// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB Image Provider
 *
 * Handles TMDB image fetching with:
 * - In-memory details cache (180-day TTL)
 * - File-based image cache
 * - Rate limiting (100ms between requests)
 * - Episode still DB lookup
 * - WebP conversion
 */

import { restrictImageOptions } from '$lib/server/utils/image-params';
import {
    ImageWorkBudgetExceededError,
    hasImageWorkBudget,
    isRestrictedImageRequest,
    requireImageProviderBudget,
} from '../work-budget';
import { isProviderImagePath } from '$lib/server/utils/provider-image-path.js';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { fetchWithTimeout, TIMEOUTS } from '$lib/server/utils/fetch-utils';
import { getAvifOptions, getWebPOptions, SIZE_PRESET_WIDTHS } from '$lib/server/utils/image-proxy';
import { selectImageFormat } from '$lib/server/utils/image-format';
import { ImageCache } from '../cache';
import { recordPhase, timePhase } from '../perf-context';
import { isEpisode, isSeason, isSeries } from '$lib/server/utils/media-types';
import { UUID_RE } from '$lib/utils/id-patterns';
import type {
    ImageType,
    ImageResponse,
    ImageProvider,
    MediaType,
    ImageOptions,
    ProviderImageRequest,
} from '../types';
import sharp from '$lib/server/services/image-proxy/image-sharp';
import type postgres from 'postgres';
import path from 'node:path';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { tmdbAuthorizedRequest } from '$lib/server/providers/implementations/tmdb/auth.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';

const logger = Logger.for('TmdbImageProvider');

/**
 * Read LIVE on every call — never captured into a module constant.
 *
 * `config.TMDB_API_KEY` is a getter resolving settings.json -> env -> default at
 * call time. A module-scope `const` froze it at process boot, so a key entered
 * in the admin UI afterwards never took effect until a restart. Season posters
 * were the visible casualty: they are the only artwork slot with no stored path
 * and no local generator, so they alone need a live call, and the guard below
 * returned early before ever reaching the season branch.
 */
const tmdbApiKey = (): string => config.TMDB_API_KEY;

/**
 * Size variant definitions for pre-generating cached image sizes.
 * When a poster/backdrop is first fetched, all 3 variants are generated
 * from the original so subsequent requests for any size are cache hits.
 *
 * maxWidth controls the Sharp resize; quality is resolved at runtime from
 * config to ensure cache keys match future requests exactly.
 */
interface SizeVariant {
    name: 'thumb' | 'medium' | 'card' | 'hd' | 'wide' | 'full';
    maxWidth?: number;
}
const SIZE_VARIANTS: SizeVariant[] = [
    { name: 'thumb', maxWidth: 250 },
    { name: 'medium', maxWidth: 350 },
    { name: 'card', maxWidth: 480 },
    { name: 'full' },
];

// Cache directories
const CACHE_DIR = path.join(process.cwd(), '.cache', 'tmdb');
const CACHE_TTL = config.TMDB_METADATA_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const EPISODE_DB_CACHE_TTL = 5 * 60 * 1000; // 5 minutes for episode DB queries

type EpisodeInfoRow = {
    series_tmdb_id: string | null;
    season_number: number | null;
    episode_number: number | null;
    title: string | null;
    // Content-matched still_path persisted at reconciliation/apply (preferred over
    // resolving by local season/episode number, which is wrong for releases whose
    // numbering does not match TMDB). Null when none has been stored.
    stored_still_path: string | null;
};

type SeasonInfoRow = {
    series_tmdb_id: string | null;
    season_number: number | null;
    title: string | null;
};

// Short-lived cache for episode database lookups
interface EpisodeDbCache {
    episodeInfo: EpisodeInfoRow | null;
    cachedAt: number;
}

interface SeasonDbCache {
    seasonInfo: SeasonInfoRow | null;
    cachedAt: number;
}

type EpisodeDetailsResponse = {
    still_path?: string | null;
    name?: string;
};

