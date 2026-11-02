// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watched Cache Service
 *
 * Manages caching of user watched IDs to reduce DB queries.
 * Provides cache invalidation for when watch status changes.
 *
 * IMPORTANT: Uses composite keys (tmdb_id + media_type) to avoid TMDB ID collisions.
 * The same TMDB ID can refer to both a movie AND a TV show (e.g., ID 1429).
 */

import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { cacheInvalidation } from '$lib/server/cache/invalidation';
import { Logger } from '$lib/server/utils/logger.js';
import { ExternalIdSet } from '$lib/server/utils/tmdb-composite-key.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types';
import { features } from '$lib/server/config.js';
import type { UserId } from '$lib/shared/user-id';

/**
 * Watched item with composite key support
 * CRITICAL: Both tmdb_id AND media_type are needed to uniquely identify content
 */
export interface WatchedItem {
    internal_id: string | null;
    tmdb_id: string;
    media_type: 'movie' | 'tv';
}

const logger = Logger.for('WatchedCacheService');

// Cache watched IDs - type-safe, TTLs from centralized config
export const watchedCache = cacheManager.for(CACHE_NAMESPACES.watchedIds);

/**
 * Get the cache key for a user's watched IDs.
 *
 * Keyed by the stable `users.id` UUID (UserId) since migration 16.46.0 re-keyed
 * user-data by UUID. Bumped to `v2` so any stale `v1` entries keyed by the old
 * username are abandoned rather than served.
 */
export function getWatchedCacheKey(userId: UserId): string {
    return `user:v2:${userId}`;
}

/**
 * Get the cache key for a user's watched media UUIDs.
 *
 * Distinct from {@link getWatchedCacheKey} (which stores composite-key
 * WatchedItem[] for TMDB-id filtering). This key stores a plain string[]
 * of internal UUIDs used by recommendation strategies for watched-exclusion.
 * Prefixed `uuids:v1:` so it can never collide with the `user:v2:` key above.
 */
export function getWatchedUuidsCacheKey(userId: UserId): string {
    return `uuids:v1:${userId}`;
}

/**
 * Invalidate watched cache for a user.
 * Call this when:
 * - User marks something as watched/unwatched
 * - Playback stops (user might have finished watching)
 * - User finishes watching something in the player
 *
 * This invalidates BOTH:
 * - watched-ids cache (used by recommendations)
 * - watched-series cache (used by new-episodes API)
 */
export async function invalidateWatchedCache(userId: UserId): Promise<void> {
    const cacheKey = getWatchedCacheKey(userId);
    const uuidsCacheKey = getWatchedUuidsCacheKey(userId);
    try {
        await Promise.all([watchedCache.delete(cacheKey), watchedCache.delete(uuidsCacheKey)]);
        logger.debug('Invalidated watched cache', { userId });
    } catch (error) {
        logger.warn('Failed to invalidate watched cache', { userId, error });
    }
}

/**
 * Invalidate the watched-series cache for a user.
 * This is a separate cache used by getWatchedSeriesAndEpisodes() in jellyfin.ts.
 * Called when marking episodes as watched to ensure new-episodes API reflects updates.
 */
export async function invalidateWatchedSeriesCache(userId: UserId): Promise<void> {
    try {
        if (!features.jellyfinSync) {
            return;
        }
        // Use the already imported cacheManager (no dynamic import needed)
        const watchedSeriesCache = cacheManager.for(CACHE_NAMESPACES.watchedSeries);
        // The cache stores with key 'watched-series-and-episodes' scoped to the
        // resolved Jellyfin user UUID. Resolve via shared Valkey-cached resolver.
        const { resolveJellyfinUserIdByUserId } = await import('./jellyfin-user-id-resolver.js');
        const jellyfinUserId = await resolveJellyfinUserIdByUserId(userId);
        if (jellyfinUserId) {
            await watchedSeriesCache.delete('watched-series-and-episodes', jellyfinUserId);
            logger.debug('Invalidated watched-series cache', {
                userId,
                jellyfinUserId,
            });
        }
    } catch (error) {
        logger.warn('Failed to invalidate watched-series cache', {
            userId,
            error,
        });
    }
}

/**
 * Invalidate the per-user Continue Watching / Next Up durable-row cache
 * (CACHE_NAMESPACES.continueWatchingRows).
 *
 * Keys are `<ns>:<userId>:cw|nu:v3:<limit>`; the per-user delete clears every
 * key version and limit variant at once. Called on every explicit watch mutation
 * so a marked/cleared item leaves (or a next-up advances) immediately rather
 * than lingering for the short TTL. Best-effort: a failure only means the
 * durable rows self-heal on the next TTL expiry.
 */
export async function invalidateContinueWatchingCache(userId: UserId): Promise<void> {
    try {
        const cwCache = cacheManager.for(CACHE_NAMESPACES.continueWatchingRows);
        await cwCache.deleteUserCache(userId);
        logger.debug('Invalidated continue-watching/next-up cache', { userId });
    } catch (error) {
        logger.warn('Failed to invalidate continue-watching cache', { userId, error });
    }
}

/**
 * Invalidate all watched-related caches for a user.
 * Call this when marking episodes as watched to ensure all APIs reflect updates.
 */
export async function invalidateAllWatchedCaches(userId: UserId): Promise<void> {
    await Promise.all([
        invalidateWatchedCache(userId),
        invalidateWatchedSeriesCache(userId),
        invalidateContinueWatchingCache(userId),
        cacheInvalidation.onWatchStateChanged(userId),
    ]);
}

/**
 * Get cached watched items for a user
 * Returns null if not cached
 *
 * IMPORTANT: Returns composite keys (tmdb_id + media_type) to correctly handle
 * TMDB ID collisions where same ID can be both movie and TV show.
 */
export async function getCachedWatchedIds(userId: UserId): Promise<WatchedItem[] | null> {
    const cacheKey = getWatchedCacheKey(userId);
    return await watchedCache.get<WatchedItem[]>(cacheKey);
}

/**
 * Set cached watched items for a user
 *
 * IMPORTANT: Requires both tmdb_id AND media_type to correctly handle
 * TMDB ID collisions where same ID can be both movie and TV show.
 */
export async function setCachedWatchedIds(
    userId: UserId,
    watchedItems: WatchedItem[],
): Promise<void> {
    const cacheKey = getWatchedCacheKey(userId);
    await watchedCache.set(cacheKey, watchedItems);
}

/**
 * Convert cached watched items to an ExternalIdSet for efficient lookups
 * Returns empty ExternalIdSet if cache is empty/null
 */
export async function getWatchedExternalIdSet(userId: UserId): Promise<ExternalIdSet> {
    const cached = await getCachedWatchedIds(userId);
    const set = new ExternalIdSet();
    if (cached) {
        cached.forEach((item) => {
            if (isMovie(item.media_type) || isSeries(item.media_type)) {
                const numericId = Number(item.tmdb_id);
                if (!isNaN(numericId)) {
                    set.add(numericId, item.media_type);
                }
            }
        });
    }
    return set;
}
