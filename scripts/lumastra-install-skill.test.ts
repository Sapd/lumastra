// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lumastra-install agent skill (plugins/lumastra-skills) tells an agent to
 * check, generate and verify the three secrets in `.env` with the shell blocks in
 * references/secrets-and-env.md. Those blocks match the literal placeholder lines
 * of `.env.example`. This test runs them against the real `.env.example`, so a
 * change to either file that breaks the install fails here.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const DOC = join(
    ROOT,
    'plugins/lumastra-skills/skills/lumastra-install/references/secrets-and-env.md',
);

/** The first ```bash block after the heading that starts with `prefix`. */
function bashBlockAfter(markdown: string, prefix: string): string {
    const start = markdown.indexOf(`\n${prefix}`);
    if (start === -1) throw new Error(`heading not found: ${prefix}`);
    const match = /```bash\n([\s\S]*?)```/.exec(markdown.slice(start));
    if (!match) throw new Error(`no bash block after: ${prefix}`);
    return match[1];
}

const doc = readFileSync(DOC, 'utf8');
const placeholderCheck = bashBlockAfter(doc, '## 1.');
const generate = bashBlockAfter(doc, '## 2.');
const verify = bashBlockAfter(doc, '## 3.');

function run(script: string, cwd: string): string {
    // grep -c exits 1 when it counts 0; the documented checks read the count.
    return execFileSync('sh', ['-c', `${script}\ntrue`], { cwd, encoding: 'utf8' }).trim();
}

describe('lumastra-install skill: secrets in .env', () => {
    let dir = '';
    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
        dir = '';
    });

    it('checks, generates and verifies the secrets against .env.example', () => {
        dir = mkdtempSync(join(tmpdir(), 'lumastra-install-skill-'));
        copyFileSync(join(ROOT, '.env.example'), join(dir, '.env'));

        expect(run(placeholderCheck, dir)).toBe('3');
        expect(run(generate, dir)).toBe('written');
        expect(run(verify, dir)).toBe('3');
        expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);

        // A second run must refuse: the placeholders are gone.
        expect(run(placeholderCheck, dir)).not.toBe('3');
        // Only the three secret lines changed.
        const before = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n');
        const after = readFileSync(join(dir, '.env'), 'utf8').split('\n');
        expect(after).toHaveLength(before.length);
        const changed = before.filter((line, i) => line !== after[i]);
        expect(changed).toEqual([
            expect.stringMatching(/^DATABASE_PASSWORD=/),
            expect.stringMatching(/^CACHE_PASSWORD=/),
            expect.stringMatching(/^# LUMASTRA_MASTER_KEY=/),
        ]);
    });
});
