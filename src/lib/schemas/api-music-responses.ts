// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { ImageSetSchema } from './api-image-descriptor.js';
/**
 * Music API Response Zod Schemas
 *
 * Bare-object response schemas for the public music API.
 * No success/timestamp envelope — all responses are plain objects.
 *
 * Convention:
 * - All schemas have .meta({ id: '...' })
 * - Use .optional() not .nullable()
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { PageBlockSchema } from './pagination';
import {
    ArtistSchema,
    ArtistSummarySchema,
    AlbumSchema,
    AlbumSummarySchema,
    TrackSchema,
} from './api-music-dto';
import { MusicTrackSchema, LyricsSchema, SyncedLyricLineSchema } from './music';
import { RadioNowPlayingSchema, RadioStationApiItemSchema } from './radio';
import { PageSectionSchema, UniversalMediaItemSchema } from './api-responses';

export const MusicArtistRowSchema = ArtistSchema;

export type MusicArtistRow = z.infer<typeof MusicArtistRowSchema>;

/**
 * Minimal artist projection for the music hover card.
 *
 * Deliberately much smaller than {@link MusicArtistRowSchema}: the hover card
 * fires on a 150ms delay, so the detail route's full discography + track list +
 * popularity joins are far too heavy for it.
 */
export const MusicArtistSummarySchema = ArtistSummarySchema;

export type MusicArtistSummary = z.infer<typeof MusicArtistSummarySchema>;

/** Minimal album projection for the music hover card. See {@link MusicArtistSummarySchema}. */
export const MusicAlbumSummarySchema = AlbumSummarySchema;

export type MusicAlbumSummary = z.infer<typeof MusicAlbumSummarySchema>;

export const MusicAlbumRowSchema = AlbumSchema;

export type MusicAlbumRow = z.infer<typeof MusicAlbumRowSchema>;

export const MusicTrackRowSchema = TrackSchema;

export type MusicTrackRow = z.infer<typeof MusicTrackRowSchema>;

export const ArtistTrackRowSchema = TrackSchema;

export type ArtistTrackRow = z.infer<typeof ArtistTrackRowSchema>;

// ============================================================================
// Album Responses
// ============================================================================

/**
 * Response: Browse/filter albums
 */
/**
 * Page block for the music browse collections.
 *
 * `total` is OPT-IN — present only when the caller passes `?includeTotal=1`, so
 * an infinite-scroll client never pays for a COUNT on every page. Clients must
 * treat it as optional and fall back to `hasMore`.
 */
const MusicBrowsePageSchema = z.object({
    limit: z.number().int(),
    offset: z.number().int(),
    hasMore: z.boolean(),
    total: z
        .number()
        .int()
        .optional()
        .meta({ description: 'Total matching items. Present only with ?includeTotal=1.' }),
});

export const MusicAlbumsResponseSchema = z
    .object({
        items: z.array(AlbumSummarySchema),
        page: MusicBrowsePageSchema,
    })
    .meta({ id: 'MusicAlbumsResponse' });

export type MusicAlbumsResponse = z.infer<typeof MusicAlbumsResponseSchema>;

/**
 * Response: Album detail with track list
 */
export const MusicAlbumDetailResponseSchema = AlbumSchema.extend({
    tracks: z.array(TrackSchema),
}).meta({ id: 'MusicAlbumDetailResponse' });

export type MusicAlbumDetailResponse = z.infer<typeof MusicAlbumDetailResponseSchema>;

// ============================================================================
// Artist Responses
// ============================================================================

/**
 * Response: Browse artists
 */
export const MusicArtistsResponseSchema = z
    .object({
        items: z.array(ArtistSummarySchema),
        page: MusicBrowsePageSchema,
    })
    .meta({ id: 'MusicArtistsResponse' });

export type MusicArtistsResponse = z.infer<typeof MusicArtistsResponseSchema>;

// ============================================================================
// Flat track browse
// ============================================================================

/** Browse tracks extend the shared public DTO with the library-added timestamp. */
export const MusicBrowseTrackRowSchema = TrackSchema.extend({
    addedAt: z.string().nullable(),
});

export type MusicBrowseTrackRow = z.infer<typeof MusicBrowseTrackRowSchema>;

/**
 * Response: browse the library's tracks.
 */
export const MusicTracksResponseSchema = z
    .object({
        items: z.array(MusicBrowseTrackRowSchema),
        page: MusicBrowsePageSchema,
    })
    .meta({ id: 'MusicTracksResponse' });

export type MusicTracksResponse = z.infer<typeof MusicTracksResponseSchema>;

/**
 * Response: Artist detail with discography
 */
