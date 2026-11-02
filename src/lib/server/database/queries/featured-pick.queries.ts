// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Featured Pick Queries
 *
 * SQL queries for fetching candidates for the Featured Pick section.
 * Each function targets a specific criteria (hidden gem, fresh, perfect match, etc.)
 *
 * @module queries/featured-pick
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { isAvailableExpr } from './availability.queries.js';
import type { ExternalIds } from '$lib/types/api-common';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';
import { createExternalIds } from '$lib/utils/external-ids';
import {
    buildOverrideAwareMetadataLateralJoinFragment,
    buildWinningSourceScalarFilterFragment,
} from './builders/provider-metadata.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildDamperPenalty, DAMPER_LAMBDA } from './builders/damper-penalty.builder.js';
import type { DamperContext } from '$lib/server/services/taste-damper.service.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import type { BaseMediaRow, MetadataContent, MetadataRatings } from './types/index.js';
import { KIDS_GENRE_IDS, ANIME_GENRE_ID } from './content-affinity.queries.js';

// =============================================================================
// Types
// =============================================================================

export interface FeaturedCandidate {
    mediaId: string;
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    title: string;
    overview?: string;
    rating?: number;
    popularity?: number;
    releaseDate?: Date;
    releaseYear?: number;
    runtimeMinutes?: number;
    genres?: string[];
    backdropUrl?: string;
    logoUrl?: string;
    trailerUrl?: string;
    isAvailable: boolean;
    canRequest: boolean;
    similarityScore?: number;
    rtCritic?: number;
    rtAudience?: number;
    mdblistScore?: number;
}

type RawFeaturedRow = BaseMediaRow &
    Pick<MetadataContent, 'overview' | 'release_date' | 'runtime_minutes' | 'trailer_url'> &
    Pick<MetadataRatings, 'imdb_rating' | 'popularity'> & {
        primary_ext_id: string;
        imdb_id?: string;
        tvdb_id?: string;
        genres?: string[];
        is_available: boolean;
        similarity_score?: number;
        rt_critic?: number;
        rt_audience?: number;
        mdblist_score?: number;
    };

// =============================================================================
// Helper Functions
// =============================================================================

function transformRow(row: RawFeaturedRow): FeaturedCandidate {
    // Build externalIds object from row data using provider-agnostic helper
    const externalIds: ExternalIds = createExternalIds({
        internal: row.media_id,
        tmdb: row.primary_ext_id,
        imdb: row.imdb_id,
        tvdb: row.tvdb_id,
    });

    return {
        mediaId: row.media_id,
        externalIds,
        mediaType: row.media_type,
        title: row.title,
        overview: row.overview || undefined,
        rating: row.imdb_rating || undefined,
        popularity: row.popularity || undefined,
        releaseDate: row.release_date ? new Date(row.release_date) : undefined,
        releaseYear: row.release_date ? new Date(row.release_date).getFullYear() : undefined,
        runtimeMinutes: row.runtime_minutes || undefined,
        genres: row.genres || undefined,
        trailerUrl: row.trailer_url || undefined,
        isAvailable: row.is_available,
        canRequest: !row.is_available,
        similarityScore: row.similarity_score || undefined,
        rtCritic: row.rt_critic || undefined,
        rtAudience: row.rt_audience || undefined,
        mdblistScore: row.mdblist_score || undefined,
    };
}

/**
 * Build exclude SQL fragment by internal media UUID. Pre-P3 the endpoint
 * passed composite TMDB keys parsed from localStorage; now the exclude
 * set comes from `getActiveFlagTargets(... 'featured_pick_shown')` and
 * arrives as proper UUIDs, so we filter on `mi.id` directly.
 */
function buildExcludeFilter(
    sql: postgres.Sql,
    excludeMediaIds: string[],
): postgres.PendingQuery<postgres.Row[]> {
    if (excludeMediaIds.length === 0) {
        return sql`TRUE`;
    }
    return sql`mi.id != ALL(${excludeMediaIds}::uuid[])`;
}

// =============================================================================
// Query Functions
//
// ACCESS BOUNDARY CONTRACT
//
// Every exported query takes a REQUIRED `access: MediaAccessBoundary` — there
// is no permissive default. A caller that genuinely wants unrestricted results
// must construct `unrestrictedAccess()` so the decision is greppable.
//
// Each fetcher short-circuits to `null` when the boundary denies everything,
// BEFORE issuing any SQL. This is belt-and-braces, not the only enforcement:
// both builders also emit `AND false` for a denyAll scope, and the integration
// suite passes with either layer removed. It saves a pointless round trip and
// keeps deny-all correct even if a future query grows a shape the `AND false`
// fragment cannot reach.
//
// Both axes are spliced with the shared builders: `buildLibraryAccessFilter`
// hardcodes the `mi` alias and `buildAgeRatingFilter` defaults to it — every
// query in this module aliases media_items as `mi`, so no alias override is
// needed. For an `all`/`any` scope both builders emit an empty fragment, so the
// SQL seen by an unrestricted caller is byte-identical to before.
//
// Placement matters in fetchPerfectMatch: both fragments go INSIDE the
// `top_matches` CTE, which applies `LIMIT 5` before the outer
// `SELECT ... FROM top_matches`. The outer query has no `mi` alias in scope, so
// appending there would not compile — and forcing it to work by filtering after
// the top-5 cut would silently change which rows survive.
// =============================================================================

