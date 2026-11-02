// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// metrics.ts — Prometheus metric surface for the task system.
//
// Six metrics with bounded cardinality. Per plan §12.3:
//   - lumastra_task_runs_total          counter
//   - lumastra_task_duration_seconds    histogram
//   - lumastra_task_queue_depth         gauge
//   - lumastra_task_active_runs         gauge
//   - lumastra_task_cost_units_total    counter
//   - lumastra_task_webhook_deliveries_total counter
//
// Cardinality note: library_group_id is NOT a label (per plan §12.3).

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { fsGuardStats } from '$lib/server/utils/safe-fs.js';
import { getLoopTick } from './loop-progress.js';

export const tasksRegistry = new Registry();

// Collect Node.js default metrics (event-loop lag, GC, heap, RSS) into the
// shared registry. Called once at module init — prom-client guards against
// double-registration automatically.
//
// Skipped under vitest: collectDefaultMetrics installs an event-loop-lag monitor
// (a libuv timer) that keeps the worker fork alive, which starves vitest's fork
// pool and makes unrelated test files time out. The /metrics endpoint isn't
// exercised in unit tests, so nothing is lost.
if (!process.env.VITEST) {
    collectDefaultMetrics({ register: tasksRegistry });
}

export const taskRunsTotal = new Counter({
    name: 'lumastra_task_runs_total',
    help: 'Total task runs by terminal status',
    labelNames: ['task_id', 'status', 'resource_class'] as const,
    registers: [tasksRegistry],
});

export const taskDurationSeconds = new Histogram({
    name: 'lumastra_task_duration_seconds',
    help: 'Task duration in seconds from pending to terminal state',
    labelNames: ['task_id', 'resource_class'] as const,
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300, 1800, 7200],
    registers: [tasksRegistry],
});

export const taskQueueDepth = new Gauge({
    name: 'lumastra_task_queue_depth',
    help: 'Current number of waiting jobs in the BullMQ queue',
    labelNames: ['queue', 'resource_class'] as const,
    registers: [tasksRegistry],
});

export const taskActiveRuns = new Gauge({
    name: 'lumastra_task_active_runs',
    help: 'Number of currently active runs on this instance',
    labelNames: ['resource_class', 'instance_id'] as const,
    registers: [tasksRegistry],
});

// safe-fs guard telemetry — the early-warning signal for a filesystem wedge.
// `waiting` sustained > 0 (all permits held AND ops queueing) means guarded fs
// ops are backing up behind a slow/unhealthy mount BEFORE it cascades to
// getaddrinfo/DB starvation. `collect()` samples at scrape time, so no hot-path
// wiring is needed. Alert on: lumastra_fs_guard_waiting > 0 for N minutes.
export const fsGuardInFlight = new Gauge({
    name: 'lumastra_fs_guard_inflight',
    help: 'In-flight guarded filesystem ops (proxy for occupied libuv threadpool threads)',
    registers: [tasksRegistry],
    collect() {
        this.set(fsGuardStats().inFlight);
    },
});

export const fsGuardWaiting = new Gauge({
    name: 'lumastra_fs_guard_waiting',
    help: 'Guarded filesystem ops queued for a permit — sustained > 0 signals an unhealthy mount',
    registers: [tasksRegistry],
    collect() {
        this.set(fsGuardStats().waiting);
    },
});

export const fsGuardMaxConcurrency = new Gauge({
    name: 'lumastra_fs_guard_max_concurrency',
    help: 'Effective fs concurrency cap (clamped below the libuv threadpool)',
    registers: [tasksRegistry],
    collect() {
        this.set(fsGuardStats().maxConcurrency);
    },
});

export const taskCostUnitsTotal = new Counter({
    name: 'lumastra_task_cost_units_total',
    help: 'Total cost units spent by task runs',
    labelNames: ['task_id', 'cost_unit'] as const,
    registers: [tasksRegistry],
});

