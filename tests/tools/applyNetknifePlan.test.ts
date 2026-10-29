import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerApplyNetknifePlanTool } from '../../src/tools/applyNetknifePlan.js';
import * as loggerModule from '../../src/utils/logger.js';
import { createFakeOmada, exampleAp } from '../helpers/fakeOmada.js';

type Handler = (args: unknown, extra: { sessionId?: string }) => Promise<{ content: { text: string }[] }>;

const plan = {
    format: 'netknife-omada/1',
    kind: 'plan',
    site: 'Алые паруса',
    aps: [
        {
            name: 'Кухня',
            mac: '3C-64-CF-69-9A-64',
            radios: {
                '2g': { channel: 1, width: 20, txPowerMode: 'custom', txPower: 12 },
                '5g': { channel: 44, width: 40, txPowerMode: 'custom', txPower: 18 },
            },
            current: { '2g': { channel: 6, width: 20, txPower: 14 }, '5g': { channel: 36, width: 40, txPower: 20 } },
        },
    ],
};

describe('tools/applyNetknifePlan', () => {
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
        vi.spyOn(loggerModule.logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('registers with safe defaults', () => {
        registerApplyNetknifePlanTool(mockServer, createFakeOmada([]) as unknown as OmadaClient);
        expect(mockServer.registerTool).toHaveBeenCalledWith('applyNetknifePlan', expect.any(Object), expect.any(Function));
        expect(toolConfig.description).toContain('dryRun=true first');
        const parsed = z.object(toolConfig.inputSchema).parse({ plan: '{}' });
        expect(parsed).toMatchObject({ dryRun: true, force: false, stopOnError: true });
    });

    it('dry-run by default: returns backup and per-AP diff without writing', async () => {
        const client = createFakeOmada([exampleAp()]);
        registerApplyNetknifePlanTool(mockServer, client as unknown as OmadaClient);
        const result = await toolHandler({ plan: JSON.stringify(plan) }, { sessionId: 's' });
        const body = JSON.parse(result.content[0].text);
        expect(body.backup).toMatchObject({ kind: 'state', site: 'Алые паруса' });
        expect(body.results[0]).toMatchObject({ status: 'dry-run', mac: '3C-64-CF-69-9A-64' });
        expect(client.modifyRadiosConfig).not.toHaveBeenCalled();
    });

    it('applies with dryRun=false and passes siteId', async () => {
        const client = createFakeOmada([exampleAp()]);
        registerApplyNetknifePlanTool(mockServer, client as unknown as OmadaClient);
        const result = await toolHandler({ plan, dryRun: false, force: false, stopOnError: true, siteId: 'site-1' }, { sessionId: 's' });
        const body = JSON.parse(result.content[0].text);
        expect(body.summary).toEqual({ applied: 1, skipped: 0, error: 0, 'dry-run': 0 });
        expect(client.modifyRadiosConfig).toHaveBeenCalledWith('3C-64-CF-69-9A-64', expect.any(Object), 'site-1', undefined);
    });

    it('applies the loadBalance block after radios and passes siteId to the load-balance PATCH', async () => {
        const client = createFakeOmada([exampleAp()]);
        registerApplyNetknifePlanTool(mockServer, client as unknown as OmadaClient);
        const withLb = { ...plan, aps: [{ ...plan.aps[0], loadBalance: { '5g': { rssiEnable: true, threshold: -70 } } }] };
        const dry = JSON.parse((await toolHandler({ plan: withLb }, { sessionId: 's' })).content[0].text);
        expect(dry.results[0].loadBalance.lines).toContain('loadBalance 5g threshold: -75 dBm → -70 dBm');
        expect(client.modifyApLoadBalanceConfig).not.toHaveBeenCalled();
        const result = await toolHandler({ plan: withLb, dryRun: false, siteId: 'site-1' }, { sessionId: 's' });
        const body = JSON.parse(result.content[0].text);
        expect(body.results[0]).toMatchObject({ status: 'applied', loadBalance: { verified: true } });
        expect(client.modifyApLoadBalanceConfig).toHaveBeenCalledWith(
            '3C-64-CF-69-9A-64',
            expect.objectContaining({ threshold5g: -70 }),
            'site-1',
            undefined
        );
        expect(toolConfig.description).toContain('loadBalance');
    });

    it('returns warnings (plan check + Helpdesk) in the tool output', async () => {
        const client = createFakeOmada([exampleAp()]);
        registerApplyNetknifePlanTool(mockServer, client as unknown as OmadaClient);
        const withWarnings = { ...plan, warnings: [{ code: 'single_channel_ap', band: '5', aps: ['Кухня'], text: 'одна точка на канале' }] };
        const result = await toolHandler({ plan: withWarnings }, { sessionId: 's' });
        const body = JSON.parse(result.content[0].text);
        expect(body.warnings).toEqual([expect.objectContaining({ source: 'helpdesk', text: 'Helpdesk предупреждает: одна точка на канале' })]);
        expect(body.results[0].status).toBe('dry-run');
    });

    it('rejects an invalid plan', async () => {
        registerApplyNetknifePlanTool(mockServer, createFakeOmada([]) as unknown as OmadaClient);
        await expect(toolHandler({ plan: { kind: 'state' } }, { sessionId: 's' })).rejects.toThrow('plan does not match');
        expect(loggerModule.logger.error).toHaveBeenCalledWith('Tool failed', expect.objectContaining({ tool: 'applyNetknifePlan' }));
    });
});
