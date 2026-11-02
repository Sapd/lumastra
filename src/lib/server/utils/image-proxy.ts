// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared utility for proxying image requests to external services
 */

import {
    ImageWorkBudgetExceededError,
    hasImageWorkBudget,
    isRestrictedImageRequest,
} from '$lib/server/services/image-proxy/work-budget';
import { snapQualityToTier, QUALITY_TIERS } from './image-quality';
import { config as appConfig } from '$lib/server/config.js';
import sharp from '$lib/server/services/image-proxy/image-sharp';
import { Logger } from '$lib/server/utils/logger.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
import { readBoundedResponseBytes } from '$lib/server/utils/bounded-response.js';

/** Sonarr/Radarr artwork: far above any real poster. */
const MAX_ARR_IMAGE_BYTES = 20 * 1024 * 1024;
const logger = Logger.for('ImageProxy');

interface ImageProxyConfig {
    serviceUrl: string;
    apiKey: string;
    serviceName: string;
}

/**
 * WebP conversion options optimized for performance and quality.
 * - lossless: false - Always use lossy compression for smaller files
 * - effort: 4 - Balanced encoding effort (0=fastest, 6=slowest but best compression)
 * - Sharp automatically uses multi-threading via libvips
 */
export interface WebPOptions {
    quality: number;
    lossless?: boolean;
    effort?: number;
}

/**
 * Get optimized WebP options for Sharp conversion.
 * @param quality - Quality value 1-100 (default from config)
 * @returns Sharp WebP options with lossless=false and reasonable effort
 */
export function getWebPOptions(quality?: number): WebPOptions {
    return {
        quality: quality ?? appConfig.IMAGE_THUMB_QUALITY,
        lossless: false,
        effort: 4, // Balanced: 0=fastest, 6=best compression
    };
}

/**
 * Sharp AVIF options. Speed (effort) is read from config so admins can tune
 * the encode-cost vs file-size trade-off without redeploying.
 */
export interface AvifOptions {
    quality: number;
    lossless?: boolean;
    effort?: number;
    chromaSubsampling?: '4:4:4' | '4:2:0';
}

/**
 * Get AVIF options for Sharp. AVIF q=54 ≈ WebP q=75 perceptually on sharp 0.35's
 * SSIMULACRA2-tuned scale (0.34 reached the same point at q=50).
 * @param quality - Quality value 1-100 (default to AVIF thumb quality from config)
 * @returns Sharp AVIF options
 */
export function getAvifOptions(quality?: number): AvifOptions {
    return {
        quality: quality ?? appConfig.IMAGE_AVIF_THUMB_QUALITY,
        lossless: false,
        effort: appConfig.IMAGE_AVIF_SPEED,
        // 4:2:0 chroma is invisible on natural images and ~20% smaller than 4:4:4.
        // Sharp/libheif default to 4:4:4 for AVIF; we override for posters/backdrops.
        chromaSubsampling: '4:2:0',
    };
}

/**
 * Map a client-supplied WebP/JPEG-scale quality (e.g. a snapped tier like 85) to an
 * AVIF-scale quality. AVIF reaches comparable perceptual quality at a LOWER numeric
 * value (see getAvifOptions: "AVIF q=54 ≈ WebP q=75"), so feeding a WebP-scale value
 * straight to the AVIF encoder over-encodes (much larger files). Scale by the
 * operator-configured AVIF:WebP quality ratio so the same perceptual tier yields an
 * AVIF-appropriate quality. Format is already a cache-key dimension, so AVIF and WebP
 * stay separate cache entries.
 */
export function avifQualityForWebp(webpQuality: number, isThumbTier: boolean): number {
    const ratio = isThumbTier
        ? appConfig.IMAGE_AVIF_THUMB_QUALITY / appConfig.IMAGE_THUMB_QUALITY
        : appConfig.IMAGE_AVIF_FULL_QUALITY / appConfig.IMAGE_FULL_QUALITY;
    return Math.max(1, Math.min(100, Math.round(webpQuality * ratio)));
}

