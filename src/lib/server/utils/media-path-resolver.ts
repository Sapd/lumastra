// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Path Resolver for Local File Access
 *
 * Resolves provider media file paths to container-accessible paths.
 * Used by full mode FFmpeg transcoding to process video and audio from local files.
 */

import { constants as fsConstants } from 'fs';
import path from 'node:path';
import type { Sql } from 'postgres';
import { cacheManager, CACHE_NAMESPACES } from '../cache/index.js';
import { getEnabledLibraryPaths } from '../database/queries/library-paths.queries.js';
import {
    metadataCentralBaseDir,
    metadataCentralBaseDirCandidates,
} from '../services/metadata-storage.service.js';
import { Logger } from './logger.js';
import { safeStat, safeAccess, safeRealpath } from './safe-fs.js';

export interface ResolveMediaPathOptions {
    /**
     * @deprecated No-op — kept only so existing call sites don't need signature
     * changes. Historically gated an `isHybridAudioEnabled()`/`isLocalFileAccessEnabled()`
     * feature check that this option could bypass; that gate was removed when
     * hybrid mode was retired (local file access is now always enabled), so the
     * option no longer has anything to skip.
     *
     * NOTE: this must NOT be repurposed to skip `checkFileAccess()` below. Every
     * current call site passes `skipLocalAccessCheck: true` and relies on
     * `checkFileAccess()` actually running to get `isAccessible`/`fileSize`
     * (verified by grepping all ~15 call sites — streaming/HLS/subsonic/chapter-sync
     * all branch on `pathInfo.isAccessible` and several read `pathInfo.fileSize`).
     * Skipping the check when this is `true` would make every caller treat every
     * file as inaccessible.
     */
    skipLocalAccessCheck?: boolean;
}

const logger = Logger.for('MediaPathResolver');

interface MediaPathMapping {
    providerPath: string;
    containerPath: string;
}

/**
 * Get DB-backed library path mappings with a 5-minute in-memory cache.
 * Returns mappings sorted longest-prefix first to avoid /media matching before /media/movies.
 */
async function getLibraryPathMappings(sql: Sql): Promise<MediaPathMapping[]> {
    const cache = cacheManager.for(CACHE_NAMESPACES.libraryPathMappings);
    const cached = await cache.get<MediaPathMapping[]>('all');
    if (cached) return cached;

    const paths = await getEnabledLibraryPaths(sql);
    const mappings = paths
        .filter((p) => p.provider_path)
        .sort((a, b) => (b.provider_path?.length ?? 0) - (a.provider_path?.length ?? 0))
        .map((p) => ({
            providerPath: p.provider_path!,
            containerPath: p.path,
        }));

    await cache.set('all', mappings);
    return mappings;
}

export interface ResolvedMediaPath {
    /** Original path from the media provider (e.g. Jellyfin MediaSource.Path) */
    providerPath: string;
    /** Resolved path in container (may differ if path mapping configured) */
    containerPath: string;
    /** Whether the file is accessible (readable) */
    isAccessible: boolean;
    /** File size in bytes (if accessible) */
    fileSize?: number;
    /** Reason if not accessible */
    reason?: 'disabled' | 'not_found' | 'permission_denied' | 'not_file' | 'error';
}

/**
 * Resolve a provider media path to a container-accessible path.
 *
 * Path resolution order:
 * 1. Check if provider path is directly accessible (same mount points)
 * 2. Apply DB-backed library path mappings (if sql provided, longest prefix first)
 * 3. Return inaccessible if no path works
 *
 * @param providerPath - The MediaSource.Path from the media provider API
 * @param options - Optional settings to control resolution behavior
 * @param sql - Optional postgres connection for DB-backed library path mappings
 * @returns Resolved path info, or null if path is empty/undefined
 */
