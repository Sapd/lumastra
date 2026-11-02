// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trickplay Storage Service
 *
 * Manages storage and retrieval of trickplay sprite sheets and manifests.
 * Storage location is controlled by TRICKPLAY_STORAGE_LOCATION, which defaults
 * to 'inherit' (follow the global METADATA_STORAGE_LOCATION) but can be set to
 * diverge from other metadata types:
 *   - central:          TRICKPLAY_STORAGE_PATH (default /config/trickplay)
 *   - alongside:        .trickplay/ directory next to the media file
 *   - alongside-prefer: try alongside, fall back to central
 * Reads always probe both locations.
 */

import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { TrickplayInfo } from '$lib/schemas/playback-types.js';
import {
    resolveWritePath,
    resolveReadPath,
    type StorageStrategy,
} from './metadata-storage.service.js';
import { dirname, join, basename } from 'path';
import { createHash, randomUUID } from 'node:crypto';
import {
    safeExists,
    safeReaddir,
    safeRm,
    safeRename as safeRenameFs,
    safeStat,
    safeCp,
    safeAccess,
    safeUnlink,
} from '$lib/server/utils/safe-fs.js';
import {
    ContainmentError,
    readContainedFile,
    writeFileNoFollow,
} from '$lib/server/utils/contained-fs.js';
import { isPathInsideDirectory } from '$lib/server/utils/hls-segment-utils.js';

const logger = Logger.for('TrickplayStorage');

/**
 * `media_files.id` shape. A caller-supplied fileId that reaches this service
 * is joined directly into a filesystem path (`TRICKPLAY_STORAGE_PATH/{fileId}/...`)
 * — the HLS handlers validate/resolve it against the requested item BEFORE
 * calling in (see iframe-handler.ts), but this is defense in depth for any
 * other/future caller: reject anything that isn't UUID-shaped before it is
 * ever joined into a path, rather than relying on containment alone.
 */
const TRICKPLAY_FILE_ID_RE = /^[0-9a-f-]{36}$/i;

function assertValidFileId(fileId: string): void {
    if (!TRICKPLAY_FILE_ID_RE.test(fileId)) {
        throw new Error(`Invalid trickplay fileId: ${fileId}`);
    }
}

/** Belt-and-suspenders containment check alongside the fileId format guard. */
function assertInsideTrickplayStorage(filePath: string, basePath: string): void {
    if (!isPathInsideDirectory(filePath, basePath)) {
        throw new Error(`Trickplay path escapes storage root: ${filePath}`);
    }
}

/** rename() that falls back to copy+delete when src and dest are on different devices (EXDEV). */
async function safeRename(src: string, dest: string): Promise<void> {
    try {
        await safeRenameFs(src, dest);
    } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === 'EXDEV') {
            // Cross-device fallback. A sibling replica may remove `src` mid-copy
            // on a shared volume; tolerate ENOENT here too (already moved).
            try {
                await safeCp(src, dest, { recursive: true });
                await safeRm(src, { recursive: true });
            } catch (fallbackErr: unknown) {
                if ((fallbackErr as { code?: string }).code === 'ENOENT') return;
                throw fallbackErr;
            }
        } else if (code === 'ENOENT') {
            // Source vanished between our check and the rename. On a shared
            // volume that means a sibling replica running the same one-time
            // migration already moved it — treat as done, not an error.
            return;
        } else {
            throw err;
        }
    }
}

export interface TrickplayStorageStats {
    totalFiles: number;
    totalSizeBytes: number;
    fileCount: number;
}

export async function getTrickplayBasePath(): Promise<string> {
    return config.TRICKPLAY_STORAGE_PATH;
}

// ---------------------------------------------------------------------------
// TODO(pre-release): Remove this filesystem migration before v1.0 release.
// It migrates the legacy `_sources/{id}/` trickplay layout to flat `{id}/`.
// After all existing deployments have upgraded past this version, delete
// `migrateTrickplayStorage()`, `mergeDirectory()`, and the startup call
// in hooks.server.ts (~line 710).
// ---------------------------------------------------------------------------

