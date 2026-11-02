// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Content API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for content/media API response types.
 * These schemas define the contract for /api/search, /api/media/*, /api/movie/*,
 * /api/series/*, /api/calendar, /api/upcoming, /api/request/*, /api/lists/* endpoints.
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

import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import { z } from 'zod';
import { MediaPreviewSchema } from './api-media-preview.js';
import { boundedListEnvelope } from './pagination.js';
import { publicAuthorSchema } from './public-author.js';
import { PlaybackProgressSchema } from './playback-progress.js';
import { ExternalIdsResponseSchema } from './api-responses';

// Re-export MediaDetail types for convenience
export {
    MediaDetailSchema,
    type MediaDetail,
    type MovieDetail,
    type TvDetail,
    MediaNodeSchema,
    type MediaNode,
} from './media-detail';

// ============================================================================
// V1 Search Item (/api/search -- new {items,page} contract)
// ============================================================================

const ImageRoleSchema = z.object({
    href: z.string(),
    thumb: z.string().optional(),
    card: z.string().optional(),
    full: z.string().optional(),
    wide: z.string().optional(),
});

const SearchImagesSchema = z.object({
    poster: ImageRoleSchema.optional(),
    backdrop: ImageRoleSchema.optional(),
});

export const V1SearchResultItemSchema = z
    .object({
        progress: PlaybackProgressSchema.optional().describe(
            'Audiobook listening progress when known',
        ),
        id: z.string(),
        // Search is CROSS-ENTITY: the `type` union is a superset of the catalog
        // MediaType. Catalog/music keep canonical types (movie|series|episode|
        // track|album|artist); the auxiliary search sources the legacy fan-out
        // covered add book|manga|comic|audiobook|request|tvchannel and the
        // non-entertainment library types. (Server union: SearchResultType in
        // defs/search/search.ts — keep these two in sync.)
        type: z.enum([
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
        ]),
        ids: z.record(z.string(), z.string()),
        title: z.string(),
        matchedTitle: z
            .string()
            .optional()
            .describe('Stored alternative title explaining a search match'),
        year: z.number().optional(),
        overview: z.string().optional(),
        images: SearchImagesSchema,
        score: z.number().optional().describe('Relevance score (higher is better)'),
        reason: z
            .object({ kind: z.string() })
            .optional()
            .describe('Why the item matched; kind is title, overview, keyword, ...'),
        // Music-track extras (structured, so track pickers can distinguish
        // duplicate copies of the same song across albums/releases — the
        // `overview` "Artist · Album" string is display-only):
        album: z.string().optional().describe('Music tracks: parent album title'),
        durationMs: z.number().int().optional().describe('Music tracks: duration in milliseconds'),
        artistId: z.string().optional().describe('Music rows: performing artist UUID'),
        albumId: z.string().optional().describe('Music tracks: parent album UUID'),
        artists: z
            .array(
                z.object({
                    id: z.string().optional(),
                    title: z.string(),
                }),
            )
            .optional()
            .describe('Structured track artists (tag order) for title/credit linkification'),
        remixerArtists: z
            .array(z.object({ id: z.string().optional(), title: z.string() }))
            .optional()
            .describe('Resolved remix/version credits, separate from performing artists.'),
        // Auxiliary-source extras (carried for the UI open-handlers):
        //  - request rows: the underlying request media type (movie|tv)
        //  - Kavita rows: the library id used to build the external deep link
        requestMediaType: z.string().optional(),
        libraryId: z.number().optional(),
        author: z
            .string()
            .optional()
            .describe('Book rows: author display name (from Kavita series metadata)'),
    })
    .meta({ id: 'V1SearchResultItem', description: 'Single v1 search result item' });

export type V1SearchResultItem = z.infer<typeof V1SearchResultItemSchema>;

// ============================================================================
// Search Response (/api/search)
// ============================================================================

/**
 * Search response -- v1 {items, page} envelope
 */
export const SearchResponseSchema = z
    .object({
        items: z.array(V1SearchResultItemSchema).describe('Search result items'),
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .describe('Pagination info'),
    })
    .meta({ id: 'SearchResponse', description: 'Search response' });

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * Available categories response -- bare flat object (no success wrapper)
 */
export const AvailableCategoriesResponseSchema = z
    .object({
        book: z.boolean().describe('Books available (Kavita)'),
        manga: z.boolean().describe('Manga available (Kavita)'),
        comic: z.boolean().describe('Comics available (Kavita)'),
        audiobook: z.boolean().describe('Audiobooks available (Audiobookshelf)'),
        anfragen: z.boolean().describe('Requests available (Jellyseerr)'),
        tvchannel: z.boolean().describe('TV channels available (Jellyfin)'),
        music: z.boolean().optional().describe('Music available'),
        home_video: z.boolean().optional().describe('Home video available'),
        training: z.boolean().optional().describe('Training content available'),
        educational: z.boolean().optional().describe('Educational content available'),
        personal: z.boolean().optional().describe('Personal content available'),
    })
    .meta({
        id: 'AvailableCategoriesResponse',
        description: 'Available categories response',
    });

export type AvailableCategoriesResponse = z.infer<typeof AvailableCategoriesResponseSchema>;

// ============================================================================
// Media Details Response (/api/media/[id], /api/media-details)
// Now returns flat MediaDetail (discriminated union of MovieDetail | TvDetail)
// ============================================================================

