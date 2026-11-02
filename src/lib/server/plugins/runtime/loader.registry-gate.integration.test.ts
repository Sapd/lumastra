// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { loadAndWirePlugin } from './loader.js';
import {
    upsertExternalPlugin,
    deleteExternalPluginRow,
} from '$lib/server/database/queries/external-plugins.queries.js';

let sql: postgres.Sql;
let tmp: string;
const NAME = 'gate-test-plugin';

// Valid single-file task bundle: default export + execute + inputSchema is what
// detectSdkDefinition (loader.ts:200) recognizes as kind 'task', and
// loadExternalPlugin (loader.ts:380) requires a default export. A bare
// `export const task = { id, run }` has NEITHER and would be rejected. [review]
// A VALID task: the loader runs defineTask over external plugins, so a stub
// missing name/version/processingVersion is refused at load — correctly.
const TASK_BUNDLE = `export default { id: '${NAME}', name: 'Gate Test Plugin', version: '1.0.0', processingVersion: 1, resourceClass: 'maintenance', capabilities: {}, identityFor: () => 'global', inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) }, execute: async () => ({}) };`;

function writeDir(name: string, indexJs: string, extraFiles: Record<string, string> = {}): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), indexJs);
    for (const [f, c] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, f), c);
    return dir;
}
function sha256(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-gate-'));
    process.env.PLUGINS_EXTERNAL_DIR = tmp;
});
afterEach(async () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    await deleteExternalPluginRow(sql, NAME);
});

describe('loader registry gate + checksum re-verify', () => {
    it('refuses to load a managed dir whose index.js sha256 != row.checksum [review C3]', async () => {
        const dir = writeDir(NAME, TASK_BUNDLE);
        await upsertExternalPlugin(sql, {
            name: NAME,
            version: '1.0.0',
            checksum: 'b'.repeat(64), // wrong on purpose
            sourceManifestUrl: 'http://x/m',
            signature: 's',
            capabilities: null,
            enabled: true,
            status: 'installed',
            installedBy: 't',
            bundle: null,
            signingKeyId: null,
        });
        const res = await loadAndWirePlugin(dir, sql);
        expect(res.loaded).toBe(false);
    });

    it('ignores package.json#main for a managed dir (loads index.js only) [review C2]', async () => {
        const dir = writeDir(NAME, TASK_BUNDLE, {
            'evil.js': `throw new Error('evil ran');`,
            'package.json': JSON.stringify({ main: 'evil.js' }),
        });
        await upsertExternalPlugin(sql, {
            name: NAME,
            version: '1.0.0',
            checksum: sha256(path.join(dir, 'index.js')),
            sourceManifestUrl: 'http://x/m',
            signature: 's',
            capabilities: null,
            enabled: true,
            status: 'installed',
            installedBy: 't',
            bundle: null,
            signingKeyId: null,
        });
        const res = await loadAndWirePlugin(dir, sql);
        expect(res.loaded).toBe(true); // evil.js never imported
    });

    it('skips a disabled row [Fable-3]', async () => {
        const dir = writeDir(NAME, TASK_BUNDLE);
        await upsertExternalPlugin(sql, {
            name: NAME,
            version: '1.0.0',
            checksum: sha256(path.join(dir, 'index.js')),
            sourceManifestUrl: 'http://x/m',
            signature: 's',
            capabilities: null,
            enabled: false,
            status: 'installed',
            installedBy: 't',
            bundle: null,
            signingKeyId: null,
        });
        const res = await loadAndWirePlugin(dir, sql);
        expect(res.loaded).toBe(false);
    });
});
