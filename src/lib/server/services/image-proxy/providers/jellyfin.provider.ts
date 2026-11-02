// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Image Provider
 *
 * Handles Jellyfin image proxying with:
 * - File-based caching (14-day TTL)
 * - Fallback chains (Episode → Series, Audio → Album, etc.)
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import { restrictImageOptions } from '$lib/server/utils/image-params';
import { requireImageProviderBudget } from '../work-budget';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { fetchWithTimeout, FetchRedirectError } from '$lib/server/utils/fetch-utils.js';
import { selectImageFormat } from '$lib/server/utils/image-format';
import { getAvifOptions } from '$lib/server/utils/image-proxy';
import { ImageCache } from '../cache';
import { timePhase } from '../perf-context';
import { jellyfinMediaService } from '$lib/server/jellyfin';
import { getFallbackChain } from './jellyfin-fallback-strategy';
import type {
    ImageType,
    ImageResponse,
    ImageProvider,
    ImageOptions,
    ProviderImageRequest,
} from '../types';
import path from 'node:path';
import sharp from '$lib/server/services/image-proxy/image-sharp';
import { encodePathSegment, isSafePathSegment } from '$lib/server/utils/upstream-path';
import {
    canCallJellyfin,
    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS,
    recordJellyfinTransportFailure,
    recordJellyfinTransportSuccess,
} from '$lib/server/jellyfin/runtime-gate.js';

const logger = Logger.for('JellyfinImageProvider');

// Cache configuration
const CACHE_DIR = path.join(process.cwd(), '.cache', 'jellyfin');
const CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Allowed standard widths for Jellyfin image requests.
 * Any arbitrary maxWidth is snapped to the nearest value to prevent
 * cache fragmentation (e.g. 481px, 482px, 512px would all produce separate files).
 */
/**
 * Thrown instead of fetching when Jellyfin sync is off, Jellyfin is unreachable
 * or the breaker is open. Callers map it to "no image" without an error log —
 * it is a state, not a failure. Cached images are still served: the cache is
 * consulted before the fetch that throws this.
 */
export class JellyfinUnavailableError extends Error {
    constructor() {
        super('Jellyfin unavailable');
        this.name = 'JellyfinUnavailableError';
    }
}

const STANDARD_WIDTHS = [150, 300, 480, 720, 1280, 1920] as const;

/** Map ImageSize presets to maxWidth values for Jellyfin requests */
const SIZE_TO_MAX_WIDTH: Record<string, number> = {
    thumb: 250,
    medium: 350,
    card: 480,
    // 'full' intentionally omitted — no width constraint
};

/**
 * Snap an arbitrary pixel dimension (width or height) to the nearest standard size.
 * Rounds up to ensure the image is never smaller than requested.
 */
function normalizeDimension(value: string): string {
    const v = parseInt(value, 10);
    if (isNaN(v) || v <= 0) return '480';
    const snapped =
        STANDARD_WIDTHS.find((s) => s >= v) ?? STANDARD_WIDTHS[STANDARD_WIDTHS.length - 1];
    return String(snapped);
}

export class JellyfinImageProvider implements ImageProvider {
    readonly name = 'jellyfin';
    private cache: ImageCache;

    constructor() {
        this.cache = new ImageCache({
            directory: CACHE_DIR,
            ttl: CACHE_TTL,
        });
    }

    /**
     * Map image type to Jellyfin image type
     */
    private mapImageType(type: ImageType): string {
        const typeMap: Record<ImageType, string> = {
            poster: 'Primary',
            backdrop: 'Backdrop',
            logo: 'Logo',
            still: 'Primary', // Episode stills use Primary
            primary: 'Primary',
            thumb: 'Thumb',
            banner: 'Banner',
        };
        return typeMap[type] || 'Primary';
    }

    /**
     * Build Jellyfin image URL with query parameters
     */
    private buildJellyfinUrl(itemId: string, jellyfinType: string, options: ImageOptions): string {
        const params = new URLSearchParams();
        if (options.maxWidth) params.set('maxWidth', options.maxWidth);
        if (options.maxHeight) params.set('maxHeight', options.maxHeight);
        if (options.quality) params.set('quality', options.quality.toString());

        // Map format. Jellyfin's image API supports webp/png/jpg natively but
        // not AVIF, so for `avif` we ask Jellyfin for WebP and re-encode
        // locally in fetchJellyfinImage.
        const upstreamFormat =
            options.format === 'webp' || options.format === 'avif'
                ? 'webp'
                : options.format === 'png'
                  ? 'png'
                  : 'jpg';
        params.set('format', upstreamFormat);

        const queryString = params.toString() ? `?${params.toString()}` : '';
        return joinUpstreamUrl(
            config.JELLYFINURL,
            `/Items/${encodePathSegment(itemId)}/Images/${jellyfinType}${queryString}`,
        );
    }

