// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '$lib/server/config';
import { Logger } from '../utils/logger.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';
import { isMovie } from '$lib/server/utils/media-types';
import { fetchWithTimeout } from '../utils/fetch-utils.js';

const logger = Logger.for('MDBListApi');

// Rating source types
export type RatingSource =
    | 'imdb'
    | 'metacritic'
    | 'metacriticuser'
    | 'trakt'
    | 'tomatoes'
    | 'popcorn'
    | 'tmdb'
    | 'letterboxd'
    | 'rogerebert'
    | 'myanimelist';

export interface MDBListRating {
    source: RatingSource;
    value: number | null;
    score: number | null; // Normalized 0-100
    votes: number | null;
    url?: string | null;
}

export interface MDBListGenre {
    id: number;
    title: string;
}

export interface MDBListStream {
    id: number;
    name: string;
}

export interface MDBListProductionCompany {
    name: string;
    id: number;
}

export interface MDBListIds {
    imdb?: string;
    trakt?: number;
    tmdb?: number;
    tvdb?: number;
    mal?: number;
}

export interface MDBListReview {
    updated_at: string;
    author: string;
    rating: number;
    provider_id: number;
    content: string;
}

export interface MDBListKeyword {
    id: number;
    name: string;
}

export interface MDBListMediaItem {
    title: string;
    year: number;
    released: string;
    released_digital?: string;
    description: string;
    runtime: number;
    score: number; // Aggregate score (0-100)
    score_average: number; // Average across all sources
    ids: MDBListIds;
    type: 'movie' | 'show';
    ratings: MDBListRating[];
    genres: MDBListGenre[];
    streams: MDBListStream[];
    watch_providers: unknown[];
    production_companies: MDBListProductionCompany[];
    language: string;
    spoken_language: string;
    country: string;
    certification: string;
    commonsense: boolean | null;
    age_rating: number | null;
    status: string;
    trailer?: string;
    poster?: string;
    backdrop?: string;
    // Additional fields from batch API
    reviews?: MDBListReview[];
    keywords?: MDBListKeyword[];
}

export interface MDBListListItem {
    id: number; // This IS the TMDB ID
    rank: number;
    adult: number; // 0 or 1
    mediatype: 'movie' | 'show';
    title: string;
    release_year: number;
    imdb_id?: string;
    tvdbid?: number | null; // Note: lowercase 'tvdbid' in API response
    // Computed fields for convenience
    tmdb_id?: number; // Will be set from 'id' field
    score?: number;
    score_average?: number;
}

const isMDBListListItem = (value: unknown): value is MDBListListItem => {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.id === 'number' &&
        typeof record.title === 'string' &&
        // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- MDBList's mediatype field uses the external 'show' alias.
        (isMovie(record.mediatype as string) || record.mediatype === 'show')
    );
};

/**
 * MDBList API Service
 *
 * Provides access to aggregated ratings from multiple sources:
 * - IMDB, Trakt, TMDB, Letterboxd, Rotten Tomatoes, Metacritic, Roger Ebert, MyAnimeList
 *
 * Features:
 * - Lookup by TMDB ID, IMDB ID, or Trakt ID
 * - Access to curated lists (trending, top rated, streaming platform lists)
 * - Aggregate scores across all rating sources
 */
export class MDBListApiService {
    private readonly baseUrl = 'https://api.mdblist.com';
    /** Read on every use — the singleton is built at import, the key is a live setting. */
    private get apiKey(): string {
        return config.MDBLIST_API_KEY;
    }

    constructor() {
        if (!this.apiKey) {
            logger.warn('MDBList API key not configured');
        }
    }

    /**
     * Check if MDBList API is configured and available
     */
    public isAvailable(): boolean {
        return !!this.apiKey;
    }

    /**
     * Make authenticated request to MDBList API
     */
    private async makeRequest<T>(
        endpoint: string,
        params: Record<string, string | number> = {},
    ): Promise<T> {
        if (!this.apiKey) {
            throw new Error('MDBList API key not configured');
        }

        // MDBList only supports apikey as a query parameter — no header auth available (F65: documented).
        const queryParams = new URLSearchParams({
            apikey: this.apiKey,
            ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
        });

        const url = `${this.baseUrl}${endpoint}?${queryParams}`;

        try {
            const response = await trackExternalCall(url, () =>
                fetchWithTimeout(url, {
                    headers: {
                        'Content-Type': 'application/json',
                    },
                }),
            );

            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('MDBList rate limit exceeded');
                }
                throw new Error(
                    `MDBList API request failed: ${response.status} ${response.statusText}`,
                );
            }

