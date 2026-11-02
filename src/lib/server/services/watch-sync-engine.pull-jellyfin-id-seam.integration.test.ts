// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test for the Jellyfin watch sync after the API stopped using Jellyfin
 * item ids anywhere else: a watched mark pulled from Jellyfin, identified ONLY
 * by its Jellyfin item id (no TMDB/IMDB id on the pulled item), must still land
 * on the right internal item via the `external_ids` rows with provider
 * 'jellyfin' that the sync keeps.
 *
 * Real pull pipeline against Postgres: pullWatchState → resolvePulledItems
 * (provider-id cache: external_ids provider='jellyfin') → appendEventAndRebuild.
 * The fake provider's `providerName` is 'jellyfin', so the engine takes the
 * Jellyfin branches (login-name user mapping, jellyfin provider namespace).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type {
    WatchSyncDefinition,
    WatchStatePullItem,
    WatchSyncPullResult,
} from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    derivedUsername,
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { registry } from '../tasks/registry.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

const PROVIDER_ID = 'fake-jellyfin-id-seam-sync';
const PROVIDER_NAME = 'jellyfin';

describe.skipIf(SKIP_TESTS)('Jellyfin pull — mapping by Jellyfin item id (seam)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'watch_sync_activity',
            'watch_state_pending_resolution',
            'watch_state_pull_log',
            'user_media_events',
            'user_media_state',
            'user_media_flags',
            'media_items',
            'external_ids',
            'user_profiles',
        ]);
    });

    it('applies a pulled watched mark to the internal item that owns the Jellyfin id', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const jellyfinId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
        const { id: targetId } = await createAndInsertTestMovie(sql, {
            title: 'Seam Target Movie',
            jellyfinId,
        });
        // A decoy with its own (different) Jellyfin id: the mark must not land here.
        const { id: decoyId } = await createAndInsertTestMovie(sql, {
            title: 'Seam Decoy Movie',
            jellyfinId: 'ffffffffffffffffffffffffffffffff',
        });

        const pulled: WatchStatePullItem = {
            providerId: jellyfinId,
            // Only the Jellyfin id identifies the item.
            tmdbId: null,
            imdbId: null,
            mediaType: 'movie',
            isWatched: true,
            resumePositionMs: 0,
            runtimeMs: 5_400_000,
            watchCount: 1,
            // Jellyfin providers send the Jellyfin login name; with no override it
            // is the Lumastra username.
            providerUsername: derivedUsername(userId),
            title: 'Seam Target Movie',
            lastWatchedAt: new Date(),
        };

        const plugin: WatchSyncDefinition = {
            id: PROVIDER_ID,
            name: 'Fake Jellyfin Id Seam Sync',
            version: '1.0.0',
            capabilities: { http: true },
            providerName: PROVIDER_NAME,
            isAvailable: async () => true,
            pullWatchState: async (): Promise<WatchSyncPullResult> => ({
                items: [pulled],
                errors: [],
                newCursors: new Map<string, string>(),
            }),
            resolveIds: async () => [],
            pushWatchState: async () => ({
                succeeded: 0,
                failed: 0,
                skipped: 0,
                staleIds: [],
                errors: [],
                successful: [],
                drainedAsSkipped: [],
            }),
        };
        registry.registerWatchSync(plugin);

        const results = await watchSyncEngine.runPull(PROVIDER_ID, undefined, sql);

        expect(results).toHaveLength(1);
        expect(results[0].totalResolved).toBe(1);
        expect(results[0].totalUpserted).toBe(1);

        const rows = await sql<Array<{ media_id: string; is_watched: boolean }>>`
            SELECT media_id::text AS media_id, is_watched FROM user_media_state
            WHERE user_id = ${userId}::uuid
        `;
        expect(rows).toEqual([{ media_id: targetId, is_watched: true }]);
        expect(rows.some((r) => r.media_id === decoyId)).toBe(false);

        // The Jellyfin mapping rows the sync relies on are untouched.
        const [{ n }] = await sql<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM external_ids WHERE provider = 'jellyfin'
        `;
        expect(n).toBe(2);
    });
});
