// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The wait between resends to a busy sonic sidecar (HTTP 429 from its memory gate).
 * The clamp keeps a broken or hostile Retry-After from hot-looping the sidecar (too
 * short) or holding a task slot past the total wait budget (too long).
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    busyRetryAfterMs,
    SIDECAR_BUSY_MAX_WAIT_MS,
    sleepUnlessAborted,
} from './sonic-task-shared.js';

describe('busyRetryAfterMs', () => {
    test('uses Retry-After seconds inside 5 s .. 2 min', () => {
        expect(busyRetryAfterMs('10')).toBe(10_000);
        expect(busyRetryAfterMs('120')).toBe(120_000);
    });

    test('clamps too short and too long values', () => {
        expect(busyRetryAfterMs('1')).toBe(5_000);
        expect(busyRetryAfterMs('9999')).toBe(120_000);
    });

    test('falls back to 30 s for a missing, zero or non-numeric header', () => {
        expect(busyRetryAfterMs(null)).toBe(30_000);
        expect(busyRetryAfterMs('0')).toBe(30_000);
        expect(busyRetryAfterMs('abc')).toBe(30_000);
        expect(busyRetryAfterMs('-5')).toBe(30_000);
    });

    test('one wait never exceeds the total budget', () => {
        expect(busyRetryAfterMs('9999')).toBeLessThan(SIDECAR_BUSY_MAX_WAIT_MS);
    });
});

describe('sleepUnlessAborted', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('resolves true after the wait', async () => {
        vi.useFakeTimers();
        const done = sleepUnlessAborted(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await done).toBe(true);
    });

    test('resolves false at once on abort, and immediately when already aborted', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const done = sleepUnlessAborted(60_000, controller.signal);
        controller.abort();
        expect(await done).toBe(false);
        expect(await sleepUnlessAborted(60_000, controller.signal)).toBe(false);
    });
});
