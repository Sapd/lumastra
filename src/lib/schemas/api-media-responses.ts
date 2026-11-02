// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Media Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for media-related API response types.
 * These schemas define the contract for /api/media-details, /api/media/[id],
 * /api/ai/similar, /api/trending, etc.
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
 * - TMDB types use snake_case for API compatibility
 */

import { FileLanguageSummarySchema } from './admin-language-summary.js';
import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import { z } from 'zod';
import { publicAuthorSchema } from './public-author';
import { ExternalIdsResponseSchema } from './api-responses';
import { ActorSchema, DirectorSchema } from './media-detail';
import { FILE_HEALTH_ISSUE_TYPES } from '$lib/types/pipeline.js';

// ============================================================================
// Media Ratings
// ============================================================================

/**
 * Common rating properties from various sources (MDBList, RT, IMDB, etc.)
 * Used by trending items, similar content, recommendations, etc.
 */
export const MediaRatingsSchema = z
    .object({
        /** Rotten Tomatoes critic score (0-100) */
        rtCritic: z.number().nullish().describe('Rotten Tomatoes critic score'),
        /** Rotten Tomatoes audience score (0-100) */
        rtAudience: z.number().nullish().describe('Rotten Tomatoes audience score'),
        /** IMDB rating (0-10) */
        imdbRating: z.number().nullish().describe('IMDB rating'),
        /** Letterboxd average rating (0-5) */
        letterboxdRating: z.number().nullish().describe('Letterboxd rating'),
        /** Letterboxd vote count */
        letterboxdVotes: z.number().nullish().describe('Letterboxd vote count'),
        /** MDBList aggregated score */
        mdblistScore: z.number().nullish().describe('MDBList score'),
        /** Metacritic score (0-100) */
        metacriticScore: z.number().nullish().describe('Metacritic score'),
        /** Trakt rating */
        traktScore: z.number().nullish().describe('Trakt score'),
        /** MyAnimeList score (0-10) */
        malScore: z.number().nullish().describe('MyAnimeList score'),
    })
    .meta({ id: 'MediaRatings', description: 'Ratings from various sources' });

export type MediaRatings = z.infer<typeof MediaRatingsSchema>;

// ============================================================================
// Media Details Response (/api/media-details)
// ============================================================================

/**
 * Detailed media information from the database.
 * Includes ratings from multiple sources (IMDB, RT, Letterboxd, etc.)
 */
export const MediaDetailsSchema = z
    .object({
        /** UUID from database (preferred identifier) */
        id: z.string().optional().describe('Internal UUID'),
        /** External IDs from various providers */
        externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
        /** Media title */
        title: z.string().describe('Media title'),
        /** Media type (MOVIE, SERIES, etc.) */
        mediaType: z.string().describe('Media type'),
        /** Release date */
        releaseDate: z.string().optional().describe('Release date'),
        /** Release year */
        year: z.number().optional().describe('Release year'),
        /** Overview/description */
        overview: z.string().optional().describe('Overview'),
        /** Original title (production language) */
        originalTitle: z.string().optional().describe('Original title'),
        /** English title (from TMDB translations, for international search) */
        englishTitle: z.string().optional().describe('English title'),
        /** Resolved artwork descriptors. */
        images: ImageSetSchema,
        /** YouTube trailer URL */
        trailerUrl: z.string().optional().describe('Trailer URL'),

        // Ratings from various sources
        /** Best available rating, normalized 0-10 */
        rating: z.number().optional().describe('Rating'),
        /** Source of primary rating */
        ratingSource: z.string().optional().describe('Rating source'),
        /** All ratings keyed by source name */
        ratings: z.record(z.string(), z.number()).optional().describe('All ratings'),
        /** IMDB rating (0-10) */
        imdbRating: z.number().optional().describe('IMDB rating'),
        /** Rotten Tomatoes critic score (0-100) */
        rtRating: z.number().optional().describe('Rotten Tomatoes critic score'),
        /** Rotten Tomatoes audience score (0-100) */
        rtAudienceRating: z.number().optional().describe('Rotten Tomatoes audience score'),
        /** TMDB rating (0-10) */
        tmdbRating: z.number().optional().describe('TMDB rating'),
        /** Letterboxd average rating (0-5) */
        letterboxdRating: z.number().optional().describe('Letterboxd rating'),
        /** Letterboxd vote count */
        letterboxdVotes: z.number().optional().describe('Letterboxd votes'),
        /** Metacritic score (0-100) */
        metacriticScore: z.number().optional().describe('Metacritic score'),
        /** Trakt rating */
        traktScore: z.number().optional().describe('Trakt score'),
        /** MDBList aggregated score */
        mdblistScore: z.number().optional().describe('MDBList score'),

        // Popularity and engagement
        /** Popularity score */
        popularity: z.coerce.number().optional().describe('Popularity score'),
        /** Vote count */
        voteCount: z.number().optional().describe('Vote count'),

        // Runtime
        /** Runtime in minutes */
        runtimeMinutes: z.number().optional().describe('Runtime in minutes'),
        /** Runtime in minutes (alias) */
        runtime: z.number().optional().describe('Runtime in minutes'),

        // Categorization
        /** Genre names */
        genres: z.array(z.string()).optional().describe('Genres'),
        /** Genre IDs */
        genreIds: z.array(z.number()).optional().describe('Genre IDs'),
        /** Keywords */
        keywords: z.array(z.string()).optional().describe('Keywords'),
        /** Networks (for TV shows) */
        networks: z.array(z.string()).optional().describe('Networks'),

        // People
        /** Cast members with character info */
        actors: z.array(ActorSchema).optional().describe('Actors'),
        /** Directors/crew members */
        directors: z.array(DirectorSchema).optional().describe('Directors'),

        // Content info
        /** Content rating/certification (PG-13, TV-MA, etc.) */
        certification: z.string().optional().describe('Content certification'),
        /** Audio language codes for the default file */
        audioLanguages: z
            .array(z.string())
            .optional()
            .describe('Audio language codes for the default file'),
        /** Subtitle language codes for the default file (embedded + sidecar) */
        subtitleLanguages: z
            .array(z.string())
            .optional()
            .describe('Subtitle language codes for the default file'),

        // Availability
        /** Whether the item is available in the library */
        isAvailable: z.boolean().describe('Available in library'),
        /** Whether the item can be requested */
        canRequest: z.boolean().describe('Can be requested'),

        // TV-specific fields (present when mediaType is 'tv')
        /** First air date (ISO 8601) */
        firstAirDate: z.string().optional().describe('First air date'),
        /** Last air date (ISO 8601) */
        lastAirDate: z.string().optional().describe('Last air date'),
        /** Series status (Continuing, Ended, Canceled, Planned) */
        status: z.string().optional().describe('Series status'),
        /** Number of seasons */
        seasonCount: z.number().optional().describe('Number of seasons'),
        /** Total episode count */
        episodeCount: z.number().optional().describe('Total episode count'),
        /** Series creators */
        creators: z.array(z.string()).optional().describe('Series creators'),

        // Episode context (when resolved from episode → series)
        /** Season number of the original episode (for auto-selecting in UI) */
        seasonNumber: z.number().optional().describe('Original episode season number'),
        /** Episode number of the original episode (for auto-selecting in UI) */
        episodeNumber: z.number().optional().describe('Original episode number'),
    })
    .meta({
        id: 'MediaDetails',
        description: 'Detailed media information from database',
    });

