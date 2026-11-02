<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	Search.svelte

	Full-screen search modal with unified search across all media types.
	Uses Server-Driven UI architecture with SectionRenderer.

	@example
	<Search bind:isOpen onclose={handleClose} />

	@example Watch Party Mode
	<Search bind:isOpen watchPartyMode onselectitem={handleSelect} />
-->
<script module lang="ts">
    import { SvelteSet, SvelteMap } from 'svelte/reactivity';
    import type { PlaylistAddItem, PlaylistAddOutcome } from '$lib/types/playlist';
    import type { AvailableCategories } from '$lib/types/search';

    import { stopPropagation } from '$lib/utils/event-helpers';

    // Cache duration in milliseconds (5 minutes)
    const CACHE_DURATION_MS = 5 * 60 * 1000;

    // Module-level cache for available categories (persists across component instances)
    let availableCategoriesCache: AvailableCategories | null = null;
    let availableCategoriesCacheTime = 0;
    let availableCategoriesLoading = false;
</script>

<script lang="ts">
    import { pickVariant } from '$lib/utils/image-utils.js';
    import './components/player/player-presentation.css';
    import { Z } from '$lib/utils/z-index';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { onMount, onDestroy, tick, untrack } from 'svelte';
    import { browser } from '$app/environment';
    import { base } from '$app/paths';
    import { beforeNavigate } from '$app/navigation';
    import { Icon } from 'svelte-hero-icons';
    import { modals, hasModals } from '$lib/stores/modal.store';
    import { registerSearchOverlay } from '$lib/stores/search-overlay.store';
    import { getModalComponent } from '$lib/stores/modal-registry.store';
    import { fade, fly } from 'svelte/transition';
    import { SectionRenderer } from '$lib/components/sections';
    import { SeriesEpisodePicker } from '$lib/components/media';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import type { SeriesSearchItem, CategoryConfig } from '$lib/types/search';
    import type { SearchResultItem as V1SearchResultItem } from '$lib/api/content';
    import { getEpisodeKey } from '$lib/utils/media-types';
    import { isMovie, isSeries, isEpisode } from '$lib/shared/media-types';
    import { toTmdbMediaType } from '$lib/shared/media-type-domain';
    import {
        buildMediaKey,
        hasValidExternalId,
        getPlayableId,
        createRenderableMediaKeys,
    } from '$lib/utils/media-id-helpers';
    import type { ApiMediaType, ExternalIds } from '$lib/types/api-common';
    import { navigateTo } from '$lib/paths';
    import { page } from '$app/stores';
    import { saveReturnPath, isNavigatingToPlayer } from '$lib/stores/playerNavigation';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';
    import * as contentApi from '$lib/api/content';
    import * as userApi from '$lib/api/user';
    import * as aiApi from '$lib/api/ai';
    import {
        watchlistItems,
        addToWatchlistStore,
        removeFromWatchlistStore,
        type WatchlistItem,
    } from '$lib/stores/watchlist';

    // Extracted utilities
    import { parseSearchOperators, type SearchOperators } from '$lib/utils/search/query-parser';
    import {
        transformSearchItem,
        buildSubtitle,
        highlightSearchTerms,
    } from '$lib/utils/search/transformers';
    import { shouldPerformSearch as shouldPerformSearchUtil } from '$lib/utils/search/search-helpers';
    import { openKavitaItem } from '$lib/utils/search/media-external-links';
    // item-open-handlers: dispatch map — each media type maps to one handler function (ref: DL-005).
    // Adding a new media type requires only one new exported function + one map entry.
    import {
        getItemOpenHandler,
        handleAudiobookOpen,
        type ItemOpenHelpers,
    } from '$lib/utils/search/item-open-handlers';
    // search-execution: parallel API call logic, URL building, stale-result detection (ref: DL-006).
    // Search.svelte retains version tracking, loading state, and result merging.
    import {
        executeSearchGroups,
        fetchSearchGroupPage,
        type SearchGroupResult,
    } from '$lib/utils/search/search-execution';
    import {
        getSearchCategories,
        getSearchCategory,
        getCategoryIcon,
        getPlaybackMediaType,
        categoryHasSimilar,
    } from '$lib/constants/search-categories';

    // Extracted UI components
    import SearchHeader from '$lib/components/search/SearchHeader.svelte';
    import SearchFilterBar from '$lib/components/search/SearchFilterBar.svelte';
    import SearchOperatorsBar from '$lib/components/search/SearchOperatorsBar.svelte';
    import SearchEmptyState from '$lib/components/search/SearchEmptyState.svelte';
    import {
        getRecentSearches,
        addRecentSearch,
        clearRecentSearches,
    } from '$lib/utils/search/recent-searches';
    import {
        CATEGORY_FILTERS_URL_PARAM,
        formatCategoryFiltersParam,
        getCategoryFilters,
        parseCategoryFiltersParam,
        saveCategoryFilters,
    } from '$lib/utils/search/category-filters';
    import SearchLoadingState from '$lib/components/search/SearchLoadingState.svelte';
    import SearchNoResults from '$lib/components/search/SearchNoResults.svelte';
    import SearchResultRow from '$lib/components/search/SearchResultRow.svelte';
    import { createMusicItemHandlers } from '$lib/utils/music-item-handlers.svelte';

    import SearchTips from '$lib/components/search/SearchTips.svelte';
    import ProgramSearchResults from '$lib/components/livetv/ProgramSearchResults.svelte';
    import { searchPrograms, groupProgramAirings } from '$lib/api/livetv-playback';
    import type { GroupedProgramSearchResult } from '$lib/schemas/livetv';

    const musicItemHandlers = createMusicItemHandlers();

    // =========================================================================
    // Constants
    // =========================================================================

    /** Search results limit per category */
    const SEARCH_RESULTS_LIMIT = 20;

    /** Delay before focusing search input (ms) */
    const FOCUS_DELAY_MS = 50;

    // =========================================================================
    // Props

    interface Props {
        // =========================================================================
        playerMode?: boolean;
        isOpen?: boolean;
        /** Watch party mode - dispatches events instead of navigating directly */
        watchPartyMode?: boolean;
        /** Playlist mode - dispatches addToPlaylist events for adding items to a playlist */
        playlistMode?: boolean;
        playlistId?: number;
        /** Restrict search to specific types (e.g. 'music' for music-only playlists). Overrides default search groups. */
        restrictToTypes?: string;
        /** Existing playlist items - used in playlist mode to show "Added" for items already in playlist */
        existingPlaylistItems?: Array<{
            externalIds: ExternalIds;
            seriesExternalIds?: ExternalIds;
            seriesName?: string;
            mediaType: string;
            seasonNumber?: number;
            episodeNumber?: number;
        }>;
        /** Search debounce delay in milliseconds */
        debounceMs?: number;
        /** Sync search query to URL (?q=term) - enables shareable search links */
        syncToUrl?: boolean;
        /** Callback when search is closed */
        onclose?: () => void;
        /** Callback when item is selected */
        onselectitem?: (data: {
            itemId: string;
            title: string;
            mediaType: 'movie' | 'episode' | 'tv' | 'tvchannel';
        }) => void;
        /** Callback when item is added to playlist */
        onaddToPlaylist?: (data: PlaylistAddItem) => Promise<PlaylistAddOutcome>;
    }

    let {
        playerMode = false,
        isOpen = $bindable(false),
        watchPartyMode = false,
        playlistMode = false,
        playlistId,
        restrictToTypes,
        existingPlaylistItems = [],
        debounceMs = 150,
        syncToUrl = false,
        onclose,
        onselectitem,
        onaddToPlaylist,
    }: Props = $props();

    // =========================================================================
    // State
    // =========================================================================

    let searchQuery = $state('');
    let groupedResults: Record<string, V1SearchResultItem[]> = $state({});
    let isLoading = $state(false);
    let searchTimeout: ReturnType<typeof setTimeout>;
    let searchInput: HTMLInputElement | undefined = $state();
    let selectedIndex = $state(-1);
    // Tracks which categories have received fresh results in the current search cycle.
    // Used to replace stale category data on first arrival rather than appending.
    let refreshedCategoriesRef: SvelteSet<string> | null = null;

    // Program search (separate parallel path — independent from standard search)
    let programSearchResults: GroupedProgramSearchResult[] = $state([]);
    let programSearchLoading = $state(false);

    // 60-second auto-refresh for program search results (AC #6, #7)
    let programRefreshActive = $state(false);
    let programRefreshQuery = '';
    let programRefreshInterval: ReturnType<typeof setInterval> | null = null;

    // Fulltext search mode (searches descriptions too)
    // Only the missing-preference default changes; existing choices are retained.
    let fulltextMode = $state(false);
    let fulltextPreferenceLoaded = false;
    let descriptionLoading = $state(false);
    let searchFailed = $state(false);
    let descriptionTimeout: ReturnType<typeof setTimeout> | undefined;
    let descriptionAbortController: AbortController | null = null;
    let descriptionVersion = 0;
    let baseResults: Record<string, V1SearchResultItem[]> = {};
    let descriptionResults: Record<string, V1SearchResultItem[]> = {};
    let baseHasMore: Record<string, boolean> = {};
    let descriptionHasMore: Record<string, boolean> = {};
    let descriptionOffsets: Record<string, number> = {};
    let preferenceSave: Promise<void> = Promise.resolve();
    const DESCRIPTION_CATEGORIES = new Set(['movie', 'tv', 'episode', 'audiobook']);

    function cancelDescriptionSearch(): void {
        clearTimeout(descriptionTimeout);
        descriptionVersion++;
        descriptionAbortController?.abort();
        descriptionLoading = false;
    }

    function resetDescriptionSearch(): void {
        cancelDescriptionSearch();
        baseResults = {};
        descriptionResults = {};
        baseHasMore = {};
        descriptionHasMore = {};
        descriptionOffsets = {};
    }

    /** Keep primary hits in place and append broader matches without duplicates. */
    function publishSearchResults(): void {
        const focusedId = visibleItems[selectedIndex]?.id;
        const anchor = Array.from(
            (scrollPhase === 'userScrolled'
                ? scrollContainer?.querySelectorAll<HTMLElement>('[data-search-item-id]')
                : []) ?? [],
        ).find(
            (node) =>
                node.getBoundingClientRect().bottom >
                (scrollContainer?.getBoundingClientRect().top ?? 0),
        );
        const anchorId = anchor?.dataset.searchItemId;
        const anchorTop = anchor?.getBoundingClientRect().top;
        const scrollTop = scrollContainer?.scrollTop ?? 0;
        const version = searchVersion;
        const next = { ...baseResults };
        if (fulltextMode) {
            for (const [category, items] of Object.entries(descriptionResults)) {
                const primary = next[category] ?? [];
                const ids = new Set(primary.map((item) => item.id));
                next[category] = [...primary, ...items.filter((item) => !ids.has(item.id))].sort(
                    (a, b) => Number(isBroaderMatch(a)) - Number(isBroaderMatch(b)),
                );
            }
        }
        groupedResults = next;
        hasMoreByCategory = { ...baseHasMore, ...(fulltextMode ? descriptionHasMore : {}) };
        if (focusedId) selectedIndex = visibleItems.findIndex((item) => item.id === focusedId);
        // Preserve the visible row as late batches insert categories above it.
        if (scrollPhase === 'userScrolled')
            void tick().then(() => {
                if (version !== searchVersion || !scrollContainer) return;
                const currentAnchor = Array.from(
                    scrollContainer.querySelectorAll<HTMLElement>('[data-search-item-id]'),
                ).find((node) => node.dataset.searchItemId === anchorId);
                if (currentAnchor && anchorTop !== undefined) {
                    scrollContainer.scrollTop +=
                        currentAnchor.getBoundingClientRect().top - anchorTop;
                } else {
                    scrollContainer.scrollTop = scrollTop;
                }
            });
    }

    function scheduleDescriptionSearch(): void {
        cancelDescriptionSearch();
        if (!fulltextMode || !shouldPerformSearch() || !parsedOperators.query) return;
        const groups = buildSearchGroups(playlistMode, shouldSearchCategory)
            .map((group) => ({
                types: group.types
                    .split(',')
                    .filter((type) => DESCRIPTION_CATEGORIES.has(type === 'series' ? 'tv' : type))
                    .join(','),
                categories: group.categories.filter((cat) => DESCRIPTION_CATEGORIES.has(cat)),
            }))
            .filter(
                (group) =>
                    group.types &&
                    group.categories.some((cat) => descriptionResults[cat] === undefined),
            );
        if (!groups.length) return;
        descriptionLoading = true;
        const version = searchVersion;
        const pass = descriptionVersion;
        const operators = parsedOperators;
        descriptionTimeout = setTimeout(async () => {
            descriptionAbortController = new AbortController();
            await executeSearchGroups(
                groups,
                {
                    effectiveQuery: operators.query,
                    parsedOperators: operators,
                    fulltextMode: true,
                    limit: SEARCH_RESULTS_LIMIT,
                },
                pass,
                (result) => {
                    if (version !== searchVersion || pass !== descriptionVersion) return;
                    if (result.failed) {
                        searchFailed = true;
                        return;
                    }
                    const grouped = groupResults(result.items);
                    for (const cat of result.categories) {
                        descriptionResults[cat] = grouped[cat] ?? [];
                        descriptionHasMore[cat] = result.hasMore ?? false;
                        descriptionOffsets[cat] = grouped[cat]?.length ?? 0;
                    }
                    publishSearchResults();
                },
                () => (version === searchVersion ? descriptionVersion : -1),
                descriptionAbortController.signal,
            );
            if (version === searchVersion && pass === descriptionVersion)
                descriptionLoading = false;
        }, 250);
    }

    // Available categories (loaded from API, cached at module level)
    let availableCategories: AvailableCategories | null = $state(availableCategoriesCache);

    // URL sync state
    let urlSyncTimeout: ReturnType<typeof setTimeout> | undefined;
    let urlSyncInitialized = $state(false);

    // =========================================================================
    // URL Sync (when syncToUrl is enabled)
    // =========================================================================

    /**
     * Update URL with current search query using replaceState (no history entry)
     */
    function updateUrlQuery(query: string) {
        if (!browser || !syncToUrl) return;

        const url = new URL(window.location.href);
        if (query.trim()) {
            url.searchParams.set('q', query.trim());
        } else {
            url.searchParams.delete('q');
        }
        setUrlCategoryFilters(url);

        // Use replaceState to avoid polluting history with every keystroke
        history.replaceState(history.state, '', url.toString());
    }

    /**
     * Mirror the category chips into `?types=` next to `?q=`, so a shared
     * search link reopens with the same chips. Only while a query is in the
     * URL: without `?q=` the link would not reopen the search at all.
     */
    function setUrlCategoryFilters(url: URL) {
        const types = url.searchParams.has('q')
            ? formatCategoryFiltersParam(selectedCategoryFilters)
            : null;
        if (types) url.searchParams.set(CATEGORY_FILTERS_URL_PARAM, types);
        else url.searchParams.delete(CATEGORY_FILTERS_URL_PARAM);
    }

    /** Update `?types=` right away after a chip toggle (replaceState, like `?q=`). */
    function syncUrlCategoryFilters() {
        if (!browser || !syncToUrl || playlistMode) return;
        const url = new URL(window.location.href);
        const before = url.toString();
        setUrlCategoryFilters(url);
        if (url.toString() !== before) history.replaceState(history.state, '', url.toString());
    }

    /**
     * Check URL for initial search query on mount
     */
    function checkUrlForQuery() {
        if (!browser || !syncToUrl) return;

        const urlQuery = new URL(window.location.href).searchParams.get('q');
        if (urlQuery && !isOpen) {
            // Open search with the URL query
            isOpen = true;
            searchQuery = urlQuery;
        }
        urlSyncInitialized = true;
    }

    /**
     * Clear URL query param when search closes
     */
    function clearUrlQuery() {
        if (!browser || !syncToUrl) return;

        const url = new URL(window.location.href);
        if (url.searchParams.has('q') || url.searchParams.has(CATEGORY_FILTERS_URL_PARAM)) {
            url.searchParams.delete('q');
            url.searchParams.delete(CATEGORY_FILTERS_URL_PARAM);
            history.replaceState(history.state, '', url.toString());
        }
    }

    // Cancel browser back navigation when search is open — close search instead
    beforeNavigate(({ type, cancel }) => {
        if (type === 'popstate' && isOpen) {
            cancel();
            closeSearch();
        }
    });

    // Setup URL sync on mount
    onMount(() => {
        if (syncToUrl) {
            checkUrlForQuery();
        }
    });

    onDestroy(() => {
        cancelDescriptionSearch();
        clearTimeout(searchTimeout);
        searchVersion++;
        searchAbortController?.abort();
        if (syncToUrl && browser) {
            clearTimeout(urlSyncTimeout);
        }
    });

    // Load available categories from API (cached at module level with 5min expiration)
    async function loadAvailableCategories() {
        const now = Date.now();
        const cacheExpired = now - availableCategoriesCacheTime > CACHE_DURATION_MS;

        // Use cached data if not expired
        if (availableCategoriesCache && !cacheExpired) {
            availableCategories = availableCategoriesCache;
            return;
        }

        // Already loading
        if (availableCategoriesLoading) return;

        availableCategoriesLoading = true;
        try {
            const { data } = await contentApi.getAvailableCategories();
            if (data) {
                const categories = data as unknown as AvailableCategories;
                availableCategoriesCache = categories;
                availableCategoriesCacheTime = now;
                availableCategories = categories;
            }
        } catch (error) {
            console.warn('Failed to load available categories:', error);
        }
        availableCategoriesLoading = false;
    }

    // Load fulltext preference from database
    async function loadFulltextPreference() {
        if (fulltextPreferenceLoaded) return;
        try {
            const { data } = await userApi.getSearchPreference();
            if (data) {
                if (!fulltextPreferenceLoaded && typeof data.fulltextSearch === 'boolean') {
                    const changed = fulltextMode !== data.fulltextSearch;
                    fulltextMode = data.fulltextSearch;
                    if (changed && isOpen && shouldPerformSearch()) {
                        publishSearchResults();
                        scheduleDescriptionSearch();
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to load search preference:', error);
        }
        fulltextPreferenceLoaded = true;
    }

    // Save fulltext preference to database
    async function saveFulltextPreference(value: boolean) {
        try {
            await userApi.updateSearchPreference({ fulltextSearch: value });
        } catch (error) {
            console.warn('Failed to save search preference:', error);
        }
    }

    // Toggle fulltext mode and save preference
    function toggleFulltextMode() {
        fulltextPreferenceLoaded = true;
        fulltextMode = !fulltextMode;
        const value = fulltextMode;
        preferenceSave = preferenceSave.then(() => saveFulltextPreference(value));
        markResultsInteraction();
        publishSearchResults();
        scheduleDescriptionSearch();
    }

    // Clear search query
    function clearSearchQuery() {
        resetDescriptionSearch();
        searchFailed = false;
        clearTimeout(searchTimeout);
        searchVersion++;
        searchAbortController?.abort();
        isLoading = false;
        programSearchResults = [];
        programSearchLoading = false;
        programRefreshActive = false;
        searchQuery = '';
        groupedResults = {};
        selectedIndex = -1;
        loadingCategories.clear();
        searchInput?.focus();
    }

    // Episode picker state
    let selectedSeries = $state<SeriesSearchItem | null>(null);

    // Track items added during this session (for "Added" feedback)
    let addedItemKeys = new SvelteSet<string>();
    const pendingPlaylistAdds = new SvelteSet<string>();
    const playlistAddFeedback = new SvelteMap<
        string,
        {
            item: PlaylistAddItem;
            pickerKey?: string;
            state: 'pending' | 'failed';
        }
    >();
    let playlistAddGeneration = 0;
    let seasonAddGeneration: number | null = null;
    $effect(() => {
        isOpen;
        playlistId;
        addedItemKeys.clear();
    });
    $effect(() => {
        isOpen;
        searchQuery;
        selectedSeries;
        playlistId;
        playlistAddGeneration++;
        playlistAddFeedback.clear();
        pickerAddedEpisodeKeys.clear();
        return () => {
            playlistAddGeneration++;
        };
    });

    async function addPlaylistItem(
        item: PlaylistAddItem,
        pickerKey?: string,
    ): Promise<PlaylistAddOutcome> {
        const key = getPlaylistItemKeyFromItem(item);
        const pendingKey = `${playlistId ?? ''}:${key}`;
        if (!isOpen || !playlistMode || pendingPlaylistAdds.has(pendingKey)) return 'failed';
        if (allPlaylistItemKeys.has(key)) {
            if (pickerKey) pickerAddedEpisodeKeys.add(pickerKey);
            return 'duplicate';
        }
        const generation = playlistAddGeneration;
        const query = searchQuery;
        const series = selectedSeries;
        const targetPlaylist = playlistId;
        const current = (): boolean =>
            isOpen &&
            generation === playlistAddGeneration &&
            query === searchQuery &&
            series === selectedSeries &&
            targetPlaylist === playlistId;
        pendingPlaylistAdds.add(pendingKey);
        playlistAddFeedback.set(key, { item, pickerKey, state: 'pending' });
        try {
            const result = await onaddToPlaylist?.(item);
            if (!current()) return result ?? 'failed';
            if (result !== 'added' && result !== 'duplicate') {
                playlistAddFeedback.set(key, { item, pickerKey, state: 'failed' });
                return 'failed';
            }
            addedItemKeys.add(key);
            if (pickerKey) pickerAddedEpisodeKeys.add(pickerKey);
            playlistAddFeedback.delete(key);
            return result;
        } catch {
            if (current()) playlistAddFeedback.set(key, { item, pickerKey, state: 'failed' });
            return 'failed';
        } finally {
            pendingPlaylistAdds.delete(pendingKey);
        }
    }

    // Category filter state - empty means search all
    let selectedCategoryFilters = new SvelteSet<string>();

    // Search version counter to prevent stale results from overwriting newer ones
    let searchVersion = 0;

    // Cancels in-flight search requests from a prior keystroke so the latest
    // search's results don't queue behind obsolete ones on the connection pool.
    let searchAbortController: AbortController | null = null;

    // Recent searches (localStorage-backed), shown in the zero-query empty state.
    let recentSearches = $state<string[]>([]);

    function selectRecentSearch(query: string) {
        searchQuery = query;
        searchInput?.focus();
    }
    function clearRecent() {
        clearRecentSearches();
        recentSearches = [];
    }

    // Per-category pagination ("Load more"). Only DB-backed categories paginate
    // (offset is honored by their SQL); external sources (books/audiobooks/
    // requests/livetv) don't support offset, so they never show load-more.
    const PAGINATED_CATEGORIES = new Set(['movie', 'tv', 'episode', 'music']);
    let hasMoreByCategory = $state<Record<string, boolean>>({});
    let loadingMoreCategories = new SvelteSet<string>();

    async function loadMoreCategory(categoryKey: string) {
        if (loadingMoreCategories.has(categoryKey) || !PAGINATED_CATEGORIES.has(categoryKey)) {
            return;
        }
        if (descriptionLoading && DESCRIPTION_CATEGORIES.has(categoryKey)) return;
        const useDescriptions = fulltextMode && descriptionResults[categoryKey] !== undefined;
        const current = baseResults[categoryKey] ?? [];
        const version = searchVersion;
        const pass = descriptionVersion;
        loadingMoreCategories.add(categoryKey);
        try {
            const result = await fetchSearchGroupPage(
                { types: categoryKey, categories: [categoryKey] },
                {
                    effectiveQuery: parsedOperators.query,
                    parsedOperators,
                    fulltextMode: useDescriptions,
                    limit: SEARCH_RESULTS_LIMIT,
                    offset: useDescriptions ? descriptionOffsets[categoryKey] : current.length,
                },
            );
            if (version !== searchVersion || pass !== descriptionVersion) return;
            if (!result) {
                searchFailed = true;
                return;
            }
            if (useDescriptions) {
                descriptionResults = addToGroupedResults(descriptionResults, result.items);
                descriptionOffsets[categoryKey] += result.items.length;
                descriptionHasMore[categoryKey] = result.hasMore ?? false;
            } else {
                baseResults = addToGroupedResults(baseResults, result.items);
                baseHasMore[categoryKey] = result.hasMore ?? false;
            }
            publishSearchResults();
        } finally {
            if (version === searchVersion) loadingMoreCategories.delete(categoryKey);
        }
    }

    // Toggle a category filter. Chips combine (Movies + Series searches both);
    // no chip pressed means every category.
    function toggleCategoryFilter(key: string) {
        // Only allow toggling searchable categories
        if (!searchableCategories.has(key)) return;

        if (selectedCategoryFilters.has(key)) {
            selectedCategoryFilters.delete(key);
        } else {
            selectedCategoryFilters.add(key);
        }

        // Persist the selection so it survives closing the modal / reloading.
        persistCategoryFilters();
        syncUrlCategoryFilters();

        // If we have a valid search query or operators, re-run search with new filters
        if (shouldPerformSearch()) {
            performSearch();
        }
    }

    // Clear all category filters
    function clearCategoryFilters() {
        selectedCategoryFilters.clear();
        persistCategoryFilters();
        syncUrlCategoryFilters();
        if (shouldPerformSearch()) {
            performSearch();
        }
    }

    // Persist the current filter selection to localStorage (playlist mode uses a
    // transient, restricted scope, so its selection is never persisted).
    function persistCategoryFilters() {
        if (playlistMode) return;
        saveCategoryFilters(selectedCategoryFilters);
    }

    // Restore the filter selection when the modal opens: a `?types=` in the URL
    // (shared search link) wins over the persisted one. Skipped in playlist mode
    // (which forces its own movie/tv scope).
    function restoreCategoryFilters() {
        if (playlistMode) return;
        const fromUrl =
            browser && syncToUrl
                ? parseCategoryFiltersParam(
                      new URL(window.location.href).searchParams.get(CATEGORY_FILTERS_URL_PARAM),
                      new Set(categories.map((c) => c.key)),
                  )
                : null;
        selectedCategoryFilters.clear();
        for (const key of fromUrl ?? getCategoryFilters()) {
            selectedCategoryFilters.add(key);
        }
    }

    // Check if a category should be searched (either no filters, or category is selected)
    function shouldSearchCategory(key: string): boolean {
        return selectedCategoryFilters.size === 0 || selectedCategoryFilters.has(key);
    }

    // =========================================================================
    // Search Logic
    // =========================================================================

    /** Map v1 API type -> UI group key ('series' -> 'tv', music types -> 'music', etc.) */
    function itemTypeToGroupKey(type: V1SearchResultItem['type']): string {
        if (type === 'series') return 'tv';
        if (type === 'track' || type === 'album' || type === 'artist') return 'music';
        // The cross-entity request type maps to the legacy 'anfragen' category key
        // (the SearchCategory + open-handler dispatch are keyed on 'anfragen').
        if (type === 'request') return 'anfragen';
        // book|manga|comic|audiobook|tvchannel|home_video|training|educational|
        // personal already match their category keys 1:1.
        return type;
    }

    /** Adapt a V1SearchResultItem to the SeriesSearchItem shape expected by SeriesEpisodePicker */
    function v1ItemToSeriesItem(v1: V1SearchResultItem): SeriesSearchItem {
        return {
            id: v1.id,
            title: v1.title,
            imageUrl: pickVariant(v1.images?.poster, 'thumb'),
            externalIds: v1.ids as ExternalIds,
        };
    }

    function groupResults(items: V1SearchResultItem[]): Record<string, V1SearchResultItem[]> {
        const groups: Record<string, V1SearchResultItem[]> = {};
        for (const item of items) {
            const key = itemTypeToGroupKey(item.type);
            if (!groups[key]) groups[key] = [];
            groups[key].push(item);
        }
        return groups;
    }

    function addToGroupedResults(
        existingGroups: Record<string, V1SearchResultItem[]>,
        newItems: V1SearchResultItem[],
    ): Record<string, V1SearchResultItem[]> {
        const groups = { ...existingGroups };
        for (const item of newItems) {
            const key = itemTypeToGroupKey(item.type);
            if (!groups[key]) groups[key] = [];
            groups[key] = [...groups[key]!, item];
        }
        return groups;
    }

    // Track loading state per category for progressive display
    let loadingCategories = new SvelteSet<string>();

    // (The legacy "episode not found but series exists" hint was driven by an
    // `episodeSearchInfo` field on the search response. The v1 /api/search
    // contract returns only { items, page }, so that field no longer exists and
    // the hint state/handlers have been removed.)

    // Watchlist state - track keys of items being toggled (loading state)
    let watchlistLoadingKeys = new SvelteSet<string>();

    // Scroll container reference for quick navigation
    let scrollContainer: HTMLDivElement | undefined = $state();
    let scrollPhase = $state<'idle' | 'searching' | 'userScrolled' | 'autoScrolled'>('idle');
    /** Category promoted to the top once every source settled (see the relevance effect). */
    let leadCategory = $state<string | null>(null);

    function markResultsInteraction(): void {
        scrollPhase = 'userScrolled';
    }

    function captureScrollContainer(node: HTMLDivElement) {
        scrollContainer = node;
        // Passive observation only: child controls keep their native behavior.
        const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
        for (const event of events)
            node.addEventListener(event, markResultsInteraction, { passive: true });
        return () => {
            for (const event of events) node.removeEventListener(event, markResultsInteraction);
            if (scrollContainer === node) {
                scrollContainer = undefined;
            }
        };
    }

    /**
     * Build the list of search groups to execute in parallel.
     * Filters based on playlist mode and active category filters.
     */
    function buildSearchGroups(
        isPlaylistMode: boolean,
        shouldSearchCategoryFn: (cat: string) => boolean,
    ): { types: string; categories: string[] }[] {
        // When restrictToTypes is set, only search those types
        if (restrictToTypes) {
            return restrictToTypes
                .split(',')
                .map((type) => (type.trim() === 'series' ? 'tv' : type.trim()))
                .filter((type) => !hasCatalogFilters || type === 'movie' || type === 'tv')
                .map((type) => ({ types: type, categories: [type] }));
        }

        // The /api/search def (defs/search/search.ts) fans out over the full
        // legacy source set: the DB catalog (movie, series, episode, music) AND
        // the auxiliary sources (Kavita books/manga/comic, Audiobookshelf
        // audiobooks, Jellyseerr requests → 'anfragen', Live TV channels, and
        // the non-entertainment library types home_video/training/educational/
        // personal). Every result is normalized to the v1 {items,page} item
        // shape, so each category below maps to real results — none is a
        // permanently-empty section. (Live TV *programs* use the separate
        // searchPrograms parallel path; channels come back via this def.)
        //
        // Playlist mode stays catalog-only (movie/tv/episode/music) — you cannot
        // add a book, audiobook, request, or channel to a media playlist.
        // Episodes are addable individually: the server derives their
        // season/episode/series from the media_items hierarchy on insert.
        //
        // One request per category: the server pages the MERGED result list, so
        // a shared group's `hasMore` can't say which category has more (a
        // lone movie hit showed "Movies 1+" because the series had more).
        const allSearchGroups = isPlaylistMode
            ? [
                  { types: 'movie', categories: ['movie'] },
                  { types: 'tv', categories: ['tv'] },
                  { types: 'episode', categories: ['episode'] },
                  { types: 'music', categories: ['music'] },
              ]
            : [
                  { types: 'movie', categories: ['movie'] },
                  { types: 'tv', categories: ['tv'] },
                  { types: 'episode', categories: ['episode'] },
                  { types: 'music', categories: ['music'] },
                  { types: 'book', categories: ['book'] },
                  { types: 'manga', categories: ['manga'] },
                  { types: 'comic', categories: ['comic'] },
                  { types: 'audiobook', categories: ['audiobook'] },
                  { types: 'anfragen', categories: ['anfragen'] },
                  { types: 'tvchannel', categories: ['tvchannel'] },
                  { types: 'home_video', categories: ['home_video'] },
                  { types: 'training', categories: ['training'] },
                  { types: 'educational', categories: ['educational'] },
                  { types: 'personal', categories: ['personal'] },
              ];

        return allSearchGroups
            .map((group) => {
                const filteredCategories = group.categories.filter(
                    (cat) =>
                        shouldSearchCategoryFn(cat) &&
                        (!hasCatalogFilters || cat === 'movie' || cat === 'tv'),
                );
                if (filteredCategories.length === 0) return null;
                return {
                    types: filteredCategories.join(','),
                    categories: filteredCategories,
                };
            })
            .filter((group): group is { types: string; categories: string[] } => group !== null);
    }

    /** Check if search should be performed (query is valid or operators are set) */
    function shouldPerformSearch(): boolean {
        return shouldPerformSearchUtil(parsedOperators.query, parsedOperators);
    }

    /**
     * Merge a completed search group result into reactive state.
     * Closes over $state variables — safe because Svelte 5 $state is signal-based.
     */
    function applyGroupResult(groupResult: SearchGroupResult): void {
        const { categories, items } = groupResult;
        if (groupResult.failed) searchFailed = true;

        if (!refreshedCategoriesRef) refreshedCategoriesRef = new SvelteSet<string>();

        // Replace each category on its first delivery in this search cycle.
        const baseGroups = { ...baseResults };
        for (const cat of categories) {
            if (!refreshedCategoriesRef.has(cat)) {
                refreshedCategoriesRef.add(cat);
                delete baseGroups[cat];
            }
        }

        baseResults = addToGroupedResults(baseGroups, items);

        // Record per-category load-more availability (paginated categories only).
        const nextHasMore = { ...baseHasMore };
        for (const cat of categories) {
            loadingCategories.delete(cat);
            if (PAGINATED_CATEGORIES.has(cat)) {
                nextHasMore[cat] = groupResult.hasMore ?? false;
            }
        }
        baseHasMore = nextHasMore;
        publishSearchResults();
    }

    async function performSearch() {
        clearTimeout(searchTimeout);
        resetDescriptionSearch();
        searchFailed = false;
        // Use reactive parsedOperators (already computed)
        const effectiveQuery = parsedOperators.query;

        // Early exit if no valid query or operators
        if (!shouldPerformSearch()) {
            isLoading = false;
            groupedResults = {};
            loadingCategories.clear();
            programSearchResults = [];
            programSearchLoading = false;
            programRefreshActive = false;
            return;
        }

        isLoading = true;
        selectedIndex = -1;
        loadingMoreCategories.clear();
        hasMoreByCategory = {};
        // A new query must never expose actionable results from the previous query.
        groupedResults = {};
        refreshedCategoriesRef = null;

        scrollContainer?.scrollTo({ top: 0 });
        scrollPhase = 'searching';
        leadCategory = null;

        // Increment search version to invalidate any in-flight requests
        searchVersion++;
        const thisSearchVersion = searchVersion;

        // Cancel the previous search's in-flight requests so this one isn't
        // stuck behind them in the browser's per-host connection queue.
        searchAbortController?.abort();
        searchAbortController = new AbortController();
        const searchSignal = searchAbortController.signal;

        const searchGroups = buildSearchGroups(playlistMode, shouldSearchCategory);
        scheduleDescriptionSearch();

        // Mark all categories as loading
        loadingCategories.clear();
        const activeCategories = new Set(searchGroups.flatMap((g) => g.categories));
        for (const cat of activeCategories) loadingCategories.add(cat);

        // Drop stale results for categories not included in this search
        // (e.g. mode change, filter change) so they don't persist indefinitely.
        const staleKeys = Object.keys(groupedResults).filter((k) => !activeCategories.has(k));
        if (staleKeys.length > 0) {
            const pruned = { ...groupedResults };
            for (const k of staleKeys) delete pruned[k];
            groupedResults = pruned;
        }

        // Program search: separate parallel path (AC #1, #2, #5)
        const hasLiveTv =
            $page.data.features?.liveTV === true && ($page.data.user?.hasLiveTvPermission ?? false);
        const shouldSearchLiveTv =
            hasLiveTv &&
            !hasCatalogFilters &&
            effectiveQuery.length >= 2 &&
            shouldSearchCategory('livetv_program');
        programSearchLoading = shouldSearchLiveTv;
        programSearchResults = [];
        programRefreshActive = false;

        const programSearchPromise = shouldSearchLiveTv
            ? Promise.race([
                  searchPrograms(effectiveQuery, 30),
                  new Promise<never>((_, reject) =>
                      setTimeout(() => reject(new Error('timeout')), 5000),
                  ),
              ])
                  .then(({ data }) => {
                      if (searchVersion !== thisSearchVersion) return;
                      programSearchResults = groupProgramAirings(data?.items ?? []);
                      // Activate 60s auto-refresh for temporal status updates
                      programRefreshQuery = effectiveQuery;
                      programRefreshActive = true;
                  })
                  .catch(() => {
                      if (searchVersion !== thisSearchVersion) return;
                      programSearchResults = [];
                      searchFailed = true;
                  })
                  .finally(() => {
                      if (searchVersion !== thisSearchVersion) return;
                      programSearchLoading = false;
                  })
            : Promise.resolve();

        // Gate the "settle" (isLoading → auto-scroll to best match) on the MEDIA
        // search groups only. The best-match category is computed from these
        // results, so the auto-scroll still waits for every media group (incl.
        // the slower episode group) — guaranteeing it lands on the most relevant
        // result. The LiveTV program search resolves independently via
        // programSearchLoading, so its up-to-5s timeout never delays the scroll.
        await executeSearchGroups(
            searchGroups,
            {
                effectiveQuery,
                parsedOperators,
                fulltextMode: false,
                limit: SEARCH_RESULTS_LIMIT,
            },
            thisSearchVersion,
            applyGroupResult,
            () => searchVersion,
            searchSignal,
        );

        // Only set loading false if this is still the current search
        if (searchVersion === thisSearchVersion) {
            isLoading = false;
        }

        // Program search continues in the background; it is version-guarded and
        // manages its own programSearchLoading indicator.
        void programSearchPromise;
    }

    function debounceSearch() {
        resetDescriptionSearch();
        searchFailed = false;
        clearTimeout(searchTimeout);
        searchVersion++;
        searchAbortController?.abort();
        selectedIndex = -1;
        groupedResults = {};
        programSearchResults = [];
        programSearchLoading = false;
        programRefreshActive = false;
        loadingCategories.clear();
        isLoading = shouldPerformSearch();
        if (!isLoading) return;
        searchTimeout = setTimeout(performSearch, debounceMs);
    }

    // =========================================================================
    // Playlist Item Helpers
    // =========================================================================

    /** Generate a unique key for playlist item identification using provider-agnostic format */
    function getPlaylistItemKeyFromItem(item: {
        externalIds?: ExternalIds;
        mediaType: string;
        seasonNumber?: number;
        episodeNumber?: number;
    }): string {
        return getEpisodeKey({
            externalIds: item.externalIds || {},
            mediaType: item.mediaType,
            seasonNumber: item.seasonNumber,
            episodeNumber: item.episodeNumber,
        });
    }

    // =========================================================================
    // Section Builder
    // =========================================================================

    /** Move the lead category's section (if any) to the front, keeping the rest in order. */
    function leadSection(list: PageSection[], lead: string | null): PageSection[] {
        const index = lead ? list.findIndex((section) => section.id === `search-${lead}`) : -1;
        return index > 0 ? [list[index], ...list.slice(0, index), ...list.slice(index + 1)] : list;
    }

    function buildSections(
        groups: Record<string, V1SearchResultItem[]>,
        query: string,
    ): PageSection[] {
        const result: PageSection[] = [];

        for (const category of categories) {
            if (!shouldSearchCategory(category.key)) continue;
            const items = groups[category.key];
            if (items && items.length > 0) {
                result.push({
                    id: `search-${category.key.toLowerCase()}`,
                    type: 'list',
                    title: category.label,
                    items: (selectedCategoryFilters.size === 0
                        ? [...items]
                              .sort(
                                  (a, b) =>
                                      matchTier(b, query.toLowerCase().trim()) -
                                      matchTier(a, query.toLowerCase().trim()),
                              )
                              .slice(0, 3)
                        : items
                    ).map((item) => transformSearchItem(item, query)),
                    meta: {
                        icon: category.key,
                        iconColor: category.iconColor,
                        count: items.length,
                        showRemoveButton: false,
                        showMoreButton: categoryHasSimilar(category.key),
                        collapsible: false,
                        showRefresh: false,
                    },
                });
            }
        }

        return result;
    }

    // =========================================================================
    // Keyboard Navigation
    // =========================================================================

    /**
     * Match-quality TIER of an item's title(s) against the query, derived purely
     * from the query string so it's COMPARABLE ACROSS SOURCES. The per-source
     * `rank` (ts_rank / similarity / popularity) is on incompatible scales — a
     * fulltext movie carries `+3`, an episode raw `ts_rank ≈ 0.05`, music `+1`,
     * kavita/requests none — so comparing raw ranks made episodes/tracks never
     * win the auto-scroll even on an exact-title match. The tier fixes that;
     * raw rank is only the within-tier tiebreaker.
     *   3 = exact whole-title, 2 = starts-with, 1 = contains, 0 = fuzzy/other-field.
     */
    function matchTier(item: V1SearchResultItem, q: string): number {
        if (isBroaderMatch(item)) return -1;
        if (!q) return 0;
        const candidates = [item.title, item.context?.series?.title].filter(
            (t): t is string => typeof t === 'string' && t.length > 0,
        );
        let best = 0;
        for (const raw of candidates) {
            const c = raw.toLowerCase().trim();
            if (c === q) return 3;
            if (c.startsWith(q)) best = Math.max(best, 2);
            else if (c.includes(q)) best = Math.max(best, 1);
        }
        return best;
    }

    function isBroaderMatch(item: V1SearchResultItem): boolean {
        return item.reason?.kind === 'overview' || item.reason?.kind === 'keyword';
    }

    /**
     * Scan the given categories and return the (category, tier, rank) of the most
     * relevant item, comparing by (match tier, then raw rank) so the result is
     * COMPARABLE ACROSS SOURCES. `include` narrows which categories participate.
     */
    function bestMatchAmong(
        groups: Record<string, V1SearchResultItem[]>,
        q: string,
        include: (key: string) => boolean,
    ): { category: string | null; tier: number; rank: number } {
        let bestCategory: string | null = null;
        let bestTier = -1;
        let bestRank = -Infinity;
        const hasPrimaryMatch = Object.entries(groups).some(
            ([key, items]) =>
                include(key) &&
                items.some(
                    (item) => item.reason?.kind !== 'overview' && item.reason?.kind !== 'keyword',
                ),
        );

        for (const category of categories) {
            if (!include(category.key)) continue;
            const items = groups[category.key];
            if (!items || items.length === 0) continue;

            for (const item of items) {
                if (
                    hasPrimaryMatch &&
                    (item.reason?.kind === 'overview' || item.reason?.kind === 'keyword')
                )
                    continue;
                const tier = matchTier(item, q);
                const rank = typeof item.score === 'number' && !isNaN(item.score) ? item.score : 0;
                if (tier > bestTier || (tier === bestTier && rank > bestRank)) {
                    bestTier = tier;
                    bestRank = rank;
                    bestCategory = category.key;
                }
            }
        }

        return { category: bestCategory, tier: bestTier, rank: bestRank };
    }

    // Requests (`anfragen`) is Jellyseerr discovery — content the user does NOT own.
    // It must never win the auto-scroll over a real library hit, even on an exact
    // title match, so it's excluded from the first pass and only considered as a
    // fallback when nothing local matches.
    const AUTO_SCROLL_DEPRIORITIZED = new Set(['anfragen']);

    /**
     * Find the category whose best result is the most relevant to the query,
     * comparing by (match tier, then raw rank) so the auto-scroll lands on the
     * truly most relevant result regardless of which source it came from.
     * Deprioritized categories (Requests) are considered only when nothing else
     * is a confident match. Returns null when nothing is a confident match.
     */
    function findBestMatchCategory(groups: Record<string, V1SearchResultItem[]>): string | null {
        const q = parsedOperators.query.toLowerCase().trim();

        // A confident match is: the query is at least a substring of a title
        // (tier ≥ 1), or there's a ranked lexical/fuzzy hit (rank > 0, e.g. a typo
        // correction where the query isn't a literal substring).
        const isConfident = (m: { tier: number; rank: number }): boolean =>
            m.tier >= 1 || m.rank > 0;

        // First pass: owned/local content only. A confident local hit always wins.
        const local = bestMatchAmong(groups, q, (key) => !AUTO_SCROLL_DEPRIORITIZED.has(key));
        if (local.category && isConfident(local)) return local.category;

        // Fallback: nothing local matched — allow Requests (and any other
        // deprioritized source) to claim the scroll.
        const all = bestMatchAmong(groups, q, () => true);
        return all.category && isConfident(all) ? all.category : null;
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.isComposing || event.defaultPrevented) return;
        if (event.key === 'Escape') {
            event.stopImmediatePropagation(); // Prevent other handlers (e.g., VideoPlayer) from also handling
            closeSearch();
            return;
        }
    }

    function handleInputKeydown(event: KeyboardEvent) {
        if (
            event.isComposing ||
            event.defaultPrevented ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
        )
            return;
        if (event.key === 'Escape') {
            event.stopImmediatePropagation(); // Prevent other handlers from also handling
            closeSearch();
            return;
        }

        if (!visibleItems.length) return;

        // Arrow navigation - always navigate results, prevent default cursor movement in input
        if (event.key === 'ArrowDown') {
            markResultsInteraction();
            event.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, visibleItems.length - 1);
            scrollToSelected();
        } else if (event.key === 'ArrowUp') {
            markResultsInteraction();
            event.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            scrollToSelected();
        } else if (event.key === 'Enter' && selectedIndex >= 0) {
            event.preventDefault();
            const item = visibleItems[selectedIndex];
            if (item) handleItemOpen(item);
        }
    }

    async function scrollToSelected(): Promise<void> {
        await tick();
        if (selectedItemId) {
            const element = Array.from(
                scrollContainer?.querySelectorAll<HTMLElement>('[data-search-item-id]') ?? [],
            ).find((node) => node.dataset.searchItemId === selectedItemId);
            element?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
    }

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function closeSearch() {
        playlistAddGeneration++;
        playlistAddFeedback.clear();
        resetDescriptionSearch();
        searchFailed = false;
        searchAbortController?.abort();
        isOpen = false;
        searchQuery = '';
        groupedResults = {};
        selectedIndex = -1;
        isLoading = false;
        loadingCategories.clear();
        selectedSeries = null;
        selectedCategoryFilters.clear(); // Reset category filters
        addedItemKeys.clear(); // Reset session-added items
        pickerAddedEpisodeKeys.clear(); // Reset picker-added episodes
        searchVersion++; // Never reuse an in-flight request's version after reopening.
        programSearchResults = [];
        programSearchLoading = false;
        programRefreshActive = false;
        clearTimeout(searchTimeout); // Prevent stale search from running
        clearTimeout(urlSyncTimeout); // Clear pending URL update
        clearUrlQuery(); // Remove ?q from URL
        onclose?.();
    }

    /**
     * Handle playlist mode and watch party mode item selection.
     * Returns true if handled (caller should return immediately); false to continue normal flow.
     *
     * @param item - The media item being opened.
     * @param mediaType - Must be item.clickData?.mediaType — passed separately to avoid repeated casting.
     * @param originalItem - Must be item.clickData?.originalItem — passed separately for the same reason.
     */
    function handlePlaylistOrWatchPartyMode(
        item: UniversalMediaItem,
        mediaType: string,
        originalItem: V1SearchResultItem | undefined,
    ): boolean {
        if (playlistMode && isSeries(mediaType) && originalItem) {
            selectedSeries = v1ItemToSeriesItem(originalItem);
            return true;
        }

        if (watchPartyMode) {
            if (isSeries(mediaType) && originalItem) {
                selectedSeries = v1ItemToSeriesItem(originalItem);
                return true;
            }
            const mappedType = getPlaybackMediaType(mediaType);
            if (mappedType) {
                onselectitem?.({
                    itemId: item.externalIds?.internal || item.id || '',
                    title: item.title,
                    mediaType: mappedType,
                });
                closeSearch();
            }
            return true;
        }

        return false;
    }

    function handleItemClick(data: { section: PageSection; item: UniversalMediaItem }) {
        handleItemOpen(data.item);
    }

    function handleItemRequest(data: { section: PageSection; item: UniversalMediaItem }): void {
        const item = data.item;
        const mediaType = (item.clickData?.mediaType as string) || item.mediaType;
        getItemOpenHandler(mediaType)(item, { closeSearch });
    }

    function handleItemOpen(item: UniversalMediaItem) {
        const originalItem = item.clickData?.originalItem as V1SearchResultItem | undefined;
        const mediaType = item.clickData?.mediaType as string;

        // Opening a result is a strong signal the query was useful — record it.
        recentSearches = addRecentSearch(parsedOperators.query);

        if (handlePlaylistOrWatchPartyMode(item, mediaType, originalItem)) return;

        const helpers: ItemOpenHelpers = { closeSearch };
        getItemOpenHandler(mediaType)(item, helpers);
    }

    function handleItemPlay(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        const mediaType = item.clickData?.mediaType as string;

        if (mediaType === 'track' || mediaType === 'album' || mediaType === 'artist') {
            const id = item.externalIds?.internal;
            if (id) void musicItemHandlers.handleItemPlay({ ...data, item: { ...item, id } });
            return;
        }

        // Series - always open episode picker (both normal and watch party mode)
        // This ensures user picks an episode rather than relying on server-side redirect
        // which can fail due to TMDB ID collisions between movies and TV shows
        if (isSeries(mediaType)) {
            const orig = item.clickData?.originalItem as V1SearchResultItem | undefined;
            selectedSeries = orig ? v1ItemToSeriesItem(orig) : null;
            return;
        }

        // Watch party mode - dispatch event for other media types
        if (watchPartyMode) {
            const mappedType = getPlaybackMediaType(mediaType);
            if (mappedType) {
                onselectitem?.({
                    itemId: item.externalIds?.internal || item.id || '',
                    title: item.title,
                    mediaType: mappedType,
                });
                closeSearch();
            }
            return;
        }

        // Normal mode - navigate to play
        if (mediaType === 'audiobook') {
            handleAudiobookOpen(item, { closeSearch });
            return;
        } else if (mediaType === 'book' || mediaType === 'manga' || mediaType === 'comic') {
            openKavitaItem({
                ...(item.clickData?.originalItem as
                    { mediaId?: string; libraryId?: number } | undefined),
                kavitaId: item.externalIds?.kavita,
            });
            // Don't close search for external links
            return;
        } else if (getPlayableId(item)) {
            // Store current path for back button navigation
            saveReturnPath();
            const playId = getPlayableId(item)!;
            void navigateTo(`/watch/${playId}`);
            closeSearch();
        }
    }

    function handleItemMore(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        const mediaType = item.clickData?.mediaType as string;

        if (mediaType === 'track') {
            const id = item.externalIds?.internal;
            if (id) musicItemHandlers.handleItemMore({ ...data, item: { ...item, id } });
            return;
        }

        // For movies/series with valid external ID, show similar content
        // Don't close search - modal will appear above it
        if (hasValidExternalId(item.externalIds) && (isMovie(mediaType) || isSeries(mediaType))) {
            openSimilarModal(item);
        }
    }

    async function handleItemAddToPlaylist(data: {
        section: PageSection;
        item: UniversalMediaItem;
    }): Promise<void> {
        const item = data.item;
        const mediaType = item.clickData?.mediaType as string;

        // Skip items that can't be added to playlists. Books/manga/comics are
        // external Kavita rows — their ids are not catalog ids, so an add would
        // post garbage as a 'tv' item.
        if (
            mediaType === 'anfragen' ||
            mediaType === 'audiobook' ||
            mediaType === 'tvchannel' ||
            mediaType === 'book' ||
            mediaType === 'manga' ||
            mediaType === 'comic'
        ) {
            return;
        }

        // For series, add the whole series directly (backend expands to all episodes)
        // For music albums, backend expands to all tracks
        // Note: User can still click on series title to open modal and pick individual episodes
        const playlistMediaType: 'movie' | 'tv' | 'episode' | 'artist' | 'album' | 'track' =
            mediaType === 'artist'
                ? 'artist'
                : mediaType === 'album'
                  ? 'album'
                  : mediaType === 'track'
                    ? 'track'
                    : isMovie(mediaType)
                      ? 'movie'
                      : isSeries(mediaType)
                        ? 'tv'
                        : isEpisode(mediaType)
                          ? 'episode'
                          : 'tv';

        await addPlaylistItem({
            externalIds: item.externalIds,
            mediaType: playlistMediaType,
            title: item.title,
            seasonNumber: item.seasonNumber,
            episodeNumber: item.episodeNumber,
            seriesName: item.seriesName,
            // For episodes, pass the series externalIds
            seriesExternalIds: playlistMediaType === 'episode' ? item.externalIds : undefined,
            posterPath: item.image,
            overview: item.overview,
        });
    }

    async function handleItemWatchlist(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        const mediaType = (item.clickData?.mediaType as string) || item.mediaType;

        // Only movies and TV shows can be added to watchlist
        if (!isMovie(mediaType) && !isSeries(mediaType)) return;
        if (!item.externalIds) return;

        // isSeries() accepts BOTH 'tv' and 'series', and search rows carry the
        // canonical 'series' — so normalise rather than assert. The watchlist
        // store and /api/ai/save-movie's body schema (z.enum(['movie','tv']))
        // both speak 'movie' | 'tv': sending 'series' 400s the call, and keying
        // off it misses the store's 'tv' entries in watchlistItemKeys below.
        const watchlistType: 'movie' | 'tv' = isMovie(mediaType) ? 'movie' : 'tv';

        const itemKey = getPlaylistItemKeyFromItem({
            externalIds: item.externalIds,
            mediaType: watchlistType,
        });
        if (!itemKey || watchlistLoadingKeys.has(itemKey)) return;

        watchlistLoadingKeys.add(itemKey);

        const isCurrentlyInWatchlist = watchlistItemKeys.has(itemKey);

        try {
            if (isCurrentlyInWatchlist) {
                // Remove from watchlist
                const { error } = await aiApi.unsaveMovie({
                    externalIds: item.externalIds,
                    mediaType: watchlistType,
                });
                if (!error) {
                    removeFromWatchlistStore(item.externalIds, watchlistType);
                    toasts.success(`Removed "${item.title}" from watchlist`);
                } else {
                    toasts.error('Failed to update watchlist');
                }
            } else {
                // Add to watchlist
                const { error } = await aiApi.saveMovie({
                    externalIds: item.externalIds,
                    mediaType: watchlistType,
                    title: item.title,
                    overview: item.overview,
                    rating: item.rating ? Number(item.rating) : undefined,
                    isAvailable: item.isAvailable,
                });
                if (!error) {
                    const watchlistItem: WatchlistItem = {
                        externalIds: item.externalIds,
                        mediaType: watchlistType,
                        title: item.title,
                        overview: item.overview,
                        rating: item.rating,
                        isAvailable: item.isAvailable,
                        savedAt: new Date().toISOString(),
                    };
                    addToWatchlistStore(watchlistItem);
                    toasts.success(`Added "${item.title}" to watchlist`);
                } else {
                    toasts.error('Failed to update watchlist');
                }
            }
        } catch (err) {
            console.error('Watchlist toggle failed:', err);
            toasts.error('Failed to update watchlist');
        } finally {
            watchlistLoadingKeys.delete(itemKey);
        }
    }

    function openSimilarModal(item: UniversalMediaItem): void {
        const mediaType = toTmdbMediaType(item.mediaType);
        if (mediaType === null || !hasValidExternalId(item.externalIds)) return;

        modals.open(getModalComponent('similarMovies'), {
            sourceMedia: {
                externalIds: item.externalIds,
                name: item.title,
                type: mediaType,
            },
            similar: [],
            loading: true,
        });
    }

    // =========================================================================
    // Episode Picker Handlers
    // =========================================================================

    type EpisodePickerItem = {
        id: string;
        name?: string;
        episodeNumber: number;
        seasonNumber: number;
        externalIds?: ExternalIds;
        imageUrl?: string;
        overview?: string;
    };
    type SeasonPickerItem = {
        Id?: string;
        id?: string;
        Name?: string;
        name?: string;
        IndexNumber?: number;
        seasonNumber?: number;
    };

    function handleEpisodeSelection(episode: EpisodePickerItem) {
        if (playlistMode) {
            void handleAddEpisodeFromPicker(episode);
            return;
        }

        if (watchPartyMode && selectedSeries) {
            onselectitem?.({
                itemId: episode.id,
                title: `${selectedSeries.title} - S${episode.seasonNumber}E${episode.episodeNumber} - ${episode.name}`,
                mediaType: 'episode',
            });
            closeSearch();
        } else if (!watchPartyMode) {
            // Store current path for back button navigation
            saveReturnPath();
            void navigateTo(`/watch/${episode.id}`);
            closeSearch();
        }
    }

    function handleBackFromEpisodePicker() {
        selectedSeries = null;
    }

    function episodePlaylistItem(episode: EpisodePickerItem): PlaylistAddItem {
        const seriesExternalIds = selectedSeries?.externalIds;
        return {
            externalIds: seriesExternalIds || episode.externalIds,
            mediaType: 'episode',
            title: episode.name || `Episode ${episode.episodeNumber}`,
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            seriesName: selectedSeries?.title || selectedSeries?.name,
            seriesExternalIds,
            posterPath: episode.imageUrl || selectedSeries?.imageUrl,
            overview: episode.overview,
        };
    }

    async function handleAddEpisodeFromPicker(episode: EpisodePickerItem): Promise<void> {
        await addPlaylistItem(
            episodePlaylistItem(episode),
            `${episode.seasonNumber}:${episode.episodeNumber}`,
        );
    }

    async function handleAddSeasonFromPicker(detail: {
        season: SeasonPickerItem;
        episodes: EpisodePickerItem[];
    }): Promise<void> {
        const generation = playlistAddGeneration;
        if (seasonAddGeneration === generation) return;
        seasonAddGeneration = generation;
        const queue = detail.episodes.map((episode) => ({
            item: episodePlaylistItem(episode),
            pickerKey: `${episode.seasonNumber}:${episode.episodeNumber}`,
        }));
        try {
            for (const entry of queue) {
                if (!isOpen || generation !== playlistAddGeneration) break;
                await addPlaylistItem(entry.item, entry.pickerKey);
            }
        } finally {
            if (seasonAddGeneration === generation) seasonAddGeneration = null;
        }
    }

    // Track episodes added from the picker (separate from search results)
    let pickerAddedEpisodeKeys = new SvelteSet<string>();

    // Feature flags for request permission
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    // Watchlist item keys derived from the watchlist store
    let watchlistItemKeys = $derived(
        new SvelteSet(
            $watchlistItems
                .map((item) => {
                    const key = getPlaylistItemKeyFromItem({
                        externalIds: item.externalIds,
                        mediaType: item.mediaType,
                    });
                    return key;
                })
                .filter((k) => k !== ''),
        ),
    );
    // Sync search query to URL (debounced).
    // Read searchQuery synchronously so Svelte 5 tracks it as a dependency —
    // reading it only inside setTimeout would NOT establish tracking.
    $effect(() => {
        const query = searchQuery;
        if (syncToUrl && browser && urlSyncInitialized && isOpen) {
            clearTimeout(urlSyncTimeout);
            urlSyncTimeout = setTimeout(() => {
                updateUrlQuery(query);
            }, 500); // Debounce URL updates
        }
    });
    // Auto-refresh program search results every 60 seconds (AC #6, #7)
    $effect(() => {
        if (programRefreshInterval) {
            clearInterval(programRefreshInterval);
            programRefreshInterval = null;
        }

        if (programRefreshActive && programRefreshQuery) {
            const currentVersion = searchVersion;
            const query = programRefreshQuery;

            programRefreshInterval = setInterval(async () => {
                if (document.hidden) return;

                if (searchVersion !== currentVersion) {
                    clearInterval(programRefreshInterval!);
                    programRefreshInterval = null;
                    return;
                }

                try {
                    const { data } = await searchPrograms(query, 30);
                    if (searchVersion === currentVersion) {
                        programSearchResults = groupProgramAirings(data?.items ?? []);
                    }
                } catch {
                    /* expected: program search refresh may fail — existing results remain displayed */
                }
            }, 60_000);
        }

        return () => {
            if (programRefreshInterval) {
                clearInterval(programRefreshInterval);
                programRefreshInterval = null;
            }
        };
    });

    // Categories that are actually searchable in the current mode
    // - In playlist mode: movie, tv and episode (single episodes are addable)
    // - Otherwise: all categories that have content available
    let searchableCategories = $derived(
        (() => {
            if (playlistMode) {
                if (restrictToTypes) {
                    return new SvelteSet(restrictToTypes.split(',').map((t) => t.trim()));
                }
                return new SvelteSet(['movie', 'tv', 'episode']);
            }

            // The /api/search def (defs/search/search.ts) fans out over the full
            // legacy source set, so every category below maps to real results.
            // Chips are feature/permission-gated by /api/search/available-categories
            // (loaded into availableCategories) so a disabled source (Kavita off,
            // no Jellyseerr, no Live TV permission, …) doesn't show an empty chip.
            // Core catalog categories are always available.
            const cats = new SvelteSet(['movie', 'tv', 'episode']);

            if (!availableCategories) {
                // Not loaded yet — show all to avoid a flash of missing chips.
                return new SvelteSet([
                    'tvchannel',
                    'movie',
                    'tv',
                    'episode',
                    'book',
                    'manga',
                    'comic',
                    'audiobook',
                    'music',
                    'anfragen',
                    'home_video',
                    'training',
                    'educational',
                    'personal',
                ]);
            }

            if (availableCategories.tvchannel) cats.add('tvchannel');
            // Live TV programs are a separate parallel search path (searchPrograms),
            // gated on the user's Live TV permission — still a valid filter chip.
            if ($page.data.features?.liveTV === true && $page.data.user?.hasLiveTvPermission)
                cats.add('livetv_program');
            if (availableCategories.book) cats.add('book');
            if (availableCategories.manga) cats.add('manga');
            if (availableCategories.comic) cats.add('comic');
            if (availableCategories.audiobook) cats.add('audiobook');
            if (availableCategories.music) cats.add('music');
            if (availableCategories.anfragen) cats.add('anfragen');
            if (availableCategories.home_video) cats.add('home_video');
            if (availableCategories.training) cats.add('training');
            if (availableCategories.educational) cats.add('educational');
            if (availableCategories.personal) cats.add('personal');

            return cats;
        })(),
    );
    // =========================================================================
    // Category Configuration
    // =========================================================================

    // Reactive categories for template use (from constants)
    let categories = $derived(getSearchCategories());
    // Core catalog categories always lead the chip row (in this order); every
    // other searchable category follows in its natural constant-array order.
    const CATEGORY_DISPLAY_PRIORITY = ['movie', 'tv', 'episode'];
    // Filtered categories for display (only show what's searchable)
    let displayCategories = $derived(
        categories
            .filter((c) => searchableCategories.has(c.key))
            .sort((a, b) => {
                const ai = CATEGORY_DISPLAY_PRIORITY.indexOf(a.key);
                const bi = CATEGORY_DISPLAY_PRIORITY.indexOf(b.key);
                const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
                const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
                return ar - br;
            }),
    );
    // Check if we have active filters that might be limiting results
    let hasActiveFilters = $derived(selectedCategoryFilters.size > 0);
    // =========================================================================
    // Search Operators (parsed from query)
    // =========================================================================

    // Active search operators (parsed from current query)
    let parsedOperators = $derived(parseSearchOperators(searchQuery));
    let hasCatalogFilters = $derived(
        parsedOperators.yearMin !== undefined ||
            parsedOperators.yearMax !== undefined ||
            parsedOperators.ratingMin !== undefined ||
            !!parsedOperators.genres?.length,
    );
    let hasOperators = $derived(
        parsedOperators.yearMin !== undefined ||
            parsedOperators.ratingMin !== undefined ||
            (parsedOperators.genres !== undefined && parsedOperators.genres.length > 0) ||
            (parsedOperators.exclude !== undefined && parsedOperators.exclude.length > 0),
    );
    // Reactive set of all item keys in playlist (existing + just added)
    let allPlaylistItemKeys = $derived(
        new SvelteSet([
            ...existingPlaylistItems.map((item) => getPlaylistItemKeyFromItem(item)),
            ...addedItemKeys,
        ]),
    );
    // Reactive sections - pass groupedResults and query as dependencies for Svelte reactivity
    // Let floating page controls (the mobile sidebar toggle) step aside while open.
    $effect(() => {
        if (isOpen) return registerSearchOverlay();
    });
    let sections = $derived(
        leadSection(buildSections(groupedResults, parsedOperators.query), leadCategory),
    );
    // Slow sources may contain a stronger match. Wait for every media source,
    // then move its category to the top — unless the user already started
    // exploring. Reordering (not scrolling to it) keeps every other category
    // visible below instead of hiding them above the fold.
    $effect(() => {
        if (isLoading || descriptionLoading || scrollPhase !== 'searching' || selectedIndex >= 0)
            return;
        const bestCategory = findBestMatchCategory(groupedResults);
        if (!bestCategory) return;
        scrollPhase = 'autoScrolled';
        leadCategory = bestCategory;
    });
    let visibleItems = $derived(sections.flatMap((section) => section.items));
    let categoryCounts: Record<string, number> = $derived({
        ...Object.fromEntries(
            Object.entries(groupedResults).map(([key, items]) => [key, items.length]),
        ),
        ...(programSearchResults.length ? { livetv_program: programSearchResults.length } : {}),
    });
    let totalResults = $derived(
        Object.entries(groupedResults).reduce(
            (sum, [key, items]) => sum + (shouldSearchCategory(key) ? items.length : 0),
            0,
        ) + (shouldSearchCategory('livetv_program') ? programSearchResults.length : 0),
    );
    let hasMoreResults = $derived(
        Object.entries(hasMoreByCategory).some(([key, more]) => more && shouldSearchCategory(key)),
    );
    let resultCountLabel = $derived(
        totalResults === 1 && !hasMoreResults
            ? m.search_result_count({ count: 1 })
            : m.search_results_count({ count: `${totalResults}${hasMoreResults ? '+' : ''}` }),
    );
    // Screen-reader announcement of the result count once a search settles
    // (empty while loading or with no query, so it only speaks meaningful counts).
    let resultAnnouncement = $derived(
        isLoading || descriptionLoading || programSearchLoading || !parsedOperators.query
            ? ''
            : searchFailed
              ? m.browse_filter_search_error()
              : totalResults > 0
                ? resultCountLabel
                : m.search_no_results_for({ query: parsedOperators.query }),
    );
    // Compute selected item ID from index
    let selectedItemId = $derived(
        selectedIndex >= 0 && visibleItems[selectedIndex] ? visibleItems[selectedIndex].id : null,
    );
    // Build playlist episode keys for the picker (existing + just added)
    let playlistEpisodeKeysForPicker = $derived(
        new SvelteSet([
            ...existingPlaylistItems
                .filter(
                    (item) =>
                        isEpisode(item.mediaType) &&
                        !!selectedSeries &&
                        (Object.entries(item.seriesExternalIds ?? {}).some(
                            ([provider, id]) =>
                                !!id &&
                                (
                                    selectedSeries?.externalIds as
                                        Record<string, string | undefined> | undefined
                                )?.[provider] === id,
                        ) ||
                            (!!item.seriesName &&
                                item.seriesName ===
                                    (selectedSeries.title || selectedSeries.name))) &&
                        item.seasonNumber !== undefined &&
                        item.episodeNumber !== undefined,
                )
                .map((item) => `${item.seasonNumber}:${item.episodeNumber}`),
            ...pickerAddedEpisodeKeys,
        ]),
    );
    // =========================================================================
    // Reactive Statements
    // =========================================================================

    // Load preferences and available categories when search opens
    $effect(() => {
        if (isOpen) {
            loadFulltextPreference();
            loadAvailableCategories();
            recentSearches = getRecentSearches();
            restoreCategoryFilters();
        }
    });
    $effect(() => {
        if (isOpen) {
            setTimeout(() => searchInput?.focus(), FOCUS_DELAY_MS);
        }
    });
    $effect(() => {
        searchQuery;
        untrack(debounceSearch);
    });
    // Auto-hide search when a modal opens (e.g. clicking a search result).
    // Only hides the overlay — preserves search state and ?q= URL param
    // so the back-to-search flow works when the modal closes.
    $effect(() => {
        if ($hasModals && isOpen && !playlistMode) {
            isOpen = false;
        }
    });
    // Reopen search when all modals close and ?q= is still in the URL
    // (i.e. user navigated back from a modal opened via search)
    $effect(() => {
        if (!$hasModals && !isOpen && browser && syncToUrl) {
            // Don't reopen search when the user clicked Play — the modal-close
            // goto and the player goto race, leaving ?q= briefly in the URL.
            if ($isNavigatingToPlayer) return;
            // Secondary guard: already on the watch page means we navigated
            // successfully; never reopen search on top of the player.
            const watchPrefix = base ? `${base}/watch` : '/watch';
            if (window.location.pathname.startsWith(watchPrefix)) return;
            const urlQuery = new URL(window.location.href).searchParams.get('q');
            if (urlQuery) {
                isOpen = true;
                // Restore searchQuery from URL in case it was lost
                if (!searchQuery) {
                    searchQuery = urlQuery;
                }
            }
        }
    });
</script>

<!-- Handle keyboard at window level when search is open -->
<svelte:window onkeydown={isOpen ? handleKeydown : undefined} />

{#if isOpen}
    <!-- Full-screen overlay -->
    <div
        class="search-overlay fixed inset-0 bg-black/90 backdrop-blur-sm"
        style="z-index: {Z.SEARCH}"
        transition:fade={{ duration: 150 }}
        onclick={closeSearch}
        onkeydown={handleKeydown}
        role="dialog"
        aria-modal="true"
        aria-label={m.common_search()}
        tabindex="-1">
        <!-- Search container -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            use:trapFocus
            class:player-menu={playerMode}
            class="search-modal relative w-full h-full sm:h-auto sm:max-h-[90vh] sm:max-w-3xl sm:mx-auto sm:mt-8 bg-surface-900 sm:rounded-2xl flex flex-col shadow-2xl"
            onclick={stopPropagation()}
            onkeydown={(event) => {
                handleKeydown(event);
                event.stopPropagation();
            }}
            transition:fly={{ y: -20, duration: 200 }}>
            <!-- Search header -->
            <SearchHeader
                bind:searchQuery
                bind:searchInput
                {isLoading}
                {descriptionLoading}
                {fulltextMode}
                onclear={clearSearchQuery}
                ontoggleFulltext={toggleFulltextMode}
                onclose={closeSearch}
                onkeydown={handleInputKeydown} />

            <!-- Screen-reader-only live region: announces the result count when a
                 search settles, so non-visual users know results arrived. -->
            <div class="sr-only" aria-live="polite" aria-atomic="true">
                {selectedIndex >= 0 ? visibleItems[selectedIndex]?.title : resultAnnouncement}
            </div>

            {#snippet filters(centered = false)}
                <SearchFilterBar
                    {centered}
                    {selectedCategoryFilters}
                    {displayCategories}
                    counts={categoryCounts}
                    hasMore={hasMoreByCategory}
                    settled={!centered &&
                        !isLoading &&
                        !descriptionLoading &&
                        loadingCategories.size === 0 &&
                        !programSearchLoading}
                    ontoggleFilter={toggleCategoryFilter}
                    onclearAll={clearCategoryFilters} />
            {/snippet}
            {#if parsedOperators.query.length >= 2 || hasOperators}
                {@render filters()}
            {/if}

            <!-- Active search operators bar -->
            <SearchOperatorsBar {parsedOperators} />
            {#if hasCatalogFilters}
                <p class="px-6 py-2 text-xs text-surface-300">{m.search_catalog_filters_scope()}</p>
            {/if}

            <!-- Results -->
            <div
                {@attach captureScrollContainer}
                role="region"
                aria-label={m.common_search()}
                tabindex="-1"
                class="flex-1 min-h-0 overflow-y-auto overscroll-contain sm:max-h-[75vh] relative">
                {#if playlistMode && playlistAddFeedback.size > 0}
                    <div class="space-y-2 px-6 py-3">
                        {#each [...playlistAddFeedback] as [key, feedback] (key)}
                            <div
                                class="flex flex-wrap items-center gap-2 text-sm"
                                role={feedback.state === 'failed' ? 'alert' : 'status'}>
                                <span class="font-medium">{feedback.item.title}</span>
                                <span
                                    >{feedback.state === 'pending'
                                        ? m.viewer_playlist_adding_item()
                                        : m.viewer_playlist_add_failed()}</span>
                                {#if feedback.state === 'failed'}
                                    <button
                                        type="button"
                                        class="btn btn-sm variant-ghost-primary min-h-11"
                                        onclick={() =>
                                            void addPlaylistItem(feedback.item, feedback.pickerKey)}
                                        >{m.common_retry()}</button>
                                {/if}
                            </div>
                        {/each}
                    </div>
                {/if}
                {#if searchFailed}
                    <div role="alert" class="flex items-center justify-between gap-3 px-6 py-4">
                        <span>{m.browse_filter_search_error()}</span>
                        <button
                            type="button"
                            class="btn btn-sm variant-ghost-primary min-h-11"
                            onclick={() => void performSearch()}>{m.common_retry()}</button>
                    </div>
                {/if}
                {#if selectedSeries}
                    <!-- Episode Picker -->
                    <SeriesEpisodePicker
                        series={selectedSeries}
                        {playlistMode}
                        playlistEpisodeKeys={playlistEpisodeKeysForPicker}
                        onselectEpisode={handleEpisodeSelection}
                        onaddEpisode={handleAddEpisodeFromPicker}
                        onaddSeason={handleAddSeasonFromPicker}
                        onback={handleBackFromEpisodePicker} />
                {:else if parsedOperators.query.length < 2 && !hasOperators}
                    <!-- Initial state -->
                    <SearchEmptyState
                        {recentSearches}
                        onselectRecent={selectRecentSearch}
                        onclearRecent={clearRecent}>
                        {@render filters(true)}
                    </SearchEmptyState>
                {:else if (isLoading || descriptionLoading || programSearchLoading) && totalResults === 0 && programSearchResults.length === 0}
                    <!-- Initial loading - skeleton cards -->
                    <SearchLoadingState searchQuery={parsedOperators.query || searchQuery} />
                {:else if !searchFailed && totalResults === 0 && programSearchResults.length === 0 && !isLoading && !descriptionLoading && loadingCategories.size === 0 && !programSearchLoading}
                    <!-- No results -->
                    <SearchNoResults
                        searchQuery={parsedOperators.query || searchQuery}
                        {hasActiveFilters}
                        {fulltextMode}
                        onincludeDescriptions={toggleFulltextMode}
                        onclearFilters={clearCategoryFilters} />
                {:else}
                    <!-- Search Results - show progressively as they arrive -->
                    <div class="search-results space-y-1 px-3 pb-4 sm:px-4">
                        {#each sections as section (section.id)}
                            {@const categoryKey = section.id.replace('search-', '')}
                            {@const category = getSearchCategory(categoryKey)}
                            {@const itemKeys = createRenderableMediaKeys(section.items)}
                            <div class="py-2 scroll-mt-2" data-search-category={categoryKey}>
                                <h2
                                    class="flex items-center gap-2.5 px-3 pt-2 pb-2 text-base font-semibold {category?.color ??
                                        'text-primary-300'}">
                                    <Icon
                                        src={getCategoryIcon(categoryKey)}
                                        class="h-5 w-5 {category?.iconColor ?? ''}" />
                                    {section.title}
                                    <span
                                        class="rounded-md bg-white/5 px-2 py-0.5 text-xs font-semibold tabular-nums"
                                        >{categoryCounts[categoryKey] ?? 0}{hasMoreByCategory[
                                            categoryKey
                                        ]
                                            ? '+'
                                            : ''}</span>
                                </h2>
                                {#each section.items as item, itemIndex (itemKeys[itemIndex])}
                                    <SearchResultRow
                                        {item}
                                        onopen={() => handleItemOpen(item)}
                                        selected={selectedItemId === item.id}>
                                        <SectionRenderer
                                            section={{
                                                ...section,
                                                title: undefined,
                                                items: [item],
                                            }}
                                            {hasRequestPermission}
                                            showAddButton={playlistMode}
                                            showWatchlistButton={!playlistMode && !watchPartyMode}
                                            {watchlistItemKeys}
                                            {watchlistLoadingKeys}
                                            playlistItemKeys={allPlaylistItemKeys}
                                            onitemClick={handleItemClick}
                                            onitemPlay={handleItemPlay}
                                            onitemRequest={handleItemRequest}
                                            onitemMore={handleItemMore}
                                            onitemAddToPlaylist={handleItemAddToPlaylist}
                                            onitemWatchlist={handleItemWatchlist} />
                                    </SearchResultRow>
                                {/each}
                                {#if selectedCategoryFilters.size === 0 && ((groupedResults[categoryKey]?.length ?? 0) > 3 || hasMoreByCategory[categoryKey])}
                                    <button
                                        onclick={() => {
                                            toggleCategoryFilter(categoryKey);
                                            searchInput?.focus();
                                        }}
                                        class="mx-2 mb-1 rounded-md px-3 py-1.5 text-xs text-primary-300 hover:bg-white/5"
                                        >{m.search_view_category({
                                            category: section.title ?? '',
                                        })}</button>
                                {:else if hasMoreByCategory[categoryKey]}
                                    <div class="px-4 pt-1 pb-2">
                                        <button
                                            onclick={() => loadMoreCategory(categoryKey)}
                                            disabled={loadingMoreCategories.has(categoryKey) ||
                                                (descriptionLoading &&
                                                    DESCRIPTION_CATEGORIES.has(categoryKey))}
                                            class="w-full py-2 text-sm text-surface-400 hover:text-surface-100 bg-surface-800/40 hover:bg-surface-800 rounded-md transition-colors disabled:opacity-50">
                                            {#if loadingMoreCategories.has(categoryKey)}
                                                <span
                                                    class="loading-spinner w-4 h-4 inline-block align-middle"
                                                ></span>
                                            {:else}
                                                {m.section_load_more()}
                                            {/if}
                                        </button>
                                    </div>
                                {/if}
                            </div>
                        {/each}

                        <!-- Program Search Results (separate parallel path) -->
                        {#if shouldSearchCategory('livetv_program') && (programSearchResults.length > 0 || programSearchLoading)}
                            {@const programCat = getSearchCategory('livetv_program')}
                            <div class="py-2" data-search-category="livetv_program">
                                <h2 class="px-3 pt-2 pb-3 flex items-center gap-2.5">
                                    <Icon
                                        src={getCategoryIcon('livetv_program')}
                                        class="w-5 h-5 {programCat?.iconColor ?? 'text-red-400'}" />
                                    <span
                                        class="text-base font-semibold {programCat?.color ??
                                            'text-red-400'}">
                                        {programCat?.label ?? 'Live TV Programs'}
                                    </span>
                                    <span
                                        class="rounded-md bg-white/5 px-2 py-0.5 text-xs font-semibold tabular-nums {programCat?.color ??
                                            'text-red-400'}">{programSearchResults.length}</span>
                                </h2>
                                <div class="px-4">
                                    <ProgramSearchResults
                                        results={programSearchResults}
                                        query={parsedOperators.query || searchQuery}
                                        loading={programSearchLoading} />
                                </div>
                            </div>
                        {/if}

                        <!-- Loading indicators for categories still loading -->
                        {#each categories as cat (cat.key)}
                            {@const IconComponent = getCategoryIcon(cat.key)}
                            {#if loadingCategories.has(cat.key) && !groupedResults[cat.key]?.length}
                                <div class="py-2">
                                    <div class="px-4 py-2 flex items-center gap-2">
                                        <Icon src={IconComponent} class="w-4 h-4 {cat.iconColor}" />
                                        <span
                                            class="text-xs font-semibold uppercase tracking-wider {cat.color}">
                                            {cat.label}
                                        </span>
                                        <div
                                            class="w-3 h-3 border-2 border-current opacity-30 border-t-current rounded-full animate-spin {cat.color}">
                                        </div>
                                        <span class="text-xs text-surface-500"
                                            >{m.search_is_loading()}</span>
                                    </div>
                                </div>
                            {/if}
                        {/each}
                    </div>
                {/if}
            </div>

            {#if !selectedSeries && parsedOperators.query.length < 2 && !hasOperators}<SearchTips />{/if}

            <!-- Footer with keyboard hints -->
            {#if !selectedSeries && (parsedOperators.query.length >= 2 || hasOperators)}
                <div
                    data-search-footer
                    class="flex items-center justify-between gap-3 shrink-0 border-t border-white/5 bg-white/[0.035] px-4 py-2.5 text-xs text-surface-300">
                    <span class="font-medium tabular-nums">{resultCountLabel}</span>
                    <div class="hidden sm:flex items-center gap-3 shrink-0">
                        <span
                            ><kbd class="px-1.5 py-0.5 bg-surface-700 rounded text-surface-300"
                                >↑↓</kbd>
                            {m.search_navigate()}</span>
                        <span
                            ><kbd class="px-1.5 py-0.5 bg-surface-700 rounded text-surface-300"
                                >Enter</kbd>
                            {m.search_open()}</span>
                        <span
                            ><kbd class="px-1.5 py-0.5 bg-surface-700 rounded text-surface-300"
                                >Esc</kbd>
                            {m.close()}</span>
                    </div>
                </div>
            {/if}
        </div>
    </div>
{/if}

<style>
    /* PWA standalone safe area support — push the search modal below the iOS
       status bar / notch and clear of the home indicator. The full-screen
       overlay uses its own classes (not .modal-backdrop), so it needs its own
       safe-area handling. The h-full search-modal inside shrinks to fit the
       padded overlay, so the bottom never overflows. */
    @media (display-mode: standalone) {
        .search-overlay {
            padding-top: env(safe-area-inset-top, 0px);
            padding-bottom: env(safe-area-inset-bottom, 0px);
        }
    }

    /* Smooth scroll for results */
    .overflow-y-auto {
        scroll-behavior: smooth;
        -webkit-overflow-scrolling: touch;
    }

    /* Respect reduced-motion: no smooth scrolling for vestibular-sensitive users. */
    @media (prefers-reduced-motion: reduce) {
        .overflow-y-auto {
            scroll-behavior: auto;
        }
    }

    /* Custom scrollbar */
    .overflow-y-auto::-webkit-scrollbar {
        width: 6px;
    }

    .overflow-y-auto::-webkit-scrollbar-track {
        background: transparent;
    }

    .overflow-y-auto::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.1);
        border-radius: 3px;
    }

    .overflow-y-auto::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.2);
    }

    /* Keyboard shortcut styling */
    kbd {
        font-family: inherit;
        font-size: 0.7rem;
    }

    /* Search results compact styling */
    :global(.search-results .space-y-4) {
        gap: 0.5rem;
    }

    :global(.search-results section) {
        gap: 0.25rem;
    }

    /* Remove extra padding from list section headers in search */
    :global(.search-results .mb-4) {
        margin-bottom: 0.5rem;
    }

    /* Hide scrollbar for horizontal scroll areas */
    .scrollbar-hide {
        -ms-overflow-style: none;
        scrollbar-width: none;
    }
    .scrollbar-hide::-webkit-scrollbar {
        display: none;
    }

    /* Episode not found info */
    .episode-not-found-info {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.25rem;
        padding: 1.5rem;
        background: rgba(var(--color-surface-800-rgb), 0.5);
        border-radius: 1rem;
        border: 1px solid rgba(var(--color-surface-600-rgb), 0.5);
        max-width: 400px;
    }
</style>
