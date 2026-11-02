// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Series Service
 * Handles TV series, seasons, and episodes
 *
 * Note: These methods return MAPPED format (camelCase) as mentioned in CLAUDE.md
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import type {
    BaseItemDto,
    ChapterInfo as JellyfinChapterInfo,
} from '@jellyfin/sdk/lib/generated-client/models';
import { JellyfinBaseClient } from './base-client.js';
import type { SeasonEpisode } from './types/jellyfin.types.js';
import type { ChapterInfo, NextEpisodeInfo } from '../types.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
type JellyfinItemsResponse<T> = {
    Items?: T[];
};

const getErrorStatus = (error: unknown): number | undefined => {
    if (typeof error !== 'object' || error === null) return undefined;
    const response = (error as { response?: { status?: number } }).response;
    return response?.status;
};

export class JellyfinSeriesService extends JellyfinBaseClient {
    constructor() {
        super('JellyfinSeries');
    }

    /**
     * Fetches all seasons for a TV series
     * @param seriesId - The Jellyfin series ID
     * @param userId - The Jellyfin user ID (optional, for user-specific data)
     * @returns Array of seasons with episode counts (MAPPED: camelCase properties)
     */
    async getSeriesSeasons(
        seriesId: string,
        userId?: string,
    ): Promise<
        {
            seasonNumber: number;
            name: string;
            id: string;
            episodeCount: number;
            watchedCount: number;
            premiereDate?: string;
            overview?: string;
            imageTag?: string;
        }[]
    > {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }

        try {
            // Fetch seasons for the series
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<BaseItemDto>>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Shows/${encodePathSegment(seriesId)}/Seasons`,
                ),
                {
                    params: {
                        userId,
                        fields: 'Overview,ChildCount,ImageTags',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const seasons = response.data.Items ?? [];

            // Map seasons to simplified format
            return seasons
                .filter((season): season is BaseItemDto & { Id: string } => !!season.Id)
                .map((season) => ({
                    seasonNumber: season.IndexNumber ?? 0,
                    name: season.Name || `Season ${season.IndexNumber}`,
                    id: season.Id,
                    episodeCount: season.ChildCount || 0,
                    watchedCount:
                        season.UserData?.UnplayedItemCount != null
                            ? (season.ChildCount || 0) - season.UserData.UnplayedItemCount
                            : 0,
                    premiereDate: season.PremiereDate ?? undefined,
                    overview: season.Overview ?? undefined,
                    imageTag: season.ImageTags?.Primary ?? undefined,
                }))
                .sort(
                    (a: { seasonNumber: number }, b: { seasonNumber: number }) =>
                        a.seasonNumber - b.seasonNumber,
                );
        } catch (error) {
            this.logger.error('Failed to get series seasons', error as Error);
            return [];
        }
    }

    /**
     * Fetches all episodes for a specific season of a TV series
     * @param seriesId - The Jellyfin series ID
     * @param seasonId - The Jellyfin season ID (optional, use with seasonNumber)
     * @param seasonNumber - The season number (optional, use with seasonId)
     * @param userId - The Jellyfin user ID (optional, for user-specific data)
     * @returns Array of episodes with playback info (MAPPED: camelCase properties)
     */
    async getSeasonEpisodes(
        seriesId: string,
        options: {
            seasonId?: string;
            seasonNumber?: number;
            userId?: string;
        } = {},
    ): Promise<SeasonEpisode[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }

        try {
            const params: Record<string, string | number | boolean | undefined> = {
                fields: 'Overview,MediaSources',
            };

            if (options.userId) {
                params.userId = options.userId;
            }
            if (options.seasonId) {
                params.seasonId = options.seasonId;
            }
            if (options.seasonNumber !== undefined) {
                params.season = options.seasonNumber;
            }

            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<BaseItemDto>>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Shows/${encodePathSegment(seriesId)}/Episodes`,
                ),
                {
                    params,
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const episodes = response.data.Items ?? [];

            return episodes
                .filter((episode): episode is BaseItemDto & { Id: string } => !!episode.Id)
                .map((episode) => ({
                    id: episode.Id,
                    name: episode.Name || `Episode ${episode.IndexNumber}`,
                    episodeNumber: episode.IndexNumber ?? 0,
                    seasonNumber: episode.ParentIndexNumber ?? 0,
                    overview: episode.Overview ?? undefined,
                    runTimeTicks: episode.RunTimeTicks || 0,
                    premiereDate: episode.PremiereDate ?? undefined,
                    imageTag: episode.ImageTags?.Primary ?? undefined,
                    playedPercentage: episode.UserData?.PlayedPercentage || 0,
                    played: episode.UserData?.Played || false,
                    playbackPositionTicks: episode.UserData?.PlaybackPositionTicks || 0,
                }))
                .sort(
                    (a: { episodeNumber: number }, b: { episodeNumber: number }) =>
                        a.episodeNumber - b.episodeNumber,
                );
        } catch (error) {
            this.logger.error('Failed to get season episodes', error as Error);
            return [];
        }
    }

    /**
     * Fetches series details including total episode count
     * @param seriesId - The Jellyfin series ID
     * @param userId - The Jellyfin user ID (optional)
     * @returns Series details
     */
    async getSeriesDetails(
        seriesId: string,
        userId?: string,
    ): Promise<{
        id: string;
        name: string;
        overview?: string;
        year?: number;
        status?: string;
        totalSeasons: number;
        totalEpisodes: number;
        genres?: string[];
        communityRating?: number;
        tmdbId?: string;
    } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        try {
            const response = await this.api!.axiosInstance.get<BaseItemDto>(
                joinUpstreamUrl(this.api!.basePath, `/Items/${encodePathSegment(seriesId)}`),
                {
                    params: {
                        // Only include userId if provided (empty string causes Jellyfin error)
                        ...(userId ? { userId } : {}),
                        fields: 'Overview,ProviderIds,Genres,ChildCount',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const series = response.data;
            if (!series?.Id || !series.Name) {
                return null;
            }

            // Also get seasons to count total episodes
            const seasons = await this.getSeriesSeasons(seriesId, userId);
            const totalEpisodes = seasons.reduce((sum, s) => sum + s.episodeCount, 0);

            return {
                id: series.Id,
                name: series.Name,
                overview: series.Overview ?? undefined,
                year: series.ProductionYear ?? undefined,
                status: series.Status ?? undefined,
                totalSeasons: seasons.length,
                totalEpisodes,
                genres: series.Genres ?? undefined,
                communityRating: series.CommunityRating ?? undefined,
                tmdbId: series.ProviderIds?.Tmdb ?? undefined,
            };
        } catch (error) {
            // 404 is expected for deleted series - don't log as error
            if (getErrorStatus(error) === 404) {
                this.logger.debug('Series not found (deleted?)', { seriesId });
            } else {
                this.logger.error('Failed to get series details', error as Error);
            }
            return null;
        }
    }

    /**
     * Fetches ALL episodes for a TV series across all seasons
     * @param seriesId - The Jellyfin series ID
     * @param userId - The Jellyfin user ID (optional)
     * @returns Array of all episodes with metadata
     */
    async getAllSeriesEpisodes(
        seriesId: string,
        userId?: string,
    ): Promise<
        {
            id: string;
            name: string;
            episodeNumber: number;
            seasonNumber: number;
            overview?: string;
            runTimeTicks: number;
            premiereDate?: string;
            imageTag?: string;
            seriesName?: string;
            seriesId: string;
        }[]
    > {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }

        try {
            // Fetch all episodes directly (without filtering by season)
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<BaseItemDto>>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Shows/${encodePathSegment(seriesId)}/Episodes`,
                ),
                {
                    params: {
                        userId,
                        fields: 'Overview,ProviderIds',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const episodes = response.data.Items ?? [];

            return episodes
                .filter((episode): episode is BaseItemDto & { Id: string } => !!episode.Id)
                .map((episode) => ({
                    id: episode.Id,
                    name: episode.Name || `Episode ${episode.IndexNumber}`,
                    episodeNumber: episode.IndexNumber ?? 0,
                    seasonNumber: episode.ParentIndexNumber ?? 0,
                    overview: episode.Overview ?? undefined,
                    runTimeTicks: episode.RunTimeTicks || 0,
                    premiereDate: episode.PremiereDate ?? undefined,
                    imageTag: episode.ImageTags?.Primary ?? undefined,
                    seriesName: episode.SeriesName ?? undefined,
                    seriesId: episode.SeriesId ?? seriesId,
                }))
                .sort(
                    (
                        a: { seasonNumber: number; episodeNumber: number },
                        b: { seasonNumber: number; episodeNumber: number },
                    ) => {
                        // Sort by season, then by episode number
                        if (a.seasonNumber !== b.seasonNumber) {
                            return a.seasonNumber - b.seasonNumber;
                        }
                        return a.episodeNumber - b.episodeNumber;
                    },
                );
        } catch (error) {
            // 404 is expected for deleted series - don't log as error
            if (getErrorStatus(error) === 404) {
                this.logger.debug('Series episodes not found (deleted?)', {
                    seriesId,
                });
            } else {
                this.logger.error('Failed to get all series episodes', error as Error);
            }
            return [];
        }
    }

    /**
     * Get item details with chapters (lightweight, no playback session)
     * @param itemId - The Jellyfin item ID
     * @param userId - The Jellyfin user ID
     * @returns Item details with chapters and runtime
     */
    async getItemWithChapters(
        itemId: string,
        userId: string,
    ): Promise<{ runTimeTicks: number; chapters: ChapterInfo[] } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        try {
            const response = await this.api!.axiosInstance.get<
                BaseItemDto & { Chapters?: JellyfinChapterInfo[] }
            >(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Users/${encodePathSegment(userId)}/Items/${encodePathSegment(itemId)}`,
                ),
                {
                    params: {
                        fields: 'Chapters',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const item = response.data;

            // Transform chapters
            const chapters: ChapterInfo[] = (item.Chapters ?? []).map(
                (chapter: JellyfinChapterInfo, index: number) => ({
                    startPositionTicks: chapter.StartPositionTicks || 0,
                    name: chapter.Name || `Chapter ${index + 1}`,
                    imageTag: chapter.ImageTag ?? undefined,
                    index,
                }),
            );

            return {
                runTimeTicks: item.RunTimeTicks || 0,
                chapters,
            };
        } catch (error) {
            this.logger.error('Failed to get item with chapters', error as Error);
            return null;
        }
    }

    /**
     * Get the next episode in a series after the current one
     * @param seriesId - The series ID
     * @param seasonNumber - Current season number
     * @param episodeNumber - Current episode number
     * @param userId - The user ID for user data
     * @returns Next episode info or null if this is the last episode
     */
    async getNextEpisode(
        seriesId: string,
        seasonNumber: number,
        episodeNumber: number,
        userId: string,
    ): Promise<NextEpisodeInfo | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        try {
            // Get all episodes in the series sorted by season and episode number
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<BaseItemDto>>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Shows/${encodePathSegment(seriesId)}/Episodes`,
                ),
                {
                    params: {
                        userId,
                        fields: 'Overview,SeriesName',
                        sortBy: 'ParentIndexNumber,IndexNumber',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const episodes = response.data.Items ?? [];

            // Find the current episode index
            let currentIndex = -1;
            for (let i = 0; i < episodes.length; i++) {
                const ep = episodes[i];
                if (ep.ParentIndexNumber === seasonNumber && ep.IndexNumber === episodeNumber) {
                    currentIndex = i;
                    break;
                }
            }

            // If we found the current episode and there's a next one
            if (currentIndex >= 0 && currentIndex < episodes.length - 1) {
                const nextEp = episodes[currentIndex + 1];
                if (!nextEp.Id || !nextEp.Name) {
                    return null;
                }
                const nextSeasonNumber = nextEp.ParentIndexNumber ?? undefined;
                const isNewSeason = nextSeasonNumber != null && nextSeasonNumber !== seasonNumber;
                const hasPrimaryImage = !!nextEp.ImageTags?.Primary;

                return {
                    itemId: nextEp.Id,
                    title: nextEp.Name,
                    episodeNumber: nextEp.IndexNumber ?? undefined,
                    seasonNumber: nextSeasonNumber,
                    isNewSeason,
                    seriesName: nextEp.SeriesName ?? undefined,
                    hasPrimaryImage,
                };
            }

            // No next episode found
            return null;
        } catch (error) {
            this.logger.error('Failed to get next episode', error as Error);
            return null;
        }
    }

    /**
     * Find an episode by series name, season, and episode number
     * @param seriesName - The series name to search for
     * @param season - Season number
     * @param episode - Episode number
     * @param options - Search options
     * @param options.exactMatch - If true, only use exact indexing (no fallback strategies)
     * @returns Episode ID or null if not found
     */
    async findEpisode(
        seriesName: string,
        season: number,
        episode: number,
        options?: { exactMatch?: boolean },
    ): Promise<{ Id: string } | null> {
        const exactMatch = options?.exactMatch ?? false;
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }
        try {
            this.logger.debug('Searching for episode', {
                seriesName,
                season,
                episode,
                exactMatch,
            });

            // First attempt: exact search term
            let response = await this.api!.axiosInstance.get<JellyfinItemsResponse<BaseItemDto>>(
                joinUpstreamUrl(this.api!.basePath, `/Items`),
                {
                    params: {
                        searchTerm: seriesName,
                        includeItemTypes: 'Episode',
                        parentIndexNumber: season,
                        indexNumber: episode,
                        recursive: true,
                        limit: 10, // Get more results to debug
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            let items: BaseItemDto[] = response.data.Items ?? [];
            this.logger.debug(`Found ${items.length} episodes on first search`);

            if (items.length === 0) {
                // Second attempt: Get series ID first, then search episodes by ParentId
                this.logger.debug(`Trying to find series "${seriesName}" first...`);
                const seriesResponse = await this.api!.axiosInstance.get<
                    JellyfinItemsResponse<BaseItemDto>
                >(joinUpstreamUrl(this.api!.basePath, `/Items`), {
                    params: {
                        searchTerm: seriesName,
                        includeItemTypes: 'Series',
                        recursive: true,
                        limit: 10,
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                });

                const series: BaseItemDto[] = seriesResponse.data.Items ?? [];
                this.logger.debug(`Found ${series.length} series matching "${seriesName}"`);

                let seriesId = null;
                // Look for exact name match first (renamed from exactMatch to avoid shadowing)
                const exactNameMatch = series.find((s: BaseItemDto) => s.Name === seriesName);
                if (exactNameMatch) {
                    seriesId = exactNameMatch.Id;
                    this.logger.debug(
                        `Using exact series match: ${exactNameMatch.Name} (${seriesId})`,
                    );
                } else if (series.length > 0) {
                    seriesId = series[0].Id;
                    this.logger.debug(`Using first series match: ${series[0].Name} (${seriesId})`);
                }

                if (seriesId) {
                    // Now search episodes by ParentId
                    this.logger.debug(`Searching episodes for series ID: ${seriesId}`);
                    response = await this.api!.axiosInstance.get<
                        JellyfinItemsResponse<BaseItemDto>
                    >(joinUpstreamUrl(this.api!.basePath, `/Items`), {
                        params: {
                            ParentId: seriesId,
                            includeItemTypes: 'Episode',
                            recursive: true,
                            limit: 1000,
                            sortBy: 'ParentIndexNumber,IndexNumber',
                            sortOrder: 'Ascending',
                        },
                        headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                    });

                    const allEpisodes: BaseItemDto[] = response.data.Items ?? [];
                    this.logger.debug(`Found ${allEpisodes.length} total episodes for series`);

                    // Debug: Show the season/episode numbers we found
                    this.logger.debug('Episode season/episode numbers found', {
                        episodes: allEpisodes.map((ep: BaseItemDto) => ({
                            name: ep.Name,
                            season: ep.ParentIndexNumber,
                            episode: ep.IndexNumber,
                        })),
                    });

                    // Try multiple matching strategies since indexing is unreliable

                    // Strategy 1: Try exact season/episode numbers
                    items = allEpisodes.filter(
                        (item: BaseItemDto) =>
                            item.ParentIndexNumber === season && item.IndexNumber === episode,
                    );
                    if (items.length > 0) {
                        this.logger.debug('Strategy 1 - Found by exact season/episode numbers');
                    }

                    // Strategy 2: Try matching S##E## pattern in name
                    if (items.length === 0) {
                        const seasonEpisodePattern = new RegExp(
                            `S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`,
                            'i',
                        );
                        items = allEpisodes.filter((item: BaseItemDto) =>
                            seasonEpisodePattern.test(item.Name || ''),
                        );
                        if (items.length > 0) {
                            this.logger.debug('Strategy 2 - Found by S##E## pattern in name');
                        }
                    }

                    // Strategy 3: Try season - 1 (common offset)
                    // ONLY use this fallback when NOT in exact match mode
                    if (items.length === 0 && !exactMatch) {
                        // Try season - 1 (common offset)
                        const altSeason = season - 1;
                        items = allEpisodes.filter(
                            (item: BaseItemDto) =>
                                item.ParentIndexNumber === altSeason &&
                                item.IndexNumber === episode,
                        );
                        if (items.length > 0) {
                            this.logger.debug('Strategy 3 - Found by season - 1 offset');
                        }
                    }

                    // Strategy 4: Extract season/episode from name (S##E##) and search by that
                    if (items.length === 0) {
                        const seasonPattern = new RegExp(
                            `S${season.toString().padStart(2, '0')}`,
                            'i',
                        );
                        const seasonMatches = allEpisodes.filter((item: BaseItemDto) =>
                            seasonPattern.test(item.Name || ''),
                        );
                        this.logger.debug(
                            `Strategy 4 - Season ${season} episodes found: ${seasonMatches.length}`,
                            {
                                matches: seasonMatches.map((ep: BaseItemDto) => ({
                                    name: ep.Name,
                                    season: ep.ParentIndexNumber,
                                    episode: ep.IndexNumber,
                                })),
                            },
                        );

                        // Try to find the specific episode within season matches
                        const episodePattern = new RegExp(
                            `E${episode.toString().padStart(2, '0')}`,
                            'i',
                        );
                        items = seasonMatches.filter((item: BaseItemDto) =>
                            episodePattern.test(item.Name || ''),
                        );
                        if (items.length > 0) {
                            this.logger.debug('Strategy 4 - Found by S##E## pattern extraction');
                        }
                    }
                }
            }

            if (items.length > 0) {
                const foundItem = items[0];
                if (!foundItem.Id) {
                    return null;
                }
                this.logger.debug('Found episode', {
                    id: foundItem.Id,
                    name: foundItem.Name,
                    season: foundItem.ParentIndexNumber,
                    episode: foundItem.IndexNumber,
                    seriesName: foundItem.SeriesName,
                });
                return { Id: foundItem.Id };
            }

            this.logger.debug('Episode not found after trying all strategies', {
                seriesName,
                season,
                episode,
            });
            return null;
        } catch (error) {
            this.logger.error('Failed to find episode', error as Error, {
                seriesName,
                season,
                episode,
            });
            return null;
        }
    }
}

// Export singleton instance
export const jellyfinSeriesService = new JellyfinSeriesService();
