<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * Browse Page - Media browsing with genres and keywords
     * Uses SectionRenderer for unified content display
     */
    import * as m from '$lib/paraglide/messages.js';
    import { onMount, tick } from 'svelte';
    import { findPageScroller } from '$lib/utils/scroll-restoration';
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import { goto, replaceState, beforeNavigate, afterNavigate } from '$app/navigation';
    import { url, resolve } from '$lib/paths';
    import * as browseApi from '$lib/api/browse';
    import * as contentApi from '$lib/api/content';
    import { navigateToWatch } from '$lib/stores/watch-navigation';
    import { setChangedRevision, sessionChangedRevision } from '$lib/services/sse/watch-state-sse';
    // Imported directly from its file, NOT the `$lib/components/sections`
    // barrel: the barrel also statically re-exports HeroSection,
    // CalendarSection, LiveSessionSection and KeywordChipsSection, which
    // Rollup treats as side-effectful (Svelte components), so importing
    // anything from the barrel pulls its whole module graph — including
    // HeroSection + LiveSessionSection (~4600 lines combined) — into any
    // chunk this route's entry can reach, even though this file only
    // touches the `SectionRenderer` binding. Importing the single file
    // sidesteps the barrel's re-exports entirely; this is what actually
    // realizes SectionRenderer's dynamic-import split for `/browse` (see
    // SectionRenderer.svelte's own import comment).
    import SectionRenderer from '$lib/components/sections/SectionRenderer.svelte';
    import LazyMount from '$lib/components/ui/LazyMount.svelte';
    // AzBrowseView is dynamically imported below (see the `{#await}` at its
    // render site) rather than imported here: azMode is driven entirely by
    // client-only code (azStore.initFromUrl runs inside `onMount`, gated
    // `if (!browser) return;`), so azMode is ALWAYS false during SSR — even
    // for a direct navigation to /browse/az (see src/routes/browse/az/+page.svelte,
    // which re-renders this same component; the /az path only flips azMode
    // client-side, after hydration). AzBrowseView (17.7 KB brotli) was never
    // server-rendered here, so moving it off this file's static import list
    // does not change what SSR emits for `/browse` or `/browse/az` — it only
    // moves the 17.7 KB out of the eagerly-loaded chunk into one fetched on
    // demand when azMode actually flips true on the client.
    import BrowseFilterSearch from '$lib/components/browse/BrowseFilterSearch.svelte';
    import { genreBrowseHref, recentBrowseHref } from '$lib/shared/browse-filter-route';
    import { openDetailForGridItem, playGridItem } from '$lib/components/browse/browse-modals';
    import RecentlyAddedSection from '$lib/components/browse/RecentlyAddedSection.svelte';
    import PopularMediaStats from '$lib/components/PopularMediaStats.svelte';
    import {
        transformJellyfinItem,
        transformJellyfinItems,
        type BrowseItem,
        type KeywordBrowseItem,
    } from '$lib/utils/browse-transformers';
    import { fetchMediaDetailsWithKey } from '$lib/components/browse';
    import {
        loadWatchingData as loadWatchingDataService,
        type BrowseMediaType,
    } from '$lib/services/browse-data.service';
    import {
        createAzBrowseStore,
        isAzRoutePath,
        type AzMediaType,
        type BrowseSort,
    } from '$lib/stores/azBrowse';
    import { loadBrowseSelection, saveBrowseSelection } from '$lib/stores/browse-selection';
    import type { AudioFilterLang, SubtitleFilterLang } from '$lib/shared/track-language';
    import type { ResolutionTier, HdrTier, CodecTier } from '$lib/shared/quality-filter';
    import { openMediaModal, openSimilarMoviesModal } from '$lib/utils/modal-utils';
    import { handleItemClick as handleWatchingItemClick } from '$lib/components/foryou/item-handlers';
    import { Icon, MagnifyingGlass, Film, Tv, ArrowLeft, Bars3BottomLeft } from 'svelte-hero-icons';
    import type { KeywordSection } from '$lib/schemas/api-browse-responses';
    import { mediaPreviewToUniversal } from '$lib/utils/media-preview';
    import UniversalMediaCard from '$lib/components/ui/UniversalMediaCard.svelte';
    import { Skeleton } from '$lib/components/ui';
    import { env } from '$env/dynamic/public';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { getExternalIdFor } from '$lib/utils/external-ids';
    import { asInternalUuid } from '$lib/utils/id-patterns';
    import {
        hasValidExternalId,
        buildMediaKey,
        getTmdbIdFromExternalIds,
        getPlayableId,
    } from '$lib/utils/media-id-helpers';
    import {
        getCwDismissArgs,
        dismissCwItem,
        restoreCwItem,
        getCwDismissDisplayName,
        type CwDismissTargetType,
    } from '$lib/utils/cw-dismiss-helper';
    import { toasts } from '$lib/stores/toast.store';
    import { resolveMediaPlayTarget } from '$lib/utils/media-play-target';
    import { playAudiobook, audiobookStartFailureMessage } from '$lib/services/audiobook-playback';
    import { dragScroll } from '$lib/utils/drag-scroll';
    import { isEpisode } from '$lib/shared/media-types';
    import {
        toTmdbMediaType as toTmdbType,
        toUniversalMediaType,
        toApiMediaType,
    } from '$lib/shared/media-type-domain';
    import type { MediaKey } from '$lib/types/api-common';
    import type { ExternalIds } from '$lib/types/api-common';
    import type { PageData } from './$types';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';

    const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null;

    interface Props {
        /**
         * `watching` and `browseSsr` are optional because /browse/az renders
         * this same component without a server load of its own — the SSR seed
         * is a /browse-only optimisation and every read below is already
         * `data.watching?.` / `data.browseSsr?.`-guarded. `browseSsr` (not
         * `browse`) — the root layout already owns `PageData['browse']` as a
         * config object; see +page.server.ts's return-statement comment.
         */
        data: Omit<PageData, 'watching' | 'watchingSuppressed' | 'browseSsr'> & {
            watching?: PageData['watching'];
            watchingSuppressed?: PageData['watchingSuppressed'];
            browseSsr?: PageData['browseSsr'];
        };
    }

    let { data }: Props = $props();

    type MediaType = 'all' | 'movies' | 'series';

    let loading = $state(true);
    let loadingWatching = $state(true); // Separate loading state for continue watching (loaded async)
    let watchingRefreshInFlight = false;
    let queuedWatchingRefresh = false;
    let queuedWatchingRefreshBustCache = false;
    let error = $state('');
    let searchQuery = $state('');
    let catalogGenre = $state<string | undefined>();
    let catalogTag = $state<string | undefined>();
    let catalogView = $state<'grid' | 'list'>('grid');
    let catalogEpoch = $state(0);
    let catalogHandle: { getLoadedCount: () => number } | undefined = $state();
    let restoreCount = $state(0);
    let restoreScroll: number | undefined;
    export const snapshot = {
        capture: (): { count: number; scroll: number } => ({
            count: catalogHandle?.getLoadedCount() ?? 0,
            scroll: findPageScroller().scrollTop,
        }),
        restore: (saved: { count: number; scroll: number }): void => {
            restoreCount = saved.count;
            restoreScroll = saved.scroll;
        },
    };
    async function restoreCatalogPosition(): Promise<void> {
        if (restoreScroll === undefined) return;
        await tick();
        findPageScroller().scrollTop = restoreScroll;
        restoreScroll = undefined;
    }
    function initialTab(): MediaType {
        const type = $page.url.searchParams.get('type');
        return type === 'movies' || type === 'series' ? type : 'all';
    }
    let activeTab = $state<MediaType>(initialTab());

    type BrowseGenreRow = { genre: string; items: BrowseItem[] };

    type BrowseApiResponse = {
        recentlyAdded: BrowseItem[];
        genres: BrowseGenreRow[];
    };

    // Browse data.
    // Seed Continue-Watching / Next-Up from the AWAITED SSR payload
    // (browse/+page.server.ts) at init so the row is SERVER-RENDERED into the
    // first-paint HTML — no post-hydration skeleton→content flash. A null payload
    // only falls back when the server did not intentionally suppress watching.
    function initialSsrWatching(): PageSection[] | null {
        return data.watching?.sections ? (data.watching.sections as PageSection[]) : null;
    }

    function initialWatchingSuppressed(): boolean {
        return data.watchingSuppressed === true;
    }

    // Seed genres/recentlyAdded from the AWAITED SSR payload
    // (browse/+page.server.ts) at init, the same way CW is seeded above — the
    // rows are SERVER-RENDERED into the first-paint HTML for the tab the
    // request URL selected, no post-hydration skeleton→content flash. A null
    // payload (SSR failed, or this render has no server load — /browse/az)
    // falls back to the existing onMount client fetch.
    function initialSsrBrowse(): PageData['browseSsr'] | null {
        return data.browseSsr ?? null;
    }

    const ssrWatching = initialSsrWatching();
    const watchingSuppressed = initialWatchingSuppressed();
    let watchingSections: PageSection[] = $state(ssrWatching ?? []);
    // CRITICAL: when SSR seeded CW the loading state must start FALSE. `loadWatchingData`
    // (which set loadingWatching=false) is now only a null-payload fallback, so without
    // this the spinner would never clear and CW "loads endlessly".
    if (ssrWatching || watchingSuppressed) loadingWatching = false;

    const ssrBrowse = initialSsrBrowse();
    // `$state.raw`: every write below is a wholesale reassignment (`= [...]` /
    // `= result`), never an in-place `.push`/`.splice`/index mutation — see
    // loadBrowseData(), loadKeywordSections() and loadMoreKeywords() — so the
    // fine-grained per-item proxying `$state` gives these arrays buys nothing
    // and only adds bookkeeping overhead across ~280 cards.
    // Same schema→client-type bridge as loadBrowseData(): the API schema's
    // `year` is nullish, the client BrowseItem's is optional-only.
    let recentlyAdded: BrowseItem[] = $state.raw(
        (ssrBrowse?.recentlyAdded ?? []) as unknown as BrowseItem[],
    );
    let genres: BrowseGenreRow[] = $state.raw(
        (ssrBrowse?.genres ?? []) as unknown as BrowseGenreRow[],
    );
    // SSR seeded the rows for the tab this render started on — skip the
    // skeleton state so buildSections() renders them immediately instead of
    // the `loading` placeholder carousels (see the onMount fetch below, which
    // is correspondingly skipped for this same tab on first load).
    if (ssrBrowse) loading = false;
    let browseRequestSeq = 0;
    let keywordRequestSeq = 0;
    let loadedBrowseType: MediaType | null = ssrBrowse ? initialTab() : null;

    // Keyword-based sections (TMDB tags) with pagination
    type KeywordsStatus = 'idle' | 'loading' | 'loaded' | 'loading-more';
    let keywordSections: KeywordSection[] = $state.raw([]);
    let keywordsStatus = $state<KeywordsStatus>('idle');
    let keywordOffset = 0;
    let hasMoreKeywords = $state(false);
    let keywordSentinel: HTMLDivElement | undefined = $state();
    // Derived convenience flags
    let loadingKeywords = $derived(keywordsStatus === 'loading');
    let loadingMoreKeywords = $derived(keywordsStatus === 'loading-more');

    // Popular Media Stats (shown after all content exhausted, only on 'all' tab)
    type PopularStatsHandle = { load: () => Promise<void> };
    let popularStatsComponent = $state<PopularStatsHandle | null>(null);
    let popularStatsSentinel: HTMLDivElement | undefined = $state();
    let popularStatsObserver = $state<IntersectionObserver | null>(null);
    let popularStatsLoaded = false;

    // A-Z Browse Mode state (managed by azBrowseStore)
    const azStore = createAzBrowseStore();

    let searchInputRef: HTMLInputElement | undefined = $state();

    // Server-driven UI sections.
    // Derived (not an $effect-written $state) so it recomputes exactly when
    // one of the inputs buildSections() reads actually changes, and never on
    // unrelated ticks. The keyed `{#each sections as section (section.id)}`
    // below reuses SectionRenderer instances across rebuilds.
    let sections: PageSection[] = $derived.by(() => buildSections());

    // Variables for buildSections() - computed reactively

    // Transformer functions now imported from $lib/utils/browse-transformers

    /**
     * Build all sections from raw data
     * IMPORTANT: This function must be pure (no side effects) to avoid recursive reactive loops
     */
    function buildSections(): PageSection[] {
        const result: PageSection[] = [];

        // Continue Watching is already a canonical server-driven section from
        // the SSR loader or /api/for-you/watching. Keep browse on that same
        // representation instead of mapping it through BrowseItem and back.
        if (activeTab === 'all') {
            if (loadingWatching) {
                // Show skeleton placeholder while loading
                result.push({
                    id: 'continue-watching',
                    type: 'continue-watching',
                    title: m.browse_continue_watching(),
                    items: [], // Empty items - the component will show skeleton
                    meta: {
                        icon: 'play-circle',
                        iconColor: 'text-green-400',
                        loading: true,
                    },
                });
            } else if (watchingSections.length > 0) {
                result.push(...watchingSections);
            }
        }

        // While the main browse fetch is in flight (initial load / tab switch),
        // emit placeholder carousels so the genre area shows per-section
        // skeletons instead of blanking the whole page. The stale genres/keywords
        // from the previous tab are intentionally NOT rendered mid-load; they
        // come back (fresh) once loadBrowseData resolves and clears `loading`.
        // An empty title makes StandardSection skip its header, so these read as
        // pure skeleton rows.
        if (loading) {
            for (let i = 0; i < 3; i++) {
                result.push({
                    id: `browse-skeleton-${i}`,
                    type: 'carousel',
                    title: '',
                    items: [],
                    meta: { loading: true },
                });
            }
            return result;
        }

        // Genre Rows
        for (const genreRow of filteredGenres) {
            result.push({
                id: `genre-${genreRow.genre.toLowerCase().replace(/\s+/g, '-')}`,
                type: 'carousel',
                title: genreRow.genre,
                // "Show more →" opens the genre's full grid — same destination
                // as its chip in the rail above.
                meta: { data: { viewAllHref: genreBrowseHref(genreRow.genre, activeTab) } },
                // transformJellyfinItems() owns both guards: it skips falsy/id-less
                // entries (a malformed one used to throw and take out the whole
                // section) and drops items whose media type has no client card.
                items: transformJellyfinItems(genreRow.items),
            });
        }

        // Keyword Sections (TMDB Tags)
        for (const section of keywordSections) {
            result.push({
                id: `keyword-${section.keywordId}`,
                type: 'carousel',
                title: section.keyword,
                items: section.items.map(mediaPreviewToUniversal),
                meta: { accentColor: 'secondary' },
            });
        }

        return result;
    }

    let keywordObserver = $state<IntersectionObserver | null>(null);
    let lastObservedSentinel = $state<HTMLDivElement | null>(null);

    // Sticky-header condense-on-scroll (fix 2). `scrolled` drives the
    // `.condensed` class on the header; `headerRef` measures the expanded header
    // height for the condense slack below.
    let scrolled = $state(false);
    let headerRef = $state<HTMLElement | undefined>(undefined);
    /** Sentinel sitting CONDENSE_SCROLL_THRESHOLD px into the page; the header
     * condenses while it's out of view (works for window AND inner scrollers). */
    let condenseSentinelRef = $state<HTMLElement | undefined>(undefined);
    const CONDENSE_SCROLL_THRESHOLD = 80;
    /** Bottom spacer height while condensed. On a page that can barely scroll
     * past the threshold, the shrinking header shortens the page, the scroller
     * clamps scrollTop back above the sentinel, the header expands, and the
     * loop repeats. Padding by the expanded header height keeps the page at
     * least as tall as before condensing, so scrollTop is never clamped. */
    let condenseSlack = $state(0);

    // Condense the sticky header once the page scrolls past the sentinel.
    // Depending on layout mode the app shell scrolls either the WINDOW or an
    // inner container (html/body overflow:hidden) where window.scrollY never
    // changes, so a viewport-rooted IntersectionObserver on the sentinel is the
    // scroller-agnostic signal. An $effect (not onMount) so the observer
    // (re)attaches whenever the sentinel element (re)mounts.
    $effect(() => {
        const sentinel = condenseSentinelRef;
        if (!browser || !sentinel) return;
        const observer = new IntersectionObserver(
            (entries) => {
                const condensed = !entries[0].isIntersecting;
                // Measured before the class flips, in the same flush, so the
                // spacer and the shorter header land in one layout pass.
                condenseSlack = condensed ? (headerRef?.offsetHeight ?? 0) : 0;
                scrolled = condensed;
            },
            { threshold: 0 },
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    });

    /**
     * Destination chips for the rail under the tabs. Every chip opens a full
     * grid on /browse/filter — Recently Added (newest first) and one per genre —
     * so a chip means one thing everywhere: "show me all of this". They used to
     * smooth-scroll to the matching carousel, which only ever showed the ~20
     * items that row holds; there was no way to browse a genre in full.
     *
     * Only destinations belong here. Continue Watching and the keyword rows sit
     * on this page but have no grid of their own, and a chip that scrolls next
     * to chips that navigate would look identical while doing something else.
     * Labels reuse the already-localized titles — never hardcoded.
     */
    type DestinationChip = { key: string; label: string; href: string };
    let destinationChips = $derived.by<DestinationChip[]>(() => {
        const chips: DestinationChip[] = [];
        if (recentlyAdded.length > 0) {
            chips.push({
                key: 'recently-added',
                label: m.browse_recently_added(),
                href: recentBrowseHref(activeTab),
            });
        }
        // Stale genres from the previous tab are hidden mid-load, matching the
        // rows below (buildSections emits only skeletons while `loading`).
        if (!loading) {
            for (const row of filteredGenres) {
                chips.push({
                    key: `genre-${row.genre}`,
                    label: row.genre,
                    href: genreBrowseHref(row.genre, activeTab),
                });
            }
        }
        return chips;
    });

    onMount(() => {
        if (!browser) return;

        // Set up IntersectionObserver for infinite scroll on keyword sections
        keywordObserver = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMoreKeywords && !loadingMoreKeywords) {
                    loadMoreKeywords();
                }
            },
            { rootMargin: browseConfig.scrollMargin },
        );

        // Set up IntersectionObserver for popular media stats (triggers when scrolled into view)
        popularStatsObserver = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && !popularStatsLoaded && activeTab === 'all') {
                    loadPopularStats();
                }
            },
            { rootMargin: browseConfig.scrollMargin },
        );

        // A-Z infinite scroll now handled by AzBrowseView component

        // Initial data load
        (async () => {
            // Initialize A-Z mode from the route, URL params, or the stored
            // preference — in that order. /browse/az renders THIS component and
            // carries no `mode=az`, so without the path signal a deep link there
            // (e.g. the tag/genre picker's /browse/az?tag=…) fell back to the
            // preference and rendered rails, dropping the filter.
            restoreCatalogUrl($page.url);

            // SSR already seeded genres/recentlyAdded for this tab (see the
            // `$state.raw` seed above) — skip the redundant initial fetch. Tab
            // switches and refreshes still call loadBrowseData() directly
            // (switchTab / retry button / keyword-triggered reloads below).
            if (!ssrBrowse || loadedBrowseType !== activeTab) {
                void loadBrowseData();
            }

            // Load keyword sections in background (don't block main content)
            loadKeywordSections();
        })();

        return () => {
            cancelCatalogUrlRestore();
            browseRequestSeq++;
            keywordRequestSeq++;
            keywordObserver?.disconnect();
            popularStatsObserver?.disconnect();
        };
    });

    // The watching strip on this page is loaded by the onMount fetch
    // above; subscribe directly and refetch on either SSE channel.
    // Both signals matter: setChangedRevision covers mark/clear/sync;
    // sessionChangedRevision covers session start/pause/resume/stop
    // (in another tab or on another device). Without the second
    // subscription, browse's CW strip would lag /'s after a fresh
    // session start until focus or remount.
    let setChangedBaseline = -1;
    $effect(() => {
        if (watchingSuppressed) return;
        const rev = $setChangedRevision;
        if (setChangedBaseline === -1) {
            setChangedBaseline = rev;
            return;
        }
        loadWatchingData(true);
    });
    let sessionChangedBaseline = -1;
    $effect(() => {
        if (watchingSuppressed) return;
        const rev = $sessionChangedRevision;
        if (sessionChangedBaseline === -1) {
            sessionChangedBaseline = rev;
            return;
        }
        loadWatchingData(true);
    });

    // CW/NU are already SERVER-RENDERED from `ssrWatching` (see the $state init
    // above). This only covers the fallback: when the SSR payload was null
    // because SSR failed, fetch it on the client once. Intentional suppression
    // is terminal for this page. Runs once.
    let watchingFallbackDone = false;
    $effect(() => {
        if (!browser || watchingFallbackDone) return;
        watchingFallbackDone = true;
        if (!watchingSuppressed && !ssrWatching) void loadWatchingData();
    });

    async function loadBrowseData(): Promise<void> {
        const requestSeq = ++browseRequestSeq;
        const requestedType = activeTab;
        loadedBrowseType = null;
        loading = true;
        error = '';
        recentlyAdded = [];
        genres = [];

        try {
            // Load main browse data (global/cached). Continue-Watching is loaded
            // ONCE via the streamed SSR seed (seedWatchingFromSSR) — it's
            // tab-independent, so it does NOT need reloading on every tab change.
            const browsePromise = browseApi.getBrowse(requestedType);

            const { data: browseResult, error: browseError } = await browsePromise;
            if (requestSeq !== browseRequestSeq || requestedType !== activeTab) return;
            if (browseError || !browseResult) {
                throw new Error(browseError || 'Failed to load browse data');
            }
            // Note: Continue Watching is loaded asynchronously via loadWatchingData().
            recentlyAdded = (browseResult?.recentlyAdded || []) as unknown as BrowseItem[];
            genres = (browseResult?.genres || []) as unknown as BrowseGenreRow[];
            loadedBrowseType = requestedType;
        } catch (e) {
            if (requestSeq !== browseRequestSeq || requestedType !== activeTab) return;
            console.error('Browse load error:', e);
            error = m.error_loading({ error: 'browse content' });
        } finally {
            if (requestSeq === browseRequestSeq) loading = false;
        }
    }

    /**
     * Load continue watching and next up data asynchronously
     * This allows the main browse content to render while watching data loads
     */
    async function performWatchingLoad(refresh: boolean): Promise<void> {
        loadingWatching = true;
        try {
            const response = await loadWatchingDataService(20, refresh);
            watchingSections = response?.sections ?? [];
        } catch (e) {
            console.error('Failed to load watching data:', e);
            // Fail silently - the skeleton will just disappear
        } finally {
            loadingWatching = false;
        }
    }

    async function loadWatchingData(refresh = false) {
        if (watchingSuppressed) return;
        queuedWatchingRefresh = true;
        queuedWatchingRefreshBustCache = queuedWatchingRefreshBustCache || refresh;

        if (watchingRefreshInFlight) return;

        watchingRefreshInFlight = true;
        try {
            while (queuedWatchingRefresh) {
                const nextRefresh = queuedWatchingRefreshBustCache;
                queuedWatchingRefresh = false;
                queuedWatchingRefreshBustCache = false;
                await performWatchingLoad(nextRefresh);
            }
        } finally {
            watchingRefreshInFlight = false;
        }
    }

    /**
     * Refresh only the continue watching and next up sections.
     * Called when video player closes to update playback progress.
     */
    async function refreshContinueWatching() {
        await loadWatchingData();
    }

    async function loadKeywordSections(): Promise<void> {
        const requestSeq = ++keywordRequestSeq;
        keywordSections = [];
        hasMoreKeywords = false;
        keywordsStatus = 'loading';
        keywordOffset = 0;
        try {
            const { data, error } = await browseApi.getBrowseKeywords({
                limit: browseConfig.keywordsInitial,
                offset: 0,
                type: activeTab,
            });
            if (requestSeq !== keywordRequestSeq) return;
            if (error || !data) {
                keywordSections = [];
                return;
            }
            keywordSections = data.items;
            hasMoreKeywords = data.page.hasMore;
            keywordOffset = (data.page.offset ?? 0) + data.page.limit;
        } catch (e) {
            if (requestSeq !== keywordRequestSeq) return;
            console.error('Failed to load keyword sections:', e);
            keywordSections = [];
        } finally {
            if (requestSeq === keywordRequestSeq) keywordsStatus = 'loaded';
        }
    }

    async function loadMoreKeywords() {
        if (keywordsStatus !== 'loaded' || !hasMoreKeywords) return;
        const requestSeq = ++keywordRequestSeq;

        keywordsStatus = 'loading-more';
        try {
            const { data, error } = await browseApi.getBrowseKeywords({
                limit: browseConfig.keywordsPageSize,
                offset: keywordOffset,
                type: activeTab,
            });

            if (requestSeq !== keywordRequestSeq) return;
            if (error || !data) {
                return;
            }

            // Append new keyword sections
            const newSections = data.items;
            keywordSections = [...keywordSections, ...newSections];
            hasMoreKeywords = data.page.hasMore;
            keywordOffset = (data.page.offset ?? keywordOffset) + data.page.limit;
        } catch (e) {
            if (requestSeq !== keywordRequestSeq) return;
            console.error('Failed to load more keyword sections:', e);
        } finally {
            if (requestSeq === keywordRequestSeq) keywordsStatus = 'loaded';
        }
    }

    async function loadPopularStats() {
        if (popularStatsLoaded || !popularStatsComponent) return;
        popularStatsLoaded = true;
        await popularStatsComponent.load();
    }

    // =========================================================================
    // A-Z Browse Mode Functions (delegated to azStore)
    // =========================================================================

    // NOTE: A-Z data fetching is owned entirely by <AzBrowseView> (it fetches on
    // mount and re-fetches when its mediaType/selectedGroupId props change). The
    // page only mirrors selections into the store + URL — it never triggers A-Z
    // fetches, so there is no loadAzItems/loadAzLibraries here.

    // Reflect the current A-Z store state (mode/type/group/letter/language/
    // quality/sort) into the URL so the view is deep-linkable and survives
    // reload/share. The page is the single owner of the browse URL; AzBrowseView
    // reports selections upward via the onSelect* callbacks below rather than
    // navigating itself.
    //
    // Compose the remembered playback axes with this catalog's content,
    // query and presentation state, without navigating or remounting the grid.
    function browseSelectionIdentity(): string | undefined {
        const user = data.user;
        return user?.userId
            ? `id:${user.userId}`
            : user?.username
              ? `username:${user.username}`
              : undefined;
    }

    let catalogUrlRestoreTimer: ReturnType<typeof setTimeout> | undefined;

    function cancelCatalogUrlRestore(): void {
        clearTimeout(catalogUrlRestoreTimer);
        catalogUrlRestoreTimer = undefined;
    }

    function writeAzUrl(): void {
        cancelCatalogUrlRestore();
        const params = azStore.buildParams(activeTab);
        params.set('mode', azMode ? 'az' : 'discover');
        if (searchQuery.trim()) params.set('q', searchQuery.trim());
        if (catalogGenre) params.set('genre', catalogGenre);
        if (catalogTag) params.set('tag', catalogTag);
        if (catalogView === 'list') params.set('layout', 'list');
        // Explicit empty axes prevent a shared URL inheriting somebody else's
        // saved playback filters when it is restored on another device.
        for (const key of ['audio', 'subs', 'res', 'hdr', 'codec']) {
            if (!params.has(key)) params.set(key, '');
        }
        if (!params.has('sort')) params.set('sort', $azStore.sort);
        saveBrowseSelection(browseSelectionIdentity(), params);
        replaceState(resolve('/browse?' + params.toString()), {});
    }

    function restoreCatalogUrl(incoming: URL): void {
        cancelCatalogUrlRestore();
        // Only a bare catalog visit resumes the saved selection. Any query
        // (including an unrelated query) and explicit /browse/az links own their URL.
        let pathname = incoming.pathname;
        try {
            pathname = decodeURIComponent(pathname);
        } catch {
            // A malformed path cannot be a normal catalog destination.
        }
        const saved =
            /(^|\/)browse\/?$/.test(pathname) && !incoming.search
                ? loadBrowseSelection(browseSelectionIdentity())
                : null;
        const params = saved ?? incoming.searchParams;
        const type = params.get('type');
        activeTab = type === 'movies' || type === 'series' ? type : 'all';
        searchQuery = params.get('q')?.slice(0, 100) ?? '';
        catalogGenre = params.get('genre')?.trim() || undefined;
        catalogTag = params.get('tag')?.trim() || undefined;
        catalogView = params.get('layout') === 'list' ? 'list' : 'grid';
        azStore.initFromUrl(params, {
            forceEnabled:
                isAzRoutePath(incoming.pathname) || !!searchQuery || !!catalogGenre || !!catalogTag,
        });
        if (params.get('mode') === 'discover') azStore.update((s) => ({ ...s, enabled: false }));
        catalogEpoch++;
        if (saved) {
            // The initial onMount runs before SvelteKit marks its router started.
            // Restore controls immediately; canonicalize only in the next task.
            catalogUrlRestoreTimer = setTimeout(() => {
                catalogUrlRestoreTimer = undefined;
                replaceState(resolve('/browse?' + saved.toString() + incoming.hash), {});
            }, 0);
        }
    }

    function selectBrowseMode(enabled: boolean): void {
        azStore.update((s) => ({
            ...s,
            enabled,
            mediaType: activeTab === 'movies' ? 'movie' : activeTab === 'series' ? 'tv' : 'all',
        }));
        azStore.savePreference();
        if (!enabled) {
            searchQuery = '';
            catalogGenre = undefined;
            catalogTag = undefined;
            if (loadedBrowseType !== activeTab || error) {
                void loadBrowseData();
                void loadKeywordSections();
            }
        }
        writeAzUrl();
    }

    function handleSearchInput(event: Event): void {
        searchQuery = (event.currentTarget as HTMLInputElement).value;
        if (searchQuery.trim() && !azMode) {
            azStore.update((s) => ({
                ...s,
                enabled: true,
                mediaType: activeTab === 'movies' ? 'movie' : activeTab === 'series' ? 'tv' : 'all',
            }));
        }
        if (searchQuery.trim()) azStore.update((s) => ({ ...s, selectedLetter: null }));
        writeAzUrl();
    }

    function handleContentChange(next: { genre?: string; tag?: string }): void {
        catalogGenre = next.genre;
        catalogTag = next.tag;
        azStore.update((s) => ({
            ...s,
            enabled: true,
            selectedLetter: null,
            mediaType: activeTab === 'movies' ? 'movie' : activeTab === 'series' ? 'tv' : 'all',
        }));
        writeAzUrl();
    }

    // Library selection originates in AzBrowseView; mirror it into the store
    // (so a later tab switch keeps it) and the URL. Changing library clears the
    // letter, matching AzBrowseView.
    function handleAzSelectLibrary(groupId: string | null) {
        azStore.update((s) => ({ ...s, selectedGroupId: groupId, selectedLetter: null }));
        writeAzUrl();
    }

    // Letter (or '#') selection from AzBrowseView's jump-nav rail.
    function handleAzSelectLetter(letter: string | null) {
        azStore.update((s) => ({ ...s, selectedLetter: letter }));
        writeAzUrl();
    }

    // Audio/subtitle/quality filter change from AzBrowseView's popover. Persist
    // into the store (also writes localStorage) and deep-link via the URL —
    // buildUrl() already emits audio/subs/includeUnknown + res/hdr/codec/qUnknown
    // params. The single "Include untagged" toggle drives BOTH the language and
    // quality "include untagged" flags.
    function handleAzFilters(next: {
        audioLangs: AudioFilterLang[];
        subLangs: SubtitleFilterLang[];
        includeUnknown: boolean;
        resolutions: string[];
        hdr: string[];
        codecs: string[];
    }) {
        azStore.setLanguageFilter({
            audioLangs: next.audioLangs,
            subLangs: next.subLangs,
            includeUnknown: next.includeUnknown,
        });
        azStore.setQualityFilter({
            resolutions: next.resolutions,
            hdr: next.hdr,
            codecs: next.codecs,
            qualityIncludeUnknown: next.includeUnknown,
        });
        writeAzUrl();
    }

    // Sort order change from AzBrowseView's sort dropdown. Persist into the
    // store (also writes localStorage) and deep-link via the URL — buildUrl()
    // already emits the sort param.
    function handleAzSort(sort: BrowseSort) {
        azStore.setSort(sort);
        writeAzUrl();
    }

    // The grid's item handlers live in browse-modals.ts so /browse/filter can
    // mount <AzBrowseView> with the same behaviour without importing this page.

    let azMode = $derived($azStore.enabled);
    let activeTabId = $derived(azMode ? 'tab-az' : `tab-${activeTab}`);

    // Keep activeTab — and therefore the type-scoped Recently Added row and genre
    // sections — in sync with the URL's ?type on client-side navigation (in-app
    // links, browser back/forward). onMount reads ?type only once at mount, so
    // without this an SPA nav to /browse?type=movies would keep showing the
    // previously loaded type (e.g. a mixed "all" Recently Added row on the Movies
    // tab). Tab clicks set activeTab themselves, so those are skipped here.
    // Sync activeTab from the URL's ?type on REAL navigations only — in-app links to
    // /browse?type=… and browser back/forward. Crucially NOT on the shallow replaceState
    // that handleTabChange performs for a tab click: afterNavigate never fires for
    // shallow routing. The previous $effect on $page.url fired on every tab click and
    // read a STALE url — $page (from $app/stores) does not reflect replaceState, so it
    // stayed pinned to the initial page-load ?type — and "corrected" activeTab straight
    // back to that type (the tab never switched; the content reloaded the old type).
    beforeNavigate(cancelCatalogUrlRestore);

    afterNavigate((nav) => {
        if (!browser || nav.type === 'enter') return; // 'enter' = initial mount → onMount handles it
        const previousTab = activeTab;
        if (nav.to) restoreCatalogUrl(nav.to.url);
        if (previousTab !== activeTab || (!azMode && loadedBrowseType !== activeTab)) {
            void loadBrowseData();
            void loadKeywordSections();
        }
    });

    function handleTabKeydown(e: KeyboardEvent) {
        const tabs = e.currentTarget as HTMLElement;
        const buttons = tabs.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
        if (!buttons.length) return;
        const focused = document.activeElement as HTMLButtonElement | null;
        if (!focused || focused.getAttribute('role') !== 'tab') return;

        const index = Array.from(buttons).indexOf(focused);
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            const next = buttons[(index + 1) % buttons.length];
            next.focus();
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            const prev = buttons[(index - 1 + buttons.length) % buttons.length];
            prev.focus();
        }
    }

    function handleFilterSelect(choice: {
        kind: 'tag' | 'genre';
        value: string;
        label: string;
    }): void {
        handleContentChange(
            choice.kind === 'genre'
                ? { genre: choice.value, tag: catalogTag }
                : { genre: catalogGenre, tag: choice.value },
        );
    }

    function handleTabChange(tab: MediaType) {
        // Update activeTab
        activeTab = tab;

        // Sync azMediaType when switching tabs while A-Z is active
        if (azMode) {
            // Map tab to A-Z media type: movies → movie, series → tv, all → all
            const newAzType: AzMediaType =
                tab === 'movies' ? 'movie' : tab === 'series' ? 'tv' : 'all';
            if (azMediaType !== newAzType) {
                // Clear library selection if it's no longer compatible with the new media type
                let newSelectedGroupId = azSelectedGroupId;
                if (azSelectedGroupId && newAzType !== 'all') {
                    const selectedLib = azLibraries.find((lib) => lib.id === azSelectedGroupId);
                    if (
                        selectedLib &&
                        selectedLib.mediaType !== 'mixed' &&
                        selectedLib.mediaType !== newAzType
                    ) {
                        newSelectedGroupId = null;
                    }
                }

                azStore.update((s) => ({
                    ...s,
                    mediaType: newAzType,
                    selectedGroupId: newSelectedGroupId,
                    // Switching media type resets the letter (AzBrowseView does
                    // the same internally) so a stale ?letter doesn't linger.
                    selectedLetter: null,
                }));
                // No fetch here: the new mediaType flows into AzBrowseView as a
                // prop, and its own $effect re-fetches (single fetch owner).
            }
        }

        writeAzUrl();
        if (!azMode) {
            loadBrowseData();
            loadKeywordSections();
        }
    }

    // =========================================================================
    // SectionRenderer Event Handlers
    // =========================================================================

    // Type guards for clickData discrimination
    function isKeywordBrowseItem(data: BrowseItem | KeywordBrowseItem): data is KeywordBrowseItem {
        return 'isAvailable' in data && !('imageId' in data);
    }

    /**
     * Unified item click handler for SectionRenderer
     */
    async function handleItemClick(data: { section: PageSection; item: UniversalMediaItem }) {
        const { section, item } = data;
        const originalData = item.clickData as BrowseItem | KeywordBrowseItem | undefined;

        // Handle keyword items (TMDB data)
        if (
            section.id.startsWith('keyword-') &&
            originalData &&
            isKeywordBrowseItem(originalData)
        ) {
            await handleKeywordItemClick(originalData);
            return;
        }

        // Handle Jellyfin items (browse data)
        if (originalData && 'id' in originalData) {
            await handleCardClick(originalData as BrowseItem);
            return;
        }

        // Continue Watching / Next Up sections are the canonical
        // UniversalMediaItem representation straight from the SSR loader /
        // for-you/watching API (see buildSections()) — they carry no
        // `clickData` wrapper, so route them through the same handler
        // WatchingStrip.svelte uses for the identical rows on /for-you.
        await handleWatchingItemClick(data);
    }

    /**
     * Unified item play handler for SectionRenderer
     */
    function handleItemPlay(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        // Books must not reach /watch (the video route). `getPlayableId()` returns a
        // book's id without complaint, which is how the Continue Watching ▶ used to
        // send one there. `resolveMediaPlayTarget` is the shared decision for every
        // play surface — keep it shared rather than re-deriving here.
        const target = resolveMediaPlayTarget(item);
        if (target.kind === 'audiobook') {
            // No position threaded on purpose: the player omits `positionMs` so
            // AudiobookShelf supplies its own saved progress.
            void playAudiobook(target.mediaId).then((started) => {
                if (!started) toasts.error(audiobookStartFailureMessage());
            });
            return;
        }
        if (target.kind === 'delegate') return;
        const key = buildMediaKey(item.externalIds, item.mediaType) ?? target.playbackId;
        void navigateToWatch(key);
    }

    /**
     * Hide an item from Continue Watching.
     *
     * M1 renamed the card menu to "Hide from Continue Watching" — the
     * correct primitive is the dismissals API, NOT markWatched (which
     * would lie to the event log). Shares `getCwDismissArgs` /
     * `dismissCwItem` with ForYou.svelte so the two surfaces can't drift.
     */
    async function handleItemRemove(data: { section: PageSection; item: UniversalMediaItem }) {
        const { section, item } = data;
        if (section.id !== 'continue-watching') return;

        const args = getCwDismissArgs(item);
        if (!args) {
            console.warn('[Browse] Cannot dismiss — missing target UUID', {
                itemId: item.id,
                isEp: isEpisode(item.mediaType),
            });
            return;
        }

        // Optimistic UI — drop the card immediately. Rollback if the
        // server rejects the write.
        const previousWatchingSections = watchingSections;
        watchingSections = watchingSections.map((watchingSection) =>
            watchingSection.id === 'continue-watching'
                ? {
                      ...watchingSection,
                      items: watchingSection.items.filter((candidate) => candidate.id !== item.id),
                  }
                : watchingSection,
        );

        const ok = await dismissCwItem(args);
        if (!ok) {
            console.error('[Browse] Dismissal failed');
            watchingSections = previousWatchingSections;
            toasts.error(m.browse_failed_to_hide());
            return;
        }

        toasts.success(
            m.card_hidden_until_watched_toast({ title: getCwDismissDisplayName(item) }),
            {
                timeout: 5000,
                action: {
                    label: m.card_hidden_undo(),
                    onClick: () => {
                        void undoBrowseDismiss(args.targetId, args.targetType);
                    },
                },
            },
        );
    }

    /**
     * DELETE the dismissal and reload the CW/NU sections so the
     * unhidden item comes back with correct ordering.
     */
    async function undoBrowseDismiss(
        targetId: string,
        targetType: CwDismissTargetType,
    ): Promise<void> {
        const ok = await restoreCwItem({ targetId, targetType });
        if (!ok) {
            console.error('[Browse] Undo dismiss failed');
            toasts.error(m.browse_failed_to_restore());
            return;
        }
        try {
            // loadWatchingData replaces the canonical section state.
            await loadWatchingData(true);
        } catch {
            // Non-fatal — user can reload if the refresh failed.
        }
    }

    /**
     * Handle "More/Similar" button click - opens similar movies modal
     */
    function handleItemMore(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        openSimilarForItem(item);
    }

    /**
     * Open similar movies modal for a given item
     * The modal handles fetching similar data when loading=true
     */
    function openSimilarForItem(item: UniversalMediaItem) {
        // Need valid external IDs
        if (!hasValidExternalId(item.externalIds)) return;

        // "Similar" is a TMDB query, so the item must HAVE a TMDB namespace.
        // This used to be `isSeries || isEpisode ? 'tv' : 'movie'`, which asked
        // TMDB for movies similar to an audiobook. Series/episodes fold onto
        // 'tv' exactly as before; a null means TMDB has no such entity, so there
        // is nothing to show.
        const mediaType = toTmdbType(item.mediaType);
        if (mediaType === null) return;

        // Open modal with loading state - modal handles fetching
        openSimilarMoviesModal(
            {
                externalIds: item.externalIds,
                name: item.title,
                mediaType,
            },
            [],
            true,
        );
    }

    async function handleCardClick(item: BrowseItem) {
        // Determine media type - episodes show as episode to trigger season display.
        // `isEpisode` is an independent wire flag and wins (the item's `type` may
        // name the parent series). Everything else goes through the domain
        // module's exhaustive table: this used to be `let mediaType = 'movie'`
        // with an if/else chain that only recognised episode/series/channel, so an
        // audiobook opened the MOVIE modal.
        const mediaType = item.isEpisode === true ? 'episode' : toUniversalMediaType(item.type);
        // No universal type ⇒ no card was rendered for it either (see
        // transformJellyfinItems), so there is nothing to open.
        if (mediaType === null) return;

        const externalIds = {
            ...item.externalIds,
            internal:
                getExternalIdFor(item.externalIds, 'internal') ??
                asInternalUuid(item.imageId || item.id),
        };
        // Only consulted for the TMDB composite-key fallback inside imageFromIds;
        // browse items always carry an internal id, which wins. `null`
        // (audiobook, channel, music) means "no TMDB namespace" — pass the
        // default rather than asserting a wrong one.
        const imageMediaType = toTmdbType(mediaType) ?? undefined;
        const imageUrl =
            imageFromIds(externalIds, 'poster', imageMediaType, {
                size: 'card',
            }) || '';

        // Base media data
        let mediaData: Record<string, unknown> = {
            externalIds: { internal: asInternalUuid(item.id), ...item.externalIds },
            mediaType: mediaType,
            title: item.name,
            overview: item.overview,
            rating: item.communityRating || 0,
            year: item.year,
            isAvailable: true,
            availabilitySource: 'lumastra',
            genres: item.genres,
            // Episode-specific data for showing series seasons
            seriesInternalId: item.seriesId,
            seriesExternalIds: item.seriesExternalIds,
            seriesName: item.seriesName,
            seasonNumber: item.seasonNumber,
            episodeNumber: item.episodeNumber,
        };

        // Fetch additional ratings from media-details API if we have external IDs.
        // `mediaType as ApiMediaType` was a lie for anything outside
        // {movie, series, episode, season} — buildMediaKey would mint a token no
        // route parses. toApiMediaType() returns null instead; audiobooks are
        // addressed by UUID and simply skip the extra-ratings fetch.
        const apiMediaType = toApiMediaType(mediaType);
        if (apiMediaType && hasValidExternalId(item.externalIds)) {
            const key = buildMediaKey(item.externalIds, apiMediaType);
            if (key) {
                const details = await fetchMediaDetailsWithKey(key);
                mediaData = { ...mediaData, ...details };
            }
        }

        openMediaModal(mediaData, imageUrl);
    }

    function clearSearch() {
        searchQuery = '';
        writeAzUrl();
    }

    async function handleKeywordItemClick(item: KeywordBrowseItem) {
        // Keyword items come from TMDB with different structure. `?? 'movie'` is
        // unreachable here, and schema-enforced rather than asserted:
        // `KeywordBrowseItemSchema` (src/lib/schemas/api-browse-responses.ts:158)
        // declares `type: z.enum(['movie', 'series'])` — required, two members —
        // and the payload is validated against `BrowseKeywordsResponseSchema`
        // before it reaches this handler ($lib/api/browse.ts:48). Same note as in
        // $lib/components/browse/browse-modals.ts.
        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- validated keyword items are movie/series only.
        const mediaType = toTmdbType(item.type) ?? 'movie';
        const apiMediaType = mediaType;
        const externalIds = item.externalIds;
        const imageUrl = imageFromIds(externalIds, 'poster', apiMediaType, { size: 'card' }) || '';

        // Base media data from TMDB
        let mediaData: Record<string, unknown> = {
            externalIds,
            mediaType,
            title: item.name,
            overview: item.overview,
            rating: item.rating || 0,
            year: item.year,
            isAvailable: item.isAvailable,
            availabilitySource: item.isAvailable ? 'lumastra' : 'tmdb',
            canRequest: !item.isAvailable,
        };

        // Fetch additional ratings if we have valid external IDs
        if (hasValidExternalId(externalIds)) {
            const key = buildMediaKey(externalIds, apiMediaType) as MediaKey;
            if (key) {
                const details = await fetchMediaDetailsWithKey(key);
                mediaData = { ...mediaData, ...details };
            }
        }

        openMediaModal(mediaData, imageUrl);
    }

    // Get browse config from page data (with defaults)
    let browseConfig = $derived({
        searchDebounceMs: $page.data.browse?.searchDebounceMs ?? 200,
        azPageSize: $page.data.browse?.azPageSize ?? 50,
        keywordsInitial: $page.data.browse?.keywordsInitial ?? 5,
        keywordsPageSize: $page.data.browse?.keywordsPageSize ?? 5,
        scrollMargin: $page.data.browse?.scrollMargin ?? '400px',
    });
    // Feature flags for request permission
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    // Reactive bindings to store state (for template compatibility)
    // A-Z reactive bindings actually consumed by the template / tab-switch logic.
    // (items/totalCount/hasMore/loading/librariesLoading are owned + rendered by
    // AzBrowseView, so the page does not mirror them.)
    let azMediaType = $derived($azStore.mediaType);
    let azSelectedGroupId = $derived($azStore.selectedGroupId);
    let azSelectedLetter = $derived($azStore.selectedLetter);
    let azLibraries = $derived($azStore.libraries);
    // Bumped by the AzBrowseView `{:catch}` retry button to re-run the
    // `{#await}` block below: referencing this inside importAzBrowseView()
    // makes that call a reactive dependency, so incrementing it re-invokes
    // `import(...)` (a fresh attempt at the chunk) instead of replaying the
    // same rejected promise.
    let azImportAttempt = $state(0);
    function importAzBrowseView() {
        void azImportAttempt;
        return import('$lib/components/browse/AzBrowseView.svelte');
    }
    // Filter genres for display (used when not in search mode for channels)
    let filteredGenres = $derived(genres);

    // Check if all dynamic content is exhausted (no more keywords to load)
    let allContentExhausted = $derived(
        !hasMoreKeywords && !loadingMoreKeywords && keywordSections.length > 0 && !loadingKeywords,
    );
    // Reactive: observe the popular stats sentinel when conditions are met
    $effect(() => {
        if (
            browser &&
            popularStatsSentinel &&
            popularStatsObserver &&
            activeTab === 'all' &&
            allContentExhausted
        ) {
            popularStatsObserver.observe(popularStatsSentinel);
        }
    });
    // Reactively observe the sentinel whenever it changes
    $effect(() => {
        if (browser && keywordSentinel && keywordObserver) {
            // Only observe if this is a new sentinel (check without making it reactive)
            if (keywordSentinel !== lastObservedSentinel) {
                keywordObserver.observe(keywordSentinel);
                lastObservedSentinel = keywordSentinel;
            }
        }
    });
