<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  SongPath — interactive panel that builds a sonic bridge between two tracks.

  The user picks a "From" track and a "To" track via an inline search box.
  Clicking "Find Path" calls GET /api/music/path and renders the ordered bridge.
  Clicking any bridge track plays it. Save as playlist copies all bridge tracks
  and both endpoints into a private playlist, with retry for partial saves.

  Gated: only rendered when features.sonicEmbeddings is true. The parent page
  is responsible for the gate; this component renders a feature-off message when
  `enabled` prop is false so it degrades gracefully if the flag is toggled
  mid-session.
-->

<script lang="ts">
    import { pickVariant } from '$lib/utils/image-utils.js';
    import { onDestroy, onMount, tick } from 'svelte';
    import { get } from 'svelte/store';
    import { page } from '$app/stores';
    import {
        Icon,
        ArrowRight,
        MusicalNote,
        MagnifyingGlass,
        XCircle,
        Sparkles,
        QueueList,
        PlayCircle,
        ChevronDoubleRight,
    } from 'svelte-hero-icons';
    import { musicPlayerStore } from '$lib/stores/music-player.store';

    import * as m from '$lib/paraglide/messages';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import type { MusicTrack } from '$lib/schemas/music';
    import type { SonicPathStepApi } from '$lib/schemas/api-music-responses';
    import { search } from '$lib/api/content';
    import { getSonicPath, getTrack } from '$lib/api/music';
    import { clickOutside } from '$lib/utils/click-outside';
    import { addTrackToPlaylistEntry } from '$lib/components/playlist/add-to-playlist-menu';
    import SaveMixButton from './SaveMixButton.svelte';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';

    // ==========================================================================
    // Props
    // ==========================================================================

    interface Props {
        /** Whether features.sonicEmbeddings is enabled. When false, shows a
         *  degraded empty-state instead of crashing or silently vanishing. */
        enabled?: boolean;
    }

    let { enabled = true }: Props = $props();

    // ==========================================================================
    // Track picker state (shared for both From and To)
    // ==========================================================================

    interface PickedTrack {
        id: string;
        title: string;
        artist: string;
        /** Album title — shown in picker rows so duplicate copies of the same
         *  track across albums/releases are distinguishable. */
        album?: string;
        /** Duration in seconds — same disambiguation purpose as `album`. */
        duration?: number;
        imageUrl: string | undefined;
    }

    let fromTrack = $state<PickedTrack | null>(null);
    let toTrack = $state<PickedTrack | null>(null);

    // Which slot is the search box wired to: 'from' | 'to' | null
    let activeSlot = $state<'from' | 'to' | null>(null);

    let searchQuery = $state('');
    let searchResults = $state<PickedTrack[]>([]);
    let searchLoading = $state(false);
    let searchError = $state<string | null>(null);
    let searchDebounce: ReturnType<typeof setTimeout> | null = null;
    /** Per-slot refs: the From/To field IS the search input (no separate panel),
     *  so each slot needs its own input + clear-button ref for focus management. */
    let fromInputRef = $state<HTMLInputElement | null>(null);
    let toInputRef = $state<HTMLInputElement | null>(null);
    let fromClearBtnRef = $state<HTMLButtonElement | null>(null);
    let toClearBtnRef = $state<HTMLButtonElement | null>(null);

    /** Bound on any in-flight request so a hung socket can't wedge the spinner. */
    const REQUEST_TIMEOUT_MS = 15_000;
    /**
     * Abort-prior controller for the picker search. Its signal cancels the request
     * and gates the result write (the timeout also bounds `searchLoading`)
     * — a superseded or timed-out response is discarded rather than overwriting
     * `searchResults` with stale data.
     */
    let searchController: AbortController | null = null;
    /** Abort-prior controller for the path build (wired into getSonicPath). */
    let pathController: AbortController | null = null;

    // ==========================================================================
    // Path state
    // ==========================================================================

    let stepsParam = $state(8);
    let pathLoading = $state(false);
    let bridgeSteps = $state<SonicPathStepApi[]>([]);
    let pathError = $state<string | null>(null);
    let hasResult = $state(false);
    const searchHasOptions = $derived(!searchLoading && !searchError && searchResults.length > 0);

    // ==========================================================================
    // Search logic
    // ==========================================================================

    function openPicker(slot: 'from' | 'to'): void {
        closePicker();
        activeSlot = slot;
    }

    function closePicker(): void {
        activeSlot = null;
        searchQuery = '';
        searchResults = [];
        if (searchDebounce) {
            clearTimeout(searchDebounce);
            searchDebounce = null;
        }
        // Discard any in-flight picker search so its late response can't reopen
        // stale results after the picker closes.
        searchController?.abort();
        searchController = null;
        searchLoading = false;
        searchError = null;
    }

    /**
     * Fires on focus of either the From or To field. The field itself IS the
     * search input (no separate panel) — focusing it activates that slot and
     * starts a fresh search, same as the old openPicker() button click did.
     */
    function handleFieldFocus(slot: 'from' | 'to'): void {
        if (activeSlot !== slot) openPicker(slot);
    }

    /**
     * Escape closes the dropdown; the field itself keeps DOM focus (we never
     * blur it), so handleFieldInput below reactivates the slot if the user
     * keeps typing.
     */
    function handleFieldKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape' && activeSlot !== null) {
            e.stopPropagation();
            closePicker();
        }
    }

    function handleFieldInput(slot: 'from' | 'to', e: Event): void {
        // Defensive: keeps this field's slot active even if it was cleared
        // (e.g. by Escape) while the field kept focus.
        if (activeSlot !== slot) activeSlot = slot;
        searchQuery = (e.currentTarget as HTMLInputElement).value;
        handleSearchInput();
    }

    function handleSearchInput(): void {
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = null;
        searchController?.abort();
        searchController = null;
        searchLoading = false;
        searchError = null;
        searchResults = [];
        const q = searchQuery.trim();
        if (!q || activeSlot === null) {
            searchResults = [];
            return;
        }
        searchLoading = true;
        searchDebounce = setTimeout(() => {
            searchDebounce = null;
            void doSearch(q);
        }, 300);
    }

    function retrySearch(): void {
        const slot = activeSlot;
        handleSearchInput();
        if (slot) (slot === 'from' ? fromInputRef : toInputRef)?.focus();
    }

    async function doSearch(q: string): Promise<void> {
        // Abort any in-flight search first so a slower earlier response can't
        // overwrite a newer one. The signal cancels the request and guards writes;
        // the timeout independently bounds the loading state.
        searchController?.abort();
        const controller = new AbortController();
        searchController = controller;
        const timer = setTimeout(() => {
            if (searchController === controller) {
                searchError = m.viewer_music_search_error();
                searchLoading = false;
            }
            controller.abort();
        }, REQUEST_TIMEOUT_MS);
        searchLoading = true;
        try {
            const result = await search(q, {
                types: 'track',
                limit: 20,
                signal: controller.signal,
            });
            // Superseded (or timed out) while in flight — drop this response.
            if (controller.signal.aborted) return;
            if (result.error || !result.data) {
                searchResults = [];
                searchError = m.viewer_music_search_error();
                return;
            }
            // v1 contract: { items, page }. Each item is a V1SearchResultItem
            // (type: track|album|artist, ids{}, images{}); the "artist · album"
            // string lives in `overview` (legacy artistName/imageUrl are gone),
            // and track rows additionally carry structured `album`/`duration`.
            const items = result.data.items ?? [];

            searchResults = items
                .filter((item) => item.type === 'track')
                .map((item) => ({
                    id: item.ids.internal ?? item.id,
                    title: item.title,
                    artist: item.overview?.split(' · ')[0] ?? 'Unknown Artist',
                    album: item.album,
                    duration: item.durationMs == null ? undefined : item.durationMs / 1000,
                    imageUrl: pickVariant(item.images.primary, 'thumb'),
                }));
        } catch {
            if (!controller.signal.aborted) searchError = m.viewer_music_search_error();
        } finally {
            clearTimeout(timer);
            // Only the latest (still-current) search clears the spinner, so a
            // superseded request settling late can't hide the newer one's spinner.
            if (searchController === controller) {
                searchLoading = false;
                searchController = null;
            }
        }
    }

    function pickTrack(track: PickedTrack): void {
        const slot = activeSlot;
        if (slot === 'from') {
            fromTrack = track;
        } else if (slot === 'to') {
            toTrack = track;
        }
        closePicker();
        // The field just swapped from an input to a picked-track chip —
        // return focus to the chip's clear button so keyboard/AT users land
        // somewhere sensible instead of losing focus entirely.
        if (slot) {
            void tick().then(() => {
                (slot === 'from' ? fromClearBtnRef : toClearBtnRef)?.focus();
            });
        }
    }

    // ==========================================================================
    // Prefill from route (?from=/&to=) and currently-playing track
    // ==========================================================================

    function trackToPicked(track: MusicTrack): PickedTrack {
        return {
            id: track.id,
            title: track.title,
            artist: track.artists.map((a) => a.title).join(', '),
            album: track.album?.title,
            duration: track.durationMs == null ? undefined : track.durationMs / 1000,
            imageUrl: pickVariant(track.images.primary, 'thumb'),
        };
    }

    async function resolveTrackParam(id: string): Promise<PickedTrack | null> {
        const result = await getTrack(id);
        if (result.error || !result.data) return null;
        return trackToPicked(result.data.track);
    }

    /**
     * ?from=/&to= (set by the "Song Paths" context-menu entry on a track card)
     * take priority; a bare visit with nothing playing prefills nothing.
     */
    async function hydrateFromRoute(): Promise<void> {
        const params = get(page).url.searchParams;
        const fromId = params.get('from');
        const toId = params.get('to');

        if (fromId) {
            const track = await resolveTrackParam(fromId);
            if (track) fromTrack = track;
        } else {
            const current = get(musicPlayerStore).currentTrack;
            if (current && !current.isRadio) fromTrack = trackToPicked(current);
        }

        if (toId) {
            const track = await resolveTrackParam(toId);
            if (track) toTrack = track;
        }
    }

    onMount(() => {
        void hydrateFromRoute();
    });

    // ==========================================================================
    // Path building
    // ==========================================================================

    const canBuildPath = $derived(
        fromTrack !== null && toTrack !== null && fromTrack.id !== toTrack.id && !pathLoading,
    );

    const pathRequirement = $derived(
        !fromTrack || !toTrack
            ? m.music_path_pick_both_hint()
            : fromTrack.id === toTrack.id
              ? m.music_path_different_tracks_hint()
              : null,
    );

    async function buildPath(): Promise<void> {
        if (!canBuildPath || !fromTrack || !toTrack) return;

        // Abort any prior build and bound this one so a stale/hung response can't
        // overwrite a newer path or wedge the spinner.
        pathController?.abort();
        const controller = new AbortController();
        pathController = controller;
        const timer = setTimeout(() => {
            if (pathController === controller) {
                pathError = m.music_path_timeout();
                pathLoading = false;
            }
            controller.abort();
        }, REQUEST_TIMEOUT_MS);

        pathLoading = true;
        pathError = null;
        bridgeSteps = [];
        hasResult = false;

        try {
            const result = await getSonicPath(
                fromTrack.id,
                toTrack.id,
                stepsParam,
                controller.signal,
            );

            // Superseded (or timed out) while in flight — drop this response.
            if (controller.signal.aborted) return;

            if (result.error || !result.data) {
                if (result.status === 404) {
                    pathError = m.music_path_requires_sonic_embeddings();
                } else if (result.status === 422 || result.status === 400) {
                    pathError = result.error ?? m.music_path_bad_request();
                } else {
                    pathError =
                        result.error ??
                        m.music_path_server_error({
                            status: result.status
                                ? String(result.status)
                                : m.music_path_status_unknown(),
                        });
                }
                return;
            }

            bridgeSteps = result.data.steps;
            hasResult = true;
        } catch {
            // An abort (supersede/timeout/destroy) surfaces here — don't show a
            // network error for a request we intentionally discarded.
            if (!controller.signal.aborted) {
                pathError = m.music_path_network_error();
            }
        } finally {
            clearTimeout(timer);
            if (pathController === controller) {
                pathLoading = false;
                pathController = null;
            }
        }
    }

    // ==========================================================================
    // Playback
    // ==========================================================================

    function playBridgeTrack(step: SonicPathStepApi): void {
        musicPlayerStore.play(step.track as unknown as MusicTrack);
    }

    // ==========================================================================
    // Track context menu (right-click) and drag-to-queue
    // ==========================================================================

    function pickedTrackPayload(picked: PickedTrack): MusicTrack {
        return musicTrackFromCard({
            id: picked.id,
            title: picked.title,
            artists: [{ id: null, title: picked.artist }],
            durationMs: picked.duration == null ? null : Math.round(picked.duration * 1000),
        });
    }

    let trackMenu = $state<{ x: number; y: number; track: MusicTrack } | null>(null);

    let trackMenuItems: ContextMenuEntry[] = $derived.by((): ContextMenuEntry[] => {
        const track = trackMenu?.track;
        if (!track) return [];
        return [
            {
                label: m.music_queue_play_now(),
                icon: PlayCircle,
                onSelect: () => musicPlayerStore.play(track),
            },
            {
                label: m.card_music_play_next(),
                icon: ChevronDoubleRight,
                onSelect: () => musicPlayerStore.addToQueueFront(track),
            },
            {
                label: m.card_music_add_to_queue(),
                icon: QueueList,
                onSelect: () => musicPlayerStore.addToQueue(track),
            },
            addTrackToPlaylistEntry(track),
        ];
    });

    function openTrackMenu(e: MouseEvent, track: MusicTrack): void {
        e.preventDefault();
        e.stopPropagation();
        trackMenu = { x: e.clientX, y: e.clientY, track };
    }

    function handleTrackDragStart(e: DragEvent, track: MusicTrack): void {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData('application/lumastra-music-track', JSON.stringify(track));
        e.dataTransfer.effectAllowed = 'copy';
    }

    // ==========================================================================
    // Create playlist
    // ==========================================================================

    // ==========================================================================
    // Full path playback (Play now / Add to queue) — reuses the same
    // musicPlayerStore.enqueueFromBrew() flow BrewTicket uses for brew results.
    // ==========================================================================

    /** Full ordered path: start seed → bridge tracks → end seed. */
    function fullPathTracks(): MusicTrack[] {
        if (!fromTrack || !toTrack || bridgeSteps.length === 0) return [];
        return [
            pickedTrackPayload(fromTrack),
            ...bridgeSteps.map((step) => step.track as unknown as MusicTrack),
            pickedTrackPayload(toTrack),
        ];
    }

    async function playPathNow(): Promise<void> {
        const tracks = fullPathTracks();
        if (tracks.length === 0) return;
        await musicPlayerStore.enqueueFromBrew(tracks, true);
    }

    async function addPathToQueue(): Promise<void> {
        const tracks = fullPathTracks();
        if (tracks.length === 0) return;
        await musicPlayerStore.enqueueFromBrew(tracks, false);
    }

    // ==========================================================================
    // Display helpers
    // ==========================================================================

    function formatDuration(seconds: number | null | undefined): string {
        if (!seconds) return '';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function formatSimilarity(score: number): string {
        return `${Math.round(score * 100)}%`;
    }

    // ==========================================================================
    // Cleanup
    // ==========================================================================

    onDestroy(() => {
        if (searchDebounce) clearTimeout(searchDebounce);
        searchController?.abort();
        pathController?.abort();
    });
</script>

{#if !enabled}
    <div class="empty-state">
        <p>{m.music_path_not_enabled()}</p>
        <p class="hint">
            {m.music_path_not_enabled_hint()}
        </p>
    </div>
{:else}
    <div class="song-path-panel">
        <!-- Header -->
        <p class="panel-instructions">{m.music_path_instructions()}</p>

        <!-- Shared results dropdown, rendered under whichever field is active -->
        {#snippet searchDropdown()}
            <div class="search-dropdown">
                {#if searchLoading}
                    <div class="search-spinner" id="song-path-search-feedback" role="status">
                        <div class="spinner"></div>
                        <span>{m.music_path_searching()}</span>
                    </div>
                {:else if searchError}
                    <p class="search-error" id="song-path-search-feedback" role="alert">
                        {searchError}
                        <button type="button" onclick={retrySearch}>{m.common_retry()}</button>
                    </p>
                {:else if searchResults.length > 0}
                    <ul
                        class="search-results"
                        id="song-path-search-results"
                        role="listbox"
                        aria-label={m.music_path_track_suggestions_aria()}>
                        {#each searchResults as result (result.id)}
                            <li role="presentation">
                                <button
                                    type="button"
                                    class="result-row"
                                    role="option"
                                    aria-selected="false"
                                    onclick={() => pickTrack(result)}>
                                    {#if result.imageUrl}
                                        <img src={result.imageUrl} alt="" class="result-art" />
                                    {:else}
                                        <div class="result-art-placeholder">
                                            <Icon src={MusicalNote} class="result-note-icon" />
                                        </div>
                                    {/if}
                                    <div class="result-info">
                                        <p class="result-title">{result.title}</p>
                                        <p class="result-artist">
                                            {result.artist}{result.album
                                                ? ` · ${result.album}`
                                                : ''}
                                        </p>
                                    </div>
                                    {#if result.duration}
                                        <span class="result-duration">
                                            {formatDuration(result.duration)}
                                        </span>
                                    {/if}
                                </button>
                            </li>
                        {/each}
                    </ul>
                {:else if searchQuery.trim().length > 0}
                    <p class="search-empty" id="song-path-search-feedback" role="status">
                        {m.music_path_no_tracks_found()}
                    </p>
                {:else}
                    <p class="search-hint" id="song-path-search-feedback">
                        {m.music_path_type_to_search()}
                    </p>
                {/if}
            </div>
        {/snippet}

        <!-- Track pickers -->
        <div class="pickers-row">
            <!-- FROM -->
            <div class="picker-slot">
                <span class="picker-label">{m.music_path_from_label()}</span>
                {#if fromTrack}
                    <div class="picked-track">
                        {#if fromTrack.imageUrl}
                            <img src={fromTrack.imageUrl} alt="" class="picked-art" />
                        {:else}
                            <div class="picked-art" aria-hidden="true"></div>
                        {/if}
                        <div class="picked-info">
                            <p class="picked-title">{fromTrack.title}</p>
                            <p class="picked-artist">{fromTrack.artist}</p>
                        </div>
                        <button
                            type="button"
                            class="clear-btn"
                            aria-label={m.music_path_clear_start_aria()}
                            bind:this={fromClearBtnRef}
                            onclick={() => {
                                pathController?.abort();
                                pathLoading = false;
                                fromTrack = null;
                                hasResult = false;
                                bridgeSteps = [];
                            }}>
                            <Icon src={XCircle} class="clear-icon" />
                        </button>
                    </div>
                {:else}
                    <div
                        class="picker-search-wrap"
                        use:clickOutside={() => {
                            if (activeSlot === 'from') closePicker();
                        }}>
                        <div class="picker-input-wrap">
                            <Icon src={MagnifyingGlass} class="picker-search-icon" />
                            <input
                                type="text"
                                class="picker-input"
                                placeholder={m.music_path_pick_start_placeholder()}
                                aria-label={m.music_path_pick_start_aria()}
                                role="combobox"
                                aria-expanded={activeSlot === 'from' && searchHasOptions}
                                aria-controls={activeSlot === 'from' && searchHasOptions
                                    ? 'song-path-search-results'
                                    : undefined}
                                aria-describedby={activeSlot === 'from' && !searchHasOptions
                                    ? 'song-path-search-feedback'
                                    : undefined}
                                aria-autocomplete="list"
                                value={activeSlot === 'from' ? searchQuery : ''}
                                bind:this={fromInputRef}
                                onfocus={() => handleFieldFocus('from')}
                                oninput={(e) => handleFieldInput('from', e)}
                                onkeydown={handleFieldKeydown} />
                            {#if activeSlot === 'from' && searchQuery}
                                <button
                                    type="button"
                                    class="clear-search-btn"
                                    aria-label={m.btn_clear_search()}
                                    onclick={() => {
                                        searchQuery = '';
                                        handleSearchInput();
                                        fromInputRef?.focus();
                                    }}>
                                    <Icon src={XCircle} class="clear-icon" />
                                </button>
                            {/if}
                        </div>
                        {#if activeSlot === 'from'}
                            {@render searchDropdown()}
                        {/if}
                    </div>
                {/if}
            </div>

            <!-- Arrow separator -->
            <div class="arrow-sep" aria-hidden="true">
                <Icon src={ArrowRight} class="arrow-icon" />
            </div>

            <!-- TO -->
            <div class="picker-slot">
                <span class="picker-label">{m.music_path_to_label()}</span>
                {#if toTrack}
                    <div class="picked-track">
                        {#if toTrack.imageUrl}
                            <img src={toTrack.imageUrl} alt="" class="picked-art" />
                        {:else}
                            <div class="picked-art" aria-hidden="true"></div>
                        {/if}
                        <div class="picked-info">
                            <p class="picked-title">{toTrack.title}</p>
                            <p class="picked-artist">{toTrack.artist}</p>
                        </div>
                        <button
                            type="button"
                            class="clear-btn"
                            aria-label={m.music_path_clear_end_aria()}
                            bind:this={toClearBtnRef}
                            onclick={() => {
                                pathController?.abort();
                                pathLoading = false;
                                toTrack = null;
                                hasResult = false;
                                bridgeSteps = [];
                            }}>
                            <Icon src={XCircle} class="clear-icon" />
                        </button>
                    </div>
                {:else}
                    <div
                        class="picker-search-wrap"
                        use:clickOutside={() => {
                            if (activeSlot === 'to') closePicker();
                        }}>
                        <div class="picker-input-wrap">
                            <Icon src={MagnifyingGlass} class="picker-search-icon" />
                            <input
                                type="text"
                                class="picker-input"
                                placeholder={m.music_path_pick_end_placeholder()}
                                aria-label={m.music_path_pick_end_aria()}
                                role="combobox"
                                aria-expanded={activeSlot === 'to' && searchHasOptions}
                                aria-controls={activeSlot === 'to' && searchHasOptions
                                    ? 'song-path-search-results'
                                    : undefined}
                                aria-describedby={activeSlot === 'to' && !searchHasOptions
                                    ? 'song-path-search-feedback'
                                    : undefined}
                                aria-autocomplete="list"
                                value={activeSlot === 'to' ? searchQuery : ''}
                                bind:this={toInputRef}
                                onfocus={() => handleFieldFocus('to')}
                                oninput={(e) => handleFieldInput('to', e)}
                                onkeydown={handleFieldKeydown} />
                            {#if activeSlot === 'to' && searchQuery}
                                <button
                                    type="button"
                                    class="clear-search-btn"
                                    aria-label={m.btn_clear_search()}
                                    onclick={() => {
                                        searchQuery = '';
                                        handleSearchInput();
                                        toInputRef?.focus();
                                    }}>
                                    <Icon src={XCircle} class="clear-icon" />
                                </button>
                            {/if}
                        </div>
                        {#if activeSlot === 'to'}
                            {@render searchDropdown()}
                        {/if}
                    </div>
                {/if}
            </div>
        </div>

        <!-- Controls row -->
        <div class="controls-row">
            <label class="steps-label">
                <span>{m.music_path_intermediate_songs()}</span>
                <input
                    type="range"
                    min="1"
                    max="20"
                    step="1"
                    bind:value={stepsParam}
                    class="steps-range" />
                <span class="steps-value">{stepsParam}</span>
            </label>

            <button
                type="button"
                class={['brew-btn', { disabled: !canBuildPath }]}
                disabled={!canBuildPath}
                aria-describedby={pathRequirement ? 'song-path-requirement' : undefined}
                onclick={buildPath}>
                {#if pathLoading}
                    <div class="spinner btn-spinner"></div>
                    <span>{m.music_path_finding()}</span>
                {:else}
                    <Icon src={Sparkles} class="brew-icon" />
                    <span>{m.music_path_find_button()}</span>
                {/if}
            </button>
        </div>

        {#if pathRequirement}
            <p id="song-path-requirement" class="path-requirement" aria-live="polite">
                {pathRequirement}
            </p>
        {/if}

        <!-- Error state -->
        {#if pathError}
            <div class="path-error">
                <p>{pathError}</p>
            </div>
        {/if}

        <!-- Results -->
        {#if hasResult}
            <div class="bridge-result">
                <!-- Seed: FROM -->
                {#if fromTrack}
                    {@const seedFromPayload = pickedTrackPayload(fromTrack)}
                    <div
                        class="seed-row seed-from"
                        role="button"
                        tabindex="0"
                        draggable="true"
                        ondragstart={(e) => handleTrackDragStart(e, seedFromPayload)}
                        oncontextmenu={(e) => openTrackMenu(e, seedFromPayload)}>
                        <div class="seed-marker">{m.music_path_start_marker()}</div>
                        {#if fromTrack.imageUrl}
                            <img src={fromTrack.imageUrl} alt="" class="step-art" />
                        {:else}
                            <div class="step-art" aria-hidden="true"></div>
                        {/if}
                        <div class="step-info">
                            <p class="step-title">{fromTrack.title}</p>
                            <p class="step-artist">{fromTrack.artist}</p>
                        </div>
                    </div>
                {/if}

                <!-- Bridge steps -->
                {#if bridgeSteps.length === 0}
                    <div class="bridge-empty">
                        <p>
                            {m.music_path_no_bridge_found()}
                        </p>
                    </div>
                {:else}
                    <ul class="bridge-steps">
                        {#each bridgeSteps as step, i (step.id)}
                            {@const artwork = pickVariant(step.track.images.primary, 'thumb')}
                            <li class="bridge-step">
                                <!-- Connector line -->
                                {#if i > 0}
                                    <div class="step-connector" aria-hidden="true"></div>
                                {/if}
                                <button
                                    type="button"
                                    class="step-row"
                                    draggable="true"
                                    onclick={() => playBridgeTrack(step)}
                                    ondragstart={(e) =>
                                        handleTrackDragStart(
                                            e,
                                            step.track as unknown as MusicTrack,
                                        )}
                                    oncontextmenu={(e) =>
                                        openTrackMenu(e, step.track as unknown as MusicTrack)}>
                                    {#if artwork}
                                        <img src={artwork} alt="" class="step-art" />
                                    {:else}
                                        <div class="step-art-placeholder">
                                            <Icon src={MusicalNote} class="step-note-icon" />
                                        </div>
                                    {/if}
                                    <div class="step-info">
                                        <p class="step-title">{step.track.title}</p>
                                        <p class="step-artist">
                                            {step.track.artists.map((a) => a.title).join(', ')}
                                        </p>
                                    </div>
                                    <div class="step-meta">
                                        <span
                                            class="similarity-badge"
                                            title={m.music_path_similarity_title()}>
                                            {formatSimilarity(step.similarityScore)}
                                        </span>
                                        {#if step.track.durationMs}
                                            <span class="step-duration"
                                                >{formatDuration(
                                                    step.track.durationMs == null
                                                        ? null
                                                        : step.track.durationMs / 1000,
                                                )}</span>
                                        {/if}
                                    </div>
                                </button>
                            </li>
                        {/each}
                    </ul>
                {/if}

                <!-- Seed: TO -->
                {#if toTrack}
                    {@const seedToPayload = pickedTrackPayload(toTrack)}
                    <div
                        class="seed-row seed-to"
                        role="button"
                        tabindex="0"
                        draggable="true"
                        ondragstart={(e) => handleTrackDragStart(e, seedToPayload)}
                        oncontextmenu={(e) => openTrackMenu(e, seedToPayload)}>
                        <div class="seed-marker seed-end">{m.music_path_end_marker()}</div>
                        {#if toTrack.imageUrl}
                            <img src={toTrack.imageUrl} alt="" class="step-art" />
                        {:else}
                            <div class="step-art" aria-hidden="true"></div>
                        {/if}
                        <div class="step-info">
                            <p class="step-title">{toTrack.title}</p>
                            <p class="step-artist">{toTrack.artist}</p>
                        </div>
                    </div>
                {/if}

                <!-- Footer actions -->
                {#if bridgeSteps.length > 0}
                    <div class="result-footer">
                        <span class="result-summary">
                            {bridgeSteps.length === 1
                                ? m.music_path_bridge_track_one()
                                : m.music_path_bridge_track_many({
                                      count: String(bridgeSteps.length),
                                  })}
                        </span>
                        <div class="result-actions">
                            <button
                                type="button"
                                class="btn-play"
                                onclick={() => void playPathNow()}>
                                <svg viewBox="0 0 16 16" aria-hidden="true" class="play-icon">
                                    <polygon points="3,1 14,8 3,15" fill="currentColor" />
                                </svg>
                                {m.music_queue_play_now()}
                            </button>
                            <button
                                type="button"
                                class="btn-enqueue"
                                onclick={() => void addPathToQueue()}>
                                {m.card_music_add_to_queue()}
                            </button>
                            <SaveMixButton
                                title={`${fromTrack?.title ?? m.music_path_track_fallback()} → ${toTrack?.title ?? m.music_path_track_fallback()}`}
                                tracks={fullPathTracks()} />
                        </div>
                    </div>
                {/if}
            </div>
        {/if}
    </div>

    {#if trackMenu}
        <ContextMenu
            x={trackMenu.x}
            y={trackMenu.y}
            title={trackMenu.track.title}
            subtitle={trackMenu.track.artists.map((a) => a.title).join(', ')}
            items={trackMenuItems}
            onClose={() => (trackMenu = null)} />
    {/if}
{/if}

<style>
    /* ── Layout ─────────────────────────────────────────────────────────────── */

    .song-path-panel {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
        padding: 1.25rem;
        background: rgb(15 23 42 / 0.6);
        border-radius: 1rem;
        border: 1px solid rgb(30 41 59 / 0.8);
        max-width: 48rem;
    }

    /* ── Header ─────────────────────────────────────────────────────────────── */

    .panel-instructions {
        font-size: 1rem;
        line-height: 1.6;
        color: rgb(203 213 225);
        margin: 0;
    }

    .path-requirement {
        font-size: 0.875rem;
        line-height: 1.5;
        color: rgb(203 213 225);
        margin: -0.5rem 0 0;
    }

    .search-error {
        color: rgb(254 202 202);
        font-size: 0.875rem;
        line-height: 1.5;
        margin: 0;
    }

    .search-error button {
        min-height: 44px;
        padding: 0.25rem 0.5rem;
        text-decoration: underline;
    }

    /* ── Pickers row ────────────────────────────────────────────────────────── */

    .pickers-row {
        display: flex;
        gap: 0.75rem;
        align-items: center;
    }

    .picker-slot {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        min-width: 0;
    }

    .picker-label {
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: rgb(203 213 225); /* slate-500 */
    }

    /* Picker field wrap — positions the results dropdown under the input */
    .picker-search-wrap {
        position: relative;
        width: 100%;
    }

    /* The From/To field IS the search input — this wrapper carries the old
     * dashed-trigger look and solidifies/highlights while the input has focus. */
    .picker-input-wrap {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        background: rgb(30 41 59 / 0.6);
        border: 1px solid rgb(100 116 139);
        border-radius: 0.6rem;
        min-height: 52px;
        padding: 0.25rem 0.5rem 0.25rem 0.75rem;
        color: rgb(203 213 225);
        transition:
            border-color 0.15s,
            background 0.15s;
    }

    .picker-input-wrap:hover {
        border-color: rgb(139 92 246);
    }

    .picker-input-wrap:focus-within {
        border-color: rgb(139 92 246);
        border-style: solid;
        background: rgb(30 41 59);
        box-shadow: 0 0 0 2px rgb(167 139 250 / 0.35);
    }

    .picker-input {
        flex: 1;
        min-width: 0;
        background: none;
        border: none;
        outline: none;
        color: rgb(226 232 240);
        font-size: 1rem;
        min-height: 44px;
        padding: 0;
    }

    .picker-input::placeholder {
        color: rgb(203 213 225);
    }

    .clear-search-btn {
        min-width: 44px;
        min-height: 44px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        flex-shrink: 0;
        color: rgb(148 163 184);
        transition: color 0.15s;
    }

    .clear-search-btn:hover {
        color: rgb(226 232 240);
    }

    :global(.picker-search-icon) {
        width: 0.9rem;
        height: 0.9rem;
        flex-shrink: 0;
    }

    /* Picked track chip */
    .picked-track {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        background: rgb(30 41 59);
        border-radius: 0.6rem;
        padding: 0.4rem 0.6rem 0.4rem 0.4rem;
        min-width: 0;
    }

    .picked-art {
        background: rgb(30 41 59);
        width: 2rem;
        height: 2rem;
        border-radius: 0.3rem;
        object-fit: cover;
        flex-shrink: 0;
    }

    .picked-info {
        flex: 1;
        min-width: 0;
    }

    .picked-title {
        font-size: 0.75rem;
        font-weight: 600;
        color: rgb(226 232 240);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin: 0;
    }

    .picked-artist {
        font-size: 0.65rem;
        color: rgb(203 213 225);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin: 0;
    }

    .clear-btn {
        min-width: 44px;
        min-height: 44px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        flex-shrink: 0;
        color: rgb(148 163 184);
        transition: color 0.15s;
    }

    .clear-btn:hover {
        color: rgb(248 113 113);
    }

    :global(.clear-icon) {
        width: 1rem;
        height: 1rem;
    }

    /* Arrow separator */
    .arrow-sep {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        padding-top: 1.1rem; /* align with picker slot content (below label) */
    }

    :global(.arrow-icon) {
        width: 1.2rem;
        height: 1.2rem;
        color: rgb(148 163 184);
    }

    /* ── Inline search dropdown (anchored under the active From/To field) ──── */

    .search-dropdown {
        position: absolute;
        top: calc(100% + 0.35rem);
        left: 0;
        right: 0;
        z-index: 5;
        background: rgb(15 23 42);
        border: 1px solid rgb(51 65 85);
        border-radius: 0.75rem;
        padding: 0.5rem;
        box-shadow: 0 10px 30px rgb(0 0 0 / 0.4);
    }

    .search-spinner {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0;
        color: rgb(203 213 225);
        font-size: 0.75rem;
    }

    .search-results {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 12rem;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
    }

    .result-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        background: none;
        border: none;
        padding: 0.4rem 0.5rem;
        border-radius: 0.4rem;
        cursor: pointer;
        text-align: left;
        transition: background 0.1s;
    }

    .result-row:hover {
        background: rgb(30 41 59);
    }

    .result-art {
        width: 2rem;
        height: 2rem;
        border-radius: 0.25rem;
        object-fit: cover;
        flex-shrink: 0;
    }

    .result-art-placeholder {
        width: 2rem;
        height: 2rem;
        border-radius: 0.25rem;
        background: rgb(30 41 59);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    :global(.result-note-icon) {
        width: 1rem;
        height: 1rem;
        color: rgb(148 163 184);
    }

    .result-info {
        flex: 1;
        min-width: 0;
    }

    .result-title {
        font-size: 0.78rem;
        font-weight: 500;
        color: rgb(203 213 225);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin: 0;
    }

    .result-artist {
        font-size: 0.65rem;
        color: rgb(148 163 184);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin: 0;
    }

    .result-duration {
        font-size: 0.65rem;
        color: rgb(148 163 184);
        flex-shrink: 0;
        margin-left: auto;
        font-variant-numeric: tabular-nums;
    }

    .search-empty,
    .search-hint {
        font-size: 0.75rem;
        color: rgb(148 163 184);
        text-align: center;
        padding: 0.75rem 0;
        margin: 0;
    }

    /* ── Controls row ───────────────────────────────────────────────────────── */

    .controls-row {
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;
    }

    .steps-label {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
        min-width: 0;
        font-size: 0.875rem;
        color: rgb(203 213 225);
    }

    .steps-range {
        min-width: 0;
        min-height: 44px;
        width: 6rem;
        accent-color: rgb(124 58 237);
    }

    .steps-value {
        min-width: 1.5ch;
        font-weight: 600;
        color: rgb(167 139 250);
    }

    .brew-btn {
        min-height: 44px;
        display: flex;
        align-items: center;
        gap: 0.4rem;
        background: rgb(124 58 237);
        border: none;
        border-radius: 0.6rem;
        padding: 0.5rem 1rem;
        color: white;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        transition:
            background 0.15s,
            opacity 0.15s;
        margin-left: auto;
    }

    .brew-btn:hover:not(.disabled) {
        background: rgb(109 40 217);
    }

    .brew-btn.disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    :global(.brew-icon) {
        width: 1rem;
        height: 1rem;
    }

    /* ── Error ──────────────────────────────────────────────────────────────── */

    .path-error {
        background: rgb(127 29 29 / 0.3);
        border: 1px solid rgb(239 68 68 / 0.4);
        border-radius: 0.5rem;
        padding: 0.6rem 0.75rem;
        font-size: 0.78rem;
        color: rgb(252 165 165);
    }

    .path-error p {
        margin: 0;
    }

    /* ── Bridge result ──────────────────────────────────────────────────────── */

    .bridge-result {
        display: flex;
        flex-direction: column;
        gap: 0;
    }

    /* Seed rows (FROM / TO) */
    .seed-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.5rem 0.75rem;
        background: rgb(30 41 59 / 0.5);
        border-radius: 0.5rem;
    }

    .seed-marker {
        font-size: 0.55rem;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: rgb(139 92 246);
        background: rgb(139 92 246 / 0.15);
        border-radius: 999px;
        padding: 0.15rem 0.4rem;
        flex-shrink: 0;
    }

    .seed-end {
        color: rgb(52 211 153); /* emerald-400 */
        background: rgb(52 211 153 / 0.15);
    }

    /* Bridge steps list */
    .bridge-steps {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        position: relative;
    }

    .bridge-step {
        position: relative;
    }

    .step-connector {
        position: absolute;
        top: -0.6rem;
        left: 1.1rem;
        width: 1px;
        height: 0.6rem;
        background: rgb(51 65 85);
    }

    .step-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        width: 100%;
        background: none;
        border: none;
        padding: 0.5rem 0.75rem;
        border-radius: 0.5rem;
        cursor: pointer;
        text-align: left;
        transition: background 0.1s;
    }

    .step-row:hover {
        background: rgb(30 41 59 / 0.8);
    }

    .step-art {
        background: rgb(30 41 59);
        width: 2.25rem;
        height: 2.25rem;
        border-radius: 0.35rem;
        object-fit: cover;
        flex-shrink: 0;
    }

    .step-art-placeholder {
        width: 2.25rem;
        height: 2.25rem;
        border-radius: 0.35rem;
        background: rgb(30 41 59);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    :global(.step-note-icon) {
        width: 1rem;
        height: 1rem;
        color: rgb(148 163 184);
    }

    .step-info {
        flex: 1;
        min-width: 0;
    }

    .step-title {
        font-size: 0.8rem;
        font-weight: 500;
        color: rgb(203 213 225);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin: 0;
    }

    .step-row:hover .step-title {
        color: rgb(167 139 250);
    }

    .step-artist {
        font-size: 0.65rem;
        color: rgb(148 163 184);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin: 0;
    }

    .step-meta {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 0.15rem;
        flex-shrink: 0;
    }

    .similarity-badge {
        font-size: 0.65rem;
        font-weight: 600;
        color: rgb(167 139 250);
        background: rgb(139 92 246 / 0.15);
        border-radius: 999px;
        padding: 0.1rem 0.4rem;
    }

    .step-duration {
        font-size: 0.6rem;
        color: rgb(148 163 184);
    }

    /* Bridge empty message */
    .bridge-empty {
        padding: 1rem 0.75rem;
        font-size: 0.78rem;
        color: rgb(148 163 184);
        text-align: center;
    }

    .bridge-empty p {
        margin: 0;
    }

    /* Result footer */
    .result-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        flex-wrap: wrap;
        margin-top: 0.75rem;
        padding-top: 0.75rem;
        border-top: 1px solid rgb(30 41 59);
    }

    .result-summary {
        font-size: 0.7rem;
        color: rgb(148 163 184);
    }

    .result-actions {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
    }

    /* Play now / Add to queue — mirrors BrewTicket's ticket-actions buttons */
    .btn-play,
    .btn-enqueue {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        border: none;
        border-radius: 0.4rem;
        padding: 0.4rem 0.9rem;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        transition:
            background 0.15s,
            opacity 0.15s;
    }

    .btn-play {
        background: rgb(124 58 237); /* violet-700 */
        color: #fff;
    }

    .btn-play:hover {
        background: rgb(109 40 217);
    }

    .btn-enqueue {
        background: rgb(30 41 59); /* slate-800 */
        color: rgb(148 163 184); /* slate-400 */
    }

    .btn-enqueue:hover {
        background: rgb(51 65 85);
    }

    .play-icon {
        width: 0.75rem;
        height: 0.75rem;
    }

    /* Spinner */
    .spinner {
        width: 1rem;
        height: 1rem;
        border-radius: 50%;
        border: 2px solid rgb(124 58 237 / 0.3);
        border-top-color: rgb(124 58 237);
        animation: spin 0.7s linear infinite;
        flex-shrink: 0;
    }

    .btn-spinner {
        border-color: white / 0.3;
        border-top-color: white;
        width: 0.85rem;
        height: 0.85rem;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    button:focus-visible,
    input[type='range']:focus-visible {
        outline: 2px solid #c4b5fd;
        outline-offset: 3px;
    }

    @media (max-width: 560px) {
        .pickers-row {
            flex-direction: column;
            align-items: stretch;
        }

        .arrow-sep {
            display: none;
        }

        .controls-row {
            align-items: stretch;
        }

        .steps-label,
        .brew-btn {
            width: 100%;
        }
    }

    /* Empty/gate state */
    .empty-state {
        padding: 2rem 1rem;
        text-align: center;
        color: rgb(148 163 184);
        font-size: 0.85rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .empty-state p {
        margin: 0;
    }

    .hint {
        font-size: 0.75rem;
        color: rgb(51 65 85);
    }
</style>
