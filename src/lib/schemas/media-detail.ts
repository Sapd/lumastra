// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unified MediaDetail Schema — new contract
 *
 * SINGLE SOURCE OF TRUTH for detailed media information.
 * Uses a discriminated union on `type` (canonical discriminator) to distinguish
 * movie vs series. The `type` field replaces the old `mediaType` discriminant.
 *
 * Contract alignment:
 * - `type` discriminates movie vs series (never 'tv' or 'show')
 * - `ids` is the open external-ID map (replaces flat `externalIds`)
 * - `images` is the self-describing href map (replaces flat `posterUrl`/`backdropUrl`)
 * - All optional fields use .optional() (NOT .nullable())
 */

import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import { z } from 'zod';
import { AudiobookKindSchema, AudiobookChapterSchema } from './api-audiobook.js';
import { PlaybackProgressSchema } from './api-playback-progress.js';
export { AudiobookChapterSchema } from './api-audiobook.js';
export type { AudiobookChapter } from './api-audiobook.js';
import { PersonCreditsSchema } from './api-person-responses.js';

// ============================================================================
// Person Schemas (structured cast/crew)
// ============================================================================

export const ActorSchema = z
    .object({
        name: z.string().describe('Actor name'),
        character: z.string().optional().describe('Character name'),
        images: ImageSetSchema.optional().describe('Person profile artwork'),
        tmdbId: z
            .string()
            .optional()
            .describe('TMDB person id, for clients that build their own image URLs'),
    })
    .meta({
        id: 'Actor',
        description: 'Actor with character and optional profile image',
    });

export type Actor = z.infer<typeof ActorSchema>;

export const DirectorSchema = z
    .object({
        name: z.string().describe('Director name'),
        job: z.string().optional().describe('Job title'),
        images: ImageSetSchema.optional().describe('Person profile artwork'),
    })
    .meta({
        id: 'Director',
        description: 'Director/crew member with optional profile image',
    });

export type Director = z.infer<typeof DirectorSchema>;

// ============================================================================
// Image hrefs (self-describing)
// ============================================================================

// ============================================================================
// Quality summary (best available version)
// ============================================================================

/**
 * Summary of the HIGHEST-quality version available for an item, for rendering
 * 4K / HDR / Dolby Vision / Atmos badges. When an item has multiple physical
 * versions the best is reported across all of them (best resolution, best
 * dynamic range independently). Sourced from the `media_item_quality`
 * projection (resolution + range — correct for movies AND series via the
 * episode rollup) plus the item's best audio stream (audio codec).
 *
 * videoRange uses the projection's fine `hdr_type` (SDR / HDR10 / HDR10Plus /
 * HLG / DolbyVision). HDR10+ relies on the source being probed with HDR10+
 * dynamic-metadata signalling (always available from Jellyfin; from the local
 * ffprobe scan when the demuxer exposes SMPTE 2094-40 side-data) — otherwise
 * HDR10+ content degrades to `"HDR10"`. Legacy projection rows written before
 * the hdr_type backfill fall back to the coarse tier (also HDR10 for any HDR).
 */
export const MediaQualitySummarySchema = z
    .object({
        resolution: z
            .string()
            .optional()
            .describe('Best available resolution label — "2160p" | "1080p" | "720p" | "480p"'),
        is4k: z
            .boolean()
            .optional()
            .describe('True when the best available version is 4K/2160p (drives the 4K badge)'),
        videoRange: z
            .enum(['SDR', 'HDR10', 'HDR10Plus', 'HLG', 'DolbyVision'])
            .optional()
            .describe(
                'Best available video dynamic range. HDR10+ requires a source probed with ' +
                    'HDR10+ dynamic-metadata signalling; otherwise HDR10+ content reports "HDR10".',
            ),
        audioCodec: z
            .string()
            .optional()
            .describe(
                'Best available audio codec label, e.g. "TrueHD Atmos", "EAC3", "DTS". The ' +
                    'Atmos suffix is best-effort inferred from codec/profile/channel data.',
            ),
        hasAtmos: z
            .boolean()
            .optional()
            .describe(
                'Dolby Atmos available, stated directly rather than inferred from the ' +
                    'audioCodec string. Recommendation rails source this from the ' +
                    'media_item_quality projection and never carry a codec label.',
            ),
        hasClosedCaptions: z
            .boolean()
            .optional()
            .describe('Embedded closed captions (EIA-608/708) available (drives the CC badge)'),
        hasSDH: z
            .boolean()
            .optional()
            .describe('Subtitles for the deaf/hard-of-hearing available (drives the SDH badge)'),
        hasAudioDescription: z
            .boolean()
            .optional()
            .describe(
                'Audio description / descriptive audio track available (drives the AD badge)',
            ),
    })
    .meta({
        id: 'MediaQualitySummary',
        description:
            'Summary of the highest-quality available version — drives 4K / HDR / Dolby ' +
            'Vision / Atmos badges. Absent when no probed local version exists.',
    });

