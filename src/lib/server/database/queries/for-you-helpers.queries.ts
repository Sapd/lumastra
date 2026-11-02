// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * For-You Helpers Queries
 *
 * SQL fragments and helper queries for the For-You recommendation service.
 * Contains reusable CTEs and filter builders for recommendation queries.
 *
 * NOTE: This module contains helpers only, not full queries.
 * The for-you.service.ts has highly dynamic queries that build on these helpers.
 *
 * ## Access boundary
 *
 * Every query here that reads `media_items` takes a REQUIRED
 * {@link MediaAccessBoundary}. There is no permissive default: a caller that
 * wants unfiltered rows must spell out `unrestrictedAccess()`, which makes the
 * decision greppable, and omitting the argument is a compile error rather than a
 * silent security downgrade.
 *
 * Each such query short-circuits `deniesEverything(access)` to an empty result
 * BEFORE issuing SQL. That is not merely an optimisation: the boundary
 * predicates are applied inside CTEs/subqueries that Postgres would otherwise
 * materialise in full (and the two-phase ANN path would run two HNSW scans plus
 * a `set_config`) only for `AND false` to discard everything.
 *
 * `getDislikedMediaIds` and `getBehaviorallyDemotedMediaIds` take NO boundary by
 * design — they build negative/exclusion sets from the caller's own rows. Adding
 * a boundary there would SHRINK the exclusion set and therefore ADD rows for a
 * restricted user.
 *
 * @module queries/for-you-helpers
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import {
    buildOverrideAwareMetadataLateralJoinFragment,
    buildMediaScalarsLateralJoinFragment,
    buildWinningSourceScalarFilterFragment,
} from './builders/provider-metadata.builder.js';
import { buildMetadataLateralJoinFragment } from './media-queries.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { AVAILABILITY_EXISTS, isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { buildFusedSimilarityExpr } from './fragments/embedding-fusion.fragments.js';
import type {
    BaseMediaWithExtIdRow,
    AvailabilityFields,
    MetadataContent,
    MetadataRatings,
} from './types/index.js';

// =============================================================================
// Types
// =============================================================================

export interface WatchedMediaRow {
    media_id: string;
    watched_at: Date;
}

export interface RatedMediaRow {
    media_id: string;
    rating: number;
}

export type AvailabilityRow = Pick<BaseMediaWithExtIdRow, 'primary_ext_id'> & {
    media_type: string;
    is_available?: boolean | null;
    can_request?: boolean | null;
    internal_id?: string | null;
    trailer_url?: string | null;
    overview?: string | null;
    rt_critic?: number | null;
    rt_audience?: number | null;
    release_year?: number | null;
};

// =============================================================================
// Watched-content exclusion (composite-key scoped)
// =============================================================================

/**
 * A watched-content exclusion key: `"<external_id>:<movie|tv>"`.
 *
 * CRITICAL: External provider IDs are NOT unique across media types — TMDB ID
 * 1429 is both "25th Hour" (movie) and "Attack on Titan" (tv). Excluding watched
 * content by bare external ID therefore cross-suppresses the other media type.
 * Always scope the exclusion by `(external_id, media_type)`.
 */
export type WatchedExclusionKey = string & {
    readonly __watchedKey: unique symbol;
};

/**
 * Build a composite watched-exclusion key from an external ID and media type.
 * The media type is normalized to the TMDB-style `'movie' | 'tv'`.
 */
export function toWatchedExclusionKey(
    externalId: string | number,
    mediaType: 'movie' | 'tv',
): WatchedExclusionKey {
    return `${externalId}:${mediaType}` as WatchedExclusionKey;
}

/**
 * Build a type-scoped SQL exclusion fragment for already-watched content.
 *
 * Compares each candidate row's `(external_id, media_type)` composite against the
 * provided watched keys, so a watched movie never suppresses a same-ID series
 * (and vice-versa). Returns an empty fragment when there is nothing to exclude.
 *
 * @param sql - postgres tagged-template instance
 * @param watchedKeys - composite keys from {@link toWatchedExclusionKey}
 * @param extIdColumn - SQL expression for the candidate's external id (default `primary_ext.external_id`)
 * @param mediaTypeColumn - SQL expression for the candidate's media type (default `mi.media_type`)
 */
export function buildWatchedExclusionFilter(
    sql: postgres.Sql,
    watchedKeys: readonly WatchedExclusionKey[],
    extIdColumn: postgres.PendingQuery<postgres.Row[]> = sql`primary_ext.external_id`,
    mediaTypeColumn: postgres.PendingQuery<postgres.Row[]> = sql`mi.media_type`,
): postgres.PendingQuery<postgres.Row[]> {
    if (watchedKeys.length === 0) return sql``;
    // Split each composite key `"<external_id>:<movie|tv>"` back into parallel
    // (external_id, media_type) arrays. The media type is always the trailing
    // 'movie'|'tv' segment, so split on the LAST colon (external ids are numeric
    // TMDB strings today, but slicing on the last ':' is robust to any future id
    // that itself contains a colon).
    const ids: string[] = [];
    const types: string[] = [];
    for (const key of watchedKeys as readonly string[]) {
        const sep = key.lastIndexOf(':');
        ids.push(key.slice(0, sep));
        types.push(key.slice(sep + 1));
    }
    // Hashable anti-join instead of a per-row string concat + linear `!= ALL`
    // array scan (the watched list can be hundreds of entries). `unnest` pairs
    // the two arrays positionally into a (ext_id, media_type) set that Postgres
    // can hash. Composite (id, media_type) semantics are preserved EXACTLY so a
    // watched movie never suppresses a same-ID series (see the TMDB-collision
    // note above): media_items.media_type is stored LOWERCASE
    // ('tv','season','episode','movie'), so lower() the column and fold any
    // external/legacy casing ('SERIES','TV', …) into the canonical 'movie'|'tv'
    // bucket the watched keys were built with before comparing.
    return sql`AND NOT EXISTS (
        SELECT 1
        FROM unnest(${ids}::text[], ${types}::text[]) AS w(ext_id, media_type)
        WHERE w.ext_id = (${extIdColumn})::text
          AND w.media_type = CASE
              WHEN lower((${mediaTypeColumn})::text) IN ('tv', 'series', 'season', 'episode')
              THEN 'tv'
              ELSE 'movie'
          END
    )`;
}

