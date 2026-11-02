// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trickplay Tile (Sprite Sheet) Cache
 *
 * Caches fetched sprite sheet images from Jellyfin to avoid
 * re-fetching the same sprite sheet for each I-frame request.
 * A single sprite sheet contains 100 thumbnails (10x10 grid),
 * so caching avoids 100x bandwidth for each sheet.
 *
 * Key format: `${itemId}-${mediaSourceId}-${width}-${sheetIndex}`
 */

import { LRUCache } from '../cache/lru-cache';
import { standaloneCacheRegistry } from '../cache/standalone-registry';

// LRU cache for sprite sheet images
// 100 sprite sheets max (~50-100MB for JPEG sprite sheets), 30 min TTL
const tileCache = new LRUCache<Buffer>({
    maxSize: 100,
    defaultTTL: 30 * 60 * 1000, // 30 minutes
    namespace: 'trickplay-sprites',
});

// Register with standalone cache registry for admin monitoring
standaloneCacheRegistry.register({
    name: 'trickplay-sprites',
    description: 'api/v1: Trickplay sprite sheets (10x10 thumbnail grids)',
    category: 'playback',
    cache: tileCache,
});

/**
 * Build cache key for a sprite sheet
 */
export function buildTileCacheKey(
    itemId: string,
    sheetIndex: number,
    trickplayWidth: number,
    mediaSourceId?: string | null,
): string {
    return `${itemId}-${mediaSourceId || 'default'}-${trickplayWidth}-${sheetIndex}`;
}

/**
 * Get cached sprite sheet
 */
export function getCachedTile(cacheKey: string): Buffer | null {
    return tileCache.get(cacheKey) ?? null;
}

/**
 * Cache a sprite sheet
 */
export function cacheTile(cacheKey: string, tile: Buffer): void {
    tileCache.set(cacheKey, tile);
}

/**
 * Get cache stats for monitoring
 */
export function getTileCacheStats() {
    return tileCache.getStats();
}
