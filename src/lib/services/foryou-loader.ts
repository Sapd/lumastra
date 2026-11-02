// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ForYou Data Loader Service
 * Handles complex parallel data fetching for the For You page
 * Supports progressive loading - sections appear as they arrive
 */

import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
import type { UniversalMediaType } from '$lib/schemas/api-responses';
import type { WatchedItemResponse } from '$lib/types/watched.types';
import type { ExternalIds } from '$lib/types/api-common';
import { buildMediaKey } from '$lib/utils/media-id-helpers';
import { getPreferredExternalId } from '$lib/utils/external-ids';
import { getCatalogBackdropUrl } from '$lib/utils/image-utils';
import { FALLBACK_IMAGE } from '$lib/constants/images';
import * as contentApi from '$lib/api/content';
import * as forYouApi from '$lib/api/for-you';
import * as aiApi from '$lib/api/ai';
import type {
    WatchingSource,
    ForYouKeywordSection,
    FeaturedPickResponse,
} from '$lib/schemas/api-for-you-responses';
import type { ForYouRecommendationItem as InternalTasteItem } from '$lib/schemas/api-for-you-responses';
import type { MediaPreview as ForYouRecommendationItem } from '$lib/schemas/api-media-preview';
import { mediaPreviewToUniversal } from '$lib/utils/media-preview';
import type { ApiResult } from '$lib/api/types';
import * as m from '$lib/paraglide/messages';
import { escapeHtml } from '$lib/utils/escape-html';
import { isSectionVisible, type FeedPrefs } from '$lib/shared/feed-section-kinds';

export interface ForYouConfig {
    defaultLimit: number;
    sourcesLimit: number;
    similarPerSource: number;
    keywordRows: number;
    keywordItems: number;
    moodLimit: number;
    secondBecauseLimit: number;
}

export interface LoadResult {
    forYouSections: PageSection[];
    /**
     * Explicit page state for the `taste` rail (see `RecommenderResult.status`
     * on recommender.ts) — `undefined` until the taste fetch resolves (or when
     * the `taste` kind is hidden / AI is disabled, in which case it never
     * fires). The rail's own `PageSection` (when non-empty) is pushed into
     * `forYouSections` with id `'taste'`, same as every other for-you rail.
     */
    tasteStatus?: 'ready' | 'generating' | 'exhausted';
    /**
     * Lifetime rating count (`getUserStats().stats.totalRatings`), fetched once
     * alongside the taste-rail request — see `taste_trainer_title` in
     * TasteTrainerCard.svelte. `undefined` when the fetch never fired (AI
     * disabled / `taste` kind hidden) or errored.
     */
    totalRatings?: number;
    /**
     * Current "include my watch history" toggle, carried on
     * the same taste-rail GET response — see `TasteRailResponseSchema`.
     * `undefined` when the taste fetch never fired or errored; the rail
     * overflow menu defaults to `true` (the server-side default) in that
     * case.
     */
    includeWatchHistory?: boolean;
    moodSections: PageSection[];
    exploreKeywordsSection: PageSection | null;
    secondBecauseSection: PageSection | null;
    featuredPickSection: PageSection | null;
    timings: Record<string, number>;
}

/**
 * Progressive update callback - called as sections become available
 */
export interface ProgressiveUpdate {
    type:
        | 'forYou'
        | 'mood'
        | 'exploreKeywords'
        | 'secondBecause'
        | 'featuredPick'
        | 'taste'
        | 'userStats';
    sections?: PageSection[];
    section?: PageSection | null;
    /** Only set on `type: 'taste'` — see `LoadResult.tasteStatus`. */
    status?: 'ready' | 'generating' | 'exhausted';
    /** Only set on `type: 'userStats'` — see `LoadResult.totalRatings`. */
    totalRatings?: number;
    /** Only set on `type: 'taste'` — see `LoadResult.includeWatchHistory`. */
    includeWatchHistory?: boolean;
}

export type OnProgressCallback = (update: ProgressiveUpdate) => void;

type WatchedItemsData = {
    watchedItems?: WatchedItemResponse[];
};

type SectionsData = {
    sections?: PageSection[];
};

