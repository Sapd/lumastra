// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Image Scanner Service
 *
 * Scans media folders for image files and matches them to episodes/seasons
 * based on filename patterns like:
 * - S01E01-backdrop.jpg, 1x01-poster.jpg (episode-specific)
 * - season1-backdrop.jpg, Season 01/poster.jpg (season-specific)
 *
 * Supports configurable patterns from settings, multiple scopes, and plan/dry-run mode.
 */

import { buildPatterns, parseEpisodeNumbers } from '../utils/image-scan-patterns.js';
import { ownsEpisodeThumb } from '../utils/episode-thumbnail-ownership.js';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { upsertLocalArtwork } from '$lib/server/database/queries/media-artwork.queries.js';
import {
    findEpisodeByNumbers,
    findSeasonByNumber,
    getSeriesFilePaths,
    getEpisodeFilePaths,
    getMediaFilePaths,
    getImageScanTarget,
} from '$lib/server/database/queries/image-sync.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { parseMediaFilename } from '$lib/server/utils/filename-parser.js';
import { safeReaddir } from '$lib/server/utils/safe-fs.js';
import { basename, join, extname } from 'path';

const logger = Logger.for('ImageScannerService');

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
const ARTWORK_TYPES = ['backdrop', 'poster', 'logo', 'thumb', 'banner'] as const;

const SPECIAL_FILENAME_MAP: Record<string, ArtworkType> = {
    'folder.jpg': 'poster',
    'folder.jpeg': 'poster',
    'landscape.jpg': 'backdrop',
    'landscape.jpeg': 'backdrop',
};

type ArtworkType = (typeof ARTWORK_TYPES)[number];

export type ScanScope = 'series' | 'season' | 'episode';
export type ScanMode = 'execute' | 'plan';

export interface ScanOptions {
    scope: ScanScope;
    mediaItemId?: string;
    mode: ScanMode;
    seriesMediaId?: string;
    seasonMediaId?: string;
    onProgress?: (processed: number, total: number) => void;
    /**
     * When set, the scan checks `.aborted` between directories AND between
     * images within a directory, then returns whatever has been written so
     * far. Wired by the image-sync task wrapper to ctx.signal so admin
     * Cancel halts a scan promptly instead of continuing to scan/store
     * hundreds of images.
     */
    signal?: AbortSignal;
    /**
     * Called once per unique media item UUID after at least one of its artwork
     * files is successfully stored. Fired only in execute mode. Used by the
     * task wrapper to write coverage-table rows so the sweep path keeps
     * `media_item_stage_state` up-to-date.
     * Non-fatal if it throws — the sweep continues regardless.
     */
    onItemSuccess?: (mediaItemId: string) => Promise<void>;
}

interface ScannedImage {
    filePath: string;
    artworkType: ArtworkType;
    seasonNumber?: number;
    episodeNumber?: number;
}

function parseArtworkType(filename: string): ArtworkType | null {
    const lower = filename.toLowerCase();

    const specialType = SPECIAL_FILENAME_MAP[lower];
    if (specialType) {
        return specialType;
    }

    for (const type of ARTWORK_TYPES) {
        if (lower.includes(type)) {
            return type;
        }
    }
    return null;
}

/**
 * Last-resort season/episode extraction for release-style artwork names, where
 * the artwork type is NOT adjacent to the episode number
 * ("S01E20 - Title - WEBRip-1080p-thumb.jpg") so none of the anchored patterns
 * above can match. In practice this is the path EVERY episode thumbnail takes:
 * the shipped IMAGE_SYNC_LOCAL_PATTERNS default defines backdrop/poster forms
 * only, so a `-thumb` file never matches a configured pattern.
 *
 * Delegates to `parseMediaFilename`, the scanner used for video files. This
 * module previously hand-rolled its own SxxExx regex here, and the two drifted:
 * the copy capped the episode at two digits, so "S01E293" resolved to episode
 * 29. Episodes >= 100 could then never be matched to their own artwork, the
 * duplicate-thumbnail fingerprint never cleared, and the retired episode-thumbnail-repair task
 * re-enqueued those series indefinitely (see the 2026-07-20 investigation).
 *
 * Delegating also inherits guards this module never had — notably that
 * "1920x1080-thumb.jpg" and "16x9-poster.jpg" are NOT read as season×episode.
 * Artwork filenames are release names with an artwork-type suffix, so the video
 * parser's rules apply unchanged; the suffix is ignored by it.
 */