    /**
     * Generate cache key. AVIF gets its own slot so AVIF and WebP variants
     * coexist for the same source image, with no collision.
     */
    private getCacheKey(itemId: string, jellyfinType: string, options: ImageOptions): string {
        const widthKey = options.maxWidth ? `-w${options.maxWidth}` : '';
        const heightKey = options.maxHeight ? `-h${options.maxHeight}` : '';
        const quality = options.quality || config.IMAGE_THUMB_QUALITY;
        const format =
            options.format === 'avif'
                ? 'avif'
                : options.format === 'webp'
                  ? 'webp'
                  : options.format === 'png'
                    ? 'png'
                    : 'jpg';
        return `${itemId}-${jellyfinType}${widthKey}${heightKey}${options.inherit === 'none' ? '-own' : ''}-q${quality}.${format}`;
    }

    /**
     * Fetch image from Jellyfin with fallback chains
     */
    private async fetchJellyfinImage(
        itemId: string,
        jellyfinType: string,
        options: ImageOptions,
    ): Promise<Buffer> {
        if (!canCallJellyfin()) {
            throw new JellyfinUnavailableError();
        }

        await requireImageProviderBudget();
        const headers = buildJellyfinAuthHeaders({ token: config.JELLYFINAPIKEY });

        // fetchWithTimeout THROWS (FetchRedirectError / FetchTimeoutError)
        // rather than returning a non-ok Response for a refused redirect or
        // a timeout — unlike a real non-ok HTTP response, an uncaught throw
        // here would skip the fallback chain below entirely (C22 fix round
        // 1: a cross-host 3xx from the configured Jellyfin server used to
        // abort image resolution outright instead of falling through to the
        // Series/Album/etc. fallback, same as a normal 404 would). Treat a
        // thrown guard error exactly like a non-ok response: null triggers
        // the same fallback path.
        let transportFailed = false;
        async function tryFetch(url: string): Promise<Response | null> {
            // Re-checked per attempt: the first timeout can open the breaker,
            // and the fallback chain must not then pay one timeout per step.
            if (!canCallJellyfin()) return null;
            try {
                const response = await fetchWithTimeout(
                    url,
                    { headers },
                    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS,
                );
                recordJellyfinTransportSuccess();
                return response;
            } catch (error) {
                recordJellyfinTransportFailure(error);
                if (!(error instanceof FetchRedirectError)) transportFailed = true;
                logger.debug('Jellyfin image fetch refused or timed out', {
                    url,
                    error: error instanceof Error ? error.message : String(error),
                });
                return null;
            }
        }

        // Try direct image first. Routed through the same-origin-only
        // redirect guard (C22 fix-plan finding) — carries the Jellyfin
        // admin token.
        let imageUrl = this.buildJellyfinUrl(itemId, jellyfinType, options);
        let response = await timePhase('jellyfin.upstream.headers', () => tryFetch(imageUrl));

        // If direct image fails, try fallback chains — unless the server did not
        // answer at all: the chain starts with an axios item lookup (10 s
        // timeout) and every step would time out the same way.
        if (!response?.ok && !transportFailed && options.inherit !== 'none') {
            logger.debug('Direct image failed, trying fallback', {
                itemId,
                jellyfinType,
            });

            // Get item info to determine fallback strategy
            const itemInfo = await jellyfinMediaService.getItemInfo(itemId);

            if (itemInfo) {
                // Get fallback chain from strategy
                const fallbacks = getFallbackChain(itemId, itemInfo.Type, jellyfinType, itemInfo);

                // Try each fallback in order
                for (const fallback of fallbacks) {
                    logger.debug(`Trying fallback: ${fallback.description}`, {
                        itemId: fallback.itemId,
                        imageType: fallback.imageType,
                    });

                    // The fallback id comes from Jellyfin's item info; one that
                    // cannot be a path segment only loses this fallback step.
                    if (!isSafePathSegment(fallback.itemId)) continue;
                    imageUrl = this.buildJellyfinUrl(fallback.itemId, fallback.imageType, options);
                    response = await tryFetch(imageUrl);

                    if (response?.ok) {
                        break; // Success - stop trying fallbacks
                    }
                }
            }
        }

        if (!response?.ok) {
            if (transportFailed || !canCallJellyfin()) throw new JellyfinUnavailableError();
            logger.warn('All image attempts failed', { itemId, jellyfinType });
            throw new Error('Image not found');
        }

        const upstreamBuffer = Buffer.from(
            await timePhase('jellyfin.upstream.body', () => response.arrayBuffer()),
        );

        // Jellyfin doesn't speak AVIF, so when AVIF was requested we fetched
        // WebP upstream and re-encode locally. This is the only Sharp work on
        // the Jellyfin path; cached on first request, free thereafter.
        // On encode failure we throw rather than caching WebP bytes under the
        // AVIF cache key — that bytes ≠ Content-Type mismatch is exactly the
        // bug a recent code review caught elsewhere. The wrapper in
        // ImageProxyService.getJellyfinImage will map the throw to null, and
        // the catalog endpoint will 404; the browser will then re-request
        // with its non-AVIF Accept on the next page load.
        if (options.format === 'avif') {
            const quality = options.quality ?? config.IMAGE_AVIF_THUMB_QUALITY;
            return await timePhase('jellyfin.encode.avif', () =>
                sharp(upstreamBuffer).avif(getAvifOptions(quality)).toBuffer(),
            );
        }

        return upstreamBuffer;
    }

