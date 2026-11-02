// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cache Statistics and Management Endpoint
 *
 * GET /api/cache-stats - View cache metrics and health
 * POST /api/cache-stats?action=clear - Clear specific caches (admin only)
 */

import {
    readBoundedBodyText,
    BODY_TOO_LARGE,
    DEFAULT_MAX_BODY_BYTES,
} from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import type { ExternalIds } from '$lib/types/api-common';
import { getExternalIdFor, createExternalIds } from '$lib/utils/external-ids';
import { typedJson } from '$lib/server/utils/typed-response.js';
import {
    CacheStatsResponseSchema,
    CacheClearResponseSchema,
    ClearFilesystemResponseSchema,
    ClearFileResponseSchema,
    CleanupFileResponseSchema,
} from '$lib/schemas/admin-types.js';
import {
    cacheManager,
    cacheInvalidation,
    getCacheWarmingService,
    validateNamespace,
    standaloneCacheRegistry,
} from '$lib/server/cache';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { requireAdmin } from '$lib/server/middleware/auth';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '$env/dynamic/private';
import { transcodingCacheTracker } from '$lib/server/services/transcoding-cache-tracker';
import { getPreviewCacheStore } from '$lib/server/services/preview-cache.store';
import { subtitleCacheService } from '$lib/server/services/subtitle-cache.service';
import { config as appConfig } from '$lib/server/config';
import { cleanupImageCaches, getLastCleanupSummary } from '$lib/server/utils/image-cache-cleanup';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import { getDb } from '$lib/server/database/connection.js';
import { getMediaExternalIds } from '$lib/server/database/queries/resolvers/media-id.resolver.js';
import { lookupLegacyJellyfinMediaId } from '$lib/server/utils/media-resolution.js';

const logger = Logger.for('CacheStatsEndpoint');
const ENDPOINT = '/api/cache-stats';

/**
 * In-process single-flight for the manual image-cache cleanup action.
 *
 * Cleanup walks every cache directory, stats every file, and unlinks
 * over-budget entries. Concurrent admin clicks would race those unlinks
 * (double-counted errors, last-write-wins persist summary). This map
 * collapses concurrent calls onto one underlying run; the in-flight
 * promise is held until the run settles.
 *
 * Single-replica scope is fine here: each replica has its own filesystem
 * cache, so cross-replica coordination buys nothing. Multi-replica
 * deployments could add a Valkey lock if cleanup ever does cross-cutting
 * work, but today it's strictly per-instance.
 */
let manualCleanupInFlight: Promise<unknown> | null = null;
const envConfig = env as {
    JELLYFIN_CACHE_DIR?: string;
    TMDB_CACHE_DIR?: string;
    USER_AVATAR_CACHE_DIR?: string;
};

type CacheActionBody = Record<string, unknown>;

// Filesystem cache directories configuration
interface FilesystemCacheConfig {
    name: string;
    path: string;
    description: string;
}

function getFilesystemCacheConfigs(): FilesystemCacheConfig[] {
    const projectRoot = process.cwd();
    return [
        {
            name: 'jellyfin',
            path: envConfig.JELLYFIN_CACHE_DIR || path.join(projectRoot, '.cache', 'jellyfin'),
            description: 'Jellyfin images (posters, backdrops, logos)',
        },
        {
            name: 'tmdb',
            path: envConfig.TMDB_CACHE_DIR || path.join(projectRoot, '.cache', 'tmdb'),
            description: 'TMDB images (posters, backdrops, logos)',
        },
        {
            name: 'tmdb-persons',
            path: envConfig.TMDB_CACHE_DIR
                ? path.join(envConfig.TMDB_CACHE_DIR, 'persons')
                : path.join(projectRoot, '.cache', 'tmdb-persons'),
            description: 'TMDB person/actor photos',
        },
        {
            name: 'user-avatars',
            path:
                envConfig.USER_AVATAR_CACHE_DIR || path.join(projectRoot, '.cache', 'user-avatars'),
            description: 'User avatar images',
        },
        // Previously missing from the admin UI — operators couldn't see disk
        // pressure from these caches even though they're real and
        // size-budget-evictable. Added in the cache-architecture refresh.
        {
            name: 'custom-url',
            path: path.join(projectRoot, '.cache', 'custom-url'),
            description: 'External URL fetches (LiveTV channel logos, music radio art)',
        },
        {
            name: 'audiobook',
            path: path.join(projectRoot, '.cache', 'audiobook'),
            description: 'Audiobookshelf cover art',
        },
        {
            name: 'arr-images',
            path: path.join(projectRoot, '.cache', 'arr-images'),
            description: 'Sonarr / Radarr poster proxy cache',
        },
        {
            name: 'kavita',
            path: path.join(projectRoot, '.cache', 'kavita'),
            description: 'Kavita comic / manga cover cache',
        },
        {
            name: 'local-artwork',
            path: path.join(projectRoot, '.cache', 'local-artwork'),
            description: 'Encoded output of admin-uploaded artwork (mtime-keyed)',
        },
    ];
}