</script>

<svelte:head>
    <title>{m.page_browse()} - {data?.branding?.appName || (m.nav_dashboard() as string)}</title>
</svelte:head>

<div class="browse-page z-40 relative">
    <!-- Condense sentinel: absolutely positioned at the top of the page,
         CONDENSE_SCROLL_THRESHOLD tall; the header condenses while it is
         scrolled out of view (see onMount observer). -->
    <div
        bind:this={condenseSentinelRef}
        class="pointer-events-none absolute left-0 top-0 w-px"
        style={`height: ${CONDENSE_SCROLL_THRESHOLD}px;`}
        aria-hidden="true">
    </div>
    <div class="container mx-auto p-4 sm:p-8">
        <!-- Header -->
        <header class="browse-header" class:condensed={scrolled} bind:this={headerRef}>
            <div class="header-content">
                <a href={resolve('/')} class="back-link">
                    <Icon src={ArrowLeft} class="h-5 w-5" />
                    <span>{m.nav_back()}</span>
                </a>

                <div class="browse-title-block">
                    <h1 class="page-title">{m.page_browse()}</h1>
                </div>

                <!-- Search bar - instant filtering -->
                <div class="search-form">
                    <span class="search-icon">
                        <Icon src={MagnifyingGlass} class="h-5 w-5" />
                    </span>
                    <input
                        type="text"
                        placeholder={m.catalog_search()}
                        aria-label={m.catalog_search()}
                        maxlength="100"
                        oninput={handleSearchInput}
                        value={searchQuery}
                        bind:this={searchInputRef}
                        class="search-input" />
                    {#if searchQuery}
                        <button
                            class="clear-search"
                            onclick={clearSearch}
                            type="button"
                            aria-label={m.btn_clear_search()}>
                            ✕
                        </button>
                    {/if}
                </div>
            </div>

            <div class="browse-navigation">
                <nav class="browse-modes" aria-label={m.page_browse()}>
                    <button
                        type="button"
                        aria-pressed={!azMode}
                        onclick={() => selectBrowseMode(false)}>{m.catalog_discover()}</button>
                    <button
                        type="button"
                        id="tab-az"
                        aria-pressed={azMode}
                        onclick={() => selectBrowseMode(true)}
                        ><Icon
                            src={Bars3BottomLeft}
                            class="h-4 w-4" />{m.catalog_library()}</button>
                </nav>
                <!-- Content type is independent of the browsing mode. -->
                <div class="tabs" role="tablist" tabindex="-1" onkeydown={handleTabKeydown}>
                    <button
                        id="tab-all"
                        role="tab"
                        aria-selected={activeTab === 'all'}
                        class="tab {activeTab === 'all' ? 'active' : ''}"
                        onclick={() => handleTabChange('all')}>
                        {m.tab_all()}
                    </button>
                    <button
                        id="tab-movies"
                        role="tab"
                        aria-selected={activeTab === 'movies'}
                        class="tab {activeTab === 'movies' ? 'active' : ''}"
                        onclick={() => handleTabChange('movies')}>
                        <Icon src={Film} class="h-4 w-4" />
                        {m.tab_movies()}
                    </button>
                    <button
                        id="tab-series"
                        role="tab"
                        aria-selected={activeTab === 'series'}
                        class="tab {activeTab === 'series' ? 'active' : ''}"
                        onclick={() => handleTabChange('series')}>
                        <Icon src={Tv} class="h-4 w-4" />
                        {m.tab_series()}
                    </button>
                </div>
            </div>
            <!-- Tag/genre filter search + destination chips (rails mode only;
                 hidden while searching or in A-Z mode). The search icon is a
                 sibling of the chips nav — never nested inside it — so it stays
                 reachable even when the nav's own horizontal scroll
                 (use:dragScroll) carries the chips out of view. It must render
                 even before any chip exists (early page load), so only the nav
                 itself is gated on destinationChips.length.

                 Chips are real links, not buttons: each opens a full grid, so
                 it gets the platform's link behaviour (history entry, Back,
                 open-in-new-tab on modifier click) for free. -->
            {#if !azMode}
                <div class="chip-row">
                    <BrowseFilterSearch mediaType={activeTab} onselect={handleFilterSelect} />
                    {#if destinationChips.length > 0}
                        <nav
                            class="section-chips"
                            aria-label={m.browse_chips_nav_aria()}
                            use:dragScroll={{ scrollSpeed: 1 }}>
                            {#each destinationChips as chip (chip.key)}
                                <a
                                    href={resolve(chip.href)}
                                    class="section-chip"
                                    data-drag-scroll-allow>
                                    {chip.label}
                                </a>
                            {/each}
                        </nav>
                    {/if}
                </div>
            {/if}
        </header>

        <!-- Content -->
        <div class="browse-content" role="tabpanel" aria-labelledby={activeTabId}>
            <!-- The header/tabs above stay mounted; content below shows per-section
                 skeletons while `loading` (buildSections emits skeleton carousels),
                 so a tab switch never blanks the whole region to one spinner. -->
            {#if error && !azMode}
                <div class="error-state">
                    <p>{error}</p>
                    <button class="btn variant-filled-primary" onclick={loadBrowseData}>
                        {m.btn_retry()}
                    </button>
                </div>
            {:else}
                {#if azMode}
                    {#await importAzBrowseView()}
                        <div class="az-lazy-pending" aria-hidden="true">
                            <div class="loading-spinner"></div>
                        </div>
                    {:then { default: AzBrowseView }}
                        {#key catalogEpoch}
                            <AzBrowseView
                                bind:this={catalogHandle}
                                {restoreCount}
                                onRestored={restoreCatalogPosition}
                                query={searchQuery}
                                onClearSearch={clearSearch}
                                genre={catalogGenre}
                                tag={catalogTag}
                                onContentChange={handleContentChange}
                                initialView={catalogView}
                                onViewChange={(next) => {
                                    catalogView = next;
                                    writeAzUrl();
                                }}
                                mediaType={azMediaType}
                                selectedGroupId={azSelectedGroupId}
                                initialLetter={azSelectedLetter}
                                {hasRequestPermission}
                                pageSize={browseConfig.azPageSize}
                                scrollMargin={browseConfig.scrollMargin}
                                onitemClick={openDetailForGridItem}
                                onitemPlay={playGridItem}
                                onitemMore={openSimilarForItem}
                                onSelectLibrary={handleAzSelectLibrary}
                                onSelectLetter={handleAzSelectLetter}
                                audioLangs={$azStore.audioLangs}
                                subLangs={$azStore.subLangs}
                                includeUnknown={$azStore.includeUnknown}
                                qualityIncludeUnknown={$azStore.qualityIncludeUnknown}
                                sort={$azStore.sort}
                                resolutions={$azStore.resolutions as ResolutionTier[]}
                                hdr={$azStore.hdr as HdrTier[]}
                                codecs={$azStore.codecs as CodecTier[]}
                                onFilterChange={handleAzFilters}
                                onSortChange={handleAzSort}
                                showLetterRail="always" />
                        {/key}
                    {:catch}
                        <div class="az-lazy-error">
                            <p>{m.browse_az_load_failed()}</p>
                            <button
                                class="btn variant-filled-primary btn-sm"
                                onclick={() => azImportAttempt++}>
                                {m.btn_retry()}
                            </button>
                        </div>
                    {/await}

                    <!-- Normal Browse Mode -->
                {:else}
                    <!-- Recently Added with filters. Shown on every tab: the
                         page already fetches type-scoped recentlyAdded for
                         movies/series, and the genre/keyword sections below are
                         frequently empty for those tabs (genres are always [],
                         keyword tags are movie-centric and library-local), which
                         would otherwise leave the Movies/Series tabs blank even
                         when locally-available titles exist. -->
                    <div>
                        <RecentlyAddedSection
                            initialItems={recentlyAdded}
                            type={activeTab}
                            viewAllHref={recentBrowseHref(activeTab)}
                            {hasRequestPermission}
                            onitemClick={handleItemClick}
                            onitemPlay={handleItemPlay}
                            onitemMore={handleItemMore} />
                    </div>

                    <!-- Main Content via SectionRenderer.
                         priorityCount=6 on the first section eagerly loads +
                         fetch-prioritizes its above-the-fold poster row (LCP).

                         Rows beyond the first 3 are below the fold on every
                         reasonable viewport (continue-watching + up to two
                         genre/keyword carousels comfortably fill it), so they
                         are deferred behind LazyMount: SSR still emits a
                         height-reserved placeholder for them (no layout
                         shift), and the real row mounts once it nears the
                         viewport. This is what cuts ~280 eagerly-mounted cards
                         down to only the ones actually shown at load. The
                         first 3 stay eager to preserve Task 6's SSR-seeded
                         first-paint win. -->
                    <div class="space-y-8">
                        {#each sections as section, index (section.id)}
                            {#if index < 3}
                                {@render sectionRow(section, index)}
                            {:else}
                                <!-- minHeight: measured from a real genre-row's CSS —
                                     poster card (w-32 => 128px, aspect-[2/3] => 192px
                                     image) + title (text-sm/20px line-height + mt-1
                                     4px) + subtitle (text-xs/16px line-height) = 232px
                                     card, +pb-4 (16px) on the carousel track = 248px,
                                     +the row's h2 header (text-lg/28px) and the
                                     section's space-y-4 gap (16px) above the track =
                                     292px total. Rounded up to 300px for safety. -->
                                <LazyMount minHeight="300px">
                                    {@render sectionRow(section, index)}
                                </LazyMount>
                            {/if}
                        {/each}
                    </div>

                    {#snippet sectionRow(section: PageSection, index: number)}
                        <div>
                            <SectionRenderer
                                {section}
                                {hasRequestPermission}
                                priorityCount={index === 0 ? 6 : 0}
                                onitemClick={handleItemClick}
                                onitemPlay={handleItemPlay}
                                onitemRemove={handleItemRemove}
                                onitemMore={handleItemMore} />
                        </div>
                    {/snippet}

                    <!-- Keyword Sections Divider -->
                    {#if keywordSections.length > 0 || loadingKeywords}
                        <div class="keyword-sections-divider">
                            <span>{m.browse_discover_by_theme()}</span>
                        </div>
                    {/if}

                    {#if loadingKeywords && keywordSections.length === 0}
                        <div class="flex gap-3 overflow-hidden py-4">
                            {#each Array(5) as _, i (i)}
                                <div class="w-32 shrink-0 space-y-2">
                                    <Skeleton width="w-full" height="h-48" rounded="md" />
                                    <Skeleton width="w-3/4" height="h-4" rounded="md" />
                                    <Skeleton width="w-1/2" height="h-3" rounded="md" />
                                </div>
                            {/each}
                        </div>
                    {/if}

                    <!-- Keyword infinite scroll sentinel -->
                    {#if hasMoreKeywords || loadingMoreKeywords}
                        <div bind:this={keywordSentinel} class="keyword-load-more">
                            {#if loadingMoreKeywords}
                                <div class="loading-spinner small"></div>
                                <span>{m.loading_more_themes()}</span>
                            {:else}
                                <button class="load-more-btn" onclick={loadMoreKeywords}>
                                    {m.browse_load_more_themes()}
                                </button>
                            {/if}
                        </div>
                    {/if}

                    <!-- Global watch stats require admin; skip doomed requests for other viewers. -->
                    {#if activeTab === 'all' && allContentExhausted && $page.data.user?.isAdmin}
                        <div bind:this={popularStatsSentinel} class="popular-stats-sentinel">
                            <PopularMediaStats bind:this={popularStatsComponent} />
                        </div>
                    {/if}

                    <!-- Empty State. recentlyAdded is rendered by
                         RecentlyAddedSection (above) on every tab, so the page is
                         only truly empty when that list is empty too — otherwise
                         "No content found" would show beneath a populated
                         Recently Added carousel on the Movies/Series tabs. -->
                    {#if sections.length === 0 && recentlyAdded.length === 0 && !loadingKeywords}
                        <div class="empty-state">
                            <p>{m.browse_no_content()}</p>
                        </div>
                    {/if}
                {/if}
            {/if}
        </div>
    </div>
    <div style={`height: ${condenseSlack}px;`} aria-hidden="true"></div>
</div>

<style lang="postcss">
    .browse-title-block {
        flex: 1;
    }
    .browse-modes {
        display: flex;
        gap: 1.5rem;
        margin-top: 0;
    }
    .browse-modes button {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        min-height: 44px;
        color: var(--color-surface-400);
        border-bottom: 2px solid transparent;
        cursor: pointer;
    }
    .browse-modes button[aria-pressed='true'] {
        color: var(--color-surface-100);
        border-color: var(--color-primary-400);
    }
    .browse-modes button:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: 3px;
    }
    .browse-navigation {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem 2rem;
        flex-wrap: wrap;
        margin-top: 0.625rem;
        border-bottom: 1px solid #ffffff08;
    }
    .browse-navigation .tabs {
        padding: 0;
    }
    .browse-header.condensed .browse-navigation {
        margin-top: 0;
    }
    .browse-header.condensed .browse-title-block {
        display: none;
    }
    .browse-header.condensed .browse-modes {
        margin-top: 0.25rem;
    }

    .browse-page {
        min-height: 100vh;
        padding-top: 5rem;
        /* The sticky header is in flow, so condensing it shrinks the page and
           scroll anchoring then scrolls back up by the same amount. That puts
           the condense sentinel back in view, the header expands, and the loop
           repeats: slow scrolling near the threshold flickers and jumps up.
           Opt the page out of anchoring so condensing never moves scrollTop. */
        overflow-anchor: none;
    }

    .browse-header {
        position: sticky;
        /* Mobile (<1024px) navbar scrolls off with the document, so the sticky
           header should pin flush with the viewport top. Desktop navbar stays
           fixed at the top, so offset by its height (4rem). */
        top: 0;
        z-index: 20;
        /* Near-opaque: section headings scroll under this bar, and at 0.8-0.9
           alpha they stayed half-legible through the blur, which read as a
           rendering glitch rather than an intentional pass-under. */
        background: linear-gradient(
            to bottom,
            rgb(var(--color-surface-900-rgb) / 0.97) 0%,
            rgb(var(--color-surface-900-rgb) / 0.92) 100%
        );
        backdrop-filter: blur(16px);
        padding: 0.75rem 0;
        margin: 0 -1rem;
        padding-left: 1rem;
        padding-right: 1rem;
        border-radius: 1rem;
        margin-bottom: 1.5rem;
        /* Smoothly animate the condense-on-scroll transition (fix 2). Only
           padding is transitioned on the header itself; children fade/collapse
           via their own transitions to avoid layout thrash. */
        transition: padding 0.2s ease;
    }

    /* Condensed sticky header: triggered past CONDENSE_SCROLL_THRESHOLD of
       scroll. Trims vertical padding, drops the page title + back link, and
       tightens the tab/chip rows so the essential controls (search, tabs, A-Z,
       chips) stay pinned in a compact band. */
    .browse-header.condensed {
        padding-top: 0.4rem;
        padding-bottom: 0.4rem;
    }

    .browse-header.condensed .page-title,
    .browse-header.condensed .back-link {
        display: none;
    }

    .browse-header.condensed .tabs {
        padding-top: 0.5rem;
    }

    .browse-header.condensed .chip-row {
        padding-top: 0.5rem;
    }

    /* Desktop: collapse the condensed header into a single inline row so
       search + tabs + A-Z sit side by side. Chips wrap onto their own line. */
    @media (min-width: 1024px) {
        .browse-header.condensed {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            column-gap: 1rem;
        }

        .browse-header.condensed .header-content {
            flex: 1 1 auto;
            order: 1;
        }

        .browse-header.condensed .tabs {
            order: 2;
            width: auto;
            padding-top: 0;
        }

        .browse-header.condensed .chip-row {
            order: 3;
            flex-basis: 100%;
        }
    }

    @media (min-width: 640px) {
        .browse-header {
            margin: 0 -2rem;
            padding-left: 2rem;
            padding-right: 2rem;
        }
    }

    @media (min-width: 1024px) {
        .browse-header {
            top: 4rem;
        }
    }

    .header-content {
        display: flex;
        align-items: center;
        gap: 1rem;
    }

    .back-link {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--color-surface-300);
        text-decoration: none;
        padding: 0.5rem;
        border-radius: 0.5rem;
        transition: all 0.2s ease;
    }

    .back-link:hover {
        color: var(--color-surface-100);
        background: rgb(var(--color-surface-700-rgb) / 0.5);
    }

    .page-title {
        font-size: 1.25rem;
        font-weight: 700;
        color: var(--color-surface-100);
        margin: 0;
    }

    .search-form {
        flex: 1;
        max-width: 400px;
        position: relative;
        margin-left: auto;
    }

    .search-icon {
        position: absolute;
        left: 0.75rem;
        top: 50%;
        transform: translateY(-50%);
        color: var(--color-surface-400);
        pointer-events: none;
    }

    .search-input {
        width: 100%;
        padding: 0.5rem 2rem 0.5rem 2.5rem;
        border-radius: 999px;
        min-height: 44px;
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-100);
        font-size: 0.875rem;
        transition: all 0.2s ease;
    }

    .search-input::placeholder {
        color: var(--color-surface-400);
    }

    .search-input:focus {
        outline: none;
        background: var(--color-surface-700);
        border-color: rgb(var(--color-primary-500-rgb) / 0.5);
    }

    .clear-search {
        position: absolute;
        right: 0.75rem;
        top: 50%;
        transform: translateY(-50%);
        background: var(--color-surface-600);
        border: none;
        color: var(--color-surface-300);
        width: 20px;
        height: 20px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.75rem;
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .clear-search:hover {
        background: var(--color-surface-500);
        color: var(--color-surface-100);
    }

    .tabs {
        display: flex;
        gap: 0.5rem;
        padding: 1rem 0 0;
        overflow-x: auto;
        scrollbar-width: none;
    }

    .tabs::-webkit-scrollbar {
        display: none;
    }

    .tab {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0.875rem;
        min-height: 40px;
        border-radius: 999px;
        background: transparent;
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.35);
        color: var(--color-surface-300);
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
    }

    .tab:hover {
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        color: var(--color-surface-100);
    }

    .tab.active {
        background: var(--color-primary-600);
        border-color: var(--color-primary-500);
        color: white;
    }

    .tab:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .tab:disabled:hover {
        background: transparent;
        color: var(--color-surface-300);
    }

    /* A-Z Mode Toggle */

    /* Wraps the filter search icon and the section-chips nav as siblings, so
       the icon stays pinned outside the nav's own horizontal scroll. */
    .chip-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
        padding: 0.75rem 0 0;
    }

    /* Destination chips (Recently Added + genres) — pill row, horizontally
       scrollable, styled to match the .tab pills above. */
    .section-chips {
        display: flex;
        gap: 0.5rem;
        overflow-x: auto;
        scrollbar-width: none;
        flex: 1;
        min-width: 0;
    }

    .section-chips::-webkit-scrollbar {
        display: none;
    }

    .section-chip {
        flex-shrink: 0;
        padding: 0.375rem 0.875rem;
        border-radius: 2rem;
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-300);
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        text-decoration: none;
        transition: all 0.15s ease;
    }

    .section-chip:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.6);
        color: var(--color-surface-100);
    }

    .section-chip:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: 2px;
    }

    /* A-Z Browse Mode styles now in AzBrowseView.svelte component */

    .browse-content {
        padding: 1rem 0;
    }

    .error-state,
    .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 50vh;
        gap: 1rem;
        color: var(--color-surface-400);
    }

    /* Pending/failed states for AzBrowseView's dynamic import. min-height
       reserves roughly the space AzBrowseView occupies once loaded, so
       switching into A-Z mode doesn't collapse the content region to zero
       height while the chunk is in flight. */
    .az-lazy-pending {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 30vh;
    }

    .az-lazy-error {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 30vh;
        gap: 0.75rem;
        color: var(--color-surface-400);
        text-align: center;
    }

    .loading-spinner {
        width: 48px;
        height: 48px;
        border: 3px solid var(--color-surface-600);
        border-top-color: var(--color-primary-500);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    .loading-spinner.small {
        width: 24px;
        height: 24px;
        border-width: 2px;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .keyword-sections-divider {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin: 2rem 1rem 1.5rem;
        color: var(--color-surface-300);
        font-size: 0.875rem;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .keyword-sections-divider::before,
    .keyword-sections-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: linear-gradient(to right, transparent, var(--color-surface-600), transparent);
    }

    .keyword-load-more {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 2rem;
        color: var(--color-surface-400);
        font-size: 0.875rem;
    }

    .load-more-btn {
        padding: 0.75rem 2rem;
        background: var(--color-surface-700);
        border: 1px solid var(--color-surface-600);
        border-radius: 2rem;
        color: var(--color-surface-200);
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
    }

    .load-more-btn:hover {
        background: var(--color-surface-600);
        color: var(--color-surface-50);
    }

    .popular-stats-sentinel {
        margin-top: 2rem;
        padding-bottom: 2rem;
    }

    /* Mobile responsive */
    @media (max-width: 640px) {
        .header-content {
            flex-wrap: wrap;
        }

        .page-title {
            font-size: 1.25rem;
        }

        .search-form {
            order: 3;
            flex: 0 0 100%;
            max-width: none;
            margin-left: 0;
            margin-top: 0.5rem;
        }

        .tabs {
            padding: 0.75rem 0 0;
        }

        .tab {
            padding: 0.375rem 0.75rem;
            font-size: 0.75rem;
        }
    }
</style>
