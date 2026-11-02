<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { calculateCrossfadeDuration, determineCrossfadeStyle } from '$lib/utils/beat-math';
    import { onMount, onDestroy } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import { apiGet } from '$lib/api/client';
    import { SearchResponseSchema } from '$lib/schemas/api-content-responses';
    import { debounce } from '$lib/utils/debounce';
    import { musicTrackFromCard } from '$lib/utils/music-track';
    import type { MusicTrack } from '$lib/schemas/music';

    // Module-level flag: settings are fetched once per session.
    // CrossfadeSettings can be mounted multiple times (e.g. the queue panel is
    // torn down and remounted each time the full-screen player opens), so guard
    // against redundant network requests on every mount (finding #9).
    let settingsLoadedOnce = false;

    const BEAT_PRESETS = [
        { label: 'Auto (Smart)', value: null },
        { label: '4 beats (1 bar)', value: 4 },
        { label: '8 beats (2 bars)', value: 8 },
        { label: '16 beats (4 bars)', value: 16 },
        { label: '24 beats (6 bars)', value: 24 },
        { label: '32 beats (8 bars)', value: 32 },
        { label: '48 beats (12 bars)', value: 48 },
        { label: '64 beats (16 bars)', value: 64 },
    ] as const;

    function formatDuration(beats: number, bpm: number): string {
        const ms = calculateCrossfadeDuration(bpm, beats);
        const seconds = ms / 1000;
        if (seconds >= 60) {
            const m = Math.floor(seconds / 60);
            const s = Math.round(seconds % 60);
            return `~${m}m ${s}s`;
        }
        return `~${seconds.toFixed(1)}s`;
    }

    onMount(() => {
        if (!settingsLoadedOnce) {
            settingsLoadedOnce = true;
            musicPlayerStore.loadMusicSettings();
        }
    });

    // ------------------------------------------------------------------
    // Fade test
    // ------------------------------------------------------------------

    interface FadeCandidate {
        id: string;
        title: string;
        artist: string;
    }

    let fadeQueryA = $state('');
    let fadeQueryB = $state('');
    let fadeResultsA = $state<FadeCandidate[]>([]);
    let fadeResultsB = $state<FadeCandidate[]>([]);
    let fadeSearchingA = $state(false);
    let fadeSearchingB = $state(false);
    let fadeTestA = $state<FadeCandidate | null>(null);
    let fadeTestB = $state<FadeCandidate | null>(null);
    let fadeTesting = $state(false);

    let abortControllerA: AbortController | null = null;
    let abortControllerB: AbortController | null = null;
    let fadeTestingTimeout: ReturnType<typeof setTimeout> | null = null;

    let showDropdownA = $derived(!fadeTestA && fadeQueryA.trim().length >= 2);
    let showDropdownB = $derived(!fadeTestB && fadeQueryB.trim().length >= 2);
    let canStartFadeTest = $derived(
        !!fadeTestA &&
            !!fadeTestB &&
            fadeTestA.id !== fadeTestB.id &&
            $musicPlayerStore.crossfadeEnabled,
    );

    async function searchTracks(query: string, slot: 'A' | 'B'): Promise<void> {
        if (slot === 'A') {
            abortControllerA?.abort();
            abortControllerA = new AbortController();
        } else {
            abortControllerB?.abort();
            abortControllerB = new AbortController();
        }
        const controller = slot === 'A' ? abortControllerA : abortControllerB;
        if (slot === 'A') {
            fadeSearchingA = true;
        } else {
            fadeSearchingB = true;
        }

        try {
            const params = new URLSearchParams({ q: query, types: 'track', limit: '6' });
            const { data } = await apiGet(
                `/api/search?${params.toString()}`,
                SearchResponseSchema,
                {
                    signal: controller?.signal,
                },
            );
            if (controller?.signal.aborted) return;

            const candidates: FadeCandidate[] = (data?.items ?? [])
                .filter((item) => item.type === 'track')
                .map((item) => ({
                    id: item.id,
                    title: item.title,
                    artist: item.overview?.split(' · ')[0]?.trim() || 'Unknown artist',
                }));

            if (slot === 'A') {
                fadeResultsA = candidates;
            } else {
                fadeResultsB = candidates;
            }
        } catch {
            if (controller?.signal.aborted) return;
            if (slot === 'A') {
                fadeResultsA = [];
            } else {
                fadeResultsB = [];
            }
        } finally {
            if (!controller?.signal.aborted) {
                if (slot === 'A') {
                    fadeSearchingA = false;
                } else {
                    fadeSearchingB = false;
                }
            }
        }
    }

    const debouncedSearchA = debounce((query: string) => void searchTracks(query, 'A'), 300);
    const debouncedSearchB = debounce((query: string) => void searchTracks(query, 'B'), 300);

    function handleFadeQueryInput(slot: 'A' | 'B'): void {
        if (slot === 'A') {
            if (fadeQueryA.trim().length >= 2) debouncedSearchA(fadeQueryA);
            else fadeResultsA = [];
        } else {
            if (fadeQueryB.trim().length >= 2) debouncedSearchB(fadeQueryB);
            else fadeResultsB = [];
        }
    }

    function selectFadeCandidate(slot: 'A' | 'B', candidate: FadeCandidate): void {
        if (slot === 'A') {
            fadeTestA = candidate;
            fadeQueryA = '';
            fadeResultsA = [];
        } else {
            fadeTestB = candidate;
            fadeQueryB = '';
            fadeResultsB = [];
        }
    }

    function clearFadeSlot(slot: 'A' | 'B'): void {
        if (slot === 'A') {
            fadeTestA = null;
            fadeQueryA = '';
            fadeResultsA = [];
        } else {
            fadeTestB = null;
            fadeQueryB = '';
            fadeResultsB = [];
        }
    }

    function useCurrentTrackAsA(): void {
        const current = $musicPlayerStore.currentTrack;
        if (!current) return;
        fadeTestA = { id: current.id, title: current.title, artist: current.artists.map((a) => a.title).join(', ') };
        fadeQueryA = '';
        fadeResultsA = [];
    }

    function toMusicTrack(candidate: FadeCandidate): MusicTrack {
        return musicTrackFromCard({ id: candidate.id, title: candidate.title, artists: [{ id: null, title: candidate.artist }] });
    }

    function startFadeTest(): void {
        if (!fadeTestA || !fadeTestB) return;
        if (fadeTestingTimeout) clearTimeout(fadeTestingTimeout);
        fadeTesting = true;
        fadeTestingTimeout = setTimeout(() => {
            fadeTesting = false;
        }, 5000);
        void musicPlayerStore.startFadeTest(toMusicTrack(fadeTestA), toMusicTrack(fadeTestB));
    }

    onDestroy(() => {
        abortControllerA?.abort();
        abortControllerB?.abort();
        if (fadeTestingTimeout) clearTimeout(fadeTestingTimeout);
    });
