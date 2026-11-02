<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import DiscogsCredit from '$lib/components/music/DiscogsCredit.svelte';
    import * as m from '$lib/paraglide/messages';
    import { onMount, tick } from 'svelte';
    import { modals } from '$lib/stores/modal.store';
    import MusicEntityHoverCard from '$lib/components/music/MusicEntityHoverCard.svelte';
    import { shuffledTracks } from '$lib/utils/music-mix';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { openArtistModal, openAlbumModal } from '$lib/utils/modal-utils';
    import type { MusicTrack } from '$lib/schemas/music';
    import type {
        MusicAlbumRow,
        MusicTrackRow,
        SimilarAlbum,
        AlbumSeriesEntry,
    } from '$lib/schemas/api-music-responses';
    import { getAlbum, getAlbumSeries, getSimilarAlbums } from '$lib/api/music';
    import PopularityBadge from '$lib/components/music/PopularityBadge.svelte';
    import TrackTitleLine from '$lib/components/music/TrackTitleLine.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { addTrackToPlaylistEntry } from '$lib/components/playlist/add-to-playlist-menu';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
    import { swipeToClose } from '$lib/utils/swipe-to-close';
    import { musicCoverUrl } from '$lib/utils/music-cover';
    import MusicCover from '$lib/components/music/MusicCover.svelte';
    import { VARIOUS_ARTISTS_LABEL, isVariousArtistsName } from '$lib/shared/various-artists';

    interface Props {
        albumId: string;
        modalId: string;
        sonicEnabled?: boolean;
        /**
         * Track UUID to scroll to and visually highlight once the tracklist
         * renders — set when the modal is opened FROM a track (card click),
         * so the user lands on "their" song instead of the top of the album.
         */
        highlightTrackId?: string;
        onAdd?: (item: {
            externalIds: { internal: string };
            mediaType: string;
            title: string;
            seriesName?: string;
            posterPath?: string;
        }) => void;
    }

    // Album row schema doesn't carry popularity (server attaches it on the
    // outer wrapper in the detail response); widen locally so the template
    // can reference `album.popularity`.
    type AlbumData = MusicAlbumRow & {
        popularity?: MusicTrackRow['popularity'];
    };

    interface TrackArtistChip {
        id?: string;
        name: string;
    }

    type TrackData = MusicTrackRow;

    function trackEssentia(track: TrackData): Record<string, unknown> | undefined {
        return track.audioFeatures;
    }

    function discNumber(track: TrackData): number {
        return track.discNumber ?? 1;
    }

    function normalizeArtistName(value: string | null | undefined): string {
        const normalized = (value ?? '').trim().toLowerCase();
        if (isVariousArtistsName(normalized)) {
            return VARIOUS_ARTISTS_LABEL.toLowerCase();
        }
        return normalized;
    }

    function getTrackArtists(track: TrackData): TrackArtistChip[] {
        return track.artists.map((artist) => ({ id: artist.id ?? undefined, name: artist.title }));
    }

    /** getTrackArtists chips reshaped to TrackTitleLine's {id?, title} contract. */
    function getTitleArtists(track: TrackData): { id?: string; title: string }[] {
        return getTrackArtists(track).map((artist) => ({ id: artist.id, title: artist.name }));
    }

    function getTrackArtistId(track: TrackData): string | undefined {
        return getTrackArtists(track).find((artist) => artist.id)?.id;
    }

    function openTrackArtist(artistId: string | undefined): void {
        if (!artistId) return;
        openArtistModal(artistId, { sonicEnabled });
    }

    function trackArtistDiffersFromAlbum(track: TrackData): boolean {
        const trackArtists = getTrackArtists(track);
        if (trackArtists.length === 0) return false;
        const albumArtist = album?.artist.title;
        if (!albumArtist) return false;
        return trackArtists.some(
            (artist) => normalizeArtistName(artist.name) !== normalizeArtistName(albumArtist),
        );
    }

    let { albumId, modalId, sonicEnabled = false, highlightTrackId, onAdd }: Props = $props();

    /** DOM id for a tracklist row — used by the highlight autoscroll. */
    function trackRowId(trackId: string): string {
        return `${modalId}-track-${trackId}`;
    }

    /**
     * Scroll the highlighted track's row into view (centered) once the
     * tracklist has rendered. Scrolls ONLY the modal card element —
     * scrollIntoView would also scroll the ModalContainer positioner
     * (overflow: auto), which shifted the whole modal up and showed a
     * second scrollbar next to the card's own.
     */
    async function scrollToHighlightedTrack(): Promise<void> {
        if (!highlightTrackId) return;
        await tick();
        const card = document.getElementById(modalId);
        const row = document.getElementById(trackRowId(highlightTrackId));
        if (!card || !row) return;
        const delta =
            row.getBoundingClientRect().top -
            card.getBoundingClientRect().top -
            (card.clientHeight / 2 - row.clientHeight / 2);
        if (Math.abs(delta) < 1) return;
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        card.scrollTo({
            top: card.scrollTop + delta,
            behavior: reduced ? 'auto' : 'smooth',
        });
    }

    let loading = $state(true);
    let error = $state<string | null>(null);
    let album = $state<AlbumData | null>(null);
    let failedCoverSrc = $state<string | null>(null);

    let tracks: TrackData[] = $state([]);
    let similarAlbums: SimilarAlbum[] = $state([]);
    let similarAlbumsLoading = $state(false);
    let seriesAlbums: AlbumSeriesEntry[] = $state([]);
    let seriesList: HTMLElement | undefined = $state();

    // Centre the open album inside the (height-capped) series list. Scrolls the
    // list only — scrollIntoView would also scroll the modal itself.
    async function scrollSeriesToCurrent(): Promise<void> {
        await tick();
        const list = seriesList;
        const row = list?.querySelector<HTMLElement>('[aria-current="true"]');
        if (!list || !row) return;
        list.scrollTop = row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2;
    }

    interface DiscGroup {
        discNumber: number;
        tracks: TrackData[];
    }

    let sortedTracks = $derived(
        [...tracks].sort((a, b) => {
            const discA = discNumber(a);
            const discB = discNumber(b);
            if (discA !== discB) return discA - discB;
            return (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999);
        }),
    );

    // Custom poster wins; VA fallback only when none is set.
    let isVaAlbum = $derived(isVariousArtistsName(album?.artist.title));
    const coverSrc = $derived(
        album
            ? musicCoverUrl({
                  id: album.id,
                  size: 'medium',
                  hasOwnPoster: album.images.primary?.href != null,
                  variousArtists: isVaAlbum,
              })
            : null,
    );
    const coverVisible = $derived(coverSrc !== null && failedCoverSrc !== coverSrc);

    let discGroups: DiscGroup[] = $derived.by(() => {
        const discNumbers = new Set(sortedTracks.map((t) => discNumber(t)));
        if (discNumbers.size <= 1) return [];

        const groups: Array<{ discNumber: number; tracks: TrackData[] }> = [];
        for (const track of sortedTracks) {
            const disc = discNumber(track);
            let group = groups.find((entry) => entry.discNumber === disc);
            if (!group) {
                group = { discNumber: disc, tracks: [] };
                groups.push(group);
            }
            group.tracks.push(track);
        }
        return groups.sort((a, b) => a.discNumber - b.discNumber);
    });

    let isMultiDisc = $derived(discGroups.length > 0);

    // Track filter. A find-and-jump aid only: it hides non-matching rows but
    // never changes what Play All / Shuffle / Add All / "play from here" queue —
    // those always act on the full album, so every visible row keeps resolving
    // its index back into `sortedTracks` (see playSingleTrack et al.).
    const TRACK_FILTER_MIN_TRACKS = 15;
    let trackFilter = $state('');
    let normalizedTrackFilter = $derived(trackFilter.trim().toLowerCase());
    let trackFilterActive = $derived(normalizedTrackFilter.length > 0);
    let showTrackFilter = $derived(tracks.length >= TRACK_FILTER_MIN_TRACKS);

    function trackMatchesFilter(track: TrackData): boolean {
        if (!trackFilterActive) return true;
        const haystack = [track.title, ...getTrackArtists(track).map((artist) => artist.name)]
            .join(' ')
            .toLowerCase();
        return haystack.includes(normalizedTrackFilter);
    }

    // Display-only projections. Indices for playback are always resolved via
    // `sortedTracks.indexOf(track)`, so filtering these never desyncs playback.
    let visibleTracks = $derived(
        trackFilterActive ? sortedTracks.filter(trackMatchesFilter) : sortedTracks,
    );
    let visibleDiscGroups = $derived(
        trackFilterActive
            ? discGroups
                  .map((group) => ({
                      discNumber: group.discNumber,
                      tracks: group.tracks.filter(trackMatchesFilter),
                  }))
                  .filter((group) => group.tracks.length > 0)
            : discGroups,
    );
    let hasVisibleTracks = $derived(visibleTracks.length > 0);

    function clearTrackFilter(): void {
        trackFilter = '';
    }

    function handleTrackFilterKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape' && trackFilter.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            clearTrackFilter();
        }
    }

    onMount(async () => {
        try {
            const { data, error: fetchError } = await getAlbum(albumId);
            if (fetchError || !data) {
                throw new Error('Failed to fetch album');
            }
            album = data;
            tracks = data.tracks ?? [];
            void scrollToHighlightedTrack();
            if (data.title) {
                modals.updateProps(modalId, {
                    albumTitle: data.title,
                });
            }
        } catch (err) {
            console.error('Failed to load album:', err);
            error = m.album_load_error();
        } finally {
            loading = false;
        }

        // Series ("Future Trance Vol. 61 … 70"): supplementary, never blocks.
        void getAlbumSeries(albumId)
            .then(({ data }) => {
                seriesAlbums = data?.albums ?? [];
                void scrollSeriesToCurrent();
            })
            .catch(() => {});

        // Lazily load sonic-similar albums after the main content is ready.
        if (sonicEnabled) {
            similarAlbumsLoading = true;
            try {
                const { data: simData } = await getSimilarAlbums(albumId, 10);
                if (simData) {
                    similarAlbums = simData.items;
                }
            } catch {
                // Non-fatal: similar albums are supplementary content.
            } finally {
                similarAlbumsLoading = false;
            }
        }
    });

    // Keyed on the ALBUM once the track has no cover of its own: both ids
    // inherit to the same artwork, but the album id is the one already warm in
    // the image cache from the hero above.
    function resolveTrackCoverArt(track: TrackData): string | undefined {
        return track.images.primary?.variants?.thumb;
    }

    function trackLoudnessDb(track: TrackData): number | undefined {
        const loudness = trackEssentia(track)?.loudnessLufs;
        return typeof loudness === 'number' && Number.isFinite(loudness) ? loudness : undefined;
    }

    function toMusicTrack(track: TrackData): MusicTrack {
        return track;
    }

    async function playAlbumSelection(queue: MusicTrack[]): Promise<void> {
        if (!queue.length) return;
        await musicPlayerStore.enqueueFromBrew(queue, true, {
            type: 'album',
            name: album?.title ?? 'Unknown Album',
            trackCount: queue.length - 1,
            sessionId: `album-${album?.id ?? 'unknown'}-${Date.now()}`,
        });
    }

    async function playAll(): Promise<void> {
        await playAlbumSelection(sortedTracks.map(toMusicTrack));
    }

    async function playShuffle(): Promise<void> {
        await playAlbumSelection(shuffledTracks(sortedTracks.map(toMusicTrack)));
    }

    async function playSingleTrack(index: number): Promise<void> {
        const tracks = sortedTracks.map(toMusicTrack);
        const track = tracks[index];
        if (!track) return;
        await musicPlayerStore.startPlayback(track);
    }

    async function playAlbumFromTrack(index: number): Promise<void> {
        await playAlbumSelection(sortedTracks.slice(index).map(toMusicTrack));
    }

    function handleTrackTitleKeydown(event: KeyboardEvent, index: number): void {
        // Nested artist-link buttons (TrackTitleLine) handle their own activation;
        // preventDefault here would cancel their native click synthesis on Enter/Space.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        playSingleTrack(index);
    }

    function addTrackToPlaylist(track: TrackData): void {
        if (!onAdd) return;
        onAdd({
            externalIds: { internal: track.id },
            mediaType: 'track',
            title: track.title,
            posterPath: resolveTrackCoverArt(track),
        });
    }

    function addAllToPlaylist(): void {
        for (const track of sortedTracks) {
            addTrackToPlaylist(track);
        }
    }

    function openArtist(): void {
        if (!album?.artist.id) return;
        openArtistModal(album.artist.id, { sonicEnabled });
    }

    function formatDuration(seconds: number | null | undefined): string {
        if (!seconds) return '';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function formatTotalDuration(seconds: number | null | undefined): string {
        if (!seconds) return '';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0) return `${h}h ${m}m`;
        return `${m} min`;
    }

    let contextMenuState = $state<{
        x: number;
        y: number;
        track: TrackData;
        index: number;
    } | null>(null);

    function handleTrackContextMenu(e: MouseEvent, track: TrackData, index: number): void {
        e.preventDefault();
        e.stopPropagation();
        contextMenuState = { x: e.clientX, y: e.clientY, track, index };
    }

    let similarAlbumContextMenu = $state<{
        x: number;
        y: number;
        album: SimilarAlbum;
    } | null>(null);

    function handleSimilarAlbumContextMenu(e: MouseEvent, sim: SimilarAlbum): void {
        e.preventDefault();
        e.stopPropagation();
        similarAlbumContextMenu = { x: e.clientX, y: e.clientY, album: sim };
    }

    function buildSimilarAlbumMenuItems(sim: SimilarAlbum): ContextMenuEntry[] {
        const items: ContextMenuEntry[] = [
            { label: 'Open album', onSelect: () => openAlbumModal(sim.id) },
        ];
        const artistId = sim.artist.id;
        if (artistId) {
            items.push({
                label: m.album_go_to_artist(),
                onSelect: () => openArtistModal(artistId, { sonicEnabled }),
            });
        }
        return items;
    }

    function buildTrackMenuItems(track: TrackData, index: number): ContextMenuEntry[] {
        const musicTrack = toMusicTrack(track);
        const artistId = getTrackArtistId(track);
        const items: ContextMenuEntry[] = [
            {
                label: m.card_play(),
                onSelect: () => void playSingleTrack(index),
            },
            {
                label: m.album_play_from_here(),
                onSelect: () => void playAlbumFromTrack(index),
            },
            {
                label: m.album_play_next(),
                onSelect: () => musicPlayerStore.addToQueueFront(musicTrack),
            },
        ];
        if (artistId) {
            items.push({
                label: m.album_go_to_artist(),
                onSelect: () => openTrackArtist(artistId),
            });
        }
        // `onAdd` is the playlist-page "pick tracks for THIS playlist" callback.
        // The flyout is the general path and is offered either way.
        if (onAdd) {
            items.push({
                label: m.album_add_to_this_playlist(),
                onSelect: () => addTrackToPlaylist(track),
            });
        }
        items.push(
            addTrackToPlaylistEntry({
                id: musicTrack.id,
                title: musicTrack.title,
                artists: musicTrack.artists,
                images: musicTrack.images,
            }),
        );
        return items;
    }

    async function handleClose(): Promise<void> {
        // X / swipe-down = "Done": leave the whole trail. Escape/backdrop still
        // pop a single trail step (owned by ModalContainer).
        await modals.closeAll();
    }
