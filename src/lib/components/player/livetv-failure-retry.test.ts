// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    LIVETV_FAILURE_MAX_AUTO_RETRIES,
    LIVETV_FAILURE_MAX_DELAY_MS,
    liveTvRetryDelayMs,
    nextLiveTvRetry,
    nextStationId,
} from './livetv-failure-retry.js';

describe('liveTvRetryDelayMs', () => {
    it('backs off 2, 4, 8, 16 seconds without a server hint', () => {
        expect([1, 2, 3, 4].map((n) => liveTvRetryDelayMs(n))).toEqual([2000, 4000, 8000, 16000]);
    });

    it('takes the larger of retryAfterMs and the backoff', () => {
        expect(liveTvRetryDelayMs(1, 10_000)).toBe(10_000);
        expect(liveTvRetryDelayMs(4, 10_000)).toBe(16_000);
        expect(liveTvRetryDelayMs(2, 3_000)).toBe(4_000);
    });

    it('never waits more than 30 seconds', () => {
        expect(liveTvRetryDelayMs(1, 120_000)).toBe(LIVETV_FAILURE_MAX_DELAY_MS);
        expect(liveTvRetryDelayMs(10)).toBe(LIVETV_FAILURE_MAX_DELAY_MS);
    });

    it('treats attempt 0 like attempt 1', () => {
        expect(liveTvRetryDelayMs(0)).toBe(2000);
    });
});

describe('nextLiveTvRetry', () => {
    it('never retries a failure that is not retryable', () => {
        expect(nextLiveTvRetry({ retryable: false, retryAfterMs: 1000 }, 0)).toBeNull();
    });

    it('numbers the attempts and allows four', () => {
        expect(nextLiveTvRetry({ retryable: true }, 0)).toEqual({ attempt: 1, delayMs: 2000 });
        expect(nextLiveTvRetry({ retryable: true }, 3)).toEqual({ attempt: 4, delayMs: 16000 });
        expect(LIVETV_FAILURE_MAX_AUTO_RETRIES).toBe(4);
    });

    it('stops after the budget', () => {
        expect(nextLiveTvRetry({ retryable: true }, 4)).toBeNull();
        expect(nextLiveTvRetry({ retryable: true }, 9)).toBeNull();
    });

    it('honours retryAfterMs for the first attempt', () => {
        expect(nextLiveTvRetry({ retryable: true, retryAfterMs: 30_000 }, 0)).toEqual({
            attempt: 1,
            delayMs: 30_000,
        });
    });
});

describe('nextStationId', () => {
    const stations = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    it('steps to the next station and wraps', () => {
        expect(nextStationId(stations, 'a')).toBe('b');
        expect(nextStationId(stations, 'c')).toBe('a');
    });
    it('starts at the first station when the current one is not in the lineup', () => {
        expect(nextStationId(stations, 'zzz')).toBe('a');
    });
    it('has no other station to offer in a lineup of one or none', () => {
        expect(nextStationId([{ id: 'a' }], 'a')).toBeUndefined();
        expect(nextStationId([], 'a')).toBeUndefined();
    });
});
