import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RSSI_THRESHOLD_MAX, RSSI_THRESHOLD_MIN } from '../../src/tools/setApLoadBalance.js';
import * as loggerModule from '../../src/utils/logger.js';
import {
    applyApRadioChanges,
    applyNetknifePlan,
    channelDetailsFor,
    checkNetknifePlan,
    collectNetknifeState,
    compactChange,
    currentMismatches,
    formatMac,
    helpdeskWarnings,
    LB_THRESHOLD_MAX,
    LB_THRESHOLD_MIN,
    loadBalanceBand,
    loadBalanceFromConfig,
    loadBalanceStateSchema,
    type NetknifeState,
    normalizeMac,
    normalizePlanCurrent,
    type PlanWarning,
    parseNetknifePlan,
    planChannelErrors,
    planListedAps,
    planListReport,
    radioStateFromSetting,
    radiosFromConfig,
    resolveBand,
    settingForWrite,
    toIsoCountry,
} from '../../src/utils/netknife-omada.js';
import { createFakeOmada, exampleAp, exampleAvailableChannels, exampleLoadBalance, type FakeAp } from '../helpers/fakeOmada.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/netknife-omada-state.json', import.meta.url), 'utf8')) as NetknifeState;

/** n APs like exampleAp() with distinct MACs and names "AP-1".."AP-n" (all on 5g channel 36). */
function manyAps(n: number): FakeAp[] {
    return Array.from({ length: n }, (_, i) => ({
        ...exampleAp(),
        mac: `3C-64-CF-69-9A-${(0x10 + i).toString(16).toUpperCase()}`,
        name: `AP-${i + 1}`,
    }));
}

function planFor(aps: FakeAp[], radios: (i: number) => Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return { format: 'netknife-omada/1', kind: 'plan', ...extra, aps: aps.map((ap, i) => ({ name: ap.name, mac: ap.mac, radios: radios(i) })) };
}

/** Build a plan from a state without changing anything (what NetKnife emits when it keeps the current settings). */
function planFromState(state: NetknifeState): Record<string, unknown> {
    return {
        format: 'netknife-omada/1',
        kind: 'plan',
        site: state.site,
        aps: state.aps.map((ap) => ({
            name: ap.name,
            mac: ap.mac,
            radios: Object.fromEntries(
                Object.entries(ap.radios).map(([band, r]) => [
                    band,
                    { channel: r?.channel, width: r?.width, txPowerMode: r?.txPowerMode, txPower: r?.txPower },
                ])
            ),
            current: Object.fromEntries(
                Object.entries(ap.radios).map(([band, r]) => [band, { channel: r?.channel, width: r?.width, txPower: r?.txPower }])
            ),
        })),
    };
}