/**
 * Every public server discriminator → the legacy internal `UniversalMediaType`
 * the SDUI renderer switches on.
 *
 * Typed as a TOTAL `Record<PublicMediaType, …>` rather than a cast, so adding a
 * member to `publicMediaTypeSchema` is a compile error here instead of a card
 * that silently renders (and routes) as the wrong kind. The two vocabularies are
 * NOT the same set:
 *  - `'series'` → `'tv'`: the load-bearing rename. Internally this codebase
 *    stores/renders TV as `'tv'`; `'series'` exists only at the public boundary.
 *  - `'season'` → `'tv'`: `UniversalMediaType` has no `'season'` member, and a
 *    season IS a TV entity (`toTmdbType` folds it the same way), so the TV card
 *    /detail path is the closest correct rendering rather than an invented one.
 *    No rail emits season rows today.
 *
 * There is deliberately NO `'show'` entry: `'show'` is accepted only as legacy
 * INPUT by `publicMediaTypeSchema`'s preprocess, which coerces it to `'series'`,
 * so it can never arrive here. The old `media.type === 'show'` comparison this
 * replaced was already dead code once the field became a real enum.
 */
export const recommendationItemToUniversal = mediaPreviewToUniversal;

/**
 * Localize a taste-rail item's typed `reason` (see `RecommendationReasonSchema`
 * on api-for-you-responses.ts) to the string the card/modal hover popup
 * renders (`UniversalMediaItem.reason` — see `MediaHoverCard.svelte`'s
 * `currentItem.reason` popup line; this is the same field the legacy
 * AiDashboardSection populated). Falls back to the generic
 * `m.ai_based_on_taste()` copy for the bare `'ai'` kind or a malformed/legacy
 * reason payload missing its expected seed/label.
 */
function localizeTasteReason(reason: InternalTasteItem['reason']): string {
    switch (reason?.kind) {
        case 'rated-similar':
            if (reason.seed && reason.label) {
                return m.reason_rated_similar({ title: reason.seed, rating: reason.label });
            }
            return m.ai_based_on_taste();
        case 'genre-affinity':
            if (reason.seed) {
                return m.reason_genre_affinity({ genre: reason.seed });
            }
            return m.ai_based_on_taste();
        default:
            return m.ai_based_on_taste();
    }
}

/**
 * Maps a taste-rail item to a `UniversalMediaItem`, additionally attaching
 * the localized reason string (unlike the generic rails, which leave
 * `reason` unset).
 */
export function tasteItemToUniversal(item: InternalTasteItem): UniversalMediaItem {
    const media = item.media;
    return {
        id: media.id,
        externalIds: media.ids as ExternalIds,
        mediaType: media.type === 'season' ? 'series' : media.type,
        title: media.title,
        image: media.images?.poster?.href ?? FALLBACK_IMAGE,
        overview: media.overview,
        rating: media.rating,
        year: media.year ?? undefined,
        durationMs: media.durationMs,
        genres: media.genres,
        isAvailable: item.isAvailable ?? false,
        hasFiles: item.isAvailable ?? false,
        canRequest: item.canRequest ?? false,
        similarityScore: item.score,
        reason: localizeTasteReason(item.reason),
    };
}

export interface TasteRailPage {
    status: 'ready' | 'generating' | 'exhausted';
    /** Non-null only when the page has items — mirrors every other for-you rail's PageSection. */
    section: PageSection | null;
}

/**
 * Pure mapper from a raw `GET /api/for-you/taste` response body to the
 * `PageSection` the feed renders (id `'taste'`) plus its explicit page
 * status. Shared by the progressive loader (`loadSections`) and
 * `RecommendationFeed`'s manual "refresh available" chip (Task 2), which
 * refetches just the taste rail via `forYouApi.getTasteRail({ refresh: true })`
 * and needs the exact same mapping without re-running the whole fan-out.
 */
export function buildTasteRailSection(data: {
    status?: 'ready' | 'generating' | 'exhausted';
    items?: InternalTasteItem[];
}): TasteRailPage {
    let section: PageSection | null = null;
    if (data.items && data.items.length > 0) {
        section = {
            id: 'taste',
            type: 'carousel',
            title: m.section_taste(),
            items: data.items.map(tasteItemToUniversal),
            meta: { icon: 'sparkles' },
        };
    }
    return { status: data.status ?? 'ready', section };
}

export class ForYouDataLoader {
    constructor(
        private config: ForYouConfig,
        private aiEnabled: boolean,
        /**
         * Per-user feed preferences. Hidden section kinds are SKIPPED entirely —
         * the loader never fires their fetches (perf) and they never render.
         * Null/undefined → show everything (back-compat default).
         */
        private prefs: FeedPrefs | null = null,
    ) {}

