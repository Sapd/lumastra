// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Queries backing the smart-downloads pool.
 *
 * Two rules from the design doc govern everything here:
 *
 * 1. Candidate queries produce FETCH ORDERING ONLY. They deliberately do not
 *    blend recency or ratings into their sort key -- a NOW()-dependent
 *    expression cannot be keyset-paged, and a rating lives in another table,
 *    so a join would make the ordering unindexable. The rich blend belongs in
 *    getRotationRescoreRanks, where the id set is bounded and both are free.
 *
 * 2. Rotation's value is at the HEAD of the ordering, so there is no cursor.
 *    The client re-reads the head and diffs it against what it already holds.
 *    A persisted frontier cursor would walk monotonically away from value.
 *
 * Verified against preprod PG 18.6: the play-count ordering resolves to
 * Index Scan using idx_ums_user_play_count plus an Incremental Sort with
 * Presorted Key: play_count, so no new index is required.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter, type AgeRatingFilterParams } from './builders/age-rating.builder.js';
import { trackArtistIdSql, trackDisplayArtistSql } from './fragments/music-artist.fragments.js';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';
import {
    MUSIC_FEEDBACK_LIKE_RATING,
    MUSIC_FEEDBACK_IMPLICIT_CEILING,
} from '$lib/server/services/music/feedback.js';

export interface DownloadAccessLimits {
    deniedGroupIds: string[] | null;
    ageRating: AgeRatingFilterParams | null;
}

export interface DownloadCandidateRow {
    media_id: string;
    title: string;
    artist_id: string | null;
    artist_title: string;
    runtime_seconds: number | null;
    play_count: number;
    source: 'play_count' | 'rating';
    /**
     * Whatever `media_audio_embeddings.projection_version` currently says for
     * this track's MSCLAP row, UNFILTERED by version -- this can be stale
     * (mid-rollout of a new basis) or absent (no embedding, or an embedding
     * that predates the projection feature). Callers MUST run this through
     * `selectServableProjectedVector` (music-embedding-projection/quantize.js)
     * against the codebase's current `EMBEDDING_PROJECTION_VERSION` before
     * ever serving it -- see that function's docstring for why serving a
     * version-mismatched vector is the exact failure mode the eval doc
     * measured at 16.4-39.4% recall. Deliberately not filtered in SQL so the
     * guard is a single testable TS choke point instead of duplicated WHERE
     * clauses.
     */
    projection_version: number | null;
    projected_vector: Buffer | null;
}

/**
 * `media_audio_embeddings` join fragment shared by both rotation sources
 * below. LEFT JOIN, not INNER -- a track with no MSCLAP embedding yet (or
 * ever, ~15 tracks on prod per the eval doc) must still be a valid download
 * candidate, just with a null projected vector (client falls back to
 * Essentia). Scoped to `SONIC_MODEL_ID` so a hypothetical future audio model
 * can't collide with this one on `(media_id, model_id)`.
 */
function embeddingProjectionJoinSql(sql: postgres.Sql) {
    return sql`
        LEFT JOIN media_audio_embeddings mae
               ON mae.media_id = mi.id AND mae.model_id = ${MSCLAP_MODEL_ID}
    `;
}

/**
 * The head of the user's play-count ordering.
 *
 * (play_count DESC, track_id DESC) is NOW()-free, which is what makes it
 * stable enough to re-read and diff. limit is the only depth control.
 */
export async function getRotationHeadByPlayCount(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    access: DownloadAccessLimits,
): Promise<DownloadCandidateRow[]> {
    return sql<DownloadCandidateRow[]>`
        SELECT
            mi.id AS media_id,
            mi.title,
            ${trackArtistIdSql(sql, 'mi')} AS artist_id,
            COALESCE(${trackDisplayArtistSql(sql, 'mi')}, '') AS artist_title,
            mi.runtime_seconds,
            ums.play_count,
            'play_count' AS source,
            mae.projection_version,
            mae.projected_vector
        FROM user_music_state ums
        JOIN media_items mi
          ON mi.id = ums.track_id AND mi.media_type = 'track' AND mi.has_files = true
        LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        ${embeddingProjectionJoinSql(sql)}
        WHERE ums.user_id = ${userId}
          AND ums.play_count > 0
          ${buildLibraryAccessFilter(sql, access.deniedGroupIds)}
          ${buildAgeRatingFilter(sql, access.ageRating)}
        ORDER BY ums.play_count DESC, ums.track_id DESC
        LIMIT ${limit}
    `;
}

