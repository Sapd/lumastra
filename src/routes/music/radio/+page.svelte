<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { musicGenreIcon } from '$lib/utils/music-genre-icon';
    import { page } from '$app/stores';
    import { onMount } from 'svelte';
    import { RadioTower } from '$lib/components/admin/navigation/lumastra-custom-icons';
    import MusicSubpageHeader from '$lib/components/music/MusicSubpageHeader.svelte';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import RadioStationCard from '$lib/components/music/RadioStationCard.svelte';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { radioSectionPreferences } from '$lib/stores/radioSectionPreferences';

    let { data } = $props();
    let genreQuery = $state('');
    let showAllGenres = $state(false);
    const matchingGenres = $derived(
        (data.genres ?? []).filter((genre) =>
            genre.genre.toLowerCase().includes(genreQuery.trim().toLowerCase()),
        ),
    );
    const visibleGenres = $derived(
        genreQuery.trim() || showAllGenres ? matchingGenres : matchingGenres.slice(0, 12),
    );

    // Initialize the radio-section pref store from localStorage so we
    // can offer a "Show on home" affordance when the user has hidden
    // the shelf on /music. Idempotent across mounts.
    onMount(() => {
        radioSectionPreferences.init();
    });

    let isHiddenOnHome = $derived($radioSectionPreferences.position === 'hidden');

    async function startMoodChannel(mood: {
        genre: string;
        label: string;
        emoji: string;
    }): Promise<void> {
        musicPlayerStore.seedAutoplay({
            type: 'mood',
            mood: mood.genre,
            label: mood.label,
            emoji: mood.emoji,
        });
    }

    async function startGenreChannel(genre: string): Promise<void> {
        musicPlayerStore.seedAutoplay({ type: 'genre', genre, label: genre });
    }
</script>

<svelte:head>
    <title>Radio — Music</title>
</svelte:head>

<MusicSubpageHeader title={m.music_feature_radio_label()} icon={RadioTower} />

<div class="mx-auto max-w-7xl space-y-10 px-4 pb-20 pt-6">
    <p class="text-surface-400">Smart radio and internet stations</p>

    {#if isHiddenOnHome}
        <!-- Persistent restore path: shown only when the radio shelf is
             hidden from /music. Lives here because /music has nothing
             left to right-click once hidden. -->
        <div
            class="flex items-center justify-between gap-3 rounded-lg border border-surface-700/50 bg-surface-800/40 px-4 py-2 text-sm text-surface-300">
            <span>Internet Radio is currently hidden from your /music home page.</span>
            <button
                type="button"
                class="rounded-md bg-primary-500/20 px-3 py-1 text-xs font-medium text-primary-300 hover:bg-primary-500/30"
                onclick={() => radioSectionPreferences.setPosition('auto')}>
                Show on home
            </button>
        </div>
    {/if}

    <!-- Smart Radio -->
    <section>
        <h2 class="mb-4 text-xl font-semibold text-white">Smart Radio</h2>
        <p class="mb-4 text-sm text-surface-400">
            Pick a mood and we'll build a station from your library using audio similarity.
        </p>

        <!-- Mood Chips -->
        <div class="flex flex-wrap gap-3">
            {#each data.moods as mood, moodIdx (mood.genre + '-' + moodIdx)}
                <button
                    class="relative flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-surface-900 {$musicPlayerStore
                        .autoplaySeed?.type === 'mood' &&
                    $musicPlayerStore.autoplaySeed.mood === mood.genre
                        ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/25'
                        : 'bg-surface-800 text-surface-300 hover:bg-surface-700 hover:text-white'}"
                    onclick={() => startMoodChannel(mood)}>
                    <span>{mood.emoji}</span>
                    <span>{mood.label}</span>
                    {#if $musicPlayerStore.autoplaySeed?.type === 'mood' && $musicPlayerStore.autoplaySeed.mood === mood.genre}
                        <span class="ml-0.5">▶</span>
                    {/if}
                </button>
            {/each}
        </div>
    </section>

    <!-- Genre Radio -->
    {#if data.genres && data.genres.length > 0}
        <section>
            <h2 class="mb-4 text-xl font-semibold text-white">Genre Radio</h2>
            <input
                type="search"
                aria-label="Find a radio genre"
                placeholder="Find a genre…"
                bind:value={genreQuery}
                class="mb-4 w-full rounded-lg border border-surface-600 bg-surface-800 px-3 py-2 text-white" />
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {#each visibleGenres as genre, genreIdx (genre.genre + '-' + genreIdx)}
                    <button
                        class="flex min-w-[120px] flex-col items-center justify-center rounded-xl bg-surface-800 p-4 transition-all hover:bg-surface-700 {$musicPlayerStore
                            .autoplaySeed?.type === 'genre' &&
                        $musicPlayerStore.autoplaySeed.genre === genre.genre
                            ? 'ring-2 ring-primary-500'
                            : ''}"
                        onclick={() => startGenreChannel(genre.genre)}>
                        <span class="text-2xl" aria-hidden="true"
                            >{musicGenreIcon(genre.genre)}</span>
                        <span class="mt-2 text-sm font-medium capitalize text-white"
                            >{genre.genre}</span>
                        <span class="text-xs text-surface-400">{genre.trackCount} tracks</span>
                    </button>
                {/each}
            </div>
            {#if visibleGenres.length === 0}
                <p class="py-4 text-surface-400">No genres match this search.</p>
            {:else if !genreQuery.trim() && matchingGenres.length > 12}
                <button
                    class="mt-3 min-h-11 text-primary-400"
                    onclick={() => (showAllGenres = !showAllGenres)}>
                    {showAllGenres
                        ? 'Show fewer genres'
                        : `Show all ${matchingGenres.length} genres`}
                </button>
            {/if}
        </section>
    {/if}

    <!-- Internet Radio -->
    <section>
        <h2 class="mb-4 text-xl font-semibold text-white">Internet Radio</h2>

        {#if data.stations.length > 0}
            <div
                class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {#each data.stations as station (station.id)}
                    <RadioStationCard {station} />
                {/each}
            </div>
        {:else}
            <div
                class="flex flex-col items-center justify-center rounded-xl bg-surface-800/30 py-16 text-center">
                <span class="mb-4 text-5xl">📻</span>
                <h3 class="mb-2 text-lg font-semibold text-white">No stations yet</h3>
                <p class="max-w-sm text-sm text-surface-400">
                    {#if $page.data.pluginUser?.isAdmin}
                        Add internet radio streams from the
                        <a
                            href={resolve('/admin/settings/music?tab=radio')}
                            class="text-primary-400 hover:text-primary-300 underline">
                            admin Radio page</a
                        >.
                    {:else}
                        No internet radio stations are available. You can still listen to Smart
                        Radio or Genre Radio above.
                    {/if}
                </p>
            </div>
        {/if}
    </section>
</div>
