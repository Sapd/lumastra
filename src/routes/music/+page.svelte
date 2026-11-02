<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import MixPreview from '$lib/components/music/MixPreview.svelte';
    import { openMusicPreview, closeMusicPreview } from '$lib/utils/music-preview-navigation';
    import type { MusicTrack } from '$lib/schemas/music';
    import { toasts } from '$lib/stores/toast.store';
    import { goto, invalidateAll } from '$app/navigation';
    import { browser } from '$app/environment';
    import { page, navigating } from '$app/stores';
    import { resolve } from '$lib/paths';
    import { onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { SectionRenderer } from '$lib/components/sections';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { Icon, MagnifyingGlass, XMark, QueueList } from 'svelte-hero-icons';
    import { getStationTracks, loadMoreQuickPicks as apiLoadMoreQuickPicks } from '$lib/api/music';
    import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
    import type { StationSummary } from '$lib/server/services/music/stations.service';
    import RadioSection from '$lib/components/music/RadioSection.svelte';
    import NavigationProgressBar from '$lib/components/ui/NavigationProgressBar.svelte';
    import { radioSectionPreferences } from '$lib/stores/radioSectionPreferences';
    import SectionSkeleton from '$lib/components/music/SectionSkeleton.svelte';
    import LazySection from '$lib/components/music/LazySection.svelte';
    import MusicMixes from '$lib/components/music/MusicMixes.svelte';
    import MusicFeatureTiles from '$lib/components/music/MusicFeatureTiles.svelte';
    import MusicNavigation from '$lib/components/music/MusicNavigation.svelte';
    import MixingDeskDock from '$lib/components/music/MixingDeskDock.svelte';
    import { musicAlchemyStore } from '$lib/stores/music-alchemy.store.svelte';
    import { createMusicItemHandlers } from '$lib/utils/music-item-handlers.svelte';
    import MusicSearchResults from '$lib/components/music/MusicSearchResults.svelte';
    import {
        handleMusicSearchShortcut,
        musicSearchShortcutLabel,
    } from '$lib/utils/music-search-shortcut';
    import MusicGenreBrowser from '$lib/components/music/MusicGenreBrowser.svelte';
    import MusicMoodChips from '$lib/components/music/MusicMoodChips.svelte';
    import * as m from '$lib/paraglide/messages.js';

    let { data } = $props();

    const musicHandlers = createMusicItemHandlers();
    const {
        hiddenTrackIds,
        getTrackInternalId,
        handleItemClick,
        handleItemPlay,
        handleItemMore,
        handleItemRemove,
    } = musicHandlers;

    // Resolve the streamed taste stations promise into reactive state.
    // While streaming, `tasteStations` stays empty so the chips are simply
    // absent rather than showing a skeleton.
    let tasteStations = $state<StationSummary[]>([]);
    let tasteStationsLoaded = $state(false);
    $effect(() => {
        void data.tasteStations.then((stations) => {
            tasteStations = stations ?? [];
            tasteStationsLoaded = true;
        });
    });

    const QUICK_PICKS_SECTION_ID = 'music-quick-picks';
    const PLAYLISTS_SECTION_ID = 'music-your-playlists';
    const RECENTLY_PLAYED_SECTION_ID = 'music-recently-played';
    const QUICK_PICKS_LOAD_LIMIT = 24;

    // Phase 3: Quick Picks streams from the server. When the promise
    // resolves, we merge the section into the reactive `sections`
    // array below so the existing infinite-scroll / dedup machinery
    // (handleSectionReachEnd, baseQuickPicksSignature, extraQuickPickItems)
    // continues to read from `sections` unchanged.
    let streamedQuickPicks = $state<PageSection | null>(null);
    // Tracks resolution state of the streamed promise separately from the
    // resolved VALUE. Needed because `streamedQuickPicks` can legitimately
    // be null after settling (empty mix, `.catch(() => null)`, new user,
    // EMPTY_STREAMED_SECTION fallback). Without this flag, the skeleton
    // would stay visible forever in those cases. Flips to true on ANY
    // settled promise (section or null) or after a 15s timeout.
    let quickPicksResolved = $state(false);

    $effect(() => {
        const promise = data.quickPicksSection;
        if (!promise) return;
        // Reset state for a fresh promise (e.g. invalidateAll refresh).
        streamedQuickPicks = null;
        quickPicksResolved = false;
        let cancelled = false;
        const timer = setTimeout(() => {
            if (!cancelled) {
                // 15s fetch timeout — treat as null-resolved so the skeleton
                // disappears even if the server never settles the stream.
                // Matches LazySection's FETCH_TIMEOUT_MS behaviour.
                quickPicksResolved = true;
            }
        }, 15_000);
        void promise
            .then((section) => {
                if (!cancelled) {
                    streamedQuickPicks = section;
                    quickPicksResolved = true;
                }
            })
            .finally(() => {
                clearTimeout(timer);
            });
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    });

    // Recently Added Albums also streams, and it is the only section a brand-new
    // user has: no plays, no playlists, and genre rails need 120+ tracks in a
    // genre. Gating the empty state on it too keeps a freshly scanned small
    // library from showing "No music yet".
    let recentlyAddedSettled = $state(false);
    let hasRecentlyAdded = $state(false);

    $effect(() => {
        const promise = data.recentlyAddedAlbumsSection;
        recentlyAddedSettled = false;
        hasRecentlyAdded = false;
        if (!promise) {
            recentlyAddedSettled = true;
            return;
        }
        let cancelled = false;
        void promise
            .then((section) => {
                if (!cancelled) hasRecentlyAdded = (section?.items.length ?? 0) > 0;
            })
            .catch(() => undefined)
            .finally(() => {
                if (!cancelled) recentlyAddedSettled = true;
            });
        return () => {
            cancelled = true;
        };
    });

    let quickPickAppend = $state<{
        baseSignature: string;
        items: UniversalMediaItem[];
        exhausted: boolean;
    }>({ baseSignature: '', items: [], exhausted: false });
    let quickPicksLoading = $state(false);

    // hiddenTrackIds comes from musicHandlers (shared with MusicSearchResults) —
    // see destructure near the top of this script.

    let sections = $derived.by(() => {
        const baseSections: PageSection[] = data.sections ?? [];

        // Phase 3: merge streamed Quick Picks in-place, positioned
        // immediately after Recently Played. Preserves Phase 2 layout
        // order, and lets baseQuickPicksSignature + handleSectionReachEnd
        // continue to read from `sections`.
        let merged: PageSection[];
        if (streamedQuickPicks) {
            const rpIdx = baseSections.findIndex((s) => s.id === RECENTLY_PLAYED_SECTION_ID);
            const insertAt = rpIdx === -1 ? 0 : rpIdx + 1;
            merged = [
                ...baseSections.slice(0, insertAt),
                streamedQuickPicks,
                ...baseSections.slice(insertAt),
            ];
        } else {
            merged = baseSections;
        }

        const baseQuickPicksSection = merged.find(
            (section) => section.id === QUICK_PICKS_SECTION_ID,
        );

        const seenIds = new SvelteSet(
            (baseQuickPicksSection?.items ?? [])
                .map((item) => item.itemKey ?? item.id)
                .filter((id): id is string => !!id),
        );
        const uniqueExtraItems = extraQuickPickItems.filter((item) => {
            const id = item.itemKey ?? item.id;
            if (!id || seenIds.has(id)) return false;
            seenIds.add(id);
            return true;
        });

        const withExtras =
            uniqueExtraItems.length === 0
                ? merged
                : merged.map((section) =>
                      section.id === QUICK_PICKS_SECTION_ID
                          ? {
                                ...section,
                                items: [...section.items, ...uniqueExtraItems],
                                meta: { ...section.meta },
                            }
                          : section,
                  );

        if (hiddenTrackIds.size === 0) return withExtras;
        return withExtras.map((section) => {
            const filtered = section.items.filter((item) => {
                const id = item.itemKey ?? item.id;
                return !id || !hiddenTrackIds.has(id);
            });
            if (filtered.length === section.items.length) return section;
            return { ...section, items: filtered, meta: { ...section.meta } };
        });
    });

    // Phase 3: reads from `streamedQuickPicks.items` directly (the streamed
    // section's BASE items) rather than searching the derived `sections`
    // array. This breaks a transitive derived cycle:
    //   sections -> extraQuickPickItems -> baseQuickPicksSignature -> (sections)
    // The signature only needs to identify the base items for append dedup;
    // the merged array contains the same items plus any appended via
    // extraQuickPickItems, but `baseSignature` must reflect the BASE only.
    let baseQuickPicksSignature = $derived.by(() => {
        if (!streamedQuickPicks) return '';
        return (
            streamedQuickPicks.items
                .map(getTrackInternalId)
                .filter((id): id is string => !!id)
                .join('|') ?? ''
        );
    });

    let extraQuickPickItems = $derived(
        quickPickAppend.baseSignature === baseQuickPicksSignature ? quickPickAppend.items : [],
    );
    let quickPicksExhausted = $derived(
        quickPickAppend.baseSignature === baseQuickPicksSignature && quickPickAppend.exhausted,
    );

    let hasPlaylists = $derived(sections.some((s) => s.id === PLAYLISTS_SECTION_ID));

    // -------------------------------------------------------------------------
    // Radio section position
    // -------------------------------------------------------------------------

    type EffectiveRadioPosition = 'top' | 'auto' | 'bottom' | 'hidden';

    // Default ('auto') anchors the radio shelf right after Quick Picks —
    // tier-2 visibility, below the personalized recommendation. The page
    // body has three render anchors: `top` above the chip strip, `auto`
    // wherever the {#each sections} loop hits the QP section (or its
    // fallback skeleton), and `bottom` after the server-driven block.
    let effectiveRadioPosition = $derived.by((): EffectiveRadioPosition => {
        const pref = $radioSectionPreferences.position;
        if (pref === 'hidden') return 'hidden';
        if (pref === 'top') return 'top';
        if (pref === 'bottom') return 'bottom';
        return 'auto';
    });

    // Whether radio rendered as part of the in-loop "after Quick Picks"
    // anchor — used to suppress the standalone-skeleton fallback so we
    // never double-render. Quick Picks is reachable via three paths:
    //  1. as a section in `sections` (normal case)
    //  2. as a skeleton anchored after Recently Played (still loading)
    //  3. as a standalone skeleton (no Recently Played either)
    let qpInSections = $derived(sections.some((s) => s.id === QUICK_PICKS_SECTION_ID));
    let rpInSections = $derived(sections.some((s) => s.id === RECENTLY_PLAYED_SECTION_ID));

    // -------------------------------------------------------------------------
    // Search (state owned by MusicSearchResults; host keeps input + focus only)
    // -------------------------------------------------------------------------

    let searchQuery = $state($page.url.searchParams.get('q') ?? '');
    let searchInputRef: HTMLInputElement | undefined = $state();
    let searchResultsRef: MusicSearchResults | undefined = $state();
    let isSearchMode = $derived(searchQuery.trim().length >= 2);
    let shortcutLabel = $state('');

    onMount(() => {
        radioSectionPreferences.init();
        // Hydrate the shared Mixing Desk store from localStorage here (not only
        // in the dock's own onMount) — the dock is now gated on seedCount > 0, so
        // if it never mounted we'd never load persisted seeds and it could never
        // appear. init() is idempotent (save() keeps localStorage authoritative).
        musicAlchemyStore.init();
        shortcutLabel = musicSearchShortcutLabel();

        // Mobile deep links to /music?q=… have no search UI (Search moved to a
        // tab) — bounce to /music/search so they don't dead-end on home.
        if (browser && searchQuery && window.innerWidth < 1024) {
            void goto(resolve(`/music/search?q=${encodeURIComponent(searchQuery)}`), {
                replaceState: true,
            });
            return;
        }
        // Only auto-focus when a search query is already present (e.g. navigating
        // back from a search URL). Unconditional focus hijacks the reading order
        // and confuses assistive technology on a fresh page load.
        if (searchQuery) {
            searchInputRef?.focus();
            searchInputRef?.select();
        }
    });

    function handleGlobalKeydown(e: KeyboardEvent): void {
        // ⌘F / Ctrl+F or '/' focuses the music search. A second ⌘F from inside
        // the input falls through to the browser's find-in-page.
        handleMusicSearchShortcut(e, searchInputRef);
    }

    function clearSearch(): void {
        searchQuery = '';
        searchInputRef?.focus();
    }

    function focusSearchInput(): void {
        searchInputRef?.focus();
    }

    function handleSearchInputKeydown(e: KeyboardEvent): void {
        if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
        if ((e.key === 'ArrowDown' || e.key === 'Enter') && isSearchMode) {
            e.preventDefault();
            searchResultsRef?.focusFirstResult();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            if (searchQuery) searchQuery = '';
            else searchInputRef?.blur();
        }
    }

    // -------------------------------------------------------------------------
    // Taste-station chip handling (v3.1)
    // -------------------------------------------------------------------------

    // Sticky last-used station is stored as {userId, label} rather than a
    // bare index. Label-based matching survives the 6h cluster regeneration
    // reshuffling cluster order, and userId scoping prevents cross-user
    // leaks when multiple users share the same browser profile.
    const LAST_STATION_STORAGE_KEY = 'lumastra:music:last-station-v2';

    interface StoredLastStation {
        userId: string;
        label: string;
    }

    const stationPreviewId = $derived(
        new URL($page.state.musicPreviewUrl ?? $page.url.href).searchParams.get('station'),
    );
    // A stored or shared `?station=` id keeps working after re-clustering: when
    // it is not in the fresh list but has the id format, the preview still opens
    // (the tracks call answers 410 once the clustering is gone for good).
    const STATION_ID_FORMAT = /^[0-9a-f]{12}\.\d{1,3}$/;
    const previewStation = $derived.by((): StationSummary | null => {
        const listed = tasteStations.find((station) => station.id === stationPreviewId);
        if (listed) return listed;
        if (tasteStationsLoaded && stationPreviewId && STATION_ID_FORMAT.test(stationPreviewId)) {
            const position = Number.parseInt(stationPreviewId.split('.')[1], 10);
            return {
                id: stationPreviewId,
                label: `Station ${position + 1}`,
                playedTrackCount: 0,
                tagline: '',
                coverTrackIds: [],
            };
        }
        return null;
    });
    const previewStationId = $derived(previewStation?.id ?? null);
    let stationTracks = $state<MusicTrack[]>([]);
    let stationLoading = $state(false);
    let stationError = $state<string | null>(null);
    let stationLoadVersion = 0;
    $effect(() => {
        const stationId = previewStationId;
        if (stationId) untrack(() => void loadStationPreview(stationId));
        else {
            untrack(() => {
                stationLoadVersion++;
            });
            stationTracks = [];
        }
    });
    async function loadStationPreview(id: string): Promise<void> {
        const version = ++stationLoadVersion;
        stationLoading = true;
        stationError = null;
        stationTracks = [];
        try {
            const result = await getStationTracks(id, 50);
            if (version !== stationLoadVersion) return;
            if (result.status === 410) {
                // The clustering behind this id is gone: drop the param and
                // list the stations again.
                closeMusicPreview('station');
                toasts.info('This station has changed. Pick one from the list.');
                void invalidateAll();
                return;
            }
            if (result.error || !result.data)
                stationError = result.error ?? 'Unable to load this station.';
            else stationTracks = result.data.items;
        } catch {
            if (version === stationLoadVersion)
                stationError = 'Unable to load this station. Please try again.';
        } finally {
            if (version === stationLoadVersion) stationLoading = false;
        }
    }

    let startingStation = $state<string | null>(null);
    let lastPlayedStationLabel = $state<string | null>(null);

    onMount(() => {
        if (!browser) return;
        try {
            const raw = localStorage.getItem(LAST_STATION_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw) as Partial<StoredLastStation>;
            if (
                typeof parsed?.userId === 'string' &&
                typeof parsed?.label === 'string' &&
                parsed.userId === $page.data.user?.username
            ) {
                lastPlayedStationLabel = parsed.label;
            }
        } catch {
            // Corrupt / blocked / missing — silently skip
        }
    });

    async function startStation(id: string, selection?: MusicTrack[]): Promise<void> {
        if (startingStation !== null) return;
        startingStation = id;
        try {
            let tracks = selection;
            if (!tracks) {
                const result = await getStationTracks(id, 50);
                if (result.error || !result.data) {
                    toasts.error('Unable to load this station. Open its preview to retry.');
                    return;
                }
                tracks = result.data.items;
            }
            if (!tracks.length) {
                toasts.info('No accessible tracks in this station.');
                return;
            }
            await musicPlayerStore.enqueueFromBrew(tracks);

            // Tag the now-playing queue with station context so the mini
            // player can show "Playing from: <station label>".
            const stationMeta = tasteStations.find((s) => s.id === id);
            if (stationMeta) {
                musicPlayerStore.setPlaybackContext({
                    type: 'station',
                    name: stationMeta.label,
                    stationId: id,
                    href: resolve(`/music?station=${encodeURIComponent(id)}`),
                });
            }

            // Remember (by label + userId) for next page load so the
            // highlight survives cluster re-ordering + doesn't leak across
            // users sharing the browser.
            if (stationMeta) {
                lastPlayedStationLabel = stationMeta.label;
                if (browser) {
                    try {
                        const username = $page.data.user?.username;
                        if (username) {
                            const payload: StoredLastStation = {
                                userId: username,
                                label: stationMeta.label,
                            };
                            localStorage.setItem(LAST_STATION_STORAGE_KEY, JSON.stringify(payload));
                        }
                    } catch {
                        // ignore quota / private-mode errors
                    }
                }
            }
        } catch {
            toasts.error('Unable to start this station. Please try again.');
        } finally {
            startingStation = null;
        }
    }

    // -------------------------------------------------------------------------
    // Section event handlers
    // -------------------------------------------------------------------------
    // handleItemClick/Play/More/Remove and getTrackInternalId come from
    // musicHandlers (shared with MusicSearchResults) — see destructure near
    // the top of this script.

    function getLoadedTrackIds(): string[] {
        const ids = new SvelteSet<string>();
        for (const section of sections) {
            for (const item of section.items) {
                const id = getTrackInternalId(item);
                if (id) ids.add(id);
            }
        }
        return [...ids];
    }

    async function loadMoreQuickPicks(): Promise<void> {
        if (quickPicksLoading || quickPicksExhausted) return;

        const quickPicksSection = sections.find((section) => section.id === QUICK_PICKS_SECTION_ID);
        if (!quickPicksSection) return;

        quickPicksLoading = true;
        try {
            const excludeIds = getLoadedTrackIds();

            const { data: payload, error } = await apiLoadMoreQuickPicks({
                limit: QUICK_PICKS_LOAD_LIMIT,
                excludeIds,
            });
            if (error || !payload) return;

            const seenIds = new SvelteSet(
                quickPicksSection.items
                    .map((item) => item.itemKey ?? item.id)
                    .filter((id): id is string => !!id),
            );
            const newItems = payload.items.filter((item) => {
                const id = item.itemKey ?? item.id;
                if (!id || seenIds.has(id)) return false;
                seenIds.add(id);
                return true;
            });

            if (newItems.length === 0) {
                quickPickAppend = {
                    baseSignature: baseQuickPicksSignature,
                    items: extraQuickPickItems,
                    exhausted: true,
                };
                return;
            }

            quickPickAppend = {
                baseSignature: baseQuickPicksSignature,
                items: [...extraQuickPickItems, ...newItems],
                exhausted: payload.exhausted === true,
            };
        } catch (e) {
            console.warn('[MusicPage] Failed to load more Quick Picks', e);
        } finally {
            quickPicksLoading = false;
        }
    }

    function handleSectionReachEnd(event: { section: PageSection }): void {
        if (event.section.id !== QUICK_PICKS_SECTION_ID) return;
        void loadMoreQuickPicks();
    }
</script>

<svelte:head>
    <title>{m.route_music_title()}</title>
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

<NavigationProgressBar active={!!$navigating || $musicPlayerStore.isLoadingTrack} />

<div class="mx-auto max-w-7xl space-y-6 px-4 pt-4 lg:pt-20 pb-20">
    <MusicNavigation />
    <!-- Zone 1: Slim sticky header — h1 + full-width search -->
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 class="text-3xl font-bold text-surface-50">{m.route_music_title()}</h1>
        {#if $musicPlayerStore.currentTrack && !$musicPlayerStore.currentTrack.isRadio}
            <button
                type="button"
                class="hidden items-center gap-2 rounded-lg bg-surface-800 px-4 py-2.5 text-sm text-surface-100 hover:bg-surface-700 focus-visible:outline-2 focus-visible:outline-primary-400 lg:flex"
                aria-expanded={$musicPlayerStore.isExpanded}
                onclick={() => musicPlayerStore.toggleExpanded()}>
                <Icon src={QueueList} class="h-4 w-4" />
                {m.music_queue_view_label()}
            </button>
        {/if}

        <!-- Search bar — desktop only; mobile uses the Search tab. -->
        <div class="relative hidden flex-1 lg:block">
            <span
                class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-surface-400">
                <Icon src={MagnifyingGlass} class="h-4 w-4" />
            </span>
            <input
                type="text"
                aria-label={m.route_music_search_placeholder()}
                aria-describedby="music-home-search-scope"
                placeholder={m.route_music_search_placeholder()}
                aria-keyshortcuts="Meta+F Control+F /"
                autocomplete="off"
                spellcheck="false"
                bind:value={searchQuery}
                bind:this={searchInputRef}
                onkeydown={handleSearchInputKeydown}
                class="peer w-full rounded-lg border border-surface-600/50 bg-surface-800/80 py-2 pr-14 pl-9 text-base text-surface-50 placeholder-surface-500 outline-none transition-colors focus:border-primary-500/50 focus:ring-1 focus:ring-primary-500/30 sm:text-sm" />
            {#if !searchQuery && shortcutLabel}
                <kbd
                    class="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-surface-600/60 bg-surface-900/60 px-1.5 py-0.5 font-sans text-[11px] text-surface-400 lg:block peer-focus:opacity-0"
                    aria-hidden="true">{shortcutLabel}</kbd>
            {/if}
            {#if searchQuery}
                <button
                    class="absolute top-1/2 right-2 -translate-y-1/2 text-surface-400 hover:text-surface-50"
                    aria-label={m.btn_clear_search()}
                    onclick={clearSearch}>
                    <Icon src={XMark} class="h-4 w-4" />
                </button>
            {/if}
        </div>
    </div>
    <p id="music-home-search-scope" class="hidden text-sm text-surface-400 lg:block">
        {m.viewer_music_search_scope()}
    </p>

    <!-- Mixing Desk Dock — sits in the top band, above search results and main
         content. Only shown once at least one seed is loaded: when empty it was
         a cryptic redundant bar above the Explore card, which is the real entry
         point. Hidden while a search is active so results start at the top of
         the viewport instead of below an unrelated tool. -->
    {#if $page.data?.features?.musicAlchemy === true && musicAlchemyStore.seedCount > 0 && !isSearchMode}
        <MixingDeskDock />
    {/if}

    <!-- Zone 2: Search Results Panel (desktop inline; shared with /music/search) -->
    <MusicSearchResults
        bind:this={searchResultsRef}
        bind:query={searchQuery}
        handlers={musicHandlers}
        onfocusinput={focusSearchInput} />

    <!-- Zones 3–11: main content (hidden in search mode) -->
    <div class="space-y-8" class:hidden={isSearchMode} aria-hidden={isSearchMode}>
        <!-- TOP NAVIGATION BAND — library nav + genre browse + the sonic-tools hub,
             grouped so every "navigate / browse the library" action sits above the
             scrolling content feed. (Search you do up top; content you scroll.) -->

        <!-- Library nav links (Playlists / Albums / Artists) — desktop only;
             mobile gets these via the bottom nav bar + /music/explore. -->
        <nav aria-label={m.route_music_browse_library()}>
            <h2 class="mb-3 text-sm font-semibold text-surface-300">{m.music_tab_library()}</h2>
            <div
                class="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 lg:pb-0">
                <a
                    href={resolve('/playlists?type=music')}
                    class="flex shrink-0 items-center gap-1.5 rounded-lg bg-surface-800 px-4 py-2 text-sm text-surface-300 transition-colors hover:bg-surface-700 hover:text-surface-50">
                    <Icon src={QueueList} class="h-4 w-4" />
                    {m.route_music_playlists()}
                </a>
                <a
                    href={resolve('/music/albums')}
                    class="shrink-0 rounded-lg bg-surface-800 px-4 py-2 text-sm text-surface-300 transition-colors hover:bg-surface-700 hover:text-surface-50">
                    {m.route_music_all_albums()}
                </a>
                <a
                    href={resolve('/music/artists')}
                    class="shrink-0 rounded-lg bg-surface-800 px-4 py-2 text-sm text-surface-300 transition-colors hover:bg-surface-700 hover:text-surface-50">
                    {m.route_music_all_artists()}
                </a>
            </div>
        </nav>
        <p class="text-sm text-surface-400">{m.viewer_music_playback_hint()}</p>

        <!-- Browse by Genre — desktop only; mobile uses the Explore tab. -->
        <div class="hidden lg:block">
            <MusicGenreBrowser
                libraryGenres={data.libraryGenres}
                pinnedGenreNames={data.pinnedGenreNames} />
        </div>

        <!-- Zone 3: Internet Radio — top position -->
        {#if data.radioStations && data.radioStations.length > 0 && effectiveRadioPosition === 'top'}
            <RadioSection stations={data.radioStations} count={data.radioStations.length} />
        {/if}

        <!-- Zone 4: Play-Something-Now Strip — unified Moods + Your Stations -->
        <div class="space-y-3">
            <!-- Moods sub-row: desktop only; mobile uses the Explore tab. -->
            <div class="hidden lg:block">
                <MusicMoodChips moodChips={data.moodChips} />
            </div>

            <!-- Your Stations sub-row: only when taste stations are available -->
            {#if tasteStations.length > 0}
                <div>
                    <h3
                        class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
                        {m.route_music_your_stations()}
                    </h3>
                    <div
                        class="flex gap-2 overflow-x-auto pb-1"
                        title={m.music_taste_stations_tooltip()}>
                        {#each tasteStations as station (station.id)}
                            {@const isActive =
                                $musicPlayerStore.playbackContext?.type === 'station' &&
                                $musicPlayerStore.playbackContext.stationId === station.id}
                            {@const isLastUsed =
                                !isActive &&
                                lastPlayedStationLabel !== null &&
                                lastPlayedStationLabel === station.label}
                            <button
                                class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all {isActive
                                    ? 'border-primary-400 bg-primary-500/25 text-surface-50 shadow-lg shadow-primary-500/20'
                                    : isLastUsed
                                      ? 'border-primary-500/60 bg-surface-700/80 text-surface-50'
                                      : 'border-primary-500/30 bg-surface-800/80 text-surface-100 hover:border-primary-400/60 hover:bg-surface-700 hover:text-surface-50'}"
                                onclick={() => openMusicPreview('station', station.id)}
                                title={isActive
                                    ? m.music_now_playing({
                                          station: station.label,
                                      })
                                    : isLastUsed
                                      ? m.music_last_played({
                                            station: station.tagline,
                                        })
                                      : station.tagline}>
                                <span class={isActive ? 'text-surface-50' : 'text-primary-400'}
                                    >&#9654;</span>
                                <span>{station.label}</span>
                                <span class="text-surface-500">({station.playedTrackCount})</span>
                                {#if startingStation === station.id}
                                    <div
                                        class="ml-1 h-3 w-3 animate-spin rounded-full border-2 border-surface-50/30 border-t-surface-50">
                                    </div>
                                {/if}
                            </button>
                            <button
                                class="shrink-0 rounded-full border border-surface-700 px-3 text-xs"
                                aria-label="Quick play {station.label}"
                                disabled={startingStation !== null}
                                onclick={() => startStation(station.id)}>▶ Play</button>
                        {/each}
                    </div>
                </div>
            {/if}
        </div>

        <MusicMixes />

        <!-- Zones 5–6: Server-Driven Sections + Quick Picks streaming -->
        {#if sections.length > 0 || data.genreCarouselNames.length > 0 || !quickPicksResolved || streamedQuickPicks !== null || !recentlyAddedSettled || hasRecentlyAdded}
            {#snippet topArtistsStream()}
                {#await data.topArtistsSection}
                    <SectionSkeleton variant="artist-row" count={8} />
                {:then taSection}
                    {#if taSection}
                        <SectionRenderer
                            section={taSection}
                            onitemClick={handleItemClick}
                            onitemPlay={handleItemPlay}
                            onitemMore={handleItemMore}
                            onitemRemove={handleItemRemove} />
                    {/if}
                {:catch}
                    <p class="text-sm text-surface-400">
                        {m.route_music_top_artists_error()}
                    </p>
                {/await}
            {/snippet}

            {#snippet recentlyAddedAlbumsStream()}
                {#await data.recentlyAddedAlbumsSection}
                    <SectionSkeleton variant="album-carousel" count={6} />
                {:then raSection}
                    {#if raSection}
                        <SectionRenderer
                            section={raSection}
                            onitemClick={handleItemClick}
                            onitemPlay={handleItemPlay}
                            onitemMore={handleItemMore}
                            onitemRemove={handleItemRemove} />
                    {/if}
                {:catch}
                    <p class="text-sm text-surface-400">
                        {m.route_music_recent_albums_error()}
                    </p>
                {/await}
            {/snippet}

            {#snippet newForYouStream()}
                <LazySection
                    url="/api/music/sections/new-for-you"
                    skeletonVariant="track-carousel"
                    skeletonCount={6}
                    {hiddenTrackIds}
                    onitemClick={handleItemClick}
                    onitemPlay={handleItemPlay}
                    onitemMore={handleItemMore}
                    onitemRemove={handleItemRemove} />
            {/snippet}

            {#snippet moodShelvesStream()}
                {#each data.moodShelves as shelf (shelf.key)}
                    <LazySection
                        url={`/api/music/sections/mood-shelf?mood=${encodeURIComponent(shelf.key)}`}
                        skeletonVariant="track-carousel"
                        skeletonCount={6}
                        {hiddenTrackIds}
                        onitemClick={handleItemClick}
                        onitemPlay={handleItemPlay}
                        onitemMore={handleItemMore}
                        onitemRemove={handleItemRemove} />
                {/each}
            {/snippet}

            {#snippet bylStream()}
                <LazySection
                    url="/api/music/sections/because-you-listened"
                    skeletonVariant="track-carousel"
                    skeletonCount={6}
                    {hiddenTrackIds}
                    onitemClick={handleItemClick}
                    onitemPlay={handleItemPlay}
                    onitemMore={handleItemMore}
                    onitemRemove={handleItemRemove} />
            {/snippet}

            {#snippet sonicFingerprintStream()}
                {#if $page.data?.features?.sonicEmbeddings === true}
                    <LazySection
                        url="/api/music/sonic-fingerprint"
                        skeletonVariant="track-carousel"
                        skeletonCount={6}
                        {hiddenTrackIds}
                        onitemClick={handleItemClick}
                        onitemPlay={handleItemPlay}
                        onitemMore={handleItemMore}
                        onitemRemove={handleItemRemove} />
                {/if}
            {/snippet}

            {#snippet quickPicksStream()}
                <!-- Quick Picks is a 2-row carousel (meta.rows: 2) — reserve two
                     rows so its skeleton is the same height as the loaded shelf. -->
                <SectionSkeleton variant="track-carousel" count={6} rows={2} />
            {/snippet}

            {#snippet genreCarousels()}
                {#each data.genreCarouselNames as genre, genreIdx (genre + '-' + genreIdx)}
                    {@const planned = data.genrePlan[genre]}
                    {#if planned === undefined}
                        <!-- No plan slot for this genre — use unfiltered fallback. -->
                        <LazySection
                            url={`/api/music/sections/genre/${encodeURIComponent(genre)}`}
                            loadMoreUrl={`/api/music/sections/genre/${encodeURIComponent(genre)}`}
                            skeletonVariant="track-carousel"
                            skeletonCount={6}
                            skeletonRows={2}
                            {hiddenTrackIds}
                            onitemClick={handleItemClick}
                            onitemPlay={handleItemPlay}
                            onitemMore={handleItemMore}
                            onitemRemove={handleItemRemove} />
                    {:else if planned.length > 0}
                        {@const idsParam = planned.join(',')}
                        <LazySection
                            url={`/api/music/sections/genre/${encodeURIComponent(genre)}?ids=${idsParam}`}
                            loadMoreUrl={`/api/music/sections/genre/${encodeURIComponent(genre)}`}
                            skeletonVariant="track-carousel"
                            skeletonCount={6}
                            skeletonRows={2}
                            {hiddenTrackIds}
                            onitemClick={handleItemClick}
                            onitemPlay={handleItemPlay}
                            onitemMore={handleItemMore}
                            onitemRemove={handleItemRemove} />
                    {/if}
                    <!-- planned exists and is empty → do not render. All
                         candidates were absorbed by Quick Picks / recently-played. -->
                {/each}
            {/snippet}

            <!-- Phase 3: when Recently Played is absent, the inline skeleton
                 anchor inside the #each never fires. Render the skeleton here
                 instead so new users see a loading indicator while QP streams. -->
            {#if !quickPicksResolved && !sections.some((s) => s.id === RECENTLY_PLAYED_SECTION_ID)}
                {@render quickPicksStream()}
                <!-- Radio (auto) anchor — fallback when neither RP nor QP is
                     a section. Standalone-skeleton path. -->
                {#if data.radioStations && data.radioStations.length > 0 && effectiveRadioPosition === 'auto' && !rpInSections && !qpInSections}
                    <RadioSection stations={data.radioStations} count={data.radioStations.length} />
                {/if}
            {/if}

            {#each sections as section (section.id)}
                {#if section.id === PLAYLISTS_SECTION_ID}
                    <!-- Top Artists / BYL / Recently Added Albums
                         anchor to the stable Playlists section (not Quick Picks,
                         which flips from absent to present as the stream lands
                         and would unmount & remount these components, losing
                         LazySection's `fetched` flag and re-triggering the
                         viewport fetch on every page load). -->
                    {@render topArtistsStream()}
                    {@render bylStream()}
                    {@render sonicFingerprintStream()}

                    {@render recentlyAddedAlbumsStream()}
                    {@render newForYouStream()}
                    {@render moodShelvesStream()}
                {/if}

                <SectionRenderer
                    {section}
                    onitemClick={handleItemClick}
                    onitemPlay={handleItemPlay}
                    onitemMore={handleItemMore}
                    onitemRemove={handleItemRemove}
                    onsectionReachEnd={handleSectionReachEnd} />

                {#if section.id === RECENTLY_PLAYED_SECTION_ID && !quickPicksResolved}
                    {@render quickPicksStream()}
                    <!-- Radio (auto) anchor — when QP is still streaming and
                         lands as a skeleton after Recently Played. -->
                    {#if data.radioStations && data.radioStations.length > 0 && effectiveRadioPosition === 'auto' && !qpInSections}
                        <RadioSection
                            stations={data.radioStations}
                            count={data.radioStations.length} />
                    {/if}
                {/if}

                <!-- Radio (auto) anchor — primary path: QP has resolved and
                     is rendered as a section in this loop. -->
                {#if section.id === QUICK_PICKS_SECTION_ID && data.radioStations && data.radioStations.length > 0 && effectiveRadioPosition === 'auto'}
                    <RadioSection stations={data.radioStations} count={data.radioStations.length} />
                {/if}
            {/each}

            <!-- Fallback when the Playlists anchor is absent (new user, empty
                 library, etc.). Renders the same four snippets that are
                 normally anchored before Playlists so they still appear. -->
            {#if !hasPlaylists}
                {@render topArtistsStream()}
                {@render bylStream()}
                {@render sonicFingerprintStream()}

                {@render recentlyAddedAlbumsStream()}
                {@render newForYouStream()}
                {@render moodShelvesStream()}
            {/if}

            <!-- Zone 7: Genre Carousels (pinned-first lazy carousels) -->
            {@render genreCarousels()}
        {:else}
            <!-- Zone 12: Empty State -->
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <span class="mb-4 text-6xl">&#9834;</span>
                <h2 class="mb-2 text-xl font-semibold text-surface-50">
                    {m.route_music_empty_title()}
                </h2>
                <p class="text-surface-400">
                    {m.route_music_empty_body()}
                </p>
                {#if data.isAdmin}
                    <div class="mt-6 flex flex-col items-center gap-3 sm:flex-row">
                        <a
                            href={resolve('/admin/tasks')}
                            class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-surface-50 transition-colors hover:bg-primary-500">
                            {m.route_music_empty_admin_scan_cta()}
                        </a>
                        <a
                            href={resolve('/admin/developer/sonic-embeddings')}
                            class="rounded-lg border border-surface-600 bg-surface-800 px-4 py-2 text-sm font-medium text-surface-300 transition-colors hover:bg-surface-700 hover:text-surface-50">
                            {m.route_music_empty_admin_sonic_cta()}
                        </a>
                    </div>
                    <p class="mt-3 text-xs text-surface-500">
                        {m.route_music_empty_admin_hint()}
                    </p>
                {/if}
            </div>
        {/if}

        <!-- Advanced discovery follows everyday listening; also available in Explore. -->
        <MusicFeatureTiles />

        <!-- Zone 10: Internet Radio — bottom position -->
        {#if data.radioStations && data.radioStations.length > 0 && effectiveRadioPosition === 'bottom'}
            <RadioSection stations={data.radioStations} count={data.radioStations.length} />
        {/if}
    </div>
</div>

{#if previewStation}
    <MixPreview
        title={previewStation.label}
        tracks={stationTracks}
        loading={stationLoading}
        error={stationError}
        onclose={() => closeMusicPreview('station')}
        onretry={() => previewStation && void loadStationPreview(previewStation.id)}
        onplay={(tracks) =>
            previewStation ? startStation(previewStation.id, tracks) : Promise.resolve()} />
{/if}
