// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `freezePosition` pull-path guarantee: **a pull never moves the position of
 * an item that is playing on another device right now.**
 *
 * A 5-minute pull cycle would otherwise yank a listener backwards to whatever
 * checkpoint the upstream server last persisted. That is unfixable from inside a
 * plugin — by the time the engine appends the event the plugin is no longer in
 * the call path — which is why this lives in shared engine code.
 *
 * **Why not `isActiveSession`.** The design this implements originally called
 * for hanging the freeze off the existing `isActiveSession` flag, on the
 * understanding that no shipped provider sets it. That is false: Jellyfin sets
 * `isActiveSession: true` on every row built from its live session list
 * (`watch-sync/jellyfin.ts:628,638`), where it means the OPPOSITE of a freeze —
 * "this live row is the freshest truth, apply it over the stale persisted resume
 * value". Overloading the flag silently converts Jellyfin's live-position
 * tracking into a no-op. The two concepts got separate flags for that reason,
 * and the last test here pins the distinction so a future tidy-up cannot merge
 * them back.
 *
 * Because this changes code shared by Trakt, MAL and Jellyfin, the regression
 * half matters as much as the feature half: with `freezePosition` absent (its
 * default, and what every existing provider emits) behaviour is unchanged.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL).
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
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import { registry } from '../tasks/registry.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

// Must contain 'jellyfin' so eventSourceForProvider() maps it AND the pull takes
// the Jellyfin-specific COALESCE(jellyfin_username, username) resolution path —
// i.e. these run against a REAL existing provider, which is what makes the
// "unaffected when the flag is absent" assertions meaningful.
const PROVIDER_NAME_PREFIX = 'fakepulljellyfinfreeze';

