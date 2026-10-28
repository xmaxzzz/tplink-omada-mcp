import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { deviceMacSchema, siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';
import type { ApLoadBalanceConfig, CustomHeaders } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { formatMac } from '../utils/netknife-omada.js';

/** Band suffixes of the GET load-balance keys (`maxClientsEnable5g2`, `threshold5g`, ...). */
export const LOAD_BALANCE_BANDS = ['2g', '5g', '5g2', '6g'] as const;
export type LoadBalanceBand = (typeof LOAD_BALANCE_BANDS)[number];

/** RSSI threshold range, dBm. The spec gives no range; this is the tool's own bound. */
export const RSSI_THRESHOLD_MIN = -95;
export const RSSI_THRESHOLD_MAX = -40;
/** Thresholds above this (stricter, e.g. -65) drop clients at the cell edge — warn. */
export const RSSI_THRESHOLD_WARN = -70;
/** `maxClients*` range from `UpdateApAdvancedLoadBalanceOpenApiVO`. */
export const MAX_CLIENTS_MIN = 1;
export const MAX_CLIENTS_MAX = 512;

export type LoadBalanceClient = Pick<OmadaClient, 'getSitesApsLoadBalance' | 'modifyApLoadBalanceConfig'>;

export interface LoadBalanceChange {
    rssiEnable?: boolean;
    threshold?: number;
    maxClientsEnable?: boolean;
    maxClients?: number;
}

export interface ApplyLoadBalanceOptions {
    dryRun: boolean;
    siteId?: string;
    customHeaders?: CustomHeaders;
}

export interface ApplyLoadBalanceResult {
    apMac: string;
    band: LoadBalanceBand;
    dryRun: boolean;
    before: ApLoadBalanceConfig;
    after: ApLoadBalanceConfig;
    diff: Record<string, { from: unknown; to: unknown }>;
    verified: boolean;
    /** Full body sent (or, with dryRun, to be sent) with PATCH. */
    request?: ApLoadBalanceConfig;
    /** Requested fields the controller did not take (re-read value differs). */
    ignored?: string[];
    /** Fields we did not touch that changed between the two GETs. */
    sideEffects?: Record<string, { from: unknown; to: unknown }>;
    warnings?: string[];
}

function bandKeys(band: LoadBalanceBand) {
    return {
        rssiEnable: `rssiEnable${band}`,
        threshold: `threshold${band}`,
        maxClientsEnable: `maxClientsEnable${band}`,
        maxClients: `maxClients${band}`,
    } as const;
}

function asConfig(value: unknown, mac: string): ApLoadBalanceConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`AP ${mac}: load-balance GET returned no config object`);
    }
    return value as ApLoadBalanceConfig;
}

function same(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Read load-balance, merge the requested per-band fields into the full GET object (a partial PATCH may reset the
 * rest), PATCH unless dryRun, re-read and verify each requested field. A request equal to the current config is
 * still written when dryRun=false (a no-op PATCH, useful to check the controller keeps everything as is).
 */
export async function applyApLoadBalanceChange(
    client: LoadBalanceClient,
    apMac: string,
    band: LoadBalanceBand,
    change: LoadBalanceChange,
    options: ApplyLoadBalanceOptions
): Promise<ApplyLoadBalanceResult> {
    const mac = formatMac(apMac);
    const { siteId, customHeaders } = options;
    const keys = bandKeys(band);

    const requested: Record<string, unknown> = {};
    for (const field of ['rssiEnable', 'threshold', 'maxClientsEnable', 'maxClients'] as const) {
        if (change[field] !== undefined) requested[keys[field]] = change[field];
    }
    if (Object.keys(requested).length === 0) {
        throw new Error('No load-balance changes requested: pass at least one of rssiEnable, threshold, maxClientsEnable, maxClients');
    }

    const before = asConfig(await client.getSitesApsLoadBalance(mac, siteId, customHeaders), mac);

    if ((change.rssiEnable !== undefined || change.threshold !== undefined) && !(keys.rssiEnable in before) && !(keys.threshold in before)) {
        throw new Error(
            `${band}: the controller returns no RSSI threshold fields (${keys.rssiEnable}/${keys.threshold}) for AP ${mac}; RSSI threshold can only be set on bands where GET load-balance shows them`
        );
    }
    if (
        (change.maxClientsEnable !== undefined || change.maxClients !== undefined) &&
        !(keys.maxClientsEnable in before) &&
        !(keys.maxClients in before)
    ) {
        throw new Error(`${band}: the controller returns no max-clients fields (${keys.maxClientsEnable}/${keys.maxClients}) for AP ${mac}`);
    }
    if (change.threshold !== undefined && (change.rssiEnable ?? before[keys.rssiEnable]) !== true) {
        throw new Error(`${band}: threshold needs RSSI threshold on — pass rssiEnable: true (it is off on AP ${mac})`);
    }
    if (change.maxClientsEnable === true && change.maxClients === undefined && typeof before[keys.maxClients] !== 'number') {
        throw new Error(`${band}: maxClientsEnable: true needs maxClients (AP ${mac} has no current value)`);
    }

    const body: ApLoadBalanceConfig = { ...before, ...requested };
    const diff: ApplyLoadBalanceResult['diff'] = {};
    for (const [key, to] of Object.entries(requested)) {
        if (!same(before[key], to)) diff[key] = { from: before[key], to };
    }

    const warnings: string[] = [];
    if (change.rssiEnable !== undefined || change.threshold !== undefined) {
        const threshold = body[keys.threshold];
        if (body[keys.rssiEnable] === true && typeof threshold === 'number' && threshold > RSSI_THRESHOLD_WARN) {
            warnings.push(
                `${band}: RSSI threshold ${threshold} dBm is stricter than ${RSSI_THRESHOLD_WARN} dBm — clients at the cell edge will be refused`
            );
        }
        if (band === '2g' && body[keys.rssiEnable] === true) {
            warnings.push('2g: IoT clients (sensors, plugs, cameras) often sit on 2.4 GHz with a weak signal and tolerate RSSI cut-off badly');
        }
    }
    const extra = warnings.length > 0 ? { warnings } : {};

    if (options.dryRun) {
        return { apMac: mac, band, dryRun: true, before, after: body, diff, verified: false, request: body, ...extra };
    }

    logger.info('Omada load-balance PATCH', { apMac: mac, band, diff: JSON.stringify(diff) });
    await client.modifyApLoadBalanceConfig(mac, body, siteId, customHeaders);
    const after = asConfig(await client.getSitesApsLoadBalance(mac, siteId, customHeaders), mac);

    const ignored: string[] = [];
    for (const [key, value] of Object.entries(requested)) {
        if (!same(after[key], value)) ignored.push(`${key}: requested ${String(value)}, controller has ${String(after[key])}`);
    }
    const sideEffects: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!(key in requested) && !same(before[key], after[key])) sideEffects[key] = { from: before[key], to: after[key] };
    }
    const verified = ignored.length === 0;
    if (!verified) logger.warn('Omada load-balance verification failed', { apMac: mac, ignored: ignored.join('; ') });
    return {
        apMac: mac,
        band,
        dryRun: false,
        before,
        after,
        diff,
        verified,
        request: body,
        ...(verified ? {} : { ignored }),
        ...(Object.keys(sideEffects).length > 0 ? { sideEffects } : {}),
        ...extra,
    };
}

