import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
// Import cycle with setApLoadBalance (it imports formatMac from here): neither module uses the other's bindings at
// top level, only inside functions, so either load order works. Keep it that way.
import { type ApplyLoadBalanceResult, applyApLoadBalanceChange, LOAD_BALANCE_BANDS, type LoadBalanceBand } from '../tools/setApLoadBalance.js';
import type { ApLoadBalanceConfig, CustomHeaders } from '../types/index.js';

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
 *   radio-config returns `channel` as a channel index (ApChannelDetail.index), so it is decoded via freq; when the
 *   channel is not changed only freq is written back (see settingForWrite).
 *
 * loadBalance (RSSI threshold, next to radios) maps to GET/PATCH /aps/{apMac}/load-balance:
 * `{"5g": {rssiEnable, threshold}}` ↔ `rssiEnable5g` / `threshold5g`. The controller has no 5g1 keys, so plan "5g1"
 * is written as "5g" (the same way radios expose radioSetting5g1 as "5g"). Writes go through applyApLoadBalanceChange
 * (setApLoadBalance): the full GET body is merged and sent back, the flag and the value are verified separately.
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

/** RSSI threshold range of the loadBalance block, dBm. Same bound as RSSI_THRESHOLD_* in setApLoadBalance (not
 * imported: the zod schemas below are built at load time, see the import-cycle note above). */
export const LB_THRESHOLD_MIN = -95;
export const LB_THRESHOLD_MAX = -40;

/** One band of the loadBalance block: RSSI threshold flag and value (dBm). */
export interface LoadBalanceState {
    rssiEnable: boolean;
    threshold?: number;
}
export type ApLoadBalanceState = Partial<Record<RadioBand, LoadBalanceState>>;

export interface ApState {
    name: string;
    mac: string;
    ip: string | null;
    model: string | null;
    radios: Partial<Record<RadioBand, RadioState>>;
    /** RSSI threshold per band as read by GET load-balance; absent when that read failed (see loadBalanceError). */
    loadBalance?: ApLoadBalanceState;
    error?: string;
    /** Why loadBalance is absent: the load-balance GET failed (radios are still reported). */
    loadBalanceError?: string;
}

