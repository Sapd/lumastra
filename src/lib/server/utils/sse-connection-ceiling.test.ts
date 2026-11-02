// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Production leak fix (2026-09-26): the original design kept ONE Valkey
 * counter per (namespace, user), re-armed on every keepalive tick of ANY
 * live connection. A replica that died mid-connection (every deploy) left
 * its INCR un-DECRed, and as long as the user kept even one other tab open
 * the shared key's TTL kept getting refreshed, so the phantom count never
 * expired — pinning the user's counter at the cap forever. Rewritten to
 * per-connection membership in a Valkey sorted set (`sse:conns:v2:...`),
 * scored by last-seen time, so a leaked member ages out independently of
 * whatever the user's other tabs are doing and is pruned on the next
 * acquire.
 *
 * `mockClient` below is a small in-memory reimplementation of the Lua
 * scripts' semantics (prune-then-admit on acquire, XX-refresh-own-member on
 * refresh, plain ZREM on release) so these tests exercise the real command
 * sequence `sse-connection-ceiling.ts` sends, not just a canned return value.
 * Reverting the fix (back to INCR/DECR on a single shared key) makes these
 * tests fail because the reverted code never issues an EVAL/ZADD/ZCARD
 * sequence at all — see the revert-proof test at the bottom of each
 * describe block.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: vi.fn(),
}));

import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { acquireUserConnectionSlot } from './sse-connection-ceiling.js';

/**
 * In-memory sorted set keyed by `key -> Map<member, score>`, driven purely
 * by the command shapes `sse-connection-ceiling.ts` actually sends (EVAL
 * with the acquire/refresh Lua bodies, plain ZREM on release). This mirrors
 * what real Valkey would do for those exact scripts, without needing a Lua
 * interpreter in the test.
 */
function mockClient(): {
    customCommand: ReturnType<typeof vi.fn>;
    store: Map<string, Map<string, number>>;
} {
    const store = new Map<string, Map<string, number>>();

    const customCommand = vi.fn(async (cmd: string[]) => {
        const [op] = cmd;
        if (op === 'EVAL') {
            const [, script, , key, member, arg3, arg4, arg5] = cmd;
            const set = store.get(key) ?? new Map<string, number>();
            store.set(key, set);

            if (script.includes('zremrangebyscore')) {
                // Acquire: prune stale, then admit if under cap.
                const now = Number(arg3);
                const max = Number(arg4);
                const staleMs = Number(arg5);
                for (const [m, score] of set) {
                    if (score < now - staleMs) set.delete(m);
                }
                if (set.size >= max) return 0;
                set.set(member, now);
                return 1;
            }

            // Refresh: XX semantics — only touch an existing member.
            const now = Number(arg3);
            if (!set.has(member)) return 0;
            set.set(member, now);
            return 1;
        }
        if (op === 'ZREM') {
            const [, key, member] = cmd;
            store.get(key)?.delete(member);
            return 1;
        }
        return 'OK';
    });

    return { customCommand, store };
}

