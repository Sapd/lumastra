// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * chromaprint.test.ts — unit tests for the cross-episode fingerprint matcher.
 *
 * Exercises the matcher against a synthetic-fingerprint generator: a deterministic
 * random background with a shared "intro/credits" block planted into multiple
 * episodes at different offsets and with controllable per-point bit-noise. The real
 * ffmpeg helper is mocked; the mock slices a registered whole-episode fingerprint by
 * the [startSec, endSec] window the analyzer asks for, so window math and coordinate
 * translation are exercised end to end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FFmpegTimeoutError } from '$lib/server/utils/ffmpeg-spawn.js';
import type { EpisodeWithFile } from './types.js';
import type { ChromaprintConfig } from './chromaprint.js';

// Seconds of audio summarized by one fingerprint point (per the spec).
const POINT = 0.1238;

// ── ffmpeg helper mock ────────────────────────────────────────────────────────
const { mockFingerprint } = vi.hoisted(() => ({ mockFingerprint: vi.fn() }));
vi.mock('$lib/server/utils/ffmpeg-analysis.js', () => ({
    chromaprintFingerprint: mockFingerprint,
}));

import {
    analyzeSeasonFingerprints,
    analyzeSeasonCreditsFingerprints,
    DEFAULT_CHROMAPRINT_CONFIG,
} from './chromaprint.js';

// ── deterministic PRNG (no Math.random → no flakes) ────────────────────────────
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function randomFingerprint(lengthPoints: number, seed: number): Uint32Array {
    const rng = mulberry32(seed);
    const out = new Uint32Array(lengthPoints);
    for (let i = 0; i < lengthPoints; i++) out[i] = (rng() * 4294967296) >>> 0;
    return out;
}

/** Flip `n` distinct random bit positions in a uint32. */
function flipBits(value: number, n: number, rng: () => number): number {
    let v = value >>> 0;
    const used = new Set<number>();
    while (used.size < n) {
        const bit = Math.floor(rng() * 32);
        if (used.has(bit)) continue;
        used.add(bit);
        v = (v ^ (1 << bit)) >>> 0;
    }
    return v >>> 0;
}

interface PlantSpec {
    block: Uint32Array; // shared clean block (same array across episodes)
    offsetPoints: number; // where it lands in this episode's fingerprint
    noiseBits?: number; // bits flipped per planted point (default 0)
    noiseSeed?: number; // PRNG seed for the noise
    stride?: number; // plant only every `stride`-th point (default 1 = dense)
}

interface EpisodeSpec {
    durationSeconds: number | null;
    lengthPoints?: number; // full-episode fingerprint length; derived from duration when omitted
    backgroundSeed: number;
    plants?: PlantSpec[];
}

const fingerprintByPath = new Map<string, Uint32Array>();
const failingPaths = new Set<string>();

function pathFor(id: string): string {
    return `/media/${id}.mkv`;
}

function makeShared(blockPoints: number, seed: number): Uint32Array {
    return randomFingerprint(blockPoints, seed);
}

function registerEpisode(id: string, spec: EpisodeSpec): EpisodeWithFile {
    const len =
        spec.lengthPoints ??
        (spec.durationSeconds != null ? Math.round(spec.durationSeconds / POINT) : 0);
    const fp = randomFingerprint(len, spec.backgroundSeed);
    for (const plant of spec.plants ?? []) {
        const rng = mulberry32(plant.noiseSeed ?? 1);
        const stride = plant.stride ?? 1;
        for (let i = 0; i < plant.block.length; i++) {
            const dst = plant.offsetPoints + i;
            if (dst < 0 || dst >= fp.length) continue;
            // Sparse planting: leave the non-strided points as random background,
            // so only every stride-th point matches across episodes (low density).
            if (stride > 1 && i % stride !== 0) continue;
            const noise = plant.noiseBits ?? 0;
            fp[dst] = noise > 0 ? flipBits(plant.block[i], noise, rng) : plant.block[i];
        }
    }
    fingerprintByPath.set(pathFor(id), fp);
    return {
        episodeId: id,
        title: id,
        seasonNumber: 1,
        episodeNumber: 1,
        filePath: pathFor(id),
        durationSeconds: spec.durationSeconds,
    };
}

