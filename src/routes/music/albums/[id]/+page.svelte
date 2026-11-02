<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import DiscogsCredit from '$lib/components/music/DiscogsCredit.svelte';
    import MusicDetailNavigation from '$lib/components/music/MusicDetailNavigation.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { toasts } from '$lib/stores/toast.store';
    import { page } from '$app/stores';
    import type { MusicTrack } from '$lib/schemas/music';
    import { openArtistModal } from '$lib/utils/modal-utils';
    import { musicCoverUrl } from '$lib/utils/music-cover';
    import MusicCover from '$lib/components/music/MusicCover.svelte';

    import { isVariousArtistsName } from '$lib/shared/various-artists';

    import { resolve } from '$lib/paths';
    import type { MusicAlbumRow } from '$lib/schemas/api-music-responses';
    import { shuffledTracks } from '$lib/utils/music-mix';
    import TrackTitleLine from '$lib/components/music/TrackTitleLine.svelte';

    let { data } = $props();

    const album: MusicAlbumRow = $derived(data.album);
    /** SSR and API playback use the same public Track DTO. */
    type ClientTrackRow = MusicTrack;

    const tracks: ClientTrackRow[] = $derived(data.tracks);
    interface DiscGroup {
        discNumber: number;
        tracks: { track: ClientTrackRow; index: number }[];
    }

    const discGroups: DiscGroup[] = $derived.by(() => {
        const groups: DiscGroup[] = [];
        tracks.forEach((track, index) => {
            const disc = track.discNumber ?? 1;
            let group = groups.find((entry) => entry.discNumber === disc);
            if (!group) {
                group = { discNumber: disc, tracks: [] };
                groups.push(group);
            }
            group.tracks.push({ track, index });
        });
        return groups.sort((a, b) => a.discNumber - b.discNumber);
    });

    let failedCoverSrc = $state<string | null>(null);
    const coverSrc = $derived(
        musicCoverUrl({
            id: album.id,
            size: 'medium',
            hasOwnPoster: album.images.primary?.href != null,
            variousArtists: isVariousArtistsName(album.artist.title),
        }),
    );
    const coverVisible = $derived(failedCoverSrc !== coverSrc);

    function trackArtists(row: ClientTrackRow): { id?: string; title: string }[] {
        return row.artists.map((a) => ({ ...a, id: a.id ?? undefined }));
    }

    function toMusicTrack(row: ClientTrackRow): MusicTrack {
        return row;
    }

    let startingPlayback = $state(false);

    async function playSelection(queue: MusicTrack[]): Promise<void> {
        if (!queue.length || startingPlayback) return;
        startingPlayback = true;
        try {
            await musicPlayerStore.enqueueFromBrew(queue, true, {
                type: 'album',
                name: album.title,
                trackCount: queue.length - 1,
                sessionId: `album-${album.id}-${Date.now()}`,
            });
        } catch {
            toasts.error('Unable to start playback. Please try again.');
        } finally {
            startingPlayback = false;
        }
    }

    async function playAll(): Promise<void> {
        await playSelection(tracks.map(toMusicTrack));
    }

    async function playShuffled(): Promise<void> {
        await playSelection(shuffledTracks(tracks.map(toMusicTrack)));
    }

    async function playFromTrack(index: number): Promise<void> {
        await playSelection(tracks.slice(index).map(toMusicTrack));
    }

    function formatDuration(seconds: number | null | undefined): string {
        if (!seconds) return '';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function totalDuration(): string {
        const total = tracks.reduce((sum, t) => sum + (t.durationMs ?? 0) / 1000, 0);
        if (total === 0) return '';
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        if (h > 0) return `${h} hr ${m} min`;
        return `${m} min`;
    }

    // Auto-play when redirected from /watch/ with ?autoplay=true
    let autoplayTriggered: string | null = null;
    $effect(() => {
        if (
            $page.url.searchParams.get('autoplay') === 'true' &&
            autoplayTriggered !== album.id &&
            tracks.length > 0
        ) {
            autoplayTriggered = album.id;
            playAll();
        }
    });

    const genre: string | null = $derived(album.genres.join(', ') || null);
</script>

<svelte:head>
    <title>{album.title} — Music</title>
</svelte:head>

<div class="mx-auto max-w-5xl space-y-8 px-4 pt-4 lg:pt-20 pb-20">
    <MusicDetailNavigation destination="/music/albums" label={m.route_music_albums()} />
    <!-- Hero -->
    <div class="flex flex-col gap-6 sm:flex-row sm:items-end">
        <div
            class="aspect-square w-48 flex-shrink-0 overflow-hidden rounded-xl bg-surface-800 shadow-2xl">
            <MusicCover
                src={coverSrc}
                onImageError={(src) => (failedCoverSrc = src)}
                alt={album.title}
                size="medium"
                hasOwnPoster={album.images.primary?.href != null}
                variousArtists={isVariousArtistsName(album.artist.title)}
                glyphClass="text-6xl"
                loading="eager" />
        </div>

        <div class="flex flex-col gap-3">
            <p class="text-sm font-medium uppercase tracking-wide text-surface-400">Album</p>
            <h1 class="text-3xl font-bold text-white">{album.title}</h1>

            <div class="flex flex-wrap items-center gap-2 text-sm text-surface-300">
                {#if album.artist.id}
                    <button
                        type="button"
                        onclick={() =>
                            openArtistModal(album.artist.id!, {
                                sonicEnabled: $page.data?.features?.sonicEmbeddings === true,
                            })}
                        class="font-medium text-white hover:text-primary-400">
                        {album.artist.title ?? 'Unknown Artist'}
                    </button>
                {:else}
                    <span class="font-medium text-white">
                        {album.artist.title ?? 'Unknown Artist'}
                    </span>
                {/if}
                {#if album.year}
                    <span class="text-surface-500">·</span>
                    <span>{album.year}</span>
                {/if}
                <span class="text-surface-500">·</span>
                <span>{tracks.length} tracks</span>
                {#if totalDuration()}
                    <span class="text-surface-500">·</span>
                    <span class="text-surface-400">{totalDuration()}</span>
                {/if}
            </div>

            {#if genre}
                <div class="flex flex-wrap gap-2">
                    <a
                        href={resolve(`/music/genres/${encodeURIComponent(genre.toLowerCase())}`)}
                        class="rounded-full bg-surface-700 px-3 py-1 text-xs text-surface-300 hover:bg-surface-600 hover:text-white">
                        {genre}
                    </a>
                </div>
            {/if}
            <DiscogsCredit
                sourceUrls={[
                    coverVisible ? album.discogsAttribution?.poster : undefined,
                    genre ? album.discogsAttribution?.genre : undefined,
                ]} />
            <div class="flex gap-3">
                <button
                    class="rounded-full bg-primary-500 px-6 py-2 text-sm font-semibold text-white shadow-lg shadow-primary-500/25 transition hover:bg-primary-400 active:scale-95"
                    onclick={playAll}
                    disabled={startingPlayback || tracks.length === 0}>
                    {m.album_play_all()}
                </button>
                <button
                    class="rounded-full border border-surface-600 bg-surface-800 px-6 py-2 text-sm font-semibold text-white transition hover:bg-surface-700 active:scale-95"
                    onclick={playShuffled}
                    disabled={startingPlayback || tracks.length === 0}>
                    {m.album_shuffle()}
                </button>
                <button
                    class="rounded-full border border-surface-600 bg-surface-800 px-6 py-2 text-sm font-semibold text-white transition hover:bg-surface-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={tracks.length === 0}
                    onclick={() => {
                        musicPlayerStore.seedAutoplay({
                            type: 'album',
                            albumId: album.id,
                            albumName: album.title,
                            artistName: album.artist.title ?? undefined,
                        });
                    }}>
                    📻 Start Radio
                </button>
            </div>
        </div>
    </div>

    <!-- Overview -->
    {#if album.overview}
        <div class="space-y-2">
            <p class="text-sm leading-relaxed text-surface-400">{album.overview}</p>
            <DiscogsCredit sourceUrls={[album.discogsAttribution?.overview]} />
        </div>
    {/if}

    <!-- Track List -->
    {#if tracks.length > 0}
        <div>
            <div
                class="mb-2 grid grid-cols-[2rem_1fr_auto] gap-4 border-b border-surface-700 pb-2 text-xs font-medium uppercase tracking-wide text-surface-500">
                <span class="text-center">#</span>
                <span>Title</span>
                <span>Duration</span>
            </div>
            {#each discGroups as group (group.discNumber)}
                {#if discGroups.length > 1}
                    <h3 class="mb-2 mt-6 text-sm font-semibold text-surface-300">
                        {m.album_disc({ number: group.discNumber })}
                    </h3>
                {/if}
                {#each group.tracks as { track, index }, i (track.id)}
                    <button
                        class="group grid w-full grid-cols-[2rem_1fr_auto] items-center gap-4 rounded-lg px-0 py-2 text-left transition-colors hover:bg-surface-800/60"
                        onclick={() => playFromTrack(index)}>
                        <span class="text-center text-sm text-surface-500 group-hover:hidden">
                            {track.trackNumber ?? i + 1}
                        </span>
                        <span class="hidden text-center text-sm text-primary-400 group-hover:block">
                            ▶
                        </span>
                        <div class="min-w-0">
                            <p class="truncate text-sm font-medium text-white">
                                <TrackTitleLine title={track.title} artists={trackArtists(track)} />
                            </p>
                            {#if track.audioFeatures?.bpm != null}
                                <span class="text-xs text-surface-400"
                                    >{Math.round(track.audioFeatures.bpm)} BPM</span>
                            {/if}
                        </div>
                        <span class="text-sm tabular-nums text-surface-400">
                            {formatDuration(
                                track.durationMs == null ? null : track.durationMs / 1000,
                            )}
                        </span>
                    </button>
                {/each}
            {/each}
        </div>
    {/if}
</div>
