<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	SearchLoadingState.svelte

	Skeleton loading animation shown while initial search is in progress.
	Extracted from Search.svelte to improve maintainability.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';

    interface Props {
        // Props
        searchQuery: string;
    }

    let { searchQuery }: Props = $props();
</script>

<div class="p-4 space-y-4 animate-pulse">
    <!-- Skeleton section header -->
    <div class="flex items-center gap-2 mb-3">
        <div class="w-4 h-4 bg-surface-700 rounded"></div>
        <div class="w-20 h-4 bg-surface-700 rounded"></div>
    </div>
    <!-- Skeleton cards (list layout) -->
    {#each Array(4) as _, i (i)}
        <div class="flex gap-3 p-2 rounded-lg bg-surface-800/50">
            <!-- Poster skeleton -->
            <div class="w-12 h-18 bg-surface-700 rounded shrink-0"></div>
            <!-- Content skeleton -->
            <div class="flex-1 space-y-2 py-1">
                <div class="h-4 bg-surface-700 rounded w-3/4"></div>
                <div class="h-3 bg-surface-700/70 rounded w-1/2"></div>
                <div class="h-3 bg-surface-700/50 rounded w-1/4"></div>
            </div>
        </div>
    {/each}
    <!-- Second section skeleton -->
    <div class="flex items-center gap-2 mb-3 mt-6">
        <div class="w-4 h-4 bg-surface-700 rounded"></div>
        <div class="w-16 h-4 bg-surface-700 rounded"></div>
    </div>
    {#each Array(2) as _, i (i)}
        <div class="flex gap-3 p-2 rounded-lg bg-surface-800/50">
            <div class="w-12 h-18 bg-surface-700 rounded shrink-0"></div>
            <div class="flex-1 space-y-2 py-1">
                <div class="h-4 bg-surface-700 rounded w-2/3"></div>
                <div class="h-3 bg-surface-700/70 rounded w-1/3"></div>
            </div>
        </div>
    {/each}
    <p class="text-surface-500 text-center text-sm mt-4">
        {m.search_searching_for({ query: searchQuery })}
    </p>
</div>
