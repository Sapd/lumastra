<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	SectionRenderer.svelte

	A switch component that renders the appropriate section component
	based on the PageSection type. This is the main entry point for
	rendering server-driven UI sections.

	@example
	<SectionRenderer {section} onitemClick={handleClick} />

	@example Multiple sections
	{#each page.sections as section (section.id)}
		<SectionRenderer {section} />
	{/each}
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';

    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';

    // Section Components
    import StandardSection from './StandardSection.svelte';
    import ListSection from './ListSection.svelte';
    import HeroSection from './HeroSection.svelte';
    import CalendarSection from './CalendarSection.svelte';
    import LiveSessionSection from './LiveSessionSection.svelte';
    import KeywordChipsSection from './KeywordChipsSection.svelte';
    import FeaturedPickSection from './FeaturedPickSection.svelte';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The section data to render */
        section: PageSection;
        /** Optional inline controls beside a standard section's title. */
        headerControls?: Snippet;
        /** ID of the currently selected item for keyboard navigation (list sections only) */
        selectedItemId?: string | null;
        /** Per-item gate for the remove button on list items (default: all removable) */
        canRemoveItem?: (item: UniversalMediaItem) => boolean;
        /** Show "Add to Playlist" button on list items (for playlist mode in search) */
        showAddButton?: boolean;
        /** Show watchlist bookmark button on list items */
        showWatchlistButton?: boolean;
        /** Set of composite keys for items in the watchlist */
        watchlistItemKeys?: Set<string>;
        /** Set of composite keys for items being saved/removed from watchlist */
        watchlistLoadingKeys?: Set<string>;
        /** Set of item keys that are already in the playlist (for "Added" state) */
        playlistItemKeys?: Set<string>;
        /** Whether the user has permission to make requests (hides request buttons if false) */
        hasRequestPermission?: boolean;
        /** Callback when item is clicked */
        onitemClick?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        /** Callback when item play is clicked */
        onitemPlay?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        /** Callback when item request is clicked */
        onitemRequest?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        /** Callback when item more is clicked */
        onitemMore?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        /** Callback when item remove is clicked */
        onitemRemove?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        /** Callback when "Mark as watched" menu action is selected */
        onitemMarkWatched?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        /** Callback when item is added to playlist */
        onitemAddToPlaylist?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        /** Callback when item watchlist button is clicked */
        onitemWatchlist?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        /** Callback when clear all is clicked */
        onclearAll?: (data: { section: PageSection }) => void;
        /** Callback when refresh is requested */
        onrefresh?: (data: { section: PageSection }) => void;
        /** Callback when filter changes */
        onfilterChange?: (data: { section: PageSection; filter: string }) => void;
        /** Callback when section is collapsed/expanded */
        oncollapse?: (data: { section: PageSection; collapsed: boolean }) => void;
        /** Callback when a section's horizontal carousel nears its right edge */
        onsectionReachEnd?: (data: { section: PageSection }) => void;
        /** When true, StandardSection renders a "Load more" button in its header */
        canLoadMore?: boolean;
        /** When true, the next "load more" batch is in flight */
        loadingMore?: boolean;
        /**
         * How many of the first cards should render with priority=true
         * (loading=eager + fetchpriority=high). Pass a small positive
         * number for the first/above-the-fold section on a page so its
         * initial cards get fetched ahead of off-screen lazy images.
         * Forwarded to StandardSection; ignored by other section types.
         */
        priorityCount?: number;
    }

    let {
        section,
        headerControls,
        selectedItemId = null,
        canRemoveItem = () => true,
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
        onitemMarkWatched,
        onitemAddToPlaylist,
        onitemWatchlist,
        onclearAll,
        onrefresh,
        onfilterChange,
        oncollapse,
        onsectionReachEnd,
        canLoadMore = false,
        loadingMore = false,
        priorityCount = 0,
    }: Props = $props();

    // =========================================================================
    // Event Handlers - Bubble up events with section context
    // =========================================================================

    function handleItemClick(item: UniversalMediaItem) {
        onitemClick?.({ section, item });
    }

    function handleItemPlay(item: UniversalMediaItem) {
        onitemPlay?.({ section, item });
    }

    function handleItemRequest(item: UniversalMediaItem) {
        onitemRequest?.({ section, item });
    }

    function handleItemMore(item: UniversalMediaItem) {
        onitemMore?.({ section, item });
    }

    function handleItemRemove(item: UniversalMediaItem) {
        onitemRemove?.({ section, item });
    }

    function handleItemMarkWatched(item: UniversalMediaItem) {
        onitemMarkWatched?.({ section, item });
    }

    function handleItemAddToPlaylist(item: UniversalMediaItem) {
        onitemAddToPlaylist?.({ section, item });
    }

    function handleItemWatchlist(item: UniversalMediaItem) {
        onitemWatchlist?.({ section, item });
    }

    function handleClearAll() {
        onclearAll?.({ section });
    }

    function handleRefresh() {
        onrefresh?.({ section });
    }

    function handleFilterChange(filter: string) {
        onfilterChange?.({ section, filter });
    }

    function handleCollapse(collapsed: boolean) {
        oncollapse?.({ section, collapsed });
    }

    function handleReachEnd() {
        onsectionReachEnd?.({ section });
    }

    // =========================================================================
    // Section Type Mapping
    // =========================================================================

    // Types that use StandardSection (carousel/grid)
    const standardTypes = ['carousel', 'grid', 'continue-watching', 'next-up'];

    // Types that use ListSection (vertical list)
    const listTypes = ['list', 'watchlist'];

    let isStandardSection = $derived(standardTypes.includes(section.type));
    let isListSection = $derived(listTypes.includes(section.type));
    let isHeroSection = $derived(section.type === 'hero');
    let isCalendarSection = $derived(section.type === 'calendar');
    let isLiveSessionsSection = $derived(section.type === 'live-sessions');
    let isKeywordChipsSection = $derived(section.type === 'keyword-chips');
    let isFeaturedPickSection = $derived(section.type === 'featured-pick');
    // A StandardSection-rendered row (carousel/grid/continue-watching/next-up)
    // that has settled to 0 items and defines no meta.emptyState should not
    // render at all — no header, no "no content" box. Sections that are still
    // loading (meta.loading) keep rendering so the skeleton isn't hidden, and
    // sections with a meaningful meta.emptyState (e.g. empty watchlist CTA)
    // keep showing it. Scoped to isStandardSection only — other section kinds
    // (hero, calendar, list, keyword-chips, live-sessions, featured-pick)
    // have their own empty-state semantics and are out of scope.
    let isSettledEmptyWithoutState = $derived(
        isStandardSection &&
            section.items.length === 0 &&
            !section.meta?.loading &&
            !section.meta?.emptyState,
    );
    let isUnknownType = $derived(
        !isStandardSection &&
            !isListSection &&
            !isHeroSection &&
            !isCalendarSection &&
            !isLiveSessionsSection &&
            !isKeywordChipsSection &&
            !isFeaturedPickSection,
    );

    // Log warning for unknown types
    $effect(() => {
        if (isUnknownType) {
            console.warn(
                `[SectionRenderer] Unknown section type: "${section.type}" for section "${section.id}"`,
            );
        }
    });
