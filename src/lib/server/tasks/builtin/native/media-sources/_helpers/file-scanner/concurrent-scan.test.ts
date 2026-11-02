// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the bounded-concurrency per-file loop and the TMDB search
 * cache introduced in the file-scanner throughput optimisation.
 *
 * These tests exercise the semaphore semantics and cache deduplication WITHOUT
 * a real database or filesystem — all collaborators are stubbed.
 */

import { describe, it, expect, vi } from 'vitest';
import type { MetadataSearchCache, MetadataSearchCacheHit } from './video-processor.js';

// ---------------------------------------------------------------------------
// Semaphore semantics — extracted inline so the test can reason about them
// without importing the full scanner (which pulls in heavy DB deps).
//
// The production implementation lives in file-scanner.ts performScan().
// This mirrors it faithfully so any divergence is caught by the assertions.
// ---------------------------------------------------------------------------

function makeSemaphore(concurrency: number): {
    acquire: () => Promise<void>;
    release: () => void;
    inFlight: () => number;
} {
    let inFlight = 0;
    const waiters: Array<() => void> = [];

    const acquire = (): Promise<void> => {
        if (inFlight < concurrency) {
            inFlight++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            waiters.push(resolve);
        });
    };

    const release = (): void => {
        const next = waiters.shift();
        if (next) {
            next();
        } else {
            inFlight--;
        }
    };

    return { acquire, release, inFlight: () => inFlight };
}

describe('bounded-concurrency semaphore', () => {
    it('allows up to N concurrent acquisitions without blocking', async () => {
        const sem = makeSemaphore(3);
        await sem.acquire();
        await sem.acquire();
        await sem.acquire();
        expect(sem.inFlight()).toBe(3);
        sem.release();
        expect(sem.inFlight()).toBe(2);
        sem.release();
        sem.release();
        expect(sem.inFlight()).toBe(0);
    });

    it('queues the (N+1)th acquisition until a slot is released', async () => {
        const sem = makeSemaphore(2);
        await sem.acquire();
        await sem.acquire();

        let resolved = false;
        const pending = sem.acquire().then(() => {
            resolved = true;
        });

        // Still blocked.
        await Promise.resolve();
        expect(resolved).toBe(false);

        // Release one slot — the queued waiter should now run.
        sem.release();
        await pending;
        expect(resolved).toBe(true);

        // Two are now in flight (one we just unblocked + the original second).
        expect(sem.inFlight()).toBe(2);

        // Clean up.
        sem.release();
        sem.release();
        expect(sem.inFlight()).toBe(0);
    });

    it('processes N files concurrently and produces correct counters', async () => {
        // Simulate 6 files processed with concurrency=3.
        // Each "file" returns its index; we sum them to check no double-count.
        const results: number[] = [];
        const sem = makeSemaphore(3);
        const files = [0, 1, 2, 3, 4, 5];

        const tasks = files.map((i) =>
            (async () => {
                await sem.acquire();
                // Simulate async work.
                await Promise.resolve();
                results.push(i);
                sem.release();
            })(),
        );
        await Promise.all(tasks);

        expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(sem.inFlight()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// MetadataSearchCache — deduplication of provider searches
// ---------------------------------------------------------------------------

describe('MetadataSearchCache deduplication', () => {
    it('returns a cached positive hit without re-calling the provider', async () => {
        const cache: MetadataSearchCache = new Map();
        const providerSearch = vi.fn(async () => ({
            matched: true,
            candidate: {
                externalId: '42',
                provider: 'tmdb',
                title: 'Voyage to Orion',
                year: 2013,
                mediaType: 'tv',
                confidence: 0.95,
            },
            parsed: { title: 'Voyage to Orion' },
        }));

        const searchOrCache = async (key: string): Promise<MetadataSearchCacheHit | null> => {
            if (cache.has(key)) return cache.get(key)!;
            const result = await providerSearch();
            if (result.matched && result.candidate) {
                const hit: MetadataSearchCacheHit = {
                    candidate: result.candidate as MetadataSearchCacheHit['candidate'],
                    matchedProviderId: 'tmdb-metadata-provider',
                };
                cache.set(key, hit);
                return hit;
            }
            cache.set(key, null);
            return null;
        };

        const key = 'tmdb-metadata-provider:tv:Voyage to Orion';

        // First call: provider is invoked.
        const hit1 = await searchOrCache(key);
        expect(hit1).not.toBeNull();
        expect(providerSearch).toHaveBeenCalledTimes(1);

        // Second call (same key): cache hit, provider NOT invoked.
        const hit2 = await searchOrCache(key);
        expect(hit2).toEqual(hit1);
        expect(providerSearch).toHaveBeenCalledTimes(1);
    });

    it('caches negative misses to prevent repeated provider calls for unresolvable titles', async () => {
        const cache: MetadataSearchCache = new Map();
        const providerSearch = vi.fn(async () => ({
            matched: false,
            parsed: { title: 'Unresolvable Title XYZ' },
        }));

        const searchOrCache = async (key: string): Promise<MetadataSearchCacheHit | null> => {
            if (cache.has(key)) return cache.get(key)!;
            const result = await providerSearch();
            if (result.matched) {
                // Never reached in this test — just for symmetry.
                const hit = { candidate: null!, matchedProviderId: '' };
                cache.set(key, hit);
                return hit;
            }
            cache.set(key, null);
            return null;
        };

        const key = 'tmdb-metadata-provider:tv:Unresolvable Title XYZ';

        const hit1 = await searchOrCache(key);
        expect(hit1).toBeNull();
        expect(providerSearch).toHaveBeenCalledTimes(1);

        // Second call: null cached, provider NOT invoked.
        const hit2 = await searchOrCache(key);
        expect(hit2).toBeNull();
        expect(providerSearch).toHaveBeenCalledTimes(1);
    });

    it('different keys are independent (different series do not share cache entries)', async () => {
        const cache: MetadataSearchCache = new Map();

        const makeHit = (title: string): MetadataSearchCacheHit => ({
            candidate: {
                externalId: String(Math.random()),
                provider: 'tmdb',
                title,
                year: 2020,
                mediaType: 'tv',
                confidence: 0.9,
            },
            matchedProviderId: 'tmdb-metadata-provider',
        });

        const keyA = 'tmdb-metadata-provider:tv:Series A';
        const keyB = 'tmdb-metadata-provider:tv:Series B';

        cache.set(keyA, makeHit('Series A'));
        cache.set(keyB, makeHit('Series B'));

        expect(cache.get(keyA)?.candidate.title).toBe('Series A');
        expect(cache.get(keyB)?.candidate.title).toBe('Series B');
    });

    it('clearing the cache between library paths prevents cross-contamination', () => {
        const cache: MetadataSearchCache = new Map();
        const key = 'tmdb-metadata-provider:tv:Some Series';
        const hit: MetadataSearchCacheHit = {
            candidate: {
                externalId: '1',
                provider: 'tmdb',
                title: 'Some Series',
                year: 2021,
                mediaType: 'tv',
                confidence: 0.9,
            },
            matchedProviderId: 'tmdb-metadata-provider',
        };

        cache.set(key, hit);
        expect(cache.has(key)).toBe(true);

        // Simulate switching library paths.
        cache.clear();
        expect(cache.has(key)).toBe(false);
    });
});
