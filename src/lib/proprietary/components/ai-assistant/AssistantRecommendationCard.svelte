<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * ChatRecommendationCard - Movie/TV show recommendation card
     * Used in the chat recommendations carousel
     * Dispatches events for play/request actions to be handled by parent
     */
    import { imageFromIds } from '$lib/utils/image-utils';
    import type { RecommendedMovie } from '$lib/types/assistant';
    import { isSeries } from '$lib/shared/media-types';
    import * as m from '$lib/paraglide/messages';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { page } from '$app/stores';

    interface Props {
        movie: RecommendedMovie;
        /** Whether the user has permission to make requests (hides request button if false) */
        hasRequestPermission?: boolean;
        /**
         * 'rail' (default): fixed-width card for the horizontal carousel —
         * poster + info block + action button, always visible.
         * 'tile': fluid poster-first tile for the desktop sidebar grid —
         * title on a bottom gradient, full details (rating, genres, action)
         * revealed on hover / keyboard focus.
         */
        variant?: 'rail' | 'tile';
        // Callbacks
        onplay?: (detail: { movie: RecommendedMovie }) => void;
        onrequest?: (detail: { movie: RecommendedMovie }) => void;
        onclick?: (detail: { movie: RecommendedMovie }) => void;
    }

    let {
        movie,
        hasRequestPermission = true,
        variant = 'rail',
        onplay,
        onrequest,
        onclick,
    }: Props = $props();

    const showAction = $derived(
        movie.actionType === 'watch' || (movie.actionType === 'request' && hasRequestPermission),
    );

    let imageError = $state(false);

    /**
     * Get poster URL for the movie
     */
    function getPosterUrl(): string {
        // Cards carry 'movie' | 'series'; the image helper wants 'movie' | 'tv'.
        return (
            imageFromIds(movie.externalIds, 'poster', isSeries(movie.mediaType) ? 'tv' : 'movie', {
                size: 'full',
            }) || '/placeholder-poster.jpg'
        );
    }

    function handleImageError() {
        imageError = true;
    }

    function handleActionClick() {
        if (movie.actionType === 'watch') {
            onplay?.({ movie });
        } else if (movie.actionType === 'request') {
            onrequest?.({ movie });
        }
    }

    function handleCardClick() {
        onclick?.({ movie });
    }
</script>