/**
 * Fetch a "Hidden Gem" - high rating (>=7.5) but low popularity.
 * Finds quality content the user likely hasn't heard of.
 *
 * @param access REQUIRED access boundary; see the contract note above.
 */
export async function fetchHiddenGem(
    sql: postgres.Sql,
    userId: UserId,
    excludeMediaIds: string[],
    limit: number,
    access: MediaAccessBoundary,
    minVoteCount: number = 50,
    suppressKidsContent: boolean = false,
    suppressAnimeContent: boolean = false,
): Promise<FeaturedCandidate | null> {
    if (deniesEverything(access)) return null;
    const excludeFilter = buildExcludeFilter(sql, excludeMediaIds);

    const rows = await sql<RawFeaturedRow[]>`
        WITH watched AS (
            SELECT media_id FROM user_media_state WHERE user_id = ${userId} AND is_watched = true
        ),
        disliked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating <= 4
        )
        SELECT
            mi.id as media_id,
            primary_ext.external_id as primary_ext_id,
            imdb_ext.external_id as imdb_id,
            mi.media_type,
            mi.title,
            (pm.metadata->>'overview')::text as overview,
            (pm.metadata->>'imdb_rating')::float as imdb_rating,
            (pm.metadata->>'popularity')::float as popularity,
            NULLIF(pm.metadata->>'release_date', '')::date as release_date,
            (pm.metadata->>'runtime')::integer as runtime_minutes,
            (SELECT array_agg(g) FROM jsonb_array_elements_text(pm.metadata->'genres') g) as genres,
            (pm.metadata->>'trailer_url')::text as trailer_url,
            ${isAvailableExpr(sql)} AS is_available,
            (pm.metadata->>'rt_rating')::integer as rt_critic,
            (pm.metadata->>'rt_audience_score')::integer as rt_audience,
            (pm.metadata->>'mdblist_score')::float as mdblist_score
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            AND primary_ext.media_type = mi.media_type
        LEFT JOIN external_ids imdb_ext ON imdb_ext.media_id = mi.id
            AND imdb_ext.provider = 'imdb'
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.status = 'active'
            AND mi.media_type IN ('movie', 'tv')
            AND NOT EXISTS (SELECT 1 FROM watched w WHERE w.media_id = mi.id)
            AND NOT EXISTS (SELECT 1 FROM disliked d WHERE d.media_id = mi.id)
            AND (pm.metadata->>'imdb_rating')::float >= 7.5
            AND (pm.metadata->>'popularity')::float < 50
            AND (pm.metadata->>'adult')::boolean IS NOT TRUE
            AND (pm.metadata->>'is_color') IS DISTINCT FROM 'false'
            AND COALESCE((pm.metadata->>'vote_count')::int, 0) >= ${minVoteCount}
            AND ${excludeFilter}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY
            (
                (pm.metadata->>'imdb_rating')::float
                -- Soft cluster (kids/anime) down-rank, no exclusion. imdb_rating
                -- is 0-10 (the WHERE filter above already requires >= 7.5), so
                -- subtracting 100 reliably drops a flagged match below every
                -- non-flagged candidate while leaving it in the pool for the
                -- RANDOM() tiebreak.
                - CASE
                    WHEN (
                        (${suppressKidsContent} AND EXISTS (
                            SELECT 1 FROM media_genres mg
                            WHERE mg.media_id = mi.id
                              AND mg.genre_id = ANY(${KIDS_GENRE_IDS})
                        ))
                        OR (${suppressAnimeContent} AND (
                            EXISTS (
                                SELECT 1 FROM media_keywords mk
                                WHERE mk.media_id = mi.id
                                  AND mk.keyword_type = 'mdblist'
                                  AND mk.keyword = 'anime'
                            )
                            OR (
                                EXISTS (
                                    SELECT 1 FROM media_genres mg2
                                    WHERE mg2.media_id = mi.id
                                      AND mg2.genre_id = ${ANIME_GENRE_ID}
                                )
                                AND (pm.metadata->>'original_language') = 'ja'
                            )
                        ))
                    ) THEN 100
                    ELSE 0
                  END
            ) DESC,
            RANDOM()
        LIMIT ${limit}
    `;

    return rows.length > 0 ? transformRow(rows[0]) : null;
}

/**
 * Fetch "Fresh for You" - released in last 90 days and matches user taste.
 * Uses embedding similarity to find new releases the user would enjoy.
 *
 * @param access REQUIRED access boundary; see the contract note above.
 */
