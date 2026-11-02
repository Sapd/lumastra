// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { MediaPreviewSchema } from './api-media-preview.js';

/**
 * Browse API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for browse API response types.
 * These schemas define the contract for /api/browse/* endpoints.
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

import { ImageSetSchema } from './api-image-descriptor.js';
import { z } from 'zod';
import { PageBlockSchema } from './pagination';
import { coerceLegacyTvToSeries } from './common';
import { UniversalMediaItemSchema } from './api-responses';

// ============================================================================
// Browse Response (/api/browse)
// ============================================================================

/**
 * Browse filter option
 */
export const BrowseFilterOptionSchema = z
    .object({
        /** Filter value */
        value: z.string().describe('Filter value'),
        /** Display label */
        label: z.string().describe('Display label'),
        /** Optional count */
        count: z.number().int().optional().describe('Item count'),
    })
    .meta({ id: 'BrowseFilterOption', description: 'Browse filter option' });

export type BrowseFilterOption = z.infer<typeof BrowseFilterOptionSchema>;

/**
 * Browse filter group
 */
export const BrowseFilterGroupSchema = z
    .object({
        /** Group ID */
        id: z.string().describe('Group ID'),
        /** Group label */
        label: z.string().describe('Group label'),
        /** Filter options */
        options: z.array(BrowseFilterOptionSchema).describe('Filter options'),
    })
    .meta({ id: 'BrowseFilterGroup', description: 'Browse filter group' });

export type BrowseFilterGroup = z.infer<typeof BrowseFilterGroupSchema>;

/**
 * Browse item (returned by /api/browse and /api/browse/recent)
 *
 * `type` is the canonical public discriminator: 'movie' | 'series'.
 * Legacy consumers may still pass items through helper functions that check
 * for 'series' via isSeries() which already recognises both 'series' and 'tv'.
 */
export const BrowseItemSchema = z
    .object({
        id: z.string().describe('Item ID'),
        name: z.string().describe('Item name'),
        seasonCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('seasonCount in the current catalog/user scope'),
        episodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('episodeCount in the current catalog/user scope'),
        availableEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('availableEpisodeCount in the current catalog/user scope'),
        watchedEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('watchedEpisodeCount in the current catalog/user scope'),
        unwatchedEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('unwatchedEpisodeCount in the current catalog/user scope'),

        /** Canonical media type — 'movie' or 'series' (never 'tv') */
        type: z.enum(['movie', 'series']).describe('Media type'),
        overview: z.string().nullish().describe('Overview'),
        imageId: z.string().nullish().describe('Image ID'),
        number: z.string().nullish().describe('Channel number'),
        // buildBrowseGenreSections emits these on genre items — declare them.
        communityRating: z.number().nullish().describe('Community rating (popularity score)'),
        year: z.number().int().nullish().describe('Release year'),
    })
    .meta({ id: 'BrowseItem', description: 'Browse item' });

export type BrowseItem = z.infer<typeof BrowseItemSchema>;

/**
 * Genre row with items
 */
export const BrowseGenreRowSchema = z
    .object({
        genre: z.string().describe('Genre name'),
        items: z.array(BrowseItemSchema).describe('Genre items'),
    })
    .meta({ id: 'BrowseGenreRow', description: 'Browse genre row' });

export type BrowseGenreRow = z.infer<typeof BrowseGenreRowSchema>;

/**
 * Browse response
 */
export const BrowseResponseSchema = z
    .object({
        /** Recently added items */
        recentlyAdded: z.array(BrowseItemSchema).optional().describe('Recently added'),
        /** Genre rows */
        genres: z.array(BrowseGenreRowSchema).optional().describe('Genres'),
        /** Live TV channels */
        channels: z.array(BrowseItemSchema).optional().describe('Channels'),
        /** Continue watching items */
        continueWatching: z.array(BrowseItemSchema).optional().describe('Continue watching'),
        /** Next up items */
        nextUp: z.array(BrowseItemSchema).optional().describe('Next up'),
        /** Total genres count */
        totalGenres: z.number().optional().describe('Total genres'),
        /** Whether more genres are available */
        hasMoreGenres: z.boolean().optional().describe('Has more genres'),
        /** Whether the media server is available (generic, not provider-specific) */
        mediaServerAvailable: z
            .boolean()
            .optional()
            .describe('Whether the media server is currently reachable'),
    })
    .meta({ id: 'BrowseResponse', description: 'Browse response' });

export type BrowseResponse = z.infer<typeof BrowseResponseSchema>;

// ============================================================================
// Browse Keywords Response (/api/browse/keywords)
// ============================================================================

/**
 * External IDs object for keyword browse items
 */
export const KeywordExternalIdsSchema = z
    .object({
        /** TMDB ID as string */
        tmdb: z.string().describe('TMDB ID'),
    })
    .meta({
        id: 'KeywordExternalIds',
        description: 'External IDs for keyword browse item',
    });

export type KeywordExternalIds = z.infer<typeof KeywordExternalIdsSchema>;

