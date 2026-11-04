// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for TaskRunner — mocks BullMQ Worker, stateMachine, registry,
 * sql, and the cancel pubsub. No live infrastructure required.
 *
 * Run with: npx vitest run src/lib/server/tasks/runner.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';
import {
    defineTask,
    TaskError,
    type ResourceClass,
    type TaskContext,
    type TaskResult,
    type TaskDefinition,
} from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import { DelayedError, UnrecoverableError } from 'bullmq';
import type { Job, Processor, Queue as BullQueue } from 'bullmq';
import { TaskRegistry } from './registry.js';
import type { StateMachine } from './state-machine.js';
import { luaLoader } from './lua/loader.js';
import { classifyMediaInfraError } from './infra-retry.js';
import {
    TaskRunner,
    classifyError,
    getTaskRunner,
    startTaskRunner,
    stopTaskRunner,
    type WorkerLike,
    type RunnerJob,
} from './runner.js';
import type { SpawnIsolationWorker, IsolationWorkerLike } from './isolation/worker-host.js';
import type { SandboxWorkerData } from './isolation/protocol.js';
import { Logger } from '$lib/server/utils/logger.js';
import { __resetCancelChannelForTests } from './cancel-channel.js';
import { config } from '$lib/server/config.js';
import { countExternalCall } from '../utils/external-request-counter.js';
import * as playbackPressure from './playback-pressure.js';
import { taskActiveRuns } from './metrics.js';
import { QueueOperationUncertainError } from '../../../task-runtime/authority/queue-write.js';

/**
 * Read the current `task_active_runs` gauge value for a (task→class, instance)
 * pair. Returns 0 when the labelset has not been touched yet. Used by the F70
 * leak regression to assert the gauge is balanced across a failed attempt.
 */
async function gaugeValue(_taskId: string, resourceClass: string): Promise<number> {
    // prom-client Gauge.get() resolves to { values: [{ value, labels }, ...] }
    const snapshot = await (
        taskActiveRuns as unknown as {
            get(): Promise<{
                values: { value: number; labels: Record<string, string> }[];
            }>;
        }
    ).get();
    const match = snapshot.values.find(
        (v) =>
            v.labels.resource_class === resourceClass && v.labels.instance_id === 'test-instance',
    );
    return match?.value ?? 0;
}

// Real ownership transaction/script behavior is exercised against PostgreSQL/Valkey
// in existing-write.integration.test.ts and fenced.integration.test.ts.
// Unit queue adapters execute their in-memory RPC directly. The durable journal
// and actual BullMQ API are exercised together in queue-write.integration.test.
vi.mock('../../../task-runtime/authority/queue-write.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../task-runtime/authority/queue-write.js')>()),
    withTaskQueueWrite: async (
        _sql: unknown,
        _authority: unknown,
        _operation: unknown,
        write: () => Promise<unknown>,
    ) => write(),
}));
vi.mock('../../../task-runtime/authority/existing-write.js', () => ({
    withExistingTaskWrite: async (
        sql: postgres.Sql,
        _authority: unknown,
        mutate: (tx: postgres.Sql) => Promise<unknown>,
    ) => mutate(sql),
}));
vi.mock('./owned-write.js', () => ({
    invokeOwnedCommand: async (
        command: string[],
        client: { customCommand(command: string[]): Promise<unknown> },
    ) => client.customCommand(command),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: vi.fn(() => null),
    getCoordinationClient: vi.fn(() => null),
    subscribeToChannel: vi.fn(async () => null),
    publishMessage: vi.fn(async () => true),
}));

vi.mock('$lib/server/queue/connection.js', () => ({
    getQueueConnectionOptions: vi.fn(() => ({
        host: 'localhost',
        port: 6379,
        db: 1,
    })),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => null),
    getTaskDb: vi.fn(() => null),
}));

vi.mock('$lib/server/config.js', () => ({
    config: { INSTANCE_ID: 'test-instance', WORKER_MODE: 'enabled', DEDICATED_WORKER: true },
    LUMASTRA_CONCURRENCY_CPU: 2,
    LUMASTRA_CONCURRENCY_IO: 4,
    LUMASTRA_CONCURRENCY_EMBEDDING: 2,
    LUMASTRA_CONCURRENCY_MAINTENANCE: 3,
    LUMASTRA_CONCURRENCY_INGEST: 4,
    LUMASTRA_CONCURRENCY_BULK: 2,
    LUMASTRA_CONCURRENCY_ANALYSIS: 1,
    // Default per-task ctx.http rate cap (TASK-C6). Tests exercise the
    // capability-gate wiring, not the throttle timing, so any positive value
    // works — the http-rate-limit buckets are unit-tested separately.
    LUMASTRA_TASK_HTTP_DEFAULT_RPS: 10,
    // Wave 8.5 per-task-queue flag — default off so these unit tests exercise
    // the legacy per-class path. The flag-on path has its own integration test.
    FEATURE_PER_TASK_QUEUES: false,
    LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS: 30_000,
    LUMASTRA_RUN_STATE_TTL_ACTIVE_MS: 900_000,
    // Stall thresholds — the watchdog reads these on every heartbeat tick.
    // If omitted, the `>` comparisons in heartbeatOnce evaluate against
    // `undefined` and always return false, silently disabling the test
    // coverage that exercises stall / wall-clock auto-fail paths.
    LUMASTRA_RUN_STALL_WARN_MS: 120_000,
    LUMASTRA_RUN_STALL_FAIL_MS: 600_000,
    // Connection-wedge watchdog threshold — read in TaskRunner.start when
    // constructing ConnectionWedgeWatchdog. Must be present or start() throws on
    // the undefined export.
    LUMASTRA_WORKER_CONN_WEDGE_MS: 120_000,
    // BullMQ job lock duration threaded into worker construction.
    LUMASTRA_BULLMQ_LOCK_DURATION_MS: 300_000,
    // Task L: secrets store needs a master key (64-char hex → 32-byte AES key).
    LUMASTRA_MASTER_KEY: 'a'.repeat(64),
    // Plugin worker-thread isolation — default off so the in-process path is the
    // default in these unit tests; the isolation describe block overrides
    // `pluginIsolation` per-test via TaskRunnerOpts.
    FEATURE_PLUGIN_WORKER_ISOLATION: false,
    LUMASTRA_ISOLATION_DB_POOL_MAX: 2,
    LUMASTRA_ISOLATION_ENTRY_PATH: '',
    LUMASTRA_ISOLATION_TERMINATE_GRACE_MS: 2_000,
}));

// ── Test doubles ──────────────────────────────────────────────────────────────

interface FakeClient {
    customCommand: Mock<(cmd: string[]) => Promise<unknown>>;
    _hsets: Array<{ key: string; fields: Record<string, string> }>;
    _pexpires: Array<{ key: string; ttl: number }>;
}

function makeFakeClient(): FakeClient {
    const hsets: FakeClient['_hsets'] = [];
    const pexpires: FakeClient['_pexpires'] = [];
    const customCommand = vi.fn(async (cmd: string[]): Promise<unknown> => {
        const op = cmd[0]?.toUpperCase();
        switch (op) {
            case 'HSET': {
                const key = cmd[1];
                const fields: Record<string, string> = {};
                for (let i = 2; i + 1 < cmd.length; i += 2) {
                    fields[cmd[i]] = cmd[i + 1];
                }
                hsets.push({ key, fields });
                return Math.floor((cmd.length - 2) / 2);
            }
            case 'PEXPIRE':
                pexpires.push({ key: cmd[1], ttl: Number(cmd[2]) });
                return 1;
            default:
                return null;
        }
    });
    return { customCommand, _hsets: hsets, _pexpires: pexpires };
}

interface FakeSql {
    calls: Array<{ head: string; values: unknown[] }>;
    responses: Map<string, unknown[]>;
    sql: postgres.Sql;
}

function makeFakeSql(): FakeSql {
    const calls: FakeSql['calls'] = [];
    const responses = new Map<string, unknown[]>();
    type SqlFn = ((s: readonly string[], ...v: unknown[]) => Promise<unknown[]>) & {
        json: (v: unknown) => unknown;
    };
    const sqlFn: SqlFn = ((strings: readonly string[], ...values: unknown[]) => {
        const head = (strings[0] || '').trim().slice(0, 80);
        calls.push({ head, values });
        for (const [key, rows] of responses) {
            if (head.includes(key)) return Promise.resolve(rows);
        }
        return Promise.resolve([]);
    }) as SqlFn;
    sqlFn.json = (v: unknown) => v;
    return { calls, responses, sql: sqlFn as unknown as postgres.Sql };
}

function makeStateMachine(): {
    sm: StateMachine;
    transitionRun: ReturnType<typeof vi.fn>;
    transitionStage: ReturnType<typeof vi.fn>;
    incrementStage: ReturnType<typeof vi.fn>;
    claimRun: ReturnType<typeof vi.fn>;
    reseedForRetry: ReturnType<typeof vi.fn>;
} {
    const transitionRun = vi.fn(async () => ({ ok: true }));
    const transitionStage = vi.fn(async () => ({ ok: true }));
    const incrementStage = vi.fn(async () => ({
        ok: true,
        processed: 0,
        autoCompleted: false,
    }));
    const claimRun = vi.fn(async () => ({ ok: true }));
    // Default reseed result matches the production "hash was DEL'd on
    // active→failed terminal, now re-seeded as pending" path so retry tests
    // exercise the same flow as the real state machine.
    const reseedForRetry = vi.fn(async () => 'reseeded' as const);
    const sm = {
        transitionRun,
        transitionStage,
        incrementStage,
        claimRun,
        reseedForRetry,
    } as unknown as StateMachine;
    return {
        sm,
        transitionRun,
        transitionStage,
        incrementStage,
        claimRun,
        reseedForRetry,
    };
}

function makeFakeWorker(): WorkerLike & { _processor: Processor | null } {
    return {
        _processor: null,
        async close() {},
        on() {
            return this;
        },
    };
}

interface FakeJobOpts {
    name: string;
    runId: string;
    input?: unknown;
    parentRunId?: string;
    scope?: { libraryGroupId?: string; userId?: string };
    mode?: TaskContext['mode'];
    attemptsMade?: number;
    exclusivityKey?: string;
}

function makeJob(opts: FakeJobOpts): Job {
    return {
        id: `job_${opts.runId}`,
        name: opts.name,
        attemptsMade: opts.attemptsMade ?? 0,
        attemptsStarted: (opts.attemptsMade ?? 0) + 1,
        queueName: 'io',
        queueQualifiedName: 'bull:task:io',
        data: {
            runId: opts.runId,
            input: opts.input ?? {},
            parentRunId: opts.parentRunId,
            scope: opts.scope,
            mode: opts.mode,
            exclusivityKey: opts.exclusivityKey,
        },
    } as unknown as Job;
}

// ── Registry helper ───────────────────────────────────────────────────────────

interface TaskFactoryOpts {
    coversStages?: TaskDefinition['coversStages'];
    exclusiveWith?: TaskDefinition['exclusiveWith'];
    timeout?: TaskDefinition['timeout'];
    resourceClass?: ResourceClass;
    id?: string;
    capabilities?: TaskFactoryCapabilities;
    execute: (ctx: TaskContext) => Promise<TaskResult>;
    retryOn?: (err: unknown) => boolean;
    retryAttempts?: number;
    isolation?: 'inline' | 'worker';
}

interface TaskFactoryCapabilities {
    http?: boolean;
    cache?: boolean;
    ffmpeg?: boolean;
    dataDir?: boolean;
}

function makeRegistry(tasks: TaskFactoryOpts[]): TaskRegistry {
    const reg = new TaskRegistry();
    for (const t of tasks) {
        reg.registerTask(
            defineTask({
                id: t.id ?? 'basic-task',
                name: 'Test',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: t.capabilities ?? {},
                resourceClass: t.resourceClass ?? 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'one',
                retry:
                    t.retryAttempts !== undefined || t.retryOn
                        ? {
                              attempts: t.retryAttempts ?? 1,
                              backoff: 'exponential' as const,
                              retryOn: t.retryOn ?? (() => true),
                          }
                        : undefined,
                isolation: t.isolation,
                coversStages: t.coversStages,
                exclusiveWith: t.exclusiveWith,
                timeout: t.timeout,
                execute: t.execute,
            }),
        );
    }
    return reg;
}

// ── Boot helper ───────────────────────────────────────────────────────────────

interface BootOpts {
    tasks: TaskFactoryOpts[];
    sql?: postgres.Sql | null;
    client?: FakeClient;
    subscribeImpl?: (
        channel: string,
        cb: (msg: string) => void,
    ) => Promise<(() => Promise<void>) | null>;
    queueFactory?: (cls: ResourceClass) => BullQueue;
    pluginIsolation?: boolean;
    spawnIsolationWorker?: SpawnIsolationWorker;
}

async function bootRunner(opts: BootOpts): Promise<{
    runner: TaskRunner;
    stateMachine: ReturnType<typeof makeStateMachine>;
    fakeClient: FakeClient;
    fakeWorker: ReturnType<typeof makeFakeWorker>;
    callProcessor: (job: Job) => Promise<unknown>;
}> {
    const registry = makeRegistry(opts.tasks);
    const stateMachine = makeStateMachine();
    const fakeClient = opts.client ?? makeFakeClient();
    const fakeWorker = makeFakeWorker();
    let captured: Processor | null = null;

    const runner = await TaskRunner.start(
        [...new Set(['io' as ResourceClass, ...opts.tasks.map((t) => t.resourceClass ?? 'io')])],
        {
            registry,
            stateMachine: stateMachine.sm,
            getSql: () => opts.sql ?? null,
            getClient: () =>
                fakeClient as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000, // effectively disabled in unit tests
            concurrencyFor: () => 1,
            subscribe: opts.subscribeImpl ?? (async () => null),
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
            ...(opts.queueFactory ? { queueFactory: opts.queueFactory } : {}),
            ...(opts.pluginIsolation !== undefined
                ? { pluginIsolation: opts.pluginIsolation }
                : {}),
            ...(opts.spawnIsolationWorker
                ? { spawnIsolationWorker: opts.spawnIsolationWorker }
                : {}),
        },
    );
    const callProcessor = async (job: Job) => {
        if (!captured) throw new Error('processor not captured');
        return captured(job, 'token');
    };
    return { runner, stateMachine, fakeClient, fakeWorker, callProcessor };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// Cancel pubsub is multiplexed over one process-wide shared subscription
// (cancel-channel.ts). Reset that singleton between tests so each test's
// injected subscribe binds fresh and doesn't inherit a prior test's stub.
beforeEach(() => {
    __resetCancelChannelForTests();
});

describe('TaskRunner role boundary', () => {
    it('refuses direct consumer startup on web and obsolete combined roles', async () => {
        const role = config as { WORKER_MODE: 'enabled' | 'disabled'; DEDICATED_WORKER: boolean };
        try {
            role.WORKER_MODE = 'disabled';
            role.DEDICATED_WORKER = false;
            await expect(TaskRunner.start([])).rejects.toThrow('dedicated worker process');
            expect(await startTaskRunner([])).toBeNull();
            role.WORKER_MODE = 'enabled';
            await expect(TaskRunner.start([])).rejects.toThrow('Combined web/task');
            await expect(startTaskRunner([])).rejects.toThrow('Combined web/task');
        } finally {
            role.WORKER_MODE = 'enabled';
            role.DEDICATED_WORKER = true;
        }
    });
});

describe('TaskRunner.processJob — happy path', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('claims, transitions pending→active, executes, transitions to completed', async () => {
        const executeSpy = vi.fn(async () => ({
            success: true,
            itemsProcessed: 1,
        }));
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: executeSpy }],
        });

        const result = await callProcessor(makeJob({ name: 'basic-task', runId: 'run_abc' }));

        expect(stateMachine.claimRun).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: 'run_abc',
                expectedState: 'pending',
                instanceId: 'test-instance',
                bootId: 'boot-0',
            }),
        );
        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).toContain('pending->active');
        expect(transitions).toContain('active->completed');
        expect(executeSpy).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ success: true, itemsProcessed: 1 });
        await runner.stop();
    });

    it('passes input + scope + mode + attemptNumber to the plugin context', async () => {
        let captured: TaskContext | null = null;
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'basic-task',
                    execute: async (ctx) => {
                        captured = ctx;
                        return { success: true };
                    },
                },
            ],
        });
        await callProcessor(
            makeJob({
                name: 'basic-task',
                runId: 'run_xyz',
                input: { foo: 'bar' },
                scope: { libraryGroupId: 'lg-1', userId: 'u-1' },
                mode: 'scheduled',
                attemptsMade: 2,
            }),
        );
        expect(captured).not.toBeNull();
        expect(captured!.runId).toBe('run_xyz');
        expect(captured!.input).toEqual({ foo: 'bar' });
        expect(captured!.scope).toEqual({
            libraryGroupId: 'lg-1',
            userId: 'u-1',
        });
        expect(captured!.mode).toBe('scheduled');
        expect(captured!.attemptNumber).toBe(3);
        await runner.stop();
    });
});

describe('TaskRunner.processJob — exclusiveWith mutex release', () => {
    // Release goes through luaLoader.invoke('release-identity', [key], [runId])
    // — a compare-and-delete (DEL only if the key still holds this run's runId)
    // so a terminal release can't steal a successor's re-claimed lock. Spy on
    // the loader so we assert the release call + its value-guard arg.
    let releaseSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        releaseSpy = vi
            .spyOn(luaLoader, 'invoke')
            .mockResolvedValue(1 as unknown as Awaited<ReturnType<typeof luaLoader.invoke>>);
    });
    afterEach(() => {
        releaseSpy.mockRestore();
        vi.clearAllMocks();
    });

    // Release calls for a given key, asserting the compare-and-delete guard
    // carries this run's runId as the expected value (argv[0]).
    const releasesFor = (key: string, runId: string) =>
        releaseSpy.mock.calls.filter(
            (call: unknown[]) =>
                call[0] === 'release-identity' &&
                (call[1] as string[])?.[0] === key &&
                (call[2] as string[])?.[0] === runId,
        );
    const allReleases = () =>
        releaseSpy.mock.calls.filter((call: unknown[]) => call[0] === 'release-identity');

    const KEY_OK = 'task:identity:excl-task:excl-task~~one';

    it('releases the exclusivity key (compare-and-delete) on a completed run', async () => {
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id: 'excl-task', execute: async () => ({ success: true }) }],
        });
        await callProcessor(
            makeJob({
                name: 'excl-task',
                runId: 'run_excl_ok',
                exclusivityKey: KEY_OK,
            }),
        );
        expect(releasesFor(KEY_OK, 'run_excl_ok')).toHaveLength(1);
        await runner.stop();
    });

    it('does NOT release the exclusivity key on a non-final failed attempt (retry pending)', async () => {
        const key = 'task:identity:excl-retry:excl-retry~~one';
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'excl-retry',
                    retryAttempts: 3,
                    execute: async () => {
                        throw new TaskError({
                            message: 'transient boom',
                            kind: 'transient',
                        });
                    },
                },
            ],
        });
        // attemptsMade=0 → current attempt 1 of 3 → not final → mutex held.
        await expect(
            callProcessor(
                makeJob({
                    name: 'excl-retry',
                    runId: 'run_excl_retry',
                    attemptsMade: 0,
                    exclusivityKey: key,
                }),
            ),
        ).rejects.toThrow('transient boom');
        // The attempt returns to pending; it must not publish a failed terminal.
        const failedTransition = stateMachine.transitionRun.mock.calls.some(
            ([opts]) => opts.from === 'active' && opts.to === 'failed',
        );
        expect(failedTransition).toBe(false);
        expect(stateMachine.transitionRun.mock.calls.some(([opts]) => opts.to === 'pending')).toBe(
            true,
        );
        expect(releasesFor(key, 'run_excl_retry')).toHaveLength(0);
        await runner.stop();
    });

    it('releases the exclusivity key on the final failed attempt', async () => {
        const key = 'task:identity:excl-retry2:excl-retry2~~one';
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'excl-retry2',
                    retryAttempts: 3,
                    execute: async () => {
                        throw new TaskError({
                            message: 'final boom',
                            kind: 'transient',
                        });
                    },
                },
            ],
        });
        // attemptsMade=2 → current attempt 3 of 3 → final → release.
        await expect(
            callProcessor(
                makeJob({
                    name: 'excl-retry2',
                    runId: 'run_excl_final',
                    attemptsMade: 2,
                    exclusivityKey: key,
                }),
            ),
        ).rejects.toThrow('final boom');
        expect(releasesFor(key, 'run_excl_final')).toHaveLength(1);
        await runner.stop();
    });

    it('issues no release when the job carries no exclusivity key (non-exclusive task)', async () => {
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id: 'plain-task', execute: async () => ({ success: true }) }],
        });
        await callProcessor(makeJob({ name: 'plain-task', runId: 'run_plain' }));
        expect(allReleases()).toHaveLength(0);
        await runner.stop();
    });

    // BUG1: a 'permanent'/'fatal' classification can never succeed on retry,
    // so BullMQ must not be allowed to retry it per `attempts` — the runner
    // now throws UnrecoverableError on that path (moving the job straight to
    // 'failed') and releases the exclusivity mutex unconditionally, exactly
    // like the pre-existing watchdog late-return UnrecoverableError case.
    it('throws UnrecoverableError and releases the mutex unconditionally for a permanent error, even on a non-final attempt', async () => {
        const key = 'task:identity:excl-permanent:excl-permanent~~one';
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'excl-permanent',
                    retryAttempts: 3,
                    execute: async () => {
                        throw new TaskError({
                            message: 'permanent boom',
                            kind: 'permanent',
                        });
                    },
                },
            ],
        });
        // attemptsMade=0 → current attempt 1 of 3 → NOT final by the old
        // `attempts` accounting — but a permanent error must still release
        // the mutex immediately because it can never retry.
        await expect(
            callProcessor(
                makeJob({
                    name: 'excl-permanent',
                    runId: 'run_excl_permanent',
                    attemptsMade: 0,
                    exclusivityKey: key,
                }),
            ),
        ).rejects.toBeInstanceOf(UnrecoverableError);
        expect(releasesFor(key, 'run_excl_permanent')).toHaveLength(1);
        await runner.stop();
    });
});

