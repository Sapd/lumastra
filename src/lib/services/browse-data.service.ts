// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type {
    BrowseKeywordsResponse,
    KeywordSection as KeywordSectionDto,
} from '$lib/schemas/api-browse-responses';

/**
 * Browse Data Service
 *
 * Handles API calls and data transformation for the browse page.
 * Extracted from browse/+page.svelte for better separation of concerns.
 */

import * as browseApi from '$lib/api/browse';
import * as playbackApi from '$lib/api/playback';
import * as forYouApi from '$lib/api/for-you';
import type { WatchingResponse as SchemaWatchingResponse } from '$lib/schemas/api-for-you-responses';
import type { ExternalIds } from '$lib/types/api-common';
import type { ImageSet } from '$lib/schemas/api-image-descriptor';
import { getCatalogPosterUrl } from '$lib/utils/image-utils';

/** Browse media type filter */
export type BrowseMediaType = 'all' | 'movies' | 'series' | 'channels';

/** Browse item (from main browse API) */
export interface BrowseItem {
    id: string;
    name: string;
    type?: string;
    /** The item's own media type for browse content. */
    mediaType?: string;
    isEpisode?: boolean;
    seriesId?: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    externalIds?: ExternalIds;
    imageId?: string;
    trailerUrl?: string;
    userData?: {
        playedPercentage?: number;
    };
    /** Internal: direct image URL from UniversalMediaItem */
    _imageUrl?: string;
}

/** Channel browse item */
export interface ChannelBrowseItem {
    id: string;
    name: string;
    number?: string | number;
    images: ImageSet;
    currentProgram?: {
        name: string;
        startTime: string;
        endTime: string;
        progress?: number;
    };
    nextProgram?: {
        name: string;
        startTime: string;
    };
}

/** Keyword-based browse item (from TMDB) */
export interface KeywordBrowseItem {
    tmdbId: number;
    title: string;
    posterPath?: string;
    mediaType: 'movie' | 'series';
    overview?: string;
    releaseYear?: number;
    voteAverage?: number;
    trailerUrl?: string;
    externalIds?: ExternalIds;
    isAvailable?: boolean;
}

/** Genre row from browse API */
export interface BrowseGenreRow {
    genre: string;
    items: BrowseItem[];
}

/** Keyword section from browse API */
export type KeywordSection = KeywordSectionDto;

/** Response from /api/browse */
export interface BrowseApiResponse {
    recentlyAdded: BrowseItem[];
    genres: BrowseGenreRow[];
    channels?: ChannelBrowseItem[];
}

/**
 * Response from /api/for-you/watching.
 *
 * Re-exported from the schema rather than re-declared: `forYouApi.getWatching`
 * already validates against `WatchingResponseSchema`, whose sections are full
 * `PageSection`s. The hand-rolled `{ id, items }` interface this replaced was a
 * strict subset, so the `as` cast below silently dropped `type`/`title`/`source`
 * — and `/browse` assigns the result straight into a `PageSection[]`.
 */
export type WatchingResponse = SchemaWatchingResponse;

/** Response from /api/browse/keywords */
export type KeywordSectionsResponse = BrowseKeywordsResponse;

/** Configuration for browse data loading */
export interface BrowseDataConfig {
    keywordsInitial?: number;
    keywordsPageSize?: number;
}

const DEFAULT_CONFIG: Required<BrowseDataConfig> = {
    keywordsInitial: 5,
    keywordsPageSize: 3,
};

/**
 * Load main browse data (genres, recently added, channels)
 */
export async function loadBrowseData(
    activeTab: BrowseMediaType,
): Promise<BrowseApiResponse | null> {
    try {
        const { data, error } = await browseApi.getBrowse(activeTab);
        if (error || !data) return null;
        return data as unknown as BrowseApiResponse;
    } catch (e) {
        console.error('Browse load error:', e);
        return null;
    }
}

/**
 * Load continue watching and next up data
 */
export async function loadWatchingData(
    limit = 20,
    refresh = false,
): Promise<WatchingResponse | null> {
    try {
        const { data, error } = await forYouApi.getWatching(limit, refresh);
        if (error || !data) return null;
        return data;
    } catch (e) {
        console.error('Failed to load watching data:', e);
        return null;
    }
}

/**
 * Load channel programs for Live TV
 */
export async function loadChannelPrograms(): Promise<ChannelBrowseItem[]> {
    try {
        const { data, error } = await playbackApi.getLiveTvChannels();
        if (error || !data) return [];
        // The livetv API returns the standard { items, page } collection envelope.
        return Array.isArray(data.items) ? (data.items as ChannelBrowseItem[]) : [];
    } catch (e) {
        console.error('Failed to load channel programs:', e);
        return [];
    }
}

/**
 * Create fallback channel items from basic channel data
 */
export function createFallbackChannels(
    channels: {
        id: string;
        name?: string;
        number?: string | number;
        imageId?: string;
    }[],
): ChannelBrowseItem[] {
    return channels.map((ch) => ({
        id: ch.id,
        name: ch.name || 'Unknown Channel',
        number: ch.number,
        images: ch.imageId
            ? {
                  primary: {
                      href: getCatalogPosterUrl(ch.id, { size: 'thumb' }),
                      revision: ch.imageId,
                      source: 'self',
                  },
              }
            : {},
    }));
}

/**
 * Load initial keyword sections
 */
export async function loadKeywordSections(
    activeTab: BrowseMediaType,
    config: BrowseDataConfig = {},
): Promise<KeywordSectionsResponse | null> {
    if (activeTab === 'channels') return null;

    const { keywordsInitial } = { ...DEFAULT_CONFIG, ...config };

    try {
        const { data, error } = await browseApi.getBrowseKeywords({
            limit: keywordsInitial,
            offset: 0,
            type: activeTab,
        });
        if (error || !data) return null;
        return data;
    } catch (e) {
        console.error('Failed to load keyword sections:', e);
        return null;
    }
}

/**
 * Load more keyword sections (pagination)
 */
export async function loadMoreKeywords(
    activeTab: BrowseMediaType,
    offset: number,
    config: BrowseDataConfig = {},
): Promise<KeywordSectionsResponse | null> {
    if (activeTab === 'channels') return null;

    const { keywordsPageSize } = { ...DEFAULT_CONFIG, ...config };

    try {
        const { data, error } = await browseApi.getBrowseKeywords({
            limit: keywordsPageSize,
            offset,
            type: activeTab,
        });
        if (error || !data) return null;
        return data;
    } catch (e) {
        console.error('Failed to load more keyword sections:', e);
        return null;
    }
}

/**
 * Create a browse data loader with configuration
 */
export function createBrowseDataLoader(config: BrowseDataConfig = {}) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };

    return {
        loadBrowseData,
        loadWatchingData,
        loadChannelPrograms,
        loadKeywordSections: (activeTab: BrowseMediaType) =>
            loadKeywordSections(activeTab, mergedConfig),
        loadMoreKeywords: (activeTab: BrowseMediaType, offset: number) =>
            loadMoreKeywords(activeTab, offset, mergedConfig),
        createFallbackChannels,
    };
}