export interface NetknifeState {
    format: typeof NETKNIFE_FORMAT;
    kind: 'state';
    site: string;
    omadaSite: string | null;
    generated: string;
    country: string | null;
    aps: ApState[];
    /** Non-fatal read problems (e.g. load-balance of one AP not read). Absent when there are none. */
    warnings?: string[];
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

const LB_THRESHOLD_TEXT = `threshold must be an integer dBm in ${LB_THRESHOLD_MIN}…${LB_THRESHOLD_MAX}`;
const lbThresholdSchema = z
    .number({ invalid_type_error: `${LB_THRESHOLD_TEXT} (a number, not a string)` })
    .int({ message: LB_THRESHOLD_TEXT })
    .min(LB_THRESHOLD_MIN, { message: LB_THRESHOLD_TEXT })
    .max(LB_THRESHOLD_MAX, { message: LB_THRESHOLD_TEXT });
const lbRssiEnableSchema = z.boolean({
    required_error: 'rssiEnable is required (true/false)',
    invalid_type_error: 'rssiEnable must be true or false',
});

/**
 * One band of the plan loadBalance block: what to write. threshold is required with rssiEnable true; with rssiEnable
 * false it may be omitted — the controller keeps its current value. Unknown fields are rejected.
 */
export const loadBalancePlanSchema = z
    .object({ rssiEnable: lbRssiEnableSchema, threshold: lbThresholdSchema.optional() })
    .strict()
    .refine((lb) => !lb.rssiEnable || lb.threshold !== undefined, {
        message: 'threshold is required when rssiEnable is true',
        path: ['threshold'],
    });
export type LoadBalancePlan = z.infer<typeof loadBalancePlanSchema>;

/** One band of the state loadBalance block (and of plan current.loadBalance): as read from the controller. */
export const loadBalanceStateSchema = z.object({ rssiEnable: lbRssiEnableSchema, threshold: lbThresholdSchema.optional() }).strict();

// current.loadBalance is a reconciliation hint copied from the state: strict integers, but no range check — whatever
// the controller holds must round-trip.
const currentLoadBalanceSchema = z
    .object({
        rssiEnable: lbRssiEnableSchema,
        threshold: z.number({ invalid_type_error: 'threshold must be an integer dBm (a number, not a string)' }).int().optional(),
    })
    .passthrough();

const currentSchema = z
    .object({
        '2g': currentRadioSchema.nullish(),
        '5g': currentRadioSchema.nullish(),
        '5g1': currentRadioSchema.nullish(),
        '5g2': currentRadioSchema.nullish(),
        '6g': currentRadioSchema.nullish(),
        loadBalance: z.record(bandSchema, currentLoadBalanceSchema.nullish()).nullish(),
    })
    .strict();

/** Plan "5g1" and "5g" both address the controller's 5g load-balance keys — only one of them may be set. */
function singleFiveGig(block: Partial<Record<RadioBand, unknown>> | null | undefined): boolean {
    return !(block?.['5g'] && block['5g1']);
}

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
                loadBalance: z
                    .record(bandSchema, loadBalancePlanSchema.nullish())
                    .nullish()
                    .refine(singleFiveGig, { message: '"5g" and "5g1" both map to the controller 5g load-balance keys — set only one' }),
                current: currentSchema.nullish(),
            })
            .refine((ap) => Boolean(ap.mac || ap.name), { message: 'each AP needs mac or name' })
    ),
    // Optional advisory list from Helpdesk ({code, band, aps, text}[]). Never validated strictly and never blocks a write;
    // unknown codes are passed through as is.
    warnings: z.unknown().optional(),
    // Optional Helpdesk lists of APs that are not in "aps" ({name, mac, reason, text}[]): "unmanaged" — not for writing
    // (no MAC / not in Omada), "unchanged" — Omada APs left as is. Reported only, never written. Other unknown
    // top-level fields are ignored (zod strips them).
    unmanaged: z.unknown().optional(),
    unchanged: z.unknown().optional(),
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
    | 'listDevices'
    | 'getSiteDetail'
    | 'getApDetail'
    | 'getRadiosConfig'
    | 'getSitesApsAvailableChannel'
    | 'modifyRadiosConfig'
    | 'getSitesApsLoadBalance'
    | 'modifyApLoadBalanceConfig'
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
    change: CompactRadioChange,
    notes?: string[]
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
    // channelRange (custom channel freq list) comes back empty on some APs while the rest of the site has the full
    // list. The controller corrects a channel that is outside channelRange, so an empty list is not sent with a
    // channel change: it is filled with every freq the AP allows for this radio (what the other APs already have).
    // A non-empty range is left as is — if the controller corrects the channel, the read-back reports it.
    if (change.channel !== undefined && Array.isArray(setting.channelRange) && setting.channelRange.length === 0 && details.length > 0) {
        merged.channelRange = details.map((d) => d.freq);
        notes?.push(`${band}: empty channelRange filled with the ${details.length} channels allowed on this AP`);
    }
    if (change.width !== undefined) merged.channelWidth = change.width === 'auto' ? info.autoWidth : WIDTH_TO_CODE[change.width];
    if (change.txPowerMode !== undefined) merged.txPowerLevel = MODE_TO_LEVEL[change.txPowerMode];
    if (change.txPower !== undefined) merged.txPower = change.txPower;
    return merged;
}

/**
 * The Omada setting as it goes into the PATCH body. radio-config `channel` is a channel *index*
 * (ApChannelDetail.index, e.g. "17" for channel 132), not the channel number, while `freq` is authoritative:
 * "the freq and channel fields should be corresponding, otherwise the channel will be corrected based on freq".
 * An unchanged fixed channel is therefore not echoed back: the index read by GET is dropped and only the current
 * freq is sent, so a write that does not touch the channel never depends on the index ↔ channel mapping.
 * Auto ("0") is kept as is — without it the current freq could pin the radio to its present channel.
 */
export function settingForWrite(merged: RadioSetting, change: CompactRadioChange): RadioSetting {
    if (change.channel !== undefined || !asNumber(merged.channel)) return merged;
    const body: RadioSetting = { ...merged };
    delete body.channel;
    return body;
}

/** Plan / state band → suffix of the load-balance keys ("5g1" → "5g": the controller has no 5g1 keys). */
export function loadBalanceBand(band: RadioBand): LoadBalanceBand {
    return band === '5g1' ? '5g' : band;
}

/** One band of a load-balance GET body in the exchange form, or undefined when the band has no RSSI fields. */
function loadBalanceBandState(config: ApLoadBalanceConfig, band: LoadBalanceBand): LoadBalanceState | undefined {
    const flag = `rssiEnable${band}`;
    const value = `threshold${band}`;
    if (!(flag in config) && !(value in config)) return undefined;
    const threshold = asNumber(config[value]);
    return { rssiEnable: config[flag] === true, ...(threshold !== undefined && Number.isInteger(threshold) ? { threshold } : {}) };
}

/**
 * The loadBalance block of a state from a GET load-balance body: every band whose RSSI fields the controller returns.
 * Throws when the body is not an object.
 */
