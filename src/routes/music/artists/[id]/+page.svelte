<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import DiscogsCredit from '$lib/components/music/DiscogsCredit.svelte';
    import MusicDetailNavigation from '$lib/components/music/MusicDetailNavigation.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { artistEnrichmentDisplay } from '$lib/shared/music-provenance';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { toasts } from '$lib/stores/toast.store';
    import { page } from '$app/stores';

    import { openAlbumModal } from '$lib/utils/modal-utils';
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import { getArtist } from '$lib/api/music';
    import { shuffledTracks } from '$lib/utils/music-mix';
    import MusicCover from '$lib/components/music/MusicCover.svelte';
    import { resolve } from '$lib/paths';
    import type {
        MusicArtistRow,
        MusicAlbumSummary,
    } from '$lib/schemas/api-music-responses';

    let { data } = $props();

    const artist: MusicArtistRow = $derived(data.artist);
    const albums: MusicAlbumSummary[] = $derived(data.albums);

    let startingPlayback = $state(false);

    async function playAll(): Promise<void> {
        if (startingPlayback) return;
        const selectedArtist = artist;
        startingPlayback = true;
        try {
            const result = await getArtist(selectedArtist.id);
            if (artist.id !== selectedArtist.id) return;
            if (result.error || !result.data) throw new Error('Unable to load songs');
            const queue = result.data.tracks;
            if (!queue.length) {
                toasts.info('No playable songs are available for this artist.');
                return;
            }
            await musicPlayerStore.enqueueFromBrew(shuffledTracks(queue), true, {
                type: 'artist',
                name: selectedArtist.title,
                trackCount: queue.length,
            });
        } catch {
            toasts.error('Unable to play this artist. Please try again.');
        } finally {
            startingPlayback = false;
        }
    }

    // Auto-play (shuffled) when redirected from /watch/ with ?autoplay=true
    let autoplayTriggered: string | null = null;
    $effect(() => {
        if (
            $page.url.searchParams.get('autoplay') === 'true' &&
            autoplayTriggered !== artist.id &&
            albums.length > 0
        ) {
            autoplayTriggered = artist.id;
            playAll();
        }
    });

    const enrichmentDisplay = $derived(
        artistEnrichmentDisplay({ genre: artist.genres, country_code: artist.countryCode }, artist.biography),
    );
    const artistGenres = $derived(enrichmentDisplay.genres);
</script>

<svelte:head>
    <title>{artist.title} — Music</title>
</svelte:head>

<div class="mx-auto max-w-5xl space-y-8 px-4 pt-4 lg:pt-20 pb-20">
    <MusicDetailNavigation destination="/music/artists" label={m.route_music_artists()} />
    <!-- Artist Hero -->
    <div class="flex flex-col gap-6 sm:flex-row sm:items-end">
        <div
            class="aspect-square w-44 flex-shrink-0 overflow-hidden rounded-full bg-surface-800 shadow-2xl">
            {#if artist.images.primary?.href}
                <img
                    src={getCatalogPosterUrl(artist.id, { size: 'medium' })}
                    alt={artist.title}
                    class="h-full w-full object-cover" />
            {:else}
                <div class="flex h-full w-full items-center justify-center bg-surface-700">
                    <span class="text-5xl text-surface-500">♪</span>
                </div>
            {/if}
        </div>

        <div class="flex flex-col gap-3">
            <p class="text-sm font-medium uppercase tracking-wide text-surface-400">Artist</p>
            <h1 class="text-3xl font-bold text-white">{artist.title}</h1>

            <div class="flex flex-wrap items-center gap-2 text-sm text-surface-300">
                <span>
                    {artist.albumCount}
                    {artist.albumCount === 1 ? 'album' : 'albums'}
                </span>
            </div>

            {#if artistGenres.length > 0}
                <div class="flex flex-wrap gap-2">
                    {#each artistGenres as g, gIdx (g + '-' + gIdx)}
                        <a
                            href={resolve(`/music/genres/${encodeURIComponent(g.toLowerCase())}`)}
                            class="rounded-full bg-surface-700 px-3 py-1 text-xs text-surface-300 hover:bg-surface-600 hover:text-white">
                            {g}
                        </a>
                    {/each}
                </div>
            {/if}
            <DiscogsCredit sourceUrls={[
                artist.images.primary ? artist.discogsAttribution?.poster : undefined,
                artistGenres.length ? artist.discogsAttribution?.genre : undefined,
            ]} />
            <div class="flex gap-3">
                <button
                    class="rounded-full bg-primary-500 px-6 py-2 text-sm font-semibold text-white shadow-lg shadow-primary-500/25 transition hover:bg-primary-400 active:scale-95"
                    onclick={playAll}
                    disabled={startingPlayback}>
                    {startingPlayback ? 'Loading songs…' : 'Shuffle songs'}
                </button>
                <button
                    class="rounded-full border border-surface-600 bg-surface-800 px-6 py-2 text-sm font-semibold text-white transition hover:bg-surface-700 active:scale-95"
                    onclick={() =>
                        musicPlayerStore.seedAutoplay({
                            type: 'artist',
                            artistId: artist.id,
                            artistName: artist.title,
                        })}>
                    📻 Start Radio
                </button>
            </div>
        </div>
    </div>

    <!-- Bio -->
    {#if enrichmentDisplay.biography}
        <div class="space-y-2">
            <p class="text-sm leading-relaxed text-surface-400">{enrichmentDisplay.biography}</p>
            <DiscogsCredit sourceUrls={[artist.discogsAttribution?.biography]} />
        </div>
    {/if}

    <!-- Discography -->
    <div>
        <h2 class="mb-4 text-xl font-semibold text-white">Discography</h2>
        {#if albums.length === 0}
            <p class="text-surface-400">No albums found.</p>
        {:else}
            <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {#each albums as album (album.id)}
                    <button
                        type="button"
                        onclick={() =>
                            openAlbumModal(album.id, {
                                sonicEnabled: $page.data?.features?.sonicEmbeddings === true,
                            })}
                        class="group flex flex-col gap-2 rounded-lg p-2 transition-colors hover:bg-surface-800/50">
                        <div class="aspect-square w-full overflow-hidden rounded-lg bg-surface-800">
                            <MusicCover
                                id={album.id}
                                alt={album.title}
                                hasOwnPoster={album.images.primary?.href != null}
                                imgClass="h-full w-full object-cover transition-transform group-hover:scale-105" />
                        </div>
                        <div class="min-w-0">
                            <p class="truncate text-sm font-medium text-white">
                                {album.title}
                            </p>
                            {#if album.year}
                                <p class="text-xs text-surface-400">
                                    {album.year}
                                </p>
                            {/if}
                            <p class="text-xs text-surface-500">
                                {album.trackCount}
                                {album.trackCount === 1 ? 'track' : 'tracks'}
                            </p>
                        </div>
                    </button>
                {/each}
            </div>
        {/if}
    </div>
</div>
