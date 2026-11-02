// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression tests for LeaderLock self-healing after a loss.
 *
 * The bug: after `onLost` ran `stop()` (which sets `stopped = true`), a later
 * `acquire()` on the SAME instance restarted a renew loop whose every firing
 * early-returned on `stopped`, so the freshly-acquired key was never renewed —
 * it expired within one TTL and the (peer-less) class became permanently
 * leaderless in Valkey while the process still believed it led. That is the
 * "leadership didn't auto-recover until a redeploy" failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./observability/audit-log.js', () => ({
    appendAuditEvent: vi.fn(),
}));

import { LeaderLock } from './leader-lock.js';
import type { ValkeyLike } from './valkey-types.js';

/** Minimal Valkey fake implementing the SET-NX + renew/release Lua semantics. */
class FakeValkey implements ValkeyLike {
    private store = new Map<string, string>();
    /** Outcome of the next renew(s): 1 = held, 0 = preempted (peer owns key). */
    renewReturns: 0 | 1 = 1;
    renewCalls = 0;
    setNxCalls = 0;

    async customCommand(cmd: string[]): Promise<unknown> {
        const op = cmd[0];
        if (op === 'SET') {
            // SET key val NX PX ttl
            this.setNxCalls++;
            const [, key, val] = cmd;
            if (this.store.has(key)) return null; // NX fails — held
            this.store.set(key, val);
            return 'OK';
        }
        if (op === 'GET') {
            return this.store.get(cmd[1]) ?? null;
        }
        if (op === 'EVAL') {
            const lua = cmd[1];
            const key = cmd[3];
            if (lua.includes('PEXPIRE')) {
                this.renewCalls++;
                if (this.renewReturns === 0) this.store.delete(key); // peer took it
                return this.renewReturns;
            }
            // release (DEL)
            this.store.delete(key);
            return 1;
        }
        return null;
    }

    has(key: string): boolean {
        return this.store.has(key);
    }

    /** Simulate the key expiring / being deleted out from under the holder. */
    expire(key: string): void {
        this.store.delete(key);
    }
}

const KEY = 'lock:orch:io';
const TTL = 5_000;
const RENEW = 2_000;

describe('LeaderLock self-heal after loss', () => {
    let client: FakeValkey;

    beforeEach(() => {
        vi.useFakeTimers();
        client = new FakeValkey();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renews again after re-acquiring a lock that was previously lost', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        let lostCount = 0;
        lock.onLost(() => lostCount++);

        // 1) Acquire — held, renew loop armed.
        expect(await lock.acquire()).toBe(true);
        expect(lock.isHeld()).toBe(true);

        // 2) First renew tick succeeds.
        await vi.advanceTimersByTimeAsync(RENEW);
        expect(client.renewCalls).toBe(1);

        // 3) Simulate a peer takeover → next renew returns 0 → onLost + stop().
        client.renewReturns = 0;
        await vi.advanceTimersByTimeAsync(RENEW);
        expect(lostCount).toBe(1);
        expect(lock.isHeld()).toBe(false);
        expect(client.has(KEY)).toBe(false);

        // 4) Re-acquire the SAME instance (the orchestrator's tryReacquire path).
        client.renewReturns = 1;
        const renewsBefore = client.renewCalls;
        expect(await lock.acquire()).toBe(true);
        expect(lock.isHeld()).toBe(true);

        // 5) THE FIX: the renew loop must be live again. Advance a few cycles and
        // assert renew actually fires (pre-fix: `stopped` stayed true → 0 renews →
        // key silently expires → permanent leaderless).
        await vi.advanceTimersByTimeAsync(RENEW * 2);
        expect(client.renewCalls).toBeGreaterThan(renewsBefore);
        expect(lock.isHeld()).toBe(true);
        expect(lostCount).toBe(1); // no spurious second loss
        expect(client.has(KEY)).toBe(true); // still renewed, not expired
    });

    it('verifyHeld reflects actual Valkey ownership', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        expect(await lock.verifyHeld()).toBe(false); // not acquired yet
        await lock.acquire();
        expect(await lock.verifyHeld()).toBe(true);
        // Key vanishes (expiry / external delete) while we still believe we hold it.
        client.expire(KEY);
        expect(lock.isHeld()).toBe(true); // in-process belief unchanged
        expect(await lock.verifyHeld()).toBe(false); // Valkey disagrees → zombie
    });

    it('verification fails closed on read error despite local held state', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        await lock.acquire();
        const command = vi.spyOn(client, 'customCommand');
        command.mockRejectedValueOnce(new Error('connection unavailable'));
        expect(lock.isHeld()).toBe(true);
        expect(await lock.verifyHeld()).toBe(false);
        lock.stop();
    });

    it('relinquishLocal stops renewing + clears held state without firing onLost; re-acquire is clean', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        let lostCount = 0;
        lock.onLost(() => lostCount++);

        expect(await lock.acquire()).toBe(true);
        await vi.advanceTimersByTimeAsync(RENEW);
        const renewsAtRelinquish = client.renewCalls;

        lock.relinquishLocal();
        expect(lock.isHeld()).toBe(false);
        await vi.advanceTimersByTimeAsync(RENEW * 2);
        expect(client.renewCalls).toBe(renewsAtRelinquish); // renew loop stopped
        expect(lostCount).toBe(0); // relinquishLocal does NOT fire onLost

        // relinquishLocal is local-only (doesn't DEL the key) — in the reconcile path
        // it's called only when the key is already gone, and the key expires on its
        // own once renewal stops. Simulate that, then re-acquire on the SAME instance:
        // it must restart a LIVE renew loop (Bug-1 fix).
        client.expire(KEY);
        expect(await lock.acquire()).toBe(true);
        await vi.advanceTimersByTimeAsync(RENEW);
        expect(client.renewCalls).toBeGreaterThan(renewsAtRelinquish);
    });
});

