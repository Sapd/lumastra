// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the external_plugins registry query module.
 *
 * Exercises upsert (INSERT + ON CONFLICT), camelCase mapping, the loadable vs
 * installed list filters, disable/uninstall state transitions, and hard delete
 * against a real PostgreSQL test DB.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import type postgres from 'postgres';
import {
    getExternalPlugin,
    listExternalPlugins,
    listLoadableExternalPlugins,
    upsertExternalPlugin,
    setExternalPluginEnabled,
    markExternalPluginUninstalled,
    deleteExternalPluginRow,
    type ExternalPluginUpsert,
} from './external-plugins.queries.js';
import {
    isInvalidBundle,
    type BundleArtifact,
} from '../../plugins/external-install/bundle-artifact.js';

const base: ExternalPluginUpsert = {
    name: 'sample-plugin',
    version: '1.0.0',
    checksum: 'a'.repeat(64),
    sourceManifestUrl: 'http://localhost/manifest.json',
    signature: 'c2ln',
    capabilities: { http: true },
    enabled: true,
    status: 'installed',
    installedBy: 'denis',
    bundle: null,
    signingKeyId: 'ops-2026',
};

describe('external-plugins.queries', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM external_plugins WHERE name = ${base.name}`;
    });

    it('upserts and reads back camelCased', async () => {
        await upsertExternalPlugin(sql, base);
        const row = await getExternalPlugin(sql, base.name);
        expect(row?.version).toBe('1.0.0');
        expect(row?.capabilities).toEqual({ http: true });
        expect(row?.installedBy).toBe('denis');
    });

    it('ON CONFLICT updates version + bumps updated_at', async () => {
        await upsertExternalPlugin(sql, base);
        const first = await getExternalPlugin(sql, base.name);
        await new Promise((r) => setTimeout(r, 5));
        await upsertExternalPlugin(sql, { ...base, version: '1.1.0' });
        const second = await getExternalPlugin(sql, base.name);
        expect(second?.version).toBe('1.1.0');
        expect(new Date(second!.updatedAt).getTime()).toBeGreaterThanOrEqual(
            new Date(first!.updatedAt).getTime(),
        );
    });

    it('disable drops the row from the loadable list but keeps it in the installed list', async () => {
        await upsertExternalPlugin(sql, base);
        await setExternalPluginEnabled(sql, base.name, false);
        expect((await listLoadableExternalPlugins(sql)).some((r) => r.name === base.name)).toBe(
            false,
        );
        expect((await listExternalPlugins(sql)).some((r) => r.name === base.name)).toBe(true);
    });

    it('markUninstalled hides from both loadable + installed lists', async () => {
        await upsertExternalPlugin(sql, base);
        await markExternalPluginUninstalled(sql, base.name);
        const row = await getExternalPlugin(sql, base.name);
        expect(row?.status).toBe('uninstalled');
        expect(row?.enabled).toBe(false);
        expect((await listExternalPlugins(sql)).some((r) => r.name === base.name)).toBe(false);
    });

    it('deleteExternalPluginRow removes it entirely', async () => {
        await upsertExternalPlugin(sql, base);
        await deleteExternalPluginRow(sql, base.name);
        expect(await getExternalPlugin(sql, base.name)).toBeNull();
    });

    const artifact: BundleArtifact = {
        entry: 'index.js',
        treeDigest: 'a'.repeat(64),
        files: [{ path: 'index.js', sha256: 'b'.repeat(64), size: 3 }],
    };

    it('round-trips a bundle artifact', async () => {
        await upsertExternalPlugin(sql, { ...base, bundle: artifact });
        const row = await getExternalPlugin(sql, base.name);
        expect(row?.bundle).toEqual(artifact);
    });

    it('persists null for single-file plugins', async () => {
        await upsertExternalPlugin(sql, { ...base, bundle: null });
        const row = await getExternalPlugin(sql, base.name);
        expect(row?.bundle).toBeNull();
    });

    it('ON CONFLICT overwrites bundle (bundle→null downgrade)', async () => {
        await upsertExternalPlugin(sql, { ...base, bundle: artifact });
        await upsertExternalPlugin(sql, { ...base, bundle: null });
        const row = await getExternalPlugin(sql, base.name);
        expect(row?.bundle).toBeNull();
    });

    it('round-trips signingKeyId and preserves it across an upgrade upsert', async () => {
        await upsertExternalPlugin(sql, { ...base, signingKeyId: 'ops-2026' });
        let row = await getExternalPlugin(sql, base.name);
        expect(row?.signingKeyId).toBe('ops-2026');

        // Upgrade upsert with a different key id overwrites (EXCLUDED wins).
        await upsertExternalPlugin(sql, { ...base, version: '1.1.0', signingKeyId: 'ops-2027' });
        row = await getExternalPlugin(sql, base.name);
        expect(row?.version).toBe('1.1.0');
        expect(row?.signingKeyId).toBe('ops-2027');

        const list = await listExternalPlugins(sql);
        expect(list.find((r) => r.name === base.name)?.signingKeyId).toBe('ops-2027');
    });

    it('reads back NULL signingKeyId as null (legacy/pre-column row)', async () => {
        await upsertExternalPlugin(sql, { ...base, signingKeyId: null });
        const row = await getExternalPlugin(sql, base.name);
        expect(row?.signingKeyId).toBeNull();
    });

    it('yields the invalid sentinel on a corrupt jsonb blob (fail closed, no throw)', async () => {
        await upsertExternalPlugin(sql, { ...base, bundle: null });
        // Hand-corrupt the jsonb to a shape that fails BundleArtifactSchema.
        await sql`UPDATE external_plugins SET bundle = ${sql.json({ entry: '../evil' })} WHERE name = ${base.name}`;
        const row = await getExternalPlugin(sql, base.name);
        expect(isInvalidBundle(row!.bundle)).toBe(true);
    });
});
