// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider-specific image URL generation (Jellyfin/TMDB/Audiobookshelf/Radarr).
 *
 * Split out of `DataNormalizationService` so that server code which needs the
 * rest of that service's pure string/number normalizers (e.g. AI metadata
 * sync, which runs both under Vite and as a standalone `tsx` script during
 * container startup) doesn't transitively import `$lib/utils/image-utils`,
 * which pulls in `$app/paths` — a Vite-only virtual module that `tsx` cannot
 * resolve outside a SvelteKit process.
 */

import { getCatalogImageUrl } from '$lib/utils/image-utils.js';

/**
 * Generate consistent image URLs
 */
export function generateImageUrl(
    source: 'jellyfin' | 'tmdb' | 'audiobookshelf' | 'radarr',
    id: string | number,
    type: 'poster' | 'backdrop' | 'thumb' = 'poster',
    mediaType: 'movie' | 'tv' = 'movie',
    tmdbPath?: string,
    internalId?: string,
): string {
    switch (source) {
        case 'jellyfin': {
            if (tmdbPath) {
                const size = type === 'backdrop' ? 'w780' : 'w500';
                return `/api/image/tmdb/${size}${tmdbPath}`;
            }
            if (internalId) {
                return getCatalogImageUrl(internalId, type === 'thumb' ? 'poster' : type);
            }
            return getCatalogImageUrl(String(id), type === 'thumb' ? 'poster' : type);
        }
        case 'tmdb': {
            const imageType = type === 'thumb' ? 'poster' : type;
            return id ? `/api/image/tmdb:${id}:${mediaType}/${imageType}` : '';
        }
        case 'audiobookshelf':
            return `/api/image/audiobook/${id}`;
        case 'radarr':
            return `/api/image/radarr/${id}/${type}`;
        default:
            return '';
    }
}
