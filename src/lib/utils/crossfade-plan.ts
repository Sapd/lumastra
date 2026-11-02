// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared crossfade trigger-point math.
 *
 * `music-player.store.ts`'s `checkCrossfadeTrigger` decides WHEN a crossfade
 * actually fires. `MiniPlayer.svelte`'s amber fade-zone marker predicts WHERE
 * that will happen so it can be drawn on the seekbar ahead of time. Both used
 * to run their own copy of the style → beats → buffer → vocal-fit → outro
 * pipeline, and the two copies had drifted (raw vs. track-length-scaled
 * beats, outro applied unconditionally vs. only for non-cut modes, etc.) —
 * the marker lied about where the fade would start.
 *
 * This module is the single source of truth for that pipeline. The store
 * calls {@link computeCrossfadePlan} directly (it always needs a plan, even
 * when the incoming track has no analysis yet — same as before). The UI
 * marker calls {@link predictCrossfadeStartMs}, which additionally refuses to
 * guess when the incoming track's analysis hasn't loaded.
 */

import type { TrackAudioFeatures as AudioFeatures } from '$lib/schemas/api-music-dto';
import {
    calculateCrossfadeDuration,
    clampBassSwapBeats,
    determineCrossfadeStyle,
    scaleCrossfadeBeatsForTrackLength,
    type CrossfadeStyle,
} from './beat-math';

/**
 * A `lastVocalEndMs` sitting within this many ms of the track's end is
 * treated as an outlier (analysis noise / mislabeled boundary) rather than a
 * real vocal-phrase end — no fade can host it, and letting it stand pushes
 * the trigger point to (or past) the very end of the track. Applied
 * everywhere `lastVocalEndMs` feeds into the crossfade math.
 */
export const LAST_VOCAL_END_OUTLIER_WINDOW_MS = 2_000;

/**
 * Safety margin (ms) kept between a predicted/armed fade start plus its
 * duration and the track's end. Prevents the "end-slam" degenerate case
 * where a fade is scheduled to finish exactly at (or after) the last sample.
 */
export const CROSSFADE_END_HEADROOM_MS = 500;

/**
 * Guard against a `lastVocalEndMs` outlier within
 * {@link LAST_VOCAL_END_OUTLIER_WINDOW_MS} of the track's end — such a value
 * cannot host a real fade, so it is treated as unknown.
 *
 * A `dj-outro` boundary placed BEFORE the vocal end mirrors the DJ intro
 * because the vocal signal ran to the end (synth leads in the mix-out) — that
 * vocal end is not a sung line and must not push the boundary back. A vocal end
 * before the boundary (the normal dj-outro case) stays a real floor.
 */
export function guardLastVocalEndMs(
    features:
        Pick<AudioFeatures, 'lastVocalEndMs' | 'outroSource' | 'outroStartMs'> | undefined,
    durationMs: number,
): number | undefined {
    const lastVocalEndMs = features?.lastVocalEndMs;
    if (lastVocalEndMs === undefined) return undefined;
    if (
        features?.outroSource === 'dj-outro' &&
        features.outroStartMs !== undefined &&
        lastVocalEndMs > features.outroStartMs
    ) {
        return undefined;
    }
    if (durationMs > 0 && lastVocalEndMs >= durationMs - LAST_VOCAL_END_OUTLIER_WINDOW_MS) {
        return undefined;
    }
    return lastVocalEndMs;
}

export interface CrossfadePlanInput {
    /** Outgoing (current) track's analysis, if any. */
    outgoingAudioFeatures?: AudioFeatures;
    /** Incoming (queue head) track's analysis, if any. */
    incomingAudioFeatures?: AudioFeatures;
    /** Outgoing track's total duration in ms (backend-reported). */
    durationMs: number;
    /** Incoming track's declared duration in seconds (`MusicTrack.duration`)
     *  — used to scale the beat count for track length, same as the store. */
    incomingDurationSec?: number | null;
    /** Manual beat-count override from crossfade settings — forces blend
     *  mode and is used verbatim (never scaled/clamped). */
    crossfadeBeatsOverride?: number | null;
    /** Autoplay channel mood, when the queue is mood-seeded. */
    mood?: string;
    /** Current playback position (ms). Only used to clamp the bass-swap
     *  beat count to the audio actually remaining, mirroring the store's
     *  live per-tick clamp. Defaults to 0 (no clamp — matches the
     *  far-from-the-end case where `clampBassSwapBeats` is a no-op). */
    currentMs?: number;
}