/**
 * Minimum `user_ratings.rating` that counts as a favourite for the rotation
 * lane.
 *
 * `user_ratings.rating` is NOT a star rating -- it is the music feedback
 * score maintained by `src/lib/server/services/music/feedback.ts`. The
 * column's CHECK constraint allows 1-10, but the value's meaning is: `>=
 * MUSIC_FEEDBACK_LIKE_RATING` (9) is an explicit like, `<=
 * MUSIC_FEEDBACK_DISLIKE_RATING` (2) is an explicit dislike, and everything
 * else is implicit behaviour (completed / skipped) with
 * MUSIC_FEEDBACK_IMPLICIT_CEILING (8) as its top. A `skipped = true` row can
 * carry a rating in this range too, so a rating alone is not sufficient to
 * mean "favourite" -- it must also not have been skipped.
 *
 * This mirrors the "loved" definition every sibling query already uses:
 * `rating >= 8 AND skipped IS NOT TRUE` (see sonic-taste.queries.ts and
 * music-quick-picks.queries.ts).
 */
export const ROTATION_MIN_RATING = MUSIC_FEEDBACK_IMPLICIT_CEILING;

/**
 * The head of the user's ratings ordering -- the second rotation source.
 *
 * This is not an optimisation. A play-count keyset cannot reach these rows:
 * a rated-never-played track has no user_music_state row to order by at all.
 * Kept as a separate small query rather than a join so the play-count stream
 * stays index-backed and keyset-stable.
 */
export async function getRotationHeadByRating(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    access: DownloadAccessLimits,
): Promise<DownloadCandidateRow[]> {
    return sql<DownloadCandidateRow[]>`
        SELECT
            mi.id AS media_id,
            mi.title,
            ${trackArtistIdSql(sql, 'mi')} AS artist_id,
            COALESCE(${trackDisplayArtistSql(sql, 'mi')}, '') AS artist_title,
            mi.runtime_seconds,
            COALESCE(ums.play_count, 0) AS play_count,
            'rating' AS source,
            mae.projection_version,
            mae.projected_vector
        FROM user_ratings ur
        JOIN media_items mi
          ON mi.id = ur.media_id AND mi.media_type = 'track' AND mi.has_files = true
        LEFT JOIN user_music_state ums ON ums.user_id = ur.user_id AND ums.track_id = mi.id
        LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
        LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
        ${embeddingProjectionJoinSql(sql)}
        WHERE ur.user_id = ${userId}
          AND ur.rating >= ${ROTATION_MIN_RATING}
          AND ur.skipped IS NOT TRUE
          ${buildLibraryAccessFilter(sql, access.deniedGroupIds)}
          ${buildAgeRatingFilter(sql, access.ageRating)}
        ORDER BY ur.rating DESC, mi.id DESC
        LIMIT ${limit}
    `;
}

export interface RescoreRankRow {
    media_id: string;
    rank: number;
}

/**
 * Version stamp for the ordering expression in `getRotationRescoreRanks`.
 *
 * Bump this whenever that expression changes. A client sees this as
 * `scoreVersion` on the rescore response (see rescore.ts / the wire schema's
 * description) and MUST treat its previously stored ranks as stale and
 * re-rescore when it changes.
 *
 * Deliberately separate from `generation` (minted per-call in rescore.ts):
 * `generation` is unique on EVERY call, including two calls with an
 * unchanged ordering, specifically so nobody can believe a candidate rank
 * and a rescore rank are comparable just because they carry the same
 * identity-shaped token. `ROTATION_SCORE_VERSION` is the one that actually
 * answers "is this the same ranking function you saw before" — changing the
 * ordering expression above without bumping this constant is a silent,
 * undetectable break of that contract, which is why the constant is pinned
 * by a test.
 */
export const ROTATION_SCORE_VERSION = 1;

/**
 * Ordinal ranks for a bounded cohort of rotation members.
 *
 * The ordering expression is the CONTRACT-LEVEL one, and it is deliberately
 * different from the fetch ordering:
 *
 *   score = GREATEST(play_count - 0.5 * skip_count, 0) * recency_boost
 *           + rating_bonus
 *
 * `recency_boost` and the ratings join are exactly what cannot live in a
 * keyset-paged fetch ordering -- NOW() makes positions drift between pages, and
 * a rating lives in another table. Over a bounded id list both are free.
 *
 * The returned `rank` is a position WITHIN THE SUBMITTED COHORT. It is not a
 * position in any global stream and must never be treated as one.
 *
 * An id absent from the result is not ranked -- deleted, not a track, or
 * inaccessible. The caller turns absence into an explicit `gone` status,
 * because absence must never reach the client as a signal.
 */