export type MediaDetails = z.infer<typeof MediaDetailsSchema>;

// ============================================================================
// Provider-neutral Detail Response schemas (/api/media/[id])
// ============================================================================

/**
 * Genre object for the media detail response.
 */
export const GenreSchema = z
    .object({
        /** Genre ID */
        id: z.number().describe('Genre ID'),
        /** Genre name */
        name: z.string().describe('Genre name'),
    })
    .meta({ id: 'Genre', description: 'Genre object' });

export type Genre = z.infer<typeof GenreSchema>;

/**
 * Cast member for the media detail response.
 */
export const CastMemberSchema = z
    .object({
        /** Person ID */
        id: z.number().optional().describe('Person ID'),
        /** Actor name */
        name: z.string().describe('Actor name'),
        /** Character name */
        character: z.string().optional().describe('Character name'),
        /** Profile image path */
        images: ImageSetSchema.optional().describe('Person profile artwork'),
        /** Order in credits */
        order: z.number().optional().describe('Credit order'),
    })
    .meta({ id: 'CastMember', description: 'Cast member' });

export type CastMember = z.infer<typeof CastMemberSchema>;

/**
 * Crew member for the media detail response.
 */
export const CrewMemberSchema = z
    .object({
        /** Person ID */
        id: z.number().optional().describe('Person ID'),
        /** Crew member name */
        name: z.string().describe('Crew member name'),
        /** Job title (Director, Producer, etc.) */
        job: z.string().describe('Job title'),
        /** Profile image path */
        images: ImageSetSchema.optional().describe('Person profile artwork'),
    })
    .meta({ id: 'CrewMember', description: 'Crew member' });

export type CrewMember = z.infer<typeof CrewMemberSchema>;

/**
 * Video (trailer) for the media detail response.
 */
export const MediaDetailVideoSchema = z
    .object({
        /** Video key (e.g. YouTube video ID) */
        key: z.string().describe('Video key'),
        /** Video site (YouTube, Vimeo, etc.) */
        site: z.string().describe('Video site'),
        /** Video type (Trailer, Teaser, etc.) */
        type: z.string().describe('Video type'),
        /** Whether this is an official video */
        official: z.boolean().optional().describe('Official video'),
    })
    .meta({ id: 'MediaDetailVideo', description: 'Video/trailer' });

export type MediaDetailVideo = z.infer<typeof MediaDetailVideoSchema>;

/**
 * Production country for the media detail response.
 */
export const ProductionCountrySchema = z
    .object({
        /** ISO 3166-1 country code */
        countryCode: z.string().describe('ISO 3166-1 country code'),
        /** Country name */
        name: z.string().describe('Country name'),
    })
    .meta({ id: 'ProductionCountry', description: 'Production country' });

export type ProductionCountry = z.infer<typeof ProductionCountrySchema>;

/**
 * Network (for TV shows) for the media detail response.
 */
export const NetworkSchema = z
    .object({
        /** Network ID */
        id: z.number().describe('Network ID'),
        /** Network name */
        name: z.string().describe('Network name'),
        /** Network logo path */
        logoPath: z.string().optional().describe('Logo path'),
    })
    .meta({ id: 'Network', description: 'Network' });

export type Network = z.infer<typeof NetworkSchema>;

/**
 * Provider-neutral media detail data.
 * Note: Some properties are movie-only or series-only.
 */
export const MediaDetailDataSchema = z
    .object({
        /** Internal or provider ID */
        id: z.number().describe('Media ID'),
        /** Media type (movie, series, etc.) */
        mediaType: z.string().describe('Media type'),
        /** Overview/description */
        overview: z.string().describe('Overview'),
        /** Resolved artwork descriptors. */
        images: ImageSetSchema,
        /** Vote average (rating) */
        voteAverage: z.number().describe('Vote average'),
        /** Vote count */
        voteCount: z.number().describe('Vote count'),
        /** Genres */
        genres: z.array(GenreSchema).describe('Genres'),
        /** Cast members (top-level, legacy; prefer credits.cast) */
        cast: z.array(CastMemberSchema).optional().describe('Cast members'),
        /** Crew members (top-level, legacy; prefer credits.crew) */
        crew: z.array(CrewMemberSchema).optional().describe('Crew members'),
        /** Credits object containing cast and crew */
        credits: z
            .object({
                cast: z.array(CastMemberSchema).optional(),
                crew: z.array(CrewMemberSchema).optional(),
            })
            .optional()
            .describe('Credits'),
        /** Production countries */
        productionCountries: z
            .array(ProductionCountrySchema)
            .optional()
            .describe('Production countries'),
        /** Videos (trailers, etc.) */
        videos: z
            .object({
                results: z.array(MediaDetailVideoSchema),
            })
            .optional()
            .describe('Videos'),

        /** Library item ID */
        libraryItemId: z.string().optional().describe('Library item ID'),
        /** Whether available in library */
        isAvailable: z.boolean().optional().describe('Available in library'),
        /** Content certification */
        certification: z.string().optional().describe('Content certification'),

        // Movie-specific fields
        /** Movie title */
        title: z.string().optional().describe('Movie title'),
        /** Release date */
        releaseDate: z.string().optional().describe('Release date'),
        /** Runtime in minutes */
        runtime: z.number().optional().describe('Runtime in minutes'),

        // Series-specific fields
        /** Series name */
        name: z.string().optional().describe('Series name'),
        /** First air date */
        firstAirDate: z.string().optional().describe('First air date'),
        /** Episode runtimes (array for varying lengths) */
        episodeRunTime: z.array(z.number()).optional().describe('Episode runtimes'),
        /** Networks */
        networks: z.array(NetworkSchema).optional().describe('Networks'),
    })
    .meta({ id: 'MediaDetailData', description: 'Provider-neutral media detail data' });

export type MediaDetailData = z.infer<typeof MediaDetailDataSchema>;

// ============================================================================
// TMDB-like Details Response (/api/media/[id])
// Note: These types use snake_case for compatibility with TMDB API format.
// @deprecated — use the provider-neutral equivalents above.
// ============================================================================

/**
 * Genre object as returned by TMDB/our TMDB-like API.
 * @deprecated Use {@link GenreSchema} instead.
 */
export const TmdbGenreSchema = GenreSchema.meta({
    id: 'TmdbGenre',
    description: 'TMDB genre object',
});

/** @deprecated Use {@link Genre} instead. */
export type TmdbGenre = Genre;

/**
 * Cast member as returned by TMDB/our TMDB-like API.
 * @deprecated Use {@link CastMemberSchema} instead.
 */
