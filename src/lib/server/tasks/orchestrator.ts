// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// TaskOrchestrator — leader-per-class run lifecycle owner.
//
// One instance manages the full lifecycle for all resource classes in this
// replica. Per class, the orchestrator races for a Valkey lock; the winner
// subscribes to BullMQ QueueEvents and writes all Run state transitions in
// response. Non-leader replicas may still call `startRun` (writes Postgres +
// Valkey hash directly) — only QueueEvents-driven transitions are leader-
// gated.
//
// Postgres is the source of truth; Valkey is the hot cache. Every Run lands
// in `task_history` BEFORE we touch the Valkey hash so a crash mid-startRun
// is recoverable from Postgres alone.

import { Queue, QueueEvents, FlowProducer, type FlowJob } from 'bullmq';
import type postgres from 'postgres';
import { AuthorityError, type AuthorityToken } from '../../../task-runtime/authority/store.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';
import {
    withTaskQueueWrite,
    QueueOperationUncertainError,
} from '../../../task-runtime/authority/queue-write.js';
import {
    taskJobId,
    taskJobOrigin,
    sameTaskAuthority,
    assertTaskJobOrigin,
} from '../../../task-runtime/authority/queue-origin.js';
import { ulid, decodeTime } from 'ulid';
import {
    TaskError,
    RESOURCE_CLASSES,
    type ResourceClass,
    type Run,
    type RunState,
    type TaskDefinition,
    type TriggerKind,
} from '@sapd/lumastra-plugin-sdk';
import { type TaskRegistry, registry as defaultRegistry } from './registry.js';
import { StateMachine, stateMachine as defaultStateMachine } from './state-machine.js';
import { LeaderLock } from './leader-lock.js';
import { insertTaskHistoryRow } from './task-history.js';
import {
    TransitionBatcher,
    type TransitionRequest,
    type TransitionFlushResult,
} from './transition-batcher.js';
// Re-exported for backwards compatibility — these were previously declared in
// this module (orchestrator.test.ts imports them from here).
export { LeaderLock } from './leader-lock.js';
export { TransitionBatcher } from './transition-batcher.js';
import { computeIdentity, identityKey } from './identity.js';
import { parseDurationMs } from './duration.js';
import { deriveIdentityTtlFloor } from './identity-ttl-floor.js';
import { buildPipelinePlan } from './pipeline-builder.js';
import {
    PER_TASK_QUEUE_PREFIX,
    QUEUE_PREFIX,
    perTaskQueueName,
    perTaskQueueQualifiedName,
    taskQueueName,
    taskQueueQualifiedName,
} from './queue-naming.js';
import { TaskQueueRegistry } from './task-queue-registry.js';
import {
    closeQueueEventsBounded,
    isConnectionLossError,
    createOutageGate,
    logQueueConnectionErrors,
} from './queue-outage.js';
import { BULL_DEFAULT_RETENTION, taskRetryOptions } from './bull-defaults.js';
import { luaLoader } from './lua/loader.js';
import { invokeOwnedCommand } from './owned-write.js';
import { BootRecovery } from './boot-recovery.js';
import { Reconciler } from './reconciler.js';
import { OrphanSweep } from './orphan-sweep.js';
import { PendingWriteDrain, isTransientPgError } from './pending-write-drain.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { Backpressure } from './backpressure.js';
import { HardKill } from './hard-kill.js';
import {
    interruptMarkerKey,
    isResumableRun,
    RESUME_BACKOFF_BASE_MS,
    RESUME_MAX,
    type ResumableJobData,
    type ResumeInfo,
} from './run-resume.js';
import { getQueueConnection } from '$lib/server/tasks/connection.js';
import { getCoordinationClient, publishMessage } from '$lib/server/cache/valkey.js';
import type { PipelineEventDispatcher } from '$lib/server/services/pipeline-event-dispatcher.service.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { defaultConcurrencyFor } from './runner.js';
import { EXPRESS_PRIORITY_MAX } from './budget-semaphore.js';
import {
    LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS,
    LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS,
    LUMASTRA_TRANSITION_BATCH_WINDOW_MS,
    LUMASTRA_TRANSITION_BATCH_MAX,
    LUMASTRA_RUN_STATE_TTL_ACTIVE_MS,
    LUMASTRA_MAX_TASK_INPUT_BYTES,
    FEATURE_PER_TASK_QUEUES,
    dev,
} from '$lib/server/config.js';
import { shouldStartWorkers } from '$lib/server/config.js';
import {
    OUTBOX_DRAIN_INTERVAL_MS,
    OUTBOX_DRAIN_BATCH_SIZE,
    OUTBOX_DRAIN_BUDGET_MS,
    OUTBOX_DRAIN_CONCURRENCY,
} from '$lib/server/config.js';
import { cloudEvents } from './cloud-events.js';
import { toRunEvent } from './run-event.js';
import { buildSubjectPredicate } from './run-filter-sql.js';
import { publishCancel } from './cancel-channel.js';
import { WebhookOutbox } from './webhook-outbox.js';
import { PushOutbox } from './push-outbox.js';
import { createLivePushTransport } from '$lib/server/services/push/push-transport-selector.js';
import { MediaAddedNotifier } from '$lib/server/services/media-added-notifier.service.js';
import { UserNotifier } from '$lib/server/services/user-notifier.service.js';
import {
    taskRunsTotal,
    taskDurationSeconds,
    taskQueueDepth,
    taskIdentityPhantomDedupTotal,
} from './metrics.js';
import { detectVersionBumps } from '$lib/server/services/stage-version-detector.js';
import {
    type ValkeyLike,
    errMessage,
    nowIso,
    requireClient,
    emitMetaEvent,
} from './valkey-types.js';
import {
    acquireDailyQuotaSlot,
    releaseDailyQuotaSlot,
} from '$lib/server/database/queries/task-quota.queries.js';
import {
    encodeKeysetCursor,
    decodeKeysetCursor,
    pgTextTimestamp,
} from '$lib/server/database/queries/builders/keyset-cursor.builder.js';

const log = Logger.for('TaskOrchestrator');

/** Longest a shutdown waits for one QueueEvents.close() before abandoning it. */
const QUEUE_EVENTS_CLOSE_TIMEOUT_MS = 2_000;
/** Once one close timed out, Valkey is known unreachable: later closes wait less. */
const QUEUE_EVENTS_CLOSE_RETRY_TIMEOUT_MS = 200;

// Failure-log throttle (OSS-readiness diagnosability). Genuine task failures are
// surfaced to the server logs (see writeTerminalToPostgres), but a provider
// outage or a cold-start flood can fail the SAME task thousands of times — so we
// log at most one line per (taskId, error-message) per window and fold the
// suppressed repeats into a count on the next line. Keyed on the message prefix
// so distinct errors each surface; pruned + size-capped so it can't grow
// unbounded under a storm of unique messages. Best-effort, per-process.
const FAILURE_LOG_THROTTLE_MS = 60_000;
const FAILURE_LOG_THROTTLE_MAX = 1_000;
const failureLogThrottle = new Map<string, { last: number; suppressed: number }>();

// Phantom-dedup grace for an identity-key holder whose task_history row is
// ABSENT. A live run inserts its row sub-second after the identity SETNX, so any
// holder minted longer ago than this with still no row is a crash-leaked key
// (process died, or the INSERT threw without rolling back the SETNX). The grace
// dwarfs the real SETNX→INSERT latency and absorbs NTP skew, so a genuinely live
// mid-window run is never re-enqueued. See isPhantomDedup.
const PHANTOM_ABSENT_GRACE_MS = 120_000;

// Hard-kill deadline for a RE-ENTRANT hard cancel ("Force stop") on a run that is
// already 'cancelling'. The operator only reaches this path after the soft-cancel
// window has already elapsed (the Force-stop button is gated on state ===
// 'cancelling'), so the escalation should be near-immediate rather than the 60s
// soft→hard grace a first-time hard cancel uses. Small non-zero value leaves a
// breath for a run that is finalizing naturally this very tick; HardKill.execute()
// no-ops if the run is already terminal by the time it fires.
const HARD_CANCEL_REENTRANT_DEADLINE_MS = 2_000;

/**
 * Decode the mint time (epoch ms) of a `run_<ULID>` runId. The ULID's leading
 * 10 chars encode a 48-bit millisecond timestamp, so a runId is self-dating —
 * no DB lookup needed. Returns null for a malformed/non-ULID id.
 */
function decodeRunMintMs(runId: string): number | null {
    try {
        const ulidPart = runId.startsWith('run_') ? runId.slice(4) : runId;
        if (ulidPart.length < 10) return null;
        const ms = decodeTime(ulidPart);
        return Number.isFinite(ms) ? ms : null;
    } catch {
        return null;
    }
}

// Serialized task-input size cap (slow-DoS guard — large payloads amplify into
// task_history JSONB, BullMQ job data, and audit rows). Env-overridable via
// LUMASTRA_MAX_TASK_INPUT_BYTES (validated in config.ts; invalid values fall
// back to 256 KiB with a warning). Read per call — it is a live config binding.
const maxTaskInputBytes = (): number => LUMASTRA_MAX_TASK_INPUT_BYTES;

/**
 * Valkey key for the coordinator leader lock (reconciler + event dispatcher +
 * media-added notifier). Deliberately under the `lock:orch:` prefix so it is
 * routed to the coordination Valkey instance and shows up as resource
 * "coordinator" in leader audit events (leaderResourceFromKey).
 */
const COORDINATOR_LOCK_KEY = 'lock:orch:coordinator';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StartRunOpts {
    libraryGroupId?: string;
    userId?: string;
    /**
     * Caller-side priority override. Widened to match TaskDefinition.taskPriority
     * (`1 | 2 | 3 | 5 | 7`) so callers can preserve or shift the per-task rank
     * without forcing demotion to 5 or over-promotion to 1. Lower number serves
     * first. See orchestrator.startRun priority-resolution chain.
     */
    priority?: 1 | 2 | 3 | 5 | 7;
    trigger?: {
        kind: TriggerKind;
        by?: string;
        sourceRoute?: string;
        /**
         * Set only by `resumeInterruptedRun` (run-resume.ts): this run
         * continues one a worker restart interrupted. Persisted with the
         * run's trigger, so the resume count lives in Postgres.
         */
        resume?: ResumeInfo;
    };
    /**
     * Hold the job back this long before a worker may pick it up (BullMQ
     * `delay`). Used for the back-off between resumes; ignored for pipelines.
     */
    delayMs?: number;
    idempotencyKey?: string;
    parentRunId?: string;
    /**
     * The domain object this run acts upon. Persisted to `scope.subjectId` and
     * filterable via `RunFilter.subjectId` — this is how a per-item admin page
     * reconstructs "what is running for this item" from server state.
     */
    subject?: { type: 'mediaItem'; id: string };
}

export interface RunFilter {
    state?: RunState[];
    taskId?: string;
    parentRunId?: string;
    libraryGroupId?: string;
    /** Filter to runs acting on this subject (see StartRunOpts.subject). */
    subjectId?: string;
    limit?: number;
    cursor?: string; // base64url of `${started_at::text}:${id}` (see keyset-cursor.builder)
    /** Only return runs started at or after this time. */
    since?: Date;
}

/**
 * Outcome of a cancel request. `reason` says why nothing happened (or that the
 * run was already stopping): `not_found` — no such run; `terminal` — it had
 * already finished; `already_cancelling` — a soft cancel was already in
 * progress, so this one was a no-op.
 */
export interface CancelRunResult {
    accepted: boolean;
    deferred?: 'hard-kill';
    reason?: 'not_found' | 'terminal' | 'already_cancelling';
}

/** Bulk cancel by task. `orphaned` = runs that had already finished or vanished. */
export interface NuclearStopResult {
    cancelled: number;
    orphaned: number;
    /** Runs whose hard-kill was scheduled (only with `force: true`). */
    escalated: number;
}

export interface StartRunResult {
    runId: string;
    deduped?: boolean;
    existingRunId?: string;
}

export interface RecoveryReport {
    reclaimed: number;
    total: number;
    runIds: string[];
}

// ── TaskOrchestrator ──────────────────────────────────────────────────────────

interface TerminalObservation {
    run: () => Promise<void>;
    pending?: Promise<void>;
    error?: unknown;
    retryAt?: number;
}

interface ClassRuntime {
    cls: ResourceClass;
    /** Test-only, irreversible for this class runtime; never set by production loss paths. */
    crashSimulatedForTesting: boolean;
    queue: Queue;
    queueEvents: QueueEvents | null;
    /**
     * Per-task QueueEvents (Wave 8.5, FEATURE_PER_TASK_QUEUES on). When the
     * flag is on, jobs flow through per-task queues, so the leader subscribes
     * one QueueEvents per task IN THIS CLASS rather than one on the class
     * queue. These are the SOLE producer of terminal CloudEvents + webhook
     * deliveries + live SSE frames (the runner writes terminal Postgres/Valkey
     * state but emits none of those), so they must be wired on every leader and
     * torn down/rebuilt on leader-loss/re-acquire alongside the per-class one.
     */
    perTaskQueueEvents: QueueEvents[];
    leader: LeaderLock;
    batcher: TransitionBatcher;
    terminalObservations: Set<TerminalObservation>;
    /** Re-attach factory captured at bootstrap so post-loss re-acquire can re-wire QueueEvents. */
    attachQueueEventsFactory: () => QueueEvents | null;
    /** Pending re-acquire timer when leadership has been lost. */
    reacquireTimer: ReturnType<typeof setTimeout> | null;
}

export class TaskOrchestrator {
    private readonly registry: TaskRegistry;
    private readonly stateMachine: StateMachine;
    private readonly authority?: AuthorityToken;
    private readonly getSql: () => postgres.Sql | null;
    private readonly getClient: () => ValkeyLike;
    private readonly instanceId: string;
    private readonly bootId: string;
    private classes = new Map<ResourceClass, ClassRuntime>();
    private flowProducer: FlowProducer | null = null;
    // Wave 8.5 — per-task queues. When the flag is on, this owns one BullMQ
    // Queue per registered task (producer side: startRun enqueue, depth scans,
    // job-id resolution, hard-kill). Null when the flag is off.
    private readonly perTaskQueues: boolean;
    private taskQueueRegistry: TaskQueueRegistry | null = null;
    private startedAt = 0;
    private stopped = false;
    private stopPending: Promise<void> | undefined;
    private strictStopRequested = false;
    private queueEventsCloseTimeoutMs = QUEUE_EVENTS_CLOSE_TIMEOUT_MS;
    private queueEventsCloseTimeoutLogged = false;
    private readonly subscriptionLostGates = new Map<
        ResourceClass,
        ReturnType<typeof createOutageGate>
    >();
    private readonly releasedAtShutdown = new Set<object>();
    private readonly leadershipAcquisitions = new Set<Promise<boolean>>();
    private circuitBreaker: CircuitBreaker | null = null;
    private backpressure: Backpressure | null = null;
    private hardKill: HardKill | null = null;
    private reconciler: Reconciler | null = null;
    private pendingWriteDrain: PendingWriteDrain | null = null;
    private webhookOutbox: WebhookOutbox | null = null;
    private pushOutbox: PushOutbox | null = null;
    private queueDepthTimer: ReturnType<typeof setInterval> | null = null;
    /** Defense-in-depth leadership reconcile timer (zombie-leadership safety net). */
    private leadershipReconcileTimer: ReturnType<typeof setInterval> | null = null;
    // Pipeline event dispatcher — set up at boot, started/stopped by the
    // coordinator-lock lifecycle so only ONE replica cluster-wide drains the
    // event outbox.
    private eventDispatcher: PipelineEventDispatcher | null = null;
    private mediaAddedNotifier: MediaAddedNotifier | null = null;
    /**
     * Per-user notification emitter. Unlike `mediaAddedNotifier` it owns no
     * leader-gated flush loop, so it is never started or stopped, only
     * registered. Its pipeline handler runs inside the dispatcher's transaction
     * but its WRITES do not: `publishUserEvent` persists through `getDb()`, a
     * separate pooled connection, and the `request.available` branch defers its
     * Jellyseerr call to a drain that runs after the handler returns. Both are
     * deliberate — a notification row must not be rolled back with an unrelated
     * outbox failure, and network I/O must never be held inside the row lock.
     */
    private userNotifier: UserNotifier | null = null;
    /**
     * Dedicated leader lock for the singleton "coordinator" duties: the
     * reconciler, the pipeline event dispatcher, and the media-added notifier.
     *
     * These were previously gated on `isAnyLeader()` — but per-class locks are
     * elected independently, so with two or more WORKER_MODE=enabled replicas
     * class leadership naturally splits and BOTH replicas passed that gate in
     * steady state: two dispatchers drained the outbox concurrently, and
     * `FOR UPDATE SKIP LOCKED` then let replica B claim a later event for an
     * item while replica A still held an earlier one — breaking the per-item
     * ordering the stage-state seeding path relies on. A dedicated lock keeps
     * "exactly one coordinator cluster-wide" true regardless of how the class
     * locks are distributed. Single-worker deployments are unaffected (the
     * sole worker wins this lock alongside its class locks).
     */
    private coordinatorLeader: LeaderLock | null = null;
    /** Pending coordinator re-acquire timer (mirrors ClassRuntime.reacquireTimer). */
    private coordinatorReacquireTimer: ReturnType<typeof setTimeout> | null = null;
    /** Delay per resume step (run-resume.ts); a test seam shortens it. */
    private readonly resumeBackoffMs: number;

    private constructor(opts: {
        registry?: TaskRegistry;
        stateMachine?: StateMachine;
        /** Original owner for this runtime; never replaced by a successor token. */
        authority?: AuthorityToken;
        getSql?: () => postgres.Sql | null;
        getClient?: () => ValkeyLike;
        instanceId?: string;
        perTaskQueues?: boolean;
        resumeBackoffMs?: number;
    }) {
        this.resumeBackoffMs = opts.resumeBackoffMs ?? RESUME_BACKOFF_BASE_MS;
        this.registry = opts.registry ?? defaultRegistry;
        this.authority = opts.authority ? Object.freeze({ ...opts.authority }) : undefined;
        this.stateMachine =
            opts.stateMachine ??
            (this.authority
                ? new StateMachine(opts.getClient ?? requireClient, this.authority)
                : defaultStateMachine);
        this.getSql = opts.getSql ?? (() => getTaskDb());
        this.getClient = opts.getClient ?? requireClient;
        this.instanceId = opts.instanceId ?? config.INSTANCE_ID;
        this.perTaskQueues = opts.perTaskQueues ?? FEATURE_PER_TASK_QUEUES;
        this.bootId = ulid();
    }

    // -- bootstrap -----------------------------------------------------------

    static async start(
        classes: ResourceClass[],
        opts: {
            registry?: TaskRegistry;
            stateMachine?: StateMachine;
            /** Original owner for this runtime; never replaced by a successor token. */
            authority?: AuthorityToken;
            getSql?: () => postgres.Sql | null;
            getClient?: () => ValkeyLike;
            instanceId?: string;
            queueFactory?: (cls: ResourceClass) => Queue;
            queueEventsFactory?: (cls: ResourceClass) => QueueEvents | null;
            flowProducer?: FlowProducer | null;
            perTaskQueues?: boolean;
            /**
             * Test seam: supply per-task Queues without a live connection. When
             * the per-task flag is on and this is set, it replaces the real
             * TaskQueueRegistry. Receives the taskId, returns its Queue.
             */
            taskQueueFactory?: (taskId: string) => Queue;
            /** Test seam: per-task QueueEvents factory (per-task-queue path). */
            perTaskQueueEventsFactory?: (taskId: string) => QueueEvents | null;
            /** Test seam: delay per resume step (default RESUME_BACKOFF_BASE_MS). */
            resumeBackoffMs?: number;
        } = {},
    ): Promise<TaskOrchestrator> {
        const orch = new TaskOrchestrator(opts);
        await luaLoader.load();
        await orch.bootstrap(
            classes,
            opts.queueFactory,
            opts.queueEventsFactory,
            opts.flowProducer,
            opts.taskQueueFactory,
            opts.perTaskQueueEventsFactory,
        );
        return orch;
    }

    /** Test seam: per-task QueueEvents factory (per-task-queue path). */
    private perTaskQueueEventsFactory: ((taskId: string) => QueueEvents | null) | null = null;
    /** Test seam: per-task Queue factory replacing the real registry. */
    private taskQueueFactoryForTests: ((taskId: string) => Queue) | null = null;

    /**
     * Resolve the BullMQ queue a task's jobs flow through. Per-task queue when
     * FEATURE_PER_TASK_QUEUES is on; legacy per-class queue otherwise. The
     * single seam every enqueue/scan/hard-kill path routes through so the
     * flag-on vs flag-off fork lives in exactly one place.
     */
    private resolveTaskQueue(taskId: string): Queue | undefined {
        if (this.perTaskQueues) {
            if (this.taskQueueFactoryForTests) return this.taskQueueFactoryForTests(taskId);
            return this.taskQueueRegistry?.getQueue(taskId);
        }
        const task = this.registry.getTask(taskId);
        return task ? this.classes.get(task.resourceClass)?.queue : undefined;
    }

    /**
     * Every queue that may hold a job, for full-scan resolution
     * (resolveJobIdForRun / resolveRunIdFromJobId). Per-task queues when the
     * flag is on; per-class queues otherwise.
     */
    private allEnqueueQueues(): Queue[] {
        if (this.perTaskQueues) {
            if (this.taskQueueFactoryForTests) {
                return this.registry.getAllTasks().map((t) => this.taskQueueFactoryForTests!(t.id));
            }
            return this.taskQueueRegistry ? [...this.taskQueueRegistry.allQueues()] : [];
        }
        return Array.from(this.classes.values(), (rt) => rt.queue);
    }

    /**
     * The per-task queues belonging to a resource class. Used by backpressure
     * (sum their depths) and depth metrics under the per-task flag. Empty when
     * the flag is off — callers gate on `this.perTaskQueues` before calling.
     */
    private queuesForClass(cls: ResourceClass): Queue[] {
        const out: Queue[] = [];
        for (const task of this.registry.getAllTasks()) {
            if (task.resourceClass !== cls) continue;
            const q = this.resolveTaskQueue(task.id);
            if (q) out.push(q);
        }
        return out;
    }

