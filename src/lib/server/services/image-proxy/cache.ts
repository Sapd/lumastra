// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Cache Utilities
 *
 * Handles file-based caching with request deduplication to prevent stampedes.
 */

import { admitImageWork, runAdmittedImageWork, type ImageWork } from './work-budget';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Logger } from '$lib/server/utils/logger';
import { recordPhase } from './perf-context';

const logger = Logger.for('ImageCache');

export interface CacheConfig {
    directory: string;
    ttl: number; // milliseconds
    /**
     * Keep an expired entry on disk and serve it when its refetch fails,
     * instead of deleting it on read. For images whose upstream can refuse us
     * for a while (a CDN 403-ing the egress IP): a week-old copy beats a
     * placeholder. The cleanup job's retention still removes it eventually.
     * A function decides per error (e.g. not for "the image is gone").
     */
    staleIfError?: boolean | ((err: unknown) => boolean);
}

export interface CacheResult {
    buffer: Buffer;
    wasHit: boolean;
    /** Served an expired entry because the refetch failed (`staleIfError`). */
    stale?: boolean;
}

export interface CacheStorage {
    read(key: string): Promise<Buffer | null>;
    write(key: string, data: Buffer): Promise<void>;
    delete(key: string): Promise<void>;
    deleteByPrefix(prefix: string): Promise<number>;
    exists(key: string): Promise<{ exists: boolean; mtime?: Date }>;
}

export class FileSystemCacheStorage implements CacheStorage {
    /** Resolved cache root, computed once and used as the containment boundary. */
    private readonly base: string;

    constructor(private directory: string) {
        this.base = path.resolve(directory);
    }

    /**
     * Resolve a cache key to an absolute path, enforcing that it stays inside
     * the cache directory. Returns null if the key would escape (path traversal).
     *
     * All current call sites pass server-generated keys (hashes, numeric IDs,
     * allowlisted types), so this is defense-in-depth: it guarantees the storage
     * abstraction is safe-by-default even if a future caller forwards unsanitized
     * input as a cache key.
     */
    private resolveKeyPath(key: string): string | null {
        const target = path.resolve(this.base, key);
        if (target !== this.base && !target.startsWith(this.base + path.sep)) {
            logger.warn('Rejected cache key escaping cache directory', { key });
            return null;
        }
        return target;
    }

    async read(key: string): Promise<Buffer | null> {
        const filePath = this.resolveKeyPath(key);
        if (!filePath) return null;
        try {
            return await fs.readFile(filePath);
        } catch {
            return null;
        }
    }

    async write(key: string, data: Buffer): Promise<void> {
        const filePath = this.resolveKeyPath(key);
        if (!filePath) throw new Error('Invalid cache key');
        await fs.mkdir(this.directory, { recursive: true });
        // Write-then-rename: with a cache volume shared by several pods, a reader
        // must never see a half-written image.
        const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
            await fs.writeFile(tmpPath, data);
            await fs.rename(tmpPath, filePath);
        } catch (err) {
            await fs.unlink(tmpPath).catch(() => {});
            throw err;
        }
    }

    async delete(key: string): Promise<void> {
        const filePath = this.resolveKeyPath(key);
        if (!filePath) return;
        try {
            await fs.unlink(filePath);
        } catch {
            /* ignore */
        }
    }

    async deleteByPrefix(prefix: string): Promise<number> {
        // Cheap early reject: a prefix is a bare filename fragment, never a path.
        if (prefix.includes('..') || prefix.includes('/') || prefix.includes('\\')) return 0;
        try {
            const files = await fs.readdir(this.directory);
            // Skip in-flight writes: unlinking one makes its rename fail.
            const matching = files.filter((f) => f.startsWith(prefix) && !f.endsWith('.tmp'));
            await Promise.all(
                matching.map((f) => {
                    // Route each unlink through the shared containment check so this
                    // method shares one boundary primitive with read/write/delete.
                    const filePath = this.resolveKeyPath(f);
                    return filePath ? fs.unlink(filePath).catch(() => {}) : Promise.resolve();
                }),
            );
            return matching.length;
        } catch {
            // best-effort: image cache cleanup — a missing/unreadable dir means nothing to delete.
            return 0;
        }
    }

    async exists(key: string): Promise<{ exists: boolean; mtime?: Date }> {
        const filePath = this.resolveKeyPath(key);
        if (!filePath) return { exists: false };
        try {
            const stats = await fs.stat(filePath);
            return { exists: true, mtime: stats.mtime };
        } catch {
            // best-effort: stat failure means the cache entry isn't present.
            return { exists: false };
        }
    }
}

export class ImageCache {
    private pendingRequests = new Map<string, Promise<Buffer>>();
    private storage: CacheStorage;

    constructor(
        private config: CacheConfig,
        storage?: CacheStorage,
    ) {
        this.storage = storage ?? new FileSystemCacheStorage(config.directory);
        void this.ensureCacheDir();
    }

    /**
     * Ensure cache directory exists
     */
    private async ensureCacheDir(): Promise<void> {
        try {
            await fs.mkdir(this.config.directory, { recursive: true });
        } catch (err) {
            logger.error('Failed to create cache directory', err as Error, {
                directory: this.config.directory,
            });
        }
    }

