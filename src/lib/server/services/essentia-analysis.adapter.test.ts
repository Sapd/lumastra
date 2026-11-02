// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the sidecar adapter — adaptSidecarAnalysis().
 *
 * Integration Shape A: the Python sonic-embedder /analyze sidecar emits RAW
 * librosa/pyloudnorm features; adaptSidecarAnalysis() maps them into engine-neutral
 * RawAudioFeatures and runs the SAME deriveAnalysis() core the binary uses.
 *
 * These tests are PURE — no PostgreSQL, no audio, no sidecar process. They build
 * hand-crafted /analyze JSON fixtures and assert that every HARD SCALE CONTRACT
 * downstream consumers depend on is enforced at the adapter boundary, plus that the
 * derived fields (intro/outro/dj-intro/energy-curve) are present and sane.
 */

import { describe, it, expect } from 'vitest';
import { adaptSidecarAnalysis, deriveVocalPresenceBounds } from './essentia-analysis.service';
import type { SidecarAnalysis } from './music-analysis-sidecar.service';

const TARGET_LUFS = -14;

/**
 * Build a long DJ-style electronic track fixture: 360 s, 128 BPM, high
 * danceability, electronic mood. Beats sit every 60/128 s; 4/4 downbeats land on
 * every 4th beat. This exercises the full derivation: capped beat_grid, decimated
 * downbeats, smart boundaries, and the DJ-intro profile branch.
 */
function buildDjFixture(overrides: Partial<SidecarAnalysis> = {}): SidecarAnalysis {
    const durationSec = 360;
    const bpm = 128;
    const beatPeriod = 60 / bpm; // ~0.46875 s
    const beatCount = Math.floor(durationSec / beatPeriod); // ~768
    const beats: number[] = [];
    for (let i = 0; i < beatCount; i++) beats.push(Number((i * beatPeriod).toFixed(5)));

    // 600 per-frame values — enough that detectArtistFadeOut runs its RMS-scan path
    // (>100 frames). Steady RMS, no late fade → fade detector should NOT fire here
    // because silence_rate_60 == 0 from the sidecar.
    const frameRms = Array.from({ length: 600 }, () => 0.2);
    const frameEnergy = Array.from({ length: 600 }, (_, i) => 10 + (i % 5));

    return {
        schema_version: 1,
        bpm,
        key: 'A',
        scale: 'minor',
        average_loudness: 0.74,
        loudness_lufs: -8.3,
        danceability: 1.42,
        beats_position: beats,
        frame_rms: frameRms,
        frame_energy: frameEnergy,
        duration: durationSec,
        mood_tags: ['Electronic', 'Party'], // mixed case on purpose
        extras: {
            zcr_mean: 0.061,
            spectral_centroid_mean: 2310,
            spectral_entropy_mean: null,
            dynamic_complexity: null,
            silence_rate_60: 0,
            spectral_complexity_var: 0,
            band_ratio_mean: [],
            band_ratio_var: [],
        },
        ...overrides,
    };
}

