// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for WatchSyncEngine pull-path activity instrumentation.
 *
 * Exercises the real pull pipeline end-to-end against a live Postgres:
 *   pullWatchState → resolvePulledItems → per-chunk upsert (appendEventAndRebuild)
 *   → per-item activity rows written via recordSyncActivity.
 *
 * A fake `WatchSyncDefinition` is registered in the real registry. Its
 * `pullWatchState` returns TWO items for one seeded user:
 *   - a RESOLVABLE movie (matched by TMDB id) that is currently unwatched and
 *     reported as watched → a genuine state change → a `pull/success` row.
 *   - an UNRESOLVABLE item (unknown providerId, no tmdb/imdb match) → buffered
 *     into watch_state_pending_resolution → a `pull/skipped` row carrying the
 *     provider title, external ref, and `error: 'no library match'`.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL) pointing to a live PostgreSQL
 * with the lumastra schema applied.
 *
 * Run with:
 *   npm run test:integration src/lib/server/services/watch-sync-engine.pull-activity.integration.test.ts
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
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { getSyncActivity } from '../database/queries/watch-sync-activity.queries.js';
import { registry } from '../tasks/registry.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

// Unique across the whole registry so registration never collides with a
// builtin. providerName must contain a known EventSource substring ('trakt')
// so eventSourceForProvider() maps it — 'trakt-sync' is already a registered
// event source, so no migration is needed. providerName lowercases to the
// `provider` column value we query.
const PROVIDER_ID = 'fake-pull-activity-sync';
const PROVIDER_NAME = 'fakepulltrakt';

describe.skipIf(SKIP_TESTS)('WatchSyncEngine pull activity — integration', () => {
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

    it('writes pull/success (per committed chunk) and pull/skipped (with reason) rows', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        // A resolvable movie: seeded WITH a TMDB external id so resolvePulledItems
        // (Strategy 1) matches it. It starts unwatched (no user_media_state row),
        // so a pulled isWatched=true flips its state → a real mark_watched event.
        const { id: resolvableMediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Pull Resolvable Movie',
        });

        const RESOLVABLE_TITLE = 'Pull Resolvable Movie';

        // The fake plugin pulls two items for our one user. providerUsername is
        // the user UUID: non-Jellyfin providers self-index UUID→UUID so the
        // engine resolves it back to the same users.id.
        const resolvableItem: WatchStatePullItem = {
            providerId: 'pv-resolvable',
            tmdbId: String(tmdbId),
            imdbId: null,
            mediaType: 'movie',
            isWatched: true,
            resumePositionMs: 0,
            runtimeMs: 5_400_000,
            watchCount: 3,
            providerUsername: userId,
            title: RESOLVABLE_TITLE,
            lastWatchedAt: new Date(),
        };
        const unresolvableItem: WatchStatePullItem = {
            providerId: 'pv-unknown-no-match',
            tmdbId: null,
            imdbId: null,
            mediaType: 'movie',
            isWatched: true,
            resumePositionMs: 0,
            runtimeMs: 5_400_000,
            watchCount: 1,
            providerUsername: userId,
            title: 'Pull Unresolvable Movie',
            lastWatchedAt: new Date(),
        };

        const plugin: WatchSyncDefinition = {
            id: PROVIDER_ID,
            name: 'Fake Pull Activity Sync',
            version: '1.0.0',
            capabilities: { http: true },
            providerName: PROVIDER_NAME,
            isAvailable: async () => true,
            pullWatchState: async (): Promise<WatchSyncPullResult> => ({
                items: [resolvableItem, unresolvableItem],
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

        // Drive only our provider; pass the test DB handle explicitly so the
        // engine's own queries land on lumastra_tests.
        const results = await watchSyncEngine.runPull(PROVIDER_ID, undefined, sql);

        // Sanity: one resolved+upserted item, one skipped-no-match item.
        expect(results).toHaveLength(1);
        expect(results[0].provider).toBe(PROVIDER_ID);
        expect(results[0].totalResolved).toBe(1);
        expect(results[0].totalSkippedNoMatch).toBe(1);
        expect(results[0].totalUpserted).toBe(1);

        // The mark_watched event was actually appended (real state change).
        const [state] = await sql<Array<{ is_watched: boolean }>>`
            SELECT is_watched FROM user_media_state
            WHERE user_id = ${userId}::uuid AND media_id = ${resolvableMediaId}::uuid
        `;
        expect(state?.is_watched).toBe(true);

        const readCount = async (): Promise<number> => {
            const [row] = await sql<{ watch_count: number }[]>`
                SELECT watch_count FROM user_media_state
                WHERE user_id = ${userId} AND media_id = ${resolvableMediaId}
            `;
            return row.watch_count;
        };
        expect(await readCount()).toBe(3);
        await watchSyncEngine.runPull(PROVIDER_ID, undefined, sql);
        expect(await readCount()).toBe(3);

        const acts = await getSyncActivity(sql, { userId, provider: PROVIDER_NAME, limit: 10 });

        // pull/success for the resolvable item that changed state — title threaded
        // through UpsertItem, eventKind set to the appended event's kind.
        expect(
            acts.some(
                (a) =>
                    a.direction === 'pull' &&
                    a.outcome === 'success' &&
                    a.eventKind === 'watched' &&
                    a.title === RESOLVABLE_TITLE,
            ),
        ).toBe(true);

        // pull/skipped for the unresolvable item is HIDDEN from the user feed
        // (getSyncActivity filters 'no library match' — un-actionable noise) but
        // IS still recorded in the table for diagnostics.
        expect(acts.some((a) => a.error === 'no library match')).toBe(false);
        const [{ n }] = await sql<Array<{ n: string }>>`
            SELECT count(*)::text n FROM watch_sync_activity
            WHERE user_id = ${userId}::uuid AND provider = ${PROVIDER_NAME}
              AND outcome = 'skipped' AND error = 'no library match'
              AND external_ref = ${`${PROVIDER_NAME}:pv-unknown-no-match`}
        `;
        expect(Number(n)).toBe(1);
    });
});
