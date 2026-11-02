// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Suggestion Engine Query Module
 *
 * Centralized queries for suggestion engine operations:
 * - Test exclude query (debugging exclusion logic)
 * - Total media counts (movies and TV series)
 */

import type postgres from 'postgres';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';

// =============================================================================
// Types
// =============================================================================

export interface TestExcludeResult {
    total: string;
    after_exclude: string;
}

// =============================================================================
// Diagnostic Queries
// =============================================================================

/**
 * Test exclusion logic against media_items with embeddings.
 * Used for debugging "Load More" exclusion behavior.
 *
 * @param sql - postgres.Sql connection
 * @param excludeItems - Array of [tmdb_id, media_type] tuples to exclude
 * @returns Total count and count after exclusion filter applied
 */
export async function getTestExcludeQuery(
    sql: postgres.Sql,
    excludeItems: Array<[string, string]>,
): Promise<TestExcludeResult | null> {
    const result = await sql<TestExcludeResult[]>`
		SELECT COUNT(*) as total,
		       COUNT(*) FILTER (WHERE NOT EXISTS (
		         SELECT 1 FROM (VALUES ${sql(excludeItems)}) AS excluded(tmdb_id, media_type)
		         WHERE excluded.tmdb_id::text = primary_ext.external_id AND excluded.media_type::text = mi.media_type
		       )) as after_exclude
		FROM media_items mi
		JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
		WHERE mi.status = 'active'
		  AND EXISTS (
		    SELECT 1 FROM media_embeddings me
		    WHERE me.media_id = mi.id AND me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
		  )
	`;

    return result[0] ?? null;
}

/**
 * Get total count of active movies with embeddings.
 *
 * @param sql - postgres.Sql connection
 * @returns Count of active movies with embeddings
 */
export async function getTotalMovieCount(sql: postgres.Sql): Promise<number> {
    const result = await sql<[{ count: string }]>`
		SELECT COUNT(*) as count
		FROM media_items mi
		WHERE mi.media_type = 'movie' AND mi.status = 'active' AND mi.has_files = true
		  AND EXISTS (SELECT 1 FROM media_embeddings me WHERE me.media_id = mi.id AND me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY}))
	`;
    return Number.parseInt(result[0]?.count || '0', 10) || 0;
}

/**
 * Get total count of active TV series with embeddings.
 *
 * @param sql - postgres.Sql connection
 * @returns Count of active TV series with embeddings
 */
export async function getTotalTvCount(sql: postgres.Sql): Promise<number> {
    const result = await sql<[{ count: string }]>`
		SELECT COUNT(*) as count
		FROM media_items mi
		WHERE mi.media_type = 'tv' AND mi.status = 'active'
		  AND EXISTS (SELECT 1 FROM media_embeddings me WHERE me.media_id = mi.id AND me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY}))
	`;
    return Number.parseInt(result[0]?.count || '0', 10) || 0;
}
