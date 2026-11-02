// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unified Caching Service
 *
 * Provides a coordinated multi-layer caching strategy:
 * - L1: In-memory LRU cache (fastest, local to instance)
 * - L2: Valkey/Redis (shared across instances)
 * - L3: Database (source of truth)
 *
 * Features:
 * - Automatic cache promotion (L2 → L1 on hit)
 * - Write-through consistency
 * - Graceful degradation if layers unavailable
 * - Cache invalidation hooks
 * - Comprehensive metrics
 */

import { LRUCache, type CacheStats } from './lru-cache';
import { Logger } from '../utils/logger';
import type { RegisteredCacheConfig } from './namespaces';

const logger = Logger.for('UnifiedCache');

export interface CacheOptions {
    l1TTL?: number; // L1 in-memory TTL
    l2TTL?: number; // L2 Valkey TTL
    namespace: string;
    enableL1?: boolean;
    enableL2?: boolean;
    /**
     * On an L2 hit, promote into L1 for `min(l1TTL, remaining L2 life)` rather
     * than the flat `l1TTL`.
     *
     * Without this, L1 can OUTLIVE the L2 entry it was promoted from: a replica
     * that reads a key one second before it expires still holds it for the full
     * l1TTL afterwards. That is tolerable while every entry in a namespace
     * shares one TTL, and wrong as soon as entries carry different ones — a
     * short-lived entry promoted at the namespace default silently gets the
     * long life it was specifically denied, on every replica except the one
     * that wrote it.
     *
     * Costs one extra Valkey round-trip per L2 hit, which is why it is opt-in
     * per namespace instead of the default. Turn it on for any namespace whose
     * writers pass a per-entry TTL.
     */
    promoteWithRemainingTtl?: boolean;
}

export interface CacheMetrics {
    l1Stats: CacheStats;
    l2Hits: number;
    l2Misses: number;
    l2Errors: number;
    writeThrough: number;
    invalidations: number;
}

type CacheValue = string | number | boolean | object | null;

// Valkey helper functions - imported dynamically
let valkeyHelpers: {
    connectValkey: () => Promise<boolean>;
    getValkeyClient: () => unknown;
    cacheGet: (key: string) => Promise<string | null>;
    cacheSet: (key: string, value: string, ttlSeconds?: number) => Promise<boolean>;
    cacheDel: (key: string | string[]) => Promise<number>;
    cacheExists: (key: string) => Promise<boolean>;
    getKeyTtlSeconds: (key: string) => Promise<number>;
    getKeysByPattern: (pattern: string, limit?: number) => Promise<string[]>;
    deleteKeysByPattern: (pattern: string, batchSize?: number) => Promise<number>;
} | null = null;

let valkeyInitPromise: Promise<boolean> | null = null;

async function initValkeyHelpers(): Promise<boolean> {
    if (valkeyHelpers) return true;

    if (valkeyInitPromise) {
        return valkeyInitPromise;
    }

    valkeyInitPromise = (async () => {
        try {
            const valkey = await import('../cache/valkey');
            const connected = await valkey.connectValkey();
            if (connected) {
                valkeyHelpers = {
                    connectValkey: valkey.connectValkey,
                    getValkeyClient: valkey.getValkeyClient,
                    cacheGet: valkey.cacheGet,
                    cacheSet: valkey.cacheSet,
                    cacheDel: valkey.cacheDel,
                    cacheExists: valkey.cacheExists,
                    getKeyTtlSeconds: valkey.getKeyTtlSeconds,
                    getKeysByPattern: valkey.getKeysByPattern,
                    deleteKeysByPattern: valkey.deleteKeysByPattern,
                };
                logger.info('Valkey helpers initialized');
                return true;
            }
            return false;
        } catch (error) {
            logger.warn('Failed to initialize Valkey helpers', {}, error as Error);
            return false;
        }
    })();

    return valkeyInitPromise;
}

export class UnifiedCache {
    private l1Cache: LRUCache<CacheValue>;
    private readonly options: Required<CacheOptions>;
    private l2Ready = false;
    private l2InitPromise: Promise<void> | null = null;

    // Metrics
    private l2Hits = 0;
    private l2Misses = 0;
    private l2Errors = 0;
    private writeThroughCount = 0;
    private invalidationCount = 0;

