import type { ImageProvider as ImageCandidateProvider } from '$lib/schemas/image-candidates.js';
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ImageProxyService Types
 *
 * Shared interfaces for the image proxy service and providers.
 */

export type ImageType = 'poster' | 'backdrop' | 'logo' | 'still' | 'primary' | 'banner' | 'thumb';

/**
 * Configurable image provider types for the catalog fallback chain.
 * `jellyfin` remains a valid provider (operators who serve art from a
 * Jellyfin server can opt in via the IMAGE_PROVIDER_PRIORITY config), it is
 * just no longer in the DEFAULT chain — see below.
 */
export type ImageProviderType = 'local' | 'generic' | 'tmdb' | 'jellyfin' | 'custom';

/**
 * Default provider priority order. Jellyfin is intentionally NOT here: it is a
 * watch-sync integration, not an image source, so including it only walked a
 * dead fallback leg on every cache miss. Operators who do serve images from
 * Jellyfin can restore it explicitly via the IMAGE_PROVIDER_PRIORITY config;
 * the jellyfin-direct fallback for unsynced Jellyfin UUIDs (see
 * _getImageByCatalogIdImpl) is separate and unaffected.
 */
export const DEFAULT_IMAGE_PROVIDER_PRIORITY: ImageProviderType[] = [
    'local',
    'generic',
    'tmdb',
    'custom',
];
export type ImageSize = 'thumb' | 'medium' | 'card' | 'hd' | 'wide' | 'full';
export type ImageFormat = 'webp' | 'avif' | 'jpg' | 'png';
export type MediaType = 'movie' | 'tv' | 'episode' | 'season';

export interface ImageOptions {
    /** Requested URL version partitions in-flight work; it never proves byte identity. */
    revision?: string;
    /** Disable all ancestor artwork resolution. */
    inherit?: 'none';
    index?: number;
    size?: ImageSize;
    quality?: number;
    format?: ImageFormat;
    maxWidth?: string;
    maxHeight?: string;
    path?: string; // Direct image path (optimization to skip API lookup)
    catalogId?: string; // Internal Lumastra UUID for providers that need hierarchy context
    /** Raw size string for providers with their own size vocabulary (e.g. TMDB person: 'w45', 'w185') */
    rawSize?: string;
    /**
     * True when this derivative is a BOUNDED preset variant (a named `size`, or a
     * `?width=N` that snapped onto a preset) — i.e. one of the small, fixed set
     * of cache-friendly sizes. The response layer marks revisioned bounded variants
     * `immutable`; custom/exact variants stay normally cached. Defaults to false
     * (treat as custom) when unset so non-snapping callers never over-cache.
     */
    bounded?: boolean;
    /**
     * True when the caller passed `?exact=true` — width + quality snapping were
     * bypassed and the precise requested values are used. Exact derivatives are
     * never `bounded`/immutable and get their own distinct cache key.
     */
    exact?: boolean;
    /**
     * Fetch a 32-hex id that maps to no catalog item, or a `jellyfin:` composite
     * key, straight from the Jellyfin server. Off by default: no library or age
     * check can apply to it, and the Jellyfin server may hold items Lumastra
     * hides. Only an admin caller may set it.
     */
    allowUnmappedJellyfinFetch?: boolean;
}

/** Kavita image types mapped to their API endpoint and parameter name */
export const KAVITA_TYPE_CONFIG: Record<string, { endpoint: string; param: string }> = {
    series: { endpoint: 'series-cover', param: 'seriesId' },
    collection: { endpoint: 'collection-cover', param: 'collectionTagId' },
    readinglist: { endpoint: 'readinglist-cover', param: 'readingListId' },
    person: { endpoint: 'person-cover', param: 'personId' },
    volume: { endpoint: 'volume-cover', param: 'volumeId' },
    chapter: { endpoint: 'chapter-cover', param: 'chapterId' },
};

export interface ImageResponse {
    /** Proven byte revision; absent for stale/recovery bytes or a changed selection. */
    servedRevision?: string;
    provenance?: {
        provider: ImageCandidateProvider;
        providerRef: string;
    };
    buffer: Buffer;
    contentType: string;
    cacheControl: string;
    /** STALE: an expired copy served because the refetch failed. */
    cacheStatus?: 'HIT' | 'MISS' | 'STALE';
    etag?: string;
}

export interface ImageRequest {
    id: string;
    type: ImageType;
    options: ImageOptions;
}

export interface ProviderImageRequest {
    providerId: string;
    type: ImageType;
    mediaType?: MediaType;
    options: ImageOptions;
}

/**
 * Common interface implemented by all image providers.
 */
export interface ImageProvider {
    /** Provider name for logging and cache key namespacing */
    readonly name: string;

    /** Fetch an image from this provider */
    getImage(request: ProviderImageRequest): Promise<ImageResponse | null>;
}

/**
 * Image metadata from catalog lookup
 */
export interface ImageMetadata {
    tmdbId?: string;
    jellyfinId?: string;
    mediaType: MediaType;
    posterPath?: string | null;
    backdropPath?: string | null;
}
