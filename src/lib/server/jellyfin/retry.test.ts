// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { classifyJellyfinError, backoffMs, withJellyfinRetry } from './retry.js';

// Minimal axios-error-shaped objects.
const axiosErr = (status: number, headers: Record<string, string> = {}): unknown => ({
    isAxiosError: true,
    response: { status, headers },
    message: `HTTP ${status}`,
});
const networkErr = (code: string): unknown => ({ isAxiosError: true, code, message: code });

describe('classifyJellyfinError', () => {
    it('retries 429 and reads Retry-After (seconds)', () => {
        const r = classifyJellyfinError(axiosErr(429, { 'retry-after': '2' }));
        expect(r.retryable).toBe(true);
        expect(r.retryAfterMs).toBe(2000);
    });

    it('retries 429 with no Retry-After (null → caller uses backoff)', () => {
        const r = classifyJellyfinError(axiosErr(429));
        expect(r).toEqual({ retryable: true, retryAfterMs: null });
    });

    it('retries 5xx', () => {
        expect(classifyJellyfinError(axiosErr(503)).retryable).toBe(true);
        expect(classifyJellyfinError(axiosErr(500)).retryable).toBe(true);
    });

    it('retries timeouts / network errors', () => {
        expect(classifyJellyfinError(networkErr('ECONNABORTED')).retryable).toBe(true);
        expect(classifyJellyfinError(networkErr('ETIMEDOUT')).retryable).toBe(true);
        // No response at all (connection refused) is transient too.
        expect(
            classifyJellyfinError({ isAxiosError: true, message: 'socket hang up' }).retryable,
        ).toBe(true);
    });

    it('does NOT retry other 4xx (auth/not-found)', () => {
        expect(classifyJellyfinError(axiosErr(401)).retryable).toBe(false);
        expect(classifyJellyfinError(axiosErr(403)).retryable).toBe(false);
        expect(classifyJellyfinError(axiosErr(404)).retryable).toBe(false);
    });

    it('does NOT retry an open circuit breaker (futile within a cycle)', () => {
        const cb = Object.assign(new Error('open'), { name: 'CircuitBreakerOpen' });
        expect(classifyJellyfinError(cb).retryable).toBe(false);
    });

    it('does NOT retry an abort', () => {
        const ab = new DOMException('Aborted', 'AbortError');
        expect(classifyJellyfinError(ab).retryable).toBe(false);
    });

    it('caps an absurd Retry-After', () => {
        const r = classifyJellyfinError(axiosErr(429, { 'retry-after': '99999' }));
        expect(r.retryAfterMs).toBe(60_000); // capped at 60s
    });
});

describe('backoffMs', () => {
    it('grows exponentially from base and caps', () => {
        expect(backoffMs(1, 500, 8000)).toBe(500);
        expect(backoffMs(2, 500, 8000)).toBe(1000);
        expect(backoffMs(3, 500, 8000)).toBe(2000);
        expect(backoffMs(10, 500, 8000)).toBe(8000); // capped
    });
});

describe('withJellyfinRetry', () => {
    const noSleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {});

    it('returns the result on first success (no retry)', async () => {
        const fn = vi.fn(async () => 'ok');
        const out = await withJellyfinRetry(fn, { sleep: noSleep });
        expect(out).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries a transient error then succeeds', async () => {
        const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {});
        let n = 0;
        const fn = vi.fn(async () => {
            n++;
            if (n < 3) throw axiosErr(503);
            return 'recovered';
        });
        const out = await withJellyfinRetry(fn, { sleep, baseMs: 500, capMs: 8000 });
        expect(out).toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000]); // backoff for attempts 1,2
    });

    it('honors Retry-After over backoff for 429', async () => {
        const sleep = vi.fn<(ms: number, signal?: AbortSignal) => Promise<void>>(async () => {});
        let n = 0;
        const fn = vi.fn(async () => {
            n++;
            if (n < 2) throw axiosErr(429, { 'retry-after': '3' });
            return 'ok';
        });
        await withJellyfinRetry(fn, { sleep });
        expect(sleep).toHaveBeenCalledWith(3000, undefined);
    });

    it('throws immediately on a non-retryable error', async () => {
        const fn = vi.fn(async () => {
            throw axiosErr(401);
        });
        await expect(withJellyfinRetry(fn, { sleep: noSleep })).rejects.toMatchObject({
            response: { status: 401 },
        });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('gives up after maxAttempts and throws the last error', async () => {
        const fn = vi.fn(async () => {
            throw axiosErr(503);
        });
        await expect(
            withJellyfinRetry(fn, { sleep: noSleep, maxAttempts: 3 }),
        ).rejects.toMatchObject({ response: { status: 503 } });
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('does not retry once the signal is aborted', async () => {
        const ac = new AbortController();
        const fn = vi.fn(async () => {
            ac.abort();
            throw axiosErr(503);
        });
        await expect(
            withJellyfinRetry(fn, { sleep: noSleep, signal: ac.signal }),
        ).rejects.toBeTruthy();
        expect(fn).toHaveBeenCalledTimes(1); // aborted → no retry
    });
});
