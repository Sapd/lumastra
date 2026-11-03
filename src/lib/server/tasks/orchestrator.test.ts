// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for TaskOrchestrator — mocks Valkey, Postgres, BullMQ Queue +
 * QueueEvents, FlowProducer. No live infrastructure required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import type { StateMachine } from './state-machine.js';
import { Reconciler } from './reconciler.js';
import { PendingWriteDrain } from './pending-write-drain.js';
import { PushOutbox } from './push-outbox.js';
import type postgres from 'postgres';
import type { Queue, FlowProducer, QueueEvents, FlowJob } from 'bullmq';
import {
    TaskOrchestrator,
    parseHGetAll,
    LeaderLock,
    TransitionBatcher,
    getOrchestrator,
    orchestrator,
} from './orchestrator.js';
import { shouldStartWorkers } from '$lib/server/config.js';
import { detectVersionBumps } from '$lib/server/services/stage-version-detector.js';
import { RunSchema } from '$lib/schemas/run.schema.js';
import {
    getCoordinationClient,
    getValkeyClient,
    publishMessage,
} from '$lib/server/cache/valkey.js';
import { taskJobId, taskJobOrigin } from '../../../task-runtime/authority/queue-origin.js';
import { QueueOperationUncertainError } from '../../../task-runtime/authority/queue-write.js';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('./builtin/index.js', () => ({ loadBuiltins: async () => {} }));
vi.mock('$lib/server/services/stage-version-detector.js', () => ({
    detectVersionBumps: vi.fn(async () => {}),
}));

const watcherRepair = vi.hoisted(() => ({ fail: true, repairs: [] as string[] }));
vi.mock('./builtin/native/media-sources/file-scanner.js', () => ({
    fileScannerMediaSource: {
        stopWatching: async () => {
            if (watcherRepair.fail) throw new Error('watcher repair submission unavailable');
            const { orchestrator: submitter } = await import('./orchestrator.js');
            const accepted = await submitter.startRun(
                'basic-task',
                { name: 'watcher-repair' },
                {
                    trigger: { kind: 'in-process', sourceRoute: 'watcher-stop-repair' },
                },
            );
            watcherRepair.repairs.push(accepted.runId);
        },
    },
}));

// Real ownership transactions/scripts are covered by real-store integration tests.
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
// Exercise the in-memory command adapter, retaining authority capture; real
// atomic ownership-prefix checks are covered by the Valkey integration suite.
vi.mock('./lua/fenced.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./lua/fenced.js')>()),
    invokeFencedValkey: async (
        source: string,
        keys: string[],
        argv: Array<string | number>,
        client: { customCommand(command: string[]): Promise<unknown> },
    ): Promise<unknown> => {
        const args = argv.map(String);
        if (source.includes('-- task-pending-enqueue-v1')) {
            const length = Number(await client.customCommand(['LLEN', keys[0]]));
            let dropped: unknown = null;
            if (length >= Number(args[1])) {
                dropped = await client.customCommand(['LMOVE', keys[0], keys[1], 'RIGHT', 'LEFT']);
                await client.customCommand(['LTRIM', keys[1], '0', String(Number(args[2]) - 1)]);
                await client.customCommand(['PEXPIRE', keys[1], args[3]]);
            }
            await client.customCommand(['LPUSH', keys[0], args[0]]);
            return dropped;
        }
        if (source.startsWith('return redis.call(ARGV[1]'))
            return client.customCommand([args[0], keys[0], ...args.slice(1)]);
        if (source.startsWith("return redis.call('LMOVE'"))
            return client.customCommand(['LMOVE', ...keys, ...args]);
        if (source.startsWith("return redis.call('SET'"))
            return client.customCommand([
                'SET',
                keys[0],
                String(argv[0]),
                'NX',
                'PX',
                String(argv[1]),
            ]);
        if (source === "return redis.call('GET', KEYS[1])")
            return client.customCommand(['GET', keys[0]]);
        return client.customCommand([
            'EVAL',
            source,
            String(keys.length),
            ...keys,
            ...argv.map(String),
        ]);
    },
}));
vi.mock('./owned-write.js', () => ({
    invokeOwnedCommand: async (
        command: string[],
        client: { customCommand(command: string[]): Promise<unknown> },
    ) => client.customCommand(command),
}));

vi.mock('$lib/server/cache/valkey.js', async () =>
    (await import('./__fixtures__/task-config-mock.js')).taskValkeyMock(),
);

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

vi.mock('$lib/server/config.js', async () => ({
    // Shared with orchestrator-hard-kill.test.ts — see the fixture's header
    // for why one missing export fails the whole file at collection.
    ...(await import('./__fixtures__/task-config-mock.js')).taskConfigMock(),
    // Exercise the actual dispatcher constructed by the orchestrator. These
    // mirror config.ts defaults, with serial drain for this in-memory SQL seam.
    OUTBOX_DRAIN_BATCH_SIZE: 500,
    OUTBOX_DRAIN_INTERVAL_MS: 10_000,
    OUTBOX_DRAIN_BUDGET_MS: 5_000,
    OUTBOX_DRAIN_CONCURRENCY: 1,
}));

vi.mock('./lua/loader.js', () => ({
    luaLoader: {
        load: vi.fn(async () => {}),
        invoke: vi.fn(async () => ({ ok: 'enqueued' })),
    },
}));

// Default circuit breaker and backpressure mocks — allow everything.
// Prototype methods so individual tests can override via prototype.method = vi.fn(...).
vi.mock('./circuit-breaker.js', () => {
    class MockCircuitBreaker {
        async check() {
            return { allowed: true, state: 'closed' as const };
        }
        async reportSuccess() {}
        async reportFailure() {}
        async forceEnable() {}
    }
    return { CircuitBreaker: MockCircuitBreaker };
});

vi.mock('./backpressure.js', async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    class MockBackpressure {
        async check() {
            return { proceed: true };
        }
    }
    return { ...actual, Backpressure: MockBackpressure };
});

import { luaLoader } from './lua/loader.js';
const mockLuaInvoke = vi.mocked(luaLoader.invoke);
const mockPublishMessage = vi.mocked(publishMessage);

import { taskIdentityPhantomDedupTotal } from './metrics.js';

/**
 * Read the current phantom-dedup counter value for a given task_id label.
 * prom-client's Counter.get() resolves synchronously when no async collect()
 * callback is registered, but is typed as a promise; await is harmless either
 * way (a plain object resolves immediately).
 */
async function readPhantomMetric(taskId: string): Promise<number> {
    const metric = await taskIdentityPhantomDedupTotal.get();
    const entry = metric.values.find((v) => v.labels.task_id === taskId);
    return entry?.value ?? 0;
}

// ── Stub helpers ──────────────────────────────────────────────────────────────

interface FakeClient {
    customCommand: (cmd: string[]) => Promise<unknown>;
    _hashes: Map<string, Map<string, string>>;
    _lists: Map<string, string[]>;
    _published: Array<{ channel: string; message: string }>;
    _setNxStore: Map<string, { value: string; expiresAt: number }>;
}

function makeFakeClient(): FakeClient {
    const hashes = new Map<string, Map<string, string>>();
    const lists = new Map<string, string[]>();
    const published: Array<{ channel: string; message: string }> = [];
    const setNxStore = new Map<string, { value: string; expiresAt: number }>();

    const customCommand = vi.fn(async (cmd: string[]): Promise<unknown> => {
        const op = cmd[0]?.toUpperCase();
        switch (op) {
            case 'HSET': {
                const key = cmd[1];
                let h = hashes.get(key);
                if (!h) {
                    h = new Map();
                    hashes.set(key, h);
                }
                for (let i = 2; i + 1 < cmd.length; i += 2) {
                    h.set(cmd[i], cmd[i + 1]);
                }
                return cmd.length / 2 - 1;
            }
            case 'HGET': {
                const h = hashes.get(cmd[1]);
                return h?.get(cmd[2]) ?? null;
            }
            case 'HGETALL': {
                const h = hashes.get(cmd[1]);
                if (!h) return [];
                const flat: string[] = [];
                for (const [k, v] of h.entries()) flat.push(k, v);
                return flat;
            }
            case 'PEXPIRE':
                return 1;
            case 'LPUSH': {
                const key = cmd[1];
                let l = lists.get(key);
                if (!l) {
                    l = [];
                    lists.set(key, l);
                }
                l.unshift(cmd[2]);
                return l.length;
            }
            case 'RPUSH': {
                const key = cmd[1];
                let l = lists.get(key);
                if (!l) {
                    l = [];
                    lists.set(key, l);
                }
                l.push(cmd[2]);
                return l.length;
            }
            case 'RPOP': {
                const l = lists.get(cmd[1]);
                if (!l || l.length === 0) return null;
                return l.pop()!;
            }
            case 'LLEN':
                return lists.get(cmd[1])?.length ?? 0;
            case 'EXISTS':
                return hashes.has(cmd[1]) ? 1 : 0;
            case 'PUBLISH':
                published.push({ channel: cmd[1], message: cmd[2] });
                return 0;
            case 'GET': {
                const entry = setNxStore.get(cmd[1]);
                return entry && entry.expiresAt > Date.now() ? entry.value : null;
            }
            case 'LMOVE': {
                const source = lists.get(cmd[1]);
                if (!source?.length) return null;
                const raw = cmd[3] === 'LEFT' ? source.shift()! : source.pop()!;
                const target = lists.get(cmd[2]) ?? [];
                lists.set(cmd[2], target);
                if (cmd[4] === 'LEFT') target.unshift(raw);
                else target.push(raw);
                return raw;
            }
            case 'LTRIM': {
                const source = lists.get(cmd[1]);
                if (source) source.splice(Number(cmd[3]) + 1);
                return 'OK';
            }
            case 'SET': {
                const isNx = cmd.includes('NX');
                const key = cmd[1];
                if (isNx && setNxStore.has(key)) {
                    const entry = setNxStore.get(key)!;
                    if (entry.expiresAt > Date.now()) return null;
                }
                const pxIdx = cmd.indexOf('PX');
                const ttl = pxIdx > 0 ? Number(cmd[pxIdx + 1]) : 60_000;
                setNxStore.set(key, {
                    value: cmd[2],
                    expiresAt: Date.now() + ttl,
                });
                return 'OK';
            }
            case 'EVAL': {
                // Renewal compare-and-extend Lua.
                const script = cmd[1];
                const key = cmd[3];
                const expected = cmd[4];
                const entry = setNxStore.get(key);
                if (!entry || entry.value !== expected) return 0;
                if (/PEXPIRE/.test(script)) {
                    entry.expiresAt = Date.now() + Number(cmd[5]);
                    return 1;
                }
                if (/DEL/.test(script)) {
                    setNxStore.delete(key);
                    return 1;
                }
                return 0;
            }
            default:
                return null;
        }
    });

    return {
        customCommand,
        _hashes: hashes,
        _lists: lists,
        _published: published,
        _setNxStore: setNxStore,
    };
}

interface FakeSqlRecorder {
    calls: Array<{ strings: readonly string[]; values: unknown[] }>;
    /** Map keyed by joined SQL template head text → row stub. */
    responses: Map<string, unknown[]>;
    /** Map keyed by joined SQL template head text → error to throw. */
    errors: Map<string, Error>;
}

// Loose stub of postgres.Sql — only the call surface used by the orchestrator.
type FakeSqlFn = ((s: readonly string[], ...v: unknown[]) => Promise<unknown[]>) & {
    json: (v: unknown) => unknown;
    listen?: (channel: string, handler: () => void) => Promise<{ unlisten: () => Promise<void> }>;
};

function makeFakeSql(): {
    sql: FakeSqlFn;
    recorder: FakeSqlRecorder;
    reset: () => void;
} {
    const recorder: FakeSqlRecorder = {
        calls: [],
        responses: new Map(),
        errors: new Map(),
    };
    const sqlFn = ((strings: readonly string[], ...values: unknown[]) => {
        recorder.calls.push({ strings, values });
        const head = (strings[0] || '').trim().slice(0, 80);
        // Check error-injection first.
        for (const [key, err] of recorder.errors) {
            if (head.includes(key)) return Promise.reject(err);
        }
        // Walk recorded responses for a head that matches.
        for (const [key, rows] of recorder.responses) {
            if (head.includes(key)) return Promise.resolve(rows);
        }
        // A normal terminal UPDATE acknowledges the row it persisted. Tests
        // for idempotent/missing rows explicitly override this with zero rows.
        const text = strings.join('');
        if (text.includes('UPDATE task_history') && text.includes('RETURNING task_id'))
            return Promise.resolve([{ task_id: 'basic-task' }]);
        return Promise.resolve([]);
    }) as FakeSqlFn;
    sqlFn.json = (v: unknown) => v;
    return {
        sql: sqlFn,
        recorder,
        reset: () => {
            recorder.calls.length = 0;
            recorder.responses.clear();
            recorder.errors.clear();
        },
    };
}

function makeFakeQueue(): {
    add: ReturnType<typeof vi.fn>;
    getJob: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
} {
    return {
        add: vi.fn(async () => ({ id: 'job-id' })),
        getJob: vi.fn(async () => null),
        close: vi.fn(async () => {}),
    };
}

function makeQueueSubscription(name: string) {
    const events = Object.assign(new EventEmitter(), {
        name,
        close: vi.fn(async () => {
            events.removeAllListeners();
        }),
    });
    return events;
}

function makeTerminalQueue(name: string) {
    return {
        ...makeFakeQueue(),
        name,
        getJob: vi.fn(async (id: string) => ({
            id,
            data: {},
            attemptsMade: 1,
            getState: async () => 'completed',
            returnvalue: { success: true },
            finishedOn: Date.now(),
        })),
    };
}

function makeRegistry() {
    const reg = new TaskRegistry();
    const basicTask = defineTask({
        id: 'basic-task',
        name: 'Basic',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.object({ name: z.string() }),
        identityFor: (input) => input.name,
        async execute() {
            return { success: true };
        },
    });
    reg.registerTask(basicTask);

    const exclusiveTask = defineTask({
        id: 'exclusive-task',
        name: 'Exclusive',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.object({ id: z.string() }),
        identityFor: (input) => input.id,
        exclusiveWith: { scope: 'global', ttl: '24h' },
        async execute() {
            return { success: true };
        },
    });
    reg.registerTask(exclusiveTask);

    return reg;
}

async function bootOrchestrator(opts: {
    client: FakeClient;
    sql?: ReturnType<typeof makeFakeSql>['sql'];
    queue?: ReturnType<typeof makeFakeQueue>;
    leaderShouldAcquire?: boolean;
    authority?: AuthorityToken;
    classes?: import('@sapd/lumastra-plugin-sdk').ResourceClass[];
    queueEventsFactory?: (
        cls: import('@sapd/lumastra-plugin-sdk').ResourceClass,
    ) => QueueEvents | null;
}): Promise<{
    orch: TaskOrchestrator;
    sm: StateMachine;
    queue: ReturnType<typeof makeFakeQueue>;
    transitionSpy: ReturnType<typeof vi.fn>;
}> {
    const reg = makeRegistry();
    const transitionSpy = vi.fn(async () => ({ ok: true }));
    const sm = {
        transitionRun: transitionSpy,
        transitionStage: vi.fn(),
        incrementStage: vi.fn(),
        claimRun: vi.fn(),
    } as unknown as StateMachine;

    const fakeQueue = opts.queue ?? makeFakeQueue();
    // The leader lock SET goes through customCommand; the FakeClient honors NX
    // semantics. For "not leader" scenarios, prepopulate the lock.
    if (opts.leaderShouldAcquire === false) {
        opts.client._setNxStore.set('lock:orch:io', {
            value: 'other',
            expiresAt: Date.now() + 10_000,
        });
    }

    const orch = await TaskOrchestrator.start(opts.classes ?? ['io'], {
        registry: reg,
        stateMachine: sm,
        authority: opts.authority,
        getSql: () => (opts.sql ?? null) as unknown as postgres.Sql | null,
        getClient: () => opts.client,
        instanceId: 'test-instance',
        queueFactory: () => fakeQueue as unknown as Queue,
        queueEventsFactory: opts.queueEventsFactory ?? (() => null),
        flowProducer: null,
    });
    return { orch, sm, queue: fakeQueue, transitionSpy };
}

// ── LeaderLock ────────────────────────────────────────────────────────────────

describe('LeaderLock', () => {
    let client: FakeClient;
    beforeEach(() => {
        client = makeFakeClient();
    });

    it('acquire() returns true on first call and false when held by another', async () => {
        const a = new LeaderLock(client, 'lock:test', 'holder-a', 1000, 200);
        const ok = await a.acquire();
        expect(ok).toBe(true);
        a.stop();

        const b = new LeaderLock(client, 'lock:test', 'holder-b', 1000, 200);
        const ok2 = await b.acquire();
        expect(ok2).toBe(false);
    });

    it('renew() returns true while we still own the key', async () => {
        const a = new LeaderLock(client, 'lock:test', 'holder-a', 1000, 200);
        await a.acquire();
        const ok = await a.renew();
        expect(ok).toBe(true);
        a.stop();
    });

    it('renew() returns false when somebody else owns the key', async () => {
        const a = new LeaderLock(client, 'lock:test', 'holder-a', 1000, 200);
        await a.acquire();
        // Surreptitiously rewrite the lock to another holder.
        client._setNxStore.set('lock:test', {
            value: 'other',
            expiresAt: Date.now() + 5_000,
        });
        const ok = await a.renew();
        expect(ok).toBe(false);
        a.stop();
    });

    it('release() removes the key only when we own it', async () => {
        const a = new LeaderLock(client, 'lock:test', 'holder-a', 1000, 200);
        await a.acquire();
        await a.release();
        expect(client._setNxStore.has('lock:test')).toBe(false);
    });
});

// ── TransitionBatcher ─────────────────────────────────────────────────────────

describe('TransitionBatcher', () => {
    it('coalesces multiple enqueues into a single flush within the window', async () => {
        vi.useFakeTimers();
        const sink = vi.fn(
            async (_batch: Array<{ runId: string; from: string; to: string }>) => {},
        );
        const b = new TransitionBatcher(50, 200, sink);
        b.enqueue({ runId: 'r1', from: 'active', to: 'completed' });
        b.enqueue({ runId: 'r2', from: 'active', to: 'completed' });
        b.enqueue({ runId: 'r3', from: 'active', to: 'failed' });
        await vi.advanceTimersByTimeAsync(60);
        expect(sink).toHaveBeenCalledTimes(1);
        const calls = sink.mock.calls as unknown as Array<[Array<{ runId: string }>]>;
        const batch = calls[0][0];
        expect(batch.map((e) => e.runId)).toEqual(['r1', 'r2', 'r3']);
        vi.useRealTimers();
    });

    it('forces a flush when reaching the max-batch cap', async () => {
        const sink = vi.fn(
            async (_batch: Array<{ runId: string; from: string; to: string }>) => {},
        );
        const b = new TransitionBatcher(60_000, 2, sink);
        b.enqueue({ runId: 'r1', from: 'active', to: 'completed' });
        b.enqueue({ runId: 'r2', from: 'active', to: 'completed' });
        // Wait one microtask for the void flush().
        await Promise.resolve();
        await Promise.resolve();
        expect(sink).toHaveBeenCalledTimes(1);
    });
});

// ── startRun ──────────────────────────────────────────────────────────────────

