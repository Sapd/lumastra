// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Test Fixtures
 *
 * Provides factory functions for creating test users, ratings, and watch history.
 */

import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { toUserId, type UserId } from '../../../src/lib/shared/user-id.js';

// =============================================================================
// Types
// =============================================================================

export interface TestUserRating {
    user_id: string;
    media_id: string;
    rating: number;
    suggestion_context: string | null;
    skipped: boolean;
}

export interface TestWatchStateEntry {
    user_id: string;
    media_id: string;
    watched_at: Date;
}

export interface TestUserProfile {
    user_id: string;
    display_name: string | null;
    preferences: Record<string, unknown>;
}

// =============================================================================
// Sample Test Users
// =============================================================================

/**
 * Test users for integration tests.
 * Using distinctive prefixes to avoid collision with real users.
 */
// users.id UUIDs (mig 16.46.0) — these are user-data KEYS, not usernames. The
// human-readable handle is derived (`u_<8>`) by ensureTestUser*.
export const TEST_USERS = {
    alice: randomUUID(),
    bob: randomUUID(),
    carol: randomUUID(),
    admin: randomUUID(),
} as const;

/**
 * Generate a unique test user ID — the stable `users.id` UUID (mig 16.46.0).
 * Returns a branded `UserId`. The accompanying `users.username` is derived from
 * this UUID by `ensureTestUser*` so a human-readable handle still exists.
 *
 * NOTE: the `prefix` is ignored for the id (a UUID can't carry a prefix); it is
 * retained for signature compatibility with the many call sites that pass one.
 */
export function generateTestUserId(_prefix: string = 'test_user'): UserId {
    return toUserId(randomUUID());
}

// =============================================================================
// Factory Functions - Ratings
// =============================================================================

/**
 * Create a test user rating.
 */
export function createTestRating(
    userId: string,
    mediaId: string,
    rating: number,
    options: {
        suggestionContext?: string | null;
        skipped?: boolean;
    } = {},
): TestUserRating {
    return {
        user_id: userId,
        media_id: mediaId,
        rating: Math.max(1, Math.min(10, rating)), // Clamp to 1-10
        suggestion_context: options.suggestionContext ?? null,
        skipped: options.skipped ?? false,
    };
}

/**
 * Create a batch of test ratings for a user.
 */
export function createTestRatingsBatch(
    userId: string,
    mediaIds: string[],
    options: {
        ratingRange?: [number, number]; // [min, max]
        withContext?: boolean;
    } = {},
): TestUserRating[] {
    const [minRating, maxRating] = options.ratingRange || [1, 10];
    const contexts = ['discover', 'home_recommended', 'similar', 'search', null];

    return mediaIds.map((mediaId, index) => ({
        user_id: userId,
        media_id: mediaId,
        rating: Math.floor(Math.random() * (maxRating - minRating + 1)) + minRating,
        suggestion_context: options.withContext ? contexts[index % contexts.length] : null,
        skipped: false,
    }));
}

// =============================================================================
// Factory Functions - Watch History
// =============================================================================

/**
 * Create a test watch history entry.
 */
export function createTestWatchStateEntry(
    userId: string,
    mediaId: string,
    watchedAt?: Date,
): TestWatchStateEntry {
    return {
        user_id: userId,
        media_id: mediaId,
        watched_at: watchedAt || new Date(),
    };
}

/**
 * Create a batch of watch history entries.
 */
export function createTestWatchStateBatch(
    userId: string,
    mediaIds: string[],
    options: {
        startDate?: Date;
        intervalDays?: number;
    } = {},
): TestWatchStateEntry[] {
    const startDate = options.startDate || new Date();
    const intervalDays = options.intervalDays || 1;

    return mediaIds.map((mediaId, index) => ({
        user_id: userId,
        media_id: mediaId,
        watched_at: new Date(startDate.getTime() - index * intervalDays * 24 * 60 * 60 * 1000),
    }));
}

// =============================================================================
// Insert Functions
// =============================================================================

/**
 * Insert a test user rating.
 */
export async function insertTestRating(sql: Sql, rating: TestUserRating): Promise<number> {
    // Ensure the users row + user_profiles FK parent exist. user_id is a
    // users.id UUID (mig 16.46.0).
    await ensureTestUser(sql, rating.user_id);

    const result = await sql<{ id: number }[]>`
        INSERT INTO user_ratings (user_id, media_id, rating, suggestion_context, skipped)
        VALUES (
            ${rating.user_id},
            ${rating.media_id}::uuid,
            ${rating.rating},
            ${rating.suggestion_context},
            ${rating.skipped}
        )
        RETURNING id
    `;
    return result[0]?.id ?? 0;
}

/**
 * Insert multiple test ratings.
 */
export async function insertTestRatings(sql: Sql, ratings: TestUserRating[]): Promise<number[]> {
    const ids: number[] = [];
    for (const rating of ratings) {
        const id = await insertTestRating(sql, rating);
        ids.push(id);
    }
    return ids;
}