describe('TaskRunner.processJob — watchdog late-return guard (F38)', () => {
    // When the stall/wall-clock watchdog auto-fails a run mid-execution it sets
    // `stallFailed` and writes a terminal 'failed'. If the wedged plugin later
    // RETURNS a value, the processor must NOT return normally — a returned
    // processor makes BullMQ mark the JOB 'completed', diverging from the run's
    // 'failed' state (QueueEvents emits 'completed', a FlowProducer parent looks
    // successful, downstream stages mis-schedule). The processor must throw
    // UnrecoverableError so BullMQ moves the job to 'failed' WITHOUT retrying.
    let releaseSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        releaseSpy = vi
            .spyOn(luaLoader, 'invoke')
            .mockResolvedValue(1 as unknown as Awaited<ReturnType<typeof luaLoader.invoke>>);
    });
    afterEach(() => {
        releaseSpy.mockRestore();
        vi.clearAllMocks();
    });

    const stallFailedOf = (runner: TaskRunner): Set<string> =>
        (runner as unknown as { stallFailed: Set<string> }).stallFailed;

    it('throws UnrecoverableError (not a normal return) when the watchdog already auto-failed the run', async () => {
        let captured: TaskRunner | null = null;
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'wedged-task',
                    execute: async () => {
                        // Simulate the watchdog firing mid-execution: it sets
                        // stallFailed and writes the terminal. Then the wedged
                        // plugin finally produces a (now-stale) success result.
                        stallFailedOf(captured!).add('run_wedged');
                        return { success: true };
                    },
                },
            ],
        });
        captured = runner;

        await expect(
            callProcessor(makeJob({ name: 'wedged-task', runId: 'run_wedged' })),
        ).rejects.toBeInstanceOf(UnrecoverableError);

        // The processor must NOT have driven an active→completed transition —
        // the watchdog already owns the terminal state.
        const completedTransition = stateMachine.transitionRun.mock.calls.some(
            ([opts]) => opts.from === 'active' && opts.to === 'completed',
        );
        expect(completedTransition).toBe(false);
        await runner.stop();
    });

    it('releases the exclusivity key unconditionally on the late-return throw (UnrecoverableError never retries)', async () => {
        const key = 'task:identity:wedged-excl:wedged-excl~~one';
        let captured: TaskRunner | null = null;
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'wedged-excl',
                    // attempts: 3, and we run a NON-final attempt (attemptsMade=0).
                    // A normal late-throw would hold the mutex (isFinalAttempt
                    // false); but UnrecoverableError can't retry, so the mutex
                    // MUST be released anyway or it leaks until TTL.
                    retryAttempts: 3,
                    execute: async () => {
                        stallFailedOf(captured!).add('run_wedged_excl');
                        return { success: true };
                    },
                },
            ],
        });
        captured = runner;

        await expect(
            callProcessor(
                makeJob({
                    name: 'wedged-excl',
                    runId: 'run_wedged_excl',
                    attemptsMade: 0,
                    exclusivityKey: key,
                }),
            ),
        ).rejects.toBeInstanceOf(UnrecoverableError);

        const released = releaseSpy.mock.calls.some(
            (call: unknown[]) =>
                call[0] === 'release-identity' &&
                (call[1] as string[])?.[0] === key &&
                (call[2] as string[])?.[0] === 'run_wedged_excl',
        );
        expect(released).toBe(true);
        await runner.stop();
    });
});

describe('TaskRunner watchdog — wall-clock budget anchored to execution start (A2)', () => {
    // A BullMQ re-delivery (ungraceful worker death → lock lapses → another
    // worker re-claims the SAME runId) used to re-seed the hard-timeout clock
    // from `now` on every pickup, so a run alive for hours never tripped its
    // declared `timeout.hard`. The budget is now anchored to the run's true
    // execution start, resolved from durable run state.
    afterEach(() => {
        vi.clearAllMocks();
    });

    const internalsOf = (runner: TaskRunner) =>
        runner as unknown as {
            startHeartbeat: (runId: string, t: unknown, budgetStartMs?: number) => void;
            stopHeartbeat: (runId: string) => void;
            checkRunDeadline: (runId: string, nowMs: number) => Promise<boolean>;
            resolveBudgetStartMs: (runId: string) => Promise<number | undefined>;
            runDeadlines: Map<string, { startedAtMs: number; hardMs: number }>;
        };

    const taskWith2hHard = defineTask({
        id: 'anchor-task',
        name: 'Anchor',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.unknown(),
        identityFor: () => 'one',
        timeout: { hard: '2h', soft: '115m' },
        execute: async () => ({ success: true }),
    });

    it('anchors the hard-timeout budget to a persisted execution start in the past (re-delivery)', async () => {
        const { runner } = await bootRunner({
            tasks: [{ id: 'anchor-task', execute: async () => ({ success: true }) }],
        });
        const internals = internalsOf(runner);
        const threeHoursAgo = Date.now() - 3 * 3_600_000;
        internals.startHeartbeat('run_redelivered', taskWith2hHard, threeHoursAgo);
        expect(internals.runDeadlines.get('run_redelivered')?.startedAtMs).toBe(threeHoursAgo);
        internals.stopHeartbeat('run_redelivered');
        await runner.stop();
    });

    it('falls back to pickup time on a genuine first attempt (no persisted start)', async () => {
        const { runner } = await bootRunner({
            tasks: [{ id: 'anchor-task', execute: async () => ({ success: true }) }],
        });
        const internals = internalsOf(runner);
        const before = Date.now();
        internals.startHeartbeat('run_first', taskWith2hHard, undefined);
        const anchored = internals.runDeadlines.get('run_first')?.startedAtMs ?? 0;
        expect(anchored).toBeGreaterThanOrEqual(before);
        expect(anchored).toBeLessThanOrEqual(Date.now());
        internals.stopHeartbeat('run_first');
        await runner.stop();
    });

    it('ignores a future persisted start (clock skew) and anchors to pickup time', async () => {
        const { runner } = await bootRunner({
            tasks: [{ id: 'anchor-task', execute: async () => ({ success: true }) }],
        });
        const internals = internalsOf(runner);
        const before = Date.now();
        internals.startHeartbeat('run_skew', taskWith2hHard, Date.now() + 60 * 60_000);
        const anchored = internals.runDeadlines.get('run_skew')?.startedAtMs ?? 0;
        expect(anchored).toBeGreaterThanOrEqual(before);
        expect(anchored).toBeLessThanOrEqual(Date.now());
        internals.stopHeartbeat('run_skew');
        await runner.stop();
    });

    it('auto-fails on the first deadline tick when the anchored age already exceeds timeout.hard', async () => {
        const { runner } = await bootRunner({
            tasks: [{ id: 'anchor-task', execute: async () => ({ success: true }) }],
        });
        const internals = internalsOf(runner);
        const autoFail = vi
            .spyOn(
                runner as unknown as { autoFailRun: (...a: unknown[]) => Promise<void> },
                'autoFailRun',
            )
            .mockResolvedValue(undefined);
        internals.startHeartbeat('run_over', taskWith2hHard, Date.now() - 3 * 3_600_000);
        const failed = await internals.checkRunDeadline('run_over', Date.now());
        expect(failed).toBe(true);
        expect(autoFail).toHaveBeenCalledWith(
            'run_over',
            'watchdog-timeout-hard',
            expect.any(String),
            expect.any(String),
        );
        internals.stopHeartbeat('run_over');
        await runner.stop();
    });

    it('resolveBudgetStartMs prefers the Valkey active-hash startedAt when present', async () => {
        const fakeClient = makeFakeClient();
        const startIso = new Date(Date.now() - 90 * 60_000).toISOString();
        fakeClient.customCommand.mockImplementation(async (cmd: string[]) => {
            if (cmd[0]?.toUpperCase() === 'HGET' && cmd[2] === 'startedAt') return startIso;
            return null;
        });
        const { runner } = await bootRunner({
            tasks: [{ id: 'anchor-task', execute: async () => ({ success: true }) }],
            client: fakeClient,
        });
        const internals = internalsOf(runner);
        const resolved = await internals.resolveBudgetStartMs('run_x');
        expect(resolved).toBe(Date.parse(startIso));
        await runner.stop();
    });
});

describe('TaskRunner.processJob — error paths', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('throws TaskError(permanent) when task is unknown', async () => {
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id: 'known-task', execute: async () => ({ success: true }) }],
        });
        await expect(
            callProcessor(makeJob({ name: 'unknown-task', runId: 'run_zzz' })),
        ).rejects.toMatchObject({ name: 'TaskError', kind: 'permanent' });
        await runner.stop();
    });

    it('throws TaskError(fatal) when runId is missing', async () => {
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });
        const job = makeJob({ name: 'basic-task', runId: '' });
        // Force runId missing.
        (job.data as { runId: string }).runId = '';
        await expect(callProcessor(job)).rejects.toMatchObject({
            kind: 'fatal',
        });
        await runner.stop();
    });

    it('marks failed when plugin throws an arbitrary Error', async () => {
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new Error('boom');
                    },
                },
            ],
        });
        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_fail' })),
        ).rejects.toThrow('boom');
        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).toContain('active->failed');
        const failedCall = stateMachine.transitionRun.mock.calls.find(
            ([opts]) => opts.from === 'active' && opts.to === 'failed',
        );
        expect(failedCall![0].extra.errorMessage).toBe('boom');
        expect(failedCall![0].extra.errorKind).toBe('permanent');
        await runner.stop();
    });

    it('marks failed with kind=transient when plugin throws TaskError(transient)', async () => {
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new TaskError({
                            message: 'flaky',
                            kind: 'transient',
                        });
                    },
                },
            ],
        });
        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_flaky' })),
        ).rejects.toThrow('flaky');
        const failedCall = stateMachine.transitionRun.mock.calls.find(
            ([opts]) => opts.from === 'active' && opts.to === 'failed',
        );
        expect(failedCall![0].extra.errorKind).toBe('transient');
        await runner.stop();
    });

    it('cleans up pre-execution resources when the Valkey claim throws', async () => {
        const unsubscribe = vi.fn(async () => {});
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ execute: async () => ({ success: true }) }],
            subscribeImpl: async () => unsubscribe,
        });
        stateMachine.claimRun.mockRejectedValueOnce(new Error('Connection is closed'));
        try {
            await expect(
                callProcessor(makeJob({ name: 'basic-task', runId: 'claim-disconnected' })),
            ).rejects.toThrow('Connection is closed');
            const resources = runner as unknown as {
                runReleases: Map<string, unknown>;
                abortControllers: Map<string, unknown>;
                cancelUnsubs: Map<string, unknown>;
            };
            expect(resources.runReleases.size).toBe(0);
            expect(resources.abortControllers.size).toBe(0);
            expect(resources.cancelUnsubs.size).toBe(0);
        } finally {
            await runner.stop();
        }
    });

    it('rethrows TaskError(transient) when claimRun fails', async () => {
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });
        stateMachine.claimRun.mockResolvedValueOnce({
            ok: false,
            error: 'already claimed',
        });
        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_lost' })),
        ).rejects.toMatchObject({ kind: 'transient' });
        // W1/C2: a pre-exec bail (claim failed after the watchdog-release handle
        // was registered) must not leak the runReleases Map entry.
        expect((runner as unknown as { runReleases: Map<string, unknown> }).runReleases.size).toBe(
            0,
        );
        await runner.stop();
    });
});

// Valkey OOM / save-failure log throttle. BullMQ re-emits a Worker `error`
// event for every failed poll/lock-renew/claim while Valkey rejects writes.
// Before this throttle, the handler logged the full multi-line ERROR on every
// event, which flooded a worker's stdout to 186 GB and filled the host disk
// (2026-05 preprod incident → Docker DNS broke, whole stack wedged). The
// handler must now emit at most one line per MEMORY_CRITICAL_LOG_THROTTLE_MS
// (30s) across all workers, folding the suppressed count into the next line.
describe('TaskRunner — Valkey OOM log throttle', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it('logs a memory-critical Valkey error at most once per 30s window', async () => {
        const taskLog = Logger.for('TaskRunner');
        const errorSpy = vi.spyOn(taskLog, 'error').mockImplementation(() => {});

        const { runner } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });
        const internals = runner as unknown as {
            logMemoryCriticalIfMatch: (err: unknown, ctx: Record<string, unknown>) => boolean;
        };

        // Pin the clock so the whole burst lands inside one throttle window.
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        const oom = new Error("OOM command not allowed when used memory > 'maxmemory'.");

        // 1000 events in the same window: each is recognized as memory-critical
        // (returns true → caller skips the generic warn), but only the first is
        // actually logged.
        for (let i = 0; i < 1000; i++) {
            expect(internals.logMemoryCriticalIfMatch(oom, { cls: 'io' })).toBe(true);
        }
        expect(errorSpy).toHaveBeenCalledTimes(1);

        // Cross the window — the next event logs again and reports how many it
        // suppressed in between (999), so operators see the true volume.
        nowSpy.mockReturnValue(1_000_000 + 30_001);
        expect(internals.logMemoryCriticalIfMatch(oom, { cls: 'io' })).toBe(true);
        expect(errorSpy).toHaveBeenCalledTimes(2);
        const secondCtx = errorSpy.mock.calls[1][2] as {
            suppressedSinceLastLog?: number;
        };
        expect(secondCtx.suppressedSinceLastLog).toBe(999);

        await runner.stop();
    });

    it('recognizes MISCONF save-failure as memory-critical', async () => {
        const taskLog = Logger.for('TaskRunner');
        const errorSpy = vi.spyOn(taskLog, 'error').mockImplementation(() => {});
        vi.spyOn(Date, 'now').mockReturnValue(2_000_000);

        const { runner } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });
        const internals = runner as unknown as {
            logMemoryCriticalIfMatch: (err: unknown, ctx: Record<string, unknown>) => boolean;
        };

        const misconf = new Error(
            'MISCONF Redis is configured to save RDB snapshots, but it is currently ' +
                'unable to persist to disk.',
        );
        expect(
            internals.logMemoryCriticalIfMatch(misconf, {
                taskId: 'series-sync',
            }),
        ).toBe(true);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        await runner.stop();
    });

    it('returns false for ordinary errors so they fall through to warn', async () => {
        const { runner } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });
        const internals = runner as unknown as {
            logMemoryCriticalIfMatch: (err: unknown, ctx: Record<string, unknown>) => boolean;
        };
        expect(
            internals.logMemoryCriticalIfMatch(new Error('connection reset by peer'), {
                cls: 'io',
            }),
        ).toBe(false);
        await runner.stop();
    });
});

// F7 — Plugin throw racing a cancel pubsub. The cancel landed in Valkey first,
// so state='cancelling'. The runner's active→failed Lua transition rejects
// with state-mismatch. Before this fix the runner would still UPDATE Postgres
// to 'failed', clobbering the 'cancelling' row. After the fix the runner
// re-reads the live state and picks the correct terminal:
//   - cancelling          → enqueue cancelling→cancelled, write 'cancelled'
//   - active (no race)    → original failed-write behavior preserved
//   - already terminal    → no-op (don't overwrite hard-kill / boot-recovery)
describe('TaskRunner.processJob — F7 plugin-throw vs cancel race', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    // makeFakeClient does not respond to HGET. For F7 tests we need the
    // recovery path's HGET on task:run:active:<runId> 'state' to return a
    // controlled value, so build a fresh fake client that adds an HGET
    // handler on top of the standard HSET/PEXPIRE/INCR mirror.
    function makeClientWithStateResolver(
        getActive: (runId: string) => string | null,
        getTerminal: (runId: string) => string | null = () => null,
    ): FakeClient {
        const hsets: FakeClient['_hsets'] = [];
        const pexpires: FakeClient['_pexpires'] = [];
        const customCommand = vi.fn(async (cmd: string[]): Promise<unknown> => {
            const op = cmd[0]?.toUpperCase();
            switch (op) {
                case 'HSET': {
                    const key = cmd[1];
                    const fields: Record<string, string> = {};
                    for (let i = 2; i + 1 < cmd.length; i += 2) {
                        fields[cmd[i]] = cmd[i + 1];
                    }
                    hsets.push({ key, fields });
                    return Math.floor((cmd.length - 2) / 2);
                }
                case 'PEXPIRE':
                    pexpires.push({ key: cmd[1], ttl: Number(cmd[2]) });
                    return 1;
                case 'HGET': {
                    const key = cmd[1];
                    const field = cmd[2];
                    if (field !== 'state') return null;
                    const activePrefix = 'task:run:active:';
                    const terminalPrefix = 'task:run:terminal:';
                    if (key.startsWith(activePrefix)) {
                        return getActive(key.slice(activePrefix.length));
                    }
                    if (key.startsWith(terminalPrefix)) {
                        return getTerminal(key.slice(terminalPrefix.length));
                    }
                    return null;
                }
                default:
                    return null;
            }
        });
        return { customCommand, _hsets: hsets, _pexpires: pexpires };
    }

    it('plugin throw + state=cancelling → runner enqueues cancelling→cancelled (not active→failed terminal)', async () => {
        const client = makeClientWithStateResolver((runId) =>
            runId === 'run_f7_cancel' ? 'cancelling' : null,
        );
        const { runner, stateMachine, callProcessor } = await bootRunner({
            client,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new Error('coincidental throw');
                    },
                },
            ],
        });

        // First transitionRun call (active→failed) rejects with state-mismatch
        // because the cancel pubsub landed first. Subsequent calls succeed.
        stateMachine.transitionRun.mockImplementation(
            async (opts: { from: string; to: string }) => {
                if (opts.from === 'active' && opts.to === 'failed') {
                    return {
                        ok: false,
                        error: 'state mismatch: expected active got cancelling',
                    };
                }
                return { ok: true };
            },
        );

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_f7_cancel' })),
        ).rejects.toThrow('coincidental throw');

        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        // active→failed must have been attempted (and rejected), then the
        // runner must enqueue cancelling→cancelled as the recovery transition.
        expect(transitions).toContain('active->failed');
        expect(transitions).toContain('cancelling->cancelled');

        // Verify cancelling→cancelled carries the cancelledAt extra (not
        // failedAt/errorKind) so the recovery path looks like a real cancel.
        const cancelCall = stateMachine.transitionRun.mock.calls.find(
            ([opts]) => opts.from === 'cancelling' && opts.to === 'cancelled',
        );
        expect(cancelCall![0].extra).toMatchObject({
            errorMessage: 'coincidental throw',
            cancelledAt: expect.any(String),
        });
        expect(cancelCall![0].extra.failedAt).toBeUndefined();
        expect(cancelCall![0].extra.errorKind).toBeUndefined();

        await runner.stop();
    });

    it('plugin throw + state=active (no race) → normal active→failed (regression guard)', async () => {
        // Default makeFakeClient returns null for HGET. With current=null the
        // F7 recovery falls through to the original failed-write behavior.
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new Error('boom');
                    },
                },
            ],
        });

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_f7_normal' })),
        ).rejects.toThrow('boom');

        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        // Normal failure: active→failed succeeded → no recovery transition.
        expect(transitions).toContain('active->failed');
        expect(transitions).not.toContain('cancelling->cancelled');
        await runner.stop();
    });

    it('plugin throw + state=completed (idempotent terminal) → no clobber, no extra transition', async () => {
        const client = makeClientWithStateResolver(
            () => null,
            (runId) => (runId === 'run_f7_term' ? 'completed' : null),
        );
        const { runner, stateMachine, callProcessor } = await bootRunner({
            client,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new Error('late throw');
                    },
                },
            ],
        });

        // active→failed rejects; recovery sees state already terminal.
        stateMachine.transitionRun.mockImplementation(
            async (opts: { from: string; to: string }) => {
                if (opts.from === 'active' && opts.to === 'failed') {
                    return { ok: false, error: 'run not found' };
                }
                return { ok: true };
            },
        );

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_f7_term' })),
        ).rejects.toThrow('late throw');

        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        // No cancelling→cancelled because state was already terminal.
        expect(transitions).not.toContain('cancelling->cancelled');
        // No second active→failed retry — recovery exits on terminal state.
        const failedAttempts = transitions.filter((t) => t === 'active->failed').length;
        expect(failedAttempts).toBe(1);
        await runner.stop();
    });
});