export const TmdbCastMemberSchema = z
    .object({
        /** Person ID */
        id: z.number().optional().describe('Person ID'),
        /** Actor name */
        name: z.string().describe('Actor name'),
        /** Character name */
        character: z.string().optional().describe('Character name'),
        /** Profile image path */
        profile_path: z.string().optional().describe('Profile image path'),
        /** Order in credits */
        order: z.number().optional().describe('Credit order'),
    })
    .meta({ id: 'TmdbCastMember', description: 'TMDB cast member' });

/** @deprecated Use {@link CastMember} instead. */
export type TmdbCastMember = z.infer<typeof TmdbCastMemberSchema>;

/**
 * Crew member as returned by TMDB/our TMDB-like API.
 * @deprecated Use {@link CrewMemberSchema} instead.
 */
export const TmdbCrewMemberSchema = z
    .object({
        /** Person ID */
        id: z.number().optional().describe('Person ID'),
        /** Crew member name */
        name: z.string().describe('Crew member name'),
        /** Job title (Director, Producer, etc.) */
        job: z.string().describe('Job title'),
        /** Profile image path */
        profile_path: z.string().optional().describe('Profile image path'),
    })
    .meta({ id: 'TmdbCrewMember', description: 'TMDB crew member' });

/** @deprecated Use {@link CrewMember} instead. */
export type TmdbCrewMember = z.infer<typeof TmdbCrewMemberSchema>;

/**
 * Video (trailer) as returned by TMDB/our TMDB-like API.
 * @deprecated Use {@link MediaDetailVideoSchema} instead.
 */
export const TmdbVideoSchema = MediaDetailVideoSchema.meta({
    id: 'TmdbVideo',
    description: 'TMDB video/trailer',
});

/** @deprecated Use {@link MediaDetailVideo} instead. */
export type TmdbVideo = MediaDetailVideo;

/**
 * Production country as returned by TMDB/our TMDB-like API.
 * @deprecated Use {@link ProductionCountrySchema} instead.
 */
export const TmdbProductionCountrySchema = z
    .object({
        /** ISO 3166-1 country code */
        iso_3166_1: z.string().describe('Country code'),
        /** Country name */
        name: z.string().describe('Country name'),
    })
    .meta({
        id: 'TmdbProductionCountry',
        description: 'TMDB production country',
    });

/** @deprecated Use {@link ProductionCountry} instead. */
export type TmdbProductionCountry = z.infer<typeof TmdbProductionCountrySchema>;

/**
 * Network (for TV shows) as returned by TMDB/our TMDB-like API.
 * @deprecated Use {@link NetworkSchema} instead.
 */
export const TmdbNetworkSchema = z
    .object({
        /** Network ID */
        id: z.number().describe('Network ID'),
        /** Network name */
        name: z.string().describe('Network name'),
        /** Network logo path */
        logo_path: z.string().optional().describe('Logo path'),
    })
    .meta({ id: 'TmdbNetwork', description: 'TMDB network' });

/** @deprecated Use {@link Network} instead. */
export type TmdbNetwork = z.infer<typeof TmdbNetworkSchema>;

/**
 * TMDB-like media details.
 * This uses snake_case to match TMDB API format that frontend expects.
 * Note: Some properties are movie-only or tv-only.
 * @deprecated Use {@link MediaDetailDataSchema} instead.
 */
export const TmdbMediaDataSchema = z
    .object({
        /** TMDB ID */
        id: z.number().describe('TMDB ID'),
        /** Media type (movie, tv, etc.) */
        media_type: z.string().describe('Media type'),
        /** Overview/description */
        overview: z.string().describe('Overview'),
        /** Resolved artwork descriptors. */
        images: ImageSetSchema,
        /** Vote average (rating) */
        vote_average: z.number().describe('Vote average'),
        /** Vote count */
        vote_count: z.number().describe('Vote count'),
        /** Genres */
        genres: z.array(TmdbGenreSchema).describe('Genres'),
        /** Cast members (deprecated, use credits.cast) */
        cast: z.array(TmdbCastMemberSchema).optional().describe('Cast members'),
        /** Crew members (deprecated, use credits.crew) */
        crew: z.array(TmdbCrewMemberSchema).optional().describe('Crew members'),
        /** Credits object containing cast and crew */
        credits: z
            .object({
                cast: z.array(TmdbCastMemberSchema).optional(),
                crew: z.array(TmdbCrewMemberSchema).optional(),
            })
            .optional()
            .describe('Credits'),
        /** Production countries */
        production_countries: z
            .array(TmdbProductionCountrySchema)
            .optional()
            .describe('Production countries'),
        /** Videos (trailers, etc.) */
        videos: z
            .object({
                results: z.array(TmdbVideoSchema),
            })
            .optional()
            .describe('Videos'),

        /** Whether available in library */
        is_available: z.boolean().optional().describe('Available in library'),
        /** Content certification */
        certification: z.string().optional().describe('Content certification'),

        // Movie-specific fields
        /** Movie title */
        title: z.string().optional().describe('Movie title'),
        /** Release date */
        release_date: z.string().optional().describe('Release date'),
        /** Runtime in minutes */
        runtime: z.number().optional().describe('Runtime in minutes'),

        // TV-specific fields
        /** TV show name */
        name: z.string().optional().describe('TV show name'),
        /** First air date */
        first_air_date: z.string().optional().describe('First air date'),
        /** Episode runtimes (array for varying lengths) */
        episode_run_time: z.array(z.number()).optional().describe('Episode runtimes'),
        /** Networks */
        networks: z.array(TmdbNetworkSchema).optional().describe('Networks'),
    })
    .meta({ id: 'TmdbMediaData', description: 'TMDB-like media details' });

/** @deprecated Use {@link MediaDetailData} instead. */
export type TmdbMediaData = z.infer<typeof TmdbMediaDataSchema>;

// ============================================================================
// Similar Content Response (/api/ai/similar/[id])
// ============================================================================

/**
 * Similar movie/show item with unified response format.
 * Uses proxy URLs for images and a flat ratings map.
 */
export const SimilarMediaItemSchema = z
    .object({
        /** Internal UUID or composite key */
        id: z.string().describe('Internal UUID or composite key'),
        /** External IDs from various providers */
        externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
        /** Media type */
        mediaType: z.enum(['movie', 'series']).describe('Media type'),
        /** Display title */
        title: z.string().describe('Display title'),
        /** Overview/description */
        overview: z.string().optional().describe('Overview'),
        /** Release year */
        year: z.number().int().optional().describe('Release year'),
        /** Resolved artwork descriptors. */
        images: ImageSetSchema,
        /** Best available rating (0-10 scale) */
        rating: z.number().min(0).max(10).optional().describe('Best available rating (0-10)'),
        /** Rating source (e.g., "imdb", "tmdb") */
        ratingSource: z.string().optional().describe('Rating source'),
        /** All available ratings from various sources */
        ratings: z
            .record(z.string(), z.number())
            .optional()
            .describe('All available ratings keyed by source'),
        /** Content is available in library */
        isAvailable: z.boolean().describe('Available in library'),
        /** Content can be requested via Jellyseerr */
        canRequest: z.boolean().describe('Can be requested'),
        /** Genres */
        genres: z.array(z.string()).optional().describe('Genres'),
        /** Vector similarity score (0-1) */
        similarity: z.number().min(0).max(1).describe('Similarity score'),
        /** User's rating for this item */
        userRating: z.number().optional().describe('User rating'),
    })
    .meta({
        id: 'SimilarMediaItem',
        description: 'Similar media item with ratings and availability',
    });

