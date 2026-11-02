// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '$lib/server/config';
import { Logger } from '../../../utils/logger.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { recordProviderRetry } from '../../../utils/provider-calls.js';
import { trackExternalCall } from '../../../utils/external-request-counter.js';
import { isMovie, isSeries } from '../../../../utils/media-types.js';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
import { withHttpRetry, parseRetryAfterHeader } from '../../../utils/http-retry.js';
import { getBreaker } from '../../../utils/circuit-breaker.js';
import { cachedTmdbResponse, peekTmdbResponse, tmdbResponseCacheKey } from './response-cache.js';
import { isTmdbBearerToken, tmdbAuthorizedRequest } from './auth.js';
import { tmdbTransportCodes } from './transport-errors.js';

const logger = Logger.for('TmdbApi');

/**
 * `append_to_response` of getTVShowDetails. `keywords` lets discovery/enrichment
 * persist TMDB keyword names + numeric ids (metadata.tmdb_keyword_ids) for
 * DB-backed browse; `aggregate_credits` is the whole-run cast, the fallback when
 * `credits` (latest season only) is empty — see detail-coerce.ts. Shared with
 * getTVShowSeasonsResult, which reads its season list from this response's
 * cache entry.
 */
const TV_DETAIL_PARAMS = {
    append_to_response:
        'credits,aggregate_credits,videos,images,translations,keywords,content_ratings',
} as const;

/**
 * Structured TMDB error. Surfaces the HTTP status (and, for 429s, the
 * `Retry-After` header value) so callers can classify transient vs. permanent
 * failures by numeric status instead of parsing the .message regex. The
 * legacy `TMDB API request failed: <status>` message format is preserved so
 * older regex-based callers still work.
 */
export class TmdbApiError extends Error {
    readonly status: number | null;
    /** Parsed Retry-After in milliseconds, if the server supplied one on 429. */
    readonly retryAfterMs: number | null;
    /** True for `auth-fatal` errors — the API key is rejected. */
    readonly authFatal: boolean;

    constructor(
        message: string,
        opts: {
            status: number | null;
            retryAfterMs?: number | null;
            authFatal?: boolean;
        },
    ) {
        super(message);
        this.name = 'TmdbApiError';
        this.status = opts.status;
        this.retryAfterMs = opts.retryAfterMs ?? null;
        this.authFatal = opts.authFatal ?? false;
    }
}

/** One season as summarized by {@link TMDBApiService.getTVShowSeasons}. */
export interface TmdbSeasonSummary {
    seasonNumber: number;
    name: string;
    episodeCount: number;
    overview?: string;
    airDate?: string;
    posterPath?: string;
}

/**
 * Outcome of a season lookup that keeps WHY it failed.
 *
 * - `ok: true`   — TMDB answered. `seasons` may be empty; that is then a fact
 *                  about the series itself, and re-asking will not change it.
 * - `not-found`  — TMDB answered 404: this series id does not exist. Terminal.
 * - `unavailable`— the request failed (429/5xx/network/timeout/bad key). Says
 *                  nothing about the series; retry later.
 */
export type TvSeasonsResult =
    | { ok: true; seasons: TmdbSeasonSummary[] }
    | { ok: false; reason: 'not-found' | 'unavailable'; message: string };

/** Local alias — delegates to the shared util in http-retry.ts. */
const parseRetryAfter = parseRetryAfterHeader;

export interface TMDBSearchResult {
    id: number;
    media_type: 'movie' | 'tv';
    title?: string;
    name?: string;
    original_title?: string;
    original_name?: string;
    overview?: string;
    poster_path?: string;
    backdrop_path?: string;
    release_date?: string;
    first_air_date?: string;
    genre_ids?: number[];
    vote_average?: number;
    vote_count?: number;
    popularity?: number;
}

/** Single image entry from TMDB /images response */
export interface TMDBImage {
    aspect_ratio: number;
    height: number;
    width: number;
    file_path: string;
    iso_639_1: string | null;
    vote_average: number;
    vote_count: number;
}

export interface TMDBMovieDetails extends TMDBSearchResult {
    genres?: TMDBGenre[];
    runtime?: number;
    production_countries?: TMDBProductionCountry[];
    production_companies?: TMDBProductionCompany[];
    spoken_languages?: TMDBSpokenLanguage[];
    credits?: TMDBCredits;
    external_ids?: TMDBExternalIds;
    keywords?: TMDBKeywordsResponse;
    networks?: TMDBNetwork[];
    videos?: { results?: TMDBVideoResult[] };
    images?: {
        backdrops?: TMDBImage[];
        logos?: TMDBImage[];
        posters?: TMDBImage[];
    };
    adult?: boolean;
    original_language?: string;
    translations?: TMDBTranslationsResponse;
}

/** Single translation entry from TMDB /translations response */
export interface TMDBTranslation {
    iso_639_1: string;
    iso_3166_1: string;
    name: string;
    english_name: string;
    data: {
        title?: string;
        name?: string;
        overview?: string;
        tagline?: string;
    };
}

/** TMDB translations response */
export interface TMDBTranslationsResponse {
    translations?: TMDBTranslation[];
}

export interface TMDBVideoResult {
    key: string;
    site: string;
    type: string;
    name: string;
    size: number;
    official: boolean;
}

/** TMDB cast member from credits response */
export interface TMDBCastMember {
    id: number;
    name: string;
    character?: string;
    order?: number;
    profile_path?: string;
}

/** TMDB crew member from credits response */
export interface TMDBCrewMember {
    id: number;
    name: string;
    job: string;
    department?: string;
    profile_path?: string;
}

/** TMDB credits response */
export interface TMDBCredits {
    cast?: TMDBCastMember[];
    crew?: TMDBCrewMember[];
}

/** TMDB genre */
export interface TMDBGenre {
    id: number;
    name: string;
}

/** TMDB keyword */
export interface TMDBKeyword {
    id: number;
    name: string;
}

/** TMDB keywords response (different structure for movies vs TV) */
export interface TMDBKeywordsResponse {
    keywords?: TMDBKeyword[];
    results?: TMDBKeyword[];
}

/** TMDB network (for TV shows) */
export interface TMDBNetwork {
    id: number;
    name: string;
    logo_path?: string;
}

/** TMDB production country */
export interface TMDBProductionCountry {
    iso_3166_1: string;
    name: string;
}

