// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Key Parser
 *
 * Parses route parameters that can be in multiple formats:
 * - UUID: 550e8400-e29b-41d4-a716-446655440000 (primary)
 * - Composite key: provider:id:mediaType (e.g., tmdb:550:movie)
 *
 * UUID is the preferred format for all internal operations.
 * Composite keys are supported for external lookups and deep links.
 */

import type { ApiMediaType } from '../../types/api-common.js';
import { toInternalMediaType, type MediaTypeInternal } from '$lib/shared/media-type-domain';

/**
 * Media-type token this parser accepts in / emits from composite keys.
 *
 * `normalizeMediaType` folds the `'series'` / `'show'` aliases down to the
 * legacy lowercase `'tv'` storage token (see `coerceLegacyTvToSeries`), so the
 * parser's runtime output genuinely includes `'tv'` — which the canonical
 * {@link ApiMediaType} (`'series'`-based) does not. Consumers, however, still
 * compare parsed values against the canonical `'series'`, so the token union
 * spans both conventions rather than narrowing to one.
 */
export type ParsedMediaTypeToken = ApiMediaType | 'tv';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of parsing a media identifier
 */
export interface ParsedMediaId {
    /** Type of identifier that was parsed */
    type: 'uuid' | 'composite';
    /** UUID if type is 'uuid' */
    uuid?: string;
    /** External ID provider if type is 'composite' */
    provider?: string;
    /** External ID value if type is 'composite' */
    externalId?: string;
    /** Media type if type is 'composite' */
    mediaType?: ParsedMediaTypeToken;
}

/**
 * Resolved media identification - always has UUID and optionally external IDs
 */
export interface ResolvedMediaId {
    /** Internal UUID */
    uuid: string;
    /** Provider that was used for lookup (if resolved from composite key) */
    resolvedFrom?: {
        provider: string;
        externalId: string;
        mediaType: ParsedMediaTypeToken;
    };
}

// =============================================================================
// UUID Detection
// =============================================================================

/**
 * UUID v4 regex pattern (with dashes)
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UUID without dashes (Jellyfin format)
 */
const UUID_NO_DASHES_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * Check if a string is a valid UUID (with or without dashes)
 * Jellyfin uses UUIDs without dashes, so we support both formats
 */
export function isUuid(value: string): boolean {
    return UUID_PATTERN.test(value) || UUID_NO_DASHES_PATTERN.test(value);
}

/**
 * Normalize UUID to standard format with dashes
 * Jellyfin uses UUIDs without dashes, this adds them back
 */
