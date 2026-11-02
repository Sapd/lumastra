<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Category chips above the Live TV grid and guide: "All · Sports 312 · News 140".
  The chips wrap instead of scrolling sideways. Collapsed, the largest
  categories (and the selected one) show, and "More" opens the rest.
  A filter, not tabs: buttons with aria-pressed in a labelled group; arrow keys
  move between the shown chips (one tab stop).
-->
<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    import * as m from '$lib/paraglide/messages.js';
    import type { GenreChip } from '$lib/shared/livetv-genres.js';

    interface Props {
        chips: GenreChip[];
        selected: string | null;
        onselect: (slug: string | null) => void;
    }

    let { chips, selected, onselect }: Props = $props();

    /** Chips shown while collapsed, besides "All" and the selected one. */
    const COLLAPSED = 7;
    let expanded = $state(false);
    const failedImages = new SvelteSet<string>();

    // The largest categories stay in view, in their category order.
    const topSlugs = $derived(
        new Set(
            [...chips]
                .sort((a, b) => b.count - a.count)
                .slice(0, COLLAPSED)
                .map((c) => c.slug),
        ),
    );
    const collapsible = $derived(chips.length > COLLAPSED + 1);
    const shownChips = $derived(
        !collapsible || expanded
            ? chips
            : chips.filter((c) => topSlugs.has(c.slug) || c.slug === selected),
    );
    const hiddenCount = $derived(chips.length - shownChips.length);

    type Item = { slug: string | null; name: string; count?: number; imageUrl?: string };
    const items = $derived<Item[]>([{ slug: null, name: m.livetv_genre_all() }, ...shownChips]);
    const activeIndex = $derived(
        Math.max(
            0,
            items.findIndex((i) => i.slug === selected),
        ),
    );

    function onkeydown(event: KeyboardEvent): void {
        const keys: Record<string, number> = {
            ArrowRight: activeIndex + 1,
            ArrowLeft: activeIndex - 1,
            Home: 0,
            End: items.length - 1,
        };
        if (!(event.key in keys)) return;
        const target = event.target as HTMLElement;
        if (target.dataset.genreChip === undefined) return;
        event.preventDefault();
        const next = Math.min(items.length - 1, Math.max(0, keys[event.key]));
        if (next === activeIndex) return;
        onselect(items[next].slug);
        const row = event.currentTarget as HTMLElement;
        // By slug, not index: selecting can change which chips are shown.
        const slug = items[next].slug ?? '';
        queueMicrotask(() =>
            row
                .querySelector<HTMLButtonElement>(`[data-genre-chip="${CSS.escape(slug)}"]`)
                ?.focus(),
        );
    }

    function imageFailed(url: string): void {
        failedImages.add(url);
    }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="flex flex-wrap gap-2" role="group" aria-label={m.livetv_genre_label()} {onkeydown}>
    {#each items as item, i (item.slug ?? '')}
        {@const pressed = i === activeIndex}
        {@const showImage = item.imageUrl && !failedImages.has(item.imageUrl)}
        <button
            type="button"
            data-genre-chip={item.slug ?? ''}
            aria-pressed={pressed}
            tabindex={pressed ? 0 : -1}
            class="flex min-h-10 items-center gap-1.5 rounded-full px-3 text-sm transition-colors
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-400 2xl:min-h-12 2xl:text-base
                {pressed
                ? 'bg-primary-600 text-white'
                : 'bg-surface-800 text-surface-300 hover:bg-surface-700'}"
            onclick={() => onselect(item.slug)}>
            {#if showImage}
                <img
                    src={item.imageUrl}
                    alt=""
                    loading="lazy"
                    class="h-5 w-5 shrink-0 rounded object-contain bg-surface-900/60"
                    onerror={() => imageFailed(item.imageUrl!)} />
            {/if}
            {item.name}
            {#if item.count !== undefined}
                <span class="hidden text-xs opacity-70 sm:inline">{item.count}</span>
            {/if}
        </button>
    {/each}
    {#if collapsible}
        <button
            type="button"
            aria-expanded={expanded}
            class="min-h-10 rounded-full px-3 text-sm text-primary-300 hover:bg-surface-800 2xl:min-h-12 2xl:text-base"
            onclick={() => (expanded = !expanded)}>
            {expanded ? m.livetv_genre_less() : m.livetv_genre_more({ count: hiddenCount })}
        </button>
    {/if}
</div>
