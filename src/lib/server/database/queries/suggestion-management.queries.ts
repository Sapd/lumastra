// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Suggestion Management Query Module
 *
 * Pure SQL queries for managing user suggestions (CRUD operations).
 * Extracted from Database class to follow three-tier architecture.
 *
 * Key patterns:
 * - All functions take sql: postgres.Sql as first parameter
 * - Uses typed result interfaces
 * - Uses batch resolve for TMDB ID to UUID conversion
 * - Handles ON CONFLICT for upsert patterns
 *
 * @module queries/suggestion-management
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { batchResolveMediaIds } from './resolvers/media-id.resolver.js';
import { Logger } from '../../utils/logger.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { resolveOrCreateMediaId } from '../../utils/media-resolution.js';
import { isDiscoveryCatalogEnabled } from '../../config.js';
import type { SuggestionReasonData } from '../utils/recommendation-helpers.js';

// =============================================================================
// Types
// =============================================================================

export type MediaType = 'movie' | 'tv';

/**
 * User suggestion input (without auto-generated fields).
 */
export interface UserSuggestionInput {
    user_id: string;
    primary_ext_id: string;
    media_type: MediaType;
    cache_context?: string;
    library_similarity_score?: number | null;
    discovery_similarity_score?: number | null;
    combined_score?: number | null;
    suggestion_reason?: string;
    /**
     * Structured, client-localizable sibling of `suggestion_reason` — see
     * `SuggestionReasonData` (recommendation-helpers.ts). Optional: callers
     * that don't build one persist `null`.
     */
    reason_data?: SuggestionReasonData | null;
    is_available: boolean;
    can_request: boolean;
}

/**
 * User suggestion row from database.
 */
export interface UserSuggestionRow {
    id: number;
    user_id: string;
    media_id: string;
    primary_ext_id: string | null;
    media_type: MediaType;
    cache_context: string;
    library_similarity_score: number | null;
    discovery_similarity_score: number | null;
    combined_score: number | null;
    suggestion_reason: string | null;
    reason_data: SuggestionReasonData | null;
    is_available: boolean;
    can_request: boolean;
    created_at: Date;
    expires_at: Date;
}

/**
 * Options for getUserSuggestions query.
 */
