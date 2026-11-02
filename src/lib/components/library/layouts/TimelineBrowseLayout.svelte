<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  TimelineBrowseLayout — vertical time ribbon for home_video libraries.

  The server groups items by date_filmed (primary groupBy key after OD-2 fix).
  The group keys are ISO date strings or partial dates; we bucket them by year
  as the primary visual header, then by event as a secondary non-sticky sub-header.
  Cards appear in a horizontal scroll row within each event sub-group.
-->

<script lang="ts">
    import { SvelteMap } from 'svelte/reactivity';
    import type { BrowseLayoutProps } from './layout-props';
    import BrowseCard from './BrowseCard.svelte';
    import { extractYear } from '$lib/shared/browse-layout-utils';
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

    /**
     * Re-bucket the already-grouped items by year, preserving insertion order.
     * groupedItems keys are date_filmed values like "2024-06-15" (primary groupBy).
     * We merge all items that share the same 4-digit year into a single year bucket,
     * then do a second-level grouping by event inside each year.
     */
    const byYear = $derived.by(() => {
        const yearMap = new SvelteMap<string, SvelteMap<string, BrowseItem[]>>();
        for (const [dateKey, items] of groupedItems) {
            const year = extractYear(dateKey);
            if (!yearMap.has(year)) {
                yearMap.set(year, new SvelteMap());
            }
            // Merge items into the existing event-map for this year
            const eventMap = yearMap.get(year)!;
            for (const item of items) {
                const event =
                    item.custom_metadata?.event == null ||
                    Array.isArray(item.custom_metadata.event) ||
                    typeof item.custom_metadata.event === 'object'
                        ? 'Uncategorized'
                        : String(item.custom_metadata.event);
                if (!eventMap.has(event)) eventMap.set(event, []);
                eventMap.get(event)!.push(item);
            }
        }
        // Sort years descending (newest first)
        return new SvelteMap(
            [...yearMap.entries()].sort(([a], [b]) => {
                if (a === 'Unknown Year') return 1;
                if (b === 'Unknown Year') return -1;
                return b.localeCompare(a);
            }),
        );
    });
</script>

<div class="space-y-10">
    {#each byYear as [year, eventMap] (year)}
        <section>
            <!-- Sticky year header -->
            <h2
                class="sticky top-16 z-10 text-2xl font-bold text-white bg-surface-900/90 backdrop-blur-sm py-2 mb-4 border-b border-surface-700">
                {year}
            </h2>

            <div class="space-y-6">
                {#each eventMap as [event, items] (event)}
                    <div>
                        <!-- Event sub-header (non-sticky) -->
                        <h3
                            class="text-sm font-semibold text-surface-300 mb-3 uppercase tracking-wide">
                            {event}
                        </h3>
                        <!-- Horizontal scroll row of narrow cards -->
                        <div class="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
                            {#each items as item (item.id)}
                                <div class="flex-none w-48">
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
        </section>
    {/each}
</div>