{#if variant === 'tile'}
    <!-- Poster-first sidebar tile: title always readable on a bottom gradient;
         rating/runtime/genres + action revealed on hover or keyboard focus. -->
    <div
        class="movie-card group relative w-full aspect-[2/3] bg-surface-700 rounded-lg overflow-hidden hover:ring-2 hover:ring-primary-500 focus-within:ring-2 focus-within:ring-primary-500 transition-all text-left"
        role="button"
        tabindex="0"
        onclick={handleCardClick}
        onkeydown={(e) => e.key === 'Enter' && handleCardClick()}>
        {#if imageError}
            <div class="w-full h-full center-col bg-gradient-to-br from-surface-600 to-surface-700">
                <div class="text-5xl mb-2">
                    {isSeries(movie.mediaType) ? '📺' : '🎬'}
                </div>
                <div class="text-3xl font-bold text-white">
                    {movie.title.charAt(0).toUpperCase()}
                </div>
            </div>
        {:else}
            <img
                src={getPosterUrl()}
                alt={movie.title}
                class="absolute inset-0 w-full h-full object-cover"
                loading="lazy"
                onerror={handleImageError} />
        {/if}

        <!-- Availability badge -->
        {#if movie.isAvailable}
            <div
                class="absolute top-1.5 right-1.5 bg-green-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-semibold">
                {m.assistant_available()}
            </div>
        {:else if movie.canRequest && hasRequestPermission}
            <div
                class="absolute top-1.5 right-1.5 bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-semibold">
                {m.assistant_request_item()}
            </div>
        {/if}

        <!-- Always-visible title strip -->
        <div
            class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2 pb-1.5 pt-6 group-hover:opacity-0 group-focus-within:opacity-0 transition-opacity">
            <h4 class="text-xs font-semibold text-white truncate" title={movie.title}>
                {movie.title}
            </h4>
        </div>

        <!-- Hover / focus details overlay -->
        <div
            class="absolute inset-0 bg-black/75 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity p-2 flex flex-col overflow-hidden">
            <h4 class="text-xs font-semibold text-white mb-1" title={movie.title}>
                {movie.title}
            </h4>
            {#if movie.imdbRating || movie.runtimeMinutes}
                <div class="flex items-center gap-1 text-[11px] text-surface-200 mb-1">
                    {#if movie.imdbRating}
                        <span>⭐ {movie.imdbRating.toFixed(1)}</span>
                    {/if}
                    {#if movie.runtimeMinutes}
                        <span>• {movie.runtimeMinutes}min</span>
                    {/if}
                </div>
            {/if}
            {#if movie.genres && movie.genres.length > 0}
                <div class="flex flex-wrap gap-1">
                    {#each movie.genres.slice(0, 2) as genre, genreIdx (genre + '-' + genreIdx)}
                        <span
                            class="text-[10px] bg-surface-600/80 text-surface-200 px-1.5 py-0.5 rounded">
                            {genre}
                        </span>
                    {/each}
                </div>
            {/if}
            {#if showAction}
                <button
                    type="button"
                    class="btn btn-sm variant-filled-primary w-full mt-auto"
                    onclick={stopPropagation(handleActionClick)}>
                    {#if movie.actionType === 'watch'}
                        {m.assistant_watch_now()}
                    {:else if movie.actionType === 'request'}
                        {m.assistant_request()}
                    {/if}
                </button>
            {/if}
        </div>
    </div>
{:else}
    <div
        class="movie-card bg-surface-700 rounded-lg overflow-hidden shrink-0 w-44 flex flex-col hover:ring-2 hover:ring-primary-500 transition-all text-left"
        role="button"
        tabindex="0"
        onclick={handleCardClick}
        onkeydown={(e) => e.key === 'Enter' && handleCardClick()}>
        <!-- Poster -->
        <div class="relative aspect-[2/3] bg-surface-600 shrink-0">
            {#if imageError}
                <div
                    class="w-full h-full center-col bg-gradient-to-br from-surface-600 to-surface-700">
                    <div class="text-5xl mb-2">
                        {isSeries(movie.mediaType) ? '📺' : '🎬'}
                    </div>
                    <div class="text-3xl font-bold text-white">
                        {movie.title.charAt(0).toUpperCase()}
                    </div>
                </div>
            {:else}
                <img
                    src={getPosterUrl()}
                    alt={movie.title}
                    class="w-full h-full object-cover"
                    onerror={handleImageError} />
            {/if}

            <!-- Availability badge -->
            {#if movie.isAvailable}
                <div
                    class="absolute top-2 right-2 bg-green-500 text-white text-xs px-2 py-1 rounded-full font-semibold">
                    {m.assistant_available()}
                </div>
            {:else if movie.canRequest && hasRequestPermission}
                <div
                    class="absolute top-2 right-2 bg-blue-500 text-white text-xs px-2 py-1 rounded-full font-semibold">
                    {m.assistant_request_item()}
                </div>
            {/if}
        </div>

        <!-- Movie Info -->
        <div class="p-2 flex flex-col flex-1">
            <h4 class="text-xs font-semibold text-white truncate mb-1" title={movie.title}>
                {movie.title}
            </h4>

            <!-- Ratings -->
            {#if movie.imdbRating || movie.runtimeMinutes}
                <div class="flex items-center gap-1 text-xs text-surface-300 mb-1">
                    {#if movie.imdbRating}
                        <span class="flex items-center gap-0.5">
                            <!-- Ratings can carry long float tails (e.g. 7.139) — show one decimal. -->
                            ⭐ {movie.imdbRating.toFixed(1)}
                        </span>
                    {/if}
                    {#if movie.runtimeMinutes}
                        <span class="text-[10px]">• {movie.runtimeMinutes}min</span>
                    {/if}
                </div>
            {/if}

            <!-- Genres -->
            {#if movie.genres && movie.genres.length > 0}
                <div class="flex flex-wrap gap-1 mb-2">
                    {#each movie.genres.slice(0, 2) as genre, genreIdx (genre + '-' + genreIdx)}
                        <span
                            class="text-[10px] bg-surface-600 text-surface-300 px-1.5 py-0.5 rounded">
                            {genre}
                        </span>
                    {/each}
                </div>
            {/if}

            <!-- Action Button (pinned to bottom for alignment across cards) -->
            {#if movie.actionType === 'watch' || (movie.actionType === 'request' && hasRequestPermission)}
                <button
                    type="button"
                    class="btn btn-sm variant-filled-primary w-full mt-auto"
                    onclick={stopPropagation(handleActionClick)}>
                    {#if movie.actionType === 'watch'}
                        {m.assistant_watch_now()}
                    {:else if movie.actionType === 'request'}
                        {m.assistant_request()}
                    {/if}
                </button>
            {/if}
        </div>
    </div>
{/if}

<style>
    .movie-card {
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }

    .movie-card:hover {
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    }
</style>
