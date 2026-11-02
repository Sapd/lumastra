// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import {
    MUSIC_FEEDBACK_DISLIKE_RATING,
    MUSIC_FEEDBACK_IMPLICIT_CEILING,
    MUSIC_FEEDBACK_IMPLICIT_FLOOR,
    MUSIC_FEEDBACK_LIKE_RATING,
    ratingToFeedback,
    type MusicTrackFeedback,
} from '$lib/server/services/music/feedback';

export async function recordTrackLike(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<void> {
    await sql`
        INSERT INTO user_ratings (user_id, media_id, rating, skipped, is_explicit)
        VALUES (${userId}, ${trackId}, ${MUSIC_FEEDBACK_LIKE_RATING}, false, true)
        ON CONFLICT (user_id, media_id)
        DO UPDATE SET
            rating = ${MUSIC_FEEDBACK_LIKE_RATING},
            is_explicit = true,
            skipped = false,
            updated_at = NOW()
    `;
}

export async function recordTrackDislike(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<void> {
    await sql`
        INSERT INTO user_ratings (user_id, media_id, rating, skipped, is_explicit)
        VALUES (${userId}, ${trackId}, ${MUSIC_FEEDBACK_DISLIKE_RATING}, false, true)
        ON CONFLICT (user_id, media_id)
        DO UPDATE SET
            rating = ${MUSIC_FEEDBACK_DISLIKE_RATING},
            is_explicit = true,
            skipped = false,
            updated_at = NOW()
    `;
}

// ── Clearing explicit feedback ────────────────────────────────────────────
//
// Un-liking / un-disliking DELETEs the `user_ratings` row rather than moving
// the rating back into the implicit band. That loses nothing: an explicit
// like/dislike already overwrote whatever implicit value was there
// (`GREATEST(rating, 9)` / `LEAST(rating, 2)` are unconditional at those
// thresholds) and already forced `skipped = false`. Play counts and listen
// history live in `user_music_state` / `music_listen_events` and are untouched.
//
// Each clear is scoped to its OWN direction via the rating threshold, so
// DELETE /like on a disliked track is a no-op instead of silently clearing the
// dislike. The threshold test lives in the WHERE clause so the read-then-write
// is a single atomic statement — no check-then-act race with a concurrent
// like/dislike from another device.

/**
 * Remove an explicit LIKE. No-op when the track is not currently liked.
 * @returns true when a like was actually cleared.
 */
export async function clearTrackLike(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<boolean> {
    const result = await sql`
        DELETE FROM user_ratings
        WHERE user_id = ${userId}
          AND media_id = ${trackId}
          AND rating >= ${MUSIC_FEEDBACK_LIKE_RATING}
    `;
    return result.count > 0;
}

/**
 * Remove an explicit DISLIKE. No-op when the track is not currently disliked.
 * @returns true when a dislike was actually cleared.
 */
export async function clearTrackDislike(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<boolean> {
    const result = await sql`
        DELETE FROM user_ratings
        WHERE user_id = ${userId}
          AND media_id = ${trackId}
          AND rating <= ${MUSIC_FEEDBACK_DISLIKE_RATING}
    `;
    return result.count > 0;
}

// Implicit behaviour (skip / complete) moves the rating within
// [IMPLICIT_FLOOR, IMPLICIT_CEILING]. Explicit likes/dislikes sit outside this
// range and are preserved — implicit behaviour must not silently overturn an
// explicit user choice.

export async function recordTrackSkip(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<void> {
    await sql`
        INSERT INTO user_ratings (user_id, media_id, rating, skipped)
        VALUES (${userId}, ${trackId}, 4, true)
        ON CONFLICT (user_id, media_id)
        DO UPDATE SET
            rating = CASE
                WHEN user_ratings.rating <= ${MUSIC_FEEDBACK_DISLIKE_RATING}
                    THEN user_ratings.rating
                ELSE GREATEST(user_ratings.rating - 1, ${MUSIC_FEEDBACK_IMPLICIT_FLOOR})
            END,
            skipped = true,
            updated_at = NOW()
        WHERE user_ratings.is_explicit = false
    `;
}

export async function recordTrackComplete(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<void> {
    await sql`
        INSERT INTO user_ratings (user_id, media_id, rating, skipped)
        VALUES (${userId}, ${trackId}, 6, false)
        ON CONFLICT (user_id, media_id)
        DO UPDATE SET
            rating = CASE
                WHEN user_ratings.rating >= ${MUSIC_FEEDBACK_LIKE_RATING}
                    THEN user_ratings.rating
                ELSE LEAST(user_ratings.rating + 1, ${MUSIC_FEEDBACK_IMPLICIT_CEILING})
            END,
            skipped = false,
            updated_at = NOW()
        WHERE user_ratings.is_explicit = false
    `;
}

export async function getTrackFeedback(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<MusicTrackFeedback> {
    const rows = await sql<{ rating: number }[]>`
        SELECT rating
        FROM user_ratings
        WHERE user_id = ${userId}
          AND media_id = ${trackId}::uuid
          AND is_explicit = true
        LIMIT 1
    `;
    return ratingToFeedback(rows[0]?.rating ?? null);
}

/**
 * Delete all of a user's *track* ratings (like/dislike/skip/complete all live
 * in `user_ratings`). Scoped to `media_type = 'track'` via a `media_items`
 * subquery so VOD (movie/tv) star ratings are preserved.
 */
export async function clearAllTrackRatings(sql: postgres.Sql, userId: UserId): Promise<number> {
    // user_id-scoped DELETE of the caller's OWN ratings; media_items is only a
    // media_type='track' filter to keep the delete track-scoped, not a content
    // listing. Library/age gating must NOT apply — a user must be able to
    // clear their own data regardless of current access.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const deleted = await sql`
        DELETE FROM user_ratings
        WHERE user_id = ${userId}
          AND media_id IN (SELECT id FROM media_items WHERE media_type = 'track')
    `;
    return deleted.count;
}

/** Clear either direction, including an inferred row. Idempotent. */
export async function clearTrackFeedback(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
): Promise<void> {
    await sql`DELETE FROM user_ratings WHERE user_id = ${userId} AND media_id = ${trackId}::uuid`;
}

/** Watch-state star ratings on tracks are explicit too. */
export async function setExplicitTrackRating(
    sql: postgres.Sql,
    userId: UserId,
    trackId: string,
    rating: number,
): Promise<void> {
    await sql`INSERT INTO user_ratings (user_id, media_id, rating, skipped, is_explicit)
        VALUES (${userId}, ${trackId}::uuid, ${rating}, false, true)
        ON CONFLICT (user_id, media_id) DO UPDATE SET rating = EXCLUDED.rating,
            skipped = false, is_explicit = true, updated_at = NOW()`;
}
