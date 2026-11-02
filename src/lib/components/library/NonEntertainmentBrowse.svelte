<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { goto, invalidateAll } from '$app/navigation';
    import { page } from '$app/stores';
    import { untrack } from 'svelte';
    import { SvelteMap, SvelteSet, SvelteURLSearchParams } from 'svelte/reactivity';
    import { getLibraryTypeTemplate } from '$lib/shared/library-type-templates';
    import { updateAdminCustomMetadata } from '$lib/api/admin';
    import { requireValue } from '$lib/utils/runtime-validation';
    import { deriveIsAdmin } from '$lib/utils/permissions';
    import * as m from '$lib/paraglide/messages.js';
    import ContentEditDrawer from './ContentEditDrawer.svelte';
    import BulkEditBar from './BulkEditBar.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import TimelineBrowseLayout from './layouts/TimelineBrowseLayout.svelte';
    import DepartmentTreeBrowseLayout from './layouts/DepartmentTreeBrowseLayout.svelte';
    import CourseBrowseLayout from './layouts/CourseBrowseLayout.svelte';
    import GridBrowseLayout from './layouts/GridBrowseLayout.svelte';
    import type { BrowseLayoutProps, BrowseItem } from './layouts/layout-props';
    import { getCatalogPosterUrl } from '$lib/utils/image-utils.js';
    import { appPath } from '$lib/shared/api-urls.js';

    /** Maximum number of items that can be bulk-selected in one operation (matches server Zod .max(500)). */
    const BULK_SELECT_MAX = 500;

    interface GroupCount {
        group_value: string;
        count: number;
    }

    interface SortOption {
        value: string;
        label: string;
    }

    interface Props {
        libraryType: string;
        items: BrowseItem[];
        total: number;
        filters: Record<string, string[]>;
        groups: GroupCount[];
        title: string;
        groupKey: string;
        activeFilter: string | null;
        limit: number;
        offset: number;
        emptyMessage?: string;
        /** Template defaultSort value — drives the available sort options. */
        defaultSort: string;
        /** Controls whether completion pill or watch-progress affordances are shown. */
        progressMeaning: 'watch_progress' | 'completion';
    }

    let {
        libraryType,
        items,
        total,
        filters,
        groups,
        title,
        groupKey,
        activeFilter,
        limit,
        offset,
        emptyMessage = 'No content found',
        defaultSort,
        progressMeaning,
    }: Props = $props();

    /** Available sort options for the current library type, derived from defaultSort. */
    const sortOptions = $derived.by((): SortOption[] => {
        if (defaultSort === 'department') {
            return [
                { value: 'department', label: m.library_sort_dept() },
                { value: 'alphabetical', label: m.library_sort_az() },
                { value: 'added', label: m.library_sort_added() },
            ];
        }
        if (defaultSort === 'chronological') {
            return [
                { value: 'chronological', label: m.library_sort_newest() },
                { value: 'oldest', label: m.library_sort_oldest() },
                { value: 'alphabetical', label: m.library_sort_az() },
            ];
        }
        if (defaultSort === 'added') {
            return [
                { value: 'added', label: m.library_sort_added() },
                { value: 'alphabetical', label: m.library_sort_az() },
            ];
        }
        // 'alphabetical' (default)
        return [
            { value: 'alphabetical', label: m.library_sort_az() },
            { value: 'added', label: m.library_sort_added() },
        ];
    });

    /** Active sort value from URL, falling back to template default.
     * Clamped to the available sortOptions to avoid client-server divergence
     * when an unknown ?sort= value appears in the URL (e.g. from a manual edit
     * or an old bookmark). An unknown value resolves server-side to 'alphabetical'
     * but would leave the client's activeSort holding the unrecognised string. */
    const activeSort = $derived.by(() => {
        const raw = $page.url.searchParams.get('sort') ?? defaultSort;
        const known = sortOptions.find((o) => o.value === raw);
        return known ? raw : (sortOptions[0]?.value ?? defaultSort);
    });

    function handleSort(value: string): void {
        const params = new SvelteURLSearchParams($page.url.searchParams);
        if (value === defaultSort) {
            params.delete('sort');
        } else {
            params.set('sort', value);
        }
        params.delete('offset');
        void goto(`?${params.toString()}`, { replaceState: true });
    }

    let template = $derived(getLibraryTypeTemplate(libraryType));
    /** True when the current user belongs to an admin group — gates edit/bulk controls. */
    const isAdmin = $derived(deriveIsAdmin($page.data));
    let searchQuery = $state($page.url.searchParams.get('q') ?? '');

    // Accumulated items across Load More pages.
    // When offset resets to 0 (new search / filter), replace the list; otherwise append.
    function initialAccumulatedItems(): BrowseItem[] {
        return items;
    }

    function initialAccumulatedOffset(): number {
        return offset;
    }

    let accumulatedItems = $state<BrowseItem[]>(initialAccumulatedItems());

    // Track the offset at which accumulatedItems was last built.
    // Initialised to the current offset so that SSR hydration (where the page
    // may load at ?offset=50) does NOT trigger an append on first mount.
    // Only a strictly higher offset (a genuine Load More navigation) causes
    // an append; same-offset re-runs (invalidateAll after saveCategory) do not.
    let accumulatedOffset = $state(initialAccumulatedOffset());

    $effect(() => {
        // Capture reactive dependencies explicitly.
        const newOffset = offset;
        const newItems = items;
        if (newOffset === 0) {
            // Filter change, search, or page reset — replace list.
            // Read accumulatedOffset inside untrack so writing it doesn't
            // re-trigger this effect (effect_update_depth_exceeded guard).
            untrack(() => {
                accumulatedItems = newItems;
                accumulatedOffset = 0;
            });
        } else if (newOffset > untrack(() => accumulatedOffset)) {
            // Genuine Load More: offset advanced past what we already have.
            // Reading accumulatedItems inside untrack avoids a reactive cycle:
            // reading it as a tracked dep while reassigning it would
            // re-invalidate this effect on every run (effect_update_depth_exceeded).
            untrack(() => {
                accumulatedItems = [...accumulatedItems, ...newItems];
                accumulatedOffset = newOffset;
            });
        }
        // If newOffset === accumulatedOffset and > 0, this is a same-page
        // re-run (e.g. invalidateAll() after saveCategory). No action needed.
    });

    const hasMore = $derived(offset + items.length < total);

    function loadMore(): void {
        const params = new SvelteURLSearchParams($page.url.searchParams);
        params.set('offset', String(offset + limit));
        void goto(`?${params.toString()}`, { replaceState: false, noScroll: true });
    }

    function handleSearch(): void {
        const params = new SvelteURLSearchParams($page.url.searchParams);
        if (searchQuery) {
            params.set('q', searchQuery);
        } else {
            params.delete('q');
        }
        params.delete('offset'); // reset to page 1 on new search
        void goto(`?${params.toString()}`, { replaceState: true });
    }

    function setFilter(val: string | null): void {
        const params = new SvelteURLSearchParams($page.url.searchParams);
        if (val) {
            params.set(`filter[${groupKey}]`, val);
        } else {
            params.delete(`filter[${groupKey}]`);
        }
        params.delete('offset'); // reset to page 1 on filter change
        void goto(`?${params.toString()}`, { replaceState: true });
    }

    // Group the accumulated items into buckets for rendering.
    // When the groupKey value is an array or object (e.g. `tags` on personal libraries),
    // String(value) yields "travel,family" which never matches the SQL group_value
    // "Uncategorized" (SQL routes arrays to that bucket). Route non-scalar values to
    // 'Uncategorized' on both sides so every item finds its bucket and none are dropped.
    let groupedItems = $derived.by(() => {
        const map = new SvelteMap<string, BrowseItem[]>();
        for (const item of accumulatedItems) {
            const raw = item.custom_metadata?.[groupKey];
            const key =
                raw === null || raw === undefined || Array.isArray(raw) || typeof raw === 'object'
                    ? 'Uncategorized'
                    : String(raw);
            if (!map.has(key)) map.set(key, []);
            requireValue(map.get(key), 'browse group bucket').push(item);
        }
        return map;
    });

    // Filter values from server
    let filterValues = $derived(filters[groupKey] ?? []);

    // Track items whose poster image failed to load
    let failedPosters = new SvelteSet<string>();

    // Category edit state
    let editingItemId = $state<string | null>(null);
    let editCategoryValue = $state('');
    let savingCategory = $state(false);

    // Full-edit drawer state
    let drawerItem = $state<BrowseItem | null>(null);

    // Bulk-select state
    let bulkModeActive = $state(false);
    // eslint-disable-next-line svelte/no-unnecessary-state-wrap -- reassigned with new SvelteSet for reactivity in toggleBulkMode/deselectAll
    let selectedIds = $state(new SvelteSet<string>());

    function toggleBulkMode(): void {
        bulkModeActive = !bulkModeActive;
        selectedIds = new SvelteSet();
    }

    function toggleSelect(id: string): void {
        if (selectedIds.has(id)) {
            selectedIds.delete(id);
        } else {
            selectedIds.add(id);
        }
    }

    function selectAll(): void {
        for (const item of accumulatedItems) {
            if (selectedIds.size >= BULK_SELECT_MAX) {
                toasts.warning(
                    `Cannot select more than ${BULK_SELECT_MAX} items at once. Selection capped.`,
                );
                break;
            }
            selectedIds.add(item.id);
        }
    }

    function deselectAll(): void {
        selectedIds = new SvelteSet();
    }

    async function saveCategory(itemId: string): Promise<void> {
        savingCategory = true;
        try {
            const newValue = editCategoryValue.trim() || null;
            const { error } = await updateAdminCustomMetadata(itemId, {
                [groupKey]: newValue,
            });
            if (!error) {
                editingItemId = null;
                // Optimistically update accumulatedItems so pre-save pages (offset > 0)
                // show the new metadata value immediately — invalidateAll() only refreshes
                // the current page window and the same-offset guard skips old pages.
                accumulatedItems = accumulatedItems.map((it) =>
                    it.id === itemId
                        ? {
                              ...it,
                              custom_metadata: {
                                  ...it.custom_metadata,
                                  [groupKey]: newValue,
                              },
                          }
                        : it,
                );
                await invalidateAll();
            }
        } finally {
            savingCategory = false;
        }
    }

    /** Navigate to the appropriate route for an item. */
    function handleNavigate(item: BrowseItem): void {
        if (item.episode_count > 1) {
            void goto(appPath(`/library/${libraryType}/${item.id}`));
        } else {
            const episodeId = item.first_episode_id ?? item.id;
            // Thread arrival context so the watch page selects the right AGPL shell.
            // Pass returnPath so the shell back button returns to this library page
            // rather than the server default of '/browse'.
            const returnPath = $page.url.pathname + $page.url.search;
            if (libraryType === 'educational') {
                const params = new URLSearchParams({
                    ctx: 'educational',
                    col: item.id,
                    returnPath,
                });
                void goto(appPath(`/watch/${episodeId}?${params.toString()}`));
            } else if (libraryType === 'home_video' || libraryType === 'personal') {
                const params = new URLSearchParams({
                    ctx: 'personal',
                    event: item.id,
                    returnPath,
                });
                void goto(appPath(`/watch/${episodeId}?${params.toString()}`));
            } else {
                void goto(appPath(`/watch/${episodeId}`));
            }
        }
    }

    /** Start inline quick-edit for the group key field. */
    function handleEditStart(item: BrowseItem): void {
        editingItemId = item.id;
        editCategoryValue = (item.custom_metadata?.[groupKey] as string) ?? '';
    }

    /** Shared layout props object passed to every layout sub-component. */
    const layoutProps = $derived.by((): BrowseLayoutProps => ({
        libraryType,
        template: template!,
        groupKey,
        groupedItems,
        onNavigate: handleNavigate,
        onEditStart: handleEditStart,
        editingItemId,
        editCategoryValue,
        onEditSave: (id) => void saveCategory(id),
        onEditCancel: () => {
            editingItemId = null;
        },
        savingCategory,
        failedPosters,
        onPosterError: (id) => {
            failedPosters.add(id);
        },
        progressMeaning,
        isAdmin,
        bulkModeActive,
        selectedIds,
        onToggleSelect: toggleSelect,
        onOpenDrawer: (item) => {
            drawerItem = item;
        },
    }));
