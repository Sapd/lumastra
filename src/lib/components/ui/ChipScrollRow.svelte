<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    ChipScrollRow

    Shared container for horizontally-scrollable chip lists with:
    - dragScroll support
    - No-clip padding for ring/shadow on edge chips
    - Progressive reveal via IntersectionObserver sentinel

    Usage:
        <ChipScrollRow totalCount={items.length}>
            {#snippet children(visibleCount)}
                {#each items.slice(0, visibleCount) as item}
                    <Chip ... />
                {/each}
            {/snippet}
        </ChipScrollRow>

    Fixed chips that are always visible (e.g. Auto, Clear) should be
    rendered inside the snippet before the sliced list — they are not
    counted toward totalCount or visibleCount.
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import type { Snippet } from 'svelte';
    import { dragScroll } from '$lib/utils/drag-scroll';

    interface Props {
        /** Total number of progressive items (controls hasMore / sentinel). */
        totalCount: number;
        /** How many items to show on first render. */
        initialCount?: number;
        /** How many more items to reveal each time the sentinel fires. */
        loadMoreCount?: number;
        children: Snippet<[visibleCount: number]>;
    }

    let { totalCount, initialCount = 12, loadMoreCount = 8, children }: Props = $props();

    let visibleCount = $state(untrack(() => initialCount));
    let sentinelEl = $state<HTMLElement | null>(null);
    let hasMore = $derived(visibleCount < totalCount);

    // Only re-run when sentinelEl changes (mounts/unmounts). The condition
    // visibleCount < totalCount is checked inside the callback so the observer
    // is created once per sentinel lifecycle, not on every visibleCount tick.
    $effect(() => {
        if (!sentinelEl) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && visibleCount < totalCount) {
                    visibleCount += Math.max(1, loadMoreCount);
                }
            },
            { threshold: 0.1 },
        );
        observer.observe(sentinelEl);
        return () => observer.disconnect();
    });
</script>

<div class="chip-row-container">
    <div
        class="chip-row flex gap-2 overflow-x-auto pb-2 smooth-scroll"
        use:dragScroll={{ scrollSpeed: 1 }}>
        {@render children(visibleCount)}

        <!-- Sentinel: triggers the next batch when it scrolls into view -->
        {#if hasMore}
            <div bind:this={sentinelEl} class="shrink-0 w-8 self-center" aria-hidden="true"></div>
        {/if}
    </div>
</div>

<style lang="postcss">
    .chip-row-container {
        position: relative;
    }

    .chip-row {
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
        /* Horizontal padding prevents ring/shadow on edge chips from
           being clipped by the overflow container. */
        padding: 0.25rem 0.25rem;
        margin: -0.25rem -0.25rem;
    }

    .chip-row::-webkit-scrollbar {
        height: 4px;
    }

    .chip-row::-webkit-scrollbar-track {
        background: transparent;
    }

    .chip-row::-webkit-scrollbar-thumb {
        background-color: rgba(255, 255, 255, 0.2);
        border-radius: 2px;
    }

    .chip-row::-webkit-scrollbar-thumb:hover {
        background-color: rgba(255, 255, 255, 0.3);
    }
</style>
