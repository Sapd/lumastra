// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    acquireBudget,
    acquireSemaphoreToken,
    clampedDecr,
    refreshSemaphoreTtl,
    getBudgetUsage,
    resetBudgetCounters,
    isExpressPriority,
    EXPRESS_PRIORITY_MAX,
} from './budget-semaphore.js';
import type { ResourceClass } from '@sapd/lumastra-plugin-sdk';

// ── Stub Valkey client ───────────────────────────────────────────────────────

interface CallRecord {
    cmd: string[];
}

function makeClient(opts: { initialCounters?: Map<string, number> } = {}) {
    const counters = opts.initialCounters ?? new Map<string, number>();
    const calls: CallRecord[] = [];
    const errs = new Map<string, Error>();
    // Last TTL (seconds) applied per key via EXPIRE — lets tests assert that
    // ACQUIRE_LUA and refreshSemaphoreTtl set/refresh the TTL backstop.
    const ttls = new Map<string, number>();

    const client = {
        calls,
        counters,
        ttls,
        // Used by tests to simulate a Valkey failure on a specific command shape.
        setError(prefix: string, err: Error) {
            errs.set(prefix, err);
        },
        async customCommand(cmd: string[]): Promise<unknown> {
            calls.push({ cmd });
            const head = `${cmd[0]} ${cmd[1] ?? ''}`.trim();
            for (const [prefix, err] of errs) {
                if (head.startsWith(prefix)) throw err;
            }
            switch (cmd[0]) {
                case 'EVAL': {
                    // Simulate ACQUIRE_LUA: KEYS[1]=cmd[3], cap=cmd[4], ttl=cmd[5].
                    // Atomic check-and-increment — never increments past cap;
                    // returns -1 at capacity, else the new count. On a successful
                    // increment it EXPIREs the key (TTL backstop refresh).
                    const key = cmd[3];
                    const cap = Number(cmd[4]);
                    const ttl = Number(cmd[5]);
                    const cur = counters.get(key) ?? 0;
                    if (cur >= cap) return -1;
                    const next = cur + 1;
                    counters.set(key, next);
                    ttls.set(key, ttl);
                    return next;
                }
                case 'INCR': {
                    const key = cmd[1];
                    const next = (counters.get(key) ?? 0) + 1;
                    counters.set(key, next);
                    return next;
                }
                case 'DECR': {
                    const key = cmd[1];
                    const next = (counters.get(key) ?? 0) - 1;
                    counters.set(key, next);
                    return next;
                }
                case 'EXPIRE': {
                    const key = cmd[1];
                    // EXPIRE on a missing key returns 0 (and sets no TTL).
                    if (!counters.has(key)) return 0;
                    ttls.set(key, Number(cmd[2]));
                    return 1;
                }
                case 'DEL': {
                    const key = cmd[1];
                    const existed = counters.has(key) ? 1 : 0;
                    counters.delete(key);
                    return existed;
                }
                case 'GET': {
                    const key = cmd[1];
                    const v = counters.get(key);
                    return v === undefined ? null : String(v);
                }
                default:
                    return null;
            }
        },
    };
    return client;
}

