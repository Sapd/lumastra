// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// snapshot-writer.ts — periodic trend-snapshot writer (Slice 3 §4.4).
//
// The ONLY new write path in Slice 3. Piggybacked on the leader-gated reconciler
// tick (30s) but SAMPLED to a coarse cadence (~5 min) via a Valkey `next at`
// guard so the table stays small. Reads the in-process Prometheus registry +
// circuit fleet + queue depths, computes p50/p95 from the duration histogram's
// cumulative buckets, diffs run-count deltas against the previous row, INSERTs
// one row, and prunes >30d. Best-effort end-to-end — never breaks the tick.

import type postgres from 'postgres';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { tasksRegistry } from '../metrics.js';
import {
    insertSnapshot,
    pruneSnapshots,
} from '$lib/server/database/queries/task-metrics-snapshot.queries.js';
import { getCircuitFleet } from './circuit-fleet.service.js';

const log = Logger.for('SnapshotWriter');

/** Coarse snapshot cadence — one row per this many ms, leader-gated. */
export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
/** Valkey guard key holding the next-eligible snapshot epoch-ms. */
const NEXT_AT_KEY = 'task:obs:snapshot:next-at';

export interface PromValue {
    labels: Record<string, string | number>;
    value: number;
    metricName?: string;
}
export interface PromMetric {
    name: string;
    type: string;
    values: PromValue[];
}

/**
 * Interpolate a percentile (0..1) from a Prometheus histogram's CUMULATIVE
 * bucket counts. Returns ms (the buckets are in seconds → ×1000), or null if
 * the histogram is empty. This is the percentile of the CUMULATIVE distribution
 * (lifetime of the process), not a per-window percentile — documented as such.
 */
export function percentileFromHistogram(
    buckets: Array<{ le: number; cumulative: number }>,
    quantile: number,
): number | null {
    const sorted = [...buckets].sort((a, b) => a.le - b.le);
    const totalRaw = sorted.find((b) => !Number.isFinite(b.le))?.cumulative;
    const total = totalRaw ?? (sorted.length > 0 ? sorted[sorted.length - 1].cumulative : 0);
    if (!total || total <= 0) return null;

    const target = quantile * total;
    let prevLe = 0;
    let prevCum = 0;
    for (const b of sorted) {
        if (b.cumulative >= target) {
            if (!Number.isFinite(b.le)) {
                // Target lands in the +Inf overflow bucket — clamp to the last
                // finite boundary (no upper bound to interpolate against).
                return Math.round(prevLe * 1000);
            }
            const bucketCount = b.cumulative - prevCum;
            if (bucketCount <= 0) return Math.round(b.le * 1000);
            const frac = (target - prevCum) / bucketCount;
            const interp = prevLe + frac * (b.le - prevLe);
            return Math.round(interp * 1000);
        }
        prevLe = b.le;
        prevCum = b.cumulative;
    }
    return Math.round(prevLe * 1000);
}

/** Extract p50/p95 (ms) + total run count from the registry JSON snapshot. */
export function readDurationAndRuns(metrics: PromMetric[]): {
    p50Ms: number | null;
    p95Ms: number | null;
    totalRuns: number;
} {
    const duration = metrics.find((m) => m.name === 'lumastra_task_duration_seconds');
    let p50Ms: number | null = null;
    let p95Ms: number | null = null;
    if (duration) {
        // Aggregate bucket counts across all label combinations into one
        // cumulative-by-le map (the histogram is per task_id/resource_class).
        const byLe = new Map<number, number>();
        for (const v of duration.values) {
            if (v.metricName && v.metricName.endsWith('_bucket')) {
                const leRaw = v.labels.le;
                const le = leRaw === '+Inf' ? Infinity : Number(leRaw);
                byLe.set(le, (byLe.get(le) ?? 0) + v.value);
            }
        }
        const buckets = [...byLe.entries()].map(([le, cumulative]) => ({
            le,
            cumulative,
        }));
        p50Ms = percentileFromHistogram(buckets, 0.5);
        p95Ms = percentileFromHistogram(buckets, 0.95);
    }

    const runs = metrics.find((m) => m.name === 'lumastra_task_runs_total');
    let totalRuns = 0;
    if (runs) {
        for (const v of runs.values) totalRuns += v.value;
    }
    return { p50Ms, p95Ms, totalRuns };
}