    private async bootstrap(
        classes: ResourceClass[],
        queueFactory?: (cls: ResourceClass) => Queue,
        queueEventsFactory?: (cls: ResourceClass) => QueueEvents | null,
        flowProducerOverride?: FlowProducer | null,
        taskQueueFactory?: (taskId: string) => Queue,
        perTaskQueueEventsFactory?: (taskId: string) => QueueEvents | null,
    ): Promise<void> {
        this.startedAt = Date.now();
        const leadershipEnabled = shouldStartWorkers();
        const connection = getQueueConnection();
        if (!connection && !queueFactory) {
            throw new Error('TaskOrchestrator: cannot start — CACHE_URL not configured');
        }

        // Wave 8.5 — per-task queues. Materialise one BullMQ Queue per
        // registered task so startRun enqueue, depth scans, job-id resolution,
        // and hard-kill all resolve a stable Queue handle. The registry is the
        // PRODUCER side; the runner (consumer side) spawns matching Workers from
        // the same queue-naming helpers. A test seam (`taskQueueFactory`) lets
        // unit tests inject fakes without a live connection.
        this.perTaskQueueEventsFactory = perTaskQueueEventsFactory ?? null;
        this.taskQueueFactoryForTests = taskQueueFactory ?? null;
        if (this.perTaskQueues && !taskQueueFactory && connection) {
            this.taskQueueRegistry = new TaskQueueRegistry({ connection });
            // Eagerly create every task's queue so allQueues()/depth scans see
            // the full set without a lazy-creation race.
            this.taskQueueRegistry.materializeAll(this.registry.getAllTasks());
        }

        // Construct the Reconciler before the class loop so `acquired` paths
        // can call `this.reconciler?.start()`. Previously this construction
        // happened AFTER the loop and the `?.` no-op'd on initial single-
        // replica boot — orphan recovery never started.
        const sqlForReconciler = this.getSql();
        if (sqlForReconciler) {
            const orphanSweep = new OrphanSweep(
                (cls) => this.classes.get(cls)?.queue,
                async () => this.getClient() as ValkeyLike,
                this.perTaskQueues
                    ? {
                          tasks: () => this.registry.getAllTasks().map((t) => t.id),
                          getQueueByTaskId: (taskId) => this.resolveTaskQueue(taskId),
                      }
                    : undefined,
                this.authority,
                this.getSql,
            );
            this.pendingWriteDrain = new PendingWriteDrain(
                sqlForReconciler,
                async () => this.getClient() as ValkeyLike,
                this.authority,
            );
            // Started with the other coordinator-gated loops on acquisition.
            this.reconciler = new Reconciler(
                sqlForReconciler,
                this.stateMachine,
                async () => this.getClient() as ValkeyLike,
                (taskId: string) => this.resolveTaskQueue(taskId),
                orphanSweep,
                this.pendingWriteDrain,
                () => this.isCoordinator(),
                this.perTaskQueues,
                // #01 Phase 0: background-reclaimed runs emit the same terminal
                // CloudEvent + webhook as a normal transition.
                (taskId, runId, to, extra) => this.emitTerminalCloudEvent(taskId, runId, to, extra),
                // Slice 3 §4.4: per-class queue-depth probe for the trend
                // snapshot writer piggybacked on the reconciler tick.
                () => this.getQueueDepths(),
                // Cancel-grace force-finalize: a run wedged in 'cancelling' past
                // CANCEL_GRACE_MS is hard-killed (terminal write + BullMQ job
                // removal) regardless of heartbeat, finalizing lock-loss zombies
                // the stale-heartbeat reclaim cannot reach. Lazily reads
                // this.hardKill (constructed below) — safe because the closure
                // only runs on a later reconciler tick.
                async (runId: string, authority?: AuthorityToken) => {
                    if (!sameTaskAuthority(authority, this.authority))
                        throw new AuthorityError('stale_authority');
                    await this.hardKill?.execute(runId, authority);
                },
                // Resume-after-restart for interrupted manual runs.
                (req) => this.resumeInterruptedRun(req),
                this.registry,
                this.authority,
            );

            // Construct the pipeline event dispatcher. Started/stopped by the
            // coordinator-lock lifecycle (same as the reconciler) so only one
            // replica cluster-wide drains the outbox. The feature_flags row
            // controls whether DB triggers write events at all; with the flag
            // off (default) the dispatcher's drain query returns zero
            // rows and the service is a no-op even when started.
            try {
                const mod =
                    await import('$lib/server/services/pipeline-event-dispatcher.service.js');
                this.eventDispatcher = new mod.PipelineEventDispatcher({
                    sql: sqlForReconciler,
                    isLeader: () => this.isCoordinator(),
                    batchSize: OUTBOX_DRAIN_BATCH_SIZE,
                    drainIntervalMs: OUTBOX_DRAIN_INTERVAL_MS,
                    drainBudgetMs: OUTBOX_DRAIN_BUDGET_MS,
                    drainConcurrency: OUTBOX_DRAIN_CONCURRENCY,
                });
            } catch (err) {
                log.warn('PipelineEventDispatcher construction failed; outbox draining disabled', {
                    err: errMessage(err),
                });
            }

            // Construct WebhookOutbox and MediaAddedNotifier here — before the
            // class-acquire loop — so this.mediaAddedNotifier is non-null when
            // the loop calls this.mediaAddedNotifier?.start() on first leader
            // acquisition. Constructing them after the loop (as the original
            // code did) meant the ?. guards always no-op'd on a fresh worker
            // that wins leadership immediately and never loses it.
            // Delivery loops start with coordinator leadership (tryAcquireCoordinator).
            this.webhookOutbox = new WebhookOutbox(sqlForReconciler);
            // Relay or straight to Apple with the operator's own signing key —
            // see `push-transport-selector.ts` for the rule. Resolved here so a
            // misconfigured `.p8` is reported at startup, and re-resolved when
            // the push settings change (no restart needed).
            this.pushOutbox = new PushOutbox(sqlForReconciler, createLivePushTransport());
            this.mediaAddedNotifier = new MediaAddedNotifier(
                sqlForReconciler,
                this.webhookOutbox,
                () => this.isCoordinator(),
            );
            this.mediaAddedNotifier.registerHandler();

            // Second handler on the same `media.becamePlayable` event, addressed
            // at users rather than at the operator's webhooks
            // (docs/architecture/user-events.md, "Emitters and hook points").
            // Registered here so it only ever runs on a worker replica — the
            // dispatcher pod — which is also why its delivery has to be a
            // durable row and not a local SSE broadcast.
            this.userNotifier = new UserNotifier();
            this.userNotifier.registerHandler();
        }

        // Whether THIS instance participates in leader election. Worker replicas
        // (WORKER_MODE=enabled) lead and run the reconciler/scheduler/dispatcher;
        // web replicas (WORKER_MODE=disabled) only enqueue. See the gate inside
        // the loop below for the full rationale (prod 2026-06-13 wedge).
        for (const cls of classes) {
            const queueName = taskQueueName(cls);
            let queue: Queue;
            if (queueFactory) {
                queue = queueFactory(cls);
            } else if (connection) {
                queue = new Queue(queueName, {
                    connection,
                    prefix: QUEUE_PREFIX,
                    defaultJobOptions: BULL_DEFAULT_RETENTION,
                });
            } else {
                throw new Error('TaskOrchestrator: no connection available for Queue');
            }
            logQueueConnectionErrors(queue, `class-queue:${cls}`);
            const leader = new LeaderLock(
                this.getClient(),
                `lock:orch:${cls}`,
                `${this.instanceId}:${this.bootId}`,
                LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS,
                LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS,
                this.authority,
            );
            const batcher = new TransitionBatcher(
                LUMASTRA_TRANSITION_BATCH_WINDOW_MS,
                LUMASTRA_TRANSITION_BATCH_MAX,
                (batch) =>
                    this.flushTransitions(
                        batch,
                        () => this.classes.get(cls)?.crashSimulatedForTesting ?? false,
                    ),
            );

            // Capture the QueueEvents construction strategy so re-acquire can
            // rebuild after a leader-lost event without re-running bootstrap.
            const attachQueueEventsFactory = (): QueueEvents | null => {
                if (queueEventsFactory) return queueEventsFactory(cls);
                if (connection)
                    return new QueueEvents(queueName, {
                        connection,
                        prefix: QUEUE_PREFIX,
                    });
                return null;
            };

            const rt: ClassRuntime = {
                cls,
                crashSimulatedForTesting: false,
                queue,
                queueEvents: null,
                perTaskQueueEvents: [],
                leader,
                batcher,
                terminalObservations: new Set(),
                attachQueueEventsFactory,
                reacquireTimer: null,
            };
            this.classes.set(cls, rt);

            // Only WORKER_MODE=enabled instances participate in leader election
            // and run leader duties (reconciler / event-dispatcher / scheduler).
            // A WORKER_MODE=disabled web replica still constructs the queue above
            // so `startRun` can ENQUEUE, but it must NEVER win leadership: its
            // TaskRunner is not started (runner.ts — `WORKER_MODE=disabled` skip),
            // so a reconciler running here would have NO BullMQ queues/workers and
            // silently fail to reclaim orphans — wedging the whole cluster.
            // Observed on prod 2026-06-13: the web container won `lock:orch:*` and
            // ran a queue-less reconciler; stale-active + stuck-pending runs
            // accumulated for days until the io budget saturated and ALL drain
            // stalled. Gating election on `shouldStartWorkers()` keeps leadership
            // (and self-healing reclaim) on the worker, matching the intended
            // topology (web never leads).
            if (!leadershipEnabled) {
                log.info('Leader election skipped — WORKER_MODE=disabled (enqueue-only)', {
                    cls,
                });
                continue;
            }

            // Try to acquire leadership; if we get it, wire QueueEvents.
            try {
                if (rt.crashSimulatedForTesting) continue;
                const acquired = await this.acquireLeadership(leader);
                if (this.stopped) return;
                if (rt.crashSimulatedForTesting) {
                    leader.stop();
                    continue;
                }
                if (acquired) {
                    log.info('Leader acquired for class', {
                        cls,
                        instance: this.instanceId,
                    });
                    this.attachQueueEventsForLeader(rt);
                    leader.onLost(() => this.handleLeaderLost(rt));
                    // Reconciler/dispatcher/notifier are NOT started here — they
                    // belong to the coordinator lock's lifecycle (acquired after
                    // this loop), not to per-class leadership. See coordinatorLeader.
                } else {
                    log.info('Not leader for class — running as standby', {
                        cls,
                    });
                    // Standby replicas keep retrying so they can take over when
                    // the current leader exits or crashes. Same loop is used by
                    // post-loss recovery.
                    this.scheduleReacquire(rt);
                }
            } catch (err) {
                log.warn('Leader acquisition errored', {
                    cls,
                    err: errMessage(err),
                });
                this.scheduleReacquire(rt);
            }
        }

        // Coordinator election — the dedicated lock gating the reconciler,
        // event dispatcher, and media-added notifier (see coordinatorLeader
        // field doc). Same WORKER_MODE gate as class election: a web replica
        // must never coordinate (its runner isn't started, so a reconciler
        // here could not reclaim orphans — the prod 2026-06-13 wedge).
        if (leadershipEnabled) {
            this.coordinatorLeader = new LeaderLock(
                this.getClient(),
                COORDINATOR_LOCK_KEY,
                `${this.instanceId}:${this.bootId}`,
                LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS,
                LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS,
                this.authority,
            );
            await this.tryAcquireCoordinator();
        }

        if (flowProducerOverride !== undefined) {
            this.flowProducer = flowProducerOverride;
        } else if (connection) {
            this.flowProducer = new FlowProducer({
                connection,
                prefix: QUEUE_PREFIX,
            });
        }
        logQueueConnectionErrors(this.flowProducer, 'flow-producer');

        const sql = this.getSql();
        if (sql) {
            this.circuitBreaker = new CircuitBreaker(sql, () => this.getClient());
        }
        this.backpressure = new Backpressure(
            (cls) => {
                const rt = this.classes.get(cls);
                if (!rt) throw new Error(`No queue for class: ${cls}`);
                return rt.queue;
            },
            // Per-task path: depth is summed across the class's per-task queues.
            this.perTaskQueues ? (cls) => this.queuesForClass(cls) : undefined,
        );

        const getClientForHardKill = (): ValkeyLike => this.getClient();
        this.hardKill = new HardKill(
            this.getSql,
            // Resolve the queue a task's jobs live on (per-task when the flag is
            // on, per-class otherwise). HardKill derives the Redis key prefix
            // from the queue's own opts, so this works for both keyspaces.
            (taskId) => this.resolveTaskQueue(taskId),
            getClientForHardKill,
            this.stateMachine,
            async (runId) => this.resolveJobIdForRun(runId),
            // A hard-kill writes the terminal `cancelled` state directly,
            // bypassing the runner's normal terminal path — so it must emit the
            // same CloudEvent + webhook here or hard-killed runs silently diverge
            // from dashboards/webhooks (TASK-C2). Guarded internally against
            // double-emit via the finalize UPDATE's RETURNING-id no-op check.
            (taskId, runId, to, extra, authority) => {
                if (!sameTaskAuthority(authority, this.authority))
                    throw new AuthorityError('stale_authority');
                return this.emitTerminalCloudEvent(taskId, runId, to, extra);
            },
            this.authority,
        );

        // Every process keeps live hook filters for enqueue(). Delivery (webhook
        // and push) is coordinator-gated, started on coordinator acquisition,
        // so shutdown and coordinator loss can fence it with the lock.
        this.webhookOutbox?.start({ deliver: false });

        // Reconciler + pending-write drain were already constructed at the
        // top of bootstrap so the class-acquire loop can start them.

        // Only the coordinator publishes queue-depth metrics.
        if (leadershipEnabled) {
            this.queueDepthTimer = setInterval(() => void this.updateQueueDepthMetrics(), 15_000);
            this.queueDepthTimer.unref?.();
        }

        // Defense-in-depth: a slow safety net that detects "this process believes it
        // leads class X but Valkey disagrees" (a zombie leader) and routes it through
        // the normal loss → re-acquire path, so leadership re-converges on its own.
        // Only run on instances that participate in leadership — a web replica
        // (WORKER_MODE=disabled) must never (re-)acquire (see the class loop gate).
        if (leadershipEnabled) {
            this.leadershipReconcileTimer = setInterval(
                () => void this.reconcileLeadership(),
                15_000,
            );
            if (typeof this.leadershipReconcileTimer.unref === 'function') {
                this.leadershipReconcileTimer.unref();
            }
        }
    }

    private async updateQueueDepthMetrics(): Promise<void> {
        // Gate to a single replica so multiple replicas don't overwrite
        // the gauge on every poll cycle (last-writer-wins race). The
        // coordinator lock is held by exactly one replica cluster-wide;
        // per-class leadership can split, so isAnyLeader() would not do.
        if (!this.isCoordinator()) return;
        for (const rt of this.classes.values()) {
            try {
                let waiting: number;
                if (this.perTaskQueues) {
                    // Per-class queue is idle under the flag — sum the class's
                    // per-task queues so the gauge reflects real backlog.
                    waiting = 0;
                    for (const q of this.queuesForClass(rt.cls)) {
                        waiting += await q.getWaitingCount();
                    }
                } else {
                    waiting = await rt.queue.getWaitingCount();
                }
                taskQueueDepth.set({ queue: `task:${rt.cls}`, resource_class: rt.cls }, waiting);
            } catch {
                // Best-effort — queue may be unavailable briefly.
            }
        }
    }

    /**
     * Snapshot of per-class queue depths for the admin UI's QueueDepthBar.
     * Each entry mirrors what BullMQ's getJobCounts reports plus the queue's
     * own paused state.
     *
     * `paused` comes from `Queue#isPaused()`, NOT from a 'paused' job count.
     * BullMQ 6 removed the `paused` job state — jobs in a paused queue are
     * reported as `waiting` — and the old `counts.paused > 0` test was wrong
     * even on v5: it reported false for a queue that was paused but empty,
     * which is exactly the state the admin UI most needs to show.
     */
    async getQueueDepths(): Promise<
        Record<
            ResourceClass,
            {
                waiting: number;
                active: number;
                delayed: number;
                paused: boolean;
            }
        >
    > {
        const out = {} as Record<
            ResourceClass,
            {
                waiting: number;
                active: number;
                delayed: number;
                paused: boolean;
            }
        >;
        for (const rt of this.classes.values()) {
            try {
                if (this.perTaskQueues) {
                    // Aggregate the class's per-task queues — the per-class queue
                    // is idle under the flag, so reading it would report all-zero.
                    let waiting = 0;
                    let active = 0;
                    let delayed = 0;
                    let paused = false;
                    for (const q of this.queuesForClass(rt.cls)) {
                        const c = await q.getJobCounts('waiting', 'active', 'delayed');
                        waiting += c.waiting ?? 0;
                        active += c.active ?? 0;
                        delayed += c.delayed ?? 0;
                        paused = paused || (await q.isPaused());
                    }
                    out[rt.cls] = { waiting, active, delayed, paused };
                } else {
                    const counts = await rt.queue.getJobCounts('waiting', 'active', 'delayed');
                    out[rt.cls] = {
                        waiting: counts.waiting ?? 0,
                        active: counts.active ?? 0,
                        delayed: counts.delayed ?? 0,
                        paused: await rt.queue.isPaused(),
                    };
                }
            } catch {
                // best-effort: queue-depth probe must not throw — report zeroes for this class.
                out[rt.cls] = {
                    waiting: 0,
                    active: 0,
                    delayed: 0,
                    paused: false,
                };
            }
        }
        return out;
    }

    /**
     * Per-task queue depth breakdown for the admin queue drill-down. Empty when
     * the per-task flag is off (no per-task queues exist). Each entry carries
     * the task's effective resourceClass (post-shim physical class) and its
     * declared class when the legacy-class shim rewrote it, so the UI can show
     * "ingest → io" provenance.
     */
    async getPerTaskQueueDepths(): Promise<
        Array<{
            taskId: string;
            resourceClass: ResourceClass;
            declaredResourceClass?: ResourceClass;
            waiting: number;
            active: number;
            delayed: number;
        }>
    > {
        if (!this.perTaskQueues) return [];
        const out: Array<{
            taskId: string;
            resourceClass: ResourceClass;
            declaredResourceClass?: ResourceClass;
            waiting: number;
            active: number;
            delayed: number;
        }> = [];
        for (const task of this.registry.getAllTasks()) {
            const queue = this.resolveTaskQueue(task.id);
            if (!queue) continue;
            try {
                const c = await queue.getJobCounts('waiting', 'active', 'delayed');
                out.push({
                    taskId: task.id,
                    resourceClass: task.resourceClass,
                    declaredResourceClass: task.declaredResourceClass,
                    waiting: c.waiting ?? 0,
                    active: c.active ?? 0,
                    delayed: c.delayed ?? 0,
                });
            } catch {
                // Skip a transiently-unavailable queue rather than fail the set.
            }
        }
        return out;
    }

    /**
     * BullMQ stalled-job counts per resource class (Slice 3 §4.3).
     *
     * BullMQ tracks stalled jobs in a Redis SET at `<prefix>:<queue>:stalled`.
     * We read each set's cardinality via `SCARD` over the STATIC
     * `RESOURCE_CLASSES` registry (and the registered task list under the
     * per-task flag) — NEVER a keyspace `SCAN`/`KEYS` (the task keyspace is
     * ~1M keys; a SCAN would be both slow and lossy). The Redis connection is
     * the shared Valkey client the rest of the orchestrator already holds.
     *
     * Best-effort: a SCARD failure (or a missing set) yields `0` for that
     * class, never throws — an observability probe must not break on Valkey.
     */
    async getStalledCounts(): Promise<Record<ResourceClass, number>> {
        const out = {} as Record<ResourceClass, number>;
        let client: ValkeyLike;
        try {
            client = this.getClient();
        } catch {
            // Valkey not connected — report all-zero rather than throwing.
            for (const cls of RESOURCE_CLASSES) out[cls] = 0;
            return out;
        }

        const scard = async (key: string): Promise<number> => {
            try {
                const res = await client.customCommand(['SCARD', key]);
                const n = typeof res === 'bigint' ? Number(res) : Number(res ?? 0);
                return Number.isFinite(n) && n > 0 ? n : 0;
            } catch {
                return 0;
            }
        };

        for (const cls of RESOURCE_CLASSES) {
            if (this.perTaskQueues) {
                // Per-task path: sum the class's registered tasks' stalled sets.
                let total = 0;
                for (const task of this.registry.getAllTasks()) {
                    if (task.resourceClass !== cls) continue;
                    total += await scard(`${perTaskQueueQualifiedName(task.id)}:stalled`);
                }
                out[cls] = total;
            } else {
                out[cls] = await scard(`${taskQueueQualifiedName(cls)}:stalled`);
            }
        }
        return out;
    }

    /**
     * Configured per-resource-class concurrency caps. Exposed for the
     * IngestMap station tooltip so it can show "active/cap" ratios
     * alongside queue depth. Sourced from `defaultConcurrencyFor` (the
     * same helper the runner uses to size each Worker) iterated over
     * the canonical `RESOURCE_CLASSES` list — adding a new resource
     * class in one place (the SDK enum) propagates here automatically,
     * no second source of truth to keep in sync.
     *
     * **Note**: these are the boot-time / module-load values of
     * LUMASTRA_CONCURRENCY_*. Workers can have been started with
     * different caps if a config update happened mid-process AND a
     * restart hasn't fired yet (the schema marks these `requiresRestart`).
     * For the tooltip's "Active N / cap" the boot-time value matches
     * what workers actually enforce — the schema's restart contract
     * ensures consistency. Mid-process drift is a known and bounded
     * window between admin-edit and restart.
     */
    getConcurrencyCaps(): Record<ResourceClass, number> {
        const out = {} as Record<ResourceClass, number>;
        for (const cls of RESOURCE_CLASSES) {
            out[cls] = defaultConcurrencyFor(cls);
        }
        return out;
    }

    /**
     * Returns true if this instance holds the leader lock for at least one
     * resource class. Used by the reconciler's getIsLeader guard.
     */
    private isAnyLeader(): boolean {
        for (const rt of this.classes.values()) {
            if (rt.leader.isHeld()) return true;
        }
        return false;
    }

    /**
     * Returns true if this instance holds the dedicated coordinator lock —
     * the gate for the reconciler, event dispatcher, and media-added notifier
     * tick predicates. Distinct from `isAnyLeader()`: per-class leadership can
     * split across replicas, the coordinator cannot.
     */
    private isCoordinator(): boolean {
        return this.coordinatorLeader?.isHeld() ?? false;
    }

    private acquireLeadership(leader: LeaderLock): Promise<boolean> {
        const pending = leader.acquire();
        this.leadershipAcquisitions.add(pending);
        void pending.then(
            () => this.leadershipAcquisitions.delete(pending),
            () => this.leadershipAcquisitions.delete(pending),
        );
        return pending;
    }

    /**
     * Attempt to acquire the coordinator lock. On success, wires onLost and
     * starts the coordinator-gated services; on failure (a peer coordinates,
     * or Valkey errored), arms the jittered re-acquire loop so this replica
     * can take over when the current coordinator exits or crashes.
     */
    private async tryAcquireCoordinator(): Promise<void> {
        if (this.stopped || !this.coordinatorLeader) return;
        try {
            const acquired = await this.acquireLeadership(this.coordinatorLeader);
            if (this.stopped) return;
            if (acquired) {
                log.info('Coordinator leadership acquired', {
                    instance: this.instanceId,
                });
                this.coordinatorLeader.onLost(() => this.handleCoordinatorLost());
                // start() is idempotent on all of them — a no-op when already
                // running (e.g. re-acquire after a brief loss). A tick still
                // finishing from before the loss blocks an overlapping one.
                this.reconciler?.start();
                this.eventDispatcher?.start();
                this.mediaAddedNotifier?.start();
                this.pendingWriteDrain?.start();
                this.webhookOutbox?.start();
                this.pushOutbox?.start();
                // 🔴 The only place version-bump detection is guaranteed to
                // run. `recoverOnBoot()` has no production caller, and the
                // per-class `tryReacquire` path fires only for a standby that
                // takes over later, so a single replica that wins every lock on
                // its first attempt never ran the detector: on prod the
                // album/artist-enrichment ledgers sat at their 2026-06-11
                // values while their completed rows carried the bumped version.
                // One coordinator exists cluster-wide, so this fires once per
                // takeover; the SETNX guard de-duplicates against the
                // per-class path.
                void this.runDetectVersionBumpsIfLeader();
            } else {
                this.scheduleCoordinatorReacquire();
            }
        } catch (err) {
            log.warn('Coordinator acquisition errored', {
                err: errMessage(err),
            });
            this.scheduleCoordinatorReacquire();
        }
    }

    /** Coordinator lock lost — stop the singleton services and retry acquisition. */
    private handleCoordinatorLost(): void {
        if (this.stopped) return;
        log.warn('Coordinator leadership lost — stopping the coordinator-gated loops', {
            instance: this.instanceId,
        });
        // No new ticks from here; the reconciler's in-flight sweep also aborts
        // before its next mutating step. In-flight ticks are awaited in the
        // background (the lock is already gone, nothing to hold for them).
        const loops = [
            ['reconciler', this.reconciler?.stop()],
            ['pending-write-drain', this.pendingWriteDrain?.stop()],
            ['webhook-outbox', this.webhookOutbox?.stopDelivery()],
            ['push-outbox', this.pushOutbox?.stopDelivery()],
        ] as const;
        this.eventDispatcher?.stop();
        this.mediaAddedNotifier?.stop();
        for (const [loop, stopping] of loops)
            void stopping?.then((settled) => {
                if (!settled)
                    log.warn('Coordinator lost: loop tick still running after stop timeout', {
                        loop,
                    });
            });
        this.scheduleCoordinatorReacquire();
    }

    /** Coordinator counterpart of scheduleReacquire — 5-7s jittered retry. */
    private scheduleCoordinatorReacquire(): void {
        if (this.stopped) return;
        if (this.coordinatorReacquireTimer) return;
        const delayMs = 5_000 + Math.floor(Math.random() * 2_000);
        this.coordinatorReacquireTimer = setTimeout(() => {
            this.coordinatorReacquireTimer = null;
            void this.tryAcquireCoordinator();
        }, delayMs);
        if (typeof this.coordinatorReacquireTimer.unref === 'function') {
            this.coordinatorReacquireTimer.unref();
        }
    }

