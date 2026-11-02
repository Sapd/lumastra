<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import * as contentApi from '$lib/api/content';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import type { MusicTrack } from '$lib/schemas/music';
    import type { SearchResultItem as V1SearchResultItem } from '$lib/api/content';
    import QueueSimpleTrackRow from './QueueSimpleTrackRow.svelte';
    import * as m from '$lib/paraglide/messages';

    let searchInputRef: HTMLInputElement | undefined = $state();

    let query = $state('');
    let searchResults = $state<MusicTrack[]>([]);
    let isSearching = $state(false);
    let searchError = $state<string | null>(null);
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * Monotonic token guarding search-result writes. A slower earlier query
     * could otherwise overwrite a newer one — same pattern as /music's
     * performSearch.
     */
    let searchVersion = 0;

    let suggestions = $state<MusicTrack[]>([]);
    let suggestionsLoading = $state(false);
    /** Monotonic token guarding suggestion writes — same rationale as searchVersion. */
    let suggestionsVersion = 0;
    /** Last currentTrack id suggestions were fetched for (plain let: the
     *  tracking $effect re-runs on every store tick and must no-op cheaply). */
    let suggestionsTrackId: string | null = null;

    const normalizedQuery = $derived(query.trim());
    const isSearchMode = $derived(normalizedQuery.length >= 2);
    const hasCurrentTrack = $derived($musicPlayerStore.currentTrack !== null);

    /**
     * Maps a music-typed v1 search result item to a MusicTrack. Adapted from
     * the playlist `toTrack` helper in src/routes/music/+page.svelte — that
     * helper reads a flat `artist` field off playlist items, which search
     * results don't carry. Here the artist name is parsed out of the
     * "Artist · Album" `overview` string instead (same pattern as /music's
     * own `searchTrackArtistKey`), while `album`/`albumId`/`artistId` come
     * straight from the structured fields.
     */
    function toTrack(item: V1SearchResultItem): MusicTrack {
        return musicTrackFromCard({
            id: item.catalogId ?? item.id,
            title: item.title,
            remixerArtists: item.remixerArtists?.map((a) => ({ ...a, id: a.id ?? null })),
            images: { ...item.images, primary: item.images.primary ?? item.images.poster },
            artists: item.artists?.map((a) => ({ ...a, id: a.id ?? null })) ?? [
                {
                    id: item.artistId ?? null,
                    title: (item.overview ?? '').split('·')[0]?.trim() || 'Unknown Artist',
                },
            ],
            album: item.albumId ? { id: item.albumId, title: item.album ?? '' } : null,
        });
    }

    async function performSearch(q: string): Promise<void> {
        const version = ++searchVersion;
        isSearching = true;
        searchError = null;
        try {
            const { data, error } = await contentApi.search(q, { types: 'track', limit: 20 });
            if (version !== searchVersion) return;
            if (error || !data) {
                searchError = 'Unable to search. Please try again.';
                searchResults = [];
                return;
            }
            searchResults = data.items.filter((item) => item.type === 'track').map(toTrack);
        } catch {
            if (version === searchVersion) {
                searchResults = [];
                searchError = 'Unable to search. Please try again.';
            }
        } finally {
            if (version === searchVersion) isSearching = false;
        }
    }

    async function loadSuggestions(): Promise<void> {
        if (!hasCurrentTrack) return;
        const version = ++suggestionsVersion;
        suggestionsLoading = true;
        try {
            const candidates = await musicPlayerStore.getSuggestionCandidates();
            if (version !== suggestionsVersion) return;
            suggestions = candidates;
        } finally {
            if (version === suggestionsVersion) suggestionsLoading = false;
        }
    }

    function removeSuggestion(trackId: string): void {
        suggestions = suggestions.filter((t) => t.id !== trackId);
    }

    /** Enqueue, reporting whether it was a real add (store dedupes silently). */
    function enqueue(track: MusicTrack): boolean {
        const isDuplicate = $musicPlayerStore.queue.some((q) => q.id === track.id);
        musicPlayerStore.addToQueue(track);
        return !isDuplicate;
    }

    // Refetch suggestions when the playing track changes (skip/autoplay) so a
    // long-open tab doesn't keep recommendations computed for the old context.
    // The effect re-runs on every store tick (progress updates included), so
    // it must bail unless the id actually changed.
    $effect(() => {
        const trackId = $musicPlayerStore.currentTrack?.id ?? null;
        if (trackId === suggestionsTrackId) return;
        suggestionsTrackId = trackId;
        if (trackId) {
            void loadSuggestions();
        } else {
            suggestionsVersion++;
            suggestions = [];
            suggestionsLoading = false;
        }
    });

    $effect(() => {
        searchVersion++;
        searchResults = [];
        searchError = null;
        isSearching = normalizedQuery.length >= 2;
        if (normalizedQuery.length >= 2) {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            const q = normalizedQuery;
            searchDebounceTimer = setTimeout(() => void performSearch(q), 200);
        } else {
            // Bump the version so an in-flight performSearch from before the
            // query was cleared can't land late and flash stale results.
            searchVersion++;
            searchResults = [];
        }
        return () => {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        };
    });

    onDestroy(() => {
        searchVersion++;
        suggestionsVersion++;
    });

    onMount(() => {
        // No autofocus on touch devices — it would pop the virtual keyboard
        // even when the user only came to browse Suggestions.
        if (!window.matchMedia('(pointer: coarse)').matches) {
            void tick().then(() => searchInputRef?.focus());
        }
        // Initial suggestions load happens in the track-tracking $effect.
    });