    /** True when the given section KIND should be loaded for this user. */
    private visible(kind: string): boolean {
        return isSectionVisible(kind, this.prefs);
    }

    /**
     * Load all For You sections with optimized parallel fetching
     * Supports progressive loading via optional onProgress callback
     *
     * Key optimization: Phase 2 starts as soon as watched IDs are ready (~100ms),
     * NOT after all Phase 1 completes (~2s). This saves ~2 seconds.
     *
     * @param refresh - Force refresh (bypass cache)
     * @param onProgress - Optional callback for progressive updates as sections arrive
     * @param signal - Optional AbortSignal. When aborted (route change / start of a
     *   refresh / component destroy) every in-flight fan-out fetch is cancelled.
     *   Aborted fetches resolve as errored ApiResults and are swallowed quietly by
     *   the `!result.error` guards below (no toasts, no partial section pushes).
     */
    async loadSections(
        refresh = false,
        onProgress?: OnProgressCallback,
        signal?: AbortSignal,
    ): Promise<LoadResult> {
        const timings: Record<string, number> = {};
        const startTotal = performance.now();

        // Track individual API call timings
        const timedCall = async <T>(
            apiCall: () => Promise<ApiResult<T>>,
            name: string,
            phase: number = 1,
        ): Promise<ApiResult<T>> => {
            const start = performance.now();
            try {
                const result = await apiCall();
                timings[`${phase}_${name}`] = performance.now() - start;
                return result;
            } catch (e) {
                console.warn(`[ForYouLoader] timed API call failed: ${name}`, e);
                timings[`${phase}_${name}`] = performance.now() - start;
                return { data: null, error: 'Request failed', status: 0 };
            }
        };

        const startParallel = performance.now();

        // Accumulate sections as they arrive
        const sections: PageSection[] = [];
        const moodSections: PageSection[] = [];
        let exploreKeywordsSection: PageSection | null = null;
        let secondBecauseSection: PageSection | null = null;
        let featuredPickSection: PageSection | null = null;
        let tasteStatus: 'ready' | 'generating' | 'exhausted' | undefined;
        let totalRatings: number | undefined;
        let includeWatchHistory: boolean | undefined;

        // Helper to build a PageSection from a paginated ForYouRecommendationItem response
        // and notify progress. The section id/title is provided by the caller context.
        const processAndNotify = (
            result: ApiResult<unknown>,
            sectionMeta: { id: string; title: string },
        ): PageSection | null => {
            if (!result.error && result.data) {
                const paged = result.data as { items?: ForYouRecommendationItem[] };
                if (paged?.items && paged.items.length > 0) {
                    const section: PageSection = {
                        id: sectionMeta.id,
                        type: 'carousel',
                        title: sectionMeta.title,
                        items: paged.items.map(recommendationItemToUniversal),
                    };
                    sections.push(section);
                    // Notify progress immediately
                    onProgress?.({ type: 'forYou', sections: [section] });
                    return section;
                }
            }
            return null;
        };

        // Process the taste-rail response when ready. Unlike processAndNotify,
        // this also surfaces `status` (ready/generating/exhausted — see
        // RecommenderResult.status) even when there are zero items, so the
        // caller can render a "generating" skeleton or hide the rail instead
        // of silently rendering nothing. Items get the extra localized-reason
        // mapping (tasteItemToUniversal) the generic rails don't carry.
        const processTasteResponse = (result: ApiResult<unknown>): void => {
            if (result.error || !result.data) return;
            const data = result.data as {
                status?: 'ready' | 'generating' | 'exhausted';
                items?: InternalTasteItem[];
                includeWatchHistory?: boolean;
            };
            const { status, section } = buildTasteRailSection(data);
            if (section) sections.push(section);
            tasteStatus = status;
            includeWatchHistory = data.includeWatchHistory;
            onProgress?.({ type: 'taste', status: tasteStatus, section, includeWatchHistory });
        };

        // Process the lifetime rating count (used by TasteTrainerCard's
        // locked/unlocked copy — see LoadResult.totalRatings). Fired in
        // parallel with the taste-rail fetch itself, never blocking it.
        const processUserStatsResponse = (result: ApiResult<unknown>): void => {
            if (result.error || !result.data) return;
            const data = result.data as { stats?: { totalRatings?: number } };
            const count = data.stats?.totalRatings;
            if (typeof count === 'number') {
                totalRatings = count;
                onProgress?.({ type: 'userStats', totalRatings: count });
            }
        };

        // Process mood response when ready
        const processMoodResponse = (result: ApiResult<unknown>): void => {
            if (!result.error && result.data) {
                const moodData = result.data as SectionsData;
                if (moodData?.sections) {
                    moodSections.push(...moodData.sections);
                    onProgress?.({
                        type: 'mood',
                        sections: moodData.sections,
                    });
                }
            }
        };

        // Process explore keywords when ready.
        // explore-keywords still returns { keywords, section: PageSection | null }
        const processExploreKeywords = (result: ApiResult<unknown>): void => {
            if (!result.error && result.data) {
                const exploreData = result.data as { section?: PageSection | null };
                if (exploreData?.section) {
                    exploreKeywordsSection = exploreData.section;
                    onProgress?.({
                        type: 'exploreKeywords',
                        section: exploreKeywordsSection,
                    });
                }
            }
        };

        // Process featured pick when ready.
        // New contract: { pick: FeaturedPickItem | null, criteria: string | null }
        // Build a PageSection from the pick for the hero renderer.
        const processFeaturedPick = (result: ApiResult<unknown>): void => {
            if (!result.error && result.data) {
                const featuredData = result.data as FeaturedPickResponse;
                const pick = featuredData?.pick;
                if (pick) {
                    const posterHref = pick.images?.['poster']?.href;
                    const backdropHref = pick.images?.['backdrop']?.href;
                    const logoHref = pick.images?.['logo']?.href;
                    // Map 'series' → 'tv' for internal UniversalMediaType compat
                    // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- legacy recommendation payloads may use the external 'show' alias.
                    const isLegacyShow = pick.type === 'show';
                    const mediaType = (
                        pick.type === 'series' || isLegacyShow ? 'tv' : pick.type
                    ) as UniversalMediaType;
                    const externalIds: Record<string, string | number | null> = {};
                    for (const [k, v] of Object.entries(pick.ids ?? {})) {
                        const asNum = Number(v);
                        externalIds[k] = isNaN(asNum) ? v : asNum;
                    }
                    const universalItem: UniversalMediaItem = {
                        id: pick.id,
                        title: pick.title,
                        mediaType,
                        image: posterHref ?? FALLBACK_IMAGE,
                        backdrop: backdropHref,
                        year: pick.year,
                        overview: pick.overview,
                        rating: pick.rating,
                        seasonCount: pick.seasonCount,
                        episodeCount: pick.episodeCount,
                        availableEpisodeCount: pick.availableEpisodeCount,
                        watchedEpisodeCount: pick.watchedEpisodeCount,
                        unwatchedEpisodeCount: pick.unwatchedEpisodeCount,

                        externalIds: externalIds as ExternalIds,
                        // Honor server availability. hasFiles mirrors isAvailable —
                        // getPlayableId() gates the Watch button on it, so a
                        // request-only featured pick must not render as watchable.
                        isAvailable: pick.isAvailable ?? true,
                        canRequest: pick.canRequest ?? false,
                        hasFiles: pick.isAvailable ?? true,
                    };
                    featuredPickSection = {
                        id: 'featured-pick',
                        type: 'featured-pick',
                        title: featuredData.criteria ?? m.featured_pick(),
                        items: [universalItem],
                        meta: {
                            backdropUrl: backdropHref,
                            // Pass logo href through the arbitrary data bag
                            ...(logoHref ? { data: { logoUrl: logoHref } } : {}),
                        },
                    };
                    onProgress?.({
                        type: 'featuredPick',
                        section: featuredPickSection,
                    });
                }
            }
        };

        // Start watched IDs fetch first (needed for Phase 2)
        const watchedStart = performance.now();
        const watchedPromise = contentApi.getWatchedItems({ signal });

        // Fire all Phase 1 requests immediately - they notify progress as they
        // complete. Each is gated on the user's feed preferences: a hidden
        // section KIND is never fetched (perf) and never rendered. Essentials
        // (continue-watching, fulfilled-requests) always pass the gate.
        const phase1Requests: Promise<unknown>[] = [];

        if (this.visible('trending')) {
            phase1Requests.push(
                timedCall(
                    () => forYouApi.getTrending(this.config.defaultLimit, { signal }),
                    'trending',
                ).then((res) =>
                    processAndNotify(res, { id: 'trending', title: m.section_trending_today() }),
                ),
            );
        }
        if (this.visible('popular-shows')) {
            phase1Requests.push(
                timedCall(
                    () => forYouApi.getPopularShows(this.config.defaultLimit, { signal }),
                    'popular_shows',
                ).then((res) =>
                    processAndNotify(res, {
                        id: 'popular-shows',
                        title: m.section_popular_shows(),
                    }),
                ),
            );
        }
        if (this.visible('fulfilled-requests')) {
            phase1Requests.push(
                timedCall(() => forYouApi.getFulfilledRequests({ signal }), 'fulfilled').then(
                    (res) =>
                        processAndNotify(res, {
                            id: 'fulfilled-requests',
                            title: m.section_requests_ready(),
                        }),
                ),
            );
        }
        if (this.visible('short-movies')) {
            phase1Requests.push(
                timedCall(
                    () => forYouApi.getShortMovies(this.config.defaultLimit, { signal }),
                    'short_movies',
                ).then((res) =>
                    processAndNotify(res, { id: 'short-movies', title: m.section_short_movies() }),
                ),
            );
        }
        if (this.visible('anime')) {
            phase1Requests.push(
                timedCall(
                    () => forYouApi.getAnime(this.config.defaultLimit, { signal }),
                    'anime',
                ).then((res) =>
                    processAndNotify(res, { id: 'anime', title: m.section_anime_for_you() }),
                ),
            );
        }
        if (this.visible('fresh-releases')) {
            phase1Requests.push(
                timedCall(
                    () => forYouApi.getFreshReleases(this.config.defaultLimit, { signal }),
                    'fresh_releases',
                ).then((res) =>
                    processAndNotify(res, {
                        id: 'fresh-releases',
                        title: m.section_fresh_releases(),
                    }),
                ),
            );
        }
        if (this.visible('binge-worthy')) {
            phase1Requests.push(
                timedCall(
                    () => forYouApi.getBingeWorthy(this.config.defaultLimit, { signal }),
                    'binge_worthy',
                ).then((res) =>
                    processAndNotify(res, { id: 'binge-worthy', title: m.section_binge_worthy() }),
                ),
            );
        }
        if (this.visible('music-because')) {
            // music-because still returns { section: PageSection | null } (pre-built server-side)
            phase1Requests.push(
                timedCall(() => forYouApi.getMusicBecause({ signal }), 'music_because').then(
                    (res) => {
                        if (!res.error && res.data) {
                            const d = res.data as { section?: PageSection | null };
                            if (d?.section) {
                                sections.push(d.section);
                                onProgress?.({ type: 'forYou', sections: [d.section] });
                            }
                        }
                        return null;
                    },
                ),
            );
        }
        if (this.visible('music-quick-picks')) {
            // music-quick-picks still returns { section: PageSection | null } (pre-built server-side)
            phase1Requests.push(
                timedCall(() => forYouApi.getMusicQuickPicks({ signal }), 'music_quick_picks').then(
                    (res) => {
                        if (!res.error && res.data) {
                            const d = res.data as { section?: PageSection | null };
                            if (d?.section) {
                                sections.push(d.section);
                                onProgress?.({ type: 'forYou', sections: [d.section] });
                            }
                        }
                        return null;
                    },
                ),
            );
        }

        // Library fallback sections — load Recently Added unless hidden.
        if (this.visible('recently-added')) {
            phase1Requests.push(
                timedCall(
                    () => forYouApi.getRecentlyAdded(this.config.defaultLimit, { signal }),
                    'recently_added',
                ).then((res) =>
                    processAndNotify(res, {
                        id: 'recently-added',
                        title: m.section_recently_added(),
                    }),
                ),
            );
        }

        // Random Picks — only when AI is disabled (fallback for discovery)
        if (!this.aiEnabled && this.visible('random-picks')) {
            phase1Requests.push(
                timedCall(
                    () => forYouApi.getRandomPicks(this.config.defaultLimit, { signal }),
                    'random_picks',
                ).then((res) =>
                    processAndNotify(res, { id: 'random-picks', title: m.section_random_picks() }),
                ),
            );
        }

        // AI requests (if enabled) - process independently, each gated on prefs.
        if (this.aiEnabled) {
            if (this.visible('taste')) {
                phase1Requests.push(
                    timedCall(() => forYouApi.getTasteRail({ refresh }, { signal }), 'taste').then(
                        (res) => {
                            processTasteResponse(res);
                            return null;
                        },
                    ),
                );
                // Lifetime rating count for TasteTrainerCard's locked/unlocked
                // copy — fired alongside the rail fetch (not gated on its
                // result) so the trainer card's numbers are ready as soon as
                // possible, independent of rail status.
                phase1Requests.push(
                    timedCall(() => aiApi.getUserStats(), 'taste_user_stats').then((res) => {
                        processUserStatsResponse(res);
                        return null;
                    }),
                );
            }
            if (this.visible('mood-recommendations')) {
                phase1Requests.push(
                    timedCall(
                        () =>
                            forYouApi.getMoodRecommendations({
                                limit: this.config.moodLimit,
                                refresh,
                                signal,
                            }),
                        'mood',
                    ).then((res) => {
                        processMoodResponse(res);
                        return null;
                    }),
                );
            }
            if (this.visible('explore-keywords')) {
                phase1Requests.push(
                    timedCall(
                        () => forYouApi.getExploreKeywords({ signal }),
                        'explore_keywords',
                    ).then((res) => {
                        processExploreKeywords(res);
                        return null;
                    }),
                );
            }
            if (this.visible('featured-pick')) {
                phase1Requests.push(
                    timedCall(() => forYouApi.getFeaturedPick({ signal }), 'featured_pick').then(
                        (res) => {
                            processFeaturedPick(res);
                            return null;
                        },
                    ),
                );
            }
        }

        // Wait ONLY for watched IDs (fast ~100ms) - don't wait for all Phase 1 (~2s)
        // This lets Phase 2 start ~2 seconds earlier!
        const watchedResult = await watchedPromise;
        timings['1_watched_ids'] = performance.now() - watchedStart;

        // Parse watched items for Phase 2
        let watchedItems: WatchedItemResponse[] = [];
        if (!watchedResult.error && watchedResult.data) {
            const watchedData = watchedResult.data as WatchedItemsData;
            watchedItems = watchedData?.watchedItems || [];
        }

        // Start Phase 2 immediately (in parallel with remaining Phase 1 requests).
        // The "Because you watched" family (sources + similar) is gated on the
        // because-you-watched kind; the keyword rows on the you-like kind. When
        // both are hidden Phase 2 does no work at all.
        const wantBecause = this.visible('because-you-watched');
        const wantYouLike = this.visible('you-like');
        let phase2Promise: Promise<void> = Promise.resolve();
        if (watchedItems.length > 0 && (wantBecause || wantYouLike)) {
            const startPhase2 = performance.now();

            phase2Promise = (async () => {
                // Run sources and keywords fetch in parallel, with progressive updates
                const [sourcesResult, keywordsResult] = await Promise.all([
                    wantBecause
                        ? this.loadSourcesAndSimilar(timings, onProgress, signal)
                        : Promise.resolve({ becauseRows: [], secondBecauseRow: null }),
                    wantYouLike
                        ? this.loadKeywords(timings, onProgress, signal)
                        : Promise.resolve([]),
                ]);

                // Add "Because you watched" sections
                sections.push(...sourcesResult.becauseRows);
                secondBecauseSection = sourcesResult.secondBecauseRow;

                // Add keyword sections
                sections.push(...keywordsResult);

                timings['2_phase2_total'] = performance.now() - startPhase2;
            })();
        }

        // Wait for both Phase 1 AND Phase 2 to complete (they run in parallel)
        await Promise.all([Promise.all(phase1Requests), phase2Promise]);
        timings['1_parallel_total'] = performance.now() - startParallel;

        timings['total'] = performance.now() - startTotal;

        // Log performance metrics
        console.log('[ForYou] Load timings:', timings);

        return {
            forYouSections: sections,
            tasteStatus,
            totalRatings,
            includeWatchHistory,
            moodSections,
            exploreKeywordsSection,
            secondBecauseSection,
            featuredPickSection,
            timings,
        };
    }