export async function getRotationRescoreRanks(
    sql: postgres.Sql,
    userId: UserId,
    mediaIds: string[],
    access: DownloadAccessLimits,
): Promise<RescoreRankRow[]> {
    if (mediaIds.length === 0) return [];

    return sql<RescoreRankRow[]>`
        WITH cohort AS (
            SELECT
                mi.id AS media_id,
                GREATEST(COALESCE(ums.play_count, 0) - 0.5 * COALESCE(ums.skip_count, 0), 0)
                    * CASE
                        WHEN ums.last_played_at IS NULL THEN 1.0
                        WHEN ums.last_played_at > NOW() - INTERVAL '24 hours'  THEN 1.5
                        WHEN ums.last_played_at > NOW() - INTERVAL '7 days'    THEN 1.25
                        WHEN ums.last_played_at > NOW() - INTERVAL '30 days'   THEN 1.0
                        ELSE 0.75
                      END
                + CASE
                    WHEN COALESCE(ur.skipped, FALSE) THEN 0
                    WHEN COALESCE(ur.rating, 0) >= ${MUSIC_FEEDBACK_LIKE_RATING} THEN 30
                    WHEN COALESCE(ur.rating, 0) >= ${ROTATION_MIN_RATING} THEN 15
                    ELSE 0
                  END AS score
            FROM media_items mi
            LEFT JOIN user_music_state ums
                   ON ums.user_id = ${userId} AND ums.track_id = mi.id
            LEFT JOIN user_ratings ur
                   ON ur.user_id = ${userId} AND ur.media_id = mi.id
            WHERE mi.id = ANY(${mediaIds}::uuid[])
              AND mi.media_type = 'track'
              AND mi.has_files = true
              ${buildLibraryAccessFilter(sql, access.deniedGroupIds)}
              ${buildAgeRatingFilter(sql, access.ageRating)}
        )
        SELECT
            media_id,
            (row_number() OVER (ORDER BY score DESC, media_id DESC) - 1)::int AS rank
        FROM cohort
        ORDER BY rank
    `;
}

// ---------------------------------------------------------------------------
// Candidates ETag validator
// ---------------------------------------------------------------------------

export interface RotationEtagInputs {
    musicStateMaxLastPlayed: Date | null;
    musicStateCount: number;
    musicStatePlayCountSum: number;
    ratingsMaxUpdated: Date | null;
    ratingsCount: number;
}

/**
 * Cheap, INDEXED aggregates over every input that can move the rotation
 * head, for the `/candidates` ETag validator (see candidates.ts).
 *
 * This is deliberately NOT the real candidate query -- it must stay cheap
 * enough to run un-rate-limited on every poll. Each subquery is scoped to
 * `user_id = $1`, the leading column of an existing index
 * (idx_ums_user_play_count / idx_ums_user_last_played on user_music_state,
 * idx_user_ratings_user on user_ratings), so this is an index range scan
 * bounded to one user's rows, never a table scan.
 *
 * `user_ratings.updated_at` is used rather than `created_at` deliberately:
 * an existing rating's VALUE changing (e.g. a like flipped to a dislike)
 * touches `updated_at`, not `created_at` -- and a value change is exactly
 * the kind of edit that must invalidate a cached head. (No index covers
 * `updated_at` itself, but the `user_id` filter above already bounds the
 * scan to this user's rows before the aggregate runs.)
 */
export async function getRotationEtagInputs(
    sql: postgres.Sql,
    userId: UserId,
): Promise<RotationEtagInputs> {
    const [row] = await sql<
        {
            music_state_max_last_played: Date | null;
            music_state_count: string;
            music_state_play_count_sum: string | null;
            ratings_max_updated: Date | null;
            ratings_count: string;
        }[]
    >`
        SELECT
            (SELECT max(last_played_at) FROM user_music_state WHERE user_id = ${userId}) AS music_state_max_last_played,
            (SELECT count(*) FROM user_music_state WHERE user_id = ${userId}) AS music_state_count,
            (SELECT COALESCE(sum(play_count), 0) FROM user_music_state WHERE user_id = ${userId}) AS music_state_play_count_sum,
            (SELECT max(updated_at) FROM user_ratings WHERE user_id = ${userId}) AS ratings_max_updated,
            (SELECT count(*) FROM user_ratings WHERE user_id = ${userId}) AS ratings_count
    `;

    return {
        musicStateMaxLastPlayed: row?.music_state_max_last_played ?? null,
        musicStateCount: Number(row?.music_state_count ?? 0),
        musicStatePlayCountSum: Number(row?.music_state_play_count_sum ?? 0),
        ratingsMaxUpdated: row?.ratings_max_updated ?? null,
        ratingsCount: Number(row?.ratings_count ?? 0),
    };
}