describe('LeaderLock shutdown authority', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each([false, true])(
        'drains a pending SET before release, lost acknowledgement: %s',
        async (loseAck) => {
            const client = new FakeValkey();
            const command = client.customCommand.bind(client);
            let finish!: () => void;
            const held = new Promise<void>((resolve) => {
                finish = resolve;
            });
            let entered!: () => void;
            const applied = new Promise<void>((resolve) => {
                entered = resolve;
            });
            vi.spyOn(client, 'customCommand').mockImplementation(async (args) => {
                const result = await command(args);
                if (args[0] === 'SET') {
                    entered();
                    await held;
                    if (loseAck) throw new Error('SET acknowledgement lost');
                }
                return result;
            });
            const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
            const acquisition = lock.acquire().catch((error: unknown) => error);
            await applied;
            const stopping = lock.release({ strict: true });
            let released = false;
            void stopping.then(() => {
                released = true;
            });
            await Promise.resolve();
            expect(client.has(KEY)).toBe(true);
            expect(released).toBe(false);
            finish();
            await acquisition;
            await stopping;
            expect(lock.isHeld()).toBe(false);
            expect(client.has(KEY)).toBe(false);
            await vi.advanceTimersByTimeAsync(RENEW * 2);
            expect(client.renewCalls).toBe(0);
        },
    );

    it.each([new Error('release unavailable'), undefined, 'unexpected'])(
        'retains unconfirmed release for strict retry: %s',
        async (reply) => {
            const client = new FakeValkey();
            const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
            await lock.acquire();
            const command = vi.spyOn(client, 'customCommand');
            if (reply instanceof Error) command.mockRejectedValueOnce(reply);
            else command.mockResolvedValueOnce(reply);
            await expect(lock.release({ strict: true })).rejects.toThrow('UNKNOWN');
            expect(lock.isHeld()).toBe(false);
            expect(client.has(KEY)).toBe(true);
            await lock.release({ strict: true });
            expect(client.has(KEY)).toBe(false);
        },
    );

    it('retains a tolerant release failure for a later strict retry', async () => {
        const client = new FakeValkey();
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        await lock.acquire();
        vi.spyOn(client, 'customCommand').mockRejectedValueOnce(new Error('release unavailable'));
        await expect(lock.release()).resolves.toBeUndefined();
        expect(client.has(KEY)).toBe(true);
        await lock.release({ strict: true });
        expect(client.has(KEY)).toBe(false);
    });

    it.each([false, true])('ignores a renewal completing after stop, error: %s', async (fail) => {
        const client = new FakeValkey();
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        const onLost = vi.fn();
        lock.onLost(onLost);
        await lock.acquire();
        let finish!: () => void;
        const held = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const command = client.customCommand.bind(client);
        vi.spyOn(client, 'customCommand').mockImplementation(async (args) => {
            if (args[0] === 'EVAL' && args[1].includes('PEXPIRE')) {
                await held;
                if (fail) throw new Error('renew unavailable');
                return 0;
            }
            return command(args);
        });
        // Fire the timer without awaiting its blocked callback.
        vi.advanceTimersByTime(RENEW);
        const stopping = lock.release({ strict: true });
        finish();
        await stopping;
        expect(onLost).not.toHaveBeenCalled();
        expect(lock.isHeld()).toBe(false);
    });
});