export async function fetchFreshForYou(
    sql: postgres.Sql,
    userId: UserId,
    excludeMediaIds: string[],
    limit: number,
    access: MediaAccessBoundary,
    minVoteCount: number = 50,
    suppressKidsContent: boolean = false,
    suppressAnimeContent: boolean = false,
    damper: DamperContext | null = null,
): Promise<FeaturedCandidate | null> {
    if (deniesEverything(access)) return null;
    const excludeFilter = buildExcludeFilter(sql, excludeMediaIds);
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const rows = await sql<RawFeaturedRow[]>`
        WITH watched AS (
            SELECT media_id FROM user_media_state WHERE user_id = ${userId} AND is_watched = true
        ),
        disliked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating <= 4
        ),
        liked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating >= 7
        ),
        user_profile AS (
            SELECT AVG(me.embedding) as avg_embedding
            FROM liked l
            JOIN media_embeddings me ON me.media_id = l.media_id
            WHERE me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
        )
        SELECT
            mi.id as media_id,
            primary_ext.external_id as primary_ext_id,
            imdb_ext.external_id as imdb_id,
            mi.media_type,
            mi.title,
            (pm.metadata->>'overview')::text as overview,
            (pm.metadata->>'imdb_rating')::float as imdb_rating,
            (pm.metadata->>'popularity')::float as popularity,
            NULLIF(pm.metadata->>'release_date', '')::date as release_date,
            (pm.metadata->>'runtime')::integer as runtime_minutes,
            (SELECT array_agg(g) FROM jsonb_array_elements_text(pm.metadata->'genres') g) as genres,
            (pm.metadata->>'trailer_url')::text as trailer_url,
            ${isAvailableExpr(sql)} AS is_available,
            (pm.metadata->>'rt_rating')::integer as rt_critic,
            (pm.metadata->>'rt_audience_score')::integer as rt_audience,
            (pm.metadata->>'mdblist_score')::float as mdblist_score,
            CASE
                WHEN up.avg_embedding IS NOT NULL AND me.embedding IS NOT NULL
                THEN 1 - (me.embedding <=> up.avg_embedding)
                -- Missing embedding → 0 (not 0.5): real cosines mostly sit below
                -- 0.5, so a 0.5 default over-rewarded unscored items.
                ELSE 0
            END as similarity_score
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            AND primary_ext.media_type = mi.media_type
        LEFT JOIN external_ids imdb_ext ON imdb_ext.media_id = mi.id
            AND imdb_ext.provider = 'imdb'
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        LEFT JOIN media_embeddings me ON me.media_id = mi.id AND me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
        CROSS JOIN user_profile up
        WHERE mi.status = 'active'
            AND mi.media_type IN ('movie', 'tv')
            AND NOT EXISTS (SELECT 1 FROM watched w WHERE w.media_id = mi.id)
            AND NOT EXISTS (SELECT 1 FROM disliked d WHERE d.media_id = mi.id)
            AND NULLIF(pm.metadata->>'release_date', '')::date >= ${ninetyDaysAgo.toISOString().split('T')[0]}
            AND (pm.metadata->>'adult')::boolean IS NOT TRUE
            AND (pm.metadata->>'is_color') IS DISTINCT FROM 'false'
            AND COALESCE((pm.metadata->>'vote_count')::int, 0) >= ${minVoteCount}
            AND ${excludeFilter}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY (
            (
                CASE
                    WHEN up.avg_embedding IS NOT NULL AND me.embedding IS NOT NULL
                    THEN 1 - (me.embedding <=> up.avg_embedding)
                    -- Missing embedding → 0 (not 0.5). Profile-less users fall through
                    -- to the imdb_rating tiebreak below, so the section still renders.
                    ELSE 0
                END
                - GREATEST(
                    CASE
                        WHEN up.avg_embedding IS NOT NULL AND me.embedding IS NOT NULL
                        THEN 1 - (me.embedding <=> up.avg_embedding)
                        ELSE 0
                    END, 0
                  ) * ${DAMPER_LAMBDA}::numeric * ${buildDamperPenalty(sql, sql`me.embedding`, damper)}
            )
            -- Soft cluster (kids/anime) down-rank, no exclusion. The similarity
            -- term above is a cosine-derived value bounded to roughly [-1, 1],
            -- so subtracting 10 reliably drops a flagged match below every
            -- non-flagged candidate while leaving it in the pool.
            - CASE
                WHEN (
                    (${suppressKidsContent} AND EXISTS (
                        SELECT 1 FROM media_genres mg
                        WHERE mg.media_id = mi.id
                          AND mg.genre_id = ANY(${KIDS_GENRE_IDS})
                    ))
                    OR (${suppressAnimeContent} AND (
                        EXISTS (
                            SELECT 1 FROM media_keywords mk
                            WHERE mk.media_id = mi.id
                              AND mk.keyword_type = 'mdblist'
                              AND mk.keyword = 'anime'
                        )
                        OR (
                            EXISTS (
                                SELECT 1 FROM media_genres mg2
                                WHERE mg2.media_id = mi.id
                                  AND mg2.genre_id = ${ANIME_GENRE_ID}
                            )
                            AND (pm.metadata->>'original_language') = 'ja'
                        )
                    ))
                ) THEN 10
                ELSE 0
              END
        ) DESC,
                 (pm.metadata->>'imdb_rating')::float DESC NULLS LAST
        LIMIT ${limit}
    `;

    return rows.length > 0 ? transformRow(rows[0]) : null;
}

