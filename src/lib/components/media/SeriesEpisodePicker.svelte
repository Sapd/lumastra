<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	SeriesEpisodePicker.svelte

	A component for browsing and selecting episodes from a TV series.
	Displays season tabs and episode list with thumbnails, progress bars, and watched indicators.

	@example Standalone (Search)
	<SeriesEpisodePicker
		{series}
		onselectEpisode={handleSelect}
		onback={() => selectedSeries = null}
	/>

	@example Inline (Modal) - compact mode without back button
	<SeriesEpisodePicker
		{series}
		inline
		onselectEpisode={handleSelect}
	/>
-->
<script lang="ts">
    import type { ImageSet } from '$lib/schemas/api-image-descriptor';
    import { pickVariant } from '$lib/utils/image-utils';
    import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';

    import { onDestroy, untrack } from 'svelte';
    import { page } from '$app/stores';
    import * as contentApi from '$lib/api/content';
    import * as userApi from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import { Icon, Play, ChevronLeft, ChevronDown, Check, Eye, Plus } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import EpisodeStill from './EpisodeStill.svelte';
    import EpisodeLanguageBadges from './EpisodeLanguageBadges.svelte';
    import EpisodeHoverPanel from './EpisodeHoverPanel.svelte';
    import { modalCount } from '$lib/stores/modal.store';
    import { mediaHoverCoordinator } from '$lib/components/ui/media-hover-coordinator.svelte';
    import { computePanelPlacement } from '$lib/utils/hover-panel-placement';
    import { centerSelectedOption } from '$lib/utils/center-selected-option';

    import { stopPropagation } from '$lib/utils/event-helpers';
    import { formatEpisodeNumber } from '$lib/utils/media-display';
    import {
        classifyEpisodeAvailability,
        isEpisodeVisible,
        type EpisodeAvailability,
    } from '$lib/shared/episode-availability';

    // =========================================================================
    // Types
    // =========================================================================

    interface SeriesItem {
        /** Series ID — accepts either field name */
        seriesId?: string;
        id?: string;
        /** Display name — accepts either field name */
        name?: string;
        title?: string;
        imageUrl?: string;
    }

    interface Season {
        Id?: string;
        id?: string;
        Name?: string;
        name?: string;
        IndexNumber?: number;
        seasonNumber?: number;
        episodeCount?: number;
        watchedCount?: number;
        imageTag?: string;
        episodesHref?: string;
        href?: string;
    }

    interface Episode {
        id: string;
        name?: string;
        episodeNumber: number;
        episodeNumberEnd?: number;
        seasonNumber: number;
        overview?: string;
        imageTag?: string;
        /** Provenance derived from the server-resolved thumbnail descriptor. */
        hasOwnStill?: boolean;
        images?: ImageSet;
        runTimeTicks?: number;
        premiereDate?: string;
        externalIds?: Record<string, string | undefined>;
        originalLanguage?: string;
        audioLanguages?: string[];
        subtitleLanguages?: string[];
        // Watch status
        playedPercentage?: number;
        played?: boolean;
        playbackPositionTicks?: number;
        // Library presence — false when metadata is ingested but no playable file exists
        hasFile?: boolean;
        segments?: { episodeNumber: number; title: string }[];
    }

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /** The series to browse episodes for */
        series: SeriesItem;
        /** Inline mode - compact display without back button header */
        inline?: boolean;
        /** Current episode ID to highlight (for player context) */
        currentEpisodeId?: string | undefined;
        /** Show watched toggle buttons */
        showWatchedToggle?: boolean;
        /** Initial season number to select (when coming from an episode) */
        initialSeason?: number | undefined;
        /** Initial episode number to highlight and scroll to */
        initialEpisode?: number | undefined;
        /** Playlist mode - shows add buttons for episodes and seasons */
        playlistMode?: boolean;
        /** Set of episode keys already in playlist (for "Added" state) */
        playlistEpisodeKeys?: Set<string>;
        // Callbacks
        onselectEpisode?: (episode: Episode) => void;
        onshowEpisodeDetails?: (episode: Episode) => void;
        onback?: () => void;
        /** Notification after persistence succeeds; never performs the write. */
        onwatchedChange?: (detail: { episode: Episode; seasonNumber: number }) => void;
        onaddEpisode?: (episode: Episode) => void;
        onaddSeason?: (detail: { season: Season; episodes: Episode[] }) => void;
    }

    let {
        series,
        inline = false,
        currentEpisodeId = undefined,
        showWatchedToggle = true,
        initialSeason = undefined,
        initialEpisode = undefined,
        playlistMode = false,
        playlistEpisodeKeys = new Set(),
        onselectEpisode,
        onshowEpisodeDetails,
        onback,
        onwatchedChange,
        onaddEpisode,
        onaddSeason,
    }: Props = $props();

    // =========================================================================
    // State
    // =========================================================================

    let seasons: Season[] = $state([]);
    let episodes: Episode[] = $state([]);
    /** Per-instance cache of already-fetched seasons so switching back and
     *  forth doesn't refetch (and re-trigger the thumbnail burst). Kept in
     *  sync by the optimistic watched-toggle; cleared on series reload. */
    const seasonEpisodeCache = new SvelteMap<number, Episode[]>();
    /** Prevent a rapid second click from reversing an in-flight watched write. */
    const pendingWatchedToggles = new SvelteSet<string>();
    /** Monotonic token guarding against out-of-order episode loads: a slow
     *  fetch for season A must not overwrite the list after the user has
     *  already switched to season B (especially via the instant cache-hit
     *  path, which never issues a fetch of its own to supersede A's). */
    let episodesLoadToken = 0;
    let seriesLoadToken = 0;
    /** The REQUESTED season number the current `episodes` list belongs to —
     *  the cache is keyed by this, never by data-derived seasonNumber (items
     *  with a missing seasonNumber map to 0 and would collide with Specials). */
    let loadedSeasonNum: number | undefined;
    let selectedSeasonIndex = $state(0);
    let isLoading = $state(false);
    let seasonDropdownOpen = $state(false);
    let loadError = $state<string | null>(null);
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    /** Scrollable episode list container — reset to top on user-driven season
     *  switches (see `resetEpisodeListScroll`). */
    let episodesListEl: HTMLDivElement | undefined = $state();
    /** Season dropdown trigger + wrapper refs, used for outside-click
     *  dismissal and returning focus on Escape. */
    let seasonDropdownTriggerEl: HTMLButtonElement | undefined = $state();
    let seasonDropdownWrapperEl: HTMLDivElement | undefined = $state();
    /** Scrollable dropdown list, so opening it can centre the selected season
     *  instead of always starting at season 1 (see
     *  `centerSelectedSeasonOption`). */
    let seasonDropdownListEl: HTMLDivElement | undefined = $state();

    // =========================================================================
    // Hover panel — ephemeral episode detail docked in the modal's right gutter
    // =========================================================================

    /** Open-intent delay. Long enough that crossing rows doesn't strobe the
     *  panel, and short enough (< Tooltip's default 200ms `delay`) that the
     *  row tooltips don't flash open at ≥1908px before the panel takes over. */
    const HOVER_OPEN_MS = 180;
    /** Close grace, so moving the pointer INTO the panel doesn't dismiss it. */
    const HOVER_CLOSE_MS = 150;

    let hoveredEpisode = $state<Episode | null>(null);
    let hoveredAnchorEl = $state<HTMLElement | null>(null);
    let hoverOpenTimer: ReturnType<typeof setTimeout> | null = null;
    let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;
    /** Unique per instance so two pickers can't collide on aria-describedby. */
    const hoverPanelId = `episode-hover-panel-${Math.random().toString(36).slice(2, 10)}`;

    function clearHoverTimers(): void {
        if (hoverOpenTimer !== null) clearTimeout(hoverOpenTimer);
        if (hoverCloseTimer !== null) clearTimeout(hoverCloseTimer);
        hoverOpenTimer = null;
        hoverCloseTimer = null;
    }

    function closeHoverPanel(): void {
        clearHoverTimers();
        hoveredEpisode = null;
        hoveredAnchorEl = null;
        mediaHoverCoordinator.release(hoverPanelId);
    }

    /**
     * Gates opening on the SAME placement check `EpisodeHoverPanel` uses to
     * decide visibility — but evaluated here, at open time, so `hoveredEpisode`
     * is never set without a real gutter to dock into. Visibility used to be
     * decided only inside the panel (render time), which meant `hoveredEpisode`
     * got set unconditionally on ANY surface/width — disabling both row
     * tooltips via their `disabled` prop even though the panel that was
     * supposed to replace them stayed `visibility: hidden`. By the time a
     * bindable `visible` prop could report back false, `Tooltip`'s retraction
     * effect had already fired and would not re-show — so this must be a
     * pre-check, not a post-hoc correction.
     */
    function openHoverPanel(episode: Episode, anchor: HTMLElement): void {
        const modalEl = anchor.closest('.modal-root');
        const gutter = computePanelPlacement({
            modalRect: modalEl ? modalEl.getBoundingClientRect() : null,
            anchorRect: anchor.getBoundingClientRect(),
            viewportWidth: document.documentElement.clientWidth,
            viewportHeight: window.innerHeight,
            // Height-independent: the width gate alone decides visibility.
            panelHeight: 0,
        });
        if (!gutter.visible) return;
        clearHoverTimers();
        mediaHoverCoordinator.claim(hoverPanelId);
        hoveredEpisode = episode;
        hoveredAnchorEl = anchor;
    }

    function handleRowPointerEnter(e: PointerEvent, episode: Episode): void {
        // Mouse only. Touch keeps today's click-to-modal behaviour.
        if (e.pointerType !== 'mouse') return;
        const anchor = e.currentTarget as HTMLElement;
        clearHoverTimers();
        hoverOpenTimer = setTimeout(() => {
            hoverOpenTimer = null;
            openHoverPanel(episode, anchor);
        }, HOVER_OPEN_MS);
    }

    function handleRowPointerLeave(): void {
        if (hoverOpenTimer !== null) {
            clearTimeout(hoverOpenTimer);
            hoverOpenTimer = null;
        }
        if (hoverCloseTimer !== null) clearTimeout(hoverCloseTimer);
        hoverCloseTimer = setTimeout(() => {
            hoverCloseTimer = null;
            closeHoverPanel();
        }, HOVER_CLOSE_MS);
    }

    /** Pointer crossed into the panel — cancel the pending close. */
    function handlePanelPointerEnter(): void {
        if (hoverCloseTimer !== null) {
            clearTimeout(hoverCloseTimer);
            hoverCloseTimer = null;
        }
    }

    function handleRowFocusIn(e: FocusEvent, episode: Episode): void {
        openHoverPanel(episode, e.currentTarget as HTMLElement);
    }

    // Dismiss when any modal opens. modalCount CHANGES (1 -> 2) and therefore
    // notifies; hasModals is a boolean derived store, so Svelte's safe_not_equal
    // dedupes true -> true and the coordinator's own hasModals subscription never
    // fires for a stacked modal. Without this the panel outlives the click that
    // opened the episode modal and paints over it (portal 1051 vs modal 1002).
    // NOT $state — the effect both reads and writes this. A reactive value here
    // would make the effect depend on its own write and re-run forever.
    let lastModalCount = 0;
    $effect(() => {
        const count = $modalCount;
        if (count > lastModalCount && hoveredEpisode) closeHoverPanel();
        lastModalCount = count;
    });

    // Season switch / filter change removes the hovered row from the rendered
    // list, and pointerleave is not reliably dispatched on a removed element.
    // Checked by id against `visibleEpisodes` (the rendered set) rather than
    // keyed on `episodes` identity: the optimistic watched-toggle
    // (handleToggleWatched) ALSO reassigns `episodes` for its in-place update,
    // and closing on that reassignment dismissed a panel the user never asked
    // to leave (the hovered row never left the list).
    // untrack is required for the same reason as elsewhere: closeHoverPanel()
    // -> mediaHoverCoordinator.release() reads activeId, and wrapping the call
    // keeps that read from becoming a spurious dependency of this effect.
    $effect(() => {
        const current = hoveredEpisode;
        if (!current) return;
        const stillVisible = visibleEpisodes.some((ep) => ep.id === current.id);
        if (!stillVisible) untrack(() => closeHoverPanel());
    });

    // Escape closes the panel FIRST and stops the event, so the same keypress
    // doesn't also close the surrounding modal (ModalContainer listens on window
    // in the bubble phase; a capture-phase document listener runs earlier).
    $effect(() => {
        if (!hoveredEpisode) return;
        const onKeydown = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            closeHoverPanel();
        };
        document.addEventListener('keydown', onKeydown, true);
        return () => document.removeEventListener('keydown', onKeydown, true);
    });

    onDestroy(() => {
        seriesLoadToken++;
        episodesLoadToken++;
        if (scrollTimer !== null) clearTimeout(scrollTimer);
        clearHoverTimers();
        mediaHoverCoordinator.release(hoverPanelId);
    });

    /** Reset the episode list scroll position to the top. Called on season
     *  switches so a season change never inherits the previous season's
     *  scroll offset; deep-link/current-episode scroll-into-view (scheduled
     *  separately, after this) is free to move it again afterwards. */
    function resetEpisodeListScroll() {
        if (episodesListEl) episodesListEl.scrollTop = 0;
    }

    // Centre the selected season whenever the dropdown opens — a series opened
    // on season 15 should not start the list at season 1. Reading the list ref
    // keeps the effect subscribed to it, so it re-runs once `bind:this` has
    // landed on the freshly rendered list.
    $effect(() => {
        if (!seasonDropdownOpen || !seasonDropdownListEl) return;
        centerSelectedOption(seasonDropdownListEl);
    });

    // Close the season dropdown on outside click or Escape, returning focus
    // to the trigger in the Escape case.
    $effect(() => {
        if (!seasonDropdownOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            if (seasonDropdownWrapperEl && !seasonDropdownWrapperEl.contains(e.target as Node)) {
                seasonDropdownOpen = false;
            }
        };
        const handleKeydown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                seasonDropdownOpen = false;
                seasonDropdownTriggerEl?.focus();
            }
        };

        document.addEventListener('click', handleClickOutside);
        document.addEventListener('keydown', handleKeydown);
        return () => {
            document.removeEventListener('click', handleClickOutside);
            document.removeEventListener('keydown', handleKeydown);
        };
    });

    /**
     * Availability state driving the per-row badge. Three-valued on the air-date
     * axis — a missing premiere date is NOT evidence the episode aired, so it
     * gets its own `undated` state rather than falling into "aired but missing".
     * See `$lib/shared/episode-availability`.
     */
    function episodeAvailability(ep: Episode): EpisodeAvailability {
        // SvelteDate keeps the derived below reactive to clock ticks the way the
        // previous inline check was; the comparison itself lives in the shared
        // module so the picker and the hover panel cannot drift apart.
        return classifyEpisodeAvailability(ep, new SvelteDate());
    }

    let visibleEpisodes = $derived.by(() => {
        const showUnaired = $page.data?.features?.showUnairedEpisodes !== false;
        const showMissing = $page.data?.features?.showMissingEpisodes !== false;
        return episodes.filter((ep) =>
            isEpisodeVisible(episodeAvailability(ep), { showUnaired, showMissing }),
        );
    });

    // =========================================================================
    // Data Loading
    // =========================================================================

    /** Resolve series ID from either field name */
    let resolvedSeriesId = $derived(series.seriesId || series.id);
    /** Resolve series name from either field name */
    let resolvedSeriesName = $derived(series.name || series.title || '');

    async function loadSeriesData() {
        const token = ++seriesLoadToken;
        const seriesId = resolvedSeriesId;
        episodesLoadToken++;
        loadedSeasonNum = undefined;
        appliedInitialSeason = undefined;
        appliedInitialEpisode = undefined;
        isLoading = true;
        loadError = null;
        seasons = [];
        episodes = [];
        seasonEpisodeCache.clear();
        selectedSeasonIndex = 0;

        if (!seriesId) {
            console.error('SeriesEpisodePicker: No series ID provided');
            isLoading = false;
            return;
        }

        // Resume-an-episode fast path: when the caller already knows which season
        // to open, fetch that season's episodes in PARALLEL with the seasons list
        // so the episode list can paint after a single RTT instead of two serial
        // ones. Reconciled against the resolved season index below.
        const hasInitialSeason = initialSeason !== undefined && initialSeason !== null;
        const targetSeasonNum = hasInitialSeason ? Number(initialSeason) : undefined;
        const episodesPrefetch =
            targetSeasonNum !== undefined
                ? contentApi.getSeriesEpisodes(seriesId, targetSeasonNum)
                : null;

        // Attach a rejection handler immediately while the seasons request is pending.
        discardPrefetch(episodesPrefetch);

        try {
            // Fetch seasons from API
            const { data: responseData, error: fetchError } =
                await contentApi.getSeriesSeasons(seriesId);
            if (token !== seriesLoadToken) return;
            if (!fetchError && responseData) {
                seasons = responseData.items.map((s) => ({
                    Id: s.id,
                    id: s.id,
                    Name: s.title,
                    name: s.title,
                    IndexNumber: s.seasonNumber,
                    seasonNumber: s.seasonNumber,
                    episodeCount: s.episodeCount || 0,
                    watchedCount: s.watchedCount || 0,
                    imageTag: pickVariant(s.images?.poster, 'thumb'),
                    episodesHref: s.episodes.href,
                    href: s.href,
                }));
                // Specials (season 0) sort last — regular seasons stay in
                // ascending order, Specials just moves to the end of the list.
                seasons.sort((a, b) => {
                    const aNum = a.IndexNumber ?? a.seasonNumber ?? 0;
                    const bNum = b.IndexNumber ?? b.seasonNumber ?? 0;
                    if (aNum === 0 && bNum !== 0) return 1;
                    if (bNum === 0 && aNum !== 0) return -1;
                    return aNum - bNum;
                });

                // Select initial season if specified, otherwise first regular season
                if (targetSeasonNum !== undefined) {
                    const targetIndex = seasons.findIndex(
                        (s) => Number(s.IndexNumber ?? s.seasonNumber) === targetSeasonNum,
                    );
                    if (targetIndex >= 0) {
                        selectedSeasonIndex = targetIndex;
                    } else {
                        // Target season not found - select the last available REGULAR
                        // season (Specials now sorts last in the array, so skip it here
                        // rather than landing on Specials). This is better UX than
                        // selecting season 1 when user clicked S24E12.
                        let lastSeasonIndex = seasons.length - 1;
                        while (
                            lastSeasonIndex > 0 &&
                            (seasons[lastSeasonIndex].IndexNumber ??
                                seasons[lastSeasonIndex].seasonNumber ??
                                0) === 0
                        ) {
                            lastSeasonIndex--;
                        }
                        selectedSeasonIndex = lastSeasonIndex >= 0 ? lastSeasonIndex : 0;
                    }
                } else {
                    // Skip specials/season 0 if possible
                    const firstRegularSeason = seasons.findIndex(
                        (s) => (s.IndexNumber ?? s.seasonNumber ?? 0) > 0,
                    );
                    selectedSeasonIndex = firstRegularSeason >= 0 ? firstRegularSeason : 0;
                }

                // Reconcile the parallel prefetch against the resolved season.
                const selectedSeason = seasons[selectedSeasonIndex];
                const selectedSeasonNum = selectedSeason
                    ? Number(selectedSeason.IndexNumber ?? selectedSeason.seasonNumber ?? 0)
                    : undefined;

                if (episodesPrefetch && selectedSeasonNum === targetSeasonNum) {
                    // Prefetch targeted exactly the season we selected — apply it,
                    // saving the second serial RTT.
                    await fetchAndApplyEpisodes(episodesPrefetch, targetSeasonNum);
                } else if (seasons.length > 0) {
                    // Target season wasn't in the list and we fell back to a
                    // different season — discard the prefetch and load the season
                    // we actually selected.
                    discardPrefetch(episodesPrefetch);
                    await loadSeasonEpisodes(seasons[selectedSeasonIndex]);
                } else if (episodesPrefetch) {
                    // Season list came back empty but we already prefetched the
                    // target season's episodes — reuse them rather than discard
                    // and refetch season 0 (which would show the wrong season).
                    await fetchAndApplyEpisodes(episodesPrefetch, targetSeasonNum);
                } else {
                    // No seasons and no prefetch — try to get episodes directly.
                    await loadSeasonEpisodes(null);
                }
            } else {
                // API returned error — try episodes directly as fallback
                discardPrefetch(episodesPrefetch);
                loadError = 'Could not load season data';
                await loadSeasonEpisodes(null);
            }
        } catch (error) {
            if (token !== seriesLoadToken) return;
            console.error('Error fetching series data:', error);
            discardPrefetch(episodesPrefetch);
            loadError = 'Could not load season data';
            await loadSeasonEpisodes(null);
        }
    }

    async function loadSeasonEpisodes(season: Season | null): Promise<void> {
        // Season number is the only field the episodes endpoint needs (works
        // with both DB and provider APIs). The old seasonId param was threaded
        // through but never consumed by getSeriesEpisodes.
        const seasonNum = Number(season?.IndexNumber ?? season?.seasonNumber ?? 0);
        await fetchAndApplyEpisodes(
            contentApi.getSeriesEpisodes(resolvedSeriesId!, seasonNum, {
                href: seasons.find((s) => s.seasonNumber === seasonNum)?.episodesHref,
            }),
            seasonNum,
        );
    }

    /**
     * Consume an in-flight getSeriesEpisodes request and distribute the result
     * to `episodes` (+ scroll side-effects). Extracted so a season change and
     * the initial-season parallel prefetch share one mapping/error path.
     */
    async function fetchAndApplyEpisodes(
        request: ReturnType<typeof contentApi.getSeriesEpisodes>,
        requestedSeasonNum?: number,
    ): Promise<void> {
        const token = ++episodesLoadToken;
        episodes = [];
        loadedSeasonNum = undefined;
        isLoading = true;
        loadError = null;

        try {
            const { data: responseData, error: fetchError } = await request;
            // Superseded by a newer season selection while in flight — drop
            // the result (a cache-hit switch bumps the token too).
            if (token !== episodesLoadToken) return;
            if (fetchError || !responseData) {
                loadError = 'Could not load episodes';
                return;
            }
            if (!fetchError && responseData) {
                episodes = responseData.items.map((ep): Episode => ({
                    id: ep.id,
                    name: ep.title,
                    episodeNumber: ep.context?.episodeNumber ?? 0,
                    episodeNumberEnd: ep.context?.endEpisodeNumber,
                    seasonNumber: ep.context?.seasonNumber ?? 0,
                    overview: ep.overview,
                    images: ep.images,
                    imageTag: pickVariant(ep.images?.thumb, 'thumb'),
                    hasOwnStill:
                        ep.images?.thumb?.source === 'self' || ep.images?.thumb?.source === 'frame',
                    runTimeTicks: ep.durationMs === undefined ? undefined : ep.durationMs * 10_000,
                    premiereDate: ep.context?.airDate,
                    playedPercentage: (ep.progress?.fraction ?? 0) * 100,
                    played: ep.progress?.finished ?? false,
                    playbackPositionTicks: (ep.progress?.positionMs ?? 0) * 10_000,
                    externalIds: ep.ids,
                    originalLanguage: ep.originalLanguage,
                    audioLanguages: ep.audioLanguages,
                    subtitleLanguages: ep.subtitleLanguages,
                    hasFile: ep.availability?.hasFile ?? ep.availability?.isAvailable ?? false,
                    segments: ep.segments,
                }));
                // Season switch: always land at the top of the list first —
                // the deep-link/current-episode scroll-into-view below (when
                // applicable) then moves it again.
                resetEpisodeListScroll();
                // Cache under the REQUESTED season number (empty lists too, so
                // re-selecting an empty season doesn't refetch) — data-derived
                // seasonNumber can be missing→0 and collide with Specials.
                if (requestedSeasonNum !== undefined) {
                    seasonEpisodeCache.set(requestedSeasonNum, episodes);
                    loadedSeasonNum = requestedSeasonNum;
                }

                // Scroll to current episode if specified
                if (currentEpisodeId) {
                    scrollToCurrentEpisode();
                } else if (initialEpisode !== undefined && initialEpisode !== null) {
                    // Scroll to initial episode if specified
                    scrollToInitialEpisode(Number(initialEpisode));
                }
            }
        } catch (error) {
            if (token !== episodesLoadToken) return;
            console.error('Error fetching episodes:', error);
            loadError = 'Could not load episodes';
            episodes = [];
        } finally {
            // Only the newest load owns the spinner — a superseded fetch
            // resolving late must not clear it under the active one.
            if (token === episodesLoadToken) isLoading = false;
        }
    }

    /** Discard an unused prefetch without triggering an unhandled rejection. */
    function discardPrefetch(p: ReturnType<typeof contentApi.getSeriesEpisodes> | null): void {
        if (p) void p.catch(() => undefined);
    }

    // =========================================================================
    // Event Handlers
    // =========================================================================

    function selectSeasonByIndex(index: number) {
        selectedSeasonIndex = index;
        seasonDropdownOpen = false;
        const season = seasons[index];
        if (!season) return;
        const seasonNum = Number(season.IndexNumber ?? season.seasonNumber ?? 0);
        const cached = seasonEpisodeCache.get(seasonNum);
        if (cached !== undefined) {
            // Invalidate any in-flight fetch so it can't overwrite this
            // season's (instantly applied) cached list when it resolves.
            episodesLoadToken++;
            episodes = cached;
            loadError = null;
            loadedSeasonNum = seasonNum;
            isLoading = false;
            resetEpisodeListScroll();
            return;
        }
        loadSeasonEpisodes(season);
    }

    function handleSelectEpisode(episode: Episode) {
        onselectEpisode?.(episode);
    }

    function handleShowEpisodeDetails(episode: Episode) {
        // Belt and braces alongside the modalCount effect: drop the panel before
        // the modal it opens can render underneath it.
        closeHoverPanel();
        // A caller that only wires `onselectEpisode` (e.g. a picker with no
        // details view of its own) would otherwise leave the title/row click
        // silently doing nothing — only the thumbnail (which calls
        // `onselectEpisode` directly) did anything. Fall back to selecting the
        // episode so the whole row is always clickable to *something* useful.
        if (onshowEpisodeDetails) {
            onshowEpisodeDetails(episode);
        } else {
            onselectEpisode?.(episode);
        }
    }

    function handleBack() {
        onback?.();
    }

    async function handleToggleWatched(episode: Episode, event: Event): Promise<void> {
        event.preventDefault();
        event.stopPropagation();
        if (pendingWatchedToggles.has(episode.id)) return;
        pendingWatchedToggles.add(episode.id);

        const originalSeriesId = resolvedSeriesId;
        const seasonNumber = loadedSeasonNum ?? episode.seasonNumber;
        const wasPlayed = !!episode.played;
        const newPlayedState = !wasPlayed;
        const notifySaved = onwatchedChange;

        // Target the clicked season, even if the user navigates while saving.
        // Patch only this row so concurrent saves for other rows are preserved.
        function updatePlayed(played: boolean, delta: number): void {
            if (resolvedSeriesId !== originalSeriesId) return;
            const cached = seasonEpisodeCache.get(seasonNumber);
            if (cached) {
                seasonEpisodeCache.set(
                    seasonNumber,
                    cached.map((ep) => (ep.id === episode.id ? { ...ep, played } : ep)),
                );
            }
            if (loadedSeasonNum === seasonNumber) {
                episodes = episodes.map((ep) => (ep.id === episode.id ? { ...ep, played } : ep));
            }
            seasons = seasons.map((s) =>
                Number(s.IndexNumber ?? s.seasonNumber ?? 0) === seasonNumber
                    ? { ...s, watchedCount: Math.max(0, (s.watchedCount || 0) + delta) }
                    : s,
            );
        }

        updatePlayed(newPlayedState, newPlayedState ? 1 : -1);
        try {
            const result = newPlayedState
                ? await userApi.markWatched(episode.id)
                : await userApi.unmarkWatched(episode.id);
            if (result.error || result.data?.watched !== newPlayedState) {
                throw new Error(result.error || 'Unexpected watched state in save response');
            }
        } catch (error) {
            updatePlayed(wasPlayed, newPlayedState ? -1 : 1);
            console.error('Failed to save episode watched status', {
                episodeId: episode.id,
                error,
            });
            toasts.error(
                newPlayedState ? m.toast_mark_watched_failed() : m.card_mark_unwatched_failed(),
            );
            return;
        } finally {
            pendingWatchedToggles.delete(episode.id);
        }

        // Refresh failures must not roll back a successfully persisted write.
        if (resolvedSeriesId === originalSeriesId) {
            notifySaved?.({ episode: { ...episode, played: newPlayedState }, seasonNumber });
        }
    }

    function handleAddEpisode(episode: Episode, event: Event) {
        event.preventDefault();
        event.stopPropagation();
        onaddEpisode?.(episode);
    }

    function handleAddSeason(event: Event) {
        event.preventDefault();
        event.stopPropagation();
        if (currentSeason && episodes.length > 0) {
            onaddSeason?.({
                season: currentSeason,
                episodes: [...episodes],
            });
        }
    }

    function handleRetry(): void {
        loadError = null;
        if (seasons.length > 0 && seasons[selectedSeasonIndex]) {
            loadSeasonEpisodes(seasons[selectedSeasonIndex]);
        } else {
            loadSeriesData();
        }
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    let currentSeason = $derived(seasons[selectedSeasonIndex]);

    function getSeasonName(season: Season): string {
        const num = season.IndexNumber ?? season.seasonNumber ?? 0;
        const name = season.Name || season.name;

        if (num === 0) return m.episode_picker_specials();
        if (name && name !== `Season ${num}` && name !== `Staffel ${num}`) {
            return `${m.episode_picker_season_label()} ${num} - ${name}`;
        }
        return `${m.episode_picker_season_label()} ${num}`;
    }

    function getSeasonShortName(season: Season): string {
        const num = season.IndexNumber ?? season.seasonNumber ?? 0;
        return num === 0 ? 'SP' : `S${num}`;
    }

    function formatRuntime(ticks: number): string {
        const minutes = Math.round(ticks / 10_000_000 / 60);
        // A genuinely short clip (e.g. a 15s teaser) rounds to 0 and read as
        // "0 min." — indistinguishable from missing runtime data. Ticks > 0
        // means there IS a real, just sub-minute, duration.
        if (minutes === 0 && ticks > 0) return m.time_less_than_a_minute();
        return m.time_minutes_short({ count: String(minutes) });
    }

    function formatDate(dateStr: string): string {
        return new Date(dateStr).toLocaleDateString(getLocale());
    }

    function getSeasonImageUrl(season: Season): string | null {
        return season.imageTag ?? null;
    }

    function scrollToCurrentEpisode() {
        if (scrollTimer !== null) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
            scrollTimer = null;
            const currentEl = document.querySelector('.episode-current');
            if (currentEl) {
                currentEl.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                });
                return;
            }
            // Target was filtered out by show-unaired/show-missing flags.
            // Fall back to the nearest visible episode by number to avoid
            // landing the user at an unrelated top-of-list with no feedback.
            const target = episodes.find((ep) => ep.id === currentEpisodeId);
            if (!target) return;
            scrollToNearestVisible(target.episodeNumber);
        }, 100);
    }

    function scrollToInitialEpisode(episodeNumber: number) {
        if (scrollTimer !== null) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
            scrollTimer = null;
            const initialEl = document.querySelector(
                `.episode-initial[data-episode="${episodeNumber}"]`,
            );
            if (initialEl) {
                initialEl.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                });
                return;
            }
            scrollToNearestVisible(episodeNumber);
        }, 100);
    }

    /**
     * Best-effort fallback when the requested target row was filtered out
     * (e.g., admin disabled FEATURE_SHOW_MISSING_EPISODES and the link
     * pointed to a missing episode). Picks the closest visible episode by
     * episodeNumber and scrolls to it. No-op if nothing is visible.
     */
    function scrollToNearestVisible(targetNumber: number) {
        if (visibleEpisodes.length === 0) return;
        let nearest: Episode = visibleEpisodes[0];
        let nearestDelta = Math.abs(nearest.episodeNumber - targetNumber);
        for (const ep of visibleEpisodes) {
            const delta = Math.abs(ep.episodeNumber - targetNumber);
            if (delta < nearestDelta) {
                nearest = ep;
                nearestDelta = delta;
            }
        }
        const el = document.querySelector(`[data-episode="${nearest.episodeNumber}"]`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    $effect(() => {
        resolvedSeriesId;
        untrack(() => void loadSeriesData());
    });

    // `initialSeason`/`initialEpisode` can arrive AFTER mount: opening the
    // modal from a series card (rather than a deep link) leaves both props
    // undefined until the parent's async "continue watching" lookup resolves
    // and starts passing the next-up season/episode down. `loadSeriesData()`
    // above reads them when the series changes, so a value that shows up later
    // would otherwise never move the selection. Not $state — this effect both
    // reads and writes it (same pattern as `lastModalCount` above), so a
    // reactive value here would make the effect depend on its own write.
    let appliedInitialSeason: number | undefined;
    let appliedInitialEpisode: number | undefined;
    $effect(() => {
        const targetSeason = initialSeason;
        const targetEpisode = initialEpisode;
        if (targetSeason === undefined && targetEpisode === undefined) return;
        if (seasons.length === 0) return;
        if (targetSeason === appliedInitialSeason && targetEpisode === appliedInitialEpisode) {
            return;
        }
        appliedInitialSeason = targetSeason;
        appliedInitialEpisode = targetEpisode;

        if (targetSeason !== undefined) {
            const targetIndex = seasons.findIndex(
                (s) => Number(s.IndexNumber ?? s.seasonNumber) === Number(targetSeason),
            );
            if (targetIndex >= 0 && targetIndex !== selectedSeasonIndex) {
                selectSeasonByIndex(targetIndex);
                return;
            }
        }
        if (targetEpisode !== undefined) {
            scrollToInitialEpisode(Number(targetEpisode));
        }
    });
</script>

<div class="episode-picker flex flex-col {inline ? 'inline-picker' : 'h-full'}">
    <!-- Header with back button and series info (non-inline only) -->
    {#if !inline}
        <div
            class="px-4 py-3 border-b border-surface-700 bg-surface-800/50 flex items-center gap-3">
            <Tooltip text={m.episode_picker_back_to_search()} position="right" fixed>
                <button
                    class="p-2 -ml-2 text-surface-400 hover:text-white rounded-lg hover:bg-surface-700 transition-colors"
                    onclick={handleBack}>
                    <Icon src={ChevronLeft} class="w-5 h-5" />
                </button>
            </Tooltip>

            {#if series.imageUrl}
                <img
                    src={series.imageUrl}
                    alt="{resolvedSeriesName} poster"
                    class="w-10 h-14 object-cover rounded-md bg-surface-800" />
            {/if}

            <div class="flex-1 min-w-0">
                <h3 class="font-medium text-white truncate">
                    {resolvedSeriesName}
                </h3>
                <p class="text-xs text-surface-400">
                    {m.episode_picker_select()}
                </p>
            </div>
        </div>
    {/if}

    {#if isLoading && episodes.length === 0}
        <!-- Loading state -->
        <div class="p-8 text-center">
            <span class="loading-spinner loading-spinner-lg loading-spinner-primary mx-auto"></span>
            <p class="text-surface-400 text-sm mt-4">
                {m.episode_picker_loading()}
            </p>
        </div>
    {:else}
        <!-- Season Selector -->
        {#if seasons.length > 1}
            <div class="p-3 border-b border-surface-700 bg-surface-800/30">
                <div class="flex items-center gap-2">
                    <div class="relative flex-1" bind:this={seasonDropdownWrapperEl}>
                        <button
                            class="w-full between p-2.5 bg-surface-700 hover:bg-surface-600 rounded-lg transition-colors"
                            bind:this={seasonDropdownTriggerEl}
                            aria-haspopup="listbox"
                            aria-expanded={seasonDropdownOpen}
                            onclick={() => (seasonDropdownOpen = !seasonDropdownOpen)}>
                            <div class="flex items-center gap-3">
                                {#if currentSeason}
                                    {@const imageUrl = getSeasonImageUrl(currentSeason)}
                                    <div class="relative w-8 h-11 rounded shrink-0">
                                        {#if imageUrl}
                                            <!-- Fallback (shows if image fails) -->
                                            <div
                                                class="w-full h-full rounded bg-primary-500/20 center text-primary-400 font-bold text-xs">
                                                {getSeasonShortName(currentSeason)}
                                            </div>
                                            <!-- Image (overlays fallback) -->
                                            <img
                                                src={imageUrl}
                                                alt="{m.episode_picker_season_label()} {currentSeason.seasonNumber} {m.episode_picker_poster()}"
                                                class="absolute inset-0 w-full h-full rounded object-cover"
                                                onerror={(e: Event) => {
                                                    const target =
                                                        e.currentTarget as HTMLImageElement;
                                                    target.style.display = 'none';
                                                }} />
                                        {:else}
                                            <div
                                                class="w-full h-full rounded bg-primary-500/20 center text-primary-400 font-bold text-xs">
                                                {getSeasonShortName(currentSeason)}
                                            </div>
                                        {/if}
                                    </div>
                                {/if}
                                <div>
                                    <div class="font-medium text-left text-sm">
                                        {currentSeason
                                            ? getSeasonName(currentSeason)
                                            : m.episode_picker_select_season()}
                                    </div>
                                    {#if currentSeason?.episodeCount}
                                        <div class="text-xs text-surface-400">
                                            {currentSeason.episodeCount}
                                            {m.episodes()}
                                            {#if currentSeason.watchedCount && currentSeason.watchedCount > 0}
                                                <span class="mx-1">•</span>
                                                {currentSeason.watchedCount}/{currentSeason.episodeCount}
                                                {m.episode_picker_watched()}
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
                                class="absolute top-full left-0 right-0 mt-1 bg-surface-800 rounded-lg shadow-xl max-h-[min(60vh,37.5rem)] overflow-y-auto overscroll-contain z-10 seasons-dropdown"
                                bind:this={seasonDropdownListEl}
                                role="listbox">
                                {#each seasons as season, i (season.Id || season.id || i)}
                                    {@const seasonImageUrl = getSeasonImageUrl(season)}
                                    {@const isSelected = i === selectedSeasonIndex}
                                    <button
                                        class="w-full flex items-center gap-3 p-2.5 hover:bg-surface-700 transition-colors {isSelected
                                            ? 'bg-surface-700'
                                            : ''}"
                                        role="option"
                                        aria-selected={isSelected}
                                        onclick={() => selectSeasonByIndex(i)}>
                                        <div class="relative w-7 h-10 rounded shrink-0">
                                            {#if seasonImageUrl}
                                                <!-- Fallback (shows if image fails) -->
                                                <div
                                                    class="w-full h-full rounded bg-primary-500/20 center text-primary-400 font-bold text-xs">
                                                    {getSeasonShortName(season)}
                                                </div>
                                                <!-- Image (overlays fallback) -->
                                                <img
                                                    src={seasonImageUrl}
                                                    alt="{m.episode_picker_season_label()} {season.seasonNumber} {m.episode_picker_poster()}"
                                                    class="absolute inset-0 w-full h-full rounded object-cover"
                                                    onerror={(e: Event) => {
                                                        const target =
                                                            e.currentTarget as HTMLImageElement;
                                                        target.style.display = 'none';
                                                    }} />
                                            {:else}
                                                <div
                                                    class="w-full h-full rounded bg-primary-500/20 center text-primary-400 font-bold text-xs">
                                                    {getSeasonShortName(season)}
                                                </div>
                                            {/if}
                                        </div>
                                        <div class="flex-1 text-left">
                                            <div class="font-medium text-sm">
                                                {getSeasonName(season)}
                                            </div>
                                            <div class="text-xs text-surface-400">
                                                {season.episodeCount || 0}
                                                {m.episodes()}
                                            </div>
                                        </div>
                                        {#if season.watchedCount && season.episodeCount}
                                            {#if season.watchedCount >= season.episodeCount}
                                                <Icon
                                                    src={Check}
                                                    class="w-4 h-4 text-green-400"
                                                    solid />
                                            {:else if season.watchedCount > 0}
                                                <span class="text-xs text-surface-400"
                                                    >{season.watchedCount}/{season.episodeCount}</span>
                                            {/if}
                                        {/if}
                                    </button>
                                {/each}
                            </div>
                        {/if}
                    </div>
                    <!-- Add Season button (playlist mode) -->
                    {#if playlistMode && currentSeason && episodes.length > 0}
                        <Tooltip text={m.episode_picker_add_season_hint()} position="left" fixed>
                            <button
                                class="shrink-0 px-3 py-2.5 bg-primary-500 hover:bg-primary-600 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-1"
                                onclick={handleAddSeason}>
                                <Icon src={Plus} class="w-4 h-4" />
                                {m.episode_picker_season()}
                            </button>
                        </Tooltip>
                    {/if}
                </div>
            </div>
        {/if}

        <!-- Episodes List -->
        <div class="flex-1 relative min-h-0">
            <div class="h-full overflow-y-auto episodes-list" bind:this={episodesListEl}>
                {#if loadError && episodes.length === 0 && !isLoading}
                    <div class="p-6 text-center">
                        <p class="text-red-400 text-sm">{loadError}</p>
                        <button
                            class="text-xs text-primary-400 hover:text-primary-300 mt-2 underline"
                            onclick={handleRetry}>
                            Retry
                        </button>
                    </div>
                {:else if episodes.length === 0 && !isLoading}
                    <div class="p-8 text-center">
                        <p class="text-surface-400">
                            {m.episode_picker_no_episodes()}
                        </p>
                    </div>
                {:else if visibleEpisodes.length === 0 && !isLoading}
                    <div class="p-8 text-center">
                        <p class="text-surface-400">
                            {m.episode_picker_all_filtered()}
                        </p>
                    </div>
                {:else}
                    {#each visibleEpisodes as episode, episodeIdx (episode.id + '-' + episodeIdx)}
                        {@const isCurrentEpisode = episode.id === currentEpisodeId}
                        {@const isInitialEpisode =
                            initialEpisode !== undefined &&
                            episode.episodeNumber === Number(initialEpisode) &&
                            (initialSeason === undefined ||
                                episode.seasonNumber === Number(initialSeason))}
                        {@const availability = episodeAvailability(episode)}
                        {@const isUnreleased = availability === 'unreleased'}
                        {@const isMissingOnDisk = availability === 'missing'}
                        {@const isUndated = availability === 'undated'}
                        {@const isUnplayable = availability !== 'available'}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                            class="episode-item w-full px-3 py-2.5 flex items-start gap-4 text-left transition-colors border-b border-surface-800/50 min-h-[76px] {isCurrentEpisode
                                ? 'bg-surface-800 episode-current'
                                : ''} {isInitialEpisode ? 'episode-initial bg-primary-500/10' : ''}"
                            data-episode={episode.episodeNumber}
                            onpointerenter={(e) => handleRowPointerEnter(e, episode)}
                            onpointerleave={handleRowPointerLeave}
                            onfocusin={(e) => handleRowFocusIn(e, episode)}
                            onfocusout={handleRowPointerLeave}>
                            <!-- Episode thumbnail - Click to play -->
                            <Tooltip
                                text={m.episode_picker_play()}
                                position="top"
                                fixed
                                disabled={hoveredEpisode?.id === episode.id}
                                triggerClass="shrink-0 self-center">
                                <button
                                    class="relative shrink-0 group {isUnplayable
                                        ? 'opacity-60'
                                        : ''}"
                                    onclick={() => handleSelectEpisode(episode)}>
                                    <EpisodeStill
                                        {episode}
                                        {resolvedSeriesId}
                                        size="thumb"
                                        class="w-24 h-14" />

                                    <!-- Playing indicator -->
                                    {#if isCurrentEpisode}
                                        <div
                                            class="absolute inset-0 bg-primary-500/30 rounded-md center">
                                            <div class="w-8 h-8 bg-primary-500 rounded-full center">
                                                <Icon src={Play} class="w-4 h-4 text-white" solid />
                                            </div>
                                        </div>
                                    {:else}
                                        <!-- Play overlay on hover -->
                                        <div
                                            class="absolute inset-0 center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-md">
                                            <Icon src={Play} class="w-8 h-8 text-white" solid />
                                        </div>
                                    {/if}

                                    <!-- Progress bar -->
                                    {#if !episode.played && episode.playedPercentage && episode.playedPercentage > 0 && episode.playedPercentage < ($page.data.episodes?.progressBarThreshold ?? 90)}
                                        <div
                                            class="absolute bottom-0 left-0 right-0 h-1 bg-black/50 rounded-b-md">
                                            <div
                                                class="h-full bg-primary-500 rounded-bl-md"
                                                style="width: {episode.playedPercentage}%">
                                            </div>
                                        </div>
                                    {/if}

                                    <!-- Episode number badge -->
                                    <div
                                        class="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/80 rounded text-xs text-white font-medium">
                                        {formatEpisodeNumber(
                                            episode.episodeNumber,
                                            episode.episodeNumberEnd,
                                        )}
                                    </div>
                                </button>
                            </Tooltip>

                            <!-- Episode info - Click to show details -->
                            <div class="flex-1 min-w-0 [&>div]:w-full">
                                <Tooltip
                                    text={m.episode_picker_details()}
                                    position="top"
                                    fixed
                                    disabled={hoveredEpisode?.id === episode.id}
                                    manageDescribedBy={false}>
                                    <div
                                        class="w-full min-w-0 text-left hover:bg-surface-800/50 px-1 rounded transition-colors cursor-pointer overflow-hidden"
                                        role="button"
                                        tabindex="0"
                                        aria-describedby={hoveredEpisode?.id === episode.id
                                            ? hoverPanelId
                                            : undefined}
                                        onclick={() => handleShowEpisodeDetails(episode)}
                                        onkeydown={(e) => {
                                            if (e.key === 'Enter') {
                                                handleShowEpisodeDetails(episode);
                                            } else if (e.key === ' ') {
                                                // Prevent the page/list from scrolling on Space.
                                                e.preventDefault();
                                                handleShowEpisodeDetails(episode);
                                            }
                                        }}>
                                        <div class="flex items-start gap-2 min-w-0">
                                            {#if episode.segments && episode.segments.length > 1}
                                                <div
                                                    class="font-medium text-white text-sm flex-1 min-w-0 space-y-0.5 {isUnplayable
                                                        ? 'text-surface-400 italic'
                                                        : ''}">
                                                    {#each episode.segments as seg, segIdx (seg.episodeNumber + '-' + segIdx)}
                                                        <div
                                                            class="flex items-baseline gap-2 min-w-0">
                                                            <span
                                                                class="text-surface-400 whitespace-nowrap shrink-0"
                                                                >E{seg.episodeNumber}</span>
                                                            <span class="truncate"
                                                                >{seg.title}</span>
                                                        </div>
                                                    {/each}
                                                </div>
                                            {:else}
                                                <h4
                                                    class="font-medium text-white text-sm truncate flex-1 min-w-0 {isUnplayable
                                                        ? 'text-surface-400 italic'
                                                        : ''}">
                                                    {episode.name ||
                                                        `Episode ${episode.episodeNumber}`}
                                                </h4>
                                            {/if}
                                            {#if isUnreleased}
                                                <Tooltip
                                                    text={m.episode_picker_unreleased_tooltip()}
                                                    position="top"
                                                    fixed>
                                                    <span
                                                        class="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                                        {m.episode_picker_unreleased_badge()}
                                                    </span>
                                                </Tooltip>
                                            {:else if isMissingOnDisk}
                                                <Tooltip
                                                    text={m.episode_picker_missing_tooltip()}
                                                    position="top"
                                                    fixed>
                                                    <span
                                                        class="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-rose-500/15 text-rose-300 border border-rose-500/30">
                                                        {m.episode_picker_missing_badge()}
                                                    </span>
                                                </Tooltip>
                                            {:else if isUndated}
                                                <Tooltip
                                                    text={m.episode_picker_undated_tooltip()}
                                                    position="top"
                                                    fixed>
                                                    <span
                                                        class="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide bg-surface-500/20 text-surface-300 border border-surface-500/40">
                                                        {m.episode_picker_undated_badge()}
                                                    </span>
                                                </Tooltip>
                                            {/if}
                                            {#if showWatchedToggle}
                                                <Tooltip
                                                    text={episode.played
                                                        ? m.episode_picker_mark_unwatched()
                                                        : m.episode_picker_mark_watched()}
                                                    position="top"
                                                    fixed>
                                                    <button
                                                        class="p-1 rounded hover:bg-surface-600 transition-colors shrink-0"
                                                        aria-label={episode.played
                                                            ? m.episode_picker_mark_unwatched()
                                                            : m.episode_picker_mark_watched()}
                                                        aria-pressed={!!episode.played}
                                                        disabled={pendingWatchedToggles.has(
                                                            episode.id,
                                                        )}
                                                        onclick={stopPropagation((e) =>
                                                            handleToggleWatched(episode, e),
                                                        )}>
                                                        {#if episode.played}
                                                            <Icon
                                                                src={Check}
                                                                class="w-4 h-4 text-green-400"
                                                                solid />
                                                        {:else}
                                                            <Icon
                                                                src={Eye}
                                                                class="w-4 h-4 text-surface-500 hover:text-surface-300" />
                                                        {/if}
                                                    </button>
                                                </Tooltip>
                                            {:else if episode.played}
                                                <Icon
                                                    src={Check}
                                                    class="w-4 h-4 text-green-400 shrink-0"
                                                    solid />
                                            {/if}
                                        </div>

                                        {#if episode.overview}
                                            <p
                                                class="text-xs text-surface-400 line-clamp-2 mt-0.5 min-w-0 break-words">
                                                {episode.overview}
                                            </p>
                                        {/if}

                                        <div
                                            class="flex items-center gap-2 mt-1 text-xs text-surface-500 min-w-0 flex-wrap">
                                            {#if episode.runTimeTicks}
                                                <span class="shrink-0 whitespace-nowrap"
                                                    >{formatRuntime(episode.runTimeTicks)}</span>
                                            {/if}
                                            {#if episode.premiereDate}
                                                <span class="shrink-0 whitespace-nowrap"
                                                    >{formatDate(episode.premiereDate)}</span>
                                            {/if}
                                            <EpisodeLanguageBadges
                                                originalLanguage={episode.originalLanguage}
                                                audioLanguages={episode.audioLanguages}
                                                subtitleLanguages={episode.subtitleLanguages}
                                                showSeparator={!!(
                                                    episode.runTimeTicks || episode.premiereDate
                                                )} />
                                        </div>
                                    </div>
                                </Tooltip>
                            </div>

                            <!-- Add Episode button (playlist mode) -->
                            {#if playlistMode}
                                <Tooltip
                                    text={playlistEpisodeKeys.has(
                                        `${episode.seasonNumber}:${episode.episodeNumber}`,
                                    )
                                        ? m.episode_picker_already_in_playlist()
                                        : m.episode_picker_add_to_playlist()}
                                    position="left"
                                    fixed>
                                    <button
                                        class="shrink-0 px-2 py-1 rounded text-sm font-medium transition-colors {playlistEpisodeKeys.has(
                                            `${episode.seasonNumber}:${episode.episodeNumber}`,
                                        )
                                            ? 'bg-success-500/20 text-success-400 cursor-default'
                                            : 'bg-primary-500 hover:bg-primary-600 text-white'}"
                                        onclick={(e) =>
                                            !playlistEpisodeKeys.has(
                                                `${episode.seasonNumber}:${episode.episodeNumber}`,
                                            ) && handleAddEpisode(episode, e)}
                                        disabled={playlistEpisodeKeys.has(
                                            `${episode.seasonNumber}:${episode.episodeNumber}`,
                                        )}>
                                        {#if playlistEpisodeKeys.has(`${episode.seasonNumber}:${episode.episodeNumber}`)}
                                            <Icon src={Check} class="w-4 h-4" />
                                        {:else}
                                            <Icon src={Plus} class="w-4 h-4" />
                                        {/if}
                                    </button>
                                </Tooltip>
                            {/if}
                        </div>
                    {/each}
                {/if}
            </div>

            <!-- Season-switch loading overlay: dims the still-visible stale list
             and centers the spinner over it, making clear the visible rows
             are outgoing rather than the new season's content. -->
            {#if isLoading && episodes.length > 0}
                <div
                    class="absolute inset-0 bg-surface-900/70 backdrop-blur-[1px] center z-10"
                    role="status"
                    aria-live="polite">
                    <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
                    <span class="sr-only">{m.loading()}</span>
                </div>
            {/if}
        </div>
    {/if}

    <EpisodeHoverPanel
        episode={hoveredEpisode}
        anchorEl={hoveredAnchorEl}
        {resolvedSeriesId}
        panelId={hoverPanelId}
        onpointerenter={handlePanelPointerEnter}
        onpointerleave={handleRowPointerLeave} />
</div>

<style lang="postcss">
    .line-clamp-2 {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    /* Custom scrollbar for episode list */
    .overflow-y-auto::-webkit-scrollbar,
    .seasons-dropdown::-webkit-scrollbar {
        width: 4px;
    }

    .overflow-y-auto::-webkit-scrollbar-track,
    .seasons-dropdown::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 2px;
    }

    .overflow-y-auto::-webkit-scrollbar-thumb,
    .seasons-dropdown::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 2px;
    }

    .overflow-y-auto::-webkit-scrollbar-thumb:hover,
    .seasons-dropdown::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.3);
    }

    /* Highlight current episode */
    .episode-current {
        position: relative;
    }

    .episode-current::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        background: var(--color-primary-500);
    }

    /* Highlight initial episode (from navigation context) */
    .episode-initial {
        position: relative;
    }

    .episode-initial::before {
        content: '';
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 3px;
        background: var(--color-primary-400);
    }

    /* Inline picker: episodes flow at natural height.
       On mobile, let the outer modal scroll handle everything. */
    @media (max-width: 639px) {
        .inline-picker :global(.episodes-list) {
            overflow-y: visible;
        }

        /* Season list grows in flow instead of floating with its own scroll:
           the outer modal already scrolls, a second scroller traps the touch. */
        .inline-picker .seasons-dropdown {
            position: static;
            max-height: none;
            overflow-y: visible;
        }
    }
</style>