describe('adaptSidecarAnalysis — hard scale contracts', () => {
    it('danceability stays on the ~0..3 Essentia scale (NOT 0..1, never *100)', () => {
        const r = adaptSidecarAnalysis(buildDjFixture({ danceability: 2.7 }));
        expect(r.danceability).toBe(2.7);
    });

    it('clamps out-of-range danceability to [0, 3]', () => {
        expect(adaptSidecarAnalysis(buildDjFixture({ danceability: 5 })).danceability).toBe(3);
        expect(adaptSidecarAnalysis(buildDjFixture({ danceability: -1 })).danceability).toBe(0);
    });

    it('energy is clamped to 0..1', () => {
        expect(adaptSidecarAnalysis(buildDjFixture({ average_loudness: 0.74 })).energy).toBe(0.74);
        expect(adaptSidecarAnalysis(buildDjFixture({ average_loudness: 9 })).energy).toBe(1);
        expect(adaptSidecarAnalysis(buildDjFixture({ average_loudness: -5 })).energy).toBe(0);
    });

    it('loudness_lufs is negative and used verbatim when a real R128 value is present', () => {
        const r = adaptSidecarAnalysis(buildDjFixture({ loudness_lufs: -8.3 }));
        expect(r.loudness_lufs).toBe(-8.3);
        expect(r.loudness_lufs).toBeLessThan(0);
    });

    it('derives a negative loudness approximation when loudness_lufs is null', () => {
        const r = adaptSidecarAnalysis(
            buildDjFixture({ loudness_lufs: null, average_loudness: 0.5 }),
        );
        // avg 0.5 → TARGET_LUFS + (0.5 - 0.5) * 20 = -14
        expect(r.loudness_lufs).toBe(TARGET_LUFS);
        expect(r.loudness_lufs).toBeLessThan(0);
    });

    it('formats key with a minor "m" suffix (A + minor → "Am")', () => {
        expect(adaptSidecarAnalysis(buildDjFixture({ key: 'A', scale: 'minor' })).key).toBe('Am');
    });

    it('formats a major key with no suffix (C + major → "C")', () => {
        expect(adaptSidecarAnalysis(buildDjFixture({ key: 'C', scale: 'major' })).key).toBe('C');
    });

    it('preserves accidentals and strips a stray mode suffix from the root', () => {
        expect(adaptSidecarAnalysis(buildDjFixture({ key: 'F#', scale: 'minor' })).key).toBe('F#m');
        // a sidecar that leaks a joined "Gm" must not become "Gmm"
        expect(adaptSidecarAnalysis(buildDjFixture({ key: 'Gm', scale: 'minor' })).key).toBe('Gm');
    });

    it('produces a sorted-ascending downbeats array', () => {
        const r = adaptSidecarAnalysis(buildDjFixture());
        for (let i = 1; i < r.downbeats.length; i++) {
            expect(r.downbeats[i]).toBeGreaterThanOrEqual(r.downbeats[i - 1]);
        }
        expect(r.downbeats.length).toBeGreaterThan(0);
    });

    it('sorts unsorted beats before deriving downbeats', () => {
        const fixture = buildDjFixture({ beats_position: [3, 1, 2, 0.5] });
        const r = adaptSidecarAnalysis(fixture);
        for (let i = 1; i < r.beat_grid.length; i++) {
            expect(r.beat_grid[i]).toBeGreaterThanOrEqual(r.beat_grid[i - 1]);
        }
    });

    it('lowercases and dedupes mood_tags', () => {
        const r = adaptSidecarAnalysis(
            buildDjFixture({ mood_tags: ['Electronic', 'PARTY', 'electronic'] }),
        );
        expect(r.mood_tags).toEqual(['electronic', 'party']);
        for (const tag of r.mood_tags) expect(tag).toBe(tag.toLowerCase());
    });

    it('caps beat_grid at 500 even when the sidecar sends an uncapped array', () => {
        const big = Array.from({ length: 1200 }, (_, i) => i * 0.5);
        const r = adaptSidecarAnalysis(buildDjFixture({ beats_position: big }));
        expect(r.beat_grid.length).toBeLessThanOrEqual(500);
        expect(r.beat_grid.length).toBe(500);
    });
});

describe('adaptSidecarAnalysis — derived fields present & sane', () => {
    it('computes intro/outro boundaries with downbeat source on a beat-rich track', () => {
        const r = adaptSidecarAnalysis(buildDjFixture());
        const durationMs = 360 * 1000;

        expect(Number.isFinite(r.intro_end_ms)).toBe(true);
        expect(Number.isFinite(r.outro_start_ms)).toBe(true);
        expect(r.intro_end_ms).toBeGreaterThanOrEqual(0);
        expect(r.outro_start_ms).toBeGreaterThan(r.intro_end_ms);
        expect(r.outro_start_ms).toBeLessThanOrEqual(durationMs);

        expect(['downbeat', 'percentage', 'fade']).toContain(r.outro_source);
        // beat-rich track with no silence → boundaries come from downbeats, not a fade
        expect(r.outro_source).toBe('downbeat');
    });

    it('detects a DJ intro on the long electronic profile (non-null, within 40% of track)', () => {
        const r = adaptSidecarAnalysis(buildDjFixture());
        expect(r.dj_intro_end_ms).not.toBeNull();
        expect(r.dj_intro_end_ms).toBeGreaterThan(0);
        expect(r.dj_intro_end_ms as number).toBeLessThanOrEqual(360 * 1000 * 0.4);
    });

    it('returns a null dj_intro for a short non-DJ track', () => {
        const r = adaptSidecarAnalysis(
            buildDjFixture({
                duration: 180,
                beats_position: Array.from({ length: 200 }, (_, i) => i * 0.5),
                danceability: 0.3,
                mood_tags: ['sad'],
            }),
        );
        expect(r.dj_intro_end_ms).toBeNull();
    });

    it('builds a real energy curve from frame_energy, normalized to 0..1', () => {
        const r = adaptSidecarAnalysis(buildDjFixture());
        expect(Array.isArray(r.energy_curve)).toBe(true);
        expect(r.energy_curve.length).toBeGreaterThan(0);
        for (const v of r.energy_curve) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
        // normalization → the peak window should reach 1
        expect(Math.max(...r.energy_curve)).toBeCloseTo(1, 5);
    });

    it('emits a valid voice/instrumental classification with bounded confidence', () => {
        const r = adaptSidecarAnalysis(buildDjFixture());
        expect(['voice', 'instrumental']).toContain(r.vocal_instrumental);
        expect(r.vocal_confidence).toBeGreaterThanOrEqual(0);
        expect(r.vocal_confidence).toBeLessThanOrEqual(1);
    });
});

