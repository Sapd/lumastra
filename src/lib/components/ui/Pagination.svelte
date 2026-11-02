<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    // Helper to calculate which page numbers to show
    function getPageNumber(index: number, current: number, total: number): number {
        if (total <= 7) {
            return index + 1;
        }

        // Always show first and last
        if (index === 0) return 1;
        if (index === 6) return total;

        // Show ellipsis positions
        if (current <= 4) {
            // Near start
            if (index <= 4) return index + 1;
            if (index === 5) return -1; // ellipsis
            return total;
        } else if (current >= total - 3) {
            // Near end
            if (index === 1) return -1; // ellipsis
            return total - (6 - index);
        } else {
            // Middle
            if (index === 1) return -1; // ellipsis
            if (index === 5) return -1; // ellipsis
            return current + (index - 3);
        }
    }
</script>

<script lang="ts">
    import { Icon, ChevronLeft, ChevronRight } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    // Additional classes
    interface Props {
        // Pagination data
        offset?: number;
        limit?: number;
        hasMore?: boolean;
        totalCount?: number | undefined;
        loading?: boolean;
        // Display mode
        mode?: 'loadMore' | 'pages' | 'simple';
        // Size
        size?: 'sm' | 'md';
        class?: string;
        onloadMore?: () => void;
        onpageChange?: (detail: { offset: number; page: number }) => void;
        onprev?: () => void;
        onnext?: () => void;
    }

    let {
        offset = 0,
        limit = 20,
        hasMore = false,
        totalCount = undefined,
        loading = false,
        mode = 'loadMore',
        size = 'md',
        class: className = '',
        onloadMore,
        onpageChange,
        onprev,
        onnext,
    }: Props = $props();

    // Computed values
    let currentPage = $derived(Math.floor(offset / limit) + 1);
    let totalPages = $derived(totalCount ? Math.ceil(totalCount / limit) : undefined);
    let showingStart = $derived(offset + 1);
    let showingEnd = $derived(totalCount ? Math.min(offset + limit, totalCount) : offset + limit);

    // Size classes
    const sizeClasses = {
        sm: 'text-sm',
        md: 'text-base',
    };

    const buttonSizeClasses = {
        sm: 'px-3 py-1 text-sm',
        md: 'px-4 py-2',
    };

    function handleLoadMore() {
        if (!loading && hasMore) {
            onloadMore?.();
        }
    }

    function handlePrev() {
        if (!loading && offset > 0) {
            const newOffset = Math.max(0, offset - limit);
            onpageChange?.({
                offset: newOffset,
                page: Math.floor(newOffset / limit) + 1,
            });
            onprev?.();
        }
    }

    function handleNext() {
        if (!loading && hasMore) {
            const newOffset = offset + limit;
            onpageChange?.({
                offset: newOffset,
                page: currentPage + 1,
            });
            onnext?.();
        }
    }

    function goToPage(page: number) {
        if (!loading && page >= 1 && (!totalPages || page <= totalPages)) {
            const newOffset = (page - 1) * limit;
            onpageChange?.({ offset: newOffset, page });
        }
    }
</script>

<div class="pagination flex items-center gap-3 {sizeClasses[size]} {className}">
    {#if mode === 'loadMore'}
        <!-- Load More Button Mode -->
        {#if hasMore}
            <button
                type="button"
                disabled={loading}
                onclick={handleLoadMore}
                class="btn btn-surface {buttonSizeClasses[size]} w-full">
                {#if loading}
                    <span class="loading-spinner loading-spinner-white w-4 h-4"></span>
                    <span>Loading...</span>
                {:else}
                    <span>Load More</span>
                {/if}
            </button>
        {/if}
    {:else if mode === 'simple'}
        <!-- Simple Prev/Next Mode -->
        <button
            type="button"
            disabled={loading || offset === 0}
            onclick={handlePrev}
            class="btn btn-ghost {buttonSizeClasses[size]} disabled:opacity-50">
            <Icon src={ChevronLeft} class="w-4 h-4" />
            <span>Previous</span>
        </button>

        {#if totalCount}
            <span class="text-surface-400">
                {showingStart}-{showingEnd} of {totalCount}
            </span>
        {:else}
            <span class="text-surface-400">
                Page {currentPage}
            </span>
        {/if}

        <button
            type="button"
            disabled={loading || !hasMore}
            onclick={handleNext}
            class="btn btn-ghost {buttonSizeClasses[size]} disabled:opacity-50">
            <span>Next</span>
            <Icon src={ChevronRight} class="w-4 h-4" />
        </button>
    {:else if mode === 'pages'}
        <!-- Full Page Navigation Mode -->
        <button
            type="button"
            disabled={loading || offset === 0}
            onclick={handlePrev}
            class="btn btn-ghost p-2 disabled:opacity-50"
            aria-label={m.ui_previous_page_aria()}>
            <Icon src={ChevronLeft} class="w-5 h-5" />
        </button>

        <div class="flex items-center gap-1">
            {#if totalPages}
                {#each Array.from({ length: Math.min(totalPages, 7) }) as _, i (i)}
                    {@const page = getPageNumber(i, currentPage, totalPages)}
                    {#if page === -1}
                        <span class="px-2 text-surface-500">...</span>
                    {:else}
                        <button
                            type="button"
                            disabled={loading}
                            onclick={() => goToPage(page)}
                            class="min-w-[2rem] h-8 rounded {page === currentPage
                                ? 'bg-primary-600 text-white'
                                : 'hover:bg-surface-700 text-surface-300'}">
                            {page}
                        </button>
                    {/if}
                {/each}
            {:else}
                <span class="px-3 py-1 bg-primary-600 text-white rounded">
                    {currentPage}
                </span>
            {/if}
        </div>

        <button
            type="button"
            disabled={loading || !hasMore}
            onclick={handleNext}
            class="btn btn-ghost p-2 disabled:opacity-50"
            aria-label={m.ui_next_page_aria()}>
            <Icon src={ChevronRight} class="w-5 h-5" />
        </button>

        {#if totalCount}
            <span class="text-surface-400 ml-2">
                {totalCount.toLocaleString()} total
            </span>
        {/if}
    {/if}
</div>