interface FormatBreakdown {
    webp: number;
    avif: number;
    jpg: number;
    png: number;
    other: number;
}

interface FilesystemCacheStats {
    name: string;
    path: string;
    description: string;
    exists: boolean;
    fileCount: number;
    totalSizeBytes: number;
    totalSizeFormatted: string;
    oldestFile?: string;
    newestFile?: string;
    formatBreakdown?: FormatBreakdown;
}

/** Classify a filename into one of the format-breakdown buckets. Cache key
 * filenames end in `.webp` / `.avif` / `.jpg` / `.png` etc. — no need to
 * sniff bytes, the writer side controls the extension. */
function bucketForFile(name: string): keyof FormatBreakdown {
    const ext = path.extname(name).toLowerCase();
    if (ext === '.webp') return 'webp';
    if (ext === '.avif') return 'avif';
    if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
    if (ext === '.png') return 'png';
    return 'other';
}

async function getFilesystemCacheStats(): Promise<FilesystemCacheStats[]> {
    const configs = getFilesystemCacheConfigs();
    const stats: FilesystemCacheStats[] = [];

    for (const config of configs) {
        try {
            const dirStats = await fs.stat(config.path);
            if (!dirStats.isDirectory()) {
                stats.push({
                    ...config,
                    exists: false,
                    fileCount: 0,
                    totalSizeBytes: 0,
                    totalSizeFormatted: '0 B',
                });
                continue;
            }

            const files = await fs.readdir(config.path);
            let totalSize = 0;
            let actualFileCount = 0;
            let oldestTime = Infinity;
            let newestTime = 0;
            const formatBreakdown: FormatBreakdown = {
                webp: 0,
                avif: 0,
                jpg: 0,
                png: 0,
                other: 0,
            };

            for (const file of files) {
                const filePath = path.join(config.path, file);
                try {
                    const fileStat = await fs.stat(filePath);
                    if (fileStat.isFile()) {
                        actualFileCount++;
                        totalSize += fileStat.size;
                        formatBreakdown[bucketForFile(file)]++;
                        if (fileStat.mtimeMs < oldestTime) {
                            oldestTime = fileStat.mtimeMs;
                        }
                        if (fileStat.mtimeMs > newestTime) {
                            newestTime = fileStat.mtimeMs;
                        }
                    }
                } catch (err) {
                    logger.debug('Skipping file we cannot stat', {
                        filePath,
                        err,
                    });
                }
            }

            stats.push({
                ...config,
                exists: true,
                // Use actualFileCount (only regular files) rather than
                // files.length which includes subdirectories.
                fileCount: actualFileCount,
                totalSizeBytes: totalSize,
                totalSizeFormatted: formatBytes(totalSize),
                oldestFile: oldestTime < Infinity ? new Date(oldestTime).toISOString() : undefined,
                newestFile: newestTime > 0 ? new Date(newestTime).toISOString() : undefined,
                formatBreakdown,
            });
        } catch (err) {
            logger.debug('Cache directory does not exist or cannot be read', {
                config,
                err,
            });
            stats.push({
                ...config,
                exists: false,
                fileCount: 0,
                totalSizeBytes: 0,
                totalSizeFormatted: '0 B',
            });
        }
    }

    return stats;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

async function clearFilesystemCache(
    cacheName: string,
): Promise<{ deletedFiles: number; freedBytes: number }> {
    const configs = getFilesystemCacheConfigs();
    const config = configs.find((c) => c.name === cacheName);

    if (!config) {
        logger.warn('Unknown filesystem cache requested', { cacheName });
        return { deletedFiles: 0, freedBytes: 0 };
    }

    try {
        const files = await fs.readdir(config.path);
        let deletedFiles = 0;
        let freedBytes = 0;

        for (const file of files) {
            const filePath = path.join(config.path, file);
            try {
                const fileStat = await fs.stat(filePath);
                if (fileStat.isFile()) {
                    freedBytes += fileStat.size;
                    await fs.unlink(filePath);
                    deletedFiles++;
                }
            } catch (err) {
                logger.debug('Skipping file we cannot delete', {
                    filePath,
                    err,
                });
            }
        }

        logger.info('Filesystem cache cleared', {
            cacheName,
            deletedFiles,
            freedBytes: formatBytes(freedBytes),
        });
        return { deletedFiles, freedBytes };
    } catch (error) {
        logger.error('Failed to clear filesystem cache', error as Error, {
            cacheName,
        });
        return { deletedFiles: 0, freedBytes: 0 };
    }
}

async function clearAllFilesystemCaches(): Promise<{
    totalDeletedFiles: number;
    totalFreedBytes: number;
}> {
    const configs = getFilesystemCacheConfigs();
    let totalDeletedFiles = 0;
    let totalFreedBytes = 0;

    for (const config of configs) {
        try {
            const result = await clearFilesystemCache(config.name);
            totalDeletedFiles += result.deletedFiles;
            totalFreedBytes += result.freedBytes;
        } catch (err) {
            logger.warn('Failed to clear filesystem cache, continuing', {
                name: config.name,
                err,
            });
        }
    }

    return { totalDeletedFiles, totalFreedBytes };
}

/**
 * Get comprehensive cache statistics
 */
export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        // Get metrics from all cache namespaces
        const allMetrics = cacheManager.getAllMetrics();

        // Get invalidation stats
        const invalidationStats = cacheInvalidation.getInvalidationStats();
        const recentInvalidations = cacheInvalidation.getInvalidationLog(20);

        // Calculate aggregate stats
        const aggregateStats = Object.entries(allMetrics).reduce(
            (acc, [_namespace, metrics]) => {
                acc.totalL1Hits += metrics.l1Stats.hits;
                acc.totalL1Misses += metrics.l1Stats.misses;
                acc.totalL2Hits += metrics.l2Hits;
                acc.totalL2Misses += metrics.l2Misses;
                acc.totalL2Errors += metrics.l2Errors;
                acc.totalSize += metrics.l1Stats.size;
                acc.totalInvalidations += metrics.invalidations;
                return acc;
            },
            {
                totalL1Hits: 0,
                totalL1Misses: 0,
                totalL2Hits: 0,
                totalL2Misses: 0,
                totalL2Errors: 0,
                totalSize: 0,
                totalInvalidations: 0,
            },
        );

        const totalL1Requests = aggregateStats.totalL1Hits + aggregateStats.totalL1Misses;
        const totalL2Requests = aggregateStats.totalL2Hits + aggregateStats.totalL2Misses;

        // Combined hit rate: L2 only receives requests that missed L1,
        // so total unique requests = totalL1Requests (L2 is a subset of L1 misses)
        // Combined hits = L1 hits + L2 hits (cache hierarchy)
        const overallHitRate = {
            l1: totalL1Requests > 0 ? aggregateStats.totalL1Hits / totalL1Requests : 0,
            l2: totalL2Requests > 0 ? aggregateStats.totalL2Hits / totalL2Requests : 0,
            combined:
                totalL1Requests > 0
                    ? (aggregateStats.totalL1Hits + aggregateStats.totalL2Hits) / totalL1Requests
                    : 0,
        };

        // Check health of cache layers
        const healthStatus = {
            l1: true, // L1 is always available (in-memory)
            l2: aggregateStats.totalL2Errors === 0 || aggregateStats.totalL2Errors < 10,
            overall: aggregateStats.totalL2Errors === 0 || aggregateStats.totalL2Errors < 10,
        };

        // Get cache warming progress
        const warmingService = getCacheWarmingService();
        const warmingProgress = warmingService.getProgress();
        const warmingPercentComplete =
            warmingProgress.tasksTotal > 0
                ? Math.round((warmingProgress.tasksCompleted / warmingProgress.tasksTotal) * 100)
                : 0;

        // Get filesystem cache stats
        const filesystemCaches = await getFilesystemCacheStats();
        const filesystemTotalBytes = filesystemCaches.reduce((acc, c) => acc + c.totalSizeBytes, 0);
        const filesystemTotalFiles = filesystemCaches.reduce((acc, c) => acc + c.fileCount, 0);

        // Tier 1: budget snapshot. percentUsed clamps at 100 so a UI gauge
        // never shows >100%. budgetBytes=0 means "unlimited" (operator
        // disabled enforcement); we report withinBudget=true and
        // percentUsed=0 in that case.
        const maxBytes = appConfig.IMAGE_CACHE_MAX_BYTES;
        const budget = {
            budgetBytes: maxBytes,
            usedBytes: filesystemTotalBytes,
            usedFormatted: formatBytes(filesystemTotalBytes),
            budgetFormatted: maxBytes > 0 ? formatBytes(maxBytes) : 'unlimited',
            percentUsed:
                maxBytes > 0
                    ? Math.min(100, Math.round((filesystemTotalBytes / maxBytes) * 100))
                    : 0,
            withinBudget: maxBytes <= 0 || filesystemTotalBytes <= maxBytes,
        };

        // Tier 2: read the persisted summary of the last cleanup run, if any.
        const lastCleanup = await getLastCleanupSummary();

        // Tier 3: surface the active image-format settings so operators can
        // confirm at a glance that AVIF is on / which pre-gen mode is active.
        const imageFormats = {
            webpEnabled: appConfig.IMAGE_WEBP_ENABLED,
            avifEnabled: appConfig.IMAGE_AVIF_ENABLED,
            avifPregenMode: appConfig.IMAGE_AVIF_PREGEN_MODE,
        };

        // Get standalone LRU cache stats
        const standaloneCaches = standaloneCacheRegistry.getAllStats();
        const standaloneAggregate = standaloneCacheRegistry.getAggregateStats();

        // Get transcoding cache stats (HLS segments for multi-audio transcoding)
        const transcodingStats = await transcodingCacheTracker.getStats();

        // Get preview artifact cache stats (content-addressed hover/scrub previews).
        // In-memory snapshot — cheap, no fs walk. The store is always constructed,
        // so when PREVIEW_CACHE_ENABLED is off it simply reports an empty/dormant
        // cache (enabled=false) rather than being hidden entirely.
        const previewRaw = getPreviewCacheStore().stats();
        const previewRequests = previewRaw.hits + previewRaw.misses;
        const previewCache = {
            enabled: appConfig.PREVIEW_CACHE_ENABLED,
            entries: previewRaw.entries,
            ready: previewRaw.ready,
            warming: previewRaw.warming,
            totalBytes: previewRaw.totalBytes,
            totalBytesFormatted: formatBytes(previewRaw.totalBytes),
            maxBytes: previewRaw.maxBytes,
            maxBytesFormatted:
                previewRaw.maxBytes > 0 ? formatBytes(previewRaw.maxBytes) : 'unlimited',
            percentUsed:
                previewRaw.maxBytes > 0
                    ? Math.min(100, Math.round((previewRaw.totalBytes / previewRaw.maxBytes) * 100))
                    : 0,
            hits: previewRaw.hits,
            misses: previewRaw.misses,
            hitRate: previewRequests > 0 ? previewRaw.hits / previewRequests : 0,
            evictions: previewRaw.evictions,
        };

        // Get subtitle cache stats (memory + file cache)
        const subtitleMemoryStats = subtitleCacheService.getStats();
        const subtitleFileStats = await subtitleCacheService.getFileCacheStats();

        return typedJson(CacheStatsResponseSchema, {
            timestamp: new Date().toISOString(),
            health: healthStatus,
            aggregate: {
                ...aggregateStats,
                hitRate: overallHitRate,
            },
            namespaces: allMetrics,
            invalidations: {
                stats: invalidationStats,
                recent: recentInvalidations,
            },
            warming: {
                ...warmingProgress,
                percentComplete: warmingPercentComplete,
                isRunning: warmingProgress.status === 'warming',
            },
            filesystem: {
                caches: filesystemCaches,
                totalSizeFormatted: formatBytes(filesystemTotalBytes),
                totalFileCount: filesystemTotalFiles,
                budget,
                lastCleanup,
                imageFormats,
            },
            standalone: {
                caches: standaloneCaches,
                aggregate: standaloneAggregate,
            },
            transcoding: transcodingStats,
            previewCache,
            subtitles: {
                memory: subtitleMemoryStats,
                file: {
                    ...subtitleFileStats,
                    totalSizeFormatted: formatBytes(subtitleFileStats.totalSizeBytes),
                },
            },
        });
    }),
);

