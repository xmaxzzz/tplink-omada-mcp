import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { deviceMacSchema, siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';
import { applyApRadioChanges, RADIO_BANDS, TX_POWER_MAX, TX_POWER_MIN, TX_POWER_MODES } from '../utils/netknife-omada.js';

const inputSchema = siteInputSchema
    .extend({
        apMac: deviceMacSchema.describe('MAC address of the access point (e.g. "AA-BB-CC-DD-EE-FF"). Use listDevices to find AP MACs.'),
        band: z.enum(RADIO_BANDS).describe('Radio band: 2g, 5g, 5g1, 5g2 or 6g. "5g" maps to 5g1 on tri-band APs.'),
        channel: z
            .union([z.number().int().positive(), z.literal('auto')])
            .optional()
            .describe('Channel number (must be in the AP available-channel list) or "auto".'),
        width: z
            .union([z.literal(20), z.literal(40), z.literal(80), z.literal(160), z.literal(240), z.literal(320), z.literal('auto')])
            .optional()
            .describe('Channel width in MHz (20/40/80/160/240/320) or "auto".'),
        txPowerMode: z.enum(TX_POWER_MODES).optional().describe('TX power mode: low, medium, high, custom or auto.'),
        txPower: z
            .number()
            .int()
            .min(TX_POWER_MIN)
            .max(TX_POWER_MAX)
            .optional()
            .describe('TX power in dBm; only with txPowerMode "custom" (or when the radio already is in custom mode).'),
        enabled: z.boolean().optional().describe('Enable or disable the radio.'),
        dryRun: z
            .boolean()
            .default(true)
            .describe('Default true: validate and return the diff without writing. Set false only after a human approved the diff.'),
    })
    .required({ apMac: true, band: true });

export function registerSetApRadioConfigTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setApRadioConfig',
        {
            description:
                'WRITE: change channel, width, TX power or enable state of one AP radio (PATCH radio-config). Only the passed fields change. Validates against the AP available channels, then re-reads and verifies. ALWAYS call with dryRun=true first (the default), show the diff to a human, and only then repeat with dryRun=false. Returns {before, after, diff, verified}.',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('setApRadioConfig', async ({ apMac, band, channel, width, txPowerMode, txPower, enabled, dryRun, siteId, customHeaders }) =>
            toToolResult(
                await applyApRadioChanges(
                    client,
                    apMac,
                    { [band]: { channel, width, txPowerMode, txPower, enabled } },
                    { dryRun: dryRun ?? true, siteId, customHeaders }
                )
            )
        )
    );
}
