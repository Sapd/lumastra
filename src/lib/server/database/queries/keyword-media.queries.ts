// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keyword Media Queries Module
 *
 * Queries for fetching media items matching a keyword.
 * Supports both personalized (AI similarity) and non-personalized variants.
 *
 * ## Access boundary
 *
 * Both keyword queries take a REQUIRED `access: MediaAccessBoundary`. There is
 * no permissive default: a caller that genuinely wants unrestricted results must
 * construct `unrestrictedAccess()` so the decision is greppable.
 *
 * The two boundary fragments are emitted INSIDE the `scored_movies` CTE, which
 * is the only correct place. `deduplicated` runs `DISTINCT ON (primary_ext_id)`
 * over `scored_movies`, so filtering after dedup could drop a whole group whose
 * surviving representative happened to be inaccessible even though an accessible
 * sibling row existed. Filtering pre-dedup keeps row visibility and ranking
 * consistent.
 *
 * `deniesEverything(access)` short-circuits to `[]` before any SQL is issued.
 *
 * @module queries/keyword-media
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { buildOverrideAwareMetadataLateralJoin } from './builders/provider-metadata.builder.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import type {
    BaseMediaWithExtIdRow,
    AvailabilityFields,
    MetadataContent,
    ExtendedRatings,
    SimilarityFields,
} from './types/index.js';

// =============================================================================
// Types
// =============================================================================

export interface KeywordMediaParams {
    availableOnly?: boolean;
    keyword: string;
    limit: number;
    offset: number;
    /**
     * REQUIRED media access boundary, applied inside the `scored_movies` CTE.
     * A `denyAll` boundary short-circuits to an empty result before querying.
     */
    access: MediaAccessBoundary;
}

export interface KeywordMediaPersonalizedParams extends KeywordMediaParams {
    userId: UserId;
}

/** Nullable variant of AvailabilityFields for queries where LEFT JOINs may produce nulls */
type NullableAvailability = {
    [K in keyof AvailabilityFields]: AvailabilityFields[K] | null;
};

export type KeywordMediaRow = Omit<BaseMediaWithExtIdRow, 'media_id'> &
    NullableAvailability &
    Pick<MetadataContent, 'overview' | 'release_date'> &
    Pick<
        ExtendedRatings,
        | 'imdb_rating'
        | 'rt_rating'
        | 'rt_audience_score'
        | 'letterboxd_rating'
        | 'mdblist_score'
        | 'popularity'
    > &
    SimilarityFields & {
        internal_id: string | null;
        quality_score: number | null;
    };

// =============================================================================
// Query Functions
// =============================================================================