const CPU: ResourceClass = 'cpu';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('acquireBudget', () => {
    it('grants a token when under cap', async () => {
        const client = makeClient();
        const a = await acquireBudget(client, CPU, () => 2);
        expect(a.acquired).toBe(true);
        expect(client.counters.get('task:resource-budget:cpu')).toBe(1);
    });

    it('refuses at cap WITHOUT incrementing past cap (atomic, leak-free)', async () => {
        const client = makeClient({
            initialCounters: new Map([['task:resource-budget:cpu', 2]]),
        });
        const a = await acquireBudget(client, CPU, () => 2);
        expect(a.acquired).toBe(false);
        // Atomic Lua never increments past cap — counter stays at 2 (the old
        // INCR-to-3-then-DECR path could leak a token if the DECR failed).
        expect(client.counters.get('task:resource-budget:cpu')).toBe(2);
    });

    it('never exceeds cap even across many contended acquire attempts', async () => {
        const client = makeClient();
        // 50 concurrent attempts on cap=4 → exactly 4 acquired, counter == 4.
        const results = await Promise.all(
            Array.from({ length: 50 }, () => acquireBudget(client, CPU, () => 4)),
        );
        expect(results.filter((r) => r.acquired).length).toBe(4);
        expect(client.counters.get('task:resource-budget:cpu')).toBe(4);
    });

    it('refuses without touching Valkey when cap is 0', async () => {
        const client = makeClient();
        const a = await acquireBudget(client, CPU, () => 0);
        expect(a.acquired).toBe(false);
        expect(client.calls).toHaveLength(0);
    });

    it('release is idempotent — second call is a no-op', async () => {
        const client = makeClient();
        const a = await acquireBudget(client, CPU, () => 2);
        expect(a.acquired).toBe(true);
        expect(client.counters.get('task:resource-budget:cpu')).toBe(1);
        await a.release();
        expect(client.counters.get('task:resource-budget:cpu')).toBe(0);
        await a.release(); // no-op
        expect(client.counters.get('task:resource-budget:cpu')).toBe(0);
    });

    it('refuse path returns a no-op release that can be safely called', async () => {
        const client = makeClient({
            initialCounters: new Map([['task:resource-budget:cpu', 2]]),
        });
        const a = await acquireBudget(client, CPU, () => 2);
        expect(a.acquired).toBe(false);
        await a.release(); // should not throw and not DECR (already DECR'd in acquire)
        expect(client.counters.get('task:resource-budget:cpu')).toBe(2);
    });

    it('three concurrent acquires on cap=2 → two succeed, one refused', async () => {
        const client = makeClient();
        const results = await Promise.all([
            acquireBudget(client, CPU, () => 2),
            acquireBudget(client, CPU, () => 2),
            acquireBudget(client, CPU, () => 2),
        ]);
        const acquiredCount = results.filter((r) => r.acquired).length;
        expect(acquiredCount).toBe(2);
        expect(client.counters.get('task:resource-budget:cpu')).toBe(2);
    });

    it('release after concurrent acquire frees a slot for next acquire', async () => {
        const client = makeClient();
        const first = await acquireBudget(client, CPU, () => 1);
        expect(first.acquired).toBe(true);
        const second = await acquireBudget(client, CPU, () => 1);
        expect(second.acquired).toBe(false);
        await first.release();
        const third = await acquireBudget(client, CPU, () => 1);
        expect(third.acquired).toBe(true);
    });

    it('clamps under-zero counter via DEL — release racing reset', async () => {
        const client = makeClient();
        // Manually set the counter below zero to simulate a release racing
        // a boot-recovery reset.
        client.counters.set('task:resource-budget:cpu', -1);
        const a = await acquireBudget(client, CPU, () => 2);
        // INCR took -1 → 0, which is ≤ cap=2, so acquired.
        expect(a.acquired).toBe(true);
        await a.release();
        // DECR took 0 → -1, which our safeDecr clamps via DEL.
        expect(client.counters.has('task:resource-budget:cpu')).toBe(false);
    });

    it('returns acquired=false when the acquire EVAL throws', async () => {
        const client = makeClient();
        client.setError('EVAL', new Error('valkey down'));
        const a = await acquireBudget(client, CPU, () => 2);
        expect(a.acquired).toBe(false);
        // No token taken on failure — counter untouched.
        expect(client.counters.has('task:resource-budget:cpu')).toBe(false);
    });
});

describe('isExpressPriority', () => {
    it('treats priorities at/below the express threshold as express', () => {
        expect(isExpressPriority(1)).toBe(true);
        expect(isExpressPriority(EXPRESS_PRIORITY_MAX)).toBe(true);
    });

    it('treats higher numbers (lower urgency) and undefined as background', () => {
        expect(isExpressPriority(3)).toBe(false);
        expect(isExpressPriority(5)).toBe(false);
        expect(isExpressPriority(undefined)).toBe(false);
        // 0 / negative are not valid BullMQ priorities — never express.
        expect(isExpressPriority(0)).toBe(false);
    });
});