/**
 * Fetch "Perfect Match" - random from top 5 AI similarity matches.
 * Uses user's embedding profile to find the best matching content.
 *
 * @param access REQUIRED access boundary; see the contract note above. The
 * boundary predicates are spliced INSIDE the `top_matches` CTE, i.e. before its
 * `LIMIT 5` — appending them to the outer SELECT would both fail (no `mi` alias
 * in scope out there) and, if forced, change which rows survive the top-5 cut.
 */
export async function fetchPerfectMatch(
    sql: postgres.Sql,
    userId: UserId,
    excludeMediaIds: string[],
    limit: number,
    access: MediaAccessBoundary,
    minVoteCount: number = 50,
    suppressKidsContent: boolean = false,
    suppressAnimeContent: boolean = false,
    damper: DamperContext | null = null,
): Promise<FeaturedCandidate | null> {
    if (deniesEverything(access)) return null;
    const excludeFilter = buildExcludeFilter(sql, excludeMediaIds);

    // Enrich only candidates that can still reach the exact top five. The
    // rank expression and all access/metadata gates are shared by both passes.
    const rankCandidates = (
        candidates: postgres.PendingQuery<postgres.Row[]>,
    ): postgres.PendingQuery<postgres.Row[]> => sql`
            SELECT
                mi.id as media_id,
                primary_ext.external_id as primary_ext_id,
                imdb_ext.external_id as imdb_id,
                mi.media_type,
                mi.title,
                pm.metadata as pm_metadata,
                ${isAvailableExpr(sql)} AS is_available,
                1 - (me.embedding <=> up.avg_embedding) as similarity_score,
                (
                (
                    (1 - (me.embedding <=> up.avg_embedding))
                    - GREATEST(1 - (me.embedding <=> up.avg_embedding), 0) * ${DAMPER_LAMBDA}::numeric * ${buildDamperPenalty(sql, sql`me.embedding`, damper)}
                )
                -- Soft cluster (kids/anime) down-rank applied BEFORE the top-5
                -- LIMIT below, so a flagged item only survives into the pool
                -- when there aren't 5 stronger non-flagged matches. Similarity
                -- here is bounded to roughly [-1, 1], so subtracting 10
                -- reliably drops a flagged match below every non-flagged
                -- candidate.
                - CASE
                    WHEN (
                        (${suppressKidsContent} AND EXISTS (
                            SELECT 1 FROM media_genres mg
                            WHERE mg.media_id = mi.id
                              AND mg.genre_id = ANY(${KIDS_GENRE_IDS})
                        ))
                        OR (${suppressAnimeContent} AND (
                            EXISTS (
                                SELECT 1 FROM media_keywords mk
                                WHERE mk.media_id = mi.id
                                  AND mk.keyword_type = 'mdblist'
                                  AND mk.keyword = 'anime'
                            )
                            OR (
                                EXISTS (
                                    SELECT 1 FROM media_genres mg2
                                    WHERE mg2.media_id = mi.id
                                      AND mg2.genre_id = ${ANIME_GENRE_ID}
                                )
                                AND (pm.metadata->>'original_language') = 'ja'
                            )
                        ))
                    ) THEN 10
                    ELSE 0
                  END
            ) AS rank_score
            FROM (${candidates}) me
            JOIN media_items mi ON mi.id = me.media_id
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
                AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                AND primary_ext.media_type = mi.media_type
            LEFT JOIN external_ids imdb_ext ON imdb_ext.media_id = mi.id
                AND imdb_ext.provider = 'imdb'
            ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
            CROSS JOIN user_profile up
            WHERE mi.status = 'active'
                AND mi.media_type IN ('movie', 'tv')
                AND up.avg_embedding IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM watched w WHERE w.media_id = mi.id)
                AND NOT EXISTS (SELECT 1 FROM disliked d WHERE d.media_id = mi.id)
                AND (pm.metadata->>'adult')::boolean IS NOT TRUE
            AND (pm.metadata->>'is_color') IS DISTINCT FROM 'false'
                AND COALESCE((pm.metadata->>'vote_count')::int, 0) >= ${minVoteCount}
                AND ${excludeFilter}
                ${buildLibraryAccessFilter(sql, access.library)}
                ${buildAgeRatingFilter(sql, access.age)}
    `;

    const rows = await sql.begin(async (tx) => {
        // LIMIT alone cannot grow a default HNSW scan beyond ef_search (40).
        // Iterative scanning lets each gated pass actually fill its larger pool;
        // SET LOCAL confines this setting to this read transaction.
        await tx`SET LOCAL hnsw.iterative_scan = 'strict_order'`;
        return tx<RawFeaturedRow[]>`
        WITH watched AS (
            SELECT media_id FROM user_media_state WHERE user_id = ${userId} AND is_watched = true
        ),
        disliked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating <= 4
        ),
        liked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating >= 7
        ),
        user_profile AS MATERIALIZED (
            SELECT AVG(me.embedding) as avg_embedding
            FROM liked l
            JOIN media_embeddings me ON me.media_id = l.media_id
            WHERE me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
        ),
        ann_candidates AS MATERIALIZED (
            (SELECT media_id, embedding FROM media_embeddings
             WHERE source = 'library' AND (SELECT avg_embedding FROM user_profile) IS NOT NULL

             ORDER BY embedding <=> (SELECT avg_embedding FROM user_profile) LIMIT 64)
            UNION ALL
            (SELECT media_id, embedding FROM media_embeddings
             WHERE source = 'discovery' AND (SELECT avg_embedding FROM user_profile) IS NOT NULL

             ORDER BY embedding <=> (SELECT avg_embedding FROM user_profile) LIMIT 64)
        ),
        seed_64 AS MATERIALIZED (
            ${rankCandidates(sql`SELECT * FROM ann_candidates`)}
            ORDER BY rank_score DESC LIMIT 5
        ),
        ready_64 AS (
            SELECT (COUNT(*) = 5 AND MIN(rank_score) >= 0) AS ready
            FROM seed_64
        ),
        ann_256 AS MATERIALIZED (
            (SELECT media_id, embedding FROM media_embeddings
             WHERE source = 'library' AND (SELECT avg_embedding FROM user_profile) IS NOT NULL
               AND NOT (SELECT ready FROM ready_64)
             ORDER BY embedding <=> (SELECT avg_embedding FROM user_profile) LIMIT 256)
            UNION ALL
            (SELECT media_id, embedding FROM media_embeddings
             WHERE source = 'discovery' AND (SELECT avg_embedding FROM user_profile) IS NOT NULL
               AND NOT (SELECT ready FROM ready_64)
             ORDER BY embedding <=> (SELECT avg_embedding FROM user_profile) LIMIT 256)
        ),
        seed_256 AS MATERIALIZED (
            ${rankCandidates(sql`SELECT * FROM ann_256`)}
            ORDER BY rank_score DESC LIMIT 5
        ),
        ready_256 AS (
            SELECT (SELECT ready FROM ready_64) OR (COUNT(*) = 5 AND MIN(rank_score) >= 0) AS ready
            FROM seed_256
        ),
        ann_1024 AS MATERIALIZED (
            (SELECT media_id, embedding FROM media_embeddings
             WHERE source = 'library' AND (SELECT avg_embedding FROM user_profile) IS NOT NULL
               AND NOT (SELECT ready FROM ready_256)
             ORDER BY embedding <=> (SELECT avg_embedding FROM user_profile) LIMIT 1024)
            UNION ALL
            (SELECT media_id, embedding FROM media_embeddings
             WHERE source = 'discovery' AND (SELECT avg_embedding FROM user_profile) IS NOT NULL
               AND NOT (SELECT ready FROM ready_256)
             ORDER BY embedding <=> (SELECT avg_embedding FROM user_profile) LIMIT 1024)
        ),
        seed_1024 AS MATERIALIZED (
            ${rankCandidates(sql`SELECT * FROM ann_1024`)}
            ORDER BY rank_score DESC LIMIT 5
        ),
        seed_matches AS MATERIALIZED (
            -- Retry after access/metadata gates or soft suppression weaken the
            -- bound. Later ANN passes run only if the preceding pass needs more.
            SELECT * FROM seed_64 WHERE (SELECT ready FROM ready_64)
            UNION ALL
            SELECT * FROM seed_256 WHERE NOT (SELECT ready FROM ready_64)
                AND (SELECT ready FROM ready_256)
            UNION ALL
            SELECT * FROM seed_1024 WHERE NOT (SELECT ready FROM ready_256)
        ),
        cutoff AS (
            SELECT CASE WHEN COUNT(*) = 5 THEN MIN(rank_score)
                ELSE '-Infinity'::float8 END AS score FROM seed_matches
        ),
        candidates AS MATERIALIZED (
            -- HNSW is approximate. A full distance-only pass certifies the
            -- bound; expensive metadata joins happen AFTER this cut. Penalties
            -- only reduce scores, so raw similarity is a safe upper bound.
            SELECT me.media_id, me.embedding
            FROM media_embeddings me CROSS JOIN user_profile up CROSS JOIN cutoff
            WHERE me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
              AND up.avg_embedding IS NOT NULL
              AND (1 - (me.embedding <=> up.avg_embedding) >= cutoff.score
                   OR (me.embedding <=> up.avg_embedding) IS NULL)
        ),
        top_matches AS (
            ${rankCandidates(sql`SELECT * FROM candidates`)}
            ORDER BY rank_score DESC LIMIT 5
        )
        SELECT
            media_id,
            primary_ext_id,
            imdb_id,
            media_type,
            title,
            (pm_metadata->>'overview')::text as overview,
            (pm_metadata->>'imdb_rating')::float as imdb_rating,
            (pm_metadata->>'popularity')::float as popularity,
            NULLIF(pm_metadata->>'release_date', '')::date as release_date,
            (pm_metadata->>'runtime')::integer as runtime_minutes,
            (SELECT array_agg(g) FROM jsonb_array_elements_text(pm_metadata->'genres') g) as genres,
            (pm_metadata->>'trailer_url')::text as trailer_url,
            is_available,
            similarity_score,
            (pm_metadata->>'rt_rating')::integer as rt_critic,
            (pm_metadata->>'rt_audience_score')::integer as rt_audience,
            (pm_metadata->>'mdblist_score')::float as mdblist_score
        FROM top_matches
        ORDER BY RANDOM()
        LIMIT ${limit}
    `;
    });

    return rows.length > 0 ? transformRow(rows[0]) : null;
}

