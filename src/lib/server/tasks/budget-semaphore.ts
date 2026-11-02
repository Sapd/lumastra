// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// budget-semaphore.ts — class-wide concurrency token semaphore for Wave 8.5.
//
// In the current (pre-Wave-8.5) model, BullMQ Worker concurrency directly
// bounds how many of a class run at once. After Phase 1 of Wave 8.5 lands,
// every task gets its own BullMQ queue + Worker, and the class concurrency
// cap is enforced at a different layer: each worker acquires a token from
// this semaphore before invoking the plugin handler.
//
// Why we need this separate layer:
//   - Per-task Workers can each run N parallel jobs. The class budget caps
//     the total across all tasks sharing a class.
//   - Without a class-wide gate, three tasks each with maxConcurrent=2 on
//     class cpu (capacity 4) could spawn 6 ffmpeg processes simultaneously
//     and pin every host core.
//
// Mechanism:
//   - INCR-and-check pattern (matches existing `quotas.maxConcurrent` in
//     runner.ts:494-535). Cheaper than BLPOP, no waiting threads in Valkey.
//   - Acquire: INCR `task:resource-budget:<class>`; if > cap, DECR and
//     refuse. Caller back-pressures by retrying.
//   - Release: DECR. Idempotent — second release is a no-op.
//   - EXPIRE: set 5min TTL on the counter so a worker crash doesn't leak
//     a slot forever. Refreshed on every INCR (which the per-class
//     "you'd need to acquire before processing" cadence makes routine).
//
// Boot recovery: `reconcileBudgetCounters` in boot-recovery.ts is the
// authoritative path — it counts active runs per task in Postgres, rolls
// up to per-class targets via the registry, and atomically DECRBYs only
// the proven excess. Same algorithm as `sweepStaleActiveCounters` for the
// per-task counters. `resetBudgetCounters` below is the unconditional
// "DEL everything" form, kept for emergency admin reset; the periodic
// reconciler does NOT use it.

import type { ResourceClass } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';
import { type ValkeyLike, errMessage } from './valkey-types.js';

const log = Logger.for('BudgetSemaphore');

const BUDGET_KEY_PREFIX = 'task:resource-budget';

/**
 * Shared semaphore TTL backstop (5 min). A worker crash is normally recovered
 * by boot-recovery's counter reconcile; this TTL is the last-resort backstop
 * that frees a leaked token if *every* holder dies (e.g. a hard crash before
 * boot-recovery runs). The per-task `task:active-count:<taskId>` counter in
 * runner.ts uses the SAME constant so the two counters age out identically —
 * and as long as any live run heartbeats, `refreshSemaphoreTtl` keeps the key
 * alive (the heartbeat interval is ~30s vs this 300s, a 10x margin).
 */
export const BUDGET_TTL_SECONDS = 300; // 5 min — worker crashes are recovered by boot-recovery; this is just a backstop

/**
 * BullMQ priorities at or below this value are "express" — admin/manual runs
 * that should jump ahead of background work. Two coupled behaviours hang off
 * this single threshold so they can't drift apart:
 *   - `orchestrator.priorityFromTrigger('manual')` returns this value, and
 *   - `acquireBudget({ reserveForExpress })` holds BACKGROUND runs to one token
 *     below the class cap so an express run almost always finds a free slot
 *     without anything being cancelled (the "express lane").
 * Keep this ≥ the highest priority any admin route passes explicitly (admin
 * "force"/"retry now" routes pass priority 1), so those count as express too.
 */
export const EXPRESS_PRIORITY_MAX = 2;

/**
 * The express lane reserves a token only for classes whose cap is at least
 * this large, so a small class never has its background throughput gutted to
 * hold a usually-idle slot. At cap=4 (io) reservation costs 25% headroom; at
 * cap=2 (embedding) it would cost 50% and halve a slow, important class. Below
 * this floor, express runs still jump the queue via priority but wait for a
 * natural slot — bump `LUMASTRA_CONCURRENCY_<class>` to 3+ to opt that class in.
 */
export const EXPRESS_RESERVE_MIN_CAP = 3;

/**
 * True when a BullMQ priority counts as an express (admin/manual) run. A missing
 * priority (undefined) is treated as background — only an explicit low number
 * earns the reserved lane. Lower BullMQ priority = more urgent.
 */
export function isExpressPriority(priority: number | undefined): boolean {
    return typeof priority === 'number' && priority > 0 && priority <= EXPRESS_PRIORITY_MAX;
}

