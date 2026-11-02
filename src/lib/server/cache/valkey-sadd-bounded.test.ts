// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `sAddBounded` is the atomic (SADD + cap check + EXPIRE, one Lua script)
 * primitive that replaced a separate "read the set, decide in JS, SADD
 * later" sequence for the per-user download-prepare cap. Two things must be
 * true of it:
 *
 *  1. Admission is ONE Valkey round trip — never a `sadd()` call followed by
 *     a later, separate `expire()`/`scard()`/`srem()` call. That separation
 *     is exactly what let concurrent callers observe the same pre-write
 *     snapshot (the TOCTOU race), and separately left a window where a key
 *     could exist on a `noeviction` instance with no TTL at all if the
 *     process died between the two calls.
 *  2. It fails OPEN — same policy every helper in `prepare-cap.ts` documents.
 *
 * No live Valkey is available in this environment, so — following the same
 * pattern `valkey-ha-fail-closed.test.ts` and `valkey-lock-renew.test.ts`
 * use — a fresh module import per scenario, and a minimal mocked
 * `@valkey/valkey-glide` client, stand in for a real server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── mocked @valkey/valkey-glide ────────────────────────────────────────────

const fakeClient = {
    ping: vi.fn(async () => 'PONG'),
    customCommand: vi.fn(),
    sadd: vi.fn(),
    scard: vi.fn(),
    srem: vi.fn(),
    expire: vi.fn(),
};
const createClient = vi.fn(async (..._args: unknown[]) => fakeClient);

vi.mock('@valkey/valkey-glide', () => ({
    GlideClient: { createClient: (...args: unknown[]) => createClient(...args) },
    TimeUnit: { Seconds: 'Seconds', Milliseconds: 'Milliseconds' },
    GlideClientConfiguration: {},
}));

/**
 * Fresh import of valkey.ts with the given environment pre-set — required
 * because CACHE_URL/TASK_CACHE_URL feed module-level consts read at import
 * time (see valkey-ha-fail-closed.test.ts for the same pattern).
 */
async function freshValkey(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
    }
    return import('./valkey.js') as Promise<typeof import('./valkey.js')>;
}

const SAVED_CACHE = process.env.CACHE_URL;
const SAVED_TASK = process.env.TASK_CACHE_URL;

afterEach(() => {
    if (SAVED_CACHE !== undefined) process.env.CACHE_URL = SAVED_CACHE;
    else delete process.env.CACHE_URL;
    if (SAVED_TASK !== undefined) process.env.TASK_CACHE_URL = SAVED_TASK;
    else delete process.env.TASK_CACHE_URL;
    vi.resetModules();
});

// ── Scenario A: connected client — the atomic path ─────────────────────────

describe('sAddBounded — connected (mocked GlideClient)', () => {
    let valkey: Awaited<ReturnType<typeof freshValkey>>;

    beforeEach(async () => {
        fakeClient.ping.mockReset().mockResolvedValue('PONG');
        fakeClient.customCommand.mockReset();
        fakeClient.sadd.mockReset();
        fakeClient.scard.mockReset();
        fakeClient.srem.mockReset();
        fakeClient.expire.mockReset();
        createClient.mockReset().mockImplementation(async () => fakeClient);

        // Both distinct endpoints use the same mock implementation.
        // Coordination keys are still routed to the task endpoint.
        valkey = await freshValkey({
            CACHE_URL: 'redis://localhost:6379/0',
            TASK_CACHE_URL: 'redis://localhost:6380/1',
        });
        const connected = await valkey.connectValkey();
        expect(connected).toBe(true);
    });

    it('admits via ONE EVAL round trip — no separate sadd/expire/scard/srem calls', async () => {
        fakeClient.customCommand.mockResolvedValue(1);

        const admitted = await valkey.sAddBounded('dl:prep:u1', 'file-1:720p:1', 1, 600);

        expect(admitted).toBe(true);
        expect(fakeClient.customCommand).toHaveBeenCalledTimes(1);
        const args = fakeClient.customCommand.mock.calls[0][0] as string[];
        expect(args[0]).toBe('EVAL');
        expect(args.slice(2)).toEqual(['1', 'dl:prep:u1', 'file-1:720p:1', '1', '600']);
        // The whole point: admission and the write that enforces it cannot be
        // torn apart into separate round trips a concurrent caller — or a
        // lost response — could land between.
        expect(fakeClient.sadd).not.toHaveBeenCalled();
        expect(fakeClient.expire).not.toHaveBeenCalled();
        expect(fakeClient.scard).not.toHaveBeenCalled();
        expect(fakeClient.srem).not.toHaveBeenCalled();
    });

    it('refuses when the script reports overshoot', async () => {
        fakeClient.customCommand.mockResolvedValue(0);

        const admitted = await valkey.sAddBounded('dl:prep:u1', 'file-2:720p:1', 1, 600);

        expect(admitted).toBe(false);
    });

    it('fails OPEN when the script call itself throws (e.g. a connection blip)', async () => {
        fakeClient.customCommand.mockRejectedValue(new Error('connection reset'));

        const admitted = await valkey.sAddBounded('dl:prep:u1', 'file-3:720p:1', 1, 600);

        expect(admitted).toBe(true);
    });
});

// ── Scenario B: no client at all — fail open ────────────────────────────────

describe('sAddBounded — Valkey unavailable', () => {
    it('admits (fails open) regardless of cap when there is no client', async () => {
        // CACHE_URL empty and connectValkey() never called → valkeyClient
        // stays null → pickClient() returns null for every key.
        const valkey = await freshValkey({ CACHE_URL: '', TASK_CACHE_URL: '' });

        const admitted = await valkey.sAddBounded('dl:prep:u1', 'm1', 0, 600);

        expect(admitted).toBe(true);
    });
});
