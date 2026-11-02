// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Non-progress backoff for GLOBAL-IDENTITY coverage enqueues.
 *
 * WHY THIS EXISTS — prod incident 2026-07-08 → 2026-07-15
 * ------------------------------------------------------
 * `mdblist-sync` declares `schedule: { every: '12h' }`. It ran **1,037×/day**
 * and burned the entire MDBList daily API quota for a week.
 *
 * Only `scheduler.ts` honours a task's declared cadence. `stage-sweep` enqueues
 * any stage with `coversStages[].enqueueable: true` on its OWN 60s tick,
 * bypassing the scheduler, and nothing bounded that:
 *   - `exclusiveWith` is a concurrency mutex, released the instant a run reaches
 *     terminal state — it never blocks a *sequential* re-fire.
 *   - the `coverage:<stage>:global` idempotency key matches only
 *     pending/active/cancelling runs, so a COMPLETED run is not a dedup hit.
 * A bug left 828 rows permanently `pending`, so every 60s tick found a backlog,
 * started a run that cleared nothing, and repeated — while each run reported
 * `success: true`.
 *
 * So `schedule.every` is a FLOOR, not a ceiling. This supplies the missing
 * ceiling, but ONLY while the loop makes no progress — a healthy backlog still
 * drains at full sweep speed. The signal is the stage's own backlog count: if it
 * did not shrink since the last enqueue, the previous run accomplished nothing,
 * so back off exponentially, capped at the task's declared `schedule.every` (the
 * cadence its author already deemed correct).
 *
 * FAIL-OPEN BY DESIGN. Every uncertainty resolves to "allow the enqueue":
 * Valkey down, unparseable state, or a backlog pinned at the count ceiling
 * (where progress is unmeasurable) never throttles. Wrongly throttling real work
 * is worse than wrongly permitting a wasted run — the worst case here is
 * degrading to the declared cadence, which is by definition acceptable.
 *
 * Call ONLY on the global-identity path. Per-item enqueues each represent one
 * distinct unit of urgent work and must never be throttled by another item.
 */

import { createHash } from 'node:crypto';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { TimeUnit } from '@valkey/valkey-glide';
import { BACKLOG_COUNT_CEILING } from '$lib/server/database/queries/stage-sweep.queries.js';

// `task:` routes to the noeviction coordination instance (see
// COORDINATION_KEY_PREFIXES). Do NOT rename to a prefix that lands on the
// volatile-lru cache — evicted state silently disables the backoff.
const KEY_PREFIX = 'task:coverage-backoff:';

/** Delay applied after the FIRST non-progressing run; doubles from there. */
const BASE_DELAY_MS = 2 * 60_000;

/** Ceiling for tasks declaring no `schedule.every` (e.g. `metadata-update`). */
const DEFAULT_CAP_MS = 60 * 60_000;

interface BackoffState {
    /** Backlog observed at the last permitted enqueue. */
    backlog: number;
    /** Fingerprint of the candidate ids observed at the last permitted enqueue. */
    fingerprint: string;
    /** Consecutive non-progressing enqueues. 0 = healthy. */
    level: number;
    /** Epoch ms before which no further enqueue is permitted. */
    nextAt: number;
}

/**
 * Fingerprint the candidate ids the sweep is about to hand a task.
 *
 * `findSweepCandidates` orders by `next_eligible_at ASC NULLS FIRST, updated_at
 * ASC` — oldest first — so freshly-arrived work sorts to the BACK and cannot
 * disturb the head of the page. If the identical head comes back tick after
 * tick, the previous run cleared none of it. (In the mdblist incident the stuck
 * rows' `updated_at` never moved for 7 days, so this set was provably stable.)
 */
export function fingerprintCandidates(ids: readonly string[]): string {
    return createHash('sha1')
        .update([...ids].sort().join(','))
        .digest('hex')
        .slice(0, 16);
}

export interface BackoffDecision {
    skip: boolean;
    /** Only meaningful when `skip` — time until the next enqueue is permitted. */
    retryInMs?: number;
    /** Consecutive non-progressing rounds. 0 while draining normally. */
    level: number;
}

const ALLOW: BackoffDecision = { skip: false, level: 0 };