export type MediaQualitySummary = z.infer<typeof MediaQualitySummarySchema>;

// ============================================================================
// Audiobook-specific fields
// ============================================================================

/** Canonical book identity, own cover, book-clock millisecond chapters and viewer progress. */
export const AudiobookFieldsSchema = z.object({
    ...AudiobookKindSchema.shape,
    durationMs: z.number().int().nullable(),
    chapters: z.array(AudiobookChapterSchema),
    progress: PlaybackProgressSchema.optional(),
    images: ImageSetSchema,
    publisher: z.string().optional(),
    abridged: z.boolean().optional(),
});

// ============================================================================
// Base MediaDetail (shared fields)
// ============================================================================

export const BaseMediaDetailSchema = z
    .object({
        // Identity
        id: z.string().describe('Internal UUID'),
        ids: z.record(z.string(), z.string()).describe('Open external-ID map'),

        // Core metadata
        title: z.string().describe('Primary display title'),
        originalTitle: z.string().optional().describe('Original language title'),
        tagline: z.string().optional().describe('Stored, localized media tagline'),
        libraryNames: z
            .array(z.string())
            .optional()
            .describe('Names of accessible libraries containing this item'),
        overview: z.string().optional().describe('Plot overview/description'),

        // Images — self-describing href map (replaces flat posterUrl/backdropUrl)
        images: ImageSetSchema.describe('Self-describing image href map'),

        // Categorization
        genres: z.array(z.string()).optional().describe('Genre names'),
        keywords: z.array(z.string()).optional().describe('Content keywords'),
        certification: z.string().optional().describe('Content rating (PG-13, TV-MA, etc.)'),
        trailerUrl: z.string().optional().describe('YouTube trailer URL'),
        hasLocalTrailer: z
            .boolean()
            .optional()
            .describe('A playable local trailer file exists for this item'),
        extras: z
            .array(
                z.object({
                    id: z.string().describe('Extra item UUID (playable via /watch/{id})'),
                    title: z.string().describe('Extra title'),
                    extraType: z
                        .string()
                        .describe('Extra kind (trailer, behind_the_scenes, featurette, …)'),
                    durationMs: z.number().int().optional().describe('Duration in milliseconds'),
                }),
            )
            .optional()
            .describe('File-backed extras (trailers, behind-the-scenes, …) belonging to this item'),

        // Availability
        isAvailable: z.boolean().optional().describe('Available in local library'),
        canRequest: z.boolean().optional().describe('Can be requested via Jellyseerr'),

        // Primary rating (best available, normalized to 0-10)
        rating: z
            .number()
            .min(0)
            .max(10)
            .optional()
            .describe('Best available rating, normalized 0-10'),
        ratingSource: z.string().optional().describe('Source of primary rating (e.g. imdb, tmdb)'),

        // All available ratings keyed by source — raw values from each provider
        ratings: z
            .record(z.string(), z.number())
            .optional()
            .describe('All ratings keyed by source name'),

        // Credits — structured Person objects
        actors: z.array(ActorSchema).optional().describe('Cast members with character info'),
        directors: z.array(DirectorSchema).optional().describe('Directors/crew members'),

        // Discovery
        popularity: z.number().optional().describe('Popularity score'),
        voteCount: z.number().int().optional().describe('Total vote count'),

        // File-based language data (movies and episodes with local files)
        originalLanguage: z
            .string()
            .optional()
            .describe(
                'Original production language of the title; episodes inherit the series language',
            ),
        audioLanguages: z
            .array(z.string())
            .optional()
            .describe(
                "Aggregated audio language codes (ISO 639-1) across the item's files; " +
                    "strict-majority across a series' episodes",
            ),
        subtitleLanguages: z
            .array(z.string())
            .optional()
            .describe(
                "Aggregated subtitle language codes (ISO 639-1) across the item's files; " +
                    "strict-majority across a series' episodes",
            ),

        // Best-available version quality summary (4K / HDR / DV / Atmos badges)
        quality: MediaQualitySummarySchema.optional().describe(
            'Quality summary of the best available version (only present for items with a probed local version)',
        ),
    })
    .meta({
        id: 'BaseMediaDetail',
        description: 'Shared fields for movie and TV detail',
    });