describe('TaskOrchestrator.startRun', () => {
    let client: FakeClient;
    beforeEach(() => {
        client = makeFakeClient();
        mockLuaInvoke.mockReset();
        mockLuaInvoke.mockResolvedValue({ ok: 'enqueued' });
    });

    it('throws TaskError when taskId is unknown', async () => {
        const { orch } = await bootOrchestrator({ client });
        await expect(orch.startRun('does-not-exist', {})).rejects.toThrow(/Unknown task/);
        await orch.stop();
    });

    it.each([
        { label: 'without authority', authority: undefined },
        {
            label: 'with authority',
            authority: {
                partition: 'tasks',
                generation: '2',
                ownerId: '10000000-0000-4000-8000-000000000001',
            } satisfies AuthorityToken,
        },
    ])('isRunQueued looks up the actual startRun jobId $label', async ({ authority }) => {
        const { orch, queue } = await bootOrchestrator({
            client,
            sql: makeFakeSql().sql,
            authority,
        });
        try {
            const input = { name: 'queued-scan' };
            const { runId } = await orch.startRun('basic-task', input);
            expect(queue.add).toHaveBeenCalledOnce();
            const [, , { jobId }] = queue.add.mock.calls[0] as unknown as [
                string,
                unknown,
                { jobId: string },
            ];
            expect(jobId).toEqual(expect.any(String));
            expect(taskJobOrigin(jobId)).toEqual(authority);

            for (const [state, queued] of [
                ['waiting', true],
                ['prioritized', true],
                ['delayed', true],
                ['active', false],
                ['waiting-children', false],
                ['completed', false],
                ['failed', false],
                ['unknown', false],
                ['missing', false],
            ] as const) {
                queue.getJob.mockClear();
                queue.getJob.mockResolvedValue(
                    state === 'missing'
                        ? null
                        : { name: 'basic-task', getState: async () => state },
                );
                expect(await orch.isRunQueued('basic-task', input, runId), state).toBe(queued);
                expect(queue.getJob.mock.calls, state).toEqual([[jobId]]);
            }
        } finally {
            await orch.stop();
        }
    });

    it('rejects invalid input with a permanent TaskError', async () => {
        const { orch } = await bootOrchestrator({ client });
        await expect(orch.startRun('basic-task', { name: 42 })).rejects.toThrow(/Invalid input/);
        await orch.stop();
    });

    // Regression for the prod 2026-06-13 wedge: a WORKER_MODE=disabled web
    // replica was winning leadership and running a queue-less reconciler that
    // could not reclaim orphans, so stale runs accumulated until the budget
    // saturated and all drain stalled. The web must NEVER lead — even when the
    // lock is freely available — but must still be able to enqueue.
    it('a web replica enqueues without leadership or shared queue consumers', async () => {
        vi.mocked(shouldStartWorkers).mockReturnValue(false);
        const pendingStart = vi.spyOn(PendingWriteDrain.prototype, 'start');
        const pushStart = vi.spyOn(PushOutbox.prototype, 'start');
        try {
            const { orch, queue } = await bootOrchestrator({
                client,
                sql: makeFakeSql().sql,
                leaderShouldAcquire: true,
            });
            expect((orch as unknown as { isAnyLeader(): boolean }).isAnyLeader()).toBe(false);
            expect((orch as unknown as { isCoordinator(): boolean }).isCoordinator()).toBe(false);
            expect(pendingStart).not.toHaveBeenCalled();
            expect(pushStart).not.toHaveBeenCalled();
            const producer = (
                orch as unknown as { webhookOutbox: { start: ReturnType<typeof vi.fn> } }
            ).webhookOutbox;
            expect(producer.start).toHaveBeenCalledWith({ deliver: false });
            await orch.startRun('basic-task', { name: 'ok' });
            expect((queue.add as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
            await orch.stop();
        } finally {
            vi.mocked(shouldStartWorkers).mockReturnValue(true);
            pendingStart.mockRestore();
            pushStart.mockRestore();
        }
    });

    // Regression for the dual-dispatcher review finding: per-class leadership
    // can split across worker replicas (each class lock is elected
    // independently), so the old `isAnyLeader()` gate let two replicas drain
    // the event outbox concurrently in steady state. The coordinator duties
    // (reconciler / event dispatcher / media-added notifier) are gated on a
    // dedicated lock instead — exactly one replica cluster-wide may hold it.
    it('coordinator lock is exclusive — a second replica must not coordinate', async () => {
        const isCoord = (o: TaskOrchestrator): boolean =>
            (o as unknown as { isCoordinator(): boolean }).isCoordinator();
        const { orch: a } = await bootOrchestrator({ client });
        // Same FakeClient = same Valkey: replica B races the same locks.
        const { orch: b } = await bootOrchestrator({ client });
        expect(isCoord(a)).toBe(true);
        expect(isCoord(b)).toBe(false);
        // B lost the io class lock to A as well, but even a replica that DID
        // hold some class must not coordinate without the dedicated lock —
        // isCoordinator is the only gate the singleton services consult.
        await b.stop();
        await a.stop();
    });

    // Regression: the stage-version ledger never advanced on prod because the
    // only callers of detectVersionBumps were recoverOnBoot() (no production
    // caller) and the standby re-acquire path. A replica that wins every lock on
    // its first attempt must still run it, exactly once cluster-wide.
    it('the coordinator runs version-bump detection on first acquisition; a standby does not', async () => {
        vi.mocked(detectVersionBumps).mockClear();
        const { orch: a } = await bootOrchestrator({ client, sql: makeFakeSql().sql });
        await vi.waitFor(() => expect(detectVersionBumps).toHaveBeenCalledTimes(1));
        const { orch: b } = await bootOrchestrator({ client, sql: makeFakeSql().sql });
        await new Promise((r) => setTimeout(r, 20));
        expect(detectVersionBumps).toHaveBeenCalledTimes(1);
        await b.stop();
        await a.stop();
    });

    it('inserts pending row, writes Valkey hash, enqueues to BullMQ', async () => {
        const fake = makeFakeSql();
        const { orch, queue } = await bootOrchestrator({
            client,
            sql: fake.sql,
        });
        const result = await orch.startRun('basic-task', { name: 'alpha' });
        expect(result.runId).toMatch(/^run_/);
        // Postgres INSERT happened
        expect(
            fake.recorder.calls.some((c) =>
                c.strings.join(' ').includes('INSERT INTO task_history'),
            ),
        ).toBe(true);
        // Valkey hash seeded
        const hashKey = `task:run:active:${result.runId}`;
        expect(client._hashes.get(hashKey)?.get('state')).toBe('pending');
        // BullMQ add called with computed jobId (encoded as `<formula>#<runId>`).
        expect(queue.add).toHaveBeenCalledOnce();
        const addArgs = queue.add.mock.calls[0];
        expect(addArgs[0]).toBe('basic-task');
        expect((addArgs[1] as { runId: string }).runId).toBe(result.runId);
        // jobId is `<taskId>~~<formula>#<runId>` to allow recovery without queue probe.
        const jobIdArg = (addArgs[2] as { jobId: string }).jobId;
        expect(jobIdArg).toMatch(/^basic-task~~alpha#run_/);
        expect(jobIdArg.endsWith(result.runId)).toBe(true);
        await orch.stop();
    });

    it('returns deduped:true when idempotencyKey matches a recent run', async () => {
        const fake = makeFakeSql();
        fake.recorder.responses.set('SELECT id FROM task_history', [{ id: 'run_existing' }]);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });
        const result = await orch.startRun(
            'basic-task',
            { name: 'alpha' },
            { idempotencyKey: 'idem-1' },
        );
        expect(result).toEqual({
            runId: 'run_existing',
            deduped: true,
            existingRunId: 'run_existing',
        });
        await orch.stop();
    });

    it('Important-5 (F3): empty-string idempotencyKey does NOT enter the dedup code path', async () => {
        // The partial unique index `task_history_idempotency_key_unique` uses
        //   WHERE trigger ? 'idempotencyKey'
        // which is true for ANY existing key, regardless of its value. If we
        // let `""` through, every empty-string-keyed call for the same taskId
        // collides at the partial index and the runner treats them as
        // duplicates of each other. The fix coerces `""` → undefined before
        // either the pre-INSERT SELECT or the post-INSERT 23505 catch runs.
        //
        // Assertions:
        //   1. The pre-INSERT idempotency-probe SELECT (`SELECT id FROM
        //      task_history ... trigger->>'idempotencyKey' = ${...}`) is NOT
        //      issued — proven by checking no SELECT call uses the dedup head
        //      with `task_id` + `trigger->>'idempotencyKey'`.
        //   2. The trigger column on the INSERT does NOT include
        //      `idempotencyKey` — empty strings must not materialise into the
        //      partial-index predicate.
        const fake = makeFakeSql();
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });
        const result = await orch.startRun('basic-task', { name: 'alpha' }, { idempotencyKey: '' });
        expect(result.runId).toMatch(/^run_/);
        expect(result.deduped).not.toBe(true);

        // Probe 1: no idempotency-dedup SELECT was issued.
        const dedupSelect = fake.recorder.calls.find((c) => {
            const head = (c.strings[0] || '').trim().slice(0, 200);
            return (
                head.includes('SELECT id FROM task_history') &&
                head.includes("trigger->>'idempotencyKey'")
            );
        });
        expect(dedupSelect).toBeUndefined();

        // Probe 2: the INSERT trigger payload omits idempotencyKey.
        const insertCall = fake.recorder.calls.find((c) => {
            const head = (c.strings[0] || '').trim().slice(0, 100);
            return head.includes('INSERT INTO task_history');
        });
        expect(insertCall).toBeDefined();
        // The trigger JSON is inserted via sql.json(triggerRecord). We just
        // need to confirm `idempotencyKey` did not appear anywhere in the
        // serialized trigger value.
        const triggerArg = insertCall!.values.find((v) => {
            if (typeof v !== 'object' || v === null) return false;
            return 'kind' in (v as Record<string, unknown>);
        }) as Record<string, unknown> | undefined;
        expect(triggerArg).toBeDefined();
        expect(triggerArg).not.toHaveProperty('idempotencyKey');
        await orch.stop();
    });

    it('returns the existing runId when identity dedup Lua reports duplicate', async () => {
        // valkey-glide decodes Lua's `{ok='duplicate', existingRunId}` table
        // as a flat positional array — the integration tests in
        // lua/scripts.integration.test.ts:319-336 assert the same shape. The
        // orchestrator must read `raw[0]` / `raw[1]`, not `raw.ok`.
        mockLuaInvoke.mockResolvedValueOnce(['duplicate', 'run_existing-456']);
        const fake = makeFakeSql();
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });
        const result = await orch.startRun('exclusive-task', { id: 'foo' });
        expect(result.deduped).toBe(true);
        expect(result.existingRunId).toBe('run_existing-456');
        await orch.stop();
    });

    it('drains the INSERT and THROWS transient (no row-less BullMQ job) on a transient pg error (H1)', async () => {
        // H1 data-loss fix: on a transient INSERT failure (08006 =
        // connection_failure) the task_history row does NOT exist yet. The drain
        // queues it for replay, but startRun MUST throw transient and MUST NOT
        // enqueue the BullMQ job — a job whose row is absent runs to completion and
        // its terminal `UPDATE … WHERE id=runId` matches 0 rows (silent no-op),
        // losing the result. The caller retries once Postgres heals.
        const fake = makeFakeSql();
        const transientErr = Object.assign(new Error('connection failure'), {
            code: '08006',
        });
        fake.recorder.errors.set('INSERT INTO task_history', transientErr);
        // Exercise admission from a submitting replica without a concurrent
        // coordinator drain moving the deferred entry onto PROCESSING_KEY.
        vi.mocked(shouldStartWorkers).mockReturnValueOnce(false);
        const { orch, queue } = await bootOrchestrator({ client, sql: fake.sql });

        await expect(orch.startRun('basic-task', { name: 'alpha' })).rejects.toMatchObject({
            kind: 'transient',
        });

        // Drain list received an LPUSH of the deferred INSERT (row WILL be replayed).
        const drainList = client._lists.get('task:pending-writes');
        expect(drainList).toBeDefined();
        expect(drainList).toHaveLength(1);
        expect((JSON.parse(drainList![0]) as { kind: string }).kind).toBe('insert');

        // CRITICAL: NO BullMQ job was enqueued — this is the data-loss guard.
        expect((queue.add as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
        await orch.stop();
    });

    it('re-throws (does not drain) when INSERT fails with a permanent pg error', async () => {
        // Constraint violation (23505) must surface — draining would just
        // pile poison into the DLQ and hide the bug. The orchestrator wraps
        // the underlying error in a TaskError(kind:'fatal').
        const fake = makeFakeSql();
        const permanentErr = Object.assign(
            new Error('duplicate key value violates unique constraint'),
            { code: '23505' },
        );
        fake.recorder.errors.set('INSERT INTO task_history', permanentErr);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        // Asserts both the message AND kind: previously kind was conditional
        // on transient — fixed to always 'fatal' in this branch since callers
        // do not distinguish for startRun.
        await expect(orch.startRun('basic-task', { name: 'alpha' })).rejects.toMatchObject({
            kind: 'fatal',
            message: expect.stringMatching(/INSERT failed/),
        });

        // Drain list stays empty.
        const drainList = client._lists.get('task:pending-writes');
        expect(drainList === undefined || drainList.length === 0).toBe(true);
        await orch.stop();
    });

    it('catches 23505 on task_history_idempotency_key_unique and returns the existing run (TOCTOU close)', async () => {
        // Three replicas race on the same idempotencyKey within ms of each other.
        // The pre-INSERT SELECT in replica B sees nothing (replica A hasn't
        // committed yet), so B proceeds to INSERT — and trips the unique partial
        // index. The catch must re-run the SELECT and surface the existing run
        // exactly like the pre-INSERT dedup branch (deduped:true).
        let insertCalled = false;
        let selectCount = 0;
        const sqlFn = ((strings: readonly string[]) => {
            const head = (strings[0] || '').trim().slice(0, 80);
            if (head.includes('SELECT id FROM task_history')) {
                selectCount++;
                // First SELECT (pre-INSERT idempotency probe): no winner yet.
                // Second SELECT (post-23505 catch): replica A is now visible.
                if (selectCount === 1) return Promise.resolve([]);
                return Promise.resolve([{ id: 'run_winner-from-replica-A' }]);
            }
            if (head.includes('INSERT INTO task_history')) {
                insertCalled = true;
                return Promise.reject(
                    Object.assign(
                        new Error(
                            'duplicate key value violates unique constraint "task_history_idempotency_key_unique"',
                        ),
                        {
                            code: '23505',
                            constraint_name: 'task_history_idempotency_key_unique',
                        },
                    ),
                );
            }
            return Promise.resolve([]);
        }) as FakeSqlFn;
        sqlFn.json = (v: unknown) => v;

        const { orch } = await bootOrchestrator({ client, sql: sqlFn });
        const result = await orch.startRun(
            'basic-task',
            { name: 'alpha' },
            { idempotencyKey: 'idem-toctou' },
        );

        expect(insertCalled).toBe(true);
        expect(selectCount).toBe(2);
        expect(result).toEqual({
            runId: 'run_winner-from-replica-A',
            deduped: true,
            existingRunId: 'run_winner-from-replica-A',
        });
        // Drain list must stay empty — this is dedup, not a transient write failure.
        const drainList = client._lists.get('task:pending-writes');
        expect(drainList === undefined || drainList.length === 0).toBe(true);
        await orch.stop();
    });

    it('does NOT swallow 23505 from an unrelated unique constraint (only the idempotency index)', async () => {
        // A 23505 on some *other* unique index (e.g. idx_task_history_idempotency
        // on the column variant, or any future unique index on task_history) must
        // surface as fatal — silently treating it as dedup would mask real bugs.
        const fake = makeFakeSql();
        const otherUniqueErr = Object.assign(
            new Error('duplicate key value violates unique constraint "some_other_unique_idx"'),
            { code: '23505', constraint_name: 'some_other_unique_idx' },
        );
        fake.recorder.errors.set('INSERT INTO task_history', otherUniqueErr);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        await expect(
            orch.startRun('basic-task', { name: 'alpha' }, { idempotencyKey: 'idem-other' }),
        ).rejects.toMatchObject({
            kind: 'fatal',
            message: expect.stringMatching(/INSERT failed/),
        });

        const drainList = client._lists.get('task:pending-writes');
        expect(drainList === undefined || drainList.length === 0).toBe(true);
        await orch.stop();
    });

    it('non-23505 errors still propagate from the idempotency catch path', async () => {
        // Even with an idempotencyKey set, a non-unique-violation error (e.g.
        // syntax error 42601) must NOT be funneled into the dedup re-fetch
        // branch. It surfaces as fatal so the caller sees the real failure.
        const fake = makeFakeSql();
        const syntaxErr = Object.assign(new Error('syntax error at or near "FROM"'), {
            code: '42601',
            constraint_name: undefined,
        });
        fake.recorder.errors.set('INSERT INTO task_history', syntaxErr);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        await expect(
            orch.startRun('basic-task', { name: 'alpha' }, { idempotencyKey: 'idem-syntax' }),
        ).rejects.toMatchObject({
            kind: 'fatal',
            message: expect.stringMatching(/INSERT failed/),
        });
        await orch.stop();
    });

    it('flushTransitions terminal UPDATE drains on transient pg error (40001)', async () => {
        // Inject a 40001 on the terminal UPDATE task_history call. We drive
        // writeTerminalToPostgres directly (private) because the public flush
        // path goes through TransitionBatcher → Lua → resolveRunId, none of
        // which we need for this catch-block assertion.
        const fake = makeFakeSql();
        const transientErr = Object.assign(new Error('serialization failure'), {
            code: '40001',
        });
        fake.recorder.errors.set('UPDATE task_history', transientErr);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        // Call the private writeTerminalToPostgres path directly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (orch as any).writeTerminalToPostgres('run_term', 'failed', {
            errorMessage: 'boom',
            startedAt: new Date().toISOString(),
        });
        // The catch fires `void enqueue()` — flush microtasks so the LPUSH
        // is observable before we assert.
        for (let i = 0; i < 5; i++) await Promise.resolve();

        // Drain list received an LPUSH for the deferred UPDATE.
        const drainList = client._lists.get('task:pending-writes');
        expect(drainList).toBeDefined();
        expect(drainList).toHaveLength(1);
        const drained = JSON.parse(drainList![0]) as {
            kind: string;
            runId: string;
            payload: { state: string };
        };
        expect(drained.kind).toBe('update');
        expect(drained.runId).toBe('run_term');
        expect(drained.payload.state).toBe('failed');
        await orch.stop();
    });

    it('enqueuePipeline pipeline-member INSERT drains on transient pg error (08006)', async () => {
        const localClient = makeFakeClient();
        const fake = makeFakeSql();

        // Two-step pipeline so we have a non-trigger member that needs INSERT.
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'pipe-trans-root',
                name: 'Root',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ name: z.string() }),
                identityFor: (input) => input.name,
                pipeline: { of: 'trans-pipe' },
                execute: async () => ({ success: true }),
            }),
        );
        reg.registerTask(
            defineTask({
                id: 'pipe-trans-child',
                name: 'Child',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'child',
                pipeline: { of: 'trans-pipe', after: ['pipe-trans-root'] },
                execute: async () => ({ success: true }),
            }),
        );

        // First INSERT (trigger row) succeeds; second INSERT (pipeline member)
        // hits transient 08006. Our FakeSqlRecorder injects by head match —
        // both calls share the same head, so we toggle via a counter via the
        // postgres pipeline path. Simpler: inject a one-shot Error that the
        // sqlFn re-arms by deleting itself after first throw.
        const transientErr = Object.assign(new Error('connection failure'), {
            code: '08006',
        });
        let insertSeen = 0;
        const sqlFn = ((strings: readonly string[], ..._values: unknown[]) => {
            const head = (strings[0] || '').trim().slice(0, 80);
            if (head.includes('INSERT INTO task_history')) {
                insertSeen++;
                // First call (trigger) succeeds; second (pipeline member) throws.
                if (insertSeen >= 2) return Promise.reject(transientErr);
            }
            return Promise.resolve([]);
        }) as unknown as ReturnType<typeof makeFakeSql>['sql'];
        (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
        void fake; // recorder unused for this test

        const fakeFlow = {
            add: vi.fn(async () => ({})),
            close: vi.fn(async () => {}),
        };

        const transitionSpy = vi.fn(async () => ({ ok: true }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => sqlFn as unknown as postgres.Sql | null,
            getClient: () => localClient,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: fakeFlow as unknown as FlowProducer,
        });

        await orch.startRun('pipe-trans-root', { name: 'alpha' });
        // Catch fires `void enqueue()` — flush microtasks before asserting.
        for (let i = 0; i < 5; i++) await Promise.resolve();

        // Drain list received an LPUSH for the deferred pipeline-member INSERT.
        const drainList = localClient._lists.get('task:pending-writes');
        expect(drainList).toBeDefined();
        expect(drainList).toHaveLength(1);
        const drained = JSON.parse(drainList![0]) as {
            kind: string;
            payload: { taskId: string; parentRunId: string };
        };
        expect(drained.kind).toBe('insert');
        expect(drained.payload.taskId).toBe('pipe-trans-child');
        await orch.stop();
    });

    it('enqueuePipeline synthetic __gate__ row INSERT drains on transient pg error (08006)', async () => {
        // Fan-in pipeline (multi-a + multi-b → converge) so buildPipelinePlan
        // synthesises a `__gate__converge` task_history row alongside the
        // real member rows. Previously this branch only logged on INSERT
        // failure; it must mirror the sibling pipeline-member branch and
        // drain transient pg errors too — otherwise the gate's own terminal
        // UPDATE (fired by the runner when BullMQ releases it) matches 0
        // rows and is silently lost.
        const localClient = makeFakeClient();
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'multi-a',
                name: 'Multi A',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ name: z.string() }),
                identityFor: (input) => input.name,
                pipeline: { of: 'gate-drain-pipe' },
                execute: async () => ({ success: true }),
            }),
        );
        reg.registerTask(
            defineTask({
                id: 'multi-b',
                name: 'Multi B',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'multi-b',
                pipeline: { of: 'gate-drain-pipe' },
                execute: async () => ({ success: true }),
            }),
        );
        reg.registerTask(
            defineTask({
                id: 'converge',
                name: 'Converge',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'converge',
                pipeline: { of: 'gate-drain-pipe', after: ['multi-a', 'multi-b'] },
                execute: async () => ({ success: true }),
            }),
        );

        // Only the gate row's INSERT (task_id === '__gate__converge') throws
        // transient — the trigger row (already inserted by the caller before
        // enqueuePipeline runs) and the sibling member rows succeed.
        const transientErr = Object.assign(new Error('connection failure'), {
            code: '08006',
        });
        const sqlFn = ((strings: readonly string[], ...values: unknown[]) => {
            const head = (strings[0] || '').trim().slice(0, 80);
            if (head.includes('INSERT INTO task_history') && values[1] === '__gate__converge') {
                return Promise.reject(transientErr);
            }
            return Promise.resolve([]);
        }) as unknown as ReturnType<typeof makeFakeSql>['sql'];
        (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

        const fakeFlow = {
            add: vi.fn(async () => ({})),
            close: vi.fn(async () => {}),
        };
        const transitionSpy = vi.fn(async () => ({ ok: true }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => sqlFn as unknown as postgres.Sql | null,
            getClient: () => localClient,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: fakeFlow as unknown as FlowProducer,
        });

        await orch.startRun('multi-a', { name: 'alpha' });
        // The gate INSERT catch fires `void enqueue()` — flush microtasks.
        for (let i = 0; i < 5; i++) await Promise.resolve();

        const drainList = localClient._lists.get('task:pending-writes');
        expect(drainList).toBeDefined();
        expect(drainList).toHaveLength(1);
        const drained = JSON.parse(drainList![0]) as {
            kind: string;
            payload: { taskId: string };
        };
        expect(drained.kind).toBe('insert');
        expect(drained.payload.taskId).toBe('__gate__converge');
        await orch.stop();
    });

    it('cancelRunInternal mirror UPDATE drains on transient pg error (40001)', async () => {
        const fake = makeFakeSql();
        const transientErr = Object.assign(new Error('serialization failure'), {
            code: '40001',
        });
        fake.recorder.errors.set('UPDATE task_history', transientErr);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        // Pre-seed the run hash so readRunState returns 'active'.
        client._hashes.set('task:run:active:run_cancel', new Map([['state', 'active']]));

        const result = await orch.cancelRun('run_cancel', { reason: 'user' });
        expect(result).toEqual({ accepted: true });
        // The catch fires `void enqueue()` AFTER cancelRun returns, and the cancel
        // path runs extra awaits (publishCancel, child-cascade) between the
        // enqueue and the return — so a fixed 5-flush races the fire-and-forget
        // LPUSH (the enqueue itself awaits getClient → LLEN → LPUSH). Poll the
        // microtask queue until the LPUSH lands instead of guessing a turn count.
        for (let i = 0; i < 100 && !client._lists.get('task:pending-writes')?.length; i++) {
            await Promise.resolve();
        }

        // Drain list received an LPUSH for the deferred 'cancelling' UPDATE.
        const drainList = client._lists.get('task:pending-writes');
        expect(drainList).toBeDefined();
        expect(drainList).toHaveLength(1);
        const drained = JSON.parse(drainList![0]) as {
            kind: string;
            runId: string;
            payload: { state: string };
        };
        expect(drained.kind).toBe('update');
        expect(drained.runId).toBe('run_cancel');
        expect(drained.payload.state).toBe('cancelling');
        await orch.stop();
    });

    it('rolls back SETNX identity key when post-INSERT enqueue fails AND compensation confirms the job + row are safely terminal', async () => {
        // Simulate enqueued claim then enqueue-time crash AFTER the
        // task_history INSERT committed. Bare rollbackIdentity here would
        // free the exclusiveWith slot while a real 'pending' row (and
        // possibly a live BullMQ job) exists — the startRun catch must
        // compensate first: confirm no live job remains (queue.getJob →
        // null, the fake queue's default) AND mark the row terminal (the
        // UPDATE below is stubbed to "succeed") before it is safe to
        // release the identity key.
        mockLuaInvoke.mockResolvedValueOnce(['enqueued', 'run_new']);
        const fake = makeFakeSql();
        fake.recorder.responses.set('UPDATE task_history', [{ id: 'compensated' }]);
        const queue = makeFakeQueue();
        // Force queue.add to throw so we exit via the catch block.
        queue.add.mockRejectedValueOnce(new Error('valkey down'));

        const { orch } = await bootOrchestrator({
            client,
            sql: fake.sql,
            queue,
        });
        await expect(orch.startRun('exclusive-task', { id: 'bar' })).rejects.toThrow(/valkey down/);

        // Verify the rollback fired a release-identity compare-and-delete
        // against the identity key, guarded by this run's runId (argv[0]).
        const releaseCalls = mockLuaInvoke.mock.calls.filter((c) => c[0] === 'release-identity');
        expect(releaseCalls.length).toBeGreaterThan(0);
        const releaseKeys = releaseCalls.map((c) => (c[1] as string[])[0]);
        expect(releaseKeys.some((k) => k.includes('exclusive-task'))).toBe(true);

        // The compensating UPDATE marked the orphaned pending row failed.
        const updateCall = fake.recorder.calls.find((c) =>
            (c.strings[0] || '').includes('UPDATE task_history'),
        );
        expect(updateCall).toBeDefined();
        await orch.stop();
    });

    it('does NOT release the identity key when compensation cannot confirm the BullMQ job is gone', async () => {
        // Same post-INSERT enqueue-time crash, but this time queue.getJob
        // returns a job that is already locked for processing (job.remove()
        // throws) — proof a run IS live. Releasing the identity key here
        // would let a fresh trigger claim a second identity while the first
        // run genuinely executes, breaking single-flight. rollbackIdentity
        // must NOT fire.
        mockLuaInvoke.mockResolvedValueOnce(['enqueued', 'run_new']);
        const fake = makeFakeSql();
        fake.recorder.responses.set('UPDATE task_history', [{ id: 'compensated' }]);
        const queue = makeFakeQueue();
        queue.add.mockRejectedValueOnce(new Error('valkey down'));
        queue.getJob.mockResolvedValueOnce({
            remove: vi.fn().mockRejectedValue(new Error('job is locked (active)')),
        });

        const { orch } = await bootOrchestrator({
            client,
            sql: fake.sql,
            queue,
        });
        await expect(orch.startRun('exclusive-task', { id: 'bar' })).rejects.toThrow(/valkey down/);

        const releaseCalls = mockLuaInvoke.mock.calls.filter((c) => c[0] === 'release-identity');
        expect(releaseCalls.length).toBe(0);
        await orch.stop();
    });

    it('does NOT release the identity key when compensation cannot confirm the row was marked terminal', async () => {
        // The job is confirmed gone (getJob → null), but the compensating
        // UPDATE matches 0 rows — e.g. a concurrent runner claim already
        // flipped state to 'active' between the throw and this compensation,
        // which is itself proof the run is live. rollbackIdentity must NOT
        // fire (the fake sql's default UPDATE response is `[]`, so no
        // response needs to be registered here).
        mockLuaInvoke.mockResolvedValueOnce(['enqueued', 'run_new']);
        const fake = makeFakeSql();
        const queue = makeFakeQueue();
        queue.add.mockRejectedValueOnce(new Error('valkey down'));

        const { orch } = await bootOrchestrator({
            client,
            sql: fake.sql,
            queue,
        });
        await expect(orch.startRun('exclusive-task', { id: 'bar' })).rejects.toThrow(/valkey down/);

        const releaseCalls = mockLuaInvoke.mock.calls.filter((c) => c[0] === 'release-identity');
        expect(releaseCalls.length).toBe(0);
        await orch.stop();
    });

    it('does NOT release the daily quota slot on the post-INSERT compensation path', async () => {
        // TASK-C4 symmetry: once the row committed, the run legitimately
        // holds a task_history slot for today's bucket whether it ends up
        // marked 'failed' (compensated) or stays live (a job survived
        // compensation) — rollbackQuota's own `quota.acquired` guard only
        // undoes a reservation that never got a run behind it. Releasing it
        // here would let the task exceed maxRunsPerDay by one per hit.
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'quota-compensate-task',
                name: 'Quota Compensate',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                quotas: { maxRunsPerDay: 5 },
                async execute() {
                    return { success: true };
                },
            }),
        );
        const fake = makeFakeSql();
        fake.recorder.responses.set('INSERT INTO task_quota_usage', [
            { runs: 1, day: '2026-07-07' },
        ]);
        fake.recorder.responses.set('UPDATE task_history', [{ id: 'compensated' }]);
        const queue = makeFakeQueue();
        queue.add.mockRejectedValueOnce(new Error('valkey down'));

        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: {
                transitionRun: vi.fn(async () => ({ ok: true })),
                transitionStage: vi.fn(),
                incrementStage: vi.fn(),
                claimRun: vi.fn(),
            } as unknown as StateMachine,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => queue as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        await expect(orch.startRun('quota-compensate-task', { id: 'bar' })).rejects.toThrow(
            /valkey down/,
        );

        // No decrement UPDATE against task_quota_usage (that's what
        // releaseDailyQuotaSlot issues) — the reservation stands.
        const releaseCall = fake.recorder.calls.find((c) =>
            (c.strings[0] || '').includes('UPDATE task_quota_usage'),
        );
        expect(releaseCall).toBeUndefined();
        await orch.stop();
    });

    // ── F1.1 identity-key TTL floor — derived, not fixed ───────────────────
    it('uses the configured ttl when it exceeds the derived floor (no timeout/schedule)', async () => {
        // A task with no timeout.hard and no schedule has a derived floor of
        // IDENTITY_CLAIM_MARGIN_MS (10s). A configured ttl of '30s' is above
        // that floor, so the configured value wins — no clamping occurs.
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'short-ttl-task',
                name: 'Short TTL',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                exclusiveWith: { scope: 'global', ttl: '30s' },
                async execute() {
                    return { success: true };
                },
            }),
        );
        const transitionSpy = vi.fn(async () => ({ ok: true }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;
        const fake = makeFakeSql();
        mockLuaInvoke.mockResolvedValueOnce(['enqueued', 'run_short']);
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        await orch.startRun('short-ttl-task', { id: 'foo' });

        // The enqueue-with-identity invoke is mockLuaInvoke; argv is the 3rd
        // positional arg [runId, String(ttlMs)].
        const enqueueCall = mockLuaInvoke.mock.calls.find((c) => c[0] === 'enqueue-with-identity');
        expect(enqueueCall).toBeDefined();
        const argv = enqueueCall![2] as string[];
        // 30s configured ttl > 10s derived floor → configured value wins.
        expect(argv[1]).toBe('30000');
        await orch.stop();
    });

    it('clamps configured ttl up to the derived floor when timeout.hard dominates', async () => {
        // A task with timeout.hard = '2m' and no schedule has derived floor =
        // max(120_000, 0) + 10_000 = 130_000 ms. A configured ttl of '2m'
        // (120_000 ms) is below the floor, so the floor wins.
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'hard-timeout-task',
                name: 'Hard Timeout',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                timeout: { hard: '2m', soft: '90s' },
                exclusiveWith: { scope: 'global', ttl: '2m' },
                async execute() {
                    return { success: true };
                },
            }),
        );
        const transitionSpy = vi.fn(async () => ({ ok: true }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;
        const fake = makeFakeSql();
        mockLuaInvoke.mockResolvedValueOnce(['enqueued', 'run_hard']);
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        await orch.startRun('hard-timeout-task', { id: 'foo' });

        const enqueueCall = mockLuaInvoke.mock.calls.find((c) => c[0] === 'enqueue-with-identity');
        expect(enqueueCall).toBeDefined();
        const argv = enqueueCall![2] as string[];
        // configured ttl = 120_000 ms (2m); derived floor = 120_000 + 10_000 = 130_000.
        // floor > configured → floor wins.
        expect(argv[1]).toBe('130000');
        await orch.stop();
    });

    // ── F1.2 phantom-dedup self-heal ────────────────────────────────────────
    it('treats the dedup as REAL (no release, no metric) when the dedup runId is ABSENT', async () => {
        // An absent task_history row is NOT a phantom: a genuine first run does
        // its SETNX BEFORE it INSERTs its row, so a concurrent dedup landing in
        // that SETNX→INSERT window sees "absent" for a live run. Self-healing
        // there would release the live run's key and re-claim — the exact
        // duplicate this guard prevents. So absent must fall through to a normal,
        // conservative dedup (no release, no re-claim, no metric).
        const before = await readPhantomMetric('exclusive-task');
        mockLuaInvoke.mockResolvedValueOnce(['duplicate', 'run_dead-absent']);
        const fake = makeFakeSql();
        // task_history probe finds NO row for the dead runId.
        fake.recorder.responses.set('SELECT state FROM task_history', []);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        const result = await orch.startRun('exclusive-task', { id: 'foo' });

        // Normal dedup — return the existing runId.
        expect(result.deduped).toBe(true);
        expect(result.existingRunId).toBe('run_dead-absent');
        // No release fired, exactly one enqueue attempt, metric untouched.
        const releaseCalls = mockLuaInvoke.mock.calls.filter((c) => c[0] === 'release-identity');
        expect(releaseCalls.length).toBe(0);
        const enqueueCalls = mockLuaInvoke.mock.calls.filter(
            (c) => c[0] === 'enqueue-with-identity',
        );
        expect(enqueueCalls.length).toBe(1);
        expect((await readPhantomMetric('exclusive-task')) - before).toBe(0);
        await orch.stop();
    });

    it('releases the stale key and re-claims when the dedup runId is ABSENT but minted long ago (crash-leaked key)', async () => {
        // A holder whose task_history row is absent is normally the live
        // SETNX→INSERT window (handled above). But if its ULID runId was minted
        // far longer ago than that sub-second window, the INSERT never landed (a
        // crash, or an INSERT that threw without rolling back the SETNX): the key
        // is a confirmed leak with no task_history row for any reclaim path to see,
        // so it would wedge the singleton until the derived-floor TTL (~24h). The
        // runId carries its own mint time (ULID), so we self-heal it. This runId
        // encodes 2020-09-13, comfortably past the 120s grace.
        const stale = 'run_01EJ3PX000RHZJGWHHE37MBP66';
        const before = await readPhantomMetric('exclusive-task');
        mockLuaInvoke
            .mockResolvedValueOnce(['duplicate', stale])
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(['enqueued', 'run_fresh_after_leak']);
        const fake = makeFakeSql();
        // Probe finds NO row for the stale runId.
        fake.recorder.responses.set('SELECT state FROM task_history', []);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        const result = await orch.startRun('exclusive-task', { id: 'foo' });

        // Self-healed: re-claimed, not a normal dedup.
        expect(result.deduped).toBeUndefined();
        const releaseCalls = mockLuaInvoke.mock.calls.filter((c) => c[0] === 'release-identity');
        expect(releaseCalls.length).toBe(1);
        expect((releaseCalls[0][2] as string[])[0]).toBe(stale);
        expect((await readPhantomMetric('exclusive-task')) - before).toBe(1);
        await orch.stop();
    });

    it('releases the stale key and re-claims when the dedup runId is TERMINAL', async () => {
        const before = await readPhantomMetric('exclusive-task');
        mockLuaInvoke
            .mockResolvedValueOnce(['duplicate', 'run_dead-terminal'])
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(['enqueued', 'run_fresh2']);
        const fake = makeFakeSql();
        // Probe returns a terminal row → phantom.
        fake.recorder.responses.set('SELECT state FROM task_history', [{ state: 'completed' }]);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        const result = await orch.startRun('exclusive-task', { id: 'foo' });

        expect(result.deduped).toBeUndefined();
        const releaseCalls = mockLuaInvoke.mock.calls.filter((c) => c[0] === 'release-identity');
        expect(releaseCalls.length).toBe(1);
        expect((releaseCalls[0][2] as string[])[0]).toBe('run_dead-terminal');
        expect((await readPhantomMetric('exclusive-task')) - before).toBe(1);
        await orch.stop();
    });

    it.each(['delayed', 'active', 'waiting', 'prioritized'])(
        'retains the exclusive key for a failed attempt whose job is still %s',
        async (jobState) => {
            mockLuaInvoke.mockResolvedValue(['duplicate', 'run_retrying']);
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT state FROM task_history', [{ state: 'failed' }]);
            const queue = makeFakeQueue();
            queue.getJob.mockResolvedValue({ getState: async () => jobState });
            const { orch } = await bootOrchestrator({ client, sql: fake.sql, queue });
            try {
                const result = await orch.startRun('exclusive-task', { id: 'foo' });
                expect(result).toMatchObject({ deduped: true, existingRunId: 'run_retrying' });
                expect(
                    mockLuaInvoke.mock.calls.filter((call) => call[0] === 'release-identity'),
                ).toHaveLength(0);
                expect(queue.add).not.toHaveBeenCalled();
            } finally {
                await orch.stop();
            }
        },
    );

    it('treats the dedup as REAL (no release, no metric) when the dedup runId is LIVE', async () => {
        const before = await readPhantomMetric('exclusive-task');
        mockLuaInvoke.mockResolvedValueOnce(['duplicate', 'run_live-789']);
        const fake = makeFakeSql();
        // Probe returns a non-terminal (live) row → genuine concurrent run.
        fake.recorder.responses.set('SELECT state FROM task_history', [{ state: 'active' }]);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        const result = await orch.startRun('exclusive-task', { id: 'foo' });

        // Normal dedup — return the existing runId.
        expect(result.deduped).toBe(true);
        expect(result.existingRunId).toBe('run_live-789');
        // No release fired, exactly one enqueue attempt, metric untouched.
        const releaseCalls = mockLuaInvoke.mock.calls.filter((c) => c[0] === 'release-identity');
        expect(releaseCalls.length).toBe(0);
        const enqueueCalls = mockLuaInvoke.mock.calls.filter(
            (c) => c[0] === 'enqueue-with-identity',
        );
        expect(enqueueCalls.length).toBe(1);
        expect((await readPhantomMetric('exclusive-task')) - before).toBe(0);
        await orch.stop();
    });

    it('rejects a 1MB string input with the size-cap TaskError', async () => {
        const { orch } = await bootOrchestrator({ client });
        const bigInput = { name: 'x'.repeat(1024 * 1024) };
        await expect(orch.startRun('basic-task', bigInput)).rejects.toMatchObject({
            kind: 'permanent',
            message: expect.stringMatching(/Task input exceeds \d+ bytes/),
        });
        await orch.stop();
    });

    it('accepts undefined input without false-positive size rejection', async () => {
        const fake = makeFakeSql();
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });
        // basic-task inputSchema: z.object({ name: z.string() }) — undefined fails Zod, not size.
        // Use a task whose schema accepts empty input.
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'no-input-task',
                name: 'No Input',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({}).optional(),
                identityFor: () => 'global',
                execute: async () => ({ success: true }),
            }),
        );
        const sm = {
            transitionRun: vi.fn(async () => ({ ok: true })),
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;
        const fakeQueue = makeFakeQueue();
        const localClient = makeFakeClient();
        const orch2 = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => localClient,
            instanceId: 'test-instance',
            queueFactory: () => fakeQueue as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });
        const result = await orch2.startRun('no-input-task', undefined);
        expect(result.runId).toMatch(/^run_/);
        await orch2.stop();
        await orch.stop();
    });

    it('rejects input with a circular reference as input-not-serializable', async () => {
        const { orch } = await bootOrchestrator({ client });
        // Build a circular object — it must pass Zod (schema is z.object({ name: z.string() }))
        // so we need a task that accepts unknown input.
        const reg2 = new TaskRegistry();
        reg2.registerTask(
            defineTask({
                id: 'unknown-input-task',
                name: 'Unknown Input',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'global',
                execute: async () => ({ success: true }),
            }),
        );
        const sm = {
            transitionRun: vi.fn(async () => ({ ok: true })),
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;
        const localClient = makeFakeClient();
        const orch3 = await TaskOrchestrator.start(['io'], {
            registry: reg2,
            stateMachine: sm,
            getSql: () => null,
            getClient: () => localClient,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;
        await expect(orch3.startRun('unknown-input-task', circular)).rejects.toMatchObject({
            kind: 'permanent',
            message: expect.stringMatching(/not serializable/),
        });
        await orch3.stop();
        await orch.stop();
    });

    it('accepts a just-under-cap input (255 KB)', async () => {
        const fake = makeFakeSql();
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });
        // Use `exclusive-task` (its identityFor uses `input.id`, a short
        // value) rather than `basic-task` (whose identityFor returns the
        // full `input.name` string and trips the 256-char identity cap
        // on a 255 KB payload).
        const nearCapInput = {
            id: 'near-cap',
            blob: 'a'.repeat(255 * 1024 - 50),
        };
        const result = await orch.startRun('exclusive-task', nearCapInput);
        expect(result.runId).toMatch(/^run_/);
        await orch.stop();
    });
});

