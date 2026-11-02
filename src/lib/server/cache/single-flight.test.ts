// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared in-memory Valkey stand-in. `vi.hoisted` makes the state available to the
// hoisted `vi.mock` factory below while staying mutable from the tests.
const mem = vi.hoisted(() => ({
    store: new Map<string, string>(),
    locks: new Set<string>(),
}));

vi.mock('./valkey.js', () => ({
    cacheGet: vi.fn(async (key: string): Promise<string | null> =>
        mem.store.has(key) ? mem.store.get(key)! : null,
    ),
    cacheSet: vi.fn(async (key: string, value: string): Promise<boolean> => {
        mem.store.set(key, value);
        return true;
    }),
    cacheExists: vi.fn(
        async (key: string): Promise<boolean> => mem.store.has(key) || mem.locks.has(key),
    ),
    // SET NX semantics: acquire only if not already held.
    acquireLock: vi.fn(async (key: string): Promise<string | null> => {
        if (mem.locks.has(key)) return null;
        mem.locks.add(key);
        return `token:${key}`;
    }),
    releaseLock: vi.fn(async (key: string): Promise<boolean> => {
        return mem.locks.delete(key);
    }),
    isValkeyReady: vi.fn(() => true),
}));

vi.mock('../utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { getOrComputeSingleFlight } from './single-flight.js';
import * as valkey from './valkey.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const FAST = { maxWaitMs: 200, pollIntervalMs: 5 };

describe('getOrComputeSingleFlight', () => {
    beforeEach(() => {
        mem.store.clear();
        mem.locks.clear();
        vi.clearAllMocks();
    });

    it('serves the cached value without invoking compute on a hit', async () => {
        mem.store.set('v1:test', 'cached-body');
        const compute = vi.fn(async () => 'fresh-body');

        const result = await getOrComputeSingleFlight({
            cacheKey: 'v1:test',
            ttlSeconds: 20,
            compute,
            ...FAST,
        });

        expect(result).toBe('cached-body');
        expect(compute).not.toHaveBeenCalled();
    });

    it('computes and caches the value on a miss', async () => {
        const compute = vi.fn(async () => 'fresh-body');

        const result = await getOrComputeSingleFlight({
            cacheKey: 'v1:test',
            ttlSeconds: 20,
            compute,
            ...FAST,
        });

        expect(result).toBe('fresh-body');
        expect(compute).toHaveBeenCalledTimes(1);
        expect(mem.store.get('v1:test')).toBe('fresh-body');
        // The lock must be released after computing.
        expect(mem.locks.has('v1:test:sf-lock')).toBe(false);
    });

    it('dedupes concurrent misses to a single compute (single-flight)', async () => {
        const gate = deferred<string>();
        let calls = 0;
        const compute = vi.fn(async () => {
            calls++;
            return gate.promise;
        });

        // Leader acquires the lock and blocks inside compute.
        const leader = getOrComputeSingleFlight({
            cacheKey: 'v1:test',
            ttlSeconds: 20,
            compute,
            ...FAST,
        });
        // Let the leader acquire the lock and enter compute before the follower starts.
        await Promise.resolve();
        await Promise.resolve();

        // Follower misses, fails to acquire the held lock, and waits for the value.
        const follower = getOrComputeSingleFlight({
            cacheKey: 'v1:test',
            ttlSeconds: 20,
            compute,
            ...FAST,
        });

        // Leader's compute resolves; it caches + releases, the follower picks it up.
        gate.resolve('fresh-body');
        const [a, b] = await Promise.all([leader, follower]);

        expect(a).toBe('fresh-body');
        expect(b).toBe('fresh-body');
        expect(calls).toBe(1); // only the leader computed
    });

    it('keeps a follower waiting through a slow-but-live leader without stampeding', async () => {
        const gate = deferred<string>();
        let calls = 0;
        const compute = vi.fn(async () => {
            calls++;
            return gate.promise;
        });

        // Default options (no short maxWaitMs override) — the follower should wait
        // for the leader's value as long as the lock is held, not give up early.
        const leader = getOrComputeSingleFlight({
            cacheKey: 'v1:test',
            ttlSeconds: 20,
            compute,
            pollIntervalMs: 10,
        });
        await Promise.resolve();
        await Promise.resolve();

        const follower = getOrComputeSingleFlight({
            cacheKey: 'v1:test',
            ttlSeconds: 20,
            compute,
            pollIntervalMs: 10,
        });

        // Leader stays "computing" past several follower poll cycles, then resolves.
        await new Promise((r) => setTimeout(r, 60));
        expect(calls).toBe(1); // follower has not stampeded while the lock is held
        gate.resolve('fresh-body');

        const [a, b] = await Promise.all([leader, follower]);
        expect(a).toBe('fresh-body');
        expect(b).toBe('fresh-body');
        expect(calls).toBe(1);
    });

    it('degrades to an immediate direct compute when Valkey is unavailable (no wait)', async () => {
        // Simulate Valkey down: no cache, no lock, not ready.
        vi.mocked(valkey.cacheGet).mockResolvedValue(null);
        vi.mocked(valkey.cacheSet).mockResolvedValue(false);
        vi.mocked(valkey.acquireLock).mockResolvedValue(null);
        vi.mocked(valkey.isValkeyReady).mockReturnValue(false);

        const compute = vi.fn(async () => 'fresh-body');

        const start = Date.now();
        const result = await getOrComputeSingleFlight({
            cacheKey: 'v1:test',
            ttlSeconds: 20,
            compute,
            maxWaitMs: 1000, // would be a long wait if the short-circuit were missing
            pollIntervalMs: 50,
        });
        const elapsed = Date.now() - start;

        expect(result).toBe('fresh-body');
        // Computed directly without burning the follower wait window.
        expect(compute).toHaveBeenCalledTimes(1);
        expect(elapsed).toBeLessThan(200);
    });
});

describe('getOrComputeSingleFlight — resolveTtlSeconds', () => {
    beforeEach(() => {
        mem.store.clear();
        mem.locks.clear();
        vi.clearAllMocks();
        // The "Valkey unavailable" test above pins all four of these with
        // mockResolvedValue/mockReturnValue, and `clearAllMocks` only clears
        // CALL HISTORY — the pinned return values survive into every later
        // test. Re-arm the in-memory behaviour rather than inheriting a dead
        // Valkey, which would silently route every case below through the
        // direct-compute fallback that caches nothing.
        vi.mocked(valkey.cacheGet).mockImplementation(async (key: string) =>
            mem.store.has(key) ? mem.store.get(key)! : null,
        );
        vi.mocked(valkey.cacheSet).mockImplementation(async (key: string, value: string) => {
            mem.store.set(key, value);
            return true;
        });
        vi.mocked(valkey.cacheExists).mockImplementation(
            async (key: string) => mem.store.has(key) || mem.locks.has(key),
        );
        vi.mocked(valkey.acquireLock).mockImplementation(async (key: string) => {
            if (mem.locks.has(key)) return null;
            mem.locks.add(key);
            return `token:${key}`;
        });
        vi.mocked(valkey.releaseLock).mockImplementation(async (key: string) =>
            mem.locks.delete(key),
        );
        vi.mocked(valkey.isValkeyReady).mockReturnValue(true);
    });

    it('resolves the TTL from the computed value and writes with it', async () => {
        const resolveTtlSeconds = vi.fn(() => 5);
        await getOrComputeSingleFlight({
            cacheKey: 'k:leader',
            ttlSeconds: 45,
            compute: async () => 'computed-value',
            resolveTtlSeconds,
            ...FAST,
        });

        // The value is what it gets to decide from — nothing else has to be
        // kept in sync with it.
        expect(resolveTtlSeconds).toHaveBeenCalledTimes(1);
        expect(resolveTtlSeconds).toHaveBeenCalledWith('computed-value');
        expect(valkey.cacheSet).toHaveBeenCalledWith('k:leader', 'computed-value', 5);
    });

    it('uses the declared TTL when no resolver is supplied', async () => {
        await getOrComputeSingleFlight({
            cacheKey: 'k:plain',
            ttlSeconds: 45,
            compute: async () => 'v',
            ...FAST,
        });
        expect(valkey.cacheSet).toHaveBeenCalledWith('k:plain', 'v', 45);
    });

    it('is not consulted on the cache-hit path, which writes nothing', async () => {
        mem.store.set('k:hit', 'already-there');
        const resolveTtlSeconds = vi.fn(() => 5);
        const out = await getOrComputeSingleFlight({
            cacheKey: 'k:hit',
            ttlSeconds: 45,
            compute: async () => 'never-runs',
            resolveTtlSeconds,
            ...FAST,
        });
        expect(out).toBe('already-there');
        expect(resolveTtlSeconds).not.toHaveBeenCalled();
        expect(valkey.cacheSet).not.toHaveBeenCalled();
    });

    it('is not consulted on the direct-compute fallback, which also writes nothing', async () => {
        // Someone else holds the lock and never publishes a value, so we fall
        // through to step 4 and compute for ourselves without caching.
        mem.locks.add('k:contended:sf-lock');
        const resolveTtlSeconds = vi.fn(() => 5);
        const out = await getOrComputeSingleFlight({
            cacheKey: 'k:contended',
            ttlSeconds: 45,
            compute: async () => 'direct',
            resolveTtlSeconds,
            maxWaitMs: 20,
            pollIntervalMs: 5,
        });
        expect(out).toBe('direct');
        expect(resolveTtlSeconds).not.toHaveBeenCalled();
        expect(valkey.cacheSet).not.toHaveBeenCalled();
    });

    it.each([
        ['zero', 0],
        ['negative', -5],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('falls back to the declared TTL when the resolver returns %s', async (_label, bad) => {
        // `cacheSet` treats a falsy TTL as "no expiry", so passing 0 through
        // would write a PERMANENT key under a versioned namespace — recoverable
        // only by a namespace version bump or a manual DEL.
        await getOrComputeSingleFlight({
            cacheKey: `k:bad-${String(bad)}`,
            ttlSeconds: 45,
            compute: async () => 'v',
            resolveTtlSeconds: () => bad,
            ...FAST,
        });
        expect(valkey.cacheSet).toHaveBeenCalledWith(`k:bad-${String(bad)}`, 'v', 45);
    });

    it('falls back to the declared TTL when the resolver throws, keeping the computed value', async () => {
        const out = await getOrComputeSingleFlight({
            cacheKey: 'k:throws',
            ttlSeconds: 45,
            compute: async () => 'expensive',
            resolveTtlSeconds: () => {
                throw new Error('bad ttl math');
            },
            ...FAST,
        });
        // A failed TTL calculation must not discard a successful compute.
        expect(out).toBe('expensive');
        expect(valkey.cacheSet).toHaveBeenCalledWith('k:throws', 'expensive', 45);
    });

    it('floors a fractional TTL rather than handing Valkey a non-integer', async () => {
        await getOrComputeSingleFlight({
            cacheKey: 'k:frac',
            ttlSeconds: 45,
            compute: async () => 'v',
            resolveTtlSeconds: () => 5.9,
            ...FAST,
        });
        expect(valkey.cacheSet).toHaveBeenCalledWith('k:frac', 'v', 5);
    });
});
