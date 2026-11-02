// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/global-pause — "pause everything for N hours" + quiet hours.
 *
 * GET    /api/admin/ops/global-pause → current pause + quiet-hours status
 *                                       (reconciles expiry/schedule first).
 * POST   /api/admin/ops/global-pause → pause every task queue for a duration.
 * DELETE /api/admin/ops/global-pause → resume early (cancel an active pause).
 *
 * Deliberately composes the TWO existing pause primitives rather than adding a
 * fourth: BullMQ `Queue.pause()`/`resume()` per resource class (the same call
 * `POST/DELETE /api/v1/queues/{class}/pause` already makes) for the actual
 * work-stopping effect, and the Valkey `task:queue-paused:<class>` flag the
 * per-queue endpoints already write for display parity — so a queue this
 * endpoint pauses reads identically to one paused by hand.
 *
 * Auto-resume survives a restart because the durable fact — "resume at time
 * T" — lives in Valkey (`admin:global-pause`), not in an in-process timer that
 * a restart would wipe. What actually resumes the queues is reconciliation
 * (`reconcileAndReadStatus`, shared with the scheduled task below), which
 * runs at the top of every GET/POST/DELETE on this endpoint AND on a fixed
 * 1-minute cadence via the `pause-reconcile` builtin task
 * (`$lib/server/tasks/builtin/native/pause-reconcile.ts`). Before that task
 * existed, the only regular caller of GET was the admin dashboard's Load
 * Controls card polling while mounted — close the tab and an active pause
 * outlived its deadline until someone happened to reopen the admin
 * dashboard. The scheduled task removes that dependency: a pause now lifts
 * on time whether or not the dashboard is open, and `runOnStartup` means a
 * restart mid-pause resumes on schedule too.
 *
 * The reconcile logic itself (`pauseClasses`/`resumeClasses`/
 * `reconcileAndReadStatus` and friends) lives in
 * `$lib/server/tasks/global-pause-reconcile.ts` so this endpoint and the
 * scheduled task can never disagree about when a pause expires — see that
 * module's doc comment for why `pause-reconcile`'s own queue is deliberately
 * exempt from the pause it performs (otherwise the one task that resumes
 * the system could be paused right along with everything else).
 *
 * Quiet hours reuses the identical mechanism: `LUMASTRA_QUIET_HOURS_*`
 * (schema.ts) name a daily window; reconciliation pauses/resumes only the
 * `cpu` and `analysis` classes for it (watch-sync/scan/ingest keep working).
 * A class an active global pause is also holding is left alone when quiet
 * hours' own window ends — global pause owns the resume for that class.
 *
 * Auth: admin. Errors: problem+json.
 */

import { getPlaybackPressure } from '$lib/server/tasks/playback-pressure.js';

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { RESOURCE_CLASSES } from '@sapd/lumastra-plugin-sdk';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { FEATURE_PER_TASK_QUEUES } from '$lib/server/config.js';
import {
    reconcileAndReadStatus,
    readGlobalPause,
    writeGlobalPause,
    clearGlobalPause,
    pauseClasses,
    resumeClasses,
    type GlobalPauseRecord,
    // Re-exported for `global-pause.test.ts`'s pure-logic coverage of the
    // quiet-hours window check.
    inWindow,
} from '$lib/server/tasks/global-pause-reconcile.js';

export { inWindow };

const PauseBody = z.object({
    durationHours: z.number().min(1).max(72),
    reason: z.string().max(500).optional(),
});

/**
 * `users.id` UUID for `GlobalPauseRecord.pausedBy` — a DATA field, not the
 * audit actor. Kept as the stable UUID deliberately: unlike a display name,
 * `users.id` survives a username change and is the correct join key if this
 * record is ever correlated back to `users` (fix round 1: the review
 * confirmed this field's UUID semantics are load-bearing and must not
 * change). For the AUDIT trail's human-readable actor, use `auditActor(event)`
 * instead — see the two `auditLog()` calls below, which is what R5 requires
 * (an operator querying "everything alice did" must find her `username`,
 * not her opaque `userId`).
 */
