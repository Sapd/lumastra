<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	Watchlist.svelte

	Displays user's saved movies and TV shows from the AI database.
	Uses Server-Driven UI architecture with SectionRenderer and ListSection.

	@example
	<Watchlist bind:this={watchlistRef} />
	watchlistRef.refresh();
-->
<script lang="ts">
    import { SvelteDate } from 'svelte/reactivity';
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import { goto } from '$app/navigation';
    import { env } from '$env/dynamic/public';
    import { SectionRenderer } from '$lib/components/sections';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import {
        watchlistItems,
        watchlistState,
        setWatchlistState,
        addToWatchlistStore,
        type WatchlistItem,
    } from '$lib/stores/watchlist';
    import { ensureWatchlistHydrated } from '$lib/services/watchlist-hydrate.service';
    import { openMediaModal, handleRequestAction } from '$lib/utils/modal-utils';
    import {
        mediaCompositeKey,
        hasValidExternalId,
        buildMediaKey,
        getPlayableId,
    } from '$lib/utils/media-id-helpers';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { isSeries } from '$lib/shared/media-types';
    import { MOVIE_OR_TV_TO_CARD } from '$lib/utils/media-types';
    import { removeFromWatchlistStore } from '$lib/stores/watchlist';
    import { navigateToWatch } from '$lib/stores/watch-navigation';
    import { page } from '$app/stores';
    import * as aiApi from '$lib/api/ai';
    import * as m from '$lib/paraglide/messages';

    // Feature flags for request modal and permission
    let requestsEnabled = $derived($page.data?.features?.requests === true);
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);

    // =========================================================================
    // Store Subscriptions
    // =========================================================================

    let currentWatchlistItems = $derived($watchlistItems);
    let currentWatchlistState = $derived($watchlistState);

    // =========================================================================
    // Wire → store adapter
    // =========================================================================

    // The wire → store adapter (`toWatchlistStoreItem`) now lives in
    // $lib/services/watchlist-hydrate.service, next to the loader that is
    // shared with the app-wide hydration this page no longer owns alone.

    // =========================================================================
    // Data Loading
    // =========================================================================

    /**
     * Always refetch (`force`), never the once-per-session memo: this page IS
     * the watchlist, so a mount or an explicit refresh() must show server
     * truth even if the layout already hydrated the store at idle. The service
     * owns the loading/error/isDatabaseAvailable transitions this page renders.
     */
    const loadWatchlist = async () => {
        await ensureWatchlistHydrated({ force: true });
    };

    const removeFromWatchlist = async (item: WatchlistItem) => {
        try {
            const { error } = await aiApi.unsaveMovie({
                externalIds: item.externalIds,
                mediaType: item.mediaType,
            });

            if (!error) {
                // Remove from store immediately for better UX
                // Use composite key (externalIds + mediaType) to avoid TMDB ID collisions
                removeFromWatchlistStore(item.externalIds, item.mediaType);
            }
        } catch (err) {
            console.error('Failed to remove from watchlist:', err);
        }
    };

    const handleRequest = (item: UniversalMediaItem) => {
        handleRequestAction(
            {
                externalIds: item.externalIds,
                mediaType: item.mediaType,
                title: item.title,
                posterPath: item.image,
                year: String(item.year ?? ''),
            },
            requestsEnabled,
            env.PUBLIC_REQUESTURL || '',
            hasRequestPermission,
        );
    };

    const handlePlay = (item: UniversalMediaItem) => {
        const playableId = getPlayableId(item);
        if (browser && playableId) {
            const key = buildMediaKey(item.externalIds, item.mediaType) ?? playableId;
            void navigateToWatch(key);
        }
    };

    // =========================================================================
    // Transformers
    // =========================================================================

    function transformWatchlistItem(item: WatchlistItem): UniversalMediaItem {
        return {
            id: `watchlist-${mediaCompositeKey(item.externalIds, item.mediaType, item.title)}`,
            externalIds: item.externalIds,
            // Store keeps TMDB 'tv' (its own dedup keys depend on it); the card
            // contract emits 'series'.
            mediaType: MOVIE_OR_TV_TO_CARD[item.mediaType],
            title: item.title ?? 'Unknown',
            subtitle: item.savedAt
                ? `Added ${new SvelteDate(item.savedAt).toLocaleDateString()}`
                : undefined,
            image: hasValidExternalId(item.externalIds)
                ? (imageFromIds(item.externalIds, 'poster', item.mediaType, { size: 'thumb' }) ??
                  '')
                : '',
            overview: item.overview,
            isAvailable: item.isAvailable ?? false,
            canRequest: item.canRequest || !!env.PUBLIC_REQUESTURL,
            rating: item.rating
                ? typeof item.rating === 'number'
                    ? item.rating
                    : Number.parseFloat(item.rating)
                : undefined,
            criticRating: item.rtCritic ?? item.criticRating ?? undefined,
            audienceRating: item.rtAudience ?? undefined,
            letterboxdRating: item.letterboxdRating ?? undefined,
            letterboxdVotes: item.letterboxdVotes ?? undefined,
            clickData: {
                criticRating: item.criticRating,
                genres: [],
            },
        };
    }

    // =========================================================================
    // Section Builder
    // =========================================================================

    function buildSection(): PageSection {
        const items = currentWatchlistItems || [];
        return {
            id: 'watchlist',
            type: 'list',
            title: m.watchlist(),
            items: items.map(transformWatchlistItem),
            meta: {
                icon: 'bookmark',
                iconColor: 'text-blue-400',
                collapsible: true,
                collapseKey: 'watchlist-collapsed',
                showRefresh: true,
                loading: currentWatchlistState?.loading && items.length === 0,
                error: currentWatchlistState?.error || undefined,
                count: items.length,
            },
        };
    }

    // Reactive section - explicitly depend on currentWatchlistItems, currentWatchlistState
    let section = $derived(
        (() => {
            void currentWatchlistItems;
            void currentWatchlistState;
            return buildSection();
        })(),
    );

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function handleItemClick(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        const imageUrl = item.image;

        openMediaModal(
            {
                externalIds: item.externalIds,
                mediaType: item.mediaType,
                title: item.title,
                overview: item.overview || '',
                rating: typeof item.rating === 'number' ? item.rating : undefined,
                isAvailable: item.isAvailable,
                criticRating: item.criticRating,
                genres: (item.clickData?.genres as string[]) || [],
            },
            imageUrl,
        );
    }

    function handleItemRemove(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        if (item.externalIds) {
            // Create a minimal WatchlistItem for removal.
            // `item` is a UniversalMediaItem, whose mediaType models 'series'
            // and 'episode' too — collapse it the same way toWatchlistStoreItem
            // does rather than asserting, so the composite key removeFromWatchlist
            // builds matches the 'movie' | 'tv' the store actually holds.
            const watchlistItem: WatchlistItem = {
                externalIds: item.externalIds,
                mediaType: isSeries(item.mediaType) ? 'tv' : 'movie',
                title: item.title,
                canRequest: item.canRequest ?? false,
                isAvailable: item.isAvailable ?? false,
                savedAt: new SvelteDate().toISOString(),
            };
            removeFromWatchlist(watchlistItem);
        }
    }

    function handleItemPlay(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        if (getPlayableId(item)) {
            handlePlay(item);
        }
    }

    function handleItemRequest(data: { section: PageSection; item: UniversalMediaItem }) {
        const item = data.item;
        handleRequest(item);
    }

    function handleRefresh(_data: { section: PageSection }) {
        loadWatchlist();
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    onMount(async () => {
        await loadWatchlist();
    });

    // =========================================================================
    // Exported Functions
    // =========================================================================

    /** Refresh the watchlist data */
    export function refresh() {
        loadWatchlist();
    }

    /** Check if database is available */
    export function getDatabaseAvailable() {
        return $watchlistState.isDatabaseAvailable;
    }

    /** Immediately add an item (for instant feedback from other components) */
    export function addItemImmediately(item: WatchlistItem) {
        console.log('[Watchlist] addItemImmediately called with:', item);

        // If database wasn't available before but we're getting items, mark it as available
        if (!$watchlistState.isDatabaseAvailable) {
            console.log('[Watchlist] Database now available, updating status');
            setWatchlistState({ isDatabaseAvailable: true, error: '' });
        }

        // Use store function to add item
        addToWatchlistStore(item);
    }
</script>

<div class="watchlist-widget">
    {#if $watchlistState.isDatabaseAvailable || $watchlistState.loading}
        <SectionRenderer
            {section}
            {hasRequestPermission}
            onitemClick={handleItemClick}
            onitemPlay={handleItemPlay}
            onitemRequest={handleItemRequest}
            onitemRemove={handleItemRemove}
            onrefresh={handleRefresh} />
    {:else}
        <!-- Database not available - show minimal message -->
        <div class="text-center py-4 text-gray-500 text-sm">
            Watchlist requires AI database connection
        </div>
    {/if}
</div>

<style lang="postcss">
    /* Component uses WatchlistSection which handles its own styling */
</style>