// ── F8 / TASK-C4: Postgres-backed daily quota + retry.backoff wiring ──────────
//
// TASK-C4: the daily-run quota moved off Valkey (TTL'd key, eviction-bypassable
// under non-`noeviction` policies) into the durable `task_quota_usage` table.
// The cap is enforced atomically inside `INSERT INTO task_quota_usage ... ON
// CONFLICT DO UPDATE ... WHERE runs < cap RETURNING runs`: rows returned ⇒ slot
// reserved; zero rows ⇒ over cap. These tests drive that Postgres path via a
// quota-aware sql stub (the real cap arithmetic lives in Postgres / the
// task-quota.queries integration test).

describe('TaskOrchestrator.startRun — TASK-C4 Postgres daily quota', () => {
    let client: FakeClient;
    beforeEach(() => {
        client = makeFakeClient();
        mockLuaInvoke.mockReset();
        mockLuaInvoke.mockResolvedValue({ ok: 'enqueued' });
    });

    // Build a fake sql that simulates the atomic quota INSERT against an
    // in-memory counter: returns `[{ runs }]` while under `cap`, `[]` at/over
    // cap, and decrements on the release UPDATE. All other statements behave
    // like the standard makeFakeSql stub (default empty rows, error injection).
    function makeQuotaSql(cap: number): {
        sql: FakeSqlFn;
        recorder: FakeSqlRecorder;
        getCount: () => number;
    } {
        const inner = makeFakeSql();
        let count = 0;
        const sqlFn = ((strings: readonly string[], ...values: unknown[]) => {
            const head = (strings[0] || '').trim();
            if (head.startsWith('INSERT INTO task_quota_usage')) {
                inner.recorder.calls.push({ strings, values });
                if (count >= cap) return Promise.resolve([]);
                count += 1;
                return Promise.resolve([{ runs: count }]);
            }
            if (head.startsWith('UPDATE task_quota_usage')) {
                inner.recorder.calls.push({ strings, values });
                count = Math.max(count - 1, 0);
                return Promise.resolve([]);
            }
            return inner.sql(strings, ...values);
        }) as FakeSqlFn;
        sqlFn.json = (v: unknown) => v;
        return { sql: sqlFn, recorder: inner.recorder, getCount: () => count };
    }

    function bootWithQuotaTask(opts: {
        maxRunsPerDay: number;
        sql?: FakeSqlFn;
        queue?: ReturnType<typeof makeFakeQueue>;
    }): Promise<{
        orch: TaskOrchestrator;
        queue: ReturnType<typeof makeFakeQueue>;
    }> {
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'quota-task',
                name: 'Quota',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ name: z.string() }),
                identityFor: (input) => input.name,
                quotas: { maxRunsPerDay: opts.maxRunsPerDay },
                execute: async () => ({ success: true }),
            }),
        );
        const sm = {
            transitionRun: vi.fn(async () => ({ ok: true })),
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;
        const fakeQueue = opts.queue ?? makeFakeQueue();
        return TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => (opts.sql ?? null) as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => fakeQueue as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        }).then((orch) => ({ orch, queue: fakeQueue }));
    }

    it('rejects with permanent quota-exceeded once the daily cap is hit', async () => {
        const quota = makeQuotaSql(2);
        const { orch, queue } = await bootWithQuotaTask({
            maxRunsPerDay: 2,
            sql: quota.sql,
        });

        await orch.startRun('quota-task', { name: 'one' });
        await orch.startRun('quota-task', { name: 'two' });
        await expect(orch.startRun('quota-task', { name: 'three' })).rejects.toMatchObject({
            kind: 'permanent',
            message: expect.stringContaining('Quota exceeded'),
        });

        // First two runs INSERTed + enqueued; third must not.
        expect(queue.add).toHaveBeenCalledTimes(2);
        expect(quota.getCount()).toBe(2);
        await orch.stop();
    });

    it('runs the quota check BEFORE the INSERT (no phantom pending row on over-cap)', async () => {
        // Cap 0 ⇒ the very first acquire is over cap (returns zero rows).
        const quota = makeQuotaSql(0);
        const { orch, queue } = await bootWithQuotaTask({
            maxRunsPerDay: 1,
            sql: quota.sql,
        });

        await expect(orch.startRun('quota-task', { name: 'denied' })).rejects.toThrow(
            /Quota exceeded/,
        );

        // No INSERT INTO task_history call (quota rejected before persistence).
        const insertCalls = quota.recorder.calls.filter((c) =>
            c.strings.join(' ').includes('INSERT INTO task_history'),
        );
        expect(insertCalls).toHaveLength(0);
        // No queue enqueue.
        expect(queue.add).not.toHaveBeenCalled();
        // No Valkey HSET on a task:run:active:<runId> hash.
        const hsetCalls = (client.customCommand as ReturnType<typeof vi.fn>).mock.calls
            .map((c: unknown[]) => c[0] as string[])
            .filter((cmd) => cmd?.[0] === 'HSET' && cmd[1]?.startsWith('task:run:active:'));
        expect(hsetCalls).toHaveLength(0);
        await orch.stop();
    });

    it('does NOT release the reserved quota slot when enqueue fails AFTER the task_history row committed', async () => {
        // Quota is reserved BEFORE the task_history INSERT, but the INSERT
        // itself still lands before queue.add() runs — so by the time
        // queue.add() throws here, the row is already durable and the run
        // legitimately holds its slot for today's bucket (startRun's outer
        // catch owns this decision now — see its comments). Releasing the
        // slot here would let the task exceed maxRunsPerDay by one for
        // every run that hits this path.
        const quota = makeQuotaSql(5);
        const queue = makeFakeQueue();
        queue.add.mockRejectedValueOnce(new Error('enqueue blew up'));
        const { orch } = await bootWithQuotaTask({
            maxRunsPerDay: 5,
            sql: quota.sql,
            queue,
        });

        await expect(orch.startRun('quota-task', { name: 'a' })).rejects.toThrow(/enqueue blew up/);

        // No UPDATE task_quota_usage ran, and the in-memory counter still
        // reflects the reservation.
        const releaseCalls = quota.recorder.calls.filter((c) =>
            c.strings.join(' ').includes('UPDATE task_quota_usage'),
        );
        expect(releaseCalls.length).toBe(0);
        expect(quota.getCount()).toBe(1);
        await orch.stop();
    });

    it('skips durable quota enforcement when sql is unavailable (cache-only dev)', async () => {
        // No sql ⇒ no task_history either; quota is skipped rather than falling
        // back to the eviction-prone Valkey counter. The run still enqueues.
        const { orch, queue } = await bootWithQuotaTask({ maxRunsPerDay: 1 });

        await orch.startRun('quota-task', { name: 'a' });
        await orch.startRun('quota-task', { name: 'b' });

        // Both enqueued — without a DB there is no durable cap to enforce.
        expect(queue.add).toHaveBeenCalledTimes(2);
        await orch.stop();
    });
});

