// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/trickplay-check — the "no seek previews" diagnostic.
 *
 * GET /api/admin/fix/trickplay-check → TrickplayCheck.
 * Auth: admin. Errors: problem+json.
 *
 * ## Coverage, not queue depth
 *
 * Trickplay generation is genuinely slow — hours of ffmpeg on a fresh library is
 * normal — so a deep `pending` queue is not evidence of a problem, and this
 * endpoint does not pretend otherwise. What IS evidence is an item that was
 * never queued at all: stage rows are seeded from the task registry snapshot at
 * item-creation time, so a stage registered later gets no row for pre-existing
 * items. A prod incident left 11,186 items with no trickplay coverage while
 * every status count and progress bar read clean, because an item with no row
 * contributes to no bucket.
 *
 * `withoutRow` is that number, derived by counting eligibility independently of
 * the rows rather than inferring it from them.
 *
 * ## `taskRegistered` is reported rather than assumed
 *
 * The stage can be absent entirely — disabled by config, or unavailable in this
 * build. Reporting 0% coverage without saying the generator is not registered
 * would send an operator to debug a queue that does not exist, which is the
 * class of mistake `/admin/fix` exists to stop making.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { getStageCoverage } from '$lib/server/database/queries/stage-state.queries.js';
import { getSchedulerState } from '$lib/server/tasks/scheduler-state.js';
import { registry } from '$lib/server/tasks/registry.js';
import type { TrickplayCheck } from '$lib/components/admin/fix/trickplay-check.schema.js';

const logger = Logger.for('AdminFixTrickplayCheck');

/** The stage that writes seek previews, and the task that owns it. */
const TRICKPLAY_STAGE_ID = 'trickplay-generation';
const TRICKPLAY_TASK_ID = 'trickplay-generation';

/** Only video items get seek previews. Music and books never should. */
const VIDEO_MEDIA_TYPES = ['movie', 'episode'] as const;

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getAdminDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not configured');
            }

            let scheduleUnreadable = false;
            const [coverage, schedule, lastCompleted] = await Promise.all([
                getStageCoverage(sql, TRICKPLAY_STAGE_ID, VIDEO_MEDIA_TYPES).catch(
                    (err: unknown) => {
                        logger.warn('trickplay coverage unreadable', {
                            error: err instanceof Error ? err.message : String(err),
                        });
                        return null;
                    },
                ),
                // A row exists only once the task was paused (it declares no
                // schedule), so null means "not paused", and only a failed
                // read is "unknown".
                getSchedulerState(sql, TRICKPLAY_TASK_ID).catch((err: unknown) => {
                    logger.warn('trickplay scheduler state unreadable', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    scheduleUnreadable = true;
                    return null;
                }),
                // When a preview was last generated. Not scheduler_state's
                // last_fired_at: this is a per-item task with no schedule, so
                // that field is null forever and read as "has never run".
                sql<{ at: Date | null }[]>`
                    SELECT MAX(updated_at) AS at
                      FROM media_item_stage_state
                     WHERE stage_id = ${TRICKPLAY_STAGE_ID}
                       AND status = 'completed'
                `
                    .then((rows) => rows[0]?.at ?? null)
                    .catch((err: unknown) => {
                        logger.warn('trickplay last completion unreadable', {
                            error: err instanceof Error ? err.message : String(err),
                        });
                        return undefined;
                    }),
            ]);

            if (!coverage) {
                return ApiProblem.dependencyUnavailable('Coverage query failed');
            }

            let taskRegistered: boolean;
            try {
                taskRegistered = registry.getAllTasks().some((t) => t.id === TRICKPLAY_TASK_ID);
            } catch {
                // A registry that will not answer is not evidence the task is
                // absent — leave the claim unmade rather than reporting a
                // missing generator that may be running perfectly well.
                taskRegistered = true;
            }

            const payload: TrickplayCheck = {
                generatedAt: new Date().toISOString(),
                stageId: TRICKPLAY_STAGE_ID,
                eligibleItems: coverage.eligibleItems,
                withRow: coverage.withRow,
                // Clamped: eligibility and rows are counted in one query, but a
                // stage row can outlive its item's eligibility (a file removed),
                // and a negative "never queued" is not a state that exists.
                withoutRow: Math.max(0, coverage.eligibleItems - coverage.withRow),
                completed: coverage.completed,
                pending: coverage.pending,
                running: coverage.running,
                failedTransient: coverage.failedTransient,
                failedPermanent: coverage.failedPermanent,
                skipped: coverage.skipped,
                obsolete: coverage.obsolete,
                coveragePercent:
                    coverage.eligibleItems === 0
                        ? 100
                        : Math.round((coverage.completed / coverage.eligibleItems) * 100),
                taskPaused: scheduleUnreadable ? null : (schedule?.paused ?? false),
                taskLastFiredAt: lastCompleted ? new Date(lastCompleted).toISOString() : null,
                taskLastFiredUnreadable: lastCompleted === undefined,
                taskRegistered,
                // Generation is opt-in, and with Jellyfin's files as the source
                // nothing is generated here. Either one explains 0% coverage on
                // its own, so the page must not read it as a backlog.
                generationEnabled: config.TRICKPLAY_ENABLED === true,
                provider: config.TRICKPLAY_PROVIDER,
            };

            return json(payload);
        },
    },
});
