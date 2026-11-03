// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Dedicated task-process startup. The web producer has its own lifecycle.
// Keep lazy imports: registry -> Valkey -> heartbeat -> recovery -> consumers.
import { shouldStartWorkers } from '$lib/server/config.js';
import { assertValkeyEndpointConfiguration } from '$lib/server/config/valkey-endpoints.js';
import { loadTaskRegistry } from './registration.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { Scheduler } from '$lib/server/tasks/scheduler.js';

const startupLogger = Logger.for('TaskRuntime');
let taskScheduler: Scheduler | null = null;
let watcherEnsureTimer: ReturnType<typeof setInterval> | undefined;
let watcherEnsurePending: Promise<void> | undefined;
let denyEnsurePending: Promise<void> | undefined;
const denySubscribersReady = new Set<'decode' | 'trickplay'>();
let startup: Promise<void> | undefined;
let shutdown: Promise<void> | undefined;
let shutdownStrict: boolean | undefined;
let workerLeaseRequested = false;
/** Set once the singleton lease is lost; nothing may start consuming afterwards. */
let workerLeaseLost: string | undefined;
/** Synchronous claim stop for the started runner (fencing loss path). */
let haltTaskRunnerClaims: (() => void) | undefined;

function assertWorkerLeaseHeld(): void {
    if (workerLeaseLost !== undefined)
        throw new Error(`Worker singleton lease lost (${workerLeaseLost}); not starting consumers`);
}

/** Best effort cache buses; retry missing subscriptions on the existing watcher tick. */
function ensureDenySubscribers(signal?: AbortSignal): Promise<void> {
    const active = (): boolean =>
        !!process.env.TASK_CACHE_URL && shutdownStrict === undefined && !signal?.aborted;
    if (!active()) return Promise.resolve();
    denyEnsurePending ??= (async () => {
        const subscribers = [
            [
                'decode',
                async () =>
                    (await import('$lib/server/cache/decode-deny-bus')).startDecodeDenySubscriber,
            ],
            [
                'trickplay',
                async () =>
                    (await import('$lib/server/cache/trickplay-hwaccel-deny-bus'))
                        .startTrickplayHwaccelDenySubscriber,
            ],
        ] as const;
        for (const [name, load] of subscribers) {
            if (!active()) return;
            if (denySubscribersReady.has(name)) continue;
            try {
                const start = await load();
                if (!active()) return;
                if (await start()) denySubscribersReady.add(name);
            } catch (err) {
                startupLogger.debug('Cache deny subscription failed; retrying on watcher tick', {
                    name,
                    error: String(err),
                });
            }
        }
    })().finally(() => {
        denyEnsurePending = undefined;
    });
    return denyEnsurePending;
}

function ensureDenySubscribersInBackground(signal?: AbortSignal): void {
    void ensureDenySubscribers(signal).catch((err: unknown) =>
        startupLogger.debug('Cache deny subscription ensure failed', { error: String(err) }),
    );
}

export interface TaskSubsystemStartOptions {
    strict?: boolean;
    signal?: AbortSignal;
    /**
     * Called once if this worker loses the singleton lease while running (a
     * peer took it over after it expired, or renewals failed past the safety
     * margin). The process entry point passes its strict shutdown, which exits
     * non-zero so the supervisor restarts the worker and it contends again.
     * Without a handler the subsystem stops its consumers itself (readiness
     * drops with the orchestrator).
     */
    onWorkerLeaseLost?: (reason: string) => void;
}

export function startTaskSubsystem(options: TaskSubsystemStartOptions = {}): Promise<void> {
    if (shutdownStrict !== undefined)
        return Promise.reject(new Error('Task subsystem is stopping'));
    startup ??= initialize(options.strict ?? true, options.signal, options.onWorkerLeaseLost);
    return startup;
}

