<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    /**
     * SeasonSelectorModal - Allows users to select specific seasons to request
     *
     * Features:
     * - Fetches season list from TMDB with availability status
     * - Shows checkboxes for each season
     * - Displays availability status and episode count
     * - Validates that at least one season is selected
     * - Handles errors gracefully with fallback to full show request
     */
    import { onMount } from 'svelte';
    import { Icon, XMark, CheckCircle, ExclamationTriangle, Clock, Tv } from 'svelte-hero-icons';
    import { modals } from '$lib/stores/modal.store';
    import RequestModal from '$lib/components/RequestModal.svelte';
    import type { ExternalIds } from '$lib/types/api-common';
    import * as m from '$lib/paraglide/messages';
    import * as contentApi from '$lib/api/content';

    interface Props {
        // Injected by ModalContainer - kept for potential future use with closeById()
        modalId: string;
        externalIds: ExternalIds | undefined;
        title?: string;
        overview?: string;
        posterPath: string | undefined;
        year?: string;
    }

    let {
        modalId,
        externalIds,
        title = m.misc_unknown() as string,
        overview = '',
        posterPath,
        year = '',
    }: Props = $props();

    const mediaType = 'series' as const;

    interface Season {
        seasonNumber: number;
        name: string;
        episodeCount: number;
        airDate: string | null;
        overview: string | null;
        posterPath: string | null;
        isAvailable: boolean;
        isPending: boolean;
    }

    // State
    let viewState = $state<'loading' | 'ready' | 'error'>('loading');
    let errorMessage = $state('');
    let seasons = $state<Season[]>([]);
    let selectedSeasons = new SvelteSet<number>();
    let showName = $state('');
    type TvQuota = {
        limit: number;
        used: number;
        remaining: number | null;
        days: number;
        restricted: boolean;
    };

    let quota = $state<{ tv: TvQuota } | null>(null);

    // Computed
    let availableCount = $derived(seasons.filter((s) => s.isAvailable).length);
    let unavailableSeasons = $derived(seasons.filter((s) => !s.isAvailable && !s.isPending));
    let tvQuota = $derived(quota?.tv);
    let hasQuota = $derived(selectedSeasons.size > 0 && tvQuota !== undefined);
    let canRequest = $derived(
        selectedSeasons.size > 0 &&
            (tvQuota === undefined ||
                (!tvQuota.restricted && (tvQuota.remaining === null || tvQuota.remaining > 0))),
    );
    let allAvailable = $derived(seasons.length > 0 && availableCount === seasons.length);

    // Auto-select unavailable seasons by default (excluding specials)
    function autoSelectUnavailable() {
        unavailableSeasons.forEach((season) => {
            // Auto-select all unavailable seasons including specials
            selectedSeasons.add(season.seasonNumber);
        });
    }

    function toggleSeason(seasonNumber: number) {
        if (selectedSeasons.has(seasonNumber)) {
            selectedSeasons.delete(seasonNumber);
        } else {
            selectedSeasons.add(seasonNumber);
        }
    }

    function selectAll() {
        unavailableSeasons.forEach((season) => {
            selectedSeasons.add(season.seasonNumber);
        });
    }

    function deselectAll() {
        selectedSeasons.clear();
    }

    async function close() {
        await modals.close();
    }

    function handleConfirm() {
        if (!canRequest) return;

        // Replace this modal with the request modal (workflow progression)
        modals.replace(RequestModal, {
            externalIds,
            mediaType,
            title,
            posterPath,
            year,
            overview,
            seasons: Array.from(selectedSeasons).sort((a, b) => a - b),
        });
    }

    function handleRequestAll() {
        // Replace this modal with the request modal (requests entire show)
        modals.replace(RequestModal, {
            externalIds,
            mediaType,
            title,
            posterPath,
            year,
            overview,
        });
    }

    async function loadSeasons() {
        if (!externalIds || !Object.values(externalIds).some(Boolean)) {
            errorMessage = 'Invalid show ID';
            viewState = 'error';
            return;
        }

        try {
            // Create abort controller for timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

            try {
                // Fetch seasons and quota data in parallel
                const [seasonsResult, quotaResult] = await Promise.all([
                    contentApi.getRequestSeasons(externalIds),
                    contentApi.getRequestQuota(),
                ]);
                clearTimeout(timeoutId);

                // Process seasons data - API returns { data: Season[], source, success }
                if (seasonsResult.error || !seasonsResult.data) {
                    throw new Error('Failed to fetch season data');
                }

                const seasonsData = seasonsResult.data;
                if (!seasonsData?.items || !Array.isArray(seasonsData.items)) {
                    throw new Error('No season data available');
                }

                showName = title;
                // Request metadata must include seasons absent from the local catalog.
                seasons = seasonsData.items;

                // Process quota data
                if (!quotaResult.error && quotaResult.data) {
                    const quotaData = quotaResult.data as {
                        quota?: { tv: TvQuota };
                    };
                    quota = quotaData?.quota ?? null;
                }

                // Filter out seasons with 0 episodes (usually specials or TBA)
                // But keep them if they're marked as available
                // Also filter out Season 0 (Specials) since backend rejects it (s < 1 validation)
                seasons = seasons.filter(
                    (s) => s.seasonNumber > 0 && (s.episodeCount > 0 || s.isAvailable),
                );

                if (seasons.length === 0) {
                    errorMessage = 'No seasons available for this show';
                    viewState = 'error';
                    return;
                }

                // Auto-select unavailable seasons
                autoSelectUnavailable();

                viewState = 'ready';
            } catch (fetchErr) {
                clearTimeout(timeoutId);
                // Check if request was aborted (timeout)
                if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
                    console.error('Season fetch timed out');
                    errorMessage =
                        'Request timed out. Please try again or request the entire show.';
                } else {
                    throw fetchErr; // Re-throw to outer catch
                }
                viewState = 'error';
            }
        } catch (err) {
            console.error('Failed to load seasons:', err);
            errorMessage =
                'Could not load season information. You can still request the entire show.';
            viewState = 'error';
        }
    }

    function getSeasonDisplayName(season: Season): string {
        if (season.seasonNumber === 0) {
            return season.name || m.season_specials();
        }
        return season.name || `Season ${season.seasonNumber}`;
    }

    onMount(() => {
        loadSeasons();
    });
