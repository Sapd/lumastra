// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for browse and search API routes
 *
 * Covers media browsing, search queries, and category discovery
 */

import { z } from 'zod';
import { optionalStringSchema, coerceBooleanSchema } from './common';
import {
    AUDIO_FILTER_LANGUAGES,
    SUBTITLE_FILTER_LANGUAGES,
    parseLangCsv,
} from '$lib/shared/track-language.js';
import {
    RESOLUTION_TIERS,
    HDR_TIERS,
    CODEC_TIERS,
    parseTierCsv,
} from '$lib/shared/quality-filter.js';

// ============================================================================
// Browse Endpoints
// ============================================================================

/**
 * Canonical media type filter for browse endpoints.
 *
 * Accepted input (query string):
 *   Canonical:  'movie' | 'series' | 'channels' | 'all'
 *   Deprecated: 'movies' (→ 'movie'), 'tv' (→ 'series')
 *
 * Output is always the canonical singular value.
 */
export const browseMediaTypeSchema = z.preprocess(
    (val) => {
        if (val === 'movies') return 'movie';
        if (val === 'tv') return 'series';
        return val;
    },
    z.enum(['movie', 'series', 'channels', 'all']),
);

export type BrowseMediaType = z.infer<typeof browseMediaTypeSchema>;

/**
 * Query params for browse endpoint
 */
export const browseQuerySchema = z.object({
    type: browseMediaTypeSchema.default('all'),
    genreOffset: z.coerce.number().int().min(0).default(0),
    genreLimit: z.coerce.number().int().min(1).max(50).default(12),
});

export type BrowseQuery = z.infer<typeof browseQuerySchema>;

// ============================================================================
// Browse Recently Added Endpoint (/api/browse/recent)
// ============================================================================

/**
 * Newness mode for the filterable Recently Added surface.
 *
 * - everything: newest file anywhere in the title (any new episode resurfaces
 *   the series).
 * - seasons: a whole new season bumps the title; extra episodes added to an
 *   existing season do not.
 * - titles: only brand-new movies/series (first became playable recently) —
 *   the default for the Recently Added carousel.
 */
export const recentNewnessSchema = z.enum(['everything', 'seasons', 'titles']);

export type RecentNewness = z.infer<typeof recentNewnessSchema>;

/**
 * Query params for /api/browse/recent endpoint.
 *
 * Supports a media-type filter, a library-group filter, a 3-way newness mode,
 * and a title search.
 */
export const recentQuerySchema = z
    .object({
        type: browseMediaTypeSchema.default('all'),
        libraryGroupId: z.string().guid().optional(),
        new: recentNewnessSchema.default('titles'),
        q: z.string().trim().max(100).optional(),
    })
    .strict();

export type RecentQuery = z.infer<typeof recentQuerySchema>;

// ============================================================================
// Browse A-Z Endpoint
// ============================================================================

/**
 * Media type filter for the A-Z browse endpoint.
 *
 * Accepted input (query string):
 *   Canonical:  'movie' | 'series' | 'all'
 *   Deprecated: 'movies' (→ 'movie'), 'tv' (→ 'series')
 *
 * Output is always the canonical singular value.
 */
export const azMediaTypeSchema = z.preprocess(
    (val) => {
        if (val === 'movies') return 'movie';
        if (val === 'tv') return 'series';
        return val;
    },
    z.enum(['movie', 'series', 'all']),
);

export type AZMediaType = z.infer<typeof azMediaTypeSchema>;

/**
 * Sort order for the A-Z browse endpoint.
 *
 * 'title_asc'/'title_desc' drive the letter-jump rail (bucket counts are
 * fetched); the other sorts hide the rail (bucket counts are skipped).
 */
export const azSortSchema = z.enum([
    'title_asc',
    'title_desc',
    'added_desc',
    'year_desc',
    'year_asc',
    'rating_desc',
]);

export type AZSort = z.infer<typeof azSortSchema>;

/**
 * Query params for /api/browse/az endpoint
 *
 * Supports alphabetical browsing with letter filter, media type filter,
 * library filter, sort order, audio/subtitle language filter, quality
 * filter (resolution/HDR/codec), and pagination for infinite scroll.
 */
