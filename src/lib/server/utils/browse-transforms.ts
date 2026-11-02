// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse page data transformation utilities
 * Shared between API endpoint and cache warming
 */

import type { JellyfinItem } from '../jellyfin';
import { isEpisode as isEpisodeType } from './media-types';

/**
 * Extended Jellyfin item with additional browse-specific properties
 */
export interface BrowseJellyfinItem extends JellyfinItem {
    SeriesPrimaryImageTag?: string;
    BackdropImageTags?: string[];
}

export interface BrowseItem {
    id: string;
    name: string;
    type: 'movie' | 'tv' | 'channel';
    year?: number;
    overview?: string;
    communityRating?: number;
    genres?: string[];
    imageId?: string;
    backdropId?: string;
    tmdbId?: number;
    imdbId?: string;
    runTimeTicks?: number;
    trailerUrl?: string;
    userData?: {
        playedPercentage?: number;
        playCount?: number;
        isFavorite?: boolean;
    };
    // Episode-specific fields
    isEpisode?: boolean;
    seriesId?: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    episodeName?: string;
}

export interface GenreRow {
    genre: string;
    items: BrowseItem[];
}

/**
 * Get the normalized item type for browse display
 */
export function getItemType(item: BrowseJellyfinItem): 'movie' | 'tv' | 'channel' {
    const type = item.Type;
    // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's item.Type uses its PascalCase vocabulary.
    if (type === 'Movie') return 'movie';
    // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's item.Type uses its PascalCase vocabulary.
    if (type === 'Series' || type === 'Episode') return 'tv';
    // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's item.Type uses its PascalCase vocabulary.
    if (type === 'TvChannel' || type === 'LiveTvChannel') return 'channel';
    // Default based on context
    if (item.SeriesName || item.SeriesId) return 'tv';
    return 'movie'; // Default to movie for unknown types
}

/**
 * Transform a Jellyfin item to BrowseItem format
 */
export function transformJellyfinItem(item: BrowseJellyfinItem): BrowseItem {
    // For episodes, use series image if available
    const imageId = item.ImageTags?.Primary
        ? item.Id
        : item.SeriesPrimaryImageTag
          ? item.SeriesId
          : undefined;

    const isEpisode = isEpisodeType(item.Type);
    const trailerUrl = item.RemoteTrailers?.find(
        (trailer): trailer is { Url: string } =>
            typeof trailer?.Url === 'string' && trailer.Url.length > 0,
    )?.Url;

    return {
        id: item.Id,
        name: isEpisode ? `${item.SeriesName} - ${item.Name}` : item.Name,
        type: getItemType(item),
        year:
            item.ProductionYear ||
            (item.PremiereDate ? Number.parseInt(item.PremiereDate.substring(0, 4)) : undefined),
        overview: item.Overview,
        communityRating: item.CommunityRating,
        genres: item.Genres,
        imageId: imageId,
        backdropId:
            item.BackdropImageTags && item.BackdropImageTags.length > 0
                ? item.Id
                : item.ParentBackdropItemId || item.SeriesId || undefined,
        tmdbId: item.ProviderIds?.Tmdb ? Number.parseInt(item.ProviderIds.Tmdb) : undefined,
        imdbId: item.ProviderIds?.Imdb,
        runTimeTicks: item.RunTimeTicks,
        trailerUrl: trailerUrl,
        userData: item.UserData
            ? {
                  playedPercentage: item.UserData.PlayedPercentage,
                  playCount: item.UserData.PlayCount,
                  isFavorite: item.UserData.IsFavorite,
              }
            : undefined,
        // Episode-specific fields
        isEpisode: isEpisode,
        seriesId: item.SeriesId,
        seriesName: item.SeriesName,
        seasonNumber: item.ParentIndexNumber,
        episodeNumber: item.IndexNumber,
        episodeName: isEpisode ? item.Name : undefined,
    };
}

/**
 * Transform a channel item to BrowseItem format
 */
export function transformChannelItem(item: BrowseJellyfinItem): BrowseItem {
    return {
        id: item.Id,
        name: item.Name,
        type: 'channel',
        overview: item.Overview,
        imageId: item.ImageTags?.Primary ? item.Id : undefined,
    };
}