export class TmdbImageProvider implements ImageProvider {
    readonly name = 'tmdb';
    private cache: ImageCache;
    private episodeDbCache = new Map<string, EpisodeDbCache>();
    private seasonDbCache = new Map<string, SeasonDbCache>();
    private readonly MAX_CACHE_ENTRIES = 10000; // FIFO eviction threshold

    constructor(private sql: postgres.Sql) {
        this.cache = new ImageCache({
            directory: CACHE_DIR,
            ttl: CACHE_TTL,
        });
    }

    /**
     * Evict oldest entries from episode DB cache when limit is reached
     */
    private evictOldestCacheEntries(): void {
        if (this.episodeDbCache.size > this.MAX_CACHE_ENTRIES) {
            const toRemove = Math.floor(this.MAX_CACHE_ENTRIES * 0.1);
            let removed = 0;
            for (const key of this.episodeDbCache.keys()) {
                this.episodeDbCache.delete(key);
                if (++removed >= toRemove) break;
            }

            logger.debug('Evicted old episode DB cache entries', {
                removed,
                remaining: this.episodeDbCache.size,
            });
        }

        if (this.seasonDbCache.size > this.MAX_CACHE_ENTRIES) {
            const toRemove = Math.floor(this.MAX_CACHE_ENTRIES * 0.1);
            let removed = 0;
            for (const key of this.seasonDbCache.keys()) {
                this.seasonDbCache.delete(key);
                if (++removed >= toRemove) break;
            }

            logger.debug('Evicted old season DB cache entries', {
                removed,
                remaining: this.seasonDbCache.size,
            });
        }
    }

    /**
     * Get image path from TMDB API (via cached plugin)
     */
    private async getImagePath(
        tmdbId: string,
        mediaType: MediaType,
        type: ImageType,
        options: ImageOptions,
    ): Promise<string | null> {
        // If path is provided directly, skip API lookup
        const providedPath = options.path;
        if (providedPath) {
            return isProviderImagePath(providedPath) ? providedPath : null;
        }

        // Check if TMDB API key is configured
        if (!tmdbApiKey()) {
            return null;
        }

        // Special handling for episode stills. UI episode thumbnails use the
        // generic `thumb` slot, but TMDB exposes those images as `still_path`.
        if ((type === 'still' || type === 'thumb') && isEpisode(mediaType)) {
            return await this.getEpisodeStillPath(options.catalogId ?? tmdbId);
        }

        // Episode IDs live in their own TMDB namespace. If there is no direct
        // image path and the request is not for a still/thumb, do not treat the
        // numeric ID as a movie ID; TV and movie IDs can legitimately collide.
        if (isEpisode(mediaType)) {
            return null;
        }

        if (isSeason(mediaType)) {
            if (type !== 'poster' || !options.catalogId) return null;
            return await this.getSeasonPosterPath(options.catalogId);
        }

        // Movie/TV series handling
        if (!tmdbApi.isAvailable()) {
            logger.warn('TMDB API not available for image path lookup');
            return null;
        }

        try {
            const numericId = parseInt(tmdbId, 10);
            if (isNaN(numericId)) return null;

            await requireImageProviderBudget();
            // Fetch details via the canonical TMDB client (deduped + rate-limited)
            const details = isSeries(mediaType)
                ? await tmdbApi.getTVShowDetails(numericId)
                : await tmdbApi.getMovieDetails(numericId);

            const posterPath = details.poster_path ?? null;
            const backdropPath = details.backdrop_path ?? null;

            // Get logo from images
            const logos = details.images?.logos ?? [];
            const englishLogo = logos.find(
                (logo: { iso_639_1?: string | null }) => logo.iso_639_1 === 'en',
            );
            const anyLogo = logos[0];
            const logoPath =
                (englishLogo as { file_path?: string | null } | undefined)?.file_path ||
                (anyLogo as { file_path?: string | null } | undefined)?.file_path ||
                null;

            // Get the appropriate image path based on type
            if (type === 'backdrop') {
                return backdropPath;
            } else if (type === 'logo') {
                return logoPath;
            } else {
                return posterPath;
            }
        } catch (error) {
            if (error instanceof ImageWorkBudgetExceededError) throw error;
            logger.error(
                'Failed to get TMDB image path via plugin',
                error instanceof Error ? error : undefined,
                { tmdbId, mediaType, type },
            );
            return null;
        }
    }