describe('LeaderLock event-loop stall tolerance', () => {
    // Regression: a stall over (ttl - renew) used to unconditionally fire onLost
    // even though the key only actually expires at `ttl`, releasing a still-valid
    // lock and causing chronic self-inflicted leadership flapping (false
    // class-no-leader CRITICALs). A stall below the loss threshold
    // (ttl - max(1s, ttl/5) = 4s here) lets the atomic renew() decide; a stall
    // past it declares loss, because the key may expire before any renew lands.
    let client: FakeValkey;
    let hrtimeSpy: ReturnType<typeof vi.spyOn>;
    let fakeNs: bigint;

    beforeEach(() => {
        vi.useFakeTimers();
        client = new FakeValkey();
        fakeNs = 0n;
        // Control the monotonic clock the stall detector reads so we can simulate
        // an event-loop stall deterministically under fake timers.
        hrtimeSpy = vi
            .spyOn(process.hrtime, 'bigint')
            .mockImplementation(() => fakeNs) as unknown as ReturnType<typeof vi.spyOn>;
    });
    afterEach(() => {
        hrtimeSpy.mockRestore();
        vi.useRealTimers();
    });

    it('keeps leadership through a stall when the key is still ours (renew succeeds) — no false onLost', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        let lostCount = 0;
        lock.onLost(() => lostCount++);

        // acquire() records its send time (fakeNs = 0) as the last confirmation.
        expect(await lock.acquire()).toBe(true);

        // Simulate a 3.5s stall: > ttl-renew (3s, the old false-loss threshold)
        // but < the 4s loss threshold — the key is still validly held. The renew
        // tick must NOT declare loss.
        fakeNs = 3_500_000_000n;
        client.renewReturns = 1;
        await vi.advanceTimersByTimeAsync(RENEW);

        expect(lostCount).toBe(0); // pre-fix this was 1 (false loss)
        expect(lock.isHeld()).toBe(true);
        expect(client.renewCalls).toBeGreaterThan(0); // ownership verified via renew
        expect(client.has(KEY)).toBe(true);
    });

    it('declares loss when renew detects the key is gone / a peer took it', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        let lostCount = 0;
        lock.onLost(() => lostCount++);
        expect(await lock.acquire()).toBe(true);

        // Short stall; meanwhile a peer claimed the key → renew returns 0.
        fakeNs = 1_000_000_000n;
        client.renewReturns = 0;
        await vi.advanceTimersByTimeAsync(RENEW);

        expect(client.renewCalls).toBe(1);
        expect(lostCount).toBe(1);
        expect(lock.isHeld()).toBe(false);
    });

    it('declares loss without renewing after a stall past the loss threshold', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        let lostCount = 0;
        lock.onLost(() => lostCount++);
        expect(await lock.acquire()).toBe(true);

        // 4.5s stall: the key (still ours in the fake) may expire before a renew
        // could land, so re-extending it would mask a possible takeover.
        fakeNs = 4_500_000_000n;
        await vi.advanceTimersByTimeAsync(RENEW);

        expect(client.renewCalls).toBe(0);
        expect(lostCount).toBe(1);
        expect(lock.isHeld()).toBe(false);
    });
});

describe('LeaderLock configuration and bounded release', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it.each([
        [5_000, 4_000],
        [5_000, 6_000],
        [30_000, 24_000],
        [5_000, 0],
    ])('rejects ttl %i ms with renew %i ms (renew must be below the loss threshold)', (ttl, renew) => {
        expect(() => new LeaderLock(new FakeValkey(), KEY, 'holder-1', ttl, renew)).toThrow(
            'loss threshold',
        );
    });

    it('accepts the defaults and the shipped configuration', () => {
        expect(() => new LeaderLock(new FakeValkey(), KEY, 'h', 15_000, 5_000)).not.toThrow();
        expect(() => new LeaderLock(new FakeValkey(), KEY, 'h', TTL, RENEW)).not.toThrow();
    });

    it('bounds release behind a renewal that never answers and reports UNKNOWN', async () => {
        vi.useFakeTimers();
        const client = new FakeValkey();
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        await lock.acquire();
        const command = client.customCommand.bind(client);
        vi.spyOn(client, 'customCommand').mockImplementation(async (args) => {
            if (args[0] === 'EVAL' && args[1].includes('PEXPIRE')) return new Promise(() => {});
            return command(args);
        });
        vi.advanceTimersByTime(RENEW); // issue the hung renewal
        const releasing = lock.release({ strict: true });
        const outcome = expect(releasing).rejects.toThrow('UNKNOWN');
        await vi.advanceTimersByTimeAsync(TTL);
        await outcome;
        // Never deleted behind an unanswered request: left to expire by TTL.
        expect(client.has(KEY)).toBe(true);
    });

    it('bounds a release whose compare-delete never answers', async () => {
        vi.useFakeTimers();
        const client = new FakeValkey();
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        await lock.acquire();
        vi.spyOn(client, 'customCommand').mockImplementation(() => new Promise(() => {}));
        const releasing = lock.release();
        await vi.advanceTimersByTimeAsync(TTL);
        await expect(releasing).resolves.toBeUndefined(); // tolerant: logged only
    });
});

