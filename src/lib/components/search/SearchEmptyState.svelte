<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { Icon, MagnifyingGlass } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    interface Props {
        recentSearches?: string[];
        onselectRecent?: (query: string) => void;
        onclearRecent?: () => void;
        children?: Snippet;
    }
    let { recentSearches = [], onselectRecent, onclearRecent, children }: Props = $props();
</script>

<div class="px-5 py-8 sm:py-10">
    <div class="text-center">
        <div class="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-white/5">
            <Icon src={MagnifyingGlass} class="h-7 w-7 text-surface-400" />
        </div>
        <p class="text-surface-200 text-base font-medium">{m.search_type_to_search()}</p>
    </div>
    {#if children}<div class="mt-5">{@render children()}</div>{/if}
    {#if recentSearches.length > 0}
        <div class="flex items-center justify-between mt-5 mb-2">
            <h2 class="text-xs font-medium text-surface-300">{m.search_recent_searches()}</h2>
            <button
                onclick={() => onclearRecent?.()}
                class="text-xs text-surface-400 hover:text-white p-2"
                >{m.search_clear_recent()}</button>
        </div>
        <div class="flex flex-col gap-1">
            {#each recentSearches as recent (recent)}
                <button
                    onclick={() => onselectRecent?.(recent)}
                    class="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-surface-200 hover:bg-white/5">
                    <Icon src={MagnifyingGlass} class="w-4 h-4 text-surface-400 shrink-0" /><span
                        class="truncate">{recent}</span>
                </button>
            {/each}
        </div>
    {/if}
</div>
