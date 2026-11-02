// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Operations Queries
 *
 * Pure SQL queries for embedding-related database operations.
 * Used by EmbeddingOperationsService for embedding CRUD and metadata aggregation.
 *
 * Tables:
 * - media_items: Core catalog with internal UUIDs
 * - external_ids: Maps internal IDs to external provider IDs
 * - provider_metadata: Raw metadata from each provider
 * - media_embeddings: Embedding vectors
 * - library_availability: Track availability across libraries
 *
 * @module queries/embedding-operations
 */

import type postgres from 'postgres';
import { buildProviderFilterUnsafe, buildProviderOrderUnsafe } from './media-queries.js';
import { refreshSortTitles } from './sort-title.queries.js';

// =============================================================================
// Types
// =============================================================================

export interface ExistingMediaItemRow {
    media_id: string;
}

export interface MediaItemCoreRow {
    id: string;
    title: string;
    original_title: string | null;
    year: number | null;
    media_type: string;
    is_local_only: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface ExternalIdRow {
    provider: string;
    external_id: string;
    media_type: string;
}

export interface ProviderMetadataRow {
    provider: string;
    metadata: Record<string, unknown>;
}

export interface EmbeddingRow {
    source: string;
    embedding: string | number[] | null;
}

export interface LibraryAvailabilityRow {
    available: boolean;
}

export interface BatchMediaItemRow {
    id: string;
    title: string;
    original_title: string | null;
    year: number | null;
    media_type: string;
    is_local_only: boolean;
    created_at: Date;
    updated_at: Date;
}

export interface BatchExternalIdRow {
    media_id: string;
    provider: string;
    external_id: string;
    media_type: string;
}

export interface BatchProviderMetadataRow {
    media_id: string;
    provider: string;
    metadata: Record<string, unknown>;
}

export interface BatchEmbeddingRow {
    media_id: string;
    source: string;
    embedding: string | number[] | null;
}

export interface BatchLibraryAvailabilityRow {
    media_id: string;
    available: boolean;
}

// =============================================================================
// Update Queries
// =============================================================================

/**
 * Update media item title, original title, year, and local-only flag.
 */
export async function updateMediaItemMetadata(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        title: string;
        originalTitle: string | null;
        year: number | null;
        isLocalOnly: boolean;
    },
): Promise<void> {
    const { mediaId, title, originalTitle, year, isLocalOnly } = params;
    await sql`
		UPDATE media_items SET
			title = ${title},
			original_title = COALESCE(${originalTitle}, original_title),
			year = COALESCE(${year}, year),
			is_local_only = ${isLocalOnly},
			updated_at = NOW()
		WHERE id = ${mediaId}
	`;
    await refreshSortTitles(sql, [mediaId]);
}

/**
 * Upsert media embedding vector.
 */
export async function upsertMediaEmbedding(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        source: string;
        embeddingVector: string;
    },
): Promise<void> {
    const { mediaId, source, embeddingVector } = params;
    await sql.unsafe(
        `
		INSERT INTO media_embeddings (media_id, source, embedding)
		VALUES ($1, $2, $3::vector)
		ON CONFLICT (media_id, source) DO UPDATE SET
			embedding = EXCLUDED.embedding,
			updated_at = NOW()
	`,
        [mediaId, source, embeddingVector],
    );
}

// =============================================================================
// Single-Item Aggregation Queries
// =============================================================================

/**
 * Get media item core data by UUID.
 */
export async function getMediaItemCore(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaItemCoreRow | null> {
    const rows = await sql<MediaItemCoreRow[]>`
		SELECT id, title, original_title, year, media_type, is_local_only, created_at, updated_at
		FROM media_items WHERE id = ${mediaId} AND status = 'active'
	`;
    return rows[0] || null;
}

/**
 * Get all external IDs for a media item.
 */
export async function getMediaItemExternalIds(
    sql: postgres.Sql,
    mediaId: string,
): Promise<ExternalIdRow[]> {
    return await sql<ExternalIdRow[]>`
		SELECT provider, external_id, media_type FROM external_ids WHERE media_id = ${mediaId}
	`;
}

/**
 * Get provider metadata for a media item (respects configured provider chain).
 */
export async function getMediaItemProviderMetadata(
    sql: postgres.Sql,
    mediaId: string,
): Promise<ProviderMetadataRow | null> {
    const providerFilter = buildProviderFilterUnsafe();
    const providerOrder = buildProviderOrderUnsafe();
    const rows = (await sql.unsafe(
        `SELECT provider, metadata FROM provider_metadata
		WHERE media_id = $1 AND ${providerFilter}
		ORDER BY ${providerOrder}
		LIMIT 1`,
        [mediaId],
    )) as ProviderMetadataRow[];
    return rows[0] || null;
}

/**
 * Get all embeddings for a media item.
 */
export async function getMediaItemEmbeddings(
    sql: postgres.Sql,
    mediaId: string,
): Promise<EmbeddingRow[]> {
    return await sql<EmbeddingRow[]>`
		SELECT source, embedding FROM media_embeddings WHERE media_id = ${mediaId}
	`;
}

/**
 * Get library availability for a media item.
 */
export async function getMediaItemAvailability(
    sql: postgres.Sql,
    mediaId: string,
): Promise<{ available: boolean } | null> {
    const rows = await sql<{ available: boolean }[]>`
		SELECT EXISTS(SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = ${mediaId}) as available
	`;
    return rows[0] || null;
}

// =============================================================================
// Batch Aggregation Queries
// =============================================================================

/**
 * Batch fetch media items by UUIDs.
 */
export async function batchGetMediaItems(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<BatchMediaItemRow[]> {
    return await sql<BatchMediaItemRow[]>`
		SELECT id, title, original_title, year, media_type, is_local_only, created_at, updated_at
		FROM media_items
		WHERE id = ANY(${mediaIds}::uuid[]) AND status = 'active'
	`;
}

/**
 * Batch fetch external IDs for multiple media items.
 */
export async function batchGetExternalIds(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<BatchExternalIdRow[]> {
    return await sql<BatchExternalIdRow[]>`
		SELECT media_id, provider, external_id, media_type
		FROM external_ids
		WHERE media_id = ANY(${mediaIds}::uuid[])
	`;
}

/**
 * Batch fetch provider metadata (respects configured provider chain).
 */
export async function batchGetProviderMetadata(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<BatchProviderMetadataRow[]> {
    const providerFilter = buildProviderFilterUnsafe();
    const providerOrder = buildProviderOrderUnsafe();
    return (await sql.unsafe(
        `SELECT DISTINCT ON (media_id) media_id, provider, metadata
		FROM provider_metadata
		WHERE media_id = ANY($1::uuid[]) AND ${providerFilter}
		ORDER BY media_id, ${providerOrder}`,
        [mediaIds],
    )) as BatchProviderMetadataRow[];
}

/**
 * Batch fetch embeddings for multiple media items.
 */
export async function batchGetEmbeddings(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<BatchEmbeddingRow[]> {
    return await sql<BatchEmbeddingRow[]>`
		SELECT media_id, source, embedding
		FROM media_embeddings
		WHERE media_id = ANY(${mediaIds}::uuid[])
	`;
}

/**
 * Batch fetch library availability for multiple media items.
 */
export async function batchGetLibraryAvailability(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<{ media_id: string; available: boolean }[]> {
    return await sql<{ media_id: string; available: boolean }[]>`
		SELECT media_item_id as media_id, TRUE as available
		FROM media_file_items
		WHERE media_item_id = ANY(${mediaIds}::uuid[])
		GROUP BY media_item_id
	`;
}
