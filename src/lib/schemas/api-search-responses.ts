// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Search Response Zod Schemas
 *
 * Zod schemas for search-related types used across the application.
 * These schemas define the contract for search API endpoints and client-side validation.
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
import { searchMediaTypeSchema } from './browse';

// Re-export SearchMediaType from browse.ts to avoid duplication
export { searchMediaTypeSchema as SearchMediaTypeSchema };
export type { SearchMediaType } from './browse';

/**
 * Runtime array of every `type` the search endpoint can emit — the SINGLE
 * SOURCE OF TRUTH shared by the OpenAPI response enum (search/_openapi.ts) and
 * the search service, so the two can never drift. It lives HERE (a light schema
 * module) rather than in search.service.ts so `_openapi.ts` can import it
 * WITHOUT pulling the heavy service→cache→tasks→lua chain (which crashes the
 * OpenAPI generator under tsx — see the openapi:check def-import guard).
 *
 * Full cross-entity union: catalog (movie|series|episode|track|album|artist)
 * plus the auxiliary search sources (books/comics/audiobooks/requests/live TV/
 * non-entertainment). Search spans more entities than the catalog media spine.
 */
export const SEARCH_RESULT_TYPES = [
    'movie',
    'series',
    'episode',
    'track',
    'album',
    'artist',
    'book',
    'manga',
    'comic',
    'audiobook',
    'request',
    'tvchannel',
    'home_video',
    'training',
    'educational',
    'personal',
] as const;

/** Full cross-entity search type union, derived from {@link SEARCH_RESULT_TYPES}. */
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

// ============================================================================
// Search Result Item
// ============================================================================

/**
 * A single search result item as returned by the /api/search endpoint.
 * This is the raw item before transformation to UniversalMediaItem.
 *
 * Supports multiple content sources:
 * - Jellyfin: Movies, series, episodes, TV channels
 * - Audiobookshelf: Audiobooks
 * - Kavita: Books, manga, comics
 * - Jellyseerr: Requests (ANFRAGEN)
 */
export const SearchResultItemSchema = z
    .object({
        // === Core identifiers ===
        /** Internal UUID from media_items.id */
        id: z.string().describe('Internal media UUID'),
        /** Display title */
        title: z.string().describe('Display title'),
        /** Media type discriminator */
        mediaType: searchMediaTypeSchema,
        /** External IDs from various providers (provider-agnostic) */
        externalIds: ExternalIdsResponseSchema.optional().describe('External provider IDs'),

        // === Display information ===
        /** Overview/description text */
        overview: z.string().optional().describe('Overview'),
        /** Rating (0-10 scale) */
        rating: z.number().optional().describe('Rating (0-10)'),
        /** Release/air year */
        year: z.number().optional().describe('Release year'),
        /** Genre array */
        genres: z.array(z.string()).optional().describe('Genres'),
        /** Poster/thumbnail image URL */
        imageUrl: z.string().optional().describe('Poster URL'),

        // === Episode-specific fields ===
        /** Series name (for episodes) */
        seriesName: z.string().optional().describe('Series name'),
        /** Season number (for episodes) */
        seasonNumber: z.number().int().optional().describe('Season number'),
        /** Episode number (for episodes) */
        episodeNumber: z.number().int().optional().describe('Episode number'),
        /** Series UUID (for episodes) */
        seriesId: z.string().optional().describe('Series UUID'),

        // === Series-specific fields ===
        /** Number of seasons (for series) */
        seasonCount: z.number().int().optional().describe('Number of seasons'),

        // === Book/audiobook-specific ===
        /** Author name (for books/audiobooks) */
        author: z.string().optional().describe('Author name'),
        /** Kavita/Audiobookshelf library ID */
        libraryId: z.union([z.number(), z.string()]).optional().describe('Library ID'),
        /** Library display name */
        libraryName: z.string().optional().describe('Library name'),

        // === Request-specific fields (provider-agnostic) ===
        /** Underlying media type for request items (movie or tv) */
        requestMediaType: z
            .enum(['movie', 'tv'])
            .optional()
            .describe('Underlying media type for request items'),
        /** Request status from the request provider */
        requestStatus: z
            .enum(['unknown', 'pending', 'processing', 'partially_available', 'available'])
            .optional()
            .describe('Request status'),

        // === Watch status ===
        /** Whether the item has been fully watched */
        isWatched: z.boolean().optional().describe('Fully watched status'),

        // === Fulltext search match info ===
        /** Where the search matched (title, overview, actor, etc.) */
        matchSource: z.string().optional().describe('Search match location'),
        /** Snippet of text showing the match context */
        matchSnippet: z.string().optional().describe('Match context snippet'),

        // === Search ranking ===
        /** Search ranking score (higher = better match) */
        rank: z.number().optional().describe('Search rank score'),

        // === Music-specific fields ===
        /** Artist name (for tracks and albums) */
        artistName: z.string().optional().describe('Artist name'),

        // === Non-entertainment metadata ===
        /** Custom metadata for non-entertainment types */
        customMetadata: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Custom metadata for non-entertainment types'),
    })
    .meta({
        id: 'SearchResultItem',
        description: 'Single search result item before UniversalMediaItem transformation',
    });

