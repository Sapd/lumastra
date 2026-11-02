<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy, tick } from 'svelte';
    import { cubicInOut } from 'svelte/easing';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import {
        findLyricInterludes,
        getCurrentLine,
        parseLRC,
        type SyncedLyricLine,
    } from '$lib/utils/lrc-parser';
    import { getTrackLyrics } from '$lib/api/music';

    type Lyrics = { plain: string | null; syncedLines: SyncedLyricLine[] };
    type LoadResult = { lyrics: Lyrics } | { error: true };
    const NO_LYRICS: Lyrics = { plain: null, syncedLines: [] };

    let lyrics = $state<Lyrics>(NO_LYRICS);
    let currentLineIndex = $state(-1);
    let lyricsContainer = $state<HTMLElement | undefined>(undefined);
    let isLoading = $state(false);
    let loadError = $state(false);
    // The track whose lyrics are on screen (or loading).
    let shownTrackId = '';
    let showToken = 0;
    // Loaded lyrics for the last few tracks, so a crossfade can swap to the
    // incoming track's lyrics (loaded in the background) without a spinner.
    // "No lyrics" expires quickly: the server may fetch them later.
    const LOADED_LIMIT = 4;
    const NEGATIVE_TTL_MS = 60_000;
    const loaded = new Map<string, { lyrics: Lyrics; at: number }>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- cache read on demand; loadedVersion is the reactive signal
    const inflight = new Map<string, Promise<LoadResult>>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- request dedupe, never rendered
    const controllers = new Map<string, AbortController>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- aborted when superseded or on destroy, never rendered
    let loadedVersion = $state(0);

    // During a crossfade the store already holds the incoming track, but the
    // outgoing song is still what is heard: show its lyrics, on its own deck's
    // clock, until the fade's midpoint — and past it until the incoming lyrics
    // are ready, so the swap never shows a spinner. A track crossfading into
    // itself (repeat) keeps the outgoing clock the same way.
    const playingTrackId = $derived($musicPlayerStore.currentTrack?.id ?? '');
    const incomingReady = $derived.by(() => {
        void loadedVersion;
        return loaded.has(playingTrackId);
    });
    const outgoing = $derived.by(() => {
        const s = $musicPlayerStore;
        const out = s.isCrossfading ? s.crossfadeOutgoing : null;
        if (!out) return null;
        return (s.crossfadeProgress ?? 0) >= 0.5 && incomingReady ? null : out;
    });
    const displayTrackId = $derived(outgoing?.trackId ?? playingTrackId);
    const timeMs = $derived(outgoing ? outgoing.timeMs : $musicPlayerStore.currentTimeMs);
    // Auto-follow pauses while the listener scrolls by hand, then resumes.
    const MANUAL_SCROLL_PAUSE_MS = 4_000;
    let manualScrollUntil = 0;
    let scrollParent: HTMLElement | null = null;

    const interludes = $derived(findLyricInterludes(lyrics.syncedLines));
    const activeInterlude = $derived(
        interludes.find((g) => timeMs >= g.startMs && timeMs < g.endMs) ?? null,
    );
    // 0..1 through the active interlude; drives the three filling dots.
    const interludeProgress = $derived(
        activeInterlude
            ? (timeMs - activeInterlude.startMs) / (activeInterlude.endMs - activeInterlude.startMs)
            : 0,
    );

    // Respect prefers-reduced-motion: use instant scroll instead of smooth
    // when the user has requested reduced motion (finding #5).
    const reducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Lyrics load lazily on mount of this panel — there is no eager fetch
    // elsewhere, so reaching the lyrics tab is what triggers a request.
    $effect(() => {
        const id = displayTrackId;
        if (id && id !== shownTrackId) void show(id);
    });

    // The playing track's lyrics drive the lyrics button; mid-fade they load
    // in the background while the outgoing song's lyrics are still shown.
    $effect(() => {
        const id = playingTrackId;
        if (!id) return;
        pruneRequests();
        const hit = cached(id);
        if (hit) musicPlayerStore.setLyricsStatus(statusOf(hit));
        else void requestLyrics(id);
    });

    onDestroy(() => {
        showToken++;
        for (const c of controllers.values()) c.abort();
    });

    // Update current line index based on playback position
    $effect(() => {
        if (lyrics.syncedLines.length > 0) {
            const newIndex = getCurrentLine(lyrics.syncedLines, timeMs);
            if (newIndex !== currentLineIndex) {
                currentLineIndex = newIndex;
                void scrollToActive();
            }
        }
    });

    // Bring the interlude dots into focus when a break starts.
    $effect(() => {
        if (activeInterlude) void scrollToActive();
    });

    // Find the element that actually scrolls (the full-screen lyrics view or
    // the queue side panel) and watch it for manual scrolling.
    $effect(() => {
        if (!lyricsContainer) return;
        let el: HTMLElement | null = lyricsContainer.parentElement;
        while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
            el = el.parentElement;
        }
        scrollParent = el;
        if (!el) return;
        const onManual = () => {
            manualScrollUntil = Date.now() + MANUAL_SCROLL_PAUSE_MS;
            stopFollow();
        };
        el.classList.add('lyrics-no-scrollbar');
        el.addEventListener('wheel', onManual, { passive: true });
        el.addEventListener('touchmove', onManual, { passive: true });
        return () => {
            stopFollow();
            el.classList.remove('lyrics-no-scrollbar');
            el.removeEventListener('wheel', onManual);
            el.removeEventListener('touchmove', onManual);
        };
    });

    function statusOf(l: Lyrics): 'available' | 'unavailable' {
        return l.syncedLines.length > 0 || l.plain ? 'available' : 'unavailable';
    }

    function cached(trackId: string): Lyrics | undefined {
        const hit = loaded.get(trackId);
        if (!hit) return undefined;
        if (statusOf(hit.lyrics) === 'unavailable' && Date.now() - hit.at > NEGATIVE_TTL_MS) {
            return undefined;
        }
        return hit.lyrics;
    }

    function remember(trackId: string, l: Lyrics): void {
        loaded.delete(trackId);
        loaded.set(trackId, { lyrics: l, at: Date.now() });
        if (loaded.size > LOADED_LIMIT) loaded.delete(loaded.keys().next().value!);
        loadedVersion++;
    }

    /** Cancel loads for tracks that are neither on screen nor playing (fast skipping). */
    function pruneRequests(): void {
        for (const [id, c] of controllers) {
            if (id === displayTrackId || id === playingTrackId) continue;
            c.abort();
            controllers.delete(id);
            inflight.delete(id);
        }
    }

    /** Load (or join the in-flight load of) a track's lyrics; errors are not cached. */
    function requestLyrics(trackId: string): Promise<LoadResult> {
        const pending = inflight.get(trackId);
        if (pending) return pending;
        const controller = new AbortController();
        controllers.set(trackId, controller);
        const isPlaying = () => trackId === $musicPlayerStore.currentTrack?.id;
        const load = async (): Promise<LoadResult> => {
            try {
                const result = await getTrackLyrics(trackId, controller.signal);
                // Superseded or unmounted: nothing to remember or report.
                if (controller.signal.aborted) return { error: true };
                if (result.error && result.status !== 404) return { error: true };
                let l: Lyrics = NO_LYRICS;
                // lyrics is null for a known track with no lyrics: keep NO_LYRICS.
                if (result.data?.lyrics) {
                    const syncedLines = result.data.syncedLines ?? [];
                    const plain = result.data.lyrics.plain ?? null;
                    l =
                        syncedLines.length === 0 && result.data.lyrics.synced
                            ? { plain, syncedLines: parseLRC(result.data.lyrics.synced).lines }
                            : { plain, syncedLines };
                }
                remember(trackId, l);
                if (isPlaying()) musicPlayerStore.setLyricsStatus(statusOf(l));
                return { lyrics: l };
            } catch {
                if (!controller.signal.aborted && isPlaying()) {
                    musicPlayerStore.setLyricsStatus('unavailable');
                }
                return { error: true };
            }
        };
        // Cleanup runs after inflight.set even when getTrackLyrics throws
        // synchronously, and never removes a newer request for the same track.
        const promise: Promise<LoadResult> = load().finally(() => {
            if (inflight.get(trackId) === promise) inflight.delete(trackId);
            if (controllers.get(trackId) === controller) controllers.delete(trackId);
        });
        inflight.set(trackId, promise);
        return promise;
    }

    async function show(trackId: string): Promise<void> {
        const token = ++showToken;
        shownTrackId = trackId;
        currentLineIndex = -1;
        loadError = false;
        pruneRequests();
        const hit = cached(trackId);
        if (hit) {
            lyrics = hit;
            isLoading = false;
            return;
        }
        lyrics = NO_LYRICS;
        isLoading = true;
        const result = await requestLyrics(trackId);
        // A newer show() owns the panel now.
        if (token !== showToken) return;
        isLoading = false;
        if ('lyrics' in result) lyrics = result.lyrics;
        else loadError = true;
    }

    // Keep the active line (or the interlude dots) at ~40 % of the visible
    // height, like Apple Music — scrolling only to the "nearest" edge crept
    // along one line at a time.
    async function scrollToActive(): Promise<void> {
        await tick();
        if (!lyricsContainer || Date.now() < manualScrollUntil) return;
        if (!activeTarget()) return;
        if (!scrollParent) {
            activeTarget()?.scrollIntoView({
                behavior: reducedMotion ? 'auto' : 'smooth',
                block: 'center',
            });
            return;
        }
        if (reducedMotion) {
            scrollParent.scrollTop += focusDelta(scrollParent) ?? 0;
            return;
        }
        startFollow();
    }

    function activeTarget(): HTMLElement | null {
        if (!lyricsContainer) return null;
        return (
            lyricsContainer.querySelector<HTMLElement>('[data-interlude]:not(.leaving)') ??
            (currentLineIndex >= 0
                ? lyricsContainer.querySelector<HTMLElement>(`[data-line="${currentLineIndex}"]`)
                : null)
        );
    }

    /** Pixels the scroller must move to put the active element on the focus line. */
    function focusDelta(parent: HTMLElement): number | null {
        const target = activeTarget();
        if (!target) return null;
        const parentRect = parent.getBoundingClientRect();
        const rect = target.getBoundingClientRect();
        return rect.top + rect.height / 2 - (parentRect.top + parent.clientHeight * 0.4);
    }

    // An eased follower instead of native smooth scrolling: every frame it
    // closes a share of the remaining distance and re-measures, so it glides
    // into place and keeps tracking while lines grow/shrink and the dots fold
    // away, instead of jumping to a target that the layout then moves.
    let followFrame = 0;
    let followStartedAt = 0;
    const FOLLOW_TAU_MS = 220;
    const FOLLOW_MAX_MS = 2_000;

    function startFollow(): void {
        followStartedAt = performance.now();
        if (followFrame) return;
        let last = followStartedAt;
        const step = (now: number) => {
            const parent = scrollParent;
            const delta = parent ? focusDelta(parent) : null;
            if (
                !parent ||
                delta === null ||
                now - followStartedAt > FOLLOW_MAX_MS ||
                Date.now() < manualScrollUntil
            ) {
                followFrame = 0;
                return;
            }
            const dt = Math.min(now - last, 64);
            last = now;
            if (Math.abs(delta) < 0.5) {
                followFrame = 0;
                return;
            }
            const before = parent.scrollTop;
            parent.scrollTop = before + delta * (1 - Math.exp(-dt / FOLLOW_TAU_MS));
            // Pinned at the top/bottom edge: nothing more to gain.
            if (Math.abs(parent.scrollTop - before) < 0.1 && dt > 0) {
                followFrame = 0;
                return;
            }
            followFrame = requestAnimationFrame(step);
        };
        followFrame = requestAnimationFrame(step);
    }

    function stopFollow(): void {
        if (followFrame) cancelAnimationFrame(followFrame);
        followFrame = 0;
    }

    /** Dots leave by shrinking, fading and folding their row away together. */
    function interludeOut(node: HTMLElement, { duration = 700 }: { duration?: number } = {}) {
        node.classList.add('leaving');
        const height = node.offsetHeight;
        return {
            duration: reducedMotion ? 0 : duration,
            easing: cubicInOut,
            css: (t: number) =>
                `opacity: ${t}; transform: scale(${0.5 + 0.5 * t}); height: ${t * height}px; overflow: hidden;`,
        };
    }

    function interludeIn(node: HTMLElement, { duration = 500 }: { duration?: number } = {}) {
        const height = node.offsetHeight;
        return {
            duration: reducedMotion ? 0 : duration,
            easing: cubicInOut,
            css: (t: number) =>
                `opacity: ${t}; transform: scale(${0.7 + 0.3 * t}); height: ${t * height}px; overflow: hidden;`,
        };
    }