function baseConfig(overrides: Partial<ChromaprintConfig> = {}): ChromaprintConfig {
    return {
        maxPointDifferences: 6,
        maxTimeSkip: 1.0,
        minIntroDuration: 3,
        maxIntroDuration: 15,
        introWindowFraction: 0.5,
        introWindowMaxSec: 600,
        invertedIndexShift: 2,
        ...overrides,
    };
}

beforeEach(() => {
    fingerprintByPath.clear();
    failingPaths.clear();
    mockFingerprint.mockReset();
    mockFingerprint.mockImplementation(
        async (filePath: string, startSec: number, endSec: number): Promise<Uint32Array> => {
            if (failingPaths.has(filePath)) throw new Error(`ffmpeg failed for ${filePath}`);
            const full = fingerprintByPath.get(filePath);
            if (!full) return new Uint32Array(0);
            const s = Math.max(0, Math.round(startSec / POINT));
            const e = Math.min(full.length, Math.round(endSec / POINT));
            if (e <= s) return new Uint32Array(0);
            return full.slice(s, e);
        },
    );
});

describe('analyzeSeasonFingerprints — intro pass', () => {
    it('finds the shared block at different offsets in every episode', async () => {
        const block = makeShared(40, 7); // ~4.95s
        // offsets chosen > 5s so the snap-to-zero rule does not fire here
        const offsets = [50, 70, 90]; // ~6.2s, 8.7s, 11.1s
        const episodes = offsets.map((off, idx) =>
            registerEpisode(`ep${idx}`, {
                durationSeconds: 40,
                backgroundSeed: 100 + idx,
                plants: [{ block, offsetPoints: off }],
            }),
        );

        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());

        expect(result.size).toBe(3);
        offsets.forEach((off, idx) => {
            const seg = result.get(`ep${idx}`);
            expect(seg).toBeDefined();
            expect(seg!.type).toBe('Intro');
            expect(seg!.method).toBe('chromaprint');
            expect(Math.abs(seg!.startTime - off * POINT)).toBeLessThanOrEqual(2 * POINT);
        });
    });

    it('matches under bit-noise up to maxPointDifferences but not well above it', async () => {
        const block = makeShared(48, 11);
        const within = [
            registerEpisode('a0', {
                durationSeconds: 40,
                backgroundSeed: 200,
                plants: [{ block, offsetPoints: 55 }],
            }),
            registerEpisode('a1', {
                durationSeconds: 40,
                backgroundSeed: 201,
                plants: [{ block, offsetPoints: 60, noiseBits: 6, noiseSeed: 3 }],
            }),
        ];
        const okResult = await analyzeSeasonFingerprints(within, '/tmp', baseConfig());
        expect(okResult.get('a0')).toBeDefined();
        expect(okResult.get('a1')).toBeDefined();

        const noisy = [
            registerEpisode('b0', {
                durationSeconds: 40,
                backgroundSeed: 202,
                plants: [{ block, offsetPoints: 55 }],
            }),
            registerEpisode('b1', {
                durationSeconds: 40,
                backgroundSeed: 203,
                plants: [{ block, offsetPoints: 60, noiseBits: 14, noiseSeed: 4 }],
            }),
        ];
        const badResult = await analyzeSeasonFingerprints(noisy, '/tmp', baseConfig());
        expect(badResult.size).toBe(0);
    });

    it('returns an empty map when no content is shared', async () => {
        const episodes = [
            registerEpisode('n0', { durationSeconds: 40, backgroundSeed: 300 }),
            registerEpisode('n1', { durationSeconds: 40, backgroundSeed: 301 }),
            registerEpisode('n2', { durationSeconds: 40, backgroundSeed: 302 }),
        ];
        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());
        expect(result.size).toBe(0);
    });

    it('splits a run on a gap larger than maxTimeSkip and reports only the longer half', async () => {
        // Shared block of 71 points with an unplanted 13-point hole in the middle.
        // Left half = 50 points (~6.19s, kept); right half = 20 points (~2.48s, < min).
        const shared = makeShared(71, 13);
        const leftLen = 50;
        const holeLen = 13;
        const rightStart = leftLen + holeLen; // 63
        const offset = 50; // ~6.19s, past the 5s snap-to-zero window
        function plantSplit(id: string, seed: number): EpisodeWithFile {
            const fp = randomFingerprint(Math.round(40 / POINT), seed);
            for (let i = 0; i < leftLen; i++) fp[offset + i] = shared[i];
            for (let i = 0; i < 20; i++) fp[offset + rightStart + i] = shared[rightStart + i];
            fingerprintByPath.set(pathFor(id), fp);
            return {
                episodeId: id,
                title: id,
                seasonNumber: 1,
                episodeNumber: 1,
                filePath: pathFor(id),
                durationSeconds: 40,
            };
        }
        const episodes = [plantSplit('g0', 400), plantSplit('g1', 401)];
        // maxTimeSkip 1.0s ≈ 8 points < 13-point hole → splits.
        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());

        const seg = result.get('g0');
        expect(seg).toBeDefined();
        // Only the longer (left) half survives: ~50 points.
        const durationSec = seg!.endTime - seg!.startTime;
        expect(durationSec).toBeGreaterThanOrEqual((leftLen - 4) * POINT);
        expect(durationSec).toBeLessThanOrEqual((leftLen + 4) * POINT);
        // start near the planted left-block offset; > 5s so snap-to-zero does NOT fire
        expect(Math.abs(seg!.startTime - offset * POINT)).toBeLessThanOrEqual(2 * POINT);
    });

    it('discards runs shorter than minIntroDuration', async () => {
        const block = makeShared(15, 21); // ~1.86s < min 3s
        const episodes = [
            registerEpisode('s0', {
                durationSeconds: 40,
                backgroundSeed: 500,
                plants: [{ block, offsetPoints: 60 }],
            }),
            registerEpisode('s1', {
                durationSeconds: 40,
                backgroundSeed: 501,
                plants: [{ block, offsetPoints: 70 }],
            }),
        ];
        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());
        expect(result.size).toBe(0);
    });

    it('discards runs longer than maxIntroDuration', async () => {
        const block = makeShared(130, 23); // ~16.1s > max 15s
        const episodes = [
            registerEpisode('l0', {
                durationSeconds: 80,
                backgroundSeed: 600,
                plants: [{ block, offsetPoints: 5 }],
            }),
            registerEpisode('l1', {
                durationSeconds: 80,
                backgroundSeed: 601,
                plants: [{ block, offsetPoints: 9 }],
            }),
        ];
        // intro window = 0.5 * 80 = 40s ≈ 323 points → block fits
        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());
        expect(result.size).toBe(0);
    });

    it('snaps a near-immediate intro start to zero', async () => {
        const block = makeShared(40, 31);
        const episodes = [
            registerEpisode('z0', {
                durationSeconds: 40,
                backgroundSeed: 700,
                plants: [{ block, offsetPoints: 16 }], // ~1.98s ≤ 5s
            }),
            registerEpisode('z1', {
                durationSeconds: 40,
                backgroundSeed: 701,
                plants: [{ block, offsetPoints: 20 }], // ~2.48s ≤ 5s
            }),
        ];
        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());
        expect(result.get('z0')!.startTime).toBe(0);
        expect(result.get('z1')!.startTime).toBe(0);
    });

    it('returns an empty map with fewer than two usable episodes', async () => {
        const block = makeShared(40, 41);
        const episodes = [
            registerEpisode('only', {
                durationSeconds: 40,
                backgroundSeed: 800,
                plants: [{ block, offsetPoints: 60 }],
            }),
        ];
        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());
        expect(result.size).toBe(0);
    });

    it('skips only the episode whose fingerprint extraction fails', async () => {
        const block = makeShared(40, 43);
        const episodes = [
            registerEpisode('f0', {
                durationSeconds: 40,
                backgroundSeed: 900,
                plants: [{ block, offsetPoints: 55 }],
            }),
            registerEpisode('f1', {
                durationSeconds: 40,
                backgroundSeed: 901,
                plants: [{ block, offsetPoints: 60 }],
            }),
            registerEpisode('f2', {
                durationSeconds: 40,
                backgroundSeed: 902,
                plants: [{ block, offsetPoints: 65 }],
            }),
        ];
        failingPaths.add(pathFor('f1'));
        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());
        expect(result.has('f0')).toBe(true);
        expect(result.has('f2')).toBe(true);
        expect(result.has('f1')).toBe(false);
    });

    it('does no work and returns empty when the signal is already aborted', async () => {
        const block = makeShared(40, 45);
        const episodes = [
            registerEpisode('x0', {
                durationSeconds: 40,
                backgroundSeed: 1000,
                plants: [{ block, offsetPoints: 55 }],
            }),
            registerEpisode('x1', {
                durationSeconds: 40,
                backgroundSeed: 1001,
                plants: [{ block, offsetPoints: 60 }],
            }),
        ];
        const controller = new AbortController();
        controller.abort();
        const result = await analyzeSeasonFingerprints(
            episodes,
            '/tmp',
            baseConfig(),
            1,
            0,
            controller.signal,
        );
        expect(result.size).toBe(0);
        expect(mockFingerprint).not.toHaveBeenCalled();
    });

    it('exposes a sensible default config', () => {
        expect(DEFAULT_CHROMAPRINT_CONFIG.maxPointDifferences).toBe(6);
        expect(DEFAULT_CHROMAPRINT_CONFIG.maxTimeSkip).toBe(3.5);
        expect(DEFAULT_CHROMAPRINT_CONFIG.minIntroDuration).toBe(15);
        expect(DEFAULT_CHROMAPRINT_CONFIG.introWindowFraction).toBe(0.25);
        expect(DEFAULT_CHROMAPRINT_CONFIG.invertedIndexShift).toBe(2);
    });
});