export type SearchResultItem = z.infer<typeof SearchResultItemSchema>;

// ============================================================================
// Grouped Results
// ============================================================================

/**
 * Search results grouped by media type for display.
 * Each media type has an optional array of results.
 *
 * Uses a record type to allow string indexing for dynamic category access
 * while maintaining type safety for known media types.
 */
export const GroupedSearchResultsSchema = z
    .object({
        /** Movie search results */
        MOVIE: z.array(SearchResultItemSchema).optional().describe('Movie results'),
        /** Series search results */
        SERIES: z.array(SearchResultItemSchema).optional().describe('Series results'),
        /** Episode search results */
        EPISODE: z.array(SearchResultItemSchema).optional().describe('Episode results'),
        /** Audiobook search results */
        AUDIOBOOK: z.array(SearchResultItemSchema).optional().describe('Audiobook results'),
        /** Request search results (Jellyseerr) */
        ANFRAGEN: z.array(SearchResultItemSchema).optional().describe('Request results'),
        /** TV channel search results */
        TVCHANNEL: z.array(SearchResultItemSchema).optional().describe('TV channel results'),
        /** Book search results (Kavita) */
        BOOK: z.array(SearchResultItemSchema).optional().describe('Book results'),
        /** Manga search results (Kavita) */
        MANGA: z.array(SearchResultItemSchema).optional().describe('Manga results'),
        /** Comic search results (Kavita) */
        COMIC: z.array(SearchResultItemSchema).optional().describe('Comic results'),
    })
    .catchall(z.array(SearchResultItemSchema).optional()) // Allow dynamic string indexing
    .meta({
        id: 'GroupedSearchResults',
        description: 'Search results grouped by media type',
    });

export type GroupedSearchResults = z.infer<typeof GroupedSearchResultsSchema>;

// ============================================================================
// Series Item (for episode picker)
// ============================================================================

/**
 * A series item used with SeriesEpisodePicker.
 * This is what gets assigned to selectedSeries when a series is clicked.
 *
 * Minimal structure needed for the episode picker to function:
 * - id: Required for fetching episodes
 * - title: Required for display
 * - imageUrl: Optional poster image
 * - externalIds: Optional external provider IDs
 * - name: Alternative to title (used in some contexts)
 */
export const SeriesSearchItemSchema = z
    .object({
        /** Internal UUID for fetching episodes */
        id: z.string().describe('Internal media UUID'),
        /** Series display title */
        title: z.string().describe('Series display title'),
        /** Poster image URL */
        imageUrl: z.string().optional().describe('Poster URL'),
        /** External IDs from various providers */
        externalIds: ExternalIdsResponseSchema.optional().describe('External provider IDs'),
        /** Alternative name field (used in some contexts) */
        name: z.string().optional().describe('Alternative name field'),
    })
    .meta({
        id: 'SeriesSearchItem',
        description: 'Series item for episode picker',
    });

