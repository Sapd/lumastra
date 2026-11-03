// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Entrypoint for build/task-runtime.js. Environment/role must be set by the
// launcher BEFORE imports evaluate (config snapshots the startup environment).
import { base } from '$app/paths';
import {
    startTaskHealthServer,
    type ReadinessResult,
    type TaskHealthServer,
} from './health-server.js';
import {
    config,
    features,
    LUMASTRA_METRICS_PUBLIC,
    LUMASTRA_METRICS_BEARER_TOKEN,
} from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    startTaskSubsystem,
    stopTaskSubsystem,
    prepareTaskSubsystemUpgrade,
    resumeTaskSubsystemAfterUpgrade,
} from './lifecycle.js';
import { startUpgradeControl, requestUpgrade, type UpgradeControl } from './upgrade-control.js';
import { cleanupTaskProcess, createTaskProcessLifecycle } from './process-lifecycle.js';
import { reportTaskStartupEvidence } from './startup-evidence.js';
import {
    getHeartbeatRuntimeState,
    getWorkerRuntimeState,
    isProgressStalled,
    recordUncaughtException,
    registerConsumerStateProvider,
    registerUpgradeStateProvider,
    registerWatcherStateProvider,
    registerWorkerLeaseStateProvider,
    watcherReadinessReasons,
} from './runtime-state.js';
import { markLoopTick } from '$lib/server/tasks/loop-progress.js';

const log = Logger.for('TaskProcess');

