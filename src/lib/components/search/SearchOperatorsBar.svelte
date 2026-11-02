<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	SearchOperatorsBar.svelte

	Display parsed search operators (year, rating, genre, exclude filters).
	Extracted from Search.svelte to improve maintainability.
-->
<script lang="ts">
    import type { SearchOperators } from '$lib/utils/search/query-parser';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        // Props
        parsedOperators: SearchOperators;
    }

    let { parsedOperators }: Props = $props();

    let hasOperators = $derived(
        parsedOperators.yearMin !== undefined ||
            parsedOperators.ratingMin !== undefined ||
            parsedOperators.genres !== undefined ||
            (parsedOperators.exclude?.length ?? 0) > 0,
    );
</script>

{#if hasOperators}
    <div
        class="flex items-center gap-2 px-4 py-1.5 border-b border-surface-700 bg-surface-800/20 overflow-x-auto scrollbar-hide">
        <span class="text-xs text-surface-500 shrink-0">{m.search_operators()}:</span>
        {#if parsedOperators.yearMin !== undefined}
            <span class="badge badge-outline-info gap-1 shrink-0">
                📅 {parsedOperators.yearMin}{parsedOperators.yearMax &&
                parsedOperators.yearMax !== parsedOperators.yearMin
                    ? `-${parsedOperators.yearMax}`
                    : ''}
            </span>
        {/if}
        {#if parsedOperators.ratingMin !== undefined}
            <span class="badge badge-outline-warning gap-1 shrink-0">
                ⭐ ≥{parsedOperators.ratingMin}
            </span>
        {/if}
        {#if parsedOperators.genres && parsedOperators.genres.length > 0}
            <span class="badge badge-purple border border-purple-500/30 gap-1 shrink-0">
                🎭 {parsedOperators.genres.join(', ')}
            </span>
        {/if}
        {#if parsedOperators.exclude && parsedOperators.exclude.length > 0}
            {#each parsedOperators.exclude as term, termIdx (term + '-' + termIdx)}
                <span class="badge badge-outline-error gap-1 shrink-0">
                    ✕ {term}
                </span>
            {/each}
        {/if}
    </div>
{/if}

<style>
    /* Hide scrollbar for horizontal scroll areas */
    .scrollbar-hide {
        -ms-overflow-style: none;
        scrollbar-width: none;
    }
    .scrollbar-hide::-webkit-scrollbar {
        display: none;
    }
</style>