describe('acquireBudget — express-lane reservation', () => {
    const BUDGET_KEY = 'task:resource-budget:cpu';

    it('holds a BACKGROUND run one token below cap (reserves the express slot)', async () => {
        // cap=4 → background admitted only up to 3; the 4th attempt defers.
        const client = makeClient({ initialCounters: new Map([[BUDGET_KEY, 3]]) });
        const bg = await acquireBudget(client, CPU, () => 4, { reserveForExpress: true });
        expect(bg.acquired).toBe(false);
        expect(client.counters.get(BUDGET_KEY)).toBe(3);
    });

    it('lets an EXPRESS run claim the reserved token at cap-1', async () => {
        // Same state (3/4 used). A background run defers, but an express run
        // (reserveForExpress: false) takes the 4th, reserved token.
        const client = makeClient({ initialCounters: new Map([[BUDGET_KEY, 3]]) });
        const express = await acquireBudget(client, CPU, () => 4, { reserveForExpress: false });
        expect(express.acquired).toBe(true);
        expect(client.counters.get(BUDGET_KEY)).toBe(4);
    });

    it('does NOT reserve for small classes (cap below the reserve floor)', async () => {
        // cap=2 (< EXPRESS_RESERVE_MIN_CAP=3): background keeps the full cap so a
        // slow class is not gutted; reservation simply does not apply here.
        const client = makeClient({ initialCounters: new Map([[BUDGET_KEY, 1]]) });
        const bg = await acquireBudget(client, CPU, () => 2, { reserveForExpress: true });
        expect(bg.acquired).toBe(true);
        expect(client.counters.get(BUDGET_KEY)).toBe(2);
    });

    it('defaults to no reservation when opts omitted (back-compat)', async () => {
        const client = makeClient({ initialCounters: new Map([[BUDGET_KEY, 3]]) });
        const a = await acquireBudget(client, CPU, () => 4);
        expect(a.acquired).toBe(true);
        expect(client.counters.get(BUDGET_KEY)).toBe(4);
    });
});

describe('getBudgetUsage', () => {
    it('reads current count without acquiring', async () => {
        const client = makeClient({
            initialCounters: new Map([['task:resource-budget:cpu', 3]]),
        });
        expect(await getBudgetUsage(client, CPU)).toBe(3);
        // GET only — no INCR/DECR.
        const sideEffects = client.calls.filter((c) => c.cmd[0] !== 'GET');
        expect(sideEffects).toHaveLength(0);
    });

    it('returns 0 for missing key', async () => {
        const client = makeClient();
        expect(await getBudgetUsage(client, CPU)).toBe(0);
    });
});

describe('resetBudgetCounters', () => {
    it('DELs counters and reports count reset', async () => {
        const client = makeClient({
            initialCounters: new Map([
                ['task:resource-budget:cpu', 3],
                ['task:resource-budget:io', 1],
            ]),
        });
        const result = await resetBudgetCounters(client, ['cpu', 'io', 'embedding'] as const);
        expect(result.reset).toBe(2); // embedding wasn't set
        expect(client.counters.has('task:resource-budget:cpu')).toBe(false);
        expect(client.counters.has('task:resource-budget:io')).toBe(false);
    });
});

// The generic primitive shared by the class budget AND the per-task
// `task:active-count:<taskId>` counter in runner.ts. These exercise it on a
// per-task-shaped key to mirror the runner's call.
describe('acquireSemaphoreToken (per-task counter primitive)', () => {
    const KEY = 'task:active-count:my-task';

    it('acquires under cap, returning the new count and refreshing the TTL', async () => {
        const client = makeClient();
        const a = await acquireSemaphoreToken(client, KEY, 2, 300);
        expect(a.acquired).toBe(true);
        expect(a.count).toBe(1);
        expect(client.counters.get(KEY)).toBe(1);
        // ACQUIRE_LUA's EXPIRE seeds the TTL backstop.
        expect(client.ttls.get(KEY)).toBe(300);
    });

    it('NEVER exceeds cap under the atomic Lua — stops at cap, returns not-acquired', async () => {
        const client = makeClient();
        // 50 concurrent attempts on cap=3 → exactly 3 acquired, counter == 3,
        // and every refusal reports count = -1 without incrementing past cap.
        const results = await Promise.all(
            Array.from({ length: 50 }, () => acquireSemaphoreToken(client, KEY, 3, 300)),
        );
        expect(results.filter((r) => r.acquired).length).toBe(3);
        expect(client.counters.get(KEY)).toBe(3);
        for (const r of results.filter((x) => !x.acquired)) {
            expect(r.count).toBe(-1);
        }
    });

    it('at cap → not acquired, count -1, counter untouched (no INCR-past-cap)', async () => {
        const client = makeClient({ initialCounters: new Map([[KEY, 2]]) });
        const a = await acquireSemaphoreToken(client, KEY, 2, 300);
        expect(a.acquired).toBe(false);
        expect(a.count).toBe(-1);
        // The old raw-INCR path would have pushed this to 3 then DECR'd;
        // the atomic Lua never touches it.
        expect(client.counters.get(KEY)).toBe(2);
    });

    it('cap<=0 disables the gate without touching Valkey', async () => {
        const client = makeClient();
        const a = await acquireSemaphoreToken(client, KEY, 0, 300);
        expect(a.acquired).toBe(false);
        expect(a.count).toBe(-1);
        expect(client.calls).toHaveLength(0);
    });

    it('release is idempotent', async () => {
        const client = makeClient();
        const a = await acquireSemaphoreToken(client, KEY, 2, 300);
        expect(client.counters.get(KEY)).toBe(1);
        await a.release();
        expect(client.counters.get(KEY)).toBe(0);
        await a.release(); // no-op
        expect(client.counters.get(KEY)).toBe(0);
    });
});

