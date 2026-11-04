// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// TaskRunner — BullMQ Worker per resource class.
//
// Consumes jobs from BullMQ queues named after the bare resource class
// (`io`, `cpu`, `embedding`, `maintenance`) with Redis prefix `bull:task`
// (final keys: `bull:task:<class>:…`), claims ownership via Lua,
// transitions pending → active, builds a TaskContext, invokes
// `plugin.execute(ctx)`, then writes the terminal state back. Heartbeats
// every LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS to refresh the active hash TTL +
// Postgres heartbeat_at so boot recovery can distinguish orphans from
// in-flight runs.
//
// The runner is the only component that touches plugin code. Plugins never
// see BullMQ internals (`Job`, `WaitingChildrenError`, `moveToWaitingChildren`)
// — pipeline parking is handled here. The downstream trampoline is a minimal
// log-only stub; full Flow-aware parking is a known follow-up.
//
// Capability gates (http/cache/ffmpeg/dataDir) and the secrets/dep/drain
// stubs are wired through `context.ts` / `plugin-context.ts` / `secrets.ts`;
// see those modules for the runtime details.

import {
    closeBullmqBounded,
    logQueueConnectionErrors,
    logTaskConnectionLoss,
    watchWorkerRecovery,
} from './queue-outage.js';
import { withApiCallSpend } from './api-call-spend.js';

import { setTimeout as delay } from 'node:timers/promises';
import { withBackgroundCpu } from './background-cpu-scope.js';
import { runTerminalFollowup } from './run-followups.js';
import {
    getPlaybackPressure,
    isBackgroundCpuTask,
    PRESSURE_RETRY_MS,
    acquirePlaybackCpuSlot,
    playbackCpuExempt,
    playbackDeferralExpired,
    recordPlaybackDeferral,
    type PlaybackCpuSlot,
} from './playback-pressure.js';
import { markLoopTick } from './loop-progress.js';
import { Worker, Queue, DelayedError, UnrecoverableError, type Job, type Processor } from 'bullmq';
import { Worker as ThreadWorker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ulid } from 'ulid';
import type postgres from 'postgres';
import { AuthorityError, type AuthorityToken } from '../../../task-runtime/authority/store.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';
import {
    withTaskQueueWrite,
    QueueOperationUncertainError,
} from '../../../task-runtime/authority/queue-write.js';
import { taskJobId, assertTaskJobOrigin } from '../../../task-runtime/authority/queue-origin.js';
import {
    TaskError,
    type CostKind,
    COST_KINDS,
    type DrainMode,
    type DrainResult,
    RESOURCE_CLASSES,
    type Logger as PluginLogger,
    type RateLimitedFetch,
    type ResourceClass,
    type TaskContext,
    type TaskDefinition,
    type TaskResult,
} from '@sapd/lumastra-plugin-sdk';

/** Set for O(1) membership test in spend/writeCostBreakdown hot paths. */
const COST_KINDS_SET: ReadonlySet<string> = new Set<string>(COST_KINDS);

import { registry as defaultRegistry, type TaskRegistry } from './registry.js';
import { emitActiveRunEvent, emitTerminalRunEvent, type TerminalRunRow } from './runner-events.js';
import {
    StateMachine,
    stateMachine as defaultStateMachine,
    type RunState,
} from './state-machine.js';
import { luaLoader } from './lua/loader.js';
import { invokeOwnedCommand } from './owned-write.js';
import { PluginSecrets } from './secrets.js';
import { RateLimiter } from './rate-limiter.js';
import { CostLedger } from './cost-ledger.js';
import { PendingWriteDrain, isTransientPgError, type PendingWrite } from './pending-write-drain.js';
import {
    captureTerminalQueueAttempt,
    terminalQueueAttemptCurrent,
    terminalResultConfirmed,
    TerminalAttemptJobMissingError,
    TerminalAttemptUnknownError,
    TERMINAL_JOB_MISSING_ACCEPT_AFTER,
    type TerminalQueueAttempt,
} from './terminal-attempt.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { logBuffer } from './log-buffer.js';
import { progressTracker } from './progress.js';
import { taskActiveRuns, taskCostUnitsTotal, taskTerminalWriteAbandonedTotal } from './metrics.js';
import {
    PER_TASK_QUEUE_PREFIX,
    QUEUE_PREFIX,
    perTaskQueueName,
    taskQueueName,
} from './queue-naming.js';
import { BULL_DEFAULT_RETENTION, taskRetryOptions } from './bull-defaults.js';
import { deriveIdentityTtlFloor } from './identity-ttl-floor.js';
import {
    acquireBudget,
    acquireSemaphoreToken,
    refreshSemaphoreTtl,
    clampedDecr,
    isExpressPriority,
    BUDGET_TTL_SECONDS,
    type BudgetAcquisition,
} from './budget-semaphore.js';
import { getQueueConnection } from '$lib/server/tasks/connection.js';
import { ConnectionWedgeWatchdog } from '$lib/server/tasks/connection-watchdog.js';
import { subscribeToCancel } from './cancel-channel.js';
import {
    type ValkeyLike,
    errMessage,
    nowIso,
    requireClient,
    emitMetaEvent,
} from './valkey-types.js';
import { RATE_LIMIT_ERROR_PATTERN } from '$lib/shared/run-error-severity.js';
import { insertTaskHistoryRow } from './task-history.js';
import { wrapExecute } from './run-wrapper.js';
import { markFailureEventsResolved } from '../database/queries/plugin-failure-events.queries.js';
import { condenseFailureReason } from '../utils/failure-reason.js';
import { parseDurationMs } from './duration.js';
import {
    buildIsolationEnv,
    executeInWorker,
    type IsolationHostHooks,
    type IsolationRun,
    type IsolationWorkerLike,
    type SpawnIsolationWorker,
} from './isolation/worker-host.js';
import type { SandboxWorkerData } from './isolation/protocol.js';
import { stageProcessingVersion } from './stage-processing-version.js';
import { getTaskDb, getHeartbeatDb } from '$lib/server/database/connection.js';
import {
    buildCatalogStore,
    buildHttpClient,
    buildMediaFilesStore,
    buildMediaItemsStore,
    buildNamespacedCache,
    buildUnavailableSqlStub,
    buildUserCredentialStore,
} from './context-primitives.js';
import { Logger, type LoggerInstance } from '$lib/server/utils/logger.js';
import { buildPlaylistStore, buildMediaSegmentStore } from './plugin-stores.js';
import {
    buildRunCheckpoint,
    clearCheckpoint,
    interruptMarkerKey,
    INTERRUPT_MARKER_TTL_MS,
    type ResumableJobData,
} from './run-resume.js';
import {
    config,
    LUMASTRA_CONCURRENCY_ANALYSIS,
    LUMASTRA_CONCURRENCY_BULK,
    LUMASTRA_CONCURRENCY_CPU,
    LUMASTRA_CONCURRENCY_DISCOVERY,
    LUMASTRA_CONCURRENCY_EMBEDDING,
    LUMASTRA_CONCURRENCY_INGEST,
    LUMASTRA_CONCURRENCY_IO,
    LUMASTRA_CONCURRENCY_MAINTENANCE,
    LUMASTRA_TASK_HTTP_DEFAULT_RPS,
    LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS,
    LUMASTRA_RUN_STALL_FAIL_MS,
    LUMASTRA_RUN_STALL_WARN_MS,
    LUMASTRA_WORKER_CONN_WEDGE_MS,
    LUMASTRA_BULLMQ_LOCK_DURATION_MS,
    LUMASTRA_RUN_STATE_TTL_ACTIVE_MS,
    FEATURE_PER_TASK_QUEUES,
    FEATURE_PLUGIN_WORKER_ISOLATION,
    LUMASTRA_ISOLATION_DB_POOL_MAX,
    LUMASTRA_ISOLATION_ENTRY_PATH,
    LUMASTRA_ISOLATION_TERMINATE_GRACE_MS,
    LUMASTRA_ISOLATION_WORKER_OLD_HEAP_MB,
    LUMASTRA_ISOLATION_WORKER_YOUNG_HEAP_MB,
    LUMASTRA_ISOLATION_WORKER_STACK_MB,
} from '$lib/server/config.js';

import { resolveTaskProcessRole } from '$lib/server/task-role.js';

const log = Logger.for('TaskRunner');

/**
 * Wall-clock fallback when a task definition omits `timeout.hard`. Generous
 * enough not to disrupt long-running chunked-drain tasks (e.g.
 * `library-embeddings`, `discovery-embeddings`) on first runs against fresh
 * libraries, but bounded so a never-terminating handler cannot camp on a
 * worker slot indefinitely. Tasks that need longer must declare `timeout.hard`
 * explicitly.
 */
const DEFAULT_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// Bound the pipeline.when predecessor-result fetch (a Valkey RPC on the hot path)
// so a Valkey stall can't hang processJob past the wall-clock deadline. On
// timeout we proceed with no parent result (the stage runs rather than skips).
const GET_CHILDREN_VALUES_TIMEOUT_MS = 30_000;

// Bound `resolveBudgetStartMs` (a Valkey HGET + Postgres fallback SELECT run
// BEFORE `startHeartbeat`, i.e. before any watchdog coverage exists for this
// attempt). Without a timeout, a Valkey/Postgres stall here holds the
// acquired concurrency slot indefinitely with nothing able to reclaim it. On
// timeout, fall back to `undefined` — the same fallback `resolveBudgetStartMs`
// already returns when neither source is resolvable — so `startHeartbeat`
// anchors to pickup time instead.
const RESOLVE_BUDGET_START_TIMEOUT_MS = 30_000;

// BUG2: cancel of an `isolation: 'worker'` run is otherwise cooperative-only
// (only `abort.abort()` on the cancel-channel handler) — a synchronously
// wedged worker ignores that until the watchdog's hard timeout (default 2h)
// terminate()s it. When a cancel arrives for a run with a live isolation
// handle, arm a one-shot grace timer of this length; if the run hasn't
// reached a terminal/cleanup state by the time it fires, force-terminate the
// worker instead of waiting out the full hard-timeout window.
const CANCEL_ISOLATION_TERMINATE_GRACE_MS = 30_000;

/**
 * When a per-task worker pops a job but the class budget is exhausted, it
 * re-queues the job with this delay (plus jitter) instead of failing it — the
 * worker can't process it now, so it waits like a job blocked in a per-class
 * queue would under the old model. The jitter spreads re-pops so many
 * budget-blocked jobs don't all wake at once (thundering herd). Tuned short so
 * a freed token is picked up within ~1–3s; the throughput ceiling is the class
 * budget itself, not this delay.
 */
const BUDGET_RETRY_DELAY_BASE_MS = 1_000;
const BUDGET_RETRY_DELAY_JITTER_MS = 2_000;
/** Min interval between "class budget saturated" deferral logs, per class. */
const BUDGET_DEFER_LOG_THROTTLE_MS = 15_000;

/** Longest a shutdown waits for one idle Worker.close() before abandoning its connections. */
const WORKER_CLOSE_TIMEOUT_MS = 2_000;

/**
 * BullMQ lock-loss zombie detection. BullMQ emits a Worker `error`
 * ("could not renew lock for job <jobId>") from its lock extender once a job's
 * lock has expired — meaning this worker no longer owns the job. The usual cause
 * is a > lockDuration event-loop stall (host CPU contention, or a synchronous
 * busy-loop in a non-isolated task). The processor promise keeps running as an
 * orphaned "zombie" whose INDEPENDENT heartbeat setInterval keeps beating
 * task_history, so every stale-heartbeat liveness guard (boot-recovery,
 * reconciler) skips it and the run wedges in 'active'/'cancelling' until its 2h
 * wall-clock cap — the exact failure that left a cancelled music-analysis run
 * "Stopping…" for ~2h in prod. We detect SUSTAINED loss (≥ threshold consecutive
 * emissions within the reset window) and finalize the run via the same path the
 * stall watchdog uses (autoFailRun → cancelling→cancelled / active→failed,
 * release slot, drop job, terminate an isolated worker thread). The threshold
 * distinguishes a true loss (BullMQ re-emits every ~lockRenewTime, i.e.
 * continuously) from a single transient Redis renew blip that recovers.
 */
const LOCK_LOST_FAIL_THRESHOLD = 3;
const LOCK_LOST_RESET_MS = 60_000;
/** Parses the runId out of BullMQ's "could not renew lock for job <jobId>". */
const LOCK_LOST_RE = /could not renew lock for job (\S+)/;

/**
 * BullMQ Worker lock options shared by the per-class and per-task worker
 * builders. We widen `lockDuration` from BullMQ's 30s default
 * (LUMASTRA_BULLMQ_LOCK_DURATION_MS, default 5 min) so a long-running, I/O-bound
 * job that stalls the event loop for >30s under host load doesn't lose its lock
 * and wedge (see the config comment + LOCK_LOST_* above). `stalledInterval` is
 * pinned to the same value so BullMQ's stalled-job sweep can't fire inside a
 * single renewal gap and fail a slow-but-alive job (`maxStalledCount` default is
 * 1, so one premature detection is terminal). The runner's heartbeat/stall
 * watchdog + boot-recovery remain the authoritative liveness layer. Returns an
 * empty object when set to 0, leaving BullMQ's defaults untouched.
 */
function workerLockOptions(): { lockDuration?: number; stalledInterval?: number } {
    const ms = LUMASTRA_BULLMQ_LOCK_DURATION_MS;
    if (!Number.isFinite(ms) || ms <= 0) return {};
    return { lockDuration: ms, stalledInterval: ms };
}

/**
 * Min interval between Valkey memory-critical (OOM / MISCONF save-failure)
 * error logs, across ALL workers. BullMQ re-emits a Worker `error` event for
 * every failed poll, lock-renew and claim while Valkey rejects writes, so
 * logging each one unthrottled is a flood: in the 2026-05 preprod incident a
 * single worker's stdout grew to 186 GB and filled the host disk, which then
 * broke Docker DNS and wedged the whole stack. One loud, searchable line per
 * window (with the suppressed count folded in) preserves the operational
 * signal without the flood. A single global gate — not per-class/per-task —
 * because during a real OOM every worker fires simultaneously.
 */
const MEMORY_CRITICAL_LOG_THROTTLE_MS = 30_000;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Discriminated result for `readProcessingVersion`. The three kinds carry
 * the policy decision out of the reader so the dispatcher can branch on it:
 *
 *   - `no-sql`   → DB not configured (test harness / degraded boot) OR the
 *                  query itself failed. Guard is skipped but we log loudly
 *                  so a real DB outage can't quietly run stale payloads
 *                  through new code indefinitely.
 *   - `null-row` → Row missing OR `processing_version` is NULL / unparseable
 *                  (legacy pre-Wave-9 rows). Guard is skipped silently.
 *   - `value`    → Numeric processing_version is available; the guard
 *                  applies the standard `< / == / >` policy.
 */
type ProcessingVersionRead =
    { kind: 'no-sql' } | { kind: 'null-row' } | { kind: 'value'; value: number };

export type RunnerJob = Job<{
    runId: string;
    input: unknown;
    playbackCpuExempt?: boolean;
    playbackDeferredAt?: number;
    parentRunId?: string;
    scope?: { libraryGroupId?: string; userId?: string };
    mode?: TaskContext['mode'];
    /**
     * Valkey key of the exclusiveWith mutex this run claimed at enqueue
     * (orchestrator.startRun, only present when the task declares
     * `exclusiveWith` AND this run won the SETNX). The runner DELs it on a
     * FINAL terminal so the mutex is released for legitimate sequential
     * re-runs instead of lingering for the full crash-safety TTL.
     */
    exclusivityKey?: string;
    /**
     * Present when this run may be resumed after a worker restart
     * (`resumeAfterRestart` + manual trigger, set by orchestrator.startRun).
     * Keys `ctx.checkpoint` and enables the shutdown-interrupt path.
     */
    resume?: ResumableJobData;
    taskAuthority?: AuthorityToken;
}>;

/** Unconfirmed retained terminal writes older than this are abandoned (logged + counted). */
const TERMINAL_OBLIGATION_MAX_AGE_MS = 15 * 60 * 1000;
/** Pause between consecutive job-missing observations of one retained terminal write. */
const TERMINAL_JOB_MISSING_RECHECK_MS = 2_000;

/** A runner terminal write that has not been acknowledged by PostgreSQL yet. */
interface TerminalWriteObligation {
    runId: string;
    to: 'completed' | 'failed' | 'cancelled';
    result: unknown;
    attempt?: TerminalQueueAttempt;
    /** Date.now() when the obligation was created; drives the abandonment age cap. */
    retainedAt: number;
    /** `acceptMissingJob` lets PostgreSQL decide once the BullMQ job has been reaped. */
    retry: (options?: { acceptMissingJob?: boolean }) => Promise<void>;
    /** The durable pending-write form of this terminal write, when it has a queue attempt. */
    deferredWrite: () => PendingWrite | undefined;
    pending?: Promise<void>;
    error?: unknown;
}

export interface TaskRunnerOpts {
    registry?: TaskRegistry;
    stateMachine?: StateMachine;
    /** Original owner for this runtime; never replaced by a successor token. */
    authority?: AuthorityToken;
    getSql?: () => postgres.Sql | null;
    /**
     * Override the SQL handle used for the liveness heartbeat write. Defaults to
     * the dedicated heartbeat pool (getHeartbeatDb) in production so the
     * heartbeat can't be starved by the task pool; falls back to `getSql` when a
     * test injects a mock there so heartbeat writes stay observable in tests.
     */
    getHeartbeatSql?: () => postgres.Sql | null;
    getClient?: () => ValkeyLike;
    instanceId?: string;
    bootId?: string;
    /**
     * Override Worker construction for tests. `taskId` is supplied only on the
     * per-task path (FEATURE_PER_TASK_QUEUES on); the legacy per-class path
     * leaves it undefined.
     */
    workerFactory?: (cls: ResourceClass, processor: Processor, taskId?: string) => WorkerLike;
    /**
     * Force the per-task-queue path on/off for tests. Defaults to the
     * `FEATURE_PER_TASK_QUEUES` config flag when omitted.
     */
    perTaskQueues?: boolean;
    /**
     * Override cancel-channel subscribe for tests. Receives the runId and a
     * callback that is called when a cancel signal arrives. Returns an
     * unsubscribe function.
     */
    subscribe?: (
        channel: string,
        cb: (msg: string) => void,
    ) => Promise<(() => Promise<void>) | null>;
    /** Override heartbeat interval (ms) for tests. */
    heartbeatIntervalMs?: number;
    /**
     * Age after which an unconfirmed retained terminal write is abandoned (logged
     * and counted) so execution can become quiescent. Defaults to 15 minutes.
     */
    terminalObligationMaxAgeMs?: number;
    /** Override concurrency lookup for tests. */
    concurrencyFor?: (cls: ResourceClass) => number;
    /**
     * Override queue factory for tests (downstream enqueue). `taskId` is
     * supplied on the per-task path so the factory can target the per-task
     * queue; ignored on the legacy per-class path.
     */
    queueFactory?: (cls: ResourceClass, taskId?: string) => Queue;
    /**
     * Force plugin worker-thread isolation on/off for tests. Defaults to the
     * `FEATURE_PLUGIN_WORKER_ISOLATION` config flag when omitted.
     */
    pluginIsolation?: boolean;
    /**
     * Override the worker spawner for tests — lets a test inject a fake worker
     * (no real thread) to exercise the host RPC/terminate logic. Defaults to a
     * real `node:worker_threads` Worker loading the sandbox bundle.
     */
    spawnIsolationWorker?: SpawnIsolationWorker;
    /** Override the resolved sandbox entry path for tests. */
    isolationEntryPath?: string;
}

/** Minimal contract required from a Worker — lets tests use a fake. */
class UpgradePreparationDeadlineError extends Error {}

async function withinUpgradeDeadline<T>(
    work: Promise<T>,
    deadline: number,
    phase: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new UpgradePreparationDeadlineError(
                                `Upgrade ${phase} deadline exceeded; outcome UNKNOWN`,
                            ),
                        ),
                    Math.max(0, deadline - performance.now()),
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export interface WorkerLike {
    close(): Promise<void>;
    pause?(doNotWaitActive?: boolean): Promise<void>;
    resume?(): Promise<void>;
    isPaused?(): boolean;
    isRunning?(): boolean;
    on(
        event: 'error' | 'failed' | 'completed' | 'active' | 'drained',
        listener: (...args: unknown[]) => void,
    ): WorkerLike;
}

interface ClassRuntime {
    cls: ResourceClass;
    worker: WorkerLike;
}

interface TaskWorkerRuntime {
    taskId: string;
    cls: ResourceClass;
    worker: WorkerLike;
}

// ── Resource-class → queue + concurrency ──────────────────────────────────────
//
// Queue names are the bare resource class (`io`, `cpu`, `embedding`,
// `maintenance`) per BullMQ 5.69+ which rejects `:` in queue names. The
// `bull:task` prefix is applied via QueueOptions.prefix / WorkerOptions.prefix
// so final Redis keys remain `bull:task:<cls>:…`. Helpers live in
// `queue-naming.ts`.

export function defaultConcurrencyFor(cls: ResourceClass): number {
    // Standalone per-class concurrency. This is the flag-off model verbatim, and
    // also the base the flag-on model sums from. Record<ResourceClass,…> stays
    // exhaustive (TS errors if a class is added without a value).
    const standalone: Record<ResourceClass, number> = {
        cpu: LUMASTRA_CONCURRENCY_CPU,
        io: LUMASTRA_CONCURRENCY_IO,
        embedding: LUMASTRA_CONCURRENCY_EMBEDDING,
        maintenance: LUMASTRA_CONCURRENCY_MAINTENANCE,
        ingest: LUMASTRA_CONCURRENCY_INGEST,
        bulk: LUMASTRA_CONCURRENCY_BULK,
        analysis: LUMASTRA_CONCURRENCY_ANALYSIS,
        discovery: LUMASTRA_CONCURRENCY_DISCOVERY,
    };
    if (!FEATURE_PER_TASK_QUEUES) return standalone[cls];

    // Per-task-queue model: the legacy-class shim (registry.ts) folds
    // ingest+bulk→io and analysis→cpu, so ALL of that work shares the physical
    // class's budget. Sum the folded classes so the physical budget preserves
    // the old separate-pool aggregate capacity (io 2 + ingest 4 + bulk 2 = 8) —
    // else collapsed pools would have far LESS concurrency (observed on preprod
    // as a 4.6k series-sync backlog draining ~170/day with bulk starved on
    // io=2). ingest/bulk/analysis are rewritten to a physical class by the shim,
    // so a task never runs under them flag-on; they return their standalone
    // value defensively (the `default` arm).
    switch (cls) {
        case 'cpu':
            return standalone.cpu + standalone.analysis;
        case 'io':
            return standalone.io + standalone.ingest + standalone.bulk;
        default:
            return standalone[cls];
    }
}

// ── TaskRunner ────────────────────────────────────────────────────────────────

export class TaskRunner {
    private readonly registry: TaskRegistry;
    private readonly stateMachine: StateMachine;
    private readonly authority?: AuthorityToken;
    private readonly getSql: () => postgres.Sql | null;
    private readonly getHeartbeatSql: () => postgres.Sql | null;
    private readonly getClient: () => ValkeyLike;
    private readonly subscribe:
        | ((channel: string, cb: (msg: string) => void) => Promise<(() => Promise<void>) | null>)
        | null;
    private readonly instanceId: string;
    private readonly bootId: string;
    private readonly heartbeatIntervalMs: number;
    private readonly terminalObligationMaxAgeMs: number;
    private readonly concurrencyFor: (cls: ResourceClass) => number;
    private readonly workerFactory: (
        cls: ResourceClass,
        processor: Processor,
        taskId?: string,
    ) => WorkerLike;
    private readonly perTaskQueues: boolean;

    private classes = new Map<ResourceClass, ClassRuntime>();
    // Per-task workers when FEATURE_PER_TASK_QUEUES is on, keyed by taskId.
    private taskWorkers = new Map<string, TaskWorkerRuntime>();
    // Connection-wedge watchdog. Created only on the worker-boot path
    // (TaskRunner.start); null on web replicas / direct test construction.
    private connWatchdog: ConnectionWedgeWatchdog | null = null;

    private heartbeats = new Map<string, ReturnType<typeof setInterval>>();
    // Dedicated wall-clock deadline samplers, keyed by runId. Decoupled from
    // the heartbeat interval so a declared `timeout.hard` shorter than
    // `heartbeatIntervalMs` is honored at its true value instead of being
    // effectively rounded up to the next heartbeat tick (F85).
    private deadlineTimers = new Map<string, ReturnType<typeof setInterval>>();
    // Wall-clock of the last heartbeat tick that successfully reached Valkey AND
    // Postgres. The watchdog in `heartbeatOnce` compares against this to warn
    // when a run hasn't successfully heartbeated in >2 minutes — a strong
    // signal that the worker is stalled on a blocking call (e.g. an NFS read
    // wedged inside an advisory-lock transaction) and is on track to be
    // mis-classified as an orphan by boot recovery.
    private lastHeartbeatSuccessAt = new Map<string, number>();
    private stallWarned = new Set<string>();
    // Set when the watchdog auto-fails a run for crossing
    // LUMASTRA_RUN_STALL_FAIL_MS without a successful heartbeat. Read in the
    // execute() result handler so a late-returning wedged plugin doesn't
    // overwrite the watchdog's terminal write.
    private stallFailed = new Set<string>();
    // Wall-clock deadline tracker. Maps runId → declared timeouts so the
    // heartbeat watchdog can also fire on total handler runtime, not just
    // heartbeat staleness. Without this, a handler whose runner heartbeat keeps
    // ticking but whose execute() is blocked indefinitely (e.g. a TMDB fetch
    // wedged on a TCP read inside an advisory lock) stays "active" forever —
    // the symptom that produced the 6.5h series-sync stuck run.
    private runDeadlines = new Map<
        string,
        {
            startedAtMs: number;
            hardMs: number;
            softMs: number;
            softWarned: boolean;
            taskId: string;
        }
    >();
    // Per-run concurrency-counter keys whose TTL the heartbeat must refresh so a
    // long-running task's shared counters don't expire mid-run and let another
    // worker over-admit past cap. Keyed by runId; populated by `startHeartbeat`
    // and cleared by `stopHeartbeat`. Holds the per-task counter key
    // (`task:active-count:<taskId>`) and — when the per-task-queue path is on —
    // the PHYSICAL class budget key (`task:resource-budget:<physicalClass>`,
    // i.e. the SAME key `acquireBudget` incremented; `task.resourceClass` is
    // already rewritten to the physical class by the registry's legacy-class
    // shim). The budget key is shared by all runs of every task in the class, so
    // as long as ANY run heartbeats it stays alive; only when all runs die does
    // it age out — the correct crash backstop.
    private heartbeatTtlKeys = new Map<
        string,
        { activeCountKey: string; budgetKey: string | null }
    >();
    private abortControllers = new Map<string, AbortController>();
    /**
     * Runs THIS instance's graceful stop() aborted (not a user cancel — those
     * were already aborted when stop() ran). A resumable one is left 'active'
     * for the reclaim to resume instead of being written terminal.
     */
    private readonly shutdownInterrupted = new Set<string>();
    /** When execute() of a resumable run started (for the crash-loop window). */
    private readonly executeStartedAt = new Map<string, number>();
    // Per-run BullMQ lock-loss episode tracker (see LOCK_LOST_FAIL_THRESHOLD).
    // count = consecutive lock-renew failures within LOCK_LOST_RESET_MS; the run
    // is auto-failed once it reaches the threshold. Cleared on run teardown in
    // stopHeartbeat so it can't grow unbounded across a worker's lifetime.
    private lockLostHits = new Map<string, { count: number; lastAt: number }>();
    // Per-run terminal-release handle, keyed by runId. Holds the SAME
    // `releaseConcurrent` thunk the normal completion path runs in its `finally`
    // (frees the per-task maxConcurrent counter + the class budget token) plus
    // the BullMQ `job` handle so the watchdog can drop the job (release the
    // Worker concurrency slot). Populated once the run starts (right after the
    // cancel subscription) and cleared in `processJob`'s `finally`. The watchdog
    // (`autoFailRun`) reads it so a PERMANENTLY-WEDGED in-process `execute()`
    // — whose `finally` never runs because the promise never settles — still
    // releases its counters + slot instead of holding them for the container's
    // lifetime (W1/C2). Both the thunk and `removeBullJobForRun` are idempotent,
    // so a run finalized by BOTH the watchdog and the (eventual) finally is safe.
    private runReleases = new Map<string, { release: () => Promise<void>; job: RunnerJob }>();
    // F2 — settle a wedged in-process run's execute() race so BullMQ frees the
    // Worker concurrency slot. Keyed by runId; the value rejects processJob's
    // `watchdogTrip` promise. autoFailRun fires it; processJob's `finally` owns
    // the map entry (same lifecycle as runReleases). A wedged in-process execute()
    // promise otherwise never settles → the slot is held until container restart.
    private watchdogTrips = new Map<string, (err: Error) => void>();
    // Soft-deadline controllers, keyed by runId. Distinct from abortControllers
    // (cancellation): the wall-clock watchdog aborts this one at `timeout.soft` so
    // a handler can wind down gracefully BEFORE the hard cap, without the run being
    // cancelled. Surfaced to handlers as `ctx.softSignal`. In-process runs only.
    private softAbortControllers = new Map<string, AbortController>();
    private cancelUnsubs = new Map<string, () => Promise<void>>();
    // BUG2: cancel of an `isolation: 'worker'` run only calls `abort.abort()`
    // (cooperative). A synchronously-wedged worker ignores that until the
    // watchdog's hard timeout (default 2h) eventually terminate()s it. Arming
    // a short one-shot grace timer on cancel gives isolated runs a bounded
    // cancel latency instead of relying on the full hard-timeout window.
    // Cleared wherever the run reaches a terminal/cleanup state.
    private cancelGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly queueFactory: (cls: ResourceClass, taskId?: string) => Queue;
    private stopped = false;
    /** Set by haltClaims(); no worker may start or claim again. */
    private claimsHalted = false;
    private stopPending: Promise<void> | undefined;
    private strictStopRequested = false;
    private readonly workerSetups = new Set<Promise<void>>();
    private readonly pendingIsolationStops = new Set<IsolationRun>();
    private readonly pendingCancelStops = new Set<() => Promise<void>>();

