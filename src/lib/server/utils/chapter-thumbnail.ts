// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Chapter thumbnail resolver.
 *
 * Derives a per-chapter thumbnail from the existing trickplay sprite sheets
 * (generated for scrub-bar previews) instead of extracting a fresh frame per
 * chapter. Given a chapter's start time and the file's trickplay params, it
 * computes which sprite sheet holds the covering thumbnail and the pixel
 * rectangle to crop out of it.
 *
 * The grid math mirrors the generator exactly (see trickplay-generator.service.ts):
 *   thumbnailsPerSheet = tile_width * tile_height   (grid counts)
 *   left = (positionInSheet % tile_width) * width    (width/height are pixels)
 *   top  = floor(positionInSheet / tile_width) * height
 */

import sharp from 'sharp';

/** Avoid the usually-black fade-in frame for a chapter placed at the movie start. */
const OPENING_CHAPTER_MAX_SECONDS = 1;
const OPENING_CHAPTER_THUMBNAIL_OFFSET_SECONDS = 10;

/** Minimal trickplay param shape needed to locate a thumbnail. */
export interface TrickplayTileParams {
    /** Pixel width of one tile. */
    width: number;
    /** Pixel height of one tile. */
    height: number;
    /** Seconds between thumbnails, in ms. */
    interval_ms: number;
    /** Grid columns per sheet. */
    tile_width: number;
    /** Grid rows per sheet. */
    tile_height: number;
    /** Total number of real thumbnails across all sheets. */
    thumbnail_count: number;
}

/** A resolved crop location within a specific sprite sheet. */
export interface ChapterTileLocation {
    sheetIndex: number;
    cropLeft: number;
    cropTop: number;
    cropWidth: number;
    cropHeight: number;
}

/**
 * Map a chapter start time (in 100ns ticks) to a sprite-sheet crop location.
 * Returns null when params are degenerate or the time falls past the last
 * real thumbnail (the final sheet is often a partial grid, so an out-of-range
 * index can still land inside an existing sheet — cropping it would throw).
 */
export function computeChapterTile(
    startTicks: number,
    p: TrickplayTileParams,
): ChapterTileLocation | null {
    if (p.interval_ms <= 0 || p.tile_width <= 0 || p.tile_height <= 0) return null;
    if (p.width <= 0 || p.height <= 0 || p.thumbnail_count <= 0) return null;

    const seconds = startTicks / 10_000_000;
    if (seconds < 0) return null;

    const intervalSeconds = p.interval_ms / 1000;
    const thumbnailIndex = Math.floor(seconds / intervalSeconds);
    if (thumbnailIndex < 0 || thumbnailIndex >= p.thumbnail_count) return null;

    return computeChapterTileForIndex(thumbnailIndex, p);
}

function computeChapterTileForIndex(
    thumbnailIndex: number,
    p: TrickplayTileParams,
): ChapterTileLocation | null {
    const tilesPerSheet = p.tile_width * p.tile_height;
    if (thumbnailIndex < 0 || thumbnailIndex >= p.thumbnail_count || tilesPerSheet <= 0) {
        return null;
    }
    const sheetIndex = Math.floor(thumbnailIndex / tilesPerSheet);
    const positionInSheet = thumbnailIndex % tilesPerSheet;
    const col = positionInSheet % p.tile_width;
    const row = Math.floor(positionInSheet / p.tile_width);

    return {
        sheetIndex,
        cropLeft: col * p.width,
        cropTop: row * p.height,
        cropWidth: p.width,
        cropHeight: p.height,
    };
}

/**
 * Return the exact chapter tile followed by later-sheet tiles, then earlier
 * ones. A missing/corrupt sprite sheet therefore degrades to the next
 * available trickplay frame before ever revealing an earlier moment.
 */