// ============================================================================
// Movie Detail
// ============================================================================

export const MovieDetailSchema = BaseMediaDetailSchema.extend({
    /** Canonical discriminator — always 'movie' */
    type: z.literal('movie').describe('Canonical media type discriminant'),
    year: z.number().int().optional().describe('Release year'),
    runtime: z.number().int().optional().describe('Runtime in minutes'),
}).meta({
    id: 'MovieDetail',
    description: 'Detailed movie information (new contract)',
});

export type MovieDetail = z.infer<typeof MovieDetailSchema>;

// ============================================================================
// TV/Series Detail
// ============================================================================

export const TvDetailSchema = BaseMediaDetailSchema.extend({
    /** Canonical discriminator — always 'series' (never 'tv' or 'show') */
    type: z.literal('series').describe('Canonical media type discriminant'),
    firstAirDate: z.string().optional().describe('First air date (ISO 8601)'),
    lastAirDate: z.string().optional().describe('Last air date (ISO 8601)'),
    status: z
        .enum(['Continuing', 'Ended', 'Canceled', 'Planned'])
        .optional()
        .describe('Series status'),
    seasonCount: z.number().int().optional().describe('Number of seasons'),
    episodeCount: z.number().int().optional().describe('Total episode count'),
    availableEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Active playable episodes in permitted libraries'),
    watchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Watched playable episodes for the current user'),
    unwatchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Unwatched playable episodes for the current user'),
    networks: z.array(z.string()).optional().describe('Broadcast networks'),
    creators: z.array(z.string()).optional().describe('Series creators'),
}).meta({
    id: 'TvDetail',
    description: 'Detailed TV series information (new contract)',
});

export type TvDetail = z.infer<typeof TvDetailSchema>;

// ============================================================================
// Audiobook Detail
// ============================================================================

/**
 * Detailed audiobook information.
 *
 * A third variant rather than a reuse of MovieDetail: `media_type = 'audiobook'`
 * is already a public discriminator (`PublicMediaType`), and the modal has to be
 * able to tell an audiobook apart from a movie to know that `narrators` and
 * `chapters` are the fields worth rendering.
 */
export const AudiobookDetailSchema = BaseMediaDetailSchema.extend({
    /** Canonical discriminator — always 'audiobook' */
    type: z.literal('audiobook').describe('Canonical media type discriminant'),
    year: z.number().int().optional().describe('Publication year'),
    ...AudiobookFieldsSchema.partial().shape,
}).meta({
    id: 'AudiobookDetail',
    description: 'Detailed audiobook information (AudiobookShelf-sourced)',
});

export type AudiobookDetail = z.infer<typeof AudiobookDetailSchema>;

// ============================================================================
// Discriminated Union (on `type`, not `mediaType`)
// ============================================================================

export const MediaDetailSchema = z
    .discriminatedUnion('type', [MovieDetailSchema, TvDetailSchema, AudiobookDetailSchema])
    .meta({
        id: 'MediaDetail',
        description: 'Unified media detail — discriminated union of movie, series and audiobook',
    });

export type MediaDetail = z.infer<typeof MediaDetailSchema>;

// ============================================================================
// Media Node — lightweight traversal spine
// ============================================================================
//
// Distinct from MediaDetail above (which is the RICH detail-page contract
// used by GET /api/media-details — actors, genres, ratings, etc., built by
// transformToMediaDetail()). This is the minimal node shape actually sent by
// GET /media/{id} (buildMediaDetail() in defs/catalog/media-id.ts) and reused
// as the base of GET /series/{id} (defs/catalog/series-id.ts): just enough
// for a client to identify the item and traverse onward. It intentionally
// carries none of MediaDetail's cast/crew/rating/genre fields.