export const MusicArtistDetailResponseSchema = ArtistSchema.extend({
    albums: z.array(AlbumSummarySchema),
    tracks: z.array(TrackSchema),
}).meta({ id: 'MusicArtistDetailResponse' });

export type MusicArtistDetailResponse = z.infer<typeof MusicArtistDetailResponseSchema>;

// ============================================================================
// Track Responses
// ============================================================================

/**
 * Per-track user context: server-authoritative state specific to the
 * requesting user. Separate from `track` so track data stays cacheable
 * and reusable across users.
 */
export const MusicTrackUserContextSchema = z
    .object({
        /** Explicit user feedback derived from `user_ratings.rating`. */
        feedback: z.enum(['liked', 'disliked']).nullable(),
    })
    .meta({ id: 'MusicTrackUserContext' });

export type MusicTrackUserContext = z.infer<typeof MusicTrackUserContextSchema>;

/**
 * Response: Track detail with audio features and per-user context.
 */
export const MusicTrackDetailResponseSchema = z
    .object({
        track: MusicTrackSchema,
        userContext: MusicTrackUserContextSchema,
    })
    .meta({ id: 'MusicTrackDetailResponse' });

export type MusicTrackDetailResponse = z.infer<typeof MusicTrackDetailResponseSchema>;

// ============================================================================
// Recommendations (POST /api/music/recommendations)
// ============================================================================

/**
 * Optional bias for a recommendation call. The value lives in the field its
 * `type` implies; every arm requires its own field, so a wrong shape is a 422
 * instead of a silent no-op.
 */
export const MusicRecommendationSeedSchema = z
    .discriminatedUnion('type', [
        z.object({
            type: z.literal('mood'),
            mood: z.string().min(1).max(64).meta({
                description:
                    'Bare mood key from `GET /api/v1/music/moods` (e.g. `chill`). A key the server does not know is not an error: the pick falls back to taste alone. The only seed that reaches retrieval on the sonic path.',
            }),
        }),
        z.object({
            type: z.literal('genre'),
            genre: z.string().min(1).max(128).meta({
                description:
                    'Genre name, e.g. `Trance`. Biases the metadata path only and switches off the listening-streak signal; needs `currentTrackId`.',
            }),
        }),
        z.object({
            type: z.literal('artist'),
            id: z.string().guid().meta({
                description:
                    'Artist id. Biases the metadata path only and switches off the listening-streak signal; needs `currentTrackId`.',
            }),
        }),
        z.object({
            type: z.literal('album'),
            id: z.string().guid().meta({
                description:
                    'Album id. Biases the metadata path only and switches off the listening-streak signal; needs `currentTrackId`.',
            }),
        }),
    ])
    .meta({ id: 'MusicRecommendationSeed' });

export type MusicRecommendationSeed = z.infer<typeof MusicRecommendationSeedSchema>;

const RecommendationIdListSchema = z.array(z.string().guid()).max(200);

export const MusicRecommendationContextSchema = z
    .object({
        currentTrackId: z.string().guid().optional().meta({
            description:
                'The track playing now. Required unless the seed is a `mood` seed (cold start).',
        }),
        history: RecommendationIdListSchema.optional().meta({
            description:
                'Track ids already played this session, newest first (index 0 = most recent play, last = session origin). At most 200.',
        }),
        skipped: RecommendationIdListSchema.optional().meta({
            description: 'Track ids the listener skipped this session. At most 200.',
        }),
        exclude: RecommendationIdListSchema.optional().meta({
            description:
                'Track ids that must never be returned, e.g. tracks already in the queue. At most 200.',
        }),
        upcoming: RecommendationIdListSchema.optional().meta({
            description:
                'Tracks that shape the taste centroid together with the current track, most relevant first: tracks the listener queued after it and/or recently played ones. Only the first four are used. Do not include autoplay picks that have not been played: they would reinforce the server\u2019s own suggestions.',
        }),
        crossfade: z.boolean().optional().meta({
            description:
                'Whether the client crossfades between tracks. `false` (hard cut) disables the BPM/key blend tiebreak; energy continuity still applies. Absent = true.',
        }),
        startedBy: z.enum(['user', 'autoplay']).optional().meta({
            description:
                'How the current track started. `user` (explicit pick) makes the current track dominate the taste centroid and halves the pull of the listener\u2019s overall taste; `autoplay` or absent keeps the default blend.',
        }),
    })
    .meta({ id: 'MusicRecommendationContext' });

export type MusicRecommendationContext = z.infer<typeof MusicRecommendationContextSchema>;

export const MusicRecommendationsRequestSchema = z
    .object({
        seed: MusicRecommendationSeedSchema.optional(),
        context: MusicRecommendationContextSchema.optional(),
    })
    .meta({ id: 'MusicRecommendationsRequest' });

export type MusicRecommendationsRequest = z.infer<typeof MusicRecommendationsRequestSchema>;

