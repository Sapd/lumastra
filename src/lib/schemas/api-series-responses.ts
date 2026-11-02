// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Series Response Zod Schemas
 *
 * Zod schemas for series-specific API response types.
 * These schemas define the contract between server and client for series endpoints.
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
import { ImageSetSchema } from './api-image-descriptor.js';
import { MediaPreviewSchema } from './api-media-preview.js';
import { PlaybackProgressSchema } from './api-playback-progress.js';
import {
    MediaNodeBaseSchema,
    MediaNodeLinkSchema,
    MediaNodeUserSchema,
    MediaNodeDetailsSchema,
} from './media-detail';

// ============================================================================
// Next Episode Response
// ============================================================================

/**
 * Next episode data - represents the next unwatched episode in a series
 */
export const NextEpisodeDataSchema = z
    .object({
        /** Episode internal UUID */
        id: z.string().describe('Episode internal UUID'),
        /** Episode name/title */
        name: z.string().describe('Episode name'),
        /** Season number */
        seasonNumber: z.number().int().describe('Season number'),
        /** Episode number */
        episodeNumber: z.number().int().describe('Episode number'),
        /** Episode overview/description */
        overview: z.string().optional().describe('Episode overview'),
        /** Runtime in ticks (10,000 ticks = 1ms) */
        runtimeTicks: z.number().optional().describe('Runtime in ticks'),
        /** Runtime in minutes */
        runtimeMinutes: z.number().optional().describe('Runtime in minutes'),
        /** Premiere/air date (ISO 8601) */
        premiereDate: z.string().optional().describe('Premiere date'),
        /** Image tag for constructing image URL */
        imageTag: z.string().optional().describe('Image tag'),
        /** Source of the data */
        source: z.string().describe('Data source'),
    })
    .meta({
        id: 'NextEpisodeData',
        description: 'Next episode to watch in a series',
    });

export type NextEpisodeData = z.infer<typeof NextEpisodeDataSchema>;

/**
 * Next episode API response
 */
export const NextEpisodeResponseSchema = NextEpisodeDataSchema.extend({
    /** Whether response was served from cache */
    cached: z.boolean().optional().describe('Whether response was served from cache'),
}).meta({
    id: 'NextEpisodeResponse',
    description: 'Next episode API response',
});

export type NextEpisodeResponse = z.infer<typeof NextEpisodeResponseSchema>;

// ============================================================================
// Series Info Response
// ============================================================================

/**
 * Image tags for series (primary/backdrop/logo)
 */
export const SeriesImageTagsSchema = z
    .object({
        /** Primary/poster image tag */
        primary: z.string().optional().describe('Primary image tag'),
        /** Backdrop/fanart image tag */
        backdrop: z.string().optional().describe('Backdrop image tag'),
        /** Logo image tag */
        logo: z.string().optional().describe('Logo image tag'),
    })
    .optional()
    .meta({ id: 'SeriesImageTags', description: 'Series image tags' });

export type SeriesImageTags = z.infer<typeof SeriesImageTagsSchema>;

/**
 * Series external IDs
 */
export const SeriesInfoExternalIdsSchema = z
    .object({
        /** Internal UUID from media_items.id */
        internal: z.string().optional().describe('Internal UUID'),
        /** TMDB series ID */
        tmdb: z.string().optional().describe('TMDB series ID'),
        /** IMDB series ID */
        imdb: z.string().optional().describe('IMDB series ID'),
        /** TVDB series ID */
        tvdb: z.string().optional().describe('TVDB series ID'),
    })
    .meta({
        id: 'SeriesInfoExternalIds',
        description: 'Series info external IDs',
    });

export type SeriesInfoExternalIds = z.infer<typeof SeriesInfoExternalIdsSchema>;

/**
 * Series info data - comprehensive metadata for a TV series
 */
