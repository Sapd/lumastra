// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Cache Cleanup Utility
 *
 * Scans all image cache directories and removes files older than the configured retention period.
 * Can be run on startup or manually via script.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('ImageCacheCleanup');

const CLEANUP_STATE_KEY = 'last';

/**
 * Persisted summary of the last cleanup run. Stored under the
 * `imageCacheCleanupState` namespace so the admin UI can render
 * "Last cleanup: 2 hours ago, freed 240 MB" without re-walking disk.
 */
export interface LastCleanupSummary {
    finishedAt: string;
    durationMs: number;
    ttlDeletedFiles: number;
    ttlFreedBytes: number;
    budgetDeletedFiles: number;
    budgetDeletedBytes: number;
    finalSizeBytes: number;
    success: boolean;
}

async function persistCleanupResult(result: CleanupResult): Promise<void> {
    try {
        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');
        const cache = cacheManager.for(CACHE_NAMESPACES.imageCacheCleanupState);
        const summary: LastCleanupSummary = {
            finishedAt: new Date().toISOString(),
            durationMs: result.duration,
            ttlDeletedFiles: result.totalDeleted,
            ttlFreedBytes: result.totalBytes,
            budgetDeletedFiles: result.budgetDeletedFiles,
            budgetDeletedBytes: result.budgetDeletedBytes,
            finalSizeBytes: result.finalSizeBytes,
            success: result.success,
        };
        await cache.set(CLEANUP_STATE_KEY, summary);
    } catch (err) {
        // Persistence is observability — never block cleanup on a Valkey
        // hiccup. Log and move on.
        logger.warn('Failed to persist cleanup summary', {
            error: (err as Error).message,
        });
    }
}

/**
 * Read the most recent cleanup summary, or null if cleanup has never run
 * (or the cache entry has expired / Valkey is unavailable).
 */
export async function getLastCleanupSummary(): Promise<LastCleanupSummary | null> {
    try {
        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');
        const cache = cacheManager.for(CACHE_NAMESPACES.imageCacheCleanupState);
        const summary = await cache.get<LastCleanupSummary>(CLEANUP_STATE_KEY);
        return summary ?? null;
    } catch (err) {
        logger.warn('Failed to read cleanup summary', {
            error: (err as Error).message,
        });
        return null;
    }
}

// Get cache directory from env or default
function getCacheDir(envVar: string | undefined, defaultPath: string): string {
    return envVar || path.join(process.cwd(), '.cache', defaultPath);
}

// All image cache directories
function getImageCacheDirs(): { name: string; path: string }[] {
    // Access env dynamically to support both SvelteKit and standalone scripts
    const env = process.env;

    return [
        {
            name: 'jellyfin',
            path: getCacheDir(env.JELLYFIN_CACHE_DIR, 'jellyfin'),
        },
        {
            name: 'tmdb',
            path: getCacheDir(env.TMDB_CACHE_DIR, 'tmdb'),
        },
        {
            name: 'tmdb-persons',
            path: env.TMDB_CACHE_DIR
                ? path.join(env.TMDB_CACHE_DIR, 'persons')
                : path.join(process.cwd(), '.cache', 'tmdb-persons'),
        },
        {
            name: 'user-avatars',
            path: getCacheDir(env.USER_AVATAR_CACHE_DIR, 'user-avatars'),
        },
        {
            name: 'custom-url',
            path: getCacheDir(undefined, 'custom-url'),
        },
        {
            name: 'audiobook',
            path: getCacheDir(undefined, 'audiobook'),
        },
        {
            name: 'arr-images',
            path: getCacheDir(undefined, 'arr-images'),
        },
        {
            // The admin UI surfaces this dir but cleanupImageCaches used to
            // skip it — files never aged out and never counted against the
            // size budget. Code-reviewer caught the divergence.
            name: 'kavita',
            path: getCacheDir(undefined, 'kavita'),
        },
        {
            // Encoded output of tryLocalArtwork — keyed by source-file
            // mtime so admin re-uploads naturally invalidate. Old entries
            // age out via TTL or budget pass.
            name: 'local-artwork',
            path: getCacheDir(undefined, 'local-artwork'),
        },
        {
            // Catalog images resized to a client's box (box-resize.ts, the
            // /j image route's fillWidth/maxHeight/… parameters).
            name: 'image-box',
            path: getCacheDir(undefined, 'image-box'),
        },
    ];
}

interface CleanupStats {
    totalFiles: number;
    deletedFiles: number;
    deletedBytes: number;
    errors: number;
}

