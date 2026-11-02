// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Catalog images sized to a client's box (`width`/`height`, `maxWidth`/
 * `maxHeight`, `fillWidth`/`fillHeight`), on top of ImageProxyService.
 *
 * The providers only know a small set of width presets. A client that asks
 * for "fill a 300×450 box" or "at most 720 high" gets the smallest preset that
 * is large enough from `getImageByCatalogId` (cached, shared with every other
 * caller), and this module resizes that to the exact box once and caches the
 * result on disk. The size rules are Jellyfin's
 * (`MediaBrowser.Controller/Drawing/ImageHelper.GetNewImageSize`), because the
 * clients that send these parameters were written against them:
 *
 *  - `width` + `height`: exactly that size (the aspect ratio is not kept).
 *    One of them: that dimension, the other follows the aspect ratio.
 *  - `maxWidth` / `maxHeight`: scaled down to fit inside.
 *  - `fillWidth` / `fillHeight`: scaled down to the smallest size that still
 *    covers the box, aspect ratio kept. Nothing is cropped (Jellyfin does not
 *    crop either; the client crops when it draws).
 *  - Never larger than the source.
 *
 * Every dimension is capped at {@link MAX_IMAGE_BOX_DIMENSION} and rounded up
 * to a {@link BOX_DIMENSION_STEP}-pixel ladder, and quality snaps to the shared
 * tiers, so a client can neither make the server render an arbitrarily large
 * image nor mint an unbounded number of cached variants.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import sharp from '$lib/server/services/image-proxy/image-sharp';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { SIZE_PRESET_WIDTHS } from '$lib/server/utils/image-proxy';
import { QUALITY_TIERS } from '$lib/server/utils/image-params';
import { ImageCache } from './cache';
import type { ImageProxyService } from './service';
import type { ImageResponse, ImageSize, ImageType } from './types';

const logger = Logger.for('ImageProxy:Box');

/** Largest width or height a box may ask for (4K UHD width). */
export const MAX_IMAGE_BOX_DIMENSION = 3840;

/** Directory of the resized-to-box derivatives (also swept by image-cache-cleanup). */
export const IMAGE_BOX_CACHE_DIR = path.join(process.cwd(), '.cache', 'image-box');

export interface ImageBox {
    width?: number;
    height?: number;
    maxWidth?: number;
    maxHeight?: number;
    fillWidth?: number;
    fillHeight?: number;
}

export type BoxOutputFormat = 'jpg' | 'png' | 'webp';

export interface Dimensions {
    width: number;
    height: number;
}

/**
 * Box dimensions snap UP to this step before sizing. The route is public and
 * unauthenticated: without a ladder every width × height × quality × format
 * would be its own encode and its own cache file (CPU burn, and eviction of
 * other caches through the shared image cache budget). Rounding up keeps
 * every result at least as large as asked.
 */
export const BOX_DIMENSION_STEP = 40;

/** The box on the cache-friendly ladder (each set value rounded up to the step, capped). */
export function snapBox(box: ImageBox): ImageBox {
    const out: ImageBox = {};
    for (const key of Object.keys(box) as (keyof ImageBox)[]) {
        const v = box[key];
        if (!v || v <= 0) continue;
        out[key] = Math.min(
            Math.ceil(v / BOX_DIMENSION_STEP) * BOX_DIMENSION_STEP,
            MAX_IMAGE_BOX_DIMENSION,
        );
    }
    return out;
}

/** Quality on the shared tier ladder (QUALITY_TIERS): always the nearest tier. */
export function snapBoxQuality(quality: number): number {
    let best: number = QUALITY_TIERS[0];
    for (const tier of QUALITY_TIERS) {
        if (Math.abs(quality - tier) < Math.abs(quality - best)) best = tier;
    }
    return best;
}

/** Disk-cache key of one derivative: source bytes × effective size, format, quality. */
export function boxDerivativeKey(
    uuid: string,
    type: ImageType,
    sourceHash: string,
    target: Dimensions,
    format: BoxOutputFormat,
    quality: number,
): string {
    return (
        createHash('sha256')
            .update(
                `${uuid}:${type}:${sourceHash}:${target.width}x${target.height}:${format}:q${quality}`,
            )
            .digest('hex') + `.${format}`
    );
}