/** Count terminal run totals split by completed vs failed/cancelled. */
export function splitRunTotals(metrics: PromMetric[]): {
    completed: number;
    failed: number;
} {
    const runs = metrics.find((m) => m.name === 'lumastra_task_runs_total');
    let completed = 0;
    let failed = 0;
    if (runs) {
        for (const v of runs.values) {
            const status = String(v.labels.status ?? '');
            if (status === 'completed') completed += v.value;
            else if (status === 'failed' || status === 'cancelled') failed += v.value;
        }
    }
    return { completed, failed };
}

async function shouldSnapshotNow(now: number): Promise<boolean> {
    try {
        const client = getCoordinationClient();
        if (!client) return true; // Valkey down → fall back to writing each tick.
        const raw = await client.customCommand(['GET', NEXT_AT_KEY]);
        const str =
            typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString('utf8') : null;
        const nextAt = str ? Number(str) : 0;
        if (Number.isFinite(nextAt) && now < nextAt) return false;
        // Reserve the next window (best-effort; last-writer-wins is fine).
        await client.customCommand([
            'SET',
            NEXT_AT_KEY,
            String(now + SNAPSHOT_INTERVAL_MS),
            'PX',
            String(SNAPSHOT_INTERVAL_MS * 3),
        ]);
        return true;
    } catch {
        return true;
    }
}

/**
 * Write one trend snapshot if the coarse cadence guard allows it, then prune
 * rows older than 30 days. Best-effort: any failure logs and returns. Called
 * from the reconciler tick with the task pool `sql` and the orchestrator's
 * queue-depth probe.
 */
export async function maybeWriteSnapshot(
    sql: postgres.Sql,
    deps: {
        getQueueDepths: () => Promise<
            Record<
                string,
                {
                    waiting: number;
                    active: number;
                    delayed: number;
                    paused: boolean;
                }
            >
        >;
    },
): Promise<void> {
    try {
        const now = Date.now();
        if (!(await shouldSnapshotNow(now))) return;

        const metrics = (await tasksRegistry.getMetricsAsJSON()) as unknown as PromMetric[];
        const { p50Ms, p95Ms } = readDurationAndRuns(metrics);
        const split = splitRunTotals(metrics);

        const depths = await deps.getQueueDepths().catch(
            () =>
                ({}) as Record<
                    string,
                    {
                        waiting: number;
                        active: number;
                        delayed: number;
                        paused: boolean;
                    }
                >,
        );
        const queueDepth: Record<string, number> = {};
        const activeRuns: Record<string, number> = {};
        for (const [cls, d] of Object.entries(depths)) {
            queueDepth[cls] = d.waiting;
            activeRuns[cls] = d.active;
        }

        const fleet = await getCircuitFleet(sql).catch(() => ({
            summary: { open: 0, halfOpen: 0, forceEnabled: 0, total: 0 },
            entries: [],
        }));

        await insertSnapshot(sql, {
            instanceId: config.INSTANCE_ID,
            queueDepth,
            activeRuns,
            durationP50Ms: p50Ms,
            durationP95Ms: p95Ms,
            // Store CUMULATIVE process totals (the Prometheus counters are
            // monotonic). The trends UI diffs adjacent points to render
            // per-interval deltas — keeping the writer stateless and
            // restart-safe (a fresh process resets to 0, which the UI's
            // clamp-negative-delta-to-0 handles).
            runsCompleted: split.completed,
            runsFailed: split.failed,
            openCircuits: fleet.summary.open,
        });

        const pruned = await pruneSnapshots(sql).catch(() => 0);
        if (pruned > 0) log.info('pruned trend snapshots', { pruned });
    } catch (err) {
        log.warn('maybeWriteSnapshot failed (best-effort)', {
            err: err instanceof Error ? err.message : String(err),
        });
    }
}
