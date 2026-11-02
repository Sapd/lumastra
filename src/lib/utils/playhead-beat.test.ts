// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { playheadBeatStrength, validBeatGrid } from './playhead-beat';

describe('playhead beat timing', () => {
    it('uses seconds from the analyzed grid ahead of BPM and decays after each beat', () => {
        const grid = validBeatGrid([0.3, 0.8, 1.4]);
        expect(playheadBeatStrength(299, grid, 120)).toBe(0);
        expect(playheadBeatStrength(300, grid, 120)).toBe(1);
        expect(playheadBeatStrength(410, grid, 120)).toBeCloseTo(0.5);
        expect(playheadBeatStrength(600, grid, 120)).toBe(0);
        expect(playheadBeatStrength(800, grid, 120)).toBe(1);
        expect(playheadBeatStrength(1650, grid, 120)).toBe(0);
    });
    it('immediately follows backward and forward seeks and replacement timing', () => {
        const grid = validBeatGrid([0, 1, 2]);
        expect(playheadBeatStrength(2050, grid)).toBeGreaterThan(0);
        expect(playheadBeatStrength(1500, grid)).toBe(0);
        expect(playheadBeatStrength(1000, grid)).toBe(1);
        expect(playheadBeatStrength(1000, validBeatGrid([0.5, 1.5]))).toBe(0);
    });
    it('uses only finite positive BPM when a valid grid is unavailable', () => {
        for (const grid of [undefined, [], [NaN], [-1], [1, 0], [0, 0], [Infinity]]) {
            expect(validBeatGrid(grid)).toBeNull();
            expect(playheadBeatStrength(500, validBeatGrid(grid), 120)).toBe(1);
        }
        for (const bpm of [undefined, 0, -1, NaN, Infinity, Number.MIN_VALUE]) {
            expect(playheadBeatStrength(500, null, bpm)).toBe(0);
        }
        expect(playheadBeatStrength(750, null, 120)).toBe(0);
        expect(playheadBeatStrength(NaN, null, 120)).toBe(0);
        expect(playheadBeatStrength(-50, null, 120)).toBe(0);
    });
    it('continues a 500-beat analyzed prefix with BPM anchored to its final beat', () => {
        const grid = validBeatGrid(Array.from({ length: 500 }, (_, i) => 0.25 + i * 0.5));
        expect(playheadBeatStrength(300250, grid, 120)).toBe(1);
        expect(playheadBeatStrength(300360, grid, 120)).toBeCloseTo(0.5);
        expect(playheadBeatStrength(300500, grid, 120)).toBe(0);
        expect(playheadBeatStrength(300000, grid, 120)).toBe(0);
        for (const bpm of [undefined, 0, -1, NaN, Infinity, Number.MIN_VALUE]) {
            expect(playheadBeatStrength(249750, grid, bpm)).toBe(1);
            expect(playheadBeatStrength(249860, grid, bpm)).toBeCloseTo(0.5);
            expect(playheadBeatStrength(300250, grid, bpm)).toBe(0);
        }
    });
    it('always returns finite strength when beat duration underflows or timing is extreme', () => {
        for (const [position, grid, bpm] of [
            [0, validBeatGrid([0, Number.MIN_VALUE]), undefined],
            [0, validBeatGrid([0, 1e-323]), undefined],
            [0, null, Number.MAX_VALUE],
            [Number.MAX_VALUE, validBeatGrid([0, 1]), 120],
            [1000, validBeatGrid([0, 1]), Number.MIN_VALUE],
        ] as const) {
            const strength = playheadBeatStrength(position, grid, bpm);
            expect(Number.isFinite(strength)).toBe(true);
            expect(strength).toBeGreaterThanOrEqual(0);
            expect(strength).toBeLessThanOrEqual(1);
        }
        expect(playheadBeatStrength(0, validBeatGrid([0, Number.MIN_VALUE]))).toBe(0);
    });
});