export function loadBalanceFromConfig(config: unknown): ApLoadBalanceState {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('load-balance GET returned no config object');
    const result: ApLoadBalanceState = {};
    for (const band of LOAD_BALANCE_BANDS) {
        const state = loadBalanceBandState(config as ApLoadBalanceConfig, band);
        if (state) result[band] = state;
    }
    return result;
}

function dbm(value: number | undefined): string {
    return value === undefined ? '—' : `${value} dBm`;
}

/** before→after of one planned band, the flag and the threshold on separate lines. */
export function loadBalanceLines(band: RadioBand, from: LoadBalanceState, to: LoadBalanceState): string[] {
    const mark = (changed: boolean) => (changed ? '' : ' (без изменений)');
    return [
        `loadBalance ${band} rssiEnable: ${from.rssiEnable} → ${to.rssiEnable}${mark(from.rssiEnable !== to.rssiEnable)}`,
        `loadBalance ${band} threshold: ${dbm(from.threshold)} → ${dbm(to.threshold)}${mark(from.threshold !== to.threshold)}`,
    ];
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
    /** Adjustments to the Omada setting beyond the requested fields (e.g. an empty channelRange filled). */
    notes?: string[];
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
    const notes: string[] = [];

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
        const bandNotes: string[] = [];
        const merged = mergeRadioChange(requestedBand, setting as RadioSetting, current, details, change, bandNotes);
        const target = radioStateFromSetting(merged, details);
        const bandDiff = diffRadio(current, target);
        before[requestedBand] = current;
        expected[requestedBand] = target;
        if (Object.keys(bandDiff).length > 0) {
            diff[requestedBand] = bandDiff;
            body[info.settingKey] = settingForWrite(merged, change);
            notes.push(...bandNotes);
        }
    }

    if (Object.keys(before).length === 0) {
        throw new Error('No radio changes requested: pass at least one of enabled, channel, width, txPowerMode, txPower');
    }

    if (Object.keys(body).length === 0) {
        return { apMac: mac, dryRun: options.dryRun, before, after: before, diff, verified: true };
    }
    const extra = notes.length > 0 ? { notes } : {};
    if (options.dryRun) {
        return { apMac: mac, dryRun: true, before, after: expected, diff, verified: false, request: body, ...extra };
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
        // A channel that was not requested must survive the write (the PATCH carries only freq for it).
        const from = before[requestedBand]?.channel;
        if (diff[requestedBand] && !diff[requestedBand].channel && !sameValue(state.channel, from)) {
            mismatches.push(`${requestedBand}.channel: not requested, expected unchanged ${String(from)}, got ${String(state.channel)}`);
        }
    }
    const verified = mismatches.length === 0;
    if (!verified) logger.warn('Omada radio-config verification failed', { apMac: mac, mismatches: mismatches.join('; ') });
    return { apMac: mac, dryRun: false, before, after, diff, verified, ...(verified ? {} : { mismatches }), ...extra };
}

export interface ApplyLoadBalancePlanResult {
    /** Bands that change: rssiEnable / threshold from → to (exchange form, plan band keys). */
    diff: Partial<Record<RadioBand, FieldDiff>>;
    /** before→after of every planned band, the flag and the threshold on separate lines. */
    lines: string[];
    /** dryRun: not checked (false); write: every written band re-read and matched. */
    verified: boolean;
    /** dryRun: full PATCH body per band that would be written. */
    requests?: Partial<Record<RadioBand, ApLoadBalanceConfig>>;
    /** Omada keys the controller did not take (re-read differs), e.g. "threshold5g". */
    ignored?: string[];
    mismatches?: Record<string, { expected: unknown; actual: unknown }>;
    /** Untouched load-balance keys that changed between GET and re-read. */
    sideEffects?: Record<string, { from: unknown; to: unknown }>;
    warnings?: string[];
    notes?: string[];
}

function bandFromResult(result: ApplyLoadBalanceResult, side: 'before' | 'after'): LoadBalanceState {
    return loadBalanceBandState(result[side], result.band) ?? { rssiEnable: false };
}

/**
 * Apply the plan loadBalance block of one AP, band by band, through applyApLoadBalanceChange (GET, merge into the
 * full body, PATCH, re-read, flag and value verified separately). null / absent bands are not touched; a band already
 * matching the plan is not written. With rssiEnable false and no threshold the current value stays. A threshold given
 * with rssiEnable false is not written either (setApLoadBalance rule: the value only applies with the flag on) — noted.
 */
