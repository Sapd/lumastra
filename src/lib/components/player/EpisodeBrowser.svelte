<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { pickVariant } from '$lib/utils/image-utils';
    import './player-presentation.css';
    import { Z } from '$lib/utils/z-index';
    import { onDestroy, onMount, untrack } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { Icon, XMark, Check, ChevronDown, Play } from 'svelte-hero-icons';
    import { fade, fly } from 'svelte/transition';
    import * as m from '$lib/paraglide/messages';
    import * as contentApi from '$lib/api/content';
    import { markWatched, unmarkWatched } from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import { formatEpisodeNumber } from '$lib/utils/media-display';
    import { centerSelectedOption } from '$lib/utils/center-selected-option';
    import EpisodeOverviewHoverPanel from './EpisodeOverviewHoverPanel.svelte';
    import EpisodeLanguageBadges from '$lib/components/media/EpisodeLanguageBadges.svelte';

    interface Props {
        // Props
        seriesId: string;
        currentSeasonNumber: number;
        currentEpisodeId: string;
        seriesName?: string;
        isOpen?: boolean;
        readOnly?: boolean; // When true, disables episode selection (for watch party guests)
        onclose?: () => void;
        onselectepisode?: (detail: {
            episodeId: string;
            seasonNumber: number;
            episodeNumber: number;
            title: string;
        }) => void;
    }

    let {
        seriesId,
        currentSeasonNumber = $bindable(0),
        currentEpisodeId,
        seriesName = '',
        isOpen = false,
        readOnly = false,
        onclose,
        onselectepisode,
    }: Props = $props();

    // Season and episode data
    interface Season {
        seasonNumber: number;
        name?: string;
        id?: string;
        episodeCount?: number;
        watchedCount?: number;
        imageTag?: string;
        episodesHref?: string;
    }

    interface Episode {
        id?: string;
        name?: string;
        episodeNumber: number;
        episodeNumberEnd?: number;
        seasonNumber: number;
        overview?: string;
        runtimeTicks?: number;
        imageTag?: string;
        progressPercent?: number;
        isWatched?: boolean;
        playbackPositionTicks?: number;
        segments?: { episodeNumber: number; title: string }[];
        originalLanguage?: string;
        audioLanguages?: string[];
        subtitleLanguages?: string[];
    }

    let seasons: Season[] = $state([]);
    let episodes: Episode[] = $state([]);
    let selectedSeasonNumber = $state(currentSeasonNumber);
    let loadingSeasons = $state(false);
    let seasonsFailed = $state(false);
    let episodesFailed = $state(false);

    let loadingEpisodes = $state(false);
    let seasonDropdownOpen = $state(false);
    /** Scrollable season dropdown, so opening it can centre the season
     *  being watched instead of always starting at season 1. */
    let seasonDropdownListEl: HTMLDivElement | undefined = $state();

    // Keep the full episode synopsis available without widening the drawer.
    // The panel is mouse/fine-pointer only and opens after a short dwell, so
    // scrolling through rows does not make the player flicker with tooltips.
    const HOVER_OPEN_MS = 180;
    const HOVER_CLOSE_MS = 150;
    let hoveredEpisode = $state<Episode | null>(null);
    let hoveredAnchorEl = $state<HTMLElement | null>(null);
    let hoverOpenTimer: ReturnType<typeof setTimeout> | null = null;
    let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;
    const hoverPanelId = `player-episode-overview-${Math.random().toString(36).slice(2, 10)}`;

    function clearHoverTimers(): void {
        if (hoverOpenTimer !== null) clearTimeout(hoverOpenTimer);
        if (hoverCloseTimer !== null) clearTimeout(hoverCloseTimer);
        hoverOpenTimer = null;
        hoverCloseTimer = null;
    }

    function closeOverviewPanel(): void {
        clearHoverTimers();
        hoveredEpisode = null;
        hoveredAnchorEl = null;
    }

    function handleEpisodePointerEnter(e: PointerEvent, episode: Episode): void {
        if (e.pointerType !== 'mouse' || !episode.overview) return;
        clearHoverTimers();
        const anchor = e.currentTarget as HTMLElement;
        hoverOpenTimer = setTimeout(() => {
            hoverOpenTimer = null;
            hoveredEpisode = episode;
            hoveredAnchorEl = anchor;
        }, HOVER_OPEN_MS);
    }

    function scheduleOverviewPanelClose(): void {
        if (hoverOpenTimer !== null) {
            clearTimeout(hoverOpenTimer);
            hoverOpenTimer = null;
        }
        if (hoverCloseTimer !== null) clearTimeout(hoverCloseTimer);
        hoverCloseTimer = setTimeout(() => {
            hoverCloseTimer = null;
            closeOverviewPanel();
        }, HOVER_CLOSE_MS);
    }

    function cancelOverviewPanelClose(): void {
        if (hoverCloseTimer !== null) {
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = null;
        }
    }

    // Format runtime from ticks to "Xm" format
    function formatRuntime(ticks: number | undefined | null): string {
        if (!ticks || ticks <= 0) return '';
        const minutes = Math.round(ticks / 10_000_000 / 60);
        return `${minutes}m`;
    }

    // Get episode thumbnail URL
    function getEpisodeThumbnailUrl(episode: Episode): string | null {
        return episode.imageTag ?? null;
    }

    // Get season image URL
    function getSeasonImageUrl(season: Season): string | null {
        return season.imageTag ?? null;
    }

    // Handle image error
    function handleImageError(event: Event) {
        const img = event.currentTarget as HTMLImageElement;
        img.style.display = 'none';
        const fallback = img.nextElementSibling as HTMLElement;
        if (fallback) fallback.classList.remove('hidden');
    }

    let seasonsRequest = 0;
    let episodesRequest = 0;

    // Fetch seasons for the series
    async function fetchSeasons() {
        if (!seriesId) return;

        const request = ++seasonsRequest;
        const targetSeries = seriesId;
        const isCurrent = () => request === seasonsRequest && targetSeries === seriesId;
        loadingSeasons = true;
        seasonsFailed = false;
        seasons = [];
        try {
            const { data, error: seasonsError } = await contentApi.getSeriesSeasons(targetSeries);
            if (!isCurrent()) return;
            seasonsFailed = !!seasonsError || !data;
            if (!seasonsError && data) {
                seasons = data.items
                    .map((s) => ({
                        seasonNumber: s.seasonNumber,
                        name: s.title,
                        id: s.id,
                        episodeCount: s.episodeCount,
                        watchedCount: s.watchedCount,
                        imageTag: pickVariant(s.images.poster, 'thumb'),
                        episodesHref: s.episodes.href,
                    }))
                    // Specials (season 0) sort last — regular seasons stay in
                    // ascending order, Specials just moves to the end of the list.
                    .sort((a, b) => {
                        if (a.seasonNumber === 0 && b.seasonNumber !== 0) return 1;
                        if (b.seasonNumber === 0 && a.seasonNumber !== 0) return -1;
                        return a.seasonNumber - b.seasonNumber;
                    });
            }
        } catch (error) {
            if (isCurrent()) seasonsFailed = true;
            console.error('[EpisodeBrowser] Failed to fetch seasons:', error);
        } finally {
            if (isCurrent()) loadingSeasons = false;
        }
    }

    // Fetch episodes for the selected season
    async function fetchEpisodes(seasonNum: number) {
        if (!seriesId) return;

        const request = ++episodesRequest;
        const targetSeries = seriesId;
        const isCurrent = () => request === episodesRequest && targetSeries === seriesId;
        loadingEpisodes = true;
        episodesFailed = false;
        episodes = [];
        closeOverviewPanel();
        // fetchEpisodes runs inside the init effect, which also (re)sets `seasons`: reading it
        // tracked here made the effect depend on its own write (effect_update_depth_exceeded).
        const episodesHref = untrack(
            () => seasons.find((s) => s.seasonNumber === seasonNum)?.episodesHref,
        );
        try {
            const { data, error: episodesError } = await contentApi.getSeriesEpisodes(
                targetSeries,
                seasonNum,
                { href: episodesHref },
            );
            if (!isCurrent()) return;
            episodesFailed = !!episodesError || !data;
            if (!episodesError && data) {
                episodes = data.items.map((ep) => ({
                    id: ep.id,
                    name: ep.title,
                    episodeNumber: ep.context?.episodeNumber ?? 0,
                    episodeNumberEnd: ep.context?.endEpisodeNumber,
                    seasonNumber: ep.context?.seasonNumber ?? 0,
                    overview: ep.overview,
                    runtimeTicks: ep.durationMs === undefined ? undefined : ep.durationMs * 10_000,
                    imageTag: pickVariant(ep.images.thumb, 'thumb'),
                    progressPercent: (ep.progress?.fraction ?? 0) * 100,
                    isWatched: ep.progress?.finished ?? false,
                    playbackPositionTicks: (ep.progress?.positionMs ?? 0) * 10_000,
                    segments: ep.segments,
                    originalLanguage: ep.originalLanguage,
                    audioLanguages: ep.audioLanguages,
                    subtitleLanguages: ep.subtitleLanguages,
                }));
            }
        } catch (error) {
            if (isCurrent()) episodesFailed = true;
            console.error('[EpisodeBrowser] Failed to fetch episodes:', error);
        } finally {
            if (isCurrent()) loadingEpisodes = false;
        }
    }

    // Select a season
    function selectSeason(seasonNum: number) {
        selectedSeasonNumber = seasonNum;
        seasonDropdownOpen = false;
        fetchEpisodes(seasonNum);
    }

    // Handle episode click
    function handleEpisodeClick(episode: Episode) {
        if (readOnly) return; // Watch party guests cannot select episodes
        if (!episode.id) return; // No ID, can't select
        if (episode.id === currentEpisodeId) return; // Already playing
        onselectepisode?.({
            episodeId: episode.id,
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            title: episode.name ?? '',
        });
    }

    // In-flight toggles — disable the button per-episode so a double-click
    // can't fire two requests for the same row. SvelteSet so .add()/.delete()
    // are reactive without manual reassignment.
    const togglingEpisodeIds = new SvelteSet<string>();

    /**
     * Toggle the watched state for an episode. Optimistic local flip,
     * revert on error. The server fan-out path treats episode marks as
     * leaf events (no cascade), so we only flip this one row.
     */
    async function toggleEpisodeWatched(episode: Episode): Promise<void> {
        const id = episode.id;
        if (!id || readOnly) return;
        if (togglingEpisodeIds.has(id)) return;

        togglingEpisodeIds.add(id);
        const wasWatched = episode.isWatched ?? false;

        // Optimistic flip — replace the array entry so reactivity picks it
        // up. We also clear progressPercent on mark-watched so the resume
        // bar disappears immediately.
        episodes = episodes.map((ep) =>
            ep.id === id
                ? {
                      ...ep,
                      isWatched: !wasWatched,
                      progressPercent: !wasWatched ? 0 : ep.progressPercent,
                  }
                : ep,
        );

        try {
            const { error } = wasWatched ? await unmarkWatched(id) : await markWatched(id);
            if (error) throw new Error(error);
        } catch {
            // Revert on failure.
            episodes = episodes.map((ep) =>
                ep.id === id
                    ? {
                          ...ep,
                          isWatched: wasWatched,
                          progressPercent: episode.progressPercent,
                      }
                    : ep,
            );
            toasts.error(wasWatched ? 'Failed to mark as unwatched' : 'Failed to mark as watched');
        } finally {
            togglingEpisodeIds.delete(id);
        }
    }

    // Close the browser
    function close() {
        onclose?.();
    }

    // Handle escape key
    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && isOpen) {
            // The portalled language list handles Escape before this drawer.
            if (document.querySelector('.language-popover')) return;
            event.preventDefault();
            event.stopImmediatePropagation(); // Prevent VideoPlayer from also handling this ESC
            if (seasonDropdownOpen) seasonDropdownOpen = false;
            else close();
        }
    }

    function scrollToCurrentEpisode(): void {
        const currentEl = document.querySelector('.episode-current');
        if (currentEl) {
            currentEl.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
            });
        }
    }

    // Get current season object
    let currentSeason = $derived(seasons.find((s) => s.seasonNumber === selectedSeasonNumber));

    // Initialize when opened (or when the playing episode changes season).
    // Write selectedSeasonNumber without reading it here so parent re-renders
    // that keep currentSeasonNumber the same don't re-run this effect and
    // reset the user's season selection.
    $effect(() => {
        if (isOpen && seriesId) {
            selectedSeasonNumber = currentSeasonNumber;
            fetchSeasons();
            fetchEpisodes(currentSeasonNumber);
        }
    });

    // Scroll to current episode when episodes load
    $effect(() => {
        if (isOpen && episodes.length > 0 && selectedSeasonNumber === currentSeasonNumber) {
            const timer = setTimeout(scrollToCurrentEpisode, 100);
            return () => clearTimeout(timer);
        }
    });

    // Centre the selected season whenever the dropdown opens. Reading the list
    // ref and `seasons` keeps the effect subscribed to both, so it re-runs once
    // `bind:this` has landed, and again when a dropdown that was opened during
    // the seasons fetch finally has rows to scroll.
    $effect(() => {
        if (!seasonDropdownOpen || !seasonDropdownListEl || seasons.length === 0) return;
        centerSelectedOption(seasonDropdownListEl);
    });

    onMount(() => {
        // Use capture phase to intercept ESC before VideoPlayer handles it
        window.addEventListener('keydown', handleKeydown, true);
        return () => window.removeEventListener('keydown', handleKeydown, true);
    });

    onDestroy(() => {
        clearHoverTimers();
        seasonsRequest++;
        episodesRequest++;
    });
