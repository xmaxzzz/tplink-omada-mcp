/**
 * Offline check of a netknife-omada/1 plan file with the same parser applyNetknifePlan uses — no controller access.
 * Usage: npx tsx scripts/validate-netknife-plan.ts <plan.json>
 * Exit 0 — plan is valid (warnings from the soft normalization of "current" are printed); 1 — validation errors.
 */
import { readFileSync } from 'node:fs';

import { type PlanWarning, parseNetknifePlan } from '../src/utils/netknife-omada.js';

const file = process.argv[2];
if (!file) {
    console.error('usage: tsx scripts/validate-netknife-plan.ts <plan.json>');
    process.exit(2);
}
const warnings: PlanWarning[] = [];
try {
    const plan = parseNetknifePlan(readFileSync(file, 'utf8').replace(/^﻿/, ''), warnings);
    const radios = plan.aps.reduce((n, ap) => n + Object.values(ap.radios).filter(Boolean).length, 0);
    console.log(`OK: ${plan.aps.length} APs, ${radios} radios, ${plan.aps.filter((ap) => ap.mac).length} with MAC, 0 validation errors`);
    for (const w of warnings) console.log(`warning ${w.code}: ${w.text}`);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
