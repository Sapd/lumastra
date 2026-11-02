// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rolling-hour cap on how many artwork files the backfill materializes.
 * Cross-replica, so it lives in Valkey rather than in-process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsValkeyReady, mockIncr, mockExpire, mockCacheGet } = vi.hoisted(() => ({
    mockIsValkeyReady: vi.fn(),
    mockIncr: vi.fn(),
    mockExpire: vi.fn(),
    mockCacheGet: vi.fn(),
}));

vi.mock('../cache/valkey.js', () => ({
    isValkeyReady: mockIsValkeyReady,
    incr: mockIncr,
    expire: mockExpire,
    cacheGet: mockCacheGet,
}));

import {
    artworkBudgetKey,
    consumeArtworkBudget,
    peekArtworkBudget,
} from './artwork-rate-budget.js';

const HOUR = 3_600_000;

describe('artworkBudgetKey', () => {
    it('is versioned and bucketed by the wall-clock hour', () => {
        expect(artworkBudgetKey(0)).toBe('v1:artwork-backfill:budget:0');
        expect(artworkBudgetKey(HOUR * 5 + 123)).toBe('v1:artwork-backfill:budget:5');
    });
});

describe('consumeArtworkBudget', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsValkeyReady.mockReturnValue(true);
        mockExpire.mockResolvedValue(true);
    });

    it('treats maxPerHour <= 0 as unlimited and never touches Valkey', async () => {
        expect(await consumeArtworkBudget(0, HOUR)).toBe(true);
        expect(await consumeArtworkBudget(-1, HOUR)).toBe(true);
        expect(mockIncr).not.toHaveBeenCalled();
    });

    it('allows while the counter is within the cap', async () => {
        mockIncr.mockResolvedValue(7);

        expect(await consumeArtworkBudget(10, HOUR)).toBe(true);
        expect(mockIncr).toHaveBeenCalledWith('v1:artwork-backfill:budget:1');
    });

    it('sets a TTL exactly once, on the first increment of the bucket', async () => {
        mockIncr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

        await consumeArtworkBudget(10, HOUR);
        await consumeArtworkBudget(10, HOUR);

        expect(mockExpire).toHaveBeenCalledTimes(1);
        expect(mockExpire).toHaveBeenCalledWith('v1:artwork-backfill:budget:1', 7200);
    });

    it('denies once the counter exceeds the cap', async () => {
        mockIncr.mockResolvedValue(11);

        expect(await consumeArtworkBudget(10, HOUR)).toBe(false);
    });

    it('allows exactly at the cap boundary', async () => {
        mockIncr.mockResolvedValue(10);

        expect(await consumeArtworkBudget(10, HOUR)).toBe(true);
    });

    it('fails OPEN when Valkey is not ready', async () => {
        mockIsValkeyReady.mockReturnValue(false);

        expect(await consumeArtworkBudget(10, HOUR)).toBe(true);
        expect(mockIncr).not.toHaveBeenCalled();
    });

    it('fails OPEN when INCR throws', async () => {
        mockIncr.mockRejectedValue(new Error('connection reset'));

        expect(await consumeArtworkBudget(10, HOUR)).toBe(true);
    });
});

describe('peekArtworkBudget', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsValkeyReady.mockReturnValue(true);
    });

    it('returns the current bucket count without incrementing', async () => {
        mockCacheGet.mockResolvedValue('42');

        expect(await peekArtworkBudget(HOUR)).toBe(42);
        expect(mockIncr).not.toHaveBeenCalled();
    });

    it('returns 0 for an unset or unparseable bucket', async () => {
        mockCacheGet.mockResolvedValue(null);
        expect(await peekArtworkBudget(HOUR)).toBe(0);

        mockCacheGet.mockResolvedValue('not-a-number');
        expect(await peekArtworkBudget(HOUR)).toBe(0);
    });
});