describe('TaskRunner.processJob — task_history.error.stack persistence', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    /**
     * Pull the `error` JSONB value out of the terminal `UPDATE task_history`
     * write for the given target state. Parameter order in
     * writeTerminalToPostgres is [to, result, error, runId, to]; makeFakeSql's
     * `sql.json` is identity, so `error` arrives as the plain object.
     */
    function terminalErrorWrite(
        fakeSql: FakeSql,
        to: string,
    ): { message?: string; kind?: string; stack?: string; reason?: string } | null | undefined {
        const call = fakeSql.calls.find(
            (c) =>
                c.head.includes('UPDATE task_history') &&
                c.head.includes('SET state') &&
                c.values[0] === to,
        );
        return call?.values[2] as
            { message?: string; kind?: string; stack?: string; reason?: string } | null | undefined;
    }

    it('persists the thrown error stack on the abort/cancel terminal write', async () => {
        const fakeSql = makeFakeSql();
        const cancelHandlers = new Map<string, (msg: string) => void>();
        const subscribeImpl = async (channel: string, cb: (msg: string) => void) => {
            cancelHandlers.set(channel, cb);
            return async () => {
                cancelHandlers.delete(channel);
            };
        };

        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            subscribeImpl,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async (ctx) => {
                        cancelHandlers.get('task:cancel')!(
                            JSON.stringify({ runId: ctx.runId, reason: 'test' }),
                        );
                        await Promise.resolve();
                        throw new Error('aborted by test');
                    },
                },
            ],
        });

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_stack_cancel' })),
        ).rejects.toThrow('aborted by test');

        const written = terminalErrorWrite(fakeSql, 'cancelled');
        expect(written).toBeDefined();
        expect(written?.message).toBe('aborted by test');
        // The whole point: an operator opening this run must be able to see
        // WHERE it aborted, not just that it did.
        expect(written?.stack).toContain('aborted by test');
        expect(written?.stack).toContain('at ');
        await runner.stop();
    });

    it('persists the thrown error stack on the F7 cancelling→cancelled terminal write', async () => {
        const fakeSql = makeFakeSql();
        const hgetClient = {
            customCommand: vi.fn(async (cmd: string[]): Promise<unknown> => {
                if (cmd[0]?.toUpperCase() === 'HGET' && cmd[2] === 'state') {
                    return cmd[1] === 'task:run:active:run_stack_f7' ? 'cancelling' : null;
                }
                return null;
            }),
            _hsets: [],
            _pexpires: [],
        };

        const { runner, stateMachine, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            client: hgetClient,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new Error('coincidental throw');
                    },
                },
            ],
        });

        stateMachine.transitionRun.mockImplementation(
            async (opts: { from: string; to: string }) => {
                if (opts.from === 'active' && opts.to === 'failed') {
                    return { ok: false, error: 'state mismatch' };
                }
                return { ok: true };
            },
        );

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_stack_f7' })),
        ).rejects.toThrow('coincidental throw');

        const written = terminalErrorWrite(fakeSql, 'cancelled');
        expect(written?.message).toBe('coincidental throw');
        expect(written?.stack).toContain('coincidental throw');
        await runner.stop();
    });

    it('keeps writing the stack on the ordinary active→failed path (regression guard)', async () => {
        const fakeSql = makeFakeSql();
        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new Error('plain failure');
                    },
                },
            ],
        });

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_stack_failed' })),
        ).rejects.toThrow('plain failure');

        const written = terminalErrorWrite(fakeSql, 'failed');
        expect(written?.stack).toContain('plain failure');
        await runner.stop();
    });
});

describe('TaskRunner.processJob — heartbeat lifecycle', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('starts heartbeat on processJob and clears it on completion', async () => {
        const fakeClient = makeFakeClient();
        // Capture the heartbeats map size at the moment execute() is invoked,
        // then verify it's cleared after completion.
        let sizeDuringExecute = -1;
        const { runner, callProcessor } = await bootRunner({
            client: fakeClient,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        const internals = runner as unknown as {
                            heartbeats: Map<string, unknown>;
                        };
                        sizeDuringExecute = internals.heartbeats.size;
                        return { success: true };
                    },
                },
            ],
        });
        const internals = runner as unknown as {
            heartbeats: Map<string, unknown>;
        };
        expect(internals.heartbeats.size).toBe(0);
        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_hb' }));
        expect(sizeDuringExecute).toBe(1);
        expect(internals.heartbeats.size).toBe(0);
        await runner.stop();
    });

    it('clears heartbeat even when the plugin throws', async () => {
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new Error('blew up');
                    },
                },
            ],
        });
        const internals = runner as unknown as {
            heartbeats: Map<string, unknown>;
        };
        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_hbfail' })),
        ).rejects.toThrow('blew up');
        expect(internals.heartbeats.size).toBe(0);
        await runner.stop();
    });

    // F70 — `taskActiveRuns` gauge + abortController/cancelUnsub maps must not
    // leak when context construction / heartbeat setup throws AFTER the gauge
    // was incremented but BEFORE the main execute try/finally is entered. Before
    // the fix, buildContextWithCost + startHeartbeat sat above the try, so a
    // throw there skipped the finally dec → permanent gauge drift + leaked map
    // entries on every such failed attempt.
    it('balances the active-runs gauge + clears maps when post-inc setup throws (F70)', async () => {
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });

        const internals = runner as unknown as {
            heartbeats: Map<string, unknown>;
            abortControllers: Map<string, unknown>;
            cancelUnsubs: Map<string, unknown>;
            startHeartbeat: (runId: string, task: unknown) => void;
        };

        // Force a throw at startHeartbeat — the first statement that runs after
        // transitionToActive has already incremented the gauge and registered
        // the abortController/cancelUnsub for this run.
        const startSpy = vi.spyOn(internals, 'startHeartbeat').mockImplementation(() => {
            throw new Error('heartbeat setup blew up');
        });

        const before = await gaugeValue('basic-task', 'io');

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_f70' })),
        ).rejects.toThrow('heartbeat setup blew up');

        // The finally must have run: gauge balanced back to baseline, and no
        // leaked abortController / cancelUnsub / heartbeat entry for this run.
        expect(await gaugeValue('basic-task', 'io')).toBe(before);
        expect(internals.abortControllers.has('run_f70')).toBe(false);
        expect(internals.cancelUnsubs.has('run_f70')).toBe(false);
        expect(internals.heartbeats.has('run_f70')).toBe(false);

        startSpy.mockRestore();
        await runner.stop();
    });
});

describe('TaskRunner.processJob — cancellation', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('trips ctx.signal.aborted when a cancel for its runId fires', async () => {
        // The runner subscribes once to the shared `task:cancel` channel and
        // demuxes by the runId in the payload.
        const cancelHandlers = new Map<string, (msg: string) => void>();
        const unsubs: Array<() => Promise<void>> = [];
        const subscribeImpl = async (channel: string, cb: (msg: string) => void) => {
            cancelHandlers.set(channel, cb);
            const unsub = async () => {
                cancelHandlers.delete(channel);
            };
            unsubs.push(unsub);
            return unsub;
        };

        let observedAborted = false;
        const { runner, stateMachine, callProcessor } = await bootRunner({
            subscribeImpl,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async (ctx) => {
                        // Fire cancel mid-execution, then yield so the abort
                        // event reaches our flag.
                        const onAbort = () => {
                            observedAborted = ctx.signal.aborted;
                        };
                        ctx.signal.addEventListener('abort', onAbort);
                        const handler = cancelHandlers.get('task:cancel');
                        expect(handler).toBeDefined();
                        handler!(JSON.stringify({ runId: ctx.runId, reason: 'test' }));
                        // give microtasks a chance
                        await Promise.resolve();
                        ctx.signal.removeEventListener('abort', onAbort);
                        // Throw so the runner enters the cancelled branch.
                        throw new Error('aborted by test');
                    },
                },
            ],
        });

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_cancel' })),
        ).rejects.toThrow('aborted by test');

        expect(observedAborted).toBe(true);
        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).toContain('active->cancelled');
        await runner.stop();
    });
});

describe('TaskRunner.buildContext — capability gates', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('attaches http only when capabilities.http=true', async () => {
        let withHttp: TaskContext | null = null;
        let withoutHttp: TaskContext | null = null;
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'with-http',
                    capabilities: { http: true },
                    execute: async (ctx) => {
                        withHttp = ctx;
                        return { success: true };
                    },
                },
                {
                    id: 'without-http',
                    capabilities: {},
                    execute: async (ctx) => {
                        withoutHttp = ctx;
                        return { success: true };
                    },
                },
            ],
        });
        await callProcessor(makeJob({ name: 'with-http', runId: 'run_h1' }));
        await callProcessor(makeJob({ name: 'without-http', runId: 'run_h2' }));
        expect(withHttp!.http).toBeDefined();
        expect(withoutHttp!.http).toBeUndefined();
        await runner.stop();
    });

    it('provides ctx.softSignal as a distinct, initially-unaborted signal', async () => {
        let captured: TaskContext | null = null;
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'soft-sig',
                    capabilities: {},
                    execute: async (ctx) => {
                        captured = ctx;
                        return { success: true };
                    },
                },
            ],
        });
        await callProcessor(makeJob({ name: 'soft-sig', runId: 'run_soft1' }));
        // Present, an AbortSignal, not the cancellation signal, and not pre-aborted.
        expect(captured!.softSignal).toBeInstanceOf(AbortSignal);
        expect(captured!.softSignal).not.toBe(captured!.signal);
        expect(captured!.softSignal!.aborted).toBe(false);
        await runner.stop();
    });

    it('attaches cache only when capabilities.cache=true', async () => {
        let withCache: TaskContext | null = null;
        let withoutCache: TaskContext | null = null;
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'with-cache',
                    capabilities: { cache: true },
                    execute: async (ctx) => {
                        withCache = ctx;
                        return { success: true };
                    },
                },
                {
                    id: 'without-cache',
                    capabilities: {},
                    execute: async (ctx) => {
                        withoutCache = ctx;
                        return { success: true };
                    },
                },
            ],
        });
        await callProcessor(makeJob({ name: 'with-cache', runId: 'run_c1' }));
        await callProcessor(makeJob({ name: 'without-cache', runId: 'run_c2' }));
        expect(withCache!.cache).toBeDefined();
        expect(withoutCache!.cache).toBeUndefined();
        await runner.stop();
    });

    it('attaches dataDir + ffmpeg only when their capabilities are set', async () => {
        let captured: TaskContext | null = null;
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'with-everything',
                    capabilities: { ffmpeg: true, dataDir: true },
                    execute: async (ctx) => {
                        captured = ctx;
                        return { success: true };
                    },
                },
            ],
        });
        await callProcessor(makeJob({ name: 'with-everything', runId: 'run_d1' }));
        // `ffmpeg` and `dataDir` are deliberately NOT on the context: both were
        // stubs that failed on first use, so declaring the capability no longer
        // hands the task a member that cannot work. The flags remain a
        // disclosure of what the task does.
        expect((captured as unknown as Record<string, unknown>).ffmpeg).toBeUndefined();
        expect((captured as unknown as Record<string, unknown>).dataDir).toBeUndefined();
        await runner.stop();
    });

    it('secrets.get returns a value when the store resolves (Task L wired)', async () => {
        const fakeSql = makeFakeSql();
        // Seed a response: secrets store will look for 'SELECT value_encrypted'
        // in the query template. Since fakeSql returns [] by default it will
        // throw "not found" — that is the correct behavior for a missing key.
        let captured: TaskContext | null = null;
        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async (ctx) => {
                        captured = ctx;
                        return { success: true };
                    },
                },
            ],
        });
        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_s1' }));
        // With no matching DB row the store throws a descriptive "not found" error.
        await expect(captured!.secrets.get('TMDB_API_KEY')).rejects.toThrow(
            'Plugin secret not found',
        );
        await runner.stop();
    });

    it('dep() returns a RateLimitedFetch with a fetch method (Task L wired)', async () => {
        let captured: TaskContext | null = null;
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'basic-task',
                    execute: async (ctx) => {
                        captured = ctx;
                        return { success: true };
                    },
                },
            ],
        });
        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_d1' }));
        const dep = captured!.dep('tmdb');
        expect(typeof dep.fetch).toBe('function');
        // name is attached as a non-enumerable diagnostic property.
        const nameDesc = Object.getOwnPropertyDescriptor(dep, 'name');
        expect(nameDesc?.value).toBe('tmdb');
        await runner.stop();
    });
});

describe('TaskRunner.processJob — downstream trampoline', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('marks parent completed after enqueuing children', async () => {
        const enqueueCalls: Array<{
            taskId: string;
            runId: string;
            parentRunId: string;
        }> = [];
        const fakeQueue = {
            add: vi.fn(async (name: string, data: { runId: string; parentRunId: string }) => {
                enqueueCalls.push({
                    taskId: name,
                    runId: data.runId,
                    parentRunId: data.parentRunId,
                });
                return { id: data.runId };
            }),
        };

        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [
                { id: 'child', execute: async () => ({ success: true }) },
                {
                    id: 'parent',
                    execute: async () => ({
                        success: true,
                        downstream: [{ taskId: 'child', input: { a: 1 } }],
                    }),
                },
            ],
            // Inject queue factory so the runner enqueues children to our fake.
            queueFactory: () => fakeQueue as unknown as BullQueue,
        });

        await callProcessor(makeJob({ name: 'parent', runId: 'run_parent' }));

        // Parent must be completed.
        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).toContain('active->completed');

        // Child must have been enqueued.
        expect(enqueueCalls).toHaveLength(1);
        expect(enqueueCalls[0].taskId).toBe('child');
        expect(enqueueCalls[0].parentRunId).toBe('run_parent');
        expect(enqueueCalls[0].runId).toMatch(/^run_/);

        await runner.stop();
    });

    it('skips unknown downstream task and still completes parent', async () => {
        const enqueueCalls: string[] = [];
        const fakeQueue = {
            add: vi.fn(async (name: string) => {
                enqueueCalls.push(name);
                return { id: 'x' };
            }),
        };

        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'parent',
                    execute: async () => ({
                        success: true,
                        downstream: [{ taskId: 'not-registered', input: {} }],
                    }),
                },
            ],
            queueFactory: () => fakeQueue as unknown as BullQueue,
        });

        await callProcessor(makeJob({ name: 'parent', runId: 'run_p2' }));

        // Parent completes; no enqueue for the unknown child.
        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).toContain('active->completed');
        expect(enqueueCalls).toHaveLength(0);

        await runner.stop();
    });

    it('enqueues child with parentRunId linkage when sql is available', async () => {
        const fakeSql = makeFakeSql();
        const enqueueCalls: Array<{
            name: string;
            data: Record<string, unknown>;
        }> = [];
        const fakeQueue = {
            add: vi.fn(async (name: string, data: Record<string, unknown>) => {
                enqueueCalls.push({ name, data });
                return { id: 'x' };
            }),
        };

        const { runner, callProcessor } = await bootRunner({
            tasks: [
                { id: 'child-task', execute: async () => ({ success: true }) },
                {
                    id: 'parent-task',
                    execute: async () => ({
                        success: true,
                        downstream: [{ taskId: 'child-task', input: { x: 99 } }],
                    }),
                },
            ],
            sql: fakeSql.sql,
            queueFactory: () => fakeQueue as unknown as BullQueue,
        });

        await callProcessor(makeJob({ name: 'parent-task', runId: 'run_p3' }));

        // child enqueued with parent_run_id
        expect(enqueueCalls).toHaveLength(1);
        expect(enqueueCalls[0].name).toBe('child-task');
        expect(enqueueCalls[0].data.parentRunId).toBe('run_p3');

        // task_history INSERT attempted for the child
        const insertCalls = fakeSql.calls.filter((c) =>
            c.head.includes('INSERT INTO task_history'),
        );
        expect(insertCalls.length).toBeGreaterThan(0);

        await runner.stop();
    });

    // F5 regression — downstream-trampoline jobId encoding.
    //
    // Before this fix, handleDownstream invoked `queue.add(taskId, data)` with
    // NO opts arg. BullMQ would assign a generated numeric jobId. After
    // removeOnComplete reaped the job, QueueEvents fired with that numeric
    // jobId; `runIdFromJobId` couldn't decode it; `flushTransitions` fell
    // through to `queue.getJob(jobId)` → null → transition silently dropped.
    // Child sat 'active' until the 5-minute reconciler sweep.
    //
    // The fix encodes `<taskId>::down#<childRunId>` in opts.jobId so the
    // QueueEvents-side decoder recovers the runId without any queue probe.
    it('F5: queue.add receives an opts.jobId encoded with the childRunId suffix', async () => {
        type AddArgs = [string, Record<string, unknown>, { jobId?: string } | undefined];
        const addCalls: AddArgs[] = [];
        const fakeQueue = {
            add: vi.fn(
                async (name: string, data: Record<string, unknown>, opts?: { jobId?: string }) => {
                    addCalls.push([name, data, opts]);
                    return { id: opts?.jobId ?? 'generated-numeric-id' };
                },
            ),
        };

        const { runner, callProcessor } = await bootRunner({
            tasks: [
                { id: 'child-f5', execute: async () => ({ success: true }) },
                {
                    id: 'parent-f5',
                    execute: async () => ({
                        success: true,
                        downstream: [{ taskId: 'child-f5', input: { z: 1 } }],
                    }),
                },
            ],
            queueFactory: () => fakeQueue as unknown as BullQueue,
        });

        await callProcessor(makeJob({ name: 'parent-f5', runId: 'run_parent_f5' }));

        // Exactly one downstream enqueue.
        expect(addCalls).toHaveLength(1);
        const [name, data, opts] = addCalls[0];
        expect(name).toBe('child-f5');

        // opts.jobId must be present and shaped as `<taskId>~~down#<childRunId>`.
        // (Switched from `::` after BullMQ 5.71 rejected colon-containing
        // custom IDs — see commit 46e931899.)
        expect(opts).toBeDefined();
        expect(opts?.jobId).toBeDefined();
        const jobId = opts!.jobId!;
        expect(jobId).toMatch(/^child-f5~~down#run_/);

        // The childRunId in the encoded jobId must match the runId in job.data.
        const childRunId = data.runId as string;
        expect(childRunId).toMatch(/^run_/);
        expect(jobId.endsWith(`#${childRunId}`)).toBe(true);
        expect(jobId).toBe(`child-f5~~down#${childRunId}`);

        // Mirror the orchestrator's runIdFromJobId decoder (suffix splitter):
        // QueueEvents handlers MUST be able to recover the runId from the
        // jobId alone — no queue.getJob probe. This is the load-bearing
        // guarantee for survival after BullMQ reaps the job.
        const decode = (jid: string | undefined): string | null => {
            if (!jid) return null;
            const hashIdx = jid.lastIndexOf('#');
            if (hashIdx > 0) {
                const candidate = jid.slice(hashIdx + 1);
                if (candidate.startsWith('run_')) return candidate;
            }
            return null;
        };
        expect(decode(jobId)).toBe(childRunId);

        await runner.stop();
    });

    it('F5: encoded jobId survives BullMQ reap — decoder yields childRunId without queue.getJob probe', async () => {
        // Simulate the post-reap scenario: queue.getJob returns null. The
        // QueueEvents-side decode path must NOT need it — the encoded jobId
        // alone carries the runId.
        type AddArgs = [string, Record<string, unknown>, { jobId?: string } | undefined];
        const addCalls: AddArgs[] = [];
        const getJobMock = vi.fn(async () => null);
        const fakeQueue = {
            add: vi.fn(
                async (name: string, data: Record<string, unknown>, opts?: { jobId?: string }) => {
                    addCalls.push([name, data, opts]);
                    return { id: opts?.jobId ?? 'generated' };
                },
            ),
            // After reap, BullMQ's getJob returns null for the jobId. This is
            // exactly the path the F5 bug exploited. The fix means we never
            // need to call this on the QueueEvents side.
            getJob: getJobMock,
        };

        const { runner, callProcessor } = await bootRunner({
            tasks: [
                { id: 'child-reap', execute: async () => ({ success: true }) },
                {
                    id: 'parent-reap',
                    execute: async () => ({
                        success: true,
                        downstream: [{ taskId: 'child-reap', input: {} }],
                    }),
                },
            ],
            queueFactory: () => fakeQueue as unknown as BullQueue,
        });

        await callProcessor(makeJob({ name: 'parent-reap', runId: 'run_parent_reap' }));

        expect(addCalls).toHaveLength(1);
        const [, data, opts] = addCalls[0];
        const jobId = opts!.jobId!;
        const childRunId = data.runId as string;

        // Decoder path (matches orchestrator.runIdFromJobId and
        // flushTransitions suffix logic) succeeds purely on the jobId string,
        // with no queue probe.
        const hashIdx = jobId.lastIndexOf('#');
        expect(hashIdx).toBeGreaterThan(0);
        const decoded = jobId.slice(hashIdx + 1);
        expect(decoded).toBe(childRunId);
        expect(decoded.startsWith('run_')).toBe(true);

        // Crucially, even though getJob is wired and would return null after
        // reap, the decoder never had to consult it. Pre-fix, the numeric
        // jobId would have forced a probe → null → dropped transition.
        expect(getJobMock).not.toHaveBeenCalled();

        await runner.stop();
    });
});

