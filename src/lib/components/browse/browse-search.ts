// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse Search Utilities
 *
 * Handles debounced search logic and result transformation for the browse page.
 * Extracted from browse/+page.svelte for better separation of concerns.
 */

import { pickVariant } from '$lib/utils/image-utils.js';
import * as contentApi from '$lib/api/content';
import { isEpisode } from '$lib/shared/media-types';
import type { ExternalIds } from '$lib/types/api-common';
import type { SearchResultItem as V1SearchResultItem } from '$lib/api/content';

/** Browse media type filter */
export type BrowseMediaType = 'all' | 'movies' | 'series' | 'channels';

/**
 * @deprecated The legacy /api/search response shape (`mediaItems`, flat
 * `imageUrl`, `mediaType`, `episodeSearchInfo`) no longer exists. The v1
 * contract returns `{ items, page }` with V1SearchResultItem entries. This type
 * is retained only so existing imports keep compiling; new code should consume
 * V1SearchResultItem directly.
 */
export interface BrowseSearchApiItem {
    id: string;
    title: string;
    mediaType: 'movie' | 'tv' | 'episode';
    year?: number;
    overview?: string;
    rating?: number;
    imageUrl?: string;
    externalIds?: ExternalIds;
    seriesId?: string;
    seriesExternalIds?: ExternalIds;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
}

/** Browse item (for compatibility with existing transformers) */
export interface BrowseItem {
    id: string;
    name: string;
    type?: string;
    year?: number;
    overview?: string;
    communityRating?: number;
    imageId?: string;
    externalIds?: ExternalIds;
    isEpisode?: boolean;
    seriesId?: string;
    seriesExternalIds?: ExternalIds;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    /** Internal: direct image URL from API */
    _imageUrl?: string;
}

/** Search result containing the transformed browse items */
export interface SearchResult {
    items: BrowseItem[];
}

/**
 * Map browse tab to API types parameter
 */
export function getSearchTypesParam(activeTab: BrowseMediaType): string {
    switch (activeTab) {
        case 'movies':
            return 'movie';
        case 'series':
            return 'tv';
        default:
            return 'movie,tv,episode';
    }
}

/**
 * Transform a v1 search result item ({ items, page } contract) to browse format.
 * The v1 item uses `type` ('series' for TV), `ids{}`, and self-describing
 * `images{}` hrefs — there is no flat `imageUrl`/`mediaType`. The browse card
 * resolves its poster from `imageId`/`id` via imageFromIds, so the v1 poster
 * href is carried in `_imageUrl` only as a hint.
 */
export function transformSearchItem(item: V1SearchResultItem): BrowseItem {
    const isEp = isEpisode(item.type);
    return {
        id: item.id,
        name: item.title,
        // Carried VERBATIM. This was `isMovie(item.type) ? 'movie' : isEp ?
        // 'episode' : 'series'`, which relabelled every one of the other twelve
        // members of `V1SearchResultItemSchema.type`
        // (src/lib/schemas/api-content-responses.ts:53-80 — audiobook, track,
        // album, artist, book, manga, comic, request, tvchannel, home_video,
        // training, educational, personal) as a TV series. The single narrowing
        // now happens once, in transformJellyfinItem, which drops what the
        // client has no card for instead of guessing.
        type: item.type,
        year: item.year,
        overview: item.overview,
        imageId: item.id,
        _imageUrl: pickVariant(item.images.poster, 'thumb'),
        externalIds: { ...item.ids, internal: item.catalogId ?? undefined },
        isEpisode: isEp,
        seriesId: item.context?.series?.id,
        seriesName: item.context?.series?.title,
        seasonNumber: item.context?.seasonNumber,
        episodeNumber: item.context?.episodeNumber,
    };
}

/**
 * Perform a search against the API (v1 { items, page } contract).
 */
export async function performSearch(
    query: string,
    activeTab: BrowseMediaType,
    limit = 50,
): Promise<SearchResult> {
    if (query.length < 2) {
        return { items: [] };
    }

    try {
        const typesParam = getSearchTypesParam(activeTab);
        const { data, error } = await contentApi.search(query, {
            types: typesParam,
            limit,
        });

        if (error || !data) {
            return { items: [] };
        }

        const apiResults = Array.isArray(data.items) ? data.items : [];

        return {
            items: apiResults.map(transformSearchItem),
        };
    } catch (e) {
        console.error('Search error:', e);
        return { items: [] };
    }
}

/**
 * Create a debounced search controller
 */
export function createDebouncedSearch(
    debounceMs: number,
    onSearchStart?: () => void,
    onSearchComplete?: (result: SearchResult) => void,
) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let currentQuery = '';

    /**
     * Trigger a debounced search
     */
    function trigger(query: string, activeTab: BrowseMediaType): void {
        currentQuery = query;

        if (timer) {
            clearTimeout(timer);
        }

        if (query.length < 2) {
            onSearchComplete?.({ items: [] });
            return;
        }

        timer = setTimeout(() => {
            onSearchStart?.();
            void performSearch(query, activeTab).then((result) => {
                // Only update if query hasn't changed during search
                if (query === currentQuery) {
                    onSearchComplete?.(result);
                }
            });
        }, debounceMs);
    }

    /**
     * Clear pending search and results
     */
    function clear(): void {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        currentQuery = '';
        onSearchComplete?.({ items: [] });
    }

    /**
     * Cancel pending search without clearing results
     */
    function cancel(): void {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    return {
        trigger,
        clear,
        cancel,
    };
}

/**
 * Filter channels locally (fast, no server needed)
 */
export function filterChannels<T extends { name?: string; currentProgram?: { name?: string } }>(
    channels: T[],
    query: string,
): T[] {
    const normalizedQuery = query.toLowerCase().trim();

    if (!normalizedQuery) {
        return channels;
    }

    return channels.filter(
        (ch) =>
            (ch.name || '').toLowerCase().includes(normalizedQuery) ||
            (ch.currentProgram?.name || '').toLowerCase().includes(normalizedQuery),
    );
}

/**
 * Normalize query for matching
 */
export function normalizeQuery(query: string): string {
    return query.toLowerCase().trim();
}

/**
 * Check if query is valid for search (minimum length)
 */
export function isValidSearchQuery(query: string, minLength = 2): boolean {
    return normalizeQuery(query).length >= minLength;
}
