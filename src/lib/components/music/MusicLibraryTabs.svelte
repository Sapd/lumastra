<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MusicLibraryTabs — segmented header (Playlists | Albums | Artists)
  shared by the three library surfaces (/playlists?type=music, /music/albums,
  /music/artists). Library destination memory is shared by the primary bars.
-->

<script lang="ts">
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';
    import {
        libraryHref,
        segmentFromRoute,
        type LibrarySegment,
    } from '$lib/utils/music-bottom-nav';
    import * as m from '$lib/paraglide/messages.js';

    const active = $derived<LibrarySegment>(
        segmentFromRoute(
            $page.route.id ?? null,
            $page.url.searchParams,
            $page.data?.playlist?.playlistType,
        ) ?? 'playlists',
    );

    interface Seg {
        key: LibrarySegment;
        label: string;
    }
    const segments = $derived<Seg[]>([
        { key: 'playlists', label: m.route_music_playlists() },
        { key: 'albums', label: m.route_music_albums() },
        { key: 'artists', label: m.route_music_artists() },
    ]);
</script>

<nav
    class="mb-4 flex w-full gap-1 rounded-lg bg-surface-800/60 p-1 lg:max-w-lg"
    aria-label={m.route_music_browse_library()}>
    {#each segments as seg (seg.key)}
        <a
            href={resolve(libraryHref(seg.key))}
            aria-current={active === seg.key ? 'page' : undefined}
            class="min-w-0 flex-1 break-words rounded-md px-2 py-3 text-center text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary-400 sm:px-3 sm:text-sm {active ===
            seg.key
                ? 'bg-surface-700 text-surface-50'
                : 'text-surface-400 hover:text-surface-200'}">
            {seg.label}
        </a>
    {/each}
</nav>