function positiveIntFromEnv(name: string, fallback: number): number {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** No scheduler or consumer loop turn for this long fails liveness (after startup, outside upgrades). */
const LIVENESS_STALL_MS = positiveIntFromEnv('TASK_RUNTIME_LIVENESS_STALL_SECONDS', 600) * 1000;
/** This many uncaught exceptions inside the window trigger a strict shutdown. */
const UNCAUGHT_MAX = positiveIntFromEnv('TASK_RUNTIME_UNCAUGHT_MAX', 3);
const UNCAUGHT_WINDOW_MS = positiveIntFromEnv('TASK_RUNTIME_UNCAUGHT_WINDOW_SECONDS', 600) * 1000;
const CONSUMER_SAMPLE_MS = 10_000;

async function optionalStartup(label: string, start: () => Promise<unknown>): Promise<void> {
    try {
        await start();
    } catch (err) {
        log.warn(label, { error: err instanceof Error ? err.message : String(err) });
    }
}

async function main(): Promise<void> {
    const upgradeCommand = process.argv[2];
    if (
        upgradeCommand === '--prepare-upgrade' ||
        upgradeCommand === '--resume-upgrade' ||
        upgradeCommand === '--upgrade-status' ||
        upgradeCommand === '--stop-upgrade'
    ) {
        const socketPath = process.argv[3];
        if (!socketPath) throw new Error('Upgrade command requires the live worker socket path');
        const operation =
            upgradeCommand === '--prepare-upgrade'
                ? 'prepare'
                : upgradeCommand === '--resume-upgrade'
                  ? 'resume'
                  : upgradeCommand === '--stop-upgrade'
                    ? 'stop'
                    : 'status';
        let nonce = process.argv[4];
        // '-' reads the nonce from stdin so it never sits in argv.
        if (nonce === '-') {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of process.stdin) {
                size += (chunk as Buffer).length;
                if (size > 1024) throw new Error('Nonce on stdin too long');
                chunks.push(chunk as Buffer);
            }
            nonce = Buffer.concat(chunks).toString('utf8').trim();
        }
        const receipt = await requestUpgrade(socketPath, operation, nonce);
        console.log(JSON.stringify(receipt));
        process.exitCode =
            receipt.error ||
            (operation === 'prepare' && receipt.state !== 'prepared') ||
            (operation === 'stop' && receipt.state !== 'stopping')
                ? 2
                : 0;
        return;
    }
    reportTaskStartupEvidence('imports');
    // Used by the clean production-dependency smoke. Imports evaluate, but no
    // database, queue consumers, listeners or background work starts.
    if (process.argv.includes('--check-imports')) {
        console.log('Task runtime imports resolved without SvelteKit request handler');
        return;
    }
    if (process.env.WORKER_MODE !== 'enabled' || process.env.DEDICATED_WORKER !== 'true') {
        throw new Error(
            'Dedicated task runtime requires WORKER_MODE=enabled and DEDICATED_WORKER=true',
        );
    }
    // CACHE_URL is optional and best-effort: the worker must not refuse to start
    // (or go unready) because only the disposable cache is down or unset.
    if (!config.DATABASE_URL || !config.TASK_CACHE_URL) {
        throw new Error('Task runtime requires DATABASE_URL and TASK_CACHE_URL');
    }

    let health: TaskHealthServer | undefined;
    let ready = false;
    let readyAt: number | undefined;
    let consumerSampler: ReturnType<typeof setInterval> | undefined;
    let upgrade: UpgradeControl | undefined;
    let jellyfinStartup: Promise<void> | undefined;
    const lifecycle = createTaskProcessLifecycle({
        drain: () => {
            ready = false;
            health?.drain();
        },
        cleanup: () =>
            cleanupTaskProcess([
                async () => {
                    // The Valkey clients' native core logs at ERROR while they lose their server.
                    const { silenceGlideLoggerForShutdown } =
                        await import('$lib/server/cache/valkey.js');
                    silenceGlideLoggerForShutdown();
                },
                async () => {
                    if (consumerSampler) clearInterval(consumerSampler);
                },
                async () => {
                    await upgrade?.close();
                },
                () => stopTaskSubsystem({ strict: true }),
                async () => {
                    const { stopJellyfinConnectionLifecycle } =
                        await import('$lib/server/jellyfin/connection-lifecycle.js');
                    await stopJellyfinConnectionLifecycle();
                },
                // Keep the initial-start result separate: a rejected boot must
                // not skip unsubscribe, retry cancellation or mirror stop.
                async () => {
                    await jellyfinStartup;
                },
                async () => {
                    await health?.close();
                },
                async () => {
                    const { clusterHeartbeatService } =
                        await import('$lib/server/services/cluster-heartbeat.service.js');
                    await clusterHeartbeatService.stop();
                },
                async () => {
                    const { stopMemoryBreakdownLog } =
                        await import('$lib/server/services/memory-breakdown-log.js');
                    stopMemoryBreakdownLog();
                },
                async () => {
                    const { stopAuthCacheInvalidationSubscriber } =
                        await import('$lib/server/cache/auth-cache-bus.js');
                    stopAuthCacheInvalidationSubscriber();
                },
                async () => {
                    const { closeAllSubscriptions } = await import('$lib/server/cache/valkey.js');
                    await closeAllSubscriptions();
                },
                async () => {
                    const { flushProviderCallsForShutdown } =
                        await import('$lib/server/utils/provider-calls.js');
                    await flushProviderCallsForShutdown();
                    const { disconnectValkey } = await import('$lib/server/cache/valkey.js');
                    await disconnectValkey();
                },
                async () => {
                    const { closeDb } = await import('$lib/server/database/connection.js');
                    await closeDb();
                },
                async () => {
                    const { cleanupUndiciAgent } =
                        await import('$lib/server/runtime-optimizations.js');
                    await cleanupUndiciAgent();
                },
            ]),
        exit: (code) => process.exit(code),
        failed: (error) => {
            log.error(
                'Task runtime shutdown failed; cleanup outcome UNKNOWN',
                error instanceof Error ? error : new Error(String(error)),
            );
            // Cleanup layers aggregate independently; include nested failures so
            // the actual release error survives error-only worker logging.
            const logFailures = (failure: AggregateError, parent = ''): void => {
                for (const [i, step] of failure.errors.entries()) {
                    const position = `${parent}${i + 1}/${failure.errors.length}`;
                    log.error(
                        `Task runtime cleanup failure ${position}`,
                        step instanceof Error ? step : new Error(String(step)),
                    );
                    if (step instanceof AggregateError) logFailures(step, `${position}.`);
                }
            };
            if (error instanceof AggregateError) logFailures(error);
        },
    });
    // Keep handlers installed through cleanup: a repeated signal must not invoke
    // Node's default termination action and abandon an in-flight release.
    process.on('SIGTERM', () => {
        void lifecycle.shutdown(0);
    });
    process.on('SIGINT', () => {
        void lifecycle.shutdown(0);
    });
    // Match existing plugin-host behavior: report un-awaited plugin failures
    // without immediately abandoning every other active run in this process.
    process.on('unhandledRejection', (reason: unknown) => {
        log.error(
            'Unhandled task rejection',
            reason instanceof Error ? reason : new Error(String(reason)),
        );
    });
    process.on('uncaughtException', (err: Error) => {
        log.error('Uncaught task exception', err);
        void import('$lib/server/tasks/metrics.js')
            .then((m) => m.runtimeUncaughtExceptionsTotal.inc())
            .catch(() => {});
        const verdict = recordUncaughtException({
            duringShutdown: lifecycle.signal.aborted,
            threshold: UNCAUGHT_MAX,
            windowMs: UNCAUGHT_WINDOW_MS,
        });
        if (verdict.shutdown) {
            // The process may be in an undefined state after an uncaught exception. The
            // lifecycle shutdown is idempotent and deadline-bound, so it is safe to start
            // from here; exit code 1 lets the orchestrator restart a clean process.
            log.error(
                `Task runtime exiting: ${verdict.reason} (${verdict.count} uncaught since start)`,
            );
            void lifecycle.shutdown(1);
        }
    });

    try {
        const { tasksRegistry } = await import('$lib/server/tasks/metrics.js');
        const port = Number(process.env.PORT ?? 3000);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            throw new Error('Invalid task health PORT');
        health = await startTaskHealthServer({
            host: process.env.HOST ?? '0.0.0.0',
            port,
            basePath: base,
            readinessBlocked: () => {
                const state = upgrade?.status().state;
                return state && !['idle', 'postponed'].includes(state) ? `upgrade_${state}` : false;
            },
            liveness: () => {
                const stalled = isProgressStalled({
                    now: Date.now(),
                    stallMs: LIVENESS_STALL_MS,
                    startedAt: readyAt,
                    upgradeState: upgrade?.status().state,
                });
                return stalled ? { alive: false, reason: 'progress_stalled' } : { alive: true };
            },
            ready: async (): Promise<ReadinessResult> => {
                if (lifecycle.signal.aborted) return { ready: false, reasons: ['draining'] };
                if (!ready) return { ready: false, reasons: ['starting'] };
                const { testDbConnection } = await import('$lib/server/database/connection.js');
                const { isCoordinationValkeyHealthy } = await import('$lib/server/cache/valkey.js');
                const { getOrchestrator } = await import('$lib/server/tasks/orchestrator.js');
                const attempt = async (
                    check: () => Promise<boolean> | boolean,
                ): Promise<boolean> => {
                    try {
                        return await check();
                    } catch {
                        return false;
                    }
                };
                // The CACHE_URL cache is informational: losing it degrades speed, not task
                // processing, so it never appears here. Task state lives in coordination Valkey.
                const [database, coordination, orchestrator] = await Promise.all([
                    attempt(() => testDbConnection()),
                    attempt(() => isCoordinationValkeyHealthy()),
                    attempt(async () => (await getOrchestrator()).isHealthy()),
                ]);
                const reasons: string[] = [];
                if (!database) reasons.push('database_unavailable');
                if (!coordination) reasons.push('task_valkey_unavailable');
                if (!orchestrator) reasons.push('orchestrator_unavailable');
                reasons.push(...watcherReadinessReasons(getWorkerRuntimeState().watcher));
                return { ready: reasons.length === 0, reasons };
            },
            metrics: async () => {
                const { applyWorkerRuntimeMetrics } = await import('$lib/server/tasks/metrics.js');
                applyWorkerRuntimeMetrics(getWorkerRuntimeState());
                return tasksRegistry.metrics();
            },
            metricsContentType: tasksRegistry.contentType,
            // Live bindings: read per request, so a rotated token applies without a restart.
            metricsPublic: () => LUMASTRA_METRICS_PUBLIC,
            metricsToken: () => LUMASTRA_METRICS_BEARER_TOKEN,
            metricsAuthorized: async (request, url, peer) => {
                const { authenticate, scopeGranted } =
                    await import('$lib/server/tasks/api-auth.js');
                try {
                    const auth = await authenticate({
                        request,
                        url,
                        locals: {},
                        getClientAddress: () => peer,
                    });
                    return scopeGranted(auth.scopes, 'metrics:read');
                } catch {
                    return false;
                }
            },
        });
        const { applyRuntimeOptimizations } = await import('$lib/server/runtime-optimizations.js');
        lifecycle.signal.throwIfAborted();
        applyRuntimeOptimizations();
        const { migrateSchema } = await import('$lib/server/database/migrate-schema.js');
        await migrateSchema();
        lifecycle.signal.throwIfAborted();
        const { testDbConnection, getDb } = await import('$lib/server/database/connection.js');
        const { connectValkey, guardTaskValkey } = await import('$lib/server/cache/valkey.js');
        if (!(await testDbConnection()) || !(await connectValkey())) {
            throw new Error('Task runtime dependencies unavailable (PostgreSQL or task Valkey)');
        }
        lifecycle.signal.throwIfAborted();
        const guardSql = getDb();
        if (!guardSql) throw new Error('Task runtime database unavailable');
        // Refuse an evicting, shared, wrong-DB or silently-emptied task store
        // before any task state is read or written.
        await guardTaskValkey(guardSql);
        lifecycle.signal.throwIfAborted();
        const { startConfigChangeSubscriber } =
            await import('$lib/server/config/config.service.js');
        lifecycle.signal.throwIfAborted();
        await optionalStartup('Could not start config-change subscriber', () =>
            startConfigChangeSubscriber(),
        );
        lifecycle.signal.throwIfAborted();
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql) throw new Error('Task runtime database unavailable');
        const { loadProviderConfigFromDb } =
            await import('$lib/server/providers/provider-config-loader.js');
        await optionalStartup('Provider configuration unavailable; using configured fallback', () =>
            loadProviderConfigFromDb(sql),
        );
        lifecycle.signal.throwIfAborted();
        const { ensureProprietaryLoaded } = await import('$lib/server/licensing/entitlements.js');
        await ensureProprietaryLoaded();
        lifecycle.signal.throwIfAborted();
        const { startJellyfinConnectionLifecycle } =
            await import('$lib/server/jellyfin/connection-lifecycle.js');
        jellyfinStartup = startJellyfinConnectionLifecycle();
        if (features.jellyfinSync) await jellyfinStartup;
        else
            void jellyfinStartup.catch((err: unknown) =>
                log.warn('Jellyfin connection check failed to start', { error: String(err) }),
            );
        lifecycle.signal.throwIfAborted();
        registerUpgradeStateProvider(() => upgrade?.status().state);
        const { getWorkerLeaseState } = await import('./worker-lease.js');
        registerWorkerLeaseStateProvider(getWorkerLeaseState);
        const { getWatcherRuntimeState } =
            await import('$lib/server/tasks/builtin/native/media-sources/file-scanner.js');
        registerWatcherStateProvider(getWatcherRuntimeState);
        const { clusterHeartbeatService } =
            await import('$lib/server/services/cluster-heartbeat.service.js');
        clusterHeartbeatService.setRuntimeStateProvider(getHeartbeatRuntimeState);
        await startTaskSubsystem({
            strict: true,
            signal: lifecycle.signal,
            // Lost singleton lease: strict shutdown, exit 1, restart and contend again.
            onWorkerLeaseLost: () => {
                ready = false;
                void lifecycle.shutdown(1);
            },
        });
        lifecycle.signal.throwIfAborted();
        const { getTaskRunner } = await import('$lib/server/tasks/runner.js');
        registerConsumerStateProvider(() => {
            const state = getTaskRunner()?.consumerState();
            return state ? { running: state.running, paused: state.paused } : undefined;
        });
        const { installProviderKeyRematchTrigger } =
            await import('$lib/server/services/provider-key-rematch.service.js');
        installProviderKeyRematchTrigger();
        const { startProviderSettingsCacheInvalidation } =
            await import('$lib/server/plugins/runtime/field-authority-loader.js');
        await optionalStartup('Could not start plugin-settings invalidation', () =>
            startProviderSettingsCacheInvalidation(),
        );
        lifecycle.signal.throwIfAborted();
        const { startMemoryBreakdownLog } =
            await import('$lib/server/services/memory-breakdown-log.js');
        startMemoryBreakdownLog({ role: 'worker' });
        lifecycle.signal.throwIfAborted();
        upgrade = await startUpgradeControl({
            prepare: prepareTaskSubsystemUpgrade,
            resume: resumeTaskSubsystemAfterUpgrade,
            stop: () => {
                void lifecycle.shutdown(0);
            },
        });
        log.info('Dedicated task upgrade control ready', {
            socketPath: upgrade.socketPath,
            ...upgrade.status(),
        });
        lifecycle.signal.throwIfAborted();
        ready = true;
        readyAt = Date.now();
        // BullMQ emits no per-iteration event while idle ('drained' fires once, on the
        // transition to empty), so the runner ticks 'consumer' on job events and this
        // sampler covers the rest: consumers running and not paused, with either work in
        // flight or nothing claimable waiting. Claimable jobs waiting while nothing runs and
        // no event arrives is exactly the stall liveness must catch, so it does not tick.
        const { getOrchestrator } = await import('$lib/server/tasks/orchestrator.js');
        consumerSampler = setInterval(() => {
            void (async (): Promise<void> => {
                const state = getTaskRunner()?.consumerState();
                if (!state || state.running === 0) return;
                if (state.executing > 0) return markLoopTick('consumer');
                try {
                    const depths = await (await getOrchestrator()).getQueueDepths();
                    const backlog = Object.values(depths).some((d) => d.waiting > 0 && !d.paused);
                    if (!backlog) markLoopTick('consumer');
                } catch {
                    // Queue depth unreadable (backend outage): unknown is not a stall.
                    markLoopTick('consumer');
                }
            })();
        }, CONSUMER_SAMPLE_MS);
        consumerSampler.unref();
        markLoopTick('consumer');
        reportTaskStartupEvidence('ready');
        log.info('Dedicated task runtime ready');
    } catch (err) {
        if (!lifecycle.signal.aborted) {
            log.error(
                'Task runtime startup failed',
                err instanceof Error ? err : new Error(String(err)),
            );
        }
        lifecycle.startupFinished();
        // A cooperative startup cancellation is expected on TERM. An unrelated
        // startup failure during that same interval still makes shutdown fail.
        await lifecycle.shutdown(err === lifecycle.signal.reason ? 0 : 1);
    } finally {
        lifecycle.startupFinished();
    }
}

void main().catch((err: unknown) => {
    log.error('Task runtime failed', err instanceof Error ? err : new Error(String(err)));
    process.exitCode = 1;
});
