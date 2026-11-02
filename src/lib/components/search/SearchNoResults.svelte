<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	SearchNoResults.svelte

	No-results empty state for the search modal.
	Extracted from Search.svelte to improve maintainability.

	Note: the legacy "episode not found but series exists" hint was driven by an
	`episodeSearchInfo` field on the search response. The v1 /api/search contract
	returns only { items, page }, so that field no longer exists and the hint has
	been removed.
-->
<script lang="ts">
    import { Icon, MagnifyingGlass } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        searchQuery: string;
        hasActiveFilters: boolean;
        onclearFilters?: () => void;
        fulltextMode?: boolean;
        onincludeDescriptions?: () => void;
    }

    let {
        searchQuery,
        hasActiveFilters,
        onclearFilters,
        fulltextMode = true,
        onincludeDescriptions,
    }: Props = $props();
</script>

<div class="p-8 text-center">
    <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-surface-800 center">
        <Icon src={MagnifyingGlass} class="w-8 h-8 text-surface-500" />
    </div>
    <p class="text-surface-300">
        {m.search_no_results_for({ query: searchQuery })}
    </p>
    <p class="text-surface-300 text-sm mt-2">{m.search_recovery_hint()}</p>
    {#if !fulltextMode}
        <button
            onclick={() => onincludeDescriptions?.()}
            class="mt-4 px-3 py-2 rounded-lg bg-primary-500/15 text-primary-300 text-sm"
            >{m.search_include_descriptions()}</button>
    {/if}
    {#if hasActiveFilters}
        <p class="text-surface-500 text-sm mt-2">
            {m.search_try_removing_filters()}
        </p>
        <button
            onclick={() => onclearFilters?.()}
            class="mt-2 text-xs text-primary-400 hover:text-primary-300 underline underline-offset-2">
            {m.search_clear_filters()}
        </button>
    {/if}
</div>
