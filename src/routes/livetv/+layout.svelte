<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import '$lib/components/app-shell';
    import { onMount, setContext } from 'svelte';
    import { invalidate } from '$app/navigation';
    import { getLiveTvAvailability } from '$lib/api/livetv-availability.js';
    import { LIVE_TV_AVAILABILITY_CONTEXT } from '$lib/shared/livetv-availability-context.js';
    import AvailabilityBanner from '$lib/components/livetv/AvailabilityBanner.svelte';
    import { page } from '$app/state';
    import { replaceState, goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { filterChannels } from '$lib/shared/livetv-transforms.js';
    import { searchPrograms, groupProgramAirings } from '$lib/api/livetv-playback.js';
    import type { GroupedProgramSearchResult, LiveTvStation } from '$lib/schemas/livetv.js';
    import ChannelSearchBar from '$lib/components/livetv/ChannelSearchBar.svelte';
    import LiveTvViewToggle from '$lib/components/livetv/LiveTvViewToggle.svelte';
    import ProgramSearchResults from '$lib/components/livetv/ProgramSearchResults.svelte';
    import SearchChannelResults from '$lib/components/livetv/SearchChannelResults.svelte';
    import GenreBar from '$lib/components/livetv/GenreBar.svelte';
    import { GENRE_PARAM, GENRE_STORAGE_KEY, buildGenreChips } from '$lib/shared/livetv-genres.js';
    import type { Snippet } from 'svelte';
    import type { LayoutServerData } from './$types';

    // This layout consumes only its own loader payload. Parent shell settings
    // are passed through by SvelteKit but are not a dependency of this view.
    let { data, children }: { data: LayoutServerData; children: Snippet } = $props();

    let now = $state(Date.now());
    let polledAvailability = $state<typeof data.availability>();
    let snapshot = $derived(polledAvailability ?? data.availability);
    let availability = $derived(
        snapshot && now - Date.parse(snapshot.observedAt) <= 90_000 ? snapshot : undefined,
    );
    setContext(LIVE_TV_AVAILABILITY_CONTEXT, () => availability);
    let availabilityReadError = $state(false);
    let refreshPending = false;
    async function refreshAvailability(): Promise<void> {
        if (refreshPending || document.hidden || data.liveTvDisabled) return;
        refreshPending = true;
        try {
            const result = await getLiveTvAvailability();
            availabilityReadError = Boolean(result.error);
            if (result.data) polledAvailability = result.data;
        } finally {
            refreshPending = false;
        }
    }
    async function retryLoading(): Promise<void> {
        await invalidate('livetv:channels');
        await refreshAvailability();
    }
    onMount(() => {
        const timer = setInterval(() => void refreshAvailability(), 30_000);
        const visible = (): void => {
            if (!document.hidden) void refreshAvailability();
        };
        document.addEventListener('visibilitychange', visible);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', visible);
        };
    });

    let searchQuery = $state(page.url.searchParams.get('q') ?? '');
    let programResults = $state<GroupedProgramSearchResult[]>([]);
    let programSearchLoading = $state(false);
    let programSearchError = $state(false);
    let searchRun = 0;

    $effect(() => {
        const id = setInterval(() => {
            now = Date.now();
        }, 60_000);
        return () => clearInterval(id);
    });

    // Simple mode (senior-friendly screen) and its setup page bring their own,
    // calmer header; search, the view toggle and genre chips stay away.
    let simpleChrome = $derived(
        Boolean(page.data?.simpleMode?.enabled) || page.route?.id === '/livetv/simple-setup',
    );
    let isSearchMode = $derived(!simpleChrome && searchQuery.trim().length > 0);
    let filteredChannels = $derived(isSearchMode ? filterChannels(data.channels, searchQuery) : []);

    function handleSearchQuery(query: string): void {
        searchQuery = query;

        const url = new URL(page.url);
        if (query) {
            url.searchParams.set('q', query);
        } else {
            url.searchParams.delete('q');
        }
        replaceState(url.pathname + url.search, {});
    }

    // The bound value invalidates old requests immediately, before debounce.
    // Also fetches a query restored from the URL on the first mount.
    $effect(() => {
        const query = data.liveTvDisabled ? '' : searchQuery.trim();
        searchRun++;
        programResults = [];
        programSearchError = false;
        programSearchLoading = query.length >= 2;
        const timer =
            query.length >= 2 ? setTimeout(() => void runProgramSearch(query), 300) : undefined;
        return () => {
            clearTimeout(timer);
            searchRun++;
        };
    });

    async function runProgramSearch(query: string): Promise<void> {
        const run = ++searchRun;
        programSearchLoading = true;
        programSearchError = false;
        try {
            const result = await searchPrograms(query, 50);
            if (run !== searchRun || query !== searchQuery.trim()) return;
            programSearchError = Boolean(result.error || !result.data);
            programResults = groupProgramAirings(result.data?.items ?? []);
        } catch {
            if (run === searchRun) programSearchError = true;
        } finally {
            if (run === searchRun) programSearchLoading = false;
        }
    }

    function handleChannelClick(channel: LiveTvStation): void {
        void goto(resolve(`/watch/${channel.id}`));
    }

    // Browse by category: the grid and guide pages read ?genre= themselves.
    let genreChips = $derived(
        data.liveTvDisabled ? [] : buildGenreChips(data.channels, data.categories),
    );
    let selectedGenre = $derived.by(() => {
        const slug = page.url.searchParams.get(GENRE_PARAM);
        return slug && genreChips.some((c) => c.slug === slug) ? slug : null;
    });
    let selectedChip = $derived(genreChips.find((c) => c.slug === selectedGenre));

    function selectGenre(slug: string | null): void {
        const url = new URL(page.url);
        if (slug) url.searchParams.set(GENRE_PARAM, slug);
        else url.searchParams.delete(GENRE_PARAM);
        try {
            localStorage.setItem(GENRE_STORAGE_KEY, slug ?? '');
        } catch {
            // Storage blocked: the URL still carries the choice.
        }
        // A history entry per choice, so Back returns to the previous genre.
        void goto(url.pathname + url.search, { keepFocus: true, noScroll: true });
    }

    onMount(() => {
        // A link that names a genre or a search wins over the remembered genre.
        if (page.url.searchParams.has(GENRE_PARAM) || page.url.searchParams.has('q')) return;
        let stored: string | null = null;
        try {
            stored = localStorage.getItem(GENRE_STORAGE_KEY);
        } catch {
            stored = null;
        }
        if (stored && genreChips.some((c) => c.slug === stored)) {
            const url = new URL(page.url);
            url.searchParams.set(GENRE_PARAM, stored);
            void goto(url.pathname + url.search, {
                replaceState: true,
                keepFocus: true,
                noScroll: true,
            });
        }
    });