    /**
     * Get season poster path from parent series TMDB ID + local season number.
     */
    private async getSeasonPosterPath(seasonItemId: string): Promise<string | null> {
        // Composite-key cache key: the media-type discriminator ('season') is
        // baked in so a raw external ID shared across media types cannot poison
        // this cache (the DB query below is likewise scoped to media_type='season').
        const dbCacheKey = `season-db-season-${seasonItemId}`;
        const dbCached = this.seasonDbCache.get(dbCacheKey);
        let seasonRow: SeasonInfoRow | null = null;

        if (dbCached && Date.now() - dbCached.cachedAt < EPISODE_DB_CACHE_TTL) {
            seasonRow = dbCached.seasonInfo;
            logger.debug('Season DB cache hit', { seasonItemId });
        } else {
            const seasonInfo = await this.sql<SeasonInfoRow[]>`
				SELECT
					tmdb_series.external_id as series_tmdb_id,
					season.season_number,
					season.title
				FROM media_items season
				JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
				LEFT JOIN external_ids tmdb_series ON tmdb_series.media_id = series.id AND tmdb_series.provider = 'tmdb' AND tmdb_series.media_type = 'tv'
				WHERE season.id = ${seasonItemId}
				  AND season.media_type = 'season'
				LIMIT 1
			`.catch((err) => {
                logger.debug('Failed to query season metadata', {
                    seasonItemId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return [];
            });

            seasonRow = seasonInfo[0] ?? null;
            this.evictOldestCacheEntries();
            this.seasonDbCache.set(dbCacheKey, {
                seasonInfo: seasonRow,
                cachedAt: Date.now(),
            });
        }

        if (!seasonRow?.series_tmdb_id || seasonRow.season_number === null) {
            return null;
        }

        if (!tmdbApi.isAvailable()) {
            logger.warn('TMDB API not available for season image lookup');
            return null;
        }

        const numericSeriesId = parseInt(seasonRow.series_tmdb_id, 10);
        if (isNaN(numericSeriesId)) return null;

        await requireImageProviderBudget();
        const seasons = await tmdbApi.getTVShowSeasons(numericSeriesId);
        return (
            seasons.find((season) => season.seasonNumber === seasonRow.season_number)?.posterPath ??
            null
        );
    }

    /**
     * Get episode still path from DB + TMDB API
     */
    private async getEpisodeStillPath(episodeKey: string): Promise<string | null> {
        // Composite-key cache key: the media-type discriminator ('episode') is
        // baked in so a raw external ID shared across media types cannot poison
        // this cache (the DB query below is likewise scoped to media_type='episode').
        const dbCacheKey = `episode-db-episode-${episodeKey}`;
        const dbCached = this.episodeDbCache.get(dbCacheKey);
        let episodeRow: EpisodeInfoRow | null = null;

        if (dbCached && Date.now() - dbCached.cachedAt < EPISODE_DB_CACHE_TTL) {
            episodeRow = dbCached.episodeInfo;
            logger.debug('Episode DB cache hit', { episodeKey });
        } else {
            // Query database for episode metadata.
            //
            // Resolves the target episode's id FIRST, in its own CTE, before
            // joining out to season/series/tmdb_series -- rather than filtering
            // `WHERE ep.id::text = $1 OR ei.external_id = $1` on the fully
            // joined row set. That OR spans two different tables (ep, ei), so
            // Postgres could not use either side's index to drive the scan and
            // instead walked the ENTIRE episode hierarchy (idx_media_items_
            // episode_order across every season, ~47k episode rows on prod)
            // before ever checking the id/external_id match -- 224-557ms on
            // prod (EXPLAIN ANALYZE) for what is always a single-row lookup.
            // The UUID branch is chosen in JS, not guarded in SQL: an AND of a
            // regex check with `$1::uuid` does not stop Postgres casting a bound
            // parameter (it can constant-fold the cast at plan time), so a TMDB
            // episode id would throw instead of falling through. With a uuid key
            // `ep.id = $1::uuid` reaches the primary key; either way the second
            // branch reaches `ei.external_id` via its own index.
            // Prod EXPLAIN ANALYZE after: 1.2ms, identical row returned.
            const key = String(episodeKey);
            const byId = UUID_RE.test(key)
                ? this.sql`
					SELECT ep.id
					FROM media_items ep
					WHERE ep.media_type = 'episode'
					  AND ep.id = ${key}::uuid
					UNION`
                : this.sql``;
            const episodeInfo = await this.sql<EpisodeInfoRow[]>`
				WITH matched_ep AS (
					${byId}
					SELECT ei.media_id AS id
					FROM external_ids ei
					JOIN media_items ep2 ON ep2.id = ei.media_id AND ep2.media_type = 'episode'
					WHERE ei.provider = 'tmdb' AND ei.media_type = 'episode'
					  AND ei.external_id = ${key}
				)
				SELECT
					tmdb_series.external_id as series_tmdb_id,
					ep.season_number,
					ep.episode_number,
					ep.title,
					(
						SELECT pm.metadata->>'still_path'
						FROM provider_metadata pm
						WHERE pm.media_id = ep.id AND pm.provider = 'tmdb' AND pm.metadata ? 'still_path'
						LIMIT 1
					) AS stored_still_path
				FROM matched_ep me
				JOIN media_items ep ON ep.id = me.id
				JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
				JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
				LEFT JOIN external_ids tmdb_series ON tmdb_series.media_id = series.id AND tmdb_series.provider = 'tmdb' AND tmdb_series.media_type = 'tv'
				LIMIT 1
			`.catch((err) => {
                logger.debug('Failed to query episode metadata', {
                    episodeKey,
                    error: err instanceof Error ? err.message : String(err),
                });
                return [];
            });

            if (episodeInfo && episodeInfo.length > 0) {
                episodeRow = episodeInfo[0];

                // Cache the DB result for 5 minutes
                this.evictOldestCacheEntries();
                this.episodeDbCache.set(dbCacheKey, {
                    episodeInfo: episodeRow,
                    cachedAt: Date.now(),
                });
                logger.debug('Cached episode DB metadata', { episodeKey });
            } else {
                // Cache null result to avoid repeated failed queries
                this.evictOldestCacheEntries();
                this.episodeDbCache.set(dbCacheKey, {
                    episodeInfo: null,
                    cachedAt: Date.now(),
                });
            }
        }

        if (!episodeRow) {
            return null;
        }

        // Prefer the content-matched still_path persisted by reconciliation/apply.
        // The by-(season,episode)-number fetch below addresses the TMDB episode at
        // the LOCAL number, which is the WRONG episode for releases whose numbering
        // doesn't match TMDB (e.g. German "Recess"). A stored still_path always
        // belongs to the episode's actual matched TMDB episode, so it wins.
        if (episodeRow.stored_still_path) {
            return episodeRow.stored_still_path;
        }

        const { series_tmdb_id, season_number, episode_number } = episodeRow;

        if (!series_tmdb_id || season_number === null || episode_number === null) {
            return null;
        }

        // Fetch from TMDB API (episode stills endpoint not covered by plugin)
        const episodeUrl = `https://api.themoviedb.org/3/tv/${series_tmdb_id}/season/${season_number}/episode/${episode_number}`;

        const request = tmdbAuthorizedRequest(episodeUrl, tmdbApiKey(), {
            'Content-Type': 'application/json',
        });
        await requireImageProviderBudget();
        const episodeResponse = await trackExternalCall(request.url, () =>
            fetchWithTimeout(request.url, { headers: request.headers }, TIMEOUTS.MEDIUM),
        );

        if (!episodeResponse.ok) {
            return null;
        }

        const episode = (await episodeResponse.json()) as EpisodeDetailsResponse;
        return episode.still_path ?? null;
    }

    /**
     * Determine TMDB image size based on type and requested size
     */
    private getImageSize(type: ImageType, requestedSize?: string): string {
        if (type === 'backdrop') {
            return requestedSize === 'thumb' ? 'w780' : 'w1280';
        } else if (type === 'still') {
            return requestedSize === 'thumb' ? 'w300' : 'w780';
        } else if (type === 'logo') {
            return 'w500';
        } else {
            // Poster
            return requestedSize === 'thumb' ? 'w342' : 'w500';
        }
    }

    /**
     * Generate cache key for file cache.
     * Includes the logical size name (thumb/medium/full) to differentiate
     * variants that share the same TMDB CDN size (e.g. medium and full both use w500).
     *
     * Prefers the internal Lumastra UUID (`catalogId`) over the TMDB ID when
     * available: TMDB IDs are not unique across media types (movie 1429 ≠ TV 1429),
     * while the UUID is guaranteed unique. Falls back to `tmdbId` when no
     * `catalogId` is provided (e.g. direct path lookups or legacy callers).
     */
    private getCacheKey(
        tmdbId: string,
        mediaType: MediaType,
        type: ImageType,
        imageSize: string,
        quality: number,
        outputFormat: string,
        providedPath?: string | null,
        sizeName?: string,
        catalogId?: string,
    ): string {
        // When path is provided directly (e.g., for episode stills), use path in cache key.
        // Otherwise prefer the internal UUID (collision-safe) over the raw TMDB ID.
        const cacheId = providedPath
            ? providedPath.replace(/[^a-zA-Z0-9]/g, '_')
            : (catalogId ?? tmdbId);
        const sizeSegment = sizeName ? `${sizeName}-${imageSize}` : imageSize;
        // Older PNG entries could contain an unchanged SVG/JPEG from TMDB.
        // Give the corrected raster output its own key, including warm caches.
        const formatRevision = outputFormat === 'png' ? '-raster2' : '';
        return `${mediaType}-${cacheId}-${type}-${sizeSegment}-q${quality}${formatRevision}.${outputFormat}`;
    }

    /**
     * Fetch and convert image
     */
    private async fetchAndConvertImage(
        imagePath: string,
        imageSize: string,
        type: ImageType,
        quality: number,
        outputFormat: string,
    ): Promise<Buffer> {
        // Fetch from TMDB image CDN (no API rate limiting needed)
        const imageUrl = `https://image.tmdb.org/t/p/${imageSize}${imagePath}`;
        await requireImageProviderBudget();
        const imageResponse = await trackExternalCall(imageUrl, () =>
            fetchWithTimeout(imageUrl, {}, TIMEOUTS.MEDIUM),
        );

        if (!imageResponse.ok) {
            logger.error('TMDB image fetch failed', undefined, {
                status: imageResponse.status,
                imageUrl,
            });
            throw new Error('Image not found');
        }

        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

        // Convert to requested format
        let outputBuffer: Buffer;
        if (outputFormat === 'avif') {
            // No silent fallback to WebP here: the caller's response will be
            // labeled image/avif via selectImageFormat, and serving WebP
            // bytes under that header is the bytes ≠ Content-Type bug a
            // recent code review caught. Instead we throw — the cache layer
            // (getCachedOrFetch) won't poison the entry, the wrapper in
            // service.ts maps to null, and the catalog endpoint 404s so the
            // browser will fall back to its non-AVIF Accept on the next
            // page load.
            outputBuffer = await sharp(imageBuffer).avif(getAvifOptions(quality)).toBuffer();
        } else if (outputFormat === 'webp') {
            outputBuffer = await sharp(imageBuffer).webp(getWebPOptions(quality)).toBuffer();
        } else if (type === 'logo' || outputFormat === 'png') {
            // TMDB logos can be SVG. Native image decoders need actual PNG
            // pixels; relabeling the upstream bytes does not convert them.
            outputBuffer = await sharp(imageBuffer).png().toBuffer();
        } else {
            // Apply JPEG quality optimization
            outputBuffer = await sharp(imageBuffer).jpeg({ quality }).toBuffer();
        }

        return outputBuffer;
    }

    /**
     * Whether to pre-generate all size variants for this image type.
     * Only posters and backdrops benefit — logos need PNG transparency,
     * and stills are fetched at episode-specific paths.
     */
    private shouldPreGenerateVariants(type: ImageType): boolean {
        return type === 'poster' || type === 'backdrop';
    }

    /**
     * Resolve quality for a given size the same way getImage does,
     * so pre-generated cache keys match future request cache keys.
     *
     * Format matters: AVIF q=50 ≈ WebP q=75 perceptually, so we read separate
     * config knobs per format. Caller passes the variant size name.
     */
    private getQualityForSize(
        sizeName: string,
        outputFormat: string,
        explicitQuality?: number,
    ): number {
        if (explicitQuality !== undefined) return explicitQuality;
        const isThumbTier = sizeName === 'thumb' || sizeName === 'card';
        if (outputFormat === 'avif') {
            return isThumbTier ? config.IMAGE_AVIF_THUMB_QUALITY : config.IMAGE_AVIF_FULL_QUALITY;
        }
        return isThumbTier ? config.IMAGE_THUMB_QUALITY : config.IMAGE_FULL_QUALITY;
    }

    /**
     * Write one pre-generated variant to disk under its format-specific cache
     * key. Fire-and-forget — a missed write just costs one extra encode on
     * the next request, not correctness.
     */
    private writeVariantToCache(
        tmdbId: string,
        mediaType: MediaType,
        type: ImageType,
        imagePath: string,
        variant: { sizeName: string; quality: number; buffer: Buffer },
        outputFormat: string,
        catalogId?: string,
    ): void {
        const variantTmdbSize = this.getImageSize(
            type,
            variant.sizeName === 'full' ? undefined : variant.sizeName,
        );
        const variantCacheKey = this.getCacheKey(
            tmdbId,
            mediaType,
            type,
            variantTmdbSize,
            variant.quality,
            outputFormat,
            imagePath,
            variant.sizeName,
            catalogId,
        );
        this.cache.write(variantCacheKey, variant.buffer).catch(() => {});
    }

    /**
     * Generate all size variants from an original buffer in the requested
     * format. AVIF encode failures for an individual variant are logged and
     * skipped so a single bad variant doesn't poison the whole batch.
     * Returns the buffer for the requested size and cache entries for all
     * successfully encoded variants.
     */
    private async generateVariants(
        originalBuffer: Buffer,
        requestedSize: string,
        outputFormat: string,
    ): Promise<{
        requested: Buffer | null;
        variants: Array<{ sizeName: string; quality: number; buffer: Buffer }>;
    }> {
        const variants: Array<{
            sizeName: string;
            quality: number;
            buffer: Buffer;
        }> = [];
        let requestedBuffer: Buffer | null = null;

        // `hd` / `wide` are real presets (hero backdrops ask for `wide` in
        // their 1920w srcset) but not part of the eager set. Without encoding
        // the requested one here, every cold `wide` request found no buffer
        // and answered with no image at all.
        const toEncode: SizeVariant[] = SIZE_VARIANTS.some((v) => v.name === requestedSize)
            ? SIZE_VARIANTS
            : requestedSize === 'hd' || requestedSize === 'wide'
              ? [
                    ...SIZE_VARIANTS,
                    { name: requestedSize, maxWidth: SIZE_PRESET_WIDTHS[requestedSize] },
                ]
              : SIZE_VARIANTS;

        for (const variant of toEncode) {
            const quality = this.getQualityForSize(variant.name, outputFormat);
            let pipeline = sharp(originalBuffer);
            if (variant.maxWidth) {
                pipeline = pipeline.resize(variant.maxWidth, undefined, {
                    fit: 'inside',
                    withoutEnlargement: true,
                });
            }

            let buffer: Buffer;
            try {
                if (outputFormat === 'avif') {
                    buffer = await pipeline.avif(getAvifOptions(quality)).toBuffer();
                } else if (outputFormat === 'webp') {
                    buffer = await pipeline.webp(getWebPOptions(quality)).toBuffer();
                } else {
                    buffer = await pipeline.jpeg({ quality }).toBuffer();
                }
            } catch (err) {
                logger.warn('Variant encode failed, skipping', {
                    size: variant.name,
                    format: outputFormat,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            if (variant.name === requestedSize) {
                requestedBuffer = buffer;
            }
            variants.push({ sizeName: variant.name, quality, buffer });
        }

        return { requested: requestedBuffer, variants };
    }

    /**
     * Get TMDB image
     */
    async getImage(request: ProviderImageRequest): Promise<ImageResponse | null> {
        const { providerId: tmdbId, type, mediaType } = request;
        const options = restrictImageOptions(request.options);

        if (!mediaType) {
            throw new Error('mediaType is required for TMDB images');
        }

        // Validate media type
        if (!['movie', 'tv', 'season', 'episode'].includes(mediaType)) {
            throw new Error(`Invalid media type: ${mediaType}`);
        }

        const effectiveType = type === 'thumb' && isEpisode(mediaType) ? 'still' : type;

        // Get image path from API
        const imagePath = await this.getImagePath(tmdbId, mediaType, effectiveType, options);

        if (!imagePath) {
            return null;
        }

        // Determine output format and quality using centralized utility
        const { format: outputFormat, contentType } = selectImageFormat(
            effectiveType,
            options.format,
        );

        // Quality must be format-aware: AVIF q=50 ≈ WebP q=75 perceptually,
        // and the cache key includes both quality AND format. If we always
        // baked the WebP quality into the key (the previous behavior), the
        // pre-gen path would write AVIF variants under keys like
        // `...-q50.avif` (via writeVariantToCache → getQualityForSize) but
        // future requests would look up `...-q75.avif`, perpetually missing.
        // Use the same getQualityForSize() that the variant writer uses.
        const requestedSizeForQuality = options.size ?? 'full';
        const quality =
            options.quality ?? this.getQualityForSize(requestedSizeForQuality, outputFormat);

        // Get image size
        const imageSize = this.getImageSize(effectiveType, options.size);
        const requestedSize = options.size || 'full';

        // For pre-generable types, include size name in cache key to
        // differentiate medium vs full (both use the same TMDB CDN size).
        // Skip pre-generation when an explicit quality override is provided
        // since the variants would use config-derived quality values.
        const preGen =
            this.shouldPreGenerateVariants(effectiveType) &&
            options.quality === undefined &&
            !(hasImageWorkBudget() && isRestrictedImageRequest());

        // Generate cache key — prefer the internal UUID (options.catalogId) over
        // the raw TMDB ID so that two different media types sharing the same TMDB
        // numeric ID can never collide in the file cache.
        const cacheKey = this.getCacheKey(
            tmdbId,
            mediaType,
            effectiveType,
            imageSize,
            quality,
            outputFormat,
            imagePath,
            preGen ? requestedSize : undefined,
            options.catalogId,
        );

        // Pre-generate all size variants on first fetch for posters/backdrops
        if (preGen) {
            // Check if the requested size is already cached
            const readStart = performance.now();
            const cached = await this.cache.read(cacheKey);
            recordPhase('cache.read', performance.now() - readStart);
            if (cached) {
                return {
                    buffer: cached,
                    contentType,
                    cacheControl: 'public, max-age=648000',
                    cacheStatus: 'HIT',
                };
            }

            // Fetch the original at the largest TMDB size (no resize constraints)
            const fullImageSize = this.getImageSize(effectiveType, 'full');
            const imageUrl = `https://image.tmdb.org/t/p/${fullImageSize}${imagePath}`;
            await requireImageProviderBudget();
            const imageResponse = await timePhase('tmdb.upstream.headers', () =>
                trackExternalCall(imageUrl, () => fetchWithTimeout(imageUrl, {}, TIMEOUTS.MEDIUM)),
            );

            if (!imageResponse.ok) {
                logger.error('TMDB image fetch failed', undefined, {
                    status: imageResponse.status,
                    imageUrl,
                });
                return null;
            }

            const originalBuffer = Buffer.from(
                await timePhase('tmdb.upstream.body', () => imageResponse.arrayBuffer()),
            );

            // Generate variants in the requested format.
            const { requested, variants } = await timePhase(`tmdb.encode.${outputFormat}`, () =>
                this.generateVariants(originalBuffer, requestedSize, outputFormat),
            );

            if (!requested) {
                logger.warn('TMDB requested-variant encode failed; no buffer to return', {
                    tmdbId,
                    type: effectiveType,
                    size: requestedSize,
                    format: outputFormat,
                });
                return null;
            }

            // Cache the requested variant (fire-and-forget — losing this write
            // costs one extra origin fetch later, not correctness).
            this.cache.write(cacheKey, requested).catch(() => {});

            // Fire-and-forget cache writes for the other variants we generated.
            for (const variant of variants) {
                if (variant.sizeName === requestedSize) continue;
                this.writeVariantToCache(
                    tmdbId,
                    mediaType,
                    effectiveType,
                    imagePath,
                    variant,
                    outputFormat,
                    options.catalogId,
                );
            }

            // Eager AVIF/WebP cross-pre-gen: when AVIF is enabled and pre-gen
            // mode is 'eager', also encode the *other* format for every size
            // so the next AVIF-accepting (or non-accepting) client gets a hit
            // instead of paying a cold encode. Lazy mode skips this — AVIF is
            // generated on demand when the first AVIF client requests it.
            if (
                !hasImageWorkBudget() &&
                config.IMAGE_AVIF_ENABLED &&
                config.IMAGE_AVIF_PREGEN_MODE === 'eager' &&
                (outputFormat === 'webp' || outputFormat === 'avif')
            ) {
                const altFormat = outputFormat === 'webp' ? 'avif' : 'webp';
                // Run alt-format generation off the critical path. Errors are
                // already swallowed inside generateVariants per-variant.
                void this.generateVariants(originalBuffer, requestedSize, altFormat).then(
                    ({ variants: altVariants }) => {
                        for (const variant of altVariants) {
                            this.writeVariantToCache(
                                tmdbId,
                                mediaType,
                                effectiveType,
                                imagePath,
                                variant,
                                altFormat,
                                options.catalogId,
                            );
                        }
                    },
                );
            }

            return {
                buffer: requested,
                contentType,
                cacheControl: 'public, max-age=648000',
                cacheStatus: 'MISS',
            };
        }

        // Non-pregenerated types: use standard single-key cache flow
        const { buffer, wasHit } = await this.cache.getCachedOrFetch(
            cacheKey,
            () =>
                this.fetchAndConvertImage(
                    imagePath,
                    imageSize,
                    effectiveType,
                    quality,
                    outputFormat,
                ),
            { provider: true, encode: true },
        );

        return {
            buffer,
            contentType,
            cacheControl: 'public, max-age=648000',
            cacheStatus: wasHit ? 'HIT' : 'MISS',
        };
    }
}