/**
 * Fetch "Overlooked Classic" - 10+ years old with high rating (>=8.0).
 * Surfaces timeless content that may have been forgotten.
 *
 * @param access REQUIRED access boundary; see the contract note above.
 */
export async function fetchOverlookedClassic(
    sql: postgres.Sql,
    userId: UserId,
    excludeMediaIds: string[],
    limit: number,
    access: MediaAccessBoundary,
    minVoteCount: number = 50,
    suppressKidsContent: boolean = false,
    suppressAnimeContent: boolean = false,
): Promise<FeaturedCandidate | null> {
    if (deniesEverything(access)) return null;
    const excludeFilter = buildExcludeFilter(sql, excludeMediaIds);
    const tenYearsAgo = new Date();
    tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10);

    const rows = await sql<RawFeaturedRow[]>`
        WITH watched AS (
            SELECT media_id FROM user_media_state WHERE user_id = ${userId} AND is_watched = true
        ),
        disliked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating <= 4
        )
        SELECT
            mi.id as media_id,
            primary_ext.external_id as primary_ext_id,
            imdb_ext.external_id as imdb_id,
            mi.media_type,
            mi.title,
            (pm.metadata->>'overview')::text as overview,
            (pm.metadata->>'imdb_rating')::float as imdb_rating,
            (pm.metadata->>'popularity')::float as popularity,
            NULLIF(pm.metadata->>'release_date', '')::date as release_date,
            (pm.metadata->>'runtime')::integer as runtime_minutes,
            (SELECT array_agg(g) FROM jsonb_array_elements_text(pm.metadata->'genres') g) as genres,
            (pm.metadata->>'trailer_url')::text as trailer_url,
            ${isAvailableExpr(sql)} AS is_available,
            (pm.metadata->>'rt_rating')::integer as rt_critic,
            (pm.metadata->>'rt_audience_score')::integer as rt_audience,
            (pm.metadata->>'mdblist_score')::float as mdblist_score
        -- Inverted scan (FROM media_scalars): imdb_rating/release_date below are
        -- both indexed media_scalars columns, so scanning it directly (instead of
        -- the old LATERAL-per-active-item pick) lets those two predicates drive
        -- the access path. The winning-source filter keeps exactly the one
        -- media_scalars row (and therefore the one provider_metadata row, joined
        -- below by provider = ms.source) that the old LATERAL would have picked
        -- per media_id (preferred_provider first, then the chain) — mirrors
        -- queryFreshReleases / binge-worthy. adult /
        -- is_color / vote_count / original_language have no media_scalars column,
        -- so they still read provider_metadata, but now only for the much smaller
        -- rating/date-qualified candidate set. Verified identical result rows
        -- against the old LATERAL form on prod (~20x faster: ~1000ms -> ~50ms).
        FROM media_scalars ms
        JOIN media_items mi ON mi.id = ms.media_id
            AND mi.status = 'active'
            AND mi.media_type IN ('movie', 'tv')
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            AND primary_ext.media_type = mi.media_type
        LEFT JOIN external_ids imdb_ext ON imdb_ext.media_id = mi.id
            AND imdb_ext.provider = 'imdb'
        LEFT JOIN LATERAL (
            SELECT media_id, provider, metadata, field_sources, fetched_at, updated_at
            FROM provider_metadata
            WHERE media_id = mi.id
              AND provider = ms.source
            LIMIT 1
        ) pm ON true
        -- Override-aware, like the LATERAL this replaced: an item's
        -- preferred_provider wins before the chain order.
        WHERE ${buildWinningSourceScalarFilterFragment(sql, undefined, 'mi.id', 'ms', 'mi.preferred_provider')}
            AND NOT EXISTS (SELECT 1 FROM watched w WHERE w.media_id = mi.id)
            AND NOT EXISTS (SELECT 1 FROM disliked d WHERE d.media_id = mi.id)
            AND ms.imdb_rating >= 8.0
            AND ms.release_date <= ${tenYearsAgo.toISOString().split('T')[0]}
            AND (pm.metadata->>'adult')::boolean IS NOT TRUE
            AND (pm.metadata->>'is_color') IS DISTINCT FROM 'false'
            AND COALESCE((pm.metadata->>'vote_count')::int, 0) >= ${minVoteCount}
            AND ${excludeFilter}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY
            (
                ms.imdb_rating::float
                -- Soft cluster (kids/anime) down-rank, no exclusion. imdb_rating
                -- is 0-10 (the WHERE filter above already requires >= 8.0), so
                -- subtracting 100 reliably drops a flagged match below every
                -- non-flagged candidate while leaving it in the pool for the
                -- RANDOM() tiebreak.
                - CASE
                    WHEN (
                        (${suppressKidsContent} AND EXISTS (
                            SELECT 1 FROM media_genres mg
                            WHERE mg.media_id = mi.id
                              AND mg.genre_id = ANY(${KIDS_GENRE_IDS})
                        ))
                        OR (${suppressAnimeContent} AND (
                            EXISTS (
                                SELECT 1 FROM media_keywords mk
                                WHERE mk.media_id = mi.id
                                  AND mk.keyword_type = 'mdblist'
                                  AND mk.keyword = 'anime'
                            )
                            OR (
                                EXISTS (
                                    SELECT 1 FROM media_genres mg2
                                    WHERE mg2.media_id = mi.id
                                      AND mg2.genre_id = ${ANIME_GENRE_ID}
                                )
                                AND (pm.metadata->>'original_language') = 'ja'
                            )
                        ))
                    ) THEN 100
                    ELSE 0
                  END
            ) DESC,
            RANDOM()
        LIMIT ${limit}
    `;

    return rows.length > 0 ? transformRow(rows[0]) : null;
}

