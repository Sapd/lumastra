// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getSeasonColor, getUniqueSeasons } from './season-colors';

describe('season-colors', () => {
    describe('getSeasonColor', () => {
        it('returns different colors for different season numbers', () => {
            const color1 = getSeasonColor(1);
            const color2 = getSeasonColor(2);
            const color3 = getSeasonColor(3);

            expect(color1.hex).not.toBe(color2.hex);
            expect(color2.hex).not.toBe(color3.hex);
        });

        it('returns the first color for season 1', () => {
            const color = getSeasonColor(1);
            expect(color.hex).toBe('#60a5fa'); // blue
        });

        it('wraps around for seasons > 10', () => {
            const color1 = getSeasonColor(1);
            const color11 = getSeasonColor(11);
            expect(color1.hex).toBe(color11.hex);
        });

        it('wraps around for season 20', () => {
            const color10 = getSeasonColor(10);
            const color20 = getSeasonColor(20);
            expect(color10.hex).toBe(color20.hex);
        });

        it('handles season 0 by wrapping to last color', () => {
            const color0 = getSeasonColor(0);
            const color10 = getSeasonColor(10);
            expect(color0.hex).toBe(color10.hex);
        });

        it('handles negative season numbers gracefully', () => {
            const color = getSeasonColor(-1);
            // Should not throw and should return a valid color
            expect(color.hex).toBeTruthy();
            expect(color.bg).toBeTruthy();
            expect(color.text).toBeTruthy();
            expect(color.dot).toBeTruthy();
        });

        it('returns all expected properties', () => {
            const color = getSeasonColor(1);
            expect(color).toHaveProperty('bg');
            expect(color).toHaveProperty('text');
            expect(color).toHaveProperty('border');
            expect(color).toHaveProperty('hex');
            expect(color).toHaveProperty('dot');
        });
    });

    describe('getUniqueSeasons', () => {
        it('returns sorted unique season numbers', () => {
            const episodes = [
                { originalSeason: 3 },
                { originalSeason: 1 },
                { originalSeason: 2 },
                { originalSeason: 1 },
                { originalSeason: 3 },
            ];
            expect(getUniqueSeasons(episodes)).toEqual([1, 2, 3]);
        });

        it('returns empty array for empty input', () => {
            expect(getUniqueSeasons([])).toEqual([]);
        });

        it('handles single season', () => {
            const episodes = [{ originalSeason: 5 }, { originalSeason: 5 }, { originalSeason: 5 }];
            expect(getUniqueSeasons(episodes)).toEqual([5]);
        });

        it('handles non-contiguous seasons', () => {
            const episodes = [{ originalSeason: 1 }, { originalSeason: 5 }, { originalSeason: 10 }];
            expect(getUniqueSeasons(episodes)).toEqual([1, 5, 10]);
        });
    });
});
