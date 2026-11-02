<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        Icon,
        ChevronDown,
        ChevronRight,
        ChevronLeft,
        MusicalNote,
        Play,
    } from 'svelte-hero-icons';
    import { SvelteSet } from 'svelte/reactivity';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import MusicCover from '$lib/components/music/MusicCover.svelte';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import { z } from 'zod';
    import { apiGet } from '$lib/api/client.js';

    interface TrackNode {
        id: string;
        title: string | null;
        sort_order: number | null;
        runtime_seconds: number | null;
        album_id: string;
    }

    interface AlbumNode {
        id: string;
        title: string;
        year: number | null;
        custom_poster_url: string | null;
        track_count: number;
        sort_order: number | null;
        tracks: TrackNode[];
    }

    interface ArtistInfo {
        id: string;
        title: string;
        custom_poster_url: string | null;
        album_count: number;
        track_count: number;
    }

    interface MusicHierarchyResult {
        artist: ArtistInfo;
        albums: AlbumNode[];
        currentItemId: string;
        resolvedFromChild: boolean;
    }

    interface Props {
        artistId: string;
        currentItemId: string;
        collapsed?: boolean;
        ontoggle?: () => void;
    }

    let { artistId, currentItemId, collapsed = false, ontoggle }: Props = $props();

    let artist = $state<ArtistInfo | null>(null);
    let albums = $state<AlbumNode[]>([]);
    let loading = $state(true);
    let loadError = $state(false);
    let expandedAlbums = new SvelteSet<string>();
    let asideEl = $state<HTMLElement | undefined>(undefined);

    // Scroll the active item into view when navigation, data, or expansion changes
    $effect(() => {
        void currentItemId;
        void albums;
        void expandedAlbums.size;
        if (!asideEl) return;
        const handle = setTimeout(() => {
            const el = asideEl?.querySelector('[data-current="true"]') as HTMLElement | null;
            el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }, 50);
        return () => clearTimeout(handle);
    });

    function playTrack(track: TrackNode, album: AlbumNode): void {
        void musicPlayerStore.startPlayback(
            musicTrackFromCard({
                id: track.id,
                title: track.title ?? 'Unknown Track',
                artists: [{ id: artist?.id ?? null, title: artist?.title ?? 'Unknown Artist' }],
                type: 'track',
                durationMs:
                    track.runtime_seconds == null ? null : Math.round(track.runtime_seconds * 1000),
                album: { id: album.id, title: album.title },
            }),
        );
    }

    function formatDuration(seconds: number | null): string {
        if (!seconds) return '';
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    $effect(() => {
        void artistId;
        void loadHierarchy();
    });

    const MusicHierarchySchema = z
        .object({
            artist: z.unknown(),
            albums: z.array(z.unknown()),
            currentItemId: z.string().optional(),
            resolvedFromChild: z.boolean().optional(),
        })
        .passthrough();

    async function loadHierarchy(): Promise<void> {
        loading = true;
        loadError = false;
        const { data, error } = await apiGet(
            `/api/admin/media/${artistId}/music-hierarchy`,
            MusicHierarchySchema,
        );
        loading = false;
        if (error || !data) {
            loadError = true;
            return;
        }
        artist = data.artist as ArtistInfo;
        albums = data.albums as AlbumNode[];

        // Auto-expand the album containing the current item
        if (currentItemId !== artistId) {
            for (const album of data.albums as AlbumNode[]) {
                if (
                    album.id === currentItemId ||
                    album.tracks.some((t) => t.id === currentItemId)
                ) {
                    expandedAlbums.add(album.id);
                    break;
                }
            }
        }
    }

    function toggleAlbum(albumId: string): void {
        if (expandedAlbums.has(albumId)) {
            expandedAlbums.delete(albumId);
        } else {
            expandedAlbums.add(albumId);
        }
    }

    function navigateToItem(id: string): void {
        goto(resolve(`/admin/library/media/${id}`));
    }
</script>

<aside
    bind:this={asideEl}
    class="{collapsed
        ? 'w-10'
        : 'w-72'} shrink-0 border-r border-surface-700/50 bg-surface-900/50 flex flex-col sticky top-0 max-h-screen overflow-hidden">
    {#if collapsed}
        <button
            type="button"
            class="p-2 text-surface-500 hover:text-surface-300 transition-colors flex items-center justify-center"
            aria-expanded={!collapsed}
            title={m.media_sidebar_expand()}
            onclick={() => ontoggle?.()}>
            <Icon src={ChevronRight} class="w-4 h-4" />
        </button>
    {:else}
        <div
            class="flex items-center justify-end px-1 py-1 border-b border-surface-700/50 shrink-0">
            <button
                type="button"
                class="p-1.5 text-surface-500 hover:text-surface-300 transition-colors rounded"
                aria-expanded={!collapsed}
                title={m.media_sidebar_collapse()}
                onclick={() => ontoggle?.()}>
                <Icon src={ChevronLeft} class="w-4 h-4" />
            </button>
        </div>
    {/if}
    {#if collapsed}
        <!-- Rail only; hierarchy content is not rendered while collapsed. -->
    {:else if loading}
        <div class="flex items-center justify-center py-8 text-surface-500 text-sm">
            {m.media_plain_loading()}
        </div>
    {:else if loadError}
        <div class="flex items-center justify-center py-8 text-red-400 text-sm">
            Failed to load hierarchy
        </div>
    {:else if artist}
        <!-- Artist header -->
        <button
            data-current={currentItemId === artistId ? 'true' : undefined}
            class="p-3 flex items-center gap-3 hover:bg-surface-800/40 transition-colors border-b border-surface-700/50 text-left w-full
            {currentItemId === artistId ? 'bg-primary-500/10' : ''}"
            onclick={() => navigateToItem(artistId)}>
            {#if artist.custom_poster_url}
                <img
                    src={getCatalogPosterUrl(artist.id, { size: 'thumb' })}
                    alt="{artist.title} cover"
                    class="w-10 h-10 rounded object-cover bg-surface-700 shrink-0" />
            {:else}
                <div
                    class="w-10 h-10 rounded bg-surface-700 shrink-0 flex items-center justify-center">
                    <Icon src={MusicalNote} class="w-5 h-5 text-surface-500" />
                </div>
            {/if}
            <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-surface-100 truncate">
                    {artist.title}
                </p>
                <p class="text-xs text-surface-500">
                    {artist.album_count} albums, {artist.track_count} tracks
                </p>
            </div>
        </button>

        <!-- Album/Track tree -->
        <nav class="flex-1 overflow-y-auto">
            {#each albums as album (album.id)}
                <div>
                    <!-- Album row -->
                    <div class="flex items-center">
                        <!-- Chevron toggle: expand/collapse only -->
                        <button
                            class="p-2 text-surface-500 hover:text-surface-300 transition-colors shrink-0"
                            title={expandedAlbums.has(album.id) ? 'Collapse' : 'Expand'}
                            onclick={(e) => {
                                e.stopPropagation();
                                toggleAlbum(album.id);
                            }}>
                            <Icon
                                src={expandedAlbums.has(album.id) ? ChevronDown : ChevronRight}
                                class="w-3.5 h-3.5" />
                        </button>
                        <!-- Album label: navigates to album detail + expands -->
                        <button
                            data-current={currentItemId === album.id ? 'true' : undefined}
                            class="flex-1 flex items-center gap-2 pr-3 py-2 text-left hover:bg-surface-800/40 transition-colors text-sm
                            {currentItemId === album.id
                                ? 'bg-primary-500/10 text-primary-400'
                                : 'text-surface-300'}"
                            onclick={() => {
                                expandedAlbums.add(album.id);
                                navigateToItem(album.id);
                            }}>
                            <!-- The sidebar shows what the byte route SERVES, so
                                 an album with no cover of its own shows the
                                 artist art it inherits — the same image the
                                 Images tab labels "INHERITED". -->
                            <div class="w-6 h-6 rounded overflow-hidden shrink-0">
                                <MusicCover
                                    id={album.id}
                                    hasOwnPoster={album.custom_poster_url != null}
                                    imgClass="h-full w-full rounded object-cover"
                                    glyph={null} />
                            </div>
                            <span class="flex-1 truncate">
                                {album.title}{#if album.year}&nbsp;<span
                                        class="text-surface-500 text-xs">({album.year})</span
                                    >{/if}
                            </span>
                            <span
                                class="text-xs text-surface-500 bg-surface-800/60 px-1.5 py-0.5 rounded-full shrink-0">
                                {album.track_count}
                            </span>
                        </button>
                    </div>

                    <!-- Tracks (expanded) -->
                    {#if expandedAlbums.has(album.id)}
                        <div class="ml-4 border-l border-surface-700/30">
                            {#each album.tracks as track (track.id)}
                                <button
                                    data-current={currentItemId === track.id ? 'true' : undefined}
                                    class="w-full flex items-center gap-2 pl-4 pr-3 py-1.5 text-left hover:bg-surface-800/40 transition-colors text-xs
                                    {currentItemId === track.id
                                        ? 'bg-primary-500/10 text-primary-400'
                                        : 'text-surface-400'}"
                                    onclick={() => navigateToItem(track.id)}>
                                    <span
                                        class="font-mono text-surface-500 shrink-0 w-5 text-right">
                                        {track.sort_order ?? '·'}
                                    </span>
                                    <span class="flex-1 truncate">
                                        {track.title ?? 'Untitled'}
                                    </span>
                                    <span class="shrink-0 relative group/play">
                                        {#if track.runtime_seconds}
                                            <span
                                                class="text-surface-500 tabular-nums group-hover/play:invisible">
                                                {formatDuration(track.runtime_seconds)}
                                            </span>
                                        {/if}
                                        <div
                                            role="button"
                                            tabindex="-1"
                                            class="absolute inset-0 items-center justify-center text-primary-400 hover:text-primary-300 cursor-pointer {track.runtime_seconds
                                                ? 'hidden group-hover/play:flex'
                                                : 'flex'}"
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                playTrack(track, album);
                                            }}
                                            onkeydown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.stopPropagation();
                                                    playTrack(track, album);
                                                }
                                            }}
                                            title={m.media_plain_play_track()}>
                                            <Icon src={Play} class="w-3.5 h-3.5" />
                                        </div>
                                    </span>
                                </button>
                            {/each}
                        </div>
                    {/if}
                </div>
            {/each}
        </nav>
    {/if}
</aside>
