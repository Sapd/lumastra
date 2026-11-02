<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import {
        Icon,
        XMark,
        Sparkles,
        Bars3,
        Squares2x2,
        Funnel,
        EyeSlash,
        CheckCircle,
    } from 'svelte-hero-icons';
    import { env } from '$env/dynamic/public';
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { SectionRenderer } from '$lib/components/sections';
    import { WatchlistButton } from '$lib/components/ui';
    import { navigateToWatch } from '$lib/stores/watch-navigation';
    import { buildMediaKey } from '$lib/utils/media-id-helpers';
    import { toasts } from '$lib/stores/toast.store';
    import { modals } from '$lib/stores/modal.store';
    import { openMediaModal, handleRequestAction } from '$lib/utils/modal-utils';
    import { imageFromIds, fallbackImage } from '$lib/utils/image-utils';
    import { buildMediaApiUrl, hasValidExternalId } from '$lib/utils/media-id-helpers';
    import type { ExternalIds } from '$lib/types/api-common';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import { isMovie, isSeries } from '$lib/shared/media-types';
    import { resolveMediaAvailability } from '$lib/shared/media-availability.js';
    import type { MediaPreview as SimilarItem } from '$lib/schemas/api-media-preview';
    import { mediaPreviewToUniversal } from '$lib/utils/media-preview';
    import { FALLBACK_IMAGE } from '$lib/constants/images';
    import * as m from '$lib/paraglide/messages';

    // ==========================================================================
    // Constants
    // ==========================================================================

    const SIMILAR_LIMIT = 20;

    // ==========================================================================
    // Types
    // ==========================================================================

    interface SourceMedia {
        externalIds?: ExternalIds;
        name: string;
        type: 'movie' | 'tv';
    }

    // ==========================================================================
    // Props (from modal-utils.ts openSimilarMoviesModal)
    // ==========================================================================

    interface Props {
        // Injected by ModalContainer - kept for potential future use with closeById()
        modalId: string;
        sourceMedia: SourceMedia;
        similar?: SimilarItem[];
        loading?: boolean;
    }

    let {
        modalId,
        sourceMedia = $bindable(),
        similar = $bindable([]),
        loading = $bindable(false),
    }: Props = $props();

    // ==========================================================================
    // Constants & Stores
    // ==========================================================================

    const requestUrl = env.PUBLIC_REQUESTURL || '';

    // Helper to get externalIds from source media
    function getSourceExternalIds(source: SourceMedia): ExternalIds {
        return source.externalIds && Object.keys(source.externalIds).length > 0
            ? source.externalIds
            : {};
    }

    let fetchFailed = $state(false);

    // Guard against concurrent initial fetches (prevents reactive statement from firing multiple times)
    let fetchingInitialData = $state(false);

    /**
     * Fetch similar data from API and update props using externalIds
     */
    async function fetchSimilarDataByExternalIds(
        externalIds: ExternalIds,
        name: string,
        mediaType: 'movie' | 'tv',
    ): Promise<void> {
        if (fetchingInitialData) return;
        fetchingInitialData = true;
        fetchFailed = false;
        sourceMedia = { externalIds, name, type: mediaType };
        similar = [];
        loading = true;
        try {
            // Build provider-agnostic URL using media key
            const mediaUrl = buildMediaApiUrl('/api/media', externalIds, mediaType);
            if (!mediaUrl) {
                throw new Error('No valid external ID to fetch similar items');
            }
            const response = await fetch(`${mediaUrl}/similar?limit=${SIMILAR_LIMIT}`);
            if (!response.ok) {
                throw new Error(`Failed to fetch similar (${response.status})`);
            }
            const data = (await response.json()) as { items: SimilarItem[]; truncated: boolean };

            // Update props with fetched data
            similar = data.items;
            resetFilters();
            const contentArea = document.querySelector('.similar-content-area');
            if (contentArea) contentArea.scrollTop = 0;
        } catch (error) {
            console.error('[SimilarMoviesModal] Error fetching similar:', error);
            toasts.error(m.similar_fetch_error());
            fetchFailed = true;
        } finally {
            loading = false;
            fetchingInitialData = false;
        }
    }

    // ==========================================================================
    // Filter & Sort State
    // ==========================================================================

    let sortBy: 'similarity' | 'rating' | 'year' = $state('similarity');
    let hideWatched = $state(false);
    let availableOnly = $state(false);
    let viewMode: 'grid' | 'list' = $state('grid');

    /** Reset all filters to default state */
    function resetFilters(): void {
        sortBy = 'similarity';
        hideWatched = false;
        availableOnly = false;
    }

    // ==========================================================================
    // Transform & Build Section
    // ==========================================================================

    function buildSubtitle(item: SimilarItem): string {
        const parts: string[] = [];
        // Similarity percentage (only show if > 0)
        if ((item.score ?? 0) > 0) {
            parts.push(`${Math.round((item.score ?? 0) * 100)}%`);
        }
        // Year
        if (item.year) parts.push(String(item.year));
        // Genres (first 2)
        if (item.genres?.length) {
            parts.push(item.genres.slice(0, 2).join(', '));
        }
        return parts.join(' • ');
    }

    function transformSimilarItem(item: SimilarItem): UniversalMediaItem {
        return {
            ...mediaPreviewToUniversal(item),
            subtitle: buildSubtitle(item),
            clickData: { originalItem: item },
        };
    }

    // ==========================================================================
    // Event Handlers
    // ==========================================================================

    function handleItemClick(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;

        // Use shared utility for consistent modal opening
        // NOTE: openMediaModal now uses modals.open() which stacks modals
        openMediaModal(
            {
                title: item.title,
                overview: item.overview,
                mediaType: item.mediaType,
                year: item.year ? String(item.year) : undefined,
                rating:
                    typeof item.rating === 'number'
                        ? item.rating
                        : parseFloat(String(item.rating)) || 0,
                rt_critic: item.criticRating,
                rt_audience: item.audienceRating,
                letterboxd_rating: item.letterboxdRating,
                letterboxd_votes: item.letterboxdVotes,
                mdblist_score: item.mdblistScore,
                metacritic_score: item.metacriticScore,
                trakt_score: item.traktScore,
                externalIds: item.externalIds,
                genres: item.genres,
                isAvailable: resolveMediaAvailability(item),
                canRequest: item.canRequest,
            },
            item.image || '',
        );
    }

    function handleItemPlay(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        const playableId = item.externalIds?.internal;
        if (playableId && resolveMediaAvailability(item)) {
            const key = buildMediaKey(item.externalIds, item.mediaType) ?? playableId;
            void navigateToWatch(key);
        } else if (item.canRequest) {
            // Use shared utility for consistent request handling
            handleRequestAction(
                {
                    externalIds: item.externalIds,
                    mediaType: item.mediaType,
                    title: item.title,
                },
                false,
                requestUrl,
                hasRequestPermission,
            ); // false = use external URL, not modal
        }
    }

    function handleItemRequest(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        handleRequestAction(
            {
                externalIds: item.externalIds,
                mediaType: item.mediaType,
                title: item.title,
            },
            false,
            requestUrl,
            hasRequestPermission,
        );
    }

    function handleItemMore(data: { section: PageSection; item: UniversalMediaItem }) {
        const { item } = data;
        // Open similar for this item (chain of similar)
        // Only fetch similar for movie or tv types
        if (
            item.externalIds &&
            hasValidExternalId(item.externalIds) &&
            (isMovie(item.mediaType) || isSeries(item.mediaType))
        ) {
            // Inside the isMovie() || isSeries() guard above, but isSeries()
            // matches 'series' as well as 'tv' — collapse rather than assert.
            void fetchSimilarDataByExternalIds(
                item.externalIds,
                item.title,
                isMovie(item.mediaType) ? 'movie' : 'tv',
            );
        }
    }

    // Permission check
    let hasRequestPermission = $derived($page.data?.user?.hasRequestPermission !== false);
    // The modal owns initial, chained, and retry requests.
    $effect(() => {
        if (loading && similar.length === 0 && !fetchingInitialData) {
            const { externalIds, name, type } = sourceMedia;
            untrack(() => {
                void fetchSimilarDataByExternalIds(externalIds ?? {}, name, type);
            });
        }
    });
    // Reactive filtering & sorting (use spread to avoid mutating original array)
    let filteredSimilar = $derived(
        [...similar]
            .filter((item) => !hideWatched || !item.progress?.finished)
            .filter((item) => !availableOnly || item.availability?.isAvailable)
            .sort((a, b) => {
                if (sortBy === 'similarity') return (b.score || 0) - (a.score || 0);
                if (sortBy === 'rating') return (b.rating || 0) - (a.rating || 0);
                if (sortBy === 'year') return (b.year || 0) - (a.year || 0);
                return 0;
            }),
    );
    // Stats for filter display (calculated in single pass)
    let filterStats = $derived(
        similar.reduce(
            (acc, item) => {
                if (item.progress?.finished) acc.watched++;
                if (item.availability?.isAvailable) acc.available++;
                return acc;
            },
            { watched: 0, available: 0 },
        ),
    );
    let watchedCount = $derived(filterStats.watched);
    let availableCount = $derived(filterStats.available);
    // Build reactive section from filtered items
    let section = $derived({
        id: 'similar-grid',
        type: viewMode,
        title: '',
        items: filteredSimilar.map(transformSimilarItem),
        meta: {
            accentColor: 'purple',
            showMoreButton: true,
        },
    } as PageSection);
