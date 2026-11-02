// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Metadata Storage Service
 *
 * Unified strategy for resolving where persistent metadata files are stored.
 * Controlled by the METADATA_STORAGE_LOCATION config setting:
 *   - 'central'          — write to a central config directory only
 *   - 'alongside'        — write next to the media file only (fails if not writable)
 *   - 'alongside-prefer' — try alongside first, fall back to central
 *
 * Reads ALWAYS probe both locations regardless of the write setting, so changing
 * the strategy never orphans existing data.
 */

import { config } from '$lib/server/config.js';
import { constants } from 'fs';
import { dirname, join } from 'path';
import { Logger } from '$lib/server/utils/logger.js';
import { safeExists, safeMkdir, safeAccess } from '$lib/server/utils/safe-fs.js';

const logger = Logger.for('MetadataStorage');

export type StorageStrategy = 'central' | 'alongside' | 'alongside-prefer';

const VALID_STRATEGIES = new Set<StorageStrategy>(['central', 'alongside', 'alongside-prefer']);

function getStrategy(): StorageStrategy {
    const value = config.METADATA_STORAGE_LOCATION;
    if (VALID_STRATEGIES.has(value)) return value;
    logger.warn(`Invalid METADATA_STORAGE_LOCATION "${value}", falling back to "central"`);
    return 'central';
}

/**
 * Root under which every `centralDir` is built. Feature-specific central paths
 * hang off this (e.g. artwork uses `<base>/.metadata/<mediaItemId>`).
 *
 * THE single source of truth. Three call sites used to derive this independently
 * (`media-image-storage.service.ts`, `media-path-resolver.getMetadataDir`,
 * `artwork-volume-headroom.collectArtworkTargetVolumes`) and they must never
 * disagree: one decides where central metadata is WRITTEN, one gates whether the
 * app is allowed to SERVE a file from there (`isPathWithinMediaStore`), and one
 * picks which filesystem the disk-headroom guard MEASURES. A split between them
 * means the app refuses to serve the files it just wrote, or guards free space on
 * the wrong volume.
 *
 * The base rather than a leaf because central dirs are created with `mkdir -p` —
 * the permission that matters is write access on this root.
 *
 * ## Why the fallback is '/config' and not '/data'
 *
 * `docker-compose.example.yml:54` sets `BASE_PATH: '/config'` ("Must match the
 * config volume mount below"), and mounts media READ-ONLY under `/data/*`
 * (`:309`, `- /path/to/music:/data/music:ro`). So `/config` is the documented
 * persistent app volume and `/data` is the media root — app-managed state was
 * never meant to live there. The old '/data' fallback contradicted the project's
 * own reference deployment, and on any install that omitted BASE_PATH it resolved
 * to a directory that is typically (a) owned by root while the app runs as uid
 * 1000 and (b) not a mounted volume at all, so it is ALSO wiped on redeploy.
 * Observed in prod 2026-07-30: every artwork item with no derivable "alongside"
 * folder failed `mkdir` and dead-lettered as `write-path-failed`.
 *
 * Deliberately NOT resolved by probing candidate roots for writability: a storage
 * location that depends on a runtime probe can move between restarts and split one
 * library's artwork across two roots. It must be deterministic.
 *
 * Existing files are not orphaned by the changed default: `media_artwork` stores
 * ABSOLUTE `file_path` values, so already-materialized artwork is read by its
 * stored path. Only NEW writes land under the new root. See
 * {@link LEGACY_METADATA_CENTRAL_BASE_DIR} for the containment/classification half.
 */
export function metadataCentralBaseDir(): string {
    return config.BASE_PATH || '/config';
}

/**
 * The pre-2026-07-30 fallback root, still honoured by READ-side containment and
 * "is this file ours?" classification so an install that already materialized
 * artwork under `/data/.metadata` keeps serving it.
 *
 * Only meaningful when `BASE_PATH` is unset — an install with an explicit
 * `BASE_PATH` was never affected by the fallback change, so its base is unchanged.
 */
export const LEGACY_METADATA_CENTRAL_BASE_DIR = '/data';

/**
 * Every root that may legitimately hold central metadata for this install: the
 * current one first, plus the legacy one when the fallback is in play.
 *
 * Use for READ paths and containment checks. Never for writes — writes go to
 * {@link metadataCentralBaseDir} alone.
 */
export function metadataCentralBaseDirCandidates(): string[] {
    const current = metadataCentralBaseDir();
    return current === LEGACY_METADATA_CENTRAL_BASE_DIR
        ? [current]
        : [current, LEGACY_METADATA_CENTRAL_BASE_DIR];
}

/**
 * Check whether a directory is writable.
 * If the directory doesn't exist, attempts to create it (recursive).
 */
