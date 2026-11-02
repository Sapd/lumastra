<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	CalendarSection.svelte

	Placeholder component for calendar/schedule sections.
	Will be implemented to show upcoming releases grouped by date.

	@example
	<CalendarSection section={{ type: 'calendar', items: [...] }} />
-->
<script lang="ts">
    import { SvelteDate, SvelteMap } from 'svelte/reactivity';
    import { Icon, CalendarDays } from 'svelte-hero-icons';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { UniversalMediaCard } from '$lib/components/ui';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';
    import { requireValue } from '$lib/utils/runtime-validation';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The section data to render */
        section: PageSection;
        // Callbacks
        onitemClick?: (item: UniversalMediaItem) => void;
        onitemPlay?: (item: UniversalMediaItem) => void;
    }

    let { section, onitemClick, onitemPlay }: Props = $props();

    // =========================================================================
    // Helper Functions
    // =========================================================================

    interface DateGroup {
        date: string;
        label: string;
        isToday: boolean;
        items: UniversalMediaItem[];
    }

    function groupByDate(items: UniversalMediaItem[]): DateGroup[] {
        const groups = new SvelteMap<string, UniversalMediaItem[]>();
        const today = new SvelteDate().toISOString().split('T')[0];

        for (const item of items) {
            const date = item.releaseDate?.split('T')[0] || 'unknown';
            if (!groups.has(date)) {
                groups.set(date, []);
            }
            requireValue(groups.get(date), 'calendar group must exist after set').push(item);
        }

        // Sort by date and convert to array
        return Array.from(groups.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, items]) => ({
                date,
                label: formatDateLabel(date),
                isToday: date === today,
                items,
            }));
    }

    function formatDateLabel(dateStr: string): string {
        if (dateStr === 'unknown') return m.misc_unknown();

        const date = new SvelteDate(dateStr);
        const today = new SvelteDate();
        const tomorrow = new SvelteDate(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const dateOnly = date.toISOString().split('T')[0];
        const todayOnly = today.toISOString().split('T')[0];
        const tomorrowOnly = tomorrow.toISOString().split('T')[0];

        if (dateOnly === todayOnly) return m.calendar_today();
        if (dateOnly === tomorrowOnly) return m.calendar_tomorrow();

        // Format as "Monday, January 15"
        return date.toLocaleDateString(getLocale(), {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
        });
    }

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function handleItemClick(item: UniversalMediaItem) {
        onitemClick?.(item);
    }

    function handleItemPlay(item: UniversalMediaItem) {
        onitemPlay?.(item);
    }
    // Feature flags for request permission
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    // =========================================================================
    // Computed Values
    // =========================================================================

    let meta = $derived(section.meta || {});
    let isLoading = $derived(meta.loading ?? false);
    // Group items by release date
    let groupedItems = $derived(groupByDate(section.items));
</script>

<section class="space-y-6">
    <!-- Header -->
    {#if section.title}
        <div class="flex items-center gap-3">
            <Icon src={CalendarDays} class="w-6 h-6 text-primary-400" />
            <h2 class="h2 text-primary-400">{section.title}</h2>
        </div>
    {/if}

    <!-- Content -->
    {#if isLoading && section.items.length === 0}
        <!-- Loading State -->
        <div class="space-y-6">
            {#each Array(3) as _, i (i)}
                <div class="animate-pulse">
                    <div class="h-6 bg-surface-600 rounded w-32 mb-3"></div>
                    <div class="flex gap-4">
                        {#each Array(4) as _, j (j)}
                            <div class="w-32 shrink-0">
                                <div class="aspect-[2/3] rounded-lg bg-surface-700"></div>
                                <div class="mt-2 h-4 bg-surface-600 rounded w-3/4"></div>
                            </div>
                        {/each}
                    </div>
                </div>
            {/each}
        </div>
    {:else if groupedItems.length === 0}
        <!-- Empty State -->
        <div class="text-center py-12 bg-surface-800/50 rounded-lg">
            <Icon src={CalendarDays} class="w-16 h-16 text-gray-600 mx-auto mb-4" />
            <h3 class="text-xl text-gray-300 mb-2">
                {m.calendar_no_upcoming_releases()}
            </h3>
            <p class="text-gray-500">{m.calendar_no_planned_releases()}</p>
        </div>
    {:else}
        <!-- Date Groups -->
        {#each groupedItems as group (group.date)}
            <div class="space-y-3">
                <!-- Date Header -->
                <h3 class="text-lg font-semibold flex items-center gap-2">
                    <span class={group.isToday ? 'text-primary-400' : 'text-gray-300'}>
                        {group.label}
                    </span>
                    {#if group.isToday}
                        <span class="badge variant-filled-primary text-xs"
                            >{m.calendar_today()}</span>
                    {/if}
                    <span class="text-gray-500 text-sm font-normal">
                        ({group.items.length}
                        {m.calendar_titles()})
                    </span>
                </h3>

                <!-- Items Grid -->
                <div
                    class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                    {#each group.items as item (item.id)}
                        <UniversalMediaCard
                            {item}
                            variant="poster"
                            widthClass="w-full"
                            {hasRequestPermission}
                            onclick={handleItemClick}
                            onplay={handleItemPlay} />
                    {/each}
                </div>
            </div>
        {/each}
    {/if}
</section>