// Legacy re-exports (still used by some consumers)
export { MediaDetailsSchema, type MediaDetails } from './api-media-responses';
export { TmdbMediaDataSchema, type TmdbMediaData } from './api-media-responses';

// ============================================================================
// Similar Media Response (/api/media/[id]/similar)
// ============================================================================

/** Similar media response: bounded top-N results, without pagination. */
export const SimilarMediaResponseSchema = boundedListEnvelope(MediaPreviewSchema).meta({
    id: 'SimilarMediaResponse',
    description: 'Similar media response',
});

export type SimilarMediaResponse = z.infer<typeof SimilarMediaResponseSchema>;

// ============================================================================
// Series Responses - Re-exports from api-series-responses
// ============================================================================

export {
    SeasonsCollectionResponseSchema,
    type SeasonsCollectionResponse,
} from './api-series-responses';
export {
    EpisodesCollectionResponseSchema,
    type EpisodesCollectionResponse,
} from './api-series-responses';
export { NextEpisodeResponseSchema, type NextEpisodeResponse } from './api-series-responses';
export { SeriesInfoResponseSchema, type SeriesInfoResponse } from './api-series-responses';

// ============================================================================
// Movie Details Response (/api/movie-details/[id])
// ============================================================================

/**
 * Movie details response (/api/movie-details/[id]) — new contract.
 * Bare object with self-describing images{} map (no posterUrl/backdropUrl).
 */
export const MovieDetailsResponseSchema = z
    .object({
        /** Item internal UUID */
        id: z.string().describe('Item internal UUID'),
        /**
         * Canonical media type (never 'tv').
         *
         * Carries `'audiobook'` too — the route resolves any catalog id, and an
         * AudiobookShelf book clamped to `'movie'` here reached the modal as a
         * movie. MUST stay in sync with `MovieDetailsResponseSchema` in
         * `$lib/server/api/defs/catalog/movie-details.ts` (the producer).
         */
        type: z.enum(['movie', 'series', 'audiobook']).describe('Media type'),
        /** Open external ID map */
        ids: z.record(z.string(), z.string()).describe('External IDs'),
        /** Title */
        title: z.string().describe('Title'),
        /** Overview */
        overview: z.string().optional().describe('Overview'),
        /** Release year */
        year: z.number().int().optional().describe('Year'),
        /** Premiere date (ISO 8601) */
        releaseDate: z.string().optional().describe('Release date'),
        /** Runtime in minutes */
        runtimeMinutes: z.number().int().optional().describe('Runtime minutes'),
        /** Genres */
        genres: z.array(z.string()).describe('Genres'),
        /** Self-describing image href map */
        images: ImageSetSchema,
        /** Whether a file exists in the library */
        isAvailable: z.boolean().describe('Available in library'),
        /** Can be requested */
        canRequest: z.boolean().describe('Can be requested'),
        /** Playback is possible now */
        playbackAvailable: z.boolean().describe('Playback available'),
        /** User-specific fields */
        user: z
            .object({
                rating: z.number().int().optional().describe('User rating'),
                isInWatchlist: z.boolean().describe('In watchlist'),
            })
            .optional()
            .describe('User-specific data'),
    })
    .meta({
        id: 'MovieDetailsResponse',
        description: 'Movie details response (new contract, no success wrapper)',
    });

export type MovieDetailsResponse = z.infer<typeof MovieDetailsResponseSchema>;

// ============================================================================
// Movie Search Response (/api/movie/search)
// Server IS migrated — returns { id, type: 'movie', ids, images{}, ... }
// ============================================================================

const MovieSearchImageRoleSchema = z.object({
    href: z.string(),
    thumb: z.string().optional(),
    card: z.string().optional(),
    wide: z.string().optional(),
    full: z.string().optional(),
});

/**
 * Movie search contract — new shape (migrated).
 * Server returns bare object: { id, type: 'movie', ids, title, year?, overview?,
 * genres?, images?, isAvailable, canRequest, playbackAvailable }
 * No legacy `mediaType`, `externalIds`, `posterUrl`, or `backdropUrl` fields.
 */
export const MovieSearchContractSchema = z
    .object({
        /** Internal UUID or best available ID */
        id: z.string().describe('Internal UUID or best available ID'),
        /** Canonical media type — always 'movie' from this endpoint */
        type: z.literal('movie').describe('Canonical media type'),
        /** Open external ID map (internal, tmdb, …) */
        ids: z.record(z.string(), z.string()).describe('External ID map'),
        /** Display title */
        title: z.string().describe('Title'),
        /** Overview */
        overview: z.string().optional().describe('Overview'),
        /** Release year */
        year: z.number().int().optional().describe('Release year'),
        /** Genre names */
        genres: z.array(z.string()).optional().describe('Genres'),
        /** Self-describing image href map (absent when item has no internal UUID) */
        images: z
            .object({
                poster: MovieSearchImageRoleSchema.optional(),
                backdrop: MovieSearchImageRoleSchema.optional(),
            })
            .optional()
            .describe('Image map'),
        /** Whether a file exists in the library */
        isAvailable: z.boolean().describe('Available in library'),
        /** Can be requested */
        canRequest: z.boolean().describe('Can be requested'),
        /** Playback is possible now */
        playbackAvailable: z.boolean().describe('Playback available'),
    })
    .meta({
        id: 'MovieSearchContract',
        description: 'Movie search response (new contract: bare object with type+ids+images)',
    });

export type MovieSearchContract = z.infer<typeof MovieSearchContractSchema>;