    // -- plugin worker-thread isolation (FEATURE_PLUGIN_WORKER_ISOLATION) -----
    // When enabled AND a task declares `isolation: 'worker'`, execute() runs in
    // a node:worker_threads Worker so a synchronous busy-loop can be hard-killed
    // via terminate() from the (unblocked) main thread's watchdog. Live runs are
    // tracked so `autoFailRun` can terminate the wedged thread.
    private readonly isolationFlag: boolean;
    private readonly isolationEntryPath: string;
    // The sandbox bundle (`build/sandbox-entry.js`) is produced by
    // `npm run build:sandbox` as part of `npm run build`. In dev (`npm run
    // dev`) it may be absent. With isolation now default-ON, we degrade
    // gracefully to the in-process path when the bundle is missing instead of
    // failing every isolated run — a real spawn can still be forced by passing
    // a custom `spawnIsolationWorker`.
    private readonly isolationBundleAvailable: boolean;
    private warnedIsolationBundleMissing = false;
    private readonly spawnIsolationWorker: SpawnIsolationWorker;
    private isolationRuns = new Map<string, IsolationRun>();

    // P2-1 / P2-5: one-shot warn dedup keyed by `task.id`. We log the first
    // time a multi-stage `coversStages` task lands on a worker (Phase 1a
    // single-stage limitation) and the first time `extractMediaItemId` rejects
    // a non-string `mediaItemId`, then suppress repeats so log volume stays
    // bounded over a worker's lifetime.
    private warnedMultiStage = new Set<string>();
    private warnedBadMediaItemId = new Set<string>();
    // Throttle "class budget saturated — deferring" logs to at most one per
    // class per BUDGET_DEFER_LOG_THROTTLE_MS so heavy contention doesn't spam.
    private lastBudgetDeferLogAt = new Map<ResourceClass, number>();
    // Throttle Valkey OOM / save-failure error logs to one per
    // MEMORY_CRITICAL_LOG_THROTTLE_MS across all workers — see the constant.
    // Tracks when we last logged and how many events we've suppressed since,
    // so the next emitted line can report the suppressed volume.
    private lastMemoryCriticalLogAt = 0;
    private suppressedMemoryCriticalLogs = 0;

    // Task L modules — instantiated once, shared across all workers.
    private readonly secretsStore: PluginSecrets;
    private readonly rateLimiter: RateLimiter;
    private readonly costLedger: CostLedger;

    // Enqueue-only pending-write drain for the runner's terminal Postgres
    // writes. Lazily constructed; NEVER start()ed here — the orchestrator's
    // leader-side instance consumes the shared `task:pending-writes` LIST.
    // enqueue() touches only the Valkey client, not sql.
    private pendingWriteDrain: PendingWriteDrain | null = null;

    // Circuit-breaker reporting instance. Lazily constructed; shares the
    // `task_circuit_state` table with the orchestrator's instance (which calls
    // check() before each run). The runner is the run-outcome authority, so it
    // is the correct place to report success/failure — without this the breaker
    // never accumulates failures and quarantine never activates.
    private circuitBreaker: CircuitBreaker | null = null;

    private constructor(opts: TaskRunnerOpts) {
        this.registry = opts.registry ?? defaultRegistry;
        this.authority = opts.authority ? Object.freeze({ ...opts.authority }) : undefined;
        this.stateMachine =
            opts.stateMachine ??
            (this.authority
                ? new StateMachine(opts.getClient ?? requireClient, this.authority)
                : defaultStateMachine);
        this.getSql = opts.getSql ?? (() => getTaskDb());
        // Heartbeat writes use a dedicated pool in production so a task that
        // saturates the task pool can't starve the liveness beat. When a test
        // injects `getSql` (a mock), reuse it so heartbeat writes stay
        // observable; only fall back to the real dedicated pool otherwise.
        this.getHeartbeatSql = opts.getHeartbeatSql ?? opts.getSql ?? (() => getHeartbeatDb());
        this.getClient = opts.getClient ?? requireClient;
        this.subscribe = opts.subscribe ?? null;
        this.instanceId = opts.instanceId ?? config.INSTANCE_ID;
        this.bootId = opts.bootId ?? ulid();
        this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS;
        this.terminalObligationMaxAgeMs =
            opts.terminalObligationMaxAgeMs ?? TERMINAL_OBLIGATION_MAX_AGE_MS;
        this.concurrencyFor = opts.concurrencyFor ?? defaultConcurrencyFor;
        this.perTaskQueues = opts.perTaskQueues ?? FEATURE_PER_TASK_QUEUES;
        this.workerFactory =
            opts.workerFactory ??
            ((cls, processor, taskId) =>
                taskId !== undefined
                    ? this.buildPerTaskWorker(taskId, cls, processor)
                    : this.buildBullMqWorker(cls, processor));
        this.queueFactory =
            opts.queueFactory ??
            ((cls, taskId) =>
                this.perTaskQueues && taskId !== undefined
                    ? this.buildPerTaskQueue(taskId)
                    : this.buildQueue(cls));

        // Task L: secrets, rate-limiter, cost-ledger.
        //
        // PluginSecrets needs a postgres.Sql handle. We resolve getSql() at
        // each call site so tests that inject a null SQL handle still construct
        // the runner without errors. The helper below wraps getSql() to give
        // PluginSecrets a function that is always available but defers the null
        // check to query time.
        //
        // postgres.Sql is a tagged-template function with attached methods.
        // A standard Proxy on an empty-object target doesn't forward tagged-
        // template calls correctly, so we use a function as the proxy target.
        const getSqlRef = this.getSql.bind(this);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const noopFn = (..._args: any[]): any => {
            return Promise.reject(new Error('TaskRunner: sql unavailable'));
        };
        const lazySql = new Proxy(noopFn as unknown as postgres.Sql, {
            apply(_target, _thisArg, args: unknown[]) {
                const sql = getSqlRef();
                if (!sql) {
                    return Promise.reject(new Error('TaskRunner: sql unavailable'));
                }
                return (sql as unknown as (...a: unknown[]) => unknown)(...args);
            },
            get(_target, prop: string | symbol) {
                const sql = getSqlRef();
                if (!sql) {
                    if (prop === 'then') return undefined; // not a Promise
                    return () => Promise.reject(new Error('TaskRunner: sql unavailable'));
                }
                const val = (sql as unknown as Record<string | symbol, unknown>)[prop];
                return typeof val === 'function'
                    ? (val as (...a: unknown[]) => unknown).bind(sql)
                    : val;
            },
        });

        this.secretsStore = new PluginSecrets(lazySql);
        this.rateLimiter = new RateLimiter();
        this.costLedger = new CostLedger();

        // Plugin worker-thread isolation wiring.
        this.isolationFlag = opts.pluginIsolation ?? FEATURE_PLUGIN_WORKER_ISOLATION;
        this.isolationEntryPath =
            opts.isolationEntryPath ??
            (LUMASTRA_ISOLATION_ENTRY_PATH ||
                path.join(process.cwd(), 'build', 'sandbox-entry.js'));
        this.spawnIsolationWorker =
            opts.spawnIsolationWorker ??
            ((entryPath, workerData, env) =>
                new ThreadWorker(entryPath, {
                    workerData,
                    env,
                    // Clamp to sane floors: a misconfigured 0/negative/too-low
                    // value would make `new Worker` throw synchronously, or make
                    // the sandbox bootstrap OOM on every attempt (→ endless retry).
                    resourceLimits: {
                        maxOldGenerationSizeMb: Math.max(64, LUMASTRA_ISOLATION_WORKER_OLD_HEAP_MB),
                        maxYoungGenerationSizeMb: Math.max(
                            16,
                            LUMASTRA_ISOLATION_WORKER_YOUNG_HEAP_MB,
                        ),
                        stackSizeMb: Math.max(4, LUMASTRA_ISOLATION_WORKER_STACK_MB),
                    },
                }) as unknown as IsolationWorkerLike);
        // A custom spawn (tests) bypasses the real bundle, so treat it as always
        // available; otherwise the bundle must exist on disk for isolation to
        // route to a worker. Checked once at construction — the bundle is a
        // build artefact, it doesn't appear at runtime.
        this.isolationBundleAvailable =
            opts.spawnIsolationWorker !== undefined || existsSync(this.isolationEntryPath);
    }

    /**
     * Boot worker instances for the supplied resource classes. The runner is
     * additive — callers that disable worker mode should skip invoking this.
     */
    /** Reusable execution host: intentionally creates no consumers or leader loops. */
    static createExecutor(opts: TaskRunnerOpts = {}): TaskRunner {
        const runner = new TaskRunner(opts);
        runner.executorMode = true;
        return runner;
    }

    private executorMode = false;
    isExecutorOnly(): boolean {
        return this.executorMode;
    }

    private executingJobs = 0;
    private readonly executingRunIds = new Set<string>();
    private readonly executingQueueJobs = new Map<string, RunnerJob>();
    private readonly terminalWriteObligations = new Set<TerminalWriteObligation>();
    /** Raw execute promises that may outlive processJob, keyed to their runId. */
    private readonly executionContinuations = new Map<Promise<unknown>, string>();
    private readonly requestedExecutionCancels = new Set<string>();

    /** Abort is a request; quiescence must be checked separately. */
    cancelExecution(runId: string): void {
        if (!this.executingRunIds.has(runId)) return;
        this.requestedExecutionCancels.add(runId);
        this.abortControllers.get(runId)?.abort();
    }

    /**
     * BullMQ consumer loops. `running` excludes paused workers: BullMQ keeps
     * isRunning() true on a paused worker, so running means "running and not paused".
     * `executing` is the number of jobs in flight in this process.
     */
    consumerState(): { total: number; running: number; paused: number; executing: number } {
        const workers = [...this.classes.values(), ...this.taskWorkers.values()].map(
            (runtime) => runtime.worker,
        );
        const paused = (worker: WorkerLike): boolean => worker.isPaused?.() ?? false;
        return {
            total: workers.length,
            running: workers.filter((worker) => (worker.isRunning?.() ?? true) && !paused(worker))
                .length,
            paused: workers.filter(paused).length,
            executing: this.executingJobs,
        };
    }

    /**
     * Consumer progress for the process liveness probe: a job started, finished or
     * failed, or the queue drained. These are the only per-loop signals BullMQ emits;
     * 'drained' fires on the transition to empty, not periodically, so an idle loop
     * is covered by the sampler in task-runtime/index.ts instead.
     */
    private watchConsumerProgress(worker: WorkerLike): void {
        for (const event of ['active', 'completed', 'failed', 'drained'] as const) {
            worker.on(event, () => markLoopTick('consumer'));
        }
    }

    /**
     * A job in its first phase (resolving the task, waiting on gates, claiming) has
     * no abort controller and no heartbeat yet, but is executing: abort it as a
     * shutdown interruption, the way the owned runs are, so it unwinds instead of
     * running on while the Worker closes. The abort reaches it as soon as it creates
     * its controller. Workers keep fetching until their close() starts, so this runs
     * again right before the Workers close and each time their close is held up.
     * A run already being cancelled (its controller aborted) stays a cancel.
     */
    private interruptFirstPhaseJobs(): void {
        for (const runId of [...this.executingRunIds]) {
            if (this.heartbeats.has(runId)) continue;
            if (this.abortControllers.get(runId)?.signal.aborted) continue;
            if (!this.requestedExecutionCancels.has(runId)) this.shutdownInterrupted.add(runId);
            this.cancelExecution(runId);
        }
    }

    /** A job is running in this process (from its first phase on). */
    hasExecutingJobs(): boolean {
        return this.executingJobs > 0 || this.executingRunIds.size > 0;
    }

    isExecutionQuiescent(): boolean {
        return (
            this.executingJobs === 0 &&
            this.executionContinuations.size === 0 &&
            this.terminalWriteObligations.size === 0 &&
            !this.upgradeSetupPending &&
            !this.upgradeReconcilePending &&
            this.upgradePausePending.size === 0 &&
            this.upgradeResumePending.size === 0
        );
    }

    /** Per-run quiescence: this run is not executing, has no live continuation
     * and no retained terminal write. Other runs may still be active. */
    isRunQuiescent(runId: string): boolean {
        if (this.executingRunIds.has(runId)) return false;
        for (const owner of this.executionContinuations.values()) if (owner === runId) return false;
        for (const obligation of this.terminalWriteObligations)
            if (obligation.runId === runId) return false;
        return true;
    }

    private upgradeWorkers: WorkerLike[] | undefined;
    private upgradePreparing = false;
    private upgradePrepared = false;
    private upgradeRegistryReconcile = false;
    private upgradeSetupPending: Promise<void> | undefined;
    private upgradeReconcilePending: Promise<void> | undefined;
    private readonly upgradePausePending = new Map<WorkerLike, Promise<void>>();
    private readonly upgradeResumePending = new Map<WorkerLike, Promise<void>>();

    /** Local claims only: never alters an administrator's global queue pause. */
    async prepareUpgrade(options: {
        deadlineMs: number;
        settled?: () => boolean;
    }): Promise<{ prepared: boolean }> {
        if (this.stopped || this.executorMode || this.upgradePreparing)
            throw new Error('TaskRunner cannot prepare an upgrade in its current state');
        if (this.upgradePrepared) return { prepared: true };
        if (this.upgradeWorkers) throw new Error('Previous upgrade restoration remains UNKNOWN');
        if (!Number.isFinite(options.deadlineMs) || options.deadlineMs < 1)
            throw new Error('Invalid upgrade preparation deadline');
        // The work budget includes setup and pause acknowledgements, not only
        // the final polling loop. Restoration gets one bounded five-second window.
        const deadline = performance.now() + options.deadlineMs;
        let restorationDeadline = deadline + 5000;
        // Freeze ALL registration paths synchronously before the first await.
        this.upgradePreparing = true;
        this.upgradeWorkers = [];
        void this.retryPendingTerminalWrites().catch((error: unknown) =>
            log.warn('Upgrade terminal persistence remains UNKNOWN', { error: errMessage(error) }),
        );
        try {
            this.upgradeSetupPending = Promise.all([
                ...this.workerSetups,
                this.upgradeReconcilePending,
            ])
                .then(() => {})
                .finally(() => {
                    this.upgradeSetupPending = undefined;
                });
            await withinUpgradeDeadline(this.upgradeSetupPending, deadline, 'worker setup');
            const workers = [...this.classes.values(), ...this.taskWorkers.values()].map(
                (runtime) => runtime.worker,
            );
            for (const worker of workers) {
                if (!worker.pause || !worker.resume || !worker.isPaused || !worker.isRunning)
                    throw new Error('Worker does not support reversible upgrade preparation');
                if (worker.isPaused()) continue;
                // Record before issuing: a lost pause acknowledgement still needs restoration.
                this.upgradeWorkers.push(worker);
                const pause = Promise.resolve()
                    .then(() => worker.pause!(true))
                    .finally(() => {
                        this.upgradePausePending.delete(worker);
                    });
                this.upgradePausePending.set(worker, pause);
                await withinUpgradeDeadline(pause, deadline, 'worker pause');
            }
            while (true) {
                if (this.stopped) throw new Error('TaskRunner stopped during upgrade preparation');
                // Pausing does not certify drain: observe the actual BullMQ loop
                // and raw execute promises, including late watchdog continuations.
                if (
                    workers.every((worker) => !worker.isRunning!()) &&
                    this.isExecutionQuiescent() &&
                    (options.settled?.() ?? true)
                ) {
                    this.upgradePrepared = true;
                    return { prepared: true };
                }
                if (performance.now() >= deadline) {
                    log.warn('Upgrade preparation postponed', {
                        runningWorkers: workers.filter((worker) => worker.isRunning!()).length,
                        executingJobs: this.executingJobs,
                        continuations: this.executionContinuations.size,
                        terminalWrites: this.terminalWriteObligations.size,
                        externalSettled: options.settled?.() ?? true,
                    });
                    throw new UpgradePreparationDeadlineError(
                        'Upgrade active-work deadline exceeded',
                    );
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
            }
        } catch (error) {
            restorationDeadline = Math.min(deadline + 5000, performance.now() + 5000);
            try {
                await this.restoreUpgradeWorkers(restorationDeadline);
            } catch (restoreError) {
                throw new AggregateError([error, restoreError], 'Upgrade restoration UNKNOWN', {
                    cause: restoreError,
                });
            }
            if (error instanceof UpgradePreparationDeadlineError) return { prepared: false };
            throw error;
        } finally {
            this.upgradePreparing = false;
            if (!this.upgradeWorkers && !this.stopped)
                await withinUpgradeDeadline(
                    this.reconcileDeferredUpgradeWorkers(),
                    restorationDeadline,
                    'registry restoration',
                );
        }
    }

    async resumeAfterUpgrade(): Promise<void> {
        if (this.upgradePreparing) throw new Error('Upgrade preparation is still in progress');
        const deadline = performance.now() + 5000;
        await this.restoreUpgradeWorkers(deadline);
        await withinUpgradeDeadline(
            this.reconcileDeferredUpgradeWorkers(),
            deadline,
            'registry restoration',
        );
    }

    private reconcileDeferredUpgradeWorkers(): Promise<void> {
        if (this.upgradeReconcilePending) return this.upgradeReconcilePending;
        if (!this.upgradeRegistryReconcile) return Promise.resolve();
        this.upgradeRegistryReconcile = false;
        this.upgradeReconcilePending = this.ensureWorkersForRegisteredTasks()
            .catch((error: unknown) => {
                this.upgradeRegistryReconcile = true;
                throw error;
            })
            .finally(() => {
                this.upgradeReconcilePending = undefined;
            });
        return this.upgradeReconcilePending;
    }

    async retryPendingTerminalWrites(): Promise<void> {
        const results = await Promise.allSettled(
            [...this.terminalWriteObligations].map((obligation) => {
                if (obligation.pending) return obligation.pending;
                // Reserve the complete retry before any SQL/queue await so two
                // explicit retry paths cannot run the same retained write in parallel.
                const retry = async (): Promise<void> => {
                    try {
                        await this.retryTerminalObligation(obligation);
                    } catch (error) {
                        if (Date.now() - obligation.retainedAt < this.terminalObligationMaxAgeMs)
                            throw error;
                        await this.abandonTerminalObligation(obligation, error);
                    }
                    this.terminalWriteObligations.delete(obligation);
                };
                obligation.pending = retry()
                    .catch((error: unknown) => {
                        obligation.error = error;
                        throw error;
                    })
                    .finally(() => {
                        obligation.pending = undefined;
                    });
                return obligation.pending;
            }),
        );
        const failures = results
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason as unknown);
        if (failures.length)
            throw new AggregateError(failures, 'Terminal persistence remains UNKNOWN');
    }

    /** Resolves once PostgreSQL holds (or now decides) the outcome; throws while UNKNOWN. */
    private async retryTerminalObligation(obligation: TerminalWriteObligation): Promise<void> {
        const sql = this.getSql();
        if (!sql) throw new Error('UNKNOWN: terminal persistence SQL unavailable');
        const confirmed = (): Promise<boolean> =>
            terminalResultConfirmed(sql, obligation.runId, obligation.to, obligation.result);
        if (await confirmed()) return;
        if (!obligation.attempt) throw new Error('UNKNOWN: retained terminal attempt unavailable');
        for (let observed = 1; ; observed++) {
            let current: boolean;
            try {
                current = await terminalQueueAttemptCurrent(
                    obligation.attempt,
                    obligation.runId,
                    this.authority,
                    confirmed,
                );
            } catch (error) {
                if (!(error instanceof TerminalAttemptJobMissingError)) throw error;
                if (observed < TERMINAL_JOB_MISSING_ACCEPT_AFTER) {
                    await new Promise<void>((resolve) =>
                        setTimeout(resolve, TERMINAL_JOB_MISSING_RECHECK_MS),
                    );
                    continue;
                }
                // A successor executing here writes its own terminal outcome.
                if (this.executingRunIds.has(obligation.runId)) return;
                // BullMQ reaped the job. Apply the write guarded on this attempt's
                // ownership of the row; otherwise PostgreSQL's state stands.
                await obligation.retry({ acceptMissingJob: true });
                return;
            }
            if (current) await obligation.retry();
            return;
        }
    }

    /**
     * Give up on a retained write after the age cap, deliberately: hand it to
     * the durable pending-write list, or else mark the row with
     * TERMINAL_WRITE_ABANDONED so recovery resolves the run instead of guessing.
     */
    private async abandonTerminalObligation(
        obligation: TerminalWriteObligation,
        error: unknown,
    ): Promise<void> {
        taskTerminalWriteAbandonedTotal.inc({ state: obligation.to });
        log.error(
            'Abandoned retained terminal persistence after age cap; outcome left to PostgreSQL',
            error instanceof Error ? error : new Error(String(error)),
            {
                runId: obligation.runId,
                to: obligation.to,
                jobId: obligation.attempt?.id,
                queueName: obligation.attempt?.queueName,
                attemptsStarted: obligation.attempt?.attemptsStarted,
                attemptsMade: obligation.attempt?.attemptsMade,
                ageMs: Date.now() - obligation.retainedAt,
            },
        );
        const sql = this.getSql();
        if (!sql) return;
        const deferred = obligation.deferredWrite();
        if (deferred) {
            try {
                await this.getPendingWriteDrain(sql).enqueue(deferred, { strict: true });
                log.warn('Abandoned terminal write handed to the pending-write drain', {
                    runId: obligation.runId,
                    to: obligation.to,
                });
                return;
            } catch (enqueueError) {
                log.warn('Abandoned terminal write could not reach the pending-write drain', {
                    runId: obligation.runId,
                    error: errMessage(enqueueError),
                });
            }
        }
        const marker = {
            code: 'TERMINAL_WRITE_ABANDONED',
            message: 'Terminal write abandoned after the retention age cap',
            intendedState: obligation.to,
            ...(obligation.attempt ? { jobId: obligation.attempt.id } : {}),
        };
        try {
            await withExistingTaskWrite(
                sql,
                this.authority,
                async (tx) => tx`
                UPDATE task_history SET error = ${tx.json(marker)}
                WHERE id = ${obligation.runId}
                  AND state NOT IN ('completed', 'failed', 'cancelled')
                  AND owner_instance_id = ${this.instanceId}
                  AND (error IS NULL OR error->>'code' IS DISTINCT FROM 'HARD_KILL_QUEUE_PENDING')
            `,
            );
        } catch (markerError) {
            log.error(
                'Could not mark the abandoned terminal write on task_history',
                markerError instanceof Error ? markerError : new Error(String(markerError)),
                { runId: obligation.runId, to: obligation.to },
            );
        }
    }

