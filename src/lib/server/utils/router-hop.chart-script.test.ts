// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Helm chart derives the router-hop secret in an init container (hop.js, a Go raw string in
 * deploy/helm/lumastra/templates/router.yaml). The app derives it with deriveRouterHopSecret.
 * They must agree byte for byte, or every hop request is rejected. This runs the chart's script.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveRouterHopSecret } from './router-hop';

const template = readFileSync(
    new URL('../../../../deploy/helm/lumastra/templates/router.yaml', import.meta.url),
    'utf8',
);
const match = template.match(/\$hopScript := `([\s\S]*?)` -\}\}/);

function runChartScript(masterKey: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), 'hop-'));
    try {
        const script = match![1].replace('/hop/hop.conf', join(dir, 'hop.conf'));
        const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
        if (masterKey !== undefined) env.LUMASTRA_MASTER_KEY = masterKey;
        execFileSync(process.execPath, ['-e', script], { env });
        const conf = readFileSync(join(dir, 'hop.conf'), 'utf8');
        const m = conf.match(/^map "" \$lumastra_hop \{ default "([0-9a-f]*)"; \}\n$/);
        if (!m) throw new Error(`unexpected hop.conf: ${conf}`);
        return m[1];
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe('chart hop.js vs deriveRouterHopSecret', () => {
    it('the script is found in the template', () => {
        expect(match).not.toBeNull();
    });

    const keys = [
        'a'.repeat(64),
        '0123456789abcdef'.repeat(4),
        'correct horse battery staple 42!',
        `  ${'b'.repeat(64)}  `,
        `${'c'.repeat(64)}\n`,
        `\t${'d'.repeat(64)}\r\n`,
    ];

    it.each(keys.map((k) => [JSON.stringify(k), k]))('key %s', (_label, key) => {
        expect(runChartScript(key)).toBe(deriveRouterHopSecret(key));
        expect(runChartScript(key)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('whitespace around the key does not change the value', () => {
        const key = 'e'.repeat(64);
        expect(runChartScript(` \n${key}\t `)).toBe(runChartScript(key));
    });

    it('a missing or blank key yields an empty value (nginx then drops the header), like the app', () => {
        expect(runChartScript(undefined)).toBe('');
        expect(runChartScript('  \n')).toBe('');
        expect(deriveRouterHopSecret('  \n')).toBe('');
    });
});