export const SeriesInfoDataSchema = z
    .object({
        /** Series internal UUID */
        id: z.string().describe('Series internal UUID'),
        /** Series name/title */
        name: z.string().describe('Series name'),
        /** Series overview/description */
        overview: z.string().describe('Series overview'),
        /** Canonical media type discriminant (always 'series') */
        type: z.literal('series').describe('Media type'),
        /** Release year */
        year: z.number().int().optional().describe('Release year'),
        /** Premiere date (ISO 8601) */
        premiereDate: z.string().optional().describe('Premiere date'),
        /** Community rating (TMDB/IMDB score) */
        communityRating: z.number().describe('Community rating'),
        /** Critic rating (Rotten Tomatoes) */
        criticRating: z.number().optional().describe('Critic rating'),
        /** Array of genre names */
        genres: z.array(z.string()).describe('Genres'),
        /** Total number of seasons */
        seasonCount: z.number().int().optional().describe('Season count'),
        /** YouTube trailer URL */
        trailerUrl: z.string().optional().describe('Trailer URL'),
        /** Average runtime in minutes */
        runtimeMinutes: z.number().optional().describe('Runtime in minutes'),
        /** Production studio/network */
        studio: z.string().optional().describe('Studio/network'),
        /** Series status (Continuing/Ended) */
        status: z.string().optional().describe('Series status'),
        /** Whether series is available locally */
        isAvailable: z.boolean().describe('Available in library'),
        /** Jellyfin image tags */
        imageTags: SeriesImageTagsSchema.describe('Image tags'),
        /** External provider IDs */
        externalIds: SeriesInfoExternalIdsSchema.describe('External IDs'),
    })
    .meta({ id: 'SeriesInfoData', description: 'Series info metadata' });

export type SeriesInfoData = z.infer<typeof SeriesInfoDataSchema>;

/**
 * Series info API response — bare object, new contract (no success wrapper).
 */
export const SeriesInfoResponseSchema = SeriesInfoDataSchema.meta({
    id: 'SeriesInfoResponse',
    description: 'Series info API response',
});

export type SeriesInfoResponse = z.infer<typeof SeriesInfoResponseSchema>;

// ============================================================================
// Series Node — traversal spine (GET /series/{id})
// ============================================================================
//
// Distinct from SeriesInfoResponseSchema above (a legacy Jellyfin-shaped
// contract — name/communityRating/genres/imageTags — still used to validate
// GET /api/series/{id} client-side; left untouched). This is the shape
// actually sent by defs/catalog/series-id.ts: the same minimal traversal
// node as GET /media/{id} (id/ids/title/images, etc. — see MediaNodeBaseSchema
// in media-detail.ts) plus always-present seasons/episodes/nextEpisode/
// watchStatus links, and an optional per-user block.

export const SeriesNodeSchema = MediaNodeBaseSchema.extend({
    catalogId: z
        .uuid()
        .nullable()
        .describe('Library UUID; id is the opaque handle accepted in the path'),
    /** Canonical discriminator — always 'series' */
    type: z.literal('series').describe('Canonical media type discriminant'),
    seasons: MediaNodeLinkSchema.describe("Link to this series' seasons list"),
    episodes: MediaNodeLinkSchema.describe("Link to this series' episodes list"),
    nextEpisode: MediaNodeLinkSchema.describe('Link to the next unwatched episode'),
    watchStatus: MediaNodeLinkSchema.describe("Link to this series' watch status"),
    user: MediaNodeUserSchema.optional().describe('Per-user state (only with ?include=user)'),
    details: MediaNodeDetailsSchema.optional().describe(
        'Rich detail fields (only with ?include=details)',
    ),
}).meta({
    id: 'SeriesNode',
    description:
        'Series traversal node — the actual GET /series/{id} response (id/ids/title/images plus seasons/episodes/nextEpisode/watchStatus links)',
});

export type SeriesNode = z.infer<typeof SeriesNodeSchema>;

// ============================================================================
// Watch Status Response
// ============================================================================

/**
 * Episode watch status data
 */
export const EpisodeWatchStatusDataSchema = z
    .object({
        /** Episode internal UUID */
        episodeId: z.string().describe('Episode internal UUID'),
        /** Season number */
        seasonNumber: z.number().int().optional().describe('Season number'),
        /** Episode number */
        episodeNumber: z.number().int().optional().describe('Episode number'),
        /** Whether episode has been watched */
        isWatched: z.boolean().describe('Episode watched status'),
        /** Playback position in ticks */
        playbackPositionTicks: z.number().describe('Playback position ticks'),
        /** Runtime in ticks */
        runtimeTicks: z.number().optional().describe('Runtime in ticks'),
        /** Playback progress percentage (0-100) */
        progressPercent: z.number().describe('Progress percentage'),
        /** When episode was marked watched (ISO 8601) */
        watchedAt: z.string().optional().describe('Watched timestamp'),
        /** Last progress update (ISO 8601) */
        lastProgressAt: z.string().optional().describe('Last progress timestamp'),
    })
    .meta({
        id: 'EpisodeWatchStatusData',
        description: 'Episode watch status',
    });

export type EpisodeWatchStatusData = z.infer<typeof EpisodeWatchStatusDataSchema>;

/**
 * Watch status summary statistics
 */
