// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Custom Content Source Adapter
 *
 * Handles explicit TMDB ID lists for manually curated content.
 * Useful for cultural traditions or specific movies that should always appear.
 */

import type { ContentSourceAdapter, ContentSource, HolidayConfig, DiscoveredItem } from '../types';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('CustomSource');

export class CustomContentSourceAdapter implements ContentSourceAdapter {
    readonly type = 'custom' as const;

    isAvailable(): boolean {
        // Custom source requires TMDB API to fetch movie details
        return tmdbApi.isAvailable();
    }

    async discover(
        config: ContentSource,
        holiday: HolidayConfig,
        limit: number,
    ): Promise<DiscoveredItem[]> {
        if (config.type !== 'custom') {
            return [];
        }

        if (!this.isAvailable()) {
            logger.warn('TMDB API not available for custom source');
            return [];
        }

        const customConfig = config;
        const results: DiscoveredItem[] = [];

        try {
            // Fetch movies
            if (customConfig.movieIds?.length) {
                logger.debug('Fetching custom movies', {
                    count: customConfig.movieIds.length,
                });

                const moviePromises = customConfig.movieIds.slice(0, limit).map(async (movieId) => {
                    try {
                        const movie = await tmdbApi.getMovieDetails(movieId);
                        if (movie?.id) {
                            return {
                                id: movie.id,
                                mediaType: 'movie' as const,
                                title: movie.title || movie.name || 'Unknown',
                                overview: movie.overview,
                                posterPath: movie.poster_path,
                                backdropPath: movie.backdrop_path,
                                releaseDate: movie.release_date,
                                popularity: movie.popularity,
                                voteAverage: movie.vote_average,
                                voteCount: movie.vote_count,
                                genreIds: movie.genres?.map((g) => g.id) || [],
                                source: 'custom' as const,
                                boostFactor: customConfig.boostFactor || 5.0, // Custom items get high boost by default
                                isFeatured: true,
                                isNewRelease: false,
                                isFromCollection: false,
                            };
                        }
                    } catch (error) {
                        logger.warn('Failed to fetch custom movie', { movieId }, error as Error);
                    }
                    return null;
                });

                const movies = (await Promise.all(moviePromises)).filter(
                    Boolean,
                ) as DiscoveredItem[];
                results.push(...movies);
            }

            // Fetch TV shows
            if (customConfig.tvIds?.length) {
                logger.debug('Fetching custom TV shows', {
                    count: customConfig.tvIds.length,
                });

                const tvPromises = customConfig.tvIds.slice(0, limit).map(async (tvId) => {
                    try {
                        const tv = await tmdbApi.getTVShowDetails(tvId);
                        if (tv?.id) {
                            return {
                                id: tv.id,
                                mediaType: 'tv' as const,
                                title: tv.name || tv.title || 'Unknown',
                                overview: tv.overview,
                                posterPath: tv.poster_path,
                                backdropPath: tv.backdrop_path,
                                releaseDate: tv.first_air_date,
                                popularity: tv.popularity,
                                voteAverage: tv.vote_average,
                                voteCount: tv.vote_count,
                                genreIds: tv.genres?.map((g) => g.id) || [],
                                source: 'custom' as const,
                                boostFactor: customConfig.boostFactor || 5.0,
                                isFeatured: true,
                                isNewRelease: false,
                                isFromCollection: false,
                            };
                        }
                    } catch (error) {
                        logger.warn('Failed to fetch custom TV show', { tvId }, error as Error);
                    }
                    return null;
                });

                const shows = (await Promise.all(tvPromises)).filter(Boolean) as DiscoveredItem[];
                results.push(...shows);
            }

            logger.debug('Custom source discovered', {
                count: results.length,
                holidayId: holiday.id,
            });
        } catch (error) {
            logger.error('Custom discovery failed', error as Error);
        }

        return results;
    }
}

// Export singleton instance
export const customSource = new CustomContentSourceAdapter();
