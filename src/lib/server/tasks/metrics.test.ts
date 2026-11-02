// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the task system Prometheus metrics surface.
 *
 * Verifies counter/histogram/gauge semantics, label cardinality, and that
 * tasksRegistry.metrics() produces valid Prometheus text format.
 *
 * Run with: npx vitest run src/lib/server/tasks/metrics.test.ts
 */

import { describe, it, expect } from 'vitest';
import { Registry, Counter, Histogram, Gauge } from 'prom-client';
import {
    tasksRegistry,
    apiResponseConformanceTotal,
    taskRunsTotal,
    taskDurationSeconds,
    taskQueueDepth,
    taskActiveRuns,
    taskCostUnitsTotal,
    webhookDeliveriesTotal,
} from './metrics.js';

// ── Label cardinality ─────────────────────────────────────────────────────────

describe('metric label names match spec', () => {
    it('taskRunsTotal has task_id, status, resource_class', () => {
        const labelNames = (taskRunsTotal as unknown as { labelNames: string[] }).labelNames;
        expect(labelNames).toEqual(expect.arrayContaining(['task_id', 'status', 'resource_class']));
        expect(labelNames).toHaveLength(3);
    });

    it('taskDurationSeconds has task_id, resource_class', () => {
        const labelNames = (taskDurationSeconds as unknown as { labelNames: string[] }).labelNames;
        expect(labelNames).toEqual(expect.arrayContaining(['task_id', 'resource_class']));
        expect(labelNames).toHaveLength(2);
    });

    it('taskQueueDepth has queue, resource_class', () => {
        const labelNames = (taskQueueDepth as unknown as { labelNames: string[] }).labelNames;
        expect(labelNames).toEqual(expect.arrayContaining(['queue', 'resource_class']));
        expect(labelNames).toHaveLength(2);
    });

    it('taskActiveRuns has resource_class, instance_id', () => {
        const labelNames = (taskActiveRuns as unknown as { labelNames: string[] }).labelNames;
        expect(labelNames).toEqual(expect.arrayContaining(['resource_class', 'instance_id']));
        expect(labelNames).toHaveLength(2);
    });

    it('taskCostUnitsTotal has task_id, cost_unit', () => {
        const labelNames = (taskCostUnitsTotal as unknown as { labelNames: string[] }).labelNames;
        expect(labelNames).toEqual(expect.arrayContaining(['task_id', 'cost_unit']));
        expect(labelNames).toHaveLength(2);
    });

    it('webhookDeliveriesTotal has status only', () => {
        const labelNames = (webhookDeliveriesTotal as unknown as { labelNames: string[] })
            .labelNames;
        expect(labelNames).toEqual(expect.arrayContaining(['status']));
        expect(labelNames).toHaveLength(1);
    });
});

// ── Fresh registry for isolation ──────────────────────────────────────────────

function makeIsolated(): {
    registry: Registry;
    runs: Counter<'task_id' | 'status' | 'resource_class'>;
    duration: Histogram<'task_id' | 'resource_class'>;
    depth: Gauge<'queue' | 'resource_class'>;
    active: Gauge<'resource_class' | 'instance_id'>;
    cost: Counter<'task_id' | 'cost_unit'>;
    webhooks: Counter<'status'>;
} {
    const registry = new Registry();
    const runs = new Counter({
        name: 'test_task_runs_total',
        help: 'test',
        labelNames: ['task_id', 'status', 'resource_class'] as const,
        registers: [registry],
    });
    const duration = new Histogram({
        name: 'test_task_duration_seconds',
        help: 'test',
        labelNames: ['task_id', 'resource_class'] as const,
        buckets: [0.1, 1, 10],
        registers: [registry],
    });
    const depth = new Gauge({
        name: 'test_task_queue_depth',
        help: 'test',
        labelNames: ['queue', 'resource_class'] as const,
        registers: [registry],
    });
    const active = new Gauge({
        name: 'test_task_active_runs',
        help: 'test',
        labelNames: ['resource_class', 'instance_id'] as const,
        registers: [registry],
    });
    const cost = new Counter({
        name: 'test_task_cost_units_total',
        help: 'test',
        labelNames: ['task_id', 'cost_unit'] as const,
        registers: [registry],
    });
    const webhooks = new Counter({
        name: 'test_webhook_deliveries_total',
        help: 'test',
        labelNames: ['status'] as const,
        registers: [registry],
    });
    return { registry, runs, duration, depth, active, cost, webhooks };
}