export const WatchStatusSummarySchema = z
    .object({
        /** Total number of episodes */
        total: z.number().int().describe('Total episodes'),
        /** Number of watched episodes */
        watched: z.number().int().describe('Watched episodes'),
        /** Number of in-progress episodes */
        inProgress: z.number().int().describe('In-progress episodes'),
        /** Number of unwatched episodes */
        unwatched: z.number().int().describe('Unwatched episodes'),
    })
    .meta({ id: 'WatchStatusSummary', description: 'Watch status summary' });

export type WatchStatusSummary = z.infer<typeof WatchStatusSummarySchema>;

/**
 * Watch status data container
 */
export const WatchStatusDataSchema = z
    .object({
        /** Series internal UUID */
        seriesId: z.string().describe('Series internal UUID'),
        /** User ID */
        userId: z.string().describe('User ID'),
        /** Season number filter */
        season: z.number().int().optional().describe('Season filter'),
        /** Watch status summary */
        summary: WatchStatusSummarySchema.describe('Summary statistics'),
        /** Array of episode watch statuses */
        episodes: z.array(EpisodeWatchStatusDataSchema).describe('Episode statuses'),
    })
    .meta({ id: 'WatchStatusData', description: 'Watch status data' });

export type WatchStatusData = z.infer<typeof WatchStatusDataSchema>;

/**
 * Watch status API response — bare object, new contract (no success wrapper).
 */
export const WatchStatusResponseSchema = WatchStatusDataSchema.meta({
    id: 'WatchStatusResponse',
    description: 'Watch status API response',
});

export type WatchStatusResponse = z.infer<typeof WatchStatusResponseSchema>;

// ============================================================================
// Season Node (flat catalog node — seasons/{id} and series/{id}/seasons/{n})
// ============================================================================

/**
 * Canonical Season node — returned by `GET /seasons/{id}` and
 * `GET /series/{id}/seasons/{n}` (single-season branch).
 *
 * Physical and virtual seasons share the builder in defs/catalog/series/seasons.ts.
 */
export const SeasonNodeSchema = z
    .object({
        id: z.string().min(1).describe('Opaque season handle'),
        catalogId: z.uuid().nullable(),
        type: z.literal('season'),
        ids: z.record(z.string(), z.string()).describe('External IDs only'),
        ordering: z.enum(['standard', 'dvd', 'absolute', 'regional', 'other']),
        virtual: z.boolean(),
        title: z.string(),
        seasonNumber: z.number().int(),
        overview: z.string().optional(),
        premiereDate: z.string().optional(),
        episodeCount: z.number().int(),
        watchedCount: z.number().int(),
        images: ImageSetSchema,
        progress: PlaybackProgressSchema.optional(),
        series: z.object({ id: z.string(), catalogId: z.uuid().nullable(), href: z.string() }),
        href: z.string(),
        episodes: z.object({ href: z.string() }),
    })
    .meta({ id: 'SeasonNode', description: 'Physical or logical season in the selected ordering' });

export type SeasonNode = z.infer<typeof SeasonNodeSchema>;

// ============================================================================
// Episode Node (flat catalog node — episodes/{id})
// ============================================================================

/**
 * Canonical Episode node — returned by `GET /episodes/{id}`.
 *
 * Shape mirrors the json() body in defs/catalog/episodes-id.ts.
 */
export const EpisodeNodeSchema = MediaPreviewSchema.pick({
    id: true,
    catalogId: true,
    type: true,
    ids: true,
    title: true,
    overview: true,
    durationMs: true,
    originalLanguage: true,
    audioLanguages: true,
    subtitleLanguages: true,
    segments: true,
    images: true,
    availability: true,
    progress: true,
    context: true,
})
    .extend({ type: z.literal('episode') })
    .meta({
        id: 'EpisodeNode',
        description:
            'Episode preview with ordering-aware context, availability, images and playback progress',
    });

export type EpisodeNode = z.infer<typeof EpisodeNodeSchema>;

// ============================================================================
// Next Episode Node (GET /api/v1/series/{id}/next-episode)
// ============================================================================

/**
 * Canonical next-unwatched Episode node — returned by
 * `GET /series/{id}/next-episode`.
 *
 * Shape mirrors the NextEpisodeNode `json()` body in
 * defs/catalog/series/next-episode.ts. Distinct from EpisodeNode: this handler
 * emits durationMs (always, null when unknown) and a non-null `series.href`,
 * and does NOT emit `year`.
 */
