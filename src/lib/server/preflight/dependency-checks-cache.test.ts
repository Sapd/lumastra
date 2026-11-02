// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import {
    createDependencyChecksCache,
    DependencyChecksWarmingError,
} from './dependency-checks-cache.js';
import type { DependencyFinding } from './dependency-checks.js';

const WARN: DependencyFinding[] = [
    {
        id: 'sonic-embedder',
        name: 'Music embedder',
        status: 'warn',
        url: 'http://sonic-embedder:8000',
    },
];

/** Flush pending microtasks so a fire-and-forget background refresh settles. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createDependencyChecksCache', () => {
    it('throws DependencyChecksWarmingError on the cold call and kicks off exactly one probe', async () => {
        const probe = vi.fn(() => Promise.resolve(WARN));
        const cache = createDependencyChecksCache({ probe, now: () => 1000, ttlMs: 60_000 });

        await expect(cache.get()).rejects.toBeInstanceOf(DependencyChecksWarmingError);
        expect(probe).toHaveBeenCalledTimes(1);
    });

    it('serves cached findings on a fresh call without re-probing', async () => {
        const probe = vi.fn(() => Promise.resolve(WARN));
        let clock = 1000;
        const cache = createDependencyChecksCache({ probe, now: () => clock, ttlMs: 60_000 });

        await cache.get().catch(() => undefined); // cold → throws, starts probe
        await flush(); // background probe resolves, cache populated at t=1000

        clock = 1000 + 30_000; // still within TTL
        const fresh = await cache.get();
        expect(fresh).toEqual(WARN);
        expect(probe).toHaveBeenCalledTimes(1); // no re-probe while fresh
    });

    it('returns stale findings and revalidates once when TTL has expired (stampede-guarded)', async () => {
        const probe = vi.fn(() => Promise.resolve(WARN));
        let clock = 1000;
        const cache = createDependencyChecksCache({ probe, now: () => clock, ttlMs: 60_000 });

        await cache.get().catch(() => undefined); // cold
        await flush(); // cache populated at t=1000, probe #1

        clock = 1000 + 60_001; // TTL expired
        const [a, b] = await Promise.all([cache.get(), cache.get()]); // two concurrent stale reads
        expect(a).toEqual(WARN);
        expect(b).toEqual(WARN);
        expect(probe).toHaveBeenCalledTimes(2); // exactly one revalidation, not two

        await flush();
        clock = 1000 + 60_001 + 10; // fresh again after revalidation
        await cache.get();
        expect(probe).toHaveBeenCalledTimes(2); // served from freshly-revalidated cache
    });
});