    /**
     * Get Jellyfin image
     */
    async getImage(request: ProviderImageRequest): Promise<ImageResponse | null> {
        const { providerId: itemId, type } = request;

        // Map image type
        const jellyfinType = this.mapImageType(type);

        // Resolve size preset to maxWidth if not explicitly set
        const options = restrictImageOptions({ ...request.options });
        if (options.size && !options.maxWidth && options.size in SIZE_TO_MAX_WIDTH) {
            options.maxWidth = String(SIZE_TO_MAX_WIDTH[options.size]);
        }

        // Determine format first; then pick a format-aware quality default.
        const { format: imageFormat, contentType } = selectImageFormat(type, options.format);
        // Quality must reflect the chosen format AND size: AVIF q=50 ≈ WebP
        // q=75 perceptually. The previous code fixed quality to
        // IMAGE_THUMB_QUALITY (75) regardless of size or format, so AVIF
        // full-size images were encoded at WebP-thumb quality — wasted
        // bytes for the visual result the AVIF tier was sized for.
        const isThumbTier = options.size === 'thumb' || options.size === 'card';
        const quality =
            options.quality ??
            (imageFormat === 'avif'
                ? isThumbTier
                    ? config.IMAGE_AVIF_THUMB_QUALITY
                    : config.IMAGE_AVIF_FULL_QUALITY
                : isThumbTier
                  ? config.IMAGE_THUMB_QUALITY
                  : config.IMAGE_FULL_QUALITY);

        // Normalize width/height to standard sizes to prevent cache fragmentation.
        // Without this, maxWidth=480 and maxWidth=481 would create separate cache files.
        const normalizedWidth = options.maxWidth ? normalizeDimension(options.maxWidth) : undefined;
        const normalizedHeight = options.maxHeight
            ? normalizeDimension(options.maxHeight)
            : undefined;

        // Build options with format
        const fetchOptions: ImageOptions = {
            ...options,
            maxWidth: normalizedWidth,
            maxHeight: normalizedHeight,
            quality,
            format: imageFormat,
        };

        // Generate cache key
        const cacheKey = this.getCacheKey(itemId, jellyfinType, fetchOptions);

        // Get from cache or fetch
        const { buffer, wasHit } = await this.cache.getCachedOrFetch(
            cacheKey,
            () => this.fetchJellyfinImage(itemId, jellyfinType, fetchOptions),
            { provider: true, encode: imageFormat === 'avif' },
        );

        return {
            buffer,
            contentType,
            cacheControl: 'public, max-age=604800',
            cacheStatus: wasHit ? 'HIT' : 'MISS',
        };
    }
}