describe('cohort consensus + match density', () => {
    it('rejects an anomalous-pairing length outlier in favour of the cohort consensus', async () => {
        // All four episodes share a 40-point intro (~5s). Two of them ALSO share a
        // longer 110-point block elsewhere in the window. A per-episode "longest run"
        // selector would report the 110-pt block for those two; cohort consensus
        // (most episodes agree on 40 pts) must report the 40-pt intro instead.
        const intro = makeShared(40, 1301); // ~5.0s
        const anomaly = makeShared(110, 1302); // ~13.6s, within the 15s max bound
        const introOffset = 100; // ~12.4s (> 5s, no snap)
        const anomalyOffset = 200;
        function ep(id: string, seed: number, withAnomaly: boolean): EpisodeWithFile {
            const plants: PlantSpec[] = [{ block: intro, offsetPoints: introOffset }];
            if (withAnomaly) plants.push({ block: anomaly, offsetPoints: anomalyOffset });
            return registerEpisode(id, { durationSeconds: 80, backgroundSeed: seed, plants });
        }
        // duration 80 → intro window 0.5*80 = 40s ≈ 323 pts → both blocks fit
        const episodes = [
            ep('k0', 1310, true),
            ep('k1', 1311, true),
            ep('k2', 1312, false),
            ep('k3', 1313, false),
        ];
        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());

        for (const id of ['k0', 'k1', 'k2', 'k3']) {
            const seg = result.get(id);
            expect(seg, `expected a segment for ${id}`).toBeDefined();
            // Consensus length ~40 pts (~5s), NOT the 110-pt (~13.6s) anomaly.
            const lengthSec = seg!.endTime - seg!.startTime;
            expect(lengthSec).toBeLessThan(9); // well under the 13.6s anomaly
            // Anchored at the intro (~12.4s), not the anomaly (~24.8s).
            expect(Math.abs(seg!.startTime - introOffset * POINT)).toBeLessThanOrEqual(3 * POINT);
        }
    });

    it('detects a cohort-wide intro across more episodes than the peer-comparison cap', async () => {
        // 20 episodes share the same 40-pt intro at slightly varied offsets (> 5s, so
        // snap-to-zero does not collapse them). This exceeds the per-episode peer cap,
        // so each episode is compared only with a window of neighbours — yet the
        // cohort-wide intro must still be found for every episode.
        const intro = makeShared(40, 1501);
        const episodes = Array.from({ length: 20 }, (_, i) =>
            registerEpisode(`m${i}`, {
                durationSeconds: 80,
                backgroundSeed: 1600 + i,
                plants: [{ block: intro, offsetPoints: 60 + (i % 5) * 4 }],
            }),
        );
        const result = await analyzeSeasonFingerprints(episodes, '/tmp', baseConfig());
        expect(result.size).toBe(20);
        for (let i = 0; i < 20; i++) expect(result.get(`m${i}`)).toBeDefined();
    });

    it('does not form a segment from sparse, low-density matches', async () => {
        // Two episodes share a value only every 5th point across a 200-point span;
        // gaps of 5 pts are below maxTimeSkip (≈8 pts) so a naive gap-bridging matcher
        // would chain them into a ~200-pt run. A density-aware matcher must reject it.
        const block = makeShared(200, 1401);
        const sparse = [
            registerEpisode('sp0', {
                durationSeconds: 40,
                backgroundSeed: 1410,
                plants: [{ block, offsetPoints: 40, stride: 5 }],
            }),
            registerEpisode('sp1', {
                durationSeconds: 40,
                backgroundSeed: 1411,
                plants: [{ block, offsetPoints: 40, stride: 5 }],
            }),
        ];
        const sparseResult = await analyzeSeasonFingerprints(sparse, '/tmp', baseConfig());
        expect(sparseResult.size).toBe(0);

        // Control: the SAME span planted densely is detected — proving the gate is
        // selective, not just rejecting everything.
        const dense = [
            registerEpisode('dn0', {
                durationSeconds: 40,
                backgroundSeed: 1420,
                plants: [{ block, offsetPoints: 40 }],
            }),
            registerEpisode('dn1', {
                durationSeconds: 40,
                backgroundSeed: 1421,
                plants: [{ block, offsetPoints: 45 }],
            }),
        ];
        const denseResult = await analyzeSeasonFingerprints(dense, '/tmp', baseConfig());
        expect(denseResult.get('dn0')).toBeDefined();
        expect(denseResult.get('dn1')).toBeDefined();
    });
});