export const webhookDeliveriesTotal = new Counter({
    name: 'lumastra_task_webhook_deliveries_total',
    help: 'Total webhook delivery attempts by status bucket',
    labelNames: ['status'] as const,
    registers: [tasksRegistry],
});

/**
 * APNs push outbox counter, incremented once per outbox ROW per delivery pass —
 * not once per device. A row is the unit the ladder and the DLQ operate on, so
 * this is the series that answers "are pushes getting through".
 *
 * Bounded cardinality: `outcome` is one of `delivered` | `dead` | `retry` |
 * `no_tokens`. `no_tokens` is split out from `delivered` on purpose — a row for
 * a user whose every device token has been deactivated is not a delivery, and
 * folding it in would let a fleet that has lost all its tokens report as 100%
 * healthy.
 */
export const pushDeliveriesTotal = new Counter({
    name: 'lumastra_push_deliveries_total',
    help: 'Push outbox rows resolved per delivery pass, by outcome',
    labelNames: ['outcome'] as const,
    registers: [tasksRegistry],
});

/**
 * Pending-write drain DLQ counter. Increments when an entry exceeds the
 * replay-attempt threshold and is moved to `task:pending-writes:poison`.
 * Bounded cardinality: label is just `kind` (insert | update).
 */
export const taskPendingWritePoisonedTotal = new Counter({
    name: 'lumastra_task_pending_write_poisoned_total',
    help: 'Pending writes moved to the poison DLQ after exhausting replay attempts',
    labelNames: ['kind'] as const,
    registers: [tasksRegistry],
});

/**
 * Pending-write drain capacity-drop counter. Increments when the buffered-write
 * LIST is at its hard cap and the oldest entry is evicted to make room for a new
 * write (data loss). Bounded cardinality: label is just `kind` (insert | update).
 */
export const taskPendingWriteDroppedTotal = new Counter({
    name: 'lumastra_task_pending_write_dropped_total',
    help: 'Pending writes evicted from the buffer at capacity (oldest dropped — data loss)',
    labelNames: ['kind'] as const,
    registers: [tasksRegistry],
});

/**
 * Retained runner terminal writes given up after the age cap so execution can
 * become quiescent. Each one is also logged at error level with run and job ids.
 * Bounded cardinality: label is the terminal state (completed | failed | cancelled).
 */
export const taskTerminalWriteAbandonedTotal = new Counter({
    name: 'lumastra_task_terminal_write_abandoned_total',
    help: 'Retained terminal writes abandoned after the age cap (outcome left to PostgreSQL)',
    labelNames: ['state'] as const,
    registers: [tasksRegistry],
});

/**
 * Run-state transitions dropped from the orchestrator's transition buffer after
 * coalescing could not bring it under its cap (PostgreSQL/Valkey outage).
 * Bounded cardinality: label is `kind` (non_terminal | terminal).
 */
export const taskTransitionBufferDroppedTotal = new Counter({
    name: 'lumastra_task_transition_buffer_dropped_total',
    help: 'Buffered run-state transitions dropped at the buffer cap after coalescing',
    labelNames: ['kind'] as const,
    registers: [tasksRegistry],
});

/**
 * Phantom-dedup counter. Increments when a `startRun` identity-dedup points at a
 * runId whose `task_history` row is absent or already terminal — i.e. a leaked
 * identity SETNX key blocked a fresh run. Self-healing releases the stale key.
 * Bounded cardinality: label is just `task_id`.
 */
export const taskIdentityPhantomDedupTotal = new Counter({
    name: 'lumastra_task_identity_phantom_dedup_total',
    help: 'Identity dedups pointing at an absent/terminal run (leaked identity key, self-healed)',
    labelNames: ['task_id'] as const,
    registers: [tasksRegistry],
});

/**
 * Backpressure action counter (Slice 0 §4.4). Incremented on the enqueue hot
 * path each time a class trips backpressure, alongside a cheap Valkey INCR. The
 * reconciler tick reads-and-resets the Valkey counters into ONE rolled-up
 * audit_log row (source='subsystem') — there is NO per-event Postgres write. Bounded
 * cardinality: resource_class × action (3 actions).
 */
