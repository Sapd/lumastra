<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Skeleton } from '$lib/components/ui';

    type Variant = 'track-carousel' | 'artist-row' | 'album-carousel';

    interface Props {
        variant: Variant;
        count?: number;
        /**
         * Number of stacked rows the *loaded* section renders. The genre and
         * Quick Picks carousels are 2-row (`meta.rows: 2`); every other music
         * shelf is single-row. The skeleton must reserve the same row count so
         * the streamed section doesn't shove the page down when it lands
         * (the "content jumps around while sections load" CLS).
         */
        rows?: number;
    }

    let { variant, count = 6, rows = 1 }: Props = $props();

    const isArtist = $derived(variant === 'artist-row');
    const mediaClass = $derived(
        isArtist ? 'aspect-square rounded-full' : 'aspect-square rounded-md',
    );

    // Match StandardSection's resolved card width so the reserved HEIGHT
    // (aspect-square ⇒ height == width) equals the real cards': single-row
    // square music shelves render `w-36`; the 2-row genre / Quick Picks
    // carousels override to `w-28`. A width mismatch here would make the
    // skeleton a different height than the content that replaces it.
    const isMultiRow = $derived(rows > 1);
    const cardWidth = $derived(isMultiRow ? 'w-28' : 'w-36');
    // rem equivalent of the card width, used as the multi-row grid column size
    // (mirrors StandardSection.multi-row-carousel so columns match the cover).
    const columnRem = $derived(isMultiRow ? '7rem' : '9rem');
</script>

{#snippet card()}
    <div data-testid="skeleton-card" class="{cardWidth} shrink-0 space-y-2">
        <div class="{mediaClass} w-full">
            <Skeleton width="w-full" height="h-full" rounded={isArtist ? 'full' : 'md'} />
        </div>
        <Skeleton width="w-full" height="h-3" rounded="md" />
        <Skeleton width="w-3/4" height="h-3" rounded="md" />
    </div>
{/snippet}

<div class="space-y-4">
    <Skeleton width="w-40" height="h-6" rounded="md" />

    {#if isMultiRow}
        <div
            class="grid gap-3 overflow-hidden"
            style="grid-auto-flow: column; grid-template-rows: repeat({rows}, auto); grid-auto-columns: {columnRem};">
            {#each Array(count * rows) as _, i (i)}
                {@render card()}
            {/each}
        </div>
    {:else}
        <div class="flex gap-3 overflow-hidden">
            {#each Array(count) as _, i (i)}
                {@render card()}
            {/each}
        </div>
    {/if}
</div>
