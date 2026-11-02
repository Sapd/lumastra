// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * L1 must never outlive the L2 entry it was promoted from.
 *
 * Without `promoteWithRemainingTtl`, `get()` promotes an L2 hit into L1 for the
 * flat namespace `l1TTL`. That is harmless while every entry in a namespace
 * shares one TTL, and wrong the moment a writer passes a per-entry TTL: a
 * replica that reads a 5-second entry one second before it expires goes on
 * serving it for the namespace's full 45 seconds. The write is bounded, the
 * READ is not — so the short TTL holds only on the replica that computed it,
 * which is exactly the guarantee it was added to make.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mem = vi.hoisted(() => ({
    store: new Map<string, string>(),
    /** Seconds of life left per key, following Valkey's TTL contract. */
    ttl: new Map<string, number>(),
}));

vi.mock('../cache/valkey', () => ({
    connectValkey: vi.fn(async () => true),
    getValkeyClient: vi.fn(() => ({})),
    cacheGet: vi.fn(async (key: string) => mem.store.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string, ttlSeconds?: number) => {
        mem.store.set(key, value);
        // -1 is Valkey's "exists, no expiry".
        mem.ttl.set(key, ttlSeconds ?? -1);
        return true;
    }),
    cacheDel: vi.fn(async () => 1),
    cacheExists: vi.fn(async (key: string) => mem.store.has(key)),
    // -2 is Valkey's "absent or unreachable".
    getKeyTtlSeconds: vi.fn(async (key: string) => mem.ttl.get(key) ?? -2),
    getKeysByPattern: vi.fn(async () => []),
    deleteKeysByPattern: vi.fn(async () => 0),
}));

vi.mock('../utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { UnifiedCache } = await import('./unified-cache.js');

const NS = { namespace: 'promo-test', l1TTL: 45_000, l2TTL: 45_000 };

describe('UnifiedCache — L1 promotion on an L2 hit', () => {
    beforeEach(() => {
        mem.store.clear();
        mem.ttl.clear();
    });

    it('promotes for the remaining L2 life when the namespace opts in', async () => {
        const writer = new UnifiedCache({ ...NS, promoteWithRemainingTtl: true });
        // A short-lived entry, as the search def writes for a degraded page.
        await writer.set('k', { hello: 'world' }, 5_000);

        // A DIFFERENT instance stands in for another replica: its L1 is empty,
        // so this read goes to L2 and promotes.
        const reader = new UnifiedCache({ ...NS, promoteWithRemainingTtl: true });
        const l1Set = vi.spyOn(
            (reader as unknown as { l1Cache: { set: (...a: unknown[]) => void } }).l1Cache,
            'set',
        );

        await expect(reader.get('k')).resolves.toEqual({ hello: 'world' });

        expect(l1Set).toHaveBeenCalledTimes(1);
        // 5s of L2 life left, so 5s in L1 — NOT the namespace's 45s.
        expect(l1Set.mock.calls[0]?.[2]).toBe(5_000);
    });

    it('still caps at l1TTL when the L2 entry outlives it', async () => {
        const writer = new UnifiedCache({ ...NS, l1TTL: 10_000, promoteWithRemainingTtl: true });
        await writer.set('k', 'v', 60_000);

        const reader = new UnifiedCache({ ...NS, l1TTL: 10_000, promoteWithRemainingTtl: true });
        const l1Set = vi.spyOn(
            (reader as unknown as { l1Cache: { set: (...a: unknown[]) => void } }).l1Cache,
            'set',
        );
        await reader.get('k');

        // min(l1TTL, remaining) — the flag narrows promotion, never widens it.
        expect(l1Set.mock.calls[0]?.[2]).toBe(10_000);
    });

    it('uses the flat l1TTL, and asks Valkey nothing, when the namespace has not opted in', async () => {
        const valkey = await import('../cache/valkey');
        const writer = new UnifiedCache(NS);
        await writer.set('k', 'v', 5_000);

        const reader = new UnifiedCache(NS);
        const l1Set = vi.spyOn(
            (reader as unknown as { l1Cache: { set: (...a: unknown[]) => void } }).l1Cache,
            'set',
        );
        vi.mocked(valkey.getKeyTtlSeconds).mockClear();
        await reader.get('k');

        expect(l1Set.mock.calls[0]?.[2]).toBe(45_000);
        // The extra round-trip is the cost of the flag; namespaces that do not
        // set it must not pay it.
        expect(valkey.getKeyTtlSeconds).not.toHaveBeenCalled();
    });

    it.each([
        ['no expiry', -1],
        ['absent or unreachable', -2],
    ])('falls back to l1TTL when Valkey reports %s', async (_label, sentinel) => {
        const valkey = await import('../cache/valkey');
        mem.store.set('promo-test:k', JSON.stringify('v'));
        vi.mocked(valkey.getKeyTtlSeconds).mockResolvedValueOnce(sentinel);

        // A fresh reader each time, so the read is guaranteed to be an L1 miss.
        const reader = new UnifiedCache({ ...NS, promoteWithRemainingTtl: true });
        const l1Set = vi.spyOn(
            (reader as unknown as { l1Cache: { set: (...a: unknown[]) => void } }).l1Cache,
            'set',
        );
        await reader.get('k');

        // Neither sentinel carries a usable expiry, so neither may shorten —
        // or silently zero — the promotion.
        expect(l1Set.mock.calls[0]?.[2]).toBe(45_000);
    });
});
