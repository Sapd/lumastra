// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `zAddBoundedExpiring` is the atomic admission primitive behind caps whose
 * members expire INDIVIDUALLY — a slot held by one request, released when
 * that request's work ends, and swept if the holder never releases it
 * (crash, pod restart, lost callback).
 *
 * It is the sorted-set sibling of `sAddBounded` and differs from it in the
 * two ways its only caller (the showcase transcode cap) needs:
 *
 *  1. Per-MEMBER expiry, not per-key. `sAddBounded` refreshes the key's TTL
 *     on every admission, so under continuous traffic a leaked member never
 *     expires and the cap silently fills with zombies until it refuses
 *     forever. A sorted set scored by acquisition time lets the script prune
 *     only the members that are actually stale.
 *  2. An EXPLICIT `failOpen` policy, with no default. `sAddBounded` fails
 *     open because a cache outage must not become a download outage; this
 *     primitive's caller needs the opposite (a Valkey blip must not uncap
 *     ffmpeg spawning). Neither default is safe for the other caller, so the
 *     option is required at every call site.
 *
 * As in `valkey-sadd-bounded.test.ts`, no live Valkey is available here, so a
 * fresh module import per scenario plus a minimal mocked `@valkey/valkey-glide`
 * client stand in for a real server.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── mocked @valkey/valkey-glide ────────────────────────────────────────────

const fakeClient = {
    ping: vi.fn(async () => 'PONG'),
    customCommand: vi.fn(),
    zadd: vi.fn(),
    zcard: vi.fn(),
    zrem: vi.fn(),
    zcount: vi.fn(),
    zremRangeByScore: vi.fn(),
    expire: vi.fn(),
};
const createClient = vi.fn(async (..._args: unknown[]) => fakeClient);