describe('TaskOrchestrator.startRun — F8 retry.backoff wiring', () => {
    let client: FakeClient;
    beforeEach(() => {
        client = makeFakeClient();
        mockLuaInvoke.mockReset();
        mockLuaInvoke.mockResolvedValue({ ok: 'enqueued' });
    });

    async function bootWithRetryTask(
        retry:
            | {
                  attempts: number;
                  backoff: 'exponential' | number[];
                  retryOn?: (e: unknown) => boolean;
              }
            | undefined,
    ): Promise<{
        orch: TaskOrchestrator;
        queue: ReturnType<typeof makeFakeQueue>;
    }> {
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'retry-task',
                name: 'Retry',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ name: z.string() }),
                identityFor: (input) => input.name,
                retry: retry
                    ? {
                          attempts: retry.attempts,
                          backoff: retry.backoff,
                          retryOn: retry.retryOn ?? (() => true),
                      }
                    : undefined,
                execute: async () => ({ success: true }),
            }),
        );
        const sm = {
            transitionRun: vi.fn(async () => ({ ok: true })),
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;
        const fakeQueue = makeFakeQueue();
        const fake = makeFakeSql();
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => fakeQueue as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });
        return { orch, queue: fakeQueue };
    }

    it('passes attempts + exponential backoff to queue.add when retry.backoff = "exponential"', async () => {
        const { orch, queue } = await bootWithRetryTask({
            attempts: 3,
            backoff: 'exponential',
        });
        await orch.startRun('retry-task', { name: 'a' });
        expect(queue.add).toHaveBeenCalledTimes(1);
        const opts = queue.add.mock.calls[0][2] as {
            attempts?: number;
            backoff?: { type: string; delay: number };
        };
        expect(opts.attempts).toBe(3);
        expect(opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
        await orch.stop();
    });

    it('passes attempts + fixed backoff (first array element) when retry.backoff is a number[]', async () => {
        const { orch, queue } = await bootWithRetryTask({
            attempts: 4,
            backoff: [5000, 15000, 60000],
        });
        await orch.startRun('retry-task', { name: 'b' });
        const opts = queue.add.mock.calls[0][2] as {
            attempts?: number;
            backoff?: { type: string; delay: number };
        };
        expect(opts.attempts).toBe(4);
        expect(opts.backoff).toEqual({ type: 'fixed', delay: 5000 });
        await orch.stop();
    });

    it('keeps tasks without an opt-in policy at one attempt', async () => {
        const { orch, queue } = await bootWithRetryTask(undefined);
        await orch.startRun('retry-task', { name: 'c' });
        const opts = queue.add.mock.calls[0][2] as {
            attempts?: number;
            backoff?: unknown;
        };
        expect(opts.attempts).toBe(1);
        expect(opts.backoff).toBeUndefined();
        await orch.stop();
    });
});

// ── cancelRun ─────────────────────────────────────────────────────────────────

describe('TaskOrchestrator.cancelRun', () => {
    let client: FakeClient;
    beforeEach(() => {
        client = makeFakeClient();
        mockLuaInvoke.mockReset();
        mockLuaInvoke.mockResolvedValue({ ok: 'enqueued' });
    });
    afterEach(() => {
        vi.mocked(getValkeyClient).mockReturnValue(null);
        vi.mocked(getCoordinationClient).mockReturnValue(null);
    });

    it('writes cancelling state AND publishes cancel on the task Valkey, never the cache', async () => {
        const cacheClient = makeFakeClient();
        vi.mocked(getValkeyClient).mockReturnValue(
            cacheClient as unknown as ReturnType<typeof getValkeyClient>,
        );
        // Production: the orchestrator's client IS the coordination client.
        vi.mocked(getCoordinationClient).mockReturnValue(
            client as unknown as ReturnType<typeof getCoordinationClient>,
        );
        // Pre-seed the run hash so readRunState sees state=active.
        const fake = makeFakeSql();
        const { orch, transitionSpy } = await bootOrchestrator({
            client,
            sql: fake.sql,
        });
        // Seed state.
        client._hashes.set('task:run:active:run_X', new Map([['state', 'active']]));
        const result = await orch.cancelRun('run_X', { reason: 'user' });
        expect(result).toEqual({ accepted: true });
        expect(transitionSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: 'run_X',
                from: 'active',
                to: 'cancelling',
            }),
        );
        expect(
            client._published.some(
                (p) =>
                    p.channel === 'task:cancel' &&
                    typeof p.message === 'string' &&
                    p.message.includes('run_X'),
            ),
        ).toBe(true);
        // The cache may be down or unset; a cancel must never depend on it.
        expect(cacheClient._published.some((p) => p.channel === 'task:cancel')).toBe(false);
        await orch.stop();
    });

    it('returns accepted:false for a run already in terminal state', async () => {
        const fake = makeFakeSql();
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });
        client._hashes.set('task:run:terminal:run_done', new Map([['state', 'completed']]));
        const result = await orch.cancelRun('run_done');
        expect(result).toEqual({ accepted: false, reason: 'terminal' });
        await orch.stop();
    });

    it('returns accepted:false when run cannot be located', async () => {
        const fake = makeFakeSql();
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });
        const result = await orch.cancelRun('run_missing');
        expect(result).toEqual({ accepted: false, reason: 'not_found' });
        await orch.stop();
    });

    // cancel-before-pickup: a pending run that no worker ever claimed must be
    // driven cancelling→cancelled by the orchestrator itself, otherwise the row
    // sits at 'cancelling' until the 5-min reconciler sweep.
    it('finalizes cancelling→cancelled when pending run has no owner', async () => {
        const fake = makeFakeSql();
        const { orch, transitionSpy } = await bootOrchestrator({
            client,
            sql: fake.sql,
        });
        // Pending run, no ownerInstanceId set — simulates cancel-before-pickup.
        client._hashes.set('task:run:active:run_pending', new Map([['state', 'pending']]));

        await orch.cancelRun('run_pending', { reason: 'user' });

        // Orchestrator should have driven BOTH transitions on its own:
        //   pending    → cancelling  (always for non-terminal)
        //   cancelling → cancelled   (cancel-before-pickup finalization)
        const calls = transitionSpy.mock.calls.map((c) => ({
            from: (c[0] as { from: string }).from,
            to: (c[0] as { to: string }).to,
        }));
        expect(calls).toContainEqual({ from: 'pending', to: 'cancelling' });
        expect(calls).toContainEqual({ from: 'cancelling', to: 'cancelled' });
        await orch.stop();
    });

    it('does NOT finalize cancelling→cancelled when pending run already has an owner', async () => {
        // When a runner has claimed the run, the runner's own cancel path
        // (driven by the task:cancel:<runId> pubsub) will finalize. The
        // orchestrator must not race with it.
        const fake = makeFakeSql();
        const { orch, transitionSpy } = await bootOrchestrator({
            client,
            sql: fake.sql,
        });
        client._hashes.set(
            'task:run:active:run_owned',
            new Map([
                ['state', 'pending'],
                ['ownerInstanceId', 'some-worker-instance'],
            ]),
        );

        await orch.cancelRun('run_owned', { reason: 'user' });

        const calls = transitionSpy.mock.calls.map((c) => ({
            from: (c[0] as { from: string }).from,
            to: (c[0] as { to: string }).to,
        }));
        // pending → cancelling still happens; cancelling → cancelled must NOT.
        expect(calls).toContainEqual({ from: 'pending', to: 'cancelling' });
        expect(calls).not.toContainEqual({
            from: 'cancelling',
            to: 'cancelled',
        });
        await orch.stop();
    });
});

// ── Hard-kill ordering: QueueEvents 'failed' must not overwrite 'cancelled' (F4)
//
// Scenario:
//   1. Run is 'cancelling' in Postgres and Valkey.
//   2. HardKill.execute writes Postgres state='cancelled' BEFORE moveToFailed
//      (verified in hard-kill.test.ts).
//   3. BullMQ emits 'failed' → QueueEvents handler enqueues active→failed.
//   4. State machine's Lua rejects (run is in 'cancelling', not 'active'),
//      so flushTransitions re-reads live state, sees 'cancelling', and retries
//      as cancelling→cancelled. Then calls writeTerminalToPostgres('cancelled').
//   5. writeTerminalToPostgres's UPDATE has AND state NOT IN ('cancelled') so
//      even when an out-of-order 'failed' write races in, Postgres stays 'cancelled'.
describe('TaskOrchestrator — F4 hard-kill / failed-event short-circuit', () => {
    let client: FakeClient;
    beforeEach(() => {
        client = makeFakeClient();
        mockLuaInvoke.mockReset();
        mockLuaInvoke.mockResolvedValue({ ok: 'enqueued' });
    });

    it('writeTerminalToPostgres UPDATE excludes already-cancelled rows', async () => {
        // Verify the WHERE clause includes AND state NOT IN ('completed', 'cancelled')
        // and a no-results UPDATE does not corrupt state. We assert by inspecting
        // the SQL template head string the orchestrator builds.
        const fake = makeFakeSql();
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        // Drive the private writeTerminalToPostgres('failed') as if the failed
        // event arrived AFTER HardKill already wrote 'cancelled' to Postgres.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (orch as any).writeTerminalToPostgres('run_late_failed', 'failed', {
            errorMessage: 'late-failed-event',
            completedAt: new Date().toISOString(),
        });

        // Find the UPDATE call and assert it has the short-circuit guard.
        const updateCall = fake.recorder.calls.find((c) =>
            c.strings.join(' ').includes('UPDATE task_history'),
        );
        expect(updateCall).toBeDefined();
        const updateSql = updateCall!.strings.join(' ');
        expect(updateSql).toMatch(/state NOT IN \('completed', 'cancelled'\)/);
        // RETURNING task_id present (used to decide if the row was actually updated).
        expect(updateSql).toMatch(/RETURNING task_id/);
        await orch.stop();
    });

    it('flushTransitions retries cancelling→cancelled when active→failed loses', async () => {
        // Build a state machine whose transitionRun mock rejects the
        // active→failed call (Valkey hash says 'cancelling'), then accepts
        // the follow-up cancelling→cancelled retry.
        const reg = makeRegistry();
        const transitionSpy = vi.fn(async (args: { from: string; to: string }) => {
            if (args.from === 'active' && args.to === 'failed') {
                return {
                    ok: false,
                    error: 'state-mismatch: expected active, got cancelling',
                };
            }
            if (args.from === 'cancelling' && args.to === 'cancelled') {
                return { ok: true };
            }
            return { ok: true };
        });
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        // Seed Valkey so readRunState returns 'cancelling' for the run.
        client._hashes.set('task:run:active:run_kill_F4', new Map([['state', 'cancelling']]));

        const fake = makeFakeSql();
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        // Drive the private flushTransitions directly, as if the BullMQ
        // QueueEvents 'failed' handler enqueued an active→failed transition.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (orch as any).flushTransitions([
            {
                runId: 'run_kill_F4',
                from: 'active',
                to: 'failed',
                extra: {
                    failedAt: new Date().toISOString(),
                    errorMessage: 'hard-cancel',
                },
            },
        ]);

        // The state machine saw BOTH transitions: the failed attempt and the
        // cancelling→cancelled retry.
        const rawCalls = transitionSpy.mock.calls as unknown as Array<
            [{ from: string; to: string }]
        >;
        const calls = rawCalls.map((c) => c[0]);
        expect(calls).toContainEqual(expect.objectContaining({ from: 'active', to: 'failed' }));
        expect(calls).toContainEqual(
            expect.objectContaining({ from: 'cancelling', to: 'cancelled' }),
        );

        // Postgres UPDATE was issued with state='cancelled' (not 'failed').
        const updateCalls = fake.recorder.calls.filter((c) =>
            c.strings.join(' ').includes('UPDATE task_history'),
        );
        expect(updateCalls.length).toBeGreaterThan(0);
        // The retry path calls writeTerminalToPostgres(runId, 'cancelled', ...);
        // the cancelled state is passed as a positional interpolation, so look
        // for it in the values array of the UPDATE call.
        const cancelledUpdate = updateCalls.find((c) => c.values.some((v) => v === 'cancelled'));
        expect(cancelledUpdate).toBeDefined();

        // And there's no UPDATE with state='failed' for this run.
        const failedUpdate = updateCalls.find(
            (c) => c.values.some((v) => v === 'failed') && c.values.includes('run_kill_F4'),
        );
        expect(failedUpdate).toBeUndefined();

        await orch.stop();
    });

    it('flushTransitions does NOT retry when live state is not cancelling', async () => {
        // Sanity guard: if the Lua transition fails for some unrelated reason
        // (e.g. run state is 'active' but Lua races us), we must NOT retry
        // cancelling→cancelled and silently corrupt the run as 'cancelled'.
        const reg = makeRegistry();
        const transitionSpy = vi.fn(async () => ({
            ok: false,
            error: 'spurious-conflict',
        }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        // Seed live state as 'active' (not cancelling). The retry guard must skip.
        client._hashes.set('task:run:active:run_no_retry', new Map([['state', 'active']]));

        const fake = makeFakeSql();
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (orch as any).flushTransitions([
            { runId: 'run_no_retry', from: 'active', to: 'failed', extra: {} },
        ]);

        // No cancelling→cancelled retry happened.
        const calls = transitionSpy.mock.calls as unknown as Array<[{ from: string; to: string }]>;
        const retried = calls.find((c) => c[0].from === 'cancelling' && c[0].to === 'cancelled');
        expect(retried).toBeUndefined();

        await orch.stop();
    });

    it('flushTransitions treats an already-completed run as an idempotent QueueEvents delivery', async () => {
        // TaskRunner transitions active→completed before BullMQ publishes the
        // normal QueueEvents completion notification. The duplicate CAS must
        // not be reported as a competing-server transition conflict.
        const reg = makeRegistry();
        const transitionSpy = vi.fn(async () => ({
            ok: false,
            error: 'state-mismatch: expected active, got completed',
        }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        client._hashes.set(
            'task:run:terminal:run_already_completed',
            new Map([['state', 'completed']]),
        );

        const fake = makeFakeSql();
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });
        mockPublishMessage.mockClear();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (orch as any).flushTransitions([
            { runId: 'run_already_completed', from: 'active', to: 'completed', extra: {} },
        ]);

        expect(transitionSpy).toHaveBeenCalledTimes(1);
        const updateCalls = fake.recorder.calls.filter((c) =>
            c.strings.join(' ').includes('UPDATE task_history'),
        );
        expect(
            updateCalls.some(
                (c) => c.values.includes('completed') && c.values.includes('run_already_completed'),
            ),
        ).toBe(true);
        expect(mockPublishMessage).not.toHaveBeenCalled();

        await orch.stop();
    });

    // O2 — orphan-sweep force-completes a stuck waiting-children parent via
    // `moveToCompleted`, firing QueueEvents 'completed' → an active→completed
    // transition request. That parent never ran its processor (it was lazily
    // resolved by BullMQ), so its live state is still `pending` and the Lua
    // state machine forbids pending→completed. WITHOUT the symmetric bypass the
    // parent lands as a spurious `failed` (or wedges in pending). The bypass
    // must write the terminal `completed` straight to Postgres.
    it('flushTransitions lands a pending parent as completed (O2 orphan-sweep moveToCompleted)', async () => {
        const reg = makeRegistry();
        // active→completed always loses (run is pending, not active). The Lua
        // mock mirrors the real state machine rejecting an illegal from-state.
        const transitionSpy = vi.fn(async (args: { from: string; to: string }) => {
            if (args.from === 'active' && args.to === 'completed') {
                return { ok: false, error: 'state-mismatch: expected active, got pending' };
            }
            return { ok: true };
        });
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        // Seed Valkey so readRunState returns 'pending' for the orphan parent.
        client._hashes.set('task:run:active:run_orphan_parent', new Map([['state', 'pending']]));

        const fake = makeFakeSql();
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        // Drive flushTransitions as if the QueueEvents 'completed' handler
        // enqueued an active→completed transition for the force-completed parent.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (orch as any).flushTransitions([
            {
                runId: 'run_orphan_parent',
                from: 'active',
                to: 'completed',
                extra: { completedAt: new Date().toISOString() },
            },
        ]);

        const updateCalls = fake.recorder.calls.filter((c) =>
            c.strings.join(' ').includes('UPDATE task_history'),
        );
        // Terminal written as 'completed' …
        const completedUpdate = updateCalls.find(
            (c) => c.values.includes('completed') && c.values.includes('run_orphan_parent'),
        );
        expect(completedUpdate).toBeDefined();
        // … NOT 'failed' (the spurious outcome without the bypass).
        const failedUpdate = updateCalls.find(
            (c) => c.values.includes('failed') && c.values.includes('run_orphan_parent'),
        );
        expect(failedUpdate).toBeUndefined();
        // The stale `pending` hash is discarded so the reconciler doesn't
        // re-reclaim it as an orphan. `discardRunStateHash` issues a DEL on the
        // active hash key via customCommand.
        const cmdCalls = (client.customCommand as unknown as { mock: { calls: string[][][] } }).mock
            .calls;
        const deletedHash = cmdCalls.some(
            (args) =>
                args[0]?.[0] === 'DEL' && args[0]?.[1] === 'task:run:active:run_orphan_parent',
        );
        expect(deletedHash).toBe(true);

        await orch.stop();
    });

    it('flushTransitions does NOT bypass-complete when live state is active (O2 guard)', async () => {
        // If active→completed loses for an UNRELATED reason while the run is
        // genuinely active (Lua race), we must NOT write a terminal completed
        // behind the state machine's back — fall through to transition-conflict.
        const reg = makeRegistry();
        const transitionSpy = vi.fn(async () => ({ ok: false, error: 'spurious-conflict' }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        client._hashes.set('task:run:active:run_active_race', new Map([['state', 'active']]));

        const fake = makeFakeSql();
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (orch as any).flushTransitions([
            { runId: 'run_active_race', from: 'active', to: 'completed', extra: {} },
        ]);

        const updateCalls = fake.recorder.calls.filter((c) =>
            c.strings.join(' ').includes('UPDATE task_history'),
        );
        const anyTerminalUpdate = updateCalls.find((c) => c.values.includes('run_active_race'));
        expect(anyTerminalUpdate).toBeUndefined();

        await orch.stop();
    });
});

