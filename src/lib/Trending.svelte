<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	Trending.svelte

	Displays trending content from various sources (TMDB, local library, MDBList curated lists).
	Uses Server-Driven UI architecture with SectionRenderer.

	@example Default Trending
	<Trending />

	@example Movies Only from TMDB
	<Trending type="movies" source="tmdb" />
-->
<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    import { onMount, onDestroy } from 'svelte';
    import { browser } from '$app/environment';
    import { SectionRenderer } from '$lib/components/sections';
    import type {
        PageSection,
        UniversalMediaItem,
        SectionFilterGroup,
    } from '$lib/types/server-driven-ui';
    import { mediaPreviewToUniversal } from '$lib/utils/media-preview';
    import { mediaCompositeKey, buildMediaKey } from '$lib/utils/media-id-helpers';
    import { seenAboveRank, TRENDING_WIDGET_RANK } from '$lib/stores/seen-media.svelte';
    import { isSeries } from '$lib/shared/media-types';
    import { openMediaModal, handleRequestAction } from '$lib/utils/modal-utils';
    import {
        handleItemPlay as handleItemPlayShared,
        handleItemMore as handleItemMoreShared,
    } from '$lib/components/foryou/item-handlers';
    import { page } from '$app/stores';
    import { env } from '$env/dynamic/public';
    import * as m from '$lib/paraglide/messages';
    import * as contentApi from '$lib/api/content';
    import { trendingAvailable } from '$lib/stores/trending-availability';

    // Feature flags from layout data
    let requestsEnabled = $derived($page.data?.features?.requests === true);
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    const requestUrl = env.PUBLIC_REQUESTURL || '';

    // =========================================================================
    // Types
    // =========================================================================

    interface CuratedList {
        id: string;
        name: string;
        description?: string;
        itemCount?: number;
        lastSyncedAt?: string | null;
    }

    // =========================================================================
    // Props

    interface Props {
        // =========================================================================
        type?: 'all' | 'movies' | 'tv';
        source?: 'hybrid' | 'tmdb' | 'jellyfin';
        limit?: number;
    }

    let { type = 'all', source = 'hybrid', limit = 20 }: Props = $props();

    // =========================================================================
    // Types (local)
    // =========================================================================

    // =========================================================================
    // State
    // =========================================================================

    let trendingItems: UniversalMediaItem[] = $state([]);
    let loading = $state(true);
    let error = $state<string | null>(null);
    /** When true, the selected list doesn't exist yet (not synced). Hide the section entirely. */
    let listNotFound = $state(false);
    let refreshing = false;
    let itemsRequestSequence = 0;
    onDestroy(() => {
        itemsRequestSequence++;
    });

    // Curated lists
    let availableLists: CuratedList[] = $state([]);
    let selectedListId: string = $state('');
    let loadingLists = $state(false);
    let listsSyncing = $state(false);
    /** Settles once the curated-list index has loaded (or failed). */
    let listsLoaded: Promise<void> = Promise.resolve();

    // =========================================================================
    // Data Loading
    // =========================================================================

    async function loadAvailableLists() {
        if (!browser) return;

        loadingLists = true;
        try {
            const { data } = await contentApi.getLists();
            if (data) {
                availableLists = (data.items || []) as CuratedList[];
                listsSyncing = data.syncing || false;
            }
        } catch (e) {
            console.error('Failed to load curated lists:', e);
        } finally {
            loadingLists = false;
        }
    }

    async function loadListItems(listId: string) {
        if (!browser || !listId) return;

        const sequence = ++itemsRequestSequence;
        loading = true;
        error = null;
        listNotFound = false;

        try {
            const { data, error: apiError, status } = await contentApi.getListItems(listId, limit);
            if (sequence !== itemsRequestSequence) return;
            if (data) {
                trendingItems = data.items.map(mediaPreviewToUniversal);
            } else if (status === 404) {
                // List hasn't been synced yet — not an error, just hide the section
                listNotFound = true;
                trendingItems = [];
            } else {
                error = apiError || 'Failed to load list items';
            }
        } catch (e) {
            if (sequence !== itemsRequestSequence) return;
            error = e instanceof Error ? e.message : 'Unknown error';
            console.error('Failed to load list items:', e);
        } finally {
            if (sequence === itemsRequestSequence) loading = false;
        }
    }

    // Default list to use when TMDB trending returns empty
    const DEFAULT_FALLBACK_LIST = 'trending-movies';

    async function loadTrending() {
        if (!browser) return;

        const sequence = ++itemsRequestSequence;
        loading = true;
        error = null;
        listNotFound = false;

        try {
            const { data, error: apiError } = await contentApi.getTrending(type, source, limit);
            if (sequence !== itemsRequestSequence) return;

            if (data) {
                // New contract: {items, page} where items are RecommendationItem shape.
                // Normalize to TrendingItem so transformTrendingItem() works unchanged.
                trendingItems = data.items.map(mediaPreviewToUniversal);

                // Fallback to default curated list if trending returns empty
                if (trendingItems.length === 0 && !selectedListId) {
                    // Only fall back to a list that has items: the index lists every
                    // CONFIGURED list, synced or not, and on a fresh install none is
                    // synced yet — the item route 404s those, a console error on
                    // every Home load.
                    await listsLoaded;
                    if (sequence !== itemsRequestSequence) return;
                    const fallback = availableLists.find((l) => l.id === DEFAULT_FALLBACK_LIST);
                    if (!fallback || !(fallback.itemCount && fallback.itemCount > 0)) {
                        listNotFound = true;
                        return;
                    }
                    console.log('[Trending] Trending empty, falling back to curated list');
                    selectedListId = DEFAULT_FALLBACK_LIST;
                    await loadListItems(DEFAULT_FALLBACK_LIST);
                    return;
                }
            } else {
                error = apiError || 'Failed to load trending items';
            }
        } catch (e) {
            if (sequence !== itemsRequestSequence) return;
            error = e instanceof Error ? e.message : 'Unknown error';
            console.error('Failed to load trending:', e);
        } finally {
            if (sequence === itemsRequestSequence) loading = false;
        }
    }

    async function refreshTrending() {
        if (!browser || refreshing) return;

        refreshing = true;
        try {
            await contentApi.clearTrendingCache();
            if (selectedListId) {
                await loadListItems(selectedListId);
            } else {
                await loadTrending();
            }
        } catch (e) {
            console.error('Failed to refresh trending:', e);
        } finally {
            refreshing = false;
        }
    }

    // =========================================================================
    // Transformers
    // =========================================================================

    // =========================================================================
    // Section Builder
    // =========================================================================

    // Type for dropdown group configuration
    interface DropdownGroupConfig {
        groups: Array<{ id: string; label: string; listIds: string[] }>;
        hiddenLists: string[];
    }

    // Default dropdown groups (used when no config is set)
    const DEFAULT_DROPDOWN_GROUPS: DropdownGroupConfig = {
        groups: [
            {
                id: 'streaming',
                label: 'Streaming',
                listIds: [
                    'netflix-movies',
                    'netflix-shows',
                    'disney-movies',
                    'disney-shows',
                    'amazon-prime-movies',
                    'amazon-prime-shows',
                    'hbo-shows',
                    'apple-tv-movies',
                    'apple-tv-all',
                ],
            },
            {
                id: 'trending',
                label: m.trending(),
                listIds: ['trending-movies', 'trending-shows', 'popular-movies', 'popular-shows'],
            },
            {
                id: 'curated',
                label: 'Curated',
                listIds: ['certified-fresh', 'box-office'],
            },
            {
                id: 'anime',
                label: 'Anime',
                listIds: ['latest-anime', 'latest-anime-movies'],
            },
        ],
        hiddenLists: [],
    };

    function getDropdownGroups(): SectionFilterGroup[] {
        // Get config from page data with fallback to defaults
        const rawConfig = $page.data.trending?.dropdownGroups;
        const dropdownConfig: DropdownGroupConfig =
            rawConfig &&
            'groups' in rawConfig &&
            Array.isArray(rawConfig.groups) &&
            'hiddenLists' in rawConfig
                ? (rawConfig as unknown as DropdownGroupConfig)
                : DEFAULT_DROPDOWN_GROUPS;
        const nameOverrides: Record<string, string> = $page.data.trending?.listNames ?? {};
        const hiddenLists = new SvelteSet(dropdownConfig.hiddenLists ?? []);

        return dropdownConfig.groups
            .map((group) => ({
                label: group.label,
                options: availableLists
                    .filter((l) => group.listIds.includes(l.id) && !hiddenLists.has(l.id))
                    .map((l) => ({
                        value: l.id,
                        label: nameOverrides[l.id] || l.name,
                    })),
            }))
            .filter((g) => g.options.length > 0);
    }

    function getDefaultTitle(): string {
        // The header sits next to a scope dropdown that already communicates
        // global vs. local, so the "(Global)"/"(Local)" suffix is redundant —
        // deliberately dropped. Every scope renders as just "Trending".
        return m.trending();
    }

    function buildSection(
        _items: UniversalMediaItem[],
        _loading: boolean,
        _error: string | null,
        _lists: CuratedList[],
        _selectedList: string,
        _syncing: boolean,
        _loadingLists: boolean,
    ): PageSection {
        return {
            id: 'trending',
            type: 'carousel',
            title: _selectedList ? undefined : getDefaultTitle(), // Title comes from filter when selected
            items: _items,
            meta: {
                icon: 'fire',
                iconColor: 'text-warning-500',
                accentColor: 'warning',
                collapsible: true,
                collapseKey: 'trending-collapsed',
                showRefresh: true,
                loading: _loading && _items.length === 0,
                loadingFilters: _loadingLists,
                syncing: _syncing,
                error: _error || undefined,
                filterGroups: _lists.length > 0 ? getDropdownGroups() : [],
                filterPlaceholder: m.trending(),
                activeFilter: _selectedList,
            },
        };
    }

    // =========================================================================
    // Cross-rail de-duplication (home page)
    //
    // On the home page this widget renders BELOW the For You feed, whose
    // "New Releases" (fresh-releases) rail can surface the same popular titles
    // we're about to show. The feed records what it renders in the seen-media
    // registry; here we thin any trending item already shown above us.
    //
    // This is a `$derived` over the reactive registry, so if the For You feed
    // streams in AFTER trending has already resolved, the late markSeen re-runs
    // this filter (accepted tradeoff: a one-time settle/reflow of the rail is
    // possible right after first paint; we don't gate it on scroll/interaction
    // to keep this small).
    //
    // Backfill: dedup is preferential, not destructive — if thinning would drop
    // the rail below MIN_TRENDING_ITEMS, we top it back up with the removed
    // items in their original order so the rail never collapses to a stub.
    // Keys use buildMediaKey (UUID-first → tmdb composite), matching the For You
    // feed's own dedup keys.
    // =========================================================================
    const MIN_TRENDING_ITEMS = 5;

    let displayItems = $derived.by(() => {
        const seen = seenAboveRank(TRENDING_WIDGET_RANK);
        if (seen.size === 0) return trendingItems;

        const kept: UniversalMediaItem[] = [];
        const dropped: UniversalMediaItem[] = [];
        for (const item of trendingItems) {
            const key = buildMediaKey(item.externalIds, item.mediaType) ?? item.id;
            if (key && seen.has(key)) dropped.push(item);
            else kept.push(item);
        }

        // Top up to a sane minimum with the filtered-out items (original order).
        if (kept.length < MIN_TRENDING_ITEMS) {
            return [...kept, ...dropped.slice(0, MIN_TRENDING_ITEMS - kept.length)];
        }
        return kept;
    });

    // Reactive section - explicitly pass all dependencies so Svelte tracks them
    let section = $derived(
        buildSection(
            displayItems,
            loading,
            error,
            availableLists,
            selectedListId,
            listsSyncing,
            loadingLists,
        ),
    );

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function handleFilterChange(data: { section: PageSection; filter: string }) {
        selectedListId = data.filter;
        trendingItems = [];

        if (selectedListId) {
            loadListItems(selectedListId);
        } else {
            loadTrending();
        }
    }

    function handleItemClick(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        const imageUrl = item.image;

        openMediaModal(
            {
                // Provider-agnostic external IDs
                externalIds: item.externalIds,
                mediaType: item.mediaType,
                title: item.title,
                overview: item.overview || '',
                rating: typeof item.rating === 'number' ? item.rating : undefined,
                isAvailable: item.isAvailable,
                genres: (item.clickData?.genres as number[] | string[]) || [],
                canRequest: item.canRequest,
                rtAudience: item.clickData?.rtAudience as number | undefined,
                letterboxdRating: item.clickData?.letterboxdRating as number | undefined,
                letterboxdVotes: item.clickData?.letterboxdVotes as number | undefined,
                metacriticScore: item.clickData?.metacriticScore as number | undefined,
                traktScore: item.clickData?.traktScore as number | undefined,
                mdblistScore: item.clickData?.mdblistScore as number | undefined,
            },
            imageUrl,
        );
    }

    function handleRefresh(_data: { section: PageSection }) {
        refreshTrending();
    }

    function handleItemRequest(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        // Validation now in handleRequestAction (provider-agnostic)
        handleRequestAction(
            {
                externalIds: item.externalIds,
                mediaType: item.mediaType,
                title: item.title,
                posterPath: item.image,
                year: String(item.year ?? ''),
            },
            requestsEnabled,
            requestUrl,
            hasRequestPermission,
        );
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    // Tell the Continue-Watching empty card whether "Browse trending" leads
    // anywhere: only once a load has settled without error (an error says nothing
    // about the catalogue). A hidden (unsynced-list) or empty row means "no".
    $effect(() => {
        if (loading || error) return;
        trendingAvailable.set(!listNotFound && trendingItems.length > 0);
    });

    onDestroy(() => trendingAvailable.set(null));

    onMount(() => {
        listsLoaded = loadAvailableLists();
        loadTrending();

        // Auto-refresh every 5 minutes — skip when tab is hidden so we don't
        // refetch a list nobody is looking at.
        const interval = setInterval(
            () => {
                if (typeof document !== 'undefined' && document.hidden) return;
                if (selectedListId) {
                    loadListItems(selectedListId);
                } else {
                    loadTrending();
                }
            },
            5 * 60 * 1000,
        );

        return () => clearInterval(interval);
    });
</script>

{#if !listNotFound}
    <SectionRenderer
        {section}
        {hasRequestPermission}
        onfilterChange={handleFilterChange}
        onitemClick={handleItemClick}
        onitemPlay={(d) =>
            handleItemPlayShared(d, requestsEnabled, requestUrl, hasRequestPermission)}
        onitemRequest={handleItemRequest}
        onitemMore={handleItemMoreShared}
        onrefresh={handleRefresh} />
{/if}