describe('TaskRunner.processJob — retry reseed', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('calls reseedForRetry when attemptsMade > 0', async () => {
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });

        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_retry', attemptsMade: 1 }));

        expect(stateMachine.reseedForRetry).toHaveBeenCalledWith('run_retry', {
            lockKey: 'bull:task:io:job_run_retry:lock',
            token: 'token',
        });
        await runner.stop();
    });

    it('calls reseedForRetry on first attempt (always-reseed path, 2026-05-xx)', async () => {
        // Production removed the attemptsMade > 0 gate — reseedForRetry is now
        // called unconditionally so fresh runs whose Valkey hash TTL-expired
        // before pick-up (e.g. cpu=1 backlog) are also re-seeded and claimed.
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });

        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_first', attemptsMade: 0 }));

        expect(stateMachine.reseedForRetry).toHaveBeenCalledWith('run_first');
        await runner.stop();
    });

    // F6 — retry sequence with previously-DEL'd active hash (the normal
    // active→failed terminal-DEL case). Verifies the end-to-end ordering
    // expected on retry: reseed runs BEFORE claim, and after reseed the
    // claim succeeds (defaulting to expectedState='pending').
    it('reseeds then claims on retry — reseed precedes claimRun call', async () => {
        const callOrder: string[] = [];
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });
        stateMachine.reseedForRetry.mockImplementation(async () => {
            callOrder.push('reseed');
            return 'reseeded';
        });
        stateMachine.claimRun.mockImplementation(async () => {
            callOrder.push('claim');
            return { ok: true };
        });

        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_seq', attemptsMade: 2 }));

        // Ordering invariant — reseed MUST land before claim, otherwise
        // claim-run.lua would reject because state='failed' or missing.
        expect(callOrder).toEqual(['reseed', 'claim']);
        // ctx.attemptNumber is 1-indexed; attemptsMade=2 → attempt 3.
        expect(stateMachine.claimRun).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: 'run_seq',
                expectedState: 'pending',
            }),
        );
        await runner.stop();
    });

    // F6 — cancel-arrives-between-attempts. reseedForRetry returns 'skipped'
    // when the active hash is in 'cancelling' state. Runner MUST short-circuit:
    // do NOT call claimRun, do NOT execute the plugin, throw permanent so
    // BullMQ stops retrying.
    it("'skipped' reseed result → runner throws permanent, no claim, no execute", async () => {
        const executeSpy = vi.fn(async () => ({ success: true }));
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: executeSpy }],
        });
        stateMachine.reseedForRetry.mockResolvedValueOnce('skipped');

        await expect(
            callProcessor(
                makeJob({
                    name: 'basic-task',
                    runId: 'run_cancelled_mid',
                    attemptsMade: 1,
                }),
            ),
        ).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'permanent',
            message: expect.stringContaining('cancelling'),
        });

        // No claim attempted.
        expect(stateMachine.claimRun).not.toHaveBeenCalled();
        // Plugin must NOT have run.
        expect(executeSpy).not.toHaveBeenCalled();
        await runner.stop();
    });

    // F6 — reseedForRetry throwing must not crash the runner. The catch
    // block falls through to claimRun, which will likely fail with
    // 'run not found' — that's a transient throw → BullMQ retries again.
    // What we test here is the graceful-degradation property: the runner
    // doesn't blow up with an uncaught exception.
    it('swallows reseedForRetry errors and continues to claim', async () => {
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });
        stateMachine.reseedForRetry.mockRejectedValueOnce(new Error('valkey blip'));
        // After reseed throws, claimRun is still called — if it succeeds
        // (which our mock does by default), execution proceeds.

        await callProcessor(
            makeJob({
                name: 'basic-task',
                runId: 'run_reseed_blip',
                attemptsMade: 1,
            }),
        );

        expect(stateMachine.reseedForRetry).toHaveBeenCalledTimes(1);
        expect(stateMachine.claimRun).toHaveBeenCalledTimes(1);
        await runner.stop();
    });
});

// Extend TaskFactoryOpts to support quotas for maxConcurrent tests.
interface TaskFactoryWithQuotas extends TaskFactoryOpts {
    quotas?: { maxConcurrent?: number };
}

function makeRegistryWithQuotas(tasks: TaskFactoryWithQuotas[]): TaskRegistry {
    const reg = new TaskRegistry();
    for (const t of tasks) {
        reg.registerTask(
            defineTask({
                id: t.id ?? 'basic-task',
                name: 'Test',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: t.capabilities ?? {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'one',
                retry: t.retryOn
                    ? {
                          attempts: 1,
                          backoff: 'exponential',
                          retryOn: t.retryOn,
                      }
                    : undefined,
                quotas: t.quotas,
                execute: t.execute,
            }),
        );
    }
    return reg;
}

describe('TaskRunner.processJob — maxConcurrent quota', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('acquires the counter before execute (atomic Lua) and decrements in finally', async () => {
        const fakeClient = makeFakeClient();
        const incrDecr: string[] = [];
        // The per-task counter now acquires via the atomic ACQUIRE_LUA (EVAL),
        // not a raw INCR. EVAL returns the post-INCR count (1, within limit=2);
        // the terminal cleanup DECRs.
        fakeClient.customCommand.mockImplementation(async (cmd: string[]) => {
            const op = cmd[0]?.toUpperCase();
            if (op === 'EVAL') {
                incrDecr.push('ACQUIRE');
                return 1;
            }
            if (op === 'DECR') {
                incrDecr.push('DECR');
                return 0;
            }
            if (op === 'HSET') return 1;
            if (op === 'PEXPIRE') return 1;
            if (op === 'EXPIRE') return 1;
            return null;
        });

        const registry = makeRegistryWithQuotas([
            {
                id: 'quota-task',
                quotas: { maxConcurrent: 2 },
                execute: async () => ({ success: true }),
            },
        ]);
        const fakeWorker = makeFakeWorker();
        const stateMachineObj = makeStateMachine();
        let captured: Processor | null = null;

        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachineObj.sm,
            getSql: () => null,
            getClient: () =>
                fakeClient as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            // Return a non-null unsub so subscribeToCancel doesn't enter the
            // retry loop (which would delay 8.75s before giving up).
            subscribe: async () => async () => {},
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        });

        await (captured! as Processor)(
            makeJob({ name: 'quota-task', runId: 'run_quota' }),
            'token',
        );

        expect(incrDecr).toContain('ACQUIRE');
        expect(incrDecr).toContain('DECR');
        await runner.stop();
    });

    it('throws transient when maxConcurrent limit is exceeded', async () => {
        const fakeClient = makeFakeClient();
        const decrements: string[] = [];
        fakeClient.customCommand.mockImplementation(async (cmd: string[]) => {
            const op = cmd[0]?.toUpperCase();
            // Atomic ACQUIRE_LUA returns -1 at capacity WITHOUT incrementing —
            // so, unlike the old INCR-to-5-then-DECR path, there is no
            // reject-side DECR to roll back.
            if (op === 'EVAL') return -1; // at cap (limit=2)
            if (op === 'DECR') {
                decrements.push('DECR');
                return 4;
            }
            if (op === 'HSET') return 1;
            if (op === 'PEXPIRE') return 1;
            if (op === 'EXPIRE') return 1;
            return null;
        });

        const registry = makeRegistryWithQuotas([
            {
                id: 'quota-task',
                quotas: { maxConcurrent: 2 },
                execute: async () => ({ success: true }),
            },
        ]);
        const fakeWorker = makeFakeWorker();
        const stateMachineObj = makeStateMachine();
        let captured: Processor | null = null;

        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachineObj.sm,
            getSql: () => null,
            getClient: () =>
                fakeClient as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => null,
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        });

        await expect(
            (captured! as Processor)(makeJob({ name: 'quota-task', runId: 'run_over' }), 'token'),
        ).rejects.toMatchObject({
            kind: 'transient',
            message: expect.stringContaining('maxConcurrent'),
        });

        // The atomic Lua never incremented at cap, so NO reject-side DECR is
        // issued — the over-limit slot was never taken to begin with.
        expect(decrements).toHaveLength(0);
        await runner.stop();
    });

    it('Critical-1: swallows DECR errors on terminal cleanup — run still completes', async () => {
        // Scenario: ACQUIRE (EVAL) succeeds, execute succeeds, but the
        // in-finally DECR throws (Valkey disconnect or hiccup). Previously this
        // propagated and corrupted the terminal cleanup (counter leaks AND
        // BullMQ never sees the job complete). With the fix the DECR error is
        // logged but swallowed, so the run still completes normally.
        const fakeClient = makeFakeClient();
        let decrAttempts = 0;
        fakeClient.customCommand.mockImplementation(async (cmd: string[]) => {
            const op = cmd[0]?.toUpperCase();
            if (op === 'EVAL') return 1;
            if (op === 'DECR') {
                decrAttempts++;
                throw new Error('Valkey disconnected');
            }
            if (op === 'HSET') return 1;
            if (op === 'PEXPIRE') return 1;
            if (op === 'EXPIRE') return 1;
            return null;
        });

        const registry = makeRegistryWithQuotas([
            {
                id: 'quota-task-decr-throw',
                quotas: { maxConcurrent: 2 },
                execute: async () => ({ success: true, itemsProcessed: 7 }),
            },
        ]);
        const fakeWorker = makeFakeWorker();
        const stateMachineObj = makeStateMachine();
        let captured: Processor | null = null;

        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachineObj.sm,
            getSql: () => null,
            getClient: () =>
                fakeClient as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => async () => {},
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        });

        // Must NOT throw — terminal cleanup swallows the DECR error.
        const result = await (captured! as Processor)(
            makeJob({ name: 'quota-task-decr-throw', runId: 'run_decr_throw' }),
            'token',
        );
        expect(result).toEqual({ success: true, itemsProcessed: 7 });

        // DECR was attempted (in releaseConcurrent) but the throw was swallowed.
        expect(decrAttempts).toBeGreaterThanOrEqual(1);

        // Terminal transition still landed despite the DECR failure.
        const transitions = stateMachineObj.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).toContain('active->completed');

        await runner.stop();
    });
});

describe('classifyError', () => {
    const baseTask = defineTask({
        id: 'classify-test',
        name: 'X',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.unknown(),
        identityFor: () => 'one',
        execute: async () => ({ success: true }),
    });

    it('returns the kind on TaskError instances', () => {
        const e = new TaskError({ message: 'x', kind: 'transient' });
        expect(classifyError(e, baseTask)).toBe('transient');
    });

    it('returns transient when task.retry.retryOn returns true', () => {
        const t = {
            ...baseTask,
            retry: { attempts: 1, backoff: 'exponential', retryOn: () => true },
        } as typeof baseTask;
        expect(classifyError(new Error('boom'), t)).toBe('transient');
    });

    it.each(['40P01', '40001'])('classifies postgres error code %s as transient', (code) => {
        const e = Object.assign(new Error('deadlock detected'), {
            name: 'PostgresError',
            code,
        });
        expect(classifyError(e, baseTask)).toBe('transient');
        const wrapped = new Error('wrapped', { cause: e });
        expect(classifyError(wrapped, baseTask)).toBe('transient');
    });

    it('keeps other postgres errors permanent', () => {
        const e = Object.assign(new Error('unique'), { name: 'PostgresError', code: '23505' });
        expect(classifyError(e, baseTask)).toBe('permanent');
    });

    it('returns permanent when no rules match', () => {
        expect(classifyError(new Error('boom'), baseTask)).toBe('permanent');
    });

    it('returns permanent when retryOn throws', () => {
        const t = {
            ...baseTask,
            retry: {
                attempts: 1,
                backoff: 'exponential',
                retryOn: () => {
                    throw new Error('predicate failed');
                },
            },
        } as typeof baseTask;
        expect(classifyError(new Error('boom'), t)).toBe('permanent');
    });

    it.each([
        'write CONNECTION_CLOSED postgres:5432',
        'ENOSPC: no space left on device',
        'Connection is closed.',
        'Connection lost',
        'getaddrinfo ENOTFOUND valkey',
        'getaddrinfo EAI_AGAIN valkey',
    ])('requires opt-in for dependency interruption: %s', (message) => {
        expect(classifyError(new Error(message), baseTask)).toBe('permanent');
        expect(
            classifyError(new Error(message), {
                ...baseTask,
                retry: { attempts: 3, backoff: [30_000], retryOn: classifyMediaInfraError },
            }),
        ).toBe('transient');
    });

    it('does not classify FFmpeg stderr through the global network fallback', () => {
        const stderr = "Input #0, from '/ECONNREFUSED.mkv': invalid data";
        const err = Object.assign(new Error(stderr), { stderr, exitCode: 1 });
        expect(classifyError(err, baseTask)).toBe('permanent');
        expect(
            classifyError(err, {
                ...baseTask,
                retry: { attempts: 3, backoff: [30_000], retryOn: classifyMediaInfraError },
            }),
        ).toBe('permanent');
    });

    // ── Built-in infrastructure-transient classifications ──────────────────
    it('treats valkey-glide "Reached maximum inflight requests" as transient', () => {
        expect(classifyError(new Error('Reached maximum inflight requests'), baseTask)).toBe(
            'transient',
        );
    });

    it('treats Node connection errors as transient (ECONNRESET / ECONNREFUSED / EPIPE / ETIMEDOUT)', () => {
        for (const code of ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']) {
            expect(classifyError(new Error(`connect ${code} 1.2.3.4:5432`), baseTask)).toBe(
                'transient',
            );
        }
    });

    it('treats a postgres.js CONNECT_TIMEOUT as transient (not permanent)', () => {
        // A brief pool-saturation / DB-busy blip raised this and was wrongly
        // classified permanent → dead-lettered the item at attempt 0.
        expect(classifyError(new Error('write CONNECT_TIMEOUT ai-postgres:5432'), baseTask)).toBe(
            'transient',
        );
    });

    it('treats outbound "fetch failed for <url>" network errors as transient', () => {
        expect(
            classifyError(
                new Error(
                    'fetch failed for https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json: fetch failed',
                ),
                baseTask,
            ),
        ).toBe('transient');
        // bare undici TypeError message, and a DNS cause via the wrapper
        expect(classifyError(new Error('fetch failed'), baseTask)).toBe('transient');
        expect(
            classifyError(
                new Error(
                    'fetch failed for https://api.example.com/x: getaddrinfo EAI_AGAIN api.example.com',
                ),
                baseTask,
            ),
        ).toBe('transient');
    });

    it('keeps HTTP-status "… fetch failed: 404" permanent (not network-level)', () => {
        // Status errors are thrown by the task after a successful fetch and
        // don't carry the start-anchored network wrapper — must stay permanent.
        expect(classifyError(new Error('Fribb fetch failed: 404 Not Found'), baseTask)).toBe(
            'permanent',
        );
        expect(classifyError(new Error('TMDB API request failed: 404 Not Found'), baseTask)).toBe(
            'permanent',
        );
    });

    it('does NOT match arbitrary "connection" wording (avoid overmatch)', () => {
        // Narrowness check: a plugin throwing a vaguely-connection-shaped
        // message without an actual errno code stays classified permanent.
        expect(classifyError(new Error('The user has no connection to the gym'), baseTask)).toBe(
            'permanent',
        );
    });

    // ── Provider rate limiting (the documented AMBER case) ─────────────────
    it('treats provider rate limiting as transient, even with no retryOn', () => {
        // classifyInfraError (the shared retryOn ~25 builtin tasks pass) covers
        // 5xx but not 429, and a false retryOn falls through to the built-in
        // set — so before this these landed `permanent`, i.e. failed_permanent
        // with retryable:false on the FIRST attempt, in the "gave up / needs
        // re-identification" bucket.
        for (const msg of [
            'mdblist rate limit exceeded (HTTP 429)',
            'TMDB API request failed: 429 Too Many Requests',
            'MAL request failed status=429',
            'MDBList rate-limit cool-down active (free-tier quota) — will retry in 42s',
        ]) {
            expect(classifyError(new Error(msg), baseTask)).toBe('transient');
        }
    });

    it('still classifies a rate-limited run permanent when the task says so', () => {
        // Precedence check: an explicit TaskError kind wins over the built-in
        // rate-limit rule, so a task that knows better is never overridden.
        const e = new TaskError({ message: 'rate limit reached', kind: 'permanent' });
        expect(classifyError(e, baseTask)).toBe('permanent');
    });

    it('does NOT treat a bare 429 as a rate limit', () => {
        // `/anime/429` is a real MyAnimeList id, and EDQUOT is genuinely
        // operator-actionable — retrying either forever would hide a real fault.
        expect(classifyError(new Error('MAL lookup failed for /anime/429'), baseTask)).toBe(
            'permanent',
        );
    });
});