describe('analyzeSeasonCreditsFingerprints — credits pass', () => {
    it('translates detected times into the tail window and excludes short/unknown-duration episodes', async () => {
        const cfg = baseConfig({ maxIntroDuration: 15 }); // tail window = 15s
        const block = makeShared(40, 51);
        // duration 40s → tail window [25, 40]; plant at absolute ~28s.
        const plantAbsPoints = Math.round(28 / POINT); // ~226
        const a = registerEpisode('c0', {
            durationSeconds: 40,
            backgroundSeed: 1100,
            plants: [{ block, offsetPoints: plantAbsPoints }],
        });
        const b = registerEpisode('c1', {
            durationSeconds: 40,
            backgroundSeed: 1101,
            plants: [{ block, offsetPoints: plantAbsPoints + 5 }],
        });
        // duration ≤ maxIntroDuration → excluded (tail window would collapse onto intro)
        const short = registerEpisode('c2', { durationSeconds: 15, backgroundSeed: 1102 });
        // unknown duration → excluded
        const unknown = registerEpisode('c3', {
            durationSeconds: null,
            lengthPoints: 0,
            backgroundSeed: 1103,
        });

        const result = await analyzeSeasonCreditsFingerprints(
            [a, b, short, unknown],
            '/tmp',
            cfg,
            1,
            0,
        );

        expect(result.has('c2')).toBe(false);
        expect(result.has('c3')).toBe(false);
        const seg = result.get('c0');
        expect(seg).toBeDefined();
        expect(seg!.type).toBe('Outro');
        expect(seg!.method).toBe('chromaprint');
        // absolute start ≈ 28s (tail-window start added back in)
        expect(Math.abs(seg!.startTime - 28)).toBeLessThanOrEqual(3 * POINT);
        expect(result.get('c1')).toBeDefined();
    });

    it('returns empty when fewer than two episodes survive the duration filter', async () => {
        const cfg = baseConfig({ maxIntroDuration: 15 });
        const block = makeShared(40, 53);
        const a = registerEpisode('d0', {
            durationSeconds: 40,
            backgroundSeed: 1200,
            plants: [{ block, offsetPoints: Math.round(28 / POINT) }],
        });
        const short = registerEpisode('d1', { durationSeconds: 10, backgroundSeed: 1201 });
        const result = await analyzeSeasonCreditsFingerprints([a, short], '/tmp', cfg, 1, 0);
        expect(result.size).toBe(0);
    });
});

