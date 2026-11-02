// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image URL utilities
 * Centralized functions for generating image URLs across all services
 */

import type { ImageDescriptor, ImageVariantName } from '$lib/schemas/api-image-descriptor.js';
import type { ExternalIds, ApiMediaTypeInput } from '$lib/types/api-common';
import { getExternalIdFor } from '$lib/utils/external-ids';
import { FALLBACK_IMAGE } from '$lib/constants/images';
import { apiUrl, entityImageUrl, type ApiSurface } from '$lib/shared/api-urls.js';

/**
 * Browser code is always talking to the cookie-authenticated internal surface;
 * `/api/v1` is the token surface for native clients.
 */
const CLIENT_SURFACE: ApiSurface = 'internal';

export interface ImageErrorOptions {
    fallbackUrl?: string;
    hideOnError?: boolean;
    showFallback?: boolean;
    onError?: (e: Event) => void;
}

/**
 * Preset thumbnail sizes for common use cases
 * - 'thumb': 250px wide posters for grids/carousels (~30-50KB)
 * - 'medium': 350px wide for larger cards (~60-80KB)
 * - 'card': 480px wide tuned for HiDPI poster cards at q=75 (~50-100KB)
 * - 'hd': 1280px wide — 720p-class full-bleed backdrops/heroes
 * - 'wide': 1920px wide — 1080p-class full-bleed backdrops/heroes (HiDPI)
 * - 'full': No size limit, original quality (modals, detail-poster editing)
 */
export type ImageSize = 'thumb' | 'medium' | 'card' | 'hd' | 'wide' | 'full';

/**
 * Get user avatar URL (cached via backend proxy)
 * Avatars are cached on disk for 48 hours to reduce API load
 *
 * Built through `apiUrl` so it carries the install's base path — an <img src>
 * is never seen by the global fetch interceptor, so a root-absolute literal
 * here 404s on a subpath install. Pass the user's UUID for identity-based avatars.
 * The route exists on both surfaces (unlike the retired
 * `/api/image/user/**` proxy this replaced).
 */
export function getAvatarUrl(
    userId: string | ImageDescriptor | undefined,
    options?: { quality?: number; width?: number; version?: string | number },
): string {
    if (typeof userId !== 'string') return pickVariant(userId, 'thumb') ?? '';
    // Username fallback for callers without a descriptor.
    // Use cached avatar endpoint instead of direct URL
    // The backend handles caching for 48 hours
    const params = new URLSearchParams();
    if (options?.quality) {
        params.set('quality', options.quality.toString());
    }
    // `width` is a CSS-pixel hint; the route snaps it UP onto [48,96,160,200].
    // Pass the size you actually draw at (times your DPR) — the endpoint served
    // the full source until 2026-08-28, so a 20px avatar could cost a 2048px
    // decode. Omitting it is safe but yields the 200px original.
    if (options?.width && Number.isFinite(options.width) && options.width > 0) {
        params.set('width', String(Math.ceil(options.width)));
    }
    // A user with no avatar anywhere gets the initials SVG as a 200 instead of
    // a 404 — every page that shows them used to log a console error for it.
    params.set('fallback', 'initials');
    // Cache-buster after an upload/removal (the image itself is cached for days).
    if (options?.version !== undefined) params.set('v', String(options.version));
    return `${apiUrl(CLIENT_SURFACE, `/users/${encodeURIComponent(userId)}/images/avatar`)}?${params.toString()}`;
}

/**
 * Add a `width` hint to an avatar URL that does not already carry a size.
 *
 * Exists so `Avatar.svelte` can size the image it was HANDED: the component is
 * the only thing that knows the rendered box, while the ~15 call sites that
 * build the URL do not. Rewriting there fixes them all at once instead of
 * threading a width through every caller.
 *
 * Leaves the URL alone when it already specifies `width` or `size` (an explicit
 * caller wins), when it is not the avatar route, and when it is not a same-origin
 * path — never rewrite a URL pointing somewhere we do not own.
 */
export function withAvatarWidth(src: string, cssPx: number): string {
    if (!src || !src.includes('/images/avatar')) return src;
    if (/[?&](width|size)=/.test(src)) return src;
    // Devices render at 2x or 3x; 2x covers the common case and the route's
    // ladder tops out at the 200px original anyway, so over-asking is bounded.
    const want = Math.ceil(cssPx * 2);
    return `${src}${src.includes('?') ? '&' : '?'}width=${want}`;
}

/** @deprecated Use getAvatarUrl instead */
export const getJellyfinUserAvatarUrl = getAvatarUrl;

/**
 * Handle image loading errors with various strategies
 */
export function handleImageError(e: Event, options?: ImageErrorOptions): void {
    const img = e.target as HTMLImageElement;

    if (options?.onError) {
        options.onError(e);
        return;
    }

    if (options?.hideOnError) {
        img.style.display = 'none';
        return;
    }

    if (options?.fallbackUrl) {
        img.src = options.fallbackUrl;
        return;
    }

    if (options?.showFallback) {
        // Hide image and show fallback element
        img.style.display = 'none';
        const parent = img.parentElement;
        if (parent) {
            const fallback = parent.querySelector('.avatar-fallback, .image-fallback');
            if (fallback instanceof HTMLElement) {
                fallback.style.display = 'flex';
            }
        }
    }
}