/**
 * Parse and validate quality parameter from URL search params.
 * Returns undefined if not provided or invalid (use config default).
 * @param url - URL with search params
 * @param defaultQuality - Default quality to use if not specified
 * @returns Validated quality value or undefined
 */
export function parseQualityParam(url: URL, defaultQuality?: number): number {
    const qualityParam = url.searchParams.get('quality');
    if (qualityParam) {
        const parsed = parseInt(qualityParam, 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
            return hasImageWorkBudget() && isRestrictedImageRequest()
                ? snapQualityToTier(parsed, QUALITY_TIERS, true)
                : parsed;
        }
    }
    return defaultQuality ?? appConfig.IMAGE_THUMB_QUALITY;
}

/**
 * Convert image buffer to WebP format with optimized settings.
 * @param buffer - Input image buffer
 * @param quality - Quality value 1-100
 * @returns Converted WebP buffer
 */
export async function convertToWebP(buffer: Buffer, quality?: number): Promise<Buffer> {
    return sharp(buffer).webp(getWebPOptions(quality)).toBuffer();
}

/**
 * Re-encode a buffer to the target format WITHOUT resizing. Used by the
 * non-resized paths (audiobook covers, custom URLs at size=full) so AVIF-
 * capable clients still get AVIF for full-size images. Falls back through
 * the same chain as resizeForPreset on encoder failure.
 */
export async function transcodeToFormat(
    buffer: Buffer,
    contentType: string,
    format: 'webp' | 'avif' | 'jpeg' | 'png',
): Promise<{ buffer: Buffer; contentType: string }> {
    const isGif = contentType === 'image/gif';
    const buildPipeline = () => sharp(buffer, { animated: isGif }).rotate();

    if (format === 'png') {
        try {
            const buf = await buildPipeline().png().toBuffer();
            return { buffer: buf, contentType: 'image/png' };
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            logger.warn('PNG transcode failed; returning original', {
                error: error instanceof Error ? error.message : String(error),
            });
            return { buffer, contentType };
        }
    }
    if (format === 'jpeg') {
        try {
            const buf = await buildPipeline()
                .jpeg({
                    quality: appConfig.IMAGE_FULL_QUALITY,
                    mozjpeg: true,
                })
                .toBuffer();
            return { buffer: buf, contentType: 'image/jpeg' };
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            logger.warn('JPEG transcode failed; returning original', {
                error: error instanceof Error ? error.message : String(error),
            });
            return { buffer, contentType };
        }
    }
    if (format === 'avif') {
        try {
            const buf = await buildPipeline()
                .avif(getAvifOptions(appConfig.IMAGE_AVIF_FULL_QUALITY))
                .toBuffer();
            return { buffer: buf, contentType: 'image/avif' };
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            logger.warn('AVIF transcode failed, falling back to WebP', {
                error: error instanceof Error ? error.message : String(error),
            });
            // fall through to webp
        }
    }
    try {
        const buf = await buildPipeline()
            .webp(getWebPOptions(appConfig.IMAGE_FULL_QUALITY))
            .toBuffer();
        return { buffer: buf, contentType: 'image/webp' };
    } catch (error) {
        if (error instanceof ImageWorkBudgetExceededError) throw error;
        logger.warn('WebP transcode failed; returning original', {
            error: error instanceof Error ? error.message : String(error),
        });
        return { buffer, contentType };
    }
}

/**
 * Map ImageSize preset → maxWidth (px) used by local/custom resize AND by the
 * width-snapping logic in `image-params.ts`. This is the single source of truth
 * for the bounded set of cache-friendly widths: a raw `?width=N` snaps onto one
 * of these when it is within ±20%, otherwise it renders as a custom width.
 *
 * `full` is intentionally omitted — it means "return the original, unbounded".
 */
export const SIZE_PRESET_WIDTHS: Record<'thumb' | 'medium' | 'card' | 'hd' | 'wide', number> = {
    thumb: 250,
    medium: 350,
    card: 480,
    // Wide presets for full-bleed backdrops / hero sections. `card`→`full`(orig,
    // ~780w) leaves a large gap before native-resolution heroes; `hd` (1280) and
    // `wide` (1920) give bounded, cache-friendly 720p/1080p-class variants so
    // HiDPI heroes never pull an unbounded original or a raw `?width=` derivative.
    hd: 1280,
    wide: 1920,
};