export const MusicRecommendationsResponseSchema = z
    .object({
        /**
         * Optional, never null: the generator emits a bare `$ref` for a nullable
         * object, so a `null` was documented as a non-nullable track.
         */
        next: MusicTrackSchema.optional().meta({
            description: 'What to play next. Absent when nothing fits.',
        }),
        alternatives: z.array(MusicTrackSchema).max(3).meta({
            description: 'Up to 3 other good picks. Never contains `next`.',
        }),
        source: z.enum(['sonic', 'metadata', 'fallback', 'mood']).meta({
            description:
                '`sonic`: ranked by audio embeddings. `metadata`: text embedding plus audio features. `fallback`: no embeddings matched, popularity/genre pick. `mood`: cold start, `next` is the first track of a mood radio and `alternatives` is empty.',
        }),
    })
    .meta({ id: 'MusicRecommendationsResponse' });

export type MusicRecommendationsResponse = z.infer<typeof MusicRecommendationsResponseSchema>;

// ============================================================================
// Radio Responses
// ============================================================================

/**
 * Response: Internet radio stations list
 *
 * Shape: { items, page } collection envelope — no legacy {stations:[]} wrapper.
 * Each item carries type:'radio', name, images{} (self-describing hrefs) and
 * optional genre/nowPlaying from custom_metadata. The upstream stream URL is
 * intentionally absent — clients play via /api/music/radio/{id}/stream.
 *
 * Empty collection ({ items:[], page:{...} }) is returned when radio is not
 * configured or all stations are filtered by access scoping — never 404.
 */
export const RadioStationsResponseSchema = z
    .object({
        items: z.array(RadioStationApiItemSchema),
        page: z.object({
            limit: z.number().int(),
            offset: z.number().int(),
            hasMore: z.boolean(),
            total: z.number().int().optional(),
        }),
    })
    .meta({ id: 'RadioStationsResponse' });

export type RadioStationsResponse = z.infer<typeof RadioStationsResponseSchema>;

/**
 * Response: Now-playing info for an internet radio station.
 * Bare RadioNowPlaying object — no envelope wrapper.
 */
export const RadioNowPlayingResponseSchema = RadioNowPlayingSchema.meta({
    id: 'RadioNowPlayingResponse',
});

export type RadioNowPlayingResponse = z.infer<typeof RadioNowPlayingResponseSchema>;

// ============================================================================
// Lyrics Responses
// ============================================================================

/**
 * Response: Track lyrics with optional parsed synced lines.
 * `lyrics` is null when the track exists but has no lyrics.
 */
export const LyricsApiResponseSchema = z
    .object({
        lyrics: LyricsSchema.nullable(),
        syncedLines: z.array(SyncedLyricLineSchema).optional(),
    })
    .meta({ id: 'LyricsApiResponse' });

export type LyricsApiResponse = z.infer<typeof LyricsApiResponseSchema>;

// ============================================================================
// Music Home Sections Response
// ============================================================================

/**
 * Response: Music home page sections (server-driven UI).
 */
export const MusicHomeSectionsResponseSchema = z
    .object({
        sections: z.array(PageSectionSchema),
    })
    .meta({ id: 'MusicHomeSectionsResponse' });

export type MusicHomeSectionsResponse = z.infer<typeof MusicHomeSectionsResponseSchema>;

// ============================================================================
// Music Genre Responses
// ============================================================================

const MusicGenreItemSchema = z.object({
    genre: z.string(),
    trackCount: z.number().optional(),
    albumCount: z.number().optional(),
});

export const MusicGenresResponseSchema = z
    .object({
        genres: z.array(MusicGenreItemSchema),
    })
    .meta({ id: 'MusicGenresResponse' });

export type MusicGenresResponse = z.infer<typeof MusicGenresResponseSchema>;

export const PinGenreResponseSchema = z
    .object({
        message: z.string(),
        genre: z.string(),
    })
    .meta({ id: 'PinGenreResponse' });

export type PinGenreResponse = z.infer<typeof PinGenreResponseSchema>;

// ============================================================================
// Pinned Genres Response (/api/v1/me/music/pinned-genres)
// ============================================================================

export const PinnedGenreSchema = z
    .object({
        id: z.number().int(),
        genre: z.string(),
        position: z.number().int(),
        /** ISO 8601 timestamp. */
        pinnedAt: z.string(),
    })
    .meta({ id: 'PinnedGenre' });

export const MusicPinnedGenresResponseSchema = z
    .object({
        items: z.array(PinnedGenreSchema),
    })
    .meta({ id: 'MusicPinnedGenresResponse' });

export type MusicPinnedGenresResponse = z.infer<typeof MusicPinnedGenresResponseSchema>;