/** True when the box asks for no resize at all. */
export function isEmptyBox(box: ImageBox): boolean {
    return !(
        box.width ||
        box.height ||
        box.maxWidth ||
        box.maxHeight ||
        box.fillWidth ||
        box.fillHeight
    );
}

const clampDim = (n: number): number =>
    Math.min(Math.max(Math.round(n), 1), MAX_IMAGE_BOX_DIMENSION);

/**
 * Jellyfin's `ImageHelper.GetNewImageSize`: Resize (width/height, then
 * maxHeight, then maxWidth), then ResizeFill, then ScaleDownToFit against
 * the source. Every box value is clamped to 1..{@link MAX_IMAGE_BOX_DIMENSION}.
 */
export function boxTargetSize(box: ImageBox, source: Dimensions): Dimensions {
    const pos = (n: number | undefined): number => (n && n > 0 ? clampDim(n) : 0);
    const width = pos(box.width);
    const height = pos(box.height);
    const maxWidth = pos(box.maxWidth);
    const maxHeight = pos(box.maxHeight);
    const fillWidth = pos(box.fillWidth);
    const fillHeight = pos(box.fillHeight);

    // DrawingUtils.Resize
    let w = source.width;
    let h = source.height;
    if (width > 0 && height > 0) {
        w = width;
        h = height;
    } else if (height > 0) {
        w = Math.round((height / h) * w);
        h = height;
    } else if (width > 0) {
        h = Math.round((width / w) * h);
        w = width;
    }
    if (maxHeight > 0 && maxHeight < h) {
        w = Math.round((maxHeight / h) * w);
        h = maxHeight;
    }
    if (maxWidth > 0 && maxWidth < w) {
        h = Math.round((maxWidth / w) * h);
        w = maxWidth;
    }

    // DrawingUtils.ResizeFill: the smallest scale-down that still covers the box.
    if (fillWidth > 0 || fillHeight > 0) {
        const ratio = Math.min(w / (fillWidth || 1), h / (fillHeight || 1));
        if (ratio >= 1) {
            w = Math.ceil(w / ratio);
            h = Math.ceil(h / ratio);
        }
    }

    // DrawingUtils.ScaleDownToFit: never larger than the source.
    const scale = Math.max(w / source.width, h / source.height);
    if (scale > 1) {
        w = Math.min(Math.max(Math.round(w / scale), 1), source.width);
        h = Math.min(Math.max(Math.round(h / scale), 1), source.height);
    }
    return { width: Math.max(1, w), height: Math.max(1, h) };
}

/**
 * Widest plausible width-to-height ratio per role. Used only to pick a source
 * preset that is wide enough; the exact size comes from the real source.
 * Over-estimating costs a larger source read, never a wrong result.
 */
const WIDEST_ASPECT: Record<ImageType, number> = {
    poster: 1, // posters are 2:3, music covers 1:1
    primary: 1,
    backdrop: 1.8,
    thumb: 1.8,
    still: 1.8,
    logo: 4,
    banner: 5.5,
};

const PRESET_ORDER = ['thumb', 'medium', 'card', 'hd', 'wide'] as const;

/** Smallest provider preset whose width is enough for the box. */
export function sourcePresetForBox(box: ImageBox, type: ImageType): ImageSize {
    // Size the box against a huge source of the widest plausible shape: that
    // is the largest width the box can end up needing.
    const aspect = WIDEST_ASPECT[type] ?? 1.8;
    const huge = MAX_IMAGE_BOX_DIMENSION * 4;
    const needed = boxTargetSize(box, { width: huge, height: Math.round(huge / aspect) }).width;
    for (const preset of PRESET_ORDER) {
        if (SIZE_PRESET_WIDTHS[preset] >= needed) return preset;
    }
    return 'full';
}

