// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Common API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for common API response types.
 * These schemas define standard response wrappers and common media item structures.
 *
 * Usage:
 * - Server: Validate responses before sending
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { coerceLegacyTvToSeries } from './common';
import { ExternalIdsResponseSchema } from './api-responses';

// ============================================================================
// Generic API Response Wrappers
// ============================================================================

/**
 * Standard error API response.
 * Server uses ApiResponses.error() which returns this format.
 */
export const ApiErrorResponseSchema = z
    .object({
        /** Success flag (always false for errors) */
        success: z.literal(false).describe('Success flag'),
        /** Error message */
        error: z.string().describe('Error message'),
        /** ISO 8601 timestamp */
        timestamp: z.string().describe('ISO 8601 timestamp'),
    })
    .meta({
        id: 'ApiErrorResponse',
        description: 'Standard error API response',
    });

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

// ============================================================================
// Pagination Types
// ============================================================================

/**
 * Paginated response wrapper
 */
export const PaginatedDataSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
    z
        .object({
            /** Array of items in this page */
            items: z.array(itemSchema).describe('Items in this page'),
            /** Total number of items across all pages */
            total: z.number().int().min(0).describe('Total items'),
            /** Current page number (1-indexed) */
            page: z.number().int().min(1).describe('Current page number'),
            /** Items per page limit */
            limit: z.number().int().min(1).describe('Items per page'),
            /** Whether more pages exist */
            hasMore: z.boolean().describe('More pages exist'),
        })
        .meta({ description: 'Paginated response wrapper' });

export type PaginatedData<T> = {
    items: T[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
};

// ============================================================================
// Common Field Types
// ============================================================================

/**
 * Media type for TMDB/Jellyfin content (API consistency)
 */
export const ApiMediaTypeSchema = z
    .preprocess(coerceLegacyTvToSeries, z.enum(['movie', 'series', 'episode', 'season']))
    .describe('Media type (lowercase for TMDB consistency)')
    .meta({ id: 'ApiMediaType' });

export type ApiMediaType = z.infer<typeof ApiMediaTypeSchema>;

/**
 * What a caller may SEND where a media type is expected.
 *
 * `ApiMediaType` is the OUTPUT of `ApiMediaTypeSchema`, but that schema's
 * `z.preprocess(coerceLegacyTvToSeries, …)` deliberately also accepts the stored
 * tokens `'tv'`/`'show'` — and `media_items.media_type` / `external_ids.media_type`
 * hold exactly `'tv'`. Client code therefore holds `'tv'` legitimately: composite
 * keys (`tmdb:<id>:tv`) are matched VERBATIM against `external_ids.media_type` by
 * `resolveComposite()`, so rewriting them to `'series'` would break resolution.
 *
 * Typing those parameters as the output type made runtime-correct calls fail to
 * compile (19 of the errors in this pass) and invited `as` casts that the
 * `no-narrowing-media-type-cast` rule exists to prevent. Use this type at INPUT
 * boundaries; keep `ApiMediaType` for anything describing a RESPONSE.
 */
export type ApiMediaTypeInput = ApiMediaType | 'tv' | 'show';

// Note: Visibility is defined in common.ts to avoid duplication

/**
 * Common user reference in API responses
 */
export const UserReferenceSchema = z
    .object({
        /** Username */
        username: z.string().describe('Username'),
        /** Optional user ID */
        userId: z.string().optional().describe('User ID'),
    })
    .meta({
        id: 'UserReference',
        description: 'User reference in API responses',
    });

export type UserReference = z.infer<typeof UserReferenceSchema>;

// ============================================================================
// Provider-Agnostic Media Types
// ============================================================================

/**
 * Standard media item for API responses.
 * Provider-agnostic structure used across all endpoints.
 */
export const MediaListItemSchema = z
    .object({
        /** Internal UUID */
        id: z.string().describe('Internal UUID'),
        /** External IDs from various providers */
        externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
        /** Media type */
        mediaType: ApiMediaTypeSchema,
        /** Display title */
        title: z.string().describe('Display title'),
        /** Original title (if different) */
        originalTitle: z.string().optional().describe('Original title'),
        /** English title (if different) */
        englishTitle: z.string().optional().describe('English title'),
        /** Short description */
        overview: z.string().optional().describe('Short description'),
        /** Release year */
        year: z.number().int().optional().describe('Release year'),
        /** Poster image path (relative or provider-specific) */
        posterPath: z.string().optional().describe('Poster image path'),
        /** Backdrop image path */
        backdropPath: z.string().optional().describe('Backdrop image path'),
        /** Average rating (0-10 scale) */
        rating: z.number().min(0).max(10).optional().describe('Average rating (0-10)'),
        /** Rating source (e.g., 'tmdb', 'imdb') */
        ratingSource: z.string().optional().describe('Rating source'),
        /** Content is available in library */
        isAvailable: z.boolean().describe('Available in library'),
        /** Content can be requested via Jellyseerr */
        canRequest: z.boolean().describe('Can be requested'),
        /** Genres */
        genres: z.array(z.string()).optional().describe('Genres'),
        /** Runtime in minutes */
        runtime: z.number().int().min(0).optional().describe('Runtime in minutes'),
    })
    .meta({
        id: 'MediaListItem',
        description: 'Standard media item for API responses',
    });

export type MediaListItem = z.infer<typeof MediaListItemSchema>;

/**
 * Extended media item with recommendation metadata
 */
export const RecommendedMediaItemSchema = MediaListItemSchema.extend({
    /** Vector similarity score (0-1) */
    similarity: z.number().min(0).max(1).optional().describe('Vector similarity score (0-1)'),
    /** Human-readable recommendation reason */
    reason: z.string().optional().describe('Recommendation reason'),
    /** Recommendation source (e.g., 'similar', 'because_watched', 'trending') */
    source: z.string().optional().describe('Recommendation source'),
}).meta({
    id: 'RecommendedMediaItem',
    description: 'Media item with recommendation metadata',
});

export type RecommendedMediaItem = z.infer<typeof RecommendedMediaItemSchema>;

/**
 * Media item with progress information (for continue watching)
 */
export const ProgressMediaItemSchema = MediaListItemSchema.extend({
    /** Playback progress (0-1) */
    progress: z.number().min(0).max(1).optional().describe('Playback progress (0-1)'),
    /** Progress in ticks */
    progressTicks: z.number().int().min(0).optional().describe('Progress in ticks'),
    /** Total runtime in ticks */
    runtimeTicks: z.number().int().min(0).optional().describe('Total runtime in ticks'),
    /** Last played timestamp (ISO 8601) */
    lastPlayed: z.string().optional().describe('Last played timestamp'),
    /** For episodes: season number */
    seasonNumber: z.number().int().min(0).optional().describe('Season number'),
    /** For episodes: episode number */
    episodeNumber: z.number().int().min(0).optional().describe('Episode number'),
    /** For episodes: series title */
    seriesTitle: z.string().optional().describe('Series title'),
    /** For episodes: series ID */
    seriesId: z.string().optional().describe('Series ID'),
}).meta({
    id: 'ProgressMediaItem',
    description: 'Media item with progress information',
});

export type ProgressMediaItem = z.infer<typeof ProgressMediaItemSchema>;