describe('TaskRunner.stop', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function gate(): { promise: Promise<void>; resolve: () => void } {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
            resolve = done;
        });
        return { promise, resolve };
    }

    async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                promise,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1500);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    it.each([false, true])('worker close failure is strict=%s', async (strict) => {
        const failure = new Error('worker connection did not close');
        const { runner, fakeWorker } = await bootRunner({
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });
        const close = vi.spyOn(fakeWorker, 'close').mockRejectedValueOnce(failure);
        try {
            if (strict) {
                await expect(
                    bounded(runner.stop({ strict: true }), 'strict stop'),
                ).rejects.toMatchObject({
                    name: 'AggregateError',
                    errors: [failure],
                });
            } else {
                await expect(bounded(runner.stop(), 'ordinary stop')).resolves.toBeUndefined();
            }
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            close.mockRestore();
            await bounded(runner.stop(), 'close-failure cleanup');
        }
    });

    it('retries a failed worker close on every strict stop and only succeeds after release', async () => {
        const { runner, fakeWorker } = await bootRunner({ tasks: [] });
        const failure = new Error('worker still owns its connection');
        const close = vi.spyOn(fakeWorker, 'close').mockRejectedValue(failure);
        try {
            for (let attempt = 0; attempt < 2; attempt++)
                await expect(runner.stop({ strict: true })).rejects.toMatchObject({
                    errors: [failure],
                });
            expect(close).toHaveBeenCalledTimes(2);
            close.mockResolvedValue(undefined);
            await runner.stop({ strict: true });
            expect(close).toHaveBeenCalledTimes(3);
            await runner.stop({ strict: true });
            expect(close).toHaveBeenCalledTimes(3);
        } finally {
            close.mockRestore();
            await runner.stop({ strict: true });
        }
    });

    it('shares overlapping stops while retaining a failed singleton for a later retry', async () => {
        const { runner, fakeWorker } = await bootRunner({ tasks: [] });
        const closeEntered = gate();
        const releaseClose = gate();
        const failure = new Error('singleton worker close failed');
        const close = vi.spyOn(fakeWorker, 'close').mockImplementation(async () => {
            closeEntered.resolve();
            await releaseClose.promise;
            throw failure;
        });
        const start = vi.spyOn(TaskRunner, 'start').mockResolvedValue(runner);
        try {
            expect(await startTaskRunner(['io'])).toBe(runner);
            const first = stopTaskRunner({ strict: true });
            const firstRejected = expect(first).rejects.toMatchObject({ errors: [failure] });
            await bounded(closeEntered.promise, 'singleton worker close entered');
            expect(getTaskRunner()).toBeNull();
            await expect(startTaskRunner(['io'])).rejects.toThrow('shut down');
            await expect(runner.ensureWorkersForRegisteredTasks()).rejects.toThrow('shut down');
            const second = stopTaskRunner({ strict: true });
            const secondRejected = expect(second).rejects.toMatchObject({ errors: [failure] });
            expect(close).toHaveBeenCalledTimes(1);
            releaseClose.resolve();
            await firstRejected;
            await secondRejected;
            expect(getTaskRunner()).toBeNull();
            await expect(startTaskRunner(['io'])).rejects.toThrow('shut down');
            await expect(runner.ensureWorkersForRegisteredTasks()).rejects.toThrow('shut down');
            expect(start).toHaveBeenCalledTimes(1);
            await expect(stopTaskRunner({ strict: true })).rejects.toMatchObject({
                errors: [failure],
            });
            expect(close).toHaveBeenCalledTimes(2);
            close.mockResolvedValue(undefined);
            await stopTaskRunner({ strict: true });
            expect(getTaskRunner()).toBeNull();
        } finally {
            releaseClose.resolve();
            close.mockRestore();
            await stopTaskRunner({ strict: true });
            start.mockRestore();
            await runner.stop({ strict: true });
        }
    });

    it('retains a tolerant failed singleton close for a later strict retry', async () => {
        const { runner, fakeWorker } = await bootRunner({ tasks: [] });
        const failure = new Error('tolerant close left worker open');
        const close = vi.spyOn(fakeWorker, 'close').mockRejectedValue(failure);
        const start = vi.spyOn(TaskRunner, 'start').mockResolvedValue(runner);
        try {
            expect(await startTaskRunner(['io'])).toBe(runner);
            await expect(stopTaskRunner()).resolves.toBeUndefined();
            expect(runner.isShutdownCleanupComplete()).toBe(false);
            expect(getTaskRunner()).toBeNull();
            await expect(startTaskRunner(['io'])).rejects.toThrow('shut down');
            await expect(stopTaskRunner({ strict: true })).rejects.toMatchObject({
                errors: [failure],
            });
            expect(close).toHaveBeenCalledTimes(2);
            expect(start).toHaveBeenCalledTimes(1);
            close.mockResolvedValue(undefined);
            await stopTaskRunner({ strict: true });
            expect(runner.isShutdownCleanupComplete()).toBe(true);
            await stopTaskRunner({ strict: true });
            expect(close).toHaveBeenCalledTimes(3);
        } finally {
            close.mockResolvedValue(undefined);
            await stopTaskRunner({ strict: true });
            close.mockRestore();
            start.mockRestore();
            await runner.stop({ strict: true });
        }
    });

    it('reaps a hotloaded worker whose factory races shutdown and refuses remaining registrations', async () => {
        const registry = makeRegistry([]);
        const worker = makeFakeWorker();
        const close = vi.spyOn(worker, 'close');
        let stopping: Promise<void> | undefined;
        const factory = vi.fn(() => {
            // Stop before the factory hands ownership back to registration.
            // Teardown must wait until that worker has reached its owned map.
            stopping = runner.stop({ strict: true });
            return worker;
        });
        const runner = await TaskRunner.start([], {
            registry,
            stateMachine: makeStateMachine().sm,
            getSql: () => null,
            getClient: () => makeFakeClient(),
            subscribe: async () => null,
            perTaskQueues: true,
            concurrencyFor: () => 1,
            workerFactory: factory,
        });
        for (const task of makeRegistry([
            { id: 'hotload-first', execute: async () => ({ success: true }) },
            { id: 'hotload-second', execute: async () => ({ success: true }) },
        ]).getAllTasks())
            registry.registerTask(task);
        try {
            await expect(runner.ensureWorkersForRegisteredTasks()).rejects.toThrow('shut down');
            expect(stopping).toBeDefined();
            await bounded(stopping!, 'racing hotload teardown');
            expect(factory).toHaveBeenCalledTimes(1);
            expect(close).toHaveBeenCalledTimes(1);
            await expect(runner.ensureWorkersForRegisteredTasks()).rejects.toThrow('shut down');
            expect(factory).toHaveBeenCalledTimes(1);
        } finally {
            if (stopping) await bounded(stopping, 'hotload stop cleanup');
            await bounded(runner.stop({ strict: true }), 'hotload runner cleanup');
            close.mockRestore();
        }
    });

    it('retains failed isolation and cancel releases independently of late run cleanup', async () => {
        const { runner } = await bootRunner({ tasks: [] });
        const failure = new Error('release remains unconfirmed');
        const terminate = vi.fn(async (_graceMs: number): Promise<void> => {
            throw failure;
        });
        const unsubscribe = vi.fn(async (): Promise<void> => {
            throw failure;
        });
        const internals = runner as unknown as {
            isolationRuns: Map<string, { terminate: typeof terminate }>;
            cancelUnsubs: Map<string, typeof unsubscribe>;
        };
        internals.isolationRuns.set('held-run', { terminate });
        internals.cancelUnsubs.set('held-run', unsubscribe);
        try {
            await expect(runner.stop({ strict: true })).rejects.toMatchObject({
                errors: [failure, failure],
            });
            // The normal run-finally may erase these live maps after stop's first
            // snapshot. That must not erase failed cleanup ownership too.
            internals.isolationRuns.delete('held-run');
            internals.cancelUnsubs.delete('held-run');
            await expect(runner.stop({ strict: true })).rejects.toMatchObject({
                errors: [failure, failure],
            });
            expect(terminate).toHaveBeenCalledTimes(2);
            expect(unsubscribe).toHaveBeenCalledTimes(2);
        } finally {
            terminate.mockResolvedValue(undefined);
            unsubscribe.mockResolvedValue(undefined);
            await runner.stop({ strict: true });
        }
    });

    it('retains run liveness while strict shutdown waits for worker.close', async () => {
        const entered = gate();
        const releasePlugin = gate();
        const closing = gate();
        const releaseClose = gate();
        const runId = 'run_strict_live';
        const { runner, fakeWorker, fakeClient, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'held-stop',
                    execute: async () => {
                        entered.resolve();
                        await releasePlugin.promise;
                        return { success: true };
                    },
                },
            ],
        });
        const close = vi.spyOn(fakeWorker, 'close').mockImplementation(async () => {
            closing.resolve();
            await releaseClose.promise;
        });
        const processing = callProcessor(makeJob({ name: 'held-stop', runId })).then(
            () => undefined,
            () => undefined,
        );
        let stopping: Promise<void> | undefined;
        try {
            await bounded(entered.promise, 'plugin entered');
            // A real processJob established this heartbeat before shutdown.
            expect(
                (runner as unknown as { heartbeats: Map<string, unknown> }).heartbeats.has(runId),
            ).toBe(true);
            stopping = runner.stop({ strict: true });
            await bounded(closing.promise, 'worker close entered');
            expect(
                fakeClient.customCommand.mock.calls.filter(
                    ([cmd]) => cmd[0] === 'DEL' && cmd[1] === `task:run:active:${runId}`,
                ),
            ).toHaveLength(0);
            releasePlugin.resolve();
            await bounded(processing, 'plugin processor settlement');
            releaseClose.resolve();
            await bounded(stopping, 'strict worker close');
        } finally {
            releasePlugin.resolve();
            releaseClose.resolve();
            await bounded(processing, 'held processor cleanup');
            if (stopping) await bounded(stopping, 'held stop cleanup');
            close.mockRestore();
            await bounded(runner.stop(), 'held runner cleanup');
        }
    });

    it('rejects clean strict shutdown after watchdog settlement while the actual plugin continues', async () => {
        const entered = gate();
        const release = gate();
        const finished = gate();
        let pluginReturned = false;
        const runId = 'run_strict_continuation';
        const { runner, callProcessor, stateMachine } = await bootRunner({
            tasks: [
                {
                    id: 'noncooperative-stop',
                    execute: async () => {
                        entered.resolve();
                        try {
                            // Deliberately ignore AbortSignal, as a stuck third-party
                            // plugin can. Only this test's finally releases the work.
                            await release.promise;
                            pluginReturned = true;
                            return { success: true };
                        } finally {
                            finished.resolve();
                        }
                    },
                },
            ],
        });
        const processing = callProcessor(makeJob({ name: 'noncooperative-stop', runId })).then(
            () => undefined,
            (error: unknown) => error,
        );
        try {
            await bounded(entered.promise, 'noncooperative plugin entered');
            // Use the existing watchdog entry seam, without faking the execution
            // tracking sets or settling the plugin's actual execute promise.
            await bounded(
                (
                    runner as unknown as {
                        autoFailRun(
                            id: string,
                            reason: string,
                            message: string,
                            terminal: string,
                        ): Promise<void>;
                    }
                ).autoFailRun(runId, 'wall-clock-timeout', 'test timeout', 'test timeout'),
                'watchdog settlement',
            );
            expect(await bounded(processing, 'processor settled by watchdog')).toBeInstanceOf(
                UnrecoverableError,
            );
            expect(stateMachine.transitionRun).toHaveBeenCalledWith(
                expect.objectContaining({ runId, from: 'active', to: 'failed' }),
            );
            expect(pluginReturned).toBe(false);
            expect(runner.isExecutionQuiescent()).toBe(false);
            await expect(
                bounded(runner.stop({ strict: true }), 'continuation strict stop'),
            ).rejects.toMatchObject({
                name: 'AggregateError',
                errors: [expect.objectContaining({ message: expect.stringContaining('UNKNOWN') })],
            });
            expect(pluginReturned).toBe(false);
        } finally {
            release.resolve();
            await bounded(finished.promise, 'actual plugin cleanup');
            await bounded(processing, 'watchdog processor cleanup');
            await expect.poll(() => runner.isExecutionQuiescent(), { timeout: 1500 }).toBe(true);
            await bounded(runner.stop({ strict: true }), 'quiescent strict cleanup');
        }
    });

    it('closes all worker instances and clears heartbeats', async () => {
        const closeSpy = vi.fn(async () => {});
        const onSpy = vi.fn();
        const worker: WorkerLike = {
            close: closeSpy,
            on(_event: string, _listener: (...args: unknown[]) => void) {
                onSpy(_event);
                return this;
            },
        };
        const runner = await TaskRunner.start(['io'], {
            registry: makeRegistry([
                { id: 'basic-task', execute: async () => ({ success: true }) },
            ]),
            stateMachine: makeStateMachine().sm,
            getSql: () => null,
            getClient: () =>
                makeFakeClient() as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => null,
            workerFactory: () => worker,
        });
        await runner.stop();
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });
});

describe('TaskRunner.processJob — Postgres writes', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('updates task_history on completion when sql is provided', async () => {
        const fakeSql = makeFakeSql();
        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });
        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_pg' }));
        const heads = fakeSql.calls.map((c) => c.head);
        // markActive + writeTerminal both touch task_history
        expect(heads.some((h) => h.includes('UPDATE task_history'))).toBe(true);
        await runner.stop();
    });

    it('writes plugin_failure_events when ctx.reportFailure is called', async () => {
        const fakeSql = makeFakeSql();
        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async (ctx) => {
                        await ctx.reportFailure('item-1', 'no good', {
                            foo: 'bar',
                        });
                        return { success: true };
                    },
                },
            ],
        });
        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_pf' }));
        const heads = fakeSql.calls.map((c) => c.head);
        expect(heads.some((h) => h.includes('INSERT INTO plugin_failure_events'))).toBe(true);
        await runner.stop();
    });

    it('writes task_history.cost_breakdown when ctx.spend is called', async () => {
        const fakeSql = makeFakeSql();
        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async (ctx) => {
                        ctx.spend('openai_tokens', 100);
                        ctx.spend('openai_tokens', 50);
                        ctx.spend('cpu_seconds', 5);
                        return { success: true };
                    },
                },
            ],
        });
        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_cost' }));

        // Find the cost_breakdown UPDATE.
        const costUpdateCall = fakeSql.calls.find(
            (c) => c.head.includes('UPDATE task_history') && c.head.includes('cost_breakdown'),
        );
        expect(costUpdateCall).toBeDefined();

        // sql.json() in makeFakeSql is an identity fn, so the breakdown arrives
        // as a plain object in values (not a JSON string). Accept either form.
        // Production change: cost_breakdown write path now passes the object
        // through sql.json() which the mock returns as-is.
        const breakdownValue = costUpdateCall!.values.find(
            (v) =>
                (typeof v === 'string' && v.includes('openai_tokens')) ||
                (typeof v === 'object' && v !== null && 'openai_tokens' in (v as object)),
        );
        expect(breakdownValue).toBeDefined();
        const breakdown =
            typeof breakdownValue === 'string'
                ? (JSON.parse(breakdownValue) as Record<string, number>)
                : (breakdownValue as Record<string, number>);
        expect(breakdown.openai_tokens).toBe(150);
        expect(breakdown.cpu_seconds).toBe(5);
        await runner.stop();
    });

    it('counts provider calls from tasks without an opt-in spend helper', async () => {
        const fakeSql = makeFakeSql();
        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        countExternalCall('https://lrclib.net/api/get', 404);
                        return { success: true };
                    },
                },
            ],
        });
        try {
            await callProcessor(makeJob({ name: 'basic-task', runId: 'run_auto_cost' }));
            const write = fakeSql.calls.find(
                (c) => c.head.includes('UPDATE task_history') && c.head.includes('cost_breakdown'),
            );
            expect(write).toBeDefined();
            expect(write!.values).toContainEqual({ api_calls: 1, 'api_calls:lrclib.net': 1 });
        } finally {
            await runner.stop();
        }
    });

    it('does not write cost_breakdown when ctx.spend is never called', async () => {
        const fakeSql = makeFakeSql();
        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => ({ success: true }),
                },
            ],
        });
        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_nocost' }));
        const costUpdateCall = fakeSql.calls.find(
            (c) => c.head.includes('UPDATE task_history') && c.head.includes('cost_breakdown'),
        );
        expect(costUpdateCall).toBeUndefined();
        await runner.stop();
    });
});

// ── F9: pipeline.when skip-stage wire ────────────────────────────────────────
//
// The runner must consult `registry.shouldSkipStage(task, parentResult)`
// before invoking `task.execute(ctx)` when the task declares `pipeline.when`.
// Parent result is fetched via BullMQ's `Job.getChildrenValues()` — the
// FlowProducer-native channel for sibling result propagation.
//
// Behaviour invariants:
//   - when predicate returns true  → task.execute runs normally
//   - when predicate returns false → task.execute NOT called, run transitions
//                                    active→completed with a skippedByWhen
//                                    marker and a 'pipeline-when-skip' meta
//                                    PUBLISH lands.
//   - tasks without pipeline.when  → shouldSkipStage is a no-op (false)

interface TaskFactoryWithPipeline extends TaskFactoryOpts {
    pipeline?: { of: string; after?: string[]; when?: (r: unknown) => boolean };
}

function makeRegistryWithPipeline(tasks: TaskFactoryWithPipeline[]): TaskRegistry {
    const reg = new TaskRegistry();
    for (const t of tasks) {
        reg.registerTask(
            defineTask({
                id: t.id ?? 'basic-task',
                name: 'Test',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: t.capabilities ?? {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'one',
                pipeline: t.pipeline,
                execute: t.execute,
            }),
        );
    }
    return reg;
}

interface FakeJobWithChildren extends FakeJobOpts {
    childrenValues?: Record<string, unknown>;
}

function makeJobWithChildren(opts: FakeJobWithChildren): Job {
    const base = makeJob(opts) as unknown as Record<string, unknown>;
    if (opts.childrenValues !== undefined) {
        base.getChildrenValues = async () => opts.childrenValues!;
    }
    return base as unknown as Job;
}

describe('TaskRunner.processJob — pipeline.when skip-stage', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('runs task.execute normally when pipeline.when returns true', async () => {
        const executeSpy = vi.fn(async () => ({ success: true }));
        const registry = makeRegistryWithPipeline([
            {
                id: 'gated-task',
                pipeline: {
                    of: 'p',
                    after: ['parent'],
                    when: (parent) => Boolean((parent as { changed?: number })?.changed),
                },
                execute: executeSpy,
            },
        ]);
        const fakeClient = makeFakeClient();
        const fakeWorker = makeFakeWorker();
        const stateMachineObj = makeStateMachine();
        let captured: Processor | null = null;

        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachineObj.sm,
            getSql: () => null,
            getClient: () =>
                fakeClient as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => async () => {},
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        });

        // when() returns true → execute should run.
        await (captured! as Processor)(
            makeJobWithChildren({
                name: 'gated-task',
                runId: 'run_when_true',
                childrenValues: { 'parent-job-key': { changed: 5 } },
            }),
            'token',
        );

        expect(executeSpy).toHaveBeenCalledTimes(1);
        const transitions = stateMachineObj.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).toContain('active->completed');
        await runner.stop();
    });

    it('skips task.execute and marks completed when pipeline.when returns false', async () => {
        const executeSpy = vi.fn(async () => ({ success: true }));
        const registry = makeRegistryWithPipeline([
            {
                id: 'gated-task',
                pipeline: {
                    of: 'p',
                    after: ['parent'],
                    when: (parent) => Boolean((parent as { changed?: number })?.changed),
                },
                execute: executeSpy,
            },
        ]);
        const fakeClient = makeFakeClient();
        const fakeWorker = makeFakeWorker();
        const stateMachineObj = makeStateMachine();
        let captured: Processor | null = null;

        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachineObj.sm,
            getSql: () => null,
            getClient: () =>
                fakeClient as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => async () => {},
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        });

        // when() returns false → execute should NOT run.
        const result = await (captured! as Processor)(
            makeJobWithChildren({
                name: 'gated-task',
                runId: 'run_when_false',
                childrenValues: { 'parent-job-key': { changed: 0 } },
            }),
            'token',
        );

        expect(executeSpy).not.toHaveBeenCalled();
        // Run transitions active→completed with the skippedByWhen marker.
        const transitions = stateMachineObj.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).toContain('active->completed');
        // Return value carries the skip marker for downstream observers.
        expect(result).toMatchObject({
            skipped: true,
            skippedByWhen: true,
            reason: 'pipeline_when_false',
        });
        await runner.stop();
    });

    it('emits a pipeline-when-skip meta event on skip', async () => {
        const executeSpy = vi.fn(async () => ({ success: true }));
        const registry = makeRegistryWithPipeline([
            {
                id: 'gated-task',
                pipeline: {
                    of: 'p',
                    after: ['parent'],
                    when: () => false,
                },
                execute: executeSpy,
            },
        ]);
        const fakeClient = makeFakeClient();
        const publishCalls: Array<{ channel: string; payload: string }> = [];
        fakeClient.customCommand.mockImplementation(async (cmd: string[]) => {
            const op = cmd[0]?.toUpperCase();
            if (op === 'PUBLISH') {
                publishCalls.push({ channel: cmd[1], payload: cmd[2] });
                return 1;
            }
            if (op === 'HSET') return 1;
            if (op === 'PEXPIRE') return 1;
            return null;
        });
        const fakeWorker = makeFakeWorker();
        const stateMachineObj = makeStateMachine();
        let captured: Processor | null = null;

        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachineObj.sm,
            getSql: () => null,
            getClient: () =>
                fakeClient as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => async () => {},
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        });

        await (captured! as Processor)(
            makeJobWithChildren({
                name: 'gated-task',
                runId: 'run_meta',
                parentRunId: 'run_parent',
                childrenValues: { p: {} },
            }),
            'token',
        );

        expect(executeSpy).not.toHaveBeenCalled();
        // Meta events publish through publishMessage (the cache client), not the
        // injected coordination client's customCommand.
        const { publishMessage } = await import('$lib/server/cache/valkey.js');
        const metaCall = vi
            .mocked(publishMessage)
            .mock.calls.find((c) => c[0] === 'task:events:meta');
        expect(metaCall, 'expected task:events:meta publish').toBeDefined();
        const parsed = JSON.parse(metaCall![1] as string);
        expect(parsed.type).toBe('pipeline-when-skip');
        expect(parsed.data).toMatchObject({
            runId: 'run_meta',
            taskId: 'gated-task',
            parentRunId: 'run_parent',
            reason: 'pipeline_when_false',
        });
        await runner.stop();
    });

    it('does not call shouldSkipStage when task has no pipeline.when (top-level run)', async () => {
        // Regression guard — non-pipeline tasks must take the unconditional
        // path. Verify by leaving getChildrenValues entirely undefined on the
        // job: if the runner were calling shouldSkipStage anyway, it would
        // either probe getChildrenValues or invoke the (absent) predicate.
        const executeSpy = vi.fn(async () => ({ success: true }));
        const registry = makeRegistryWithPipeline([
            {
                id: 'top-level',
                execute: executeSpy,
            },
        ]);
        const fakeClient = makeFakeClient();
        const fakeWorker = makeFakeWorker();
        const stateMachineObj = makeStateMachine();
        let captured: Processor | null = null;

        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachineObj.sm,
            getSql: () => null,
            getClient: () =>
                fakeClient as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => async () => {},
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        });

        const job = makeJob({ name: 'top-level', runId: 'run_top' });
        // Sanity: no getChildrenValues hook on this job.
        expect(
            (job as unknown as { getChildrenValues?: unknown }).getChildrenValues,
        ).toBeUndefined();

        await (captured! as Processor)(job, 'token');

        expect(executeSpy).toHaveBeenCalledTimes(1);
        await runner.stop();
    });

    it('falls back to undefined parentResult when getChildrenValues throws', async () => {
        // Predicate must still be invoked with `undefined` rather than the
        // runner crashing — the registry decides what to do with it.
        const whenSpy = vi.fn((parent: unknown) => parent !== undefined);
        const executeSpy = vi.fn(async () => ({ success: true }));
        const registry = makeRegistryWithPipeline([
            {
                id: 'gated-task',
                pipeline: { of: 'p', after: ['parent'], when: whenSpy },
                execute: executeSpy,
            },
        ]);
        const fakeClient = makeFakeClient();
        const fakeWorker = makeFakeWorker();
        const stateMachineObj = makeStateMachine();
        let captured: Processor | null = null;

        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachineObj.sm,
            getSql: () => null,
            getClient: () =>
                fakeClient as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => async () => {},
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        });

        // Build a job whose getChildrenValues throws.
        const baseJob = makeJob({
            name: 'gated-task',
            runId: 'run_cv_throw',
        }) as unknown as Record<string, unknown>;
        baseJob.getChildrenValues = async () => {
            throw new Error('BullMQ blip');
        };

        await (captured! as Processor)(baseJob as unknown as Job, 'token');

        // Predicate was called with `undefined` (fallback).
        expect(whenSpy).toHaveBeenCalledWith(undefined);
        // Predicate returned false (undefined !== undefined → false) → skip path.
        expect(executeSpy).not.toHaveBeenCalled();
        await runner.stop();
    });
});