function actorId(event: { locals: { principal?: unknown } }): string {
    const principal = event.locals.principal;
    return typeof principal === 'object' && principal !== null
        ? (((principal as Record<string, unknown>).userId as string | undefined) ?? 'unknown')
        : 'unknown';
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    // No endpoint-level `request.body`: the schema applies to every method that
    // `methodCanHaveBody()` covers (POST *and* DELETE here), but only POST
    // carries a body — DELETE (resume) sends none. Parsed and validated by
    // hand inside the POST handler instead, same as PUT .../schedule does for
    // its own method-specific body.
    handlers: {
        GET: async (_event, _ctx) => {
            const status = await reconcileAndReadStatus();
            return json(
                { ...status, playbackPressure: await getPlaybackPressure() },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        },

        POST: async (event, _ctx) => {
            // Refuse rather than deadlock. The auto-resume is a registered task, and
            // it is spared the pause by having its OWN BullMQ queue excluded — which
            // only exists under FEATURE_PER_TASK_QUEUES (default true). In the legacy
            // shared-per-class-queue fallback every task in a class shares one
            // physical queue, so pausing `maintenance` would pause the resumer along
            // with everything else and nothing would ever lift it. Background
            // processing would stop indefinitely with no error and no visible cause.
            //
            // A control that can brick the server in a supported rollback mode should
            // not be offered in that mode. Per-task Pause and the Task-runner
            // switches still work there.
            if (!FEATURE_PER_TASK_QUEUES) {
                return problem('conflict', {
                    error:
                        'Pause everything is unavailable while FEATURE_PER_TASK_QUEUES is off, ' +
                        'because the job that resumes it shares a queue with the jobs being paused ' +
                        'and could not restart them. Pause individual tasks instead.',
                });
            }

            // Reconcile first so a stale/expired record never blocks a new pause.
            await reconcileAndReadStatus();

            const existing = await readGlobalPause();
            if (existing) {
                return problem('conflict', {
                    error: 'Everything is already paused. Resume it first, or wait for it to expire.',
                });
            }

            let rawBody: unknown;
            try {
                rawBody = await readBoundedJson(event.request);
            } catch {
                rawBody = {};
            }
            const parsed = PauseBody.safeParse(rawBody);
            if (!parsed.success) {
                return problem('validation_failed', {
                    error: 'Invalid pause request',
                    details: parsed.error.issues.map((i) => ({
                        field: i.path.join('.') || 'body',
                        message: i.message,
                    })),
                });
            }
            const { durationHours, reason } = parsed.data;
            const connection = getQueueConnectionOptions();
            if (!connection) {
                return ApiProblem.dependencyUnavailable(
                    'Queue unavailable — CACHE_URL not configured',
                );
            }

            const classes = [...RESOURCE_CLASSES];
            const paused = await pauseClasses(classes);
            if (paused.length !== classes.length) {
                // Best-effort rollback of whatever DID pause, so a partial
                // failure doesn't leave some queues silently stuck.
                await resumeClasses(paused);
                return ApiProblem.dependencyUnavailable(
                    'Could not pause every queue — nothing was left paused. Check Valkey/BullMQ connectivity and try again.',
                );
            }

            const resumeAt = new Date(Date.now() + durationHours * 3600 * 1000);
            const record: GlobalPauseRecord = {
                resumeAt: resumeAt.toISOString(),
                classes,
                reason,
                pausedBy: actorId(event),
                pausedAt: new Date().toISOString(),
            };
            // TTL well past resumeAt: the record must outlive the scheduled
            // resume so a late poll can still find it and finish the job.
            await writeGlobalPause(record, durationHours * 3600 + 3600);

            // Fix round 1: the previous object here reused actorId()'s userId
            // UUID as the audit `username`, so an operator querying the audit
            // log for everything a specific admin did would never find their
            // queue.pause.global/queue.resume.global rows — filed under a
            // UUID instead of a name (same defect class as
            // secrets-rotate.handler.ts's `username: auth.userId`).
            // `auditActor(event)` gives the audit trail the actual username;
            // `pausedBy` above is UNCHANGED — it stays on the UUID (see
            // actorId()'s doc comment).
            auditLog('queue.pause.global', 'global', auditActor(event), {
                durationHours,
                reason,
                resumeAt: record.resumeAt,
            });

            return json({
                globalPause: { active: true, ...record },
                quietHours: (await reconcileAndReadStatus()).quietHours,
            });
        },

        DELETE: async (event, _ctx) => {
            const existing = await readGlobalPause();
            if (!existing) {
                return problem('not_found', {
                    error: 'Nothing is currently paused.',
                });
            }
            await resumeClasses(existing.classes);
            await clearGlobalPause();
            auditLog('queue.resume.global', 'global', auditActor(event), {
                classes: existing.classes,
            });
            const status = await reconcileAndReadStatus();
            return json(status);
        },
    },
});
