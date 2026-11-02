// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/admin/task-system/metrics — Prometheus → JSON bridge (Slice 0 §4.6).
//
// Gives non-Prometheus OSS users the operational numbers without a scraper. A
// PURE PROJECTION of the existing tasksRegistry counters/gauges — no new
// computation. Reshapes getMetricsAsJSON() into a curated, typed object.

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { tasksRegistry } from '$lib/server/tasks/metrics.js';
import type { MetricsBridgeResponse } from '$lib/schemas/task-system-observability.schema.js';

type MetricValue = {
    value: number;
    labels: Record<string, string | number>;
    metricName?: string;
};
type MetricJson = { name: string; type: string; values: MetricValue[] };

function lbl(v: MetricValue, key: string): string {
    const raw = v.labels[key];
    return raw === undefined ? '' : String(raw);
}

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['metrics:read'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const metrics = (await tasksRegistry.getMetricsAsJSON()) as unknown as MetricJson[];
            const byName = new Map(metrics.map((m) => [m.name, m]));

            const queueDepth = (byName.get('lumastra_task_queue_depth')?.values ?? []).map((v) => ({
                queue: lbl(v, 'queue'),
                resourceClass: lbl(v, 'resource_class'),
                value: v.value,
            }));

            const runsByStatus = (byName.get('lumastra_task_runs_total')?.values ?? []).map(
                (v) => ({
                    taskId: lbl(v, 'task_id'),
                    status: lbl(v, 'status'),
                    resourceClass: lbl(v, 'resource_class'),
                    value: v.value,
                }),
            );

            const activeRuns = (byName.get('lumastra_task_active_runs')?.values ?? []).map((v) => ({
                resourceClass: lbl(v, 'resource_class'),
                instanceId: lbl(v, 'instance_id'),
                value: v.value,
            }));

            // Histogram: aggregate buckets (summed across task_id/resource_class
            // labels) + the overall _sum / _count.
            const durationValues = byName.get('lumastra_task_duration_seconds')?.values ?? [];
            const bucketTotals = new Map<string, number>();
            let durationSum = 0;
            let durationCount = 0;
            for (const v of durationValues) {
                if (v.metricName?.endsWith('_bucket')) {
                    const le = lbl(v, 'le');
                    bucketTotals.set(le, (bucketTotals.get(le) ?? 0) + v.value);
                } else if (v.metricName?.endsWith('_sum')) {
                    durationSum += v.value;
                } else if (v.metricName?.endsWith('_count')) {
                    durationCount += v.value;
                }
            }
            const buckets = [...bucketTotals.entries()].map(([le, value]) => ({
                le,
                value,
            }));

            const backpressureTotals = (
                byName.get('lumastra_task_backpressure_total')?.values ?? []
            ).map((v) => ({
                resourceClass: lbl(v, 'resource_class'),
                action: lbl(v, 'action'),
                value: v.value,
            }));

            const stageBacklog = (byName.get('lumastra_stage_state_backlog')?.values ?? []).map(
                (v) => ({ stageId: lbl(v, 'stage_id'), value: v.value }),
            );

            const sumValues = (name: string): number =>
                (byName.get(name)?.values ?? []).reduce((acc, v) => acc + v.value, 0);

            const response: MetricsBridgeResponse = {
                timestamp: new Date().toISOString(),
                queueDepth,
                runsByStatus,
                activeRuns,
                duration: { buckets, sum: durationSum, count: durationCount },
                backpressureTotals,
                stageBacklog,
                pendingWriteDropped: sumValues('lumastra_task_pending_write_dropped_total'),
                pendingWritePoisoned: sumValues('lumastra_task_pending_write_poisoned_total'),
            };

            return json(response);
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
