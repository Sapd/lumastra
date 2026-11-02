// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CrossfadeEngine — manages equal-power crossfade between two Web Audio API decks.
 *
 * Uses cos/sin equal-power curves and requestAnimationFrame for smooth gain updates.
 */

import {
    calculateCrossfadeDuration,
    calculatePlaybackRate,
    computeBlendGains,
    resolveIncomingStartSec,
    BLEND_INCOMING_DELAY,
    BPM_NATIVE_RATE_MAX_GAP,
    BPM_WSOLA_MAX_GAP,
    ASSUMED_FADE_BPM,
} from './beat-math';
import type { TimeStretchNode } from './soundtouch-worklet';

export interface AudioDeck {
    audio: HTMLAudioElement;
    source: MediaElementAudioSourceNode;
    gain: GainNode;
    /** Lowshelf EQ at 200Hz — always in signal path, 0dB = transparent.
     *  Bass-swap mode ramps this to control bass volume per deck. */
    eqLow: BiquadFilterNode;
    /** Highshelf EQ at 3000Hz — always in signal path, 0dB = transparent.
     *  Bass-swap mode ramps this to control mid/high volume per deck. */
    eqHigh: BiquadFilterNode;
}

export interface CrossfadeProgress {
    /** 0-1 progress through the crossfade */
    ratio: number;
    /** Current beat number (1-based) */
    currentBeat: number;
    /** Total beats in this crossfade */
    totalBeats: number;
    /**
     * Equal-power outgoing reference gain (0-1): `cos(t·π/2)`. This is a
     * display/diagnostic reference curve, NOT the real applied gain — the actual
     * deck gain differs by mode (LUFS-scaled volume, filter/echo/bass-swap
     * shaping). Use only for UI visualization.
     */
    outGainReference: number;
    /**
     * Equal-power incoming reference gain (0-1): `sin(tIn·π/2)` with the blend
     * incoming delay applied. Display/diagnostic reference only — see
     * {@link outGainReference}.
     */
    inGainReference: number;
}

export interface CrossfadeOptions {
    /** Crossfade duration in beats (default: 8) */
    beats?: number;
    /** Volume level for the target deck (0-1) */
    volume?: number;
    /** Fade mode: blend (default), cut, filter, or echo */
    /** BPM that paces the fade; see CrossfadeOptions.paceBpm in $lib/audio/types. */
    paceBpm?: number;
    fadeMode?: 'blend' | 'cut' | 'filter' | 'echo' | 'bassswap';
    /** Beat grid of the outgoing track for alignment */
    outgoingBeatGrid?: number[];
    /** Downbeat timestamps of the outgoing track (seconds, sorted) */
    outgoingDownbeats?: number[];
    /** Current playback position of the outgoing track (seconds) */
    outgoingCurrentTimeSec?: number;
    /** Beat grid of the incoming track */
    incomingBeatGrid?: number[];
    /** Downbeat timestamps of the incoming track (seconds, sorted) */
    incomingDownbeats?: number[];
    /** Intro end point of incoming track in ms */
    incomingIntroEndMs?: number;
    /** LUFS-adjusted volume for the outgoing deck (0-1). Defaults to `volume` if omitted. */
    outgoingVolume?: number;
    /** BPM of outgoing track */
    outgoingBpm?: number;
    /** BPM of incoming track */
    incomingBpm?: number;
    /** Called on each animation frame during crossfade with beat progress */
    onProgress?: (progress: CrossfadeProgress) => void;
}

/** Min EQ shelf gain in dB — below this is inaudible (0.01 linear amplitude). */
const EQ_MIN_DB = -40;

// ── Tunable constants ──────────────────────────────────────────────────────
// BPM thresholds (BPM_NATIVE_RATE_MAX_GAP / BPM_WSOLA_MAX_GAP) are imported
// from beat-math so the gain math and rate-matching gates share one source.

/** CUT-mode click-prevention ramp length (seconds). Real DJ cuts are ~15ms. */
const CUT_RAMP_SEC = 0.015;
/** Delay after the CUT ramp before finalizing (ms). Must exceed CUT_RAMP_SEC. */
const CUT_FINALIZE_DELAY_MS = 20;

/** Default crossfade duration in beats — used when the caller passes an invalid value. */
const DEFAULT_BEATS = 8;
/** How often the completion fallback may wait for a lagging audio clock. */
const FALLBACK_MAX_REARMS = 10;
/** Hard floor on fade duration (ms) — guards against division-by-zero (t → NaN). */
const MIN_FADE_MS = 100;

/** Filter-fade lowpass sweep floor (Hz). */
const FILTER_MIN_FREQ_HZ = 80;
/** Filter-fade lowpass sweep ceiling (Hz) — perceptual cap, decoupled from hardware. */
const FILTER_MAX_FREQ_HZ = 20_000;
/** Filter mode incoming-fade delay (fraction of total fade). */
const FILTER_INCOMING_DELAY = 0.1;

/** Echo delay as a fraction of one beat (dotted-eighth feel). */
const ECHO_DELAY_BEAT_FRACTION = 0.75;
/** Maximum echo delay time (seconds). */
const ECHO_MAX_DELAY_SEC = 1.5;
/** Peak echo feedback level (≈4-6 audible repeats). */
const ECHO_FEEDBACK_PEAK = 0.45;
/** Peak echo wet level. */
const ECHO_WET_PEAK = 0.6;
/** Echo wet-curve time scale — shifts the wet peak earlier in the fade. */
const ECHO_WET_TIME_SCALE = 1.3;
/** Echo teardown ramp length (seconds) — avoids a click when cutting the tail. */
const ECHO_TEARDOWN_RAMP_SEC = 0.005;

