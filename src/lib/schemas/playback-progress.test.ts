// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildPlaybackProgress, PlaybackProgressSchema } from './playback-progress.js';

const base = { positionMs: 250, durationMs: 1000, finished: false, updatedAt: null };

describe('PlaybackProgress', () => {
    it('computes a fraction while preserving millisecond precision', () => {
        expect(PlaybackProgressSchema.parse(buildPlaybackProgress(base))).toEqual({
            ...base,
            fraction: 0.25,
        });
    });

    it.each([
        [null, 1000],
        [250, null],
        [250, 0],
        [250, -1],
    ])('uses null for an unknown fraction (%s / %s)', (positionMs, durationMs) => {
        expect(buildPlaybackProgress({ ...base, positionMs, durationMs }).fraction).toBeNull();
    });

    it.each([
        [-10, 0],
        [2000, 1],
    ])('clamps position %s to fraction %s', (positionMs, fraction) => {
        expect(buildPlaybackProgress({ ...base, positionMs }).fraction).toBe(fraction);
    });

    it('shows a completed item as finished even when its resume position was reset', () => {
        expect(buildPlaybackProgress({ ...base, positionMs: 0, finished: true }).fraction).toBe(1);
    });

    it('accepts ISO timestamps with offsets', () => {
        expect(
            PlaybackProgressSchema.safeParse({
                ...base,
                fraction: 0.25,
                updatedAt: '2026-10-16T12:00:00+02:00',
            }).success,
        ).toBe(true);
    });

    it.each([
        { positionMs: 1.5 },
        { durationMs: 1.5 },
        { fraction: -0.1 },
        { fraction: 1.1 },
        { updatedAt: 'yesterday' },
    ])('rejects invalid progress %j', (invalid) => {
        expect(
            PlaybackProgressSchema.safeParse({ ...base, fraction: 0.25, ...invalid }).success,
        ).toBe(false);
    });
});
