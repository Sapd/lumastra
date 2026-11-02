// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { PlaybackProgressSchema, buildPlaybackProgress, buildPlaybackProgressFromPercent } from './api-playback-progress.js';

describe('PlaybackProgress', () => {
    it('represents unknown progress explicitly', () => {
        expect(buildPlaybackProgress({})).toEqual({ positionMs: null, durationMs: null,
            fraction: null, finished: false, updatedAt: null });
        expect(PlaybackProgressSchema.meta()?.id).toBe('PlaybackProgress');
    });
    it('derives a clamped fraction without guessing completion', () => {
        expect(buildPlaybackProgress({ positionMs: 25, durationMs: 100 }).fraction).toBe(0.25);
        expect(buildPlaybackProgress({ positionMs: 125, durationMs: 100 }).fraction).toBe(1);
        expect(buildPlaybackProgress({ positionMs: -25, durationMs: 100 }).fraction).toBe(0);
        expect(buildPlaybackProgress({ positionMs: -25, durationMs: 100 }).positionMs).toBe(0);
        expect(buildPlaybackProgress({ positionMs: 100, durationMs: 100 }).finished).toBe(false);
    });
    it('honours explicit fractions and completion', () => {
        expect(buildPlaybackProgress({ positionMs: 25, durationMs: 100, fraction: 0,
            finished: true })).toMatchObject({ fraction: 1, finished: true });
        expect(buildPlaybackProgress({ finished: true })).toMatchObject({ fraction: 1, finished: true });
        expect(buildPlaybackProgress({ positionMs: 0, durationMs: null, finished: true }).fraction).toBe(1);
        expect(buildPlaybackProgress({ fraction: 2 }).fraction).toBe(1);
        expect(buildPlaybackProgress({ fraction: -1 }).fraction).toBe(0);
    });
    it.each([0, -1, null, undefined, NaN, Infinity])('does not divide by unknown/invalid duration %s', (durationMs) => {
        expect(buildPlaybackProgress({ positionMs: 10, durationMs }).fraction).toBeNull();
    });
    it('normalises milliseconds and timestamps into valid schema values', () => {
        const result = buildPlaybackProgress({ positionMs: 12.9, durationMs: Infinity,
            updatedAt: new Date('2026-10-17T12:00:00Z') });
        expect(result).toMatchObject({ positionMs: 12, durationMs: null, updatedAt: '2026-10-17T12:00:00.000Z' });
        expect(PlaybackProgressSchema.safeParse(result).success).toBe(true);
        expect(buildPlaybackProgress({ positionMs: NaN, updatedAt: 'invalid' }).updatedAt).toBeNull();
        expect(buildPlaybackProgress({ updatedAt: new Date(NaN) }).updatedAt).toBeNull();
    });
    it('converts source percentages without conflating ranking scores', () => {
        expect(buildPlaybackProgressFromPercent(25).fraction).toBe(0.25);
        expect(buildPlaybackProgressFromPercent(150).fraction).toBe(1);
        expect(buildPlaybackProgressFromPercent(-10).fraction).toBe(0);
        expect(buildPlaybackProgressFromPercent(null).fraction).toBeNull();
        expect(buildPlaybackProgressFromPercent(NaN).fraction).toBeNull();
        expect(buildPlaybackProgressFromPercent(0, { finished: true }).finished).toBe(true);
    });
    it.each([{ positionMs: 0.5 }, { durationMs: 0.5 }, { fraction: 1.1 },
        { fraction: -0.1 }, { updatedAt: '2026-10-17' }, { finished: null }])('rejects malformed wire fields %j', (fields) => {
        expect(PlaybackProgressSchema.safeParse({ ...buildPlaybackProgress({}), ...fields }).success).toBe(false);
    });
});
