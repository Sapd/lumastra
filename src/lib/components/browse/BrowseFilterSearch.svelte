<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    BrowseFilterSearch.svelte

    A search icon that expands into a typeahead combobox over the browse
    tag and genre facets. Purely a picker: it fetches and renders results
    and reports the chosen tag/genre via `onselect` — it never navigates.

    @example
    <BrowseFilterSearch mediaType="all" onselect={(choice) => { ... }} />
-->
<script lang="ts">
    import { z } from 'zod';
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, MagnifyingGlass } from 'svelte-hero-icons';
    import { onDestroy, untrack } from 'svelte';
    import { apiGet } from '$lib/api/client';
    import {
        BrowseGenresResponseSchema,
        KeywordCountSchema,
    } from '$lib/schemas/api-browse-responses';
    import { keywordDisplayName } from '$lib/shared/keyword-vocabulary';

    interface Props {
        mediaType: 'all' | 'movies' | 'series';
        onselect: (choice: { kind: 'tag' | 'genre'; value: string; label: string }) => void;
    }

    let { mediaType, onselect }: Props = $props();

    interface FilterOption {
        kind: 'tag' | 'genre';
        /** Raw value — sent back verbatim via onselect, never relabelled. */
        value: string;
        /** Display label — translated for tags, as-is for genres. */
        label: string;
    }

    const tagsResponseSchema = z.object({ tags: z.array(KeywordCountSchema) });

    const DEBOUNCE_MS = 250;
    const MIN_QUERY_LENGTH = 2;

    // Stable per-instance id prefix for the combobox/listbox/option DOM ids.
    const uid = $props.id();
    const inputId = `${uid}-input`;
    const listboxId = `${uid}-listbox`;

    let expanded = $state(false);
    let query = $state('');
    let searching = $state(false);
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let results = $state<FilterOption[]>([]);
    let highlightedIndex = $state(-1);
    let errorMessage = $state<string | null>(null);
    let inputEl: HTMLInputElement | undefined = $state(undefined);

    /**
     * Genre list for this expansion, fetched ONCE.
     *
     * /api/browse/genres takes no `q` — it returns the whole scope-wide genre
     * facet, which is then prefix-filtered in memory. Fetching it inside the
     * per-keystroke `Promise.all` meant one full facet-aggregation round-trip
     * per debounce-settled keystroke for a byte-identical payload.
     *
     * `null` = not loaded for `genreCacheKey` yet. Cleared on collapse (so a
     * later expansion sees a fresh catalog) and whenever `mediaType` changes
     * while expanded — clicking a tab does not collapse this widget, so without
     * that key the 'all' genres would keep answering for the 'movies' tab.
     */
    let genreCache = $state<{ name: string }[] | null>(null);
    let genreCacheKey: string | null = null;
    /**
     * In-flight genre fetch, shared so two fast keystrokes kick off only one
     * request. Cleared when it settles: a SUCCESS is remembered in `genreCache`,
     * a FAILURE deliberately is not, so the next keystroke retries rather than
     * poisoning the whole expansion.
     */
    let genrePromise: Promise<boolean> | null = null;
    /** Guards a genre response that a `mediaType` change already superseded. */
    let genreSeq = 0;

    // Monotonically increasing request token — discards a stale response that
    // resolves after a newer one already landed (see +page.svelte performSearch).
    let requestSeq = 0;

    function optionId(index: number): string {
        return `${uid}-opt-${index}`;
    }

    let activeDescendant = $derived(
        highlightedIndex >= 0 && highlightedIndex < results.length
            ? optionId(highlightedIndex)
            : undefined,
    );

    /**
     * Whether the listbox popup is actually on screen. `.bfs-listbox:empty` is
     * `display: none`, so with no results there is no popup — announcing
     * `aria-expanded="true"` regardless would tell a screen reader about a
     * popup that isn't rendered.
     */
    let listboxVisible = $derived(results.length > 0);

    /**
     * Load the genre facet once per expansion. Subsequent keystrokes reuse
     * `genreCache` (or the in-flight promise) and never hit the network.
     *
     * @returns whether genres are available for the current `mediaType`
     */
    function ensureGenres(): Promise<boolean> {
        if (genreCacheKey !== mediaType) {
            genreCacheKey = mediaType;
            genreCache = null;
            genrePromise = null;
            genreSeq += 1;
        }
        if (genreCache !== null) return Promise.resolve(true);
        if (genrePromise) return genrePromise;

        const myGenreReq = genreSeq;
        genrePromise = apiGet('/api/browse/genres', BrowseGenresResponseSchema, {
            params: { type: mediaType },
        })
            .then((result) => {
                // A mediaType change already invalidated this response.
                if (myGenreReq !== genreSeq) return false;
                if (result.error || !result.data) return false;
                genreCache = result.data.genres ?? [];
                return true;
            })
            .finally(() => {
                if (myGenreReq === genreSeq) genrePromise = null;
            });
        return genrePromise;
    }

    async function performSearch(rawQuery: string) {
        // Bail if the widget was collapsed while this debounced call was in flight.
        if (!expanded) return;

        const trimmed = rawQuery.trim();
        if (trimmed.length < MIN_QUERY_LENGTH) {
            searching = false;
            results = [];
            errorMessage = null;
            return;
        }

        const myReq = ++requestSeq;
        errorMessage = null;

        // Only the tags request is per-keystroke; genres are fetched once and
        // filtered in memory. Both still sit inside the request-token guard
        // below, so a first-keystroke genre fetch resolving late cannot revive
        // a superseded search.
        const [tagsResult, genresOk] = await Promise.all([
            apiGet('/api/browse/tags', tagsResponseSchema, {
                params: { q: trimmed, limit: 20, type: mediaType },
            }),
            ensureGenres(),
        ]);

        // Discard if a newer search superseded this one, or the widget collapsed.
        if (myReq !== requestSeq || !expanded) return;
        searching = false;

        if (tagsResult.error || !genresOk) {
            errorMessage = m.browse_filter_search_error();
        }

        const tagOptions: FilterOption[] = (tagsResult.data?.tags ?? []).map((t) => ({
            kind: 'tag' as const,
            value: t.keyword,
            // Real translated label from the curated vocabulary; the raw
            // projection value is only ever a last-resort fallback.
            label: keywordDisplayName(t.keyword),
        }));

        const lowerQuery = trimmed.toLowerCase();
        const genreOptions: FilterOption[] = (genreCache ?? [])
            .filter((g) => g.name.toLowerCase().includes(lowerQuery))
            .map((g) => ({ kind: 'genre' as const, value: g.name, label: g.name }));

        results = [...tagOptions, ...genreOptions];
        highlightedIndex = -1;
    }

    function debouncedSearch(value: string): void {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            void performSearch(value);
        }, DEBOUNCE_MS);
    }
    onDestroy(() => {
        clearTimeout(searchTimer);
        requestSeq++;
        genreSeq++;
    });

    function expand() {
        expanded = true;
    }

    function collapse() {
        clearTimeout(searchTimer);
        requestSeq++;
        searching = false;
        expanded = false;
        query = '';
        results = [];
        highlightedIndex = -1;
        errorMessage = null;
        // Drop the genre cache so the next expansion re-reads it — "once per
        // expand", not "once per page".
        genreCache = null;
        genreCacheKey = null;
        genrePromise = null;
        genreSeq += 1;
    }

    function handleInput(e: Event) {
        const value = (e.currentTarget as HTMLInputElement).value;
        query = value;
        requestSeq++;
        results = [];
        errorMessage = null;
        searching = value.trim().length >= MIN_QUERY_LENGTH;
        highlightedIndex = -1;
        debouncedSearch(value);
    }

    function selectOption(option: FilterOption) {
        onselect({ kind: option.kind, value: option.value, label: option.label });
        collapse();
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            collapse();
            return;
        }

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (results.length === 0) return;
            highlightedIndex = highlightedIndex < results.length - 1 ? highlightedIndex + 1 : 0;
            return;
        }

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (results.length === 0) return;
            highlightedIndex = highlightedIndex > 0 ? highlightedIndex - 1 : results.length - 1;
            return;
        }

        if (e.key === 'Enter') {
            if (highlightedIndex < 0 || highlightedIndex >= results.length) return;
            e.preventDefault();
            selectOption(results[highlightedIndex]);
        }
    }

    // A tab switch changes the search scope even if the text is unchanged.
    // Invalidate immediately, including replies still inside the debounce gap.
    let previousMediaType = untrack(() => mediaType);
    $effect(() => {
        const nextType = mediaType;
        if (nextType === previousMediaType) return;
        previousMediaType = nextType;
        untrack(() => {
            clearTimeout(searchTimer);
            requestSeq++;
            genreSeq++;
            genreCache = null;
            genreCacheKey = null;
            genrePromise = null;
            results = [];
            highlightedIndex = -1;
            errorMessage = null;
            searching = expanded && query.trim().length >= MIN_QUERY_LENGTH;
            if (searching) debouncedSearch(query);
        });
    });

    // Focus the input as soon as it appears in the DOM after expanding.
    $effect(() => {
        if (expanded && inputEl) {
            inputEl.focus();
        }
    });