</script>

<div
    id={modalId}
    class="modal-example-form card p-4 w-modal shadow-xl space-y-4 bg-surface-800 max-h-[90vh] overflow-y-auto">
    <!-- Header with Close Button -->
    <header class="flex justify-between items-start">
        <div>
            <h3 class="text-xl font-bold text-white">
                {m.request_select_seasons()}
            </h3>
            <p class="text-sm text-surface-400 mt-1">{showName || title}</p>
        </div>
        <button type="button" class="btn-icon variant-ghost-surface" onclick={close}>
            <Icon src={XMark} class="w-5 h-5" />
        </button>
    </header>

    <!-- Content -->
    <div class="pt-2">
        {#if viewState === 'loading'}
            <div class="center py-8">
                <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
                <span class="ml-3 text-surface-300">{m.loading_seasons()}</span>
            </div>
        {:else if viewState === 'error'}
            <div class="center-col py-6">
                <Icon src={ExclamationTriangle} class="w-12 h-12 text-warning-400 mb-4" />
                <p class="text-warning-400 font-semibold text-center">
                    {errorMessage}
                </p>
                <button
                    type="button"
                    class="btn variant-filled-primary mt-6"
                    onclick={handleRequestAll}>
                    {m.request_entire_show()}
                </button>
                <button type="button" class="btn variant-ghost-surface mt-2" onclick={close}>
                    {m.btn_cancel()}
                </button>
            </div>
        {:else if allAvailable}
            <div class="center-col py-6">
                <Icon src={CheckCircle} class="w-12 h-12 text-success-400 mb-4" />
                <p class="text-success-400 font-semibold text-center">
                    {m.all_seasons_available()}
                </p>
                <p class="text-surface-400 text-sm text-center mt-2">
                    {m.all_seasons_in_library()}
                </p>
                <button type="button" class="btn variant-ghost-surface mt-6" onclick={close}>
                    {m.close()}
                </button>
            </div>
        {:else}
            <!-- Season Selection -->
            <div class="space-y-3">
                <!-- Info message -->
                <div class="bg-primary-500/10 border border-primary-500/20 rounded-lg p-3">
                    <p class="text-sm text-surface-300">
                        {m.select_seasons_to_request()}
                        {#if availableCount > 0}
                            <span class="text-success-400 font-medium">
                                {m.seasons_already_available({
                                    count: availableCount,
                                })}
                            </span>
                        {/if}
                    </p>
                </div>

                <!-- Quota Display -->
                {#if tvQuota}
                    <div class="bg-surface-700 rounded-lg p-3">
                        <div class="flex items-center gap-2 text-sm">
                            <Icon src={Tv} class="w-4 h-4 text-surface-400" />
                            <span class="text-surface-300">
                                {m.tab_series()}:
                            </span>
                            <span class="font-semibold text-white">
                                {tvQuota.remaining === null
                                    ? m.misc_unlimited()
                                    : m.misc_available_of({
                                          remaining: tvQuota.remaining,
                                          limit: tvQuota.limit,
                                      })}
                            </span>
                            {#if tvQuota.days > 0}
                                <span class="text-surface-400 text-xs">
                                    ({m.request_days({ days: tvQuota.days })})
                                </span>
                            {/if}
                        </div>
                        <p class="text-xs text-surface-400 mt-1">
                            {m.season_quota_note()}
                        </p>
                        {#if tvQuota.restricted}
                            <p class="text-warning-400 text-sm mt-2 flex items-center gap-1">
                                <Icon src={ExclamationTriangle} class="w-4 h-4" />
                                {m.request_limit_reached()}
                            </p>
                        {/if}
                    </div>
                {/if}

                <!-- Select All / Deselect All -->
                {#if unavailableSeasons.length > 1}
                    <div class="flex gap-2">
                        <button
                            type="button"
                            class="btn btn-sm variant-ghost-primary"
                            onclick={selectAll}>
                            {m.select_all()}
                        </button>
                        <button
                            type="button"
                            class="btn btn-sm variant-ghost-surface"
                            onclick={deselectAll}>
                            {m.deselect_all()}
                        </button>
                    </div>
                {/if}

                <!-- Season List -->
                <div class="space-y-2 max-h-96 overflow-y-auto pr-2 scrollbar-thin">
                    {#each seasons as season (season.seasonNumber)}
                        <label
                            class="flex items-start gap-3 p-3 rounded-lg transition-colors {season.isAvailable
                                ? 'bg-success-900/20 opacity-60 cursor-not-allowed'
                                : season.isPending
                                  ? 'bg-warning-900/20 opacity-60 cursor-not-allowed'
                                  : 'bg-surface-700/50 hover:bg-surface-700 cursor-pointer'}">
                            <!-- Checkbox (disabled if available or pending) -->
                            <input
                                type="checkbox"
                                class="checkbox mt-0.5"
                                checked={selectedSeasons.has(season.seasonNumber)}
                                disabled={season.isAvailable || season.isPending}
                                onchange={() => toggleSeason(season.seasonNumber)} />

                            <!-- Season Info -->
                            <div class="flex-1 min-w-0">
                                <div class="flex items-start justify-between gap-2">
                                    <div>
                                        <h4 class="font-medium text-white text-sm">
                                            {getSeasonDisplayName(season)}
                                        </h4>
                                        <p class="text-xs text-surface-400 mt-0.5">
                                            {season.episodeCount}
                                            {season.episodeCount === 1
                                                ? m.episode_singular()
                                                : m.episodes_plural()}
                                            {#if season.airDate}
                                                • {new Date(season.airDate).getFullYear()}
                                            {/if}
                                        </p>
                                    </div>

                                    <!-- Status Badge -->
                                    <div class="flex flex-col gap-1">
                                        {#if season.isAvailable}
                                            <span
                                                class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-success-500/20 text-success-400">
                                                <Icon src={CheckCircle} class="w-3 h-3" />
                                                {m.available()}
                                            </span>
                                        {:else if season.isPending}
                                            <span
                                                class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-warning-500/20 text-warning-400">
                                                <Icon src={Clock} class="w-3 h-3" />
                                                {m.requested()}
                                            </span>
                                        {/if}
                                    </div>
                                </div>

                                <!-- Overview (if available, truncated) -->
                                {#if season.overview && !season.isAvailable}
                                    <p class="text-xs text-surface-500 mt-1 line-clamp-2">
                                        {season.overview}
                                    </p>
                                {/if}
                            </div>
                        </label>
                    {/each}
                </div>

                <!-- Action Buttons -->
                <div class="flex gap-2 pt-4 border-t border-surface-700">
                    <button
                        type="button"
                        class="btn variant-filled-primary flex-1"
                        disabled={!canRequest}
                        onclick={handleConfirm}>
                        {m.request_selected_seasons({
                            count: selectedSeasons.size,
                        })}
                    </button>
                    <button type="button" class="btn variant-ghost-surface" onclick={close}>
                        {m.btn_cancel()}
                    </button>
                </div>

                <!-- Request All Option -->
                <button
                    type="button"
                    class="btn variant-ghost-surface w-full text-sm"
                    onclick={handleRequestAll}>
                    {m.request_all_seasons_instead()}
                </button>
            </div>
        {/if}
    </div>
</div>

<style lang="postcss">
    .line-clamp-2 {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    /* Custom scrollbar for season list */
    .scrollbar-thin::-webkit-scrollbar {
        width: 6px;
    }

    .scrollbar-thin::-webkit-scrollbar-track {
        background: var(--color-surface-800);
    }

    .scrollbar-thin::-webkit-scrollbar-thumb {
        background: var(--color-surface-600);
        border-radius: 3px;
    }

    .scrollbar-thin::-webkit-scrollbar-thumb:hover {
        background: var(--color-surface-500);
    }
</style>
