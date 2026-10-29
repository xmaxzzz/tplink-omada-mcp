import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';
import { collectNetknifeState } from '../utils/netknife-omada.js';

const inputSchema = siteInputSchema.extend({
    siteName: z.string().min(1).optional().describe('Human-readable site name to put into the "site" field. Defaults to the Omada site name.'),
});

export function registerGetNetknifeStateTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getNetknifeState',
        {
            description:
                'Snapshot radio settings of every AP in a site as a NetKnife exchange file (format "netknife-omada/1", kind "state"): per AP name, mac, ip, model and radios 2g/5g/6g with enabled, channel, width, txPowerMode, txPower and the channels/widths Omada allows, plus loadBalance (RSSI threshold per band: {rssiEnable, threshold}) from GET load-balance. A failed load-balance read of one AP only omits its loadBalance block and is listed in `warnings`. Read-only. Save the JSON and load it into NetKnife ("Загрузить из Omada").',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('getNetknifeState', async ({ siteId, siteName, customHeaders }) =>
            toToolResult(await collectNetknifeState(client, { siteId, siteName, customHeaders }))
        )
    );
}