export async function resolveMediaPath(
    providerPath: string | undefined | null,
    options?: ResolveMediaPathOptions,
    sql?: Sql,
): Promise<ResolvedMediaPath | null> {
    // No path provided
    if (!providerPath) {
        return null;
    }

    // First, try the provider path directly
    // This works when container mounts match the provider's internal paths
    // (e.g., both use /data/movies)
    const directResult = await checkFileAccess(providerPath);
    if (directResult.isAccessible) {
        logger.debug('Media file accessible at provider path', {
            path: providerPath,
            fileSize: directResult.fileSize,
        });
        return {
            providerPath,
            containerPath: providerPath,
            isAccessible: true,
            fileSize: directResult.fileSize,
        };
    }

    // Apply DB-backed library path mappings (most-specific prefix first)
    if (sql) {
        const dbMappings = await getLibraryPathMappings(sql);
        for (const mapping of dbMappings) {
            if (providerPath.startsWith(mapping.providerPath)) {
                const containerPath = providerPath.replace(
                    mapping.providerPath,
                    mapping.containerPath,
                );

                const mappedResult = await checkFileAccess(containerPath);
                if (mappedResult.isAccessible) {
                    logger.debug('Media file accessible via DB library path mapping', {
                        providerPath,
                        containerPath,
                        mapping: `${mapping.providerPath} -> ${mapping.containerPath}`,
                        fileSize: mappedResult.fileSize,
                    });
                    return {
                        providerPath,
                        containerPath,
                        isAccessible: true,
                        fileSize: mappedResult.fileSize,
                    };
                }

                logger.debug('DB library path mapping resulted in inaccessible path', {
                    providerPath,
                    containerPath,
                    reason: mappedResult.reason,
                });
            }
        }
    }

    // File not accessible
    logger.debug('Media file not accessible locally', {
        providerPath,
        dbMappingsChecked: sql ? 'yes' : 'no',
        directAccessReason: directResult.reason,
    });

    return {
        providerPath,
        containerPath: providerPath,
        isAccessible: false,
        reason: directResult.reason,
    };
}

/**
 * Fetch all enabled library root paths from DB, with a 60-second in-process cache.
 *
 * Returns both the container-side `path` and the provider-side `provider_path`
 * (when set) of each enabled library. A media file can be served either directly
 * at its provider path (when container mounts match) or via a container mapping,
 * so a containment check must trust both prefixes — otherwise a legitimately
 * directly-accessible file whose path sits under `provider_path` (but not the
 * container `path`) would be wrongly rejected.
 */
async function getLibraryRootPaths(sql: Sql): Promise<string[]> {
    const cache = cacheManager.for(CACHE_NAMESPACES.libraryRoots);
    const cached = await cache.get<string[]>('all');
    if (cached) return cached;

    const rows = await getEnabledLibraryPaths(sql);
    const roots = rows.flatMap((r) => (r.provider_path ? [r.path, r.provider_path] : [r.path]));
    await cache.set('all', roots);
    return roots;
}

/**
 * Verify that `targetPath` is contained within at least one configured library root.
 *
 * Defense-in-depth: even if a DB row is tampered with, file reads are sandboxed to
 * operator-configured library directories.
 *
 * FAIL-CLOSED: when no roots are configured (fresh install / dev / misconfiguration)
 * this returns `false`. There is no library media to serve in that state anyway, so
 * denying is correct — and an earlier `true`-on-zero-roots made this containment guard
 * a no-op exactly when the operator had configured no sandbox. Callers that legitimately
 * serve files outside the library tree (e.g. metadata-store artwork/subtitles) must add
 * their own allow-list branch — see {@link isPathWithinMediaStore}.
 */
export async function isPathWithinLibraryRoots(sql: Sql, targetPath: string): Promise<boolean> {
    const roots = await getLibraryRootPaths(sql);
    if (roots.length === 0) return false;
    return roots.some((root) => isPathWithin(targetPath, root));
}

/**
 * Absolute path of the metadata store (downloaded artwork, fetched external
 * subtitles, etc.). Mirrors the custom-image handler's `metadataDir` derivation.
 */
export function getMetadataDir(): string {
    return path.join(metadataCentralBaseDir(), '.metadata');
}

/**
 * Every metadata store this install may legitimately read from — the current one
 * plus the legacy `/data/.metadata` root. Containment must accept both, or an
 * install that materialized artwork under the old fallback would stop being
 * allowed to serve it the moment the default moved.
 */