/**
 * Bulk insert ratings using unnest for efficiency.
 */
export async function bulkInsertTestRatings(sql: Sql, ratings: TestUserRating[]): Promise<number> {
    if (ratings.length === 0) return 0;

    const userIds = ratings.map((r) => r.user_id);
    const mediaIds = ratings.map((r) => r.media_id);
    const ratingValues = ratings.map((r) => r.rating);
    const contexts = ratings.map((r) => r.suggestion_context);

    // Ensure user profiles exist (required by foreign key constraint).
    // user_id values are users.id UUIDs (mig 16.46.0).
    const uniqueUserIds = [...new Set(userIds)];
    const uniqueUsernames = uniqueUserIds.map(derivedUsername);
    await sql`
        INSERT INTO users (id, username, hide_streams, share_listening_activity, share_audiobook_activity)
        SELECT id, username, false, true, true
        FROM unnest(${uniqueUserIds}::uuid[], ${uniqueUsernames}::text[]) AS fixture(id, username)
        ON CONFLICT (id) DO NOTHING
    `;
    await sql`
        INSERT INTO user_profiles (user_id)
        SELECT * FROM unnest(${uniqueUserIds}::uuid[])
        ON CONFLICT (user_id) DO NOTHING
    `;

    const result = await sql`
        INSERT INTO user_ratings (user_id, media_id, rating, suggestion_context)
        SELECT * FROM unnest(
            ${userIds}::uuid[],
            ${mediaIds}::uuid[],
            ${ratingValues}::integer[],
            ${contexts}::text[]
        )
        ON CONFLICT (user_id, media_id) DO UPDATE SET
            rating = EXCLUDED.rating,
            suggestion_context = EXCLUDED.suggestion_context
    `;

    return result.count;
}

/**
 * Insert a test watch history entry into the watch-state materialized read
 * model. Migration 12.44.0 replaced the legacy `user_watch_state` table with
 * `user_media_state` (derived) + `user_media_events` (append-only event log);
 * `synced_from_provider` was dropped in favour of `last_event_source` on the
 * derived table.
 */
export async function insertTestWatchStateEntry(
    sql: Sql,
    entry: TestWatchStateEntry,
): Promise<void> {
    // Ensure the users row + user_profiles FK parent exist (user_id is a UUID).
    await ensureTestUser(sql, entry.user_id);

    await sql`
        INSERT INTO user_media_state (
            user_id, media_id, is_watched,
            first_watched_at, last_watched_at, last_event_source
        )
        VALUES (
            ${entry.user_id},
            ${entry.media_id}::uuid,
            true,
            ${entry.watched_at},
            ${entry.watched_at},
            'lumastra-user-mark'
        )
        ON CONFLICT (user_id, media_id) DO UPDATE SET
            is_watched = true,
            last_watched_at = EXCLUDED.last_watched_at
    `;
}

/**
 * Insert multiple watch history entries.
 */
export async function insertTestWatchState(
    sql: Sql,
    entries: TestWatchStateEntry[],
): Promise<void> {
    for (const entry of entries) {
        await insertTestWatchStateEntry(sql, entry);
    }
}

/**
 * Derive the `users.username` for a fixture user from its id.
 *
 * `users.username` carries a UNIQUE constraint, and every insert below guards
 * only `ON CONFLICT (id)`. Deriving the name from the first EIGHT hex chars of
 * the uuid therefore made two different fixture users with the same uuid prefix
 * collide on the username — the id clause does not match (the ids differ), so
 * the insert raised 23505 instead of no-opping, `ensureTestUser` threw, and the
 * calling file's beforeEach died with it. Every test in that file then failed
 * for a reason having nothing to do with the file.
 *
 * That is not hypothetical: SEVEN distinct fixture uuids across four
 * integration files begin `22222222`, so whichever ran first claimed
 * `u_22222222` and the rest went red. In CI it cost sonic-fingerprint (4/4) and
 * sonic-taste (3/3) — files that pass in isolation, which is what made it look
 * like flakiness rather than a fixture bug.
 *
 * The full uuid is unique by definition, so a collision can no longer be
 * constructed. `users.username` is `text`, so length is not a constraint.
 *
 * EXPORTED, and the only place this derivation may live. It was previously
 * private, and 53 sites across 20 test files spelled `'u_' + id.slice(0, 8)`
 * out by hand — some to assert on what `ensureTestUser` had inserted, some to
 * insert a users row themselves without the fixtures at all. Narrowing the
 * derivation here therefore broke nine files at once (30 tests), because their
 * copy of the rule kept saying `slice(0, 8)`. A duplicated derivation that four
 * different comments describe in prose is exactly the thing that cannot be
 * changed safely; call this instead of restating it.
 */
export function derivedUsername(userId: string): string {
    return 'u_' + userId.replace(/-/g, '');
}

