// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Stats Queries
 *
 * Pure SQL queries for the admin embedding statistics dashboard.
 * Runs 7 parallel queries to gather comprehensive stats on media items,
 * data quality, and embedding vector coverage.
 *
 * Tables / views:
 * - media_items: Core catalog with internal UUIDs
 * - external_ids: Maps internal IDs to external provider IDs
 * - media_file_items: Tracks locally available files
 * - v_media_metadata: Aggregated metadata view
 * - media_embeddings: Embedding vectors
 *
 * @module queries/embedding-stats
 */

import type postgres from 'postgres';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';

// =============================================================================
// Types
// =============================================================================

export interface QualityRow {
    with_mdblist_keywords: string;
    with_mdblist_score: string;
    with_streaming_services: string;
    missing_genres: string;
    missing_overview: string;
    missing_actors: string;
    missing_directors: string;
    very_short_overview: string;
    avg_overview_length: number | string;
    avg_actor_count: number | string;
    avg_genre_count: number | string;
}

export interface CoverageRow {
    has_library_embedding: string;
    has_discovery_embedding: string;
    has_both_embeddings: string;
    no_embeddings: string;
}

export interface EmbeddingItemRow {
    id: string;
    primary_ext_id: string;
    title: string;
    media_type: string;
    genres: number[] | null;
    created_at?: Date;
}

export interface MediaTypeCountRow {
    media_type: string;
    count: string;
}

export interface SourceCountRow {
    source: string;
    count: string;
}

export interface OverviewCountsRow {
    without_external_id: string;
    in_library: string;
    requestable_only: string;
}

export interface MusicQualityRow {
    total_tracks: string;
    with_embedding: string;
    missing_artist: string;
    missing_album: string;
    missing_genre: string;
    missing_bpm: string;
    missing_mood_tags: string;
    avg_genre_count: number | string;
}

