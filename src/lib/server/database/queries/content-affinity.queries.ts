// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Content Cluster Affinity Queries
 *
 * Pure SQL for measuring how much of a user's own engagement history carries a
 * given content cluster (kids/family, anime). Feeds the For-You mood-rail
 * soft-suppression signal (see `$lib/server/services/content-affinity.service`),
 * which decides whether to soft-suppress a cluster's content for users who
 * don't watch it.
 *
 * Kids genres = TMDB genre ids 10751 (Family) and 10762 (Kids), matched via the
 * `media_genres` per-provider projection table (see base-schema.ts ~line 436).
 *
 * Anime (item-level definition, used everywhere a query needs to classify a
 * single candidate row): mdblist keyword `'anime'` present, OR (genre 16
 * (Animation) AND `provider_metadata.metadata->>'original_language' = 'ja'`).
 * This is deliberately simpler than the MDBList-native `has_anime_genres`
 * projection (media_scalars) — that column depends on MDBList populating a
 * dedicated `anime_genres` array, which is not reliably populated across the
 * catalog and undercounts anime on prod.
 *
 * @module queries/content-affinity
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Constants
// =============================================================================

/** The two content clusters this system tracks affinity for. */
export type ContentClusterKey = 'kids' | 'anime';

/**
 * TMDB genre ids that mark a title as kids/family content. Exported so the
 * mood-recommendations and short-movies queries can compute their soft
 * down-rank penalty against the same genre set as this affinity signal.
 */
export const KIDS_GENRE_IDS = [10751, 10762];

/**
 * TMDB Animation genre id. Exported so item-level anime detection (mdblist
 * keyword 'anime' OR genre 16 + Japanese original language) stays consistent
 * across the mood-recommendations and short-movies queries.
 */
export const ANIME_GENRE_ID = 16;

/** Recency window for the "watched/completed" signal. */
const WATCH_LOOKBACK_DAYS = 90;

/** Minimum rating (out of 10) that counts as a positive signal. */
const MIN_POSITIVE_RATING = 7;

// =============================================================================
// Types
// =============================================================================

export interface ClusterWatchCounts {
    /** Distinct engaged media items (resolved to series for episodes) that carry a kids genre. */
    kidsCount: number;
    /** Distinct engaged media items (resolved to series for episodes) that are anime. */
    animeCount: number;
    /** Total distinct engaged media items considered. */
    totalCount: number;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Count how many of the user's own recently-engaged media items fall into
 * each content cluster (kids/family, anime) vs the total, so the caller can
 * derive per-cluster affinity ratios.
 *
 * Engagement signals (unioned, deduplicated by resolved media id):
 *   (a) items watched/completed in the last {@link WATCH_LOOKBACK_DAYS} days
 *       (`user_media_state.is_watched`, the sole source of truth for watch state)
 *   (b) items rated >= {@link MIN_POSITIVE_RATING} at any time (`user_ratings`)
 *
 * Genre/keyword/language metadata lives on the SERIES
 * (`provider_metadata`/`media_genres`/`media_keywords` are populated at the
 * series level, never per-episode/-season), so an episode engagement is
 * resolved up through its season to its series before either cluster check.
 * Movies/series rows are used as-is.
 *
 * This query is scoped to the CALLING user's own history (user_media_state /
 * user_ratings rows filtered by `user_id`), not a content-discovery surface — it
 * cannot leak metadata for items the user hasn't already engaged with, so the
 * `media_items` hop used purely to walk the episode -> season -> series
 * hierarchy is exempt from the library/age access-gate requirement. See the
 * documented exception pattern in docs/dev/eslint-exceptions.md.
 */
export async function getClusterWatchCounts(
    sql: postgres.Sql,
    userId: UserId,
): Promise<ClusterWatchCounts> {
    // Documented exception (docs/dev/eslint-exceptions.md pattern): this query is
    // scoped to the CALLING user's own user_media_state/user_ratings rows, not a
    // content-discovery surface. media_items is joined only to walk the
    // episode -> season -> series hierarchy so genre/keyword/language metadata
    // (which lives on the series row) can be resolved for an episode the user
    // already engaged with.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<{ kids_count: number; anime_count: number; total_count: number }[]>`
        WITH user_media AS (
            SELECT media_id
            FROM user_media_state
            WHERE user_id = ${userId}
              AND is_watched = true
              AND last_watched_at >= NOW() - ${`${WATCH_LOOKBACK_DAYS} days`}::interval
            UNION
            SELECT media_id
            FROM user_ratings
            WHERE user_id = ${userId}
              AND rating >= ${MIN_POSITIVE_RATING}
        ),
        resolved AS (
            SELECT
                COALESCE(series_via_episode.id, series_via_season.id, mi.id) AS genre_media_id
            FROM user_media um
            JOIN media_items mi ON mi.id = um.media_id
            LEFT JOIN media_items season
                ON mi.media_type = 'episode' AND season.id = mi.parent_id
            LEFT JOIN media_items series_via_episode
                ON season.id IS NOT NULL AND series_via_episode.id = season.parent_id
            LEFT JOIN media_items series_via_season
                ON mi.media_type = 'season' AND series_via_season.id = mi.parent_id
        ),
        distinct_media AS (
            SELECT DISTINCT genre_media_id
            FROM resolved
            WHERE genre_media_id IS NOT NULL
        )
        SELECT
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1 FROM media_genres mg
                    WHERE mg.media_id = distinct_media.genre_media_id
                      AND mg.genre_id = ANY(${KIDS_GENRE_IDS}::int[])
                )
            )::int AS kids_count,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1 FROM media_keywords mk
                    WHERE mk.media_id = distinct_media.genre_media_id
                      AND mk.keyword_type = 'mdblist'
                      AND mk.keyword = 'anime'
                )
                OR (
                    EXISTS (
                        SELECT 1 FROM media_genres mg
                        WHERE mg.media_id = distinct_media.genre_media_id
                          AND mg.genre_id = ${ANIME_GENRE_ID}
                    )
                    AND EXISTS (
                        SELECT 1 FROM provider_metadata pm
                        WHERE pm.media_id = distinct_media.genre_media_id
                          AND pm.metadata->>'original_language' = 'ja'
                    )
                )
            )::int AS anime_count,
            COUNT(*)::int AS total_count
        FROM distinct_media
    `;

    return {
        kidsCount: row?.kids_count ?? 0,
        animeCount: row?.anime_count ?? 0,
        totalCount: row?.total_count ?? 0,
    };
}