/**
 * Migrate legacy `_sources/{id}/` directories to the flat `{id}/` layout.
 *
 * When the destination already exists (mixed layout), individual files are
 * moved from the old directory into the existing one so no data is lost.
 * Safe to call multiple times — no-ops if `_sources/` doesn't exist.
 */
export async function migrateTrickplayStorage(): Promise<void> {
    const basePath = config.TRICKPLAY_STORAGE_PATH;
    const sourcesDir = join(basePath, '_sources');
    try {
        await safeAccess(sourcesDir);
    } catch {
        return;
    }

    // NOTE: Concurrent trickplay generation may write new files into _sources/
    // while this migration runs. The risk is low since this is a one-time startup
    // operation and any missed files will use the flat layout on next generation.
    // On a shared volume another replica may also be running this migration; an
    // ENOENT here means a sibling already finished and removed _sources/.
    let entries;
    try {
        entries = await safeReaddir(sourcesDir);
    } catch (err: unknown) {
        if ((err as { code?: string }).code === 'ENOENT') return;
        throw err;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const src = join(sourcesDir, entry.name);
        const dest = join(basePath, entry.name);
        if (!(await safeExists(dest))) {
            // Simple case: no conflict, just rename the whole directory
            await safeRename(src, dest);
        } else {
            // Mixed layout: merge files from old into existing directory
            await mergeDirectory(src, dest);
        }
    }
    await safeRm(sourcesDir, { recursive: true, force: true }).catch(() => {});
    logger.info('Migrated trickplay storage from _sources/ to flat layout');
}

/**
 * Recursively merge `src` into `dest`, preferring existing files in dest.
 */
