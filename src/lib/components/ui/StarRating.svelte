<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- Reusable star rating component — read-only display and interactive input -->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    interface Props {
        value?: number | null;
        max?: number;
        /** Interactive mode: enables hover highlight and click-to-rate */
        interactive?: boolean;
        size?: 'xs' | 'base';
        onchange?: (rating: number) => void;
    }

    let { value = null, max = 10, interactive = false, size = 'xs', onchange }: Props = $props();

    let hovered = $state(0);

    const sizeClass = $derived(size === 'base' ? 'text-base leading-none' : 'text-xs');
</script>

<div
    class="flex items-center gap-0"
    role={interactive ? 'group' : undefined}
    aria-label={interactive ? 'Rating' : undefined}
    onmouseleave={interactive ? () => (hovered = 0) : undefined}>
    {#each Array(max) as _, i (i)}
        {@const filled = i < (hovered || value || 0)}
        {#if interactive}
            <button
                type="button"
                class="{sizeClass} px-0.5 transition-transform hover:scale-125 {filled
                    ? 'text-yellow-400'
                    : 'text-surface-600'}"
                onclick={() => onchange?.(i + 1)}
                onmouseenter={() => (hovered = i + 1)}
                aria-label={m.ui_star_rating_aria({
                    current: String(i + 1),
                    max: String(max),
                })}>★</button>
        {:else}
            <span class="{sizeClass} {filled ? 'text-yellow-400' : 'text-surface-600'}">★</span>
        {/if}
    {/each}
    {#if (hovered > 0 || value) && interactive}
        <span class="ml-1.5 text-xs text-surface-400">{hovered || value}/{max}</span>
    {/if}
</div>
