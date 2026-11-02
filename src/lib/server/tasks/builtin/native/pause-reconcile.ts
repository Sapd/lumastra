// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pause Reconcile — the server-side heartbeat for "pause everything for N
 * hours" (admin/ops/global-pause) and quiet hours.
 *
 * ── Why this task exists ───────────────────────────────────────────────────
 * The durable fact for an active pause — "resume at time T" — lives in
 * Valkey (`admin:global-pause`), not an in-process timer, so a restart never
 * loses the deadline. But actually LIFTING the pause requires someone to
 * call `reconcileAndReadStatus()`. Before this task, the only caller was
 * `GET/POST/DELETE admin/ops/global-pause`, and the only regular caller of
 * GET was the admin dashboard's Load Controls card polling every 20s while
 * mounted. Close the tab and nothing resumes the paused queues until an
 * operator happens to open the admin dashboard again — on a self-hosted
 * server that can be days, with background processing stopped silently and
 * no error anywhere to point at. This task runs the identical reconcile on
 * a schedule so the pause lifts on time regardless of whether the dashboard
 * is open.
 *
 * ── The pause-pauses-its-own-resumer trap ──────────────────────────────────
 * `POST admin/ops/global-pause` pauses every `ResourceClass` queue
 * (`[...RESOURCE_CLASSES]`), and this task's own `resourceClass` below is
 * `'maintenance'` — one of them. If this task's queue were paused along with
 * everything else, the one thing that resumes the system would itself be
 * stuck waiting on a resume only it can trigger: a permanent deadlock, not
 * just a delay.
 *
 * `$lib/server/tasks/global-pause-reconcile.ts#tasksForClass` guards against
 * exactly this: under `FEATURE_PER_TASK_QUEUES` (default ON — the deployed
 * model since 2026-05-24, see `config.ts`), every task gets its own BullMQ
 * queue keyed by task id, and `tasksForClass` excludes
 * `GLOBAL_PAUSE_RECONCILE_TASK_ID` from the per-class task list it builds
 * queues from — for BOTH `pauseClasses` and `resumeClasses`, so this task's
 * queue is never touched by the global-pause endpoint on either side of the
 * pause/resume boundary. This task's `id` below is declared as that SAME
 * exported constant (not a second hardcoded string) so the exemption and
 * the task it protects cannot drift apart. (Under the legacy shared-
 * per-class-queue fallback, `FEATURE_PER_TASK_QUEUES=false`, tasks sharing a
 * class share one physical BullMQ queue and cannot be individually spared —
 * that mode is an env-var rollback path only, not the production default.)
 *
 * ── Leader gating ───────────────────────────────────────────────────────────
 * Mirrors problem-derive / stage-sweep exactly — every other cluster-
 * singleton builtin is gated the same way, not by a bespoke lock:
 *   - `scope: 'global'` + a constant `identityFor` — one identity, so the
 *     orchestrator's SETNX identity dedup collapses concurrent enqueues;
 *   - the scheduler's cluster-wide fire claim, so one tick produces one run;
 *   - `resourceClass: 'maintenance'` — see the exemption above for why this
 *     is safe despite being one of the classes global pause otherwise pauses;
 *   - `quotas: { maxConcurrent: 1 }` — two overlapping cycles must never
 *     race the same Valkey keys (auto-resume + quiet-hours marker writes).
 *
 * `runOnStartup: true` so a restart mid-pause resumes on schedule instead of
 * waiting out a full interval — e.g. a restart with 5 minutes left on a 2h
 * pause should not additionally wait up to another minute for the next tick.
 *
 * 1-minute cadence: the pause window is granular to hours (`durationHours`,
 * 1-72) and quiet hours to HH:MM, so minute-ish resolution is all the
 * feature needs — no operator will notice a resume landing up to 60s after
 * its deadline. Faster buys nothing and adds a needless Valkey/BullMQ round
 * trip every tick.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import {
    reconcileAndReadStatus,
    GLOBAL_PAUSE_RECONCILE_TASK_ID,
} from '../../global-pause-reconcile.js';

const inputSchema = z.object({}).passthrough();

interface PauseReconcileResult {
    /** Whether a global pause is still active after this cycle's reconcile. */
    globalPauseActive: boolean;
    /** ISO resume deadline, present only while a global pause is active. */
    globalPauseResumeAt?: string;
    /** Whether quiet hours' cpu/analysis pause is active after this cycle. */
    quietHoursActive: boolean;
}

export const pauseReconcileTask = defineTask<Record<string, unknown>, PauseReconcileResult>({
    id: GLOBAL_PAUSE_RECONCILE_TASK_ID,
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Pause Reconcile',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    // Touches Valkey (pause record + quiet-hours marker) and BullMQ
    // (Queue.pause/resume) directly, not through ctx.sql.
    capabilities: { cache: true },

    schedule: {
        every: '1m',
        // See "Why this task exists" above — a restart mid-pause must not
        // wait out a full interval before the deadline is honoured.
        runOnStartup: true,
    },

    identityFor: () => 'global',
    scope: 'global',
    resourceClass: 'maintenance',
    // Two overlapping cycles would race the auto-resume and quiet-hours
    // marker writes against each other.
    quotas: { maxConcurrent: 1 },

    inputSchema,

    // Reconcile is a handful of Valkey round trips plus, at most, closing out
    // one pause window's worth of BullMQ Queue.resume() calls — generous
    // against a slow Valkey without letting cycles pile up.
    timeout: { hard: '1m', soft: '20s' },

    async execute(ctx) {
        const status = await reconcileAndReadStatus();

        if (status.globalPause.active) {
            ctx.logger.info('global pause still active', {
                resumeAt: status.globalPause.resumeAt,
            });
        }

        const result: PauseReconcileResult = {
            globalPauseActive: status.globalPause.active,
            globalPauseResumeAt: status.globalPause.resumeAt,
            quietHoursActive: status.quietHours.active,
        };

        return {
            success: true,
            itemsProcessed: 1,
            result,
        };
    },
});

registry.registerTask(pauseReconcileTask);
