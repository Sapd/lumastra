// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-Side Media ID Helpers
 *
 * Utilities for consistent ID handling across all frontend components.
 * These helpers ensure proper composite key usage and prevent TMDB ID collision bugs.
 *
 * Usage in Svelte components:
 * - Use mediaCompositeKey() for {#each} block keys
 * - Use buildMediaKey() for API URLs and navigation
 * - Use hasValidExternalId() to check if actions are possible
 *
 * NOTE: This module is being consolidated with external-ids.ts.
 * For new code, prefer importing from '$lib/utils/external-ids' directly.
 * Re-exports are provided at the bottom for convenience.
 */

import type { ExternalIds, ApiMediaType, ApiMediaTypeInput } from '$lib/types/api-common';

// Import from the new provider-agnostic module for internal use
import {
    getExternalIdFor,
    hasAnyExternalId,
    buildExternalIdKey,
    type PreferredExternalId,
    type ExternalIdKeyOptions,
} from '$lib/utils/external-ids';

// =============================================================================
// Composite Key Builders
// =============================================================================

/**
 * Build a canonical media key for URLs and deduplication.
 * Always returns provider:id:mediaType format for external providers,
 * or the normalized internal UUID.
 *
 * Priority: internal (our UUID) > tmdb > imdb > tvdb > trakt > mal
 *
 * Internal UUID is preferred because:
 * - It's our canonical identifier
 * - It doesn't depend on external providers
 * - It's stable and won't change
 *
 * NOTE: This function now uses buildExternalIdKey() from external-ids.ts internally.
 *
 * @param externalIds - External IDs object
 * @param mediaType - Media type (movie, tv, episode)
 * @returns Formatted media key or null if no valid ID
 *
 * @example
 * buildMediaKey({ internal: 'a3f5e8c7-1234-5678-90ab-cdef12345678' }, 'movie') // 'a3f5e8c7-1234-5678-90ab-cdef12345678'
 * buildMediaKey({ tmdb: '550' }, 'movie') // 'tmdb:550:movie'
 */
export function buildMediaKey(
    externalIds: ExternalIds | undefined,
    mediaType: ApiMediaType | string,
): string | null {
    // Delegate to the provider-agnostic helper from external-ids.ts
    // This maintains the same behavior but uses the centralized implementation
    return buildExternalIdKey(externalIds, mediaType as ApiMediaType, {
        includeUuids: true,
    });
}

/**
 * Build composite key for Svelte {#each} blocks and Set/Map deduplication.
 * Returns a string suitable for use as a unique key.
 *
 * IMPORTANT: This function must return deterministic keys to prevent DOM thrashing.
 * If no external IDs are available, provide a stable fallback (e.g., title or index).
 *
 * @param externalIds - External IDs object
 * @param mediaType - Media type
 * @param fallbackId - Optional stable fallback identifier (e.g., title, array index)
 * @returns Unique key string or empty string if no valid key can be generated
 *
 * @example
 * {#each items as item (mediaCompositeKey(item.externalIds, item.mediaType, item.title))}
 * {#each items as item, i (mediaCompositeKey(item.externalIds, item.mediaType, `idx-${i}`))}
 */
export function mediaCompositeKey(
    externalIds: ExternalIds | undefined,
    mediaType: string,
    fallbackId?: string,
): string {
    const key = buildMediaKey(externalIds, (mediaType as ApiMediaType) || 'movie');
    if (key) return key;

    // Use stable fallback if provided
    if (fallbackId) {
        return `fallback:${fallbackId}:${mediaType || 'unknown'}`;
    }

    // Return empty string - caller should ensure items have either external IDs or fallback
    // Empty keys will cause Svelte to use index-based keying for those items
    return '';
}

/**
 * Build API URL with canonical media key.
 * Use this instead of manual URL construction.
 *
 * @param endpoint - API endpoint path (e.g., '/api/media')
 * @param externalIds - External IDs object
 * @param mediaType - Media type
 * @returns Full API URL or null if no valid ID
 *
 * @example
 * buildMediaApiUrl('/api/media', { tmdb: '550' }, 'movie')
 * // '/api/media/tmdb:550:movie'
 */
export function buildMediaApiUrl(
    endpoint: string,
    externalIds: ExternalIds | undefined,
    mediaType: ApiMediaTypeInput,
): string | null {
    const key = buildMediaKey(externalIds, mediaType);
    if (!key) return null;

    // Ensure endpoint doesn't have trailing slash
    const base = endpoint.replace(/\/$/, '');
    return `${base}/${key}`;
}

/**
 * Build API URL for provider-agnostic endpoints using UUID.
 * Preferred when UUID is available.
 *
 * @param endpoint - API endpoint path
 * @param id - UUID or composite key
 * @returns Full API URL
 */
export function buildMediaApiUrlWithId(endpoint: string, id: string): string {
    const base = endpoint.replace(/\/$/, '');
    return `${base}/${id}`;
}

/**
 * Get the best available media key for linking to details pages.
 *
 * Priority: internalId/UUID → externalIds.internal → composite key
 *
 * Use this in components instead of building composite keys manually.
 * Keeps TMDB requirement ONLY for Jellyseerr external URL.
 *
 * @param item - Media item with optional IDs
 * @returns Best available key or null if no valid ID found
 *
 * @example
 * const key = getBestMediaKey({
 *     id: item.id,
 *     externalIds: item.externalIds,
 *     mediaType: item.mediaType
 * });
 * if (key) {
 *     openMediaModal(modalStore, key);
 * }
 */
export function getBestMediaKey(item: {
    id?: string;
    externalIds?: ExternalIds;
    mediaType?: string;
}): string | null {
    // Priority 1: Internal UUID (preferred)
    if (
        item.id &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)
    ) {
        return item.id;
    }

    // Priority 2: internal UUID carried in externalIds
    const internalId = getExternalIdFor(item.externalIds, 'internal');
    if (internalId) {
        return internalId;
    }

    // Priority 3: Composite key (provider:id:mediaType)
    return mediaCompositeKey(item.externalIds, item.mediaType || 'movie', undefined);
}

