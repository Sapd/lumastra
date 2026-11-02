<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { SvelteURLSearchParams } from 'svelte/reactivity';
    import { page } from '$app/state';
    import { musicItemPath } from './music-context.js';
    import { replaceState } from '$app/navigation';
    import * as m from '$lib/paraglide/messages';
    import { resolve } from '$lib/paths';
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import { toasts } from '$lib/stores/toast.store';
    import { getAdminAlbums } from '$lib/api/admin';
    import { requireValue } from '$lib/utils/runtime-validation';

    interface Props {
        artistId: string;
        onsaved?: () => void;
    }

    let { artistId, onsaved: _ }: Props = $props();

    interface AdminAlbumRow {
        id: string;
        title: string;
        year: number | null;
        custom_poster_url: string | null;
        track_count: number;
        total_duration_seconds: number;
        album_type: string | null;
        sort_order: number | null;
    }

    let albums = $state<AdminAlbumRow[]>([]);
    let loading = $state(true);
    // A failed load is not an empty discography.
    let loadError = $state(false);
    let loadGeneration = 0;
    let query = $derived(page.url.searchParams.get('albums_q') ?? '');
    const filteredAlbums = $derived(
        albums.filter((album) =>
            album.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        ),
    );
    function albumPath(id: string, tab = 'overview', edit = false): string {
        const params = new SvelteURLSearchParams(page.url.searchParams);
        params.set('albums_q', query);
        return musicItemPath(id, params, { kind: 'artist', id: artistId }, tab, edit);
    }
    function setQuery(value: string): void {
        query = value;
        const target = new URL(page.url);
        value ? target.searchParams.set('albums_q', value) : target.searchParams.delete('albums_q');
        void replaceState(target, page.state);
    }

    function formatTotalDuration(seconds: number): string {
        // A sum of runtimes can be fractional; '3:07.42' is not a duration.
        const total = Math.round(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    async function loadAlbums(): Promise<void> {
        const generation = ++loadGeneration;
        const requestedArtist = artistId;
        loading = true;
        loadError = false;
        try {
            const { data, error } = await getAdminAlbums(requestedArtist);
            if (generation !== loadGeneration || requestedArtist !== artistId) return;
            if (error || !Array.isArray(data)) {
                loadError = true;
                toasts.error(m.media_discography_load_failed());
                return;
            }
            albums = data;
        } catch {
            if (generation !== loadGeneration || requestedArtist !== artistId) return;
            loadError = true;
            toasts.error(m.media_discography_load_failed());
        } finally {
            if (generation === loadGeneration && requestedArtist === artistId) loading = false;
        }
    }

    $effect(() => {
        const _id = artistId;
        untrack(() => {
            albums = [];
            void loadAlbums();
        });
        return () => {
            loadGeneration += 1;
        };
    });
</script>

<div class="space-y-6">
    <div>
        <h3 class="text-lg font-semibold text-white">{m.media_discography_heading()}</h3>
        <p class="text-sm text-surface-400 mt-1">{m.media_discography_subtitle()}</p>
    </div>

    <label class="block text-xs text-surface-300"
        >{m.media_music_find_album()}
        <input
            type="search"
            aria-label={m.media_music_find_album()}
            value={query}
            oninput={(event) => setQuery(event.currentTarget.value)}
            class="mt-1 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm" />
    </label>
    {#if loading}
        <div class="flex items-center gap-2 text-surface-400 py-8">
            <div
                class="w-4 h-4 border-2 border-surface-400 border-t-transparent rounded-full animate-spin">
            </div>
            {m.media_discography_loading()}
        </div>
    {:else if loadError}
        <div class="flex flex-col items-start gap-3 py-8">
            <p class="text-warning-400">{m.media_discography_load_failed()}</p>
            <button
                class="btn variant-ghost-surface text-sm px-4 py-2"
                onclick={() => void loadAlbums()}>
                {m.common_retry()}
            </button>
        </div>
    {:else if albums.length === 0}
        <p class="text-surface-500 py-8">{m.media_discography_empty()}</p>
    {:else}
        <p class="text-sm text-surface-300">
            {m.media_music_album_summary({
                albums: albums.length,
                tracks: albums.reduce((sum, album) => sum + album.track_count, 0),
                duration: formatTotalDuration(
                    albums.reduce((sum, album) => sum + album.total_duration_seconds, 0),
                ),
            })}
        </p>
        {#if filteredAlbums.length === 0}<p class="text-sm text-surface-300">
                {m.media_music_no_album_matches()}
            </p>{/if}
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {#each filteredAlbums as album (album.id)}
                <article class="min-w-0 text-left group">
                    <a href={resolve(albumPath(album.id))} aria-label={album.title}>
                        <!-- Square cover art -->
                        <div
                            class="aspect-square rounded-lg overflow-hidden bg-surface-800 mb-3 group-hover:ring-2 group-hover:ring-primary-500/50 transition-all">
                            <img
                                src={getCatalogPosterUrl(album.id, {
                                    size: 'thumb',
                                })}
                                alt={album.title}
                                class="w-full h-full object-cover"
                                onerror={(e) => {
                                    const target = e.currentTarget as HTMLImageElement;
                                    target.style.display = 'none';
                                    const parent = requireValue(
                                        target.parentElement,
                                        'album image must have a parent element',
                                    );
                                    parent.classList.add('flex', 'items-center', 'justify-center');
                                    parent.innerHTML =
                                        '<svg class="w-10 h-10 text-surface-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"/></svg>';
                                }} />
                        </div>

                        <!-- Album info -->
                        <div class="space-y-1">
                            <div class="flex items-start gap-1.5">
                                <p
                                    class="text-sm font-medium text-surface-100 leading-tight break-words min-w-0 flex-1">
                                    {album.title}
                                </p>
                                {#if album.album_type && album.album_type !== 'album'}
                                    <span
                                        class="shrink-0 px-1.5 py-0.5 text-[10px] rounded-full bg-primary-500/15 text-primary-300 capitalize">
                                        {album.album_type}
                                    </span>
                                {/if}
                            </div>

                            <p class="text-xs text-surface-400">
                                {#if album.year}{album.year} ·
                                {/if}{album.track_count === 1
                                    ? m.media_discography_track_count_one({
                                          count: album.track_count,
                                      })
                                    : m.media_discography_track_count_many({
                                          count: album.track_count,
                                      })} · {formatTotalDuration(album.total_duration_seconds)}
                            </p>
                        </div>
                    </a>
                    <div class="mt-2 flex flex-wrap gap-3 text-xs text-yellow-300">
                        <a href={resolve(albumPath(album.id, 'overview', true))}
                            >{m.media_redesign_edit_metadata()}</a
                        ><a href={resolve(albumPath(album.id, 'tracks'))}>{m.media_tab_tracks()}</a>
                    </div>
                </article>
            {/each}
        </div>
    {/if}
</div>