export interface BudgetAcquisition {
    /** True if a token was acquired and the caller may proceed. */
    acquired: boolean;
    /**
     * Release the token. Safe to call any number of times — only the
     * first non-no-op release actually DECRs. Always invoke in a
     * `finally` to guarantee release even on plugin throw.
     */
    release: () => Promise<void>;
}

const NOOP_RELEASE: BudgetAcquisition['release'] = async () => {
    /* nothing held */
};

/**
 * Generic, key-addressed semaphore acquire — the single shared primitive
 * behind BOTH concurrency counters:
 *   - the class budget (`task:resource-budget:<class>`) via `acquireBudget`, and
 *   - the per-task ceiling (`task:active-count:<taskId>`) in runner.ts.
 *
 * Runs the atomic check-and-INCR `ACQUIRE_LUA` against an arbitrary key and
 * returns an idempotent `release()` plus the post-INCR `count` (-1 when at
 * capacity / not acquired). Keeping the GET<cap check and the INCR in one Lua
 * step is what makes the counter leak-free under high-frequency contended
 * acquires: it NEVER increments past cap, and there is no reject-side DECR to
 * leak a token if a subsequent Valkey command fails. The EXPIRE inside the Lua
 * refreshes the TTL backstop on every successful acquire.
 */
export async function acquireSemaphoreToken(
    client: ValkeyLike,
    key: string,
    cap: number,
    ttlSeconds: number,
): Promise<BudgetAcquisition & { count: number }> {
    if (cap <= 0) {
        // Cap of 0 (or negative) means "disabled" — refuse without touching
        // Valkey so a misconfigured class/task can't take a token.
        return { acquired: false, count: -1, release: NOOP_RELEASE };
    }

    let countAfter: number;
    try {
        const raw = await client.customCommand([
            'EVAL',
            ACQUIRE_LUA,
            '1',
            key,
            String(cap),
            String(ttlSeconds),
        ]);
        countAfter = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(countAfter)) {
            // Malformed result — refuse rather than assume a token was taken.
            return { acquired: false, count: -1, release: NOOP_RELEASE };
        }
    } catch (err) {
        log.warn('semaphore acquire EVAL failed', { key, err: errMessage(err) });
        return { acquired: false, count: -1, release: NOOP_RELEASE };
    }

    if (countAfter < 0) {
        // At capacity — the Lua did not increment, so nothing to return.
        return { acquired: false, count: -1, release: NOOP_RELEASE };
    }

    // Acquired. Build a release closure with idempotency.
    let released = false;
    const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        await safeDecr(client, key);
    };
    return { acquired: true, count: countAfter, release };
}

/**
 * Best-effort TTL refresh for a semaphore counter key. The heartbeat calls
 * this for both the per-task counter and the class budget of a running task so
 * a long-running task's shared counters don't expire mid-run and let another
 * worker over-admit past cap. Swallows errors with a WARN — a missed refresh is
 * recovered by the next beat (10x margin between the ~30s beat and the 300s
 * TTL), and a throw here must never abort the heartbeat loop. Uses EXPIRE
 * (whole-second TTL) to mirror the EXPIRE inside `ACQUIRE_LUA`. A no-op when the
 * key has already expired/been deleted (EXPIRE on a missing key returns 0).
 */
export async function refreshSemaphoreTtl(
    client: ValkeyLike,
    key: string,
    ttlSeconds: number,
): Promise<void> {
    try {
        await client.customCommand(['EXPIRE', key, String(ttlSeconds)]);
    } catch (err) {
        log.warn('semaphore TTL refresh failed', { key, err: errMessage(err) });
    }
}

/**
 * Attempt to acquire one token from the class's resource budget. Returns
 * `acquired: false` when the class is at capacity; caller should back off
 * (BullMQ retry / next pop tick).
 *
 * The cap is read fresh each call from `getCap(cls)` so config changes
 * via env override take effect on the next acquire without restart. Delegates
 * to the shared `acquireSemaphoreToken` primitive (same atomic Lua used by the
 * per-task counter in runner.ts); the public signature is unchanged.
 */
export async function acquireBudget(
    client: ValkeyLike,
    cls: ResourceClass,
    getCap: (cls: ResourceClass) => number,
    opts?: { reserveForExpress?: boolean },
): Promise<BudgetAcquisition> {
    const key = `${BUDGET_KEY_PREFIX}:${cls}`;
    const cap = getCap(cls);
    // Express lane: background runs are admitted only up to `cap - 1`, leaving
    // one token free for an admin/manual (express) run so it starts promptly
    // without preempting anything. Express runs themselves use the full `cap`,
    // so they can claim that reserved last token. Only classes at/above
    // EXPRESS_RESERVE_MIN_CAP reserve — small classes keep full background
    // throughput (see the constant's rationale).
    const effectiveCap = opts?.reserveForExpress && cap >= EXPRESS_RESERVE_MIN_CAP ? cap - 1 : cap;
    const { acquired, release } = await acquireSemaphoreToken(
        client,
        key,
        effectiveCap,
        BUDGET_TTL_SECONDS,
    );
    return { acquired, release };
}

