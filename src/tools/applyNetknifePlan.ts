import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';
import { applyNetknifePlan } from '../utils/netknife-omada.js';

const inputSchema = siteInputSchema.extend({
    plan: z
        .union([z.string().min(1), z.record(z.string(), z.unknown())])
        .describe('NetKnife plan (format "netknife-omada/1", kind "plan") as an object or a JSON string.'),
    dryRun: z.boolean().default(true).describe('Default true: validate every AP and return the diffs without writing.'),
    force: z
        .boolean()
        .default(false)
        .describe('Apply even if the plan "current" block differs from the controller. Default false (such APs are skipped).'),
    stopOnError: z.boolean().default(true).describe('Stop at the first failed AP (remaining APs are reported as skipped). Default true.'),
});

export function registerApplyNetknifePlanTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'applyNetknifePlan',
        {
            description:
                'WRITE: apply a NetKnife radio plan (netknife-omada/1, kind "plan") to the site APs — channel, width, TX power, radio on/off only (never SSIDs, site or other devices). APs are matched by MAC (name as fallback) and changed one at a time with verification after each. Null/missing fields are left unchanged. ALWAYS run with dryRun=true first (the default), show the per-AP diff to a human, then repeat with dryRun=false. Planned channels are checked against the AP available-channel list before any write: an unavailable channel is an error and that AP is not written (with stopOnError, the default, nothing is written). An AP that is not on the controller (no MAC and no unique name match, or an unknown MAC) is skipped with a reason, the rest of the plan proceeds. Optional plan lists `unmanaged` / `unchanged` (APs not for writing / left as is) are never written, only reported in `unmanaged`, `unchanged` and `report`. An empty `channelRange` on the AP is filled with the allowed channels of the AP when the channel is written (see `notes`). Returns a backup (state before changes), per-AP results and `warnings` (3+ APs on one channel in one band; numeric strings in the plan "current" block read as numbers; the optional Helpdesk `warnings`) — warnings never block the write, show them to the human.',
            inputSchema: inputSchema.shape,
        },
        wrapToolHandler('applyNetknifePlan', async ({ plan, dryRun, force, stopOnError, siteId, customHeaders }) =>
            toToolResult(
                await applyNetknifePlan(client, plan, {
                    dryRun: dryRun ?? true,
                    force: force ?? false,
                    stopOnError: stopOnError ?? true,
                    siteId,
                    customHeaders,
                })
            )
        )
    );
}
