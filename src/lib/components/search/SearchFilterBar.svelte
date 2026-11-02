<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { SearchCategory } from '$lib/constants/search-categories';
    import { Icon } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    interface Props {
        selectedCategoryFilters: Set<string>;
        displayCategories: SearchCategory[];
        counts?: Record<string, number>;
        hasMore?: Record<string, boolean>;
        centered?: boolean;
        /** Every source answered: a category without results is dimmed. */
        settled?: boolean;
        ontoggleFilter?: (key: string) => void;
        onclearAll?: () => void;
    }
    let {
        selectedCategoryFilters,
        displayCategories,
        counts = {},
        hasMore = {},
        centered = false,
        settled = false,
        ontoggleFilter,
        onclearAll,
    }: Props = $props();
</script>

<nav
    aria-label={m.search_filtering()}
    class="flex shrink-0 flex-wrap items-center gap-1.5 px-4 py-3 sm:px-5 {centered
        ? 'justify-center'
        : ''}">
    <button
        type="button"
        aria-pressed={selectedCategoryFilters.size === 0}
        onclick={() => onclearAll?.()}>{m.search_all_categories()}</button>
    {#each displayCategories as cat (cat.key)}
        <button
            type="button"
            class={cat.color}
            class:empty={settled && !counts[cat.key] && !selectedCategoryFilters.has(cat.key)}
            aria-pressed={selectedCategoryFilters.has(cat.key)}
            onclick={() => ontoggleFilter?.(cat.key)}>
            <Icon src={cat.icon} class="w-3 h-3 shrink-0 {cat.iconColor}" />
            <span class="category-label"
                >{cat.key === 'tvchannel'
                    ? m.tab_channels()
                    : cat.key === 'livetv_program'
                      ? m.search_tv_guide_compact()
                      : cat.label}</span>
            {#if counts[cat.key]}<span class="count"
                    >{counts[cat.key]}{hasMore[cat.key] ? '+' : ''}</span
                >{/if}
        </button>
    {/each}
</nav>

<style>
    button {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        max-width: 100%;
        min-height: 2rem;
        padding: 0.25rem 0.5rem;
        border-radius: 0.625rem;
        font-size: 0.75rem;
        background: rgb(255 255 255 / 0.035);
        transition: background-color 150ms ease;
    }
    .category-label {
        color: inherit;
        overflow-wrap: anywhere;
    }
    .count {
        font-size: 0.6875rem;
        font-variant-numeric: tabular-nums;
        opacity: 0.8;
    }
    button.empty {
        opacity: 0.45;
    }
    button:first-child {
        color: var(--color-primary-300, #b7baff);
    }
    button:hover {
        background: color-mix(in srgb, currentColor 9%, transparent);
    }
    button[aria-pressed='true'] {
        background: color-mix(in srgb, currentColor 18%, transparent);
        box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 25%, transparent);
    }
    button[aria-pressed='true'] .category-label {
        color: inherit;
    }
    button:focus-visible {
        outline: 2px solid var(--color-primary-400, #a5b4fc);
        outline-offset: -2px;
    }
</style>
