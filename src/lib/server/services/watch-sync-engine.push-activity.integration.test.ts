// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for WatchSyncEngine push-path activity instrumentation.
 *
 * Exercises the real push pipeline end-to-end against a live Postgres:
 *   getUnpushedLumastraItems → resolveIds → pushWatchState → per-outcome
 *   activity rows written via recordSyncActivity.
 *
 * A fake `WatchSyncDefinition` is registered in the real registry. It resolves
 * both seeded media to provider IDs, then reports one (user, media) pair as a
 * genuine success and the other as a transient failure (via `failedItems`).
 * The test asserts a `push/success` row AND a `push/failed` row carrying the
 * plugin's error string and transient (`terminal=false`) verdict land in
 * `watch_sync_activity`.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL) pointing to a live PostgreSQL
 * with the lumastra schema applied.
 *
 * Run with:
 *   npm run test:integration src/lib/server/services/watch-sync-engine.push-activity.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type {
    WatchSyncDefinition,
    WatchSyncResolveItem,
    WatchStateChange,
    WatchSyncPushResult,
} from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { appendEventAndRebuild } from './watch-state-rebuilder.service.js';
import type { NewUserMediaEvent } from '../database/queries/user-media-events.queries.js';
import type { UserId } from '$lib/shared/user-id.js';
import { getSyncActivity } from '../database/queries/watch-sync-activity.queries.js';
import { registry } from '../tasks/registry.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

// Unique across the whole registry so registration never collides with a
// builtin. providerName lowercases to the `provider` column value we query.
const PROVIDER_ID = 'fake-push-activity-sync';
const PROVIDER_NAME = 'fakepushactivity';

/** Un-pushed decisive mark_watched event → is_watched=true derived state. */
function markWatchedEvent(userId: UserId, mediaId: string): NewUserMediaEvent {
    return {
        user_id: userId,
        media_id: mediaId,
        event_type: 'mark_watched',
        source: 'lumastra-user-mark',
        position_ms: null,
        runtime_ms: 5_400_000,
        source_event_id: null,
        session_id: null,
        event_seq: null,
        occurred_at: new Date().toISOString(),
    };
}

describe.skipIf(SKIP_TESTS)('WatchSyncEngine push activity — integration', () => {
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
            'user_media_events',
            'user_media_state',
            'user_media_flags',
            'media_items',
            'external_ids',
            'user_profiles',
        ]);
    });

    it('writes push/success and push/failed rows with error+terminal', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        // Two watched movies with un-pushed decisive events. Neither has an
        // external_id for our provider, so the engine falls to plugin.resolveIds.
        const { id: okMediaId } = await createAndInsertTestMovie(sql, { title: 'Push OK Movie' });
        const { id: boomMediaId } = await createAndInsertTestMovie(sql, {
            title: 'Push Boom Movie',
        });

        expect(await appendEventAndRebuild(sql, markWatchedEvent(userId, okMediaId))).toBe(true);
        expect(await appendEventAndRebuild(sql, markWatchedEvent(userId, boomMediaId))).toBe(true);

        // Fake plugin: resolves every item to a provider id, then reports the
        // OK item as a genuine success and the BOOM item as a transient failure.
        const plugin: WatchSyncDefinition = {
            id: PROVIDER_ID,
            name: 'Fake Push Activity Sync',
            version: '1.0.0',
            capabilities: { http: true },
            providerName: PROVIDER_NAME,
            isAvailable: async () => true,
            resolveIds: async (_ctx, items: WatchSyncResolveItem[]) =>
                items.map((it) => ({ mediaId: it.mediaId, providerId: `pv-${it.mediaId}` })),
            pushWatchState: async (
                _ctx,
                changes: WatchStateChange[],
            ): Promise<WatchSyncPushResult> => {
                const successful = changes
                    .filter((c) => c.mediaId === okMediaId)
                    .map((c) => ({ username: c.username, mediaId: c.mediaId }));
                const failedItems = changes
                    .filter((c) => c.mediaId === boomMediaId)
                    .map((c) => ({
                        username: c.username,
                        mediaId: c.mediaId,
                        error: 'boom',
                        terminal: false,
                    }));
                return {
                    succeeded: successful.length,
                    failed: failedItems.length,
                    skipped: 0,
                    staleIds: [],
                    errors: [],
                    successful,
                    drainedAsSkipped: [],
                    failedItems,
                };
            },
        };

        registry.registerWatchSync(plugin);

        // Drive only our provider; pass the test DB handle explicitly so the
        // engine's own queries land on lumastra_tests.
        const results = await watchSyncEngine.runPush(PROVIDER_ID, undefined, sql);

        // Sanity: the engine reported one success and one transient failure.
        expect(results).toHaveLength(1);
        expect(results[0].providerId).toBe(PROVIDER_ID);
        expect(results[0].succeeded).toBe(1);
        expect(results[0].failed).toBe(1);

        const acts = await getSyncActivity(sql, { userId, provider: PROVIDER_NAME, limit: 10 });

        expect(acts.some((a) => a.direction === 'push' && a.outcome === 'success')).toBe(true);
        expect(
            acts.some(
                (a) =>
                    a.direction === 'push' &&
                    a.outcome === 'failed' &&
                    a.error === 'boom' &&
                    a.terminal === false,
            ),
        ).toBe(true);
    });
});
