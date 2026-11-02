// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB Content Source Adapter
 *
 * Discovers holiday-themed content from TMDB using:
 * - Keyword IDs (most accurate)
 * - Collections
 * - Text search fallback
 * - New releases discovery
 */

import type { ContentSourceAdapter, ContentSource, HolidayConfig, DiscoveredItem } from '../types';
import {
    tmdbApi,
    type TMDBGenre,
    type TMDBSearchResult,
    type TMDBMovieDetails,
} from '$lib/server/providers/implementations/tmdb/index.js';
import { invokeProviderDiscover } from '$lib/server/tasks/plugin-context.js';
import { ExternalIdSet } from '$lib/server/utils/tmdb-composite-key';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('TmdbSource');

type TmdbContentItem = (TMDBSearchResult | TMDBMovieDetails) & {
    genres?: TMDBGenre[];
};

export class TmdbContentSourceAdapter implements ContentSourceAdapter {
    readonly type = 'tmdb' as const;

    isAvailable(): boolean {
        return tmdbApi.isAvailable();
    }

    async discover(
        config: ContentSource,
        holiday: HolidayConfig,
        limit: number,
    ): Promise<DiscoveredItem[]> {
        if (config.type !== 'tmdb') {
            return [];
        }

        if (!this.isAvailable()) {
            logger.warn('TMDB API not available');
            return [];
        }

        const tmdbConfig = config;
        const results: DiscoveredItem[] = [];
        const seenIds = new ExternalIdSet();
        const currentYear = new Date().getFullYear();

        // Helper to add results with deduplication
        const addResults = (
            items: TmdbContentItem[],
            mediaType: 'movie' | 'tv',
            options: {
                isFeatured?: boolean;
                isNewRelease?: boolean;
                isFromCollection?: boolean;
            } = {},
        ) => {
            for (const item of items || []) {
                if (!item || !item.id) continue;
                if (seenIds.has(item.id, mediaType)) continue;
                // Ensure vote_count is treated as a number (handles string coercion from API)
                const voteCount = Number(item.vote_count) || 0;
                if (!options.isFeatured && voteCount < 10) continue;

                seenIds.add(item.id, mediaType);
                // Handle both discover endpoints (genre_ids: number[]) and detail endpoints (genres: {id, name}[])
                const genreIds = item.genre_ids ?? item.genres?.map((g) => g.id);
                results.push({
                    id: item.id,
                    mediaType,
                    title: item.title || item.name || 'Unknown',
                    overview: item.overview,
                    posterPath: item.poster_path,
                    backdropPath: item.backdrop_path,
                    releaseDate: item.release_date || item.first_air_date,
                    popularity: Number(item.popularity) || 0,
                    voteAverage: Number(item.vote_average) || 0,
                    voteCount,
                    genreIds,
                    source: 'tmdb',
                    boostFactor: options.isFeatured ? 10 : options.isFromCollection ? 1.5 : 1,
                    isFeatured: options.isFeatured,
                    isNewRelease: options.isNewRelease,
                    isFromCollection: options.isFromCollection,
                });
            }
        };

        try {
            // Strategy 1: Featured content (specific TMDB IDs)
            if (tmdbConfig.featuredMovieIds?.length) {
                logger.debug('Fetching featured movies', {
                    count: tmdbConfig.featuredMovieIds.length,
                });
                const moviePromises = tmdbConfig.featuredMovieIds.map(
                    async (movieId): Promise<TmdbContentItem | null> => {
                        try {
                            const movie = await tmdbApi.getMovieDetails(movieId);
                            if (movie?.id) {
                                return {
                                    ...movie,
                                    title: movie.title || movie.name,
                                } as TmdbContentItem;
                            }
                        } catch (error) {
                            logger.warn(
                                'Failed to fetch featured movie',
                                { movieId },
                                error as Error,
                            );
                        }
                        return null;
                    },
                );
                const movies = (await Promise.all(moviePromises)).filter(
                    (movie): movie is TmdbContentItem => Boolean(movie && movie.id),
                );
                addResults(movies, 'movie', { isFeatured: true });
            }

            if (tmdbConfig.featuredTvIds?.length) {
                logger.debug('Fetching featured TV shows', {
                    count: tmdbConfig.featuredTvIds.length,
                });
                const tvPromises = tmdbConfig.featuredTvIds.map(
                    async (tvId): Promise<TmdbContentItem | null> => {
                        try {
                            const tv = await tmdbApi.getTVShowDetails(tvId);
                            if (tv?.id) {
                                return {
                                    ...tv,
                                    name: tv.name || tv.title,
                                } as TmdbContentItem;
                            }
                        } catch (error) {
                            logger.warn(
                                'Failed to fetch featured TV show',
                                { tvId },
                                error as Error,
                            );
                        }
                        return null;
                    },
                );
                const shows = (await Promise.all(tvPromises)).filter(
                    (show): show is TmdbContentItem => Boolean(show && show.id),
                );
                addResults(shows, 'tv', { isFeatured: true });
            }

            // Strategy 2: Keyword ID discovery (most accurate)
            if (tmdbConfig.keywordIds?.length && tmdbApi.isAvailable()) {
                logger.debug('Discovering by keyword IDs', {
                    keywordIds: tmdbConfig.keywordIds.slice(0, 5),
                });
                try {
                    const [moviesByKeyword, tvByKeyword] = await Promise.all([
                        invokeProviderDiscover('tmdb-metadata-provider', {
                            mediaType: 'movie',
                            keywordIds: tmdbConfig.keywordIds,
                            page: 1,
                            minVoteCount: tmdbConfig.minVoteCount ?? 50,
                            minVoteAverage: tmdbConfig.minVoteAverage ?? 5.5,
                            sortBy: 'popularity.desc',
                        })
                            .then((results: unknown[]) => ({
                                results: results as TMDBSearchResult[],
                            }))
                            .catch(() =>
                                tmdbApi.discoverHolidayMovies({
                                    keywordIds: tmdbConfig.keywordIds,
                                    page: 1,
                                    minVoteCount: tmdbConfig.minVoteCount ?? 50,
                                    minVoteAverage: tmdbConfig.minVoteAverage ?? 5.5,
                                    sortBy: 'popularity.desc',
                                }),
                            ),
                        invokeProviderDiscover('tmdb-metadata-provider', {
                            mediaType: 'tv',
                            keywordIds: tmdbConfig.keywordIds,
                            page: 1,
                            minVoteCount: tmdbConfig.minVoteCount
                                ? Math.floor(tmdbConfig.minVoteCount / 2)
                                : 20,
                            minVoteAverage: tmdbConfig.minVoteAverage ?? 5.5,
                            sortBy: 'popularity.desc',
                        })
                            .then((results: unknown[]) => ({
                                results: results as TMDBSearchResult[],
                            }))
                            .catch(() =>
                                tmdbApi.discoverHolidayTVShows({
                                    keywordIds: tmdbConfig.keywordIds,
                                    page: 1,
                                    minVoteCount: tmdbConfig.minVoteCount
                                        ? Math.floor(tmdbConfig.minVoteCount / 2)
                                        : 20,
                                    minVoteAverage: tmdbConfig.minVoteAverage ?? 5.5,
                                    sortBy: 'popularity.desc',
                                }),
                            ),
                    ]);

                    addResults(moviesByKeyword.results, 'movie');
                    addResults(tvByKeyword.results, 'tv');
                } catch (error) {
                    logger.warn('Keyword discovery failed', {}, error as Error);
                }
            }

            // Strategy 3: New releases (current/last year)
            if (
                tmdbConfig.includeNewReleases &&
                tmdbConfig.keywordIds?.length &&
                tmdbApi.isAvailable()
            ) {
                logger.debug('Fetching new releases');
                try {
                    const [newMoviesCurrent, newMoviesPrev, newTvCurrent, newTvPrev] =
                        await Promise.all([
                            tmdbApi.discoverHolidayMovies({
                                keywordIds: tmdbConfig.keywordIds,
                                page: 1,
                                minVoteCount: 1,
                                sortBy: 'popularity.desc',
                                releaseDateGte: `${currentYear}-01-01`,
                                releaseDateLte: `${currentYear}-12-31`,
                            }),
                            tmdbApi.discoverHolidayMovies({
                                keywordIds: tmdbConfig.keywordIds,
                                page: 1,
                                minVoteCount: 5,
                                sortBy: 'popularity.desc',
                                releaseDateGte: `${currentYear - 1}-01-01`,
                                releaseDateLte: `${currentYear - 1}-12-31`,
                            }),
                            tmdbApi.discoverHolidayTVShows({
                                keywordIds: tmdbConfig.keywordIds,
                                page: 1,
                                minVoteCount: 1,
                                sortBy: 'popularity.desc',
                                firstAirDateGte: `${currentYear}-01-01`,
                                firstAirDateLte: `${currentYear}-12-31`,
                            }),
                            tmdbApi.discoverHolidayTVShows({
                                keywordIds: tmdbConfig.keywordIds,
                                page: 1,
                                minVoteCount: 5,
                                sortBy: 'popularity.desc',
                                firstAirDateGte: `${currentYear - 1}-01-01`,
                                firstAirDateLte: `${currentYear - 1}-12-31`,
                            }),
                        ]);

                    addResults(newMoviesCurrent.results, 'movie', {
                        isNewRelease: true,
                    });
                    addResults(newMoviesPrev.results, 'movie', {
                        isNewRelease: true,
                    });
                    addResults(newTvCurrent.results, 'tv', {
                        isNewRelease: true,
                    });
                    addResults(newTvPrev.results, 'tv', { isNewRelease: true });
                } catch (error) {
                    logger.warn('New releases discovery failed', {}, error as Error);
                }
            }

            // Strategy 4: Collections
            if (tmdbConfig.collectionIds?.length && tmdbApi.isAvailable()) {
                logger.debug('Fetching collections', {
                    count: tmdbConfig.collectionIds.length,
                });
                // Limit to 10 collections, and limit parts per collection to prevent unbounded results
                const maxCollections = 10;
                const maxPartsPerCollection = Math.max(5, Math.floor(limit / maxCollections));

                const collectionPromises = tmdbConfig.collectionIds
                    .slice(0, maxCollections)
                    .map(async (collectionId) => {
                        try {
                            const collection = await tmdbApi.getCollectionDetails(collectionId);
                            // Sort by popularity and take top N parts to avoid unbounded results
                            const parts = collection?.parts || [];
                            return parts
                                .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
                                .slice(0, maxPartsPerCollection);
                        } catch (e) {
                            logger.debug('Failed to fetch TMDB collection', {
                                collectionId,
                                error: e,
                            });
                            return [];
                        }
                    });

                const collectionResults = await Promise.all(collectionPromises);
                for (const parts of collectionResults) {
                    addResults(parts, 'movie', { isFromCollection: true });
                }
            }

            // Strategy 5: Text search fallback
            if (results.length < limit && tmdbConfig.keywords?.length && tmdbApi.isAvailable()) {
                logger.debug('Using text search fallback', {
                    keywords: tmdbConfig.keywords,
                });
                for (const keyword of tmdbConfig.keywords.slice(0, 2)) {
                    try {
                        const [movieResults, tvResults] = await Promise.all([
                            tmdbApi.searchMoviesByKeyword(keyword, 1),
                            tmdbApi.searchTVShowsByKeyword(keyword, 1),
                        ]);
                        addResults(movieResults.results, 'movie');
                        addResults(tvResults.results, 'tv');
                    } catch (e) {
                        logger.debug('TMDB keyword search failed, continuing with next keyword', {
                            keyword,
                            error: e,
                        });
                    }
                }
            }
        } catch (error) {
            logger.error('TMDB discovery failed', error as Error);
        }

        logger.debug('TMDB source discovered', {
            count: results.length,
            holidayId: holiday.id,
        });
        return results;
    }
}

// Export singleton instance
export const tmdbSource = new TmdbContentSourceAdapter();
