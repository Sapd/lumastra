// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { actionableTaskFailure } from '../database/queries/fragments/task-failure.fragments.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { requireClient, type ValkeyLike } from './valkey-types.js';
import { getTrickplayDisplayCounts } from '$lib/server/services/trickplay-coverage.service.js';
// Single source of truth is the Zod schema — re-exported here so existing
// importers (the admin /tasks page) keep resolving `TaskLane` from this module.
// Avoids the drift trap where adding a lane to the schema compiled clean but
// left this bare union behind, yielding a runtime TypeError in groupByLane.
import type { TaskLane } from '$lib/schemas/task-definition.schema.js';
export type { TaskLane };

const log = Logger.for('tasks.lane-data');

export interface TaskLaneInfo {
    lane: TaskLane;
    activeCount: number;
    /** Runtime-confirmed executions among the four newest in-flight rows per task. */
    observedActiveCount?: number;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    /**
     * For tasks that cover one or more stage_ids (`TaskDefinition.coversStages`,
     * passed in via `stagesByTask`), this is a LIVE count of pending
     * `media_item_stage_state` rows for those stages — the same predicate
     * `/api/admin/coverage/backlog` uses to feed the catalog card's live
     * "N in backlog" pulse (`task-aggregates.ts` `coverageBacklog`). Querying
     * live state (rather than the last terminal run's self-reported `stages`
     * snapshot) keeps this field in agreement with the card even while a task
     * is stuck failing and never reaches a state where it reports fresh
     * numbers — a task with an open circuit and 15 failures in a row would
     * otherwise read 0/stale here while the card correctly showed a real
     * backlog.
     *
     * Tasks without covered stages (or when `stagesByTask` is omitted
     * entirely) fall back to summing the `count` fields of the last terminal
     * run's self-reported `stages` JSON — the previous, run-history-only
     * source for this field.
     */
    backlogRemaining: number;
    recentFailCount: number;
    circuitState: 'closed' | 'open' | 'half_open';
    /**
     * Stage rows transitioned to `completed` per hour over the last 1h
     * window. Powers the ETA estimate on lane cards: `eta = coverageBacklog
     * / itemsPerHour`. For tasks that cover one or more stage_ids the
     * value is the per-stage completion count (the same metric as the
     * backlog), so the ratio directly answers "how long until backlog
     * drains". For batch tasks without covered stages we fall back to
     * `SUM(task_history.result.itemsProcessed)` so they still report a
     * meaningful number.
     *
     * `null` when there's no observable throughput in the window — the
     * task hasn't completed any work in the last hour. The UI surfaces
     * this as "ETA unknown" rather than dividing by zero.
     *
     * Window is fixed at 1h; we could make it operator-configurable later
     * but 1h is the right balance between "responsive to recent throughput
     * changes" and "not over-reacting to single completed-run blips."
     */
    itemsPerHour: number | null;
    /**
     * Truncated `error.message` from the most recent failed run in the last
     * 24h window. Same window + boot-recovery exclusion as `recentFailCount`.
     * Lets the lane card answer "why is this failing?" inline without
     * forcing the operator to open the detail panel.
     *
     * Capped at 300 chars server-side; the card clamps it to two lines and
     * carries the full text in a tooltip.
     */
    lastFailedError: string | null;
    /**
     * How long the most recent terminal run (same 7-day window as
     * `lastCompletedAt`) took, in ms — the "took 2 min" of the admin task
     * list. Null when there is no such run.
     */
    lastDurationMs: number | null;
}

export interface TaskLaneSummary {
    activeCount: number;
    pendingItems: number;
    failedLast24h: number;
}

function sumStages(stages: unknown): number {
    if (!Array.isArray(stages)) return 0;
    let total = 0;
    for (const stage of stages) {
        if (stage !== null && typeof stage === 'object' && 'count' in stage) {
            const c = (stage as Record<string, unknown>).count;
            if (typeof c === 'number' && isFinite(c)) {
                total += c;
            }
        }
    }
    return total;
}

function coerceCircuitState(v: unknown): 'closed' | 'open' | 'half_open' {
    return v === 'open' || v === 'half_open' ? v : 'closed';
}