/** TMDB production company */
export interface TMDBProductionCompany {
    id: number;
    name: string;
    logo_path?: string;
    origin_country?: string;
}

/** TMDB spoken language */
export interface TMDBSpokenLanguage {
    iso_639_1: string;
    name: string;
    english_name?: string;
}

/** TMDB external IDs */
export interface TMDBExternalIds {
    imdb_id?: string;
    tvdb_id?: number;
    facebook_id?: string;
    instagram_id?: string;
    twitter_id?: string;
}

/** One episode as returned by {@link TMDBApiService.getSeasonEpisodes}. */
export interface TmdbSeasonEpisode {
    id: number;
    name: string;
    episodeNumber: number;
    seasonNumber: number;
    overview?: string;
    airDate?: string;
    stillPath?: string;
    runtimeMinutes?: number;
}

/** TMDB allows at most 20 `append_to_response` entries per request. */
const TMDB_MAX_APPENDS = 20;

export interface TMDBSeason {
    season_number: number;
    name?: string;
    episode_count?: number;
    overview?: string;
    air_date?: string;
    poster_path?: string;
}

export interface TMDBSeasonResponse {
    seasons?: TMDBSeason[];
}

export interface TMDBEpisode {
    id: number;
    name?: string;
    episode_number: number;
    season_number?: number;
    overview?: string;
    air_date?: string;
    still_path?: string;
    runtime?: number;
}

export interface TMDBSeasonEpisodesResponse {
    episodes?: TMDBEpisode[];
}

export interface TMDBVideoResponse {
    results?: TMDBVideoResult[];
}

export interface TMDBGenreListResponse {
    genres?: TMDBGenre[];
}

export interface TMDBCollectionDetails {
    id: number;
    name: string;
    overview?: string;
    poster_path?: string;
    backdrop_path?: string;
    parts?: TMDBSearchResult[];
}

// =============================================================================
// Episode Groups Types (for alternative episode orderings)
// =============================================================================

/**
 * Episode group types from TMDB
 * Used for alternative episode orderings like absolute, DVD, regional
 */
export type TMDBEpisodeGroupType =
    | 1 // Original air date
    | 2 // Absolute
    | 3 // DVD
    | 4 // Digital
    | 5 // Story arc
    | 6 // Production
    | 7; // TV

/**
 * Episode group summary (from /tv/{id}/episode_groups)
 */
export interface TMDBEpisodeGroupSummary {
    id: string; // UUID string like "5acf93e60e0a26346d0000ce"
    name: string;
    type: TMDBEpisodeGroupType;
    description?: string;
    episode_count: number;
    group_count: number; // Number of groups (seasons) in this ordering
    network?: TMDBNetwork;
}

/**
 * Episode groups list response
 */
export interface TMDBEpisodeGroupsResponse {
    results?: TMDBEpisodeGroupSummary[];
    id: number; // TV series ID
}

/**
 * Episode within an episode group
 */
export interface TMDBEpisodeGroupEpisode {
    id: number;
    name?: string;
    overview?: string;
    air_date?: string;
    episode_number: number; // Position within the group
    season_number: number; // Original season number
    still_path?: string;
    runtime?: number;
    order: number; // Order within the group (0-indexed)
}

/**
 * Group (like a season) within an episode group
 */
export interface TMDBEpisodeGroupGroup {
    id: string; // UUID string
    name?: string;
    order: number; // 0-indexed order
    episodes: TMDBEpisodeGroupEpisode[];
    locked: boolean;
}

/**
 * Full episode group details (from /tv/episode_group/{id})
 */
export interface TMDBEpisodeGroupDetails {
    id: string;
    name: string;
    type: TMDBEpisodeGroupType;
    description?: string;
    episode_count: number;
    group_count: number;
    groups: TMDBEpisodeGroupGroup[];
    network?: TMDBNetwork;
}

const TMDB_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Classify a thrown `TmdbApiError` for the retry loop.
 * - 429 → retryable, honor Retry-After
 * - 5xx → retryable
 * - null status (network/timeout) → retryable
 * - authFatal / other 4xx → permanent, bail immediately
 * - AbortError → not retryable (caller is cancelling)
 */
function classifyTmdbError(err: unknown): { retryable: boolean; retryAfterMs: number | null } {
    if (err instanceof TmdbApiError) {
        if (err.authFatal) return { retryable: false, retryAfterMs: null };
        const { status } = err;
        if (status === null) return { retryable: true, retryAfterMs: null };
        if (status === 429) return { retryable: true, retryAfterMs: err.retryAfterMs };
        if (status >= 500) return { retryable: true, retryAfterMs: null };
        return { retryable: false, retryAfterMs: null };
    }
    // AbortError → never retry
    if (err instanceof Error && err.name === 'AbortError') {
        return { retryable: false, retryAfterMs: null };
    }
    // Unknown non-TmdbApiError → treat as network transient
    return { retryable: true, retryAfterMs: null };
}

/**
 * Centralized TMDB API Service
 *
 * Handles all TMDB API interactions with:
 * - Unified authentication (Bearer token + API key fallback)
 * - Standardized error handling and rate limiting
 * - Consistent response formatting
 * - Centralized configuration
 */
export class TMDBApiService {
    private readonly baseUrl = 'https://api.themoviedb.org/3';
    private readonly imageBaseUrl = 'https://image.tmdb.org/t/p';
    /** Set for a client built for one language (createTMDBApi(lang)). */
    private readonly explicitLanguage: string | undefined;

    /**
     * The bare `tmdbApi` singleton follows TMDB_LANGUAGE live (it is built at
     * import, and the language is a saved setting); an explicit per-client
     * language wins.
     */
    private get language(): string {
        return this.explicitLanguage ?? config.TMDB_LANGUAGE;
    }

    /**
     * The key an auth failure was recorded against, or null if none.
     *
     * Keyed rather than a bare boolean so that CORRECTING a bad key clears the
     * latch by itself. `config.TMDB_API_KEY` is settable at runtime (admin UI ->
     * settings.json), so a boolean latch would keep the client dead until a
     * process restart even after the operator fixed the key.
     */
    private authFailedForKey: string | null = null;

    /**
     * Read LIVE on every access — never captured.
     *
     * `config.TMDB_API_KEY` is a getter resolving settings.json -> env -> default
     * at call time. Capturing it in the constructor froze it at process boot,
     * because the `tmdbApi` singleton is built at module import; an operator who
     * entered their key in the admin UI afterwards stayed unavailable until a
     * restart. Season posters were the visible casualty — the only artwork slot
     * that needs a live TMDB call.
     */
    private get apiKey(): string {
        return config.TMDB_API_KEY;
    }