    /**
     * Returns true when the orchestrator is running (not stopped) and has at
     * least one class registered with an active queue. Used by the readiness
     * endpoint to confirm the orchestrator has completed bootstrap.
     */
    isHealthy(): boolean {
        return !this.stopped && this.classes.size > 0;
    }

    /**
     * Returns true when this instance holds the leader lock for at least one
     * resource class. Exposed for the readiness endpoint.
     */
    isLeaderForAnyClass(): boolean {
        return this.isAnyLeader();
    }

    /**
     * Test-only: irreversibly stop leadership for one class in this runtime.
     * Stops renewal, subscriptions and acquisition without releasing the Valkey
     * lock, leaving the orphaned lease to expire on its normal TTL. In-flight
     * acquisitions cannot restore local leadership or subscriptions.
     *
     * This is a class-only simulation, not a process SIGKILL: other classes,
     * coordinator duties and enqueue APIs continue running on this instance.
     *
     * Returns true if the class was found and crash-simulated, false if
     * this orchestrator does not own that class. Throws if invoked on a
     * non-leader replica — that would cancel the standby's reacquire timer
     * and silently disable it for the rest of the test, an unfaithful
     * simulation of a crash.
     *
     * @internal
     */
    simulateCrashForTesting(cls: ResourceClass): boolean {
        const rt = this.classes.get(cls);
        if (!rt) return false;
        if (!rt.leader.isHeld()) {
            throw new Error(
                `simulateCrashForTesting(${cls}): instance is not the leader for this class — only the live leader can be crashed in a replica-handoff test`,
            );
        }
        // Set before stopping: reconciliation and already-awaiting acquisitions
        // must never re-arm this class. Production loss paths leave it false.
        rt.crashSimulatedForTesting = true;
        // Drop test-dead observation/retry work. stop() blocks new enqueues;
        // the crash-aware sink drops its buffered work instead of persisting it.
        // A mutation already submitted before the crash cannot be rolled back.
        rt.terminalObservations.clear();
        void rt.batcher.stop().catch((err: unknown) => {
            log.warn('Crash simulation batcher stop failed', { cls, err: errMessage(err) });
        });
        // 1. Kill the renew timer so the lock TTL is no longer extended.
        rt.leader.stop();
        // 2. Clear remaining local renewal bookkeeping without firing the
        //    normal onLost callback, which schedules ordinary recovery.
        rt.leader._clearHeldStateForTesting();
        // 3. Cancel any retry already scheduled before the crash marker.
        if (rt.reacquireTimer) {
            clearTimeout(rt.reacquireTimer);
            rt.reacquireTimer = null;
        }
        if (rt.queueEvents) {
            void rt.queueEvents.close().catch(() => {});
            rt.queueEvents = null;
        }
        this.closePerTaskQueueEvents(rt);
        return true;
    }

    /**
     * Wire the run-lifecycle handlers onto a QueueEvents subscription. The
     * `'completed'`/`'failed'` handlers feed the class batcher → flushTransitions
     * → terminal Postgres write + terminal CloudEvent + webhook enqueue. These
     * are the SOLE producer of terminal CloudEvents/webhooks/SSE, so they must
     * be wired on whatever queues jobs actually flow through (per-class when the
     * flag is off, per-task when on). Shared by both attach paths.
     */
    private wireQueueEventsHandlers(rt: ClassRuntime, qe: QueueEvents): void {
        const terminal = async (jobId: string, state: 'completed' | 'failed'): Promise<void> => {
            if (rt.crashSimulatedForTesting) return;
            // The event's producer, not the subscriber's new leadership, owns
            // this write. Job IDs retain provenance after removeOnComplete.
            const origin = taskJobOrigin(jobId);
            if (!sameTaskAuthority(origin, this.authority)) return;
            const runId = this.runIdFromJobId(jobId);
            if (!runId) return;
            const queueName = qe.name ?? rt.queue?.name;
            const queue = this.allEnqueueQueues().find((entry) => entry.name === queueName);
            const job = await queue?.getJob(jobId);
            if (rt.crashSimulatedForTesting) return;
            if (!queue || !job) {
                if (await this.terminalPersistenceConfirmed(runId, state)) return;
                throw new Error('UNKNOWN: terminal observation queue job unavailable');
            }
            const currentState = await job.getState();
            if (rt.crashSimulatedForTesting || currentState !== state) return;
            assertTaskJobOrigin(this.authority, job.data.taskAuthority, job.id);
            const attemptsMade = job.attemptsMade;
            if (!Number.isSafeInteger(attemptsMade) || attemptsMade < 0)
                throw new Error('UNKNOWN: terminal observation attempt unavailable');
            const value =
                state === 'completed' ? safeShort(job.returnvalue) : safeShort(job.failedReason);
            const completedAt = new Date(job.finishedOn ?? Date.now()).toISOString();
            if (state === 'completed' && isRefusedRedelivery(value)) return;
            rt.batcher.enqueue({
                runId,
                from: 'active',
                to: state,
                origin,
                job: { id: jobId, queueName: queue.name },
                extra: {
                    ...(state === 'completed'
                        ? { completedAt, returnvalue: safeShort(value) }
                        : { failedAt: completedAt, errorMessage: safeShort(value) }),
                    ...(attemptsMade === undefined ? {} : { queueAttemptsMade: attemptsMade }),
                },
            });
        };
        const admit = (jobId: string, state: 'completed' | 'failed'): void => {
            if (this.stopped || rt.crashSimulatedForTesting) return;
            const observation: TerminalObservation = { run: () => terminal(jobId, state) };
            rt.terminalObservations.add(observation);
            this.runTerminalObservation(rt, observation);
        };
        qe.on('completed', ({ jobId }) => admit(jobId, 'completed'));
        qe.on('failed', ({ jobId }) => admit(jobId, 'failed'));
        // Every QueueEvents of a class errors on every reconnect attempt while
        // Valkey is down: log once per outage (shared gate) and tell SSE
        // subscribers once per class and outage.
        logQueueConnectionErrors(qe, `queue-events:${rt.cls}`);
        qe.on('error', (err: Error) => {
            if (rt.crashSimulatedForTesting) return;
            // Only connection loss repeats per reconnect attempt; any other error is news.
            if (isConnectionLossError(err)) {
                let gate = this.subscriptionLostGates.get(rt.cls);
                if (!gate) {
                    gate = createOutageGate();
                    this.subscriptionLostGates.set(rt.cls, gate);
                }
                if (!gate.note().first) return;
            }
            void this.emitMeta('subscription-lost', {
                cls: rt.cls,
                error: err.message,
            });
        });
    }

    private runTerminalObservation(rt: ClassRuntime, observation: TerminalObservation): void {
        if (rt.crashSimulatedForTesting) {
            rt.terminalObservations.delete(observation);
            return;
        }
        if (observation.pending) return;
        observation.retryAt = performance.now() + 1000;
        observation.error = undefined;
        observation.pending = observation
            .run()
            .then(
                () => {
                    rt.terminalObservations.delete(observation);
                },
                (error: unknown) => {
                    if (rt.crashSimulatedForTesting) return;
                    observation.error = error;
                    log.warn('Rejected queue terminal observation', {
                        cls: rt.cls,
                        err: errMessage(error),
                    });
                },
            )
            .finally(() => {
                observation.pending = undefined;
            });
    }

    /** Legacy per-class attach — stores the single QueueEvents on the runtime. */
    private attachQueueEvents(rt: ClassRuntime, qe: QueueEvents): void {
        rt.queueEvents = qe;
        this.wireQueueEventsHandlers(rt, qe);
    }

    /**
     * Attach QueueEvents for a newly-acquired leader. Flag-off: one subscription
     * on the per-class queue. Flag-on: one subscription per task IN THIS CLASS,
     * because jobs flow through per-task queues and the per-class queue is idle.
     * Idempotent-ish — callers (boot + re-acquire) start from a clean rt.
     */
    private attachQueueEventsForLeader(rt: ClassRuntime): void {
        if (this.perTaskQueues) {
            this.attachPerTaskQueueEvents(rt);
            return;
        }
        const qe = rt.attachQueueEventsFactory();
        if (qe) this.attachQueueEvents(rt, qe);
    }

    /**
     * Build + wire one QueueEvents per task whose resourceClass is this leader's
     * class. Stored on rt.perTaskQueueEvents so leader-loss can close them all.
     */
    private attachPerTaskQueueEvents(rt: ClassRuntime): void {
        const connection = getQueueConnection();
        const tasks = this.registry.getAllTasks().filter((t) => t.resourceClass === rt.cls);
        for (const task of tasks) {
            let qe: QueueEvents | null = null;
            if (this.perTaskQueueEventsFactory) {
                qe = this.perTaskQueueEventsFactory(task.id);
            } else if (connection) {
                qe = new QueueEvents(perTaskQueueName(task.id), {
                    connection,
                    prefix: PER_TASK_QUEUE_PREFIX,
                });
            }
            if (!qe) continue;
            this.wireQueueEventsHandlers(rt, qe);
            rt.perTaskQueueEvents.push(qe);
        }
        log.info('Per-task QueueEvents attached for leader class', {
            cls: rt.cls,
            count: rt.perTaskQueueEvents.length,
        });
    }

    /** Close + clear all per-task QueueEvents for a class (leader-loss / stop). */
    private closePerTaskQueueEvents(rt: ClassRuntime): void {
        for (const qe of rt.perTaskQueueEvents) {
            void qe.close().catch(() => {});
        }
        rt.perTaskQueueEvents = [];
    }

    private handleLeaderLost(rt: ClassRuntime): void {
        if (this.stopped) return;
        log.warn('Leader lost — detaching QueueEvents', { cls: rt.cls });
        void this.emitMeta('subscription-lost', {
            cls: rt.cls,
            reason: 'leader-lost',
        });
        if (rt.queueEvents) {
            void rt.queueEvents.close().catch(() => {});
            rt.queueEvents = null;
        }
        // Per-task subscriptions (flag-on) must also be closed or they leak a
        // blocking connection per task on every failover AND double-emit
        // terminal CloudEvents alongside the next leader's handlers.
        this.closePerTaskQueueEvents(rt);
        // NOTE: the reconciler/dispatcher/notifier are NOT stopped here — they
        // are owned by the coordinator lock's lifecycle (handleCoordinatorLost),
        // which is independent of per-class leadership.
        // Re-arm a slow retry loop. Without this the replica becomes a
        // permanent standby until process restart even when the next leader
        // exits cleanly.
        this.scheduleReacquire(rt);
    }

    /**
     * Schedule a re-acquire attempt with 5-7s jittered delay. On success,
     * re-attach QueueEvents and wire onLost so future losses also retry.
     * No-ops if stopped, the class was crash-simulated, or a timer is pending.
     */
    private scheduleReacquire(rt: ClassRuntime): void {
        if (this.stopped || rt.crashSimulatedForTesting) return;
        if (rt.reacquireTimer) return;
        const delayMs = 5_000 + Math.floor(Math.random() * 2_000); // 5–7s with jitter
        rt.reacquireTimer = setTimeout(() => {
            rt.reacquireTimer = null;
            void this.tryReacquire(rt);
        }, delayMs);
        if (typeof rt.reacquireTimer.unref === 'function') rt.reacquireTimer.unref();
    }

    /**
     * Defense-in-depth leadership reconcile (slow safety net, runs on every
     * replica). The LeaderLock renew loop is the PRIMARY loss detector; this guards
     * against any divergence between in-process belief (`isHeld()`) and Valkey
     * reality — e.g. a renew loop that stopped without firing `onLost`. A confirmed
     * zombie (believed-held but Valkey shows otherwise) is corrected by relinquishing
     * locally and routing through the normal loss → re-acquire path, so leadership
     * re-converges within one cycle instead of staying stuck until a redeploy. A
     * standby that has somehow lost its retry timer is re-armed.
     */
    private async reconcileLeadership(): Promise<void> {
        if (this.stopped) return;
        // Defense-in-depth: a WORKER_MODE=disabled web replica never participates
        // in leadership (the timer that calls this isn't even scheduled there), so
        // this is a belt-and-suspenders guard against any future caller.
        if (!shouldStartWorkers()) return;
        for (const rt of this.classes.values()) {
            if (rt.crashSimulatedForTesting) continue;
            try {
                if (rt.leader.isHeld()) {
                    const held = await rt.leader.verifyHeld();
                    if (this.stopped) return;
                    if (rt.crashSimulatedForTesting) continue;
                    if (!held) {
                        log.warn(
                            'Leadership reconcile: believed leader but Valkey disagrees — correcting',
                            { cls: rt.cls, instance: this.instanceId },
                        );
                        rt.leader.relinquishLocal();
                        this.handleLeaderLost(rt);
                    }
                } else if (!rt.reacquireTimer) {
                    // Standby with no pending retry — never get wedged as a
                    // permanent non-leader; re-arm the slow retry loop.
                    this.scheduleReacquire(rt);
                }
            } catch (err) {
                log.warn('Leadership reconcile error', {
                    cls: rt.cls,
                    err: errMessage(err),
                });
            }
        }
        // Coordinator lock: same zombie-check + standby re-arm as the classes.
        const coord = this.coordinatorLeader;
        if (coord) {
            try {
                if (coord.isHeld()) {
                    const held = await coord.verifyHeld();
                    if (this.stopped) return;
                    if (!held) {
                        log.warn(
                            'Leadership reconcile: believed coordinator but Valkey disagrees — correcting',
                            { instance: this.instanceId },
                        );
                        coord.relinquishLocal();
                        this.handleCoordinatorLost();
                    }
                } else if (!this.coordinatorReacquireTimer) {
                    this.scheduleCoordinatorReacquire();
                }
            } catch (err) {
                log.warn('Leadership reconcile error (coordinator)', {
                    err: errMessage(err),
                });
            }
        }
    }

    private async tryReacquire(rt: ClassRuntime): Promise<void> {
        if (this.stopped || rt.crashSimulatedForTesting) return;
        try {
            const acquired = await this.acquireLeadership(rt.leader);
            if (this.stopped) return;
            if (rt.crashSimulatedForTesting) {
                // Leave any late SET orphaned too; stop locally, never release
                // a lease here (a peer may already own it).
                rt.leader.stop();
                return;
            }
            if (acquired) {
                log.info('Leader re-acquired for class', {
                    cls: rt.cls,
                    instance: this.instanceId,
                });
                // Rebuild whichever subscription set this build uses (per-class
                // or per-task). closePerTaskQueueEvents on loss left the set
                // empty, so this is a clean rebuild.
                this.attachQueueEventsForLeader(rt);
                rt.leader.onLost(() => this.handleLeaderLost(rt));
                // Reconciler/dispatcher/notifier restarts are handled by the
                // coordinator lock's own re-acquire path, not per-class wins.
                void this.emitMeta('leader-reacquired', { cls: rt.cls });
                // Run version-bump detection on every fresh leader acquisition.
                // A standby that wins the lock later would otherwise never run
                // it until the next restart. The first-attempt winner is
                // covered by tryAcquireCoordinator.
                // A SETNX guard (60s TTL) prevents concurrent runs when
                // multiple replicas acquire leadership for different resource
                // classes within the same deployment window.
                void this.runDetectVersionBumpsIfLeader();
            } else {
                this.scheduleReacquire(rt);
            }
        } catch (err) {
            log.warn('Leader re-acquire errored', {
                cls: rt.cls,
                err: errMessage(err),
            });
            this.scheduleReacquire(rt);
        }
    }

    /**
     * Fires detectVersionBumps at most once every 60s across all replicas.
     * Uses a Valkey SETNX guard so a deployment that triggers leadership
     * transitions on multiple resource classes (or multiple replicas) doesn't
     * cause redundant scans.
     */
    private async runDetectVersionBumpsIfLeader(): Promise<void> {
        const sql = this.getSql();
        if (!sql) return;
        const client = this.getClient();
        const guardKey = 'pipeline:bump-detect:running';
        try {
            const set = await invokeOwnedCommand(
                ['SET', guardKey, '1', 'NX', 'EX', '60'],
                client,
                this.authority,
            );
            if (!set) return; // another replica is already running it
            await detectVersionBumps(sql, this.registry);
        } catch (err) {
            log.error('detectVersionBumps failed on leader-acquired', err as Error);
        }
    }

    private runIdFromJobId(jobId: string | undefined): string | null {
        if (!jobId) return null;
        // Job names are encoded as `<taskId>~~<formula>#<runId>` so that
        // QueueEvents handlers can recover the runId without a queue probe
        // even after BullMQ has reaped the job (removeOnComplete). Extract
        // the runId from the suffix when present; fall back to returning the
        // raw jobId to flushTransitions which will attempt a queue probe.
        const hashIdx = jobId.lastIndexOf('#');
        if (hashIdx > 0) {
            const candidate = jobId.slice(hashIdx + 1);
            if (candidate.startsWith('run_')) return candidate;
        }
        return jobId;
    }

    private async terminalPersistenceConfirmed(runId: string, to: RunState): Promise<boolean> {
        const sql = this.getSql();
        if (!sql) return false;
        const rows = await withExistingTaskWrite(
            sql,
            this.authority,
            async (tx) =>
                tx<{ state: RunState }[]>`SELECT state FROM task_history WHERE id = ${runId}`,
        );
        const state = rows[0]?.state;
        return state === to || state === 'cancelled' || state === 'completed';
    }

    /** Recheck the producer attempt at the queue seam before a retained CAS or
     * SQL mirror can overwrite a subsequently reseeded run. */
    private async terminalAttemptCurrent(req: TransitionRequest): Promise<boolean> {
        const identity = req.job;
        if (!identity) return true; // Internal synthetic transitions have no QueueEvents producer.
        const queue = this.allEnqueueQueues().find((entry) => entry.name === identity.queueName);
        const job = await queue?.getJob(identity.id);
        if (!job) {
            if (await this.terminalPersistenceConfirmed(req.runId, req.persistenceState ?? req.to))
                return false;
            throw new Error('UNKNOWN: retained terminal job unavailable');
        }
        assertTaskJobOrigin(this.authority, job.data.taskAuthority, job.id);
        const attemptsMade = req.extra?.queueAttemptsMade;
        if (typeof attemptsMade !== 'number' || !Number.isSafeInteger(attemptsMade))
            throw new Error('UNKNOWN: retained terminal attempt unavailable');
        // A changed attempt or a non-terminal queue state is positive evidence
        // of supersession, so discard this old observation without any writes.
        return job.attemptsMade === attemptsMade && (await job.getState()) === req.to;
    }

    private async flushTransitions(
        batch: TransitionRequest[],
        isClassCrashedForTesting: () => boolean = () => false,
    ): Promise<TransitionFlushResult> {
        const unresolved: TransitionRequest[] = [];
        for (const req of batch) {
            try {
                if (isClassCrashedForTesting()) continue;
                if (!sameTaskAuthority(req.origin, this.authority)) continue;
                if (!(await this.terminalAttemptCurrent(req))) continue;
                if (isClassCrashedForTesting()) continue;
                const target = req.persistenceState ?? req.to;
                // Resolve jobId → runId via BullMQ if necessary. For the simple
                // direct case (req.runId already prefixed with `run_`) we skip
                // the lookup. Job names encode runId as `<taskId>~~<formula>#<runId>`
                // so we can split on the last `#` to avoid queue probes.
                let runId: string = req.runId;
                if (!runId.startsWith('run_')) {
                    const hashIdx = req.runId.lastIndexOf('#');
                    if (hashIdx > 0) {
                        const candidate = req.runId.slice(hashIdx + 1);
                        if (candidate.startsWith('run_')) runId = candidate;
                    }
                    if (!runId.startsWith('run_')) {
                        const resolved = await this.resolveRunIdFromJobId(req.runId);
                        if (isClassCrashedForTesting() || !resolved) continue;
                        runId = resolved;
                    }
                }
                if (this.authority) {
                    const sql = this.getSql();
                    if (!sql) throw new Error('Terminal transition database unavailable');
                    const blocked = await withExistingTaskWrite(
                        sql,
                        this.authority,
                        async (tx) => tx`
                        SELECT id FROM task_history WHERE id = ${runId}
                        AND state = 'cancelling' AND error->>'code' = 'HARD_KILL_QUEUE_PENDING'
                    `,
                    );
                    if (isClassCrashedForTesting()) continue;
                    if (blocked.length !== 0)
                        throw new Error(
                            'UNKNOWN: terminal transition awaits hard-kill queue cleanup',
                        );
                }
                let result = await this.stateMachine.transitionRun({
                    runId,
                    from: req.from,
                    to: target,
                    extra: req.extra,
                });
                if (isClassCrashedForTesting()) continue;
                if (!result.ok) {
                    if (result.error === 'hard kill queue cleanup pending')
                        throw new Error(
                            'UNKNOWN: terminal transition awaits hard-kill queue cleanup',
                        );
                    // A normally completed/failed job has already made this
                    // transition in TaskRunner before BullMQ emits its terminal
                    // QueueEvents notification. QueueEvents is still responsible
                    // for its idempotent Postgres/outbox pass, but attempting the
                    // same Valkey CAS a second time correctly loses with a state
                    // mismatch. That is expected delivery order, not a competing
                    // writer, so do not surface it as transition-conflict.
                    const currentState = await this.readRunState(runId);
                    if (isClassCrashedForTesting()) continue;
                    if (
                        (req.to === 'completed' || req.to === 'failed' || req.to === 'cancelled') &&
                        (currentState === target ||
                            (req.to === 'failed' && currentState === 'cancelled'))
                    ) {
                        await this.writeTerminalToPostgres(runId, currentState, req.extra, {
                            strict: true,
                            isClassCrashedForTesting,
                        });
                        continue;
                    }
                    // When a hard-kill fires moveToFailed, QueueEvents emits 'failed'
                    // but the run may already be in 'cancelling'. Re-read the live
                    // state and retry as cancelling→cancelled so Postgres gets the
                    // correct terminal rather than overwriting 'cancelling' with 'failed'.
                    if (req.to === 'failed') {
                        if (currentState === 'cancelling') {
                            result = await this.stateMachine.transitionRun({
                                runId,
                                from: 'cancelling',
                                to: 'cancelled',
                                extra: req.extra,
                            });
                            if (isClassCrashedForTesting()) continue;
                            if (!result.ok && result.error === 'hard kill queue cleanup pending')
                                throw new Error(
                                    'UNKNOWN: terminal transition awaits hard-kill queue cleanup',
                                );
                            if (result.ok) {
                                req.persistenceState = 'cancelled';
                                await this.writeTerminalToPostgres(runId, 'cancelled', req.extra, {
                                    strict: true,
                                    isClassCrashedForTesting,
                                });
                                continue;
                            }
                        }
                        // TASK-C8: a convergent parent (or fan-in gate) that
                        // BullMQ lazily failed via `failParentOnFailure` never
                        // runs its processor, so it was never transitioned
                        // pending→active — its Valkey state stays `pending` (or
                        // the hash is absent and readRunState falls back to the
                        // `pending` task_history row). The Lua state machine
                        // forbids pending→failed, so the active→failed CAS above
                        // can never succeed and the run would wedge in `pending`
                        // forever. Skip the (illegal) state-machine transition
                        // and write the terminal `failed` straight to Postgres —
                        // the terminal UPDATE already overwrites any non-terminal
                        // state — then discard the stale Valkey `pending` hash so
                        // the reconciler doesn't re-reclaim it as an orphan.
                        if (currentState === 'pending' || currentState === null) {
                            // Resume after restart: a run the runner left for
                            // the reclaim (interrupt marker) is NOT ours to
                            // fail — currentState is only null here because
                            // the Postgres fallback read itself failed.
                            if (await this.hasInterruptMarker(runId)) continue;
                            if (isClassCrashedForTesting()) continue;
                            await this.discardRunStateHash(runId);
                            if (isClassCrashedForTesting()) continue;
                            await this.writeTerminalToPostgres(runId, 'failed', req.extra, {
                                strict: true,
                                isClassCrashedForTesting,
                            });
                            continue;
                        }
                    }
                    // O2 — symmetric `pending→completed` bypass. The orphan-sweep
                    // (orphan-sweep.ts) force-completes a stuck waiting-children
                    // parent via `moveToCompleted`, which fires QueueEvents
                    // 'completed' → an `active→completed` request here. But that
                    // parent never ran its processor (children gone, lazily
                    // resolved by BullMQ), so its Valkey state is still `pending`
                    // (or absent → readRunState falls back to the `pending`
                    // task_history row). The Lua state machine forbids
                    // pending→completed (only TASK-C8 added pending→failed), so the
                    // active→completed CAS above always fails — and WITHOUT this
                    // branch the parent lands as a spurious `failed` (or wedges in
                    // `pending`). Write terminal `completed` straight to Postgres
                    // (overwrites any non-terminal state) and discard the stale
                    // hash so the reconciler doesn't re-reclaim it. Idempotent.
                    if (req.to === 'completed') {
                        const currentState = await this.readRunState(runId);
                        if (isClassCrashedForTesting()) continue;
                        if (currentState === 'pending' || currentState === null) {
                            // Same guard as the failed branch: a run left for
                            // resume-after-restart is the reclaim's to end.
                            if (await this.hasInterruptMarker(runId)) continue;
                            if (isClassCrashedForTesting()) continue;
                            await this.discardRunStateHash(runId);
                            if (isClassCrashedForTesting()) continue;
                            await this.writeTerminalToPostgres(runId, 'completed', req.extra, {
                                strict: true,
                                isClassCrashedForTesting,
                            });
                            continue;
                        }
                    }
                    await this.emitMeta('transition-conflict', {
                        runId,
                        from: req.from,
                        to: req.to,
                        error: result.error,
                    });
                    continue;
                }
                await this.writeTerminalToPostgres(runId, target, req.extra, {
                    strict: true,
                    isClassCrashedForTesting,
                });
            } catch (err) {
                if (isClassCrashedForTesting()) continue;
                unresolved.push(req);
                log.error('Transition flush failed', err as Error, {
                    runId: req.runId,
                });
            }
        }
        return { unresolved };
    }

