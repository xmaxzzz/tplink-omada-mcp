import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import type { CustomHeaders } from '../types/index.js';

import { logger } from './logger.js';

/**
 * Exchange format between NetKnife and Omada (netknife-omada/1).
 * Spec: https://github.com/xmaxzzz/NetKnife/blob/HEAD/docs/OMADA-EXCHANGE.md
 *
 * Mapping to the Omada OpenAPI ApRadioSetting schema (docs/openapi/03-device.json):
 * - width → channelWidth: 20→"2", 40→"3", 80→"5", 160→"7", 240→"9", 320→"10";
 *   "auto" → "4" (2g, RADIO_40_20), "6" (5g, RADIO_80_40_20), "8" (6g, RADIO_160_80_40_20).
 * - txPowerMode → txPowerLevel: low 0, medium 1, high 2, custom 3, auto 4. txPower is only sent with custom.
 * - channel → channel (string) + freq taken from the AP's available-channel list; "auto" → channel "0", freq removed.
 */

export const NETKNIFE_FORMAT = 'netknife-omada/1';

export const RADIO_BANDS = ['2g', '5g', '5g1', '5g2', '6g'] as const;
export type RadioBand = (typeof RADIO_BANDS)[number];

export const TX_POWER_MODES = ['low', 'medium', 'high', 'custom', 'auto'] as const;
export type TxPowerMode = (typeof TX_POWER_MODES)[number];

export const CHANNEL_WIDTHS = [20, 40, 80, 160, 240, 320] as const;

/** Sanity range for custom TX power (dBm). The Omada API does not expose a per-AP range. */
export const TX_POWER_MIN = 1;
export const TX_POWER_MAX = 30;

export type ChannelValue = number | 'auto';
export type WidthValue = number | 'auto';

export interface RadioState {
    enabled: boolean;
    channel: ChannelValue;
    width: WidthValue;
    txPowerMode: TxPowerMode;
    txPower: number | null;
    channels: number[];
    widths: number[];
}

export interface ApState {
    name: string;
    mac: string;
    ip: string | null;
    model: string | null;
    radios: Partial<Record<RadioBand, RadioState>>;
    error?: string;
}

export interface NetknifeState {
    format: typeof NETKNIFE_FORMAT;
    kind: 'state';
    site: string;
    omadaSite: string | null;
    generated: string;
    country: string | null;
    aps: ApState[];
}

export const radioChangeSchema = z.object({
    enabled: z.boolean().nullish(),
    channel: z.union([z.number().int().positive(), z.literal('auto')]).nullish(),
    width: z.union([z.number().int().positive(), z.literal('auto')]).nullish(),
    txPowerMode: z.enum(TX_POWER_MODES).nullish(),
    txPower: z.number().int().nullish(),
});
export type RadioChange = z.infer<typeof radioChangeSchema>;
/** A change with null/undefined ("do not change") fields removed. */
export type CompactRadioChange = { [K in keyof RadioChange]?: NonNullable<RadioChange[K]> };

const currentRadioSchema = z
    .object({
        enabled: z.boolean().nullish(),
        channel: z.union([z.number(), z.literal('auto')]).nullish(),
        width: z.union([z.number(), z.literal('auto')]).nullish(),
        txPowerMode: z.enum(TX_POWER_MODES).nullish(),
        txPower: z.number().nullish(),
    })
    .passthrough();

const bandSchema = z.enum(RADIO_BANDS);

export const netknifePlanSchema = z.object({
    format: z.literal(NETKNIFE_FORMAT),
    kind: z.literal('plan'),
    site: z.string().optional(),
    generated: z.string().optional(),
    aps: z.array(
        z
            .object({
                name: z.string().nullish(),
                mac: z.string().nullish(),
                radios: z.record(bandSchema, radioChangeSchema.passthrough().nullish()).default({}),
                current: z.record(bandSchema, currentRadioSchema.nullish()).nullish(),
            })
            .refine((ap) => Boolean(ap.mac || ap.name), { message: 'each AP needs mac or name' })
    ),
});
export type NetknifePlan = z.infer<typeof netknifePlanSchema>;

export type FieldDiff = Record<string, { from: unknown; to: unknown }>;
export type RadiosDiff = Partial<Record<RadioBand, FieldDiff>>;

type RadioSetting = Record<string, unknown>;

interface BandInfo {
    settingKey: string;
    radioId: number;
    autoWidth: string;
}

