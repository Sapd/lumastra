// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DismissService - Negative steering for "Because you watched" recommendations
 *
 * Tracks dismissed items in Redis (ephemeral, session-based) and provides
 * steered vectors for improved recommendations.
 *
 * When users dismiss items in "Because you watched X" rows, we:
 * 1. Store the dismissed item's embedding
 * 2. On next request, compute: steered_vec = normalize(source_vec - beta × avg(dismissed_vecs))
 * 3. Use steered_vec for similarity search to steer away from dismissed content
 */

import { Logger } from '$lib/server/utils/logger';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { isMovie, isSeries } from '$lib/server/utils/media-types';
import { parseEmbedding, applyNegativeSteering } from '$lib/server/utils/embedding-utils';
import type postgres from 'postgres';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source';

const logger = Logger.for('DismissService');

// Type-safe cache for dismiss state
const dismissCache = cacheManager.for(CACHE_NAMESPACES.dismissState);

/** Stored dismiss state for a source media */
interface DismissState {
    sourceMediaKey: string;
    dismissedItems: Array<{
        mediaKey: string;
        embedding: number[];
        dismissedAt: number;
    }>;
    lastUpdated: number;
}

/** Result of applying steering */
export interface SteeringResult {
    steeredVector: number[];
    dismissCount: number;
    beta: number;
}

export class DismissService {
    constructor(private sql: postgres.Sql) {}

    /**
     * Record that a user dismissed an item in a "Because you watched" row.
     *
     * @param userId - User who dismissed
     * @param sourceMediaKey - Composite key of source media (e.g., "tmdb:550:movie")
     * @param dismissedMediaKey - Composite key of dismissed item
     * @returns Updated dismiss count for this source
     */
    async recordDismiss(
        userId: string,
        sourceMediaKey: string,
        dismissedMediaKey: string,
    ): Promise<{ success: boolean; dismissCount: number }> {
        const cacheKey = this.buildCacheKey(userId, sourceMediaKey);

        // Parse the dismissed media key to get details
        const parsed = this.parseMediaKey(dismissedMediaKey);
        if (!parsed) {
            logger.warn('Invalid dismissed media key', { dismissedMediaKey });
            return { success: false, dismissCount: 0 };
        }

        // Get embedding for dismissed item
        const embedding = await this.getMediaEmbedding(parsed);
        if (!embedding) {
            const logDetails =
                parsed.type === 'uuid'
                    ? { dismissedMediaKey, uuid: parsed.uuid }
                    : {
                          dismissedMediaKey,
                          tmdbId: parsed.tmdbId,
                          mediaType: parsed.mediaType,
                      };
            logger.warn('No embedding found for dismissed item', logDetails);
            // Still record the dismiss even without embedding
            // (won't affect steering but maintains state)
        }

        // Get existing state
        let state = await dismissCache.get<DismissState>(cacheKey);
        if (!state) {
            state = {
                sourceMediaKey,
                dismissedItems: [],
                lastUpdated: Date.now(),
            };
        }

        // Check if already dismissed
        const alreadyDismissed = state.dismissedItems.some(
            (item) => item.mediaKey === dismissedMediaKey,
        );
        if (alreadyDismissed) {
            logger.debug('Item already dismissed', {
                userId,
                sourceMediaKey,
                dismissedMediaKey,
            });
            return { success: true, dismissCount: state.dismissedItems.length };
        }

        // Add dismissed item
        if (embedding) {
            state.dismissedItems.push({
                mediaKey: dismissedMediaKey,
                embedding,
                dismissedAt: Date.now(),
            });
        }
        state.lastUpdated = Date.now();

        // Store updated state
        await dismissCache.set(cacheKey, state);

        logger.info('Recorded dismiss', {
            userId,
            sourceMediaKey,
            dismissedMediaKey,
            totalDismissed: state.dismissedItems.length,
            hasEmbedding: !!embedding,
        });

        return { success: true, dismissCount: state.dismissedItems.length };
    }

    /**
     * Get steered vector for a source media based on dismissed items.
     *
     * @param userId - User requesting
     * @param sourceMediaKey - Composite key of source media
     * @param sourceEmbedding - Source media's embedding (from caller)
     * @param beta - Steering strength (default: 0.3)
     */
    async getSteeredVector(
        userId: string,
        sourceMediaKey: string,
        sourceEmbedding: number[],
        beta: number = 0.3,
    ): Promise<SteeringResult | null> {
        const cacheKey = this.buildCacheKey(userId, sourceMediaKey);
        const state = await dismissCache.get<DismissState>(cacheKey);

        if (!state || state.dismissedItems.length === 0) {
            // No dismissals - return original vector
            return {
                steeredVector: sourceEmbedding,
                dismissCount: 0,
                beta,
            };
        }

        // Collect embeddings from dismissed items
        const dismissedEmbeddings = state.dismissedItems
            .filter((item) => item.embedding && item.embedding.length > 0)
            .map((item) => item.embedding);

        if (dismissedEmbeddings.length === 0) {
            return {
                steeredVector: sourceEmbedding,
                dismissCount: state.dismissedItems.length,
                beta,
            };
        }

        // Apply negative steering
        const steeredVector = applyNegativeSteering(sourceEmbedding, dismissedEmbeddings, beta);

        logger.debug('Applied negative steering', {
            userId,
            sourceMediaKey,
            dismissCount: dismissedEmbeddings.length,
            beta,
        });

        return {
            steeredVector,
            dismissCount: state.dismissedItems.length,
            beta,
        };
    }

    /**
     * Get dismiss count for a source media.
     */
    async getDismissCount(userId: string, sourceMediaKey: string): Promise<number> {
        const cacheKey = this.buildCacheKey(userId, sourceMediaKey);
        const state = await dismissCache.get<DismissState>(cacheKey);
        return state?.dismissedItems.length ?? 0;
    }

