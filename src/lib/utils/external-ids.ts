// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider-Agnostic External ID Helpers
 *
 * Centralized utilities for working with external IDs from various providers.
 * These helpers abstract away direct provider access (e.g., externalIds.tmdb)
 * to enable provider-agnostic code throughout the codebase.
 *
 * Usage:
 * - Use getPreferredExternalId() when you need the "best" available ID
 * - Use getExternalIdFor() when you need a specific provider's ID
 * - Use buildExternalIdKey() for building composite keys for URLs/deduplication
 * - Use hasAnyExternalId() to check if any provider ID exists
 *
 * Note: For Jellyseerr requests, use getExternalIdFor(ids, 'tmdb') explicitly
 * as Jellyseerr's API requires TMDB IDs (external API constraint).
 *
 * @see docs/provider-constraints.md for provider-specific limitations
 */

import type { ExternalIds, ExternalIdProvider, ApiMediaType } from '$lib/types/api-common';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of getting a preferred external ID
 */
export interface PreferredExternalId {
    /** The provider name */
    provider: ExternalIdProvider;
    /** The external ID value */
    id: string;
}

/**
 * Options for building external ID keys
 */
export interface ExternalIdKeyOptions {
    /** Preferred provider to use (if available) */
    preferredProvider?: ExternalIdProvider;
    /** Whether to include the internal UUID in key selection */
    includeUuids?: boolean;
}

// =============================================================================
// Provider Priority Configuration
// =============================================================================

/**
 * Default priority order for external ID providers.
 * Used when no specific provider is requested.
 * Order: TMDB > IMDB > TVDB > Trakt > MAL > AniList
 */
const DEFAULT_PROVIDER_PRIORITY: readonly ExternalIdProvider[] = [
    'tmdb',
    'imdb',
    'tvdb',
    'trakt',
    'mal',
    'anilist',
] as const;

/**
 * Providers that represent internal UUIDs (not external metadata providers)
 */
const UUID_PROVIDERS: ReadonlySet<ExternalIdProvider> = new Set(['internal']);

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Get the preferred external ID based on provider priority.
 *
 * Returns the first available ID from the priority chain.
 * Does NOT include the internal UUID by default - use includeUuids option.
 *
 * @param externalIds - External IDs object
 * @param options - Options for customizing behavior
 * @returns The preferred external ID with its provider, or null if none available
 *
 * @example
 * const preferred = getPreferredExternalId(item.externalIds);
 * if (preferred) {
 *     console.log(`Using ${preferred.provider}: ${preferred.id}`);
 * }
 */
export function getPreferredExternalId(
    externalIds: ExternalIds | undefined | null,
    options?: ExternalIdKeyOptions,
): PreferredExternalId | null {
    if (!externalIds) return null;

    const { preferredProvider, includeUuids = false } = options ?? {};

    // Check preferred provider first if specified
    if (preferredProvider) {
        const id = externalIds[preferredProvider];
        if (id) {
            return { provider: preferredProvider, id };
        }
    }

    // Check internal UUID first if includeUuids is enabled
    if (includeUuids && externalIds.internal) {
        return { provider: 'internal', id: externalIds.internal };
    }

    // Walk through priority chain
    for (const provider of DEFAULT_PROVIDER_PRIORITY) {
        // Skip UUID providers unless includeUuids is enabled
        if (!includeUuids && UUID_PROVIDERS.has(provider)) {
            continue;
        }

        const id = externalIds[provider];
        if (id) {
            return { provider, id };
        }
    }

    return null;
}

/**
 * Get a specific provider's external ID.
 *
 * Use this when you need a specific provider's ID (e.g., TMDB for Jellyseerr).
 *
 * @param externalIds - External IDs object
 * @param provider - The specific provider to get
 * @returns The external ID string, or undefined if not available
 *
 * @example
 * // For Jellyseerr requests (requires TMDB ID)
 * const tmdbId = getExternalIdFor(item.externalIds, 'tmdb');
 * if (!tmdbId) {
 *     return { canRequest: false, reason: 'TMDB ID required for requests' };
 * }
 */
export function getExternalIdFor(
    externalIds: ExternalIds | undefined | null,
    provider: ExternalIdProvider,
): string | undefined {
    return externalIds?.[provider];
}

/**
 * Build a composite key for URLs and deduplication.
 *
 * Priority: internal UUID > provider:id:mediaType
 *
 * @param externalIds - External IDs object
 * @param mediaType - Media type for composite key
 * @param options - Options for customizing behavior
 * @returns Formatted key string or null if no valid ID
 *
 * @example
 * const key = buildExternalIdKey(item.externalIds, 'movie');
 * // Returns: 'uuid-string' or 'tmdb:550:movie' or null
 */