export async function applyApLoadBalancePlan(
    client: RadioClient,
    apMac: string,
    block: Partial<Record<RadioBand, LoadBalancePlan | null>>,
    options: ApplyRadioOptions
): Promise<ApplyLoadBalancePlanResult> {
    const { siteId, customHeaders } = options;
    const diff: ApplyLoadBalancePlanResult['diff'] = {};
    const lines: string[] = [];
    const requests: NonNullable<ApplyLoadBalancePlanResult['requests']> = {};
    const ignored: string[] = [];
    const mismatches: NonNullable<ApplyLoadBalancePlanResult['mismatches']> = {};
    const sideEffects: NonNullable<ApplyLoadBalancePlanResult['sideEffects']> = {};
    const warnings: string[] = [];
    const notes: string[] = [];

    for (const band of RADIO_BANDS) {
        const lb = block[band];
        if (!lb) continue;
        const lbBand = loadBalanceBand(band);
        const change = { rssiEnable: lb.rssiEnable, ...(lb.rssiEnable ? { threshold: lb.threshold } : {}) };
        const preview = await applyApLoadBalanceChange(client, apMac, lbBand, change, { dryRun: true, siteId, customHeaders });
        const from = bandFromResult(preview, 'before');
        const to = bandFromResult(preview, 'after');
        lines.push(...loadBalanceLines(band, from, to));
        if (!lb.rssiEnable && lb.threshold !== undefined && lb.threshold !== from.threshold) {
            notes.push(
                `loadBalance ${band}: threshold ${lb.threshold} not written with rssiEnable false — the controller keeps ${dbm(from.threshold)}`
            );
        }
        const bandDiff: FieldDiff = {};
        if (from.rssiEnable !== to.rssiEnable) bandDiff.rssiEnable = { from: from.rssiEnable, to: to.rssiEnable };
        if (from.threshold !== to.threshold) bandDiff.threshold = { from: from.threshold ?? null, to: to.threshold ?? null };
        if (Object.keys(bandDiff).length === 0) continue;
        diff[band] = bandDiff;
        if (options.dryRun) {
            if (preview.request) requests[band] = preview.request;
            warnings.push(...(preview.warnings ?? []));
            continue;
        }
        const result = await applyApLoadBalanceChange(client, apMac, lbBand, change, { dryRun: false, siteId, customHeaders });
        warnings.push(...(result.warnings ?? []));
        ignored.push(...(result.ignored ?? []));
        Object.assign(mismatches, result.mismatches ?? {});
        Object.assign(sideEffects, result.sideEffects ?? {});
    }

    const verified = !options.dryRun && ignored.length === 0;
    return {
        diff,
        lines,
        verified,
        ...(Object.keys(requests).length > 0 ? { requests } : {}),
        ...(ignored.length > 0 ? { ignored, mismatches } : {}),
        ...(Object.keys(sideEffects).length > 0 ? { sideEffects } : {}),
        ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
        ...(notes.length > 0 ? { notes } : {}),
    };
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
    const warnings: string[] = [];
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
        // A failed load-balance read does not fail the AP: the block is left out and reported.
        if (!base.error) {
            try {
                base.loadBalance = loadBalanceFromConfig(await client.getSitesApsLoadBalance(mac, siteId, customHeaders));
            } catch (error) {
                base.loadBalanceError = error instanceof Error ? error.message : String(error);
                warnings.push(`${base.name} (${mac}): load-balance not read, loadBalance omitted — ${base.loadBalanceError}`);
            }
        }
        result.push(base);
    }
    if (warnings.length > 0) logger.warn('NetKnife state: load-balance not read', { warnings: warnings.join(' | ') });

    const omadaSite = str(site.name);
    return {
        format: NETKNIFE_FORMAT,
        kind: 'state',
        site: options.siteName ?? omadaSite ?? siteId ?? '',
        omadaSite,
        generated: new Date().toISOString(),
        country: toIsoCountry(site.region),
        aps: result,
        ...(warnings.length > 0 ? { warnings } : {}),
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
    notes?: string[];
    /** Present when the plan has a loadBalance block for the AP: applied after its radios. */
    loadBalance?: ApplyLoadBalancePlanResult;
}

export interface ApplyPlanOptions {
    dryRun: boolean;
    force: boolean;
    stopOnError: boolean;
    siteId?: string;
    customHeaders?: CustomHeaders;
}

/** Advisory message: shown to the human, never blocks the write. */
export interface PlanWarning {
    /** "plan-check" — computed here from the plan; "helpdesk" — passed through from the plan's own warnings field. */
    source: 'plan-check' | 'helpdesk';
    code: string;
    band: string | null;
    channel?: number;
    aps: string[];
    text: string;
}

/** An AP from the plan's "unmanaged" / "unchanged" lists (reported, never written). */
export interface PlanListedAp {
    name: string | null;
    mac: string | null;
    reason: string | null;
    text: string | null;
}

