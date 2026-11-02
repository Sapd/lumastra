// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the P5 hard confirm gate (confirm-gate.ts) in isolation —
 * `create-request.tool.test.ts` covers its integration into the tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
let valkeyReady = true;

vi.mock('$lib/server/cache/valkey.js', () => ({
    isCoordinationValkeyReady: () => valkeyReady,
    cacheGet: vi.fn(async (key: string) => store.get(key) ?? null),
    setEx: vi.fn(async (key: string, _seconds: number, value: string) => {
        store.set(key, value);
        return true;
    }),
}));

import { markPendingConfirmation, isConfirmedFromEarlierInvocation } from './confirm-gate.js';

beforeEach(() => {
    store.clear();
    valkeyReady = true;
});

describe('confirm-gate (P5)', () => {
    it('no marker was ever set → refuse (isConfirmedFromEarlierInvocation is false)', async () => {
        expect(await isConfirmedFromEarlierInvocation('u1', 'm1', 'inv-B')).toBe(false);
    });

    it('a marker set by a DIFFERENT invocation → confirmed', async () => {
        await markPendingConfirmation('u1', 'm1', 'inv-A');
        expect(await isConfirmedFromEarlierInvocation('u1', 'm1', 'inv-B')).toBe(true);
    });

    it('a marker set by the SAME invocation → refused (same-turn self-confirm)', async () => {
        await markPendingConfirmation('u1', 'm1', 'inv-A');
        expect(await isConfirmedFromEarlierInvocation('u1', 'm1', 'inv-A')).toBe(false);
    });

    it('is keyed per (userId, mediaId) — a marker for a different title does not confirm this one', async () => {
        await markPendingConfirmation('u1', 'm1', 'inv-A');
        expect(await isConfirmedFromEarlierInvocation('u1', 'm2', 'inv-B')).toBe(false);
    });

    it('is keyed per (userId, mediaId) — a marker for a different user does not confirm this one', async () => {
        await markPendingConfirmation('u1', 'm1', 'inv-A');
        expect(await isConfirmedFromEarlierInvocation('u2', 'm1', 'inv-B')).toBe(false);
    });

    it('fails CLOSED when Valkey is unreachable, even with a marker that would otherwise confirm', async () => {
        await markPendingConfirmation('u1', 'm1', 'inv-A');
        valkeyReady = false;
        expect(await isConfirmedFromEarlierInvocation('u1', 'm1', 'inv-B')).toBe(false);
    });

    it('markPendingConfirmation is a no-op when Valkey is unreachable (never throws)', async () => {
        valkeyReady = false;
        await expect(markPendingConfirmation('u1', 'm1', 'inv-A')).resolves.toBeUndefined();
        expect(store.size).toBe(0);
    });

    it('no invocationId (a tool called directly, outside the dispatch loop): mark is a no-op, confirm always passes', async () => {
        await markPendingConfirmation('u1', 'm1', undefined);
        expect(store.size).toBe(0);
        expect(await isConfirmedFromEarlierInvocation('u1', 'm1', undefined)).toBe(true);
    });
});