/**
 * Keyword browse item (returned by TMDB keyword discovery)
 */
export const KeywordBrowseItemSchema = z
    .object({
        /** TMDB numeric ID */
        id: z.number().describe('TMDB ID'),
        /** External IDs */
        externalIds: KeywordExternalIdsSchema.describe('External IDs'),
        /** Item name/title */
        name: z.string().describe('Item name'),
        seasonCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('seasonCount in the current catalog/user scope'),
        episodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('episodeCount in the current catalog/user scope'),
        availableEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('availableEpisodeCount in the current catalog/user scope'),
        watchedEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('watchedEpisodeCount in the current catalog/user scope'),
        unwatchedEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('unwatchedEpisodeCount in the current catalog/user scope'),

        /** Media type (movie or series) */
        type: z.enum(['movie', 'series']).describe('Media type'),
        /** Release year */
        year: z.string().optional().describe('Release year'),
        /** Overview/description */
        overview: z.string().optional().describe('Overview'),
        /** Vote average rating */
        rating: z.number().optional().describe('Rating'),
        /** YouTube trailer URL */
        trailerUrl: z.string().optional().describe('Trailer URL'),
        /** TMDB poster path */
        posterPath: z.string().nullish().describe('Poster path'),
        /** TMDB backdrop path */
        backdropPath: z.string().nullish().describe('Backdrop path'),
        /** Whether the item is available in the local library */
        isAvailable: z.boolean().describe('Is available locally'),
    })
    .meta({
        id: 'KeywordBrowseItem',
        description: 'Keyword browse item from TMDB discovery',
    });

export type KeywordBrowseItem = z.infer<typeof KeywordBrowseItemSchema>;

/**
 * Keyword section (keyword with items)
 */
export const KeywordSectionSchema = z
    .object({
        /** Keyword name */
        keyword: z.string().describe('Keyword'),
        /** Keyword ID */
        keywordId: z.number().describe('Keyword ID'),
        /** Items for this keyword */
        items: z.array(MediaPreviewSchema).describe('Items'),
    })
    .meta({ id: 'KeywordSection', description: 'Keyword section' });

export type KeywordSection = z.infer<typeof KeywordSectionSchema>;

/**
 * Available keyword
 */
export const AvailableKeywordSchema = z
    .object({
        /** Keyword ID */
        id: z.number().describe('Keyword ID'),
        /** Keyword name */
        name: z.string().describe('Keyword name'),
    })
    .meta({ id: 'AvailableKeyword', description: 'Available keyword' });

export type AvailableKeyword = z.infer<typeof AvailableKeywordSchema>;

/**
 * Browse keywords response
 */
export const BrowseKeywordsResponseSchema = z
    .object({
        /** Keyword sections with items */
        items: z.array(KeywordSectionSchema).describe('Keyword sections'),
        /** Available keywords for selection */
        availableKeywords: z.array(AvailableKeywordSchema).describe('Available keywords'),
        page: PageBlockSchema,
    })
    .meta({
        id: 'BrowseKeywordsResponse',
        description: 'Browse keywords response',
    });

export type BrowseKeywordsResponse = z.infer<typeof BrowseKeywordsResponseSchema>;

// ============================================================================
// Libraries Response (/api/browse/libraries)
// ============================================================================

/**
 * Library item
 */
export const LibraryItemSchema = z
    .object({
        images: ImageSetSchema.optional(),
        /** Library group ID */
        id: z.string().describe('Library group ID'),
        /** Library name */
        name: z.string().describe('Library name'),
        /** Item count */
        itemCount: z.number().int().describe('Item count'),
        /** Library media type */
        mediaType: z
            .preprocess(coerceLegacyTvToSeries, z.enum(['movie', 'series', 'mixed']))
            .describe('Library media type'),
        /** Icon name or emoji */
        icon: z.string().optional().describe('Icon name or emoji'),
        /** Description */
        description: z.string().optional().describe('Description'),
    })
    .meta({ id: 'LibraryItem', description: 'Library group item' });

export type LibraryItem = z.infer<typeof LibraryItemSchema>;

/**
 * Libraries response
 */
export const LibrariesResponseSchema = z
    .object({
        /** Libraries */
        libraries: z.array(LibraryItemSchema).describe('Libraries'),
        /** Total libraries count */
        totalLibraries: z.number().describe('Total libraries'),
    })
    .meta({ id: 'LibrariesResponse', description: 'Libraries response' });

export type LibrariesResponse = z.infer<typeof LibrariesResponseSchema>;

// ============================================================================
// A-Z Browse Response (/api/browse/az)
// ============================================================================

/**
 * Letter count
 */
export const LetterCountSchema = z
    .object({
        /** Letter */
        letter: z.string().describe('Letter'),
        /** Item count */
        count: z.number().int().describe('Item count'),
    })
    .meta({ id: 'LetterCount', description: 'Letter count' });

export type LetterCount = z.infer<typeof LetterCountSchema>;