    private async resolveRunIdFromJobId(jobId: string): Promise<string | null> {
        // The job lives in some queue; we don't know which without probing.
        // Probe every queue this orchestrator manages — per-task queues when
        // the flag is on, per-class otherwise.
        for (const queue of this.allEnqueueQueues()) {
            try {
                const job = await queue.getJob(jobId);
                if (job && typeof job.data === 'object' && job.data !== null) {
                    const data = job.data as Record<string, unknown>;
                    if (typeof data.runId === 'string') return data.runId;
                }
            } catch {
                // Ignore — queue may not have the job. Continue probing.
            }
        }
        return null;
    }

    /**
     * Resolve the BullMQ jobId for a runId by scanning all managed queues.
     * Returns null when the job is not found (e.g. already reaped by BullMQ).
     */
    private async resolveJobIdForRun(runId: string): Promise<string | null> {
        for (const queue of this.allEnqueueQueues()) {
            try {
                // BullMQ stores runId in job.data.runId; the job's own id is the
                // computed identity formula. Hard-kill targets jobs in any
                // pre-terminal state — active, waiting, delayed, prioritized,
                // or waiting-children — so scan all of them.
                const lists = await Promise.all([
                    queue.getActive(),
                    queue.getWaiting(),
                    queue.getDelayed(),
                    queue.getPrioritized(),
                    queue.getWaitingChildren(),
                ]);
                for (const jobs of lists) {
                    for (const job of jobs) {
                        const d = job.data as Record<string, unknown>;
                        if (d.runId === runId && job.id) return job.id;
                    }
                }
            } catch {
                // Queue probe failed — continue to next queue.
            }
        }
        return null;
    }

    private async writeTerminalToPostgres(
        runId: string,
        to: RunState,
        extra: Record<string, string | number> | undefined,
        options: { strict?: boolean; isClassCrashedForTesting?: () => boolean } = {},
    ): Promise<void> {
        if (options.isClassCrashedForTesting?.()) return;
        // If the run completes naturally, cancel any pending hard-kill timer.
        if (to === 'completed' || to === 'failed' || to === 'cancelled') {
            this.hardKill?.cancelScheduled(runId);
        }

        const sql = this.getSql();
        if (!sql) {
            if (options.strict) throw new Error('Terminal transition database unavailable');
            return;
        }
        const completedAt = (extra?.completedAt as string | undefined) ?? nowIso();
        if (to === 'completed' || to === 'failed' || to === 'cancelled') {
            const errorObj =
                to === 'failed' && extra?.errorMessage
                    ? { message: String(extra.errorMessage) }
                    : null;
            const errorValue = errorObj
                ? sql.json(errorObj as unknown as postgres.JSONValue)
                : null;
            let taskId: string | null = null;
            try {
                // BullMQ retry path: a prior attempt may have already written
                // state='failed' here. The successful retry MUST be able to
                // overwrite failed→completed (or failed→active for resume),
                // otherwise every successful retry is recorded as the prior
                // attempt's failure. Exclude only the strictly terminal cases
                // that genuinely shouldn't change:
                //   - completed:  done; nothing should overwrite it
                //   - cancelled:  user-requested terminal; respect it
                //   - failed→failed: no-op overwrite, skip to avoid touching ts
                const rows = await withExistingTaskWrite(sql, this.authority, async (tx) => {
                    const updated = await tx<{ task_id: string }[]>`
                    UPDATE task_history
                    SET state = ${to},
                        completed_at = ${completedAt},
                        error = ${errorValue}
                    WHERE id = ${runId}
                      AND state NOT IN ('completed', 'cancelled')
                      AND NOT (state = 'failed' AND ${to}::text = 'failed')
                      AND (state <> 'cancelling' OR error->>'code' IS DISTINCT FROM 'HARD_KILL_QUEUE_PENDING')
                    RETURNING task_id
                `;
                    if (options.strict && updated.length === 0) {
                        const existing = await tx<{ state: RunState }[]>`
                                SELECT state FROM task_history WHERE id = ${runId}
                            `;
                        const state = existing[0]?.state;
                        // A no-op is acknowledged only when a respected
                        // terminal row actually exists. A deferred INSERT
                        // may still arrive after a currently missing row.
                        if (state !== to && state !== 'completed' && state !== 'cancelled')
                            throw new Error(
                                'UNKNOWN: terminal persistence has no confirmed terminal row',
                            );
                    }
                    return updated;
                });
                if (options.isClassCrashedForTesting?.()) return;
                taskId = rows[0]?.task_id ?? null;
                // OSS-readiness: surface GENUINE task failures to the server logs,
                // not only to task_history.error (which an operator otherwise has
                // to query the DB to read). Every real failure path — handler
                // throw, wall-clock/stall watchdog, hard-timeout, processing-
                // version mismatch — funnels its terminal write through here with
                // a message. The NULL-error INFRA events (orphan reclaim / queue
                // drain / parent-fail — see the `error IS NOT NULL` filter in
                // invariants.ts) have no `errorObj`, so they're skipped: this stays
                // the actionable-failure signal, not lock-renewal noise. `taskId`
                // is null on a no-op overwrite of an already-terminal row → skip.
                if (to === 'failed' && errorObj && taskId) {
                    const key = `${taskId}|${errorObj.message.slice(0, 120)}`;
                    const now = Date.now();
                    const prev = failureLogThrottle.get(key);
                    if (!prev || now - prev.last >= FAILURE_LOG_THROTTLE_MS) {
                        log.warn('Task run failed', {
                            taskId,
                            runId,
                            error: errorObj.message,
                            // How many identical failures were suppressed since the
                            // last time this (task, error) was logged — so a storm
                            // is one line/min that still shows its true volume.
                            ...(prev?.suppressed
                                ? { suppressedSinceLastLog: prev.suppressed }
                                : {}),
                        });
                        failureLogThrottle.set(key, { last: now, suppressed: 0 });
                        // Bound memory: drop entries whose window has fully lapsed.
                        if (failureLogThrottle.size > FAILURE_LOG_THROTTLE_MAX) {
                            for (const [k, v] of failureLogThrottle) {
                                if (now - v.last >= FAILURE_LOG_THROTTLE_MS)
                                    failureLogThrottle.delete(k);
                            }
                        }
                    } else {
                        prev.suppressed++;
                    }
                }
            } catch (err) {
                // A transaction already submitted may finish, but a test-dead
                // class must not create fresh fallback work after its failure.
                if (options.isClassCrashedForTesting?.()) return;
                log.warn('Terminal Postgres write failed', {
                    runId,
                    to,
                    err: errMessage(err),
                });
                // Only drain transient errors — a permanent failure (e.g. invalid
                // state value) won't recover by retry and would pile into the DLQ.
                if (this.pendingWriteDrain && isTransientPgError(err)) {
                    const handoff = this.pendingWriteDrain.enqueue(
                        {
                            kind: 'update',
                            authority: this.authority,
                            runId,
                            payload: {
                                state: to,
                                completedAt,
                                error: errorObj ?? undefined,
                            },
                            enqueuedAt: Date.now(),
                        },
                        { strict: options.strict },
                    );
                    if (options.strict) await handoff;
                } else if (options.strict) {
                    throw err;
                }
            }
            if (options.isClassCrashedForTesting?.()) return;
            if (taskId) {
                await this.emitTerminalCloudEvent(
                    taskId,
                    runId,
                    to,
                    extra,
                    options.isClassCrashedForTesting,
                );
                // Update Prometheus metrics after terminal DB write.
                const task = this.registry.getTask(taskId);
                const resourceClass = task?.resourceClass ?? 'io';
                taskRunsTotal.inc({
                    task_id: taskId,
                    status: to,
                    resource_class: resourceClass,
                });
                // Compute duration from started_at if available in extra or DB.
                // We use the completedAt field vs started_at from the DB row; if
                // not available, fall back to 0 (avoids a DB round-trip per run).
                const completedMs = new Date(completedAt).getTime();
                const startedAtRaw = extra?.startedAt;
                if (startedAtRaw && typeof startedAtRaw === 'string') {
                    const durationSec = (completedMs - new Date(startedAtRaw).getTime()) / 1000;
                    if (durationSec >= 0) {
                        taskDurationSeconds.observe(
                            { task_id: taskId, resource_class: resourceClass },
                            durationSec,
                        );
                    }
                }
            }
        }
    }

    private async emitTerminalCloudEvent(
        taskId: string,
        runId: string,
        to: 'completed' | 'failed' | 'cancelled',
        extra: Record<string, string | number> | undefined,
        isClassCrashedForTesting: () => boolean = () => false,
    ): Promise<void> {
        if (isClassCrashedForTesting()) return;
        // Kept for the paths the orchestrator genuinely owns (pending-run
        // cancel, TASK-C8 pending->failed, orphan sweep). Normally-finishing
        // runs are published by the runner, which is their actual writer.
        //
        // The payload is loaded back from the row rather than assembled from
        // `extra`: `{ runId, taskId, ...extra }` could not be parsed by any
        // client (RunSchema requires id/label/state/trigger/startedAt/stages/
        // actor), so every terminal frame published here was silently dropped.
        // No row (or no DB at all) means there is nothing truthful to publish,
        // and the client re-seeds from REST on reconnect either way.
        void extra;
        const sql = this.getSql();
        if (!sql) return;
        let run: Run | null;
        try {
            const rows = await sql<Record<string, unknown>[]>`
                SELECT id, task_id, parent_run_id, label, state, input, scope, trigger, actor,
                       started_at, execution_started_at, completed_at, heartbeat_at, stages, result, error,
                       cost_breakdown, owner_instance_id
                FROM task_history WHERE id = ${runId}
            `;
            run = rows[0] ? this.rowToRun(rows[0]) : null;
        } catch (err) {
            log.warn('CloudEvent terminal row load failed', {
                runId,
                err: errMessage(err),
            });
            return;
        }
        if (isClassCrashedForTesting() || !run) return;
        const data = toRunEvent(run);
        const event =
            to === 'completed'
                ? cloudEvents.runCompleted(taskId, runId, data)
                : to === 'failed'
                  ? cloudEvents.runFailed(taskId, runId, data)
                  : cloudEvents.runCancelled(taskId, runId, data);

        // Resolve resource class for the pubsub channel.
        const task = this.registry.getTask(taskId);
        const cls = task?.resourceClass ?? 'io';
        try {
            // All pub/sub, like the keyed state, runs on the task Valkey.
            await publishMessage(`task:events:${cls}`, JSON.stringify(event));
        } catch (err) {
            log.warn('CloudEvent terminal publish failed', {
                type: event.type,
                runId,
                err: errMessage(err),
            });
        }
        if (isClassCrashedForTesting()) return;
        if (this.webhookOutbox) {
            try {
                await this.webhookOutbox.enqueue(event);
            } catch (err) {
                log.warn('WebhookOutbox terminal enqueue failed', {
                    type: event.type,
                    runId,
                    err: errMessage(err),
                });
            }
        }
    }

    // -- public API ----------------------------------------------------------

    /**
     * S0 — Resolve the task definition from the registry.
     * Throws a permanent TaskError if the task id is unknown.
     */
    private resolveTask(taskId: string): TaskDefinition {
        const task = this.registry.getTask(taskId);
        if (!task) {
            throw new TaskError({
                message: `Unknown task: ${taskId}`,
                kind: 'permanent',
            });
        }
        return task;
    }

    /**
     * S1 — Validate input against the task's input schema.
     * Lets Zod throw on invalid shape, then re-wraps as a permanent TaskError.
     */
    private validateInput(task: TaskDefinition, taskId: string, input: unknown): unknown {
        // Validate input — let Zod throw on invalid shape, then re-wrap.
        let parsed: unknown;
        try {
            parsed = task.inputSchema.parse(input);
        } catch (err) {
            throw new TaskError({
                message: `Invalid input for task ${taskId}: ${errMessage(err)}`,
                kind: 'permanent',
                cause: err,
            });
        }
        return parsed;
    }

    /**
     * S2 — Serialize the parsed input and enforce the size cap before any I/O.
     * Throws a permanent TaskError on non-serializable or oversize input.
     */
    private enforceInputSizeCap(taskId: string, parsed: unknown): void {
        // Enforce serialized input size cap before any I/O (see
        // maxTaskInputBytes above).
        let inputJson: string;
        try {
            inputJson = JSON.stringify(parsed ?? {});
        } catch {
            throw new TaskError({
                message: `Task input is not serializable for task ${taskId} (contains circular reference or BigInt)`,
                kind: 'permanent',
            });
        }
        const inputByteLength = Buffer.byteLength(inputJson, 'utf8');
        if (inputByteLength > maxTaskInputBytes()) {
            log.warn('Task input exceeds size cap', {
                taskId,
                inputKeys: Object.keys(
                    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
                ),
                byteLength: inputByteLength,
                cap: maxTaskInputBytes(),
            });
            throw new TaskError({
                message: `Task input exceeds ${maxTaskInputBytes()} bytes (got ${inputByteLength}). Task id: ${taskId}`,
                kind: 'permanent',
            });
        }
    }

    private async idempotencyDedup(
        taskId: string,
        idempotencyKey: string | undefined,
        sql: postgres.Sql | null,
    ): Promise<StartRunResult | undefined> {
        // Idempotency: an in-flight (pending/active/cancelling) run with
        // the same key returns the original runId. Terminal runs
        // (completed/failed/cancelled) are NOT a dedup match — once a
        // run has terminated, a fresh enqueue with the same key should
        // proceed to start a new run, not reuse the terminated row.
        //
        // This filter must agree EXACTLY with the partial unique index
        // `task_history_idempotency_key_unique` (migration 16.16.0), which is
        // `WHERE state IN ('pending','active','cancelling')` — and NOTHING ELSE.
        // The state filter is essential (a terminated run must not dedup-block a
        // fresh enqueue). The `started_at > NOW()-24h` bound that used to be here
        // was a BUG (series-sync 23505 INSERT-loop, prod 2026-06-13): the index
        // has NO time bound, so a non-terminal run aged past 24h (e.g. a zombie
        // the reconciler hadn't reclaimed yet) was INVISIBLE to this dedup SELECT
        // -> the INSERT below tripped the unbounded unique index (23505) -> the
        // 23505-recovery SELECT (also 24h-bounded) found nothing -> tight
        // `duplicate key` loop, item stuck forever. Match the constraint exactly:
        // no time bound. A genuinely-stale stuck row is now returned as a dedup
        // hit (caller sees the stuck runId, no loop) and the reconciler
        // terminalizes it to free the key.
        if (idempotencyKey && sql) {
            const existing = await sql<{ id: string }[]>`
                SELECT id FROM task_history
                WHERE task_id = ${taskId}
                  -- The 'trigger ? key' conjunct matches the partial predicate of
                  -- task_history_idempotency_key_unique so the planner can USE that
                  -- index instead of falling back to idx_task_history_state (which
                  -- scans the whole non-terminal set — costly on a 15k-pending cold
                  -- start). No-op on results: a non-empty key is always present.
                  AND trigger ? 'idempotencyKey'
                  AND trigger->>'idempotencyKey' = ${idempotencyKey}
                  AND state IN ('pending', 'active', 'cancelling')
                ORDER BY started_at DESC
                LIMIT 1
            `;
            if (existing.length > 0) {
                return {
                    runId: existing[0].id,
                    deduped: true,
                    existingRunId: existing[0].id,
                };
            }
        }
        return undefined;
    }

    private async circuitBreakerGate(taskId: string): Promise<void> {
        // Circuit breaker check — before identity dedup so denied runs are never written to DB.
        if (this.circuitBreaker) {
            const decision = await this.circuitBreaker.check(taskId);
            if (!decision.allowed) {
                throw new TaskError({
                    message: `Circuit breaker is ${decision.state} for task ${taskId}: ${decision.reason ?? 'denied'}`,
                    kind: 'transient',
                });
            }
        }
    }

    private async backpressureDrop(
        task: TaskDefinition,
        earlyPriority: number,
    ): Promise<{ drop: false } | { drop: true; reason: string }> {
        if (!this.backpressure) {
            return { drop: false };
        }
        const bpDecision = await this.backpressure.check(
            task.resourceClass,
            earlyPriority,
            task.backpressure,
        );
        if (!bpDecision.proceed) {
            return { drop: true, reason: bpDecision.reason ?? 'drop' };
        }
        return { drop: false };
    }

    // Cross-time identity dedup via SETNX Lua (when the task opts in).
    private async claimIdentity(
        task: TaskDefinition,
        taskId: string,
        parsed: unknown,
        client: ValkeyLike,
        sql: postgres.Sql | null,
    ): Promise<
        | { kind: 'duplicate'; result: StartRunResult }
        | {
              kind: 'claimed';
              runId: string;
              jobId: string;
              exclusivityKey: string | null;
              identityClaimed: boolean;
          }
    > {
        const jobId = computeIdentity(task as TaskDefinition<unknown, unknown>, parsed);
        const runId = `run_${ulid()}`;
        let identityClaimed = false;
        // Valkey key for the cross-time exclusiveWith mutex (only when the task
        // opts in). Captured once so it can be reused for the SETNX claim, the
        // rollback-on-failure DEL, AND stashed into job data below so the
        // runner can DEL it on a final terminal — otherwise the key lingers for
        // the full crash-safety TTL and blocks legitimate sequential re-runs.
        const exclusivityKey = task.exclusiveWith ? identityKey(taskId, jobId) : null;
        if (task.exclusiveWith) {
            // F1.1: clamp the configured TTL up to the derived floor. The floor
            // is max(timeout.hard_ms, schedule.every_ms) + IDENTITY_CLAIM_MARGIN_MS
            // so the dedup key always outlives both the SETNX→queue.add critical
            // section AND the task's own worst-case runtime. Without this clamp a
            // scheduled task whose configured TTL is shorter than its own hard
            // timeout would have its key expire mid-run, letting the next scheduler
            // tick spawn a duplicate concurrent run.
            const parsedTtl = parseDurationMs(task.exclusiveWith.ttl) ?? 24 * 3_600_000;
            const derivedFloor = deriveIdentityTtlFloor(task);
            const ttlMs = Math.max(derivedFloor, parsedTtl);
            log.debug('exclusiveWith identity-key TTL resolved', {
                taskId,
                configuredTtlMs: parsedTtl,
                derivedFloorMs: derivedFloor,
                effectiveTtlMs: ttlMs,
                clamped: parsedTtl < derivedFloor,
            });

            // One extra claim attempt is allowed: if the first SETNX reports a
            // duplicate whose run is dead (phantom), we release the stale key
            // and re-attempt exactly ONCE. A bounded loop (max 2 iterations)
            // keeps this race-safe — a real concurrent run winning the re-claim
            // falls through to a normal dedup, no unbounded retry.
            for (let attempt = 0; attempt < 2; attempt++) {
                const raw = await luaLoader.invoke(
                    'enqueue-with-identity',
                    [exclusivityKey as string],
                    [runId, String(ttlMs)],
                    client,
                    this.authority,
                );
                // enqueue-with-identity.lua returns a flat positional array
                // ['enqueued'|'duplicate', runId]. valkey-glide decodes Lua tables
                // as plain JS arrays — the `{ok='…', val}` shape becomes
                // ['…', val] at the wire boundary, *not* an object with `.ok`.
                if (Array.isArray(raw) && raw[0] === 'duplicate') {
                    const existing = typeof raw[1] === 'string' ? raw[1] : '';
                    if (existing) {
                        // F1.2: a terminated run can leave the identity SETNX key
                        // pointing at its (now terminal) runId — no recovery path
                        // releases identity keys, so the phantom key blocks every
                        // fresh run for the full crash-safety TTL. On the FIRST
                        // attempt, probe whether the existing run is a confirmed
                        // phantom (terminal); if so, compare-and-delete the stale
                        // key (only if it still holds that exact dead runId) and
                        // re-attempt the claim once.
                        if (
                            attempt === 0 &&
                            (await this.isPhantomDedup(existing, sql, taskId, jobId))
                        ) {
                            log.warn(
                                'Phantom identity dedup detected — releasing stale key and retrying',
                                {
                                    taskId,
                                    staleRunId: existing,
                                },
                            );
                            taskIdentityPhantomDedupTotal.inc({
                                task_id: taskId,
                            });
                            try {
                                // Compare-and-delete on the DEAD runId so we only
                                // free the key if it still holds that exact value —
                                // never steal a concurrent successor's lock.
                                await luaLoader.invoke(
                                    'release-identity',
                                    [exclusivityKey as string],
                                    [existing],
                                    client,
                                    this.authority,
                                );
                            } catch {
                                // Best-effort — Lua TTL eventually cleans it up.
                            }
                            // Fall through to a fresh SETNX on the next iteration.
                            continue;
                        }
                        // Real in-flight run (or re-attempt also lost the race to a
                        // genuine concurrent winner): normal dedup.
                        return {
                            kind: 'duplicate',
                            result: {
                                runId: existing,
                                deduped: true,
                                existingRunId: existing,
                            },
                        };
                    }
                    // duplicate=true but empty existing — the identity key vanished
                    // between SETNX and GET (TTL expired in that microsecond). Refuse
                    // rather than fall through and enqueue a fresh run that bypasses
                    // dedup; caller retries.
                    throw new TaskError({
                        message: `Identity race for task ${taskId}: dup reported but existing runId is empty`,
                        kind: 'transient',
                    });
                }
                identityClaimed = Array.isArray(raw) && raw[0] === 'enqueued';
                break;
            }
        }
        return {
            kind: 'claimed',
            runId,
            jobId,
            exclusivityKey,
            identityClaimed,
        };
    }