    /**
     * Load sources and fetch similar items for each
     * Notifies progress as each "Because you watched" section completes
     */
    private async loadSourcesAndSimilar(
        timings: Record<string, number>,
        onProgress?: OnProgressCallback,
        signal?: AbortSignal,
    ): Promise<{
        becauseRows: PageSection[];
        secondBecauseRow: PageSection | null;
    }> {
        const startSources = performance.now();
        const { data: sourceData, error: sourceError } = await forYouApi.getWatchingSources(
            this.config.sourcesLimit,
            { signal },
        );
        timings['2_sources'] = performance.now() - startSources;

        if (sourceError || !sourceData) return { becauseRows: [], secondBecauseRow: null };

        // New contract: { sources: WatchingSource[], secondBecauseSource: WatchingSource | null }
        const typed = sourceData as {
            sources?: WatchingSource[];
            secondBecauseSource?: WatchingSource | null;
        };
        const sourceMovies = typed?.sources ?? [];
        const secondBecauseSourceData = typed?.secondBecauseSource ?? null;

        if (sourceMovies.length === 0) return { becauseRows: [], secondBecauseRow: null };

        // Fetch similar items for each source movie in parallel
        const startSimilar = performance.now();

        const becauseRows: PageSection[] = [];
        let secondBecauseRow: PageSection | null = null;

        /**
         * Build a "Because you watched X" PageSection from the new similar response.
         * New contract: { source: { id, title, type, ids }, items: ForYouRecommendationItem[], page }
         */
        const buildAndNotifySection = (
            source: WatchingSource,
            items: InternalTasteItem[],
            isSecondBecause = false,
        ): PageSection | null => {
            if (items.length === 0) return null;

            // Derive a stable composite key from the canonical ids{} record
            const mediaKey = buildMediaKey(source.ids, source.type);
            const sectionKey = mediaKey ?? source.title;

            // Generate backdrop URL from internal UUID when available
            const backdropUrl = this.getBackdropUrl(source.ids, source.id);

            const posterHref = source.images?.poster?.href;

            const section: PageSection = {
                id: `because-${sectionKey}`,
                type: 'carousel',
                title:
                    source.reason === 'popular'
                        ? m.section_popular_with_viewers()
                        : m.section_because_you_watched({ title: escapeHtml(source.title) }),
                items: items.map((item) => ({
                    ...tasteItemToUniversal(item),
                    reason: item.reason?.label,
                })),
                meta: {
                    icon: 'sparkles',
                    sourceImage: posterHref,
                    sourceTitle: source.title,
                    sourceExternalIds: source.ids,
                    sourceMediaType: source.type,
                    backdropUrl,
                    accentColor: 'purple',
                },
            };

            if (isSecondBecause) {
                onProgress?.({ type: 'secondBecause', section });
            } else {
                onProgress?.({ type: 'forYou', sections: [section] });
            }
            return section;
        };

        const fetchSimilar = async (
            source: WatchingSource,
            idx: number,
            limit: number = this.config.similarPerSource,
            isSecondBecause = false,
        ): Promise<PageSection | null> => {
            const start = performance.now();
            // Build composite key for API call from the canonical ids{} map
            const mediaKey = buildMediaKey(source.ids, source.type);
            if (!mediaKey) {
                timings[`2_similar_${idx}`] = performance.now() - start;
                return null;
            }
            try {
                const { data, error } = await forYouApi.getSimilar({
                    key: mediaKey,
                    title: source.title,
                    limit,
                    signal,
                });
                timings[`2_similar_${idx}`] = performance.now() - start;
                if (!error && data) {
                    // New contract: { source, items: InternalTasteItem[], page }
                    const d = data as { items?: InternalTasteItem[] };
                    if (d?.items?.length) {
                        return buildAndNotifySection(source, d.items, isSecondBecause);
                    }
                }
            } catch (e) {
                console.warn(`[ForYouLoader] similar fetch failed for index ${idx}`, e);
                timings[`2_similar_${idx}`] = performance.now() - start;
            }
            return null;
        };

        // Fire all similar fetches in parallel - each notifies progress when done
        const similarPromises = sourceMovies.map((source: WatchingSource, idx: number) =>
            fetchSimilar(source, idx).then((section) => {
                if (section) becauseRows.push(section);
                return section;
            }),
        );

        // Fetch second because source if available (in parallel)
        let secondBecausePromise: Promise<PageSection | null> | null = null;
        if (secondBecauseSourceData) {
            secondBecausePromise = fetchSimilar(
                secondBecauseSourceData,
                999,
                this.config.secondBecauseLimit,
                true,
            ).then((section) => {
                secondBecauseRow = section;
                return section;
            });
        }

        // Wait for all similar fetches to complete
        const allPromises = secondBecausePromise
            ? [...similarPromises, secondBecausePromise]
            : similarPromises;
        await Promise.all(allPromises);
        timings['2_similar_total'] = performance.now() - startSimilar;

        return { becauseRows, secondBecauseRow };
    }