    private async restoreUpgradeWorkers(deadline: number): Promise<void> {
        if (this.stopped) return; // Terminal shutdown must never restart a closed consumer.
        const failures: unknown[] = [];
        // A late pause must settle before resume can run. Otherwise a timed-out
        // pause could re-pause a worker after we claimed restoration succeeded.
        await withinUpgradeDeadline(
            this.upgradeSetupPending ?? Promise.resolve(),
            deadline,
            'setup restoration',
        );
        for (const worker of [...(this.upgradeWorkers ?? [])]) {
            try {
                const pause = this.upgradePausePending.get(worker);
                if (pause)
                    await withinUpgradeDeadline(
                        pause.catch(() => {}),
                        deadline,
                        'pause restoration',
                    );
                let resume = this.upgradeResumePending.get(worker);
                if (!resume) {
                    resume = Promise.resolve()
                        .then(() => worker.resume!())
                        .finally(() => {
                            this.upgradeResumePending.delete(worker);
                        });
                    this.upgradeResumePending.set(worker, resume);
                }
                await withinUpgradeDeadline(resume, deadline, 'worker restoration');
                if (worker.isPaused!()) throw new Error('Worker remained paused after restoration');
                this.upgradeWorkers = this.upgradeWorkers?.filter((item) => item !== worker);
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length)
            throw new AggregateError(failures, 'Upgrade claim restoration UNKNOWN');
        this.upgradeWorkers = undefined;
        this.upgradePrepared = false;
    }

    static async start(classes: ResourceClass[], opts: TaskRunnerOpts = {}): Promise<TaskRunner> {
        if (resolveTaskProcessRole(config.WORKER_MODE, config.DEDICATED_WORKER) !== 'worker')
            throw new Error('TaskRunner requires the dedicated worker process');
        const runner = new TaskRunner(opts);
        // Connection-wedge watchdog: only on the worker-boot path. Recovers a
        // worker whose BullMQ/Valkey connections wedge after a partition/IP
        // change by exiting so the container restart policy gives it fresh ones.
        runner.connWatchdog = new ConnectionWedgeWatchdog({
            thresholdMs: LUMASTRA_WORKER_CONN_WEDGE_MS,
        });
        runner.connWatchdog.start();
        if (runner.perTaskQueues) {
            // Per-task model (Wave 8.5): one Worker per registered task. The
            // class budget semaphore (acquired in processJob) enforces the
            // class-wide concurrency cap across all tasks sharing a class.
            // `classes` is ignored — task→class is read from the registry.
            for (const task of runner.registry.getAllTasks()) {
                await runner.startTaskWorker(task as TaskDefinition<unknown, unknown>);
            }
            log.info('TaskRunner started in per-task-queue mode', {
                taskWorkers: runner.taskWorkers.size,
                instance: runner.instanceId,
            });
        } else {
            for (const cls of classes) {
                await runner.startClassWorker(cls);
            }
        }
        return runner;
    }

    /**
     * Idempotently start a per-task BullMQ Worker for any registered task
     * that doesn't already have one. No-op when `perTaskQueues` is off (the
     * legacy per-class Workers already cover every task by construction).
     *
     * Exists for hot-loaded plugins: `TaskRunner.start()` enumerates
     * `registry.getAllTasks()` exactly once at boot. A task registered
     * afterwards via `reloadExternalPlugins()` would otherwise have jobs
     * enqueued into `bull:task:t:<id>` with no consumer forever — the job
     * sits healthy in `waiting`, and boot-recovery can't reap it because
     * nothing is wrong from BullMQ's point of view. Call this after
     * registering a new task outside the boot path.
     *
     * Safe to call before this instance has any workers (e.g. defensively) —
     * it simply starts whatever is missing.
     */
    async ensureWorkersForRegisteredTasks(): Promise<void> {
        this.assertWorkerStartupAllowed();
        if (!this.perTaskQueues) return;
        for (const task of this.registry.getAllTasks()) {
            const taskId = (task as TaskDefinition<unknown, unknown>).id;
            this.assertWorkerStartupAllowed();
            if (this.taskWorkers.has(taskId)) continue;
            await this.startTaskWorker(task as TaskDefinition<unknown, unknown>);
            this.assertWorkerStartupAllowed();
        }
    }

    /**
     * Graceful shutdown — closes Workers (lets in-flight jobs finish), then
     * tears down heartbeats and cancel subscriptions for anything still alive.
     */
    stop(options: { strict?: boolean } = {}): Promise<void> {
        // Strict teardown remains strict across retries, including an overlapping
        // best-effort caller. Never lose failed resource ownership on that path.
        this.strictStopRequested ||= options.strict ?? false;
        this.stopPending ??= this.stopResources().finally(() => {
            this.stopPending = undefined;
        });
        return this.stopPending;
    }

    private async stopResources(): Promise<void> {
        const failures: unknown[] = [];
        this.stopped = true;
        this.connWatchdog?.stop();
        // Setup reserves ownership before calling a factory. A hotload already
        // in flight must publish its worker before teardown snapshots the maps.
        await Promise.all([...this.workerSetups]);

        this.interruptFirstPhaseJobs();

        // Fast-recovery release on graceful shutdown (e.g. a redeploy SIGTERM):
        // proactively relinquish every run THIS instance owns so the next worker
        // reclaims them within one ~30s reconciler sweep instead of waiting out
        // the full LUMASTRA_RUN_STATE_TTL_ACTIVE_MS (~15min) heartbeat-TTL
        // backstop. For a global-singleton task like media-probe that backstop
        // otherwise stalls the WHOLE stage for up to 15min after every deploy,
        // because the dead orphan keeps holding the single run slot.
        //
        // Order matters: clear the heartbeat timers FIRST so no in-flight tick's
        // `HSET task:run:active:<id>` re-creates a hash we are about to delete;
        // abort the handlers so they stop touching the run; then DEL the
        // `task:run:active:<id>` hash — the exact key RunLivenessAuthority's
        // HEXISTS liveness check consults (and that its reclaim path itself DELs).
        // Best-effort: a Valkey error, or a SIGKILL before this completes, simply
        // falls back to the TTL backstop — so this can only ever speed recovery up.
        const ownedRunIds = [...this.heartbeats.keys()];
        // A dedicated strict shutdown must not publish fast-recovery eligibility
        // before the old processor and its asynchronous continuation are gone.
        // Existing terminal paths perform their normal settlement; unresolved
        // liveness remains for fenced recovery rather than deleting a successor.
        if (ownedRunIds.length > 0) {
            for (const timer of this.heartbeats.values()) clearInterval(timer);
            this.heartbeats.clear();
            for (const runId of ownedRunIds) {
                try {
                    const ac = this.abortControllers.get(runId);
                    // Record BEFORE aborting so the handler's unwind sees it.
                    // An already-aborted controller is a user cancel in flight:
                    // that run must end cancelled, never be resumed.
                    if (ac && !ac.signal.aborted) this.shutdownInterrupted.add(runId);
                    ac?.abort();
                } catch {
                    // best-effort
                }
            }
            try {
                const client = this.getClient();
                if (client && !this.strictStopRequested) {
                    await Promise.allSettled(
                        ownedRunIds.map((runId) =>
                            client.customCommand(['DEL', `task:run:active:${runId}`]),
                        ),
                    );
                }
                log.info(
                    this.strictStopRequested
                        ? 'Shutdown: retained run-state until qualified recovery'
                        : 'Shutdown: released owned run-state for fast recovery',
                    {
                        count: ownedRunIds.length,
                        instance: this.instanceId,
                    },
                );
            } catch (err) {
                log.warn('Shutdown: fast-recovery release failed (falling back to TTL)', {
                    err: errMessage(err),
                });
            }
        }

        // Close every Worker at once. BullMQ's own close() never returns while the
        // task Valkey is down (a compose restart stops Valkey together with the
        // worker) and used to run the process into its shutdown deadline, one worker
        // after the other. A Worker with nothing running is therefore abandoned after
        // a short bound; one with a job in flight is awaited for as long as the job
        // needs. "In flight" is read when the bound expires, from everything that
        // marks a job as executing: a job may have started after the stop began.
        let workersForcedClosed = 0;
        const jobsInFlight = (): boolean =>
            this.executingJobs > 0 ||
            this.executingRunIds.size > 0 ||
            this.abortControllers.size > 0 ||
            this.heartbeats.size > 0;
        // A job fetched since the first sweep (the owned-run release above awaits Valkey
        // while Workers still pull) is interrupted before the Workers close.
        this.interruptFirstPhaseJobs();
        const closeWorker = (worker: WorkerLike): Promise<unknown> =>
            closeBullmqBounded(worker, WORKER_CLOSE_TIMEOUT_MS, () => {
                this.interruptFirstPhaseJobs();
                return !jobsInFlight();
            }).then((settled) => {
                if (!settled) workersForcedClosed++;
            });
        await Promise.all([
            ...[...this.classes].map(async ([key, rt]) => {
                try {
                    await closeWorker(rt.worker);
                    this.classes.delete(key);
                } catch (err) {
                    failures.push(err);
                    log.warn('Worker close failed', {
                        cls: rt.cls,
                        err: errMessage(err),
                    });
                }
            }),
            ...[...this.taskWorkers].map(async ([key, rt]) => {
                try {
                    await closeWorker(rt.worker);
                    this.taskWorkers.delete(key);
                } catch (err) {
                    failures.push(err);
                    log.warn('Task worker close failed', {
                        taskId: rt.taskId,
                        err: errMessage(err),
                    });
                }
            }),
        ]);
        if (workersForcedClosed > 0)
            log.warn(
                'Task worker close timed out (task Valkey unreachable); connections abandoned',
                { workers: workersForcedClosed },
            );
        // Terminate any isolated plugin worker threads still alive so a
        // shutdown doesn't leak threads + their DB pools. Best-effort, grace 0
        // (we're shutting down — don't wait).
        //
        // Snapshot-then-clear SYNCHRONOUSLY (no `await` between the read and the
        // clear) so a concurrent `autoFailRun` watchdog — or an `executeIsolated`
        // `.finally(delete)` — can't mutate the map while we iterate it. The
        // snapshot takes ownership of exactly the runs present at this instant;
        // any run that settles or is auto-failed after this point operates on the
        // already-emptied map and is a harmless no-op. We only `await` the
        // terminate() calls after the map is detached. Failed terminations are
        // retained separately so a late execution-finally cannot erase a failed
        // termination before the next strict cleanup retries it.
        for (const run of this.isolationRuns.values()) this.pendingIsolationStops.add(run);
        this.isolationRuns.clear();
        for (const run of this.pendingIsolationStops) {
            try {
                await run.terminate(0);
                this.pendingIsolationStops.delete(run);
            } catch (error) {
                failures.push(error);
            }
        }
        // Any in-flight handlers should have hit their finally blocks and
        // cleaned themselves up. Sweep stragglers defensively.
        for (const timer of this.heartbeats.values()) {
            clearInterval(timer);
        }
        this.heartbeats.clear();
        for (const timer of this.deadlineTimers.values()) {
            clearInterval(timer);
        }
        this.deadlineTimers.clear();
        for (const ac of this.abortControllers.values()) {
            try {
                ac.abort();
            } catch {
                // ignore — best-effort
            }
        }
        this.abortControllers.clear();
        this.softAbortControllers.clear();
        for (const unsub of this.cancelUnsubs.values()) this.pendingCancelStops.add(unsub);
        this.cancelUnsubs.clear();
        for (const unsub of this.pendingCancelStops) {
            try {
                await unsub();
                this.pendingCancelStops.delete(unsub);
            } catch (error) {
                failures.push(error);
            }
        }
        if (this.strictStopRequested) {
            try {
                await this.retryPendingTerminalWrites();
            } catch (error) {
                failures.push(error);
            }
        }
        if (this.strictStopRequested && !this.isExecutionQuiescent()) {
            failures.push(
                new Error(
                    'Task execution continuation remains active; shutdown outcome is UNKNOWN',
                ),
            );
        }
        if (this.strictStopRequested && failures.length) {
            throw new AggregateError(failures, 'TaskRunner shutdown is incomplete');
        }
    }

    // -- worker construction -------------------------------------------------

    /** Resource cleanup evidence only; this does not qualify runtime handover. */
    isShutdownCleanupComplete(): boolean {
        return (
            this.stopped &&
            this.workerSetups.size === 0 &&
            this.classes.size === 0 &&
            this.taskWorkers.size === 0 &&
            this.isolationRuns.size === 0 &&
            this.pendingIsolationStops.size === 0 &&
            this.cancelUnsubs.size === 0 &&
            this.pendingCancelStops.size === 0 &&
            this.isExecutionQuiescent()
        );
    }

    isStopped(): boolean {
        return this.stopped;
    }

    /**
     * Fencing loss (the worker singleton lease is gone): stop claiming jobs NOW,
     * before any awaited teardown, because a successor may already be consuming.
     * Aborts handlers synchronously, issues `pause(true)` (do not wait for
     * active jobs) on every worker and refuses new workers. Irreversible; the caller follows with a strict stop,
     * which still drains and closes the workers.
     */
    haltClaims(): void {
        this.claimsHalted = true;
        for (const [runId, controller] of this.abortControllers) {
            if (!controller.signal.aborted) this.shutdownInterrupted.add(runId);
            controller.abort();
        }
        for (const { worker } of [...this.classes.values(), ...this.taskWorkers.values()]) {
            if (!worker.pause) {
                void worker.close().catch((err: unknown) =>
                    log.warn('Worker close after fencing loss failed', {
                        err: errMessage(err),
                    }),
                );
                continue;
            }
            void worker
                .pause(true)
                .catch((err: unknown) =>
                    log.warn('Worker pause after fencing loss failed', { err: errMessage(err) }),
                );
        }
    }

    private assertWorkerStartupAllowed(): void {
        if (this.stopped) throw new Error('TaskRunner has shut down; worker startup refused');
        if (this.claimsHalted)
            throw new Error('TaskRunner claims are halted (fencing loss); worker startup refused');
        if (this.upgradeWorkers || this.upgradePreparing) {
            this.upgradeRegistryReconcile = true;
            throw new Error('TaskRunner upgrade preparation has paused worker creation');
        }
    }

    private async registerWorker(setup: () => void): Promise<void> {
        this.assertWorkerStartupAllowed();
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        this.workerSetups.add(pending);
        try {
            setup();
            this.assertWorkerStartupAllowed();
        } finally {
            finish();
            this.workerSetups.delete(pending);
        }
    }

    private async startClassWorker(cls: ResourceClass): Promise<void> {
        await this.registerWorker(() => {
            const processor: Processor = async (job: Job, token?: string) => {
                return this.processJob(job as RunnerJob, token);
            };
            const worker = this.workerFactory(cls, processor);
            this.classes.set(cls, { cls, worker });
            this.watchConsumerProgress(worker);
            watchWorkerRecovery(worker);
            worker.on('error', (err: unknown) => {
                if (this.logMemoryCriticalIfMatch(err, { cls })) return;
                if (this.maybeReactToLockLoss(err)) return;
                // Legacy per-class mode: all tasks in `cls` share this Worker's one
                // connection, so `cls` IS the right wedge-tracking scope (matches
                // `job.queueName` for jobs processed on it — see `recordHealthy`).
                this.connWatchdog?.recordError(cls, err);
                // Valkey went away: one warning per outage, not one per Worker.
                if (logTaskConnectionLoss(`class-worker:${cls}`, err)) return;
                log.warn('Worker error', { cls, err: errMessage(err) });
            });
            log.info('Worker started for class', {
                cls,
                concurrency: this.concurrencyFor(cls),
                instance: this.instanceId,
            });
        });
    }

    private buildBullMqWorker(cls: ResourceClass, processor: Processor): WorkerLike {
        const connection = getQueueConnection();
        if (!connection) {
            throw new Error('TaskRunner: cannot start — CACHE_URL not configured');
        }
        const queueName = taskQueueName(cls);
        const worker = new Worker(queueName, processor, {
            connection,
            prefix: QUEUE_PREFIX,
            concurrency: this.concurrencyFor(cls),
            ...workerLockOptions(),
        });
        return worker as unknown as WorkerLike;
    }

    private buildQueue(cls: ResourceClass): Queue {
        const connection = getQueueConnection();
        if (!connection) {
            throw new Error('TaskRunner: cannot build queue — CACHE_URL not configured');
        }
        const queue = new Queue(taskQueueName(cls), {
            connection,
            prefix: QUEUE_PREFIX,
            defaultJobOptions: BULL_DEFAULT_RETENTION,
        });
        logQueueConnectionErrors(queue, `class-queue:${cls}`);
        return queue;
    }

    // -- per-task worker construction (FEATURE_PER_TASK_QUEUES) ---------------
    //
    // Each task gets its own Worker on `bull:task:t:<taskId>`. The Worker's
    // BullMQ concurrency is the per-task ceiling (`quotas.maxConcurrent`, or the
    // class default when unset). The class-wide cap is enforced separately in
    // processJob via the budget semaphore so N tasks sharing a class can't
    // collectively exceed `LUMASTRA_CONCURRENCY_<class>`.

    private perTaskConcurrency(task: TaskDefinition<unknown, unknown>): number {
        const maxConcurrent = task.quotas?.maxConcurrent;
        if (typeof maxConcurrent === 'number' && maxConcurrent > 0) return maxConcurrent;
        // No explicit per-task cap: fall back to (class budget - 1), not the
        // full budget, so a single task can't pop enough jobs to drain every
        // budget token and starve its class siblings (D6 residual — the budget
        // semaphore caps the class TOTAL but doesn't distribute it fairly).
        // Floored at 1.
        return Math.max(1, this.concurrencyFor(task.resourceClass) - 1);
    }

    private buildPerTaskWorker(
        taskId: string,
        cls: ResourceClass,
        processor: Processor,
    ): WorkerLike {
        const connection = getQueueConnection();
        if (!connection) {
            throw new Error('TaskRunner: cannot start — CACHE_URL not configured');
        }
        const task = this.registry.getTask(taskId);
        const concurrency = task
            ? this.perTaskConcurrency(task as TaskDefinition<unknown, unknown>)
            : this.concurrencyFor(cls);
        const worker = new Worker(perTaskQueueName(taskId), processor, {
            connection,
            prefix: PER_TASK_QUEUE_PREFIX,
            concurrency,
            ...workerLockOptions(),
        });
        return worker as unknown as WorkerLike;
    }

    private buildPerTaskQueue(taskId: string): Queue {
        const connection = getQueueConnection();
        if (!connection) {
            throw new Error('TaskRunner: cannot build queue — CACHE_URL not configured');
        }
        const queue = new Queue(perTaskQueueName(taskId), {
            connection,
            prefix: PER_TASK_QUEUE_PREFIX,
            defaultJobOptions: BULL_DEFAULT_RETENTION,
        });
        logQueueConnectionErrors(queue, 'task-queue');
        return queue;
    }

    private async startTaskWorker(task: TaskDefinition<unknown, unknown>): Promise<void> {
        await this.registerWorker(() => {
            const taskId = task.id;
            const processor: Processor = async (job: Job, token?: string) => {
                return this.processJob(job as RunnerJob, token);
            };
            const worker = this.workerFactory(task.resourceClass, processor, taskId);
            this.taskWorkers.set(taskId, {
                taskId,
                cls: task.resourceClass,
                worker,
            });
            this.watchConsumerProgress(worker);
            watchWorkerRecovery(worker);
            worker.on('error', (err: unknown) => {
                if (this.logMemoryCriticalIfMatch(err, { taskId })) return;
                if (this.maybeReactToLockLoss(err)) return;
                // Per-task mode: this Worker owns a dedicated connection for
                // `taskId` alone, so `taskId` IS the wedge-tracking scope — it must
                // NOT be masked by (or mask) any other task's healthy connection.
                this.connWatchdog?.recordError(taskId, err);
                // Valkey went away: one warning per outage, not one per Worker.
                if (logTaskConnectionLoss(`task-worker:${taskId}`, err)) return;
                log.warn('Task worker error', { taskId, err: errMessage(err) });
            });
            log.info('Worker started for task', {
                taskId,
                resourceClass: task.resourceClass,
                concurrency: this.perTaskConcurrency(task),
                instance: this.instanceId,
            });
        });
    }

    /**
     * Log "class budget saturated — deferring jobs" at most once per class per
     * BUDGET_DEFER_LOG_THROTTLE_MS. Gives operators + the preprod soak a signal
     * that a class is shedding to delay (expected backpressure) without one log
     * line per deferred pop under heavy contention.
     */
    private logBudgetDeferThrottled(cls: ResourceClass): void {
        const now = Date.now();
        const last = this.lastBudgetDeferLogAt.get(cls) ?? 0;
        if (now - last < BUDGET_DEFER_LOG_THROTTLE_MS) return;
        this.lastBudgetDeferLogAt.set(cls, now);
        log.info('Class budget saturated — deferring jobs (moveToDelayed)', {
            cls,
            cap: this.concurrencyFor(cls),
        });
    }

    /**
     * If a Worker `error` event is a Valkey out-of-memory / save-failure
     * condition, log it at ERROR (loud + searchable) and return true so the
     * caller skips the generic warn. Logs at most once per
     * MEMORY_CRITICAL_LOG_THROTTLE_MS across all workers — the throttle is the
     * whole point: BullMQ's poll/lock-renew loop re-emits this continuously
     * while Valkey rejects writes, and an unthrottled log.error per event
     * flooded a worker to 186 GB → filled the host disk (2026-05 preprod
     * incident). Suppressed events are counted and folded into the next line.
     *
     * Match variants:
     *   - `OOM command not allowed when used memory > 'maxmemory'.`
     *   - `OOM Can't save in background: fork: Cannot allocate memory`
     *   - `MISCONF Redis is configured to save RDB snapshots, ...` (writes
     *     refused after a background save failed — e.g. disk full)
     *   - `EXECABORT Transaction discarded ...` mid-pipeline OOM
     */
    private logMemoryCriticalIfMatch(err: unknown, context: Record<string, unknown>): boolean {
        const msg = errMessage(err);
        const isMemoryCritical =
            /\bOOM\b/.test(msg) ||
            msg.includes('MISCONF') ||
            (msg.includes('EXECABORT') && msg.includes('memory'));
        if (!isMemoryCritical) return false;

        const now = Date.now();
        if (now - this.lastMemoryCriticalLogAt < MEMORY_CRITICAL_LOG_THROTTLE_MS) {
            this.suppressedMemoryCriticalLogs++;
            return true;
        }
        const suppressed = this.suppressedMemoryCriticalLogs;
        this.suppressedMemoryCriticalLogs = 0;
        this.lastMemoryCriticalLogAt = now;
        log.error(
            'Valkey OOM / save-failure — workers cannot claim or complete jobs. ' +
                'Increase --maxmemory, verify the RDB snapshot path is writable, ' +
                'or consider splitting BullMQ onto its own Valkey instance. See ' +
                '`docker compose exec lumastra-valkey valkey-cli INFO memory` for current usage.',
            err instanceof Error ? err : new Error(msg),
            { ...context, suppressedSinceLastLog: suppressed },
        );
        return true;
    }

    /** A hard-kill reservation owns termination until queue cleanup is known.
     * A refusal is not a task outcome: stop all subsequent SQL/identity writes. */
    private async transitionRun(
        opts: Parameters<StateMachine['transitionRun']>[0],
    ): ReturnType<StateMachine['transitionRun']> {
        const result = await this.stateMachine.transitionRun(opts);
        if (!result.ok && result.error === 'hard kill queue cleanup pending')
            throw new AuthorityError('not_drained');
        return result;
    }

    // -- core processJob -----------------------------------------------------

    /**
     * Release the per-run resources acquired BEFORE execute() — the concurrency
     * counter, the AbortController, and the cancel subscription — in ONE place.
     * This triad was copy-pasted across several pre-exec early-exit paths; a new
     * early-exit that forgot one member leaked silently. `releaseConcurrent` is
     * wrapped so the Map cleanup ALWAYS runs even if the concurrency release
     * throws (the invariant the pv-mismatch path already documented).
     */
    private async releasePreExecResources(
        runId: string,
        releaseConcurrent: () => Promise<void>,
    ): Promise<void> {
        try {
            await releaseConcurrent();
        } catch (err) {
            log.warn('releaseConcurrent failed during pre-exec cleanup', {
                runId,
                err: errMessage(err),
            });
        }
        this.abortControllers.delete(runId);
        this.softAbortControllers.delete(runId);
        // W1/C2: the watchdog-release handle is registered in processJob BEFORE
        // the bail-prone claim/transition/version steps, so a pre-exec bail would
        // otherwise leave a stale `runReleases` entry (a slow Map leak; the
        // watchdog would also retain a now-useless handle). Drop it here — this
        // teardown runs on every pre-exec bail. Safe no-op when the run bailed
        // before the handle was registered.
        this.runReleases.delete(runId);
        // BUG2: same reasoning as the main finally cleanup — a bail this early
        // can't have an isolation handle yet, but a cancel could still have
        // raced in since subscribeCancelPhase runs before this point, so clear
        // any armed grace timer defensively.
        const graceTimer = this.cancelGraceTimers.get(runId);
        if (graceTimer) {
            clearTimeout(graceTimer);
            this.cancelGraceTimers.delete(runId);
        }
        const unsub = this.cancelUnsubs.get(runId);
        this.cancelUnsubs.delete(runId);
        if (unsub) {
            try {
                await unsub();
            } catch {
                // best-effort
            }
        }
    }

    /**
     * Phase 0 — precondition resolution. Validates `job.data.runId`, short-
     * circuits synthetic pipeline gates, and resolves the task from the
     * registry. Returns a discriminated result the `processJob` driver
     * dispatches on:
     *
     *   - `gate`    → synthetic `__gate__<taskId>` FlowJob; return its success
     *                 sentinel verbatim (no registered handler to run).
     *   - `unknown` → no registered task; the terminal `failed` row has already
     *                 been recorded in Postgres, so the driver only throws.
     *   - `ok`      → carries the resolved `{ runId, taskId, task }` for the
     *                 resource-acquisition phases that follow.
     *
     * This phase acquires NO per-run resources (no concurrency counter, no
     * AbortController, no cancel subscription), so it has no teardown
     * obligations and is safe to run before the main try/finally.
     */
    private async resolveTaskOrShortCircuit(
        job: RunnerJob,
    ): Promise<
        | { kind: 'gate'; result: { success: true; gate: true } }
        | { kind: 'unknown'; taskId: string }
        | { kind: 'ok'; runId: string; taskId: string; task: TaskDefinition }
    > {
        const runId = job.data?.runId;
        if (!runId || typeof runId !== 'string') {
            throw new TaskError({
                message: 'job.data.runId missing',
                kind: 'fatal',
            });
        }

        const taskId = job.name;

        // Synthetic pipeline gate (multi-parent fan-in) — pipeline-builder
        // inserts a `__gate__<convergentTaskId>` FlowJob between predecessors
        // and the convergent task. The gate has no registered handler; its
        // sole job is to "complete" once BullMQ has finished all children
        // so the convergent task can proceed. Just return success.
        if (taskId.startsWith('__gate__')) {
            // Flip the gate's pending task_history row (inserted by
            // enqueuePipeline, TASK-C7) to a terminal `completed` state so the
            // synthetic fan-in node is traceable in the admin UI rather than
            // sitting in `pending` forever. Best-effort — a missing row (e.g.
            // DB was down at enqueue time) is fine; the gate's purpose is
            // purely to let BullMQ release the convergent child.
            await this.markGateCompletedInPostgres(runId);
            return { kind: 'gate', result: { success: true, gate: true } };
        }

        const task = this.registry.getTask(taskId);
        if (!task) {
            // Unknown task — record terminal failure in Postgres so the run
            // doesn't sit in pending forever, then signal the driver to throw
            // so the BullMQ job is marked failed too.
            await this.recordFailure(runId, `Unknown task: ${taskId}`, 'permanent');
            return { kind: 'unknown', taskId };
        }

        return { kind: 'ok', runId, taskId, task };
    }

    private async subscribeCancelPhase(runId: string): Promise<AbortController> {
        // Subscribe to the cancel channel FIRST. Valkey pubsub does not
        // buffer, so any PUBLISH that lands before we've subscribed is
        // lost. Subscribing before claim/transition means a cancel
        // arriving during context construction is observed via abort.
        const abort = new AbortController();
        this.abortControllers.set(runId, abort);
        if (this.requestedExecutionCancels.has(runId)) abort.abort();
        await this.subscribeCancel(runId, abort);
        return abort;
    }

    /**
     * P1 — per-task maxConcurrent gate. ATOMIC check-and-INCR via the shared
     * `acquireSemaphoreToken` Lua (same primitive as the class budget): the
     * GET<cap check and the INCR happen in one Valkey round-trip so the counter
     * NEVER increments past cap and there is no reject-side DECR to leak. The
     * DRIVER owns the `concurrentAcquired` flag: on { kind: 'continue',
     * acquired: true } it sets it; the terminal release (DECR via
     * `releaseConcurrent`) stays in the driver.
     *
     * Previously this was a raw `INCR` then a check-and-DECR-if-over-cap. Two
     * bugs the Lua fixes: (1) concurrent acquires briefly exceeded cap and a
     * swallowed reject-side DECR leaked a token (the exact class-budget bug,
     * fixed the same way); (2) the key had NO TTL, so a worker crash leaked the
     * slot until the reconciler sweep. The Lua's EXPIRE seeds a 300s TTL
     * (`BUDGET_TTL_SECONDS`, shared with the class budget) and the heartbeat
     * refreshes it so a long-running task's counter never expires mid-run.
     *
     * On at-cap (Lua returned -1) we re-queue with a short jittered delay
     * (moveToDelayed → 'deferred') rather than fail, mirroring the class-budget
     * exhaustion path. The old transient-throw path wrote a `failed` task_history
     * row per collision AND consumed a BullMQ retry attempt; on every-1m
     * schedule-driven tasks with periodic concurrent runs this surfaced as a
     * steady "N failed in last 24h" chip in the admin UI for behaviour that is
     * exactly what maxConcurrent is supposed to do. The counter is released
     * exactly once via `releaseConcurrent()` (driver-owned) on every terminal
     * path so it can't drift negative.
     *
     * The atomic Lua never increments on the reject path, so — unlike the old
     * INCR-then-DECR code — there is no rollback DECR to pass in here.
     */
    private async acquireMaxConcurrent(
        job: RunnerJob,
        token: string | undefined,
        task: TaskDefinition,
        taskId: string,
        runId: string,
        concurrentKey: string,
    ): Promise<
        | { kind: 'continue'; acquired: boolean }
        | { kind: 'deferred' }
        | { kind: 'bail'; error: TaskError }
    > {
        const maxConcurrent = task.quotas?.maxConcurrent;
        if (maxConcurrent === undefined || maxConcurrent <= 0) {
            return { kind: 'continue', acquired: false };
        }
        const client = this.getClient();
        // Atomic check-and-INCR with a 300s TTL backstop (shared
        // BUDGET_TTL_SECONDS). `acquired === false` means the counter was at
        // cap — the Lua did NOT increment, so no rollback DECR is needed.
        const acq = await acquireSemaphoreToken(
            client,
            concurrentKey,
            maxConcurrent,
            BUDGET_TTL_SECONDS,
        );
        if (!acq.acquired) {
            const count = maxConcurrent; // at cap (Lua returned -1)
            const canDelay =
                typeof token === 'string' &&
                token.length > 0 &&
                typeof (job as unknown as { moveToDelayed?: unknown }).moveToDelayed === 'function';
            if (canDelay) {
                const delayMs =
                    BUDGET_RETRY_DELAY_BASE_MS +
                    Math.floor(Math.random() * BUDGET_RETRY_DELAY_JITTER_MS);
                try {
                    await (
                        job as unknown as {
                            moveToDelayed: (ts: number, token?: string) => Promise<void>;
                        }
                    ).moveToDelayed(Date.now() + delayMs, token);
                } catch (err) {
                    log.warn(
                        'maxConcurrent moveToDelayed failed; falling back to transient retry',
                        {
                            runId,
                            taskId,
                            err: errMessage(err),
                        },
                    );
                    return {
                        kind: 'bail',
                        error: new TaskError({
                            message: `maxConcurrent-delay failed for task ${taskId}: ${errMessage(err)}; will retry`,
                            kind: 'transient',
                        }),
                    };
                }
                return { kind: 'deferred' };
            }
            return {
                kind: 'bail',
                error: new TaskError({
                    message: `maxConcurrent reached for task ${taskId} (limit=${maxConcurrent}, active=${count})`,
                    kind: 'transient',
                }),
            };
        }
        return { kind: 'continue', acquired: true };
    }

    /**
     * Class budget semaphore (Wave 8.5). When per-task queues are on, each
     * task's Worker concurrency is only the per-task ceiling; the class-wide
     * cap (LUMASTRA_CONCURRENCY_<class>) is enforced here so N tasks sharing a
     * class can't collectively pin more than the class budget. Acquired
     * AFTER the per-task maxConcurrent check so a task already at its own
     * ceiling never consumes a class token it would immediately return. On
     * exhaustion we RE-QUEUE the job with a short delay (moveToDelayed) —
     * NOT fail it. The old "throw transient" path consumed a BullMQ retry
     * attempt and (for low-retry tasks like image-sync) sent the job
     * straight to `failed`, leaving the run `pending` → reclaimed as an
     * orphan → re-enqueued → a 93%-rejection churn loop under real io
     * contention (27 io-class tasks sharing io budget=4). moveToDelayed
     * makes a budget-blocked job wait gracefully like a job queued behind a
     * full per-class worker did under the old model: no failure, no retry
     * consumed, the run stays `pending` with a live (delayed) job so
     * boot-recovery never mis-classifies it as an orphan.
     *
     * The driver owns the `budgetAcq` state (so `releaseConcurrent` can close
     * over it). This phase NEVER assigns it — it returns the acquired token on
     * { kind: 'continue', budgetAcq } and the driver assigns. On bail/defer it
     * has already called the driver-owned `releaseConcurrent` to free the
     * maxConcurrent slot acquired just above.
     */
    private async acquireClassBudget(
        job: RunnerJob,
        token: string | undefined,
        task: TaskDefinition,
        taskId: string,
        runId: string,
        releaseConcurrent: () => Promise<void>,
    ): Promise<
        | { kind: 'continue'; budgetAcq: BudgetAcquisition | null }
        | { kind: 'deferred' }
        | { kind: 'bail'; error: TaskError }
    > {
        if (!this.perTaskQueues) {
            return { kind: 'continue', budgetAcq: null };
        }
        // Resolve the client in a guarded step: getClient() throws when
        // Valkey is disconnected, and this sits BEFORE the main try/finally —
        // so an unguarded throw here would leak the maxConcurrent slot
        // acquired just above. Release and bail transient instead.
        let budgetClient: ValkeyLike;
        try {
            budgetClient = this.getClient();
        } catch (err) {
            await releaseConcurrent();
            return {
                kind: 'bail',
                error: new TaskError({
                    message: `Resource budget client unavailable for task ${taskId}: ${errMessage(err)}`,
                    kind: 'transient',
                }),
            };
        }
        // Express lane: admin/manual (low-priority-number) runs may use the
        // full class budget; background runs are held one token below it so a
        // free slot is (almost) always waiting for an express run — it starts
        // promptly without cancelling anything. `job.opts.priority` is the
        // resolved BullMQ priority set at enqueue (orchestrator.startRun).
        const reserveForExpress = !isExpressPriority(job.opts?.priority);
        const acq = await acquireBudget(
            budgetClient,
            task.resourceClass,
            (c) => this.concurrencyFor(c),
            { reserveForExpress },
        );
        if (!acq.acquired) {
            await releaseConcurrent();
            // Re-queue with a short jittered delay rather than fail. Needs
            // the BullMQ job token + moveToDelayed; both are present on the
            // real worker path. If either is missing (test fakes / a job
            // shape without moveToDelayed), fall back to the transient throw
            // so behaviour is still correct, just less graceful.
            const canDelay =
                typeof token === 'string' &&
                token.length > 0 &&
                typeof (job as unknown as { moveToDelayed?: unknown }).moveToDelayed === 'function';
            if (canDelay) {
                const delayMs =
                    BUDGET_RETRY_DELAY_BASE_MS +
                    Math.floor(Math.random() * BUDGET_RETRY_DELAY_JITTER_MS);
                try {
                    await (
                        job as unknown as {
                            moveToDelayed: (ts: number, token?: string) => Promise<void>;
                        }
                    ).moveToDelayed(Date.now() + delayMs, token);
                } catch (err) {
                    // moveToDelayed can reject — the job lock may have been
                    // released by BullMQ's stalled-job detector, the job may
                    // have been moved by an admin action, or Valkey hiccuped.
                    // If the raw rejection escaped it would count as a failed
                    // attempt and resurrect the churn loop, so fall back to
                    // the transient throw (which BullMQ retries with backoff).
                    log.warn('budget moveToDelayed failed; falling back to transient retry', {
                        runId,
                        taskId,
                        err: errMessage(err),
                    });
                    return {
                        kind: 'bail',
                        error: new TaskError({
                            message: `Budget-delay failed for task ${taskId}: ${errMessage(err)}; will retry`,
                            kind: 'transient',
                        }),
                    };
                }
                // Throttled visibility: a saturated class deferring jobs is
                // expected backpressure, but operators (and the soak) need to
                // see it without per-job log spam.
                this.logBudgetDeferThrottled(task.resourceClass);
                // DelayedError tells BullMQ the job was deferred (not
                // completed/failed); it does NOT consume a retry attempt.
                return { kind: 'deferred' };
            }
            return {
                kind: 'bail',
                error: new TaskError({
                    message: `Resource budget exhausted for class ${task.resourceClass} (task ${taskId}); will retry`,
                    kind: 'transient',
                }),
            };
        }
        return { kind: 'continue', budgetAcq: acq };
    }

    /**
     * 4b. processing_version guard.
     *
     *    The row's `processing_version` was stamped at insert by the
     *    orchestrator (or downstream-trampoline) using whatever code
     *    revision was live at that moment. During a rolling restart an
     *    in-flight job from a prior revision can land on a worker
     *    running new code that expects a higher version — e.g. the
     *    embedding schema changed and running the old payload through
     *    new code would write garbage.
     *
     *    Policy:
     *      row.pv == null         → legacy / pre-Wave-9 row, run normally
     *      row.pv == task.pv      → match, run normally
     *      row.pv < task.pv       → stale enqueue, fail PERMANENT
     *                               (don't retry — code/data mismatch)
     *      row.pv > task.pv       → row was created by FUTURE code; log
     *                               but still run. Refusing here would
     *                               block downgrade rollbacks where the
     *                               new replica drains queues from the
     *                               old replica during a revert.
     *
     * Sits BEFORE the main execute try/finally. On the mismatch path it
     * releases everything explicitly and returns a `bail` decision; the
     * driver throws the carried error WITHOUT entering the try. Every other
     * branch returns `continue` and the driver proceeds.
     */
    private async processingVersionGuard(
        job: RunnerJob,
        runId: string,
        taskId: string,
        task: TaskDefinition,
        releaseConcurrent: () => Promise<void>,
    ): Promise<{ kind: 'continue' } | { kind: 'bail'; error: TaskError }> {
        const pvRead = await this.readProcessingVersion(runId);
        if (pvRead.kind === 'no-sql') {
            // Degraded boot or DB outage — the guard cannot run. Log loudly
            // so the operator can see we're proceeding without the safety
            // check. Blocking would prevent ANY work during a DB outage,
            // which is worse than the (rare) risk of running a stale payload
            // through new code; the trade-off is explicit here.
            log.warn('processing_version guard skipped — sql unavailable', {
                runId,
                taskId,
                taskProcessingVersion: task.processingVersion,
            });
        } else if (pvRead.kind === 'value' && pvRead.value < task.processingVersion) {
            log.warn('processing_version mismatch — refusing to execute', {
                runId,
                taskId,
                rowProcessingVersion: pvRead.value,
                taskProcessingVersion: task.processingVersion,
            });
            // Heartbeat hasn't started yet (step 6) and no execute has run,
            // so this is a clean failure path. Drive the run to terminal
            // 'failed' via the active→failed transition, then throw
            // permanent so BullMQ records the attempt as failed-without-retry.
            const reason = 'processing_version_mismatch';
            const errorMessage =
                `processing_version_mismatch: row=${pvRead.value} ` +
                `task=${task.processingVersion}`;
            try {
                await this.transitionRun({
                    runId,
                    from: 'active',
                    to: 'failed',
                    extra: {
                        failedAt: nowIso(),
                        errorMessage,
                        errorKind: 'permanent',
                    },
                });
            } catch (err) {
                if (err instanceof AuthorityError) {
                    taskActiveRuns.dec({
                        resource_class: task.resourceClass,
                        instance_id: this.instanceId,
                    });
                    await this.releasePreExecResources(runId, releaseConcurrent);
                    throw err;
                }
                // Best-effort — the Postgres write below still lands and
                // boot-recovery's terminal classifier will sweep the row.
                log.warn('processing_version_mismatch state transition failed', {
                    runId,
                    err: errMessage(err),
                });
            }
            await this.writeTerminalToPostgres(
                runId,
                'failed',
                null,
                {
                    message: errorMessage,
                    kind: 'permanent',
                    reason,
                },
                taskId,
            );
            // Throw path (permanent pv-mismatch) → release the mutex only on
            // the final attempt.
            if (this.isFinalAttempt(job, task)) await this.releaseExclusivityKey(job);
            taskActiveRuns.dec({
                resource_class: task.resourceClass,
                instance_id: this.instanceId,
            });
            await this.releasePreExecResources(runId, releaseConcurrent);
            return {
                kind: 'bail',
                error: new TaskError({
                    message: errorMessage,
                    kind: 'permanent',
                }),
            };
        } else if (pvRead.kind === 'value' && pvRead.value > task.processingVersion) {
            log.warn(
                'processing_version: row is newer than task — proceeding (downgrade rollback)',
                {
                    runId,
                    taskId,
                    rowProcessingVersion: pvRead.value,
                    taskProcessingVersion: task.processingVersion,
                },
            );
        }
        // `kind: 'null-row'` falls through silently — legacy row, no guard.
        return { kind: 'continue' };
    }

    /**
     * P4+P5 — Re-seed the active hash (F6), then claim ownership via Lua.
     *
     * Combined into one phase because both bail paths share the same
     * pre-exec teardown: `releasePreExecResources(runId, releaseConcurrent)`.
     * Sits BEFORE the main execute try/finally; on either bail it releases
     * pre-exec resources explicitly and returns a `bail` decision; the driver
     * throws the carried error WITHOUT entering the try.
     */
    private async reseedAndClaim(
        job: RunnerJob,
        runId: string,
        releaseConcurrent: () => Promise<void>,
        token?: string,
    ): Promise<{ kind: 'continue' } | { kind: 'bail'; error: TaskError }> {
        // 2. F6 — Re-seed the active hash before claim.
        //
        //    Two cases this protects:
        //
        //    (a) BullMQ retry — transition-run.lua DEL's the active hash on
        //        every terminal transition (active→failed). When BullMQ
        //        retries after `retry.backoff`, the worker re-enters
        //        `processJob` for the same runId — but the hash is gone,
        //        so claim-run.lua rejects with 'run not found'. Effective
        //        retry count = 0 without the reseed.
        //
        //    (b) Long queue wait — the orchestrator's initial HSET sets the
        //        hash with `PEXPIRE` = LUMASTRA_RUN_STATE_TTL_ACTIVE_MS
        //        (default 15 min). When a worker's concurrency cap is
        //        saturated, jobs can sit in BullMQ's prioritized queue for
        //        much longer than 15 min — observed 15-30 min waits on
        //        preprod with cpu=1 concurrency and a trickplay backlog.
        //        The hash TTL fires before the worker picks the job up,
        //        and the first-attempt claim fails with 'run not found' —
        //        same symptom as the retry case but happening on attempt 0.
        //        Boot-recovery then catches the now-pending task_history
        //        row + the now-failed BullMQ job and stamps it
        //        `pending_orphan_at_recovery`. Sustained ~450/hr orphan
        //        rate on preprod overnight.
        //
        //    reseedForRetry recreates the hash in 'pending' state when (and
        //    only when) it's missing or terminal. It refuses to clobber a
        //    'cancelling' hash so a cancel that arrived between attempts
        //    still wins. A redelivery holding its current queue lock may reset
        //    a stranded active hash after the prior handler has unwound.
        //
        //    Always called (not gated on attemptsMade) so case (b) is
        //    covered for fresh runs too.
        //
        //    Result map:
        //      'reseeded'    — terminal/missing → now pending → claim will succeed
        //      'kept-active' — pending, or active without redelivery ownership
        //      'skipped'     — cancelling → abort, let cancel flow finish
        if (token && job.attemptsStarted > 1) {
            try {
                const sql = this.getSql();
                const live = sql
                    ? await sql`
                    SELECT id FROM task_history
                    WHERE id = ${runId} AND state = 'active'
                      AND heartbeat_at > NOW() - INTERVAL '60 seconds'
                `
                    : [];
                if (live.length) {
                    await withTaskQueueWrite(
                        this.getSql(),
                        this.authority,
                        { kind: 'defer-live-predecessor', queue: job.queueName, jobId: job.id },
                        () => job.moveToDelayed(Date.now() + 30_000, token),
                    );
                    throw new DelayedError();
                }
            } catch (err) {
                await this.releasePreExecResources(runId, releaseConcurrent);
                throw err;
            }
        }
        let reseedResult: 'reseeded' | 'skipped' | 'kept-active' | null = null;
        try {
            reseedResult =
                token && job.attemptsStarted > 1
                    ? await this.stateMachine.reseedForRetry(runId, {
                          lockKey: `${job.queueQualifiedName}:${job.id}:lock`,
                          token,
                      })
                    : await this.stateMachine.reseedForRetry(runId);
        } catch (err) {
            // Reseed failure is best-effort — claim-run.lua will reject
            // and bubble a transient error. We log and let the natural
            // flow proceed.
            log.warn('reseedForRetry failed — claimRun may reject', {
                runId,
                attemptsMade: job.attemptsMade,
                err: errMessage(err),
            });
        }
        if (reseedResult === 'skipped') {
            // Cancel arrived between attempts. Release resources and
            // throw PERMANENT so BullMQ does not retry again — the
            // cancel flow will write the terminal cancelled state.
            //
            // NOTE: this throw must escape the try/catch above (which
            // is why the try only wraps the call, not the result-check)
            // — otherwise the warn-catch would swallow the abort signal.
            await this.releasePreExecResources(runId, releaseConcurrent);
            // An in-flight cancellation retains its mutex until the cancel flow
            // finishes. A terminal cancellation can safely release it now too.
            if ((await this.readRunStateForRecovery(runId)) === 'cancelled')
                await this.releaseExclusivityKey(job);
            return {
                kind: 'bail',
                error: new TaskError({
                    message: `Retry skipped — run ${runId} is cancelling`,
                    kind: 'permanent',
                }),
            };
        }

        // 3. Claim ownership via Lua. The orchestrator seeded the hash with
        //    state=pending; claim-run.lua verifies that and sets owner fields.
        const claim = await this.stateMachine
            .claimRun({
                runId,
                expectedState: 'pending',
                instanceId: this.instanceId,
                bootId: this.bootId,
            })
            .catch(async (err: unknown) => {
                // A disconnected Valkey throws instead of returning ok:false.
                // This phase is outside execute()'s cleanup, so release here too.
                await this.releasePreExecResources(runId, releaseConcurrent);
                const task = this.registry.getTask(job.name);
                if (task && this.isFinalAttempt(job, task)) await this.releaseExclusivityKey(job);
                throw err;
            });
        if (!claim.ok) {
            // Hash may have expired (TTL) or another replica claimed it. Don't
            // mark the row failed — boot recovery handles orphans. Surface the
            // error so BullMQ records this attempt as failed and retries pick
            // it up cleanly. Release the cancel subscription and concurrent
            // counter so we don't leak.
            await this.releasePreExecResources(runId, releaseConcurrent);
            // A live predecessor is not a failed attempt. Keep the same job
            // parked until its liveness proof expires; never burn its retries.
            if (token && claim.error?.includes('expected pending got active')) {
                await withTaskQueueWrite(
                    this.getSql(),
                    this.authority,
                    { kind: 'defer-live-predecessor', queue: job.queueName, jobId: job.id },
                    () => job.moveToDelayed(Date.now() + 30_000, token),
                );
                throw new DelayedError();
            }
            const task = this.registry.getTask(job.name);
            if (task && this.isFinalAttempt(job, task)) await this.releaseExclusivityKey(job);
            return {
                kind: 'bail',
                error: new TaskError({
                    message: `claimRun failed for ${runId}: ${claim.error ?? 'unknown'}`,
                    kind: 'transient',
                }),
            };
        }
        return { kind: 'continue' };
    }

    private async transitionToActive(
        runId: string,
        task: TaskDefinition,
        releaseConcurrent: () => Promise<void>,
    ): Promise<{ kind: 'continue' } | { kind: 'bail'; error: TaskError }> {
        // 4. pending → active. Idempotent in practice — boot recovery may
        //    have already marked the row active in Postgres, but the Valkey
        //    hash transition still needs to land for QueueEvents to fire.
        //    This await sits BEFORE the main try/finally; a Valkey error here
        //    (transition-run.lua EVALSHA reject) would otherwise leak the
        //    maxConcurrent + class-budget slots and the cancel subscription.
        //    Release + clean up + rethrow transient so BullMQ retries.
        const executionStartedAt = nowIso();
        try {
            await this.transitionRun({
                runId,
                from: 'pending',
                to: 'active',
                extra: {
                    startedAt: executionStartedAt,
                    ownerInstanceId: this.instanceId,
                },
            });
        } catch (err) {
            await this.releasePreExecResources(runId, releaseConcurrent);
            return {
                kind: 'bail',
                error: new TaskError({
                    message: `pending→active transition failed for ${runId}: ${errMessage(err)}`,
                    kind: 'transient',
                }),
            };
        }
        await this.markActiveInPostgres(runId, executionStartedAt);
        taskActiveRuns.inc({
            resource_class: task.resourceClass,
            instance_id: this.instanceId,
        });
        return { kind: 'continue' };
    }

    async processJob(job: RunnerJob, token?: string, signal?: AbortSignal): Promise<unknown> {
        assertTaskJobOrigin(this.authority, job.data.taskAuthority, job.id);
        if (this.executorMode && this.stopped) throw new Error('TaskRunner is stopped');
        // Reserve before any awaited gate. A settled processor can still have
        // a handler unwinding after a watchdog trip, so check both lifetimes.
        if (
            this.executingRunIds.has(job.data.runId) ||
            [...this.executionContinuations.values()].includes(job.data.runId)
        ) {
            if (!token)
                throw new TaskError({
                    kind: 'transient',
                    message: 'Previous execution is still unwinding',
                });
            await job.moveToDelayed(Date.now() + BUDGET_RETRY_DELAY_BASE_MS, token);
            throw new DelayedError();
        }
        const cancel = (): void => this.cancelExecution(job.data.runId);
        this.executingJobs++;
        this.executingRunIds.add(job.data.runId);
        this.executingQueueJobs.set(job.data.runId, job);
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        try {
            return await this.processJobInternal(job, token);
        } finally {
            const slot = this.playbackSlots.get(job.data.runId);
            this.playbackSlots.delete(job.data.runId);
            await slot?.release();
            // Delayed jobs retain their first-deferral visibility until admission.
            if (this.playbackAdmitted.delete(job.data.runId))
                await recordPlaybackDeferral(() => this.getClient(), job.data.runId, undefined);
            signal?.removeEventListener('abort', cancel);
            this.requestedExecutionCancels.delete(job.data.runId);
            this.executingRunIds.delete(job.data.runId);
            this.executingQueueJobs.delete(job.data.runId);
            this.executingJobs--;
        }
    }

    private async processJobInternal(job: RunnerJob, token?: string): Promise<unknown> {
        // A delivered job is proof the task-Valkey connection works end-to-end —
        // the watchdog's only reliable recovery signal (a fresh PING can succeed
        // while BullMQ's own connections stay wedged). `job.queueName` is the
        // bare taskId in per-task mode or the bare resource class in legacy
        // per-class mode (both `perTaskQueueName`/`taskQueueName` are identity
        // functions on their input) — i.e. exactly the scope the owning
        // Worker's `recordError` call site uses, so this clears the streak for
        // (and only for) the connection that actually proved itself here.
        this.connWatchdog?.recordHealthy(job.queueName);
        const resolved = await this.resolveTaskOrShortCircuit(job);
        if (resolved.kind === 'gate') {
            return resolved.result;
        }
        if (resolved.kind === 'unknown') {
            throw new TaskError({
                message: `Unknown task: ${resolved.taskId}`,
                kind: 'permanent',
            });
        }
        const { runId, taskId, task } = resolved;

        // Resume after restart: a SIGKILL that lands after the interrupt
        // marker but before BullMQ failed the job leaves it active; the
        // stalled check then redelivers it and reseed would happily run the
        // OLD run id again — next to the run the reclaim resumed it as. Checked
        // before any concurrency gate (a refused job must not wait behind the
        // resumed run's maxConcurrent slot). RETURNS instead of throwing: a
        // 'failed' QueueEvent would let the leader's flush write a terminal
        // over the reclaimed row's "resumed as" message (it allows
        // failed→failed), while a 'completed' one only ends in a
        // transition-conflict for a row that is active or already failed.
        if (job.data.resume && (await this.isInterruptedOrReclaimed(runId))) {
            log.warn('Refused a redelivered job of an interrupted or reclaimed run', {
                runId,
                taskId,
            });
            return { success: false, itemsProcessed: 0, redeliveryRefused: true };
        }

        if (job.attemptsStarted > job.attemptsMade + 1) {
            const sql = this.getSql();
            if (!sql)
                throw new TaskError({
                    kind: 'transient',
                    message: 'Database unavailable during stalled delivery recovery',
                });
            const [prior] = await sql<
                { state: string; result: unknown; error: { kind?: string } | null }[]
            >`
                SELECT state, result, error FROM task_history WHERE id = ${runId}
            `;
            if (!prior) throw new UnrecoverableError(`Run ${runId} no longer exists`);
            // Completion may have committed just before the old worker lost its
            // BullMQ lock. A redelivery must acknowledge it without side effects.
            if (prior?.state === 'completed') return prior.result;
            if (
                prior?.state === 'cancelled' ||
                prior?.state === 'cancelling' ||
                (prior?.state === 'failed' && prior.error?.kind !== 'transient')
            ) {
                throw new UnrecoverableError(`Run ${runId} is already ${prior.state}`);
            }
        }

        // Before counters, claims, or active-state writes: retain the SAME job
        // and identity; DelayedError consumes no attempt and cannot drop work.
        if (
            isBackgroundCpuTask(task.resourceClass, task.id) &&
            !playbackCpuExempt(
                task.id,
                job.data.playbackCpuExempt || isExpressPriority(job.opts?.priority),
            )
        ) {
            const pressure = await getPlaybackPressure(() => this.getClient());
            if (pressure.paused && !playbackDeferralExpired(job.data.playbackDeferredAt)) {
                const slot = await acquirePlaybackCpuSlot(
                    () => this.getClient(),
                    `${this.instanceId}:${runId}:${ulid()}`,
                );
                if (slot) this.playbackSlots.set(runId, slot);
                else {
                    if (!token || typeof job.moveToDelayed !== 'function') {
                        throw new TaskError({
                            kind: 'transient',
                            message: 'Background CPU playback slot is occupied',
                        });
                    }
                    // Persist the first deferral, never restart its clock on a
                    // retry/restart. After 15 minutes this job gets one complete
                    // execution outside the pressure limiter (starvation escape).
                    let persisted = true;
                    try {
                        if (job.data.playbackDeferredAt === undefined) {
                            await job.updateData({ ...job.data, playbackDeferredAt: Date.now() });
                        }
                    } catch {
                        persisted = false;
                    }
                    if (persisted) {
                        await recordPlaybackDeferral(
                            () => this.getClient(),
                            runId,
                            job.data.playbackDeferredAt,
                        );
                        await delay(250);
                        try {
                            await job.moveToDelayed(Date.now() + PRESSURE_RETRY_MS, token);
                        } catch (err) {
                            throw new TaskError({
                                kind: 'transient',
                                message: `Playback-pressure delay failed: ${errMessage(err)}`,
                            });
                        }
                        throw new DelayedError();
                    }
                }
            }
        }

        if (isBackgroundCpuTask(task.resourceClass, task.id)) {
            this.playbackAdmitted.add(runId);
            // The admin age represents waiting jobs, not a job now running.
            if (job.data.playbackDeferredAt !== undefined)
                await recordPlaybackDeferral(() => this.getClient(), runId, undefined);
        }

        // maxConcurrent quota enforcement lives in `acquireMaxConcurrent` (P1).
        // The counter is released exactly once via `releaseConcurrent()` on every
        // terminal path (success, failure, cancel, skipped-by-pipeline-when) so it
        // can't drift negative even under unusual control flow.
        //
        // Every DECR is wrapped in try/catch and logs WARN — if Valkey
        // disconnects mid-DECR we don't want a propagating throw to abort
        // terminal cleanup (which would leak the BullMQ active job AND the
        // counter). Boot-recovery's stale-counter sweep is the long-term
        // backstop for any leaks that slip through.
        const concurrentKey = `task:active-count:${taskId}`;
        let concurrentAcquired = false;
        let concurrentReleased = false;
        // Class budget token (Wave 8.5, per-task-queue path only). Released by
        // `releaseConcurrent` alongside the maxConcurrent counter so every
        // terminal path frees the class slot exactly once.
        let budgetAcq: BudgetAcquisition | null = null;
        const safeDecr = async (reason: string): Promise<void> => {
            // C1 — route through the shared `clampedDecr` so a negative drift
            // (reconciler clears the counter to its DB target a moment before
            // this terminal DECR fires → counter lands at "-1") is DEL'd back to
            // absent. A negative STRING value defeats the acquire Lua's `or '0'`
            // fallback and silently over-admits by 1; the clamp restores the
            // "key absent → 0" invariant. Same helper the class budget release
            // uses, so both counters self-heal identically.
            await clampedDecr(this.getClient(), concurrentKey, (msg, meta) =>
                log.warn('maxConcurrent DECR failed (counter may leak; boot-sweep clears)', {
                    taskId,
                    runId,
                    reason,
                    ...meta,
                    detail: msg,
                }),
            );
        };
        const releaseConcurrent = async (): Promise<void> => {
            const playbackSlot = this.playbackSlots.get(runId);
            this.playbackSlots.delete(runId);
            await playbackSlot?.release();
            // maxConcurrent counter — release once if held.
            if (concurrentAcquired && !concurrentReleased) {
                concurrentReleased = true;
                await safeDecr('terminal-cleanup');
            }
            // Class budget token — release once if held. `release()` is itself
            // idempotent (budget-semaphore.ts), so nulling here is belt-and-braces.
            if (budgetAcq) {
                const acq = budgetAcq;
                budgetAcq = null;
                await acq.release();
            }
        };
        const gate = await this.acquireMaxConcurrent(
            job,
            token,
            task,
            taskId,
            runId,
            concurrentKey,
        );
        if (gate.kind === 'deferred') throw new DelayedError();
        if (gate.kind === 'bail') throw gate.error;
        if (gate.acquired) concurrentAcquired = true;

        const budget = await this.acquireClassBudget(
            job,
            token,
            task,
            taskId,
            runId,
            releaseConcurrent,
        );
        if (budget.kind === 'deferred') throw new DelayedError();
        if (budget.kind === 'bail') throw budget.error;
        budgetAcq = budget.budgetAcq;

        // 1. Subscribe to the cancel channel FIRST (see subscribeCancelPhase).
        const abort = await this.subscribeCancelPhase(runId);

        // Register the terminal-release handle so the wall-clock/stall watchdog
        // can free this run's counters + BullMQ slot even when `execute()` wedges
        // permanently (its `finally` never runs). Both `releaseConcurrent` and
        // `removeBullJobForRun` are idempotent, so a later `finally` (if the wedge
        // ever clears) is a no-op. Cleared in the `finally` below (W1/C2). We
        // register here — after acquiring the counters but before the heavy
        // context build / execute — so the watchdog has the handle for the entire
        // window the slot is actually held.
        this.runReleases.set(runId, { release: releaseConcurrent, job });

        const claimed = await this.reseedAndClaim(job, runId, releaseConcurrent, token);
        if (claimed.kind === 'bail') throw claimed.error;

        const activated = await this.transitionToActive(runId, task, releaseConcurrent);
        if (activated.kind === 'bail') {
            // Activation failed before execute()'s terminal/finally paths.
            if (this.isFinalAttempt(job, task)) await this.releaseExclusivityKey(job);
            throw activated.error;
        }

        const pv = await this.processingVersionGuard(job, runId, taskId, task, releaseConcurrent);
        if (pv.kind === 'bail') throw pv.error;

        // Hoisted above the try so the catch block below can still reach the
        // in-flight execute() promise when the watchdog wins the race (F2/BUG4):
        // Promise.race leaves the loser (execPromise) attached to nothing once
        // it resolves via the watchdogTrip rejection, so a late resolution/
        // rejection from execPromise after that point would otherwise be an
        // unhandled rejection.
        let execPromise: Promise<unknown> | undefined;
        let stageRetriesExhausted = false;

        try {
            await this.refreshExclusivityKey(job, task);
            // 5. Build context. AbortController + cancel subscription are already
            //    wired (step 1). If a cancel arrived between claim and here,
            //    abort.signal.aborted is already true and the plugin's very
            //    first await throws cleanly into the catch block below.
            //
            //    buildContextWithCost + startHeartbeat live INSIDE this try (not
            //    above it) on purpose: `transitionToActive` already incremented
            //    `taskActiveRuns` and registered the abortController/cancelUnsub
            //    entries. If context construction or heartbeat setup threw while
            //    they sat between the inc and the try, the `finally` dec +
            //    Map cleanup never ran → a permanent gauge leak and a leaked
            //    abortController/cancelUnsub entry per failed attempt (F70).
            //    Keeping them in the try guarantees the finally always balances
            //    the inc.
            const { ctx, costSpend } = this.buildContextWithCost(task, job, abort);

            // 6. Start heartbeat AFTER claim so we don't refresh somebody else's TTL.
            //    Resolve the run's TRUE execution start first (durable; survives
            //    re-delivery) so the wall-clock watchdog anchors the hard-timeout
            //    budget to it instead of this attempt's pickup time. Runs AFTER
            //    transitionToActive so the Valkey active-hash `startedAt` exists.
            // BUG3: this runs BEFORE startHeartbeat, so there is zero watchdog
            // coverage yet — a Valkey/Postgres stall inside resolveBudgetStartMs
            // would otherwise hold the acquired slot forever. Bound it the same
            // way as the getChildrenValues call below: race against a timeout
            // that resolves to the function's own "unresolvable" fallback
            // (`undefined`) and log a warning so an operator can see it happened.
            let budgetStartTimedOut = false;
            const budgetStartMs = await Promise.race([
                this.resolveBudgetStartMs(runId),
                new Promise<undefined>((resolve) => {
                    const t = setTimeout(() => {
                        budgetStartTimedOut = true;
                        resolve(undefined);
                    }, RESOLVE_BUDGET_START_TIMEOUT_MS);
                    if (typeof t.unref === 'function') t.unref();
                }),
            ]);
            if (budgetStartTimedOut) {
                log.warn(
                    'resolveBudgetStartMs timed out; anchoring wall-clock budget to pickup time',
                    { runId, timeoutMs: RESOLVE_BUDGET_START_TIMEOUT_MS },
                );
            }
            this.startHeartbeat(runId, task as TaskDefinition<unknown, unknown>, budgetStartMs);

            // 7. pipeline.when skip evaluation. When a task declares a conditional
            //    predecessor, fetch the predecessor's result from the FlowProducer
            //    children-values map and ask the registry whether to skip this stage.
            if (task.pipeline?.when) {
                let parentResult: unknown;
                try {
                    const jobWithChildren = job as RunnerJob & {
                        getChildrenValues(): Promise<Record<string, unknown>>;
                    };
                    if (typeof jobWithChildren.getChildrenValues === 'function') {
                        // Bound this Valkey RPC: it's an unguarded network call on
                        // the hot path, and a Valkey stall here would otherwise let
                        // the wall-clock watchdog fire (writing terminal 'failed')
                        // while this await hangs — see the stallFailed guard below.
                        // On timeout, proceed with no parent result (don't skip).
                        const childrenValues = await Promise.race([
                            jobWithChildren.getChildrenValues(),
                            new Promise<Record<string, unknown>>((resolve) =>
                                setTimeout(() => resolve({}), GET_CHILDREN_VALUES_TIMEOUT_MS),
                            ),
                        ]);
                        // childrenValues is keyed by BullMQ job key; take the first
                        // (and typically only) value as the predecessor's result.
                        const values = Object.values(childrenValues);
                        parentResult = values.length > 0 ? values[0] : undefined;
                    }
                } catch {
                    // If getChildrenValues fails, treat parentResult as undefined.
                    parentResult = undefined;
                }

                if (this.registry.shouldSkipStage(task, parentResult)) {
                    // Watchdog late-write guard (same as the main/error paths): if
                    // the stall/wall-clock watchdog already finalized this run while
                    // we were resolving the predecessor above, it wrote a terminal
                    // 'failed'. Do NOT write 'completed' here — writeTerminalToPostgres
                    // allows a failed->completed overwrite (for the retry-success
                    // case), which would silently clobber the watchdog's failure and
                    // erase the signal. Throw so the outer catch discards it and
                    // BullMQ marks the job failed (matching the run); the finally
                    // handles all cleanup. (F2 edge case.)
                    if (this.stallFailed.has(runId)) {
                        throw new UnrecoverableError(
                            `Run ${runId} was stopped by the stall/timeout watchdog before its ` +
                                `pipeline.when skip could finalize; discarding the skip result.`,
                        );
                    }
                    this.stopHeartbeat(runId);
                    const skippedResult = {
                        skipped: true,
                        skippedByWhen: true,
                        reason: 'pipeline_when_false',
                    };
                    await this.transitionRun({
                        runId,
                        from: 'active',
                        to: 'completed',
                        extra: { completedAt: nowIso() },
                    });
                    await this.writeTerminalToPostgres(
                        runId,
                        'completed',
                        skippedResult,
                        null,
                        taskId,
                    );
                    // Emit a meta event so admin UI can surface "skipped by when()"
                    // distinctly from normal completions. Best-effort — the run
                    // is already terminal in Postgres/Valkey at this point.
                    await this.emitMeta('pipeline-when-skip', {
                        runId,
                        taskId,
                        parentRunId: job.data.parentRunId,
                        reason: 'pipeline_when_false',
                    });
                    taskActiveRuns.dec({
                        resource_class: task.resourceClass,
                        instance_id: this.instanceId,
                    });
                    await releaseConcurrent();
                    progressTracker.finalize(runId, this.authority);
                    this.costLedger.finalize(runId);
                    this.abortControllers.delete(runId);
                    this.runReleases.delete(runId);
                    this.softAbortControllers.delete(runId);
                    // BUG2: this run reached a terminal state (skipped) before
                    // execute() ever ran, so no isolation handle exists — clear
                    // any armed cancel grace timer defensively, same as the
                    // other cleanup sites.
                    const skipGraceTimer = this.cancelGraceTimers.get(runId);
                    if (skipGraceTimer) {
                        clearTimeout(skipGraceTimer);
                        this.cancelGraceTimers.delete(runId);
                    }
                    const skipUnsub = this.cancelUnsubs.get(runId);
                    this.cancelUnsubs.delete(runId);
                    if (skipUnsub) {
                        try {
                            await skipUnsub();
                        } catch {
                            /* best-effort */
                        }
                    }
                    return skippedResult;
                }
            }

            // Pipeline-coverage wrapper: when a task declares exactly ONE
            // covered stage AND the job carries a `mediaItemId` in its input,
            // we wrap `task.execute(ctx)` to write the stage's transitions
            // (running → completed/failed_transient/failed_permanent) in
            // `media_item_stage_state`. Multi-stage tasks per single execute
            // are out of scope for Phase 1a — they fall through to the bare
            // call. The wrapper never alters BullMQ retry semantics; it just
            // records coverage alongside whatever the existing runner does.
            //
            // The automatic recorder handles one stage per execute. Multi-stage
            // tasks such as media-probe write their coverage alongside their
            // business data; bypassing this recorder is expected.
            if (
                task.coversStages &&
                task.coversStages.length > 1 &&
                !this.warnedMultiStage.has(task.id)
            ) {
                this.warnedMultiStage.add(task.id);
                log.debug(
                    `Task ${task.id} declares ${task.coversStages.length} stages; automatic coverage recorder skipped (single-stage limit).`,
                );
            }

            const coverageSql = this.getSql();
            const singleStage =
                task.coversStages && task.coversStages.length === 1
                    ? task.coversStages[0]
                    : undefined;
            const coverageMediaItemId = this.extractMediaItemIdWithWarn(task.id, job.data.input);
            // Fork point: when isolation is enabled AND the task opts in, run
            // execute() in a worker thread; otherwise the unchanged in-process
            // path. The coverage wrapper composes over EITHER — it just needs an
            // `inner` thunk returning the plugin's result promise.
            //
            // The decision is computed once (here) so the log line below reflects
            // the path actually taken, and so `isolationEnabled` (which has a
            // once-only warn side effect for a missing bundle) runs exactly once.
            // `isolationEnabled` returns false on its first guard for any task
            // that didn't opt in — so the in-process path stays side-effect-free.
            const useIsolation = this.isolationEnabled(task as TaskDefinition<unknown, unknown>);
            // One line per run (NOT per item) so an operator can confirm from
            // container logs which path executed — the only success-path signal
            // that isolation engaged (everything else is error-only). Info only
            // when it DID engage: the default in-process path is most runs
            // (~200 lines an hour on prod) and says nothing new.
            const isolationContext = {
                taskId: task.id,
                runId,
                mode: useIsolation ? 'worker' : 'in-process',
            };
            if (useIsolation) log.info('task isolation decision', isolationContext);
            else log.debug('task isolation decision', isolationContext);
            if (job.data.resume) this.executeStartedAt.set(runId, Date.now());
            const runExecute = (): Promise<unknown> =>
                withApiCallSpend(ctx, () =>
                    useIsolation
                        ? this.executeIsolated(
                              task as TaskDefinition<unknown, unknown>,
                              job,
                              ctx,
                              abort,
                          )
                        : isBackgroundCpuTask(task.resourceClass, task.id)
                          ? withBackgroundCpu(
                                () => this.playbackCheckpoint(runId, abort.signal),
                                () => task.execute(ctx),
                            )
                          : task.execute(ctx),
                );

            // F2 — watchdog "trip". If the stall/wall-clock watchdog auto-fails
            // this run while an IN-PROCESS execute() is still pending (wedged on a
            // hung syscall / never-settling await), that promise never resolves and
            // would hold this Worker's concurrency slot until container restart.
            // Race execute() against a trip promise that autoFailRun rejects with
            // UnrecoverableError; it lands in the catch below, whose stallFailed
            // branch discards the late result and rethrows, so BullMQ moves the job
            // to 'failed' and FREES the slot. (This reclaims the slot, not the
            // wedged libuv thread — the safe-fs cap bounds threads; see F1.) A
            // SYNCHRONOUS-CPU wedge can't be freed this way — the watchdog timer is
            // on the blocked loop — which is why CPU tasks opt into
            // isolation:'worker', where terminate() rejects execute() directly.
            let tripReject: (e: Error) => void = () => {};
            const watchdogTrip = new Promise<never>((_, reject) => {
                tripReject = reject;
            });
            // Never an unhandled rejection: Promise.race keeps a handler attached,
            // and if execute wins first the trip is simply abandoned.
            void watchdogTrip.catch(() => {});
            this.watchdogTrips.set(runId, tripReject);
            // Close the microscopic gap where the watchdog fired between scheduling
            // the run and reaching here.
            if (this.stallFailed.has(runId)) {
                tripReject(
                    new UnrecoverableError(
                        `Run ${runId} was stopped by the stall/timeout watchdog before execution completed.`,
                    ),
                );
            }

            execPromise =
                singleStage && coverageSql && coverageMediaItemId
                    ? wrapExecute({
                          sql: coverageSql,
                          authority: this.authority,
                          signal: ctx.signal,
                          stageId: singleStage.id,
                          pluginId: task.id,
                          mediaItemId: coverageMediaItemId,
                          runId,
                          // Per-STAGE version: a multi-stage task's stages move
                          // independently, and this row belongs to one of them.
                          processingVersion: stageProcessingVersion(task, singleStage),
                          inner: runExecute,
                          retryPolicy: singleStage.retryPolicy,
                          onRetryExhausted: () => {
                              stageRetriesExhausted = true;
                          },
                          currentAttempt: (job.attemptsMade ?? 0) + 1,
                          classify: (err) => classifyError(err, task),
                      })
                    : runExecute();
            // Watchdog settlement frees the queue slot, but it does not stop an
            // inline plugin continuation. Never use processJob settlement alone
            // as proof that ownership can move to another executor.
            const continuation = execPromise;
            this.executionContinuations.set(continuation, runId);
            void continuation.then(
                () => this.executionContinuations.delete(continuation),
                () => this.executionContinuations.delete(continuation),
            );
            const result = (await Promise.race([execPromise, watchdogTrip])) as TaskResult<unknown>;

            // Mid-execution fan-out — plugin returned `downstream`. Minimal
            // trampoline: log and surface as part of the result. Full
            // FlowProducer parking is a known follow-up.
            if (result?.downstream && result.downstream.length > 0) {
                await this.handleDownstream(job, runId, result.downstream);
                // Ideally the parent stays in waiting-children until all
                // children finish; today we mark completed so the run row
                // doesn't sit active forever. Full Flow-aware parking is a
                // known follow-up.
            }

            // Stop heartbeat BEFORE writing the terminal state. Otherwise
            // a heartbeat tick scheduled mid-transition can HSET the
            // active hash AFTER the terminal write, resurrecting the
            // run as 'active' until the next TTL sweep.
            this.stopHeartbeat(runId);

            // Watchdog late-return guard: if the watchdog already auto-failed
            // this run, the run is already terminal in Valkey/Postgres. Don't
            // overwrite with 'completed' — that would falsely suggest the
            // wedge resolved cleanly. The plugin's eventual result is
            // discarded.
            if (this.stallFailed.has(runId)) {
                // The watchdog already wrote a FINAL terminal ('failed'). We
                // must NOT return normally here: a returned processor makes
                // BullMQ mark the JOB 'completed', diverging from the run's
                // 'failed' state. QueueEvents would emit 'completed', a
                // FlowProducer parent would look successful, and downstream
                // pipeline children could be mis-scheduled. Throw
                // UnrecoverableError instead — BullMQ moves the job to the
                // 'failed' set WITHOUT retrying (overriding `attempts`), so the
                // job state matches the run's terminal state. The throw lands
                // in this method's own catch block, which detects the still-set
                // stallFailed flag, logs the discarded late result, and
                // releases the mutex (an UnrecoverableError never retries, so
                // the release is unconditional there).
                throw new UnrecoverableError(
                    `Run ${runId} exceeded its time budget and was stopped by the stall/timeout ` +
                        `watchdog (any late result was discarded). This is usually a slow external ` +
                        `dependency or an oversized item; the item is re-attempted on the next ` +
                        `scheduled pass. If it recurs for the same task, raise that task's timeout.`,
                );
            }

            // Resume-after-restart: a resumable run our own shutdown aborted
            // returned without finishing. Hand it to the catch below, which
            // leaves the row 'active' for the reclaim to resume.
            if (this.isShutdownInterrupted(job, runId) && !isFinishedResult(result)) {
                throw new Error(`Run ${runId} stopped by a worker shutdown before it finished`);
            }

            // active → completed.
            await this.transitionRun({
                runId,
                from: 'active',
                to: 'completed',
                extra: { completedAt: nowIso() },
            });
            await this.writeTerminalToPostgres(runId, 'completed', result, null, taskId);
            // The chain is done: nothing reads its checkpoint again.
            if (job.data.resume) {
                await clearCheckpoint(this.getClient(), job.data.resume.rootRunId);
            }
            await this.writeCostBreakdown(runId, taskId, costSpend.snapshot());
            // A completed run returns (no throw) → BullMQ never retries it →
            // always safe to release the exclusivity mutex.
            await this.releaseExclusivityKey(job);
            return result;
        } catch (err) {
            const wrapped = err instanceof Error ? err : new Error(String(err));
            // Same ordering invariant applies to the error path — kill
            // the heartbeat before we transition or the terminal write
            // can be overwritten by a still-scheduled tick.
            this.stopHeartbeat(runId);
            if (err instanceof AuthorityError) throw err;
            // Watchdog late-return guard: terminal state already written by
            // the watchdog. Don't overwrite with cancelled/failed — that
            // changes the recorded reason from "watchdog stall" to whatever
            // the wedged plugin happened to throw on its way out (often a
            // misleading abort/cancellation error).
            if (this.stallFailed.has(runId)) {
                log.warn('Watchdog-failed run produced a late throw; discarding', {
                    runId,
                    taskId,
                    err: wrapped.message,
                });
                this.clearStallFailed(runId);
                // BUG4/F2: when the watchdog trip won `Promise.race` above,
                // execPromise is the abandoned loser — it's still pending and
                // may resolve/reject later, out-of-band, with nothing left
                // attached to observe it. Attach a no-op catch so a late
                // rejection never surfaces as an unhandled rejection. Harmless
                // in the other case that lands here (execPromise itself
                // already settled — this is a second, no-op handler on an
                // already-settled promise).
                void execPromise?.catch(() => {});

                // Two callers land here:
                //   (a) the wedged plugin threw NATURALLY on its way out — a
                //       plain error BullMQ may retry per `attempts`, so release
                //       the mutex only on the final attempt; OR
                //   (b) the late-RETURN guard above rethrew an
                //       UnrecoverableError to force the job into the 'failed'
                //       set (matching the run's terminal state). BullMQ never
                //       retries an UnrecoverableError, so this is effectively
                //       the final attempt — release the mutex unconditionally
                //       or it would leak until TTL.
                if (wrapped instanceof UnrecoverableError || this.isFinalAttempt(job, task)) {
                    await this.releaseExclusivityKey(job);
                }
                throw wrapped;
            }
            // Resume-after-restart: our own graceful shutdown stopped a
            // resumable run and its handler has now unwound. Write NO terminal
            // state — the row stays 'active' (stop() DELs the run hash), the
            // reclaim on the next boot/sweep finds it and decides whether to
            // resume (run-resume.ts). The marker below is the proof the
            // handler really stopped; without it (SIGKILL before this line, a
            // crash, a wedge) the run is never resumed. The exclusivity key
            // stays claimed too: the reclaim releases it right before it
            // starts the continuing run. UnrecoverableError: BullMQ must not
            // retry this job (its run hash is gone — a retry could only fail).
            // A TaskError the handler explicitly marked permanent/fatal on its
            // way out is a real failure: it must not be resumed and masked as
            // restart churn. Anything else thrown after our own abort (an
            // AbortError, a closed connection, the sentinel above) is the
            // interruption itself.
            const explicitlyFatal = wrapped instanceof TaskError && wrapped.kind !== 'transient';
            if (this.isShutdownInterrupted(job, runId) && !explicitlyFatal) {
                void execPromise?.catch(() => {});
                await this.recordShutdownInterrupt(runId, taskId);
                throw new UnrecoverableError(
                    `orphaned_at_recovery: run ${runId} was interrupted by a worker shutdown and waits for the reclaim to resume it`,
                );
            }
            // Honour cancellation: if AbortSignal tripped, treat as cancelled.
            if (abort.signal.aborted) {
                await this.transitionRun({
                    runId,
                    from: 'active',
                    to: 'cancelled',
                    extra: {
                        cancelledAt: nowIso(),
                        errorMessage: wrapped.message,
                    },
                });
                await this.writeTerminalToPostgres(runId, 'cancelled', null, {
                    message: wrapped.message,
                    kind: 'transient',
                    // `wrapped` is a REAL thrown Error here, so a stack exists —
                    // record it. Without it an operator sees only "aborted",
                    // never where. It is stripped from `GET /runs/{id}` and
                    // served only by the admin-gated `/runs/{id}/diagnostics`.
                    stack: wrapped.stack,
                });
                // Cancellation is terminal; reseed refuses any queued retry.
                await this.releaseExclusivityKey(job);
                throw wrapped;
            }
            const kind = classifyError(wrapped, task);
            if (kind === 'transient' && !stageRetriesExhausted && !this.isFinalAttempt(job, task)) {
                const retry = await this.transitionRun({
                    runId,
                    from: 'active',
                    to: 'pending',
                    extra: { ownerInstanceId: '', ownerBootId: '', heartbeatAt: 0 },
                });
                if (retry.ok) {
                    const sql = this.getSql();
                    if (sql)
                        await withExistingTaskWrite(sql, this.authority, async (tx) => {
                            await tx`
                            UPDATE task_history
                            SET state = 'pending', heartbeat_at = NULL, owner_instance_id = NULL
                            WHERE id = ${runId} AND state IN ('active', 'pending')
                        `;
                        });
                    // No terminal event, webhook, alert, or circuit sample:
                    // this attempt is waiting for BullMQ's configured backoff.
                    throw wrapped;
                }
                if ((await this.readRunStateForRecovery(runId)) !== 'cancelling') throw wrapped;
            }
            const failedResult = await this.transitionRun({
                runId,
                from: 'active',
                to: 'failed',
                extra: {
                    failedAt: nowIso(),
                    errorMessage: wrapped.message,
                    errorKind: kind,
                },
            });
            if (!failedResult.ok) {
                // F7 — Plugin threw at the same instant a cancel pubsub arrived,
                // and the cancel landed in Valkey first (state='cancelling').
                // Lua active→failed rejects with state-mismatch. If we blindly
                // wrote 'failed' to Postgres it would overwrite the 'cancelling'
                // row (the UPDATE only excludes terminal states), producing the
                // wrong final state. Re-read the current state and pick the
                // correct terminal:
                //
                //   cancelling          → do cancelling→cancelled, write 'cancelled'
                //   active (Lua glitch) → retain original failed-write behavior
                //   already terminal    → no-op (preserve whatever landed)
                const current = await this.readRunStateForRecovery(runId);
                if (current === 'cancelling') {
                    const cancelResult = await this.transitionRun({
                        runId,
                        from: 'cancelling',
                        to: 'cancelled',
                        extra: {
                            cancelledAt: nowIso(),
                            errorMessage: wrapped.message,
                        },
                    });
                    if (cancelResult.ok) {
                        await this.writeTerminalToPostgres(runId, 'cancelled', null, {
                            message: wrapped.message,
                            kind: 'transient',
                            // Same as the abort branch above: `wrapped` is the
                            // plugin's real thrown Error, so its stack is the
                            // only record of where the F7 race caught it.
                            stack: wrapped.stack,
                        });
                        await this.releaseExclusivityKey(job);
                        throw wrapped;
                    }
                    // cancelling→cancelled also rejected (e.g. hard-kill already
                    // wrote cancelled while we were in flight). Fall through to
                    // emit a transition-conflict but skip the Postgres clobber —
                    // the terminal write would only run if state weren't already
                    // terminal, so just log and rethrow.
                    log.warn(
                        'cancelling→cancelled rejected after plugin throw — leaving state untouched',
                        {
                            runId,
                            error: cancelResult.error,
                        },
                    );
                    // Run is already terminal (hard-kill won the race); throw
                    // path → release the mutex only on the final attempt.
                    if (this.isFinalAttempt(job, task)) await this.releaseExclusivityKey(job);
                    throw wrapped;
                }
                if (current === 'completed' || current === 'failed' || current === 'cancelled') {
                    // Already terminal — don't clobber. Just rethrow so BullMQ
                    // records the attempt; the terminal state already landed
                    // through another path (hard-kill, boot recovery, etc).
                    log.warn(
                        'active→failed rejected and state already terminal — preserving existing terminal',
                        {
                            runId,
                            currentState: current,
                        },
                    );
                    // Already terminal via another path; throw path → release
                    // the mutex only on the final attempt.
                    if (this.isFinalAttempt(job, task)) await this.releaseExclusivityKey(job);
                    throw wrapped;
                }
                // Either current === 'active' (Lua glitch / re-read race) or
                // null (hash missing). Fall through to the original failed-write
                // so behavior is unchanged for non-cancel races.
            }
            await this.writeTerminalToPostgres(
                runId,
                'failed',
                null,
                {
                    message: wrapped.message,
                    kind,
                    stack: wrapped.stack,
                    remediation: (wrapped as { remediation?: 'identity' | 'operational' })
                        .remediation,
                },
                taskId,
            );
            // A 'permanent'/'fatal' classification means the error can never
            // succeed on retry — but rethrowing the raw `wrapped` here still
            // counts against BullMQ's `attempts`, so the job gets retried
            // anyway (the classification was recorded but never enforced).
            // Throw UnrecoverableError instead: BullMQ moves the job straight
            // to 'failed', bypassing `attempts`. That makes this the final
            // attempt unconditionally, so release the exclusivity mutex here
            // too — same reasoning as the stallFailed branch above
            // (~2019-2031). Leave the 'transient' path untouched below.
            if (kind !== 'transient' || stageRetriesExhausted) {
                await this.releaseExclusivityKey(job);
                const unrecoverable = new UnrecoverableError(wrapped.message);
                // Preserve the original error for diagnostics/log correlation.
                unrecoverable.cause = wrapped;
                throw unrecoverable;
            }
            // Throw path → only release the mutex on the final attempt so a
            // pending retry keeps holding it.
            if (this.isFinalAttempt(job, task)) await this.releaseExclusivityKey(job);
            throw wrapped;
        } finally {
            taskActiveRuns.dec({
                resource_class: task.resourceClass,
                instance_id: this.instanceId,
            });
            // Heartbeat is stopped on the success/failure paths above
            // BEFORE the terminal transition lands so heartbeatOnce can't
            // resurrect the active-hash TTL after we've written the
            // terminal state. This is a defensive double-stop in case
            // any new path adds a code-path that skips the explicit stop.
            this.stopHeartbeat(runId);
            progressTracker.finalize(runId, this.authority);
            // Drop the per-run cost map so it doesn't grow unbounded over
            // the runner's lifetime. cost_breakdown is already persisted
            // to Postgres above; this just releases the in-memory entry.
            this.costLedger.finalize(runId);
            this.abortControllers.delete(runId);
            this.shutdownInterrupted.delete(runId);
            this.executeStartedAt.delete(runId);
            // Drop the watchdog's terminal-release handle. The thunk it pointed
            // at was just invoked (or already invoked by the watchdog) — both are
            // idempotent — so this only frees the map entry (W1/C2).
            this.runReleases.delete(runId);
            // Drop the F2 watchdog-trip rejector. If the trip already fired it's a
            // resolved no-op; if execute() won the race it was never needed.
            this.watchdogTrips.delete(runId);
            this.softAbortControllers.delete(runId);
            // BUG2: the run reached a terminal state, so the cancel grace
            // timer (if armed) no longer has anything to protect — clear it
            // so it doesn't fire a stray terminate() against a future run
            // that happens to reuse this runId's map slot, and so it doesn't
            // needlessly linger.
            const graceTimer = this.cancelGraceTimers.get(runId);
            if (graceTimer) {
                clearTimeout(graceTimer);
                this.cancelGraceTimers.delete(runId);
            }
            const unsub = this.cancelUnsubs.get(runId);
            this.cancelUnsubs.delete(runId);
            if (unsub) {
                try {
                    await unsub();
                } catch {
                    // best-effort
                }
            }
            // Release maxConcurrent slot on every terminal path. The helper
            // is idempotent — early-return paths above already called it.
            await releaseConcurrent();
        }
    }

    // -- resume after restart (run-resume.ts) --------------------------------

    /**
     * True when a resumable run must not execute again under its own id: its
     * handler was stopped by a graceful shutdown (marker present) or the
     * reclaim has already ended it. A lookup error THROWS (transient): the
     * no-op return is only for a positive finding — swallowing a fresh run on
     * a Valkey/Postgres blip would end it 'completed' without a trace.
     */
    private async isInterruptedOrReclaimed(runId: string): Promise<boolean> {
        try {
            const marker = await this.getClient().customCommand([
                'EXISTS',
                interruptMarkerKey(runId),
            ]);
            if (Number(marker) > 0 || marker === true) return true;
            const sql = this.getSql();
            if (!sql) return false;
            const rows = await sql<{ id: string }[]>`
                SELECT id FROM task_history
                WHERE id = ${runId}
                  AND (
                      state = 'cancelled'
                      OR (
                          state = 'failed'
                          AND (
                              error->>'message' LIKE '%orphan%_at_recovery%'
                              OR error->>'message' LIKE 'Not resumed:%'
                              OR error->>'message' LIKE 'Stopped after %'
                          )
                      )
                  )
            `;
            return rows.length > 0;
        } catch (err) {
            throw new TaskError({
                message: `Resume guard lookup failed for run ${runId}: ${errMessage(err)}`,
                kind: 'transient',
            });
        }
    }

    /** A resumable run that THIS instance's graceful stop() aborted. */
    private isShutdownInterrupted(job: RunnerJob, runId: string): boolean {
        return (
            (this.stopped || this.claimsHalted) &&
            this.shutdownInterrupted.has(runId) &&
            !!job.data.resume
        );
    }

    /**
     * Write the "handler stopped because of a graceful shutdown" marker the
     * reclaim requires before it resumes a run. Best-effort: if it fails the
     * run is simply not resumed (the safe direction).
     */
    private async recordShutdownInterrupt(runId: string, taskId: string): Promise<void> {
        this.stopHeartbeat(runId);
        try {
            await invokeOwnedCommand(
                [
                    'SET',
                    interruptMarkerKey(runId),
                    JSON.stringify({
                        instanceId: this.instanceId,
                        at: nowIso(),
                        // How long the handler actually executed — the reclaim's
                        // crash-loop window measures this, not queue/backoff time.
                        executedMs: Math.max(
                            0,
                            Date.now() - (this.executeStartedAt.get(runId) ?? Date.now()),
                        ),
                    }),
                    'PX',
                    String(INTERRUPT_MARKER_TTL_MS),
                ],
                this.getClient(),
                this.authority,
            );
            log.info('Shutdown: resumable run left for resume after restart', { runId, taskId });
        } catch (err) {
            log.warn('Shutdown: interrupt marker write failed — run will not be resumed', {
                runId,
                taskId,
                err: errMessage(err),
            });
        }
    }

    // -- context construction ------------------------------------------------

    private buildContextWithCost(
        task: TaskDefinition,
        job: RunnerJob,
        abort: AbortController,
    ): { ctx: TaskContext; costSpend: ReturnType<CostLedger['create']> } {
        const runId = job.data.runId;
        const childLogger: PluginLogger = adaptLoggerWithBuffer(
            Logger.for('TaskRunner').child(`${task.id}:${runId}`),
            runId,
        );
        // The real handle (or the 'unavailable' stub when the DB is unconfigured
        // in test/degraded boot). The SCOPED data surfaces (catalog / mediaItems
        // / mediaFiles) are always built from this real handle — they are the
        // intended safe alternative to raw SQL and are not gated here.
        const realSql = this.getSql() ?? buildUnavailableSqlStub();
        // RAW `ctx.sql` is gated on the declared `database` capability, exactly
        // like http/cache/ffmpeg below: a task that did NOT declare
        // `capabilities.database` must not receive a live Postgres handle —
        // closing the gap where the declared capability was advisory only. It
        // still gets a throwing stub (the type is non-optional) so an undeclared
        // touch fails loudly + actionably rather than silently running arbitrary
        // SQL.
        const sql = task.capabilities?.database
            ? realSql
            : buildUnavailableSqlStub(
                  `Task '${task.id}' accessed ctx.sql but did not declare ` +
                      `capabilities.database — add { capabilities: { database: true } } ` +
                      `to its defineTask manifest.`,
                  'permanent',
              );
        const mode = (job.data.mode ?? 'manual') as TaskContext['mode'];

        // Bind instance methods up-front so the context closures don't alias
        // `this` (avoids the no-this-alias lint rule).
        const loadSettings = this.loadPluginSettings.bind(this);
        const recordFailure = this.recordPluginFailure.bind(this);
        const resolveFailures = this.resolvePluginFailures.bind(this);
        const secretsStore = this.secretsStore;
        const rateLimiter = this.rateLimiter;
        const costSpend = this.costLedger.create(runId);
        const reportProgress = progressTracker.create(runId, 'main', this.authority);

        // Soft-deadline controller — aborted by the wall-clock watchdog at
        // `timeout.soft` (see checkRunDeadline). Distinct from `abort`
        // (cancellation): firing it does NOT cancel the run, it just lets a
        // handler wind down gracefully before the hard cap. Surfaced as
        // `ctx.softSignal`. Cleaned up alongside the cancel controller.
        const softAbort = new AbortController();
        this.softAbortControllers.set(runId, softAbort);

        const ctx: TaskContext = {
            runId,
            parentRunId: job.data.parentRunId,
            attemptNumber: (job.attemptsMade ?? 0) + 1,
            input: job.data.input,
            scope: job.data.scope ?? {},
            mode,

            sql,
            logger: childLogger,
            signal: abort.signal,
            abortSignal: abort.signal,
            softSignal: softAbort.signal,

            // `ctx.http` for tasks gets a DEFAULT per-task rate cap (TASK-C6).
            // TaskDefinition has no per-context `rateLimit` field — only
            // `externalDeps[].rps` for the `ctx.dep()` surface (enforced by
            // RateLimiter). Without a default, a task could hammer an upstream
            // API in a tight loop, and the aggregate outbound rate across
            // replicas was unbounded. We bind a per-task token bucket keyed by
            // `http-default:<taskId>` at LUMASTRA_TASK_HTTP_DEFAULT_RPS (shared
            // cross-replica via the Valkey shared bucket). This is a guardrail,
            // not a per-provider budget — tasks needing a tighter limit declare
            // `externalDeps` and use `ctx.dep(name).fetch()`. Operators can
            // disable the cap by setting LUMASTRA_TASK_HTTP_DEFAULT_RPS=0.
            // Per-provider enforcement for non-task callers lives in
            // `buildPluginContext` (see plugin-context.ts).
            http: task.capabilities?.http
                ? buildHttpClient(
                      childLogger,
                      abort.signal,
                      LUMASTRA_TASK_HTTP_DEFAULT_RPS > 0
                          ? {
                                providerId: `http-default:${task.id}`,
                                rateLimit: {
                                    rps: LUMASTRA_TASK_HTTP_DEFAULT_RPS,
                                },
                            }
                          : undefined,
                      task.capabilities.allowedDomains,
                  )
                : undefined,
            cache: task.capabilities?.cache ? buildNamespacedCache(task.id) : undefined,
            checkpoint: job.data.resume
                ? buildRunCheckpoint(() => this.getClient(), job.data.resume.rootRunId, childLogger)
                : undefined,

            dep: (name: string): RateLimitedFetch => {
                const depCfg = task.externalDeps?.find((d) => d.name === name);
                return rateLimiter.forDep(name, depCfg ?? {});
            },
            settings: async () => loadSettings(task.id),
            secrets: {
                get: (key: string) => secretsStore.get(task.id, key, runId),
                getOptional: (key: string) => secretsStore.getOptional(task.id, key, runId),
                getUser: (userId: string, key: string) =>
                    secretsStore.getUser(task.id, userId, key, runId),
            },
            userCredentials: buildUserCredentialStore(task.id, secretsStore),
            // Scoped data surfaces use the REAL handle regardless of the
            // `database` capability — only raw `ctx.sql` above is gated.
            catalog: buildCatalogStore(realSql),
            mediaItems: buildMediaItemsStore(realSql),
            mediaFiles: buildMediaFilesStore(realSql),
            playlists: buildPlaylistStore(realSql, task.id),
            mediaSegments: buildMediaSegmentStore(realSql, task.id),

            reportProgress,
            reportFailure: async (itemId: string, reason: string, meta?: object) => {
                await recordFailure(task.id, runId, itemId, reason, meta);
            },
            reportSuccess: async (itemId: string) => {
                await resolveFailures(task.id, itemId);
            },
            spend: (kind: CostKind, units: number) => {
                costSpend.spend(kind, units);
            },
            drain: async (_opts?: { mode?: DrainMode }): Promise<DrainResult> => {
                // Not yet available. Surface a clear, author-facing message
                // (the old 'Task J/L' internal-milestone text was opaque to
                // external plugin authors) and a 'permanent' kind so the run
                // fails deterministically rather than via the internal 'fatal'.
                throw new TaskError({
                    message:
                        'ctx.drain() is not available in this Lumastra version — ' +
                        'implement chunked draining inside execute() instead. ' +
                        'Track support on the task-system roadmap.',
                    kind: 'permanent',
                });
            },
        };
        return { ctx, costSpend };
    }

    // -- plugin worker-thread isolation --------------------------------------

    /**
     * True when the flag is on, the task opted into worker isolation, AND the
     * sandbox bundle is present. When the flag + opt-in are set but the bundle
     * is missing (e.g. `npm run dev` without `build:sandbox`), we warn once and
     * fall back to the in-process path so default-ON isolation never fails a run
     * outright.
     */
    private isolationEnabled(task: TaskDefinition<unknown, unknown>): boolean {
        if (!this.isolationFlag || task.isolation !== 'worker') return false;
        if (!this.isolationBundleAvailable) {
            if (!this.warnedIsolationBundleMissing) {
                this.warnedIsolationBundleMissing = true;
                log.warn(
                    'Worker isolation is enabled but the sandbox bundle is missing — ' +
                        'falling back to in-process execution. Run `npm run build:sandbox` ' +
                        '(included in `npm run build`) to enable worker isolation.',
                    { entryPath: this.isolationEntryPath },
                );
            }
            return false;
        }
        return true;
    }

    private checkpointPressure:
        { expires: number; value: ReturnType<typeof getPlaybackPressure> } | undefined;

    private readCheckpointPressure(): ReturnType<typeof getPlaybackPressure> {
        if (!this.checkpointPressure || this.checkpointPressure.expires <= Date.now()) {
            this.checkpointPressure = {
                expires: Date.now() + 1000,
                value: getPlaybackPressure(() => this.getClient()),
            };
        }
        return this.checkpointPressure.value;
    }

    private playbackSlots = new Map<string, PlaybackCpuSlot>();
    private playbackAdmitted = new Set<string>();
    private playbackWaits = new Map<string, { since: number; users: number }>();

    private async playbackCheckpoint(runId: string, signal: AbortSignal): Promise<void> {
        const job = this.executingQueueJobs.get(runId);
        const task = job ? this.registry.getTask(job.name) : undefined;
        if (
            playbackCpuExempt(
                task?.id ?? '',
                job?.data.playbackCpuExempt || isExpressPriority(job?.opts?.priority),
            )
        )
            return;
        const firstAt = job?.data.playbackDeferredAt ?? Date.now();
        while (
            !signal.aborted &&
            !playbackDeferralExpired(job?.data.playbackDeferredAt ?? firstAt) &&
            (await this.readCheckpointPressure()).paused
        ) {
            if (this.playbackSlots.has(runId)) break;
            const slot = await acquirePlaybackCpuSlot(
                () => this.getClient(),
                `${this.instanceId}:${runId}:${ulid()}`,
            );
            if (slot) {
                this.playbackSlots.set(runId, slot);
                break;
            }
            if (job && job.data.playbackDeferredAt === undefined) {
                try {
                    await job.updateData({ ...job.data, playbackDeferredAt: firstAt });
                } catch {
                    break;
                } // Task Valkey unavailable: fail open.
            }
            await recordPlaybackDeferral(() => this.getClient(), runId, firstAt);
            let wait = this.playbackWaits.get(runId);
            if (!wait) {
                wait = { since: Date.now(), users: 0 };
                this.playbackWaits.set(runId, wait);
            }
            wait.users++;
            try {
                await delay(PRESSURE_RETRY_MS, undefined, { signal });
            } finally {
                wait.users--;
                if (wait.users === 0) {
                    const deadline = this.runDeadlines.get(runId);
                    if (deadline) deadline.startedAtMs += Math.max(0, Date.now() - wait.since);
                    this.playbackWaits.delete(runId);
                }
            }
        }
        signal.throwIfAborted();
    }

    /**
     * Run `execute(ctx)` in an isolated worker thread. The returned promise
     * settles exactly like an in-process `task.execute(ctx)` (resolves with the
     * TaskResult; rejects with a rehydrated `TaskError`/`Error` so the runner's
     * existing catch + `classifyError` retry semantics are unchanged). The live
     * run is tracked so `autoFailRun` can `terminate()` a wedged thread.
     */
    private executeIsolated(
        task: TaskDefinition<unknown, unknown>,
        job: RunnerJob,
        ctx: TaskContext,
        abort: AbortController,
    ): Promise<unknown> {
        const runId = job.data.runId;
        const run = executeInWorker({
            entryPath: this.isolationEntryPath,
            workerData: this.buildSandboxWorkerData(task, job),
            env: buildIsolationEnv(),
            hooks: {
                ...this.buildIsolationHooks(ctx),
                backgroundCpuCheckpoint: () =>
                    isBackgroundCpuTask(task.resourceClass, task.id)
                        ? this.playbackCheckpoint(runId, abort.signal)
                        : Promise.resolve(),
            },
            signal: abort.signal,
            // Relay the soft-deadline so an isolated handler also gets ctx.softSignal.
            softSignal: this.softAbortControllers.get(runId)?.signal,
            spawn: this.spawnIsolationWorker,
        });
        this.isolationRuns.set(runId, run);
        return run.result.finally(() => {
            this.isolationRuns.delete(runId);
        });
    }

    private buildSandboxWorkerData(
        task: TaskDefinition<unknown, unknown>,
        job: RunnerJob,
    ): SandboxWorkerData {
        const caps = task.capabilities ?? {};
        return {
            runId: job.data.runId,
            taskId: task.id,
            parentRunId: job.data.parentRunId,
            attemptNumber: (job.attemptsMade ?? 0) + 1,
            input: job.data.input,
            scope: job.data.scope ?? {},
            mode: (job.data.mode ?? 'manual') as string,
            capabilities: {
                http: !!caps.http,
                cache: !!caps.cache,
                ffmpeg: !!caps.ffmpeg,
                dataDir: !!caps.dataDir,
                database: !!caps.database,
                allowedDomains: caps.allowedDomains,
            },
            dbPoolMax: LUMASTRA_ISOLATION_DB_POOL_MAX,
        };
    }

    /**
     * Adapt the runner's in-process `ctx` to the host-RPC hook surface. Every
     * call lands on the SAME secrets store / cost ledger / progress tracker /
     * log buffer the in-process path uses — no duplicated business logic, and
     * decryption stays main-side (the worker never holds the master key).
     */
    private buildIsolationHooks(ctx: TaskContext): IsolationHostHooks {
        const uc = ctx.userCredentials;
        return {
            secretsGet: (key) => ctx.secrets.get(key),
            secretsGetOptional: (key) => ctx.secrets.getOptional(key),
            secretsGetUser: (userId, key) => ctx.secrets.getUser(userId, key),
            settings: () => ctx.settings(),
            cacheGet: (key) => (ctx.cache ? ctx.cache.get(key) : Promise.resolve(null)),
            cacheSet: (key, value, ttlMs) =>
                ctx.cache ? ctx.cache.set(key, value, ttlMs) : Promise.resolve(),
            cacheDel: (key) => (ctx.cache ? ctx.cache.del(key) : Promise.resolve()),
            reportFailure: (itemId, reason, meta) => ctx.reportFailure(itemId, reason, meta),
            reportSuccess: (itemId) => ctx.reportSuccess(itemId),
            ucGet: (userId, key) => uc.get(userId, key),
            ucSet: (userId, key, value, opts) => uc.set(userId, key, value, opts),
            ucDelete: (userId, key) => uc.delete(userId, key),
            ucListKeys: (userId) => uc.listKeys(userId),
            ucListLinkedUsers: () => uc.listLinkedUsers(),
            ucListUsersWithKey: (key) => uc.listUsersWithKey(key),
            log: (level, msg, meta) => ctx.logger[level](msg, meta),
            progress: (processed, total, currentItem) =>
                ctx.reportProgress(processed, total, currentItem),
            spend: (kind, units) => ctx.spend(kind, units),
            warn: (msg, meta) => log.warn(msg, meta),
        };
    }

    // -- heartbeat -----------------------------------------------------------

    private startHeartbeat(
        runId: string,
        task: TaskDefinition<unknown, unknown>,
        budgetStartMs?: number,
    ): void {
        const now = Date.now();
        // Seed lastHeartbeatSuccessAt at startup so the first watchdog window
        // measures from claim-time, not zero (which would always trip). The
        // STALL watchdog is intentionally per-attempt — a freshly re-delivered
        // worker really is beating now — so this always uses `now`, never the
        // persisted start.
        this.lastHeartbeatSuccessAt.set(runId, now);
        // Record wall-clock deadlines so the heartbeat tick can also enforce
        // task.timeout.hard. Without this, a hung handler whose runner-side
        // heartbeat keeps ticking (heartbeatOnce HSETs Valkey itself; the
        // handler's progress is not consulted) stays "active" forever — the
        // exact symptom of the preprod 6.5h series-sync stuck run. The hard
        // limit becomes a true wall-clock cap; the soft limit emits a
        // one-shot warning so a cooperative handler can wind down early.
        // Tasks without declared timeouts get DEFAULT_HARD_TIMEOUT_MS — large
        // enough that today's long-running chunked-drain tasks (e.g.
        // library-embeddings) aren't disrupted, but bounded so a never-
        // terminating handler can't camp on a worker slot indefinitely.
        // Honor the declared `timeout.hard` at its true value. The wall-clock
        // watchdog runs on a DEDICATED sampler below whose period is decoupled
        // from `heartbeatIntervalMs`, so a hard cap shorter than the heartbeat
        // interval (e.g. 10s hard with a 30s heartbeat) still fires on time
        // instead of being effectively rounded up to the next heartbeat tick
        // (F85). No upward clamp.
        const hardMs = parseDurationMs(task.timeout?.hard) ?? DEFAULT_HARD_TIMEOUT_MS;
        const softDeclared = parseDurationMs(task.timeout?.soft);
        // Derive soft as `max(hard - 60s, floor(hard * 0.9))` — both branches
        // give "a meaningful warn-before-kill window". For small hard caps
        // the first branch can produce a negative/zero value; clamp at 0 so
        // the comparison in heartbeatOnce stays well-defined (the warning
        // simply fires on the first eligible tick).
        const softMs =
            softDeclared !== null && softDeclared > 0 && softDeclared < hardMs
                ? softDeclared
                : Math.max(0, Math.max(hardMs - 60_000, Math.floor(hardMs * 0.9)));
        // Anchor the wall-clock budget to the run's TRUE execution start
        // (resolved from the durable run state by the caller), not this
        // attempt's pickup time. On a BullMQ re-delivery after an ungraceful
        // worker death, processJob runs again for the SAME runId; seeding from
        // `now` here would reset the hard-timeout clock on every re-delivery,
        // so a run that has genuinely been alive for hours could never trip its
        // declared `timeout.hard`. `budgetStartMs` is the original execution
        // start (Valkey active-hash `startedAt`, with a durable Postgres
        // `started_at` fallback for runs whose hash has aged out). Fall back to
        // `now` when it is missing (a genuine first attempt) or in the future
        // (clock skew) so a run is NEVER instantly failed on its first pickup.
        const startedAtMs =
            budgetStartMs !== undefined && Number.isFinite(budgetStartMs) && budgetStartMs <= now
                ? budgetStartMs
                : now;
        this.runDeadlines.set(runId, {
            startedAtMs,
            hardMs,
            softMs,
            softWarned: false,
            taskId: task.id,
        });
        // Record the concurrency-counter keys whose TTL each beat refreshes.
        // The per-task counter always exists; the class budget key only when
        // the per-task-queue path is on (the sole path on which `acquireBudget`
        // takes a token). `task.resourceClass` is already the PHYSICAL class
        // (rewritten by the registry's legacy-class shim), so this is the EXACT
        // key `acquireClassBudget` incremented — not the raw SDK resourceClass.
        this.heartbeatTtlKeys.set(runId, {
            activeCountKey: `task:active-count:${task.id}`,
            budgetKey: this.perTaskQueues ? `task:resource-budget:${task.resourceClass}` : null,
        });
        const timer = setInterval(() => {
            void this.heartbeatOnce(runId);
        }, this.heartbeatIntervalMs);
        if (typeof timer.unref === 'function') timer.unref();
        this.heartbeats.set(runId, timer);

        // Dedicated wall-clock deadline sampler, decoupled from the heartbeat
        // cadence (F85). Sampling at `min(heartbeatIntervalMs, hardMs)` keeps
        // the Valkey/Postgres heartbeat at its normal (cheap) cadence while
        // letting a short hard cap fire close to its declared value rather than
        // waiting for the next heartbeat tick. Capped at 1ms so a degenerate
        // sub-millisecond hard cap can't spin a zero-delay interval.
        const samplePeriodMs = Math.max(1, Math.min(this.heartbeatIntervalMs, hardMs));
        const deadlineTimer = setInterval(() => {
            void this.checkRunDeadline(runId, Date.now());
        }, samplePeriodMs);
        if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
        this.deadlineTimers.set(runId, deadlineTimer);
    }

    private stopHeartbeat(runId: string): void {
        const timer = this.heartbeats.get(runId);
        if (timer) {
            clearInterval(timer);
            this.heartbeats.delete(runId);
        }
        const deadlineTimer = this.deadlineTimers.get(runId);
        if (deadlineTimer) {
            clearInterval(deadlineTimer);
            this.deadlineTimers.delete(runId);
        }
        this.lastHeartbeatSuccessAt.delete(runId);
        this.stallWarned.delete(runId);
        this.lockLostHits.delete(runId);
        this.runDeadlines.delete(runId);
        this.heartbeatTtlKeys.delete(runId);
        // Intentionally NOT clearing stallFailed here — the late return path
        // for the wedged plugin still needs to see it to skip its terminal
        // write. It is cleared in clearStallFailed() once the execute()
        // promise resolves (either by abort or natural return).
    }

    /**
     * Clear the stallFailed flag after the wedged plugin's late return has
     * been observed. Called from the execute() result/catch handlers so the
     * Set doesn't grow unbounded across long-running workers.
     */
    private clearStallFailed(runId: string): void {
        this.stallFailed.delete(runId);
    }

    /**
     * Wall-clock timeout watchdog. Independent of heartbeat freshness —
     * heartbeatOnce HSETs Valkey ITSELF, so a handler that's wedged on a
     * blocking syscall can still have a "fresh" heartbeat. Without this
     * check, task.timeout.{hard,soft} is documentation-only. See the
     * runDeadlines field doc for the symptom this prevents.
     *
     * Runs on a dedicated timer whose period is decoupled from
     * `heartbeatIntervalMs` so a declared `timeout.hard` shorter than the
     * heartbeat interval (e.g. 10s hard with a 30s heartbeat) fires at its
     * true value instead of being effectively rounded up to the next
     * heartbeat tick. Returns `true` when the run was auto-failed so the
     * caller can short-circuit.
     */
    private async checkRunDeadline(runId: string, nowMs: number): Promise<boolean> {
        const deadline = this.runDeadlines.get(runId);
        if (!deadline) return false;
        // Clamp at 0 to defend against NTP backward steps mid-run. A
        // negative elapsedMs would make BOTH `>= softMs` and `>= hardMs`
        // false on every subsequent tick until the clock recovers,
        // effectively pausing the wall-clock cap — but it would also
        // make the soft-warn flag's "first eligible tick" never trigger.
        // Treat a backward step as "no time passed" rather than "time
        // went negative", so the cap eventually still fires.
        const waiting = this.playbackWaits.get(runId);
        const elapsedMs = Math.max(
            0,
            nowMs - deadline.startedAtMs - (waiting ? nowMs - waiting.since : 0),
        );
        if (!deadline.softWarned && elapsedMs >= deadline.softMs && elapsedMs < deadline.hardMs) {
            deadline.softWarned = true;
            log.warn('Soft-timeout: handler approaching declared hard cap', {
                runId,
                taskId: deadline.taskId,
                elapsedMs,
                softMs: deadline.softMs,
                hardMs: deadline.hardMs,
            });
            // Fire ctx.softSignal so a handler can wind down gracefully before the
            // hard cap. This does NOT cancel the run (distinct controller) — a
            // handler that ignores it simply runs to the hard cap as before.
            const soft = this.softAbortControllers.get(runId);
            if (soft && !soft.signal.aborted) {
                try {
                    soft.abort(new Error('soft-timeout: winding down before hard cap'));
                } catch {
                    // ignore — signal already aborted
                }
            }
        }
        if (elapsedMs >= deadline.hardMs && !this.stallFailed.has(runId)) {
            await this.autoFailRun(
                runId,
                'watchdog-timeout-hard',
                `Handler exceeded task.timeout.hard (${Math.round(deadline.hardMs / 1000)}s); wall-clock watchdog marked the run failed.`,
                `Handler runtime ${Math.round(elapsedMs / 1000)}s exceeded hard timeout`,
            );
            return true;
        }
        return false;
    }

    private async heartbeatOnce(runId: string): Promise<void> {
        const nowMs = Date.now();

        // Stall watchdog: if the last successful heartbeat is older than the
        // boot-recovery orphan threshold (effectively 2 min), log once so
        // operators can correlate the stall with whatever the worker was
        // doing — see `lastHeartbeatSuccessAt` declaration for context.
        const lastSuccess = this.lastHeartbeatSuccessAt.get(runId);
        if (
            typeof lastSuccess === 'number' &&
            nowMs - lastSuccess > LUMASTRA_RUN_STALL_WARN_MS &&
            !this.stallWarned.has(runId)
        ) {
            this.stallWarned.add(runId);
            log.warn('Heartbeat stalled — no successful beat in >2 min', {
                runId,
                staleForMs: nowMs - lastSuccess,
            });
        }

        // Wall-clock timeout watchdog runs on its OWN timer (see
        // `startHeartbeat`), decoupled from the heartbeat cadence so a
        // declared `timeout.hard` shorter than `heartbeatIntervalMs` is
        // honored at its true value rather than being effectively rounded
        // up to the next heartbeat tick. Sample it here too so a hard cap
        // never depends solely on the dedicated timer firing.
        if (await this.checkRunDeadline(runId, nowMs)) {
            return;
        }

        // Auto-fail: if the stall has persisted past LUMASTRA_RUN_STALL_FAIL_MS
        // (default 10 min), give up on the run. The plugin's execute() is
        // still running — most likely wedged on a blocking syscall (NFS, DNS,
        // a forgotten timeout). We can't kill the thread, but we can mark the
        // run terminal so the admin UI stops showing it as active and so the
        // BullMQ stalled-check + boot recovery don't pick it up later. Setting
        // stallFailed guarantees the late return path skips its own terminal
        // write. We also abort the controller; the plugin code is unlikely to
        // honor it (that's why it's stuck) but if any inner await actually
        // checks `ctx.signal.aborted` it can unstick itself.
        if (
            typeof lastSuccess === 'number' &&
            nowMs - lastSuccess > LUMASTRA_RUN_STALL_FAIL_MS &&
            !this.stallFailed.has(runId)
        ) {
            const staleForMs = nowMs - lastSuccess;
            log.error('Heartbeat watchdog auto-failing stalled run', undefined, {
                runId,
                staleForMs,
                stallFailMs: LUMASTRA_RUN_STALL_FAIL_MS,
            });
            await this.autoFailRun(
                runId,
                'watchdog-stall-auto-fail',
                `Heartbeat stalled for ${Math.round(staleForMs / 1000)}s; runner watchdog marked the run failed.`,
                `Heartbeat stalled for ${Math.round(staleForMs / 1000)}s`,
            );
            return;
        }

        let valkeyOk = false;
        try {
            const client = this.getClient();
            await invokeOwnedCommand(
                ['HSET', `task:run:active:${runId}`, 'heartbeatAt', String(nowMs)],
                client,
                this.authority,
            );
            await invokeOwnedCommand(
                ['PEXPIRE', `task:run:active:${runId}`, String(LUMASTRA_RUN_STATE_TTL_ACTIVE_MS)],
                client,
                this.authority,
            );
            const job = this.runReleases.get(runId)?.job;
            const task = job && this.registry.getTask(job.name);
            if (job && task) await this.refreshExclusivityKey(job, task);
            valkeyOk = true;
            // Refresh the TTL backstop on this run's concurrency counters so a
            // long-running task (heartbeat ~30s, TTL 300s) never lets its
            // per-task counter OR shared class budget expire mid-run and admit
            // a worker past cap. Both calls swallow their own errors with a WARN
            // (best-effort — the next beat recovers, and a throw must not abort
            // the heartbeat) so they can't flip `valkeyOk` above. The class
            // budget key is shared across all runs in the class: any single
            // live heartbeat keeps it alive; it ages out only when every run
            // dies (the correct crash backstop).
            const ttlKeys = this.heartbeatTtlKeys.get(runId);
            if (ttlKeys) {
                await refreshSemaphoreTtl(client, ttlKeys.activeCountKey, BUDGET_TTL_SECONDS);
                if (ttlKeys.budgetKey) {
                    await refreshSemaphoreTtl(client, ttlKeys.budgetKey, BUDGET_TTL_SECONDS);
                }
            }
        } catch (err) {
            if (err instanceof UnrecoverableError) {
                log.warn('Task identity ownership lost during heartbeat', {
                    runId,
                    err: err.message,
                });
                return; // The handler is aborted; do not refresh its PG liveness.
            }
            log.warn('Valkey heartbeat failed', {
                runId,
                err: errMessage(err),
            });
        }
        // Postgres heartbeat — boot recovery's two-minute orphan threshold
        // depends on this. Write every beat (every 30s by default); cheap
        // single-row UPDATE keyed by PK. Uses the dedicated heartbeat pool
        // (getHeartbeatSql) so it can't be starved by a task that has checked
        // out the whole task pool — that starvation is what produced the
        // `write CONNECT_TIMEOUT` heartbeat failures under host I/O load.
        const sql = this.getHeartbeatSql();
        if (!sql) return;
        let postgresOk = false;
        try {
            const rows = await withExistingTaskWrite(
                sql,
                this.authority,
                async (tx) => tx<{ cancel_requested: boolean }[]>`
                    UPDATE task_history SET heartbeat_at = NOW() WHERE id = ${runId}
                    RETURNING (cancel_requested_at IS NOT NULL) AS cancel_requested
                `,
            );
            postgresOk = true;
            // Durable cancel fallback: the orchestrator records the cancel in
            // Postgres before it PUBLISHes, so a lost pub/sub message delays the
            // abort by at most one heartbeat interval instead of forever.
            const abort = this.abortControllers.get(runId);
            if (rows?.[0]?.cancel_requested === true && abort && !abort.signal.aborted) {
                log.info('Cancel seen in Postgres (no pub/sub message); aborting run', { runId });
                this.onCancelSignal(runId, abort);
            }
        } catch (err) {
            log.warn('Postgres heartbeat failed', {
                runId,
                err: errMessage(err),
            });
        }

        // Update lastSuccess when EITHER store accepted the beat. The stall
        // watchdog measures one thing: "is this worker process alive and
        // ticking the heartbeat loop?" A single landed write proves that —
        // the loop ran and reached the network. Requiring BOTH stores (the
        // old `valkeyOk && postgresOk`) conflated worker liveness with
        // backing-store availability: an intermittent single-store
        // degradation (e.g. Postgres pool exhaustion while Valkey is fine, or
        // vice-versa) would freeze `lastHeartbeatSuccessAt`, and a healthy
        // worker would be falsely warned at 2 min and auto-failed at 10 min.
        // Boot-recovery's orphan threshold reads Valkey/Postgres heartbeat
        // freshness independently and has its own three-signal liveness probe;
        // it does not depend on this in-memory flag, so OR'ing here cannot
        // mask a genuinely dead worker.
        if (valkeyOk || postgresOk) {
            this.lastHeartbeatSuccessAt.set(runId, nowMs);
            // Clear any earlier stall warning so a subsequent re-stall trips
            // a fresh warning instead of being permanently suppressed.
            this.stallWarned.delete(runId);
        }
    }

    /**
     * Shared auto-fail path for both the heartbeat-stall watchdog and the
     * wall-clock timeout watchdog. Both signal the same "the handler is
     * unrecoverable; mark it terminal without waiting for execute() to
     * return". The two reasons differ only in the recorded error reason
     * + message so post-mortem reads can tell them apart.
     *
     * Idempotent via `stallFailed.has(runId)` — callers must check before
     * invoking, OR rely on the postgres + valkey writes being safely
     * re-applied. Today callers all gate on stallFailed; this method
     * adds the runId to the set first so a concurrent tick can't double-fire.
     */
    private async autoFailRun(
        runId: string,
        reason: string,
        transitionMessage: string,
        terminalMessage: string,
    ): Promise<void> {
        this.stallFailed.add(runId);
        try {
            const abort = this.abortControllers.get(runId);
            if (abort && !abort.signal.aborted) abort.abort();
        } catch (err) {
            // best-effort cleanup
            log.warn('Watchdog abort failed', { runId, err: errMessage(err) });
        }
        // Hard-kill an isolated worker that ignored the abort (the only defence
        // against a SYNCHRONOUS busy-loop — the whole point of isolation). The
        // abort above already asked it to stop; terminate() force-kills the
        // thread after the grace window if it hasn't exited. The terminal
        // task_history write lands below regardless, and the run's stallFailed
        // flag makes the runner discard the worker's late exit-rejection.
        const isoRun = this.isolationRuns.get(runId);
        if (isoRun) {
            try {
                await isoRun.terminate(LUMASTRA_ISOLATION_TERMINATE_GRACE_MS);
                // Positive signal that the safety net actually fired — a wedged
                // isolated worker was force-killed. Only emitted on a real
                // hard-kill (abnormal), so it's cheap and is the line an operator
                // (or an OSS reviewer) points to as live proof terminate() works.
                log.warn('Watchdog hard-killed isolated worker', {
                    runId,
                    reason,
                    graceMs: LUMASTRA_ISOLATION_TERMINATE_GRACE_MS,
                });
            } catch (err) {
                // best-effort cleanup
                log.warn('Watchdog isolation terminate failed', {
                    runId,
                    err: errMessage(err),
                });
            }
        }
        try {
            // Try the canonical active → failed transition first. If the
            // run was racing a cancel signal, it may already be in
            // 'cancelling' — fall through to a second attempt from
            // 'cancelling' so the run doesn't get stranded in the
            // cancelling state when the wall-clock or heartbeat watchdog
            // fires after a cancel arrives. The state-machine Lua
            // rejects the wrong-from-state with `ok:false` rather than
            // throwing, so this is a cheap probe.
            let failResult = await this.transitionRun({
                runId,
                from: 'active',
                to: 'failed',
                extra: {
                    failedAt: nowIso(),
                    errorMessage: transitionMessage,
                    errorKind: 'transient',
                },
            });
            // If active→failed was rejected, the run was racing a cancel and is
            // already 'cancelling'. The state machine ONLY permits
            // cancelling→cancelled (transition-run.lua:21) — the previous
            // cancelling→failed probe was always rejected, stranding the run in
            // 'cancelling' forever. Drive it to its correct terminal,
            // 'cancelled', with the watchdog reason recorded.
            let terminal: 'failed' | 'cancelled' = 'failed';
            if (!failResult.ok) {
                failResult = await this.transitionRun({
                    runId,
                    from: 'cancelling',
                    to: 'cancelled',
                    extra: {
                        cancelledAt: nowIso(),
                        errorMessage: transitionMessage,
                    },
                });
                terminal = 'cancelled';
            }
            // Run could already be terminal (cancel raced, plugin returned
            // between our abort and this transition). In either case the
            // late-return path is suppressed by stallFailed so we're safe.
            if (failResult.ok) {
                await this.writeTerminalToPostgres(runId, terminal, null, {
                    message: terminalMessage,
                    kind: 'transient',
                    reason,
                });
            }
        } catch (err) {
            if (err instanceof AuthorityError) {
                this.clearStallFailed(runId);
                this.stopHeartbeat(runId);
                return;
            }
            log.warn('Watchdog auto-fail transition failed', {
                runId,
                err: errMessage(err),
            });
        }
        // W1/C2 — release the run's CONCURRENCY resources. The terminal write
        // above marks the run failed in Postgres/Valkey, but for a permanently-
        // wedged IN-PROCESS `execute()` the `finally` in processJob never runs
        // (the promise never settles), so its per-task counter, class budget
        // token, and BullMQ Worker slot would be held for the container's
        // lifetime — 100% capacity loss for a concurrency=1 analysis task. Run
        // the SAME idempotent `releaseConcurrent` thunk the normal completion
        // path uses, then free the Worker slot by firing the watchdog-trip (F2)
        // so processJob's execute race rejects and BullMQ moves the job to
        // 'failed'. An isolated worker that honoured terminate() reaches its own
        // `finally`; the thunk is idempotent, so the double-release is safe.
        // We deliberately do NOT delete the `runReleases` entry here — the
        // processJob `finally` is the single owner of that map entry; leaving it
        // lets a (theoretical) clearing-wedge path's `finally` find it. The thunk
        // having already fired makes that a no-op.
        const handle = this.runReleases.get(runId);
        if (handle) {
            try {
                await handle.release();
            } catch (err) {
                log.warn('Watchdog releaseConcurrent failed', {
                    runId,
                    err: errMessage(err),
                });
            }
            // Free the BullMQ Worker slot. Preferred (F2): settle processJob's
            // execute race so the processor promise rejects (UnrecoverableError →
            // moveToFailed → slot freed immediately, no reliance on the stalled-
            // check that the wedged job's live lock would defeat). Fall back to the
            // best-effort job.remove() ONLY when no trip is registered — a wedge
            // BEFORE the execute race was set up (pipeline setup / getChildrenValues).
            // Never do BOTH: a successful remove racing the injected moveToFailed
            // makes BullMQ log "missing key for job" worker errors.
            const trip = this.watchdogTrips.get(runId);
            if (trip) {
                trip(
                    new UnrecoverableError(
                        `Run ${runId} exceeded its time budget and was stopped by the stall/timeout ` +
                            `watchdog; its worker slot was reclaimed while the handler kept running.`,
                    ),
                );
            } else {
                await this.removeBullJobForRun(runId, handle.job);
            }
        }
        // Stop further heartbeat ticks for this run; we've already written
        // the terminal state. The execute() promise will continue to run
        // in the worker until the wedge clears or the container restarts.
        this.stopHeartbeat(runId);
    }

    /**
     * FALLBACK-ONLY (F2): drop a wedged run's BullMQ job when no watchdog-trip is
     * registered — i.e. the wedge happened BEFORE processJob set up the execute
     * race (pipeline setup / getChildrenValues). The normal in-process wedge is
     * now handled by firing the trip (autoFailRun above), which rejects the
     * processor promise → moveToFailed → the slot frees deterministically.
     *
     * NOTE on why this is only a fallback: for an active in-process job whose
     * processor promise is wedged, BullMQ's own lock-extender keeps renewing the
     * job lock for the life of the process — it is INDEPENDENT of the runner's
     * app-level heartbeat, so stopping the heartbeat does NOT make the lock lapse.
     * And `job.remove()` on an active, locked job is rejected by BullMQ. So this
     * path cannot, on its own, reliably free the slot; it is best-effort cleanup
     * for the narrow pre-trip window. Idempotent; never throws into the watchdog.
     */
    private async removeBullJobForRun(runId: string, job: RunnerJob): Promise<void> {
        try {
            assertTaskJobOrigin(this.authority, job.data?.taskAuthority, job.id);
            await withTaskQueueWrite(
                this.getSql(),
                this.authority,
                { kind: 'remove', queue: job.queueName, jobId: job.id },
                () => job.remove(),
                { allowDraining: true },
            );
            log.info('Watchdog removed BullMQ job for auto-failed run', {
                runId,
                jobId: job.id,
            });
        } catch (err) {
            // Non-fatal — best-effort only (see docblock). The normal in-process
            // wedge path is the watchdog-trip in autoFailRun, not this remove().
            log.warn('Watchdog could not remove BullMQ job for auto-failed run', {
                runId,
                jobId: job.id,
                err: errMessage(err),
            });
        }
    }

    /**
     * React to a BullMQ Worker `error` that signals this worker has lost a job's
     * lock ("could not renew lock for job <jobId>"). Returns `true` when the
     * error WAS a lock-loss message — the caller then suppresses the generic
     * unthrottled `log.warn`, because BullMQ re-emits this every ~lockRenewTime
     * for the whole life of the zombie and logging each one floods stdout (the
     * 2026-05 186 GB incident).
     *
     * When the loss is SUSTAINED (≥ LOCK_LOST_FAIL_THRESHOLD emissions within
     * LOCK_LOST_RESET_MS) for a run THIS worker still tracks, we finalize the
     * orphaned run via `autoFailRun` — the same machinery the stall watchdog
     * uses. A single transient renew blip that recovers never reaches the
     * threshold, so a healthy run is never killed.
     */
    private maybeReactToLockLoss(err: unknown): boolean {
        const m = LOCK_LOST_RE.exec(errMessage(err));
        if (!m) return false;
        const jobId = m[1];
        const hashIdx = jobId.lastIndexOf('#');
        const runId = hashIdx >= 0 ? jobId.slice(hashIdx + 1) : '';
        // Not a run we own (already finalized, or another shard's job): still a
        // lock-loss line, so suppress the flood, but nothing to act on.
        if (!runId.startsWith('run_') || !this.abortControllers.has(runId)) return true;
        // Already auto-failed by a prior threshold hit (or the stall watchdog):
        // keep suppressing the repeats, don't re-finalize.
        if (this.stallFailed.has(runId)) return true;

        const now = Date.now();
        const entry = this.lockLostHits.get(runId);
        const sinceLast = entry ? now - entry.lastAt : Infinity;
        // Reset on a stale gap OR an NTP backward step (sinceLast < 0): a
        // backward clock step must not let stale hits from "the future" survive
        // and prematurely trip the threshold on an otherwise-healthy run.
        // Mirrors checkRunDeadline's backward-step clamp.
        if (!entry || sinceLast > LOCK_LOST_RESET_MS || sinceLast < 0) {
            // Fresh episode — one blip is not enough to act.
            this.lockLostHits.set(runId, { count: 1, lastAt: now });
            return true;
        }
        entry.count += 1;
        entry.lastAt = now;
        if (entry.count < LOCK_LOST_FAIL_THRESHOLD) return true;

        this.lockLostHits.delete(runId);
        log.warn('BullMQ job lock lost — finalizing orphaned run', {
            runId,
            consecutiveRenewFailures: entry.count,
        });
        void this.autoFailRun(
            runId,
            'lock-lost',
            `BullMQ job lock lost (${entry.count} consecutive renew failures); ` +
                `this worker no longer owns the job. Runner finalized the orphaned run.`,
            'BullMQ job lock lost — worker no longer owns the job',
        ).catch((e: unknown) => {
            log.warn('autoFailRun after lock loss threw', { runId, err: errMessage(e) });
        });
        return true;
    }

    // -- cancellation --------------------------------------------------------

    private async subscribeCancel(runId: string, abort: AbortController): Promise<void> {
        // Pass a test-injected subscribe override when present; otherwise
        // subscribeToCancel uses the real valkey subscribeToChannel internally.
        const subscribeOverride = this.subscribe ?? undefined;
        try {
            const unsub = await subscribeToCancel(
                runId,
                () => this.onCancelSignal(runId, abort),
                subscribeOverride,
            );
            this.cancelUnsubs.set(runId, unsub);
        } catch (err) {
            // Cancel subscription is best-effort — soft-cancel will still
            // mark the Postgres row 'cancelling' even if pubsub fails, and
            // the heartbeat's cancel_requested_at poll picks that up.
            log.warn('cancel subscribe failed', {
                runId,
                err: errMessage(err),
            });
        }
    }

    /**
     * Abort a run on a cancel request. Two triggers: the `task:cancel` pub/sub
     * message (fast path) and the heartbeat seeing `cancel_requested_at` in
     * Postgres (durable fallback: pub/sub never buffers, so a PUBLISH sent while
     * this worker's subscription was reconnecting is simply lost).
     */
    private onCancelSignal(runId: string, abort: AbortController): void {
        try {
            abort.abort();
        } catch {
            // ignore — signal already aborted
        }
        // BUG2: a synchronously-wedged `isolation: 'worker'` run
        // ignores the cooperative abort() above until the
        // watchdog's hard timeout (default 2h) eventually
        // terminate()s it. Arm a bounded grace timer that force-
        // terminates the worker if the run hasn't settled by
        // then, instead of waiting out the full hard-timeout
        // window. No-op for in-process runs (no isolation
        // handle to find). Guard against arming twice for the
        // same run (e.g. a duplicate cancel signal).
        if (!this.cancelGraceTimers.has(runId)) {
            const graceTimer = setTimeout(() => {
                this.cancelGraceTimers.delete(runId);
                // Presence in isolationRuns IS "not yet terminal/
                // cleanup" — executeIsolated's `.finally()` removes
                // the entry the moment the isolated run settles.
                const isoRun = this.isolationRuns.get(runId);
                if (isoRun) {
                    log.warn('Cancel grace window elapsed; force-terminating isolated worker', {
                        runId,
                        graceMs: CANCEL_ISOLATION_TERMINATE_GRACE_MS,
                    });
                    // terminate() is idempotent/memoized (safe if
                    // the watchdog also terminates concurrently).
                    void isoRun.terminate(0).catch((err: unknown) => {
                        log.warn('cancel grace-timer isolation terminate failed', {
                            runId,
                            err: errMessage(err),
                        });
                    });
                }
            }, CANCEL_ISOLATION_TERMINATE_GRACE_MS);
            if (typeof graceTimer.unref === 'function') graceTimer.unref();
            this.cancelGraceTimers.set(runId, graceTimer);
        }
    }

    // -- downstream trampoline -----------------------------------------------
    //
    // When a plugin returns `result.downstream`, the runner enqueues each
    // child as an independent top-level BullMQ job with `parentRunId` set so
    // the family tree is visible in task_history for UI and diagnostics.
    //
    // Simplified contract (Task J iteration): the parent job completes
    // immediately after enqueueing children. Children execute independently;
    // the parent does NOT wait for all children before transitioning to
    // `completed`. The full "parent waits for all children" semantic (using
    // FlowProducer + moveToWaitingChildren) can be added in a future task if
    // needed — parent_run_id in task_history already captures the relationship.

    private async handleDownstream(
        _parentJob: RunnerJob,
        parentRunId: string,
        downstream: Array<{ taskId: string; input: unknown }>,
    ): Promise<void> {
        for (const d of downstream) {
            const child = this.registry.getTask(d.taskId);
            if (!child) {
                log.warn('downstream task not registered — skipping', {
                    parentRunId,
                    childTaskId: d.taskId,
                });
                continue;
            }

            const childRunId = `run_${ulid()}`;
            const startedAt = new Date();

            // Seed the Valkey active hash.
            //
            // IMPORTANT: do NOT write `ownerInstanceId` here — same reason as
            // orchestrator.startRun. claim-run.lua rejects when the existing
            // owner differs from the claimant's instanceId, so seeding this
            // field locks the child to whichever worker spawned it. Let the
            // first runner to call claimRun win atomically across replicas.
            try {
                const client = this.getClient();
                await invokeOwnedCommand(
                    [
                        'HSET',
                        `task:run:active:${childRunId}`,
                        'state',
                        'pending',
                        'taskId',
                        d.taskId,
                        'startedAt',
                        startedAt.toISOString(),
                        'updatedAt',
                        String(Date.now()),
                    ],
                    client,
                    this.authority,
                );
                await invokeOwnedCommand(
                    [
                        'PEXPIRE',
                        `task:run:active:${childRunId}`,
                        String(LUMASTRA_RUN_STATE_TTL_ACTIVE_MS),
                    ],
                    client,
                    this.authority,
                );
            } catch (err) {
                log.warn('downstream Valkey HSET failed', {
                    parentRunId,
                    childRunId,
                    err: errMessage(err),
                });
            }

            // Enqueue first so a crash after this point does not leave a
            // task_history row with no BullMQ job backing it.
            //
            // Encode the runId in opts.jobId as `<taskId>~~down#<childRunId>`
            // so QueueEvents handlers can decode the runId without a
            // queue.getJob probe — critical when BullMQ has reaped the job
            // (removeOnComplete). Without the suffix, `runIdFromJobId` falls
            // back to `queue.getJob(jobId)` which returns null after reap,
            // dropping the terminal transition silently and leaving the
            // child stuck 'active' until the 5-minute reconciler sweep.
            //
            // `~~` is the separator (not `::`) because BullMQ 5.71+ rejects
            // jobIds whose colon-split yields a count other than 3.
            //
            // Mirrors the conventions used elsewhere:
            //   - trigger task           → `<computeIdentity>#<runId>`
            //   - non-trigger pipeline   → `<taskId>~~pipe#<runId>`
            //   - pipeline gate          → `<gateId>#<gateRunId>`
            //   - downstream trampoline  → `<taskId>~~down#<childRunId>` (this site)
            let enqueued = false;
            try {
                // Under FEATURE_PER_TASK_QUEUES the queueFactory routes to the
                // child's per-task queue (`bull:task:t:<childId>`); otherwise to
                // the legacy per-class queue.
                const queue = this.queueFactory(child.resourceClass, d.taskId);
                const childJobId = taskJobId(`${d.taskId}~~down#${childRunId}`, this.authority);
                await withTaskQueueWrite(
                    this.getSql(),
                    this.authority,
                    { kind: 'add', queue: queue.name, jobId: childJobId },
                    () =>
                        queue.add(
                            d.taskId,
                            {
                                runId: childRunId,
                                input: d.input,
                                parentRunId,
                                ...(_parentJob.data.playbackCpuExempt
                                    ? { playbackCpuExempt: true }
                                    : {}),
                                ...(this.authority ? { taskAuthority: this.authority } : {}),
                            },
                            {
                                jobId: childJobId,
                                ...taskRetryOptions(child),
                            },
                        ),
                );
                enqueued = true;
                log.info('downstream child enqueued', {
                    parentRunId,
                    childRunId,
                    childTaskId: d.taskId,
                    resourceClass: child.resourceClass,
                });
            } catch (err) {
                // Unknown publication may already be live: retain its history
                // below instead of erasing the run from recovery's view.
                if (err instanceof QueueOperationUncertainError) enqueued = true;
                log.warn('downstream enqueue failed', {
                    parentRunId,
                    childRunId,
                    childTaskId: d.taskId,
                    err: errMessage(err),
                });
            }

            // Persist task_history after successful or uncertain publication.
            // If the INSERT subsequently fails the BullMQ job still runs
            // (boot recovery will reconcile the missing row).
            if (enqueued) {
                const sql = this.getSql();
                if (sql) {
                    try {
                        await insertTaskHistoryRow(
                            sql,
                            {
                                id: childRunId,
                                taskId: d.taskId,
                                parentRunId,
                                label: child.name || d.taskId,
                                state: 'pending',
                                input: d.input,
                                scope: null,
                                trigger: { kind: 'pipeline-child' },
                                actor: { type: 'system', via: 'in-process' },
                                startedAt,
                                processingVersion: child.processingVersion,
                                ownerInstanceId: this.instanceId,
                                retentionPolicy: child.retention?.policy ?? 'standard',
                                stages: [],
                            },
                            this.authority,
                        );
                    } catch (err) {
                        log.warn('downstream task_history INSERT failed', {
                            parentRunId,
                            childRunId,
                            childTaskId: d.taskId,
                            err: errMessage(err),
                        });
                    }
                }
            }
        }
    }

    // -- Postgres writes -----------------------------------------------------

    private async markActiveInPostgres(runId: string, executionStartedAt: string): Promise<void> {
        const sql = this.getSql();
        if (!sql) return;
        try {
            // RETURNING is load-bearing: `WHERE state = 'pending'` means an
            // empty result is "this run was already active", and re-publishing
            // would emit a duplicate transition.
            const rows = await withExistingTaskWrite(
                sql,
                this.authority,
                async (tx) => tx`
                UPDATE task_history
                SET state = 'active',
                    execution_started_at = ${executionStartedAt},
                    heartbeat_at = NOW(),
                    owner_instance_id = ${this.instanceId}
                WHERE id = ${runId}
                  AND state = 'pending'
                RETURNING id, task_id, label, state, scope, trigger, actor,
                          CASE WHEN task_id = 'media-probe' AND input ? 'fileId'
                               THEN jsonb_build_object('fileId', input->'fileId') END AS recheck_input,
                          started_at, execution_started_at, completed_at, heartbeat_at, stages, error
            `,
            );
            const activeRow = rows[0] as unknown as TerminalRunRow | undefined;
            // Resolve the channel from the row's own task_id: this call site
            // has no taskId argument, and publishing on the wrong
            // `task:events:<class>` channel would hide the event from every
            // subscriber.
            const resolvedClass =
                this.registry.getTask(activeRow?.task_id ?? '')?.resourceClass ?? 'io';
            await emitActiveRunEvent({ resourceClass: resolvedClass, row: activeRow });
        } catch (err) {
            if (err instanceof AuthorityError) throw err;
            log.warn('markActiveInPostgres failed', {
                runId,
                err: errMessage(err),
            });
        }
    }

    /**
     * Mark a synthetic fan-in gate's `task_history` row `completed` (TASK-C7).
     *
     * The gate has no `execute()`; once BullMQ has run all its children it is
     * picked up here purely so the convergent child can proceed. The row is
     * seeded `pending` by the orchestrator at enqueue time — flip it to a
     * terminal state so the gate is visible/traceable in the admin UI instead
     * of looking like a stuck pending run. Best-effort and idempotent: scoped to
     * the synthetic id prefix and to a non-terminal state so a redelivery (or a
     * missing row) is a harmless no-op.
     */
    private async markGateCompletedInPostgres(runId: string): Promise<void> {
        const sql = this.getSql();
        if (!sql) return;
        try {
            await withExistingTaskWrite(
                sql,
                this.authority,
                async (tx) => tx`
                UPDATE task_history
                SET state = 'completed',
                    completed_at = NOW(),
                    heartbeat_at = NOW(),
                    owner_instance_id = ${this.instanceId}
                WHERE id = ${runId}
                  AND starts_with(task_id, '__gate__')
                  AND state NOT IN ('completed', 'failed', 'cancelled')
            `,
            );
        } catch (err) {
            if (err instanceof AuthorityError) throw err;
            log.warn('markGateCompletedInPostgres failed', {
                runId,
                err: errMessage(err),
            });
        }
    }

    /**
     * Read the `processing_version` recorded on this row at insert time.
     *
     * Used by the dispatch-time guard (step 4b in processJob) to refuse
     * stale enqueues that would otherwise run against incompatible new
     * code during a rolling restart.
     *
     * Returns a discriminated `ProcessingVersionRead`:
     *   - `{ kind: 'no-sql' }`   — sql unavailable OR query failed. Dispatcher
     *     logs loudly and proceeds without the guard. (Blocking would prevent
     *     ANY work during a DB outage; we accept the silent-skip risk and
     *     surface it via the warn log.)
     *   - `{ kind: 'null-row' }` — row missing, column NULL, or value
     *     unparseable. All three are legacy / pre-Wave-9 shapes; dispatcher
     *     skips the guard silently.
     *   - `{ kind: 'value', value }` — numeric processing_version available;
     *     dispatcher applies the standard `< / == / >` policy.
     */
    private async readProcessingVersion(runId: string): Promise<ProcessingVersionRead> {
        const sql = this.getSql();
        // Distinguish "sql unavailable" (degraded boot / test harness — guard
        // intentionally skipped, log loudly so the operator sees it) from
        // "row column is NULL" (legacy pre-Wave-9 row — also skip the guard
        // but no need to alarm) and "row missing / parse failure" (treat as
        // legacy: no guard but no alarm either). The previous code returned
        // `null` for all four cases so a degraded boot silently disabled the
        // processing_version guard, letting stale-payload runs through. The
        // discriminated result moves that decision back to the dispatcher.
        if (!sql) return { kind: 'no-sql' };
        try {
            const rows = await sql<{ processing_version: string | null }[]>`
                SELECT processing_version
                FROM task_history
                WHERE id = ${runId}
            `;
            const raw = rows[0]?.processing_version;
            if (raw == null) return { kind: 'null-row' };
            const n = Number(raw);
            if (!Number.isFinite(n)) return { kind: 'null-row' };
            return { kind: 'value', value: n };
        } catch (err) {
            log.warn('readProcessingVersion failed', {
                runId,
                err: errMessage(err),
            });
            // Treat a query failure the same as no-sql — guard is skipped but
            // we log loudly so the operator can correlate with DB health.
            return { kind: 'no-sql' };
        }
    }

    /**
     * Whether this is the LAST BullMQ attempt for the job, i.e. a failure
     * here is genuinely terminal and won't be retried. `attemptsMade` is the
     * count of attempts already finished, so the current attempt is
     * `attemptsMade + 1`; compare against the configured ceiling
     * (the persisted job options, falling back to the task's retry policy).
     */
    private isFinalAttempt(job: RunnerJob, task: TaskDefinition): boolean {
        // Floor at 1: a misconfigured `attempts: 0` (or negative) must not make
        // `(0)+1 >= 0` true on the first try and release the mutex prematurely.
        const maxAttempts = Math.max(1, job.opts?.attempts ?? taskRetryOptions(task).attempts);
        return (job.attemptsMade ?? 0) + 1 >= maxAttempts;
    }

    /** Extend the current attempt's mutex without recreating or stealing it. */
    private async refreshExclusivityKey(job: RunnerJob, task: TaskDefinition): Promise<void> {
        const key = job.data.exclusivityKey;
        if (!key) return;
        const ttl = Math.max(
            deriveIdentityTtlFloor(task),
            parseDurationMs(task.exclusiveWith?.ttl) ?? 24 * 3_600_000,
        );
        const renewed = await luaLoader.invoke(
            'refresh-identity',
            [key],
            [job.data.runId, String(ttl)],
            this.getClient(),
            this.authority,
        );
        if (Number(renewed) !== 1) {
            this.abortControllers.get(job.data.runId)?.abort();
            throw new UnrecoverableError('Task identity ownership lost');
        }
    }

    /**
     * Release the `exclusiveWith` mutex key on a FINAL terminal. The
     * orchestrator SETNX-claims `task:identity:<…>` at enqueue (with a
     * crash-safety TTL, default 24h) and stashes the key in job data; without
     * an explicit DEL the key lingers for the whole TTL and blocks legitimate
     * sequential re-runs of the same identity.
     *
     * Best-effort: a failed DEL just falls back to TTL expiry. No-op for the
     * (vast) majority of tasks that don't declare `exclusiveWith` — they carry
     * no key in job data.
     *
     * MUST only be called on a genuinely final terminal — never between BullMQ
     * retry attempts (see `isFinalAttempt`), or a duplicate concurrent run
     * could claim the freed key while the retry is still pending.
     */
    private async releaseExclusivityKey(job: RunnerJob): Promise<void> {
        const key = job.data.exclusivityKey;
        if (!key) return;
        try {
            // Compare-and-delete: DEL only if the key still holds THIS run's
            // runId (the value enqueue-with-identity.lua stored). A blind DEL
            // would steal a successor's lock if our key's TTL expired mid-run
            // and another run re-claimed the same identity. Falls back to TTL
            // expiry on any failure.
            await luaLoader.invoke(
                'release-identity',
                [key],
                [job.data.runId],
                this.getClient(),
                this.authority,
            );
        } catch (err) {
            log.warn('releaseExclusivityKey failed — falling back to TTL expiry', {
                runId: job.data.runId,
                err: errMessage(err),
            });
        }
        try {
            await runTerminalFollowup(job.name, this.getSql());
        } catch {
            log.warn('Terminal follow-up could not start', { taskId: job.name });
        }
    }

    private async writeTerminalToPostgres(
        runId: string,
        to: 'completed' | 'failed' | 'cancelled',
        result: unknown,
        error: {
            message: string;
            kind?: string;
            stack?: string;
            reason?: string;
            remediation?: 'identity' | 'operational';
        } | null,
        // Optional — supply at the run-outcome call sites (completed/failed) so
        // the circuit breaker accumulates success/failure. Omitted at cancel /
        // watchdog-autofail sites, which must not count toward quarantine.
        taskId?: string,
    ): Promise<void> {
        const sql = this.getSql();
        if (!sql) return;
        const attempt = captureTerminalQueueAttempt(this.executingQueueJobs.get(runId));
        const enqueuedAt = Date.now();
        const completedAt = new Date(enqueuedAt).toISOString();
        let snapshotError: unknown;
        try {
            const snapshot = JSON.parse(JSON.stringify({ result: result ?? null, error })) as {
                result: unknown;
                error: typeof error;
            };
            result = snapshot.result;
            error = snapshot.error;
        } catch (failure) {
            snapshotError = failure;
        }
        const deferredWrite = (): PendingWrite | undefined =>
            attempt
                ? {
                      kind: 'update',
                      queueAttempt: attempt,
                      ownerInstanceId: this.instanceId,
                      authority: this.authority,
                      runId,
                      payload: { state: to, result: result ?? null, error, completedAt },
                      enqueuedAt,
                  }
                : undefined;
        const persist = async (options: { acceptMissingJob?: boolean } = {}): Promise<void> => {
            try {
                // postgres.js binds JS strings as text parameters. A bare
                // `${JSON.stringify(obj)}` against a JSONB column lands as a
                // JSONB *string scalar* — `jsonb_typeof` returns 'string' and
                // `result->>'itemsProcessed'` returns NULL. Use `sql.json()` so
                // the binary protocol writes an actual JSONB object/array. This
                // path produced 100% of the 1.06M `result` rows on preprod
                // 2026-05-29 as string-encoded — `/admin/tasks` ETA was always
                // null because the throughput query couldn't extract
                // `itemsProcessed`.
                const errorValue = error ? sql.json(error as unknown as postgres.JSONValue) : null;
                const resultValue =
                    result === undefined || result === null
                        ? null
                        : sql.json(result as postgres.JSONValue);
                if (options.acceptMissingJob) {
                    // The job was reaped: re-confirm and write in ONE transaction,
                    // and only over a row this instance's attempt still owns. A
                    // successor's pending/active row is never overwritten.
                    const reapedRows = await withExistingTaskWrite(
                        sql,
                        this.authority,
                        async (tx): Promise<TerminalRunRow[]> => {
                            if (await terminalResultConfirmed(tx, runId, to, result)) return [];
                            return (await tx`
                            UPDATE task_history
                            SET state = ${to},
                                completed_at = NOW(),
                                result = ${resultValue},
                                error = ${errorValue}
                            WHERE id = ${runId}
                              AND owner_instance_id = ${this.instanceId}
                              AND (state IN ('active', 'cancelling')
                                   OR (state = 'failed' AND ${to}::text = 'completed'))
                              AND (state <> 'cancelling' OR error->>'code' IS DISTINCT FROM 'HARD_KILL_QUEUE_PENDING')
                            RETURNING id, task_id, label, state, scope, trigger, actor,
                          CASE WHEN task_id = 'media-probe' AND input ? 'fileId'
                               THEN jsonb_build_object('fileId', input->'fileId') END AS recheck_input,
                                      started_at, execution_started_at, completed_at, heartbeat_at, stages, result, error
                        `) as unknown as TerminalRunRow[];
                        },
                    );
                    const reapedRow = reapedRows[0];
                    if (!reapedRow) {
                        log.warn('Terminal job reaped; accepting the PostgreSQL outcome', {
                            runId,
                            to,
                            jobId: attempt?.id,
                        });
                        return;
                    }
                    await emitTerminalRunEvent({
                        resourceClass:
                            this.registry.getTask(reapedRow.task_id ?? taskId ?? '')
                                ?.resourceClass ?? 'io',
                        row: reapedRow,
                    });
                    return;
                }
                // Allow `failed → completed` overwrite for retry-success path;
                // orchestrator.ts's terminal-write applies the same policy. After
                // attempts 1+2 fail (row='failed') and attempt 3 succeeds, the
                // runner is the actual writer (orchestrator's QueueEvents path is
                // a no-op because runner Lua already DEL'd the active hash). So
                // without this explicit allow, the row stays 'failed' forever.
                // RETURNING drives event emission: an empty result means another
                // writer already terminalized this run, so we must not publish a
                // second frame for it.
                const terminalRows = await withExistingTaskWrite(
                    sql,
                    this.authority,
                    async (tx) => tx`
                UPDATE task_history
                SET state = ${to},
                    completed_at = NOW(),
                    result = ${resultValue},
                    error = ${errorValue}
                WHERE id = ${runId}
                  AND (state NOT IN ('completed', 'failed', 'cancelled')
                       OR (state = 'failed' AND ${to}::text = 'completed'))
                  AND (state <> 'cancelling' OR error->>'code' IS DISTINCT FROM 'HARD_KILL_QUEUE_PENDING')
                RETURNING id, task_id, label, state, scope, trigger, actor,
                          CASE WHEN task_id = 'media-probe' AND input ? 'fileId'
                               THEN jsonb_build_object('fileId', input->'fileId') END AS recheck_input,
                          started_at, execution_started_at, completed_at, heartbeat_at, stages, result, error
            `,
                );
                const terminalRow = terminalRows[0] as unknown as TerminalRunRow | undefined;
                if (!terminalRow && !(await terminalResultConfirmed(sql, runId, to, result))) {
                    if (!attempt)
                        throw new TerminalAttemptUnknownError(
                            'UNKNOWN: original terminal result attempt unavailable',
                        );
                    if (
                        !(await terminalQueueAttemptCurrent(attempt, runId, this.authority, () =>
                            terminalResultConfirmed(sql, runId, to, result),
                        ))
                    )
                        return;
                    await withExistingTaskWrite(
                        sql,
                        this.authority,
                        async (tx) => tx`
                        UPDATE task_history SET result = ${resultValue}
                        WHERE id = ${runId} AND state = ${to}
                          AND state IN ('completed', 'failed') AND result IS NULL
                    `,
                    );
                    if (!(await terminalResultConfirmed(sql, runId, to, result)))
                        throw new TerminalAttemptUnknownError(
                            'UNKNOWN: original terminal result is unconfirmed',
                        );
                }
                // Prefer the row's own task_id: the cancel / watchdog call sites
                // omit the `taskId` argument, and publishing on the wrong
                // `task:events:<class>` channel would silently hide the event from
                // every subscriber.
                const resolvedClass =
                    this.registry.getTask(terminalRow?.task_id ?? taskId ?? '')?.resourceClass ??
                    'io';
                await emitTerminalRunEvent({
                    resourceClass: resolvedClass,
                    row: terminalRow,
                });
            } catch (err) {
                if (err instanceof AuthorityError) throw err;
                log.warn('writeTerminalToPostgres failed', {
                    runId,
                    to,
                    err: errMessage(err),
                });
                // Durability: on a TRANSIENT Postgres error (connection lost,
                // deadlock, serialization failure, resource exhaustion) enqueue the
                // terminal write to the pending-write drain so a brief DB blip at
                // completion time does not permanently lose the run's terminal state
                // and result JSON. The runner is the actual writer of the
                // `completed` row (the orchestrator's QueueEvents path no-ops once
                // the active hash is DEL'd), so without this the run is later
                // reclaimed as `failed` by boot-recovery and the result is dropped.
                // The orchestrator's own terminal writes already drain this way.
                // Non-transient errors remain owned UNKNOWN obligations; never enqueue invalid fallback data.
                if (isTransientPgError(err)) {
                    if (!attempt)
                        throw new Error(
                            'UNKNOWN: terminal fallback has no original queue attempt',
                            { cause: err },
                        );
                    await this.getPendingWriteDrain(sql).enqueue(deferredWrite()!, {
                        strict: true,
                    });
                } else {
                    throw err;
                }
            }
        };
        const obligation: TerminalWriteObligation = {
            runId,
            to,
            result,
            attempt,
            retainedAt: Date.now(),
            deferredWrite,
            retry: async (options) => {
                if (snapshotError) throw snapshotError;
                await persist(options);
            },
        };
        this.terminalWriteObligations.add(obligation);
        obligation.pending = obligation
            .retry()
            .then(() => {
                this.terminalWriteObligations.delete(obligation);
            })
            .catch((failure: unknown) => {
                obligation.error = failure;
                if (failure instanceof AuthorityError) throw failure;
                log.warn('Retained unacknowledged terminal persistence', {
                    runId,
                    error: errMessage(failure),
                });
            })
            .finally(() => {
                obligation.pending = undefined;
            });
        await obligation.pending;

        // Circuit-breaker accounting. Report the RUN outcome regardless of
        // whether the Postgres terminal write above succeeded (reportSuccess/
        // reportFailure swallow their own DB errors). completed → success,
        // failed → failure; cancels are not reported. Errors stay best-effort,
        // but the known host SQL promise must settle before execution quiescence.
        if (taskId) {
            const breaker = this.getCircuitBreaker(sql);
            if (to === 'completed') {
                await breaker.reportSuccess(taskId);
            } else if (to === 'failed') {
                const kind: 'transient' | 'permanent' | 'fatal' =
                    error?.kind === 'permanent' || error?.kind === 'fatal'
                        ? error.kind
                        : 'transient';
                // Permanent failures (bad TMDB ID, data error, schema mismatch, etc.)
                // are deterministic — retrying later will never fix them. Counting
                // them toward the circuit threshold would open the circuit and fire a
                // CRITICAL alert for a backlog full of malformed data, which is noise
                // rather than an actionable signal. Only transient / fatal errors
                // (network blips, infra crashes) drive the consecutive-failure count.
                if (kind !== 'permanent') {
                    await breaker.reportFailure(taskId, { kind });
                }
            }
        }
    }

    /**
     * CircuitBreaker reporting instance, lazily constructed. Shares
     * `task_circuit_state` with the orchestrator's instance. The client getter
     * returns the runner's underlying Valkey client (a real GlideClient at
     * runtime, typed narrower as ValkeyLike), used only for the breaker's state
     * mirror; reportSuccess/reportFailure persist to Postgres.
     */
    private getCircuitBreaker(sql: postgres.Sql): CircuitBreaker {
        if (!this.circuitBreaker) {
            this.circuitBreaker = new CircuitBreaker(sql, () => this.getClient());
        }
        return this.circuitBreaker;
    }

    /**
     * Enqueue-only pending-write drain, lazily constructed. Never start()ed —
     * the orchestrator's leader-side instance consumes the shared
     * `task:pending-writes` LIST. enqueue() uses only the Valkey client, so the
     * sql handle (already non-null at the single call site) is just satisfying
     * the constructor.
     */
    private getPendingWriteDrain(sql: postgres.Sql): PendingWriteDrain {
        if (!this.pendingWriteDrain) {
            this.pendingWriteDrain = new PendingWriteDrain(sql, async () => this.getClient());
        }
        return this.pendingWriteDrain;
    }

    /**
     * Re-read the run's current state from Valkey (active hash first, then
     * terminal hash). Used by the failure path to recover from cancel/throw
     * races: when active→failed rejects with state-mismatch, we need to know
     * whether the live state is 'cancelling' (so we should write 'cancelled'
     * instead of 'failed') or something else.
     *
     * Returns `null` if the hash is absent and can't be classified — caller
     * falls through to original failed-write behavior in that case.
     */
    /**
     * Resolve the run's authoritative execution-start (epoch ms) for the
     * wall-clock budget watchdog. Priority:
     *
     *   1. Valkey active-hash `task:run:active:<runId>` field `startedAt` — the
     *      exact pending→active execution start written by `transitionToActive`.
     *      Fresh on the FIRST attempt (so a run that sat in a deep backlog is NOT
     *      instantly failed — the budget clock starts at execution, not enqueue),
     *      and the ORIGINAL start on a re-delivery while the hash is still alive.
     *   2. Postgres `task_history.started_at` — durable fallback for when the
     *      Valkey hash has aged out of its TTL. That only happens for a run
     *      already older than the hash TTL (15m–1h), i.e. a genuinely
     *      long-lived/redelivered run, where anchoring to the slightly-earlier
     *      enqueue time is immaterial and correctly lets the hard cap fire.
     *
     * Returns `undefined` when neither is resolvable; `startHeartbeat` then
     * anchors to pickup time so a genuine first attempt is never failed early.
     */
    private async resolveBudgetStartMs(runId: string): Promise<number | undefined> {
        // 1. Valkey active hash (execution start).
        try {
            const client = this.getClient();
            const raw = await client.customCommand([
                'HGET',
                `task:run:active:${runId}`,
                'startedAt',
            ]);
            if (typeof raw === 'string' && raw) {
                const ms = Date.parse(raw);
                if (!Number.isNaN(ms)) return ms;
            }
        } catch (err) {
            log.warn('resolveBudgetStartMs: Valkey read failed; trying Postgres', {
                runId,
                err: errMessage(err),
            });
        }
        // 2. Postgres durable fallback (enqueue time) for aged-out hashes.
        try {
            const sql = this.getSql();
            if (sql) {
                const rows = await sql<{ started_at: Date | string | null }[]>`
                    SELECT started_at FROM task_history WHERE id = ${runId} LIMIT 1
                `;
                const v = rows[0]?.started_at;
                if (v) {
                    const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
                    if (!Number.isNaN(ms)) return ms;
                }
            }
        } catch (err) {
            log.warn('resolveBudgetStartMs: Postgres read failed; anchoring to pickup time', {
                runId,
                err: errMessage(err),
            });
        }
        return undefined;
    }

    private async readRunStateForRecovery(runId: string): Promise<RunState | null> {
        try {
            const client = this.getClient();
            const live = await client.customCommand(['HGET', `task:run:active:${runId}`, 'state']);
            if (typeof live === 'string') return live as RunState;
            const term = await client.customCommand([
                'HGET',
                `task:run:terminal:${runId}`,
                'state',
            ]);
            if (typeof term === 'string') return term as RunState;
        } catch (err) {
            log.warn('readRunStateForRecovery failed', {
                runId,
                err: errMessage(err),
            });
        }
        return null;
    }

    /**
     * Best-effort PUBLISH to `task:events:meta` so the admin UI / SSE bridge
     * can surface runner-side events (e.g. "skipped by when()"). Mirrors
     * `TaskOrchestrator.emitMeta` so the meta-event envelope shape is
     * consistent across components. Failures are swallowed — self-observability
     * must never block the terminal write that already landed.
     */
    private async emitMeta(type: string, data: unknown): Promise<void> {
        await emitMetaEvent(type, data);
    }

    private async writeCostBreakdown(
        runId: string,
        taskId: string,
        breakdown: Record<string, number>,
    ): Promise<void> {
        if (Object.keys(breakdown).length === 0) return;
        // Record cost units in Prometheus — only known COST_KINDS to prevent
        // cardinality explosion from arbitrary plugin-supplied strings (TASK-H19).
        for (const [costUnit, amount] of Object.entries(breakdown)) {
            if (!COST_KINDS_SET.has(costUnit)) continue;
            taskCostUnitsTotal.inc({ task_id: taskId, cost_unit: costUnit }, amount);
        }
        const sql = this.getSql();
        if (!sql) return;
        try {
            await withExistingTaskWrite(
                sql,
                this.authority,
                async (tx) => tx`
                UPDATE task_history
                SET cost_breakdown = ${sql.json(breakdown as postgres.JSONValue)}
                WHERE id = ${runId}
            `,
            );
        } catch (err) {
            if (err instanceof AuthorityError) throw err;
            log.warn('writeCostBreakdown failed', {
                runId,
                err: errMessage(err),
            });
        }
    }

    private async recordFailure(
        runId: string,
        message: string,
        kind: 'transient' | 'permanent' | 'fatal',
    ): Promise<void> {
        // No taskId passed: the only caller is the unknown-task path, which
        // must NOT count toward a circuit breaker for a non-registered task.
        await this.writeTerminalToPostgres(runId, 'failed', null, {
            message,
            kind,
        });
        try {
            await this.transitionRun({
                runId,
                from: 'pending',
                to: 'failed',
                extra: {
                    failedAt: nowIso(),
                    errorMessage: message,
                    errorKind: kind,
                },
            });
        } catch {
            // best-effort: row may not have an active hash anymore
        }
    }

    private async recordPluginFailure(
        pluginId: string,
        runId: string,
        itemId: string,
        reason: string,
        meta: object | undefined,
    ): Promise<void> {
        const sql = this.getSql();
        if (!sql) return;
        try {
            await withExistingTaskWrite(
                sql,
                this.authority,
                async (tx) => tx`
                INSERT INTO plugin_failure_events (plugin_id, item_id, run_id, reason, meta)
                VALUES (${pluginId}, ${itemId}, ${runId}, ${condenseFailureReason(reason)}, ${meta ? sql.json(meta as postgres.JSONValue) : null})
            `,
            );
        } catch (err) {
            if (err instanceof AuthorityError) throw err;
            log.warn('recordPluginFailure failed', {
                runId,
                pluginId,
                err: errMessage(err),
            });
        }
    }

    /**
     * Clear every unresolved failure row a task holds against one item.
     *
     * The counterpart to `recordPluginFailure`, and the reason `ctx.reportSuccess`
     * exists. `plugin_failure_events` is append-only, and until this was wired up
     * the ONLY thing in the codebase that ever stamped `resolved_at` was the
     * admin UI's per-item Retry button — so an item that failed on Monday and
     * succeeded by itself on Tuesday kept its row, and the attention board kept
     * reporting it. Prod 2026-09-11: 3,010 unresolved rows across six tasks,
     * ZERO resolved, with 578 of `lumastra-intro-analyzer`'s 580 failed items
     * already `completed` on their stage rows.
     *
     * Best-effort like its sibling: an audit write must never fail a run that
     * genuinely succeeded.
     */
    private async resolvePluginFailures(pluginId: string, itemId: string): Promise<void> {
        const sql = this.getSql();
        if (!sql) return;
        try {
            await withExistingTaskWrite(sql, this.authority, async (tx) =>
                markFailureEventsResolved(tx, pluginId, itemId),
            );
        } catch (err) {
            log.warn('resolvePluginFailures failed', {
                pluginId,
                itemId,
                err: errMessage(err),
            });
        }
    }

    /**
     * Wrapper around the pure `extractMediaItemId` helper that emits a one-
     * shot warning per task id when an `input.mediaItemId` is present but
     * has the wrong shape (not a non-empty string). This catches plugin
     * authors who accidentally pass a number, `null`, or an object — without
     * it the coverage wrapper silently falls through to bare execute and the
     * stage row never updates.
     *
     * P2-5: warn once per task id so log volume stays bounded.
     */
    private extractMediaItemIdWithWarn(taskId: string, input: unknown): string | null {
        const extracted = extractMediaItemId(input);
        if (extracted !== null) return extracted;
        // Was a `mediaItemId` field present but invalid?
        if (input !== null && typeof input === 'object') {
            const raw = (input as { mediaItemId?: unknown }).mediaItemId;
            if (raw !== undefined && !this.warnedBadMediaItemId.has(taskId)) {
                this.warnedBadMediaItemId.add(taskId);
                log.warn(
                    `Task ${taskId} produced an input with a non-string mediaItemId (${typeof raw}); coverage row skipped for this run.`,
                );
            }
        }
        return null;
    }

    private async loadPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
        const sql = this.getSql();
        if (!sql) return {};
        try {
            const rows = await sql<{ key: string; value: unknown }[]>`
                SELECT key, value FROM plugin_settings WHERE plugin_id = ${pluginId}
            `;
            const out: Record<string, unknown> = {};
            for (const r of rows) {
                out[r.key] = r.value;
            }
            return out;
        } catch (err) {
            log.warn('loadPluginSettings failed', {
                pluginId,
                err: errMessage(err),
            });
            return {};
        }
    }
}

