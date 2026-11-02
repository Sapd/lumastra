// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test — music play_count rapid-fire skip+restart (Test 10).
 *
 * Simulates a user rapidly skipping track T three times then completing it.
 * After four play-starts and four play-ends, user_music_state must show:
 *   play_count = 4   (incremented on every recordPlayStart)
 *   skip_count = 3   (incremented on each wasSkipped=true recordPlayEnd)
 *   complete_count = 1 (incremented on the final wasCompleted=true recordPlayEnd)
 *
 * Verifies the invariant from project_play_count_semantics.md:
 *   play_count increments on EVERY attempt incl. skips
 *   skip_count is a subset of play_count
 *   complete_count is a subset of play_count
 *
 * Requires TEST_DATABASE_URL (skipped otherwise).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createAndInsertTestMusicHierarchy,
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';
import { recordPlayStart, recordPlayEnd, getMusicState } from './music-tracking.queries.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const RUN = Boolean(TEST_DATABASE_URL);

describe.runIf(RUN)('Music tracking — rapid-fire skip+restart', () => {
    let sql: Sql;
    const TEST_USER_ID = generateTestUserId();

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM user_music_state LIMIT 0`;
        } catch (e) {
            throw new Error(
                `user_music_state table missing — run db:test:migrate first. ${(e as Error).message}`,
                { cause: e },
            );
        }
    }, 30_000);

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Isolate each test: wipe this user's music state.
        await sql`DELETE FROM user_music_state WHERE user_id = ${TEST_USER_ID}`;
        await sql`DELETE FROM music_listen_events WHERE user_id = ${TEST_USER_ID}`;
    });

    it('play_count=4, skip_count=3, complete_count=1 after three rapid skips + one completion', async () => {
        // Set up a real media_items track via the music hierarchy fixture.
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Rapid Fire Artist',
            albumTitle: 'Rapid Fire Album',
            trackCount: 1,
        });
        const trackId = trackIds[0];
        expect(trackId).toBeDefined();

        // Ensure the test user profile row exists (user.fixtures.ts).
        await ensureTestUser(sql, TEST_USER_ID);

        // --- Play 1: start → skip ---
        await recordPlayStart(sql, TEST_USER_ID, trackId);
        await recordPlayEnd(sql, TEST_USER_ID, trackId, 2_000, true, false);

        // --- Play 2: start → skip ---
        await recordPlayStart(sql, TEST_USER_ID, trackId);
        await recordPlayEnd(sql, TEST_USER_ID, trackId, 2_000, true, false);

        // --- Play 3: start → skip ---
        await recordPlayStart(sql, TEST_USER_ID, trackId);
        await recordPlayEnd(sql, TEST_USER_ID, trackId, 2_000, true, false);

        // --- Play 4: start → complete ---
        await recordPlayStart(sql, TEST_USER_ID, trackId);
        await recordPlayEnd(sql, TEST_USER_ID, trackId, 180_000, false, true);

        // Assert final aggregated state.
        const state = await getMusicState(sql, TEST_USER_ID, trackId);
        expect(state).not.toBeNull();
        if (!state) return;

        expect(state.play_count).toBe(4);
        expect(state.skip_count).toBe(3);
        expect(state.complete_count).toBe(1);

        // Invariant: play_count ≥ skip_count + complete_count
        // (a single play cannot simultaneously be a skip AND a complete)
        expect(state.play_count).toBeGreaterThanOrEqual(state.skip_count + state.complete_count);
    }, 30_000);

    it('play_count reflects every recordPlayStart call, even without a matching recordPlayEnd', async () => {
        // Simulates app crash or tab close before playback ends.
        const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
            artistTitle: 'Orphaned Start Artist',
            trackCount: 1,
        });
        const trackId = trackIds[0];
        await ensureTestUser(sql, TEST_USER_ID);

        // Two starts with no ends (crash scenario).
        await recordPlayStart(sql, TEST_USER_ID, trackId);
        await recordPlayStart(sql, TEST_USER_ID, trackId);

        const state = await getMusicState(sql, TEST_USER_ID, trackId);
        expect(state).not.toBeNull();
        // Both starts must have incremented play_count.
        expect(state!.play_count).toBe(2);
        // No ends were recorded.
        expect(state!.skip_count).toBe(0);
        expect(state!.complete_count).toBe(0);
    }, 30_000);
});