describe('utils/netknife-omada', () => {
    beforeEach(() => {
        vi.spyOn(loggerModule.logger, 'info').mockImplementation(() => undefined);
        vi.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('mac helpers', () => {
        it('normalizes dashes, colons and case', () => {
            expect(normalizeMac('3c:64:cf:69:9a:64')).toBe('3C64CF699A64');
            expect(normalizeMac('3C-64-CF-69-9A-64')).toBe('3C64CF699A64');
        });

        it('formats as AA-BB-CC-DD-EE-FF and leaves invalid input unchanged', () => {
            expect(formatMac('3c:64:cf:69:9a:64')).toBe('3C-64-CF-69-9A-64');
            expect(formatMac('not-a-mac')).toBe('not-a-mac');
        });
    });

    describe('toIsoCountry', () => {
        it('maps Omada country names to ISO codes', () => {
            expect(toIsoCountry('Russia')).toBe('RU');
            expect(toIsoCountry('United States')).toBe('US');
            expect(toIsoCountry('germany')).toBe('DE');
            expect(toIsoCountry('Russian Federation')).toBe('RU');
        });

        it('passes 2-letter codes through and keeps unknown names', () => {
            expect(toIsoCountry('ru')).toBe('RU');
            expect(toIsoCountry('Atlantis')).toBe('Atlantis');
        });

        it('returns null for missing region', () => {
            expect(toIsoCountry(undefined)).toBeNull();
            expect(toIsoCountry('  ')).toBeNull();
        });
    });

    describe('channelDetailsFor', () => {
        it('accepts a single object response (as in the OpenAPI schema)', () => {
            const single = (exampleAvailableChannels() as unknown[])[1];
            expect(channelDetailsFor(single, 1)).toHaveLength(19);
            expect(channelDetailsFor(single, 0)).toEqual([]);
        });

        it('skips malformed entries and parses numeric strings', () => {
            const available = [
                {
                    radioId: '0',
                    apChannelDetailList: [
                        { channel: '1', freq: '2412' },
                        { channel: 2 },
                        null,
                        { channel: 3, freq: 2422, availableChannelWidthList: 'x' },
                    ],
                },
            ];
            expect(channelDetailsFor(available, 0)).toEqual([
                { channel: 1, freq: 2412, index: undefined, widths: [] },
                { channel: 3, freq: 2422, index: undefined, widths: [] },
            ]);
            expect(channelDetailsFor(null, 0)).toEqual([]);
            expect(channelDetailsFor([{ radioId: 0 }], 0)).toEqual([]);
        });
    });

    describe('radioStateFromSetting', () => {
        const details = channelDetailsFor(exampleAvailableChannels(), 1);

        it('decodes auto channel, auto width and non-custom power', () => {
            const state = radioStateFromSetting({ radioEnable: true, channel: '0', channelWidth: '6', txPowerLevel: 2, txPower: 25 }, details);
            expect(state).toMatchObject({ enabled: true, channel: 'auto', width: 'auto', txPowerMode: 'high', txPower: null });
        });

        it('prefers freq, then channel number, then channel index', () => {
            expect(radioStateFromSetting({ channel: '1', freq: 5200 }, details).channel).toBe(40);
            expect(radioStateFromSetting({ channel: '44' }, details).channel).toBe(44);
            expect(radioStateFromSetting({ channel: '2' }, details).channel).toBe(40);
            expect(radioStateFromSetting({ channel: '165' }, details).channel).toBe(165);
        });

        it('maps every width code and defaults unknown values', () => {
            const widthOf = (code: string) => radioStateFromSetting({ channelWidth: code }, details).width;
            expect(['2', '3', '4', '5', '6', '7', '8', '9', '10', '99'].map(widthOf)).toEqual([
                20,
                40,
                'auto',
                80,
                'auto',
                160,
                'auto',
                240,
                320,
                'auto',
            ]);
            const state = radioStateFromSetting({}, []);
            expect(state).toMatchObject({ enabled: false, channel: 'auto', txPowerMode: 'auto', txPower: null, channels: [], widths: [] });
        });

        it('returns null txPower for custom mode without a value', () => {
            expect(radioStateFromSetting({ txPowerLevel: 3 }, details).txPower).toBeNull();
        });
    });

    describe('resolveBand / radiosFromConfig', () => {
        it('maps 5g to 5g1 on tri-band APs', () => {
            expect(resolveBand({ radioSetting5g1: {} }, '5g')).toBe('5g1');
            expect(resolveBand({ radioSetting5g: {} }, '5g')).toBe('5g');
            expect(resolveBand({}, '2g')).toBe('2g');
        });

        it('exposes 5g1 as 5g and keeps 5g2 / 6g', () => {
            const radios = radiosFromConfig(
                {
                    radioSetting5g1: { channel: '36' },
                    radioSetting5g2: { channel: '0' },
                    radioSetting6g: { channel: '0', channelWidth: '8' },
                    radioSetting2g: null,
                },
                []
            );
            expect(Object.keys(radios).sort()).toEqual(['5g', '5g2', '6g']);
            expect(radios['6g']?.width).toBe('auto');
            expect(radiosFromConfig(undefined, [])).toEqual({});
        });
    });

    describe('compactChange', () => {
        it('drops null and undefined fields', () => {
            expect(compactChange({ channel: null, width: 40, txPower: undefined, enabled: false })).toEqual({ width: 40, enabled: false });
            expect(compactChange(null)).toEqual({});
        });
    });

    describe('collectNetknifeState', () => {
        it('produces the OMADA-EXCHANGE.md example state', async () => {
            const client = createFakeOmada([exampleAp()]);
            const state = await collectNetknifeState(client, { siteName: 'Алые паруса' });
            expect({ ...state, generated: fixture.generated }).toEqual(fixture);
            expect(client.listDevices).toHaveBeenCalledWith(undefined, undefined);
            expect(Number.isNaN(Date.parse(state.generated))).toBe(false);
        });

        it('falls back to the Omada site name and reports per-AP read errors', async () => {
            const client = createFakeOmada([exampleAp()], { site: { name: 'Alie Parusa' } });
            client.getRadiosConfig.mockRejectedValueOnce(new Error('AP offline'));
            const state = await collectNetknifeState(client, { siteId: 'site-1' });
            expect(state.site).toBe('Alie Parusa');
            expect(state.country).toBeNull();
            expect(state.aps[0]).toMatchObject({ name: 'Кухня', mac: '3C-64-CF-69-9A-64', radios: {}, error: 'AP offline' });
            expect(client.getApDetail).toHaveBeenCalledWith('3C-64-CF-69-9A-64', 'site-1', undefined);
        });

        it('uses device list values when AP detail is sparse and siteId when site has no name', async () => {
            const client = createFakeOmada([exampleAp()], { site: {} });
            client.getApDetail.mockResolvedValueOnce({});
            client.listDevices.mockResolvedValueOnce([{ mac: '3c:64:cf:69:9a:64', type: 'AP' }]);
            client.getRadiosConfig.mockRejectedValueOnce('boom');
            const state = await collectNetknifeState(client, { siteId: 'site-1' });
            expect(state.site).toBe('site-1');
            expect(state.aps[0]).toMatchObject({ name: '3C-64-CF-69-9A-64', ip: null, model: null, error: 'boom' });
        });
    });

    describe('applyApRadioChanges', () => {
        it('dry-run validates, maps and returns diff without PATCH', async () => {
            const client = createFakeOmada([exampleAp()]);
            const result = await applyApRadioChanges(
                client,
                '3c:64:cf:69:9a:64',
                { '5g': { channel: 44, width: 80, txPower: 17 } },
                { dryRun: true }
            );
            expect(client.modifyRadiosConfig).not.toHaveBeenCalled();
            expect(result.dryRun).toBe(true);
            expect(result.verified).toBe(false);
            expect(result.diff).toEqual({
                '5g': { channel: { from: 36, to: 44 }, width: { from: 40, to: 80 }, txPower: { from: 20, to: 17 } },
            });
            expect(result.request).toEqual({
                radioSetting5g: expect.objectContaining({ channel: '44', freq: 5220, channelWidth: '5', txPower: 17, txPowerLevel: 3 }),
            });
        });

        it('writes, re-reads and verifies; only the changed band is sent', async () => {
            const client = createFakeOmada([exampleAp()]);
            const result = await applyApRadioChanges(
                client,
                '3C-64-CF-69-9A-64',
                { '2g': { channel: 'auto', width: 'auto', txPowerMode: 'auto' }, '5g': { channel: 36 } },
                { dryRun: false, siteId: 'site-1' }
            );
            expect(client.modifyRadiosConfig).toHaveBeenCalledTimes(1);
            const [mac, body, siteId] = client.modifyRadiosConfig.mock.calls[0];
            expect(mac).toBe('3C-64-CF-69-9A-64');
            expect(siteId).toBe('site-1');
            expect(Object.keys(body)).toEqual(['radioSetting2g']);
            expect(body.radioSetting2g).toMatchObject({ channel: '0', channelWidth: '4', txPowerLevel: 4, wirelessMode: -2 });
            expect(body.radioSetting2g).not.toHaveProperty('freq');
            expect(result.verified).toBe(true);
            expect(result.after['2g']).toMatchObject({ channel: 'auto', width: 'auto', txPowerMode: 'auto', txPower: null });
            expect(result.diff['5g']).toBeUndefined();
            expect(loggerModule.logger.info).toHaveBeenCalledWith(
                'Omada radio-config PATCH',
                expect.objectContaining({ apMac: '3C-64-CF-69-9A-64', bands: ['2g'] })
            );
        });

        it('uses band-specific auto width codes and maps power modes', async () => {
            const ap = exampleAp();
            ap.config.radioSetting6g = { radioEnable: false, channel: '0', channelWidth: '7', txPowerLevel: 0 };
            const client = createFakeOmada([ap]);
            const result = await applyApRadioChanges(
                client,
                ap.mac,
                { '5g': { width: 'auto', txPowerMode: 'medium' }, '6g': { width: 'auto', enabled: true } },
                { dryRun: true }
            );
            expect(result.request?.radioSetting5g).toMatchObject({ channelWidth: '6', txPowerLevel: 1 });
            expect(result.request?.radioSetting6g).toMatchObject({ channelWidth: '8', radioEnable: true });
        });

        it('reports verification failure when the controller ignores the write', async () => {
            const client = createFakeOmada([exampleAp()], { ignoreWrites: true });
            const result = await applyApRadioChanges(client, '3C-64-CF-69-9A-64', { '5g': { channel: 40 } }, { dryRun: false });
            expect(result.verified).toBe(false);
            expect(result.mismatches).toEqual(['5g.channel: expected 40, got 36']);
            expect(loggerModule.logger.warn).toHaveBeenCalled();
        });

        it('does not PATCH when nothing differs', async () => {
            const client = createFakeOmada([exampleAp()]);
            const result = await applyApRadioChanges(client, '3C-64-CF-69-9A-64', { '2g': { channel: 6, txPower: 14 } }, { dryRun: false });
            expect(result).toMatchObject({ diff: {}, verified: true });
            expect(client.modifyRadiosConfig).not.toHaveBeenCalled();
        });

        it('rejects empty changes and missing radios', async () => {
            const client = createFakeOmada([exampleAp()]);
            await expect(applyApRadioChanges(client, '3C-64-CF-69-9A-64', { '2g': { channel: null } }, { dryRun: true })).rejects.toThrow(
                'No radio changes requested'
            );
            await expect(applyApRadioChanges(client, '3C-64-CF-69-9A-64', { '6g': { channel: 'auto' } }, { dryRun: true })).rejects.toThrow(
                '6g: AP 3C-64-CF-69-9A-64 has no such radio'
            );
        });

        it.each([
            [{ '2g': { channel: 14 } }, '2g: channel 14 is not available on this AP'],
            [{ '2g': { width: 80 } }, '2g: width 80 MHz is not supported'],
            [{ '5g': { channel: 140, width: 80 } }, '5g: width 80 MHz is not allowed on channel 140'],
            [{ '5g': { txPowerMode: 'high', txPower: 10 } }, 'txPower can only be set with txPowerMode "custom"'],
            [{ '5g': { txPower: 40 } }, '5g: txPower 40 dBm is out of range 1..30'],
        ])('validates %j', async (changes, message) => {
            const client = createFakeOmada([exampleAp()]);
            await expect(applyApRadioChanges(client, '3C-64-CF-69-9A-64', changes as never, { dryRun: true })).rejects.toThrow(message);
        });

        it('explains when the AP reports no channels or widths', async () => {
            const ap = exampleAp();
            ap.available = [];
            const client = createFakeOmada([ap]);
            await expect(applyApRadioChanges(client, ap.mac, { '2g': { channel: 1 } }, { dryRun: true })).rejects.toThrow('(allowed: none)');
            await expect(applyApRadioChanges(client, ap.mac, { '2g': { width: 20 } }, { dryRun: true })).rejects.toThrow('(allowed: none)');
        });
    });

    describe('parseNetknifePlan', () => {
        it('accepts a JSON string and an object', () => {
            const plan = planFromState(fixture);
            expect(parseNetknifePlan(JSON.stringify(plan)).aps).toHaveLength(1);
            expect(parseNetknifePlan(plan).site).toBe('Алые паруса');
        });

        it('rejects invalid JSON, wrong kind and APs without mac/name', () => {
            expect(() => parseNetknifePlan('{oops')).toThrow('plan is not valid JSON');
            expect(() => parseNetknifePlan({ ...fixture })).toThrow('kind');
            expect(() => parseNetknifePlan({ format: 'netknife-omada/1', kind: 'plan', aps: [{ radios: {} }] })).toThrow('each AP needs mac or name');
        });

        it('accepts "auto" for channel and width in radios and current', () => {
            const auto = { channel: 'auto', width: 'auto', txPowerMode: 'auto', txPower: null };
            const plan = parseNetknifePlan({
                format: 'netknife-omada/1',
                kind: 'plan',
                aps: [
                    {
                        mac: '3C-64-CF-69-9A-64',
                        radios: { '2g': auto, '5g': auto },
                        current: { '2g': { channel: 'auto', width: 'auto', txPower: 14 } },
                    },
                ],
            });
            expect(plan.aps[0].radios['5g']).toMatchObject({ channel: 'auto', width: 'auto' });
            expect(plan.aps[0].current?.['2g']).toMatchObject({ channel: 'auto', width: 'auto' });
        });

        it('normalizes numeric strings in current with a warning; radios stay strict', () => {
            const warnings: PlanWarning[] = [];
            const plan = parseNetknifePlan(
                {
                    format: 'netknife-omada/1',
                    kind: 'plan',
                    aps: [
                        {
                            name: 'Кухня',
                            mac: '3C-64-CF-69-9A-64',
                            radios: { '2g': { channel: 1, width: 20 } },
                            current: { '2g': { channel: '1', width: '20', txPower: 14 }, '5g': { channel: 'auto', width: '80', txPower: '' } },
                        },
                        { name: 'Холл', mac: '3C-64-CF-69-9A-65', radios: {}, current: { '5g': { channel: 36, width: 40, txPower: 20 } } },
                    ],
                },
                warnings
            );
            expect(plan.aps[0].current).toEqual({
                '2g': { channel: 1, width: 20, txPower: 14 },
                '5g': { channel: 'auto', width: 80, txPower: null },
            });
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toMatchObject({
                source: 'plan-check',
                code: 'plan_current_strings',
                aps: ['Кухня (2g.channel, 2g.width, 5g.width, 5g.txPower)'],
            });

            const strict = (radios: Record<string, unknown>) => () =>
                parseNetknifePlan({ format: 'netknife-omada/1', kind: 'plan', aps: [{ mac: '3C-64-CF-69-9A-64', radios: { '2g': radios } }] });
            expect(strict({ channel: '1' })).toThrow('aps.0.radios.2g.channel');
            expect(strict({ width: '20' })).toThrow('aps.0.radios.2g.width');
            expect(strict({ txPower: '17' })).toThrow('aps.0.radios.2g.txPower');
            expect(() =>
                parseNetknifePlan({
                    format: 'netknife-omada/1',
                    kind: 'plan',
                    aps: [{ mac: '3C-64-CF-69-9A-64', current: { '2g': { channel: 'six' } } }],
                })
            ).toThrow('aps.0.current.2g.channel');
        });

        it('leaves a clean plan untouched', () => {
            const plan = planFromState(fixture);
            expect(normalizePlanCurrent(plan)).toEqual({ value: plan, warnings: [] });
            expect(normalizePlanCurrent('oops')).toEqual({ value: 'oops', warnings: [] });
        });
    });

    describe('currentMismatches', () => {
        it('ignores nulls and reports missing radios', () => {
            const ap = fixture.aps[0];
            expect(currentMismatches(ap, { '2g': { channel: 6, txPower: null }, '5g': null })).toEqual([]);
            expect(currentMismatches(ap, { '6g': { channel: 1 } })).toEqual(['6g: radio not present on AP']);
            expect(currentMismatches(ap, { '5g': { channel: 40, width: 40 } })).toEqual(['5g.channel: plan expects 40, controller has 36']);
            expect(currentMismatches(ap, undefined)).toEqual([]);
        });
    });

    describe('applyNetknifePlan', () => {
        const options = { dryRun: true, force: false, stopOnError: true };

        it('round-trip: state → unchanged plan → empty diff, nothing written', async () => {
            const client = createFakeOmada([exampleAp()]);
            const state = await collectNetknifeState(client, { siteName: 'Алые паруса' });
            const result = await applyNetknifePlan(client, JSON.stringify(planFromState(state)), { ...options, dryRun: false });
            expect(result.results).toEqual([{ mac: '3C-64-CF-69-9A-64', name: 'Кухня', status: 'skipped', reason: 'no changes needed', diff: {} }]);
            expect(client.modifyRadiosConfig).not.toHaveBeenCalled();
            expect(result.backup.aps[0].radios).toEqual(fixture.aps[0].radios);
        });

        it('dry-run returns backup and per-AP diff (fixture plan)', async () => {
            const client = createFakeOmada([exampleAp()]);
            const plan = {
                format: 'netknife-omada/1',
                kind: 'plan',
                site: 'Алые паруса',
                aps: [
                    {
                        name: 'Кухня',
                        mac: '3c:64:cf:69:9a:64',
                        radios: {
                            '2g': { channel: 1, width: 20, txPowerMode: 'custom', txPower: 12 },
                            '5g': { channel: 44, width: null, txPower: 18 },
                        },
                        current: { '2g': { channel: 6, width: 20, txPower: 14 }, '5g': { channel: 36, width: 40, txPower: 20 } },
                    },
                ],
            };
            const result = await applyNetknifePlan(client, plan, options);
            expect(result.summary).toEqual({ applied: 0, skipped: 0, error: 0, 'dry-run': 1 });
            expect(result.backup.kind).toBe('state');
            expect(result.results[0]).toMatchObject({
                mac: '3C-64-CF-69-9A-64',
                status: 'dry-run',
                diff: {
                    '2g': { channel: { from: 6, to: 1 }, txPower: { from: 14, to: 12 } },
                    '5g': { channel: { from: 36, to: 44 }, txPower: { from: 20, to: 18 } },
                },
            });
            expect(client.modifyRadiosConfig).not.toHaveBeenCalled();
        });

        it('applies and verifies when dryRun=false', async () => {
            const client = createFakeOmada([exampleAp()]);
            const plan = { format: 'netknife-omada/1', kind: 'plan', aps: [{ mac: '3C-64-CF-69-9A-64', radios: { '5g': { channel: 48 } } }] };
            const result = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
            expect(result.results[0]).toMatchObject({ status: 'applied', diff: { '5g': { channel: { from: 36, to: 48 } } } });
            expect(client.modifyRadiosConfig).toHaveBeenCalledTimes(1);
        });

        it('skips APs whose current differs unless force is set', async () => {
            const plan = {
                format: 'netknife-omada/1',
                kind: 'plan',
                aps: [{ mac: '3C-64-CF-69-9A-64', radios: { '5g': { channel: 48 } }, current: { '5g': { channel: 40 } } }],
            };
            const skipped = await applyNetknifePlan(createFakeOmada([exampleAp()]), plan, { ...options, dryRun: false });
            expect(skipped.results[0]).toMatchObject({ status: 'skipped', mismatches: ['5g.channel: plan expects 40, controller has 36'] });

            const client = createFakeOmada([exampleAp()]);
            const forced = await applyNetknifePlan(client, plan, { ...options, dryRun: false, force: true });
            expect(forced.results[0]).toMatchObject({ status: 'applied', mismatches: ['5g.channel: plan expects 40, controller has 36'] });
        });

        it('dry-run accepts an older Helpdesk plan with numeric strings in current and warns about it', async () => {
            const client = createFakeOmada([exampleAp()]);
            const plan = {
                format: 'netknife-omada/1',
                kind: 'plan',
                aps: [
                    {
                        name: 'Кухня',
                        mac: '3C-64-CF-69-9A-64',
                        radios: { '5g': { channel: 44, width: 40 } },
                        current: { '2g': { channel: '6', width: '20', txPower: 14 }, '5g': { channel: '36', width: '40', txPower: 20 } },
                    },
                ],
            };
            const result = await applyNetknifePlan(client, plan, options);
            expect(result.results[0]).toMatchObject({ status: 'dry-run', diff: { '5g': { channel: { from: 36, to: 44 } } } });
            expect(result.results[0].mismatches).toBeUndefined();
            expect(result.warnings.map((w) => w.code)).toEqual(['plan_current_strings']);
            expect(client.modifyRadiosConfig).not.toHaveBeenCalled();
        });

        it('matches by name when mac is absent', async () => {
            const client = createFakeOmada([exampleAp()]);
            const plan = { format: 'netknife-omada/1', kind: 'plan', aps: [{ name: 'Кухня', radios: { '2g': { channel: 11 } } }] };
            const result = await applyNetknifePlan(client, plan, options);
            expect(result.results[0]).toMatchObject({ status: 'dry-run', mac: '3C-64-CF-69-9A-64', name: 'Кухня' });
        });

        describe('APs not on the controller (skipped, never an error)', () => {
            // As in plan 3 of "Алые паруса": two APs without MAC at the end of the list, unknown to Omada.
            const plan = (radios: (i: number) => Record<string, unknown>) => {
                const base = planFor(manyAps(3), radios);
                return {
                    ...base,
                    aps: [
                        ...base.aps,
                        { name: 'AP 00:5A', mac: null, radios: { '5g': { channel: 44 } } },
                        { name: 'AP EC:20', radios: { '2g': { channel: 6 } } },
                    ],
                };
            };

            it('dry-run: unknown APs skipped with a reason, the others are processed', async () => {
                const client = createFakeOmada(manyAps(3));
                const result = await applyNetknifePlan(
                    client,
                    plan((i) => ({ '5g': { channel: [40, 44, 48][i] } })),
                    options
                );
                expect(result.summary).toEqual({ applied: 0, skipped: 2, error: 0, 'dry-run': 3 });
                expect(result.results.slice(3)).toEqual([
                    {
                        mac: null,
                        name: 'AP 00:5A',
                        status: 'skipped',
                        diff: {},
                        reason: 'not on the controller: plan has no MAC and no unique AP named "AP 00:5A" on the site — not written',
                    },
                    expect.objectContaining({ name: 'AP EC:20', status: 'skipped', reason: expect.stringContaining('no MAC') }),
                ]);
            });

            it('write: the known APs are applied, the run has no errors, stopOnError is not triggered', async () => {
                const client = createFakeOmada(manyAps(3));
                const result = await applyNetknifePlan(
                    client,
                    plan((i) => ({ '5g': { channel: [40, 44, 48][i] } })),
                    {
                        ...options,
                        dryRun: false,
                    }
                );
                expect(result.summary).toEqual({ applied: 3, skipped: 2, error: 0, 'dry-run': 0 });
                expect(client.modifyRadiosConfig).toHaveBeenCalledTimes(3);
            });

            it('an unknown MAC is skipped too, also in the middle of the plan', async () => {
                const aps = manyAps(2);
                const client = createFakeOmada(structuredClone(aps));
                const result = await applyNetknifePlan(
                    client,
                    {
                        format: 'netknife-omada/1',
                        kind: 'plan',
                        aps: [
                            { name: 'AP-1', mac: aps[0].mac, radios: { '5g': { channel: 40 } } },
                            { name: 'Гостиная', mac: 'aa:aa:aa:aa:aa:aa', radios: { '2g': { channel: 1 } } },
                            { mac: 'BB-BB-BB-BB-BB-BB', radios: { '2g': { channel: 1 } } },
                            { name: 'AP-2', mac: aps[1].mac, radios: { '5g': { channel: 44 } } },
                        ],
                    },
                    { ...options, dryRun: false }
                );
                expect(result.results.map((r) => r.status)).toEqual(['applied', 'skipped', 'skipped', 'applied']);
                expect(result.results[1]).toMatchObject({
                    mac: 'AA-AA-AA-AA-AA-AA',
                    reason: 'not on the controller: MAC AA-AA-AA-AA-AA-AA not found on the site (nor a unique AP named "Гостиная") — not written',
                });
                expect(result.results[2].reason).toBe('not on the controller: MAC BB-BB-BB-BB-BB-BB not found on the site — not written');
                expect(result.summary.error).toBe(0);
            });

            it('an unreadable AP is still an error and stops the plan', async () => {
                const client = createFakeOmada(manyAps(2));
                client.getApDetail.mockRejectedValueOnce(new Error('timeout'));
                const result = await applyNetknifePlan(
                    client,
                    planFor(manyAps(2), () => ({ '2g': { channel: 1 } })),
                    options
                );
                expect(result.results.map((r) => r.status)).toEqual(['error', 'skipped']);
            });
        });

        it('reports validation errors, unreadable APs and failed verification as errors', async () => {
            const invalid = { format: 'netknife-omada/1', kind: 'plan', aps: [{ mac: '3C-64-CF-69-9A-64', radios: { '2g': { channel: 99 } } }] };
            const r1 = await applyNetknifePlan(createFakeOmada([exampleAp()]), invalid, options);
            expect(r1.results[0]).toMatchObject({ status: 'error', error: expect.stringContaining('channel 99') });

            const offline = createFakeOmada([exampleAp()]);
            offline.getRadiosConfig.mockRejectedValueOnce(new Error('timeout'));
            const r2 = await applyNetknifePlan(
                offline,
                { ...invalid, aps: [{ mac: '3C-64-CF-69-9A-64', radios: { '2g': { channel: 1 } } }] },
                options
            );
            expect(r2.results[0]).toMatchObject({ status: 'error', error: 'could not read AP state: timeout' });

            const lying = createFakeOmada([exampleAp()], { ignoreWrites: true });
            const r3 = await applyNetknifePlan(
                lying,
                { ...invalid, aps: [{ mac: '3C-64-CF-69-9A-64', radios: { '2g': { channel: 1 } } }] },
                { ...options, dryRun: false }
            );
            expect(r3.results[0]).toMatchObject({
                status: 'error',
                error: 'verification after PATCH failed',
                mismatches: ['2g.channel: expected 1, got 6'],
            });
            expect(r3.summary.error).toBe(1);
        });

        describe('channel validation (blocks the write)', () => {
            it('channel outside the AP list: error in dry-run and on write, nothing is written', async () => {
                const aps = manyAps(3);
                // AP-2 reports a narrower 5 GHz list than the others (e.g. DFS disabled on this unit)
                const narrow = exampleAvailableChannels() as { radioId: number; apChannelDetailList: { channel: number }[] }[];
                narrow[1].apChannelDetailList = narrow[1].apChannelDetailList.filter((d) => d.channel <= 48);
                aps[1].available = narrow;
                const plan = planFor(aps, (i) => ({ '5g': { channel: [40, 100, 44][i] } }));

                const dry = await applyNetknifePlan(createFakeOmada(structuredClone(aps)), plan, options);
                expect(dry.results.map((r) => r.status)).toEqual(['skipped', 'error', 'skipped']);
                expect(dry.results[1]).toMatchObject({
                    name: 'AP-2',
                    error: '5g: channel 100 is not available on this AP (allowed: 36, 40, 44, 48)',
                });
                expect(dry.results[0].reason).toContain('unavailable channels');

                const client = createFakeOmada(structuredClone(aps));
                const write = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(write.summary).toEqual({ applied: 0, skipped: 2, error: 1, 'dry-run': 0 });
                expect(client.modifyRadiosConfig).not.toHaveBeenCalled();
            });

            it('without stopOnError only the bad AP is not written', async () => {
                const aps = manyAps(3);
                const plan = planFor(aps, (i) => ({ '5g': { channel: [40, 165, 44][i] } }));
                const client = createFakeOmada(aps);
                const result = await applyNetknifePlan(client, plan, { ...options, dryRun: false, stopOnError: false });
                expect(result.results.map((r) => r.status)).toEqual(['applied', 'error', 'applied']);
                expect(result.results[1].error).toContain('channel 165 is not available');
                expect(client.modifyRadiosConfig).toHaveBeenCalledTimes(2);
                expect(client.modifyRadiosConfig.mock.calls.map((c) => c[0])).not.toContain(aps[1].mac);
            });

            it('checks 2.4 GHz and skips unmatched or unreadable APs (left to the main loop)', async () => {
                const aps = manyAps(2);
                const plan = parseNetknifePlan({
                    format: 'netknife-omada/1',
                    kind: 'plan',
                    aps: [
                        { mac: aps[0].mac, radios: { '2g': { channel: 14 }, '5g': { channel: 'auto' } } },
                        { mac: 'AA-AA-AA-AA-AA-AA', radios: { '2g': { channel: 99 } } },
                        { mac: aps[1].mac, radios: { '6g': { channel: 5 } } },
                    ],
                });
                const state = await collectNetknifeState(createFakeOmada(aps));
                const errors = planChannelErrors(plan, state);
                expect([...errors.keys()]).toEqual([0]);
                expect(errors.get(0)).toContain('2g: channel 14 is not available');
            });
        });

        describe('warnings (never block the write)', () => {
            it('10 APs on one 5 GHz channel: warning with the AP list, write still happens', async () => {
                const aps = manyAps(10);
                const plan = planFor(aps, () => ({ '5g': { channel: 48 } }));

                const dry = await applyNetknifePlan(createFakeOmada(structuredClone(aps)), plan, options);
                expect(dry.warnings).toEqual([
                    {
                        source: 'plan-check',
                        code: 'plan_same_channel',
                        band: '5',
                        channel: 48,
                        aps: aps.map((ap) => ap.name),
                        text: expect.stringContaining('План ставит 10 точек на канал 48 (5 ГГц): AP-1, AP-2'),
                    },
                ]);
                expect(dry.summary['dry-run']).toBe(10);

                const client = createFakeOmada(aps);
                const write = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(write.warnings).toHaveLength(1);
                expect(write.summary).toEqual({ applied: 10, skipped: 0, error: 0, 'dry-run': 0 });
                expect(client.modifyRadiosConfig).toHaveBeenCalledTimes(10);
                expect(loggerModule.logger.warn).toHaveBeenCalledWith('NetKnife plan warnings', expect.any(Object));
            });

            it('exactly 3 APs warn, 2 do not; disabled radios and auto channels are not counted', async () => {
                const aps = manyAps(6);
                const three = await applyNetknifePlan(
                    createFakeOmada(structuredClone(aps)),
                    planFor(aps, (i) => ({ '2g': { channel: i < 3 ? 6 : 11 } })),
                    options
                );
                expect(three.warnings).toMatchObject([
                    { band: '2.4', channel: 6, aps: ['AP-1', 'AP-2', 'AP-3'] },
                    { band: '2.4', channel: 11 },
                ]);

                const plan = planFor(aps, (i) => ({
                    '5g': [
                        { channel: 36 },
                        { channel: 36 },
                        { channel: 36, enabled: false },
                        { channel: 'auto' },
                        { channel: 'auto' },
                        { channel: 'auto' },
                    ][i],
                }));
                const quiet = await applyNetknifePlan(createFakeOmada(aps), plan, options);
                expect(quiet.warnings).toEqual([]);
            });

            it('a normal plan has no warnings', async () => {
                const aps = manyAps(6);
                const plan = planFor(aps, (i) => ({ '2g': { channel: [1, 6, 11][i % 3] }, '5g': { channel: [36, 44, 52, 100, 108, 116][i] } }));
                const result = await applyNetknifePlan(createFakeOmada(aps), plan, options);
                expect(result.warnings).toEqual([]);
                expect(result.summary).toEqual({ applied: 0, skipped: 0, error: 0, 'dry-run': 6 });
            });

            it('accepts plans with and without Helpdesk warnings; they are shown and never block', async () => {
                const aps = manyAps(2);
                const helpdesk = [
                    { code: 'same_channel_neighbors', band: '5', aps: ['AP-1', 'AP-2'], text: 'AP-1 и AP-2 рядом на одном канале' },
                    { code: 'band_one_channel', band: '2.4', aps: [], text: 'весь диапазон на одном канале' },
                ];
                const radios = (i: number) => ({ '5g': { channel: [40, 44][i] } });

                const without = await applyNetknifePlan(createFakeOmada(structuredClone(aps)), planFor(aps, radios), options);
                expect(without.warnings).toEqual([]);
                expect(without.summary['dry-run']).toBe(2);

                const dry = await applyNetknifePlan(
                    createFakeOmada(structuredClone(aps)),
                    JSON.stringify(planFor(aps, radios, { warnings: helpdesk })),
                    options
                );
                expect(dry.warnings).toEqual([
                    {
                        source: 'helpdesk',
                        code: 'same_channel_neighbors',
                        band: '5',
                        aps: ['AP-1', 'AP-2'],
                        text: 'Helpdesk предупреждает: AP-1 и AP-2 рядом на одном канале',
                    },
                    {
                        source: 'helpdesk',
                        code: 'band_one_channel',
                        band: '2.4',
                        aps: [],
                        text: 'Helpdesk предупреждает: весь диапазон на одном канале',
                    },
                ]);
                expect(dry.summary['dry-run']).toBe(2);

                const client = createFakeOmada(aps);
                const write = await applyNetknifePlan(client, planFor(aps, radios, { warnings: helpdesk }), { ...options, dryRun: false });
                expect(write.summary.applied).toBe(2);
                expect(write.warnings).toHaveLength(2);
                expect(client.modifyRadiosConfig).toHaveBeenCalledTimes(2);
            });

            it('new Helpdesk warning codes are passed through and never block', async () => {
                const aps = manyAps(2);
                const helpdesk = [
                    { code: 'ap_no_rooms', band: null, aps: ['AP-2'], text: 'у AP-2 нет комнат' },
                    { code: 'room_coverage_low', band: '5', aps: ['AP-1'], text: 'слабое покрытие в спальне' },
                    { code: 'tx_floor', band: '2.4', aps: ['AP-1', 'AP-2'], text: 'мощность упёрлась в минимум' },
                    { code: 'some_future_code', band: '6', aps: [], text: 'код из будущей версии', extra: 1 },
                ];
                const client = createFakeOmada(aps);
                const result = await applyNetknifePlan(
                    client,
                    planFor(aps, (i) => ({ '5g': { channel: [40, 44][i] } }), { warnings: helpdesk }),
                    {
                        ...options,
                        dryRun: false,
                    }
                );
                expect(result.warnings.map((w) => [w.source, w.code])).toEqual([
                    ['helpdesk', 'ap_no_rooms'],
                    ['helpdesk', 'room_coverage_low'],
                    ['helpdesk', 'tx_floor'],
                    ['helpdesk', 'some_future_code'],
                ]);
                expect(result.summary).toEqual({ applied: 2, skipped: 0, error: 0, 'dry-run': 0 });
            });

            it('tolerates malformed Helpdesk warnings', () => {
                expect(helpdeskWarnings(undefined)).toEqual([]);
                expect(helpdeskWarnings({ code: 'x' })).toEqual([]);
                expect(helpdeskWarnings(['просто строка', null, { code: 'single_channel_ap', aps: ['AP-1', 7] }])).toEqual([
                    { source: 'helpdesk', code: 'unknown', band: null, aps: [], text: 'Helpdesk предупреждает: просто строка' },
                    { source: 'helpdesk', code: 'unknown', band: null, aps: [], text: 'Helpdesk предупреждает: unknown' },
                    { source: 'helpdesk', code: 'single_channel_ap', band: null, aps: ['AP-1'], text: 'Helpdesk предупреждает: single_channel_ap' },
                ]);
                expect(() => parseNetknifePlan({ format: 'netknife-omada/1', kind: 'plan', aps: [], warnings: 'oops' })).not.toThrow();
            });
        });

        describe('plan lists unmanaged / unchanged (reported, never written)', () => {
            const lists = {
                unmanaged: [
                    { name: 'AP 00:5A', mac: null, reason: 'no_mac', text: 'нет MAC в Helpdesk' },
                    { name: 'AP EC:20', mac: 'ec:20:aa:bb:cc:dd', reason: 'not_in_omada', text: 'нет в Omada' },
                ],
                unchanged: [{ name: 'AP-2', mac: '3C-64-CF-69-9A-11', reason: 'not_surveyed', text: 'не обследована' }],
                someFutureField: { x: 1 },
            };

            it('parses with and without the lists; unknown top-level fields are ignored', () => {
                const plain = parseNetknifePlan(planFor(manyAps(1), () => ({ '5g': { channel: 40 } })));
                expect(planListReport(plain)).toEqual([]);
                const withLists = parseNetknifePlan(JSON.stringify(planFor(manyAps(1), () => ({ '5g': { channel: 40 } }), lists)));
                expect(withLists).not.toHaveProperty('someFutureField');
                expect(planListReport(withLists)).toEqual(['unmanaged: 2 (не записываются): AP 00:5A, AP EC:20', 'unchanged: 1: AP-2']);
            });

            it('dry-run and write report the lists; only "aps" is written', async () => {
                const aps = manyAps(2);
                const plan = planFor([aps[0]], () => ({ '5g': { channel: 40 } }), lists);

                const dry = await applyNetknifePlan(createFakeOmada(structuredClone(aps)), plan, options);
                expect(dry.summary).toEqual({ applied: 0, skipped: 0, error: 0, 'dry-run': 1 });
                expect(dry.unmanaged).toEqual([
                    { name: 'AP 00:5A', mac: null, reason: 'no_mac', text: 'нет MAC в Helpdesk' },
                    { name: 'AP EC:20', mac: 'EC-20-AA-BB-CC-DD', reason: 'not_in_omada', text: 'нет в Omada' },
                ]);
                expect(dry.unchanged).toEqual([{ name: 'AP-2', mac: '3C-64-CF-69-9A-11', reason: 'not_surveyed', text: 'не обследована' }]);
                expect(dry.report).toEqual(['unmanaged: 2 (не записываются): AP 00:5A, AP EC:20', 'unchanged: 1: AP-2']);

                const client = createFakeOmada(structuredClone(aps));
                const write = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(write.summary).toEqual({ applied: 1, skipped: 0, error: 0, 'dry-run': 0 });
                expect(write.report).toEqual(dry.report);
                expect(client.modifyRadiosConfig).toHaveBeenCalledTimes(1);
                expect(client.modifyRadiosConfig.mock.calls[0][0]).toBe(aps[0].mac);
            });

            it('tolerates malformed lists', () => {
                expect(planListedAps(undefined)).toEqual([]);
                expect(planListedAps({ name: 'x' })).toEqual([]);
                expect(planListedAps(['Чердак', null, { mac: 'not-a-mac', reason: 7 }])).toEqual([
                    { name: 'Чердак', mac: null, reason: null, text: null },
                    { name: null, mac: null, reason: null, text: null },
                    { name: null, mac: 'not-a-mac', reason: null, text: null },
                ]);
                const plan = parseNetknifePlan({ format: 'netknife-omada/1', kind: 'plan', aps: [], unmanaged: 'oops', unchanged: [{}] });
                expect(planListReport(plan)).toEqual(['unchanged: 1: ?']);
            });
        });

        describe('empty channelRange (the 5 GHz radio of "Гостиная")', () => {
            const ALL_5G_FREQS = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140].map((c) => 5000 + c * 5);
            const gostinaya = (channelRange: number[]): FakeAp => {
                const ap = { ...exampleAp(), mac: '3C-64-CF-69-9A-70', name: 'Гостиная' };
                ap.config.radioSetting5g = { ...ap.config.radioSetting5g, channelRange };
                return ap;
            };
            const plan = {
                format: 'netknife-omada/1',
                kind: 'plan',
                aps: [{ name: 'Гостиная', mac: '3C-64-CF-69-9A-70', radios: { '5g': { channel: 132 } } }],
            };

            it('dry-run: channel 132 + freq go into the request, channelRange is filled with the AP channels', async () => {
                const result = await applyNetknifePlan(createFakeOmada([gostinaya([])]), plan, options);
                expect(result.results[0]).toMatchObject({
                    status: 'dry-run',
                    diff: { '5g': { channel: { from: 36, to: 132 } } },
                    notes: ['5g: empty channelRange filled with the 19 channels allowed on this AP'],
                });
                expect(result.results[0].request?.radioSetting5g).toMatchObject({ channel: '132', freq: 5660, channelRange: ALL_5G_FREQS });
            });

            it('write: channel 132 is sent and confirmed by the read-back on a controller that enforces channelRange', async () => {
                const client = createFakeOmada([gostinaya([])], { enforceChannelRange: true });
                const result = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(result.results[0]).toMatchObject({ status: 'applied', diff: { '5g': { channel: { from: 36, to: 132 } } } });
                const [, body] = client.modifyRadiosConfig.mock.calls[0];
                expect(body.radioSetting5g).toMatchObject({ channel: '132', freq: 5660, channelRange: ALL_5G_FREQS });
                const readBack = await client.getRadiosConfig('3C-64-CF-69-9A-70');
                expect(readBack.radioSetting5g).toMatchObject({ channel: '132', freq: 5660 });
            });

            it('read-back is not falsely green: a corrected channel is a verification error', async () => {
                // Non-empty range without 132: sent as read, the controller keeps channel 36.
                const client = createFakeOmada([gostinaya([5180, 5200])], { enforceChannelRange: true });
                const result = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(client.modifyRadiosConfig.mock.calls[0][1].radioSetting5g).toMatchObject({ channel: '132', channelRange: [5180, 5200] });
                expect(result.results[0]).toMatchObject({
                    status: 'error',
                    error: 'verification after PATCH failed',
                    mismatches: ['5g.channel: expected 132, got 36'],
                });
                expect(result.results[0].notes).toBeUndefined();
            });

            it('a full or missing channelRange is sent as is; no channel change → range untouched', async () => {
                const full = await applyApRadioChanges(
                    createFakeOmada([gostinaya(ALL_5G_FREQS)]),
                    '3C-64-CF-69-9A-70',
                    { '5g': { channel: 132 } },
                    { dryRun: true }
                );
                expect(full.notes).toBeUndefined();
                expect(full.request?.radioSetting5g).toMatchObject({ channelRange: ALL_5G_FREQS });

                const missing = await applyApRadioChanges(
                    createFakeOmada([exampleAp()]),
                    exampleAp().mac,
                    { '5g': { channel: 132 } },
                    { dryRun: true }
                );
                expect(missing.request?.radioSetting5g).not.toHaveProperty('channelRange');

                const powerOnly = await applyApRadioChanges(
                    createFakeOmada([gostinaya([])]),
                    '3C-64-CF-69-9A-70',
                    { '5g': { txPower: 17 } },
                    { dryRun: true }
                );
                expect(powerOnly.request?.radioSetting5g).toMatchObject({ channelRange: [] });
                expect(powerOnly.notes).toBeUndefined();
            });

            it('channel "auto" with an empty range also gets the full list', async () => {
                const result = await applyApRadioChanges(
                    createFakeOmada([gostinaya([])]),
                    '3C-64-CF-69-9A-70',
                    { '5g': { channel: 'auto' } },
                    { dryRun: true }
                );
                expect(result.request?.radioSetting5g).toMatchObject({ channel: '0', channelRange: ALL_5G_FREQS });
            });
        });

        it('stringifies non-Error failures', async () => {
            const client = createFakeOmada([exampleAp()]);
            const plan = { format: 'netknife-omada/1', kind: 'plan', aps: [{ mac: '3C-64-CF-69-9A-64', radios: { '2g': { channel: 1 } } }] };
            client.getRadiosConfig.mockResolvedValueOnce(structuredClone(exampleAp().config)).mockRejectedValueOnce('down');
            const result = await applyNetknifePlan(client, plan, options);
            expect(result.results[0]).toMatchObject({ status: 'error', error: 'down' });
        });
    });

    // Live controller "Alie Parusa" (Omada 6.3.0.45): radio-config returns `channel` as the channel index
    // ("17" for 132), a power-only write echoed that index back into the PATCH.
    describe('unchanged channel is not written back as an index', () => {
        const NO_100 = [36, 40, 44, 48, 52, 56, 60, 64, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140];

        /** exampleAp() as the real controller returns it: channel = index, plus freq. */
        function indexedAp(band: '2g' | '5g', channel: number, channels5g?: number[]): FakeAp {
            const ap = exampleAp();
            if (channels5g) {
                (ap.available as { radioId: number; apChannelDetailList: unknown[] }[])[1].apChannelDetailList = channels5g.map((c, i) => ({
                    channel: c,
                    freq: 5000 + c * 5,
                    index: i + 1,
                    availableChannelWidthList: [20, 40, 80],
                }));
            }
            const freq = band === '2g' ? 2407 + channel * 5 : 5000 + channel * 5;
            const detail = channelDetailsFor(ap.available, band === '2g' ? 0 : 1).find((d) => d.freq === freq);
            const key = band === '2g' ? 'radioSetting2g' : 'radioSetting5g';
            ap.config[key] = { ...ap.config[key], channel: String(detail?.index), freq };
            return ap;
        }

        it.each([
            { band: '5g' as const, channel: 132, index: '17', list: undefined },
            { band: '5g' as const, channel: 104, index: '9', list: NO_100 },
            { band: '2g' as const, channel: 6, index: '6', list: undefined },
            { band: '2g' as const, channel: 11, index: '11', list: undefined },
        ])('$band channel $channel (index $index): txPower only → no channel in PATCH, channel kept', async ({ band, channel, index, list }) => {
            const ap = indexedAp(band, channel, list);
            const key = band === '2g' ? 'radioSetting2g' : 'radioSetting5g';
            const freq = ap.config[key].freq;
            expect(ap.config[key].channel).toBe(index);
            const client = createFakeOmada([ap], { channelIndex: true });

            const dry = await applyApRadioChanges(client, ap.mac, { [band]: { txPower: 17 } }, { dryRun: true });
            expect(dry.before[band]?.channel).toBe(channel);
            expect(dry.diff).toEqual({ [band]: { txPower: { from: band === '2g' ? 14 : 20, to: 17 } } });
            expect(dry.request?.[key]).not.toHaveProperty('channel');
            expect(dry.request?.[key]).toMatchObject({ freq, txPower: 17 });

            const result = await applyApRadioChanges(client, ap.mac, { [band]: { txPower: 17 } }, { dryRun: false });
            const [, body] = client.modifyRadiosConfig.mock.calls[0];
            expect(body[key]).not.toHaveProperty('channel');
            expect(body[key]).toMatchObject({ freq, txPower: 17 });
            expect(result).toMatchObject({ verified: true, after: { [band]: { channel, txPower: 17 } } });
            expect(result.mismatches).toBeUndefined();
            expect(ap.config[key]).toMatchObject({ channel: index, freq });
        });

        it('a channel the controller moved although not requested → verified:false with a message', async () => {
            const ap = indexedAp('5g', 132);
            const client = createFakeOmada([ap], { channelIndex: true });
            client.modifyRadiosConfig.mockImplementationOnce(() => {
                ap.config.radioSetting5g = { ...ap.config.radioSetting5g, channel: '1', freq: 5180, txPower: 17 };
                return Promise.resolve(undefined);
            });
            const result = await applyApRadioChanges(client, ap.mac, { '5g': { txPower: 17 } }, { dryRun: false });
            expect(result.verified).toBe(false);
            expect(result.mismatches).toEqual(['5g.channel: not requested, expected unchanged 132, got 36']);
        });

        it('applyNetknifePlan: channel null → the index is not sent, the channel stays; a moved channel is an error', async () => {
            const ap = indexedAp('5g', 132);
            const plan = {
                format: 'netknife-omada/1',
                kind: 'plan',
                aps: [{ mac: ap.mac, radios: { '5g': { channel: null, width: null, txPower: 17 }, '2g': { channel: null } } }],
            };
            const client = createFakeOmada([ap], { channelIndex: true });
            const result = await applyNetknifePlan(client, plan, { dryRun: false, force: false, stopOnError: true });
            expect(result.results[0]).toMatchObject({ status: 'applied', diff: { '5g': { txPower: { from: 20, to: 17 } } } });
            const [, body] = client.modifyRadiosConfig.mock.calls[0];
            expect(Object.keys(body)).toEqual(['radioSetting5g']);
            expect(body.radioSetting5g).not.toHaveProperty('channel');
            expect(ap.config.radioSetting5g).toMatchObject({ channel: '17', freq: 5660, txPower: 17 });

            const moved = indexedAp('5g', 132);
            const movedClient = createFakeOmada([moved], { channelIndex: true });
            movedClient.modifyRadiosConfig.mockImplementationOnce(() => {
                moved.config.radioSetting5g = { ...moved.config.radioSetting5g, channel: '0', txPower: 17 };
                return Promise.resolve(undefined);
            });
            const failed = await applyNetknifePlan(movedClient, plan, { dryRun: false, force: false, stopOnError: true });
            expect(failed.results[0]).toMatchObject({
                status: 'error',
                error: 'verification after PATCH failed',
                mismatches: ['5g.channel: not requested, expected unchanged 132, got auto'],
            });
        });

        it('settingForWrite: requested channel and auto are sent as is, an unchanged fixed channel is dropped', () => {
            const fixed = { channel: '17', freq: 5660, txPower: 20 };
            expect(settingForWrite(fixed, { txPower: 17 })).toEqual({ freq: 5660, txPower: 20 });
            expect(fixed).toHaveProperty('channel', '17');
            expect(settingForWrite(fixed, { channel: 132 })).toBe(fixed);
            const auto = { channel: '0', txPower: 20 };
            expect(settingForWrite(auto, { txPower: 17 })).toBe(auto);
        });
    });

    describe('loadBalance (netknife-omada/1 RSSI threshold block)', () => {
        const MAC = '3C-64-CF-69-9A-64';
        const options = { dryRun: true, force: false, stopOnError: true };
        const lbPlan = (ap: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
            format: 'netknife-omada/1',
            kind: 'plan',
            ...extra,
            aps: [{ name: 'Кухня', mac: MAC, radios: {}, ...ap }],
        });
        const parseLb = (loadBalance: unknown) => () => parseNetknifePlan(lbPlan({ loadBalance }));

        describe('schema', () => {
            it('accepts valid blocks, null bands and plans/states without the block', () => {
                const plan = parseNetknifePlan(
                    lbPlan({
                        loadBalance: { '2g': null, '5g': { rssiEnable: true, threshold: -70 }, '6g': { rssiEnable: false } },
                        current: { '5g': { channel: 36 }, loadBalance: { '2g': { rssiEnable: false, threshold: -85 }, '5g': null } },
                    })
                );
                expect(plan.aps[0].loadBalance).toEqual({ '2g': null, '5g': { rssiEnable: true, threshold: -70 }, '6g': { rssiEnable: false } });
                expect(plan.aps[0].current?.loadBalance).toEqual({ '2g': { rssiEnable: false, threshold: -85 }, '5g': null });
                expect(parseNetknifePlan(lbPlan({ loadBalance: null })).aps[0].loadBalance).toBeNull();
                expect(parseNetknifePlan(planFromState(fixture)).aps[0].loadBalance).toBeUndefined();
                expect(parseNetknifePlan(lbPlan({ loadBalance: { '5g': { rssiEnable: true, threshold: -95 } } })).aps).toHaveLength(1);
                expect(parseNetknifePlan(lbPlan({ loadBalance: { '5g': { rssiEnable: false, threshold: -40 } } })).aps).toHaveLength(1);
                for (const band of Object.values(fixture.aps[0].loadBalance ?? {})) expect(loadBalanceStateSchema.parse(band)).toEqual(band);
            });

            it('rejects contract violations with readable messages', () => {
                expect(parseLb({ '5g': { rssiEnable: true, threshold: '-70' } })).toThrow(
                    'aps.0.loadBalance.5g.threshold: threshold must be an integer dBm in -95…-40 (a number, not a string)'
                );
                expect(parseLb({ '5g': { rssiEnable: true, threshold: -96 } })).toThrow(
                    'aps.0.loadBalance.5g.threshold: threshold must be an integer dBm'
                );
                expect(parseLb({ '5g': { rssiEnable: true, threshold: -39 } })).toThrow('aps.0.loadBalance.5g.threshold');
                expect(parseLb({ '5g': { rssiEnable: true, threshold: -70.5 } })).toThrow('aps.0.loadBalance.5g.threshold');
                expect(parseLb({ '5g': { rssiEnable: true } })).toThrow(
                    'aps.0.loadBalance.5g.threshold: threshold is required when rssiEnable is true'
                );
                expect(parseLb({ '5g': { threshold: -70 } })).toThrow('aps.0.loadBalance.5g.rssiEnable: rssiEnable is required');
                expect(parseLb({ '5g': { rssiEnable: 'yes', threshold: -70 } })).toThrow('rssiEnable must be true or false');
                expect(parseLb({ '5g': { rssiEnable: true, threshold: -70, maxClients: 30 } })).toThrow(
                    "Unrecognized key(s) in object: 'maxClients'"
                );
                expect(parseLb({ '7g': { rssiEnable: false } })).toThrow('aps.0.loadBalance.7g');
                expect(parseLb({ '5g': { rssiEnable: false }, '5g1': { rssiEnable: false } })).toThrow('"5g" and "5g1" both map');
                expect(() => parseNetknifePlan(lbPlan({ current: { loadBalance: { '5g': { rssiEnable: true, threshold: '-75' } } } }))).toThrow(
                    'aps.0.current.loadBalance.5g.threshold'
                );
                expect(() => parseNetknifePlan(lbPlan({ current: { '7g': {} } }))).toThrow('aps.0.current');
            });

            it('keeps the contract range in sync with setApLoadBalance', () => {
                expect([LB_THRESHOLD_MIN, LB_THRESHOLD_MAX]).toEqual([RSSI_THRESHOLD_MIN, RSSI_THRESHOLD_MAX]);
            });

            it('normalizePlanCurrent leaves current.loadBalance as is', () => {
                const plan = lbPlan({ current: { '5g': { channel: '36' }, loadBalance: { '5g': { rssiEnable: true, threshold: -75 } } } });
                const { value } = normalizePlanCurrent(plan);
                expect((value as { aps: { current: unknown }[] }).aps[0].current).toEqual({
                    '5g': { channel: 36 },
                    loadBalance: { '5g': { rssiEnable: true, threshold: -75 } },
                });
            });
        });

        describe('state', () => {
            it('loadBalanceFromConfig keeps every band with RSSI fields', () => {
                expect(
                    loadBalanceFromConfig({ rssiEnable2g: true, threshold2g: '-80', rssiEnable5g: false, maxClients6g: 10, threshold5g2: -70.5 })
                ).toEqual({ '2g': { rssiEnable: true, threshold: -80 }, '5g': { rssiEnable: false }, '5g2': { rssiEnable: false } });
                expect(() => loadBalanceFromConfig(null)).toThrow('load-balance GET returned no config object');
                expect(() => loadBalanceFromConfig([])).toThrow('no config object');
                expect(loadBalanceBand('5g1')).toBe('5g');
                expect(loadBalanceBand('6g')).toBe('6g');
            });

            it('reads load-balance of every AP with the setApLoadBalance GET', async () => {
                const client = createFakeOmada([exampleAp()]);
                const state = await collectNetknifeState(client, { siteId: 'site-1' });
                expect(state.aps[0].loadBalance).toEqual({ '2g': { rssiEnable: false, threshold: -85 }, '5g': { rssiEnable: true, threshold: -75 } });
                expect(state.warnings).toBeUndefined();
                expect(client.getSitesApsLoadBalance).toHaveBeenCalledWith(MAC, 'site-1', undefined);
            });

            it('a failed load-balance read of one AP omits its block and warns, the rest of the state stays', async () => {
                const [a, b] = manyAps(2);
                const client = createFakeOmada([a, { ...b, loadBalance: undefined }]);
                const state = await collectNetknifeState(client);
                expect(state.aps[0].loadBalance).toBeDefined();
                expect(state.aps[1]).not.toHaveProperty('loadBalance');
                expect(state.aps[1].radios['5g']?.channel).toBe(36);
                expect(state.aps[1].error).toBeUndefined();
                expect(state.aps[1].loadBalanceError).toContain('load-balance is not supported');
                expect(state.warnings).toEqual([
                    `AP-2 (${b.mac}): load-balance not read, loadBalance omitted — Omada API error -1: load-balance is not supported`,
                ]);
                expect(loggerModule.logger.warn).toHaveBeenCalledWith('NetKnife state: load-balance not read', expect.any(Object));

                client.getSitesApsLoadBalance.mockRejectedValueOnce('boom');
                expect((await collectNetknifeState(client)).aps[0].loadBalanceError).toBe('boom');
            });

            it('does not read load-balance of an AP whose radios could not be read', async () => {
                const client = createFakeOmada([exampleAp()]);
                client.getRadiosConfig.mockRejectedValueOnce(new Error('AP offline'));
                const state = await collectNetknifeState(client);
                expect(state.aps[0].error).toBe('AP offline');
                expect(client.getSitesApsLoadBalance).not.toHaveBeenCalled();
                expect(state.warnings).toBeUndefined();
            });
        });

        describe('currentMismatches', () => {
            const ap = () => structuredClone(fixture.aps[0]);

            it('compares rssiEnable and threshold, skips null/absent fields', () => {
                expect(currentMismatches(ap(), { loadBalance: { '5g': { rssiEnable: true, threshold: -75 }, '2g': null } })).toEqual([]);
                expect(currentMismatches(ap(), { loadBalance: { '5g': { rssiEnable: false, threshold: -70 } } })).toEqual([
                    'loadBalance.5g.rssiEnable: plan expects false, controller has true',
                    'loadBalance.5g.threshold: plan expects -70, controller has -75',
                ]);
                expect(currentMismatches(ap(), { loadBalance: { '5g1': { rssiEnable: true } } })).toEqual([]);
                expect(currentMismatches(ap(), { loadBalance: { '6g': { rssiEnable: false } } })).toEqual([
                    'loadBalance.6g: the controller returns no RSSI threshold for this band',
                ]);
                const noThreshold = { ...ap(), loadBalance: { '5g': { rssiEnable: true } } };
                expect(currentMismatches(noThreshold, { loadBalance: { '5g': { rssiEnable: true, threshold: -75 } } })).toEqual([]);
            });

            it('reports a load-balance that could not be read', () => {
                const unread = { ...ap(), loadBalance: undefined, loadBalanceError: 'timeout' };
                const current = { loadBalance: { '2g': { rssiEnable: false }, '5g': { rssiEnable: true } } };
                expect(currentMismatches(unread, current)).toEqual(['loadBalance: not read from the controller (timeout)']);
                expect(currentMismatches({ ...unread, loadBalanceError: undefined }, current)).toEqual(['loadBalance: not read from the controller']);
            });
        });

        describe('applyNetknifePlan', () => {
            it('dry-run shows before→after of the flag and the threshold on separate lines, nothing written', async () => {
                const client = createFakeOmada([exampleAp()]);
                const plan = lbPlan({ loadBalance: { '5g': { rssiEnable: true, threshold: -70 }, '2g': { rssiEnable: true, threshold: -80 } } });
                const result = await applyNetknifePlan(client, plan, options);
                expect(result.results[0]).toMatchObject({ status: 'dry-run', diff: {} });
                const lb = result.results[0].loadBalance;
                expect(lb?.lines).toEqual([
                    'loadBalance 2g rssiEnable: false → true',
                    'loadBalance 2g threshold: -85 dBm → -80 dBm',
                    'loadBalance 5g rssiEnable: true → true (без изменений)',
                    'loadBalance 5g threshold: -75 dBm → -70 dBm',
                ]);
                expect(lb?.diff).toEqual({
                    '2g': { rssiEnable: { from: false, to: true }, threshold: { from: -85, to: -80 } },
                    '5g': { threshold: { from: -75, to: -70 } },
                });
                expect(lb?.verified).toBe(false);
                expect(lb?.requests?.['5g']).toEqual({ ...exampleLoadBalance(), threshold5g: -70, rssiEnable5g: true });
                expect(lb?.warnings).toEqual([
                    '2g: IoT clients (sensors, plugs, cameras) often sit on 2.4 GHz with a weak signal and tolerate RSSI cut-off badly',
                ]);
                expect(client.modifyApLoadBalanceConfig).not.toHaveBeenCalled();
                expect(client.modifyRadiosConfig).not.toHaveBeenCalled();
            });

            it('writes radios first, then load-balance of the same AP, and verifies both', async () => {
                const client = createFakeOmada([exampleAp()]);
                const plan = lbPlan({ radios: { '5g': { channel: 44 } }, loadBalance: { '5g': { rssiEnable: true, threshold: -68 } } });
                const result = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(result.results[0]).toMatchObject({
                    status: 'applied',
                    diff: { '5g': { channel: { from: 36, to: 44 } } },
                    loadBalance: { verified: true, diff: { '5g': { threshold: { from: -75, to: -68 } } } },
                });
                const radioOrder = client.modifyRadiosConfig.mock.invocationCallOrder[0];
                const lbOrder = client.modifyApLoadBalanceConfig.mock.invocationCallOrder[0];
                expect(radioOrder).toBeLessThan(lbOrder);
                // full GET body merged and sent back
                expect(client.modifyApLoadBalanceConfig).toHaveBeenCalledWith(
                    MAC,
                    { ...exampleLoadBalance(), threshold5g: -68 },
                    undefined,
                    undefined
                );
                expect(result.backup.aps[0].loadBalance).toEqual(fixture.aps[0].loadBalance);
            });

            it('rssiEnable false without threshold keeps the current value; a given threshold is not written (note)', async () => {
                const client = createFakeOmada([exampleAp()]);
                const result = await applyNetknifePlan(client, lbPlan({ loadBalance: { '5g': { rssiEnable: false } } }), {
                    ...options,
                    dryRun: false,
                });
                expect(result.results[0]).toMatchObject({
                    status: 'applied',
                    loadBalance: { diff: { '5g': { rssiEnable: { from: true, to: false } } } },
                });
                expect(result.results[0].loadBalance?.lines).toEqual([
                    'loadBalance 5g rssiEnable: true → false',
                    'loadBalance 5g threshold: -75 dBm → -75 dBm (без изменений)',
                ]);
                expect(client.modifyApLoadBalanceConfig).toHaveBeenCalledWith(
                    MAC,
                    { ...exampleLoadBalance(), rssiEnable5g: false },
                    undefined,
                    undefined
                );

                const dry = await applyNetknifePlan(
                    createFakeOmada([exampleAp()]),
                    lbPlan({ loadBalance: { '5g': { rssiEnable: false, threshold: -60 } } }),
                    options
                );
                expect(dry.results[0].loadBalance?.notes).toEqual([
                    'loadBalance 5g: threshold -60 not written with rssiEnable false — the controller keeps -75 dBm',
                ]);
                expect(dry.results[0].loadBalance?.requests?.['5g']).toMatchObject({ rssiEnable5g: false, threshold5g: -75 });
            });

            it('null / absent bands and a band already as planned send no write', async () => {
                const client = createFakeOmada([exampleAp()]);
                const plan = lbPlan({ loadBalance: { '2g': null, '5g': { rssiEnable: true, threshold: -75 } } });
                const result = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(result.results[0]).toMatchObject({
                    status: 'skipped',
                    reason: 'no changes needed',
                    loadBalance: { diff: {}, verified: true },
                });
                expect(client.modifyApLoadBalanceConfig).not.toHaveBeenCalled();

                const untouched = createFakeOmada([exampleAp()]);
                for (const loadBalance of [null, { '2g': null }]) {
                    const r = await applyNetknifePlan(untouched, lbPlan({ radios: { '5g': { channel: 44 } }, loadBalance }), {
                        ...options,
                        dryRun: false,
                    });
                    expect(r.results[0]).not.toHaveProperty('loadBalance');
                }
                expect(untouched.getSitesApsLoadBalance).toHaveBeenCalledTimes(2); // backups only
                expect(untouched.modifyApLoadBalanceConfig).not.toHaveBeenCalled();
            });

            it('maps plan 5g1 to the controller 5g keys', async () => {
                const client = createFakeOmada([exampleAp()]);
                await applyNetknifePlan(client, lbPlan({ loadBalance: { '5g1': { rssiEnable: true, threshold: -72 } } }), {
                    ...options,
                    dryRun: false,
                });
                expect(client.modifyApLoadBalanceConfig).toHaveBeenCalledWith(
                    MAC,
                    expect.objectContaining({ threshold5g: -72 }),
                    undefined,
                    undefined
                );
            });

            it('a threshold the controller ignores → error with ignored keys, stops the plan', async () => {
                const [a, b] = manyAps(2);
                const client = createFakeOmada([a, b], { ignoreLoadBalanceKeys: ['threshold5g'] });
                const plan = {
                    format: 'netknife-omada/1',
                    kind: 'plan',
                    aps: [a, b].map((ap) => ({ mac: ap.mac, radios: {}, loadBalance: { '5g': { rssiEnable: true, threshold: -70 } } })),
                };
                const result = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(result.results[0]).toMatchObject({
                    status: 'error',
                    error: 'load-balance verification after PATCH failed (controller ignored the change)',
                    mismatches: ['loadBalance threshold5g: expected -70, got -75'],
                    loadBalance: { verified: false, ignored: ['threshold5g'] },
                });
                expect(result.results[1]).toMatchObject({ status: 'skipped', reason: 'not attempted: stopped after previous error (stopOnError)' });

                const side = createFakeOmada([exampleAp()]);
                side.modifyApLoadBalanceConfig.mockImplementationOnce(async () => {
                    const lbNow = (await side.getSitesApsLoadBalance(MAC)) as Record<string, unknown>;
                    side.getSitesApsLoadBalance.mockResolvedValueOnce({ ...lbNow, threshold5g: -70, maxClients2g: 50 });
                    return undefined;
                });
                const sideResult = await applyNetknifePlan(side, lbPlan({ loadBalance: { '5g': { rssiEnable: true, threshold: -70 } } }), {
                    ...options,
                    dryRun: false,
                });
                expect(sideResult.results[0]).toMatchObject({
                    status: 'applied',
                    loadBalance: { sideEffects: { maxClients2g: { from: 100, to: 50 } } },
                });
            });

            it('radio verification failure stops before load-balance', async () => {
                const client = createFakeOmada([exampleAp()], { ignoreWrites: true });
                const plan = lbPlan({ radios: { '5g': { channel: 44 } }, loadBalance: { '5g': { rssiEnable: true, threshold: -70 } } });
                const result = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(result.results[0]).toMatchObject({ status: 'error', error: 'verification after PATCH failed' });
                expect(client.modifyApLoadBalanceConfig).not.toHaveBeenCalled();
            });

            it('a load-balance error after written radios says the radios are already written', async () => {
                const ap = { ...exampleAp(), loadBalance: { maxClientsEnable2g: false, maxClients2g: 100 } };
                const client = createFakeOmada([ap]);
                const plan = lbPlan({ radios: { '5g': { channel: 44 } }, loadBalance: { '5g': { rssiEnable: true, threshold: -70 } } });
                const result = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(result.results[0].status).toBe('error');
                expect(result.results[0].error).toMatch(
                    /^loadBalance: 5g: the controller returns no RSSI threshold fields .*\(radios of this AP were already written and verified\)$/
                );
                expect(result.results[0].diff).toEqual({ '5g': { channel: { from: 36, to: 44 } } });

                const dry = await applyNetknifePlan(createFakeOmada([ap]), plan, options);
                expect(dry.results[0].error).not.toContain('already written');
            });

            it('current.loadBalance differing from the controller follows the radio rule: skipped unless force', async () => {
                const plan = lbPlan({
                    loadBalance: { '5g': { rssiEnable: true, threshold: -70 } },
                    current: { loadBalance: { '5g': { rssiEnable: true, threshold: -80 } } },
                });
                const client = createFakeOmada([exampleAp()]);
                const skipped = await applyNetknifePlan(client, plan, { ...options, dryRun: false });
                expect(skipped.results[0]).toMatchObject({
                    status: 'skipped',
                    mismatches: ['loadBalance.5g.threshold: plan expects -80, controller has -75'],
                });
                expect(client.modifyApLoadBalanceConfig).not.toHaveBeenCalled();

                const forced = await applyNetknifePlan(client, plan, { ...options, dryRun: false, force: true });
                expect(forced.results[0]).toMatchObject({
                    status: 'applied',
                    mismatches: ['loadBalance.5g.threshold: plan expects -80, controller has -75'],
                });
                expect(client.modifyApLoadBalanceConfig).toHaveBeenCalledTimes(1);
            });

            it('backup carries the load-balance read before the write', async () => {
                const client = createFakeOmada([exampleAp()]);
                const result = await applyNetknifePlan(client, lbPlan({ loadBalance: { '2g': { rssiEnable: true, threshold: -82 } } }), {
                    ...options,
                    dryRun: false,
                });
                expect(result.backup.aps[0].loadBalance?.['2g']).toEqual({ rssiEnable: false, threshold: -85 });
                expect((await collectNetknifeState(client)).aps[0].loadBalance?.['2g']).toEqual({ rssiEnable: true, threshold: -82 });
            });

            it('an entry with no radio and no load-balance change keeps the "No radio changes" error', async () => {
                const result = await applyNetknifePlan(createFakeOmada([exampleAp()]), lbPlan({ loadBalance: { '5g': null } }), options);
                expect(result.results[0]).toMatchObject({ status: 'error', error: expect.stringContaining('No radio changes requested') });
            });
        });

        describe('checkNetknifePlan (offline validator)', () => {
            it('accepts a plan with loadBalance and reports counts, notes and warnings', () => {
                const plan = lbPlan(
                    {
                        loadBalance: { '5g': { rssiEnable: true, threshold: -70 }, '2g': { rssiEnable: false, threshold: -80 } },
                        current: { '5g': { channel: '36' } },
                    },
                    { unchanged: [{ name: 'Холл' }] }
                );
                const { ok, lines } = checkNetknifePlan(`﻿${JSON.stringify(plan)}`);
                expect(ok).toBe(true);
                expect(lines[0]).toBe('OK: 1 APs, 0 radios, 2 loadBalance bands, 1 with MAC, 0 validation errors');
                expect(lines).toContain('unchanged: 1: Холл');
                expect(lines).toContain('note Кухня: loadBalance 2g threshold -80 is not written with rssiEnable false');
                expect(lines.some((l) => l.startsWith('warning plan_current_strings'))).toBe(true);
            });

            it('rejects contract violations', () => {
                const bad = checkNetknifePlan(JSON.stringify(lbPlan({ loadBalance: { '5g': { rssiEnable: true } } })));
                expect(bad).toEqual({
                    ok: false,
                    lines: [expect.stringContaining('aps.0.loadBalance.5g.threshold: threshold is required when rssiEnable is true')],
                });
                expect(checkNetknifePlan('{oops').ok).toBe(false);
            });
        });
    });
});