export interface CrossfadePlan {
    /** Predicted/target ms position (within the outgoing track) where the
     *  fade starts — the outro boundary for non-cut modes when known,
     *  otherwise the dynamic (BPM-paced) target. This is what a UI marker
     *  should show. */
    startMs: number;
    /** Beat count the fade will actually run (scaled, clamped, vocal-fit). */
    beats: number;
    /** Duration of the fade itself, in ms. */
    fadeDurationMs: number;
    /** The fade mode that will actually run (post cut/bass-swap resolution). */
    mode: CrossfadeStyle['fadeMode'];
    /** The dynamic (BPM-paced) target, independent of the outro boundary —
     *  what the store's arm-window / downbeat-snap logic operates on. */
    dynamicTargetMs: number;
    /** Guarded (outlier-filtered) `lastVocalEndMs` of the outgoing track,
     *  or `undefined` when absent or filtered out. */
    lastVocalEndMs?: number;
    /** Guarded outro boundary: `max(outroStartMs, lastVocalEndMs)` when
     *  both are known, else `outroStartMs` alone, else `undefined`. */
    outroBoundaryMs?: number;
    /** True when the fade starts at the outro boundary — a gradual mode that
     *  is not end-aligned, with a known boundary. The store's outro trigger
     *  fires only when this is set. */
    usesOutro: boolean;
}

/**
 * Compute the crossfade plan (target start point, fade duration, resolved
 * mode) for an outgoing→incoming track pair. This reproduces the store's
 * REAL trigger plan exactly:
 *
 * `determineCrossfadeStyle` → `scaleCrossfadeBeatsForTrackLength` →
 * effective fade mode (manual override forces blend; bass-swap adapts to
 * remaining time or downgrades to blend) → per-mode buffer (5s default, 1s
 * bass-swap / end-aligned) → vocal-fit shrink → outro-vs-dynamic choice (outro is used
 * only for non-cut modes).
 *
 * Always returns a plan, even when `incomingAudioFeatures` is missing
 * (falls back to `determineCrossfadeStyle`'s "no audio data" default — the
 * same degraded-but-still-functional path the store has always had). UI
 * callers that don't want to render a guess in that case should use
 * {@link predictCrossfadeStartMs} instead.
 */
