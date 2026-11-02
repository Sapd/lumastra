// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Thread-safe LRU (Least Recently Used) Cache Implementation
 *
 * Features:
 * - Automatic eviction when size limit reached
 * - TTL-based expiration
 * - User-scoped namespacing
 * - Memory-efficient with configurable limits
 * - Cache hit/miss metrics
 */

export interface CacheEntry<T> {
    value: T;
    expiresAt: number;
    accessCount: number;
    createdAt: number;
    lastAccessed: number;
}

export interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
    size: number;
    maxSize: number;
    hitRate: number;
}

export interface LRUCacheOptions {
    maxSize?: number;
    defaultTTL?: number; // milliseconds
    namespace?: string;
}

export class LRUCache<T> {
    private cache: Map<string, CacheEntry<T>>;
    private readonly maxSize: number;
    private readonly defaultTTL: number;
    private readonly namespace: string;

    // Metrics
    private hits = 0;
    private misses = 0;
    private evictions = 0;

    constructor(options: LRUCacheOptions = {}) {
        this.cache = new Map();
        this.maxSize = options.maxSize ?? 500;
        this.defaultTTL = options.defaultTTL ?? 60 * 60 * 1000; // 1 hour default
        this.namespace = options.namespace ?? 'default';
    }

    /**
     * Generate namespaced key
     */
    private getKey(key: string, userId?: string): string {
        if (userId) {
            return `${this.namespace}:${userId}:${key}`;
        }
        return `${this.namespace}:${key}`;
    }

    /**
     * Get value from cache
     */
    get(key: string, userId?: string): T | null {
        const fullKey = this.getKey(key, userId);
        const entry = this.cache.get(fullKey);

        if (!entry) {
            this.misses++;
            return null;
        }

        // Check if expired
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(fullKey);
            this.misses++;
            return null;
        }

        // Update access metadata
        entry.accessCount++;
        entry.lastAccessed = Date.now();

        // Move to end (most recently used)
        this.cache.delete(fullKey);
        this.cache.set(fullKey, entry);

        this.hits++;
        return entry.value;
    }

    /**
     * Set value in cache
     */
    set(key: string, value: T, ttl?: number, userId?: string): void {
        const fullKey = this.getKey(key, userId);

        // Evict if at capacity and key doesn't exist
        if (!this.cache.has(fullKey) && this.cache.size >= this.maxSize) {
            this.evictLRU();
        }

        const now = Date.now();
        const expiresAt = now + (ttl ?? this.defaultTTL);

        this.cache.set(fullKey, {
            value,
            expiresAt,
            accessCount: 0,
            createdAt: now,
            lastAccessed: now,
        });
    }

    /**
     * Check if key exists and is not expired
     */
    has(key: string, userId?: string): boolean {
        const fullKey = this.getKey(key, userId);
        const entry = this.cache.get(fullKey);

        if (!entry) return false;

        if (Date.now() > entry.expiresAt) {
            this.cache.delete(fullKey);
            return false;
        }

        return true;
    }

    /**
     * Delete specific key
     */
    delete(key: string, userId?: string): boolean {
        const fullKey = this.getKey(key, userId);
        return this.cache.delete(fullKey);
    }

    /**
     * Delete all keys for a specific user
     */
    deleteUserCache(userId: string): number {
        let deleted = 0;
        const userPrefix = `${this.namespace}:${userId}:`;

        for (const key of this.cache.keys()) {
            if (key.startsWith(userPrefix)) {
                this.cache.delete(key);
                deleted++;
            }
        }

        return deleted;
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
        this.evictions = 0;
    }

    /**
     * Evict least recently used entry
     */
    private evictLRU(): void {
        // Map is ordered by insertion, first key is LRU
        const firstKey = this.cache.keys().next().value;
        if (firstKey) {
            this.cache.delete(firstKey);
            this.evictions++;
        }
    }

    /**
     * Remove all expired entries
     */
    cleanup(): number {
        const now = Date.now();
        let removed = 0;

        for (const [key, entry] of this.cache.entries()) {
            if (now > entry.expiresAt) {
                this.cache.delete(key);
                removed++;
            }
        }

        return removed;
    }

    /**
     * Get cache statistics
     */
    getStats(): CacheStats {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            size: this.cache.size,
            maxSize: this.maxSize,
            hitRate: total > 0 ? this.hits / total : 0,
        };
    }

    /**
     * Get all keys matching a pattern
     */
    keys(pattern?: RegExp): string[] {
        const keys = Array.from(this.cache.keys());

        if (!pattern) return keys;

        return keys.filter((key) => pattern.test(key));
    }

    /**
     * Get cache size
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Get detailed entry metadata
     */
    getEntryMetadata(key: string, userId?: string): Omit<CacheEntry<T>, 'value'> | null {
        const fullKey = this.getKey(key, userId);
        const entry = this.cache.get(fullKey);

        if (!entry) return null;

        const { value, ...metadata } = entry;
        void value;
        return metadata;
    }
}
