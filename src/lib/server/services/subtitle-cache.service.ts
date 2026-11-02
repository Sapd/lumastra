// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subtitle Cache Service
 *
 * Multi-layer subtitle caching with direct FFmpeg extraction:
 * 1. Memory cache (fast, 30min TTL)
 * 2. File cache (persistent, 7 day TTL)
 * 3. FFmpeg extraction (direct from media file)
 * 4. Jellyfin API (fallback)
 *
 * Cache key: mediaSourceId:subtitleIndex (stable IDs)
 * File cache: cache/subtitles/{mediaSourceId}_{streamIndex}.vtt
 */

import { Logger } from '$lib/server/utils/logger.js';
import { parseWebVTT, type ParsedCue } from '$lib/server/utils/webvtt-parser.js';
import { sanitizeWebVTT } from '$lib/server/utils/subtitle-sanitizer.js';
import { jellyfinMediaService } from '$lib/server/jellyfin.js';
import type { JellyfinItem } from '$lib/server/jellyfin.js';
import { SubtitleFileCacheService } from './cache/subtitle-file-cache.service.js';
import { extractSubtitleStream } from '$lib/server/utils/ffmpeg-subtitle-extractor.js';
import { config } from '$lib/server/config.js';
import { isTextBasedSubtitle } from '$lib/server/utils/hls-audio-injection.js';
import { getDb } from '$lib/server/database/connection.js';
import { getExternalSubtitlesByJellyfinId } from '$lib/server/database/queries/external-subtitles.queries.js';
import { readSidecarText, SidecarTooLargeError } from '$lib/server/utils/sidecar-text.js';
import { ContainmentError, resolveContainedFile } from '$lib/server/utils/contained-fs.js';
import { resolve } from 'node:path';

const logger = Logger.for('SubtitleCacheService');

/**
 * Identifies a specific subtitle track.
 */
export interface SubtitleIdentifier {
    itemId: string;
    subtitleIndex: number;
    mediaSourceId: string;
}

interface CachedSubtitle {
    cues: ParsedCue[];
    fetchedAt: number; // Unix timestamp (ms) for faster comparison
}

interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
}

type MediaStreamInfo = {
    Type: string;
    Index: number;
    Codec?: string;
    IsExternal?: boolean;
};

type JellyfinItemWithPath = JellyfinItem & {
    Path?: string;
    MediaStreams?: MediaStreamInfo[];
};

type IntervalHandle = ReturnType<typeof setInterval> & { unref?: () => void };

class SubtitleCacheService {
    private cache = new Map<string, CachedSubtitle>();
    private stats: CacheStats = { hits: 0, misses: 0, evictions: 0 };

    /** Pending fetch requests to prevent duplicate concurrent fetches */
    private pendingFetches = new Map<string, Promise<ParsedCue[]>>();

    /** Semaphore locks for file extraction (prevent duplicate FFmpeg calls) */
    private extractionLocks = new Map<string, Promise<void>>();

    /** Cache TTL in milliseconds (30 minutes) */
    private readonly TTL_MS = 30 * 60 * 1000;

    /** Maximum cache entries (LRU eviction when exceeded) */
    private readonly MAX_ENTRIES = 50;

    /** Cleanup interval timer for memory cache */
    private cleanupInterval: IntervalHandle | null = null;

    /** Cleanup interval timer for file cache */
    private fileCleanupInterval: IntervalHandle | null = null;

    constructor() {
        // Start periodic cleanup for memory cache (every 5 minutes)
        this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
        this.cleanupInterval.unref?.();

        // Start periodic cleanup for file cache (every 24 hours)
        // Run cleanup immediately on startup, then every 24 hours
        this.scheduleFileCleanup();
    }

