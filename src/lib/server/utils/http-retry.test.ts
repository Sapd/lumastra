// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for http-retry.ts.
 *
 * All timing is injected via the `sleep` option so no fake timers are needed.
 * parseRetryAfterHeader tests are purely synchronous.
 *
 * Run: npx vitest run src/lib/server/utils/http-retry.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { parseRetryAfterHeader, withHttpRetry } from './http-retry.js';

// ── parseRetryAfterHeader ─────────────────────────────────────────────────────

describe('parseRetryAfterHeader', () => {
    const NOW = 1_700_000_000_000; // fixed reference point

    // Null / empty input
    it('returns null for null input', () => {
        expect(parseRetryAfterHeader(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(parseRetryAfterHeader(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(parseRetryAfterHeader('')).toBeNull();
    });

    it('returns null for whitespace-only string', () => {
        expect(parseRetryAfterHeader('   ')).toBeNull();
    });

    // Delta-seconds (integer only per RFC 9110)
    it('parses integer delta-seconds "0" to 0 ms', () => {
        expect(parseRetryAfterHeader('0', NOW)).toBe(0);
    });

    it('parses integer delta-seconds "30" to 30000 ms', () => {
        expect(parseRetryAfterHeader('30', NOW)).toBe(30_000);
    });

    it('parses integer delta-seconds "60" to 60000 ms (at cap)', () => {
        expect(parseRetryAfterHeader('60', NOW)).toBe(60_000);
    });

    it('caps delta-seconds above 60 s to RETRY_AFTER_CAP_MS (60000)', () => {
        expect(parseRetryAfterHeader('120', NOW)).toBe(60_000);
    });

    it('caps large delta-seconds to RETRY_AFTER_CAP_MS', () => {
        expect(parseRetryAfterHeader('9999', NOW)).toBe(60_000);
    });

    // Strict integer — exotic numeric forms must NOT be parsed as delta-seconds
    it('does not accept "1e3" as delta-seconds (falls through to HTTP-date, returns null)', () => {
        // '1e3' is not /^\d+$/ so it goes to Date.parse which also fails → null
        expect(parseRetryAfterHeader('1e3', NOW)).toBeNull();
    });

    it('does not accept "0x10" as delta-seconds', () => {
        expect(parseRetryAfterHeader('0x10', NOW)).toBeNull();
    });

    it('does not accept "  5 " with leading/trailing spaces as delta-seconds (trim then test)', () => {
        // After trimmed, "5" matches /^\d+$/ → 5000 ms
        expect(parseRetryAfterHeader('  5 ', NOW)).toBe(5_000);
    });

    it('does not accept "5.5" as delta-seconds — falls through to Date.parse which returns 0 (epoch)', () => {
        // '5.5' fails /^\d+$/, Date.parse('5.5') parses as a tiny timestamp
        // well in the past → Math.max(0, tinyMs - NOW) = 0, not null.
        const result = parseRetryAfterHeader('5.5', NOW);
        expect(result).toBe(0);
    });

    it('does not accept "-1" as delta-seconds — Date.parse("-1") is 1ms before epoch → clamped to 0', () => {
        // '-1' fails /^\d+$/, Date.parse('-1') = -1 (valid finite date)
        // Math.max(0, -1 - NOW) = 0
        const result = parseRetryAfterHeader('-1', NOW);
        expect(result).toBe(0);
    });

    // HTTP-date parsing
    it('parses an HTTP-date in the future and returns capped ms delay', () => {
        // NOW + 30 seconds as HTTP-date
        const future = new Date(NOW + 30_000).toUTCString();
        const result = parseRetryAfterHeader(future, NOW);
        expect(result).toBe(30_000);
    });

    it('caps an HTTP-date more than 60 s in the future to RETRY_AFTER_CAP_MS', () => {
        const future = new Date(NOW + 90_000).toUTCString();
        const result = parseRetryAfterHeader(future, NOW);
        expect(result).toBe(60_000);
    });

    it('returns 0 (not negative) for an HTTP-date in the past', () => {
        const past = new Date(NOW - 5_000).toUTCString();
        const result = parseRetryAfterHeader(past, NOW);
        expect(result).toBe(0);
    });

    it('returns null for an unparseable non-integer non-date string', () => {
        expect(parseRetryAfterHeader('junk', NOW)).toBeNull();
    });

    it('returns null for "NaN"', () => {
        expect(parseRetryAfterHeader('NaN', NOW)).toBeNull();
    });
});

// ── withHttpRetry ─────────────────────────────────────────────────────────────

/** No-op sleep that records how long it was asked to sleep. */
function makeSleep() {
    const calls: number[] = [];
    const sleep = vi.fn(async (ms: number): Promise<void> => {
        calls.push(ms);
    });
    return { sleep, calls };
}

const retryable = { retryable: true, retryAfterMs: null } as const;
const notRetryable = { retryable: false, retryAfterMs: null } as const;

describe('withHttpRetry', () => {
    // Success path
    it('returns the resolved value on first attempt', async () => {
        const { sleep } = makeSleep();
        const fn = vi.fn(async () => 'hello');
        const result = await withHttpRetry(fn, { classify: () => retryable, sleep });
        expect(result).toBe('hello');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    // Retry on transient errors
    it('retries up to maxAttempts and eventually succeeds', async () => {
        const { sleep } = makeSleep();
        let count = 0;
        const fn = vi.fn(async () => {
            if (++count < 3) throw new Error('transient');
            return 'ok';
        });

        const result = await withHttpRetry(fn, {
            classify: () => retryable,
            sleep,
            maxAttempts: 3,
        });

        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('throws after maxAttempts exhausted', async () => {
        const { sleep } = makeSleep();
        const err = new Error('always fails');
        const fn = vi.fn(async () => {
            throw err;
        });

        await expect(
            withHttpRetry(fn, { classify: () => retryable, sleep, maxAttempts: 3 }),
        ).rejects.toBe(err);

        expect(fn).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2); // sleeps between attempts 1→2 and 2→3
    });

    // Non-retryable — bail immediately
    it('does not retry when classify returns retryable:false', async () => {
        const { sleep } = makeSleep();
        const err = new Error('auth error');
        const fn = vi.fn(async () => {
            throw err;
        });

        await expect(
            withHttpRetry(fn, { classify: () => notRetryable, sleep, maxAttempts: 5 }),
        ).rejects.toBe(err);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    // Already-aborted signal
    it('throws immediately when signal is already aborted', async () => {
        const { sleep } = makeSleep();
        const ac = new AbortController();
        ac.abort(new DOMException('Aborted', 'AbortError'));

        const fn = vi.fn(async () => 'should not run');

        await expect(
            withHttpRetry(fn, { classify: () => retryable, sleep, signal: ac.signal }),
        ).rejects.toBeInstanceOf(DOMException);

        expect(fn).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
    });

    it('throws signal reason when signal is pre-aborted with a custom reason', async () => {
        const { sleep } = makeSleep();
        const ac = new AbortController();
        const reason = new Error('custom cancel');
        ac.abort(reason);

        await expect(
            withHttpRetry(async () => 'x', { classify: () => retryable, sleep, signal: ac.signal }),
        ).rejects.toBe(reason);
    });

    // retryAfterMs from classification takes priority over backoff
    it('uses retryAfterMs from classify instead of backoff delay', async () => {
        const { sleep, calls } = makeSleep();
        let attempt = 0;
        const fn = vi.fn(async () => {
            if (++attempt < 3) throw new Error('429');
            return 'done';
        });

        await withHttpRetry(fn, {
            classify: () => ({ retryable: true, retryAfterMs: 1234 }),
            sleep,
            maxAttempts: 3,
            baseMs: 999, // would produce different delays if used
        });

        expect(calls).toEqual([1234, 1234]);
    });

    // Backoff strategy: baseMs * 2^(attempt-1), capped at capMs
    it('uses exponential backoff when retryAfterMs is null', async () => {
        const { sleep, calls } = makeSleep();
        let attempt = 0;
        const fn = vi.fn(async () => {
            if (++attempt < 4) throw new Error('transient');
            return 'ok';
        });

        await withHttpRetry(fn, {
            classify: () => retryable,
            sleep,
            maxAttempts: 4,
            baseMs: 100,
            capMs: 10_000,
        });

        // attempt 1 → sleep(100 * 2^0 = 100)
        // attempt 2 → sleep(100 * 2^1 = 200)
        // attempt 3 → sleep(100 * 2^2 = 400)
        expect(calls).toEqual([100, 200, 400]);
    });

    it('caps backoff at capMs', async () => {
        const { sleep, calls } = makeSleep();
        let attempt = 0;
        const fn = vi.fn(async () => {
            if (++attempt < 4) throw new Error('transient');
            return 'ok';
        });

        await withHttpRetry(fn, {
            classify: () => retryable,
            sleep,
            maxAttempts: 4,
            baseMs: 1000,
            capMs: 1500,
        });

        // attempt 1 → min(1500, 1000) = 1000
        // attempt 2 → min(1500, 2000) = 1500
        // attempt 3 → min(1500, 4000) = 1500
        expect(calls).toEqual([1000, 1500, 1500]);
    });

    // Default options
    it('uses default maxAttempts=3 when not specified', async () => {
        const { sleep } = makeSleep();
        const fn = vi.fn(async () => {
            throw new Error('fail');
        });

        await expect(withHttpRetry(fn, { classify: () => retryable, sleep })).rejects.toThrow(
            'fail',
        );

        expect(fn).toHaveBeenCalledTimes(3);
    });

    // Retries with null retryAfterMs fall through to backoff (no throw on sleep args)
    it('passes signal to sleep', async () => {
        const { sleep } = makeSleep();
        const ac = new AbortController();
        let attempt = 0;
        const fn = vi.fn(async () => {
            if (++attempt < 2) throw new Error('transient');
            return 'ok';
        });

        await withHttpRetry(fn, {
            classify: () => retryable,
            sleep,
            maxAttempts: 3,
            signal: ac.signal,
        });

        expect(sleep).toHaveBeenCalledWith(expect.any(Number), ac.signal);
    });
});