/** Per-user state — only present when ?include=user or ?include=playback. */
export const MediaNodeUserSchema = z
    .object({
        rating: z.number().nullable().describe('User rating, or null if not rated'),
        inWatchlist: z.boolean().describe('Whether the item is on the watchlist'),
    })
    .meta({ id: 'MediaNodeUser', description: 'Per-user rating/watchlist state' });

/** A single traversal link — always an href, always present when declared. */
export const MediaNodeLinkSchema = z
    .object({ href: z.string().describe('Link URL') })
    .meta({ id: 'MediaNodeLink', description: 'Traversal link' });

/**
 * Shared identity fields common to every media node (movie, series, episode,
 * season) AND to the series node returned by GET /series/{id}. `id`, `ids`,
 * `title`, and `images` are always present; `year`/`overview` are omitted
 * when the source data has none.
 */
export const MediaNodeBaseSchema = z.object({
    tagline: z.string().optional().describe('Stored, localized media tagline'),
    libraryNames: z
        .array(z.string())
        .optional()
        .describe('Names of accessible libraries containing this item'),
    id: z.string().describe('Internal UUID'),
    ids: z.record(z.string(), z.string()).describe('Open external-ID map'),
    title: z.string().describe('Primary display title'),
    year: z.number().int().optional().describe('Premiere/release year'),
    overview: z.string().optional().describe('Plot overview/description'),
    images: ImageSetSchema.describe('Self-describing image href map'),
    durationMs: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
            'Length in ms: the probed duration of the primary file, or the metadata runtime until the file is probed. Null when unknown (series, seasons).',
        ),
});

/**
 * Rich detail fields — cast, genres, ratings, trailer, runtime, etc. Only
 * present on a movie/series `MediaNode` when the caller passes
 * `?include=details`; absent by default (and never populated for
 * episode/season nodes, which this data model doesn't cover at that
 * granularity). Movie-only and series-only fields simply stay absent on the
 * other type rather than forming a nested discriminated union — the parent
 * `MediaNode` already discriminates on `type`.
 *
 * Field-for-field subset of `BaseMediaDetailSchema`/`MovieDetailSchema`/
 * `TvDetailSchema` MINUS whatever `MediaNodeBaseSchema` already carries
 * (id/ids/title/overview/images/year) — `details` augments the node, it
 * doesn't repeat it. Sourced via the SAME `transformToMediaDetail()` used by
 * `GET /api/media-details`, so the two paths can't drift (see
 * `toNodeDetailsExtra()` in `api-transforms.ts`).
 */
