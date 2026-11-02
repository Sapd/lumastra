// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    estimateWatchTogetherDrift,
    POSITION_SAMPLE_MAX_AGE_MS,
    projectPositionSample,
} from './watch-together-drift.js';

describe('watch-together drift estimation', () => {
    it('aligns staggered playing samples to one server time', () => {
        const now = 20_000;
        const estimate = estimateWatchTogetherDrift(
            [
                { position: 10, timestamp: 10_000, isHost: true },
                { position: 16, timestamp: 16_000, isHost: false },
            ],
            now,
            true,
            1,
        );

        expect(estimate.hostPosition).toBe(20);
        expect(estimate.maxDrift).toBe(0);
        expect(estimate.comparableGuests).toBe(1);
    });

    it('preserves genuine drift after timestamp alignment', () => {
        const estimate = estimateWatchTogetherDrift(
            [
                { position: 50, timestamp: 10_000, isHost: true },
                { position: 38, timestamp: 14_000, isHost: false },
            ],
            15_000,
            true,
            1,
        );

        expect(estimate.hostPosition).toBe(55);
        expect(estimate.maxDrift).toBe(16);
    });

    it('does not project paused samples', () => {
        const sample = { position: 42, timestamp: 1_000, isHost: true };
        expect(projectPositionSample(sample, 11_000, false, 1)).toBe(42);
    });

    it('projects at the session playback rate', () => {
        const sample = { position: 20, timestamp: 1_000, isHost: true };
        expect(projectPositionSample(sample, 5_000, true, 1.5)).toBe(26);
    });

    it('ignores stale and future-dated samples', () => {
        const now = 50_000;
        const estimate = estimateWatchTogetherDrift(
            [
                { position: 50, timestamp: now, isHost: true },
                {
                    position: 0,
                    timestamp: now - POSITION_SAMPLE_MAX_AGE_MS - 1,
                    isHost: false,
                },
                { position: 0, timestamp: now + 1, isHost: false },
            ],
            now,
            true,
            1,
        );

        expect(estimate.maxDrift).toBe(0);
        expect(estimate.comparableGuests).toBe(0);
    });

    it('requires a host sample before producing a comparison', () => {
        const estimate = estimateWatchTogetherDrift(
            [{ position: 10, timestamp: 1_000, isHost: false }],
            2_000,
            true,
            1,
        );

        expect(estimate).toEqual({
            hostPosition: null,
            maxDrift: 0,
            comparableGuests: 0,
        });
    });
});
