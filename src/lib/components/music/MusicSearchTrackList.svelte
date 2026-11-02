<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MusicSearchTrackList — the "Songs" block of music search as a dense,
  scannable list (cover · title · artist · album · year · duration) instead of
  big album-art cards: a search hit is picked by reading, and cards showed ~12
  songs per screen. Clicking a row PLAYS the song (the reason you searched);
  album and similar-tracks are trailing icon buttons. On desktop the artist and
  album names in the credit line are links with hover cards, exactly like the
  mini player's track info.

  Keyboard: ↑/↓ move between rows (DOM order = visual order — the two-column
  layout flows down column 1 first), ↑ on the first row or Esc hands focus back
  to the search input (`onexit`), Enter plays.
-->

<script lang="ts" module>
    export interface SearchTrackRow {
        id: string;
        title: string;
        artist: string;
        album?: string;
        albumId?: string;
        artistId?: string;
        /** Structured track artists, so each credited artist links separately. */
        artists?: ReadonlyArray<{ id?: string; title: string }>;
        remixerArtists?: ReadonlyArray<{ id?: string; title: string }>;
        year?: number;
        duration?: number;
        image?: string;
    }
</script>

<script lang="ts">
    import { Icon, Play, RectangleStack, Sparkles, ChevronDown } from 'svelte-hero-icons';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { formatDuration } from '$lib/utils/time-formatting';
    import { openAlbumModal } from '$lib/utils/modal-utils';
    import TrackArtistLine from './TrackArtistLine.svelte';
    import TrackTitleLine from './TrackTitleLine.svelte';
    import MusicEntityHoverCard from './MusicEntityHoverCard.svelte';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        rows: SearchTrackRow[];
        onplay: (row: SearchTrackRow) => void;
        onalbum: (row: SearchTrackRow) => void;
        onsimilar: (row: SearchTrackRow) => void;
        onexit?: () => void;
        /** The server has more songs for this query than `rows` holds. */
        hasMore?: boolean;
        loadingMore?: boolean;
        /** The last "Load more" failed; the rows already shown stay. */
        loadMoreFailed?: boolean;
        onloadmore?: () => void;
    }

    let {
        rows,
        onplay,
        onalbum,
        onsimilar,
        onexit,
        hasMore = false,
        loadingMore = false,
        loadMoreFailed = false,
        onloadmore,
    }: Props = $props();

    // No client-side fold: every fetched song is shown and more are paged in
    // from the server. The old 10-row fold hid ranked hits behind "Show all"
    // (a credited remix sat at row 11 and read as "not found").
    let listEl: HTMLOListElement | undefined = $state();

    // An expression, not literal text: Svelte trims whitespace at element
    // boundaries, so <span> · </span> would render as a bare "·".
    const SEP = ' · ';

    let currentTrackId = $derived($musicPlayerStore.currentTrack?.id ?? null);

    function rowButtons(): HTMLButtonElement[] {
        return Array.from(listEl?.querySelectorAll<HTMLButtonElement>('[data-track-row]') ?? []);
    }

    export function focusFirst(): boolean {
        const first = rowButtons()[0];
        first?.focus();
        return !!first;
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const buttons = rowButtons();
        const index = buttons.findIndex((b) => b === document.activeElement);
        if (e.key === 'Escape') {
            e.preventDefault();
            onexit?.();
            return;
        }
        if (index === -1) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (index === 0) onexit?.();
            else buttons[index - 1]?.focus();
        } else if (e.key === 'Home') {
            e.preventDefault();
            buttons[0]?.focus();
        } else if (e.key === 'End') {
            e.preventDefault();
            buttons[buttons.length - 1]?.focus();
        }
    }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ol
    bind:this={listEl}
    class="track-grid grid grid-cols-1 gap-x-6 gap-y-0.5 lg:grid-flow-col lg:grid-cols-2"
    style:--rows={Math.ceil(rows.length / 2)}
    onkeydown={handleKeydown}>
    {#each rows as row (row.id)}
        {@const playing = row.id === currentTrackId}
        <li
            class="group flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-surface-800/70 has-[[data-track-row]:focus-visible]:bg-surface-800/80 has-[[data-track-row]:focus-visible]:ring-2 has-[[data-track-row]:focus-visible]:ring-primary-400/70
                {playing ? 'bg-primary-500/10' : ''}">
            <!-- The play button is stretched over the whole row instead of wrapping
                 it, so the credit line can hold real artist/album links (a button
                 cannot contain buttons). Only the link buttons sit above it (md, z-10);
                 on mobile they stay plain text under it, like the mini player, and
                 a tap anywhere plays. -->
            <div class="relative flex min-w-0 flex-1 items-center gap-3 p-1.5">
                <button
                    type="button"
                    data-track-row
                    class="absolute inset-0 rounded-lg outline-none"
                    title={row.title}
                    aria-label={m.music_search_play_track({ title: row.title, artist: row.artist })}
                    aria-current={playing ? 'true' : undefined}
                    onclick={() => onplay(row)}></button>
                <span
                    class="pointer-events-none relative h-11 w-11 shrink-0 overflow-hidden rounded-md bg-surface-800">
                    {#if row.image}
                        <img
                            src={row.image}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            class="h-full w-full object-cover" />
                    {/if}
                    <span
                        class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 text-white transition-opacity
                            {playing
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:opacity-100 group-has-[[data-track-row]:focus-visible]:opacity-100'}">
                        {#if playing && $musicPlayerStore.isPlaying}
                            <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
                        {:else}
                            <Icon src={Play} solid class="h-5 w-5" />
                        {/if}
                    </span>
                </span>
                <span class="pointer-events-none min-w-0 flex-1">
                    <span
                        class="block truncate text-sm font-medium md:[&_button]:pointer-events-auto md:[&_button]:relative md:[&_button]:z-10 {playing
                            ? 'text-primary-300'
                            : 'text-surface-50'}"
                        ><TrackTitleLine
                            title={row.title}
                            artists={row.artists}
                            remixerArtists={row.remixerArtists} /></span>
                    <span
                        class="block truncate text-xs text-surface-400 md:[&_button]:pointer-events-auto md:[&_button]:relative md:[&_button]:z-10"
                        >{#if row.artist}<TrackArtistLine
                                artist={row.artist}
                                artists={row.artists}
                                artistId={row.artistId} />{/if}{#if row.album}{#if row.artist}<span
                                    class="text-surface-500">{SEP}</span
                                >{/if}{#if row.albumId}<MusicEntityHoverCard
                                    kind="album"
                                    id={row.albumId}
                                    class="hover:text-primary-400 hover:underline"
                                    onclick={(e) => {
                                        e.stopPropagation();
                                        openAlbumModal(row.albumId ?? '');
                                    }}>{row.album}</MusicEntityHoverCard
                                >{:else}{row.album}{/if}{/if}{#if row.year}<span
                                class="text-surface-500">{SEP}</span
                            >{row.year}{/if}</span>
                </span>
                {#if row.duration}
                    <span
                        class="pointer-events-none shrink-0 pl-2 text-xs tabular-nums text-surface-500"
                        >{formatDuration(row.duration)}</span>
                {/if}
            </div>
            <button
                type="button"
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-surface-400 transition hover:bg-surface-700 hover:text-surface-50 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary-400 lg:opacity-0 lg:group-hover:opacity-100 lg:group-has-[[data-track-row]:focus-visible]:opacity-100"
                title={m.music_go_to_album()}
                aria-label={m.music_go_to_album()}
                onclick={() => onalbum(row)}>
                <Icon src={RectangleStack} class="h-4 w-4" />
            </button>
            <button
                type="button"
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-surface-400 transition hover:bg-surface-700 hover:text-surface-50 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary-400 lg:opacity-0 lg:group-hover:opacity-100 lg:group-has-[[data-track-row]:focus-visible]:opacity-100"
                title={m.music_find_similar_tracks_aria()}
                aria-label={m.music_find_similar_tracks_aria()}
                onclick={() => onsimilar(row)}>
                <Icon src={Sparkles} class="h-4 w-4" />
            </button>
        </li>
    {/each}
</ol>

{#if hasMore && onloadmore}
    <div class="mt-2 flex flex-wrap items-center gap-3">
        <!-- aria-disabled, not disabled: a disabled button drops keyboard focus
             right after the user pressed it. -->
        <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary-400 transition-colors hover:text-primary-300 focus-visible:outline-2 focus-visible:outline-primary-400 aria-disabled:opacity-60"
            aria-disabled={loadingMore}
            aria-busy={loadingMore}
            onclick={() => {
                if (!loadingMore) onloadmore();
            }}>
            {m.viewer_music_load_more()}
            <Icon src={ChevronDown} class="h-3 w-3" />
        </button>
        {#if loadMoreFailed}
            <p role="alert" class="text-xs text-surface-400">{m.viewer_music_search_error()}</p>
        {/if}
    </div>
{/if}

<style>
    /* Column-major flow on two columns so ↑/↓ (DOM order) match what the eye
       reads: down column 1, then column 2. */
    @media (min-width: 1024px) {
        .track-grid {
            grid-template-rows: repeat(var(--rows), minmax(0, auto));
        }
    }

    .eq {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 14px;
    }
    .eq i {
        width: 3px;
        background: currentColor;
        border-radius: 1px;
        animation: eq 0.9s ease-in-out infinite;
    }
    .eq i:nth-child(2) {
        animation-delay: -0.3s;
    }
    .eq i:nth-child(3) {
        animation-delay: -0.6s;
    }
    @keyframes eq {
        0%,
        100% {
            height: 30%;
        }
        50% {
            height: 100%;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .eq i {
            animation: none;
            height: 70%;
        }
    }
</style>