export const MediaNodeDetailsSchema = z
    .object({
        originalTitle: z.string().optional().describe('Original language title'),
        genres: z.array(z.string()).optional().describe('Genre names'),
        keywords: z.array(z.string()).optional().describe('Content keywords'),
        certification: z.string().optional().describe('Content rating (PG-13, TV-MA, etc.)'),
        trailerUrl: z.string().optional().describe('YouTube trailer URL'),
        hasLocalTrailer: z
            .boolean()
            .optional()
            .describe('A playable local trailer file exists for this item'),
        extras: z
            .array(
                z.object({
                    id: z.string().describe('Extra item UUID (playable via /watch/{id})'),
                    title: z.string().describe('Extra title'),
                    extraType: z
                        .string()
                        .describe('Extra kind (trailer, behind_the_scenes, featurette, …)'),
                    durationMs: z.number().int().optional().describe('Duration in milliseconds'),
                }),
            )
            .optional()
            .describe('File-backed extras (trailers, behind-the-scenes, …) belonging to this item'),
        rating: z
            .number()
            .min(0)
            .max(10)
            .optional()
            .describe('Best available rating, normalized 0-10'),
        ratingSource: z.string().optional().describe('Source of primary rating (e.g. imdb, tmdb)'),
        ratings: z
            .record(z.string(), z.number())
            .optional()
            .describe('All ratings keyed by source name'),
        popularity: z.number().optional().describe('Popularity score'),
        voteCount: z.number().int().optional().describe('Total vote count'),
        originalLanguage: z
            .string()
            .optional()
            .describe(
                'Original production language of the title; episodes inherit the series language',
            ),
        audioLanguages: z
            .array(z.string())
            .optional()
            .describe(
                "Aggregated audio language codes (ISO 639-1) across the item's files; " +
                    "strict-majority across a series' episodes",
            ),
        subtitleLanguages: z
            .array(z.string())
            .optional()
            .describe(
                "Aggregated subtitle language codes (ISO 639-1) across the item's files; " +
                    "strict-majority across a series' episodes",
            ),
        quality: MediaQualitySummarySchema.optional().describe(
            'Quality summary of the best available version (4K / HDR / Dolby Vision / Atmos badges)',
        ),
        // Series-only
        firstAirDate: z.string().optional().describe('First air date, ISO 8601 (series only)'),
        lastAirDate: z.string().optional().describe('Last air date, ISO 8601 (series only)'),
        status: z
            .enum(['Continuing', 'Ended', 'Canceled', 'Planned'])
            .optional()
            .describe('Series status (series only)'),
        seasonCount: z.number().int().optional().describe('Number of seasons (series only)'),
        episodeCount: z.number().int().optional().describe('Total episode count (series only)'),
        availableEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Active playable episodes in permitted libraries'),
        watchedEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Watched playable episodes for the current user'),
        unwatchedEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Unwatched playable episodes for the current user'),
        networks: z.array(z.string()).optional().describe('Broadcast networks (series only)'),
    })
    .meta({
        id: 'MediaNodeDetails',
        description:
            'Rich detail fields (cast, genres, ratings, trailer, runtime, etc.) — only present ' +
            'with ?include=details on a movie or series node.',
    });

export type MediaNodeDetails = z.infer<typeof MediaNodeDetailsSchema>;

export const MediaNodeMovieSchema = MediaNodeBaseSchema.extend({
    credits: PersonCreditsSchema.optional().describe(
        'Cast and crew with canonical person handles; unknown person id is null and images are omitted',
    ),
    /** Canonical discriminator — always 'movie' */
    type: z.literal('movie').describe('Canonical media type discriminant'),
    isAvailable: z.boolean().describe('Available in local library'),
    canRequest: z.boolean().describe('Can be requested via Jellyseerr'),
    user: MediaNodeUserSchema.optional().describe('Per-user state (only with ?include=user)'),
    details: MediaNodeDetailsSchema.optional().describe(
        'Rich detail fields (only with ?include=details)',
    ),
}).meta({ id: 'MediaNodeMovie', description: 'Movie traversal node' });

export type MediaNodeMovie = z.infer<typeof MediaNodeMovieSchema>;

export const MediaNodeSeriesSchema = MediaNodeBaseSchema.extend({
    credits: PersonCreditsSchema.optional().describe(
        'Cast and crew with canonical person handles; unknown person id is null and images are omitted',
    ),
    seasonCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('seasonCount for the current catalog/user scope'),
    episodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('episodeCount for the current catalog/user scope'),
    availableEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('availableEpisodeCount for the current catalog/user scope'),
    watchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('watchedEpisodeCount for the current catalog/user scope'),
    unwatchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('unwatchedEpisodeCount for the current catalog/user scope'),

    /** Canonical discriminator — always 'series' (never 'tv' or 'show') */
    type: z.literal('series').describe('Canonical media type discriminant'),
    isAvailable: z.boolean().describe('Available in local library'),
    canRequest: z.boolean().describe('Can be requested via Jellyseerr'),
    seasons: MediaNodeLinkSchema.optional().describe("Link to this series' seasons list"),
    user: MediaNodeUserSchema.optional().describe('Per-user state (only with ?include=user)'),
    details: MediaNodeDetailsSchema.optional().describe(
        'Rich detail fields (only with ?include=details)',
    ),
}).meta({ id: 'MediaNodeSeries', description: 'Series traversal node (from GET /media/{id})' });

export type MediaNodeSeries = z.infer<typeof MediaNodeSeriesSchema>;