describe('LeaderLock hung renewal', () => {
    // A renew whose reply never arrives (paused connection, stalled server) used
    // to count as neither success nor failure: the loop kept the stale belief
    // forever while the key expired and a peer acquired it (dual leader).
    let client: FakeValkey;
    let hrtimeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        client = new FakeValkey();
        // Monotonic clock driven by the fake timers.
        hrtimeSpy = vi
            .spyOn(process.hrtime, 'bigint')
            .mockImplementation(() => BigInt(Date.now()) * 1_000_000n) as unknown as ReturnType<
            typeof vi.spyOn
        >;
    });
    afterEach(() => {
        hrtimeSpy.mockRestore();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    function hangRenewals(): { calls: () => number } {
        const command = client.customCommand.bind(client);
        let renewCalls = 0;
        vi.spyOn(client, 'customCommand').mockImplementation(async (args) => {
            if (args[0] === 'EVAL' && args[1].includes('PEXPIRE')) {
                renewCalls++;
                return new Promise<never>(() => {});
            }
            return command(args);
        });
        return { calls: () => renewCalls };
    }

    it('declares loss before the TTL elapses while a renew never resolves', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        const onLost = vi.fn();
        lock.onLost(onLost);
        expect(await lock.acquire()).toBe(true);
        const renew = hangRenewals();

        await vi.advanceTimersByTimeAsync(TTL - 1_000 - 1);
        expect(onLost).not.toHaveBeenCalled();
        expect(lock.isHeld()).toBe(true);

        await vi.advanceTimersByTimeAsync(1);
        expect(onLost).toHaveBeenCalledTimes(1);
        expect(lock.isHeld()).toBe(false);
        // Only one renew was ever issued: the loop does not stack behind it.
        expect(renew.calls()).toBe(1);

        await vi.advanceTimersByTimeAsync(TTL * 2);
        expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('detects the deadline between renew ticks for a long renew interval', async () => {
        // ttl 30s / renew 10s: ticks at 10s, 20s, 30s. The loss must fire at
        // 24s (ttl - ttl/5), not at the 30s tick when the key is already gone.
        const lock = new LeaderLock(client, KEY, 'holder-1', 30_000, 10_000);
        const onLost = vi.fn();
        lock.onLost(onLost);
        expect(await lock.acquire()).toBe(true);
        hangRenewals();

        await vi.advanceTimersByTimeAsync(23_999);
        expect(onLost).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('a confirmed renewal moves the deadline forward', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        const onLost = vi.fn();
        lock.onLost(onLost);
        expect(await lock.acquire()).toBe(true);

        // First renew (sent at t=2s) succeeds; then renewals hang.
        await vi.advanceTimersByTimeAsync(RENEW);
        expect(client.renewCalls).toBe(1);
        hangRenewals();

        // Deadline is now 2s + 4s = 6s, past the 4s acquire-based one.
        await vi.advanceTimersByTimeAsync(3_999);
        expect(onLost).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('fast renew errors declare loss at the same deadline', async () => {
        const lock = new LeaderLock(client, KEY, 'holder-1', TTL, RENEW);
        const onLost = vi.fn();
        lock.onLost(onLost);
        expect(await lock.acquire()).toBe(true);
        const command = client.customCommand.bind(client);
        vi.spyOn(client, 'customCommand').mockImplementation(async (args) => {
            if (args[0] === 'EVAL' && args[1].includes('PEXPIRE'))
                throw new Error('connection reset');
            return command(args);
        });

        await vi.advanceTimersByTimeAsync(3_999);
        expect(onLost).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onLost).toHaveBeenCalledTimes(1);
    });
});

vi.mock('./lua/fenced.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lua/fenced.js')>();
    return {
        ...actual,
        invokeFencedValkey: async (
            source: string,
            keys: string[],
            args: (string | number)[],
            client: ValkeyLike,
        ): Promise<unknown> => {
            const argv = args.map(String);
            if (source.includes("return redis.call('GET'"))
                return client.customCommand(['GET', keys[0]]);
            if (source.includes("return redis.call('SET'"))
                return client.customCommand(['SET', keys[0], argv[0], 'NX', 'PX', argv[1]]);
            return client.customCommand(['EVAL', source, String(keys.length), ...keys, ...argv]);
        },
    };
});