    /**
     * Load keyword-based recommendation sections
     * Notifies progress when sections are ready
     */
    private async loadKeywords(
        timings: Record<string, number>,
        onProgress?: OnProgressCallback,
        signal?: AbortSignal,
    ): Promise<PageSection[]> {
        const startKeywords = performance.now();
        const { data, error } = await forYouApi.getKeywords({
            rows: this.config.keywordRows,
            limit: this.config.keywordItems,
            signal,
        });
        timings['2_keywords'] = performance.now() - startKeywords;

        if (error || !data) return [];

        // New contract: { sections: ForYouKeywordSection[] }
        // Each ForYouKeywordSection has canonical items — map to UniversalMediaItem for the renderer.
        const keywordsData = data as { sections?: ForYouKeywordSection[] };
        if (keywordsData?.sections && keywordsData.sections.length > 0) {
            const pageSections: PageSection[] = keywordsData.sections.map((ks) => ({
                id: ks.id,
                type: 'carousel' as const,
                title: ks.title,
                items: ks.items.map((item) => {
                    const image =
                        item.images?.['poster']?.href ??
                        item.images?.['thumb']?.href ??
                        FALLBACK_IMAGE;
                    const backdrop = item.images?.['backdrop']?.href;
                    // Map 'series' → 'tv' for UniversalMediaType compat
                    // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- legacy recommendation payloads may use the external 'show' alias.
                    const isLegacyShow = item.type === 'show';
                    const mediaType = (
                        item.type === 'series' || isLegacyShow ? 'tv' : item.type
                    ) as UniversalMediaType;
                    const externalIds: Record<string, string | number | null> = {};
                    for (const [k, v] of Object.entries(item.ids ?? {})) {
                        const asNum = Number(v);
                        externalIds[k] = isNaN(asNum) ? v : asNum;
                    }
                    return {
                        id: item.id,
                        title: item.title,
                        mediaType,
                        image,
                        backdrop,
                        year: item.year,
                        externalIds: externalIds as ExternalIds,
                        // Honor server availability. hasFiles mirrors isAvailable —
                        // it is what getPlayableId() gates the Watch button on, so a
                        // request-only keyword item must not render as watchable.
                        isAvailable: item.isAvailable ?? true,
                        canRequest: item.canRequest ?? false,
                        hasFiles: item.isAvailable ?? true,
                    } satisfies UniversalMediaItem;
                }),
                // Pass keyword tag via the arbitrary data bag (SectionMeta has no standalone `keyword`)
                meta: ks.keyword ? { data: { keyword: ks.keyword } } : undefined,
            }));
            onProgress?.({ type: 'forYou', sections: pageSections });
            return pageSections;
        }

        return [];
    }

