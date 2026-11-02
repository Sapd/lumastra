// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AI Admin Endpoint Query Module
 *
 * Centralized queries for AI admin operations including:
 * - Suggestions management
 * - Embedding management
 * - Watch history stats
 * - MDBList status
 * - System statistics
 *
 * @module queries/ai-admin
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { buildOverrideAwareMetadataLateralJoin } from './builders/provider-metadata.builder.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';

// =============================================================================
// System Statistics Queries
// =============================================================================

export interface SystemStats {
    totalUsers: number;
    totalRatings: number;
    totalMediaItems: number;
    totalSuggestions: number;
}

/**
 * Get system-wide AI statistics.
 */
export async function getSystemStats(sql: postgres.Sql): Promise<SystemStats> {
    const [users, ratings, embeddings, suggestions] = await Promise.all([
        sql<{ count: string }[]>`
            SELECT COUNT(DISTINCT user_id) as count FROM user_ratings
        `,
        sql<{ count: string }[]>`
            SELECT COUNT(*) as count FROM user_ratings
        `,
        sql<{ count: string }[]>`
            SELECT COUNT(*) as count FROM media_items WHERE status = 'active'
        `,
        sql<{ count: string }[]>`
            SELECT COUNT(*) as count FROM user_suggestions
        `,
    ]);

    return {
        totalUsers: Number.parseInt(users[0]?.count ?? '0', 10),
        totalRatings: Number.parseInt(ratings[0]?.count ?? '0', 10),
        totalMediaItems: Number.parseInt(embeddings[0]?.count ?? '0', 10),
        totalSuggestions: Number.parseInt(suggestions[0]?.count ?? '0', 10),
    };
}

/**
 * Delete expired suggestions (older than specified date).
 */
export async function deleteExpiredSuggestions(
    sql: postgres.Sql,
    olderThanDate: Date,
): Promise<void> {
    await sql`DELETE FROM user_suggestions WHERE created_at < ${olderThanDate}`;
}

// =============================================================================
// Suggestions Queries
// =============================================================================

/**
 * Delete all suggestions for a user.
 */
export async function deleteUserSuggestions(sql: postgres.Sql, userId: UserId): Promise<void> {
    await sql`DELETE FROM user_suggestions WHERE user_id = ${userId}`;
}

// =============================================================================
// Watch History Stats Queries
// =============================================================================

export interface WatchHistoryStats {
    ratingsCount: number;
    usersWithRatings: number;
}

/**
 * Get watch history/ratings statistics.
 */
export async function getWatchHistoryStats(sql: postgres.Sql): Promise<WatchHistoryStats> {
    const result = await sql<{ ratings_count: string; users_with_ratings: string }[]>`
        SELECT
            (SELECT COUNT(*) FROM user_ratings) as ratings_count,
            (SELECT COUNT(DISTINCT user_id) FROM user_ratings) as users_with_ratings
    `;
    return {
        ratingsCount: parseInt(result[0]?.ratings_count || '0', 10),
        usersWithRatings: parseInt(result[0]?.users_with_ratings || '0', 10),
    };
}

// =============================================================================
// Reset/Cleanup Queries
// =============================================================================

export interface ResetEmbeddingsResult {
    deletedCount: number;
}

/**
 * Delete all media embeddings.
 */
export async function deleteAllMediaEmbeddings(sql: postgres.Sql): Promise<ResetEmbeddingsResult> {
    const result = await sql`DELETE FROM media_embeddings`;
    return { deletedCount: result.count };
}

/**
 * Delete all media items (cascades to related tables).
 */
export async function deleteAllMediaItems(sql: postgres.Sql): Promise<ResetEmbeddingsResult> {
    const result = await sql`DELETE FROM media_items`;
    return { deletedCount: result.count };
}

/**
 * Delete all library availability records.
 */
export async function deleteLibraryAvailability(sql: postgres.Sql, library: string): Promise<void> {
    await sql`DELETE FROM library_availability WHERE library = ${library}`;
}

/**
 * Delete all external IDs.
 */
export async function deleteAllExternalIds(sql: postgres.Sql): Promise<ResetEmbeddingsResult> {
    const result = await sql`DELETE FROM external_ids`;
    return { deletedCount: result.count };
}

/**
 * Delete all provider metadata.
 */
export async function deleteAllProviderMetadata(sql: postgres.Sql): Promise<ResetEmbeddingsResult> {
    const result = await sql`DELETE FROM provider_metadata`;
    return { deletedCount: result.count };
}

/**
 * Delete embeddings by source.
 */
export async function deleteEmbeddingsBySource(
    sql: postgres.Sql,
    source: string,
): Promise<ResetEmbeddingsResult> {
    const result = await sql`DELETE FROM media_embeddings WHERE source = ${source}`;
    return { deletedCount: result.count };
}

