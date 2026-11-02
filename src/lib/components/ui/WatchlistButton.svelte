<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteDate } from 'svelte/reactivity';

    /**
     * Reusable Watchlist Button Component
     * Allows adding/removing items from watchlist with consistent styling
     *
     * Uses externalIds for provider-agnostic ID handling.
     */
    import { Icon, Bolt } from 'svelte-hero-icons';
    import type { ExternalIds } from '$lib/types/api-common';
    import {
        watchlistItems,
        addToWatchlistStore,
        removeFromWatchlistStore,
        type WatchlistItem,
        type SaveMovieRequest,
        type RemoveMovieRequest,
    } from '$lib/stores/watchlist';
    import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
    import * as m from '$lib/paraglide/messages';

    import { stopPropagation } from '$lib/utils/event-helpers';
    import * as aiApi from '$lib/api/ai';

    interface Props {
        // Required props - uses externalIds for provider-agnostic ID handling
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv';
        title: string;
        // Optional props with defaults
        overview?: string;
        rating?: string;
        criticRating?: number | undefined;
        canRequest?: boolean;
        isAvailable?: boolean;
        availabilitySource?: string;
        // Styling props
        variant?: 'button' | 'icon'; // button (Skeleton btn) or icon (circle)
        size?: 'sm' | 'md' | 'lg';
    }

    let {
        externalIds,
        mediaType,
        title,
        overview = '',
        rating = '0',
        criticRating = undefined,
        canRequest = false,
        isAvailable = false,
        availabilitySource = '',
        variant = 'button',
        size = 'md',
    }: Props = $props();

    let isProcessing = $state(false);

    // Compute composite key for comparison
    let compositeKey = $derived(mediaCompositeKey(externalIds, mediaType));

    // Check if saved using composite key (handles TMDB ID collisions)
    let isSaved = $derived(
        $watchlistItems.some(
            (item) => mediaCompositeKey(item.externalIds, item.mediaType) === compositeKey,
        ),
    );

    async function toggleWatchlist() {
        if (isProcessing) return;

        isProcessing = true;

        try {
            if (isSaved) {
                // Remove from watchlist
                console.log('[WatchlistButton] Removing from watchlist:', title);

                const { error: removeError } = await aiApi.unsaveMovie({
                    externalIds,
                    mediaType,
                });

                if (!removeError) {
                    removeFromWatchlistStore(externalIds, mediaType);
                } else {
                    console.error('[WatchlistButton] Failed to remove from watchlist');
                }
            } else {
                // Add to watchlist
                console.log('[WatchlistButton] Adding to watchlist:', title);

                const watchlistItem: WatchlistItem = {
                    externalIds,
                    mediaType: mediaType,
                    title: title,
                    overview: overview,
                    rating: rating,
                    criticRating: criticRating,
                    canRequest: canRequest,
                    isAvailable: isAvailable,
                    availabilitySource: availabilitySource,
                    savedAt: new SvelteDate().toISOString(),
                };

                const { error: saveError } = await aiApi.saveMovie({
                    externalIds,
                    mediaType,
                    title: title,
                    overview: overview,
                    rating: Number.parseFloat(rating) || 0,
                    criticRating: criticRating,
                    canRequest,
                    isAvailable,
                    availabilitySource,
                });

                if (!saveError) {
                    addToWatchlistStore(watchlistItem);
                } else {
                    console.error('[WatchlistButton] Failed to save to watchlist');
                }
            }
        } catch (error) {
            console.error('[WatchlistButton] Error updating watchlist:', error);
        } finally {
            isProcessing = false;
        }
    }

    // Size classes
    let iconSizeClass = $derived(size === 'sm' ? 'w-4 h-4' : size === 'lg' ? 'w-6 h-6' : 'w-5 h-5');
    let btnSizeClass = $derived(size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '');
</script>

{#if variant === 'button'}
    <!-- Button variant (Skeleton UI button) -->
    <button
        onclick={stopPropagation(toggleWatchlist)}
        class="btn {btnSizeClass} transition-all duration-300 {isSaved
            ? 'variant-filled-warning'
            : 'variant-ghost-surface hover:variant-filled-primary'}"
        title={isSaved ? m.watchlist_remove() : m.watchlist_add()}
        disabled={isProcessing}>
        {#if isProcessing}
            <span class="loading-spinner"></span>
        {:else}
            <Icon src={Bolt} class={iconSizeClass} solid={isSaved} />
            {#if size !== 'sm'}
                <span>{isSaved ? m.watchlist_saved() : m.watchlist()}</span>
            {/if}
        {/if}
    </button>
{:else}
    <!-- Icon variant (circular button) -->
    <button
        onclick={stopPropagation(toggleWatchlist)}
        class="p-2 rounded-full transition-all duration-200 {isSaved
            ? 'text-blue-400 bg-blue-400/20 shadow-lg shadow-blue-400/25 hover:text-red-400 hover:bg-red-400/20 hover:shadow-red-400/25'
            : isProcessing
              ? 'text-yellow-400 bg-yellow-400/20'
              : 'text-gray-400 hover:text-white hover:bg-blue-400/20 hover:shadow-lg hover:shadow-blue-400/10'}"
        title={isSaved
            ? m.watchlist_in_list()
            : isProcessing
              ? m.watchlist_processing()
              : m.watchlist_add()}
        disabled={isProcessing}>
        {#if isProcessing}
            <span
                class="loading-spinner {iconSizeClass}"
                style="border-color: rgb(var(--color-warning-400-rgb) / 0.3); border-top-color: var(--color-warning-400);"
            ></span>
        {:else}
            <Icon src={Bolt} class={iconSizeClass} solid={isSaved} />
        {/if}
    </button>
{/if}