/** Bass-swap phase 1 (lowshelf) completion point (fraction of fade). */
const BASSSWAP_BASS_END = 0.4;
/** Bass-swap outgoing master-gain fade start (fraction of fade). */
const BASSSWAP_OUT_FADE_START = 0.55;
/** Bass-swap phase 2 (highshelf) start point (fraction of fade). */
const BASSSWAP_MIDHI_START = 0.65;
/**
 * Incoming deck's highshelf corner during a bass-swap. With the stock 3 kHz
 * corner, a -40 dB shelf left 200 Hz–3 kHz nearly untouched (-4 dB at 1 kHz,
 * measured) — the incoming vocals and snare played over the outgoing track
 * from the first frame. At 250 Hz the shelf cuts everything above the bass
 * (1 kHz ≈ -39 dB), so phase 1 really brings in only the kick and bass.
 */
const BASSSWAP_INCOMING_SPLIT_HZ = 250;

/**
 * Per-frame ramp target horizon (seconds). Tick methods ramp toward the next
 * frame instead of snapping with setValueAtTime, smoothing the param updates.
 */
const FRAME_INTERVAL_SEC = 1 / 60;

/**
 * Context-suspension detection window (ms). If AudioContext time stalls while
 * wall time advances past this threshold, treat the context as suspended.
 */
const SUSPEND_THRESHOLD_MS = 200;

export class CrossfadeEngine {
    private audioContext: AudioContext;
    private crossfadeId = 0;
    private animationFrameId: number | null = null;
    private fallbackTimerId: ReturnType<typeof setTimeout> | null = null;
    private normalizeIntervalId: ReturnType<typeof setInterval> | null = null;
    private activeTimeStretch: TimeStretchNode | null = null;
    /** The deck that currently has a time-stretch node wired in */
    private stretchedDeck: AudioDeck | null = null;
    /** Temporary filter node for filter-fade mode */
    private activeFilter: BiquadFilterNode | null = null;
    /** The deck that has the filter inserted */
    private filterDeck: AudioDeck | null = null;
    /** Temporary echo nodes for echo-fade mode */
    private activeEcho: {
        delay: DelayNode;
        feedback: GainNode;
        wet: GainNode;
    } | null = null;
    /** The deck that has echo nodes connected */
    private echoDeck: AudioDeck | null = null;
    /** Active bass-swap state — stores deck references for EQ gain control */
    private activeBassSwap: {
        outDeck: AudioDeck;
        inDeck: AudioDeck;
        /** Outgoing deck's gain at crossfade start — used for phase 2 fade-out */
        outGainStart: number;
        /** Incoming highshelf corner before the swap, restored on cleanup. */
        inHighFreq: number;
    } | null = null;
    /** Resolve callback for the current startCrossfade Promise.
     *  Called by cancel() to prevent the Promise from hanging forever. */
    private pendingResolve: (() => void) | null = null;
    /**
     * While set, {@link rampParam} records values here instead of writing them —
     * used to sample a fade's remaining curve for {@link scheduleRemainingCurve}.
     * Each param maps to one slot per sample index.
     */
    private curveSink: { index: number; values: Map<AudioParam, (number | undefined)[]> } | null =
        null;
    /** Curves handed to the audio clock while the page is hidden (see scheduleRemainingCurve). */
    private scheduledCurves = new Map<
        AudioParam,
        { values: Float32Array; startSec: number; durationSec: number }
    >();
    /** visibilitychange listener of the fade in progress, removed on complete/cancel. */
    private visibilityListener: (() => void) | null = null;
    /** Pending CUT-mode finalize timer — tracked so cancel() can clear it and a
     *  stale completion cannot mutate a subsequent crossfade. */
    private cutTimerId: ReturnType<typeof setTimeout> | null = null;
    /**
     * Optional provider for the backend's current user volume (mute-adjusted)
     * to re-apply to the now-active deck when a fade completes. When unset,
     * {@link setFinalGains} falls back to the crossfade's target volume.
     *
     * Coordinated with WebAudioBackend (C3): the backend tracks the raw user
     * volume + mute state, so after a fade the active deck should play at that
     * level rather than the captured LUFS-adjusted crossfade volume.
     */
    private finalVolumeProvider: (() => number) | null = null;

    /**
     * Where the decks' output lands — the backend's output bus, so effect
     * paths (the echo tail) and the post-echo reconnect honour the same
     * mute as the decks. Defaults to the context destination.
     */
    private readonly output: AudioNode;

    constructor(audioContext: AudioContext, output?: AudioNode) {
        this.audioContext = audioContext;
        this.output = output ?? audioContext.destination;
    }

    /**
     * Register a provider for the active deck's final user volume. Called by the
     * backend so {@link setFinalGains} re-applies the live user volume/mute after
     * a fade instead of leaving the LUFS-adjusted crossfade volume in place.
     */
    setFinalVolumeProvider(provider: (() => number) | null): void {
        this.finalVolumeProvider = provider;
    }

