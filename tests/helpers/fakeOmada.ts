import { vi } from 'vitest';

import type { OmadaDeviceInfo } from '../../src/types/index.js';
import type { RadioClient } from '../../src/utils/netknife-omada.js';

type Setting = Record<string, unknown>;

export interface FakeAp {
    mac: string;
    name: string;
    ip?: string;
    model?: string;
    config: Record<string, Setting>;
    available: unknown;
}

export interface FakeOmadaOptions {
    /** If true, PATCH is accepted but the stored config does not change (verification must fail). */
    ignoreWrites?: boolean;
    /**
     * Emulate the controller correcting a fixed channel whose freq is outside the written channelRange:
     * the PATCH is accepted, but channel/freq keep their previous values.
     */
    enforceChannelRange?: boolean;
    /**
     * Emulate the real controller: radio-config `channel` is the channel index from the available-channel list,
     * and a written freq wins over the written channel (the channel is corrected based on freq).
     */
    channelIndex?: boolean;
    site?: Record<string, unknown>;
}

/** The ApChannelDetail entry for a freq in an available-channel response. */
function detailByFreq(available: unknown, freq: unknown): Setting | undefined {
    for (const radio of available as { apChannelDetailList: Setting[] }[]) {
        const detail = radio.apChannelDetailList.find((d) => d.freq === freq);
        if (detail) return detail;
    }
    return undefined;
}

const CHANNELS_5G = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140];

/** Available-channel response matching the OMADA-EXCHANGE.md example (EAP613, RU). */
export function exampleAvailableChannels(): unknown {
    return [
        {
            radioId: 0,
            apChannelDetailList: Array.from({ length: 13 }, (_, i) => ({
                channel: i + 1,
                freq: 2412 + i * 5,
                index: i + 1,
                availableChannelWidthList: [20, 40],
            })),
        },
        {
            radioId: 1,
            apChannelDetailList: CHANNELS_5G.map((channel, i) => ({
                channel,
                freq: 5000 + channel * 5,
                index: i + 1,
                // the last channel of a block does not allow 80 MHz on its own
                availableChannelWidthList: channel === 140 ? [20, 40] : [20, 40, 80],
            })),
        },
    ];
}

export function exampleAp(): FakeAp {
    return {
        mac: '3C-64-CF-69-9A-64',
        name: 'Кухня',
        ip: '192.168.115.208',
        model: 'EAP613',
        config: {
            radioSetting2g: {
                radioEnable: true,
                channel: '6',
                freq: 2437,
                channelWidth: '2',
                txPowerLevel: 3,
                txPower: 14,
                wirelessMode: -2,
                channelLimitEnable: false,
            },
            radioSetting5g: {
                radioEnable: true,
                channel: '36',
                freq: 5180,
                channelWidth: '3',
                txPowerLevel: 3,
                txPower: 20,
                wirelessMode: -2,
                channelLimitEnable: false,
            },
        },
        available: exampleAvailableChannels(),
    };
}

/** In-memory Omada controller: radio-config GET/PATCH, available channels, device list, AP and site detail. */
export function createFakeOmada(aps: FakeAp[], options: FakeOmadaOptions = {}) {
    const byMac = new Map(aps.map((ap) => [ap.mac, ap]));
    const find = (mac: string): Promise<FakeAp> => {
        const ap = byMac.get(mac);
        return ap ? Promise.resolve(ap) : Promise.reject(new Error('Omada API error -39303: AP does not exist.'));
    };
    const devices: OmadaDeviceInfo[] = [
        ...aps.map((ap) => ({ mac: ap.mac, name: ap.name, type: 'ap', ip: ap.ip, model: ap.model })),
        { mac: '11-22-33-44-55-66', name: 'Core switch', type: 'switch' },
    ];
    const client = {
        getSiteDetail: vi.fn(async () => options.site ?? { name: 'Alie Parusa', region: 'Russia' }),
        listDevices: vi.fn(async () => devices),
        getApDetail: vi.fn(async (mac: string) => {
            const ap = await find(mac);
            return { mac: ap.mac, name: ap.name, ip: ap.ip, model: ap.model, type: 'ap' };
        }),
        getRadiosConfig: vi.fn(async (mac: string) => structuredClone((await find(mac)).config)),
        getSitesApsAvailableChannel: vi.fn(async (mac: string) => structuredClone((await find(mac)).available)),
        modifyRadiosConfig: vi.fn(async (mac: string, body: Record<string, unknown>) => {
            const ap = await find(mac);
            if (!options.ignoreWrites) {
                for (const [key, value] of Object.entries(body)) {
                    const next = structuredClone(value as Setting);
                    const range = next.channelRange;
                    if (options.enforceChannelRange && Array.isArray(range) && next.channel !== '0' && !range.includes(next.freq)) {
                        next.channel = ap.config[key]?.channel;
                        next.freq = ap.config[key]?.freq;
                    }
                    // A channel left out of the PATCH keeps the stored one (freq still corrects it, see channelIndex).
                    next.channel ??= ap.config[key]?.channel;
                    if (options.channelIndex) {
                        const detail = next.channel !== '0' ? detailByFreq(ap.available, next.freq) : undefined;
                        if (detail) next.channel = String(detail.index);
                    }
                    ap.config[key] = next;
                }
            }
            return undefined;
        }),
    };
    return client as typeof client & RadioClient;
}