/**
 * Cache management actions
 */
export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async ({ url, locals, request }) => {
        const action = url.searchParams.get('action');
        let body: CacheActionBody = {};
        const rawBody = await readBoundedBodyText(request, DEFAULT_MAX_BODY_BYTES);
        if (rawBody === BODY_TOO_LARGE) return ApiResponses.payloadTooLarge();
        if (rawBody) {
            try {
                body = JSON.parse(rawBody) as CacheActionBody;
            } catch (err) {
                logger.warn('Malformed JSON in cache action request body', {
                    err,
                });
                return ApiResponses.badRequest('Invalid JSON in request body');
            }
        }

        switch (action) {
            case 'clear': {
                const result = await handleClearCache(body);
                if (result instanceof Response) return result;
                return typedJson(CacheClearResponseSchema, {
                    message: 'Cache cleared successfully',
                });
            }

            case 'invalidate-user': {
                const result = await handleInvalidateUser(body);
                if (result instanceof Response) return result;
                return typedJson(CacheClearResponseSchema, {
                    message: 'User cache invalidated',
                });
            }

            case 'invalidate-media': {
                const result = await handleInvalidateMedia(body);
                if (result instanceof Response) return result;
                return typedJson(CacheClearResponseSchema, {
                    message: 'Media cache invalidated',
                });
            }

            case 'clear-all':
                await cacheInvalidation.clearAllCaches();
                logger.warn('All caches cleared by admin', {
                    admin: locals.user?.username,
                });
                return typedJson(CacheClearResponseSchema, {
                    message: 'All caches cleared',
                });

            case 'clear-filesystem': {
                const result = await handleClearFilesystemCache(body, locals.user?.username);
                if (result instanceof Response) return result;
                return typedJson(CacheClearResponseSchema, {
                    message: 'Filesystem cache cleared successfully',
                });
            }

            case 'clear-all-filesystem': {
                const fsResult = await clearAllFilesystemCaches();
                logger.warn('All filesystem caches cleared by admin', {
                    admin: locals.user?.username,
                    ...fsResult,
                });
                return typedJson(ClearFilesystemResponseSchema, {
                    message: 'All filesystem caches cleared',
                    deletedFiles: fsResult.totalDeletedFiles,
                    freedBytes: fsResult.totalFreedBytes,
                    freedFormatted: formatBytes(fsResult.totalFreedBytes),
                });
            }

            case 'clear-standalone': {
                const result = await handleClearStandaloneCache(body, locals.user?.username);
                if (result instanceof Response) return result;
                return typedJson(CacheClearResponseSchema, {
                    message: 'Standalone cache cleared successfully',
                });
            }

            case 'clear-all-standalone':
                standaloneCacheRegistry.clearAll();
                logger.warn('All standalone caches cleared by admin', {
                    admin: locals.user?.username,
                });
                return typedJson(CacheClearResponseSchema, {
                    message: 'All standalone caches cleared',
                });

            case 'clear-subtitle-memory':
                subtitleCacheService.clear();
                logger.warn('Subtitle memory cache cleared by admin', {
                    admin: locals.user?.username,
                });
                return typedJson(CacheClearResponseSchema, {
                    message: 'Subtitle memory cache cleared',
                });

            case 'clear-subtitle-file': {
                const deletedCount = await subtitleCacheService.clearFileCache();
                logger.warn('Subtitle file cache cleared by admin', {
                    admin: locals.user?.username,
                    deletedCount,
                });
                return typedJson(ClearFileResponseSchema, {
                    message: 'Subtitle file cache cleared',
                    deletedCount,
                });
            }

            case 'cleanup-subtitle-file': {
                const deletedCount = await subtitleCacheService.cleanupFileCache();
                logger.info('Subtitle file cache cleanup completed', {
                    admin: locals.user?.username,
                    deletedCount,
                });
                return typedJson(CleanupFileResponseSchema, {
                    message: 'Subtitle file cache cleanup completed',
                    deletedCount,
                });
            }

            case 'cleanup-image-cache': {
                // Manual trigger for the same TTL + size-budget pass that
                // runs on startup. Awaited so the response carries the
                // freshest summary; cleanupImageCaches persists it to
                // Valkey, so the next stats poll sees the updated panel.
                //
                // Single-flight guard: an admin spam-clicking "Run cleanup"
                // would otherwise queue concurrent filesystem walks that
                // race each other's unlinks. Reuse the in-flight promise.
                if (!manualCleanupInFlight) {
                    manualCleanupInFlight = cleanupImageCaches().finally(() => {
                        manualCleanupInFlight = null;
                    });
                } else {
                    logger.debug('Image cache cleanup already in flight; reusing existing run', {
                        admin: locals.user?.username,
                    });
                }
                const result = (await manualCleanupInFlight) as Awaited<
                    ReturnType<typeof cleanupImageCaches>
                >;
                logger.info('Image cache cleanup triggered manually by admin', {
                    admin: locals.user?.username,
                    ttlDeleted: result.totalDeleted,
                    budgetDeleted: result.budgetDeletedFiles,
                    finalSize: result.finalSizeBytes,
                });
                return typedJson(CacheClearResponseSchema, {
                    message: `Image cache cleanup ran: ${result.totalDeleted} expired + ${result.budgetDeletedFiles} over-budget files deleted, ${formatBytes(result.totalBytes + result.budgetDeletedBytes)} freed, final size ${formatBytes(result.finalSizeBytes)}`,
                });
            }

            default:
                return ApiResponses.badRequest(
                    'Invalid action. Use: clear, invalidate-user, invalidate-media, clear-all, clear-filesystem, clear-all-filesystem, clear-standalone, clear-all-standalone, clear-subtitle-memory, clear-subtitle-file, cleanup-subtitle-file, cleanup-image-cache',
                    ENDPOINT,
                );
        }
    }),
);