    /**
     * Get all dismissed media keys for a source.
     */
    async getDismissedMediaKeys(userId: string, sourceMediaKey: string): Promise<string[]> {
        const cacheKey = this.buildCacheKey(userId, sourceMediaKey);
        const state = await dismissCache.get<DismissState>(cacheKey);
        return state?.dismissedItems.map((item) => item.mediaKey) ?? [];
    }

    /**
     * Clear dismiss state for a source media.
     * Use when the source media changes or user wants to reset.
     */
    async clearDismissState(userId: string, sourceMediaKey: string): Promise<void> {
        const cacheKey = this.buildCacheKey(userId, sourceMediaKey);
        await dismissCache.delete(cacheKey);
        logger.info('Cleared dismiss state', { userId, sourceMediaKey });
    }

    /**
     * Clear all dismiss state for a user.
     */
    async clearAllUserDismissState(userId: string): Promise<void> {
        // Note: This requires iterating all keys for the user
        // In practice, states expire after 2 hours anyway
        logger.info('Clearing all dismiss state for user', { userId });
        // With prefix-based deletion not available, states will naturally expire
    }

    /**
     * Get a hash of current dismiss state for cache key purposes.
     * Returns null if no dismissals.
     */
    async getDismissHash(userId: string, sourceMediaKey: string): Promise<string | null> {
        const cacheKey = this.buildCacheKey(userId, sourceMediaKey);
        const state = await dismissCache.get<DismissState>(cacheKey);

        if (!state || state.dismissedItems.length === 0) {
            return null;
        }

        // Simple hash based on dismissed keys and count
        const keys = state.dismissedItems
            .map((item) => item.mediaKey)
            .sort()
            .join('|');
        // Use a simple hash for cache key differentiation
        let hash = 0;
        for (let i = 0; i < keys.length; i++) {
            const char = keys.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return `d${Math.abs(hash).toString(36)}`;
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    private buildCacheKey(userId: string, sourceMediaKey: string): string {
        return `dismiss:${userId}:${sourceMediaKey}`;
    }

    /**
     * Parse a media key into its components.
     * Supports both composite keys (tmdb:550:movie) and UUIDs.
     */
    private parseMediaKey(mediaKey: string):
        | {
              type: 'composite';
              provider: string;
              tmdbId: number;
              mediaType: 'movie' | 'tv';
          }
        | { type: 'uuid'; uuid: string }
        | null {
        // Check if it's a UUID
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidPattern.test(mediaKey)) {
            return { type: 'uuid', uuid: mediaKey.toLowerCase() };
        }

        // Expected format: "tmdb:550:movie" or "imdb:tt0137523:movie"
        const parts = mediaKey.split(':');
        if (parts.length !== 3) return null;

        const [provider, id, type] = parts;
        if (!isMovie(type) && !isSeries(type)) return null;

        // For now, only support TMDB IDs for embedding lookup
        if (provider !== 'tmdb') {
            // Could resolve IMDB to TMDB here in the future
            return null;
        }

        const tmdbId = parseInt(id, 10);
        if (isNaN(tmdbId)) return null;

        return {
            type: 'composite',
            provider,
            tmdbId,
            // Normalise: the isMovie/isSeries guard accepts 'series' too, so a bare
            // cast would carry 'series' through wearing the 'tv' type.
            mediaType: isMovie(type) ? 'movie' : 'tv',
        };
    }

    private async getMediaEmbeddingByTmdb(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
    ): Promise<number[] | null> {
        const result = await this.sql<{ embedding: string | number[] }[]>`
            SELECT COALESCE(jf_emb.embedding, js_emb.embedding)::text as embedding
            FROM media_items mi
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
                AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                AND primary_ext.media_type = mi.media_type
            LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id
                AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            LEFT JOIN media_embeddings js_emb ON js_emb.media_id = mi.id
                AND js_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
            WHERE primary_ext.external_id = ${String(tmdbId)}
                AND mi.media_type = ${mediaType}
                AND mi.status = 'active'
                AND (jf_emb.embedding IS NOT NULL OR js_emb.embedding IS NOT NULL)
            LIMIT 1
        `;

        if (result.length === 0) return null;
        return parseEmbedding(result[0].embedding);
    }

    private async getMediaEmbeddingByUuid(uuid: string): Promise<number[] | null> {
        const result = await this.sql<{ embedding: string | number[] }[]>`
            SELECT COALESCE(jf_emb.embedding, js_emb.embedding)::text as embedding
            FROM media_items mi
            LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id
                AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            LEFT JOIN media_embeddings js_emb ON js_emb.media_id = mi.id
                AND js_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
            WHERE mi.id = ${uuid}
                AND mi.status = 'active'
                AND (jf_emb.embedding IS NOT NULL OR js_emb.embedding IS NOT NULL)
            LIMIT 1
        `;

        if (result.length === 0) return null;
        return parseEmbedding(result[0].embedding);
    }

    /**
     * Get embedding for a media key (supports both UUID and composite key)
     */
    private async getMediaEmbedding(
        parsed:
            | { type: 'composite'; tmdbId: number; mediaType: 'movie' | 'tv' }
            | { type: 'uuid'; uuid: string },
    ): Promise<number[] | null> {
        if (parsed.type === 'uuid') {
            return this.getMediaEmbeddingByUuid(parsed.uuid);
        }
        return this.getMediaEmbeddingByTmdb(parsed.tmdbId, parsed.mediaType);
    }
}

// Singleton instance factory
let _instance: DismissService | null = null;

export function getDismissService(sql: postgres.Sql): DismissService {
    if (!_instance) {
        _instance = new DismissService(sql);
    }
    return _instance;
}
