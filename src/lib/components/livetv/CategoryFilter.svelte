<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { LiveTvCategory } from '$lib/schemas/livetv.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        categories: LiveTvCategory[];
        selectedCategoryId: string | null;
        onselect: (categoryId: string | null) => void;
        totalChannelCount: number;
    }

    let { categories, selectedCategoryId, onselect, totalChannelCount }: Props = $props();

    function handleKeydown(event: KeyboardEvent) {
        const pills = (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(
            '[role="tab"]',
        );
        const currentIndex = Array.from(pills).findIndex((el) => el === document.activeElement);
        if (currentIndex === -1) return;

        let nextIndex: number;
        if (event.key === 'ArrowRight') {
            nextIndex = (currentIndex + 1) % pills.length;
        } else if (event.key === 'ArrowLeft') {
            nextIndex = (currentIndex - 1 + pills.length) % pills.length;
        } else {
            return;
        }

        event.preventDefault();
        pills[nextIndex].focus();
    }
</script>

<div
    class="flex gap-2 overflow-x-auto scroll-smooth snap-x snap-mandatory pb-2"
    role="tablist"
    tabindex="0"
    aria-label={m.media_live_tv()}
    onkeydown={handleKeydown}>
    <button
        role="tab"
        aria-selected={selectedCategoryId === null}
        tabindex={selectedCategoryId === null ? 0 : -1}
        class="snap-start shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors
			{selectedCategoryId === null
            ? 'bg-primary-500 text-white'
            : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
        onclick={() => onselect(null)}>
        {m.livetv_all_channels()} ({totalChannelCount})
    </button>

    {#each categories as category (category.id)}
        <button
            role="tab"
            aria-selected={selectedCategoryId === category.id}
            tabindex={selectedCategoryId === category.id ? 0 : -1}
            class="snap-start shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors
				{selectedCategoryId === category.id
                ? 'bg-primary-500 text-white'
                : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
            onclick={() => onselect(category.id)}>
            {category.name}{category.channelCount != null ? ` (${category.channelCount})` : ''}
        </button>
    {/each}
</div>
