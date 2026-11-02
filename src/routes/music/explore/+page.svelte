<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /music/explore — the Explore tab. Genre browser + mood chips + sonic-tool
  tiles, composed from existing components. Rendered at both breakpoints; only
  linked from the bar on mobile.
-->

<script lang="ts">
    import type { PageServerData } from './$types';
    import MusicGenreBrowser from '$lib/components/music/MusicGenreBrowser.svelte';
    import GenreCoverCard from '$lib/components/music/GenreCoverCard.svelte';
    import MusicMoodChips from '$lib/components/music/MusicMoodChips.svelte';
    import MusicFeatureTiles from '$lib/components/music/MusicFeatureTiles.svelte';
    import MusicNavigation from '$lib/components/music/MusicNavigation.svelte';
    import * as m from '$lib/paraglide/messages.js';

    let {
        data,
    }: {
        data: Pick<
            PageServerData,
            'libraryGenres' | 'pinnedGenreNames' | 'genreCovers' | 'moodChips'
        >;
    } = $props();
    let genresExpanded = $state(false);
    const GENRE_PREVIEW_COUNT = 12;

    // Only genres the server actually built a collage for; the chip browser
    // below is still the complete list.
    const coveredGenres = $derived(
        data.libraryGenres.filter((g) => (data.genreCovers?.[g.genre]?.length ?? 0) > 0),
    );
    const visibleGenres = $derived(
        genresExpanded ? coveredGenres : coveredGenres.slice(0, GENRE_PREVIEW_COUNT),
    );
</script>

<svelte:head>
    <title>{m.route_music_title()}</title>
</svelte:head>

<div class="mx-auto max-w-7xl space-y-8 px-4 pt-4 lg:pt-20 pb-20">
    <MusicNavigation />
    <header class="space-y-2">
        <h1 class="text-3xl font-bold text-surface-50">{m.music_tab_explore()}</h1>
        <p class="max-w-2xl text-base leading-relaxed text-surface-300">
            {m.music_explore_intro()}
        </p>
    </header>

    <MusicFeatureTiles showOnMobile />
    <MusicMoodChips moodChips={data.moodChips} />

    {#if coveredGenres.length > 0}
        <section aria-label={m.route_music_browse_genres()}>
            <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-surface-400">
                {m.route_music_browse_genres()}
            </h2>
            <div
                class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
                id="explore-genre-covers"
                data-testid="genre-cover-grid">
                {#each visibleGenres as g (g.genre)}
                    <GenreCoverCard
                        genre={g.genre}
                        albumIds={data.genreCovers[g.genre]}
                        trackCount={g.trackCount} />
                {/each}
            </div>
            {#if coveredGenres.length > GENRE_PREVIEW_COUNT}
                <button
                    type="button"
                    class="mt-4 min-h-11 rounded-lg border border-surface-600 px-4 py-2 text-sm font-semibold text-primary-200 transition-colors hover:bg-surface-800 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-300"
                    aria-expanded={genresExpanded}
                    aria-controls="explore-genre-covers"
                    onclick={() => (genresExpanded = !genresExpanded)}>
                    {genresExpanded
                        ? m.music_explore_fewer_genres()
                        : m.music_explore_all_genres({ count: String(coveredGenres.length) })}
                </button>
            {/if}
        </section>
    {/if}

    <MusicGenreBrowser
        libraryGenres={data.libraryGenres}
        pinnedGenreNames={data.pinnedGenreNames} />
</div>