// Returns null when the database is unreachable. Callers should surface this
// as "metrics unavailable" rather than falsely classifying every task as
// healthy — DB-down looks identical to a quiet system at the row level.
//
// `stagesByTask` (optional) maps task_id → list of stage_ids that task covers
// (from `TaskDefinition.coversStages`). When supplied, the throughput query
// uses true `media_item_stage_state` completion rate as the ETA denominator
// instead of summing `task_history.result.itemsProcessed`. Per-item tasks
// (trickplay-generation, metadata-update, etc.) report tile/field counts via
// itemsProcessed but the actual stage-row drain is one row per run, so the
// old denominator overstated throughput 100×+ on those tasks. Batch tasks
// without covered stages fall through to the itemsProcessed sum.
export async function getTaskLaneData(
    taskIds: string[],
    stagesByTask?: Map<string, string[]>,
    providedSql?: postgres.Sql,
    providedClient?: ValkeyLike,
): Promise<Map<string, TaskLaneInfo> | null> {
    if (taskIds.length === 0) return new Map();

    // Task-system observability data lives on task tables (task_history,
    // media_item_stage_state, task_circuit_state). Read it through the task
    // pool so a burst of admin-dashboard metric queries can't pin web-pool
    // connections and starve user-facing routes. Callers inside a run can
    // inject ctx.sql; the admin route omits it and gets the task pool.
    const sql = providedSql ?? getTaskDb();
    if (!sql) return null;

    const idArray = sql.array(taskIds);

    // Invert stagesByTask → stageToTask for the post-query aggregation.
    // Skipped entirely when no map provided (legacy path).
    const stageToTask = new Map<string, string>();
    const allCoveredStages: string[] = [];
    const tasksWithStages = new Set<string>();
    if (stagesByTask) {
        for (const [taskId, stageIds] of stagesByTask) {
            if (stageIds.length === 0) continue;
            tasksWithStages.add(taskId);
            for (const sid of stageIds) {
                stageToTask.set(sid, taskId);
                allCoveredStages.push(sid);
            }
        }
    }

    const [
        activeRows,
        terminalRows,
        failCountRows,
        circuitRows,
        lastErrorRows,
        throughputRows,
        liveBacklogRows,
    ] = await Promise.all([
        (async () => {
            try {
                return await sql<
                    {
                        task_id: string;
                        active_count: string;
                        last_started_at: Date | null;
                        sample_run_ids?: string[];
                    }[]
                >`
                    SELECT a.task_id, a.active_count, a.last_started_at,
                           ARRAY(
                               SELECT sample.id FROM task_history sample
                               WHERE sample.task_id = a.task_id
                                 AND sample.state IN ('active', 'pending', 'cancelling')
                               ORDER BY sample.started_at DESC LIMIT 4
                           ) AS sample_run_ids
                    FROM (
                        SELECT task_id, COUNT(*) AS active_count, MAX(started_at) AS last_started_at
                        FROM task_history
                        WHERE state IN ('active', 'pending', 'cancelling')
                          AND task_id = ANY(${idArray})
                        GROUP BY task_id
                    ) a
                `;
            } catch (err) {
                log.warn('lane-data: active query failed', {
                    err: String(err),
                });
                return [];
            }
        })(),
        (async () => {
            try {
                // Backlog stages snapshot taken at the end of the latest run.
                // Capped at 7d so a task that hasn't run in months doesn't
                // sit forever in the pending lane with stale counts.
                //
                // Rewritten from `DISTINCT ON (task_id) ... WHERE state IN
                // (...) AND completed_at > ... AND task_id = ANY(...) ORDER BY
                // task_id, completed_at DESC NULLS LAST` (prod slow log:
                // 106 calls/4.3h, p50 297ms, max 455ms). The old shape forced
                // an index scan on `idx_task_history_terminal_completed`
                // (completed_at) filtering ~150k rows down to ~70 by task_id,
                // then an external-merge disk sort of all 150k rows to
                // satisfy `ORDER BY task_id` — 236ms in a prod EXPLAIN. A
                // per-task LATERAL join lets each of the ~80 task ids do its
                // own indexed lookup on `idx_task_history_task_completed`
                // (task_id, completed_at DESC): 3.5ms in the same prod
                // EXPLAIN (~67x). Two things were required for the planner to
                // pick that index instead of re-deriving the same slow plan
                // per task: (1) `duration_ms IS NOT NULL` is redundant with
                // `state IN (...)` (every terminal-state row has completed_at
                // set — confirmed zero counter-examples on prod) but matches
                // that index's partial predicate and is the signal the
                // planner uses to choose it; (2) dropping `NULLS LAST` from
                // `ORDER BY completed_at DESC` — the btree's default null
                // ordering for a DESC column is NULLS FIRST, so `NULLS LAST`
                // was forcing a re-sort even when the index was chosen (rows
                // are filtered to completed_at NOT NULL anyway, so the null
                // ordering is unobservable here).
                return await sql<
                    {
                        task_id: string;
                        state: string;
                        completed_at: Date | null;
                        stages: unknown;
                        duration_ms: string | number | null;
                    }[]
                >`
                    SELECT t.task_id, th.state, th.completed_at, th.stages,
                           CASE WHEN th.execution_started_at IS NOT NULL
                                THEN GREATEST(0, EXTRACT(EPOCH FROM (th.completed_at - th.execution_started_at)) * 1000)
                                END AS duration_ms
                    FROM unnest(${idArray}) AS t(task_id)
                    CROSS JOIN LATERAL (
                        SELECT state, completed_at, stages, duration_ms, execution_started_at
                        FROM task_history th
                        WHERE th.task_id = t.task_id
                          AND th.duration_ms IS NOT NULL
                          AND th.state IN ('completed', 'failed', 'cancelled')
                          AND th.completed_at > NOW() - INTERVAL '7 days'
                        ORDER BY th.completed_at DESC
                        LIMIT 1
                    ) th
                `;
            } catch (err) {
                log.warn('lane-data: terminal query failed', {
                    err: String(err),
                });
                return [];
            }
        })(),
        (async () => {
            try {
                // Exclude scheduler bookkeeping that isn't actionable to
                // operators:
                //
                // 1. Boot-recovery sweep marks in-flight rows 'failed' with
                //    `orphaned_at_recovery` / `pending_orphan_at_recovery`
                //    when a worker is SIGTERM'd mid-run (deploy, container
                //    restart). See boot-recovery.ts:98-100.
                //
                // 2. `claimRun failed: state mismatch: expected pending got
                //    active` fires when a second replica races on the same
                //    runId — boot recovery (or another worker) already
                //    claimed it. The losing worker correctly bails as
                //    transient and BullMQ retries, but the row remains as
                //    a tombstone in task_history.
                //
                // 3. `maxConcurrent reached` historical rows. The runner
                //    now uses moveToDelayed so future occurrences don't
                //    write a failed row at all (see runner.ts), but rows
                //    written before that fix linger in the 24h window.
                //    The condition is exactly "limit=1 is doing its job";
                //    surfacing it as a failure misleads operators.
                //
                // 4. `job stalled more than allowable limit` — BullMQ's
                //    watchdog moved an in-flight job back to wait because its
                //    worker stopped renewing the lock (a deploy/restart/
                //    SIGTERM mid-run, same root cause as #1). BullMQ retries
                //    the job; this row is just a tombstone of the interrupted
                //    attempt. A task that genuinely runs too long still shows
                //    up via 'Handler runtime ... exceeded hard timeout'.
                //
                // Surfacing any of these would put every task that ran
                // during the last deploy into the ⚠️ lane, drowning the
                // genuinely-failing signal operators need.
                return await sql<{ task_id: string; fail_count: string }[]>`
                    SELECT task_id, COUNT(*) AS fail_count
                    FROM task_history
                    WHERE ${actionableTaskFailure(sql)}
                      AND task_id = ANY(${idArray})
                    GROUP BY task_id
                `;
            } catch (err) {
                log.warn('lane-data: fail-count query failed', {
                    err: String(err),
                });
                return [];
            }
        })(),
        (async () => {
            try {
                return await sql<{ task_id: string; state: string }[]>`
                    SELECT task_id, state
                    FROM task_circuit_state
                    WHERE task_id = ANY(${idArray})
                `;
            } catch (err) {
                log.warn('lane-data: circuit-state query failed', {
                    err: String(err),
                });
                return [];
            }
        })(),
        (async () => {
            try {
                // Most recent failed run per task in the last 24h, excluding
                // boot-recovery synthetic failures (same exclusion as the
                // fail-count query so the surfaced error is actually
                // actionable). LEFT(message, 300) caps payload size before it
                // crosses the wire — 80 cut prod's XMLTV timeout mid-address
                // with nothing saying so; the card clamps visually instead and
                // keeps the whole message in its tooltip. NULLs when no recent
                // failure.
                return await sql<{ task_id: string; last_error: string | null }[]>`
                    SELECT DISTINCT ON (task_id)
                           task_id,
                           LEFT(error->>'message', 300) AS last_error
                      FROM task_history
                     WHERE ${actionableTaskFailure(sql)}
                       AND task_id = ANY(${idArray})
                     ORDER BY task_id, completed_at DESC NULLS LAST
                `;
            } catch (err) {
                log.warn('lane-data: last-error query failed', {
                    err: String(err),
                });
                return [];
            }
        })(),
        (async () => {
            try {
                // Throughput over the last hour. Two-tier strategy:
                //
                //   1. For tasks that cover one or more stage_ids, count
                //      `media_item_stage_state` rows that transitioned to
                //      `completed` in the window. This is the actual drain
                //      rate of the backlog the UI shows. A task covering N
                //      stages sums all of them.
                //
                //   2. For tasks without covered stages (batch sync tasks like
                //      database-cleanup, file-library-scan), fall back to
                //      SUM(result.itemsProcessed) on completed task_history
                //      rows. Those tasks don't have a stage-row-per-item
                //      model, so itemsProcessed IS the meaningful metric.
                //
                // The old single-strategy of SUM(itemsProcessed) was wrong for
                // per-item tasks: e.g. trickplay-generation returns
                // `itemsProcessed = generated` (~128 sprite tiles per episode)
                // when the actual drain is one stage row per run. 14k tiles/hr
                // ÷ 4k backlog gave "~20m" when the real ETA is ~12h.
                const [stageRows, itemsRows] = await Promise.all([
                    allCoveredStages.length > 0
                        ? sql<{ stage_id: string; n: string }[]>`
                              SELECT stage_id, COUNT(*)::text AS n
                                FROM media_item_stage_state
                               WHERE status = 'completed'
                                 AND completed_at > NOW() - INTERVAL '1 hour'
                                 AND stage_id = ANY(${sql.array(allCoveredStages)})
                               GROUP BY stage_id
                          `
                        : Promise.resolve([] as { stage_id: string; n: string }[]),
                    sql<{ task_id: string; items: string }[]>`
                        SELECT task_id,
                               SUM(COALESCE((result->>'itemsProcessed')::int, 0))::text AS items
                          FROM task_history
                         WHERE state = 'completed'
                           AND completed_at > NOW() - INTERVAL '1 hour'
                           AND task_id = ANY(${idArray})
                           AND result ? 'itemsProcessed'
                         GROUP BY task_id
                    `,
                ]);
                // Merge: for each task, prefer stage-completion total over
                // itemsProcessed sum. Tasks present in the stage-row tier
                // hide their itemsProcessed entry in the output so the
                // downstream Map.set never overwrites.
                const fromStages = new Map<string, number>();
                for (const r of stageRows) {
                    const taskId = stageToTask.get(r.stage_id);
                    if (!taskId) continue;
                    fromStages.set(
                        taskId,
                        (fromStages.get(taskId) ?? 0) + (parseInt(r.n, 10) || 0),
                    );
                }
                const out: { task_id: string; items: string }[] = [];
                for (const [taskId, n] of fromStages) {
                    out.push({ task_id: taskId, items: n.toString() });
                }
                for (const r of itemsRows) {
                    if (tasksWithStages.has(r.task_id)) continue;
                    out.push(r);
                }
                return out;
            } catch (err) {
                log.warn('lane-data: throughput query failed', {
                    err: String(err),
                });
                return [];
            }
        })(),
        (async () => {
            try {
                // Live pending backlog per covered stage — same predicate as
                // `countSweepBacklog` (the query behind
                // /api/admin/coverage/backlog, which feeds the catalog
                // card's live "N in backlog" pulse via
                // task-aggregates.ts's `coverageBacklog`). Used below to
                // compute `backlogRemaining` from live state instead of the
                // last terminal run's self-reported snapshot, so the lane
                // card and detail drawer agree with the live pulse even
                // when the task is currently failing.
                const ordinaryStages = allCoveredStages.filter(
                    (id) => id !== 'trickplay-params-sync',
                );
                const rows: { stage_id: string; n: string }[] =
                    ordinaryStages.length > 0
                        ? await sql<{ stage_id: string; n: string }[]>`
                          SELECT s.stage_id, COUNT(*)::text AS n
                            FROM media_item_stage_state s
                            JOIN media_items mi ON mi.id = s.media_item_id
                           WHERE s.stage_id = ANY(${sql.array(ordinaryStages)})
                             AND s.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
                             AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= NOW())
                             AND COALESCE(mi.is_dismissed, false) = false
                             AND mi.status = 'active'
                           GROUP BY s.stage_id
                      `
                        : [];
                if (allCoveredStages.includes('trickplay-params-sync')) {
                    const counts = await getTrickplayDisplayCounts(sql);
                    rows.push({ stage_id: 'trickplay-params-sync', n: String(counts.remaining) });
                }
                return rows;
            } catch (err) {
                log.warn('lane-data: live-backlog query failed', {
                    err: String(err),
                });
                return [];
            }
        })(),
    ]);

    const toIso = (v: unknown): string | null => {
        if (v == null) return null;
        if (v instanceof Date) return v.toISOString();
        if (typeof v === 'string') return v;
        return null;
    };

    const activeMap = new Map(
        activeRows.map((r) => [
            r.task_id,
            {
                activeCount: parseInt(r.active_count, 10) || 0,
                lastStartedAt: toIso(r.last_started_at),
            },
        ]),
    );

    // SQL active/pending/cancelling is an in-flight record, not execution
    // proof. Probe a fixed number of recent hashes per task for actual
    // pending→active admissions. Missing hashes (including old workers or
    // Valkey outage) leave the count at zero, while activeCount still guards
    // duplicate controls and preserves the old aggregate contract.
    let client: ValkeyLike | undefined = providedClient;
    if (!client && !providedSql) {
        try {
            client = requireClient();
        } catch {
            /* recorded state remains available */
        }
    }
    const observedActive = new Map<string, number>();
    if (client) {
        await Promise.all(
            activeRows.flatMap((row) =>
                (row.sample_run_ids ?? []).map(async (runId) => {
                    try {
                        const state = await client.customCommand([
                            'HGET',
                            `task:run:active:${runId}`,
                            'state',
                        ]);
                        const start = await client.customCommand([
                            'HGET',
                            `task:run:active:${runId}`,
                            'startedAt',
                        ]);
                        if (
                            state === 'active' &&
                            typeof start === 'string' &&
                            !Number.isNaN(Date.parse(start))
                        )
                            observedActive.set(
                                row.task_id,
                                (observedActive.get(row.task_id) ?? 0) + 1,
                            );
                    } catch {
                        /* no runtime observation */
                    }
                }),
            ),
        );
    }

    const terminalMap = new Map(
        terminalRows.map((r) => [
            r.task_id,
            {
                state: r.state,
                completedAt: toIso(r.completed_at),
                backlogRemaining: sumStages(r.stages),
                durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
            },
        ]),
    );

    const failCountMap = new Map(
        failCountRows.map((r) => [r.task_id, parseInt(r.fail_count, 10) || 0]),
    );

    const circuitMap = new Map(circuitRows.map((r) => [r.task_id, coerceCircuitState(r.state)]));

    const throughputMap = new Map(
        throughputRows.map((r) => {
            const parsed = parseInt(r.items, 10);
            return [r.task_id, Number.isFinite(parsed) && parsed > 0 ? parsed : null];
        }),
    );

    const lastErrorMap = new Map(
        lastErrorRows
            .filter((r) => r.last_error && r.last_error.length > 0)
            .map((r) => [r.task_id, r.last_error as string]),
    );

    // Live pending backlog, summed per task across its covered stages —
    // mirrors the `fromStages` merge above for throughput. Only tasks present
    // in `tasksWithStages` use this map; everyone else falls back to the
    // terminal-run snapshot below.
    const liveBacklogByTask = new Map<string, number>();
    for (const r of liveBacklogRows) {
        const taskId = stageToTask.get(r.stage_id);
        if (!taskId) continue;
        liveBacklogByTask.set(
            taskId,
            (liveBacklogByTask.get(taskId) ?? 0) + (parseInt(r.n, 10) || 0),
        );
    }

    const result = new Map<string, TaskLaneInfo>();
    for (const id of taskIds) {
        const active = activeMap.get(id);
        const terminal = terminalMap.get(id);
        const recentFailCount = failCountMap.get(id) ?? 0;
        const circuitState = circuitMap.get(id) ?? 'closed';
        // Live source wins whenever the task covers stages; the last
        // terminal run's self-reported snapshot is only a fallback for tasks
        // with no coversStages declaration (or when the caller omitted
        // stagesByTask entirely).
        const backlogRemaining = tasksWithStages.has(id)
            ? (liveBacklogByTask.get(id) ?? 0)
            : (terminal?.backlogRemaining ?? 0);

        const info: Omit<TaskLaneInfo, 'lane'> = {
            activeCount: active?.activeCount ?? 0,
            observedActiveCount: observedActive.get(id) ?? 0,
            lastStartedAt: active?.lastStartedAt ?? null,
            lastCompletedAt: terminal?.completedAt ?? null,
            backlogRemaining,
            recentFailCount,
            circuitState,
            // Window is 1h, so itemsPerHour == total items observed in window.
            // This stage's backlog counts linked file pairs while coverage
            // completion throughput counts item rows. Their ratio is not an ETA.
            itemsPerHour: id === 'trickplay-params-sync' ? null : (throughputMap.get(id) ?? null),
            lastFailedError: lastErrorMap.get(id) ?? null,
            lastDurationMs:
                terminal?.durationMs != null && Number.isFinite(terminal.durationMs)
                    ? terminal.durationMs
                    : null,
        };

        result.set(id, { ...info, lane: classifyLane(info) });
    }

    return result;
}