export async function findKeywordMediaPersonalized(
    sql: postgres.Sql,
    params: KeywordMediaPersonalizedParams,
): Promise<KeywordMediaRow[]> {
    const { keyword, limit, offset, userId, access } = params;
    if (!keyword || keyword.trim().length === 0) return [];
    if (deniesEverything(access)) return [];
    return sql<KeywordMediaRow[]>`
        WITH user_profile AS (
            SELECT catalog_embedding
            FROM user_profiles
            WHERE user_id = ${userId}
        ),
        scored_movies AS (
            SELECT
                mi.id::text as internal_id,
                COALESCE((SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), mi.id::text) as primary_ext_id,
                mi.title,
                mi.media_type,
                (pm.metadata->>'overview')::text as overview,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                (pm.metadata->>'rt_audience_score')::integer as rt_audience_score,
                (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                (pm.metadata->>'mdblist_score')::float as mdblist_score,
                CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                    THEN make_date(mi.year, 1, 1)
                    ELSE NULL
                END as release_date,
                (pm.metadata->>'popularity')::float as popularity,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request,
                jf_emb.embedding as jellyfin_embedding,
                CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'mdblist_keywords') AS elem)
                    ELSE NULL
                END as mdblist_keywords,
                CASE WHEN pm.metadata->'keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'keywords') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'keywords') AS elem)
                    ELSE NULL
                END as keywords,
                -- AI similarity score (0-1, higher is better)
                CASE
                    WHEN jf_emb.embedding IS NOT NULL AND up.catalog_embedding IS NOT NULL
                    THEN 1 - (jf_emb.embedding <=> up.catalog_embedding)
                    ELSE 0.5::real
                END as ai_similarity,
                -- Normalize scores to 0-100 scale
                COALESCE((pm.metadata->>'mdblist_score')::float, 0) AS mdb_norm,
                COALESCE((pm.metadata->>'imdb_rating')::float, 0) * 10 AS imdb_norm,
                COALESCE((pm.metadata->>'rt_rating')::integer, 0) AS rt_norm,
                COALESCE((pm.metadata->>'letterboxd_rating')::float, 0) * 20 AS lb_norm,
                -- Count how many ratings we have for this movie
                (CASE WHEN pm.metadata->>'mdblist_score' IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN pm.metadata->>'imdb_rating' IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN pm.metadata->>'rt_rating' IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN pm.metadata->>'letterboxd_rating' IS NOT NULL THEN 1 ELSE 0 END) AS rating_count
            FROM media_items mi
            ${sql.unsafe(buildOverrideAwareMetadataLateralJoin())}
            LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            CROSS JOIN user_profile up
            WHERE mi.status = 'active'
              AND mi.is_dismissed = false
              ${params.availableOnly ? sql`AND ${isAvailableExpr(sql)}` : sql``}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
        )
        , deduplicated AS (
            SELECT DISTINCT ON (primary_ext_id)
                internal_id, primary_ext_id, title, media_type, overview, imdb_rating, rt_rating, rt_audience_score,
                letterboxd_rating, mdblist_score, release_date, popularity, is_available, can_request,
                ai_similarity, rating_count, mdb_norm, imdb_norm, rt_norm, lb_norm,
                -- Combined quality score using weighted average of available ratings
                CASE WHEN rating_count > 0 THEN
                    (mdb_norm * 0.40 + imdb_norm * 0.25 + rt_norm * 0.20 + lb_norm * 0.15) /
                    (CASE WHEN mdblist_score IS NOT NULL THEN 0.40 ELSE 0 END +
                     CASE WHEN imdb_rating IS NOT NULL THEN 0.25 ELSE 0 END +
                     CASE WHEN rt_rating IS NOT NULL THEN 0.20 ELSE 0 END +
                     CASE WHEN letterboxd_rating IS NOT NULL THEN 0.15 ELSE 0 END)
                ELSE 0 END AS quality_score
            FROM scored_movies
            WHERE (
                ${keyword} = ANY(SELECT LOWER(unnest(mdblist_keywords)))
                OR ${keyword} = ANY(SELECT LOWER(unnest(keywords)))
            )
            ORDER BY primary_ext_id, ai_similarity DESC
        )
        SELECT * FROM deduplicated
        ORDER BY
            -- Final ranking score with AI personalization
            (
                CASE WHEN is_available THEN 5 ELSE 0 END +
                ai_similarity * 30 +
                COALESCE(mdblist_score, 0) * 0.5 +
                CASE
                    WHEN release_date IS NOT NULL AND release_date > NOW() - INTERVAL '3 years'
                    THEN 8 * (1 - EXTRACT(EPOCH FROM (NOW() - release_date)) / (3 * 365.25 * 24 * 60 * 60))
                    ELSE 0
                END +
                LEAST(COALESCE(popularity, 0) / 20, 5)
            ) DESC,
            ai_similarity DESC
        LIMIT ${limit}
        OFFSET ${offset}
    `;
}