export type SimilarMediaItem = z.infer<typeof SimilarMediaItemSchema>;

// ============================================================================
// Social Activity Response (/api/social/watch-activity/[id])
// ============================================================================

/**
 * Social watch activity (friends who watched/rated this).
 */
export const SocialActivityItemSchema = z
    .object({
        author: publicAuthorSchema.describe('Public identity of the person'),
        /** Activity description */
        description: z.string().describe('Activity description'),
        /** Rating given (1-10) */
        rating: z.number().optional().describe('Rating'),
        /** How the rating was entered — 'quick' (semantic button/swipe) or 'stars' (precise) */
        ratingStyle: z.enum(['quick', 'stars']).optional().describe('How the rating was entered'),
        /** When the rating was given */
        ratedAt: z.string().optional().describe('Rating timestamp'),
        /** Whether this is watch-only (no rating) */
        watchedOnly: z.boolean().optional().describe('Watch without rating'),
        /** Watch progress for TV shows */
        progress: z
            .object({
                /** Number of episodes watched */
                episodesWatched: z.number().describe('Episodes watched'),
                /** Total number of episodes */
                totalEpisodes: z.number().describe('Total episodes'),
                /** Progress percentage */
                percentage: z.number().describe('Progress percentage'),
            })
            .optional()
            .describe('Watch progress'),
        /** Written review text (if this user has written a review) */
        review: z.string().optional().describe('Written review text'),
        /** UUID of the review annotation (needed to delete/edit it) */
        reviewId: z.string().optional().describe('Review annotation UUID'),
        /** True when this entry represents the current user's own review */
        isSelf: z.boolean().optional().describe('Current user own review'),

        // ------------------------------------------------------------------
        // Audiobook listening (design doc 2026-07-28-audiobook-social-design §4)
        //
        // Time-shaped siblings of `progress`, which is episode-shaped and cannot
        // express a position in a 15-40 hour book. All optional: absent on every
        // movie/TV row, and individually absent on a book that has no chapters
        // (129 of 1188 in the reference library) or no known duration.
        //
        // These are visible ONLY to the subject's designated trust circle — the
        // server applies `buildSocialVisibilityFilter` before a row is built. And
        // there is deliberately NO timestamp among them: the design doc forbids
        // clock times at every tier, so "when" is never on the wire, only "where".
        // ------------------------------------------------------------------

        /** Position in the book, ms. Absent when the person has not started it. */
        positionMs: z.number().optional().describe('Listening position in the book (ms)'),
        /** Total book duration, ms. Absent when neither the book nor the row knows it. */
        durationMs: z.number().optional().describe('Total audiobook duration (ms)'),
        /** Title of the chapter that position falls in. Shown plainly — no spoiler gating. */
        chapterTitle: z.string().optional().describe('Chapter the listener is in'),
        /** 0-BASED index of that chapter. Display as `chapterIndex + 1` of `chapterCount`. */
        chapterIndex: z.number().optional().describe('Zero-based index of the current chapter'),
        /** Number of chapters in the book. */
        chapterCount: z.number().optional().describe('Total chapters in the book'),
        /**
         * True when this person has finished the book at least once. Renders
         * distinctly — NOT as "100%, chapter 45" — and can be true together with a
         * position, which is a re-listen.
         */
        finished: z.boolean().optional().describe('Has finished the book at least once'),
        /** Server-derived 60-day display policy; exposes no completion timestamp. */
        recentlyFinished: z
            .boolean()
            .optional()
            .describe('Completion is recent enough for a timeline marker'),
        /** Times finished (`user_media_state.watch_count`), for "3× gehört". */
        timesFinished: z.number().optional().describe('Completed listen-throughs'),
        /** True when the viewer and this person both have the book in progress. */
        sharedListen: z.boolean().optional().describe('Viewer and this person are both listening'),
        /**
         * Chapters this person is ahead of the viewer; negative means behind, 0
         * means the same chapter. Only present alongside `sharedListen`, and only
         * when both positions resolve to a chapter.
         */
        chapterDelta: z.number().optional().describe('Chapters ahead of the viewer (signed)'),
        /**
         * Position difference to the viewer in ms, signed the same way. The
         * fallback for a book with no chapter list, where `chapterDelta` cannot
         * exist. A duration difference, not a clock time.
         */
        positionDeltaMs: z
            .number()
            .optional()
            .describe('Position difference to the viewer, ms (signed)'),
        /**
         * Calendar day (`YYYY-MM-DD`, server date) of this person's latest
         * listening on the book, for "2 days ago" and for sorting. A date, never
         * a clock time. Present only when BOTH this person and the viewer share
         * their listening activity — the reciprocal tier, the same rule as the
         * activity rail's `occurredOn`. Audiobooks only.
         */
        listenedOn: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional()
            .describe(
                'Day of latest listening (YYYY-MM-DD, no time); only when both sides share listening activity',
            ),
    })
    .meta({
        id: 'SocialActivityItem',
        description: 'Social watch activity item',
    });

export type SocialActivityItem = z.infer<typeof SocialActivityItemSchema>;

// ============================================================================
// Trending Item Response (/api/trending, /api/lists/[list_id])
// ============================================================================

/**
 * Trending/curated list item with ratings and metadata.
 */
export const TrendingItemSchema = MediaRatingsSchema.extend({
    /** UUID from database (preferred identifier) */
    id: z.string().optional().describe('Internal UUID'),
    /** External IDs from various providers */
    externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
    /** Media type */
    mediaType: z.enum(['movie', 'series']).describe('Media type'),
    /** Display title */
    title: z.string().describe('Display title'),
    /** Overview/description */
    overview: z.string().describe('Overview'),
    /** Genre IDs or names */
    genres: z.union([z.array(z.number()), z.array(z.string())]).describe('Genres'),
    /** Best available rating (0-10 scale) */
    rating: z.number().optional().describe('Best available rating (0-10)'),
    /** Source of primary rating */
    ratingSource: z.string().optional().describe('Rating source'),
    /** Whether this item is trending */
    trending: z.boolean().describe('Is trending'),
    /** Source of trending data */
    trendingSource: z.enum(['tmdb', 'jellyfin', 'mdblist']).describe('Trending source'),
    /** Popularity score */
    popularity: z.number().optional().describe('Popularity'),
    /** Local play count */
    localPlayCount: z.number().optional().describe('Local play count'),
    /** Rank position */
    rank: z.number().optional().describe('Rank'),
    /** Image URL */
    imageUrl: z.string().optional().describe('Image URL'),
    /** Whether available in library */
    isAvailable: z.boolean().describe('Available in library'),
    /** Whether item can be requested */
    canRequest: z.boolean().describe('Can be requested'),
    /** Release year */
    year: z.number().optional().describe('Release year'),
}).meta({ id: 'TrendingItem', description: 'Trending/curated list item' });

