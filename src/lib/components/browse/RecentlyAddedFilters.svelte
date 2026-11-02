<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    RecentlyAddedFilters.svelte

    A popover filter control for the Recently Added section.
    Provides library selector, newness mode segmented control, and
    debounced title search. Anchored to the right of its trigger button.

    @example
    <RecentlyAddedFilters
        libraries={[...]}
        bind:selectedGroup
        bind:newnessMode
        bind:searchQuery
    />
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { clickOutside } from '$lib/utils/click-outside';
    import { debounce } from '$lib/utils/debounce';

    interface Library {
        id: string;
        name: string;
        /** Canonical token from /api/browse/libraries ('series', not 'tv'). */
        mediaType: 'movie' | 'series' | 'mixed';
    }

    interface Props {
        libraries?: Library[];
        selectedGroup?: string | null;
        newnessMode?: 'everything' | 'seasons' | 'titles';
        searchQuery?: string;
    }

    let {
        libraries = [],
        selectedGroup = $bindable(null),
        newnessMode = $bindable('titles' as 'everything' | 'seasons' | 'titles'),
        searchQuery = $bindable(''),
    }: Props = $props();

    let open = $state(false);

    // Local search input value — debounced before writing to searchQuery
    let localSearch = $state(searchQuery);

    const DEBOUNCE_MS = 250;

    const flushSearch = debounce((value: string) => {
        searchQuery = value;
    }, DEBOUNCE_MS);

    function handleSearchInput(e: Event) {
        const val = (e.currentTarget as HTMLInputElement).value;
        localSearch = val;
        flushSearch(val);
    }

    // Show an active indicator on the trigger when any non-default filter is set
    // (default newness mode is 'titles' — only brand-new titles).
    let isActive = $derived(
        selectedGroup !== null || newnessMode !== 'titles' || searchQuery.trim() !== '',
    );

    function toggleOpen() {
        open = !open;
    }

    function closePopover() {
        open = false;
    }

    function selectGroup(id: string | null) {
        selectedGroup = id;
    }

    function selectNewness(mode: 'everything' | 'seasons' | 'titles') {
        newnessMode = mode;
    }

    const NEWNESS_OPTIONS: { value: 'everything' | 'seasons' | 'titles'; label: () => string }[] = [
        // Ordered narrowest → broadest so the labels read as an additive ladder:
        // "New titles" (base) → "+ New seasons" → "+ New episodes" (everything).
        { value: 'titles', label: () => m.browse_recently_added_show_new_titles() },
        { value: 'seasons', label: () => m.browse_recently_added_show_new_seasons() },
        { value: 'everything', label: () => m.browse_recently_added_show_everything() },
    ];
</script>

<div class="raf-root" use:clickOutside={closePopover}>
    <!-- Trigger button -->
    <button
        class="raf-trigger az-type-chip {open ? 'active' : ''}"
        onclick={toggleOpen}
        type="button"
        aria-expanded={open}
        aria-haspopup="true">
        {m.browse_recently_added_filters()}
        {#if isActive}
            <span class="raf-active-dot" aria-hidden="true"></span>
        {/if}
    </button>

    <!-- Popover panel -->
    {#if open}
        <div class="raf-popover" role="dialog" aria-label={m.browse_recently_added_filters()}>
            <!-- Library selector -->
            {#if libraries.length > 0}
                <section class="raf-section">
                    <span class="raf-section-label">{m.browse_recently_added_library_label()}</span>
                    <div class="raf-chips">
                        <button
                            class="az-type-chip raf-chip {selectedGroup === null ? 'active' : ''}"
                            onclick={() => selectGroup(null)}
                            type="button">
                            {m.browse_recently_added_all_libraries()}
                        </button>
                        {#each libraries as lib (lib.id)}
                            <button
                                class="az-type-chip raf-chip {selectedGroup === lib.id
                                    ? 'active'
                                    : ''}"
                                onclick={() => selectGroup(lib.id)}
                                type="button">
                                {lib.name}
                            </button>
                        {/each}
                    </div>
                </section>
            {/if}

            <!-- Newness mode segmented control -->
            <section class="raf-section">
                <div class="raf-segmented" role="group">
                    {#each NEWNESS_OPTIONS as opt (opt.value)}
                        <button
                            class="raf-seg-btn {newnessMode === opt.value ? 'active' : ''}"
                            onclick={() => selectNewness(opt.value)}
                            type="button">
                            {opt.label()}
                        </button>
                    {/each}
                </div>
            </section>

            <!-- Search input -->
            <section class="raf-section">
                <input
                    class="raf-search-input"
                    type="text"
                    maxlength="100"
                    value={localSearch}
                    oninput={handleSearchInput}
                    placeholder={m.browse_recently_added_search_placeholder()} />
            </section>
        </div>
    {/if}
</div>

<style lang="postcss">
    .raf-root {
        position: relative;
        display: inline-flex;
    }

    /* Reuse az-type-chip from AzBrowseView for the trigger */
    .raf-trigger {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.5rem 1rem;
        border-radius: 2rem;
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-300);
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
    }

    .raf-trigger:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-100);
    }

    .raf-trigger.active {
        background: var(--color-primary-600);
        border-color: var(--color-primary-500);
        color: white;
    }

    .raf-active-dot {
        display: inline-block;
        width: 0.4rem;
        height: 0.4rem;
        border-radius: 50%;
        background: var(--color-primary-300);
        margin-left: 0.125rem;
    }

    .raf-trigger.active .raf-active-dot {
        background: white;
    }

    /* Popover panel */
    .raf-popover {
        position: absolute;
        top: calc(100% + 0.5rem);
        right: 0;
        z-index: 50;
        min-width: 18rem;
        max-width: 22rem;
        padding: 1rem;
        background: var(--color-surface-800);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.6);
        border-radius: 0.75rem;
        box-shadow: 0 8px 32px rgb(0 0 0 / 0.4);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .raf-section {
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
    }

    .raf-section-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-surface-400);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .raf-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
    }

    /* Re-style the az-type-chip inside the popover to be smaller */
    .raf-chip {
        padding: 0.3rem 0.7rem;
        font-size: 0.8125rem;
    }

    /* Segmented control */
    .raf-segmented {
        display: flex;
        border-radius: 0.5rem;
        overflow: hidden;
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
    }

    .raf-seg-btn {
        flex: 1;
        padding: 0.4rem 0.5rem;
        background: transparent;
        border: none;
        border-right: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-300);
        font-size: 0.8rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
        text-align: center;
        white-space: nowrap;
    }

    .raf-seg-btn:last-child {
        border-right: none;
    }

    .raf-seg-btn:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.4);
        color: var(--color-surface-100);
    }

    .raf-seg-btn.active {
        background: var(--color-primary-600);
        color: white;
    }

    /* Search input */
    .raf-search-input {
        width: 100%;
        padding: 0.4rem 0.75rem;
        border-radius: 0.5rem;
        background: rgb(var(--color-surface-700-rgb) / 0.6);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-100);
        font-size: 0.875rem;
        transition: border-color 0.15s ease;
        outline: none;
        box-sizing: border-box;
    }

    .raf-search-input::placeholder {
        color: var(--color-surface-500);
    }

    .raf-search-input:focus {
        border-color: rgb(var(--color-primary-500-rgb) / 0.6);
    }
</style>
