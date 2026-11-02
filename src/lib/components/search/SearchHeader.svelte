<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	SearchHeader.svelte

	Search modal header with input, clear button, fulltext toggle, and close button.
	Extracted from Search.svelte to improve maintainability.
-->
<script lang="ts">
    import { Icon, MagnifyingGlass, XMark, XCircle, DocumentText } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        // Props
        searchQuery: string;
        isLoading: boolean;
        fulltextMode: boolean;
        descriptionLoading?: boolean;
        searchInput?: HTMLInputElement | undefined;
        // Callbacks
        onclear?: () => void;
        ontoggleFulltext?: () => void;
        onclose?: () => void;
        onkeydown?: (event: KeyboardEvent) => void;
    }

    let {
        searchQuery = $bindable(),
        isLoading,
        fulltextMode,
        descriptionLoading = false,
        searchInput = $bindable(undefined),
        onclear,
        ontoggleFulltext,
        onclose,
        onkeydown,
    }: Props = $props();

    function handleInputKeydown(event: KeyboardEvent) {
        onkeydown?.(event);
    }
</script>

<div class="search-header flex shrink-0 items-center gap-1 px-3 py-3 sm:gap-2 sm:px-5 sm:py-4">
    <div class="flex min-w-0 flex-1 items-center gap-3">
        <Icon src={MagnifyingGlass} class="w-5 h-5 text-surface-400 shrink-0" />
        <!-- Input container with clear button inside -->
        <div class="flex-1 min-w-0 relative flex items-center">
            <input
                bind:this={searchInput}
                bind:value={searchQuery}
                onkeydown={handleInputKeydown}
                type="text"
                placeholder={m.search_placeholder()}
                class="search-input w-full min-w-0 rounded-md bg-transparent py-2 text-white text-lg sm:text-xl placeholder-surface-400 pr-10"
                aria-label={m.common_search()}
                aria-busy={isLoading}
                autocomplete="off"
                autocorrect="off"
                spellcheck="false" />
            <!-- Clear search button - inside input, only show when there's text -->
            {#if searchQuery.length > 0}
                <button
                    onclick={() => onclear?.()}
                    type="button"
                    class="absolute right-0 grid h-10 w-10 place-items-center rounded-md text-surface-400 hover:text-surface-200 transition-colors"
                    aria-label={m.btn_clear_search()}>
                    <Icon src={XCircle} class="w-4 h-4" solid />
                </button>
            {/if}
        </div>
        {#if isLoading}
            <span class="loading-spinner loading-spinner-primary w-5 h-5"></span>
        {/if}
    </div>
    <button
        type="button"
        aria-label={m.search_include_descriptions()}
        title={m.search_include_descriptions()}
        aria-pressed={fulltextMode}
        aria-busy={descriptionLoading}
        onclick={() => ontoggleFulltext?.()}
        class="description-toggle flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary-400 {fulltextMode
            ? 'bg-primary-500/15 text-primary-300'
            : 'text-surface-300 hover:bg-white/5 hover:text-white'}">
        {#if descriptionLoading}
            <span
                role="status"
                aria-label={m.search_descriptions_loading()}
                class="loading-spinner w-4 h-4"></span>
        {:else}
            <Icon src={DocumentText} class="w-5 h-5" />
        {/if}
        <span class="hidden sm:inline">{m.search_descriptions_short()}</span>
    </button>
    <button
        type="button"
        aria-label={m.close()}
        onclick={() => onclose?.()}
        class="grid h-11 w-11 shrink-0 place-items-center text-surface-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors">
        <Icon src={XMark} class="w-5 h-5" />
    </button>
</div>

<style>
    .search-header {
        background: rgb(255 255 255 / 0.035);
        border-bottom: 1px solid rgb(255 255 255 / 0.06);
        border-radius: inherit;
        border-bottom-left-radius: 0;
        border-bottom-right-radius: 0;
    }
    /* The whole header is the search field: focus shows on its bottom edge
       rather than as a second box drawn around the input. */
    .search-header:has(.search-input:focus-visible) {
        border-bottom-color: color-mix(in srgb, var(--color-primary-400, #a5b4fc) 60%, transparent);
    }
    .search-input {
        outline: none;
    }
</style>
