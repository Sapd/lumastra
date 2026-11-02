<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Shared embedding search page component used by both Sound Search and Lyrics
  Search. Owns the search input, submit/clear handlers, and result/state
  rendering. Fetch/abort/state is delegated to the C2 primitive
  `createEmbeddingSearch`.
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import {
        Icon,
        MagnifyingGlass,
        MusicalNote,
        XCircle,
    } from 'svelte-hero-icons';
    import { createEmbeddingSearch } from '$lib/components/music/useEmbeddingSearch.svelte';
    import type { MusicSearchResultItem } from '$lib/schemas/api-music-responses';
    import type { MusicTrack } from '$lib/schemas/music';
    import { musicPlayerStore } from '$lib/stores/music-player.store';

    interface Props {
        kind: 'sound' | 'lyrics';
        endpoint: string;
        subtitle: string;
        inputAriaLabel: string;
        placeholder: string;
        badgeTitle: string;
        emptyTextPrefix: string;
        /** Plain text shown before the bold action name, e.g. "Sonic embeddings must be computed first — run the" */
        emptyHintText: string;
        /** Bold task name shown in the empty hint, e.g. "Sonic Embedding Backfill" */
        emptyHintAction: string;
        gateMessage: string;
        /** When true: idle state shows whenever !hasSearched && !loading (even with no query). When false: only when !hasSearched && !loading && query */
        idleAlwaysVisible: boolean;
        idleText: string;
        examplePrompts?: string[];
        featureEnabled: boolean;
    }

    const {
        endpoint,
        subtitle,
        inputAriaLabel,
        placeholder,
        badgeTitle,
        emptyTextPrefix,
        emptyHintText,
        emptyHintAction,
        gateMessage,
        idleAlwaysVisible,
        idleText,
        examplePrompts,
        featureEnabled,
    }: Props = $props();

    // =========================================================================
    // Search state
    // =========================================================================

    let query = $state('');
    let hasSearched = $state(false);

    const es = createEmbeddingSearch(() => endpoint);

    onDestroy(() => es.dispose());

    // =========================================================================
    // Handlers
    // =========================================================================

    async function doSearch(): Promise<void> {
        const q = query.trim();
        if (!q) return;
        hasSearched = true;
        await es.search(q);
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') void doSearch();
    }

    function clearSearch(): void {
        query = '';
        hasSearched = false;
        es.reset();
    }

    function useExample(prompt: string): void {
        query = prompt;
        void doSearch();
    }

    function playTrack(track: MusicSearchResultItem): void {
        // The player only needs id/title/artist/album to stream — images{} hrefs
        // are embedded in the result item so no further lookup is needed.
        // Cast is safe: MusicSearchResultItem is a subset of the MusicTrack shape.
        void musicPlayerStore.startPlayback(track as unknown as MusicTrack);
    }

    function formatSimilarity(score: number): string {
        return `${Math.round(score * 100)}%`;
    }

    // =========================================================================
    // Derived display flags
    // =========================================================================

    const showIdle = $derived(
        !hasSearched && !es.loading && (idleAlwaysVisible ? true : query.length > 0),
    );
    const showExamples = $derived((examplePrompts?.length ?? 0) > 0 && !hasSearched && !es.loading);

    /** Placeholder rows for the results skeleton shown while a search is loading. */
    const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];
</script>

