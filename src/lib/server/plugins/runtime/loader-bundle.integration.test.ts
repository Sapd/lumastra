// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { extractTarball, type ExtractResult } from '../external-install/archive.js';

const BLOCK = 512;

/** Canonical ustar header for a regular file (mirrors archive.test.ts / the signer). */
function header(name: string, size: number, typeflag = '0'): Buffer {
    const b = Buffer.alloc(BLOCK);
    b.write(name, 0, 'utf8');
    b.write('0000644', 100, 'ascii');
    b.write('0000000', 108, 'ascii');
    b.write('0000000', 116, 'ascii');
    b.write(size.toString(8).padStart(11, '0'), 124, 'ascii');
    b.write('00000000000', 136, 'ascii');
    b.write(typeflag, 156, 'ascii');
    b.write('ustar\0', 257, 'binary');
    b.write('00', 263, 'ascii');
    b.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += b[i];
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return b;
}

function buildTar(entries: Array<{ name: string; content: string; typeflag?: string }>): Buffer {
    const parts: Buffer[] = [];
    for (const e of entries) {
        const data = Buffer.from(e.content, 'utf8');
        parts.push(header(e.name, data.length, e.typeflag ?? '0'));
        const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
        data.copy(padded);
        parts.push(padded);
    }
    parts.push(Buffer.alloc(1024));
    return Buffer.concat(parts);
}

const LIMITS = { maxTotalBytes: 1 << 20, maxEntries: 64, maxFileBytes: 1 << 19 };
const NAME = 'bundle-loader-test';
let sql: postgres.Sql;
let base: string;

// A minimal ESM task plugin split across two files (entry imports the sibling).
const ENTRY =
    `import { schema } from './schema.js';\n` +
    `export default { id: '${NAME}', name: 'Bundle Test Plugin', version: '1.0.0', ` +
    `processingVersion: 1, resourceClass: 'maintenance', capabilities: {}, ` +
    `identityFor: () => 'global', inputSchema: schema, execute: async () => ({}) };\n`;
// Duck-typed: defineTask checks for .parse/.safeParse, not for a zod instance.
const SIB = `export const schema = { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) };\n`;

let loadAndWirePlugin: typeof import('./loader.js').loadAndWirePlugin;
let lastLoadError: typeof import('./loader.js').lastLoadError;
let upsertExternalPlugin: typeof import('../../database/queries/external-plugins.queries.js').upsertExternalPlugin;
let deleteExternalPluginRow: typeof import('../../database/queries/external-plugins.queries.js').deleteExternalPluginRow;

async function fresh(): Promise<void> {
    vi.resetModules();
    ({ loadAndWirePlugin, lastLoadError } = await import('./loader.js'));
    ({ upsertExternalPlugin, deleteExternalPluginRow } =
        await import('../../database/queries/external-plugins.queries.js'));
}

function stageBundle(dir: string): ExtractResult {
    const tar = buildTar([
        { name: 'index.js', content: ENTRY },
        { name: 'schema.js', content: SIB },
    ]);
    return extractTarball(tar, dir, LIMITS);
}

beforeAll(() => {
    sql = getTestDb();
});
beforeEach(async () => {
    await fresh();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-bundle-'));
    process.env.PLUGINS_EXTERNAL_DIR = base;
    await deleteExternalPluginRow(sql, NAME);
});
afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
    delete process.env.PLUGINS_EXTERNAL_DIR;
});
afterAll(async () => {
    await deleteExternalPluginRow(sql, NAME);
    await closeTestDb();
});

async function insertRow(artifactFiles: ExtractResult): Promise<void> {
    await upsertExternalPlugin(sql, {
        name: NAME,
        version: '1.0.0',
        checksum: 'c'.repeat(64), // unused for bundles
        sourceManifestUrl: 'https://x/m',
        signature: 'sig',
        capabilities: null,
        enabled: true,
        status: 'installed',
        installedBy: 'denis',
        bundle: {
            entry: 'index.js',
            treeDigest: artifactFiles.treeDigest,
            files: artifactFiles.files,
        },
        signingKeyId: null,
    });
}