// ── Counter semantics ─────────────────────────────────────────────────────────

describe('Counter increments correctly', () => {
    it('taskRunsTotal increments by 1', async () => {
        const { registry, runs } = makeIsolated();
        runs.inc({
            task_id: 'scan',
            status: 'completed',
            resource_class: 'io',
        });
        const text = await registry.metrics();
        expect(text).toContain(
            'test_task_runs_total{task_id="scan",status="completed",resource_class="io"} 1',
        );
    });

    it('taskRunsTotal accumulates across multiple labels', async () => {
        const { registry, runs } = makeIsolated();
        runs.inc({
            task_id: 'embed',
            status: 'completed',
            resource_class: 'embedding',
        });
        runs.inc({
            task_id: 'embed',
            status: 'failed',
            resource_class: 'embedding',
        });
        runs.inc({
            task_id: 'embed',
            status: 'completed',
            resource_class: 'embedding',
        });
        const text = await registry.metrics();
        expect(text).toContain('task_id="embed",status="completed",resource_class="embedding"} 2');
        expect(text).toContain('task_id="embed",status="failed",resource_class="embedding"} 1');
    });

    it('taskCostUnitsTotal increments with amount', async () => {
        const { registry, cost } = makeIsolated();
        cost.inc({ task_id: 'embed', cost_unit: 'openai_tokens' }, 500);
        cost.inc({ task_id: 'embed', cost_unit: 'openai_tokens' }, 300);
        const text = await registry.metrics();
        expect(text).toContain('openai_tokens"} 800');
    });

    it('webhookDeliveriesTotal increments by status bucket', async () => {
        const { registry, webhooks } = makeIsolated();
        webhooks.inc({ status: '2xx' });
        webhooks.inc({ status: '2xx' });
        webhooks.inc({ status: 'failed' });
        const text = await registry.metrics();
        expect(text).toContain('status="2xx"} 2');
        expect(text).toContain('status="failed"} 1');
    });
});

// ── Histogram semantics ───────────────────────────────────────────────────────

describe('Histogram observes correctly', () => {
    it('records observations in buckets', async () => {
        const { registry, duration } = makeIsolated();
        duration.observe({ task_id: 'scan', resource_class: 'io' }, 0.5);
        duration.observe({ task_id: 'scan', resource_class: 'io' }, 5);
        const text = await registry.metrics();
        // sum should be 5.5
        expect(text).toContain(
            'test_task_duration_seconds_sum{task_id="scan",resource_class="io"} 5.5',
        );
        expect(text).toContain(
            'test_task_duration_seconds_count{task_id="scan",resource_class="io"} 2',
        );
    });
});

// ── Gauge semantics ───────────────────────────────────────────────────────────

describe('Gauge set/inc/dec', () => {
    it('taskQueueDepth set/overwrite', async () => {
        const { registry, depth } = makeIsolated();
        depth.set({ queue: 'task:io', resource_class: 'io' }, 42);
        depth.set({ queue: 'task:io', resource_class: 'io' }, 10);
        const text = await registry.metrics();
        expect(text).toContain('task:io"');
        expect(text).toContain('} 10');
    });

    it('taskActiveRuns inc/dec', async () => {
        const { registry, active } = makeIsolated();
        active.inc({ resource_class: 'cpu', instance_id: 'web-1' });
        active.inc({ resource_class: 'cpu', instance_id: 'web-1' });
        active.dec({ resource_class: 'cpu', instance_id: 'web-1' });
        const text = await registry.metrics();
        expect(text).toContain('instance_id="web-1"');
        expect(text).toContain('} 1');
    });
});

