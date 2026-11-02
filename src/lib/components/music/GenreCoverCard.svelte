<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  A genre tile with a collage cover built from that genre's own album art.

  Genres were the one browse surface in the app with no artwork at all — bare
  text chips next to albums, artists, playlists and radio stations that all
  carry covers. The art to fix that is already in the library, so the collage
  is composed from real album covers rather than generated: nothing here can
  depict a record that does not exist.

  Degrades by tile count, not by failing: 4 covers give a 2x2 grid, 1 gives a
  single full-bleed cover, 0 gives the same note-glyph placeholder every other
  music surface uses.
-->

<script lang="ts">
    import MusicCover from './MusicCover.svelte';
    import { resolve } from '$lib/paths';

    interface Props {
        genre: string;
        /** Album ids, already access-filtered server-side. Up to 4 are used. */
        albumIds?: string[];
        trackCount?: number;
    }

    let { genre, albumIds = [], trackCount }: Props = $props();

    // A 3-cover collage would leave a hole in a 2x2 grid, so fall back to the
    // single-cover layout rather than rendering a gap.
    const tiles = $derived(albumIds.length >= 4 ? albumIds.slice(0, 4) : albumIds.slice(0, 1));
</script>

<a
    href={resolve(`/music/genres/${encodeURIComponent(genre)}`)}
    class="group flex flex-col gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 rounded-lg"
    data-testid="genre-cover-card"
    data-genre={genre}>
    <div
        class="relative aspect-square w-full overflow-hidden rounded-lg bg-surface-800 transition-transform group-hover:scale-[1.02]">
        {#if tiles.length >= 4}
            <div class="grid h-full w-full grid-cols-2 grid-rows-2">
                {#each tiles as albumId (albumId)}
                    <MusicCover id={albumId} hasOwnPoster alt={null} glyph={null} />
                {/each}
            </div>
        {:else if tiles.length === 1}
            <MusicCover id={tiles[0]} hasOwnPoster alt={null} glyphClass="text-4xl" />
        {:else}
            <div class="flex h-full w-full items-center justify-center bg-surface-700">
                <span class="text-4xl text-surface-500" aria-hidden="true">♪</span>
            </div>
        {/if}
        <!-- Scrim keeps the label legible over whatever the collage happens to be. -->
        <div
            class="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-8">
            <p class="truncate text-sm font-semibold text-white">{genre}</p>
            {#if trackCount !== undefined}
                <p class="text-xs text-surface-300">{trackCount}</p>
            {/if}
        </div>
    </div>
</a>
