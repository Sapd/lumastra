// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for `/admin/fix/stuck` — "something has been running forever".
 *
 * ## The question this surface exists to answer
 *
 * "Stuck" and "slow" look identical from the outside: a progress bar that is not
 * moving, for hours. They have completely different fixes, and an operator
 * cannot tell them apart from any screen the product previously offered.
 *
 * The distinguishing measurement is THROUGHPUT, not depth. A queue of 14,000
 * items that completed 300 rows in the last five minutes is working exactly as
 * designed. The same queue with zero completions is wedged. The `slow` page
 * already uses this gate to decide whether to reassure; this page uses it to
 * decide the opposite, so the two can never disagree about the same instance.
 *
 * ## `verdict` is the whole point, and it is MEASURED
 *
 * Everything else on this payload is evidence for it. The verdict is computed
 * server-side rather than left to the page so that the API and the UI cannot
 * drift into telling an operator two different stories — the same reason
 * `library-scan-check` reports `PathProbe.state` rather than raw errno.
 *
 * `idle` is a real answer, not a fallback: an instance with nothing queued is
 * not stuck, and saying so plainly is what stops the operator hunting.
 *
 * Shared by the endpoint def and the page — one definition, no drift.
 */

import { z } from 'zod';

/**
 * Why nothing is finishing. Ordered by how the page reads them: the first three
 * are causes an operator can act on, `stalled` means "queued, workers alive,
 * nothing moving" — the genuinely bad case with no single obvious cause.
 */
export const StuckVerdictSchema = z.enum([
    /** Nothing pending anywhere. Not stuck; there is simply no work. */
    'idle',
    /** Work queued AND completing. Slow, not stuck — the reassurance case. */
    'moving',
    /** Work queued but no worker can pick it up. This is usually the answer. */
    'no-worker',
    /** Work queued but its task, the stage sweep or its lane is paused, so it will never start. */
    'paused',
    /** Work queued, workers alive, nothing completed in the window. */
    'stalled',
]);
export type StuckVerdict = z.infer<typeof StuckVerdictSchema>;

export const StuckStageSchema = z.object({
    stageId: z.string(),
    /** Rows this stage completed in the throughput window. */
    completed5m: z.number(),
    /** Rows this stage currently has in `running`. */
    running: z.number(),
    /** Failures in the last hour — high with zero completions means thrashing. */
    failed1h: z.number(),
    /** ISO 8601, or null when this stage has never completed anything. */
    lastCompletedAt: z.string().nullable(),
    /**
     * Rows still waiting (`pending` + `failed_transient`).
     *
     * Reported because the other three fields are all measures of MOVEMENT, and
     * on a wedged instance every one of them is zero — which would leave the
     * evidence list empty at exactly the moment it matters most. Verified on a
     * real instance: 9,209 items in flight, nothing completing, and the stage
     * list came back empty.
     */
    pending: z.number(),
    /** How long the oldest waiting row in this stage has waited, in seconds. */
    oldestPendingAgeSec: z.number().nullable(),
});
export type StuckStage = z.infer<typeof StuckStageSchema>;

/** A read that failed. The verdict is computed without it, and the page says so. */
export const StuckCheckFailedSchema = z.enum(['pending', 'scheduler', 'worker', 'queues']);
export type StuckCheckFailed = z.infer<typeof StuckCheckFailedSchema>;

export const StuckCheckSchema = z.object({
    generatedAt: z.string(),
    verdict: StuckVerdictSchema,
    /** Minutes of throughput the verdict was computed over. */
    windowMinutes: z.number(),

    /** Total rows completed across all stages in the window. The gate itself. */
    completedInWindow: z.number(),
    /**
     * Items with a stage row that will still run (running, pending, retrying,
     * re-runnable). Dead letters are excluded — they are `deadLetterItems`.
     * `0` with a stalled verdict is impossible.
     */
    inFlight: z.number(),
    /** Stage rows currently claimed by a worker. */
    running: z.number(),
    /** Age of the oldest waiting row, in seconds. Null when nothing is waiting. */
    oldestPendingAgeSec: z.number().nullable(),
    /** Items that gave up entirely — not "stuck", but often what prompted the visit. */
    deadLetterItems: z.number(),
    /** Items whose most-active stage has already failed three or more times. */
    degradedItems: z.number(),

    /**
     * Whether ANY worker can pick up jobs. False makes the verdict `no-worker`.
     * True when the probe failed (`workerSource: 'probe-failed'`): an
     * unmeasured cause is never named.
     */
    workerAvailable: z.boolean(),
    /** How worker availability was determined, for the operator's own judgement. */
    workerSource: z.string(),

    /**
     * Tasks the scheduler will not fire. Populated regardless of verdict: a
     * paused task that is NOT the cause is still worth seeing on this page,
     * because "I paused that last week and forgot" is a real outcome.
     */
    pausedTasks: z.array(z.string()),
    /** Lanes (resource classes) whose queue is paused. Same reasoning as `pausedTasks`. */
    pausedQueues: z.array(z.string()),
    /**
     * How many of those pauses hold back the queued work — the stage sweep, a
     * task owning a backlogged stage, or that task's lane. Only these make the
     * verdict `paused`.
     */
    blockingPauses: z.number(),
    /** Reads that failed; the verdict may be missing a cause they would have shown. */
    checksFailed: z.array(StuckCheckFailedSchema),

    /**
     * Per-stage throughput, busiest first. Empty when nothing is queued.
     * Capped server-side — this is evidence, not an inventory.
     */
    stages: z.array(StuckStageSchema),
});
export type StuckCheck = z.infer<typeof StuckCheckSchema>;