// ============================================================================
// Similar tracks / albums / artists (GET /api/music/{tracks,albums,artists}/[id]/similar)
// ============================================================================

const SimilarPageSchema = z.object({
    limit: z.number().int(),
    truncated: z.boolean(),
});

const SimilarityScoreSchema = z.number().min(-1).max(1).meta({
    description:
        'Cosine similarity to the seed, in [-1, 1]; 1 = identical. Rounded to 4 decimals. Absent when the basis has no score.',
});

/** A track plus its similarity score (when the basis has one). */
export const SimilarTrackSchema = MusicTrackSchema.extend({
    similarityScore: SimilarityScoreSchema.optional(),
}).meta({ id: 'SimilarTrack' });

export type SimilarTrack = z.infer<typeof SimilarTrackSchema>;

export const SimilarTracksResponseSchema = z
    .object({
        items: z.array(SimilarTrackSchema),
        source: z.enum(['sonic', 'metadata']).meta({
            description:
                'The basis that produced `items`: `sonic` (audio embeddings) or `metadata` (text embedding plus audio features).',
        }),
        page: SimilarPageSchema,
    })
    .meta({ id: 'SimilarTracksResponse' });

export type SimilarTracksResponse = z.infer<typeof SimilarTracksResponseSchema>;

export const SimilarAlbumSchema = AlbumSummarySchema.extend({
    similarityScore: SimilarityScoreSchema,
}).meta({ id: 'SimilarAlbum' });

export type SimilarAlbum = z.infer<typeof SimilarAlbumSchema>;

export const SimilarAlbumsResponseSchema = z
    .object({
        items: z.array(SimilarAlbumSchema),
        source: z.literal('sonic'),
        page: SimilarPageSchema,
    })
    .meta({ id: 'SimilarAlbumsResponse' });

export type SimilarAlbumsResponse = z.infer<typeof SimilarAlbumsResponseSchema>;

export const SimilarArtistSchema = ArtistSummarySchema.extend({
    similarityScore: SimilarityScoreSchema,
}).meta({ id: 'SimilarArtist' });

export type SimilarArtist = z.infer<typeof SimilarArtistSchema>;

export const SimilarArtistsResponseSchema = z
    .object({
        items: z.array(SimilarArtistSchema),
        source: z.literal('sonic'),
        page: SimilarPageSchema,
    })
    .meta({ id: 'SimilarArtistsResponse' });

export type SimilarArtistsResponse = z.infer<typeof SimilarArtistsResponseSchema>;

// ============================================================================
// Album Series Response (/api/music/albums/[id]/series)
// ============================================================================

export const AlbumSeriesEntrySchema = AlbumSummarySchema.extend({
    /** Volume number parsed from the title ("Vol. 62" → 62). */
    volume: z.number().int(),
}).meta({ id: 'AlbumSeriesEntry' });

export type AlbumSeriesEntry = z.infer<typeof AlbumSeriesEntrySchema>;

export const AlbumSeriesResponseSchema = z
    .object({
        /** The whole series including the source album, ordered by volume. Empty when none. */
        albums: z.array(AlbumSeriesEntrySchema),
        sourceAlbumId: z.string(),
    })
    .meta({ id: 'AlbumSeriesResponse' });

export type AlbumSeriesResponse = z.infer<typeof AlbumSeriesResponseSchema>;

// ============================================================================
// Sonic Path Response (/api/music/path)
// ============================================================================

/** A single step in the sonic bridge between two seed tracks. */
export const SonicPathStepApiSchema = z
    .object({
        /** Internal UUID of the track. */
        id: z.string(),
        /** Step index (0-based, 0 = closest to `from`). */
        step: z.number().int().min(0),
        /**
         * Cosine similarity between this track and the waypoint at this step.
         * True range is [-1, 1] (fed by `1 - (embedding <=> …)`).
         */
        similarityScore: z.number().min(-1).max(1),
        /** Full track details for playback/display. */
        track: MusicTrackSchema,
    })
    .meta({ id: 'SonicPathStepApi' });

export type SonicPathStepApi = z.infer<typeof SonicPathStepApiSchema>;

export const SonicPathResponseSchema = z
    .object({
        /** Ordered bridge steps from `from` toward `to`. */
        steps: z.array(SonicPathStepApiSchema),
        /** UUID of the start track. */
        fromId: z.string(),
        /** UUID of the end track. */
        toId: z.string(),
        /** Number of bridge steps actually returned. */
        stepCount: z.number().int().min(0),
    })
    .meta({ id: 'SonicPathResponse' });

export type SonicPathApiResponse = z.infer<typeof SonicPathResponseSchema>;

// ============================================================================
// Semantic Search Query Params (text-search and lyrics-search)
// ============================================================================