// ── Capability builders ───────────────────────────────────────────────────────
// Most capability builders live in `context-primitives.ts` so both the runner
// (TaskContext) and the non-task plugin-context helpers share one set.
//
// `ffmpeg` and `dataDir` USED to be built here as stubs that threw on first
// use and pointed at a directory that did not exist. They are no longer on the
// plugin context at all — a member that always fails is worse than an absent
// one. The capability FLAGS survive as disclosures; see FfmpegRunner's note.

// ── Logger adapter — bridge LoggerInstance → PluginLogger + log-buffer mirror ─

function adaptLoggerWithBuffer(base: LoggerInstance, runId: string): PluginLogger {
    const mirror = (
        level: 'debug' | 'info' | 'warn' | 'error',
        msg: string,
        meta?: object,
    ): void => {
        void logBuffer.append(runId, {
            ts: Date.now(),
            level,
            message: msg,
            meta: meta as Record<string, unknown> | undefined,
        });
    };
    return {
        info: (msg, meta) => {
            base.info(msg, meta);
            mirror('info', msg, meta);
        },
        warn: (msg, meta) => {
            base.warn(msg, meta);
            mirror('warn', msg, meta);
        },
        error: (msg, meta) => {
            base.error(msg, undefined, meta);
            mirror('error', msg, meta);
        },
        debug: (msg, meta) => {
            base.debug(msg, meta);
            mirror('debug', msg, meta);
        },
        child: (bindings) => {
            const tag = Object.entries(bindings)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(',');
            return adaptLoggerWithBuffer(base.child(tag), runId);
        },
    };
}