</script>

{#if data.liveTvDisabled}
    <div class="flex flex-col items-center justify-center py-20 text-center">
        <span class="mb-4 text-6xl">&#128225;</span>
        <h2 class="mb-2 text-xl font-semibold text-white">{m.viewer_livetv_disabled_title()}</h2>
        <p class="text-surface-400">{m.viewer_livetv_disabled_body()}</p>
    </div>
{:else if simpleChrome}
    {@render children()}
{:else}
    <!-- Search + view toggle header (always visible) -->
    <div class="mx-auto max-w-7xl px-4 pt-4 lg:pt-20 pb-2">
        <!-- Mobile: title row + search/toggle row stacked; desktop: single row -->
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <h1 class="text-xl font-semibold text-surface-100 sm:shrink-0">
                {m.media_live_tv()}
            </h1>
            <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <div class="min-w-0 basis-full sm:basis-auto sm:flex-1">
                    <ChannelSearchBar bind:value={searchQuery} onquery={handleSearchQuery} />
                </div>
                {#if !isSearchMode}
                    <LiveTvViewToggle />
                    <a
                        href={resolve('/livetv/simple-setup')}
                        class="inline-flex min-h-10 items-center rounded-lg border border-surface-600 px-3 text-sm text-surface-200 hover:bg-surface-800"
                        title={m.livetv_simple_setup_entry_title()}
                        >{m.livetv_simple_setup_entry()}</a>
                {/if}
            </div>
        </div>
    </div>

    {#if !isSearchMode && genreChips.length > 1}
        <div class="mx-auto max-w-7xl px-4 pb-2">
            <GenreBar chips={genreChips} selected={selectedGenre} onselect={selectGenre} />
            <p class="sr-only" role="status">
                {selectedChip
                    ? m.livetv_genre_status({ genre: selectedChip.name, count: selectedChip.count })
                    : ''}
            </p>
        </div>
    {/if}

    <div class="mx-auto max-w-7xl px-4">
        <AvailabilityBanner
            {availability}
            readError={data.loadError || availabilityReadError}
            onretry={() => void retryLoading()} />
    </div>
    {#if isSearchMode}
        <!-- Search results: matching channels + EPG programs -->
        <div class="mx-auto max-w-7xl space-y-6 p-4">
            {#if filteredChannels.length > 0}
                <section>
                    <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-400">
                        {m.livetv_search_channels({
                            count: filteredChannels.length,
                        })}
                    </h2>
                    <SearchChannelResults
                        channels={filteredChannels}
                        {now}
                        onclick={handleChannelClick} />
                </section>
            {:else}
                <p role="status" class="text-sm text-surface-400">
                    {m.livetv_no_search_results({ query: searchQuery })}
                </p>
            {/if}

            <section aria-busy={programSearchLoading}>
                <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-400">
                    {m.livetv_search_programs()}
                </h2>
                {#if searchQuery.trim().length < 2}
                    <p class="text-sm text-surface-400">{m.viewer_livetv_search_minimum()}</p>
                {:else if programSearchError}
                    <div role="alert" class="flex flex-wrap items-center gap-3">
                        <p class="text-sm text-surface-300">{m.viewer_livetv_search_error()}</p>
                        <button
                            type="button"
                            class="min-h-10 rounded-lg bg-surface-700 px-4 text-sm"
                            onclick={() => void runProgramSearch(searchQuery.trim())}
                            >{m.common_retry()}</button>
                    </div>
                {:else if !programSearchLoading && programResults.length === 0}
                    <p class="text-sm text-surface-500">
                        {m.livetv_no_program_results({ query: searchQuery })}
                    </p>
                {:else}
                    <ProgramSearchResults
                        results={programResults}
                        query={searchQuery}
                        loading={programSearchLoading} />
                {/if}
            </section>
        </div>
    {:else}
        {@render children()}
    {/if}
{/if}