/**
 * Get the best playable ID for watch URLs: the internal UUID (`item.id` when
 * it is a UUID, else `externalIds.internal`). Jellyfin ids play no role.
 *
 * Simpler than getBestMediaKey — no composite key fallback, just the
 * raw ID for playback gates and URL construction.
 */
export function getPlayableId(item: {
    id?: string;
    hasFiles?: boolean;
    externalIds?: { internal?: string };
}): string | undefined {
    // Discovery-only items (no local file) are never playable. Only an
    // explicit `false` gates them out — `undefined` keeps current behavior.
    if (item.hasFiles === false) {
        return undefined;
    }

    if (
        item.id &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)
    ) {
        return item.id;
    }

    return item.externalIds?.internal || undefined;
}

/**
 * Get the local internal UUID for preview/transcode flows.
 *
 * Prefers `externalIds.internal` over `item.id` (the preview-session pipeline
 * resolves media through the local database).
 */
export function getLocalPreviewId(item: {
    id?: string;
    externalIds?: { internal?: string };
}): string | undefined {
    if (item.externalIds?.internal) {
        return item.externalIds.internal;
    }

    if (
        item.id &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id)
    ) {
        return item.id;
    }

    return undefined;
}

/**
 * Build stable render keys for media lists while tolerating duplicate items.
 *
 * Unique items keep their canonical key. Duplicate occurrences receive a
 * deterministic suffix so keyed each blocks do not throw.
 */
export function createRenderableMediaKeys<
    T extends {
        id?: string;
        itemKey?: string;
        mediaType?: string;
        externalIds?: ExternalIds;
    },