describe('same-file self-comparison', () => {
    /**
     * Two episodes can name the SAME physical file — a genuine combined file
     * holding both, or a scanner mis-link. Their fingerprints are then
     * byte-identical, so every point matches on diagonal 0 and the "shared run"
     * is the whole window.
     *
     * The consensus band normally masks this: with a real intro in the season,
     * the median run length is the real intro's and the full-window run falls
     * out of band. It surfaces when nothing in the season has a genuine shared
     * intro — the degenerate runs then ARE the consensus. That is how Hafentage S6
     * (rips with no title sequence, three episodes mis-linked onto one combined
     * file) ended up with an intro covering 97% of its head window, marking real
     * content skippable.
     */
    it('reports no intro when every episode resolves to the same file', async () => {
        const a = registerEpisode('dup-a', { durationSeconds: 28, backgroundSeed: 41 });
        // Point both episodes at the SAME path — identical fingerprints.
        const b: EpisodeWithFile = { ...a, episodeId: 'dup-b', title: 'dup-b' };
        const c: EpisodeWithFile = { ...a, episodeId: 'dup-c', title: 'dup-c' };

        const res = await analyzeSeasonFingerprints([a, b, c], '/tmp', baseConfig(), 1, 0);

        expect(res.size).toBe(0);
    });

    it('still finds the real intro when a duplicated file sits alongside distinct ones', async () => {
        // Three episodes sharing a genuine 6s intro, plus a fourth that is a
        // duplicate of the first. The duplicate must not drag the consensus to a
        // full-window run, and must not suppress the real detection either.
        const shared = makeShared(Math.round(5 / POINT), 7);
        const e1 = registerEpisode('real-1', {
            durationSeconds: 28,
            backgroundSeed: 11,
            plants: [{ block: shared, offsetPoints: 0 }],
        });
        const e2 = registerEpisode('real-2', {
            durationSeconds: 28,
            backgroundSeed: 12,
            plants: [{ block: shared, offsetPoints: 0 }],
        });
        const e3 = registerEpisode('real-3', {
            durationSeconds: 28,
            backgroundSeed: 13,
            plants: [{ block: shared, offsetPoints: 0 }],
        });
        const dup: EpisodeWithFile = { ...e1, episodeId: 'real-1-dup', title: 'real-1-dup' };

        const res = await analyzeSeasonFingerprints([e1, e2, e3, dup], '/tmp', baseConfig(), 1, 0);

        for (const id of ['real-1', 'real-2', 'real-3']) {
            const seg = res.get(id);
            expect(seg, `${id} should still get the real intro`).toBeDefined();
            expect(seg!.startTime).toBe(0);
            // ~5s intro, not the 14s head window.
            expect(seg!.endTime).toBeGreaterThan(3.5);
            expect(seg!.endTime).toBeLessThan(8);
        }
    });

    it('prefers fileId over filePath when distinguishing files', async () => {
        // The production query supplies fileId; two rows can carry the same path
        // spelling while being different rows, and vice versa.
        const a = registerEpisode('key-a', { durationSeconds: 28, backgroundSeed: 21 });
        const b: EpisodeWithFile = { ...a, episodeId: 'key-b', title: 'key-b' };
        const res = await analyzeSeasonFingerprints(
            [
                { ...a, fileId: 'file-1' },
                { ...b, fileId: 'file-1' },
            ],
            '/tmp',
            baseConfig(),
            1,
            0,
        );
        expect(res.size).toBe(0);
    });
});