export function computeCrossfadePlan(input: CrossfadePlanInput): CrossfadePlan {
    const {
        outgoingAudioFeatures,
        incomingAudioFeatures,
        durationMs,
        incomingDurationSec,
        mood,
        currentMs = 0,
    } = input;
    const crossfadeBeatsOverride = input.crossfadeBeatsOverride ?? undefined;

    const style = determineCrossfadeStyle(outgoingAudioFeatures, incomingAudioFeatures, mood);
    const styleBeats = scaleCrossfadeBeatsForTrackLength(
        style.beats,
        style.fadeMode,
        durationMs / 1000,
        incomingDurationSec,
    );
    let beats = crossfadeBeatsOverride ?? styleBeats;
    let mode: CrossfadeStyle['fadeMode'] = crossfadeBeatsOverride ? 'blend' : style.fadeMode;

    const outBpm = outgoingAudioFeatures?.bpm;
    const inBpm = incomingAudioFeatures?.bpm;
    const bpm = outBpm ?? inBpm ?? 0;

    // Bass-swap: adapt beat count to available time (or downgrade to blend
    // when there isn't enough remaining audio for even a minimum swap).
    if (mode === 'bassswap' && !crossfadeBeatsOverride && bpm > 0) {
        const remainingMs = durationMs - currentMs;
        const clampedBeats = clampBassSwapBeats(beats, remainingMs, bpm);
        if (clampedBeats === 0) {
            mode = 'blend';
            beats = styleBeats;
        } else {
            beats = clampedBeats;
        }
    }

    let fadeDurationMs = calculateCrossfadeDuration(bpm, beats);

    // Vocal fit: shrink (floor 8 beats) so the fade doesn't have to run over
    // the outgoing track's last vocal phrase.
    const lastVocalEndMs = guardLastVocalEndMs(outgoingAudioFeatures, durationMs);
    if (lastVocalEndMs !== undefined && !crossfadeBeatsOverride && bpm > 0) {
        const fitMs = durationMs - lastVocalEndMs - 1_000;
        if (fitMs > 0 && fadeDurationMs > fitMs) {
            const fitBeats = Math.max(8, Math.floor(fitMs / (60_000 / bpm)));
            if (fitBeats < beats) {
                beats = fitBeats;
                fadeDurationMs = calculateCrossfadeDuration(bpm, beats);
            }
        }
    }

    // Bass-swap can start earlier because the first 55% of the fade doesn't
    // touch the vocal — only the kick swaps underneath. An end-aligned style
    // (the short BPM-gap echo) finishes just before the end so the outgoing
    // track plays out. Other modes need a 5s lead for a clean transition.
    const endAligned = style.endAligned === true && !crossfadeBeatsOverride;
    const bufferAfterFade = mode === 'bassswap' || endAligned ? 1_000 : 5_000;
    const dynamicTargetMs = durationMs - (fadeDurationMs + bufferAfterFade);

    // Outro boundary — never fade while the outgoing track is still singing:
    // raised to the (guarded) last vocal end when known.
    const rawOutroStart = outgoingAudioFeatures?.outroStartMs;
    const outroBoundaryMs =
        rawOutroStart !== undefined && lastVocalEndMs !== undefined
            ? Math.max(rawOutroStart, lastVocalEndMs)
            : rawOutroStart;

    // Cut and end-aligned transitions skip the outro boundary entirely —
    // outroStartMs marks where a gradual outro begins (8-16s from end), but
    // those are short and should fire closer to the actual end via the
    // dynamic lead.
    const usesOutro = mode !== 'cut' && !endAligned && outroBoundaryMs !== undefined;
    const maxStartMs = durationMs - fadeDurationMs - CROSSFADE_END_HEADROOM_MS;
    // Where the store's dynamic path fires: the lead point, never while the
    // outgoing track is still singing, never too late to finish. The outro
    // trigger runs independently, so with an outro the EARLIER of the two
    // wins — the marker used to show the outro even when the dynamic lead
    // fired seconds before it.
    const dynamicStartMs = Math.min(
        Math.max(dynamicTargetMs, lastVocalEndMs ?? -Infinity),
        maxStartMs,
    );
    const rawStartMs =
        usesOutro && dynamicTargetMs > 0
            ? Math.min(outroBoundaryMs, dynamicStartMs)
            : usesOutro
              ? Math.min(outroBoundaryMs, maxStartMs)
              : dynamicStartMs;
    const startMs = Math.max(0, rawStartMs);

    return {
        startMs,
        beats,
        fadeDurationMs,
        mode,
        dynamicTargetMs,
        lastVocalEndMs,
        outroBoundaryMs,
        usesOutro,
    };
}

/**
 * Predicted crossfade start point for UI display (the amber fade-zone
 * marker). A thin wrapper over {@link computeCrossfadePlan} that refuses to
 * guess when the incoming track's analysis hasn't loaded yet — the style
 * (and therefore beat count / fade mode) can swing wildly once it does, so a
 * marker built on `determineCrossfadeStyle`'s generic "no audio data"
 * fallback would be actively misleading. The marker should appear late
 * rather than lie.
 *
 * Also returns `null` when the resolved plan is a dynamic (non-outro)
 * target that doesn't fit before the track ends (mirrors the store's own
 * "not enough duration for a lead" gate).
 */
export function predictCrossfadeStartMs(input: CrossfadePlanInput): CrossfadePlan | null {
    if (!input.incomingAudioFeatures) return null;
    const plan = computeCrossfadePlan(input);
    if (!plan.usesOutro && plan.dynamicTargetMs <= 0) return null;
    return plan;
}
