// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Content API domain module
 *
 * Typed functions for search, movie/series details, genres, ratings,
 * similar items, calendar, requests, lists, and upcoming content.
 *
 * All responses are validated with Zod schemas for runtime type safety.
 */

import { paginatedEnvelope, boundedListEnvelope } from '$lib/schemas/pagination.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import {
    UpcomingResponseSchema,
    UpcomingCalendarItemSchema,
    TrendingResponseSchema,
} from '$lib/schemas/api-recommender-responses.js';
import { RequestSeasonsResponseSchema } from '$lib/schemas/request-seasons.js';
import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import type { ApiRequestOptions } from './types.js';
import {
    SearchResponseSchema as LegacySearchResponseSchema,
    V1SearchResultItemSchema,
    AvailableCategoriesResponseSchema,
    MovieDetailsResponseSchema,
    MovieSearchResponseSchema,
    SeriesSearchResponseSchema,
    EpisodeResponseSchema,
    ExcludedSeriesResponseSchema,
    ExcludeSeriesMutationResponseSchema,
    WatchedItemsResponseSchema,
    SubmitRequestResponseSchema,
    RequestQuotaResponseSchema,
    PendingRequestsResponseSchema,
    RequestStatusResponseSchema,
    ListsResponseSchema,
    ClearTrendingCacheResponseSchema,
    MediaDetailSchema,
    MediaNodeSchema,
    SeriesOrderingResponseSchema,
    SeriesOrderingSetResponseSchema,
    SeriesOrderingResetResponseSchema,
    SeriesOrderingApplyResponseSchema,
    SeriesOrderingSyncResponseSchema,
    PersonSearchResponseSchema,
    SharingPolicySchema,
} from '$lib/schemas/api-content-responses.js';
import {
    EpisodesCollectionResponseSchema,
    NextEpisodeNodeSchema,
    SeasonsCollectionResponseSchema,
    SeriesNodeSchema,
} from '$lib/schemas/api-series-responses.js';
import { MediaContextResponseSchema } from '$lib/schemas/api-media-context-response.js';
import {
    annotationsListResponseSchema,
    annotationCreatedResponseSchema,
} from '$lib/schemas/media-annotations.js';
import { NoContentSchema, type ExternalIds } from '$lib/schemas/common.js';
import type { DismissRequestBody } from '$lib/schemas/request.js';

import { z } from 'zod';

const CalendarResponseSchema = paginatedEnvelope(UpcomingCalendarItemSchema);
const SimilarMediaResponseSchema = boundedListEnvelope(MediaPreviewSchema);
const ListItemsResponseSchema = boundedListEnvelope(MediaPreviewSchema);

const SearchItemSchema = V1SearchResultItemSchema.extend({
    catalogId: MediaPreviewSchema.shape.catalogId,
    images: MediaPreviewSchema.shape.images,
    availability: MediaPreviewSchema.shape.availability,
    progress: MediaPreviewSchema.shape.progress,
    context: MediaPreviewSchema.shape.context,
});
export const SearchResponseSchema = LegacySearchResponseSchema.extend({
    items: z.array(SearchItemSchema),
});
export type SearchResultItem = z.infer<typeof SearchItemSchema>;

// =========================================================================
// Search
// =========================================================================

export function search(
    query: string,
    options?: {
        types?: string;
        limit?: number;
        offset?: number;
        signal?: AbortSignal;
    },
) {
    return apiGet('/api/search', SearchResponseSchema, {
        params: {
            q: query,
            types: options?.types,
            limit: options?.limit,
            offset: options?.offset,
        },
        signal: options?.signal,
    });
}

export function getAvailableCategories() {
    return apiGet('/api/search/available-categories', AvailableCategoriesResponseSchema);
}

// =========================================================================
// Media Details (provider-agnostic)
// =========================================================================

export function getMediaDetails(mediaKey: string, options?: ApiRequestOptions) {
    return apiGet(`/api/media/${mediaKey}`, MediaNodeSchema, options);
}

export function getListeningSharing(mediaId: string) {
    return apiGet(
        `/api/media/${encodeURIComponent(mediaId)}/listening-sharing`,
        SharingPolicySchema,
    );
}

export function updateListeningSharing(mediaId: string, shared: boolean) {
    return apiPut(
        `/api/media/${encodeURIComponent(mediaId)}/listening-sharing`,
        SharingPolicySchema,
        { shared },
    );
}

export function getMediaDetailsByQuery(key: string, options?: ApiRequestOptions) {
    return apiGet('/api/media-details', MediaDetailSchema, {
        ...options,
        params: { key },
    });
}

export function getSimilarMedia(mediaKey: string, limit?: number) {
    return apiGet(`/api/media/${mediaKey}/similar`, SimilarMediaResponseSchema, {
        params: { limit },
    });
}

export function getMediaSeasons(mediaKey: string) {
    // Uses the series seasons endpoint which supports composite keys via withIdResolution middleware
    return apiGet(`/api/series/${mediaKey}/seasons`, SeasonsCollectionResponseSchema);
}

// =========================================================================
// Movie Details
// =========================================================================

