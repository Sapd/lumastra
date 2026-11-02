// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { calculateCrossfadeDuration, scaleCrossfadeBeatsForTrackLength } from './beat-math';
import {
    computeCrossfadePlan,
    predictCrossfadeStartMs,
    CROSSFADE_END_HEADROOM_MS,
    type CrossfadePlanInput,
} from './crossfade-plan';
import type { TrackAudioFeatures as AudioFeatures } from '$lib/schemas/api-music-dto';

describe('predictCrossfadeStartMs', () => {
    it('large-BPM-gap pair: short echo-out ends ~1s before the track end, ignoring the outro', () => {
        // 100 vs 130 BPM → 23% gap → short unsynced echo-out (8 beats). Starting
        // it at outroStartMs (40s from the end) would finish in ~5s and skip
        // the rest of the outro — the same "stopped early" symptom as the old
        // cut — so it is end-aligned instead.
        const outgoing: AudioFeatures = { bpm: 100, energy: 0.5, outroStartMs: 260_000 };
        const incoming: AudioFeatures = { bpm: 130, energy: 0.5 };
        const durationMs = 300_000;

        const plan = predictCrossfadeStartMs({
            outgoingAudioFeatures: outgoing,
            incomingAudioFeatures: incoming,
            durationMs,
        });

        expect(plan).not.toBeNull();
        expect(plan!.mode).toBe('echo');
        expect(plan!.usesOutro).toBe(false);
        const fadeMs = calculateCrossfadeDuration(100, 8);
        expect(plan!.fadeDurationMs).toBe(fadeMs);
        expect(plan!.startMs).toBe(durationMs - (fadeMs + 1_000));
    });

    it('an outro later than the dynamic lead: the plan starts at the lead, like the trigger', () => {
        // The store's outro trigger and its dynamic lead run independently, so
        // the earlier one fires. The marker used to show the outro regardless.
        const plan = computeCrossfadePlan({
            outgoingAudioFeatures: { bpm: 120, energy: 0.3, outroStartMs: 297_000 },
            incomingAudioFeatures: { bpm: 120, energy: 0.3 },
            durationMs: 300_000,
            crossfadeBeatsOverride: 16, // 8s blend → dynamic lead 300 - 8 - 5 = 287s
        });
        expect(plan.usesOutro).toBe(true);
        expect(plan.startMs).toBe(287_000);
        expect(plan.beats).toBe(16);
    });

    it('never predicts a negative start on a track shorter than its fade', () => {
        const plan = computeCrossfadePlan({
            outgoingAudioFeatures: { bpm: 60, energy: 0.3 },
            incomingAudioFeatures: { bpm: 60, energy: 0.3 },
            durationMs: 5_000,
            crossfadeBeatsOverride: 32,
        });
        expect(plan.startMs).toBeGreaterThanOrEqual(0);
    });

    it('a manual beat override on a large-gap pair is a normal blend that uses the outro', () => {
        const plan = predictCrossfadeStartMs({
            outgoingAudioFeatures: { bpm: 100, energy: 0.5, outroStartMs: 260_000 },
            incomingAudioFeatures: { bpm: 130, energy: 0.5 },
            durationMs: 300_000,
            crossfadeBeatsOverride: 16,
        });
        expect(plan!.mode).toBe('blend');
        expect(plan!.usesOutro).toBe(true);
        expect(plan!.startMs).toBe(260_000);
    });

    it('200s blend pair: scales (halves) the style beat count instead of using it raw', () => {
        // Equal, moderate-energy BPMs with no mood/key data → default "blend,
        // 48 beats" style. Both tracks are 200s (≤ SHORT_TRACK_SEC), so the
        // beat count must be scaled down (halved, floored to a multiple of 4)
        // rather than used at its raw style value.
        const outgoing: AudioFeatures = { bpm: 120, energy: 0.3 };
        const incoming: AudioFeatures = { bpm: 120, energy: 0.3 };
        const durationMs = 200_000;
        const incomingDurationSec = 200;

        const plan = predictCrossfadeStartMs({
            outgoingAudioFeatures: outgoing,
            incomingAudioFeatures: incoming,
            durationMs,
            incomingDurationSec,
        });

        expect(plan).not.toBeNull();
        expect(plan!.mode).toBe('blend');
        const scaledBeats = scaleCrossfadeBeatsForTrackLength(
            48,
            'blend',
            durationMs / 1000,
            incomingDurationSec,
        );
        expect(scaledBeats).toBeLessThan(48);
        const scaledFadeMs = calculateCrossfadeDuration(120, scaledBeats);
        const rawFadeMs = calculateCrossfadeDuration(120, 48);
        expect(plan!.fadeDurationMs).toBe(scaledFadeMs);
        expect(plan!.fadeDurationMs).toBeLessThan(rawFadeMs);
    });

    it('a dj-outro boundary is not pushed back by lastVocalEndMs', () => {
        // Server mirrored the DJ intro because the vocal signal ran to 3s before
        // the end (synth lead in the mix-out) — outside the 2s outlier window.
        const durationMs = 346_000;
        const outgoing: AudioFeatures = {
            bpm: 143.55,
            energy: 0.53,
            outroStartMs: 291_000,
            outroSource: 'dj-outro',
            lastVocalEndMs: durationMs - 3_000,
        };
        const incoming: AudioFeatures = { bpm: 143.55, energy: 0.5 };

        const plan = predictCrossfadeStartMs({
            outgoingAudioFeatures: outgoing,
            incomingAudioFeatures: incoming,
            durationMs,
        });

        expect(plan).not.toBeNull();
        expect(plan!.lastVocalEndMs).toBeUndefined();
        expect(plan!.outroBoundaryMs).toBe(291_000);
        expect(plan!.startMs).toBeLessThanOrEqual(291_000);
    });

    it('a normal dj-outro keeps lastVocalEndMs as the vocal floor', () => {
        // Vocals end 40s before the end; the server put the dj-outro after them.
        const outgoing: AudioFeatures = {
            bpm: 128,
            energy: 0.5,
            outroStartMs: 323_750,
            outroSource: 'dj-outro',
            lastVocalEndMs: 320_000,
        };
        const plan = predictCrossfadeStartMs({
            outgoingAudioFeatures: outgoing,
            incomingAudioFeatures: { bpm: 128, energy: 0.5 },
            durationMs: 360_000,
        });

        expect(plan).not.toBeNull();
        expect(plan!.lastVocalEndMs).toBe(320_000);
        expect(plan!.startMs).toBeGreaterThanOrEqual(320_000);
    });

    it('lastVocalEndMs within 2s of the track end is ignored (treated as absent)', () => {
        const durationMs = 300_000;
        const withOutlier: AudioFeatures = {
            bpm: 120,
            energy: 0.3,
            lastVocalEndMs: durationMs - 1_000, // inside the 2s outlier window
        };
        const withoutVocalData: AudioFeatures = { bpm: 120, energy: 0.3 };
        const incoming: AudioFeatures = { bpm: 120, energy: 0.3 };

        const planWithOutlier = predictCrossfadeStartMs({
            outgoingAudioFeatures: withOutlier,
            incomingAudioFeatures: incoming,
            durationMs,
        });
        const planWithoutVocalData = predictCrossfadeStartMs({
            outgoingAudioFeatures: withoutVocalData,
            incomingAudioFeatures: incoming,
            durationMs,
        });

        expect(planWithOutlier).not.toBeNull();
        expect(planWithOutlier!.lastVocalEndMs).toBeUndefined();
        expect(planWithOutlier).toEqual(planWithoutVocalData);
    });

    it('returns null when the next track (queue head) has no audioFeatures yet', () => {
        const plan = predictCrossfadeStartMs({
            outgoingAudioFeatures: { bpm: 120, energy: 0.3 },
            incomingAudioFeatures: undefined,
            durationMs: 300_000,
        });
        expect(plan).toBeNull();
    });

    describe('style matrix invariant: prediction + fadeDuration never runs past the end-headroom', () => {
        const durationMs = 300_000;

        const cases: Array<{ name: string; outgoing: AudioFeatures; incoming: AudioFeatures }> = [
            {
                name: 'gap echo (large BPM gap)',
                outgoing: { bpm: 100, energy: 0.5 },
                incoming: { bpm: 130, energy: 0.5 },
            },
            {
                name: 'blend (compatible, moderate energy)',
                outgoing: { bpm: 120, energy: 0.3 },
                incoming: { bpm: 120, energy: 0.3 },
            },
            {
                name: 'bassswap (synced, both energetic)',
                outgoing: { bpm: 120, energy: 0.8 },
                incoming: { bpm: 124, energy: 0.8 },
            },
            {
                name: 'echo (chill mood, no BPM)',
                outgoing: { energy: 0.4 },
                incoming: { energy: 0.4 },
            },
        ];

        for (const { name, outgoing, incoming } of cases) {
            for (const withVocalEnd of [false, true]) {
                it(`${name}${withVocalEnd ? ' with lastVocalEndMs' : ' without lastVocalEndMs'}`, () => {
                    const input: CrossfadePlanInput = {
                        outgoingAudioFeatures: withVocalEnd
                            ? { ...outgoing, lastVocalEndMs: 250_000 }
                            : outgoing,
                        incomingAudioFeatures: incoming,
                        durationMs,
                        mood: name.startsWith('echo') ? 'chill' : undefined,
                    };
                    const plan = predictCrossfadeStartMs(input);
                    expect(plan).not.toBeNull();
                    if (name.startsWith('echo')) expect(plan!.mode).toBe('echo');
                    if (name.startsWith('bassswap')) expect(plan!.mode).toBe('bassswap');
                    if (name.startsWith('gap')) expect(plan!.mode).toBe('echo');
                    expect(plan!.startMs + plan!.fadeDurationMs).toBeLessThanOrEqual(
                        durationMs - CROSSFADE_END_HEADROOM_MS,
                    );
                });
            }
        }
    });
});
