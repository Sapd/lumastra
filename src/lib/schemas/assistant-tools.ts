// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for the AI assistant's hybrid tool-calling (agentic RAG).
 *
 * SINGLE SOURCE OF TRUTH for every tool's argument shape. The OpenAI
 * `tools` array is derived from these via `z.toJSONSchema()` (see
 * `src/lib/server/assistant/assistant-tools/to-openai-schema.ts`), and the
 * dispatch loop validates the model's `tool_calls.arguments` against the
 * exact same schema before executing — this is the prompt-injection
 * boundary: the model can only ever supply typed, bounded arguments, never
 * SQL.
 *
 * Keep argument schemas FLAT (object of primitives/enums) and use
 * `.describe()` on every field — the description is what the model reads to
 * decide when/how to call the tool, and it flows into the JSON schema.
 *
 * @module schemas/assistant-tools
 */

import { z } from 'zod';

/**
 * Local, plain media-type enum for tool arguments. Intentionally NOT the
 * shared `mediaTypeSchema` from `./common`, which carries `.meta({ id })` and
 * therefore serializes to a `$ref`/`$defs` form under `z.toJSONSchema()`.
 * Tool parameter schemas must stay flat and inline for OpenAI, and the
 * inferred TypeScript type (`'movie' | 'tv'`) is identical either way.
 */
const toolMediaTypeSchema = z.enum(['movie', 'tv']);

// ============================================================================
// Tool name registry
// ============================================================================

/**
 * Canonical tool names. The dispatch loop, registry, and OpenAI tool
 * definitions all key off these exact strings.
 */
export const ASSISTANT_TOOL_NAMES = {
    SEARCH_LIBRARY: 'search_library',
    FIND_MEDIA: 'find_media',
    BUILD_WATCH_PLAN: 'build_watch_plan',
    ANALYZE_VIEWING_HISTORY: 'analyze_viewing_history',
    CHECK_AVAILABILITY: 'check_availability',
    GET_MY_RATINGS: 'get_my_ratings',
    GET_WATCH_HISTORY: 'get_watch_history',
    GET_SHARED_WATCH_HISTORY: 'get_shared_watch_history',
    GET_WATCH_STATS: 'get_watch_stats',
    GET_WATCHLIST: 'get_watchlist',
    SEARCH_MUSIC: 'search_music',
    GET_DETAILS: 'get_details',
    GET_LIBRARIES: 'get_libraries',
    GET_PLAYLISTS: 'get_playlists',
    GET_PLAYLIST_ITEMS: 'get_playlist_items',
    GET_AUDIOBOOK_PROGRESS: 'get_audiobook_progress',
    GET_MY_REQUESTS: 'get_my_requests',
    BROWSE_BY_KEYWORD: 'browse_by_keyword',
    BROWSE_BY_GENRE: 'browse_by_genre',
    FIND_BY_PERSON: 'find_by_person',
    GET_SERIES_EPISODES: 'get_series_episodes',
    GET_UPCOMING_RELEASES: 'get_upcoming_releases',
    GET_RECOMMENDATIONS: 'get_recommendations',
    GET_TOP_MUSIC: 'get_top_music',
    GET_MUSIC_PICKS: 'get_music_picks',
    FIND_MUSIC_BY_VIBE: 'find_music_by_vibe',
    WHATS_ON_TV: 'whats_on_tv',
    SEARCH_TV_GUIDE: 'search_tv_guide',
    SEARCH_AUDIOBOOKS: 'search_audiobooks',
    SEARCH_BOOKS: 'search_books',
    GET_ACTIVE_STREAMS: 'get_active_streams',
    GET_MY_STATS: 'get_my_stats',
    // --- WRITE ACTIONS (mutate the caller's OWN state; gated in registry.ts) ---
    ADD_TO_WATCHLIST: 'add_to_watchlist',
    REMOVE_FROM_WATCHLIST: 'remove_from_watchlist',
    SET_RATING: 'set_rating',
    MARK_WATCHED: 'mark_watched',
    CREATE_REQUEST: 'create_request',
} as const;