export function getMovieDetails(itemId: string) {
    return apiGet(`/api/movie-details/${itemId}`, MovieDetailsResponseSchema);
}

export function searchMovies(name: string, year?: number | string) {
    return apiGet('/api/movie/search', MovieSearchResponseSchema, {
        params: { name, year },
    });
}

// =========================================================================
// Series Details
// =========================================================================

export function getSeriesDetails(seriesId: string, options?: ApiRequestOptions) {
    return apiGet(`/api/series/${seriesId}`, SeriesNodeSchema, options);
}

export function searchSeries(name: string) {
    return apiGet('/api/series/search', SeriesSearchResponseSchema, {
        params: { name },
    });
}

export function getSeriesSeasons(seriesId: string) {
    return apiGet(`/api/series/${seriesId}/seasons`, SeasonsCollectionResponseSchema);
}

/** Fetch the complete season, following the server's episode link when supplied. */
export async function getSeriesEpisodes(
    seriesId: string,
    season: number,
    options?: { limit?: number; href?: string },
) {
    const endpoint = options?.href ?? `/api/series/${encodeURIComponent(seriesId)}/episodes`;
    const limit = Math.min(100, Math.max(1, options?.limit ?? 100));
    const load = (offset: number) =>
        apiGet(endpoint, EpisodesCollectionResponseSchema, {
            params: { ...(options?.href ? {} : { season }), limit, offset },
        });
    const first = await load(0);
    if (first.error || !first.data) return first;
    const items = [...first.data.items];
    let page = first.data.page;
    while (page.hasMore) {
        const next = await load((page.offset ?? 0) + page.limit);
        if (next.error || !next.data) return next;
        if (next.data.items.length === 0) {
            return { ...next, data: null, error: 'Episode pagination did not advance' };
        }
        items.push(...next.data.items);
        page = next.data.page;
    }
    return { ...first, data: { ...first.data, items, page: { ...page, offset: 0 } } };
}

export function getNextEpisode(seriesId: string, season?: number, episode?: number) {
    // The endpoint returns a NextEpisodeNode. The legacy NextEpisodeResponse
    // shape (`name`, `source`) no longer matches it and only produced
    // schema-mismatch reports.
    return apiGet(`/api/series/${seriesId}/next-episode`, NextEpisodeNodeSchema, {
        params: { season, episode },
    });
}

/** Resolve autoplay after an entire default file, independent of watch history. */
export function getNextEpisodeAfterPlayback(seriesId: string, episodeId: string) {
    return apiGet(`/api/series/${seriesId}/next-episode`, NextEpisodeNodeSchema, {
        params: { afterPlayback: episodeId, inherit: 'none' },
    });
}

// =========================================================================
// Episodes
// =========================================================================

export function getEpisode(
    series: string,
    season: number | string,
    episode: number | string,
    options?: {
        seriesTmdbId?: string;
        seriesTvdbId?: string;
        seriesImdbId?: string;
    },
) {
    return apiGet('/api/episode', EpisodeResponseSchema, {
        params: {
            series,
            season,
            episode,
            ...(options?.seriesTmdbId && {
                seriesTmdbId: options.seriesTmdbId,
            }),
            ...(options?.seriesTvdbId && {
                seriesTvdbId: options.seriesTvdbId,
            }),
            ...(options?.seriesImdbId && { seriesImdbId: options.seriesImdbId }),
        },
    });
}

// =========================================================================
// Calendar
// =========================================================================

export function getCalendar(start: string, end: string) {
    // The calendar is a bounded month window — request the whole range in one
    // page (endpoint default is only 20, which truncated the month to its first
    // few days and dropped every later day's events).
    return apiGet('/api/calendar', CalendarResponseSchema, {
        params: { start, end, limit: 500 },
    });
}

// =========================================================================
// Upcoming
// =========================================================================

export function getUpcoming(limit?: number, refresh?: boolean) {
    if (refresh) return apiPost('/api/upcoming/refresh', UpcomingResponseSchema, { limit });
    return apiGet('/api/upcoming', UpcomingResponseSchema, {
        params: { limit },
    });
}

export function getExcludedSeries() {
    return apiGet('/api/upcoming/exclude', ExcludedSeriesResponseSchema);
}

/**
 * Mute a series or movie on the upcoming + calendar surfaces.
 *
 * The server keys the mute by id: `mediaId` (catalog series or movie) when
 * given, else `tmdbId` (scoped by `mediaType`, default series) for a title that
 * is not in the catalog. One of the two is required; `seriesName` is only the
 * display label.
 */
export function excludeSeries(
    body: {
        seriesName: string;
        mediaType?: 'series' | 'movie';
    } & (
        | { mediaId: string; tmdbId?: number | string }
        | { mediaId?: undefined; tmdbId: number | string }
    ),
) {
    return apiPost('/api/upcoming/exclude', ExcludeSeriesMutationResponseSchema, body);
}

/** Unmute by the `id` of the row returned from {@link getExcludedSeries}. */
export function unexcludeSeries(id: string) {
    return apiDelete('/api/upcoming/exclude', ExcludeSeriesMutationResponseSchema, { id });
}

