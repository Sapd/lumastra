// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Disk trickplay provider.
 *
 * Reads Jellyfin-format trickplay sprite sheets from media directories.
 * These are pre-generated sprite sheets in `.trickplay` directories alongside
 * media files, using the format: {filename}.trickplay/{width} - {tileW}x{tileH}/
 *
 * The interval between thumbnails is NOT stored on disk. We infer it from
 * the media duration and the occupied tiles in the generated sprite sheets.
 */

import {
    defineTrickplayProvider,
    type PluginContext,
    type TrickplayParams,
} from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { config } from '$lib/server/config.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { findVideoPath } from '$lib/server/database/queries/trickplay.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { type Dirent } from 'fs';
import { safeExists, safeReaddir } from '$lib/server/utils/safe-fs.js';
import { readContainedFile, resolveContainedFile } from '$lib/server/utils/contained-fs.js';
import { join, dirname, basename, extname } from 'path';
import sharp from 'sharp';

/** Common intervals to snap to when the measured interval is already close. */
const COMMON_INTERVALS = [2000, 5000, 10000, 15000, 20000, 30000];

/**
 * Defensive bounds for `getJellyfinDiskSpriteSheet`'s `width`/`sheetIndex`
 * inputs. All 3 current HTTP callers validate first (Zod `trickplayParamsSchema`
 * /`trickplayQuerySchema` in `$lib/schemas/playback` — positive/non-negative
 * integers with NO upper bound — or the legacy `/j/` compat route's hand-rolled
 * `parseInt` check, which does cap at these exact values). These constants
 * mirror the `/j/` route's bounds so this function stays safe even if a future
 * caller forgets to validate: values are used to build a filesystem path via
 * `join()`, and an unbounded/non-integer value is a traversal/DoS smell.
 */
const MAX_SPRITE_WIDTH = 10_000;
const MAX_SPRITE_SHEET_INDEX = 100_000;

/** Pattern: "{width} - {tileW}x{tileH}" */
const RESOLUTION_DIR_PATTERN = /^(\d+)\s*-\s*(\d+)x(\d+)$/;

/** Fallback pattern: just "{width}" (older Jellyfin format) */
const WIDTH_ONLY_PATTERN = /^(\d+)$/;

interface ParsedResolutionDir {
    width: number;
    tileWidth: number;
    tileHeight: number;
}

function parseResolutionDir(dirName: string): ParsedResolutionDir | null {
    const match = dirName.match(RESOLUTION_DIR_PATTERN);
    if (match) {
        return {
            width: parseInt(match[1], 10),
            tileWidth: parseInt(match[2], 10),
            tileHeight: parseInt(match[3], 10),
        };
    }
    const widthMatch = dirName.match(WIDTH_ONLY_PATTERN);
    if (widthMatch) {
        return {
            width: parseInt(widthMatch[1], 10),
            tileWidth: 10,
            tileHeight: 10,
        };
    }
    return null;
}

/**
 * Normalize an inferred interval.
 *
 * When the measured value is very close to a common cadence, use the exact
 * cadence to avoid tiny duration/count rounding drift.
 */
function normalizeInterval(rawIntervalMs: number): number {
    const SNAP_TOLERANCE = 0.03;
    for (const common of COMMON_INTERVALS) {
        const ratio = rawIntervalMs / common;
        if (ratio >= 1 - SNAP_TOLERANCE && ratio <= 1 + SNAP_TOLERANCE) return common;
    }
    return Math.max(1, Math.round(rawIntervalMs));
}

/**
 * Calculate interval from duration, sheet count, and tiles per sheet.
 *
 * Jellyfin writes fixed-interval thumbnails into fixed-size sprite sheets, but
 * does not persist the interval in the `.trickplay` folder. The best signal we
 * have on disk is the count of occupied cells in the sheets.
 */
