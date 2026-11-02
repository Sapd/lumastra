<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MusicSearchResults — the shared music search state + results panel, used by
  the desktop inline search on /music and by the mobile /music/search route.
  The host owns the <input> (bound to `query`); this component owns URL sync,
  the versioned search, dedup, the window-anchored quick-nav rail, and results.
  The ?q= sync deliberately uses raw history.replaceState (SvelteKit's shallow
  replaceState throws during hydration on 1-char deep links — see comment).
-->

<script lang="ts">
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import { untrack } from 'svelte';
    import { resolve } from '$lib/paths';
    import {
        Icon,
        MusicalNote,
        ChevronRight,
        UserGroup,
        RectangleStack,
        SpeakerWave,
        ChatBubbleBottomCenterText,
    } from 'svelte-hero-icons';
    import * as contentApi from '$lib/api/content';
    import { getMusicGenres } from '$lib/api/music';
    import { collapseTitleVariants } from '$lib/shared/music-title-normalize';
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import { buildMusicCardItem } from '$lib/utils/mapMusicTrackToItem';
    import type { ExternalIds } from '$lib/types/api-common';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { musicTrackFromCard } from '$lib/utils/music-track';

    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import SearchQuickNav from '$lib/components/search/SearchQuickNav.svelte';
    import SemanticSearchSection from '$lib/components/music/SemanticSearchSection.svelte';
    import AlbumCard from '$lib/components/music/AlbumCard.svelte';
    import ArtistCard from '$lib/components/music/ArtistCard.svelte';
    import MusicSearchTrackList, {
        type SearchTrackRow,
    } from '$lib/components/music/MusicSearchTrackList.svelte';
    import type { MusicItemHandlers } from '$lib/utils/music-item-handlers.svelte';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        query?: string;
        handlers: MusicItemHandlers;
        /** Hands keyboard focus back to the host's search input (↑ on the first row / Esc). */
        onfocusinput?: () => void;
    }

    let { query = $bindable(''), handlers, onfocusinput }: Props = $props();

    // svelte-ignore state_referenced_locally
    const {
        hiddenTrackIds,
        posterImages,
        handleItemClick,
        handleItemPlay,
        handleItemMore,
        handleItemRemove,
    } = handlers;

    let searchResults: UniversalMediaItem[] = $state([]);
    let searchTrackRows: SearchTrackRow[] = $state([]);
    let resultsEl: HTMLDivElement | undefined = $state();
    let trackList: MusicSearchTrackList | undefined = $state();
    let genreSearchResults: { genre: string; trackCount: number; albumCount: number }[] = $state(
        [],
    );
    let isSearching = $state(false);
    let searchError = $state(false);
    let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    /** Monotonic token guarding search-result writes (see original comment). */
    let searchVersion = 0;

    let normalizedQuery = $derived(query.trim());
    let isSearchMode = $derived(normalizedQuery.length >= 2);
    const textToSoundEnabled = $derived($page.data?.features?.textToSound === true);
    const lyricsSearchEnabled = $derived($page.data?.features?.lyricsSearch === true);

    // URL → state (back/forward navigation or external links).
    // `query` may legitimately be AHEAD of the URL — e.g. on desktop /music this
    // component only mounts once isSearchMode flips true (2nd keystroke), before
    // the state → URL effect below has had a chance to write `?q=` — so the very
    // first run must never treat "URL hasn't caught up yet" as a real navigation
    // and stomp freshly-typed state. Only apply the URL over state once we've
    // observed it actually CHANGE since the last time this effect looked at it.
    let lastObservedUrlQ: string | null = null;
    $effect(() => {
        const urlQ = $page.url.searchParams.get('q') ?? '';
        if (browser) {
            // Mid-navigation, $page.url can update before window.location does —
            // skip (and don't record) until they agree, so a stale snapshot never
            // gets treated as a genuine change.
            const currentQ = new URL(window.location.href).searchParams.get('q') ?? '';
            if (currentQ !== urlQ) return;
        }
        const previousUrlQ = lastObservedUrlQ;
        lastObservedUrlQ = urlQ;
        if (previousUrlQ === null) return;
        if (urlQ === previousUrlQ) return;
        if (urlQ !== untrack(() => query.trim())) query = urlQ;
    });

    // state → URL: raw History API (NOT SvelteKit replaceState) — the shallow
    // variant dereferences the not-yet-initialized client router at hydration
    // (1-char ?q=a deep link) and poisons the flush scheduler. Native rewrite
    // only touches the URL bar and does not retrigger the loader.
    $effect(() => {
        if (!browser) return;
        const q = normalizedQuery;
        const currentUrl = new URL(window.location.href);
        const currentQ = currentUrl.searchParams.get('q') ?? '';
        const desiredQ = q.length >= 2 ? q : '';
        if (desiredQ === currentQ) return;
        currentUrl.searchParams.set('q', desiredQ);
        if (!desiredQ) currentUrl.searchParams.delete('q');
        const qs = currentUrl.searchParams.toString();
        const target = qs ? `${currentUrl.pathname}?${qs}` : currentUrl.pathname;
        window.history.replaceState(window.history.state, '', resolve(target));
    });

    $effect(() => {
        if (!browser) return;
        // Invalidate immediately, including during the debounce and on unmount.
        const version = ++searchVersion;
        searchError = false;
        isLoadingMoreTracks = false;
        loadMoreFailed = false;
        isSearching = normalizedQuery.length >= 2;
        if (normalizedQuery.length >= 2) {
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            const q = normalizedQuery;
            searchDebounceTimer = setTimeout(() => void performSearch(q, version), 200);
        } else {
            searchVersion++;
            searchResults = [];
            searchTrackRows = [];
            tracksHasMore = false;
            albumsHasMore = false;
            artistsHasMore = false;
            genreSearchResults = [];
        }
        return () => {
            searchVersion++;
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        };
    });

    type SearchItem = NonNullable<
        Awaited<ReturnType<typeof contentApi.search>>['data']
    >['items'][number];

    // One request per section. A single mixed `types=music` page let the artist
    // and its albums eat the window, and the songs past it were unreachable:
    // "perfect pitch" matched ~50 songs, the page held 20, and there was no way
    // to ask for the rest. Typed requests give each section its own window and
    // its own `hasMore`.
    const TRACK_PAGE_SIZE = 20;
    const ALBUM_LIMIT = 24;
    const ARTIST_LIMIT = 12;

    let tracksHasMore = $state(false);
    // Albums and artists don't page here; when the server has more, the section
    // links to the albums/artists page, which searches the same query.
    let albumsHasMore = $state(false);
    let artistsHasMore = $state(false);
    let isLoadingMoreTracks = $state(false);
    let loadMoreFailed = $state(false);
    /** Query the shown song rows belong to, and how many rows the server has sent for it. */
    let tracksQuery = '';
    let tracksFetched = 0;

    function toTrackRow(item: SearchItem): SearchTrackRow {
        const internal = item.ids?.internal ?? item.id;
        return {
            id: internal,
            title: item.title,
            artist:
                item.artists?.map((a) => a.title).join(', ') ||
                (item.overview ?? '').split(' · ')[0] ||
                '',
            album: item.album,
            albumId: item.albumId,
            artistId: item.artistId,
            artists: item.artists,
            remixerArtists: item.remixerArtists,
            year: item.year,
            duration: item.durationMs == null ? undefined : item.durationMs / 1000,
            image: getCatalogPosterUrl(internal, { size: 'thumb' }),
        };
    }

    function toCardItem(item: SearchItem): UniversalMediaItem {
        return buildMusicCardItem({
            id: item.id,
            mediaType: item.type as 'album' | 'artist',
            title: item.title,
            subtitle: item.overview ?? (item.year ? String(item.year) : ''),
            overview: item.overview,
            year: item.year,
            externalIds: item.ids as ExternalIds,
            clickData: { artistId: item.artistId, albumId: item.albumId },
            artists: item.artists,
            remixerArtists: item.remixerArtists,
        });
    }

    async function performSearch(q: string, version = ++searchVersion): Promise<void> {
        isSearching = true;
        searchError = false;
        // Retry calls this directly (no query effect), and the new version makes
        // an in-flight "Load more" skip its own reset.
        isLoadingMoreTracks = false;
        loadMoreFailed = false;
        try {
            const [trackResult, albumResult, artistResult, genreApiResult] = await Promise.all([
                contentApi.search(q, { types: 'track', limit: TRACK_PAGE_SIZE }),
                contentApi.search(q, { types: 'album', limit: ALBUM_LIMIT }),
                contentApi.search(q, { types: 'artist', limit: ARTIST_LIMIT }),
                getMusicGenres(q),
            ]);
            if (version !== searchVersion) return;
            searchError =
                !!trackResult.error ||
                !trackResult.data ||
                !!albumResult.error ||
                !albumResult.data ||
                !!artistResult.error ||
                !artistResult.data ||
                !!genreApiResult.error;
            const genreResult = !genreApiResult.error ? genreApiResult.data : null;

            const trackItems = trackResult.data?.items ?? [];
            searchTrackRows = trackItems.filter((item) => item.type === 'track').map(toTrackRow);
            tracksQuery = q;
            tracksFetched = trackItems.length;
            tracksHasMore = trackResult.data?.page.hasMore === true;
            albumsHasMore = albumResult.data?.page.hasMore === true;
            artistsHasMore = artistResult.data?.page.hasMore === true;
            searchResults = [
                ...(artistResult.data?.items ?? []).filter((item) => item.type === 'artist'),
                ...(albumResult.data?.items ?? []).filter((item) => item.type === 'album'),
            ].map(toCardItem);

            genreSearchResults = (genreResult?.genres ?? []).map((genre) => ({
                genre: genre.genre,
                trackCount: genre.trackCount ?? 0,
                albumCount: genre.albumCount ?? 0,
            }));
        } catch {
            if (version !== searchVersion) return;
            searchError = true;
            searchResults = [];
            searchTrackRows = [];
            tracksHasMore = false;
            albumsHasMore = false;
            artistsHasMore = false;
            genreSearchResults = [];
        } finally {
            if (version === searchVersion) isSearching = false;
        }
    }

    /** Appends the next page of songs; dropped if the query changed meanwhile. */
    async function loadMoreTracks(): Promise<void> {
        // While a new query is in flight the rows on screen belong to the old
        // one; paging them with the new query would splice two result sets.
        if (isSearching || isLoadingMoreTracks || !tracksHasMore) return;
        const version = searchVersion;
        isLoadingMoreTracks = true;
        loadMoreFailed = false;
        try {
            const result = await contentApi.search(tracksQuery, {
                types: 'track',
                limit: TRACK_PAGE_SIZE,
                // What the server has handed out, not what survived the client
                // filters: a dropped duplicate would otherwise re-request the
                // same window forever.
                offset: tracksFetched,
            });
            if (version !== searchVersion) return;
            if (result.error || !result.data) {
                loadMoreFailed = true;
                return;
            }
            const items = result.data.items;
            tracksFetched += items.length;
            const seen = new Set(searchTrackRows.map((row) => row.id));
            const next = items
                .filter((item) => item.type === 'track')
                .map(toTrackRow)
                .filter((row) => !seen.has(row.id));
            searchTrackRows = [...searchTrackRows, ...next];
            // An empty page ends paging even if the server still says hasMore.
            tracksHasMore = items.length > 0 && result.data.page.hasMore === true;
        } catch {
            if (version === searchVersion) loadMoreFailed = true;
        } finally {
            // A superseded load is reset by the query effect, not here, so it
            // cannot clear the flag of a newer load.
            if (version === searchVersion) isLoadingMoreTracks = false;
        }
    }

    let searchArtists = $derived(searchResults.filter((r) => r.mediaType === 'artist'));
    let searchAlbums = $derived(searchResults.filter((r) => r.mediaType === 'album'));

    let showAllVersions = $state(false);
    $effect(() => {
        void normalizedQuery;
        showAllVersions = false;
    });

    let dedupedTrackRows = $derived(
        collapseTitleVariants(
            searchTrackRows,
            (t) => t.title,
            (t) => t.artistId || t.artist.toLowerCase() || `untagged:${t.id}`,
        ),
    );
    let visibleTrackRows = $derived(showAllVersions ? searchTrackRows : dedupedTrackRows);
    let hiddenVersionCount = $derived(searchTrackRows.length - dedupedTrackRows.length);

    // Handlers expect a section; search rows only need its id.
    const TRACKS_SECTION: PageSection = {
        id: 'music-search-tracks',
        type: 'carousel',
        title: '',
        items: [],
    };

    function trackRowItem(row: SearchTrackRow): UniversalMediaItem {
        return buildMusicCardItem({
            id: row.id,
            mediaType: 'track',
            title: row.title,
            overview: row.artist,
            clickData: { artistId: row.artistId, albumId: row.albumId },
        });
    }

    function playTrackRow(row: SearchTrackRow): void {
        const track = musicTrackFromCard({
            id: row.id,
            title: row.title,
            remixerArtists: row.remixerArtists?.map((a) => ({ ...a, id: a.id ?? null })),
            artists: row.artists?.map((a) => ({ ...a, id: a.id ?? null })) ?? [
                { id: row.artistId ?? null, title: row.artist || 'Unknown Artist' },
            ],
            album: row.albumId ? { id: row.albumId, title: row.album ?? '' } : null,
            durationMs: row.duration == null ? null : Math.round(row.duration * 1000),
        });
        void musicPlayerStore.startPlayback(track);
    }

    /** Moves keyboard focus from the search input into the results. */
    export function focusFirstResult(): void {
        if (trackList?.focusFirst()) return;
        resultsEl?.querySelector<HTMLElement>('a[href], button')?.focus();
    }

    let hasSearchResults = $derived(
        searchArtists.length > 0 || searchTrackRows.length > 0 || searchAlbums.length > 0,
    );

    let activeSearchSection = $state<string | null>(null);

    let musicSearchNavCategories = $derived.by(() => {
        if (!isSearchMode) return [];
        const cats: Array<{
            key: string;
            label: string;
            icon: typeof MusicalNote;
            iconColor: string;
        }> = [];
        if (visibleTrackRows.length > 0)
            cats.push({
                key: 'songs',
                label: m.route_music_songs(),
                icon: MusicalNote,
                iconColor: 'text-primary-400',
            });
        if (genreSearchResults.length > 0)
            cats.push({
                key: 'genres',
                label: m.route_music_matching_genres(),
                icon: MusicalNote,
                iconColor: 'text-primary-400',
            });
        if (searchArtists.length > 0)
            cats.push({
                key: 'artists',
                label: m.route_music_artists(),
                icon: UserGroup,
                iconColor: 'text-violet-400',
            });
        if (searchAlbums.length > 0)
            cats.push({
                key: 'albums',
                label: m.route_music_albums(),
                icon: RectangleStack,
                iconColor: 'text-blue-400',
            });
        if (textToSoundEnabled)
            cats.push({
                key: 'sound',
                label: m.music_semantic_sounds_like(),
                icon: SpeakerWave,
                iconColor: 'text-cyan-400',
            });
        if (lyricsSearchEnabled)
            cats.push({
                key: 'lyrics',
                label: m.music_semantic_lyrics_about(),
                icon: ChatBubbleBottomCenterText,
                iconColor: 'text-amber-400',
            });
        return cats;
    });

    let musicSearchNavCounts = $derived({
        genres: genreSearchResults,
        artists: searchArtists,
        songs: visibleTrackRows,
        albums: searchAlbums,
    });

    function scrollToSearchSection(key: string): void {
        const el = document.querySelector(`[data-music-search-section="${key}"]`);
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    }

    // The page itself is the scroll container — do NOT wrap results in an inner
    // scroll div, or this window-anchored scroll-spy breaks.
    let searchScrollSpyRaf = 0;
    function handleSearchScrollSpy(): void {
        if (!isSearchMode || searchScrollSpyRaf) return;
        searchScrollSpyRaf = requestAnimationFrame(() => {
            searchScrollSpyRaf = 0;
            const sections = document.querySelectorAll('[data-music-search-section]');
            let best: string | null = null;
            let bestDistance = Number.POSITIVE_INFINITY;
            for (const el of sections) {
                const distance = Math.abs(el.getBoundingClientRect().top - 120);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = el.getAttribute('data-music-search-section');
                }
            }
            activeSearchSection = best;
        });
    }