</script>

<div>
    <input
        bind:this={searchInputRef}
        type="search"
        bind:value={query}
        aria-label={m.music_add_search_placeholder()}
        placeholder={m.music_add_search_placeholder()}
        class="mb-4 w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-white placeholder-surface-500 focus:border-primary-500 focus:outline-none" />

    {#if isSearchMode}
        <!-- ═══ SEARCH RESULTS ═══ -->
        {#if isSearching && searchResults.length === 0}
            <div class="flex items-center gap-3 rounded-lg bg-surface-800/50 p-3">
                <div
                    class="h-4 w-4 animate-spin rounded-full border-2 border-surface-600 border-t-primary-400">
                </div>
                <span class="text-xs text-surface-500">{m.music_queue_finding_next()}</span>
            </div>
        {:else if searchError}
            <p role="alert" class="p-3 text-sm text-surface-300">
                {searchError}
                <button class="underline" onclick={() => void performSearch(normalizedQuery)}
                    >Retry</button>
            </p>
        {:else if searchResults.length === 0}
            <p class="px-1 py-3 text-xs text-surface-500">{m.music_add_no_results()}</p>
        {:else}
            <div class="space-y-0.5">
                {#each searchResults as track (track.id)}
                    <QueueSimpleTrackRow
                        {track}
                        activateLabel={m.card_music_add_to_queue()}
                        feedbackOnActivate
                        onactivate={() => enqueue(track)}
                        onadd={() => enqueue(track)}
                        onplaynext={() => musicPlayerStore.addToQueueFront(track)} />
                {/each}
            </div>
        {/if}
    {:else}
        <!-- ═══ SUGGESTIONS ═══ -->
        <div class="mb-2 flex items-center justify-between">
            <h3 class="text-xs uppercase text-surface-400">{m.music_suggestions_label()}</h3>
            {#if hasCurrentTrack}
                <button
                    type="button"
                    class="rounded p-1 text-surface-400 transition-colors hover:bg-surface-800 hover:text-white"
                    aria-label={m.music_get_suggestions_aria()}
                    onclick={() => void loadSuggestions()}>
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        class="h-4 w-4"
                        viewBox="0 0 20 20"
                        fill="currentColor">
                        <path
                            fill-rule="evenodd"
                            d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                            clip-rule="evenodd" />
                    </svg>
                </button>
            {/if}
        </div>

        {#if !hasCurrentTrack}
            <p class="px-1 py-3 text-xs text-surface-500">{m.music_suggestions_need_track()}</p>
        {:else if suggestionsLoading && suggestions.length === 0}
            <div class="flex items-center gap-3 rounded-lg bg-surface-800/50 p-3">
                <div
                    class="h-4 w-4 animate-spin rounded-full border-2 border-surface-600 border-t-primary-400">
                </div>
                <span class="text-xs text-surface-500">{m.music_queue_finding_next()}</span>
            </div>
        {:else if suggestions.length === 0}
            <p class="px-1 py-3 text-xs text-surface-500">{m.music_add_no_results()}</p>
        {:else}
            <div class="space-y-0.5">
                {#each suggestions as track (track.id)}
                    <QueueSimpleTrackRow
                        {track}
                        activateLabel={m.card_music_add_to_queue()}
                        onactivate={() => {
                            enqueue(track);
                            removeSuggestion(track.id);
                        }}
                        onadd={() => {
                            const added = enqueue(track);
                            removeSuggestion(track.id);
                            return added;
                        }}
                        onplaynext={() => {
                            musicPlayerStore.addToQueueFront(track);
                            removeSuggestion(track.id);
                        }} />
                {/each}
            </div>
        {/if}
    {/if}
</div>