function handleWorkerLeaseLost(reason: string, handler?: (reason: string) => void): void {
    if (shutdownStrict !== undefined) return;
    workerLeaseLost = reason;
    // A successor may already hold the lease: stop claiming and dispatching
    // synchronously, before any awaited teardown (which first waits for
    // startup, the watcher and the scheduler).
    haltTaskRunnerClaims?.();
    taskScheduler?.suspendForUpgrade();
    startupLogger.error('Worker singleton lease lost while running — stopping task consumers', {
        reason,
    });
    if (handler) {
        handler(reason);
        return;
    }
    void stopTaskSubsystem({ strict: true }).catch((err: unknown) =>
        startupLogger.error(
            'Task subsystem stop after singleton lease loss failed',
            err instanceof Error ? err : new Error(String(err)),
        ),
    );
}

async function initialize(
    strict: boolean,
    signal?: AbortSignal,
    onWorkerLeaseLost?: (reason: string) => void,
): Promise<void> {
    signal?.throwIfAborted();
    if (!shouldStartWorkers())
        throw new Error('Task consumers require the dedicated worker process');
    assertValkeyEndpointConfiguration();
    // Exactly one dedicated worker: hold the durable singleton lease before
    // anything that consumes, watches, schedules or recovers runs. A second
    // worker waits here (unready, retrying) until the holder exits or its
    // lease expires.
    {
        const { acquireWorkerLease } = await import('./worker-lease.js');
        workerLeaseRequested = true;
        await acquireWorkerLease({
            signal,
            onLost: (reason) => handleWorkerLeaseLost(reason, onWorkerLeaseLost),
        });
        signal?.throwIfAborted();
    }
    const sql = await loadTaskRegistry(signal);
    // Managed task authority is disabled; a stray authority row would make
    // every tokenless task write fail with stale_authority. Refuse to start.
    const { assertTaskAuthorityUnmanaged } = await import('./authority/store.js');
    await assertTaskAuthorityUnmanaged(sql);
    const { runFeatureStartups } = await import('$lib/server/plugins/runtime/feature-startup.js');
    const { registry: taskRegistry } = await import('$lib/server/tasks/registry.js');
    const { buildPluginContext } = await import('$lib/server/tasks/plugin-context.js');
    signal?.throwIfAborted();
    await runFeatureStartups(taskRegistry.getAllFeatures(), (id) => buildPluginContext(id), signal);
    signal?.throwIfAborted();

    startupLogger.info('Starting dedicated BullMQ workers');

    // Eagerly connect Valkey before any subsystem that calls
    // getCoordinationClient(). Without this, the TaskOrchestrator boot
    // path throws "Valkey client is not connected" and falls into
    // its lazy-retry mode — but the retry only fires on the first
    // startRun, which (in WORKER_MODE) only fires from the
    // scheduler, which itself requires the orchestrator. Result:
    // orchestrator never starts, no reconciler, no scheduled
    // tasks, wedged active jobs hold budget slots forever.
    // Observed in production 2026-05-26.
    try {
        const { connectValkey } = await import('$lib/server/cache/valkey');
        const ok = await connectValkey();
        if (ok) {
            startupLogger.info('Valkey client connected (pre-orchestrator init)');
            // Subscriptions are best effort and cannot delay watcher readiness.
            ensureDenySubscribersInBackground(signal);
        } else {
            startupLogger.error(
                'connectValkey returned false at boot — TaskOrchestrator will fail to start',
            );
        }
    } catch (err) {
        startupLogger.error(
            'Failed to connect Valkey at boot — TaskOrchestrator will fail to start',
            err instanceof Error ? err : new Error(String(err)),
        );
    }

    // Cross-replica auth-cache invalidation subscriber. Started
    // whether or not Valkey connected above: it retries with
    // backoff until subscribed and re-subscribes after a
    // connection loss. Not awaited — with Valkey down the first
    // attempt can take seconds, and nothing at boot needs it.
    void import('$lib/server/cache/auth-cache-bus')
        .then((m) => m.startAuthCacheInvalidationSubscriber())
        .catch((err: unknown) =>
            startupLogger.error(
                'Failed to start the auth-cache invalidation bus',
                err instanceof Error ? err : new Error(String(err)),
            ),
        );

    // Start the file-scanner watcher. This is worker-tier
    // background work (native watcher → DB writes, holds a Valkey
    // leader lock), so it belongs inside this gate alongside the
    // runner/scheduler — NOT before it. Running it on every
    // replica meant a web replica (WORKER_MODE=disabled, no media
    // volume mounted) could win the leader lock and then watch a
    // path it can't read.
    //
    // It MUST start AFTER connectValkey() above: the leader lock
    // uses acquireLock(), which silently falls back to a
    // PER-PROCESS in-memory lock when Valkey isn't connected. If
    // it ran first, two workers would each win their own
    // in-memory lock and both run the native watcher → duplicate file
    // processing. With Valkey connected, the lock elects exactly
    // one watcher across all workers. Only the registry (loaded
    // above) and a connected Valkey are required here.
    {
        const { fileScannerMediaSource, updateWatcherPaths } =
            await import('$lib/server/tasks/builtin/native/media-sources/file-scanner.js');
        const { buildPluginContext } = await import('$lib/server/tasks/plugin-context.js');
        const { isCoordinationValkeyHealthy } = await import('$lib/server/cache/valkey');
        if (!(await isCoordinationValkeyHealthy())) {
            if (strict) throw new Error('Task watcher requires healthy coordination Valkey');
            startupLogger.warn(
                'File scanner watcher starting WITHOUT coordination Valkey — leadership is per-process only.',
            );
        }
        // Ensure the native watcher is running whenever ≥1 enabled
        // library path exists. startWatching() no-ops once active or
        // while there are still no paths (so it is safe to call
        // repeatedly), and updateWatcherPaths() refreshes the watched
        // set on an already-running watcher. Running this on a timer —
        // not just once at boot — means a library created AFTER boot
        // (the common fresh-install flow: install → add a library) starts
        // the watcher within the interval WITHOUT requiring a restart,
        // and it self-heals if the watcher ever dies.
        const ensureScannerWatcher = (): Promise<void> => {
            signal?.throwIfAborted();
            watcherEnsurePending ??= (async () => {
                const scannerCtx = buildPluginContext('file-scanner');
                await fileScannerMediaSource.startWatching!(scannerCtx);
                await updateWatcherPaths(scannerCtx.sql);
            })().finally(() => {
                watcherEnsurePending = undefined;
            });
            return watcherEnsurePending;
        };
        signal?.throwIfAborted();
        const initialEnsure = ensureScannerWatcher()
            .then(() => startupLogger.info('File scanner watcher ensured'))
            .catch((err: Error) => {
                if (strict) throw err;
                startupLogger.warn('File scanner watcher failed to start', {
                    error: String(err),
                });
            });
        // Readiness requires the initial watcher setup to finish.
        await initialEnsure;
        signal?.throwIfAborted();
        watcherEnsureTimer = setInterval(() => {
            if (signal?.aborted || shutdownStrict !== undefined) return;
            ensureDenySubscribersInBackground(signal);
            void ensureScannerWatcher().catch((err: Error) =>
                startupLogger.debug('File scanner watcher ensure tick failed', {
                    error: String(err),
                }),
            );
        }, 60_000);
        watcherEnsureTimer.unref?.();
    }

    // Start cluster heartbeat BEFORE the new task runner so boot
    // recovery sweeps see a live heartbeat and can correctly
    // classify peer-claimed runs.
    try {
        const { clusterHeartbeatService } =
            await import('$lib/server/services/cluster-heartbeat.service.js');
        signal?.throwIfAborted();
        await clusterHeartbeatService.start(sql);
        startupLogger.info('Cluster heartbeat service started (pre-scheduler init)');
    } catch (err) {
        if (strict) throw err;
        // Escalate to error — heartbeat failure at boot means
        // leader election may misclassify peer-claimed runs.
        // BootRecovery still runs (falls back to PTTL path),
        // but the operator should know the heartbeat service
        // didn't come up on this replica.
        startupLogger.error(
            'CLUSTER_HEARTBEAT_BOOT_FAILED: heartbeat service did not start pre-scheduler — sweep will fall back to PTTL path',
            err instanceof Error ? err : new Error(String(err)),
            { tag: 'CLUSTER_HEARTBEAT_BOOT_FAILED' },
        );
    }

    // Sync the pipeline-event-outbox feature flag into the DB
    // so trigger functions read the same state as application
    // code. Without this, the DB triggers would honor whatever
    // value `feature_flags` held from the previous deploy —
    // potentially out of sync with the new container's env.
    // Failures are non-fatal: the flag stays at its previous
    // DB value and the dispatcher proceeds accordingly.
    try {
        const { getDb } = await import('$lib/server/database/connection');
        const { syncEventOutboxFlag } =
            await import('$lib/server/database/queries/event-outbox.queries');
        const { FEATURE_PIPELINE_EVENT_OUTBOX } = await import('$lib/server/config');
        const sql = getDb();
        if (sql) {
            const result = await syncEventOutboxFlag(sql, FEATURE_PIPELINE_EVENT_OUTBOX);
            if (result.conflict) {
                startupLogger.warn(
                    `Pipeline event outbox flag mismatch — local FEATURE_PIPELINE_EVENT_OUTBOX=${FEATURE_PIPELINE_EVENT_OUTBOX} ` +
                        `but DB feature_flags.event_outbox_enabled=${result.effective ? 'on' : 'off'}. ` +
                        `The sync preserved 'on' to avoid silent disablement during a rolling deploy; ` +
                        `update the DB row manually to fully turn the flag off cluster-wide.`,
                );
            } else {
                startupLogger.info(
                    `Pipeline event outbox flag synced (effective=${result.effective})`,
                );
            }
        }
    } catch (err) {
        startupLogger.warn(
            'Failed to sync pipeline event outbox flag — DB triggers may use stale state',
            err instanceof Error ? err : new Error(String(err)),
        );
    }

    try {
        const { checkSyncInstance } =
            await import('$lib/server/database/queries/sync-changes.queries.js');
        await checkSyncInstance(sql);
    } catch (err) {
        startupLogger.warn(
            'Failed to check library sync instance',
            err instanceof Error ? err : new Error(String(err)),
        );
    }

    // Boot the TaskOrchestrator BEFORE the runner. BootRecovery
    // runs inside getOrchestrator() and classifies any pending /
    // active task_history rows left over from a crashed replica.
    // If the runner came up first it could claim those orphans
    // before recovery marked them failed (TOCTOU on claim-run).
    try {
        const { getOrchestrator } = await import('$lib/server/tasks/orchestrator');
        signal?.throwIfAborted();
        const orchestrator = await getOrchestrator();
        assertWorkerLeaseHeld();
        await orchestrator.recoverInterruptedWorkerRuns(assertWorkerLeaseHeld);
        startupLogger.info('TaskOrchestrator started (leader election + boot recovery)');
    } catch (err) {
        if (strict) throw err;
        startupLogger.error(
            'Failed to eagerly start TaskOrchestrator — will retry lazily on first startRun',
            err instanceof Error ? err : undefined,
        );
    }

    // Start the TaskRunner (consumes task:cpu/io/embedding/maintenance
    // queues populated by orchestrator.startRun). Without this, every run
    // enqueued via the new task system sits `pending` forever.
    //
    // Failures are non-fatal: the orchestrator can still record runs in
    // Postgres and accept startRun calls; jobs just won't be picked up on
    // this replica.
    try {
        const { startTaskRunner } = await import('$lib/server/tasks/runner');
        // Must stay in sync with `getOrchestrator()`'s class
        // list (orchestrator.ts) AND `defaultConcurrencyFor`
        // (runner.ts) — any class registered with the
        // orchestrator but not booted here as a Worker has
        // its queue accumulate jobs that no consumer picks
        // up. Observed on preprod as 146 ingest jobs sitting
        // prioritized with active=0 right after the initial
        // class-split deploy. Re-tripped on the 'analysis'
        // class deploy (eb82dbdcf) — one intro-analyzer job
        // sat in analysis:prioritized for ~minutes before
        // this file got updated.
        //
        // Source-of-truth: SDK RESOURCE_CLASSES. Importing
        // it here would defeat the lazy-import pattern this
        // block relies on for boot ordering, so the
        // duplication is intentional but lint-worthy.
        const { RESOURCE_CLASSES } = await import('@sapd/lumastra-plugin-sdk');
        signal?.throwIfAborted();
        assertWorkerLeaseHeld();
        const runner = await startTaskRunner([...RESOURCE_CLASSES]);
        haltTaskRunnerClaims = () => runner?.haltClaims();
        if (workerLeaseLost !== undefined) runner?.haltClaims();
        startupLogger.info('TaskRunner started');
    } catch (err) {
        if (strict) throw err;
        startupLogger.error(
            'Failed to start TaskRunner — new task queues will have no consumer on this replica',
            err instanceof Error ? err : undefined,
        );
    }

    // Start the Scheduler — fires tasks declared with
    // `schedule: { every: '...' }`. Without this the task
    // catalog is intact but nothing runs on its own; every
    // run would require a manual /api/v1/tasks/<id>/run POST.
    // Multi-replica fairness is enforced via Valkey SETNX on
    // `lock:scheduler:<taskId>:<bucket>`, so it is safe to
    // run on every replica that has DB access — only the
    // worker(s) get it here to avoid wasted ticks on the
    // web tier.
    try {
        const { Scheduler } = await import('$lib/server/tasks/scheduler.js');
        const { registry } = await import('$lib/server/tasks/registry.js');
        const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
        const { getCoordinationClient } = await import('$lib/server/cache/valkey.js');
        signal?.throwIfAborted();
        // Fire claims (`lock:scheduler:*`) live on the task Valkey: on the cache
        // they stopped every schedule during a cache outage and an eviction
        // could let two replicas fire the same bucket.
        const instance = new Scheduler(registry, orchestrator, sql, async () => {
            const c = getCoordinationClient();
            if (!c) {
                throw new Error('Task Valkey client not connected');
            }
            return {
                customCommand: (cmd) => c.customCommand(cmd),
            };
        });
        // catchUpAtBoot is best-effort: a single failing task
        // shouldn't prevent the steady-state tick loop from
        // starting. The loop itself will pick up missed cycles
        // on the next interval anyway.
        try {
            await instance.catchUpAtBoot();
        } catch (catchupErr) {
            startupLogger.warn(
                'Scheduler catchUpAtBoot threw — proceeding to start the tick loop anyway',
                {
                    error: catchupErr instanceof Error ? catchupErr.message : String(catchupErr),
                },
            );
        }
        signal?.throwIfAborted();
        assertWorkerLeaseHeld();
        await instance.start();
        taskScheduler = instance;
        startupLogger.info('TaskScheduler started');
    } catch (err) {
        if (strict) throw err;
        startupLogger.error(
            'Failed to start TaskScheduler — scheduled tasks (every-N) will not fire on this replica',
            err instanceof Error ? err : undefined,
        );
    }

    startupLogger.info('Dedicated task system initialized');
}