// ── Error classification ──────────────────────────────────────────────────────

export function classifyError(
    err: Error,
    task: Pick<TaskDefinition, 'id' | 'retry'>,
): 'transient' | 'permanent' | 'fatal' {
    if (err instanceof TaskError) {
        return err.kind;
    }
    try {
        if (task.retry?.retryOn?.(err)) {
            return 'transient';
        }
    } catch (predicateErr) {
        // The plugin's own retryOn predicate threw. We still classify the run
        // permanent, but surface it — otherwise a buggy predicate (e.g. a
        // missing optional-chain) makes every run fail permanently with NO
        // diagnostic, indistinguishable in the admin UI from a legit permanent
        // failure. This is exactly the OSS self-documenting-admin concern.
        log.warn('retryOn predicate threw — classifying as permanent', {
            taskId: task.id,
            predicateError: errMessage(predicateErr),
        });
    }
    // Postgres deadlock_detected (40P01) / serialization_failure (40001) abort one
    // transaction with no partial commit; the next attempt almost always succeeds.
    // Generic for every task, so none has to wire its own retryOn for them.
    if (isRetryablePgConflict(err)) return 'transient';
    // FFmpegError.message can be its entire stderr, including arbitrary input
    // paths and title tags. Only the opt-in predicate above may inspect its
    // structured signal/fixed diagnostics; never send it through text fallbacks.
    if ('stderr' in err && typeof err.stderr === 'string') return 'permanent';
    // Built-in cross-cutting transient classifications. Infrastructure
    // backpressure / momentary disconnect errors are NEVER a plugin-author
    // problem — every task can hit them, so it's wrong to make every task
    // wire its own retryOn for them and equally wrong to surface them in
    // the admin failure badge. Each pattern below has been observed on
    // preprod and verified to clear on the next attempt without code change.
    if (isTransientInfrastructureError(err)) {
        return 'transient';
    }
    return 'permanent';
}