export function calculateInterval(
    durationMs: number,
    sheetCount: number,
    tilesPerSheet: number,
    thumbnailCount?: number | null,
): number {
    if (sheetCount <= 0 || tilesPerSheet <= 0) return 10000;

    const exactSheetMatches = COMMON_INTERVALS.filter((interval) => {
        const count = Math.ceil(durationMs / interval);
        return Math.ceil(count / tilesPerSheet) === sheetCount;
    });

    // A unique common-interval match is more reliable than the thumbnail count:
    // blank-tile detection is heuristic and can over-count dark end frames,
    // while the sheet count is an exact file count.
    if (exactSheetMatches.length === 1) return exactSheetMatches[0];

    if (exactSheetMatches.length > 1) {
        if (thumbnailCount && thumbnailCount > 0) {
            const exactCountMatch = exactSheetMatches.find(
                (interval) => Math.ceil(durationMs / interval) === thumbnailCount,
            );
            if (exactCountMatch !== undefined) return exactCountMatch;
            return normalizeInterval(durationMs / thumbnailCount);
        }
        // No thumbnail count — prefer the interval that leaves the final sheet
        // fullest; break ties by proximity to Jellyfin's observed 5s default.
        return exactSheetMatches.reduce((best, interval) => {
            const bestThumbs = Math.ceil(durationMs / best);
            const intervalThumbs = Math.ceil(durationMs / interval);
            const bestUnused = sheetCount * tilesPerSheet - bestThumbs;
            const intervalUnused = sheetCount * tilesPerSheet - intervalThumbs;
            if (intervalUnused !== bestUnused) {
                return intervalUnused < bestUnused ? interval : best;
            }
            return Math.abs(interval - 5000) < Math.abs(best - 5000) ? interval : best;
        }, exactSheetMatches[0]);
    }

    if (thumbnailCount && thumbnailCount > 0) {
        return normalizeInterval(durationMs / thumbnailCount);
    }
    return normalizeInterval(durationMs / (sheetCount * tilesPerSheet));
}

function isBlankTile(
    raw: Buffer,
    imageWidth: number,
    channels: number,
    tileWidthPx: number,
    tileHeightPx: number,
    tileIndex: number,
    columns: number,
): boolean {
    const left = (tileIndex % columns) * tileWidthPx;
    const top = Math.floor(tileIndex / columns) * tileHeightPx;
    const stride = 8;
    let samples = 0;
    let litSamples = 0;

    for (let y = top; y < top + tileHeightPx; y += stride) {
        for (let x = left; x < left + tileWidthPx; x += stride) {
            const offset = (y * imageWidth + x) * channels;
            const r = raw[offset] ?? 0;
            const g = raw[offset + 1] ?? r;
            const b = raw[offset + 2] ?? r;
            samples++;
            if (r > 8 || g > 8 || b > 8) litSamples++;
        }
    }
    return samples > 0 && litSamples / samples < 0.01;
}