export type TrendingItem = z.infer<typeof TrendingItemSchema>;

// ============================================================================
// AI Recommendation Item Response (/api/recommendations)
// ============================================================================

/**
 * AI-powered recommendation item with similarity scores.
 */
export const RecommendationItemSchema = MediaRatingsSchema.extend({
    /** UUID from database (preferred identifier) */
    id: z.string().optional().describe('Internal UUID'),
    /** External IDs from various providers */
    externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
    /** Media type */
    mediaType: z.enum(['movie', 'series']).describe('Media type'),
    /** Display title */
    title: z.string().describe('Display title'),
    /** Overview/description */
    overview: z.string().describe('Overview'),
    /** Genre IDs */
    genres: z.array(z.number()).describe('Genre IDs'),
    /** Best available rating (0-10 scale) */
    rating: z.number().optional().describe('Best available rating (0-10)'),
    /** Source of primary rating */
    ratingSource: z.string().optional().describe('Rating source'),
    /** Whether this is an AI suggestion */
    aiSuggestion: z.boolean().describe('AI-generated suggestion'),
    /** AI-generated recommendation reason */
    aiReason: z.string().describe('Recommendation reason'),
    /** AI similarity score (formatted) */
    aiSimilarity: z.string().describe('Similarity score'),
    /** Whether item can be requested */
    canRequest: z.boolean().describe('Can be requested'),
    /** Whether available in library */
    isAvailable: z.boolean().describe('Available in library'),
    /** Availability source */
    availabilitySource: z.string().optional().describe('Availability source'),
    /** User's rating for this item */
    userRating: z.number().optional().describe('User rating'),
    /** When the user rated this */
    ratedAt: z.string().optional().describe('Rating timestamp'),
    /** Whether user has watched this */
    isWatched: z.boolean().optional().describe('Has been watched'),
}).meta({
    id: 'RecommendationItem',
    description: 'AI-powered recommendation item',
});

export type RecommendationItem = z.infer<typeof RecommendationItemSchema>;

// ============================================================================
// Movie Detail Response (/api/movie-details/[id])
// ============================================================================

/**
 * Movie detail response with user-specific fields.
 * Extends MediaDetailsSchema with user rating and watchlist status.
 */
export const MovieDetailResponseSchema = MediaDetailsSchema.extend({
    /** User's rating for this item */
    userRating: z.number().optional().describe('User rating'),
    /** Whether item is in user watchlist */
    isInWatchlist: z.boolean().optional().describe('In user watchlist'),
    /** Whether playback is currently available (media server reachable) */
    playbackAvailable: z.boolean().optional().describe('Whether playback is currently available'),
}).meta({
    id: 'MovieDetailResponse',
    description: 'Movie detail with user-specific fields',
});

export type MovieDetailResponse = z.infer<typeof MovieDetailResponseSchema>;

// ============================================================================
// Media Streams Response (GET /api/v1/media/{id}/streams)
// ============================================================================

/**
 * A single media stream row (video / audio / subtitle track).
 * Mirrors the MediaStreamRow shape produced by media-streams.queries.ts and
 * validated by StreamsResponseSchema in defs/admin/media/[id]/streams.ts.
 * Authored here so _openapi.ts files can import from $lib/schemas only.
 */
const MediaStreamRowSchema = z
    .object({
        id: z.string().describe('Stream row UUID'),
        file_id: z.string().describe('Parent file UUID'),
        stream_type: z.enum(['audio', 'video', 'subtitle']).describe('Track type'),
        stream_index: z.number().int().describe('Stream index within the file'),
        codec: z.string().describe('Codec name (e.g. h264, aac, ass)'),
        codec_tag: z.string().nullable().describe('Codec tag'),
        profile: z.string().nullable().describe('Codec profile'),
        level: z.number().nullable().describe('Codec level'),
        language: z.string().nullable().describe('BCP-47 language code'),
        display_title: z.string().nullable().describe('Human-readable track label'),
        title: z.string().nullable().describe('Track title from container metadata'),
        channels: z.number().nullable().describe('Audio channels (null for non-audio)'),
        channel_layout: z.string().nullable().describe('Channel layout string'),
        sample_rate: z.number().nullable().describe('Audio sample rate Hz'),
        width: z.number().nullable().describe('Video width px (null for non-video)'),
        height: z.number().nullable().describe('Video height px (null for non-video)'),
        bit_depth: z.number().nullable().describe('Bit depth'),
        video_range: z.string().nullable().describe('Video range (HDR/SDR)'),
        video_range_type: z.string().nullable().describe('Video range type'),
        color_space: z.string().nullable().describe('Color space'),
        aspect_ratio: z.string().nullable().describe('Display aspect ratio'),
        average_frame_rate: z.number().nullable().describe('Average frame rate'),
        is_anamorphic: z.boolean().nullable().describe('Anamorphic video flag'),
        is_external: z.boolean().nullable().describe('External subtitle flag'),
        is_text_subtitle: z.boolean().nullable().describe('Text-based subtitle flag'),
        bitrate: z.number().nullable().describe('Track bitrate bps'),
        is_default: z.boolean().describe('Default track flag'),
        is_forced: z.boolean().describe('Forced track flag'),
        dv_profile: z.number().nullable().describe('Dolby Vision profile'),
        dv_level: z.number().nullable().describe('Dolby Vision level'),
        dv_bl_signal_compatibility_id: z.number().nullable().describe('DV BL signal compat ID'),
        master_display: z.string().nullable().describe('HDR10 master display metadata'),
        max_cll: z.string().nullable().describe('HDR10 MaxCLL/MaxFALL'),
        pixel_format: z.string().nullable().describe('Pixel format'),
        ref_frames: z.number().nullable().describe('Reference frames'),
        color_primaries: z.string().nullable().describe('Color primaries'),
        color_transfer: z.string().nullable().describe('Color transfer characteristics'),
        created_at: z.union([z.string(), z.date()]).describe('Row creation timestamp'),
    })
    .meta({
        id: 'MediaStreamRow',
        description: 'One media stream (video/audio/subtitle) track row',
    });

/**
 * Response for GET /api/v1/media/{id}/streams.
 * Returns all stream (track) rows across every file version of the item
 * (or a single file when ?fileId=<uuid> is supplied).
 */
export const MediaStreamsResponseSchema = z
    .object({
        streams: z.array(MediaStreamRowSchema).describe('Stream track rows for the media item'),
    })
    .meta({
        id: 'MediaStreamsResponse',
        description: 'Media streams (video/audio/subtitle tracks) response',
    });

export type MediaStreamsResponse = z.infer<typeof MediaStreamsResponseSchema>;