describe('refreshSemaphoreTtl', () => {
    const KEY = 'task:active-count:my-task';

    it('extends the TTL of an existing key', async () => {
        const client = makeClient({ initialCounters: new Map([[KEY, 1]]) });
        client.ttls.set(KEY, 50); // simulate a key whose TTL has been ticking down
        await refreshSemaphoreTtl(client, KEY, 300);
        expect(client.ttls.get(KEY)).toBe(300);
        // Refresh must NOT mutate the counter value.
        expect(client.counters.get(KEY)).toBe(1);
    });

    it('is a no-op (does not throw) when the key has already expired', async () => {
        const client = makeClient();
        await expect(refreshSemaphoreTtl(client, KEY, 300)).resolves.toBeUndefined();
        // EXPIRE on a missing key sets no TTL.
        expect(client.ttls.has(KEY)).toBe(false);
    });

    it('swallows Valkey errors with a WARN (never throws into the heartbeat)', async () => {
        const client = makeClient({ initialCounters: new Map([[KEY, 1]]) });
        client.setError('EXPIRE', new Error('valkey down'));
        await expect(refreshSemaphoreTtl(client, KEY, 300)).resolves.toBeUndefined();
    });
});

// C1 — the shared negative-clamping DECR used by BOTH the class-budget release
// (this module) and the runner's per-task `task:active-count:<taskId>` release.
// A reconciler-clear race can leave a counter at "-1"; the acquire Lua's
// `tonumber(GET) or '0'` does NOT rescue the STRING "-1" (it's not nil), so the
// over-limit gate passes and over-admits by 1. The clamp DELs a negative counter
// back to absent, restoring the "key absent → 0" invariant.
describe('clampedDecr (C1 shared negative-clamp)', () => {
    const KEY = 'task:active-count:my-task';

    it('DELs a counter that DECRs below zero so the acquire gate cannot over-admit', async () => {
        const client = makeClient();
        // Simulate the race: reconciler cleared the counter to its target a
        // moment before this terminal DECR fires, so it sits at 0; the DECR
        // would take it to -1.
        client.counters.set(KEY, 0);
        await clampedDecr(client, KEY, () => {});
        // Negative result → clamped via DEL → key absent.
        expect(client.counters.has(KEY)).toBe(false);
        // And a subsequent acquire then reads the key as absent (== 0), NOT as
        // the over-admitting string "-1".
        const a = await acquireSemaphoreToken(client, KEY, 1, 300);
        expect(a.acquired).toBe(true);
        expect(a.count).toBe(1);
    });

    it('leaves a still-positive counter intact (normal release)', async () => {
        const client = makeClient({ initialCounters: new Map([[KEY, 2]]) });
        await clampedDecr(client, KEY, () => {});
        expect(client.counters.get(KEY)).toBe(1);
    });

    it('DELs exactly at the zero boundary (DECR 0 → -1 → absent)', async () => {
        const client = makeClient({ initialCounters: new Map([[KEY, 1]]) });
        await clampedDecr(client, KEY, () => {}); // 1 → 0, stays
        expect(client.counters.get(KEY)).toBe(0);
        await clampedDecr(client, KEY, () => {}); // 0 → -1, clamped to absent
        expect(client.counters.has(KEY)).toBe(false);
    });

    it('routes DECR failures to the supplied warn and never throws', async () => {
        const client = makeClient({ initialCounters: new Map([[KEY, 1]]) });
        client.setError('DECR', new Error('valkey down'));
        const warned: Array<{ msg: string; meta: Record<string, unknown> }> = [];
        await expect(
            clampedDecr(client, KEY, (msg, meta) => warned.push({ msg, meta })),
        ).resolves.toBeUndefined();
        expect(warned).toHaveLength(1);
        expect(warned[0].meta).toMatchObject({ key: KEY });
    });
});