export interface ApplyPlanResult {
    format: typeof NETKNIFE_FORMAT;
    kind: 'apply-result';
    dryRun: boolean;
    backup: NetknifeState;
    warnings: PlanWarning[];
    results: ApplyPlanApResult[];
    summary: Record<ApplyStatus, number>;
    /** Plan "unmanaged" list: APs not for writing (no MAC / not in Omada). */
    unmanaged: PlanListedAp[];
    /** Plan "unchanged" list: Omada APs the plan leaves as is. */
    unchanged: PlanListedAp[];
    /** Human-readable lines about the plan lists ("unmanaged: N (не записываются): …"). */
    report: string[];
}

/** This many APs (or more) on one channel in one band trigger a warning. */
export const SAME_CHANNEL_WARN_THRESHOLD = 3;

const CURRENT_NUMERIC_FIELDS = ['channel', 'width', 'txPower'] as const;
const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

/**
 * Soft normalization of the plan's "current" block (a reconciliation hint, never written): numeric strings
 * ("36", "20") become numbers and "" becomes null, as older Helpdesk/NetKnife exports wrote them. Returns a copy
 * and one warning listing the affected APs. "radios" (what gets written) is left as is and validated strictly.
 */
export function normalizePlanCurrent(value: unknown): { value: unknown; warnings: PlanWarning[] } {
    const plan = asRecord(value);
    if (!Array.isArray(plan.aps)) return { value, warnings: [] };
    const fixed: string[] = [];
    const aps = plan.aps.map((rawAp) => {
        const ap = asRecord(rawAp);
        const current = asRecord(ap.current);
        if (typeof rawAp !== 'object' || rawAp === null || Object.keys(current).length === 0) return rawAp;
        const fields: string[] = [];
        const nextCurrent = Object.fromEntries(
            Object.entries(current).map(([band, rawRadio]) => {
                // loadBalance is validated strictly (integers only), never normalized.
                if (band === 'loadBalance' || typeof rawRadio !== 'object' || rawRadio === null) return [band, rawRadio];
                const radio: Record<string, unknown> = { ...(rawRadio as Record<string, unknown>) };
                for (const field of CURRENT_NUMERIC_FIELDS) {
                    const v = radio[field];
                    if (typeof v !== 'string' || v === 'auto') continue;
                    if (v.trim() === '') radio[field] = null;
                    else if (NUMERIC_STRING.test(v.trim())) radio[field] = Number(v.trim());
                    else continue;
                    fields.push(`${band}.${field}`);
                }
                return [band, radio];
            })
        );
        if (fields.length === 0) return rawAp;
        fixed.push(`${str(ap.name) ?? str(ap.mac) ?? '?'} (${fields.join(', ')})`);
        return { ...ap, current: nextCurrent };
    });
    if (fixed.length === 0) return { value, warnings: [] };
    return {
        value: { ...plan, aps },
        warnings: [
            {
                source: 'plan-check',
                code: 'plan_current_strings',
                band: null,
                aps: fixed,
                text: `В блоке current плана числа записаны строками — приведены к числам для сверки (на запись не влияет): ${fixed.join('; ')}. Перевыгрузите план из Helpdesk.`,
            },
        ],
    };
}

/**
 * Parse a plan given either as an object or as a JSON string. Warnings from the soft normalization of
 * "current" (see normalizePlanCurrent) are appended to `warnings` when given.
 */