// ============================================================================
// Media Rescan Response (POST /api/v1/media/{id}/rescan)
// ============================================================================

/**
 * Response for POST /api/v1/media/{id}/rescan.
 * Triggers on-demand Essentia audio analysis; returns the computed values
 * (or null when analysis produced no result for a field).
 * Mirrors RescanResponseSchema from defs/admin/media/[id]/rescan.ts.
 */
export const MediaRescanResponseSchema = z
    .object({
        /** Beats per minute (null if not computable) */
        bpm: z.number().nullable().describe('Beats per minute'),
        /** Musical key (e.g. "C major") */
        key: z.string().nullable().describe('Musical key'),
        /** Energy level 0–1 (Essentia); observed 0.11–0.96 */
        energy: z
            .number()
            .nullable()
            .describe(
                'Energy, 0-1. Essentia scale. Measured across 892 real tracks: min 0.112, median 0.398, max 0.955 — it does not span the full range, so normalise against your own pool rather than against 0-1 if you need spread.',
            ),
        /** Danceability on the Essentia 0–3 scale, NOT a 0–1 fraction; observed median 2.06 */
        danceability: z
            .number()
            .nullable()
            .describe(
                'Danceability on the Essentia 0-3 scale — NOT a 0-1 fraction, despite the name. Measured across 892 real tracks: min 0.166, MEDIAN 2.057, max 2.865. Clamping or normalising this to 0-1 pins most of the library at 1.0 and the term stops distinguishing anything, which fails silently.',
            ),
        /** Integrated loudness in LUFS */
        loudness_lufs: z.number().nullable().describe('Integrated loudness (LUFS)'),
    })
    .meta({
        id: 'MediaRescanResponse',
        description: 'Audio analysis result from Essentia (POST /api/v1/media/{id}/rescan)',
    });

export type MediaRescanResponse = z.infer<typeof MediaRescanResponseSchema>;

// ============================================================================
// Media Sync Response (POST /api/v1/media/{id}/sync)
// ============================================================================

/**
 * Inline sync result — returned when the item is synced immediately
 * (i.e. includeChildren=false or item is not a series).
 */
const MediaSyncInlineSchema = z.object({
    /** Whether the sync wrote any changes to the DB */
    updated: z.boolean().describe('Whether the sync wrote any DB changes'),
    /** DB field names that were changed */
    fieldsChanged: z.array(z.string()).describe('Fields updated during sync'),
});

/**
 * Queued sync result — returned when a series-sync job is enqueued
 * (i.e. includeChildren=true for a series item).
 */
const MediaSyncQueuedSchema = z.object({
    /** Always true when a job was enqueued */
    started: z.boolean().describe('Whether the sync job was enqueued'),
    /** Orchestrator run ID for the enqueued series-sync run */
    runId: z.string().describe('Run ID of the enqueued series-sync run'),
});

/**
 * Response for POST /api/v1/media/{id}/sync.
 * Returns either an inline sync result (single item) or a queued-job ack
 * (series with children). Discriminated by the presence of `started`/`runId`
 * vs `updated`/`fieldsChanged`.
 */
export const MediaSyncResponseSchema = z
    .union([MediaSyncInlineSchema, MediaSyncQueuedSchema])
    .meta({
        id: 'MediaSyncResponse',
        description:
            'POST /api/v1/media/{id}/sync: inline result (updated+fieldsChanged) ' +
            'or queued-run ack (started+runId)',
    });

export type MediaSyncResponse = z.infer<typeof MediaSyncResponseSchema>;

// ============================================================================
// Media Chapters Response (GET /api/v1/media/{id}/chapters)
// ============================================================================

/**
 * One stored chapter marker row (EpisodeChapterRow).
 * Mirrors EpisodeChapterRowSchema in defs/admin/media/[id]/chapters/index.ts.
 */
const EpisodeChapterRowSchema = z
    .object({
        id: z.number().int().describe('Chapter row ID'),
        file_id: z.string().describe('Parent file UUID'),
        media_item_id: z.string().nullable().describe('Owning media item UUID'),
        chapter_index: z.number().int().describe('Chapter ordinal within the file'),
        chapter_name: z.string().nullable().describe('Chapter name/title'),
        startMs: z.number().int().describe('Chapter start in milliseconds'),
        endMs: z.number().int().nullable().describe('Chapter end in milliseconds'),
        source: z.string().describe('Source of the chapter data'),
        fetched_at: z.union([z.string(), z.date()]).describe('When the chapter data was fetched'),
    })
    .meta({ id: 'EpisodeChapterRow', description: 'Stored chapter marker row' });

/**
 * Response for GET /api/v1/media/{id}/chapters.
 * Mirrors ChaptersResponseSchema in defs/admin/media/[id]/chapters/index.ts —
 * the admin media-chapters handler returns the stored chapter rows for the item
 * (or all chapters grouped by episode for a series) plus a count of episodes
 * that have chapters. NOTE: distinct from the playback ChaptersResponseSchema
 * (runtime/skip-segments) used by /api/playback/{itemId}/chapters.
 */
export const MediaChaptersResponseSchema = z
    .object({
        chapters: z.array(EpisodeChapterRowSchema).describe('Stored chapter marker rows'),
        episodesWithChapters: z
            .number()
            .int()
            .nonnegative()
            .describe('Number of episodes that have chapters'),
    })
    .meta({
        id: 'MediaChaptersResponse',
        description: 'Stored chapter markers for a media item (admin media-chapters surface)',
    });

export type MediaChaptersResponse = z.infer<typeof MediaChaptersResponseSchema>;

// ============================================================================
// Media Files Response (GET /api/v1/media/{id}/files)
// ============================================================================

/**
 * File health issue entry attached to a media file row.
 * Admin projections use AdminFileHealthIssueSchema in schemas/admin-file-health.ts.
 */
export const FileHealthIssueSchema = z
    .object({
        // Derived from the canonical list rather than re-typed: this schema
        // gates the /api/admin/media/{id}/files and /api/v1/... responses, so a
        // hand-copied enum that lags the writer rejects rows for a file that has
        // a NEW issue type — precisely the file the caller needs to see.
        type: z.enum(FILE_HEALTH_ISSUE_TYPES).describe('Health issue type'),
        basis: z
            .enum(['duration_comparison', 'premature_eof'])
            .optional()
            .describe(
                'Whether a duration warning is a comparison or positively observed premature EOF',
            ),
        detected_at: z.string().describe('When the issue was detected (ISO 8601)'),
        attempt_count: z.number().int().nonnegative().optional().describe('Retry attempt count'),
        next_retry_at: z.string().optional().describe('Next scheduled retry (ISO 8601)'),
        detail: z.string().optional().describe('Human-readable detail'),
        expected_duration: z.number().optional().describe('Expected duration (seconds)'),
        actual_duration: z.number().optional().describe('Actual probed duration (seconds)'),
        file_duration: z.number().optional().describe('File-reported duration (seconds)'),
        tmdb_duration: z.number().optional().describe('TMDB-reported duration (seconds)'),
    })
    .meta({ id: 'FileHealthIssue', description: 'File health issue' });

