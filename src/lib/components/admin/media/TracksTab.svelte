<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { SvelteURLSearchParams } from 'svelte/reactivity';
    import { page } from '$app/state';
    import { musicItemPath } from './music-context.js';
    import { adminWorkspaceUrl, writeAdminWorkspaceUrl } from '../admin-workspace-url.js';
    import { resolve } from '$lib/paths';
    import { toasts } from '$lib/stores/toast.store';
    import { readArtistTracks } from '$lib/api/music-credits.js';
    import { getAdminTracks } from '$lib/api/admin';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        albumId: string;
        kind?: 'album' | 'artist';
        onsaved?: () => void;
    }

    let { albumId, kind = 'album', onsaved: _ }: Props = $props();

    interface AdminTrackRow {
        id: string;
        title: string | null;
        sort_order: number | null;
        runtime_seconds: number | null;
        custom_metadata: Record<string, unknown> | null;
        has_lyrics: boolean;
        file_path: string | null;
        album_id?: string | null;
        album_title?: string | null;
    }

    let tracks = $state<AdminTrackRow[]>([]);
    let loading = $state(true);
    let serverTotal = $state(0);
    let catalogTotal = $state(0);
    let catalogDuration = $state(0);
    // A failed load is not an empty album.
    let loadError = $state(false);
    let loadGeneration = 0;
    // Restore shallow workspace history through the shared admin URL state.
    const workspaceUrl = $derived(adminWorkspaceUrl(page.url, page.state));
    let query = $derived(workspaceUrl.searchParams.get('tracks_q') ?? '');
    let issue = $derived(workspaceUrl.searchParams.get('tracks_issue') ?? 'all');
    let sort = $derived(
        workspaceUrl.searchParams.get('tracks_sort') === 'title' ? 'title' : 'album',
    );
    function parsePage(value: string | null): number {
        const n = Number(value);
        return Number.isSafeInteger(n) && n > 0 ? n : 1;
    }
    let workspacePage = $derived(parsePage(workspaceUrl.searchParams.get('tracks_page')));
    const filteredTracks = $derived.by(() => {
        if (kind === 'artist') return tracks;
        const needle = query.trim().toLocaleLowerCase();
        const rows = tracks.filter(
            (track) =>
                (!needle || (track.title ?? '').toLocaleLowerCase().includes(needle)) &&
                (issue !== 'missing-lyrics' || !track.has_lyrics) &&
                (issue !== 'missing-file' || !track.file_path),
        );
        return sort === 'title'
            ? [...rows].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))
            : rows;
    });
    const pageCount = $derived(
        Math.max(1, Math.ceil((kind === 'artist' ? serverTotal : filteredTracks.length) / 50)),
    );
    const currentPage = $derived(Math.min(workspacePage, pageCount));
    const visibleTracks = $derived(
        kind === 'artist' ? tracks : filteredTracks.slice((currentPage - 1) * 50, currentPage * 50),
    );
    const totalDuration = $derived(
        tracks.reduce((sum, track) => sum + (track.runtime_seconds ?? 0), 0),
    );
    function setWorkspace(key: string, value: string): void {
        workspacePage = key === 'tracks_page' ? parsePage(value) : 1;
        if (key === 'tracks_q') query = value;
        if (key === 'tracks_issue') issue = value;
        if (key === 'tracks_sort') sort = value;
        const target = new URL(workspaceUrl);
        target.searchParams.set('tracks_q', query);
        target.searchParams.set('tracks_issue', issue);
        target.searchParams.set('tracks_sort', sort);
        target.searchParams.set('tracks_page', String(workspacePage));
        writeAdminWorkspaceUrl(target, page.state, true);
    }
    function trackPath(id: string, tab = 'overview', edit = false): string {
        const params = new SvelteURLSearchParams(workspaceUrl.searchParams);
        params.set('tracks_q', query);
        params.set('tracks_issue', issue);
        params.set('tracks_sort', sort);
        params.set('tracks_page', String(currentPage));
        return musicItemPath(
            id,
            params,
            { kind: kind === 'artist' ? 'artist-tracks' : 'album', id: albumId },
            tab,
            edit,
        );
    }

    function formatDuration(seconds: number | null): string {
        if (!seconds) return '—';
        // Runtimes can be fractional, and a DJ mix runs past an hour.
        const total = Math.round(seconds);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function essentia(track: AdminTrackRow): Record<string, unknown> | undefined {
        const ess = track.custom_metadata?.essentia;
        return ess && typeof ess === 'object' ? (ess as Record<string, unknown>) : undefined;
    }

    function getBpm(track: AdminTrackRow): string {
        const bpm = essentia(track)?.bpm;
        if (typeof bpm === 'number') return String(Math.round(bpm));
        if (typeof bpm === 'string') return bpm;
        return '—';
    }

    function getKey(track: AdminTrackRow): string {
        const key = essentia(track)?.key;
        if (typeof key === 'string') return key;
        return '—';
    }

    async function loadTracks(): Promise<void> {
        const generation = ++loadGeneration;
        const requestedAlbum = albumId;
        const requestedKind = kind;
        loading = true;
        loadError = false;
        try {
            if (requestedKind === 'artist') {
                const result = await readArtistTracks(requestedAlbum, {
                    q: query,
                    issue,
                    sort,
                    page: String(workspacePage),
                });
                if (
                    generation !== loadGeneration ||
                    requestedAlbum !== albumId ||
                    requestedKind !== kind
                )
                    return;
                if (!result.data || result.error) {
                    loadError = true;
                    return;
                }
                const lastPage = Math.max(1, Math.ceil(result.data.total / 50));
                if (workspacePage > lastPage) {
                    // A retained URL can outlive a catalog edit. Refetch the
                    // valid page through the same fenced filter effect.
                    loadGeneration += 1;
                    setWorkspace('tracks_page', String(lastPage));
                    return;
                }
                tracks = result.data.tracks;
                serverTotal = result.data.total;
                catalogTotal = result.data.catalogTotal;
                catalogDuration = result.data.durationSeconds;
                return;
            }
            const { data, error } = await getAdminTracks(requestedAlbum);
            if (generation !== loadGeneration || requestedAlbum !== albumId) return;
            if (error || !Array.isArray(data)) {
                loadError = true;
                toasts.error(m.media_tracks_load_failed());
                return;
            }
            tracks = data;
        } catch {
            if (generation !== loadGeneration || requestedAlbum !== albumId) return;
            loadError = true;
            toasts.error(m.media_tracks_load_failed());
        } finally {
            if (generation === loadGeneration && requestedAlbum === albumId) loading = false;
        }
    }

    $effect(() => {
        const _id = albumId;
        const _kind = kind;
        if (_kind === 'artist') {
            const _query = query;
            const _issue = issue;
            const _sort = sort;
            const _page = workspacePage;
            untrack(() => {
                loadGeneration += 1;
                loading = true;
            });
            const timer = setTimeout(() => void loadTracks(), 250);
            return () => {
                clearTimeout(timer);
                loadGeneration += 1;
            };
        }
        untrack(() => {
            tracks = [];
            void loadTracks();
        });
        return () => {
            loadGeneration += 1;
        };
    });
</script>

<div class="space-y-6">
    <div>
        <h3 class="text-lg font-semibold text-white">{m.media_tracks_heading()}</h3>
        <p class="text-sm text-surface-400 mt-1">
            {kind === 'artist' ? m.music_credits_artist_tracks_help() : m.media_tracks_subtitle()}
        </p>
    </div>

    <div class="flex flex-wrap items-end gap-3">
        <label class="min-w-0 flex-1 text-xs text-surface-300"
            >{m.media_music_find_track()}
            <input
                type="search"
                aria-label={m.media_music_find_track()}
                value={query}
                oninput={(event) => setWorkspace('tracks_q', event.currentTarget.value)}
                class="mt-1 w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm" />
        </label>
        <label class="text-xs text-surface-300"
            >{m.media_music_filter_tracks()}
            <select
                aria-label={m.media_music_filter_tracks()}
                value={issue}
                onchange={(event) => setWorkspace('tracks_issue', event.currentTarget.value)}
                class="mt-1 block rounded-lg border border-surface-700 bg-surface-800 px-2 py-2 text-sm">
                <option value="all">{m.media_music_all_tracks()}</option><option
                    value="missing-lyrics">{m.media_music_missing_lyrics()}</option
                ><option value="missing-file">{m.media_music_missing_file()}</option>
            </select>
        </label>
        <label class="text-xs text-surface-300"
            >{m.media_music_sort_tracks()}
            <select
                aria-label={m.media_music_sort_tracks()}
                value={sort}
                onchange={(event) => setWorkspace('tracks_sort', event.currentTarget.value)}
                class="mt-1 block rounded-lg border border-surface-700 bg-surface-800 px-2 py-2 text-sm">
                <option value="album">{m.media_music_album_order()}</option><option value="title"
                    >{m.media_tracks_col_title()}</option>
            </select>
        </label>
    </div>
    {#if loading}
        <div class="flex items-center gap-2 text-surface-400 py-8">
            <div
                class="w-4 h-4 border-2 border-surface-400 border-t-transparent rounded-full animate-spin">
            </div>
            {m.media_tracks_loading()}
        </div>
    {:else if loadError}
        <div class="flex flex-col items-start gap-3 py-8">
            <p class="text-warning-400">{m.media_tracks_load_failed()}</p>
            <button
                class="btn variant-ghost-surface text-sm px-4 py-2"
                onclick={() => void loadTracks()}>
                {m.common_retry()}
            </button>
        </div>
    {:else if (kind === 'artist' ? catalogTotal : tracks.length) === 0}
        <p class="text-surface-500 py-8">{m.media_tracks_empty()}</p>
    {:else}
        <p class="text-sm text-surface-300">
            {(kind === 'artist'
                ? m.music_credits_artist_tracks_summary
                : m.media_music_track_summary)({
                visible: kind === 'artist' ? serverTotal : filteredTracks.length,
                total: kind === 'artist' ? catalogTotal : tracks.length,
                duration: formatDuration(kind === 'artist' ? catalogDuration : totalDuration),
            })}
        </p>
        {#if tracks.some((track) => track.sort_order == null)}<p class="text-xs text-surface-400">
                {m.media_music_order_unknown()}
            </p>{/if}
        {#if filteredTracks.length === 0}<p class="py-6 text-sm text-surface-300">
                {m.media_music_no_track_matches()}
            </p>
        {:else}
            <ul class="space-y-2" aria-label={m.media_tracks_heading()}>
                {#each visibleTracks as track (track.id)}
                    <li class="min-w-0 rounded-lg border border-surface-700 bg-surface-800/30 p-3">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <div class="min-w-0 flex-1">
                                <a
                                    href={resolve(trackPath(track.id))}
                                    class="break-words font-medium text-surface-100 hover:text-yellow-300"
                                    >{track.title ?? m.media_tracks_untitled()}</a>
                                {#if kind === 'artist' && track.album_id}<a
                                        class="mt-1 block break-words text-xs text-primary-300 underline"
                                        href={resolve(trackPath(track.album_id, 'tracks'))}
                                        >{track.album_title ?? '—'}</a
                                    >{/if}
                                <p class="mt-1 text-xs text-surface-400">
                                    {m.media_music_order_number({
                                        disc: String(track.custom_metadata?.disc_number ?? '—'),
                                        track: String(track.sort_order ?? '—'),
                                    })} · <span>{formatDuration(track.runtime_seconds)}</span> · {getBpm(
                                        track,
                                    )} BPM · {getKey(track)}
                                </p>
                                <p class="mt-1 text-xs text-surface-400">
                                    {track.file_path
                                        ? m.media_tracks_file_linked()
                                        : m.media_tracks_file_none()} · {track.has_lyrics
                                        ? m.media_tracks_has_lyrics()
                                        : m.media_music_missing_lyrics()}
                                </p>
                            </div>
                            <div class="flex flex-wrap gap-3 text-xs text-yellow-300">
                                {#if kind === 'artist'}<a
                                        href={resolve(
                                            `${trackPath(track.id, 'overview')}#artist-credits`,
                                        )}>{m.music_credits_review_track()}</a
                                    >{/if}
                                <a href={resolve(trackPath(track.id, 'overview', true))}
                                    >{m.media_redesign_edit_metadata()}</a>
                                <a href={resolve(trackPath(track.id, 'lyrics'))}
                                    >{m.media_tab_lyrics()}</a>
                                <a href={resolve(trackPath(track.id, 'audio-features'))}
                                    >{m.media_tab_audio_features()}</a>
                                <a href={resolve(trackPath(track.id, 'files'))}
                                    >{m.media_tab_files()}</a>
                            </div>
                        </div>
                    </li>
                {/each}
            </ul>
            <nav
                aria-label={m.media_music_track_pages()}
                class="flex flex-wrap items-center gap-4 text-sm">
                <button
                    type="button"
                    class="rounded px-2 py-1 text-surface-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
                    disabled={currentPage <= 1}
                    onclick={() => setWorkspace('tracks_page', String(currentPage - 1))}
                    >{m.media_music_previous_page()}</button>
                <span>{m.media_music_page_count({ page: currentPage, count: pageCount })}</span>
                <button
                    type="button"
                    class="rounded px-2 py-1 text-surface-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400"
                    disabled={currentPage >= pageCount}
                    onclick={() => setWorkspace('tracks_page', String(currentPage + 1))}
                    >{m.media_music_next_page()}</button>
            </nav>
        {/if}
    {/if}
</div>
