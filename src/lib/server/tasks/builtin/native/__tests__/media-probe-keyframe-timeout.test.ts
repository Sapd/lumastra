// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `keyframeTimeoutForSize` — the size-scaled keyframe-probe
 * timeout. A 50 GB 4K remux can't be packet-scanned inside the 120 s base, so
 * the timeout scales with file size (capped). Before this, such files timed out
 * on every attempt and looped forever (observed at attempt 637).
 */
import { describe, it, expect } from 'vitest';
import { keyframeTimeoutForSize } from '../media-probe.js';

const GB = 1_000_000_000;
const BASE = 120_000;
const CAP = 900_000;

describe('keyframeTimeoutForSize', () => {
    it('falls back to the 120 s base when size is unknown / zero / negative / non-finite', () => {
        expect(keyframeTimeoutForSize(null)).toBe(BASE);
        expect(keyframeTimeoutForSize(undefined)).toBe(BASE);
        expect(keyframeTimeoutForSize(0)).toBe(BASE);
        expect(keyframeTimeoutForSize(-5)).toBe(BASE);
        expect(keyframeTimeoutForSize(Number.NaN)).toBe(BASE);
        expect(keyframeTimeoutForSize(Number.POSITIVE_INFINITY)).toBe(BASE);
    });

    it('scales above the base for large files (+20 s/GB)', () => {
        // 8 GB → 120s + 8*20s = 280s.
        expect(keyframeTimeoutForSize(8 * GB)).toBe(280_000);
        // A small file stays near the base.
        expect(keyframeTimeoutForSize(GB)).toBe(140_000);
    });

    it('caps the timeout so one pathological file cannot hold a slot forever', () => {
        // 50 GB would compute 1,120,000ms but is clamped to the 15 min cap.
        expect(keyframeTimeoutForSize(50 * GB)).toBe(CAP);
        expect(keyframeTimeoutForSize(500 * GB)).toBe(CAP);
    });

    it('is monotonic in size', () => {
        const sizes = [GB, 5 * GB, 10 * GB, 40 * GB, 80 * GB];
        const timeouts = sizes.map(keyframeTimeoutForSize);
        for (let i = 1; i < timeouts.length; i++) {
            expect(timeouts[i]).toBeGreaterThanOrEqual(timeouts[i - 1]);
        }
    });
});