// ── F5: runId encoded in BullMQ jobId survives QueueEvents-after-reap ─────────
//
// Scenario:
//   BullMQ's `removeOnComplete` (or removeOnFail) reaps the job from the queue
//   the instant it terminates. If QueueEvents fires after the reap, calling
//   `queue.getJob(jobId)` returns null. Without the runId encoded in the jobId,
//   the orchestrator can't map the event to a Run and the terminal transition
//   is dropped silently — the run sits in 'active' until the 5-minute
//   reconciler sweep.
//
// Fix: every queue.add / FlowProducer.add call sets `opts.jobId` to a string
// containing `#<runId>` as the suffix. `runIdFromJobId` parses the suffix so
// QueueEvents handlers no longer need to probe the queue.
describe('TaskOrchestrator — F5 runId encoded in BullMQ jobId', () => {
    let client: FakeClient;
    beforeEach(() => {
        client = makeFakeClient();
        mockLuaInvoke.mockReset();
        mockLuaInvoke.mockResolvedValue({ ok: 'enqueued' });
    });

    it('queue.add receives a jobId encoded with the runId suffix', async () => {
        const fake = makeFakeSql();
        const queue = makeFakeQueue();
        const { orch } = await bootOrchestrator({
            client,
            sql: fake.sql,
            queue,
        });

        const result = await orch.startRun('basic-task', { name: 'enc' });
        expect(result.runId).toMatch(/^run_/);

        expect(queue.add).toHaveBeenCalledOnce();
        const callArgs = queue.add.mock.calls[0] as unknown as [string, unknown, { jobId: string }];
        const opts = callArgs[2];
        expect(opts.jobId).toMatch(/#run_/);
        expect(opts.jobId.endsWith(result.runId)).toBe(true);

        await orch.stop();
    });

    it('FlowProducer.add receives FlowJobs with runId-encoded jobIds for every member', async () => {
        const fake = makeFakeSql();
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'pipe-f5-a',
                name: 'A',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ name: z.string() }),
                identityFor: (input) => input.name,
                pipeline: { of: 'f5-pipe' },
                execute: async () => ({ success: true }),
            }),
        );
        reg.registerTask(
            defineTask({
                id: 'pipe-f5-b',
                name: 'B',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'b',
                pipeline: { of: 'f5-pipe', after: ['pipe-f5-a'] },
                execute: async () => ({ success: true }),
            }),
        );

        const addedRoots: unknown[] = [];
        const fp = {
            add: vi.fn(async (job: unknown) => {
                addedRoots.push(job);
                return {};
            }),
            close: vi.fn(async () => {}),
        };

        const sm = {
            transitionRun: vi.fn(async () => ({ ok: true })),
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => makeFakeQueue() as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: fp as unknown as FlowProducer,
        });

        await orch.startRun('pipe-f5-a', { name: 'gamma' });

        expect(addedRoots).toHaveLength(1);
        // The root is pipe-f5-b (terminal node) and contains pipe-f5-a as child.
        // Walk the FlowJob tree and assert every job's opts.jobId includes #run_.
        interface FlowJobShape {
            name: string;
            opts?: { jobId?: string };
            children?: FlowJobShape[];
        }
        const root = addedRoots[0] as FlowJobShape;
        const walk = (j: FlowJobShape): FlowJobShape[] => [j, ...(j.children ?? []).flatMap(walk)];
        const allJobs = walk(root);
        expect(allJobs.length).toBeGreaterThanOrEqual(2);
        for (const job of allJobs) {
            expect(job.opts?.jobId).toBeDefined();
            expect(job.opts!.jobId!).toMatch(/#run_/);
        }

        await orch.stop();
    });

    it('flushTransitions resolves runId from encoded jobId WITHOUT probing the queue (survives reap)', async () => {
        // Simulate the post-reap scenario: queue.getJob returns null for EVERY
        // probe. The transition must still succeed because the encoded jobId
        // alone carries the runId.
        const reg = makeRegistry();
        const transitionSpy = vi.fn(async () => ({ ok: true }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        // Force getJob() to always return null — the job has been reaped.
        const queue = {
            add: vi.fn(async () => ({ id: 'job-id' })),
            getJob: vi.fn(async () => null),
            close: vi.fn(async () => {}),
        };

        const fake = makeFakeSql();
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => queue as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        // Drive flushTransitions directly with a jobId-shaped req.runId that
        // mirrors what the QueueEvents 'completed' / 'failed' handler enqueues
        // when the job arrives encoded as `<taskId>~~<formula>#<runId>`.
        const encodedJobId = 'basic-task~~alpha#run_01HXENCODED';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (orch as any).flushTransitions([
            {
                runId: encodedJobId,
                from: 'active',
                to: 'completed',
                extra: { completedAt: new Date().toISOString() },
            },
        ]);

        // The Lua transition should be called with the *decoded* runId.
        expect(transitionSpy).toHaveBeenCalledTimes(1);
        const transitionCalls = transitionSpy.mock.calls as unknown as Array<
            [{ runId: string; from: string; to: string }]
        >;
        const callArg = transitionCalls[0][0];
        expect(callArg.runId).toBe('run_01HXENCODED');
        expect(callArg.from).toBe('active');
        expect(callArg.to).toBe('completed');

        // Crucially, the queue was never probed — runId came from the suffix.
        expect(queue.getJob).not.toHaveBeenCalled();

        await orch.stop();
    });

    it('flushTransitions still resolves runId from encoded jobId on FAILED transitions after reap', async () => {
        // Same scenario as above but for the 'failed' QueueEvents event —
        // returnvalue is NOT populated on failure, so jobId-encoding is the
        // only path that works.
        const reg = makeRegistry();
        const transitionSpy = vi.fn(async () => ({ ok: true }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        const queue = {
            add: vi.fn(async () => ({ id: 'job-id' })),
            getJob: vi.fn(async () => null),
            close: vi.fn(async () => {}),
        };

        const fake = makeFakeSql();
        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => queue as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        const encodedJobId = 'basic-task~~beta#run_01HXFAILED';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (orch as any).flushTransitions([
            {
                runId: encodedJobId,
                from: 'active',
                to: 'failed',
                extra: {
                    failedAt: new Date().toISOString(),
                    errorMessage: 'boom',
                },
            },
        ]);

        expect(transitionSpy).toHaveBeenCalled();
        const failedCalls = transitionSpy.mock.calls as unknown as Array<
            [{ runId: string; to: string }]
        >;
        const callArg = failedCalls[0][0];
        expect(callArg.runId).toBe('run_01HXFAILED');
        expect(callArg.to).toBe('failed');
        expect(queue.getJob).not.toHaveBeenCalled();

        await orch.stop();
    });

    it('QueueEvents `completed` handler decodes runId and retains its producer attempt', async () => {
        // End-to-end: attach a real QueueEvents-shaped emitter, fire the
        // 'completed' event with an encoded jobId, and verify the transition
        // is enqueued with the decoded runId.
        const reg = makeRegistry();
        const transitionSpy = vi.fn(async () => ({ ok: true }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        const fake = makeFakeSql();
        const queue = { ...makeFakeQueue(), name: 'io' };
        queue.getJob.mockImplementation(async (id: string) => ({
            id,
            data: {},
            attemptsMade: 1,
            getState: async () => 'completed',
            returnvalue: { success: true },
            finishedOn: Date.now(),
        }));

        // Minimal QueueEvents-like emitter: a typed `on` registrar that lets
        // the test fire the events the orchestrator subscribes to.
        type Handler = (payload: Record<string, unknown>) => void;
        const handlers = new Map<string, Handler>();
        const fakeQE = {
            name: 'io',
            on: (event: string, h: Handler) => {
                handlers.set(event, h);
                return fakeQE;
            },
            close: vi.fn(async () => {}),
            waitUntilReady: async () => {},
        };

        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => queue as unknown as Queue,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            queueEventsFactory: () => fakeQE as any,
            flowProducer: null,
        });

        // Fire the completed handler with a fully-encoded jobId. The handler
        // pushes a transition into the batcher, which flushes asynchronously.
        const completed = handlers.get('completed');
        expect(completed).toBeDefined();
        completed!({
            jobId: 'basic-task~~iota#run_01HXQE',
            returnvalue: { success: true },
        });

        // Let the batcher flush.
        await new Promise((r) => setTimeout(r, 80));

        const qeCalls = transitionSpy.mock.calls as unknown as Array<[{ runId: string }]>;
        const found = qeCalls.find((c) => c[0].runId === 'run_01HXQE');
        expect(found).toBeDefined();

        await orch.stop();
    });
});

// ── listRuns ──────────────────────────────────────────────────────────────────

describe('TaskOrchestrator.listRuns', () => {
    let client: FakeClient;
    beforeEach(() => {
        client = makeFakeClient();
    });

    it('returns an empty list when Postgres is unavailable', async () => {
        const { orch } = await bootOrchestrator({ client });
        const result = await orch.listRuns({});
        expect(result).toEqual({ runs: [] });
        await orch.stop();
    });

    it('emits nextCursor when more rows exist than the requested limit', async () => {
        const fake = makeFakeSql();
        const rows = Array.from({ length: 11 }).map((_, i) => ({
            id: `run_${i}`,
            task_id: 't',
            label: 'l',
            state: 'completed',
            started_at: new Date(2026, 0, 1, 0, i).toISOString(),
            input: {},
            trigger: { kind: 'manual' },
            actor: { type: 'system' },
            stages: [],
        }));
        fake.recorder.responses.set('SELECT id, task_id', rows);
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });
        const result = await orch.listRuns({ limit: 10 });
        expect(result.runs).toHaveLength(10);
        expect(result.nextCursor).toBeTypeOf('string');
        await orch.stop();
    });
});

describe.each([false, true])(
    'live run heartbeat contract (per-task queues: %s)',
    (perTaskQueues) => {
        const runId = 'run_heartbeat_contract';

        function activeRunRow(heartbeatAt: string | Date | null = '2026-10-26T07:59:00Z') {
            return {
                id: runId,
                task_id: 'basic-task',
                label: 'Basic',
                state: 'active',
                input: { name: 'heartbeat' },
                scope: null,
                trigger: { kind: 'manual' },
                actor: { type: 'user' },
                started_at: new Date('2026-10-26T07:58:00Z'),
                execution_started_at: null,
                heartbeat_at: heartbeatAt,
                stages: [],
            };
        }

        async function startReader(client: FakeClient, fake: ReturnType<typeof makeFakeSql>) {
            const queue = makeFakeQueue();
            return TaskOrchestrator.start(['io'], {
                registry: makeRegistry(),
                stateMachine: {
                    transitionRun: vi.fn(async () => ({ ok: true })),
                } as unknown as StateMachine,
                getSql: () => fake.sql as unknown as postgres.Sql,
                getClient: () => client,
                queueFactory: () => queue as unknown as Queue,
                queueEventsFactory: () => null,
                perTaskQueues,
                taskQueueFactory: () => queue as unknown as Queue,
                perTaskQueueEventsFactory: () => null,
                flowProducer: null,
            });
        }

        it.each([
            ['Postgres text', '2026-10-25 13:14:15.123456+02', '2026-10-25T11:14:15.123Z'],
            ['Date', new Date('2026-10-25T11:14:15.123Z'), '2026-10-25T11:14:15.123Z'],
            ['malformed text', 'not-a-timestamp', undefined],
            ['invalid Date', new Date(NaN), undefined],
            ['absent', null, undefined],
        ])('serializes a SQL heartbeat as ISO or absent: %s', async (_label, value, expected) => {
            const client = makeFakeClient();
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                activeRunRow(value),
            ]);
            const orch = await startReader(client, fake);
            try {
                const single = await orch.getRun(runId);
                expect(single).not.toBeNull();
                expect(single?.heartbeatAt).toBe(expected);
                const listed = await orch.listRuns({ limit: 50 });
                expect(listed.runs).toHaveLength(1);
                expect(listed.runs[0]?.heartbeatAt).toBe(expected);
                expect(RunSchema.safeParse(listed.runs[0]).success).toBe(true);
            } finally {
                await orch.stop();
            }
        });

        it('normalizes a runner-shaped epoch heartbeat through getRun and listRuns', async () => {
            const client = makeFakeClient();
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                activeRunRow(),
            ]);
            client._hashes.set(
                `task:run:active:${runId}`,
                new Map([
                    ['state', 'active'],
                    ['heartbeatAt', '1793001600123'],
                    ['stage:scan:processed', '4'],
                    ['stage:scan:total', '9'],
                    ['stage:scan:currentItem', 'episode.mkv'],
                ]),
            );
            const orch = await startReader(client, fake);
            try {
                const expectedHeartbeat = new Date(1793001600123).toISOString();
                const single = await orch.getRun(runId);
                expect(single?.heartbeatAt).toBe(expectedHeartbeat);
                expect(RunSchema.safeParse(single).success).toBe(true);
                expect(single?.stages).toContainEqual({
                    id: 'scan',
                    label: 'scan',
                    state: 'active',
                    processed: 4,
                    total: 9,
                    currentItem: 'episode.mkv',
                });

                const listed = await orch.listRuns({});
                expect(listed.runs[0]?.heartbeatAt).toBe(expectedHeartbeat);
                expect(RunSchema.safeParse(listed.runs[0]).success).toBe(true);
                expect(listed.runs[0]?.stages).toEqual(single?.stages);
            } finally {
                await orch.stop();
            }
        });

        it('canonicalizes a valid legacy ISO offset without changing its instant', async () => {
            const client = makeFakeClient();
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                activeRunRow(),
            ]);
            client._hashes.set(
                `task:run:active:${runId}`,
                new Map([['heartbeatAt', '2026-10-26T10:01:02.003+02:00']]),
            );
            const orch = await startReader(client, fake);
            try {
                const run = await orch.getRun(runId);
                expect(run?.heartbeatAt).toBe('2026-10-26T08:01:02.003Z');
                expect(RunSchema.safeParse(run).success).toBe(true);
            } finally {
                await orch.stop();
            }
        });

        it('keeps newer SQL heartbeat evidence over an older valid live observation', async () => {
            const client = makeFakeClient();
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                activeRunRow('2026-10-26T08:01:00Z'),
            ]);
            client._hashes.set(
                `task:run:active:${runId}`,
                new Map([['heartbeatAt', '1793001600123']]),
            );
            const orch = await startReader(client, fake);
            try {
                const single = await orch.getRun(runId);
                expect(single?.heartbeatAt).toBe('2026-10-26T08:01:00.000Z');
                expect(RunSchema.safeParse(single).success).toBe(true);

                const listed = await orch.listRuns({});
                expect(listed.runs[0]?.heartbeatAt).toBe('2026-10-26T08:01:00.000Z');
                expect(RunSchema.safeParse(listed.runs[0]).success).toBe(true);
            } finally {
                await orch.stop();
            }
        });

        it('uses a valid newer live heartbeat when SQL has no heartbeat', async () => {
            const client = makeFakeClient();
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                activeRunRow(null),
            ]);
            client._hashes.set(
                `task:run:active:${runId}`,
                new Map([['heartbeatAt', '1793001600123']]),
            );
            const orch = await startReader(client, fake);
            try {
                const expectedHeartbeat = new Date(1793001600123).toISOString();
                const single = await orch.getRun(runId);
                expect(single?.heartbeatAt).toBe(expectedHeartbeat);
                expect(RunSchema.safeParse(single).success).toBe(true);

                const listed = await orch.listRuns({});
                expect(listed.runs[0]?.heartbeatAt).toBe(expectedHeartbeat);
                expect(RunSchema.safeParse(listed.runs[0]).success).toBe(true);
            } finally {
                await orch.stop();
            }
        });

        it.each([
            '',
            'garbage',
            'NaN',
            '1.5',
            '9007199254740992',
            '8640000000000001',
            '2026-02-30T00:00:00Z',
        ])('keeps SQL heartbeat when live value %j is unusable', async (liveHeartbeat) => {
            const client = makeFakeClient();
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                activeRunRow('2026-10-26T07:59:00Z'),
            ]);
            client._hashes.set(
                `task:run:active:${runId}`,
                new Map([['heartbeatAt', liveHeartbeat]]),
            );
            const orch = await startReader(client, fake);
            try {
                const run = await orch.getRun(runId);
                expect(run?.heartbeatAt).toBe('2026-10-26T07:59:00.000Z');
                expect(RunSchema.safeParse(run).success).toBe(true);
            } finally {
                await orch.stop();
            }
        });

        it.each(['8640000000000000', '-8640000000000000'])(
            'keeps strict RunSchema timestamps when live epoch %s is a valid Date with an extended year',
            async (liveHeartbeat) => {
                const client = makeFakeClient();
                const fake = makeFakeSql();
                fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                    activeRunRow('2026-10-26T07:59:00Z'),
                ]);
                client._hashes.set(
                    `task:run:active:${runId}`,
                    new Map([['heartbeatAt', liveHeartbeat]]),
                );
                const orch = await startReader(client, fake);
                try {
                    const single = await orch.getRun(runId);
                    expect.soft(RunSchema.safeParse(single).success).toBe(true);
                    expect(single?.heartbeatAt).toBe('2026-10-26T07:59:00.000Z');

                    const listed = await orch.listRuns({});
                    expect.soft(RunSchema.safeParse(listed.runs[0]).success).toBe(true);
                    expect(listed.runs[0]?.heartbeatAt).toBe('2026-10-26T07:59:00.000Z');
                } finally {
                    await orch.stop();
                }
            },
        );

        it('omits malformed live heartbeat when SQL has none and preserves other live facts', async () => {
            const client = makeFakeClient();
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                activeRunRow(null),
            ]);
            client._hashes.set(
                `task:run:active:${runId}`,
                new Map([
                    ['heartbeatAt', 'not-a-time'],
                    ['stage:scan:processed', '4'],
                ]),
            );
            const orch = await startReader(client, fake);
            try {
                const run = await orch.getRun(runId);
                expect(run?.heartbeatAt).toBeUndefined();
                expect(run?.stages[0]?.processed).toBe(4);
                expect(RunSchema.safeParse(run).success).toBe(true);
            } finally {
                await orch.stop();
            }
        });

        it('leaves SQL evidence intact when Valkey observation fails', async () => {
            const client = makeFakeClient();
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                activeRunRow('2026-10-26T07:59:00Z'),
            ]);
            const orch = await startReader(client, fake);
            client.customCommand = vi.fn(async (command: string[]) => {
                if (command[0] === 'HGETALL') throw new Error('Valkey unavailable');
                return null;
            });
            try {
                const run = await orch.getRun(runId);
                expect(run?.heartbeatAt).toBe('2026-10-26T07:59:00.000Z');
                expect(run?.state).toBe('active');
                expect(RunSchema.safeParse(run).success).toBe(true);
            } finally {
                await orch.stop();
            }
        });

        it('does not observe or merge stale live state for a terminal SQL row', async () => {
            const client = makeFakeClient();
            const fake = makeFakeSql();
            fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
                {
                    ...activeRunRow('2026-10-26T07:59:00Z'),
                    state: 'completed',
                    completed_at: new Date('2026-10-26T08:00:00Z'),
                },
            ]);
            client._hashes.set(
                `task:run:active:${runId}`,
                new Map([
                    ['state', 'active'],
                    ['heartbeatAt', '1793001600123'],
                ]),
            );
            const orch = await startReader(client, fake);
            try {
                const run = await orch.getRun(runId);
                expect(run?.state).toBe('completed');
                expect(run?.heartbeatAt).toBe('2026-10-26T07:59:00.000Z');
                expect(client.customCommand).not.toHaveBeenCalledWith([
                    'HGETALL',
                    `task:run:active:${runId}`,
                ]);
                expect(RunSchema.safeParse(run).success).toBe(true);
            } finally {
                await orch.stop();
            }
        });
    },
);

// ── recoverOnBoot ─────────────────────────────────────────────────────────────

describe('TaskOrchestrator.recoverOnBoot', () => {
    it('returns an empty report when there are no stale runs', async () => {
        const client = makeFakeClient();
        const fake = makeFakeSql();
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });
        const report = await orch.recoverOnBoot();
        expect(report).toEqual({ reclaimed: 0, total: 0, runIds: [] });
        await orch.stop();
    });
});

// ── stop lifecycle ────────────────────────────────────────────────────────────

describe('TaskOrchestrator.stop', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('releases leader lock and closes queues on stop', async () => {
        const client = makeFakeClient();
        const queue = makeFakeQueue();
        const { orch } = await bootOrchestrator({ client, queue });
        await orch.stop();
        expect(queue.close).toHaveBeenCalled();
        expect(client._setNxStore.has('lock:orch:io')).toBe(false);
    });
});

// ── lost-leader re-acquire ────────────────────────────────────────────────────

