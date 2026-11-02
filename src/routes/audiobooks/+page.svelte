<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { pickVariant } from '$lib/utils/image-utils.js';
    /**
     * `/audiobooks` — the audiobook destination.
     *
     * Reuses `/browse`'s chrome with one substitution that drives everything
     * else: **`/browse` tabs on `media_type`; this tabs on `library_group`.**
     * Every book here is one media type, so the meaningful axes are the shelf
     * (Hörbücher vs Hörspiele — whatever the operator called their groups) and
     * the language configured on the library path.
     *
     * Filter state lives in the URL and is applied by the server load, so a
     * shelf/chip/letter change is a navigation: deep links, the back button and
     * a reload all restore the same view. Search and load-more are client-side;
     * snapshots preserve the query and appended browse pages on Back.
     *
     * A collapsed series is a tile, not a row: clicking it drills into
     * the series resource page, while its play control starts the representative book.
     */
    import * as m from '$lib/paraglide/messages.js';
    import { goto, invalidateAll, beforeNavigate } from '$app/navigation';
    import { onDestroy } from 'svelte';
    import { page } from '$app/stores';
    import { SvelteURLSearchParams } from 'svelte/reactivity';
    import AudiobookCardGrid from '$lib/components/audiobook/AudiobookCardGrid.svelte';
    import UniversalMediaCard from '$lib/components/ui/UniversalMediaCard.svelte';
    import AudiobookActivityRail from '$lib/components/audiobook/AudiobookActivityRail.svelte';
    import { Icon, MagnifyingGlass, XMark } from 'svelte-hero-icons';
    import { requestLibrary, LatestRequest } from './browse-request';
    import { audiobookCardItem, openAudiobook } from '$lib/utils/audiobook-catalog';
    import { resolve } from '$lib/paths';
    import { createRenderableMediaKeys } from '$lib/utils/media-id-helpers';
    import { resolveAudiobookEntryClick } from '$lib/utils/audiobook-entry-click';
    import { playAudiobook, audiobookStartFailureMessage } from '$lib/services/audiobook-playback';
    import { toasts } from '$lib/stores/toast.store';
    import type { AudiobookSortValue } from '$lib/schemas/api-audiobooks-responses';
    import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';
    import type { PageData, Snapshot } from './$types';

    let { data }: { data: PageData } = $props();

    // Pill styling, matching the station chips on /music. Deliberately plain
    // Tailwind: the Skeleton `chip`/`variant-*` utilities other markup in this
    // repo still names are not in this app's compiled CSS, so they render as
    // unstyled text.
    const PILL =
        'flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all';
    const PILL_SM =
        'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all';
    const PILL_ON =
        'border-primary-400 bg-primary-500/25 text-surface-50 shadow-lg shadow-primary-500/20';
    const PILL_OFF =
        'border-primary-500/30 bg-surface-800/80 text-surface-100 hover:border-primary-400/60 hover:bg-surface-700 hover:text-surface-50';

    /** A-Z plus '#', which gathers every title that does not start with a Latin letter. */
    const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

    const SORT_OPTIONS: Array<{ value: AudiobookSortValue; label: () => string }> = [
        { value: 'title_asc', label: () => m.audiobooks_sort_title_asc() },
        { value: 'title_desc', label: () => m.audiobooks_sort_title_desc() },
        { value: 'added_desc', label: () => m.audiobooks_sort_added() },
        { value: 'year_desc', label: () => m.audiobooks_sort_year_desc() },
        { value: 'year_asc', label: () => m.audiobooks_sort_year_asc() },
    ];

    // ── Client-appended pages ────────────────────────────────────────────────
    // The server renders page 0; scrolling appends the rest. The appended tail
    // is STAMPED with the filter it was fetched for and derived away when that
    // stops matching, rather than cleared by an effect: a filter change can
    // arrive without any handler firing (back button, deep link), and an effect
    // would blank the tail one frame after the new page had already rendered
    // with it.
    type AppendedPages = {
        key: string;
        items: AudiobookPreview[];
        nextOffset: number;
        hasMore: boolean;
    };
    let appended = $state<AppendedPages | null>(null);
    let loading = $state(false);
    let browseError = $state<string | null>(null);
    const browseRequest = new LatestRequest();
    const searchRequest = new LatestRequest();

    let filterKey = $derived(JSON.stringify(data.filter));
    let liveAppended = $derived(appended?.key === filterKey ? appended : null);
    let items = $derived(liveAppended ? [...data.items, ...liveAppended.items] : [...data.items]);
    let hasMore = $derived(liveAppended ? liveAppended.hasMore : data.hasMore);
    let nextOffset = $derived(liveAppended ? liveAppended.nextOffset : data.items.length);
    let activeSeries = $derived(data.filter.series);
    let activeAuthor = $derived(data.filter.author);
    let activeNarrator = $derived(data.filter.narrator);
    let seriesLabel = $derived(data.filterNames?.series ?? m.modal_audiobook_series());
    let authorLabel = $derived(data.filterNames?.author ?? m.modal_audiobook_author());
    let narratorLabel = $derived(data.filterNames?.narrator ?? m.modal_audiobook_narrator());
    /** Drill-ins compose with the shelf, language and other visible filters. */
    let activeDrillIn = $derived(activeSeries || activeAuthor || activeNarrator);
    let drillInTitle = $derived(
        activeSeries
            ? seriesLabel
            : activeAuthor
              ? m.audiobooks_by_author({ name: authorLabel })
              : activeNarrator
                ? m.audiobooks_read_by_narrator({ name: narratorLabel })
                : null,
    );
    let letterRailVisible = $derived(
        (data.filter.sort === 'title_asc' || data.filter.sort === 'title_desc') &&
            data.letterCounts.length > 0,
    );
    let countByLetter = $derived(new Map(data.letterCounts.map((c) => [c.letter, c.count])));
    // One language is not a choice — an install with no language split (or an
    // operator who never configured one) gets no chips rather than a dead row.
    let languagesVisible = $derived(data.languages.length > 1);
    let shelvesVisible = $derived(data.shelves.length > 1);
    let activeFilters = $derived(
        [
            {
                key: 'libraryGroupId',
                value: data.filter.group,
                // A bookmarked shelf that no longer exists must not surface its raw id.
                label:
                    data.shelves.find((shelf) => shelf.id === data.filter.group)?.name ??
                    m.viewer_audiobooks_unknown_shelf(),
            },
            { key: 'lang', value: data.filter.language, label: data.filter.language },
            {
                key: 'authorId',
                value: activeAuthor,
                label: activeAuthor ? m.audiobooks_by_author({ name: authorLabel }) : null,
            },
            {
                key: 'narratorId',
                value: activeNarrator,
                label: activeNarrator
                    ? m.audiobooks_read_by_narrator({ name: narratorLabel })
                    : null,
            },
            { key: 'seriesId', value: activeSeries, label: seriesLabel },
            { key: 'letter', value: data.filter.letter, label: data.filter.letter },
        ].filter((filter) => filter.value),
    );

    /**
     * Navigate to a new filter state.
     *
     * Every control routes through here so the URL stays the single source of
     * truth. Changing shelf or language drops the letter: a letter that had
     * results on the previous shelf usually has none on the next, and an empty
     * grid behind an invisible filter reads as a broken page.
     */
    function applyFilter(patch: Record<string, string | null>): void {
        cancelSearch();
        browseRequest.cancel();
        loading = false;
        browseError = null;
        const params = new SvelteURLSearchParams($page.url.search);
        for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === '') params.delete(key);
            else params.set(key, value);
        }
        // Query-only, relative: base-path safe without a resolve() wrapper, and
        // it keeps the destination's scroll position while the grid swaps.
        void goto(`?${params.toString()}`, { noScroll: true, keepFocus: true });
    }

    function selectShelf(libraryGroupId: string | null): void {
        applyFilter({ libraryGroupId: libraryGroupId, letter: null });
    }

    function selectLanguage(language: string | null): void {
        applyFilter({ lang: language, letter: null });
    }

    function selectLetter(letter: string): void {
        applyFilter({ letter: data.filter.letter === letter ? null : letter });
    }

    function selectSort(sort: string): void {
        applyFilter({ sort, letter: null });
    }

    function openSeries(seriesId: string): void {
        void goto(resolve(`/audiobooks/series/${encodeURIComponent(seriesId)}`));
    }

    function leaveSeries(): void {
        applyFilter({ seriesId: null, authorId: null, narratorId: null, letter: null, sort: null });
    }

    function resetFilters(): void {
        applyFilter({
            libraryGroupId: null,
            lang: null,
            seriesId: null,
            authorId: null,
            narratorId: null,
            letter: null,
            sort: null,
        });
    }

    /**
     * Start a book from a card's ▶.
     *
     * `UniversalMediaCard` renders the play button unconditionally, so without an
     * `onplay` handler every ▶ on this page was a silent no-op — the click landed
     * on a button that did nothing at all.
     *
     * Goes through `resolveMediaPlayTarget` rather than reading
     * `externalIds.internal` directly, so this surface shares the one decision every
     * other play surface uses. No position is threaded: the player omits
     * `positionMs` so AudiobookShelf answers with its own saved progress, which also
     * means this cannot reset a book the user advanced in the ABS app.
     */
    function handleCardPlay(item: AudiobookPreview): void {
        void playAudiobook(item.catalogId).then((started) => {
            if (!started) toasts.error(audiobookStartFailureMessage());
        });
    }

    function handleCardClick(item: AudiobookPreview): void {
        const click = resolveAudiobookEntryClick(item);
        if (click.action === 'series') {
            openSeries(click.seriesId);
            return;
        }
        openAudiobook(item);
    }

    async function loadMore(): Promise<void> {
        if (loading || !hasMore) return;
        const requestKey = filterKey;
        const offset = nextOffset;
        const previous = liveAppended?.items ?? [];
        const request = browseRequest.start();
        loading = true;
        browseError = null;
        try {
            const { data: result, error } = await requestLibrary(
                data.filter,
                offset,
                data.pageSize,
                request.signal,
            );
            if (!request.current() || requestKey !== filterKey) return;
            if (error || !result) {
                browseError = requestKey;
                return;
            }
            appended = {
                key: requestKey,
                items: [...previous, ...result.items],
                nextOffset: (result.page.offset ?? offset) + result.items.length,
                hasMore:
                    result.page.hasMore &&
                    (result.page.offset ?? offset) + result.items.length > offset,
            };
        } catch {
            if (request.current() && requestKey === filterKey) browseError = requestKey;
        } finally {
            if (request.current()) loading = false;
        }
    }

    // Infinite scroll, like /browse: the next page loads as the end of the grid
    // nears. Re-arms whenever the item count or error state changes, because an
    // IntersectionObserver only fires on a CHANGE — a short page that leaves the
    // sentinel on screen would otherwise never load the one after it. A failed
    // page stops auto-loading so a dead connection doesn't retry in a loop; the
    // Retry button takes over. Without IntersectionObserver the button stays.
    const autoLoadSupported = typeof IntersectionObserver !== 'undefined';
    function watchSentinel(node: HTMLElement): (() => void) | undefined {
        void items.length;
        if (!autoLoadSupported || !hasMore || browseError === filterKey) return undefined;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) void loadMore();
            },
            { rootMargin: '600px' },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }

    // Search leaves the underlying library mounted. Snapshot restores the
    // query and appended browse pages when returning with browser history.
    let searchQuery = $state('');
    let searchResults = $state<AudiobookPreview[]>([]);
    let searchTotal = $state(0);
    let searching = $state(false);
    let searchError = $state(false);
    let searchHasMore = $state(false);
    let searchOffset = $state(0);
    let searchInput = $state<HTMLInputElement | undefined>();
    let searchDebounce: ReturnType<typeof setTimeout> | undefined;
    let isSearchMode = $derived(searchQuery.trim().length > 0);
    let searchKeys = $derived(createRenderableMediaKeys(searchResults));

    function cancelSearch(): void {
        clearTimeout(searchDebounce);
        searchRequest.cancel();
        searching = false;
    }

    $effect(() => {
        const term = searchQuery.trim();
        const scope = filterKey;
        cancelSearch();
        searchResults = [];
        searchError = false;
        searchHasMore = false;
        if (term) {
            searching = true;
            searchDebounce = setTimeout(() => void runSearch(term, scope), 250);
        }
        return cancelSearch;
    });

    async function runSearch(term: string, scope: string, append = false): Promise<void> {
        const request = searchRequest.start();
        const offset = append ? searchOffset : 0;
        searching = true;
        searchError = false;
        try {
            const { data: result, error } = await requestLibrary(
                data.filter,
                offset,
                data.pageSize,
                request.signal,
                term,
            );
            if (!request.current() || term !== searchQuery.trim() || scope !== filterKey) return;
            if (error || !result) {
                searchError = true;
                return;
            }
            searchResults = append ? [...searchResults, ...result.items] : result.items;
            searchTotal = result.page.total ?? result.items.length;
            searchOffset = (result.page.offset ?? offset) + result.items.length;
            searchHasMore =
                result.page.hasMore &&
                (result.page.offset ?? offset) + result.items.length > offset;
        } catch {
            if (request.current() && term === searchQuery.trim() && scope === filterKey)
                searchError = true;
        } finally {
            if (request.current()) searching = false;
        }
    }

    function resetSearch(): void {
        cancelSearch();
        searchQuery = '';
        searchResults = [];
        searchTotal = 0;
        searchHasMore = false;
        searchError = false;
    }

    function clearSearch(): void {
        resetSearch();
        searchInput?.focus();
    }

    export const snapshot: Snapshot<{ query: string; appended: AppendedPages | null }> = {
        capture: () => ({ query: searchQuery, appended }),
        restore: (value) => {
            searchQuery = value.query;
            appended = value.appended;
        },
    };

    onDestroy(() => {
        cancelSearch();
        browseRequest.cancel();
    });

    beforeNavigate(() => {
        cancelSearch();
        browseRequest.cancel();
        loading = false;
    });

    function bookCountLabel(item: AudiobookPreview): string | null {
        const count = item.audiobook.series?.bookCount;
        return typeof count === 'number' ? m.audiobooks_book_count({ count }) : null;
    }
