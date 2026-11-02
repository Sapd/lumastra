<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { mediaPreviewToUniversal } from '$lib/utils/media-preview';
    import { pickVariant } from '$lib/utils/image-utils';
    import './player-presentation.css';
    import { playerStore, formatTime } from './playerStore.svelte';
    import type { TimelineChapter } from '$lib/types/playback';
    import PlayerIcon from './PlayerIcon.svelte';
    import { Z } from '$lib/utils/z-index';
    import { onMount, onDestroy } from 'svelte';
    import { browser } from '$app/environment';
    import { fade, fly } from 'svelte/transition';
    import { Icon, Bookmark, XCircle, Play } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import AIRatingButton from '$lib/components/AIRatingButton.svelte';
    import type { ExternalIds, ApiMediaType } from '$lib/types/api-common';
    import {
        buildMediaKey,
        hasValidExternalId,
        createRenderableMediaKeys,
    } from '$lib/utils/media-id-helpers';
    import * as contentApi from '$lib/api/content';
    import * as aiApi from '$lib/api/ai';
    import {
        addToWatchlistStore,
        removeFromWatchlistStore,
        type WatchlistItem,
    } from '$lib/stores/watchlist';
    import { isSeries } from '$lib/shared/media-types';
    import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
    import { FALLBACK_IMAGE } from '$lib/constants/images';

    interface Props {
        isOpen?: boolean;
        itemId: string;
        readOnly?: boolean; // When true, disables playing similar movies (for watch party guests)
        onseek?: (seconds: number) => void;
        onclose?: () => void;
        onabandon?: () => void;
        onplaymovie?: (detail: { itemId: string }) => void;
    }

    let {
        isOpen = false,
        itemId,
        readOnly = false,
        onseek,
        onclose,
        onabandon,
        onplaymovie,
    }: Props = $props();

    interface MovieDetails {
        id: string;
        title: string;
        overview: string;
        year: number | null;
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv';
        runtime: number | null;
        genres: string[];
        rating: number | null;
        ratingSource: string | null;
        ratings: Record<string, number>;
        posterUrl: string | null;
        backdropUrl: string | null;
        userRating: number | null;
        isInWatchlist: boolean;
    }

    interface SimilarMovie {
        externalIds: ExternalIds;
        mediaType: string;
        title: string;
        rating: number;
        overview: string;
        genres: string[];
        year: number | null;
        similarity: number;
        isAvailable: boolean;
        posterUrl: string | null;
        backdropUrl: string | null;
        canRequest: boolean;
        userRating: number | null;
        isWatched: boolean;
    }

    let movieDetails = $state<MovieDetails | null>(null);
    let similarMovies: SimilarMovie[] = $state([]);
    // Dedup-safe render keys — composite key / title fallback can collide and throw
    // `each_key_duplicate` when two similar items resolve to the same identity.
    let similarMovieKeys = $derived(createRenderableMediaKeys(similarMovies));
    let loading = $state(true);
    let loadingSimilar = $state(false);
    let error = $state<string | null>(null);

    let cast = $state<Array<{ name: string; character?: string }>>([]);
    const chapters = $derived(playerStore.chapters ?? []);
    const currentChapter = $derived(
        chapters.findLastIndex(
            (chapter) => chapter.startMs <= playerStore.currentTime * 1000,
        ),
    );

    async function fetchCast(id: string): Promise<void> {
        cast = [];
        try {
            const { data } = await contentApi.getMediaDetailsByQuery(id);
            if (id !== itemId) return;
            cast = (data?.actors ?? [])
                .map((actor) => (typeof actor === 'string' ? { name: actor } : actor))
                .slice(0, 8);
        } catch {
            // Cast is optional; metadata and playback remain available.
        }
    }

    function seekChapter(chapter: TimelineChapter): void {
        if (readOnly || !onseek) return;
        onseek(chapter.startMs / 1000);
        close();
    }

    // Rating state
    let currentRating = $state<number | null>(null);

    // Watchlist state
    let isInWatchlist = $state(false);
    let isUpdatingWatchlist = $state(false);

    // Helper: Check if movie has valid external IDs for actions
    let hasValidIds = $derived.by(() => {
        const details = movieDetails;
        if (!details?.externalIds) return false;
        return hasValidExternalId(details.externalIds);
    });

    function getBackdropUrl(): string {
        return movieDetails?.backdropUrl ?? FALLBACK_IMAGE;
    }

    function getPosterUrl(movie: SimilarMovie): string | null {
        return movie.posterUrl ?? null;
    }

    // Handle poster image error - hide the image
    function handlePosterError(e: Event) {
        const img = e.target as HTMLImageElement;
        img.style.display = 'none';
    }

    // Handle backdrop image error - hide the backdrop section
    let backdropFailed = $state(false);
    function handleBackdropError() {
        backdropFailed = true;
    }

    let detailsRequest = 0;
    onDestroy(() => {
        detailsRequest++;
    });

    // Fetch movie details
    async function fetchMovieDetails() {
        if (!browser || !itemId) return;

        const request = ++detailsRequest;
        const targetId = itemId;
        const isCurrent = () => request === detailsRequest && targetId === itemId;
        loading = true;
        movieDetails = null;
        similarMovies = [];
        loadingSimilar = false;
        error = null;
        backdropFailed = false;

        try {
            const { data: details, error: detailsError } =
                await contentApi.getMovieDetails(targetId);
            if (!isCurrent()) return;
            if (!detailsError) {
                if (details) {
                    // Map new contract fields to local MovieDetails interface.
                    // Server now returns `type`/`ids`/`images{}` instead of
                    // `mediaType`/`externalIds`/`posterUrl`/`backdropUrl`.
                    const mappedDetails: MovieDetails = {
                        ...details,
                        // Map `ids` -> `externalIds`
                        externalIds: (details.ids as ExternalIds) ?? {},
                        // Map `type` -> `mediaType` (new server uses 'series' not 'tv').
                        //
                        // `details.type === 'series' ? 'tv' : (details.type ?? 'movie')`
                        // used to sit here — a bare literal comparison whose else-branch
                        // let `'audiobook'` through into a `'movie' | 'tv'` field. The
                        // player sidebar has no audiobook representation, and this
                        // component is only mounted for video playback, so 'movie' is the
                        // reviewed substitute rather than a guess about an unknown type.
                        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- this sidebar is video-only.
                        mediaType: toTmdbType(details.type) ?? 'movie',
                        // Map `images{}` hrefs -> flat legacy fields
                        posterUrl: pickVariant(details.images?.poster, 'card') ?? null,
                        backdropUrl: pickVariant(details.images?.backdrop, 'card') ?? null,
                        // Map `runtimeMinutes` -> `runtime`
                        runtime:
                            (details as unknown as { runtimeMinutes?: number }).runtimeMinutes ??
                            null,
                        // These fields are not in new contract — read from user sub-object
                        userRating: details.user?.rating ?? null,
                        isInWatchlist: details.user?.isInWatchlist ?? false,
                        // Ratings map is not in new contract — fall back to null
                        ratings: {} as Record<string, number>,
                        rating: null,
                        ratingSource: null,
                        year: details.year ?? null,
                        overview: details.overview ?? '',
                    };
                    movieDetails = mappedDetails;
                    currentRating = mappedDetails.userRating;
                    isInWatchlist = mappedDetails.isInWatchlist;
                } else {
                    error = m.error_parse_movie_details();
                }

                // Fetch similar movies if we have external IDs
                if (movieDetails?.externalIds && hasValidExternalId(movieDetails.externalIds)) {
                    fetchSimilarMovies(movieDetails.externalIds, movieDetails.mediaType, isCurrent);
                }
            } else {
                console.error('[MovieSidebar] Movie details error:', detailsError);
                error = m.error_load_movie_details();
            }
        } catch (e) {
            console.error('[MovieSidebar] Error fetching details:', e);
            if (isCurrent()) error = m.error_load_movie_details();
        } finally {
            if (isCurrent()) loading = false;
        }
    }

    // Fetch similar movies using provider-agnostic API
    async function fetchSimilarMovies(
        externalIds: ExternalIds,
        mediaType: string,
        isCurrent: () => boolean,
    ) {
        if (!browser) return;

        // Build media key for provider-agnostic API
        const apiMediaType = isSeries(mediaType) ? 'tv' : 'movie';
        const mediaKey = buildMediaKey(externalIds, apiMediaType as ApiMediaType);
        if (!mediaKey) {
            console.warn('[MovieSidebar] No valid external ID for similar movies');
            return;
        }

        loadingSimilar = true;

        try {
            const { data: result, error: similarError } = await contentApi.getSimilarMedia(
                mediaKey,
                10,
            );
            if (!isCurrent()) return;
            if (!similarError && result) {
                similarMovies = result.items.map((item) => ({
                    id: item.id,
                    title: item.title,
                    overview: item.overview ?? '',
                    year: item.year ?? null,
                    genres: item.genres ?? [],
                    externalIds: mediaPreviewToUniversal(item).externalIds,
                    mediaType: item.type === 'series' ? 'tv' : item.type,
                    posterUrl: pickVariant(item.images.poster, 'thumb') ?? null,
                    backdropUrl: pickVariant(item.images.backdrop, 'wide') ?? null,
                    isAvailable: item.availability?.isAvailable ?? false,
                    canRequest: item.availability?.canRequest ?? false,
                    rating: item.rating ?? 0,
                    similarity: item.score ?? 0,
                    isWatched: item.progress?.finished ?? false,
                    userRating: null,
                }));
            } else if (similarError) {
                console.error('[MovieSidebar] Similar movies error response:', similarError);
            }
        } catch (e) {
            console.error('[MovieSidebar] Error fetching similar movies:', e);
        } finally {
            if (isCurrent()) loadingSimilar = false;
        }
    }

    // Handle rating from AIRatingButton
    function handleRated(detail: { externalIds: ExternalIds; rating: number; title: string }) {
        currentRating = detail.rating;
    }

    // Toggle watchlist
    async function toggleWatchlist() {
        if (
            !movieDetails?.externalIds ||
            !hasValidExternalId(movieDetails.externalIds) ||
            isUpdatingWatchlist
        )
            return;

        isUpdatingWatchlist = true;

        try {
            if (isInWatchlist) {
                // Remove from watchlist
                const { error: removeError } = await aiApi.unsaveMovie({
                    externalIds: movieDetails.externalIds,
                    mediaType: movieDetails.mediaType,
                });

                if (!removeError) {
                    isInWatchlist = false;
                    removeFromWatchlistStore(movieDetails.externalIds, movieDetails.mediaType);
                }
            } else {
                // Add to watchlist
                const { error: saveError } = await aiApi.saveMovie({
                    externalIds: movieDetails.externalIds,
                    mediaType: movieDetails.mediaType,
                    title: movieDetails.title,
                    overview: movieDetails.overview,
                });

                if (!saveError) {
                    isInWatchlist = true;
                    const watchlistItem: WatchlistItem = {
                        externalIds: movieDetails.externalIds,
                        mediaType: movieDetails.mediaType,
                        title: movieDetails.title,
                        overview: movieDetails.overview,
                        savedAt: new Date().toISOString(),
                    };
                    addToWatchlistStore(watchlistItem);
                }
            }
        } catch (e) {
            console.error('[MovieSidebar] Error updating watchlist:', e);
        } finally {
            isUpdatingWatchlist = false;
        }
    }

    // Abandon movie (close and mark as unwatched)
    function handleAbandon() {
        onabandon?.();
        onclose?.();
    }

    // Play a similar movie — accepts any resolvable ID (jellyfinId or internal UUID)
    function playSimilarMovie(playId: string) {
        if (readOnly) return; // Watch party guests cannot play similar movies
        onplaymovie?.({ itemId: playId });
        onclose?.();
    }

    // Close the sidebar
    function close() {
        onclose?.();
    }

    // Handle escape key
    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && isOpen) {
            event.preventDefault();
            event.stopImmediatePropagation(); // Prevent VideoPlayer from also handling this ESC
            close();
        }
    }

    // Fetch on mount and when opened
    $effect(() => {
        if (isOpen && browser && itemId) {
            fetchMovieDetails();
            void fetchCast(itemId);
        }
    });

    onMount(() => {
        // Use capture phase to intercept ESC before VideoPlayer handles it
        window.addEventListener('keydown', handleKeydown, true);
        return () => window.removeEventListener('keydown', handleKeydown, true);
    });