const BAND_INFO: Record<RadioBand, BandInfo> = {
    '2g': { settingKey: 'radioSetting2g', radioId: 0, autoWidth: '4' },
    '5g': { settingKey: 'radioSetting5g', radioId: 1, autoWidth: '6' },
    '5g1': { settingKey: 'radioSetting5g1', radioId: 1, autoWidth: '6' },
    '5g2': { settingKey: 'radioSetting5g2', radioId: 2, autoWidth: '6' },
    '6g': { settingKey: 'radioSetting6g', radioId: 3, autoWidth: '8' },
};

const WIDTH_TO_CODE: Record<number, string> = { 20: '2', 40: '3', 80: '5', 160: '7', 240: '9', 320: '10' };
const CODE_TO_WIDTH: Record<string, WidthValue> = {
    '2': 20,
    '3': 40,
    '4': 'auto',
    '5': 80,
    '6': 'auto',
    '7': 160,
    '8': 'auto',
    '9': 240,
    '10': 320,
};
const MODE_TO_LEVEL: Record<TxPowerMode, number> = { low: 0, medium: 1, high: 2, custom: 3, auto: 4 };
const LEVEL_TO_MODE: Record<number, TxPowerMode> = { 0: 'low', 1: 'medium', 2: 'high', 3: 'custom', 4: 'auto' };

const CHANGE_FIELDS = ['enabled', 'channel', 'width', 'txPowerMode', 'txPower'] as const;

export type RadioClient = Pick<
    OmadaClient,
    'listDevices' | 'getSiteDetail' | 'getApDetail' | 'getRadiosConfig' | 'getSitesApsAvailableChannel' | 'modifyRadiosConfig'
>;