function keyFor(taskId: string, stageId: string): string {
    return `${KEY_PREFIX}${taskId}:${stageId}`;
}

function parseState(raw: string | null): BackoffState | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Partial<BackoffState>;
        if (
            typeof v.backlog !== 'number' ||
            typeof v.fingerprint !== 'string' ||
            typeof v.level !== 'number' ||
            typeof v.nextAt !== 'number'
        ) {
            return null;
        }
        return {
            backlog: v.backlog,
            fingerprint: v.fingerprint,
            level: v.level,
            nextAt: v.nextAt,
        };
    } catch {
        return null;
    }
}

function toStringValue(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
    if (v instanceof Buffer) return v.toString('utf8');
    return String(v);
}

/**
 * Decide whether a global-identity coverage enqueue may proceed, recording the
 * observation. Call immediately BEFORE `orchestrator.startRun`.
 *
 * @param backlog Current sweepable backlog for the stage (`countSweepBacklog`).
 *                A value at {@link BACKLOG_COUNT_CEILING} means "at least that
 *                many" — progress is unmeasurable, so we never throttle.
 * @param scheduleEveryMs The task's declared cadence, used as the backoff cap.
 */
export async function shouldSkipGlobalEnqueue(opts: {
    taskId: string;
    stageId: string;
    backlog: number;
    fingerprint: string;
    scheduleEveryMs?: number | null;
    now?: number;
}): Promise<BackoffDecision> {
    const now = opts.now ?? Date.now();

    // A ceiling-pinned count cannot reveal progress: a backlog draining 50k→40k
    // reads as the ceiling both times and would look stuck. Never throttle on an
    // unmeasurable signal — a stuck backlog that large is caught by the
    // `dormant-stage-with-backlog` invariant instead.
    if (opts.backlog >= BACKLOG_COUNT_CEILING) return ALLOW;

    const client = getCoordinationClient();
    if (!client) return ALLOW; // fail-open: a cache outage must not stall coverage

    const key = keyFor(opts.taskId, opts.stageId);

    let prev: BackoffState | null;
    try {
        prev = parseState(toStringValue(await client.get(key)));
    } catch {
        return ALLOW;
    }

    if (prev && now < prev.nextAt) {
        return { skip: true, retryInMs: prev.nextAt - now, level: prev.level };
    }

    // Two independent progress signals; ANY evidence of progress clears the
    // backoff. Only when the exact same head-of-backlog comes back AND the total
    // hasn't shrunk do we conclude the previous run accomplished nothing — the
    // precise mdblist signature. Requiring both keeps a task that drains items
    // the sweep didn't name (its own backlog query may order differently), or
    // one whose count is masked by new arrivals, from being throttled while it
    // is genuinely working.
    const madeProgress =
        !prev || opts.fingerprint !== prev.fingerprint || opts.backlog < prev.backlog;
    // Safe: madeProgress is false only when `!prev` is false, i.e. prev is non-null here.
    const level = madeProgress ? 0 : prev!.level + 1;

    const cap = Math.max(0, opts.scheduleEveryMs ?? DEFAULT_CAP_MS);
    const delay = level === 0 ? 0 : Math.min(BASE_DELAY_MS * 2 ** (level - 1), cap);

    const next: BackoffState = {
        backlog: opts.backlog,
        fingerprint: opts.fingerprint,
        level,
        nextAt: now + delay,
    };
    try {
        // Outlive the longest delay so state isn't lost mid-backoff, but stay
        // TTL'd so a retired stage can't leak a key forever.
        const ttlMs = Math.max(delay, cap) + 3_600_000;
        await client.set(key, JSON.stringify(next), {
            expiry: { type: TimeUnit.Milliseconds, count: ttlMs },
        });
    } catch {
        return ALLOW; // recording failed — allow rather than throttle blind
    }

    return { skip: false, level };
}

/** Drop backoff state — e.g. an operator forcing a run after fixing the cause. */
export async function clearGlobalEnqueueBackoff(taskId: string, stageId: string): Promise<void> {
    try {
        const client = getCoordinationClient();
        if (!client) return;
        await client.del([keyFor(taskId, stageId)]);
    } catch {
        // Best-effort.
    }
}