    constructor(options: CacheOptions) {
        this.options = {
            l1TTL: options.l1TTL ?? 5 * 60 * 1000, // 5 minutes default
            l2TTL: options.l2TTL ?? 60 * 60 * 1000, // 1 hour default
            namespace: options.namespace,
            enableL1: options.enableL1 ?? true,
            // `l2TTL: 0` declares an L1-only namespace (library roots, path
            // mappings). It must NOT reach Valkey: cacheSet treats a 0 TTL as
            // "no expiry", so the entry was written once and served forever —
            // a file-read allow-list that never saw a root added or removed
            // outside the admin API, despite promising a 60 s refresh.
            enableL2: options.enableL2 ?? options.l2TTL !== 0,
            promoteWithRemainingTtl: options.promoteWithRemainingTtl ?? false,
        };

        // Initialize L1 cache
        this.l1Cache = new LRUCache({
            maxSize: 500,
            defaultTTL: this.options.l1TTL,
            namespace: this.options.namespace,
        });
    }

    /**
     * Initialize Valkey connection
     */
    private async initializeL2Cache(): Promise<void> {
        try {
            const connected = await initValkeyHelpers();
            if (connected) {
                this.l2Ready = true;
                // Cache initialized successfully (verbose logging removed)
            } else {
                logger.warn('Failed to connect to Valkey, L2 cache disabled', {
                    namespace: this.options.namespace,
                });
            }
        } catch (error) {
            logger.warn('L2 cache unavailable, falling back to L1 only', {
                namespace: this.options.namespace,
                error,
            });
        }
    }

    private async ensureL2Ready(): Promise<void> {
        if (!this.options.enableL2 || this.l2Ready) {
            return;
        }

        if (!this.l2InitPromise) {
            this.l2InitPromise = this.initializeL2Cache();
        }

        await this.l2InitPromise;
    }

    /**
     * Get value from cache (L1 → L2 → null)
     */
    async get<T = CacheValue>(key: string, userId?: string): Promise<T | null> {
        // Try L1 first
        if (this.options.enableL1) {
            const l1Value = this.l1Cache.get(key, userId);
            if (l1Value !== null) {
                return l1Value as T;
            }
        }

        await this.ensureL2Ready();

        // Try L2 (Valkey)
        if (this.options.enableL2 && this.l2Ready && valkeyHelpers) {
            try {
                const l2Key = this.buildL2Key(key, userId);
                const l2Value = await valkeyHelpers.cacheGet(l2Key);

                if (l2Value !== null) {
                    this.l2Hits++;

                    // Deserialize once and reuse for both L1 promotion and return
                    const parsedValue = this.deserialize(l2Value);

                    // Promote to L1 — never for longer than the L2 entry has
                    // left to live, when the namespace asks for that.
                    if (this.options.enableL1) {
                        let promoteTtl = this.options.l1TTL;
                        if (this.options.promoteWithRemainingTtl) {
                            const remainingSeconds = await valkeyHelpers.getKeyTtlSeconds(l2Key);
                            // Valkey's TTL contract: -1 = key exists with no
                            // expiry, -2 = absent or unreachable. Neither bounds
                            // us, so only a positive value narrows the promotion.
                            if (remainingSeconds > 0) {
                                promoteTtl = Math.min(promoteTtl, remainingSeconds * 1000);
                            }
                        }
                        this.l1Cache.set(key, parsedValue, promoteTtl, userId);
                    }

                    return parsedValue as T;
                }

                this.l2Misses++;
            } catch (error) {
                this.l2Errors++;
                logger.warn('L2 cache read error', { key, userId, error });
            }
        }

        return null;
    }

    /**
     * Set value in cache (write-through to L1 and L2)
     */
    async set(key: string, value: CacheValue, ttl?: number, userId?: string): Promise<void> {
        // For L2, use custom TTL if provided, otherwise use configured L2 TTL
        const l2TTL = ttl ?? this.options.l2TTL;

        // For L1, use the MINIMUM of custom TTL and configured L1 TTL
        const l1TTL = ttl !== undefined ? Math.min(ttl, this.options.l1TTL) : this.options.l1TTL;

        // Write to L1
        if (this.options.enableL1) {
            this.l1Cache.set(key, value, l1TTL, userId);
        }

        // Write to L2 (non-blocking, but wait for init)
        if (this.options.enableL2) {
            void (async () => {
                await this.ensureL2Ready();
                if (this.l2Ready && valkeyHelpers) {
                    try {
                        const l2Key = this.buildL2Key(key, userId);
                        const serialized = this.serialize(value);
                        const ttlSeconds = Math.floor(l2TTL / 1000);
                        await valkeyHelpers.cacheSet(l2Key, serialized, ttlSeconds);
                    } catch (error) {
                        this.l2Errors++;
                        logger.warn('L2 cache write error', {
                            key,
                            userId,
                            error,
                        });
                    }
                }
            })();
        }

        this.writeThroughCount++;
    }

