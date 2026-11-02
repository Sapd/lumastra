// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test reproducing the prod watch-sync pull loop bug and
 * proving the fix.
 *
 * Root cause: `pullForProvider`'s change-detection compared the sync
 * source's freshly-reported value against Lumastra's DERIVED
 * `user_media_state` instead of what that SAME SOURCE last reported.
 * The derived state is arbitrated across every source and the
 * rebuilder's own transforms, so it can permanently diverge from any one
 * source's raw reports — and a comparison against a value that never
 * converges re-appends the same `progress` (and sometimes
 * `mark_unwatched`) event on every single pull cycle, forever. Confirmed
 * in prod: one user accumulated 1455 and 687 redundant `progress` rows
 * for two stuck episodes.
 *
 * Exercises the real pull pipeline end-to-end against a live Postgres:
 *   pullWatchState → resolvePulledItems → per-chunk upsert
 *   (getSourceSnapshotsForMedia + appendEventAndRebuild).
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL) pointing to a live PostgreSQL
 * with the lumastra schema applied.
 *
 * Run with:
 *   npm run test:integration src/lib/server/services/watch-sync-engine.pull-progress-convergence.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
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
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import { appendEventAndRebuild } from './watch-state-rebuilder.service.js';
import type { NewUserMediaEvent } from '../database/queries/user-media-events.queries.js';
import type { UserId } from '$lib/shared/user-id.js';
import { registry } from '../tasks/registry.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';
import { LoggerInstance } from '../utils/logger.js';

vi.mock('./notification-events.service.js', () => ({ publishUserEvent: vi.fn(async () => {}) }));
import { publishUserEvent } from './notification-events.service.js';
import { watchStateEvents } from './watch-state-events.service.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

// providerName must contain a known EventSource substring so
// eventSourceForProvider() maps it, AND contain 'jellyfin' specifically —
// the pull's per-user resolution takes the Jellyfin-specific username path
// (COALESCE(jellyfin_username, username)) whenever providerName includes
// 'jellyfin', which is the exact prod code path this bug came from.
//
// Each test registers its own provider id/name (suffixed) because
// `TaskRegistry.registerWatchSync` throws on a duplicate id and the
// registry has no unregister — reusing one id across tests in this file
// would collide on the second `describe`/`it`.
const PROVIDER_NAME_PREFIX = 'fakepulljellyfinloop';

/** Un-pushed decisive mark_watched event from a HIGHER-priority source
 * (lumastra-user-mark, priority 100) than jellyfin-sync (priority 10) —
 * used to pin `is_watched = true` regardless of what jellyfin-sync later
 * reports, reproducing the "higher-confidence source keeps it watched"
 * half of the prod bug. */
