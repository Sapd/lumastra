// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The relay token shared through Valkey, against a faithful store.
 *
 * The enrolment tests mock this whole module, so they cannot see what it does
 * to the real cache stack. Here the REAL `cacheManager` / `UnifiedCache` run on
 * top of an in-memory Valkey that honours TTLs (the clock is faked) and SET NX
 * locks. A second `UnifiedCache` instance on the same namespace stands in for a
 * sibling process: its writes reach the store but never this process's L1, which
 * is exactly the case a 60 s in-process copy got wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = vi.hoisted(() => ({
    store: new Map<string, { value: string; expiresAt: number | null }>(),
    locks: new Map<string, { value: string; expiresAt: number }>(),
    lockDown: false,
    lockSeq: 0,
    lastTtlSeconds: null as number | null,
}));

function live(key: string): string | null {
    const e = mem.store.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
        mem.store.delete(key);
        return null;
    }
    return e.value;
}

vi.mock('$lib/server/cache/valkey', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache/valkey')>()),
    connectValkey: vi.fn(async () => true),
    getValkeyClient: vi.fn(() => ({})),
    cacheGet: vi.fn(async (key: string) => live(key)),
    cacheSet: vi.fn(async (key: string, value: string, ttlSeconds?: number) => {
        mem.lastTtlSeconds = ttlSeconds ?? null;
        mem.store.set(key, {
            value,
            expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
        });
        return true;
    }),
    cacheDel: vi.fn(async (key: string) => (mem.store.delete(key) ? 1 : 0)),
    cacheExists: vi.fn(async (key: string) => live(key) !== null),
    getKeyTtlSeconds: vi.fn(async () => -2),
    getKeysByPattern: vi.fn(async () => []),
    deleteKeysByPattern: vi.fn(async () => 0),
    acquireLock: vi.fn(async (key: string, ttlSeconds: number, value?: string) => {
        if (mem.lockDown) throw new Error('coordination valkey down');
        const held = mem.locks.get(key);
        if (held && held.expiresAt > Date.now()) return null;
        const v = value ?? `lock-${++mem.lockSeq}`;
        mem.locks.set(key, { value: v, expiresAt: Date.now() + ttlSeconds * 1000 });
        return v;
    }),
    releaseLock: vi.fn(async (key: string, value: string) => {
        const held = mem.locks.get(key);
        if (!held || held.value !== value) return false;
        mem.locks.delete(key);
        return true;
    }),
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { UnifiedCache } from '$lib/server/cache/unified-cache';
import { CACHE_NAMESPACES } from '$lib/server/cache';
import {
    acquireEnrolLock,
    clearSharedRelayToken,
    clearSharedRelayTokenIfEquals,
    loadSharedRelayToken,
    releaseEnrolLock,
    saveSharedRelayToken,
} from './relay-token.shared.js';

const HOUR = 60 * 60 * 1000;

/** Another process: same namespace, same Valkey, its own (separate) L1. */
function sibling(): UnifiedCache {
    return new UnifiedCache({
        namespace: CACHE_NAMESPACES.pushRelayToken.name,
        l1TTL: 60_000,
        l2TTL: 24 * HOUR,
    });
}

/** Let the cache's fire-and-forget L2 write land. */
async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
    mem.store.clear();
    mem.locks.clear();
    mem.lockDown = false;
    mem.lastTtlSeconds = null;
    await clearSharedRelayToken();
    await flush();
    mem.store.clear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('shared relay token: store and TTL', () => {
    it('round-trips a token and writes it with its remaining life as the TTL', async () => {
        const exp = Date.now() + 20 * HOUR;
        await saveSharedRelayToken('tok-a', exp);
        await flush();
        expect(mem.lastTtlSeconds).toBe(20 * 3600);
        expect(await loadSharedRelayToken()).toEqual({ token: 'tok-a', expiresAtMs: exp });
    });

    it('is gone once the TTL has run out', async () => {
        await saveSharedRelayToken('tok-a', Date.now() + 6 * 60 * 1000);
        await flush();
        expect(await loadSharedRelayToken()).not.toBeNull();
        vi.setSystemTime(Date.now() + 7 * 60 * 1000);
        expect(await loadSharedRelayToken()).toBeNull();
    });

    it('does not share, and does not return, a token with under 5 minutes left', async () => {
        await saveSharedRelayToken('tok-short', Date.now() + 4 * 60 * 1000);
        await flush();
        expect(mem.store.size).toBe(0);
        // Written by a sibling with a long TTL but a near expiry claim: still refused.
        await sibling().set('v1:relay-token', { token: 't', expiresAtMs: Date.now() + 60_000 });
        await flush();
        expect(await loadSharedRelayToken()).toBeNull();
    });

    it('ignores a malformed stored value', async () => {
        await sibling().set('v1:relay-token', { token: 42 });
        await flush();
        expect(await loadSharedRelayToken()).toBeNull();
    });
});

describe('shared relay token: reads see what other processes wrote', () => {
    it('a sibling replacing the token is visible at once, not after a 60 s in-process copy', async () => {
        await saveSharedRelayToken('old', Date.now() + 20 * HOUR);
        await flush();
        expect((await loadSharedRelayToken())?.token).toBe('old');

        await sibling().set('v1:relay-token', {
            token: 'newer',
            expiresAtMs: Date.now() + 23 * HOUR,
        });
        await flush();
        expect((await loadSharedRelayToken())?.token).toBe('newer');
    });

    it('a token a sibling removed is not served from a local copy', async () => {
        await saveSharedRelayToken('old', Date.now() + 20 * HOUR);
        await flush();
        expect(await loadSharedRelayToken()).not.toBeNull();

        await sibling().delete('v1:relay-token');
        expect(await loadSharedRelayToken()).toBeNull();
    });
});

describe('shared relay token: compare-and-delete', () => {
    it('removes the copy when it is the rejected token', async () => {
        await saveSharedRelayToken('rejected', Date.now() + 20 * HOUR);
        await flush();
        await clearSharedRelayTokenIfEquals('rejected');
        expect(await loadSharedRelayToken()).toBeNull();
    });

    it('keeps a newer token a sibling stored after this process last looked', async () => {
        await saveSharedRelayToken('rejected', Date.now() + 20 * HOUR);
        await flush();
        // This process has read the slot (and, with a local copy, remembers it).
        await loadSharedRelayToken();

        await sibling().set('v1:relay-token', {
            token: 'newer',
            expiresAtMs: Date.now() + 23 * HOUR,
        });
        await flush();

        await clearSharedRelayTokenIfEquals('rejected');
        expect((await loadSharedRelayToken())?.token).toBe('newer');
        expect(mem.store.size).toBe(1);
    });

    it('is a no-op on an empty slot', async () => {
        await expect(clearSharedRelayTokenIfEquals('anything')).resolves.toBeUndefined();
        expect(mem.store.size).toBe(0);
    });
});

describe('shared relay token: the call lock', () => {
    it('one holder at a time; the second gets null until the first releases', async () => {
        const first = await acquireEnrolLock();
        expect(first).not.toBeNull();
        expect(await acquireEnrolLock()).toBeNull();
        await releaseEnrolLock(first!);
        expect(await acquireEnrolLock()).not.toBeNull();
    });

    it('a stale holder cannot release the lock a later holder took', async () => {
        const first = await acquireEnrolLock();
        vi.setSystemTime(Date.now() + 60_000); // the 45 s TTL ran out
        const second = await acquireEnrolLock();
        expect(second).not.toBeNull();
        await releaseEnrolLock(first!);
        expect(await acquireEnrolLock()).toBeNull();
    });

    it('falls back to a process-local lock value when the lock service throws', async () => {
        mem.lockDown = true;
        const value = await acquireEnrolLock();
        expect(value).toMatch(/^local-/);
        await expect(releaseEnrolLock(value!)).resolves.toBeUndefined();
    });
});