            const data: unknown = await response.json();
            return data as T;
        } catch (error) {
            logger.error('MDBList request failed', error as Error, {
                endpoint,
            });
            throw error;
        }
    }

    /**
     * Get media details by TMDB ID
     */
    async getByTmdbId(
        tmdbId: number,
        mediaType: 'movie' | 'show' = 'movie',
    ): Promise<MDBListMediaItem | null> {
        try {
            return await this.makeRequest<MDBListMediaItem>('/', {
                t: tmdbId.toString(),
                m: mediaType,
            });
        } catch (error) {
            logger.error('Failed to get media by TMDB ID', error as Error, {
                tmdbId,
                mediaType,
            });
            return null;
        }
    }

    /**
     * Get media details by IMDB ID
     */
    async getByImdbId(imdbId: string): Promise<MDBListMediaItem | null> {
        try {
            return await this.makeRequest<MDBListMediaItem>('/', { i: imdbId });
        } catch (error) {
            logger.error('Failed to get media by IMDB ID', error as Error, {
                imdbId,
            });
            return null;
        }
    }

    /**
     * Get media details by Trakt ID
     */
    async getByTraktId(
        traktId: number,
        mediaType: 'movie' | 'show' = 'movie',
    ): Promise<MDBListMediaItem | null> {
        try {
            return await this.makeRequest<MDBListMediaItem>('/', {
                tr: traktId.toString(),
                m: mediaType,
            });
        } catch (error) {
            logger.error('Failed to get media by Trakt ID', error as Error, {
                traktId,
                mediaType,
            });
            return null;
        }
    }

    // ============================================
    // BATCH API METHODS (up to 200 items per request)
    // ============================================

    /**
     * Batch fetch media info by TMDB IDs
     * Uses POST /{media_provider}/{media_type}?apikey=xxx
     * Body: { "ids": [...], "append_to_response": ["review", "keyword"] }
     * @param tmdbIds - Array of TMDB IDs (max 200)
     * @param mediaType - 'movie' or 'show'
     * @returns Array of MDBListMediaItem (may be fewer than requested if some not found)
     */
    async getBatchByTmdbIds(
        tmdbIds: number[],
        mediaType: 'movie' | 'show' = 'movie',
    ): Promise<MDBListMediaItem[]> {
        if (!this.apiKey) {
            throw new Error('MDBList API key not configured');
        }

        if (tmdbIds.length === 0) {
            return [];
        }

        if (tmdbIds.length > 200) {
            logger.warn('Batch request exceeds 200 items, truncating', {
                requested: tmdbIds.length,
            });
            tmdbIds = tmdbIds.slice(0, 200);
        }

        // MDBList batch endpoints only support apikey as a query parameter (F65: documented).
        const url = `${this.baseUrl}/tmdb/${mediaType}?apikey=${this.apiKey}`;

        try {
            logger.debug('Fetching batch from MDBList', {
                count: tmdbIds.length,
                mediaType,
            });

            const response = await trackExternalCall(url, () =>
                fetchWithTimeout(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        ids: tmdbIds.map((id) => String(id)),
                        append_to_response: ['review', 'keyword'],
                    }),
                }),
            );

            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('MDBList rate limit exceeded');
                }
                const errorText = await response.text().catch(() => '');
                throw new Error(
                    `MDBList batch API request failed: ${response.status} ${response.statusText} - ${errorText}`,
                );
            }

            const results = (await response.json()) as MDBListMediaItem[];
            logger.debug('Batch fetch completed', {
                requested: tmdbIds.length,
                returned: results.length,
            });

            return results || [];
        } catch (error) {
            // A 429 (free-tier daily quota exhausted) is expected on a large
            // cold scan, NOT a failure — log it as a clear WARN and let the
            // caller back off / cool down. Only genuine errors are ERROR.
            const isRateLimit = error instanceof Error && /rate limit/i.test(error.message);
            if (isRateLimit) {
                logger.warn(
                    'MDBList rate limit reached (free-tier daily request quota) — backing off. ' +
                        'Ratings/keywords will resume automatically once the quota resets; no action needed.',
                    { count: tmdbIds.length, mediaType },
                );
            } else {
                logger.error('MDBList batch request failed', error as Error, {
                    count: tmdbIds.length,
                    mediaType,
                });
            }
            throw error;
        }
    }

    /**
     * Batch fetch media info by IMDB IDs
     * @param imdbIds - Array of IMDB IDs (max 200), e.g., ["tt1234567", "tt7654321"]
     * @param mediaType - 'movie' or 'show'
     */
    async getBatchByImdbIds(
        imdbIds: string[],
        mediaType: 'movie' | 'show' = 'movie',
    ): Promise<MDBListMediaItem[]> {
        if (!this.apiKey) {
            throw new Error('MDBList API key not configured');
        }

        if (imdbIds.length === 0) {
            return [];
        }

        if (imdbIds.length > 200) {
            logger.warn('Batch request exceeds 200 items, truncating', {
                requested: imdbIds.length,
            });
            imdbIds = imdbIds.slice(0, 200);
        }

        // MDBList batch endpoints only support apikey as a query parameter (F65: documented).
        const url = `${this.baseUrl}/imdb/${mediaType}?apikey=${this.apiKey}`;

        try {
            logger.debug('Fetching batch by IMDB IDs from MDBList', {
                count: imdbIds.length,
                mediaType,
            });

            const response = await trackExternalCall(url, () =>
                fetchWithTimeout(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        ids: imdbIds,
                        append_to_response: ['review', 'keyword'],
                    }),
                }),
            );

            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('MDBList rate limit exceeded');
                }
                const errorText = await response.text().catch(() => '');
                throw new Error(
                    `MDBList batch API request failed: ${response.status} ${response.statusText} - ${errorText}`,
                );
            }

            const results = (await response.json()) as MDBListMediaItem[];
            logger.debug('Batch fetch by IMDB completed', {
                requested: imdbIds.length,
                returned: results.length,
            });

            return results || [];
        } catch (error) {
            logger.error('MDBList batch request by IMDB failed', error as Error, {
                count: imdbIds.length,
                mediaType,
            });
            throw error;
        }
    }

    /**
     * Batch fetch with automatic chunking for large datasets
     * Splits requests into chunks of 200 and combines results
     * Uses composite key (tmdbId:mediaType) to avoid TMDB ID collisions
     * @param tmdbIds - Array of TMDB IDs (any size)
     * @param mediaType - 'movie' or 'show'
     * @param delayMs - Delay between batch requests (default 500ms)
     * @returns Map with composite keys (tmdbId:mediaType) to handle TMDB ID collisions
     */
    async getBatchByTmdbIdsChunked(
        tmdbIds: number[],
        mediaType: 'movie' | 'show' = 'movie',
        delayMs = 500,
    ): Promise<Map<string, MDBListMediaItem>> {
        const results = new Map<string, MDBListMediaItem>();
        const chunkSize = 200;
        const chunks: number[][] = [];

        // Split into chunks of 200
        for (let i = 0; i < tmdbIds.length; i += chunkSize) {
            chunks.push(tmdbIds.slice(i, i + chunkSize));
        }

        logger.debug('Processing batch in chunks', {
            totalItems: tmdbIds.length,
            chunks: chunks.length,
            chunkSize,
        });

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];

            try {
                const batchResults = await this.getBatchByTmdbIds(chunk, mediaType);

                // Map results by composite key (tmdbId:mediaType) to avoid TMDB ID collisions
                // Same TMDB ID can be both a movie AND a TV show (e.g., ID 1429)
                for (const item of batchResults) {
                    if (item.ids?.tmdb) {
                        // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- MDBList's type field uses the external 'show' alias.
                        const itemMediaType = item.type === 'show' ? 'tv' : 'movie';
                        const compositeKey = `${item.ids.tmdb}:${itemMediaType}`;
                        results.set(compositeKey, item);
                    }
                }

                logger.debug(`Chunk ${i + 1}/${chunks.length} completed`, {
                    requested: chunk.length,
                    found: batchResults.length,
                });

                // Delay between requests to respect rate limits
                if (i < chunks.length - 1 && delayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            } catch (error) {
                logger.error(`Chunk ${i + 1}/${chunks.length} failed`, error as Error);
                // Continue with next chunk instead of failing completely
            }
        }

        return results;
    }

    /**
     * Get a public list by list ID or URL path
     * Lists are served from mdblist.com (not api.mdblist.com). The endpoint itself
     * needs no key, but MDBList is an opt-in provider: without MDBLIST_API_KEY the
     * server must not contact mdblist.com at all (docs: "What Lumastra sends where").
     * @param listPath - e.g., "linaspurinis/top-watched-movies-of-the-week"
     */
    async getList(listPath: string, limit = 100): Promise<MDBListListItem[]> {
        if (!this.isAvailable()) {
            logger.debug('MDBList not configured; not fetching public list', { listPath });
            return [];
        }
        try {
            // Lists are served from the main website, not the API
            const url = `https://mdblist.com/lists/${listPath}/json/`;
            logger.debug('Fetching MDBList list', { listPath, url });

            const response = await trackExternalCall(url, () =>
                fetchWithTimeout(url, {
                    headers: {
                        Accept: 'application/json',
                        'User-Agent': 'MediaDashboard/1.0',
                    },
                }),
            );

            if (!response.ok) {
                throw new Error(
                    `MDBList list request failed: ${response.status} ${response.statusText}`,
                );
            }

            const data: unknown = await response.json();

            // The response is an array of items, limit if needed
            if (Array.isArray(data)) {
                const items = (data as unknown[]).filter(isMDBListListItem);
                return items.slice(0, limit);
            }

            return [];
        } catch (error) {
            logger.error('Failed to get list', error as Error, { listPath });
            return [];
        }
    }

    /**
     * Get user's personal lists
     */
    async getUserLists(): Promise<unknown[]> {
        try {
            return await this.makeRequest<unknown[]>('/lists/user');
        } catch (error) {
            logger.error('Failed to get user lists', error as Error);
            return [];
        }
    }

    // ============================================
    // CONVENIENCE METHODS FOR COMMON LISTS
    // ============================================

    /**
     * Get top watched movies of the week
     */
    async getTopWatchedMoviesWeek(limit = 20): Promise<MDBListListItem[]> {
        return this.getList('linaspurinis/top-watched-movies-of-the-week', limit);
    }

    /**
     * Get top watched TV shows of the week
     */
    async getTopWatchedShowsWeek(limit = 20): Promise<MDBListListItem[]> {
        return this.getList('linaspurinis/top-watched-shows-of-the-week', limit);
    }

    /**
     * Get most popular movies
     */
    async getMostPopularMovies(limit = 20): Promise<MDBListListItem[]> {
        return this.getList('linaspurinis/most-popular-movies', limit);
    }

    /**
     * Get most popular TV shows
     */
    async getMostPopularShows(limit = 20): Promise<MDBListListItem[]> {
        return this.getList('linaspurinis/most-popular-shows', limit);
    }

    // ============================================
    // RATING EXTRACTION HELPERS
    // ============================================

    /**
     * Extract specific rating from media item
     */
    extractRating(item: MDBListMediaItem, source: RatingSource): MDBListRating | null {
        return item.ratings.find((r) => r.source === source) || null;
    }

    /**
     * Extract all ratings as a structured object
     */
    extractAllRatings(
        item: MDBListMediaItem,
    ): Record<RatingSource, { value: number | null; votes: number | null }> {
        const ratings: Record<string, { value: number | null; votes: number | null }> = {};

        for (const rating of item.ratings) {
            ratings[rating.source] = {
                value: rating.value,
                votes: rating.votes,
            };
        }

        return ratings;
    }

    /**
     * Get normalized ratings (all on 0-100 scale) for embedding generation
     */
    getNormalizedRatings(item: MDBListMediaItem): {
        imdb: number | null;
        letterboxd: number | null;
        metacritic: number | null;
        rt_critic: number | null;
        rt_audience: number | null;
        trakt: number | null;
        mal: number | null;
        aggregate: number;
    } {
        const getRatingScore = (source: RatingSource): number | null => {
            const rating = this.extractRating(item, source);
            return rating?.score ?? null;
        };

        return {
            imdb: getRatingScore('imdb'),
            letterboxd: getRatingScore('letterboxd'),
            metacritic: getRatingScore('metacritic'),
            rt_critic: getRatingScore('tomatoes'),
            rt_audience: getRatingScore('popcorn'),
            trakt: getRatingScore('trakt'),
            mal: getRatingScore('myanimelist'),
            aggregate: item.score,
        };
    }

    /**
     * Get vote counts for confidence weighting
     */
    getVoteCounts(item: MDBListMediaItem): Record<RatingSource, number> {
        const votes: Record<string, number> = {};

        for (const rating of item.ratings) {
            votes[rating.source] = rating.votes ?? 0;
        }

        return votes;
    }

    /**
     * Check if this is anime content (has MAL rating)
     */
    isAnime(item: MDBListMediaItem): boolean {
        const malRating = this.extractRating(item, 'myanimelist');
        return (
            (malRating?.value ?? 0) > 0 ||
            item.genres.some((g) => g.title.toLowerCase().includes('anime'))
        );
    }

    /**
     * Get anime-specific sub-genres
     */
    getAnimeGenres(item: MDBListMediaItem): string[] {
        return item.genres
            .filter((g) => g.title.toLowerCase().startsWith('anime:'))
            .map((g) => g.title);
    }

    /**
     * Get streaming availability
     */
    getStreamingServices(item: MDBListMediaItem): string[] {
        return item.streams.map((s) => s.name);
    }
}

// Export singleton instance
export const mdblistApi = new MDBListApiService();

// Export factory function
export function createMDBListApi(): MDBListApiService {
    return new MDBListApiService();
}