export async function findKeywordMedia(
    sql: postgres.Sql,
    params: KeywordMediaParams,
): Promise<KeywordMediaRow[]> {
    const { keyword, limit, offset, access } = params;
    if (!keyword || keyword.trim().length === 0) return [];
    if (deniesEverything(access)) return [];
    return sql<KeywordMediaRow[]>`
        WITH scored_movies AS (
            SELECT
                mi.id::text as internal_id,
                COALESCE((SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), mi.id::text) as primary_ext_id,
                mi.title,
                mi.media_type,
                (pm.metadata->>'overview')::text as overview,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                (pm.metadata->>'rt_audience_score')::integer as rt_audience_score,
                (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                (pm.metadata->>'mdblist_score')::float as mdblist_score,
                CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                    THEN make_date(mi.year, 1, 1)
                    ELSE NULL
                END as release_date,
                (pm.metadata->>'popularity')::float as popularity,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request,
                CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'mdblist_keywords') AS elem)
                    ELSE NULL
                END as mdblist_keywords,
                CASE WHEN pm.metadata->'keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'keywords') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'keywords') AS elem)
                    ELSE NULL
                END as keywords,
                0.5::real as ai_similarity,
                -- Normalize scores to 0-100 scale
                COALESCE((pm.metadata->>'mdblist_score')::float, 0) AS mdb_norm,
                COALESCE((pm.metadata->>'imdb_rating')::float, 0) * 10 AS imdb_norm,
                COALESCE((pm.metadata->>'rt_rating')::integer, 0) AS rt_norm,
                COALESCE((pm.metadata->>'letterboxd_rating')::float, 0) * 20 AS lb_norm,
                -- Count how many ratings we have for this movie
                (CASE WHEN pm.metadata->>'mdblist_score' IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN pm.metadata->>'imdb_rating' IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN pm.metadata->>'rt_rating' IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN pm.metadata->>'letterboxd_rating' IS NOT NULL THEN 1 ELSE 0 END) AS rating_count
            FROM media_items mi
            ${sql.unsafe(buildOverrideAwareMetadataLateralJoin())}
            WHERE mi.status = 'active'
              AND mi.is_dismissed = false
              ${params.availableOnly ? sql`AND ${isAvailableExpr(sql)}` : sql``}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
        )
        , deduplicated AS (
            SELECT DISTINCT ON (primary_ext_id)
                internal_id, primary_ext_id, title, media_type, overview, imdb_rating, rt_rating, rt_audience_score,
                letterboxd_rating, mdblist_score, release_date, popularity, is_available, can_request,
                ai_similarity, rating_count, mdb_norm, imdb_norm, rt_norm, lb_norm,
                -- Combined quality score using weighted average of available ratings
                CASE WHEN rating_count > 0 THEN
                    (mdb_norm * 0.40 + imdb_norm * 0.25 + rt_norm * 0.20 + lb_norm * 0.15) /
                    (CASE WHEN mdblist_score IS NOT NULL THEN 0.40 ELSE 0 END +
                     CASE WHEN imdb_rating IS NOT NULL THEN 0.25 ELSE 0 END +
                     CASE WHEN rt_rating IS NOT NULL THEN 0.20 ELSE 0 END +
                     CASE WHEN letterboxd_rating IS NOT NULL THEN 0.15 ELSE 0 END)
                ELSE 0 END AS quality_score
            FROM scored_movies
            WHERE (
                ${keyword} = ANY(SELECT LOWER(unnest(mdblist_keywords)))
                OR ${keyword} = ANY(SELECT LOWER(unnest(keywords)))
            )
            ORDER BY primary_ext_id
        )
        SELECT * FROM deduplicated
        ORDER BY
            -- Final ranking score
            (
                CASE WHEN is_available THEN 5 ELSE 0 END +
                COALESCE(mdblist_score, 0) * 0.5 +
                CASE
                    WHEN release_date IS NOT NULL AND release_date > NOW() - INTERVAL '3 years'
                    THEN 8 * (1 - EXTRACT(EPOCH FROM (NOW() - release_date)) / (3 * 365.25 * 24 * 60 * 60))
                    ELSE 0
                END +
                LEAST(COALESCE(popularity, 0) / 20, 5)
            ) DESC
        LIMIT ${limit}
        OFFSET ${offset}
    `;
}

/**
 * Returns true if the user has a non-null catalog embedding in `user_profiles`,
 * i.e. an AI taste profile usable for personalized keyword results.
 */
export async function userHasCatalogProfile(sql: postgres.Sql, userId: UserId): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
            SELECT 1
            FROM user_profiles
            WHERE user_id = ${userId}
              AND catalog_embedding IS NOT NULL
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}