interface ChannelDetail {
    channel: number;
    freq: number;
    index?: number;
    widths: number[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Normalize a MAC for comparison: hex digits only, upper case. */
export function normalizeMac(mac: string): string {
    return mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

/** Format a MAC as AA-BB-CC-DD-EE-FF (the Omada form). Invalid input is returned unchanged. */
export function formatMac(mac: string): string {
    const hex = normalizeMac(mac);
    if (hex.length !== 12) return mac;
    return (hex.match(/.{2}/g) as string[]).join('-');
}

// Deprecated / non-country codes that ICU still resolves to a current name (SU → "Russia", UK → "United Kingdom"…).
const NON_COUNTRY_CODES = new Set(['AN', 'BU', 'CS', 'DD', 'EU', 'EZ', 'FX', 'NT', 'QO', 'SU', 'TP', 'UK', 'UN', 'XA', 'XB', 'YU', 'ZR']);

let countryNameIndex: Map<string, string> | undefined;

function buildCountryNameIndex(): Map<string, string> {
    const index = new Map<string, string>();
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of letters) {
        for (const b of letters) {
            const code = `${a}${b}`;
            if (NON_COUNTRY_CODES.has(code)) continue;
            const name = names.of(code)?.toLowerCase();
            if (name && name !== code.toLowerCase() && !index.has(name)) index.set(name, code);
        }
    }
    const aliases: Record<string, string> = {
        'united states of america': 'US',
        usa: 'US',
        'united kingdom of great britain and northern ireland': 'GB',
        uk: 'GB',
        'russian federation': 'RU',
        korea: 'KR',
        'korea, republic of': 'KR',
        'republic of korea': 'KR',
        'czech republic': 'CZ',
        turkey: 'TR',
        myanmar: 'MM',
        'viet nam': 'VN',
    };
    for (const [name, code] of Object.entries(aliases)) index.set(name, code);
    return index;
}

/** Omada stores the site region as a country name ("United States"); NetKnife wants an ISO code. */
export function toIsoCountry(region: unknown): string | null {
    if (typeof region !== 'string' || !region.trim()) return null;
    const value = region.trim();
    if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
    countryNameIndex ??= buildCountryNameIndex();
    return countryNameIndex.get(value.toLowerCase()) ?? value;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | undefined {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Extract the channel list for one radio from the available-channel response (object or array of objects). */
export function channelDetailsFor(available: unknown, radioId: number): ChannelDetail[] {
    const entries = Array.isArray(available) ? available : [available];
    const entry = entries.map(asRecord).find((e) => asNumber(e.radioId) === radioId);
    const list = Array.isArray(entry?.apChannelDetailList) ? entry.apChannelDetailList : [];
    const details: ChannelDetail[] = [];
    for (const raw of list) {
        const item = asRecord(raw);
        const channel = asNumber(item.channel);
        const freq = asNumber(item.freq);
        if (channel === undefined || freq === undefined) continue;
        const widths = Array.isArray(item.availableChannelWidthList)
            ? item.availableChannelWidthList.map(asNumber).filter((w): w is number => w !== undefined)
            : [];
        details.push({ channel, freq, index: asNumber(item.index), widths });
    }
    return details;
}

function decodeChannel(setting: RadioSetting, details: ChannelDetail[]): ChannelValue {
    const raw = asNumber(setting.channel);
    if (!raw) return 'auto';
    const freq = asNumber(setting.freq);
    const byFreq = freq ? details.find((d) => d.freq === freq) : undefined;
    if (byFreq) return byFreq.channel;
    if (details.some((d) => d.channel === raw)) return raw;
    // The spec calls the field "Channel Index"; fall back to the index column if it matches.
    return details.find((d) => d.index === raw)?.channel ?? raw;
}

/** Convert an Omada ApRadioSetting into a netknife radio state. */
export function radioStateFromSetting(setting: RadioSetting, details: ChannelDetail[]): RadioState {
    const level = asNumber(setting.txPowerLevel);
    const txPowerMode = (level !== undefined ? LEVEL_TO_MODE[level] : undefined) ?? 'auto';
    const txPower = txPowerMode === 'custom' ? (asNumber(setting.txPower) ?? null) : null;
    const widthSet = new Set<number>();
    for (const d of details) for (const w of d.widths) if ((CHANNEL_WIDTHS as readonly number[]).includes(w)) widthSet.add(w);
    return {
        enabled: setting.radioEnable === true,
        channel: decodeChannel(setting, details),
        width: CODE_TO_WIDTH[String(setting.channelWidth)] ?? 'auto',
        txPowerMode,
        txPower,
        channels: [...new Set(details.map((d) => d.channel))].sort((a, b) => a - b),
        widths: [...widthSet].sort((a, b) => a - b),
    };
}

/** Which ApRadiosConfig key a band maps to on this AP ("5g" falls back to radioSetting5g1 on tri-band APs). */
export function resolveBand(config: Record<string, unknown>, band: RadioBand): RadioBand {
    if (band === '5g' && !config.radioSetting5g && config.radioSetting5g1) return '5g1';
    return band;
}

/** Build the netknife radios map from a radio-config + available-channel response pair. */
export function radiosFromConfig(config: unknown, available: unknown): Partial<Record<RadioBand, RadioState>> {
    const cfg = asRecord(config);
    const radios: Partial<Record<RadioBand, RadioState>> = {};
    for (const band of RADIO_BANDS) {
        const info = BAND_INFO[band];
        const setting = cfg[info.settingKey];
        if (!setting || typeof setting !== 'object') continue;
        // Exchange format exposes 5g1 as "5g" (unless the AP also reports a plain 5g radio).
        const key: RadioBand = band === '5g1' && !radios['5g'] ? '5g' : band;
        radios[key] = radioStateFromSetting(setting as RadioSetting, channelDetailsFor(available, info.radioId));
    }
    return radios;
}

function sameValue(a: unknown, b: unknown): boolean {
    return a === b || (a == null && b == null);
}

/** Field-by-field diff between two radio states (only the writable fields). */
export function diffRadio(before: RadioState, after: RadioState): FieldDiff {
    const diff: FieldDiff = {};
    for (const field of CHANGE_FIELDS) {
        if (!sameValue(before[field], after[field])) diff[field] = { from: before[field], to: after[field] };
    }
    return diff;
}

/** Strip null/undefined fields — those mean "do not change". */
export function compactChange(change: RadioChange | null | undefined): CompactRadioChange {
    const result: CompactRadioChange = {};
    if (!change) return result;
    for (const field of CHANGE_FIELDS) {
        const value = change[field];
        if (value !== null && value !== undefined) (result as Record<string, unknown>)[field] = value;
    }
    return result;
}

/**
 * Validate a change against the current radio state and available channels, then merge it into the Omada setting.
 * Throws with a human-readable message on any invalid value.
 */
export function mergeRadioChange(
    band: RadioBand,
    setting: RadioSetting,
    current: RadioState,
    details: ChannelDetail[],
    change: CompactRadioChange
): RadioSetting {
    const info = BAND_INFO[band];
    const merged: RadioSetting = { ...setting };
    const targetChannel = change.channel ?? current.channel;
    const targetWidth = change.width ?? current.width;
    const targetMode = change.txPowerMode ?? current.txPowerMode;

    if (typeof change.channel === 'number' && !current.channels.includes(change.channel)) {
        throw new Error(`${band}: channel ${change.channel} is not available on this AP (allowed: ${current.channels.join(', ') || 'none'})`);
    }
    if (typeof change.width === 'number' && !current.widths.includes(change.width)) {
        throw new Error(`${band}: width ${change.width} MHz is not supported (allowed: ${current.widths.join(', ') || 'none'})`);
    }
    if ((change.channel !== undefined || change.width !== undefined) && typeof targetChannel === 'number' && typeof targetWidth === 'number') {
        const detail = details.find((d) => d.channel === targetChannel);
        if (detail && detail.widths.length > 0 && !detail.widths.includes(targetWidth)) {
            throw new Error(`${band}: width ${targetWidth} MHz is not allowed on channel ${targetChannel} (allowed: ${detail.widths.join(', ')})`);
        }
    }
    if (change.txPower !== undefined) {
        if (targetMode !== 'custom') {
            throw new Error(`${band}: txPower can only be set with txPowerMode "custom" (mode is "${targetMode}")`);
        }
        if (change.txPower < TX_POWER_MIN || change.txPower > TX_POWER_MAX) {
            throw new Error(`${band}: txPower ${change.txPower} dBm is out of range ${TX_POWER_MIN}..${TX_POWER_MAX}`);
        }
    }

    if (change.enabled !== undefined) merged.radioEnable = change.enabled;
    if (change.channel === 'auto') {
        merged.channel = '0';
        delete merged.freq;
    } else if (typeof change.channel === 'number') {
        const detail = details.find((d) => d.channel === change.channel) as ChannelDetail;
        merged.channel = String(detail.channel);
        merged.freq = detail.freq;
    }
    if (change.width !== undefined) merged.channelWidth = change.width === 'auto' ? info.autoWidth : WIDTH_TO_CODE[change.width];
    if (change.txPowerMode !== undefined) merged.txPowerLevel = MODE_TO_LEVEL[change.txPowerMode];
    if (change.txPower !== undefined) merged.txPower = change.txPower;
    return merged;
}

// ---------------------------------------------------------------------------
// Client-backed operations
// ---------------------------------------------------------------------------

export interface ApplyRadioOptions {
    dryRun: boolean;
    siteId?: string;
    customHeaders?: CustomHeaders;
}

export interface ApplyRadioResult {
    apMac: string;
    dryRun: boolean;
    before: Partial<Record<RadioBand, RadioState>>;
    after: Partial<Record<RadioBand, RadioState>>;
    diff: RadiosDiff;
    verified: boolean;
    request?: Record<string, unknown>;
    mismatches?: string[];
}

/**
 * Read radio-config + available channels, validate and merge the requested changes,
 * PATCH (unless dryRun), re-read and verify. All bands of one AP go in a single PATCH.
 */
export async function applyApRadioChanges(
    client: RadioClient,
    apMac: string,
    changes: Partial<Record<RadioBand, RadioChange | null>>,
    options: ApplyRadioOptions
): Promise<ApplyRadioResult> {
    const mac = formatMac(apMac);
    const { siteId, customHeaders } = options;
    const config = asRecord(await client.getRadiosConfig(mac, siteId, customHeaders));
    const available = await client.getSitesApsAvailableChannel(mac, siteId, customHeaders);

    const body: Record<string, unknown> = {};
    const before: Partial<Record<RadioBand, RadioState>> = {};
    const expected: Partial<Record<RadioBand, RadioState>> = {};
    const diff: RadiosDiff = {};

    for (const [requestedBand, rawChange] of Object.entries(changes) as [RadioBand, RadioChange | null][]) {
        const change = compactChange(rawChange);
        if (Object.keys(change).length === 0) continue;
        const band = resolveBand(config, requestedBand);
        const info = BAND_INFO[band];
        const setting = config[info.settingKey];
        if (!setting || typeof setting !== 'object') {
            throw new Error(`${requestedBand}: AP ${mac} has no such radio`);
        }
        const details = channelDetailsFor(available, info.radioId);
        const current = radioStateFromSetting(setting as RadioSetting, details);
        const merged = mergeRadioChange(requestedBand, setting as RadioSetting, current, details, change);
        const target = radioStateFromSetting(merged, details);
        const bandDiff = diffRadio(current, target);
        before[requestedBand] = current;
        expected[requestedBand] = target;
        if (Object.keys(bandDiff).length > 0) {
            diff[requestedBand] = bandDiff;
            body[info.settingKey] = merged;
        }
    }

    if (Object.keys(before).length === 0) {
        throw new Error('No radio changes requested: pass at least one of enabled, channel, width, txPowerMode, txPower');
    }

    if (Object.keys(body).length === 0) {
        return { apMac: mac, dryRun: options.dryRun, before, after: before, diff, verified: true };
    }
    if (options.dryRun) {
        return { apMac: mac, dryRun: true, before, after: expected, diff, verified: false, request: body };
    }

    logger.info('Omada radio-config PATCH', { apMac: mac, bands: Object.keys(diff), diff: JSON.stringify(diff) });
    await client.modifyRadiosConfig(mac, body, siteId, customHeaders);

    const afterConfig = asRecord(await client.getRadiosConfig(mac, siteId, customHeaders));
    const after: Partial<Record<RadioBand, RadioState>> = {};
    const mismatches: string[] = [];
    for (const requestedBand of Object.keys(before) as RadioBand[]) {
        const band = resolveBand(afterConfig, requestedBand);
        const info = BAND_INFO[band];
        const setting = asRecord(afterConfig[info.settingKey]);
        const state = radioStateFromSetting(setting, channelDetailsFor(available, info.radioId));
        after[requestedBand] = state;
        for (const [field, { to }] of Object.entries(diff[requestedBand] ?? {})) {
            const actual = state[field as keyof RadioState];
            if (!sameValue(actual, to)) mismatches.push(`${requestedBand}.${field}: expected ${String(to)}, got ${String(actual)}`);
        }
    }
    const verified = mismatches.length === 0;
    if (!verified) logger.warn('Omada radio-config verification failed', { apMac: mac, mismatches: mismatches.join('; ') });
    return { apMac: mac, dryRun: false, before, after, diff, verified, ...(verified ? {} : { mismatches }) };
}

export interface CollectStateOptions {
    siteId?: string;
    siteName?: string;
    customHeaders?: CustomHeaders;
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/** Snapshot the radio settings of every AP in the site as a netknife-omada/1 state document. */
export async function collectNetknifeState(client: RadioClient, options: CollectStateOptions = {}): Promise<NetknifeState> {
    const { siteId, customHeaders } = options;
    const site = asRecord(await client.getSiteDetail(siteId, customHeaders));
    const devices = await client.listDevices(siteId, customHeaders);
    const aps = devices.filter((d) => String(d.type ?? '').toLowerCase() === 'ap');

    const result: ApState[] = [];
    for (const device of aps) {
        const mac = formatMac(device.mac);
        const base: ApState = { name: device.name ?? mac, mac, ip: str(device.ip), model: str(device.model), radios: {} };
        try {
            const detail = asRecord(await client.getApDetail(mac, siteId, customHeaders));
            base.name = str(detail.name) ?? base.name;
            base.ip = str(detail.ip) ?? base.ip;
            base.model = str(detail.model) ?? base.model;
            const config = await client.getRadiosConfig(mac, siteId, customHeaders);
            const available = await client.getSitesApsAvailableChannel(mac, siteId, customHeaders);
            base.radios = radiosFromConfig(config, available);
        } catch (error) {
            base.error = error instanceof Error ? error.message : String(error);
        }
        result.push(base);
    }

    const omadaSite = str(site.name);
    return {
        format: NETKNIFE_FORMAT,
        kind: 'state',
        site: options.siteName ?? omadaSite ?? siteId ?? '',
        omadaSite,
        generated: new Date().toISOString(),
        country: toIsoCountry(site.region),
        aps: result,
    };
}

export type ApplyStatus = 'applied' | 'skipped' | 'error' | 'dry-run';

export interface ApplyPlanApResult {
    mac: string | null;
    name: string | null;
    status: ApplyStatus;
    diff: RadiosDiff;
    reason?: string;
    error?: string;
    mismatches?: string[];
    request?: Record<string, unknown>;
}

export interface ApplyPlanOptions {
    dryRun: boolean;
    force: boolean;
    stopOnError: boolean;
    siteId?: string;
    customHeaders?: CustomHeaders;
}

export interface ApplyPlanResult {
    format: typeof NETKNIFE_FORMAT;
    kind: 'apply-result';
    dryRun: boolean;
    backup: NetknifeState;
    results: ApplyPlanApResult[];
    summary: Record<ApplyStatus, number>;
}

/** Parse a plan given either as an object or as a JSON string. */
export function parseNetknifePlan(input: unknown): NetknifePlan {
    let value = input;
    if (typeof input === 'string') {
        try {
            value = JSON.parse(input);
        } catch (error) {
            throw new Error(`plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const parsed = netknifePlanSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error(
            `plan does not match ${NETKNIFE_FORMAT} kind "plan": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        );
    }
    return parsed.data;
}

function findAp(state: NetknifeState, mac: string | null | undefined, name: string | null | undefined): ApState | undefined {
    if (mac) {
        const byMac = state.aps.find((ap) => normalizeMac(ap.mac) === normalizeMac(mac));
        if (byMac) return byMac;
    }
    if (name) {
        const byName = state.aps.filter((ap) => ap.name === name);
        if (byName.length === 1) return byName[0];
    }
    return undefined;
}

/** Compare the plan's "current" block with the live state. Fields that are null on either side are not compared. */
export function currentMismatches(ap: ApState, current: NetknifePlan['aps'][number]['current']): string[] {
    const mismatches: string[] = [];
    for (const [band, expected] of Object.entries(current ?? {}) as [RadioBand, z.infer<typeof currentRadioSchema> | null][]) {
        if (!expected) continue;
        const actual = ap.radios[band];
        if (!actual) {
            mismatches.push(`${band}: radio not present on AP`);
            continue;
        }
        for (const field of CHANGE_FIELDS) {
            const want = expected[field];
            const have = actual[field];
            if (want === null || want === undefined || have === null) continue;
            if (want !== have) mismatches.push(`${band}.${field}: plan expects ${String(want)}, controller has ${String(have)}`);
        }
    }
    return mismatches;
}

/** Apply a netknife-omada/1 plan AP by AP. Backup (state before changes) is always returned. */
export async function applyNetknifePlan(client: RadioClient, planInput: unknown, options: ApplyPlanOptions): Promise<ApplyPlanResult> {
    const plan = parseNetknifePlan(planInput);
    const backup = await collectNetknifeState(client, { siteId: options.siteId, siteName: plan.site, customHeaders: options.customHeaders });
    const results: ApplyPlanApResult[] = [];
    let stopped = false;

    for (const entry of plan.aps) {
        const base = { mac: entry.mac ? formatMac(entry.mac) : null, name: entry.name ?? null, diff: {} };
        if (stopped) {
            results.push({ ...base, status: 'skipped', reason: 'not attempted: stopped after previous error (stopOnError)' });
            continue;
        }
        const ap = findAp(backup, entry.mac, entry.name);
        if (!ap) {
            results.push({ ...base, status: 'error', error: 'AP not found on site (by mac, then by unique name)' });
            stopped = options.stopOnError;
            continue;
        }
        const matched = { ...base, mac: ap.mac, name: ap.name };
        if (ap.error) {
            results.push({ ...matched, status: 'error', error: `could not read AP state: ${ap.error}` });
            stopped = options.stopOnError;
            continue;
        }
        const mismatches = currentMismatches(ap, entry.current);
        if (mismatches.length > 0 && !options.force) {
            results.push({ ...matched, status: 'skipped', reason: 'plan "current" differs from the controller (use force to override)', mismatches });
            continue;
        }
        try {
            const outcome = await applyApRadioChanges(client, ap.mac, entry.radios, {
                dryRun: options.dryRun,
                siteId: options.siteId,
                customHeaders: options.customHeaders,
            });
            const extra = mismatches.length > 0 ? { mismatches } : {};
            if (Object.keys(outcome.diff).length === 0) {
                results.push({ ...matched, ...extra, status: 'skipped', reason: 'no changes needed', diff: {} });
            } else if (outcome.dryRun) {
                results.push({ ...matched, ...extra, status: 'dry-run', diff: outcome.diff, request: outcome.request });
            } else if (!outcome.verified) {
                results.push({
                    ...matched,
                    status: 'error',
                    diff: outcome.diff,
                    error: 'verification after PATCH failed',
                    mismatches: outcome.mismatches,
                });
                stopped = options.stopOnError;
            } else {
                results.push({ ...matched, ...extra, status: 'applied', diff: outcome.diff });
            }
        } catch (error) {
            results.push({ ...matched, status: 'error', error: error instanceof Error ? error.message : String(error) });
            stopped = options.stopOnError;
        }
    }

    const summary: Record<ApplyStatus, number> = { applied: 0, skipped: 0, error: 0, 'dry-run': 0 };
    for (const r of results) summary[r.status]++;
    return { format: NETKNIFE_FORMAT, kind: 'apply-result', dryRun: options.dryRun, backup, results, summary };
}