    /**
     * Read from cache if exists and not expired
     */
    async read(cacheKey: string): Promise<Buffer | null> {
        const info = await this.storage.exists(cacheKey);

        if (!info.exists || !info.mtime) {
            return null;
        }

        const age = Date.now() - info.mtime.getTime();

        if (age < this.config.ttl) {
            const buffer = await this.storage.read(cacheKey);
            // A zero-byte entry (crash before the data reached disk) is a miss.
            return buffer && buffer.length > 0 ? buffer : null;
        }
        // Kept for getCachedOrFetch's fallback; a successful refetch overwrites it.
        if (this.config.staleIfError) return null;

        // Expired cache, delete it
        await this.storage.delete(cacheKey).catch((err) => {
            logger.debug('Failed to delete expired cache file', {
                cacheKey,
                error: err instanceof Error ? err.message : String(err),
            });
        });
        return null;
    }

    /**
     * Write to cache (async, don't wait)
     */
    async write(cacheKey: string, buffer: Buffer): Promise<void> {
        try {
            await this.storage.write(cacheKey, buffer);
        } catch (err) {
            logger.warn('Failed to write cache file', {
                cacheKey,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Get cached image or fetch from source with request deduplication
     *
     * Prevents multiple concurrent requests for the same uncached image
     * from hitting the upstream provider.
     *
     * @returns Object with buffer and cache hit status (wasHit: true if cached, false if fetched)
     */
    async getCachedOrFetch(
        cacheKey: string,
        fetchFn: () => Promise<Buffer>,
        work: ImageWork = {},
    ): Promise<CacheResult> {
        // Check cache first
        const readStart = performance.now();
        const cached = await this.read(cacheKey);
        recordPhase('cache.read', performance.now() - readStart);
        if (cached) {
            return { buffer: cached, wasHit: true };
        }

        // Admission belongs to this request, never to the promise other users await.
        await admitImageWork(work);
        const admittedFetch = (): Promise<Buffer> => runAdmittedImageWork(work, fetchFn);
        if (!this.config.staleIfError) return this.fetchDeduped(cacheKey, admittedFetch);
        try {
            return await this.fetchDeduped(cacheKey, admittedFetch);
        } catch (err) {
            const { staleIfError } = this.config;
            if (typeof staleIfError === 'function' && !staleIfError(err)) throw err;
            // read() left the expired entry in place; serve it rather than nothing.
            const stale = await this.storage.read(cacheKey).catch(() => null);
            if (stale && stale.length > 0) return { buffer: stale, wasHit: true, stale: true };
            throw err;
        }
    }

    private async fetchDeduped(
        cacheKey: string,
        fetchFn: () => Promise<Buffer>,
    ): Promise<CacheResult> {
        // Check if there's already a pending request for this key
        const pending = this.pendingRequests.get(cacheKey);
        if (pending) {
            // Return from pending request (cache miss since it's being fetched)
            const waitStart = performance.now();
            const buffer = await pending;
            recordPhase('cache.dedupe-wait', performance.now() - waitStart);
            return { buffer, wasHit: false };
        }

        // Fetch and cache
        const promise = fetchFn()
            .then((buffer) => {
                if (!buffer || buffer.length === 0) {
                    throw new Error('Empty fetch result');
                }

                // Write to cache (async, don't wait)
                const writeStart = performance.now();
                this.write(cacheKey, buffer)
                    .then(() => recordPhase('cache.write', performance.now() - writeStart))
                    .catch((err) => {
                        logger.warn('Cache write failed', {
                            cacheKey,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    });

                // Clean up pending request
                this.pendingRequests.delete(cacheKey);
                return buffer;
            })
            .catch((err) => {
                // Clean up on error
                this.pendingRequests.delete(cacheKey);
                throw err;
            });

        this.pendingRequests.set(cacheKey, promise);
        const buffer = await promise;
        return { buffer, wasHit: false };
    }

    /**
     * Delete a cache file
     */
    async delete(cacheKey: string): Promise<void> {
        try {
            await this.storage.delete(cacheKey);
        } catch (err) {
            // Ignore errors (file might not exist)
            logger.debug('Failed to delete cache file (may not exist)', {
                cacheKey,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Delete all cache files matching a prefix.
     * Used for avatar cache invalidation where a user may have multiple
     * cached variants (different qualities/formats).
     */
    async deleteByPrefix(prefix: string): Promise<number> {
        try {
            return await this.storage.deleteByPrefix(prefix);
        } catch (err) {
            logger.debug('Failed to delete cache files by prefix', {
                prefix,
                error: err instanceof Error ? err.message : String(err),
            });
            return 0;
        }
    }

    /**
     * Clear all cache files (useful for testing)
     */
    async clear(): Promise<void> {
        try {
            const files = await fs.readdir(this.config.directory);
            await Promise.all(
                files.map((file) => fs.unlink(path.join(this.config.directory, file))),
            );
        } catch (err) {
            logger.error('Failed to clear cache', err as Error);
        }
    }
}