// ── processing_version dispatch guard ────────────────────────────────────────
//
// During a rolling restart, a task_history row inserted by a prior code
// revision can be picked up by a worker on the new revision. If
// `task.processingVersion` has bumped (signalling a payload/schema
// incompatibility), the runner MUST refuse to execute that stale row
// rather than silently process it with the wrong code path. The refusal
// is permanent — retrying won't make the version mismatch go away.

function makeRegistryWithVersion(
    tasks: Array<TaskFactoryOpts & { processingVersion: number }>,
): TaskRegistry {
    const reg = new TaskRegistry();
    for (const t of tasks) {
        reg.registerTask(
            defineTask({
                id: t.id ?? 'basic-task',
                name: 'Test',
                version: '1.0.0',
                processingVersion: t.processingVersion,
                minAppVersion: '1.0.0',
                capabilities: t.capabilities ?? {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'one',
                execute: t.execute,
            }),
        );
    }
    return reg;
}

describe('TaskRunner.processJob — processing_version dispatch guard', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    function buildRunnerForVersion(opts: {
        taskProcessingVersion: number;
        rowProcessingVersion: string | null;
        executeSpy: (ctx: TaskContext) => Promise<TaskResult>;
    }): Promise<{
        runner: TaskRunner;
        stateMachine: ReturnType<typeof makeStateMachine>;
        callProcessor: (job: Job) => Promise<unknown>;
        fakeSql: FakeSql;
    }> {
        const fakeSql = makeFakeSql();
        // Seed the SELECT processing_version response. Header-match on
        // 'SELECT processing_version' so the lookup only fires for the
        // guard's query, not the other UPDATE-task_history calls.
        fakeSql.responses.set('SELECT processing_version', [
            { processing_version: opts.rowProcessingVersion },
        ]);
        const registry = makeRegistryWithVersion([
            {
                id: 'versioned-task',
                processingVersion: opts.taskProcessingVersion,
                execute: opts.executeSpy,
            },
        ]);
        const stateMachine = makeStateMachine();
        const fakeWorker = makeFakeWorker();
        let captured: Processor | null = null;
        return TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachine.sm,
            getSql: () => fakeSql.sql,
            getClient: () =>
                makeFakeClient() as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => async () => {},
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        }).then((runner) => ({
            runner,
            stateMachine,
            fakeSql,
            callProcessor: async (job: Job) => {
                if (!captured) throw new Error('processor not captured');
                return captured(job, 'token');
            },
        }));
    }

    it('refuses to execute when row.processing_version < task.processingVersion', async () => {
        const executeSpy = vi.fn(async () => ({ success: true }));
        const { runner, stateMachine, callProcessor } = await buildRunnerForVersion({
            taskProcessingVersion: 5,
            rowProcessingVersion: '3',
            executeSpy,
        });

        await expect(
            callProcessor(makeJob({ name: 'versioned-task', runId: 'run_stale' })),
        ).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'permanent',
            message: expect.stringContaining('processing_version_mismatch'),
        });

        // Plugin must NEVER have been invoked.
        expect(executeSpy).not.toHaveBeenCalled();

        // The run was driven to active→failed and the terminal write
        // recorded the mismatch reason.
        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).toContain('active->failed');
        const failedCall = stateMachine.transitionRun.mock.calls.find(
            ([opts]) => opts.from === 'active' && opts.to === 'failed',
        );
        expect(failedCall![0].extra.errorKind).toBe('permanent');
        expect(failedCall![0].extra.errorMessage).toContain('processing_version_mismatch');

        await runner.stop();
    });

    it('runs normally when row.processing_version === task.processingVersion', async () => {
        const executeSpy = vi.fn(async () => ({ success: true }));
        const { runner, callProcessor } = await buildRunnerForVersion({
            taskProcessingVersion: 5,
            rowProcessingVersion: '5',
            executeSpy,
        });

        await callProcessor(makeJob({ name: 'versioned-task', runId: 'run_match' }));
        expect(executeSpy).toHaveBeenCalledTimes(1);
        await runner.stop();
    });

    it('treats NULL row.processing_version as legacy → runs normally', async () => {
        // Pre-Wave-9 rows have NULL — the guard must be opt-in via the
        // column's presence, not opt-out.
        const executeSpy = vi.fn(async () => ({ success: true }));
        const { runner, callProcessor } = await buildRunnerForVersion({
            taskProcessingVersion: 5,
            rowProcessingVersion: null,
            executeSpy,
        });
        await callProcessor(makeJob({ name: 'versioned-task', runId: 'run_legacy' }));
        expect(executeSpy).toHaveBeenCalledTimes(1);
        await runner.stop();
    });

    it('runs normally (with warn) when row.processing_version > task.processingVersion', async () => {
        // Downgrade rollback: refusing here would block the new replica
        // from draining queues left over from the just-rolled-back replica.
        const executeSpy = vi.fn(async () => ({ success: true }));
        const { runner, callProcessor } = await buildRunnerForVersion({
            taskProcessingVersion: 3,
            rowProcessingVersion: '5',
            executeSpy,
        });
        await callProcessor(makeJob({ name: 'versioned-task', runId: 'run_downgrade' }));
        expect(executeSpy).toHaveBeenCalledTimes(1);
        await runner.stop();
    });

    it('runs normally when sql is unavailable (degraded boot — guard skipped, logged) — finding #8', async () => {
        // Edge-case finding #8: previously the reader returned `null` for
        // both "no sql" and "row column NULL", collapsing two distinct
        // signals. The discriminated `ProcessingVersionRead` now exposes
        // `'no-sql'` — dispatcher proceeds (so we don't block ALL work
        // during a DB outage) but emits a loud warn so the operator can
        // correlate with infra health. Test: with getSql=() => null, the
        // task still executes (no permanent throw, no active→failed).
        const executeSpy = vi.fn(async () => ({ success: true }));
        const registry = makeRegistryWithVersion([
            { id: 'versioned-task', processingVersion: 7, execute: executeSpy },
        ]);
        const stateMachine = makeStateMachine();
        const fakeWorker = makeFakeWorker();
        let captured: Processor | null = null;
        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine: stateMachine.sm,
            getSql: () => null, // ← degraded boot
            getClient: () =>
                makeFakeClient() as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            concurrencyFor: () => 1,
            subscribe: async () => async () => {},
            workerFactory: (_cls, processor) => {
                captured = processor;
                fakeWorker._processor = processor;
                return fakeWorker;
            },
        });
        if (!captured) throw new Error('processor not captured');
        await (captured as Processor)(
            makeJob({ name: 'versioned-task', runId: 'run_no_sql' }),
            'token',
        );
        // Plugin DID execute — the guard cannot block on degraded sql.
        expect(executeSpy).toHaveBeenCalledTimes(1);
        // No active→failed transition fired for pv mismatch.
        const transitions = stateMachine.transitionRun.mock.calls.map(
            ([opts]) => `${opts.from}->${opts.to}`,
        );
        expect(transitions).not.toContain('active->failed');
        await runner.stop();
    });
});

// ── Wave 8.5: per-task-queue path (FEATURE_PER_TASK_QUEUES on) ──────────────────

describe('TaskRunner with FEATURE_PER_TASK_QUEUES on', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    // A fake client that tracks the budget counter so we can assert
    // acquire/release symmetry and cap enforcement on the class budget.
    function makeBudgetClient(): FakeClient & { _budget: Map<string, number> } {
        const base = makeFakeClient();
        const budget = new Map<string, number>();
        const customCommand = vi.fn(async (cmd: string[]): Promise<unknown> => {
            const op = cmd[0]?.toUpperCase();
            const key = cmd[1];
            // Atomic acquire EVAL: ['EVAL', script, '1', key, cap, ttl].
            if (op === 'EVAL' && cmd[3]?.startsWith('task:resource-budget:')) {
                const k = cmd[3];
                const cap = Number(cmd[4]);
                const cur = budget.get(k) ?? 0;
                if (cur >= cap) return -1;
                const next = cur + 1;
                budget.set(k, next);
                return next;
            }
            if (op === 'INCR' && key?.startsWith('task:resource-budget:')) {
                const next = (budget.get(key) ?? 0) + 1;
                budget.set(key, next);
                return next;
            }
            if (op === 'DECR' && key?.startsWith('task:resource-budget:')) {
                const next = (budget.get(key) ?? 0) - 1;
                budget.set(key, next);
                return next;
            }
            if (op === 'DEL' && key?.startsWith('task:resource-budget:')) {
                budget.delete(key);
                return 1;
            }
            // EXPIRE + everything else → delegate to the base fake.
            return base.customCommand(cmd);
        });
        return { ...base, customCommand, _budget: budget };
    }

    interface PerTaskBoot {
        runner: TaskRunner;
        stateMachine: ReturnType<typeof makeStateMachine>;
        client: FakeClient & { _budget: Map<string, number> };
        processors: Map<string, Processor>;
        startedTaskIds: string[];
    }

    async function bootPerTask(opts: {
        tasks: TaskFactoryOpts[];
        capPerClass?: number;
        client?: FakeClient & { _budget: Map<string, number> };
    }): Promise<PerTaskBoot> {
        const registry = makeRegistry(opts.tasks);
        const stateMachine = makeStateMachine();
        const client = opts.client ?? makeBudgetClient();
        const processors = new Map<string, Processor>();
        const startedTaskIds: string[] = [];

        const runner = await TaskRunner.start([], {
            registry,
            stateMachine: stateMachine.sm,
            getSql: () => null,
            getClient: () =>
                client as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            instanceId: 'test-instance',
            bootId: 'boot-0',
            heartbeatIntervalMs: 1_000_000,
            // Budget cap per class — getCap reads this in processJob.
            concurrencyFor: () => opts.capPerClass ?? 4,
            subscribe: async () => null,
            perTaskQueues: true,
            workerFactory: (_cls, processor, taskId) => {
                if (taskId) {
                    processors.set(taskId, processor);
                    startedTaskIds.push(taskId);
                }
                return makeFakeWorker();
            },
        });
        return { runner, stateMachine, client, processors, startedTaskIds };
    }

    it('spawns one worker per registered task (not per class)', async () => {
        const { runner, startedTaskIds } = await bootPerTask({
            tasks: [
                { id: 'task-a', execute: async () => ({ success: true }) },
                { id: 'task-b', execute: async () => ({ success: true }) },
                { id: 'task-c', execute: async () => ({ success: true }) },
            ],
        });
        expect(startedTaskIds.sort()).toEqual(['task-a', 'task-b', 'task-c']);
        await runner.stop();
    });

    it('acquires then releases a class budget token across a run', async () => {
        const { runner, client, processors } = await bootPerTask({
            tasks: [{ id: 'task-a', execute: async () => ({ success: true }) }],
            capPerClass: 4,
        });
        const proc = processors.get('task-a')!;
        await proc(makeJob({ name: 'task-a', runId: 'run_budget' }), 'token');
        // After a clean terminal path the budget counter is back to 0 (or the
        // key DEL'd when it underflowed) — i.e. the token was released.
        expect(client._budget.get('task:resource-budget:io') ?? 0).toBe(0);
        await runner.stop();
    });

    it('re-queues via moveToDelayed (not fail) when the class budget is exhausted', async () => {
        const client = makeBudgetClient();
        // Pre-fill the io budget to its cap so the next acquire overshoots.
        client._budget.set('task:resource-budget:io', 4);
        const { runner, processors } = await bootPerTask({
            tasks: [{ id: 'task-a', execute: async () => ({ success: true }) }],
            capPerClass: 4,
            client,
        });
        const proc = processors.get('task-a')!;
        const moveToDelayed = vi.fn(async (_timestamp?: number) => {});
        const job = makeJob({
            name: 'task-a',
            runId: 'run_over',
        }) as unknown as {
            moveToDelayed: typeof moveToDelayed;
        };
        job.moveToDelayed = moveToDelayed;
        // With a token + moveToDelayed available, a budget-blocked job is
        // deferred (DelayedError), NOT failed — no retry attempt consumed.
        await expect(proc(job as unknown as Job, 'tok-1')).rejects.toBeInstanceOf(DelayedError);
        expect(moveToDelayed).toHaveBeenCalledTimes(1);
        // Delayed to a future timestamp.
        expect(moveToDelayed.mock.calls[0][0]).toBeGreaterThan(Date.now());
        // The over-cap INCR was rolled back — counter is back at the cap, not cap+1.
        expect(client._budget.get('task:resource-budget:io')).toBe(4);
        await runner.stop();
    });

    it('falls back to transient throw when moveToDelayed itself rejects', async () => {
        const client = makeBudgetClient();
        client._budget.set('task:resource-budget:io', 4);
        const { runner, processors } = await bootPerTask({
            tasks: [{ id: 'task-a', execute: async () => ({ success: true }) }],
            capPerClass: 4,
            client,
        });
        const proc = processors.get('task-a')!;
        const job = makeJob({
            name: 'task-a',
            runId: 'run_del_fail',
        }) as unknown as {
            moveToDelayed: () => Promise<void>;
        };
        // moveToDelayed rejects (e.g. stale lock) — must NOT escape as a plain
        // error (which BullMQ counts as a failed attempt); fall back to transient.
        job.moveToDelayed = vi.fn(async () => {
            throw new Error('lock mismatch');
        });
        await expect(proc(job as unknown as Job, 'tok-3')).rejects.toThrow(/Budget-delay failed/i);
        expect(client._budget.get('task:resource-budget:io')).toBe(4);
        await runner.stop();
    });

    it('falls back to transient throw when budget exhausted and moveToDelayed is unavailable', async () => {
        const client = makeBudgetClient();
        client._budget.set('task:resource-budget:io', 4);
        const { runner, processors } = await bootPerTask({
            tasks: [{ id: 'task-a', execute: async () => ({ success: true }) }],
            capPerClass: 4,
            client,
        });
        const proc = processors.get('task-a')!;
        // makeJob has no moveToDelayed → fallback path.
        await expect(
            proc(makeJob({ name: 'task-a', runId: 'run_over2' }), 'tok-2'),
        ).rejects.toThrow(/budget exhausted/i);
        expect(client._budget.get('task:resource-budget:io')).toBe(4);
        await runner.stop();
    });

    it('releases the budget token when the pending→active transition throws', async () => {
        const { runner, client, processors, stateMachine } = await bootPerTask({
            tasks: [{ id: 'task-a', execute: async () => ({ success: true }) }],
            capPerClass: 4,
        });
        // Claim succeeds, but the pending→active transition rejects (Valkey
        // EVALSHA error). This await sits before the main try/finally, so the
        // guard must release the budget token (regression: code-review finding).
        stateMachine.transitionRun.mockImplementation(
            async (opts: { from: string; to: string }) => {
                if (opts.from === 'pending' && opts.to === 'active') {
                    throw new Error('valkey EVALSHA failed');
                }
                return { ok: true };
            },
        );
        const proc = processors.get('task-a')!;
        await expect(proc(makeJob({ name: 'task-a', runId: 'run_tx' }), 'token')).rejects.toThrow(
            /transition failed/i,
        );
        expect(client._budget.get('task:resource-budget:io') ?? 0).toBe(0);
        await runner.stop();
    });

    it('heartbeat refreshes the TTL of BOTH the per-task counter and the class budget', async () => {
        const { runner, client } = await bootPerTask({
            tasks: [{ id: 'task-a', execute: async () => ({ success: true }) }],
            capPerClass: 4,
        });
        // `task-a` is registered with resourceClass 'io' (makeRegistry default),
        // so the budget key acquireClassBudget would use is
        // `task:resource-budget:io` — the SAME key the heartbeat must refresh.
        const task = defineTask({
            id: 'task-a',
            name: 'Test',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io',
            inputSchema: z.unknown(),
            identityFor: () => 'one',
            execute: async () => ({ success: true }),
        });
        const internals = runner as unknown as {
            startHeartbeat: (runId: string, t: unknown) => void;
            heartbeatOnce: (runId: string) => Promise<void>;
            stopHeartbeat: (runId: string) => void;
        };
        const runId = 'run_hb_ttl';
        internals.startHeartbeat(runId, task);
        // Drop the calls accumulated during boot/start so we only assert on the
        // beat's own EXPIREs.
        client.customCommand.mockClear();
        await internals.heartbeatOnce(runId);
        internals.stopHeartbeat(runId);

        const expireKeys = client.customCommand.mock.calls
            .map((c) => c[0] as string[])
            .filter((cmd) => cmd[0]?.toUpperCase() === 'EXPIRE')
            .map((cmd) => cmd[1]);
        expect(expireKeys).toContain('task:active-count:task-a');
        expect(expireKeys).toContain('task:resource-budget:io');
        await runner.stop();
    });

    it('heartbeat refreshes ONLY the per-task counter when per-task queues are off', async () => {
        // perTaskQueues defaults off in bootRunner — the class budget is not in
        // play, so the heartbeat must not refresh a budget key.
        const fakeClient = makeFakeClient();
        const { runner } = await bootRunner({
            tasks: [{ id: 'task-a', execute: async () => ({ success: true }) }],
            client: fakeClient,
        });
        const task = defineTask({
            id: 'task-a',
            name: 'Test',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io',
            inputSchema: z.unknown(),
            identityFor: () => 'one',
            execute: async () => ({ success: true }),
        });
        const internals = runner as unknown as {
            startHeartbeat: (runId: string, t: unknown) => void;
            heartbeatOnce: (runId: string) => Promise<void>;
            stopHeartbeat: (runId: string) => void;
        };
        const runId = 'run_hb_noqueue';
        internals.startHeartbeat(runId, task);
        fakeClient.customCommand.mockClear();
        await internals.heartbeatOnce(runId);
        internals.stopHeartbeat(runId);

        const expireKeys = fakeClient.customCommand.mock.calls
            .map((c) => c[0] as string[])
            .filter((cmd) => cmd[0]?.toUpperCase() === 'EXPIRE')
            .map((cmd) => cmd[1]);
        expect(expireKeys).toContain('task:active-count:task-a');
        expect(expireKeys.some((k) => k.startsWith('task:resource-budget:'))).toBe(false);
        await runner.stop();
    });
});

// ── Plugin worker-thread isolation ──────────────────────────────────────────

/**
 * Fake isolation worker for the runner routing tests. Auto-posts a `done`
 * message on the next tick after the host attaches its `message` listener, so
 * `executeInWorker`'s result promise resolves and `processJob` reaches its
 * terminal write — all without a real thread.
 */
function makeFakeIsoWorker(result: TaskResult = { success: true, itemsProcessed: 1 }): {
    worker: IsolationWorkerLike;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
} {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    let doneScheduled = false;
    const postMessage = vi.fn();
    const terminate = vi.fn(async () => {
        for (const cb of listeners.exit ?? []) cb(1);
    });
    const worker = {
        postMessage,
        terminate,
        on(event: string, cb: (...a: unknown[]) => void) {
            (listeners[event] ??= []).push(cb);
            if (event === 'message' && !doneScheduled) {
                doneScheduled = true;
                setImmediate(() => {
                    for (const m of listeners.message ?? []) m({ t: 'done', result });
                });
            }
            return worker;
        },
        once(event: string, cb: (...a: unknown[]) => void) {
            return (worker.on as (e: string, c: (...a: unknown[]) => void) => unknown)(event, cb);
        },
    } as unknown as IsolationWorkerLike;
    return { worker, postMessage, terminate };
}