</script>

{#if isOpen}
    <!-- Backdrop -->
    <button
        class="fixed inset-0 bg-black/50"
        style="z-index: {Z.PLAYER_SIDEBAR};"
        transition:fade={{ duration: 200 }}
        onclick={close}
        aria-label="Close movie sidebar"></button>

    <!-- Drawer -->
    <div
        class="player-drawer fixed right-0 top-0 bottom-0 w-[420px] max-w-[90vw] flex flex-col"
        style="z-index: {Z.PLAYER_SIDEBAR_CONTENT};"
        transition:fly={{ x: 420, duration: 300 }}>
        {#if loading}
            <div class="center flex-1">
                <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
            </div>
        {:else if error}
            <div class="center-col flex-1 p-8 text-surface-400">
                <span>{error}</span>
                <button
                    class="mt-2 px-4 py-2 bg-surface-700 hover:bg-surface-600 rounded-lg transition-colors"
                    onclick={fetchMovieDetails}>
                    {m.btn_retry()}
                </button>
            </div>
        {:else if movieDetails}
            <header class="player-drawer-header">
                <div>
                    <span class="player-eyebrow">{m.music_now_playing_label()}</span>
                    <h2>{movieDetails.title}</h2>
                </div>
                <button onclick={close} aria-label={m.btn_close()}
                    ><PlayerIcon name="close" size={20} /></button>
            </header>
            <div class="flex-1 overflow-y-auto sidebar-scroll">
                {#if movieDetails.backdropUrl && !backdropFailed}
                    <img
                        src={getBackdropUrl()}
                        alt=""
                        class="movie-backdrop"
                        onerror={handleBackdropError} />
                {/if}
                <div class="movie-copy">
                    <div class="flex items-center gap-3 text-sm text-surface-400 mb-4">
                        {#if movieDetails.year}
                            <span>{movieDetails.year}</span>
                        {/if}
                        {#if movieDetails.runtime}
                            <span
                                >{m.format_minutes_short({
                                    minutes: String(movieDetails.runtime),
                                })}</span>
                        {/if}
                    </div>

                    {#if movieDetails.overview}<p class="movie-overview">
                            {movieDetails.overview}
                        </p>{/if}
                    {#if chapters.length > 0}
                        <h3 class="player-section-heading">{m.media_tab_chapters()}</h3>
                        <div class="movie-chapters">
                            {#each chapters as chapter, index (index)}
                                <button
                                    class="movie-chapter"
                                    class:current={index === currentChapter}
                                    aria-current={index === currentChapter ? 'true' : undefined}
                                    disabled={readOnly || !onseek}
                                    onclick={() => seekChapter(chapter)}>
                                    <span class="chapter-number">{index + 1}</span>
                                    <span
                                        ><strong>{chapter.name}</strong><small
                                            >{formatTime(
                                                (chapter.startMs / 1000),
                                            )}</small
                                        ></span>
                                </button>
                            {/each}
                        </div>
                    {/if}
                    {#if cast.length > 0}
                        <h3 class="player-section-heading">{m.cast()}</h3>
                        <ul class="movie-cast">
                            {#each cast as actor, index (index)}<li>
                                    <strong>{actor.name}</strong>{#if actor.character}<small
                                            >{actor.character}</small
                                        >{/if}
                                </li>{/each}
                        </ul>
                    {/if}
                    <div class="movie-actions-divider"></div>
                    <!-- Ratings Section -->
                    {#if movieDetails.ratings && (movieDetails.ratings.imdb || movieDetails.ratings.rtCritic || movieDetails.ratings.rtAudience || movieDetails.ratings.mdblist)}
                        {@const ratings = movieDetails.ratings}
                        <div class="grid grid-cols-2 gap-2 mb-4 p-3 bg-surface-800/50 rounded-lg">
                            <!-- IMDB Rating -->
                            {#if ratings.imdb}
                                <div class="flex-center-gap-2">
                                    <div class="w-8 h-8 center bg-yellow-500/20 rounded">
                                        <span class="text-xs font-bold text-yellow-500"
                                            >{m.rating_imdb_short()}</span>
                                    </div>
                                    <div>
                                        <div class="text-sm font-semibold text-white">
                                            {ratings.imdb.toFixed(1)}
                                        </div>
                                        <div class="text-[10px] text-surface-500">
                                            {m.rating_out_of_10()}
                                        </div>
                                    </div>
                                </div>
                            {/if}

                            <!-- Rotten Tomatoes Critic -->
                            {#if ratings.rtCritic}
                                <div class="flex-center-gap-2">
                                    <div
                                        class="w-8 h-8 center rounded {ratings.rtCritic >= 60
                                            ? 'bg-red-500/20'
                                            : 'bg-surface-700'}">
                                        <span class="text-lg">&#x1F345;</span>
                                    </div>
                                    <div>
                                        <div class="text-sm font-semibold text-white">
                                            {ratings.rtCritic}%
                                        </div>
                                        <div class="text-[10px] text-surface-500">
                                            {m.rating_rt_critics_short()}
                                        </div>
                                    </div>
                                </div>
                            {/if}

                            <!-- Rotten Tomatoes Audience -->
                            {#if ratings.rtAudience}
                                <div class="flex-center-gap-2">
                                    <div
                                        class="w-8 h-8 center rounded {ratings.rtAudience >= 60
                                            ? 'bg-red-500/20'
                                            : 'bg-surface-700'}">
                                        <span class="text-lg">&#x1F37F;</span>
                                    </div>
                                    <div>
                                        <div class="text-sm font-semibold text-white">
                                            {ratings.rtAudience}%
                                        </div>
                                        <div class="text-[10px] text-surface-500">
                                            {m.rating_rt_audience_short()}
                                        </div>
                                    </div>
                                </div>
                            {/if}

                            <!-- MDBList Score -->
                            {#if ratings.mdblist}
                                <div class="flex-center-gap-2">
                                    <div class="w-8 h-8 center bg-primary-500/20 rounded">
                                        <span class="text-xs font-bold text-primary-400"
                                            >{m.rating_mdblist_short()}</span>
                                    </div>
                                    <div>
                                        <div class="text-sm font-semibold text-white">
                                            {ratings.mdblist}
                                        </div>
                                        <div class="text-[10px] text-surface-500">
                                            {m.rating_out_of_100()}
                                        </div>
                                    </div>
                                </div>
                            {/if}
                        </div>
                    {/if}

                    {#if movieDetails.genres.length > 0}
                        <div class="flex flex-wrap gap-2 mb-4">
                            {#each movieDetails.genres.slice(0, 4) as genre, genreIdx (genre + '-' + genreIdx)}
                                <span class="text-xs px-2 py-1 bg-surface-700 rounded"
                                    >{genre}</span>
                            {/each}
                        </div>
                    {/if}

                    <!-- Rating Buttons -->
                    {#if movieDetails.externalIds && hasValidExternalId(movieDetails.externalIds)}
                        <div class="mb-4">
                            <div class="text-sm text-surface-400 mb-2">
                                {m.rate_this_movie()}
                            </div>
                            <div class="flex justify-center">
                                <AIRatingButton
                                    externalIds={movieDetails.externalIds}
                                    mediaType={movieDetails.mediaType}
                                    title={movieDetails.title}
                                    {currentRating}
                                    context="for-you"
                                    seen={true}
                                    onrated={handleRated} />
                            </div>
                        </div>
                    {/if}

                    <!-- Action Buttons -->
                    <div class="flex gap-2 mb-6">
                        <button
                            class="flex-1 center gap-2 py-3 rounded-lg transition-all
                                   {isInWatchlist
                                ? 'bg-primary-500/20 border-2 border-primary-500 text-primary-400'
                                : 'bg-surface-700 hover:bg-surface-600 text-surface-300'}"
                            onclick={toggleWatchlist}
                            disabled={isUpdatingWatchlist || !hasValidIds}>
                            <Icon src={Bookmark} class="w-5 h-5" solid={isInWatchlist} />
                            <span class="text-sm"
                                >{isInWatchlist ? m.on_watchlist() : m.watch_later()}</span>
                        </button>
                        <button
                            class="flex-1 center gap-2 py-3 rounded-lg bg-surface-700 hover:bg-red-500/20 hover:text-red-400 text-surface-300 transition-all"
                            onclick={handleAbandon}>
                            <Icon src={XCircle} class="w-5 h-5" />
                            <span class="text-sm">{m.abandon()}</span>
                        </button>
                    </div>

                    <!-- Similar Movies -->
                    <div>
                        <h3
                            class="text-sm font-semibold text-surface-400 uppercase tracking-wide mb-3">
                            {m.similar_movies()}
                        </h3>

                        {#if loadingSimilar}
                            <div class="center py-8">
                                <span
                                    class="loading-spinner loading-spinner-lg loading-spinner-primary"
                                ></span>
                            </div>
                        {:else if similarMovies.length === 0}
                            <div class="text-center text-surface-500 py-4 text-sm">
                                {m.no_similar_movies()}
                            </div>
                        {:else}
                            <div class="space-y-3">
                                {#each similarMovies as movie, movieIdx (similarMovieKeys[movieIdx])}
                                    <div
                                        class="flex gap-3 p-2 rounded-lg bg-surface-800/50 hover:bg-surface-800 transition-colors">
                                        <!-- Poster -->
                                        {#if getPosterUrl(movie)}
                                            <div
                                                class="w-16 h-24 shrink-0 rounded overflow-hidden bg-surface-700">
                                                <img
                                                    src={getPosterUrl(movie)!}
                                                    alt={movie.title}
                                                    class="w-full h-full object-cover"
                                                    onerror={handlePosterError} />
                                            </div>
                                        {:else}
                                            <div
                                                class="w-16 h-24 shrink-0 rounded bg-surface-700 center">
                                                <span class="text-2xl text-surface-500"
                                                    >{movie.title.charAt(0)}</span>
                                            </div>
                                        {/if}

                                        <!-- Info -->
                                        <div class="flex-1 min-w-0">
                                            <div class="font-medium text-sm truncate">
                                                {movie.title}
                                            </div>
                                            <div
                                                class="flex items-center gap-2 text-xs text-surface-400 mt-1">
                                                {#if movie.year}
                                                    <span>{movie.year}</span>
                                                {/if}
                                                {#if movie.rating && typeof movie.rating === 'number'}
                                                    <span class="flex items-center gap-0.5">
                                                        <svg
                                                            class="w-3 h-3 text-yellow-500"
                                                            fill="currentColor"
                                                            viewBox="0 0 20 20">
                                                            <path
                                                                d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                                                        </svg>
                                                        {movie.rating.toFixed(1)}
                                                    </span>
                                                {/if}
                                                {#if movie.similarity && typeof movie.similarity === 'number'}
                                                    <span class="text-surface-500"
                                                        >{Math.round(movie.similarity * 100)}% match</span>
                                                {/if}
                                            </div>

                                            {#if movie.isWatched}
                                                <span class="badge badge-success mt-1">
                                                    Watched
                                                </span>
                                            {/if}

                                            <!-- Play button if available -->
                                            {#if movie.externalIds?.internal}
                                                <button
                                                    class="mt-2 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors {readOnly
                                                        ? 'bg-surface-700 text-surface-500 cursor-not-allowed'
                                                        : 'bg-primary-500 hover:bg-primary-600 text-white'}"
                                                    onclick={() => {
                                                        const playId = movie.externalIds?.internal;
                                                        if (playId) playSimilarMovie(playId);
                                                    }}
                                                    disabled={readOnly}
                                                    title={readOnly
                                                        ? 'Only host can change content'
                                                        : ''}>
                                                    <Icon src={Play} class="w-3.5 h-3.5" solid />
                                                    Play
                                                </button>
                                            {:else if movie.canRequest}
                                                <span
                                                    class="inline-block text-[10px] px-1.5 py-0.5 bg-surface-700 text-surface-400 rounded mt-2">
                                                    Not available
                                                </span>
                                            {/if}
                                        </div>
                                    </div>
                                {/each}
                            </div>
                        {/if}
                    </div>
                </div>
            </div>
        {/if}
    </div>
{/if}

<style>
    .movie-backdrop {
        display: block;
        width: 100%;
        aspect-ratio: 2;
        object-fit: cover;
    }
    .movie-copy {
        padding: 20px;
    }
    .movie-overview {
        color: #cbd5e1;
        line-height: 1.65;
        font-size: 14px;
    }
    .movie-chapter {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 8px;
        width: 100%;
        text-align: left;
        border-radius: 8px;
    }
    .movie-chapter:hover:not(:disabled),
    .movie-chapter.current {
        background: #818cf822;
    }
    .movie-chapter:disabled {
        cursor: default;
    }
    .chapter-number {
        display: grid;
        place-items: center;
        min-width: 30px;
        height: 30px;
        border-radius: 6px;
        background: #818cf822;
        color: #c7d2fe;
    }
    .movie-chapter strong {
        font-size: 13px;
        font-weight: 500;
    }
    .movie-chapter small,
    .movie-cast small {
        display: block;
        margin-top: 4px;
        color: #94a3b8;
        font-size: 11px;
    }
    .movie-cast {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        list-style: none;
        padding: 0;
    }
    .movie-cast strong {
        font-size: 12px;
        font-weight: 500;
    }
    .movie-actions-divider {
        border-top: 1px solid #ffffff12;
        margin: 24px 0;
    }

    .sidebar-scroll::-webkit-scrollbar {
        width: 4px;
    }

    .sidebar-scroll::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 2px;
    }

    .sidebar-scroll::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 2px;
    }

    .sidebar-scroll::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.5);
    }
</style>