function makePullPlugin(
    providerId: string,
    providerName: string,
    pull: () => Promise<WatchSyncPullResult>,
): WatchSyncDefinition {
    return {
        id: providerId,
        name: 'Fake Active-Session Freeze Sync',
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

describe.skipIf(SKIP_TESTS)('WatchSyncEngine pull — freezePosition', () => {
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

    /** Progress events this source wrote for the pair, oldest first. */
    const progressEvents = (userId: string, mediaId: string) =>
        sql<Array<{ position_ms: number }>>`
            SELECT position_ms FROM user_media_events
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
              AND event_type = 'progress' AND source = 'jellyfin-sync'
            ORDER BY occurred_at ASC, recorded_at ASC
        `;

    const resumePosition = async (userId: string, mediaId: string): Promise<number | null> => {
        const [row] = await sql<Array<{ resume_position_ms: number | null }>>`
            SELECT resume_position_ms FROM user_media_state
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        return row?.resume_position_ms ?? null;
    };

    it('appends no progress event and does not move the position when the item is an active session', async () => {
        const providerId = 'fake-freeze-active';
        const providerName = `${PROVIDER_NAME_PREFIX}active`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Active Session Freeze Movie',
        });

        let reportedPositionMs = 500_000;
        let active = false;
        const item = (): WatchStatePullItem => ({
            providerId: 'jf-freeze-item',
            tmdbId: String(tmdbId),
            imdbId: null,
            mediaType: 'movie',
            isWatched: false,
            resumePositionMs: reportedPositionMs,
            runtimeMs: 5_400_000,
            watchCount: 0,
            providerUsername,
            title: 'Active Session Freeze Movie',
            freezePosition: active,
        });
        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [item()],
                errors: [],
                newCursors: new Map(),
            })),
        );

        // Establish a baseline position with the flag absent-equivalent (false).
        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect(await progressEvents(userId, mediaId)).toHaveLength(1);
        expect(await resumePosition(userId, mediaId)).toBe(500_000);

        // Now the user is listening on another device: the upstream server
        // reports a STALE, EARLIER position while a session is open. Without the
        // freeze this rewinds them by ~5 minutes.
        reportedPositionMs = 200_000;
        active = true;
        await watchSyncEngine.runPull(providerId, undefined, sql);

        expect(await progressEvents(userId, mediaId)).toHaveLength(1);
        expect(await resumePosition(userId, mediaId)).toBe(500_000);
    });

    it('freezes a FORWARD move too — an active session owns the position outright', async () => {
        const providerId = 'fake-freeze-forward';
        const providerName = `${PROVIDER_NAME_PREFIX}forward`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Active Session Forward Movie',
        });

        let reportedPositionMs = 500_000;
        let active = false;
        const item = (): WatchStatePullItem => ({
            providerId: 'jf-freeze-forward-item',
            tmdbId: String(tmdbId),
            imdbId: null,
            mediaType: 'movie',
            isWatched: false,
            resumePositionMs: reportedPositionMs,
            runtimeMs: 5_400_000,
            watchCount: 0,
            providerUsername,
            title: 'Active Session Forward Movie',
            freezePosition: active,
        });
        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [item()],
                errors: [],
                newCursors: new Map(),
            })),
        );

        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect(await resumePosition(userId, mediaId)).toBe(500_000);

        reportedPositionMs = 900_000;
        active = true;
        await watchSyncEngine.runPull(providerId, undefined, sql);

        expect(await progressEvents(userId, mediaId)).toHaveLength(1);
        expect(await resumePosition(userId, mediaId)).toBe(500_000);
    });

    /**
     * The freeze is scoped to POSITION. "Finished" is a decisive fact the
     * upstream server is entitled to assert even mid-session — and for
     * audiobooks it is the signal `watch_count` is derived from, so swallowing
     * it would make re-listens uncountable.
     */
    it('still applies a decisive watched transition while an active session is open', async () => {
        const providerId = 'fake-freeze-decisive';
        const providerName = `${PROVIDER_NAME_PREFIX}decisive`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Active Session Decisive Movie',
        });

        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [
                    {
                        providerId: 'jf-freeze-decisive-item',
                        tmdbId: String(tmdbId),
                        imdbId: null,
                        mediaType: 'movie',
                        isWatched: true,
                        resumePositionMs: 0,
                        runtimeMs: 5_400_000,
                        watchCount: 1,
                        providerUsername,
                        title: 'Active Session Decisive Movie',
                        freezePosition: true,
                    } satisfies WatchStatePullItem,
                ],
                errors: [],
                newCursors: new Map(),
            })),
        );

        await watchSyncEngine.runPull(providerId, undefined, sql);

        const [row] = await sql<Array<{ is_watched: boolean }>>`
            SELECT is_watched FROM user_media_state
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        expect(row?.is_watched).toBe(true);
    });

    /**
     * The Jellyfin regression, pinned. `isActiveSession: true` must keep
     * applying the position — it is how Jellyfin tracks a live playhead. If a
     * future change routes the freeze through this flag, this test fails
     * instead of Jellyfin's live-position tracking silently going dead.
     */
    it('does NOT freeze on isActiveSession alone — that flag means the opposite', async () => {
        const providerId = 'fake-freeze-active-session-distinct';
        const providerName = `${PROVIDER_NAME_PREFIX}distinct`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Live Session Movie',
        });

        let reportedPositionMs = 500_000;
        const item = (): WatchStatePullItem => ({
            providerId: 'jf-live-session-item',
            tmdbId: String(tmdbId),
            imdbId: null,
            mediaType: 'movie',
            isWatched: false,
            resumePositionMs: reportedPositionMs,
            runtimeMs: 5_400_000,
            watchCount: 0,
            providerUsername,
            title: 'Live Session Movie',
            // Exactly what Jellyfin emits for a currently-playing item: the live
            // session row, with no freeze requested.
            isActiveSession: true,
        });
        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [item()],
                errors: [],
                newCursors: new Map(),
            })),
        );

        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect(await resumePosition(userId, mediaId)).toBe(500_000);

        // The live playhead advances — Jellyfin depends on this landing.
        reportedPositionMs = 600_000;
        await watchSyncEngine.runPull(providerId, undefined, sql);

        expect(await progressEvents(userId, mediaId)).toHaveLength(2);
        expect(await resumePosition(userId, mediaId)).toBe(600_000);
    });

    /**
     * Regression guard for every existing provider. `freezePosition` is optional
     * and no shipped plugin sets it, so an item WITHOUT the field must behave
     * exactly as before: positions keep moving on every genuine change.
     */
    it('leaves providers that never set the flag completely unaffected', async () => {
        const providerId = 'fake-freeze-absent';
        const providerName = `${PROVIDER_NAME_PREFIX}absent`;
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Flag Absent Movie',
        });

        let reportedPositionMs = 500_000;
        // NB: `isActiveSession` is deliberately not present on this object at
        // all — not `false`. That is the exact shape Trakt/MAL/Jellyfin emit.
        const item = (): WatchStatePullItem => ({
            providerId: 'jf-freeze-absent-item',
            tmdbId: String(tmdbId),
            imdbId: null,
            mediaType: 'movie',
            isWatched: false,
            resumePositionMs: reportedPositionMs,
            runtimeMs: 5_400_000,
            watchCount: 0,
            providerUsername,
            title: 'Flag Absent Movie',
        });
        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [item()],
                errors: [],
                newCursors: new Map(),
            })),
        );

        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect(await progressEvents(userId, mediaId)).toHaveLength(1);
        expect(await resumePosition(userId, mediaId)).toBe(500_000);

        // A genuine forward move still lands, and a repeat still converges.
        reportedPositionMs = 505_000;
        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect(await progressEvents(userId, mediaId)).toHaveLength(2);
        expect(await resumePosition(userId, mediaId)).toBe(505_000);

        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect(await progressEvents(userId, mediaId)).toHaveLength(2);
    });
});