let resumeUpgradeScheduler: (() => void) | undefined;

/** Prepare is reversible. It neither stops the owner nor cancels active plugins. */
export async function prepareTaskSubsystemUpgrade(
    deadlineMs: number,
): Promise<{ prepared: boolean }> {
    if (shutdownStrict !== undefined) throw new Error('Task subsystem is stopping');
    const { getTaskRunner } = await import('$lib/server/tasks/runner');
    const { getOrchestrator } = await import('$lib/server/tasks/orchestrator');
    const runner = getTaskRunner();
    if (!runner) throw new Error('Task runner is not running');
    const owner = await getOrchestrator();
    resumeUpgradeScheduler ??= taskScheduler?.suspendForUpgrade();
    try {
        const result = await runner.prepareUpgrade({
            deadlineMs,
            settled: () =>
                (taskScheduler?.isUpgradeQuiescent() ?? true) && owner.isUpgradeQuiescent(),
        });
        if (!result.prepared) {
            resumeUpgradeScheduler?.();
            resumeUpgradeScheduler = undefined;
        }
        return result;
    } catch (error) {
        // Scheduler dispatch is restored even when consumer restoration is
        // uncertain; readiness remains down through the control server's UNKNOWN.
        resumeUpgradeScheduler?.();
        resumeUpgradeScheduler = undefined;
        throw error;
    }
}