/**
 * Base media file row (no child-context columns).
 * Mirrors BaseFileRowSchema in defs/admin/media/[id]/files.ts.
 */
const BaseFileRowSchema = z
    .object({
        id: z.string().describe('File UUID'),
        file_path: z.string().describe('Absolute file path'),
        language_summary: FileLanguageSummarySchema.optional(),
        edition: z.string().nullable().describe('Edition label'),
        part_number: z.number().nullable().describe('Multi-part part number'),
        library_group_id: z.string().nullable().describe('Library group UUID'),
        created_at: z.string().describe('Row creation timestamp'),
        media_item_id: z.string().describe('Owning media item UUID'),
        file_size_bytes: z.string().nullable().describe('File size in bytes (bigint as string)'),
        duration_seconds: z.number().nullable().describe('Duration in seconds'),
        container_format: z.string().nullable().describe('Container format'),
        file_mtime: z.string().nullable().describe('Filesystem mtime'),
        file_hash_head: z.string().nullable().describe('Head-bytes hash'),
        probed_at: z.string().nullable().describe('When the file was last probed'),
        health_issues: z.array(FileHealthIssueSchema).nullable().describe('Detected health issues'),
        is_default: z.boolean().describe('Default file flag for the item'),
        file_sort_order: z.number().int().describe('Sort order within the item'),
        file_label: z.string().nullable().describe('File label'),
    })
    .meta({ id: 'MediaFileRow', description: 'Base media file row' });

/**
 * Media file row with descendant child context — returned (alongside base rows)
 * when ?children=true is requested. Adds the owning item's title/type/position.
 * Mirrors FileRowWithChildrenSchema in defs/admin/media/[id]/files.ts.
 */
const FileRowWithChildrenSchema = BaseFileRowSchema.extend({
    media_title: z.string().nullable().describe('Owning media item title'),
    media_type: z.string().describe('Owning media item type'),
    season_number: z.number().nullable().describe('Season number (when episode/season)'),
    episode_number: z.number().nullable().describe('Episode number (when episode)'),
}).meta({ id: 'MediaFileRowWithChildren', description: 'Media file row with child media context' });

/**
 * Response for GET /api/v1/media/{id}/files.
 * Mirrors FilesResponseSchema in defs/admin/media/[id]/files.ts — the handler
 * returns base file rows for the item, or a union of base + child-context rows
 * when ?children=true traverses descendant seasons/episodes.
 */
export const MediaFilesResponseSchema = z
    .object({
        files: z
            .array(z.union([FileRowWithChildrenSchema, BaseFileRowSchema]))
            .describe('File rows attached to the media item (and descendants when children=true)'),
    })
    .meta({ id: 'MediaFilesResponse', description: 'Media files list' });

export type MediaFilesResponse = z.infer<typeof MediaFilesResponseSchema>;

// ============================================================================
// Media External IDs Responses (/api/v1/media/{id}/external-ids)
// ============================================================================

/**
 * One provider external-ID entry for a media item.
 * Mirrors ExternalIdRowSchema in defs/admin/media/[id]/external-ids.ts.
 */
const ExternalIdRowSchema = z
    .object({
        id: z.string().describe('External-ID row identifier'),
        external_id: z.string().describe('Provider external ID value'),
        provider: z.string().describe('Provider name (tmdb, imdb, …)'),
        is_primary: z.boolean().nullable().describe('Whether this is the primary ID for the item'),
    })
    .meta({ id: 'ExternalIdRow', description: 'Provider external ID entry' });

/**
 * GET response for /api/v1/media/{id}/external-ids.
 * Mirrors ExternalIdsGetResponseSchema in defs/admin/media/[id]/external-ids.ts.
 */
export const ExternalIdsGetResponseSchema = z
    .object({
        externalIds: z
            .array(ExternalIdRowSchema)
            .describe('All external provider IDs for the item'),
    })
    .meta({ id: 'ExternalIdsGetResponse', description: 'External IDs for a media item' });

export type ExternalIdsGetResponse = z.infer<typeof ExternalIdsGetResponseSchema>;

/**
 * PUT (upsert) response for /api/v1/media/{id}/external-ids.
 * Mirrors ExternalIdMutateResponseSchema in defs/admin/media/[id]/external-ids.ts.
 */
export const ExternalIdMutateResponseSchema = z
    .object({
        updated: z.boolean().describe('Whether the external ID was upserted'),
    })
    .meta({ id: 'ExternalIdMutateResponse', description: 'External ID upsert result' });

export type ExternalIdMutateResponse = z.infer<typeof ExternalIdMutateResponseSchema>;

/**
 * DELETE response for /api/v1/media/{id}/external-ids.
 * Mirrors ExternalIdDeleteResponseSchema in defs/admin/media/[id]/external-ids.ts.
 */
export const ExternalIdDeleteResponseSchema = z
    .object({
        deleted: z.boolean().describe('Whether the external ID was removed'),
    })
    .meta({ id: 'ExternalIdDeleteResponse', description: 'External ID deleted' });

export type ExternalIdDeleteResponse = z.infer<typeof ExternalIdDeleteResponseSchema>;

// ============================================================================
// Media Health Response (GET /api/v1/media/{id}/health)
// ============================================================================

/**
 * Response for GET /api/v1/media/{id}/health.
 * Mirrors HealthGetResponseSchema in defs/admin/media/[id]/health/index.ts —
 * a cached series health report (null when not yet computed). `computed` is the
 * literal false because GET never recomputes (POST /health/analyze does that).
 */
export const MediaHealthResponseSchema = z
    .object({
        report: z
            .object({
                computed: z.literal(false).describe('Always false — GET never recomputes'),
                status: z.string().describe('Health status'),
                episodeCountLocal: z.number().int().describe('Local episode count'),
                episodeCountProvider: z.number().int().describe('Provider episode count'),
                seasonCountLocal: z.number().int().describe('Local season count'),
                seasonCountProvider: z.number().int().describe('Provider season count'),
                seasonComparisons: z.array(z.unknown()).describe('Per-season comparison entries'),
                mismatchedSeasons: z.array(z.unknown()).describe('Mismatched seasons'),
                suggestedGroupId: z.string().nullable().describe('Suggested ordering group ID'),
                suggestedGroupName: z
                    .null()
                    .describe('Suggested ordering group name (always null)'),
                suggestedConfidence: z
                    .number()
                    .nullable()
                    .describe('Suggested ordering confidence'),
                groupScores: z.array(z.unknown()).describe('Ordering group scores'),
                chaptersAvailable: z.number().int().describe('Episodes with chapters'),
                orderingHealth: z
                    .object({
                        isActive: z.boolean().describe('Whether a non-standard ordering is active'),
                        orderingType: z.string().nullable().describe('Ordering type'),
                        provider: z.string().nullable().describe('Ordering provider'),
                        groupId: z.string().nullable().describe('Ordering group ID'),
                        linked: z.number().int().describe('Linked episode count'),
                        unlinked: z.number().int().describe('Unlinked episode count'),
                        total: z.number().int().describe('Total ordering entries'),
                        linkRatio: z.number().describe('Linked / total ratio'),
                    })
                    .nullable()
                    .describe('Episode-ordering health (null when no non-standard ordering)'),
            })
            .nullable()
            .describe('Cached health report (null when not yet computed)'),
    })
    .meta({ id: 'MediaHealthResponse', description: 'Media health GET response' });