    constructor(language?: string) {
        this.explicitLanguage = language;

        if (!this.apiKey) {
            logger.warn('TMDB API key not configured');
        }
    }

    /**
     * A detail GET through the response cache. Bypassed while the client is
     * unavailable (no key / key known bad), so a cache hit can never paper over
     * the auth failure makeRequest would raise.
     */
    private cachedDetail<T>(
        endpoint: string,
        params: Record<string, string | number>,
        options: { signal?: AbortSignal; fresh?: boolean },
    ): Promise<T> {
        if (!this.isAvailable()) return this.makeRequest<T>(endpoint, params, options);
        return cachedTmdbResponse(
            tmdbResponseCacheKey(this.language, endpoint, params),
            () => this.makeRequest<T>(endpoint, params, { signal: options.signal }),
            options,
        );
    }

    /**
     * Check if TMDB API is configured and available
     */
    public isAvailable(): boolean {
        const key = this.apiKey;
        return !!key && this.authFailedForKey !== key;
    }

    /**
     * Make authenticated request to TMDB API with automatic fallback.
     * Tries Bearer token first, falls back to API key parameter.
     *
     * On error throws `TmdbApiError` with the HTTP status (for 4xx/5xx) or
     * a null status (for network-layer failures and aborts) so callers can
     * branch on numeric status instead of regex-matching the message. The
     * legacy "TMDB API request failed: <status>" message format is kept so
     * older string-regex callers continue to work.
     *
     * `options.signal` — when present, is composed into the outgoing fetch
     * so the caller can cancel mid-flight (soft-budget pre-emption from the
     * sync drain, or explicit admin-triggered abort).
     */
    private async makeRequest<T>(
        endpoint: string,
        params: Record<string, string | number> = {},
        options: { signal?: AbortSignal } = {},
    ): Promise<T> {
        if (!this.apiKey) {
            throw new TmdbApiError('TMDB API key not configured', {
                status: null,
                authFatal: true,
            });
        }

        // Don't make requests if we already know auth is invalid
        if (this.authFailedForKey === this.apiKey) {
            throw new TmdbApiError('TMDB API key is invalid', {
                status: 401,
                authFatal: true,
            });
        }

        // TMDB otherwise filters appended images to the text language alone.
        // Include English and neutral artwork on sync, discovery and append paths.
        const hasImages =
            typeof params.append_to_response === 'string' &&
            params.append_to_response.split(',').includes('images');
        const queryParams = {
            language: this.language,
            ...(hasImages && {
                include_image_language: [
                    ...new Set([this.language.split('-')[0], 'en', 'null']),
                ].join(','),
            }),
            ...params,
        };

        // v4 Read Access Token -> Bearer header, v3 key -> ?api_key= (auth.ts)
        const isBearerToken = isTmdbBearerToken(this.apiKey);
        const authorized = tmdbAuthorizedRequest(
            `${this.baseUrl}${endpoint}?${new URLSearchParams(
                Object.entries(queryParams).map(([k, v]) => [k, String(v)]),
            )}`,
            this.apiKey,
            { 'Content-Type': 'application/json' },
        );
        const url = authorized.url;
        const fetchOptions: RequestInit = { headers: authorized.headers };

        let httpAttempt = 0;
        const attemptFetch = async (): Promise<T> => {
            if (httpAttempt++ > 0) recordProviderRetry('tmdb');
            // Each HTTP send gets a fresh timeout from fetchWithTimeout.
            // Keep the caller signal separate so provider timeouts count as
            // network errors while caller cancellation does not.
            try {
                const response = await trackExternalCall(
                    url,
                    () =>
                        fetchWithTimeout(
                            url,
                            { ...fetchOptions, signal: options.signal },
                            TMDB_REQUEST_TIMEOUT_MS,
                        ),
                    options.signal,
                );

                if (!response.ok) {
                    // If Bearer token failed, try fallback to API key method
                    if (isBearerToken && response.status === 401) {
                        const fallbackUrl = `${this.baseUrl}${endpoint}?${new URLSearchParams({
                            ...Object.fromEntries(
                                Object.entries(queryParams).map(([k, v]) => [k, String(v)]),
                            ),
                            api_key: this.apiKey.trim(),
                        })}`;

                        const fallbackResponse = await trackExternalCall(
                            fallbackUrl,
                            () =>
                                fetchWithTimeout(
                                    fallbackUrl,
                                    {
                                        headers: { 'Content-Type': 'application/json' },
                                        signal: options.signal,
                                    },
                                    TMDB_REQUEST_TIMEOUT_MS,
                                ),
                            options.signal,
                        );

                        if (!fallbackResponse.ok) {
                            // Both methods failed with 401 - API key is invalid
                            if (fallbackResponse.status === 401) {
                                this.authFailedForKey = this.apiKey;
                                logger.warn('TMDB API key is invalid - disabling TMDB features');
                                throw new TmdbApiError('TMDB API key is invalid', {
                                    status: 401,
                                    authFatal: true,
                                });
                            }
                            throw new TmdbApiError(
                                `TMDB API request failed: ${fallbackResponse.status} ${fallbackResponse.statusText}`,
                                {
                                    status: fallbackResponse.status,
                                    retryAfterMs:
                                        fallbackResponse.status === 429
                                            ? parseRetryAfter(
                                                  fallbackResponse.headers.get('Retry-After'),
                                              )
                                            : null,
                                },
                            );
                        }

                        return (await fallbackResponse.json()) as T;
                    }

                    // Non-bearer token 401 - mark auth as failed
                    if (response.status === 401) {
                        this.authFailedForKey = this.apiKey;
                        logger.warn('TMDB API key is invalid - disabling TMDB features');
                        throw new TmdbApiError('TMDB API key is invalid', {
                            status: 401,
                            authFatal: true,
                        });
                    }

                    throw new TmdbApiError(
                        `TMDB API request failed: ${response.status} ${response.statusText}`,
                        {
                            status: response.status,
                            retryAfterMs:
                                response.status === 429
                                    ? parseRetryAfter(response.headers.get('Retry-After'))
                                    : null,
                        },
                    );
                }

                return (await response.json()) as T;
            } catch (error) {
                // Rethrow TmdbApiError untouched; wrap anything else so the
                // status-based classifier can still see a structured shape.
                if (error instanceof TmdbApiError) {
                    if (!error.authFatal) {
                        logger.error('TMDB request failed', error, { endpoint });
                    }
                    throw error;
                }
                const err = error as Error;
                const transportCodes = tmdbTransportCodes(error);
                logger.error('TMDB request failed', err, { endpoint, transportCodes });
                const message = transportCodes.length
                    ? `TMDB transport failed: ${transportCodes.join(', ')}`
                    : err.message || 'TMDB request failed';
                throw new TmdbApiError(message, {
                    status: null,
                });
            }
        };

        // The retry loop is cancelled by the CALLER's signal only — a per-attempt
        // timeout (inside attemptFetch) must NOT abort the loop, so a slow attempt
        // is retried with a fresh timeout rather than failing the whole request.
        //
        // The circuit breaker wraps the entire retry call so only exhausted
        // transient failures (after all retries) trip the counter.  Auth/4xx
        // errors are excluded via the isTransient predicate.
        const breaker = getBreaker('tmdb');
        return breaker.execute(
            () =>
                withHttpRetry(attemptFetch, {
                    classify: classifyTmdbError,
                    signal: options.signal,
                }),
            (err) => classifyTmdbError(err).retryable,
        );
    }