/**
 * Resize a raw image buffer to the requested size preset and re-encode in the
 * target format (default WebP). Used by providers (local artwork, custom URLs)
 * that have no native size handling. Returns the original buffer untouched
 * when size is missing or `full`.
 *
 * Quality is read from config on each call so runtime changes take effect
 * without restart.
 *
 * Format fallback chain: format='avif' → AVIF, falling back to WebP if libheif
 * fails. format='webp' or undefined → WebP, falling back to JPEG if libwebp
 * fails. format='jpeg' → JPEG. The returned `contentType` always reflects what
 * was actually encoded so the caller never has to guess.
 *
 * Notes on Sharp:
 * - `.rotate()` (no args) reads EXIF orientation and bakes it into the pixels,
 *   so phone-uploaded portrait artwork doesn't display sideways.
 * - For animated GIF input we opt into `animated: true` so all frames are
 *   resized; libvips can encode animated WebP, and a static-only resize would
 *   silently strip animation.
 */
export async function resizeForPreset(
    buffer: Buffer,
    contentType: string,
    size?: string,
    format: 'webp' | 'avif' | 'jpeg' | 'png' = 'webp',
    /**
     * Custom/exact width (px). When provided this overrides the preset width
     * (used by the `?width=N` custom path and `?exact=true`). Takes priority
     * over `size`; `size` may be a sentinel like 'custom' in that case.
     */
    customMaxWidth?: number,
    /**
     * Explicit encode quality (1-100). When provided (custom/exact paths) it
     * overrides the per-tier config quality so `?quality=Q` is honored exactly.
     */
    qualityOverride?: number,
): Promise<{ buffer: Buffer; contentType: string }> {
    const maxWidth =
        customMaxWidth !== undefined
            ? customMaxWidth
            : size && size !== 'full'
              ? SIZE_PRESET_WIDTHS[size as 'thumb' | 'medium' | 'card' | 'hd' | 'wide']
              : undefined;
    // No resize target → return original untouched (size=full / unset / unknown).
    if (!maxWidth) return { buffer, contentType };
    const isThumbTier = size === 'thumb' || size === 'card';
    const webpQuality =
        qualityOverride ??
        (isThumbTier ? appConfig.IMAGE_THUMB_QUALITY : appConfig.IMAGE_FULL_QUALITY);
    const avifQuality =
        qualityOverride != null
            ? // Client passed a (snapped) WebP/JPEG-scale quality — remap to AVIF scale so
              // the AVIF encoder isn't over-driven (a WebP-85 request must not encode AVIF at 85).
              avifQualityForWebp(qualityOverride, isThumbTier)
            : isThumbTier
              ? appConfig.IMAGE_AVIF_THUMB_QUALITY
              : appConfig.IMAGE_AVIF_FULL_QUALITY;
    const isGif = contentType === 'image/gif';

    const buildPipeline = () =>
        sharp(buffer, { animated: isGif }).rotate().resize(maxWidth, undefined, {
            fit: 'inside',
            withoutEnlargement: true,
        });

    // Explicit JPEG/PNG paths — no fallback chain because the caller asked
    // for that specific format on purpose. Honor the request or fail loudly.
    if (format === 'jpeg') {
        try {
            const buf = await buildPipeline()
                .jpeg({ quality: webpQuality, mozjpeg: true })
                .toBuffer();
            return { buffer: buf, contentType: 'image/jpeg' };
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            logger.warn('JPEG resize failed; returning original', {
                size,
                error: error instanceof Error ? error.message : String(error),
            });
            return { buffer, contentType };
        }
    }
    if (format === 'png') {
        try {
            const buf = await buildPipeline().png().toBuffer();
            return { buffer: buf, contentType: 'image/png' };
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            logger.warn('PNG resize failed; returning original', {
                size,
                error: error instanceof Error ? error.message : String(error),
            });
            return { buffer, contentType };
        }
    }

    // Primary attempt: requested format.
    if (format === 'avif') {
        try {
            const buf = await buildPipeline().avif(getAvifOptions(avifQuality)).toBuffer();
            return { buffer: buf, contentType: 'image/avif' };
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            logger.warn('AVIF resize failed, falling back to WebP', {
                size,
                error: error instanceof Error ? error.message : String(error),
            });
            // fall through to webp
        }
    }
    try {
        const buf = await buildPipeline().webp(getWebPOptions(webpQuality)).toBuffer();
        return { buffer: buf, contentType: 'image/webp' };
    } catch (error) {
        if (error instanceof ImageWorkBudgetExceededError) throw error;
        logger.warn('WebP resize failed, attempting JPEG fallback', {
            size,
            error: error instanceof Error ? error.message : String(error),
        });
        try {
            const buf = await buildPipeline()
                .jpeg({ quality: Math.min(webpQuality, 70), mozjpeg: true })
                .toBuffer();
            return { buffer: buf, contentType: 'image/jpeg' };
        } catch (fallbackError) {
            if (fallbackError instanceof ImageWorkBudgetExceededError) throw fallbackError;
            logger.error(
                'Image resize fully failed; returning original (size budget will not be enforced)',
                fallbackError as Error,
                {
                    size,
                    primaryError: error instanceof Error ? error.message : String(error),
                },
            );
            return { buffer, contentType };
        }
    }
}