export const NextEpisodeNodeSchema = z
    .object({
        /** Internal UUID */
        id: z.string().describe('Internal UUID'),
        catalogId: z.uuid().nullable().describe('Catalog episode UUID'),
        /** Canonical type discriminant */
        type: z.literal('episode').describe('Media type'),
        /** Open external-ID map (provider → id) */
        ids: z.record(z.string(), z.string()).describe('External IDs map'),
        /** Episode title */
        title: z.string().describe('Episode title'),
        /** Season number */
        seasonNumber: z.number().int().describe('Season number'),
        /** Episode number */
        episodeNumber: z.number().int().describe('Episode number'),
        /** Episode overview (auto-resolution branch only) */
        overview: z.string().optional().describe('Episode overview'),
        /** Premiere/air date, ISO 8601 (auto-resolution branch only) */
        premiereDate: z.string().optional().describe('Premiere date'),
        /** Duration in milliseconds; null when no duration is known */
        durationMs: z
            .number()
            .int()
            .nullable()
            .describe(
                'Duration in milliseconds; null when neither metadata nor a probed file gives one (e.g. an episode that has not aired yet)',
            ),
        /** Explicit lookup only: whether the episode has a file to play */
        playable: z
            .boolean()
            .optional()
            .describe(
                'Set only for an explicit `?season=&episode=` lookup: false when the episode has no file yet (not aired or not downloaded)',
            ),
        /** Resolved landscape artwork descriptors */
        images: ImageSetSchema.describe('Self-describing image hrefs'),
        /** Deep-link to parent series */
        series: z
            .object({ href: z.string().describe('Series detail URL') })
            .describe('Parent series href'),
    })
    .meta({ id: 'NextEpisodeNode', description: 'Canonical next-unwatched episode catalog node' });

export type NextEpisodeNode = z.infer<typeof NextEpisodeNodeSchema>;

// ============================================================================
// V1 canonical paginated collection schemas
// (PageBlockSchema mirrors the runtime `paginate()` envelope)
// ============================================================================

import { PageBlockSchema, paginatedEnvelope } from './pagination.js';

/**
 * Episode item as returned in the v1 `series/{id}/episodes` paginated collection.
 * Shares the flat EpisodeNode preview contract.
 */
export const EpisodeCollectionItemSchema = MediaPreviewSchema.extend({
    type: z.literal('episode'),
}).meta({
    id: 'EpisodeCollectionItem',
    description: 'Episode preview with ordering-aware context',
});

export type EpisodeCollectionItem = z.infer<typeof EpisodeCollectionItemSchema>;

/**
 * V1 `GET /series/{id}/episodes` response — `{ items, page }` of episode items.
 */
export const EpisodesCollectionResponseSchema = paginatedEnvelope(EpisodeCollectionItemSchema).meta(
    {
        id: 'EpisodesCollectionResponse',
        description: 'Paged episode previews in active walk order',
    },
);

export type EpisodesCollectionResponse = z.infer<typeof EpisodesCollectionResponseSchema>;

/**
 * Season item as returned in the v1 `series/{id}/seasons` paginated collection.
 * Mirrors the `SeasonNode` interface in defs/catalog/series/seasons.ts.
 */
export const SeasonCollectionItemSchema = SeasonNodeSchema;

export type SeasonCollectionItem = z.infer<typeof SeasonCollectionItemSchema>;

/**
 * V1 `GET /series/{id}/seasons` response — `{ items, page }` of season items.
 */
export const SeasonsCollectionResponseSchema = paginatedEnvelope(SeasonCollectionItemSchema)
    .extend({
        ordering: z.enum(['standard', 'dvd', 'absolute', 'regional', 'other']),
    })
    .meta({ id: 'SeasonsCollectionResponse', description: 'All seasons in the active ordering' });

export type SeasonsCollectionResponse = z.infer<typeof SeasonsCollectionResponseSchema>;

/**
 * Per-user watch state for an episode in the watch-status collection.
 */
const EpisodeWatchStateSchema = z
    .object({
        isWatched: z.boolean().describe('Whether the episode has been watched'),
        playbackPositionTicks: z.number().describe('Playback position in ticks'),
        durationMs: z.number().int().optional().describe('Duration in milliseconds'),
        progressPercent: z.number().describe('Progress percentage (0–100)'),
        watchedAt: z.string().optional().describe('When episode was marked watched (ISO 8601)'),
        lastProgressAt: z.string().optional().describe('Last progress update (ISO 8601)'),
    })
    .meta({
        id: 'EpisodeWatchState',
        description: 'Per-user watch state for an episode in watch-status collection',
    });

/**
 * Episode watch-status item as returned in the v1 `series/{id}/watch-status` collection.
 */
