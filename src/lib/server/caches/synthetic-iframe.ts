// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Synthetic I-Frame Cache
 *
 * Caches encoded I-frame video segments generated from trickplay thumbnails.
 * Uses LRU eviction to prevent memory bloat.
 *
 * Key format: `${itemId}-${mediaSourceId}-${trickplayWidth}-${iframeIndex}`
 */

import { LRUCache } from '../cache/lru-cache';
import { standaloneCacheRegistry } from '../cache/standalone-registry';

// LRU cache for encoded I-frame segments
// 2000 segments max (~10-40MB for small video segments), 1 hour TTL
// A 2h movie at 10s intervals = 720 I-frames, so 2000 supports 2-3 concurrent movies
const iframeCache = new LRUCache<Buffer>({
    maxSize: 2000,
    defaultTTL: 60 * 60 * 1000, // 1 hour
    namespace: 'synthetic-iframes',
});

// Register with standalone cache registry for admin monitoring
standaloneCacheRegistry.register({
    name: 'synthetic-iframes',
    description: 'api/v1: Encoded I-frame segments for Apple TV scrubbing',
    category: 'playback',
    cache: iframeCache,
});

/**
 * Build cache key for a synthetic I-frame
 */
export function buildIFrameCacheKey(
    itemId: string,
    iframeIndex: number,
    trickplayWidth: number,
    mediaSourceId?: string | null,
): string {
    return `${itemId}-${mediaSourceId || 'default'}-${trickplayWidth}-${iframeIndex}`;
}

/**
 * Get cached I-frame segment
 */
export function getCachedIFrame(cacheKey: string): Buffer | null {
    return iframeCache.get(cacheKey) ?? null;
}

/**
 * Cache an I-frame segment
 */
export function cacheIFrame(cacheKey: string, segment: Buffer): void {
    iframeCache.set(cacheKey, segment);
}

/**
 * Get cache stats for monitoring
 */
export function getIFrameCacheStats() {
    return iframeCache.getStats();
}
