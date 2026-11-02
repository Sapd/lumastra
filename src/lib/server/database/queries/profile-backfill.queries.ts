// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Profile Backfill Query Module
 *
 * Finds users whose `user_profiles` row either does not exist, has a NULL
 * catalog_embedding, or (in stale-only mode) has an embedding that pre-dates
 * the user's most recent watch / rating activity.
 *
 * Results are ordered by watched_count DESC so the users with the most
 * engagement are rebuilt first.
 */

import type postgres from 'postgres';

// =============================================================================
// Types
// =============================================================================

export interface ProfileBackfillCandidate {
    user_id: string;
    watched_count: number;
    latest_activity: Date;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Find users who are candidates for a profile (re)build.
 *
 * A candidate must:
 *   1. Have watched >= `minWatched` movie/tv items that have a media_embedding
 *      (mirrors the EXISTS gate in countWatchedEmbeddableItems).
 *   2. Either have no user_profiles row, a NULL catalog_embedding, OR
 *      (when staleOnly = true) have an embedding whose updated_at is older than
 *      the user's latest watch or rating activity.
 *
 * @param sql       - postgres.Sql connection
 * @param limit     - Maximum number of candidates to return
 * @param staleOnly - When true, also return users whose profile is outdated
 * @param minWatched - Minimum number of watched embeddable items (FORYOU_MIN_WATCHED)
 */
export async function findProfileBackfillCandidates(
    sql: postgres.Sql,
    {
        limit,
        staleOnly,
        minWatched,
    }: {
        limit: number;
        staleOnly: boolean;
        minWatched: number;
    },
): Promise<ProfileBackfillCandidate[]> {
    // The watched aggregate is computed in a CTE grouped by user only — this
    // avoids (a) a fan-out from joining user_ratings to user_media_state (which
    // would multiply watched_count by the rating-row count) and (b) putting the
    // catalog_embedding vector in a GROUP BY. user_profiles + the latest rating
    // are then joined 1:1 in the outer query.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
    return sql<ProfileBackfillCandidate[]>`
        WITH watched AS (
            SELECT
                uws.user_id,
                COUNT(*)::integer       AS watched_count,
                MAX(uws.last_watched_at) AS last_watched_at
            FROM user_media_state uws
            JOIN media_items mi ON mi.id = uws.media_id
            WHERE uws.is_watched = true
              AND mi.media_type IN ('movie', 'tv')
              AND EXISTS (
                  SELECT 1 FROM media_embeddings me WHERE me.media_id = mi.id
              )
            GROUP BY uws.user_id
            HAVING COUNT(*) >= ${minWatched}
        )
        SELECT
            w.user_id,
            w.watched_count,
            GREATEST(
                COALESCE(w.last_watched_at, 'epoch'::timestamptz),
                COALESCE(r.last_rated_at, 'epoch'::timestamptz)
            ) AS latest_activity
        FROM watched w
        LEFT JOIN user_profiles up ON up.user_id = w.user_id
        LEFT JOIN LATERAL (
            SELECT MAX(ur.created_at) AS last_rated_at
            FROM user_ratings ur
            WHERE ur.user_id = w.user_id
        ) r ON true
        WHERE
            up.user_id IS NULL
            OR up.catalog_embedding IS NULL
            OR (
                ${staleOnly}
                AND up.updated_at < GREATEST(
                    COALESCE(w.last_watched_at, 'epoch'::timestamptz),
                    COALESCE(r.last_rated_at, 'epoch'::timestamptz)
                )
            )
        ORDER BY w.watched_count DESC
        LIMIT ${limit}
    `;
}
