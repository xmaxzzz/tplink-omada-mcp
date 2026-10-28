import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { OmadaClient } from '../../src/omadaClient/index.js';
import { applyApLoadBalanceChange, registerSetApLoadBalanceTool } from '../../src/tools/setApLoadBalance.js';
import * as loggerModule from '../../src/utils/logger.js';

type Handler = (args: unknown, extra: { sessionId?: string }) => Promise<{ content: { text: string }[] }>;

const MAC = '3C-64-CF-69-9A-64';

/** Real 6.x GET response (Alie Parusa, controller 6.x). */
function lbConfig(): Record<string, unknown> {
    return {
        maxClientsEnable2g: false,
        maxClients2g: 1,
        rssiEnable2g: true,
        threshold2g: -80,
        maxClientsEnable5g: false,
        maxClients5g: 1,
        rssiEnable5g: true,
        threshold5g: -70,
        maxClientsEnable5g2: false,
        maxClientsEnable6g: false,
    };
}

/** Fake controller: GET returns the stored config, PATCH stores the body through `accept` (default: take it all). */
function fakeClient(
    initial = lbConfig(),
    accept: (body: Record<string, unknown>, stored: Record<string, unknown>) => Record<string, unknown> = (b) => b
) {
    let stored = { ...initial };
    return {
        getSitesApsLoadBalance: vi.fn(() => Promise.resolve({ ...stored })),
        modifyApLoadBalanceConfig: vi.fn((_mac: string, body: Record<string, unknown>) => {
            stored = { ...accept(body, stored) };
            return Promise.resolve(undefined);
        }),
    };
}