/**
 * Fetch "Buzzing Now" - currently trending and matches user taste.
 * Combines popularity with embedding similarity.
 *
 * @param access REQUIRED access boundary; see the contract note above.
 */
export async function fetchBuzzingNow(
    sql: postgres.Sql,
    userId: UserId,
    excludeMediaIds: string[],
    limit: number,
    access: MediaAccessBoundary,
    minVoteCount: number = 50,
    suppressKidsContent: boolean = false,
    suppressAnimeContent: boolean = false,
    damper: DamperContext | null = null,
): Promise<FeaturedCandidate | null> {
    if (deniesEverything(access)) return null;
    const excludeFilter = buildExcludeFilter(sql, excludeMediaIds);

    const rows = await sql<RawFeaturedRow[]>`
        WITH watched AS (
            SELECT media_id FROM user_media_state WHERE user_id = ${userId} AND is_watched = true
        ),
        disliked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating <= 4
        ),
        liked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating >= 7
        ),
        user_profile AS (
            SELECT AVG(me.embedding) as avg_embedding
            FROM liked l
            JOIN media_embeddings me ON me.media_id = l.media_id
            WHERE me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
        )
        SELECT
            mi.id as media_id,
            primary_ext.external_id as primary_ext_id,
            imdb_ext.external_id as imdb_id,
            mi.media_type,
            mi.title,
            (pm.metadata->>'overview')::text as overview,
            (pm.metadata->>'imdb_rating')::float as imdb_rating,
            (pm.metadata->>'popularity')::float as popularity,
            NULLIF(pm.metadata->>'release_date', '')::date as release_date,
            (pm.metadata->>'runtime')::integer as runtime_minutes,
            (SELECT array_agg(g) FROM jsonb_array_elements_text(pm.metadata->'genres') g) as genres,
            (pm.metadata->>'trailer_url')::text as trailer_url,
            ${isAvailableExpr(sql)} AS is_available,
            (pm.metadata->>'rt_rating')::integer as rt_critic,
            (pm.metadata->>'rt_audience_score')::integer as rt_audience,
            (pm.metadata->>'mdblist_score')::float as mdblist_score,
            CASE
                WHEN up.avg_embedding IS NOT NULL AND me.embedding IS NOT NULL
                THEN 1 - (me.embedding <=> up.avg_embedding)
                -- Missing embedding → 0 (not 0.5): real cosines mostly sit below
                -- 0.5, so a 0.5 default over-rewarded unscored items.
                ELSE 0
            END as similarity_score
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            AND primary_ext.media_type = mi.media_type
        LEFT JOIN external_ids imdb_ext ON imdb_ext.media_id = mi.id
            AND imdb_ext.provider = 'imdb'
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        LEFT JOIN media_embeddings me ON me.media_id = mi.id AND me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
        CROSS JOIN user_profile up
        WHERE mi.status = 'active'
            AND mi.media_type IN ('movie', 'tv')
            AND NOT EXISTS (SELECT 1 FROM watched w WHERE w.media_id = mi.id)
            AND NOT EXISTS (SELECT 1 FROM disliked d WHERE d.media_id = mi.id)
            AND (pm.metadata->>'popularity')::float >= 100
            AND (pm.metadata->>'adult')::boolean IS NOT TRUE
            AND (pm.metadata->>'is_color') IS DISTINCT FROM 'false'
            AND COALESCE((pm.metadata->>'vote_count')::int, 0) >= ${minVoteCount}
            AND ${excludeFilter}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY (
            (pm.metadata->>'popularity')::float * COALESCE(
                CASE
                    -- No user profile: fall back to pure popularity ordering
                    -- (neutral multiplier 1), NOT the old 0.5 freebie.
                    WHEN up.avg_embedding IS NULL THEN 1
                    WHEN me.embedding IS NOT NULL THEN 1 - (me.embedding <=> up.avg_embedding)
                    -- Profile present but this item is unscored → sink it (0).
                    ELSE 0
                END, 0
            ) * (1 - ${DAMPER_LAMBDA}::numeric * ${buildDamperPenalty(sql, sql`me.embedding`, damper)})
            -- Soft cluster (kids/anime) down-rank, no exclusion. The sort key
            -- above is TMDB popularity (>= 100 per the WHERE filter) times a
            -- multiplier in roughly [0, 1] — popularity practically never
            -- reaches six figures, so subtracting 1,000,000 reliably drops a
            -- flagged match below every non-flagged candidate while leaving
            -- it in the pool.
            - CASE
                WHEN (
                    (${suppressKidsContent} AND EXISTS (
                        SELECT 1 FROM media_genres mg
                        WHERE mg.media_id = mi.id
                          AND mg.genre_id = ANY(${KIDS_GENRE_IDS})
                    ))
                    OR (${suppressAnimeContent} AND (
                        EXISTS (
                            SELECT 1 FROM media_keywords mk
                            WHERE mk.media_id = mi.id
                              AND mk.keyword_type = 'mdblist'
                              AND mk.keyword = 'anime'
                        )
                        OR (
                            EXISTS (
                                SELECT 1 FROM media_genres mg2
                                WHERE mg2.media_id = mi.id
                                  AND mg2.genre_id = ${ANIME_GENRE_ID}
                            )
                            AND (pm.metadata->>'original_language') = 'ja'
                        )
                    ))
                ) THEN 1000000
                ELSE 0
              END
        ) DESC
        LIMIT ${limit}
    `;

    return rows.length > 0 ? transformRow(rows[0]) : null;
}