// =========================================================================
// Provider-Agnostic Image Functions
// =========================================================================

/**
 * Resolve an image URL from ExternalIds.
 * Uses internal UUID (catalog endpoint) when available, falls back to
 * composite key URL for items that only have external provider IDs.
 *
 * This is the primary image resolution function for any code that has
 * ExternalIds but not a bare UUID.
 *
 * @param externalIds External IDs object (must include `internal` for best results)
 * @param type Image type (poster, backdrop, logo, thumb — thumb is the only
 *   type that resolves to an episode's OWN still/extracted frame; poster and
 *   backdrop always inherit from the season/series for episodes)
 * @param mediaType Media type for composite key fallback ('movie' | 'tv')
 * @param options Optional size parameter
 */
export function imageFromIds(
    externalIds: ExternalIds | undefined,
    type: 'poster' | 'backdrop' | 'logo' | 'thumb',
    mediaType: ApiMediaTypeInput = 'movie',
    options?: { size?: ImageSize },
): string | null {
    if (!externalIds) return null;

    // Priority 1: Internal UUID — provider-agnostic catalog endpoint
    const internalId = getExternalIdFor(externalIds, 'internal');
    if (internalId) {
        return getCatalogImageUrl(internalId, type, options);
    }

    // Priority 2: External providers via composite key URL.
    // Only providers the backend's getImageByCompositeKey resolves are listed here.
    // tvdb and imdb composite keys are not supported by the backend and would 404.
    const imageProviders = ['tmdb'] as const;
    for (const provider of imageProviders) {
        const providerIdStr = getExternalIdFor(externalIds, provider);
        if (providerIdStr) {
            const id = parseInt(providerIdStr, 10);
            if (!isNaN(id) && id > 0 && id < 100000000) {
                // The composite key is matched VERBATIM against
                // `external_ids.media_type`, which stores 'tv' — never 'series'.
                // Callers legitimately hold the canonical 'series' (it is what the
                // public API returns), so normalise here rather than at every call
                // site: passing it straight through built `tmdb:<id>:series`, which
                // resolves to nothing and rendered a broken poster.
                // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- legacy provider image keys may use the external 'show' alias.
                const isLegacyShow = mediaType === 'show';
                const storageMediaType = mediaType === 'series' || isLegacyShow ? 'tv' : mediaType;
                const compositeKey = `${provider}:${id}:${storageMediaType}`;
                // The entity route resolves composite provider keys too, so the
                // fallback path uses the SAME URL shape as the UUID path above.
                return entityImageUrl(compositeKey, type, CLIENT_SURFACE, {
                    size: options?.size,
                });
            }
        }
    }

    return null;
}

/**
 * Get catalog image URL using internal UUID.
 *
 * Emits the canonical entity route — `{base}/api/media/{id}/images/{role}` —
 * which is the SAME shape the server puts in every `images{}` href. It used to
 * emit `/api/image/catalog/{id}/{type}`, which meant the client computed one URL
 * shape for an image while the API handed it a different one, and neither
 * carried the install's base path. Both resolve through the same
 * `ImageProxyService.getImageByCatalogId()`, including the track → album →
 * artist parent-walk music cover art depends on, so only the URL form changes.
 *
 * Every `getCatalog*Url` / `getCatalog*SrcSet` helper funnels through here.
 *
 * @param id Internal UUID of the media item (a composite provider key also resolves)
 * @param type Image role (poster, backdrop, logo, thumb)
 * @param options Optional size preset / maxWidth / fallback
 */
export function getCatalogImageUrl(
    id: string,
    type: 'poster' | 'backdrop' | 'logo' | 'thumb',
    options?: { size?: ImageSize; fallback?: 'none'; maxWidth?: string },
): string {
    const params = new URLSearchParams();
    if (options?.maxWidth) params.set('maxWidth', options.maxWidth);
    if (options?.fallback) params.set('fallback', options.fallback);
    const extra = params.toString() ? `&${params.toString()}` : '';
    const url = entityImageUrl(id, type, CLIENT_SURFACE, { size: options?.size });
    if (!extra) return url;
    return url.includes('?') ? `${url}${extra}` : `${url}?${extra.slice(1)}`;
}

/**
 * Get poster URL for a media item using its UUID.
 * Preferred method for provider-agnostic image loading.
 */
export function getCatalogPosterUrl(
    id: string,
    options?: { size?: ImageSize; fallback?: 'none' },
): string {
    return getCatalogImageUrl(id, 'poster', options);
}

/**
 * Get backdrop URL for a media item using its UUID.
 */
export function getCatalogBackdropUrl(
    id: string,
    options?: { size?: ImageSize; fallback?: 'none' },
): string {
    return getCatalogImageUrl(id, 'backdrop', options);
}

/**
 * Get thumb URL for a media item using its UUID.
 * Useful for episode thumbnails extracted from video files.
 */
