import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/validate-netknife-plan.ts', import.meta.url));

function run(...args: string[]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8' });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function planFile(loadBalance: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'netknife-plan-'));
    const file = join(dir, 'omada-plan.json');
    writeFileSync(
        file,
        JSON.stringify({ format: 'netknife-omada/1', kind: 'plan', aps: [{ name: 'Кухня', mac: '3C-64-CF-69-9A-64', radios: {}, loadBalance }] })
    );
    return file;
}

describe('scripts/validate-netknife-plan', () => {
    it('exit 0 for a plan with a valid loadBalance block', () => {
        const { code, stdout } = run(planFile({ '5g': { rssiEnable: true, threshold: -70 }, '2g': null }));
        expect(code).toBe(0);
        expect(stdout).toContain('OK: 1 APs, 0 radios, 1 loadBalance bands, 1 with MAC, 0 validation errors');
    });

    it('exit 1 with a readable message on a contract violation', () => {
        const { code, stderr } = run(planFile({ '5g': { rssiEnable: true, threshold: '-70' } }));
        expect(code).toBe(1);
        expect(stderr).toContain('aps.0.loadBalance.5g.threshold: threshold must be an integer dBm in -95…-40 (a number, not a string)');
    });

    it('exit 1 for a missing file, 2 without arguments', () => {
        expect(run('/nonexistent/plan.json').code).toBe(1);
        expect(run().code).toBe(2);
    });
});