describe('loadOneDir bundle branch', () => {
    it('loads the declared entry across multiple files', async () => {
        const dir = path.join(base, NAME);
        const res = stageBundle(dir);
        await insertRow(res);
        const r = await loadAndWirePlugin(dir, sql, {
            expectedName: NAME,
            expectedKind: 'task',
            rejectWorkerIsolation: true,
        });
        expect(r.loaded).toBe(true);
        expect(lastLoadError.has(NAME)).toBe(false);
    });

    it('refuses when any extracted file is tampered', async () => {
        const dir = path.join(base, NAME);
        const res = stageBundle(dir);
        await insertRow(res);
        fs.writeFileSync(path.join(dir, 'schema.js'), 'export const schema = { HACKED: true };');
        const r = await loadAndWirePlugin(dir, sql, { expectedName: NAME, expectedKind: 'task' });
        expect(r.loaded).toBe(false);
        expect(lastLoadError.get(NAME)).toMatch(/tree digest mismatch/);
    });

    it('refuses a corrupt/invalid bundle jsonb (sentinel)', async () => {
        const dir = path.join(base, NAME);
        await insertRow(stageBundle(dir)); // valid row first
        await sql`UPDATE external_plugins SET bundle = ${sql.json({ entry: '../evil' })} WHERE name = ${NAME}`;
        const r = await loadAndWirePlugin(dir, sql, { expectedName: NAME, expectedKind: 'task' });
        expect(r.loaded).toBe(false);
        expect(lastLoadError.get(NAME)).toMatch(/bundle artifact unreadable/);
    });

    it('refuses a bundle whose entry is missing on disk', async () => {
        const dir = path.join(base, NAME);
        const res = stageBundle(dir);
        await insertRow(res);
        fs.rmSync(path.join(dir, 'index.js'));
        const r = await loadAndWirePlugin(dir, sql, { expectedName: NAME, expectedKind: 'task' });
        expect(r.loaded).toBe(false);
        // removing a file changes the tree digest → mismatch refusal is acceptable too.
        expect(lastLoadError.get(NAME)).toMatch(/tree digest mismatch|bundle entry missing/);
    });

    // §8.4 bullet 1: the declared entry is NOT index.js.
    it('loads a declared entry that is not index.js (entry: main.js, no index.js present)', async () => {
        const dir = path.join(base, NAME);
        const tar = buildTar([
            { name: 'main.js', content: ENTRY }, // ENTRY imports ./schema.js
            { name: 'schema.js', content: SIB },
        ]);
        const res = extractTarball(tar, dir, LIMITS);
        await upsertExternalPlugin(sql, {
            name: NAME,
            version: '1.0.0',
            checksum: 'c'.repeat(64),
            sourceManifestUrl: 'https://x/m',
            signature: 'sig',
            capabilities: null,
            enabled: true,
            status: 'installed',
            installedBy: 'denis',
            bundle: { entry: 'main.js', treeDigest: res.treeDigest, files: res.files },
            signingKeyId: null,
        });
        expect(fs.existsSync(path.join(dir, 'index.js'))).toBe(false); // prove no index.js exists
        const r = await loadAndWirePlugin(dir, sql, {
            expectedName: NAME,
            expectedKind: 'task',
            rejectWorkerIsolation: true,
        });
        expect(r.loaded).toBe(true);
        expect(lastLoadError.has(NAME)).toBe(false);
    });

    // §8.4 bullet 4 (INVARIANT 4 regression): pre-registration worker-isolation refusal for a bundle entry.
    it("rejects a bundle whose entry declares isolation:'worker' (pre-registration)", async () => {
        const dir = path.join(base, NAME);
        const WORKER_ENTRY = `export default { id: '${NAME}', name: 'Gate Test Plugin', version: '1.0.0', processingVersion: 1, resourceClass: 'maintenance', capabilities: {}, identityFor: () => 'global', inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) }, isolation: 'worker', execute: async () => ({}) };\n`;
        const tar = buildTar([{ name: 'index.js', content: WORKER_ENTRY }]);
        const res = extractTarball(tar, dir, LIMITS);
        await upsertExternalPlugin(sql, {
            name: NAME,
            version: '1.0.0',
            checksum: 'c'.repeat(64),
            sourceManifestUrl: 'https://x/m',
            signature: 'sig',
            capabilities: null,
            enabled: true,
            status: 'installed',
            installedBy: 'denis',
            bundle: { entry: 'index.js', treeDigest: res.treeDigest, files: res.files },
            signingKeyId: null,
        });
        const r = await loadAndWirePlugin(dir, sql, {
            expectedName: NAME,
            expectedKind: 'task',
            rejectWorkerIsolation: true,
        });
        expect(r.loaded).toBe(false);
        expect(r.constraintViolation).toBe(true);
        expect(r.error).toMatch(/worker/i);
    });

    it('rejects a bundle whose detected kind mismatches the expected kind (pre-registration)', async () => {
        const dir = path.join(base, NAME);
        const res = stageBundle(dir); // ENTRY is a task-kind def
        await insertRow(res);
        const r = await loadAndWirePlugin(dir, sql, {
            expectedName: NAME,
            expectedKind: 'provider', // mismatch: def is a task
            rejectWorkerIsolation: true,
        });
        expect(r.loaded).toBe(false);
        expect(r.constraintViolation).toBe(true);
        expect(r.error).toMatch(/kind/i);
    });

    // §8.4 bullet 5: module-format fail-closed. In production a bundle shipping
    // package.json {"type":"commonjs"} flips Node's resolution of the ESM entry
    // and the entry's import/export throws at import() time; loadOneDir must
    // surface that as a per-plugin refusal (loaded:false), NEVER let it escape
    // loadAndWirePlugin (host crash). package.json is a tree file → covered by
    // treeDigest and listed in the artifact.
    //
    // NOTE: Vitest's module runner transforms file:// dynamic imports and does
    // NOT honour a bundled package.json#type the way native Node does, so we
    // provoke the SAME caught-import-error path with an entry that throws at
    // module top level (env-independent) while still shipping the package.json
    // in the covered tree.
    it('fails closed (no host crash) when a bundle entry throws at import (package.json in tree)', async () => {
        const dir = path.join(base, NAME);
        const THROWING_ENTRY = `throw new Error('boom at import (would be a CJS/ESM flip in prod)');\n`;
        const tar = buildTar([
            { name: 'index.js', content: THROWING_ENTRY },
            { name: 'package.json', content: '{"type":"commonjs"}\n' },
        ]);
        const res = extractTarball(tar, dir, LIMITS);
        await upsertExternalPlugin(sql, {
            name: NAME,
            version: '1.0.0',
            checksum: 'c'.repeat(64),
            sourceManifestUrl: 'https://x/m',
            signature: 'sig',
            capabilities: null,
            enabled: true,
            status: 'installed',
            installedBy: 'denis',
            bundle: { entry: 'index.js', treeDigest: res.treeDigest, files: res.files },
            signingKeyId: null,
        });
        // Must RESOLVE (not throw) with loaded:false — the import error is caught.
        const r = await loadAndWirePlugin(dir, sql, { expectedName: NAME, expectedKind: 'task' });
        expect(r.loaded).toBe(false);
        expect(lastLoadError.has(NAME)).toBe(true);
    });
});
