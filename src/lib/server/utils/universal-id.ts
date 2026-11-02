// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Universal ID Generator - Provider-Agnostic
 *
 * Creates unique composite IDs from any external ID provider (TMDB, IMDB, Jellyfin, etc.)
 * Ensures uniqueness across different media types.
 */

export type MediaProvider = 'tmdb' | 'imdb' | 'jellyfin' | 'tvdb' | 'custom';
export type MediaTypeIdentifier = 'movie' | 'tv' | 'season' | 'episode' | 'audio' | 'audiobook';

export interface ExternalIdMap {
    [provider: string]: string;
}

/**
 * Provider priority order - used to select the "best" available provider
 * TMDB is preferred because it has the most complete metadata
 */
const PROVIDER_PRIORITY: MediaProvider[] = ['tmdb', 'imdb', 'tvdb', 'jellyfin', 'custom'];

/**
 * Generate a unique composite ID from any available external ID
 *
 * @param externalIds - Map of provider -> external ID
 * @param mediaType - Media type for uniqueness (some providers reuse IDs across types)
 * @param preferredProvider - Optional: force a specific provider
 * @returns Composite ID in format `provider:id:mediaType` or null if no IDs available
 *
 * @example
 * ```ts
 * // Prefer TMDB if available
 * generateUniversalId({ tmdb: '550', imdb: 'tt0137523' }, 'movie')
 * // => 'tmdb:550:movie'
 *
 * // Fallback to IMDB if TMDB not available
 * generateUniversalId({ imdb: 'tt0137523' }, 'movie')
 * // => 'imdb:tt0137523:movie'
 *
 * // Force Jellyfin UUID
 * generateUniversalId({ jellyfin: 'abc-123', tmdb: '550' }, 'movie', 'jellyfin')
 * // => 'jellyfin:abc-123:movie'
 * ```
 */
export function generateUniversalId(
    externalIds: ExternalIdMap,
    mediaType: MediaTypeIdentifier,
    preferredProvider?: MediaProvider,
): string | null {
    // If preferred provider specified and available, use it
    if (preferredProvider && externalIds[preferredProvider]) {
        return `${preferredProvider}:${externalIds[preferredProvider]}:${mediaType}`;
    }

    // Otherwise, pick the best available provider by priority
    for (const provider of PROVIDER_PRIORITY) {
        if (externalIds[provider]) {
            return `${provider}:${externalIds[provider]}:${mediaType}`;
        }
    }

    // Fallback to any available provider
    const firstProvider = Object.keys(externalIds)[0];
    if (firstProvider) {
        return `${firstProvider}:${externalIds[firstProvider]}:${mediaType}`;
    }

    return null;
}

/**
 * Parse a composite ID back into its components
 *
 * @param compositeId - ID in format `provider:id:mediaType`
 * @returns Parsed components or null if invalid format
 *
 * @example
 * ```ts
 * parseUniversalId('tmdb:550:movie')
 * // => { provider: 'tmdb', externalId: '550', mediaType: 'movie' }
 * ```
 */
export function parseUniversalId(compositeId: string): {
    provider: string;
    externalId: string;
    mediaType: MediaTypeIdentifier;
} | null {
    const parts = compositeId.split(':');
    if (parts.length !== 3) {
        return null;
    }

    const [provider, externalId, mediaType] = parts;
    return {
        provider,
        externalId,
        mediaType: mediaType as MediaTypeIdentifier,
    };
}

/**
 * Check if an ID uses a specific provider
 *
 * @param compositeId - Composite ID
 * @param provider - Provider to check for
 * @returns True if the ID uses the specified provider
 */
export function isProviderType(compositeId: string, provider: MediaProvider): boolean {
    const parsed = parseUniversalId(compositeId);
    return parsed?.provider === provider;
}

/**
 * Extract just the external ID from a composite ID
 *
 * @param compositeId - Composite ID in format `provider:id:mediaType`
 * @returns Just the external ID part, or null if invalid
 */
export function extractExternalId(compositeId: string): string | null {
    const parsed = parseUniversalId(compositeId);
    return parsed?.externalId || null;
}

/**
 * Convert TMDB-specific data to universal ID
 * Helper for gradual migration from TMDB-centric code
 *
 * @deprecated Use generateUniversalId instead for new code
 */
export function tmdbToUniversalId(tmdbId: number | string, mediaType: 'movie' | 'tv'): string {
    return `tmdb:${tmdbId}:${mediaType}`;
}
