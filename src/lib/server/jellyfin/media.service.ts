// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Media Service
 * Handles media-related operations: search, items, genres
 * Extracted from the monolithic jellyfin.ts for better organization
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import type { BaseItemDto, NameGuidPair, UserDto } from '@jellyfin/sdk/lib/generated-client/models';
import { JellyfinBaseClient } from './base-client.js';
import type { JellyfinItem } from './types/jellyfin.types.js';
import { config } from '../config.js';
import { cacheManager, CACHE_NAMESPACES } from '../cache/index.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
type JellyfinItemsResponse<T> = {
    Items?: T[];
};

/**
 * Service for media-related Jellyfin operations
 * Handles searching, fetching items, genres, and library queries
 */
export class JellyfinMediaService extends JellyfinBaseClient {
    constructor() {
        super('Jellyfin:Media');
    }

    /**
     * Search for items by type
     */
    private async searchItems(
        userId: string,
        searchTerm: string,
        itemType: 'Series' | 'Movie',
        fields: string,
    ): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}/Items`),
                {
                    params: {
                        searchTerm,
                        includeItemTypes: itemType,
                        recursive: true,
                        limit: 10,
                        fields,
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data.Items || [];
        } catch (error) {
            this.logger.error(`Failed to search ${itemType.toLowerCase()}`, error as Error);
            return [];
        }
    }

    /**
     * Search for a series by name
     */
    async searchSeries(userId: string, searchTerm: string): Promise<JellyfinItem[]> {
        return this.searchItems(
            userId,
            searchTerm,
            'Series',
            'Overview,ChildCount,Genres,RemoteTrailers,ProviderIds,Studios,CommunityRating,CriticRating',
        );
    }

    async searchMovie(userId: string, searchTerm: string): Promise<JellyfinItem[]> {
        return this.searchItems(
            userId,
            searchTerm,
            'Movie',
            'Overview,Genres,RemoteTrailers,ProviderIds,Studios,CommunityRating,CriticRating,RunTimeTicks',
        );
    }

    /**
     * Search for movies and TV shows by person/actor name
     */
    async searchByPerson(userId: string, personName: string): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}/Items`),
                {
                    params: {
                        person: personName,
                        includeItemTypes: 'Movie,Series',
                        recursive: true,
                        limit: 100,
                        fields: 'ProviderIds',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data.Items || [];
        } catch (error) {
            this.logger.error('Failed to search by person', error as Error);
            return [];
        }
    }

    /**
     * Get a single item by ID
     */
    async getItemById(userId: string, itemId: string): Promise<JellyfinItem | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItem>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Users/${encodePathSegment(userId)}/Items/${encodePathSegment(itemId)}`,
                ),
                {
                    params: {
                        fields: 'Overview,ChildCount,Genres,RemoteTrailers,ProviderIds,Studios,CommunityRating,CriticRating',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data || null;
        } catch (error) {
            this.logger.error('Failed to get item by ID', error as Error);
            return null;
        }
    }

    /**
     * Get item info for various use cases (image proxy fallback, I-frame playlist generation)
     * Uses default user since these calls don't have user context
     * Returns Type, ParentId, SeriesId, and optionally RunTimeTicks and MediaStreams
     */
    async getItemInfo(itemId: string): Promise<{
        Type: string;
        ParentId?: string;
        SeriesId?: string;
        RunTimeTicks?: number;
        MediaStreams?: Array<{ Type: string; Index: number }>;
    } | null> {
        if (!this.isConfigured()) {
            return null;
        }
        try {
            // Get a default user ID for the API call
            const defaultUser = await this.getUserByName(config.DEFAULT_USER);
            if (!defaultUser?.Id) {
                this.logger.warn('No default user found for getItemInfo');
                return null;
            }

            const response = await this.api!.axiosInstance.get<JellyfinItem>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Users/${encodePathSegment(defaultUser.Id)}/Items/${encodePathSegment(itemId)}`,
                ),
                {
                    params: {
                        fields: 'ParentId,MediaStreams',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data
                ? {
                      Type: response.data.Type,
                      ParentId: response.data.ParentId,
                      SeriesId: response.data.SeriesId,
                      RunTimeTicks: response.data.RunTimeTicks,
                      MediaStreams: response.data.MediaStreams,
                  }
                : null;
        } catch (error) {
            this.logger.debug('Failed to get item info', {
                itemId,
                error: (error as Error).message,
            });
            return null;
        }
    }

    /**
     * Get the type of an item (Movie, Series, Episode, etc.)
     * Used for determining if we need to redirect series to first episode
     */
    async getItemType(itemId: string, userId: string): Promise<string | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItem>(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/Users/${encodePathSegment(userId)}/Items/${encodePathSegment(itemId)}`,
                ),
                {
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data?.Type || null;
        } catch (error) {
            this.logger.error('Failed to get item type', error as Error);
            return null;
        }
    }

    async getItems(
        userId: string,
        includeItemTypes: string[],
        options: {
            isUnplayed?: boolean;
            limit?: number;
            startIndex?: number;
            parentId?: string;
            recursive?: boolean;
            fields?: string;
            sortBy?: string;
            sortOrder?: 'Ascending' | 'Descending';
            includeUserData?: boolean;
        } = {},
    ): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            const params: Record<string, string | number | boolean | undefined> = {
                includeItemTypes: includeItemTypes.join(','),
                isUnplayed: options.isUnplayed,
                limit: options.limit || 20,
                startIndex: options.startIndex,
                parentId: options.parentId,
                recursive: options.recursive ?? true,
                fields: options.fields || 'Overview,ChildCount,Genres,RemoteTrailers',
                ...(options.includeUserData && { enableUserData: 'true' }),
            };

            // Only add sortBy if it's provided and not empty
            if (options.sortBy && options.sortBy.trim() !== '') {
                params.sortBy = options.sortBy;
            } else if (!options.sortBy) {
                params.sortBy = 'Random';
            }
            if (options.sortOrder) {
                params.sortOrder = options.sortOrder;
            }

            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}/Items`),
                {
                    params,
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data.Items || [];
        } catch (error) {
            this.logger.error('Failed to get items', error as Error);
            return [];
        }
    }

    /**
     * Fetch the user's Jellyfin Favorites, filtered to the given item types.
     *
     * Unlike every other method in this class, this THROWS on failure instead
     * of swallowing to `[]` — the watchlist-import caller must be able to
     * distinguish "zero favorites" from "Jellyfin is unreachable" (the latter
     * must not report as a false-success "Synced 0 of 0" toast).
     */
    async getFavoriteItems(userId: string, includeItemTypes: string[]): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            throw new Error('Jellyfin not configured');
        }
        const FAVORITES_LIMIT = 300;
        const response = await this.api!.axiosInstance.get<{
            Items?: JellyfinItem[];
            TotalRecordCount?: number;
        }>(joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}/Items`), {
            params: {
                includeItemTypes: includeItemTypes.join(','),
                filters: 'IsFavorite',
                fields: 'ProviderIds',
                recursive: true,
                limit: FAVORITES_LIMIT,
            },
            headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
        });
        const items = response.data.Items || [];
        const total = response.data.TotalRecordCount ?? items.length;
        if (total > FAVORITES_LIMIT) {
            this.logger.warn('Jellyfin favorites list truncated on import', {
                userId,
                total,
                limit: FAVORITES_LIMIT,
            });
        }
        return items;
    }

    async getItemsByGenre(
        userId: string,
        genre: string,
        options: {
            includeItemTypes?: string[];
            limit?: number;
            sortBy?: string;
        } = {},
    ): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<JellyfinItem>>(
                joinUpstreamUrl(this.api!.basePath, `/Users/${encodePathSegment(userId)}/Items`),
                {
                    params: {
                        includeItemTypes: (options.includeItemTypes || ['Movie', 'Series']).join(
                            ',',
                        ),
                        genres: genre,
                        limit: options.limit || 20,
                        recursive: true,
                        fields: 'Overview,Genres,CommunityRating,ProviderIds,RunTimeTicks,RemoteTrailers',
                        sortBy: options.sortBy || 'SortName',
                        sortOrder: 'Ascending',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            return response.data.Items || [];
        } catch (error) {
            this.logger.error('Failed to get items by genre', error as Error);
            return [];
        }
    }

    async getGenresList(
        userId: string,
        includeItemTypes: string[] = ['Movie', 'Series'],
    ): Promise<string[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }
        try {
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<NameGuidPair>>(
                joinUpstreamUrl(this.api!.basePath, `/Genres`),
                {
                    params: {
                        userId,
                        includeItemTypes: includeItemTypes.join(','),
                        fields: 'ItemCounts',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            // Return only genre names, sorted alphabetically
            return (response.data.Items || [])
                .map((g: NameGuidPair) => g.Name)
                .filter((name): name is string => typeof name === 'string' && name.length > 0)
                .sort();
        } catch (error) {
            this.logger.error('Failed to get genres', error as Error);
            return [];
        }
    }

    async searchLiveTvChannels(query: string, limit = 10): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured for LiveTV search');
            return [];
        }
        try {
            // Jellyfin's LiveTv/Channels endpoint doesn't support searchTerm
            // So we fetch all channels and filter client-side
            const response = await this.api!.axiosInstance.get<JellyfinItemsResponse<BaseItemDto>>(
                joinUpstreamUrl(this.api!.basePath, `/LiveTv/Channels`),
                {
                    params: {
                        limit: 500, // Fetch more channels to search through
                        fields: 'Overview',
                        sortBy: 'SortName',
                        sortOrder: 'Ascending',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const allChannels = response.data.Items || [];
            const queryLower = query.toLowerCase();

            // Common channel name aliases/abbreviations
            const channelAliases: Record<string, string[]> = {
                prosieben: ['pro7', 'pro 7', 'prosieben'],
                'sat.1': ['sat1', 'sat 1', 'sat.1'],
                rtl: ['rtl'],
                rtl2: ['rtl 2', 'rtl2', 'rtl zwei', 'rtlzwei'],
                vox: ['vox'],
                'kabel eins': ['kabel1', 'kabel 1', 'kabeleins'],
                'super rtl': ['superrtl', 'super rtl', 'srtl'],
                zdf: ['zdf'],
                ard: ['ard', 'das erste'],
                arte: ['arte'],
                'n-tv': ['ntv', 'n-tv'],
                welt: ['welt', 'n24'],
                sixx: ['sixx', '6'],
                'pro7 maxx': ['pro7maxx', 'pro7 maxx', 'prosieben maxx'],
                'sat.1 gold': ['sat1gold', 'sat.1 gold', 'sat1 gold'],
                nitro: ['nitro', 'rtl nitro'],
                'tele 5': ['tele5', 'tele 5'],
                dmax: ['dmax'],
                tlc: ['tlc'],
                'comedy central': ['cc', 'comedy central'],
                disney: ['disney', 'disney channel'],
                nick: ['nick', 'nickelodeon'],
                mtv: ['mtv'],
            };

            // Normalize query - check if it matches any alias
            const matchesAlias = (channelName: string, searchQuery: string): boolean => {
                const nameLower = channelName.toLowerCase();

                // Direct match
                if (nameLower.includes(searchQuery)) return true;

                // Check aliases
                for (const [canonical, aliases] of Object.entries(channelAliases)) {
                    // If the search query matches an alias
                    if (
                        aliases.some(
                            (alias) => alias.includes(searchQuery) || searchQuery.includes(alias),
                        )
                    ) {
                        // Check if the channel name contains the canonical name or any alias
                        if (
                            nameLower.includes(canonical) ||
                            aliases.some((alias) => nameLower.includes(alias))
                        ) {
                            return true;
                        }
                    }
                }

                return false;
            };

            // Filter channels by name matching the query (with alias support)
            const matchingChannels = allChannels.filter((ch) => {
                const name = (ch.Name || '').toLowerCase();
                const channelNumber = (ch.ChannelNumber || '').toLowerCase();
                return matchesAlias(name, queryLower) || channelNumber.includes(queryLower);
            });

            return matchingChannels
                .slice(0, limit)
                .map((ch) => {
                    if (!ch.Id || !ch.Name) return null;
                    return {
                        ...ch,
                        Id: ch.Id,
                        Name: ch.Name,
                        Type: 'TvChannel',
                    } as JellyfinItem;
                })
                .filter((ch): ch is JellyfinItem => ch !== null);
        } catch (error) {
            this.logger.error('Failed to search Live TV channels', error as Error);
            return [];
        }
    }

    /**
     * Get all movies and series from the Jellyfin library
     * Used for syncing metadata to the AI database
     * @param userId - The Jellyfin user ID
     * @param options - Optional parameters for filtering and limiting results
     * @returns Combined array of all movies and series
     */
    async getAllMoviesAndSeries(
        userId: string,
        options: {
            movieLimit?: number;
            seriesLimit?: number;
            fields?: string;
            recursive?: boolean;
        } = {},
    ): Promise<JellyfinItem[]> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return [];
        }

        // Type-safe cache - TTLs from centralized CACHE_NAMESPACES config
        // Long TTL (24h L2) since library metadata rarely changes
        const libraryCache = cacheManager.for(CACHE_NAMESPACES.jellyfinLibrary);

        // Create cache key based on options
        const cacheKey = `all-items:${options.movieLimit || 3000}:${options.seriesLimit || 2000}:${options.fields || 'ProviderIds'}`;

        // Try to get from cache
        const cached = await libraryCache.get<JellyfinItem[]>(cacheKey, userId);
        if (cached) {
            return cached;
        }

        // Cache miss - fetch from Jellyfin
        try {
            const [movies, series] = await Promise.all([
                this.getItems(userId, ['Movie'], {
                    limit: options.movieLimit || 3000,
                    recursive: options.recursive ?? true,
                    fields: options.fields || 'ProviderIds',
                }),
                this.getItems(userId, ['Series'], {
                    limit: options.seriesLimit || 2000,
                    recursive: options.recursive ?? true,
                    fields: options.fields || 'ProviderIds',
                }),
            ]);

            const allItems = [...(movies || []), ...(series || [])];

            // Cache the result - TTL from CACHE_NAMESPACES.jellyfinLibrary
            await libraryCache.set(cacheKey, allItems, undefined, userId);

            return allItems;
        } catch (error) {
            this.logger.error('Failed to fetch all movies and series', error as Error);
            return [];
        }
    }

    /**
     * Fetch item metadata using the admin API (no userId required).
     * Uses /Items/{itemId} with the API key only — same pattern as jellyfinSeriesService.getSeriesDetails.
     * Used by the Jellyfin metadata-provider plugin for system-level access.
     */
    async getItemDetails(itemId: string): Promise<{
        Name: string;
        Overview?: string;
        ProductionYear?: number;
        Genres?: string[];
        RunTimeTicks?: number;
        ProviderIds?: Record<string, string>;
        OriginalTitle?: string;
        PremiereDate?: string;
    } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }
        try {
            const response = await this.api!.axiosInstance.get<BaseItemDto>(
                joinUpstreamUrl(this.api!.basePath, `/Items/${encodePathSegment(itemId)}`),
                {
                    params: {
                        fields: 'Overview,Genres,RunTimeTicks,ProviderIds,OriginalTitle,PremiereDate',
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            const item = response.data;
            if (!item?.Name) return null;
            return {
                Name: item.Name,
                Overview: item.Overview ?? undefined,
                ProductionYear: item.ProductionYear ?? undefined,
                Genres: item.Genres ?? undefined,
                RunTimeTicks: item.RunTimeTicks ?? undefined,
                ProviderIds: item.ProviderIds
                    ? (item.ProviderIds as Record<string, string>)
                    : undefined,
                OriginalTitle: item.OriginalTitle ?? undefined,
                PremiereDate: item.PremiereDate ?? undefined,
            };
        } catch (error) {
            this.logger.debug('Failed to get item details', {
                itemId,
                error: (error as Error).message,
            });
            return null;
        }
    }

    /**
     * Helper method to get user by name
     * Used internally by getItemInfo to get default user
     */
    private async getUserByName(username: string): Promise<{ Id: string; Name: string } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        const cacheKey = username.toLowerCase();

        // Type-safe cache - TTLs from centralized CACHE_NAMESPACES config
        // Long TTL (7 days L2) since user IDs rarely change
        const userCache = cacheManager.for(CACHE_NAMESPACES.jellyfinUsers);

        // Check cache first
        const cached = await userCache.get<{ Id: string; Name: string }>(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const response = await this.api!.axiosInstance.get<UserDto[]>(
                joinUpstreamUrl(this.api!.basePath, `/Users`),
                {
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            const users = response.data || [];
            const user = users.find((u) => u.Name?.toLowerCase() === username.toLowerCase());

            if (user?.Id && user.Name) {
                // Cache the user data
                await userCache.set(cacheKey, {
                    Id: user.Id,
                    Name: user.Name,
                });
                return { Id: user.Id, Name: user.Name };
            }

            return null;
        } catch (error) {
            this.logger.error('Failed to get user by name', error as Error);
            return null;
        }
    }
}

// Export singleton instance
export const jellyfinMediaService = new JellyfinMediaService();