/**
 * Delete provider metadata by provider names.
 */
export async function deleteProviderMetadataByProviders(
    sql: postgres.Sql,
    providers: string[],
): Promise<ResetEmbeddingsResult> {
    const result = await sql`
        DELETE FROM provider_metadata
        WHERE provider = ANY(${providers}::text[])
    `;
    return { deletedCount: result.count };
}

// =============================================================================
// MDBList Status Queries
// =============================================================================

export interface MdblistCoverageResult {
    totalItems: number;
    withMdblist: number;
    coveragePercent: number;
}

/**
 * Get MDBList coverage statistics.
 */
export async function getMdblistCoverage(sql: postgres.Sql): Promise<MdblistCoverageResult> {
    const result = await sql<{ total_items: string; with_mdblist: string }[]>`
        SELECT
            (SELECT COUNT(*) FROM media_items WHERE status = 'active') as total_items,
            (SELECT COUNT(*) FROM provider_metadata WHERE provider = 'mdblist') as with_mdblist
    `;
    const totalItems = parseInt(result[0]?.total_items || '0', 10);
    const withMdblist = parseInt(result[0]?.with_mdblist || '0', 10);
    return {
        totalItems,
        withMdblist,
        coveragePercent: totalItems > 0 ? Math.round((withMdblist / totalItems) * 100) : 0,
    };
}

// =============================================================================
// Search Embeddings Queries
// =============================================================================

export interface EmbeddingSearchRow {
    id: string;
    primary_ext_id: string;
    title: string;
    media_type: string;
    genres: number[] | null;
}

/**
 * Search media items by title for embedding admin.
 */
export async function searchMediaByTitle(
    sql: postgres.Sql,
    searchPattern: string,
    exactQuery: string,
    mediaType?: string,
    limit: number = 50,
): Promise<EmbeddingSearchRow[]> {
    if (mediaType) {
        return sql<EmbeddingSearchRow[]>`
            SELECT
                mi.id,
                (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
                mi.title,
                mi.media_type,
                CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                    THEN ARRAY(SELECT elem::integer FROM jsonb_array_elements_text(pm.metadata->'genres') AS elem)
                    ELSE NULL
                END as genres
            FROM media_items mi
            ${sql.unsafe(buildOverrideAwareMetadataLateralJoin())}
            WHERE mi.status = 'active'
                AND mi.title ILIKE ${searchPattern}
                AND mi.media_type = ${mediaType}
            ORDER BY
                CASE WHEN mi.title ILIKE ${exactQuery} THEN 0 ELSE 1 END,
                mi.title
            LIMIT ${limit}
        `;
    }

    return sql<EmbeddingSearchRow[]>`
        SELECT
            mi.id,
            (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
            mi.title,
            mi.media_type,
            CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                THEN ARRAY(SELECT elem::integer FROM jsonb_array_elements_text(pm.metadata->'genres') AS elem)
                ELSE NULL
            END as genres
        FROM media_items mi
        ${sql.unsafe(buildOverrideAwareMetadataLateralJoin())}
        WHERE mi.status = 'active'
            AND mi.title ILIKE ${searchPattern}
        ORDER BY
            CASE WHEN mi.title ILIKE ${exactQuery} THEN 0 ELSE 1 END,
            mi.title
        LIMIT ${limit}
    `;
}

// =============================================================================
// MDBList Status Queries
// =============================================================================

export interface MdblistTagStats {
    total: number;
    withTags: number;
    withoutTags: number;
}

/**
 * Get MDBList tag statistics for status endpoint.
 */
export async function getMdblistTagStats(sql: postgres.Sql): Promise<MdblistTagStats> {
    const result = await sql<{ total: string; with_tags: string; without_tags: string }[]>`
        SELECT
            COUNT(DISTINCT mi.id) as total,
            COUNT(DISTINCT CASE
                WHEN pm.metadata->'mdblist_keywords' IS NOT NULL
                    AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                    AND jsonb_array_length(pm.metadata->'mdblist_keywords') > 0
                THEN mi.id
            END) as with_tags,
            COUNT(DISTINCT CASE
                WHEN pm.metadata->'mdblist_keywords' IS NULL
                    OR jsonb_typeof(pm.metadata->'mdblist_keywords') != 'array'
                    OR jsonb_array_length(pm.metadata->'mdblist_keywords') = 0
                THEN mi.id
            END) as without_tags
        FROM media_items mi
        LEFT JOIN provider_metadata pm ON pm.media_id = mi.id AND pm.provider IN ('aggregated', 'mdblist')
        WHERE mi.status = 'active'
    `;
    return {
        total: parseInt(result[0]?.total || '0', 10),
        withTags: parseInt(result[0]?.with_tags || '0', 10),
        withoutTags: parseInt(result[0]?.without_tags || '0', 10),
    };
}
