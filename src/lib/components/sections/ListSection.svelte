<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	ListSection.svelte

	Renders vertical list layouts for media items (search results, watchlist, etc.)
	Uses UniversalMediaCard with variant="list" for horizontal card layout.

	@example Watchlist
	<ListSection section={{ type: 'list', items: [...] }} />
-->
<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';

    import { onMount } from 'svelte';
    import { Icon, ArrowPath, ChevronDown, ChevronUp, XMark } from 'svelte-hero-icons';
    import type { PageSection, UniversalMediaItem, SectionMeta } from '$lib/types/server-driven-ui';
    import { createRenderableMediaKeys } from '$lib/utils/media-id-helpers';
    import { getIcon } from '$lib/utils/icon-map';
    import { createCollapseHandler } from '$lib/utils/ui-state';
    import { UniversalMediaCard } from '$lib/components/ui';
    import * as m from '$lib/paraglide/messages';

    import { stopPropagation } from '$lib/utils/event-helpers';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The section data to render */
        section: PageSection;
        /** Show remove button on each item */
        showRemoveButton?: boolean;
        /** Per-item gate for the remove button (default: every item can be removed) */
        canRemoveItem?: (item: UniversalMediaItem) => boolean;
        /** Show "More/Similar" button on each item */
        showMoreButton?: boolean;
        /** ID of the currently selected item for keyboard navigation */
        selectedItemId?: string | null;
        /** Show "Add to Playlist" button on each item */
        showAddButton?: boolean;
        /** Show watchlist bookmark button on each item */
        showWatchlistButton?: boolean;
        /** Set of composite keys for items in the watchlist */
        watchlistItemKeys?: Set<string>;
        /** Set of composite keys for items being saved/removed from watchlist */
        watchlistLoadingKeys?: Set<string>;
        /** Set of item keys that are already in the playlist (for "Added" state) */
        playlistItemKeys?: Set<string>;
        /** Whether the user has permission to make requests (hides request buttons if false) */
        hasRequestPermission?: boolean;
        // Callbacks
        onitemClick?: (item: UniversalMediaItem) => void;
        onitemPlay?: (item: UniversalMediaItem) => void;
        onitemRequest?: (item: UniversalMediaItem) => void;
        onitemMore?: (item: UniversalMediaItem) => void;
        onitemRemove?: (item: UniversalMediaItem) => void;
        onitemAddToPlaylist?: (item: UniversalMediaItem) => void;
        onitemWatchlist?: (item: UniversalMediaItem) => void;
        onrefresh?: () => void;
        oncollapse?: (collapsed: boolean) => void;
    }

    let {
        section,
        showRemoveButton = true,
        canRemoveItem = () => true,
        showMoreButton = true,
        selectedItemId = null,
        showAddButton = false,
        showWatchlistButton = false,
        watchlistItemKeys = new SvelteSet(),
        watchlistLoadingKeys = new SvelteSet(),
        playlistItemKeys = new SvelteSet(),
        hasRequestPermission = true,
        onitemClick,
        onitemPlay,
        onitemRequest,
        onitemMore,
        onitemRemove,
        onitemAddToPlaylist,
        onitemWatchlist,
        onrefresh,
        oncollapse,
    }: Props = $props();

    // =========================================================================
    // Internal State
    // =========================================================================

    let isCollapsed = $state(false);
    let isRefreshing = $state(false);
    let meta = $derived(section.meta || {}) as SectionMeta;
    let iconName = $derived(meta.icon);
    type SectionIcon = typeof Icon;
    let iconComponent = $derived(iconName ? (getIcon(iconName) as SectionIcon) || null : null);

    // =========================================================================
    // Computed Values
    // =========================================================================

    let isCollapsible = $derived(meta.collapsible ?? false);
    let showRefresh = $derived(meta.showRefresh ?? false);
    let iconColor = $derived(meta.iconColor || 'text-primary-400');
    let subtitle = $derived(meta.subtitle);
    let isLoading = $derived(meta.loading ?? false);
    let errorMessage = $derived(meta.error);
    let itemCount = $derived(meta.count ?? section.items.length);
    let renderItemKeys = $derived(createRenderableMediaKeys(section.items));

    // Get icon component

    // Collapse handler with localStorage persistence
    let collapseHandler = $derived(
        meta.collapseKey ? createCollapseHandler(meta.collapseKey) : null,
    );

    // =========================================================================
    // Lifecycle
    // =========================================================================

    onMount(() => {
        // Load saved collapse state
        if (collapseHandler) {
            isCollapsed = collapseHandler.loadState();
        } else if (meta.defaultCollapsed) {
            isCollapsed = meta.defaultCollapsed;
        }
    });

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function toggleCollapse() {
        if (!isCollapsible) return;

        if (collapseHandler) {
            isCollapsed = collapseHandler.toggle(isCollapsed);
        } else {
            isCollapsed = !isCollapsed;
        }

        oncollapse?.(isCollapsed);
    }

    function handleRefresh() {
        if (isRefreshing) return;
        isRefreshing = true;
        onrefresh?.();

        // Reset refreshing state after animation
        setTimeout(() => {
            isRefreshing = false;
        }, 1000);
    }

    function handleItemClick(item: UniversalMediaItem) {
        onitemClick?.(item);
    }

    function handleItemPlay(item: UniversalMediaItem) {
        onitemPlay?.(item);
    }

    function handleItemRequest(item: UniversalMediaItem) {
        onitemRequest?.(item);
    }

    function handleItemMore(item: UniversalMediaItem) {
        onitemMore?.(item);
    }

    function handleItemRemove(item: UniversalMediaItem) {
        onitemRemove?.(item);
    }

    function handleItemAddToPlaylist(item: UniversalMediaItem) {
        console.log('[ListSection] handleItemAddToPlaylist received:', item.title);
        onitemAddToPlaylist?.(item);
    }

    function handleItemWatchlist(item: UniversalMediaItem) {
        onitemWatchlist?.(item);
    }
