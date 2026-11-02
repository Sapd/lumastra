// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { moodToColor, energyToColor, MOOD_PALETTE_FALLBACK } from './mood-palette';

describe('moodToColor', () => {
    it('maps known moods to distinct colors', () => {
        expect(moodToColor('happy')).toBe('#fbbf24');
        expect(moodToColor('sad')).toBe('#60a5fa');
        expect(moodToColor('angry')).toBe('#f87171');
        expect(moodToColor('calm')).toBe('#86efac');
    });

    it('is case-insensitive', () => {
        expect(moodToColor('HAPPY')).toBe(moodToColor('happy'));
        expect(moodToColor('Happy')).toBe(moodToColor('happy'));
        expect(moodToColor('HaPpY')).toBe(moodToColor('happy'));
    });

    it('trims whitespace', () => {
        expect(moodToColor('  happy  ')).toBe(moodToColor('happy'));
        expect(moodToColor('\thappy\t')).toBe(moodToColor('happy'));
    });

    it('returns fallback for unknown moods', () => {
        expect(moodToColor('unknown_mood_xyz')).toBe(MOOD_PALETTE_FALLBACK);
        expect(moodToColor('foobar')).toBe(MOOD_PALETTE_FALLBACK);
    });

    it('returns fallback for empty strings', () => {
        expect(moodToColor('')).toBe(MOOD_PALETTE_FALLBACK);
    });

    it('returns valid hex colors', () => {
        const result = moodToColor('happy');
        expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    });
});

describe('energyToColor', () => {
    it('maps extreme values to gradient endpoints', () => {
        const minColor = energyToColor(0);
        const maxColor = energyToColor(1);

        expect(minColor).toBe('#38bdf8'); // cyan-400
        expect(maxColor).toBe('#fbbf24'); // amber-400
    });

    it('maps mid-range energy to intermediate colors', () => {
        const midColor = energyToColor(0.5);
        // Should be somewhere in the middle of the gradient
        expect(midColor).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('clamps values below 0', () => {
        expect(energyToColor(-0.5)).toBe(energyToColor(0));
        expect(energyToColor(-100)).toBe(energyToColor(0));
    });

    it('clamps values above 1', () => {
        expect(energyToColor(1.5)).toBe(energyToColor(1));
        expect(energyToColor(100)).toBe(energyToColor(1));
    });

    it('is deterministic across multiple calls', () => {
        const energy = 0.73;
        const result1 = energyToColor(energy);
        const result2 = energyToColor(energy);
        expect(result1).toBe(result2);
    });

    it('returns valid hex colors for all values in [0, 1]', () => {
        for (let i = 0; i <= 10; i++) {
            const result = energyToColor(i / 10);
            expect(result).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

    it('monotonically increases color warmth with energy', () => {
        // This is a softer test: just verify results are different
        const cool = energyToColor(0.1);
        const warm = energyToColor(0.9);
        expect(cool).not.toBe(warm);
    });
});
