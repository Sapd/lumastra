// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Binge-Worthy Queries Module
 *
 * Optimized queries for binge-worthy TV series recommendations.
 * Finds high-quality TV series with at least 6 months of content available.
 *
 * Key features:
 * - Single unified query (no separate available/requestable queries)
 * - Uses media_file_items for correct availability checking
 * - Quality-based ranking (no AI similarity)
 * - Excludes user's watched and disliked content
 *
 * ## Access boundary
 *
 * `getBingeWorthySeries` takes a REQUIRED `access: MediaAccessBoundary`. There
 * is no permissive default: a caller that genuinely wants unrestricted results
 * must construct `unrestrictedAccess()` so the decision is greppable.
 *
 * Both boundary fragments are emitted INSIDE the `candidates` CTE, which is the
 * only correct place:
 * - `candidates` runs `DISTINCT ON (primary_ext.external_id, mi.media_type)`, so
 *   filtering after dedup could drop a whole group whose surviving
 *   representative happened to be inaccessible.
 * - `availability_ranked` assigns `ROW_NUMBER()` over `candidates`; a denied row
 *   that survived into that window would consume a rank slot and silently shrink
 *   the visible rail.
 *
 * Both fragments target the `mi` alias bound by `JOIN media_items mi` in the
 * `candidates` CTE — `buildLibraryAccessFilter` hardcodes `mi`, and
 * `buildAgeRatingFilter` defaults to it. Note `mi` is ALSO bound, to a different
 * scope, by the `user_watched` CTE. That CTE is an exclusion set and
 * deliberately carries no access filter: adding one there would change which
 * rows are excluded, and therefore which rows a restricted user sees.
 *
 * `deniesEverything(access)` short-circuits to `[]` before any SQL is issued.
 *
 * @module queries/binge-worthy
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { isAvailableExpr } from './availability.queries.js';
import { buildWinningSourceScalarFilterFragment } from './builders/provider-metadata.builder.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildDamperPenalty, DAMPER_LAMBDA } from './builders/damper-penalty.builder.js';
import type { DamperContext } from '$lib/server/services/taste-damper.service.js';
import { KIDS_GENRE_IDS, ANIME_GENRE_ID } from './content-affinity.queries.js';
import type {
    BaseMediaWithExtIdRow,
    MetadataContent,
    MetadataRatings,
    MetadataArrays,
} from './types/index.js';

// =============================================================================
// Types
// =============================================================================

export interface BingeWorthyQueryParams {
    userId: UserId;
    excludeTmdbIds: number[];
    limit: number;
    sixMonthsAgo: string;
    /**
     * REQUIRED media access boundary, applied inside the `candidates` CTE
     * (before both the `DISTINCT ON` dedup and the `availability_ranked`
     * window). A `denyAll` boundary short-circuits to an empty result before
     * any SQL is issued.
     */
    access: MediaAccessBoundary;
    /**
     * Active "show less like this" taste-dampers for the requesting user.
     * Applied as a multiplicative attenuation on the positive part of the
     * final ordering score (never boosts a negative score) — same idiom as
     * ShortMoviesStrategy / anime / featured-pick / mood.
     */
    damper?: DamperContext | null;
    /**
     * Soft down-rank series whose genres include Family/Kids (10751/10762).
     * Never excludes — subtracts a flat penalty from the final ordering score
     * so a family-heavy library still fills the rail rather than returning
     * empty.
     */
    suppressKidsContent?: boolean;
    /**
     * Soft down-rank anime series (mdblist keyword 'anime', OR genre 16
     * (Animation) AND Japanese original language). Never excludes — same
     * flat-penalty shape as `suppressKidsContent`.
     */
    suppressAnimeContent?: boolean;
}

export type BingeWorthyRow = Omit<BaseMediaWithExtIdRow, 'media_id'> &
    Pick<MetadataContent, 'overview' | 'release_date' | 'trailer_url'> &
    Pick<MetadataRatings, 'imdb_rating' | 'tmdb_rating'> &
    Pick<MetadataArrays, 'genres'> & {
        internal_id: string;
        mdblist_score: number | null;
        rt_critic: number | null;
        rt_audience: number | null;
        release_year: number | null;
        poster_path: string | null;
        backdrop_path: string | null;
        is_available: boolean;
        quality_score: number;
        /** TMDB vote count; gates whether tmdb_rating may be shown as a display rating. */
        vote_count: number | null;
    };

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Get binge-worthy TV series with availability flags.
 *
 * This query:
 * - Returns series at least 6 months old (using year column)
 * - Uses media_file_items for correct availability checking
 * - Applies different quality thresholds: available >= 65, requestable >= 70
 * - Excludes user's watched series
 * - Sorts by availability first, then quality
 *
 * Quality score fallback chain: MDBList → IMDB*10 → TMDB*10 → 0
 *
 * @param sql - Postgres SQL instance
 * @param params - Query parameters
 * @returns Array of binge-worthy series rows with availability flags
 */