describe('TaskOrchestrator lost-leader re-acquire', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('a crash-simulated class never acquires again after reconciliation and retry horizons', async () => {
        vi.useFakeTimers();
        const client = makeFakeClient();
        const queueEventsFactory = vi.fn(() => null);
        const { orch } = await bootOrchestrator({ client, queueEventsFactory });
        const acquire = vi.spyOn(LeaderLock.prototype, 'acquire');
        try {
            const orphan = client._setNxStore.get('lock:orch:io');
            expect(orch.simulateCrashForTesting('io')).toBe(true);
            expect(client._setNxStore.get('lock:orch:io')).toBe(orphan);
            expect(orch.isLeaderForAnyClass()).toBe(false);

            // Two 15s reconciliation cycles plus the full 7s retry delay.
            // No deletion/expiry override: the fake store honors the original TTL.
            await vi.advanceTimersByTimeAsync(40_000);
            expect(
                acquire.mock.instances.filter(
                    (lock) => (lock as unknown as { key: string }).key === 'lock:orch:io',
                ),
                'crashed class issued a fresh leadership acquisition',
            ).toHaveLength(0);
            expect(orch.isLeaderForAnyClass(), 'crashed class resurrected').toBe(false);
            expect(queueEventsFactory).toHaveBeenCalledTimes(1);
            // The coordinator is deliberately outside this class-only simulation.
            expect(await client.customCommand(['GET', 'lock:orch:coordinator'])).toMatch(
                /test-instance:/,
            );
        } finally {
            acquire.mockRestore();
            await orch.stop();
        }
    });

    it('an acquisition completing after a simulated crash cannot attach leader subscriptions', async () => {
        vi.useFakeTimers();
        const client = makeFakeClient();
        const queueEventsFactory = vi.fn(() => null);
        const { orch } = await bootOrchestrator({ client, queueEventsFactory });
        const runtime = orch as unknown as {
            classes: Map<string, { leader: LeaderLock }>;
            tryReacquire(rt: { leader: LeaderLock }): Promise<void>;
        };
        const rt = runtime.classes.get('io')!;
        let complete!: () => void;
        const gate = new Promise<void>((resolve) => {
            complete = resolve;
        });
        const acquireNormally = rt.leader.acquire.bind(rt.leader);
        // Hold the acquisition at its async boundary, then exercise the real
        // LeaderLock success path, including rearming held state and renewal.
        const acquire = vi.spyOn(rt.leader, 'acquire').mockImplementationOnce(async () => {
            await gate;
            return acquireNormally();
        });
        const pending = runtime.tryReacquire(rt);
        try {
            expect(acquire).toHaveBeenCalledTimes(1);
            expect(orch.simulateCrashForTesting('io')).toBe(true);
            // Let the orphan expire normally before the delayed acquisition wins.
            await vi.advanceTimersByTimeAsync(6_000);
            complete();
            await pending;
            expect(
                queueEventsFactory,
                'late acquisition reattached crashed subscriptions',
            ).toHaveBeenCalledTimes(1);
            expect(orch.isLeaderForAnyClass()).toBe(false);
            const orphan = client._setNxStore.get('lock:orch:io');
            expect(orphan, 'late acquisition released the orphaned lease').toBeDefined();
            const expiresAt = orphan?.expiresAt;
            await vi.advanceTimersByTimeAsync(4_000);
            expect(orphan?.expiresAt, 'late acquisition kept renewing after the crash').toBe(
                expiresAt,
            );
        } finally {
            complete();
            await pending;
            acquire.mockRestore();
            await orch.stop();
        }
    });

    it('crashing one class leaves distinct surviving subscriptions handling terminal events', async () => {
        vi.useFakeTimers();
        const client = makeFakeClient();
        const database = makeFakeSql();
        const subscriptions = {
            io: makeQueueSubscription('io'),
            cpu: makeQueueSubscription('cpu'),
        };
        const queues = { io: makeTerminalQueue('io'), cpu: makeTerminalQueue('cpu') };
        const transitionRun = vi.fn(async () => ({ ok: true }));
        const orch = await TaskOrchestrator.start(['io', 'cpu'], {
            registry: makeRegistry(),
            stateMachine: { transitionRun } as unknown as StateMachine,
            getSql: () => database.sql as unknown as postgres.Sql,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: (cls) => queues[cls as 'io' | 'cpu'] as unknown as Queue,
            queueEventsFactory: (cls) =>
                subscriptions[cls as 'io' | 'cpu'] as unknown as QueueEvents,
            perTaskQueues: false,
            flowProducer: null,
        });
        try {
            expect(orch.simulateCrashForTesting('io')).toBe(true);
            expect(subscriptions.io.close).toHaveBeenCalledTimes(1);
            expect(subscriptions.io.listenerCount('completed')).toBe(0);
            expect(subscriptions.cpu.close).not.toHaveBeenCalled();
            subscriptions.cpu.emit('completed', { jobId: 'cpu-task#run_surviving_class' });
            await vi.advanceTimersByTimeAsync(40_000);
            expect(transitionRun).toHaveBeenCalledWith(
                expect.objectContaining({ runId: 'run_surviving_class', to: 'completed' }),
            );
            expect(
                database.recorder.calls.some(
                    (call) =>
                        call.strings.join('').includes('UPDATE task_history') &&
                        call.values.includes('run_surviving_class'),
                ),
            ).toBe(true);
            expect(orch.isLeaderForAnyClass()).toBe(true);
            expect(await client.customCommand(['GET', 'lock:orch:cpu'])).toMatch(/test-instance:/);
            expect(await client.customCommand(['GET', 'lock:orch:coordinator'])).toMatch(
                /test-instance:/,
            );
            expect(await client.customCommand(['GET', 'lock:orch:io'])).toBeNull();
        } finally {
            await orch.stop();
        }
    });

    it.each([
        'lookup',
        'state',
        'buffer',
        'observation-retry',
        'transition-retry',
        'flush-lookup',
    ] as const)(
        'a crashed class drops terminal work at %s and rejects later events even if close fails',
        async (phase) => {
            vi.useFakeTimers();
            const client = makeFakeClient();
            const database = makeFakeSql();
            const queue = makeTerminalQueue('io');
            const events = makeQueueSubscription('io');
            // Retain listeners to prove crash admission guards independently of close().
            events.close.mockRejectedValue(new Error('subscription close unavailable'));
            let finish!: () => void;
            const gate = new Promise<void>((resolve) => {
                finish = resolve;
            });
            const normalGetJob = queue.getJob.getMockImplementation()!;
            let lookups = 0;
            queue.getJob.mockImplementation(async (id: string) => {
                lookups++;
                if (phase === 'observation-retry') throw new Error('lookup unavailable');
                if (phase === 'lookup' || (phase === 'flush-lookup' && lookups > 1)) await gate;
                const job = await normalGetJob(id);
                if (phase === 'state')
                    job.getState = async () => {
                        await gate;
                        return 'completed';
                    };
                return job;
            });
            const { orch, transitionSpy } = await bootOrchestrator({
                client,
                sql: database.sql,
                queue,
                queueEventsFactory: () => events as unknown as QueueEvents,
            });
            if (phase === 'transition-retry')
                transitionSpy.mockRejectedValue(new Error('transition unavailable'));
            try {
                events.emit('completed', { jobId: 'basic-task#run_crash_terminal' });
                await vi.advanceTimersByTimeAsync(
                    phase === 'transition-retry' || phase === 'flush-lookup' ? 50 : 0,
                );
                const attempts = transitionSpy.mock.calls.length;
                const lookupsAtCrash = queue.getJob.mock.calls.length;
                expect(orch.simulateCrashForTesting('io')).toBe(true);
                events.emit('completed', { jobId: 'basic-task#run_after_crash' });
                finish();
                await vi.advanceTimersByTimeAsync(40_000);
                orch.isUpgradeQuiescent();
                await vi.advanceTimersByTimeAsync(1_000);
                expect(queue.getJob).toHaveBeenCalledTimes(lookupsAtCrash);
                expect(
                    transitionSpy,
                    'crashed class submitted terminal transition work',
                ).toHaveBeenCalledTimes(attempts);
                expect(
                    database.recorder.calls.filter((call) =>
                        call.strings.join('').includes('UPDATE task_history'),
                    ),
                ).toHaveLength(0);
                expect(orch.isUpgradeQuiescent()).toBe(true);
            } finally {
                finish();
                await orch.stop();
            }
        },
    );

    it('stop() does not wait forever on QueueEvents whose close never settles (Valkey down)', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const classes = ['io', 'cpu', 'maintenance'] as const;
        const subscriptions = new Map(classes.map((cls) => [cls, makeQueueSubscription(cls)]));
        // BullMQ behaviour while Valkey is down: close() waits for an 'end' that never comes.
        for (const events of subscriptions.values())
            events.close.mockImplementation(() => new Promise<void>(() => {}));
        const { orch } = await bootOrchestrator({
            client: makeFakeClient(),
            sql: makeFakeSql().sql,
            classes: [...classes],
            queueEventsFactory: (cls) => subscriptions.get(cls as 'io') as unknown as QueueEvents,
        });
        let stopped = false;
        const stopping = orch.stop().then(() => {
            stopped = true;
        });
        // The first close is given 2 s ...
        await vi.advanceTimersByTimeAsync(1_900);
        expect(stopped).toBe(false);
        // ... then Valkey is known unreachable and each remaining close gets only 200 ms.
        await vi.advanceTimersByTimeAsync(100 + 2 * 200 + 50);
        await stopping;
        expect(stopped).toBe(true);
        for (const events of subscriptions.values()) expect(events.close).toHaveBeenCalledTimes(1);
        const timedOutWarnings = warn.mock.calls.filter((c) =>
            String(c[0]).includes('Queue connection close timed out'),
        );
        expect(timedOutWarnings).toHaveLength(1);
        warn.mockRestore();
    });

    it('tells SSE subscribers once per outage and class, and always about other errors', async () => {
        vi.useFakeTimers();
        const events = makeQueueSubscription('io');
        const { orch } = await bootOrchestrator({
            client: makeFakeClient(),
            sql: makeFakeSql().sql,
            queueEventsFactory: () => events as unknown as QueueEvents,
        });
        const emitMeta = vi
            .spyOn(
                orch as unknown as { emitMeta: (t: string, d: unknown) => Promise<void> },
                'emitMeta',
            )
            .mockResolvedValue(undefined);
        const lost = (): number =>
            emitMeta.mock.calls.filter((c) => c[0] === 'subscription-lost').length;
        try {
            for (let i = 0; i < 10; i++) {
                events.emit('error', new Error('getaddrinfo ENOTFOUND lumastra-valkey'));
                await vi.advanceTimersByTimeAsync(1_000);
            }
            expect(lost()).toBe(1);
            // A different error inside the outage is not swallowed.
            events.emit('error', new Error('NOAUTH Authentication required.'));
            expect(lost()).toBe(2);
            // Quiet for longer than the window: the next connection loss is a new outage.
            await vi.advanceTimersByTimeAsync(31_000);
            events.emit('error', new Error('connect ECONNREFUSED 10.0.0.1:6379'));
            expect(lost()).toBe(3);
        } finally {
            await orch.stop();
        }
    });

    it.each([false, true])(
        'a crashed class submits no fallback or terminal event after awaited SQL, failure: %s',
        async (failSql) => {
            vi.useFakeTimers();
            const client = makeFakeClient();
            const database = makeFakeSql();
            database.recorder.responses.set('SELECT id, task_id, parent_run_id', [
                {
                    id: 'run_crash_sql',
                    task_id: 'basic-task',
                    label: 'SQL completion',
                    state: 'completed',
                    started_at: new Date(),
                    completed_at: new Date(),
                    input: {},
                    stages: [],
                    trigger: { kind: 'manual' },
                    actor: { type: 'system' },
                },
            ]);
            const queue = makeTerminalQueue('io');
            const events = makeQueueSubscription('io');
            let entered!: () => void;
            let finish!: () => void;
            const submitted = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                finish = resolve;
            });
            const sql = ((strings: readonly string[], ...values: unknown[]) => {
                const result = database.sql(strings, ...values);
                if (strings.join('').includes('UPDATE task_history')) {
                    entered();
                    return gate.then(() => {
                        if (failSql)
                            throw Object.assign(new Error('connection lost'), { code: '08006' });
                        return result;
                    });
                }
                return result;
            }) as FakeSqlFn;
            sql.json = database.sql.json;
            const { orch } = await bootOrchestrator({
                client,
                sql,
                queue,
                queueEventsFactory: () => events as unknown as QueueEvents,
            });
            const fallback = vi.spyOn(PendingWriteDrain.prototype, 'enqueue');
            const webhook = (
                orch as unknown as {
                    webhookOutbox: { enqueue: ReturnType<typeof vi.fn> };
                }
            ).webhookOutbox.enqueue;
            try {
                events.emit('completed', { jobId: 'basic-task#run_crash_sql' });
                await vi.advanceTimersByTimeAsync(50);
                await submitted;
                expect(orch.simulateCrashForTesting('io')).toBe(true);
                finish();
                await vi.advanceTimersByTimeAsync(40_000);
                expect(
                    fallback,
                    'crashed SQL continuation submitted fallback work',
                ).not.toHaveBeenCalled();
                expect(
                    mockPublishMessage.mock.calls.filter((args) =>
                        JSON.stringify(args).includes('run_crash_sql'),
                    ),
                    'crashed SQL continuation published a terminal event',
                ).toHaveLength(0);
                expect(
                    webhook.mock.calls.filter((args) =>
                        JSON.stringify(args).includes('run_crash_sql'),
                    ),
                    'crashed SQL continuation submitted a webhook',
                ).toHaveLength(0);
                // The SQL submission made before the crash is not rolled back.
                expect(
                    database.recorder.calls.filter((call) =>
                        call.strings.join('').includes('UPDATE task_history'),
                    ),
                ).toHaveLength(1);
                expect(orch.isUpgradeQuiescent()).toBe(true);
            } finally {
                finish();
                await orch.stop();
                fallback.mockRestore();
            }
        },
    );

    it.each(['terminal-row', 'publication'] as const)(
        'a crashed class makes no new terminal submissions after awaited %s',
        async (phase) => {
            vi.useFakeTimers();
            const runId = `run_crash_nested_${phase}`;
            const client = makeFakeClient();
            const database = makeFakeSql();
            database.recorder.responses.set('SELECT id, task_id, parent_run_id', [
                {
                    id: runId,
                    task_id: 'basic-task',
                    label: 'Nested completion',
                    state: 'completed',
                    started_at: new Date(),
                    completed_at: new Date(),
                    input: {},
                    stages: [],
                    trigger: { kind: 'manual' },
                    actor: { type: 'system' },
                },
            ]);
            let entered!: () => void;
            let finish!: () => void;
            const submitted = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const gate = new Promise<void>((resolve) => {
                finish = resolve;
            });
            const sql = ((strings: readonly string[], ...values: unknown[]) => {
                const result = database.sql(strings, ...values);
                if (
                    phase === 'terminal-row' &&
                    strings.join('').includes('SELECT id, task_id, parent_run_id') &&
                    values.includes(runId)
                ) {
                    entered();
                    return gate.then(() => result);
                }
                return result;
            }) as FakeSqlFn;
            sql.json = database.sql.json;
            const queue = makeTerminalQueue('io');
            const events = makeQueueSubscription('io');
            const { orch } = await bootOrchestrator({
                client,
                sql,
                queue,
                queueEventsFactory: () => events as unknown as QueueEvents,
            });
            const publishNormally = mockPublishMessage.getMockImplementation()!;
            mockPublishMessage.mockImplementation(async (...args) => {
                if (phase === 'publication' && JSON.stringify(args).includes(runId)) {
                    entered();
                    await gate;
                }
                return publishNormally(...args);
            });
            const fallback = vi.spyOn(PendingWriteDrain.prototype, 'enqueue');
            const webhook = (
                orch as unknown as {
                    webhookOutbox: { enqueue: ReturnType<typeof vi.fn> };
                }
            ).webhookOutbox.enqueue;
            const publications = () =>
                mockPublishMessage.mock.calls.filter((args) =>
                    JSON.stringify(args).includes(runId),
                );
            try {
                events.emit('completed', { jobId: `basic-task#${runId}` });
                await vi.advanceTimersByTimeAsync(50);
                await submitted;
                const acceptedPublications = phase === 'publication' ? 1 : 0;
                expect(publications()).toHaveLength(acceptedPublications);
                expect(orch.simulateCrashForTesting('io')).toBe(true);
                finish();
                await vi.advanceTimersByTimeAsync(40_000);
                // A publication submitted before crash may finish; the continuation
                // cannot create a later publication or enqueue a new webhook.
                expect(
                    publications(),
                    'crashed nested continuation published a new event',
                ).toHaveLength(acceptedPublications);
                expect(
                    webhook.mock.calls.filter((args) => JSON.stringify(args).includes(runId)),
                    'crashed nested continuation submitted a new webhook',
                ).toHaveLength(0);
                expect(fallback).not.toHaveBeenCalled();
                expect(
                    database.recorder.calls.filter((call) =>
                        call.strings.join('').includes('UPDATE task_history'),
                    ),
                ).toHaveLength(1);
                expect(orch.isUpgradeQuiescent()).toBe(true);
            } finally {
                finish();
                await orch.stop();
                mockPublishMessage.mockImplementation(publishNormally);
                fallback.mockRestore();
            }
        },
    );

    it('a successful transition completing after crash submits no terminal persistence', async () => {
        vi.useFakeTimers();
        const client = makeFakeClient();
        const database = makeFakeSql();
        const queue = makeTerminalQueue('io');
        const events = makeQueueSubscription('io');
        const { orch, transitionSpy } = await bootOrchestrator({
            client,
            sql: database.sql,
            queue,
            queueEventsFactory: () => events as unknown as QueueEvents,
        });
        let finish!: (result: { ok: boolean }) => void;
        const gate = new Promise<{ ok: boolean }>((resolve) => {
            finish = resolve;
        });
        transitionSpy.mockReturnValue(gate);
        const fallback = vi.spyOn(PendingWriteDrain.prototype, 'enqueue');
        const webhook = (
            orch as unknown as {
                webhookOutbox: { enqueue: ReturnType<typeof vi.fn> };
            }
        ).webhookOutbox.enqueue;
        try {
            events.emit('completed', { jobId: 'basic-task#run_crash_transition' });
            await vi.advanceTimersByTimeAsync(50);
            expect(transitionSpy).toHaveBeenCalledOnce();
            expect(orch.simulateCrashForTesting('io')).toBe(true);
            finish({ ok: true });
            await vi.advanceTimersByTimeAsync(40_000);
            expect(fallback).not.toHaveBeenCalled();
            expect(
                mockPublishMessage.mock.calls.filter((args) =>
                    JSON.stringify(args).includes('run_crash_transition'),
                ),
            ).toHaveLength(0);
            expect(
                webhook.mock.calls.filter((args) =>
                    JSON.stringify(args).includes('run_crash_transition'),
                ),
            ).toHaveLength(0);
            expect(
                database.recorder.calls.filter((call) =>
                    call.strings.join('').includes('UPDATE task_history'),
                ),
            ).toHaveLength(0);
            expect(orch.isUpgradeQuiescent()).toBe(true);
        } finally {
            finish({ ok: true });
            await orch.stop();
            fallback.mockRestore();
        }
    });

    it('per-task crash disconnects every crashed subscription while survivor and successor handle terminals', async () => {
        vi.useFakeTimers();
        const client = makeFakeClient();
        const database = makeFakeSql();
        const registry = makeRegistry();
        registry.registerTask(
            defineTask({
                id: 'cpu-task',
                name: 'CPU Task',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'cpu',
                inputSchema: z.unknown(),
                identityFor: () => 'global',
                execute: async () => ({ success: true }),
            }),
        );
        const taskIds = registry.getAllTasks().map((task) => task.id);
        const queues = new Map(taskIds.map((id) => [id, makeTerminalQueue(id)]));
        const aSubscriptions = new Map(taskIds.map((id) => [id, makeQueueSubscription(id)]));
        const bSubscriptions = new Map(taskIds.map((id) => [id, makeQueueSubscription(id)]));
        const transitionA = vi.fn(async () => ({ ok: true }));
        const transitionB = vi.fn(async () => ({ ok: true }));
        const start = (
            instanceId: string,
            transitionRun: typeof transitionA,
            subscriptions: typeof aSubscriptions,
        ) =>
            TaskOrchestrator.start(['io', 'cpu'], {
                registry,
                stateMachine: { transitionRun } as unknown as StateMachine,
                getSql: () => database.sql as unknown as postgres.Sql,
                getClient: () => client,
                instanceId,
                queueFactory: () => makeFakeQueue() as unknown as Queue,
                perTaskQueues: true,
                taskQueueFactory: (id) => queues.get(id)! as unknown as Queue,
                perTaskQueueEventsFactory: (id) => subscriptions.get(id)! as unknown as QueueEvents,
                flowProducer: null,
            });
        const a = await start('replica-a', transitionA, aSubscriptions);
        const b = await start('replica-b', transitionB, bSubscriptions);
        try {
            const crashedIds = registry
                .getAllTasks()
                .filter((task) => task.resourceClass === 'io')
                .map((task) => task.id);
            expect(crashedIds.length).toBeGreaterThan(1);
            expect(a.simulateCrashForTesting('io')).toBe(true);
            for (const id of crashedIds) {
                expect(
                    aSubscriptions.get(id)!.close,
                    `${id} subscription leaked`,
                ).toHaveBeenCalledOnce();
                expect(aSubscriptions.get(id)!.listenerCount('completed')).toBe(0);
            }
            expect(aSubscriptions.get('cpu-task')!.close).not.toHaveBeenCalled();
            aSubscriptions
                .get('cpu-task')!
                .emit('completed', { jobId: 'cpu-task#run_surviving_task' });
            await vi.advanceTimersByTimeAsync(8_000);
            expect(transitionA).toHaveBeenCalledWith(
                expect.objectContaining({ runId: 'run_surviving_task' }),
            );
            for (const id of crashedIds) {
                aSubscriptions.get(id)!.emit('completed', { jobId: `${id}#run_dead_${id}` });
                bSubscriptions.get(id)!.emit('completed', { jobId: `${id}#run_successor_${id}` });
            }
            await vi.advanceTimersByTimeAsync(100);
            expect(transitionA).toHaveBeenCalledTimes(1);
            for (const id of crashedIds)
                expect(transitionB).toHaveBeenCalledWith(
                    expect.objectContaining({ runId: `run_successor_${id}`, to: 'completed' }),
                );
            expect(
                database.recorder.calls.filter(
                    (call) =>
                        call.strings.join('').includes('UPDATE task_history') &&
                        call.values.some(
                            (value) =>
                                typeof value === 'string' && value.startsWith('run_successor_'),
                        ),
                ),
            ).toHaveLength(crashedIds.length);
        } finally {
            await a.stop();
            await b.stop();
        }
    });

    it('preserves missing-class and non-leader crash simulation contracts', async () => {
        const client = makeFakeClient();
        const { orch } = await bootOrchestrator({ client, leaderShouldAcquire: false });
        try {
            expect(orch.simulateCrashForTesting('cpu')).toBe(false);
            expect(() => orch.simulateCrashForTesting('io')).toThrow(/not the leader/);
        } finally {
            await orch.stop();
        }
    });

    it('schedules a re-acquire attempt on bootstrap when not initially leader', async () => {
        vi.useFakeTimers();
        const client = makeFakeClient();
        // Pre-claim the lock so the orchestrator boots as a standby.
        client._setNxStore.set('lock:orch:io', {
            value: 'other',
            expiresAt: Date.now() + 60_000,
        });

        const { orch } = await bootOrchestrator({
            client,
            leaderShouldAcquire: false,
        });

        // Free the lock and let the re-acquire timer fire (5-7s with jitter,
        // so advance past the upper bound).
        client._setNxStore.delete('lock:orch:io');
        await vi.advanceTimersByTimeAsync(8_000);

        // After the timer fires this replica should own the lock.
        expect(client._setNxStore.get('lock:orch:io')?.value).toMatch(/test-instance:/);
        await orch.stop();
    });
});

// ── Pipeline refactor (buildPipelinePlan delegation) ─────────────────────────

describe('TaskOrchestrator.startRun — pipeline', () => {
    afterEach(() => {
        vi.useRealTimers();
        mockLuaInvoke.mockReset();
        mockLuaInvoke.mockResolvedValue({ ok: 'enqueued' });
    });

    it('calls FlowProducer.add when a pipeline task is started', async () => {
        const client = makeFakeClient();
        const fake = makeFakeSql();

        // Build a registry with a two-step pipeline.
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'pipe-step-a',
                name: 'Step A',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ name: z.string() }),
                identityFor: (input) => input.name,
                pipeline: { of: 'test-pipe' },
                execute: async () => ({ success: true }),
            }),
        );
        reg.registerTask(
            defineTask({
                id: 'pipe-step-b',
                name: 'Step B',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'b',
                pipeline: { of: 'test-pipe', after: ['pipe-step-a'] },
                execute: async () => ({ success: true }),
            }),
        );

        const flowAddCalls: unknown[] = [];
        const fakeFlowProducer = {
            add: vi.fn(async (job: unknown) => {
                flowAddCalls.push(job);
                return {};
            }),
            close: vi.fn(async () => {}),
        };

        const fakeQueue = makeFakeQueue();
        const transitionSpy = vi.fn(async () => ({ ok: true }));
        const sm = {
            transitionRun: transitionSpy,
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => fakeQueue as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: fakeFlowProducer as unknown as FlowProducer,
        });

        const result = await orch.startRun('pipe-step-a', { name: 'alpha' });
        expect(result.runId).toMatch(/^run_/);

        // FlowProducer.add must have been called (once per pipeline root).
        expect(flowAddCalls).toHaveLength(1);

        // Regular queue.add should NOT have been called (pipeline path uses FP).
        expect(fakeQueue.add).not.toHaveBeenCalled();

        await orch.stop();
    });

    it('falls back to queue.add when FlowProducer is null', async () => {
        const client = makeFakeClient();
        const fake = makeFakeSql();

        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'pipe-step-only',
                name: 'Only',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ name: z.string() }),
                identityFor: (input) => input.name,
                pipeline: { of: 'solo-pipe' },
                execute: async () => ({ success: true }),
            }),
        );

        const fakeQueue = makeFakeQueue();
        const sm = {
            transitionRun: vi.fn(async () => ({ ok: true })),
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => fakeQueue as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        await orch.startRun('pipe-step-only', { name: 'beta' });

        // Fallback path: uses queue.add.
        expect(fakeQueue.add).toHaveBeenCalledOnce();

        await orch.stop();
    });
});

// ── Circuit breaker + backpressure integration ────────────────────────────────

import { CircuitBreaker } from './circuit-breaker.js';
import { Backpressure, BackpressureError as BPError } from './backpressure.js';

describe('TaskOrchestrator.startRun — circuit breaker', () => {
    it('throws TaskError when circuit is open', async () => {
        // Override the prototype check to return denied.
        const original = CircuitBreaker.prototype.check;
        CircuitBreaker.prototype.check = vi.fn(async () => ({
            allowed: false,
            state: 'open' as const,
            reason: 'open_with_cooldown' as const,
        }));

        const client = makeFakeClient();
        const fake = makeFakeSql();
        const { orch, queue } = await bootOrchestrator({
            client,
            sql: fake.sql,
        });

        await expect(orch.startRun('basic-task', { name: 'test' })).rejects.toBeInstanceOf(
            TaskError,
        );
        expect(queue.add).not.toHaveBeenCalled();

        CircuitBreaker.prototype.check = original;
        await orch.stop();
    });

    it('allows startRun when circuit is closed', async () => {
        // Default mock allows — just verify queue.add is called normally.
        const client = makeFakeClient();
        const fake = makeFakeSql();
        const { orch, queue } = await bootOrchestrator({
            client,
            sql: fake.sql,
        });

        await orch.startRun('basic-task', { name: 'test' });
        expect(queue.add).toHaveBeenCalledOnce();

        await orch.stop();
    });
});