</script>

<div
    id={modalId}
    class="card p-4 sm:p-6 shadow-xl max-w-[700px] w-screen sm:w-[90vw] h-full sm:h-auto sm:max-h-[90vh] overflow-y-auto relative"
    use:swipeToClose={{ onClose: handleClose }}>
    <!-- Mobile grab handle (swipe down to close) -->
    <div class="mx-auto mb-4 h-1 w-10 rounded-full bg-surface-500/60 sm:hidden" aria-hidden="true">
    </div>

    {#if loading}
        <div class="flex flex-col items-center justify-center py-12">
            <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
        </div>
    {:else if error || !album}
        <div class="text-center py-12">
            <p class="text-error-500">{error ?? m.album_not_found()}</p>
            <button class="btn variant-ghost-surface mt-4" onclick={handleClose}
                >{m.btn_close()}</button>
        </div>
    {:else}
        <!-- Hero -->
        <div class="flex flex-col sm:flex-row gap-6 mb-6">
            <!-- Square album art -->
            <div
                class="w-48 aspect-square flex-shrink-0 overflow-hidden rounded-xl bg-surface-800 shadow-2xl mx-auto sm:mx-0">
                <MusicCover
                    src={coverSrc}
                    onImageError={(src) => (failedCoverSrc = src)}
                    alt={album.title}
                    size="medium"
                    hasOwnPoster={album.images.primary?.href != null}
                    variousArtists={isVaAlbum}
                    glyphClass="text-6xl"
                    loading="eager" />
            </div>

            <!-- Album info -->
            <div class="flex flex-col justify-end gap-2 min-w-0">
                <p class="text-xs font-medium uppercase tracking-wide text-surface-400">
                    {m.media_album()}
                </p>
                <h2 class="text-2xl sm:text-3xl font-bold text-white truncate">
                    {album.title}
                </h2>

                <div class="flex flex-wrap items-center gap-2 text-sm text-surface-300">
                    {#if album.artist.id}
                        <button
                            class="font-medium text-primary-400 hover:text-primary-300 transition-colors"
                            onclick={openArtist}>
                            {album.artist.title ?? m.music_unknown_artist()}
                        </button>
                    {:else}
                        <span class="font-medium text-white">
                            {album.artist.title ?? m.music_unknown_artist()}
                        </span>
                    {/if}
                    {#if album.year}
                        <span class="text-surface-500">·</span>
                        <span>{album.year}</span>
                    {/if}
                    <span class="text-surface-500">·</span>
                    <span>{sortedTracks.length} tracks</span>
                    {#if album.durationMs}
                        <span class="text-surface-500">·</span>
                        <span class="text-surface-400">
                            {formatTotalDuration(
                                album.durationMs == null ? null : album.durationMs / 1000,
                            )}
                        </span>
                    {/if}
                </div>
                {#if album.popularity}
                    <!-- The detail endpoint attaches the ARTIST's popularity here
                         (albums/[id]/+server.ts: popularity: artistPopularity) —
                         label it as such so "1.8M listeners" doesn't read as an
                         album-level stat. -->
                    <PopularityBadge
                        popularity={album.popularity}
                        variant="artist"
                        labelOverrides={{
                            listeners: m.music_popularity_artist_listeners(),
                            plays: m.music_popularity_artist_plays(),
                        }} />
                {/if}

                <DiscogsCredit sourceUrls={[coverVisible ? album.discogsAttribution?.poster : undefined]} />
                {#if album.overview}
                    <p class="text-sm text-surface-400 line-clamp-3">
                        {album.overview}
                    </p>
                    <DiscogsCredit sourceUrls={[album.discogsAttribution?.overview]} />
                {/if}
            </div>
        </div>

        <!-- Actions row -->
        <div class="flex flex-wrap gap-3 mb-6">
            <button
                class="btn variant-filled-primary"
                disabled={tracks.length === 0}
                onclick={() => void playAll()}>
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                </svg>
                {m.album_play_all()}
            </button>
            <button
                class="btn variant-soft-surface"
                disabled={tracks.length === 0}
                onclick={() => void playShuffle()}>
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M16 3h5m0 0v5m0-5l-6 6M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-1M16 21h5m0 0v-5m0 5l-6-6" />
                </svg>
                {m.album_shuffle()}
            </button>
            {#if onAdd}
                <button
                    class="btn variant-soft-primary"
                    disabled={tracks.length === 0}
                    onclick={addAllToPlaylist}>
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 4v16m8-8H4" />
                    </svg>
                    {m.album_add_all()}
                </button>
            {/if}
        </div>

        <!-- Track list -->
        {#if tracks.length > 0}
            <div>
                {#if showTrackFilter}
                    <div class="relative mb-3">
                        <svg
                            class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-surface-500"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
                        </svg>
                        <input
                            type="text"
                            bind:value={trackFilter}
                            onkeydown={handleTrackFilterKeydown}
                            placeholder={m.album_search_placeholder()}
                            class="w-full rounded-lg border border-surface-700 bg-surface-800/60 py-2 pl-9 pr-24 text-sm text-white placeholder:text-surface-500 focus:border-primary-500 focus:outline-none" />
                        <div
                            class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-2">
                            {#if trackFilterActive}
                                <span class="text-xs tabular-nums text-surface-500">
                                    {m.album_search_count({
                                        shown: visibleTracks.length,
                                        total: sortedTracks.length,
                                    })}
                                </span>
                                <button
                                    class="rounded p-0.5 text-surface-500 transition-colors hover:text-white"
                                    onclick={clearTrackFilter}
                                    aria-label={m.album_search_clear()}>
                                    <svg
                                        class="h-4 w-4"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24">
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2"
                                            d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            {/if}
                        </div>
                    </div>
                {/if}

                <div
                    class="mb-2 grid gap-4 border-b border-surface-700 pb-2 text-xs font-medium uppercase tracking-wide text-surface-500"
                    class:grid-cols-[2rem_1fr_auto_auto]={onAdd}
                    class:grid-cols-[2rem_1fr_auto]={!onAdd}>
                    <span class="text-center">#</span>
                    <span>{m.album_track_title()}</span>
                    <span>{m.album_track_duration()}</span>
                    {#if onAdd}<span></span>{/if}
                </div>

                {#if trackFilterActive && !hasVisibleTracks}
                    <p class="py-6 text-center text-sm text-surface-500">
                        {m.album_search_no_matches({ query: trackFilter.trim() })}
                    </p>
                {/if}

                {#if isMultiDisc}
                    {#each visibleDiscGroups as group (group.discNumber)}
                        <div class="flex items-center gap-3 mt-4 mb-2 first:mt-0">
                            <span
                                class="text-xs font-medium uppercase tracking-wide text-surface-500">
                                {m.album_disc({ number: group.discNumber })}
                            </span>
                            <div class="flex-1 border-b border-surface-700/50"></div>
                        </div>

                        {#each group.tracks as track (track.id)}
                            {@const flatIndex = sortedTracks.indexOf(track)}
                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                            <div
                                id={trackRowId(track.id)}
                                class="group grid items-center gap-4 rounded-lg py-2 transition-colors hover:bg-surface-800/60"
                                class:grid-cols-[2rem_1fr_auto_auto]={onAdd}
                                class:grid-cols-[2rem_1fr_auto]={!onAdd}
                                class:highlighted-track={track.id === highlightTrackId}
                                oncontextmenu={(e) => handleTrackContextMenu(e, track, flatIndex)}>
                                <!-- Track number / play icon -->
                                <button
                                    class="flex items-center justify-center w-full h-full"
                                    onclick={() => void playSingleTrack(flatIndex)}
                                    aria-label={m.album_play_track_aria()}>
                                    <span
                                        class="text-center text-sm text-surface-500 group-hover:hidden">
                                        {track.trackNumber ?? flatIndex + 1}
                                    </span>
                                    <span
                                        class="hidden text-center text-sm text-primary-400 group-hover:block">
                                        ▶
                                    </span>
                                </button>

                                <!-- Title + BPM + Featuring -->
                                <div
                                    role="button"
                                    tabindex="0"
                                    class="min-w-0 text-left"
                                    onclick={() => void playSingleTrack(flatIndex)}
                                    onkeydown={(event) =>
                                        handleTrackTitleKeydown(event, flatIndex)}>
                                    <p class="truncate text-sm font-medium text-white">
                                        <TrackTitleLine
                                            title={track.title}
                                            artists={getTitleArtists(track)}
                                            remixerArtists={track.remixerArtists} />
                                    </p>
                                    {#if trackArtistDiffersFromAlbum(track) || ($musicPlayerStore.showBpm && typeof trackEssentia(track)?.bpm === 'number') || ($musicPlayerStore.showLoudnessDb && trackLoudnessDb(track) !== undefined)}
                                        <div class="mt-0.5 inline-flex flex-wrap gap-1">
                                            {#if trackArtistDiffersFromAlbum(track)}
                                                {#each getTrackArtists(track) as artist, artistIdx ((artist.id ?? artist.name ?? 'artist') + '-' + artistIdx)}
                                                    {#if artist.id}
                                                        <MusicEntityHoverCard
                                                            kind="artist"
                                                            id={artist.id}
                                                            class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-300 transition-colors hover:bg-surface-600 hover:text-primary-300"
                                                            onclick={(event) => {
                                                                event.stopPropagation();
                                                                openTrackArtist(artist.id);
                                                            }}>
                                                            {artist.name}
                                                        </MusicEntityHoverCard>
                                                    {:else}
                                                        <span
                                                            class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-300">
                                                            {artist.name}
                                                        </span>
                                                    {/if}
                                                {/each}
                                            {/if}
                                            {#if $musicPlayerStore.showBpm && typeof trackEssentia(track)?.bpm === 'number'}
                                                <span
                                                    class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-400">
                                                    {Math.round(
                                                        trackEssentia(track)!.bpm as number,
                                                    )} BPM
                                                </span>
                                            {/if}
                                            {#if $musicPlayerStore.showLoudnessDb && trackLoudnessDb(track) !== undefined}
                                                <span
                                                    class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-400">
                                                    {trackLoudnessDb(track)!.toFixed(1)} dB
                                                </span>
                                            {/if}
                                        </div>
                                    {/if}
                                </div>

                                <!-- Duration -->
                                <div class="flex items-center gap-1.5">
                                    {#if track.popularity}
                                        <PopularityBadge
                                            popularity={track.popularity}
                                            variant="track" />
                                    {/if}
                                    <span class="text-sm tabular-nums text-surface-400">
                                        {formatDuration(
                                            track.durationMs == null
                                                ? null
                                                : track.durationMs / 1000,
                                        )}
                                    </span>
                                    <Tooltip text={m.album_play_from_track()} position="top">
                                        <button
                                            class="rounded p-0.5 text-surface-500 opacity-0 transition-colors hover:text-primary-400 group-hover:opacity-100"
                                            onclick={(e) => {
                                                e.stopPropagation();
                                                void playAlbumFromTrack(flatIndex);
                                            }}
                                            aria-label={m.album_play_from_track()}>
                                            <svg
                                                class="h-3.5 w-3.5"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24">
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    stroke-width="2"
                                                    d="M4 6h16M4 10h16M4 14h8m-8 4h5" />
                                            </svg>
                                        </button>
                                    </Tooltip>
                                </div>

                                <!-- Add button (only if onAdd provided) -->
                                {#if onAdd}
                                    <button
                                        class="p-1.5 rounded-full text-surface-400 hover:text-primary-400 hover:bg-surface-700 transition-colors opacity-0 group-hover:opacity-100"
                                        onclick={() => addTrackToPlaylist(track)}
                                        aria-label={m.playlist_add_to_playlist()}>
                                        <svg
                                            class="w-4 h-4"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24">
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                stroke-width="2"
                                                d="M12 4v16m8-8H4" />
                                        </svg>
                                    </button>
                                {/if}
                            </div>
                        {/each}
                    {/each}
                {:else}
                    {#each visibleTracks as track (track.id)}
                        {@const i = sortedTracks.indexOf(track)}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                            id={trackRowId(track.id)}
                            class="group grid items-center gap-4 rounded-lg py-2 transition-colors hover:bg-surface-800/60"
                            class:grid-cols-[2rem_1fr_auto_auto]={onAdd}
                            class:grid-cols-[2rem_1fr_auto]={!onAdd}
                            class:highlighted-track={track.id === highlightTrackId}
                            oncontextmenu={(e) => handleTrackContextMenu(e, track, i)}>
                            <!-- Track number / play icon -->
                            <button
                                class="flex items-center justify-center w-full h-full"
                                onclick={() => void playSingleTrack(i)}
                                aria-label={m.album_play_track_aria()}>
                                <span
                                    class="text-center text-sm text-surface-500 group-hover:hidden">
                                    {track.trackNumber ?? i + 1}
                                </span>
                                <span
                                    class="hidden text-center text-sm text-primary-400 group-hover:block">
                                    ▶
                                </span>
                            </button>

                            <!-- Title + BPM + Featuring -->
                            <div
                                role="button"
                                tabindex="0"
                                class="min-w-0 text-left"
                                onclick={() => void playSingleTrack(i)}
                                onkeydown={(event) => handleTrackTitleKeydown(event, i)}>
                                <p class="truncate text-sm font-medium text-white">
                                    <TrackTitleLine
                                        title={track.title}
                                        artists={getTitleArtists(track)}
                                        remixerArtists={track.remixerArtists} />
                                </p>
                                {#if trackArtistDiffersFromAlbum(track) || ($musicPlayerStore.showBpm && typeof trackEssentia(track)?.bpm === 'number') || ($musicPlayerStore.showLoudnessDb && trackLoudnessDb(track) !== undefined)}
                                    <div class="mt-0.5 inline-flex flex-wrap gap-1">
                                        {#if trackArtistDiffersFromAlbum(track)}
                                            {#each getTrackArtists(track) as artist, artistIdx ((artist.id ?? artist.name ?? 'artist') + '-' + artistIdx)}
                                                {#if artist.id}
                                                    <button
                                                        class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-300 transition-colors hover:bg-surface-600 hover:text-primary-300"
                                                        onclick={(event) => {
                                                            event.stopPropagation();
                                                            openTrackArtist(artist.id);
                                                        }}>
                                                        {artist.name}
                                                    </button>
                                                {:else}
                                                    <span
                                                        class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-300">
                                                        {artist.name}
                                                    </span>
                                                {/if}
                                            {/each}
                                        {/if}
                                        {#if $musicPlayerStore.showBpm && typeof trackEssentia(track)?.bpm === 'number'}
                                            <span
                                                class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-400">
                                                {Math.round(trackEssentia(track)!.bpm as number)} BPM
                                            </span>
                                        {/if}
                                        {#if $musicPlayerStore.showLoudnessDb && trackLoudnessDb(track) !== undefined}
                                            <span
                                                class="rounded bg-surface-700 px-1.5 py-0.5 text-xs text-surface-400">
                                                {trackLoudnessDb(track)!.toFixed(1)} dB
                                            </span>
                                        {/if}
                                    </div>
                                {/if}
                            </div>

                            <!-- Duration -->
                            <div class="flex items-center gap-1.5">
                                {#if track.popularity}
                                    <PopularityBadge
                                        popularity={track.popularity}
                                        variant="track" />
                                {/if}
                                <span class="text-sm tabular-nums text-surface-400">
                                    {formatDuration(
                                        track.durationMs == null ? null : track.durationMs / 1000,
                                    )}
                                </span>
                                <Tooltip text={m.album_play_from_track()} position="top">
                                    <button
                                        class="rounded p-0.5 text-surface-500 opacity-0 transition-colors hover:text-primary-400 group-hover:opacity-100"
                                        onclick={(e) => {
                                            e.stopPropagation();
                                            void playAlbumFromTrack(i);
                                        }}
                                        aria-label={m.album_play_from_track()}>
                                        <svg
                                            class="h-3.5 w-3.5"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24">
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                stroke-width="2"
                                                d="M4 6h16M4 10h16M4 14h8m-8 4h5" />
                                        </svg>
                                    </button>
                                </Tooltip>
                            </div>

                            <!-- Add button (only if onAdd provided) -->
                            {#if onAdd}
                                <button
                                    class="p-1.5 rounded-full text-surface-400 hover:text-primary-400 hover:bg-surface-700 transition-colors opacity-0 group-hover:opacity-100"
                                    onclick={() => addTrackToPlaylist(track)}
                                    aria-label={m.playlist_add_to_playlist()}>
                                    <svg
                                        class="w-4 h-4"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24">
                                        <path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2"
                                            d="M12 4v16m8-8H4" />
                                    </svg>
                                </button>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>
        {:else}
            <p class="text-center text-surface-400 py-8">
                {m.album_no_tracks()}
            </p>
        {/if}

        <!-- Series (other volumes of a title-detected album series) -->
        {#if seriesAlbums.length > 1}
            <section class="mt-8">
                <h3 class="mb-2 text-sm font-semibold uppercase tracking-wide text-surface-300">
                    {m.music_album_series_section({ count: seriesAlbums.length })}
                </h3>
                <ul
                    bind:this={seriesList}
                    class="relative max-h-72 overflow-y-auto rounded-lg bg-surface-900/40 scrollbar-thin">
                    {#each seriesAlbums as entry (entry.id)}
                        {@const isCurrent = entry.id === albumId}
                        <li>
                            <button
                                class="flex w-full items-center gap-3 px-2 py-1.5 text-left transition-colors {isCurrent
                                    ? 'bg-primary-500/15'
                                    : 'hover:bg-surface-800/60'}"
                                aria-current={isCurrent ? 'true' : undefined}
                                disabled={isCurrent}
                                onclick={() => openAlbumModal(entry.id, { sonicEnabled })}>
                                <img
                                    src={entry.images.primary?.variants?.thumb}
                                    alt=""
                                    class="h-10 w-10 flex-shrink-0 rounded object-cover bg-surface-700"
                                    loading="lazy" />
                                <span class="min-w-0 flex-1">
                                    <span
                                        class="block truncate text-sm {isCurrent
                                            ? 'font-semibold text-primary-300'
                                            : 'text-white'}">
                                        {entry.title}
                                    </span>
                                    <span class="block text-xs text-surface-500">
                                        {[
                                            isCurrent ? m.music_album_series_current() : null,
                                            entry.year,
                                        ]
                                            .filter((part) => part != null)
                                            .join(' · ')}
                                    </span>
                                </span>
                            </button>
                        </li>
                    {/each}
                </ul>
            </section>
        {/if}

        <!-- Sounds Like (sonic-similar albums) -->
        {#if sonicEnabled}
            <section class="mt-8">
                <h3 class="mb-2 text-sm font-semibold uppercase tracking-wide text-surface-300">
                    {m.music_similar_albums_section()}
                </h3>
                {#if similarAlbumsLoading}
                    <div class="flex items-center gap-2 py-2 text-xs text-surface-500">
                        <span class="loading-spinner loading-spinner-sm loading-spinner-primary"
                        ></span>
                        <span>Finding similar albums…</span>
                    </div>
                {:else if similarAlbums.length === 0}
                    <p class="text-xs text-surface-500">{m.music_sounds_like_no_data()}</p>
                {:else}
                    <div class="flex gap-3 overflow-x-auto pb-2 snap-x scrollbar-thin">
                        {#each similarAlbums as sim (sim.id)}
                            <button
                                class="group flex flex-col gap-2 rounded-lg p-2 text-left transition-colors hover:bg-surface-800/50 flex-shrink-0 w-36 snap-start"
                                onclick={() => openAlbumModal(sim.id)}
                                oncontextmenu={(e) => handleSimilarAlbumContextMenu(e, sim)}>
                                <div
                                    class="aspect-square w-full overflow-hidden rounded-lg bg-surface-800">
                                    {#if sim.images.primary?.variants?.thumb}
                                        <img
                                            src={sim.images.primary?.variants?.thumb}
                                            alt={sim.title}
                                            class="h-full w-full object-cover transition-transform group-hover:scale-105"
                                            loading="lazy" />
                                    {:else}
                                        <div
                                            class="flex h-full w-full items-center justify-center bg-surface-700">
                                            <span class="text-3xl text-surface-500">♪</span>
                                        </div>
                                    {/if}
                                </div>
                                <div class="min-w-0">
                                    <p class="truncate text-sm font-medium text-white">
                                        {sim.title}
                                    </p>
                                    {#if sim.artist.title}
                                        <p class="truncate text-xs text-surface-400">
                                            {sim.artist.title}
                                        </p>
                                    {/if}
                                    {#if sim.year}
                                        <p class="text-xs text-surface-500">{sim.year}</p>
                                    {/if}
                                </div>
                            </button>
                        {/each}
                    </div>
                {/if}
            </section>
        {/if}

        <!-- Footer -->
        <footer class="mt-6 flex justify-end">
            <button class="btn variant-ghost-surface" onclick={handleClose}>{m.btn_close()}</button>
        </footer>
    {/if}
</div>

{#if contextMenuState}
    <ContextMenu
        x={contextMenuState.x}
        y={contextMenuState.y}
        title={contextMenuState.track.title}
        subtitle={album?.title ?? ''}
        items={buildTrackMenuItems(contextMenuState.track, contextMenuState.index)}
        onClose={() => (contextMenuState = null)} />
{/if}

{#if similarAlbumContextMenu}
    <ContextMenu
        x={similarAlbumContextMenu.x}
        y={similarAlbumContextMenu.y}
        title={similarAlbumContextMenu.album.title}
        subtitle={similarAlbumContextMenu.album.artist.title ?? ''}
        items={buildSimilarAlbumMenuItems(similarAlbumContextMenu.album)}
        onClose={() => (similarAlbumContextMenu = null)} />
{/if}

<style>
    /* Row the modal was opened FOR (highlightTrackId) — a persistent tint +
       inset ring so the autoscroll target is obvious without being loud. */
    .highlighted-track {
        /* --color-primary-500 is a hex value; the space-separated RGB triplet
           variant is required inside rgb(... / alpha). */
        background-color: rgb(var(--color-primary-500-rgb) / 0.1);
        box-shadow: inset 0 0 0 1px rgb(var(--color-primary-500-rgb) / 0.4);
    }
</style>
