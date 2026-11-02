// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A namespace declared with `l2TTL: 0` is L1-only and never touches Valkey.
 *
 * Regression: `cacheSet` treats a 0 TTL as "no expiry", so an L1-only
 * namespace was in fact written to Valkey once and read back forever. For
 * `library-roots-v1` — the containment allow-list in front of every direct
 * file read — that meant a library root added (or removed) outside the admin
 * API was never seen, although the namespace promises a 60 s refresh.
 * Found by the Watch Together browser <-> Apple TV e2e: a freshly configured
 * root still answered 404 to every direct-play request.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('../cache/valkey', () => ({
    connectValkey: vi.fn(async () => true),
    getValkeyClient: vi.fn(() => ({})),
    cacheGet: vi.fn(async (key: string) => mem.store.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string) => {
        mem.store.set(key, value);
        return true;
    }),
    cacheDel: vi.fn(async () => 1),
    cacheExists: vi.fn(async (key: string) => mem.store.has(key)),
    getKeyTtlSeconds: vi.fn(async () => -2),
    getKeysByPattern: vi.fn(async () => []),
    deleteKeysByPattern: vi.fn(async () => 0),
}));

vi.mock('../utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { UnifiedCache } = await import('./unified-cache.js');
const { CACHE_NAMESPACES } = await import('./namespaces.js');

/** L2 writes are fire-and-forget; let them land before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('UnifiedCache — l2TTL: 0 means L1 only', () => {
    beforeEach(() => mem.store.clear());

    it('never writes an l2TTL: 0 namespace to Valkey', async () => {
        const cache = new UnifiedCache({ namespace: 'l1-only', l1TTL: 60_000, l2TTL: 0 });
        await cache.set('all', ['/media/movies']);
        await settle();
        expect(mem.store.size).toBe(0);
    });

    it('does not read a stale Valkey entry back into another replica', async () => {
        // An entry left behind by a build that still wrote it (no expiry).
        mem.store.set('l1-only:all', JSON.stringify(['/old-root']));
        const replica = new UnifiedCache({ namespace: 'l1-only', l1TTL: 60_000, l2TTL: 0 });
        await expect(replica.get('all')).resolves.toBeNull();
    });

    it('still writes through when the namespace has an L2 TTL', async () => {
        const cache = new UnifiedCache({ namespace: 'l2', l1TTL: 60_000, l2TTL: 60_000 });
        await cache.set('k', 'v');
        await settle();
        expect(mem.store.size).toBe(1);
    });

    it('keeps the library-root allow-list L1-only', () => {
        expect(CACHE_NAMESPACES.libraryRoots.l2TTL).toBe(0);
        expect(CACHE_NAMESPACES.libraryPathMappings.l2TTL).toBe(0);
    });
});
