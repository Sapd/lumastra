// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { calculateSubtitleOverlayFontSize } from './subtitle-utils';

describe('calculateSubtitleOverlayFontSize', () => {
    it('keeps the existing 16px floor outside portrait layouts', () => {
        expect(calculateSubtitleOverlayFontSize(360, 640, false, 1, 1.2)).toBe(16);
    });

    it('uses a readable width-based floor on a portrait phone', () => {
        expect(calculateSubtitleOverlayFontSize(360, 393, true, 1, 1.2)).toBe(24);
    });

    it('bounds the portrait floor on narrow and tablet-sized viewports', () => {
        expect(calculateSubtitleOverlayFontSize(360, 320, true, 1, 1.2)).toBe(22);
        expect(calculateSubtitleOverlayFontSize(360, 768, true, 1, 1.2)).toBe(28);
    });

    it('still honors a larger user-selected subtitle size', () => {
        expect(calculateSubtitleOverlayFontSize(1080, 393, true, 1.5, 1.2)).toBe(50);
    });

    it.each([
        [720, 22],
        [1080, 34],
        [2160, 67],
    ])('preserves default overlay sizing at %ipx rendered height', (height, expected) => {
        expect(calculateSubtitleOverlayFontSize(height, 1920, false, 1, 1.2, 140)).toBe(expected);
    });

    it('normalizes server SRT scaling relative to the existing default', () => {
        expect(calculateSubtitleOverlayFontSize(1080, 1920, false, 1, 1.2, 280)).toBe(67);
        expect(calculateSubtitleOverlayFontSize(1080, 1920, false, 1, 1.2, 70)).toBe(17);
    });

    it.each([NaN, Infinity, -1, 0])('defaults invalid SRT scale %s safely', (scale) => {
        expect(calculateSubtitleOverlayFontSize(1080, 1920, false, 1, 1.2, scale)).toBe(34);
    });

    it('keeps invalid geometry and settings finite', () => {
        expect(calculateSubtitleOverlayFontSize(NaN, NaN, true, NaN, NaN, NaN)).toBe(22);
        expect(
            calculateSubtitleOverlayFontSize(Infinity, Infinity, false, Infinity, Infinity),
        ).toBe(16);
        expect(calculateSubtitleOverlayFontSize(-100, -100, true, -1, -1)).toBe(22);
        expect(
            calculateSubtitleOverlayFontSize(Number.MAX_VALUE, 393, true, Number.MAX_VALUE, 1.2),
        ).toBe(24);
    });
});