    /**
     * Search for movies, TV shows, or people
     */
    async searchMulti(
        query: string,
        page = 1,
    ): Promise<{
        results: TMDBSearchResult[];
        total_pages: number;
        total_results: number;
    }> {
        return this.makeRequest('/search/multi', { query, page });
    }

    /**
     * Get popular movies
     */
    async getPopularMovies(
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/movie/popular', { page });
    }

    /**
     * Get popular TV shows
     */
    async getPopularTVShows(
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/tv/popular', { page });
    }

    /**
     * Get trending movies for the week
     */
    async getTrendingMovies(
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/trending/movie/week', { page });
    }

    /**
     * Get trending TV shows for the week
     */
    async getTrendingTVShows(
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/trending/tv/week', { page });
    }

    /**
     * Get movie details by TMDB ID. Accepts an optional `AbortSignal` so
     * callers (e.g. the TMDB-metadata sync drain under soft-budget pressure)
     * can cancel the HTTP round-trip immediately instead of waiting for the
     * fetch to return.
     */
    async getMovieDetails(
        tmdbId: number,
        options: { signal?: AbortSignal; fresh?: boolean } = {},
    ): Promise<TMDBMovieDetails> {
        const params = {
            // `keywords` appended so the discovery/enrichment paths can persist
            // TMDB keyword names + numeric IDs (metadata.tmdb_keyword_ids) that
            // DB-backed browse/keywords matches on. Small payload; harmless for
            // callers that ignore it. `release_dates` carries the per-country
            // certifications (FSK, MPAA, ...) the age rating is derived from.
            append_to_response: 'credits,videos,images,translations,keywords,release_dates',
        };
        return this.cachedDetail(`/movie/${tmdbId}`, params, options);
    }

    /**
     * Get TV show details by TMDB ID. Accepts an optional `AbortSignal` —
     * see `getMovieDetails` for the rationale.
     */
    async getTVShowDetails(
        tmdbId: number,
        options: { signal?: AbortSignal; fresh?: boolean } = {},
    ): Promise<TMDBMovieDetails> {
        return this.cachedDetail(`/tv/${tmdbId}`, TV_DETAIL_PARAMS, options);
    }

