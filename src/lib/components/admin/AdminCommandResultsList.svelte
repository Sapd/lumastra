<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { tick } from 'svelte';
    import { Icon, Clock, type IconSource } from 'svelte-hero-icons';
    import type { PaletteResults, PaletteDestination } from '$lib/utils/admin/command-palette';
    import type { FlatPaletteItem } from '$lib/utils/admin/use-command-palette.svelte';
    import type { RecentEntry } from '$lib/utils/admin/command-palette-recents';

    interface Props {
        recents: RecentEntry[];
        results: PaletteResults;
        flat: FlatPaletteItem[];
        selectedIndex: number;
        pagesOffset: number;
        settingsOffset: number;
        providersOffset: number;
        onhoverindex: (index: number) => void;
        onactivate: (item: FlatPaletteItem) => void;
    }
    let {
        recents,
        results,
        flat,
        selectedIndex,
        pagesOffset,
        settingsOffset,
        providersOffset,
        onhoverindex,
        onactivate,
    }: Props = $props();

    let listEl = $state<HTMLElement | null>(null);

    // Keep the selected row visible as selection moves (keyboard nav or hover).
    $effect(() => {
        void selectedIndex;
        void tick().then(() => {
            listEl
                ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
                ?.scrollIntoView({ block: 'nearest' });
        });
    });

    function iconFor(dest: PaletteDestination): IconSource | undefined {
        return dest.icon;
    }
</script>

<div bind:this={listEl} class="max-h-[60vh] overflow-y-auto py-2">
    {#if flat.length === 0}
        <div class="px-4 py-6 text-center text-sm text-surface-500">No results</div>
    {/if}

    {#if recents.length > 0}
        <div class="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-surface-500">
            Recent
        </div>
        {#each recents as entry, i (entry.href)}
            <button
                type="button"
                tabindex="-1"
                data-index={i}
                class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors"
                class:bg-surface-700={selectedIndex === i}
                onmousemove={() => onhoverindex(i)}
                onclick={() => onactivate(flat[i])}>
                <Icon src={Clock} class="w-4 h-4 text-surface-400 shrink-0" />
                <span class="text-white">{entry.label}</span>
                {#if entry.sectionLabel}
                    <span class="ml-auto text-xs text-surface-500">{entry.sectionLabel} →</span>
                {/if}
            </button>
        {/each}
    {/if}

    {#if results.pages.length > 0}
        <div class="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-surface-500">
            Pages
        </div>
        {#each results.pages as dest, i (dest.href)}
            {@const icon = iconFor(dest)}
            {@const idx = pagesOffset + i}
            <button
                type="button"
                tabindex="-1"
                data-index={idx}
                class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors"
                class:bg-surface-700={selectedIndex === idx}
                onmousemove={() => onhoverindex(idx)}
                onclick={() => onactivate(flat[idx])}>
                {#if icon}<Icon src={icon} class="w-4 h-4 text-surface-400 shrink-0" />{/if}
                {#if dest.parentTitle}
                    <span class="text-surface-400">{dest.parentTitle} ›</span>
                {/if}
                <span class="text-white">{dest.title}</span>
                <span class="ml-auto text-xs text-surface-500">{dest.sectionTitle} →</span>
            </button>
        {/each}
    {/if}

    {#if results.settings.length > 0}
        <div class="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-surface-500">
            Settings
        </div>
        {#each results.settings as match, i (match.setting.key)}
            {@const idx = settingsOffset + i}
            <button
                type="button"
                tabindex="-1"
                data-index={idx}
                class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors"
                class:bg-surface-700={selectedIndex === idx}
                onmousemove={() => onhoverindex(idx)}
                onclick={() => onactivate(flat[idx])}>
                <span class="text-white">{match.setting.label}</span>
                <span class="ml-auto text-xs text-surface-500"
                    >{match.pageLabel} · {match.section.label} →</span>
            </button>
        {/each}
    {/if}

    {#if results.providers.length > 0}
        <div class="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-surface-500">
            Providers
        </div>
        {#each results.providers as entry, i (entry.id)}
            {@const idx = providersOffset + i}
            <button
                type="button"
                tabindex="-1"
                data-index={idx}
                class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors"
                class:bg-surface-700={selectedIndex === idx}
                onmousemove={() => onhoverindex(idx)}
                onclick={() => onactivate(flat[idx])}>
                <span class="text-white">{entry.label}</span>
                <span class="ml-auto text-xs text-surface-500">{entry.category} →</span>
            </button>
        {/each}
    {/if}
</div>