</script>

{#if isSettledEmptyWithoutState}
    <!-- Settled-empty StandardSection row with no meta.emptyState: render nothing. -->
{:else if isStandardSection}
    <StandardSection
        {section}
        {hasRequestPermission}
        {showAddButton}
        {showWatchlistButton}
        {watchlistItemKeys}
        {watchlistLoadingKeys}
        {playlistItemKeys}
        {priorityCount}
        {canLoadMore}
        {loadingMore}
        {headerControls}
        onitemClick={handleItemClick}
        onitemPlay={handleItemPlay}
        onitemRequest={handleItemRequest}
        onitemMore={handleItemMore}
        onitemRemove={handleItemRemove}
        onitemMarkWatched={handleItemMarkWatched}
        onitemAddToPlaylist={handleItemAddToPlaylist}
        onitemWatchlist={handleItemWatchlist}
        onclearAll={handleClearAll}
        onrefresh={handleRefresh}
        onfilterChange={handleFilterChange}
        oncollapse={handleCollapse}
        onreachEnd={handleReachEnd} />
{:else if isListSection}
    <ListSection
        {section}
        {hasRequestPermission}
        showRemoveButton={section.meta?.showRemoveButton ?? true}
        {canRemoveItem}
        showMoreButton={section.meta?.showMoreButton ?? true}
        {selectedItemId}
        {showAddButton}
        {showWatchlistButton}
        {watchlistItemKeys}
        {watchlistLoadingKeys}
        {playlistItemKeys}
        onitemClick={handleItemClick}
        onitemPlay={handleItemPlay}
        onitemRequest={handleItemRequest}
        onitemMore={handleItemMore}
        onitemRemove={handleItemRemove}
        onitemAddToPlaylist={handleItemAddToPlaylist}
        onitemWatchlist={handleItemWatchlist}
        onrefresh={handleRefresh}
        oncollapse={handleCollapse} />
{:else if isHeroSection}
    <HeroSection
        {section}
        onitemClick={handleItemClick}
        onitemPlay={handleItemPlay}
        onitemRequest={handleItemRequest} />
{:else if isCalendarSection}
    <CalendarSection {section} onitemClick={handleItemClick} onitemPlay={handleItemPlay} />
{:else if isLiveSessionsSection}
    <LiveSessionSection data={section.meta?.data || {}} />
{:else if isKeywordChipsSection}
    <KeywordChipsSection
        {section}
        onitemClick={handleItemClick}
        onitemPlay={handleItemPlay}
        onitemRequest={handleItemRequest}
        onitemMore={handleItemMore} />
{:else if isFeaturedPickSection}
    <FeaturedPickSection
        {section}
        {hasRequestPermission}
        onitemClick={handleItemClick}
        onitemPlay={handleItemPlay}
        onitemRequest={handleItemRequest}
        onitemMore={handleItemMore} />
{:else}
    <!-- Unknown section type - render nothing but log warning above -->
    {#if import.meta.env.DEV}
        <div class="p-4 bg-error-500/20 border border-error-500 rounded-lg text-error-300 text-sm">
            Unknown section type: <code class="font-mono">{section.type}</code>
            <br />
            Section ID: <code class="font-mono">{section.id}</code>
        </div>
    {/if}
{/if}