/**
 * Atomic acquire: increment only when below cap, refresh the TTL, and report
 * the new count; return -1 at capacity without touching the counter. Keeping
 * the check and the increment in one Lua step is what makes the semaphore
 * leak-free under high-frequency contended acquires.
 */
const ACQUIRE_LUA = `
local cap = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur >= cap then
  return -1
end
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ttl)
return n
`;

/**
 * Reset all budget counters to zero. Intended for boot-recovery once the
 * three-signal classifier has marked orphan runs failed — any token still
 * held by a dead worker is by definition stale at that point. Subsequent
 * acquires rebuild from real running counts.
 */
export async function resetBudgetCounters(
    client: ValkeyLike,
    classes: readonly ResourceClass[],
): Promise<{ reset: number }> {
    let reset = 0;
    for (const cls of classes) {
        const key = `${BUDGET_KEY_PREFIX}:${cls}`;
        try {
            const existed = await client.customCommand(['DEL', key]);
            if ((typeof existed === 'number' ? existed : Number(existed)) > 0) {
                reset += 1;
            }
        } catch (err) {
            log.warn('budget reset failed', { cls, err: errMessage(err) });
        }
    }
    return { reset };
}

/**
 * Read current usage for a class without acquiring. Used by admin
 * surfaces to render "cpu: 3/4 tokens in use" without taking a token.
 */
export async function getBudgetUsage(client: ValkeyLike, cls: ResourceClass): Promise<number> {
    const key = `${BUDGET_KEY_PREFIX}:${cls}`;
    try {
        const raw = await client.customCommand(['GET', key]);
        if (raw === null || raw === undefined) return 0;
        const parsed = Number(raw);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } catch (err) {
        log.warn('budget read failed', { cls, err: errMessage(err) });
        return 0;
    }
}

async function safeDecr(client: ValkeyLike, key: string): Promise<void> {
    await clampedDecr(client, key, (msg, meta) => log.warn(msg, meta));
}

/**
 * Shared negative-clamping DECR for the concurrency counters. DECR a key and, if
 * the post-DECR value is negative, DEL it so the next acquire restarts cleanly
 * from 0.
 *
 * Why the clamp matters (C1): a reconciler-clear race (boot-recovery DECRBYs the
 * counter down to its DB-authoritative target a moment before a run's own
 * terminal DECR fires) can leave the counter at `-1`. The acquire Lua's
 * `tonumber(redis.call('GET', KEYS[1]) or '0')` does NOT rescue this: the key
 * holds the STRING `"-1"`, so the `or '0'` fallback never triggers and `cur` is
 * `-1`, which is `< cap` → the over-limit gate passes and the class / task
 * over-admits by one. Clamping a negative counter back to absent restores the
 * "key absent → treat as 0" invariant the gate relies on. Mirrors the
 * negative-counter self-heal in boot-recovery's RECONCILE_LUA.
 *
 * Both the runner's per-task `task:active-count:<taskId>` release and this
 * module's class-budget release route through this helper so the clamp is
 * applied identically on both counters. Best-effort throughout — a DECR failure
 * is logged via the caller-supplied `warn` and recovered by the next boot /
 * reconciler sweep; it must never throw into a terminal-release path.
 */
export async function clampedDecr(
    client: ValkeyLike,
    key: string,
    warn: (msg: string, meta: Record<string, unknown>) => void,
): Promise<void> {
    try {
        const raw = await client.customCommand(['DECR', key]);
        const value = typeof raw === 'number' ? raw : Number(raw);
        // DECR can drift below 0 if a release races a reconciler clear. Clamp by
        // deleting — DEL is cheaper than SET 0 since the counter restarts on the
        // next acquire anyway, AND a negative string value ("-1") would defeat
        // the acquire Lua's `or '0'` fallback and silently over-admit by 1 (C1).
        if (Number.isFinite(value) && value < 0) {
            try {
                await client.customCommand(['DEL', key]);
            } catch {
                /* best-effort */
            }
        }
    } catch (err) {
        warn('counter DECR failed', { key, err: errMessage(err) });
    }
}
