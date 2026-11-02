// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration coverage for listExternalPluginsWithState against lumastra_tests.
 *
 * In the integration process NOTHING is registered on the task registry, so every
 * seeded row reports loaded:false — the `uninstalled && loaded` pending-restart
 * card is covered by the unit test (registry mocked). Here we assert the joined
 * shape, the uninstalled-and-gone filter, and the fail-closed bundle surfacing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { upsertExternalPlugin } from '$lib/server/database/queries/external-plugins.queries.js';
import type { BundleArtifact } from '$lib/server/plugins/external-install/bundle-artifact.js';
import {
    listExternalPluginsWithState,
    disableExternalPlugin,
    uninstallExternalPlugin,
    enableExternalPlugin,
} from './external-plugin-manager.service.js';
import { getAttention, ackAttention, snoozeAttention } from './attention/attention-service.js';
import { registry } from '$lib/server/tasks/registry.js';

let sql: postgres.Sql;

interface SeedOver {
    name: string;
    enabled?: boolean;
    status?: 'installed' | 'uninstalled';
    capabilities?: Record<string, unknown> | null;
    bundle?: BundleArtifact | null;
    signingKeyId?: string | null;
}

const seed = (over: SeedOver): Promise<void> =>
    upsertExternalPlugin(sql, {
        name: over.name,
        version: '1.0.0',
        checksum: 'c'.repeat(64),
        sourceManifestUrl: 'https://example.com/m',
        signature: 'sig',
        capabilities: over.capabilities ?? null,
        enabled: over.enabled ?? true,
        status: over.status ?? 'installed',
        installedBy: 'tester',
        bundle: over.bundle ?? null,
        signingKeyId: over.signingKeyId ?? null,
    });

beforeAll(() => {
    sql = getTestDb() as unknown as postgres.Sql;
});
afterAll(async () => {
    vi.restoreAllMocks();
    await sql`DELETE FROM external_plugins WHERE name LIKE 'itest-%'`;
    await closeTestDb();
});
beforeEach(async () => {
    vi.restoreAllMocks();
    await sql`DELETE FROM external_plugins WHERE name LIKE 'itest-%'`;
});

describe('listExternalPluginsWithState (integration)', () => {
    it('joins registry rows with live (empty) loader state and filters gone rows', async () => {
        await seed({ name: 'itest-enabled', enabled: true });
        await seed({ name: 'itest-disabled', enabled: false });
        await seed({ name: 'itest-keyed', signingKeyId: 'some-key' });
        await seed({
            name: 'itest-bundle',
            bundle: {
                entry: 'index.js',
                treeDigest: 'a'.repeat(64),
                files: [{ path: 'index.js', sha256: 'b'.repeat(64), size: 10 }],
            },
        });
        await seed({ name: 'itest-gone', status: 'uninstalled', enabled: false });

        const { items, trustedKeysConfigured } = await listExternalPluginsWithState(sql);
        const mine = items.filter((i) => i.id.startsWith('itest-'));
        const ids = mine.map((i) => i.id);

        // uninstalled AND not-loaded (nothing registered in the test process) → filtered out
        expect(ids).not.toContain('itest-gone');
        expect(ids).toContain('itest-enabled');
        expect(ids).toContain('itest-disabled');

        const enabled = mine.find((i) => i.id === 'itest-enabled')!;
        expect(enabled.loaded).toBe(false);
        expect(enabled.restartRequired).toBe(true); // enabled && !loaded

        const disabled = mine.find((i) => i.id === 'itest-disabled')!;
        expect(disabled.restartRequired).toBe(false); // !enabled && !loaded

        const bundle = mine.find((i) => i.id === 'itest-bundle')!;
        expect(bundle.isBundle).toBe(true);
        expect(bundle.bundleInvalid).toBe(false);

        expect(typeof trustedKeysConfigured).toBe('boolean');
    });

    it('surfaces a hand-corrupted bundle jsonb as bundleInvalid without throwing (spec §8)', async () => {
        // upsertExternalPlugin only accepts a typed BundleArtifact, so corrupt the
        // stored jsonb directly — parseBundle() must yield INVALID_BUNDLE and the
        // manager must report bundleInvalid:true (fail-closed) rather than crash.
        await seed({ name: 'itest-corrupt' });
        await sql`UPDATE external_plugins SET bundle = '"garbage"'::jsonb WHERE name = 'itest-corrupt'`;

        const { items } = await listExternalPluginsWithState(sql);
        const corrupt = items.find((i) => i.id === 'itest-corrupt')!;
        expect(corrupt).toBeDefined();
        expect(corrupt.bundleInvalid).toBe(true);
        expect(corrupt.isBundle).toBe(false);
    });
});

describe('plugin lifecycle attention without a derivation task', () => {
    const notice = async () =>
        (await getAttention(sql)).items.find((item) => item.id === 'settings:plugin-restart');

    it.each(['disable', 'uninstall'] as const)(
        '%s stays visible across repeated requests and retries until running code is gone',
        async (action) => {
            await seed({ name: 'itest-running' });
            const loaded = vi
                .spyOn(registry, 'hasPluginRegistered')
                .mockImplementation((id) => id === 'itest-running');
            expect(await notice()).toBeUndefined();
            const mutate = action === 'disable' ? disableExternalPlugin : uninstallExternalPlugin;
            await mutate(sql, 'itest-running', null);
            const first = await notice();
            expect(first).toMatchObject({
                domain: 'plugins',
                severity: 'warning',
                acked: false,
                sourceRef: '/admin/settings/plugins',
            });
            expect(first?.detail).toMatch(/still running/i);
            expect(first?.detail).toMatch(/restart/i);
            await mutate(sql, 'itest-running', null);
            expect(await notice()).toMatchObject({ fingerprint: first!.fingerprint });
            // Reject before touching the alert table: this notice is derived from saved plugin intent.
            expect(await ackAttention({} as never, first!.id, first!.fingerprint, 'tester')).toBe(
                false,
            );
            expect(await snoozeAttention({} as never, first!.id, first!.fingerprint, 60_000)).toBe(
                false,
            );
            expect(await notice()).toMatchObject({ acked: false });
            // A process that has restarted reads the same saved intent but has no loaded code.
            loaded.mockReturnValue(false);
            expect(await notice()).toBeUndefined();
        },
    );

    it('clears immediately when enabling an already loaded plugin restores agreement', async () => {
        await seed({ name: 'itest-running', enabled: false });
        vi.spyOn(registry, 'hasPluginRegistered').mockImplementation(
            (id) => id === 'itest-running',
        );
        expect(await notice()).toBeDefined();
        await enableExternalPlugin(sql, 'itest-running', null);
        expect(await notice()).toBeUndefined();
    });

    it('reports enabled but unloaded plugins without leaking stored URL credentials or keys', async () => {
        await seed({ name: 'itest-waiting' });
        await sql`UPDATE external_plugins SET source_manifest_url = 'https://user:secret-password@example.com/manifest?key=secret-key', signature = 'secret-signature' WHERE name = 'itest-waiting'`;
        const board = await getAttention(sql);
        const item = board.items.find((i) => i.id === 'settings:plugin-restart');
        expect(item).toBeDefined();
        expect(board.unreadCount).toBeGreaterThanOrEqual(1);
        expect(board.verdict).not.toBe('healthy');
        expect(JSON.stringify(item)).not.toMatch(/secret-password|secret-key|secret-signature/);
    });

    it('does not ask for a restart when disabled code was never loaded', async () => {
        await seed({ name: 'itest-disabled', enabled: false });
        expect(await notice()).toBeUndefined();
    });
});