it('propagates timeouts for task backoff after in-flight fingerprint workers finish', async () => {
    const episodes = ['slow', 'in-flight', 'not-started-1', 'not-started-2'].map((id, i) =>
        registerEpisode(id, { durationSeconds: 90, backgroundSeed: i + 1 }),
    );
    const timeout = new FFmpegTimeoutError(300_000, '');
    let active = 0;
    mockFingerprint.mockImplementation(async (file: string) => {
        active++;
        await new Promise((resolve) => setTimeout(resolve, file === pathFor('slow') ? 10 : 30));
        active--;
        if (file === pathFor('slow')) throw timeout;
        return new Uint32Array(100);
    });
    await expect(analyzeSeasonFingerprints(episodes, '/tmp', baseConfig(), 2)).rejects.toBe(
        timeout,
    );
    expect(active).toBe(0);
    expect(mockFingerprint).toHaveBeenCalledTimes(2);
});

describe('fingerprint checkpoint boundaries', () => {
    const episode: EpisodeWithFile = {
        episodeId: 'invented-episode',
        title: 'The Lantern Atlas',
        seasonNumber: 1,
        episodeNumber: 1,
        filePath: '/invented.mkv',
        durationSeconds: 1200,
    };
    it('accepts the last successful extraction when its completion exhausts the budget', async () => {
        let yielded = false;
        mockFingerprint.mockImplementation(async () => {
            yielded = true;
            return new Uint32Array([1, 2, 3]);
        });
        const checkpoint = {
            shouldYield: () => yielded,
            load: vi.fn().mockResolvedValue(null),
            save: vi.fn().mockResolvedValue(undefined),
        };
        await expect(
            analyzeSeasonFingerprints(
                [episode],
                '/tmp',
                DEFAULT_CHROMAPRINT_CONFIG,
                1,
                1,
                undefined,
                checkpoint,
            ),
        ).resolves.toEqual(new Map());
        expect(checkpoint.save).toHaveBeenCalledTimes(1);
    });
    it('treats a checkpoint read error as a cache miss', async () => {
        mockFingerprint.mockResolvedValue(new Uint32Array([1, 2, 3]));
        const checkpoint = {
            load: vi.fn().mockRejectedValue(new Error('checkpoint unavailable')),
            save: vi.fn().mockResolvedValue(undefined),
        };
        await expect(
            analyzeSeasonFingerprints(
                [episode],
                '/tmp',
                DEFAULT_CHROMAPRINT_CONFIG,
                1,
                1,
                undefined,
                checkpoint,
            ),
        ).resolves.toEqual(new Map());
        expect(mockFingerprint).toHaveBeenCalled();
    });
});