export async function resumeTaskSubsystemAfterUpgrade(): Promise<void> {
    if (shutdownStrict !== undefined) throw new Error('Task subsystem is stopping');
    const { getTaskRunner } = await import('$lib/server/tasks/runner');
    await getTaskRunner()?.resumeAfterUpgrade();
    resumeUpgradeScheduler?.();
    resumeUpgradeScheduler = undefined;
}

export function stopTaskSubsystem(options: { strict?: boolean } = {}): Promise<void> {
    // Tolerant teardown may already have published fast-recovery eligibility.
    // It cannot subsequently be certified as strict, even by an overlapping caller.
    if (options.strict && shutdownStrict === false)
        return Promise.reject(
            new Error('Cannot certify strict cleanup after tolerant shutdown; outcome UNKNOWN'),
        );
    shutdownStrict ??= options.strict ?? false;
    shutdown ??= stop(shutdownStrict).catch((error: unknown) => {
        // A failed strict attempt retains resource handles and may be retried.
        // Keep shutdownStrict set so startup cannot restart during that retry.
        shutdown = undefined;
        throw error;
    });
    return shutdown;
}

async function stop(strict: boolean): Promise<void> {
    const failures: unknown[] = [];
    let watcherStopped = false;
    // A signal during initialization must not leave late-starting consumers alive.
    await startup?.catch(() => undefined);
    if (watcherEnsureTimer) clearInterval(watcherEnsureTimer);
    watcherEnsureTimer = undefined;
    await watcherEnsurePending?.catch(() => undefined);
    await denyEnsurePending?.catch(() => undefined);
    // Stop file-scanner watcher: releases the Valkey leader lock and tears
    // down native watcher so a fast redeploy doesn't briefly overlap leaders.
    try {
        const { fileScannerMediaSource } =
            await import('$lib/server/tasks/builtin/native/media-sources/file-scanner.js');
        const { buildPluginContext } = await import('$lib/server/tasks/plugin-context.js');
        await fileScannerMediaSource.stopWatching!(buildPluginContext('file-scanner'));
        watcherStopped = true;
    } catch (err) {
        failures.push(err);
        startupLogger.warn('File scanner watcher stop failed', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Stop the Scheduler first so no new scheduled runs are enqueued while we
    // are draining BullMQ workers. catchUpAtBoot only runs at startup so we
    // don't need to coordinate with the new boot path here.
    if (taskScheduler) {
        try {
            await taskScheduler.stop();
            startupLogger.info('TaskScheduler stopped');
            taskScheduler = null;
        } catch (err) {
            failures.push(err);
            startupLogger.warn('Failed to stop TaskScheduler cleanly', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Stop the TaskRunner (consumer side of the new task system).
    try {
        const { stopTaskRunner } = await import('$lib/server/tasks/runner');
        await stopTaskRunner({ strict });
        startupLogger.info('TaskRunner stopped');
    } catch (err) {
        failures.push(err);
        startupLogger.warn('Failed to stop TaskRunner cleanly', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // A failed strict watcher stop can retain a reconciliation submission.
    // Keep its real orchestrator dependency alive until a retry accepts that
    // obligation. Stopping the facade is terminal and would make repair retries
    // impossible. Tolerant shutdown remains best-effort.
    if (watcherStopped || !strict) {
        try {
            const { orchestrator } = await import('$lib/server/tasks/orchestrator');
            await orchestrator.stop({ strict });
            startupLogger.info('TaskOrchestrator stopped');
        } catch (err) {
            failures.push(err);
            startupLogger.warn('Failed to stop TaskOrchestrator cleanly', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    // The singleton lease goes last, once everything it guards has stopped. If
    // a strict cleanup step failed, consumers may still be alive: keep renewing
    // so no successor starts beside them (a retry, or process exit and the
    // lease's expiry, ends it). Tolerant shutdown releases regardless.
    if (workerLeaseRequested && (!strict || failures.length === 0)) {
        try {
            const { releaseWorkerLease } = await import('./worker-lease.js');
            await releaseWorkerLease();
            workerLeaseRequested = false;
        } catch (err) {
            // Not a cleanup failure: everything the lease guards has stopped by
            // now, so an unreleased lease only delays a successor until it
            // expires (a compose restart takes PostgreSQL down with the worker,
            // so this is the normal outcome there). Counting it as a failure
            // made every `docker compose restart` log "cleanup outcome UNKNOWN".
            startupLogger.warn('Worker singleton lease release failed; it expires on its own', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    if (strict && failures.length > 0)
        throw new AggregateError(failures, 'Task subsystem cleanup incomplete; outcome UNKNOWN');
}