function parseBroadEpisodeNumbers(
    filename: string,
): { seasonNumber: number; episodeNumber: number } | null {
    const parsed = parseMediaFilename(filename);
    if (parsed.season === undefined || parsed.episodeStart === undefined) return null;

    return { seasonNumber: parsed.season, episodeNumber: parsed.episodeStart };
}

/**
 * Single place where "what season/episode does this artwork file belong to?"
 * is decided, for every scan scope.
 *
 * Configured patterns win when they matched during the directory walk —
 * operator intent is explicit. Otherwise fall back to the release-name parser,
 * which is what handles Sonarr/Radarr layouts.
 *
 * Every scan path routing through here is the point: two scan paths once
 * disagreed about identical filenames, and that disagreement is what let the
 * duplicate-thumbnail bug persist for so long.
 *
 * @param allowReleaseNames when false, only pattern-matched numbers count.
 */
function resolveEffectiveNumbers(
    filePath: string,
    seasonNumber: number | undefined,
    episodeNumber: number | undefined,
    allowReleaseNames: boolean,
): { effSeasonNumber?: number; effEpisodeNumber?: number } {
    if (seasonNumber !== undefined && episodeNumber !== undefined) {
        return { effSeasonNumber: seasonNumber, effEpisodeNumber: episodeNumber };
    }
    if (!allowReleaseNames) {
        return { effSeasonNumber: seasonNumber, effEpisodeNumber: episodeNumber };
    }

    const fname = filePath.split('/').pop() ?? '';
    const broad = parseBroadEpisodeNumbers(fname);
    if (!broad) return { effSeasonNumber: seasonNumber, effEpisodeNumber: episodeNumber };

    return { effSeasonNumber: broad.seasonNumber, effEpisodeNumber: broad.episodeNumber };
}

/** The anchor of a targeted (episode/season) scan, as {@link isTargetsOwnImage} needs it. */
interface ImageScanTarget {
    id: string;
    mediaType: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    /** The target's own video files — an episode's sidecars are named after them. */
    videoPaths: readonly string[];
}

/**
 * May a targeted scan attach this image to its anchor item?
 *
 * An episode- or season-scope scan walks the FOLDER, and that folder is shared:
 * every sibling episode's `-thumb.jpg`, the season's `poster.jpg`, stale
 * sidecars of replaced releases. This scan used to attach every one of them to
 * the anchor, each re-pointing the item's single local row, so the anchor ended
 * up on whichever file readdir returned last. That is how new episodes kept
 * getting a SIBLING's thumbnail (all twelve episodes of a season on E12's;
 * S13E01 on a stale S13E03 WEBDL sidecar) for the retired episode-thumbnail-repair task to
 * re-point afterwards — the per-item image-sync stage runs this scope for
 * every new episode.
 *
 * Episode thumbnails require an actual video sidecar, an owner-ID filename,
 * or an explicit episode-number artwork pattern in the video's directory.
 * Matching a release's episode number alone cannot establish thumb ownership:
 * obsolete releases still name the same episode. Other artwork can fall back
 * to release-number matching. A file with no episode belongs to its container.
 * A season owns what does not name an episode or a different season. Other
 * targets (a movie folder) own everything, as before.
 */