export async function getBingeWorthySeries(
    sql: postgres.Sql,
    params: BingeWorthyQueryParams,
): Promise<BingeWorthyRow[]> {
    const {
        userId,
        excludeTmdbIds,
        limit,
        sixMonthsAgo,
        access,
        damper = null,
        suppressKidsContent = false,
        suppressAnimeContent = false,
    } = params;

    if (deniesEverything(access)) return [];

    // "Show less like this": attenuate only the positive part of the ranking
    // score (a negative score must not be boosted toward 0), matching the
    // subtractive idiom used by ShortMoviesStrategy/anime/mood. Reused below
    // in both the availability_ranked ORDER BY and the final ORDER BY.
    const rankBase =
        suppressKidsContent || suppressAnimeContent
            ? sql`(quality_score - cluster_penalty)`
            : sql`quality_score`;
    const rankExpr = sql`(${rankBase} - GREATEST(${rankBase}, 0) * ${DAMPER_LAMBDA}::numeric * damper_pen)`;

    const result = await sql<BingeWorthyRow[]>`
        WITH
        -- Get user's watched series once (instead of array). MATERIALIZED is
        -- required, not cosmetic: left un-hinted, Postgres inlines this CTE
        -- (PG12+ default for a single-reference CTE) into the candidates
        -- anti-join. The planner then drastically under-estimates the anti-
        -- join's selectivity (it sees the whole user_media_state -> media_items
        -- join, not the small deduped set this CTE actually produces) and
        -- picks a Nested Loop Anti Join instead of a hash/CTE-scan anti join —
        -- recomputing the user_media_state scan + media_items lookup once PER
        -- CANDIDATE ROW instead of once total. EXPLAIN ANALYZE confirmed that
        -- materializing avoids this repeated work. MATERIALIZED changes only
        -- the physical plan, never the result set.
        user_watched AS MATERIALIZED (
            SELECT DISTINCT uwh.media_id
            FROM user_media_state uwh
            JOIN media_items mi ON mi.id = uwh.media_id
            WHERE uwh.user_id = ${userId}
              AND uwh.is_watched = true
              AND mi.media_type = 'tv'
        ),
        -- Main query with availability flag
        candidates AS (
            SELECT DISTINCT ON (primary_ext.external_id, mi.media_type)
                mi.id as internal_id,
                primary_ext.external_id as primary_ext_id,
                mi.title,
                mi.media_type,
                COALESCE(
                    ms.release_date,
                    ms.first_air_date,
                    CASE WHEN mi.year BETWEEN 1 AND 9999 THEN make_date(mi.year, 1, 1) ELSE NULL END
                ) as release_date,
                ms.overview as overview,
                ms.vote_average::float as tmdb_rating,
                ms.imdb_rating::float as imdb_rating,
                ms.mdblist_score as mdblist_score,
                ms.rt_rating as rt_critic,
                ms.rt_audience_score as rt_audience,
                ms.release_year as release_year,
                ms.poster_path as poster_path,
                ms.backdrop_path as backdrop_path,
                ms.trailer_url as trailer_url,
                ${isAvailableExpr(sql)} AS is_available,
                COALESCE(
                    ms.mdblist_score,
                    (ms.imdb_rating * 10)::integer,
                    (ms.vote_average * 10)::integer,
                    0
                ) as quality_score,
                -- Scoped to the SAME winning source (ms.source) as every other
                -- field above; gates whether tmdb_rating may be shown (see
                -- pickDisplayRating in rating-utils.ts) — media_scalars has no
                -- vote_count column of its own.
                (SELECT (pm_vc.metadata->>'vote_count')::integer
                   FROM provider_metadata pm_vc
                   WHERE pm_vc.media_id = mi.id AND pm_vc.provider = ms.source) as vote_count,
                -- genre ids from the SAME winning source ms read from (media_genres,
                -- migration 16.122.0); NULL when that source carried no genres — same
                -- as the old single-provider pm.metadata->'genres' pick, but now also
                -- resolves scalar-encoded [16,18] ids the old (elem->>'id') dropped.
                (SELECT ARRAY_AGG(mg.genre_id)
                   FROM media_genres mg WHERE mg.media_id = mi.id AND mg.source = ms.source) as genres,
                -- "Show less like this": per-damper mean-centered MAX-pool penalty
                -- ∈ [0,1] (0 when the user has no active dampers), evaluated
                -- against the LIBRARY embedding — same join/column shape as
                -- ShortMoviesStrategy/anime.
                ${buildDamperPenalty(sql, sql`jf_emb.embedding`, damper)} as damper_pen
                ${
                    suppressKidsContent || suppressAnimeContent
                        ? sql`,
                -- Soft cluster (kids/anime) down-rank flag for the FINAL ORDER
                -- BY only — never excludes. Series carry their own genre/
                -- keyword/language metadata directly (media_id = mi.id), no
                -- episode->series hop needed here (unlike the affinity signal
                -- itself, which resolves episodes up to their series). Scoped
                -- to the SAME winning source (ms.source) as the genres column
                -- above and the quality_score fallback chain.
                (CASE WHEN (
                    ${suppressKidsContent} AND EXISTS (
                        SELECT 1 FROM media_genres mg
                        WHERE mg.media_id = mi.id
                          AND mg.source = ms.source
                          AND mg.genre_id = ANY(${KIDS_GENRE_IDS}::int[])
                    )
                  ) OR (
                    ${suppressAnimeContent} AND (
                        EXISTS (
                            SELECT 1 FROM media_keywords mk_anime
                            WHERE mk_anime.media_id = mi.id AND mk_anime.source = ms.source
                              AND mk_anime.keyword_type = 'mdblist' AND mk_anime.keyword = 'anime'
                        )
                        OR (
                            EXISTS (
                                SELECT 1 FROM media_genres mg_anime
                                WHERE mg_anime.media_id = mi.id AND mg_anime.source = ms.source
                                  AND mg_anime.genre_id = ${ANIME_GENRE_ID}
                            )
                            AND EXISTS (
                                SELECT 1 FROM provider_metadata pm_anime
                                WHERE pm_anime.media_id = mi.id AND pm_anime.provider = ms.source
                                  AND pm_anime.metadata->>'original_language' = 'ja'
                            )
                        )
                    )
                  -- quality_score is 0-100 (mdblist_score, or imdb/tmdb rating x10)
                  -- and the WHERE clause above admits nothing below 65 (has_files
                  -- true, imdb_rating >= 6.5), so a flat 60-point penalty always
                  -- drops a matching series below every non-matching qualifying
                  -- candidate — same magnitude as ShortMoviesStrategy's identical
                  -- 0-100 scale down-rank.
                  ) THEN 60 ELSE 0 END) as cluster_penalty`
                        : sql``
                }
            -- Inverted scan (FROM media_scalars): the quality predicates below
            -- (mdblist_score / imdb_rating / vote_average) live on media_scalars,
            -- so scanning it directly lets those predicates drive the access path
            -- instead of a per-row LATERAL lookup for every active tv media_item.
            -- The winning-source filter keeps exactly the one media_scalars row
            -- the LATERAL would have picked per media_id (~12×; mirrors
            -- queryFreshReleases / short-movies). An item with no media_scalars
            -- row is dropped here just as the old LATERAL's NULL scalars failed
            -- every quality branch, so results are identical.
            FROM media_scalars ms
            JOIN media_items mi ON mi.id = ms.media_id AND mi.status = 'active'
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
                AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                AND primary_ext.media_type = mi.media_type
            LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            LEFT JOIN user_watched uw ON uw.media_id = mi.id
            WHERE mi.media_type = 'tv'
              AND ${buildWinningSourceScalarFilterFragment(sql)}
              -- Use year column for established series (more reliable than metadata dates),
              -- but compare against the FULL six-months-ago date rather than truncating to
              -- the year. The previous strict-year gate (mi.year < year-of-sixMonthsAgo)
              -- silently excluded up to ~11 months of qualifying shows (e.g. a series that
              -- premiered in January was dropped all year). make_date(year,1,1) anchors the
              -- series to the start of its release year and admits anything ≥6 months old.
              AND mi.year BETWEEN 1 AND 9999
              AND make_date(mi.year, 1, 1) < ${sixMonthsAgo}::date
              AND (
                (mi.has_files = true AND (
                    ms.mdblist_score >= 65
                    OR (
                        ms.mdblist_score IS NULL
                        AND (
                            ms.imdb_rating >= 6.5
                            OR ms.vote_average >= 7.0
                        )
                    )
                ))
                OR (mi.has_files = false AND (
                    ms.mdblist_score >= 70
                    OR (
                        ms.mdblist_score IS NULL
                        AND (
                            ms.imdb_rating >= 7.0
                            OR ms.vote_average >= 7.5
                        )
                    )
                ))
              )
              AND uw.media_id IS NULL
              -- Exclude disliked content (rating <= 4). Same idiom as the
              -- featured-pick / similar queries; user-scoped so it is safe to bake
              -- into the per-user binge cache.
              AND NOT EXISTS (
                SELECT 1 FROM user_ratings ur
                WHERE ur.user_id = ${userId} AND ur.media_id = mi.id AND ur.rating <= 4
              )
              ${excludeTmdbIds.length > 0 ? sql`AND primary_ext.external_id != ALL(${excludeTmdbIds.map(String)}::text[])` : sql``}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY
                primary_ext.external_id,
                mi.media_type,
                quality_score DESC
        ),
        -- The caller (fetchBingeWorthySeries in for-you.service.ts) enforces a
        -- 70/30 available/requestable quota AFTER this query returns, by
        -- filtering rows on is_available and slicing each pool to its quota.
        -- The previous single mixed ORDER BY is_available DESC ... LIMIT
        -- window let available series (routinely more than limit+5 in a
        -- well-stocked library) evict every requestable row before the caller
        -- ever saw them, silently under-filling the requestable quota. Rank
        -- each class independently so both survive to the caller's split.
        availability_ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY is_available
                ORDER BY ${rankExpr} DESC
            ) as availability_rank
            FROM candidates
        )
        SELECT * FROM availability_ranked
        WHERE availability_rank <= ${limit + 5}
        ORDER BY
            is_available DESC,
            ${rankExpr} DESC
    `;

    return result;
}
