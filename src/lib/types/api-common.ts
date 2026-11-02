// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Common API Types
 *
 * These types are used by BOTH the server (to build responses) and client (to consume them).
 * This ensures TypeScript catches errors at compile time.
 *
 * Convention:
 * - All property names use camelCase
 * - Database columns (snake_case) are transformed at the server boundary
 *
 * Non-generic types are Zod-inferred from schemas (SINGLE SOURCE OF TRUTH).
 * Generic types (ApiSuccessResponse<T>, PaginatedData<T>) remain manually defined
 * as Zod cannot express TypeScript generics.
 */

import type { ExternalIdsResponse } from '$lib/schemas/api-responses';
import type {
    ApiErrorResponse as _ApiErrorResponse,
    ApiMediaType as _ApiMediaType,
    ApiMediaTypeInput as _ApiMediaTypeInput,
    UserReference as _UserReference,
    MediaListItem as _MediaListItem,
    RecommendedMediaItem as _RecommendedMediaItem,
    ProgressMediaItem as _ProgressMediaItem,
} from '$lib/schemas/api-common-responses';
import type { Visibility as _Visibility } from '$lib/schemas/common';

// =============================================================================
// Re-exports from Zod Schemas (SINGLE SOURCE OF TRUTH)
// =============================================================================

// ExternalIds — from api-responses.ts (ExternalIdsResponseSchema). The API
// never sends a Jellyfin id. The optional `jellyfin` field stays on this
// client-side type only so the calendar code (changed separately) still
// compiles; nothing may rely on it being set.
export type ExternalIds = ExternalIdsResponse & {
    /** @deprecated Never sent by the API; Jellyfin ids are sync-only. */
    jellyfin?: string;
};
export { ExternalIdsResponseSchema } from '$lib/schemas/api-responses';

// Types — from api-common-responses.ts
export type ApiErrorResponse = _ApiErrorResponse;
export type ApiMediaType = _ApiMediaType;
/** INPUT-side media type: also admits the stored 'tv'/'show' tokens. */
export type ApiMediaTypeInput = _ApiMediaTypeInput;
export type UserReference = _UserReference;
export type MediaListItem = _MediaListItem;
export type RecommendedMediaItem = _RecommendedMediaItem;
export type ProgressMediaItem = _ProgressMediaItem;

export {
    ApiErrorResponseSchema,
    PaginatedDataSchema,
    ApiMediaTypeSchema,
    UserReferenceSchema,
    MediaListItemSchema,
    RecommendedMediaItemSchema,
    ProgressMediaItemSchema,
} from '$lib/schemas/api-common-responses';

// Visibility — from common.ts
export type Visibility = _Visibility;
export { visibilitySchema as VisibilitySchema } from '$lib/schemas/common';

// =============================================================================
// Pagination Types
// =============================================================================

export interface PaginationParams {
    page?: number;
    limit?: number;
}

export interface PaginatedData<T> {
    items: T[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
}

// =============================================================================
// Common Field Types
// =============================================================================

/**
 * Media type for TMDB/Jellyfin content (playlists, media details, etc.)
 *
 * Convention: TMDB uses lowercase 'movie' | 'tv', Jellyfin uses PascalCase 'Movie' | 'Series'.
 * This type uses lowercase for API consistency, matching TMDB format.
 *
 * Note: Audiobooks and music are handled by separate systems (Audiobookshelf)
 * and use different APIs, so they're not included here.
 * For UI display of all content types, see server-driven-ui.ts MediaType.
 */
export type MediaType = 'movie' | 'tv' | 'episode';

// =============================================================================
// External IDs (Provider-Agnostic)
// =============================================================================

// Note: ExternalIds type is re-exported from ExternalIdsResponseSchema above.
// The following are utility types and functions that complement it.

/**
 * Valid external ID provider names
 */
export type ExternalIdProvider =
    | 'internal'
    | 'tmdb'
    | 'imdb'
    | 'tvdb'
    | 'trakt'
    | 'mal'
    | 'anilist'
    | 'audiobookshelf'
    | 'kavita';

/**
 * Composite media key format: provider:id:mediaType
 * Example: "tmdb:550:movie", "imdb:tt0137523:movie"
 */
export type MediaKey = `${string}:${string}:${ApiMediaType}`;

// =============================================================================
// Media Key Utilities
// =============================================================================

/**
 * Create a composite media key
 * @param provider - External ID provider (e.g., 'tmdb', 'imdb')
 * @param id - External ID value
 * @param mediaType - Media type
 * @returns Formatted media key
 */
export function mediaKey(provider: string, id: string | number, mediaType: ApiMediaType): MediaKey {
    return `${provider}:${id}:${mediaType}` as MediaKey;
}

/**
 * Parse a composite media key
 * @param key - Media key string to parse
 * @returns Parsed components or null if invalid
 */
export function parseMediaKey(key: string): {
    provider: string;
    id: string;
    mediaType: ApiMediaType;
} | null {
    const parts = key.split(':');
    if (parts.length !== 3) return null;

    const [provider, id, mediaType] = parts;
    if (!provider || !id || !mediaType) return null;

    // Validate media type
    if (!['movie', 'tv', 'episode', 'season'].includes(mediaType)) {
        return null;
    }

    return {
        provider,
        id,
        mediaType: mediaType as ApiMediaType,
    };
}

// =============================================================================
// External ID Helpers
// =============================================================================

/**
 * Extract a specific external ID from ExternalIds object
 */
export function getExternalId(
    externalIds: ExternalIds | undefined,
    provider: ExternalIdProvider,
): string | undefined {
    return externalIds?.[provider];
}

// NOTE: getPrimaryExternalId and hasExternalId have been removed.
// Use getPreferredExternalId() and hasAnyExternalId() from '$lib/utils/external-ids' instead.

/**
 * Convert ExternalIds to a record suitable for database storage
 */
export function externalIdsToRecord(externalIds: ExternalIds): Record<string, string> {
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(externalIds)) {
        if (value !== undefined && value !== null) {
            record[key] = String(value);
        }
    }
    return record;
}

/**
 * Create ExternalIds from database records
 */
export function externalIdsFromRecords(
    records: Array<{ provider: string; external_id: string }>,
): ExternalIds {
    const ids: ExternalIds = {};
    for (const record of records) {
        const provider = record.provider.toLowerCase() as ExternalIdProvider;
        if (['tmdb', 'imdb', 'tvdb', 'trakt', 'mal', 'anilist'].includes(provider)) {
            ids[provider] = record.external_id;
        }
    }
    return ids;
}