export const azQuerySchema = z.strictObject({
    type: azMediaTypeSchema.default('all'),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    sort: azSortSchema.default('title_asc'),
    letter: z
        .string()
        .length(1)
        // A-Z, or '#' for the bucket of titles that don't start with a Latin
        // letter (digits, Hangul/CJK) — keeps non-Latin series reachable.
        .regex(/^[A-Za-z#]$/, 'Must be a single letter A-Z or #')
        .optional(),
    q: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe(
            'Free-text narrowing over the title columns — "search within this slice". ' +
                'Composes with every other filter and sort here, which is the point: a ' +
                'viewer narrowed to Documentaries/4K who then types a title searches THAT ' +
                'slice. Substring, accent-insensitive, so "sig" matches "Signal" and ' +
                '"etoile" matches "Étoile Harbor"; original and English titles are matched too. ' +
                'OVERRIDES `letter` — the A-Z rail is hidden while searching, so a letter ' +
                'left in the filter bar is not an intentional narrowing. `letterCounts`, ' +
                '`genreCounts` and `keywordCounts` are all computed under the query, so ' +
                'the rails never disagree with the grid. Not to be confused with ' +
                "`qUnknown`, which is the quality filter's include-unknown flag.",
        ),
    libraryGroupId: z.string().guid().optional(),
    genre: z
        .string()
        .trim()
        .max(100)
        .optional()
        .describe(
            'Restrict to a single genre by exact name (e.g. "Science Fiction"). ' +
                'Composes with every other filter and sort on this endpoint. Use the ' +
                'names returned by GET /browse/genres (or `genreCounts` on this response) — ' +
                'an unknown name is not an error, it simply matches nothing. A ' +
                'whitespace-only value degrades to "no filter" rather than an error.',
        ),
    tag: z
        .string()
        .trim()
        .max(100)
        .optional()
        .describe(
            'Restrict to a single keyword/tag (e.g. "whodunit", "time travel"). ' +
                'Use a value returned by GET /browse/tags (or `keywordCounts` on this ' +
                'response) — an unknown value simply matches nothing. Matched ' +
                'case-insensitively. Composes with `genre` and every other filter. A ' +
                'whitespace-only value degrades to "no filter" rather than an error.',
        ),
    audio: z
        .string()
        .optional()
        .transform((v) => parseLangCsv(v, AUDIO_FILTER_LANGUAGES)),
    subs: z
        .string()
        .optional()
        .transform((v) => parseLangCsv(v, SUBTITLE_FILTER_LANGUAGES)),
    includeUnknown: z
        .union([z.boolean(), z.literal('true'), z.literal('false')])
        .optional()
        .transform((v) => v === true || v === 'true'),
    res: z
        .string()
        .optional()
        .transform((v) => parseTierCsv(v, RESOLUTION_TIERS)),
    hdr: z
        .string()
        .optional()
        .transform((v) => parseTierCsv(v, HDR_TIERS)),
    codec: z
        .string()
        .optional()
        .transform((v) => parseTierCsv(v, CODEC_TIERS)),
    qUnknown: z
        .union([z.boolean(), z.literal('true'), z.literal('false')])
        .optional()
        .transform((v) => v === true || v === 'true'),
});

export type AZQuery = z.infer<typeof azQuerySchema>;

/**
 * Query params for GET /api/browse/genres — the genre facet for A-Z browse.
 *
 * Deliberately the A-Z filter surface minus the paging/ordering/narrowing knobs:
 * the counts describe the same scope `/browse/az` would return, so a client can
 * build a genre rail that matches the grid it will navigate to. Derived from
 * `azQuerySchema` so the two can never drift apart (`genre` is omitted — a facet
 * must not narrow over its own axis; `letter` is omitted because the rail is a
 * top-level destination picker, not a sub-filter of the current letter).
 */
export const browseGenresQuerySchema = azQuerySchema.omit({
    offset: true,
    limit: true,
    sort: true,
    letter: true,
    genre: true,
});

export type BrowseGenresQuery = z.infer<typeof browseGenresQuerySchema>;

/**
 * Query params for GET /api/browse/tags — the keyword facet for A-Z browse.
 *
 * Derived from `azQuerySchema` so the two can never drift (`tag` is omitted — a
 * facet must not narrow over its own axis), plus `q` for prefix typeahead.
 */
export const tagsQuerySchema = azQuerySchema
    .omit({ tag: true, offset: true, limit: true, sort: true })
    .extend({
        q: z
            .string()
            .trim()
            .max(100)
            .optional()
            .describe('Prefix filter for typeahead; lowercased server-side. Omit for top tags.'),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(100)
            .default(20)
            .describe('Maximum tags to return, count-descending.'),
    });

export type TagsQuery = z.infer<typeof tagsQuerySchema>;

/**
 * Query params for GET /api/browse/genre/{name}. Library-local genre listing
 * with media-type filter + offset pagination. `type` accepts movie|series|all
 * (legacy movies/tv coerced) and defaults to `all`.
 */
export const genreBrowseQuerySchema = z.object({
    type: azMediaTypeSchema.default('all'),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
        .string()
        .optional()
        .describe(
            'Opaque keyset cursor, returned as nextCursor on a previous response. ' +
                'When present, offset is ignored and the response omits totalCount/nextOffset/currentOffset.',
        ),
});

export type GenreBrowseQuery = z.infer<typeof genreBrowseQuerySchema>;

// ============================================================================
// Browse Keywords Endpoint
// ============================================================================

/**
 * Media type filter for the keywords browse endpoint.
 *
 * Accepted input (query string):
 *   Canonical:  'movie' | 'series' | 'all'
 *   Deprecated: 'movies' (→ 'movie'), 'tv' (→ 'series')
 *
 * Output is always the canonical singular value.
 */
export const keywordsMediaTypeSchema = z.preprocess(
    (val) => {
        if (val === 'movies') return 'movie';
        if (val === 'tv') return 'series';
        return val;
    },
    z.enum(['movie', 'series', 'all']),
);

export type KeywordsMediaType = z.infer<typeof keywordsMediaTypeSchema>;

/**
 * Query params for /api/browse/keywords endpoint
 *
 * Supports keyword-based browsing with media type filter and pagination.
 */
export const keywordsQuerySchema = z.object({
    type: keywordsMediaTypeSchema.default('all'),
    limit: z.coerce.number().int().min(1).max(20).default(5),
    offset: z.coerce.number().int().min(0).default(0),
});

export type KeywordsQuery = z.infer<typeof keywordsQuerySchema>;

// ============================================================================
// Search Endpoints
// ============================================================================

/**
 * Media types for search filter
 */
export const searchMediaTypeSchema = z.enum([
    'movie',
    'tv',
    'episode',
    'season',
    'audiobook',
    'anfragen',
    'tvchannel',
    'book',
    'manga',
    'comic',
    'home_video',
    'training',
    'educational',
    'personal',
    'music',
    'audio',
    // Music sub-types — /api/search emits these for music rows; the
    // schema was missing them so any consumer parsing search results
    // through this enum would throw on music. (Audit C, D2.)
    'track',
    'album',
    'artist',
    // Request integrations also surface as search-result rows
    'sonarr',
    'radarr',
    'podcast',
]);

export type SearchMediaType = z.infer<typeof searchMediaTypeSchema>;

/**
 * Query params for search endpoint
 *
 * Supports:
 * - Basic search with query string
 * - Type filtering (comma-separated list)
 * - Fulltext search (includes descriptions)
 * - Search operators (year range, rating min, genres, exclude terms)
 */
export const searchQuerySchema = z.object({
    // Basic search
    q: z.string().min(1).max(200).optional().meta({ description: 'Search terms.' }),

    // Pagination
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .meta({ description: 'Page size (1–100).' }),
    offset: z.coerce
        .number()
        .int()
        .min(0)
        .default(0)
        .meta({ description: 'Number of results to skip.' }),

    // Type filtering (comma-separated list)
    //
    // This shipped undocumented, which made the endpoint look like it was
    // leaking: search is deliberately cross-entity, so an unfiltered query
    // returns music/book/channel rows alongside video, and a client with no
    // way to discover this parameter can only read that as a bug.
    types: optionalStringSchema.meta({
        description:
            'Comma-separated result-type filter. Omit to search EVERY entity — search is ' +
            'cross-entity by design, so an unfiltered query returns `track`/`album`/`artist`, ' +
            '`book`/`manga`/`comic`, `audiobook`, `tvchannel` and `request` rows alongside ' +
            'video. Video-only clients should pass `types=movie,series,episode`. ' +
            '`track`, `album` and `artist` are honoured individually (`music` = all three), ' +
            'so a client can page through one music section. ' +
            'Accepted: movie, series (alias of the internal tv), episode, track, album, ' +
            'artist, music, book, manga, comic, audiobook, tvchannel, request, home_video, ' +
            'training, educational, personal.',
    }),

    // Fulltext search toggle
    fulltext: coerceBooleanSchema
        .optional()
        .meta({ description: 'Also match overviews/descriptions, not just titles.' }),

    // Search operators (advanced filtering)
    yearMin: z.coerce
        .number()
        .int()
        .min(1900)
        .max(2100)
        .optional()
        .meta({ description: 'Earliest release year, inclusive.' }),
    yearMax: z.coerce
        .number()
        .int()
        .min(1900)
        .max(2100)
        .optional()
        .meta({ description: 'Latest release year, inclusive.' }),
    ratingMin: z.coerce
        .number()
        .min(0)
        .max(10)
        .optional()
        .meta({ description: 'Minimum rating (0–10).' }),
    genres: optionalStringSchema.meta({ description: 'Comma-separated genre names.' }),
    exclude: optionalStringSchema.meta({
        description: 'Comma-separated terms to exclude from results.',
    }),
    availableOnly: coerceBooleanSchema.optional().meta({
        description:
            'Only return titles that can be played: drops catalog-only movies, series, ' +
            'episodes and audiobooks (`isAvailable: false`) and request rows. Can only narrow ' +
            'what the server shows, never widen it: installs that already hide unavailable ' +
            'titles return the same results either way.',
    }),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * Query params for the typeahead suggest endpoint (`GET /api/v1/search/suggest`).
 *
 * Deliberately minimal: a query string, a small limit (max 20 — a suggestion
 * list, not a results page), and an optional canonical-type filter (CSV of
 * public discriminators). Single source of truth shared by the def and its
 * colocated `_openapi.ts`.
 */
export const searchSuggestQuerySchema = z.object({
    q: z.string().max(200).optional().default(''),
    limit: z.coerce.number().int().min(1).max(20).optional().default(8),
    types: z.string().optional(),
    availableOnly: coerceBooleanSchema.optional().meta({
        description:
            'Only suggest titles that can be played. Can only narrow what the server shows, ' +
            'never widen it.',
    }),
});

export type SearchSuggestQuery = z.infer<typeof searchSuggestQuerySchema>;

/**
 * Parsed search query with processed arrays
 */
export interface ParsedSearchQuery {
    q?: string;
    limit: number;
    offset: number;
    types?: string[];
    fulltext?: boolean;
    yearMin?: number;
    yearMax?: number;
    ratingMin?: number;
    genres?: string[];
    excludeTerms?: string[];
    availableOnly?: boolean;
}

/**
 * Helper to parse search query into structured format
 */
export function parseSearchQuery(query: SearchQuery): ParsedSearchQuery {
    return {
        q: query.q,
        limit: query.limit,
        offset: query.offset,
        types: query.types?.split(',').map((t) => {
            const normalized = t.trim().toLowerCase();
            // PUBLIC → INTERNAL boundary conversion, NOT a legacy client shim.
            // The comment here used to read "tvOS/external clients use 'SERIES'",
            // which made it look like compat cruft that could be deleted once
            // clients went canonical. It cannot: `series` IS the canonical public
            // token (and the one the OpenAPI `types` description tells clients to
            // send), while the source toggle in defs/search/search.ts tests
            // `allowedTypes.includes('tv')` — the internal/DB vocabulary. Drop
            // this map and `?types=series` silently switches the series source
            // OFF and returns 200 with no series at all.
            return normalized === 'series' ? 'tv' : normalized;
        }),
        fulltext: query.fulltext,
        yearMin: query.yearMin,
        yearMax: query.yearMax,
        ratingMin: query.ratingMin,
        genres: query.genres?.split(',').map((g) => g.trim().toLowerCase()),
        excludeTerms: query.exclude?.split(',').map((t) => t.trim().toLowerCase()),
        availableOnly: query.availableOnly,
    };
}

// ============================================================================
// Episode Search Pattern
// ============================================================================

/**
 * Episode search info returned when an episode pattern is detected
 */
export const episodeSearchInfoSchema = z.object({
    patternDetected: z.boolean(),
    requestedSeason: z.number().int().min(1),
    requestedEpisode: z.number().int().min(1),
    seriesFound: z.boolean(),
    seriesName: z.string().optional(),
    seriesInternalId: z.string().optional(),
    seriesTmdbId: z.number().optional(),
    availableSeasons: z.array(z.number().int()).optional(),
    seasonAvailable: z.boolean(),
});

export type EpisodeSearchInfo = z.infer<typeof episodeSearchInfoSchema>;