function isTargetsOwnImage(image: ScannedImage, target: ImageScanTarget): boolean {
    const { effSeasonNumber, effEpisodeNumber } = resolveEffectiveNumbers(
        image.filePath,
        image.seasonNumber,
        image.episodeNumber,
        true,
    );

    if (target.mediaType === 'season') {
        if (effEpisodeNumber !== undefined) return false;
        return effSeasonNumber === undefined || effSeasonNumber === target.seasonNumber;
    }
    if (target.mediaType !== 'episode') return true;
    if (image.artworkType === 'thumb') {
        return ownsEpisodeThumb(image.filePath, target.videoPaths, target.id, {
            seasonNumber: target.seasonNumber,
            episodeNumber: target.episodeNumber,
            patterns: buildPatterns(config.IMAGE_SYNC_LOCAL_PATTERNS).episode,
        });
    }

    const imageStem = basename(image.filePath, extname(image.filePath)).toLowerCase();
    if (imageStem.endsWith(`-${target.id.slice(0, 8).toLowerCase()}-${image.artworkType}`))
        return true;
    for (const videoPath of target.videoPaths) {
        const videoStem = basename(videoPath, extname(videoPath)).toLowerCase();
        if (imageStem.startsWith(videoStem) && /^[-.]/.test(imageStem.slice(videoStem.length))) {
            return true;
        }
    }

    return (
        effSeasonNumber !== undefined &&
        effEpisodeNumber !== undefined &&
        effSeasonNumber === target.seasonNumber &&
        effEpisodeNumber === target.episodeNumber
    );
}

function parseSeasonNumber(filename: string, patterns: RegExp[]): number | null {
    for (const pattern of patterns) {
        const match = filename.match(pattern);
        if (match) {
            const seasonNumber = parseInt(match[1], 10);
            if (Number.isNaN(seasonNumber)) continue;
            return seasonNumber;
        }
    }
    return null;
}

export { ARTWORK_TYPES };
export type { ArtworkType, ImageScanTarget };
export {
    buildPatterns,
    isTargetsOwnImage,
    parseArtworkType,
    parseEpisodeNumbers,
    parseBroadEpisodeNumbers,
    parseSeasonNumber,
    resolveEffectiveNumbers,
};