/**
 * Proxies an image request to an Arr* service (Sonarr, Radarr)
 * @param id - Media item ID
 * @param type - Image type (poster, banner, etc.)
 * @param config - Service configuration
 * @param url - Request URL for extracting quality param
 * @returns Response with image data or error
 */
export async function proxyArrImage(
    id: string,
    type: string,
    config: ImageProxyConfig,
    url?: URL,
): Promise<Response> {
    try {
        const imageUrl = `${config.serviceUrl}/api/v3/mediacover/${encodePathSegment(id)}/${encodePathSegment(type)}.jpg`;
        // Routed through the same-origin-only redirect guard (C22 fix-plan
        // finding) — Sonarr/Radarr are admin-configured, credentialed hosts.
        const response = await fetchWithTimeout(imageUrl, {
            headers: {
                'X-Api-Key': config.apiKey,
            },
        });

        if (!response.ok) {
            return new Response('Image not found', { status: 404 });
        }

        const originalBuffer = await readBoundedResponseBytes(response, MAX_ARR_IMAGE_BYTES);

        // Determine format based on config
        const useWebP = appConfig.IMAGE_WEBP_ENABLED;
        const contentType = useWebP
            ? 'image/webp'
            : response.headers.get('Content-Type') || 'image/jpeg';

        // Parse quality from URL param or use config default
        const quality = url ? parseQualityParam(url) : appConfig.IMAGE_THUMB_QUALITY;

        let outputBuffer: Buffer = originalBuffer;

        // Convert to WebP if enabled
        if (useWebP) {
            try {
                outputBuffer = await convertToWebP(originalBuffer, quality);
            } catch (e) {
                logger.debug('WebP conversion failed, using original buffer', {
                    error: e,
                });
            }
        }

        return new Response(new Uint8Array(outputBuffer), {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
            },
        });
    } catch (error) {
        if (error instanceof ImageWorkBudgetExceededError) throw error;
        console.error(`Failed fetching ${config.serviceName} Image:`, error);
        return new Response('Image not found', { status: 404 });
    }
}

/**
 * Proxies an image from a generic source with custom caching
 * @param imageBuffer - Pre-fetched image buffer
 * @param contentType - Image content type
 * @param maxAge - Cache max-age in seconds (default: 86400 = 24 hours)
 * @returns Response with image data
 */
export function createImageResponse(
    imageBuffer: ArrayBuffer,
    contentType: string,
    maxAge: number = 86400,
): Response {
    return new Response(imageBuffer, {
        headers: {
            'Content-Type': contentType,
            'Cache-Control': `public, max-age=${maxAge}`,
        },
    });
}
