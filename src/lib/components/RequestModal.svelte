<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * RequestModal - Modal for requesting media from Jellyseerr
     *
     * Features:
     * - Shows poster, title, overview, and quota information
     * - Displays YouTube trailer if available and feature is enabled
     * - Handles request submission
     * - Shows success/error states
     */
    import { onMount } from 'svelte';
    import { Icon } from 'svelte-hero-icons';
    import { XMark, ExclamationTriangle, Film, Tv } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import { modals } from '$lib/stores/modal.store';
    import { requestNotifications } from '$lib/stores/request-notifications';
    import { featureYoutubeModals } from '$lib/stores/appConfig';
    import { youtube_parser } from '../../utility';
    import type { MediaDetailVideo } from '$lib/types/api-media';
    import { buildMediaApiUrl } from '$lib/utils/media-id-helpers';
    import { imageFromIds } from '$lib/utils/image-utils';
    import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
    import type { ApiMediaTypeInput } from '$lib/types/api-common';
    import type { ExternalIds } from '$lib/types/api-common';
    import * as m from '$lib/paraglide/messages';
    import * as contentApi from '$lib/api/content';
    import { isMovie, isSeries } from '$lib/shared/media-types';

    // Props passed from modal-utils openRequestModal()
    interface Props {
        externalIds: ExternalIds;
        /** Canonical: 'movie' | 'series'. Legacy 'tv' is still accepted by isSeries(). */
        mediaType: 'movie' | 'series';
        title: string;
        posterPath?: string | null | undefined;
        year?: string | undefined;
        overview?: string | undefined;
        seasons?: number[] | undefined;
        // Injected by ModalContainer - kept for potential future use with closeById()
        modalId: string;
    }

    let { externalIds, mediaType, title, posterPath, year, overview, seasons, modalId }: Props =
        $props();

    // State
    let viewState = $state<'loading' | 'ready' | 'submitting' | 'success' | 'error'>('loading');
    let errorMessage = $state('');
    let trailerUrl = $state<string | null>(null);
    let fetchedOverview = $state('');
    type RequestQuota = {
        movie: {
            limit: number;
            used: number;
            remaining: number | null;
            days: number;
            restricted: boolean;
        };
        tv: {
            limit: number;
            used: number;
            remaining: number | null;
            days: number;
            restricted: boolean;
        };
    };

    let quota = $state<RequestQuota | null>(null);

    // Computed
    let currentQuota = $derived(isMovie(mediaType) ? quota?.movie : quota?.tv);
    let canRequest = $derived(
        currentQuota &&
            !currentQuota.restricted &&
            (currentQuota.remaining === null || currentQuota.remaining > 0),
    );
    let quotaDisplay = $derived(getQuotaDisplay(currentQuota));
    let showTrailer = $derived($featureYoutubeModals && trailerUrl);
    let videoId = $derived(trailerUrl ? youtube_parser(trailerUrl) : false);
    let displayOverview = $derived(overview || fetchedOverview);

    function getQuotaDisplay(q: typeof currentQuota): string {
        if (!q) return '';
        if (q.remaining === null) return m.misc_unlimited();
        return m.misc_available_of({ remaining: q.remaining, limit: q.limit });
    }

    function getPosterUrl(): string {
        // The inline poster renders at ~96×144 px (w-24 h-36) so medium (350w)
        // is plenty even at 3× DPR. Prefer rebuilding from externalIds at the
        // right size; fall back to caller-provided posterPath only when there
        // are no usable externalIds.
        // imageFromIds expects 'movie'|'tv' for composite-key generation;
        // map canonical 'series' → 'tv' via toTmdbType.
        //
        // `?? 'movie'` cannot be reached: this component's `mediaType` prop is
        // typed `'movie' | 'series'` (requests exist for nothing else), which is
        // exactly the set toTmdbType answers non-null for. Written as a checked
        // fallback rather than an assertion.
        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- request media is schema-constrained to movie/series.
        const derived = imageFromIds(externalIds, 'poster', toTmdbType(mediaType) ?? 'movie', {
            size: 'medium',
        });
        if (derived) return derived;
        return posterPath ?? '';
    }

    async function loadData() {
        try {
            // Load quota and TMDB data in parallel
            // Build provider-agnostic API URL for media details
            let mediaDetailsUrl: string | null = null;
            if (externalIds && mediaType) {
                // Storage token: it goes into the `tmdb:<id>:<type>` composite key,
                // which is matched verbatim against external_ids.media_type ('tv').
                const apiMediaType: ApiMediaTypeInput = isSeries(mediaType) ? 'series' : 'movie';
                mediaDetailsUrl = buildMediaApiUrl('/api/media', externalIds, apiMediaType);
                if (mediaDetailsUrl && $featureYoutubeModals) {
                    mediaDetailsUrl += '?append=videos';
                }
            }

            const [quotaResult, tmdbResponse] = await Promise.all([
                contentApi.getRequestQuota(),
                mediaDetailsUrl ? fetch(mediaDetailsUrl) : Promise.resolve(null),
            ]);

            // Process quota
            const quotaData = quotaResult.data as {
                quota?: RequestQuota;
            } | null;
            quota = quotaData?.quota ?? null;

            // Process TMDB data (overview and trailer)
            if (tmdbResponse && tmdbResponse.ok) {
                const tmdbData = (await tmdbResponse.json()) as {
                    overview?: string;
                    videos?: { results?: MediaDetailVideo[] };
                };

                // Extract overview
                if (tmdbData?.overview) {
                    fetchedOverview = tmdbData.overview;
                }

                // Extract trailer if videos are available
                if (tmdbData?.videos?.results) {
                    const trailer = tmdbData.videos.results.find(
                        (video) =>
                            video.site === 'YouTube' &&
                            (video.type === 'Trailer' || video.type === 'Teaser'),
                    );
                    if (trailer) {
                        trailerUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
                    }
                }
            }

            viewState = 'ready';
        } catch (err) {
            console.error('Failed to load data:', err);
            quota = null;
            viewState = 'ready';
            toasts.error(m.error_generic());
        }
    }

    const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null;

    async function submitRequest() {
        if (viewState !== 'ready') return;

        if (!externalIds || !mediaType) {
            toasts.error(m.misc_missing_data());
            return;
        }

        viewState = 'submitting';

        try {
            const requestBody: {
                externalIds: ExternalIds;
                mediaType: string;
                seasons?: number[];
            } = { externalIds, mediaType };
            if (seasons && seasons.length > 0) {
                requestBody.seasons = seasons;
            }

            const {
                data: responseData,
                error: apiError,
                validationError,
            } = await contentApi.submitRequest(requestBody);

            const data = isRecord(responseData)
                ? (responseData as unknown as { requestedAt?: string })
                : {};
            const requestedAt = typeof data.requestedAt === 'string' ? data.requestedAt : undefined;

            if (!apiError && !validationError) {
                // Add to notification tracker for status updates
                // Use server timestamp from response to avoid clock skew issues
                requestNotifications.addRequest(
                    externalIds,
                    mediaType,
                    title,
                    posterPath || undefined,
                    seasons,
                    requestedAt, // Server timestamp
                );

                // Close modal immediately and show toast notification
                await modals.close();
                toasts.success(m.request_submitted_toast({ title }), 4000);
            } else {
                errorMessage =
                    apiError || (validationError ? m.error_generic() : m.request_failed());
                viewState = 'error';
            }
        } catch (err) {
            console.error('Request failed:', err);
            errorMessage = m.request_network_error();
            viewState = 'error';
        }
    }

    async function close() {
        await modals.close();
    }

    onMount(() => {
        loadData();
    });