>(items: T[]): string[] {
    const seenCounts = new Map<string, number>();

    return items.map((item, index) => {
        const baseKey =
            item.itemKey ?? (mediaCompositeKey(
                item.externalIds,
                item.mediaType || 'movie',
                item.id || `idx-${index}`,
            ) || `fallback:idx-${index}:${item.mediaType || 'movie'}`);

        const occurrence = seenCounts.get(baseKey) ?? 0;
        seenCounts.set(baseKey, occurrence + 1);

        return occurrence === 0 ? baseKey : `${baseKey}::dup-${occurrence}`;
    });
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Check if externalIds carries an id the app can open: the internal UUID or
 * any external metadata provider id. (An internal-only item — a standalone
 * library without TMDB — is valid; a Jellyfin id plays no role.)
 *
 * @param externalIds - External IDs object
 * @returns True if at least one valid ID exists
 */
export function hasValidExternalId(externalIds: ExternalIds | undefined): boolean {
    if (!externalIds) return false;

    if (externalIds.internal) return true;

    // Any external metadata provider ID (hasAnyExternalId excludes the internal UUID)
    return hasAnyExternalId(externalIds);
}

/**
 * Check if externalIds has a TMDB ID.
 *
 * @deprecated Use hasAnyExternalId() from '$lib/utils/external-ids' for general validation.
 * Only use hasTmdbId() when you specifically need TMDB (e.g., external Jellyseerr URL).
 *
 * For provider-agnostic validation, use:
 * - hasAnyExternalId() - checks for any external provider ID
 * - hasValidExternalId() - also accepts the internal UUID
 * - getPreferredExternalId() - returns the best available ID with provider info
 *
 * Most code should use provider-agnostic validation via canRequestMedia() from request-utils.ts.
 * The request system can resolve any provider (IMDB, TVDB, TMDB) server-side.
 *
 * @param externalIds - External IDs object
 * @returns True if TMDB ID exists
 */
export function hasTmdbId(externalIds: ExternalIds | undefined): boolean {
    // Delegate to provider-agnostic helper
    return !!getExternalIdFor(externalIds, 'tmdb');
}

/**
 * Get TMDB ID from externalIds (for legacy compatibility).
 * Returns undefined if not available.
 *
 * @deprecated Use getExternalIdFor(ids, 'tmdb') from '$lib/utils/external-ids' for string access.
 * Only use getTmdbIdFromExternalIds() when you specifically need the numeric TMDB ID.
 *
 * For provider-agnostic access:
 * - getExternalIdFor(ids, 'tmdb') - returns string ID for specific provider
 * - getPreferredExternalId(ids) - returns { provider, id } for best available
 *
 * @param externalIds - External IDs object
 * @returns TMDB ID as number or undefined
 */
export function getTmdbIdFromExternalIds(externalIds: ExternalIds | undefined): number | undefined {
    const tmdbId = getExternalIdFor(externalIds, 'tmdb');
    if (!tmdbId) return undefined;
    const id = parseInt(tmdbId, 10);
    return isNaN(id) ? undefined : id;
}

// =============================================================================
// External ID Construction
// =============================================================================

/**
 * Create an ExternalIds object with the correct provider key.
 * Use this instead of createExternalIdsFromTmdb when the provider may not be TMDB.
 *
 * @param provider - The provider key to use (e.g., 'tmdb', 'tvdb', 'imdb')
 * @param id - The external ID value
 */
export function createExternalIdsFromProvider(
    provider: string,
    id: string | number,
): Record<string, string> {
    return { [provider]: String(id) };
}

/**
 * Create ExternalIds object from a single TMDB ID.
 * Useful when you only have a TMDB ID (e.g., from TMDB API responses).
 *
 * @deprecated Use createExternalIdsFromProvider('tmdb', id) for truly-TMDB callers
 *
 * @param id - TMDB ID (number or string)
 * @returns ExternalIds object
 */
export function createExternalIdsFromTmdb(id: number | string): ExternalIds {
    return createExternalIdsFromProvider('tmdb', id) as ExternalIds;
}

/**
 * Create ExternalIds object from multiple sources.
 * Normalizes all IDs to strings.
 *
 * NOTE: For new code, prefer createExternalIds() from '$lib/utils/external-ids'.
 *
 * @param ids - Partial external IDs with optional number values
 * @returns ExternalIds object with string values
 */
export function createExternalIds(ids: {
    tmdb?: number | string;
    imdb?: string;
    tvdb?: number | string;
    trakt?: number | string;
    mal?: number | string;
}): ExternalIds {
    const result: ExternalIds = {};

    if (ids.tmdb !== undefined) result.tmdb = String(ids.tmdb);
    if (ids.imdb !== undefined) result.imdb = ids.imdb;
    if (ids.tvdb !== undefined) result.tvdb = String(ids.tvdb);
    if (ids.trakt !== undefined) result.trakt = String(ids.trakt);
    if (ids.mal !== undefined) result.mal = String(ids.mal);

    return result;
}

/**
 * Merge two ExternalIds objects.
 * Values from the second object take priority.
 *
 * NOTE: For new code, prefer mergeExternalIds() from '$lib/utils/external-ids'.
 *
 * @param base - Base external IDs
 * @param override - Override external IDs
 * @returns Merged ExternalIds object
 */
export function mergeExternalIds(
    base: ExternalIds | undefined,
    override: ExternalIds | undefined,
): ExternalIds {
    return {
        ...(base || {}),
        ...(override || {}),
    };
}

// =============================================================================
// Re-exports from external-ids.ts for convenience
// =============================================================================

// Re-export provider-agnostic functions for consumers who import from this module
export {
    getPreferredExternalId,
    getExternalIdFor,
    hasAnyExternalId,
    buildExternalIdKey,
    hasAnyId,
    createExternalIdFromSingle,
    getAllExternalIds,
    getPrimaryExternalIdForDisplay,
    getProviderDisplayName,
} from '$lib/utils/external-ids';

// Re-export types
export type { PreferredExternalId, ExternalIdKeyOptions };
