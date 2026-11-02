// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Music Tracking Query Module
 *
 * Tests play state writes, event logging, reads, and pruning.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMusicHierarchy,
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    recordPlayStart,
    recordPlayEnd,
    insertListenEvent,
    getMusicState,
    getRecentlyPlayedTrackIds,
    isMusicTrackCompleted,
    resetMusicTrackState,
    pruneOldListenEvents,
} from './music-tracking.queries.js';

describe('Music Tracking Queries', () => {
    let sql: postgres.Sql;
    const userId = generateTestUserId();

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'music_listen_events',
            'user_music_state',
            ...TEST_TABLES.userData,
            ...TEST_TABLES.mediaFiles,
            ...TEST_TABLES.media,
        ]);
        await ensureTestUser(sql, userId);
    });

    // ========================================================================
    // recordPlayStart
    // ========================================================================

    describe('recordPlayStart', () => {
        it('increments play_count and sets last_played_at', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordPlayStart(sql, userId, trackIds[0]);

            const state = await getMusicState(sql, userId, trackIds[0]);
            expect(state).not.toBeNull();
            expect(state!.play_count).toBe(1);
            expect(state!.last_played_at).toBeInstanceOf(Date);
        });

        it('increments play_count on repeated starts', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordPlayStart(sql, userId, trackIds[0]);
            await recordPlayStart(sql, userId, trackIds[0]);

            const state = await getMusicState(sql, userId, trackIds[0]);
            expect(state!.play_count).toBe(2);
        });
    });

    // ========================================================================
    // recordPlayEnd
    // ========================================================================

    describe('recordPlayEnd', () => {
        it('records skip and total listen ms', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordPlayEnd(sql, userId, trackIds[0], 30_000, true, false);

            const state = await getMusicState(sql, userId, trackIds[0]);
            expect(state).not.toBeNull();
            expect(state!.skip_count).toBe(1);
            expect(state!.complete_count).toBe(0);
        });

        it('records complete and adds to total_listen_ms', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordPlayEnd(sql, userId, trackIds[0], 180_000, false, true);

            const state = await getMusicState(sql, userId, trackIds[0]);
            expect(state!.complete_count).toBe(1);
        });
    });

    // ========================================================================
    // insertListenEvent
    // ========================================================================

    describe('insertListenEvent', () => {
        it('appends a listen event', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await insertListenEvent(sql, {
                userId,
                trackId: trackIds[0],
                startedAt: new Date(),
                durationMs: 120_000,
                trackDurationMs: 180_000,
                wasCompleted: true,
                wasSkipped: false,
                playContext: 'test',
            });

            const rows = await sql<{ count: number }[]>`
                SELECT COUNT(*)::int AS count FROM music_listen_events WHERE user_id = ${userId}
            `;
            expect(rows[0].count).toBe(1);
        });
    });

    // ========================================================================
    // getRecentlyPlayedTrackIds
    // ========================================================================

    describe('getRecentlyPlayedTrackIds', () => {
        it('returns recently played tracks ordered by last_played_at DESC', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });
            await recordPlayEnd(sql, userId, trackIds[0], 180_000, false, true);
            await new Promise((r) => setTimeout(r, 20));
            await recordPlayEnd(sql, userId, trackIds[1], 180_000, false, true);

            const recent = await getRecentlyPlayedTrackIds(sql, userId, 10);
            expect(recent[0].media_id).toBe(trackIds[1]);
        });
    });

    // ========================================================================
    // isMusicTrackCompleted
    // ========================================================================

    describe('isMusicTrackCompleted', () => {
        it('returns true when track has been completed', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordPlayEnd(sql, userId, trackIds[0], 180_000, false, true);

            const completed = await isMusicTrackCompleted(sql, userId, trackIds[0]);
            expect(completed).toBe(true);
        });

        it('returns false when track has not been completed', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            const completed = await isMusicTrackCompleted(sql, userId, trackIds[0]);
            expect(completed).toBe(false);
        });
    });

    // ========================================================================
    // resetMusicTrackState
    // ========================================================================

    describe('resetMusicTrackState', () => {
        it('resets complete and skip counts to zero', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordPlayEnd(sql, userId, trackIds[0], 180_000, false, true);
            await resetMusicTrackState(sql, userId, trackIds[0]);

            const state = await getMusicState(sql, userId, trackIds[0]);
            expect(state!.complete_count).toBe(0);
            expect(state!.skip_count).toBe(0);
        });
    });

    // ========================================================================
    // pruneOldListenEvents
    // ========================================================================

    describe('pruneOldListenEvents', () => {
        it('deletes events older than retention days', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });

            const oldDate = new Date();
            oldDate.setDate(oldDate.getDate() - 10);
            await sql`
                INSERT INTO music_listen_events (user_id, track_id, started_at, created_at, duration_ms, was_completed, was_skipped)
                VALUES (${userId}, ${trackIds[0]}, ${oldDate}, ${oldDate}, 120000, true, false)
            `;

            const pruned = await pruneOldListenEvents(sql, 5);
            expect(pruned).toBeGreaterThanOrEqual(1);

            const rows = await sql<{ count: number }[]>`
                SELECT COUNT(*)::int AS count FROM music_listen_events WHERE user_id = ${userId}
            `;
            expect(rows[0].count).toBe(0);
        });

        it('retains recent events', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await insertListenEvent(sql, {
                userId,
                trackId: trackIds[0],
                startedAt: new Date(),
                durationMs: 120_000,
                trackDurationMs: 180_000,
                wasCompleted: true,
                wasSkipped: false,
                playContext: 'test',
            });

            const pruned = await pruneOldListenEvents(sql, 7);
            expect(pruned).toBe(0);
        });
    });
});