// =============================================================================
// CTE Helpers - Common Table Expression builders
// =============================================================================

/**
 * Get user's disliked media IDs (rating <= 4).
 */
export async function getDislikedMediaIds(sql: postgres.Sql, userId: UserId): Promise<string[]> {
    const rows = await sql<{ media_id: string }[]>`
        SELECT media_id
        FROM user_ratings
        WHERE user_id = ${userId}
          AND rating <= 4
    `;
    return rows.map((r) => r.media_id);
}

/**
 * Get media_ids the user has shown a behavioral negative signal toward.
 *
 * A "qualified abandonment" is a `watch_history` row where the user spent at
 * least `minWatchSeconds` of real watch time but stopped before
 * `maxCompletionPct`. Below `minWatchSeconds` we treat the session as a peek,
 * not a rejection — preprod data showed 90.5% of `status='abandoned'` rows
 * are <5min peeks, so unfiltered consumption would be dominated by noise.
 *
 * The `>= 300s` default reuses the project-wide "real watch" convention from
 * `idx_watch_history_trending_v2` (also used in trending detection at
 * `watch-history.queries.ts:186`).
 *
 * Guarded by a `total_engagements >= minTotalEngagements` floor so dev/test
 * accounts (which can have hundreds of qualified abandons from player
 * regression testing) don't poison their own profile.
 */
export async function getBehaviorallyDemotedMediaIds(
    sql: postgres.Sql,
    userId: UserId,
    options: {
        minWatchSeconds?: number;
        maxCompletionPct?: number;
        minTotalEngagements?: number;
    } = {},
): Promise<string[]> {
    const minWatchSeconds = options.minWatchSeconds ?? 300;
    const maxCompletionPct = options.maxCompletionPct ?? 60;
    const minTotalEngagements = options.minTotalEngagements ?? 20;

    const rows = await sql<{ media_id: string }[]>`
        WITH user_engagement AS (
            SELECT COUNT(*) AS total
            FROM watch_history
            WHERE user_id = ${userId}
        )
        SELECT DISTINCT wh.media_id
        FROM watch_history wh
        CROSS JOIN user_engagement ue
        WHERE wh.user_id = ${userId}
          AND ue.total >= ${minTotalEngagements}::bigint
          AND wh.status = 'abandoned'
          AND wh.actual_watch_time_seconds >= ${minWatchSeconds}::integer
          AND wh.completion_percentage IS NOT NULL
          AND wh.completion_percentage < ${maxCompletionPct}::numeric
          AND wh.media_id IS NOT NULL
    `;
    return rows.map((r) => r.media_id);
}

// =============================================================================
// SQL Fragment Builders
// =============================================================================

// NOTE: buildExcludeWatchedFilter and buildExcludeDislikedFilter were removed
// because they used unsafe string interpolation (SQL injection risk) and had no
// call sites. Exclusion logic is handled inline via parameterized queries.

/**
 * Build availability filter for media content.
 * Requires media_file_items table to be accessible (no JOIN alias needed).
 */
export function buildAvailabilityFilter(requireAvailable: boolean): string {
    if (!requireAvailable) {
        return 'TRUE';
    }
    return AVAILABILITY_EXISTS;
}

/**
 * Build embedding source filter.
 * Requires media_embeddings JOIN with appropriate alias.
 *
 * @param source - Embedding source ('library', 'discovery', or 'both')
 * @param alias - Table alias (e.g., 'me', 'emb')
 */
export function buildEmbeddingSourceFilter(
    source: 'library' | 'discovery' | 'both',
    alias: string,
): string {
    switch (source) {
        case 'library':
            return `${alias}.source = '${EMBEDDING_SOURCE.LIBRARY}'`;
        case 'discovery':
            return `${alias}.source = '${EMBEDDING_SOURCE.DISCOVERY}'`;
        case 'both':
            return `${alias}.source IN ('${EMBEDDING_SOURCE.LIBRARY}', '${EMBEDDING_SOURCE.DISCOVERY}')`;
    }
}

// =============================================================================
// Fallback Queries
// =============================================================================

export type RandomPopularItemRow = Pick<BaseMediaWithExtIdRow, 'primary_ext_id' | 'title'> & {
    media_type: string;
    internal_id?: string | null;
};

/**
 * Get a random popular item of a specific media type.
 * Used as fallback when main "Because you watched" queries return no results.
 *
 * Criteria:
 * - Has TMDB external ID of the specified media type
 * - Has embedding from Jellyfin (meaning we can generate recommendations from it)
 * - Is available in Jellyfin library
 * - Has good ratings (IMDB >= 7.0 or MDBList score >= 70)
 * - Active status
 *
 * @param access - REQUIRED media access boundary. `denyAll` short-circuits to
 *   null without a round trip.
 */
export async function getRandomPopularItem(
    sql: postgres.Sql,
    mediaType: 'movie' | 'tv',
    access: MediaAccessBoundary,
): Promise<RandomPopularItemRow | null> {
    if (deniesEverything(access)) return null;

    const rows = await sql<RandomPopularItemRow[]>`
        SELECT mi.id::text as internal_id, ei.external_id as primary_ext_id, ei.media_type, mi.title
        FROM media_items mi
        JOIN external_ids ei ON ei.media_id = mi.id
            AND ei.provider = ${getPrimaryExternalIdProvider()}
            AND ei.media_type = ${mediaType}
        JOIN media_embeddings me ON me.media_id = mi.id
            AND me.source = ${EMBEDDING_SOURCE.LIBRARY}
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.media_type = ${mediaType}
          AND mi.status = 'active'
          AND mi.has_files
          AND (
              (pm.metadata->>'imdb_rating')::float >= 7.0
              OR (pm.metadata->>'mdblist_score')::float >= 70
          )
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY RANDOM()
        LIMIT 1
    `;

    return rows.length > 0 ? rows[0] : null;
}

/**
 * Batch lookup availability information by TMDB IDs.
 * Returns a map keyed by composite key (tmdb_id:media_type).
 *
 * Deliberately does NOT filter on `has_files` — this backs discovery surfaces
 * governed by SHOW_UNAVAILABLE_MEDIA, which need catalog-only rows too.
 *
 * @param sql - PostgreSQL connection
 * @param tmdbIds - Array of TMDB IDs to look up
 * @param access - REQUIRED media access boundary. `denyAll` short-circuits to an
 *   empty map without a round trip.
 * @returns Map of composite keys to availability data
 */
