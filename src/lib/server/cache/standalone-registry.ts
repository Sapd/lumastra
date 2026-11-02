// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standalone LRU Cache Registry
 *
 * Provides a central registry for standalone LRU caches that exist outside
 * the UnifiedCache system. This enables monitoring and management of these
 * caches through the admin dashboard.
 *
 * Usage:
 * ```typescript
 * import { standaloneCacheRegistry } from '$lib/server/cache';
 * import { LRUCache } from '$lib/server/cache';
 *
 * const myCache = new LRUCache<MyType>({ maxSize: 100, namespace: 'my-cache' });
 *
 * standaloneCacheRegistry.register({
 *   name: 'my-cache',
 *   description: 'Caches my data',
 *   category: 'media',
 *   cache: myCache
 * });
 * ```
 */

import type { LRUCache, CacheStats } from './lru-cache';

/**
 * Category for grouping related caches in the admin UI
 */
export type StandaloneCacheCategory = 'playback' | 'media' | 'auth' | 'other';

/**
 * Configuration for registering a standalone cache
 */
export interface StandaloneCacheConfig {
    /** Unique identifier for the cache */
    name: string;
    /** Human-readable description */
    description: string;
    /** Category for grouping in admin UI */
    category: StandaloneCacheCategory;
    /** The LRU cache instance */
    cache: LRUCache<unknown>;
}

/**
 * Stats returned for a standalone cache
 */
export interface StandaloneCacheStats extends CacheStats {
    name: string;
    description: string;
    category: StandaloneCacheCategory;
}

/**
 * Registry for standalone LRU caches
 */
class StandaloneCacheRegistry {
    private caches: Map<string, StandaloneCacheConfig> = new Map();

    /**
     * Register a standalone LRU cache
     */
    register(config: StandaloneCacheConfig): void {
        if (this.caches.has(config.name)) {
            // Already registered, skip (allows re-registration on hot reload)
            return;
        }
        this.caches.set(config.name, config);
    }

    /**
     * Get a registered cache by name
     */
    get(name: string): StandaloneCacheConfig | undefined {
        return this.caches.get(name);
    }

    /**
     * Check if a cache is registered
     */
    has(name: string): boolean {
        return this.caches.has(name);
    }

    /**
     * Get all registered cache names
     */
    getNames(): string[] {
        return Array.from(this.caches.keys());
    }

    /**
     * Get stats for all registered caches
     */
    getAllStats(): StandaloneCacheStats[] {
        const stats: StandaloneCacheStats[] = [];

        for (const [name, config] of this.caches) {
            const cacheStats = config.cache.getStats();
            stats.push({
                name,
                description: config.description,
                category: config.category,
                ...cacheStats,
            });
        }

        return stats;
    }

    /**
     * Get stats for a specific cache
     */
    getStats(name: string): StandaloneCacheStats | null {
        const config = this.caches.get(name);
        if (!config) return null;

        const cacheStats = config.cache.getStats();
        return {
            name,
            description: config.description,
            category: config.category,
            ...cacheStats,
        };
    }

    /**
     * Get stats grouped by category
     */
    getStatsByCategory(): Record<StandaloneCacheCategory, StandaloneCacheStats[]> {
        const result: Record<StandaloneCacheCategory, StandaloneCacheStats[]> = {
            playback: [],
            media: [],
            auth: [],
            other: [],
        };

        for (const stats of this.getAllStats()) {
            result[stats.category].push(stats);
        }

        return result;
    }

    /**
     * Clear a specific cache
     */
    clear(name: string): boolean {
        const config = this.caches.get(name);
        if (!config) return false;

        config.cache.clear();
        return true;
    }

    /**
     * Clear all registered caches
     */
    clearAll(): void {
        for (const config of this.caches.values()) {
            config.cache.clear();
        }
    }

    /**
     * Get aggregate stats across all standalone caches
     */
    getAggregateStats(): {
        totalCaches: number;
        totalEntries: number;
        totalMaxSize: number;
        totalHits: number;
        totalMisses: number;
        totalEvictions: number;
        overallHitRate: number;
    } {
        let totalEntries = 0;
        let totalMaxSize = 0;
        let totalHits = 0;
        let totalMisses = 0;
        let totalEvictions = 0;

        for (const config of this.caches.values()) {
            const stats = config.cache.getStats();
            totalEntries += stats.size;
            totalMaxSize += stats.maxSize;
            totalHits += stats.hits;
            totalMisses += stats.misses;
            totalEvictions += stats.evictions;
        }

        const totalRequests = totalHits + totalMisses;

        return {
            totalCaches: this.caches.size,
            totalEntries,
            totalMaxSize,
            totalHits,
            totalMisses,
            totalEvictions,
            overallHitRate: totalRequests > 0 ? totalHits / totalRequests : 0,
        };
    }
}

// Singleton instance
export const standaloneCacheRegistry = new StandaloneCacheRegistry();
