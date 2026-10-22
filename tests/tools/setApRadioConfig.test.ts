import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerSetApRadioConfigTool } from '../../src/tools/setApRadioConfig.js';
import * as loggerModule from '../../src/utils/logger.js';
import { createFakeOmada, exampleAp } from '../helpers/fakeOmada.js';

type Handler = (args: unknown, extra: { sessionId?: string }) => Promise<{ content: { text: string }[] }>;

describe('tools/setApRadioConfig', () => {
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

    it('registers with a dry-run-first description and dryRun defaulting to true', () => {
        registerSetApRadioConfigTool(mockServer, createFakeOmada([]) as unknown as OmadaClient);
        expect(mockServer.registerTool).toHaveBeenCalledWith('setApRadioConfig', expect.any(Object), expect.any(Function));
        expect(toolConfig.description).toContain('dryRun=true first');
        const parsed = z.object(toolConfig.inputSchema).parse({ apMac: '3C-64-CF-69-9A-64', band: '5g', channel: 40 });
        expect(parsed.dryRun).toBe(true);
        expect(() => z.object(toolConfig.inputSchema).parse({ apMac: 'x', band: '5g' })).toThrow();
        expect(() => z.object(toolConfig.inputSchema).parse({ apMac: '3C-64-CF-69-9A-64', band: '5g', width: 30 })).toThrow();
    });

    it('defaults to dry-run (no PATCH) when dryRun is omitted', async () => {
        const client = createFakeOmada([exampleAp()]);
        registerSetApRadioConfigTool(mockServer, client as unknown as OmadaClient);
        const result = await toolHandler({ apMac: '3C-64-CF-69-9A-64', band: '5g', channel: 40 }, { sessionId: 's' });
        const body = JSON.parse(result.content[0].text);
        expect(body).toMatchObject({ dryRun: true, verified: false, diff: { '5g': { channel: { from: 36, to: 40 } } } });
        expect(client.modifyRadiosConfig).not.toHaveBeenCalled();
    });

    it('writes and verifies with dryRun=false', async () => {
        const client = createFakeOmada([exampleAp()]);
        registerSetApRadioConfigTool(mockServer, client as unknown as OmadaClient);
        const result = await toolHandler(
            { apMac: '3C-64-CF-69-9A-64', band: '2g', txPowerMode: 'custom', txPower: 10, dryRun: false, siteId: 'site-1' },
            { sessionId: 's' }
        );
        const body = JSON.parse(result.content[0].text);
        expect(body).toMatchObject({ dryRun: false, verified: true, after: { '2g': { txPower: 10 } } });
        expect(client.modifyRadiosConfig).toHaveBeenCalledWith('3C-64-CF-69-9A-64', expect.any(Object), 'site-1', undefined);
    });

    it('fails with a validation error', async () => {
        registerSetApRadioConfigTool(mockServer, createFakeOmada([exampleAp()]) as unknown as OmadaClient);
        await expect(toolHandler({ apMac: '3C-64-CF-69-9A-64', band: '2g', channel: 14 }, { sessionId: 's' })).rejects.toThrow('not available');
        expect(loggerModule.logger.error).toHaveBeenCalledWith('Tool failed', expect.objectContaining({ tool: 'setApRadioConfig' }));
    });
});
