// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the smart-downloads query module.
 *
 * These MUST be integration tests, not unit tests: every assertion here is
 * about an ORDERING or an index-backed keyset, and the unit suite mocks the
 * query layer entirely. Two design revisions were rejected for defects that
 * lived exactly here.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMusicHierarchy,
    createTestTrack,
    insertTestTrack,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    getRotationHeadByPlayCount,
    getRotationHeadByRating,
    getRotationRescoreRanks,
    ROTATION_MIN_RATING,
} from './music-downloads.queries.js';

const NO_ACCESS_LIMITS = { deniedGroupIds: null, ageRating: null };

let sql: postgres.Sql;
let userId: string;
let albumId: string;
/** createTestTrack takes a track NUMBER positionally; keep them unique per test. */
let trackNumber: number;

beforeAll(async () => {
    sql = await getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, ['user_music_state', ...TEST_TABLES.media]);
    userId = randomUUID();
    // user_music_state.user_id FKs to users(id), so the row must exist before
    // any seedPlayed() insert. user_ratings.user_id FKs to user_profiles(user_id)
    // instead (discovered via \d user_ratings against the test DB -- the FK name
    // is user_ratings_v2_user_id_fkey, a leftover from the table's old name), so
    // seedRatedNeverPlayed() needs that row too.
    await sql`
        INSERT INTO users (id, username)
        VALUES (${userId}::uuid, ${derivedUsername(userId)})
        ON CONFLICT (id) DO NOTHING
    `;
    await sql`
        INSERT INTO user_profiles (user_id)
        VALUES (${userId}::uuid)
        ON CONFLICT (user_id) DO NOTHING
    `;
    const hierarchy = await createAndInsertTestMusicHierarchy(sql);
    albumId = hierarchy.albumId;
    trackNumber = 0;
});

/**
 * Inserts a track and its per-user play state.
 *
 * Note two fixture facts the queries depend on:
 *  - createTestTrack(albumId, trackNumber, overrides) is POSITIONAL.
 *  - insertTestTrack does NOT set has_files, which defaults to false
 *    (media.fixtures.ts:182). Both candidate queries filter on
 *    has_files = true -- mirroring getMostPlayedTracks -- so without this
 *    UPDATE every assertion here would pass against an empty set.
 */
async function seedTrack(title: string, runtimeSeconds = 240): Promise<string> {
    const track = createTestTrack(albumId, ++trackNumber, {
        title,
        runtime_seconds: runtimeSeconds,
    });
    await insertTestTrack(sql, track);
    await sql`UPDATE media_items SET has_files = true WHERE id = ${track.id}::uuid`;
    return track.id;
}

async function seedPlayed(title: string, playCount: number, skipCount = 0): Promise<string> {
    const trackId = await seedTrack(title);
    await sql`
        INSERT INTO user_music_state (user_id, track_id, play_count, skip_count, last_played_at, first_played_at)
        VALUES (${userId}::uuid, ${trackId}::uuid, ${playCount}, ${skipCount}, NOW(), NOW())
    `;
    return trackId;
}

describe('getRotationHeadByPlayCount', () => {
    it('orders by play_count descending, head first', async () => {
        const low = await seedPlayed('low', 3);
        const high = await seedPlayed('high', 90);
        const mid = await seedPlayed('mid', 40);

        const rows = await getRotationHeadByPlayCount(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows.map((r) => r.media_id)).toEqual([high, mid, low]);
    });

    it('honours the limit, returning the head rather than an arbitrary slice', async () => {
        const top = await seedPlayed('top', 100);
        await seedPlayed('second', 50);
        await seedPlayed('third', 10);

        const rows = await getRotationHeadByPlayCount(sql, toUserId(userId), 1, NO_ACCESS_LIMITS);

        expect(rows).toHaveLength(1);
        expect(rows[0]!.media_id).toBe(top);
    });

    it('excludes tracks with no plays', async () => {
        const played = await seedPlayed('played', 5);
        await seedTrack('unplayed');

        const rows = await getRotationHeadByPlayCount(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows.map((r) => r.media_id)).toEqual([played]);
    });

    it('returns runtime_seconds so the caller can size the download', async () => {
        await seedPlayed('sized', 7);

        const rows = await getRotationHeadByPlayCount(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows[0]!.runtime_seconds).toBe(240);
    });

    it('is deterministic across calls for equal play counts', async () => {
        await seedPlayed('a', 10);
        await seedPlayed('b', 10);
        await seedPlayed('c', 10);

        const first = await getRotationHeadByPlayCount(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);
        const second = await getRotationHeadByPlayCount(
            sql,
            toUserId(userId),
            10,
            NO_ACCESS_LIMITS,
        );

        expect(first.map((r) => r.media_id)).toEqual(second.map((r) => r.media_id));
    });

    // The no-cursor design (see the module docstring) depends on this exact
    // tiebreak: without ORDER BY ... track_id DESC as the second key,
    // Postgres's within-tie order is unspecified, and the client's head-diff
    // would churn every re-read even though nothing actually changed.
    it('breaks a play_count tie by track_id DESC, not an unspecified order', async () => {
        const ids = [
            await seedPlayed('a', 10),
            await seedPlayed('b', 10),
            await seedPlayed('c', 10),
        ];
        const expected = [...ids].sort().reverse();

        const rows = await getRotationHeadByPlayCount(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows.map((r) => r.media_id)).toEqual(expected);
    });

    it('excludes played tracks whose has_files is false', async () => {
        const trackId = await seedPlayed('played but no files', 20);
        await sql`UPDATE media_items SET has_files = false WHERE id = ${trackId}::uuid`;

        const rows = await getRotationHeadByPlayCount(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows).toHaveLength(0);
    });
});

