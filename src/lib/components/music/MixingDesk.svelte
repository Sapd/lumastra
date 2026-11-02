<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MixingDesk — the main Music Alchemy console.

  Layout:
    [In-page track search]
    [SEED pad]  [AVOID pad]
    [ENERGY knob] [TEMPO knob] [DISCOVERY knob]  [BREW button]
    [Full-width mix result with mood summary]

  State is shared via musicAlchemyStore so the /music dock and this page
  always show the same brew. Local state is limited to the search UI.
-->

<script lang="ts">
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import { pickVariant } from '$lib/utils/image-utils';
    import type { MusicTrack } from '$lib/schemas/music';
    import ConsoleKnob from './ConsoleKnob.svelte';
    import SeedAvoidPad from './SeedAvoidPad.svelte';
    import BrewTicket from './BrewTicket.svelte';
    import { musicAlchemyStore } from '$lib/stores/music-alchemy.store.svelte';
    import { onMount, onDestroy } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, MagnifyingGlass, XMark } from 'svelte-hero-icons';
    import { search } from '$lib/api/content';
    import { clickOutside } from '$lib/utils/click-outside';

    // ── Store init ──────────────────────────────────────────────────────────
    onMount(() => {
        musicAlchemyStore.init();
    });

    // ── In-page track search (local UI state — not shared) ──────────────────
    let searchQuery = $state('');
    let searchResults = $state<MusicTrack[]>([]);
    let isSearching = $state(false);
    /** Whether the results dropdown is visible (closed on Escape / click-outside). */
    let resultsOpen = $state(false);

    let searchVersion = 0;
    let searchError = $state<string | null>(null);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    function onSearchInput(): void {
        const version = ++searchVersion;
        searchError = null;
        searchResults = [];
        isSearching = false;
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        if (searchQuery.trim().length < 2) {
            searchResults = [];
            resultsOpen = false;
            return;
        }
        resultsOpen = true;
        isSearching = true;
        const query = searchQuery.trim();
        debounceTimer = setTimeout(() => {
            void fetchResults(query, version);
        }, 250);
    }

    function closeResults(): void {
        resultsOpen = false;
    }

    function onSearchKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape' && resultsOpen) {
            e.stopPropagation();
            resultsOpen = false;
        }
    }

    async function fetchResults(q: string, version: number): Promise<void> {
        isSearching = true;
        try {
            // Typed client → v1 contract: { items, page }. Each item is a
            // V1SearchResultItem (type: track|album|artist, ids{}, images{});
            // the "artist · album" string lives in `overview`.
            const { data, error } = await search(q, { types: 'track', limit: 30 });
            if (version !== searchVersion) return;
            if (error || !data) {
                searchError = m.viewer_music_search_error();
                searchResults = [];
                return;
            }
            const tracks: MusicTrack[] = (data.items ?? [])
                .filter((it) => it.type === 'track')
                .map((it) => {
                    const id = it.catalogId ?? it.id;
                    return musicTrackFromCard({
                        id,
                        title: it.title,
                        remixerArtists: it.remixerArtists?.map((a) => ({ ...a, id: a.id ?? null })),
                        images: it.images,
                        artists: it.artists?.map((a) => ({ ...a, id: a.id ?? null })) ?? [
                            { id: null, title: it.overview?.split(' · ')[0] ?? 'Unknown Artist' },
                        ],
                        album: it.albumId ? { id: it.albumId, title: it.album ?? '' } : null,
                    });
                });
            searchResults = tracks;
        } catch {
            if (version !== searchVersion) return;
            searchResults = [];
            searchError = m.viewer_music_search_error();
        } finally {
            if (version === searchVersion) isSearching = false;
        }
    }

    function clearSearch(): void {
        searchQuery = '';
        onSearchInput();
    }

    onDestroy(() => {
        searchVersion++;
        if (debounceTimer !== null) clearTimeout(debounceTimer);
    });

    function addSearchTrackToSeed(track: MusicTrack): void {
        musicAlchemyStore.addSeed(track);
    }

    function addSearchTrackToAvoid(track: MusicTrack): void {
        musicAlchemyStore.addAvoid(track);
    }
</script>