function lumastraMarkWatchedEvent(userId: UserId, mediaId: string): NewUserMediaEvent {
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

/** A prior jellyfin-sync mark_unwatched — establishes that this SOURCE has
 * already reported "not watched" once, so the fixed gate must not re-fire
 * mark_unwatched every cycle even though `is_watched` stays pinned `true`
 * (by the higher-priority event above). */
function jellyfinUnwatchedEvent(userId: UserId, mediaId: string): NewUserMediaEvent {
    return {
        user_id: userId,
        media_id: mediaId,
        event_type: 'mark_unwatched',
        source: 'jellyfin-sync',
        position_ms: null,
        runtime_ms: 5_400_000,
        source_event_id: null,
        session_id: null,
        event_seq: null,
        occurred_at: new Date().toISOString(),
    };
}

function makePullPlugin(
    providerId: string,
    providerName: string,
    pull: () => Promise<WatchSyncPullResult>,
): WatchSyncDefinition {
    return {
        id: providerId,
        name: 'Fake Pull Progress Loop Sync',
        version: '1.0.0',
        capabilities: { http: true },
        providerName,
        isAvailable: async () => true,
        pullWatchState: pull,
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
}

describe.skipIf(SKIP_TESTS)('WatchSyncEngine pull progress convergence — integration', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterEach(() => { watchStateEvents.__resetForTests(); });

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

    it.each(['jellyfin', 'trakt', 'audiobookshelf'])(
        'publishes a user event for a committed %s import, but not an unchanged pull',
        async (providerName) => {
            watchStateEvents.__resetForTests();
            vi.mocked(publishUserEvent).mockClear();
            const providerId = `live-refresh-${providerName}`;
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
                title: 'Live import refresh',
            });
            registry.registerWatchSync(
                makePullPlugin(providerId, providerName, async () => ({
                    items: [
                        {
                            providerId: 'live-item',
                            tmdbId: String(tmdbId),
                            imdbId: null,
                            mediaType: 'movie',
                            isWatched: true,
                            resumePositionMs: 0,
                            runtimeMs: 5_400_000,
                            watchCount: 1,
                            providerUsername:
                                providerName === 'jellyfin' ? derivedUsername(userId) : userId,
                        },
                    ],
                    errors: [],
                })),
            );
            await watchSyncEngine.runPull(providerId, undefined, sql);
            const [state] = await sql`SELECT is_watched FROM user_media_state
                WHERE user_id = ${userId} AND media_id = ${mediaId}`;
            expect(state?.is_watched).toBe(true);
            await vi.waitFor(
                () =>
                    expect(publishUserEvent).toHaveBeenCalledWith(
                        expect.objectContaining({
                            userId,
                            kind: 'watch_state_set_changed',
                            persist: false,
                        }),
                    ),
                { timeout: 5000 },
            );
            vi.mocked(publishUserEvent).mockClear();
            await watchSyncEngine.runPull(providerId, undefined, sql);
            await new Promise((resolve) => setTimeout(resolve, 1200));
            expect(publishUserEvent).not.toHaveBeenCalled();
            watchStateEvents.__resetForTests();
        },
    );

    it('converges on an unchanged Jellyfin position and emits exactly one event for a genuine move', async () => {
        const providerId = 'fake-pull-progress-loop-sync-convergence';
        const providerName = `${PROVIDER_NAME_PREFIX}convergence`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        // Matches the username ensureTestUser mints (see user.fixtures.ts) so
        // the Jellyfin-specific COALESCE(jellyfin_username, username) lookup
        // resolves this provider login back to `userId`.
        const providerUsername = derivedUsername(userId);

        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Progress Convergence Movie',
        });

        let reportedPositionMs = 500_000;
        const item = (): WatchStatePullItem => ({
            providerId: 'jf-progress-item',
            tmdbId: String(tmdbId),
            imdbId: null,
            mediaType: 'movie',
            isWatched: false,
            resumePositionMs: reportedPositionMs,
            runtimeMs: 5_400_000,
            watchCount: 0,
            providerUsername,
            title: 'Progress Convergence Movie',
        });
        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [item()],
                errors: [],
                newCursors: new Map(),
            })),
        );

        const progressEvents = async () =>
            sql<Array<{ position_ms: number }>>`
                SELECT position_ms FROM user_media_events
                WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
                  AND event_type = 'progress' AND source = 'jellyfin-sync'
                ORDER BY occurred_at ASC, recorded_at ASC
            `;

        // Cycle 1: first-ever report at P=500000 -> exactly one progress event.
        await watchSyncEngine.runPull(providerId, undefined, sql);
        let events = await progressEvents();
        expect(events).toHaveLength(1);
        expect(events[0]?.position_ms).toBe(500_000);

        // Cycle 2: Jellyfin reports the SAME position again (the exact loop
        // repro) -> must NOT append a second progress event.
        await watchSyncEngine.runPull(providerId, undefined, sql);
        events = await progressEvents();
        expect(events).toHaveLength(1);

        // Cycle 3: a genuine forward move (P -> P+5000, past the 1000ms
        // tolerance) -> exactly one NEW progress event.
        reportedPositionMs = 505_000;
        await watchSyncEngine.runPull(providerId, undefined, sql);
        events = await progressEvents();
        expect(events).toHaveLength(2);
        expect(events[1]?.position_ms).toBe(505_000);

        // Cycle 4: unchanged again at the new position -> still converged.
        await watchSyncEngine.runPull(providerId, undefined, sql);
        events = await progressEvents();
        expect(events).toHaveLength(2);
        // Position-only imports must wake an already-open Home as well as
        // watched flags. The shared publisher works without local listeners.
        await vi.waitFor(() => expect(publishUserEvent).toHaveBeenCalledWith(
            expect.objectContaining({ userId, kind: 'watch_state_set_changed', persist: false }),
        ), { timeout: 5000 });
    });

    it('does not re-open a Lumastra-watched item as in-progress from a stale Jellyfin resume position', async () => {
        const providerId = 'fake-pull-progress-loop-sync-pinned';
        const providerName = `${PROVIDER_NAME_PREFIX}pinned`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Pinned Watched Movie',
        });

        // Steady-state setup reproducing the prod bug's exact fixture:
        //   - a higher-priority source (lumastra-user-mark) has this item
        //     definitively watched, and keeps winning arbitration forever.
        //   - jellyfin-sync already reported "not watched" once in the past
        //     (so the mark_unwatched gate has already converged and must
        //     not re-fire).
        expect(await appendEventAndRebuild(sql, lumastraMarkWatchedEvent(userId, mediaId))).toBe(
            true,
        );
        expect(await appendEventAndRebuild(sql, jellyfinUnwatchedEvent(userId, mediaId))).toBe(
            true,
        );

        const [stateBefore] = await sql<Array<{ is_watched: boolean }>>`
            SELECT is_watched FROM user_media_state
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        expect(stateBefore?.is_watched).toBe(true);

        // Jellyfin keeps reporting this item as not-watched with a resume
        // position every cycle (the prod fixture: is_watched=true derived,
        // but Jellyfin still reports ~300000ms).
        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [
                    {
                        providerId: 'jf-pinned-item',
                        tmdbId: String(tmdbId),
                        imdbId: null,
                        mediaType: 'movie',
                        isWatched: false,
                        resumePositionMs: 300_000,
                        runtimeMs: 5_400_000,
                        watchCount: 0,
                        providerUsername,
                        title: 'Pinned Watched Movie',
                    },
                ],
                errors: [],
                newCursors: new Map(),
            })),
        );

        await watchSyncEngine.runPull(providerId, undefined, sql);

        const events = await sql<Array<{ event_type: string; source: string }>>`
            SELECT event_type, source FROM user_media_events
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
              AND source = 'jellyfin-sync'
            ORDER BY occurred_at ASC, recorded_at ASC
        `;
        // Only the ONE mark_unwatched event seeded in setup — no new
        // mark_unwatched churn, and no progress event at all.
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ event_type: 'mark_unwatched', source: 'jellyfin-sync' });

        const [stateAfter] = await sql<Array<{ is_watched: boolean; resume_position_ms: number }>>`
            SELECT is_watched, resume_position_ms FROM user_media_state
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        expect(stateAfter?.is_watched).toBe(true);
        expect(stateAfter?.resume_position_ms).toBe(0);
    });

    it('reports an auto-complete once, not again on every pull after the item is watched here', async () => {
        const providerId = 'fake-pull-progress-loop-sync-autocomplete';
        const providerName = `${PROVIDER_NAME_PREFIX}autocomplete`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);
        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Nearly Finished Movie',
        });

        // Jellyfin never marks it played and keeps a 98% resume point — the
        // prod shape that logged the same items every 5 minutes.
        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [
                    {
                        providerId: 'jf-nearly-finished',
                        tmdbId: String(tmdbId),
                        imdbId: null,
                        mediaType: 'movie',
                        isWatched: false,
                        resumePositionMs: 5_300_000,
                        runtimeMs: 5_400_000,
                        watchCount: 0,
                        providerUsername,
                        title: 'Nearly Finished Movie',
                    },
                ],
                errors: [],
                newCursors: new Map(),
            })),
        );
        const info = vi.spyOn(LoggerInstance.prototype, 'info');
        const autoCompleteLines = () =>
            info.mock.calls.filter(([message]) =>
                String(message).startsWith('Provider sync: auto-complet'),
            ).length;

        try {
            await watchSyncEngine.runPull(providerId, undefined, sql);
            // The line plus the summary, once.
            expect(autoCompleteLines()).toBe(2);
            const [state] = await sql<Array<{ is_watched: boolean }>>`
                SELECT is_watched FROM user_media_state
                WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
            `;
            expect(state?.is_watched).toBe(true);

            info.mockClear();
            await watchSyncEngine.runPull(providerId, undefined, sql);
            await watchSyncEngine.runPull(providerId, undefined, sql);
            expect(autoCompleteLines()).toBe(0);
        } finally {
            info.mockRestore();
        }
    });

    it('marks an item watched once, not every pull, when a higher-priority verdict keeps it unwatched', async () => {
        const providerId = 'fake-pull-progress-loop-sync-watch-converge';
        const providerName = `${PROVIDER_NAME_PREFIX}watchconverge`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);
        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Stopped In The Credits',
        });

        // The prod shape: a higher-priority verdict pins the item unwatched
        // (on prod a compaction snapshot attributes is_watched=false to
        // lumastra-player), so jellyfin-sync's auto-completed mark_watched
        // loses arbitration on every pull and the derived state never flips.
        expect(
            await appendEventAndRebuild(sql, {
                user_id: userId,
                media_id: mediaId,
                event_type: 'mark_unwatched',
                source: 'lumastra-user-mark',
                position_ms: null,
                runtime_ms: 5_400_000,
                source_event_id: null,
                session_id: null,
                event_seq: null,
                occurred_at: new Date(Date.now() - 86_400_000).toISOString(),
            }),
        ).toBe(true);

        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [
                    {
                        providerId: 'jf-credits',
                        tmdbId: String(tmdbId),
                        imdbId: null,
                        mediaType: 'movie',
                        isWatched: false,
                        resumePositionMs: 5_300_000,
                        runtimeMs: 5_400_000,
                        watchCount: 0,
                        providerUsername,
                        title: 'Stopped In The Credits',
                    },
                ],
                errors: [],
                newCursors: new Map(),
            })),
        );

        for (let cycle = 0; cycle < 3; cycle++) {
            await watchSyncEngine.runPull(providerId, undefined, sql);
        }

        const [{ count }] = await sql<Array<{ count: number }>>`
            SELECT count(*)::int AS count FROM user_media_events
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
              AND source = 'jellyfin-sync' AND event_type = 'mark_watched'
        `;
        expect(count).toBe(1);
    });
});
