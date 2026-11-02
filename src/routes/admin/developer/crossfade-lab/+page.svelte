<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { apiGet } from '$lib/api/client';
    import { SearchResponseSchema } from '$lib/schemas/api-content-responses';
    import { getTrack } from '$lib/api/music';
    import { debounce } from '$lib/utils/debounce';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { AdminPageHeader, StatCard } from '$lib/components/admin';
    import {
        Icon,
        ArrowsRightLeft,
        Clock,
        Fire,
        Key,
        SpeakerWave,
        Beaker,
        Play,
    } from 'svelte-hero-icons';
    import type { MusicTrack } from '$lib/schemas/music';
    import type { TrackAudioFeatures } from '$lib/schemas/api-music-dto';
    import {
        determineCrossfadeStyle,
        scaleCrossfadeBeatsForTrackLength,
        calculateCrossfadeDuration,
        computeBeatIntervalCv,
        isOrganicTrack,
        isBpmCompatible,
        areKeysCompatible,
        calculatePlaybackRate,
        getEffectiveIntroEndMs,
        resolveIncomingStartSec,
        ORGANIC_BEAT_CV_MIN,
        ORGANIC_DANCEABILITY_VETO,
        ORGANIC_SIDECAR_BEAT_CV_MIN,
        ORGANIC_SIDECAR_DANCEABILITY_MAX,
        BPM_NATIVE_RATE_MAX_GAP,
        BPM_WSOLA_MAX_GAP,
    } from '$lib/utils/beat-math';
    import { computeLufsGain, TARGET_LUFS } from '$lib/utils/lufs-gain';

    // ── Track pickers (A = outgoing, B = incoming) ───────────────────────
    // Mirrors the fade-test search pattern in CrossfadeSettings.svelte.

    interface Candidate {
        id: string;
        title: string;
        artist: string;
    }

    let queryA = $state('');
    let queryB = $state('');
    let resultsA = $state<Candidate[]>([]);
    let resultsB = $state<Candidate[]>([]);
    let searchingA = $state(false);
    let searchingB = $state(false);
    let pickedA = $state<Candidate | null>(null);
    let pickedB = $state<Candidate | null>(null);

    // Full track detail (audioFeatures + duration) fetched via getTrack().
    let trackA = $state<MusicTrack | null>(null);
    let trackB = $state<MusicTrack | null>(null);
    let loadingA = $state(false);
    let loadingB = $state(false);
    let errorA = $state<string | null>(null);
    let errorB = $state<string | null>(null);

    let abortControllerA: AbortController | null = null;
    let abortControllerB: AbortController | null = null;

    let showDropdownA = $derived(!pickedA && queryA.trim().length >= 2);
    let showDropdownB = $derived(!pickedB && queryB.trim().length >= 2);

    async function searchTracks(query: string, slot: 'A' | 'B'): Promise<void> {
        if (slot === 'A') {
            abortControllerA?.abort();
            abortControllerA = new AbortController();
        } else {
            abortControllerB?.abort();
            abortControllerB = new AbortController();
        }
        const controller = slot === 'A' ? abortControllerA : abortControllerB;
        if (slot === 'A') searchingA = true;
        else searchingB = true;

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

            const candidates: Candidate[] = (data?.items ?? [])
                .filter((item) => item.type === 'track')
                .map((item) => ({
                    id: item.id,
                    title: item.title,
                    artist: item.overview?.split(' · ')[0]?.trim() || 'Unknown artist',
                }));

            if (slot === 'A') resultsA = candidates;
            else resultsB = candidates;
        } catch {
            if (controller?.signal.aborted) return;
            if (slot === 'A') resultsA = [];
            else resultsB = [];
        } finally {
            if (!controller?.signal.aborted) {
                if (slot === 'A') searchingA = false;
                else searchingB = false;
            }
        }
    }

    const debouncedSearchA = debounce((query: string) => void searchTracks(query, 'A'), 300);
    const debouncedSearchB = debounce((query: string) => void searchTracks(query, 'B'), 300);

    function handleQueryInput(slot: 'A' | 'B'): void {
        if (slot === 'A') {
            if (queryA.trim().length >= 2) debouncedSearchA(queryA);
            else resultsA = [];
        } else {
            if (queryB.trim().length >= 2) debouncedSearchB(queryB);
            else resultsB = [];
        }
    }

    async function loadFullTrack(slot: 'A' | 'B', id: string): Promise<void> {
        if (slot === 'A') {
            loadingA = true;
            errorA = null;
        } else {
            loadingB = true;
            errorB = null;
        }
        try {
            const { data, error } = await getTrack(id);
            if (error || !data) {
                if (slot === 'A') errorA = error ?? 'Failed to load track details';
                else errorB = error ?? 'Failed to load track details';
                return;
            }
            if (slot === 'A') trackA = data.track;
            else trackB = data.track;
        } finally {
            if (slot === 'A') loadingA = false;
            else loadingB = false;
        }
    }

    function selectCandidate(slot: 'A' | 'B', candidate: Candidate): void {
        if (slot === 'A') {
            pickedA = candidate;
            queryA = '';
            resultsA = [];
        } else {
            pickedB = candidate;
            queryB = '';
            resultsB = [];
        }
        void loadFullTrack(slot, candidate.id);
    }

    function clearSlot(slot: 'A' | 'B'): void {
        if (slot === 'A') {
            pickedA = null;
            trackA = null;
            errorA = null;
            queryA = '';
            resultsA = [];
        } else {
            pickedB = null;
            trackB = null;
            errorB = null;
            queryB = '';
            resultsB = [];
        }
    }

    function useCurrentTrackAsA(): void {
        const current = $musicPlayerStore.currentTrack;
        if (!current) return;
        pickedA = {
            id: current.id,
            title: current.title,
            artist: current.artists.map((a) => a.title).join(', '),
        };
        queryA = '';
        resultsA = [];
        void loadFullTrack('A', current.id);
    }

    function swapSlots(): void {
        const pA = pickedA;
        const pB = pickedB;
        const tA = trackA;
        const tB = trackB;
        const eA = errorA;
        const eB = errorB;
        pickedA = pB;
        pickedB = pA;
        trackA = tB;
        trackB = tA;
        errorA = eB;
        errorB = eA;
    }

    function playTransition(): void {
        if (!trackA || !trackB) return;
        void musicPlayerStore.startFadeTest(trackA, trackB);
    }

    // ── Decision engine (same shared functions the live player uses) ────

    let outAf = $derived(trackA?.audioFeatures);
    let inAf = $derived(trackB?.audioFeatures);
    let outDurSec = $derived((trackA?.durationMs ?? 0) / 1000);
    let inDurSec = $derived((trackB?.durationMs ?? 0) / 1000);

    let style = $derived(determineCrossfadeStyle(outAf, inAf));
    let scaledBeats = $derived(
        scaleCrossfadeBeatsForTrackLength(style.beats, style.fadeMode, outDurSec, inDurSec),
    );
    let bpm = $derived(outAf?.bpm ?? inAf?.bpm ?? 0);
    let fadeDurationMs = $derived(calculateCrossfadeDuration(bpm, scaledBeats));

    // Vocal-fit shrink display — informational only, mirrors the runtime
    // trigger's tendency to shrink a fade so it never bites into the
    // outgoing track's vocals.
    let shrunkBeats = $derived.by((): number | null => {
        const lastVocal = outAf?.lastVocalEndMs;
        if (lastVocal === undefined || outDurSec <= 0 || bpm <= 0) return null;
        const durMs = outDurSec * 1000;
        const fitMs = durMs - lastVocal - 1000;
        if (fadeDurationMs <= fitMs) return null;
        return Math.max(8, Math.floor(fitMs / (60_000 / bpm)));
    });

    // Projected fade start on A — mirrors the player's checkCrossfadeTrigger /
    // startFadeTest boundary math.
    let projectedFadeStartMs = $derived.by((): number | null => {
        if (outDurSec <= 0) return null;
        const durMs = outDurSec * 1000;
        const rawOutro = outAf?.outroStartMs;
        const lastVocal = outAf?.lastVocalEndMs;
        const outroStart =
            lastVocal !== undefined && rawOutro !== undefined
                ? Math.max(rawOutro, lastVocal)
                : rawOutro;
        const buffer = style.fadeMode === 'bassswap' ? 1_000 : 5_000;
        const dynamicStart = durMs - (fadeDurationMs + buffer);
        return style.fadeMode !== 'cut' && outroStart !== undefined
            ? Math.min(outroStart, dynamicStart)
            : dynamicStart;
    });

    // Incoming track's beat-aligned seek offset. Plain transitions never
    // seek — natural-tempo Apple-style blend starts B at 0.
    let incomingStartSec = $derived.by((): number => {
        if (style.plainTransition) return 0;
        if (projectedFadeStartMs === null) return 0;
        return resolveIncomingStartSec(
            {
                incomingIntroEndMs: getEffectiveIntroEndMs(inAf),
                outgoingDownbeats: outAf?.downbeats,
                outgoingCurrentTimeSec: projectedFadeStartMs / 1000,
                incomingDownbeats: inAf?.downbeats,
                incomingBeatGrid: inAf?.beatGrid,
                incomingBpm: inAf?.bpm,
            },
            inDurSec,
        );
    });

    let lufsGainA = $derived(computeLufsGain(outAf?.loudnessLufs));
    let lufsGainB = $derived(computeLufsGain(inAf?.loudnessLufs));

    let bpmGapPct = $derived.by((): number | null => {
        if (!outAf?.bpm || !inAf?.bpm) return null;
        return Math.abs(1 - outAf.bpm / inAf.bpm) * 100;
    });
    let rateMatchTechnique = $derived.by((): string => {
        if (bpmGapPct === null) return 'n/a — missing BPM';
        const gap = bpmGapPct / 100;
        if (gap <= BPM_NATIVE_RATE_MAX_GAP) return 'native rate';
        if (gap <= BPM_WSOLA_MAX_GAP) return 'WSOLA (pitch-preserving)';
        return 'none — gap too large';
    });
    let bpmCompatible = $derived(
        outAf?.bpm && inAf?.bpm ? isBpmCompatible(outAf.bpm, inAf.bpm) : null,
    );
    let playbackRate = $derived(
        outAf?.bpm && inAf?.bpm ? calculatePlaybackRate(inAf.bpm, outAf.bpm) : null,
    );

    let keysCompatible = $derived.by((): boolean | null => {
        if (!outAf?.key || !inAf?.key) return null;
        return areKeysCompatible(outAf.key, inAf.key);
    });

    interface OrganicVerdict {
        organic: boolean;
        cv: number | null;
        tier: 'strict' | 'sidecar-loose' | 'none';
        danceability?: number;
    }

    function organicVerdict(af: TrackAudioFeatures | undefined): OrganicVerdict {
        if (!af) return { organic: false, cv: null, tier: 'none' };
        const cv = computeBeatIntervalCv(af.beatGrid);
        const organic = isOrganicTrack(af);
        let tier: OrganicVerdict['tier'] = 'none';
        if (cv !== null) {
            const strictOk =
                cv >= ORGANIC_BEAT_CV_MIN &&
                (af.danceability === undefined || af.danceability < ORGANIC_DANCEABILITY_VETO);
            if (strictOk) {
                tier = 'strict';
            } else {
                const sidecarEra =
                    af.firstVocalStartMs !== undefined || af.lastVocalEndMs !== undefined;
                if (
                    sidecarEra &&
                    cv >= ORGANIC_SIDECAR_BEAT_CV_MIN &&
                    af.danceability !== undefined &&
                    af.danceability < ORGANIC_SIDECAR_DANCEABILITY_MAX
                ) {
                    tier = 'sidecar-loose';
                }
            }
        }
        return { organic, cv, tier, danceability: af.danceability };
    }

    let organicA = $derived(organicVerdict(outAf));
    let organicB = $derived(organicVerdict(inAf));

    interface CompletenessField {
        label: string;
        present: boolean;
    }

    function completeness(af: TrackAudioFeatures | undefined): CompletenessField[] {
        return [
            { label: 'BPM', present: af?.bpm !== undefined },
            { label: 'Beat grid', present: (af?.beatGrid?.length ?? 0) > 0 },
            { label: 'Downbeats', present: (af?.downbeats?.length ?? 0) > 0 },
            { label: 'Energy curve', present: (af?.energyCurve?.length ?? 0) > 0 },
            {
                label: 'Vocal bounds',
                present:
                    af?.firstVocalStartMs !== undefined && af?.lastVocalEndMs !== undefined,
            },
            { label: 'Outro', present: af?.outroStartMs !== undefined },
            { label: 'LUFS', present: af?.loudnessLufs !== undefined },
        ];
    }

    let completenessA = $derived(completeness(outAf));
    let completenessB = $derived(completeness(inAf));
    let vocalDataMissingA = $derived(
        outAf?.firstVocalStartMs === undefined || outAf?.lastVocalEndMs === undefined,
    );
    let vocalDataMissingB = $derived(
        inAf?.firstVocalStartMs === undefined || inAf?.lastVocalEndMs === undefined,
    );

    // ── Per-track feature timeline (SVG) ─────────────────────────────────

    const VIEW_W = 1000;
    const ENERGY_TOP = 8;
    const ENERGY_BOTTOM = 78;
    const DOWNBEAT_MAX_TICKS = 300;

    function msToClock(ms: number): string {
        const totalSec = Math.max(0, Math.round(ms / 1000));
        const mins = Math.floor(totalSec / 60);
        const secs = totalSec % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    interface TimelineData {
        energyPolygon: string;
        energyPolyline: string;
        hasEnergy: boolean;
        introEndX: number;
        djIntroX: number | null;
        outroStartX: number | null;
        vocalStartX: number | null;
        vocalEndX: number | null;
        downbeatXs: number[];
        axisLabels: { x: number; text: string; anchor: 'start' | 'middle' | 'end' }[];
    }

    function buildTimeline(track: MusicTrack | null): TimelineData | null {
        if (!track?.durationMs || track.durationMs <= 0) return null;
        const durationMs = track.durationMs;
        const af = track.audioFeatures;
        const xFor = (ms: number): number =>
            Math.max(0, Math.min(VIEW_W, (ms / durationMs) * VIEW_W));

        const curve = af?.energyCurve ?? [];
        const hasEnergy = curve.length >= 2;
        let energyPolygon = '';
        let energyPolyline = '';
        if (hasEnergy) {
            const pts = curve.map((v, i) => {
                const clamped = Math.max(0, Math.min(1, v));
                const x = (i / (curve.length - 1)) * VIEW_W;
                const y = ENERGY_BOTTOM - clamped * (ENERGY_BOTTOM - ENERGY_TOP);
                return `${x.toFixed(1)},${y.toFixed(1)}`;
            });
            energyPolyline = pts.join(' ');
            energyPolygon = `0,${ENERGY_BOTTOM} ${pts.join(' ')} ${VIEW_W},${ENERGY_BOTTOM}`;
        }

        const djIntroX = af?.djIntroEndMs !== undefined ? xFor(af.djIntroEndMs) : null;
        const outroStartX = af?.outroStartMs !== undefined ? xFor(af.outroStartMs) : null;
        const vocalStartX =
            af?.firstVocalStartMs !== undefined ? xFor(af.firstVocalStartMs) : null;
        const vocalEndX = af?.lastVocalEndMs !== undefined ? xFor(af.lastVocalEndMs) : null;

        const rawDownbeats = af?.downbeats ?? [];
        const step =
            rawDownbeats.length > DOWNBEAT_MAX_TICKS
                ? Math.ceil(rawDownbeats.length / DOWNBEAT_MAX_TICKS)
                : 1;
        const downbeatXs = rawDownbeats.filter((_, i) => i % step === 0).map((t) => xFor(t * 1000));

        return {
            energyPolygon,
            energyPolyline,
            hasEnergy,
            introEndX: xFor(getEffectiveIntroEndMs(af)),
            djIntroX,
            outroStartX,
            vocalStartX,
            vocalEndX,
            downbeatXs,
            axisLabels: [
                { x: 4, text: '0:00', anchor: 'start' },
                { x: VIEW_W / 2, text: msToClock(durationMs / 2), anchor: 'middle' },
                { x: VIEW_W - 4, text: msToClock(durationMs), anchor: 'end' },
            ],
        };
    }

    let timelineA = $derived(buildTimeline(trackA));
    let timelineB = $derived(buildTimeline(trackB));

    // ── Transition view (A's tail + B's head on a shared axis) ──────────

    interface TransitionView {
        aEnergyPoints: string;
        bEnergyPoints: string;
        aVocalRect: { x: number; width: number } | null;
        bVocalRect: { x: number; width: number } | null;
        fadeRectX: number;
        fadeRectWidth: number;
        bStartMarkerX: number;
        fadeStartLabel: string;
        fadeLengthLabel: string;
        bSeekLabel: string;
    }

    let transitionView = $derived.by((): TransitionView | null => {
        if (
            !trackA ||
            !trackB ||
            outDurSec <= 0 ||
            inDurSec <= 0 ||
            projectedFadeStartMs === null
        ) {
            return null;
        }

        const fadeStartSec = projectedFadeStartMs / 1000;
        const fadeDurationSec = fadeDurationMs / 1000;
        const fadeEndSec = fadeStartSec + fadeDurationSec;

        // A's last ~90s, B's first ~60s (wall-clock, aligned to when B starts).
        const aWindowStart = Math.max(0, outDurSec - 90);
        const bWindowEndWall = fadeStartSec + 60;

        const domainStart = Math.min(aWindowStart, fadeStartSec);
        const domainEnd = Math.max(outDurSec, bWindowEndWall);
        const domainSpan = Math.max(1, domainEnd - domainStart);

        const xFor = (tSec: number): number =>
            Math.max(0, Math.min(VIEW_W, ((tSec - domainStart) / domainSpan) * VIEW_W));
        // B's internal time maps onto the wall clock starting at fadeStartSec,
        // offset by its own beat-aligned seek position.
        const xForB = (bSec: number): number => xFor(fadeStartSec + (bSec - incomingStartSec));

        const aCurve = outAf?.energyCurve ?? [];
        const aEnergyPoints =
            aCurve.length >= 2
                ? aCurve
                      .map((v, i) => {
                          const t = (i / (aCurve.length - 1)) * outDurSec;
                          const y = 70 - Math.max(0, Math.min(1, v)) * 55;
                          return `${xFor(t).toFixed(1)},${y.toFixed(1)}`;
                      })
                      .join(' ')
                : '';

        const bCurve = inAf?.energyCurve ?? [];
        const bEnergyPoints =
            bCurve.length >= 2
                ? bCurve
                      .map((v, i) => {
                          const t = (i / (bCurve.length - 1)) * inDurSec;
                          const y = 70 - Math.max(0, Math.min(1, v)) * 55;
                          return `${xForB(t).toFixed(1)},${y.toFixed(1)}`;
                      })
                      .join(' ')
                : '';

        const aVocalRect =
            outAf?.firstVocalStartMs !== undefined && outAf?.lastVocalEndMs !== undefined
                ? {
                      x: xFor(outAf.firstVocalStartMs / 1000),
                      width: Math.max(
                          0,
                          xFor(outAf.lastVocalEndMs / 1000) -
                              xFor(outAf.firstVocalStartMs / 1000),
                      ),
                  }
                : null;
        const bVocalRect =
            inAf?.firstVocalStartMs !== undefined && inAf?.lastVocalEndMs !== undefined
                ? {
                      x: xForB(inAf.firstVocalStartMs / 1000),
                      width: Math.max(
                          0,
                          xForB(inAf.lastVocalEndMs / 1000) -
                              xForB(inAf.firstVocalStartMs / 1000),
                      ),
                  }
                : null;

        const fadeRectX = xFor(fadeStartSec);
        const fadeRectWidth = Math.max(1, xFor(fadeEndSec) - fadeRectX);

        return {
            aEnergyPoints,
            bEnergyPoints,
            aVocalRect,
            bVocalRect,
            fadeRectX,
            fadeRectWidth,
            bStartMarkerX: xFor(fadeStartSec),
            fadeStartLabel: msToClock(projectedFadeStartMs),
            fadeLengthLabel: `${scaledBeats} beats (~${fadeDurationSec.toFixed(1)}s)`,
            bSeekLabel: style.plainTransition
                ? 'plain transition — no beat-aligned seek (starts at 0:00)'
                : `B seeks to ${incomingStartSec.toFixed(1)}s`,
        };
    });
</script>

<div class="space-y-6">
    <AdminPageHeader
        icon={ArrowsRightLeft}
        title="Crossfade Lab"
        description="Debug the DJ-style crossfade decision engine track by track. Unlinked admin debug page — direct URL only." />

    <!-- Track pickers -->
    <section class="grid gap-4 lg:grid-cols-2">
        <!-- Slot A -->
        <div class="rounded-xl border border-surface-700 bg-surface-900/40 p-4">
            <div class="mb-2 flex items-center justify-between">
                <p class="text-xs font-semibold uppercase tracking-wide text-surface-400">
                    A · Outgoing
                </p>
                {#if $musicPlayerStore.currentTrack}
                    <button
                        type="button"
                        class="text-xs text-primary-400 hover:text-primary-300"
                        onclick={useCurrentTrackAsA}>
                        Use current track
                    </button>
                {/if}
            </div>
            {#if pickedA}
                <div
                    class="flex items-center justify-between gap-2 rounded-md bg-surface-800/50 px-3 py-2">
                    <p class="truncate text-sm text-surface-200">
                        {pickedA.title} — {pickedA.artist}
                    </p>
                    <button
                        type="button"
                        class="shrink-0 text-surface-500 hover:text-surface-200"
                        onclick={() => clearSlot('A')}
                        aria-label="Clear track A">
                        ×
                    </button>
                </div>
                {#if loadingA}
                    <p class="mt-2 text-xs text-surface-500">Loading audio features…</p>
                {:else if errorA}
                    <p class="mt-2 text-xs text-red-400">{errorA}</p>
                {/if}
            {:else}
                <div class="relative">
                    <input
                        type="text"
                        bind:value={queryA}
                        oninput={() => handleQueryInput('A')}
                        placeholder="Search tracks…"
                        class="input w-full text-sm" />
                    {#if showDropdownA}
                        <div
                            class="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-surface-700 bg-surface-800 shadow-lg">
                            {#if searchingA}
                                <p class="px-3 py-2 text-xs text-surface-500">Searching…</p>
                            {:else if resultsA.length === 0}
                                <p class="px-3 py-2 text-xs text-surface-500">No tracks found</p>
                            {:else}
                                {#each resultsA as candidate (candidate.id)}
                                    <button
                                        type="button"
                                        class="block w-full truncate px-3 py-2 text-left text-sm text-surface-200 hover:bg-surface-700/50"
                                        onclick={() => selectCandidate('A', candidate)}>
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
        <div class="rounded-xl border border-surface-700 bg-surface-900/40 p-4">
            <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
                B · Incoming
            </p>
            {#if pickedB}
                <div
                    class="flex items-center justify-between gap-2 rounded-md bg-surface-800/50 px-3 py-2">
                    <p class="truncate text-sm text-surface-200">
                        {pickedB.title} — {pickedB.artist}
                    </p>
                    <button
                        type="button"
                        class="shrink-0 text-surface-500 hover:text-surface-200"
                        onclick={() => clearSlot('B')}
                        aria-label="Clear track B">
                        ×
                    </button>
                </div>
                {#if loadingB}
                    <p class="mt-2 text-xs text-surface-500">Loading audio features…</p>
                {:else if errorB}
                    <p class="mt-2 text-xs text-red-400">{errorB}</p>
                {/if}
            {:else}
                <div class="relative">
                    <input
                        type="text"
                        bind:value={queryB}
                        oninput={() => handleQueryInput('B')}
                        placeholder="Search tracks…"
                        class="input w-full text-sm" />
                    {#if showDropdownB}
                        <div
                            class="absolute inset-x-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-surface-700 bg-surface-800 shadow-lg">
                            {#if searchingB}
                                <p class="px-3 py-2 text-xs text-surface-500">Searching…</p>
                            {:else if resultsB.length === 0}
                                <p class="px-3 py-2 text-xs text-surface-500">No tracks found</p>
                            {:else}
                                {#each resultsB as candidate (candidate.id)}
                                    <button
                                        type="button"
                                        class="block w-full truncate px-3 py-2 text-left text-sm text-surface-200 hover:bg-surface-700/50"
                                        onclick={() => selectCandidate('B', candidate)}>
                                        {candidate.title} — {candidate.artist}
                                    </button>
                                {/each}
                            {/if}
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    </section>

    <div class="flex justify-center">
        <button
            type="button"
            class="btn btn-sm variant-soft flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!pickedA && !pickedB}
            onclick={swapSlots}>
            <Icon src={ArrowsRightLeft} class="h-4 w-4" />
            Swap A ↔ B
        </button>
    </div>

    {#if !trackA || !trackB}
        <p class="py-12 text-center text-sm text-surface-500">
            Pick both an outgoing (A) and incoming (B) track to see the crossfade decision.
        </p>
    {:else}
        <!-- Per-track feature timelines -->
        <section class="grid gap-4 lg:grid-cols-2">
            {#each [{ track: trackA, data: timelineA, label: 'A · Outgoing', grad: 'cfl-grad-a' }, { track: trackB, data: timelineB, label: 'B · Incoming', grad: 'cfl-grad-b' }] as t (t.grad)}
                <div class="rounded-xl border border-surface-700 bg-surface-900/40 p-3">
                    <div class="mb-2 flex items-center justify-between gap-2">
                        <p class="text-xs font-semibold uppercase tracking-wide text-surface-400">
                            {t.label}
                        </p>
                        <p class="truncate text-sm text-surface-200">
                            {t.track?.title} — {t.track?.artists.map((a) => a.title).join(', ')}
                        </p>
                    </div>
                    {#if !t.data}
                        <p class="py-8 text-center text-sm text-surface-500">
                            No duration data — cannot render timeline
                        </p>
                    {:else}
                        <svg
                            viewBox="0 0 1000 110"
                            class="h-[110px] w-full"
                            preserveAspectRatio="none">
                            <defs>
                                <linearGradient id={t.grad} x1="0" x2="1" y1="0" y2="0">
                                    <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.55" />
                                    <stop offset="50%" stop-color="#fbbf24" stop-opacity="0.55" />
                                    <stop offset="100%" stop-color="#ef4444" stop-opacity="0.55" />
                                </linearGradient>
                            </defs>

                            <!-- intro / outro zones -->
                            <rect
                                x="0"
                                y="0"
                                width={t.data.introEndX}
                                height="78"
                                class="fill-sky-500/10" />
                            {#if t.data.outroStartX !== null}
                                <rect
                                    x={t.data.outroStartX}
                                    y="0"
                                    width={1000 - t.data.outroStartX}
                                    height="78"
                                    class="fill-amber-500/10" />
                            {/if}

                            <!-- energy curve -->
                            {#if t.data.hasEnergy}
                                <polygon points={t.data.energyPolygon} fill="url(#{t.grad})" />
                                <polyline
                                    points={t.data.energyPolyline}
                                    fill="none"
                                    stroke="url(#{t.grad})"
                                    stroke-width="1.2"
                                    opacity="0.9" />
                            {:else}
                                <rect
                                    x="0"
                                    y="60"
                                    width="1000"
                                    height="6"
                                    rx="3"
                                    class="fill-surface-600/40" />
                            {/if}

                            <!-- vocal span -->
                            {#if t.data.vocalStartX !== null && t.data.vocalEndX !== null}
                                <rect
                                    x={t.data.vocalStartX}
                                    y="0"
                                    width={t.data.vocalEndX - t.data.vocalStartX}
                                    height="78"
                                    class="fill-rose-500/15" />
                            {/if}

                            <!-- downbeat ticks -->
                            {#each t.data.downbeatXs as x, i (i)}
                                <line
                                    x1={x}
                                    x2={x}
                                    y1="80"
                                    y2="86"
                                    stroke="#94a3b8"
                                    stroke-width="0.6"
                                    opacity="0.6" />
                            {/each}

                            <!-- DJ intro marker -->
                            {#if t.data.djIntroX !== null}
                                <line
                                    x1={t.data.djIntroX}
                                    x2={t.data.djIntroX}
                                    y1="0"
                                    y2="78"
                                    stroke="#38bdf8"
                                    stroke-width="1"
                                    stroke-dasharray="3,2" />
                            {/if}

                            <!-- voice starts (small tick) -->
                            {#if t.data.vocalStartX !== null}
                                <line
                                    x1={t.data.vocalStartX}
                                    x2={t.data.vocalStartX}
                                    y1="0"
                                    y2="78"
                                    stroke="#fb7185"
                                    stroke-width="0.8"
                                    opacity="0.5" />
                            {/if}

                            <!-- voice ends (prominent marker) -->
                            {#if t.data.vocalEndX !== null}
                                <line
                                    x1={t.data.vocalEndX}
                                    x2={t.data.vocalEndX}
                                    y1="0"
                                    y2="90"
                                    stroke="#fb7185"
                                    stroke-width="2" />
                            {/if}

                            <!-- time axis -->
                            {#each t.data.axisLabels as al (al.text + al.x)}
                                <text
                                    x={al.x}
                                    y="106"
                                    font-size="9"
                                    fill="#94a3b8"
                                    text-anchor={al.anchor}>{al.text}</text>
                            {/each}
                        </svg>

                        <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                            {#if t.track?.audioFeatures?.lastVocalEndMs !== undefined}
                                <span class="font-semibold text-rose-300">
                                    voice ends {msToClock(t.track.audioFeatures.lastVocalEndMs)}
                                </span>
                            {/if}
                            {#if t.track?.audioFeatures?.firstVocalStartMs !== undefined}
                                <span class="text-rose-400/70">
                                    voice starts {msToClock(
                                        t.track.audioFeatures.firstVocalStartMs,
                                    )}
                                </span>
                            {/if}
                            {#if t.track?.audioFeatures?.outroSource}
                                <span
                                    class="rounded px-1.5 py-0.5 {t.track.audioFeatures
                                        .outroSource === 'dj-outro'
                                        ? 'bg-amber-500/20 font-semibold text-amber-300'
                                        : 'text-amber-400/70'}">
                                    outro: {t.track.audioFeatures.outroSource}
                                </span>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/each}
        </section>

        <!-- Transition view -->
        <section class="rounded-xl border border-surface-700 bg-surface-900/40 p-3">
            <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
                Transition view
            </p>
            {#if !transitionView}
                <p class="py-8 text-center text-sm text-surface-500">
                    Both tracks need duration data to render the transition
                </p>
            {:else}
                <svg viewBox="0 0 1000 90" class="h-[130px] w-full" preserveAspectRatio="none">
                    <defs>
                        <linearGradient id="cfl-transition-out" x1="0" x2="1" y1="0" y2="0">
                            <stop offset="0%" stop-color="#60a5fa" stop-opacity="0.35" />
                            <stop offset="100%" stop-color="#60a5fa" stop-opacity="0" />
                        </linearGradient>
                        <linearGradient id="cfl-transition-in" x1="0" x2="1" y1="0" y2="0">
                            <stop offset="0%" stop-color="#34d399" stop-opacity="0" />
                            <stop offset="100%" stop-color="#34d399" stop-opacity="0.35" />
                        </linearGradient>
                    </defs>

                    <rect
                        x={transitionView.fadeRectX}
                        y="0"
                        width={transitionView.fadeRectWidth}
                        height="78"
                        class="fill-primary-500/10" />

                    {#if transitionView.aVocalRect}
                        <rect
                            x={transitionView.aVocalRect.x}
                            y="0"
                            width={transitionView.aVocalRect.width}
                            height="78"
                            class="fill-rose-500/15" />
                    {/if}
                    {#if transitionView.bVocalRect}
                        <rect
                            x={transitionView.bVocalRect.x}
                            y="0"
                            width={transitionView.bVocalRect.width}
                            height="78"
                            class="fill-rose-400/10" />
                    {/if}

                    {#if transitionView.aEnergyPoints}
                        <polyline
                            points={transitionView.aEnergyPoints}
                            fill="none"
                            stroke="#60a5fa"
                            stroke-width="1.4"
                            opacity="0.85" />
                    {/if}
                    {#if transitionView.bEnergyPoints}
                        <polyline
                            points={transitionView.bEnergyPoints}
                            fill="none"
                            stroke="#34d399"
                            stroke-width="1.4"
                            opacity="0.85" />
                    {/if}

                    <!-- cross-gradient: A ramps down, B ramps up over the fade window -->
                    <rect
                        x={transitionView.fadeRectX}
                        y="0"
                        width={transitionView.fadeRectWidth}
                        height="78"
                        fill="url(#cfl-transition-out)" />
                    <rect
                        x={transitionView.fadeRectX}
                        y="0"
                        width={transitionView.fadeRectWidth}
                        height="78"
                        fill="url(#cfl-transition-in)" />

                    <!-- B's playback start marker -->
                    <line
                        x1={transitionView.bStartMarkerX}
                        x2={transitionView.bStartMarkerX}
                        y1="0"
                        y2="86"
                        stroke="#facc15"
                        stroke-width="1.5"
                        stroke-dasharray="2,2" />
                </svg>
                <div
                    class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-surface-300">
                    <span
                        >Fade starts on A at <strong class="text-white"
                            >{transitionView.fadeStartLabel}</strong
                        ></span>
                    <span
                        >Length: <strong class="text-white">{transitionView.fadeLengthLabel}</strong
                        ></span>
                    <span class="text-yellow-300">{transitionView.bSeekLabel}</span>
                </div>
            {/if}
        </section>

        <!-- Decision cards -->
        <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard
                icon={ArrowsRightLeft}
                title="Fade mode"
                value={style.fadeMode}
                subtitle={style.reason}>
                {#snippet details()}
                    {#if style.plainTransition}
                        <p
                            class="mt-2 rounded bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-300">
                            Plain transition — organic material, no DJ effects
                        </p>
                    {/if}
                {/snippet}
            </StatCard>

            <StatCard
                icon={Clock}
                title="Crossfade length"
                value={`${scaledBeats} beats`}
                subtitle={`${(fadeDurationMs / 1000).toFixed(1)}s @ ${bpm.toFixed(0)} BPM`}>
                {#snippet details()}
                    <p class="text-caption mt-1">
                        style {style.beats} → length-scaled {scaledBeats}{#if shrunkBeats !== null}
                            → vocal-fit shrunk {shrunkBeats}{/if}
                    </p>
                {/snippet}
            </StatCard>

            <StatCard
                icon={Fire}
                title="BPM gap"
                value={bpmGapPct !== null ? `${bpmGapPct.toFixed(1)}%` : 'n/a'}
                healthy={bpmGapPct !== null ? bpmGapPct <= 15 : null}>
                {#snippet details()}
                    <p class="text-caption mt-1">
                        A {outAf?.bpm?.toFixed(1) ?? '—'} · B {inAf?.bpm?.toFixed(1) ?? '—'}
                    </p>
                    <p class="text-caption">
                        Technique: <span class="font-medium text-white">{rateMatchTechnique}</span>
                    </p>
                    {#if bpmCompatible !== null}
                        <p class="text-caption">Compatible (±8%): {bpmCompatible ? 'Yes' : 'No'}</p>
                    {/if}
                    {#if playbackRate !== null}
                        <p class="text-caption">
                            Playback rate to match: ×{playbackRate.toFixed(3)}
                        </p>
                    {/if}
                {/snippet}
            </StatCard>

            <StatCard
                icon={Key}
                title="Key compatibility"
                value={keysCompatible === null ? 'n/a' : keysCompatible ? 'Compatible' : 'Clash'}
                healthy={keysCompatible}>
                {#snippet details()}
                    <p class="text-caption mt-1">A {outAf?.key ?? '—'} · B {inAf?.key ?? '—'}</p>
                {/snippet}
            </StatCard>

            <StatCard icon={SpeakerWave} title="Loudness (LUFS)" value={`target ${TARGET_LUFS}`}>
                {#snippet details()}
                    <p class="text-caption mt-1">
                        A {outAf?.loudnessLufs?.toFixed(1) ?? '—'} LUFS → ×{lufsGainA.toFixed(2)} gain
                    </p>
                    <p class="text-caption">
                        B {inAf?.loudnessLufs?.toFixed(1) ?? '—'} LUFS → ×{lufsGainB.toFixed(2)} gain
                    </p>
                {/snippet}
            </StatCard>

            <StatCard
                icon={Beaker}
                title="Track A profile"
                value={organicA.organic ? 'Organic' : 'DJ-style'}
                healthy={organicA.organic ? true : null}>
                {#snippet details()}
                    <p class="text-caption mt-1">
                        CV {organicA.cv !== null ? organicA.cv.toFixed(3) : '—'} · danceability {organicA.danceability?.toFixed(
                            2,
                        ) ?? '—'} · tier {organicA.tier}
                    </p>
                    <p class="text-caption">
                        Vocal: {outAf?.vocalInstrumental ??
                            '—'}{#if outAf?.vocalConfidence !== undefined}
                            ({Math.round(outAf.vocalConfidence * 100)}%){/if}
                    </p>
                    <p class="text-caption">Outro source: {outAf?.outroSource ?? '—'}</p>
                {/snippet}
            </StatCard>

            <StatCard
                icon={Beaker}
                title="Track B profile"
                value={organicB.organic ? 'Organic' : 'DJ-style'}
                healthy={organicB.organic ? true : null}>
                {#snippet details()}
                    <p class="text-caption mt-1">
                        CV {organicB.cv !== null ? organicB.cv.toFixed(3) : '—'} · danceability {organicB.danceability?.toFixed(
                            2,
                        ) ?? '—'} · tier {organicB.tier}
                    </p>
                    <p class="text-caption">
                        Vocal: {inAf?.vocalInstrumental ??
                            '—'}{#if inAf?.vocalConfidence !== undefined}
                            ({Math.round(inAf.vocalConfidence * 100)}%){/if}
                    </p>
                    <p class="text-caption">Outro source: {inAf?.outroSource ?? '—'}</p>
                {/snippet}
            </StatCard>
        </section>

        <!-- Data completeness strip -->
        <section class="space-y-2">
            <h3 class="text-xs font-semibold uppercase tracking-wide text-surface-400">
                Data completeness
            </h3>
            <div class="grid gap-3 sm:grid-cols-2">
                {#each [{ label: 'A · Outgoing', fields: completenessA, vocalMissing: vocalDataMissingA }, { label: 'B · Incoming', fields: completenessB, vocalMissing: vocalDataMissingB }] as row (row.label)}
                    <div class="rounded-lg border border-surface-700 bg-surface-900/40 p-3">
                        <p class="mb-2 text-xs font-medium text-surface-300">{row.label}</p>
                        <div class="flex flex-wrap gap-1.5">
                            {#each row.fields as f (f.label)}
                                <span
                                    class="rounded-full px-2 py-0.5 text-[10px] font-medium {f.present
                                        ? 'bg-emerald-500/15 text-emerald-300'
                                        : 'bg-surface-600/30 text-surface-400'}">
                                    {f.label}
                                </span>
                            {/each}
                        </div>
                        {#if row.vocalMissing}
                            <p class="mt-2 text-[11px] italic text-surface-500">
                                Needs sidecar analysis (PROCESSING_VERSION 7) for vocal bounds
                            </p>
                        {/if}
                    </div>
                {/each}
            </div>
        </section>

        <!-- Play this transition -->
        <div class="flex flex-col items-center gap-2 pb-4">
            <button
                type="button"
                class="btn variant-filled-primary flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={trackA.id === trackB.id}
                onclick={playTransition}>
                <Icon src={Play} class="h-4 w-4" />
                Play this transition
            </button>
            <p class="text-xs text-surface-500">
                Tip: enable the player's debug overlay (Music player → Crossfade settings → Debug
                overlay) to see live alignment data during playback.
            </p>
        </div>
    {/if}
</div>
