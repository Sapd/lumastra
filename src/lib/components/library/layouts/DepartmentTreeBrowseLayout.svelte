<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  DepartmentTreeBrowseLayout — two-tier accordion for training libraries.

  Primary groups: department (from server groupBy[0]).
  Secondary groups: category (client-side, from custom_metadata.category).
  Each department is a <details open> accordion; items carry a difficulty badge
  and a "Required" pill. Completion rings are deferred (OD-1: skip for now).
-->

<script lang="ts">
    import { SvelteMap } from 'svelte/reactivity';
    import type { BrowseLayoutProps } from './layout-props';
    import BrowseCard from './BrowseCard.svelte';
    import { difficultyBadgeClass } from '$lib/shared/browse-layout-utils';
    import type { BrowseItem } from '$lib/shared/browse-layout-utils';

    let {
        libraryType,
        template,
        groupedItems,
        onNavigate,
        onEditStart,
        editingItemId,
        editCategoryValue,
        onEditSave,
        onEditCancel,
        savingCategory,
        failedPosters,
        onPosterError,
        progressMeaning,
        isAdmin,
        bulkModeActive,
        selectedIds,
        onToggleSelect,
        onOpenDrawer,
        groupKey,
    }: BrowseLayoutProps = $props();

    /** Whether all departments are expanded. Default: true (see OD-4). */
    let allExpanded = $state(true);

    /** Map of departmentKey → category sub-grouping (client-side second level). */
    const departmentCategoryMap = $derived.by(() => {
        const result = new SvelteMap<string, SvelteMap<string, BrowseItem[]>>();
        for (const [dept, items] of groupedItems) {
            // Build the category sub-map as SvelteMap
            const catMap = new SvelteMap<string, BrowseItem[]>();
            for (const item of items) {
                const cat =
                    item.custom_metadata?.category == null ||
                    Array.isArray(item.custom_metadata.category) ||
                    typeof item.custom_metadata.category === 'object'
                        ? 'Uncategorized'
                        : String(item.custom_metadata.category);
                if (!catMap.has(cat)) catMap.set(cat, []);
                catMap.get(cat)!.push(item);
            }
            result.set(dept, catMap);
        }
        return result;
    });
</script>

<!-- Expand / Collapse all toggle -->
<div class="flex justify-end mb-4">
    <button
        class="text-xs px-3 py-1.5 bg-surface-700 hover:bg-surface-600 text-surface-300 rounded-lg transition-colors"
        onclick={() => {
            allExpanded = !allExpanded;
        }}>
        {allExpanded ? 'Collapse All' : 'Expand All'}
    </button>
</div>

<div class="space-y-4">
    {#each groupedItems as [dept] (dept)}
        {@const categoryMap = departmentCategoryMap.get(dept) ?? new Map()}
        {#key allExpanded}
            <details
                open={allExpanded}
                class="group/dept bg-surface-800 rounded-xl overflow-hidden">
                <summary
                    class="flex items-center justify-between px-5 py-3 cursor-pointer list-none select-none hover:bg-surface-700/50 transition-colors">
                    <span class="text-lg font-semibold text-white">{dept}</span>
                    <svg
                        class="w-5 h-5 text-surface-400 transition-transform group-open/dept:rotate-180"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M19 9l-7 7-7-7" />
                    </svg>
                </summary>

                <div class="px-5 pb-5 space-y-6">
                    {#each categoryMap as [category, items] (category)}
                        <div>
                            <h3
                                class="text-sm font-medium text-surface-400 mb-3 uppercase tracking-wide">
                                {category}
                            </h3>
                            <div
                                class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                                {#each items as item (item.id)}
                                    <div class="relative">
                                        <!-- Difficulty badge overlay -->
                                        {#if item.custom_metadata?.difficulty}
                                            <div
                                                class="absolute top-0 left-0 z-10 text-[10px] font-semibold px-1.5 py-0.5 rounded-br rounded-tl-lg leading-tight {difficultyBadgeClass(
                                                    item.custom_metadata.difficulty,
                                                )}">
                                                {String(item.custom_metadata.difficulty)}
                                            </div>
                                        {/if}
                                        <!-- Required pill -->
                                        {#if item.custom_metadata?.required}
                                            <div
                                                class="absolute top-0 right-0 z-10 text-[10px] font-semibold px-1.5 py-0.5 bg-primary-600 text-white rounded-bl rounded-tr-lg leading-tight">
                                                Required
                                            </div>
                                        {/if}
                                        <!-- TODO: completion rings require per-series watch-state data (OD-1 deferred) -->
                                        <BrowseCard
                                            {item}
                                            {libraryType}
                                            {template}
                                            {groupKey}
                                            {progressMeaning}
                                            {isAdmin}
                                            {bulkModeActive}
                                            {selectedIds}
                                            {failedPosters}
                                            {editingItemId}
                                            {editCategoryValue}
                                            {savingCategory}
                                            {onNavigate}
                                            {onEditStart}
                                            {onEditSave}
                                            {onEditCancel}
                                            {onPosterError}
                                            {onToggleSelect}
                                            {onOpenDrawer} />
                                    </div>
                                {/each}
                            </div>
                        </div>
                    {/each}
                </div>
            </details>
        {/key}
    {/each}
</div>
