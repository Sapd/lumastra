<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import { Icon, ChevronRight } from 'svelte-hero-icons';
    import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        item: UniversalMediaItem;
        selected?: boolean;
        onopen: () => void;
        children: Snippet;
    }
    let { item, selected = false, onopen, children }: Props = $props();
</script>

<div
    data-search-item-id={item.id}
    class="search-result-detail relative mb-2 rounded-xl border border-white/5 bg-white/[0.025] transition-colors motion-reduce:transition-none"
    class:selected>
    {@render children()}
    <button
        type="button"
        onclick={onopen}
        aria-label={m.search_open()}
        title={m.search_open()}
        class="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full text-surface-300 hover:bg-white/10 hover:text-surface-100 focus-visible:outline-primary-400">
        <Icon src={ChevronRight} class="h-4 w-4" />
    </button>
</div>

<style>
    .search-result-detail :global(.media-list-title-year) {
        display: inline;
    }
    .search-result-detail :global(.media-list-footer-year) {
        display: none;
    }
    .search-result-detail :global(.media-list-header) {
        padding-right: 2rem;
    }
    .search-result-detail :global(.media-list-footer) {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.75rem;
    }
    .search-result-detail :global(.media-list-actions) {
        display: contents;
    }
    .search-result-detail :global(.media-list-metadata) {
        order: 1;
        margin-bottom: 0;
    }
    .search-result-detail :global(.media-list-metadata:empty),
    .search-result-detail :global(.media-list-metadata:has(> .media-list-footer-year:only-child)) {
        display: none;
    }
    .search-result-detail:hover {
        background: rgb(255 255 255 / 0.045);
    }
    .search-result-detail.selected {
        background: rgb(99 102 241 / 0.16);
        border-color: rgb(129 140 248 / 0.45);
    }
    .search-result-detail :global(.media-list-card) {
        border: 0;
        background: transparent;
        padding: 0.875rem;
    }
    .search-result-detail :global(.media-list-card > div > [role='button']:first-child) {
        width: 5rem;
        height: 7rem;
        transform-origin: top left;
        animation: poster-enter 200ms ease-out;
    }
    @media (min-width: 640px) {
        .search-result-detail :global(.media-list-card > div > [role='button']:first-child) {
            width: 6rem;
            height: 8.4rem;
        }
    }
    .search-result-detail :global(.media-list-card > div > .square-artwork:first-child) {
        height: 5rem;
    }
    @media (min-width: 640px) {
        .search-result-detail :global(.media-list-card > div > .square-artwork:first-child) {
            height: 6rem;
        }
    }
    @keyframes poster-enter {
        from {
            transform: scale(0.8);
        }
        to {
            transform: scale(1);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .search-result-detail :global(.media-list-card > div > [role='button']:first-child) {
            animation: none;
        }
    }
</style>
