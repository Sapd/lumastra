// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * For-You API domain module
 *
 * Typed functions for personalized content sections, continue watching,
 * mood recommendations, dismiss, similar items, and section loading.
 */

import { apiGet, apiPost, apiPatch, apiDelete } from './client.js';
import type { ApiRequestOptions, ApiResult } from './types.js';
import {
    WatchingResponseSchema,
    NewEpisodesResponseSchema,
    ClearContinueWatchingResponseSchema,
    FulfilledRequestsResponseSchema as LegacyFulfilledRequestsResponseSchema,
    FeaturedPickResponseSchema,
    MusicSectionResponseSchema,
    ExploreKeywordsResponseSchema,
    MoodSuggestionsResponseSchema,
    MoodRecommendationsResponseSchema,
    WatchingSourcesResponseSchema,
    SimilarResponseSchema,
    KeywordsResponseSchema,
    DismissRecommendationResponseSchema,
    LessLikeThisResponseSchema,
    ActiveDampersResponseSchema,
    ClearDampersResponseSchema,
    TasteRailResponseSchema,
    OkAckResponseSchema,
    SectionOrderResponseSchema,
} from '$lib/schemas/api-for-you-responses';
import type { ExternalIds } from '$lib/types/api-common';
import {
    DismissalMutationResponseSchema,
    type DismissalRequestBody,
} from '$lib/schemas/api-dismissals-responses.js';
import { z } from 'zod';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview';
import { paginatedEnvelope } from '$lib/schemas/pagination';
const SectionResponseSchema = paginatedEnvelope(MediaPreviewSchema);
const FulfilledRequestsResponseSchema = LegacyFulfilledRequestsResponseSchema.omit({
    items: true,
}).extend({ items: z.array(MediaPreviewSchema) });
import { AudiobookActivityFeedResponseSchema } from '$lib/schemas/api-feed-responses.js';

// =========================================================================
// Watching / Continue Watching
// =========================================================================

export function getAudiobookActivityFeed(options?: ApiRequestOptions) {
    return apiGet('/api/feed', AudiobookActivityFeedResponseSchema, {
        ...options,
        params: { sections: 'audiobook-activity', limit: 10 },
        strict: true,
    });
}

export function getWatching(limit: number, _refresh?: boolean) {
    return apiGet('/api/for-you/watching', WatchingResponseSchema, {
        params: { limit },
    });
}

/** "New episodes available" (computed fresh per request; nothing to refresh). */
export function getNewEpisodes(limit: number) {
    return apiGet('/api/for-you/new-episodes', NewEpisodesResponseSchema, {
        params: { limit },
    });
}

export function clearContinueWatching(type: 'movies' | 'episodes' | 'both') {
    return apiPost('/api/continue-watching/clear', ClearContinueWatchingResponseSchema, { type });
}

// =========================================================================
// Section Endpoints (Phase 1)
//
// The uniform curated rails are served by the unified recommendations
// multiplexer (`GET /api/recommendations/sections?type=<rail>`), backed by the
// shared strategy registry — the same fetch/filter/cache path as /feed.
// The formerly-distinct GET /api/for-you/<rail> routes are folded into this
// single endpoint; each returns the canonical { items, page } envelope of
// ForYouRecommendationItem ({ media, score?, reason? }) which is exactly what
// `SectionResponseSchema` already validates, so the consumer mapping in
// foryou-loader.ts (recommendationItemToUniversal) is unchanged.
// =========================================================================

export function getTrending(limit: number, options?: ApiRequestOptions) {
    return apiGet(`/api/recommendations/sections`, SectionResponseSchema, {
        ...options,
        params: { type: 'trending', limit },
    });
}

export function getPopularShows(limit: number, options?: ApiRequestOptions) {
    return apiGet(`/api/recommendations/sections`, SectionResponseSchema, {
        ...options,
        params: { type: 'popular-shows', limit },
    });
}

export function getFulfilledRequests(options?: ApiRequestOptions) {
    return apiGet('/api/recommendations/sections', FulfilledRequestsResponseSchema, {
        ...options,
        params: { type: 'fulfilled-requests' },
    });
}

export function getShortMovies(limit: number, options?: ApiRequestOptions) {
    return apiGet(`/api/recommendations/sections`, SectionResponseSchema, {
        ...options,
        params: { type: 'short-movies', limit },
    });
}

export function getAnime(limit: number, options?: ApiRequestOptions) {
    return apiGet(`/api/recommendations/sections`, SectionResponseSchema, {
        ...options,
        params: { type: 'anime', limit },
    });
}

export function getFreshReleases(limit: number, options?: ApiRequestOptions) {
    return apiGet(`/api/recommendations/sections`, SectionResponseSchema, {
        ...options,
        params: { type: 'fresh-releases', limit },
    });
}

