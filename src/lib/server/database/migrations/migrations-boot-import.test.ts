// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = resolve(__dirname, '../../../../..');

/**
 * Containers run migrations through tsx (`npm run startup-migration`), not
 * through Vite, so vitest's alias resolution proves nothing about boot. A
 * migration that imports live code must still load there: a broken import is a
 * boot that fails before the first migration runs.
 */
describe('migration module graph on the container boot path', () => {
    it('imports migrate-schema.ts and every registered migration under tsx', async () => {
        const fixture = 'src/lib/server/database/migrations/__fixtures__/boot-import.fixture.ts';
        const result = await run('npx', ['tsx', '--tsconfig', 'tsconfig.scripts.json', fixture], {
            cwd: root,
            env: { ...process.env, NODE_OPTIONS: '--import ./scripts/register-lua.mjs' },
            timeout: 120_000,
        }).catch((error: { stdout?: string; stderr?: string; message: string }) => {
            throw new Error(`${error.message}\n${error.stderr ?? ''}\n${error.stdout ?? ''}`);
        });
        const { stdout } = result;
        expect(stdout).toContain('boot-import-ok');
    }, 150_000);
});