const inputSchema = siteInputSchema
    .extend({
        apMac: deviceMacSchema.describe('MAC address of the access point (e.g. "AA-BB-CC-DD-EE-FF"). Use listDevices to find AP MACs.'),
        band: z
            .enum(LOAD_BALANCE_BANDS)
            .describe(
                'Band suffix of the load-balance fields: 2g, 5g, 5g2 or 6g. RSSI threshold exists only where GET load-balance shows it (2g/5g).'
            ),
        rssiEnable: z.boolean().optional().describe('Turn RSSI Threshold on/off for this band.'),
        threshold: z
            .number()
            .int()
            .min(RSSI_THRESHOLD_MIN)
            .max(RSSI_THRESHOLD_MAX)
            .optional()
            .describe(
                `RSSI threshold in dBm (${RSSI_THRESHOLD_MIN}…${RSSI_THRESHOLD_MAX}); clients weaker than this are refused. Needs rssiEnable true (in this call or already on). Above ${RSSI_THRESHOLD_WARN} returns a warning.`
            ),
        maxClientsEnable: z.boolean().optional().describe('Turn the per-band max-clients limit on/off.'),
        maxClients: z
            .number()
            .int()
            .min(MAX_CLIENTS_MIN)
            .max(MAX_CLIENTS_MAX)
            .optional()
            .describe(`Maximum associated clients on this band (${MAX_CLIENTS_MIN}…${MAX_CLIENTS_MAX}).`),
        dryRun: z
            .boolean()
            .default(true)
            .describe('Default true: return the diff and the full PATCH body without writing. Set false only after a human approved the diff.'),
    })
    .required({ apMac: true, band: true });

export function registerSetApLoadBalanceTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setApLoadBalance',
        {
            description:
                'WRITE: change RSSI Threshold (rssiEnable/threshold) or max clients of one AP band (PATCH load-balance). Reads the current config and sends it back whole with only the passed fields changed, then re-reads and verifies; fields the controller ignored are listed in "ignored" (verified=false), untouched fields that changed in "sideEffects". On 2.4 GHz IoT clients tolerate RSSI cut-off badly. ALWAYS call with dryRun=true first (the default), show the diff to a human, and only then repeat with dryRun=false. Returns {before, after, diff, verified}.',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler(
            'setApLoadBalance',
            async ({ apMac, band, rssiEnable, threshold, maxClientsEnable, maxClients, dryRun, siteId, customHeaders }) =>
                toToolResult(
                    await applyApLoadBalanceChange(
                        client,
                        apMac,
                        band,
                        { rssiEnable, threshold, maxClientsEnable, maxClients },
                        { dryRun: dryRun ?? true, siteId, customHeaders }
                    )
                )
        )
    );
}