{#if featureEnabled}
    <div class="embedding-search-page">
        <p class="page-subtitle">{subtitle}</p>

        <!-- Search bar -->
        <div class="search-bar">
            <div class="search-input-wrap">
                <Icon src={MagnifyingGlass} class="search-icon" />
                <input
                    type="text"
                    class="search-input"
                    {placeholder}
                    bind:value={query}
                    onkeydown={handleKeydown}
                    disabled={es.loading}
                    aria-label={inputAriaLabel} />
                {#if query}
                    <button
                        class="clear-btn"
                        onclick={clearSearch}
                        aria-label="Clear search"
                        type="button">
                        <Icon src={XCircle} class="clear-icon" />
                    </button>
                {/if}
            </div>
            <button
                class="search-btn"
                onclick={doSearch}
                disabled={es.loading || !query.trim()}
                type="button">
                {#if es.loading}
                    <span class="spinner" aria-hidden="true"></span>
                    Searching…
                {:else}
                    Search
                {/if}
            </button>
        </div>

        <!-- Example prompts (sound search only, shown before first search) -->
        {#if showExamples && examplePrompts}
            <div class="examples">
                <p class="examples-label">Try:</p>
                <div class="examples-chips">
                    {#each examplePrompts as prompt (prompt)}
                        <button
                            class="example-chip"
                            onclick={() => useExample(prompt)}
                            type="button">
                            {prompt}
                        </button>
                    {/each}
                </div>
            </div>
        {/if}

        <!-- Error -->
        {#if es.errorMsg}
            <div class="error-banner" role="alert">
                {es.errorMsg}
            </div>
        {/if}

        <!-- Results skeleton (while a search is in flight) -->
        {#if es.loading}
            <section class="results-section" aria-label="Loading results" aria-busy="true">
                <ul class="track-list">
                    {#each SKELETON_ROWS as row (row)}
                        <li class="track-item track-item--skeleton" aria-hidden="true">
                            <div class="track-art skeleton-box"></div>
                            <div class="track-info">
                                <span class="skeleton-line skeleton-line--title"></span>
                                <span class="skeleton-line skeleton-line--sub"></span>
                            </div>
                        </li>
                    {/each}
                </ul>
            </section>
        {/if}

        <!-- Results -->
        {#if hasSearched && !es.loading}
            {#if es.tracks.length === 0}
                <div class="empty-state">
                    <Icon src={MusicalNote} class="empty-icon" />
                    <p class="empty-text">{emptyTextPrefix} <em>"{es.resolvedQuery}"</em>.</p>
                    <p class="empty-hint">
                        {emptyHintText} — run the
                        <strong>{emptyHintAction}</strong> task from Admin → Tasks.
                    </p>
                </div>
            {:else}
                <section class="results-section" aria-label="Search results">
                    <p class="results-count">
                        {es.tracks.length} result{es.tracks.length !== 1 ? 's' : ''} for
                        <em>"{es.resolvedQuery}"</em>
                    </p>
                    <ul class="track-list">
                        {#each es.tracks as track (track.id)}
                            <li class="track-item">
                                <button
                                    class="track-play-btn"
                                    onclick={() => playTrack(track)}
                                    aria-label="Play {track.title}"
                                    type="button">
                                    {#if track.images?.primary?.variants?.thumb}
                                        <img
                                            src={track.images.primary?.variants?.thumb}
                                            alt=""
                                            class="track-art"
                                            loading="lazy" />
                                    {:else}
                                        <div class="track-art track-art--placeholder">
                                            <Icon src={MusicalNote} class="placeholder-icon" />
                                        </div>
                                    {/if}
                                </button>
                                <div class="track-info">
                                    <span class="track-title">{track.title}</span>
                                    <span class="track-artist">{track.artists.map((a) => a.title).join(', ')}</span>
                                    {#if track.album?.title}
                                        <span class="track-album">{track.album?.title}</span>
                                    {/if}
                                </div>
                                <div class="track-meta">
                                    {#if track.similarityScore !== undefined}
                                        <span class="similarity-badge" title={badgeTitle}>
                                            {formatSimilarity(track.similarityScore)}
                                        </span>
                                    {/if}
                                </div>
                            </li>
                        {/each}
                    </ul>
                </section>
            {/if}
        {/if}

        <!-- Idle state -->
        {#if showIdle}
            <div class="idle-state">
                <Icon src={MusicalNote} class="idle-icon" />
                <p class="idle-text">{idleText}</p>
            </div>
        {/if}
    </div>
{:else}
    <div class="gate-msg">
        <p>{gateMessage}</p>
    </div>
{/if}

<style>
    /* Page wrapper — shared by the sound + lyrics dedicated search pages */
    :global(.embedding-search-page) {
        max-width: 48rem;
        margin: 0 auto;
        /* top padding owned by MusicSubpageHeader */
        padding: 1.5rem 1rem 2rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    .page-subtitle {
        font-size: 0.875rem;
        color: rgb(100 116 139);
        margin: 0;
    }

    /* Search bar */
    .search-bar {
        display: flex;
        gap: 0.5rem;
    }
    .search-input-wrap {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        border: 1px solid rgb(51 65 85);
        border-radius: 0.5rem;
        padding: 0.5rem 0.75rem;
        background: rgb(15 23 42);
        transition: border-color 0.15s;
    }
    .search-input-wrap:focus-within {
        border-color: rgb(99 102 241);
    }
    :global(.search-icon) {
        width: 1rem;
        height: 1rem;
        color: rgb(100 116 139);
        flex-shrink: 0;
    }
    .search-input {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        color: inherit;
        font-size: 0.875rem;
        min-width: 0;
    }
    .search-input::placeholder {
        color: rgb(100 116 139);
    }
    .clear-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        display: flex;
        color: rgb(100 116 139);
    }
    .clear-btn:hover {
        color: inherit;
    }
    :global(.clear-icon) {
        width: 1rem;
        height: 1rem;
    }
    .search-btn {
        padding: 0.5rem 1.25rem;
        border-radius: 0.5rem;
        background: rgb(99 102 241);
        color: #fff;
        border: none;
        cursor: pointer;
        font-size: 0.875rem;
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 0.375rem;
        flex-shrink: 0;
        transition: background 0.15s;
    }
    .search-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    .search-btn:not(:disabled):hover {
        background: rgb(79 70 229);
    }
    .spinner {
        width: 0.875rem;
        height: 0.875rem;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
    }
    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    /* Example prompts */
    .examples {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
    .examples-label {
        font-size: 0.8125rem;
        color: rgb(100 116 139);
        margin: 0;
        flex-shrink: 0;
    }
    .examples-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
    }
    .example-chip {
        font-size: 0.75rem;
        padding: 0.25rem 0.625rem;
        border-radius: 9999px;
        border: 1px solid rgb(51 65 85);
        background: transparent;
        color: rgb(148 163 184);
        cursor: pointer;
        transition:
            border-color 0.1s,
            color 0.1s;
    }
    .example-chip:hover {
        border-color: rgb(99 102 241);
        color: rgb(165 180 252);
    }

    /* Error */
    .error-banner {
        padding: 0.75rem 1rem;
        border-radius: 0.5rem;
        background: rgb(127 29 29 / 0.4);
        border: 1px solid rgb(185 28 28 / 0.5);
        color: rgb(252 165 165);
        font-size: 0.875rem;
    }

    /* Results */
    .results-section {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }
    .results-count {
        font-size: 0.8125rem;
        color: rgb(100 116 139);
        margin: 0;
    }
    .track-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.375rem;
    }
    .track-item {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0.75rem;
        border-radius: 0.5rem;
        background: rgb(15 23 42 / 0.5);
        border: 1px solid rgb(30 41 59);
        transition: background 0.1s;
    }
    .track-item:hover {
        background: rgb(30 41 59 / 0.7);
    }
    .track-play-btn {
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        flex-shrink: 0;
    }
    .track-art {
        width: 2.5rem;
        height: 2.5rem;
        border-radius: 0.25rem;
        object-fit: cover;
        display: block;
    }
    .track-art--placeholder {
        background: rgb(30 41 59);
        display: flex;
        align-items: center;
        justify-content: center;
    }
    :global(.placeholder-icon) {
        width: 1rem;
        height: 1rem;
        color: rgb(100 116 139);
    }
    .track-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
        min-width: 0;
    }
    .track-title {
        font-size: 0.875rem;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .track-artist {
        font-size: 0.75rem;
        color: rgb(148 163 184);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .track-album {
        font-size: 0.6875rem;
        color: rgb(100 116 139);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .track-meta {
        flex-shrink: 0;
    }

    /* Loading skeleton */
    .track-item--skeleton {
        pointer-events: none;
    }
    .skeleton-box,
    .skeleton-line {
        position: relative;
        overflow: hidden;
        background: rgb(30 41 59 / 0.7);
        border-radius: 0.25rem;
    }
    .skeleton-box {
        width: 2.5rem;
        height: 2.5rem;
        flex-shrink: 0;
    }
    .skeleton-line {
        display: block;
        height: 0.7rem;
        border-radius: 9999px;
    }
    .skeleton-line--title {
        width: 55%;
    }
    .skeleton-line--sub {
        width: 35%;
    }
    .skeleton-box::after,
    .skeleton-line::after {
        content: '';
        position: absolute;
        inset: 0;
        transform: translateX(-100%);
        background: linear-gradient(90deg, transparent, rgb(148 163 184 / 0.12), transparent);
        animation: skeleton-shimmer 1.3s ease-in-out infinite;
    }
    @keyframes skeleton-shimmer {
        100% {
            transform: translateX(100%);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .skeleton-box::after,
        .skeleton-line::after {
            animation: none;
        }
    }
    .similarity-badge {
        font-size: 0.6875rem;
        font-weight: 600;
        color: rgb(129 140 248);
        background: rgb(49 46 129 / 0.4);
        padding: 0.125rem 0.375rem;
        border-radius: 9999px;
        border: 1px solid rgb(99 102 241 / 0.3);
    }

    /* Empty / idle states */
    .empty-state,
    .idle-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        padding: 4rem 1rem;
        text-align: center;
        color: rgb(100 116 139);
    }
    :global(.empty-icon),
    :global(.idle-icon) {
        width: 2.5rem;
        height: 2.5rem;
        opacity: 0.4;
    }
    .empty-text,
    .idle-text {
        font-size: 0.875rem;
        margin: 0;
    }
    .empty-hint {
        font-size: 0.75rem;
        color: rgb(71 85 105);
        margin: 0;
        max-width: 28rem;
    }

    /* Gate message */
    .gate-msg {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4rem 1rem;
        color: rgb(100 116 139);
        font-size: 0.875rem;
    }
</style>