    /**
     * F1.2 probe: is an identity-dedup hit pointing at a dead run?
     *
     * Returns true ONLY when the `task_history` row for `existingRunId` is in a
     * terminal state (completed/failed/cancelled) — a run that finished but whose
     * terminal handler did not release the identity key — normally the runner
     * releases it on every clean exit and RunLivenessAuthority.releaseIdentityKey()
     * releases it on reclaim (Consolidation #1), so a still-set key on a terminal
     * row means that release was skipped or failed (e.g. a transient Valkey error
     * mid-release). That is an unambiguous phantom and is safe to self-heal.
     *
     * Returns false for a live run (pending/active/cancelling), when `sql` is
     * absent, when the probe throws — AND, critically, when the row is ABSENT.
     * An absent row is NOT treated as a phantom: a genuine first run does its
     * SETNX before it INSERTs its `task_history` row, so a concurrent dedup that
     * lands in that SETNX→INSERT window would see "absent" for a perfectly live
     * run. Treating absent as phantom there would release the live run's key and
     * re-claim, producing the very duplicate this guard exists to prevent. The
     * rarer crash-between-SETNX-and-INSERT leak (a permanently-absent row) is freed
     * by RunLivenessAuthority.releaseIdentityKey() when the orphaned run is reclaimed
     * on markFailed (Consolidation #1), typically within ~15 min. The derived TTL floor
     * is safe BECAUSE reclaim releases the key on discovery; the long TTL is only a
     * worst-case ceiling for an unreclaimed crash, not the normal operating window.
     */
    private async isPhantomDedup(
        existingRunId: string,
        sql: postgres.Sql | null,
        taskId: string,
        jobId: string,
    ): Promise<boolean> {
        if (!sql) return false;
        try {
            const rows = await sql<{ state: string }[]>`
                SELECT state FROM task_history
                WHERE id = ${existingRunId}
                LIMIT 1
            `;
            // Absent row → normally the SETNX→INSERT window of a live run (a
            // sub-second gap: the task_history INSERT is the very next step after
            // the identity SETNX), so we stay conservative and do NOT re-enqueue.
            // BUT if the holder runId was minted far longer ago than that window,
            // the INSERT never landed — the process crashed (or the INSERT threw
            // without rolling back the SETNX) between claiming the identity key and
            // writing the row. That key is a confirmed LEAK that no reclaim path can
            // see (the reclaim authority scans task_history, which has no row), so it
            // would wedge the singleton until its derived-floor TTL (up to ~24h).
            // The runId is a ULID, so its mint time is self-describing: if it
            // predates now − PHANTOM_ABSENT_GRACE_MS, treat it as a phantom and let
            // the caller release the stale key. The grace dwarfs the real SETNX→
            // INSERT latency and absorbs NTP skew, so a genuinely live mid-window
            // run is never disturbed.
            if (rows.length === 0) {
                const mintedMs = decodeRunMintMs(existingRunId);
                if (mintedMs !== null && Date.now() - mintedMs > PHANTOM_ABSENT_GRACE_MS) {
                    log.warn(
                        'Phantom identity dedup: holder runId has no task_history row long after mint — treating as crash-leaked key',
                        {
                            staleRunId: existingRunId,
                            ageMs: Date.now() - mintedMs,
                        },
                    );
                    return true;
                }
                return false;
            }
            const state = rows[0].state;
            if (state === 'failed') {
                // A failed ATTEMPT is still live while BullMQ holds its retry.
                // Keep its exclusive identity through backoff and queue waits.
                const queue = this.resolveTaskQueue(taskId);
                if (!queue) return false;
                const job = await queue.getJob(
                    taskJobId(`${jobId}#${existingRunId}`, this.authority),
                );
                if (job && !['failed', 'completed'].includes(await job.getState())) return false;
            }
            return state === 'completed' || state === 'failed' || state === 'cancelled';
        } catch (err) {
            // Probe failure must not crash startRun — fall back to treating the
            // dedup as real (conservative: never re-enqueue on uncertainty).
            log.warn('Phantom-dedup task_history probe failed — treating dedup as real', {
                existingRunId,
                err: errMessage(err),
            });
            return false;
        }
    }

    private assembleRunMetadata(
        task: TaskDefinition,
        taskId: string,
        opts: StartRunOpts,
        idempotencyKey: string | undefined,
    ): {
        trigger: NonNullable<StartRunOpts['trigger']>;
        triggerRecord: Record<string, unknown>;
        scope: Record<string, string>;
        actor: Record<string, string>;
        label: string;
        startedAt: Date;
    } {
        const trigger = opts.trigger ?? { kind: 'in-process' as TriggerKind };
        const triggerRecord: Record<string, unknown> = { ...trigger };
        // Only persist a non-empty idempotencyKey so we don't materialise the
        // partial-index trigger->>'idempotencyKey' for empty-string calls.
        if (idempotencyKey) triggerRecord.idempotencyKey = idempotencyKey;
        const scope: Record<string, string> = {};
        if (opts.libraryGroupId) scope.libraryGroupId = opts.libraryGroupId;
        if (opts.userId) scope.userId = opts.userId;
        if (opts.subject) {
            scope.subjectType = opts.subject.type;
            scope.subjectId = opts.subject.id;
        }
        const actor = inferActor(trigger);
        const label = task.name || taskId;
        const startedAt = new Date();
        return { trigger, triggerRecord, scope, actor, label, startedAt };
    }

    private async acquireQuota(
        task: TaskDefinition,
        taskId: string,
        quota: { acquired: boolean; rolledBack: boolean; day?: string },
        rollbackIdentity: () => Promise<void>,
        sql: postgres.Sql | null,
    ): Promise<void> {
        const cap = task.quotas?.maxRunsPerDay;
        if (!cap) return;

        // TASK-C4: enforce the daily-run quota in Postgres, NOT Valkey. The
        // Valkey counter (`task:quota:<id>:<day>`) carried a 48h TTL and was an
        // eviction candidate under any non-`noeviction` policy (the shipped
        // compose uses `volatile-lru`) — once evicted the counter reset to zero
        // and the cap was silently bypassed, precisely under the memory pressure
        // a runaway task creates. task_quota_usage is durable and the cap is
        // enforced atomically inside the INSERT ... ON CONFLICT statement.
        if (!sql) {
            // Cache-only / no-DB dev setup: there is no task_history to persist
            // the run into either, so durable quota enforcement is moot. Skip
            // rather than fall back to the eviction-prone Valkey path.
            return;
        }

        const result = await acquireDailyQuotaSlot(sql, taskId, cap);
        if (!result.acquired) {
            // Cap already reached — nothing was incremented, so there is no
            // counter to roll back. Release the identity claim and reject.
            await rollbackIdentity();
            throw new TaskError({
                message: `Quota exceeded for task ${taskId} (maxRunsPerDay: ${cap})`,
                kind: 'permanent',
            });
        }
        // Slot reserved — flag for rollback if a later startRun step fails.
        // Record the day the slot was reserved against so a release that crosses
        // the UTC-midnight boundary still targets the same bucket (TASK-C4).
        quota.acquired = true;
        quota.day = result.day;
    }