export function getBingeWorthy(limit: number, options?: ApiRequestOptions) {
    return apiGet(`/api/recommendations/sections`, SectionResponseSchema, {
        ...options,
        params: { type: 'binge-worthy', limit },
    });
}

export function getMusicBecause(options?: ApiRequestOptions) {
    return apiGet(`/api/for-you/music-because`, MusicSectionResponseSchema, options);
}

export function getMusicQuickPicks(options?: ApiRequestOptions) {
    return apiGet(`/api/for-you/music-quick-picks`, MusicSectionResponseSchema, options);
}

export function getRecentlyAdded(limit: number, options?: ApiRequestOptions) {
    return apiGet(`/api/recommendations/sections`, SectionResponseSchema, {
        ...options,
        params: { type: 'recently-added', limit },
    });
}

export function getRandomPicks(limit: number, options?: ApiRequestOptions) {
    return apiGet(`/api/recommendations/sections`, SectionResponseSchema, {
        ...options,
        params: { type: 'random-picks', limit },
    });
}

export function getFeaturedPick(options?: ApiRequestOptions) {
    // P3: shown-pick exclusion is server-side via `featured_pick_shown`
    // flags. The pre-P3 `excludeKeys` query param has been retired.
    return apiGet('/api/for-you/featured-pick', FeaturedPickResponseSchema, options);
}

export function getExploreKeywords(options?: ApiRequestOptions) {
    return apiGet('/api/for-you/explore-keywords', ExploreKeywordsResponseSchema, options);
}

/**
 * GET /api/for-you/section-order — ranked per-user long-tail section order
 * (M3 section ranker, flag-gated). Returns the canonical order unchanged
 * when `FEATURE_FORYOU_SECTION_RANKER` is off.
 */
export function getSectionOrder(options?: ApiRequestOptions) {
    return apiGet('/api/for-you/section-order', SectionOrderResponseSchema, options);
}

// =========================================================================
// Taste Rail ("From your ratings") — strategy-backed, cursor-paged
// =========================================================================

/**
 * GET /api/for-you/taste — the strategy-backed "From your ratings" rail.
 * Cursor-only (no offset); `refresh` forces regeneration on the first page
 * only (cursor pages never regenerate — see `AiStrategy`/`getTasteRailPage`).
 */
export function getTasteRail(
    params?: { cursor?: string; refresh?: boolean },
    options?: ApiRequestOptions,
): Promise<ApiResult<z.infer<typeof TasteRailResponseSchema>>> {
    const firstPage = !params?.cursor;
    if (firstPage && params?.refresh) tasteFirstPage = null;
    // The home page asks for the first page twice on one load (hero AI slides
    // and the "From your ratings" rail). Browser-only: module state on the
    // server would be shared across users.
    const reusable = firstPage && !params?.refresh && typeof window !== 'undefined';
    if (reusable && tasteFirstPage && Date.now() - tasteFirstPage.at < TASTE_FIRST_PAGE_REUSE_MS) {
        return tasteFirstPage.promise.then((r) => structuredClone(r));
    }
    const request =
        firstPage && params?.refresh
            ? apiPost('/api/for-you/taste/refresh', TasteRailResponseSchema, {}, options)
            : apiGet('/api/for-you/taste', TasteRailResponseSchema, {
                  // A shared request must not die with one caller's signal.
                  ...(reusable ? { ...options, signal: undefined } : options),
                  params: { cursor: params?.cursor },
              });
    if (!reusable) return request;
    const entry = { at: Date.now(), promise: request };
    tasteFirstPage = entry;
    void request.then((r) => {
        if (r.error !== null && tasteFirstPage === entry) tasteFirstPage = null;
    });
    return request.then((r) => structuredClone(r));
}

/** How long the first taste-rail page is shared between callers. */
const TASTE_FIRST_PAGE_REUSE_MS = 10_000;
let tasteFirstPage: {
    at: number;
    promise: Promise<ApiResult<z.infer<typeof TasteRailResponseSchema>>>;
} | null = null;

/**
 * Toggle whether the taste profile folds watch-history signals into its
 * positive centroid (rail overflow menu). Persists server-side
 * and synchronously rebuilds the profile — the next `getTasteRail()` call
 * reflects the change.
 */
export function patchTasteIncludeWatchHistory(includeWatchHistory: boolean) {
    tasteFirstPage = null;
    return apiPatch('/api/for-you/taste', OkAckResponseSchema, { includeWatchHistory });
}

// =========================================================================
// Mood Recommendations
// =========================================================================

export function getMoodSuggestions() {
    return apiGet('/api/mood-recommendations/suggestions', MoodSuggestionsResponseSchema);
}