export interface MusicItemRow {
    id: string;
    title: string;
    artist: string;
    album: string | null;
    genres: string[] | null;
    has_embedding: boolean;
    created_at?: Date;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Dynamic overview stats — no hardcoded media types.
 * Used by the always-visible overview section.
 */
export async function getEmbeddingOverviewStats(sql: postgres.Sql): Promise<{
    mediaTypeCounts: MediaTypeCountRow[];
    sourceCounts: SourceCountRow[];
    overviewCounts: OverviewCountsRow[];
}> {
    const [mediaTypeCounts, sourceCounts, overviewCounts] = await Promise.all([
        sql<MediaTypeCountRow[]>`
            SELECT media_type, COUNT(*)::text as count
            FROM media_items
            WHERE status = 'active'
            GROUP BY media_type
            ORDER BY count DESC
        `,
        sql<SourceCountRow[]>`
            SELECT me.source, COUNT(DISTINCT me.media_id)::text as count
            FROM media_embeddings me
            JOIN media_items mi ON mi.id = me.media_id
            WHERE mi.status = 'active'
            GROUP BY me.source
            ORDER BY count DESC
        `,
        sql<OverviewCountsRow[]>`
            SELECT
                COUNT(*) FILTER (
                    WHERE NOT EXISTS(
                        SELECT 1 FROM external_ids ei
                        WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file'
                    )
                )::text as without_external_id,
                COUNT(*) FILTER (WHERE ${isAvailableExpr(sql)})::text as in_library,
                COUNT(*) FILTER (WHERE ${canRequestExpr(sql)})::text as requestable_only
            FROM media_items mi
            WHERE mi.status = 'active'
        `,
    ]);

    return { mediaTypeCounts, sourceCounts, overviewCounts };
}

/**
 * Video-domain stats — movie/tv quality metrics, samples, coverage.
 * Loaded lazily when Video tab is active.
 */
export async function getVideoEmbeddingStats(sql: postgres.Sql): Promise<{
    quality: QualityRow[];
    coverage: CoverageRow[];
    recent: EmbeddingItemRow[];
    noExternalId: EmbeddingItemRow[];
    sample: EmbeddingItemRow[];
}> {
    const [quality, coverage, recent, noExternalId, sample] = await Promise.all([
        sql<QualityRow[]>`
                SELECT
                    COUNT(*) FILTER (WHERE vm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_array_length(vm.metadata->'mdblist_keywords') > 0) as with_mdblist_keywords,
                    COUNT(*) FILTER (WHERE vm.metadata->>'mdblist_score' IS NOT NULL) as with_mdblist_score,
                    COUNT(*) FILTER (WHERE vm.metadata->'streaming_services' IS NOT NULL AND jsonb_array_length(vm.metadata->'streaming_services') > 0) as with_streaming_services,
                    COUNT(*) FILTER (WHERE vm.metadata->'genres' IS NULL OR jsonb_array_length(COALESCE(vm.metadata->'genres', '[]'::jsonb)) = 0) as missing_genres,
                    COUNT(*) FILTER (WHERE vm.metadata->>'overview' IS NULL OR vm.metadata->>'overview' = '') as missing_overview,
                    COUNT(*) FILTER (WHERE vm.metadata->'actors' IS NULL OR jsonb_array_length(COALESCE(vm.metadata->'actors', '[]'::jsonb)) = 0) as missing_actors,
                    COUNT(*) FILTER (WHERE vm.metadata->'directors' IS NULL OR jsonb_array_length(COALESCE(vm.metadata->'directors', '[]'::jsonb)) = 0) as missing_directors,
                    COUNT(*) FILTER (WHERE LENGTH(COALESCE(vm.metadata->>'overview', '')) < 50) as very_short_overview,
                    COALESCE(ROUND(AVG(LENGTH(COALESCE(vm.metadata->>'overview', ''))))::int, 0) as avg_overview_length,
                    COALESCE(ROUND(AVG(jsonb_array_length(COALESCE(vm.metadata->'actors', '[]'::jsonb))), 1), 0) as avg_actor_count,
                    COALESCE(ROUND(AVG(jsonb_array_length(COALESCE(vm.metadata->'genres', '[]'::jsonb))), 1), 0) as avg_genre_count
                FROM media_items mi
                LEFT JOIN v_media_metadata vm ON vm.media_id = mi.id
                WHERE mi.status = 'active'
                  AND mi.media_type IN ('movie', 'tv')
            `,
        sql<CoverageRow[]>`
                SELECT
                    COUNT(DISTINCT mi.id) FILTER (WHERE lib_emb.id IS NOT NULL) as has_library_embedding,
                    COUNT(DISTINCT mi.id) FILTER (WHERE disc_emb.id IS NOT NULL) as has_discovery_embedding,
                    COUNT(DISTINCT mi.id) FILTER (WHERE lib_emb.id IS NOT NULL AND disc_emb.id IS NOT NULL) as has_both_embeddings,
                    COUNT(DISTINCT mi.id) FILTER (WHERE lib_emb.id IS NULL AND disc_emb.id IS NULL) as no_embeddings
                FROM media_items mi
                LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
                LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
                WHERE mi.status = 'active'
                  AND mi.media_type IN ('movie', 'tv')
            `,
        sql<EmbeddingItemRow[]>`
                SELECT
                    mi.id,
                    COALESCE(primary_ext.external_id, '') as primary_ext_id,
                    mi.title,
                    mi.media_type::text as media_type,
                    CASE WHEN vm.metadata->'genres' IS NOT NULL
                        THEN ARRAY(
                            SELECT (elem->>'id')::integer
                            FROM jsonb_array_elements(vm.metadata->'genres') AS elem
                            WHERE elem->>'id' IS NOT NULL
                              AND elem->>'id' != ''
                              AND elem->>'id' ~ '^[0-9]+$'
                        )
                        ELSE NULL
                    END as genres,
                    mi.created_at
                FROM media_items mi
                LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                LEFT JOIN v_media_metadata vm ON vm.media_id = mi.id
                WHERE mi.status = 'active'
                  AND mi.media_type IN ('movie', 'tv')
                ORDER BY mi.created_at DESC
                LIMIT 10
            `,
        sql<EmbeddingItemRow[]>`
                SELECT
                    mi.id,
                    '' as primary_ext_id,
                    mi.title,
                    mi.media_type::text as media_type,
                    NULL::integer[] as genres
                FROM media_items mi
                LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                WHERE mi.status = 'active'
                  AND mi.media_type IN ('movie', 'tv')
                  AND (mi.is_local_only = true OR primary_ext.external_id IS NULL)
                ORDER BY mi.title
                LIMIT 20
            `,
        sql<EmbeddingItemRow[]>`
                SELECT
                    mi.id,
                    COALESCE(primary_ext.external_id, '') as primary_ext_id,
                    mi.title,
                    mi.media_type::text as media_type,
                    CASE WHEN vm.metadata->'genres' IS NOT NULL
                        THEN ARRAY(
                            SELECT (elem->>'id')::integer
                            FROM jsonb_array_elements(vm.metadata->'genres') AS elem
                            WHERE elem->>'id' IS NOT NULL
                              AND elem->>'id' != ''
                              AND elem->>'id' ~ '^[0-9]+$'
                        )
                        ELSE NULL
                    END as genres
                FROM media_items mi
                LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                LEFT JOIN v_media_metadata vm ON vm.media_id = mi.id
                WHERE mi.status = 'active'
                  AND mi.media_type IN ('movie', 'tv')
                  AND primary_ext.external_id IS NOT NULL
                  AND primary_ext.external_id != ''
                ORDER BY RANDOM()
                LIMIT 20
            `,
    ]);

    return { quality, coverage, recent, noExternalId, sample };
}

/**
 * Music-domain stats — track quality from custom_metadata JSONB.
 * Loaded lazily when Music tab is active.
 */
export async function getMusicEmbeddingStats(sql: postgres.Sql): Promise<{
    quality: MusicQualityRow[];
    recentTracks: MusicItemRow[];
    sample: MusicItemRow[];
}> {
    const [quality, recentTracks, sample] = await Promise.all([
        sql<MusicQualityRow[]>`
            SELECT
                COUNT(*)::text as total_tracks,
                COUNT(*) FILTER (
                    WHERE EXISTS(
                        SELECT 1 FROM media_embeddings me
                        WHERE me.media_id = mi.id AND me.source = ${EMBEDDING_SOURCE.MUSIC}
                    )
                )::text as with_embedding,
                COUNT(*) FILTER (
                    WHERE mi.custom_metadata->>'artist' IS NULL
                       OR mi.custom_metadata->>'artist' = ''
                )::text as missing_artist,
                COUNT(*) FILTER (
                    WHERE mi.custom_metadata->>'album' IS NULL
                       OR mi.custom_metadata->>'album' = ''
                )::text as missing_album,
                COUNT(*) FILTER (
                    WHERE mi.custom_metadata->'genre' IS NULL
                       OR jsonb_typeof(mi.custom_metadata->'genre') != 'array'
                       OR jsonb_array_length(mi.custom_metadata->'genre') = 0
                )::text as missing_genre,
                COUNT(*) FILTER (
                    WHERE mi.custom_metadata->'essentia'->>'bpm' IS NULL
                )::text as missing_bpm,
                COUNT(*) FILTER (
                    WHERE mi.custom_metadata->'essentia'->'mood_tags' IS NULL
                       OR jsonb_typeof(mi.custom_metadata->'essentia'->'mood_tags') != 'array'
                       OR jsonb_array_length(mi.custom_metadata->'essentia'->'mood_tags') = 0
                )::text as missing_mood_tags,
                COALESCE(ROUND(AVG(
                    CASE
                        WHEN mi.custom_metadata->'genre' IS NOT NULL
                         AND jsonb_typeof(mi.custom_metadata->'genre') = 'array'
                        THEN jsonb_array_length(mi.custom_metadata->'genre')
                        ELSE 0
                    END
                ), 1), 0) as avg_genre_count
            FROM media_items mi
            WHERE mi.status = 'active'
              AND mi.media_type = 'track'
        `,
        sql<MusicItemRow[]>`
            SELECT
                mi.id,
                mi.title,
                COALESCE(mi.custom_metadata->>'artist', '') as artist,
                mi.custom_metadata->>'album' as album,
                CASE
                    WHEN mi.custom_metadata->'genre' IS NOT NULL
                     AND jsonb_typeof(mi.custom_metadata->'genre') = 'array'
                    THEN ARRAY(SELECT jsonb_array_elements_text(mi.custom_metadata->'genre'))
                    ELSE NULL
                END as genres,
                EXISTS(
                    SELECT 1 FROM media_embeddings me
                    WHERE me.media_id = mi.id AND me.source = ${EMBEDDING_SOURCE.MUSIC}
                ) as has_embedding,
                mi.created_at
            FROM media_items mi
            WHERE mi.status = 'active'
              AND mi.media_type = 'track'
            ORDER BY mi.created_at DESC
            LIMIT 10
        `,
        sql<MusicItemRow[]>`
            SELECT
                mi.id,
                mi.title,
                COALESCE(mi.custom_metadata->>'artist', '') as artist,
                mi.custom_metadata->>'album' as album,
                CASE
                    WHEN mi.custom_metadata->'genre' IS NOT NULL
                     AND jsonb_typeof(mi.custom_metadata->'genre') = 'array'
                    THEN ARRAY(SELECT jsonb_array_elements_text(mi.custom_metadata->'genre'))
                    ELSE NULL
                END as genres,
                EXISTS(
                    SELECT 1 FROM media_embeddings me
                    WHERE me.media_id = mi.id AND me.source = ${EMBEDDING_SOURCE.MUSIC}
                ) as has_embedding
            FROM media_items mi
            WHERE mi.status = 'active'
              AND mi.media_type = 'track'
            ORDER BY RANDOM()
            LIMIT 20
        `,
    ]);

    return { quality, recentTracks, sample };
}

// =============================================================================
// VOD embedding coverage (focused single-query variant for the coverage
// dashboard at /admin/developer/vod-embeddings — distinct from getVideoEmbeddingStats,
// which runs 5 heavy queries for the full embeddings explorer).
// =============================================================================

export interface VodEmbeddingCoverage {
    /** Active movie/tv catalog items (the denominator). */
    eligible: number;
    /** Items with ANY embedding (library OR discovery). */
    withEmbedding: number;
    withLibrary: number;
    withDiscovery: number;
    withBoth: number;
    /** Items with no embedding of either source. */
    missing: number;
    /** withEmbedding / eligible, rounded to a whole percent. */
    coveragePercent: number;
}

/**
 * Coverage of AI text embeddings across the movie/TV catalog. "Eligible" is
 * every active movie/tv item; "covered" is any that carry a library OR
 * discovery embedding (the two sources are mutually exclusive by `has_files`,
 * so together they describe whole-catalog AI readiness for search + For-You).
 */
export async function getVodEmbeddingCoverage(sql: postgres.Sql): Promise<VodEmbeddingCoverage> {
    const rows = await sql<
        {
            eligible: string;
            with_library: string;
            with_discovery: string;
            with_both: string;
            with_any: string;
            missing: string;
        }[]
    >`
        SELECT
            COUNT(DISTINCT mi.id) AS eligible,
            COUNT(DISTINCT mi.id) FILTER (WHERE lib_emb.id IS NOT NULL) AS with_library,
            COUNT(DISTINCT mi.id) FILTER (WHERE disc_emb.id IS NOT NULL) AS with_discovery,
            COUNT(DISTINCT mi.id) FILTER (WHERE lib_emb.id IS NOT NULL AND disc_emb.id IS NOT NULL) AS with_both,
            COUNT(DISTINCT mi.id) FILTER (WHERE lib_emb.id IS NOT NULL OR disc_emb.id IS NOT NULL) AS with_any,
            COUNT(DISTINCT mi.id) FILTER (WHERE lib_emb.id IS NULL AND disc_emb.id IS NULL) AS missing
        FROM media_items mi
        LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
        LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
        WHERE mi.status = 'active'
          AND mi.media_type IN ('movie', 'tv')
    `;

    const row = rows[0];
    const eligible = Number(row?.eligible ?? 0);
    const withEmbedding = Number(row?.with_any ?? 0);

    return {
        eligible,
        withEmbedding,
        withLibrary: Number(row?.with_library ?? 0),
        withDiscovery: Number(row?.with_discovery ?? 0),
        withBoth: Number(row?.with_both ?? 0),
        missing: Number(row?.missing ?? 0),
        coveragePercent: eligible > 0 ? Math.round((withEmbedding / eligible) * 100) : 0,
    };
}