/** Alias kept for the lib/api/content.ts import name. */
export const MovieSearchResponseSchema = MovieSearchContractSchema;
export type MovieSearchResponse = MovieSearchContract;

// ============================================================================
// Series Search Response (/api/series/search)
// Server IS migrated — returns { id, type: 'series', ids, images }
// ============================================================================

/**
 * Series search response — new contract.
 * Server returns bare object: { id, type: 'series', ids, title, year?, overview?, images? }
 */
export const SeriesSearchResponseSchema = z
    .object({
        id: z.string().describe('Internal series UUID'),
        type: z.literal('series').describe('Canonical media type'),
        ids: z.record(z.string(), z.string()).describe('External ID map'),
        title: z.string().describe('Series title'),
        year: z.number().int().optional().describe('Release year'),
        overview: z.string().optional().describe('Series overview'),
        images: ImageSetSchema,
    })
    .meta({
        id: 'SeriesSearchResponse',
        description: 'Series search response (new contract: bare object with type+ids+images)',
    });

export type SeriesSearchResponse = z.infer<typeof SeriesSearchResponseSchema>;

// ============================================================================
// Episode Response (/api/episode)
// ============================================================================

/**
 * Episode search response (/api/episode) — new contract.
 * Returns internal UUID (null if not found) and optionally the series internal UUID.
 */
export const EpisodeResponseSchema = z
    .object({
        /** Internal episode UUID (null if not found) */
        episodeId: z.string().nullable().describe('Internal episode UUID'),
        /**
         * Internal series UUID resolved alongside the episode. When the episode
         * is found via name-based lookup, this is the *correct* series for the
         * matched episode — used to disambiguate same-title series.
         */
        seriesInternalId: z.string().guid().optional().describe('Internal series UUID'),
    })
    .meta({ id: 'EpisodeResponse', description: 'Episode search response (new contract)' });

export type EpisodeResponse = z.infer<typeof EpisodeResponseSchema>;

// ============================================================================
// Calendar Response (/api/calendar)
// ============================================================================

/**
 * Calendar entry
 */
export const CalendarEntrySchema = z
    .object({
        /** Episode ID */
        id: z.string().describe('Episode ID'),
        /** Episode title */
        title: z.string().describe('Title'),
        /** Series name */
        seriesName: z.string().describe('Series name'),
        /** Season number */
        seasonNumber: z.number().describe('Season number'),
        /** Episode number */
        episodeNumber: z.number().describe('Episode number'),
        /** Air date (ISO 8601) */
        airDate: z.string().describe('Air date'),
        /** Overview */
        overview: z.string().optional().describe('Overview'),
        /** Whether episode has aired */
        hasAired: z.boolean().describe('Has aired'),
        /** Whether episode is available locally */
        isAvailable: z.boolean().describe('Is available'),
        /** Series external IDs */
        seriesExternalIds: ExternalIdsResponseSchema.optional().describe('Series external IDs'),
        /** Poster URL */
        posterUrl: z.string().optional().describe('Poster URL'),
    })
    .meta({ id: 'CalendarEntry', description: 'Calendar entry' });

export type CalendarEntry = z.infer<typeof CalendarEntrySchema>;

/**
 * Calendar item — matches the typed CalendarItem shape emitted by the
 * `calendar.ts` def. That def is DB-backed (media_items), NOT
 * transformSonarrToMediaItem: the sonarr-prefixed names are legacy only.
 *
 * This schema is what `apiGet('/api/calendar', ...)` validates against, and a
 * `z.object` STRIPS undeclared keys — so a field missing here never reaches the
 * component no matter what the server emits.
 */
export const CalendarItemSchema = z
    .object({
        /** Internal UUID when available, otherwise null. */
        id: z.string().nullable().optional(),
        /** Display title. */
        title: z.string(),
        /** 'series' for TV episodes, 'movie' for Radarr items. */
        mediaType: z.string().optional(),
        /** Series name (TV only). */
        seriesName: z.string().optional(),
        /** Season number (TV only). */
        seasonNumber: z.number().int().optional(),
        /** Episode number (TV only). */
        episodeNumber: z.number().int().optional(),
        /** Air/release date as ISO string. */
        sonarrAirDate: z.string().optional(),
        /** Whether the file has been downloaded. */
        sonarrHasFile: z.boolean().optional(),
        /** Parent series' `media_items` UUID (TV only). */
        seriesMediaId: z.string().optional(),
        /**
         * @deprecated Alias of `seriesMediaId` — the SAME `media_items` UUID
         * string, despite the name. Never a Sonarr id; that is `sourceSeriesId`.
         */
        sonarrSeriesId: z.string().optional(),
        /** Episode overview text. */
        overview: z.string().optional(),
        /** Release year. */
        year: z.number().int().optional(),
        /**
         * Provenance: 'catalog' = in the library/catalog (has a UUID);
         * 'monitored' = tracked in Sonarr/Radarr but not yet in the library
         * (rendered "Not on server", no playback). Defaults to 'catalog'.
         */
        source: z.enum(['catalog', 'monitored']).optional(),
        /** True only when the item is in the library with a downloaded file. */
        onServer: z.boolean().optional(),
        /** Sonarr numeric series id — artwork fallback for monitored episodes. */
        sourceSeriesId: z.number().int().optional(),
        /** TMDB id — artwork fallback for monitored items. */
        tmdbId: z.number().int().optional(),
    })
    .meta({ id: 'CalendarItem', description: 'Calendar item from Sonarr/Radarr' });

