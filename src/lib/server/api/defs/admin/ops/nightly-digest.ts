// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/nightly-digest — "recent activity" digest for the Home
 * dashboard: what finished, what's still going, what failed, and the one
 * thing that needs a human.
 *
 * GET /api/admin/ops/nightly-digest?hours=12
 *
 * Everything here is read, not invented:
 *  - Completed work: `task_history.result->>'itemsProcessed'`, the SAME
 *    field `lane-data.ts` already sums for the live throughput panel — not a
 *    new metric. A task only appears in `completed` when that sum is > 0;
 *    plenty of real completed runs (a cleanup task, a sync with nothing new)
 *    carry no `itemsProcessed` and are simply not itemized, matching "leave
 *    the line out rather than estimate" rather than reporting a fake zero.
 *  - Still going: `task_history` rows currently `active`.
 *  - Failed: a count of `task_history` rows that finished `failed` in the
 *    window — no per-item narrative, just the number and a link to Health.
 *
 * Deliberately NOT included here: "one thing needs you". That line is the
 * top OPEN item from `adminStatus.payload.attention.items` — the exact same
 * source Home's AttentionList and the bell already read (`getAttention()`,
 * wired through `admin-status-payload.service.ts`). `NightlyDigest.svelte`
 * takes it as a PROP from `/admin/+page.svelte`'s already-loaded status
 * payload rather than this endpoint querying it a second time: the page's
 * own doc comment states it "makes NO fetches of its own" precisely so no
 * two admin surfaces can disagree about what's wrong, and adding a second,
 * independent attention query here would reintroduce exactly that risk.
 *
 * Auth: admin. Errors: problem+json.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import { registry } from '$lib/server/tasks/registry.js';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';

const DEFAULT_WINDOW_HOURS = 12;
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 48;
const MAX_COMPLETED_ROWS = 8;
const MAX_STILL_GOING_ROWS = 10;

interface CompletedRow {
    task_id: string;
    runs: number;
    items_processed: number;
}

interface StillGoingRow {
    task_id: string;
    started_at: Date;
}

export function parseWindowHours(raw: string | null): number {
    const n = raw ? Number.parseInt(raw, 10) : DEFAULT_WINDOW_HOURS;
    if (!Number.isFinite(n)) return DEFAULT_WINDOW_HOURS;
    return Math.max(MIN_WINDOW_HOURS, Math.min(MAX_WINDOW_HOURS, n));
}

/**
 * True when the whole install is younger than the digest window — the first
 * task run started after `since`. The card then says "since setup" instead of
 * "in the last 12h", which read as wrong on a 25-minute-old install (Windows
 * e2e 2026-09-27: "While you were asleep — 1349 runs completed in the last
 * 12h").
 */
export function windowCoversWholeInstall(firstRunAt: Date | null, since: Date): boolean {
    return firstRunAt !== null && firstRunAt.getTime() > since.getTime();
}

function taskName(taskId: string): string {
    return taskDisplayName(taskId, registry.getTask(taskId)?.name);
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event, _ctx) => {
            const sqlTask = getTaskDb();
            if (!sqlTask) {
                return ApiProblem.dependencyUnavailable(
                    'Database unavailable — cannot build the digest',
                );
            }

            const windowHours = parseWindowHours(event.url.searchParams.get('hours'));
            const since = new Date(Date.now() - windowHours * 3600 * 1000);

            const [completedRows, totalCompletedRows, stillGoingRows, failedRows, firstRunRows] =
                await Promise.all([
                    sqlTask<CompletedRow[]>`
                        SELECT task_id,
                               COUNT(*)::int AS runs,
                               SUM(COALESCE((result->>'itemsProcessed')::int, 0))::int AS items_processed
                          FROM task_history
                         WHERE state = 'completed'
                           AND completed_at > ${since}
                           AND result ? 'itemsProcessed'
                         GROUP BY task_id
                        HAVING SUM(COALESCE((result->>'itemsProcessed')::int, 0)) > 0
                         ORDER BY items_processed DESC
                         LIMIT ${MAX_COMPLETED_ROWS}
                    `,
                    sqlTask<{ n: number }[]>`
                        SELECT COUNT(*)::int AS n
                          FROM task_history
                         WHERE state = 'completed'
                           AND completed_at > ${since}
                    `,
                    sqlTask<StillGoingRow[]>`
                        SELECT task_id, started_at
                          FROM task_history
                         WHERE state = 'active'
                         ORDER BY started_at ASC
                         LIMIT ${MAX_STILL_GOING_ROWS}
                    `,
                    sqlTask<{ n: number }[]>`
                        SELECT COUNT(*)::int AS n
                          FROM task_history
                         WHERE state = 'failed'
                           AND COALESCE(completed_at, started_at) > ${since}
                    `,
                    sqlTask<{ started_at: Date }[]>`
                        SELECT started_at
                          FROM task_history
                         WHERE started_at IS NOT NULL
                         ORDER BY started_at ASC
                         LIMIT 1
                    `,
                ]);

            return json(
                {
                    windowHours,
                    windowStart: since.toISOString(),
                    sinceInstall: windowCoversWholeInstall(
                        firstRunRows[0]?.started_at ?? null,
                        since,
                    ),
                    totalCompletedRuns: totalCompletedRows[0]?.n ?? 0,
                    completed: completedRows.map((r) => ({
                        taskId: r.task_id,
                        taskName: taskName(r.task_id),
                        runs: r.runs,
                        itemsProcessed: r.items_processed,
                    })),
                    stillGoing: stillGoingRows.map((r) => ({
                        taskId: r.task_id,
                        taskName: taskName(r.task_id),
                        startedAt: r.started_at.toISOString(),
                    })),
                    failedCount: failedRows[0]?.n ?? 0,
                },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        },
    },
});
