<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import DiscogsCredit from '$lib/components/music/DiscogsCredit.svelte';
    import { artistEnrichmentDisplay } from '$lib/shared/music-provenance';
    import { onMount } from 'svelte';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { modals } from '$lib/stores/modal.store';
    import * as m from '$lib/paraglide/messages';
    import { openAlbumModal, openArtistModal } from '$lib/utils/modal-utils';
    import { shuffledTracks } from '$lib/utils/music-mix';
    import { sentencePreview } from '$lib/utils/sentence-preview';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import type { MusicTrack } from '$lib/schemas/music';
    import type {
        MusicArtistRow,
        MusicAlbumSummary,
        ArtistTrackRow,
        SimilarArtist,
    } from '$lib/schemas/api-music-responses';
    import { getArtist, getSimilarArtists } from '$lib/api/music';
    import PopularityBadge from '$lib/components/music/PopularityBadge.svelte';
    import TrackTitleLine from '$lib/components/music/TrackTitleLine.svelte';
    import { swipeToClose } from '$lib/utils/swipe-to-close';

    import MusicCover from '$lib/components/music/MusicCover.svelte';
    import { isVariousArtistsName, VARIOUS_ARTISTS_COVER_URL } from '$lib/shared/various-artists';
    import { Icon, XMark } from 'svelte-hero-icons';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';

    interface Props {
        artistId: string;
        modalId: string;
        sonicEnabled?: boolean;
    }

    type ArtistData = MusicArtistRow;
    type AlbumData = MusicAlbumSummary;
    type TrackData = ArtistTrackRow;

    type TabId = 'overview' | 'albums' | 'singles' | 'songs';

    let { artistId, modalId, sonicEnabled = false }: Props = $props();

    let loading = $state(true);
    let error = $state<string | null>(null);
    let artist = $state<ArtistData | null>(null);
    let albums: AlbumData[] = $state([]);
    let tracks: TrackData[] = $state([]);
    let activeTab: TabId = $state('overview');

    // "Various Artists" is a synthetic compilation artist with no real photo —
    // show the shared placeholder cover instead of the generic note glyph.
    // Prefer the server-computed flag (set at ingest); fall back to a
    // name-match for older responses that don't carry it yet.
    let isVa = $derived(artist?.isVariousArtists ?? isVariousArtistsName(artist?.title));
    let similarArtists: SimilarArtist[] = $state([]);
    let similarArtistsLoading = $state(false);
    let songSearch = $state('');
    let songSearchInput = $state<HTMLInputElement | null>(null);

    function isTouchDevice(): boolean {
        if (typeof window === 'undefined') return false;
        return (
            'ontouchstart' in window ||
            (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
        );
    }

    // Autofocus the songs search on desktop when the tab becomes active.
    $effect(() => {
        if (activeTab !== 'songs') return;
        if (isTouchDevice()) return;
        const el = songSearchInput;
        if (!el) return;
        queueMicrotask(() => el.focus());
    });

    // Split albums vs singles by track count (4+ = album, 1-3 = single)
    let fullAlbums = $derived(albums.filter((a) => a.trackCount >= 4));
    let singles = $derived(albums.filter((a) => a.trackCount < 4));

    // Pick the most popular track per album: prefer lower rankInArtist,
    // fall back to higher listeners.
    function isBetterTrack(candidate: TrackData, current: TrackData): boolean {
        const candRank = candidate.popularity?.rankInArtist ?? null;
        const currRank = current.popularity?.rankInArtist ?? null;
        if (candRank !== null && currRank !== null) return candRank < currRank;
        if (candRank !== null && currRank === null) return true;
        if (candRank === null && currRank !== null) return false;
        const candListeners = candidate.popularity?.listeners ?? 0;
        const currListeners = current.popularity?.listeners ?? 0;
        return (candListeners ?? 0) > (currListeners ?? 0);
    }

    let albumTopTracks = $derived.by(() => {
        const map = new SvelteMap<string, TrackData>();
        for (const t of tracks) {
            if (!t.popularity) continue;
            const existing = map.get(t.album?.id ?? t.id);
            if (!existing || isBetterTrack(t, existing)) {
                map.set(t.album?.id ?? t.id, t);
            }
        }
        return map;
    });

    // Suggested tracks for the Overview tab — merges user-played with Last.fm
    // top-ranked. Dedup by track id, cap at 6. User plays first (most recent),
    // then popularity-ranked picks fill the remaining slots.
    const SUGGESTED_LIMIT = 6;
    let suggestedTracks = $derived.by((): TrackData[] => {
        if (tracks.length === 0) return [];

        const byRank = tracks
            .filter((t) => t.popularity?.rankInArtist != null)
            .sort(
                (a, b) =>
                    (a.popularity?.rankInArtist ?? Infinity) -
                    (b.popularity?.rankInArtist ?? Infinity),
            );

        const seen = new SvelteSet<string>();
        const out: TrackData[] = [];
        for (const t of byRank) {
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            out.push(t);
            if (out.length >= SUGGESTED_LIMIT) break;
        }
        return out;
    });

    // Top tracks for the Overview tracks carousel — popularity-ranked only.
    let topTracksForCarousel = $derived.by((): TrackData[] => {
        return tracks
            .filter((t) => t.popularity?.rankInArtist != null)
            .sort(
                (a, b) =>
                    (a.popularity?.rankInArtist ?? Infinity) -
                    (b.popularity?.rankInArtist ?? Infinity),
            )
            .slice(0, 20);
    });

    // Filter songs by search query
    let filteredTracks = $derived.by(() => {
        if (!songSearch.trim()) return tracks;
        const q = songSearch.toLowerCase().trim();
        return tracks.filter(
            (t) =>
                t.title.toLowerCase().includes(q) ||
                (t.album?.title ?? '').toLowerCase().includes(q),
        );
    });

    // Auto-select first non-empty tab (once after load). Overview is preferred
    // whenever we have tracks; it synthesizes suggested/albums/tracks in one
    // view so it's the most useful default.
    let tabInitialized = $state(false);
    $effect(() => {
        if (!loading && artist && !tabInitialized) {
            tabInitialized = true;
            if (tracks.length > 0) {
                activeTab = 'overview';
            } else if (fullAlbums.length > 0) {
                activeTab = 'albums';
            } else if (singles.length > 0) {
                activeTab = 'singles';
            }
        }
    });

    onMount(async () => {
        try {
            const { data, error: fetchError } = await getArtist(artistId);
            if (fetchError || !data) {
                throw new Error('Failed to fetch artist');
            }
            artist = data;
            albums = data.albums ?? [];
            tracks = data.tracks ?? [];
            if (data.title) {
                modals.updateProps(modalId, { artistName: data.title });
            }
        } catch (err) {
            console.error('Failed to load artist details:', err);
            error = 'Failed to load artist details.';
        } finally {
            loading = false;
        }

        // Lazily load sonic-similar artists after the main content is ready.
        // Skip for Various Artists: it's a synthetic compilation bucket with
        // no coherent sonic identity, so similarity search is meaningless.
        if (sonicEnabled && !isVa) {
            similarArtistsLoading = true;
            try {
                const { data: simData } = await getSimilarArtists(artistId, 10);
                if (simData) {
                    similarArtists = simData.items;
                }
            } catch {
                // Non-fatal: similar artists are supplementary content.
            } finally {
                similarArtistsLoading = false;
            }
        }
    });

    function openAlbum(albumId: string): void {
        openAlbumModal(albumId, { sonicEnabled });
    }

    type CardContextMenuState =
        | { kind: 'album'; x: number; y: number; album: AlbumData }
        | { kind: 'similar-artist'; x: number; y: number; artist: SimilarArtist };

    let cardContextMenu = $state<CardContextMenuState | null>(null);

    function handleAlbumContextMenu(e: MouseEvent, album: AlbumData): void {
        e.preventDefault();
        e.stopPropagation();
        cardContextMenu = { kind: 'album', x: e.clientX, y: e.clientY, album };
    }

    function handleSimilarArtistContextMenu(e: MouseEvent, artist: SimilarArtist): void {
        e.preventDefault();
        e.stopPropagation();
        cardContextMenu = { kind: 'similar-artist', x: e.clientX, y: e.clientY, artist };
    }

    function buildAlbumMenuItems(album: AlbumData): ContextMenuEntry[] {
        const items: ContextMenuEntry[] = [];
        const topTrack = albumTopTracks.get(album.id);
        if (topTrack) {
            items.push({ label: m.card_play(), onSelect: () => playTrack(topTrack) });
            items.push({
                label: m.album_play_next(),
                onSelect: () => musicPlayerStore.addToQueueFront(toMusicTrack(topTrack)),
            });
        }
        items.push({ label: 'Open album', onSelect: () => openAlbum(album.id) });
        return items;
    }

    function buildSimilarArtistMenuItems(artist: SimilarArtist): ContextMenuEntry[] {
        return [{ label: 'Open artist', onSelect: () => openArtistModal(artist.id) }];
    }

    function getGenres(): string[] {
        return artist?.genres ?? [];
    }
    const enrichmentDisplay = $derived(
        artist
            ? artistEnrichmentDisplay(
                  { genre: artist.genres, country_code: artist.countryCode },
                  artist.biography,
              )
            : null,
    );
    // Long biographies (Wikipedia/Last.fm text can run to many paragraphs)
    // collapse to their first sentences behind a "Show more" toggle.
    let bioExpanded = $state(false);
    const bioPreview = $derived(
        enrichmentDisplay?.biography
            ? sentencePreview(enrichmentDisplay.biography, { maxSentences: 3, maxChars: 400 })
            : null,
    );

    function formatDuration(seconds: number | null): string {
        if (seconds == null) return '';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function trackLoudnessDb(track: TrackData): number | undefined {
        return track.audioFeatures?.loudnessLufs;
    }

    function toMusicTrack(track: TrackData): MusicTrack {
        return track;
    }

    function playTrack(track: TrackData): void {
        // startPlayback (not play): clicking a track in the artist modal cancels any
        // active radio (clears the queue + autoplaySeed) and regenerates the smart
        // queue from this track, instead of leaving a radio's prefetched queue behind.
        void musicPlayerStore.startPlayback(toMusicTrack(track));
    }

    /** ArtistTrackRow.track_artists reshaped to TrackTitleLine's contract. */
    function titleArtists(track: Pick<TrackData, 'artists'>): { id?: string; title: string }[] {
        return (track.artists ?? []).map((artist) => ({
            id: artist.id ?? undefined,
            title: artist.title,
        }));
    }

    // The track rows below are non-button (role="button") containers rather
    // than real <button> elements: TrackTitleLine renders a real <button> for
    // each linked remixer credit, and a <button> cannot legally contain
    // interactive descendants (invalid HTML5 + broken a11y semantics). Mirrors
    // AlbumModal's handleTrackTitleKeydown.
    function handleTrackRowKeydown(event: KeyboardEvent, track: TrackData): void {
        // Nested artist-link buttons (TrackTitleLine) handle their own activation;
        // preventDefault here would cancel their native click synthesis on Enter/Space.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        playTrack(track);
    }

    // Header Play All / Shuffle — mirrors AlbumModal's queue pattern. Play All
    // runs the popularity-ranked top tracks first, then the rest of the
    // catalogue; Shuffle randomizes the whole song list. Capped so a huge
    // discography doesn't enqueue hundreds of tracks in one click.
    const ARTIST_QUEUE_CAP = 100;

    function artistPlayQueue(shuffle: boolean): MusicTrack[] {
        let ordered: TrackData[];
        if (shuffle) {
            return shuffledTracks(tracks.map(toMusicTrack)).slice(0, ARTIST_QUEUE_CAP);
        } else {
            const top = topTracksForCarousel;
            const topIds = new Set(top.map((t) => t.id));
            ordered = [...top, ...tracks.filter((t) => !topIds.has(t.id))];
        }
        return ordered.slice(0, ARTIST_QUEUE_CAP).map(toMusicTrack);
    }

    async function playArtist(shuffle: boolean): Promise<void> {
        const queue = artistPlayQueue(shuffle);
        if (queue.length === 0) return;
        await musicPlayerStore.enqueueFromBrew(queue, true, {
            type: 'artist',
            name: artist?.title ?? m.music_unknown_artist(),
            trackCount: queue.length - 1,
        });
    }

    async function handleClose(): Promise<void> {
        // X / swipe-down = "Done": leave the whole trail. Escape/backdrop still
        // pop a single trail step (owned by ModalContainer).
        await modals.closeAll();
    }

    const tabs: { id: TabId; label: string; count: () => number }[] = [
        {
            id: 'overview',
            label: 'Overview',
            count: () => tracks.length + albums.length,
        },
        { id: 'albums', label: 'Albums', count: () => fullAlbums.length },
        { id: 'singles', label: 'Singles', count: () => singles.length },
        { id: 'songs', label: 'Songs', count: () => tracks.length },
    ];

    // Various Artists has no flat track list (server returns tracks: []) —
    // hide the Songs tab entirely rather than just disabling it. Same for any
    // empty non-overview tab: a permanently disabled "Singles (0)" is dead
    // chrome, not information.
    let visibleTabs = $derived(
        tabs.filter((tab) => {
            if (isVa && tab.id === 'songs') return false;
            if (tab.id !== 'overview' && tab.count() === 0) return false;
            return true;
        }),
    );
</script>

<div
    id={modalId}
    class="card p-4 sm:p-6 shadow-xl max-w-[900px] w-screen sm:w-[90vw] h-full sm:h-auto sm:max-h-[90vh] overflow-y-auto relative"
    use:swipeToClose={{ onClose: handleClose }}>
    <!-- Mobile grab handle (swipe down to close) -->
    <div class="mx-auto mb-4 h-1 w-10 rounded-full bg-surface-500/60 sm:hidden" aria-hidden="true">
    </div>

    {#if loading}
        <div class="flex flex-col items-center justify-center py-12">
            <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
        </div>
    {:else if error || !artist}
        <div class="text-center py-12">
            <p class="text-error-500">{error || m.artist_not_found()}</p>
            <button class="btn variant-ghost-surface mt-4" onclick={handleClose}> Close </button>
        </div>
    {:else}
        <!-- Hero -->
        <div class="flex flex-col items-center gap-4 mb-6">
            <div
                class="w-36 h-36 rounded-full overflow-hidden bg-surface-800 shadow-2xl flex-shrink-0">
                {#if isVa}
                    <img
                        src={VARIOUS_ARTISTS_COVER_URL}
                        alt={artist.title}
                        class="h-full w-full object-cover" />
                {:else if artist.images.primary?.href}
                    <img
                        src={artist.images.primary.href}
                        alt={artist.title}
                        class="h-full w-full object-cover" />
                {:else}
                    <div class="flex h-full w-full items-center justify-center bg-surface-700">
                        <span class="text-5xl text-surface-500">♪</span>
                    </div>
                {/if}
            </div>

            <div class="text-center">
                <h2 class="text-2xl sm:text-3xl font-bold text-white mb-1">
                    {artist.title}
                </h2>
                <p class="text-sm text-surface-400 mb-3">
                    {albums.length}
                    {albums.length === 1 ? 'release' : 'releases'}
                    &middot;
                    {tracks.length}
                    {tracks.length === 1 ? 'song' : 'songs'}
                </p>

                {#if artist.popularity}
                    <div class="mb-3">
                        <PopularityBadge popularity={artist.popularity} variant="artist" />
                    </div>
                {/if}

                <DiscogsCredit sourceUrls={[
                    !isVa && artist.images.primary ? artist.discogsAttribution?.poster : undefined,
                    getGenres().length ? artist.discogsAttribution?.genre : undefined,
                ]} />

                <!-- Primary actions — playing an artist is the #1 intent when
                     opening one; before this the header was stats-only while
                     the album modal already had Play All/Shuffle. -->
                {#if tracks.length > 0}
                    <div class="mb-3 flex flex-wrap justify-center gap-3">
                        <button
                            class="btn variant-filled-primary"
                            onclick={() => void playArtist(false)}>
                            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                            {m.album_play_all()}
                        </button>
                        <button
                            class="btn variant-soft-surface"
                            onclick={() => void playArtist(true)}>
                            <svg
                                class="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24">
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M16 3h5m0 0v5m0-5l-6 6M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-1M16 21h5m0 0v-5m0 5l-6-6" />
                            </svg>
                            {m.album_shuffle()}
                        </button>
                    </div>
                {/if}

                {#if getGenres().length > 0}
                    <div class="flex flex-wrap justify-center gap-2">
                        {#each getGenres() as genre, genreIdx (genre + '-' + genreIdx)}
                            <span class="badge variant-soft-surface text-xs">
                                {genre}
                            </span>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>
        <!-- Overview -->
        {#if enrichmentDisplay?.biography}
            <div class="max-w-lg mx-auto text-center mb-6">
                <p class="text-sm leading-relaxed text-surface-400">
                    {bioPreview && !bioExpanded ? bioPreview : enrichmentDisplay.biography}
                </p>
                <DiscogsCredit sourceUrls={[artist.discogsAttribution?.biography]} />
                {#if bioPreview}
                    <button
                        type="button"
                        class="mt-1 text-sm font-medium text-primary-400 hover:text-primary-300"
                        aria-expanded={bioExpanded}
                        onclick={() => (bioExpanded = !bioExpanded)}>
                        {bioExpanded ? m.section_show_less() : m.section_show_more()}
                    </button>
                {/if}
            </div>
        {/if}
        <!-- Tabs -->
        <div class="flex gap-1 mb-4 border-b border-surface-700">
            {#each visibleTabs as tab (tab.id)}
                {@const count = tab.count()}
                <button
                    class="px-4 py-2 text-sm font-medium transition-colors relative {activeTab ===
                    tab.id
                        ? 'text-white'
                        : 'text-surface-400 hover:text-surface-200'}"
                    class:opacity-50={count === 0}
                    disabled={count === 0}
                    onclick={() => {
                        activeTab = tab.id;
                        songSearch = '';
                        tabInitialized = true;
                    }}>
                    {tab.label}
                    {#if tab.id !== 'overview'}
                        <span class="text-xs text-surface-500 ml-1">({count})</span>
                    {/if}
                    {#if activeTab === tab.id}
                        <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-primary-500"></div>
                    {/if}
                </button>
            {/each}
        </div>

        <!-- Tab Content -->
        {#if activeTab === 'overview'}
            {#if suggestedTracks.length === 0 && fullAlbums.length === 0 && singles.length === 0 && topTracksForCarousel.length === 0}
                <p class="text-center text-surface-400 py-8">No content to show.</p>
            {:else}
                <!-- Suggested / Top tracks list -->
                {#if suggestedTracks.length > 0}
                    <section class="mb-6">
                        <div class="flex items-center justify-between mb-2">
                            <h3
                                class="text-sm font-semibold uppercase tracking-wide text-surface-300">
                                Top Tracks
                            </h3>
                            <button
                                class="text-xs text-primary-400 hover:text-primary-300 transition-colors"
                                onclick={() => {
                                    activeTab = 'songs';
                                    songSearch = '';
                                }}>
                                See all →
                            </button>
                        </div>
                        <div class="flex flex-col gap-0.5">
                            {#each suggestedTracks as track, i (track.id)}
                                <div
                                    role="button"
                                    tabindex="0"
                                    class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-800/50 transition-colors text-left w-full group"
                                    onclick={() => playTrack(track)}
                                    onkeydown={(event) => handleTrackRowKeydown(event, track)}>
                                    <span
                                        class="text-xs text-surface-500 w-6 text-right flex-shrink-0">
                                        {i + 1}
                                    </span>
                                    <div
                                        class="w-10 h-10 rounded overflow-hidden bg-surface-800 flex-shrink-0">
                                        <MusicCover
                                            id={track.id}
                                            alt={track.album?.title ?? ''}
                                            hasOwnPoster={true}
                                            glyphClass="text-xs" />
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <p
                                            class="truncate text-sm font-medium text-white group-hover:text-primary-400 transition-colors">
                                            <TrackTitleLine
                                                title={track.title}
                                                artists={titleArtists(track)}
                                                remixerArtists={track.remixerArtists} />
                                        </p>
                                        <p class="truncate text-xs text-surface-400">
                                            {track.album?.title ?? ''}
                                        </p>
                                    </div>
                                    {#if track.popularity}
                                        <PopularityBadge
                                            popularity={track.popularity}
                                            variant="track" />
                                    {/if}
                                    {#if track.durationMs}
                                        <span class="text-xs text-surface-500 flex-shrink-0">
                                            {formatDuration(
                                                track.durationMs == null
                                                    ? null
                                                    : track.durationMs / 1000,
                                            )}
                                        </span>
                                    {/if}
                                    {#if $musicPlayerStore.showLoudnessDb && trackLoudnessDb(track) !== undefined}
                                        <span
                                            class="text-xs tabular-nums text-surface-500 flex-shrink-0">
                                            {trackLoudnessDb(track)!.toFixed(1)} dB
                                        </span>
                                    {/if}
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}

                <!-- Albums carousel -->
                {#if fullAlbums.length > 0}
                    <section class="mb-6">
                        <div class="flex items-center justify-between mb-2">
                            <h3
                                class="text-sm font-semibold uppercase tracking-wide text-surface-300">
                                Albums
                            </h3>
                            <button
                                class="text-xs text-primary-400 hover:text-primary-300 transition-colors"
                                onclick={() => (activeTab = 'albums')}>
                                See all →
                            </button>
                        </div>
                        <div class="flex gap-3 overflow-x-auto pb-2 snap-x scrollbar-thin">
                            {#each fullAlbums.slice(0, 12) as album (album.id)}
                                {@const topTrack = albumTopTracks.get(album.id)}
                                <button
                                    class="group flex flex-col gap-2 rounded-lg p-2 text-left transition-colors hover:bg-surface-800/50 flex-shrink-0 w-36 snap-start"
                                    onclick={() => openAlbum(album.id)}
                                    oncontextmenu={(e) => handleAlbumContextMenu(e, album)}>
                                    <div
                                        class="aspect-square w-full overflow-hidden rounded-lg bg-surface-800">
                                        <MusicCover
                                            id={album.id}
                                            alt={album.title}
                                            hasOwnPoster={true}
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
                                        {#if topTrack?.popularity}
                                            <div class="mt-1 flex items-center gap-1.5 min-w-0">
                                                <PopularityBadge
                                                    popularity={topTrack.popularity}
                                                    variant="track" />
                                                <span class="truncate text-xs text-surface-400">
                                                    {topTrack.title}
                                                </span>
                                            </div>
                                        {/if}
                                    </div>
                                </button>
                            {/each}
                        </div>
                    </section>
                {/if}

                <!-- Top tracks carousel -->
                {#if topTracksForCarousel.length > 0}
                    <section class="mb-6">
                        <div class="flex items-center justify-between mb-2">
                            <h3
                                class="text-sm font-semibold uppercase tracking-wide text-surface-300">
                                Popular Tracks
                            </h3>
                            <button
                                class="text-xs text-primary-400 hover:text-primary-300 transition-colors"
                                onclick={() => {
                                    activeTab = 'songs';
                                    songSearch = '';
                                }}>
                                See all →
                            </button>
                        </div>
                        <div class="flex gap-3 overflow-x-auto pb-2 snap-x scrollbar-thin">
                            {#each topTracksForCarousel as track (track.id)}
                                <div
                                    role="button"
                                    tabindex="0"
                                    class="group flex flex-col gap-2 rounded-lg p-2 text-left transition-colors hover:bg-surface-800/50 flex-shrink-0 w-36 snap-start"
                                    onclick={() => playTrack(track)}
                                    onkeydown={(event) => handleTrackRowKeydown(event, track)}>
                                    <div
                                        class="aspect-square w-full overflow-hidden rounded-lg bg-surface-800">
                                        <MusicCover
                                            id={track.id}
                                            alt={track.album?.title ?? ''}
                                            hasOwnPoster={true}
                                            imgClass="h-full w-full object-cover transition-transform group-hover:scale-105" />
                                    </div>
                                    <div class="min-w-0">
                                        <p class="truncate text-sm font-medium text-white">
                                            <TrackTitleLine
                                                title={track.title}
                                                artists={titleArtists(track)}
                                                remixerArtists={track.remixerArtists} />
                                        </p>
                                        <p class="truncate text-xs text-surface-400">
                                            {track.album?.title ?? ''}
                                        </p>
                                        {#if track.popularity}
                                            <div class="mt-1">
                                                <PopularityBadge
                                                    popularity={track.popularity}
                                                    variant="track" />
                                            </div>
                                        {/if}
                                    </div>
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}

                <!-- Similar Artists (sonic-similar, Overview tab only). Skipped
                     entirely for Various Artists — a compilation bucket has no
                     coherent sonic identity to compare against. -->
                {#if sonicEnabled && !isVa}
                    <section class="mb-6">
                        <h3
                            class="mb-2 text-sm font-semibold uppercase tracking-wide text-surface-300">
                            {m.music_similar_artists_section()}
                        </h3>
                        {#if similarArtistsLoading}
                            <div class="flex items-center gap-2 py-2 text-xs text-surface-500">
                                <span
                                    class="loading-spinner loading-spinner-sm loading-spinner-primary"
                                ></span>
                                <span>Finding similar artists…</span>
                            </div>
                        {:else if similarArtists.length === 0}
                            <p class="text-xs text-surface-500">{m.music_sounds_like_no_data()}</p>
                        {:else}
                            <!-- pb-4: last Overview section — keep the name/release
                                 labels clear of the modal's bottom edge. -->
                            <div class="flex gap-3 overflow-x-auto pb-4 snap-x scrollbar-thin">
                                {#each similarArtists as sim (sim.id)}
                                    <button
                                        class="group flex flex-col items-center gap-2 rounded-lg p-2 text-center transition-colors hover:bg-surface-800/50 flex-shrink-0 w-28 snap-start"
                                        onclick={() => openArtistModal(sim.id)}
                                        oncontextmenu={(e) =>
                                            handleSimilarArtistContextMenu(e, sim)}>
                                        <div
                                            class="w-20 h-20 rounded-full overflow-hidden bg-surface-800 flex-shrink-0">
                                            {#if sim.images.primary?.variants?.thumb}
                                                <img
                                                    src={sim.images.primary?.variants?.thumb}
                                                    alt={sim.title}
                                                    class="h-full w-full object-cover transition-transform group-hover:scale-105"
                                                    loading="lazy" />
                                            {:else}
                                                <div
                                                    class="flex h-full w-full items-center justify-center bg-surface-700">
                                                    <span class="text-2xl text-surface-500">♪</span>
                                                </div>
                                            {/if}
                                        </div>
                                        <div class="min-w-0 w-full">
                                            <p
                                                class="truncate text-xs font-medium text-white group-hover:text-primary-400 transition-colors">
                                                {sim.title}
                                            </p>
                                            <p class="text-xs text-surface-500">
                                                {sim.albumCount}
                                                {sim.albumCount === 1 ? 'release' : 'releases'}
                                            </p>
                                        </div>
                                    </button>
                                {/each}
                            </div>
                        {/if}
                    </section>
                {/if}
            {/if}
        {:else if activeTab === 'albums'}
            {#if fullAlbums.length === 0}
                <p class="text-center text-surface-400 py-8">No albums found.</p>
            {:else}
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                    {#each fullAlbums as album (album.id)}
                        {@const topTrack = albumTopTracks.get(album.id)}
                        <button
                            class="group flex flex-col gap-2 rounded-lg p-2 text-left transition-colors hover:bg-surface-800/50 w-full"
                            onclick={() => openAlbum(album.id)}
                            oncontextmenu={(e) => handleAlbumContextMenu(e, album)}>
                            <div
                                class="aspect-square w-full overflow-hidden rounded-lg bg-surface-800">
                                <MusicCover
                                    id={album.id}
                                    alt={album.title}
                                    hasOwnPoster={true}
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
                                {#if topTrack?.popularity}
                                    <div class="mt-1 flex items-center gap-1.5 min-w-0">
                                        <PopularityBadge
                                            popularity={topTrack.popularity}
                                            variant="track" />
                                        <span class="truncate text-xs text-surface-400">
                                            {topTrack.title}
                                        </span>
                                    </div>
                                {/if}
                            </div>
                        </button>
                    {/each}
                </div>
            {/if}
        {:else if activeTab === 'singles'}
            {#if singles.length === 0}
                <p class="text-center text-surface-400 py-8">No singles found.</p>
            {:else}
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                    {#each singles as single (single.id)}
                        {@const topTrack = albumTopTracks.get(single.id)}
                        <button
                            class="group flex flex-col gap-2 rounded-lg p-2 text-left transition-colors hover:bg-surface-800/50 w-full"
                            onclick={() => openAlbum(single.id)}
                            oncontextmenu={(e) => handleAlbumContextMenu(e, single)}>
                            <div
                                class="aspect-square w-full overflow-hidden rounded-lg bg-surface-800">
                                <MusicCover
                                    id={single.id}
                                    alt={single.title}
                                    hasOwnPoster={true}
                                    imgClass="h-full w-full object-cover transition-transform group-hover:scale-105" />
                            </div>
                            <div class="min-w-0">
                                <p class="truncate text-sm font-medium text-white">
                                    {single.title}
                                </p>
                                {#if single.year}
                                    <p class="text-xs text-surface-400">
                                        {single.year}
                                    </p>
                                {/if}
                                {#if topTrack?.popularity}
                                    <div class="mt-1 flex items-center gap-1.5 min-w-0">
                                        <PopularityBadge
                                            popularity={topTrack.popularity}
                                            variant="track" />
                                        <span class="truncate text-xs text-surface-400">
                                            {topTrack.title}
                                        </span>
                                    </div>
                                {/if}
                            </div>
                        </button>
                    {/each}
                </div>
            {/if}
        {:else if activeTab === 'songs'}
            <!-- Search bar -->
            <div class="mb-4 relative">
                <input
                    bind:this={songSearchInput}
                    type="search"
                    class="input w-full text-base sm:text-sm pr-10"
                    placeholder={m.modal_search_songs_placeholder()}
                    autocomplete="off"
                    autocorrect="off"
                    spellcheck="false"
                    bind:value={songSearch} />
                {#if songSearch}
                    <button
                        type="button"
                        class="absolute top-1/2 right-2 -translate-y-1/2 text-surface-400 hover:text-white transition-colors p-1 rounded"
                        aria-label={m.btn_clear_search()}
                        onclick={() => {
                            songSearch = '';
                            songSearchInput?.focus();
                        }}>
                        <Icon src={XMark} class="w-5 h-5" />
                    </button>
                {/if}
            </div>

            {#if filteredTracks.length === 0}
                <p class="text-center text-surface-400 py-8">
                    {songSearch ? 'No songs match your search.' : 'No songs found.'}
                </p>
            {:else}
                <div class="flex flex-col gap-0.5">
                    {#each filteredTracks as track, i (track.id)}
                        <div
                            role="button"
                            tabindex="0"
                            class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-800/50 transition-colors text-left w-full group"
                            onclick={() => playTrack(track)}
                            onkeydown={(event) => handleTrackRowKeydown(event, track)}>
                            <span class="text-xs text-surface-500 w-6 text-right flex-shrink-0">
                                {i + 1}
                            </span>
                            <div
                                class="w-8 h-8 rounded overflow-hidden bg-surface-800 flex-shrink-0">
                                <MusicCover
                                    id={track.id}
                                    alt={track.album?.title ?? ''}
                                    hasOwnPoster={true}
                                    glyphClass="text-xs" />
                            </div>
                            <div class="min-w-0 flex-1">
                                <p
                                    class="truncate text-sm font-medium text-white group-hover:text-primary-400 transition-colors">
                                    <TrackTitleLine
                                        title={track.title}
                                        artists={titleArtists(track)}
                                        remixerArtists={track.remixerArtists} />
                                </p>
                                <p class="truncate text-xs text-surface-400">
                                    {track.album?.title ?? ''}{track.year ? ` (${track.year})` : ''}
                                </p>
                            </div>
                            {#if track.popularity}
                                <PopularityBadge popularity={track.popularity} variant="track" />
                            {/if}
                            {#if track.durationMs}
                                <span class="text-xs text-surface-500 flex-shrink-0">
                                    {formatDuration(
                                        track.durationMs == null ? null : track.durationMs / 1000,
                                    )}
                                </span>
                            {/if}
                            {#if $musicPlayerStore.showLoudnessDb && trackLoudnessDb(track) !== undefined}
                                <span class="text-xs tabular-nums text-surface-500 flex-shrink-0">
                                    {trackLoudnessDb(track)!.toFixed(1)} dB
                                </span>
                            {/if}
                        </div>
                    {/each}
                </div>
            {/if}
        {/if}

        <!-- Footer -->
        <footer class="mt-6 flex justify-end">
            <button class="btn variant-ghost-surface" onclick={handleClose}> Close </button>
        </footer>
    {/if}
</div>

{#if cardContextMenu}
    <ContextMenu
        x={cardContextMenu.x}
        y={cardContextMenu.y}
        title={cardContextMenu.kind === 'album'
            ? cardContextMenu.album.title
            : cardContextMenu.artist.title}
        items={cardContextMenu.kind === 'album'
            ? buildAlbumMenuItems(cardContextMenu.album)
            : buildSimilarArtistMenuItems(cardContextMenu.artist)}
        onClose={() => (cardContextMenu = null)} />
{/if}

<style>
    /* Hide the browser's native clear button for type="search" — we render our own. */
    input[type='search']::-webkit-search-cancel-button {
        -webkit-appearance: none;
        appearance: none;
    }
</style>