export type CalendarItem = z.infer<typeof CalendarItemSchema>;

/**
 * Calendar response — server returns { items, page } collection envelope.
 * Each item is a CalendarItem (typed, no z.unknown()).
 */
export const CalendarResponseSchema = z
    .object({
        items: z.array(CalendarItemSchema).describe('Calendar items'),
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .describe('Pagination info'),
    })
    .meta({ id: 'CalendarResponse', description: 'Calendar response ({items,page} envelope)' });

export type CalendarResponse = z.infer<typeof CalendarResponseSchema>;

// ============================================================================
// Upcoming Response (/api/upcoming)
// ============================================================================

/**
 * Media preview embedded inside an upcoming/recommendation item.
 * Matches the RecommendedMediaRef shape emitted by recommender.ts.
 */
const UpcomingMediaRefSchema = z.object({
    /** Internal UUID (stable, canonical). May be a composite fallback string. */
    id: z.string(),
    /** Canonical media type: 'movie' | 'series' | 'episode'. */
    type: z.string(),
    /** Display title. */
    title: z.string(),
    /** Release year. */
    year: z.number().int().nullable().optional(),
    /** Provider ID map. */
    ids: z.record(z.string(), z.string()),
    /** Self-describing image hrefs. */
    images: z
        .record(
            z.string(),
            z.object({
                href: z.string(),
                width: z.number().int().optional(),
                height: z.number().int().optional(),
            }),
        )
        .optional(),
});

/**
 * Reason block emitted alongside each recommendation item.
 */
const UpcomingReasonSchema = z.object({
    kind: z.string(),
    seed: z.string().optional(),
    label: z.string().optional(),
    airDate: z.string().optional(),
    episodeTitle: z.string().optional(),
    overview: z.string().optional(),
});

/**
 * One item in the upcoming/recommendation response.
 * Matches the RecommendationItem shape emitted by recommender.ts.
 */
export const UpcomingItemSchema = z
    .object({
        media: UpcomingMediaRefSchema,
        score: z.number().min(0).max(1).optional(),
        reason: UpcomingReasonSchema.optional(),
    })
    .meta({ id: 'UpcomingItem', description: 'Upcoming/recommendation item (new contract)' });

export type UpcomingItem = z.infer<typeof UpcomingItemSchema>;

/**
 * Upcoming response — server returns { items, page } collection envelope.
 * Items are RecommendationItem shapes (media preview + optional reason).
 */
export const UpcomingResponseSchema = z
    .object({
        items: z.array(UpcomingItemSchema).describe('Upcoming items'),
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .describe('Pagination info'),
    })
    .meta({ id: 'UpcomingResponse', description: 'Upcoming response ({items,page} envelope)' });

export type UpcomingResponse = z.infer<typeof UpcomingResponseSchema>;

/**
 * Excluded series item (matches server transformed shape)
 */
export const ExcludedSeriesItemSchema = z
    .object({
        /** Row ID */
        id: z.string().describe('Row ID'),
        /** Username */
        username: z.string().describe('Username'),
        /** Display name: catalog title, else a title the arr projection knows, else `TMDB <id>` */
        seriesName: z.string().describe('Display name'),
        /** How the mute is keyed: catalog id, TMDB TV id, TMDB movie id, or exact name */
        kind: z.enum(['series', 'tmdb_tv', 'tmdb_movie']).describe('Mute key kind'),
        /** Media ID (internal UUID) of the catalog series or movie, when kind is series */
        mediaId: z.string().optional().describe('Media ID'),
        /** TMDB id, when kind is tmdb_tv or tmdb_movie */
        tmdbId: z.string().optional().describe('TMDB ID'),
        /** When excluded */
        excludedAt: z.string().describe('Excluded timestamp'),
    })
    .meta({ id: 'ExcludedSeriesItem', description: 'Excluded series item' });

export type ExcludedSeriesItem = z.infer<typeof ExcludedSeriesItemSchema>;

/**
 * Excluded series response -- v1 {items, page} envelope
 */
export const ExcludedSeriesResponseSchema = z
    .object({
        /** Excluded series items */
        items: z.array(ExcludedSeriesItemSchema).describe('Excluded series items'),
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .describe('Pagination info'),
    })
    .meta({
        id: 'ExcludedSeriesResponse',
        description: 'Excluded series response',
    });

export type ExcludedSeriesResponse = z.infer<typeof ExcludedSeriesResponseSchema>;

/**
 * Exclude series mutation response
 */
export const ExcludeSeriesMutationResponseSchema = z
    .object({
        /** Message */
        message: z.string().describe('Message'),
        /** Series name (empty when removed by id) */
        seriesName: z.string().describe('Series name'),
        /** Row ID of the exclusion that was added */
        id: z.string().optional().describe('Row ID'),
    })
    .meta({
        id: 'ExcludeSeriesMutationResponse',
        description: 'Exclude series mutation response',
    });

export type ExcludeSeriesMutationResponse = z.infer<typeof ExcludeSeriesMutationResponseSchema>;

// ============================================================================
// Watched Items Response (/api/watched)
// ============================================================================

/**
 * Watched items response
 * Server returns WatchedItemsDataSchema from watched-types.ts:
 * { watchedItems: Array<{ externalIds, mediaType }>, cached? }
 * Re-export from watched-types for consistency.
 */