async function isWritable(dir: string): Promise<boolean> {
    try {
        if (!(await safeExists(dir))) {
            await safeMkdir(dir, { recursive: true });
        }
        await safeAccess(dir, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Write-path resolution
// ---------------------------------------------------------------------------

export interface WritePathOptions {
    /** Absolute path to the media file (video/audio). Used to derive the alongside directory. */
    mediaFilePath: string | null;
    /**
     * Absolute directory to use as the alongside location, overriding
     * `dirname(mediaFilePath)`. For container rows (artist, series, album,
     * season) there is no file to sit next to — only a folder — so callers
     * resolve that folder themselves and pass it here.
     */
    mediaDirPath?: string | null;
    /** Central directory for this feature (e.g. '/config/trickplay/{id}'). */
    centralDir: string;
    /** Filename or sub-path within the target directory. */
    fileName: string;
    /** Sub-directory relative to the media file directory (optional, e.g. '.trickplay'). */
    alongsideSubDir?: string;
    /**
     * Per-feature strategy override. When provided, this strategy is used instead
     * of the global METADATA_STORAGE_LOCATION, letting a single feature (e.g.
     * trickplay) diverge from the global default. Omit to inherit the global.
     */
    strategyOverride?: StorageStrategy;
}

export interface WritePathResult {
    /** The resolved absolute file path to write to. */
    filePath: string;
    /** Which strategy was actually used. */
    location: 'central' | 'alongside';
}

/**
 * Resolve the write path for a metadata file according to the configured strategy.
 *
 * Throws if the strategy is 'alongside' and the media directory is not writable,
 * or if no mediaFilePath is provided for alongside strategies.
 */
export async function resolveWritePath(opts: WritePathOptions): Promise<WritePathResult> {
    const strategy = opts.strategyOverride ?? getStrategy();

    if (strategy === 'central') {
        await safeMkdir(opts.centralDir, { recursive: true });
        return {
            filePath: join(opts.centralDir, opts.fileName),
            location: 'central',
        };
    }

    // 'alongside' or 'alongside-prefer'
    // An explicit mediaDirPath (container folder) stands in for the file's own
    // directory — a container has no file to sit next to, only a folder.
    const mediaDir = opts.mediaDirPath ?? (opts.mediaFilePath ? dirname(opts.mediaFilePath) : null);

    if (!mediaDir) {
        if (strategy === 'alongside') {
            throw new Error(
                'METADATA_STORAGE_LOCATION is "alongside" but no media file path is available',
            );
        }
        // alongside-prefer: fall back to central
        await safeMkdir(opts.centralDir, { recursive: true });
        return {
            filePath: join(opts.centralDir, opts.fileName),
            location: 'central',
        };
    }

    const alongsideDir = opts.alongsideSubDir ? join(mediaDir, opts.alongsideSubDir) : mediaDir;

    if (await isWritable(alongsideDir)) {
        return {
            filePath: join(alongsideDir, opts.fileName),
            location: 'alongside',
        };
    }

    if (strategy === 'alongside') {
        throw new Error(
            `METADATA_STORAGE_LOCATION is "alongside" but directory is not writable: ${alongsideDir}`,
        );
    }

    // alongside-prefer: fall back to central
    logger.info('Media directory not writable, falling back to central', {
        alongsideDir,
    });
    await safeMkdir(opts.centralDir, { recursive: true });
    return {
        filePath: join(opts.centralDir, opts.fileName),
        location: 'central',
    };
}

// ---------------------------------------------------------------------------
// Read-path resolution (dual probe)
// ---------------------------------------------------------------------------

export interface ReadPathOptions {
    /** Absolute path to the media file. Used to derive the alongside directory. */
    mediaFilePath: string | null;
    /** Central directory for this feature. */
    centralDir: string;
    /** Filename or sub-path within the target directory. */
    fileName: string;
    /** Sub-directory relative to the media file directory (optional). */
    alongsideSubDir?: string;
    /**
     * Per-feature strategy override (see WritePathOptions). Reads probe BOTH
     * locations regardless; this only controls which is checked first so the
     * "preferred" location wins when a file exists in both.
     */
    strategyOverride?: StorageStrategy;
}

/**
 * Probe both central and alongside locations for an existing file.
 * Returns the first path that exists, or null if not found.
 *
 * The probe order matches the configured strategy so the "preferred" location
 * wins when both exist:
 *   - central           → check central first, then alongside
 *   - alongside         → check alongside first, then central
 *   - alongside-prefer  → check alongside first, then central
 */
export async function resolveReadPath(opts: ReadPathOptions): Promise<string | null> {
    const strategy = opts.strategyOverride ?? getStrategy();
    const centralPath = join(opts.centralDir, opts.fileName);

    let alongsidePath: string | null = null;
    if (opts.mediaFilePath) {
        const mediaDir = dirname(opts.mediaFilePath);
        const alongsideDir = opts.alongsideSubDir ? join(mediaDir, opts.alongsideSubDir) : mediaDir;
        alongsidePath = join(alongsideDir, opts.fileName);
    }

    // safeExists (not existsSync): the alongside path lives next to the media file
    // on the (possibly NFS) library mount — a synchronous existsSync there blocks
    // the event loop if the mount stalls.
    if (strategy === 'central') {
        if (await safeExists(centralPath)) return centralPath;
        if (alongsidePath && (await safeExists(alongsidePath))) return alongsidePath;
    } else {
        // alongside or alongside-prefer
        if (alongsidePath && (await safeExists(alongsidePath))) return alongsidePath;
        if (await safeExists(centralPath)) return centralPath;
    }

    return null;
}

/**
 * Check whether a metadata file exists in either location.
 */
export async function metadataFileExists(opts: ReadPathOptions): Promise<boolean> {
    return (await resolveReadPath(opts)) !== null;
}
