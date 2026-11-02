// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Music Interactions Query Module
 *
 * Tests like/dislike/skip/complete recordings and feedback reads.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
    createAndInsertTestMusicHierarchy,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    recordTrackLike,
    recordTrackDislike,
    recordTrackSkip,
    recordTrackComplete,
    getTrackFeedback,
    clearTrackLike,
    clearTrackDislike,
} from './music-interactions.queries.js';

import { MUSIC_FEEDBACK_LIKE_RATING } from '$lib/server/services/music/feedback';

describe('Music Interactions Queries', () => {
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
            ...TEST_TABLES.userData,
            ...TEST_TABLES.mediaFiles,
            ...TEST_TABLES.media,
        ]);
        await ensureTestUser(sql, userId);
    });

    it.each([
        ['like', recordTrackLike, recordTrackSkip, 9],
        ['dislike', recordTrackDislike, recordTrackComplete, 2],
    ] as const)(
        'inference never changes explicit %s, including skipped and updated_at',
        async (_label, explicit, inferred, rating) => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            const trackId = trackIds[0];
            await explicit(sql, userId, trackId);
            const before =
                await sql`SELECT rating, skipped, updated_at, is_explicit FROM user_ratings WHERE user_id = ${userId} AND media_id = ${trackId}`;
            await inferred(sql, userId, trackId);
            const after =
                await sql`SELECT rating, skipped, updated_at, is_explicit FROM user_ratings WHERE user_id = ${userId} AND media_id = ${trackId}`;
            expect(after[0]).toEqual(before[0]);
            expect(after[0]).toMatchObject({ rating, skipped: false, is_explicit: true });
        },
    );

    // ========================================================================
    // recordTrackLike
    // ========================================================================

    describe('recordTrackLike', () => {
        it('stores a like rating', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordTrackLike(sql, userId, trackIds[0]);

            const feedback = await getTrackFeedback(sql, userId, trackIds[0]);
            expect(feedback).toBe('liked');
        });

        it('does not downgrade an existing like', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordTrackLike(sql, userId, trackIds[0]);
            await recordTrackLike(sql, userId, trackIds[0]);

            const rows = await sql<{ rating: number }[]>`
                SELECT rating FROM user_ratings WHERE user_id = ${userId} AND media_id = ${trackIds[0]}::uuid
            `;
            expect(rows[0].rating).toBeGreaterThanOrEqual(MUSIC_FEEDBACK_LIKE_RATING);
        });
    });

    // ========================================================================
    // recordTrackDislike
    // ========================================================================

    describe('recordTrackDislike', () => {
        it('stores a dislike rating', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordTrackDislike(sql, userId, trackIds[0]);

            const feedback = await getTrackFeedback(sql, userId, trackIds[0]);
            expect(feedback).toBe('disliked');
        });
    });

    // ========================================================================
    // recordTrackSkip
    // ========================================================================

    describe('recordTrackSkip', () => {
        it('records a skip and sets skipped flag', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordTrackSkip(sql, userId, trackIds[0]);

            const rows = await sql<{ skipped: boolean }[]>`
                SELECT skipped FROM user_ratings WHERE user_id = ${userId} AND media_id = ${trackIds[0]}::uuid
            `;
            expect(rows[0].skipped).toBe(true);
        });

        it('preserves an explicit dislike on skip', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordTrackDislike(sql, userId, trackIds[0]);
            await recordTrackSkip(sql, userId, trackIds[0]);

            const feedback = await getTrackFeedback(sql, userId, trackIds[0]);
            expect(feedback).toBe('disliked');
        });
    });

    // ========================================================================
    // recordTrackComplete
    // ========================================================================

    describe('recordTrackComplete', () => {
        it('records a complete listen with skipped=false', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordTrackComplete(sql, userId, trackIds[0]);

            const rows = await sql<{ skipped: boolean }[]>`
                SELECT skipped FROM user_ratings WHERE user_id = ${userId} AND media_id = ${trackIds[0]}::uuid
            `;
            expect(rows[0].skipped).toBe(false);
        });

        it('preserves an explicit like on complete', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            await recordTrackLike(sql, userId, trackIds[0]);
            await recordTrackComplete(sql, userId, trackIds[0]);

            const feedback = await getTrackFeedback(sql, userId, trackIds[0]);
            expect(feedback).toBe('liked');
        });
    });

    // ========================================================================
    // getTrackFeedback
    // ========================================================================

    describe('getTrackFeedback', () => {
        it('returns null when no rating exists', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 1,
            });
            const feedback = await getTrackFeedback(sql, userId, trackIds[0]);
            expect(feedback).toBeNull();
        });
    });

    // ========================================================================
    // clearTrackLike / clearTrackDislike
    //
    // These back DELETE /music/tracks/{id}/{like,dislike}. The contract that
    // matters is: idempotent, and scoped to their OWN direction — clearing a
    // like must never silently drop a dislike (and vice versa), because the
    // two endpoints are independent toggles on the client.
    // ========================================================================

    describe('clearTrackLike', () => {
        it('clears a like back to null', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await recordTrackLike(sql, userId, trackIds[0]);

            await expect(clearTrackLike(sql, userId, trackIds[0])).resolves.toBe(true);
            expect(await getTrackFeedback(sql, userId, trackIds[0])).toBeNull();
        });

        it('is idempotent — clearing twice is a no-op, not an error', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await recordTrackLike(sql, userId, trackIds[0]);

            expect(await clearTrackLike(sql, userId, trackIds[0])).toBe(true);
            expect(await clearTrackLike(sql, userId, trackIds[0])).toBe(false);
            expect(await getTrackFeedback(sql, userId, trackIds[0])).toBeNull();
        });

        it('is a no-op on a track that was never rated', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            expect(await clearTrackLike(sql, userId, trackIds[0])).toBe(false);
        });

        it('leaves a dislike untouched', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await recordTrackDislike(sql, userId, trackIds[0]);

            expect(await clearTrackLike(sql, userId, trackIds[0])).toBe(false);
            expect(await getTrackFeedback(sql, userId, trackIds[0])).toBe('disliked');
        });

        it('leaves implicit skip/complete behaviour untouched', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await recordTrackComplete(sql, userId, trackIds[0]);

            expect(await clearTrackLike(sql, userId, trackIds[0])).toBe(false);
            const [row] = await sql<{ rating: number }[]>`
                SELECT rating FROM user_ratings
                WHERE user_id = ${userId} AND media_id = ${trackIds[0]}
            `;
            expect(row).toBeDefined();
        });
    });

    describe('clearTrackDislike', () => {
        it('clears a dislike back to null', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await recordTrackDislike(sql, userId, trackIds[0]);

            await expect(clearTrackDislike(sql, userId, trackIds[0])).resolves.toBe(true);
            expect(await getTrackFeedback(sql, userId, trackIds[0])).toBeNull();
        });

        it('is idempotent — clearing twice is a no-op, not an error', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await recordTrackDislike(sql, userId, trackIds[0]);

            expect(await clearTrackDislike(sql, userId, trackIds[0])).toBe(true);
            expect(await clearTrackDislike(sql, userId, trackIds[0])).toBe(false);
            expect(await getTrackFeedback(sql, userId, trackIds[0])).toBeNull();
        });

        it('leaves a like untouched', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await recordTrackLike(sql, userId, trackIds[0]);

            expect(await clearTrackDislike(sql, userId, trackIds[0])).toBe(false);
            expect(await getTrackFeedback(sql, userId, trackIds[0])).toBe('liked');
        });

        it('re-likeable after clearing — the toggle round-trips', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            await recordTrackDislike(sql, userId, trackIds[0]);
            await clearTrackDislike(sql, userId, trackIds[0]);
            await recordTrackLike(sql, userId, trackIds[0]);

            expect(await getTrackFeedback(sql, userId, trackIds[0])).toBe('liked');
        });
    });
});
