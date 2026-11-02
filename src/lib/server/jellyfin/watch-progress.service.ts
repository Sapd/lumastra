// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Progress Service
 * Handles all watch progress and history tracking for Jellyfin
 * - Continue watching, next up, recently added
 * - Watch history and watched status
 * - Episode progression tracking
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models';
import { JellyfinBaseClient } from './base-client.js';
import type { JellyfinItem } from './types/jellyfin.types.js';
import { cacheManager, CACHE_NAMESPACES } from '../cache/index.js';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
type JellyfinItemsResponse<T> = {
    Items?: T[];
    TotalRecordCount?: number;
};

export class JellyfinWatchProgressService extends JellyfinBaseClient {
    constructor() {
        super('Jellyfin:WatchProgress');
    }

    async getContinueWatching(userId: string, limit = 20): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Users/${encodePathSegment(userId)}/Items/Resume`,
                ),
                {
                    params: {
                        limit,
                        fields: 'Overview,Genres,CommunityRating,ProviderIds,SeriesProviderIds,RunTimeTicks,UserData',
                        enableUserData: true,
                        mediaTypes: 'Video',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data.Items || [];
        } catch (error) {
            this.logger.error('Failed to get continue watching', error as Error);
            return [];
        }
    }

    async getRecentlyAdded(
        userId: string,
        options: {
            includeItemTypes?: string[];
            limit?: number;
        } = {},
    ): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            // Note: /Items/Latest returns one item per library folder, which is not what we want
            // Use /Items with sortBy=DateCreated for a proper "recently added" list
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}/Items`),
                {
                    params: {
                        includeItemTypes: (options.includeItemTypes || ['Movie', 'Series']).join(
                            ',',
                        ),
                        limit: options.limit || 20,
                        fields: 'Overview,Genres,CommunityRating,ProviderIds,RunTimeTicks,RemoteTrailers',
                        enableUserData: true,
                        recursive: true,
                        sortBy: 'DateCreated',
                        sortOrder: 'Descending',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data.Items || [];
        } catch (error) {
            this.logger.error('Failed to get recently added', error as Error);
            return [];
        }
    }

    async getNextUp(userId: string, limit = 10): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Shows/NextUp`),
                {
                    params: {
                        userId,
                        limit,
                        fields: 'Overview,RemoteTrailers,ProviderIds,SeriesProviderIds',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data.Items || [];
        } catch (error) {
            this.logger.error('Failed to get next up', error as Error);
            return [];
        }
    }

    /**
     * Get the next unwatched episode for a specific series
     * Uses Jellyfin's NextUp API filtered by series ID
     * @returns The next episode to watch, or null if series is fully watched/not started
     */
    async getNextUpForSeries(seriesId: string, userId: string): Promise<JellyfinItem | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Shows/NextUp`),
                {
                    params: {
                        userId,
                        seriesId,
                        limit: 1,
                        fields: 'Overview,UserData,ParentIndexNumber,IndexNumber',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            const items = response.data.Items || [];
            return items.length > 0 ? items[0] : null;
        } catch (error) {
            this.logger.error('Failed to get next up for series', error as Error);
            return null;
        }
    }

    /**
     * Get the first unwatched episode for a series (efficient single API call)
     * Returns all episodes sorted by season/episode, then finds first unwatched
     * More efficient than iterating season by season
     */
    async getFirstUnwatchedEpisode(
        seriesId: string,
        userId: string,
    ): Promise<{
        id: string;
        name: string;
        seasonNumber: number;
        episodeNumber: number;
        overview?: string;
        runtimeTicks?: number;
        premiereDate?: string;
        imageTag?: string;
        played: boolean;
    } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }
        try {
            // Get all episodes for this series in one call
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Shows/${encodePathSegment(seriesId)}/Episodes`,
                ),
                {
                    params: {
                        userId,
                        fields: 'Overview,UserData,PremiereDate',
                        enableUserData: true,
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const allEpisodes = response.data.Items || [];
            if (allEpisodes.length === 0) return null;

            // Filter out specials (Season 0) - prefer regular episodes
            // Only fall back to specials if there are no regular episodes
            const regularEpisodes = allEpisodes.filter(
                (ep: JellyfinItem) => (ep.ParentIndexNumber ?? 0) > 0,
            );
            const episodes = regularEpisodes.length > 0 ? regularEpisodes : allEpisodes;

            // Sort by season then episode number
            episodes.sort((a: JellyfinItem, b: JellyfinItem) => {
                const seasonDiff = (a.ParentIndexNumber || 0) - (b.ParentIndexNumber || 0);
                if (seasonDiff !== 0) return seasonDiff;
                return (a.IndexNumber || 0) - (b.IndexNumber || 0);
            });

            // Find first unwatched
            const unwatched = episodes.find((ep: JellyfinItem) => !ep.UserData?.Played);
            const target = unwatched || episodes[0]; // Fall back to first if all watched

            return {
                id: target.Id,
                name: target.Name,
                seasonNumber: target.ParentIndexNumber || 1,
                episodeNumber: target.IndexNumber || 1,
                overview: target.Overview,
                runtimeTicks: target.RunTimeTicks,
                premiereDate: target.PremiereDate,
                imageTag: target.ImageTags?.Primary,
                played: target.UserData?.Played || false,
            };
        } catch (error) {
            this.logger.error('Failed to get first unwatched episode', error as Error);
            return null;
        }
    }

    /**
     * Get a specific episode by season and episode number
     * Used when UI explicitly requests S1E1 instead of relying on heuristics
     */
    async getEpisodeBySeasonAndNumber(
        seriesId: string,
        seasonNumber: number,
        episodeNumber: number,
        userId: string,
    ): Promise<{
        id: string;
        name: string;
        seasonNumber: number;
        episodeNumber: number;
        overview?: string;
        runtimeTicks?: number;
        premiereDate?: string;
        imageTag?: string;
        played: boolean;
    } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }
        try {
            // Get episodes for the specific season
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Shows/${encodePathSegment(seriesId)}/Episodes`,
                ),
                {
                    params: {
                        userId,
                        seasonNumber,
                        fields: 'Overview,UserData,PremiereDate',
                        enableUserData: true,
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const episodes = response.data.Items || [];

            // Find the exact episode
            const episode = episodes.find((ep: JellyfinItem) => ep.IndexNumber === episodeNumber);

            if (!episode) {
                this.logger.warn('Episode not found', {
                    seriesId,
                    seasonNumber,
                    episodeNumber,
                });
                return null;
            }

            return {
                id: episode.Id,
                name: episode.Name,
                seasonNumber: episode.ParentIndexNumber || seasonNumber,
                episodeNumber: episode.IndexNumber || episodeNumber,
                overview: episode.Overview,
                runtimeTicks: episode.RunTimeTicks,
                premiereDate: episode.PremiereDate,
                imageTag: episode.ImageTags?.Primary,
                played: episode.UserData?.Played || false,
            };
        } catch (error) {
            this.logger.error('Failed to get episode by season and number', error as Error, {
                seriesId,
                seasonNumber,
                episodeNumber,
            });
            return null;
        }
    }

    async getEnhancedNextUp(userId: string, limit = 10): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }

        try {
            // Fetch all three sources in parallel for better performance
            const [continueWatchingResponse, nextUpResponse, recentEpisodesResponse] =
                await Promise.all([
                    // 1. Continue watching (partly watched items) - highest priority
                    this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                        joinUpstreamUrl(
                            this.api!.basePath,
                            `/Users/${encodePathSegment(userId)}/Items/Resume`,
                        ),
                        {
                            params: {
                                limit: 5,
                                fields: 'Overview,RemoteTrailers,PremiereDate,UserData,ProviderIds,SeriesProviderIds',
                                enableUserData: true,
                                mediaTypes: 'Video',
                                includeItemTypes: 'Episode', // Only episodes for the hero section
                            },
                            headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                        },
                    ),
                    // 2. Regular next up episodes
                    this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                        joinUpstreamUrl(this.api!.basePath, `/Shows/NextUp`),
                        {
                            params: {
                                userId,
                                limit: Math.ceil(limit * 0.7),
                                fields: 'Overview,RemoteTrailers,PremiereDate,UserData,ProviderIds,SeriesProviderIds',
                                enableUserData: true,
                            },
                            headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                        },
                    ),
                    // 3. Recent unwatched episodes from last 7 days
                    this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                        joinUpstreamUrl(
                            this.api!.basePath,
                            `/Users/${encodePathSegment(userId)}/Items`,
                        ),
                        {
                            params: {
                                includeItemTypes: 'Episode',
                                recursive: true,
                                fields: 'Overview,RemoteTrailers,PremiereDate,UserData,ProviderIds,SeriesProviderIds',
                                enableUserData: true,
                                filters: 'IsUnplayed',
                                minPremiereDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
                                    .toISOString()
                                    .split('T')[0],
                                sortBy: 'PremiereDate,SortName',
                                sortOrder: 'Descending',
                                limit: Math.floor(limit * 0.3),
                            },
                            headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                        },
                    ),
                ]);

            const continueWatching = continueWatchingResponse.data.Items || [];
            const nextUpItems = nextUpResponse.data.Items || [];
            const recentEpisodes = recentEpisodesResponse.data.Items || [];

            // Track seen IDs to avoid duplicates
            const seenIds = new Set<string>();
            const result: JellyfinItem[] = [];

            // Helper to add items without duplicates
            const addItems = (items: JellyfinItem[]) => {
                for (const item of items) {
                    if (!seenIds.has(item.Id) && result.length < limit) {
                        seenIds.add(item.Id);
                        result.push(item);
                    }
                }
            };

            // Priority order:
            // 1. Continue watching (partly watched) - user explicitly started these
            addItems(continueWatching);
            // 2. Next up (unwatched next episodes from series user is watching)
            addItems(nextUpItems);
            // 3. Recent episodes (newly released)
            addItems(recentEpisodes);

            this.logger.debug('Enhanced Next Up', {
                continueWatching: continueWatching.length,
                nextUp: nextUpItems.length,
                recent: recentEpisodes.length,
                total: result.length,
            });

            return result;
        } catch (error) {
            this.logger.error('Failed to get enhanced next up', error as Error);
            // Fallback to regular next up
            return this.getNextUp(userId, limit);
        }
    }

    async getRecentUnwatchedEpisodes(userId: string, limit = 10): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }

        try {
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}/Items`),
                {
                    params: {
                        includeItemTypes: 'Episode',
                        recursive: true,
                        fields: 'Overview,PremiereDate,SeriesName,ParentIndexNumber,IndexNumber,SeriesId,ParentId',
                        filters: 'IsUnplayed', // Only unwatched episodes
                        minPremiereDate: sevenDaysAgo.toISOString().split('T')[0], // Last 7 days
                        sortBy: 'PremiereDate,SortName',
                        sortOrder: 'Descending',
                        limit: limit,
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            return response.data.Items || [];
        } catch (error) {
            this.logger.error('Failed to get recent unwatched episodes', error as Error);
            return [];
        }
    }

    // Note: getContinueWatching is defined earlier in this class with ProviderIds support

    /**
     * Get recently played/watched items for the user
     * Used for "Because you watched X" recommendations
     */
    async getRecentlyPlayed(userId: string, limit = 10): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}/Items`),
                {
                    params: {
                        limit,
                        recursive: true,
                        fields: 'Overview,ProviderIds,UserData',
                        includeItemTypes: 'Movie',
                        sortBy: 'DatePlayed',
                        sortOrder: 'Descending',
                        filters: 'IsPlayed',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data.Items || [];
        } catch (error) {
            this.logger.error('Failed to get recently played', error as Error);
            return [];
        }
    }

    /**
     * Get watched series names and episode keys in a single paginated API call
     * Returns both series names and episode keys (format: "seriesname|S{season}E{episode}")
     * Efficiently caches both results together
     * @param userId - Jellyfin user ID
     * @param refresh - Force refresh from API (clears cache)
     * @returns Object with series array and episodeKeys Set
     */
    async getWatchedSeriesAndEpisodes(
        userId: string,
        refresh = false,
    ): Promise<{
        series: string[];
        episodeKeys: Set<string>;
    }> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return { series: [], episodeKeys: new Set() };
        }

        // Type-safe cache - TTLs from centralized CACHE_NAMESPACES config
        const watchedSeriesCache = cacheManager.for(CACHE_NAMESPACES.watchedSeries);

        const cacheKey = 'watched-series-and-episodes';

        // Clear cache if refresh requested
        if (refresh) {
            this.logger.debug('Refresh requested - clearing watched series/episodes cache', {
                userId,
            });
            await watchedSeriesCache.delete(cacheKey, userId);
        }

        // Try to get from cache (skip if refresh)
        if (!refresh) {
            const cached = await watchedSeriesCache.get<{
                series: string[];
                episodeKeys: string[];
            }>(cacheKey, userId);
            if (cached) {
                this.logger.debug('Using cached watched series/episodes', {
                    userId,
                });
                return {
                    series: cached.series,
                    episodeKeys: new Set(cached.episodeKeys),
                };
            }
        }

        // Cache miss - fetch from Jellyfin with pagination (SINGLE API call sequence)
        try {
            const watchedSeriesSet = new Set<string>();
            const watchedEpisodeKeys = new Set<string>();
            let startIndex = 0;
            const limit = 1000;
            let hasMore = true;

            // Paginate through ALL watched episodes - extract BOTH series names AND episode keys
            while (hasMore) {
                const response = await this.api!.axiosInstance.get<
                    JellyfinItemsResponse<BaseItemDto>
                >(
                    joinUpstreamUrl(
                        this.api!.basePath,
                        `/Users/${encodePathSegment(userId)}/Items`,
                    ),
                    {
                        params: {
                            includeItemTypes: 'Episode',
                            recursive: true,
                            filters: 'IsPlayed',
                            limit: limit,
                            startIndex: startIndex,
                            fields: 'SeriesName,ParentIndexNumber,IndexNumber',
                        },
                        headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                    },
                );

                const episodes = response.data.Items || [];
                const totalRecordCount = response.data.TotalRecordCount || 0;

                this.logger.debug('Fetched watched episodes batch', {
                    count: episodes.length,
                    startIndex: startIndex + 1,
                    endIndex: startIndex + episodes.length,
                    total: totalRecordCount,
                    userId,
                });

                // Extract BOTH series names AND episode keys from this batch
                episodes.forEach((episode: BaseItemDto) => {
                    if (episode.SeriesName) {
                        watchedSeriesSet.add(episode.SeriesName);

                        // Also build episode key if we have season/episode numbers
                        if (episode.ParentIndexNumber != null && episode.IndexNumber != null) {
                            const key = `${episode.SeriesName.toLowerCase()}|S${episode.ParentIndexNumber}E${episode.IndexNumber}`;
                            watchedEpisodeKeys.add(key);
                        }
                    }
                });

                startIndex += episodes.length;
                hasMore = startIndex < totalRecordCount && episodes.length === limit;
            }

            const watchedSeries = Array.from(watchedSeriesSet);
            this.logger.debug('Watched series/episodes summary', {
                seriesCount: watchedSeries.length,
                episodeKeys: watchedEpisodeKeys.size,
                totalEpisodes: startIndex,
            });

            // Cache both results together - TTL from CACHE_NAMESPACES.watchedSeries
            await watchedSeriesCache.set(
                cacheKey,
                {
                    series: watchedSeries,
                    episodeKeys: Array.from(watchedEpisodeKeys),
                },
                undefined,
                userId,
            );

            return {
                series: watchedSeries,
                episodeKeys: watchedEpisodeKeys,
            };
        } catch (error) {
            this.logger.error('Failed to get watched series and episodes', error as Error);
            return { series: [], episodeKeys: new Set() };
        }
    }

    /**
     * Get watched series names only (uses combined method internally)
     */
    async getWatchedSeries(userId: string): Promise<string[]> {
        const result = await this.getWatchedSeriesAndEpisodes(userId);
        return result.series;
    }

    /**
     * Get watched episode keys (uses combined method internally)
     * Keys are in format "seriesname|S{season}E{episode}" (lowercase)
     */
    async getWatchedEpisodeKeys(userId: string): Promise<Set<string>> {
        const result = await this.getWatchedSeriesAndEpisodes(userId);
        return result.episodeKeys;
    }

    /**
     * Batch check watched status for multiple TMDB IDs in one API call
     * Uses composite keys (tmdbId:mediaType) to avoid TMDB ID collisions
     * @param userId - Jellyfin user ID
     * @param items - Array of {tmdbId, mediaType} to check
     * @returns Map of "tmdbId:mediaType" → isWatched status
     */
    async getWatchedStatusBatch(
        userId: string,
        items: Array<{ tmdbId: number; mediaType: 'movie' | 'tv' }>,
    ): Promise<Map<string, boolean>> {
        const watchedMap = new Map<string, boolean>();

        if (!this.isConfigured() || items.length === 0) {
            return watchedMap;
        }
        if (!userId) {
            this.logger.warn('Missing Jellyfin user ID for watched status batch');
            return watchedMap;
        }

        // Build a Set of composite keys (tmdbId:mediaType) for quick lookup.
        // TMDB IDs are not unique across media types (a movie and a TV series
        // can share the same numeric ID), so we must never match on the raw ID.
        const requestedKeySet = new Set(items.map((i) => `${i.tmdbId}:${i.mediaType}`));

        try {
            // Query Jellyfin for all items with these TMDB IDs in one request
            // This is much more efficient than N separate API calls
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}/Items`),
                {
                    params: {
                        recursive: true,
                        includeItemTypes: 'Movie,Series',
                        fields: 'ProviderIds',
                        enableUserData: true,
                        limit: 5000, // High limit to catch all matches
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const jellyfinItems = response.data.Items || [];

            // Build a map using composite keys (tmdbId:mediaType)
            for (const item of jellyfinItems) {
                const tmdbId = item.ProviderIds?.Tmdb;
                if (tmdbId) {
                    const tmdbIdNum = parseInt(tmdbId);
                    // Determine media type from the Jellyfin item itself, then
                    // match on the composite key so a movie never satisfies a
                    // TV request (and vice-versa) when TMDB IDs collide.
                    const mediaType = toTmdbType(item.Type);
                    const key = `${tmdbIdNum}:${mediaType}`;
                    if (requestedKeySet.has(key)) {
                        // Item is watched if UserData.Played is true
                        const isWatched = item.UserData?.Played === true;
                        watchedMap.set(key, isWatched);
                    }
                }
            }

            return watchedMap;
        } catch (error) {
            this.logger.error('Failed to get watched status batch', error as Error);
            return watchedMap;
        }
    }
}

// Export singleton instance
export const jellyfinWatchProgressService = new JellyfinWatchProgressService();