/** Inserts a track with a user rating and NO play state at all. */
async function seedRatedNeverPlayed(
    title: string,
    rating: number,
    skipped = false,
): Promise<string> {
    const trackId = await seedTrack(title, 180);
    await sql`
        INSERT INTO user_ratings (user_id, media_id, rating, skipped, created_at)
        VALUES (${userId}::uuid, ${trackId}::uuid, ${rating}, ${skipped}, NOW())
    `;
    return trackId;
}

describe('getRotationHeadByRating', () => {
    it('returns a rated track that has never been played', async () => {
        const rated = await seedRatedNeverPlayed('loved but unplayed', 9);

        const rows = await getRotationHeadByRating(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows.map((r) => r.media_id)).toEqual([rated]);
        expect(rows[0]!.play_count).toBe(0);
        expect(rows[0]!.source).toBe('rating');
    });

    it('is the ONLY source that can surface such a track', async () => {
        await seedRatedNeverPlayed('invisible to play_count', 9);

        const byPlayCount = await getRotationHeadByPlayCount(
            sql,
            toUserId(userId),
            100,
            NO_ACCESS_LIMITS,
        );

        expect(byPlayCount).toHaveLength(0);
    });

    it('excludes ratings below the threshold', async () => {
        await seedRatedNeverPlayed('meh', ROTATION_MIN_RATING - 1);
        const loved = await seedRatedNeverPlayed('loved', ROTATION_MIN_RATING);

        const rows = await getRotationHeadByRating(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows.map((r) => r.media_id)).toEqual([loved]);
    });

    it('orders by rating descending', async () => {
        const nine = await seedRatedNeverPlayed('nine', 9);
        const ten = await seedRatedNeverPlayed('ten', 10);
        const eight = await seedRatedNeverPlayed('eight', ROTATION_MIN_RATING);

        const rows = await getRotationHeadByRating(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows.map((r) => r.media_id)).toEqual([ten, nine, eight]);
    });

    it('excludes rated tracks whose has_files is false', async () => {
        const trackId = await seedRatedNeverPlayed('rated but no files', 9);
        await sql`UPDATE media_items SET has_files = false WHERE id = ${trackId}::uuid`;

        const rows = await getRotationHeadByRating(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows).toHaveLength(0);
    });

    // Fix 2: `user_ratings.rating` is a feedback score, not a star rating — a
    // track the user explicitly SKIPPED can still carry a rating in the
    // qualifying band, and must not be offered back to them as a favourite.
    it('excludes a skipped track even at a qualifying rating', async () => {
        await seedRatedNeverPlayed('skipped but rated', ROTATION_MIN_RATING, true);

        const rows = await getRotationHeadByRating(sql, toUserId(userId), 10, NO_ACCESS_LIMITS);

        expect(rows).toHaveLength(0);
    });
});

/** Sets last_played_at to N hours ago for an existing play row. */
async function agePlay(trackId: string, hoursAgo: number): Promise<void> {
    await sql`
        UPDATE user_music_state
        SET last_played_at = NOW() - (${hoursAgo}::text || ' hours')::interval
        WHERE user_id = ${userId}::uuid AND track_id = ${trackId}::uuid
    `;
}

