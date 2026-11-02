// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task-metrics snapshot queries (Slice 3 §4.4 — migration 16.30.0).
 *
 * The ONLY new write path in Slice 3: one coarse (~5 min, leader-gated) row per
 * tick, fed by the reconciler, providing retained trend samples for OSS users
 * with no Prometheus scraper. Append-only, pruned to 30 days on the same tick.
 *
 * Each function takes `sql: postgres.Sql` first and has no side effects beyond
 * the query. Writes route from `getTaskDb()` (leader tick); reads from `getDb()`.
 */

import type postgres from 'postgres';
import type { TaskMetricsSnapshot } from '$lib/schemas/task-system-failure-detection.schema.js';

export interface SnapshotInsert {
    instanceId: string;
    queueDepth: Record<string, number>;
    activeRuns: Record<string, number>;
    durationP50Ms: number | null;
    durationP95Ms: number | null;
    runsCompleted: number;
    runsFailed: number;
    openCircuits: number;
}

type SnapshotDbRow = {
    id: string;
    ts: Date;
    instance_id: string;
    queue_depth: Record<string, number>;
    active_runs: Record<string, number>;
    duration_p50_ms: number | null;
    duration_p95_ms: number | null;
    runs_completed: number;
    runs_failed: number;
    open_circuits: number;
};

function toNumberRecord(v: unknown): Record<string, number> {
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const n = Number(val);
        if (Number.isFinite(n)) out[k] = n;
    }
    return out;
}

function mapSnapshotRow(r: SnapshotDbRow): TaskMetricsSnapshot {
    return {
        id: Number(r.id),
        ts: new Date(r.ts).toISOString(),
        instanceId: r.instance_id,
        queueDepth: toNumberRecord(r.queue_depth),
        activeRuns: toNumberRecord(r.active_runs),
        durationP50Ms: r.duration_p50_ms != null ? Number(r.duration_p50_ms) : null,
        durationP95Ms: r.duration_p95_ms != null ? Number(r.duration_p95_ms) : null,
        runsCompleted: Number(r.runs_completed),
        runsFailed: Number(r.runs_failed),
        openCircuits: Number(r.open_circuits),
    };
}

/** Insert one trend snapshot row. */
export async function insertSnapshot(sql: postgres.Sql, entry: SnapshotInsert): Promise<void> {
    await sql`
        INSERT INTO task_metrics_snapshot (
            instance_id, queue_depth, active_runs,
            duration_p50_ms, duration_p95_ms,
            runs_completed, runs_failed, open_circuits
        ) VALUES (
            ${entry.instanceId},
            ${sql.json(entry.queueDepth)},
            ${sql.json(entry.activeRuns)},
            ${entry.durationP50Ms},
            ${entry.durationP95Ms},
            ${entry.runsCompleted},
            ${entry.runsFailed},
            ${entry.openCircuits}
        )
    `;
}

/**
 * Snapshots over the last `sinceHours`, oldest→newest (for a left-to-right
 * trend line). `limit` caps the series so a long window can't unbounded the
 * payload. `sinceHours`/`limit` must be pre-clamped by the caller.
 */
export async function listSnapshots(
    sql: postgres.Sql,
    { sinceHours, limit }: { sinceHours: number; limit: number },
): Promise<TaskMetricsSnapshot[]> {
    // Take the newest `limit` rows in the window, then re-order oldest→newest.
    const rows = await sql<SnapshotDbRow[]>`
        SELECT * FROM (
            SELECT id, ts, instance_id, queue_depth, active_runs,
                   duration_p50_ms, duration_p95_ms,
                   runs_completed, runs_failed, open_circuits
            FROM task_metrics_snapshot
            WHERE ts >= NOW() - (${sinceHours} || ' hours')::interval
            ORDER BY ts DESC
            LIMIT ${limit}
        ) recent
        ORDER BY ts ASC
    `;
    return rows.map(mapSnapshotRow);
}

/** Most-recent snapshot row, or null. Used by the writer to diff run-count deltas. */
export async function getLatestSnapshot(sql: postgres.Sql): Promise<TaskMetricsSnapshot | null> {
    const rows = await sql<SnapshotDbRow[]>`
        SELECT id, ts, instance_id, queue_depth, active_runs,
               duration_p50_ms, duration_p95_ms,
               runs_completed, runs_failed, open_circuits
        FROM task_metrics_snapshot
        ORDER BY ts DESC
        LIMIT 1
    `;
    return rows.length > 0 ? mapSnapshotRow(rows[0]) : null;
}

/** Prune snapshot rows older than 30 days. Returns rows deleted. */
export async function pruneSnapshots(sql: postgres.Sql): Promise<number> {
    const deleted = await sql<{ id: string }[]>`
        DELETE FROM task_metrics_snapshot
        WHERE ts < NOW() - INTERVAL '30 days'
        RETURNING id
    `;
    return deleted.length;
}