    /**
     * Execute an equal-power crossfade from one deck to another.
     *
     * Equal-power curve: gainA = cos(t * π/2), gainB = sin(t * π/2)
     * where t goes from 0 to 1 over the fade duration.
     *
     * Returns a promise that resolves when the crossfade completes.
     */
    async startCrossfade(
        fromDeck: AudioDeck,
        toDeck: AudioDeck,
        options: CrossfadeOptions = {},
    ): Promise<void> {
        this.cancel();

        // Clear accumulated AudioParam automation events from previous crossfades.
        // Without this, hundreds of stale setValueAtTime events accumulate and
        // cause audio glitches/crackling on subsequent crossfades.
        // Use audioContext.currentTime (not 0) to avoid canceling the explicit
        // gain values set by WebAudioBackend.triggerCrossfade() just before this call.
        const now = this.audioContext.currentTime;
        fromDeck.gain.gain.cancelScheduledValues(now);
        toDeck.gain.gain.cancelScheduledValues(now);

        const {
            beats = DEFAULT_BEATS,
            volume = 0.8,
            fadeMode = 'blend',
            outgoingBpm,
            outgoingDownbeats,
            outgoingCurrentTimeSec,
            incomingBpm,
            incomingBeatGrid,
            incomingDownbeats,
            incomingIntroEndMs,
            outgoingVolume,
            onProgress,
        } = options;

        // Normalize beats once at entry so NaN/negative/non-finite values can't
        // leak into duration math or onProgress beat-count reports.
        const safeBeats = Number.isFinite(beats) && beats > 0 ? Math.floor(beats) : DEFAULT_BEATS;

        const fromVolume = outgoingVolume ?? volume;

        // Fade duration: beats at the pacing BPM, through the same helper the
        // planner and trigger use (unknown BPM → assumed 120) so the fade the
        // UI predicted is the fade that runs. Floor at MIN_FADE_MS to prevent
        // division-by-zero (t = elapsed / 0 → NaN gains).
        const bpm = options.paceBpm ?? outgoingBpm ?? incomingBpm ?? 0;
        const rawFadeMs = calculateCrossfadeDuration(bpm, safeBeats);
        const fadeDurationMs = Math.max(rawFadeMs, MIN_FADE_MS);

        // BPM rate-matching
        if (outgoingBpm && incomingBpm) {
            const rate = calculatePlaybackRate(incomingBpm, outgoingBpm);
            const gap = Math.abs(1 - rate);

            if (gap <= BPM_NATIVE_RATE_MAX_GAP) {
                // Gap ≤15%: native playbackRate. The pitch shift is noticeable
                // at the high end (~2.4 semitones) but masked by the crossfade
                // and corrected by normalizePlaybackRate afterward. WSOLA
                // artifacts are worse — the overlap-add buffers produce audible
                // glitches when connected to an already-playing audio element.
                // Filter mode (8-15% gap) specifically benefits from this.
                toDeck.audio.playbackRate = rate;
            } else if (gap <= BPM_WSOLA_MAX_GAP) {
                // Very large gap (15-25%): WSOLA for pitch-preserving stretch.
                // Automatic styles never reach this — a gap this large gets the
                // unsynced echo-out (no incoming BPM passed). Kept for callers
                // that pass both BPMs across such a gap.
                const thisId = ++this.crossfadeId;
                await this.enableTimeStretch(toDeck, rate);
                if (thisId !== this.crossfadeId) return;
            }
            // >25% gap: skip BPM matching entirely
        }

        // Position incoming track with beat phase alignment.
        // Priority: phase-align to outgoing downbeats → snap to incoming downbeat
        // → snap to beat grid → raw intro_end. Delegated to the shared
        // resolveIncomingStartSec helper (mirrored by SafariAudioBackend).
        // Guard: duration may be NaN if track metadata isn't loaded yet.
        const durationSec = isFinite(toDeck.audio.duration) ? toDeck.audio.duration : 0;
        const startSec = resolveIncomingStartSec(
            {
                incomingIntroEndMs,
                outgoingDownbeats,
                outgoingCurrentTimeSec,
                incomingDownbeats,
                incomingBeatGrid,
                incomingBpm,
            },
            durationSec,
        );
        // The helper returns 0 when there's no usable beat data and a non-positive
        // desired start — the original code left currentTime untouched in that
        // case, so only seek when the resolved start is positive.
        if (startSec > 0) {
            toDeck.audio.currentTime = startSec;
        }

        // Set up mode-specific audio nodes after positioning but before the animation
        if (fadeMode === 'filter') {
            this.setupFilterFade(fromDeck);
        } else if (fadeMode === 'echo') {
            const echoBpm = options.paceBpm ?? outgoingBpm ?? incomingBpm ?? ASSUMED_FADE_BPM;
            this.setupEchoFade(fromDeck, echoBpm);
        } else if (fadeMode === 'bassswap') {
            this.setupBassSwapFade(fromDeck, toDeck, volume);
        }

        // CUT mode: instant transition with ~15ms click-prevention ramp.
        // Real DJ cuts are ~15ms — imperceptible as a fade but eliminates
        // the click from discontinuous waveform splicing.
        if (fadeMode === 'cut') {
            const cutNow = this.audioContext.currentTime;
            const cutEnd = cutNow + CUT_RAMP_SEC;

            fromDeck.gain.gain.cancelScheduledValues(cutNow);
            fromDeck.gain.gain.setValueAtTime(fromVolume, cutNow);
            fromDeck.gain.gain.linearRampToValueAtTime(0, cutEnd);

            toDeck.gain.gain.cancelScheduledValues(cutNow);
            toDeck.gain.gain.setValueAtTime(0, cutNow);
            toDeck.gain.gain.linearRampToValueAtTime(volume, cutEnd);

            // Report progress as instant completion
            if (onProgress) {
                onProgress({
                    ratio: 1,
                    currentBeat: safeBeats,
                    totalBeats: safeBeats,
                    outGainReference: 0,
                    inGainReference: 1,
                });
            }

            // Wait for the ramp to finish, then finalize. Track the resolver and
            // the timer so cancel() can resolve/clear them; guard the body with a
            // resolved + crossfadeId check so a stale cut completion can't mutate
            // a subsequent crossfade or leave the Promise hanging.
            const cutId = this.crossfadeId;
            return new Promise<void>((resolve) => {
                this.pendingResolve = resolve;
                this.cutTimerId = setTimeout(() => {
                    this.cutTimerId = null;
                    // Stale guard: cancel() (or a new crossfade) bumped the id or
                    // already resolved this Promise — do nothing.
                    if (cutId !== this.crossfadeId || this.pendingResolve !== resolve) {
                        return;
                    }
                    this.pendingResolve = null;
                    this.setFinalGains(fromDeck, toDeck, volume);
                    this.cleanupFadeNodes();
                    this.disposeTimeStretch();
                    resolve();
                }, CUT_FINALIZE_DELAY_MS); // > ramp length, ensures completion
            });
        }

        return new Promise<void>((resolve) => {
            this.pendingResolve = resolve;
            const startContextTime = this.audioContext.currentTime;
            const startWallTime = performance.now();
            let lastContextTime = startContextTime;
            let resolved = false;

            // Mode-specific gain/parameter updates for fade progress t ∈ [0, 1].
            const applyAt = (t: number): void => {
                if (fadeMode === 'filter') {
                    this.tickFilterFade(t, fromDeck, toDeck, volume, fromVolume);
                } else if (fadeMode === 'echo') {
                    this.tickEchoFade(t, fromDeck, toDeck, volume, fromVolume);
                } else if (fadeMode === 'bassswap') {
                    this.tickBassSwapFade(t);
                } else {
                    // blend mode — standard equal-power curve
                    // (cut mode is handled above with 15ms instant ramp)
                    this.tickBlendFade(t, fromDeck, toDeck, volume, fromVolume);
                }
            };

            // requestAnimationFrame does not run in a hidden tab. Driven by rAF
            // alone, a fade that starts (or continues) while the page is in the
            // background never moves: the outgoing deck stays at full level, the
            // incoming one plays silently, and the fallback timer hard-swaps at
            // the end — the old track stops seconds early and the new one jumps
            // in mid-song. So while hidden, the rest of the fade is handed to the
            // audio clock; once visible again, per-frame updates take back over.
            const progressNow = (): number =>
                Math.min(
                    Math.max(
                        ((this.audioContext.currentTime - startContextTime) * 1000) /
                            fadeDurationMs,
                        0,
                    ),
                    1,
                );
            const onVisibilityChange = (): void => {
                if (resolved) return;
                if (document.hidden) {
                    this.scheduleRemainingCurve(progressNow(), fadeDurationMs, applyAt);
                } else {
                    this.clearScheduledCurves();
                }
            };
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', onVisibilityChange);
                this.visibilityListener = () =>
                    document.removeEventListener('visibilitychange', onVisibilityChange);
            }

            const complete = (): void => {
                if (resolved) return;
                resolved = true;
                this.pendingResolve = null;
                this.detachFadeScheduling();
                this.setFinalGains(fromDeck, toDeck, volume);
                this.cleanupFadeNodes();
                // Dispose the SoundTouch worklet — without this, the WSOLA processor
                // stays permanently wired into the now-active deck's graph, corrupting
                // all subsequent audio (beats + noise artifacts on Chrome).
                this.disposeTimeStretch();
                if (this.animationFrameId !== null) {
                    cancelAnimationFrame(this.animationFrameId);
                    this.animationFrameId = null;
                }
                if (this.fallbackTimerId !== null) {
                    clearTimeout(this.fallbackTimerId);
                    this.fallbackTimerId = null;
                }
                resolve();
            };

            // setTimeout fallback: if rAF is frozen (iOS background), ensure
            // crossfade completes and isCrossfading resets. Without this,
            // the Promise never resolves and the smart queue stalls permanently.
            //
            // With the page hidden the curve runs on the AUDIO clock, which can
            // lag the wall clock (a stalled output device, a slow context
            // start). Completing on wall time would then snap the gains to their
            // end values mid-curve — so while the context is running and still
            // behind, re-arm (bounded) instead. A suspended context completes as
            // before: its curve would never finish.
            let fallbackRearms = 0;
            const fallback = (): void => {
                const lagSec =
                    startContextTime + fadeDurationMs / 1000 - this.audioContext.currentTime;
                if (
                    lagSec > 0.05 &&
                    this.audioContext.state === 'running' &&
                    fallbackRearms++ < FALLBACK_MAX_REARMS
                ) {
                    this.fallbackTimerId = setTimeout(fallback, lagSec * 1000 + 50);
                    return;
                }
                complete();
            };
            this.fallbackTimerId = setTimeout(fallback, fadeDurationMs + SUSPEND_THRESHOLD_MS);

            const tick = (): void => {
                if (resolved) return;
                const contextTime = this.audioContext.currentTime;
                const wallNow = performance.now();

                // Context suspension detection: if AudioContext time hasn't advanced
                // but wall time has, the context is suspended (e.g. iOS background).
                // Schedule another rAF and return without advancing the crossfade.
                if (
                    contextTime === lastContextTime &&
                    wallNow - startWallTime > SUSPEND_THRESHOLD_MS
                ) {
                    this.animationFrameId = requestAnimationFrame(tick);
                    return;
                }
                lastContextTime = contextTime;

                const elapsed = (contextTime - startContextTime) * 1000;
                const t = Math.min(elapsed / fadeDurationMs, 1);

                // The audio clock owns the params while a scheduled curve runs.
                if (this.scheduledCurves.size === 0) applyAt(t);

                if (onProgress) {
                    const currentBeat = Math.min(Math.floor(t * safeBeats) + 1, safeBeats);
                    const tInReference = Math.max(
                        0,
                        (t - BLEND_INCOMING_DELAY) / (1 - BLEND_INCOMING_DELAY),
                    );
                    onProgress({
                        ratio: t,
                        currentBeat,
                        totalBeats: safeBeats,
                        outGainReference: Math.cos(t * Math.PI * 0.5),
                        inGainReference: Math.sin(tInReference * Math.PI * 0.5),
                    });
                }

                if (t < 1) {
                    this.animationFrameId = requestAnimationFrame(tick);
                } else {
                    complete();
                }
            };

            this.animationFrameId = requestAnimationFrame(tick);
            // Started while already hidden (the trigger runs off timeupdate,
            // which keeps firing in a background tab): schedule it all now.
            if (typeof document !== 'undefined' && document.hidden) {
                this.scheduleRemainingCurve(0, fadeDurationMs, applyAt);
            }
        });
    }

    /**
     * Sample the fade from progress `tFrom` to 1 through the mode's own tick
     * math (via {@link curveSink}) and schedule each touched AudioParam with
     * `setValueCurveAtTime`, so the fade completes on the audio clock without
     * any further JS. A param first written partway through (bass-swap's
     * outgoing gain starts at 55%) holds its current value until then.
     */
    private scheduleRemainingCurve(
        tFrom: number,
        fadeDurationMs: number,
        applyAt: (t: number) => void,
    ): void {
        const durationSec = ((1 - tFrom) * fadeDurationMs) / 1000;
        this.clearScheduledCurves();
        if (!(durationSec > 0.05)) return;

        const samples = Math.min(512, Math.max(2, Math.ceil(durationSec * 50)));
        const sink = { index: 0, values: new Map<AudioParam, (number | undefined)[]>() };
        this.curveSink = sink;
        try {
            for (let i = 0; i < samples; i++) {
                sink.index = i;
                applyAt(tFrom + ((1 - tFrom) * i) / (samples - 1));
            }
        } finally {
            this.curveSink = null;
        }

        const startSec = this.audioContext.currentTime;
        for (const [param, slots] of sink.values) {
            const values = new Float32Array(samples);
            let held = param.value;
            for (let i = 0; i < samples; i++) {
                const v = slots[i];
                if (v !== undefined && Number.isFinite(v)) held = v;
                values[i] = held;
            }
            try {
                param.cancelScheduledValues(startSec);
                param.setValueCurveAtTime(values, startSec, durationSec);
                this.scheduledCurves.set(param, { values, startSec, durationSec });
            } catch {
                // Unsupported or overlapping automation: leave the param to the
                // per-frame path (and the fallback completion).
            }
        }
    }

    /**
     * Drop any scheduled fade curves, pinning each param at the value the curve
     * has reached now so handing control back to per-frame updates (or to a
     * cancel/complete write) cannot jump back to the pre-curve level. Direct
     * `.value` writes throw while a value curve is active, so this must run
     * before them.
     */
    private clearScheduledCurves(): void {
        if (this.scheduledCurves.size === 0) return;
        const now = this.audioContext.currentTime;
        for (const [param, curve] of this.scheduledCurves) {
            const { values, startSec, durationSec } = curve;
            const pos = Math.min(Math.max((now - startSec) / durationSec, 0), 1);
            const x = pos * (values.length - 1);
            const i = Math.floor(x);
            const v =
                i >= values.length - 1
                    ? values[values.length - 1]
                    : values[i] + (values[i + 1] - values[i]) * (x - i);
            try {
                param.cancelScheduledValues(0);
                param.setValueAtTime(v, now);
            } catch {
                /* no-op */
            }
        }
        this.scheduledCurves.clear();
    }

    /** Stop hidden-page scheduling for the fade that just completed or was cancelled. */
    private detachFadeScheduling(): void {
        this.visibilityListener?.();
        this.visibilityListener = null;
        this.clearScheduledCurves();
    }

    /**
     * Schedule an AudioParam toward `value` smoothly. During the fade (not the
     * final frame) a short {@link FRAME_INTERVAL_SEC} linear ramp glides the
     * param toward the target, avoiding the audible stair-stepping that
     * per-frame `setValueAtTime` produces. On the final frame, snap exactly with
     * `setValueAtTime` so the crossfade lands on its precise end value.
     */
    private rampParam(param: AudioParam, value: number, isFinal: boolean): void {
        if (this.curveSink) {
            let slots = this.curveSink.values.get(param);
            if (!slots) {
                slots = [];
                this.curveSink.values.set(param, slots);
            }
            slots[this.curveSink.index] = value;
            return;
        }
        const now = this.audioContext.currentTime;
        if (isFinal) {
            param.cancelScheduledValues(now);
            param.setValueAtTime(value, now);
        } else {
            // Anchor the ramp at the param's current value, then glide to target.
            param.cancelScheduledValues(now);
            param.setValueAtTime(param.value, now);
            param.linearRampToValueAtTime(value, now + FRAME_INTERVAL_SEC);
        }
    }

    /** Perceptual filter sweep ceiling — capped so it never exceeds Nyquist. */
    private get filterMaxFreq(): number {
        return Math.min(this.audioContext.sampleRate / 2, FILTER_MAX_FREQ_HZ);
    }

    private setupFilterFade(deck: AudioDeck): void {
        const filter = this.audioContext.createBiquadFilter();
        filter.type = 'lowpass';
        // Start at the perceptual sweep ceiling (≤ Nyquist) — transparent enough
        // while decoupling the sweep range from the hardware sample rate so the
        // sonic character is identical at 44.1kHz and 48kHz.
        filter.frequency.value = this.filterMaxFreq;
        filter.Q.value = 5; // Mild resonance peak at cutoff — gives the
        // characteristic "DJ filter sweep" sound (Pioneer DJM uses ~8-12)

        // Insert: source → filter → eqLow (was: source → eqLow)
        // The signal chain is: source → [filter] → eqLow → eqHigh → gain → dest
        // Use disconnect() without args — Safari's selective disconnect is buggy.
        try {
            deck.source.disconnect();
        } catch {
            /* already disconnected */
        }
        deck.source.connect(filter);
        filter.connect(deck.eqLow);

        this.activeFilter = filter;
        this.filterDeck = deck;
    }

    private tickFilterFade(
        t: number,
        fromDeck: AudioDeck,
        toDeck: AudioDeck,
        volume: number,
        fromVolume: number,
    ): void {
        // Exponential frequency sweep: perceptual ceiling → 80 Hz.
        // The ceiling is capped at min(Nyquist, 20kHz) so the audible character
        // is consistent regardless of hardware sample rate.
        const minFreq = FILTER_MIN_FREQ_HZ;
        const maxFreq = this.filterMaxFreq;
        const freq = maxFreq * Math.pow(minFreq / maxFreq, t);
        const isFinal = t >= 1;

        if (this.activeFilter) {
            this.rampParam(this.activeFilter.frequency, freq, isFinal);
        }

        // Outgoing: stays louder longer than blend — the filter sweep naturally
        // reduces perceived loudness as highs are removed, so gain stays high
        // and lets the filter do the "separation" work. This is the standard
        // DJ filter-fade technique (Pioneer DJM, Traktor).
        const tSquared = t * t;
        const gainOut = Math.cos(tSquared * Math.PI * 0.5) * fromVolume;

        // Incoming: slightly delayed fade in — start ramping after FILTER_INCOMING_DELAY
        const tIn = Math.max(0, (t - FILTER_INCOMING_DELAY) / (1 - FILTER_INCOMING_DELAY));
        const gainIn = Math.sin(tIn * Math.PI * 0.5) * volume;

        this.rampParam(fromDeck.gain.gain, gainOut, isFinal);
        this.rampParam(toDeck.gain.gain, gainIn, isFinal);
    }

    private setupEchoFade(deck: AudioDeck, bpm: number): void {
        // Delay time: dotted eighth note (3/4 beat) for musical echo
        const beatDuration = 60 / Math.max(bpm, 60);
        const delayTime = beatDuration * ECHO_DELAY_BEAT_FRACTION;

        const delay = this.audioContext.createDelay(2.0);
        delay.delayTime.value = Math.min(delayTime, ECHO_MAX_DELAY_SEC);

        const feedback = this.audioContext.createGain();
        feedback.gain.value = 0; // start silent, ramp up during fade

        const wet = this.audioContext.createGain();
        wet.gain.value = 0; // start silent — no audible change when connected

        // Parallel echo path from outgoing gain output
        // source → gain → destination (existing dry path)
        //           gain → delay → wet → destination (echo path)
        //                  delay → feedback → delay (feedback loop)
        deck.gain.connect(delay);
        delay.connect(feedback);
        feedback.connect(delay);
        delay.connect(wet);
        wet.connect(this.output);

        this.activeEcho = { delay, feedback, wet };
        this.echoDeck = deck;
    }

    private tickEchoFade(
        t: number,
        fromDeck: AudioDeck,
        toDeck: AudioDeck,
        volume: number,
        fromVolume: number,
    ): void {
        // Standard equal-power crossfade on the dry gains.
        // The echo wet signal adds energy ON TOP — this is intentional.
        // The perceived loudness increase from the echo is the artistic
        // effect that defines the echo-out DJ technique (Pioneer DJM
        // "Dub Echo", Traktor "Delay" freeze).
        const gainOut = Math.cos(t * Math.PI * 0.5) * fromVolume;
        const gainIn = Math.sin(t * Math.PI * 0.5) * volume;
        const isFinal = t >= 1;

        this.rampParam(fromDeck.gain.gain, gainOut, isFinal);
        this.rampParam(toDeck.gain.gain, gainIn, isFinal);

        if (this.activeEcho) {
            // Feedback: rises to ECHO_FEEDBACK_PEAK at midpoint, then decreases
            // (~4-6 audible repeats before decay).
            const feedbackLevel = Math.sin(t * Math.PI) * ECHO_FEEDBACK_PEAK;
            this.rampParam(this.activeEcho.feedback.gain, feedbackLevel, isFinal);

            // Wet level: bell curve peaking earlier in the fade — prominent echo
            // trail without overwhelming.
            const wetLevel =
                Math.sin(Math.min(t * ECHO_WET_TIME_SCALE, 1) * Math.PI) *
                ECHO_WET_PEAK *
                fromVolume;
            this.rampParam(this.activeEcho.wet.gain, wetLevel, isFinal);
        }
    }

    private tickBlendFade(
        t: number,
        fromDeck: AudioDeck,
        toDeck: AudioDeck,
        volume: number,
        fromVolume: number,
    ): void {
        // Shared equal-power blend curve with BLEND_INCOMING_DELAY applied to the
        // incoming gain (mirrored by SafariAudioBackend). Gains are clamped ≤ 1.
        const { gainOut, gainIn } = computeBlendGains(t, fromVolume, volume);
        const isFinal = t >= 1;

        this.rampParam(fromDeck.gain.gain, gainOut, isFinal);
        this.rampParam(toDeck.gain.gain, gainIn, isFinal);
    }

    private setupBassSwapFade(outDeck: AudioDeck, inDeck: AudioDeck, incomingVolume: number): void {
        // Bass-swap uses shelving EQ filters always in the signal path.
        // Master gains stay CONSTANT — only the EQ shelf gains drive the
        // per-band crossfade. This avoids the volume drop that occurs when
        // an equal-power master gain crossfade fights the EQ transition.
        //
        // Incoming deck: kill ALL frequencies (both shelves at -40dB, the
        // highshelf corner lowered below — see BASSSWAP_INCOMING_SPLIT_HZ) and
        // set master gain to target volume. The EQ ramps bring in bass first
        // (phase 1), then mids/highs (phase 2).
        const now = this.audioContext.currentTime;
        inDeck.eqLow.gain.setValueAtTime(EQ_MIN_DB, now);
        inDeck.eqHigh.gain.setValueAtTime(EQ_MIN_DB, now);
        // Set incoming master gain immediately — the -40dB EQ shelves keep
        // it silent until the tick ramps them up.
        inDeck.gain.gain.cancelScheduledValues(0);
        inDeck.gain.gain.setValueAtTime(incomingVolume, now);

        // Outgoing deck: do NOT touch master gain — leave it at whatever
        // the deck is currently playing at. Capture the current value so
        // phase 2 can fade it smoothly to 0 (catches mid-range EQ leakage).
        const outGainStart = outDeck.gain.gain.value;

        // Shelving EQs only act beyond their corner: lower the incoming
        // highshelf's corner so the -40 dB shelf covers the mids too (see
        // BASSSWAP_INCOMING_SPLIT_HZ). Phase 2's highshelf ramp then brings
        // mids and highs in together; at 0 dB the corner is irrelevant.
        const inHighFreq = inDeck.eqHigh.frequency.value;
        inDeck.eqHigh.frequency.value = BASSSWAP_INCOMING_SPLIT_HZ;

        this.activeBassSwap = { outDeck, inDeck, outGainStart, inHighFreq };
    }

    private tickBassSwapFade(t: number): void {
        if (!this.activeBassSwap) return;
        const { outDeck, inDeck } = this.activeBassSwap;
        const isFinal = t >= 1;

        // Outgoing master gain: stays untouched during phase 1, then starts a
        // long fade to 0 from BASSSWAP_OUT_FADE_START onwards. This is longer
        // than the EQ highshelf phase to give a smooth, gradual tail for the
        // mid-range frequencies (~500-1500Hz) that shelving EQ doesn't fully
        // attenuate. Starting before the highshelf cut means the vocal begins
        // fading gently even before the highshelf starts cutting.
        const { outGainStart } = this.activeBassSwap;
        if (t > BASSSWAP_OUT_FADE_START) {
            const tFadeOut = (t - BASSSWAP_OUT_FADE_START) / (1 - BASSSWAP_OUT_FADE_START);
            const fadeGain = Math.cos(tFadeOut * Math.PI * 0.5) * outGainStart;
            this.rampParam(outDeck.gain.gain, fadeGain, isFinal);
        }

        // Phase 1 (0 → BASSSWAP_BASS_END): Bass swap via lowshelf EQ.
        // Completes early to give the vocal a "hold" period over the new beat.
        const tBass = Math.min(t / BASSSWAP_BASS_END, 1);
        const outBassDb = Math.max(
            EQ_MIN_DB,
            20 * Math.log10(Math.max(0.01, Math.cos(tBass * Math.PI * 0.5))),
        );
        const inBassDb = Math.max(
            EQ_MIN_DB,
            20 * Math.log10(Math.max(0.01, Math.sin(tBass * Math.PI * 0.5))),
        );

        this.rampParam(outDeck.eqLow.gain, outBassDb, isFinal);
        this.rampParam(inDeck.eqLow.gain, inBassDb, isFinal);

        // Hold: incoming kick + outgoing vocals at full volume. This is the
        // "mashup" moment — the new beat is locked in while the outgoing vocal
        // finishes its phrase.

        // Phase 2 (BASSSWAP_MIDHI_START → 100%): Mids/highs swap via highshelf EQ.
        // Starts late so outgoing vocals stay audible as long as possible.
        const tMidHi = Math.max(0, (t - BASSSWAP_MIDHI_START) / (1 - BASSSWAP_MIDHI_START));
        const outHighDb = Math.max(
            EQ_MIN_DB,
            20 * Math.log10(Math.max(0.01, Math.cos(tMidHi * Math.PI * 0.5))),
        );
        const inHighDb = Math.max(
            EQ_MIN_DB,
            20 * Math.log10(Math.max(0.01, Math.sin(tMidHi * Math.PI * 0.5))),
        );

        this.rampParam(outDeck.eqHigh.gain, outHighDb, isFinal);
        this.rampParam(inDeck.eqHigh.gain, inHighDb, isFinal);
    }

    private setFinalGains(fromDeck: AudioDeck, toDeck: AudioDeck, volume: number): void {
        // Re-apply the backend's live user volume (mute-adjusted) to the now-
        // active deck if a provider is registered (B6). Otherwise fall back to
        // the crossfade's target volume. Without this, the deck would be left at
        // the LUFS-adjusted crossfade volume, which drifts from the user's
        // setVolume() value (setVolume does not apply LUFS) and causes a
        // perceptible level jump at the next user volume change.
        const finalVolume = this.finalVolumeProvider ? this.finalVolumeProvider() : volume;

        fromDeck.gain.gain.cancelScheduledValues(0);
        toDeck.gain.gain.cancelScheduledValues(0);
        fromDeck.gain.gain.value = 0;
        toDeck.gain.gain.value = finalVolume;
    }

    private cleanupFadeNodes(): void {
        // Clean up filter
        if (this.activeFilter && this.filterDeck) {
            // Safari bug: selective disconnect (node.disconnect(specificNode)) may
            // disconnect ALL outputs instead of just the targeted one. Use disconnect()
            // (no args) + explicit reconnection to avoid orphaned audio graphs.
            try {
                this.filterDeck.source.disconnect();
            } catch {
                /* already disconnected */
            }
            try {
                this.activeFilter.disconnect();
            } catch {
                /* already disconnected */
            }
            // Restore source → eqLow (the normal signal chain)
            try {
                this.filterDeck.source.connect(this.filterDeck.eqLow);
            } catch {
                /* already connected */
            }
            this.activeFilter = null;
            this.filterDeck = null;
        }

        // Clean up echo
        if (this.activeEcho && this.echoDeck) {
            // Ramp echo gains to zero over a short window to avoid a click/pop
            // from the delay buffer being cut off mid-sample.
            // linearRampToValueAtTime produces a smooth transition.
            const rampEnd = this.audioContext.currentTime + ECHO_TEARDOWN_RAMP_SEC;
            try {
                this.activeEcho.feedback.gain.cancelScheduledValues(0);
                this.activeEcho.feedback.gain.linearRampToValueAtTime(0, rampEnd);
            } catch {
                /* no-op */
            }
            try {
                this.activeEcho.wet.gain.cancelScheduledValues(0);
                this.activeEcho.wet.gain.linearRampToValueAtTime(0, rampEnd);
            } catch {
                /* no-op */
            }
            // Disconnect ALL outputs from gain, then reconnect to destination.
            // Safari bug: gain.disconnect(delay) may sever gain→destination too,
            // permanently breaking audio on this deck.
            try {
                this.echoDeck.gain.disconnect();
            } catch {
                /* already disconnected */
            }
            try {
                this.activeEcho.delay.disconnect();
            } catch {
                /* already disconnected */
            }
            try {
                this.activeEcho.feedback.disconnect();
            } catch {
                /* already disconnected */
            }
            try {
                this.activeEcho.wet.disconnect();
            } catch {
                /* already disconnected */
            }
            // Restore gain → destination (critical: was severed by gain.disconnect())
            try {
                this.echoDeck.gain.connect(this.output);
            } catch {
                /* already connected */
            }
            this.activeEcho = null;
            this.echoDeck = null;
        }

        // Clean up bassswap — reset shelving EQ gains to 0dB (transparent)
        if (this.activeBassSwap) {
            const { outDeck, inDeck, inHighFreq } = this.activeBassSwap;
            inDeck.eqHigh.frequency.value = inHighFreq;
            outDeck.eqLow.gain.cancelScheduledValues(0);
            outDeck.eqLow.gain.value = 0;
            outDeck.eqHigh.gain.cancelScheduledValues(0);
            outDeck.eqHigh.gain.value = 0;
            inDeck.eqLow.gain.cancelScheduledValues(0);
            inDeck.eqLow.gain.value = 0;
            inDeck.eqHigh.gain.cancelScheduledValues(0);
            inDeck.eqHigh.gain.value = 0;
            this.activeBassSwap = null;
        }
    }

    /**
     * Gradually normalize playback rate back to 1.0 over ~4 beats.
     * Call after crossfade completes to remove pitch shift.
     */
    normalizePlaybackRate(deck: AudioDeck, _bpm: number = 120): void {
        if (deck.audio.playbackRate === 1) return;

        this.stopNormalization();

        // Normalize over ~400ms intervals, converging over ~2 seconds
        this.normalizeIntervalId = setInterval(() => {
            const rate = deck.audio.playbackRate;
            const diff = 1 - rate;
            if (Math.abs(diff) < 0.005) {
                deck.audio.playbackRate = 1;
                this.stopNormalization();
            } else {
                deck.audio.playbackRate += diff * 0.15;
            }
        }, 100);
    }

    /**
     * Enable SoundTouch time-stretching on a deck for large BPM gaps (>8%).
     * Inserts an AudioWorklet between source and gain.
     */
    private async enableTimeStretch(deck: AudioDeck, tempoRatio: number): Promise<void> {
        const idBefore = this.crossfadeId;
        try {
            const { createTimeStretchNode } = await import('./soundtouch-worklet');
            const stretchNode = await createTimeStretchNode(this.audioContext, tempoRatio);

            // Guard: if cancel() fired while we awaited, dispose the new node
            // instead of rewiring the deck — the crossfade is already aborted.
            if (idBefore !== this.crossfadeId) {
                stretchNode.dispose();
                return;
            }

            // Rewire: source → stretch → eqLow (instead of source → eqLow)
            // Use disconnect() without args — Safari's selective disconnect is buggy
            deck.source.disconnect();
            deck.source.connect(stretchNode.node);
            stretchNode.node.connect(deck.eqLow);

            this.activeTimeStretch = stretchNode;
            this.stretchedDeck = deck;
        } catch {
            // AudioWorklet not supported or failed to load — fall back to playbackRate
            deck.audio.playbackRate = tempoRatio;
            // Reconnect source to eqLow after the failed rewire attempt.
            try {
                if (this.audioContext.state !== 'closed') deck.source.connect(deck.eqLow);
            } catch {
                // source may already be connected if disconnect did not complete
            }
        }
    }

    /** Cancel any in-progress crossfade animation. */
    cancel(): void {
        // Resolve the outstanding startCrossfade Promise so callers don't hang.
        // Must be called BEFORE clearing timers so the resolved flag is checked.
        if (this.pendingResolve) {
            this.pendingResolve();
            this.pendingResolve = null;
        }
        ++this.crossfadeId; // invalidate any in-flight enableTimeStretch continuations
        this.detachFadeScheduling();

        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        if (this.fallbackTimerId !== null) {
            clearTimeout(this.fallbackTimerId);
            this.fallbackTimerId = null;
        }
        // Clear the pending CUT-mode finalize timer so a stale completion can't
        // mutate a subsequent crossfade. (The bumped crossfadeId + nulled
        // pendingResolve also guard the timer body if it somehow still fires.)
        if (this.cutTimerId !== null) {
            clearTimeout(this.cutTimerId);
            this.cutTimerId = null;
        }
        this.stopNormalization();
        if (this.activeEcho) {
            try {
                this.activeEcho.feedback.gain.cancelScheduledValues(0);
                this.activeEcho.feedback.gain.value = 0;
            } catch {
                /* no-op */
            }
            try {
                this.activeEcho.wet.gain.cancelScheduledValues(0);
                this.activeEcho.wet.gain.value = 0;
            } catch {
                /* no-op */
            }
        }
        // Bass-swap EQ shelves are reset to 0dB (transparent) by cleanupFadeNodes().
        this.cleanupFadeNodes();
        this.disposeTimeStretch();
    }

    private stopNormalization(): void {
        if (this.normalizeIntervalId !== null) {
            clearInterval(this.normalizeIntervalId);
            this.normalizeIntervalId = null;
        }
    }

    private disposeTimeStretch(): void {
        if (this.activeTimeStretch) {
            const deck = this.stretchedDeck;

            // Dispose the worklet node (disconnects it from the graph)
            this.activeTimeStretch.dispose();
            this.activeTimeStretch = null;

            // Restore direct routing: source → eqLow (the normal signal chain)
            // First disconnect() all to remove the dangling connection to the
            // disposed worklet, then reconnect source → eqLow.
            if (deck) {
                try {
                    deck.source.disconnect();
                } catch {
                    /* already disconnected */
                }
                try {
                    deck.source.connect(deck.eqLow);
                } catch {
                    /* already connected */
                }
            }
            this.stretchedDeck = null;
        }
    }

    /** Clean up all timers and worklet nodes. */
    destroy(): void {
        this.cancel();
        // Also stop normalization in case it was started after the last crossfade
        // completed but before destroy() was called.
        this.stopNormalization();
    }
}