// ── Registry output format ────────────────────────────────────────────────────

describe('tasksRegistry.metrics() Prometheus text format', () => {
    it('produces a non-empty string with # HELP and # TYPE lines', async () => {
        const text = await tasksRegistry.metrics();
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
        expect(text).toContain('# HELP lumastra_task_runs_total');
        expect(text).toContain('# TYPE lumastra_task_runs_total counter');
        expect(text).toContain('# HELP lumastra_task_duration_seconds');
        expect(text).toContain('# HELP lumastra_task_queue_depth');
        expect(text).toContain('# HELP lumastra_task_active_runs');
        expect(text).toContain('# HELP lumastra_task_cost_units_total');
        expect(text).toContain('# HELP lumastra_task_webhook_deliveries_total');
    });

    it('contentType is text/plain with version', () => {
        expect(tasksRegistry.contentType).toContain('text/plain');
        expect(tasksRegistry.contentType).toContain('0.0.4');
    });
});

// Conformance totals remain available in /metrics even when Valkey is down.
describe('API response conformance metric', () => {
    it('exposes boot totals labelled by method, route id and kind', async () => {
        apiResponseConformanceTotal.reset();
        apiResponseConformanceTotal.inc(
            { method: 'GET', route: '/api/test/[id]', kind: 'stripped' },
            3,
        );
        apiResponseConformanceTotal.inc({
            method: 'GET',
            route: '/api/test/[id]',
            kind: 'mismatch',
        });
        const text = await tasksRegistry.metrics();
        expect(text).toContain('# TYPE lumastra_api_response_conformance_total counter');
        expect(text).toContain(
            'lumastra_api_response_conformance_total{method="GET",route="/api/test/[id]",kind="stripped"} 3',
        );
        expect(text).toContain(
            'lumastra_api_response_conformance_total{method="GET",route="/api/test/[id]",kind="mismatch"} 1',
        );
        apiResponseConformanceTotal.reset();
    });
});

describe('worker runtime metrics', () => {
    it('exports upgrade, watcher, consumer and lease state at scrape time', async () => {
        const { applyWorkerRuntimeMetrics } = await import('./metrics.js');
        const { markLoopTick } = await import('./loop-progress.js');
        markLoopTick('scheduler', 1_700_000_000_000);
        applyWorkerRuntimeMetrics(
            {
                upgradeState: 'prepared',
                consumers: { running: 4, paused: 4 },
                watcher: { state: 'degraded', restarts: 2 },
                lease: {
                    held: true,
                    // Database clock 40 s off: must not leak into the local age.
                    lastRenewAt: new Date(1_000_000 - 47_000).toISOString(),
                    lastRenewLocalAt: new Date(1_000_000 - 7_000).toISOString(),
                },
            },
            1_000_000,
        );
        applyWorkerRuntimeMetrics({ watcher: { state: 'ready', restarts: 3 } });
        const text = await tasksRegistry.metrics();
        expect(text).toContain('lumastra_task_runtime_upgrade_state{state="prepared"} 1');
        expect(text).toContain('lumastra_task_runtime_upgrade_state{state="idle"} 0');
        expect(text).toContain('lumastra_task_runtime_consumers{condition="paused"} 4');
        expect(text).toContain('lumastra_task_runtime_watcher_state{state="ready"} 1');
        expect(text).toContain('lumastra_task_runtime_watcher_restarts_total 3');
        expect(text).toContain('lumastra_task_runtime_singleton_lease_held 1');
        expect(text).toContain('lumastra_task_runtime_singleton_lease_seconds_since_renew 7');
        expect(text).toContain(
            'lumastra_task_runtime_last_tick_timestamp_seconds{loop="scheduler"} 1700000000',
        );
        expect(text).toContain('lumastra_task_runtime_uncaught_exceptions_total');
    });
});
