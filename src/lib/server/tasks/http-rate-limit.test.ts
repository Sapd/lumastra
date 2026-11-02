// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for per-provider HTTP rate-limit enforcement.
 *
 * Covers:
 *   - N requests within a 1-second window get throttled to rps
 *   - AbortSignal during the wait throws an AbortError
 *   - Different providerIds get independent buckets (slow provider
 *     doesn't starve a fast one)
 *
 * Real timers — the rps values used here are small enough that
 * wall-clock waits stay under a couple of seconds total. Fake timers
 * complicate AbortSignal interaction without buying much here.
 *
 * Run with: npx vitest run src/lib/server/tasks/http-rate-limit.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    acquireHttpToken,
    __resetHttpRateLimitBucketsForTests,
    __getHttpRateLimitBucketCountForTests,
} from './http-rate-limit.js';

beforeEach(() => {
    __resetHttpRateLimitBucketsForTests();
});

describe('acquireHttpToken — throttling', () => {
    it('is a no-op when providerId is undefined', async () => {
        const start = Date.now();
        await acquireHttpToken(undefined, { rps: 1 });
        await acquireHttpToken(undefined, { rps: 1 });
        await acquireHttpToken(undefined, { rps: 1 });
        expect(Date.now() - start).toBeLessThan(50);
        expect(__getHttpRateLimitBucketCountForTests()).toBe(0);
    });

    it('is a no-op when cfg is undefined', async () => {
        const start = Date.now();
        await acquireHttpToken('p', undefined);
        await acquireHttpToken('p', undefined);
        await acquireHttpToken('p', undefined);
        expect(Date.now() - start).toBeLessThan(50);
        expect(__getHttpRateLimitBucketCountForTests()).toBe(0);
    });

    it('throttles N requests within a 1-second window to rps', async () => {
        // rps=2 → capacity 2. Three back-to-back takes: first two consume
        // the bucket immediately, third must wait ~500ms for a refill.
        const start = Date.now();
        await acquireHttpToken('slow', { rps: 2 });
        await acquireHttpToken('slow', { rps: 2 });
        await acquireHttpToken('slow', { rps: 2 });
        const elapsed = Date.now() - start;
        // At least one msPerToken (500ms) wait should have happened.
        // Allow generous upper bound for CI variance.
        expect(elapsed).toBeGreaterThanOrEqual(450);
        expect(elapsed).toBeLessThan(2000);
    });

    it('honours fractional rps (0.5 = 1 request every 2s)', async () => {
        // rps=0.5 → capacity max(1, 0.5)=1. Two back-to-back: first
        // consumes the lone token, second waits ~2000ms (1 / 0.5).
        const start = Date.now();
        await acquireHttpToken('anidb', { rps: 0.5 });
        await acquireHttpToken('anidb', { rps: 0.5 });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(1800);
        expect(elapsed).toBeLessThan(3500);
    }, 10_000);

    it('concurrent bursts do not all proceed off a single refill tick (non-atomic take regression)', async () => {
        // Regression for a non-atomic check-then-act take(): the old
        // implementation slept once and then unconditionally decremented
        // (floored at 0), so N concurrent waiters that all woke after ONE
        // refill period would ALL resolve even though only one token had
        // actually been replenished — a burst that exceeds rps. The fix
        // re-refills and re-checks `tokens >= 1` in a loop, so only one
        // waiter proceeds per refill tick and the rest loop back to sleep.
        const rps = 3;
        const msPerToken = 1000 / rps;
        const providerId = 'burst-provider';

        const start = Date.now();
        const completionTimes: number[] = [];
        const calls = Array.from({ length: rps * 2 }, () =>
            acquireHttpToken(providerId, { rps }).then(() => {
                completionTimes.push(Date.now() - start);
            }),
        );
        await Promise.all(calls);
        completionTimes.sort((a, b) => a - b);

        // Bucket starts full (capacity = rps) — the first `rps` calls
        // resolve immediately without waiting on a refill.
        const immediate = completionTimes.filter((t) => t < msPerToken / 2).length;
        expect(immediate).toBe(rps);

        // The remaining `rps` calls must each wait for their own token —
        // they should NOT all land within the first post-burst refill tick.
        const waiters = completionTimes.slice(rps);
        const firstTickWaiters = waiters.filter((t) => t < msPerToken * 1.5).length;
        expect(firstTickWaiters).toBeLessThan(waiters.length);
    }, 15_000);
});

describe('acquireHttpToken — AbortSignal', () => {
    it('throws immediately when the signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        // Drain the lone token first so the next take would have to wait —
        // not strictly necessary because an aborted signal is checked up
        // front, but exercises the early-abort path explicitly.
        await acquireHttpToken('p1', { rps: 1 });
        await expect(acquireHttpToken('p1', { rps: 1 }, ac.signal)).rejects.toThrow(/abort/i);
    });

    it('throws when the signal aborts during the wait', async () => {
        // Drain the bucket, then start a take that must wait.
        await acquireHttpToken('p2', { rps: 1 });

        const ac = new AbortController();
        const start = Date.now();
        const pending = acquireHttpToken('p2', { rps: 1 }, ac.signal);
        setTimeout(() => ac.abort(), 100);
        await expect(pending).rejects.toThrow(/abort/i);
        // Should reject quickly after abort, NOT wait the full msPerToken (1000ms).
        expect(Date.now() - start).toBeLessThan(500);
    });
});

describe('acquireHttpToken — bucket isolation', () => {
    it('uses independent buckets per providerId', async () => {
        // p-slow at 0.5 rps; p-fast at 100 rps. Drain p-slow's bucket
        // then issue many p-fast takes — they should NOT be blocked by
        // p-slow's exhausted state.
        await acquireHttpToken('p-slow', { rps: 0.5 });

        const start = Date.now();
        for (let i = 0; i < 10; i++) {
            await acquireHttpToken('p-fast', { rps: 100 });
        }
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(200);
        expect(__getHttpRateLimitBucketCountForTests()).toBe(2);
    });

    it('shares a single bucket across calls for the same providerId', async () => {
        // Two separate "context builds" reusing the same providerId must
        // share state — otherwise each context would start with a full
        // bucket and rate limit would be defeated.
        await acquireHttpToken('shared', { rps: 1 });
        // Bucket capacity is 1; second take from a "different context"
        // (same id, different call site) must wait ~1000ms.
        const start = Date.now();
        await acquireHttpToken('shared', { rps: 1 });
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(800);
        expect(__getHttpRateLimitBucketCountForTests()).toBe(1);
    }, 5_000);
});