/**
 * Handle cache clear for specific namespace
 * Validates namespace against registry to prevent creating unregistered caches
 */
async function handleClearCache(body: CacheActionBody): Promise<Response | void> {
    const namespace = typeof body.namespace === 'string' ? body.namespace : null;

    if (!namespace) {
        return ApiResponses.badRequest('namespace is required', ENDPOINT);
    }

    // Validate namespace exists in registry before accessing
    // This prevents creating unregistered caches via admin API
    try {
        validateNamespace(namespace);
    } catch (error) {
        return ApiResponses.badRequest(
            error instanceof Error ? error.message : 'Invalid namespace',
            ENDPOINT,
        );
    }

    const cache = cacheManager.getCache(namespace);
    await cache.clear();

    logger.info('Cache namespace cleared', { namespace });
}

/**
 * Handle user cache invalidation
 */
async function handleInvalidateUser(body: CacheActionBody): Promise<Response | void> {
    const userId = typeof body.userId === 'string' ? body.userId : null;

    if (!userId) {
        return ApiResponses.badRequest('userId is required', ENDPOINT);
    }

    await cacheInvalidation.invalidateUserRecommendations(userId, 'manual');

    logger.info('User cache invalidated', { userId });
}

/**
 * Handle media cache invalidation
 * Requires mediaType to avoid provider ID collisions (same ID can be movie AND tv)
 * Accepts externalIds format: { externalIds: { tmdb: "550" }, mediaType: "movie" }
 */