describe('TaskOrchestrator.startRun — backpressure', () => {
    it('throws BackpressureError when queue is at cap with fail-fast', async () => {
        // Override the prototype check to throw BackpressureError.
        const original = Backpressure.prototype.check;
        Backpressure.prototype.check = vi.fn(async () => {
            throw new BPError(5_000);
        });

        const client = makeFakeClient();
        const fake = makeFakeSql();
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: 'ff-task',
                name: 'FF',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ x: z.string() }),
                identityFor: (input) => input.x,
                backpressure: { onQueueDepthOver: 1, action: 'fail-fast' },
                execute: async () => ({ success: true }),
            }),
        );

        const fakeQueue = makeFakeQueue();
        const sm = {
            transitionRun: vi.fn(async () => ({ ok: true })),
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            queueFactory: () => fakeQueue as unknown as Queue,
            queueEventsFactory: () => null,
            flowProducer: null,
        });

        await expect(orch.startRun('ff-task', { x: 'hi' })).rejects.toBeInstanceOf(BPError);
        expect(fakeQueue.add).not.toHaveBeenCalled();

        Backpressure.prototype.check = original;
        await orch.stop();
    });

    it('throws TaskError when backpressure drops the job', async () => {
        const original = Backpressure.prototype.check;
        Backpressure.prototype.check = vi.fn(async () => ({
            proceed: false,
            reason: 'backpressure-drop' as const,
        }));

        const client = makeFakeClient();
        const fake = makeFakeSql();
        const { orch, queue } = await bootOrchestrator({
            client,
            sql: fake.sql,
        });

        await expect(orch.startRun('basic-task', { name: 'test' })).rejects.toBeInstanceOf(
            TaskError,
        );
        expect(queue.add).not.toHaveBeenCalled();

        Backpressure.prototype.check = original;
        await orch.stop();
    });
});

// ── CloudEvents + WebhookOutbox wiring ───────────────────────────────────────

// Capture the enqueue spy across the module-level mock.
let outboxEnqueueSpy: ReturnType<typeof vi.fn>;

vi.mock('./webhook-outbox.js', () => {
    const enqueueFn = vi.fn(async () => {});
    // Expose so the describe block can reference it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).__outboxEnqueueSpy = enqueueFn;
    class MockWebhookOutbox {
        enqueue = enqueueFn;
        start = vi.fn();
        stop = vi.fn();
    }
    return { WebhookOutbox: MockWebhookOutbox };
});

describe('TaskOrchestrator.startRun — CloudEvents + WebhookOutbox', () => {
    beforeEach(() => {
        mockLuaInvoke.mockReset();
        mockLuaInvoke.mockResolvedValue({ ok: 'enqueued' });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outboxEnqueueSpy = (globalThis as any).__outboxEnqueueSpy as ReturnType<typeof vi.fn>;
        outboxEnqueueSpy.mockClear();
    });

    it('calls webhookOutbox.enqueue after a successful startRun', async () => {
        const client = makeFakeClient();
        const fake = makeFakeSql();
        const { orch } = await bootOrchestrator({ client, sql: fake.sql });

        await orch.startRun('basic-task', { name: 'hello' });

        expect(outboxEnqueueSpy).toHaveBeenCalledOnce();

        // Verify the event passed to enqueue is a valid CloudEvents 1.0 envelope.
        const event = outboxEnqueueSpy.mock.calls[0][0] as Record<string, unknown>;
        expect(event.specversion).toBe('1.0');
        expect(event.type).toBe('org.lumastra.task.run.started');
        expect(typeof event.id).toBe('string');

        await orch.stop();
    });
});

// Hard-kill wiring tests are excluded from the default test runner (see
// vitest.config.ts). The orchestrator-hard-kill.test.ts file exercises
// cancelRun({ hard: true }) → HardKill.schedule() wiring, but its import
// graph (orchestrator.ts + hard-kill.ts together) exceeds the V8 heap
// limit on a fresh worker fork. Run that file explicitly when needed.

// ── Wave 8.5: per-task-queue routing (FEATURE_PER_TASK_QUEUES on) ───────────────

it('decodes the live Glide hash entry shape used by production HGETALL', () => {
    expect(
        parseHGetAll([
            { key: 'state', value: 'active' },
            { key: 'startedAt', value: '2026-10-25T10:00:00Z' },
        ]),
    ).toEqual({
        state: 'active',
        startedAt: '2026-10-25T10:00:00Z',
    });
    expect(parseHGetAll([{ field: 'state', value: 'pending' }])).toEqual({ state: 'pending' });
});

describe.each([false, true])('run admission observation (per-task queues: %s)', (perTaskQueues) => {
    it('distinguishes direct waiting, playback deferral, unknown, and live execution', async () => {
        const client = makeFakeClient();
        const fake = makeFakeSql();
        const runId = 'run_observe';
        fake.recorder.responses.set('SELECT id, task_id, parent_run_id, label, state', [
            {
                id: runId,
                task_id: 'basic-task',
                label: 'Basic',
                state: 'pending',
                input: { name: 'fixture' },
                scope: null,
                trigger: { kind: 'manual' },
                actor: { type: 'user' },
                started_at: new Date('2026-10-25T10:00:00Z'),
                execution_started_at: null,
                stages: [],
            },
        ]);
        const queue = makeFakeQueue();
        const job = {
            data: { runId } as { runId: string; playbackDeferredAt?: number },
            getState: vi.fn(async () => 'waiting'),
        };
        queue.getJob.mockResolvedValue(job);
        const orch = await TaskOrchestrator.start(['io'], {
            registry: makeRegistry(),
            stateMachine: {
                transitionRun: vi.fn(async () => ({ ok: true })),
            } as unknown as StateMachine,
            getSql: () => fake.sql as unknown as postgres.Sql,
            getClient: () => client,
            queueFactory: () => queue as unknown as Queue,
            queueEventsFactory: () => null,
            perTaskQueues,
            taskQueueFactory: () => queue as unknown as Queue,
            perTaskQueueEventsFactory: () => null,
            flowProducer: null,
        });
        try {
            expect((await orch.getRun(runId))?.admissionObservation).toBe('waiting');
            expect(queue.getJob).toHaveBeenCalledTimes(1);

            job.data.playbackDeferredAt = Date.now();
            job.getState.mockResolvedValue('delayed');
            expect((await orch.getRun(runId))?.admissionObservation).toBe('playback-deferred');

            queue.getJob.mockResolvedValue(null);
            expect((await orch.getRun(runId))?.admissionObservation).toBeUndefined();

            client._hashes.set(
                `task:run:active:${runId}`,
                new Map([
                    ['state', 'active'],
                    ['startedAt', '2026-10-25T10:02:00Z'],
                ]),
            );
            const active = await orch.getRun(runId);
            expect(active?.state).toBe('active');
            expect(active?.admissionObservation).toBe('active');
            expect(active?.startedAt).toBe('2026-10-25T10:00:00.000Z');
            expect(active?.executionStartedAt).toBe('2026-10-25T10:02:00Z');
        } finally {
            await orch.stop();
        }
    });
});

describe('TaskOrchestrator.startRun with FEATURE_PER_TASK_QUEUES on', () => {
    let client: FakeClient;
    beforeEach(() => {
        client = makeFakeClient();
        mockLuaInvoke.mockReset();
        mockLuaInvoke.mockResolvedValue({ ok: 'enqueued' });
    });

    it('routes startRun to the per-task queue (not the per-class queue)', async () => {
        const reg = makeRegistry();
        const sm = {
            transitionRun: vi.fn(async () => ({ ok: true })),
            transitionStage: vi.fn(),
            incrementStage: vi.fn(),
            claimRun: vi.fn(),
        } as unknown as StateMachine;

        // One fake Queue per taskId so we can assert which one received the job.
        const perTaskQueues = new Map<string, ReturnType<typeof makeFakeQueue>>();
        const classQueue = makeFakeQueue();
        const fake = makeFakeSql();

        const orch = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine: sm,
            getSql: () => fake.sql as unknown as postgres.Sql | null,
            getClient: () => client,
            instanceId: 'test-instance',
            // Per-class queue still constructed (flag-off fallback path) but
            // should NOT receive the job under the flag.
            queueFactory: () => classQueue as unknown as Queue,
            queueEventsFactory: () => null,
            perTaskQueueEventsFactory: () => null,
            flowProducer: null,
            perTaskQueues: true,
            taskQueueFactory: (taskId: string) => {
                let q = perTaskQueues.get(taskId);
                if (!q) {
                    q = makeFakeQueue();
                    perTaskQueues.set(taskId, q);
                }
                return q as unknown as Queue;
            },
        });

        const result = await orch.startRun('basic-task', { name: 'alpha' });
        expect(result.runId).toMatch(/^run_/);

        // The job landed on the per-task queue for basic-task…
        const taskQueue = perTaskQueues.get('basic-task');
        expect(taskQueue).toBeDefined();
        expect(taskQueue!.add).toHaveBeenCalledTimes(1);
        const [jobName] = taskQueue!.add.mock.calls[0];
        expect(jobName).toBe('basic-task');
        // …and NOT on the legacy per-class queue.
        expect(classQueue.add).not.toHaveBeenCalled();

        await orch.stop();
    });
});

describe('queue publication and producer provenance', () => {
    const authority: AuthorityToken = {
        partition: 'tasks',
        generation: '2',
        ownerId: '10000000-0000-4000-8000-000000000001',
    };
    it('preserves run identity and history when a queue RPC has an uncertain outcome', async () => {
        const client = makeFakeClient();
        const fake = makeFakeSql();
        const queue = makeFakeQueue();
        queue.add.mockRejectedValue(
            new QueueOperationUncertainError(
                '10000000-0000-4000-8000-000000000003',
                new Error('lost ack'),
            ),
        );
        const { orch } = await bootOrchestrator({ client, sql: fake.sql, queue });
        const luaCallsBefore = mockLuaInvoke.mock.calls.length;
        mockLuaInvoke.mockResolvedValueOnce(['enqueued', 'claimed']);
        try {
            await expect(
                orch.startRun('exclusive-task', { id: 'uncertain' }),
            ).rejects.toBeInstanceOf(QueueOperationUncertainError);
            expect(queue.getJob).not.toHaveBeenCalled();
            const scripts = mockLuaInvoke.mock.calls.slice(luaCallsBefore).map((entry) => entry[0]);
            expect(scripts).toContain('enqueue-with-identity');
            expect(scripts).not.toContain('release-identity');
            expect(
                fake.recorder.calls.some((entry) =>
                    entry.strings.join('').includes('INSERT INTO task_history'),
                ),
            ).toBe(true);
            expect(
                fake.recorder.calls.some((entry) =>
                    entry.strings.join('').includes("SET state = 'failed'"),
                ),
            ).toBe(false);
        } finally {
            await orch.stop();
        }
    });
    it('rejects old producer events and ignores failed retry events while a later attempt is active', async () => {
        const client = makeFakeClient();
        const fake = makeFakeSql();
        const queue = { ...makeFakeQueue(), name: 'io' };
        const { orch, transitionSpy } = await bootOrchestrator({
            client,
            sql: fake.sql,
            queue,
            authority,
        });
        const handlers = new Map<
            string,
            (event: { jobId: string; failedReason: string }) => void
        >();
        const qe = {
            name: 'io',
            on(
                event: string,
                handler: (event: { jobId: string; failedReason: string }) => void,
            ): void {
                handlers.set(event, handler);
            },
        };
        const batcher = new TransitionBatcher(5, 100, async (batch) => {
            await (
                orch as unknown as {
                    flushTransitions(
                        batch: import('./transition-batcher.js').TransitionRequest[],
                    ): Promise<void>;
                }
            ).flushTransitions(batch);
        });
        (
            orch as unknown as { wireQueueEventsHandlers(rt: unknown, qe: QueueEvents): void }
        ).wireQueueEventsHandlers(
            { cls: 'io', batcher, terminalObservations: new Set() },
            qe as unknown as QueueEvents,
        );
        try {
            const old = { ...authority, generation: '1' };
            handlers.get('failed')!({
                jobId: taskJobId('basic-task#run_old', old),
                failedReason: 'old attempt',
            });
            await Promise.resolve();
            expect(queue.getJob).not.toHaveBeenCalled();
            const currentId = taskJobId('basic-task#run_current', authority);
            queue.getJob.mockResolvedValue({
                id: currentId,
                data: { taskAuthority: authority },
                getState: async () => 'active',
                attemptsMade: 1,
            });
            handlers.get('failed')!({ jobId: currentId, failedReason: 'first retry failed' });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(queue.getJob).toHaveBeenCalledWith(currentId);
            expect(transitionSpy).not.toHaveBeenCalled();
            for (const state of ['completed', 'failed'] as const) {
                const id = taskJobId(`basic-task#run_${state}`, authority);
                queue.getJob.mockResolvedValue({
                    id,
                    data: { taskAuthority: authority },
                    getState: async () => state,
                    attemptsMade: 2,
                    finishedOn: 123456,
                    returnvalue: { success: true, itemsProcessed: 7 },
                    failedReason: 'actual queue failure',
                });
                handlers.get(state)!({
                    jobId: id,
                    failedReason: 'stale event failure',
                    returnvalue: 'stale event result',
                } as { jobId: string; failedReason: string });
                await new Promise((resolve) => setTimeout(resolve, 20));
                expect(transitionSpy).toHaveBeenCalledWith(
                    expect.objectContaining({
                        runId: `run_${state}`,
                        to: state,
                        extra: expect.objectContaining(
                            state === 'completed'
                                ? {
                                      returnvalue: JSON.stringify({
                                          success: true,
                                          itemsProcessed: 7,
                                      }),
                                  }
                                : { errorMessage: 'actual queue failure' },
                        ),
                    }),
                );
            }
            fake.recorder.responses.set('SELECT id FROM task_history', [{ id: 'run_intent' }]);
            const callsBefore = transitionSpy.mock.calls.length;
            await (
                orch as unknown as {
                    flushTransitions(
                        batch: import('./transition-batcher.js').TransitionRequest[],
                    ): Promise<void>;
                }
            ).flushTransitions([
                { runId: 'run_intent', origin: authority, from: 'active', to: 'failed' },
            ]);
            expect(transitionSpy).toHaveBeenCalledTimes(callsBefore);
        } finally {
            await batcher.stop();
            await orch.stop();
        }
    });
});

it('stamps the actual managed orchestrator multi-stage FlowProducer tree', async () => {
    const authority = {
        partition: 'tasks',
        generation: '1',
        ownerId: '10000000-0000-4000-8000-000000000001',
    };
    const reg = new TaskRegistry();
    for (const [id, after] of [
        ['managed-a', []],
        ['managed-b', ['managed-a']],
    ] as const) {
        reg.registerTask(
            defineTask({
                id,
                name: id,
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.unknown(),
                identityFor: () => 'global',
                pipeline: { of: 'managed-pipeline', after: [...after] },
                execute: async () => ({ success: true }),
            }),
        );
    }
    const fake = makeFakeSql();
    const queue = makeFakeQueue();
    const client = makeFakeClient();
    const roots: FlowJob[] = [];
    const fp = {
        add: vi.fn(async (root: FlowJob) => {
            roots.push(root);
            return {};
        }),
        close: vi.fn(async () => {}),
    };
    const orch = await TaskOrchestrator.start(['io'], {
        registry: reg,
        authority,
        stateMachine: {
            transitionRun: vi.fn(async () => ({ ok: true })),
        } as unknown as StateMachine,
        getSql: () => fake.sql as unknown as postgres.Sql,
        getClient: () => client,
        instanceId: 'test-instance',
        queueFactory: () => queue as unknown as Queue,
        queueEventsFactory: () => null,
        flowProducer: fp as unknown as FlowProducer,
    });
    try {
        const result = await orch.startRun('managed-a', {});
        const pending = [...roots];
        const seen = new Set<string>();
        while (pending.length) {
            const job = pending.pop()!;
            seen.add(job.name);
            const data = job.data as { runId: string; taskAuthority: unknown };
            expect(data.taskAuthority).toEqual(authority);
            expect(taskJobOrigin(job.opts?.jobId)).toEqual(authority);
            expect(job.opts?.jobId?.endsWith(`#${data.runId}`)).toBe(true);
            if (job.name === 'managed-a') expect(data.runId).toBe(result.runId);
            pending.push(...(job.children ?? []));
        }
        expect([...seen].sort()).toEqual(['managed-a', 'managed-b']);
    } finally {
        await orch.stop();
    }
});