export interface GetUserSuggestionsOptions {
    cacheContext?: string;
    mediaType?: MediaType;
    watchedBased?: boolean;
    withoutRatingInfluence?: boolean;
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Save user suggestions to database with ON CONFLICT handling.
 *
 * This function:
 * - Batch resolves TMDB IDs to UUIDs
 * - Creates media items if they don't exist (via CatalogService), but only while
 *   the discovery catalog is enabled; otherwise suggestions for titles without a
 *   catalog row are dropped (automatic generation must not mint fileless rows)
 * - Inserts suggestions with ON CONFLICT DO UPDATE
 * - Sets expiration to 2 days from now
 *
 * @param sql - Postgres SQL client instance
 * @param suggestions - Array of suggestion inputs
 */
export async function saveSuggestions(
    sql: postgres.Sql,
    suggestions: UserSuggestionInput[],
): Promise<void> {
    if (suggestions.length === 0) return;

    // Filter out invalid TMDB IDs (must be positive integers)
    const logger = Logger.for('SuggestionManagement');
    const validSuggestions = suggestions.filter((s) => {
        if (!s.primary_ext_id || s.primary_ext_id === '') {
            // Log and skip invalid suggestions
            logger.warn('Skipping suggestion with invalid primary_ext_id', {
                primary_ext_id: s.primary_ext_id,
                media_type: s.media_type,
                user_id: s.user_id,
            });
            return false;
        }
        return true;
    });

    if (validSuggestions.length === 0) return;

    // Batch resolve TMDB IDs to UUIDs
    const resolved = await batchResolveMediaIds(
        sql,
        validSuggestions.map((s) => ({
            tmdbId: s.primary_ext_id,
            mediaType: s.media_type,
        })),
    );

    // Resolve any cache misses by creating stub media items one-by-one
    // (advisory lock in CatalogService.getOrCreateMinimal prevents race conditions)
    for (const s of validSuggestions) {
        const lookupKey = `${s.primary_ext_id}:${s.media_type}`;
        let mediaId = resolved.get(lookupKey);

        // Create media item if not exists (race-safe via advisory lock in CatalogService).
        // Suggestions are generated automatically, not by a user click: with no
        // discovery surface enabled a new fileless row would never be shown.
        if (!mediaId) {
            if (!isDiscoveryCatalogEnabled()) {
                logger.debug('Skipping suggestion without catalog row: discovery disabled', {
                    primary_ext_id: s.primary_ext_id,
                    media_type: s.media_type,
                });
                continue;
            }
            mediaId = await resolveOrCreateMediaId(sql, s.primary_ext_id, s.media_type);
        }

        const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // 2 days
        await sql`
			INSERT INTO user_suggestions (
				user_id, media_id, cache_context,
				library_similarity_score, discovery_similarity_score,
				combined_score, explanation, reason_data, expires_at
			)
			VALUES (
				${s.user_id}, ${mediaId}, ${s.cache_context || 'general'},
				${s.library_similarity_score ?? null}, ${s.discovery_similarity_score ?? null},
				${s.combined_score ?? null}, ${s.suggestion_reason ?? null},
				${s.reason_data ? sql.json(s.reason_data) : null}, ${expiresAt}
			)
			ON CONFLICT (user_id, media_id, cache_context) DO UPDATE SET
				library_similarity_score = EXCLUDED.library_similarity_score,
				discovery_similarity_score = EXCLUDED.discovery_similarity_score,
				combined_score = EXCLUDED.combined_score,
				explanation = EXCLUDED.explanation,
				reason_data = EXCLUDED.reason_data,
				expires_at = EXCLUDED.expires_at,
				updated_at = NOW()
		`;
    }
}

/**
 * Get cached user suggestions with context-aware filtering.
 *
 * @param sql - Postgres SQL client instance
 * @param userId - User identifier
 * @param limit - Maximum number of suggestions to return
 * @param options - Filtering options for cache context and media type
 * @returns Array of cached user suggestions
 */
export async function getUserSuggestions(
    sql: postgres.Sql,
    userId: UserId,
    limit = 20,
    options: GetUserSuggestionsOptions = {},
): Promise<UserSuggestionRow[]> {
    const { cacheContext, mediaType, watchedBased, withoutRatingInfluence } = options;
    // Suggestions are a video recommendation contract. Keep the read boundary
    // closed even if a stale or malformed writer persists another media type.
    const allowedMediaTypes: MediaType[] = mediaType ? [mediaType] : ['movie', 'tv'];

    let contextKey = cacheContext || 'general';
    if (watchedBased) contextKey = 'watched_based';
    if (withoutRatingInfluence) contextKey = 'no_rating_influence';

    // Query user_suggestions with media_items for media_type (authoritative).
    const baseQuery = sql<UserSuggestionRow[]>`
			SELECT
				us.id, us.user_id, us.media_id, us.cache_context,
				us.library_similarity_score, us.discovery_similarity_score,
				us.combined_score, us.explanation as suggestion_reason, us.reason_data,
				us.created_at, us.expires_at,
				(SELECT external_id FROM external_ids WHERE media_id = us.media_id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
				mi.media_type,
				${isAvailableExpr(sql)} AS is_available,
				${canRequestExpr(sql)} AS can_request
			FROM user_suggestions us
			JOIN media_items mi ON mi.id = us.media_id
			WHERE us.user_id = ${userId}
			  AND us.expires_at > NOW()
			  AND us.cache_context = ${contextKey}
			  AND mi.media_type = ANY(${allowedMediaTypes})
			ORDER BY us.combined_score DESC, us.created_at DESC
			LIMIT ${limit}
		  `;

    const results = await baseQuery;

    // Return results directly — primary_ext_id is already a string from the subquery
    return results;
}

/**
 * Clear all cached suggestions for a user.
 * Used when user requests refresh.
 *
 * @param sql - Postgres SQL client instance
 * @param userId - User identifier
 */
export async function clearUserSuggestions(sql: postgres.Sql, userId: UserId): Promise<void> {
    await sql`DELETE FROM user_suggestions WHERE user_id = ${userId}`;
}

/**
 * Clean up expired suggestions across all users.
 *
 * @param sql - Postgres SQL client instance
 * @returns Number of deleted suggestions
 */
export async function cleanupExpiredSuggestions(sql: postgres.Sql): Promise<number> {
    const result = await sql`
		DELETE FROM user_suggestions
		WHERE expires_at < NOW()
		RETURNING user_id
	`;

    return result.length;
}