    private async persistAndEnqueue(args: {
        task: TaskDefinition;
        taskId: string;
        parsed: unknown;
        opts: StartRunOpts;
        sql: postgres.Sql | null;
        client: ValkeyLike;
        runId: string;
        jobId: string;
        exclusivityKey: string | null;
        identityClaimed: boolean;
        idempotencyKey: string | undefined;
        label: string;
        scope: Record<string, string>;
        triggerRecord: Record<string, unknown>;
        actor: Record<string, string>;
        startedAt: Date;
        earlyPriority: number;
        /**
         * Caller-visible marker (mutated in place, same pattern as the
         * `quota` tracker above) flipped to `true` the instant the
         * task_history INSERT commits. startRun's outer catch reads this to
         * decide whether a downstream failure needs compensation (the row —
         * and possibly a live BullMQ job — already exist) instead of a bare
         * rollbackIdentity/rollbackQuota. Note quota release is now decided
         * ONLY by that outer catch (see its comments) — once this INSERT
         * commits the run legitimately holds its quota slot for today's
         * bucket regardless of how enqueueing later fails, so this function
         * no longer calls rollbackQuota itself.
         */
        persisted: { committed: boolean };
    }): Promise<StartRunResult> {
        const {
            task,
            taskId,
            parsed,
            opts,
            sql,
            client,
            runId,
            jobId,
            exclusivityKey,
            identityClaimed,
            idempotencyKey,
            label,
            scope,
            triggerRecord,
            actor,
            startedAt,
            earlyPriority,
            persisted,
        } = args;
        // Postgres FIRST (source of truth). Valkey hash is set after.
        if (sql) {
            try {
                await insertTaskHistoryRow(
                    sql,
                    {
                        id: runId,
                        taskId,
                        parentRunId: opts.parentRunId ?? null,
                        label,
                        state: 'pending',
                        input: parsed,
                        scope,
                        trigger: triggerRecord,
                        actor,
                        startedAt,
                        processingVersion: task.processingVersion,
                        ownerInstanceId: this.instanceId,
                        retentionPolicy: task.retention?.policy ?? 'standard',
                        stages: [],
                    },
                    this.authority,
                );
                // INSERT committed — from this point on the row is real and
                // durable. A later throw in this function (Valkey HSET blip,
                // an ambiguous queue.add ack, FlowProducer failure) must NOT
                // let startRun's catch treat this as "nothing happened":
                // rollbackIdentity would free the exclusiveWith slot while a
                // real pending row (and possibly a live BullMQ job) exists.
                persisted.committed = true;
            } catch (err) {
                // Catch unique-constraint violation on the idempotency partial index
                // (task_history_idempotency_key_unique) — a concurrent replica raced
                // and inserted first. Re-fetch and return the existing run so callers
                // see the same dedup result as the pre-INSERT SELECT branch.
                //
                // Strict match by pg SQLSTATE 23505 (unique_violation) AND the exact
                // constraint name. Substring matching on the error *message* would
                // wrongly swallow violations from unrelated unique indexes (e.g.
                // the column-based `idx_task_history_idempotency` from 15.0.0).
                const errObj = (err ?? {}) as {
                    code?: unknown;
                    constraint_name?: unknown;
                };
                // Reuse the normalized `idempotencyKey` from the top of
                // startRun — empty strings were already coerced to
                // undefined, so this branch never hits the dedup re-fetch
                // for a phantom key.
                if (
                    idempotencyKey &&
                    errObj.code === '23505' &&
                    errObj.constraint_name === 'task_history_idempotency_key_unique'
                ) {
                    try {
                        // Mirror the partial unique index EXACTLY (state IN the
                        // three non-terminal states, no time bound) so we re-fetch
                        // the actual row that HOLDS the key — not a stale terminal
                        // row, and not nothing-because-it's->24h-old (the latter was
                        // the series-sync 23505-loop bug: a >24h stuck row tripped
                        // the unbounded index but this 24h-bounded SELECT missed it,
                        // so it fell through to the error path and looped).
                        const existing = await sql<{ id: string }[]>`
                            SELECT id FROM task_history
                            WHERE task_id = ${taskId}
                              -- Matches the partial predicate of the idempotency
                              -- unique index so the planner uses it (see the
                              -- primary dedup SELECT above). No-op on results.
                              AND trigger ? 'idempotencyKey'
                              AND trigger->>'idempotencyKey' = ${idempotencyKey}
                              AND state IN ('pending', 'active', 'cancelling')
                            ORDER BY started_at DESC
                            LIMIT 1
                        `;
                        if (existing.length > 0) {
                            // Benign: a concurrent enqueue won the idempotency
                            // race, so this run dedups to the existing one. The
                            // task still runs exactly once — this is the dedup
                            // path, not a failure, so log at debug (NOT error).
                            log.debug('task_history idempotency dedup — returning existing run', {
                                runId,
                                taskId,
                                existingRunId: existing[0].id,
                            });
                            return {
                                runId: existing[0].id,
                                deduped: true,
                                existingRunId: existing[0].id,
                            };
                        }
                        // Index says a row exists but SELECT didn't find one — most
                        // likely the racing row was deleted in the microsecond between
                        // 23505 and our SELECT. Fall through to the generic error
                        // surface below; caller can retry.
                    } catch {
                        // SELECT failed (transient pg issue). Fall through to drain
                        // enqueue / fatal throw below — do not silently swallow.
                    }
                }
                // Reaching here means it was NOT a benign idempotency dedup
                // (which returned above) — a real INSERT failure worth an error.
                log.error('task_history INSERT failed', err as Error, {
                    runId,
                    taskId,
                });
                // Only drain on transient errors (connection lost, deadlock,
                // resource exhaustion). Permanent errors — constraint violations
                // not caught above, syntax/data-type errors — must surface so the
                // caller can react (e.g. invalid input → permanent failure).
                if (this.pendingWriteDrain && isTransientPgError(err)) {
                    await this.pendingWriteDrain.enqueue({
                        kind: 'insert',
                        authority: this.authority,
                        runId,
                        payload: {
                            taskId,
                            parentRunId: opts.parentRunId,
                            label,
                            state: 'pending',
                            input: parsed,
                            scope: Object.keys(scope).length > 0 ? scope : undefined,
                            trigger: triggerRecord,
                            actor,
                            startedAt: startedAt.toISOString(),
                            processingVersion: String(task.processingVersion),
                            ownerInstanceId: this.instanceId,
                            retentionPolicy: task.retention?.policy ?? 'standard',
                            stages: [],
                        },
                        enqueuedAt: Date.now(),
                    });
                    // CRITICAL (H1 data-loss fix): the INSERT did NOT land — the
                    // task_history row does not exist yet (the drain replays it as
                    // 'pending' once Postgres recovers). We must NOT fall through to
                    // enqueue the BullMQ job: a job whose row is absent runs to
                    // completion, but the terminal `UPDATE … WHERE id=runId` then
                    // matches 0 rows (silent no-op) so the result/cost is LOST, and
                    // boot-recovery later mis-marks the drained 'pending' row failed.
                    // Throw transient so NO job is enqueued; the caller
                    // (scheduler/sweep/retry) re-attempts startRun once Postgres is
                    // healthy, where it dedups against the drained row or creates +
                    // enqueues a fresh, row-backed run.
                    throw new TaskError({
                        message: `task_history INSERT failed (transient) — drained for replay, not enqueued: ${errMessage(err)}`,
                        kind: 'transient',
                        cause: err,
                    });
                } else {
                    // kind:'fatal' — startRun callers do not branch on
                    // transient-vs-fatal; the classification here is
                    // informational/telemetry only. Transient errors took
                    // the drain branch above, so anything reaching this
                    // throw is by definition non-recoverable for the
                    // caller (constraint violation, bad input, etc.).
                    throw new TaskError({
                        message: `task_history INSERT failed: ${errMessage(err)}`,
                        kind: 'fatal',
                        cause: err,
                    });
                }
            }
        }

        // Seed the Valkey hash so getRun returns merged state immediately and
        // QueueEvents-driven transitions have a row to mutate.
        //
        // IMPORTANT: do NOT write `ownerInstanceId` here. In split web+worker
        // deployments the orchestrator (on the web replica) enqueues; the
        // worker replica picks the job up. claim-run.lua rejects when the
        // existing owner differs from the claimant's instanceId, so seeding
        // the field with the orchestrator's INSTANCE_ID makes every
        // cross-replica claim fail. Leave it unset and let the runner write
        // it atomically via claim-run.lua at job pickup. Postgres still
        // records `owner_instance_id` on the task_history row above for
        // observability.
        try {
            await invokeOwnedCommand(
                [
                    'HSET',
                    `task:run:active:${runId}`,
                    'state',
                    'pending',
                    'taskId',
                    taskId,
                    'startedAt',
                    startedAt.toISOString(),
                    'updatedAt',
                    String(Date.now()),
                ],
                client,
                this.authority,
            );
            await invokeOwnedCommand(
                ['PEXPIRE', `task:run:active:${runId}`, String(LUMASTRA_RUN_STATE_TTL_ACTIVE_MS)],
                client,
                this.authority,
            );
        } catch (err) {
            // The Valkey hash is what claim-run.lua reads at job pickup.
            // If the seed HSET fails, the runner will reject with
            // 'run not found' and burn through all retry attempts before
            // boot-recovery sweeps the row 2 minutes later. Bail
            // transient so BullMQ retry kicks in once Valkey recovers.
            log.warn('Valkey HSET failed at startRun', {
                runId,
                err: errMessage(err),
            });
            throw new TaskError({
                message: `Valkey seed HSET failed for ${runId}: ${errMessage(err)}`,
                kind: 'transient',
                cause: err,
            });
        }

        // Enqueue. Per-task queue when the flag is on, per-class otherwise.
        const queue = this.resolveTaskQueue(task.id);
        if (!queue) {
            throw new TaskError({
                message: this.perTaskQueues
                    ? `No per-task queue registered for task: ${task.id}`
                    : `No queue registered for resource class: ${task.resourceClass}`,
                kind: 'fatal',
            });
        }

        const priority = earlyPriority;
        const jobData: {
            playbackCpuExempt?: boolean;
            runId: string;
            input: unknown;
            exclusivityKey?: string;
            resume?: ResumableJobData;
            taskAuthority?: AuthorityToken;
        } = {
            runId,
            input: parsed,
            ...(triggerRecord.kind === 'manual' ? { playbackCpuExempt: true } : {}),
            ...(this.authority ? { taskAuthority: this.authority } : {}),
        };
        // Marks a run the runner may leave 'active' on a graceful shutdown so
        // the reclaim can resume it (run-resume.ts), and keys ctx.checkpoint
        // to the chain's first run.
        if (isResumableRun(task, triggerRecord)) {
            jobData.resume = { rootRunId: opts.trigger?.resume?.rootRunId ?? runId };
        }
        // Stash the exclusivity key so the runner can DEL it on a final
        // terminal. Only when THIS call actually won the SETNX claim
        // (identityClaimed) — a duplicate already returned early above, and
        // a non-exclusiveWith task has no key.
        if (identityClaimed && exclusivityKey) {
            jobData.exclusivityKey = exclusivityKey;
        }
        // Backpressure and quota already checked above (before INSERT).

        // Encode runId into the job name suffix so QueueEvents handlers can
        // recover it without a queue probe even after BullMQ reaps the job.
        const jobIdWithRunId = taskJobId(`${jobId}#${runId}`, this.authority);

        const retryOptions = taskRetryOptions(task);
        const bullBackoff = retryOptions.backoff;

        // Enqueue failures propagate to startRun's outer catch WITHOUT a local
        // rollbackQuota: the task_history INSERT already committed above
        // (persisted.committed is true by this point), so the run legitimately
        // holds its quota slot whether the outer catch ends up marking it
        // 'failed' or leaves it live pending TTL. That outer catch is the
        // single place quota-release decisions are made.
        if (task.pipeline?.of) {
            await this.enqueuePipeline(
                task,
                parsed,
                runId,
                jobData,
                priority,
                opts,
                jobIdWithRunId,
                bullBackoff,
            );
        } else {
            await withTaskQueueWrite(
                sql,
                this.authority,
                { kind: 'add', queue: queue.name, jobId: jobIdWithRunId },
                () =>
                    queue.add(task.id, jobData, {
                        jobId: jobIdWithRunId,
                        priority,
                        attempts: retryOptions.attempts,
                        backoff: bullBackoff,
                        ...(opts.delayMs && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
                    }),
            );
        }

        await this.maybeMarkActiveInPostgres(runId);
        // Mirror of the row just inserted above — the started event has to carry
        // a full Run so it survives RunEventSchema parsing on the client, and
        // so every scope key (including subject correlation) reaches it.
        const startedRun: Run = {
            id: runId,
            taskId,
            parentRunId: opts.parentRunId ?? undefined,
            label,
            state: 'pending',
            input: parsed,
            scope: scope as Run['scope'],
            trigger: triggerRecord as Run['trigger'],
            actor: actor as unknown as Run['actor'],
            startedAt: startedAt.toISOString(),
            stages: [],
            ownerInstanceId: this.instanceId,
        };
        await this.emitCloudEventStarted(task.id, task.resourceClass, runId, startedRun);

        return { runId };
    }

    async startRun(
        taskId: string,
        input: unknown,
        opts: StartRunOpts = {},
    ): Promise<StartRunResult> {
        const task = this.resolveTask(taskId);
        const parsed = this.validateInput(task, taskId, input);
        this.enforceInputSizeCap(taskId, parsed);
        await this.circuitBreakerGate(taskId);

        const sql = this.getSql();
        const client = this.getClient();

        // Normalize idempotencyKey: empty-string `""` is treated as "no key".
        //
        // Why: the partial unique index `task_history_idempotency_key_unique`
        // uses `WHERE trigger ? 'idempotencyKey'`, which is true whenever the
        // key *exists* in the JSON object regardless of value. If we let `""`
        // through, every empty-string-keyed call for the same taskId collides
        // against the same partial-index row, and dedup turns into a
        // "any-other-empty-keyed-run wins" global lock. Reject `""` and any
        // non-string before the dedup code path runs.
        const idempotencyKey =
            typeof opts.idempotencyKey === 'string' && opts.idempotencyKey.length > 0
                ? opts.idempotencyKey
                : undefined;

        const dedup = await this.idempotencyDedup(taskId, idempotencyKey, sql);
        if (dedup) return dedup;

        const idn = await this.claimIdentity(task, taskId, parsed, client, sql);
        if (idn.kind === 'duplicate') return idn.result;
        const { runId, jobId, exclusivityKey, identityClaimed } = idn;

        const { trigger, triggerRecord, scope, actor, label, startedAt } = this.assembleRunMetadata(
            task,
            taskId,
            opts,
            idempotencyKey,
        );

        // Roll back the SETNX identity key on any downstream failure so
        // subsequent calls don't see a phantom dedup hit pointing at a runId
        // that never landed in Postgres.
        const rollbackIdentity = async (): Promise<void> => {
            if (!identityClaimed || !exclusivityKey) return;
            try {
                // Compare-and-delete on this run's runId (the value the SETNX
                // stored) so a rollback can't delete a successor's key if ours
                // already expired and was re-claimed. Best-effort — Lua TTL
                // eventually cleans it up otherwise.
                await luaLoader.invoke(
                    'release-identity',
                    [exclusivityKey],
                    [runId],
                    client,
                    this.authority,
                );
            } catch {
                // Best-effort — Lua TTL will eventually clean it up.
            }
        };

        // Backpressure check BEFORE Postgres INSERT and Valkey HSET so a drop
        // doesn't leave a pending-orphan task_history row that boot-recovery
        // has to sweep 2 minutes later. We resolve priority here once so the
        // check sees the same priority that the enqueue uses below.
        //
        // Priority resolution order:
        //   1. opts.priority — explicit caller override (e.g. admin
        //      "retry now" sets priority=1 to jump the queue)
        //   2. task.taskPriority — static per-task override (e.g.
        //      lumastra-intro-analyzer sets priority=3 to cut ahead of
        //      trickplay-generation's default-5 in the same cpu queue)
        //   3. priorityFromTrigger — trigger-derived fallback
        //      (in-process / manual / webhook → 5; pipeline-child / resume → 7)
        const earlyPriority =
            opts.priority ?? task.taskPriority ?? priorityFromTrigger(trigger.kind);
        const bp = await this.backpressureDrop(task, earlyPriority);
        if (bp.drop) {
            await rollbackIdentity();
            throw new TaskError({
                message: `Backpressure ${bp.reason} for task ${taskId}`,
                kind: 'transient',
            });
        }

        // Quota check (TASK-C4) — reserve a slot in today's daily bucket BEFORE
        // the Postgres task_history INSERT and Valkey HSET so an over-cap request
        // never leaves a phantom pending row or a stale active hash. Enforced in
        // Postgres (task_quota_usage), not Valkey, so the cap cannot be bypassed
        // by TTL'd-key eviction under memory pressure. The release-on-failure
        // path below keeps the bucket accurate when a later step fails.
        //
        // acquireDailyQuotaSlot is invoked exactly once per startRun call —
        // startRun does not retry internally — so this cannot double-count.
        // BullMQ-level retries re-run processJob (not startRun), so they hit
        // maxConcurrent on the runner side, never the daily bucket here.
        // The `acquired` flag is only set AFTER a confirmed increment, so
        // rollbackQuota no-ops when nothing was reserved (no quota, over-cap
        // rejection that incremented nothing, or null sql).
        const quota: { acquired: boolean; rolledBack: boolean; day?: string } = {
            acquired: false,
            rolledBack: false,
        };
        await this.acquireQuota(task, taskId, quota, rollbackIdentity, sql);
        const rollbackQuota = async (): Promise<void> => {
            if (!quota.acquired || quota.rolledBack || !sql) return;
            quota.rolledBack = true;
            try {
                // Release against the day the slot was acquired (quota.day), not
                // "today", so a rollback that crosses UTC midnight still rolls back
                // the correct bucket (TASK-C4).
                await releaseDailyQuotaSlot(sql, taskId, quota.day);
            } catch {
                // Best-effort — a leaked +1 only costs one slot in today's
                // bucket and rolls off when the next UTC day starts.
            }
        };

        // Mutated in place by persistAndEnqueue the instant its task_history
        // INSERT commits — see the field doc on persistAndEnqueue's args.
        const persisted: { committed: boolean } = { committed: false };
        try {
            return await this.persistAndEnqueue({
                task,
                taskId,
                parsed,
                opts,
                sql,
                client,
                runId,
                jobId,
                exclusivityKey,
                identityClaimed,
                idempotencyKey,
                label,
                scope,
                triggerRecord,
                actor,
                startedAt,
                earlyPriority,
                persisted,
            });
        } catch (err) {
            if (err instanceof QueueOperationUncertainError) {
                // A negative getJob probe cannot prove a timed-out add will not
                // arrive later. Preserve the run and its identity/quota until
                // explicit queue reconciliation resolves the durable journal.
                log.warn('Queue publication outcome unknown', {
                    runId,
                    taskId,
                    operationId: err.operationId,
                });
                throw err;
            }
            if (!persisted.committed) {
                // The task_history INSERT never landed — nothing durable
                // exists yet, so the plain rollback is correct.
                await rollbackIdentity();
                await rollbackQuota();
                throw err;
            }
            // The row committed before this failure (Valkey HSET blip, or an
            // ambiguous queue.add ack that may have actually landed in
            // BullMQ despite the throw). Compensate instead of a bare
            // rollback: confirm no live job remains AND the row is marked
            // terminal before releasing the identity slot — otherwise a
            // fresh trigger for the same exclusiveWith formula could claim a
            // second identity while the first run is genuinely still live,
            // which is exactly the single-flight break this guard exists to
            // prevent.
            const compensationJobId = taskJobId(`${jobId}#${runId}`, this.authority);
            let jobConfirmedGone = false;
            try {
                const queue = this.resolveTaskQueue(taskId);
                const job = queue ? await queue.getJob(compensationJobId) : undefined;
                if (!job) {
                    // Never enqueued, already reaped, or already completed —
                    // no live job to worry about.
                    jobConfirmedGone = true;
                } else {
                    // Throws if BullMQ has already locked the job for
                    // processing — that means a run IS live, so leave
                    // jobConfirmedGone false and fall through to the
                    // leave-identity-in-place branch below.
                    assertTaskJobOrigin(this.authority, job.data.taskAuthority, job.id);
                    await withTaskQueueWrite(
                        this.getSql(),
                        this.authority,
                        { kind: 'remove', queue: queue!.name, jobId: job.id },
                        () => job.remove(),
                        { allowDraining: true },
                    );
                    jobConfirmedGone = true;
                }
            } catch (removeErr) {
                log.warn('startRun compensation: could not confirm BullMQ job removal', {
                    runId,
                    taskId,
                    jobId: compensationJobId,
                    err: errMessage(removeErr),
                });
            }

            // No sql connection means task_history was never actually
            // written (persisted.committed can only flip true inside the
            // `if (sql)` branch of persistAndEnqueue), so there is nothing
            // to mark terminal — treat that leg as satisfied.
            let rowMarkedFailed = !sql;
            if (sql) {
                try {
                    const rows = await withExistingTaskWrite(
                        sql,
                        this.authority,
                        async (tx) => tx<{ id: string }[]>`
                        UPDATE task_history
                        SET state = 'failed',
                            completed_at = NOW(),
                            error = ${sql.json({
                                message: `startRun compensation: ${errMessage(err)}`,
                            } as unknown as postgres.JSONValue)}
                        WHERE id = ${runId} AND state = 'pending'
                        RETURNING id
                    `,
                    );
                    rowMarkedFailed = rows.length > 0;
                } catch (updateErr) {
                    log.warn('startRun compensation: failed to mark orphaned pending row failed', {
                        runId,
                        taskId,
                        err: errMessage(updateErr),
                    });
                }
            }

            if (jobConfirmedGone && rowMarkedFailed) {
                await rollbackIdentity();
            } else {
                // Leave the identity key in place — its TTL is the backstop.
                // Releasing it here without both confirmations could free the
                // slot for a re-trigger while this run is still genuinely
                // live (job) or task_history still reads 'pending' (row —
                // e.g. a concurrent runner claim already flipped it to
                // 'active' between our throw and this compensation, which is
                // itself proof the run is live and must not be double-run).
                log.warn(
                    'startRun compensation: leaving identity claim in place pending TTL — could not confirm both job removal and terminal row write',
                    { runId, taskId, jobConfirmedGone, rowMarkedFailed },
                );
            }
            // Do NOT release the quota slot here: whether the run is now
            // marked 'failed' (rowMarkedFailed) or left 'pending'/'active'
            // (a live job survived compensation), the run legitimately holds
            // a task_history row for today's bucket — rollbackQuota's own
            // guard only compensates a slot that never got a run behind it
            // (see acquireQuota/rollbackQuota above). Releasing it here would
            // let this task exceed maxRunsPerDay by one for every run that
            // hits this path.
            throw err;
        }
    }

    private async enqueuePipeline(
        task: TaskDefinition,
        parsedInput: unknown,
        runId: string,
        jobData: Record<string, unknown>,
        priority: number,
        opts: StartRunOpts,
        jobIdWithRunId?: string,
        bullBackoff?: { type: 'exponential' | 'fixed'; delay: number },
    ): Promise<void> {
        const fp = this.flowProducer;
        if (!fp) {
            // Fallback: enqueue root only (per-task queue when flag on).
            const queue = this.resolveTaskQueue(task.id);
            if (queue) {
                const fallbackJobId =
                    jobIdWithRunId ??
                    taskJobId(
                        `${computeIdentity(task as TaskDefinition<unknown, unknown>, parsedInput)}#${runId}`,
                        this.authority,
                    );
                await withTaskQueueWrite(
                    this.getSql(),
                    this.authority,
                    { kind: 'add', queue: queue.name, jobId: fallbackJobId },
                    () =>
                        queue.add(task.id, jobData, {
                            jobId: fallbackJobId,
                            priority,
                            attempts: taskRetryOptions(task).attempts,
                            backoff: bullBackoff,
                        }),
                );
            }
            return;
        }
        if (!task.pipeline?.of) return;

        // Delegate tree construction to pipeline-builder.ts. The orchestrator
        // keeps ownership of Postgres inserts and FlowProducer submission.
        const plan = buildPipelinePlan(
            task.pipeline.of,
            task,
            parsedInput,
            {
                priority: priority as 1 | 2 | 3 | 5 | 7,
                libraryGroupId: opts.libraryGroupId,
                userId: opts.userId,
                // When the flag is on, FlowJobs must target per-task queues
                // (`bull:task:t:<taskId>`) so the per-task Workers drain them;
                // gate jobs route to the convergent task's per-task queue.
                perTaskQueues: this.perTaskQueues,
            },
            this.registry,
        );

        // Override the rootRunId assigned by the builder with the runId the
        // orchestrator already wrote to Postgres + Valkey (it was generated
        // before this method was called).
        plan.runIdsByTaskId.set(task.id, runId);
        // Patch the trigger task's FlowJob data: reconcile its runId and thread
        // the exclusiveWith mutex key through so the runner releases it on the
        // trigger's terminal (jobData carries the key only when this call won
        // the SETNX claim).
        patchFlowJobData(
            plan.flowJobs,
            task.id,
            runId,
            typeof jobData.exclusivityKey === 'string' ? jobData.exclusivityKey : undefined,
        );

        if (jobData.playbackCpuExempt === true) {
            const exempt = (jobs: FlowJob[]): void => {
                for (const job of jobs) {
                    (job.data as Record<string, unknown>).playbackCpuExempt = true;
                    if (job.children) exempt(job.children);
                }
            };
            exempt(plan.flowJobs);
        }

        // Insert task_history rows for every pipeline member that is NOT the
        // trigger task (trigger was already inserted by the caller).
        const sql = this.getSql();
        if (sql) {
            for (const [taskId, memberRunId] of plan.runIdsByTaskId) {
                if (taskId === task.id) continue; // already inserted

                // Synthetic fan-in gate (`__gate__<convergentTaskId>`). These
                // have no registered task definition, so they used to be skipped
                // here and were invisible to admin UI / circuit breaker (TASK-C7).
                // Persist a minimal `pending` row so the gate is traceable; the
                // runner flips it to `completed` (or `failed`) when BullMQ
                // releases the gate. Standard retention — the normal
                // task_history cleanup prunes these alongside member rows.
                if (taskId.startsWith('__gate__')) {
                    const convergentTaskId = taskId.slice('__gate__'.length);
                    const gateStartedAt = new Date();
                    try {
                        await insertTaskHistoryRow(
                            sql,
                            {
                                id: memberRunId,
                                taskId,
                                parentRunId: runId,
                                label: `gate: ${convergentTaskId}`,
                                state: 'pending',
                                input: {},
                                scope: null,
                                trigger: { kind: 'pipeline-gate' },
                                actor: { type: 'system', via: 'in-process' },
                                startedAt: gateStartedAt,
                                processingVersion: 0,
                                ownerInstanceId: this.instanceId,
                                retentionPolicy: 'standard',
                                stages: [],
                            },
                            this.authority,
                        );
                    } catch (err) {
                        log.warn('pipeline gate task_history INSERT failed', {
                            memberRunId,
                            taskId,
                            err: errMessage(err),
                        });
                        // Mirror the pipeline-member branch below: a transient
                        // failure (connection lost, deadlock) means the gate
                        // row does not exist yet, so drain it for replay —
                        // otherwise the gate's own terminal UPDATE (fired by
                        // the runner when BullMQ releases it) matches 0 rows
                        // and is silently lost. Permanent errors stay
                        // logged-only, same as the sibling branch.
                        if (this.pendingWriteDrain && isTransientPgError(err)) {
                            void this.pendingWriteDrain.enqueue({
                                kind: 'insert',
                                authority: this.authority,
                                runId: memberRunId,
                                payload: {
                                    taskId,
                                    parentRunId: runId,
                                    label: `gate: ${convergentTaskId}`,
                                    state: 'pending',
                                    input: {},
                                    trigger: { kind: 'pipeline-gate' },
                                    actor: { type: 'system', via: 'in-process' },
                                    startedAt: gateStartedAt.toISOString(),
                                    processingVersion: '0',
                                    ownerInstanceId: this.instanceId,
                                    retentionPolicy: 'standard',
                                    stages: [],
                                },
                                enqueuedAt: Date.now(),
                            });
                        }
                    }
                    continue;
                }

                const member = this.registry.getTask(taskId);
                if (!member) continue;
                const startedAt = new Date();
                try {
                    await insertTaskHistoryRow(
                        sql,
                        {
                            id: memberRunId,
                            taskId,
                            parentRunId: runId,
                            label: member.name || taskId,
                            state: 'pending',
                            input: {},
                            scope: null,
                            trigger: { kind: 'pipeline-child' },
                            actor: { type: 'system', via: 'in-process' },
                            startedAt,
                            processingVersion: member.processingVersion,
                            ownerInstanceId: this.instanceId,
                            retentionPolicy: member.retention?.policy ?? 'standard',
                            stages: [],
                        },
                        this.authority,
                    );
                } catch (err) {
                    log.warn('pipeline member task_history INSERT failed', {
                        memberRunId,
                        taskId,
                        err: errMessage(err),
                    });
                    // Transient (connection lost, deadlock) → drain so claim-run
                    // doesn't fail with 'run not found' when the worker picks up
                    // the child job. Permanent errors stay logged-only — the
                    // child job will still be enqueued by the FlowProducer and
                    // boot-recovery / reconciler will sweep the orphan.
                    if (this.pendingWriteDrain && isTransientPgError(err)) {
                        void this.pendingWriteDrain.enqueue({
                            kind: 'insert',
                            authority: this.authority,
                            runId: memberRunId,
                            payload: {
                                taskId,
                                parentRunId: runId,
                                label: member.name || taskId,
                                state: 'pending',
                                input: {},
                                trigger: { kind: 'pipeline-child' },
                                actor: { type: 'system', via: 'in-process' },
                                startedAt: startedAt.toISOString(),
                                processingVersion: String(member.processingVersion),
                                ownerInstanceId: this.instanceId,
                                retentionPolicy: member.retention?.policy ?? 'standard',
                                stages: [],
                            },
                            enqueuedAt: Date.now(),
                        });
                    }
                }
            }
        }

        // Submit FlowJob trees. Multiple roots = parallel pipeline branches.
        const stamp = (jobs: FlowJob[]): void => {
            for (const job of jobs) {
                const data = job.data as Record<string, unknown>;
                if (this.authority) {
                    data.taskAuthority = this.authority;
                    if (!job.opts?.jobId)
                        throw new Error('Managed flow requires explicit job identity');
                    const suffix = job.opts.jobId.lastIndexOf('#');
                    if (suffix < 0 || typeof data.runId !== 'string')
                        throw new Error('Invalid managed flow run identity');
                    job.opts.jobId = taskJobId(
                        `${job.opts.jobId.slice(0, suffix)}#${data.runId}`,
                        this.authority,
                    );
                }
                if (job.children) stamp(job.children);
            }
        };
        stamp(plan.flowJobs);
        for (const root of plan.flowJobs) {
            await withTaskQueueWrite(
                sql,
                this.authority,
                { kind: 'flow-add', queue: root.queueName, jobId: root.opts?.jobId },
                () => fp.add(root),
            );
        }
    }

    private async maybeMarkActiveInPostgres(runId: string): Promise<void> {
        // This is intentionally a no-op in the orchestrator. The pending→active
        // transition is owned by the runner via claim-run.lua at job pickup time.
        // This method is the designated seam for future use — e.g. marking
        // pipeline children as 'active' when their parent completes (Task J).
        void runId;
    }

    private async emitCloudEventStarted(
        taskId: string,
        cls: ResourceClass,
        runId: string,
        run: Run,
    ): Promise<void> {
        // Publish the redacted projection, not a hand-assembled subset. The
        // previous literal `scope: { libraryGroupId, userId }` silently dropped
        // any scope key added later, and the payload could not be parsed by
        // RunSchema at all, so every started event was discarded client-side.
        const event = cloudEvents.runStarted(taskId, runId, toRunEvent(run));
        try {
            // All pub/sub, like the keyed state, runs on the task Valkey.
            await publishMessage(`task:events:${cls}`, JSON.stringify(event));
        } catch (err) {
            log.warn('CloudEvent publish failed', {
                type: event.type,
                runId,
                err: errMessage(err),
            });
        }
        if (this.webhookOutbox) {
            try {
                await this.webhookOutbox.enqueue(event);
            } catch (err) {
                log.warn('WebhookOutbox enqueue failed', {
                    type: event.type,
                    runId,
                    err: errMessage(err),
                });
            }
        }
    }

    async cancelRun(
        runId: string,
        opts: { hard?: boolean; reason?: string } = {},
    ): Promise<CancelRunResult> {
        return this.cancelRunInternal(runId, opts, new Set());
    }

    /**
     * Start the run that continues one a worker restart interrupted
     * (resume-after-restart, run-resume.ts). Called by the reclaim path only
     * after every loop-protection rule passed. Goes through the normal
     * startRun — identity dedup, backpressure, quota, the runner's
     * maxConcurrent + class budget — so a resumed run is never special-cased
     * past a limit. Re-validates the task's opt-in in case it was removed by
     * the deploy that caused the restart.
     */
    async resumeInterruptedRun(req: {
        taskId: string;
        input: unknown;
        trigger: { kind: 'manual'; by?: string; sourceRoute?: string };
        resume: ResumeInfo;
        authority?: AuthorityToken;
        scope?: {
            libraryGroupId?: string;
            userId?: string;
            subject?: { type: 'mediaItem'; id: string };
        };
    }): Promise<StartRunResult> {
        if (!sameTaskAuthority(req.authority, this.authority))
            throw new AuthorityError('stale_authority');
        const task = this.resolveTask(req.taskId);
        if (task.resumeAfterRestart !== true) {
            throw new TaskError({
                message: `task ${req.taskId} no longer declares resumeAfterRestart`,
                kind: 'permanent',
            });
        }
        if (req.resume.count < 1 || req.resume.count > RESUME_MAX) {
            throw new TaskError({
                message: `resume count ${req.resume.count} out of range`,
                kind: 'permanent',
            });
        }
        return this.startRun(req.taskId, req.input, {
            trigger: { ...req.trigger, resume: req.resume },
            delayMs: this.resumeBackoffMs * req.resume.count,
            libraryGroupId: req.scope?.libraryGroupId,
            userId: req.scope?.userId,
            subject: req.scope?.subject,
        });
    }

    private async cancelRunInternal(
        runId: string,
        opts: { hard?: boolean; reason?: string },
        seen: Set<string>,
    ): Promise<CancelRunResult> {
        // Cycle guard — a corrupted parent_run_id graph could otherwise blow
        // the stack via mutual cancellation. Cap recursion to one visit per
        // run id; revisits become no-ops.
        if (seen.has(runId)) return { accepted: false, reason: 'not_found' };
        seen.add(runId);
        // Hard cap to bound runaway pipelines even when graph traversal is
        // acyclic but extremely deep.
        if (seen.size > 1000) {
            log.warn('cancelRun: aborting cascade — depth limit reached', {
                runId,
                depth: seen.size,
            });
            return { accepted: false, reason: 'not_found' };
        }

        const sql = this.getSql();
        const client = this.getClient();

        // Determine current state — prefer Valkey hash (live), fall back to Postgres.
        const current = await this.readRunState(runId);
        if (!current) return { accepted: false, reason: 'not_found' };
        if (current === 'completed' || current === 'failed' || current === 'cancelled') {
            return { accepted: false, reason: 'terminal' };
        }
        // Re-entrant cancel for a run already in 'cancelling'.
        //
        // A re-entrant SOFT cancel is a genuine no-op: without this short-circuit
        // the Lua transition rejects with an invalid-transition error AND we
        // still fire PUBLISH + UPDATE, generating duplicate cancel pubsubs and a
        // redundant DB write.
        //
        // A re-entrant HARD cancel ("Force stop") is NOT a no-op. The admin UI
        // only ENABLES the Force-stop button once a run is already 'cancelling'
        // (RunDetailPanel.svelte) — so a hard cancel ALWAYS arrives here, after
        // the soft cancel transitioned the run. If we returned early it would do
        // nothing, which is exactly the bug that left music-analysis "Stopping…"
        // for 2h in prod: the worker had lost its BullMQ job lock and become a
        // zombie that kept beating its heartbeat, so neither the soft-cancel
        // abort nor any liveness guard could finalize it, and Force-stop never
        // escalated. Schedule the hard-kill here so it force-writes the terminal
        // state (Postgres + Valkey + BullMQ job bypass) without the wedged
        // worker's cooperation. The hard-kill is a near-immediate deadline (the
        // operator already waited through the soft-cancel window before clicking
        // Force); HardKill.execute() no-ops if the run finalizes first.
        if (current === 'cancelling') {
            if (opts.hard && this.hardKill) {
                this.hardKill.schedule(runId, HARD_CANCEL_REENTRANT_DEADLINE_MS);
                return { accepted: true, deferred: 'hard-kill' };
            }
            return { accepted: true, reason: 'already_cancelling' };
        }

        // Lua transition writes Valkey — the source of truth — first.
        const transition = await this.stateMachine.transitionRun({
            runId,
            from: current,
            to: 'cancelling',
            extra: {
                cancelledAt: nowIso(),
                ...(opts.reason ? { cancelReason: opts.reason } : {}),
            },
        });
        if (!transition.ok && transition.error !== 'run not found') {
            log.warn('cancelRun transition rejected', {
                runId,
                error: transition.error,
            });
        }

        // Mirror the state change to Postgres before publishing so that
        // subscribers who poll the DB after receiving the pubsub message
        // observe the intermediate 'cancelling' state correctly.
        if (sql) {
            try {
                const cancellingRows = await withExistingTaskWrite(
                    sql,
                    this.authority,
                    async (tx) => tx`
                    UPDATE task_history
                    SET state = 'cancelling',
                        cancel_requested_at = NOW()
                    WHERE id = ${runId}
                      AND state NOT IN ('completed', 'failed', 'cancelled', 'cancelling')
                    RETURNING id, task_id, parent_run_id, label, state, input, scope,
                              trigger, actor, started_at, execution_started_at, completed_at, heartbeat_at,
                              stages, result, error, cost_breakdown, owner_instance_id
                `,
                );
                // Publish the intermediate transition. Without it no client ever
                // learns a run entered `cancelling`: the terminal `cancelled`
                // event only arrives once the handler finishes unwinding, which
                // for an active run can be minutes later. RETURNING gates the
                // emit so a repeat cancel cannot double-publish.
                const cancellingRow = cancellingRows[0];
                if (cancellingRow) {
                    const cancellingRun = this.rowToRun(cancellingRow);
                    if (cancellingRun) {
                        const cls =
                            this.registry.getTask(cancellingRun.taskId)?.resourceClass ?? 'io';
                        try {
                            await publishMessage(
                                `task:events:${cls}`,
                                JSON.stringify(
                                    cloudEvents.runCancelling(
                                        cancellingRun.taskId,
                                        runId,
                                        toRunEvent(cancellingRun),
                                    ),
                                ),
                            );
                        } catch (err) {
                            log.warn('cancelling CloudEvent publish failed', {
                                runId,
                                err: errMessage(err),
                            });
                        }
                    }
                }
            } catch (err) {
                log.warn('cancelRun Postgres mirror failed', {
                    runId,
                    err: errMessage(err),
                });
                // Drain transient errors so the intermediate 'cancelling' state
                // eventually reaches Postgres even if the DB is briefly down.
                if (this.pendingWriteDrain && isTransientPgError(err)) {
                    void this.pendingWriteDrain.enqueue({
                        kind: 'update',
                        authority: this.authority,
                        runId,
                        // Carry cancelRequestedAt so the deferred replay still
                        // populates cancel_requested_at — otherwise a cancel that
                        // hit a transient DB error would leave the column NULL and
                        // the reconciler's cancel-grace sweep could never see it.
                        payload: { state: 'cancelling', cancelRequestedAt: nowIso() },
                        enqueuedAt: Date.now(),
                    });
                }
            }
        }

        // Pubsub the cancel last — TaskRunner picks this up and aborts the run.
        // Published after both Valkey and Postgres updates so subscribers see
        // a consistent 'cancelling' intermediate state. Route through the
        // shared `publishCancel` helper so the wire format (one shared
        // `task:cancel` channel, runId in the payload) stays in lockstep with
        // the subscriber side (runner.ts → subscribeToCancel) — both anchored
        // on `CANCEL_CHANNEL` in cancel-channel.ts.
        // Cancellation pub/sub runs on the task Valkey too (all pub/sub does);
        // the runner heartbeat's cancel_requested_at poll is the durable
        // fallback when this PUBLISH is lost.
        await publishCancel(runId, opts.reason);

        // Cancel-before-pickup finalization. The runner-side cancel terminal
        // write (runner.ts:618-672) only runs when a worker has claimed the
        // run. A cancel for a pending run that no runner ever picked up sits
        // in 'cancelling' forever until the 5-min reconciler sweep (which
        // marks it 'failed', not 'cancelled'). Drive cancelling→cancelled
        // here when the pre-cancel state was 'pending' AND the Valkey active
        // hash has no ownerInstanceId.
        //
        // Race safety: the Lua transition is atomic. If a worker concurrently
        // claimed the run between our pending→cancelling and cancelling→
        // cancelled, the Lua will reject (state≠'cancelling' because the
        // worker transitioned to 'active'). In that case the worker's normal
        // cancel path (driven by the pubsub above) takes over and finalizes.
        if (current === 'pending') {
            let ownerInstanceId: string | null = null;
            try {
                const raw = await client.customCommand([
                    'HGET',
                    `task:run:active:${runId}`,
                    'ownerInstanceId',
                ]);
                ownerInstanceId = typeof raw === 'string' && raw.length > 0 ? raw : null;
            } catch (err) {
                log.warn('cancelRun owner probe failed', {
                    runId,
                    err: errMessage(err),
                });
            }
            if (!ownerInstanceId) {
                const finalize = await this.stateMachine.transitionRun({
                    runId,
                    from: 'cancelling',
                    to: 'cancelled',
                    extra: { cancelledAt: nowIso() },
                });
                if (finalize.ok) {
                    await this.writeTerminalToPostgres(runId, 'cancelled', {
                        completedAt: nowIso(),
                        ...(opts.reason
                            ? { cancelReason: opts.reason }
                            : { cancelReason: 'cancel-before-pickup' }),
                    });
                    // No handler will execute its normal terminal cleanup.
                    // Confirm durable cancellation before releasing the mutex;
                    // compare-and-delete cannot free a successor's claim.
                    if (sql) {
                        try {
                            const [row] = await sql<{ task_id: string; input: unknown }[]>`
                                SELECT task_id, input FROM task_history
                                WHERE id = ${runId} AND state = 'cancelled'
                            `;
                            const task = row && this.registry.getTask(row.task_id);
                            if (row && task?.exclusiveWith) {
                                await luaLoader.invoke(
                                    'release-identity',
                                    [identityKey(task.id, computeIdentity(task, row.input))],
                                    [runId],
                                    client,
                                    this.authority,
                                );
                            }
                        } catch (err) {
                            log.warn('Cancel-before-pickup identity release failed', {
                                runId,
                                err: errMessage(err),
                            });
                        }
                    }
                }
                // If finalize rejected, a worker claimed concurrently and
                // transitioned the hash out of 'cancelling' — the worker's
                // own cancel path will finalize via the pubsub.
            }
        }

        // Pipeline cascade: cancel children whose parent_run_id == runId.
        // Processed in parallel batches of 20 to bound concurrency on deep trees.
        if (sql) {
            try {
                const children = await sql<{ id: string }[]>`
                    SELECT id FROM task_history
                    WHERE parent_run_id = ${runId}
                      AND state NOT IN ('completed', 'failed', 'cancelled')
                `;
                const CANCEL_BATCH_SIZE = 20;
                for (let i = 0; i < children.length; i += CANCEL_BATCH_SIZE) {
                    const chunk = children.slice(i, i + CANCEL_BATCH_SIZE);
                    // Per-child catch so one rejected child does not abort
                    // the entire batch loop (and skip every remaining chunk).
                    await Promise.all(
                        chunk.map((c) =>
                            this.cancelRunInternal(c.id, opts, seen).catch((err) => {
                                log.warn('cascade child cancel failed', {
                                    parentRunId: runId,
                                    childRunId: c.id,
                                    err: errMessage(err),
                                });
                                return { accepted: false };
                            }),
                        ),
                    );
                }
            } catch (err) {
                log.warn('cancelRun cascade failed', {
                    runId,
                    err: errMessage(err),
                });
            }
        }

        if (opts.hard && this.hardKill) {
            this.hardKill.schedule(runId);
            return { accepted: true, deferred: 'hard-kill' };
        }

        return { accepted: true };
    }

    private async readRunState(runId: string): Promise<RunState | null> {
        const client = this.getClient();
        try {
            const raw = await client.customCommand(['HGET', `task:run:active:${runId}`, 'state']);
            if (typeof raw === 'string') return raw as RunState;
            const term = await client.customCommand([
                'HGET',
                `task:run:terminal:${runId}`,
                'state',
            ]);
            if (typeof term === 'string') return term as RunState;
        } catch {
            // Fall back to DB.
        }
        const sql = this.getSql();
        if (!sql) return null;
        try {
            const rows = await sql<{ state: RunState }[]>`
                SELECT state FROM task_history WHERE id = ${runId} LIMIT 1
            `;
            return rows[0]?.state ?? null;
        } catch {
            return null;
        }
    }

    /**
     * True when the runner left this run for resume-after-restart. Fails OPEN
     * (false) on a Valkey error: writing 'failed' then only means "not
     * resumed", while skipping would leave e.g. a fan-in parent pending.
     */
    private async hasInterruptMarker(runId: string): Promise<boolean> {
        try {
            const raw = await this.getClient().customCommand(['EXISTS', interruptMarkerKey(runId)]);
            return Number(raw) > 0 || raw === true;
        } catch (err) {
            log.warn('Interrupt-marker check failed; treating the run as not resumable', {
                runId,
                err: errMessage(err),
            });
            return false;
        }
    }

    /**
     * Best-effort DEL of a run's live Valkey state hash. Used (TASK-C8) when a
     * run reaches a terminal state without going through the Lua transition
     * (which normally DELs `task:run:active:*` and seeds `task:run:terminal:*`).
     * A convergent parent failed via BullMQ `failParentOnFailure` never runs its
     * processor, so its seeded `pending` hash (if any) would otherwise linger and
     * be re-classified as a stale orphan by the reconciler. Failure to DEL is
     * non-fatal — the hash carries a TTL and the run is already terminal in
     * Postgres.
     */
    private async discardRunStateHash(runId: string): Promise<void> {
        try {
            const client = this.getClient();
            await invokeOwnedCommand(['DEL', `task:run:active:${runId}`], client, this.authority);
        } catch (err) {
            log.warn('discardRunStateHash DEL failed', {
                runId,
                err: errMessage(err),
            });
        }
    }

    async nuclearStop(
        taskId: string,
        opts?: { force?: boolean; reason?: string },
    ): Promise<NuclearStopResult> {
        // Throws rather than answering {0, 0}: callers report these counts to
        // an operator, and "nothing was running" is the wrong reading of a
        // database that could not be asked.
        const sql = this.getSql();
        if (!sql) throw new Error('nuclearStop: task database unavailable');
        let cancelled = 0;
        let orphaned = 0;
        let escalated = 0;
        // Graceful by default, like single-run cancel; `force: true` escalates
        // to the hard-kill path (which also finalizes runs wedged in
        // 'cancelling'). Never do more than the operator asked for.
        const hard = opts?.force === true;
        const reason = opts?.reason ?? 'nuclear-stop';
        try {
            const rows = await sql<{ id: string }[]>`
                SELECT id FROM task_history
                WHERE task_id = ${taskId}
                  AND state IN ('pending', 'active', 'cancelling')
            `;
            for (const r of rows) {
                // Soft (default): runs already 'cancelling' are left to finish
                // stopping — escalate with force. Hard: the hard-kill path
                // force-finalizes them too.
                const res = await this.cancelRun(r.id, { hard, reason });
                if (res.accepted) {
                    cancelled++;
                    if (res.deferred === 'hard-kill') escalated++;
                } else {
                    // Finished (or vanished) between the SELECT and the cancel.
                    orphaned++;
                }
            }
        } catch (err) {
            log.error('nuclearStop failed', err as Error, { taskId, cancelled, orphaned });
            throw err;
        }
        return { cancelled, orphaned, escalated };
    }

    /** Confirm a future execution after the caller's observation, including retry backoff. */
    async isRunQueued(taskId: string, input: unknown, runId: string): Promise<boolean> {
        const task = this.registry.getTask(taskId);
        if (!task) return false;
        const queue = this.resolveTaskQueue(taskId);
        if (!queue) return false;
        const identity = computeIdentity(task, task.inputSchema.parse(input));
        const job = await queue.getJob(taskJobId(`${identity}#${runId}`, this.authority));
        if (!job || job.name !== taskId) return false;
        const state = await job.getState();
        // Active scans may already have passed a changed file. Only a queued
        // execution can cover the caller's gap without admitting another scan.
        return state === 'waiting' || state === 'prioritized' || state === 'delayed';
    }

    async getRun(runId: string): Promise<Run | null> {
        const sql = this.getSql();
        if (!sql) return null;
        const rows = await sql<Record<string, unknown>[]>`
            SELECT id, task_id, parent_run_id, label, state, input, scope, trigger, actor,
                   started_at, execution_started_at, completed_at, heartbeat_at, stages, result, error,
                   cost_breakdown, owner_instance_id
            FROM task_history WHERE id = ${runId} LIMIT 1
        `;
        if (rows.length === 0) return null;
        const base = this.rowToRun(rows[0]);
        if (!base) return null;

        if (base.state === 'completed' || base.state === 'failed' || base.state === 'cancelled') {
            return base;
        }

        return await this.mergeLiveProgress(base);
    }

    /**
     * Merge live Valkey hash fields onto a Run for non-terminal states.
     * Returns a NEW Run object with `heartbeatAt`, `state`, and per-stage
     * progress updated from `stage:<id>:processed/total/currentItem`.
     * Best-effort: on Valkey unavailability the input `base` is returned
     * unchanged.
     *
     * Returning a new object (rather than mutating `base` in place) is
     * architectural hygiene per review-finding CR-5: today `listRuns`
     * holds the only reference, but if Run objects are ever cached or
     * shared across calls in future, in-place mutation would silently
     * corrupt cached state. Cost is bounded by stage count (typically <5).
     *
     * Extracted from `getRun` so `listRuns` can also surface live progress
     * for active rows — `task_history.stages` JSONB is only written on
     * terminal transitions, so without this merge the bus seed for
     * `state=active` would show zero progress.
     */
    private async mergeLiveProgress(base: Run): Promise<Run> {
        if (base.state === 'completed' || base.state === 'failed' || base.state === 'cancelled') {
            return base;
        }
        try {
            const client = this.getClient();
            const raw = await client.customCommand(['HGETALL', `task:run:active:${base.id}`]);
            const live = parseHGetAll(raw);
            const merged: Run = { ...base };
            const liveHeartbeatAt = normalizeLiveHeartbeatAt(live.heartbeatAt);
            if (liveHeartbeatAt) {
                const baseHeartbeatAt = normalizeLiveHeartbeatAt(base.heartbeatAt);
                if (!baseHeartbeatAt || Date.parse(liveHeartbeatAt) > Date.parse(baseHeartbeatAt)) {
                    merged.heartbeatAt = liveHeartbeatAt;
                }
            }
            if (live.state) merged.state = live.state as RunState;
            if (
                (live.state === 'active' || live.state === 'cancelling') &&
                live.startedAt &&
                !Number.isNaN(Date.parse(live.startedAt))
            ) {
                merged.executionStartedAt = live.startedAt;
                merged.admissionObservation = 'active';
            }

            // The pending hash is written before BullMQ publication, so it
            // cannot establish waiting by itself. Probe only this run's
            // calculated job ID on its registered queue; missing/old-style
            // jobs remain uncertain rather than becoming "queued" by guess.
            if (merged.state === 'pending' && !merged.admissionObservation) {
                const task = this.registry.getTask(merged.taskId);
                const queue = task ? this.resolveTaskQueue(task.id) : undefined;
                if (task && queue) {
                    try {
                        const identity = computeIdentity(
                            task as TaskDefinition<unknown, unknown>,
                            merged.input,
                        );
                        const jobId = taskJobId(`${identity}#${merged.id}`, this.authority);
                        const job = await queue.getJob(jobId);
                        if (job?.data?.runId === merged.id) {
                            const queueState = await job.getState();
                            if (
                                job.data.playbackDeferredAt !== undefined &&
                                queueState === 'delayed'
                            )
                                merged.admissionObservation = 'playback-deferred';
                            else if (queueState === 'waiting' || queueState === 'prioritized')
                                merged.admissionObservation = 'waiting';
                        }
                    } catch (err) {
                        log.debug('run queue observation unavailable', {
                            runId: merged.id,
                            err: errMessage(err),
                        });
                    }
                }
            }

            // Merge per-stage progress from Valkey hash fields
            // (stage:<id>:processed, stage:<id>:total, stage:<id>:currentItem).
            const stageIds = new Set<string>();
            for (const key of Object.keys(live)) {
                const m = /^stage:(.+):(processed|total|currentItem)$/.exec(key);
                if (m) stageIds.add(m[1]);
            }
            if (stageIds.size === 0) return merged;
            const stagesByid = new Map<string, Run['stages'][number]>();
            // Clone each stage object — they were direct references into
            // base.stages and would otherwise be mutated below.
            for (const s of base.stages) stagesByid.set(s.id, { ...s });
            for (const stageId of stageIds) {
                const processedStr = live[`stage:${stageId}:processed`];
                const totalStr = live[`stage:${stageId}:total`];
                const currentItem = live[`stage:${stageId}:currentItem`];
                const processed = processedStr ? Number(processedStr) : undefined;
                const total = totalStr ? Number(totalStr) : undefined;
                const existing = stagesByid.get(stageId);
                if (existing) {
                    if (typeof processed === 'number' && !Number.isNaN(processed)) {
                        existing.processed = processed;
                    }
                    if (typeof total === 'number' && !Number.isNaN(total)) {
                        existing.total = total;
                    }
                    if (currentItem) existing.currentItem = currentItem;
                } else {
                    // Synthesize a stage entry for single-task runs (no
                    // pipeline plan persisted in DB).
                    stagesByid.set(stageId, {
                        id: stageId,
                        label: stageId,
                        state: 'active',
                        processed:
                            typeof processed === 'number' && !Number.isNaN(processed)
                                ? processed
                                : undefined,
                        total:
                            typeof total === 'number' && !Number.isNaN(total) ? total : undefined,
                        currentItem: currentItem || undefined,
                    });
                }
            }
            merged.stages = Array.from(stagesByid.values());
            return merged;
        } catch (err) {
            // Live merge is best-effort. Surface the failure at debug level
            // so partial-success in listRuns isn't completely invisible
            // (review-finding CR-4 / EH-7). We don't bubble it to the
            // caller — the run object is returned with its DB-row values
            // intact, which is the correct degraded mode.
            log.debug('mergeLiveProgress failed', {
                runId: base.id,
                err: errMessage(err),
            });
            return base;
        }
    }

    async listRuns(filter: RunFilter): Promise<{ runs: Run[]; nextCursor?: string }> {
        const sql = this.getSql();
        if (!sql) return { runs: [] };

        const limit = Math.min(filter.limit ?? 50, 200);
        // Keep the cursor timestamp as the raw `started_at::text` string end-to-end
        // — never round-trip it through a JS Date, which truncates the microsecond
        // precision Postgres timestamptz carries and can skip/re-emit a row updated
        // in the same millisecond as the page boundary. See keyset-cursor.builder.
        let cursorTs: string | null = null;
        let cursorId: string | null = null;
        if (filter.cursor) {
            const decoded = decodeKeysetCursor(filter.cursor);
            if (decoded) {
                cursorTs = decoded.ts;
                cursorId = decoded.id;
            }
        }
        // Wire-pin the bind to `text` (OID 25) so postgres.js does not infer
        // timestamptz from the `::timestamptz` cast and re-serialize via
        // `new Date(x).toISOString()` (ms truncation). Null when no cursor.
        const cursorTsParam = cursorTs !== null ? pgTextTimestamp(sql, cursorTs) : null;

        const states = filter.state ?? null;
        const taskId = filter.taskId ?? null;
        const parentRunId = filter.parentRunId ?? null;
        const libraryGroupId = filter.libraryGroupId ?? null;
        const since = filter.since ?? null;

        // Emitted CONDITIONALLY, unlike every predicate below it. A
        // null-guarded `OR` would make `idx_task_history_subject`'s partial
        // predicate unprovable under a generic plan; a bare strict equality
        // structurally implies `scope->>'subjectId' IS NOT NULL`. See
        // run-filter-sql.ts.
        const subjectPredicate = buildSubjectPredicate(filter.subjectId);
        const subjectClause = subjectPredicate
            ? sql`AND scope->>'subjectId' = ${subjectPredicate.value}`
            : sql``;

        const rows = await sql<Record<string, unknown>[]>`
            SELECT id, task_id, parent_run_id, label, state, input, scope, trigger, actor,
                   started_at, execution_started_at, started_at::text AS started_at_cursor,
                   completed_at, heartbeat_at, stages, result, error,
                   cost_breakdown, owner_instance_id
            FROM task_history
            WHERE TRUE
              AND (${states}::text[] IS NULL OR state = ANY(${states}::text[]))
              AND (${taskId}::text IS NULL OR task_id = ${taskId}::text)
              AND (${parentRunId}::text IS NULL OR parent_run_id = ${parentRunId}::text)
              AND (${libraryGroupId}::text IS NULL OR scope->>'libraryGroupId' = ${libraryGroupId}::text)
              ${subjectClause}
              AND (${since}::timestamptz IS NULL OR started_at >= ${since}::timestamptz)
              AND (
                  ${cursorTsParam}::timestamptz IS NULL
                  OR (started_at, id) < (${cursorTsParam}::timestamptz, ${cursorId}::text)
              )
            ORDER BY started_at DESC, id DESC
            LIMIT ${limit + 1}
        `;

        const runs: Run[] = [];
        for (const r of rows.slice(0, limit)) {
            const run = this.rowToRun(r);
            if (run) runs.push(run);
        }

        // Merge live Valkey progress for non-terminal runs. task_history.stages
        // is only written on terminal transitions, so without this the bus seed
        // (state=active) renders zero progress. mergeLiveProgress is
        // best-effort + filters by state internally, so terminal rows are
        // skipped automatically.
        //
        // Concurrency cap: with `limit=200` (the bus-seed default) a naive
        // Promise.all would issue up to 200 simultaneous Valkey HGETALL
        // commands on a single client. Under load the Glide connection pool
        // serialises them anyway, but the in-flight count keeps the Node.js
        // I/O completion queue busy and the dashboard's initial load latency
        // spikes. Run in chunks of MERGE_LIVE_BATCH so each chunk awaits
        // before the next fires — small enough to keep latency bounded,
        // large enough to amortise per-call overhead.
        const MERGE_LIVE_BATCH = 20;
        for (let i = 0; i < runs.length; i += MERGE_LIVE_BATCH) {
            const chunk = runs.slice(i, i + MERGE_LIVE_BATCH);
            // mergeLiveProgress returns the same Run for terminal states
            // and a new object for non-terminal — capture by index so
            // we substitute the merged Run back into the array in place.
            const indices: number[] = [];
            const promises: Promise<Run>[] = [];
            for (let j = 0; j < chunk.length; j++) {
                const run = chunk[j];
                if (
                    run.state === 'pending' ||
                    run.state === 'active' ||
                    run.state === 'cancelling'
                ) {
                    indices.push(i + j);
                    promises.push(this.mergeLiveProgress(run));
                }
            }
            if (promises.length === 0) continue;
            const merged = await Promise.all(promises);
            for (let k = 0; k < indices.length; k++) {
                runs[indices[k]] = merged[k];
            }
        }

        let nextCursor: string | undefined;
        if (rows.length > limit) {
            const last = rows[limit - 1];
            // Encode from the lossless `started_at::text` projection — NOT
            // `toIsoString(last.started_at)`, which truncates to ms.
            nextCursor = encodeKeysetCursor({
                ts: String(last.started_at_cursor),
                id: String(last.id),
            });
        }
        return { runs, nextCursor };
    }

    async recoverInterruptedWorkerRuns(assertLeaseHeld: () => void): Promise<void> {
        const sql = this.getSql();
        if (!sql) throw new Error('Database unavailable during worker startup recovery');
        const { requeueInterruptedWorkerRuns } = await import('./worker-recovery.js');
        // Materialise lazy per-task queues too: a queue from the old boot may
        // never have been used by this orchestrator yet.
        const queues = new Set(
            this.registry
                .getAllTasks()
                .map((task) => this.resolveTaskQueue(task.id))
                .filter((queue): queue is Queue => queue !== undefined),
        );
        const runIds = await requeueInterruptedWorkerRuns(
            sql,
            queues,
            assertLeaseHeld,
            this.authority,
        );
        assertLeaseHeld();
        // The periodic reconciler repairs counters and other orphans. Do not
        // await the unbounded full boot sweep here: it scans every history/stage
        // row and can delay startup (and singleton-lease loss shutdown).
        log.info('Worker startup recovered interrupted queue jobs', { runIds });
    }

    /**
     * Boot reconciliation — delegates to BootRecovery so there's a single
     * source of truth for three-signal classification. Returns
     * { reclaimed, total, runIds } shape preserved for callers that depend on it.
     */
    async recoverOnBoot(): Promise<RecoveryReport> {
        const sql = this.getSql();
        if (!sql) return { reclaimed: 0, total: 0, runIds: [] };

        const recovery = new BootRecovery(
            sql,
            this.stateMachine,
            async () => this.getClient(),
            (taskId: string) => this.resolveTaskQueue(taskId),
            // Pass the orchestrator's own registry + flag so a test-injected
            // registry is honoured and the budget-counter reset matches this
            // instance's mode (rather than silently falling back to the module
            // singleton / config flag).
            this.registry,
            this.perTaskQueues,
            // #01 Phase 0: reclaimed runs emit the same terminal CloudEvent +
            // webhook as a normal transition (closes the dashboard-divergence
            // gap). Bound so `this.webhookOutbox`/registry resolve correctly.
            (taskId, runId, to, extra) => this.emitTerminalCloudEvent(taskId, runId, to, extra),
            // F42: durability — a transient Postgres error on the reclaim UPDATE
            // is enqueued to the drain instead of being lost until the next sweep.
            this.pendingWriteDrain ?? undefined,
            // Resume-after-restart for interrupted manual runs.
            (req) => this.resumeInterruptedRun(req),
            this.authority,
        );
        const report = await recovery.run();

        if (this.isAnyLeader()) {
            try {
                await detectVersionBumps(sql, this.registry);
            } catch (err) {
                log.error('detectVersionBumps failed at boot', err as Error);
                // do not block other boot tasks
            }
        }

        return {
            reclaimed: report.reclaimed,
            total: report.inspected,
            runIds: report.runIds,
        };
    }

    /** Observe retained terminal lookup/persistence work without stopping its retry loop. */
    isUpgradeQuiescent(): boolean {
        if (this.stopped) return false;
        // Preparation keeps the owner alive; retry retained failed lookups with
        // bounded cadence instead of requiring an unsafe TERM to drive retries.
        for (const runtime of this.classes.values())
            for (const observation of runtime.terminalObservations) {
                if (!observation.pending && performance.now() >= (observation.retryAt ?? 0))
                    this.runTerminalObservation(runtime, observation);
            }
        return [...this.classes.values()].every(
            (runtime) => runtime.terminalObservations.size === 0 && runtime.batcher.isQuiescent(),
        );
    }

    /** Resource cleanup evidence only; this does not qualify runtime handover. */
    isShutdownCleanupComplete(): boolean {
        return (
            this.stopped &&
            this.leadershipAcquisitions.size === 0 &&
            this.classes.size === 0 &&
            this.coordinatorLeader === null &&
            this.flowProducer === null &&
            this.taskQueueRegistry === null
        );
    }

    stop(options: { strict?: boolean } = {}): Promise<void> {
        this.strictStopRequested ||= options.strict ?? false;
        this.stopPending ??= this.stopResources().finally(() => {
            this.stopPending = undefined;
        });
        return this.stopPending;
    }

    private async stopResources(): Promise<void> {
        const failures: unknown[] = [];
        this.queueEventsCloseTimeoutMs = QUEUE_EVENTS_CLOSE_TIMEOUT_MS;
        this.queueEventsCloseTimeoutLogged = false;
        this.subscriptionLostGates.clear();
        this.stopped = true;
        if (this.queueDepthTimer) {
            clearInterval(this.queueDepthTimer);
            this.queueDepthTimer = null;
        }
        if (this.leadershipReconcileTimer) {
            clearInterval(this.leadershipReconcileTimer);
            this.leadershipReconcileTimer = null;
        }
        // Each loop stops scheduling ticks at once; the returned promise settles
        // when its in-flight tick has finished (bounded by LOOP_STOP_TIMEOUT_MS).
        const loops = [
            ['reconciler', this.reconciler?.stop()],
            ['pending-write-drain', this.pendingWriteDrain?.stop()],
            ['webhook-outbox', this.webhookOutbox?.stop()],
            ['push-outbox', this.pushOutbox?.stop()],
        ] as const;
        this.eventDispatcher?.stop();
        this.mediaAddedNotifier?.stop();
        if (this.coordinatorReacquireTimer) {
            clearTimeout(this.coordinatorReacquireTimer);
            this.coordinatorReacquireTimer = null;
        }
        // Invalidate every class lock before yielding. Late acquisition/renew
        // replies must not re-arm leadership while we wait for issued requests.
        for (const rt of this.classes.values()) {
            rt.leader.stop();
            if (rt.reacquireTimer) {
                clearTimeout(rt.reacquireTimer);
                rt.reacquireTimer = null;
            }
        }
        // The coordinator lock is the last thing released (end of this method):
        // it keeps renewing until every loop's in-flight tick has finished, so a
        // successor cannot acquire it and start a sweep, drain or delivery pass
        // that overlaps ours. `stopped` is already set, so a late coordinator
        // acquisition or loss cannot restart the gated services meanwhile.
        let loopStillRunning = false;
        for (const [loop, stopping] of loops) {
            if (stopping && !(await stopping)) {
                loopStillRunning = true;
                failures.push(new Error(`UNKNOWN: ${loop} tick still running after stop timeout`));
            }
        }
        await Promise.allSettled(this.leadershipAcquisitions);
        for (const [key, rt] of this.classes) {
            const priorFailures = failures.length;
            // Cancel any pending leader re-acquire so we don't schedule new
            // work after stop().
            if (rt.reacquireTimer) {
                clearTimeout(rt.reacquireTimer);
                rt.reacquireTimer = null;
            }
            // Close QueueEvents BEFORE stopping the batcher so no new
            // transitions land while we're draining. TransitionBatcher.stop()
            // performs a final flush, so any in-flight items still get
            // delivered.
            const release = async (
                resource: object,
                label: string,
                close: () => Promise<void>,
            ): Promise<void> => {
                if (this.releasedAtShutdown.has(resource)) return;
                try {
                    await close();
                    this.releasedAtShutdown.add(resource);
                } catch (err) {
                    failures.push(err);
                    log.warn(label, { cls: rt.cls, err: errMessage(err) });
                }
            };
            const queueEvents = rt.queueEvents;
            if (queueEvents)
                await release(queueEvents, 'QueueEvents close failed', () =>
                    this.closeQueueEventsAtShutdown(rt, queueEvents),
                );
            // Concurrently: with Valkey down each close waits out its timeout.
            await Promise.all(
                rt.perTaskQueueEvents.map((qe) =>
                    release(qe, 'Per-task QueueEvents close failed', () =>
                        this.closeQueueEventsAtShutdown(rt, qe),
                    ),
                ),
            );
            // Already-admitted callbacks may still be resolving a BullMQ job.
            // Keep their queue and batcher usable until those observations land.
            for (const observation of [...rt.terminalObservations]) {
                await observation.pending;
                for (
                    let attempt = 0;
                    rt.terminalObservations.has(observation) && attempt < 2;
                    attempt++
                ) {
                    this.runTerminalObservation(rt, observation);
                    await observation.pending;
                }
            }
            if (rt.terminalObservations.size > 0) {
                failures.push(
                    new Error('UNKNOWN: terminal callbacks remain unresolved', {
                        cause: [...rt.terminalObservations][0]?.error,
                    }),
                );
            } else {
                await release(rt.batcher, 'Batcher stop failed', () =>
                    rt.batcher.stop({ strict: true }),
                );
            }
            await release(rt.leader, 'Leader release failed', () =>
                rt.leader.release({ strict: true }),
            );
            if (this.releasedAtShutdown.has(rt.batcher))
                await release(rt.queue, 'Queue close failed', () => rt.queue.close());
            if (failures.length === priorFailures) {
                this.classes.delete(key);
                for (const resource of [
                    rt.queueEvents,
                    ...rt.perTaskQueueEvents,
                    rt.batcher,
                    rt.leader,
                    rt.queue,
                ])
                    if (resource) this.releasedAtShutdown.delete(resource);
            }
        }
        if (this.flowProducer) {
            try {
                await this.flowProducer.close();
                this.flowProducer = null;
            } catch (err) {
                failures.push(err);
                log.warn('FlowProducer close failed', { err: errMessage(err) });
            }
        }
        const queuesNeeded = [...this.classes.values()].some(
            (rt) => rt.terminalObservations.size > 0 || rt.batcher.pendingCount() > 0,
        );
        if (this.taskQueueRegistry && !queuesNeeded) {
            try {
                // Nested ownership must retain failures even if a tolerant caller
                // started this close before a strict caller joined it.
                await this.taskQueueRegistry.closeAll({ strict: true });
                this.taskQueueRegistry = null;
            } catch (err) {
                failures.push(err);
                log.warn('TaskQueueRegistry close failed', {
                    err: errMessage(err),
                });
            }
        }
        this.coordinatorLeader?.stop();
        await Promise.allSettled(this.leadershipAcquisitions);
        if (this.coordinatorLeader && loopStillRunning) {
            // A tick outlived its stop timeout. Releasing now would let a successor
            // start an overlapping sweep/drain/delivery pass; leave the key to expire
            // by its TTL instead (renewal has stopped above).
            log.warn('Coordinator lock left to expire: a loop tick is still running');
        } else if (this.coordinatorLeader) {
            try {
                await this.coordinatorLeader.release({ strict: true });
                this.coordinatorLeader = null;
            } catch (err) {
                failures.push(err);
                // Retain uncertain ownership for a later strict cleanup retry.
                log.warn('Coordinator lock release failed', {
                    err: errMessage(err),
                });
            }
        }
        if (this.strictStopRequested && failures.length) {
            throw new AggregateError(failures, 'TaskOrchestrator shutdown is incomplete');
        }
    }

    /**
     * BullMQ's QueueEvents.close() never settles while Valkey is down (see
     * queue-outage.ts); a worker restarted together with Valkey sat on it until
     * its shutdown deadline. Bound the wait: a QueueEvents is a read-only stream
     * subscription, so a forced close leaves nothing for a successor to collide with.
     */
    private async closeQueueEventsAtShutdown(rt: ClassRuntime, qe: QueueEvents): Promise<void> {
        const settled = await closeQueueEventsBounded(qe, this.queueEventsCloseTimeoutMs);
        if (!settled) {
            // Valkey is unreachable: the remaining closes would wait just as long.
            this.queueEventsCloseTimeoutMs = QUEUE_EVENTS_CLOSE_RETRY_TIMEOUT_MS;
            if (!this.queueEventsCloseTimeoutLogged) {
                this.queueEventsCloseTimeoutLogged = true;
                log.warn(
                    'QueueEvents close timed out (Valkey unreachable); connections abandoned',
                    {
                        cls: rt.cls,
                    },
                );
            }
        }
    }

    // -- helpers -------------------------------------------------------------

    private async emitMeta(type: string, data: unknown): Promise<void> {
        await emitMetaEvent(type, data);
    }

    private rowToRun(row: Record<string, unknown>): Run | null {
        const r = row;
        try {
            const startedAt = toIsoString(r.started_at);
            const trigger = (asObject(r.trigger) ?? {
                kind: 'in-process',
            }) as Run['trigger'];
            const actor = (asObject(r.actor) ?? {
                type: 'system',
            }) as Run['actor'];
            const stages = Array.isArray(r.stages) ? (r.stages as Run['stages']) : [];
            const scope = asObject(r.scope) as Run['scope'] | undefined;
            const err = asObject(r.error) as Run['error'] | undefined;
            const result: Run = {
                id: String(r.id),
                taskId: String(r.task_id),
                parentRunId: r.parent_run_id ? String(r.parent_run_id) : undefined,
                label: String(r.label),
                state: String(r.state) as RunState,
                input: r.input,
                scope,
                trigger,
                startedAt,
                executionStartedAt: r.execution_started_at
                    ? toIsoString(r.execution_started_at)
                    : undefined,
                completedAt: r.completed_at ? toIsoString(r.completed_at) : undefined,
                heartbeatAt: normalizeSqlHeartbeatAt(r.heartbeat_at),
                stages,
                result: r.result,
                error: err,
                costBreakdown: (r.cost_breakdown as Run['costBreakdown']) ?? undefined,
                ownerInstanceId: r.owner_instance_id ? String(r.owner_instance_id) : undefined,
                actor,
            };
            return result;
        } catch (e) {
            log.warn('rowToRun parse failed', { err: errMessage(e) });
            return null;
        }
    }
}

// ── Module-level singleton + facade per plan §12.5 ────────────────────────────

let _orchestrator: TaskOrchestrator | null = null;

// The IN-FLIGHT start, memoized separately from the resolved instance above.
// `_orchestrator` is only assigned after `TaskOrchestrator.start()` resolves, so
// callers arriving during a start all saw `null` and each ran a full second
// start — duplicate BullMQ connections, duplicate leader-election timers, and a
// `_orchestrator` that ends up pointing at whichever finished last while the
// others keep running unreferenced.
//
// It stayed latent while the only caller was boot (one call) plus `startRun`
// (after boot resolved). The readiness probe makes it reachable: it polls every
// 15s and abandons its await after 2s WITHOUT cancelling the start underneath,
// so on a node whose boot start is slow or was skipped, probe N+1 arrives with
// the start still running and `_orchestrator` still null.
let _orchestratorStarting: Promise<TaskOrchestrator> | null = null;

// Set by the facade's stop() and never cleared: once this process has torn the
// orchestrator down it is exiting, and nothing may build a new one. Without it
// the readiness probe — which polls every 15s, anonymously, for the whole
// termination grace period — calls getOrchestrator() after shutdown and starts a
// fresh orchestrator (BullMQ queues, Valkey coordination client, leader-election
// timers) that no shutdown path will ever stop.
let _orchestratorStopped = false;

export async function getOrchestrator(): Promise<TaskOrchestrator> {
    if (_orchestratorStopped) {
        throw new Error('TaskOrchestrator has been shut down — refusing to start a new one');
    }
    if (_orchestrator) return _orchestrator;
    if (_orchestratorStarting) return _orchestratorStarting;

    _orchestratorStarting = startOrchestrator().finally(() => {
        // Cleared on failure too, so a start that failed (Valkey not up yet) is
        // retried by the next caller rather than handing every future caller the
        // same rejected promise.
        _orchestratorStarting = null;
    });

    return _orchestratorStarting;
}

async function startOrchestrator(): Promise<TaskOrchestrator> {
    // Populate the registry with builtin tasks BEFORE starting the runner
    // subscribes to queue events. The autoloader is idempotent — repeated
    // calls no-op via an internal flag. Errors here are non-fatal: a
    // failing builtin shouldn't prevent orchestrator startup, only its
    // own jobs from running.
    try {
        const { loadBuiltins } = await import('./builtin/index.js');
        await loadBuiltins();
    } catch (err) {
        log.warn('builtin loader failed; continuing without builtins', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Boot trigger audit — catches the structural bug class where a task is
    // registered but nothing fires it. Loud-fails in dev so a developer who
    // forgets to declare manualOnly / dynamicSchedule / pipeline.of sees the
    // issue immediately; logs at error in prod with TASK_TRIGGER_INCONSISTENCY
    // so operators can grep / alert.
    auditTriggerCoverage();

    // RESOURCE_CLASSES is the canonical list. Hardcoding a parallel
    // copy here proved fragile — drift between this list, runner.ts's
    // startTaskRunner default, and hooks.server.ts's worker-boot call
    // surfaced as silent queue-with-no-consumer bugs on two separate
    // resource-class additions (ingest/bulk in 4b224751d, analysis in
    // eb82dbdcf). Use the source of truth.
    _orchestrator = await TaskOrchestrator.start([...RESOURCE_CLASSES]);
    void warnIfValkeyEvictsAuthoritativeState();
    return _orchestrator;
}

/**
 * One-time boot warning. The task system stores authoritative run/stage state
 * in Valkey keys that carry TTLs (run hashes, budget + active-count counters,
 * identity dedup keys). Under ANY eviction policy (`allkeys-*` or `volatile-*`)
 * those keys can be dropped under memory pressure regardless of TTL — silently
 * corrupting the transitionRun CAS, letting concurrency caps be exceeded, and
 * re-opening duplicate execution. Operators should run the task keyspace with
 * `noeviction`. We only WARN (never fail boot) — managed providers may restrict
 * CONFIG, and a cache-only dev setup should still start.
 */
async function warnIfValkeyEvictsAuthoritativeState(): Promise<void> {
    try {
        const client = getCoordinationClient();
        if (!client) return;
        const raw = await client.customCommand(['CONFIG', 'GET', 'maxmemory-policy']);
        // GLIDE answers a GlideRecord ([{ key, value }]), not RESP2 flat pairs;
        // `raw[1]` was always undefined, so this warning never fired.
        const { configValue } = await import('../cache/task-valkey-guard.js');
        const policy = configValue(raw, 'maxmemory-policy') ?? '';
        if (policy && policy !== 'noeviction') {
            log.warn(
                `Valkey maxmemory-policy is '${policy}' — task/run state keys carry TTLs ` +
                    `and CAN be evicted under memory pressure, silently corrupting run state, ` +
                    `concurrency counters, and dedup. Use 'noeviction' for the task keyspace.`,
                { TAG: 'VALKEY_EVICTION_RISK', policy },
            );
        }
    } catch {
        // Best-effort — never block boot on a CONFIG GET failure.
    }
}

/**
 * Boot-time AND hot-load check: every registered task must have a declared
 * trigger source. See `TaskRegistry.classifyTriggers()` for the rules.
 *
 * Policy mirrors `handle-trigger-failure.ts`: dev/test throws so test runs
 * blow up loudly; prod logs at error level with the TASK_TRIGGER_INCONSISTENCY
 * tag so operators can alert on it.
 *
 * Exported so `reloadExternalPlugins()` can re-audit after hot-load: a
 * dropped-in plugin without a declared trigger would otherwise ship silently
 * and only be noticed when a downstream feature mysteriously stops working.
 */
export function auditTriggerCoverage(): void {
    const coverage = defaultRegistry.classifyTriggers();
    const orphans: string[] = [];
    for (const [taskId, cov] of coverage) {
        if (cov.kind === 'unknown') orphans.push(taskId);
    }
    if (orphans.length === 0) return;

    const remedy =
        'Declare one of: `schedule: { every: ... }`, `dynamicSchedule: { loader }`, ' +
        '`pipeline: { of: ... }`, `coversStages: [{ enqueueable: true }]` (stage-sweep), ' +
        '`demo: true`, or `manualOnly: true`.';
    const summary = `${orphans.length} task(s) have no trigger source: ${orphans.join(', ')}. ${remedy}`;

    if (!dev) {
        log.error(
            'TASK_TRIGGER_INCONSISTENCY: tasks registered without a trigger source',
            undefined,
            {
                TAG: 'TASK_TRIGGER_INCONSISTENCY',
                orphans,
                count: orphans.length,
            },
        );
        // Prod: do not throw. A misconfigured task firing nothing is a
        // silent-data bug, not a crash-loop trigger. Surfacing it as an
        // alertable log is the right escalation path.
    } else {
        throw new Error(`TASK_TRIGGER_INCONSISTENCY: ${summary}`);
    }
}

export const orchestrator = {
    async startRun(taskId: string, input: unknown, opts?: StartRunOpts): Promise<StartRunResult> {
        return (await getOrchestrator()).startRun(taskId, input, opts);
    },
    async isRunQueued(taskId: string, input: unknown, runId: string): Promise<boolean> {
        return (await getOrchestrator()).isRunQueued(taskId, input, runId);
    },
    async cancelRun(
        runId: string,
        opts?: { hard?: boolean; reason?: string },
    ): Promise<CancelRunResult> {
        return (await getOrchestrator()).cancelRun(runId, opts);
    },
    async nuclearStop(
        taskId: string,
        opts?: { force?: boolean; reason?: string },
    ): Promise<NuclearStopResult> {
        return (await getOrchestrator()).nuclearStop(taskId, opts);
    },
    async getRun(runId: string): Promise<Run | null> {
        return (await getOrchestrator()).getRun(runId);
    },
    async listRuns(filter: RunFilter): Promise<{ runs: Run[]; nextCursor?: string }> {
        return (await getOrchestrator()).listRuns(filter);
    },
    async recoverOnBoot(): Promise<RecoveryReport> {
        return (await getOrchestrator()).recoverOnBoot();
    },
    async getQueueDepths(): Promise<
        Record<
            ResourceClass,
            {
                waiting: number;
                active: number;
                delayed: number;
                paused: boolean;
            }
        >
    > {
        return (await getOrchestrator()).getQueueDepths();
    },
    async getPerTaskQueueDepths(): Promise<
        Array<{
            taskId: string;
            resourceClass: ResourceClass;
            declaredResourceClass?: ResourceClass;
            waiting: number;
            active: number;
            delayed: number;
        }>
    > {
        return (await getOrchestrator()).getPerTaskQueueDepths();
    },
    async getStalledCounts(): Promise<Record<ResourceClass, number>> {
        return (await getOrchestrator()).getStalledCounts();
    },
    getConcurrencyCaps(): Record<ResourceClass, number> {
        // No await — caps come from the same helper the runner uses to
        // configure each Worker (defaultConcurrencyFor in runner.ts).
        // Iterates RESOURCE_CLASSES so adding a new class in the SDK
        // automatically appears here without a second source-of-truth.
        const out = {} as Record<ResourceClass, number>;
        for (const cls of RESOURCE_CLASSES) {
            out[cls] = defaultConcurrencyFor(cls);
        }
        return out;
    },
    async stop(options: { strict?: boolean } = {}): Promise<void> {
        _orchestratorStopped = true;
        // Wait out a start that is still in flight before deciding there is
        // nothing to stop. Without this the early return below fires (there is no
        // resolved instance yet), the start then completes and installs a live
        // orchestrator AFTER teardown, and nothing is left to shut it down.
        if (_orchestratorStarting) {
            await _orchestratorStarting.catch(() => undefined);
        }
        if (!_orchestrator) return;
        const o = _orchestrator;
        await o.stop(options);
        if (_orchestrator === o && o.isShutdownCleanupComplete()) _orchestrator = null;
    },
};

// ── Utility functions ────────────────────────────────────────────────────────

function safeShort(value: unknown): string {
    try {
        const s = typeof value === 'string' ? value : JSON.stringify(value);
        return s.length > 1024 ? `${s.slice(0, 1024)}…` : s;
    } catch {
        // best-effort: unserializable value → sentinel string for the truncated preview.
        return '<unserializable>';
    }
}

/** BullMQ hands `returnvalue` over as a JSON string or the object itself. */
function isRefusedRedelivery(returnvalue: unknown): boolean {
    if (typeof returnvalue === 'string') {
        try {
            return (
                (JSON.parse(returnvalue) as { redeliveryRefused?: unknown })?.redeliveryRefused ===
                true
            );
        } catch {
            return false;
        }
    }
    return (
        typeof returnvalue === 'object' &&
        returnvalue !== null &&
        (returnvalue as { redeliveryRefused?: unknown }).redeliveryRefused === true
    );
}

function priorityFromTrigger(kind: TriggerKind): number {
    // Manual = an admin clicked "run now". Boost it into the express band so it
    // jumps ahead of scheduled/background work AND qualifies for the reserved
    // budget slot in runner.acquireClassBudget (see EXPRESS_PRIORITY_MAX). Only
    // a task's explicit `taskPriority` (resolution chain in startRun) can keep a
    // manual run below express. webhook/in-process stay at the default — they're
    // system-driven, not a human waiting on the result.
    if (kind === 'manual') return EXPRESS_PRIORITY_MAX;
    if (kind === 'webhook' || kind === 'in-process') return 5;
    if (kind === 'pipeline-child' || kind === 'resume') return 7;
    return 5;
}

function inferActor(trigger: { kind: TriggerKind; by?: string }): Record<string, string> {
    if (trigger.kind === 'scheduled') return { type: 'system', via: 'cron' };
    if (trigger.kind === 'webhook') return { type: 'webhook', via: 'webhook' };
    if (trigger.kind === 'manual' && trigger.by) {
        return { type: 'user', id: trigger.by, via: 'ui' };
    }
    if (trigger.kind === 'pipeline-child') return { type: 'system', via: 'in-process' };
    if (trigger.kind === 'resume') return { type: 'system', via: 'in-process' };
    return { type: 'service', via: 'in-process' };
}

export function parseHGetAll(raw: unknown): Record<string, string> {
    if (!raw) return {};
    if (Array.isArray(raw)) {
        const out: Record<string, string> = {};
        // Either flat [k, v, k, v, …] (from EVAL/customCommand HGETALL)
        // or [{ key, value }, …] / [{ field, value }, …] from Glide versions.
        if (
            raw.length > 0 &&
            typeof raw[0] === 'object' &&
            raw[0] !== null &&
            ('field' in (raw[0] as object) || 'key' in (raw[0] as object))
        ) {
            for (const entry of raw as Array<{
                field?: unknown;
                key?: unknown;
                value: unknown;
            }>) {
                const key = entry.field ?? entry.key;
                if (key !== undefined) out[String(key)] = String(entry.value ?? '');
            }
            return out;
        }
        for (let i = 0; i + 1 < raw.length; i += 2) {
            out[String(raw[i])] = String(raw[i + 1] ?? '');
        }
        return out;
    }
    // @valkey/valkey-glide v2 `customCommand(['HGETALL', …])` decodes the RESP
    // map into a JS Map (ReturnTypeMap), NOT a plain object or array. Without
    // this branch Object.entries(map) is [] and live run progress is silently
    // dropped — task cards then never render progress bars (the symptom that
    // sent us here). String() coerces Buffer values (bytes decoder) to utf-8.
    if (raw instanceof Map) {
        const out: Record<string, string> = {};
        for (const [k, v] of raw.entries()) {
            out[String(k)] = String(v ?? '');
        }
        return out;
    }
    if (typeof raw === 'object') {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            out[k] = String(v ?? '');
        }
        return out;
    }
    return {};
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return undefined;
}

/** Optional SQL heartbeat: normalize Date/timestamptz text and omit invalid evidence. */
function normalizeSqlHeartbeatAt(value: unknown): string | undefined {
    const time =
        value instanceof Date
            ? value.getTime()
            : typeof value === 'string'
              ? Date.parse(value)
              : NaN;
    return toStrictUtcTimestamp(time);
}

function toIsoString(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
        return value;
    }
    return new Date().toISOString();
}

/**
 * Converts the live runner heartbeat formats into the strict Run wire format.
 * The runner stores epoch milliseconds; older hashes may contain ISO values.
 * Invalid observations are ignored so the SQL heartbeat remains authoritative.
 */
function normalizeLiveHeartbeatAt(value: string | undefined): string | undefined {
    if (!value) return undefined;

    if (/^-?\d+$/.test(value)) {
        const epochMs = Number(value);
        if (!Number.isSafeInteger(epochMs)) return undefined;
        return toStrictUtcTimestamp(epochMs);
    }

    const iso =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
            value,
        );
    if (!iso) return undefined;

    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const hour = Number(iso[4]);
    const minute = Number(iso[5]);
    const second = Number(iso[6]);
    const offsetHour = iso[9] ? Number(iso[9]) : 0;
    const offsetMinute = iso[10] ? Number(iso[10]) : 0;
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > daysInMonth[month - 1] ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        offsetHour > 23 ||
        offsetMinute > 59
    ) {
        return undefined;
    }

    const epochMs = Date.parse(value);
    if (!Number.isFinite(epochMs)) return undefined;
    return toStrictUtcTimestamp(epochMs);
}