</script>

<svelte:head>
    <title>{m.audiobooks_title()}</title>
</svelte:head>

<div class="mx-auto w-full max-w-[1800px] px-4 pb-20 pt-6 sm:px-6 lg:px-8 lg:pt-20">
    <div class="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div class="flex flex-wrap items-center gap-3">
            {#if activeDrillIn}
                <button type="button" class="{PILL_SM} {PILL_OFF}" onclick={leaveSeries}>
                    ← {m.viewer_audiobooks_library()}
                </button>
                <h1 class="text-2xl font-semibold text-surface-100">{drillInTitle}</h1>
            {:else}
                <h1 class="text-2xl font-semibold text-surface-100">{m.audiobooks_title()}</h1>
            {/if}
            <span class="text-sm text-surface-400">
                {m.audiobooks_entry_count({ count: data.totalCount })}
            </span>
        </div>

        <div class="flex flex-1 flex-wrap items-center justify-end gap-3">
            <div class="relative w-full min-w-0 sm:w-auto sm:min-w-[14rem] sm:flex-1 sm:max-w-sm">
                <span
                    class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-surface-400">
                    <Icon src={MagnifyingGlass} class="h-4 w-4" />
                </span>
                <input
                    type="search"
                    maxlength="200"
                    bind:value={searchQuery}
                    bind:this={searchInput}
                    onkeydown={(event) => {
                        if (event.key === 'Escape') clearSearch();
                    }}
                    placeholder={m.audiobooks_search_placeholder()}
                    aria-label={m.audiobooks_search_placeholder()}
                    class="w-full rounded-lg border border-surface-600/50 bg-surface-800/80 py-2 pl-9 pr-8 text-sm text-surface-50 placeholder-surface-500 outline-none transition-colors focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/30" />
                {#if searchQuery}
                    <button
                        type="button"
                        class="absolute right-2 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-50"
                        aria-label={m.audiobooks_search_clear()}
                        onclick={clearSearch}>
                        <Icon src={XMark} class="h-4 w-4" />
                    </button>
                {/if}
            </div>

            <!-- Series default to reading order; explicit URL sorts stay visible. -->
            <label class="flex items-center gap-2 text-sm text-surface-300">
                <span>{m.audiobooks_sort_label()}</span>
                <select
                    class="w-44 rounded-lg border border-surface-600 bg-surface-800 px-3 py-1.5 text-sm text-surface-100 focus:border-primary-400 focus:outline-none"
                    value={data.filter.sort}
                    onchange={(event) => selectSort(event.currentTarget.value)}>
                    {#if activeSeries}
                        <option value="series_sequence"
                            >{m.viewer_audiobooks_reading_order()}</option>
                    {/if}
                    {#each SORT_OPTIONS as option (option.value)}
                        <option value={option.value}>{option.label()}</option>
                    {/each}
                </select>
            </label>
        </div>
    </div>

    <section class="mb-8 space-y-3" aria-label={m.audiobooks_shelves()}>
        {#if shelvesVisible}
            <div class="mb-4 flex flex-wrap gap-2" role="group" aria-label={m.audiobooks_shelves()}>
                <button
                    type="button"
                    aria-pressed={data.filter.group === null}
                    class="{PILL} {data.filter.group === null ? PILL_ON : PILL_OFF}"
                    onclick={() => selectShelf(null)}>
                    {m.audiobooks_all_shelves()}
                </button>
                {#each data.shelves as shelf (shelf.id)}
                    <button
                        type="button"
                        aria-pressed={data.filter.group === shelf.id}
                        class="{PILL} {data.filter.group === shelf.id ? PILL_ON : PILL_OFF}"
                        onclick={() => selectShelf(shelf.id)}>
                        {shelf.name}
                        <span class="text-surface-400">{shelf.bookCount}</span>
                    </button>
                {/each}
            </div>
        {/if}

        {#if languagesVisible}
            <div class="mb-6 flex flex-wrap gap-2" aria-label={m.audiobooks_languages()}>
                <button
                    type="button"
                    aria-pressed={data.filter.language === null}
                    class="{PILL_SM} {data.filter.language === null ? PILL_ON : PILL_OFF}"
                    onclick={() => selectLanguage(null)}>
                    {m.audiobooks_all_languages()}
                </button>
                {#each data.languages as facet (facet.language)}
                    <button
                        type="button"
                        aria-pressed={data.filter.language === facet.language}
                        class="{PILL_SM} uppercase {data.filter.language === facet.language
                            ? PILL_ON
                            : PILL_OFF}"
                        onclick={() => selectLanguage(facet.language)}>
                        {facet.language}
                        <span class="text-surface-400">{facet.bookCount}</span>
                    </button>
                {/each}
            </div>
        {/if}

        {#if activeFilters.length > 0}
            <div class="flex flex-wrap items-center gap-2">
                {#each activeFilters as filter (filter.key)}
                    <button
                        type="button"
                        class="{PILL_SM} {PILL_ON} max-w-full"
                        aria-label={m.viewer_audiobooks_remove_filter({ name: filter.label ?? '' })}
                        onclick={() =>
                            applyFilter({
                                [filter.key]: null,
                                ...(filter.key === 'seriesId' ? { sort: null } : {}),
                            })}>
                        <span class="truncate">{filter.label}</span>
                        <Icon src={XMark} class="h-3.5 w-3.5 shrink-0" />
                    </button>
                {/each}
                <button
                    type="button"
                    class="min-h-10 px-2 text-sm text-primary-300 hover:underline"
                    onclick={resetFilters}>
                    {m.search_clear_filters()}
                </button>
            </div>
        {/if}
        {#if activeSeries && data.filter.sort === 'series_sequence'}
            <p class="text-sm text-surface-400">{m.viewer_audiobooks_reading_order()}</p>
        {/if}
    </section>

    <!-- Search results. The browse chrome BELOW stays mounted and is only
         hidden, so dismissing search costs one state flip and no refetch. -->
    {#if isSearchMode}
        <section class="mb-8" aria-label={m.audiobooks_search_placeholder()} aria-busy={searching}>
            {#if searchError}
                <div
                    role="alert"
                    class="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-surface-800 p-4">
                    <p>{m.viewer_audiobooks_load_error()}</p>
                    <button
                        type="button"
                        class="{PILL_SM} {PILL_OFF}"
                        onclick={() =>
                            void runSearch(searchQuery.trim(), filterKey, searchResults.length > 0)}
                        >{m.common_retry()}</button>
                </div>
            {/if}
            {#if searching && searchResults.length === 0}
                <p class="py-10 text-center text-sm text-surface-400">{m.audiobooks_loading()}</p>
            {:else if searchResults.length === 0 && !searchError}
                <p class="py-10 text-center text-surface-400">{m.audiobooks_empty()}</p>
            {:else if searchResults.length > 0}
                <p class="mb-3 text-sm text-surface-400" role="status">
                    {m.audiobooks_entry_count({ count: searchTotal })}
                </p>
                <div
                    class="audiobook-search-result-cards grid grid-cols-2 gap-4 min-[420px]:grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                    {#each searchResults as result, index (searchKeys[index])}
                        {@const seriesLabel = bookCountLabel(result)}
                        <div class="relative">
                            <UniversalMediaCard
                                item={audiobookCardItem(result)}
                                variant="poster"
                                onclick={() => handleCardClick(result)}
                                onplay={() => handleCardPlay(result)} />
                            {#if seriesLabel}
                                <span
                                    class="pointer-events-none absolute left-2 top-2 rounded bg-surface-900/80 px-1.5 py-0.5 text-xs font-medium text-surface-100">
                                    {seriesLabel}
                                </span>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}
            {#if searchHasMore && !searchError}
                <div class="mt-6 flex justify-center">
                    <button
                        type="button"
                        disabled={searching}
                        class="{PILL} {PILL_OFF}"
                        onclick={() => void runSearch(searchQuery.trim(), filterKey, true)}>
                        {searching ? m.audiobooks_loading() : m.section_load_more()}
                    </button>
                </div>
            {/if}
        </section>
    {/if}

    <div class:hidden={isSearchMode} aria-hidden={isSearchMode}>
        {#if !activeDrillIn && data.resume.length > 0}
            <section class="mb-8" aria-labelledby="audiobooks-resume-heading">
                <h2
                    id="audiobooks-resume-heading"
                    class="mb-3 text-lg font-semibold text-surface-200">
                    {m.audiobooks_continue()}
                </h2>
                <p class="mb-4 text-sm text-surface-400">{m.viewer_audiobooks_resume_scope()}</p>
                <div class="flex gap-4 overflow-x-auto pb-2">
                    {#each data.resume as row (row.id)}
                        <div class="w-36 shrink-0 sm:w-40">
                            <UniversalMediaCard
                                item={audiobookCardItem(row)}
                                variant="poster"
                                onclick={() => handleCardClick(row)}
                                onplay={() => handleCardPlay(row)} />
                        </div>
                    {/each}
                </div>
            </section>
        {/if}

        <!-- After Continue, before the grid: what the circle is listening to is
             a reason to start something, so it belongs above the A-Z wall but
             below the book the viewer is already in the middle of. Hidden while
             drilled into a series, where the page is about one work. -->
        {#if !activeDrillIn && data.audiobookActivity}
            <div class="mb-8">
                <AudiobookActivityRail section={data.audiobookActivity} />
            </div>
        {/if}

        <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="text-xl font-semibold text-surface-100">
                {activeSeries ? seriesLabel : m.viewer_audiobooks_library()}
            </h2>
            <span class="text-sm text-surface-400"
                >{m.audiobooks_entry_count({ count: data.totalCount })}</span>
        </div>

        {#if letterRailVisible}
            <div class="mb-6 flex flex-wrap gap-1" aria-label={m.audiobooks_letter_rail()}>
                {#each LETTERS as letter (letter)}
                    {@const count = countByLetter.get(letter) ?? 0}
                    <button
                        type="button"
                        disabled={count === 0}
                        aria-pressed={data.filter.letter === letter}
                        class="h-8 w-8 rounded text-sm transition-colors {data.filter.letter ===
                        letter
                            ? 'bg-primary-500 text-white'
                            : count === 0
                              ? 'cursor-not-allowed text-surface-600'
                              : 'text-surface-300 hover:bg-surface-700'}"
                        onclick={() => selectLetter(letter)}>
                        {letter}
                    </button>
                {/each}
            </div>
        {/if}

        {#if data.loadError}
            <div
                role="alert"
                class="flex flex-wrap items-center gap-3 rounded-lg bg-surface-800 p-4">
                <p>{m.viewer_audiobooks_load_error()}</p>
                <button
                    type="button"
                    class="{PILL_SM} {PILL_OFF}"
                    onclick={() => void invalidateAll()}>{m.common_retry()}</button>
            </div>
        {:else if items.length === 0}
            <p class="py-16 text-center text-surface-400">{m.audiobooks_empty()}</p>
        {:else}
            <AudiobookCardGrid books={items} />

            {#if browseError === filterKey}
                <p role="alert" class="mt-6 text-center text-surface-300">
                    {m.viewer_audiobooks_load_error()}
                </p>
            {/if}
            {#if hasMore}
                <div class="h-px" aria-hidden="true" {@attach watchSentinel}></div>
            {/if}
            {#if hasMore && autoLoadSupported && browseError !== filterKey}
                {#if loading}
                    <p class="mt-6 text-center text-sm text-surface-400" role="status">
                        {m.audiobooks_loading()}
                    </p>
                {/if}
            {:else if hasMore}
                <div class="mt-6 flex justify-center">
                    <button
                        type="button"
                        disabled={loading}
                        class="{PILL} {PILL_OFF}"
                        onclick={() => void loadMore()}>
                        {loading
                            ? m.audiobooks_loading()
                            : browseError === filterKey
                              ? m.common_retry()
                              : m.section_load_more()}
                    </button>
                </div>
            {/if}
        {/if}
    </div>
</div>

<style>
    /* A search result needs its title more than the density of a browse shelf.
       Reserve two lines so long audiobook names remain identifiable. */
    .audiobook-search-result-cards :global([data-media-card-title]) {
        display: -webkit-box;
        min-height: 2.5rem;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        white-space: normal;
    }
</style>