</script>

<!-- Modal Background -->
<div
    id={modalId}
    class="modal-example-form card p-4 w-modal shadow-xl space-y-4 bg-surface-800 max-h-[90vh] overflow-y-auto">
    <!-- Header with Close Button -->
    <header class="flex justify-between items-start">
        <h3 class="text-xl font-bold text-white">{m.btn_request()}</h3>
        <button type="button" class="btn-icon variant-ghost-surface" onclick={close}>
            <Icon src={XMark} class="w-5 h-5" />
        </button>
    </header>

    <!-- YouTube Trailer -->
    {#if showTrailer && videoId}
        <div class="relative w-full aspect-video rounded-lg overflow-hidden bg-surface-900">
            <iframe
                src="https://www.youtube-nocookie.com/embed/{videoId}?autoplay=0&rel=0&modestbranding=1"
                title="Trailer for {title}"
                class="absolute inset-0 w-full h-full"
                frameborder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen></iframe>
        </div>
    {/if}

    <!-- Media Info -->
    <div class="flex gap-4">
        <!-- Poster -->
        {#if getPosterUrl()}
            <img
                src={getPosterUrl()}
                alt={title}
                class="w-24 h-36 object-cover rounded-lg shadow-lg shrink-0" />
        {:else}
            <div class="w-24 h-36 bg-surface-700 rounded-lg center shrink-0">
                <Icon src={isMovie(mediaType) ? Film : Tv} class="w-12 h-12 text-surface-400" />
            </div>
        {/if}

        <!-- Title, Year, Type & Overview -->
        <div class="flex flex-col min-w-0">
            <h4 class="text-lg font-bold text-white truncate">
                {title || m.misc_unknown()}
            </h4>
            {#if year}
                <p class="text-surface-400 text-sm">{year}</p>
            {/if}
            <p class="text-sm text-surface-400">
                {isMovie(mediaType) ? m.media_movie() : m.media_series()}
            </p>
            {#if displayOverview && !showTrailer}
                <p class="text-surface-300 text-sm mt-2 line-clamp-3">
                    {displayOverview}
                </p>
            {/if}
        </div>
    </div>

    <!-- Overview (shown below when trailer is present) -->
    {#if displayOverview && showTrailer}
        <p class="text-surface-300 text-sm line-clamp-4">{displayOverview}</p>
    {/if}

    <!-- Selected Seasons Info (for TV shows) -->
    {#if isSeries(mediaType) && seasons && seasons.length > 0}
        <div class="bg-primary-500/10 border border-primary-500/20 rounded-lg p-3">
            <p class="text-sm text-surface-300">
                {m.requesting_seasons({
                    count: seasons.length,
                })}:
                <span class="font-medium text-white">
                    {seasons.map((s) => `${m.misc_season()} ${s}`).join(', ')}
                </span>
            </p>
        </div>
    {/if}

    <!-- Content -->
    <div class="pt-2">
        {#if viewState === 'loading'}
            <div class="center py-4">
                <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
            </div>
        {:else if viewState === 'ready'}
            <!-- Quota Info -->
            {#if quota}
                <div class="bg-surface-700 rounded-lg p-3 mb-4">
                    <div class="flex items-center gap-2 text-sm">
                        <Icon
                            src={isMovie(mediaType) ? Film : Tv}
                            class="w-4 h-4 text-surface-400" />
                        <span class="text-surface-300">
                            {isMovie(mediaType) ? m.tab_movies() : m.tab_series()}:
                        </span>
                        <span class="font-semibold text-white">{quotaDisplay}</span>
                        {#if currentQuota && currentQuota.days > 0}
                            <span class="text-surface-400 text-xs"
                                >({m.request_days({
                                    days: currentQuota.days,
                                })})</span>
                        {/if}
                    </div>
                    {#if currentQuota?.restricted}
                        <p class="text-warning-400 text-sm mt-2 flex items-center gap-1">
                            <Icon src={ExclamationTriangle} class="w-4 h-4" />
                            {m.request_limit_reached()}
                        </p>
                    {/if}
                </div>
            {/if}

            <!-- Request Button -->
            <button
                type="button"
                class="btn variant-filled-primary w-full"
                disabled={viewState !== 'ready' || (quota !== null && !canRequest)}
                onclick={submitRequest}>
                {m.btn_request()}
            </button>

            {#if quota !== null && !canRequest}
                <p class="text-error-400 text-sm text-center mt-2">
                    {m.request_no_more_available()}
                </p>
            {/if}
        {:else if viewState === 'submitting'}
            <div class="center-col py-4">
                <span class="loading-spinner loading-spinner-lg loading-spinner-primary mb-4"
                ></span>
                <p class="text-surface-300">{m.request_sending()}</p>
            </div>
        {:else if viewState === 'error'}
            <div class="center-col py-4">
                <div class="w-12 h-12 bg-error-500 rounded-full center mb-4">
                    <Icon src={ExclamationTriangle} class="w-6 h-6 text-white" />
                </div>
                <p class="text-error-400 font-semibold">{m.request_failed()}</p>
                <p class="text-surface-400 text-sm mt-1">{errorMessage}</p>
                <button
                    type="button"
                    class="btn variant-ghost-surface mt-4"
                    onclick={() => {
                        viewState = 'ready';
                        errorMessage = '';
                    }}>
                    {m.btn_retry()}
                </button>
            </div>
        {/if}
    </div>
</div>

<style lang="postcss">
    .line-clamp-3 {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .line-clamp-4 {
        display: -webkit-box;
        -webkit-line-clamp: 4;
        line-clamp: 4;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }
</style>