export {
    WatchedItemsDataSchema as WatchedItemsResponseSchema,
    type WatchedItemsData as WatchedItemsResponse,
    WatchedItemResponseSchema as WatchedItemSchema,
    type WatchedItemResponse as WatchedItem,
} from './watched-types';

// ============================================================================
// Request Responses (/api/request/*)
// ============================================================================

/**
 * Submit request response — bare object (no success wrapper).
 * Server returns: { requestId, message, requestedAt }
 */
export const SubmitRequestResponseSchema = z
    .object({
        /** Request ID assigned by Jellyseerr */
        id: z.number().int().describe('Request ID'),
        /** Server timestamp for notification tracking (ISO 8601) */
        requestedAt: z.string().describe('Server timestamp'),
    })
    .meta({
        id: 'SubmitRequestResponse',
        description: 'Submit request response (bare object, no success wrapper)',
    });

export type SubmitRequestResponse = z.infer<typeof SubmitRequestResponseSchema>;

/**
 * Request quota response
 */
export const RequestQuotaResponseSchema = z
    .object({
        /** Quota details (null when service unavailable/user missing) */
        quota: z
            .object({
                movie: z.object({
                    limit: z.number().int(),
                    used: z.number(),
                    remaining: z.number().nullable(),
                    days: z.number(),
                    restricted: z.boolean(),
                }),
                tv: z.object({
                    limit: z.number().int(),
                    used: z.number(),
                    remaining: z.number().nullable(),
                    days: z.number(),
                    restricted: z.boolean(),
                }),
            })
            .nullable()
            .describe('Quota details'),
        /** Optional status message */
        message: z.string().optional().describe('Message'),
        /**
         * Whether the current user has a linked Jellyseerr account.
         * `false` => reachable but no matching account ("not linked" — clients
         * may show a distinct, non-error hint). Omitted when linked or when the
         * service is unavailable (transient — treat as a fail-soft empty result).
         */
        linked: z.boolean().optional().describe('Jellyseerr account link state'),
    })
    .meta({
        id: 'RequestQuotaResponse',
        description: 'Request quota response',
    });

export type RequestQuotaResponse = z.infer<typeof RequestQuotaResponseSchema>;

/**
 * Pending request item (matches server transform in /api/request/pending)
 */
export const PendingRequestItemSchema = z
    .object({
        /** Request ID */
        id: z.number().int().describe('Request ID'),
        /** External IDs */
        dismissalKey: z.string(),
        externalIds: ExternalIdsResponseSchema.describe('External IDs'),
        /** Media type discriminator (canonical: 'movie' | 'series'). */
        mediaType: z.enum(['movie', 'series']).describe('Media type'),
        /** Seasons covered by this request, retained when restoring on another device. */
        seasons: z.array(z.number().int().min(0)).optional(),
        /** Title */
        title: z.string().describe('Title'),
        /** Poster path (TMDB format) */
        posterPath: z.string().nullable().describe('Poster path'),
        /** Request status label */
        status: z.string().describe('Status'),
        /** Requested timestamp */
        requestedAt: z.string().describe('Requested timestamp'),
        /** Whether this is a 4K request */
        is4k: z.boolean().describe('Is 4K request'),
    })
    .meta({ id: 'PendingRequestItem', description: 'Pending request item' });

export type PendingRequestItem = z.infer<typeof PendingRequestItemSchema>;

/**
 * Server dismissal record (echoed from the dismissals table).
 */
export const ServerDismissalSchema = z
    .object({
        /** Dismissal row ID */
        key: z.string().describe('Dismissal ID'),
        /** ISO 8601 timestamp when the item was dismissed */
        dismissedAt: z.string().describe('Dismissed timestamp'),
    })
    .meta({ id: 'ServerDismissal', description: 'Server-side dismissal record' });

export type ServerDismissal = z.infer<typeof ServerDismissalSchema>;

/**
 * Pending requests response
 * Server returns: { requests, dismissals, count, warning? } (no success field)
 */
export const PendingRequestsResponseSchema = z
    .object({
        /** Pending requests */
        items: z.array(PendingRequestItemSchema).describe('Requests'),
        /** User dismissals (typed) */
        dismissals: z.array(ServerDismissalSchema).optional().describe('Dismissals'),
        page: z.object({
            limit: z.number().int(),
            offset: z.number().int(),
            hasMore: z.boolean(),
            total: z.number().int().optional(),
        }),
        /** Warning message if dismissals query failed */
        warning: z.string().optional().describe('Warning message'),
        /**
         * Jellyseerr account link state for the current user. `false` => the
         * service is reachable but the user has no linked account ("not linked").
         * Omitted when linked or when the service is unavailable (transient).
         */
        linked: z.boolean().optional().describe('Jellyseerr account link state'),
    })
    .meta({
        id: 'PendingRequestsResponse',
        description: 'Pending requests response',
    });

export type PendingRequestsResponse = z.infer<typeof PendingRequestsResponseSchema>;

/**
 * Request status check result
 */