/**
 * Fetch a featured pick by criteria.
 * Dispatches to the appropriate query function based on criteria.
 *
 * @param access REQUIRED access boundary, forwarded verbatim to whichever
 * fetcher the criteria selects. Deny-all short-circuits here as well as in
 * every fetcher, so an unknown criteria and a closed boundary both return null
 * without touching the database.
 */
export async function fetchFeaturedPickByCriteria(
    sql: postgres.Sql,
    criteria: string,
    userId: UserId,
    excludeMediaIds: string[],
    access: MediaAccessBoundary,
    minVoteCount: number = 50,
    suppressKidsContent: boolean = false,
    suppressAnimeContent: boolean = false,
    damper: DamperContext | null = null,
): Promise<FeaturedCandidate | null> {
    if (deniesEverything(access)) return null;
    switch (criteria) {
        case 'hidden-gem':
            return fetchHiddenGem(
                sql,
                userId,
                excludeMediaIds,
                1,
                access,
                minVoteCount,
                suppressKidsContent,
                suppressAnimeContent,
            );
        case 'fresh-for-you':
            return fetchFreshForYou(
                sql,
                userId,
                excludeMediaIds,
                1,
                access,
                minVoteCount,
                suppressKidsContent,
                suppressAnimeContent,
                damper,
            );
        case 'perfect-match':
            return fetchPerfectMatch(
                sql,
                userId,
                excludeMediaIds,
                1,
                access,
                minVoteCount,
                suppressKidsContent,
                suppressAnimeContent,
                damper,
            );
        case 'overlooked-classic':
            return fetchOverlookedClassic(
                sql,
                userId,
                excludeMediaIds,
                1,
                access,
                minVoteCount,
                suppressKidsContent,
                suppressAnimeContent,
            );
        case 'buzzing-now':
            return fetchBuzzingNow(
                sql,
                userId,
                excludeMediaIds,
                1,
                access,
                minVoteCount,
                suppressKidsContent,
                suppressAnimeContent,
                damper,
            );
        default:
            return null;
    }
}