export function getCatalogThumbUrl(
    id: string,
    options?: { size?: ImageSize; fallback?: 'none' },
): string {
    return getCatalogImageUrl(id, 'thumb', options);
}

/**
 * Generate srcset attribute value for a catalog image.
 * Uses named size presets only — no raw ?width= params — so each entry is a
 * bounded, cache-friendly preset variant.
 */
export function getCatalogImageSrcSet(id: string, type: 'poster' | 'backdrop' | 'logo'): string {
    return [
        `${getCatalogImageUrl(id, type, { size: 'thumb' })} 250w`,
        `${getCatalogImageUrl(id, type, { size: 'medium' })} 350w`,
        `${getCatalogImageUrl(id, type, { size: 'card' })} 480w`,
    ].join(', ');
}

/**
 * Poster srcset tuned for media cards. Caps at the `card` variant (480w / q=75)
 * so HiDPI cards don't pull the unbounded `full` variant. Use the backdrop
 * srcset when you need the full-size variant (hero sections, modals).
 */
export function getCatalogPosterSrcSet(id: string): string {
    return [
        `${getCatalogImageUrl(id, 'poster', { size: 'thumb' })} 250w`,
        `${getCatalogImageUrl(id, 'poster', { size: 'medium' })} 350w`,
        `${getCatalogImageUrl(id, 'poster', { size: 'card' })} 480w`,
    ].join(', ');
}

export function getCatalogBackdropSrcSet(id: string): string {
    // Backdrops fill 100vw on the hero; emit high-DPI variants so 1080p+
    // displays don't upscale. All candidates are NAMED presets (no raw
    // ?width=) so each lands on a bounded, immutable cache entry — the same
    // canonical variants the API's self-describing images{} hrefs emit and
    // that 3rd-party clients consume.
    return [
        `${getCatalogImageUrl(id, 'backdrop', { size: 'thumb' })} 250w`,
        `${getCatalogImageUrl(id, 'backdrop', { size: 'medium' })} 350w`,
        `${getCatalogImageUrl(id, 'backdrop', { size: 'card' })} 480w`,
        `${getCatalogImageUrl(id, 'backdrop', { size: 'hd' })} 1280w`,
        `${getCatalogImageUrl(id, 'backdrop', { size: 'wide' })} 1920w`,
    ].join(', ');
}

/**
 * Thumb srcset for an episode's own still/extracted frame. Same width ladder
 * as the poster srcset (episode thumbs are card-sized, not hero-sized).
 */
export function getCatalogThumbSrcSet(id: string): string {
    return [
        `${getCatalogImageUrl(id, 'thumb', { size: 'thumb' })} 250w`,
        `${getCatalogImageUrl(id, 'thumb', { size: 'medium' })} 350w`,
        `${getCatalogImageUrl(id, 'thumb', { size: 'card' })} 480w`,
    ].join(', ');
}

/**
 * Get logo URL for a media item using its UUID.
 *
 * Pass `{ fallback: 'none' }` to get a 404 instead of the popcorn placeholder
 * when no logo exists — useful for decorative logos that should disappear
 * gracefully rather than show a fallback image.
 */
export function getCatalogLogoUrl(id: string, options?: { fallback?: 'none' }): string | undefined {
    if (!id) return undefined;
    return getCatalogImageUrl(id, 'logo', options);
}

/**
 * Svelte action that handles image load errors by swapping to fallback
 * Usage: <img use:fallbackImage /> or <img use:fallbackImage={'/custom-fallback.png'} />
 */
export function fallbackImage(
    node: HTMLImageElement,
    fallbackUrl: string = FALLBACK_IMAGE,
): {
    update(newFallbackUrl: string): void;
    destroy(): void;
} {
    function handleError() {
        if (node.src !== fallbackUrl && !node.src.endsWith(fallbackUrl)) {
            node.src = fallbackUrl;
        }
    }

    node.addEventListener('error', handleError);

    return {
        update(newFallbackUrl: string) {
            fallbackUrl = newFallbackUrl || FALLBACK_IMAGE;
        },
        destroy() {
            node.removeEventListener('error', handleError);
        },
    };
}

/**
 * Create a data URL for a placeholder image
 */
export function createPlaceholderDataUrl(
    width: number = 300,
    height: number = 450,
    text?: string,
): string {
    const svg = `
		<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
			<rect width="100%" height="100%" fill="#1e293b"/>
			<text x="50%" y="50%" font-family="Arial" font-size="16" fill="#64748b" text-anchor="middle" dy=".3em">
				${text || 'No Image'}
			</text>
		</svg>
	`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Select an advertised size, falling back to the descriptor's default URL. */
export function pickVariant(
    descriptor: Pick<ImageDescriptor, 'href' | 'variants'> | undefined,
    preferred: ImageVariantName,
): string | undefined {
    return descriptor?.variants?.[preferred] ?? descriptor?.href;
}

/** Like `pickVariant` for a descriptor that is known to exist: always a URL. */
export function pickVariantUrl(
    descriptor: Pick<ImageDescriptor, 'href' | 'variants'>,
    preferred: ImageVariantName,
): string {
    return descriptor.variants?.[preferred] ?? descriptor.href;
}