function toStrictUtcTimestamp(epochMs: number): string | undefined {
    const date = new Date(epochMs);
    if (!Number.isFinite(date.getTime())) return undefined;
    const iso = date.toISOString();
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso) ? iso : undefined;
}

/**
 * Recursively patch the trigger FlowJob (the one whose `name === taskId`):
 *  - reconcile its builder-assigned runId with the one the orchestrator already
 *    wrote to Postgres before calling enqueuePipeline, and
 *  - thread the exclusiveWith mutex key (when the task claimed one) into its
 *    data so the runner DELs it on the trigger task's terminal — the same
 *    release contract as the non-pipeline path. The builder constructs fresh
 *    FlowJob `data` objects and never sees the caller's jobData, so without this
 *    a pipeline trigger would never release its mutex and the key would linger
 *    for the full crash-safety ttl (default 24h).
 */
function patchFlowJobData(
    jobs: FlowJob[],
    taskId: string,
    runId: string,
    exclusivityKey: string | undefined,
): boolean {
    for (const job of jobs) {
        if (job.name === taskId) {
            const data = job.data as Record<string, unknown>;
            data.runId = runId;
            if (exclusivityKey) data.exclusivityKey = exclusivityKey;
            return true;
        }
        if (job.children && patchFlowJobData(job.children, taskId, runId, exclusivityKey)) {
            return true;
        }
    }
    return false;
}