export function normalizeUuid(value: string): string {
    // Already has dashes
    if (UUID_PATTERN.test(value)) {
        return value.toLowerCase();
    }

    // Add dashes to Jellyfin-style UUID
    if (UUID_NO_DASHES_PATTERN.test(value)) {
        const clean = value.toLowerCase();
        return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`;
    }

    // Return as-is if not a valid UUID
    return value;
}

// =============================================================================
// Provider Validation
// =============================================================================

/**
 * Valid provider names for composite keys
 */
const VALID_PROVIDERS: ReadonlySet<string> = new Set([
    'tmdb',
    'imdb',
    'tvdb',
    'trakt',
    'mal',
    'jellyfin',
    'jellyseerr',
]);

/**
 * Jellyfin item ids are GUIDs (32 hex, optionally dashed). The id is later
 * interpolated into upstream Jellyfin URLs that carry the admin token, so
 * anything else must not parse as a composite key.
 */
const JELLYFIN_ID_RE =
    /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidExternalId(provider: string, externalId: string): boolean {
    return provider.toLowerCase() !== 'jellyfin' || JELLYFIN_ID_RE.test(externalId);
}

/**
 * Check if a string is a valid provider name
 */
export function isValidProvider(value: string): boolean {
    return VALID_PROVIDERS.has(value.toLowerCase());
}

// =============================================================================
// Media Type Validation
// =============================================================================

/**
 * Valid media types for API routes
 */
const VALID_MEDIA_TYPES: ReadonlySet<string> = new Set(['movie', 'tv', 'episode', 'season']);

/**
 * Check if a string is a valid media type
 */
export function isValidMediaType(value: string): value is ParsedMediaTypeToken {
    return VALID_MEDIA_TYPES.has(value.toLowerCase());
}

/**
 * internal media type → the token a composite key may carry.
 *
 * `ParsedMediaTypeToken` is deliberately the DB-side spelling (`'tv'`, not
 * `'series'`) because that is what appears in a stored key like `tmdb:1399:tv`.
 * Only the four video kinds are addressable this way: a composite key exists to
 * disambiguate a PROVIDER id, and provider ids are what these four have.
 *
 * Exhaustive over `MediaTypeInternal`, so adding a media type is a compile error
 * here until someone decides whether it is key-addressable.
 */
const TO_KEY_TOKEN: Readonly<Record<MediaTypeInternal, ParsedMediaTypeToken | null>> = {
    movie: 'movie',
    tv: 'tv',
    episode: 'episode',
    season: 'season',
    extra: null,
    // Audiobooks and music are addressed by internal UUID, not by a
    // provider-composite key — ApiMediaType has no member for them.
    audiobook: null,
    book: null,
    manga: null,
    comic: null,
    podcast: null,
    artist: null,
    album: null,
    track: null,
    audio: null,
    music: null,
    tvchannel: null,
    radio: null,
    home_video: null,
    training: null,
    educational: null,
    personal: null,
    product: null,
    anfragen: null,
    sonarr: null,
    radarr: null,
};

/**
 * Normalize a composite-key media-type token.
 *
 * Parsing (case handling + the `'series'`/`'show'`/`'film'` aliases) is delegated
 * to `toInternalMediaType` — this used to carry its own copy of that alias
 * switch, which made it a FIFTH place the vocabulary was written down.
 */
export function normalizeMediaType(value: string): ParsedMediaTypeToken | null {
    const internal = toInternalMediaType(value);
    return internal === null ? null : TO_KEY_TOKEN[internal];
}

// =============================================================================
// Media ID Parsing
// =============================================================================

/**
 * Parse a media identifier from a route parameter
 *
 * Supports two formats:
 * - UUID: 550e8400-e29b-41d4-a716-446655440000 (preferred)
 * - Composite: provider:id:mediaType (e.g., tmdb:550:movie)
 *
 * REJECTED formats (return invalid result, validateParsedMediaId() returns false):
 * - Bare numeric IDs: 550 (must use tmdb:550:movie)
 * - Short format: 550:movie (must include provider: tmdb:550:movie)
 * - Legacy tmdbId params: Use composite keys instead
 *
 * Migration guide for legacy code:
 * - Old: parseMediaId(params.tmdbId) with separate mediaType param
 * - New: parseMediaId('tmdb:550:movie') composite key
 *
 * @param id - Route parameter value (UUID or composite key)
 * @param _queryMediaType - REMOVED: No longer supported. Use composite keys instead.
 * @returns Parsed media identifier
 */
export function parseMediaId(id: string, _queryMediaType?: string): ParsedMediaId {
    // Handle empty or null input
    if (!id || typeof id !== 'string') {
        return { type: 'uuid' };
    }

    const trimmed = id.trim();

    // 1. Check for UUID format (preferred)
    if (isUuid(trimmed)) {
        return {
            type: 'uuid',
            uuid: normalizeUuid(trimmed),
        };
    }

    // 2. Check for composite key format: provider:id:mediaType (or provider:id for non-TMDB)
    if (trimmed.includes(':')) {
        const parts = trimmed.split(':');

        // Accept 2-part format for non-TMDB providers: imdb:tt0137523
        if (parts.length === 2) {
            const [provider, externalId] = parts;

            // Validate provider name (rejects numeric like "550:movie")
            // Only allow 2-part for non-TMDB providers (TMDB requires mediaType due to ID collisions)
            if (
                provider &&
                externalId &&
                isValidProvider(provider) &&
                isValidExternalId(provider, externalId) &&
                provider.toLowerCase() !== 'tmdb'
            ) {
                return {
                    type: 'composite',
                    provider: provider.toLowerCase(),
                    externalId,
                    mediaType: undefined, // No mediaType for non-TMDB
                };
            }
        }

        // Accept 3-part format: provider:id:mediaType
        if (parts.length === 3) {
            const [provider, externalId, mediaTypeStr] = parts;
            const mediaType = normalizeMediaType(mediaTypeStr);

            // Validate provider name for consistency
            if (
                provider &&
                externalId &&
                mediaType &&
                isValidProvider(provider) &&
                isValidExternalId(provider, externalId)
            ) {
                return {
                    type: 'composite',
                    provider: provider.toLowerCase(),
                    externalId,
                    mediaType,
                };
            }
        }

        // Reject invalid composite formats
        // Return invalid result so validateParsedMediaId() returns false
        return { type: 'uuid' }; // No uuid = validateParsedMediaId returns false
    }

    // 3. Reject bare numeric IDs (look like TMDB IDs without provider)
    // These should use the full composite format: provider:id:mediaType
    if (/^\d+$/.test(trimmed)) {
        return { type: 'uuid' }; // No uuid = validateParsedMediaId returns false
    }

    // 4. Non-numeric strings without colons could be valid UUIDs
    // Validate UUID format before accepting
    if (isUuid(trimmed)) {
        return {
            type: 'uuid',
            uuid: normalizeUuid(trimmed),
        };
    }

    // Not a valid UUID - reject it
    return { type: 'uuid' }; // No uuid = validateParsedMediaId returns false
}

/**
 * Parse and validate a media type parameter
 * Returns null if invalid
 */
export function parseMediaTypeParam(value: string | null): ParsedMediaTypeToken | null {
    if (!value) return null;
    return normalizeMediaType(value);
}

/**
 * Create a composite key from components
 */
export function createCompositeKey(
    provider: string,
    externalId: string | number,
    mediaType: ApiMediaType,
): string {
    return `${provider}:${externalId}:${mediaType}`;
}

// =============================================================================
// Route Parameter Helpers
// =============================================================================

/**
 * Extract and parse media ID from SvelteKit route params
 *
 * Accepts only:
 * - params.id - Composite key (provider:id:mediaType) or UUID
 * - params.mediaId - Composite key (provider:id:mediaType) or UUID
 *
 * Legacy params.tmdbId support has been REMOVED. Use composite keys instead:
 * - Old: /api/media/550?mediaType=movie (with params.tmdbId)
 * - New: /api/media/tmdb:550:movie (composite key)
 */
export function parseMediaIdFromParams(
    params: Record<string, string>,
    _searchParams: URLSearchParams,
): ParsedMediaId {
    const id = params.id || params.mediaId;
    return parseMediaId(id);
}

/**
 * Validate that a parsed media ID has required fields for lookup
 * For composite keys: provider and externalId required, mediaType required for TMDB only
 */
export function validateParsedMediaId(parsed: ParsedMediaId): boolean {
    if (parsed.type === 'uuid') {
        return !!parsed.uuid;
    }
    // Composite: provider and externalId required
    if (!parsed.provider || !parsed.externalId) {
        return false;
    }
    // TMDB specifically requires mediaType (due to ID collisions across movie/tv)
    if (parsed.provider === 'tmdb' && !parsed.mediaType) {
        return false;
    }
    // Other providers don't require mediaType
    return true;
}

/**
 * Get human-readable description of parsed media ID (for logging/errors)
 */
export function describeParsedMediaId(parsed: ParsedMediaId): string {
    if (parsed.type === 'uuid') {
        return `UUID: ${parsed.uuid || '(missing)'}`;
    }
    return `${parsed.provider}:${parsed.externalId}:${parsed.mediaType}`;
}
