/**
 * Offline check of a netknife-omada/1 plan file with the same parser applyNetknifePlan uses — no controller access.
 * Usage: npx tsx scripts/validate-netknife-plan.ts <plan.json>
 * Exit 0 — plan is valid (warnings from the soft normalization of "current", the plan's own Helpdesk warnings with any code,
 * its "unmanaged" / "unchanged" lists and loadBalance notes are printed — none of them is an error); 1 — validation errors
 * (e.g. loadBalance threshold as a string, out of −95…−40, rssiEnable true without threshold).
 */
import { readFileSync } from 'node:fs';

import { checkNetknifePlan } from '../src/utils/netknife-omada.js';

const file = process.argv[2];
if (!file) {
    console.error('usage: tsx scripts/validate-netknife-plan.ts <plan.json>');
    process.exit(2);
}
let text: string;
try {
    text = readFileSync(file, 'utf8');
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
const { ok, lines } = checkNetknifePlan(text);
for (const line of lines) (ok ? console.log : console.error)(line);
process.exit(ok ? 0 : 1);
