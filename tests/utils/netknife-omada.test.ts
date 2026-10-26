import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as loggerModule from '../../src/utils/logger.js';
import {
    applyApRadioChanges,
    applyNetknifePlan,
    channelDetailsFor,
    collectNetknifeState,
    compactChange,
    currentMismatches,
    formatMac,
    helpdeskWarnings,
    type NetknifeState,
    normalizeMac,
    parseNetknifePlan,
    planChannelErrors,
    radioStateFromSetting,
    radiosFromConfig,
    resolveBand,
    toIsoCountry,
} from '../../src/utils/netknife-omada.js';
import { createFakeOmada, exampleAp, exampleAvailableChannels, type FakeAp } from '../helpers/fakeOmada.js';

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

        it('matches by name when mac is absent, stops on error by default', async () => {
            const client = createFakeOmada([exampleAp()]);
            const plan = {
                format: 'netknife-omada/1',
                kind: 'plan',
                aps: [
                    { name: 'Гостиная', mac: 'AA-AA-AA-AA-AA-AA', radios: { '2g': { channel: 1 } } },
                    { name: 'Кухня', radios: { '2g': { channel: 11 } } },
                ],
            };
            const stopped = await applyNetknifePlan(client, plan, options);
            expect(stopped.results.map((r) => r.status)).toEqual(['error', 'skipped']);
            expect(stopped.results[1].reason).toContain('stopOnError');

            const continued = await applyNetknifePlan(client, plan, { ...options, stopOnError: false });
            expect(continued.results.map((r) => r.status)).toEqual(['error', 'dry-run']);
            expect(continued.results[1]).toMatchObject({ mac: '3C-64-CF-69-9A-64', name: 'Кухня' });
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

        it('stringifies non-Error failures', async () => {
            const client = createFakeOmada([exampleAp()]);
            const plan = { format: 'netknife-omada/1', kind: 'plan', aps: [{ mac: '3C-64-CF-69-9A-64', radios: { '2g': { channel: 1 } } }] };
            client.getRadiosConfig.mockResolvedValueOnce(structuredClone(exampleAp().config)).mockRejectedValueOnce('down');
            const result = await applyNetknifePlan(client, plan, options);
            expect(result.results[0]).toMatchObject({ status: 'error', error: 'down' });
        });
    });
});
