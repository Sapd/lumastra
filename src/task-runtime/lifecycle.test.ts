// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    events: [] as string[],
    worker: true,
    coordinationHealthy: true,
    cacheReady: true,
    decode: vi.fn(),
    trickplay: vi.fn(),
    valkeyBoot: 'healthy' as 'healthy' | 'unavailable' | 'throws',
    failRunner: false,
    failWatcherStop: false,
    failRunnerStop: false,
    failLeaseRelease: false,
    failSchedulerStop: false,
    verdict: { state: 'up' } as {
        state: 'up' | 'gone' | 'unknown';
        evidence?: 'error' | 'silence';
    },
    jobsRunning: false,
    goneDependencies: undefined as string[] | undefined,
    leaseReleaseHangs: false,
    runnerStopHangs: false,
    hardExit: [] as number[],
    schedulerStopHangs: false,
    orchestratorStop: 'ok' as 'ok' | 'fails' | 'hangs',
    pluginPending: undefined as Promise<void> | undefined,
    featurePending: undefined as Promise<void> | undefined,
    subscriberStarts: 0,
    watcherStopPending: undefined as Promise<void> | undefined,
    rateLimitLoads: 0,
    runnerStopModes: [] as boolean[],
    watcherPending: undefined as Promise<void> | undefined,
    leasePending: undefined as Promise<void> | undefined,
    leaseLost: undefined as ((reason: string) => void) | undefined,
}));
// W1's startup guard (managed authority must stay off) reads PostgreSQL.
// The real probe opens TCP connections to the configured hosts.
vi.mock('$lib/server/lifecycle/infrastructure-probe.js', () => ({
    createInfrastructureProbe: () => ({
        verdict: async (only?: string[]) =>
            state.goneDependencies && only && !only.some((n) => state.goneDependencies!.includes(n))
                ? { state: 'up' }
                : state.verdict,
    }),
    missingProbeTargets: () => [],
    probeTargetsFromEnvironment: () => [],
}));
vi.mock('./authority/store.js', () => ({ assertTaskAuthorityUnmanaged: async () => {} }));
vi.mock('./worker-lease.js', () => ({
    acquireWorkerLease: async (options: {
        signal?: AbortSignal;
        onLost: (reason: string) => void;
    }): Promise<void> => {
        state.events.push('lease');
        state.leaseLost = options.onLost;
        await state.leasePending;
        options.signal?.throwIfAborted();
    },
    releaseWorkerLease: async (): Promise<void> => {
        state.events.push('release-lease');
        if (state.leaseReleaseHangs) await new Promise<void>(() => {});
        if (state.failLeaseRelease) throw new Error('the database system is shutting down');
    },
}));
vi.mock('$lib/server/config.js', () => ({
    config: { WORKER_MODE: 'enabled' },
    shouldStartWorkers: () => state.worker,
    FEATURE_PIPELINE_EVENT_OUTBOX: false,
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/plugins', () => ({
    loadAllPlugins: async () => {
        state.events.push('plugins');
        await state.pluginPending;
    },
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/tasks/builtin', () => ({
    loadBuiltins: async () => {
        state.events.push('builtins');
    },
}));
vi.mock('$lib/server/tasks/http-rate-limit.js', () => ({
    applyStoredRateLimits: async () => {
        state.rateLimitLoads++;
        return 0;
    },
}));
vi.mock('$lib/server/plugins/runtime/feature-startup.js', () => ({
    runFeatureStartups: async () => {
        state.events.push('features');
        await state.featurePending;
    },
}));
vi.mock('$lib/server/tasks/registry.js', () => ({ registry: { getAllFeatures: () => [] } }));
vi.mock('$lib/server/tasks/plugin-context.js', () => ({ buildPluginContext: () => ({ sql: {} }) }));
vi.mock('$lib/server/cache/valkey', () => ({
    connectValkey: async () => {
        state.events.push('valkey');
        if (state.valkeyBoot === 'throws') throw new Error('Valkey unavailable');
        return state.valkeyBoot === 'healthy';
    },
    isValkeyReady: () => state.cacheReady,
    isCoordinationValkeyHealthy: async () => state.coordinationHealthy,
    guardTaskValkey: async () => undefined,
    getValkeyClient: () => (state.cacheReady ? { customCommand: vi.fn() } : null),
    // Scheduler fire claims use the task Valkey, present even without a cache.
    getCoordinationClient: () => ({ customCommand: vi.fn() }),
}));
vi.mock('$lib/server/cache/decode-deny-bus', () => ({
    startDecodeDenySubscriber: state.decode,
}));
vi.mock('$lib/server/cache/trickplay-hwaccel-deny-bus', () => ({
    startTrickplayHwaccelDenySubscriber: state.trickplay,
}));
vi.mock('$lib/server/cache/auth-cache-bus', () => ({
    stopAuthCacheInvalidationSubscriber: vi.fn(),
    startAuthCacheInvalidationSubscriber: async () => {
        state.subscriberStarts++;
    },
}));
vi.mock('$lib/server/tasks/builtin/native/media-sources/file-scanner.js', () => ({
    fileScannerMediaSource: {
        startWatching: async () => {
            state.events.push('watcher');
            await state.watcherPending;
        },
        stopWatching: async () => {
            state.events.push('stop-watcher');
            await state.watcherStopPending;
            if (state.failWatcherStop) throw new Error('watcher stop failed');
        },
    },
    updateWatcherPaths: async () => {},
}));
vi.mock('$lib/server/services/cluster-heartbeat.service.js', () => ({
    clusterHeartbeatService: {
        start: async () => {
            state.events.push('heartbeat');
        },
    },
}));
vi.mock('$lib/server/database/connection', () => ({ getDb: () => null }));
vi.mock('$lib/server/database/queries/event-outbox.queries', () => ({
    syncEventOutboxFlag: vi.fn(),
}));
vi.mock('$lib/server/database/queries/sync-changes.queries.js', () => ({
    checkSyncInstance: async () => {},
}));
vi.mock('$lib/server/tasks/orchestrator', () => ({
    getOrchestrator: async () => {
        state.events.push('orchestrator');
        return {
            recoverInterruptedWorkerRuns: async () => {
                state.events.push('recover-worker-runs');
            },
        };
    },
    orchestrator: {
        stop: async () => {
            state.events.push('stop-orchestrator');
            if (state.orchestratorStop === 'hangs') await new Promise<void>(() => {});
            if (state.orchestratorStop === 'fails') throw new Error('leader release unconfirmed');
        },
    },
}));
vi.mock('$lib/server/tasks/runner', () => ({
    startTaskRunner: async () => {
        state.events.push('runner');
        if (state.failRunner) throw new Error('runner failed');
        return {
            haltClaims: (): void => {
                state.events.push('halt-claims');
            },
        };
    },
    taskRunnerHasExecutingJobs: () => state.jobsRunning,
    stopTaskRunner: async (options: { strict?: boolean } = {}) => {
        state.runnerStopModes.push(options.strict ?? false);
        state.events.push('stop-runner');
        if (state.runnerStopHangs) await new Promise<void>(() => {});
        if (state.failRunnerStop) throw new Error('runner stop failed');
    },
}));
vi.mock('$lib/server/tasks/scheduler.js', () => ({
    Scheduler: class {
        async catchUpAtBoot(): Promise<void> {
            state.events.push('catchup');
        }
        suspendForUpgrade(): () => void {
            state.events.push('suspend-scheduler');
            return () => {};
        }
        async start(): Promise<void> {
            state.events.push('scheduler');
        }
        async stop(): Promise<void> {
            state.events.push('stop-scheduler');
            if (state.schedulerStopHangs) await new Promise<void>(() => {});
            if (state.failSchedulerStop) throw new Error('scheduler stop failed');
        }
    },
}));

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv('TASK_CACHE_URL', 'redis://task-test:6379');
    vi.stubEnv('CACHE_URL', 'redis://cache-test:6379');
    state.events = [];
    state.worker = true;
    state.coordinationHealthy = true;
    state.cacheReady = true;
    state.decode.mockReset();
    state.decode.mockResolvedValue(true);
    state.trickplay.mockReset();
    state.trickplay.mockResolvedValue(true);
    state.failRunner = false;
    state.failWatcherStop = false;
    state.failRunnerStop = false;
    state.failLeaseRelease = false;
    state.failSchedulerStop = false;
    state.verdict = { state: 'up' };
    state.jobsRunning = false;
    state.goneDependencies = undefined;
    state.leaseReleaseHangs = false;
    state.runnerStopHangs = false;
    state.hardExit = [];
    state.schedulerStopHangs = false;
    state.orchestratorStop = 'ok';
    state.pluginPending = undefined;
    state.featurePending = undefined;
    state.subscriberStarts = 0;
    state.valkeyBoot = 'healthy';
    state.watcherStopPending = undefined;
    state.rateLimitLoads = 0;
    state.runnerStopModes = [];
    state.watcherPending = undefined;
    state.leasePending = undefined;
    state.leaseLost = undefined;
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('dedicated task lifecycle seam', () => {
    it('initializes once, heartbeats before recovery and starts consumers only after recovery', async () => {
        const runtime = await import('./lifecycle.js');
        const first = runtime.startTaskSubsystem({ strict: true });
        expect(runtime.startTaskSubsystem()).toBe(first);
        await first;
        expect(state.events).toEqual([
            'lease',
            'builtins',
            'plugins',
            'features',
            'valkey',
            'watcher',
            'heartbeat',
            'orchestrator',
            'recover-worker-runs',
            'runner',
            'catchup',
            'scheduler',
        ]);
        const stop = runtime.stopTaskSubsystem();
        expect(runtime.stopTaskSubsystem()).toBe(stop);
        await stop;
        expect(state.events.slice(-5)).toEqual([
            'stop-watcher',
            'stop-scheduler',
            'stop-runner',
            'stop-orchestrator',
            'release-lease',
        ]);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(state.events.filter((event) => event === 'watcher')).toHaveLength(1);
    });
    it('holds the singleton lease before any registry, watcher or consumer work', async () => {
        let grant: () => void = () => {};
        state.leasePending = new Promise<void>((resolve) => {
            grant = resolve;
        });
        const runtime = await import('./lifecycle.js');
        const starting = runtime.startTaskSubsystem({ strict: true });
        await vi.advanceTimersByTimeAsync(60_000);
        // Another worker holds the lease: nothing beyond the wait has started.
        expect(state.events).toEqual(['lease']);
        grant();
        await starting;
        expect(state.events).toContain('runner');
        expect(state.events).toContain('scheduler');
        await runtime.stopTaskSubsystem({ strict: true });
        expect(state.events.at(-1)).toBe('release-lease');
    });
    it('does not treat a failed lease release as an unknown cleanup outcome', async () => {
        // `docker compose restart` stops PostgreSQL together with the worker. Every
        // consumer is already stopped here, so an unreleased lease only expires.
        state.failLeaseRelease = true;
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true });
        await expect(runtime.stopTaskSubsystem({ strict: true })).resolves.toBeUndefined();
        expect(state.events.at(-1)).toBe('release-lease');
    });
    describe('when PostgreSQL or Valkey vanish during the stop', () => {
        const start = async () => {
            const runtime = await import('./lifecycle.js');
            runtime.__setHardExitForTests((code) => state.hardExit.push(code));
            await runtime.startTaskSubsystem({ strict: true });
            return runtime;
        };
        it('stops within a few seconds when the network says the server is gone, and leaves the lease and locks to expire', async () => {
            // Full `docker compose restart`: the leader-lock releases and loop ticks wait on a
            // Valkey that stopped with us. Their locks expire on their own.
            const runtime = await start();
            state.verdict = { state: 'gone', evidence: 'error' };
            state.orchestratorStop = 'hangs';
            const stopping = runtime.stopTaskSubsystem({ strict: true });
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(stopping).resolves.toBeUndefined();
            expect(state.events).toContain('stop-orchestrator');
            // An abandoned step means nobody knows what is still held: nothing is released.
            expect(state.events).not.toContain('release-lease');
        });
        it('does not wait for an in-flight scheduler tick that waits for a Valkey that is gone', async () => {
            const runtime = await start();
            state.verdict = { state: 'gone', evidence: 'error' };
            state.schedulerStopHangs = true;
            const stopping = runtime.stopTaskSubsystem({ strict: true });
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(stopping).resolves.toBeUndefined();
            expect(state.events).toContain('stop-runner');
        });
        it('exits before the lease expires when an abandoned teardown is still running', async () => {
            const runtime = await start();
            state.verdict = { state: 'gone', evidence: 'error' };
            state.orchestratorStop = 'hangs';
            void runtime.stopTaskSubsystem({ strict: true });
            await vi.advanceTimersByTimeAsync(10_000);
            expect(state.hardExit).toEqual([]);
            await vi.advanceTimersByTimeAsync(15_000);
            expect(state.hardExit).toEqual([1]);
        });
        it.each(['up', 'unknown'] as const)(
            'keeps waiting for a slow orchestrator stop when the probe says %s (busy pool, blocked loop)',
            async (probeState) => {
                const runtime = await start();
                state.verdict = { state: probeState };
                state.orchestratorStop = 'hangs';
                let settled = false;
                const stopping = runtime.stopTaskSubsystem({ strict: true }).finally(() => {
                    settled = true;
                });
                await vi.advanceTimersByTimeAsync(40_000);
                expect(settled).toBe(false);
                // The lease is released only after the teardown it guards finished.
                expect(state.events).not.toContain('release-lease');
                expect(state.hardExit).toEqual([]);
                void stopping.catch(() => undefined);
            },
        );
        it('still waits for a hung scheduler stop while the infrastructure answers', async () => {
            const runtime = await start();
            state.schedulerStopHangs = true;
            let settled = false;
            const stopping = runtime.stopTaskSubsystem({ strict: true }).finally(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(30_000);
            expect(settled).toBe(false);
            expect(state.events).not.toContain('stop-runner');
            void stopping.catch(() => undefined);
        });
        it('does not give up on a runner stop with jobs running after mere silence', async () => {
            const runtime = await start();
            state.jobsRunning = true;
            state.runnerStopHangs = true;
            state.verdict = { state: 'gone', evidence: 'silence' };
            let settled = false;
            const stopping = runtime.stopTaskSubsystem({ strict: true }).finally(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(30_000);
            expect(settled).toBe(false);
            expect(state.events).not.toContain('release-lease');
            void stopping.catch(() => undefined);
        });
        it('gives up on a runner stop with jobs running only on a refused connection, and reports it as unknown', async () => {
            const runtime = await start();
            state.jobsRunning = true;
            state.runnerStopHangs = true;
            state.verdict = { state: 'gone', evidence: 'error' };
            const stopping = runtime.stopTaskSubsystem({ strict: true });
            const rejected = expect(stopping).rejects.toThrow('outcome UNKNOWN');
            await vi.advanceTimersByTimeAsync(10_000);
            await rejected;
            expect(state.events).not.toContain('release-lease');
        });
        it('does not give up on a Postgres lease release because only Valkey is gone', async () => {
            const runtime = await start();
            state.leaseReleaseHangs = true;
            state.verdict = { state: 'gone', evidence: 'error' };
            state.goneDependencies = ['task-valkey'];
            let settled = false;
            const stopping = runtime.stopTaskSubsystem({ strict: true }).finally(() => {
                settled = true;
            });
            await vi.advanceTimersByTimeAsync(30_000);
            // The lease release is waited for, as its server answers.
            expect(settled).toBe(false);
            expect(state.hardExit).toEqual([]);
            void stopping.catch(() => undefined);
        });
        it('gives up on a Valkey step because Valkey is gone, whatever Postgres does', async () => {
            const runtime = await start();
            state.orchestratorStop = 'hangs';
            state.verdict = { state: 'gone', evidence: 'error' };
            state.goneDependencies = ['task-valkey'];
            const stopping = runtime.stopTaskSubsystem({ strict: true });
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(stopping).resolves.toBeUndefined();
        });
        it('does not swallow a genuine error because the server was gone a moment ago', async () => {
            const runtime = await start();
            state.orchestratorStop = 'fails';
            // The server is up when the error arrives.
            state.verdict = { state: 'up' };
            await expect(runtime.stopTaskSubsystem({ strict: true })).rejects.toThrow(
                'outcome UNKNOWN',
            );
        });
    });
    it('still reports a failed orchestrator teardown while the infrastructure is reachable', async () => {
        state.orchestratorStop = 'fails';
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true });
        await expect(runtime.stopTaskSubsystem({ strict: true })).rejects.toThrow(
            'outcome UNKNOWN',
        );
    });
    it('cancels while waiting for the singleton lease without starting anything', async () => {
        let grant: () => void = () => {};
        state.leasePending = new Promise<void>((resolve) => {
            grant = resolve;
        });
        const controller = new AbortController();
        const runtime = await import('./lifecycle.js');
        const starting = runtime.startTaskSubsystem({ strict: true, signal: controller.signal });
        const rejected = expect(starting).rejects.toThrow('stopping');
        controller.abort(new Error('stopping'));
        grant();
        await rejected;
        expect(state.events).toEqual(['lease']);
        await runtime.stopTaskSubsystem({ strict: true });
        expect(state.events).not.toContain('runner');
    });
    it('hands a lease loss while running to the process handler', async () => {
        const onWorkerLeaseLost = vi.fn();
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true, onWorkerLeaseLost });
        state.leaseLost?.('lease expired or taken over');
        expect(onWorkerLeaseLost).toHaveBeenCalledWith('lease expired or taken over');
        await runtime.stopTaskSubsystem({ strict: true });
        // A loss reported during shutdown is ignored.
        state.leaseLost?.('late');
        expect(onWorkerLeaseLost).toHaveBeenCalledTimes(1);
    });
    it('halts claims and scheduler dispatch synchronously on a lease loss, before teardown', async () => {
        const onWorkerLeaseLost = vi.fn();
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true, onWorkerLeaseLost });
        state.events = [];
        state.leaseLost?.('lease expired or taken over');
        // Same tick, nothing awaited: a successor may already be consuming.
        expect(state.events).toEqual(['halt-claims', 'suspend-scheduler']);
        expect(onWorkerLeaseLost).toHaveBeenCalledOnce();
        await runtime.stopTaskSubsystem({ strict: true });
    });
    it('halts claims before the strict teardown waits on the watcher', async () => {
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true });
        let release: () => void = () => {};
        state.watcherStopPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        state.events = [];
        state.leaseLost?.('no confirmed renewal');
        expect(state.events.slice(0, 2)).toEqual(['halt-claims', 'suspend-scheduler']);
        await vi.waitFor(() => expect(state.events).toContain('stop-watcher'));
        expect(state.events).not.toContain('stop-runner');
        release();
        await vi.waitFor(() => expect(state.events).toContain('stop-orchestrator'));
    });
    it('does not start consumers when the lease is lost during startup', async () => {
        let release: () => void = () => {};
        state.watcherPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const onWorkerLeaseLost = vi.fn();
        const runtime = await import('./lifecycle.js');
        const starting = runtime.startTaskSubsystem({ strict: true, onWorkerLeaseLost });
        const rejected = expect(starting).rejects.toThrow('lease lost');
        await vi.waitFor(() => expect(state.events).toContain('watcher'));
        state.leaseLost?.('lease expired or taken over');
        release();
        await rejected;
        expect(state.events).not.toContain('runner');
        expect(state.events).not.toContain('scheduler');
        await runtime.stopTaskSubsystem({ strict: true });
    });
    it('stops consumers itself on a lease loss when no handler is given', async () => {
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true });
        state.leaseLost?.('no confirmed renewal');
        await vi.waitFor(() => expect(state.events).toContain('stop-orchestrator'));
        expect(state.events).toContain('stop-runner');
        expect(state.events).toContain('stop-scheduler');
        await expect(runtime.startTaskSubsystem()).rejects.toThrow('stopping');
    });
    it('rejects invalid dedicated Valkey configuration before registry or feature work', async () => {
        vi.stubEnv('TASK_CACHE_URL', '');
        const runtime = await import('./lifecycle.js');
        await expect(runtime.startTaskSubsystem({ strict: true })).rejects.toThrow(
            'TASK_CACHE_URL',
        );
        expect(state.events).toEqual([]);
        expect(state.rateLimitLoads).toBe(0);
        expect(state.subscriberStarts).toBe(0);
        await runtime.stopTaskSubsystem();
    });
    it('refuses to start dedicated consumers on a web process', async () => {
        state.worker = false;
        const runtime = await import('./lifecycle.js');
        await expect(runtime.startTaskSubsystem()).rejects.toThrow('dedicated worker process');
        expect(state.events).toEqual([]);
    });
    it('rejects late startup after shutdown begins, including before initialization', async () => {
        const runtime = await import('./lifecycle.js');
        await runtime.stopTaskSubsystem();
        await expect(runtime.startTaskSubsystem()).rejects.toThrow('stopping');
        expect(state.events).not.toContain('builtins');
        expect(state.events).not.toContain('runner');
    });
    it('waits for initial watcher readiness before starting consumers', async () => {
        let release: () => void = () => {};
        state.watcherPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const runtime = await import('./lifecycle.js');
        const starting = runtime.startTaskSubsystem();
        await vi.waitFor(() => expect(state.events).toContain('watcher'));
        expect(state.events).not.toContain('runner');
        release();
        await starting;
        expect(state.events).toContain('runner');
        await runtime.stopTaskSubsystem();
    });
    it('initializes web feature plugins and task producers without task consumers', async () => {
        state.worker = false;
        const runtime = await import('./web-lifecycle.js');
        const starting = runtime.startWebTaskSubsystem();
        expect(runtime.startWebTaskSubsystem()).toBe(starting);
        await starting;
        expect(state.events).toEqual(['builtins', 'plugins', 'features', 'valkey', 'orchestrator']);
        expect(state.rateLimitLoads).toBe(1);
        await runtime.stopWebTaskSubsystem();
        expect(state.events.slice(-1)).toEqual(['stop-orchestrator']);
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('stopping');
        expect(state.events).not.toContain('stop-watcher');
        expect(state.events).not.toContain('stop-runner');
    });
    it('rejects a worker role at the web startup boundary', async () => {
        const runtime = await import('./web-lifecycle.js');
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('web server cannot run');
        expect(state.events).toEqual([]);
    });
    it.each(['unavailable', 'throws'] as const)(
        'starts the web auth-cache supervisor when Valkey boot %s',
        async (failure) => {
            state.worker = false;
            state.valkeyBoot = failure;
            const runtime = await import('./web-lifecycle.js');
            await expect(runtime.startWebTaskSubsystem()).rejects.toThrow(/Valkey/);
            await vi.waitFor(() => expect(state.subscriberStarts).toBe(1));
            expect(state.events).not.toContain('runner');
            expect(state.events).not.toContain('watcher');
        },
    );
    it('starts the dedicated watcher and consumers with coordination only and memory caching', async () => {
        vi.stubEnv('CACHE_URL', '');
        state.cacheReady = false;
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true });
        expect(state.events).toContain('watcher');
        expect(state.events).toContain('runner');
        expect(state.events).toContain('scheduler');
        // Deny buses are pub/sub, which runs on the task Valkey: no cache needed.
        await vi.waitFor(() => expect(state.decode).toHaveBeenCalled());
        await vi.waitFor(() => expect(state.trickplay).toHaveBeenCalled());
        await runtime.stopTaskSubsystem({ strict: true });
    });
    it('recovers failed cache subscriptions on the watcher tick and stops retrying after success or shutdown', async () => {
        state.decode.mockResolvedValueOnce(false);
        state.trickplay.mockResolvedValueOnce(false);
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true });
        await vi.waitFor(() => expect(state.trickplay).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(state.decode).toHaveBeenCalledTimes(2);
        expect(state.trickplay).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(state.decode).toHaveBeenCalledTimes(2);
        expect(state.trickplay).toHaveBeenCalledTimes(2);
        await runtime.stopTaskSubsystem({ strict: true });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(state.decode).toHaveBeenCalledTimes(2);
        expect(state.trickplay).toHaveBeenCalledTimes(2);
    });

    it('keeps watcher readiness independent of subscription delays and cancels later subscription work at stop', async () => {
        let release: (subscribed: boolean) => void = () => {};
        state.decode.mockReturnValue(
            new Promise<boolean>((resolve) => {
                release = resolve;
            }),
        );
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true });
        expect(state.events).toContain('watcher');
        expect(state.events).toContain('runner');
        expect(state.decode).toHaveBeenCalledTimes(1);
        expect(state.trickplay).not.toHaveBeenCalled();
        const stopping = runtime.stopTaskSubsystem({ strict: true });
        release(false);
        await stopping;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(state.decode).toHaveBeenCalledTimes(1);
        expect(state.trickplay).not.toHaveBeenCalled();
    });

    it('refuses dedicated watcher leadership when only cache Valkey is healthy', async () => {
        state.coordinationHealthy = false;
        const runtime = await import('./lifecycle.js');
        await expect(runtime.startTaskSubsystem({ strict: true })).rejects.toThrow(
            'healthy coordination Valkey',
        );
        expect(state.events).not.toContain('watcher');
        expect(state.events).not.toContain('runner');
        await runtime.stopTaskSubsystem();
    });
    it('fails dedicated startup visibly when consumers cannot start and still cleans up', async () => {
        state.failRunner = true;
        const runtime = await import('./lifecycle.js');
        await expect(runtime.startTaskSubsystem({ strict: true })).rejects.toThrow('runner failed');
        await runtime.stopTaskSubsystem();
        expect(state.events).not.toContain('scheduler');
        expect(state.events).toContain('stop-orchestrator');
    });
    it('waits for an in-flight watcher ensure before shutdown and coalesces periodic ensures', async () => {
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem();
        let release: () => void = () => {};
        state.watcherPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(state.events.filter((event) => event === 'watcher')).toHaveLength(2);
        const stopping = runtime.stopTaskSubsystem();
        await Promise.resolve();
        expect(state.events).not.toContain('stop-watcher');
        release();
        await stopping;
        expect(state.events).toContain('stop-watcher');
    });
    it('cancels dedicated startup at the watcher boundary before starting consumers', async () => {
        let release: () => void = () => {};
        state.watcherPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const controller = new AbortController();
        const runtime = await import('./lifecycle.js');
        const startup = runtime.startTaskSubsystem({ strict: true, signal: controller.signal });
        const rejected = expect(startup).rejects.toThrow('stopping');
        await vi.waitFor(() => {
            expect(state.events).toContain('watcher');
        });
        controller.abort(new Error('stopping'));
        release();
        await rejected;
        await runtime.stopTaskSubsystem({ strict: true });
        expect(state.events).not.toContain('heartbeat');
        expect(state.events).not.toContain('runner');
        expect(state.events).not.toContain('scheduler');
        expect(state.events).toContain('stop-watcher');
    });
    it('retains all cleanup errors in strict mode and still attempts the later releases', async () => {
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true });
        state.failWatcherStop = true;
        state.failRunnerStop = true;
        const stopping = runtime.stopTaskSubsystem({ strict: true });
        expect(runtime.stopTaskSubsystem({ strict: true })).toBe(stopping);
        await expect(stopping).rejects.toMatchObject({
            message: expect.stringContaining('UNKNOWN'),
            errors: [expect.any(Error), expect.any(Error)],
        });
        expect(state.events.slice(-3)).toEqual(['stop-watcher', 'stop-scheduler', 'stop-runner']);
        expect(state.events).not.toContain('stop-orchestrator');
        // Consumers may still be alive: the singleton lease is kept, not released.
        expect(state.events).not.toContain('release-lease');
    });
    it('allows explicitly best-effort cleanup without certifying a strict shutdown', async () => {
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem();
        state.failWatcherStop = true;
        state.failRunnerStop = true;
        await expect(runtime.stopTaskSubsystem()).resolves.toBeUndefined();
        expect(state.events).toContain('stop-orchestrator');
    });
    it('rejects strict certification after tolerant shutdown, including overlapping calls', async () => {
        let release: () => void = () => {};
        state.watcherStopPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem();
        const tolerant = runtime.stopTaskSubsystem();
        await vi.waitFor(() => {
            expect(state.events).toContain('stop-watcher');
        });
        await expect(runtime.stopTaskSubsystem({ strict: true })).rejects.toThrow('UNKNOWN');
        release();
        await tolerant;
        expect(state.runnerStopModes).toEqual([false]);
        await expect(runtime.stopTaskSubsystem({ strict: true })).rejects.toThrow('UNKNOWN');
        expect(runtime.stopTaskSubsystem()).toBe(tolerant);
    });
    it('retains a failed scheduler and retries a rejected strict shutdown', async () => {
        const runtime = await import('./lifecycle.js');
        await runtime.startTaskSubsystem({ strict: true });
        state.failSchedulerStop = true;
        await expect(runtime.stopTaskSubsystem({ strict: true })).rejects.toThrow('UNKNOWN');
        await expect(runtime.startTaskSubsystem()).rejects.toThrow('stopping');
        state.failSchedulerStop = false;
        await runtime.stopTaskSubsystem({ strict: true });
        expect(state.events.filter((event) => event === 'stop-scheduler')).toHaveLength(2);
        expect(state.runnerStopModes).toEqual([true, true]);
    });
    it('cancels immediately after plugin loading before stored rate limits or feature startup', async () => {
        let release: () => void = () => {};
        state.pluginPending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const controller = new AbortController();
        const runtime = await import('./lifecycle.js');
        const starting = runtime.startTaskSubsystem({ strict: true, signal: controller.signal });
        const rejected = expect(starting).rejects.toThrow('stopping');
        await vi.waitFor(() => {
            expect(state.events).toContain('plugins');
        });
        controller.abort(new Error('stopping'));
        release();
        await rejected;
        expect(state.rateLimitLoads).toBe(0);
        expect(state.events).not.toContain('features');
        expect(state.events).not.toContain('runner');
        await runtime.stopTaskSubsystem({ strict: true });
    });
    it('cancels immediately after feature startup before Valkey and background subscriptions', async () => {
        let release: () => void = () => {};
        state.featurePending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const controller = new AbortController();
        const runtime = await import('./lifecycle.js');
        const starting = runtime.startTaskSubsystem({ strict: true, signal: controller.signal });
        const rejected = expect(starting).rejects.toThrow('stopping');
        await vi.waitFor(() => {
            expect(state.events).toContain('features');
        });
        controller.abort(new Error('stopping'));
        release();
        await rejected;
        expect(state.events).not.toContain('valkey');
        expect(state.events).not.toContain('runner');
        expect(state.subscriberStarts).toBe(0);
        await runtime.stopTaskSubsystem({ strict: true });
    });
});