export function classifyLane(info: Omit<TaskLaneInfo, 'lane'>): TaskLane {
    if (info.activeCount > 0) return 'active';
    if (info.recentFailCount > 0 || info.circuitState !== 'closed') return 'failed';
    if (info.backlogRemaining > 0) return 'pending';
    return 'healthy';
}

export interface StaleEdgeAlert {
    upstreamId: string;
    downstreamId: string;
    upstreamCompletedAt: string;
    downstreamCompletedAt: string | null;
    staleByMs: number;
}

export function computeStaleEdges(
    edges: Array<{ upstream: string; downstream: string }>,
    laneMap: Map<string, TaskLaneInfo>,
    schedulesByTask: Map<string, { everyMs: number | null }>,
): StaleEdgeAlert[] {
    const now = Date.now();
    const alerts: StaleEdgeAlert[] = [];

    for (const { upstream, downstream } of edges) {
        const upInfo = laneMap.get(upstream);
        const downInfo = laneMap.get(downstream);
        const sched = schedulesByTask.get(downstream);

        if (!sched || sched.everyMs === null) continue;
        if (!upInfo?.lastCompletedAt) continue;

        const upMs = new Date(upInfo.lastCompletedAt).getTime();
        if (!Number.isFinite(upMs)) continue;
        const threshold = 2 * sched.everyMs;

        if (downInfo?.lastCompletedAt) {
            const downMs = new Date(downInfo.lastCompletedAt).getTime();
            if (!Number.isFinite(downMs)) continue;
            const delta = upMs - downMs;
            if (delta > threshold) {
                alerts.push({
                    upstreamId: upstream,
                    downstreamId: downstream,
                    upstreamCompletedAt: upInfo.lastCompletedAt,
                    downstreamCompletedAt: downInfo.lastCompletedAt,
                    staleByMs: delta,
                });
            }
        } else {
            const staleByMs = now - upMs;
            if (staleByMs > threshold) {
                alerts.push({
                    upstreamId: upstream,
                    downstreamId: downstream,
                    upstreamCompletedAt: upInfo.lastCompletedAt,
                    downstreamCompletedAt: null,
                    staleByMs,
                });
            }
        }
    }

    return alerts;
}

export function summarizeLanes(map: Map<string, TaskLaneInfo>): TaskLaneSummary {
    let activeCount = 0;
    let pendingItems = 0;
    let failedLast24h = 0;

    for (const info of map.values()) {
        if (info.lane === 'active') activeCount++;
        pendingItems += info.backlogRemaining;
        failedLast24h += info.recentFailCount;
    }

    return { activeCount, pendingItems, failedLast24h };
}