/**
 * Pattern set for cross-cutting transient infrastructure errors. Keep
 * narrow — overmatching here masks genuine plugin bugs as retryable, so
 * each entry must be (a) literally a backpressure / connectivity signal
 * and (b) verified to self-resolve on the next attempt.
 *
 *   - `Reached maximum inflight requests` (@valkey/valkey-glide): the
 *     client's per-connection in-flight cap (default 1000) is full. The
 *     client clears the queue as outstanding commands complete; the next
 *     scheduled attempt finds capacity. Observed on preprod 2026-05-30
 *     in stage-sweep + play-session-cleanup during a Valkey burst.
 *   - Connection refused / reset / EPIPE on Valkey or Postgres: typically
 *     a rolling deploy of the storage tier; the next attempt reconnects.
 *   - `fetch failed for <url>: …` (ctx.http / safeFetch network wrapper, and
 *     the bare undici `TypeError: fetch failed`): a DNS/connect/TLS/socket
 *     failure on an OUTBOUND fetch — never a plugin-logic bug. HTTP-status
 *     failures (404/5xx) are thrown by the task AFTER a successful fetch with
 *     a different message (e.g. "… fetch failed: 404 Not Found"), so the
 *     start-anchored pattern below leaves those correctly `permanent`.
 *     Observed on preprod 2026-06-05: a momentary blip fetching the Fribb
 *     anime list from GitHub raw was mis-classified `permanent`, opening the
 *     fribb-anime-sync circuit and wedging ~130 pending items, while the
 *     worker container could reach the URL fine on retest.
 *   - Provider rate limiting (HTTP 429 / `Retry-After`): the upstream is
 *     asking us to slow down, which is the EXPECTED response to a big first
 *     scan and clears on its own once the quota window rolls. It is not a
 *     plugin-author problem and it is not a data problem, so it belongs here
 *     rather than in each task's `retryOn`. `classifyInfraError` (the shared
 *     `retryOn` ~25 builtin tasks pass) covers 5xx but never covered 429, and
 *     `retryOn` returning false falls through to this function — so before
 *     this entry a 429 that escaped a provider client's own retry budget was
 *     classified `permanent`. That wrote `failed_permanent` with
 *     `retryable: false` on the FIRST attempt, which put the item in the
 *     "gave up / needs re-identification" bucket (Library → Fix matches) as
 *     though its provider id were dead, and put the task in the ⚠ failed
 *     lane — the precise opposite of what /admin/help/tasks promises
 *     ("Amber failures are usually self-healing — things like rate limits or
 *     quota limits that resolve on their own"). Retrying is bounded by the
 *     task's own `attempts` / the stage policy's `maxAttempts`, so a provider
 *     that stays rate-limited still dead-letters eventually.
 */