async function handleInvalidateMedia(body: CacheActionBody): Promise<Response | void> {
    if (!body.externalIds || typeof body.externalIds !== 'object') {
        return ApiResponses.badRequest(
            'externalIds is required. Use format: { externalIds: { tmdb: "550" }, mediaType: "movie" }',
            ENDPOINT,
        );
    }

    const rawIds = body.externalIds as Record<string, unknown>;

    // Build externalIds using helper to avoid direct property access
    let externalIds: ExternalIds = createExternalIds({
        tmdb:
            typeof rawIds.tmdb === 'string' || typeof rawIds.tmdb === 'number'
                ? rawIds.tmdb
                : undefined,
        imdb: typeof rawIds.imdb === 'string' ? rawIds.imdb : undefined,
        tvdb:
            typeof rawIds.tvdb === 'string' || typeof rawIds.tvdb === 'number'
                ? rawIds.tvdb
                : undefined,
        trakt:
            typeof rawIds.trakt === 'string' || typeof rawIds.trakt === 'number'
                ? rawIds.trakt
                : undefined,
        mal:
            typeof rawIds.mal === 'string' || typeof rawIds.mal === 'number'
                ? rawIds.mal
                : undefined,
    });

    const mediaType = body.mediaType;

    // An older admin client may name the item only by its Jellyfin item id:
    // map it (lookup only) to the item's own provider ids.
    if (typeof rawIds.jellyfin === 'string' && Object.keys(externalIds).length === 0) {
        externalIds = await externalIdsForLegacyJellyfinId(rawIds.jellyfin);
    }

    if (
        !getExternalIdFor(externalIds, 'tmdb') &&
        !getExternalIdFor(externalIds, 'imdb') &&
        !getExternalIdFor(externalIds, 'tvdb') &&
        !getExternalIdFor(externalIds, 'trakt') &&
        !getExternalIdFor(externalIds, 'mal')
    ) {
        return ApiResponses.badRequest(
            'externalIds must contain at least one valid provider ID',
            ENDPOINT,
        );
    }
    const mediaTypeStr = typeof mediaType === 'string' ? mediaType : undefined;
    if (!mediaTypeStr || (!isMovie(mediaTypeStr) && !isSeries(mediaTypeStr))) {
        return ApiResponses.badRequest(
            'mediaType is required and must be "movie" or "tv"',
            ENDPOINT,
        );
    }

    // Normalise: the isMovie/isSeries guard accepts 'series' too, so a bare
    // cast would carry 'series' through wearing the 'tv' type.
    await cacheInvalidation.invalidateMedia(externalIds, isMovie(mediaTypeStr) ? 'movie' : 'tv');

    logger.info('Media cache invalidated', { externalIds, mediaType });
}