function isImageFile(filename: string): boolean {
    const ext = extname(filename).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

async function scanDirectory(
    dirPath: string,
    depth: number = 0,
    maxDepth: number = 10,
    patterns?: { episode: RegExp[]; season: RegExp[] },
): Promise<ScannedImage[]> {
    const images: ScannedImage[] = [];
    const defaultPatterns = buildPatterns([]);
    const epPatterns = patterns?.episode ?? defaultPatterns.episode;
    const sePatterns = patterns?.season ?? defaultPatterns.season;

    if (depth > maxDepth) return images;

    try {
        const entries = await safeReaddir(dirPath);

        for (const entry of entries) {
            const fullPath = join(dirPath, entry.name);

            if (entry.isDirectory()) {
                const subImages = await scanDirectory(fullPath, depth + 1, maxDepth, patterns);
                images.push(...subImages);
            } else if (entry.isFile() && isImageFile(entry.name)) {
                const artworkType = parseArtworkType(entry.name);
                if (!artworkType) continue;

                const episodeMatch = parseEpisodeNumbers(entry.name, epPatterns);
                if (episodeMatch) {
                    images.push({
                        filePath: fullPath,
                        artworkType,
                        seasonNumber: episodeMatch.seasonNumber,
                        episodeNumber: episodeMatch.episodeNumber,
                    });
                    continue;
                }

                const seasonMatch = parseSeasonNumber(entry.name, sePatterns);
                if (seasonMatch !== null) {
                    images.push({
                        filePath: fullPath,
                        artworkType,
                        seasonNumber: seasonMatch,
                    });
                    continue;
                }

                // Also add images without episode/season in name (e.g., backdrop.jpg in series root)
                images.push({
                    filePath: fullPath,
                    artworkType,
                });
            }
        }
    } catch (err) {
        logger.warn('Failed to scan directory', { dirPath, error: err });
    }

    return images;
}

export interface ImageScannerResult {
    scanned: number;
    matched: number;
    stored: number;
    errors: number;
}

export interface ImageScanMatch {
    filePath: string;
    artworkType: ArtworkType;
    targetMediaId: string;
    seasonNumber?: number;
    episodeNumber?: number;
}

async function loadImageScanTarget(
    sql: postgres.Sql,
    id: string,
    videoPaths: readonly string[],
): Promise<ImageScanTarget | null> {
    const row = await getImageScanTarget(sql, id);
    if (!row) return null;
    return {
        id,
        mediaType: row.media_type,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
        videoPaths,
    };
}

export async function scanImages(
    sql: postgres.Sql,
    options: ScanOptions,
): Promise<ImageScannerResult> {
    const {
        scope,
        mode = 'execute',
        mediaItemId,
        seriesMediaId,
        seasonMediaId,
        onProgress,
        signal,
        onItemSuccess,
    } = options;

    // Tracks items already notified so onItemSuccess fires at most once per
    // unique media_item UUID per sweep invocation.
    const notifiedItems = new Set<string>();

    const enabled = config.IMAGE_SYNC_LOCAL_FILE_SCANNING;
    logger.info('Image sync config', {
        enabled,
        IMAGE_SYNC_LOCAL_FILE_SCANNING: config.IMAGE_SYNC_LOCAL_FILE_SCANNING,
    });
    if (!enabled) {
        logger.info('Local file scanning is disabled in settings');
        return { scanned: 0, matched: 0, stored: 0, errors: 0 };
    }

    const patternStrings = config.IMAGE_SYNC_LOCAL_PATTERNS;
    const patterns = buildPatterns(patternStrings);

    const result: ImageScannerResult = {
        scanned: 0,
        matched: 0,
        stored: 0,
        errors: 0,
    };

    let directories: string[] = [];
    let targetMediaId: string | null = mediaItemId ?? null;
    // Set for the folder-anchored scopes (season, episode): the folder they walk
    // is shared with siblings, so each image must prove it is the anchor's own.
    let scanTarget: ImageScanTarget | null = null;

    if (scope === 'series' && seriesMediaId) {
        targetMediaId = seriesMediaId;

        const filePaths = await getSeriesFilePaths(sql, seriesMediaId);
        const fileToUse = filePaths.direct ?? filePaths.episode;
        if (fileToUse) {
            const lastSlash = fileToUse.lastIndexOf('/');
            const seriesFolder = fileToUse.substring(0, lastSlash);
            directories.push(seriesFolder);

            // Add series root for backdrop.jpg etc
            const rootFolder = seriesFolder.split('/Season')[0].split('/season')[0];
            directories.push(rootFolder);

            logger.info('Series folder from media file', {
                seriesFolder,
                rootFolder,
            });
        }
    } else if (scope === 'season' && seasonMediaId) {
        targetMediaId = seasonMediaId;
        scanTarget = await loadImageScanTarget(sql, seasonMediaId, []);
        const episodeFiles = await getEpisodeFilePaths(sql, seasonMediaId);
        directories = [
            ...new Set(
                episodeFiles
                    .map((fp) => fp.substring(0, fp.lastIndexOf('/')) ?? '')
                    .filter(Boolean),
            ),
        ];
    } else if (scope === 'episode' && mediaItemId) {
        const filePaths = await getMediaFilePaths(sql, mediaItemId);
        scanTarget = await loadImageScanTarget(sql, mediaItemId, filePaths);
        if (filePaths[0]) {
            directories = [filePaths[0].substring(0, filePaths[0].lastIndexOf('/'))];
        }
    }

    logger.info('Starting image scan', {
        scope,
        mode,
        directories: directories.length,
        directoryPaths: directories.slice(0, 5),
        targetMediaId,
    });

    let processedDirs = 0;
    const totalDirs = directories.length;

    for (const dirPath of directories) {
        // Library-wide sweeps can iterate hundreds of directories — exit
        // promptly on admin Cancel rather than continuing the sweep.
        if (signal?.aborted) break;
        try {
            const images = await scanDirectory(dirPath, 0, 3, patterns);
            result.scanned += images.length;

            for (const image of images) {
                // Per-image check so abort propagates inside a busy
                // directory (large series with hundreds of episode JPGs).
                if (signal?.aborted) break;
                try {
                    const { seasonNumber, episodeNumber, artworkType, filePath } = image;

                    if (scanTarget && !isTargetsOwnImage(image, scanTarget)) {
                        // A sibling's file in the shared folder — not an error.
                        logger.debug('Skipping image that belongs to another item', {
                            filePath,
                            targetMediaId,
                        });
                        continue;
                    }

                    let matchMediaId: string | null = targetMediaId;

                    if (scope === 'series' && seriesMediaId) {
                        // Series-scope scan: images with episode/season numbers must be
                        // matched to the specific episode/season, not left at the series
                        // level. Without this, episode thumbnail JPGs (e.g. S01E20-thumb.jpg)
                        // get stored as series-level artwork and propagate to all episodes
                        // via the getLocalArtwork parent-chain CTE.
                        //
                        // Standard patterns require the artwork type directly after the
                        // episode number (e.g. S01E20-thumb.jpg). Sonarr-style names like
                        // "S01E20 - Title - WEBRip-1080p-thumb.jpg" have extra tokens in
                        // between, so we fall back to the release-name parser.
                        //
                        // Always enabled here: series-scope scans have resolved these
                        // names since c5736fa4e, and the repair task depends on it.
                        const { effSeasonNumber, effEpisodeNumber } = resolveEffectiveNumbers(
                            filePath,
                            seasonNumber,
                            episodeNumber,
                            true,
                        );

                        if (effEpisodeNumber !== undefined && effSeasonNumber !== undefined) {
                            const episodeId = await findEpisodeByNumbers(
                                sql,
                                seriesMediaId,
                                effSeasonNumber,
                                effEpisodeNumber,
                            );
                            // If the filename has episode numbers but no DB match, skip
                            // rather than storing at the series level.
                            matchMediaId = episodeId ?? null;
                        } else if (effSeasonNumber !== undefined) {
                            const seasonId = await findSeasonByNumber(
                                sql,
                                seriesMediaId,
                                effSeasonNumber,
                            );
                            matchMediaId = seasonId ?? null;
                        }
                    }

                    if (scope === 'series' && matchMediaId && artworkType === 'thumb') {
                        const matched = await getImageScanTarget(sql, matchMediaId);
                        if (matched?.media_type === 'episode') {
                            const paths = await getMediaFilePaths(sql, matchMediaId);
                            if (
                                !ownsEpisodeThumb(filePath, paths, matchMediaId, {
                                    seasonNumber: matched.season_number,
                                    episodeNumber: matched.episode_number,
                                    patterns: patterns.episode,
                                })
                            )
                                continue;
                        }
                    }

                    if (!matchMediaId) {
                        result.errors++;
                        continue;
                    }

                    result.matched++;

                    if (mode === 'execute') {
                        const registered = await upsertLocalArtwork(sql, {
                            mediaItemId: matchMediaId,
                            artworkType,
                            filePath,
                        });
                        // A removed (tombstoned) sidecar is skipped — don't count
                        // it as stored or report coverage success for an item that
                        // received no new artwork.
                        if (registered) {
                            result.stored++;
                            if (onItemSuccess && !notifiedItems.has(matchMediaId)) {
                                notifiedItems.add(matchMediaId);
                                await onItemSuccess(matchMediaId).catch(() => {
                                    // Non-fatal — coverage write failure must not abort sweep
                                });
                            }
                        }
                    }
                } catch (err) {
                    logger.warn('Failed to process image', {
                        filePath: image.filePath,
                        error: err,
                    });
                    result.errors++;
                }
            }
        } catch (err) {
            logger.warn('Failed to scan directory', { dirPath, error: err });
        }

        processedDirs++;
        onProgress?.(processedDirs, totalDirs);
    }

    logger.info('Image scan complete', result);
    return result;
}