export const RequestStatusResultSchema = z
    .object({
        /** External IDs */
        externalIds: ExternalIdsResponseSchema.describe('External IDs'),
        /** Media type (canonical: 'movie' | 'series'). */
        mediaType: z.enum(['movie', 'series']).describe('Media type'),
        /** Season number when querying specific seasons */
        seasonNumber: z.number().optional().describe('Season number'),
        /** Request status */
        status: z
            .enum([
                'pending',
                'searching',
                'queued',
                'paused',
                'downloading',
                'importing',
                'synching',
                'available',
                'unavailable',
                'monitored',
            ])
            .describe('Status'),
        /** Status message */
        statusMessage: z.string().optional().describe('Status message'),
        /**
         * Download progress.
         *
         * NOTE: the server-internal `state` (queued|paused|downloading|importing)
         * is intentionally NOT part of this public contract — it is collapsed
         * into the outer `status` server-side. Do NOT re-add it here.
         */
        download: z
            .object({
                percentage: z.number().describe('Progress percentage'),
                // Kept for wire compatibility with existing clients; no
                // source fills it any more.
                speed: z
                    .string()
                    .optional()
                    .describe('Deprecated: no longer populated, always absent'),
                timeLeft: z.string().optional().describe('Time left'),
                size: z.string().optional().describe('Total size'),
                sizeLeft: z.string().optional().describe('Remaining size'),
            })
            .optional()
            .describe('Progress of the request in the admin-connected library manager'),
        /** Whether the user has watched this content */
        watched: z.boolean().optional().describe('Watched'),
    })
    .meta({ id: 'RequestStatusResult', description: 'Request status result' });

export type RequestStatusResult = z.infer<typeof RequestStatusResultSchema>;

/**
 * Request status response
 */
export const RequestStatusResponseSchema = z.array(RequestStatusResultSchema).meta({
    id: 'RequestStatusResponse',
    description: 'Request status response',
});

export type RequestStatusResponse = z.infer<typeof RequestStatusResponseSchema>;

// ============================================================================
// Lists Responses (/api/lists/*)
// ============================================================================

/**
 * Curated list metadata item — matches toListItem() output from defs/lists/index.ts.
 * Fields are camelCase (server converts from snake_case DB columns).
 */
export const ListInfoSchema = z
    .object({
        /** List slug identifier */
        id: z.string().describe('List slug ID'),
        /** Display name */
        name: z.string().describe('List name'),
        /** Description */
        description: z.string().optional().describe('Description'),
        /** Source provider (mdblist, etc.) */
        source: z.string().optional().describe('Source provider'),
        /** Source list path */
        listPath: z.string().optional().describe('Source list path'),
        /** Number of items in list */
        itemCount: z.number().int().optional().describe('Item count'),
        /** Last sync timestamp (ISO 8601 or null) */
        lastSyncedAt: z.string().nullable().optional().describe('Last synced'),
    })
    .meta({ id: 'ListInfo', description: 'Curated list metadata item' });

export type ListInfo = z.infer<typeof ListInfoSchema>;

/**
 * Lists response — server returns { items, page, syncing?, cached? }.
 * Replaces the old { lists, syncing, cached } shape.
 */
export const ListsResponseSchema = z
    .object({
        /** Curated list metadata items */
        items: z.array(ListInfoSchema).describe('List metadata items'),
        /** Pagination block */
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .describe('Pagination info'),
        /** Whether a background sync is in progress */
        syncing: z.boolean().optional().describe('Background sync in progress'),
        /** Whether response was served from cache */
        cached: z.boolean().optional().describe('Served from cache'),
    })
    .meta({ id: 'ListsResponse', description: 'Lists response ({items,page} envelope)' });

export type ListsResponse = z.infer<typeof ListsResponseSchema>;

/**
 * Enriched list item — matches the enrichedItems shape built by defs/lists/[id].ts.
 * Server emits the canonical `type` discriminator ('series', never raw 'tv'/sonarr/
 * radarr) and a flat `posterUrl` (matching GET /media/{id}).
 */
export const ListItemSchema = z
    .object({
        /** Internal UUID (null when item is not in local library). */
        id: z.string().nullable().optional(),
        /** External ID map (internal + primary provider). */
        externalIds: z
            .object({
                internal: z.string().nullable().optional(),
            })
            .catchall(z.string())
            .optional(),
        /** Canonical media type discriminator ('movie' | 'series' | 'episode'). */
        type: z.enum(['movie', 'series', 'episode']),
        /** Display title. */
        title: z.string().optional(),
        /** Overview/description. */
        overview: z.string().optional(),
        /** Genre names or IDs. */
        genres: z.union([z.array(z.string()), z.array(z.number())]).optional(),
        /** Best available rating (0-10). */
        rating: z.number().optional(),
        /** Rating source. */
        ratingSource: z.string().optional(),
        /** Letterboxd average rating (0-5). */
        letterboxdRating: z.number().optional(),
        /** Letterboxd vote count. */
        letterboxdVotes: z.number().optional(),
        /** Rotten Tomatoes critic score (0-100). */
        rtCritic: z.number().optional(),
        /** Rotten Tomatoes audience score (0-100). */
        rtAudience: z.number().optional(),
        /** MDBList aggregated score. */
        mdblistScore: z.number().optional(),
        /** Trakt rating. */
        traktScore: z.number().optional(),
        /** Metacritic score (0-100). */
        metacriticScore: z.number().optional(),
        /** MyAnimeList score (0-10). */
        malScore: z.number().optional(),
        /** Whether item is trending. */
        trending: z.boolean().optional(),
        /** Trending source. */
        trendingSource: z.string().optional(),
        /** Rank position in list (1-indexed). */
        rank: z.number().optional(),
        /** Release year. */
        year: z.number().optional(),
        /** Whether available in library. */
        isAvailable: z.boolean(),
        /** Whether item can be requested. */
        canRequest: z.boolean(),
        /** Poster image proxy URL (flat — server uses getCatalogPosterUrl or /api/image proxy). */
        posterUrl: z.string().optional(),
    })
    .meta({ id: 'ListItem', description: 'Enriched curated list item' });

