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
                'WRITE: apply a NetKnife radio plan (netknife-omada/1, kind "plan") to the site APs — channel, width, TX power, radio on/off only (never SSIDs, site or other devices). APs are matched by MAC (name as fallback) and changed one at a time with verification after each. Null/missing fields are left unchanged. ALWAYS run with dryRun=true first (the default), show the per-AP diff to a human, then repeat with dryRun=false. Returns a backup (state before changes) and per-AP results.',
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