export function buildExternalIdKey(
    externalIds: ExternalIds | undefined | null,
    mediaType: ApiMediaType,
    options?: ExternalIdKeyOptions,
): string | null {
    if (!externalIds) return null;

    const { preferredProvider, includeUuids = true } = options ?? {};

    // Priority 1: Internal UUID (preferred for URLs)
    if (includeUuids && externalIds.internal) {
        return normalizeUuid(externalIds.internal);
    }

    // Check preferred provider if specified
    if (preferredProvider && !UUID_PROVIDERS.has(preferredProvider)) {
        const id = externalIds[preferredProvider];
        if (id) {
            return `${preferredProvider}:${id}:${mediaType}`;
        }
    }

    // Fall back to priority chain for composite keys
    const preferred = getPreferredExternalId(externalIds, {
        includeUuids: false,
    });
    if (preferred) {
        return `${preferred.provider}:${preferred.id}:${mediaType}`;
    }

    return null;
}

/**
 * Check if any external ID is available (excluding the internal UUID).
 *
 * @param externalIds - External IDs object
 * @returns True if at least one external provider ID exists
 *
 * @example
 * if (!hasAnyExternalId(item.externalIds)) {
 *     console.log('No external metadata available');
 * }
 */
export function hasAnyExternalId(externalIds: ExternalIds | undefined | null): boolean {
    return getPreferredExternalId(externalIds, { includeUuids: false }) !== null;
}

/**
 * Check if any ID (including the internal UUID) is available.
 *
 * @param externalIds - External IDs object
 * @returns True if any ID exists
 */
export function hasAnyId(externalIds: ExternalIds | undefined | null): boolean {
    return getPreferredExternalId(externalIds, { includeUuids: true }) !== null;
}

// =============================================================================
// Specific Provider Checks (with deprecation warnings for direct access)
// =============================================================================

/**
 * Check if TMDB ID is available.
 *
 * @deprecated Use hasAnyExternalId() for general validation.
 * Only use hasTmdbId() when you specifically need TMDB (e.g., Jellyseerr requests).
 *
 * @param externalIds - External IDs object
 * @returns True if TMDB ID exists
 */
export function hasTmdbId(externalIds: ExternalIds | undefined | null): boolean {
    return !!getExternalIdFor(externalIds, 'tmdb');
}

/**
 * Get TMDB ID as a number.
 *
 * @deprecated Use getExternalIdFor(ids, 'tmdb') for string access.
 * Only use getTmdbId() when you specifically need the numeric TMDB ID.
 *
 * @param externalIds - External IDs object
 * @returns TMDB ID as number or undefined
 */
export function getTmdbId(externalIds: ExternalIds | undefined | null): number | undefined {
    const id = getExternalIdFor(externalIds, 'tmdb');
    if (!id) return undefined;
    const parsed = parseInt(id, 10);
    return isNaN(parsed) ? undefined : parsed;
}

// =============================================================================
// Construction Helpers
// =============================================================================

/**
 * Create an ExternalIds object from a single provider ID.
 *
 * @param provider - Provider name
 * @param id - External ID value
 * @returns ExternalIds object
 *
 * @example
 * const ids = createExternalIdFromSingle('tmdb', '550');
 * // { tmdb: '550' }
 */
export function createExternalIdFromSingle(
    provider: ExternalIdProvider,
    id: string | number,
): ExternalIds {
    return { [provider]: String(id) };
}

/**
 * Create an ExternalIds object from multiple providers.
 *
 * @param ids - Partial external IDs with optional number values
 * @returns ExternalIds object with string values
 *
 * @example
 * const ids = createExternalIds({ tmdb: 550, imdb: 'tt0137523' });
 * // { tmdb: '550', imdb: 'tt0137523' }
 */
export function createExternalIds(ids: {
    internal?: string | null;
    tmdb?: number | string | null;
    imdb?: string | null;
    tvdb?: number | string | null;
    trakt?: number | string | null;
    mal?: number | string | null;
    anilist?: number | string | null;
    kavita?: string | null;
}): ExternalIds {
    const result: ExternalIds = {};

    if (ids.internal != null) result.internal = ids.internal;
    if (ids.tmdb != null) result.tmdb = String(ids.tmdb);
    if (ids.imdb != null) result.imdb = ids.imdb;
    if (ids.tvdb != null) result.tvdb = String(ids.tvdb);
    if (ids.trakt != null) result.trakt = String(ids.trakt);
    if (ids.mal != null) result.mal = String(ids.mal);
    if (ids.anilist != null) result.anilist = String(ids.anilist);
    if (ids.kavita != null) result.kavita = ids.kavita;

    return result;
}