/**
 * Provider ids (never `jellyfin`) of the active item a legacy Jellyfin item id
 * maps to, or an empty dict when it maps to nothing.
 */
async function externalIdsForLegacyJellyfinId(jellyfinId: string): Promise<ExternalIds> {
    const sql = getDb();
    if (!sql) return {};
    const mediaId = await lookupLegacyJellyfinMediaId(sql, jellyfinId);
    if (!mediaId) return {};
    const info = await getMediaExternalIds(sql, mediaId);
    if (!info) return {};
    const ids = info.externalIds;
    return createExternalIds({
        internal: mediaId,
        tmdb: ids.tmdb,
        imdb: ids.imdb,
        tvdb: ids.tvdb,
        trakt: ids.trakt,
        mal: ids.mal,
    });
}

/**
 * Handle filesystem cache clear
 */
async function handleClearFilesystemCache(
    body: CacheActionBody,
    adminUsername?: string,
): Promise<Response | void> {
    const cacheName = typeof body.cacheName === 'string' ? body.cacheName : null;

    if (!cacheName) {
        return ApiResponses.badRequest('cacheName is required', ENDPOINT);
    }

    try {
        const result = await clearFilesystemCache(cacheName);
        logger.warn('Filesystem cache cleared by admin', {
            admin: adminUsername,
            cacheName,
            ...result,
            freedFormatted: formatBytes(result.freedBytes),
        });
    } catch (error) {
        return ApiResponses.error(
            `Failed to clear filesystem cache: ${cacheName}`,
            error as Error,
            500,
        );
    }
}

/**
 * Handle standalone LRU cache clear
 */
async function handleClearStandaloneCache(
    body: CacheActionBody,
    adminUsername?: string,
): Promise<Response | void> {
    const cacheName = typeof body.cacheName === 'string' ? body.cacheName : null;

    if (!cacheName) {
        return ApiResponses.badRequest('cacheName is required', ENDPOINT);
    }

    if (!standaloneCacheRegistry.has(cacheName)) {
        return ApiResponses.badRequest(`Unknown standalone cache: ${cacheName}`, ENDPOINT);
    }

    standaloneCacheRegistry.clear(cacheName);
    logger.warn('Standalone cache cleared by admin', {
        admin: adminUsername,
        cacheName,
    });
}
