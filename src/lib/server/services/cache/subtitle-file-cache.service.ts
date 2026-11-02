// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subtitle File Cache Service
 *
 * File-based caching for extracted subtitle streams.
 * Provides persistent caching with statistics tracking.
 */

import fs from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { constants as fsConstants, existsSync, readdirSync } from 'fs';
import { Logger } from '$lib/server/utils/logger';
import { isRecord } from '$lib/utils/data-extraction';
import { config } from '$lib/server/config.js';
import { readContainedFile } from '$lib/server/utils/contained-fs.js';

const logger = Logger.for('SubtitleFileCache');

// Cache directory: `.cache/subtitles` lives under the `cache` volume every
// deployment already mounts at `/app/.cache` (docker-compose.example.yml),
// same convention as the image caches (JELLYFIN_CACHE_DIR etc). The old
// `cache/subtitles` location was NOT volume-backed, so subtitles silently
// vanished on every image update.
//
// One-time migration: if an install already has files under the old,
// unmounted `cache/subtitles` dir and no new dir at all, keep
// reading/writing the old dir (rather than losing/duplicating those files)
// and log a deprecation notice. Fresh installs, and any install where the
// new dir already exists, use the new dir. Resolution is memoized after the
// first call — cache directory is not something that flips mid-process.
let cacheDirOverride: string | null = null;
let resolvedCacheDir: string | null = null;

// Only a legacy dir that HOLDS files is worth staying on. An empty one carries
// nothing to preserve, and treating it as an install to migrate is how every
// fresh container ended up pinned to the unmounted path.
function hasEntries(dir: string): boolean {
    try {
        return readdirSync(dir).length > 0;
    } catch {
        return false;
    }
}

function resolveCacheDir(): string {
    if (cacheDirOverride) return cacheDirOverride;
    if (resolvedCacheDir) return resolvedCacheDir;

    const newDir = path.join(process.cwd(), '.cache', 'subtitles');
    const oldDir = path.join(process.cwd(), 'cache', 'subtitles');

    if (!existsSync(newDir) && hasEntries(oldDir)) {
        logger.warn(
            'Using deprecated subtitle cache directory cache/subtitles — it is not ' +
                'covered by the `cache` volume mount and its contents do not survive an ' +
                'image update. New installs use .cache/subtitles. Delete cache/subtitles ' +
                'to switch over; support for it will be removed in a future release.',
            { oldDir, newDir },
        );
        resolvedCacheDir = oldDir;
    } else {
        resolvedCacheDir = newDir;
    }

    return resolvedCacheDir;
}

// Cache TTL: 7 days for text subtitles
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Binary subtitles (extracted PGS/VobSub and rendered bundles) have NO TTL. The
// output is a pure function of the media file, and `probed_at` validation already
// retires an entry when that file is replaced — so age alone never makes one
// wrong. Redoing one costs a full read of the container (a minute and a half on a
// 2h remux), so expiring them just re-bills that on the next viewing. Disk use is
// bounded by the byte budget (central) or lives with the media (alongside).

/** Bound on one cached bitmap track read back (a long PGS track is tens of MB). */
const MAX_BINARY_SUBTITLE_BYTES = 512 * 1024 * 1024;

/** Hidden folder next to the media file for alongside-stored bitmap subtitles. */
export const SUBTITLE_ALONGSIDE_DIR = '.subtitle-cache';

type BinaryExtension = 'sup' | 'sub' | 'render';

/**
 * Effective storage strategy for bitmap subtitles. 'inherit' follows the global
 * METADATA_STORAGE_LOCATION, exactly as trickplay does.
 */
function binaryStrategy(): 'central' | 'alongside' | 'alongside-prefer' {
    const own = config.SUBTITLE_STORAGE_LOCATION;
    return own === 'inherit' ? config.METADATA_STORAGE_LOCATION : own;
}

