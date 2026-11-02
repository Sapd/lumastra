// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { gpuHistorySegments, gpuMeterPercent, appendGpuHistory } from './gpu-history.js';

describe('GPU activity history', () => {
    it('missing telemetry creates gaps between measured activity and observed zero', () => {
        const segments = gpuHistorySegments([45, 70, null, 0, null], 5);
        expect(segments).toEqual([
            { points: '0.00,55.00 25.00,30.00', firstX: 0, firstY: 55, count: 2 },
            { points: '75.00,100.00', firstX: 75, firstY: 100, count: 1 },
        ]);
    });
    it('never draws unmeasured or non-finite values as zero', () => {
        expect(gpuHistorySegments([null, Number.NaN, null], 40)).toEqual([]);
    });
    it('clamps drawing coordinates and meters while leaving the raw values intact', () => {
        expect(gpuMeterPercent(-20)).toBe(0);
        expect(gpuMeterPercent(150)).toBe(100);
        expect(gpuHistorySegments([-10, 150], 2)[0].points).toBe('0.00,100.00 100.00,0.00');
    });
});

describe('GPU history retention and time', () => {
    it('retains exactly the latest 40 samples in order', () => {
        let state = appendGpuHistory(undefined, 'a', 0, 0);
        for (let i = 1; i < 55; i++) state = appendGpuHistory(state, 'a', i * 10_000, i);
        expect(state.values).toEqual(Array.from({ length: 40 }, (_, i) => i + 15));
        expect(gpuHistorySegments(state.values, 40)[0].firstX).toBe(0);
    });
    it('right-aligns a partially filled window and resets it when the host changes', () => {
        const first = appendGpuHistory(undefined, 'a', 0, 20);
        const next = appendGpuHistory(first, 'a', 10_000, 30);
        expect(gpuHistorySegments(next.values, 40)[0].points).toBe('97.44,80.00 100.00,70.00');
        const reset = appendGpuHistory(next, 'b', 500_000, 50);
        expect(reset.values).toEqual([50]);
        expect(gpuHistorySegments(reset.values, 40)[0].firstX).toBe(100);
    });
    it('bounds a long failure gap to the same 40-point window', () => {
        const first = appendGpuHistory(undefined, 'a', 0, 20);
        const recovered = appendGpuHistory(first, 'a', 4_000_000, 80);
        expect(recovered.values).toEqual([...Array.from({ length: 39 }, () => null), 80]);
    });
});