/**
 * Merge two ExternalIds objects.
 * Values from the override object take priority.
 *
 * @param base - Base external IDs
 * @param override - Override external IDs
 * @returns Merged ExternalIds object
 */
export function mergeExternalIds(
    base: ExternalIds | undefined | null,
    override: ExternalIds | undefined | null,
): ExternalIds {
    return {
        ...(base ?? {}),
        ...(override ?? {}),
    };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Normalize a UUID by adding dashes if missing.
 * Converts: 6abfe9f17836b3aa44ce38440e81651d
 * To:       6abfe9f1-7836-b3aa-44ce-38440e81651d
 *
 * Exported because `$lib/shared/request-dismissal-key.ts` has to reproduce the
 * bare-UUID flag target (`K-UUID`) EXACTLY as `buildExternalIdKey` would have
 * written it. Re-deriving that dashing rule there would be a second copy of
 * this one, free to drift.
 */
export function normalizeUuid(id: string): string {
    // Already has dashes or not a valid UUID-like string
    if (id.includes('-') || !/^[0-9a-f]{32}$/i.test(id)) {
        return id;
    }
    // Insert dashes at standard UUID positions: 8-4-4-4-12
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * Get the display name for a provider.
 *
 * @param provider - Provider key
 * @returns Human-readable provider name
 */
export function getProviderDisplayName(provider: ExternalIdProvider): string {
    const names: Record<ExternalIdProvider, string> = {
        internal: 'Internal',
        tmdb: 'TMDB',
        imdb: 'IMDB',
        tvdb: 'TVDB',
        trakt: 'Trakt',
        mal: 'MyAnimeList',
        anilist: 'AniList',
        audiobookshelf: 'AudiobookShelf',
        kavita: 'Kavita',
    };
    return names[provider] || String(provider).toUpperCase();
}

/**
 * Get the primary external ID with display information.
 *
 * @param externalIds - External IDs object
 * @returns Object with provider, id, and displayName, or null
 */
export function getPrimaryExternalIdForDisplay(
    externalIds: ExternalIds | undefined | null,
): { provider: ExternalIdProvider; id: string; displayName: string } | null {
    const preferred = getPreferredExternalId(externalIds);
    if (!preferred) return null;

    return {
        provider: preferred.provider,
        id: preferred.id,
        displayName: getProviderDisplayName(preferred.provider),
    };
}

/**
 * Get all available external IDs as an array.
 *
 * @param externalIds - External IDs object
 * @param includeUuids - Whether to include the internal UUID
 * @returns Array of { provider, id } objects
 */
export function getAllExternalIds(
    externalIds: ExternalIds | undefined | null,
    includeUuids = false,
): PreferredExternalId[] {
    if (!externalIds) return [];

    const result: PreferredExternalId[] = [];

    // Add internal UUID if requested
    if (includeUuids && externalIds.internal) {
        result.push({ provider: 'internal', id: externalIds.internal });
    }

    // Add all external provider IDs
    for (const provider of DEFAULT_PROVIDER_PRIORITY) {
        if (!includeUuids && UUID_PROVIDERS.has(provider)) {
            continue;
        }

        const id = externalIds[provider];
        if (id) {
            result.push({ provider, id });
        }
    }

    return result;
}

// =============================================================================
// Legacy Jellyfin ids (input only)
// =============================================================================

/** The deprecated request key that older clients still send. */
const LEGACY_JELLYFIN_KEY = 'jellyfin';

/**
 * The Jellyfin item id an older client may still send as `externalIds.jellyfin`.
 * Only for mapping it to the internal id; it is never put into a response.
 */
export function getLegacyJellyfinId(externalIds: object | undefined | null): string | undefined {
    const value = (externalIds as Record<string, unknown> | undefined | null)?.[
        LEGACY_JELLYFIN_KEY
    ];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A copy of `externalIds` without the legacy `jellyfin` key (same object if it has none). */
export function withoutLegacyJellyfinId<T extends object>(externalIds: T): T {
    if (!(LEGACY_JELLYFIN_KEY in externalIds)) return externalIds;
    const copy: Record<string, unknown> = { ...externalIds };
    delete copy[LEGACY_JELLYFIN_KEY];
    return copy as T;
}