/**
 * Genre count — the genre-axis analogue of {@link LetterCountSchema}.
 *
 * `name` is the exact value to send back as `?genre=`; `count` is how many items
 * the current filter scope holds for it. Only genres with content are emitted,
 * so a client can render the full set as pills without landing a viewer on an
 * empty grid.
 */
export const GenreCountSchema = z
    .object({
        /** Genre name — pass back verbatim as `?genre=` */
        name: z.string().describe('Genre name (pass back verbatim as ?genre=)'),
        /** Item count in the current filter scope */
        count: z.number().int().describe('Item count in the current filter scope'),
    })
    .meta({ id: 'GenreCount', description: 'Genre name with item count' });

export type GenreCount = z.infer<typeof GenreCountSchema>;

/**
 * Keyword count — the keyword-axis analogue of {@link GenreCountSchema}.
 *
 * `keyword` is the exact value to send back as `?tag=`, in the projection's own
 * normalized form (lowercased, spaces preserved — `whodunit`, `time travel`).
 */
export const KeywordCountSchema = z
    .object({
        keyword: z.string().describe('Keyword (pass back verbatim as ?tag=)'),
        count: z.number().int().describe('Items matching this tag in the current filter scope'),
    })
    .meta({ id: 'KeywordCount', description: 'Keyword with item count' });

export type KeywordCount = z.infer<typeof KeywordCountSchema>;

/**
 * Genres response — GET /api/browse/genres. The set of genres that actually have
 * content under the requested scope, count-descending. The companion to
 * `?genre=` on /browse/az: render these as the rail, send `name` back as the
 * filter.
 */
export const BrowseGenresResponseSchema = z
    .object({
        genres: z.array(GenreCountSchema).describe('Genres with content, count-descending'),
        /** Applied media-type filter (movie | series | all) */
        mediaType: z.string().optional().describe('Applied media-type filter'),
        /** Applied library group filter */
        libraryGroupId: z.string().optional().describe('Library group ID filter'),
    })
    .meta({ id: 'BrowseGenresResponse', description: 'Genre facet for browse' });

export type BrowseGenresResponse = z.infer<typeof BrowseGenresResponseSchema>;

/**
 * A-Z browse response
 */
export const AzBrowseResponseSchema = z
    .object({
        /** Items for the current page */
        items: z.array(UniversalMediaItemSchema).optional().describe('Items'),
        page: PageBlockSchema,
        /** Media type filter */
        mediaType: z.string().optional().describe('Media type filter'),
        /** Current letter filter */
        letter: z.string().optional().describe('Current letter'),
        /** Library group ID filter */
        libraryGroupId: z.string().optional().describe('Library group ID filter'),
        /** Current genre filter */
        genre: z.string().optional().describe('Current genre filter'),
        /** Current keyword/tag filter — echoed back exactly as `?tag=` sent it */
        tag: z.string().optional().describe('Current keyword/tag filter'),
        /** Letter counts for navigation */
        letterCounts: z.array(LetterCountSchema).optional().describe('Letter counts'),
        /**
         * Genre counts for the current scope — the genre-axis twin of
         * `letterCounts`. Computed with the `genre` narrowing removed (so a
         * client can switch genres from one response) but every other filter
         * applied. Only genres with content appear.
         */
        genreCounts: z
            .array(GenreCountSchema)
            .optional()
            .describe('Genre counts for the current scope (genre filter itself excluded)'),
        keywordCounts: z
            .array(KeywordCountSchema)
            .optional()
            .describe('Keyword facet for the current filter scope (excludes the tag axis itself)'),
    })
    .meta({ id: 'AzBrowseResponse', description: 'A-Z browse response' });

export type AzBrowseResponse = z.infer<typeof AzBrowseResponseSchema>;

/**
 * Genre browse response — GET /api/browse/genre/{name}. A page of library items
 * in the requested genre (library-local, `has_files = true`), ordered by
 * popularity, with offset pagination.
 */
export const GenreBrowseResponseSchema = z
    .object({
        items: z.array(UniversalMediaItemSchema).optional().describe('Items for the current page'),
        genre: z.string().optional().describe('The genre name being browsed'),
        page: PageBlockSchema,
        mediaType: z
            .string()
            .optional()
            .describe('Applied media-type filter (movie | series | all)'),
    })
    .meta({ id: 'GenreBrowseResponse', description: 'Paginated genre browse response' });

export type GenreBrowseResponse = z.infer<typeof GenreBrowseResponseSchema>;

/** Public browse sections use the same card contract as all discovery lists. */
export const MediaBrowseResponseSchema = z
    .object({
        recentlyAdded: z.array(MediaPreviewSchema),
        genres: z.array(z.object({ genre: z.string(), items: z.array(MediaPreviewSchema) })),
        continueWatching: z.array(MediaPreviewSchema),
        nextUp: z.array(MediaPreviewSchema),
        totalGenres: z.number(),
        hasMoreGenres: z.boolean(),
        mediaServerAvailable: z.boolean(),
    })
    .meta({ id: 'MediaBrowseResponse' });