export type MediaHealthResponse = z.infer<typeof MediaHealthResponseSchema>;

// ============================================================================
// Media Metadata Responses (/api/v1/media/{id}/metadata)
// ============================================================================

/**
 * GET response for /api/v1/media/{id}/metadata.
 * Mirrors MetadataGetResponseSchema in defs/admin/media/[id]/metadata.ts —
 * `custom_metadata` is a freeform JSONB key→value map (no fixed schema).
 */
export const MediaMetadataGetResponseSchema = z
    .object({
        undoIds: z
            .object({ chapters: z.uuid().optional(), lyrics: z.uuid().optional() })
            .optional()
            .describe('Guarded recovery receipts for curated chapter and lyric content.'),
        custom_metadata: z
            .record(z.string(), z.unknown())
            .describe('Freeform custom metadata key→value map'),
    })
    .meta({ id: 'MediaMetadataGetResponse', description: 'Custom metadata key-value map' });

export type MediaMetadataGetResponse = z.infer<typeof MediaMetadataGetResponseSchema>;

/**
 * PATCH response for /api/v1/media/{id}/metadata.
 * Mirrors MetadataPatchResponseSchema in defs/admin/media/[id]/metadata.ts.
 */
export const MediaMetadataPatchResponseSchema = z
    .object({
        updated: z.boolean().describe('Whether the metadata was updated'),
        undoId: z.uuid().optional().describe('Receipt for restoring the prior curated output.'),
    })
    .meta({ id: 'MediaMetadataPatchResponse', description: 'Metadata patch result' });

export type MediaMetadataPatchResponse = z.infer<typeof MediaMetadataPatchResponseSchema>;

// ============================================================================
// Media Pipeline Responses (/api/v1/media/{id}/pipeline)
// ============================================================================

const StageStatusSchema = z
    .enum([
        'pending',
        'running',
        'completed',
        'failed_transient',
        'failed_permanent',
        'skipped_permanent',
        'skipped_transient',
        'obsolete',
    ])
    .meta({ id: 'StageStatus', description: 'Processing pipeline stage status' });

/**
 * Stage-level error detail attached to a pipeline stage row.
 * Mirrors StageErrorDetailSchema in defs/admin/media/[id]/pipeline/index.ts.
 */
const StageErrorDetailSchema = z
    .object({
        message: z.string().describe('Error message'),
        code: z.string().optional().describe('Error code'),
        retryable: z.boolean().optional().describe('Whether the error is retryable'),
        plugin_id: z.string().optional().describe('Originating plugin ID'),
        kind: z
            .enum(['transient', 'permanent', 'fatal'])
            .optional()
            .describe(
                "The classifier's actual verdict. `retryable` cannot distinguish " +
                    'permanent from fatal, so grouping dead letters by verdict needs this.',
            ),
        status: z
            .number()
            .int()
            .optional()
            .describe('Upstream HTTP status, when the thrown error carried one'),
        decidedBy: z
            .enum([
                'task-error-kind',
                'retryable-flag',
                'classifier',
                'classifier-threw',
                'default',
            ])
            .optional()
            .describe(
                'Which rule produced `kind`. `default` means no rule matched and the ' +
                    'fallback decided — otherwise indistinguishable from a rule that ' +
                    'deliberately chose that verdict.',
            ),
    })
    .meta({ id: 'StageErrorDetail', description: 'Stage error detail' });

/**
 * One processing-pipeline stage-state row.
 * Mirrors StageStateRowSchema in defs/admin/media/[id]/pipeline/index.ts.
 */
const StageStateRowSchema = z
    .object({
        media_item_id: z.string().describe('Owning media item UUID'),
        stage_id: z.string().describe('Stage identifier'),
        processing_version: z.number().int().describe('Processing version'),
        status: StageStatusSchema.describe('Stage status'),
        attempt: z.number().int().describe('Attempt count'),
        last_run_id: z.string().nullable().describe('Last run UUID'),
        last_error: StageErrorDetailSchema.nullable().describe('Last error detail'),
        skipped_reason: z.string().nullable().describe('Reason the stage was skipped'),
        started_at: z.union([z.string(), z.date()]).nullable().describe('Stage start timestamp'),
        completed_at: z
            .union([z.string(), z.date()])
            .nullable()
            .describe('Stage completion timestamp'),
        next_eligible_at: z
            .union([z.string(), z.date()])
            .nullable()
            .describe('Next eligible retry timestamp'),
        updated_at: z.union([z.string(), z.date()]).describe('Row update timestamp'),
    })
    .meta({ id: 'StageStateRow', description: 'Processing pipeline stage state' });

/**
 * Stage count summary in the pipeline response.
 * Mirrors PipelineSummarySchema in defs/admin/media/[id]/pipeline/index.ts.
 */
const PipelineSummarySchema = z
    .object({
        total: z.number().int().nonnegative().describe('Total stage count'),
        completed: z.number().int().nonnegative().describe('Completed stages'),
        in_progress: z.number().int().nonnegative().describe('Running stages'),
        failed: z.number().int().nonnegative().describe('Failed stages'),
        pending: z.number().int().nonnegative().describe('Pending stages'),
        obsolete: z.number().int().nonnegative().describe('Obsolete stages'),
        skipped: z.number().int().nonnegative().describe('Skipped stages'),
    })
    .meta({ id: 'PipelineSummary', description: 'Stage count summary' });

/**
 * GET response for /api/v1/media/{id}/pipeline.
 * Mirrors PipelineGetResponseSchema in defs/admin/media/[id]/pipeline/index.ts.
 */
export const MediaPipelineGetResponseSchema = z
    .object({
        rows: z.array(StageStateRowSchema).describe('Pipeline stage-state rows'),
        summary: PipelineSummarySchema.describe('Stage count summary'),
    })
    .meta({ id: 'MediaPipelineGetResponse', description: 'Media processing pipeline state' });

export type MediaPipelineGetResponse = z.infer<typeof MediaPipelineGetResponseSchema>;

/**
 * POST (reset) response for /api/v1/media/{id}/pipeline.
 * Mirrors PipelineResetResponseSchema in defs/admin/media/[id]/pipeline/index.ts.
 */
export const MediaPipelineResetResponseSchema = z
    .object({
        reset: z.number().int().nonnegative().describe('Number of stages reset'),
    })
    .meta({ id: 'MediaPipelineResetResponse', description: 'Number of pipeline stages reset' });

export type MediaPipelineResetResponse = z.infer<typeof MediaPipelineResetResponseSchema>;