async function readLastSheetOccupancy(
    resolutionDir: string,
    jpgFiles: string[],
    tileWidth: number,
    tileHeight: number,
    logger: { warn(msg: string, meta?: object): void },
): Promise<{ thumbnailCount: number; usedInLastSheet: number; thumbnailHeight: number } | null> {
    if (jpgFiles.length === 0) return null;

    const sorted = [...jpgFiles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const lastSheet = join(resolutionDir, sorted[sorted.length - 1]);

    try {
        const { data, info } = await sharp(lastSheet).raw().toBuffer({ resolveWithObject: true });
        if (!info.width || !info.height || info.channels <= 0) return null;

        const tileWidthPx = Math.floor(info.width / tileWidth);
        const tileHeightPx = Math.floor(info.height / tileHeight);
        if (tileWidthPx <= 0 || tileHeightPx <= 0) return null;

        const tilesPerSheet = tileWidth * tileHeight;
        let lastContentIndex = tilesPerSheet - 1;

        while (
            lastContentIndex >= 0 &&
            isBlankTile(
                data,
                info.width,
                info.channels,
                tileWidthPx,
                tileHeightPx,
                lastContentIndex,
                tileWidth,
            )
        ) {
            lastContentIndex--;
        }

        if (lastContentIndex < 0) return null;

        // Include one trailing black tile as possible real video content. End
        // credits/fade-to-black can be visually indistinguishable from padding,
        // and over-counting by one is less harmful than dropping the final
        // playable thumbnail from the timeline.
        const usedInLastSheet = Math.min(tilesPerSheet, lastContentIndex + 2);
        return {
            usedInLastSheet,
            thumbnailCount: (jpgFiles.length - 1) * tilesPerSheet + usedInLastSheet,
            // Jellyfin writes every sheet at full height, the last one too.
            thumbnailHeight: tileHeightPx,
        };
    } catch (err) {
        logger.warn('Failed to read last trickplay sheet occupancy', {
            resolutionDir,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

async function getTrickplayDirPath(videoFilePath: string): Promise<string | null> {
    const dir = dirname(videoFilePath);
    const base = basename(videoFilePath, extname(videoFilePath));
    const trickplayDir = join(dir, `${base}.trickplay`);
    // safeExists: the .trickplay dir sits next to the media on the (possibly NFS)
    // library mount — a sync existsSync here would block the event loop on a stall.
    return (await safeExists(trickplayDir)) ? trickplayDir : null;
}

/**
 * Shared probe routine: resolves the item's video path + duration once,
 * lists the .trickplay directory once, then probes the requested set of
 * widths (or all discovered widths) in parallel. Returns one
 * `{width, params}` entry per width actually present on disk.
 *
 * Per-width work is just the sharp decode of the last sheet + interval
 * inference; everything else is shared.
 */
async function probeJellyfinDiskItem(
    ctx: PluginContext,
    mediaItemId: string,
    widthFilter: ReadonlySet<number> | null,
): Promise<Array<{ width: number; params: TrickplayParams }> | null> {
    const selection = await resolvePlaybackSelection(ctx.sql, mediaItemId, {});
    if (!selection.fileId) return null;
    // `selection.files` is ordered by sort_order, not "default first" — pick the
    // row whose id matches the resolved default fileId so multi-version items
    // (extended cut + theatrical cut) probe the right `.trickplay` directory.
    const selectedFile =
        selection.files.find((f) => f.id === selection.fileId) ?? selection.files[0];
    const videoPath = selectedFile?.file_path ?? null;
    if (!videoPath) return null;

    const trickplayDir = await getTrickplayDirPath(videoPath);
    if (!trickplayDir) return null;

    const runtimeSeconds: number | null =
        selectedFile.duration_seconds ??
        (await (async () => {
            try {
                const rows = await ctx.sql<{ duration: number | null }[]>`
                SELECT COALESCE(mi.runtime_seconds, mf.duration_seconds) AS duration
                FROM media_items mi
                LEFT JOIN media_file_items mfi ON mfi.media_item_id = mi.id
                LEFT JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mi.id = ${mediaItemId}
                  AND mf.id = ${selection.fileId!}
                ORDER BY mfi.is_default DESC, mfi.sort_order NULLS LAST, mf.id
                LIMIT 1
            `;
                return rows[0]?.duration ?? null;
            } catch (err) {
                ctx.logger.warn('jellyfin-disk trickplay: duration lookup failed', {
                    mediaItemId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return null;
            }
        })());

    if (!runtimeSeconds || runtimeSeconds <= 0) {
        ctx.logger.warn('No runtime available for trickplay interval calculation', { mediaItemId });
        return null;
    }
    const durationMs = runtimeSeconds * 1000;

    let entries: Dirent[];
    try {
        entries = await safeReaddir(trickplayDir);
    } catch {
        return null;
    }

    // Parse every resolution subdir once. Most items have 1-2 widths on disk
    // (Jellyfin's default is one), so width-filtering up front skips a LOT
    // of would-be-null sharp decodes when callers ask for canonical widths.
    const candidates: Array<{ entry: Dirent; parsed: ParsedResolutionDir }> = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const parsed = parseResolutionDir(entry.name);
        if (!parsed) continue;
        if (widthFilter !== null && !widthFilter.has(parsed.width)) continue;
        candidates.push({ entry, parsed });
    }
    if (candidates.length === 0) return [];

    // Probe present widths in bounded-parallel batches. The only per-width
    // cost left is the sharp decode of the last sprite sheet (interval
    // inference) — everything shared (path resolution, runtime lookup,
    // .trickplay readdir) ran once.
    //
    // Concurrency cap of 2 keeps the transient RAM footprint bounded
    // (sharp.raw() on a 6400×6400 sheet allocates ~100MB; 4 concurrent
    // could spike to 400MB on a single item, problematic on small worker
    // containers). 2 is the sweet spot for 1-2-width items (common case
    // runs at full speed) and bounded for 4-width items.
    //
    // Uses Promise.allSettled so one corrupt sprite sheet doesn't reject
    // the whole batch — we keep the widths that succeeded.
    const SHARP_CONCURRENCY = 2;
    type ProbeResult = { width: number; params: TrickplayParams } | null;
    const probeOne = async ({
        entry,
        parsed,
    }: {
        entry: Dirent;
        parsed: ParsedResolutionDir;
    }): Promise<ProbeResult> => {
        const resolutionDir = join(trickplayDir, entry.name);
        let jpgFiles: string[];
        try {
            const files = await safeReaddir(resolutionDir);
            jpgFiles = files.filter((f) => f.name.endsWith('.jpg')).map((f) => f.name);
        } catch {
            return null;
        }
        if (jpgFiles.length === 0) {
            // Partial-generation state: Jellyfin created the resolution dir
            // but no sprites yet. Debug-level since it's transient.
            ctx.logger.debug('jellyfin-disk: width dir present but empty', {
                mediaItemId,
                width: parsed.width,
            });
            return null;
        }

        const tilesPerSheet = parsed.tileWidth * parsed.tileHeight;
        const occupancy = await readLastSheetOccupancy(
            resolutionDir,
            jpgFiles,
            parsed.tileWidth,
            parsed.tileHeight,
            ctx.logger,
        );
        const intervalMs = calculateInterval(
            durationMs,
            jpgFiles.length,
            tilesPerSheet,
            occupancy?.thumbnailCount,
        );

        ctx.logger.debug('Found Jellyfin disk trickplay', {
            mediaItemId,
            width: parsed.width,
            sheets: jpgFiles.length,
            intervalMs,
            thumbnailCount: occupancy?.thumbnailCount,
            usedInLastSheet: occupancy?.usedInLastSheet,
        });

        return {
            width: parsed.width,
            params: {
                url: `/api/playback/${mediaItemId}/trickplay/${parsed.width}?index={index}`,
                tileWidth: parsed.tileWidth,
                tileHeight: parsed.tileHeight,
                interval: intervalMs,
                columns: parsed.tileWidth,
                rows: parsed.tileHeight,
                // Real total across every sheet, not one sheet's tile
                // capacity — falls back to the on-disk sheet count * tiles
                // when occupancy detection itself failed (corrupt/unreadable
                // last sheet), which still beats a single-sheet undercount.
                thumbnailCount: occupancy?.thumbnailCount ?? jpgFiles.length * tilesPerSheet,
                // Jellyfin keeps the source aspect ratio (240 for 4:3 at 320);
                // a 16:9 guess shows two half thumbnails per frame.
                thumbnailHeight: occupancy?.thumbnailHeight,
            },
        };
    };

    const out: Array<{ width: number; params: TrickplayParams }> = [];
    for (let i = 0; i < candidates.length; i += SHARP_CONCURRENCY) {
        const batch = candidates.slice(i, i + SHARP_CONCURRENCY);
        const settled = await Promise.allSettled(batch.map(probeOne));
        for (const r of settled) {
            if (r.status === 'fulfilled' && r.value !== null) {
                out.push(r.value);
            } else if (r.status === 'rejected') {
                ctx.logger.warn('jellyfin-disk: sprite probe rejected', {
                    mediaItemId,
                    error: r.reason instanceof Error ? r.reason.message : String(r.reason),
                });
            }
        }
    }
    return out;
}

export const jellyfinDiskTrickplayProvider = defineTrickplayProvider({
    id: 'jellyfin-disk-trickplay',
    capabilities: { http: false, cache: false, database: true },

    async fetchParams(ctx, params) {
        if (config.TRICKPLAY_PROVIDER === 'local_only') return null;
        if (config.DISABLE_JELLYFIN_DISK_TRICKPLAY) return null;

        const results = await probeJellyfinDiskItem(
            ctx,
            params.mediaItemId,
            new Set([params.width]),
        );
        if (!results || results.length === 0) return null;
        return results[0].params;
    },

    async discoverParams(ctx, { mediaItemId }) {
        if (config.TRICKPLAY_PROVIDER === 'local_only') return null;
        if (config.DISABLE_JELLYFIN_DISK_TRICKPLAY) return null;
        return probeJellyfinDiskItem(ctx, mediaItemId, null);
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerTrickplay(jellyfinDiskTrickplayProvider);

/**
 * Read a specific sprite-sheet JPEG from the Jellyfin-format trickplay
 * directory. Used by HTTP routes that serve the actual image bytes — the
 * `defineTrickplayProvider` contract describes manifest metadata, not raw
 * image delivery, so this lives as a named export for route consumers.
 *
 * Returns null when:
 *   - The internal id can't be resolved to a video path
 *   - No `.trickplay` directory exists alongside the video
 *   - No resolution subdir matches the requested width
 *   - The sheet file is missing
 */
export async function getJellyfinDiskSpriteSheet(
    internalId: string,
    width: number,
    sheetIndex: number,
    mediaFilePath?: string | null,
): Promise<{ buffer: Buffer; contentType: string } | null> {
    // Internal defensive validation — every current HTTP caller Zod-validates
    // (or, for the legacy `/j/` route, hand-checks) width/sheetIndex before
    // calling in, but this function builds a filesystem path from both via
    // `join()` below with zero validation of its own. A future caller that
    // skips validation is one path away from traversal or a bogus huge-number
    // path lookup. Reject non-finite, non-integer, negative, or out-of-bounds
    // values the same way the rest of this function signals "not found".
    if (
        !Number.isInteger(width) ||
        width <= 0 ||
        width > MAX_SPRITE_WIDTH ||
        !Number.isInteger(sheetIndex) ||
        sheetIndex < 0 ||
        sheetIndex > MAX_SPRITE_SHEET_INDEX
    ) {
        return null;
    }

    let videoPath = mediaFilePath ?? null;

    if (!videoPath) {
        const sql = await aiDbService.getSql();
        if (!sql) return null;
        videoPath = await findVideoPath(sql, internalId);
    }
    if (!videoPath) return null;

    const sheet = await findSheetPath(videoPath, width, sheetIndex);
    if (!sheet) return null;
    try {
        const buffer = await readContainedFile(sheet.path);
        return { buffer, contentType: 'image/jpeg' };
    } catch {
        return null;
    }
}

async function findSheetPath(
    videoPath: string,
    width: number,
    sheetIndex: number,
): Promise<{ path: string; rows: number } | null> {
    const trickplayDir = await getTrickplayDirPath(videoPath);
    if (!trickplayDir) return null;

    let entries: Dirent[];
    try {
        entries = await safeReaddir(trickplayDir);
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const parsed = parseResolutionDir(entry.name);
        if (!parsed || parsed.width !== width) continue;
        return {
            path: join(trickplayDir, entry.name, `${sheetIndex}.jpg`),
            rows: parsed.tileHeight,
        };
    }
    return null;
}

/**
 * Pixel height of one thumbnail in a Jellyfin sprite set, read from the first
 * sheet's image header (no decode). Used to repair rows stored before
 * providers reported the height. Null when the sheet is missing or unreadable.
 */
export async function readJellyfinDiskThumbnailHeight(
    videoPath: string,
    width: number,
): Promise<number | null> {
    if (!Number.isInteger(width) || width <= 0 || width > MAX_SPRITE_WIDTH) return null;
    const sheet = await findSheetPath(videoPath, width, 0);
    if (!sheet) return null;
    try {
        const target = await resolveContainedFile(sheet.path, [], { parents: true });
        if (!target) return null;
        const { height } = await sharp(target).metadata();
        if (!height) return null;
        const thumbnailHeight = Math.floor(height / sheet.rows);
        return thumbnailHeight > 0 ? thumbnailHeight : null;
    } catch {
        return null;
    }
}
