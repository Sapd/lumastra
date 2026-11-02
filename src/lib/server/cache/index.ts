// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unified Caching System - Main Export
 *
 * PREFERRED USAGE (type-safe):
 * ```typescript
 * import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
 *
 * // Use cacheManager.for() for type safety and automatic TTL configuration
 * const trendingCache = cacheManager.for(CACHE_NAMESPACES.trending);
 *
 * // Get cached data
 * const cached = await trendingCache.get('movies:20');
 * if (cached) return cached;
 *
 * // Compute and cache
 * const trending = await fetchTrending();
 * await trendingCache.set('movies:20', trending);
 *
 * // Invalidate after content changes
 * await cacheInvalidation.invalidateTrending();
 * ```
 *
 * BENEFITS OF cacheManager.for():
 * - Compile-time error if namespace doesn't exist in registry
 * - IDE autocomplete for namespace names (CACHE_NAMESPACES.xxx)
 * - TTLs automatically applied from centralized config
 * - No possibility of typos or namespace mismatches
 *
 * ADDING A NEW CACHE:
 * 1. Add the namespace to CACHE_NAMESPACES in ./namespaces.ts
 * 2. Use cacheManager.for(CACHE_NAMESPACES.yourCache) in your code
 */

export { LRUCache, type CacheEntry, type CacheStats, type LRUCacheOptions } from './lru-cache';
export { UnifiedCache, CacheManager, type CacheOptions, type CacheMetrics } from './unified-cache';
export {
    CacheInvalidationService,
    cacheInvalidation,
    type InvalidationReason,
    type InvalidationEvent,
} from './invalidation';
export {
    CacheWarmingService,
    getCacheWarmingService,
    startCacheWarming,
    type CacheWarmingConfig,
    type CacheWarmingProgress,
} from './warming';
export {
    CACHE_NAMESPACES,
    CACHE_KEY_VERSIONS,
    type CacheNamespace,
    type CacheNamespaceConfig,
    type CacheKeyVersion,
    type RegisteredCacheConfig,
    buildVersionedCacheKey,
    browseGenresCacheKey,
    getAllNamespaceConfigs,
    getNamespaceConfig,
    getValidNamespaceNames,
    isRegisteredNamespace,
    validateNamespace,
} from './namespaces';
export {
    standaloneCacheRegistry,
    type StandaloneCacheCategory,
    type StandaloneCacheConfig,
    type StandaloneCacheStats,
} from './standalone-registry';
export {
    ScopedCache,
    boundedCache,
    searchScopedCache,
    searchScopedCacheWithBoundary,
    browseScopedCache,
    type AccessScope,
    type SingleFlightOverrides,
} from './scoped-cache';

// Export singleton instances
import { CacheManager } from './unified-cache';
import { getAllNamespaceConfigs } from './namespaces';

export const cacheManager = CacheManager.getInstance();

// Pre-initialize all registered cache namespaces so they show up in admin stats
// Uses the centralized namespace registry as the single source of truth
for (const config of getAllNamespaceConfigs()) {
    cacheManager.getCache(config.name, {
        l1TTL: config.l1TTL,
        l2TTL: config.l2TTL,
    });
}