</script>

<section class="space-y-4">
    <!-- Section Header -->
    {#if section.title}
        <div class="flex items-center gap-2 mb-4">
            <!-- Icon -->
            {#if iconComponent}
                <Icon src={iconComponent} class="w-5 h-5 {iconColor}" />
            {/if}

            <!-- Title -->
            <h2 class="text-xl font-semibold text-white">{section.title}</h2>

            <!-- Item count badge -->
            {#if itemCount > 0}
                <span class="text-xs bg-primary-600 text-white px-2 py-1 rounded">
                    {itemCount}
                    {itemCount === 1 ? m.section_item() : m.section_items()}
                </span>
            {/if}

            <!-- Subtitle -->
            {#if subtitle}
                <span class="text-muted ml-2">{subtitle}</span>
            {/if}

            <!-- Header Actions -->
            <div class="ml-auto flex gap-1">
                <!-- Refresh Button -->
                {#if showRefresh}
                    <button
                        class="p-1 hover:bg-gray-700 rounded-full transition-colors"
                        onclick={handleRefresh}
                        disabled={isRefreshing || isLoading}
                        title={m.section_refresh()}>
                        <Icon
                            src={ArrowPath}
                            class="w-4 h-4 text-gray-400 hover:text-white {isRefreshing || isLoading
                                ? 'animate-spin'
                                : ''}" />
                    </button>
                {/if}

                <!-- Collapse Toggle -->
                {#if isCollapsible}
                    <button
                        class="p-1 hover:bg-gray-700 rounded-full transition-colors"
                        onclick={toggleCollapse}
                        title={isCollapsed ? m.section_expand() : m.section_collapse()}>
                        <Icon
                            src={isCollapsed ? ChevronDown : ChevronUp}
                            class="w-4 h-4 text-gray-400 hover:text-white" />
                    </button>
                {/if}
            </div>
        </div>
    {/if}

    <!-- Content -->
    {#if !isCollapsed}
        <!-- Loading State -->
        {#if isLoading && section.items.length === 0}
            <div class="center py-8">
                <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
                <span class="ml-3 text-gray-300">{m.section_loading()}</span>
            </div>

            <!-- Error State -->
        {:else if errorMessage}
            <div class="section-error">
                <div class="flex items-center gap-2">
                    <Icon src={XMark} class="w-5 h-5 text-red-400" />
                    <span class="text-red-300">{errorMessage}</span>
                </div>
            </div>

            <!-- Empty State -->
        {:else if section.items.length === 0}
            <div class="bg-gray-800/50 border border-gray-600 rounded-lg p-6 text-center">
                {#if iconComponent}
                    <Icon src={iconComponent} class="w-12 h-12 text-gray-500 mx-auto mb-3" />
                {/if}
                <h3 class="text-gray-300 font-medium mb-2">
                    {m.section_no_entries()}
                </h3>
                <p class="text-muted">
                    {#if section.type === 'watchlist'}
                        {m.section_add_to_watchlist()}
                    {:else}
                        {m.section_no_content_available()}
                    {/if}
                </p>
            </div>

            <!-- List Items -->
        {:else}
            <div class="space-y-2">
                {#each section.items as item, index (renderItemKeys[index])}
                    {@const isSelected = selectedItemId === item.id}
                    <div
                        class="animate-in slide-in-from-top-1 duration-300 rounded-lg transition-colors {isSelected
                            ? 'ring-2 ring-primary-500 bg-primary-500/10'
                            : ''}"
                        data-search-item-id={item.id}>
                        <UniversalMediaCard
                            {item}
                            variant="list"
                            {showAddButton}
                            {showWatchlistButton}
                            {watchlistItemKeys}
                            {watchlistLoadingKeys}
                            {showMoreButton}
                            {playlistItemKeys}
                            {hasRequestPermission}
                            onclick={handleItemClick}
                            onplay={handleItemPlay}
                            onrequest={handleItemRequest}
                            onmore={handleItemMore}
                            onaddToPlaylist={handleItemAddToPlaylist}
                            onwatchlist={handleItemWatchlist}>
                            {#snippet actions()}
                                <!-- Remove button, rendered into the card's actions slot -->
                                {#if showRemoveButton && canRemoveItem(item)}
                                    <button
                                        onclick={stopPropagation(() => handleItemRemove(item))}
                                        class="p-1 hover:bg-red-600 rounded transition-colors"
                                        title={m.section_remove()}>
                                        <Icon
                                            src={XMark}
                                            class="w-4 h-4 text-gray-400 hover:text-white" />
                                    </button>
                                {/if}
                            {/snippet}
                        </UniversalMediaCard>
                    </div>
                {/each}
            </div>
        {/if}
    {/if}
</section>

<style lang="postcss">
    /* Slide-in animation for list items */
    @keyframes slide-in-from-top {
        from {
            opacity: 0;
            transform: translateY(-0.25rem);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    .animate-in {
        animation: slide-in-from-top 0.3s ease-out;
    }

    /* Animation distance already defined in @keyframes above */
    .slide-in-from-top-1 {
        /* Marker class - animation values in keyframes */
    }
</style>
