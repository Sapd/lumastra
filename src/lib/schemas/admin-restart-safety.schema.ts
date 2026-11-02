// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Safe to restart?" — Zod response schema.
 *
 * SINGLE SOURCE OF TRUTH for GET /api/admin/system/restart-safety
 * (and its /api/v1 mirror).
 *
 * Derived honestly from what is actually running:
 *   - `task_history` rows in ('active','pending','cancelling') per task
 *     (via `getTaskLaneData`) give the currently in-flight work and how
 *     long it has been running.
 *   - Whether that work is `resumable` is read from the task's own
 *     `TaskDefinition.coversStages` — tasks that cover one or more stages
 *     persist progress per-item in `media_item_stage_state`, so a reclaimed
 *     run's remaining items are picked up by the next stage-sweep tick
 *     rather than lost. Tasks with no covered stages run as a single
 *     continuous unit of work with no incremental checkpoint — if that run
 *     is interrupted, the next attempt starts over.
 *   - `pendingWrites` mirrors the same Valkey `task:pending-writes` depth
 *     the health page's "pendingWriteDrain" component already reports.
 *     Per `pending-write-drain.ts`, entries there survive a SIGKILL/OOM/
 *     redeploy (crash-safe claim via LMOVE + a recovery sweep on every
 *     tick), so a non-zero depth means "still saving", never "will be
 *     lost" — it only ever delays.
 */

import { z } from 'zod';

export const RestartSafetyItemSchema = z.object({
    taskId: z.string(),
    taskName: z.string(),
    resourceClass: z.string(),
    /** How many runs of this task are currently active/pending/cancelling. */
    activeCount: z.number().int().nonnegative(),
    /**
     * Milliseconds since the most recently started in-flight run of this
     * task began. 0 when unknown.
     */
    elapsedMs: z.number().nonnegative(),
    /**
     * True when the task covers one or more pipeline stages — its progress
     * is durable per-item in `media_item_stage_state`, so an interrupted
     * run resumes from where it left off rather than restarting from zero.
     */
    resumable: z.boolean(),
    /** Live backlog count for this task's covered stages, when it has any. */
    backlogRemaining: z.number().int().nonnegative().optional(),
    /** Unit label for `backlogRemaining` (e.g. "items", "files"), from `TaskDefinition.backlog`. */
    unitLabel: z.string().optional(),
    /**
     * Estimated milliseconds to drain `backlogRemaining` at the task's
     * observed throughput over the last hour. `null` when throughput is
     * unknown (task hasn't completed anything in the last hour) — the UI
     * must render this as "ETA unknown", never divide-by-zero.
     */
    etaMs: z.number().nonnegative().nullable().optional(),
});
export type RestartSafetyItem = z.infer<typeof RestartSafetyItemSchema>;

export const RestartSafetyResponseSchema = z.object({
    generatedAt: z.string(),
    /**
     * `unknown` when the task database is unreachable, or when nothing else is
     * running but the Valkey pending-write queue could not be read (then
     * `pendingWrites` is 0 but not known to be 0). Every other signal is still
     * computed on a best-effort basis in those cases.
     */
    status: z.enum(['safe', 'wait', 'lossy', 'unknown']),
    /** Depth of the `task:pending-writes` Valkey list. Always resumable — see module doc. */
    pendingWrites: z.number().int().nonnegative(),
    /** Only tasks with `activeCount > 0`, longest-running first. */
    items: z.array(RestartSafetyItemSchema),
});
export type RestartSafetyResponse = z.infer<typeof RestartSafetyResponseSchema>;