describe('TaskRunner.processJob — plugin worker isolation', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('routes execute() to a worker thread when flag on AND task opts in', async () => {
        const execute = vi.fn(async () => ({ success: true }));
        const fake = makeFakeIsoWorker({ success: true, itemsProcessed: 4 });
        const spawn = vi.fn<SpawnIsolationWorker>(() => fake.worker);
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'iso-task', isolation: 'worker', execute }],
            pluginIsolation: true,
            spawnIsolationWorker: spawn,
        });

        await callProcessor(makeJob({ runId: 'r1', name: 'iso-task' }));

        // The plugin ran in the worker, NOT in-process.
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(execute).not.toHaveBeenCalled();
        // Correct workerData crossed the boundary.
        const workerData = spawn.mock.calls[0][1] as SandboxWorkerData;
        expect(workerData).toMatchObject({ runId: 'r1', taskId: 'iso-task' });
        // Run reached a normal terminal completion.
        expect(stateMachine.transitionRun).toHaveBeenCalledWith(
            expect.objectContaining({ to: 'completed' }),
        );
        await runner.stop();
    });

    it('keeps the in-process path when the flag is OFF (default)', async () => {
        const execute = vi.fn(async () => ({ success: true }));
        const spawn = vi.fn();
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id: 'iso-task', isolation: 'worker', execute }],
            pluginIsolation: false,
            spawnIsolationWorker: spawn as unknown as SpawnIsolationWorker,
        });

        await callProcessor(makeJob({ runId: 'r2', name: 'iso-task' }));

        expect(spawn).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledTimes(1);
        await runner.stop();
    });

    it('keeps the in-process path for a task that does NOT opt in, even with the flag on', async () => {
        const execute = vi.fn(async () => ({ success: true }));
        const spawn = vi.fn();
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id: 'plain-task', execute }], // no isolation field
            pluginIsolation: true,
            spawnIsolationWorker: spawn as unknown as SpawnIsolationWorker,
        });

        await callProcessor(makeJob({ runId: 'r3', name: 'plain-task' }));

        expect(spawn).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledTimes(1);
        await runner.stop();
    });

    // The whole point of worker isolation: when a run wedges (a SYNCHRONOUS
    // busy-loop the in-process watchdogs can't escape), the main-thread watchdog
    // must hard-kill the worker. The terminate() MECHANISM is proven against a
    // real thread in worker-host.test.ts; this proves the runner WIRING —
    // autoFailRun → isoRun.terminate(grace) → terminal 'failed' — which is the
    // exact path that had never been exercised at the runner level (GH #57).
    it('hard-kills the isolated worker via terminate() when the watchdog auto-fails the run', async () => {
        const { runner, stateMachine } = await bootRunner({
            tasks: [{ id: 'iso-task', isolation: 'worker', execute: vi.fn() }],
            pluginIsolation: true,
        });

        // Register a live IsolationRun exactly as executeIsolated would, but with
        // a result that never settles on its own — i.e. a wedged worker. The only
        // way it ends is the watchdog calling terminate().
        const terminate = vi.fn(async () => {});
        const isoRuns = (
            runner as unknown as {
                isolationRuns: Map<
                    string,
                    {
                        result: Promise<unknown>;
                        terminate: (ms: number) => Promise<void>;
                    }
                >;
            }
        ).isolationRuns;
        isoRuns.set('run_wedged_iso', {
            result: new Promise<never>(() => {}),
            terminate,
        });

        // Drive the watchdog's auto-fail path directly — the same call the
        // wall-clock / stall watchdog makes when a run blows its deadline.
        await (
            runner as unknown as {
                autoFailRun: (
                    runId: string,
                    reason: string,
                    transitionMessage: string,
                    terminalMessage: string,
                ) => Promise<void>;
            }
        ).autoFailRun('run_wedged_iso', 'wall-clock-timeout', 'stalled', 'stalled');

        // Safety net fired: terminate() called once with a (grace-window) number.
        expect(terminate).toHaveBeenCalledTimes(1);
        expect(terminate).toHaveBeenCalledWith(expect.any(Number));
        // And the run was driven to a terminal 'failed' state.
        expect(stateMachine.transitionRun).toHaveBeenCalledWith(
            expect.objectContaining({ to: 'failed' }),
        );
        await runner.stop();
    });
});

// ── T4: terminal-drain transient-PG fallback payload ─────────────────────────
//
// `writeTerminalToPostgres` enqueues to PendingWriteDrain when the Postgres
// UPDATE throws a TRANSIENT error (SQLSTATE 08xxx, 40001/40P01, 53xxx, etc.).
// The drain payload must carry {state, result, error, completedAt} so the
// drain consumer can reconstruct the terminal write. A NON-transient error
// (e.g. syntax, constraint) must NOT be drained — it's a permanent failure
// the operator needs to see.
//
// Regression signal: if the `if (isTransientPgError(err))` block in
// writeTerminalToPostgres is removed, or the payload shape changes, the spy
// is never called (transient case) or called for non-transient (negative
// case) — both fail this test.

describe('TaskRunner.writeTerminalToPostgres — transient-PG drain fallback (T4)', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    /**
     * Build a fake sql that rejects ONLY the SECOND UPDATE task_history call
     * (the terminal write in writeTerminalToPostgres, not the markActive write).
     * Uses a call-counter so the first UPDATE (markActiveInPostgres) resolves,
     * allowing the run to reach the terminal-write stage.
     */
    function makeSqlThrowingOnTerminalUpdate(err: Error): postgres.Sql {
        let updateCallCount = 0;
        const fn = vi.fn((...args: unknown[]) => {
            const head = (Array.from(args[0] as readonly string[])[0] ?? '').trim().slice(0, 60);
            if (head.includes('SELECT processing_version')) {
                return Promise.resolve([{ processing_version: null }]);
            }
            if (head.includes('UPDATE task_history')) {
                updateCallCount++;
                // First UPDATE = markActiveInPostgres (state→active) → pass.
                // Second UPDATE = writeTerminalToPostgres (state→completed) → throw.
                if (updateCallCount >= 2) {
                    return Promise.reject(err);
                }
            }
            return Promise.resolve([]);
        });
        (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
        return fn as unknown as postgres.Sql;
    }

    it('enqueues to PendingWriteDrain with correct payload on a transient PG error', async () => {
        // SQLSTATE 08006 (connection_failure) is in the TRANSIENT set.
        const transientErr = Object.assign(new Error('Connection terminated unexpectedly'), {
            code: '08006',
        });

        // Spy on PendingWriteDrain.enqueue BEFORE the runner is constructed.
        // The runner lazily creates the drain instance on the first transient error;
        // the prototype spy is already in place so the instance method is intercepted.
        const { PendingWriteDrain } = await import('./pending-write-drain.js');
        const enqueueSpy = vi
            .spyOn(PendingWriteDrain.prototype, 'enqueue')
            .mockResolvedValue(undefined);

        const { runner, callProcessor } = await bootRunner({
            sql: makeSqlThrowingOnTerminalUpdate(transientErr),
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => ({ success: true, itemsProcessed: 42 }),
                },
            ],
        });

        // The run completes from the plugin perspective; the Postgres terminal
        // write fails. The runner catches it, checks isTransientPgError, and
        // enqueues to the drain.
        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_t4_transient' }));

        // The drain enqueue must have been called with the correct shape.
        expect(enqueueSpy).toHaveBeenCalled();
        const drainPayload = enqueueSpy.mock.calls[0][0];
        expect(drainPayload.kind).toBe('update');
        expect(drainPayload.runId).toBe('run_t4_transient');
        expect(drainPayload.payload).toMatchObject({
            state: 'completed',
            completedAt: expect.any(String),
        });
        // result and error keys must exist in the payload (may be null).
        expect('result' in drainPayload.payload).toBe(true);
        expect('error' in drainPayload.payload).toBe(true);

        enqueueSpy.mockRestore();
        await runner.stop();
    });

    it('does NOT enqueue to drain on a non-transient PG error', async () => {
        // SQLSTATE 23505 (unique_violation) is NOT transient — constraint error,
        // permanent failure the operator needs to see.
        const permanentErr = Object.assign(
            new Error('duplicate key value violates unique constraint'),
            { code: '23505' },
        );

        const { PendingWriteDrain } = await import('./pending-write-drain.js');
        const enqueueSpy = vi
            .spyOn(PendingWriteDrain.prototype, 'enqueue')
            .mockResolvedValue(undefined);

        const { runner, callProcessor } = await bootRunner({
            sql: makeSqlThrowingOnTerminalUpdate(permanentErr),
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });

        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_t4_permanent' }));

        // Drain must NOT have been called for a non-transient error.
        expect(enqueueSpy).not.toHaveBeenCalled();

        expect(runner.isExecutionQuiescent()).toBe(false); // Permanent terminal persistence remains owned UNKNOWN.
        enqueueSpy.mockRestore();
        await runner.stop();
    });
});

// ── T5: circuit-breaker wiring at terminal-write call sites ──────────────────
//
// `writeTerminalToPostgres` reports run outcomes to the circuit breaker:
//   - state='completed' → breaker.reportSuccess(taskId)
//   - state='failed'    → breaker.reportFailure(taskId, { kind })
//   - state='cancelled' → neither (cancels must not accumulate against quota)
//
// The taskId argument is only supplied at the outcome call sites (completed /
// failed); watchdog + cancel call sites omit it to prevent misclassification.
//
// Regression signal: if the circuit-breaker reporting block in
// writeTerminalToPostgres is removed, or the cancelled guard is dropped,
// the corresponding spy assertions fail.

describe('TaskRunner.writeTerminalToPostgres — circuit-breaker wiring (T5)', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('calls reportSuccess(taskId) on a completed run', async () => {
        const fakeSql = makeFakeSql();
        // Seed the processing_version response so the guard passes.
        fakeSql.responses.set('SELECT processing_version', [{ processing_version: null }]);

        const { CircuitBreaker } = await import('./circuit-breaker.js');
        const reportSuccessSpy = vi
            .spyOn(CircuitBreaker.prototype, 'reportSuccess')
            .mockResolvedValue(undefined);
        const reportFailureSpy = vi
            .spyOn(CircuitBreaker.prototype, 'reportFailure')
            .mockResolvedValue(undefined);

        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [{ id: 'basic-task', execute: async () => ({ success: true }) }],
        });

        await callProcessor(makeJob({ name: 'basic-task', runId: 'run_t5_ok' }));

        expect(reportSuccessSpy).toHaveBeenCalledWith('basic-task');
        expect(reportFailureSpy).not.toHaveBeenCalled();

        reportSuccessSpy.mockRestore();
        reportFailureSpy.mockRestore();
        await runner.stop();
    });

    it('calls reportFailure(taskId, {kind}) on a transient/fatal failed run', async () => {
        // Only transient/fatal failures drive the circuit breaker — permanent
        // failures are deterministic and are deliberately NOT reported (see the
        // permanent-skip in writeTerminalToPostgres and the test below). So this
        // wiring test must throw a TRANSIENT error to exercise reportFailure.
        const fakeSql = makeFakeSql();
        fakeSql.responses.set('SELECT processing_version', [{ processing_version: null }]);

        const { CircuitBreaker } = await import('./circuit-breaker.js');
        const reportSuccessSpy = vi
            .spyOn(CircuitBreaker.prototype, 'reportSuccess')
            .mockResolvedValue(undefined);
        const reportFailureSpy = vi
            .spyOn(CircuitBreaker.prototype, 'reportFailure')
            .mockResolvedValue(undefined);

        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new TaskError({ message: 'boom', kind: 'transient' });
                    },
                },
            ],
        });

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_t5_fail' })),
        ).rejects.toThrow('boom');

        expect(reportFailureSpy).toHaveBeenCalledWith(
            'basic-task',
            expect.objectContaining({
                kind: expect.stringMatching(/^(transient|fatal)$/),
            }),
        );
        expect(reportSuccessSpy).not.toHaveBeenCalled();

        reportSuccessSpy.mockRestore();
        reportFailureSpy.mockRestore();
        await runner.stop();
    });

    it('does NOT call reportFailure on a permanent failed run (deterministic — kept off the circuit)', async () => {
        // A plain Error (no retryOn match, not a network error) classifies as
        // permanent. Counting permanent failures toward the circuit threshold
        // would open the circuit + fire a CRITICAL alert for a backlog of
        // malformed data, which is noise. Only transient/fatal drive the count.
        const fakeSql = makeFakeSql();
        fakeSql.responses.set('SELECT processing_version', [{ processing_version: null }]);

        const { CircuitBreaker } = await import('./circuit-breaker.js');
        const reportSuccessSpy = vi
            .spyOn(CircuitBreaker.prototype, 'reportSuccess')
            .mockResolvedValue(undefined);
        const reportFailureSpy = vi
            .spyOn(CircuitBreaker.prototype, 'reportFailure')
            .mockResolvedValue(undefined);

        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async () => {
                        throw new Error('boom');
                    },
                },
            ],
        });

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_t5_perm' })),
        ).rejects.toThrow('boom');

        expect(reportFailureSpy).not.toHaveBeenCalled();
        expect(reportSuccessSpy).not.toHaveBeenCalled();

        reportSuccessSpy.mockRestore();
        reportFailureSpy.mockRestore();
        await runner.stop();
    });

    it('calls neither reportSuccess nor reportFailure on a cancelled run', async () => {
        // Cancel path: abort.signal is tripped, runner writes 'cancelled'.
        // The cancelled terminal must NOT report to the breaker — cancels are
        // operator decisions and must not count toward failure/success quotas.
        const fakeSql = makeFakeSql();
        fakeSql.responses.set('SELECT processing_version', [{ processing_version: null }]);

        const { CircuitBreaker } = await import('./circuit-breaker.js');
        const reportSuccessSpy = vi
            .spyOn(CircuitBreaker.prototype, 'reportSuccess')
            .mockResolvedValue(undefined);
        const reportFailureSpy = vi
            .spyOn(CircuitBreaker.prototype, 'reportFailure')
            .mockResolvedValue(undefined);

        // Wire a cancel subscription that fires mid-execution, then the plugin
        // throws to enter the cancellation branch.
        const cancelHandlers = new Map<string, (msg: string) => void>();
        const subscribeImpl = async (channel: string, cb: (msg: string) => void) => {
            cancelHandlers.set(channel, cb);
            return async () => {
                cancelHandlers.delete(channel);
            };
        };

        const { runner, callProcessor } = await bootRunner({
            sql: fakeSql.sql,
            subscribeImpl,
            tasks: [
                {
                    id: 'basic-task',
                    execute: async (ctx) => {
                        // Fire the cancel signal mid-run.
                        const handler = cancelHandlers.get('task:cancel');
                        if (handler) handler(JSON.stringify({ runId: ctx.runId }));
                        await Promise.resolve(); // yield so abort fires
                        throw new Error('aborted');
                    },
                },
            ],
        });

        await expect(
            callProcessor(makeJob({ name: 'basic-task', runId: 'run_t5_cancel' })),
        ).rejects.toThrow('aborted');

        // Cancelled run: neither breaker method must have been called.
        expect(reportSuccessSpy).not.toHaveBeenCalled();
        expect(reportFailureSpy).not.toHaveBeenCalled();

        reportSuccessSpy.mockRestore();
        reportFailureSpy.mockRestore();
        await runner.stop();
    });
});

it('retains downstream history and parent linkage after an unknown queue add ACK', async () => {
    const sql = makeFakeSql();
    let delivered: { runId: string; parentRunId: string; input: unknown } | undefined;
    const queue = {
        add: vi.fn(
            async (_name: string, data: { runId: string; parentRunId: string; input: unknown }) => {
                delivered = data;
                throw new QueueOperationUncertainError(
                    '10000000-0000-4000-8000-000000000001',
                    new Error('lost queue ack'),
                );
            },
        ),
    };
    const { runner, callProcessor } = await bootRunner({
        sql: sql.sql,
        queueFactory: () => queue as unknown as BullQueue,
        tasks: [
            { id: 'unknown-child', execute: async () => ({ success: true }) },
            {
                id: 'unknown-parent',
                execute: async () => ({
                    success: true,
                    downstream: [{ taskId: 'unknown-child', input: { value: 9 } }],
                }),
            },
        ],
    });
    try {
        await callProcessor(makeJob({ name: 'unknown-parent', runId: 'run_unknown_parent' }));
        expect(delivered).toMatchObject({ parentRunId: 'run_unknown_parent', input: { value: 9 } });
        const row = sql.calls.find(
            (call) =>
                call.head.includes('INSERT INTO task_history') &&
                call.values[0] === delivered?.runId,
        );
        expect(row?.values.slice(0, 3)).toEqual([
            delivered?.runId,
            'unknown-child',
            'run_unknown_parent',
        ]);
        expect(row?.values[5]).toEqual({ value: 9 });
    } finally {
        await runner.stop();
    }
});

it('does not report completion or release identity when the hard-kill reservation refuses completion', async () => {
    const sql = makeFakeSql();
    const { runner, stateMachine, callProcessor } = await bootRunner({
        sql: sql.sql,
        tasks: [
            {
                id: 'reserved-completion',
                execute: async () => ({ success: true, itemsProcessed: 3 }),
            },
        ],
    });
    stateMachine.transitionRun.mockImplementation(async (opts: { to: string }) =>
        opts.to === 'completed'
            ? { ok: false, error: 'hard kill queue cleanup pending' }
            : { ok: true },
    );
    const invokeSpy = vi
        .spyOn(luaLoader, 'invoke')
        .mockResolvedValue(1 as unknown as Awaited<ReturnType<typeof luaLoader.invoke>>);
    try {
        await expect(
            callProcessor(
                makeJob({
                    name: 'reserved-completion',
                    runId: 'run_reserved',
                    exclusivityKey: 'task:identity:reserved',
                }),
            ),
        ).rejects.toMatchObject({ code: 'not_drained' });
        expect(
            sql.calls.some(
                (call) =>
                    call.head.includes('UPDATE task_history') && call.values[0] === 'completed',
            ),
        ).toBe(false);
        expect(invokeSpy.mock.calls.some((call) => call[0] === 'release-identity')).toBe(false);
    } finally {
        invokeSpy.mockRestore();
        await runner.stop();
    }
});

it('reports quiescence per run: a finished run is quiescent while another still executes', async () => {
    const sql = makeFakeSql();
    const now = new Date();
    sql.responses.set('UPDATE task_history', [
        {
            id: 'run_quiet_done',
            task_id: 'quiet-done',
            label: 'quiet-done',
            state: 'completed',
            scope: null,
            trigger: { kind: 'manual' },
            actor: { type: 'system' },
            started_at: now,
            completed_at: now,
            heartbeat_at: now,
            stages: [],
            error: null,
        },
    ]);
    let entered: () => void = () => {};
    const liveEntered = new Promise<void>((resolve) => {
        entered = resolve;
    });
    let release: () => void = () => {};
    const liveReleased = new Promise<void>((resolve) => {
        release = resolve;
    });
    const { runner, callProcessor } = await bootRunner({
        sql: sql.sql,
        tasks: [
            { id: 'quiet-done', execute: async () => ({ success: true }) },
            {
                id: 'quiet-live',
                execute: async () => {
                    entered();
                    await liveReleased;
                    return { success: true };
                },
            },
        ],
    });
    try {
        await callProcessor(makeJob({ name: 'quiet-done', runId: 'run_quiet_done' }));
        const live = callProcessor(makeJob({ name: 'quiet-live', runId: 'run_quiet_live' }));
        await liveEntered;
        expect(runner.isRunQuiescent('run_quiet_done')).toBe(true);
        expect(runner.isRunQuiescent('run_quiet_live')).toBe(false);
        expect(runner.isExecutionQuiescent()).toBe(false);
        release();
        await live;
        expect(runner.isRunQuiescent('run_quiet_live')).toBe(true);
    } finally {
        release();
        await runner.stop();
    }
});

