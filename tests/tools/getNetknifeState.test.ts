import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerGetNetknifeStateTool } from '../../src/tools/getNetknifeState.js';
import * as loggerModule from '../../src/utils/logger.js';
import { createFakeOmada, exampleAp } from '../helpers/fakeOmada.js';

type Handler = (args: unknown, extra: { sessionId?: string }) => Promise<{ content: { text: string }[] }>;

describe('tools/getNetknifeState', () => {
    let mockServer: McpServer;
    let toolHandler: Handler;
    let toolConfig: { description: string };

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

    it('registers as a read-only state tool', () => {
        registerGetNetknifeStateTool(mockServer, createFakeOmada([]) as unknown as OmadaClient);
        expect(mockServer.registerTool).toHaveBeenCalledWith('getNetknifeState', expect.any(Object), expect.any(Function));
        expect(toolConfig.description).toContain('netknife-omada/1');
    });

    it('returns a netknife-omada/1 state document', async () => {
        const client = createFakeOmada([exampleAp()]);
        registerGetNetknifeStateTool(mockServer, client as unknown as OmadaClient);
        const result = await toolHandler({ siteId: 'site-1', siteName: 'Алые паруса' }, { sessionId: 's' });
        const state = JSON.parse(result.content[0].text);
        expect(state).toMatchObject({ format: 'netknife-omada/1', kind: 'state', site: 'Алые паруса', country: 'RU' });
        expect(state.aps[0].radios['5g'].channel).toBe(36);
        expect(state.aps[0].loadBalance).toEqual({ '2g': { rssiEnable: false, threshold: -85 }, '5g': { rssiEnable: true, threshold: -75 } });
        expect(client.getSiteDetail).toHaveBeenCalledWith('site-1', undefined);
    });

    it('propagates errors', async () => {
        const client = createFakeOmada([]);
        client.listDevices.mockRejectedValueOnce(new Error('API error'));
        registerGetNetknifeStateTool(mockServer, client as unknown as OmadaClient);
        await expect(toolHandler({}, { sessionId: 's' })).rejects.toThrow('API error');
        expect(loggerModule.logger.error).toHaveBeenCalledWith('Tool failed', expect.objectContaining({ tool: 'getNetknifeState' }));
    });
});