</script>

<svelte:window onscroll={handleSearchScrollSpy} />

{#if isSearchMode}
    {#if isSearching && !hasSearchResults && genreSearchResults.length === 0}
        <div role="status" class="flex items-center justify-center py-12">
            <div
                class="h-6 w-6 animate-spin rounded-full border-2 border-primary-500/30 border-t-primary-500">
            </div>
            <span class="ml-3 text-sm text-surface-400">{m.loading()}</span>
        </div>
    {:else}
        <!-- While a follow-up keystroke re-searches, keep the previous results on
             screen (dimmed) instead of swapping them for a spinner — the list no
             longer flashes empty on every character. -->
        <div
            bind:this={resultsEl}
            class="relative space-y-8 transition-opacity duration-150 xl:pr-36"
            class:opacity-60={isSearching}
            aria-busy={isSearching}>
            {#if isSearching}
                <div
                    role="status"
                    class="search-progress pointer-events-none absolute -top-4 right-0 left-0 h-0.5 overflow-hidden rounded-full">
                    <span class="sr-only">{m.loading()}</span>
                </div>
            {/if}
            {#if searchError}
                <div
                    role="alert"
                    class="flex flex-wrap items-center gap-3 rounded-lg bg-surface-800/60 p-4">
                    <p class="text-sm text-surface-300">{m.viewer_music_search_error()}</p>
                    <button
                        type="button"
                        class="rounded-lg px-4 py-2 text-sm font-medium text-primary-300 hover:bg-surface-700 focus-visible:outline-2 focus-visible:outline-primary-400"
                        onclick={() => void performSearch(normalizedQuery)}>{m.retry()}</button>
                </div>
            {/if}

            {#if visibleTrackRows.length > 0}
                <section class="scroll-mt-24 space-y-2" data-music-search-section="songs">
                    <div class="flex items-baseline justify-between gap-3">
                        <h2 class="text-lg font-semibold text-surface-50">
                            {m.route_music_songs()}
                        </h2>
                        {#if hiddenVersionCount > 0 || showAllVersions}
                            <button
                                type="button"
                                class="rounded-md px-2 py-1 text-xs font-medium text-surface-400 transition-colors hover:text-surface-100 focus-visible:outline-2 focus-visible:outline-primary-400"
                                onclick={() => (showAllVersions = !showAllVersions)}>
                                {showAllVersions
                                    ? m.music_search_versions_hide()
                                    : m.music_search_versions_show({ count: hiddenVersionCount })}
                            </button>
                        {/if}
                    </div>
                    <MusicSearchTrackList
                        bind:this={trackList}
                        rows={visibleTrackRows}
                        hasMore={tracksHasMore && !isSearching}
                        loadingMore={isLoadingMoreTracks}
                        {loadMoreFailed}
                        onloadmore={() => void loadMoreTracks()}
                        onplay={playTrackRow}
                        onalbum={(row) =>
                            handleItemClick({ section: TRACKS_SECTION, item: trackRowItem(row) })}
                        onsimilar={(row) =>
                            handleItemMore({ section: TRACKS_SECTION, item: trackRowItem(row) })}
                        onexit={onfocusinput} />
                </section>
            {/if}

            {#if genreSearchResults.length > 0}
                <div class="scroll-mt-24 space-y-2" data-music-search-section="genres">
                    <h3 class="text-sm font-medium text-surface-400">
                        {m.route_music_matching_genres()}
                    </h3>
                    <div class="flex flex-wrap gap-2">
                        {#each genreSearchResults as g, gIdx (g.genre + '-' + gIdx)}
                            <a
                                href={resolve(`/music/genres/${encodeURIComponent(g.genre)}`)}
                                class="group flex items-center gap-2 rounded-lg border border-surface-600/30 bg-surface-800/60 px-3 py-2 text-sm transition-all hover:border-primary-500/40 hover:bg-surface-700/80">
                                <Icon src={MusicalNote} class="h-4 w-4 text-primary-400" />
                                <span class="font-medium text-surface-50">{g.genre}</span>
                                <span class="text-xs text-surface-500">
                                    {g.trackCount}
                                    {m.music_tracks_plural()} &middot; {g.albumCount}
                                    {m.music_albums_plural()}
                                </span>
                                <Icon
                                    src={ChevronRight}
                                    class="h-3 w-3 text-surface-500 transition-transform group-hover:translate-x-0.5" />
                            </a>
                        {/each}
                    </div>
                </div>
            {/if}

            {#if hasSearchResults}
                {#if searchArtists.length > 0}
                    <div
                        class="music-search-result-cards scroll-mt-24 space-y-3"
                        data-music-search-section="artists">
                        <div class="flex items-baseline justify-between gap-3">
                            <h2 class="text-lg font-semibold text-surface-50">
                                {m.route_music_artists()}
                            </h2>
                            {#if artistsHasMore}
                                <a
                                    href={resolve(
                                        `/music/artists?q=${encodeURIComponent(normalizedQuery)}`,
                                    )}
                                    class="rounded-md px-2 py-1 text-xs font-medium text-primary-400 transition-colors hover:text-primary-300 focus-visible:outline-2 focus-visible:outline-primary-400"
                                    >{m.music_search_see_all()}</a>
                            {/if}
                        </div>
                        <div
                            class="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                            {#each searchArtists as item (item.id)}
                                {#if item.id}
                                    <ArtistCard
                                        id={item.id}
                                        title={item.title}
                                        subtitle={item.subtitle || undefined}
                                        hasCustomPoster={true} />
                                {/if}
                            {/each}
                        </div>
                    </div>
                {/if}

                {#if searchAlbums.length > 0}
                    <div
                        class="music-search-result-cards scroll-mt-24 space-y-3"
                        data-music-search-section="albums">
                        <div class="flex items-baseline justify-between gap-3">
                            <h2 class="text-lg font-semibold text-surface-50">
                                {m.route_music_albums()}
                            </h2>
                            {#if albumsHasMore}
                                <a
                                    href={resolve(
                                        `/music/albums?q=${encodeURIComponent(normalizedQuery)}`,
                                    )}
                                    class="rounded-md px-2 py-1 text-xs font-medium text-primary-400 transition-colors hover:text-primary-300 focus-visible:outline-2 focus-visible:outline-primary-400"
                                    >{m.music_search_see_all()}</a>
                            {/if}
                        </div>
                        <div
                            class="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
                            {#each searchAlbums as item (item.id)}
                                {#if item.id}
                                    <AlbumCard
                                        id={item.id}
                                        title={item.title}
                                        artistName={item.overview ?? null}
                                        year={item.year ?? null}
                                        hasCustomPoster={true} />
                                {/if}
                            {/each}
                        </div>
                    </div>
                {/if}
            {:else if isSearching}
                <!-- previous query had nothing; the dimmed spinner bar says we're on it -->
            {:else if genreSearchResults.length === 0 && !searchError}
                <div class="py-12 text-center">
                    <p class="text-surface-400">{m.route_music_no_results({ query })}</p>
                </div>
            {:else if genreSearchResults.length > 0}
                <div class="py-4 text-center">
                    <p class="text-sm text-surface-500">
                        {m.route_music_showing_genres_only({ query })}
                    </p>
                </div>
            {/if}

            {#if textToSoundEnabled}
                <div
                    class="music-search-result-cards scroll-mt-24"
                    data-music-search-section="sound">
                    <SemanticSearchSection
                        kind="sound"
                        endpoint="/api/music/text-search"
                        query={normalizedQuery}
                        enabled={textToSoundEnabled}
                        {hiddenTrackIds}
                        onitemClick={handleItemClick}
                        onitemPlay={handleItemPlay}
                        onitemMore={handleItemMore}
                        onitemRemove={handleItemRemove} />
                </div>
            {/if}
            {#if lyricsSearchEnabled}
                <div
                    class="music-search-result-cards scroll-mt-24"
                    data-music-search-section="lyrics">
                    <SemanticSearchSection
                        kind="lyrics"
                        endpoint="/api/music/lyrics-search"
                        query={normalizedQuery}
                        enabled={lyricsSearchEnabled}
                        {hiddenTrackIds}
                        onitemClick={handleItemClick}
                        onitemPlay={handleItemPlay}
                        onitemMore={handleItemMore}
                        onitemRemove={handleItemRemove} />
                </div>
            {/if}
        </div>

        <SearchQuickNav
            categoriesWithResults={musicSearchNavCategories}
            activeCategory={activeSearchSection}
            groupedResults={musicSearchNavCounts}
            positionClass="fixed right-4 top-1/2 -translate-y-1/2 z-30 hidden xl:block"
            labelSide="left"
            onscrollTo={scrollToSearchSection} />
    {/if}
{/if}

<style>
    .search-progress {
        background: linear-gradient(90deg, transparent, var(--color-primary-400), transparent);
        background-size: 40% 100%;
        background-repeat: no-repeat;
        animation: search-progress 0.9s linear infinite;
    }
    @keyframes search-progress {
        from {
            background-position: -40% 0;
        }
        to {
            background-position: 140% 0;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .search-progress {
            animation: none;
            background-position: 50% 0;
        }
    }

    /* Search is a decision surface: let result names use two lines instead of
       hiding their distinguishing words behind a one-line ellipsis. Browsing
       shelves intentionally stay compact. */
    .music-search-result-cards :global([data-media-card-title]) {
        display: -webkit-box;
        min-height: 2.5rem;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        white-space: normal;
    }

    /* Same for the credit line, "{artist} · {album} · {year}". One truncated
       line reduced it to "2015 · …" — the album, the thing that tells two
       copies of a song apart, never survived.

       This relies on the line being a single text-only element (a <p>, or the
       whole line as one artist <button>); a <button> nested INSIDE the line is
       an inline-block that can't break across lines, and clamping silently
       leaks a third line. That's why track cards fold the year into the
       subtitle rather than letting the card render "{year} · {subtitle}". */
    .music-search-result-cards :global([data-media-card-subtitle]) {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        white-space: normal;
    }
</style>
