// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB metadata provider.
 *
 * TMDB (The Movie Database) is the primary metadata source for movies and
 * TV shows. Highest priority (100) among metadata providers; authoritative
 * field weights for all common metadata fields declared in `metadata`
 * below.
 *
 * Typed extension methods (getMovieDetailsWithAppends, getEpisodeGroups,
 * resolveImdbToTmdb, etc.) live on the canonical TMDBApiService at
 * `src/lib/server/providers/implementations/tmdb/client.ts` — import `tmdbApi`
 * from `$lib/server/providers/implementations/tmdb` when you need them.
 * Trending + cross-reference helpers live at
 * `src/lib/server/providers/implementations/tmdb/{trending,resolve-external}.ts`.
 *
 * TMDB rate limit: 40 req/10s = 4 rps.
 *
 * ID encoding convention used by detail() and childList():
 *   'movie:550'          → movie detail (TMDB ID 550)
 *   'tv:1399'            → TV series detail (TMDB ID 1399)
 *   'tv:1399:s1'         → season 1 of series 1399
 *   'tv:1399:s1:e3'      → episode 3 of season 1 of series 1399
 *   'person:1234'        → person detail
 *
 * append_to_response: movie and TV series detail calls include
 * credits,videos,keywords,images,translations,external_ids (plus release_dates for
 * movies / content_ratings for TV: the per-country certifications) in a single
 * round-trip. Season and episode detail calls include credits,videos.
 */

import { defineProvider } from '@sapd/lumastra-plugin-sdk';
import type {
    PluginContext,
    ProviderDiscoverParams,
    ProviderDiscoverResult,
    ProviderExternalIdSource,
    ProviderResolveExternalIdResult,
    ProviderTrendingParams,
    ProviderPopularParams,
    ProviderTopRatedParams,
} from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import {
    isProviderAuthFailed,
    markProviderAuthFailed,
    ProviderAuthError,
} from '../../../../providers/provider-auth-state.js';
import { config } from '../../../../config.js';
import { tmdbApi } from '../../../../providers/implementations/tmdb/index.js';
import {
    buildProviderDetailResult,
    type TmdbItem,
    type TmdbDetailResult,
} from '../../../../providers/implementations/tmdb/detail-coerce.js';
import {
    isTmdbBearerToken,
    tmdbAuthorizedRequest,
} from '../../../../providers/implementations/tmdb/auth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TMDB_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_LANGUAGE = 'en-US';

// ---------------------------------------------------------------------------
// Param / result shapes
// ---------------------------------------------------------------------------

export interface TmdbSearchParams {
    type: 'movie' | 'tv' | 'person';
    query: string;
    year?: number;
    language?: string;
}

// `TmdbItem` / `TmdbDetailResult` / `buildProviderDetailResult` now live in
// `providers/implementations/tmdb/detail-coerce.ts` (imported above) so non-task
// callers can reuse the pure coercion without loading this self-registering
// provider module.

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * The TMDB API key — the host setting (settings.json, else env).
 * Throws if none is set.
 */
const TMDB_PROVIDER_ID = 'tmdb-metadata-provider';

function resolveApiKey(): string {
    const key = config.TMDB_API_KEY?.trim();
    if (!key) throw new Error('TMDB_API_KEY is not configured');
    return key;
}

/**
 * The language to fetch in: a per-call (per-library) override, else the host
 * TMDB_LANGUAGE — the primary language every other writer and the
 * translation overlay resolve against — else DEFAULT_LANGUAGE.
 */
function resolveLanguage(override?: string): string {
    if (override) return override;
    return config.TMDB_LANGUAGE?.trim() || DEFAULT_LANGUAGE;
}

/**
 * Build a TMDB URL with authentication (v3 key or v4 Bearer token, see
 * `providers/implementations/tmdb/auth.ts`). Returns the URL string and the
 * headers object so the caller can forward them to ctx.http.get().
 */
function buildRequest(
    endpoint: string,
    apiKey: string,
    params: Record<string, string | number>,
): { url: string; headers: Record<string, string> } {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return tmdbAuthorizedRequest(`${TMDB_BASE}${endpoint}?${qs}`, apiKey, {
        'Content-Type': 'application/json',
    });
}

/**
 * Execute a TMDB GET request via ctx.http. Handles Bearer-token fallback,
 * structured TmdbApiError-compatible throws for 4xx/5xx, and network errors.
 */