    /**
     * Check if key exists in any cache layer
     */
    async has(key: string, userId?: string): Promise<boolean> {
        // Check L1
        if (this.options.enableL1 && this.l1Cache.has(key, userId)) {
            return true;
        }

        // Check L2
        await this.ensureL2Ready();
        if (this.options.enableL2 && this.l2Ready && valkeyHelpers) {
            try {
                const l2Key = this.buildL2Key(key, userId);
                return await valkeyHelpers.cacheExists(l2Key);
            } catch (error) {
                logger.warn('L2 cache exists check error', {
                    key,
                    userId,
                    error,
                });
            }
        }

        return false;
    }

    /**
     * Delete key from all cache layers
     */
    async delete(key: string, userId?: string): Promise<void> {
        this.invalidationCount++;

        // Delete from L1
        if (this.options.enableL1) {
            this.l1Cache.delete(key, userId);
        }

        // Delete from L2
        await this.ensureL2Ready();
        if (this.options.enableL2 && this.l2Ready && valkeyHelpers) {
            try {
                const l2Key = this.buildL2Key(key, userId);
                await valkeyHelpers.cacheDel(l2Key);
            } catch (error) {
                logger.warn('L2 cache delete error', { key, userId, error });
            }
        }
    }

    /**
     * Delete all cache entries for a user
     */
    async deleteUserCache(userId: string): Promise<void> {
        this.invalidationCount++;

        // Delete from L1
        if (this.options.enableL1) {
            this.l1Cache.deleteUserCache(userId);
        }

        // Delete from L2 using SCAN
        await this.ensureL2Ready();
        if (this.options.enableL2 && this.l2Ready && valkeyHelpers) {
            try {
                const pattern = `${this.options.namespace}:${userId}:*`;
                const deletedCount = await valkeyHelpers.deleteKeysByPattern(pattern, 50);
                logger.debug('Deleted user cache', {
                    userId,
                    namespace: this.options.namespace,
                    count: deletedCount,
                });
            } catch (error) {
                logger.warn('L2 user cache delete error', { userId, error });
            }
        }
    }

    /**
     * Clear all cache entries in this namespace
     */
    async clear(): Promise<void> {
        // Clear L1
        if (this.options.enableL1) {
            this.l1Cache.clear();
        }

        // Clear L2 using SCAN
        await this.ensureL2Ready();
        if (this.options.enableL2 && this.l2Ready && valkeyHelpers) {
            try {
                const pattern = `${this.options.namespace}:*`;
                const deletedCount = await valkeyHelpers.deleteKeysByPattern(pattern, 100);
                logger.info('Cleared namespace cache', {
                    namespace: this.options.namespace,
                    count: deletedCount,
                });
            } catch (error) {
                logger.warn('L2 namespace clear error', { error });
            }
        }
    }

    /**
     * Drop only this process's in-memory entries for the namespace. Used when
     * another process already cleared L2 and broadcast the clear, so the
     * receivers must not touch the shared store again.
     */
    clearL1(): void {
        if (this.options.enableL1) {
            this.l1Cache.clear();
        }
    }

    /**
     * Run cleanup on expired entries
     */
    cleanup(): void {
        if (this.options.enableL1) {
            const removed = this.l1Cache.cleanup();
            if (removed > 0) {
                logger.debug('L1 cache cleanup', {
                    namespace: this.options.namespace,
                    removed,
                });
            }
        }
    }

    /**
     * Get comprehensive cache metrics
     */
    getMetrics(): CacheMetrics {
        return {
            l1Stats: this.l1Cache.getStats(),
            l2Hits: this.l2Hits,
            l2Misses: this.l2Misses,
            l2Errors: this.l2Errors,
            writeThrough: this.writeThroughCount,
            invalidations: this.invalidationCount,
        };
    }

    /**
     * Build L2 key with namespace and user
     */
    private buildL2Key(key: string, userId?: string): string {
        if (userId) {
            return `${this.options.namespace}:${userId}:${key}`;
        }
        return `${this.options.namespace}:${key}`;
    }

    /**
     * Serialize value for storage
     */
    private serialize(value: CacheValue): string {
        if (typeof value === 'string') return value;
        return JSON.stringify(value);
    }

    /**
     * Deserialize value from storage
     */
    private deserialize(value: string): CacheValue {
        try {
            const parsed: unknown = JSON.parse(value);
            if (parsed === null) return null;
            if (
                typeof parsed === 'string' ||
                typeof parsed === 'number' ||
                typeof parsed === 'boolean' ||
                typeof parsed === 'object'
            ) {
                return parsed;
            }
            return null;
        } catch {
            return value; // Return as-is if not JSON
        }
    }

    /**
     * Get cache layer availability status
     */
    getStatus(): { l1: boolean; l2: boolean } {
        return {
            l1: this.options.enableL1,
            l2: this.options.enableL2 && this.l2Ready,
        };
    }

