<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { browser } from '$app/environment';
    import { untrack } from 'svelte';
    import { SvelteURLSearchParams } from 'svelte/reactivity';
    import { Icon, MagnifyingGlass, XMark } from 'svelte-hero-icons';
    import type { MusicAlbumSummary } from '$lib/types/music.js';
    import { getAlbums } from '$lib/api/music';
    import * as contentApi from '$lib/api/content';
    import AlbumCard from '$lib/components/music/AlbumCard.svelte';
    import MusicLibraryTabs from '$lib/components/music/MusicLibraryTabs.svelte';
    import MusicNavigation from '$lib/components/music/MusicNavigation.svelte';
    import { resolve } from '$lib/paths';
    import type { Snapshot } from './$types';

    let { data } = $props();

    // svelte-ignore state_referenced_locally
    let albums = $state<MusicAlbumSummary[]>([...data.albums]);
    // svelte-ignore state_referenced_locally
    let hasMore = $state(data.hasMore);
    let loading = $state(false);
    let loadError = $state(false);
    let sentinel = $state<HTMLElement | null>(null);
    let loadVersion = 0;

    // Reset when sort/genre/artist changes (primitive comparison — reference
    // equality on `data.albums` is unreliable under SvelteKit's reactive props
    // proxy and caused an effect_update_depth_exceeded loop).
    // svelte-ignore state_referenced_locally
    let lastSort: string | null | undefined = data.sort;
    // svelte-ignore state_referenced_locally
    let lastGenre: string | null | undefined = data.genre;
    // svelte-ignore state_referenced_locally
    let lastArtist: string | null | undefined = data.artist;
    $effect(() => {
        const s = data.sort;
        const g = data.genre;
        const a = data.artist;
        if (s !== lastSort || g !== lastGenre || a !== lastArtist) {
            lastSort = s;
            lastGenre = g;
            lastArtist = a;
            untrack(() => {
                loadVersion++;
                loading = false;
                albums = [...(data.albums ?? [])];
                hasMore = data.hasMore ?? false;
                loadError = false;
            });
        }
    });

    const PAGE_SIZE = 48;

    const sortOptions = $derived.by((): { value: string; label: string }[] => [
        { value: '', label: m.section_recently_added() },
        { value: 'alpha', label: 'A – Z' },
        { value: 'year', label: m.viewer_music_by_year() },
    ]);

    function onSortChange(e: Event): void {
        const select = e.currentTarget as HTMLSelectElement;
        const params = new SvelteURLSearchParams(window.location.search);
        if (select.value) {
            params.set('sort', select.value);
        } else {
            params.delete('sort');
        }
        goto(`?${params.toString()}`);
    }

    async function loadMore(): Promise<void> {
        if (loading || !hasMore || loadError) return;
        loading = true;
        const version = ++loadVersion;

        try {
            const { data: apiData, error } = await getAlbums({
                offset: albums.length,
                limit: PAGE_SIZE,
                sort: data.sort ?? undefined,
                genre: data.genre ?? undefined,
                artist: data.artist ?? undefined,
            });

            if (version !== loadVersion) return;
            if (error || !apiData) {
                loadError = true;
                return;
            }

            const newAlbums = (apiData.items as unknown as MusicAlbumSummary[]) ?? [];
            // Authoritative hasMore from the {items,page} contract; fall back to
            // a short-page heuristic if the page block is somehow absent.
            hasMore = apiData.page?.hasMore ?? newAlbums.length >= PAGE_SIZE;
            albums = [...albums, ...newAlbums];
        } catch {
            if (version === loadVersion) loadError = true;
        } finally {
            if (version === loadVersion) loading = false;
        }
    }

    function retryLoad(): void {
        loadError = false;
        void loadMore();
    }

    // Infinite scroll via IntersectionObserver
    $effect(() => {
        if (!sentinel) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting && hasMore && !loading && !loadError) {
                    void loadMore();
                }
            },
            { rootMargin: '400px' },
        );

        observer.observe(sentinel);
        return () => observer.disconnect();
    });

    function bindSentinel(el: HTMLElement | null) {
        sentinel = el;
    }

    // -------------------------------------------------------------------------
    // Search
    // -------------------------------------------------------------------------

    interface SearchAlbumResult {
        id: string;
        title: string;
        artistName?: string;
        year?: number;
        hasCustomPoster: boolean;
    }

    // `?q=` opens the page already searching — the "See all" link from the
    // /music search lands here with the query the user typed.
    let searchQuery = $state($page.url.searchParams.get('q') ?? '');
    export const snapshot: Snapshot<string> = {
        capture: () => searchQuery,
        restore: (value) => {
            searchQuery = value;
        },
    };
    let searchResults = $state<SearchAlbumResult[]>([]);
    let searchError = $state(false);
    let isSearching = $state(false);
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let searchInputRef: HTMLInputElement | undefined = $state();
    let searchSeq = 0;

    let normalizedQuery = $derived(searchQuery.trim());
    let isSearchMode = $derived(normalizedQuery.length >= 2);

    $effect(() => {
        if (!browser) return;
        const seq = ++searchSeq;
        searchError = false;
        if (normalizedQuery.length >= 2) {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            const query = normalizedQuery;
            isSearching = true;
            searchDebounceTimer = setTimeout(() => void performSearch(query, seq), 200);
        } else {
            searchResults = [];
            isSearching = false;
        }
        return () => {
            searchSeq++;
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        };
    });

    async function performSearch(query: string, seq = ++searchSeq): Promise<void> {
        isSearching = true;
        searchError = false;
        try {
            const result = await contentApi.search(query, {
                types: 'album',
                limit: 100,
            });
            if (seq !== searchSeq) return;
            if (result.error || !result.data) {
                searchError = true;
                searchResults = [];
                return;
            }
            // v1 contract: { items, page }. Each item is a V1SearchResultItem
            // (type: album, ids{}, images{}). The artist name lives in `overview`
            // (music items carry "artist" / "artist · album" there); the album
            // cover is derived from the internal id, so hasCustomPoster is true.
            const items = result.data.items ?? [];
            searchResults = items
                .filter((item) => item.type === 'album')
                .map((item) => ({
                    id: item.ids?.internal ?? item.id,
                    title: item.title,
                    artistName: item.overview ?? undefined,
                    year: item.year,
                    hasCustomPoster: true,
                }));
        } catch {
            if (seq !== searchSeq) return;
            searchError = true;
            searchResults = [];
        } finally {
            if (seq === searchSeq) isSearching = false;
        }
    }

    function clearSearch(): void {
        searchSeq++;
        searchQuery = '';
        searchResults = [];
        isSearching = false;
        searchInputRef?.focus();
    }