// =========================================================================
// Watched Status
// =========================================================================

export function getWatchedItems(options?: ApiRequestOptions) {
    return apiGet('/api/watched', WatchedItemsResponseSchema, options);
}

// =========================================================================
// Requests (Jellyseerr)
// =========================================================================

export function submitRequest(body: {
    externalIds: ExternalIds;
    mediaType: string;
    seasons?: number[];
}) {
    return apiPost('/api/request', SubmitRequestResponseSchema, {
        ...body,
        mediaType: body.mediaType === 'tv' ? 'series' : body.mediaType,
    });
}

export function getRequestQuota() {
    return apiGet('/api/request/quota', RequestQuotaResponseSchema);
}

export function getPendingRequests() {
    return apiGet('/api/request/pending', PendingRequestsResponseSchema);
}

export function checkRequestStatuses(
    requests: {
        externalIds: ExternalIds;
        mediaType: string;
        seasons?: number[];
    }[],
) {
    return apiPost('/api/request/status', RequestStatusResponseSchema, {
        requests: requests.map((item) => ({
            ...item,
            mediaType: item.mediaType === 'tv' ? 'series' : item.mediaType,
        })),
    });
}

export function dismissRequest(body: DismissRequestBody) {
    return apiPost('/api/request/dismissals', z.null(), body);
}

// =========================================================================
// Lists (Curated)
// =========================================================================

export function getLists() {
    return apiGet('/api/lists', ListsResponseSchema);
}

export function getListItems(listId: string, limit?: number) {
    return apiGet(`/api/lists/${listId}`, ListItemsResponseSchema, {
        params: { limit },
    });
}

// =========================================================================
// Trending
// =========================================================================

export function getTrending(type: string, source: string, limit: number) {
    return apiGet('/api/trending', TrendingResponseSchema, {
        params: { type, source, limit },
    });
}

export function clearTrendingCache() {
    return apiPost('/api/trending/clear-cache', ClearTrendingCacheResponseSchema);
}

// =========================================================================
// Composite Media Context
// =========================================================================

export type MediaContextSection =
    'details' | 'similar' | 'social' | 'rating' | 'nextEpisode' | 'watched';

/**
 * Fetch multiple media data sections in a single request.
 * Reduces waterfall requests when opening the media detail modal.
 *
 * @param mediaKey - Media identifier (UUID or composite key)
 * @param sections - Which sections to include (defaults to all if omitted)
 */
export function getMediaContext(mediaKey: string, sections?: MediaContextSection[]) {
    return apiGet(`/api/media/${mediaKey}/context`, MediaContextResponseSchema, {
        params: {
            include: sections?.join(','),
        },
    });
}

// =========================================================================
// Media Annotations
// =========================================================================

export function getAnnotations(mediaId: string) {
    return apiGet(`/api/media/${mediaId}/annotations`, annotationsListResponseSchema);
}

export function createAnnotation(
    mediaId: string,
    body: {
        type: 'chat' | 'pin' | 'review';
        content: string;
        timestamp_seconds?: number;
    },
) {
    return apiPost(`/api/media/${mediaId}/annotations`, annotationCreatedResponseSchema, body);
}

export function deleteAnnotation(mediaId: string, annotationId: string) {
    return apiDelete(`/api/media/${mediaId}/annotations/${annotationId}`, NoContentSchema);
}

// =========================================================================
// Series Episode Ordering
// =========================================================================

export function getSeriesOrdering(seriesId: string) {
    return apiGet(`/api/series/${seriesId}/ordering`, SeriesOrderingResponseSchema);
}

export function setSeriesOrdering(
    seriesId: string,
    body: {
        orderingType: string;
        provider?: string;
        groupId?: string;
    },
) {
    return apiPut(`/api/series/${seriesId}/ordering`, SeriesOrderingSetResponseSchema, body);
}

export function resetSeriesOrdering(seriesId: string) {
    return apiDelete(`/api/series/${seriesId}/ordering`, SeriesOrderingResetResponseSchema);
}

export function applySeriesOrdering(seriesId: string, body: { provider: string; groupId: string }) {
    return apiPost(
        `/api/series/${seriesId}/ordering/apply`,
        SeriesOrderingApplyResponseSchema,
        body,
    );
}

export function syncSeriesOrderings(
    seriesId: string,
    body?: { orderingType?: string; provider?: string; groupId?: string },
) {
    return apiPost(
        `/api/series/${seriesId}/ordering/sync`,
        SeriesOrderingSyncResponseSchema,
        body ?? {},
    );
}

// =========================================================================
// Person Search
// =========================================================================

/** Search for a person (actor/director) by name via TMDB. */
export function searchPerson(name: string) {
    return apiGet('/api/person/search', PersonSearchResponseSchema, {
        params: { name },
    });
}

export function getRequestSeasons(externalIds: ExternalIds) {
    return apiPost('/api/request/seasons', RequestSeasonsResponseSchema, {
        externalIds,
        mediaType: 'series',
    });
}