</script>

<div
    id={modalId}
    class="card p-4 sm:p-6 w-screen sm:w-full sm:max-w-5xl h-screen sm:h-auto sm:max-h-[90vh] overflow-hidden flex flex-col bg-surface-900 modal-similar-mobile">
    <!-- Header -->
    <header class="between mb-4">
        <div class="flex items-center gap-3">
            <Icon src={Sparkles} class="w-6 h-6 text-purple-400" />
            <div>
                <h3 class="text-xl sm:text-2xl font-bold text-white">
                    {isSeries(sourceMedia.type)
                        ? m.modal_ai_similar_series()
                        : m.modal_ai_similar_movies()}
                </h3>
            </div>
        </div>
        <button
            type="button"
            class="btn-icon variant-ghost-surface hover:variant-filled-surface"
            onclick={() => modals.close()}
            aria-label={m.btn_close()}>
            <Icon src={XMark} class="w-6 h-6" />
        </button>
    </header>

    <!-- Source Media Card -->
    {#if hasValidExternalId(sourceMedia.externalIds) && !loading}
        {@const sourceExternalIds = getSourceExternalIds(sourceMedia)}
        <div
            class="flex items-center gap-4 mb-4 p-3 bg-surface-800/50 rounded-lg border border-surface-700">
            <img
                src={imageFromIds(sourceExternalIds, 'poster', sourceMedia.type, {
                    size: 'thumb',
                }) ?? FALLBACK_IMAGE}
                alt={sourceMedia.name}
                class="w-12 h-18 sm:w-16 sm:h-24 object-cover rounded shadow-lg"
                use:fallbackImage />
            <div class="flex-1 min-w-0">
                <p class="text-xs text-surface-400 uppercase tracking-wide">
                    {m.modal_based_on_label()}
                </p>
                <h4 class="text-base sm:text-lg font-semibold text-white truncate">
                    {sourceMedia.name}
                </h4>
                <p class="text-xs text-surface-500">
                    {isSeries(sourceMedia.type) ? m.card_series() : m.media_movie()}
                </p>
            </div>
            <!-- Watchlist button for source -->
            <WatchlistButton
                externalIds={sourceExternalIds}
                mediaType={sourceMedia.type}
                title={sourceMedia.name}
                variant="icon"
                size="md" />
        </div>
    {/if}

    <!-- Filter & Sort Bar -->
    {#if !loading && similar.length > 0}
        <div
            class="flex flex-wrap items-center gap-2 sm:gap-3 mb-4 pb-3 border-b border-surface-700">
            <!-- Sort dropdown -->
            <select
                bind:value={sortBy}
                class="select text-xs sm:text-sm py-1.5 px-2 sm:px-3 w-auto min-w-0 bg-surface-800 border-surface-600">
                <option value="similarity">{m.similar_sort_match()}</option>
                <option value="rating">{m.similar_sort_rating()}</option>
                <option value="year">{m.similar_sort_year()}</option>
            </select>

            <!-- Hide watched toggle -->
            <button
                onclick={() => (hideWatched = !hideWatched)}
                class="btn btn-sm py-1.5 px-2 sm:px-3 {hideWatched
                    ? 'variant-filled-primary'
                    : 'variant-soft-surface'}"
                title={m.similar_hide_watched()}
                disabled={watchedCount === 0}>
                <Icon src={EyeSlash} class="w-4 h-4" />
                <span class="hidden sm:inline">{m.similar_hide_watched()}</span>
                {#if watchedCount > 0}
                    <span class="badge variant-filled-surface text-xs ml-1">{watchedCount}</span>
                {/if}
            </button>

            <!-- Available only toggle -->
            <button
                onclick={() => (availableOnly = !availableOnly)}
                class="btn btn-sm py-1.5 px-2 sm:px-3 {availableOnly
                    ? 'variant-filled-success'
                    : 'variant-soft-surface'}"
                title={m.similar_available_only()}
                disabled={availableCount === 0}>
                <Icon src={CheckCircle} class="w-4 h-4" />
                <span class="hidden sm:inline">{m.similar_available_only()}</span>
                {#if availableCount > 0}
                    <span class="badge variant-filled-surface text-xs ml-1">{availableCount}</span>
                {/if}
            </button>

            <!-- Spacer -->
            <div class="flex-1"></div>

            <!-- View mode toggle -->
            <div class="btn-group variant-soft-surface" role="group" aria-label="View mode">
                <button
                    class="btn btn-sm px-2 {viewMode === 'grid' ? 'variant-filled-primary' : ''}"
                    onclick={() => (viewMode = 'grid')}
                    title={m.similar_view_grid()}
                    aria-pressed={viewMode === 'grid'}>
                    <Icon src={Squares2x2} class="w-4 h-4" />
                </button>
                <button
                    class="btn btn-sm px-2 {viewMode === 'list' ? 'variant-filled-primary' : ''}"
                    onclick={() => (viewMode = 'list')}
                    title={m.similar_view_list()}
                    aria-pressed={viewMode === 'list'}>
                    <Icon src={Bars3} class="w-4 h-4" />
                </button>
            </div>

            <!-- Result count -->
            <span class="text-xs text-surface-500 whitespace-nowrap">
                {filteredSimilar.length}/{similar.length}
            </span>
        </div>
    {/if}

    <!-- Content -->
    <div class="similar-content-area flex-1 overflow-y-auto pr-1">
        {#if loading}
            <div class="center py-12">
                <span
                    class="loading-spinner loading-spinner-lg"
                    style="border-color: rgb(var(--color-purple-500-rgb) / 0.3); border-top-color: var(--color-purple-500);"
                ></span>
            </div>
        {:else if fetchFailed}
            <div class="text-center py-12 px-6" role="alert">
                <p class="text-gray-300 text-lg mb-4">{m.similar_fetch_error()}</p>
                <button
                    type="button"
                    class="btn variant-soft-primary"
                    onclick={() =>
                        fetchSimilarDataByExternalIds(
                            getSourceExternalIds(sourceMedia),
                            sourceMedia.name,
                            sourceMedia.type,
                        )}>
                    {m.btn_retry()}
                </button>
            </div>
        {:else if similar.length === 0}
            <div class="text-center py-12 px-6">
                <div class="text-6xl mb-4">🤖</div>
                <p class="text-gray-300 text-lg mb-2">
                    {isSeries(sourceMedia.type)
                        ? m.modal_no_similar_series_found()
                        : m.modal_no_similar_found()}
                </p>
                <p class="text-gray-500 text-sm">
                    {isSeries(sourceMedia.type)
                        ? m.modal_no_series_embeddings()
                        : m.modal_no_embeddings()}<br />
                    {m.modal_embeddings_background()}
                </p>
            </div>
        {:else if filteredSimilar.length === 0}
            <!-- All filtered out -->
            <div class="text-center py-12 px-6">
                <Icon src={Funnel} class="w-12 h-12 mx-auto mb-4 text-surface-500" />
                <p class="text-gray-300 text-lg mb-2">
                    {m.similar_all_filtered()}
                </p>
                <p class="text-gray-500 text-sm mb-4">
                    {m.similar_try_adjusting()}
                </p>
                <button class="btn variant-soft-primary" onclick={resetFilters}>
                    {m.similar_clear_filters()}
                </button>
            </div>
        {:else}
            <SectionRenderer
                {section}
                {hasRequestPermission}
                onitemClick={handleItemClick}
                onitemPlay={handleItemPlay}
                onitemRequest={handleItemRequest}
                onitemMore={handleItemMore} />
        {/if}
    </div>

    <!-- Footer (desktop only - mobile uses header close button) -->
    <footer
        class="hidden sm:flex justify-between items-center gap-3 mt-6 pt-4 border-t border-surface-700 shrink-0">
        <span class="text-xs text-surface-500">{m.similar_click_for_details()}</span>
        <button type="button" class="btn variant-ghost-surface" onclick={() => modals.close()}
            >{m.btn_close()}</button>
    </footer>
</div>

<style>
    /* Mobile fullscreen modal styles */
    @media (max-width: 639px) {
        :global(.modal-similar-mobile) {
            width: 100vw !important;
            height: 100vh !important;
            height: 100dvh !important;
            max-width: none !important;
            max-height: none !important;
            border-radius: 0 !important;
            margin: 0 !important;
            padding: 1rem !important;
            padding-top: calc(1rem + env(safe-area-inset-top, 0px)) !important;
            padding-bottom: calc(2rem + env(safe-area-inset-bottom, 0px)) !important;
            padding-left: calc(1rem + env(safe-area-inset-left, 0px)) !important;
            padding-right: calc(1rem + env(safe-area-inset-right, 0px)) !important;
        }
    }

    /* PWA standalone mode */
    @media (display-mode: standalone) {
        :global(.modal-similar-mobile) {
            padding-top: calc(1rem + env(safe-area-inset-top, 0px)) !important;
            padding-bottom: calc(1.5rem + env(safe-area-inset-bottom, 0px)) !important;
        }
    }

    /* Compact select on mobile */
    select.select {
        background-position: right 0.5rem center;
        padding-right: 1.75rem;
    }
</style>