describe('adaptSidecarAnalysis — FIX 1: fade detection works for sidecar (hasSilenceRateHint=false)', () => {
    it('detects a clear outro fade when frame_rms drops to near-zero at end (sidecar, silence_rate_60=0)', () => {
        // 200 seconds, steady RMS until ~85%, then a sustained fade toward 0.
        // The RMS-scan must reach the fade even though silence_rate_60 === 0
        // (the sidecar never fills it). With hasSilenceRateHint=false the guard
        // does NOT fire and the RMS-scan self-gates via the 50–98% window.
        const durationSec = 200;
        const frames = 400;
        const fadeStartFrame = Math.floor(frames * 0.82); // ~164 → ~82% of track
        const frameRms = Array.from({ length: frames }, (_, i) =>
            i < fadeStartFrame
                ? 0.4
                : 0.4 * Math.max(0, 1 - (i - fadeStartFrame) / (frames - fadeStartFrame)),
        );
        const beats: number[] = [];
        for (let i = 0; i < 400; i++) beats.push(i * 0.5);

        const fixture = buildDjFixture({
            duration: durationSec,
            beats_position: beats,
            frame_rms: frameRms,
            danceability: 0.4,
            mood_tags: [],
            extras: {
                zcr_mean: 0.05,
                spectral_centroid_mean: 1000,
                spectral_entropy_mean: null,
                dynamic_complexity: null,
                silence_rate_60: 0, // sidecar always sends 0
                spectral_complexity_var: 0,
                band_ratio_mean: [],
                band_ratio_var: [],
            },
        });

        const r = adaptSidecarAnalysis(fixture);
        expect(r.outro_source).toBe('fade');
        // Fade should be detected somewhere in the 50–98% window
        expect(r.outro_start_ms).toBeGreaterThan(durationSec * 1000 * 0.5);
        expect(r.outro_start_ms).toBeLessThan(durationSec * 1000 * 0.98);
    });
});

describe('adaptSidecarAnalysis — FIX 2: instrumental classification with spectral_entropy_mean', () => {
    it('classifies as instrumental when zcr + centroid + entropy all indicate instrumental (low values)', () => {
        // With spectral_entropy_mean provided (~6.5, below 7.3 threshold), the
        // heuristic now has 3 features (zcr=0.03 < 0.055, centroid=900 < 1200,
        // entropy=6.5 < 7.3) → instrumentalScore=3 → 'instrumental'.
        const fixture = buildDjFixture({
            duration: 180,
            beats_position: Array.from({ length: 240 }, (_, i) => i * 0.75),
            danceability: 0.3,
            mood_tags: [],
            extras: {
                zcr_mean: 0.03,
                spectral_centroid_mean: 900,
                spectral_entropy_mean: 6.5,
                dynamic_complexity: null,
                silence_rate_60: 0,
                spectral_complexity_var: 0,
                band_ratio_mean: [],
                band_ratio_var: [],
            },
        });

        const r = adaptSidecarAnalysis(fixture);
        expect(r.vocal_instrumental).toBe('instrumental');
        expect(r.vocal_confidence).toBeGreaterThan(0);
    });

    it('still defaults to voice when only zcr + centroid provided (2 features < 3 threshold)', () => {
        const fixture = buildDjFixture({
            extras: {
                zcr_mean: 0.03,
                spectral_centroid_mean: 900,
                spectral_entropy_mean: null, // only 2 features
                dynamic_complexity: null,
                silence_rate_60: 0,
                spectral_complexity_var: 0,
                band_ratio_mean: [],
                band_ratio_var: [],
            },
        });

        const r = adaptSidecarAnalysis(fixture);
        expect(r.vocal_instrumental).toBe('voice');
    });
});

