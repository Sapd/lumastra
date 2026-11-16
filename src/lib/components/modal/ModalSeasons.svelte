<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * ModalSeasons - Seasons and episodes section for series modals
     *
     * Wraps SeriesEpisodePicker with a collapsible header.
     * Handles episode selection and watched status toggling.
     */
    import { onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { Icon, ChevronDown, ChevronUp } from 'svelte-hero-icons';
    import { SeriesEpisodePicker } from '$lib/components/media';
    import { navigateToWatch } from '$lib/stores/watch-navigation';
    import { openMediaModal } from '$lib/utils/modal-utils';
    import { asInternalUuid } from '$lib/utils/id-patterns';
    import { runTimeTicksToSeconds } from '$lib/utils/time-formatting';
    import { fetchOrderingLabel } from '$lib/utils/ordering-utils';
    import * as m from '$lib/paraglide/messages';

    let orderingLabel = $state<string | null>(null);

    type Episode = {
        id: string;
        name?: string;
        seasonNumber: number;
        episodeNumber: number;
        episodeNumberEnd?: number;
        overview?: string;
        imageTag?: string;
        runTimeTicks?: number;
        played?: boolean;
        externalIds?: Record<string, string | undefined>;
    };

    interface Props {
        // Props
        seriesId?: string | undefined;
        seriesName?: string;
        imageUrl?: string | undefined;
        showWatchedToggle?: boolean;
        defaultExpanded?: boolean | undefined;
        initialSeason?: number | undefined;
        initialEpisode?: number | undefined;
        // Episode layout toggle
        episodeLayout?: 'single' | 'split';
        isSplitCapable?: boolean;
        // Whether to render the layout toggle at all. When true but the window
        // is too narrow to actually split (`isSplitCapable` false), the toggle
        // renders DISABLED with an explanatory tooltip rather than vanishing.
        // Kept false in page mode / touch-phone sizes where split is meaningless.
        canToggleLayout?: boolean;
        onepisodeLayoutChange?: (layout: 'single' | 'split') => void;
        // Callbacks
        onselectEpisode?: (episode: Episode) => void;
        onwatchedChange?: (detail: { episode: Episode; seasonNumber: number }) => void;
        onclose?: () => void;
    }

    let {
        seriesId = undefined,
        seriesName = 'Serie',
        imageUrl = undefined,
        showWatchedToggle = true,
        defaultExpanded = undefined,
        initialSeason = undefined,
        initialEpisode = undefined,
        episodeLayout = 'single',
        isSplitCapable = false,
        canToggleLayout = false,
        onepisodeLayoutChange,
        onselectEpisode,
        onwatchedChange,
        onclose,
    }: Props = $props();

    // Internal state - start collapsed by default (safe for SSR)
    // Expand if explicit defaultExpanded prop, initial season/episode context, or
    // when 'split' is the preference but the window is too narrow for the split
    // pane (the fallback below): the user wants episodes visible, so keep the
    // inline list open instead of collapsing it as we reflow to single view.
    // svelte-ignore state_referenced_locally
    let expanded = $state(
        defaultExpanded ??
            (initialSeason !== undefined ||
                initialEpisode !== undefined ||
                (episodeLayout === 'split' && !isSplitCapable)),
    );

    // After mount, expand on screens larger than FullHD (taller than 1080px)
    // This avoids SSR/hydration mismatches and runs after modal animation starts
    onMount(() => {
        // Only auto-expand if no explicit default was set and no initial context
        if (
            defaultExpanded === undefined &&
            initialSeason === undefined &&
            initialEpisode === undefined &&
            window.innerHeight > 1080
        ) {
            expanded = true;
        }
    });

    $effect(() => {
        if (seriesId) {
            void fetchOrderingLabel(seriesId).then((label) => {
                orderingLabel = label;
            });
        }
    });

    // Build series data for SeriesEpisodePicker
    let seriesData = $derived(
        seriesId
            ? {
                  seriesId: seriesId,
                  name: seriesName,
                  imageUrl,
              }
            : null,
    );

    // The parent renders the dedicated split layout (separate episode pane) only
    // when the viewport is wide enough. When 'split' is the stored preference but
    // the window is too narrow (`isSplitCapable` false), fall back to behaving as
    // 'single' so the inline picker + its expand/collapse header still appear —
    // otherwise the header row renders empty and the episode list vanishes.
    let effectiveLayout = $derived(
        episodeLayout === 'split' && isSplitCapable ? 'split' : 'single',
    );

    // Toggle expansion
    function toggleExpanded() {
        expanded = !expanded;
    }

    // Handle episode selection - navigate to player
    function handleEpisodeSelect(episode: Episode) {
        if (!episode?.id) return;

        // Dispatch event for parent to handle
        onselectEpisode?.(episode);

        // Close modal and navigate
        onclose?.();
        void navigateToWatch(episode.id);
    }

    // Handle showing episode details - open episode modal
    function handleShowEpisodeDetails(episode: Episode) {
        if (!episode?.id) return;

        // Build image URL - use optimized thumb size for episode modal
        const episodeImageUrl = episode.imageTag ?? imageUrl ?? '';

        // Open episode modal with series context using openMediaModal
        openMediaModal(
            {
                mediaType: 'episode',
                externalIds: { internal: asInternalUuid(episode.id), ...episode.externalIds },
                title: episode.name || `Episode ${episode.episodeNumber}`,
                overview: episode.overview || '',
                seriesName: seriesName,
                // seriesId here came from ModalMovie's seriesPickerData derive,
                // which prefers the Lumastra UUID. Pass it as seriesInternalId so
                // the boundary's series-context check sees it.
                seriesInternalId: seriesId,
                seasonNumber: episode.seasonNumber,
                episodeNumber: episode.episodeNumber,
                episodeNumberEnd: episode.episodeNumberEnd,
                // SECONDS — see runTimeTicksToSeconds. This value wins over the
                // enriched one in mergeModalValue, so a minutes value here made
                // every sub-hour episode render as "00m".
                duration: runTimeTicksToSeconds(episode.runTimeTicks),
                isAvailable: true,
            },
            episodeImageUrl,
        );
    }
</script>

{#if seriesData}
    <div class="seasons-section" class:split-header={effectiveLayout === 'split'}>
        <div class="flex items-center gap-2 seasons-header-row">
            {#if effectiveLayout === 'split'}
                <h3 class="flex-1 text-sm font-semibold text-surface-300">
                    {m.modal_seasons_episodes()}
                </h3>
            {:else}
                <button
                    type="button"
                    aria-expanded={expanded}
                    class="flex items-center gap-2 text-sm font-semibold text-surface-300 hover:text-white transition-colors flex-1 min-w-0"
                    onclick={toggleExpanded}>
                    <Icon src={expanded ? ChevronUp : ChevronDown} class="w-4 h-4 shrink-0" />
                    <span class="truncate">{m.modal_seasons_episodes()}</span>
                    {#if orderingLabel}
                        <span
                            class="px-1.5 py-0.5 rounded bg-primary-500/15 text-primary-400 text-xs font-normal shrink-0">
                            {orderingLabel}
                        </span>
                    {/if}
                </button>
            {/if}

            {#if canToggleLayout}
                <div
                    class="episode-layout-toggle"
                    class:disabled={!isSplitCapable}
                    role="group"
                    aria-label="Episode layout"
                    title={!isSplitCapable ? m.modal_split_needs_width() : undefined}>
                    <button
                        class="toggle-seg {effectiveLayout === 'single' ? 'active' : ''}"
                        onclick={() => onepisodeLayoutChange?.('single')}
                        disabled={!isSplitCapable}
                        aria-pressed={effectiveLayout === 'single'}
                        title={!isSplitCapable ? m.modal_split_needs_width() : 'Single scroll'}>
                        <svg
                            class="w-3 h-3"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            aria-hidden="true">
                            <rect x="1" y="2" width="14" height="2.5" rx="1" />
                            <rect x="1" y="6.5" width="14" height="2.5" rx="1" />
                            <rect x="1" y="11" width="14" height="2.5" rx="1" />
                        </svg>
                        Single
                    </button>
                    <button
                        class="toggle-seg {effectiveLayout === 'split' ? 'active' : ''}"
                        onclick={() => onepisodeLayoutChange?.('split')}
                        disabled={!isSplitCapable}
                        aria-pressed={effectiveLayout === 'split'}
                        title={!isSplitCapable ? m.modal_split_needs_width() : 'Split view'}>
                        <svg
                            class="w-3 h-3"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            aria-hidden="true">
                            <rect x="1" y="1" width="6" height="14" rx="1" />
                            <rect x="9" y="1" width="6" height="6" rx="1" />
                            <rect x="9" y="9" width="6" height="6" rx="1" />
                        </svg>
                        Split
                    </button>
                </div>
            {/if}
        </div>

        {#if expanded && effectiveLayout !== 'split'}
            <!-- No overflow clipping: the season dropdown is absolutely positioned and must extend past the picker. -->
            <div class="mt-3 bg-surface-800/50 rounded-lg">
                <SeriesEpisodePicker
                    series={seriesData}
                    inline={true}
                    {showWatchedToggle}
                    {initialSeason}
                    {initialEpisode}
                    onselectEpisode={handleEpisodeSelect}
                    onshowEpisodeDetails={handleShowEpisodeDetails}
                    {onwatchedChange} />
            </div>
        {/if}
    </div>
{/if}

<style>
    .seasons-section {
        margin-top: 1rem;
    }
    .split-header {
        margin-top: 0;
        flex-shrink: 0;
    }
    .split-header .seasons-header-row {
        padding-top: 0;
        border-top: 0;
    }

    .seasons-header-row {
        min-width: 0;
        flex-wrap: wrap;
        padding: 0.75rem 0;
        border-top: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
    }

    .seasons-header-row > button {
        min-height: 2rem;
    }

    .seasons-header-row button:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: 3px;
        border-radius: 0.25rem;
    }

    .episode-layout-toggle {
        display: flex;
        background: rgba(255, 255, 255, 0.07);
        border-radius: 6px;
        padding: 2px;
        gap: 2px;
        flex-shrink: 0;
    }

    .toggle-seg {
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 3px 8px;
        border-radius: 4px;
        font-size: 11px;
        color: rgb(var(--color-surface-400-rgb));
        background: transparent;
        border: none;
        cursor: pointer;
        transition:
            background 120ms ease,
            color 120ms ease;
        white-space: nowrap;
    }

    .toggle-seg:hover {
        color: rgb(var(--color-surface-200-rgb));
    }

    .toggle-seg.active {
        background: rgba(255, 255, 255, 0.13);
        color: rgb(var(--color-surface-100-rgb));
    }

    .episode-layout-toggle.disabled {
        opacity: 0.55;
    }

    .toggle-seg:disabled {
        cursor: not-allowed;
    }

    .toggle-seg:disabled:hover {
        color: rgb(var(--color-surface-400-rgb));
    }
</style>