export function computeNearestChapterTiles(
    startTicks: number,
    p: TrickplayTileParams,
): ChapterTileLocation[] {
    // Chapter zero commonly points to a black distributor/fade-in frame. Keep
    // its timeline position intact, but choose a representative frame shortly
    // into the feature for its thumbnail.
    const thumbnailTicks =
        startTicks >= 0 && startTicks / 10_000_000 < OPENING_CHAPTER_MAX_SECONDS
            ? startTicks + OPENING_CHAPTER_THUMBNAIL_OFFSET_SECONDS * 10_000_000
            : startTicks;
    const exact = computeChapterTile(thumbnailTicks, p);
    if (!exact) return [];

    const tilesPerSheet = p.tile_width * p.tile_height;
    const targetIndex = Math.floor(thumbnailTicks / 10_000_000 / (p.interval_ms / 1000));
    const sheetCount = Math.ceil(p.thumbnail_count / tilesPerSheet);
    const locationForSheet = (sheetIndex: number): ChapterTileLocation | null => {
        const firstIndex = sheetIndex * tilesPerSheet;
        const lastIndex = Math.min(p.thumbnail_count - 1, firstIndex + tilesPerSheet - 1);
        const nearestIndex = Math.max(firstIndex, Math.min(targetIndex, lastIndex));
        return computeChapterTileForIndex(nearestIndex, p);
    };
    const candidates = [exact];

    for (let sheetIndex = exact.sheetIndex + 1; sheetIndex < sheetCount; sheetIndex++) {
        const location = locationForSheet(sheetIndex);
        if (location) candidates.push(location);
    }
    for (let sheetIndex = exact.sheetIndex - 1; sheetIndex >= 0; sheetIndex--) {
        const location = locationForSheet(sheetIndex);
        if (location) candidates.push(location);
    }

    return candidates;
}

/** Pick the highest-resolution trickplay params row (best thumbnail quality). */
export function pickBestTrickplayParams<T extends { width: number }>(rows: readonly T[]): T | null {
    if (rows.length === 0) return null;
    return rows.reduce((best, r) => (r.width > best.width ? r : best));
}

/**
 * Crop a single tile out of a sprite sheet and return WebP bytes.
 *
 * The DB params normally mirror the sheet dimensions, but trickplay can be
 * regenerated while stale params are still being served. Derive the pixel
 * bounds from the sheet itself so a stale tile height cannot straddle two
 * adjacent frames (or make an otherwise valid crop 404).
 */
export async function cropChapterTile(
    sheet: Buffer,
    loc: ChapterTileLocation,
    p: Pick<TrickplayTileParams, 'width' | 'height' | 'tile_width' | 'tile_height'>,
): Promise<Buffer> {
    const image = sharp(sheet);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || p.tile_width <= 0 || p.width <= 0 || p.height <= 0) {
        throw new Error('Invalid trickplay sheet dimensions');
    }

    const col = Math.floor(loc.cropLeft / loc.cropWidth);
    const row = Math.floor(loc.cropTop / loc.cropHeight);
    const tilePixelWidth = metadata.width / p.tile_width;
    const expectedTileHeight = tilePixelWidth * (p.height / p.width);
    const rowsInSheet = Math.max(
        1,
        Math.min(p.tile_height, Math.round(metadata.height / expectedTileHeight)),
    );
    if (col < 0 || col >= p.tile_width || row < 0 || row >= rowsInSheet) {
        throw new Error('Chapter tile is outside the trickplay sheet');
    }

    // Use proportional edges so a non-integer scaled tile size cannot leak a
    // pixel from the neighbouring frame.
    const left = Math.floor((col * metadata.width) / p.tile_width);
    const right = Math.floor(((col + 1) * metadata.width) / p.tile_width);
    const top = Math.floor((row * metadata.height) / rowsInSheet);
    const bottom = Math.floor(((row + 1) * metadata.height) / rowsInSheet);

    return image
        .extract({ left, top, width: right - left, height: bottom - top })
        .webp({ quality: 85 })
        .toBuffer();
}