/**
 * Query params for `GET /api/v1/music/text-search` (text-to-sound semantic
 * search). Single source of truth shared by the def and its colocated
 * `_openapi.ts`.
 */
export const musicTextSearchQuerySchema = z.object({
    q: z.string().max(200).optional().default(''),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export type MusicTextSearchQuery = z.infer<typeof musicTextSearchQuerySchema>;

/**
 * Query params for `GET /api/v1/music/lyrics-search` (semantic lyrics search).
 * Single source of truth shared by the def and its colocated `_openapi.ts`.
 */
export const musicLyricsSearchQuerySchema = z.object({
    q: z.string().max(200).optional().default(''),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export type MusicLyricsSearchQuery = z.infer<typeof musicLyricsSearchQuerySchema>;

// ============================================================================
// Semantic Search Result Item (text-search and lyrics-search)
// ============================================================================

export const MusicSearchResultItemSchema = TrackSchema.extend({ similarityScore: z.number() }).meta(
    { id: 'MusicSearchResultItem' },
);

export type MusicSearchResultItem = z.infer<typeof MusicSearchResultItemSchema>;

/**
 * Response: Text-to-sound or lyrics semantic search — `{ items, page }` envelope.
 * Matches the def-based /api/music/text-search and /api/music/lyrics-search surfaces.
 */
export const MusicTextSearchResponseSchema = z
    .object({
        items: z.array(MusicSearchResultItemSchema),
        page: z.object({
            limit: z.number().int(),
            truncated: z.boolean(),
        }),
    })
    .meta({ id: 'MusicTextSearchResponse' });

export type MusicTextSearchResponse = z.infer<typeof MusicTextSearchResponseSchema>;

// ============================================================================
// Cluster Responses (/api/music/sonic-mixes)
// ============================================================================

export const MusicClusterSchema = z
    .object({
        id: z.number().int(),
        label: z.string(),
        trackCount: z.number().int(),
        topGenres: z.array(z.string()),
        topArtists: z.array(z.string()),
        images: ImageSetSchema.optional().describe(
            'Cover collage (2x2 of the mix’s distinct albums, or one cover when fewer are distinct). Absent when no member track has a cover.',
        ),
    })
    .meta({ id: 'MusicCluster' });

export type MusicCluster = z.infer<typeof MusicClusterSchema>;

/** The cluster listing. */
export const MusicClustersResponseSchema = z
    .object({
        items: z.array(MusicClusterSchema),
    })
    .meta({ id: 'MusicClustersResponse' });

/**
 * Response for /music/sonic-mixes/index — id and label only, for devices that read the list
 * once at boot with a few KB of RAM. Ids are stable across re-clustering.
 */
export const MusicClustersIndexResponseSchema = z
    .object({
        items: z.array(
            z.object({ id: z.number().int(), label: z.string() }).meta({ id: 'MusicClusterIndex' }),
        ),
    })
    .meta({ id: 'MusicClustersIndexResponse' });

/** Page block for the bounded discovery lists: more rows existed than `limit`. */
const DiscoveryListPageSchema = z.object({
    limit: z.number().int(),
    truncated: z.boolean(),
});

/** Member tracks of one cluster, most representative first. */
export const MusicClusterTracksResponseSchema = z
    .object({
        items: z.array(MusicTrackSchema),
        page: PageBlockSchema,
    })
    .meta({ id: 'MusicClusterTracksResponse' });

export type MusicClustersResponse = z.infer<typeof MusicClustersResponseSchema>;
export type MusicClusterTracksResponse = z.infer<typeof MusicClusterTracksResponseSchema>;

// ============================================================================
// Quick Picks Response (/api/music/quick-picks)
// ============================================================================

export const MusicQuickPicksResponseSchema = z
    .object({
        items: z.array(UniversalMediaItemSchema),
        exhausted: z.boolean(),
    })
    .meta({ id: 'MusicQuickPicksResponse' });

export type MusicQuickPicksResponse = z.infer<typeof MusicQuickPicksResponseSchema>;

// ============================================================================
// Recently Played Response (/api/v1/me/music/recently-played)
// ============================================================================

export const MusicRecentlyPlayedResponseSchema = z
    .object({
        items: z.array(MusicTrackSchema),
        page: DiscoveryListPageSchema,
    })
    .meta({ id: 'MusicRecentlyPlayedResponse' });

export type MusicRecentlyPlayedResponse = z.infer<typeof MusicRecentlyPlayedResponseSchema>;

// ============================================================================
// Top Tracks Response (/api/v1/me/music/top-tracks)
// ============================================================================

export const MusicTopTracksResponseSchema = z
    .object({
        items: z.array(MusicTrackSchema),
        page: DiscoveryListPageSchema,
    })
    .meta({ id: 'MusicTopTracksResponse' });

export type MusicTopTracksResponse = z.infer<typeof MusicTopTracksResponseSchema>;

// ============================================================================
// Top Artists Response (/api/v1/me/music/top-artists)
// ============================================================================

export const MusicTopArtistItemSchema = ArtistSummarySchema.extend({
    playCount: z.number().int(),
    source: z.enum(['personal', 'catalog']),
}).meta({ id: 'MusicTopArtistItem' });

export const MusicTopArtistsResponseSchema = z
    .object({
        items: z.array(MusicTopArtistItemSchema),
        page: DiscoveryListPageSchema,
    })
    .meta({ id: 'MusicTopArtistsResponse' });

export type MusicTopArtistsResponse = z.infer<typeof MusicTopArtistsResponseSchema>;

// ============================================================================
// Station Tracks Response (/api/v1/me/music/taste-stations/{id}/tracks)
// ============================================================================

export const MusicStationTracksResponseSchema = z
    .object({
        items: z.array(MusicTrackSchema),
        page: DiscoveryListPageSchema,
    })
    .meta({ id: 'MusicStationTracksResponse' });

export type MusicStationTracksResponse = z.infer<typeof MusicStationTracksResponseSchema>;

// ============================================================================
// Taste Stations Response (/api/v1/me/music/taste-stations)
// ============================================================================

export const TasteStationSchema = z.object({
    id: z
        .string()
        .describe(
            'Opaque handle bound to the clustering the station came from. Safe to store; once the clustering it belongs to has expired, fetching its tracks answers 410 and the stations must be listed again.',
        ),
    label: z.string(),
    playedTrackCount: z.number().int(),
    tagline: z.string(),
    images: ImageSetSchema.optional().describe(
        "Cover collage (2x2 of the station's sample albums, or one cover when fewer are distinct). Absent when no sample track is visible to the caller.",
    ),
});

export const MusicTasteStationsResponseSchema = z
    .object({
        items: z.array(TasteStationSchema),
    })
    .meta({ id: 'MusicTasteStationsResponse' });

export type MusicTasteStationsResponse = z.infer<typeof MusicTasteStationsResponseSchema>;

// ============================================================================
// Music Map Response (/api/music/map)
// ============================================================================

export const MusicMapPointSchema = z.object({
    id: z.string(),
    x: z.number(),
    y: z.number(),
    title: z.string(),
    artist: z.string().nullable(),
    topMood: z.string().nullable(),
    images: ImageSetSchema,
});

export const MusicMapResponseSchema = z
    .object({
        points: z.array(MusicMapPointSchema),
        hasCoords: z.boolean(),
        embeddedCount: z.number().int().optional(),
        totalTracks: z.number().int().optional(),
        projectedCount: z.number().int().optional(),
    })
    .meta({ id: 'MusicMapResponse' });

export type MusicMapResponse = z.infer<typeof MusicMapResponseSchema>;

// ============================================================================
// Music Mood Recommendations Response (/api/music/sections/mood-recommendations)
// ============================================================================

/**
 * One mood-ranked track. NOTE: distinct from `MoodRecommendationsResponseSchema`
 * in api-for-you-responses.ts, which is the PageSection-shaped for-you surface.
 */
export const MusicMoodTrackSchema = TrackSchema.extend({ similarityScore: z.number() }).meta({
    id: 'MusicMoodTrack',
});

export const MusicMoodRecommendationsResponseSchema = z
    .object({
        items: z.array(MusicMoodTrackSchema),
        mood: z.string(),
        page: PageBlockSchema,
    })
    .meta({ id: 'MusicMoodRecommendationsResponse' });

export type MusicMoodRecommendationsResponse = z.infer<
    typeof MusicMoodRecommendationsResponseSchema
>;

/**
 * One selectable mood, ready to render as a chip.
 *
 * Only moods with a usable audio-space vector on this install are emitted, so
 * every entry is guaranteed to return results rather than silently nothing.
 */
export const MusicMoodSchema = z
    .object({
        key: z
            .string()
            .describe(
                'Bare mood key to pass as ?mood= (the music: namespace is added server-side)',
            ),
        label: z.string().describe('Display label'),
        emoji: z.string().describe('Display emoji'),
        images: ImageSetSchema.optional().describe(
            'Cover collage (2x2 of albums from this mood’s default mood-recommendations page, or one cover when fewer are distinct). Absent when the mood has no tracks for the caller; fall back to `emoji`.',
        ),
    })
    .meta({ id: 'MusicMood' });

export const MusicMoodsResponseSchema = z
    .object({
        moods: z.array(MusicMoodSchema),
    })
    .meta({ id: 'MusicMoodsResponse' });

export type MusicMood = z.infer<typeof MusicMoodSchema>;
export type MusicMoodsResponse = z.infer<typeof MusicMoodsResponseSchema>;

/**
 * Smart-mix carousels — k-means genre clusters surfaced as themed sections.
 * Empty array when clustering has not produced usable clusters yet.
 */
export const MusicSmartMixSectionsSchema = z
    .object({
        sections: z.array(PageSectionSchema),
    })
    .meta({ id: 'MusicSmartMixSections' });

export type MusicSmartMixSections = z.infer<typeof MusicSmartMixSectionsSchema>;

// ============================================================================
// Smart Downloads Responses
// ============================================================================

/**
 * One candidate from a smart-downloads lane stream.
 *
 * `rank` here is FETCH ORDERING ONLY. It is never persisted by the client and
 * never enters a keep-or-evict decision — see the design doc §3. Only rescore
 * output is comparable.
 *
 * `reason` and `reasonSubject.type` are deliberately plain strings, not enums:
 * generated Swift enums are @frozen with no unknown case, so adding a value
 * later would fail the decode of the entire response on every shipped client.
 */
export const MusicDownloadCandidateSchema = z
    .object({
        id: z.string(),
        rank: z.number().int().min(0),
        /** duration x bitrate estimate; null when runtime is unknown. */
        estBytes: z.number().int().min(0).nullable(),
        /** True only when the byte count is known exactly rather than estimated. */
        estBytesExact: z.boolean(),
        reason: z.string(),
        reasonSubject: z.object({ type: z.string(), id: z.string(), name: z.string() }).nullable(),
        embeddingProjection: z
            .string()
            .nullable()
            .describe(
                "A 64-dimensional projection of this track's MSCLAP sound embedding, " +
                    'max-abs-int8-quantized and base64-encoded (always exactly 64 raw bytes / 88 ' +
                    'base64 characters once decoded). Intended for the OFFLINE download pool to ' +
                    'rank "which track to fetch next" by sound similarity when the device has no ' +
                    "server connection -- measured 94.3% recall@10 against the server's true kNN, " +
                    'vs 5.3% for the on-device Essentia proxy it is meant to replace (see the ' +
                    'quantization eval). Compare two vectors with plain cosine similarity -- the ' +
                    'per-vector quantization scale is deliberately NOT included because cosine is ' +
                    'scale-invariant, which is what keeps this to 64 bytes with no sidecar float. ' +
                    'This vector is ONLY comparable against another vector carrying the exact same ' +
                    '`embeddingProjectionVersion`: the projection matrix is fit-once per deployment ' +
                    'and never recomputed, but a version bump (a full basis re-fit) is a full cache ' +
                    'invalidation. Measured cost of comparing across two different bases -- even two ' +
                    'independently well-fit ones -- ranges from 16.4% recall (a single flipped ' +
                    'component sign) down to 0.5% (a reseeded random projection), i.e. WORSE than ' +
                    'the Essentia fallback this feature exists to beat. `null` when this track has ' +
                    'no MSCLAP embedding yet (~15 tracks on the reference deployment) or the server ' +
                    'has not finished fitting/backfilling a basis -- treat exactly like a missing ' +
                    'embedding and fall back to the Essentia-based heuristic.',
            ),
        embeddingProjectionVersion: z
            .number()
            .int()
            .nullable()
            .describe(
                'The projection basis version `embeddingProjection` was produced under, or `null` ' +
                    'whenever `embeddingProjection` itself is `null` (the two fields are always ' +
                    'both-null or both-present together). On a version change from what you last ' +
                    'stored: discard EVERY previously stored `embeddingProjection` vector for every ' +
                    'track, not just this one -- vectors under different versions are not ' +
                    'comparable at all, per the mismatch costs described on `embeddingProjection`.',
            ),
    })
    .meta({ id: 'MusicDownloadCandidate' });

export const MusicDownloadCandidatesResponseSchema = z
    .object({
        lane: z.string(),
        candidates: z.array(MusicDownloadCandidateSchema),
        /**
         * Derived from the server's per-user transcode cap; the client must honour
         * it. `0` means the server currently has no spare per-user transcode
         * capacity — playback's own slots already consume what the cap allows — and
         * the client MUST NOT start any pool downloads until a later response
         * advertises a nonzero value.
         */
        maxConcurrentDownloads: z.number().int().min(0),
        scoreVersion: z
            .number()
            .int()
            .describe(
                'Version stamp for the `/music/downloads/rescore` ordering function — the ' +
                    'ONLY ranking a client persists. This field appears here purely so a ' +
                    'client polling `/candidates` can notice a ranking-function change without ' +
                    'waiting for its next rescore call; the `rank` values ON THIS response ' +
                    'remain fetch-ordering-only regardless. It is NOT a comparability token: ' +
                    'unlike `generation` on the rescore response, two responses sharing the ' +
                    'same `scoreVersion` does not make their ranks comparable. A client that ' +
                    'sees a `scoreVersion` different from what it last stored (from a rescore ' +
                    'response) should treat its stored ranks as stale and re-rescore.',
            ),
    })
    .meta({ id: 'MusicDownloadCandidatesResponse' });

export type MusicDownloadCandidatesResponse = z.infer<typeof MusicDownloadCandidatesResponseSchema>;

/**
 * One rescored pool member. EVERY submitted id comes back with a status —
 * absence is never a signal, because a truncated response would otherwise be
 * indistinguishable from "your whole pool was deleted" and the client's
 * reaction to that signal is mass deletion.
 */
export const MusicDownloadRescoreResultSchema = z
    .object({
        mediaId: z.string(),
        status: z
            .string()
            .describe(
                "This id's lifecycle status within the submitted cohort. An OPEN string, " +
                    'never an enum — a generated Swift enum is @frozen with no unknown case, ' +
                    'so adding a value later would fail the decode of the ENTIRE response on ' +
                    'every shipped client. Three values are defined today: ' +
                    '`ranked` — still active in this lane; `rank` is set (non-null), `toLane` ' +
                    'is null. `gone` — deleted, access revoked, or otherwise no longer ' +
                    'playable; `rank` and `toLane` are both null; EVICT this id. ' +
                    '`graduated` — still valid but has left this lane for `toLane`; `rank` is ' +
                    'null; hand off to the named lane, do NOT delete. ' +
                    'CLIENT RULE (this is what prevents data loss): eviction requires an ' +
                    'explicit, RECOGNIZED `gone`. An unrecognized status MUST be retained ' +
                    'and MUST NOT sort below a known `ranked` item — prefer overshooting ' +
                    'the budget by the count of unknowns over evicting them. Sorting them ' +
                    'worst would delete them on the next cycle, because a full pool at ' +
                    'budget is the steady state, not an edge case. If a hard ceiling must ' +
                    'be enforced, evict from the `ranked` tail first and touch unknowns ' +
                    'only once `ranked` is exhausted. Misfiling a `gone` as retain costs ' +
                    "one budget slot; misfiling anything as `gone` destroys a user's " +
                    'offline content.',
            ),
        rank: z
            .number()
            .int()
            .min(0)
            .nullable()
            .describe(
                'Ordinal position WITHIN the submitted cohort (not a global position). ' +
                    'Non-null only when `status` is `ranked`; null for `gone` and `graduated`.',
            ),
        toLane: z
            .string()
            .nullable()
            .describe(
                'Destination lane when `status` is `graduated`; null otherwise. Open string, ' +
                    'never an enum, for the same @frozen-Swift-enum reason as `status`.',
            ),
    })
    .meta({ id: 'MusicDownloadRescoreResult' });

export const MusicDownloadRescoreResponseSchema = z
    .object({
        /** Opaque, minted by rescore and by nothing else. Not a streamId. */
        generation: z.string(),
        results: z.array(MusicDownloadRescoreResultSchema),
        scoreVersion: z
            .number()
            .int()
            .describe(
                'Version stamp for the ranking expression that produced these ranks. This is ' +
                    'NOT a comparability token — unlike `generation`, sharing the same ' +
                    '`scoreVersion` across two responses does NOT make their ranks comparable; ' +
                    'ranks are comparable only within one response, keyed by its `generation`. ' +
                    '`scoreVersion` answers a narrower question: "is this the same ranking ' +
                    'FUNCTION I last saw?" It is bumped only when the server-side rescore ' +
                    'ordering expression itself changes. A client that sees a `scoreVersion` ' +
                    'different from what it last stored must treat its stored ranks as stale ' +
                    'and re-rescore.',
            ),
        statusVocabulary: z
            .array(z.string())
            .describe(
                'The full `status` vocabulary this server build can emit, across every lane — ' +
                    'not just the values present in `results` on this particular response. A ' +
                    "client's protection against an unrecognized status is silent retention " +
                    '(see `MusicDownloadRescoreResult.status`), which is correct but produces ' +
                    'no error and nothing in any log — indistinguishable from a healthy, ' +
                    'quiet pool. Diff this array against your own allow-list on every call: a ' +
                    'value present here that your client does not recognize means YOUR ' +
                    'VOCABULARY IS STALE, and you should treat that as a leading indicator to ' +
                    'update before it silently affects eviction, not as something to ignore.',
            ),
    })
    .meta({ id: 'MusicDownloadRescoreResponse' });

export type MusicDownloadRescoreResponse = z.infer<typeof MusicDownloadRescoreResponseSchema>;