</script>

<div class="bfs-root">
    {#if !expanded}
        <button
            type="button"
            class="bfs-trigger"
            aria-expanded={false}
            aria-label={m.browse_filter_search_aria_label()}
            onclick={expand}>
            <Icon src={MagnifyingGlass} class="w-4 h-4" />
            <span>{m.catalog_picker()}</span>
        </button>
    {:else}
        <div class="bfs-expanded">
            <input
                bind:this={inputEl}
                id={inputId}
                type="search"
                role="combobox"
                class="bfs-input"
                aria-expanded={listboxVisible}
                aria-controls={listboxId}
                aria-activedescendant={activeDescendant}
                aria-autocomplete="list"
                aria-label={m.browse_filter_search_aria_label()}
                autocomplete="off"
                value={query}
                oninput={handleInput}
                onkeydown={handleKeydown}
                placeholder={m.browse_filter_search_placeholder()} />

            {#if errorMessage}
                <p role="alert" class="bfs-error">{errorMessage}</p>
            {/if}
            {#if searching}
                <p role="status" class="bfs-feedback">{m.catalog_picker_loading()}</p>
            {:else if query.trim().length >= MIN_QUERY_LENGTH && !results.length && !errorMessage}
                <p role="status" class="bfs-feedback">{m.catalog_picker_empty()}</p>
            {/if}

            <ul id={listboxId} role="listbox" class="bfs-listbox">
                {#each results as option, index (option.kind + ':' + option.value)}
                    <li
                        id={optionId(index)}
                        role="option"
                        aria-selected={index === highlightedIndex}
                        class="bfs-option"
                        class:highlighted={index === highlightedIndex}>
                        <button
                            type="button"
                            class="bfs-option-btn"
                            onclick={() => selectOption(option)}>
                            <span class="bfs-badge bfs-badge-{option.kind}">
                                {option.kind === 'tag'
                                    ? m.browse_filter_search_badge_tag()
                                    : m.browse_filter_search_badge_genre()}
                            </span>
                            <span class="bfs-option-label">{option.label}</span>
                        </button>
                    </li>
                {/each}
            </ul>
        </div>
    {/if}
</div>

<style lang="postcss">
    .bfs-root {
        position: relative;
        display: inline-flex;
    }

    .bfs-trigger {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        min-height: 44px;
        border-radius: 0.4rem;
        white-space: nowrap;
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-300);
        cursor: pointer;
        transition: all 0.2s ease;
    }

    .bfs-trigger:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-100);
    }

    .bfs-expanded {
        position: relative;
        display: flex;
        flex-direction: column;
        min-width: 16rem;
    }

    .bfs-input {
        width: 100%;
        padding: 0.4rem 0.75rem;
        border-radius: 0.5rem;
        background: rgb(var(--color-surface-700-rgb) / 0.6);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-100);
        font-size: 0.875rem;
        outline: none;
        box-sizing: border-box;
    }

    .bfs-input:focus {
        border-color: rgb(var(--color-primary-500-rgb) / 0.6);
    }

    .bfs-error {
        margin: 0.375rem 0 0;
        font-size: 0.8125rem;
        color: var(--color-error-400, #f87171);
    }
    .bfs-feedback {
        margin: 0.5rem 0;
        font-size: 0.8rem;
        color: var(--color-surface-400);
    }

    .bfs-listbox {
        position: absolute;
        top: calc(100% + 0.375rem);
        left: 0;
        right: 0;
        z-index: 50;
        max-height: 18rem;
        overflow-y: auto;
        margin: 0;
        padding: 0.25rem;
        list-style: none;
        background: var(--color-surface-800);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.6);
        border-radius: 0.75rem;
        box-shadow: 0 8px 32px rgb(0 0 0 / 0.4);
    }

    .bfs-listbox:empty {
        display: none;
    }

    .bfs-option-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.4rem 0.6rem;
        border: none;
        background: transparent;
        border-radius: 0.5rem;
        color: var(--color-surface-100);
        font-size: 0.875rem;
        text-align: left;
        cursor: pointer;
    }

    .bfs-option.highlighted .bfs-option-btn,
    .bfs-option-btn:hover {
        background: rgb(var(--color-surface-600-rgb) / 0.5);
    }

    .bfs-badge {
        flex-shrink: 0;
        padding: 0.125rem 0.4rem;
        border-radius: 0.25rem;
        font-size: 0.6875rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .bfs-badge-tag {
        background: rgb(var(--color-secondary-500-rgb, 168 85 247) / 0.2);
        color: var(--color-secondary-300, #d8b4fe);
    }

    .bfs-badge-genre {
        background: rgb(var(--color-primary-500-rgb) / 0.2);
        color: var(--color-primary-300);
    }

    .bfs-option-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
</style>