export async function lookupAvailabilityByTmdbIds(
    sql: postgres.Sql,
    tmdbIds: string[],
    access: MediaAccessBoundary,
): Promise<Map<string, AvailabilityRow>> {
    const map = new Map<string, AvailabilityRow>();
    if (tmdbIds.length === 0) return map;
    if (deniesEverything(access)) return map;

    const rows = await sql<AvailabilityRow[]>`
        SELECT DISTINCT ON (primary_ext.external_id, mi.media_type)
            primary_ext.external_id as primary_ext_id,
            mi.media_type,
            mi.id as internal_id,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request,
            pm.metadata->>'trailer_url' as trailer_url,
            pm.metadata->>'overview' as overview,
            (pm.metadata->>'rt_rating')::integer as rt_critic,
            (pm.metadata->>'rt_audience_score')::integer as rt_audience,
            (pm.metadata->>'release_year')::integer as release_year
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
        ${buildMetadataLateralJoinFragment(sql)}
        WHERE mi.status = 'active'
          AND primary_ext.external_id = ANY(${tmdbIds.map(String)}::text[])
          ${buildAgeRatingFilter(sql, access.age)}
          ${buildLibraryAccessFilter(sql, access.library)}
        -- has_files DESC: a file-less twin of the same TMDB title must never
        -- shadow the owned row.
        ORDER BY primary_ext.external_id, mi.media_type, mi.has_files DESC, mi.created_at, mi.id
    `;

    for (const row of rows) {
        const compositeKey = `${row.primary_ext_id}:${row.media_type}`;
        map.set(compositeKey, {
            primary_ext_id: row.primary_ext_id,
            media_type: row.media_type,
            is_available: row.is_available ?? undefined,
            can_request: row.can_request ?? undefined,
            internal_id: row.internal_id ?? undefined,
            trailer_url: row.trailer_url ?? undefined,
            overview: row.overview ?? undefined,
            rt_critic: row.rt_critic ?? undefined,
            rt_audience: row.rt_audience ?? undefined,
            release_year: row.release_year ?? undefined,
        });
    }
    return map;
}

/**
 * Availability lookup by internal media id, for rows that carry no numeric
 * primary (TMDB) id. Same access boundary as {@link lookupAvailabilityByTmdbIds};
 * the result is keyed by the internal id. Ids that are missing, inactive or
 * denied by the boundary are absent from the map.
 */
export async function lookupAvailabilityByInternalIds(
    sql: postgres.Sql,
    internalIds: string[],
    access: MediaAccessBoundary,
): Promise<Map<string, AvailabilityRow>> {
    const map = new Map<string, AvailabilityRow>();
    if (internalIds.length === 0) return map;
    if (deniesEverything(access)) return map;

    const rows = await sql<AvailabilityRow[]>`
        SELECT
            mi.id as internal_id,
            mi.media_type,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request
        FROM media_items mi
        WHERE mi.status = 'active'
          AND mi.id = ANY(${internalIds}::uuid[])
          ${buildAgeRatingFilter(sql, access.age)}
          ${buildLibraryAccessFilter(sql, access.library)}
    `;

    for (const row of rows) {
        if (!row.internal_id) continue;
        map.set(row.internal_id, {
            // Keyed by internal id: the row has no primary external id.
            primary_ext_id: '',
            media_type: row.media_type,
            is_available: row.is_available ?? undefined,
            can_request: row.can_request ?? undefined,
            internal_id: row.internal_id,
        });
    }
    return map;
}

// =============================================================================
// Large CTE Queries
// =============================================================================

export type SimilarMediaRow = BaseMediaWithExtIdRow &
    AvailabilityFields &
    Pick<MetadataContent, 'overview' | 'trailer_url'> &
    Pick<MetadataRatings, 'imdb_rating'> & {
        internal_id: string;
        mdblist_score: number | null;
        rt_critic: number | null;
        rt_audience: number | null;
        release_year: number | null;
        has_library_embedding: boolean;
        has_discovery_embedding: boolean;
        vector_similarity: number | null;
        combined_score: number | null;
    };

export interface SimilarMediaParams {
    userId: UserId;
    mediaType: 'movie' | 'tv';
    tmdbId: number;
    embeddingStr: string;
    rawKeywords: string[];
    stems: string[];
    tasteKeywords: string[];
    watchedKeys: readonly WatchedExclusionKey[];
    limit: number;
    similarWeightDislikedKeyword: number;
    similarWeightDislikedGenre: number;
    /**
     * REQUIRED media access boundary, applied inside the `candidate_media` CTE
     * of both the full-scan and two-phase variants. Without it the similar-media
     * candidate pool would surface denied-library or over-age titles.
     *
     * `denyAll` short-circuits to an empty result before any query runs.
     */
    access: MediaAccessBoundary;
    /**
     * Opt-in HNSW two-phase ANN path (gated by `FEATURE_TWO_PHASE_ANN`). When
     * false/undefined the proven full-scan query runs verbatim. The caller
     * (`fetchSimilarMedia` in for-you.service.ts) reads the env flag once and
     * threads it here. See {@link querySimilarMediaWithAvailabilityTwoPhase}.
     *
     * TODO: promote `FEATURE_TWO_PHASE_ANN` into the config service once A/B
     * tested on preprod (config.ts is owned by another change right now).
     */
    useTwoPhaseAnn?: boolean;
    /**
     * Only return rows with files (`mi.has_files`). Applied inside the candidate
     * pool (both phases of the two-phase path) so `limit` counts available rows
     * only, instead of the caller dropping file-less rows after the fetch.
     */
    availableOnly?: boolean;
}

/**
 * Candidate-pool sizing for the HNSW two-phase similarity rewrite (mirrors the
 * proven pattern in `suggestion-search.queries.ts`). Phase 1 gathers the
 * nearest `limit * MULTIPLIER` (floored at MIN) embeddings per source via the
 * raw `<=>` operator (HNSW-eligible against `idx_me_library_hnsw` /
 * `idx_me_discovery_hnsw`); phase 2 re-scores that bounded pool with the
 * late-fusion / keyword-genre / availability expression. The over-fetch
 * preserves recall when the fused re-score reorders raw-distance candidates.
 */
