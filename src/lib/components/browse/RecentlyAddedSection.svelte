<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    RecentlyAddedSection.svelte

    Owns the "Recently Added" header, filter controls, fetch state, and
    the carousel. Uses the initial items passed from the page (no duplicate
    fetch on mount). When filters change it re-fetches via
    browseApi.getRecentlyAdded() and replaces the carousel items.

    Props:
      - initialItems: BrowseItem[] — server-loaded recently-added items
      - type: active browse tab ('all' | 'movies' | 'series') — passed as
              the `type` param to /api/browse/recent
      - hasRequestPermission: forwarded to SectionRenderer
      - onitemClick / onitemPlay / onitemMore — forwarded up to the page
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import * as browseApi from '$lib/api/browse';
    // Imported directly from its file, NOT the `$lib/components/sections`
    // barrel: that barrel also statically re-exports HeroSection,
    // CalendarSection, LiveSessionSection and KeywordChipsSection
    // (`export { default as X } from './X.svelte'`). Those are Svelte
    // components, which Rollup treats as side-effectful, so importing
    // ANYTHING from the barrel pulls the whole module graph — including
    // HeroSection + LiveSessionSection (~4600 lines combined) — into
    // whatever shared chunk this component's static importers (every
    // /browse tab renders this unconditionally) can reach, even though this
    // file only ever touches the `SectionRenderer` binding. Importing the
    // single file sidesteps the barrel's re-exports entirely.
    import SectionRenderer from '$lib/components/sections/SectionRenderer.svelte';
    import RecentlyAddedFilters from './RecentlyAddedFilters.svelte';
    import { transformJellyfinItems, type BrowseItem } from '$lib/utils/browse-transformers';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';

    interface Props {
        initialItems?: BrowseItem[];
        type?: 'all' | 'movies' | 'series';
        /** Full newest-first grid this row previews ("Show more →"). */
        viewAllHref?: string;
        hasRequestPermission?: boolean;
        onitemClick?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        onitemPlay?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
        onitemMore?: (data: { section: PageSection; item: UniversalMediaItem }) => void;
    }

    let {
        initialItems = [],
        type = 'all',
        viewAllHref,
        hasRequestPermission = true,
        onitemClick,
        onitemPlay,
        onitemMore,
    }: Props = $props();

    // -------------------------------------------------------------------------
    // Libraries — fetched once and passed to the filters control
    // -------------------------------------------------------------------------
    let libraries: { id: string; name: string; mediaType: 'movie' | 'series' | 'mixed' }[] = $state(
        [],
    );

    async function loadLibraries() {
        const { data, error } = await browseApi.getLibraries();
        if (error || !data) return;
        libraries = (data.libraries ?? []).map((lib) => ({
            id: lib.id,
            name: lib.name,
            mediaType: lib.mediaType ?? 'mixed',
        }));
    }

    // -------------------------------------------------------------------------
    // Filter state (bound to RecentlyAddedFilters)
    // -------------------------------------------------------------------------
    let selectedGroup = $state<string | null>(null);
    // Default to 'titles' — only brand-new movies/series. This matches the
    // ordering /api/browse now uses for initialItems, so the default view needs
    // no extra fetch.
    let newnessMode = $state<'everything' | 'seasons' | 'titles'>('titles');
    let searchQuery = $state('');

    // -------------------------------------------------------------------------
    // Items state
    // -------------------------------------------------------------------------
    // fetchedItems holds the result of filter-triggered API calls (null = no
    // active filter → display the SSR-provided initialItems instead).
    let fetchedItems = $state<BrowseItem[] | null>(null);
    let loading = $state(false);
    let fetchFailed = $state(false);
    // Monotonic request token so out-of-order responses from rapid filter
    // changes can be discarded — only the latest fetch may write state.
    let reqSeq = 0;

    // The displayed items: use fetchedItems once a filter is applied, else initialItems
    let items = $derived<BrowseItem[]>(fetchedItems !== null ? fetchedItems : initialItems);

    // Any filter deviating from its default. Keeps the section (and its filter
    // control) mounted even when a filter narrows the result to empty, so the
    // user can always widen or clear the filter again.
    let hasActiveFilter = $derived(
        selectedGroup !== null || newnessMode !== 'titles' || searchQuery.trim() !== '',
    );

    // Build the PageSection from current items — mirrors how +page.svelte does it
    let section = $derived<PageSection>({
        id: 'recently-added',
        type: 'carousel',
        title: m.browse_recently_added(),
        // Drops falsy/id-less entries and items whose media type has no client
        // card (transformJellyfinItem returns null for those).
        items: transformJellyfinItems(items),
        meta: { icon: 'sparkles', iconColor: 'text-yellow-500', loading },
    });

    // -------------------------------------------------------------------------
    // Re-fetch when filters change
    // -------------------------------------------------------------------------
    $effect(() => {
        // Read filter values to establish reactive dependencies
        const group = selectedGroup;
        const mode = newnessMode;
        const q = searchQuery.trim();
        const tabType = type;

        if (!browser) return;

        // Default filters: fall back to the SSR-provided initialItems with no
        // network round-trip. This covers both the initial mount and the user
        // clearing every filter again. Bumping reqSeq invalidates any fetch
        // still in flight so its (now-stale) result is discarded.
        if (group === null && mode === 'titles' && q === '') {
            reqSeq++;
            fetchedItems = null;
            fetchFailed = false;
            loading = false;
            return;
        }

        void fetchItems(group, mode, q, tabType);
    });

    async function fetchItems(
        group: string | null,
        mode: 'everything' | 'seasons' | 'titles',
        q: string,
        tabType: string,
    ) {
        const myReq = ++reqSeq;
        fetchFailed = false;
        loading = true;
        try {
            // Map the active browse tab to the API `type` param.
            const typeParam =
                tabType === 'movies' ? 'movies' : tabType === 'series' ? 'series' : 'all';

            const { data, error } = await browseApi.getRecentlyAdded({
                type: typeParam !== 'all' ? typeParam : undefined,
                libraryGroupId: group ?? undefined,
                new: mode !== 'everything' ? mode : undefined,
                q: q || undefined,
            });

            // Discard if a newer request (or a reset to defaults) superseded this one.
            if (myReq !== reqSeq) return;
            if (error || !data) {
                fetchFailed = true;
                return;
            }
            fetchedItems = (data.recentlyAdded ?? []) as unknown as BrowseItem[];
        } catch (e) {
            if (myReq === reqSeq) {
                fetchFailed = true;
                console.error('[RecentlyAddedSection] fetch error:', e);
            }
        } finally {
            if (myReq === reqSeq) loading = false;
        }
    }

    onMount(() => {
        loadLibraries();
    });