    /**
     * Get TV show seasons with episode counts, PRESERVING why an empty answer
     * is empty.
     *
     * `getTVShowSeasons` collapses every failure into `[]`, which makes
     * "TMDB says this series id does not exist" indistinguishable from
     * "TMDB was rate-limited". Callers that must decide whether to retry
     * forever or give up need that distinction — see
     * `provider-artwork-backfill.ts`, where a 404 series burned 17 retries
     * because the swallow made the failure look transient.
     *
     * `ok: true` means TMDB ANSWERED — `seasons` may still be empty, and that
     * emptiness is then a fact about the series, not about the request.
     */
    async getTVShowSeasonsResult(tmdbId: number): Promise<TvSeasonsResult> {
        try {
            // The season-poster stage runs once per season right after series-sync,
            // so the series' full detail response (a superset of plain /tv/{id})
            // is usually still in the response cache: read the season list from
            // it. On a miss, fetch the LIGHT /tv/{id} as before — not the heavy
            // append payload just to read `seasons`.
            const data =
                (this.isAvailable()
                    ? peekTmdbResponse<TMDBSeasonResponse>(
                          tmdbResponseCacheKey(this.language, `/tv/${tmdbId}`, TV_DETAIL_PARAMS),
                      )
                    : undefined) ?? (await this.makeRequest<TMDBSeasonResponse>(`/tv/${tmdbId}`));

            const seasons = Array.isArray(data.seasons) ? data.seasons : [];

            return {
                ok: true,
                seasons: seasons
                    .map((season) => ({
                        seasonNumber: season.season_number,
                        name: season.name || `Season ${season.season_number}`,
                        episodeCount: season.episode_count || 0,
                        overview: season.overview,
                        airDate: season.air_date,
                        posterPath: season.poster_path,
                    }))
                    .sort((a, b) => a.seasonNumber - b.seasonNumber),
            };
        } catch (error) {
            logger.error('Failed to get TV show seasons', error as Error, {
                tmdbId,
            });
            // 404 is TMDB answering definitively: no such series id. Every other
            // status is a statement about the REQUEST, not the series — 429/5xx
            // and network/timeout (`status === null`) are transient, and an
            // auth-fatal key is a GLOBAL outage that must never be charged to a
            // single item. Mirrors `classifyTmdbError`'s retryable split, except
            // that non-404 4xx (e.g. 422) stays `unavailable`: it means the call
            // was malformed, which a caller must not read as "series is gone".
            if (error instanceof TmdbApiError && !error.authFatal && error.status === 404) {
                return { ok: false, reason: 'not-found', message: error.message };
            }
            return {
                ok: false,
                reason: 'unavailable',
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Get TV show seasons with episode counts.
     *
     * Lenient: any failure yields `[]`. Callers that need to tell "no such
     * series" apart from "TMDB unreachable" must use
     * {@link getTVShowSeasonsResult} instead.
     *
     * @param tmdbId - The TMDB TV show ID
     * @returns Array of seasons with episode counts
     */
    async getTVShowSeasons(tmdbId: number): Promise<TmdbSeasonSummary[]> {
        const result = await this.getTVShowSeasonsResult(tmdbId);
        return result.ok ? result.seasons : [];
    }

    /**
     * Get episodes for a specific season of a TV show
     */
    async getSeasonEpisodes(
        tmdbId: number,
        seasonNumber: number,
    ): Promise<
        {
            id: number;
            name: string;
            episodeNumber: number;
            seasonNumber: number;
            overview?: string;
            airDate?: string;
            stillPath?: string;
            runtimeMinutes?: number;
        }[]
    > {
        try {
            const data = await this.makeRequest<TMDBSeasonEpisodesResponse>(
                `/tv/${tmdbId}/season/${seasonNumber}`,
            );

            const episodes = Array.isArray(data.episodes) ? data.episodes : [];

            return episodes.map((episode) => ({
                id: episode.id,
                name: episode.name || `Episode ${episode.episode_number}`,
                episodeNumber: episode.episode_number,
                seasonNumber: episode.season_number ?? seasonNumber,
                overview: episode.overview,
                airDate: episode.air_date,
                stillPath: episode.still_path,
                runtimeMinutes: episode.runtime,
            }));
        } catch (error) {
            logger.error('Failed to get season episodes', error as Error, {
                tmdbId,
                seasonNumber,
            });
            return [];
        }
    }

    /**
     * Episodes for several seasons of one show, batched through TMDB's
     * `append_to_response=season/N,season/M` (max 20 appends per request) so a
     * series sync spends one request per 20 seasons instead of one per season.
     *
     * Result is keyed by season number; `null` = TMDB could not give that season
     * (it must count as INCOMPLETE, never as an empty season).
     *
     * Failure policy (one 429 must not become 1+N requests, and an abort must
     * stop promptly):
     *  - a failed batch request rethrows (retryable step failure): NO per-season
     *    fallback;
     *  - a season missing from an otherwise OK batch is fetched on its own,
     *    with the abort signal checked before every such call; 429 / auth-fatal
     *    / abort rethrow, any other single-season failure yields `null`.
     */
    async getSeasonsEpisodes(
        tmdbId: number,
        seasonNumbers: number[],
        signal?: AbortSignal,
    ): Promise<Map<number, TmdbSeasonEpisode[] | null>> {
        const out = new Map<number, TmdbSeasonEpisode[] | null>();
        const unique = [...new Set(seasonNumbers)];
        // A single season is the plain endpoint: nothing to batch.
        if (unique.length >= 2) {
            for (let i = 0; i < unique.length; i += TMDB_MAX_APPENDS) {
                if (signal?.aborted) throw new Error('TMDB season fetch aborted');
                const chunk = unique.slice(i, i + TMDB_MAX_APPENDS);
                const data = await this.makeRequest<
                    Record<string, TMDBSeasonEpisodesResponse | undefined>
                >(
                    `/tv/${tmdbId}`,
                    { append_to_response: chunk.map((n) => `season/${n}`).join(',') },
                    { signal },
                );
                for (const n of chunk) {
                    const season = data[`season/${n}`];
                    if (season && Array.isArray(season.episodes)) {
                        out.set(n, this.mapSeasonEpisodes(season.episodes, n));
                    }
                }
            }
        }
        for (const n of unique) {
            if (out.has(n)) continue;
            if (signal?.aborted) throw new Error('TMDB season fetch aborted');
            try {
                const data = await this.makeRequest<TMDBSeasonEpisodesResponse>(
                    `/tv/${tmdbId}/season/${n}`,
                    {},
                    { signal },
                );
                out.set(n, this.mapSeasonEpisodes(data.episodes ?? [], n));
            } catch (error) {
                if (
                    signal?.aborted ||
                    (error instanceof TmdbApiError && (error.status === 429 || error.authFatal))
                ) {
                    throw error;
                }
                logger.warn('Failed to fetch TMDB season, counting it as incomplete', {
                    tmdbId,
                    seasonNumber: n,
                    error: error instanceof Error ? error.message : String(error),
                });
                out.set(n, null);
            }
        }
        return out;
    }

    private mapSeasonEpisodes(episodes: TMDBEpisode[], seasonNumber: number): TmdbSeasonEpisode[] {
        return episodes.map((episode) => ({
            id: episode.id,
            name: episode.name || `Episode ${episode.episode_number}`,
            episodeNumber: episode.episode_number,
            seasonNumber: episode.season_number ?? seasonNumber,
            overview: episode.overview,
            airDate: episode.air_date,
            stillPath: episode.still_path,
            runtimeMinutes: episode.runtime,
        }));
    }

    /**
     * Get movie or TV show details automatically
     */
    async getMediaDetails(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<TMDBMovieDetails> {
        return isMovie(mediaType) ? this.getMovieDetails(tmdbId) : this.getTVShowDetails(tmdbId);
    }

    /**
     * Get trailer URLs for a movie or TV show
     * Returns YouTube URLs for trailers and teasers
     */
    async getTrailerUrls(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<string[]> {
        try {
            const endpoint = toTmdbType(mediaType);
            const data = await this.makeRequest<TMDBVideoResponse>(`/${endpoint}/${tmdbId}/videos`);

            // Filter for YouTube trailers and teasers
            const youtubeTrailers = (data.results || []).filter((video) => {
                const isYoutube = video.site === 'YouTube';
                const isTrailerType = video.type === 'Trailer' || video.type === 'Teaser';
                return isYoutube && isTrailerType;
            });

            return youtubeTrailers.map(
                (trailer: TMDBVideoResult) => `https://www.youtube.com/watch?v=${trailer.key}`,
            );
        } catch (error) {
            logger.error('Failed to get trailers', error as Error, { tmdbId });
            return [];
        }
    }

    /**
     * Get backdrop image path for a movie or TV show
     */
    async getBackdropPath(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<string> {
        try {
            const data = await this.getMediaDetails(tmdbId, mediaType);
            return data.backdrop_path || data.poster_path || '';
        } catch (error) {
            logger.error('Failed to get backdrop', error as Error, {
                tmdbId,
                mediaType,
            });
            return '';
        }
    }

    /**
     * Construct full image URL from TMDB path
     */
    getImageUrl(path: string, size: 'w300' | 'w500' | 'w780' | 'original' = 'w500'): string {
        if (!path) return '';
        return `${this.imageBaseUrl}/${size}${path}`;
    }

    /**
     * Get genre list for movies
     */
    async getMovieGenres(): Promise<{ id: number; name: string }[]> {
        const data = await this.makeRequest<TMDBGenreListResponse>('/genre/movie/list');
        return data.genres || [];
    }

    /**
     * Get genre list for TV shows
     */
    async getTVGenres(): Promise<{ id: number; name: string }[]> {
        const data = await this.makeRequest<TMDBGenreListResponse>('/genre/tv/list');
        return data.genres || [];
    }

    /**
     * Discover movies with filters
     */
    async discoverMovies(
        options: {
            page?: number;
            genre_ids?: number[];
            sort_by?: string;
            min_vote_average?: number;
            min_vote_count?: number;
        } = {},
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        const params: Record<string, string | number> = {
            page: options.page || 1,
        };

        // Handle non-string/number properties separately
        if (options.sort_by) params.sort_by = options.sort_by;
        if (options.min_vote_average) params.min_vote_average = options.min_vote_average;
        if (options.min_vote_count) params.min_vote_count = options.min_vote_count;

        // Convert array to comma-separated string
        if (options.genre_ids && Array.isArray(options.genre_ids)) {
            params.genre_ids = options.genre_ids.join(',');
        }

        return this.makeRequest('/discover/movie', params);
    }

    /**
     * Discover TV shows with filters
     */
    async discoverTVShows(
        options: {
            page?: number;
            genre_ids?: number[];
            sort_by?: string;
            min_vote_average?: number;
            min_vote_count?: number;
        } = {},
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        const params: Record<string, string | number> = {
            page: options.page || 1,
        };

        // Handle non-string/number properties separately
        if (options.sort_by) params.sort_by = options.sort_by;
        if (options.min_vote_average) params.min_vote_average = options.min_vote_average;
        if (options.min_vote_count) params.min_vote_count = options.min_vote_count;

        // Convert array to comma-separated string
        if (options.genre_ids && Array.isArray(options.genre_ids)) {
            params.genre_ids = options.genre_ids.join(',');
        }

        return this.makeRequest('/discover/tv', params);
    }

    /**
     * Get now playing movies
     */
    async getNowPlayingMovies(
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/movie/now_playing', { page });
    }

    /**
     * Get top rated movies
     */
    async getTopRatedMovies(
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/movie/top_rated', { page });
    }

    /**
     * Get top rated TV shows
     */
    async getTopRatedTVShows(
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/tv/top_rated', { page });
    }

    /**
     * Get trending movies for a specific time window
     */
    async getTrendingMoviesTimeWindow(
        timeWindow: 'day' | 'week' = 'week',
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest(`/trending/movie/${timeWindow}`, { page });
    }

    /**
     * Get trending TV shows for a specific time window
     */
    async getTrendingTVShowsTimeWindow(
        timeWindow: 'day' | 'week' = 'week',
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest(`/trending/tv/${timeWindow}`, { page });
    }

    /**
     * Get TV shows airing today
     */
    async getAiringTodayTVShows(
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/tv/airing_today', { page });
    }

    /**
     * Get TV shows currently on the air
     */
    async getOnTheAirTVShows(
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/tv/on_the_air', { page });
    }

    /**
     * Get movie/TV details with additional data appended
     */
    async getMovieDetailsWithAppends(
        tmdbId: number,
        appendToResponse: string[] = [],
    ): Promise<TMDBMovieDetails> {
        const append = appendToResponse.length > 0 ? appendToResponse.join(',') : '';
        const params: Record<string, string | number> = {};
        if (append) {
            params.append_to_response = append;
        }
        return this.makeRequest(`/movie/${tmdbId}`, params);
    }

    async getTVDetailsWithAppends(
        tmdbId: number,
        appendToResponse: string[] = [],
    ): Promise<TMDBMovieDetails> {
        const append = appendToResponse.length > 0 ? appendToResponse.join(',') : '';
        const params: Record<string, string | number> = {};
        if (append) {
            params.append_to_response = append;
        }
        return this.makeRequest(`/tv/${tmdbId}`, params);
    }

    /**
     * Get credits for movie or TV show
     */
    /**
     * All logos for a title in the configured language, English and
     * language-neutral. The `images` append on the detail call is filtered to
     * the request language only, so it can miss the English/neutral variants.
     */
    async getLogos(tmdbId: number, mediaType: 'movie' | 'tv'): Promise<TMDBImage[]> {
        const lang = this.language.split('-')[0];
        const res = await this.makeRequest<{ logos?: TMDBImage[] }>(
            `/${mediaType}/${tmdbId}/images`,
            { include_image_language: [...new Set([lang, 'en', 'null'])].join(',') },
        );
        return res.logos ?? [];
    }

    async getMovieCredits(tmdbId: number): Promise<TMDBCredits> {
        return this.makeRequest(`/movie/${tmdbId}/credits`);
    }

    async getTVCredits(tmdbId: number): Promise<TMDBCredits> {
        return this.makeRequest(`/tv/${tmdbId}/credits`);
    }

    /**
     * Discover movies by genre
     */
    async discoverMoviesByGenre(
        genreId: number,
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        const params: Record<string, string | number> = {
            with_genres: genreId,
            sort_by: 'vote_average.desc',
            page,
        };
        params['vote_count.gte'] = 100;
        return this.makeRequest('/discover/movie', params);
    }

    /**
     * Discover TV shows by genre
     */
    async discoverTVShowsByGenre(
        genreId: number,
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        const params: Record<string, string | number> = {
            with_genres: genreId,
            sort_by: 'vote_average.desc',
            page,
        };
        params['vote_count.gte'] = 50; // Lower threshold for TV shows
        return this.makeRequest('/discover/tv', params);
    }

    /**
     * Search for movies by keywords (for holiday themes)
     */
    async searchMoviesByKeyword(
        keyword: string,
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/search/movie', { query: keyword, page });
    }

    /**
     * Search for TV shows by keywords (for holiday themes)
     */
    async searchTVShowsByKeyword(
        keyword: string,
        page = 1,
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        return this.makeRequest('/search/tv', { query: keyword, page });
    }

    /**
     * Get collection details by ID
     */
    async getCollectionDetails(collectionId: number): Promise<TMDBCollectionDetails> {
        return this.makeRequest(`/collection/${collectionId}`);
    }

    // =========================================================================
    // Episode Groups (Alternative Episode Orderings)
    // =========================================================================

    /**
     * Get available episode groups for a TV series
     * Episode groups provide alternative orderings like absolute, DVD, regional, etc.
     *
     * @param tmdbId - The TMDB TV series ID
     * @returns List of available episode groups
     */
    async getEpisodeGroups(tmdbId: number): Promise<TMDBEpisodeGroupSummary[]> {
        try {
            const data = await this.makeRequest<TMDBEpisodeGroupsResponse>(
                `/tv/${tmdbId}/episode_groups`,
            );
            return data.results || [];
        } catch (error) {
            logger.error('Failed to get episode groups', error as Error, {
                tmdbId,
            });
            return [];
        }
    }

    /**
     * Get detailed episode group with all episodes and their ordering
     *
     * @param episodeGroupId - The episode group UUID (e.g., "5acf93e60e0a26346d0000ce")
     * @returns Full episode group details with episodes
     */
    async getEpisodeGroupDetails(episodeGroupId: string): Promise<TMDBEpisodeGroupDetails | null> {
        try {
            return await this.makeRequest<TMDBEpisodeGroupDetails>(
                `/tv/episode_group/${episodeGroupId}`,
            );
        } catch (error) {
            logger.error('Failed to get episode group details', error as Error, {
                episodeGroupId,
            });
            return null;
        }
    }

    /**
     * Get episodes for a specific season in a given language.
     * Useful for building multi-language name variants for reconciliation.
     */
    async getSeasonEpisodesInLanguage(
        tmdbId: number,
        seasonNumber: number,
        language: string,
        opts?: { throwOnError?: boolean },
    ): Promise<
        {
            id: number;
            name: string;
            overview: string | null;
            episodeNumber: number;
            seasonNumber: number;
        }[]
    > {
        try {
            const data = await this.makeRequest<TMDBSeasonEpisodesResponse>(
                `/tv/${tmdbId}/season/${seasonNumber}`,
                { language },
            );
            const episodes = Array.isArray(data.episodes) ? data.episodes : [];
            return episodes.map((episode) => ({
                id: episode.id,
                name: episode.name || `Episode ${episode.episode_number}`,
                overview: episode.overview?.trim() || null,
                episodeNumber: episode.episode_number,
                seasonNumber: episode.season_number ?? seasonNumber,
            }));
        } catch (error) {
            if (opts?.throwOnError) throw error;
            logger.error('Failed to get season episodes in language', error as Error, {
                tmdbId,
                seasonNumber,
                language,
            });
            return [];
        }
    }

    /**
     * Get episode group details in a specific language.
     * Useful for matching chapter names against localized episode titles.
     */
    async getEpisodeGroupDetailsInLanguage(
        episodeGroupId: string,
        language: string,
    ): Promise<TMDBEpisodeGroupDetails | null> {
        try {
            return await this.makeRequest<TMDBEpisodeGroupDetails>(
                `/tv/episode_group/${episodeGroupId}`,
                { language },
            );
        } catch (error) {
            logger.error('Failed to get episode group details', error as Error, {
                episodeGroupId,
                language,
            });
            return null;
        }
    }

    /**
     * Map TMDB episode group type to human-readable ordering type
     */
    static mapEpisodeGroupType(
        type: TMDBEpisodeGroupType,
    ): 'absolute' | 'dvd' | 'regional' | 'other' {
        switch (type) {
            case 1: // Original air date
                // A selected group is an alternative, even when based on air dates.
                // Reserve standard for the provider's default seasons without a group.
                return 'other';
            case 2: // Absolute
                return 'absolute';
            case 3: // DVD
            case 4: // Digital
                return 'dvd';
            case 5: // Story arc
            case 6: // Production
            case 7: // TV
            default:
                return 'other';
        }
    }

    /**
     * Get episode ordering for a specific type (convenience method)
     * Returns the first matching episode group of the specified type
     *
     * @param tmdbId - The TMDB TV series ID
     * @param orderingType - The desired ordering type
     * @returns Episode group details or null if not available
     */
    async getEpisodeOrdering(
        tmdbId: number,
        orderingType: 'absolute' | 'dvd' | 'standard',
    ): Promise<TMDBEpisodeGroupDetails | null> {
        const groups = await this.getEpisodeGroups(tmdbId);

        // Map ordering type to TMDB group types
        const typeMap: Record<string, TMDBEpisodeGroupType[]> = {
            standard: [1], // Original air date
            absolute: [2], // Absolute
            dvd: [3, 4], // DVD, Digital
        };

        const targetTypes = typeMap[orderingType] || [];
        const matchingGroup = groups.find((g) => targetTypes.includes(g.type));

        if (!matchingGroup) {
            return null;
        }

        return this.getEpisodeGroupDetails(matchingGroup.id);
    }

    /**
     * Discover holiday-themed movies with advanced filtering
     * Uses TMDB keyword IDs for precise discovery (preferred over text search)
     */
    async discoverHolidayMovies(
        options: {
            keywords?: string[];
            keywordIds?: number[]; // TMDB keyword IDs - much more accurate than text search
            genres?: number[];
            page?: number;
            minVoteAverage?: number;
            minVoteCount?: number;
            sortBy?: string;
            releaseDateGte?: string; // YYYY-MM-DD format
            releaseDateLte?: string; // YYYY-MM-DD format
        } = {},
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        const params: Record<string, string | number> = {
            page: options.page || 1,
            sort_by: options.sortBy || 'popularity.desc',
        };

        // Use keyword IDs for precise filtering (TMDB's with_keywords parameter)
        if (options.keywordIds && options.keywordIds.length > 0) {
            // Use | (OR) operator to match any of the keywords
            params.with_keywords = options.keywordIds.join('|');
        }

        if (options.genres && options.genres.length > 0) {
            params.with_genres = options.genres.join(',');
        }

        if (options.minVoteAverage) {
            params['vote_average.gte'] = options.minVoteAverage;
        }

        if (options.minVoteCount) {
            params['vote_count.gte'] = options.minVoteCount;
        }

        // Date range filtering for new releases
        if (options.releaseDateGte) {
            params['primary_release_date.gte'] = options.releaseDateGte;
        }
        if (options.releaseDateLte) {
            params['primary_release_date.lte'] = options.releaseDateLte;
        }

        return this.makeRequest('/discover/movie', params);
    }

    /**
     * Discover holiday-themed TV shows with advanced filtering
     * Uses TMDB keyword IDs for precise discovery (preferred over text search)
     */
    async discoverHolidayTVShows(
        options: {
            keywords?: string[];
            keywordIds?: number[]; // TMDB keyword IDs - much more accurate than text search
            genres?: number[];
            page?: number;
            minVoteAverage?: number;
            minVoteCount?: number;
            sortBy?: string;
            firstAirDateGte?: string; // YYYY-MM-DD format
            firstAirDateLte?: string; // YYYY-MM-DD format
        } = {},
    ): Promise<{ results: TMDBSearchResult[]; total_pages: number }> {
        const params: Record<string, string | number> = {
            page: options.page || 1,
            sort_by: options.sortBy || 'popularity.desc',
        };

        // Use keyword IDs for precise filtering (TMDB's with_keywords parameter)
        if (options.keywordIds && options.keywordIds.length > 0) {
            // Use | (OR) operator to match any of the keywords
            params.with_keywords = options.keywordIds.join('|');
        }

        if (options.genres && options.genres.length > 0) {
            params.with_genres = options.genres.join(',');
        }

        if (options.minVoteAverage) {
            params['vote_average.gte'] = options.minVoteAverage;
        }

        if (options.minVoteCount) {
            params['vote_count.gte'] = options.minVoteCount;
        }

        // Date range filtering for new releases
        if (options.firstAirDateGte) {
            params['first_air_date.gte'] = options.firstAirDateGte;
        }
        if (options.firstAirDateLte) {
            params['first_air_date.lte'] = options.firstAirDateLte;
        }

        return this.makeRequest('/discover/tv', params);
    }

    /**
     * Discover movies by keyword ID
     * Used for tag-based browsing like "Martial Arts", "Time Travel", etc.
     */
    async discoverByKeyword(
        keywordId: number,
        mediaType: 'movie' | 'tv' = 'movie',
        page = 1,
    ): Promise<{
        results: TMDBSearchResult[];
        total_pages: number;
        total_results: number;
    }> {
        const params: Record<string, string | number> = {
            page,
            with_keywords: keywordId,
            sort_by: 'popularity.desc', // Most popular first, no vote minimum to include more results
        };

        return this.makeRequest(`/discover/${mediaType}`, params);
    }

    /**
     * Discover both movies and TV shows by keyword ID
     * Returns combined results sorted by popularity
     */
    async discoverAllByKeyword(keywordId: number, limit = 20): Promise<TMDBSearchResult[]> {
        // Fetch several pages each. /browse keyword sections intersect these
        // results with the LOCAL library, and a small/curated library's titles
        // are rarely in just the top-2 popularity pages — pulling 5 movie + 3 TV
        // pages surfaces far more local matches per keyword section.
        const MOVIE_PAGES = 5;
        const TV_PAGES = 3;
        const [movieResults, tvResults] = await Promise.all([
            Promise.all(
                Array.from({ length: MOVIE_PAGES }, (_, i) =>
                    this.discoverByKeyword(keywordId, 'movie', i + 1),
                ),
            ),
            Promise.all(
                Array.from({ length: TV_PAGES }, (_, i) =>
                    this.discoverByKeyword(keywordId, 'tv', i + 1),
                ),
            ),
        ]);

        const taggedMovies = movieResults.flatMap((p) =>
            p.results.map((m) => ({ ...m, media_type: 'movie' as const })),
        );
        const taggedTV = tvResults.flatMap((p) =>
            p.results.map((t) => ({ ...t, media_type: 'tv' as const })),
        );

        // Combine and sort by popularity
        const combined = [...taggedMovies, ...taggedTV]
            .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
            .slice(0, limit);

        return combined;
    }

    // =========================================================================
    // External ID Resolution (IMDB/TVDB → TMDB)
    // =========================================================================

    /**
     * Find TMDB ID by external ID (IMDB, TVDB, etc.)
     * Uses TMDB's /find/{external_id} endpoint
     *
     * @param externalId - The external ID (e.g., "tt0137523" for IMDB)
     * @param source - The external source (imdb_id, tvdb_id, etc.)
     * @returns Found movie/TV results or empty arrays
     */
    async findByExternalId(
        externalId: string,
        source: 'imdb_id' | 'tvdb_id' | 'facebook_id' | 'instagram_id' | 'twitter_id',
    ): Promise<{
        movie_results: TMDBSearchResult[];
        tv_results: TMDBSearchResult[];
        tv_episode_results: TMDBSearchResult[];
        tv_season_results: TMDBSearchResult[];
    }> {
        try {
            return await this.makeRequest(`/find/${externalId}`, {
                external_source: source,
            });
        } catch (error) {
            logger.error('Failed to find by external ID', error as Error, {
                externalId,
                source,
            });
            return {
                movie_results: [],
                tv_results: [],
                tv_episode_results: [],
                tv_season_results: [],
            };
        }
    }

    /**
     * Resolve IMDB ID to TMDB ID
     * Works for both movies and TV shows
     *
     * @param imdbId - IMDB ID (e.g., "tt0137523")
     * @param mediaType - Expected media type (movie or tv)
     * @returns TMDB ID or null if not found
     */
    async resolveImdbToTmdb(imdbId: string, mediaType: 'movie' | 'tv'): Promise<number | null> {
        const result = await this.findByExternalId(imdbId, 'imdb_id');

        if (isMovie(mediaType) && result.movie_results.length > 0) {
            return result.movie_results[0].id;
        }
        if (isSeries(mediaType) && result.tv_results.length > 0) {
            return result.tv_results[0].id;
        }

        return null;
    }

    /**
     * Resolve TVDB ID to TMDB ID
     * Note: TMDB only indexes TV shows by TVDB, not movies
     *
     * @param tvdbId - TVDB ID as string
     * @returns TMDB ID or null if not found
     */
    async resolveTvdbToTmdb(tvdbId: string): Promise<number | null> {
        const result = await this.findByExternalId(tvdbId, 'tvdb_id');

        if (result.tv_results.length > 0) {
            return result.tv_results[0].id;
        }

        return null;
    }
}

// Export singleton instance
export const tmdbApi = new TMDBApiService();

// Export factory function for custom language
export function createTMDBApi(language: string = config.TMDB_LANGUAGE): TMDBApiService {
    return new TMDBApiService(language);
}