describe('TaskOrchestrator strict shutdown', () => {
    it.each([false, true])(
        'drains admitted terminal callbacks before stopping their batcher, observation fails: %s',
        async (failObservation) => {
            const authority: AuthorityToken = {
                partition: 'tasks',
                generation: '1',
                ownerId: '10000000-0000-4000-8000-000000000001',
            };
            const client = makeFakeClient();
            const database = makeFakeSql();
            const queue = { ...makeFakeQueue(), name: 'io' };
            const close = vi.fn(async (): Promise<void> => {});
            const events = Object.assign(new EventEmitter(), { name: 'io', close });
            let finish!: () => void;
            const held = new Promise<void>((resolve) => {
                finish = resolve;
            });
            const jobId = taskJobId('basic-task#run_callback_drain', authority);
            queue.getJob.mockImplementation(async () => {
                await held;
                if (failObservation) throw new Error('job observation unavailable');
                return {
                    id: jobId,
                    data: { taskAuthority: authority },
                    getState: async () => 'completed',
                    attemptsMade: 1,
                    returnvalue: { success: true },
                    finishedOn: Date.now(),
                };
            });
            const { orch, transitionSpy } = await bootOrchestrator({
                client,
                sql: database.sql,
                queue,
                authority,
                queueEventsFactory: () => events as unknown as QueueEvents,
            });
            try {
                events.emit('completed', { jobId, returnvalue: '{}' });
                expect(queue.getJob).toHaveBeenCalledOnce();
                const stopping = orch.stop({ strict: true });
                const observed = stopping.catch((error: unknown) => error);
                await vi.waitFor(() => {
                    expect(close).toHaveBeenCalledOnce();
                });
                expect(queue.close).not.toHaveBeenCalled();
                finish();
                const result = await observed;
                if (failObservation) {
                    expect(result).toMatchObject({
                        errors: [
                            expect.objectContaining({
                                message: expect.stringContaining('UNKNOWN'),
                            }),
                        ],
                    });
                    expect(orch.isShutdownCleanupComplete()).toBe(false);
                    expect(queue.close).not.toHaveBeenCalled();
                    queue.getJob.mockResolvedValue({
                        id: jobId,
                        data: { taskAuthority: authority },
                        getState: async () => 'completed',
                        attemptsMade: 1,
                        returnvalue: {},
                        finishedOn: Date.now(),
                    });
                    await orch.stop({ strict: true });
                } else expect(result).toBeUndefined();
                expect(transitionSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ runId: 'run_callback_drain', to: 'completed' }),
                );
                expect(
                    database.recorder.calls.some((entry) =>
                        entry.strings.join('').includes('UPDATE task_history'),
                    ),
                ).toBe(true);
                expect(orch.isShutdownCleanupComplete()).toBe(true);
                expect(queue.close).toHaveBeenCalledOnce();
            } finally {
                finish();
                queue.getJob.mockResolvedValue(null);
                await orch.stop({ strict: true });
            }
        },
    );

    it('retains terminal persistence when both SQL and fallback fail, then retries after tolerant stop', async () => {
        const client = makeFakeClient();
        const database = makeFakeSql();
        const failure = Object.assign(new Error('connection lost'), { code: '08006' });
        database.recorder.errors.set('UPDATE task_history', failure);
        const producerQueue = { ...makeFakeQueue(), name: 'io' };
        producerQueue.getJob.mockImplementation(async (id: string) => ({
            id,
            data: {},
            attemptsMade: 1,
            getState: async () => 'completed',
            returnvalue: {},
            finishedOn: Date.now(),
        }));
        const events = Object.assign(new EventEmitter(), {
            name: 'io',
            close: vi.fn(async (): Promise<void> => {}),
        });
        const { orch, queue } = await bootOrchestrator({
            client,
            sql: database.sql,
            queue: producerQueue,
            queueEventsFactory: () => events as unknown as QueueEvents,
        });
        const command = vi.mocked(client.customCommand).getMockImplementation()!;
        let fail = true;
        vi.mocked(client.customCommand).mockImplementation(async (args: string[]) => {
            if (args[0] === 'LPUSH' && args[1] === 'task:pending-writes' && fail)
                throw new Error('fallback unavailable');
            return command(args);
        });
        try {
            events.emit('completed', { jobId: 'basic-task#run_retained_drain', returnvalue: '{}' });
            await orch.stop();
            expect(orch.isShutdownCleanupComplete()).toBe(false);
            expect(queue.close).not.toHaveBeenCalled();
            await expect(orch.stop({ strict: true })).rejects.toThrow('shutdown is incomplete');
            fail = false;
            await orch.stop({ strict: true });
            expect(client._lists.get('task:pending-writes')).toHaveLength(1);
            expect(orch.isShutdownCleanupComplete()).toBe(true);
        } finally {
            fail = false;
            database.recorder.errors.clear();
            await orch.stop({ strict: true });
        }
    });

    it('keeps missing retained jobs unknown and never replays an old failed attempt over a successor', async () => {
        const client = makeFakeClient();
        const database = makeFakeSql();
        database.recorder.errors.set(
            'UPDATE task_history',
            Object.assign(new Error('constraint unavailable'), { code: '23514' }),
        );
        const queue = { ...makeFakeQueue(), name: 'io' };
        const events = Object.assign(new EventEmitter(), {
            name: 'io',
            close: vi.fn(async (): Promise<void> => {}),
        });
        const jobId = 'basic-task#run_attempt_replay';
        let missing = false;
        let attemptsMade = 1;
        queue.getJob.mockImplementation(async () =>
            missing
                ? null
                : {
                      id: jobId,
                      data: {},
                      attemptsMade,
                      getState: async () => 'failed',
                      failedReason: 'old attempt',
                      finishedOn: Date.now(),
                  },
        );
        const { orch, transitionSpy } = await bootOrchestrator({
            client,
            sql: database.sql,
            queue,
            queueEventsFactory: () => events as unknown as QueueEvents,
        });
        try {
            events.emit('failed', { jobId, failedReason: 'old attempt' });
            await orch.stop();
            expect(orch.isShutdownCleanupComplete()).toBe(false);
            const transitions = transitionSpy.mock.calls.length;
            expect(transitions).toBeGreaterThan(0);
            missing = true;
            database.recorder.responses.set('SELECT state FROM task_history', [
                { state: 'active' },
            ]);
            await expect(orch.stop({ strict: true })).rejects.toThrow('shutdown is incomplete');
            expect(transitionSpy).toHaveBeenCalledTimes(transitions);
            // A new execution reseeds the same logical run and advances the
            // queue attempt. Replaying the retained old terminal must do no CAS
            // and no SQL terminal write against this successor.
            client._hashes.set(
                'task:run:active:run_attempt_replay',
                new Map([['state', 'active']]),
            );
            missing = false;
            attemptsMade = 2;
            database.recorder.errors.clear();
            const sqlBefore = database.recorder.calls.length;
            await orch.stop({ strict: true });
            expect(transitionSpy).toHaveBeenCalledTimes(transitions);
            expect(database.recorder.calls).toHaveLength(sqlBefore);
            expect(client._hashes.get('task:run:active:run_attempt_replay')?.get('state')).toBe(
                'active',
            );
            expect(orch.isShutdownCleanupComplete()).toBe(true);
        } finally {
            missing = false;
            attemptsMade = 2;
            database.recorder.errors.clear();
            await orch.stop({ strict: true });
        }
    });

    it.each([
        ['completed', undefined, false],
        ['completed', 'pending', false],
        ['completed', 'active', false],
        ['completed', 'cancelling', false],
        ['completed', 'failed', false],
        ['completed', 'completed', true],
        ['completed', 'cancelled', true],
        ['failed', 'failed', true],
    ] as const)(
        'confirms zero-row terminal UPDATE against actual row state: %s / %s',
        async (target, state, confirmed) => {
            const client = makeFakeClient();
            const database = makeFakeSql();
            database.recorder.responses.set('UPDATE task_history', []);
            database.recorder.responses.set(
                'SELECT state FROM task_history',
                state ? [{ state }] : [],
            );
            const queue = { ...makeFakeQueue(), name: 'io' };
            const jobId = 'basic-task#run_zero_update';
            queue.getJob.mockImplementation(async () => ({
                id: jobId,
                data: {},
                attemptsMade: 1,
                getState: async () => target,
                returnvalue: {},
                failedReason: 'fixture',
                finishedOn: Date.now(),
            }));
            const events = Object.assign(new EventEmitter(), {
                name: 'io',
                close: vi.fn(async (): Promise<void> => {}),
            });
            const { orch } = await bootOrchestrator({
                client,
                sql: database.sql,
                queue,
                queueEventsFactory: () => events as unknown as QueueEvents,
            });
            try {
                events.emit(target, { jobId, returnvalue: '{}', failedReason: 'fixture' });
                if (confirmed) await orch.stop({ strict: true });
                else {
                    await expect(orch.stop({ strict: true })).rejects.toThrow(
                        'shutdown is incomplete',
                    );
                    expect(orch.isShutdownCleanupComplete()).toBe(false);
                    expect(queue.close).not.toHaveBeenCalled();
                    expect(client._lists.get('task:pending-writes') ?? []).toHaveLength(0);
                    database.recorder.responses.set('UPDATE task_history', [
                        { task_id: 'basic-task' },
                    ]);
                    await orch.stop({ strict: true });
                }
                expect(
                    database.recorder.calls.some((entry) =>
                        entry.strings.join('').includes('SELECT state FROM task_history'),
                    ),
                ).toBe(true);
                expect(orch.isShutdownCleanupComplete()).toBe(true);
            } finally {
                database.recorder.responses.set('UPDATE task_history', [{ task_id: 'basic-task' }]);
                await orch.stop({ strict: true });
            }
        },
    );

    it('retains failed QueueEvents ownership when a leadership read finishes during stop', async () => {
        vi.useFakeTimers();
        const client = makeFakeClient();
        const failure = new Error('subscription remains open');
        let finishRead!: () => void;
        const readHeld = new Promise<void>((resolve) => {
            finishRead = resolve;
        });
        let readEntered!: () => void;
        const readStarted = new Promise<void>((resolve) => {
            readEntered = resolve;
        });
        let finishClose!: () => void;
        const closeHeld = new Promise<void>((resolve) => {
            finishClose = resolve;
        });
        let closeEntered!: () => void;
        const closeStarted = new Promise<void>((resolve) => {
            closeEntered = resolve;
        });
        let failClose = true;
        const close = vi.fn(async (): Promise<void> => {
            closeEntered();
            await closeHeld;
            if (failClose) throw failure;
        });
        const events = { on: vi.fn(), close };
        const { orch } = await bootOrchestrator({
            client,
            queueEventsFactory: () => events as unknown as QueueEvents,
        });
        const command = vi.mocked(client.customCommand).getMockImplementation()!;
        vi.mocked(client.customCommand).mockImplementation(async (args: string[]) => {
            if (args[0] === 'GET' && args[1] === 'lock:orch:io') {
                readEntered();
                await readHeld;
                throw new Error('leadership verification unavailable');
            }
            return command(args);
        });
        let stopping: Promise<void> | undefined;
        try {
            await vi.advanceTimersByTimeAsync(15_001);
            await readStarted;
            stopping = orch.stop({ strict: true });
            const observed = stopping.catch((error: unknown) => error);
            await closeStarted;
            finishRead();
            await vi.advanceTimersByTimeAsync(0);
            expect(close).toHaveBeenCalledOnce();
            finishClose();
            expect(await observed).toMatchObject({ errors: [failure] });
            expect(orch.isShutdownCleanupComplete()).toBe(false);
            await expect(orch.stop({ strict: true })).rejects.toMatchObject({ errors: [failure] });
            expect(close).toHaveBeenCalledTimes(2);
            failClose = false;
            await orch.stop({ strict: true });
            expect(close).toHaveBeenCalledTimes(3);
            expect(orch.isShutdownCleanupComplete()).toBe(true);
        } finally {
            finishRead();
            finishClose();
            failClose = false;
            await stopping?.catch(() => {});
            await orch.stop({ strict: true });
            vi.useRealTimers();
        }
    });

    it.each([false, true])(
        'disposes the wired dispatcher LISTEN subscription through stop, late connect: %s',
        async (lateConnect) => {
            vi.useFakeTimers();
            const database = makeFakeSql();
            let finishListen!: () => void;
            const listenHeld = new Promise<void>((resolve) => {
                finishListen = resolve;
            });
            const unlisten = vi.fn(async (): Promise<void> => {});
            const listen = vi.fn(async (_channel: string, _handler: () => void) => {
                if (lateConnect) await listenHeld;
                return { unlisten };
            });
            database.sql.listen = listen;
            const { orch } = await bootOrchestrator({
                client: makeFakeClient(),
                sql: database.sql,
            });
            try {
                await vi.advanceTimersByTimeAsync(0);
                expect(listen).toHaveBeenCalledWith('event_outbox_new', expect.any(Function));
                expect(unlisten).not.toHaveBeenCalled();
                await orch.stop({ strict: true });
                finishListen();
                await vi.advanceTimersByTimeAsync(0);
                expect(unlisten).toHaveBeenCalledOnce();
                const callsAtStop = database.recorder.calls.length;
                await vi.advanceTimersByTimeAsync(31_000);
                expect(database.recorder.calls).toHaveLength(callsAtStop);
                expect(listen).toHaveBeenCalledOnce();
            } finally {
                finishListen();
                await orch.stop({ strict: true });
                vi.useRealTimers();
            }
        },
    );

    it.each(['io', 'coordinator'])(
        'waits for pending %s acquisition without restarting leadership',
        async (cls) => {
            vi.useFakeTimers();
            const client = makeFakeClient();
            const key = `lock:orch:${cls}`;
            client._setNxStore.set(key, { value: 'peer', expiresAt: Date.now() + 60_000 });
            const factory = vi.fn(() => null);
            const starts = vi.spyOn(Reconciler.prototype, 'start');
            const { orch, queue } = await bootOrchestrator({
                client,
                sql: makeFakeSql().sql,
                queueEventsFactory: factory,
            });
            const attachedAtBoot = factory.mock.calls.length;
            const startedAtBoot = starts.mock.calls.length;
            client._setNxStore.delete(key);
            const command = vi.mocked(client.customCommand).getMockImplementation()!;
            let finish!: () => void;
            const held = new Promise<void>((resolve) => {
                finish = resolve;
            });
            let entered!: () => void;
            const applied = new Promise<void>((resolve) => {
                entered = resolve;
            });
            vi.mocked(client.customCommand).mockImplementation(async (args: string[]) => {
                const result = await command(args);
                if (args[0] === 'SET' && args[1] === key) {
                    entered();
                    await held;
                }
                return result;
            });
            let stopping: Promise<void> | undefined;
            try {
                await vi.advanceTimersByTimeAsync(7_001);
                await applied;
                stopping = orch.stop({ strict: true });
                let stopped = false;
                void stopping.then(() => {
                    stopped = true;
                });
                await Promise.resolve();
                expect(stopped).toBe(false);
                expect(orch.isShutdownCleanupComplete()).toBe(false);
                expect(queue.close).not.toHaveBeenCalled();
                finish();
                await stopping;
                expect(factory.mock.calls.length).toBe(attachedAtBoot);
                expect(starts.mock.calls.length).toBe(startedAtBoot);
                expect(client._setNxStore.has(key)).toBe(false);
                expect(orch.isLeaderForAnyClass()).toBe(false);
                expect(orch.isShutdownCleanupComplete()).toBe(true);
                const callsAtStop = vi.mocked(client.customCommand).mock.calls.length;
                await vi.advanceTimersByTimeAsync(20_000);
                expect(client.customCommand).toHaveBeenCalledTimes(callsAtStop);
            } finally {
                finish();
                await stopping?.catch(() => {});
                await orch.stop({ strict: true });
                starts.mockRestore();
                vi.useRealTimers();
            }
        },
    );

    it.each(['io', 'coordinator'])(
        'retains failed %s release after tolerant stop for strict retries',
        async (cls) => {
            const client = makeFakeClient();
            const { orch, queue } = await bootOrchestrator({ client });
            const key = `lock:orch:${cls}`;
            const command = vi.mocked(client.customCommand).getMockImplementation()!;
            let fail = true;
            vi.mocked(client.customCommand).mockImplementation(async (args: string[]) => {
                if (args[0] === 'EVAL' && args[3] === key && args[1].includes('DEL') && fail)
                    throw new Error('release unavailable');
                return command(args);
            });
            try {
                await orch.stop();
                expect(orch.isShutdownCleanupComplete()).toBe(false);
                expect(client._setNxStore.has(key)).toBe(true);
                await expect(orch.stop({ strict: true })).rejects.toThrow('shutdown is incomplete');
                expect(queue.close).toHaveBeenCalledOnce();
                fail = false;
                await orch.stop({ strict: true });
                expect(client._setNxStore.has(key)).toBe(false);
                expect(orch.isShutdownCleanupComplete()).toBe(true);
                expect(queue.close).toHaveBeenCalledOnce();
            } finally {
                fail = false;
                await orch.stop({ strict: true });
            }
        },
    );

    it('reports queue-close failure instead of certifying a clean dedicated shutdown', async () => {
        const queue = makeFakeQueue();
        const failure = new Error('queue close failed');
        queue.close.mockRejectedValue(failure);
        const { orch } = await bootOrchestrator({ client: makeFakeClient(), queue });
        await expect(orch.stop({ strict: true })).rejects.toSatisfy(
            (error: unknown) => error instanceof AggregateError && error.errors.includes(failure),
        );
        expect(queue.close).toHaveBeenCalledOnce();
    });

    it('retains failed queue ownership across repeated strict stops and skips releases already observed', async () => {
        const queue = makeFakeQueue();
        const failure = new Error('queue connection remains open');
        queue.close.mockRejectedValue(failure);
        const { orch } = await bootOrchestrator({ client: makeFakeClient(), queue });
        const eventsClose = vi.fn(async () => {});
        const internals = orch as unknown as {
            classes: Map<string, { queueEvents: { close: typeof eventsClose } | null }>;
        };
        const runtime = internals.classes.get('io');
        if (!runtime) throw new Error('Missing io class runtime');
        runtime.queueEvents = { close: eventsClose };
        try {
            for (let attempt = 0; attempt < 2; attempt++)
                await expect(orch.stop({ strict: true })).rejects.toSatisfy(
                    (error: unknown) =>
                        error instanceof AggregateError && error.errors.includes(failure),
                );
            expect(queue.close).toHaveBeenCalledTimes(2);
            expect(eventsClose).toHaveBeenCalledTimes(1);
            queue.close.mockResolvedValue(undefined);
            await orch.stop({ strict: true });
            expect(queue.close).toHaveBeenCalledTimes(3);
            expect(eventsClose).toHaveBeenCalledTimes(1);
            await orch.stop({ strict: true });
            expect(queue.close).toHaveBeenCalledTimes(3);
        } finally {
            queue.close.mockResolvedValue(undefined);
            await orch.stop({ strict: true });
        }
    });

    it('retains failed flow-producer and per-task registry releases until successful retry', async () => {
        const { orch } = await bootOrchestrator({ client: makeFakeClient() });
        const failure = new Error('producer teardown incomplete');
        const close = vi.fn(async (): Promise<void> => {
            throw failure;
        });
        const closeAll = vi.fn(async (_options?: { strict?: boolean }): Promise<void> => {
            throw failure;
        });
        const internals = orch as unknown as {
            flowProducer: { close: typeof close } | null;
            taskQueueRegistry: { closeAll: typeof closeAll } | null;
        };
        internals.flowProducer = { close };
        internals.taskQueueRegistry = { closeAll };
        try {
            for (let attempt = 0; attempt < 2; attempt++)
                await expect(orch.stop({ strict: true })).rejects.toMatchObject({
                    errors: [failure, failure],
                });
            expect(close).toHaveBeenCalledTimes(2);
            expect(closeAll).toHaveBeenCalledTimes(2);
            close.mockResolvedValue(undefined);
            closeAll.mockResolvedValue(undefined);
            await orch.stop({ strict: true });
            expect(internals.flowProducer).toBeNull();
            expect(internals.taskQueueRegistry).toBeNull();
            await orch.stop({ strict: true });
            expect(close).toHaveBeenCalledTimes(3);
            expect(closeAll).toHaveBeenCalledTimes(3);
        } finally {
            close.mockResolvedValue(undefined);
            closeAll.mockResolvedValue(undefined);
            await orch.stop({ strict: true });
        }
    });

    it.each([false, true])(
        'retains nested close errors when strict joins tolerant stop: %s',
        async (joinStrict) => {
            const { orch } = await bootOrchestrator({ client: makeFakeClient() });
            const failure = new Error('nested per-task queue remains open');
            let entered!: () => void;
            let release!: () => void;
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            const closeAll = vi.fn(async (options?: { strict?: boolean }): Promise<void> => {
                entered();
                await held;
                // Model the exact registry await seam: tolerant close swallows the
                // failure and clears ownership; strict close exposes and retains it.
                if (options?.strict) throw failure;
            });
            const internals = orch as unknown as {
                taskQueueRegistry: { closeAll: typeof closeAll } | null;
            };
            const registry = { closeAll };
            internals.taskQueueRegistry = registry;
            let stopping: Promise<void> | undefined;
            try {
                stopping = orch.stop();
                // Attach the possible rejection before upgrading the in-flight stop.
                const observed = stopping.then(
                    () => undefined,
                    (error: unknown) => error,
                );
                await started;
                if (joinStrict) orch.stop({ strict: true }).catch(() => {});
                release();
                const result = await observed;
                if (joinStrict) expect(result).toMatchObject({ errors: [failure] });
                else expect(result).toBeUndefined();
                expect(closeAll).toHaveBeenCalledWith({ strict: true });
                expect(internals.taskQueueRegistry).toBe(registry);
                await expect(orch.stop({ strict: true })).rejects.toMatchObject({
                    errors: [failure],
                });
            } finally {
                release();
                if (stopping) await stopping.catch(() => {});
                closeAll.mockResolvedValue(undefined);
                await orch.stop({ strict: true });
            }
        },
    );

    it('preserves the existing tolerant cleanup behavior outside strict dedicated mode', async () => {
        const queue = makeFakeQueue();
        queue.close.mockRejectedValue(new Error('queue close failed'));
        const { orch } = await bootOrchestrator({ client: makeFakeClient(), queue });
        await expect(orch.stop()).resolves.toBeUndefined();
        expect(queue.close).toHaveBeenCalledOnce();
    });
});

it('forwards strict teardown to per-task queue ownership', async () => {
    const { orch } = await bootOrchestrator({ client: makeFakeClient() });
    const failure = new Error('per-task queue remained open');
    const closeAll = vi.fn(async (options?: { strict?: boolean }) => {
        if (options?.strict) throw failure;
    });
    const internals = orch as unknown as {
        taskQueueRegistry: { closeAll: typeof closeAll } | null;
    };
    internals.taskQueueRegistry = { closeAll };
    await expect(orch.stop({ strict: true })).rejects.toSatisfy(
        (error: unknown) => error instanceof AggregateError && error.errors.includes(failure),
    );
    expect(closeAll).toHaveBeenCalledWith({ strict: true });
});

it('retains a tolerant failed singleton close for strict retries without exposing the stopped owner', async () => {
    const queue = makeFakeQueue();
    const failure = new Error('singleton queue still open');
    queue.close.mockRejectedValue(failure);
    const { orch } = await bootOrchestrator({ client: makeFakeClient(), queue });
    const start = vi.spyOn(TaskOrchestrator, 'start').mockResolvedValue(orch);
    try {
        expect(await getOrchestrator()).toBe(orch);
        await expect(orchestrator.stop()).resolves.toBeUndefined();
        expect(orch.isShutdownCleanupComplete()).toBe(false);
        await expect(getOrchestrator()).rejects.toThrow('shut down');
        for (let attempt = 0; attempt < 2; attempt++)
            await expect(orchestrator.stop({ strict: true })).rejects.toSatisfy(
                (error: unknown) =>
                    error instanceof AggregateError && error.errors.includes(failure),
            );
        expect(queue.close).toHaveBeenCalledTimes(3);
        await expect(getOrchestrator()).rejects.toThrow('shut down');
        expect(start).toHaveBeenCalledTimes(1);
        queue.close.mockResolvedValue(undefined);
        await orchestrator.stop({ strict: true });
        await orchestrator.stop({ strict: true });
        expect(queue.close).toHaveBeenCalledTimes(4);
        expect(orch.isShutdownCleanupComplete()).toBe(true);
    } finally {
        queue.close.mockResolvedValue(undefined);
        await orchestrator.stop({ strict: true });
        start.mockRestore();
        await orch.stop({ strict: true });
    }
});

it('keeps singleton lock-release uncertainty observable until a strict retry confirms absence', async () => {
    vi.resetModules();
    const fresh = await import('./orchestrator.js');
    const client = makeFakeClient();
    const { orch } = await bootOrchestrator({ client });
    const start = vi.spyOn(fresh.TaskOrchestrator, 'start').mockResolvedValue(orch);
    const command = vi.mocked(client.customCommand).getMockImplementation()!;
    let fail = true;
    vi.mocked(client.customCommand).mockImplementation(async (args: string[]) => {
        if (args[0] === 'EVAL' && args[3] === 'lock:orch:io' && args[1].includes('DEL') && fail)
            throw new Error('release acknowledgement unavailable');
        return command(args);
    });
    try {
        expect(await fresh.getOrchestrator()).toBe(orch);
        await fresh.orchestrator.stop();
        expect(orch.isShutdownCleanupComplete()).toBe(false);
        await expect(fresh.getOrchestrator()).rejects.toThrow('shut down');
        await expect(fresh.orchestrator.stop({ strict: true })).rejects.toMatchObject({
            errors: [expect.objectContaining({ message: expect.stringContaining('UNKNOWN') })],
        });
        fail = false;
        await fresh.orchestrator.stop({ strict: true });
        expect(client._setNxStore.has('lock:orch:io')).toBe(false);
        expect(orch.isShutdownCleanupComplete()).toBe(true);
        expect(start).toHaveBeenCalledOnce();
    } finally {
        fail = false;
        await fresh.orchestrator.stop({ strict: true });
        start.mockRestore();
        await orch.stop({ strict: true });
    }
});

it('retains the real submission facade until a strict watcher repair retry is accepted', async () => {
    vi.resetModules();
    const fresh = await import('./orchestrator.js');
    const queue = makeFakeQueue();
    const database = makeFakeSql();
    const client = makeFakeClient();
    const stateMachine = {
        transitionRun: vi.fn(async () => ({ ok: true })),
        transitionStage: vi.fn(),
        incrementStage: vi.fn(),
        claimRun: vi.fn(),
    } as unknown as StateMachine;
    const owner = await fresh.TaskOrchestrator.start(['io'], {
        registry: makeRegistry(),
        stateMachine,
        getSql: () => database.sql as unknown as postgres.Sql,
        getClient: () => client,
        instanceId: 'watcher-repair-owner',
        queueFactory: () => queue as unknown as Queue,
        queueEventsFactory: () => null,
        flowProducer: null,
    });
    const start = vi.spyOn(fresh.TaskOrchestrator, 'start').mockResolvedValue(owner);
    const runtime = await import('../../../task-runtime/lifecycle.js');
    watcherRepair.fail = true;
    watcherRepair.repairs = [];
    try {
        expect(await fresh.getOrchestrator()).toBe(owner);
        await expect(runtime.stopTaskSubsystem({ strict: true })).rejects.toThrow('UNKNOWN');
        // No mock startRun: the real facade must remain available after failure.
        expect(await fresh.getOrchestrator()).toBe(owner);
        expect(queue.close).not.toHaveBeenCalled();
        watcherRepair.fail = false;
        await runtime.stopTaskSubsystem({ strict: true });
        expect(watcherRepair.repairs).toHaveLength(1);
        expect(queue.add).toHaveBeenCalledOnce();
        expect(queue.add.mock.calls[0]?.[1]).toMatchObject({ runId: watcherRepair.repairs[0] });
        expect(
            database.recorder.calls.some((call) =>
                call.strings.join(' ').includes('INSERT INTO task_history'),
            ),
        ).toBe(true);
        expect(queue.close).toHaveBeenCalledOnce();
        await expect(fresh.getOrchestrator()).rejects.toThrow('shut down');
        expect(start).toHaveBeenCalledOnce();
    } finally {
        watcherRepair.fail = false;
        await runtime.stopTaskSubsystem({ strict: true }).catch(() => {});
        await owner.stop({ strict: true });
        start.mockRestore();
    }
});

it('does not put the full boot sweep on the worker startup path', async () => {
    const { orch, queue } = await bootOrchestrator({
        client: makeFakeClient(),
        sql: makeFakeSql().sql,
    });
    Object.assign(queue, { getActive: vi.fn(async () => []) });
    let release!: () => void;
    const gate = new Promise<{ reclaimed: number; total: number; runIds: string[] }>((resolve) => {
        release = () => resolve({ reclaimed: 0, total: 0, runIds: [] });
    });
    const fullSweep = vi.spyOn(orch, 'recoverOnBoot').mockReturnValue(gate);
    const recovery = orch.recoverInterruptedWorkerRuns(() => {});
    try {
        await Promise.race([recovery, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
        expect(fullSweep).not.toHaveBeenCalled();
    } finally {
        release();
        await recovery;
        await orch.stop();
    }
});