export type ListItem = z.infer<typeof ListItemSchema>;

/**
 * List items response — server returns bare { id, items, page, debug? }.
 * No success wrapper; collection uses the canonical { items, page } envelope.
 */
export const ListItemsResponseSchema = z
    .object({
        /** List slug identifier. */
        id: z.string().describe('List ID'),
        /** Enriched list items. */
        items: z.array(ListItemSchema).describe('List items'),
        /** Pagination block. */
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int(),
                hasMore: z.boolean(),
            })
            .describe('Pagination info'),
        /** Debug diagnostics (present when debug=true query param is set). */
        debug: z
            .object({
                originalCount: z.number(),
                afterDedup: z.number(),
                duplicatesRemoved: z.number(),
                duplicates: z.array(z.unknown()),
            })
            .optional()
            .describe('Debug info'),
    })
    .meta({
        id: 'ListItemsResponse',
        description: 'List items response (bare object, no success wrapper)',
    });

export type ListItemsResponse = z.infer<typeof ListItemsResponseSchema>;

// ============================================================================
// Trending Response (/api/trending)
// ============================================================================

// Re-export TrendingItemSchema from api-media-responses (kept for callers that still use it)
export { TrendingItemSchema, type TrendingItem } from './api-media-responses';

/**
 * Media preview embedded inside a trending recommendation item.
 * Matches the RecommendedMediaRef shape from recommender.ts.
 */
const TrendingMediaRefSchema = z.object({
    /** Internal UUID (stable, canonical). */
    id: z.string(),
    /** Canonical media type: 'movie' | 'series' | 'episode'. Never 'tv' or 'show'. */
    type: z.string(),
    /** Display title. */
    title: z.string(),
    /** Release year. */
    year: z.number().int().nullable().optional(),
    /** Provider ID map. */
    ids: z.record(z.string(), z.string()),
    /** Self-describing image href map keyed by role (poster | backdrop | …). */
    images: z
        .record(
            z.string(),
            z.object({
                href: z.string(),
                width: z.number().int().optional(),
                height: z.number().int().optional(),
            }),
        )
        .optional(),
});

/**
 * Reason block emitted by the trending strategy.
 */
const TrendingReasonSchema = z.object({
    kind: z.string(),
    seed: z.string().optional(),
    label: z.string().optional(),
});

/**
 * One item in the trending response.
 * Matches the RecommendationItem shape emitted by recommender.ts / trending.ts def.
 */
export const TrendingRecommendationItemSchema = z
    .object({
        media: TrendingMediaRefSchema,
        score: z.number().min(0).max(1).optional(),
        /** Item is in the library (has_files) — carried for discovery-sourced trending. */
        isAvailable: z.boolean().optional(),
        /** Item is not available and eligible to be requested. */
        canRequest: z.boolean().optional(),
        reason: TrendingReasonSchema.optional(),
    })
    .meta({ id: 'TrendingRecommendationItem', description: 'Trending recommendation item' });

export type TrendingRecommendationItem = z.infer<typeof TrendingRecommendationItemSchema>;

/**
 * Trending response — server returns { items, page } collection envelope.
 * Items are RecommendationItem shapes (media preview + optional score/reason).
 */
export const TrendingResponseSchema = z
    .object({
        /** Trending recommendation items */
        items: z.array(TrendingRecommendationItemSchema).describe('Trending items'),
        /** Pagination block */
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .describe('Pagination info'),
    })
    .meta({ id: 'TrendingResponse', description: 'Trending response ({items,page} envelope)' });

export type TrendingResponse = z.infer<typeof TrendingResponseSchema>;

/**
 * Clear trending cache response
 */
export const ClearTrendingCacheResponseSchema = z
    .object({
        /** Success flag */
        success: z.boolean().describe('Success'),
        /** Number of cache keys cleared */
        cleared: z.number().describe('Number of cache keys cleared'),
    })
    .meta({
        id: 'ClearTrendingCacheResponse',
        description: 'Clear trending cache response',
    });

export type ClearTrendingCacheResponse = z.infer<typeof ClearTrendingCacheResponseSchema>;

// ============================================================================
// Person Search Response (/api/person/search)
// ============================================================================

/**
 * Person search response
 * Server returns a single match: { personId, name, profilePath? }
 */
export const PersonSearchResponseSchema = z
    .object({
        /** TMDB person ID */
        personId: z.number().describe('TMDB person ID'),
        /** Person name */
        name: z.string().describe('Person name'),
        /** Profile image path */
        images: ImageSetSchema.optional().describe('Person profile artwork'),
    })
    .meta({
        id: 'PersonSearchResponse',
        description: 'Person search response',
    });

export type PersonSearchResponse = z.infer<typeof PersonSearchResponseSchema>;

// ============================================================================
// Media Rating Response (/api/media/[id]/rating)
// ============================================================================

/**
 * Media rating response
 * Server returns: { rating, canRate?, message? }
 */
export const MediaRatingResponseSchema = z
    .object({
        /** User's rating (null if not rated) */
        rating: z.number().optional().describe('User rating'),
        /** How the rating was entered — undefined when unknown/not rated */
        ratingStyle: z.enum(['quick', 'stars']).optional().describe('How the rating was entered'),
        /** Whether user can rate this item */
        canRate: z.boolean().optional().describe('Whether user can rate'),
        /** Status message */
        message: z.string().optional().describe('Status message'),
    })
    .meta({ id: 'MediaRatingResponse', description: 'Media rating response' });