export const MediaNodeEpisodeSchema = MediaNodeBaseSchema.extend({
    /** Canonical discriminator — always 'episode' */
    type: z.literal('episode').describe('Canonical media type discriminant'),
    isAvailable: z.boolean().describe('Available in local library'),
    canRequest: z.boolean().describe('Can be requested via Jellyseerr'),
    seriesId: z.string().optional().describe('Internal UUID of the owning series'),
    seasonNumber: z.number().int().optional().describe('Season number'),
    episodeNumber: z.number().int().optional().describe('Episode number'),
    user: MediaNodeUserSchema.optional().describe('Per-user state (only with ?include=user)'),
}).meta({ id: 'MediaNodeEpisode', description: 'Episode traversal node' });

export type MediaNodeEpisode = z.infer<typeof MediaNodeEpisodeSchema>;

export const MediaNodeSeasonSchema = MediaNodeBaseSchema.extend({
    seasonCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('seasonCount for the current catalog/user scope'),
    episodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('episodeCount for the current catalog/user scope'),
    availableEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('availableEpisodeCount for the current catalog/user scope'),
    watchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('watchedEpisodeCount for the current catalog/user scope'),
    unwatchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('unwatchedEpisodeCount for the current catalog/user scope'),

    /** Canonical discriminator — always 'season' */
    type: z.literal('season').describe('Canonical media type discriminant'),
    isAvailable: z.boolean().describe('Available in local library'),
    canRequest: z.boolean().describe('Can be requested via Jellyseerr'),
    seriesId: z.string().optional().describe('Internal UUID of the owning series'),
    seasonNumber: z.number().int().optional().describe('Season number'),
    episodeNumber: z.number().int().optional().describe('Episode number'),
    user: MediaNodeUserSchema.optional().describe('Per-user state (only with ?include=user)'),
}).meta({ id: 'MediaNodeSeason', description: 'Season traversal node' });

export type MediaNodeSeason = z.infer<typeof MediaNodeSeasonSchema>;

/**
 * Audiobook traversal node.
 *
 * Audiobook-specific fields sit at the node's TOP LEVEL, not nested under
 * `details` like the movie/series rich block. That is deliberate: the composite
 * `media/{id}/context` endpoint the web modal uses calls `buildMediaDetail()`
 * with an EMPTY `include`, so anything nested under `details` never reaches the
 * modal on that path (see the note in use-modal-data's loadCompositeContext).
 * Author/narrator/chapters are not an opt-in expansion for a book — they are the
 * book's identity — so they ride the base node and cost one extra query for
 * audiobook rows only.
 */
export const MediaNodeAudiobookSchema = MediaNodeBaseSchema.extend({
    /** Canonical discriminator — always 'audiobook' */
    type: z.literal('audiobook').describe('Canonical media type discriminant'),
    isAvailable: z.boolean().describe('Playable in this install'),
    canRequest: z.boolean().describe('Can be requested via Jellyseerr (always false for books)'),
    user: MediaNodeUserSchema.optional().describe('Per-user state (only with ?include=user)'),
    ...AudiobookFieldsSchema.shape,
}).meta({ id: 'MediaNodeAudiobook', description: 'Audiobook traversal node' });

export type MediaNodeAudiobook = z.infer<typeof MediaNodeAudiobookSchema>;

/**
 * MediaNodeSchema — the actual response contract for GET /media/{id}
 * (buildMediaDetail() in defs/catalog/media-id.ts). Discriminated union of
 * the movie/series/episode/season/audiobook traversal-node shapes.
 *
 * ⚠️ Every `media_items.media_type` that `toPublicMediaType()` maps to a public
 * value needs a variant here. A missing variant does NOT fail loudly: mount()'s
 * conformance strip can't parse the body, logs once, and passes the ORIGINAL
 * through — which is how audiobook nodes appeared to "work" while every
 * audiobook-shaped field was silently absent from the wire.
 */
export const MediaNodeSchema = z
    .discriminatedUnion('type', [
        MediaNodeMovieSchema,
        MediaNodeSeriesSchema,
        MediaNodeEpisodeSchema,
        MediaNodeSeasonSchema,
        MediaNodeAudiobookSchema,
    ])
    .meta({
        id: 'MediaNode',
        description:
            'Polymorphic media traversal node — discriminated union of movie, series, episode, season, and audiobook (GET /media/{id})',
    });

export type MediaNode = z.infer<typeof MediaNodeSchema>;
