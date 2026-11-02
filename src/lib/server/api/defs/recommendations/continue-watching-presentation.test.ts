// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ContinueWatchingItem } from '$lib/server/utils/section-builder.js';
import { presentContinueWatchingItem } from './continue-watching-presentation.js';

const baseItem: ContinueWatchingItem = {
    id: 'item-1',
    title: 'Item',
    mediaType: 'movie',
    watchProgress: 40,
    duration: 1000,
    externalIds: { internal: 'item-1' },
};

describe('presentContinueWatchingItem', () => {
    it.each([
        ['movie', 'movie', ['poster', 'backdrop', 'thumb']],
        ['tv', 'series', ['poster', 'backdrop', 'thumb']],
        ['episode', 'episode', ['poster', 'backdrop', 'thumb']],
        ['audiobook', 'audiobook', ['poster']],
    ] as const)('maps %s to %s with the valid image roles', (rawType, publicType, roles) => {
        const result = presentContinueWatchingItem({ ...baseItem, mediaType: rawType });

        expect(result?.publicType).toBe(publicType);
        expect(result?.imageRoles).toEqual(roles);
    });

    it('clamps progress and position to the runtime', () => {
        const result = presentContinueWatchingItem({
            ...baseItem,
            watchProgress: 140,
            resumeRatio: 1.4,
        });

        expect(result?.progress.fraction).toBe(1);
        expect(result?.progress.durationMs).toBe(1000000);
        expect(result?.progress.positionMs).toBe(1000000);
    });

    it('preserves millisecond positions without seconds rounding', () => {
        const result = presentContinueWatchingItem({
            ...baseItem,
            duration: 60.001,
            resumePositionSeconds: 12.345,
        });
        expect(result?.progress).toMatchObject({ positionMs: 12345, durationMs: 60001 });
    });

    it('derives progress from the precise position and keeps the activity timestamp', () => {
        const result = presentContinueWatchingItem({
            ...baseItem,
            duration: 1000.123,
            resumePositionSeconds: 400.456,
            updatedAt: '2026-10-16T12:00:00.000Z',
        });
        expect(result?.progress).toEqual({
            positionMs: 400456,
            durationMs: 1000123,
            fraction: 400456 / 1000123,
            finished: false,
            updatedAt: '2026-10-16T12:00:00.000Z',
        });
        expect(result?.lastPlayedAt).toBe('2026-10-16T12:00:00.000Z');
        expect(result).not.toHaveProperty('score');
        expect(result).not.toHaveProperty('positionSeconds');
        expect(result).not.toHaveProperty('durationSeconds');
    });

    it('drops internal media types without a public card contract', () => {
        expect(presentContinueWatchingItem({ ...baseItem, mediaType: 'tvchannel' })).toBeNull();
    });
});
