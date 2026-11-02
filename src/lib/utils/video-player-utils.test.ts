// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    calculateResumePosition,
    calculateSmartPreviewPosition,
    PREVIEW_FALLBACK_START_SECONDS,
} from './video-player-utils';

describe('video-player-utils', () => {
    describe('calculateResumePosition', () => {
        it('uses watch progress when available', () => {
            expect(calculateResumePosition(25, 120, 5)).toBe(1800);
        });

        it('falls back when no progress is available', () => {
            expect(calculateResumePosition(undefined, 120, 5)).toBe(5);
        });
    });

    describe('calculateSmartPreviewPosition', () => {
        it('keeps resume progress as the preview start for in-progress items', () => {
            expect(
                calculateSmartPreviewPosition({
                    progress: 50,
                    runtimeMinutes: 90,
                    itemKey: 'movie-a',
                    fallbackSeconds: 30,
                }),
            ).toBe(2700);
        });

        it('uses a deterministic mid-content offset for unwatched movies', () => {
            const start = calculateSmartPreviewPosition({
                runtimeMinutes: 120,
                itemKey: 'movie-a',
                fallbackSeconds: 30,
            });

            expect(start).toBeGreaterThanOrEqual(864);
            expect(start).toBeLessThanOrEqual(6120);
            expect(start).toBe(
                calculateSmartPreviewPosition({
                    runtimeMinutes: 120,
                    itemKey: 'movie-a',
                    fallbackSeconds: 30,
                }),
            );
        });

        it('uses the fallback when runtime is unavailable', () => {
            expect(
                calculateSmartPreviewPosition({
                    itemKey: 'movie-a',
                    fallbackSeconds: 30,
                }),
            ).toBe(30);
        });

        it('defaults past the studio-logo window when runtime is unavailable', () => {
            // Regression: the old default of 30s landed inside distributor
            // logo cards, which routinely run 30-90s on movies.
            expect(
                calculateSmartPreviewPosition({
                    itemKey: 'movie-a',
                }),
            ).toBe(PREVIEW_FALLBACK_START_SECONDS);
            expect(PREVIEW_FALLBACK_START_SECONDS).toBeGreaterThanOrEqual(90);
        });
    });
});