/**
 * `{mediaDir}/.subtitle-cache/{key}` for one media file.
 *
 * Keyed on the file's BASENAME, not on media_files.id — the trickplay reasoning:
 * two instances sharing a library over a network mount give the same physical
 * file different UUIDs, and a key derived from the name lets both find what
 * either wrote. The basename is unique within its directory, so a short hash is
 * collision-free here.
 */
function alongsideDirFor(mediaFilePath: string): string {
    return path.join(
        path.dirname(mediaFilePath),
        SUBTITLE_ALONGSIDE_DIR,
        alongsideKey(path.basename(mediaFilePath)),
    );
}

/** The per-file folder name under `.subtitle-cache/`: a short hash of the basename. */
function alongsideKey(basename: string): string {
    return createHash('sha1').update(basename).digest('hex').slice(0, 16);
}

/** Temp files younger than this may belong to an in-flight write; cleanup leaves them alone. */
const TEMP_FILE_GRACE_MS = 10 * 60 * 1000;

/** Unique per write: pid is identical across containers and Date.now() collides within a ms. */
function tempPathFor(cachePath: string): string {
    return `${cachePath}.tmp.${process.pid}.${randomUUID()}`;
}

/** Rename a finished temp file into place; a lost race with a concurrent writer is not an error. */
async function renameIntoPlace(tempPath: string, cachePath: string): Promise<void> {
    try {
        await fs.rename(tempPath, cachePath);
    } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT' && existsSync(cachePath)) {
            logger.debug('Cache rename lost a race to a concurrent writer', { cachePath });
            return;
        }
        throw error;
    }
}

/**
 * Remove `.subtitle-cache/{key}` folders in a media directory whose video is gone.
 *
 * Nothing else would: there is no TTL, and the delete hooks see item ids rather
 * than file paths, so a film deleted or renamed within a folder that stays
 * would leave its subtitles behind forever. A key is the hash of a basename, so
 * one listing of the directory tells which keys still have a file. Runs after
 * each alongside write — only when something is being added here anyway — and
 * only ever deletes inside our own hidden folder. Best-effort.
 */
async function pruneOrphanedAlongside(mediaDir: string): Promise<void> {
    const cacheRoot = path.join(mediaDir, SUBTITLE_ALONGSIDE_DIR);
    try {
        const [keys, names] = await Promise.all([fs.readdir(cacheRoot), fs.readdir(mediaDir)]);
        const live = new Set(names.map(alongsideKey));
        for (const key of keys) {
            if (live.has(key)) continue;
            await fs.rm(path.join(cacheRoot, key), { recursive: true, force: true });
            logger.debug('Removed alongside subtitles of a media file that no longer exists', {
                mediaDir,
                key,
            });
        }
    } catch (error) {
        logger.debug('Could not prune orphaned alongside subtitles', {
            mediaDir,
            error: (error as Error).message,
        });
    }
}

function alongsidePathFor(
    mediaFilePath: string,
    streamIndex: number,
    extension: BinaryExtension,
): string {
    return path.join(alongsideDirFor(mediaFilePath), `${streamIndex}.${extension}`);
}

export interface CacheStatistics {
    totalFiles: number;
    totalSizeBytes: number;
    oldestFile?: Date;
    newestFile?: Date;
}

/** Text formats the disk cache stores, as file extensions. */
export type TextSubtitleExtension = 'vtt' | 'ass' | 'srt';

/**
 * Subtitle file cache manager
 */
export class SubtitleFileCacheService {
    private static hitCount = 0;
    private static missCount = 0;

    /**
     * Get cache key for a subtitle stream
     * Format: {mediaSourceId}_{streamIndex}.{ext} — `ext` names the stored text
     * format (WebVTT unless told otherwise), so an ASS extraction never answers
     * a WebVTT read for the same stream.
     *
     * Sanitizes mediaSourceId to prevent path traversal attacks
     */
    static getCacheKey(
        mediaSourceId: string,
        streamIndex: number,
        ext: TextSubtitleExtension = 'vtt',
    ): string {
        // Remove any path separators and special characters
        // Keep only alphanumeric, underscore, and hyphen
        const sanitized = mediaSourceId.replace(/[^a-zA-Z0-9_-]/g, '_');
        return `${sanitized}_${streamIndex}.${ext}`;
    }