</script>

<svelte:head>
    <title>{m.route_music_albums()} — {m.route_music_title()}</title>
</svelte:head>

<div class="mx-auto max-w-7xl space-y-6 px-4 pt-4 lg:pt-20 pb-20">
    <MusicNavigation />
    <MusicLibraryTabs />
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
            <h1 class="text-3xl font-bold text-white">{m.route_music_albums()}</h1>
            {#if data.genre}
                <p class="mt-1 text-surface-400">
                    Genre: <span class="text-primary-400">{data.genre}</span>
                </p>
            {/if}
        </div>

        <!-- Search bar -->
        <div class="relative flex-1 sm:max-w-sm">
            <span
                class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-surface-400">
                <Icon src={MagnifyingGlass} class="h-4 w-4" />
            </span>
            <input
                type="search"
                aria-label={m.music_search_albums_placeholder()}
                aria-describedby="library-search-scope"
                placeholder={m.music_search_albums_placeholder()}
                bind:value={searchQuery}
                bind:this={searchInputRef}
                class="w-full rounded-lg border border-surface-600/50 bg-surface-800/80 py-2 pr-8 pl-9 text-base text-white placeholder-surface-500 outline-none transition-colors focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/30 sm:text-sm" />
            {#if searchQuery}
                <button
                    type="button"
                    aria-label={m.btn_clear_search()}
                    class="absolute top-1/2 right-0 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-surface-400 hover:text-white focus-visible:outline-2 focus-visible:outline-primary-400"
                    onclick={clearSearch}>
                    <Icon src={XMark} class="h-4 w-4" />
                </button>
            {/if}
        </div>

        <select
            aria-label={m.viewer_music_sort()}
            disabled={isSearchMode}
            class="rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-primary-500"
            value={data.sort ?? ''}
            onchange={onSortChange}>
            {#each sortOptions as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
            {/each}
        </select>
    </div>

    <p id="library-search-scope" class="text-sm text-surface-400">{m.viewer_music_album_scope()}</p>
    {#if searchQuery.trim().length === 1}
        <p role="status" class="text-sm text-surface-400">{m.viewer_music_search_start()}</p>
    {/if}
    {#if data.genre || data.artist}
        <div class="flex flex-wrap items-center gap-3 text-sm">
            {#if data.artist}<span class="text-surface-400">{m.viewer_music_artist_filter()}</span
                >{/if}
            <a
                href={resolve('/music/albums')}
                class="rounded-lg bg-surface-800 px-3 py-2 text-primary-300 focus-visible:outline-2 focus-visible:outline-primary-400"
                >{m.viewer_music_clear_filters()}</a>
        </div>
    {/if}

    {#if isSearchMode}
        <!-- Search results -->
        {#if isSearching}
            <div
                role="status"
                aria-label={m.loading()}
                class="flex items-center justify-center py-20">
                <div
                    class="h-6 w-6 animate-spin rounded-full border-2 border-surface-500 border-t-primary-400">
                </div>
            </div>
        {:else if searchError}
            <div role="alert" class="space-y-3 py-12 text-center">
                <p class="text-surface-300">{m.viewer_music_search_error()}</p>
                <button
                    type="button"
                    onclick={() => void performSearch(normalizedQuery)}
                    class="rounded-lg bg-surface-800 px-4 py-3 text-primary-300 focus-visible:outline-2 focus-visible:outline-primary-400"
                    >{m.retry()}</button>
            </div>
        {:else if searchResults.length === 0}
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <span class="mb-4 text-6xl">♪</span>
                <h2 class="mb-2 text-xl font-semibold text-white">No albums found</h2>
                <p class="text-surface-400">
                    No albums match "{searchQuery}"
                </p>
            </div>
        {:else}
            <div
                class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {#each searchResults as album (album.id)}
                    <AlbumCard
                        id={album.id}
                        title={album.title}
                        artistName={album.artistName}
                        year={album.year}
                        hasCustomPoster={album.hasCustomPoster} />
                {/each}
            </div>
        {/if}
    {:else if albums.length === 0 && !loading}
        <div class="flex flex-col items-center justify-center py-20 text-center">
            <span class="mb-4 text-6xl">♪</span>
            <h2 class="mb-2 text-xl font-semibold text-white">No albums found</h2>
            <p class="text-surface-400">Add a music library in Admin to get started.</p>
        </div>
    {:else}
        <div
            class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {#each albums as album, albumIdx (album.id + '-' + albumIdx)}
                <AlbumCard
                    id={album.id}
                    title={album.title}
                    artistName={album.artist.title}
                    year={album.year}
                    hasCustomPoster={album.images.primary?.href != null} />
            {/each}
        </div>

        <!-- Infinite scroll sentinel / status -->
        {#if loadError}
            <div class="flex flex-col items-center justify-center gap-2 py-8">
                <p class="text-sm text-surface-400">Failed to load more albums.</p>
                <button
                    type="button"
                    onclick={retryLoad}
                    class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500">
                    Retry
                </button>
            </div>
        {:else if hasMore}
            <div use:bindSentinel class="flex items-center justify-center py-8" aria-live="polite">
                {#if loading}
                    <div class="flex items-center gap-2 text-sm text-surface-400">
                        <div
                            class="h-4 w-4 animate-spin rounded-full border-2 border-surface-500 border-t-primary-400">
                        </div>
                        Loading more albums...
                    </div>
                {:else}
                    <button
                        type="button"
                        onclick={() => void loadMore()}
                        class="rounded-lg bg-surface-800 px-4 py-3 text-primary-300 focus-visible:outline-2 focus-visible:outline-primary-400"
                        >{m.viewer_music_load_more()}</button>
                {/if}
            </div>
        {:else if albums.length > 0}
            <p
                class="py-8 text-center text-sm text-surface-500"
                aria-live="polite"
                aria-atomic="true">
                All {albums.length} albums loaded
            </p>
        {/if}
    {/if}
</div>