describe('playback pressure admission', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('defers the same CPU job without claiming, executing, or consuming an attempt; resumes when clear', async () => {
        vi.useFakeTimers();
        const pressure = vi.spyOn(playbackPressure, 'getPlaybackPressure');
        pressure.mockResolvedValue(
            playbackPressure.decidePlaybackPressure(
                [
                    {
                        cpuTranscodes: 1,
                        gpuTranscodes: 0,
                        activeSessions: 1,
                        loadRatioPerCore: 0.1,
                        sampledAt: Date.now(),
                    },
                ],
                1.25,
                undefined,
            ),
        );
        vi.spyOn(playbackPressure, 'acquirePlaybackCpuSlot').mockResolvedValue(null);
        const execute = vi.fn(async () => ({ success: true }));
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'guarded-cpu', resourceClass: 'cpu', execute }],
        });
        const job = makeJob({ name: 'guarded-cpu', runId: 'run_cpu_guard' });
        const moveToDelayed = vi.fn(async () => {});
        job.moveToDelayed = moveToDelayed;
        job.updateData = vi.fn(async (data) => {
            job.data = data;
        });
        try {
            const deferred = expect(callProcessor(job)).rejects.toBeInstanceOf(DelayedError);
            await vi.advanceTimersByTimeAsync(0);
            expect(moveToDelayed).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(250);
            await deferred;
            expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
            expect(execute).not.toHaveBeenCalled();
            expect(stateMachine.claimRun).not.toHaveBeenCalled();
            expect(stateMachine.transitionRun).not.toHaveBeenCalled();
            expect(job.attemptsMade).toBe(0);
            pressure.mockResolvedValue(playbackPressure.decidePlaybackPressure([], 2));
            await callProcessor(job);
            expect(execute).toHaveBeenCalledOnce();
        } finally {
            await runner.stop();
            vi.useRealTimers();
        }
    });

    it('does not gate IO tasks during CPU playback', async () => {
        const pressure = vi.spyOn(playbackPressure, 'getPlaybackPressure');
        const execute = vi.fn(async () => ({ success: true }));
        const { runner, callProcessor } = await bootRunner({ tasks: [{ execute }] });
        try {
            await callProcessor(makeJob({ name: 'basic-task', runId: 'run_io_guard' }));
            expect(pressure).not.toHaveBeenCalled();
            expect(execute).toHaveBeenCalledOnce();
        } finally {
            await runner.stop();
        }
    });
    it('runs a deferred job once after 15 minutes even if pressure persists', async () => {
        vi.spyOn(playbackPressure, 'getPlaybackPressure').mockResolvedValue(
            playbackPressure.decidePlaybackPressure(
                [
                    {
                        cpuTranscodes: 1,
                        gpuTranscodes: 0,
                        activeSessions: 1,
                        loadRatioPerCore: 0,
                        sampledAt: Date.now(),
                    },
                ],
                2,
            ),
        );
        const slot = vi.spyOn(playbackPressure, 'acquirePlaybackCpuSlot').mockResolvedValue(null);
        const visibility = vi.spyOn(playbackPressure, 'recordPlaybackDeferral');
        const execute = vi.fn(async () => ({ success: true }));
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id: 'cap-cpu', resourceClass: 'cpu', execute }],
        });
        const job = makeJob({ name: 'cap-cpu', runId: 'run_cap' });
        job.data.playbackDeferredAt = Date.now() - 15 * 60_000;
        try {
            await callProcessor(job);
            expect(execute).toHaveBeenCalledOnce();
            expect(slot).not.toHaveBeenCalled();
            expect(visibility).toHaveBeenCalledWith(expect.any(Function), 'run_cap', undefined);
        } finally {
            await runner.stop();
        }
    });
    it.each([
        ['file-system-scan-probe', false],
        ['manual-cpu', true],
    ] as const)('exempts %s before reading pressure', async (id, manual) => {
        const pressure = vi.spyOn(playbackPressure, 'getPlaybackPressure');
        const execute = vi.fn(async () => ({ success: true }));
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id, resourceClass: 'cpu', execute }],
        });
        const job = makeJob({ name: id, runId: 'run_exempt' });
        job.data.playbackCpuExempt = manual;
        try {
            await callProcessor(job);
            expect(execute).toHaveBeenCalledOnce();
            expect(pressure).not.toHaveBeenCalled();
        } finally {
            await runner.stop();
        }
    });
    it('a pressure client failure does not turn admission into a task failure', async () => {
        const original = playbackPressure.getPlaybackPressure;
        vi.spyOn(playbackPressure, 'getPlaybackPressure').mockImplementation(async (client) => {
            expect(typeof client).toBe('function');
            return original(() => {
                throw new Error('task Valkey offline');
            });
        });
        const execute = vi.fn(async () => ({ success: true }));
        const { runner, callProcessor } = await bootRunner({
            tasks: [{ id: 'offline-cpu', resourceClass: 'cpu', execute }],
        });
        try {
            await callProcessor(makeJob({ name: 'offline-cpu', runId: 'run_offline' }));
            expect(execute).toHaveBeenCalledOnce();
        } finally {
            await runner.stop();
        }
    });
});

it('logs the expected multi-stage auto-recorder bypass at debug', async () => {
    const log = Logger.for('TaskRunner');
    const warn = vi.spyOn(log, 'warn');
    const debug = vi.spyOn(log, 'debug');
    const { runner, callProcessor } = await bootRunner({
        tasks: [
            {
                id: 'multi-probe',
                execute: async () => ({ success: true, itemsProcessed: 0 }),
                coversStages: ['probe-a', 'probe-b'].map((id) => ({
                    id,
                    appliesTo: ['movie'] as const,
                    enqueueable: false,
                    terminalDisposition: { kind: 'self-terminal' as const, ruleId: 'test-managed' },
                })),
            },
        ],
    });
    try {
        await callProcessor(makeJob({ name: 'multi-probe', runId: 'run_multi' }));
        expect(
            warn.mock.calls.filter(([message]) => message.includes('single-stage limit')),
        ).toHaveLength(0);
        expect(debug).toHaveBeenCalledWith(
            expect.stringContaining('multi-probe declares 2 stages'),
        );
    } finally {
        await runner.stop();
        warn.mockRestore();
        debug.mockRestore();
    }
});

describe('TaskRunner stalled redelivery safety', () => {
    it('defers a redelivery while the old handler still has side effects in flight', async () => {
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const execute = vi.fn(async () => {
            await pending;
            return { success: true };
        });
        const { runner, callProcessor, stateMachine } = await bootRunner({ tasks: [{ execute }] });
        const first = callProcessor(makeJob({ name: 'basic-task', runId: 'still-live' }));
        try {
            await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
            const redelivery = makeJob({ name: 'basic-task', runId: 'still-live' });
            redelivery.attemptsStarted = 2;
            redelivery.moveToDelayed = vi.fn(async () => {});
            await expect(callProcessor(redelivery)).rejects.toBeInstanceOf(DelayedError);
            expect(execute).toHaveBeenCalledOnce();
            expect(stateMachine.claimRun).toHaveBeenCalledOnce();
            expect(redelivery.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
        } finally {
            finish();
            await first;
            await runner.stop();
        }
    });
    it('preserves the existing resume refusal for a stalled delivery of a reclaimed run', async () => {
        const fake = makeFakeSql();
        fake.responses.set('SELECT state, result, error', [
            {
                state: 'failed',
                result: null,
                error: { message: 'orphaned_at_recovery: resumed as run_next' },
            },
        ]);
        fake.responses.set('SELECT id FROM task_history', [{ id: 'run_resumed' }]);
        const execute = vi.fn(async () => ({ success: true }));
        const { runner, callProcessor, stateMachine } = await bootRunner({
            tasks: [{ execute }],
            sql: fake.sql,
        });
        try {
            const job = makeJob({ name: 'basic-task', runId: 'run_resumed' }) as RunnerJob;
            job.attemptsStarted = 2;
            job.data.resume = { rootRunId: 'run_resumed' };
            await expect(callProcessor(job)).resolves.toMatchObject({ redeliveryRefused: true });
            expect(execute).not.toHaveBeenCalled();
            expect(stateMachine.claimRun).not.toHaveBeenCalled();
        } finally {
            await runner.stop();
        }
    });

    it('acknowledges an already-completed delivery without executing again', async () => {
        const fake = makeFakeSql();
        const result = { success: true, itemsProcessed: 7 };
        fake.responses.set('SELECT state, result, error', [
            { state: 'completed', result, error: null },
        ]);
        const execute = vi.fn(async () => ({ success: true }));
        const { runner, callProcessor, stateMachine } = await bootRunner({
            tasks: [{ execute }],
            sql: fake.sql,
        });
        try {
            const job = makeJob({ name: 'basic-task', runId: 'already-done' });
            job.attemptsStarted = 2;
            expect(await callProcessor(job)).toEqual(result);
            expect(execute).not.toHaveBeenCalled();
            expect(stateMachine.claimRun).not.toHaveBeenCalled();
        } finally {
            await runner.stop();
        }
    });
});

describe('task resilience review regressions', () => {
    afterEach(() => vi.restoreAllMocks());

    it('does not publish terminal failure bookkeeping for an attempt awaiting retry', async () => {
        const fake = makeFakeSql();
        const { runner, callProcessor } = await bootRunner({
            sql: fake.sql,
            tasks: [
                {
                    id: 'retry-safe',
                    retryAttempts: 3,
                    execute: async () => {
                        throw new TaskError({ kind: 'transient', message: 'storage unavailable' });
                    },
                },
            ],
        });
        const terminal = vi.spyOn(
            runner as unknown as { writeTerminalToPostgres(...args: unknown[]): Promise<void> },
            'writeTerminalToPostgres',
        );
        try {
            await expect(
                callProcessor(makeJob({ name: 'retry-safe', runId: 'review-retry' })),
            ).rejects.toThrow('storage unavailable');
            expect(terminal).not.toHaveBeenCalled();
        } finally {
            await runner.stop();
        }
    });

    it('releases the identity after claimRun rejects the final attempt', async () => {
        const invoke = vi.spyOn(luaLoader, 'invoke').mockResolvedValue(1);
        const { runner, stateMachine, callProcessor } = await bootRunner({
            tasks: [{ id: 'claim-final', execute: async () => ({ success: true }) }],
        });
        stateMachine.claimRun.mockResolvedValueOnce({ ok: false, error: 'state mismatch' });
        try {
            await expect(
                callProcessor(
                    makeJob({
                        name: 'claim-final',
                        runId: 'claim-final-run',
                        exclusivityKey: 'review-identity',
                    }),
                ),
            ).rejects.toThrow('claimRun failed');
            expect(invoke).toHaveBeenCalledWith(
                'release-identity',
                ['review-identity'],
                ['claim-final-run'],
                expect.anything(),
                undefined,
            );
        } finally {
            await runner.stop();
        }
    });

    it('renews the identity at attempt start and each heartbeat, then aborts immediately on lease loss', async () => {
        const invoke = vi.spyOn(luaLoader, 'invoke').mockResolvedValue(1);
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let signal!: AbortSignal;
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'identity-renew',
                    exclusiveWith: { scope: 'global', ttl: '130m' },
                    timeout: { hard: '120m', soft: '110m' },
                    execute: async (ctx) => {
                        signal = ctx.signal;
                        entered();
                        await new Promise<void>((resolve) =>
                            ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
                        );
                        return { success: false };
                    },
                },
            ],
        });
        const pending = callProcessor(
            makeJob({ name: 'identity-renew', runId: 'renew-run', exclusivityKey: 'renew-key' }),
        ).catch(() => undefined);
        try {
            await started;
            expect(invoke.mock.calls.filter(([name]) => name === 'refresh-identity')).toHaveLength(
                1,
            );
            await (runner as unknown as { heartbeatOnce(id: string): Promise<void> }).heartbeatOnce(
                'renew-run',
            );
            const refreshes = invoke.mock.calls.filter(([name]) => name === 'refresh-identity');
            expect(refreshes).toHaveLength(2);
            expect(refreshes[0].slice(1, 3)).toEqual([['renew-key'], ['renew-run', '7800000']]);
            runner.haltClaims();
            expect(signal.aborted).toBe(true);
        } finally {
            await runner.stop();
            await pending;
        }
    });
});

it('stops queue retries when the durable stage budget is exhausted', async () => {
    const sql = makeFakeSql();
    sql.responses.set('INSERT INTO media_item_stage_state', [{ attempt: 2 }]);
    const { runner, callProcessor } = await bootRunner({
        sql: sql.sql,
        tasks: [
            {
                id: 'stage-budget',
                retryAttempts: 6,
                coversStages: [
                    {
                        id: 'stage-budget',
                        appliesTo: ['movie'],
                        enqueueable: false,
                        terminalDisposition: { kind: 'self-terminal', ruleId: 'test-managed' },
                        retryPolicy: { maxAttempts: 3 },
                    },
                ],
                execute: async () => {
                    throw new TaskError({
                        kind: 'transient',
                        message: 'dependency still unavailable',
                    });
                },
            },
        ],
    });
    try {
        await expect(
            callProcessor(
                makeJob({
                    name: 'stage-budget',
                    runId: 'stage-budget-run',
                    input: { mediaItemId: '11111111-1111-1111-1111-111111111111' },
                }),
            ),
        ).rejects.toBeInstanceOf(UnrecoverableError);
    } finally {
        await runner.stop();
    }
});

it('parks claimRun active-state mismatches without exhausting retry attempts or releasing identity', async () => {
    const invoke = vi.spyOn(luaLoader, 'invoke').mockResolvedValue(1);
    const execute = vi.fn(async () => ({ success: true }));
    const { runner, stateMachine, callProcessor } = await bootRunner({
        tasks: [{ id: 'live-claim', execute }],
    });
    stateMachine.claimRun.mockResolvedValueOnce({
        ok: false,
        error: 'state mismatch: expected pending got active',
    });
    const job = makeJob({
        name: 'live-claim',
        runId: 'live-claim-run',
        exclusivityKey: 'live-claim-key',
    });
    const moveToDelayed = vi.fn(async () => {});
    Object.assign(job, { moveToDelayed });
    try {
        await expect(callProcessor(job)).rejects.toBeInstanceOf(DelayedError);
        expect(moveToDelayed).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
        expect(invoke.mock.calls.some(([name]) => name === 'release-identity')).toBe(false);
    } finally {
        invoke.mockRestore();
        await runner.stop();
    }
});

it('does not execute after an identity mutex has passed to a successor', async () => {
    const invoke = vi.spyOn(luaLoader, 'invoke').mockResolvedValue(0);
    const execute = vi.fn(async () => ({ success: true }));
    const { runner, callProcessor } = await bootRunner({
        tasks: [{ id: 'lost-identity', execute }],
    });
    try {
        await expect(
            callProcessor(
                makeJob({
                    name: 'lost-identity',
                    runId: 'lost-run',
                    exclusivityKey: 'successor-key',
                }),
            ),
        ).rejects.toBeInstanceOf(UnrecoverableError);
        expect(execute).not.toHaveBeenCalled();
    } finally {
        invoke.mockRestore();
        await runner.stop();
    }
});

describe('pre-execution identity cleanup and ownership diagnostics', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([0, 2])(
        'keeps the activation-bail mutex only while a retry remains (attemptsMade=%s)',
        async (attemptsMade) => {
            const invoke = vi.spyOn(luaLoader, 'invoke').mockResolvedValue(1);
            const execute = vi.fn(async () => ({ success: true }));
            const { runner, stateMachine, callProcessor } = await bootRunner({
                tasks: [{ id: 'activation-bail', retryAttempts: 3, execute }],
            });
            stateMachine.transitionRun.mockRejectedValueOnce(new Error('connection closed'));
            try {
                await expect(
                    callProcessor(
                        makeJob({
                            name: 'activation-bail',
                            runId: 'activation-bail-run',
                            attemptsMade,
                            exclusivityKey: 'activation-key',
                        }),
                    ),
                ).rejects.toThrow('pending→active transition failed');
                expect(execute).not.toHaveBeenCalled();
                expect(
                    invoke.mock.calls.filter(([name]) => name === 'release-identity'),
                ).toHaveLength(attemptsMade === 2 ? 1 : 0);
            } finally {
                await runner.stop();
            }
        },
    );

    it('logs heartbeat identity loss as ownership loss and aborts the handler', async () => {
        const invoke = vi.spyOn(luaLoader, 'invoke').mockResolvedValueOnce(1).mockResolvedValue(0);
        const warn = vi.spyOn(Logger.for('TaskRunner'), 'warn');
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        let signal!: AbortSignal;
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'heartbeat-owner-loss',
                    execute: async (ctx) => {
                        signal = ctx.signal;
                        enter();
                        await new Promise<void>((resolve) =>
                            ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
                        );
                        return { success: false };
                    },
                },
            ],
        });
        const pending = callProcessor(
            makeJob({
                name: 'heartbeat-owner-loss',
                runId: 'heartbeat-lost',
                exclusivityKey: 'heartbeat-key',
            }),
        ).catch(() => undefined);
        try {
            await entered;
            await (runner as unknown as { heartbeatOnce(id: string): Promise<void> }).heartbeatOnce(
                'heartbeat-lost',
            );
            expect(signal.aborted).toBe(true);
            expect(warn).toHaveBeenCalledWith(
                'Task identity ownership lost during heartbeat',
                expect.objectContaining({ runId: 'heartbeat-lost' }),
            );
            expect(warn.mock.calls.some(([message]) => message === 'Valkey heartbeat failed')).toBe(
                false,
            );
            expect(invoke).toHaveBeenCalled();
        } finally {
            await runner.stop();
            await pending;
        }
    });
});

describe('cancel flow identity release', () => {
    afterEach(() => vi.restoreAllMocks());
    it.each(['cancelling', 'cancelled'] as const)(
        'holds a skipped delivery mutex until cancellation is terminal (%s)',
        async (state) => {
            const invoke = vi.spyOn(luaLoader, 'invoke').mockResolvedValue(1);
            const client = makeFakeClient();
            const command = client.customCommand.getMockImplementation()!;
            client.customCommand.mockImplementation(async (cmd: string[]) => {
                if (cmd[0] === 'HGET' && cmd[2] === 'state') return state;
                return command(cmd);
            });
            const execute = vi.fn(async () => ({ success: true }));
            const { runner, stateMachine, callProcessor } = await bootRunner({
                client,
                tasks: [{ id: 'cancel-skip', execute }],
            });
            stateMachine.reseedForRetry.mockResolvedValueOnce('skipped');
            try {
                await expect(
                    callProcessor(
                        makeJob({
                            name: 'cancel-skip',
                            runId: 'cancel-skip-run',
                            exclusivityKey: 'cancel-skip-key',
                        }),
                    ),
                ).rejects.toMatchObject({ kind: 'permanent' });
                expect(execute).not.toHaveBeenCalled();
                expect(
                    invoke.mock.calls.filter(([name]) => name === 'release-identity'),
                ).toHaveLength(state === 'cancelled' ? 1 : 0);
            } finally {
                await runner.stop();
            }
        },
    );

    it('releases a terminal cancelled mutex even when BullMQ attempts remain', async () => {
        const invoke = vi.spyOn(luaLoader, 'invoke').mockResolvedValue(1);
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const { runner, callProcessor } = await bootRunner({
            tasks: [
                {
                    id: 'cancel-active',
                    retryAttempts: 3,
                    execute: async (ctx) => {
                        enter();
                        await new Promise<void>((_resolve, reject) =>
                            ctx.signal.addEventListener(
                                'abort',
                                () => reject(new Error('cancelled')),
                                { once: true },
                            ),
                        );
                        return { success: false };
                    },
                },
            ],
        });
        const pending = callProcessor(
            makeJob({
                name: 'cancel-active',
                runId: 'cancel-active-run',
                exclusivityKey: 'cancel-active-key',
            }),
        );
        const assertion = expect(pending).rejects.toThrow('cancelled');
        try {
            await entered;
            runner.cancelExecution('cancel-active-run');
            await assertion;
            expect(invoke.mock.calls.filter(([name]) => name === 'release-identity')).toHaveLength(
                1,
            );
        } finally {
            await runner.stop();
        }
    });
});

describe('TaskRunner.stop — Worker close with and without a job in flight', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('gives up on an idle Worker whose close never returns (Valkey gone), after a short bound', async () => {
        vi.useFakeTimers();
        const { runner, fakeWorker } = await bootRunner({
            tasks: [{ id: 'idle-task', execute: vi.fn(async () => ({ success: true })) }],
        });
        fakeWorker.close = () => new Promise<void>(() => {});
        const stopping = runner.stop();
        await vi.advanceTimersByTimeAsync(2_500);
        await expect(stopping).resolves.toBeUndefined();
    });

    it('does not force-close a Worker while a job is still in its first phase, and aborts that job', async () => {
        vi.useFakeTimers();
        let releaseClaim: (v: { ok: boolean }) => void = () => {};
        const execute = vi.fn(async () => ({ success: true }));
        const { runner, stateMachine, fakeWorker, callProcessor } = await bootRunner({
            tasks: [{ id: 'early-task', execute }],
        });
        // The job is claimed late: no abort controller and no heartbeat exist yet.
        stateMachine.claimRun.mockImplementationOnce(
            () => new Promise((resolve) => (releaseClaim = resolve)),
        );
        let closed = false;
        let finishClose: () => void = () => {};
        fakeWorker.close = () =>
            new Promise<void>((resolve) => {
                finishClose = () => {
                    closed = true;
                    resolve();
                };
            });
        const job = callProcessor(makeJob({ name: 'early-task', runId: 'early-run' }));
        job.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(10);
        expect(runner.hasExecutingJobs()).toBe(true);

        let stopped = false;
        const stopping = runner.stop().then(() => {
            stopped = true;
        });
        // Far beyond the 2 s bound for an idle Worker: the job is still running.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(stopped).toBe(false);
        expect(closed).toBe(false);
        // The run is marked as interrupted by the shutdown and asked to stop.
        const internals = runner as unknown as {
            requestedExecutionCancels: Set<string>;
            shutdownInterrupted: Set<string>;
        };
        expect(internals.requestedExecutionCancels.has('early-run')).toBe(true);
        expect(internals.shutdownInterrupted.has('early-run')).toBe(true);

        releaseClaim({ ok: false });
        await vi.advanceTimersByTimeAsync(10);
        finishClose();
        await vi.advanceTimersByTimeAsync(10);
        await stopping;
        expect(stopped).toBe(true);
    });
});