</script>

<div
    class="flex flex-col items-center"
    bind:this={lyricsContainer}
    style="padding-bottom: max(1rem, env(safe-area-inset-bottom))">
    {#if isLoading}
        <!-- Loading state -->
        <div class="flex flex-col items-center gap-3 py-12">
            <div
                class="h-6 w-6 animate-spin rounded-full border-2 border-surface-600 border-t-primary-400">
            </div>
            <span class="text-sm text-surface-500">Loading lyrics…</span>
        </div>
    {:else if loadError}
        <div role="alert" class="py-8 text-center text-sm text-surface-400">
            <p>Unable to load lyrics.</p>
            <button class="min-h-11 underline" onclick={() => void show(shownTrackId)}
                >Retry</button>
        </div>
    {:else if lyrics.syncedLines.length > 0}
        <!-- Synced lyrics mode -->
        {#snippet interlude()}
            <div
                data-interlude
                class="interlude flex h-11 items-center justify-center gap-2"
                class:paused={!$musicPlayerStore.isPlaying}
                class:ending={interludeProgress > 0.9}
                aria-hidden="true"
                in:interludeIn
                out:interludeOut>
                {#each [0, 1, 2] as dot (dot)}
                    <span
                        class="h-2.5 w-2.5 rounded-full bg-white"
                        style="opacity: {0.25 +
                            0.75 * Math.min(1, Math.max(0, interludeProgress * 3 - dot))}">
                    </span>
                {/each}
            </div>
        {/snippet}
        {#if activeInterlude?.afterIndex === -1}
            {@render interlude()}
        {/if}
        {#each lyrics.syncedLines as line, i (line.startMs + '-' + i)}
            <p
                data-line={i}
                class="min-h-[44px] py-2 text-center leading-relaxed transition-all duration-300 {i ===
                    currentLineIndex && !activeInterlude
                    ? 'text-xl font-semibold text-white'
                    : Math.abs(i - currentLineIndex) > 3
                      ? 'text-lg text-surface-500 opacity-40'
                      : 'text-lg text-surface-500'}">
                {line.text}
            </p>
            {#if activeInterlude?.afterIndex === i}
                {@render interlude()}
            {/if}
        {/each}
        <!-- Room below the last line so it can still reach the focus point -->
        <div class="h-[30vh] shrink-0" aria-hidden="true"></div>
    {:else if lyrics.plain}
        <!-- Plain lyrics mode -->
        <div
            class="max-w-lg whitespace-pre-line text-center text-sm leading-relaxed text-surface-300">
            {lyrics.plain}
        </div>
    {:else}
        <!-- No lyrics available -->
        <div class="py-8 text-sm text-surface-500">No lyrics available</div>
    {/if}
</div>

<style>
    /* Gentle breathing while the band plays; dots fill left to right with
       progress (inline opacity) and shrink away just before the next line. */
    .interlude span {
        display: block;
        animation: interlude-breathe 2.4s ease-in-out infinite;
        transition:
            opacity 400ms linear,
            transform 900ms cubic-bezier(0.4, 0, 0.2, 1);
    }
    .interlude.paused span {
        animation-play-state: paused;
    }
    /* Last ~10 %: stop breathing and ease down so the hand-off to the next
       line starts before the row folds away. */
    .interlude.ending span {
        animation: none;
        transform: scale(0.75);
    }
    :global(.lyrics-no-scrollbar) {
        scrollbar-width: none;
    }
    :global(.lyrics-no-scrollbar::-webkit-scrollbar) {
        display: none;
    }
    @keyframes interlude-breathe {
        0%,
        100% {
            transform: scale(1);
        }
        50% {
            transform: scale(1.18);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .interlude span {
            animation: none;
        }
    }
</style>