export type MediaRatingResponse = z.infer<typeof MediaRatingResponseSchema>;

// ============================================================================
// Viewers Response (/api/media/[id]/viewers)
// ============================================================================

/**
 * A user who watched this item. Ships `displayName`, never the login handle
 * — viewers render on a shared living-room TV screen, so the username must
 * not be on the wire. Uses the same public author identity as social activity.
 */
export const ViewerItemSchema = z
    .object({
        author: publicAuthorSchema,
        rating: z.number().int().optional(),
        ratingStyle: z.enum(['quick', 'stars']).optional(),
        watchedAt: z.string().optional(),
        playCount: z.number().int().optional(),
        isFavorite: z.boolean().optional(),
    })
    .meta({ id: 'ViewerItem', description: 'A user who watched this item' });

export type ViewerItem = z.infer<typeof ViewerItemSchema>;

/**
 * Media viewers response
 * Server returns: { items: [{ author, ...activity }], page, me: { watched, rating? } }
 */
export const ViewersResponseSchema = z
    .object({
        items: z.array(ViewerItemSchema),
        page: z.object({
            limit: z.number().int(),
            offset: z.number().int(),
            hasMore: z.boolean(),
            total: z.number().int(),
        }),
        me: z.object({ watched: z.boolean(), rating: z.number().optional() }),
    })
    .meta({ id: 'ViewersResponse', description: 'Media viewers response' });

export type ViewersResponse = z.infer<typeof ViewersResponseSchema>;

// ============================================================================
// Dismiss Request Detail Responses (/api/request/dismiss)
// ============================================================================

// ============================================================================
// Series Ordering Responses (/api/series/[id]/ordering)
// ============================================================================

const OrderingInfoSchema = z.object({
    orderingType: z.string(),
    orderingSource: z.string(),
    provider: z.string().nullable(),
    groupId: z.string().nullable(),
    updatedAt: z.string().optional(),
});

const AvailableOrderingSchema = z.object({
    type: z.string(),
    provider: z.string(),
    groupId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    episodeCount: z.number(),
    groupCount: z.number(),
    providerType: z
        .number()
        .int()
        .optional()
        .describe('Provider group type code (TMDB: 1 original air date … 7 TV)'),
});

export const SeriesOrderingResponseSchema = z
    .object({
        current: OrderingInfoSchema,
        available: z.array(AvailableOrderingSchema),
        hasCachedOrderings: z.boolean(),
    })
    .meta({ id: 'SeriesOrderingResponse' });

export type SeriesOrderingResponse = z.infer<typeof SeriesOrderingResponseSchema>;

/** Ordering set response — bare object, new contract. */
export const SeriesOrderingSetResponseSchema = z
    .object({
        orderingType: z.string(),
        orderingSource: z.string(),
        provider: z.string().nullable(),
        groupId: z.string().nullable(),
        updatedAt: z.string(),
    })
    .meta({ id: 'SeriesOrderingSetResponse' });

export type SeriesOrderingSetResponse = z.infer<typeof SeriesOrderingSetResponseSchema>;

/** Ordering reset/delete response — bare object, new contract. */
export const SeriesOrderingResetResponseSchema = z
    .object({
        message: z.string(),
    })
    .meta({ id: 'SeriesOrderingResetResponse' });

export type SeriesOrderingResetResponse = z.infer<typeof SeriesOrderingResetResponseSchema>;

/** Ordering apply response — bare object, new contract. */
export const SeriesOrderingApplyResponseSchema = z
    .object({
        applied: z.number(),
        skipped: z.number(),
        combined: z.number(),
    })
    .meta({ id: 'SeriesOrderingApplyResponse' });

export type SeriesOrderingApplyResponse = z.infer<typeof SeriesOrderingApplyResponseSchema>;

/** Sync result item — typed shape for a single synced ordering. */
const SyncedOrderingItemSchema = z.object({
    type: z.string(),
    provider: z.string().optional(),
    count: z.number().int(),
});

/** Ordering sync response — bare object, new contract; no z.unknown() array. */
export const SeriesOrderingSyncResponseSchema = z
    .object({
        synced: z.array(SyncedOrderingItemSchema),
    })
    .meta({ id: 'SeriesOrderingSyncResponse' });

export type SeriesOrderingSyncResponse = z.infer<typeof SeriesOrderingSyncResponseSchema>;

// ============================================================================
// Per-book audiobook social sharing (/api/{,v1}/media/{id}/listening-sharing)
// ============================================================================

export const SharingPolicySchema = z
    .object({
        /** Per-book preference. False means an explicit user_media_share_opt_out row exists. */
        shared: z.boolean(),
        /** Audiobook-wide preference from Settings. */
        globallyShared: z.boolean(),
        /** Whether privacy switches allow sharing with at least one other live audience member. */
        effectiveShared: z.boolean(),
        audience: z.enum(['household', 'groups']),
        blockedBy: z.array(
            z.enum(['global_sharing_off', 'hidden', 'item_opted_out', 'no_audience']),
        ),
    })
    .meta({
        id: 'SharingPolicy',
        description:
            'The authenticated user’s sharing policy for one audiobook, including audience reach and blockers.',
    });

export type SharingPolicy = z.infer<typeof SharingPolicySchema>;
