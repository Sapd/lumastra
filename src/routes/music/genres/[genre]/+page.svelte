<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { openAlbumModal } from '$lib/utils/modal-utils';
    import type { MusicTrack } from '$lib/schemas/music';
    import { Icon, MapPin } from 'svelte-hero-icons';
    import { pinMusicGenre, unpinMusicGenre } from '$lib/api/music';

    import MusicCover from '$lib/components/music/MusicCover.svelte';
    import MusicDetailNavigation from '$lib/components/music/MusicDetailNavigation.svelte';
    import { page } from '$app/stores';
    import { resolve } from '$lib/paths';

    let { data } = $props();

    let startingRadio = $state(false);

    let isPinned = $derived.by(() => data.isPinned);
    let isPinnedOverride = $state<boolean | null>(null);
    let pinLoading = $state(false);

    // Use override during optimistic updates, fall back to server data
    let effectivePinned = $derived(isPinnedOverride ?? isPinned);

    async function togglePin(): Promise<void> {
        if (pinLoading) return;
        pinLoading = true;
        const wasPinned = effectivePinned;

        try {
            isPinnedOverride = !wasPinned;
            const { error } = wasPinned
                ? await unpinMusicGenre(data.genre)
                : await pinMusicGenre(data.genre);
            if (error) {
                isPinnedOverride = wasPinned;
            }
        } finally {
            pinLoading = false;
        }
    }

    type TabId = 'albums' | 'singles' | 'songs';
    let activeTab: TabId = $state('albums');
    let songSearch = $state('');

    // Split albums vs singles by track count (4+ = album, 1-3 = single)
    let fullAlbums = $derived(
        data.albums.filter((a: { trackCount: number }) => a.trackCount >= 4),
    );
    let singles = $derived(data.albums.filter((a: { trackCount: number }) => a.trackCount < 4));

    // Filter songs by search query
    let filteredTracks = $derived.by(() => {
        if (!songSearch.trim()) return data.tracks;
        const q = songSearch.toLowerCase().trim();
        return data.tracks.filter(
            (t) =>
                t.title.toLowerCase().includes(q) ||
                (t.album?.title ?? '').toLowerCase().includes(q) ||
                (t.artists.map((a) => a.title).join(', ')?.toLowerCase().includes(q) ?? false),
        );
    });

    // Auto-select first non-empty tab
    $effect(() => {
        if (fullAlbums.length > 0) {
            // default is albums, no change needed
        } else if (singles.length > 0) {
            activeTab = 'singles';
        } else if (data.tracks.length > 0) {
            activeTab = 'songs';
        }
    });

    async function startRadio(): Promise<void> {
        if (data.albums.length === 0 || startingRadio) return;
        startingRadio = true;
        try {
            musicPlayerStore.seedAutoplay({
                type: 'genre',
                genre: data.genre,
                label: data.genre,
            });
        } finally {
            startingRadio = false;
        }
    }

    function formatDuration(seconds: number | null): string {
        if (seconds == null) return '';
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function playTrack(track: MusicTrack): void {
        musicPlayerStore.play(track);
    }

    const displayGenre: string = $derived(
        data.genre ? data.genre.charAt(0).toUpperCase() + data.genre.slice(1) : '',
    );

    const totalReleases = $derived(data.albums.length);
    const totalSongs = $derived(data.tracks.length);

    const tabs: { id: TabId; label: string; count: () => number }[] = [
        { id: 'albums', label: m.tab_albums(), count: () => fullAlbums.length },
        { id: 'singles', label: m.tab_singles(), count: () => singles.length },
        { id: 'songs', label: m.tab_songs(), count: () => data.tracks.length },
    ];
</script>

<svelte:head>
    <title>{displayGenre} — Music</title>
</svelte:head>

<div class="mx-auto max-w-7xl space-y-6 px-4 pt-4 lg:pt-20 pb-20">
    <MusicDetailNavigation destination="/music/explore" label={m.music_tab_explore()} />
    <!-- Header -->
    <div class="flex items-center justify-between">
        <div>
            <p class="text-sm text-surface-400">Genre</p>
            <h1 class="text-3xl font-bold text-white">{displayGenre}</h1>
            <p class="mt-1 text-sm text-surface-400">
                {totalReleases}
                {totalReleases === 1 ? m.music_release_singular() : m.music_releases_plural()} &middot;
                {totalSongs}
                {totalSongs === 1 ? m.music_song_singular() : m.music_songs_plural()}
            </p>
        </div>
        <div class="flex items-center gap-2">
            <button
                class="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition active:scale-95 {effectivePinned
                    ? 'bg-primary-500/20 text-primary-300 ring-1 ring-primary-500/40 hover:bg-primary-500/30'
                    : 'bg-surface-700 text-surface-300 hover:bg-surface-600 hover:text-white'}"
                disabled={pinLoading}
                onclick={togglePin}>
                {#if pinLoading}
                    <span
                        class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                        aria-hidden="true"></span>
                {:else}
                    <Icon src={MapPin} class="h-4 w-4" solid={effectivePinned} />
                {/if}
                {effectivePinned ? m.music_pinned() : m.music_pin_to_home()}
            </button>
            <button
                class="rounded-full bg-primary-500 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-primary-500/25 transition hover:bg-primary-400 active:scale-95"
                disabled={startingRadio}
                onclick={startRadio}>
                {#if startingRadio}
                    {m.music_starting()}
                {:else}
                    {m.music_start_radio()}
                {/if}
            </button>
        </div>
    </div>

    {#if data.albums.length === 0 && data.tracks.length === 0}
        <div class="flex flex-col items-center justify-center py-20 text-center">
            <span class="mb-4 text-6xl">♪</span>
            <h2 class="mb-2 text-xl font-semibold text-white">
                {m.music_genre_empty_title({ genre: displayGenre })}
            </h2>
            <p class="text-surface-400">
                {m.music_genre_empty_description()}
            </p>
        </div>
    {:else}
        <!-- Tabs -->
        <div class="flex gap-1 border-b border-surface-700" role="tablist">
            {#each tabs as tab (tab.id)}
                {@const count = tab.count()}
                <button
                    role="tab"
                    id="tab-{tab.id}"
                    aria-selected={activeTab === tab.id}
                    aria-controls="tabpanel-{tab.id}"
                    class="px-4 py-2 text-sm font-medium transition-colors relative {activeTab ===
                    tab.id
                        ? 'text-white'
                        : 'text-surface-400 hover:text-surface-200'}"
                    class:opacity-50={count === 0}
                    disabled={count === 0}
                    tabindex={activeTab === tab.id ? 0 : -1}
                    onclick={() => {
                        activeTab = tab.id;
                        songSearch = '';
                    }}
                    onkeydown={(e) => {
                        const ids: TabId[] = ['albums', 'singles', 'songs'];
                        const idx = ids.indexOf(activeTab);
                        if (e.key === 'ArrowRight') {
                            const next = ids[(idx + 1) % ids.length];
                            activeTab = next;
                            songSearch = '';
                        } else if (e.key === 'ArrowLeft') {
                            const prev = ids[(idx - 1 + ids.length) % ids.length];
                            activeTab = prev;
                            songSearch = '';
                        }
                    }}>
                    {tab.label}
                    <span class="text-xs text-surface-500 ml-1">({count})</span>
                    {#if activeTab === tab.id}
                        <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary-500"></div>
                    {/if}
                </button>
            {/each}
        </div>

        <!-- Albums Tab -->
        {#if activeTab === 'albums'}
            <div role="tabpanel" id="tabpanel-albums" aria-labelledby="tab-albums" tabindex="0">
                {#if fullAlbums.length === 0}
                    <p class="text-center text-surface-400 py-8">No albums found.</p>
                {:else}
                    <div
                        class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                        {#each fullAlbums as album (album.id)}
                            <a
                                href={resolve(`/music/albums/${album.id}`)}
                                class="group flex flex-col gap-2 rounded-lg p-2 text-left transition-colors hover:bg-surface-800/50 w-full"
                                onclick={(e) => {
                                    e.preventDefault();
                                    openAlbumModal(album.id, {
                                        sonicEnabled:
                                            $page.data?.features?.sonicEmbeddings === true,
                                    });
                                }}>
                                <div
                                    class="aspect-square w-full overflow-hidden rounded-lg bg-surface-800">
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
                                    <p class="truncate text-xs text-surface-400">
                                        {album.artist.title ?? m.music_unknown_artist()}
                                        {#if album.year}
                                            <span class="text-surface-500"> · {album.year}</span>
                                        {/if}
                                    </p>
                                    <p class="text-xs text-surface-500">
                                        {album.trackCount}
                                        {album.trackCount === 1
                                            ? m.music_track_singular()
                                            : m.music_tracks_plural()}
                                    </p>
                                </div>
                            </a>
                        {/each}
                    </div>
                {/if}
            </div>
        {:else if activeTab === 'singles'}
            <!-- Singles Tab -->
            <div role="tabpanel" id="tabpanel-singles" aria-labelledby="tab-singles" tabindex="0">
                {#if singles.length === 0}
                    <p class="text-center text-surface-400 py-8">
                        {m.music_no_singles()}
                    </p>
                {:else}
                    <div
                        class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                        {#each singles as single (single.id)}
                            <a
                                href={resolve(`/music/albums/${single.id}`)}
                                class="group flex flex-col gap-2 rounded-lg p-2 text-left transition-colors hover:bg-surface-800/50 w-full"
                                onclick={(e) => {
                                    e.preventDefault();
                                    openAlbumModal(single.id, {
                                        sonicEnabled:
                                            $page.data?.features?.sonicEmbeddings === true,
                                    });
                                }}>
                                <div
                                    class="aspect-square w-full overflow-hidden rounded-lg bg-surface-800">
                                    <MusicCover
                                        id={single.id}
                                        alt={single.title}
                                        hasOwnPoster={single.images.primary?.href != null}
                                        imgClass="h-full w-full object-cover transition-transform group-hover:scale-105" />
                                </div>
                                <div class="min-w-0">
                                    <p class="truncate text-sm font-medium text-white">
                                        {single.title}
                                    </p>
                                    <p class="truncate text-xs text-surface-400">
                                        {single.artist.title ?? m.music_unknown_artist()}
                                        {#if single.year}
                                            <span class="text-surface-500"> · {single.year}</span>
                                        {/if}
                                    </p>
                                </div>
                            </a>
                        {/each}
                    </div>
                {/if}
            </div>
        {:else if activeTab === 'songs'}
            <!-- Songs Tab with search -->
            <div role="tabpanel" id="tabpanel-songs" aria-labelledby="tab-songs" tabindex="0">
                <div class="mb-4">
                    <input
                        type="text"
                        class="w-full rounded-lg border border-surface-600/50 bg-surface-800/80 px-4 py-2 text-sm text-white placeholder-surface-500 outline-none transition-colors focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/30"
                        placeholder={m.music_search_songs_placeholder()}
                        bind:value={songSearch} />
                </div>

                {#if filteredTracks.length === 0}
                    <p class="text-center text-surface-400 py-8">
                        {songSearch ? m.music_no_songs_match() : m.music_no_songs_found()}
                    </p>
                {:else}
                    <ol class="flex flex-col gap-0.5 list-none">
                        {#each filteredTracks as track, i (track.id)}
                            <li>
                                <button
                                    type="button"
                                    class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-800/50 transition-colors text-left w-full group"
                                    onclick={() => playTrack(track)}>
                                    <span
                                        class="text-xs text-surface-500 w-6 text-right flex-shrink-0"
                                        aria-hidden="true">
                                        {i + 1}
                                    </span>
                                    <div
                                        class="w-9 h-9 rounded overflow-hidden bg-surface-800 flex-shrink-0">
                                        <MusicCover
                                            id={track.id}
                                            alt={(track.album?.title ?? '')}
                                            hasOwnPoster={true}
                                            glyphClass="text-xs" />
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <p
                                            class="truncate text-sm font-medium text-white group-hover:text-primary-400 transition-colors">
                                            {track.title}
                                        </p>
                                        <p class="truncate text-xs text-surface-400">
                                            {track.artists.map((a) => a.title).join(', ') ?? m.music_unknown_artist()}
                                            · {(track.album?.title ?? '')}{track.year
                                                ? ` (${track.year})`
                                                : ''}
                                        </p>
                                    </div>
                                    {#if track.durationMs}
                                        <span class="text-xs text-surface-500 flex-shrink-0">
                                            {formatDuration(track.durationMs == null ? null : track.durationMs / 1000)}
                                        </span>
                                    {/if}
                                </button>
                            </li>
                        {/each}
                    </ol>
                {/if}
            </div>
        {/if}
    {/if}
</div>