export function parseNetknifePlan(input: unknown, warnings?: PlanWarning[]): NetknifePlan {
    let value = input;
    if (typeof input === 'string') {
        try {
            value = JSON.parse(input);
        } catch (error) {
            throw new Error(`plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const normalized = normalizePlanCurrent(value);
    value = normalized.value;
    warnings?.push(...normalized.warnings);
    const parsed = netknifePlanSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error(
            `plan does not match ${NETKNIFE_FORMAT} kind "plan": ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        );
    }
    return parsed.data;
}

/**
 * Offline check of a plan file (scripts/validate-netknife-plan.ts): the same parser applyNetknifePlan uses, no
 * controller access. ok=false → lines hold the validation errors; ok=true → a summary, the plan lists and warnings.
 */
export function checkNetknifePlan(text: string): { ok: boolean; lines: string[] } {
    const warnings: PlanWarning[] = [];
    let plan: NetknifePlan;
    try {
        plan = parseNetknifePlan(text.replace(/^\uFEFF/, ''), warnings);
    } catch (error) {
        return { ok: false, lines: [error instanceof Error ? error.message : String(error)] };
    }
    const radios = plan.aps.reduce((n, ap) => n + Object.values(ap.radios).filter(Boolean).length, 0);
    const lbBands = plan.aps.reduce((n, ap) => n + Object.values(ap.loadBalance ?? {}).filter(Boolean).length, 0);
    const lines = [
        `OK: ${plan.aps.length} APs, ${radios} radios, ${lbBands} loadBalance bands, ${plan.aps.filter((ap) => ap.mac).length} with MAC, 0 validation errors`,
        ...planListReport(plan),
    ];
    for (const ap of plan.aps) {
        for (const [band, lb] of Object.entries(ap.loadBalance ?? {})) {
            if (lb && !lb.rssiEnable && lb.threshold !== undefined) {
                lines.push(`note ${ap.name ?? ap.mac}: loadBalance ${band} threshold ${lb.threshold} is not written with rssiEnable false`);
            }
        }
    }
    for (const w of [...warnings, ...helpdeskWarnings(plan.warnings)]) lines.push(`warning ${w.code}: ${w.text}`);
    return { ok: true, lines };
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

/**
 * Compare the plan's "current" block (radios and loadBalance) with the live state. Fields that are null/absent on
 * either side are not compared. A current.loadBalance against an AP whose load-balance could not be read is a mismatch.
 */
export function currentMismatches(ap: ApState, current: NetknifePlan['aps'][number]['current']): string[] {
    const { loadBalance, ...radios } = current ?? {};
    const mismatches: string[] = [];
    for (const [band, expected] of Object.entries(radios) as [RadioBand, z.infer<typeof currentRadioSchema> | null][]) {
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
    for (const [band, expected] of Object.entries(loadBalance ?? {}) as [RadioBand, z.infer<typeof currentLoadBalanceSchema> | null][]) {
        if (!expected) continue;
        if (!ap.loadBalance) {
            mismatches.push(`loadBalance: not read from the controller${ap.loadBalanceError ? ` (${ap.loadBalanceError})` : ''}`);
            break;
        }
        const actual = ap.loadBalance[band] ?? ap.loadBalance[loadBalanceBand(band)];
        if (!actual) {
            mismatches.push(`loadBalance.${band}: the controller returns no RSSI threshold for this band`);
            continue;
        }
        for (const field of ['rssiEnable', 'threshold'] as const) {
            const want = expected[field];
            const have = actual[field];
            if (want === null || want === undefined || have === undefined) continue;
            if (want !== have) mismatches.push(`loadBalance.${band}.${field}: plan expects ${String(want)}, controller has ${String(have)}`);
        }
    }
    return mismatches;
}

/** Frequency band of a radio key, as used in warnings: 5g / 5g1 / 5g2 share channel numbers. */
function bandLabel(band: RadioBand): string {
    if (band === '2g') return '2.4';
    if (band === '6g') return '6';
    return '5';
}

/** Radio of a matched AP for a plan band key ("5g1" in the plan may be exposed as "5g" in the state). */
function stateRadio(ap: ApState, band: RadioBand): RadioState | undefined {
    return ap.radios[band] ?? (band === '5g1' ? ap.radios['5g'] : undefined);
}

/**
 * Check every numeric channel in the plan against the AP's available channels (from the backup read)
 * before anything is written. Returns plan index → error message. APs that are not found or unreadable
 * are left to the main loop; per-AP validation in mergeRadioChange stays as the last line.
 */
export function planChannelErrors(plan: NetknifePlan, state: NetknifeState): Map<number, string> {
    const errors = new Map<number, string>();
    plan.aps.forEach((entry, index) => {
        const ap = findAp(state, entry.mac, entry.name);
        if (!ap || ap.error) return;
        const messages: string[] = [];
        for (const [band, rawChange] of Object.entries(entry.radios) as [RadioBand, RadioChange | null][]) {
            const channel = rawChange?.channel;
            const radio = stateRadio(ap, band);
            if (typeof channel !== 'number' || !radio || radio.channels.includes(channel)) continue;
            messages.push(`${band}: channel ${channel} is not available on this AP (allowed: ${radio.channels.join(', ') || 'none'})`);
        }
        if (messages.length > 0) errors.set(index, messages.join('; '));
    });
    return errors;
}

/** Warn when the plan puts SAME_CHANNEL_WARN_THRESHOLD or more enabled radios on one channel of one band. */
export function sameChannelWarnings(plan: NetknifePlan, state: NetknifeState): PlanWarning[] {
    const groups = new Map<string, { band: string; channel: number; aps: string[] }>();
    for (const entry of plan.aps) {
        const ap = findAp(state, entry.mac, entry.name);
        const label = ap?.name ?? entry.name ?? (entry.mac ? formatMac(entry.mac) : '?');
        for (const [band, rawChange] of Object.entries(entry.radios) as [RadioBand, RadioChange | null][]) {
            const change = compactChange(rawChange);
            if (typeof change.channel !== 'number') continue;
            const enabled = change.enabled ?? (ap ? stateRadio(ap, band)?.enabled : undefined) ?? true;
            if (!enabled) continue;
            const key = `${bandLabel(band)}:${change.channel}`;
            const group = groups.get(key) ?? { band: bandLabel(band), channel: change.channel, aps: [] };
            if (!group.aps.includes(label)) group.aps.push(label);
            groups.set(key, group);
        }
    }
    return [...groups.values()]
        .filter((g) => g.aps.length >= SAME_CHANNEL_WARN_THRESHOLD)
        .map((g) => ({
            source: 'plan-check' as const,
            code: 'plan_same_channel',
            band: g.band,
            channel: g.channel,
            aps: g.aps,
            text: `План ставит ${g.aps.length} точек на канал ${g.channel} (${g.band} ГГц): ${g.aps.join(', ')}. Проверьте план перед записью.`,
        }));
}

/** Normalize the optional Helpdesk "warnings" field. Malformed items are kept as far as possible, never rejected. */
export function helpdeskWarnings(raw: unknown): PlanWarning[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
        const record = asRecord(item);
        const code = str(record.code) ?? 'unknown';
        const aps = Array.isArray(record.aps) ? record.aps.filter((a): a is string => typeof a === 'string') : [];
        const text = str(record.text) ?? (typeof item === 'string' ? item : code);
        return { source: 'helpdesk' as const, code, band: str(record.band), aps, text: `Helpdesk предупреждает: ${text}` };
    });
}

/** Normalize the optional "unmanaged" / "unchanged" plan lists. Malformed items are kept as far as possible, never rejected. */
export function planListedAps(raw: unknown): PlanListedAp[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
        const record = asRecord(item);
        const mac = str(record.mac);
        return {
            name: str(record.name) ?? (typeof item === 'string' ? item : null),
            mac: mac ? formatMac(mac) : null,
            reason: str(record.reason),
            text: str(record.text),
        };
    });
}

