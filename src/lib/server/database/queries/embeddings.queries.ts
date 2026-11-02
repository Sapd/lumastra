// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Queries
 *
 * Read-only queries for media embeddings.
 * Complex embedding operations (upsert, build from UUID) remain in Database class or services.
 *
 * @module queries/embeddings
 */

import type postgres from 'postgres';
import { buildMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { buildEmbeddingTextFields } from './fragments/base-media.fragments.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';

// =============================================================================
// Types
// =============================================================================

export interface MediaCatalogMetadata {
    imdb_rating: number | null;
    rt_rating: number | null;
    tmdb_rating: number | null;
    popularity: number | null;
    networks: string[] | null;
    keywords: string[] | null;
    production_companies: string[] | null;
    is_available: boolean;
    can_request: boolean;
}

export interface DualEmbeddingResult {
    library_embedding?: number[] | string;
    discovery_embedding?: number[] | string;
    metadata?: MediaCatalogMetadata;
}

// =============================================================================
// Dual Embedding Queries
// =============================================================================

/**
 * Get both Jellyfin and Jellyseerr embeddings for a media item,
 * along with enriched metadata.
 *
 * @param sql - Postgres SQL instance
 * @param tmdbId - TMDB ID of the media item
 * @param mediaType - Media type (movie or tv)
 * @returns Dual embedding result with metadata, or null if not found
 */
export async function getDualEmbedding(
    sql: postgres.Sql,
    tmdbId: number,
    mediaType: 'movie' | 'tv',
): Promise<DualEmbeddingResult | null> {
    const result = await sql<
        Array<{
            library_embedding: number[] | string | null;
            discovery_embedding: number[] | string | null;
            imdb_rating: number | null;
            rt_rating: number | null;
            tmdb_rating: number | null;
            popularity: number | null;
            networks: string[] | null;
            keywords: string[] | null;
            production_companies: string[] | null;
            is_available: boolean;
            can_request: boolean;
        }>
    >`
        SELECT
            ${sql.unsafe(buildEmbeddingTextFields('lib_emb', 'disc_emb'))},
            (pm.metadata->>'imdb_rating')::float as imdb_rating,
            (pm.metadata->>'rt_rating')::integer as rt_rating,
            (pm.metadata->>'popularity')::float as tmdb_rating,
            (pm.metadata->>'popularity')::float as popularity,
            CASE WHEN pm.metadata->'networks' IS NOT NULL AND jsonb_typeof(pm.metadata->'networks') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'networks') AS elem)
                ELSE NULL
            END as networks,
            CASE WHEN pm.metadata->'keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'keywords') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'keywords') AS elem)
                ELSE NULL
            END as keywords,
            CASE WHEN pm.metadata->'production_companies' IS NOT NULL AND jsonb_typeof(pm.metadata->'production_companies') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'production_companies') AS elem)
                ELSE NULL
            END as production_companies,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            AND primary_ext.external_id = ${tmdbId}::text
            AND primary_ext.media_type = ${mediaType}
        ${buildMetadataLateralJoinFragment(sql)}
        LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
        LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
        WHERE mi.status = 'active'
    `;

    if (result.length === 0) return null;

    const row = result[0];
    return {
        library_embedding: row.library_embedding ?? undefined,
        discovery_embedding: row.discovery_embedding ?? undefined,
        metadata: {
            imdb_rating: row.imdb_rating,
            rt_rating: row.rt_rating,
            tmdb_rating: row.tmdb_rating,
            popularity: row.popularity,
            networks: row.networks,
            keywords: row.keywords,
            production_companies: row.production_companies,
            is_available: row.is_available,
            can_request: row.can_request,
        },
    };
}

// =============================================================================
// Embedding Counts
// =============================================================================

/**
 * Get count of library embeddings in the database.
 *
 * @param sql - Postgres SQL instance
 * @returns Count of library embeddings
 */
export async function getLibraryEmbeddingCount(sql: postgres.Sql): Promise<number> {
    const result = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM media_embeddings
        WHERE source = ${EMBEDDING_SOURCE.LIBRARY}
    `;
    return Number.parseInt(result[0].count) || 0;
}

/**
 * Get count of discovery embeddings in the database.
 *
 * @param sql - Postgres SQL instance
 * @returns Count of discovery embeddings
 */
export async function getDiscoveryEmbeddingCount(sql: postgres.Sql): Promise<number> {
    const result = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM media_embeddings
        WHERE source = ${EMBEDDING_SOURCE.DISCOVERY}
    `;
    return Number.parseInt(result[0].count) || 0;
}

/**
 * Get total count of all embeddings in the database.
 *
 * @param sql - Postgres SQL instance
 * @returns Total count of embeddings
 */
export async function getTotalEmbeddingCount(sql: postgres.Sql): Promise<number> {
    const result = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM media_embeddings
    `;
    return Number.parseInt(result[0].count) || 0;
}

/**
 * Library-embedding coverage: how many file-backed, active items are eligible
 * for a library embedding vs. how many actually have one. Mirrors the eligibility
 * predicate the library-embeddings generator uses (`mi.status = 'active'` +
 * `mi.has_files`, embedding `source = 'library'`), so `eligible - embedded` is
 * the true coverage gap an operator cares about ("are my library items
 * embedded?"). Informational — NOT a health alarm (a fresh import legitimately
 * shows a large gap until the pipeline catches up).
 */
export async function getLibraryEmbeddingCoverage(
    sql: postgres.Sql,
): Promise<{ eligible: number; embedded: number }> {
    // Admin-only system aggregate: the sole caller is the admin-gated
    // /api/admin/task-system/now endpoint, and a coverage statistic counts the
    // whole library by design — per-user library/age scoping does not apply.
    // (File is in the rule's exempt list as a full-catalog embedding query.)
    const rows = await sql<{ eligible: number; embedded: number }[]>`
        SELECT
            COUNT(DISTINCT mi.id)::int AS eligible,
            COUNT(DISTINCT mi.id) FILTER (WHERE emb.id IS NOT NULL)::int AS embedded
        FROM media_items mi
        LEFT JOIN media_embeddings emb
            ON emb.media_id = mi.id AND emb.source = ${EMBEDDING_SOURCE.LIBRARY}
        WHERE mi.status = 'active' AND mi.has_files
    `;
    return {
        eligible: rows[0]?.eligible ?? 0,
        embedded: rows[0]?.embedded ?? 0,
    };
}

// =============================================================================
// Coverage-table backlog (feature-flag path)
// =============================================================================

export interface EmbeddingCoverageRow {
    id: string;
    media_type: string;
}

/**
 * Return up to `limit` media item IDs from `media_item_stage_state` where the
 * row is in a retriable state for `stageId`. Used when
 * `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES` includes an embedding stage and the
 * coverage table is the authoritative eligibility source.
 *
 * Retriable statuses:
 *   pending          — not yet processed
 *   failed_transient — transient failure, backoff window expired
 *   obsolete         — content changed, needs re-embedding
 *   skipped_transient — transient skip, retry allowed
 *
 * Defensive predicate: items must be `media_items.status = 'active'` and not
 * dismissed. Otherwise inactive/dismissed items returned here would be filtered
 * out by every downstream generator's `WHERE mi.status = 'active'` clause,
 * leaving the coverage row `pending` forever (drift class shared with the
 * legacy filter mismatch — see `markSkippedTransientBatch`).
 */
export async function findEmbeddingCoverageTableBacklog(
    sql: postgres.Sql,
    stageId: string,
    limit: number,
): Promise<EmbeddingCoverageRow[]> {
    return sql<EmbeddingCoverageRow[]>`
        SELECT mi.id, mi.media_type
        FROM media_item_stage_state miss
        JOIN media_items mi ON mi.id = miss.media_item_id
        WHERE miss.stage_id = ${stageId}
          AND miss.status IN ('pending', 'failed_transient', 'obsolete', 'skipped_transient')
          AND (miss.next_eligible_at IS NULL OR miss.next_eligible_at <= now())
          AND mi.status = 'active'
          AND COALESCE(mi.is_dismissed, false) = false
        ORDER BY miss.next_eligible_at ASC NULLS FIRST, miss.updated_at ASC
        LIMIT ${limit}
    `;
}