describe('tools/setApLoadBalance', () => {
    let mockServer: McpServer;
    let toolHandler: Handler;
    let toolConfig: { description: string; inputSchema: z.ZodRawShape };

    beforeEach(() => {
        mockServer = {
            registerTool: vi.fn((_name, config, handler) => {
                toolConfig = config;
                toolHandler = handler;
            }),
        } as unknown as McpServer;
        vi.spyOn(loggerModule.logger, 'info').mockImplementation(() => undefined);
        vi.spyOn(loggerModule.logger, 'warn').mockImplementation(() => undefined);
        vi.spyOn(loggerModule.logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function call(client: ReturnType<typeof fakeClient>, args: Record<string, unknown>) {
        registerSetApLoadBalanceTool(mockServer, client as unknown as OmadaClient);
        const result = await toolHandler({ apMac: MAC, ...args }, { sessionId: 's' });
        return JSON.parse(result.content[0].text);
    }

    describe('registration and input schema', () => {
        it('registers with dryRun defaulting to true and the IoT note', () => {
            registerSetApLoadBalanceTool(mockServer, fakeClient() as unknown as OmadaClient);
            expect(mockServer.registerTool).toHaveBeenCalledWith('setApLoadBalance', expect.any(Object), expect.any(Function));
            expect(toolConfig.description).toContain('dryRun=true first');
            expect(toolConfig.description).toContain('On 2.4 GHz IoT clients tolerate RSSI cut-off badly');
            const schema = z.object(toolConfig.inputSchema);
            expect(schema.parse({ apMac: MAC, band: '5g', threshold: -75 }).dryRun).toBe(true);
        });

        it('rejects out-of-range and malformed values', () => {
            registerSetApLoadBalanceTool(mockServer, fakeClient() as unknown as OmadaClient);
            const schema = z.object(toolConfig.inputSchema);
            expect(() => schema.parse({ apMac: MAC, band: '5g', threshold: -96 })).toThrow();
            expect(() => schema.parse({ apMac: MAC, band: '5g', threshold: -39 })).toThrow();
            expect(() => schema.parse({ apMac: MAC, band: '5g', threshold: -70.5 })).toThrow();
            expect(() => schema.parse({ apMac: MAC, band: '5g', maxClients: 0 })).toThrow();
            expect(() => schema.parse({ apMac: MAC, band: '5g', maxClients: 513 })).toThrow();
            expect(() => schema.parse({ apMac: MAC, band: '5g1', maxClients: 10 })).toThrow();
            expect(() => schema.parse({ apMac: 'x', band: '5g' })).toThrow();
            expect(schema.parse({ apMac: MAC, band: '5g', threshold: -95, maxClients: 512 })).toMatchObject({ threshold: -95, maxClients: 512 });
        });
    });

    describe('dry run', () => {
        it('returns before/after/diff with the full body and does not PATCH', async () => {
            const client = fakeClient();
            const body = await call(client, { band: '5g', threshold: -75 });
            expect(body).toMatchObject({ apMac: MAC, band: '5g', dryRun: true, verified: false, diff: { threshold5g: { from: -70, to: -75 } } });
            expect(body.after).toEqual({ ...lbConfig(), threshold5g: -75 });
            expect(body.request).toEqual(body.after);
            expect(body.before).toEqual(lbConfig());
            expect(body.warnings).toBeUndefined();
            expect(client.modifyApLoadBalanceConfig).not.toHaveBeenCalled();
            expect(client.getSitesApsLoadBalance).toHaveBeenCalledTimes(1);
        });

        it('normalizes the MAC and passes siteId/customHeaders to GET', async () => {
            const client = fakeClient();
            await call(client, { apMac: '3c:64:cf:69:9a:64', band: '2g', maxClients: 30, siteId: 'site-1', customHeaders: { 'X-A': 'b' } });
            expect(client.getSitesApsLoadBalance).toHaveBeenCalledWith(MAC, 'site-1', { 'X-A': 'b' });
        });
    });

    describe('write', () => {
        it('PATCHes the whole GET object with only the band fields changed and verifies', async () => {
            const client = fakeClient();
            const body = await call(client, { band: '5g', rssiEnable: true, threshold: -75, dryRun: false, siteId: 'site-1' });
            expect(client.modifyApLoadBalanceConfig).toHaveBeenCalledWith(MAC, { ...lbConfig(), threshold5g: -75 }, 'site-1', undefined);
            expect(body).toMatchObject({ dryRun: false, verified: true, after: { threshold5g: -75, threshold2g: -80, rssiEnable2g: true } });
            expect(body.diff).toEqual({ threshold5g: { from: -70, to: -75 } });
            expect(body.ignored).toBeUndefined();
            expect(body.sideEffects).toBeUndefined();
            expect(client.getSitesApsLoadBalance).toHaveBeenCalledTimes(2);
        });

        it('keeps unknown keys of the GET object in the PATCH body', async () => {
            const client = fakeClient({ ...lbConfig(), enable: true, futureField: { a: 1 } });
            await call(client, { band: '2g', maxClientsEnable: true, maxClients: 40, dryRun: false });
            expect(client.modifyApLoadBalanceConfig).toHaveBeenCalledWith(
                MAC,
                { ...lbConfig(), enable: true, futureField: { a: 1 }, maxClientsEnable2g: true, maxClients2g: 40 },
                undefined,
                undefined
            );
        });

        it('still PATCHes a no-op request and reports verified with an empty diff', async () => {
            const client = fakeClient();
            const body = await call(client, { band: '5g', threshold: -70, dryRun: false });
            expect(client.modifyApLoadBalanceConfig).toHaveBeenCalledWith(MAC, lbConfig(), undefined, undefined);
            expect(body).toMatchObject({ verified: true, diff: {} });
        });

        it('returns verified=false and lists fields the controller ignored', async () => {
            // Controller keeps rssi/threshold as they were (spec-only PATCH semantics).
            const client = fakeClient(lbConfig(), (bodyIn, stored) => ({
                ...bodyIn,
                threshold5g: stored.threshold5g,
                rssiEnable5g: stored.rssiEnable5g,
            }));
            const body = await call(client, { band: '5g', threshold: -75, dryRun: false });
            expect(body.verified).toBe(false);
            expect(body.ignored).toEqual(['threshold5g: requested -75, controller has -70']);
            expect(loggerModule.logger.warn).toHaveBeenCalledWith('Omada load-balance verification failed', expect.any(Object));
        });

        it('reports untouched fields that changed as sideEffects', async () => {
            // Controller resets 2g RSSI when 5g is written.
            const client = fakeClient(lbConfig(), (bodyIn) => {
                const { rssiEnable2g: _r, threshold2g: _t, ...rest } = bodyIn;
                return rest;
            });
            const body = await call(client, { band: '5g', maxClients: 50, dryRun: false });
            expect(body.verified).toBe(true);
            expect(body.sideEffects).toEqual({ rssiEnable2g: { from: true, to: undefined }, threshold2g: { from: -80, to: undefined } });
        });
    });

    describe('guards', () => {
        it('rejects threshold when RSSI threshold is off and not turned on', async () => {
            const client = fakeClient({ ...lbConfig(), rssiEnable5g: false });
            await expect(call(client, { band: '5g', threshold: -75 })).rejects.toThrow('threshold needs RSSI threshold on');
            await expect(call(client, { band: '5g', rssiEnable: false, threshold: -75 })).rejects.toThrow('pass rssiEnable: true');
            expect(client.modifyApLoadBalanceConfig).not.toHaveBeenCalled();
        });

        it('accepts threshold together with rssiEnable: true when it is off', async () => {
            const client = fakeClient({ ...lbConfig(), rssiEnable5g: false });
            const body = await call(client, { band: '5g', rssiEnable: true, threshold: -75 });
            expect(body.diff).toEqual({ rssiEnable5g: { from: false, to: true }, threshold5g: { from: -70, to: -75 } });
        });

        it('rejects RSSI fields on a band without them in GET (5g2/6g)', async () => {
            const client = fakeClient();
            await expect(call(client, { band: '5g2', rssiEnable: true })).rejects.toThrow(
                'returns no RSSI threshold fields (rssiEnable5g2/threshold5g2)'
            );
            await expect(call(client, { band: '6g', threshold: -75 })).rejects.toThrow('returns no RSSI threshold fields');
        });

        it('rejects max-clients fields on a band the controller does not return', async () => {
            const { maxClientsEnable6g: _drop, ...without6g } = lbConfig();
            await expect(call(fakeClient(without6g), { band: '6g', maxClients: 10 })).rejects.toThrow('returns no max-clients fields');
        });

        it('requires maxClients when enabling the limit and there is no current value', async () => {
            await expect(call(fakeClient(), { band: '5g2', maxClientsEnable: true })).rejects.toThrow('needs maxClients');
            const body = await call(fakeClient(), { band: '5g2', maxClientsEnable: true, maxClients: 64 });
            expect(body.diff).toEqual({ maxClientsEnable5g2: { from: false, to: true }, maxClients5g2: { from: undefined, to: 64 } });
            const keep = await call(fakeClient(), { band: '2g', maxClientsEnable: true });
            expect(keep.after.maxClients2g).toBe(1);
        });

        it('rejects an empty request before reading the controller', async () => {
            const client = fakeClient();
            await expect(call(client, { band: '5g' })).rejects.toThrow('No load-balance changes requested');
            expect(client.getSitesApsLoadBalance).not.toHaveBeenCalled();
            expect(loggerModule.logger.error).toHaveBeenCalledWith('Tool failed', expect.objectContaining({ tool: 'setApLoadBalance' }));
        });

        it('rejects a GET that is not a config object', async () => {
            const client = fakeClient();
            client.getSitesApsLoadBalance.mockResolvedValueOnce(undefined as unknown as Record<string, unknown>);
            await expect(call(client, { band: '5g', maxClients: 5 })).rejects.toThrow('returned no config object');
            client.getSitesApsLoadBalance.mockResolvedValueOnce([] as unknown as Record<string, unknown>);
            await expect(call(client, { band: '5g', maxClients: 5 })).rejects.toThrow('returned no config object');
        });

        it('warns on a threshold stricter than -70 dBm', async () => {
            const body = await call(fakeClient(), { band: '5g', threshold: -65 });
            expect(body.warnings).toEqual([expect.stringContaining('5g: RSSI threshold -65 dBm is stricter than -70 dBm')]);
            const atEdge = await call(fakeClient(), { band: '5g', threshold: -70 });
            expect(atEdge.warnings).toBeUndefined();
        });

        it('warns about IoT clients when RSSI threshold is on for 2g', async () => {
            const body = await call(fakeClient(), { band: '2g', threshold: -85 });
            expect(body.warnings).toEqual([expect.stringContaining('IoT clients')]);
            const off = await call(fakeClient(), { band: '2g', rssiEnable: false });
            expect(off.warnings).toBeUndefined();
            const maxOnly = await call(fakeClient(), { band: '2g', maxClients: 20 });
            expect(maxOnly.warnings).toBeUndefined();
        });
    });

    it('exposes the core function for direct use', async () => {
        const client = fakeClient();
        const result = await applyApLoadBalanceChange(client as unknown as OmadaClient, MAC, '5g', { maxClients: 10 }, { dryRun: true });
        expect(result.diff).toEqual({ maxClients5g: { from: 1, to: 10 } });
    });
});