export function getMoodRecommendations(options?: {
    limit?: number;
    mood?: string;
    mode?: string;
    refresh?: boolean;
    /** Optional cancellation signal (loader aborts on route change / refresh). */
    signal?: AbortSignal;
}) {
    const params: Record<string, string | number | boolean | undefined> = {};
    if (options?.limit) params.limit = options.limit;
    if (options?.mood) params.mood = options.mood;
    if (options?.mode) params.mode = options.mode;
    if (options?.refresh)
        return apiPost(
            '/api/mood-recommendations/refresh',
            MoodRecommendationsResponseSchema,
            params,
            { signal: options.signal },
        );
    return apiGet('/api/mood-recommendations', MoodRecommendationsResponseSchema, {
        params,
        signal: options?.signal,
    });
}

// =========================================================================
// Phase 2: Sources & Similar
// =========================================================================

export function getWatchingSources(limit: number, options?: ApiRequestOptions) {
    return apiGet(`/api/for-you/watching/sources`, WatchingSourcesResponseSchema, {
        ...options,
        params: { limit },
    });
}

export function getSimilar(options: {
    key: string;
    title?: string;
    limit?: number;
    steering?: boolean;
    /** Optional cancellation signal (loader aborts on route change / refresh). */
    signal?: AbortSignal;
}) {
    return apiGet('/api/for-you/similar', SimilarResponseSchema, {
        params: {
            key: options.key,
            title: options.title,
            limit: options.limit,
            steering: options.steering,
        },
        signal: options.signal,
    });
}

export function getKeywords(options: { rows: number; limit: number; signal?: AbortSignal }) {
    return apiGet('/api/for-you/keywords', KeywordsResponseSchema, {
        params: {
            rows: options.rows,
            limit: options.limit,
        },
        signal: options.signal,
    });
}

// =========================================================================
// Dismiss
// =========================================================================

/**
 * "Show less like this" — record a soft, decaying, non-judgmental damper that
 * nudges For-You away from content similar to this title. NOT a rating.
 */
export function lessLikeThis(body: {
    externalIds: ExternalIds;
    /** Canonical discriminator: 'movie' or 'series'. Never 'tv'. */
    mediaType: 'movie' | 'series';
    title?: string;
}) {
    return apiPost('/api/for-you/less-like-this', LessLikeThisResponseSchema, body);
}

/** List the user's active "show less like this" dampers (settings UI). */
export function getActiveDampers() {
    return apiGet('/api/for-you/dampers', ActiveDampersResponseSchema);
}

/** Remove one damper ("show this again"). */
export function clearDamper(mediaId: string) {
    return apiDelete('/api/for-you/dampers', ClearDampersResponseSchema, { mediaId });
}

/** Clear all dampers ("reset recommendation tuning"). */
export function clearAllDampers() {
    return apiDelete('/api/for-you/dampers', ClearDampersResponseSchema, { all: true });
}

export function dismissRecommendation(body: { sourceMediaKey: string; dismissedMediaKey: string }) {
    return apiPost('/api/recommendations/dismiss', DismissRecommendationResponseSchema, body);
}

// =========================================================================
// For-You Dismiss (request_dismissed / new_episode_alert_dismissed flags)
// =========================================================================

/** POST /api/for-you/dismiss — set a for-you dismissal flag. */
export function dismissForYouItem(body: {
    targetId: string;
    targetType: 'series' | 'movie';
    flagType: 'request_dismissed' | 'new_episode_alert_dismissed';
}) {
    return apiPost('/api/for-you/dismiss', FeedbackOkResponseSchema, body);
}

// =========================================================================
// For-You Feedback (section-level interaction beacons)
// =========================================================================

const FeedbackOkResponseSchema = z.object({ ok: z.literal(true) });

/** POST /api/for-you/feedback — fire-and-forget section interaction beacon. */
export function feedbackForYouSection(body: {
    sectionType: string;
    event: 'impression' | 'play' | 'abandon' | 'dismiss';
}) {
    return apiPost('/api/for-you/feedback', FeedbackOkResponseSchema, body);
}

// =========================================================================
// Continue-Watching Dismissals (dismissed_cw flag)
// =========================================================================

/** POST /api/continue-watching/dismissals — hide an item from the CW row. */
export function postCwDismissal(body: DismissalRequestBody) {
    return apiPost('/api/continue-watching/dismissals', DismissalMutationResponseSchema, body);
}

/** DELETE /api/continue-watching/dismissals — restore a hidden CW item. */
export function deleteCwDismissal(body: DismissalRequestBody) {
    return apiDelete('/api/continue-watching/dismissals', DismissalMutationResponseSchema, body);
}