export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[keyof typeof ASSISTANT_TOOL_NAMES];

// ============================================================================
// Per-tool argument schemas (model -> server)
// ============================================================================

/**
 * `search_library` — semantic/vector search over the user's accessible
 * library. This is the PRIMARY tool and the source of recommended cards.
 */
export const searchLibraryArgsSchema = z.object({
    query: z
        .string()
        .min(1)
        .max(400)
        .describe(
            'Natural-language description of what to find, e.g. "mind-bending sci-fi thrillers" or "movies like Inception". Semantic search — describe the vibe/theme, not just a title.',
        ),
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('Restrict results to "movie" or "tv". Omit for both.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe('Maximum number of results to return (default 8).'),
});
export type SearchLibraryArgs = z.infer<typeof searchLibraryArgsSchema>;

/** Structured hard filters for recommendation queries. */
export const findMediaArgsSchema = z.object({
    mediaType: toolMediaTypeSchema.optional().describe('Restrict to "movie" or "tv".'),
    genres: z
        .array(z.string().min(2).max(40))
        .max(6)
        .optional()
        .describe('English TMDB genres; a title may match any one.'),
    excludeGenres: z
        .array(z.string().min(2).max(40))
        .max(6)
        .optional()
        .describe(
            'English TMDB genres to EXCLUDE. Use for "not horror" / "kein Horror" / "anything but a musical".',
        ),
    maxAgeRating: z
        .number()
        .int()
        .min(0)
        .max(21)
        .optional()
        .describe(
            'Only titles rated for this age or younger (FSK/certification number). USE THIS for "for kids", "Kinderserien", "family friendly" — 6 for young children, 12 for older. Genre tags do NOT mean child-suitable: "Animation" also covers adult anime. Titles with no age rating are excluded, deliberately.',
        ),
    minYear: z
        .number()
        .int()
        .min(1880)
        .max(2100)
        .optional()
        .describe('Earliest RELEASE year (when the title came out, NOT when it was added).'),
    addedWithinDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .optional()
        .describe(
            'Only titles ADDED to the library within this many days. This is ingest date, NOT release year — use it for "what is new", "was ist neu dazugekommen", "recently added".',
        ),
    maxYear: z.number().int().min(1880).max(2100).optional().describe('Latest release year.'),
    minRuntimeMinutes: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('Shortest runtime in minutes.'),
    maxRuntimeMinutes: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('Longest runtime in minutes.'),
    // NOTE the differing scales — the model gets these verbatim, and mixing them
    // up is the difference between "acclaimed" and "no results".
    minRtRating: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe(
            'Minimum Rotten Tomatoes CRITIC score (Tomatometer) as a percentage, 0-100. "Well reviewed" is about 75, "acclaimed" about 90.',
        ),
    minRtAudienceScore: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe(
            'Minimum Rotten Tomatoes AUDIENCE score (Popcornmeter) as a percentage, 0-100. Use when the user asks what viewers liked rather than what critics liked.',
        ),
    minImdbRating: z
        .number()
        .min(0)
        .max(10)
        .optional()
        .describe('Minimum IMDb rating on the 0-10 scale.'),
    watched: z
        .boolean()
        .optional()
        .describe('true for already watched, false for unwatched, omit for either.'),
    unwatchedByUsername: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe('Named, consented household member who must also not have watched it.'),
    sortBy: z
        .enum([
            'rating',
            'rt_rating',
            'rt_audience_score',
            'imdb_rating',
            'newest_added',
            'oldest_added',
            'longest',
            'shortest',
        ])
        .optional()
        .describe(
            'rating for the best-reviewed titles overall (best available source per title); rt_rating / rt_audience_score / imdb_rating to rank by that specific source; newest_added for what arrived most recently; oldest_added for forgotten library additions; longest / shortest to rank by runtime. Use longest/shortest for superlatives ("the longest film we have") — do NOT fetch a batch and eyeball it, that only ranks the batch.',
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Maximum number of results (default 10).'),
});
export type FindMediaArgs = z.infer<typeof findMediaArgsSchema>;

/** A bounded, server-built watchlist/marathon from real library candidates. */
export const buildWatchPlanArgsSchema = z.object({
    targetMinutes: z.number().int().min(20).max(1440).describe('Total time budget in minutes.'),
    itemCount: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe('Maximum titles to include (default 3).'),
    mediaType: toolMediaTypeSchema.optional().describe('Restrict to movies or TV shows.'),
    genres: z
        .array(z.string().min(2).max(40))
        .max(6)
        .optional()
        .describe('Optional English TMDB genres; titles may match any one.'),
    minRtRating: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Optional minimum Rotten Tomatoes critic score, 0-100.'),
    minImdbRating: z
        .number()
        .min(0)
        .max(10)
        .optional()
        .describe('Optional minimum IMDb rating, 0-10.'),
    selectionMode: z
        .enum(['best_rated', 'diverse'])
        .optional()
        .describe('Use diverse to avoid repeating the same genre mix.'),
});
export type BuildWatchPlanArgs = z.infer<typeof buildWatchPlanArgsSchema>;

export const analyzeViewingHistoryArgsSchema = z.object({
    mode: z
        .enum(['abandoned', 'nearly_finished', 'recent'])
        .describe('Which viewing-history insight to return.'),
    limit: z.number().int().min(1).max(30).optional().describe('Maximum results (default 10).'),
});
export type AnalyzeViewingHistoryArgs = z.infer<typeof analyzeViewingHistoryArgsSchema>;

/**
 * `check_availability` — resolve a specific title (optionally by year) to a
 * concrete library item with watch/request status.
 */
export const checkAvailabilityArgsSchema = z.object({
    title: z
        .string()
        .min(1)
        .max(200)
        .describe('Exact-ish title to look up, e.g. "Blade Runner 2049".'),
    year: z
        .number()
        .int()
        .min(1880)
        .max(2100)
        .optional()
        .describe('Release year, to disambiguate remakes/reboots.'),
});
export type CheckAvailabilityArgs = z.infer<typeof checkAvailabilityArgsSchema>;

/**
 * `get_my_ratings` — the calling user's own rated titles (taste signal).
 */
export const getMyRatingsArgsSchema = z.object({
    minRating: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Only return ratings at or above this value (1-10).'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of rated titles to return (default 20).'),
});
export type GetMyRatingsArgs = z.infer<typeof getMyRatingsArgsSchema>;

/**
 * `get_watch_history` — the calling user's recently watched titles.
 */
export const getWatchHistoryArgsSchema = z.object({
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('Restrict to "movie" or "tv". Omit for both.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of watched titles to return (default 20).'),
});
export type GetWatchHistoryArgs = z.infer<typeof getWatchHistoryArgsSchema>;

/**
 * `get_shared_watch_history` — a consent-gated view of one household member's
 * watched titles. It is deliberately separate from the caller's history: the
 * registry only exposes it when the operator enabled social sharing, and the
 * SQL query applies the subject's privacy/audience controls.
 */
export const getSharedWatchHistoryArgsSchema = z.object({
    username: z.string().min(1).max(80).describe('Exact household member username, e.g. "Alex".'),
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('Restrict to "movie" or "tv". Omit for both.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of watched titles to return (default 20).'),
});
export type GetSharedWatchHistoryArgs = z.infer<typeof getSharedWatchHistoryArgsSchema>;

/**
 * `get_watch_stats` — coarse counts of what the calling user has watched.
 *
 * NOTE: only all-time counts are backed by an existing query. Per-period
 * ("this month") and group-by aggregates are NOT yet available; the tool
 * description tells the model so it does not over-promise.
 */
export const getWatchStatsArgsSchema = z.object({
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('Restrict the count to "movie" or "tv". Omit for a combined total.'),
});
export type GetWatchStatsArgs = z.infer<typeof getWatchStatsArgsSchema>;

/**
 * `get_watchlist` — the movies/shows the user has saved to watch later.
 */
export const getWatchlistArgsSchema = z.object({
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('Restrict to "movie" or "tv". Omit for both.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum number of saved titles to return (default 30).'),
});
export type GetWatchlistArgs = z.infer<typeof getWatchlistArgsSchema>;

/**
 * `search_music` — text search over the user's accessible MUSIC library
 * (tracks, albums, artists). Separate from `search_library` (movies/tv).
 */
export const searchMusicArgsSchema = z.object({
    query: z
        .string()
        .min(1)
        .max(200)
        .describe(
            'Track, album or artist NAME to search for, e.g. "Copper Lanterns" or "Signals at Dawn". This is a NAME search only — it cannot find music by genre, mood or decade, and a query like "90s rock" will only match titles containing those words.',
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe('Maximum number of music results to return (default 10).'),
});
export type SearchMusicArgs = z.infer<typeof searchMusicArgsSchema>;

/**
 * `get_details` — full details for ONE movie or TV show: overview, cast,
 * directors, genres, tags/keywords, ratings, runtime, certification, which
 * library it's in, available audio & subtitle languages, and (for series)
 * season & episode counts.
 */
export const getDetailsArgsSchema = z.object({
    title: z
        .string()
        .min(1)
        .max(200)
        .describe('Title of the movie or show to get full details for.'),
    year: z
        .number()
        .int()
        .min(1880)
        .max(2100)
        .optional()
        .describe('Release year, to disambiguate.'),
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('"movie" or "tv", if known, to disambiguate.'),
});
export type GetDetailsArgs = z.infer<typeof getDetailsArgsSchema>;

/**
 * `get_libraries` — list the media libraries the user can access (name, how
 * many items, and which media types each holds). No arguments.
 */
export const getLibrariesArgsSchema = z.object({});
export type GetLibrariesArgs = z.infer<typeof getLibrariesArgsSchema>;

/**
 * `get_playlists` — playlists the user owns or has been invited to. No args.
 */
export const getPlaylistsArgsSchema = z.object({});
export type GetPlaylistsArgs = z.infer<typeof getPlaylistsArgsSchema>;

/**
 * `get_my_requests` — the user's own media requests that are now available
 * ("your requests are ready"). No args.
 */
export const getMyRequestsArgsSchema = z.object({});
export type GetMyRequestsArgs = z.infer<typeof getMyRequestsArgsSchema>;

/**
 * `browse_by_keyword` — find library titles tagged with a keyword/tag, e.g.
 * "whodunit", "heist", "time travel". Precise tag match (not semantic).
 */
export const browseByKeywordArgsSchema = z.object({
    keywords: z
        .array(z.string().min(2).max(60))
        .min(1)
        .max(8)
        .describe(
            'One or more tags/keywords; a title matching ANY is returned. Pass close synonyms to widen recall, e.g. whodunit → ["whodunit","murder mystery","detective","mystery"]; heist → ["heist","robbery"].',
        ),
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('Restrict to "movie" or "tv". Omit for both.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe('Maximum number of results (default 10).'),
});
export type BrowseByKeywordArgs = z.infer<typeof browseByKeywordArgsSchema>;

/**
 * `browse_by_genre` — find library titles in a genre/category, e.g. "Family",
 * "Kids", "Comedy", "Horror". Use the canonical English TMDB genre name.
 */
export const browseByGenreArgsSchema = z.object({
    genres: z
        .array(z.string().min(2).max(40))
        .min(1)
        .max(6)
        .describe(
            'One or more genre/category names in English (TMDB genres); a title matching ANY of them is returned. Pass several related genres to widen recall, e.g. kids shows → ["Kids","Family","Animation"]; horror → ["Horror"].',
        ),
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('Restrict to "movie" or "tv". Omit for both.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe('Maximum number of results (default 10).'),
});
export type BrowseByGenreArgs = z.infer<typeof browseByGenreArgsSchema>;

/**
 * `find_by_person` — library titles featuring a specific actor or director.
 */
export const findByPersonArgsSchema = z.object({
    person: z
        .string()
        .min(2)
        .max(80)
        .describe('Actor or director full name, e.g. "Christoph Maria Herbst".'),
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('Restrict to "movie" or "tv". Omit for both.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(15)
        .optional()
        .describe('Maximum number of results (default 10).'),
});
export type FindByPersonArgs = z.infer<typeof findByPersonArgsSchema>;

/**
 * `get_series_episodes` — a series' episodes with the user's watched status,
 * for "which episodes of X haven't I watched" / "what's left in X".
 */
export const getSeriesEpisodesArgsSchema = z.object({
    title: z.string().min(1).max(200).describe('Title of the series.'),
    season: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe('Restrict to a single season number. Omit for all seasons.'),
});
export type GetSeriesEpisodesArgs = z.infer<typeof getSeriesEpisodesArgsSchema>;

/**
 * `get_upcoming_releases` — future air dates from the release calendar.
 *
 * EPISODE-ONLY on purpose. The calendar query has a movie branch, but
 * `media_items.premiere_date` is populated for 26 of 12,687 movies on real
 * data (0.2%) because only `release-calendar-sync` writes it, from Radarr.
 * Advertising a movie filter over a column that is empty 99.8% of the time
 * produces a silent zero-row answer the model then narrates as fact, so
 * neither the argument nor the movie rows are exposed.
 *
 * There is deliberately no "mediaType" argument for the same reason.
 */
export const getUpcomingReleasesArgsSchema = z.object({
    days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe(
            'How many days ahead to look, starting today (default 7). The calendar only holds about 90 days of future air dates, so 90 is the maximum and anything beyond it does not exist.',
        ),
    series: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
            'Restrict to ONE series by title, for "when is the next episode of X" or "when does season 3 of X start". Omit to list everything airing in the window.',
        ),
    onlyMyShows: z
        .boolean()
        .optional()
        .describe(
            'When true, only series the user has already watched at least one episode of. Use this for "my shows" / "meine Serien" / "welche neuen Folgen kommen" (personal phrasing). Leave false for a general "what is coming out this week".',
        ),
});
export type GetUpcomingReleasesArgs = z.infer<typeof getUpcomingReleasesArgsSchema>;

/**
 * `whats_on_tv` — current/upcoming Live TV programming. With a channel name
 * ("ZDF", "Das Erste") it returns that channel's now-playing + next programs;
 * without one it returns what is currently airing across the user's visible
 * channels. Only available when the user may view Live TV.
 */
export const whatsOnTvArgsSchema = z.object({
    channel: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
            'Channel name to look up (e.g. "ZDF", "Das Erste"). Omit to list what is airing across all channels.',
        ),
    atTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM')
        .optional()
        .describe(
            'Local clock time to look up, 24-hour HH:MM (e.g. "20:15"). REQUIRED for "what is on tonight at 20:15" / "was läuft heute Abend" — without it you get what is on RIGHT NOW, which is a different question.',
        ),
    daysAhead: z
        .number()
        .int()
        .min(0)
        .max(6)
        .optional()
        .describe('0 = today (default), 1 = tomorrow, up to 6 days ahead. Combine with atTime.'),
});
export type WhatsOnTvArgs = z.infer<typeof whatsOnTvArgsSchema>;

/**
 * `search_tv_guide` — full-text search of the Live TV guide (EPG) for a show,
 * event, team, or topic ("Bundesliga", "Tatort", "news"). Returns matching
 * programs with their channel and whether they are live now, later today, or
 * upcoming. Only available when the user may view Live TV.
 */
export const searchTvGuideArgsSchema = z.object({
    query: z
        .string()
        .min(1)
        .max(120)
        .describe('What to search the TV guide for (show, event, team, topic).'),
});
export type SearchTvGuideArgs = z.infer<typeof searchTvGuideArgsSchema>;

/**
 * `search_audiobooks` — search the Audiobookshelf library by title, author, or
 * series. Only available when Audiobookshelf is configured. Text-only.
 */
export const searchAudiobooksArgsSchema = z.object({
    query: z
        .string()
        .min(1)
        .max(200)
        .describe('Title, author, or series to search audiobooks for.'),
});
export type SearchAudiobooksArgs = z.infer<typeof searchAudiobooksArgsSchema>;

/**
 * `search_books` — search the Kavita library (books / manga / comics) by title
 * or series. Only available when Kavita is configured. Text-only.
 */
export const searchBooksArgsSchema = z.object({
    query: z
        .string()
        .min(1)
        .max(200)
        .describe('Title or series to search books / manga / comics for.'),
});
export type SearchBooksArgs = z.infer<typeof searchBooksArgsSchema>;

/**
 * `get_active_streams` — who is watching/listening right now. Takes no
 * arguments; visibility is enforced server-side by the shared session
 * pipeline (feature gate + per-user privacy). Only registered when the caller
 * is permitted to view streams.
 */
export const getActiveStreamsArgsSchema = z.object({});
export type GetActiveStreamsArgs = z.infer<typeof getActiveStreamsArgsSchema>;

/**
 * `get_my_stats` — the user's rich personal viewing-statistics dashboard
 * (the /my-stats page): overview, watch-time, peak hours, completion, top
 * genres + keywords, devices, quality, ratings, taste profile, and fun
 * records. Only available when personal stats are enabled.
 */
/**
 * `get_playlist_items` — what is actually ON a named playlist.
 *
 * Deliberately separate from `get_playlists`, which lists names + counts only.
 * Without this the model was handed "Roadtrip, 42 items" and a question about
 * the 42, and had nothing to answer from but its own imagination.
 */
/**
 * `get_audiobook_progress` — where the caller is in the books they have started.
 *
 * There was no tool for this at all: the audiobook surface was search-only and
 * `analyze_viewing_history` reads `watch_history`, which is video. A resume
 * position is a specific, checkable number, so an assistant that cannot read one
 * but gets asked for it is a fabrication surface.
 */
export const getAudiobookProgressArgsSchema = z.object({
    limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('Maximum books to return, most recent activity first (default 10).'),
});
export type GetAudiobookProgressArgs = z.infer<typeof getAudiobookProgressArgsSchema>;

export const getPlaylistItemsArgsSchema = z.object({
    name: z
        .string()
        .min(1)
        .max(120)
        .describe(
            'Playlist name exactly as get_playlists reported it (match is case-insensitive).',
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Maximum items to return (default 25, newest position first).'),
});
export type GetPlaylistItemsArgs = z.infer<typeof getPlaylistItemsArgsSchema>;

export const getMyStatsArgsSchema = z.object({
    period: z
        .union([
            z.enum(['7d', '30d', '90d', 'all']),
            z.string().regex(/^year:20\d{2}$/, 'Use year:YYYY, e.g. year:2026'),
        ])
        .optional()
        .describe(
            'Time window. "7d"/"30d"/"90d" are ROLLING windows (30d is the last 30 days, NOT last calendar month). For a calendar year — "this year", "in 2025", "dieses Jahr" — pass "year:YYYY". "all" (default) is all-time. Never relabel one window as another.',
        ),
});
export type GetMyStatsArgs = z.infer<typeof getMyStatsArgsSchema>;

/**
 * `get_recommendations` — taste-aware picks for open-ended/"what should I
 * watch" requests. Uses the user's own high ratings to seed the search, so it
 * works without the user supplying a search query. An optional mood/vibe
 * steers it.
 */
export const getRecommendationsArgsSchema = z.object({
    mood: z
        .string()
        .max(120)
        .optional()
        .describe(
            'Optional mood/vibe/theme to steer the picks, e.g. "cozy", "intense thriller", "feel-good". Omit to base it purely on the user\'s taste.',
        ),
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('Restrict to "movie" or "tv". Omit for both.'),
    includeWatched: z
        .boolean()
        .optional()
        .describe(
            'Set true ONLY when the user explicitly wants rewatch suggestions or titles they have already seen. Omit (default) to recommend only unwatched titles.',
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe('Maximum number of recommendations (default 8).'),
});
export type GetRecommendationsArgs = z.infer<typeof getRecommendationsArgsSchema>;

/** `get_top_music` — the user's most-played tracks. */
export const getTopMusicArgsSchema = z.object({
    period: z
        .enum(['7d', '30d', '90d', '1y', 'all'])
        .optional()
        .describe(
            'Time window for "top". Default "all" = all-time play counts. Pass 7d/30d/90d/1y for "this week/month/year" — do NOT relabel an all-time list as a period.',
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe('Maximum number of tracks to return (default 15).'),
});
export type GetTopMusicArgs = z.infer<typeof getTopMusicArgsSchema>;

/** `get_music_picks` — personalized "quick picks" music recommendations. */
export const getMusicPicksArgsSchema = z.object({
    limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe('Maximum number of picks to return (default 12).'),
});
export type GetMusicPicksArgs = z.infer<typeof getMusicPicksArgsSchema>;

/**
 * `find_music_by_vibe` — CLAP text-to-sound search: finds tracks whose actual
 * AUDIO character matches a described SOUND, as opposed to `get_music_picks`
 * (taste-based, not mood-aware) or `search_music` (name lookup).
 *
 * The `query` describe() is the only steering the model gets, and it decides
 * whether the search works at all: the embedding represents timbre /
 * instrumentation / energy (measured cosine 0.48-0.56) and represents an
 * activity, a context or a decade not at all (0.33-0.40, i.e. noise). See the
 * tool module for the measurements.
 */
export const findMusicByVibeArgsSchema = z.object({
    query: z
        .string()
        .min(1)
        .max(400)
        .describe(
            'An ENGLISH description of HOW THE MUSIC SHOULD SOUND — instruments, voice, timbre, energy, tempo, production — e.g. "calm solo piano", "distorted aggressive guitar", "sparse acoustic folk with a soft male voice", "upbeat electronic dance beat". Restate the user\'s request as audible qualities and translate it to English; a bare mood, activity or situation ("music for cooking", "workout") has no audible signature and will match nothing. Do NOT put a decade, era or genre name in here — they are not searchable and are ignored.',
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe('Maximum number of tracks to return (default 12).'),
});
export type FindMusicByVibeArgs = z.infer<typeof findMusicByVibeArgsSchema>;

// ============================================================================
// Write actions (model -> server MUTATIONS)
// ============================================================================

/**
 * Shared target fields for every write tool: the model names a TITLE, never an
 * id.
 *
 * There is deliberately NO `mediaId` argument on any write tool. The internal
 * UUID must originate from an access-scoped query in the SAME request
 * (`searchMediaByTitle`), never from the model — a model-supplied provider id
 * would fall through `resolveExternalIdsToMediaId` into
 * `resolveOrCreateMediaId`, which CREATES a stub `media_items` row for an
 * unknown id. An hallucinated TMDB id would then write catalogue rows.
 * `assistant-tools.test`s assert the schemas reject a `mediaId` field so a
 * future edit cannot quietly re-open that path.
 */
const writeTargetShape = {
    title: z
        .string()
        .min(1)
        .max(200)
        .describe(
            'Title of the movie or show, spelled as it appeared in an earlier tool result, e.g. "Blade Runner 2049".',
        ),
    year: z
        .number()
        .int()
        .min(1880)
        .max(2100)
        .optional()
        .describe('Release year — pass it to disambiguate remakes and reboots.'),
    mediaType: toolMediaTypeSchema
        .optional()
        .describe('"movie" or "tv", if known, to disambiguate a film from a same-named series.'),
} as const;

/** `add_to_watchlist` — save ONE title to the caller's own watchlist. */
export const addToWatchlistArgsSchema = z.strictObject({ ...writeTargetShape });
export type AddToWatchlistArgs = z.infer<typeof addToWatchlistArgsSchema>;

/** `remove_from_watchlist` — remove ONE title from the caller's own watchlist. */
export const removeFromWatchlistArgsSchema = z.strictObject({ ...writeTargetShape });
export type RemoveFromWatchlistArgs = z.infer<typeof removeFromWatchlistArgsSchema>;

/**
 * `set_rating` — set or REMOVE the caller's own 1-10 rating for one title.
 *
 * `rating` is nullable-but-required rather than optional: one tool with an
 * explicit "null means delete" beats two tools the model has to choose
 * between, and there is no generated Swift client here to collapse
 * absent-vs-null into a single Optional.
 */
export const setRatingArgsSchema = z.strictObject({
    ...writeTargetShape,
    rating: z
        .number()
        .int()
        .min(1)
        .max(10)
        .nullable()
        .describe(
            'Rating from 1 (worst) to 10 (best). Pass null to REMOVE an existing rating. This is a 1-10 scale — never pass a percentage, and never pass a 5-star value.',
        ),
});
export type SetRatingArgs = z.infer<typeof setRatingArgsSchema>;

/** `mark_watched` — mark ONE title watched or unwatched. */
export const markWatchedArgsSchema = z.strictObject({
    ...writeTargetShape,
    watched: z
        .boolean()
        .describe(
            'true = mark as watched, false = mark as unwatched. For a SERIES this applies to the WHOLE show — every season and episode — not to a single episode. There is no per-episode option.',
        ),
});
export type MarkWatchedArgs = z.infer<typeof markWatchedArgsSchema>;

/**
 * `create_request` — ask for a title that is not in the library yet.
 *
 * `seasons` is deliberately absent: the def supports it, but the assistant has
 * no reliable way to know which seasons are missing and a wrong season list is
 * a real download.
 */
export const createRequestArgsSchema = z.strictObject({
    ...writeTargetShape,
    confirmed: z
        .boolean()
        .describe(
            'Must be false on the FIRST call. The tool then returns the exact title it resolved and requests nothing; show that title to the user, get their explicit yes, and only then call again with true. A request orders a real download — never pass true on the first call, and never pass true for a title the user has not confirmed in their own words.',
        ),
});
export type CreateRequestArgs = z.infer<typeof createRequestArgsSchema>;

// ============================================================================
// Tool result media summary (server -> model, and basis for cards)
// ============================================================================

/**
 * Compact, model-facing summary of one media item returned by a tool. This
 * is what gets serialized into the `tool` message the model reads back. It
 * intentionally mirrors the fields needed to later build a `RecommendedMovie`
 * card without a regex round-trip.
 */
export const assistantToolMediaSummarySchema = z.object({
    /** Stable handle the model cites to link the title (e.g. "562:movie"). */
    ref: z.string().nullable().optional(),
    title: z.string(),
    mediaType: z.enum(['movie', 'series']),
    year: z.number().int().nullable().optional(),
    overview: z.string().nullable().optional(),
    imdbRating: z.number().nullable().optional(),
    /** Rotten Tomatoes CRITIC score, 0-100. null means WE DO NOT HAVE IT. */
    rtRating: z.number().nullable().optional(),
    /** Rotten Tomatoes AUDIENCE score, 0-100. null means WE DO NOT HAVE IT. */
    rtAudienceScore: z.number().nullable().optional(),
    /**
     * Runtime in minutes; null means WE DO NOT HAVE IT. Queried all along but
     * stripped here, so every "it's only 90 minutes" the model said about a
     * find_media / browse_by_genre result was sourced from its own memory.
     */
    runtimeMinutes: z.number().nullable().optional(),
    /** Genre names as stored; empty means WE DO NOT HAVE THEM. */
    genres: z.array(z.string()).optional(),
    userRating: z.number().nullable().optional(),
    isAvailable: z.boolean(),
    canRequest: z.boolean(),
    /** Whether the calling user has already watched this title. */
    watched: z.boolean(),
});
export type AssistantToolMediaSummary = z.infer<typeof assistantToolMediaSummarySchema>;