export const taskBackpressureTotal = new Counter({
    name: 'lumastra_task_backpressure_total',
    help: 'Total backpressure actions taken on the enqueue hot path',
    labelNames: ['resource_class', 'action'] as const,
    registers: [tasksRegistry],
});

/**
 * Per-stage backlog gauge — set each sweep tick to the total number of rows
 * in `media_item_stage_state` that are eligible for processing (status IN
 * pending/failed_transient/skipped_transient/obsolete and not dismissed).
 *
 * Label: `stage_id`. Cardinality is bounded by the number of registered
 * enqueueable stages (≤ ~12 at launch).
 */
export const stageSweepBacklog = new Gauge({
    name: 'lumastra_stage_state_backlog',
    help: 'Sweepable rows in media_item_stage_state per stage',
    labelNames: ['stage_id'] as const,
    registers: [tasksRegistry],
});

/**
 * Pending rows in `task_runtime_queue_operations` (queue-write uncertainty
 * journal), sampled by the reconciler's journal janitor. Unmanaged task mode
 * writes no rows, so a non-zero value means a managed write with an unknown
 * outcome or a leftover from an older build.
 */
export const taskQueueJournalPending = new Gauge({
    name: 'lumastra_task_queue_journal_pending',
    help: 'Pending queue-operation journal rows awaiting reconciliation',
    registers: [tasksRegistry],
});

export const taskQueueJournalOldestPendingSeconds = new Gauge({
    name: 'lumastra_task_queue_journal_oldest_pending_seconds',
    help: 'Age in seconds of the oldest pending queue-operation journal row (0 when none)',
    registers: [tasksRegistry],
});

/**
 * HTTP request duration histogram. Labels are deliberately low-cardinality:
 *   - route: SvelteKit route id (e.g. `/api/v1/media/[id]`) or the fallback
 *     sentinel `_unknown` when route.id is absent (e.g. 404 paths).
 *     Never the raw pathname — that is unbounded cardinality.
 *   - method: HTTP verb (GET, POST, …)
 *   - status: HTTP status code as a string
 *
 * Observed by mainHandle in hooks.server.ts on every request.
 */