describe('getRotationRescoreRanks', () => {
    it('ranks from 0, best first, within the submitted cohort only', async () => {
        const a = await seedPlayed('a', 50);
        const b = await seedPlayed('b', 10);

        const ranks = await getRotationRescoreRanks(
            sql,
            toUserId(userId),
            [a, b],
            NO_ACCESS_LIMITS,
        );

        expect(ranks).toEqual([
            { media_id: a, rank: 0 },
            { media_id: b, rank: 1 },
        ]);
    });

    // Mutation this catches: dropping the "- 0.5 * skip_count" term from the
    // score. clean has a LOWER play_count than skipped, so clean can only win
    // if the skip penalty is actually applied -- without it, skipped's higher
    // raw play_count would win outright (not just tie).
    it('penalises skips', async () => {
        const clean = await seedPlayed('clean', 15, 0);
        const skipped = await seedPlayed('skipped', 20, 30);

        const ranks = await getRotationRescoreRanks(
            sql,
            toUserId(userId),
            [skipped, clean],
            NO_ACCESS_LIMITS,
        );

        expect(ranks.find((r) => r.media_id === clean)!.rank).toBeLessThan(
            ranks.find((r) => r.media_id === skipped)!.rank,
        );
    });

    // Mutation this catches: replacing the recency_boost CASE with a constant
    // 1.0. recent has a LOWER play_count than stale, so recent can only win
    // if the recency boost is actually applied -- without it, stale's higher
    // raw play_count would win outright (not just tie).
    it('boosts recent listening over lower-play-count stale listening', async () => {
        const recent = await seedPlayed('recent', 12);
        const stale = await seedPlayed('stale', 20);
        await agePlay(recent, 2);
        await agePlay(stale, 24 * 90);

        const ranks = await getRotationRescoreRanks(
            sql,
            toUserId(userId),
            [stale, recent],
            NO_ACCESS_LIMITS,
        );

        expect(ranks.find((r) => r.media_id === recent)!.rank).toBeLessThan(
            ranks.find((r) => r.media_id === stale)!.rank,
        );
    });

    it('ranks a rated-never-played track, which has no play row at all', async () => {
        const played = await seedPlayed('barely', 1);
        const rated = await seedRatedNeverPlayed('rated', 10);

        const ranks = await getRotationRescoreRanks(
            sql,
            toUserId(userId),
            [played, rated],
            NO_ACCESS_LIMITS,
        );

        expect(ranks.map((r) => r.media_id).sort()).toEqual([played, rated].sort());
        expect(ranks.find((r) => r.media_id === rated)!.rank).toBeLessThan(
            ranks.find((r) => r.media_id === played)!.rank,
        );
    });

    it('omits an id that is not a track in this catalog, so the caller can call it gone', async () => {
        const real = await seedPlayed('real', 5);
        const bogus = randomUUID();

        const ranks = await getRotationRescoreRanks(
            sql,
            toUserId(userId),
            [real, bogus],
            NO_ACCESS_LIMITS,
        );

        expect(ranks.map((r) => r.media_id)).toEqual([real]);
    });

    it('returns an empty array for an empty cohort rather than throwing', async () => {
        const ranks = await getRotationRescoreRanks(sql, toUserId(userId), [], NO_ACCESS_LIMITS);

        expect(ranks).toEqual([]);
    });

    it('produces a strict total order — no duplicate ranks', async () => {
        const ids = [
            await seedPlayed('x', 10),
            await seedPlayed('y', 10),
            await seedPlayed('z', 10),
        ];

        const ranks = await getRotationRescoreRanks(sql, toUserId(userId), ids, NO_ACCESS_LIMITS);

        expect(new Set(ranks.map((r) => r.rank)).size).toBe(3);
    });

    it('excludes a submitted id whose has_files is false, same as the candidate queries', async () => {
        const trackId = await seedPlayed('no files', 20);
        await sql`UPDATE media_items SET has_files = false WHERE id = ${trackId}::uuid`;

        const ranks = await getRotationRescoreRanks(
            sql,
            toUserId(userId),
            [trackId],
            NO_ACCESS_LIMITS,
        );

        expect(ranks).toHaveLength(0);
    });

    // Fix 2: a skipped track must not receive the rating bonus, even at a
    // rating that would otherwise qualify as an explicit like.
    it('does not grant the rating bonus to a skipped track', async () => {
        const skippedFavourite = await seedPlayed('skipped favourite', 10);
        await sql`
            UPDATE user_music_state SET skip_count = 0 WHERE track_id = ${skippedFavourite}::uuid
        `;
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating, skipped, created_at)
            VALUES (${userId}::uuid, ${skippedFavourite}::uuid, 9, true, NOW())
        `;
        // Higher raw play_count, no rating at all: this track must win unless
        // the skipped track wrongly receives the +30 explicit-like bonus.
        const plainFavourite = await seedPlayed('plain favourite', 20);

        const ranks = await getRotationRescoreRanks(
            sql,
            toUserId(userId),
            [skippedFavourite, plainFavourite],
            NO_ACCESS_LIMITS,
        );

        expect(ranks.find((r) => r.media_id === plainFavourite)!.rank).toBeLessThan(
            ranks.find((r) => r.media_id === skippedFavourite)!.rank,
        );
    });
});