function listedLabel(ap: PlanListedAp): string {
    return ap.name ?? ap.mac ?? '?';
}

/** Report lines for the plan's "unmanaged" / "unchanged" lists (empty lists are not reported). */
export function planListReport(plan: NetknifePlan): string[] {
    const lines: string[] = [];
    const unmanaged = planListedAps(plan.unmanaged);
    const unchanged = planListedAps(plan.unchanged);
    if (unmanaged.length > 0) lines.push(`unmanaged: ${unmanaged.length} (не записываются): ${unmanaged.map(listedLabel).join(', ')}`);
    if (unchanged.length > 0) lines.push(`unchanged: ${unchanged.length}: ${unchanged.map(listedLabel).join(', ')}`);
    return lines;
}

function notFoundReason(entry: NetknifePlan['aps'][number]): string {
    if (!entry.mac) return `not on the controller: plan has no MAC and no unique AP named "${entry.name}" on the site — not written`;
    return `not on the controller: MAC ${formatMac(entry.mac)} not found on the site${entry.name ? ` (nor a unique AP named "${entry.name}")` : ''} — not written`;
}

/**
 * Apply a netknife-omada/1 plan AP by AP. Backup (state before changes) is always returned.
 *
 * Before any write, every planned channel is checked against the AP's available channels. An AP with an
 * unavailable channel is an error and is never written. With stopOnError (default) the whole plan is
 * blocked — the remaining APs are skipped, so a bad plan is never half-applied; without it the other APs proceed.
 * Warnings (3+ APs on one channel, Helpdesk warnings) are reported in dry-run and write mode but never block.
 * An AP that is not on the controller (no MAC and no unique name match, or an unknown MAC) is skipped with a reason —
 * not an error, the rest of the plan proceeds. The plan's "unmanaged" / "unchanged" lists are only reported.
 */