    /**
     * Get full cache file path
     */
    static getCachePath(
        mediaSourceId: string,
        streamIndex: number,
        ext: TextSubtitleExtension = 'vtt',
    ): string {
        const key = this.getCacheKey(mediaSourceId, streamIndex, ext);
        return path.join(resolveCacheDir(), key);
    }

    /**
     * Check if subtitle is cached
     */
    static async has(mediaSourceId: string, streamIndex: number): Promise<boolean> {
        const cachePath = this.getCachePath(mediaSourceId, streamIndex);

        if (!existsSync(cachePath)) {
            return false;
        }

        // Check if cache is stale
        try {
            const stats = await fs.stat(cachePath);
            const age = Date.now() - stats.mtimeMs;

            if (age > CACHE_TTL_MS) {
                logger.debug('Cache file is stale, removing', {
                    cachePath,
                    ageHours: Math.round(age / (60 * 60 * 1000)),
                });
                await fs.unlink(cachePath).catch(() => {
                    /* File may already be deleted - safe to ignore */
                });
                return false;
            }

            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get cached subtitle content.
     * Checks TTL and returns null if expired.
     *
     * @param mediaSourceId - Media source identifier
     * @param streamIndex - Subtitle stream index
     * @param notBefore - If provided, cache entries older than this date are
     *   treated as stale (e.g., pass the media file's `probed_at`).
     */
    static async get(
        mediaSourceId: string,
        streamIndex: number,
        notBefore?: Date | null,
        ext: TextSubtitleExtension = 'vtt',
    ): Promise<string | null> {
        const cachePath = this.getCachePath(mediaSourceId, streamIndex, ext);

        try {
            // Check TTL first (avoid TOCTOU by not using has())
            const stats = await fs.stat(cachePath);
            const age = Date.now() - stats.mtimeMs;

            if (age > CACHE_TTL_MS) {
                logger.debug('Cache file is stale (TTL), removing', {
                    cachePath,
                    ageHours: Math.round(age / (60 * 60 * 1000)),
                });
                await fs.unlink(cachePath).catch(() => {
                    /* File may already be deleted - safe to ignore */
                });
                this.missCount++;
                return null;
            }

            // If the source file was re-probed after this cache entry was
            // written, the underlying media changed — cache is invalid.
            if (notBefore && stats.mtimeMs < notBefore.getTime()) {
                logger.debug('Cache file predates source re-probe, removing', {
                    cachePath,
                    cacheMtime: new Date(stats.mtimeMs).toISOString(),
                    probedAt: notBefore.toISOString(),
                });
                await fs.unlink(cachePath).catch(() => {});
                this.missCount++;
                return null;
            }

            // Read content
            const content = (
                await readContainedFile(cachePath, { extraRoots: [resolveCacheDir()] })
            ).toString('utf-8');
            this.hitCount++;

            // Touch only on a VALIDATED read — same reasoning as getBinary below.
            // mtime is both the TTL clock and the freshness stamp, so touching
            // after an unvalidated read pushes it past a newer `probed_at` and
            // launders a stale entry as fresh permanently.
            //
            // Note the text path's callers do not currently pass `notBefore` at
            // all, so this entry now simply expires on its own TTL rather than
            // being renewed forever while someone is watching. That is the safer
            // of the two behaviours; wiring `probed_at` through would give it
            // real replacement invalidation.
            if (notBefore) {
                await fs.utimes(cachePath, new Date(), new Date()).catch(() => {
                    // Ignore errors - cache hit still succeeds even if touch fails
                });
            }

            logger.debug('Cache hit', {
                mediaSourceId,
                streamIndex,
                sizeBytes: content.length,
                ageSeconds: Math.round(age / 1000),
            });

            return content;
        } catch (error) {
            // File doesn't exist or other error
            if (isRecord(error) && error.code === 'ENOENT') {
                this.missCount++;
                return null;
            }

            // Unexpected error
            logger.warn('Failed to read cache file', {
                cachePath,
                error: (error as Error).message,
            });
            this.missCount++;
            return null;
        }
    }

    /**
     * Write subtitle to cache (atomic write)
     */
    static async set(
        mediaSourceId: string,
        streamIndex: number,
        content: string,
        ext: TextSubtitleExtension = 'vtt',
    ): Promise<void> {
        const cachePath = this.getCachePath(mediaSourceId, streamIndex, ext);
        // Use unique temp file name to prevent concurrent write conflicts
        const tempPath = tempPathFor(cachePath);

        try {
            // Ensure cache directory exists
            await fs.mkdir(resolveCacheDir(), { recursive: true });

            // Write to temp file first (atomic write)
            await fs.writeFile(tempPath, content, 'utf-8');

            // Rename temp file to final path (atomic operation)
            await renameIntoPlace(tempPath, cachePath);

            logger.debug('Cache write successful', {
                mediaSourceId,
                streamIndex,
                sizeBytes: content.length,
            });
        } catch (error) {
            logger.error('Failed to write cache file', error as Error, {
                cachePath,
                code: (error as { code?: string }).code,
                message: (error as Error).message,
            });

            // Clean up temp file if it exists
            await fs.unlink(tempPath).catch(() => {
                /* File may already be deleted - safe to ignore */
            });

            throw error;
        }
    }

    // ========================================================================
    // Binary subtitle cache (PGS .sup, VobSub .sub, rendered PNG bundle .render)
    // ========================================================================

    /**
     * Get cache key for a binary subtitle stream.
     * Extension distinguishes format: .sup (PGS), .sub (VobSub), or .render
     * (server-rendered PNG cue bundle -- see subtitle-render.service).
     */
    static getBinaryCacheKey(
        mediaSourceId: string,
        streamIndex: number,
        extension: 'sup' | 'sub' | 'render',
    ): string {
        const sanitized = mediaSourceId.replace(/[^a-zA-Z0-9_-]/g, '_');
        return `${sanitized}_${streamIndex}.${extension}`;
    }

    /**
     * Get full cache file path for binary subtitle
     */
    static getBinaryCachePath(
        mediaSourceId: string,
        streamIndex: number,
        extension: 'sup' | 'sub' | 'render',
    ): string {
        const key = this.getBinaryCacheKey(mediaSourceId, streamIndex, extension);
        return path.join(resolveCacheDir(), key);
    }

    /**
     * Where a binary entry may live, in probe order: the configured location first,
     * so a file present in both is served from where it is meant to be. Reads check
     * both regardless of the setting, so changing it never orphans existing files.
     */
    private static binaryCandidates(
        mediaSourceId: string,
        streamIndex: number,
        extension: BinaryExtension,
        mediaFilePath?: string | null,
    ): string[] {
        const central = this.getBinaryCachePath(mediaSourceId, streamIndex, extension);
        if (!mediaFilePath) return [central];
        const alongside = alongsidePathFor(mediaFilePath, streamIndex, extension);
        return binaryStrategy() === 'central' ? [central, alongside] : [alongside, central];
    }

    /**
     * Get cached binary subtitle content.
     *
     * No TTL: see the note on binary subtitles at the top of this file. An entry is
     * only ever retired because its source was re-probed after it was written.
     *
     * @param mediaSourceId - Media source identifier
     * @param streamIndex - Subtitle stream index
     * @param extension - File extension ('sup' for PGS, 'sub' for VobSub,
     *   'render' for the rendered PNG cue bundle)
     * @param notBefore - If provided, cache entries older than this date are
     *   treated as stale. Use the media file's `probed_at` to auto-invalidate
     *   when the underlying file is replaced and re-probed.
     * @param mediaFilePath - The media file, so an entry stored alongside it can
     *   be found. Without it only the central cache is checked.
     */
    static async getBinary(
        mediaSourceId: string,
        streamIndex: number,
        extension: BinaryExtension,
        notBefore?: Date | null,
        mediaFilePath?: string | null,
    ): Promise<Buffer | null> {
        for (const cachePath of this.binaryCandidates(
            mediaSourceId,
            streamIndex,
            extension,
            mediaFilePath,
        )) {
            const content = await this.readBinaryAt(cachePath, notBefore);
            if (content) {
                this.hitCount++;
                logger.debug('Binary cache hit', {
                    mediaSourceId,
                    streamIndex,
                    extension,
                    cachePath,
                    sizeBytes: content.length,
                });
                return content;
            }
        }
        this.missCount++;
        return null;
    }

    /** Read and validate one candidate; null when absent, stale or unreadable. */
    private static async readBinaryAt(
        cachePath: string,
        notBefore?: Date | null,
    ): Promise<Buffer | null> {
        try {
            const stats = await fs.stat(cachePath);

            // If the source file was re-probed after this cache entry was
            // written, the underlying media changed — cache is invalid.
            if (notBefore && stats.mtimeMs < notBefore.getTime()) {
                logger.debug('Binary cache file predates source re-probe, removing', {
                    cachePath,
                    cacheMtime: new Date(stats.mtimeMs).toISOString(),
                    probedAt: notBefore.toISOString(),
                });
                await fs.unlink(cachePath).catch(() => {});
                return null;
            }

            // An alongside entry sits in the library, where a link can be swapped in
            // after it was written: read it contained (sidecar rules), so neither the
            // read nor the touch below reaches a target outside the library.
            const content = await readContainedFile(cachePath, {
                extraRoots: [resolveCacheDir()],
                maxBytes: MAX_BINARY_SUBTITLE_BYTES,
                parents: true,
            });

            // Touch — but ONLY when this read was validated against a known probe
            // time. The touch keeps a central entry warm for the byte budget's
            // least-recently-used eviction.
            //
            // Staleness is decided by comparing mtime to `probed_at`, and the
            // touch rewrites mtime to now. So a single unvalidated read (caller
            // could not resolve the file row — exactly what happens while a file
            // is being replaced) would push mtime past the new probe time and
            // launder the pre-replacement entry as fresh for every validated read
            // afterwards.
            if (notBefore) {
                await fs.lutimes(cachePath, new Date(), new Date()).catch(() => {});
            }

            return content;
        } catch (error) {
            if (!(isRecord(error) && error.code === 'ENOENT')) {
                logger.warn('Failed to read binary cache file', {
                    cachePath,
                    error: (error as Error).message,
                });
            }
            return null;
        }
    }

    /**
     * Whether a valid binary entry exists, WITHOUT reading or touching it.
     *
     * Same `notBefore` rule as getBinary, but a stat only: callers use this to
     * decide what still needs extracting, and a full read of a multi-megabyte
     * .sup just to learn it exists would be waste. It does not touch the entry
     * either, since nothing was served.
     */
    static async hasFreshBinary(
        mediaSourceId: string,
        streamIndex: number,
        extension: BinaryExtension,
        notBefore?: Date | null,
        mediaFilePath?: string | null,
    ): Promise<boolean> {
        for (const cachePath of this.binaryCandidates(
            mediaSourceId,
            streamIndex,
            extension,
            mediaFilePath,
        )) {
            try {
                const stats = await fs.stat(cachePath);
                if (notBefore && stats.mtimeMs < notBefore.getTime()) continue;
                if (stats.size > 0) return true;
            } catch {
                // Absent here; try the other location.
            }
        }
        return false;
    }

    /**
     * Where to write a binary entry under the configured strategy.
     *
     * Mirrors metadata-storage's semantics: 'alongside' insists (and throws when
     * the media folder is not writable), 'alongside-prefer' falls back to the
     * central cache, 'central' never touches the media folder. One deliberate
     * difference: with no media path at all, both alongside modes use central.
     */
    private static async binaryWritePath(
        mediaSourceId: string,
        streamIndex: number,
        extension: BinaryExtension,
        mediaFilePath?: string | null,
    ): Promise<string> {
        const strategy = binaryStrategy();
        if (strategy !== 'central') {
            if (mediaFilePath) {
                const dir = alongsideDirFor(mediaFilePath);
                try {
                    await fs.mkdir(dir, { recursive: true });
                    await fs.access(dir, fsConstants.W_OK);
                    return path.join(dir, `${streamIndex}.${extension}`);
                } catch (error) {
                    if (strategy === 'alongside') throw error;
                    logger.debug('Media folder not writable, keeping subtitle in central cache', {
                        dir,
                        error: (error as Error).message,
                    });
                }
            } else {
                // No path means the caller could not resolve the file — nothing
                // to sit next to. Unlike an unwritable folder that is not an
                // operator decision to honour, and throwing would only leave the
                // result uncached so the next request re-reads the whole file.
                logger.debug('No media file path for alongside subtitle, using central cache', {
                    mediaSourceId,
                    streamIndex,
                });
            }
        }
        await fs.mkdir(resolveCacheDir(), { recursive: true });
        return this.getBinaryCachePath(mediaSourceId, streamIndex, extension);
    }

    /**
     * Write binary subtitle to cache (atomic write), alongside the media file or
     * in the central cache per SUBTITLE_STORAGE_LOCATION.
     */
    static async setBinary(
        mediaSourceId: string,
        streamIndex: number,
        extension: BinaryExtension,
        content: Buffer,
        mediaFilePath?: string | null,
    ): Promise<void> {
        const cachePath = await this.binaryWritePath(
            mediaSourceId,
            streamIndex,
            extension,
            mediaFilePath,
        );
        const tempPath = tempPathFor(cachePath);

        try {
            await fs.writeFile(tempPath, content);
            await renameIntoPlace(tempPath, cachePath);

            if (mediaFilePath && cachePath.startsWith(alongsideDirFor(mediaFilePath))) {
                await pruneOrphanedAlongside(path.dirname(mediaFilePath));
            }

            logger.debug('Binary cache write successful', {
                mediaSourceId,
                streamIndex,
                extension,
                cachePath,
                sizeBytes: content.length,
            });
        } catch (error) {
            logger.error('Failed to write binary cache file', error as Error, {
                cachePath,
                code: (error as { code?: string }).code,
                message: (error as Error).message,
            });
            await fs.unlink(tempPath).catch(() => {});
            throw error;
        }
    }

    /**
     * Remove every bitmap subtitle stored alongside a media file.
     *
     * Called when the file's content changes, like the trickplay equivalent. A
     * stale entry would be caught by the `probed_at` check anyway; this keeps the
     * media folder from carrying dead bytes until someone happens to request each
     * track. The central cache needs no counterpart: its keys include the file id,
     * and the budget sweep reaps unread entries.
     */
    static async deleteAlongside(mediaFilePath: string): Promise<void> {
        await fs.rm(alongsideDirFor(mediaFilePath), { recursive: true, force: true });
    }

    /**
     * Delete cached subtitle
     */
    static async delete(mediaSourceId: string, streamIndex: number): Promise<void> {
        const cachePath = this.getCachePath(mediaSourceId, streamIndex);

        try {
            await fs.unlink(cachePath);
            logger.debug('Cache file deleted', { cachePath });
        } catch (error) {
            // Ignore errors if file doesn't exist
            if (!(isRecord(error) && error.code === 'ENOENT')) {
                logger.warn('Failed to delete cache file', {
                    cachePath,
                    error: (error as Error).message,
                });
            }
        }
    }

    /**
     * Get cache statistics
     */
    static async getStatistics(): Promise<CacheStatistics> {
        try {
            // Ensure cache directory exists
            if (!existsSync(resolveCacheDir())) {
                return {
                    totalFiles: 0,
                    totalSizeBytes: 0,
                };
            }

            const files = await fs.readdir(resolveCacheDir());
            let totalSize = 0;
            let oldestDate: Date | undefined;
            let newestDate: Date | undefined;

            for (const file of files) {
                try {
                    const filePath = path.join(resolveCacheDir(), file);
                    const stats = await fs.stat(filePath);

                    // Skip directories and other non-file entries
                    if (!stats.isFile()) {
                        continue;
                    }

                    totalSize += stats.size;

                    const mtime = stats.mtime;
                    if (!oldestDate || mtime < oldestDate) {
                        oldestDate = mtime;
                    }
                    if (!newestDate || mtime > newestDate) {
                        newestDate = mtime;
                    }
                } catch (error) {
                    // Skip files we can't stat
                    logger.debug('Failed to stat cache file', {
                        file,
                        error: (error as Error).message,
                    });
                }
            }

            return {
                totalFiles: files.length,
                totalSizeBytes: totalSize,
                oldestFile: oldestDate,
                newestFile: newestDate,
            };
        } catch (error) {
            logger.error('Failed to get cache statistics', error as Error);
            return {
                totalFiles: 0,
                totalSizeBytes: 0,
            };
        }
    }

    /**
     * Clean up stale cache files
     */
    static async cleanup(): Promise<number> {
        try {
            if (!existsSync(resolveCacheDir())) {
                return 0;
            }

            const files = await fs.readdir(resolveCacheDir());
            let deletedCount = 0;
            const now = Date.now();

            for (const file of files) {
                try {
                    const filePath = path.join(resolveCacheDir(), file);

                    // Orphaned .tmp files (.tmp, .tmp.PID.TIMESTAMP, .tmp.PID.UUID).
                    // A young one may belong to an in-flight write that is about to
                    // rename it, so only reap those past the grace period.
                    if (file.includes('.tmp')) {
                        const tmpStats = await fs.stat(filePath);
                        if (tmpStats.isFile() && now - tmpStats.mtimeMs > TEMP_FILE_GRACE_MS) {
                            await fs.unlink(filePath);
                            deletedCount++;
                            logger.debug('Deleted orphaned temp file', { file });
                        }
                        continue;
                    }

                    const stats = await fs.stat(filePath);

                    // Skip directories
                    if (!stats.isFile()) {
                        continue;
                    }

                    const age = now - stats.mtimeMs;

                    // Binary subtitle artifacts never expire by age (see the note
                    // at the top of this file); only the byte budget below reaps
                    // them. Keep this in step with the extensions
                    // getBinaryCacheKey can emit — a missing one here silently
                    // subjects that artifact to the short text TTL.
                    const isBinary =
                        file.endsWith('.sup') || file.endsWith('.sub') || file.endsWith('.render');
                    const ttl = isBinary ? Infinity : CACHE_TTL_MS;

                    if (age > ttl) {
                        await fs.unlink(filePath);
                        deletedCount++;
                        logger.debug('Deleted stale cache file', {
                            file,
                            ageHours: Math.round(age / (60 * 60 * 1000)),
                        });
                    }
                } catch (error) {
                    // Skip files we can't process
                    logger.debug('Failed to process file during cleanup', {
                        file,
                        error: (error as Error).message,
                    });
                }
            }

            // Byte-budget pass: runs after TTL cleanup, independent of it. It is
            // the ONLY bound on binary artifacts here, since they never expire by
            // age — a `.sup`/`.render` pair from one PGS track runs tens of MB.
            // Entries stored alongside media are outside this directory and so
            // outside the budget, by design.
            const maxBytes = config.SUBTITLE_CACHE_MAX_BYTES;
            if (maxBytes > 0) {
                deletedCount += await this.enforceSizeBudget(maxBytes);
            }

            if (deletedCount > 0) {
                logger.info('Cache cleanup completed', { deletedCount });
            }

            return deletedCount;
        } catch (error) {
            logger.error('Cache cleanup failed', error as Error);
            return 0;
        }
    }

    /**
     * Enforce SUBTITLE_CACHE_MAX_BYTES by deleting the coldest (oldest mtime)
     * surviving files first, until total usage is at or under budget. mtime is
     * touched on validated reads (see get()/getBinary()), so this is an
     * LRU-ish proxy — same tradeoff the image cache's size-budget pass makes.
     */
    private static async enforceSizeBudget(maxBytes: number): Promise<number> {
        interface FileEntry {
            path: string;
            size: number;
            mtimeMs: number;
        }

        const dir = resolveCacheDir();
        let files: string[];
        try {
            files = await fs.readdir(dir);
        } catch {
            return 0;
        }

        const entries: FileEntry[] = [];
        let totalBytes = 0;

        for (const file of files) {
            // In-flight temp files are not cache entries yet (cleanup() reaps stale ones).
            if (file.includes('.tmp')) continue;
            const filePath = path.join(dir, file);
            try {
                const stat = await fs.stat(filePath);
                if (!stat.isFile()) continue;
                entries.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
                totalBytes += stat.size;
            } catch {
                // Best-effort: a file that vanished or can't be stat'd is
                // simply excluded from the accounting.
            }
        }

        if (totalBytes <= maxBytes) {
            return 0;
        }

        entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

        let deletedCount = 0;
        let deletedBytes = 0;
        for (const entry of entries) {
            if (totalBytes <= maxBytes) break;
            try {
                await fs.unlink(entry.path);
                deletedCount++;
                deletedBytes += entry.size;
                totalBytes -= entry.size;
            } catch (error) {
                logger.debug('Failed to delete cache file under budget pressure', {
                    path: entry.path,
                    error: (error as Error).message,
                });
            }
        }

        if (deletedCount > 0) {
            logger.info('Subtitle cache size-budget pass evicted oldest files', {
                deletedCount,
                deletedBytes,
                finalSizeBytes: totalBytes,
                maxBytes,
            });
        }

        return deletedCount;
    }

    /**
     * Test-only: pin the cache directory to a fixed path, bypassing legacy-dir
     * resolution entirely. Pass null to clear the override.
     */
    static _setCacheDirForTesting(dir: string | null): void {
        cacheDirOverride = dir;
    }

    /**
     * Test-only: forget the memoized legacy-vs-new directory resolution so the
     * next call re-evaluates against the current (possibly mocked) cwd.
     */
    static _resetCacheDirResolutionForTesting(): void {
        resolvedCacheDir = null;
    }

    /**
     * Clear all cached subtitles
     */
    static async clear(): Promise<number> {
        try {
            if (!existsSync(resolveCacheDir())) {
                return 0;
            }

            const files = await fs.readdir(resolveCacheDir());

            for (const file of files) {
                try {
                    const filePath = path.join(resolveCacheDir(), file);
                    const stats = await fs.stat(filePath);

                    // Only delete files, not directories
                    if (stats.isFile()) {
                        await fs.unlink(filePath);
                    }
                } catch (error) {
                    // Skip files we can't delete
                    logger.debug('Failed to delete file during clear', {
                        file,
                        error: (error as Error).message,
                    });
                }
            }

            logger.info('Cache cleared', { deletedCount: files.length });
            return files.length;
        } catch (error) {
            logger.error('Cache clear failed', error as Error);
            return 0;
        }
    }

    /**
     * Get cache hit/miss statistics
     */
    static getHitMissStats(): {
        hits: number;
        misses: number;
        hitRate: number;
    } {
        const total = this.hitCount + this.missCount;
        const hitRate = total > 0 ? this.hitCount / total : 0;

        return {
            hits: this.hitCount,
            misses: this.missCount,
            hitRate: Math.round(hitRate * 100) / 100,
        };
    }

    /**
     * Reset hit/miss counters
     */
    static resetStats(): void {
        this.hitCount = 0;
        this.missCount = 0;
    }
}
