// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { lumaStats, edgeDensity, colorfulness, scoreFrame, luma } from './frame-metrics.js';

const W = 64;
const H = 36;

function grey(fill: (x: number, y: number) => number): Uint8Array {
    const b = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) b[y * W + x] = fill(x, y) & 0xff;
    return b;
}
function rgb(fill: (x: number, y: number) => [number, number, number]): Uint8Array {
    const b = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const [r, g, bl] = fill(x, y);
            const i = (y * W + x) * 3;
            b[i] = r;
            b[i + 1] = g;
            b[i + 2] = bl;
        }
    return b;
}

const NEUTRAL_RGB = rgb(() => [120, 120, 120]);

describe('luma', () => {
    it('uses Rec.709 weights', () => {
        expect(luma(255, 255, 255)).toBeCloseTo(255, 3);
        expect(luma(0, 0, 0)).toBe(0);
        expect(luma(255, 0, 0)).toBeCloseTo(54.213, 2);
    });
});

describe('lumaStats', () => {
    it('handles an empty buffer without dividing by zero', () => {
        expect(lumaStats(new Uint8Array(0))).toEqual({
            mean: 0,
            stddev: 0,
            p05: 0,
            p95: 0,
            entropy: 0,
        });
    });

    it('reports a flat frame as zero-variance, zero-entropy', () => {
        const s = lumaStats(grey(() => 100));
        expect(s.mean).toBe(100);
        expect(s.stddev).toBeCloseTo(0, 6);
        expect(s.entropy).toBeCloseTo(0, 6);
    });

    it('uses percentiles so one bright pixel cannot fake contrast', () => {
        const b = grey(() => 10);
        b[0] = 255; // single specular highlight
        const s = lumaStats(b);
        expect(s.p95).toBeLessThan(50); // min/max would have said 255
    });
});

describe('edgeDensity', () => {
    it('is ~0 for a flat frame', () => {
        expect(
            edgeDensity(
                grey(() => 128),
                W,
                H,
            ),
        ).toBeCloseTo(0, 6);
    });

    it('is high for a hard-edged pattern', () => {
        expect(
            edgeDensity(
                grey((x) => ((x >> 2) % 2 ? 255 : 0)),
                W,
                H,
            ),
        ).toBeGreaterThan(0.2);
    });

    it('degrades safely on a degenerate size', () => {
        expect(edgeDensity(new Uint8Array(4), 2, 2)).toBe(0);
    });
});

describe('colorfulness', () => {
    it('is low for greyscale and higher for saturated colour', () => {
        const flat = colorfulness(rgb(() => [120, 120, 120]));
        const vivid = colorfulness(rgb((x) => (x % 2 ? [255, 0, 0] : [0, 0, 255])));
        expect(flat).toBeLessThan(1);
        expect(vivid).toBeGreaterThan(flat);
    });

    it('returns 0 for an empty buffer', () => {
        expect(colorfulness(new Uint8Array(0))).toBe(0);
    });
});

describe('scoreFrame — rejection of the MEASURED failure modes', () => {
    // These are the modes actually observed sampling six real TNG S3 episodes
    // at the shipped 10% offset: two near-black starfields out of six.
    it('rejects a near-black frame', () => {
        const r = scoreFrame({ grey: grey(() => 4), width: W, height: H, rgb: NEUTRAL_RGB });
        expect(r.rejected).toBe(true);
        expect(r.reason).toBe('near-black');
    });

    it('rejects a blown-out frame', () => {
        const r = scoreFrame({ grey: grey(() => 250), width: W, height: H, rgb: NEUTRAL_RGB });
        expect(r.rejected).toBe(true);
        expect(r.reason).toBe('blown-out');
    });

    it('rejects a flat frame', () => {
        const r = scoreFrame({ grey: grey(() => 128), width: W, height: H, rgb: NEUTRAL_RGB });
        expect(r.rejected).toBe(true);
    });

    it('accepts a detailed, well-exposed frame', () => {
        const r = scoreFrame({
            grey: grey((x, y) => (x * 7 + y * 13) % 256),
            width: W,
            height: H,
            rgb: rgb((x, y) => [(x * 9) % 256, (y * 5) % 256, (x + y) % 256]),
        });
        expect(r.rejected).toBe(false);
        expect(r.score).toBeGreaterThan(0.3);
    });

    it('darkTolerant lowers the floor for dark-graded content', () => {
        const dark = grey((x, y) => ((x + y) % 2 ? 16 : 8));
        expect(scoreFrame({ grey: dark, width: W, height: H, rgb: NEUTRAL_RGB }).reason).toBe(
            'near-black',
        );
        const tolerant = scoreFrame({
            grey: dark,
            width: W,
            height: H,
            rgb: NEUTRAL_RGB,
            darkTolerant: true,
        });
        expect(tolerant.reason).not.toBe('near-black');
    });

    it('always returns a usable score so an episode is never left blank', () => {
        const r = scoreFrame({ grey: grey(() => 0), width: W, height: H, rgb: NEUTRAL_RGB });
        expect(r.rejected).toBe(true);
        expect(Number.isFinite(r.score)).toBe(true);
        expect(r.score).toBeGreaterThanOrEqual(0);
    });
});

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Calibration record — measured against real production frames extracted from
 * Star Harbor: NG S3 on 2026-07-20 (six episodes at the shipped 10% offset):
 *
 *   e1 starfield                 0.000  rejected near-black
 *   e2 "MICHAEL DORN" title card 0.053  rejected near-black
 *   e3 corridor                  0.857  best
 *   e4 village exterior          0.624
 *   e5 Troi + Picard             0.563
 *   e6 starfield                 0.000  rejected near-black
 *   E26 "Line Producer" card     0.602  NOT rejected
 *
 * All three known-bad frames were rejected and all three known-good frames
 * ranked above them, which is the bar this scorer has to clear.
 *
 * The E26 credit card is the honest limit: it is well lit and detailed, so no
 * cheap pixel statistic rejects it. It is excluded STRUCTURALLY instead — the
 * new window puts the act-one credit period out of reach (see
 * frame-window.test.ts). Do not "fix" that by bolting on a text detector
 * without field evidence that title cards are surviving the window.
 */
describe('calibration invariants', () => {
    it('ranks a detailed frame above a dark low-detail one', () => {
        const good = scoreFrame({
            grey: grey((x, y) => (x * 7 + y * 13) % 256),
            width: W,
            height: H,
            rgb: rgb((x, y) => [(x * 9) % 256, (y * 5) % 256, (x + y) % 256]),
        });
        const dim = scoreFrame({
            grey: grey((x, y) => ((x + y) % 3 === 0 ? 40 : 22)),
            width: W,
            height: H,
            rgb: NEUTRAL_RGB,
        });
        expect(good.score).toBeGreaterThan(dim.score);
    });
});