async function tmdbGet(
    ctx: PluginContext,
    endpoint: string,
    params: Record<string, string | number>,
): Promise<TmdbItem> {
    const apiKey = resolveApiKey();
    // A key TMDB already rejected is not asked again for every file of a
    // scan — see provider-auth-state.ts.
    if (isProviderAuthFailed(TMDB_PROVIDER_ID, apiKey)) {
        throw new ProviderAuthError(TMDB_PROVIDER_ID, 'TMDB API key rejected (401)');
    }
    const { url, headers } = buildRequest(endpoint, apiKey, params);

    if (!ctx.http) throw new Error('ctx.http is not available (capabilities.http must be true)');

    let response = await ctx.http.get(url, { headers });

    // Bearer-token 401 fallback: retry with api_key param
    if (response.status === 401 && isTmdbBearerToken(apiKey)) {
        const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
        qs.set('api_key', apiKey);
        response = await ctx.http.get(`${TMDB_BASE}${endpoint}?${qs}`, {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    if (response.status === 401) {
        markProviderAuthFailed(TMDB_PROVIDER_ID, apiKey);
        throw new ProviderAuthError(TMDB_PROVIDER_ID, 'TMDB API key rejected (401)');
    }

    if (!response.ok) {
        throw Object.assign(
            new Error(
                `TMDB API request failed: ${response.status} ${response.statusText} — ${endpoint}`,
            ),
            { status: response.status },
        );
    }

    return (await response.json()) as TmdbItem;
}

// ---------------------------------------------------------------------------
// Search helpers (dispatch by type)
// ---------------------------------------------------------------------------

async function searchMovie(
    ctx: PluginContext,
    query: string,
    language: string,
    year?: number,
): Promise<TmdbItem[]> {
    const params: Record<string, string | number> = {
        query,
        language,
        page: 1,
    };
    if (year) params['primary_release_year'] = year;

    const data = await tmdbGet(ctx, '/search/movie', params);
    const results = (data['results'] as TmdbItem[] | undefined) ?? [];
    return results.map((r) => ({ ...r, media_type: 'movie' }));
}

async function searchTv(
    ctx: PluginContext,
    query: string,
    language: string,
    year?: number,
): Promise<TmdbItem[]> {
    const params: Record<string, string | number> = {
        query,
        language,
        page: 1,
    };
    if (year) params['first_air_date_year'] = year;

    const data = await tmdbGet(ctx, '/search/tv', params);
    const results = (data['results'] as TmdbItem[] | undefined) ?? [];
    return results.map((r) => ({ ...r, media_type: 'tv' }));
}

async function searchPerson(
    ctx: PluginContext,
    query: string,
    language: string,
): Promise<TmdbItem[]> {
    const data = await tmdbGet(ctx, '/search/person', {
        query,
        language,
        page: 1,
    });
    const results = (data['results'] as TmdbItem[] | undefined) ?? [];
    return results.map((r) => ({ ...r, media_type: 'person' }));
}

// ---------------------------------------------------------------------------
// Detail helpers (dispatch by id prefix)
// ---------------------------------------------------------------------------

/**
 * Parse the encoded id string into its components.
 *
 * Accepted forms:
 *   'movie:550'       → { kind: 'movie', tmdbId: 550 }
 *   'tv:1399'         → { kind: 'tv', tmdbId: 1399 }
 *   'tv:1399:s2'      → { kind: 'season', tmdbId: 1399, season: 2 }
 *   'tv:1399:s2:e5'   → { kind: 'episode', tmdbId: 1399, season: 2, episode: 5 }
 *   'person:1234'     → { kind: 'person', tmdbId: 1234 }
 */
function parseId(
    id: string,
):
    | { kind: 'movie'; tmdbId: number }
    | { kind: 'tv'; tmdbId: number }
    | { kind: 'season'; tmdbId: number; season: number }
    | { kind: 'episode'; tmdbId: number; season: number; episode: number }
    | { kind: 'person'; tmdbId: number }
    | null {
    const parts = id.split(':');
    const type = parts[0];

    if (type === 'movie' && parts.length === 2) {
        const tmdbId = parseInt(parts[1], 10);
        if (!isNaN(tmdbId)) return { kind: 'movie', tmdbId };
    }

    if (type === 'tv') {
        const tmdbId = parseInt(parts[1], 10);
        if (isNaN(tmdbId)) return null;

        if (parts.length === 2) return { kind: 'tv', tmdbId };

        if (parts.length >= 3 && parts[2].startsWith('s')) {
            const season = parseInt(parts[2].slice(1), 10);
            if (isNaN(season)) return null;

            if (parts.length === 3) return { kind: 'season', tmdbId, season };

            if (parts.length === 4 && parts[3].startsWith('e')) {
                const episode = parseInt(parts[3].slice(1), 10);
                if (!isNaN(episode)) return { kind: 'episode', tmdbId, season, episode };
            }
        }
    }

    if (type === 'person' && parts.length === 2) {
        const tmdbId = parseInt(parts[1], 10);
        if (!isNaN(tmdbId)) return { kind: 'person', tmdbId };
    }

    return null;
}

async function detailMovie(
    ctx: PluginContext,
    tmdbId: number,
    language: string,
): Promise<TmdbDetailResult> {
    const raw = await tmdbGet(ctx, `/movie/${tmdbId}`, {
        language,
        append_to_response:
            'credits,videos,keywords,images,translations,external_ids,release_dates',
    });
    return buildProviderDetailResult(raw, 'movie');
}

async function detailTv(
    ctx: PluginContext,
    tmdbId: number,
    language: string,
): Promise<TmdbDetailResult> {
    const raw = await tmdbGet(ctx, `/tv/${tmdbId}`, {
        language,
        // aggregate_credits: whole-run cast, the fallback when `credits`
        // (latest season only) is empty — see detail-coerce.ts.
        append_to_response:
            'credits,aggregate_credits,videos,keywords,images,translations,external_ids,content_ratings',
    });
    return buildProviderDetailResult(raw, 'tv');
}

async function detailSeason(
    ctx: PluginContext,
    tmdbId: number,
    season: number,
    language: string,
): Promise<TmdbItem> {
    return tmdbGet(ctx, `/tv/${tmdbId}/season/${season}`, {
        language,
        append_to_response: 'credits,videos',
    });
}

async function detailEpisode(
    ctx: PluginContext,
    tmdbId: number,
    season: number,
    episode: number,
    language: string,
): Promise<TmdbItem> {
    return tmdbGet(ctx, `/tv/${tmdbId}/season/${season}/episode/${episode}`, {
        language,
        append_to_response: 'credits,videos',
    });
}

async function detailPerson(
    ctx: PluginContext,
    tmdbId: number,
    language: string,
): Promise<TmdbItem> {
    return tmdbGet(ctx, `/person/${tmdbId}`, {
        language,
        append_to_response: 'movie_credits,tv_credits,images,external_ids',
    });
}

// ---------------------------------------------------------------------------
// childList helpers
// ---------------------------------------------------------------------------

/**
 * For 'tv:1399'    → return season stubs from the series detail response.
 * For 'tv:1399:s1' → return episode stubs from the season detail response.
 */
async function childListTv(
    ctx: PluginContext,
    parsed: { kind: 'tv'; tmdbId: number } | { kind: 'season'; tmdbId: number; season: number },
    language: string,
): Promise<TmdbItem[]> {
    if (parsed.kind === 'tv') {
        const data = await tmdbGet(ctx, `/tv/${parsed.tmdbId}`, { language });
        const seasons = (data['seasons'] as TmdbItem[] | undefined) ?? [];
        return seasons.map((s) => ({
            ...s,
            _parent_tmdb_id: parsed.tmdbId,
            media_type: 'tv_season',
        }));
    }

    // season → episodes
    const data = await detailSeason(ctx, parsed.tmdbId, parsed.season, language);
    const episodes = (data['episodes'] as TmdbItem[] | undefined) ?? [];
    return episodes.map((e) => ({
        ...e,
        _parent_tmdb_id: parsed.tmdbId,
        _season_number: parsed.season,
        media_type: 'tv_episode',
    }));
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

export const tmdbProvider = defineProvider<TmdbSearchParams, TmdbItem>({
    id: 'tmdb-metadata-provider',
    name: 'TMDB',
    version: '1.0.0',

    capabilities: { http: true, cache: true },

    rateLimit: { rps: 4 },

    metadata: {
        priority: 100,
        cacheTtlHours: 24,
        fieldAuthorities: {
            title: 10,
            overview: 10,
            poster_path: 10,
            backdrop_path: 10,
            genres: 10,
            keywords: 10,
            actors: 10,
            directors: 10,
            writers: 10,
            producers: 10,
            vote_average: 10,
            vote_count: 10,
            popularity: 10,
            release_date: 10,
            runtime_minutes: 10,
            certification: 10,
            tagline: 10,
            original_language: 10,
            production_countries: 10,
            spoken_languages: 10,
            budget: 10,
            revenue: 10,
            status: 10,
            homepage: 10,
            imdb_id: 10,
            trailer_url: 10,
            logo_path: 10,
            still_path: 10,
            profile_path: 10,
            total_episodes: 10,
            total_seasons: 10,
            series_status: 10,
            last_air_date: 10,
            next_episode_to_air: 10,
            networks: 10,
            created_by: 10,
            imdb_rating: 10,
            rt_rating: 10,
        },
    },

    // No settings of its own: TMDB_API_KEY and TMDB_LANGUAGE are host
    // settings (Settings → Providers → Connections). Plugin copies used to win
    // over them for this provider only, while the rest of the app read the
    // host values — two languages/keys for one install.

    async isConfigured(): Promise<boolean> {
        return !!config.TMDB_API_KEY?.trim();
    },

    /**
     * Search TMDB for movies, TV shows, or people.
     *
     * Dispatches to the type-specific endpoint (/search/movie, /search/tv,
     * /search/person) rather than /search/multi so callers get back results
     * pre-filtered by type. Each result is tagged with a `media_type` field
     * consistent with the TMDB multi-search shape.
     */
    async search(ctx, params): Promise<TmdbItem[]> {
        const language = resolveLanguage(params.language);
        switch (params.type) {
            case 'movie':
                return searchMovie(ctx, params.query, language, params.year);
            case 'tv':
                return searchTv(ctx, params.query, language, params.year);
            case 'person':
                return searchPerson(ctx, params.query, language);
        }
    },

    /**
     * Fetch full TMDB details for the encoded id.
     *
     * Movie and TV series calls include append_to_response with credits,
     * videos, keywords, images, translations, and external_ids — all in a
     * single HTTP round-trip. The raw TMDB response is enriched with the
     * provider-neutral `ProviderDetailResult` fields so callers can read
     * structured data (genreNames, keywordSlugs, cast, artwork, …) without
     * re-parsing raw TMDB key names. Raw TMDB fields are preserved alongside
     * the neutral overlay for callers that still read them directly.
     *
     * Season and episode calls include credits and videos only; person calls
     * include movie_credits, tv_credits, images, and external_ids. These
     * sub-resource kinds do NOT populate the neutral overlay (only movie/tv do).
     *
     * Throws on unknown id format or HTTP errors.
     */
    async detail(ctx, id): Promise<TmdbDetailResult> {
        const parsed = parseId(id);
        if (!parsed) throw new Error(`tmdb: unrecognised id format: "${id}"`);

        const language = resolveLanguage();

        switch (parsed.kind) {
            case 'movie':
                return detailMovie(ctx, parsed.tmdbId, language);
            case 'tv':
                return detailTv(ctx, parsed.tmdbId, language);
            case 'season':
                return detailSeason(ctx, parsed.tmdbId, parsed.season, language);
            case 'episode':
                return detailEpisode(ctx, parsed.tmdbId, parsed.season, parsed.episode, language);
            case 'person':
                return detailPerson(ctx, parsed.tmdbId, language);
        }
    },

    /**
     * List child items for a TV series or season.
     *
     * Accepts:
     *   'tv:1399'     → list of season stubs (from series detail response)
     *   'tv:1399:s1'  → list of episode stubs (from season detail response)
     *
     * Throws on unsupported parent id formats (movies, people, episodes).
     */
    async childList(ctx, parentId): Promise<TmdbItem[]> {
        const parsed = parseId(parentId);
        if (!parsed) throw new Error(`tmdb childList: unrecognised id format: "${parentId}"`);

        if (parsed.kind === 'tv' || parsed.kind === 'season') {
            const language = resolveLanguage();
            return childListTv(ctx, parsed, language);
        }

        throw new Error(
            `tmdb childList: unsupported parent kind "${parsed.kind}" — only 'tv' and 'season' are supported`,
        );
    },

    /**
     * Catalog-browse / discover endpoint. Delegates to the existing
     * `tmdbApi.discoverMovies` / `tmdbApi.discoverTVShows` calls so
     * behaviour is identical to the direct-tmdbApi callers in the codebase.
     *
     * Callers reach this via `invokeProviderDiscover('tmdb-metadata-provider', params)`.
     */
    async discover(
        _ctx: PluginContext,
        params: ProviderDiscoverParams,
    ): Promise<ProviderDiscoverResult[]> {
        const page = params.page ?? 1;

        // When keywordIds are present, delegate to the holiday-discover path
        // that maps them to TMDB's `with_keywords` filter — the generic
        // discoverMovies/discoverTVShows helpers don't accept keywordIds.
        if (params.keywordIds && params.keywordIds.length > 0) {
            const response =
                params.mediaType === 'movie'
                    ? await tmdbApi.discoverHolidayMovies({
                          keywordIds: params.keywordIds,
                          page,
                          sortBy: params.sortBy,
                          minVoteAverage: params.minVoteAverage,
                          minVoteCount: params.minVoteCount,
                      })
                    : await tmdbApi.discoverHolidayTVShows({
                          keywordIds: params.keywordIds,
                          page,
                          sortBy: params.sortBy,
                          minVoteAverage: params.minVoteAverage,
                          minVoteCount: params.minVoteCount,
                      });
            return (response.results ?? []).map((r): ProviderDiscoverResult => ({
                ...r,
                media_type: params.mediaType,
            }));
        }

        const opts: {
            page: number;
            genre_ids?: number[];
            sort_by?: string;
            min_vote_average?: number;
            min_vote_count?: number;
        } = { page };
        if (params.genreIds && params.genreIds.length > 0) opts.genre_ids = params.genreIds;
        if (params.sortBy) opts.sort_by = params.sortBy;
        if (params.minVoteAverage !== undefined) opts.min_vote_average = params.minVoteAverage;
        if (params.minVoteCount !== undefined) opts.min_vote_count = params.minVoteCount;

        const response =
            params.mediaType === 'movie'
                ? await tmdbApi.discoverMovies(opts)
                : await tmdbApi.discoverTVShows(opts);

        return (response.results ?? []).map((r): ProviderDiscoverResult => ({
            ...r,
            media_type: params.mediaType,
        }));
    },

    /**
     * Trending endpoint. Delegates to `tmdbApi.getTrendingMoviesTimeWindow` /
     * `tmdbApi.getTrendingTVShowsTimeWindow` so behaviour is identical to
     * the direct-tmdbApi callers in the codebase.
     *
     * Callers reach this via `invokeProviderTrending('tmdb-metadata-provider', params)`.
     */
    async getTrending(
        _ctx: PluginContext,
        params: ProviderTrendingParams,
    ): Promise<ProviderDiscoverResult[]> {
        const window = params.window ?? 'week';
        const page = params.page ?? 1;

        const response =
            params.mediaType === 'movie'
                ? await tmdbApi.getTrendingMoviesTimeWindow(window, page)
                : await tmdbApi.getTrendingTVShowsTimeWindow(window, page);

        return (response.results ?? []).map((r): ProviderDiscoverResult => ({
            ...r,
            media_type: params.mediaType,
        }));
    },

    /**
     * Popular endpoint. Delegates to `tmdbApi.getPopularMovies` /
     * `tmdbApi.getPopularTVShows` so behaviour is identical to the
     * direct-tmdbApi callers in the codebase.
     *
     * Callers reach this via `invokeProviderPopular('tmdb-metadata-provider', params)`.
     */
    async getPopular(
        _ctx: PluginContext,
        params: ProviderPopularParams,
    ): Promise<ProviderDiscoverResult[]> {
        const page = params.page ?? 1;

        const response =
            params.mediaType === 'movie'
                ? await tmdbApi.getPopularMovies(page)
                : await tmdbApi.getPopularTVShows(page);

        return (response.results ?? []).map((r): ProviderDiscoverResult => ({
            ...r,
            media_type: params.mediaType,
        }));
    },

    /**
     * Top-rated endpoint. Delegates to `tmdbApi.getTopRatedMovies` /
     * `tmdbApi.getTopRatedTVShows` so behaviour is identical to the
     * direct-tmdbApi callers in the codebase.
     *
     * Callers reach this via `invokeProviderTopRated('tmdb-metadata-provider', params)`.
     */
    async getTopRated(
        _ctx: PluginContext,
        params: ProviderTopRatedParams,
    ): Promise<ProviderDiscoverResult[]> {
        const page = params.page ?? 1;

        const response =
            params.mediaType === 'movie'
                ? await tmdbApi.getTopRatedMovies(page)
                : await tmdbApi.getTopRatedTVShows(page);

        return (response.results ?? []).map((r): ProviderDiscoverResult => ({
            ...r,
            media_type: params.mediaType,
        }));
    },

    /**
     * Cross-id resolution via TMDB's `/find/{external_id}` endpoint.
     *
     * Delegates to `tmdbApi.findByExternalId` (gated on `tmdbApi.isAvailable()`)
     * and maps the raw match into the provider-neutral `ProviderResolveExternalIdResult`
     * shape. Returns null on any miss, unavailability, or error.
     *
     * Supported sources: 'imdb', 'tvdb', 'facebook', 'instagram', 'twitter'.
     * TMDB's `/find` endpoint rejects unsupported sources with a 400, caught
     * and returned as null.
     *
     * Callers reach this via
     * `invokeProviderResolveExternalId('tmdb-metadata-provider', externalId, source, mediaType)`.
     */
    /**
     * Fetch person detail (biography + filmography credits) for a TMDB person id.
     *
     * Delegates to `detailPerson`, which fetches
     * `/person/{tmdbId}?append_to_response=movie_credits,tv_credits,images,external_ids`
     * in a single round-trip. The raw TMDB response is returned so callers
     * can read both the provider-neutral biography fields and the raw
     * `movie_credits.cast` / `tv_credits.cast` arrays.
     *
     * Callers reach this via
     * `invokeProviderGetPersonDetail('tmdb-metadata-provider', personId)`.
     */
    async getPersonDetail(ctx: PluginContext, personId: number): Promise<TmdbItem> {
        const language = resolveLanguage();
        return detailPerson(ctx, personId, language);
    },

    async resolveExternalId(
        ctx: PluginContext,
        externalId: string,
        source: ProviderExternalIdSource,
        mediaType: 'movie' | 'tv',
    ): Promise<ProviderResolveExternalIdResult | null> {
        // Call findByExternalId directly (rather than tmdbResolveExternalId)
        // so we can surface originalTitle and releaseDate for the title-similarity
        // gate in auto-identify — those fields are stripped by the MetadataCandidate
        // normaliser that tmdbResolveExternalId returns.
        if (!tmdbApi.isAvailable()) return null;
        try {
            const tmdbSource = `${source}_id` as
                'imdb_id' | 'tvdb_id' | 'facebook_id' | 'instagram_id' | 'twitter_id';
            const result = await tmdbApi.findByExternalId(externalId, tmdbSource);
            const matches = mediaType === 'movie' ? result.movie_results : result.tv_results;
            const match = matches[0];
            if (!match || match.id == null) return null;
            const isMovieType = mediaType === 'movie';
            return {
                externalId: String(match.id),
                title: (isMovieType ? match.title : match.name) ?? undefined,
                originalTitle:
                    (isMovieType ? match.original_title : match.original_name) ?? undefined,
                releaseDate: (isMovieType ? match.release_date : match.first_air_date) ?? undefined,
            };
        } catch (err) {
            // A cancelled run must propagate immediately — it is not a "no
            // cross-reference" answer. Note: the current sole caller,
            // `invokeProviderResolveExternalId` in plugin-context.ts, wraps
            // this whole call in its own try/catch that treats ANY throw
            // (including this rethrown abort) as a miss and returns null —
            // so this rethrow does not yet change externally-observable
            // behavior for that caller. It is still the locally correct
            // fix: it stops resolveExternalId itself from mistaking a
            // cancellation for "TMDB has no crossref", and it's the
            // correct contract if a future caller invokes this method
            // directly instead of through that wrapper.
            const e = err as Error & { name?: string };
            if (e?.name === 'AbortError' || e?.name === 'CancelError') throw err;
            // Previously a bare `catch { return null; }` — any failure
            // (network error, TMDB 5xx, malformed response) silently
            // collapsed into the same "no crossref" null that a genuine
            // miss returns, with no log trail. Log before returning null so
            // an outage is at least visible; null stays the contract since
            // callers (auto-identify.service.ts) rely on it to fall through
            // to Phase 2 title search.
            ctx.logger.warn('tmdb resolveExternalId failed — treating as no crossref', {
                externalId,
                source,
                mediaType,
                err: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerProvider(tmdbProvider);