    /**
     * Get the namespace of this cache
     */
    getNamespace(): string {
        return this.options.namespace;
    }
}

/**
 * Cache Manager - Singleton for managing multiple cache namespaces
 */
export class CacheManager {
    private static instance: CacheManager;
    private caches: Map<string, UnifiedCache> = new Map();
    private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

    private constructor() {
        // Start background cleanup every 5 minutes
        this.cleanupIntervalId = setInterval(() => this.runCleanup(), 5 * 60 * 1000);
    }

    static getInstance(): CacheManager {
        if (!CacheManager.instance) {
            CacheManager.instance = new CacheManager();
        }
        return CacheManager.instance;
    }

    /**
     * Get or create a cache for a namespace (PREFERRED METHOD)
     */
    for(config: RegisteredCacheConfig): UnifiedCache {
        if (!this.caches.has(config.name)) {
            this.caches.set(
                config.name,
                new UnifiedCache({
                    namespace: config.name,
                    l1TTL: config.l1TTL,
                    l2TTL: config.l2TTL,
                    // Declared on the namespace, so only namespaces that
                    // actually write per-entry TTLs pay the extra round-trip.
                    promoteWithRemainingTtl:
                        'promoteWithRemainingTtl' in config
                            ? config.promoteWithRemainingTtl === true
                            : false,
                }),
            );
        }
        return this.caches.get(config.name)!;
    }

    /**
     * Get or create a cache for a namespace by string name
     * @deprecated Prefer using `cacheManager.for(CACHE_NAMESPACES.xxx)` for type safety.
     */
    getCache(namespace: string, options?: Partial<CacheOptions>): UnifiedCache {
        if (!this.caches.has(namespace)) {
            this.warnIfUnregistered(namespace);
            this.caches.set(
                namespace,
                new UnifiedCache({
                    namespace,
                    ...options,
                }),
            );
        }
        return this.caches.get(namespace)!;
    }

    private warnIfUnregistered(namespace: string): void {
        void import('./namespaces')
            .then((module) => {
                const isRegisteredNamespace = module.isRegisteredNamespace;
                if (
                    typeof isRegisteredNamespace === 'function' &&
                    !isRegisteredNamespace(namespace)
                ) {
                    logger.warn(
                        `⚠️ UNREGISTERED CACHE NAMESPACE: "${namespace}". ` +
                            `Add it to CACHE_NAMESPACES in cache/namespaces.ts.`,
                    );
                }
            })
            .catch(() => {
                /* Dynamic import for warning is best-effort */
            });
    }

    registerCache(cache: UnifiedCache): void {
        const namespace = cache.getNamespace();
        if (!this.caches.has(namespace)) {
            this.caches.set(namespace, cache);
        }
    }

    private runCleanup(): void {
        for (const [namespace, cache] of this.caches.entries()) {
            try {
                cache.cleanup();
            } catch (error) {
                logger.warn('Cache cleanup error', { namespace, error });
            }
        }
    }

    getAllMetrics(): Record<string, CacheMetrics> {
        const metrics: Record<string, CacheMetrics> = {};
        for (const [namespace, cache] of this.caches.entries()) {
            metrics[namespace] = cache.getMetrics();
        }
        return metrics;
    }

    /**
     * Clear all caches except protected ones (user preference data).
     * Protected caches include: dismissState, excludedSeries
     * @param includeProtected - If true, also clears protected caches (use with caution)
     */
    async clearAll(includeProtected = false): Promise<void> {
        const { getProtectedNamespaceNames } = await import('./namespaces');

        // Build set of protected namespace names
        const protectedNames = new Set(getProtectedNamespaceNames());

        const cachesToClear = Array.from(this.caches.entries())
            .filter(([namespace]) => {
                if (includeProtected) return true;
                return !protectedNames.has(namespace);
            })
            .map(([, cache]) => cache);

        if (!includeProtected && protectedNames.size > 0) {
            const skipped = Array.from(this.caches.keys()).filter((ns) => protectedNames.has(ns));
            if (skipped.length > 0) {
                logger.info('Skipping protected caches during clearAll', {
                    skipped,
                });
            }
        }

        await Promise.all(cachesToClear.map((cache) => cache.clear()));
    }

    /**
     * Drop this process's L1 entries for a namespace by name. A namespace
     * this process never created holds nothing, so it is a no-op.
     */
    clearL1(namespace: string): void {
        this.caches.get(namespace)?.clearL1();
    }

    stopCleanupInterval(): void {
        if (this.cleanupIntervalId) {
            clearInterval(this.cleanupIntervalId);
            this.cleanupIntervalId = null;
            logger.debug('Cache cleanup interval stopped');
        }
    }
}