function getMetadataDirCandidates(): string[] {
    return metadataCentralBaseDirCandidates().map((base) => path.join(base, '.metadata'));
}

/**
 * Containment check for files the app legitimately reads from EITHER the metadata
 * store OR a configured library root. Use this (instead of {@link isPathWithinLibraryRoots}
 * alone) for assets that can live in the metadata store — notably fetched external
 * subtitles — so the fail-closed library-root guard doesn't wrongly block them on
 * installs whose subtitles were downloaded into the metadata store.
 */
export async function isPathWithinMediaStore(sql: Sql, targetPath: string): Promise<boolean> {
    if (getMetadataDirCandidates().some((dir) => isPathWithin(targetPath, dir))) return true;
    return isPathWithinLibraryRoots(sql, targetPath);
}

/**
 * Check an already-resolved file against the real targets of operator-configured
 * roots. Resolve the roots themselves, never a child directory: a symlinked
 * library mount is legitimate, but a child link outside that mount is not.
 */
export async function isResolvedPathWithinMediaStore(
    sql: Sql,
    targetPath: string,
    extraRoots: readonly string[] = [],
): Promise<boolean> {
    return (await findResolvedMediaStoreRoot(sql, targetPath, extraRoots)) !== null;
}

/** Return the matching canonical root so descriptor validation needs no I/O. */
export async function findResolvedMediaStoreRoot(
    sql: Sql,
    targetPath: string,
    extraRoots: readonly string[] = [],
): Promise<string | null> {
    const cache = cacheManager.for(CACHE_NAMESPACES.libraryRoots);
    const withinRoots = async (roots: readonly string[]): Promise<string | null> => {
        for (const root of roots) {
            const key = `realpath:${path.resolve(root)}`;
            let canonical = await cache.get<{ path: string | null }>(key);
            if (!canonical) {
                let real: string | null = null;
                try {
                    real = await safeRealpath(root);
                } catch {
                    // Missing/unmounted stores cannot authorize a resolved file.
                }
                canonical = { path: real };
                // Same bounded L1-only 60s TTL and namespace invalidation as the
                // configured root list. Cache misses too (e.g. legacy /data).
                await cache.set(key, canonical);
            }
            if (canonical.path && isPathWithin(targetPath, canonical.path)) return canonical.path;
        }
        return null;
    };
    // A managed image needs neither a DB lookup nor NFS library-root realpaths.
    const managedRoot = await withinRoots([...getMetadataDirCandidates(), ...extraRoots]);
    if (managedRoot) return managedRoot;
    return withinRoots(await getLibraryRootPaths(sql));
}

/**
 * True when `targetPath` resolves to `rootDir` itself or a descendant of it.
 *
 * Resolves both paths first (collapsing `..`) and compares on a path-separator
 * boundary so a sibling sharing a string prefix (`/a/image-sync-evil` vs
 * `/a/image-sync`) is NOT considered inside. Pure and synchronous so it can
 * guard hot serving paths without a DB round-trip.
 */
export function isPathWithin(targetPath: string, rootDir: string): boolean {
    const resolved = path.resolve(targetPath);
    const r = path.resolve(rootDir);
    return resolved === r || resolved.startsWith(r + path.sep);
}

interface FileAccessResult {
    isAccessible: boolean;
    fileSize?: number;
    reason?: 'not_found' | 'permission_denied' | 'not_file' | 'error';
}

/**
 * Check if a file path is accessible for reading.
 */
async function checkFileAccess(filePath: string): Promise<FileAccessResult> {
    try {
        const stats = await safeStat(filePath);

        if (!stats.isFile()) {
            return { isAccessible: false, reason: 'not_file' };
        }

        // Also verify we can actually read it
        await safeAccess(filePath, fsConstants.R_OK);

        return {
            isAccessible: true,
            fileSize: stats.size,
        };
    } catch (error) {
        const err = error as { code?: string };

        if (err.code === 'ENOENT') {
            return { isAccessible: false, reason: 'not_found' };
        }
        if (err.code === 'EACCES' || err.code === 'EPERM') {
            return { isAccessible: false, reason: 'permission_denied' };
        }

        return { isAccessible: false, reason: 'error' };
    }
}
