// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * System Status Query Module
 *
 * Centralized queries for system status endpoint including:
 * - Database table validation
 * - Media item statistics
 * - Embedding coverage statistics
 * - User and suggestion counts
 *
 * @module queries/system-status
 */

import type postgres from 'postgres';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';

// =============================================================================
// Type Definitions
// =============================================================================

export interface MediaStats {
    totalMediaItems: number;
    libraryEmbeddings: number;
    primaryProviderEmbeddings: number;
    bothEmbeddings: number;
}

export interface SystemStatusStats {
    totalMediaItems: number;
    libraryEmbeddings: number;
    primaryProviderEmbeddings: number;
    bothEmbeddings: number;
    totalUsers: number;
    totalSuggestions: number;
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Check which required tables exist in the database.
 * Returns a Set of table names that exist.
 */
export async function checkRequiredTables(sql: postgres.Sql): Promise<Set<string>> {
    const tables = await sql<{ table_name: string }[]>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name IN ('media_items', 'media_embeddings', 'user_profiles', 'user_suggestions', 'users')
    `;

    return new Set(tables.map((t) => t.table_name));
}

/**
 * Get media item and embedding statistics.
 * Returns counts of media items and their embedding coverage.
 *
 * A failing item COUNT throws rather than reading as 0: the admin home treats
 * zero items as a first run and swaps its live sections for the setup
 * checklist, so a statement timeout here must surface as an unhealthy
 * database, not an empty library. The embedding coverage stays best-effort.
 */
export async function getMediaStats(sql: postgres.Sql): Promise<MediaStats> {
    const stats: MediaStats = {
        totalMediaItems: 0,
        libraryEmbeddings: 0,
        primaryProviderEmbeddings: 0,
        bothEmbeddings: 0,
    };

    // Check if required tables exist
    const existingTables = await checkRequiredTables(sql);

    if (existingTables.has('media_items')) {
        // Get total active media items
        const totalResult = await sql<{ count: string }[]>`
            SELECT COUNT(*) as count FROM media_items WHERE status = 'active'
        `;
        stats.totalMediaItems = Number.parseInt(totalResult[0]?.count || '0');

        try {
            // Get embedding stats from media_embeddings table
            if (existingTables.has('media_embeddings')) {
                const embeddingStats = await sql<
                    {
                        library_count: string;
                        jellyseerr_count: string;
                        both_count: string;
                    }[]
                >`
                    SELECT
                        COUNT(DISTINCT CASE WHEN source = ${EMBEDDING_SOURCE.LIBRARY} THEN media_id END) as library_count,
                        COUNT(DISTINCT CASE WHEN source = ${EMBEDDING_SOURCE.DISCOVERY} THEN media_id END) as jellyseerr_count,
                        COUNT(DISTINCT CASE
                            WHEN media_id IN (SELECT media_id FROM media_embeddings WHERE source = ${EMBEDDING_SOURCE.LIBRARY})
                             AND media_id IN (SELECT media_id FROM media_embeddings WHERE source = ${EMBEDDING_SOURCE.DISCOVERY})
                            THEN media_id
                        END) as both_count
                    FROM media_embeddings
                `;

                const result = embeddingStats[0];
                stats.libraryEmbeddings = Number.parseInt(result?.library_count || '0');
                stats.primaryProviderEmbeddings = Number.parseInt(result?.jellyseerr_count || '0');
                stats.bothEmbeddings = Number.parseInt(result?.both_count || '0');
            }
        } catch (error) {
            // Coverage is secondary — keep the item count, report zero coverage
            console.error('Failed to get embedding stats:', error);
        }
    }

    return stats;
}

/**
 * Get the number of registered user accounts.
 *
 * Counts rows in `users` (the canonical accounts table — native admins,
 * forward-auth/OIDC users all live here). Previously this counted
 * `user_profiles` rows with a preference embedding, which read as 0 on a fresh
 * install even though the bootstrap admin account exists (a native admin gets a
 * `users` row but no `user_profiles`/embeddings until it accrues preferences) —
 * a mismatch with the "registered accounts" label this feeds on the admin
 * dashboard.
 */
export async function getUserStats(sql: postgres.Sql): Promise<number> {
    // Check if required tables exist
    const existingTables = await checkRequiredTables(sql);

    if (!existingTables.has('users')) {
        return 0;
    }

    // Active accounts only — exclude soft-deleted and disabled/suspended
    // rows, matching the "active seats" convention used elsewhere (e.g.
    // migration 16.97.0). A disabled or deleted user is not a live
    // "registered account" for this dashboard stat. A failure throws (see
    // getMediaStats) instead of showing "0 users".
    const userCount = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count
        FROM users
        WHERE deleted_at IS NULL AND disabled_at IS NULL
    `;
    return Number.parseInt(userCount[0]?.count || '0');
}

/**
 * Get count of active (non-expired) user suggestions.
 * Returns the number of suggestions that haven't expired yet.
 */
export async function getActiveSuggestionCount(sql: postgres.Sql): Promise<number> {
    // Check if required tables exist
    const existingTables = await checkRequiredTables(sql);

    if (!existingTables.has('user_suggestions')) {
        return 0;
    }

    try {
        const suggestionCount = await sql<{ count: string }[]>`
            SELECT COUNT(*) as count
            FROM user_suggestions
            WHERE expires_at > NOW()
        `;
        return Number.parseInt(suggestionCount[0]?.count || '0');
    } catch (error) {
        console.error('Failed to get suggestion stats:', error);
        return 0;
    }
}

/**
 * Get comprehensive system status statistics.
 * Combines media, user, and suggestion stats into a single result.
 */
export async function getSystemStatusStats(sql: postgres.Sql): Promise<SystemStatusStats> {
    const [mediaStats, totalUsers, totalSuggestions] = await Promise.all([
        getMediaStats(sql),
        getUserStats(sql),
        getActiveSuggestionCount(sql),
    ]);

    return {
        totalMediaItems: mediaStats.totalMediaItems,
        libraryEmbeddings: mediaStats.libraryEmbeddings,
        primaryProviderEmbeddings: mediaStats.primaryProviderEmbeddings,
        bothEmbeddings: mediaStats.bothEmbeddings,
        totalUsers,
        totalSuggestions,
    };
}