    /**
     * Schedule file cache cleanup (runs on startup and every 24 hours)
     */
    private scheduleFileCleanup(): void {
        // Run initial cleanup after 10 seconds (let server finish starting)
        setTimeout(() => {
            this.cleanupFileCache().catch((err) => {
                logger.warn('Initial file cache cleanup failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }, 10_000);

        // Schedule periodic cleanup every 24 hours
        this.fileCleanupInterval = setInterval(
            () => {
                this.cleanupFileCache().catch((err) => {
                    logger.warn('Periodic file cache cleanup failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
            },
            24 * 60 * 60 * 1000,
        ); // 24 hours
        this.fileCleanupInterval.unref?.();
    }

    /**
     * Get the age of a cached entry in milliseconds.
     */
    private getAge(entry: CachedSubtitle): number {
        return Date.now() - entry.fetchedAt;
    }

    /**
     * Generate cache key for a subtitle.
     */
    private getCacheKey(itemId: string, subtitleIndex: number, mediaSourceId: string): string {
        return `${itemId}:${subtitleIndex}:${mediaSourceId}`;
    }

    /**
     * Get cached cues with multi-layer caching strategy:
     * 1. Memory cache (fastest)
     * 2. File cache (persistent)
     * 3. FFmpeg extraction (direct from media)
     * 4. Jellyfin API (fallback)
     *
     * @param itemId - Jellyfin item ID
     * @param subtitleIndex - Subtitle stream index
     * @param mediaSourceId - Media source ID
     * @returns Parsed cues array
     */
    async getCues(
        itemId: string,
        subtitleIndex: number,
        mediaSourceId: string,
    ): Promise<ParsedCue[]> {
        const key = this.getCacheKey(itemId, subtitleIndex, mediaSourceId);

        // Layer 1: Check memory cache first (fastest)
        const cached = this.cache.get(key);
        if (cached) {
            const age = this.getAge(cached);
            if (age < this.TTL_MS) {
                this.stats.hits++;
                logger.debug('Memory cache hit', {
                    itemId,
                    subtitleIndex,
                    cueCount: cached.cues.length,
                    ageSeconds: Math.round(age / 1000),
                });
                return cached.cues;
            } else {
                // Expired
                this.cache.delete(key);
                this.stats.evictions++;
            }
        }

        this.stats.misses++;

        // Layer 2: Check file cache (persistent, survives restarts)
        const fileCached = await SubtitleFileCacheService.get(mediaSourceId, subtitleIndex);
        if (fileCached) {
            logger.debug('File cache hit', { mediaSourceId, subtitleIndex });

            // Parse and store in memory cache
            const { content: sanitized } = sanitizeWebVTT(fileCached, {
                enableLogging: false,
            });
            const parsed = parseWebVTT(sanitized);
            this.cacheResult(key, parsed.cues);

            return parsed.cues;
        }

        // Check if there's already a pending fetch for this subtitle
        // This prevents duplicate concurrent fetches
        const pendingFetch = this.pendingFetches.get(key);
        if (pendingFetch) {
            logger.debug('Joining pending subtitle fetch', {
                itemId,
                subtitleIndex,
            });
            return pendingFetch;
        }

        // Layer 3 & 4: Extract with FFmpeg or fetch from Jellyfin
        const fetchPromise = this.extractOrFetchSubtitle(itemId, subtitleIndex, mediaSourceId)
            .then((cues) => {
                // Only cache non-empty results (don't cache errors)
                if (cues.length > 0) {
                    this.cacheResult(key, cues);
                }
                return cues;
            })
            .catch((error) => {
                // Catch any unexpected errors to prevent process crash
                logger.error('Unexpected error in subtitle fetch', error, {
                    itemId,
                    subtitleIndex,
                    mediaSourceId,
                });
                // Return empty array on error
                return [];
            })
            .finally(() => {
                // Remove from pending when done
                this.pendingFetches.delete(key);
            });

        this.pendingFetches.set(key, fetchPromise);
        return fetchPromise;
    }

    /**
     * Extract subtitle using FFmpeg or fall back to Jellyfin API
     */
    private async extractOrFetchSubtitle(
        itemId: string,
        subtitleIndex: number,
        mediaSourceId: string,
    ): Promise<ParsedCue[]> {
        // Try FFmpeg extraction first
        try {
            const webvtt = await this.extractWithFFmpeg(itemId, subtitleIndex, mediaSourceId);

            if (webvtt) {
                // Parse the extracted WebVTT
                const { content: sanitized } = sanitizeWebVTT(webvtt, {
                    enableLogging: false,
                });
                const parsed = parseWebVTT(sanitized);

                // Cache to file for next time
                await SubtitleFileCacheService.set(mediaSourceId, subtitleIndex, webvtt).catch(
                    (err) => logger.warn('Failed to cache subtitle to file', err),
                );

                logger.info('FFmpeg extraction successful', {
                    itemId,
                    subtitleIndex,
                    cueCount: parsed.cues.length,
                });

                return parsed.cues;
            }
        } catch (error) {
            logger.warn('FFmpeg subtitle extraction failed', {
                itemId,
                subtitleIndex,
                error: (error as Error).message,
            });
        }

        return [];
    }

    /**
     * Extract subtitle directly from media file using FFmpeg
     */
    private async extractWithFFmpeg(
        itemId: string,
        subtitleIndex: number,
        mediaSourceId: string,
    ): Promise<string | null> {
        const lockKey = `${mediaSourceId}_${subtitleIndex}`;

        // Check if extraction is already in progress (semaphore lock)
        const existingLock = this.extractionLocks.get(lockKey);
        if (existingLock) {
            logger.debug('Waiting for ongoing extraction', {
                mediaSourceId,
                subtitleIndex,
            });
            await existingLock;

            // After lock releases, check file cache
            return await SubtitleFileCacheService.get(mediaSourceId, subtitleIndex);
        }

        // Create extraction lock
        const extractionPromise = (async () => {
            let subtitleCodec: string | undefined;

            try {
                // Get file path and stream info from Jellyfin
                const mediaInfo = await this.getMediaFileInfo(itemId, mediaSourceId);
                if (!mediaInfo) {
                    logger.debug('Cannot get media file info for FFmpeg extraction', {
                        itemId,
                        mediaSourceId,
                    });
                    return null;
                }

                const { filePath, streams } = mediaInfo;

                // Find the subtitle stream
                const subtitleStream = streams?.find(
                    (s) => s.Type === 'Subtitle' && s.Index === subtitleIndex,
                );

                if (!subtitleStream) {
                    logger.debug('Subtitle stream not found', {
                        itemId,
                        subtitleIndex,
                    });
                    return null;
                }

                if (subtitleStream.IsExternal) {
                    // Try local external_subtitle_files table first.
                    // subtitleIndex is Jellyfin's absolute all-stream index, so compute
                    // the subtitle-relative index among IsExternal subtitle streams only.
                    try {
                        const db = getDb();
                        if (db) {
                            const externalSubs = await getExternalSubtitlesByJellyfinId(db, itemId);

                            // Compute zero-based index among external subtitle streams
                            const externalSubtitleStreams =
                                streams?.filter((s) => s.Type === 'Subtitle' && s.IsExternal) ?? [];
                            const relativeIndex = externalSubtitleStreams.findIndex(
                                (s) => s.Index === subtitleIndex,
                            );
                            const localSub =
                                relativeIndex >= 0 ? externalSubs[relativeIndex] : undefined;

                            if (localSub) {
                                // subtitle_path is written exclusively by the file
                                // scanner from library paths — no user-controlled input
                                const resolvedPath = resolve(localSub.subtitle_path);

                                logger.debug('Serving external subtitle from local file', {
                                    itemId,
                                    subtitleIndex,
                                    format: localSub.format,
                                });

                                if (localSub.format === 'vtt') {
                                    return readSidecarText(resolvedPath);
                                }

                                if (
                                    localSub.format === 'srt' ||
                                    localSub.format === 'ass' ||
                                    localSub.format === 'ssa'
                                ) {
                                    // ffmpeg opens this path itself and would follow a
                                    // symlink planted at it: same containment as the reader.
                                    if (!(await resolveContainedFile(resolvedPath))) return null;
                                    const codec = localSub.format === 'srt' ? 'subrip' : 'ass';
                                    return extractSubtitleStream({
                                        filePath: resolvedPath,
                                        streamIndex: 0,
                                        codec,
                                        outputFormat: 'webvtt',
                                    });
                                }
                            }
                        }
                    } catch (err) {
                        // Oversize or refused (symlink out of the roots, FIFO): serve
                        // nothing, same as the resolver does.
                        if (
                            err instanceof SidecarTooLargeError ||
                            err instanceof ContainmentError
                        ) {
                            logger.warn('External subtitle refused', {
                                itemId,
                                subtitleIndex,
                                error: err.message,
                            });
                            return null;
                        }
                        logger.debug('Failed to serve external subtitle from local DB', {
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }

                    logger.debug('External subtitle not in local DB, falling through', {
                        itemId,
                        subtitleIndex,
                    });
                    return null;
                }

                // Check if subtitle is text-based (allowlist check)
                if (!isTextBasedSubtitle(subtitleStream.Codec)) {
                    logger.info('Subtitle codec is not text-based, cannot extract to WebVTT', {
                        codec: subtitleStream.Codec,
                        subtitleIndex,
                        itemId,
                    });
                    return null;
                }

                // Extract with FFmpeg
                subtitleCodec = subtitleStream.Codec;
                logger.info('Extracting subtitle with FFmpeg', {
                    filePath,
                    subtitleIndex,
                    codec: subtitleCodec,
                });

                const webvtt = await extractSubtitleStream({
                    filePath,
                    streamIndex: subtitleIndex,
                    codec: subtitleCodec,
                    outputFormat: 'webvtt',
                });

                return webvtt;
            } catch (error) {
                // Add context about which subtitle extraction failed
                logger.error(
                    `FFmpeg subtitle extraction failed for ${subtitleCodec?.toUpperCase() || 'unknown'} → WEBVTT`,
                    error as Error,
                    {
                        itemId,
                        mediaSourceId,
                        subtitleIndex,
                        sourceCodec: subtitleCodec || 'unknown',
                        targetFormat: 'webvtt',
                    },
                );
                throw error; // Re-throw to trigger fallback
            } finally {
                // Release lock
                this.extractionLocks.delete(lockKey);
            }
        })();

        this.extractionLocks.set(
            lockKey,
            extractionPromise.then(() => {}),
        );

        return extractionPromise;
    }

    /**
     * Get media file path and stream info from Jellyfin
     * Uses Jellyfin SDK BaseItemDto which has MediaStreams and Path
     */
    private async getMediaFileInfo(
        itemId: string,
        mediaSourceId: string,
    ): Promise<{ filePath: string; streams?: MediaStreamInfo[] } | null> {
        try {
            // Get default user for API call via cached resolver
            const { resolveJellyfinUserId } = await import('./jellyfin-user-id-resolver.js');
            const defaultUserId = await resolveJellyfinUserId(config.DEFAULT_USER);
            if (!defaultUserId) {
                logger.warn('No default user found for subtitle extraction');
                return null;
            }

            // Get item directly to access Path and MediaStreams
            // BaseItemDto from SDK has these properties
            const item = await jellyfinMediaService.getItemById(defaultUserId, itemId);
            if (!item) {
                return null;
            }

            // Path should be on the item (BaseItemDto)
            const typedItem = item as JellyfinItemWithPath;
            const filePath = typedItem.Path;
            if (!filePath) {
                logger.debug('Item has no file path', { itemId });
                return null;
            }

            // MediaStreams should be on the item (BaseItemDto)
            const streams = typedItem.MediaStreams || [];

            return {
                filePath,
                streams,
            };
        } catch (error) {
            logger.error('Failed to get media file info', error as Error, {
                itemId,
                mediaSourceId,
            });
            return null;
        }
    }

    /**
     * Cache parsed cues with LRU eviction.
     */
    private cacheResult(key: string, cues: ParsedCue[]): void {
        // LRU eviction if at capacity
        if (this.cache.size >= this.MAX_ENTRIES) {
            // Find oldest entry (largest age = oldest)
            let oldestKey: string | null = null;
            let oldestAge = -1; // Start with -1 so any positive age is larger

            for (const [k, v] of this.cache) {
                const age = this.getAge(v);
                if (age > oldestAge) {
                    oldestAge = age;
                    oldestKey = k;
                }
            }

            if (oldestKey) {
                this.cache.delete(oldestKey);
                this.stats.evictions++;
                logger.debug('LRU eviction', { evictedKey: oldestKey });
            }
        }

        this.cache.set(key, {
            cues,
            fetchedAt: Date.now(),
        });
    }

    /**
     * Invalidate cache for a specific subtitle.
     */
    invalidate(itemId: string, subtitleIndex: number, mediaSourceId: string): void {
        const key = this.getCacheKey(itemId, subtitleIndex, mediaSourceId);
        if (this.cache.delete(key)) {
            logger.debug('Cache invalidated', { itemId, subtitleIndex });
        }
    }

    /**
     * Invalidate all cache entries for an item.
     */
    invalidateItem(itemId: string): void {
        // Collect keys first to avoid modifying map while iterating
        const keysToDelete: string[] = [];
        const prefix = `${itemId}:`;

        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            this.cache.delete(key);
        }

        if (keysToDelete.length > 0) {
            logger.debug('Cache invalidated for item', {
                itemId,
                entriesRemoved: keysToDelete.length,
            });
        }
    }

    /**
     * Cleanup expired entries.
     */
    cleanup(): void {
        // Collect expired keys first to avoid modifying map while iterating
        const expiredKeys: string[] = [];

        for (const [key, value] of this.cache) {
            if (this.getAge(value) > this.TTL_MS) {
                expiredKeys.push(key);
            }
        }

        for (const key of expiredKeys) {
            this.cache.delete(key);
        }

        if (expiredKeys.length > 0) {
            this.stats.evictions += expiredKeys.length;
            logger.debug('Cache cleanup', {
                entriesRemoved: expiredKeys.length,
                remaining: this.cache.size,
            });
        }
    }

    /**
     * Get cache statistics (memory cache only).
     * Use getFileCacheStats() for file cache statistics.
     */
    getStats(): { cacheSize: number; stats: CacheStats } {
        return {
            cacheSize: this.cache.size,
            stats: { ...this.stats },
        };
    }

    /**
     * Get file cache statistics.
     */
    async getFileCacheStats() {
        const stats = await SubtitleFileCacheService.getStatistics();
        const hitMiss = SubtitleFileCacheService.getHitMissStats();

        return {
            ...stats,
            ...hitMiss,
        };
    }

    /**
     * Clear all cached entries (memory cache only).
     */
    clear(): void {
        const size = this.cache.size;
        this.cache.clear();
        logger.info('Memory cache cleared', { entriesRemoved: size });
    }

    /**
     * Clear file cache.
     */
    async clearFileCache(): Promise<number> {
        return await SubtitleFileCacheService.clear();
    }

    /**
     * Clean up stale file cache entries.
     */
    async cleanupFileCache(): Promise<number> {
        return await SubtitleFileCacheService.cleanup();
    }

    /**
     * Shutdown the service and stop all cleanup intervals.
     */
    shutdown(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        if (this.fileCleanupInterval) {
            clearInterval(this.fileCleanupInterval);
            this.fileCleanupInterval = null;
        }
        this.clear();
        logger.info('Subtitle cache service shut down');
    }
}

// Singleton instance
export const subtitleCacheService = new SubtitleCacheService();