describe('adaptSidecarAnalysis — defensive coercion of malformed input', () => {
    it('survives non-finite / missing numeric fields without throwing', () => {
        const r = adaptSidecarAnalysis(
            buildDjFixture({
                bpm: Number.NaN,
                average_loudness: Number.POSITIVE_INFINITY,
                danceability: Number.NaN,
                duration: Number.NaN,
                loudness_lufs: Number.NaN as unknown as number,
            }),
        );
        expect(r.bpm).toBe(0);
        // +Infinity is non-finite → finiteOr falls back to 0 (garbage in, neutral out)
        expect(r.energy).toBe(0);
        expect(r.danceability).toBe(0);
        // NaN loudness → treated as "unmeasurable" → derived (avg clamped to 1) negative dB
        expect(Number.isFinite(r.loudness_lufs)).toBe(true);
        expect(r.loudness_lufs).toBeLessThan(0);
    });

    it('drops non-numeric beats and keeps the array sorted', () => {
        const r = adaptSidecarAnalysis(
            buildDjFixture({
                beats_position: [2, 'x' as unknown as number, 1, Number.NaN, 0.5],
            }),
        );
        expect(r.beat_grid).toEqual([0.5, 1, 2]);
    });
});

describe('vocal-phrase boundaries (deriveVocalPresenceBounds + adapter e2e)', () => {
    /** hop=100ms signal: `ranges` are [startBin, endBinExclusive] at `high`, rest at `low`. */
    function buildRatio(
        bins: number,
        ranges: Array<[number, number]>,
        high = 0.3,
        low = 0.02,
    ): number[] {
        const arr = new Array<number>(bins).fill(low);
        for (const [s, e] of ranges) for (let i = s; i < e; i++) arr[i] = high;
        return arr;
    }

    it('detects first/last vocal boundaries on a clear vocal region', () => {
        // 300s track, vocals 30s → 240s
        const bounds = deriveVocalPresenceBounds(
            { vocalBandRatio: buildRatio(3000, [[300, 2400]]), vocalRatioHopMs: 100 },
            300,
            true,
        );
        expect(bounds).not.toBeNull();
        expect(bounds!.firstVocalStartMs).toBeGreaterThan(28_000);
        expect(bounds!.firstVocalStartMs).toBeLessThan(32_000);
        expect(bounds!.lastVocalEndMs).toBeGreaterThan(238_000);
        expect(bounds!.lastVocalEndMs).toBeLessThan(242_000);
    });

    it('returns null for instrumental tracks', () => {
        expect(
            deriveVocalPresenceBounds(
                { vocalBandRatio: buildRatio(3000, [[300, 2400]]), vocalRatioHopMs: 100 },
                300,
                false,
            ),
        ).toBeNull();
    });

    it('returns null when the signal is missing (binary engine / old sidecar)', () => {
        expect(
            deriveVocalPresenceBounds({ vocalBandRatio: null, vocalRatioHopMs: null }, 300, true),
        ).toBeNull();
        expect(
            deriveVocalPresenceBounds({ vocalBandRatio: [], vocalRatioHopMs: 100 }, 300, true),
        ).toBeNull();
    });

    it('returns null when vocal coverage is too sparse to trust', () => {
        // single 3s blip in a 300s track (1% coverage < 5% minimum)
        expect(
            deriveVocalPresenceBounds(
                { vocalBandRatio: buildRatio(3000, [[1000, 1030]]), vocalRatioHopMs: 100 },
                300,
                true,
            ),
        ).toBeNull();
    });

    it('extends the last boundary across separate phrases and clamps to duration', () => {
        // verse 20-60s, chorus 250-299.9s (to the end)
        const bounds = deriveVocalPresenceBounds(
            {
                vocalBandRatio: buildRatio(3000, [
                    [200, 600],
                    [2500, 3000],
                ]),
                vocalRatioHopMs: 100,
            },
            300,
            true,
        );
        expect(bounds).not.toBeNull();
        expect(bounds!.firstVocalStartMs).toBeLessThan(22_000);
        expect(bounds!.lastVocalEndMs).toBeLessThanOrEqual(300_000);
        expect(bounds!.lastVocalEndMs).toBeGreaterThan(295_000);
    });

    it('returns null when the ratio signal does not span the track', () => {
        // 100s of bins for a 300s track — truncated/filtered transport would
        // silently shift every boundary timestamp, so it must be rejected
        expect(
            deriveVocalPresenceBounds(
                { vocalBandRatio: buildRatio(1000, [[100, 900]]), vocalRatioHopMs: 100 },
                300,
                true,
            ),
        ).toBeNull();
    });

    it('returns null when only mutual outlier chops remain after trimming', () => {
        // 60s track: two isolated 2s chops 28s apart — passes the 5% coverage
        // gate, but neither is a real phrase; trimming must not leave one of
        // them standing as the "vocal boundary"
        expect(
            deriveVocalPresenceBounds(
                {
                    vocalBandRatio: buildRatio(600, [
                        [100, 120],
                        [400, 420],
                    ]),
                    vocalRatioHopMs: 100,
                },
                60,
                true,
            ),
        ).toBeNull();
    });

    it('trims a short isolated trailing blip (extended-mix outro chop)', () => {
        // vocals 30-160s, lone 1.5s blip at 290s of a 300s track (verified prod
        // pattern: FX stab in the DJ outro) → lastVocal stays at ~160s
        const bounds = deriveVocalPresenceBounds(
            {
                vocalBandRatio: buildRatio(3000, [
                    [300, 1600],
                    [2900, 2915],
                ]),
                vocalRatioHopMs: 100,
            },
            300,
            true,
        );
        expect(bounds).not.toBeNull();
        expect(bounds!.lastVocalEndMs).toBeLessThan(165_000);
    });

    it('keeps a short trailing segment when it is close to the previous one', () => {
        // chop 10s after the last block (gap < 20s) → part of the vocal tail
        const bounds = deriveVocalPresenceBounds(
            {
                vocalBandRatio: buildRatio(3000, [
                    [300, 1600],
                    [1700, 1715],
                ]),
                vocalRatioHopMs: 100,
            },
            300,
            true,
        );
        expect(bounds).not.toBeNull();
        expect(bounds!.lastVocalEndMs).toBeGreaterThan(168_000);
    });

    it('trims a short isolated leading blip', () => {
        // lone 1.5s chop at 5s, real vocals from 60s → firstVocal ≈ 60s
        const bounds = deriveVocalPresenceBounds(
            {
                vocalBandRatio: buildRatio(3000, [
                    [50, 65],
                    [600, 2000],
                ]),
                vocalRatioHopMs: 100,
            },
            300,
            true,
        );
        expect(bounds).not.toBeNull();
        expect(bounds!.firstVocalStartMs).toBeGreaterThan(55_000);
    });

    it('pulls the outro forward to the DJ outro on extended tracks (dj-outro)', () => {
        // 360s DJ-format track, vocals 30s → 315s: 45s instrumental tail.
        // Expected fade point: lastVocal + 8 beats @128bpm (3.75s) ≈ 318.75s.
        const fixture = buildDjFixture();
        fixture.extras = {
            ...fixture.extras,
            vocal_band_ratio: buildRatio(3600, [[300, 3150]]),
            vocal_ratio_hop_ms: 100,
        };
        const r = adaptSidecarAnalysis(fixture);
        expect(r.dj_intro_end_ms).not.toBeNull();
        expect(r.outro_source).toBe('dj-outro');
        expect(r.outro_start_ms).toBeGreaterThan(315_000);
        expect(r.outro_start_ms).toBeLessThan(325_000);
    });

    it('caps the dj-outro pull-forward at 60s before track end', () => {
        // vocals end at 240s → 120s tail, but the fade point must not move
        // earlier than duration − 60s = 300s.
        const fixture = buildDjFixture();
        fixture.extras = {
            ...fixture.extras,
            vocal_band_ratio: buildRatio(3600, [[300, 2400]]),
            vocal_ratio_hop_ms: 100,
        };
        const r = adaptSidecarAnalysis(fixture);
        expect(r.outro_source).toBe('dj-outro');
        expect(r.outro_start_ms).toBeGreaterThanOrEqual(300_000);
        expect(r.outro_start_ms).toBeLessThan(305_000);
    });

    it('does not pull the outro forward when the vocal tail is short', () => {
        // vocals to 340s of 360s → 20s tail < 30s minimum → normal outro source
        const fixture = buildDjFixture();
        fixture.extras = {
            ...fixture.extras,
            vocal_band_ratio: buildRatio(3600, [[300, 3400]]),
            vocal_ratio_hop_ms: 100,
        };
        const r = adaptSidecarAnalysis(fixture);
        expect(r.outro_source).not.toBe('dj-outro');
    });

    it('mirrors the DJ intro when the vocal signal runs to the track end', () => {
        // Prod pattern (Megalanterns vs. Ti-Mo — Rescue Me (Club Mix)): a
        // synth lead keeps the vocal band "on" until the last sample, so
        // last_vocal_end_ms = duration and the vocal-tail rule never fires.
        // The DJ intro is the format signal, so the mix-out mirrors it:
        // max(duration − introLength, duration − 60s).
        const fixture = buildDjFixture();
        fixture.extras = {
            ...fixture.extras,
            vocal_band_ratio: buildRatio(3600, [[300, 3600]]),
            vocal_ratio_hop_ms: 100,
        };
        const r = adaptSidecarAnalysis(fixture);
        const introMs = r.dj_intro_end_ms!;
        expect(introMs).not.toBeNull();
        expect(r.last_vocal_end_ms!).toBeGreaterThan(357_000);
        expect(r.outro_source).toBe('dj-outro');
        expect(r.outro_start_ms).toBe(Math.round(Math.max(360_000 - introMs, 300_000)));
    });

    it('mirrors the DJ intro when the vocal signal ends within the last 4s', () => {
        const fixture = buildDjFixture();
        fixture.extras = {
            ...fixture.extras,
            vocal_band_ratio: buildRatio(3600, [[300, 3570]]),
            vocal_ratio_hop_ms: 100,
        };
        const r = adaptSidecarAnalysis(fixture);
        expect(r.outro_source).toBe('dj-outro');
        expect(r.outro_start_ms).toBeLessThan(320_000);
    });

    it('mirrors the DJ intro when the vocal signal ends exactly 4s before the end', () => {
        const fixture = buildDjFixture();
        fixture.extras = {
            ...fixture.extras,
            vocal_band_ratio: buildRatio(3600, [[300, 3560]]),
            vocal_ratio_hop_ms: 100,
        };
        const r = adaptSidecarAnalysis(fixture);
        expect(360_000 - r.last_vocal_end_ms!).toBeLessThanOrEqual(4_000);
        expect(r.outro_source).toBe('dj-outro');
    });

    it('does not mirror the DJ intro when vocals end a few seconds before the end', () => {
        // 6s before the end is a plausible last sung line — keep the normal outro.
        const fixture = buildDjFixture();
        fixture.extras = {
            ...fixture.extras,
            vocal_band_ratio: buildRatio(3600, [[300, 3540]]),
            vocal_ratio_hop_ms: 100,
        };
        const r = adaptSidecarAnalysis(fixture);
        expect(r.outro_source).not.toBe('dj-outro');
    });

    it('does not mirror the DJ intro on tracks without a DJ intro', () => {
        // 280s track: below the extended-mix length, so no DJ intro.
        const fixture = buildDjFixture({ duration: 280 });
        fixture.extras = {
            ...fixture.extras,
            vocal_band_ratio: buildRatio(2800, [[300, 2800]]),
            vocal_ratio_hop_ms: 100,
        };
        const r = adaptSidecarAnalysis(fixture);
        expect(r.dj_intro_end_ms).toBeNull();
        expect(r.last_vocal_end_ms!).toBeGreaterThan(277_000);
        expect(r.outro_source).not.toBe('dj-outro');
    });

    it('flows end-to-end through adaptSidecarAnalysis', () => {
        const fixture = buildDjFixture();
        fixture.extras = {
            ...fixture.extras,
            vocal_band_ratio: buildRatio(3600, [[300, 2400]]),
            vocal_ratio_hop_ms: 100,
        };
        const r = adaptSidecarAnalysis(fixture);
        expect(r.vocal_instrumental).toBe('voice');
        expect(r.first_vocal_start_ms).not.toBeNull();
        expect(r.last_vocal_end_ms).not.toBeNull();
        expect(r.last_vocal_end_ms!).toBeGreaterThan(230_000);

        // Without the signal the fields are null (older sidecar / binary parity)
        const bare = adaptSidecarAnalysis(buildDjFixture());
        expect(bare.first_vocal_start_ms).toBeNull();
        expect(bare.last_vocal_end_ms).toBeNull();
    });
});