<div class="mixing-desk" role="main" aria-label={m.music_feature_mixing_desk_label()}>
    <p class="desk-instructions">{m.music_alchemy_instructions()}</p>

    <!-- In-page track search -->
    <div class="track-search" use:clickOutside={closeResults}>
        <label class="search-label" for="mixing-desk-search"
            >{m.music_alchemy_search_label()}</label>
        <div class="search-input-wrap">
            <span class="search-icon" aria-hidden="true">
                <Icon src={MagnifyingGlass} class="h-4 w-4" />
            </span>
            <input
                id="mixing-desk-search"
                type="search"
                placeholder={m.music_alchemy_search_placeholder()}
                bind:value={searchQuery}
                oninput={onSearchInput}
                onkeydown={onSearchKeydown}
                class="search-input"
                aria-controls={resultsOpen &&
                !isSearching &&
                !searchError &&
                searchResults.length > 0
                    ? 'mixing-desk-search-results'
                    : undefined} />
            {#if searchQuery}
                <button
                    class="search-clear"
                    onclick={clearSearch}
                    aria-label={m.btn_clear_search()}>
                    <Icon src={XMark} class="h-3 w-3" />
                </button>
            {/if}
        </div>

        {#if isSearching}
            <div class="search-loading" aria-live="polite">
                <span class="search-spinner" aria-hidden="true"></span>
                <span class="text-surface-400 text-xs">{m.music_path_searching()}</span>
            </div>
        {:else if searchError && resultsOpen}
            <p role="alert" class="p-3 text-sm text-surface-300">
                {searchError}
                <button class="search-retry" onclick={onSearchInput}>{m.common_retry()}</button>
            </p>
        {:else if searchQuery.trim().length >= 2 && searchResults.length === 0 && resultsOpen}
            <p class="p-3 text-sm text-surface-400">{m.music_path_no_tracks_found()}</p>
        {:else if searchResults.length > 0 && resultsOpen}
            <ul
                id="mixing-desk-search-results"
                class="search-results"
                aria-label={m.music_path_track_suggestions_aria()}>
                {#each searchResults as track (track.id)}
                    {@const artwork = pickVariant(track.images.primary, 'thumb')}
                    <li class="search-result-row">
                        {#if artwork}
                            <img src={artwork} alt="" class="result-art" />
                        {:else}
                            <div class="result-art" aria-hidden="true"></div>
                        {/if}
                        <div class="result-text">
                            <span class="result-title">{track.title}</span>
                            <span class="result-artist"
                                >{track.artists.map((a) => a.title).join(', ')}</span>
                        </div>
                        <div class="result-actions">
                            <button
                                class="btn-add-seed"
                                aria-label={m.music_alchemy_seed_track_aria({ title: track.title })}
                                onclick={() => addSearchTrackToSeed(track)}>
                                {m.music_alchemy_search_add_seed()}
                            </button>
                            <button
                                class="btn-add-avoid"
                                aria-label={m.music_alchemy_avoid_track_aria({
                                    title: track.title,
                                })}
                                onclick={() => addSearchTrackToAvoid(track)}>
                                {m.music_alchemy_search_add_avoid()}
                            </button>
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>

    <!-- Main console surface -->
    <div class="console">
        <!-- Seed pad -->
        <div class="pad-area">
            <SeedAvoidPad
                tracks={musicAlchemyStore.seedTracks}
                type="seed"
                onremove={(t) => musicAlchemyStore.removeFromSeed(t)}
                ondrop={(ts) => musicAlchemyStore.addToSeed(ts)} />
        </div>

        <!-- Avoid pad -->
        <div class="pad-area">
            <SeedAvoidPad
                tracks={musicAlchemyStore.avoidTracks}
                type="avoid"
                onremove={(t) => musicAlchemyStore.removeFromAvoid(t)}
                ondrop={(ts) => musicAlchemyStore.addToAvoid(ts)} />
        </div>
        <div class="console-controls">
            <!-- Knobs section -->
            <div class="knobs-section">
                <ConsoleKnob
                    value={musicAlchemyStore.energy}
                    onchange={(v) => musicAlchemyStore.setEnergy(v)}
                    label={m.music_alchemy_energy()}
                    labelMin={m.music_alchemy_calm()}
                    labelMax={m.music_alchemy_hot()}
                    color="#ef4444" />
                <ConsoleKnob
                    value={musicAlchemyStore.tempo}
                    onchange={(v) => musicAlchemyStore.setTempo(v)}
                    label={m.music_alchemy_tempo()}
                    labelMin={m.music_alchemy_slow()}
                    labelMax={m.music_alchemy_fast()}
                    color="#f59e0b" />
                <ConsoleKnob
                    value={musicAlchemyStore.obscurity}
                    onchange={(v) => musicAlchemyStore.setObscurity(v)}
                    label={m.music_alchemy_obscurity()}
                    labelMin={m.music_alchemy_pop()}
                    labelMax={m.music_alchemy_deep()}
                    color="#8b5cf6" />
            </div>

            <div class="brew-center">
                <button
                    class={['brew-btn', { brewing: musicAlchemyStore.brewing }]}
                    disabled={!musicAlchemyStore.canBrew}
                    onclick={() => musicAlchemyStore.brew()}
                    aria-label={m.music_alchemy_brew()}>
                    {#if musicAlchemyStore.brewing}
                        <span class="brew-spinner" aria-hidden="true"></span>
                        {m.music_alchemy_brewing()}
                    {:else}
                        <svg viewBox="0 0 20 20" aria-hidden="true" class="brew-icon">
                            <path
                                d="M10 2a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 2zm4.33 2.17a.75.75 0 010 1.06l-1.06 1.06a.75.75 0 01-1.06-1.06l1.06-1.06a.75.75 0 011.06 0zM17 9.25a.75.75 0 010 1.5h-1.5a.75.75 0 010-1.5H17zm-2.17 4.33a.75.75 0 01-1.06 0l-1.06-1.06a.75.75 0 011.06-1.06l1.06 1.06a.75.75 0 010 1.06zM10 15.5a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 15.5zm-4.33-1.83a.75.75 0 010 1.06l-1.06 1.06a.75.75 0 01-1.06-1.06l1.06-1.06a.75.75 0 011.06 0zM4.25 10a.75.75 0 01-.75.75H2a.75.75 0 010-1.5h1.5a.75.75 0 01.75.75zm-.92-5.33l1.06 1.06A.75.75 0 013.33 6.8L2.27 5.73a.75.75 0 011.06-1.06z"
                                fill="currentColor" />
                        </svg>
                        {m.music_alchemy_brew()}
                    {/if}
                </button>
                {#if musicAlchemyStore.seedTracks.length === 0}
                    <p class="brew-hint">{m.music_alchemy_ticket_add_seeds()}</p>
                {/if}
            </div>
        </div>
    </div>

    <BrewTicket
        tracks={musicAlchemyStore.brewedTracks}
        totalDurationMs={musicAlchemyStore.totalDurationMs}
        loading={musicAlchemyStore.brewing}
        hasBrewed={musicAlchemyStore.hasBrewed}
        moodAnchors={musicAlchemyStore.moodAnchors}
        seedCount={musicAlchemyStore.seedCount}
        onclear={() => musicAlchemyStore.clearBrew()} />
</div>

<style>
    .mixing-desk {
        width: 100%;
        max-width: 80rem;
        min-width: 0;
        margin: 0 auto;
        /* top padding comes from MusicSubpageHeader when embedded in /music/alchemy */
        padding: 1rem 1rem 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .desk-instructions {
        max-width: 45rem;
        font-size: 1rem;
        line-height: 1.6;
        color: rgb(203 213 225);
        margin: 0;
    }

    .search-label {
        font-size: 0.875rem;
        font-weight: 600;
        color: rgb(226 232 240);
    }

    /* Track search ---------------------------------------------------------- */

    .track-search {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .search-input-wrap {
        position: relative;
        display: flex;
        align-items: center;
    }

    .search-icon {
        position: absolute;
        left: 0.75rem;
        top: 50%;
        transform: translateY(-50%);
        color: rgb(100 116 139);
        pointer-events: none;
    }

    .search-input {
        width: 100%;
        border-radius: 0.5rem;
        border: 1px solid rgb(51 65 85 / 0.6);
        background: rgb(15 23 42 / 0.7);
        color: rgb(226 232 240);
        padding: 0.6rem 3rem 0.6rem 2.25rem;
        min-height: 48px;
        min-width: 0;
        font-size: 1rem;
        outline: none;
        transition:
            border-color 0.15s,
            box-shadow 0.15s;
    }

    .search-input::placeholder {
        color: rgb(148 163 184);
    }

    .search-input:focus {
        border-color: rgb(167 139 250);
        box-shadow: 0 0 0 2px rgb(167 139 250 / 0.35);
    }

    .search-clear {
        position: absolute;
        right: 0.25rem;
        top: 50%;
        transform: translateY(-50%);
        background: none;
        border: none;
        color: rgb(100 116 139);
        cursor: pointer;
        padding: 0.25rem;
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: color 0.1s;
    }

    .search-clear:hover {
        color: rgb(226 232 240);
    }

    .search-loading {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
    }

    .search-retry {
        min-height: 44px;
        padding: 0.25rem 0.5rem;
        text-decoration: underline;
    }

    .search-spinner {
        width: 0.75rem;
        height: 0.75rem;
        border: 2px solid rgb(100 116 139 / 0.3);
        border-top-color: rgb(124 58 237);
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
        flex-shrink: 0;
    }

    .search-results {
        list-style: none;
        margin: 0;
        padding: 0;
        background: rgb(15 23 42 / 0.8);
        border: 1px solid rgb(30 41 59);
        border-radius: 0.75rem;
        overflow: hidden;
        max-height: 16rem;
        overflow-y: auto;
    }

    .search-result-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.5rem 0.75rem;
        transition: background 0.1s;
    }

    .search-result-row:hover {
        background: rgb(30 41 59 / 0.7);
    }

    .search-result-row + .search-result-row {
        border-top: 1px solid rgb(30 41 59 / 0.5);
    }

    .result-art {
        width: 2rem;
        height: 2rem;
        border-radius: 0.25rem;
        object-fit: cover;
        flex-shrink: 0;
        background: rgb(30 41 59);
    }

    .result-text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
    }

    .result-title {
        font-size: 0.8rem;
        font-weight: 500;
        color: rgb(203 213 225);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .result-artist {
        font-size: 0.7rem;
        color: rgb(148 163 184);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .result-actions {
        display: flex;
        gap: 0.35rem;
        flex-shrink: 0;
        flex-wrap: wrap;
    }

    .btn-add-seed,
    .btn-add-avoid {
        min-height: 44px;
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.02em;
        padding: 0.25rem 0.6rem;
        border: none;
        border-radius: 0.5rem;
        cursor: pointer;
        transition:
            opacity 0.15s,
            transform 0.1s;
    }

    .btn-add-seed {
        background: rgb(124 58 237 / 0.25);
        color: rgb(221 214 254);
        border: 1px solid rgb(167 139 250 / 0.6);
    }

    .btn-add-seed:hover {
        background: rgb(124 58 237 / 0.4);
    }

    .btn-add-avoid {
        background: rgb(239 68 68 / 0.15);
        color: rgb(252 165 165);
        border: 1px solid rgb(239 68 68 / 0.3);
    }

    .btn-add-avoid:hover {
        background: rgb(239 68 68 / 0.28);
    }

    /* Console surface ------------------------------------------------------- */

    .console {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1rem;
        align-items: start;
        background: rgb(15 23 42 / 0.7);
        border: 1px solid rgb(30 41 59);
        border-radius: 1rem;
        padding: 1rem;
    }

    .pad-area {
        min-width: 0;
    }

    .console-controls {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 1.5rem;
        border-top: 1px solid rgb(51 65 85);
        padding-top: 1.25rem;
        min-width: 0;
    }

    .knobs-section {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 1.25rem;
        min-width: 0;
    }

    /* Brew row -------------------------------------------------------------- */

    .brew-center {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
    }

    /* Brew button ----------------------------------------------------------- */

    .brew-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        background: linear-gradient(135deg, rgb(124 58 237), rgb(109 40 217));
        color: #fff;
        border: none;
        border-radius: 0.75rem;
        padding: 0.75rem 1.75rem;
        font-size: 0.85rem;
        font-weight: 800;
        letter-spacing: 0.1em;
        cursor: pointer;
        transition:
            opacity 0.15s,
            transform 0.1s,
            box-shadow 0.15s;
        box-shadow: 0 4px 20px rgb(124 58 237 / 0.4);
    }

    .brew-btn:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 6px 24px rgb(124 58 237 / 0.55);
    }

    .brew-btn:active:not(:disabled) {
        transform: translateY(0);
    }

    .brew-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        box-shadow: none;
    }

    .brew-btn.brewing {
        animation: pulse 1.2s ease-in-out infinite;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.7;
        }
    }

    .brew-icon {
        width: 1rem;
        height: 1rem;
    }

    .brew-spinner {
        width: 0.85rem;
        height: 0.85rem;
        border: 2px solid rgb(255 255 255 / 0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
        flex-shrink: 0;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .brew-hint {
        font-size: 0.875rem;
        color: rgb(203 213 225); /* slate-300 */
        text-align: center;
        margin: 0;
    }

    button:focus-visible {
        outline: 2px solid #c4b5fd;
        outline-offset: 3px;
    }

    .result-artist {
        color: rgb(148 163 184);
    }

    /* Responsive: stack on narrow screens ---------------------------------- */

    @media (max-width: 720px) {
        .console {
            grid-template-columns: 1fr;
        }

        .console-controls,
        .knobs-section,
        .brew-center {
            width: 100%;
        }

        .console-controls {
            justify-content: center;
        }

        .search-result-row {
            flex-wrap: wrap;
        }

        .result-actions {
            width: 100%;
            padding-left: 2.6rem;
        }
    }
</style>