</script>

{#if section.items.length > 0 || loading || hasActiveFilter || fetchFailed}
    <div class="ras-root">
        <!-- Section header: title on the left, filters trigger on the right -->
        <div class="ras-header">
            <div class="ras-heading">
                <span class="ras-title">{m.browse_recently_added()}</span>
                {#if viewAllHref}
                    <a href={resolve(viewAllHref)} class="ras-view-all">
                        {m.section_show_more()} →
                    </a>
                {/if}
            </div>
            <RecentlyAddedFilters
                {libraries}
                bind:selectedGroup
                bind:newnessMode
                bind:searchQuery />
        </div>

        <!-- Empty state after filtering -->
        {#if fetchFailed}
            <div class="ras-empty" role="alert">
                <p>{m.catalog_error()}</p>
                <button
                    type="button"
                    class="btn variant-filled-primary btn-sm"
                    onclick={() =>
                        fetchItems(selectedGroup, newnessMode, searchQuery.trim(), type)}>
                    {m.btn_retry()}
                </button>
            </div>
        {:else if !loading && section.items.length === 0}
            <div class="ras-empty">
                <p>{m.browse_no_content()}</p>
            </div>
        {:else}
            <!-- Pass the carousel section to SectionRenderer — same as how the page
                 renders any other carousel section. The title is hidden because we
                 rendered it ourselves above in ras-header. -->
            <SectionRenderer
                section={{ ...section, title: '' }}
                {hasRequestPermission}
                {onitemClick}
                {onitemPlay}
                {onitemMore} />
        {/if}
    </div>
{/if}

<style lang="postcss">
    /* Contain the whole section in a subtle card so it reads as one unit and
       the filter control clearly belongs to Recently Added (not the page). */
    .ras-root {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem 1rem 1.25rem;
        border-radius: 1rem;
        border: 1px solid rgb(var(--color-surface-700-rgb) / 0.6);
        background: rgb(var(--color-surface-800-rgb) / 0.35);
        /* Match the 2rem (space-y-8) rhythm between page sections so the card
           doesn't crowd Continue Watching directly below it. */
        margin-bottom: 2rem;
    }

    .ras-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        /* Divider tying the header (title + filter) to the carousel below */
        padding-bottom: 0.5rem;
        border-bottom: 1px solid rgb(var(--color-surface-700-rgb) / 0.5);
    }

    .ras-title {
        font-size: 1.125rem;
        font-weight: 700;
        color: var(--color-surface-100);
        line-height: 1.2;
    }

    .ras-heading {
        display: flex;
        align-items: baseline;
        gap: 0.75rem;
        min-width: 0;
    }

    .ras-view-all {
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--color-primary-400);
        white-space: nowrap;
        text-decoration: none;
    }

    .ras-view-all:hover {
        color: var(--color-primary-300);
    }

    .ras-empty {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        align-items: center;
        justify-content: center;
        padding: 2rem 1rem;
        color: var(--color-surface-400);
        font-size: 0.875rem;
    }
</style>