    /**
     * Generate backdrop URL for "Because you watched" sections.
     * New signature: takes flat ids{} record and an optional internal UUID.
     * Priority 1: catalog proxy via internal UUID.
     * Priority 2: composite image key from the best external provider id.
     */
    private getBackdropUrl(
        ids: Record<string, string>,
        internalId: string | null | undefined,
    ): string | undefined {
        // Priority 1: Internal UUID via catalog proxy
        if (internalId) {
            return getCatalogBackdropUrl(internalId, { size: 'medium' });
        }

        // Priority 2: Best available external ID via preferred provider heuristic
        const externalIds: Record<string, string | number | null> = {};
        for (const [k, v] of Object.entries(ids)) {
            if (k !== 'internal') externalIds[k] = v;
        }
        const preferred = getPreferredExternalId(externalIds as ExternalIds);
        if (!preferred || preferred.provider === 'internal') return undefined;

        const numId = parseInt(preferred.id, 10);
        if (isNaN(numId) || numId <= 0 || numId >= 100000000) return undefined;

        // We don't have a canonical type string here — use 'movie' as a safe fallback;
        // the image proxy resolves by provider ID which is type-agnostic for TMDb backdrops.
        const compositeKey = `${preferred.provider}:${numId}:movie`;
        return `/api/image/${compositeKey}/backdrop?size=medium`;
    }
}
