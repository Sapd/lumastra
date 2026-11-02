// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    heightFromPositionY,
    positionYFromHeight,
    SUBTITLE_HEIGHT_MIN,
    SUBTITLE_HEIGHT_MAX,
} from './subtitle-preview-style';

describe('subtitle height <-> positionY', () => {
    it('round-trips every slider value', () => {
        for (let h = SUBTITLE_HEIGHT_MIN; h <= SUBTITLE_HEIGHT_MAX; h++) {
            expect(heightFromPositionY(positionYFromHeight(h))).toBe(h);
        }
    });

    it('a higher caption is a larger height (the slider no longer runs backwards)', () => {
        expect(heightFromPositionY(70)).toBeGreaterThan(heightFromPositionY(85));
    });

    // The schema allows positionY 0–100; the slider only shows 5–50.
    it('clamps a stored value the slider cannot show', () => {
        expect(heightFromPositionY(10)).toBe(SUBTITLE_HEIGHT_MAX);
        expect(heightFromPositionY(99)).toBe(SUBTITLE_HEIGHT_MIN);
    });
});