export const httpRequestDurationSeconds = new Histogram({
    name: 'lumastra_http_request_duration_seconds',
    help: 'HTTP request duration in seconds by route, method, and status',
    labelNames: ['route', 'method', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [tasksRegistry],
});

/**
 * Image-proxy cache hit/miss counter. Incremented in the catalog image path
 * (service.ts) each time a provider result is returned with a known cacheStatus.
 *
 * Labels:
 *   - result: `hit` | `miss`
 *
 * Bounded cardinality: 2 series.
 */
export const imageProxyCacheOpsTotal = new Counter({
    name: 'lumastra_image_proxy_cache_ops_total',
    help: 'Image proxy cache hits and misses from the catalog image path',
    labelNames: ['result'] as const,
    registers: [tasksRegistry],
});

/** Response contract drift since process start; route labels are SvelteKit ids. */
export const apiResponseConformanceTotal = new Counter({
    name: 'lumastra_api_response_conformance_total',
    help: 'API response conformance events since process start',
    labelNames: ['method', 'route', 'kind'] as const,
    registers: [tasksRegistry],
});

// ---------------------------------------------------------------------------
// Dedicated worker runtime state. Alert on a stale last-tick timestamp, a
// prepared upgrade that never resumes, a lease nobody holds, a watcher that is
// not ready, and any growth in uncaught exceptions.
// ---------------------------------------------------------------------------

export const runtimeLastTickTimestamp = new Gauge({
    name: 'lumastra_task_runtime_last_tick_timestamp_seconds',
    help: 'Unix time of the last scheduler or consumer loop turn (not job completion)',
    labelNames: ['loop'] as const,
    registers: [tasksRegistry],
    collect() {
        for (const loop of ['scheduler', 'consumer'] as const) {
            const at = getLoopTick(loop);
            if (at !== undefined) this.set({ loop }, at / 1000);
        }
    },
});

export const runtimeUncaughtExceptionsTotal = new Counter({
    name: 'lumastra_task_runtime_uncaught_exceptions_total',
    help: 'Uncaught exceptions in the dedicated task runtime process',
    registers: [tasksRegistry],
});

export const runtimeUpgradeState = new Gauge({
    name: 'lumastra_task_runtime_upgrade_state',
    help: '1 for the current upgrade-control state of the dedicated worker, 0 for the others',
    labelNames: ['state'] as const,
    registers: [tasksRegistry],
});

export const runtimeWatcherState = new Gauge({
    name: 'lumastra_task_runtime_watcher_state',
    help: '1 for the current library watcher state, 0 for the others',
    labelNames: ['state'] as const,
    registers: [tasksRegistry],
});

export const runtimeWatcherRestartsTotal = new Counter({
    name: 'lumastra_task_runtime_watcher_restarts_total',
    help: 'Library watcher restarts since process start',
    registers: [tasksRegistry],
});

export const runtimeConsumers = new Gauge({
    name: 'lumastra_task_runtime_consumers',
    help: 'BullMQ consumer loops of the dedicated worker by condition (running, paused)',
    labelNames: ['condition'] as const,
    registers: [tasksRegistry],
});

export const runtimeLeaseHeld = new Gauge({
    name: 'lumastra_task_runtime_singleton_lease_held',
    help: '1 when this worker holds the singleton lease, 0 when it does not',
    registers: [tasksRegistry],
});

export const runtimeLeaseSecondsSinceRenew = new Gauge({
    name: 'lumastra_task_runtime_singleton_lease_seconds_since_renew',
    help: 'Seconds since this worker last renewed the singleton lease (absent while not held)',
    registers: [tasksRegistry],
});

const UPGRADE_STATES = ['idle', 'preparing', 'prepared', 'postponed', 'unknown', 'stopping'];
const WATCHER_STATES = ['stopped', 'starting', 'ready', 'degraded', 'failed'];
let watcherRestartsReported = 0;

/** Structural subset of getWorkerRuntimeState(); metrics.ts must not import the task-runtime package. */
export interface WorkerRuntimeMetricsInput {
    upgradeState?: string;
    consumers?: { running: number; paused: number };
    watcher?: { state: string; restarts: number };
    lease?: { held: boolean; lastRenewAt?: string; lastRenewLocalAt?: string };
}

/** Called at scrape time by the dedicated runtime's /metrics handler. */
export function applyWorkerRuntimeMetrics(
    state: WorkerRuntimeMetricsInput,
    now = Date.now(),
): void {
    if (state.upgradeState !== undefined) {
        for (const s of UPGRADE_STATES)
            runtimeUpgradeState.set({ state: s }, s === state.upgradeState ? 1 : 0);
    }
    if (state.watcher) {
        for (const s of WATCHER_STATES)
            runtimeWatcherState.set({ state: s }, s === state.watcher.state ? 1 : 0);
        if (state.watcher.restarts > watcherRestartsReported) {
            runtimeWatcherRestartsTotal.inc(state.watcher.restarts - watcherRestartsReported);
        }
        watcherRestartsReported = state.watcher.restarts;
    }
    if (state.consumers) {
        runtimeConsumers.set({ condition: 'running' }, state.consumers.running);
        runtimeConsumers.set({ condition: 'paused' }, state.consumers.paused);
    }
    if (state.lease) {
        runtimeLeaseHeld.set(state.lease.held ? 1 : 0);
        // Local clock on both sides; lastRenewAt is the database clock.
        const renewed = state.lease.lastRenewLocalAt
            ? Date.parse(state.lease.lastRenewLocalAt)
            : NaN;
        if (state.lease.held && Number.isFinite(renewed)) {
            runtimeLeaseSecondsSinceRenew.set(Math.max(0, (now - renewed) / 1000));
        } else {
            runtimeLeaseSecondsSinceRenew.reset();
        }
    }
}