export type SeriesSearchItem = z.infer<typeof SeriesSearchItemSchema>;

// ============================================================================
// Available Categories
// ============================================================================

/**
 * Available search categories as returned by /api/search/available-categories.
 * Used to show/hide category filter chips based on what content is available.
 *
 * Categories correspond to:
 * - Kavita: book, manga, comic
 * - Audiobookshelf: audiobook
 * - Jellyseerr: anfragen (requests)
 * - Jellyfin: tvchannel (requires permission)
 */
export const AvailableCategoriesSchema = z
    .object({
        /** Kavita books available */
        book: z.boolean().describe('Books available (Kavita)'),
        /** Kavita manga available */
        manga: z.boolean().describe('Manga available (Kavita)'),
        /** Kavita comics available */
        comic: z.boolean().describe('Comics available (Kavita)'),
        /** Audiobookshelf audiobooks available */
        audiobook: z.boolean().describe('Audiobooks available (Audiobookshelf)'),
        /** Jellyseerr requests available */
        anfragen: z.boolean().describe('Requests available (Jellyseerr)'),
        /** Live TV channels available (requires permission) */
        tvchannel: z.boolean().describe('TV channels available (Jellyfin)'),
        /** Music library available (tracks/albums in database) */
        music: z.boolean().optional().describe('Music library available'),
        /** Non-entertainment library types */
        home_video: z.boolean().optional().describe('Home videos library available'),
        training: z.boolean().optional().describe('Training library available'),
        educational: z.boolean().optional().describe('Educational library available'),
        personal: z.boolean().optional().describe('Personal media library available'),
    })
    .meta({
        id: 'AvailableCategories',
        description: 'Available search categories based on configured services',
    });

export type AvailableCategories = z.infer<typeof AvailableCategoriesSchema>;

// ============================================================================
// Category Configuration
// ============================================================================

/**
 * Category configuration for display in the search UI.
 * Defines the appearance and behavior of category filter chips.
 */
export const CategoryConfigSchema = z
    .object({
        /** Category identifier (matches SearchMediaType values) */
        key: z.string().describe('Category identifier'),
        /** Display label for the filter chip */
        label: z.string().describe('Display label'),
        /** Icon name (maps to svelte-hero-icons via icon-map) */
        icon: z.string().describe('Icon name'),
        /** Background/border color class (Tailwind) */
        color: z.string().describe('Background color class'),
        /** Icon color class (Tailwind) */
        iconColor: z.string().describe('Icon color class'),
    })
    .extend({
        /**
         * Canonical lowercase media type for onselectitem callbacks and watch-party dispatching.
         * undefined for categories with no playback equivalent (books, audiobooks, anfragen).
         */
        playbackMediaType: z
            .preprocess(coerceLegacyTvToSeries, z.enum(['movie', 'series', 'episode', 'tvchannel']))
            .optional()
            .describe('Playback media type for onselectitem callbacks'),
        /**
         * Whether similar-content suggestions are available for this category.
         * Controls whether similar-content suggestions appear for this category in the UI.
         */
        supportsSimilar: z.boolean().optional().describe('Supports similar content suggestions'),
        /**
         * True for categories served by an external service (Kavita, Audiobookshelf, Jellyseerr).
         * These categories do not open the internal media modal on item click.
         */
        isExternalService: z
            .boolean()
            .optional()
            .describe('Backed by an external service rather than Jellyfin'),
    })
    .meta({
        id: 'CategoryConfig',
        description: 'Category filter chip configuration for search UI',
    });

export type CategoryConfig = z.infer<typeof CategoryConfigSchema>;