</script>

{#if isOpen}
    <!-- Backdrop -->
    <button
        class="fixed inset-0 bg-black/50"
        style="z-index: {Z.PLAYER_SIDEBAR};"
        transition:fade={{ duration: 200 }}
        onclick={close}
        aria-label={m.player_close_episode_browser()}></button>

    <!-- Drawer -->
    <div
        class="player-drawer episode-browser-drawer fixed right-0 top-0 bottom-0 w-[400px] max-w-[90vw] flex flex-col"
        style="z-index: {Z.PLAYER_SIDEBAR_CONTENT};"
        transition:fly={{ x: 400, duration: 300 }}>
        <!-- Header -->
        <div class="player-drawer-header">
            <div class="flex-1 min-w-0">
                <h2 class="text-lg font-semibold">
                    {seriesName || m.episodes()}
                </h2>
            </div>
            <button
                class="p-2 hover:bg-surface-700 rounded-lg transition-colors"
                onclick={close}
                aria-label={m.btn_close()}>
                <Icon src={XMark} class="w-5 h-5" />
            </button>
        </div>

        <!-- Season Selector -->
        <div class="p-4 border-b border-surface-700">
            <div class="relative">
                <button
                    class="w-full between p-3 bg-surface-800 hover:bg-surface-700 rounded-lg transition-colors"
                    aria-haspopup="listbox"
                    aria-expanded={seasonDropdownOpen}
                    onclick={() => (seasonDropdownOpen = !seasonDropdownOpen)}>
                    <div class="flex items-center gap-3">
                        {#if currentSeason}
                            {@const imageUrl = getSeasonImageUrl(currentSeason)}
                            {#if imageUrl}
                                <img
                                    src={imageUrl}
                                    alt={m.player_season_image_alt({
                                        number: String(selectedSeasonNumber),
                                    })}
                                    class="w-8 h-12 rounded object-cover shrink-0"
                                    onerror={handleImageError} />
                                <div class="hidden">
                                    <div
                                        class="w-8 h-12 rounded bg-primary-500/20 flex items-center justify-center text-primary-400 font-bold text-xs shrink-0">
                                        {m.season_prefix()}{selectedSeasonNumber}
                                    </div>
                                </div>
                            {:else}
                                <div
                                    class="w-8 h-12 rounded bg-primary-500/20 flex items-center justify-center text-primary-400 font-bold text-xs shrink-0">
                                    {#if selectedSeasonNumber === 0}{m.season_special_prefix()}{:else}{m.season_prefix()}{selectedSeasonNumber}{/if}
                                </div>
                            {/if}
                        {/if}
                        <div>
                            <div class="font-medium text-left">
                                {#if selectedSeasonNumber === 0}
                                    {m.player_specials()}
                                {:else}
                                    {m.player_season({
                                        number: selectedSeasonNumber,
                                    })}
                                {/if}
                            </div>
                            {#if currentSeason}
                                <div class="text-xs text-surface-400">
                                    {m.player_episodes_count({
                                        count: currentSeason.episodeCount ?? 0,
                                    })}
                                    {#if (currentSeason.watchedCount ?? 0) > 0}
                                        <span class="mx-1">•</span>
                                        {m.player_watched_count({
                                            watched: currentSeason.watchedCount ?? 0,
                                            total: currentSeason.episodeCount ?? 0,
                                        })}
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    </div>
                    <Icon
                        src={ChevronDown}
                        class="w-5 h-5 transition-transform {seasonDropdownOpen
                            ? 'rotate-180'
                            : ''}" />
                </button>

                <!-- Season Dropdown -->
                {#if seasonDropdownOpen}
                    <div
                        class="absolute top-full left-0 right-0 mt-1 player-menu max-h-[min(60vh,37.5rem)] overflow-y-auto overscroll-contain z-10 seasons-dropdown"
                        bind:this={seasonDropdownListEl}
                        role="listbox"
                        transition:fly={{ y: -10, duration: 150 }}>
                        {#if loadingSeasons}
                            <div class="center p-4">
                                <span class="loading-spinner loading-spinner-primary"></span>
                            </div>
                        {:else if seasonsFailed}
                            <div class="p-4 text-center" role="alert">
                                <p>{m.modal_progress_error_load_seasons()}</p>
                                <button class="mt-2 underline" onclick={() => fetchSeasons()}
                                    >{m.retry()}</button>
                            </div>
                        {:else}
                            {#each seasons as season (season.id)}
                                {@const seasonImageUrl = getSeasonImageUrl(season)}
                                <button
                                    class="w-full flex items-center gap-3 p-3 hover:bg-surface-700 transition-colors {season.seasonNumber ===
                                    selectedSeasonNumber
                                        ? 'bg-surface-700'
                                        : ''}"
                                    role="option"
                                    aria-selected={season.seasonNumber === selectedSeasonNumber}
                                    onclick={() => selectSeason(season.seasonNumber)}>
                                    {#if seasonImageUrl}
                                        <img
                                            src={seasonImageUrl}
                                            alt={season.name}
                                            class="w-8 h-12 rounded object-cover shrink-0"
                                            onerror={handleImageError} />
                                        <div class="hidden">
                                            <div
                                                class="w-8 h-12 rounded bg-primary-500/20 flex items-center justify-center text-primary-400 font-bold text-xs shrink-0">
                                                {#if season.seasonNumber === 0}SP{:else}S{season.seasonNumber}{/if}
                                            </div>
                                        </div>
                                    {:else}
                                        <div
                                            class="w-8 h-12 rounded bg-primary-500/20 flex items-center justify-center text-primary-400 font-bold text-xs shrink-0">
                                            {#if season.seasonNumber === 0}SP{:else}S{season.seasonNumber}{/if}
                                        </div>
                                    {/if}
                                    <div class="flex-1 text-left">
                                        <div class="font-medium">
                                            {#if season.seasonNumber === 0}
                                                {m.player_specials()}
                                            {:else if season.name && season.name !== `Season ${season.seasonNumber}` && season.name !== m.player_season( { number: season.seasonNumber } )}
                                                {m.player_season_with_name({
                                                    number: season.seasonNumber,
                                                    name: season.name,
                                                })}
                                            {:else}
                                                {m.player_season({
                                                    number: season.seasonNumber,
                                                })}
                                            {/if}
                                        </div>
                                        <div class="text-xs text-surface-400">
                                            {m.player_episodes_count({
                                                count: season.episodeCount ?? 0,
                                            })}
                                        </div>
                                    </div>
                                    {#if (season.watchedCount ?? 0) >= (season.episodeCount ?? 0) && (season.episodeCount ?? 0) > 0}
                                        <Icon src={Check} class="w-4 h-4 text-green-400" solid />
                                    {:else if (season.watchedCount ?? 0) > 0}
                                        <span class="text-xs text-surface-400"
                                            >{season.watchedCount ?? 0}/{season.episodeCount ??
                                                0}</span>
                                    {/if}
                                </button>
                            {/each}
                        {/if}
                    </div>
                {/if}
            </div>
        </div>

        <!-- Episodes List -->
        <div class="flex-1 overflow-y-auto episodes-list">
            {#if loadingEpisodes}
                <div class="center p-8">
                    <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
                </div>
            {:else if episodesFailed}
                <div class="p-8 text-center" role="alert">
                    <p>
                        {m.modal_progress_error_load_season({ seasonNumber: selectedSeasonNumber })}
                    </p>
                    <button
                        class="mt-2 underline"
                        onclick={() => fetchEpisodes(selectedSeasonNumber)}>{m.retry()}</button>
                </div>
            {:else if episodes.length === 0}
                <div class="text-center text-surface-400 p-8">
                    {m.player_no_episodes_found()}
                </div>
            {:else}
                {#each episodes as episode, episodeIdx (episode.id + '-' + episodeIdx)}
                    {@const isCurrentEpisode = episode.id === currentEpisodeId}
                    {@const thumbnailUrl = getEpisodeThumbnailUrl(episode)}
                    {@const isDisabled = readOnly && !isCurrentEpisode}
                    {@const isToggling = episode.id != null && togglingEpisodeIds.has(episode.id)}
                    {@const isWatched = episode.isWatched ?? false}
                    <!--
                        Row is a flex wrapper, not a button — the watched-
                        toggle on the right is its own real button. Nesting
                        a button inside another button is invalid HTML and
                        browser parsers split the markup unpredictably.
                    -->
                    <div
                        class="w-full flex border-b border-surface-800 {isCurrentEpisode
                            ? 'bg-surface-800 episode-current'
                            : ''}"
                        role="group"
                        onpointerenter={(e) => handleEpisodePointerEnter(e, episode)}
                        onpointerleave={scheduleOverviewPanelClose}>
                        <div
                            class="flex-1 min-w-0 flex gap-3 p-3 transition-colors text-left {isDisabled
                                ? 'opacity-50 cursor-not-allowed'
                                : 'hover:bg-surface-800'}"
                            role="button"
                            tabindex={isDisabled ? -1 : 0}
                            aria-disabled={isDisabled}
                            onclick={() => {
                                if (!isDisabled) handleEpisodeClick(episode);
                            }}
                            onkeydown={(event) => {
                                if (
                                    event.target === event.currentTarget &&
                                    (event.key === 'Enter' || event.key === ' ')
                                ) {
                                    event.preventDefault();
                                    if (!isDisabled) handleEpisodeClick(episode);
                                }
                            }}>
                            <!-- Keep the image, playing overlay and progress bar in the same fixed frame. -->
                            <div
                                class="relative shrink-0 self-start w-28 h-16 rounded overflow-hidden">
                                {#if thumbnailUrl}
                                    <img
                                        src={thumbnailUrl}
                                        alt={episode.name}
                                        class="block w-full h-full object-cover object-center"
                                        onerror={handleImageError} />
                                    <div class="hidden">
                                        <div
                                            class="w-28 h-16 rounded bg-surface-700 flex items-center justify-center text-surface-400">
                                            <Icon src={Play} class="w-6 h-6" />
                                        </div>
                                    </div>
                                {:else}
                                    <div
                                        class="w-28 h-16 rounded bg-surface-700 flex items-center justify-center text-surface-400">
                                        <Icon src={Play} class="w-6 h-6" />
                                    </div>
                                {/if}

                                <!-- Playing indicator -->
                                {#if isCurrentEpisode}
                                    <div class="absolute inset-0 bg-primary-500/30 rounded center">
                                        <div class="w-8 h-8 bg-primary-500 rounded-full center">
                                            <Icon src={Play} class="w-4 h-4 text-white" solid />
                                        </div>
                                    </div>
                                {/if}

                                <!-- Progress bar -->
                                {#if (episode.progressPercent ?? 0) > 0 && !isWatched}
                                    <div class="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                                        <div
                                            class="h-full bg-primary-500"
                                            style="width: {episode.progressPercent}%">
                                        </div>
                                    </div>
                                {/if}
                            </div>

                            <!-- Episode Info -->
                            <div class="flex-1 min-w-0">
                                {#if episode.segments && episode.segments.length > 1}
                                    <div class="text-sm font-medium space-y-0.5">
                                        {#each episode.segments as seg, segIdx (seg.episodeNumber + '-' + segIdx)}
                                            <div class="flex items-baseline gap-2">
                                                <span
                                                    class="text-surface-400 whitespace-nowrap shrink-0"
                                                    >E{seg.episodeNumber}</span>
                                                <span class="episode-title">{seg.title}</span>
                                            </div>
                                        {/each}
                                    </div>
                                {:else}
                                    <div class="text-sm font-medium flex items-start gap-2">
                                        <span class="text-surface-400 whitespace-nowrap shrink-0"
                                            >{formatEpisodeNumber(
                                                episode.episodeNumber,
                                                episode.episodeNumberEnd,
                                            )}</span>
                                        <span class="episode-title">{episode.name}</span>
                                    </div>
                                {/if}
                                <div
                                    class="flex flex-wrap items-center gap-2 mt-1 text-xs text-surface-400 min-w-0">
                                    {#if episode.runtimeTicks}
                                        <span class="shrink-0 whitespace-nowrap"
                                            >{formatRuntime(episode.runtimeTicks)}</span>
                                    {/if}
                                    <EpisodeLanguageBadges
                                        originalLanguage={episode.originalLanguage}
                                        audioLanguages={episode.audioLanguages}
                                        subtitleLanguages={episode.subtitleLanguages}
                                        showSeparator={!!episode.runtimeTicks} />
                                </div>
                                {#if episode.overview}
                                    <div class="text-xs text-surface-400 mt-1 line-clamp-2">
                                        {episode.overview}
                                    </div>
                                {/if}
                            </div>
                        </div>

                        <!--
                            Watched toggle — always rendered (even when
                            unwatched, dimmed) so a single tap can mark or
                            unmark. Hidden under readOnly so watch-party
                            guests can't mutate state. Native title gives
                            the hover hint inside fullscreen, where a
                            portal-based Tooltip wouldn't render.
                        -->
                        {#if !readOnly}
                            <button
                                type="button"
                                class="self-stretch px-3 flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-wait {isWatched
                                    ? 'text-green-400 hover:text-green-300'
                                    : 'text-surface-500 hover:text-surface-200'}"
                                title={isWatched
                                    ? m.episode_picker_mark_unwatched()
                                    : m.episode_picker_mark_watched()}
                                aria-label={isWatched
                                    ? m.episode_picker_mark_unwatched()
                                    : m.episode_picker_mark_watched()}
                                aria-pressed={isWatched}
                                disabled={isToggling}
                                onclick={() => toggleEpisodeWatched(episode)}>
                                <Icon src={Check} class="w-5 h-5" solid={isWatched} />
                            </button>
                        {:else if isWatched}
                            <!--
                                Read-only: keep the watched indicator
                                visible but non-interactive so guests can
                                still see episode state at a glance.
                            -->
                            <div
                                class="self-stretch px-3 flex items-center justify-center text-green-400">
                                <Icon src={Check} class="w-5 h-5" solid />
                            </div>
                        {/if}
                    </div>
                {/each}
            {/if}
        </div>
    </div>

    <EpisodeOverviewHoverPanel
        episode={hoveredEpisode}
        anchorEl={hoveredAnchorEl}
        panelId={hoverPanelId}
        onpointerenter={cancelOverviewPanelClose}
        onpointerleave={scheduleOverviewPanelClose} />
{/if}

<style>
    .episode-title {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        overflow: hidden;
        overflow-wrap: anywhere;
        line-height: 1.45;
    }
    .episode-current {
        box-shadow: inset 3px 0 #a5b4fc;
        background: #818cf822;
    }
    .episodes-list::-webkit-scrollbar,
    .seasons-dropdown::-webkit-scrollbar {
        width: 4px;
    }

    .episodes-list::-webkit-scrollbar-track,
    .seasons-dropdown::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 2px;
    }

    .episodes-list::-webkit-scrollbar-thumb,
    .seasons-dropdown::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 2px;
    }

    .episodes-list::-webkit-scrollbar-thumb:hover,
    .seasons-dropdown::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.5);
    }
</style>