vi.mock('@valkey/valkey-glide', () => ({
    GlideClient: { createClient: (...args: unknown[]) => createClient(...args) },
    TimeUnit: { Seconds: 'Seconds', Milliseconds: 'Milliseconds' },
    GlideClientConfiguration: {},
    InfBoundary: { NegativeInfinity: '-inf', PositiveInfinity: '+inf' },
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

const KEY = 'showcase:transcode:slots';

// ── Scenario A: connected client — the atomic path ─────────────────────────

describe('zAddBoundedExpiring — connected (mocked GlideClient)', () => {
    let valkey: Awaited<ReturnType<typeof freshValkey>>;

    beforeEach(async () => {
        fakeClient.ping.mockReset().mockResolvedValue('PONG');
        fakeClient.customCommand.mockReset();
        fakeClient.zadd.mockReset();
        fakeClient.zcard.mockReset();
        fakeClient.zrem.mockReset();
        fakeClient.zcount.mockReset();
        fakeClient.zremRangeByScore.mockReset();
        fakeClient.expire.mockReset();
        createClient.mockReset().mockImplementation(async () => fakeClient);

        // Both distinct endpoints use the same mock implementation. Production
        // clients remain separate; coordination keys use the task endpoint.
        valkey = await freshValkey({
            CACHE_URL: 'redis://localhost:6379/0',
            TASK_CACHE_URL: 'redis://localhost:6380/1',
        });
        const connected = await valkey.connectValkey();
        expect(connected).toBe(true);
    });

    it('admits via ONE EVAL round trip — no separate zadd/zcard/zrem/expire calls', async () => {
        fakeClient.customCommand.mockResolvedValue(1);

        const admitted = await valkey.zAddBoundedExpiring(KEY, 'slot-a', 4, 300, {
            failOpen: false,
            nowMs: 1_700_000_000_000,
        });

        expect(admitted).toBe(true);
        expect(fakeClient.customCommand).toHaveBeenCalledTimes(1);
        const args = fakeClient.customCommand.mock.calls[0][0] as string[];
        expect(args[0]).toBe('EVAL');
        // KEYS[1]=key, ARGV = member, nowMs, cap, ttlMs
        expect(args.slice(2)).toEqual(['1', KEY, 'slot-a', '1700000000000', '4', '300000']);
        // The whole point: the prune, the admission decision and the write
        // that enforces it cannot be torn apart into separate round trips a
        // concurrent caller — on this pod or any other — could land between.
        expect(fakeClient.zadd).not.toHaveBeenCalled();
        expect(fakeClient.zcard).not.toHaveBeenCalled();
        expect(fakeClient.zrem).not.toHaveBeenCalled();
        expect(fakeClient.zremRangeByScore).not.toHaveBeenCalled();
        expect(fakeClient.expire).not.toHaveBeenCalled();
    });

    it('the script prunes members older than the TTL before counting', async () => {
        fakeClient.customCommand.mockResolvedValue(1);

        await valkey.zAddBoundedExpiring(KEY, 'slot-a', 4, 300, {
            failOpen: false,
            nowMs: 1_700_000_000_000,
        });

        const script = (fakeClient.customCommand.mock.calls[0][0] as string[])[1];
        // Without the prune, a leaked slot occupies the cap forever: the key's
        // own TTL is refreshed by every later admission, so it never lapses
        // under continuous traffic.
        expect(script).toMatch(/zremrangebyscore/i);
        // The prune must run before the cardinality is read, or a stale member
        // still counts against the cap for one admission.
        expect(script.toLowerCase().indexOf('zremrangebyscore')).toBeLessThan(
            script.toLowerCase().indexOf('zcard'),
        );
    });

    it('refuses when the script reports overshoot', async () => {
        fakeClient.customCommand.mockResolvedValue(0);

        const admitted = await valkey.zAddBoundedExpiring(KEY, 'slot-b', 4, 300, {
            failOpen: false,
        });

        expect(admitted).toBe(false);
    });

    it('fails CLOSED when the script call throws and failOpen is false', async () => {
        fakeClient.customCommand.mockRejectedValue(new Error('connection reset'));

        const admitted = await valkey.zAddBoundedExpiring(KEY, 'slot-c', 4, 300, {
            failOpen: false,
        });

        expect(admitted).toBe(false);
    });

    it('fails OPEN when the script call throws and failOpen is true', async () => {
        fakeClient.customCommand.mockRejectedValue(new Error('connection reset'));

        const admitted = await valkey.zAddBoundedExpiring(KEY, 'slot-d', 4, 300, {
            failOpen: true,
        });

        expect(admitted).toBe(true);
    });
});

// ── Scenario B: no client at all ───────────────────────────────────────────

describe('zAddBoundedExpiring — Valkey unavailable', () => {
    it('refuses (fails closed) when there is no client and failOpen is false', async () => {
        // CACHE_URL empty and connectValkey() never called → valkeyClient
        // stays null → pickClient() returns null for every key.
        const valkey = await freshValkey({ CACHE_URL: '', TASK_CACHE_URL: '' });

        const admitted = await valkey.zAddBoundedExpiring(KEY, 'slot-a', 4, 300, {
            failOpen: false,
        });

        expect(admitted).toBe(false);
    });

    it('admits (fails open) when there is no client and failOpen is true', async () => {
        const valkey = await freshValkey({ CACHE_URL: '', TASK_CACHE_URL: '' });

        const admitted = await valkey.zAddBoundedExpiring(KEY, 'slot-a', 4, 300, {
            failOpen: true,
        });

        expect(admitted).toBe(true);
    });
});

// ── Release and observability wrappers ─────────────────────────────────────

describe('zRem / zCountFrom', () => {
    let valkey: Awaited<ReturnType<typeof freshValkey>>;

    beforeEach(async () => {
        fakeClient.ping.mockReset().mockResolvedValue('PONG');
        fakeClient.customCommand.mockReset();
        fakeClient.zrem.mockReset();
        createClient.mockReset().mockImplementation(async () => fakeClient);

        valkey = await freshValkey({
            CACHE_URL: 'redis://localhost:6379/0',
            TASK_CACHE_URL: 'redis://localhost:6380/1',
        });
        expect(await valkey.connectValkey()).toBe(true);
    });

    it('zRem removes the named members and reports how many went', async () => {
        fakeClient.zrem.mockResolvedValue(1);

        expect(await valkey.zRem(KEY, 'slot-a')).toBe(1);
        expect(fakeClient.zrem).toHaveBeenCalledWith(KEY, ['slot-a']);
    });

    it('zCountFrom counts only members at or after the given score', async () => {
        fakeClient.customCommand.mockResolvedValue(3);

        expect(await valkey.zCountFrom(KEY, 1_700_000_000_000)).toBe(3);
        expect(fakeClient.customCommand).toHaveBeenCalledWith([
            'ZCOUNT',
            KEY,
            '1700000000000',
            '+inf',
        ]);
    });

    it('zCountFrom reports null — not 0 — when the count cannot be read', async () => {
        // 0 would be indistinguishable from "the cap is empty", which is the
        // opposite of what an outage means for a cap's observability.
        fakeClient.customCommand.mockRejectedValue(new Error('connection reset'));

        expect(await valkey.zCountFrom(KEY, 1_700_000_000_000)).toBeNull();
    });
});

describe('zRem / zCountFrom — Valkey unavailable', () => {
    it('zRem is a no-op and zCountFrom is unknown when there is no client', async () => {
        const valkey = await freshValkey({ CACHE_URL: '', TASK_CACHE_URL: '' });

        expect(await valkey.zRem(KEY, 'slot-a')).toBe(0);
        expect(await valkey.zCountFrom(KEY, 0)).toBeNull();
    });
});

// ── Keyspace routing ───────────────────────────────────────────────────────

describe('showcase transcode slot keyspace', () => {
    it('routes to the noeviction coordination instance', async () => {
        const valkey = await freshValkey({ CACHE_URL: '', TASK_CACHE_URL: '' });

        // An evicted slot set silently LIFTS the cap — the dangerous
        // direction, exactly as for `dl:prep:`.
        expect(valkey.isCoordinationKey(KEY)).toBe(true);
    });
});