function isRetryablePgConflict(err: unknown): boolean {
    for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
        const code = (e as { code?: unknown }).code;
        if (code === '40P01' || code === '40001') return true;
        e = (e as { cause?: unknown }).cause;
    }
    return false;
}

function isTransientInfrastructureError(err: Error): boolean {
    const msg = err.message ?? '';
    if (/Reached maximum inflight requests/i.test(msg)) return true;
    // Narrow, context-anchored — see RATE_LIMIT_ERROR_PATTERN's own note on why
    // a bare `429` and a bare `quota` deliberately do NOT match here.
    if (RATE_LIMIT_ERROR_PATTERN.test(msg)) return true;
    // CONNECT_TIMEOUT: postgres.js "write CONNECT_TIMEOUT <host>:<port>" when it
    // can't establish a connection in time (pool saturation / DB briefly busy) —
    // transient, not permanent. Omitting it dead-lettered items on a brief blip
    // (a trickplay item went failed_permanent at attempt 0 on this).
    if (/ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|CONNECT_TIMEOUT/i.test(msg)) return true;
    if (/^fetch failed( for |$)/i.test(msg)) return true;
    return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Pull `mediaItemId` out of a job's input payload for pipeline-coverage
 * wrapping. Returns the bare UUID string when the input is a plain object
 * carrying `{ mediaItemId: string }`; returns null otherwise so the runner
 * falls through to the bare `task.execute(ctx)` path.
 *
 * The convention across all builtin tasks (`tmdb-metadata-sync`,
 * `series-sync`, `media-probe`, etc.) is `input.mediaItemId`. This helper is
 * deliberately defensive: it accepts no other field names and rejects empty
 * strings rather than recording a transition against a bogus item id.
 */
/**
 * True only for a result that says the run did all its work. A run aborted
 * by a shutdown usually returns `success: false` / `stopReason: 'aborted'`;
 * anything short of an explicit success counts as unfinished, so a resumable
 * run cut short is resumed rather than recorded as completed.
 */
function isFinishedResult(result: unknown): boolean {
    if (typeof result !== 'object' || result === null) return false;
    const r = result as { success?: unknown; stopReason?: unknown };
    return r.success === true && r.stopReason !== 'aborted';
}

function extractMediaItemId(input: unknown): string | null {
    if (input === null || typeof input !== 'object') return null;
    const candidate = (input as { mediaItemId?: unknown }).mediaItemId;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

// ── Module-level singleton + facade ───────────────────────────────────────────

let _runner: TaskRunner | null = null;
let _runnerStarting: Promise<TaskRunner> | null = null;
let _runnerStopRequested = false;

/**
 * Start the runner respecting WORKER_MODE. Returns null if workers are
 * disabled on this replica (boot wireup should treat that as "skip").
 */
export async function startTaskRunner(
    // Default to the canonical SDK enum to avoid drift when new classes
    // are added — see the comment block in orchestrator.ts:recoverOnBoot.
    classes: ResourceClass[] = [...RESOURCE_CLASSES],
    opts: TaskRunnerOpts = {},
): Promise<TaskRunner | null> {
    if (_runnerStopRequested || _runner?.isStopped()) {
        throw new Error('TaskRunner has shut down; startup refused');
    }
    if (resolveTaskProcessRole(config.WORKER_MODE, config.DEDICATED_WORKER) !== 'worker') {
        log.info('TaskRunner skipped — WORKER_MODE=disabled');
        return null;
    }
    if (_runner) return _runner;
    _runnerStarting ??= TaskRunner.start(classes, opts);
    try {
        _runner = await _runnerStarting;
        if (_runnerStopRequested || _runner.isStopped()) {
            throw new Error('TaskRunner has shut down; startup refused');
        }
        return _runner;
    } finally {
        _runnerStarting = null;
    }
}

/** True while a job runs in this process's task runner. */
export function taskRunnerHasExecutingJobs(): boolean {
    return _runner?.hasExecutingJobs() ?? false;
}

export async function stopTaskRunner(options: { strict?: boolean } = {}): Promise<void> {
    _runnerStopRequested = true;
    if (!_runner && _runnerStarting) _runner = await _runnerStarting;
    if (!_runner) {
        _runnerStopRequested = false;
        return;
    }
    const r = _runner;
    await r.stop(options);
    if (_runner === r && r.isShutdownCleanupComplete()) {
        _runner = null;
        _runnerStopRequested = false;
    }
}

/**
 * The process-wide `TaskRunner` singleton, or `null` when workers haven't
 * started on this replica yet (`WORKER_MODE=disabled`, or `startTaskRunner`
 * simply hasn't run yet — e.g. during the boot-time plugin-load window,
 * which populates the registry BEFORE `startTaskRunner` is called and so
 * doesn't need this accessor at all; see `reloadExternalPlugins` in
 * `plugins/runtime/loader.ts` for the one caller that does).
 */
export function getTaskRunner(): TaskRunner | null {
    return _runnerStopRequested || _runner?.isStopped() ? null : _runner;
}