interface CleanupResult {
    success: boolean;
    totalDeleted: number;
    totalBytes: number;
    byDirectory: Record<string, CleanupStats>;
    duration: number;
    /** Files deleted by the size-budget pass (after TTL cleanup). */
    budgetDeletedFiles: number;
    /** Bytes freed by the size-budget pass. */
    budgetDeletedBytes: number;
    /** Total cache size after all cleanup passes (bytes). */
    finalSizeBytes: number;
}

/**
 * Clean up a single cache directory
 */
async function cleanupDirectory(dirPath: string, maxAgeMs: number): Promise<CleanupStats> {
    const stats: CleanupStats = {
        totalFiles: 0,
        deletedFiles: 0,
        deletedBytes: 0,
        errors: 0,
    };

    try {
        // Check if directory exists
        await fs.access(dirPath);
    } catch {
        // Directory doesn't exist, nothing to clean
        return stats;
    }

    const now = Date.now();

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isFile()) continue;

            stats.totalFiles++;
            const filePath = path.join(dirPath, entry.name);

            try {
                const fileStat = await fs.stat(filePath);
                const age = now - fileStat.mtimeMs;

                if (age > maxAgeMs) {
                    await fs.unlink(filePath);
                    stats.deletedFiles++;
                    stats.deletedBytes += fileStat.size;
                }
            } catch (err) {
                stats.errors++;
                logger.debug('Failed to process cache file', {
                    filePath,
                    error: (err as Error).message,
                });
            }
        }
    } catch (err) {
        logger.error('Failed to read cache directory', err as Error, {
            dirPath,
        });
        stats.errors++;
    }

    return stats;
}

/**
 * Enforce a global byte budget across all cache directories.
 *
 * Runs after the TTL pass, so it only acts on files that survived TTL but
 * still push the cache over the configured limit. Sorts surviving files by
 * mtime ascending and deletes oldest first until under budget. mtime is a
 * pragmatic LRU-ish proxy: most filesystems use `relatime` which doesn't
 * update atime on every read, so true LRU isn't free; mtime gives FIFO with
 * occasional refresh-on-rewrite, which is good enough.
 */
async function enforceSizeBudget(
    cacheDirs: { name: string; path: string }[],
    maxBytes: number,
): Promise<{
    deletedFiles: number;
    deletedBytes: number;
    finalSizeBytes: number;
    errors: number;
}> {
    interface FileEntry {
        path: string;
        size: number;
        mtimeMs: number;
    }

    const all: FileEntry[] = [];
    let totalBytes = 0;
    let errors = 0;

    for (const { path: dirPath } of cacheDirs) {
        try {
            await fs.access(dirPath);
        } catch {
            continue;
        }

        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                // Skip dotfiles and in-flight write targets — deleting a
                // partially written file would corrupt the cache; skipping
                // also avoids racing the cache writer.
                if (
                    entry.name.startsWith('.') ||
                    entry.name.endsWith('.tmp') ||
                    entry.name.endsWith('.partial')
                ) {
                    continue;
                }
                const filePath = path.join(dirPath, entry.name);
                try {
                    const stat = await fs.stat(filePath);
                    all.push({
                        path: filePath,
                        size: stat.size,
                        mtimeMs: stat.mtimeMs,
                    });
                    totalBytes += stat.size;
                } catch {
                    // best-effort: a single unstattable file is counted in `errors`, scan continues.
                    errors++;
                }
            }
        } catch (err) {
            logger.warn('Failed to scan cache directory for size budget', {
                dirPath,
                error: (err as Error).message,
            });
            errors++;
        }
    }

    if (totalBytes <= maxBytes) {
        return {
            deletedFiles: 0,
            deletedBytes: 0,
            finalSizeBytes: totalBytes,
            errors,
        };
    }

    // Sort by mtime ascending (oldest first), delete until under budget.
    all.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let deletedFiles = 0;
    let deletedBytes = 0;
    for (const entry of all) {
        if (totalBytes <= maxBytes) break;
        try {
            await fs.unlink(entry.path);
            deletedFiles++;
            deletedBytes += entry.size;
            totalBytes -= entry.size;
        } catch (err) {
            errors++;
            logger.debug('Failed to delete cache file under budget pressure', {
                path: entry.path,
                error: (err as Error).message,
            });
        }
    }

    return {
        deletedFiles,
        deletedBytes,
        finalSizeBytes: totalBytes,
        errors,
    };
}

/**
 * Run cache cleanup on all image cache directories
 */
