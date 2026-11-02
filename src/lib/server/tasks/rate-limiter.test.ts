// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for RateLimiter — token bucket, Retry-After, circuit breaker.
 *
 * Uses vi.useFakeTimers() where timing precision is needed. fetch() is mocked
 * globally via vi.stubGlobal().
 *
 * Targets use public IP literals (e.g. http://93.184.216.34/) rather than
 * hostnames: ctx.dep().fetch now funnels through safeFetch, which resolves +
 * pins DNS for hostnames (and would use the unmocked undici dispatcher). For
 * IP literals safeFetch skips DNS and issues through the mocked global fetch,
 * so these wrapper-behavior tests stay hermetic. DNS-pinning itself is covered
 * in url-safety.test.ts.
 *
 * Run with: npx vitest run src/lib/server/tasks/rate-limiter.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFetchMock(status: number, headers: Record<string, string> = {}): typeof fetch {
    return vi.fn(async () => {
        return new Response(null, { status, headers });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RateLimiter — token bucket', () => {
    let rl: RateLimiter;

    beforeEach(() => {
        rl = new RateLimiter();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rl.reset();
    });

    it('allows calls within the rps budget without delay', async () => {
        const mockFetch = makeFetchMock(200);
        vi.stubGlobal('fetch', mockFetch);

        const dep = rl.forDep('fast-api', { rps: 10 });
        const start = Date.now();
        await dep.fetch('http://93.184.216.34/1');
        await dep.fetch('http://93.184.216.34/2');
        const elapsed = Date.now() - start;
        // Both within the token budget — should be fast (<500 ms).
        expect(elapsed).toBeLessThan(500);
    });

    it('throttles when calls exceed rps=2 and 3 calls are made', async () => {
        // rps=2 → 1 token per 500ms. After the bucket is exhausted the 3rd
        // call must wait at least 1 token refill (~500ms).
        const mockFetch = makeFetchMock(200);
        vi.stubGlobal('fetch', mockFetch);

        const dep = rl.forDep('slow-api', { rps: 2 });
        const start = Date.now();
        await dep.fetch('http://93.184.216.34/1');
        await dep.fetch('http://93.184.216.34/2');
        await dep.fetch('http://93.184.216.34/3');
        const elapsed = Date.now() - start;
        // At rps=2 the 3rd call must wait ~500ms, so total > 450ms.
        expect(elapsed).toBeGreaterThan(450);
    }, 10_000);

    it('fractional rps (slow API) accumulates tokens correctly', async () => {
        // F11 carryover: a 10rpm API was previously floored to rps=1 (60rpm
        // budget). With fractional rps support, rps = 10/60 ≈ 0.1667 means
        // one token every 6 seconds. The bucket capacity floors at 1 so the
        // first call goes through immediately, and the second call should
        // wait ~6s. We use rps=2 inverted to keep the test fast: rps=0.5
        // means one token every 2 seconds.
        const mockFetch = makeFetchMock(200);
        vi.stubGlobal('fetch', mockFetch);

        const dep = rl.forDep('very-slow-api', { rps: 0.5 });
        const start = Date.now();
        await dep.fetch('http://93.184.216.34/1'); // burst from initial bucket
        await dep.fetch('http://93.184.216.34/2'); // waits ~2s for the next token
        const elapsed = Date.now() - start;
        // At rps=0.5 the 2nd call must wait ~2000ms.
        expect(elapsed).toBeGreaterThan(1800);
    }, 10_000);

    it('concurrent bursts do not all proceed off a single refill tick (non-atomic take regression)', async () => {
        // Regression for a non-atomic check-then-act take(): the old
        // implementation slept once and then unconditionally decremented
        // (floored at 0), so N concurrent waiters that all woke after ONE
        // refill period would ALL resolve even though only one token had
        // actually been replenished — a burst that exceeds rps. The fix
        // re-refills and re-checks `tokens >= 1` in a loop, so only one
        // waiter proceeds per refill tick and the rest loop back to sleep.
        const mockFetch = makeFetchMock(200);
        vi.stubGlobal('fetch', mockFetch);

        const rps = 3;
        const msPerToken = 1000 / rps;
        const dep = rl.forDep('burst-api', { rps });

        const start = Date.now();
        const completionTimes: number[] = [];
        const calls = Array.from({ length: rps * 2 }, (_, i) =>
            dep.fetch(`http://93.184.216.34/${i}`).then(() => {
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

describe('RateLimiter — 429 Retry-After header', () => {
    let rl: RateLimiter;

    beforeEach(() => {
        rl = new RateLimiter();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rl.reset();
    });

    it('waits Retry-After seconds and retries once on 429', async () => {
        let callCount = 0;
        const mockFetch = vi.fn(async () => {
            callCount++;
            if (callCount === 1) {
                return new Response(null, {
                    status: 429,
                    headers: { 'Retry-After': '1' }, // 1 second
                });
            }
            return new Response(null, { status: 200 });
        });
        vi.stubGlobal('fetch', mockFetch);

        const dep = rl.forDep('rate-limited-api', {
            rps: 100,
            retryAfter: 'header',
        });
        const start = Date.now();
        const res = await dep.fetch('http://93.184.216.34/');
        const elapsed = Date.now() - start;

        expect(res.status).toBe(200);
        expect(callCount).toBe(2);
        // Must have waited at least 900ms (1s Retry-After with 100ms tolerance).
        expect(elapsed).toBeGreaterThan(900);
    }, 10_000);

    it('does not retry when retryAfter is not configured', async () => {
        let callCount = 0;
        const mockFetch = vi.fn(async () => {
            callCount++;
            return new Response(null, {
                status: 429,
                headers: { 'Retry-After': '1' },
            });
        });
        vi.stubGlobal('fetch', mockFetch);

        const dep = rl.forDep('no-retry-api', { rps: 100 }); // no retryAfter
        const res = await dep.fetch('http://93.184.216.34/');
        expect(res.status).toBe(429);
        expect(callCount).toBe(1);
    });
});

describe('RateLimiter — circuit breaker', () => {
    let rl: RateLimiter;

    beforeEach(() => {
        rl = new RateLimiter();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rl.reset();
    });

    it('opens circuit after configured failure threshold', async () => {
        const mockFetch = makeFetchMock(503);
        vi.stubGlobal('fetch', mockFetch);

        const dep = rl.forDep('flaky-api', {
            circuitBreaker: { failures: 5, cooldownMs: 60_000 },
        });

        // 5 failures should open the circuit.
        for (let i = 0; i < 5; i++) {
            await dep.fetch('http://93.184.216.34/');
        }

        // 6th call: circuit is open → throws without hitting fetch.
        await expect(dep.fetch('http://93.184.216.34/')).rejects.toThrow('circuit open');
    });

    it('after cooldown the circuit allows a probe through', async () => {
        const mockFetch = makeFetchMock(503);
        vi.stubGlobal('fetch', mockFetch);

        const cooldownMs = 100;
        const dep = rl.forDep('cool-api', {
            circuitBreaker: { failures: 3, cooldownMs },
        });

        for (let i = 0; i < 3; i++) {
            await dep.fetch('http://93.184.216.34/');
        }

        // Circuit is open — 4th call throws.
        await expect(dep.fetch('http://93.184.216.34/')).rejects.toThrow('circuit open');

        // Wait for cooldown.
        await sleep(cooldownMs + 20);

        // Now the circuit should allow a probe (openUntil has passed).
        const probeFetch = makeFetchMock(200);
        vi.stubGlobal('fetch', probeFetch);

        const res = await dep.fetch('http://93.184.216.34/');
        expect(res.status).toBe(200);

        // Success should close the circuit — state resets.
        const state = rl.getCircuitState('cool-api');
        expect(state?.failures).toBe(0);
    }, 10_000);

    it('successive successes reset the failure counter', async () => {
        const mockFetch = makeFetchMock(200);
        vi.stubGlobal('fetch', mockFetch);

        const dep = rl.forDep('resilient-api', {
            circuitBreaker: { failures: 5, cooldownMs: 60_000 },
        });

        await dep.fetch('http://93.184.216.34/');
        await dep.fetch('http://93.184.216.34/');

        const state = rl.getCircuitState('resilient-api');
        // Success should keep failures at 0 (or reset if they were non-zero).
        expect(state?.failures ?? 0).toBe(0);
    });
});

describe('RateLimiter — SSRF guard (ctx.dep().fetch)', () => {
    let rl: RateLimiter;
    beforeEach(() => {
        rl = new RateLimiter();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('rejects loopback / private / link-local hosts WITHOUT calling fetch', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('x', { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);
        const dep = rl.forDep('internal', { rps: 100 });

        // ctx.http applies the same guard; the dep path used to skip it,
        // letting a plugin reach Postgres/Valkey/internal admin at 127.0.0.1.
        await expect(dep.fetch('http://127.0.0.1:5432/')).rejects.toThrow();
        await expect(dep.fetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
        await expect(dep.fetch('http://10.0.0.5:6379/')).rejects.toThrow();
        await expect(dep.fetch('ftp://example.com/')).rejects.toThrow();

        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('allows public hosts (guard does not block legitimate traffic)', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);
        const dep = rl.forDep('public', { rps: 100 });

        const res = await dep.fetch('http://93.184.216.34/data');
        expect(res.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// allowPrivateUrls (final fix wave, 2026-09-13): EMBEDDING_ALLOW_PRIVATE_URLS
// used to reach only the interactive embedding path (ai/voyage.ts's
// guardedDefaultFetch) — the task-scoped ctx.dep('embeddings') path always
// went through the public-only safeFetch with no opt-in, so a self-hosted
// EMBEDDING_BASE_URL on a private network stayed unreachable from a task run
// even with the flag enabled. A dep can now opt in per-call via
// `allowPrivateUrls: () => boolean`, mirroring guardedDefaultFetch's
// same-origin-only fallback (fetchWithTimeout) instead of the public-only
// guard (safeFetch).
// ---------------------------------------------------------------------------
describe('RateLimiter — allowPrivateUrls', () => {
    let rl: RateLimiter;

    beforeEach(() => {
        rl = new RateLimiter();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('without allowPrivateUrls, a private target is rejected (default safeFetch behavior)', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('x', { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);
        const dep = rl.forDep('embeddings', { rps: 100 });

        await expect(dep.fetch('http://127.0.0.1:8088/embed')).rejects.toThrow();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('with allowPrivateUrls() returning true, a private target IS reachable', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);
        const dep = rl.forDep('embeddings', { rps: 100, allowPrivateUrls: () => true });

        const res = await dep.fetch('http://127.0.0.1:8088/embed');
        expect(res.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(
            'http://127.0.0.1:8088/embed',
            expect.objectContaining({ redirect: 'manual' }),
        );
    });

    it('allowPrivateUrls() is read on EVERY call, not cached at forDep() time', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);
        let allowed = false;
        const dep = rl.forDep('embeddings', { rps: 100, allowPrivateUrls: () => allowed });

        await expect(dep.fetch('http://127.0.0.1:8088/embed')).rejects.toThrow();

        allowed = true;
        const res = await dep.fetch('http://127.0.0.1:8088/embed');
        expect(res.status).toBe(200);
    });

    it('still blocks a private target when allowPrivateUrls() returns false', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('x', { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);
        const dep = rl.forDep('embeddings', { rps: 100, allowPrivateUrls: () => false });

        await expect(dep.fetch('http://10.0.0.5:8088/embed')).rejects.toThrow();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a public target still works normally when allowPrivateUrls is set', async () => {
        const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
        vi.stubGlobal('fetch', mockFetch);
        const dep = rl.forDep('embeddings', { rps: 100, allowPrivateUrls: () => true });

        const res = await dep.fetch('http://93.184.216.34/embed');
        expect(res.status).toBe(200);
    });
});