export const EpisodeWatchStatusItemSchema = z
    .object({
        id: z.string().describe('Episode internal UUID'),
        catalogId: z.uuid().nullable().describe('Catalog episode UUID'),
        type: z.literal('episode').describe('Media type discriminant'),
        ids: z.record(z.string(), z.string()).describe('External IDs map (provider → id)'),
        seasonNumber: z.number().int().optional().describe('Season number'),
        episodeNumber: z.number().int().optional().describe('Episode number'),
        images: ImageSetSchema.describe('Resolved landscape artwork descriptors'),
        series: z
            .object({ href: z.string().describe('Parent series detail URL') })
            .describe('Parent series deep-link'),
        user: EpisodeWatchStateSchema.describe('Per-user watch state'),
    })
    .meta({ id: 'EpisodeWatchStatusItem', description: 'Episode watch-status item' });

export type EpisodeWatchStatusItem = z.infer<typeof EpisodeWatchStatusItemSchema>;

/**
 * Summary counts in the watch-status response.
 */
const WatchStatusSummaryV1Schema = z
    .object({
        total: z.number().int().describe('Total episode count'),
        watched: z.number().int().describe('Watched count'),
        inProgress: z.number().int().describe('In-progress count'),
        unwatched: z.number().int().describe('Unwatched count'),
    })
    .meta({ id: 'WatchStatusSummaryV1', description: 'Watch status summary counts' });

/**
 * V1 `GET /series/{id}/watch-status` response — `{ items, page, summary }`.
 */
export const WatchStatusCollectionResponseSchema = z
    .object({
        items: z.array(EpisodeWatchStatusItemSchema).describe('Episode watch-status items'),
        page: PageBlockSchema.describe('Pagination info'),
        summary: WatchStatusSummaryV1Schema.describe('Roll-up watch status counts'),
    })
    .meta({
        id: 'WatchStatusCollectionResponse',
        description: 'Series watch-status collection response',
    });

export type WatchStatusCollectionResponse = z.infer<typeof WatchStatusCollectionResponseSchema>;

// ============================================================================
// Series watch marker (GET /api/v1/series/{id}/watch-marker)
// ============================================================================

/**
 * The episode a series watch marker points at. Season/episode numbers follow
 * the series' active episode ordering.
 */
export const SeriesWatchMarkerEpisodeSchema = z
    .object({
        id: z.string().describe('Episode internal UUID'),
        seasonNumber: z.number().int().describe('Season number (ordering-aware)'),
        episodeNumber: z.number().int().describe('Episode number (ordering-aware)'),
        title: z.string().describe('Episode title'),
        orderKey: z
            .number()
            .describe(
                'Ordering-aware sort key; a larger key is later in the series. Only meaningful ' +
                    'for comparisons within the same series.',
            ),
    })
    .meta({
        id: 'SeriesWatchMarkerEpisode',
        description: 'Episode a series watch marker points at',
    });

/**
 * `GET /series/{id}/watch-marker` — where the caller is in a series.
 *
 * Every field is required; "may be null" is expressed as required+nullable,
 * never optional+nullable (Swift codegen).
 */
export const SeriesWatchMarkerSchema = z
    .object({
        state: z
            .enum(['in_progress', 'next', 'finished', 'not_started'])
            .describe(
                '`in_progress`: an episode is partly watched (live or durable). `next`: the next ' +
                    'episode after the watch history, at position 0. `finished`: every main-line ' +
                    'episode is watched (episode = the last watched). `not_started`: nothing ' +
                    'watched (episode = the first main-line episode, if any).',
            ),
        episode: SeriesWatchMarkerEpisodeSchema.nullable().describe(
            'Marker episode; null when the series has no playable main-line episode',
        ),
        progress: PlaybackProgressSchema.describe('Marker episode playback progress'),
        positionMs: z.number().int().describe('Resume position in the marker episode (ms)'),
        updatedAt: z
            .string()
            .nullable()
            .describe('ISO 8601 time of the activity behind the marker, when known'),
        deviceName: z
            .string()
            .nullable()
            .describe('Best-effort client name of the device that set the marker'),
        relation: z
            .enum(['forward', 'same', 'behind', 'none'])
            .describe(
                'Marker position relative to `from`. `none` without `from`, when `from` is not ' +
                    'an episode of this series, or when there is no marker episode.',
            ),
        sameFileAsFrom: z
            .boolean()
            .describe(
                'True when `from` and the marker episode share one media file (combined ' +
                    'episodes): seek instead of navigating.',
            ),
    })
    .meta({ id: 'SeriesWatchMarker', description: 'Series watch marker for the caller' });

export type SeriesWatchMarker = z.infer<typeof SeriesWatchMarkerSchema>;