async function mergeDirectory(src: string, dest: string): Promise<void> {
    let entries;
    try {
        entries = await safeReaddir(src);
    } catch (err: unknown) {
        // A sibling replica running the same migration may have moved/removed
        // `src` concurrently — nothing left to merge.
        if ((err as { code?: string }).code === 'ENOENT') return;
        throw err;
    }
    for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
            if (!(await safeExists(destPath))) {
                await safeRename(srcPath, destPath);
            } else {
                await mergeDirectory(srcPath, destPath);
            }
        } else if (!(await safeExists(destPath))) {
            await safeRename(srcPath, destPath);
        } else {
            // Dest file exists but is 0 bytes — overwrite with source
            try {
                const destStat = await safeStat(destPath);
                if (destStat.size === 0) {
                    await safeRename(srcPath, destPath);
                }
            } catch {
                // stat failed — skip, dest wins
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Central directory for a given fileId + width. */
function centralDir(fileId: string, width: number): string {
    assertValidFileId(fileId);
    const dir = join(config.TRICKPLAY_STORAGE_PATH, fileId, width.toString());
    assertInsideTrickplayStorage(dir, config.TRICKPLAY_STORAGE_PATH);
    return dir;
}

/**
 * Stable key for the ALONGSIDE sidecar directory.
 *
 * The alongside layout is `{mediaDir}/.trickplay/{key}/{width}/`. The parent
 * dir is already the media file's own directory, so the key only needs to be
 * unique WITHIN that directory — and `media_files.id` (a per-instance random
 * UUID) is the wrong choice for that: two instances that share the same media
 * over a network mount assign DIFFERENT UUIDs to the same physical file, so a
 * consumer replica could never find the sidecar a producer wrote. We instead
 * derive the key from the file's basename, which is identical on every instance
 * that mounts the same media (and mount-root independent). Colocation makes the
 * basename unique within its directory, so a short hash is collision-free here.
 *
 * Content freshness on in-place replacement is handled elsewhere: the scanner's
 * `content-changed` path calls `deleteTrickplay()` (same derivation) and the
 * producer regenerates under this same key — the key deliberately does NOT
 * encode content, so cross-instance sharing stays stable.
 *
 * `mediaFilePath` is required to locate the sidecar at all; when it is absent
 * (central-only callers) we fall back to `fileId` so the value is still defined.
 */
function alongsideKey(fileId: string, mediaFilePath?: string | null): string {
    if (!mediaFilePath) return fileId;
    return createHash('sha1').update(basename(mediaFilePath)).digest('hex').slice(0, 16);
}

/** `.trickplay/{key}/{width}` sub-path used as the alongside write/read target. */
function alongsideSubDir(fileId: string, width: number, mediaFilePath?: string | null): string {
    return join('.trickplay', alongsideKey(fileId, mediaFilePath), width.toString());
}

/** Root `.trickplay/{key}` directory next to the media file (for delete/scan). */
function alongsideRootDir(fileId: string, mediaFilePath: string): string {
    return join(dirname(mediaFilePath), '.trickplay', alongsideKey(fileId, mediaFilePath));
}

/**
 * Resolve the storage strategy for trickplay specifically.
 * Returns `undefined` when TRICKPLAY_STORAGE_LOCATION is 'inherit', so the
 * metadata-storage resolver falls back to the global METADATA_STORAGE_LOCATION.
 * Otherwise returns the trickplay-specific override.
 */
function trickplayStrategyOverride(): StorageStrategy | undefined {
    const loc = config.TRICKPLAY_STORAGE_LOCATION;
    return loc === 'inherit' ? undefined : loc;
}

/**
 * Resolve trickplay file path, probing alongside-media and central locations,
 * with legacy `_sources/` fallback for the startup migration window.
 *
 * @param mediaFilePath  Absolute path to the media file (optional — needed for alongside probing)
 */
async function getTrickplayPath(
    basePath: string,
    fileId: string,
    width: number,
    fileName: string,
    mediaFilePath?: string | null,
): Promise<string> {
    assertValidFileId(fileId);
    const centralReadDir = join(basePath, fileId, width.toString());
    assertInsideTrickplayStorage(centralReadDir, basePath);

    // Use the unified read-path resolver to check alongside + central
    const resolved = await resolveReadPath({
        mediaFilePath: mediaFilePath ?? null,
        centralDir: centralReadDir,
        fileName,
        alongsideSubDir: alongsideSubDir(fileId, width, mediaFilePath),
        strategyOverride: trickplayStrategyOverride(),
    });
    if (resolved) return resolved;

    // Legacy _sources/ fallback during startup migration window
    const legacyDir = join(basePath, '_sources', fileId, width.toString());
    assertInsideTrickplayStorage(legacyDir, basePath);
    const legacyPath = join(legacyDir, fileName);
    if (await safeExists(legacyPath)) return legacyPath;

    // Not found anywhere — return the central path as default
    return join(basePath, fileId, width.toString(), fileName);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function saveSpriteSheet(
    fileId: string,
    width: number,
    index: number,
    data: Buffer,
    mediaFilePath?: string | null,
    generation?: string,
): Promise<string> {
    if (generation) assertValidFileId(generation);
    const result = await resolveWritePath({
        mediaFilePath: mediaFilePath ?? null,
        centralDir: generation
            ? join(centralDir(fileId, width), generation)
            : centralDir(fileId, width),
        fileName: `${index}.webp`,
        alongsideSubDir: generation
            ? join(alongsideSubDir(fileId, width, mediaFilePath), generation)
            : alongsideSubDir(fileId, width, mediaFilePath),
        strategyOverride: trickplayStrategyOverride(),
    });
    await writeFileNoFollow(result.filePath, data);
    logger.debug('Saved sprite sheet', {
        fileId,
        width,
        index,
        size: data.length,
        location: result.location,
    });
    return result.filePath;
}

/** Resolve a sheet for stat-based completeness checks without loading image bytes. */
export async function getSpriteSheetPath(
    fileId: string,
    width: number,
    index: number,
    mediaFilePath?: string | null,
): Promise<string> {
    const manifest = await getTrickplayManifest(fileId, width, mediaFilePath);
    const generation = manifest?.storageGeneration;
    if (generation) assertValidFileId(generation);
    return getTrickplayPath(
        await getTrickplayBasePath(),
        fileId,
        width,
        generation ? `${generation}/${index}.webp` : `${index}.webp`,
        mediaFilePath,
    );
}

export async function getSpriteSheet(
    fileId: string,
    width: number,
    index: number,
    mediaFilePath?: string | null,
): Promise<Buffer | null> {
    const manifest = await getTrickplayManifest(fileId, width, mediaFilePath);
    const generation = manifest?.storageGeneration;
    if (generation) assertValidFileId(generation);
    const basePath = await getTrickplayBasePath();
    const filePath = await getTrickplayPath(
        basePath,
        fileId,
        width,
        generation ? `${generation}/${index}.webp` : `${index}.webp`,
        mediaFilePath,
    );

    if (!(await safeExists(filePath))) {
        return null;
    }

    try {
        return await readContainedFile(filePath);
    } catch (err) {
        // A planted symlink out of the library reads as "no sprite".
        if (err instanceof ContainmentError) return null;
        throw err;
    }
}

export interface TrickplayManifest {
    /** Immutable sheet set. manifest.json is the atomic publication pointer. */
    storageGeneration?: string;
    /** The single prior published set retained for recovery. */
    previousStorageGeneration?: string;
    version: string;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
    interval: number;
    thumbnailCount: number;
    format: string;
    sheets: TrickplaySheet[];
    /** Only successful, complete Lumastra extraction writes this content proof. */
    reuse?: {
        sampledHash: string;
        size: number;
        mtimeMs: number;
        quality: number;
        spriteQuality: number;
        providerId: string;
    };
}

export interface TrickplaySheet {
    index: number;
    filename: string;
    startTime: number;
    endTime: number;
    thumbnailCount: number;
}

export async function saveTrickplayManifest(
    fileId: string,
    width: number,
    manifest: TrickplayManifest,
    mediaFilePath?: string | null,
): Promise<void> {
    const result = await resolveWritePath({
        mediaFilePath: mediaFilePath ?? null,
        centralDir: centralDir(fileId, width),
        fileName: 'manifest.json',
        alongsideSubDir: alongsideSubDir(fileId, width, mediaFilePath),
        strategyOverride: trickplayStrategyOverride(),
    });
    if (manifest.storageGeneration) {
        assertValidFileId(manifest.storageGeneration);
        for (const sheet of manifest.sheets) {
            const file = join(
                dirname(result.filePath),
                manifest.storageGeneration,
                `${sheet.index}.webp`,
            );
            const stored = await safeStat(file).catch(() => null);
            if (!stored?.isFile() || stored.size === 0)
                throw new Error(
                    'Seek preview replacement is incomplete; previous previews retained.',
                );
        }
    }
    const previous = await getTrickplayManifest(fileId, width, mediaFilePath);
    if (previous?.storageGeneration && previous.storageGeneration !== manifest.storageGeneration)
        manifest.previousStorageGeneration = previous.storageGeneration;
    else if (previous?.previousStorageGeneration)
        manifest.previousStorageGeneration = previous.previousStorageGeneration;
    const tmp = `${result.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFileNoFollow(tmp, JSON.stringify(manifest, null, 2));
        await safeRenameFs(tmp, result.filePath);
    } finally {
        await safeUnlink(tmp).catch(() => undefined);
    }
    // Publication succeeded. Retain only this set and the prior publication.
    await pruneGenerations(
        dirname(result.filePath),
        manifest,
        false,
        previous?.previousStorageGeneration,
    ).catch((error: unknown) =>
        logger.warn('Could not prune old seek previews', { fileId, error: String(error) }),
    );
    logger.debug('Saved manifest', {
        fileId,
        width,
        location: result.location,
    });
}

export async function getTrickplayManifest(
    fileId: string,
    width: number,
    mediaFilePath?: string | null,
): Promise<TrickplayManifest | null> {
    const basePath = await getTrickplayBasePath();
    const manifestPath = await getTrickplayPath(
        basePath,
        fileId,
        width,
        'manifest.json',
        mediaFilePath,
    );

    if (!(await safeExists(manifestPath))) {
        return null;
    }

    try {
        const data = (
            await readContainedFile(manifestPath, { maxBytes: 4 * 1024 * 1024 })
        ).toString('utf-8');
        return JSON.parse(data) as TrickplayManifest;
    } catch (error) {
        logger.error('Failed to read manifest', error instanceof Error ? error : undefined, {
            fileId,
            width,
        });
        return null;
    }
}

/** Revision comes from the stored manifest contents and filesystem identity. The
 * generator publishes manifest.json after sheets, so regenerating identical
 * dimensions still invalidates chapter URLs. Sheet ETags also hash sheet bytes. */
const revisionCache = new Map<string, string>();
const REVISION_CACHE_LIMIT = 64;

export async function getTrickplayRevision(
    fileId: string,
    width: number,
    mediaFilePath?: string | null,
): Promise<string | null> {
    const basePath = await getTrickplayBasePath();
    const path = await getTrickplayPath(basePath, fileId, width, 'manifest.json', mediaFilePath);
    try {
        const stat = await safeStat(path);
        const key = `${fileId}:${width}:${path}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
        const cached = revisionCache.get(key);
        if (cached) {
            revisionCache.delete(key);
            revisionCache.set(key, cached);
            return cached;
        }
        const data = await readContainedFile(path, { maxBytes: 4 * 1024 * 1024 });
        const revision = createHash('sha256')
            .update(`${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:`)
            .update(data)
            .digest('hex');
        revisionCache.set(key, revision);
        if (revisionCache.size > REVISION_CACHE_LIMIT) {
            const oldest = revisionCache.keys().next().value;
            if (oldest !== undefined) revisionCache.delete(oldest);
        }
        return revision;
    } catch {
        return null;
    }
}

export async function hasTrickplay(
    fileId: string,
    width: number,
    mediaFilePath?: string | null,
): Promise<boolean> {
    const manifest = await getTrickplayManifest(fileId, width, mediaFilePath);
    return manifest !== null && manifest.sheets.length > 0;
}

export async function deleteTrickplay(
    fileId: string,
    mediaFilePath?: string | null,
): Promise<void> {
    const basePath = await getTrickplayBasePath();

    // Delete from central location
    const centralDirPath = join(basePath, fileId);
    try {
        await safeAccess(centralDirPath);
        await safeRm(centralDirPath, { recursive: true, force: true });
        logger.info('Deleted trickplay from central', { fileId });
    } catch {
        // Directory does not exist — nothing to delete
    }

    // Delete from alongside location if media file path is known
    if (mediaFilePath) {
        const alongsideDir = alongsideRootDir(fileId, mediaFilePath);
        try {
            await safeAccess(alongsideDir);
            await safeRm(alongsideDir, { recursive: true, force: true });
            logger.info('Deleted trickplay from alongside media', { fileId });
        } catch {
            // Directory does not exist — nothing to delete
        }
    }
}

/** Remove only the unfinished set owned by one failed/cancelled generator. */
export async function deleteTrickplayGeneration(
    fileId: string,
    width: number,
    generation: string,
    mediaFilePath?: string | null,
): Promise<void> {
    assertValidFileId(fileId);
    assertValidFileId(generation);
    const roots = [centralDir(fileId, width)];
    if (mediaFilePath)
        roots.push(join(dirname(mediaFilePath), alongsideSubDir(fileId, width, mediaFilePath)));
    for (const root of roots) {
        const manifest = await readManifestAt(root);
        if (manifest === undefined) continue;
        if ([manifest?.storageGeneration, manifest?.previousStorageGeneration].includes(generation))
            continue;
        await safeRm(join(root, generation), { recursive: true, force: true });
    }
}
async function readManifestAt(root: string): Promise<TrickplayManifest | null | undefined> {
    try {
        const manifest: unknown = JSON.parse(
            (
                await readContainedFile(join(root, 'manifest.json'), { maxBytes: 4 * 1024 * 1024 })
            ).toString(),
        );
        if (
            !manifest ||
            typeof manifest !== 'object' ||
            !('sheets' in manifest) ||
            !Array.isArray(manifest.sheets)
        )
            throw new Error('Invalid seek preview publication pointer');
        return manifest as TrickplayManifest;
    } catch (error) {
        if ((error as { code?: string } | null)?.code === 'ENOENT') return null;
        logger.warn('Could not verify seek preview publication; generation bytes retained', {
            root,
            error: String(error),
        });
        return undefined;
    }
}
async function pruneGenerations(
    root: string,
    manifest: TrickplayManifest | null | undefined,
    oldOnly: boolean,
    retiredGeneration?: string,
): Promise<number> {
    if (manifest === undefined) return 0;
    let cleaned = 0;
    const entries = await safeReaddir(root).catch(() => []);
    for (const entry of entries) {
        // Flat sheets were the previous publication during the first upgrade.
        // Once two generation publications exist they are older than recovery.
        if (
            !oldOnly &&
            manifest?.storageGeneration &&
            manifest.previousStorageGeneration &&
            entry.isFile() &&
            /^\d+\.webp$/.test(entry.name)
        ) {
            await safeUnlink(join(root, entry.name));
            continue;
        }
        if (
            !entry.isDirectory() ||
            !TRICKPLAY_FILE_ID_RE.test(entry.name) ||
            [manifest?.storageGeneration, manifest?.previousStorageGeneration].includes(entry.name)
        )
            continue;
        // A different active job may be writing an unpublished set. Only retire
        // the known older publication here; the age-gated sweep handles crashes.
        if (!oldOnly && entry.name !== retiredGeneration) continue;
        const path = join(root, entry.name);
        if (oldOnly) {
            const stat = await safeStat(path).catch(() => null);
            if (!stat || Date.now() - stat.mtimeMs < 3600000) continue;
        }
        await safeRm(path, { recursive: true, force: true });
        cleaned++;
    }
    return cleaned;
}

/**
 * Clean up orphaned trickplay artifacts — width directories that have sprite
 * sheets (.webp) but no manifest.json, indicating a crash mid-generation.
 * Returns the number of orphaned directories removed.
 */
export async function cleanupOrphanedTrickplay(): Promise<number> {
    const basePath = await getTrickplayBasePath();
    try {
        await safeAccess(basePath);
    } catch {
        return 0;
    }

    let cleaned = 0;
    try {
        const fileEntries = await safeReaddir(basePath);
        for (const fileEntry of fileEntries) {
            if (!fileEntry.isDirectory()) continue;
            const fileDir = join(basePath, fileEntry.name);
            const widthEntries = await safeReaddir(fileDir);

            for (const widthEntry of widthEntries) {
                if (!widthEntry.isDirectory()) continue;
                try {
                    const widthDir = join(fileDir, widthEntry.name);
                    const manifestPath = join(widthDir, 'manifest.json');
                    cleaned += await pruneGenerations(
                        widthDir,
                        await readManifestAt(widthDir),
                        true,
                    );

                    if (!(await safeExists(manifestPath))) {
                        // Has no manifest — orphaned partial generation
                        const files = (await safeReaddir(widthDir)).map((d) => d.name);
                        const hasSheets = files.some((f) => f.endsWith('.webp'));
                        if (hasSheets) {
                            // Only delete if files are older than 1 hour — this safety margin
                            // prevents deleting artifacts from concurrent generation in progress.
                            const firstSheet = files.find((f) => f.endsWith('.webp'));
                            if (firstSheet) {
                                const sheetStat = await safeStat(join(widthDir, firstSheet));
                                const ageMs = Date.now() - sheetStat.mtimeMs;
                                if (ageMs < 3_600_000) continue; // skip recently-written files
                            }
                            await safeRm(widthDir, {
                                recursive: true,
                                force: true,
                            });
                            cleaned++;
                            logger.info('Removed orphaned trickplay directory', {
                                fileId: fileEntry.name,
                                width: widthEntry.name,
                                orphanedFiles: files.length,
                            });
                        }
                    }
                } catch {
                    // Skip individual width directory errors, continue with remaining
                }
            }

            // If the file directory is now empty, remove it too
            try {
                const remaining = await safeReaddir(fileDir);
                if (remaining.length === 0) {
                    await safeRm(fileDir, { recursive: true, force: true });
                }
            } catch {
                // Skip parent cleanup errors
            }
        }
    } catch (error) {
        logger.error(
            'Failed to cleanup orphaned trickplay',
            error instanceof Error ? error : undefined,
        );
    }
    return cleaned;
}

export async function getTrickplayStats(): Promise<TrickplayStorageStats> {
    const basePath = await getTrickplayBasePath();

    let totalFiles = 0;
    let totalSizeBytes = 0;
    let fileCount = 0;

    try {
        await safeAccess(basePath);
    } catch {
        // best-effort: trickplay base dir absent → zero stats, nothing to scan.
        return { totalFiles, totalSizeBytes, fileCount };
    }

    try {
        const entries = await safeReaddir(basePath);

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            fileCount++;
            const dirStats = await collectDirectoryStats(join(basePath, entry.name));
            totalFiles += dirStats.totalFiles;
            totalSizeBytes += dirStats.totalSizeBytes;
        }
    } catch (error) {
        logger.error('Failed to get trickplay stats', error instanceof Error ? error : undefined);
    }

    return { totalFiles, totalSizeBytes, fileCount };
}

export async function getAvailableTrickplayWidths(
    fileId: string,
    mediaFilePath?: string | null,
): Promise<number[]> {
    const widths = new Set<number>();

    // Scan central location
    const basePath = await getTrickplayBasePath();
    await scanWidthDirs(join(basePath, fileId), fileId, mediaFilePath, widths);
    // Legacy _sources/ fallback
    await scanWidthDirs(join(basePath, '_sources', fileId), fileId, mediaFilePath, widths);

    // Scan alongside location
    if (mediaFilePath) {
        const alongsideDir = alongsideRootDir(fileId, mediaFilePath);
        await scanWidthDirs(alongsideDir, fileId, mediaFilePath, widths);
    }

    return [...widths].sort((a, b) => a - b);
}

async function scanWidthDirs(
    dir: string,
    fileId: string,
    mediaFilePath: string | null | undefined,
    widths: Set<number>,
): Promise<void> {
    if (!(await safeExists(dir))) return;
    try {
        const dirs = await safeReaddir(dir);
        for (const entry of dirs) {
            if (!entry.isDirectory()) continue;
            const width = parseInt(entry.name, 10);
            if (!isNaN(width) && !widths.has(width)) {
                const manifest = await getTrickplayManifest(fileId, width, mediaFilePath);
                if (manifest && manifest.sheets.length > 0) {
                    widths.add(width);
                }
            }
        }
    } catch {
        // Directory not readable — skip
    }
}

export async function getTrickplayInfos(
    fileId: string,
    mediaFilePath?: string | null,
): Promise<TrickplayInfo[]> {
    const widths = await getAvailableTrickplayWidths(fileId, mediaFilePath);
    const manifests = await Promise.all(
        widths.map((width) => getTrickplayManifest(fileId, width, mediaFilePath)),
    );

    return manifests
        .filter((manifest): manifest is TrickplayManifest => manifest !== null)
        .map((manifest) => ({
            width: manifest.width,
            height: manifest.height,
            tileWidth: manifest.tileWidth,
            tileHeight: manifest.tileHeight,
            thumbnailCount: manifest.thumbnailCount,
            interval: manifest.interval,
            bandwidth: 50000,
        }))
        .sort((a, b) => a.width - b.width);
}

/**
 * Get the best trickplay info for a media file.
 * Checks local Lumastra-generated trickplay first, then falls back to
 * provider plugins (e.g. Jellyfin-disk) via trickplayParamsService if
 * internalId is provided.
 */
export async function getBestTrickplayInfo(
    fileId: string,
    mediaFilePath?: string | null,
    internalId?: string,
): Promise<TrickplayInfo | null> {
    const infos = await getTrickplayInfos(fileId, mediaFilePath);
    if (infos.length > 0) {
        return infos.find((info) => info.width >= 320) ?? infos[infos.length - 1];
    }

    // Fallback: try provider plugins (e.g. Jellyfin-disk trickplay)
    if (internalId) {
        const { trickplayParamsService } = await import('./trickplay-params.service.js');
        return trickplayParamsService.getParams(internalId, undefined, {
            fileId,
        });
    }

    return null;
}

async function collectDirectoryStats(
    dirPath: string,
): Promise<{ totalFiles: number; totalSizeBytes: number }> {
    let totalFiles = 0;
    let totalSizeBytes = 0;

    // safeReaddir has no `recursive` option, so walk manually one level at a time.
    const entries = await safeReaddir(dirPath);

    for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
            const nested = await collectDirectoryStats(entryPath);
            totalFiles += nested.totalFiles;
            totalSizeBytes += nested.totalSizeBytes;
            continue;
        }
        if (!entry.isFile()) continue;
        totalFiles++;

        try {
            const fileStats = await safeStat(entryPath);
            totalSizeBytes += fileStats.size;
        } catch {
            // Ignore stat errors for files that disappear mid-scan.
        }
    }

    return { totalFiles, totalSizeBytes };
}