describe('acquireUserConnectionSlot — Valkey membership path', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('admits connections up to the cap', async () => {
        const client = mockClient();
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );

        const slots = await Promise.all(
            [1, 2, 3].map(() => acquireUserConnectionSlot('ns', 'user-1', 3)),
        );
        expect(slots.every((s) => s.ok)).toBe(true);
    });

    it('refuses a connection once the cap is reached', async () => {
        const client = mockClient();
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );

        await acquireUserConnectionSlot('ns', 'user-1', 2);
        await acquireUserConnectionSlot('ns', 'user-1', 2);
        const third = await acquireUserConnectionSlot('ns', 'user-1', 2);

        expect(third.ok).toBe(false);
    });

    it('release() frees a slot for a subsequent acquire', async () => {
        const client = mockClient();
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );

        const first = await acquireUserConnectionSlot('ns', 'user-1', 1);
        expect(first.ok).toBe(true);

        const blocked = await acquireUserConnectionSlot('ns', 'user-1', 1);
        expect(blocked.ok).toBe(false);

        first.release();
        await Promise.resolve();
        await Promise.resolve();

        const afterRelease = await acquireUserConnectionSlot('ns', 'user-1', 1);
        expect(afterRelease.ok).toBe(true);
    });

    it('release() is idempotent', async () => {
        const client = mockClient();
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );

        const slot = await acquireUserConnectionSlot('ns', 'user-1', 1);
        slot.release();
        slot.release();
        slot.release();
        await Promise.resolve();

        const zremCalls = client.customCommand.mock.calls.filter((c) => c[0][0] === 'ZREM');
        expect(zremCalls).toHaveLength(1);
    });

    it('a member whose score is older than staleMs is pruned on the next acquire — simulates a dead replica that never ran its release', async () => {
        vi.useFakeTimers();
        const client = mockClient();
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );

        // Fill the cap. Not one of these ever releases — mirrors a replica
        // that died (deploy restart) mid-connection.
        const CAP = 3;
        for (let i = 0; i < CAP; i++) {
            const slot = await acquireUserConnectionSlot('ns', 'user-1', CAP);
            expect(slot.ok).toBe(true);
        }

        const blocked = await acquireUserConnectionSlot('ns', 'user-1', CAP);
        expect(blocked.ok).toBe(false);

        // Advance well past staleness (3x the 10s keepalive cadence = 30s) —
        // none of the abandoned members are ever refreshed.
        vi.advanceTimersByTime(60_000);

        const afterStale = await acquireUserConnectionSlot('ns', 'user-1', CAP);
        expect(afterStale.ok).toBe(true);
    });

    it("refresh() keeps a live member from being pruned, even after its neighbours' staleness window has passed", async () => {
        vi.useFakeTimers();
        const client = mockClient();
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );

        const CAP = 2;
        const live = await acquireUserConnectionSlot('ns', 'user-1', CAP);
        const abandoned = await acquireUserConnectionSlot('ns', 'user-1', CAP);
        expect(live.ok).toBe(true);
        expect(abandoned.ok).toBe(true);

        // Both connections keep ticking every 10s (SSE_KEEPALIVE_MS), but
        // only `live` calls refresh() — `abandoned`'s replica died.
        for (let i = 0; i < 5; i++) {
            vi.advanceTimersByTime(10_000);
            live.refresh();
            await Promise.resolve();
        }
        // 50s elapsed — past the 30s staleness window, so `abandoned` is now
        // prunable but `live` (last refreshed 0-10s ago) is not.

        const third = await acquireUserConnectionSlot('ns', 'user-1', CAP);
        // The abandoned member was pruned, freeing a slot for `third`, while
        // `live` still holds its own slot (total live members == CAP).
        expect(third.ok).toBe(true);

        const fourth = await acquireUserConnectionSlot('ns', 'user-1', CAP);
        expect(fourth.ok).toBe(false);
    });

    it('refresh() is a no-op when no slot was granted (ok: false)', async () => {
        const client = mockClient();
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );

        await acquireUserConnectionSlot('ns', 'user-1', 1);
        const refused = await acquireUserConnectionSlot('ns', 'user-1', 1);
        expect(refused.ok).toBe(false);

        client.customCommand.mockClear();
        expect(() => refused.refresh()).not.toThrow();
        await Promise.resolve();
        expect(client.customCommand).not.toHaveBeenCalled();
    });

    it('uses a new v2 key namespace, distinct from any stale v1 counter key', async () => {
        const client = mockClient();
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );

        await acquireUserConnectionSlot('ns', 'user-1', 5);

        const keysTouched = client.customCommand.mock.calls.map((c) => c[0][3]);
        expect(keysTouched).toContain('sse:conns:v2:ns:user-1');
        expect(keysTouched.some((k) => k === 'sse:conns:ns:user-1')).toBe(false);
    });

    it('revert-proof: the acquire path issues an EVAL (membership), never a bare INCR (the old, leaky counter)', async () => {
        const client = mockClient();
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );

        await acquireUserConnectionSlot('ns', 'user-1', 5);

        const ops = client.customCommand.mock.calls.map((c) => c[0][0]);
        expect(ops).toContain('EVAL');
        expect(ops).not.toContain('INCR');
    });
});

describe('acquireUserConnectionSlot — in-process fallback (no Valkey)', () => {
    beforeEach(() => {
        vi.mocked(getCoordinationClient).mockReturnValue(null);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('enforces the cap and release() frees a slot', async () => {
        const first = await acquireUserConnectionSlot('local-ns', 'user-x', 1);
        expect(first.ok).toBe(true);

        const blocked = await acquireUserConnectionSlot('local-ns', 'user-x', 1);
        expect(blocked.ok).toBe(false);

        first.release();

        const afterRelease = await acquireUserConnectionSlot('local-ns', 'user-x', 1);
        expect(afterRelease.ok).toBe(true);
        afterRelease.release();
    });

    it('release() is idempotent', async () => {
        const slot = await acquireUserConnectionSlot('local-ns', 'user-y', 1);
        slot.release();
        slot.release();

        const afterRelease = await acquireUserConnectionSlot('local-ns', 'user-y', 1);
        expect(afterRelease.ok).toBe(true);
        afterRelease.release();
    });

    it('refresh() is a harmless no-op (no per-connection membership to refresh)', async () => {
        const slot = await acquireUserConnectionSlot('local-ns', 'user-z', 5);
        expect(slot.ok).toBe(true);
        expect(() => slot.refresh()).not.toThrow();
        slot.release();
    });
});