export async function applyNetknifePlan(client: RadioClient, planInput: unknown, options: ApplyPlanOptions): Promise<ApplyPlanResult> {
    const parseWarnings: PlanWarning[] = [];
    const plan = parseNetknifePlan(planInput, parseWarnings);
    const backup = await collectNetknifeState(client, { siteId: options.siteId, siteName: plan.site, customHeaders: options.customHeaders });
    const warnings = [...parseWarnings, ...sameChannelWarnings(plan, backup), ...helpdeskWarnings(plan.warnings)];
    const channelErrors = planChannelErrors(plan, backup);
    const blocked = options.stopOnError && channelErrors.size > 0;
    const results: ApplyPlanApResult[] = [];
    let stopped = false;

    for (const [index, entry] of plan.aps.entries()) {
        const base = { mac: entry.mac ? formatMac(entry.mac) : null, name: entry.name ?? null, diff: {} };
        const channelError = channelErrors.get(index);
        if (stopped) {
            results.push({ ...base, status: 'skipped', reason: 'not attempted: stopped after previous error (stopOnError)' });
            continue;
        }
        if (blocked && !channelError) {
            results.push({ ...base, status: 'skipped', reason: 'not attempted: plan has APs with unavailable channels (stopOnError)' });
            continue;
        }
        const ap = findAp(backup, entry.mac, entry.name);
        if (!ap) {
            results.push({ ...base, status: 'skipped', reason: notFoundReason(entry) });
            continue;
        }
        const matched = { ...base, mac: ap.mac, name: ap.name };
        if (ap.error) {
            results.push({ ...matched, status: 'error', error: `could not read AP state: ${ap.error}` });
            stopped = options.stopOnError;
            continue;
        }
        if (channelError) {
            results.push({ ...matched, status: 'error', error: channelError });
            stopped = options.stopOnError;
            continue;
        }
        const mismatches = currentMismatches(ap, entry.current);
        if (mismatches.length > 0 && !options.force) {
            results.push({ ...matched, status: 'skipped', reason: 'plan "current" differs from the controller (use force to override)', mismatches });
            continue;
        }
        // Radios first, then the load-balance of the same AP. An entry with only a loadBalance block skips the radio
        // step; an entry with neither keeps the "No radio changes requested" error.
        const lbBlock = entry.loadBalance && Object.values(entry.loadBalance).some(Boolean) ? entry.loadBalance : undefined;
        const radioRequested = Object.values(entry.radios).some((change) => Object.keys(compactChange(change)).length > 0);
        const applyOptions = { dryRun: options.dryRun, siteId: options.siteId, customHeaders: options.customHeaders };
        let radio: ApplyRadioResult | undefined;
        try {
            if (radioRequested || !lbBlock) radio = await applyApRadioChanges(client, ap.mac, entry.radios, applyOptions);
        } catch (error) {
            results.push({ ...matched, status: 'error', error: error instanceof Error ? error.message : String(error) });
            stopped = options.stopOnError;
            continue;
        }
        const radioDiff = radio?.diff ?? {};
        const radioChanged = Object.keys(radioDiff).length > 0;
        const notes = radio?.notes ? { notes: radio.notes } : {};
        if (radio && radioChanged && !radio.dryRun && !radio.verified) {
            results.push({
                ...matched,
                status: 'error',
                diff: radioDiff,
                error: 'verification after PATCH failed',
                mismatches: radio.mismatches,
                ...notes,
            });
            stopped = options.stopOnError;
            continue;
        }

        let lb: ApplyLoadBalancePlanResult | undefined;
        if (lbBlock) {
            try {
                lb = await applyApLoadBalancePlan(client, ap.mac, lbBlock, applyOptions);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const radiosWritten = radioChanged && !options.dryRun ? ' (radios of this AP were already written and verified)' : '';
                results.push({ ...matched, status: 'error', diff: radioDiff, error: `loadBalance: ${message}${radiosWritten}`, ...notes });
                stopped = options.stopOnError;
                continue;
            }
        }
        const lbChanged = lb !== undefined && Object.keys(lb.diff).length > 0;
        const extra = { ...(mismatches.length > 0 ? { mismatches } : {}), ...notes, ...(lb ? { loadBalance: lb } : {}) };

        if (!radioChanged && !lbChanged) {
            results.push({ ...matched, ...extra, status: 'skipped', reason: 'no changes needed', diff: {} });
        } else if (options.dryRun) {
            results.push({ ...matched, ...extra, status: 'dry-run', diff: radioDiff, ...(radio?.request ? { request: radio.request } : {}) });
        } else if (lb && lbChanged && !lb.verified) {
            const lbMismatches = Object.entries(lb.mismatches ?? {}).map(
                ([key, m]) => `loadBalance ${key}: expected ${String(m.expected)}, got ${String(m.actual)}`
            );
            results.push({
                ...matched,
                ...extra,
                status: 'error',
                diff: radioDiff,
                error: 'load-balance verification after PATCH failed (controller ignored the change)',
                mismatches: lbMismatches,
            });
            stopped = options.stopOnError;
        } else {
            results.push({ ...matched, ...extra, status: 'applied', diff: radioDiff });
        }
    }

    const summary: Record<ApplyStatus, number> = { applied: 0, skipped: 0, error: 0, 'dry-run': 0 };
    for (const r of results) summary[r.status]++;
    if (warnings.length > 0) logger.warn('NetKnife plan warnings', { dryRun: options.dryRun, warnings: warnings.map((w) => w.text).join(' | ') });
    return {
        format: NETKNIFE_FORMAT,
        kind: 'apply-result',
        dryRun: options.dryRun,
        backup,
        warnings,
        results,
        summary,
        unmanaged: planListedAps(plan.unmanaged),
        unchanged: planListedAps(plan.unchanged),
        report: planListReport(plan),
    };
}