/**
 * Insert a test user profile.
 */
export async function insertTestUserProfile(sql: Sql, profile: TestUserProfile): Promise<void> {
    await sql`
        INSERT INTO users (id, username, hide_streams, share_listening_activity, share_audiobook_activity)
        VALUES (${profile.user_id}::uuid, ${derivedUsername(profile.user_id)}, false, true, true)
        ON CONFLICT (id) DO NOTHING
    `;
    await sql`
        INSERT INTO user_profiles (user_id, display_name, preferences)
        VALUES (
            ${profile.user_id}::uuid,
            ${profile.display_name},
            ${JSON.stringify(profile.preferences)}
        )
        ON CONFLICT (user_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            preferences = EXCLUDED.preferences
    `;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Ensure a user profile exists (creates if not exists).
 * Use this before calling query functions that require user_id FK.
 */
export async function ensureTestUser(sql: Sql, userId: string): Promise<void> {
    // Social fixtures explicitly opt in; production users default to private.
    // userId is the users.id UUID (mig 16.46.0). Insert the row keyed by id with
    // a derived username, then the FK-dependent user_profiles row keyed by id.
    await sql`
        INSERT INTO users (id, username, hide_streams, share_listening_activity, share_audiobook_activity)
        VALUES (${userId}::uuid, ${derivedUsername(userId)}, false, true, true)
        ON CONFLICT (id) DO NOTHING
    `;
    await sql`
        INSERT INTO user_profiles (user_id)
        VALUES (${userId}::uuid)
        ON CONFLICT (user_id) DO NOTHING
    `;
}

/**
 * Ensure multiple user profiles exist.
 */
export async function ensureTestUsers(sql: Sql, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const usernames = userIds.map(derivedUsername);
    await sql`
        INSERT INTO users (id, username, hide_streams, share_listening_activity, share_audiobook_activity)
        SELECT id, username, false, true, true
        FROM unnest(${userIds}::uuid[], ${usernames}::text[]) AS fixture(id, username)
        ON CONFLICT (id) DO NOTHING
    `;
    await sql`
        INSERT INTO user_profiles (user_id)
        SELECT * FROM unnest(${userIds}::uuid[])
        ON CONFLICT (user_id) DO NOTHING
    `;
}

/**
 * Create a test user with some ratings.
 */
export async function createTestUserWithRatings(
    sql: Sql,
    mediaIds: string[],
    options: {
        userId?: string;
        likedCount?: number;
        dislikedCount?: number;
    } = {},
): Promise<{
    userId: string;
    likedMediaIds: string[];
    dislikedMediaIds: string[];
}> {
    const userId = options.userId || generateTestUserId();
    const likedCount = options.likedCount ?? Math.min(3, mediaIds.length);
    const dislikedCount = options.dislikedCount ?? Math.min(2, mediaIds.length - likedCount);

    const shuffled = [...mediaIds].sort(() => Math.random() - 0.5);
    const likedMediaIds = shuffled.slice(0, likedCount);
    const dislikedMediaIds = shuffled.slice(likedCount, likedCount + dislikedCount);

    // Insert liked ratings (7-10)
    for (const mediaId of likedMediaIds) {
        await insertTestRating(
            sql,
            createTestRating(userId, mediaId, 7 + Math.floor(Math.random() * 4)),
        );
    }

    // Insert disliked ratings (1-4)
    for (const mediaId of dislikedMediaIds) {
        await insertTestRating(
            sql,
            createTestRating(userId, mediaId, 1 + Math.floor(Math.random() * 4)),
        );
    }

    return { userId, likedMediaIds, dislikedMediaIds };
}

/**
 * Create test data with user ratings for multiple media items.
 * Useful for recommendation testing.
 */
export async function createRatingsTestScenario(
    sql: Sql,
    options: {
        userCount?: number;
        mediaIds: string[];
        ratingsPerUser?: number;
    },
): Promise<{
    userIds: string[];
    ratingsByUser: Map<string, Array<{ mediaId: string; rating: number }>>;
}> {
    const userCount = options.userCount ?? 3;
    const ratingsPerUser = options.ratingsPerUser ?? 5;
    const userIds: string[] = [];
    const ratingsByUser = new Map<string, Array<{ mediaId: string; rating: number }>>();

    for (let i = 0; i < userCount; i++) {
        const userId = generateTestUserId(`scenario_user_${i}`);
        userIds.push(userId);

        const mediaIdsSample = options.mediaIds.slice(0, ratingsPerUser);
        const userRatings: Array<{ mediaId: string; rating: number }> = [];

        for (const mediaId of mediaIdsSample) {
            const rating = Math.floor(Math.random() * 10) + 1;
            await insertTestRating(sql, createTestRating(userId, mediaId, rating));
            userRatings.push({ mediaId, rating });
        }

        ratingsByUser.set(userId, userRatings);
    }

    return { userIds, ratingsByUser };
}