const SIMILARITY_CANDIDATE_POOL_MULTIPLIER = 5;
const SIMILARITY_CANDIDATE_POOL_MIN = 200;

const logger = Logger.for('ForYouHelpers');

/**
 * Query similar media using 14-CTE similarity search with user taste filtering.
 * This is the largest SQL query in for-you.service (~160 lines).
 *
 * When `params.useTwoPhaseAnn` is set (via `FEATURE_TWO_PHASE_ANN`), dispatches
 * to the HNSW-accelerated {@link querySimilarMediaWithAvailabilityTwoPhase},
 * which produces the SAME output shape/ordering but bounds the fused re-score to
 * a per-source ANN candidate pool instead of scanning every embedded row.
 * Default (flag off) runs the original full-scan query below, unchanged.
 */
export async function querySimilarMediaWithAvailability(
    sql: postgres.Sql,
    params: SimilarMediaParams,
): Promise<SimilarMediaRow[]> {
    if (deniesEverything(params.access)) return [];
    if (params.useTwoPhaseAnn) {
        try {
            return await querySimilarMediaWithAvailabilityTwoPhase(sql, params);
        } catch (err) {
            // Experimental path failed — fall through to the proven full-scan
            // query rather than surfacing a 500. Only reachable under the opt-in
            // FEATURE_TWO_PHASE_ANN flag, so the default path is never affected.
            logger.warn('two-phase ANN similarity failed; falling back to full scan', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return await sql<SimilarMediaRow[]>`
        WITH
        stem_map AS (
            SELECT unnest(${params.rawKeywords}::text[]) as raw_keyword, unnest(${params.stems}::text[]) as stem
        ),
        taste_keywords AS (
            SELECT unnest(${params.tasteKeywords}::text[]) as keyword
        ),
        source_embedding AS (
            SELECT ${params.embeddingStr}::vector as emb
        ),
        disliked_movies AS (
            SELECT
                ur.media_id,
                mi_ur.media_type,
                (SELECT ARRAY_AGG(mk.keyword) FROM media_keywords mk
                   WHERE mk.media_id = ur.media_id AND mk.source = ms.source AND mk.keyword_type = 'mdblist') as mdblist_keywords,
                (SELECT ARRAY_AGG(mg.genre_id) FROM media_genres mg
                   WHERE mg.media_id = ur.media_id AND mg.source = ms.source) as genres
            FROM user_ratings ur
            JOIN media_items mi_ur ON mi_ur.id = ur.media_id
            ${buildMediaScalarsLateralJoinFragment(sql, undefined, 'ur.media_id')}
            WHERE ur.user_id = ${params.userId} AND ur.rating <= 4
        ),
        disliked_stem_counts AS (
            SELECT COALESCE(sm.stem, LOWER(kw)) as stem, COUNT(*) as dislike_count
            FROM disliked_movies dm
            CROSS JOIN LATERAL unnest(dm.mdblist_keywords) as kw
            LEFT JOIN stem_map sm ON LOWER(kw) = sm.raw_keyword
            WHERE dm.mdblist_keywords IS NOT NULL
              AND EXISTS (SELECT 1 FROM taste_keywords tk WHERE tk.keyword = LOWER(kw))
            GROUP BY COALESCE(sm.stem, LOWER(kw))
            HAVING COUNT(*) >= 2
        ),
        disliked_genre_counts AS (
            SELECT g as genre_id, COUNT(*) as dislike_count
            FROM disliked_movies
            CROSS JOIN LATERAL unnest(genres) AS g
            WHERE genres IS NOT NULL
            GROUP BY g
        ),
        hard_filtered_stems AS (
            SELECT stem FROM disliked_stem_counts WHERE dislike_count >= 3
        ),
        -- Every raw keyword whose stem is disliked: mapped keywords via stem_map,
        -- plus unmapped keywords, whose stem is the keyword itself. Lets
        -- candidate_media fetch only these keywords through the media_keywords
        -- primary key instead of every keyword of every candidate (keywords are
        -- stored lowercased by the media_keywords_sync trigger).
        disliked_stem_keywords AS (
            SELECT ARRAY(
                SELECT sm.raw_keyword FROM stem_map sm
                JOIN disliked_stem_counts d ON d.stem = sm.stem
                UNION
                SELECT d.stem FROM disliked_stem_counts d
                WHERE NOT EXISTS (SELECT 1 FROM stem_map sm WHERE sm.raw_keyword = d.stem)
            ) AS keywords
        ),
        candidate_media AS (
            SELECT
                mi.id as internal_id,
                primary_ext.external_id as primary_ext_id,
                mi.title,
                mi.media_type,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request,
                ms.imdb_rating::float as imdb_rating,
                ms.mdblist_score as mdblist_score,
                ms.trailer_url as trailer_url,
                ms.overview as overview,
                ms.rt_rating as rt_critic,
                ms.rt_audience_score as rt_audience,
                ms.release_year as release_year,
                (jf_emb.embedding IS NOT NULL) as has_library_embedding,
                (js_emb.embedding IS NOT NULL) as has_discovery_embedding,
                -- keyword/genre arrays from the winning source (media_keywords/media_genres).
                -- media_genres already resolves object+scalar+string genre ids, matching the
                -- old robust COALESCE extraction here, so genre scoring is unchanged.
                -- Both arrays feed ONLY the dislike penalties below, so skip them when
                -- the user has no disliked stems/genres (the common case), and keep
                -- only keywords that map to a disliked stem otherwise. Fetching every
                -- keyword cost ~170k buffer hits per call on prod.
                CASE WHEN EXISTS (SELECT 1 FROM disliked_stem_counts) THEN
                    (SELECT ARRAY_AGG(mk.keyword) FROM media_keywords mk
                       WHERE mk.media_id = mi.id AND mk.source = ms.source AND mk.keyword_type = 'mdblist'
                         AND mk.keyword = ANY((SELECT keywords FROM disliked_stem_keywords)::text[]))
                END as mdblist_keywords,
                CASE WHEN EXISTS (SELECT 1 FROM disliked_genre_counts) THEN
                    (SELECT ARRAY_AGG(mg.genre_id) FROM media_genres mg
                       WHERE mg.media_id = mi.id AND mg.source = ms.source)
                END as genres,
                ${buildFusedSimilarityExpr(sql, sql`jf_emb.embedding`, sql`js_emb.embedding`, sql`se.emb`)} as vector_similarity
            FROM media_items mi
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
            ${buildMediaScalarsLateralJoinFragment(sql)}
            LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            LEFT JOIN media_embeddings js_emb ON js_emb.media_id = mi.id AND js_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
            CROSS JOIN source_embedding se
            WHERE mi.status = 'active'
              AND mi.media_type = ${params.mediaType}
              AND primary_ext.external_id != ${String(params.tmdbId)}
              AND (jf_emb.embedding IS NOT NULL OR js_emb.embedding IS NOT NULL)
              ${buildWatchedExclusionFilter(sql, params.watchedKeys)}
              AND NOT EXISTS (SELECT 1 FROM disliked_movies dm WHERE dm.media_id = mi.id)
              ${params.availableOnly ? sql`AND mi.has_files` : sql``}
              ${buildLibraryAccessFilter(sql, params.access.library)}
              ${buildAgeRatingFilter(sql, params.access.age)}
        ),
        -- vector_similarity is computed ONCE in candidate_media above; the fused
        -- similarity threshold is applied here in a wrapping CTE instead of being
        -- repeated in candidate_media's WHERE. Postgres does not CSE a CASE
        -- expression across the SELECT list and WHERE clause, so an inlined
        -- 0.5 threshold there re-evaluated the (up to four) vector distances per
        -- row. Filtering on the already-projected column collapses that to one.
        qualified_media AS (
            SELECT * FROM candidate_media WHERE vector_similarity >= 0.5
        ),
        -- Stems are only ever compared against disliked_stem_counts (and its
        -- subset hard_filtered_stems), so keep just those. A candidate with no
        -- disliked stem gets no row, which both consumers already treat as
        -- "no overlap". Unrestricted, this unnested ~300k keyword rows per call
        -- and spilled the sort to disk.
        movie_stems AS (
            SELECT cm.primary_ext_id, cm.media_type,
                   ARRAY_AGG(DISTINCT COALESCE(sm.stem, LOWER(kw))) as stems
            FROM qualified_media cm
            CROSS JOIN LATERAL unnest(cm.mdblist_keywords) as kw
            LEFT JOIN stem_map sm ON LOWER(kw) = sm.raw_keyword
            JOIN disliked_stem_counts dsc_f ON dsc_f.stem = COALESCE(sm.stem, LOWER(kw))
            WHERE cm.mdblist_keywords IS NOT NULL
            GROUP BY cm.primary_ext_id, cm.media_type
        ),
        filtered_media AS (
            SELECT cm.*
            FROM qualified_media cm
            LEFT JOIN movie_stems ms ON cm.primary_ext_id = ms.primary_ext_id AND cm.media_type = ms.media_type
            WHERE NOT EXISTS (
                SELECT 1 FROM hard_filtered_stems hfs WHERE hfs.stem = ANY(ms.stems)
            )
            OR ms.stems IS NULL
        ),
        scored_media AS (
            SELECT
                fm.*,
                COALESCE(dk.total_dislikes, 0) as disliked_keyword_overlap,
                COALESCE(dg.total_dislikes, 0) as disliked_genre_overlap
            FROM filtered_media fm
            LEFT JOIN movie_stems ms ON fm.primary_ext_id = ms.primary_ext_id AND fm.media_type = ms.media_type
            LEFT JOIN LATERAL (
                SELECT SUM(dsc.dislike_count) as total_dislikes
                FROM disliked_stem_counts dsc WHERE dsc.stem = ANY(ms.stems)
            ) dk ON true
            LEFT JOIN LATERAL (
                SELECT SUM(dgc.dislike_count) as total_dislikes
                FROM disliked_genre_counts dgc WHERE dgc.genre_id = ANY(fm.genres)
            ) dg ON true
        ),
        deduped AS (
            SELECT DISTINCT ON (primary_ext_id, media_type)
                internal_id, primary_ext_id, title, media_type, is_available, can_request,
                imdb_rating, mdblist_score, trailer_url, overview, has_library_embedding, has_discovery_embedding,
                vector_similarity, rt_critic, rt_audience, release_year,
                (
                    vector_similarity -
                    (disliked_keyword_overlap * ${params.similarWeightDislikedKeyword}::numeric) -
                    (disliked_genre_overlap * ${params.similarWeightDislikedGenre}::numeric)
                ) as combined_score
            FROM scored_media
            ORDER BY primary_ext_id, media_type, combined_score DESC
        ),
        -- The caller (fetchSimilarMedia → interleaveByAvailability, and the
        -- /api/for-you/similar route's showUnavailableMedia gate) partitions the
        -- result by is_available AFTER this query. A single mixed LIMIT window
        -- lets one availability class evict the other entirely — discovery
        -- (unavailable) candidates outnumber library items ~4:1 and score into
        -- the top of the fused ranking, so library rows never reached the window
        -- and availability-filtered rails collapsed to 0-1 items. Rank each
        -- class independently so both survive to the caller's interleave/filter.
        availability_ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY is_available
                ORDER BY combined_score DESC, vector_similarity DESC
            ) as availability_rank
            FROM deduped
        )
        SELECT internal_id, primary_ext_id, title, media_type, is_available, can_request,
               imdb_rating, mdblist_score, trailer_url, overview, has_library_embedding, has_discovery_embedding,
               vector_similarity, rt_critic, rt_audience, release_year, combined_score
        FROM availability_ranked
        WHERE availability_rank <= ${params.limit + 15}
        ORDER BY combined_score DESC, vector_similarity DESC
    `;
}

/**
 * HNSW two-phase variant of {@link querySimilarMediaWithAvailability}.
 *
 * Phase 1 (`ann_candidates`): per embedding source, gather the nearest
 * `candidatePoolSize` rows by the raw `<=>` cosine distance against the source
 * item's embedding. Each branch is index-eligible — the `library` branch hits
 * the partial `idx_me_library_hnsw` (`WHERE source = 'library'`) and the
 * `discovery` branch hits `idx_me_discovery_hnsw` (`WHERE source =
 * 'discovery'`) — and the two candidate sets are UNIONed. This replaces the
 * full sequential scan the original query pays because its `ORDER BY` /
 * threshold is on a CASE-based fused expression the planner cannot push into an
 * index.
 *
 * Phase 2: the ORIGINAL fused re-score + keyword/genre penalties + availability
 * joins + `>= 0.5` threshold + dedupe, run UNCHANGED but bounded to
 * `mi.id IN (SELECT media_id FROM ann_candidates)` — a few hundred rows instead
 * of the whole embedded catalog. Output columns, final `ORDER BY`, and `LIMIT`
 * are byte-identical to the original path, so callers/types are unaffected.
 *
 * Runs inside a transaction so `hnsw.ef_search` can be raised (SET LOCAL) to the
 * candidate-pool size — the pgvector default (40) is too small to return
 * `candidatePoolSize` neighbours and would silently degrade phase-1 recall.
 */
export async function querySimilarMediaWithAvailabilityTwoPhase(
    sql: postgres.Sql,
    params: SimilarMediaParams,
): Promise<SimilarMediaRow[]> {
    // denyAll must short-circuit BEFORE `sql.begin`. Phase 1 (`ann_candidates`)
    // carries no access filter at all — it joins media_items as `cmi`, an alias
    // buildLibraryAccessFilter cannot even target — so without this guard a
    // deny-everything caller would still open a transaction, run a set_config
    // and two full HNSW scans, only for phase 2's `AND false` to throw the
    // entire pool away.
    if (deniesEverything(params.access)) return [];

    // Restricted users (denied groups / age cap) only see a subset, so a fixed
    // pool can be dominated by rows they can't access and starve phase 2 — widen
    // it when a restriction is active. Separately, phase 2 also drops every
    // already-watched item (buildWatchedExclusionFilter, below) — a pool sized
    // only off `limit` ignores that volume entirely, so a user with a long
    // watch history can have most of the phase-1 pool filtered away before
    // scoring even starts. `watchedKeys.length` is known to the caller (it's
    // already a required param), so fold it in additively on top of the
    // restricted multiplier. Clamp to 1000: pgvector rejects an hnsw.ef_search
    // above that.
    //
    // Scope mapping: this replaces `(deniedGroupIds?.length ?? 0) > 0 ||
    // ageRating != null`. `denyGroups` is exactly the non-empty-array case, and
    // `limit` is exactly the case where buildAgeRatingFilter emits a predicate.
    // The one legacy shape that is NOT carried over is a non-null `ageRating`
    // whose `maxAgeRating` is null: that widened the pool ×3 while emitting NO
    // age predicate, so the widening bought nothing. It is unreachable from
    // every live caller anyway — `restrictedAccess` already collapses it to
    // `age: 'any'` — so no caller's pool size, and therefore no caller's result
    // ordering, changes here.
    const restricted =
        params.access.library.kind === 'denyGroups' || params.access.age.kind === 'limit';
    const excludedCount = params.watchedKeys.length;
    const candidatePoolSize = Math.min(
        Math.max(
            params.limit * SIMILARITY_CANDIDATE_POOL_MULTIPLIER,
            SIMILARITY_CANDIDATE_POOL_MIN,
        ) *
            (restricted ? 3 : 1) +
            excludedCount,
        1000,
    );

    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // ef_search must be >= candidatePoolSize so the HNSW graph traversal
        // visits enough nodes to actually return the requested neighbours.
        await tx`SELECT set_config('hnsw.ef_search', ${String(candidatePoolSize)}, true)`;

        return tx<SimilarMediaRow[]>`
        WITH
        ann_candidates AS (
            (
                SELECT lib_emb.media_id
                FROM media_embeddings lib_emb
                JOIN media_items cmi ON cmi.id = lib_emb.media_id
                    AND cmi.status = 'active'
                    AND cmi.media_type = ${params.mediaType}
                    ${params.availableOnly ? tx`AND cmi.has_files` : tx``}
                WHERE lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
                ORDER BY lib_emb.embedding <=> ${params.embeddingStr}::vector
                LIMIT ${candidatePoolSize}
            )
            UNION
            (
                SELECT disc_emb.media_id
                FROM media_embeddings disc_emb
                JOIN media_items cmi ON cmi.id = disc_emb.media_id
                    AND cmi.status = 'active'
                    AND cmi.media_type = ${params.mediaType}
                    ${params.availableOnly ? tx`AND cmi.has_files` : tx``}
                WHERE disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
                ORDER BY disc_emb.embedding <=> ${params.embeddingStr}::vector
                LIMIT ${candidatePoolSize}
            )
        ),
        stem_map AS (
            SELECT unnest(${params.rawKeywords}::text[]) as raw_keyword, unnest(${params.stems}::text[]) as stem
        ),
        taste_keywords AS (
            SELECT unnest(${params.tasteKeywords}::text[]) as keyword
        ),
        source_embedding AS (
            SELECT ${params.embeddingStr}::vector as emb
        ),
        disliked_movies AS (
            SELECT
                ur.media_id,
                mi_ur.media_type,
                (SELECT ARRAY_AGG(mk.keyword) FROM media_keywords mk
                   WHERE mk.media_id = ur.media_id AND mk.source = ms.source AND mk.keyword_type = 'mdblist') as mdblist_keywords,
                (SELECT ARRAY_AGG(mg.genre_id) FROM media_genres mg
                   WHERE mg.media_id = ur.media_id AND mg.source = ms.source) as genres
            FROM user_ratings ur
            JOIN media_items mi_ur ON mi_ur.id = ur.media_id
            ${buildMediaScalarsLateralJoinFragment(sql, undefined, 'ur.media_id')}
            WHERE ur.user_id = ${params.userId} AND ur.rating <= 4
        ),
        disliked_stem_counts AS (
            SELECT COALESCE(sm.stem, LOWER(kw)) as stem, COUNT(*) as dislike_count
            FROM disliked_movies dm
            CROSS JOIN LATERAL unnest(dm.mdblist_keywords) as kw
            LEFT JOIN stem_map sm ON LOWER(kw) = sm.raw_keyword
            WHERE dm.mdblist_keywords IS NOT NULL
              AND EXISTS (SELECT 1 FROM taste_keywords tk WHERE tk.keyword = LOWER(kw))
            GROUP BY COALESCE(sm.stem, LOWER(kw))
            HAVING COUNT(*) >= 2
        ),
        disliked_genre_counts AS (
            SELECT g as genre_id, COUNT(*) as dislike_count
            FROM disliked_movies
            CROSS JOIN LATERAL unnest(genres) AS g
            WHERE genres IS NOT NULL
            GROUP BY g
        ),
        hard_filtered_stems AS (
            SELECT stem FROM disliked_stem_counts WHERE dislike_count >= 3
        ),
        -- Every raw keyword whose stem is disliked: mapped keywords via stem_map,
        -- plus unmapped keywords, whose stem is the keyword itself. Lets
        -- candidate_media fetch only these keywords through the media_keywords
        -- primary key instead of every keyword of every candidate (keywords are
        -- stored lowercased by the media_keywords_sync trigger).
        disliked_stem_keywords AS (
            SELECT ARRAY(
                SELECT sm.raw_keyword FROM stem_map sm
                JOIN disliked_stem_counts d ON d.stem = sm.stem
                UNION
                SELECT d.stem FROM disliked_stem_counts d
                WHERE NOT EXISTS (SELECT 1 FROM stem_map sm WHERE sm.raw_keyword = d.stem)
            ) AS keywords
        ),
        candidate_media AS (
            SELECT
                mi.id as internal_id,
                primary_ext.external_id as primary_ext_id,
                mi.title,
                mi.media_type,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request,
                ms.imdb_rating::float as imdb_rating,
                ms.mdblist_score as mdblist_score,
                ms.trailer_url as trailer_url,
                ms.overview as overview,
                ms.rt_rating as rt_critic,
                ms.rt_audience_score as rt_audience,
                ms.release_year as release_year,
                (jf_emb.embedding IS NOT NULL) as has_library_embedding,
                (js_emb.embedding IS NOT NULL) as has_discovery_embedding,
                -- keyword/genre arrays from the winning source (media_keywords/media_genres).
                -- Both arrays feed ONLY the dislike penalties below, so skip them when
                -- the user has no disliked stems/genres (the common case), and keep
                -- only keywords that map to a disliked stem otherwise. Fetching every
                -- keyword cost ~170k buffer hits per call on prod.
                CASE WHEN EXISTS (SELECT 1 FROM disliked_stem_counts) THEN
                    (SELECT ARRAY_AGG(mk.keyword) FROM media_keywords mk
                       WHERE mk.media_id = mi.id AND mk.source = ms.source AND mk.keyword_type = 'mdblist'
                         AND mk.keyword = ANY((SELECT keywords FROM disliked_stem_keywords)::text[]))
                END as mdblist_keywords,
                CASE WHEN EXISTS (SELECT 1 FROM disliked_genre_counts) THEN
                    (SELECT ARRAY_AGG(mg.genre_id) FROM media_genres mg
                       WHERE mg.media_id = mi.id AND mg.source = ms.source)
                END as genres,
                ${buildFusedSimilarityExpr(sql, sql`jf_emb.embedding`, sql`js_emb.embedding`, sql`se.emb`)} as vector_similarity
            FROM media_items mi
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
            ${buildMediaScalarsLateralJoinFragment(sql)}
            LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            LEFT JOIN media_embeddings js_emb ON js_emb.media_id = mi.id AND js_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
            CROSS JOIN source_embedding se
            WHERE mi.status = 'active'
              -- Phase-2 bound: only the HNSW candidate pool from phase 1.
              AND mi.id IN (SELECT media_id FROM ann_candidates)
              AND mi.media_type = ${params.mediaType}
              AND primary_ext.external_id != ${String(params.tmdbId)}
              AND (jf_emb.embedding IS NOT NULL OR js_emb.embedding IS NOT NULL)
              ${buildWatchedExclusionFilter(sql, params.watchedKeys)}
              AND NOT EXISTS (SELECT 1 FROM disliked_movies dm WHERE dm.media_id = mi.id)
              ${params.availableOnly ? sql`AND mi.has_files` : sql``}
              ${buildLibraryAccessFilter(sql, params.access.library)}
              ${buildAgeRatingFilter(sql, params.access.age)}
        ),
        -- Same fused-once restructure as the full-scan path so the two scoring
        -- pipelines stay byte-identical: vector_similarity is projected once in
        -- candidate_media, and the 0.5 threshold is applied here rather than
        -- re-evaluated in candidate_media's WHERE (Postgres won't CSE the CASE
        -- across SELECT and WHERE).
        qualified_media AS (
            SELECT * FROM candidate_media WHERE vector_similarity >= 0.5
        ),
        -- Stems are only ever compared against disliked_stem_counts (and its
        -- subset hard_filtered_stems), so keep just those. A candidate with no
        -- disliked stem gets no row, which both consumers already treat as
        -- "no overlap". Unrestricted, this unnested ~300k keyword rows per call
        -- and spilled the sort to disk.
        movie_stems AS (
            SELECT cm.primary_ext_id, cm.media_type,
                   ARRAY_AGG(DISTINCT COALESCE(sm.stem, LOWER(kw))) as stems
            FROM qualified_media cm
            CROSS JOIN LATERAL unnest(cm.mdblist_keywords) as kw
            LEFT JOIN stem_map sm ON LOWER(kw) = sm.raw_keyword
            JOIN disliked_stem_counts dsc_f ON dsc_f.stem = COALESCE(sm.stem, LOWER(kw))
            WHERE cm.mdblist_keywords IS NOT NULL
            GROUP BY cm.primary_ext_id, cm.media_type
        ),
        filtered_media AS (
            SELECT cm.*
            FROM qualified_media cm
            LEFT JOIN movie_stems ms ON cm.primary_ext_id = ms.primary_ext_id AND cm.media_type = ms.media_type
            WHERE NOT EXISTS (
                SELECT 1 FROM hard_filtered_stems hfs WHERE hfs.stem = ANY(ms.stems)
            )
            OR ms.stems IS NULL
        ),
        scored_media AS (
            SELECT
                fm.*,
                COALESCE(dk.total_dislikes, 0) as disliked_keyword_overlap,
                COALESCE(dg.total_dislikes, 0) as disliked_genre_overlap
            FROM filtered_media fm
            LEFT JOIN movie_stems ms ON fm.primary_ext_id = ms.primary_ext_id AND fm.media_type = ms.media_type
            LEFT JOIN LATERAL (
                SELECT SUM(dsc.dislike_count) as total_dislikes
                FROM disliked_stem_counts dsc WHERE dsc.stem = ANY(ms.stems)
            ) dk ON true
            LEFT JOIN LATERAL (
                SELECT SUM(dgc.dislike_count) as total_dislikes
                FROM disliked_genre_counts dgc WHERE dgc.genre_id = ANY(fm.genres)
            ) dg ON true
        ),
        deduped AS (
            SELECT DISTINCT ON (primary_ext_id, media_type)
                internal_id, primary_ext_id, title, media_type, is_available, can_request,
                imdb_rating, mdblist_score, trailer_url, overview, has_library_embedding, has_discovery_embedding,
                vector_similarity, rt_critic, rt_audience, release_year,
                (
                    vector_similarity -
                    (disliked_keyword_overlap * ${params.similarWeightDislikedKeyword}::numeric) -
                    (disliked_genre_overlap * ${params.similarWeightDislikedGenre}::numeric)
                ) as combined_score
            FROM scored_media
            ORDER BY primary_ext_id, media_type, combined_score DESC
        ),
        -- The caller (fetchSimilarMedia → interleaveByAvailability, and the
        -- /api/for-you/similar route's showUnavailableMedia gate) partitions the
        -- result by is_available AFTER this query. A single mixed LIMIT window
        -- lets one availability class evict the other entirely — discovery
        -- (unavailable) candidates outnumber library items ~4:1 and score into
        -- the top of the fused ranking, so library rows never reached the window
        -- and availability-filtered rails collapsed to 0-1 items. Rank each
        -- class independently so both survive to the caller's interleave/filter.
        availability_ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY is_available
                ORDER BY combined_score DESC, vector_similarity DESC
            ) as availability_rank
            FROM deduped
        )
        SELECT internal_id, primary_ext_id, title, media_type, is_available, can_request,
               imdb_rating, mdblist_score, trailer_url, overview, has_library_embedding, has_discovery_embedding,
               vector_similarity, rt_critic, rt_audience, release_year, combined_score
        FROM availability_ranked
        WHERE availability_rank <= ${params.limit + 15}
        ORDER BY combined_score DESC, vector_similarity DESC
    `;
    });
}

export type FreshReleaseRow = BaseMediaWithExtIdRow &
    Pick<MetadataContent, 'overview' | 'trailer_url'> &
    Pick<MetadataRatings, 'imdb_rating' | 'tmdb_rating'> & {
        internal_id: string;
        release_date: Date;
        mdblist_score: number | null;
        rt_critic: number | null;
        rt_audience: number | null;
        release_year: number | null;
        poster_path: string | null;
        backdrop_path: string | null;
        is_available: boolean;
        /** TMDB vote count; gates whether tmdb_rating may be shown as a display rating. */
        vote_count: number | null;
    };

/**
 * Query fresh releases from the last 3 months with availability data.
 *
 * Deliberately does NOT filter on `has_files` — this backs a discovery surface
 * governed by SHOW_UNAVAILABLE_MEDIA.
 *
 * @param access - REQUIRED media access boundary. `denyAll` short-circuits to an
 *   empty array without a round trip.
 */
export async function queryFreshReleases(
    sql: postgres.Sql,
    threeMonthsAgo: string,
    watchedKeys: readonly WatchedExclusionKey[],
    limit: number,
    access: MediaAccessBoundary,
): Promise<FreshReleaseRow[]> {
    if (deniesEverything(access)) return [];

    // Validate date parameter to prevent PostgreSQL "invalid input syntax" error
    const validDate =
        threeMonthsAgo && threeMonthsAgo.trim() !== ''
            ? threeMonthsAgo
            : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // 90 days ago as fallback

    return await sql<FreshReleaseRow[]>`
        WITH deduped AS (
            SELECT DISTINCT ON (primary_ext.external_id, mi.media_type)
                mi.id as internal_id,
                primary_ext.external_id as primary_ext_id,
                mi.title,
                mi.media_type,
                ms.release_date as release_date,
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
                -- Scoped to the SAME winning source (ms.source) as every other
                -- field above; gates whether tmdb_rating may be shown (see
                -- pickDisplayRating in rating-utils.ts) — media_scalars has no
                -- vote_count column of its own.
                (SELECT (pm_vc.metadata->>'vote_count')::integer
                   FROM provider_metadata pm_vc
                   WHERE pm_vc.media_id = mi.id AND pm_vc.provider = ms.source) as vote_count,
                ${isAvailableExpr(sql)} AS is_available
            -- Inverted scan (FROM media_scalars): the release_date range hits
            -- idx_media_scalars_release_date; winning-source filter keeps the LATERAL's
            -- exact per-media_id pick. ~12× faster (see buildWinningSourceScalarFilter).
            FROM media_scalars ms
            JOIN media_items mi ON mi.id = ms.media_id AND mi.status = 'active'
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
            WHERE ms.release_date >= ${validDate}::date
              AND ms.release_date <= NOW()
              AND ${buildWinningSourceScalarFilterFragment(sql)}
              -- Block only path-like / filesystem-noise titles (e.g. "/", "..").
              -- The previous ASCII+umlaut allowlist silently dropped legitimate
              -- accented international titles (é, ñ, ï, å, …); the quality-score
              -- gate below already filters low-signal noise.
              AND mi.title !~ '^[/.\\\\]+$'
              AND (
                ms.mdblist_score >= 50
                OR (
                    ms.mdblist_score IS NULL
                    AND (
                        ms.imdb_rating >= 6.0
                        OR ms.vote_average >= 6.5
                    )
                )
              )
              ${buildWatchedExclusionFilter(sql, watchedKeys)}
              -- Inverted scan (FROM media_scalars JOIN media_items mi): both
              -- builders hardcode/default to the mi alias, which still resolves
              -- here. If this join is ever re-inverted, these two fragments
              -- detach silently — there is no type error for it.
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY
                primary_ext.external_id, mi.media_type,
                is_available DESC,
                COALESCE(ms.mdblist_score, (ms.imdb_rating * 10)::int, (ms.vote_average * 10)::int, 0) DESC,
                ms.release_date DESC
        )
        SELECT * FROM deduped
        ORDER BY is_available DESC, COALESCE(mdblist_score, imdb_rating * 10, tmdb_rating * 10, 0) DESC, release_date DESC
        LIMIT ${limit + 5}
    `;
}