</script>

<div class="max-w-7xl mx-auto px-4 pt-20 pb-8">
    <!-- Bulk / single-item drawers & bars (admin-only) -->
    {#if isAdmin && drawerItem}
        <ContentEditDrawer
            item={drawerItem}
            {libraryType}
            onsaved={() => void invalidateAll()}
            onclose={() => {
                drawerItem = null;
            }} />
    {/if}

    {#if isAdmin && bulkModeActive && selectedIds.size > 0 && template}
        <BulkEditBar
            selectedIds={[...selectedIds]}
            metadataFields={template.metadataFields}
            mediaType={libraryType}
            oncancel={deselectAll}
            onsaved={() => void invalidateAll()} />
    {/if}

    <div class="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <h1 class="text-2xl font-bold text-white">{title}</h1>
        <div class="flex items-center gap-3 flex-wrap">
            <!-- Sort control — shown only when there are multiple options -->
            {#if sortOptions.length > 1}
                <div class="flex items-center gap-2">
                    <span class="text-xs text-surface-400">{m.library_sort_label()}</span>
                    <select
                        value={activeSort}
                        onchange={(e) => handleSort((e.currentTarget as HTMLSelectElement).value)}
                        class="px-2 py-1.5 bg-surface-800 border border-surface-600 rounded-lg text-sm text-white focus:outline-none focus:border-primary-500">
                        {#each sortOptions as opt (opt.value)}
                            <option value={opt.value}>{opt.label}</option>
                        {/each}
                    </select>
                </div>
            {/if}
            <form
                onsubmit={(e) => {
                    e.preventDefault();
                    handleSearch();
                }}
                class="flex gap-2">
                <input
                    type="text"
                    bind:value={searchQuery}
                    placeholder="Search..."
                    class="px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-white placeholder-surface-400 focus:outline-none focus:border-primary-500" />
                <button
                    type="submit"
                    class="px-4 py-2 bg-primary-500 hover:bg-primary-600 text-white rounded-lg text-sm transition-colors">
                    Search
                </button>
            </form>
            <!-- Bulk select toggle (admin-only) -->
            {#if isAdmin && template && template.metadataFields.length > 0}
                <button
                    class="px-3 py-2 text-sm rounded-lg transition-colors {bulkModeActive
                        ? 'bg-primary-600 text-white'
                        : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
                    onclick={toggleBulkMode}>
                    {bulkModeActive ? 'Exit Select' : 'Select'}
                </button>
                {#if bulkModeActive && accumulatedItems.length > 0}
                    <button
                        class="px-3 py-2 text-xs rounded-lg bg-surface-700 text-surface-300 hover:bg-surface-600 transition-colors"
                        onclick={selectedIds.size === accumulatedItems.length
                            ? deselectAll
                            : selectAll}>
                        {selectedIds.size === accumulatedItems.length
                            ? 'Deselect All'
                            : 'Select All'}
                    </button>
                {/if}
            {/if}
        </div>
    </div>

    <!-- Filter pills -->
    {#if filterValues.length > 0}
        <div class="flex flex-wrap gap-2 mb-6">
            <button
                class="px-3 py-1.5 text-xs font-medium rounded-full transition-colors {activeFilter ===
                null
                    ? 'bg-primary-600 text-white'
                    : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
                onclick={() => setFilter(null)}>
                All
            </button>
            {#each filterValues as val (val)}
                <button
                    class="px-3 py-1.5 text-xs font-medium rounded-full transition-colors {activeFilter ===
                    val
                        ? 'bg-primary-600 text-white'
                        : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
                    onclick={() => setFilter(val)}>
                    {val}
                </button>
            {/each}
        </div>
    {/if}

    {#if accumulatedItems.length === 0}
        <div class="text-center text-surface-400 py-16">
            <p class="text-lg">{emptyMessage}</p>
            {#if searchQuery}
                <p class="text-sm mt-2">Try a different search term</p>
            {:else}
                <p class="text-sm mt-2">Add a library path in Admin to get started</p>
            {/if}
        </div>
    {:else if template}
        <!-- Layout dispatcher: select rendering based on browseConfig.layout -->
        {#if template.browseConfig.layout === 'timeline'}
            <TimelineBrowseLayout {...layoutProps} />
        {:else if template.browseConfig.layout === 'department_tree'}
            <DepartmentTreeBrowseLayout {...layoutProps} />
        {:else if template.browseConfig.layout === 'course'}
            <CourseBrowseLayout {...layoutProps} />
        {:else}
            <GridBrowseLayout {...layoutProps} />
        {/if}

        <!-- Load More button -->
        {#if hasMore}
            <div class="flex justify-center mt-8">
                <button
                    class="px-6 py-2 bg-surface-700 hover:bg-surface-600 text-white rounded-lg text-sm transition-colors"
                    onclick={loadMore}>
                    Load More ({Math.max(0, total - offset - items.length)} remaining)
                </button>
            </div>
        {/if}
    {:else}
        <!-- Fallback: template not found (unknown libraryType) — render flat grid using server groups -->
        {#each groups as g (g.group_value)}
            {@const groupItems = groupedItems.get(g.group_value) ?? []}
            {#if groupItems.length > 0}
                <div class="mb-8">
                    <h2
                        class="text-xl font-semibold text-surface-200 mb-4 border-b border-surface-700 pb-2">
                        {g.group_value}
                        <span class="text-sm font-normal text-surface-500 ml-2">{g.count}</span>
                    </h2>
                    <div
                        class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                        {#each groupItems as item (item.id)}
                            <div
                                class="group cursor-pointer"
                                role="link"
                                tabindex="0"
                                onclick={() => handleNavigate(item)}
                                onkeydown={(e) => {
                                    if (e.key === 'Enter') handleNavigate(item);
                                }}>
                                <div
                                    class="aspect-video rounded-lg overflow-hidden bg-surface-700 mb-2">
                                    {#if !failedPosters.has(item.id)}
                                        <img
                                            src={getCatalogPosterUrl(item.id)}
                                            alt={item.title}
                                            class="w-full h-full object-cover group-hover:scale-105 transition-transform"
                                            onerror={() => {
                                                failedPosters.add(item.id);
                                            }} />
                                    {:else}
                                        <div
                                            class="w-full h-full flex items-center justify-center text-surface-500">
                                            <svg
                                                class="w-8 h-8"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24">
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    stroke-width="2"
                                                    d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                            </svg>
                                        </div>
                                    {/if}
                                </div>
                                <p class="text-sm text-white truncate">{item.title}</p>
                            </div>
                        {/each}
                    </div>
                </div>
            {/if}
        {/each}

        <!-- Load More button (fallback path) -->
        {#if hasMore}
            <div class="flex justify-center mt-8">
                <button
                    class="px-6 py-2 bg-surface-700 hover:bg-surface-600 text-white rounded-lg text-sm transition-colors"
                    onclick={loadMore}>
                    Load More ({Math.max(0, total - offset - items.length)} remaining)
                </button>
            </div>
        {/if}
    {/if}
</div>