export async function cleanupImageCaches(retentionDays?: number): Promise<CleanupResult> {
    const startTime = Date.now();
    const days = retentionDays ?? config.IMAGE_CACHE_RETENTION_DAYS;
    const maxAgeMs = days * 24 * 60 * 60 * 1000;
    const maxBytes = config.IMAGE_CACHE_MAX_BYTES;

    logger.info('Starting image cache cleanup', {
        retentionDays: days,
        maxBytes: maxBytes > 0 ? formatBytes(maxBytes) : 'unlimited',
    });

    const result: CleanupResult = {
        success: true,
        totalDeleted: 0,
        totalBytes: 0,
        byDirectory: {},
        duration: 0,
        budgetDeletedFiles: 0,
        budgetDeletedBytes: 0,
        finalSizeBytes: 0,
    };

    const cacheDirs = getImageCacheDirs();

    for (const { name, path: dirPath } of cacheDirs) {
        const stats = await cleanupDirectory(dirPath, maxAgeMs);
        result.byDirectory[name] = stats;
        result.totalDeleted += stats.deletedFiles;
        result.totalBytes += stats.deletedBytes;

        if (stats.errors > 0) {
            result.success = false;
        }

        if (stats.deletedFiles > 0) {
            logger.debug('Cleaned cache directory', {
                name,
                deleted: stats.deletedFiles,
                bytes: formatBytes(stats.deletedBytes),
            });
        }
    }

    // Size-budget pass after TTL cleanup. Disabled when maxBytes <= 0 — a
    // negative misconfig must NOT be treated as "delete everything".
    if (maxBytes > 0) {
        const budget = await enforceSizeBudget(cacheDirs, maxBytes);
        result.budgetDeletedFiles = budget.deletedFiles;
        result.budgetDeletedBytes = budget.deletedBytes;
        result.finalSizeBytes = budget.finalSizeBytes;
        if (budget.errors > 0) result.success = false;

        if (budget.deletedFiles > 0) {
            logger.info('Image cache size-budget pass evicted oldest files', {
                deleted: budget.deletedFiles,
                freed: formatBytes(budget.deletedBytes),
                finalSize: formatBytes(budget.finalSizeBytes),
                budget: formatBytes(maxBytes),
            });
        }
    }

    result.duration = Date.now() - startTime;

    if (result.totalDeleted > 0 || result.budgetDeletedFiles > 0) {
        logger.info('Image cache cleanup completed', {
            ttlDeleted: result.totalDeleted,
            ttlFreed: formatBytes(result.totalBytes),
            budgetDeleted: result.budgetDeletedFiles,
            budgetFreed: formatBytes(result.budgetDeletedBytes),
            finalSize: formatBytes(result.finalSizeBytes),
            duration: `${result.duration}ms`,
        });
    } else {
        logger.debug('Image cache cleanup completed, no expired or over-budget files', {
            duration: `${result.duration}ms`,
            finalSize: formatBytes(result.finalSizeBytes),
        });
    }

    // Persist a summary so the admin UI can show "Last cleanup at ... freed
    // X". Awaited (not fire-and-forget) so a manual run from the admin
    // panel can return the same data the next stats poll will see.
    await persistCleanupResult(result);

    return result;
}

/**
 * Get current cache statistics without deleting anything
 */
export async function getCacheStats(): Promise<{
    totalFiles: number;
    totalBytes: number;
    byDirectory: Record<string, { files: number; bytes: number; oldestFile?: Date }>;
}> {
    const result = {
        totalFiles: 0,
        totalBytes: 0,
        byDirectory: {} as Record<string, { files: number; bytes: number; oldestFile?: Date }>,
    };

    const cacheDirs = getImageCacheDirs();

    for (const { name, path: dirPath } of cacheDirs) {
        const dirStats = {
            files: 0,
            bytes: 0,
            oldestFile: undefined as Date | undefined,
        };

        try {
            await fs.access(dirPath);
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                if (!entry.isFile()) continue;

                const filePath = path.join(dirPath, entry.name);
                try {
                    const fileStat = await fs.stat(filePath);
                    dirStats.files++;
                    dirStats.bytes += fileStat.size;

                    const mtime = new Date(fileStat.mtimeMs);
                    if (!dirStats.oldestFile || mtime < dirStats.oldestFile) {
                        dirStats.oldestFile = mtime;
                    }
                } catch {
                    // Skip files we can't stat
                }
            }
        } catch {
            // Directory doesn't exist
        }

        result.byDirectory[name] = dirStats;
        result.totalFiles += dirStats.files;
        result.totalBytes += dirStats.bytes;
    }

    return result;
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Export formatBytes for use in scripts
 */
export { formatBytes };