</script>

<div class="space-y-5">
    <h3 class="text-xs font-semibold uppercase text-surface-400">Crossfade</h3>

    <div class="flex items-center justify-between border-b border-surface-700/50 pb-4">
        <div>
            <p class="text-sm text-white">Show loudness in music details</p>
            <p class="text-xs text-surface-500">Display each track's integrated loudness in dB</p>
        </div>
        <button
            class="toggle-switch"
            class:active={$musicPlayerStore.showLoudnessDb}
            onclick={() => musicPlayerStore.setShowLoudnessDb(!$musicPlayerStore.showLoudnessDb)}
            aria-label="Show loudness in music details"
            aria-checked={$musicPlayerStore.showLoudnessDb}
            role="switch">
            <span class="toggle-knob"></span>
        </button>
    </div>

    <div class="flex items-center justify-between">
        <div>
            <p class="text-sm text-white">Show BPM</p>
            <p class="text-xs text-surface-500">Display BPM in music details and the queue</p>
        </div>
        <button
            class="toggle-switch"
            class:active={$musicPlayerStore.showBpm}
            onclick={() => musicPlayerStore.setShowBpm(!$musicPlayerStore.showBpm)}
            aria-label="Show BPM"
            aria-checked={$musicPlayerStore.showBpm}
            role="switch">
            <span class="toggle-knob"></span>
        </button>
    </div>

    <div class="flex items-center justify-between">
        <div>
            <p class="text-sm text-white">Loudness normalization</p>
            <p class="text-xs text-surface-500">Keep tracks at a more consistent listening level</p>
        </div>
        <button
            class="toggle-switch"
            class:active={$musicPlayerStore.loudnessNormalizationEnabled}
            onclick={() =>
                musicPlayerStore.setLoudnessNormalizationEnabled(
                    !$musicPlayerStore.loudnessNormalizationEnabled,
                )}
            aria-label="Enable loudness normalization"
            aria-checked={$musicPlayerStore.loudnessNormalizationEnabled}
            role="switch">
            <span class="toggle-knob"></span>
        </button>
    </div>

    <div class="flex items-center justify-between">
        <div>
            <p class="text-sm text-white">Always show beat pulse</p>
            <p class="text-xs text-surface-500">
                Pulse the playhead circle on beats during playback
            </p>
        </div>
        <button
            class="toggle-switch"
            class:active={$musicPlayerStore.alwaysShowBeatPulse}
            onclick={() =>
                musicPlayerStore.setAlwaysShowBeatPulse(!$musicPlayerStore.alwaysShowBeatPulse)}
            aria-label="Always show beat pulse"
            aria-checked={$musicPlayerStore.alwaysShowBeatPulse}
            role="switch">
            <span class="toggle-knob"></span>
        </button>
    </div>

    <!-- Enable/disable toggle -->
    <div class="flex items-center justify-between">
        <div>
            <p class="text-sm text-white">Crossfade between tracks</p>
            <p class="text-xs text-surface-500">Smoothly blend outgoing and incoming tracks</p>
            {#if $musicPlayerStore.isAirPlayActive && $musicPlayerStore.crossfadeEnabled}
                <p class="mt-1 text-xs italic text-amber-400/80">
                    AirPlay is active — crossfade paused for this output.
                </p>
            {/if}
        </div>
        <button
            class="toggle-switch"
            class:active={$musicPlayerStore.crossfadeEnabled}
            onclick={() =>
                musicPlayerStore.setCrossfadeEnabled(!$musicPlayerStore.crossfadeEnabled)}
            aria-label={m.music_toggle_crossfade_aria()}
            aria-checked={$musicPlayerStore.crossfadeEnabled}
            role="switch">
            <span class="toggle-knob"></span>
        </button>
    </div>

    <!-- Beat count selector -->
    {#if $musicPlayerStore.crossfadeEnabled}
        <div class="space-y-2">
            <p class="text-sm text-surface-300">Crossfade length</p>
            <div class="grid grid-cols-2 gap-1.5">
                {#each BEAT_PRESETS as preset (preset.label)}
                    {@const isSelected = $musicPlayerStore.crossfadeBeatsOverride === preset.value}
                    <button
                        class="rounded-md px-3 py-1.5 text-left text-xs transition-colors
                            {isSelected
                            ? 'bg-primary-500/20 text-primary-400 ring-1 ring-primary-500/40'
                            : 'bg-surface-800/50 text-surface-300 hover:bg-surface-700/50'}"
                        onclick={() => musicPlayerStore.setCrossfadeBeats(preset.value)}>
                        {preset.label}
                    </button>
                {/each}
            </div>

            <!-- Duration preview -->
            {#if $musicPlayerStore.crossfadeBeatsOverride}
                {@const bpm = $musicPlayerStore.currentTrack?.audioFeatures?.bpm ?? 120}
                <p class="text-xs text-surface-500">
                    At {Math.round(bpm)} BPM: {formatDuration(
                        $musicPlayerStore.crossfadeBeatsOverride,
                        bpm,
                    )}
                </p>
            {:else}
                {@const outgoing = $musicPlayerStore.currentTrack?.audioFeatures}
                {@const incoming = $musicPlayerStore.queue[0]?.track?.audioFeatures}
                {@const style = determineCrossfadeStyle(outgoing, incoming)}
                {@const bpm = $musicPlayerStore.currentTrack?.audioFeatures?.bpm ?? 120}
                <p class="text-xs text-surface-500">
                    Auto: {style.beats}-beat, {formatDuration(style.beats, bpm)} ({style.reason})
                </p>
            {/if}
        </div>
    {/if}

    <!-- Debug mode toggle -->
    <div class="flex items-center justify-between border-t border-surface-700/50 pt-4">
        <div>
            <p class="text-sm text-white">Debug overlay</p>
            <p class="text-xs text-surface-500">Show alignment & beat data during crossfade</p>
        </div>
        <button
            class="toggle-switch"
            class:active={$musicPlayerStore.crossfadeDebug}
            onclick={() => musicPlayerStore.toggleCrossfadeDebug()}
            aria-label={m.music_toggle_debug_mode_aria()}
            aria-checked={$musicPlayerStore.crossfadeDebug}
            role="switch">
            <span class="toggle-knob"></span>
        </button>
    </div>

    <!-- Fade test -->
    <div class="space-y-3 border-t border-surface-700/50 pt-4">
        <div>
            <p class="text-sm text-white">Fade test</p>
            <p class="text-xs text-surface-500">
                Plays the end of track A and crossfades into track B
            </p>
        </div>

        <!-- Slot A -->
        <div class="space-y-1">
            <div class="flex items-center justify-between">
                <p class="text-xs font-medium text-surface-400">A · Outgoing</p>
                {#if $musicPlayerStore.currentTrack}
                    <button
                        type="button"
                        class="text-xs text-primary-400 hover:text-primary-300"
                        onclick={useCurrentTrackAsA}>
                        Use current track
                    </button>
                {/if}
            </div>
            {#if fadeTestA}
                <div
                    class="flex items-center justify-between gap-2 rounded-md bg-surface-800/50 px-2.5 py-1.5">
                    <p class="truncate text-sm text-surface-200">
                        {fadeTestA.title} — {fadeTestA.artist}
                    </p>
                    <button
                        type="button"
                        class="shrink-0 text-surface-500 hover:text-surface-200"
                        onclick={() => clearFadeSlot('A')}
                        aria-label={m.music_fade_test_clear_aria()}>
                        ×
                    </button>
                </div>
            {:else}
                <div class="relative">
                    <input
                        type="text"
                        bind:value={fadeQueryA}
                        oninput={() => handleFadeQueryInput('A')}
                        placeholder="Search tracks…"
                        class="input w-full py-1.5 text-sm" />
                    {#if showDropdownA}
                        <div
                            class="absolute inset-x-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-md border border-surface-700 bg-surface-800 shadow-lg">
                            {#if fadeSearchingA}
                                <p class="px-2.5 py-1.5 text-xs text-surface-500">Searching…</p>
                            {:else if fadeResultsA.length === 0}
                                <p class="px-2.5 py-1.5 text-xs text-surface-500">
                                    No tracks found
                                </p>
                            {:else}
                                {#each fadeResultsA as candidate (candidate.id)}
                                    <button
                                        type="button"
                                        class="block w-full truncate px-2.5 py-1.5 text-left text-sm text-surface-200 hover:bg-surface-700/50"
                                        onclick={() => selectFadeCandidate('A', candidate)}>
                                        {candidate.title} — {candidate.artist}
                                    </button>
                                {/each}
                            {/if}
                        </div>
                    {/if}
                </div>
            {/if}
        </div>

        <!-- Slot B -->
        <div class="space-y-1">
            <p class="text-xs font-medium text-surface-400">B · Incoming</p>
            {#if fadeTestB}
                <div
                    class="flex items-center justify-between gap-2 rounded-md bg-surface-800/50 px-2.5 py-1.5">
                    <p class="truncate text-sm text-surface-200">
                        {fadeTestB.title} — {fadeTestB.artist}
                    </p>
                    <button
                        type="button"
                        class="shrink-0 text-surface-500 hover:text-surface-200"
                        onclick={() => clearFadeSlot('B')}
                        aria-label={m.music_fade_test_clear_aria()}>
                        ×
                    </button>
                </div>
            {:else}
                <div class="relative">
                    <input
                        type="text"
                        bind:value={fadeQueryB}
                        oninput={() => handleFadeQueryInput('B')}
                        placeholder="Search tracks…"
                        class="input w-full py-1.5 text-sm" />
                    {#if showDropdownB}
                        <div
                            class="absolute inset-x-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-md border border-surface-700 bg-surface-800 shadow-lg">
                            {#if fadeSearchingB}
                                <p class="px-2.5 py-1.5 text-xs text-surface-500">Searching…</p>
                            {:else if fadeResultsB.length === 0}
                                <p class="px-2.5 py-1.5 text-xs text-surface-500">
                                    No tracks found
                                </p>
                            {:else}
                                {#each fadeResultsB as candidate (candidate.id)}
                                    <button
                                        type="button"
                                        class="block w-full truncate px-2.5 py-1.5 text-left text-sm text-surface-200 hover:bg-surface-700/50"
                                        onclick={() => selectFadeCandidate('B', candidate)}>
                                        {candidate.title} — {candidate.artist}
                                    </button>
                                {/each}
                            {/if}
                        </div>
                    {/if}
                </div>
            {/if}
        </div>

        <div class="space-y-1.5 pt-1">
            <button
                type="button"
                class="btn variant-filled-primary btn-sm w-full disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!canStartFadeTest}
                onclick={startFadeTest}>
                Start fade test
            </button>
            {#if !$musicPlayerStore.crossfadeEnabled}
                <p class="text-xs text-surface-500">Enable crossfade first</p>
            {:else if !$musicPlayerStore.crossfadeDebug}
                <p class="text-xs text-surface-500">
                    Tip: turn on the debug overlay above to see the fade in detail
                </p>
            {/if}
            {#if fadeTesting}
                <p class="text-xs text-primary-400">Testing… listen for the fade</p>
            {/if}
        </div>
    </div>
</div>

<style>
    .toggle-switch {
        position: relative;
        width: 44px;
        height: 24px;
        background: rgba(255, 255, 255, 0.2);
        border: none;
        border-radius: 12px;
        cursor: pointer;
        transition: background 0.2s ease;
        flex-shrink: 0;
    }

    .toggle-switch.active {
        background: rgb(var(--color-primary-500-rgb) / 0.8);
    }

    .toggle-knob {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 20px;
        height: 20px;
        background: white;
        border-radius: 50%;
        transition: transform 0.2s ease;
    }

    .toggle-switch.active .toggle-knob {
        transform: translateX(20px);
    }

    .toggle-switch:focus-visible {
        outline: 2px solid rgb(var(--color-primary-500-rgb));
        outline-color: rgb(var(--color-primary-500-rgb));
        outline-offset: 2px;
    }
</style>