let boxCache: ImageCache | null = null;
function getBoxCache(): ImageCache {
    boxCache ??= new ImageCache({
        directory: IMAGE_BOX_CACHE_DIR,
        ttl: 30 * 24 * 60 * 60 * 1000, // 30 days; the key carries the source hash
    });
    return boxCache;
}

function outputFormatFor(
    requested: BoxOutputFormat | undefined,
    sourceType: string,
): BoxOutputFormat {
    if (requested) return requested;
    if (sourceType === 'image/png') return 'png'; // keep logo transparency
    if (sourceType === 'image/jpeg') return 'jpg';
    // WebP for everything else, AVIF included: not every TV client decodes AVIF.
    return 'webp';
}

const CONTENT_TYPE: Record<BoxOutputFormat, string> = {
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
};

async function encode(
    source: Buffer,
    target: Dimensions,
    format: BoxOutputFormat,
    quality: number,
): Promise<Buffer> {
    const pipeline = sharp(source).rotate().resize(target.width, target.height, { fit: 'fill' });
    if (format === 'jpg') return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    if (format === 'png') return pipeline.png().toBuffer();
    return pipeline.webp({ quality, effort: 4 }).toBuffer();
}

export interface BoxImageOptions {
    revision?: string;
    format?: BoxOutputFormat;
    /** 1-100; the configured thumb quality when unset. */
    quality?: number;
}

/**
 * The catalog image for `uuid`/`type`, sized to `box` with Jellyfin's rules.
 * An empty box is a plain `getImageByCatalogId` call. Null when the item has
 * no such image (the caller serves its placeholder).
 */
export async function getCatalogImageInBox(
    service: Pick<ImageProxyService, 'getImageByCatalogId'>,
    uuid: string,
    type: ImageType,
    box: ImageBox,
    options: BoxImageOptions = {},
): Promise<ImageResponse | null> {
    if (isEmptyBox(box)) {
        return service.getImageByCatalogId(uuid, type, {
            ...(options.revision ? { revision: options.revision } : {}),
            ...(options.quality !== undefined ? { quality: options.quality } : {}),
            ...(options.format ? { format: options.format } : {}),
        });
    }

    // The source: a cached, bounded preset that is at least as wide as needed.
    const snapped = snapBox(box);
    const base = await service.getImageByCatalogId(uuid, type, {
        ...(options.revision ? { revision: options.revision } : {}),
        size: sourcePresetForBox(snapped, type),
        bounded: true,
    });
    if (!base) return null;

    try {
        const meta = await sharp(base.buffer).metadata();
        if (!meta.width || !meta.height) return base;
        // EXIF orientation 5-8 swaps the axes once `.rotate()` applies it.
        const rotated = (meta.orientation ?? 1) >= 5;
        const source: Dimensions = rotated
            ? { width: meta.height, height: meta.width }
            : { width: meta.width, height: meta.height };
        const target = boxTargetSize(snapped, source);
        const format = outputFormatFor(options.format, base.contentType);
        const quality = snapBoxQuality(options.quality ?? config.IMAGE_THUMB_QUALITY);

        if (
            target.width === source.width &&
            target.height === source.height &&
            CONTENT_TYPE[format] === base.contentType &&
            options.quality === undefined
        ) {
            return base;
        }

        const sourceHash = createHash('sha1').update(base.buffer).digest('hex');
        const cacheKey = boxDerivativeKey(uuid, type, sourceHash, target, format, quality);
        const { buffer, wasHit } = await getBoxCache().getCachedOrFetch(
            cacheKey,
            () => encode(base.buffer, target, format, quality),
            { encode: true },
        );
        return {
            buffer,
            contentType: CONTENT_TYPE[format],
            cacheControl: base.cacheControl,
            servedRevision: base.servedRevision,
            cacheStatus: wasHit ? 'HIT' : 'MISS',
        };
    } catch (error) {
        // An undecodable source is still an image the client can draw itself.
        logger.warn('Box resize failed; serving the unresized source', {
            uuid,
            type,
            error: error instanceof Error ? error.message : String(error),
        });
        return base;
    }
}
