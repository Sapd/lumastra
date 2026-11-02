// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the worker-isolation host (worker-host.ts).
 *
 * Two layers:
 *   1. Fake-worker unit tests — exercise RPC dispatch, fire-and-forget relay,
 *      result/error rehydration (TaskError kind preserved), cancel relay,
 *      terminate grace logic, and env scrubbing. No real threads → fast +
 *      deterministic.
 *   2. Real-thread tests — prove a SYNCHRONOUS busy-loop worker is actually
 *      hard-killed by terminate() at the grace deadline, that a cooperative
 *      worker exits without a hard kill, and that a returned result round-trips.
 *
 * Run: npx vitest run src/lib/server/tasks/isolation/worker-host.test.ts
 */

const recordProviderCall = vi.hoisted(() => vi.fn());
const recordProviderRetry = vi.hoisted(() => vi.fn());
vi.mock('../../utils/provider-calls.js', () => ({ recordProviderCall, recordProviderRetry }));

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { TaskError } from '@sapd/lumastra-plugin-sdk';
import {
    buildIsolationEnv,
    executeInWorker,
    rehydrateError,
    type IsolationHostHooks,
    type IsolationWorkerLike,
    type SpawnIsolationWorker,
} from './worker-host.js';
import {
    serializeError,
    type MainToWorker,
    type SandboxWorkerData,
    type WorkerToMain,
} from './protocol.js';
import { ISOLATION_WORKER_ENV_MARKER } from './isolation-context.js';

// ── Fake worker ───────────────────────────────────────────────────────────────

class FakeWorker implements IsolationWorkerLike {
    posted: MainToWorker[] = [];
    terminated = false;
    private listeners: Record<string, Array<(...a: never[]) => void>> = {};

    postMessage(msg: MainToWorker): void {
        this.posted.push(msg);
    }
    terminate(): Promise<number> {
        this.terminated = true;
        // A real terminate() ends the thread → 'exit'. Mirror that so the host's
        // settle/cleanup paths run.
        this.emit('exit', 1);
        return Promise.resolve(1);
    }
    on(event: string, cb: (...a: never[]) => void): this {
        (this.listeners[event] ??= []).push(cb);
        return this;
    }
    once(event: string, cb: (...a: never[]) => void): this {
        return this.on(event, cb);
    }
    emit(event: string, ...args: unknown[]): void {
        for (const cb of this.listeners[event] ?? []) (cb as (...a: unknown[]) => void)(...args);
    }
    /** Simulate a worker→main message. */
    send(msg: WorkerToMain): void {
        this.emit('message', msg);
    }
    lastRpcReply(): MainToWorker | undefined {
        return [...this.posted].reverse().find((m) => m.t === 'rpcResult');
    }
}

function noopHooks(over: Partial<IsolationHostHooks> = {}): IsolationHostHooks {
    return {
        secretsGet: async () => '',
        secretsGetOptional: async () => null,
        secretsGetUser: async () => '',
        settings: async () => ({}),
        cacheGet: async () => null,
        cacheSet: async () => {},
        cacheDel: async () => {},
        reportFailure: async () => {},
        reportSuccess: async () => {},
        ucGet: async () => null,
        ucSet: async () => {},
        ucDelete: async () => {},
        ucListKeys: async () => [],
        ucListLinkedUsers: async () => [],
        ucListUsersWithKey: async () => [],
        log: () => {},
        progress: () => {},
        spend: () => {},
        warn: () => {},
        ...over,
    };
}

const WORKER_DATA: SandboxWorkerData = {
    runId: 'run_1',
    taskId: 'demo',
    attemptNumber: 1,
    input: {},
    scope: {},
    mode: 'manual',
    capabilities: {},
    dbPoolMax: 2,
};

function startWithFake(
    fake: FakeWorker,
    hooks: IsolationHostHooks,
    signal: AbortSignal,
    softSignal?: AbortSignal,
): ReturnType<typeof executeInWorker> {
    const spawn: SpawnIsolationWorker = () => fake;
    return executeInWorker({
        entryPath: 'unused',
        workerData: WORKER_DATA,
        env: {},
        hooks,
        signal,
        softSignal,
        spawn,
    });
}

describe('worker-host — fake worker', () => {
    it('relays provider attempts and retries to host telemetry with fixed provider labels', async () => {
        recordProviderCall.mockClear();
        recordProviderRetry.mockClear();
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        const at = Date.now();
        fake.send({ t: 'providerCall', provider: 'tmdb', status: 429, retry: false, at });
        fake.send({ t: 'providerCall', provider: 'tmdb', status: null, retry: true, at });
        fake.send({
            t: 'providerCall',
            provider: 'https://arbitrary.test',
            status: 200,
            retry: false,
            at,
        });
        expect(recordProviderCall).toHaveBeenCalledExactlyOnceWith('tmdb', 429, expect.any(Number));
        expect(recordProviderRetry).toHaveBeenCalledExactlyOnceWith('tmdb', expect.any(Number));
        expect(fake.posted).toEqual([]);
        fake.send({ t: 'done', result: {} });
        await run.result;
    });

    it('providerCall boundary uses host time even when worker timestamps are spoofed or absent', async () => {
        recordProviderCall.mockClear();
        recordProviderRetry.mockClear();
        const now = Date.UTC(2026, 9, 31, 23, 30);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            const fake = new FakeWorker();
            const run = startWithFake(fake, noopHooks(), new AbortController().signal);
            fake.send({ t: 'providerCall', provider: 'tmdb', status: 200, retry: false, at: 0 });
            fake.send({
                t: 'providerCall',
                provider: 'tmdb',
                status: null,
                retry: true,
                at: Infinity,
            });
            fake.send({
                t: 'providerCall',
                provider: 'tmdb',
                status: 100,
                retry: false,
            } as WorkerToMain);
            expect(recordProviderCall.mock.calls).toEqual([
                ['tmdb', 200, now],
                ['tmdb', 100, now],
            ]);
            expect(recordProviderRetry).toHaveBeenCalledExactlyOnceWith('tmdb', now);
            fake.send({ t: 'done', result: {} });
            await run.result;
        } finally {
            clock.mockRestore();
        }
    });

    it('providerCall boundary drops invalid status and retry values without consuming the valid path', async () => {
        recordProviderCall.mockClear();
        recordProviderRetry.mockClear();
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        const base = {
            t: 'providerCall',
            provider: 'tmdb',
            status: 200,
            retry: false,
            at: Date.now(),
        };
        for (const status of [undefined, '200', 99, 600, 200.5, NaN, Infinity, {}, true]) {
            fake.send({ ...base, status } as unknown as WorkerToMain);
            fake.send({ ...base, status, retry: true } as unknown as WorkerToMain);
        }
        for (const retry of [undefined, 'false', 'true', 0, 1, null, {}]) {
            fake.send({ ...base, retry } as unknown as WorkerToMain);
        }
        expect(recordProviderCall).not.toHaveBeenCalled();
        expect(recordProviderRetry).not.toHaveBeenCalled();
        fake.send({ ...base, status: 599 } as WorkerToMain);
        fake.send({ ...base, status: null } as WorkerToMain);
        expect(recordProviderCall).toHaveBeenCalledTimes(2);
        fake.send({ t: 'done', result: {} });
        await run.result;
    });

    it('providerCall boundary enforces a per-run budget including invalid messages', async () => {
        recordProviderCall.mockClear();
        recordProviderRetry.mockClear();
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        const msg = {
            t: 'providerCall',
            provider: 'tmdb',
            status: 200,
            retry: false,
            at: Date.now(),
        } as const;
        // Deterministic fake messages only: no workers, network or stress workload.
        fake.send({ ...msg, retry: 'invalid' } as unknown as WorkerToMain);
        for (let i = 0; i < 10_001; i++) fake.send(msg);
        fake.send({ ...msg, retry: true });
        expect(recordProviderCall).toHaveBeenCalledTimes(9_999);
        expect(recordProviderRetry).not.toHaveBeenCalled();
        fake.send({ t: 'done', result: {} });
        await run.result;
        const next = new FakeWorker();
        const nextRun = startWithFake(next, noopHooks(), new AbortController().signal);
        next.send(msg);
        expect(recordProviderCall).toHaveBeenCalledTimes(10_000);
        next.send({ t: 'done', result: {} });
        await nextRun.result;
    });

    it('resolves the result when the worker reports done', async () => {
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        fake.send({ t: 'done', result: { success: true, itemsProcessed: 3 } });
        await expect(run.result).resolves.toEqual({
            success: true,
            itemsProcessed: 3,
        });
    });

    it('rejects with a TaskError preserving kind on a serialized error', async () => {
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        fake.send({
            t: 'error',
            error: { isTaskError: true, message: 'boom', kind: 'permanent' },
        });
        await expect(run.result).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'permanent',
        });
    });

    it('rejects with a plain Error (not TaskError) for a non-TaskError throw', async () => {
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        fake.send({
            t: 'error',
            error: { isTaskError: false, message: 'kaboom' },
        });
        await run.result.catch((e) => {
            expect(e).toBeInstanceOf(Error);
            expect(e).not.toBeInstanceOf(TaskError);
            expect(e.message).toBe('kaboom');
        });
        expect.assertions(3);
    });

    it('relays log/progress/spend to the host sinks (no reply posted)', async () => {
        const fake = new FakeWorker();
        const log = vi.fn();
        const progress = vi.fn();
        const spend = vi.fn();
        const run = startWithFake(
            fake,
            noopHooks({ log, progress, spend }),
            new AbortController().signal,
        );
        fake.send({ t: 'log', level: 'warn', msg: 'hi', meta: { a: 1 } });
        fake.send({ t: 'progress', processed: 2, total: 10, currentItem: 'x' });
        fake.send({ t: 'spend', kind: 'cpu_seconds', units: 5 });
        expect(log).toHaveBeenCalledWith('warn', 'hi', { a: 1 });
        expect(progress).toHaveBeenCalledWith(2, 10, 'x');
        expect(spend).toHaveBeenCalledWith('cpu_seconds', 5);
        expect(fake.posted.filter((m) => m.t === 'rpcResult')).toHaveLength(0);
        fake.send({ t: 'done', result: { success: true } });
        await run.result;
    });

    it('dispatches an RPC to the matching hook and replies with the value', async () => {
        const fake = new FakeWorker();
        const secretsGet = vi.fn(async (k: string) => `secret-for-${k}`);
        const run = startWithFake(fake, noopHooks({ secretsGet }), new AbortController().signal);
        fake.send({
            t: 'rpc',
            cid: 7,
            method: 'secrets.get',
            args: ['API_KEY'],
        });
        await vi.waitFor(() => expect(fake.lastRpcReply()).toBeDefined());
        expect(secretsGet).toHaveBeenCalledWith('API_KEY');
        expect(fake.lastRpcReply()).toEqual({
            t: 'rpcResult',
            cid: 7,
            ok: true,
            value: 'secret-for-API_KEY',
        });
        fake.send({ t: 'done', result: { success: true } });
        await run.result;
    });

    it('keeps an isolated CPU checkpoint pending until the host releases it', async () => {
        const fake = new FakeWorker();
        let resume!: () => void;
        const checkpoint = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resume = resolve;
                }),
        );
        const run = startWithFake(
            fake,
            noopHooks({ backgroundCpuCheckpoint: checkpoint }),
            new AbortController().signal,
        );
        fake.send({ t: 'rpc', cid: 8, method: 'backgroundCpuCheckpoint', args: [] });
        expect(checkpoint).toHaveBeenCalledOnce();
        expect(fake.lastRpcReply()).toBeUndefined();
        resume();
        await vi.waitFor(() => expect(fake.lastRpcReply()).toMatchObject({ cid: 8, ok: true }));
        fake.send({ t: 'done', result: { success: true } });
        await run.result;
    });

    it('replies ok:false with a serialized error when the hook throws', async () => {
        const fake = new FakeWorker();
        const settings = vi.fn(async () => {
            throw new TaskError({ message: 'no settings', kind: 'fatal' });
        });
        const run = startWithFake(fake, noopHooks({ settings }), new AbortController().signal);
        fake.send({ t: 'rpc', cid: 9, method: 'settings', args: [] });
        await vi.waitFor(() => expect(fake.lastRpcReply()).toBeDefined());
        const reply = fake.lastRpcReply();
        expect(reply).toMatchObject({ t: 'rpcResult', cid: 9, ok: false });
        expect((reply as { error?: { message: string } }).error?.message).toBe('no settings');
        fake.send({ t: 'done', result: { success: true } });
        await run.result;
    });

    it('posts an abort message when the runner signal aborts', async () => {
        const fake = new FakeWorker();
        const ac = new AbortController();
        const run = startWithFake(fake, noopHooks(), ac.signal);
        expect(fake.posted.some((m) => m.t === 'abort')).toBe(false);
        ac.abort();
        expect(fake.posted.some((m) => m.t === 'abort')).toBe(true);
        fake.send({ t: 'done', result: { success: true } });
        await run.result;
    });

    it('posts a softAbort message when the soft-deadline signal fires (not abort)', async () => {
        const fake = new FakeWorker();
        const ac = new AbortController();
        const soft = new AbortController();
        const run = startWithFake(fake, noopHooks(), ac.signal, soft.signal);
        expect(fake.posted.some((m) => m.t === 'softAbort')).toBe(false);
        soft.abort();
        expect(fake.posted.some((m) => m.t === 'softAbort')).toBe(true);
        // Soft-abort must NOT relay a cancel.
        expect(fake.posted.some((m) => m.t === 'abort')).toBe(false);
        fake.send({ t: 'done', result: { success: true } });
        await run.result;
    });

    it('posts abort immediately if the signal is already aborted at spawn', async () => {
        const fake = new FakeWorker();
        const ac = new AbortController();
        ac.abort();
        const run = startWithFake(fake, noopHooks(), ac.signal);
        expect(fake.posted.some((m) => m.t === 'abort')).toBe(true);
        fake.send({ t: 'done', result: { success: true } });
        await run.result;
    });

    it('rejects when the worker exits before reporting a terminal message', async () => {
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        fake.emit('exit', 7);
        await expect(run.result).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
        });
    });

    it('terminate() asks nicely then hard-terminates when the worker does not exit', async () => {
        const fake = new FakeWorker();
        // Override terminate so the auto-exit-on-terminate doesn't fire until we
        // assert it was called; here we just confirm it WAS called after grace.
        // Small shutdownGraceMs override keeps this test fast — production uses
        // SANDBOX_SHUTDOWN_GRACE_MS (1.5s).
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        await run.terminate(10, 10);
        expect(fake.posted.some((m) => m.t === 'abort')).toBe(true); // asked nicely
        expect(fake.posted.some((m) => m.t === 'shutdown')).toBe(true); // last-chance pool close
        expect(fake.terminated).toBe(true); // hard kill after grace
        await expect(run.result).rejects.toBeDefined();
    });

    it('terminate() skips the shutdown message when the worker exits within the abort grace', async () => {
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        const p = run.terminate(1000, 10);
        setTimeout(() => fake.emit('exit', 0), 10);
        await p;
        expect(fake.posted.some((m) => m.t === 'abort')).toBe(true);
        expect(fake.posted.some((m) => m.t === 'shutdown')).toBe(false);
        expect(fake.terminated).toBe(false);
        await expect(run.result).rejects.toBeDefined();
    });

    it('terminate() skips the hard kill when the worker exits during the shutdown window', async () => {
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        // graceMs=10 so the abort-only wait elapses quickly, forcing onShutdown();
        // then the worker "cooperates" shortly after the shutdown message.
        const p = run.terminate(10, 1000);
        setTimeout(() => {
            if (fake.posted.some((m) => m.t === 'shutdown')) fake.emit('exit', 1);
        }, 20);
        await p;
        expect(fake.posted.some((m) => m.t === 'shutdown')).toBe(true);
        expect(fake.terminated).toBe(false); // pool-close exit pre-empted the hard kill
        await expect(run.result).rejects.toBeDefined();
    });

    it('terminate() does NOT hard-kill when the worker exits within grace', async () => {
        const fake = new FakeWorker();
        const run = startWithFake(fake, noopHooks(), new AbortController().signal);
        const p = run.terminate(1000);
        // Simulate a cooperative exit shortly after the abort ask.
        setTimeout(() => fake.emit('exit', 0), 10);
        await p;
        expect(fake.terminated).toBe(false);
        await expect(run.result).rejects.toBeDefined();
    });
});

describe('buildIsolationEnv', () => {
    it('removes the secret master key + KDF salt, keeps DATABASE_URL/CACHE_URL', () => {
        const env = buildIsolationEnv({
            DATABASE_URL: 'postgres://x',
            CACHE_URL: 'redis://y',
            LUMASTRA_MASTER_KEY: 'topsecret',
            LUMASTRA_KDF_SALT: 'salt',
            TZ: 'UTC',
        });
        expect(env.DATABASE_URL).toBe('postgres://x');
        expect(env.CACHE_URL).toBe('redis://y');
        expect(env.TZ).toBe('UTC');
        expect(env.LUMASTRA_MASTER_KEY).toBeUndefined();
        expect(env.LUMASTRA_KDF_SALT).toBeUndefined();
    });

    it('does not mutate the source env', () => {
        const src = { LUMASTRA_MASTER_KEY: 'k' };
        buildIsolationEnv(src);
        expect(src.LUMASTRA_MASTER_KEY).toBe('k');
    });

    it('marks the env as an isolation worker so key-touching code refuses (B1)', () => {
        const env = buildIsolationEnv({ LUMASTRA_MASTER_KEY: 'k' });
        expect(env[ISOLATION_WORKER_ENV_MARKER]).toBe('1');
    });
});

describe('rehydrateError', () => {
    it('reconstructs a TaskError with kind + preserves stack', () => {
        const e = rehydrateError({
            isTaskError: true,
            message: 'm',
            kind: 'transient',
            stack: 'STACK',
        });
        expect(e).toBeInstanceOf(TaskError);
        expect((e as TaskError).kind).toBe('transient');
        expect(e.stack).toBe('STACK');
    });
    it('falls back to a plain Error when not a TaskError', () => {
        const e = rehydrateError({ isTaskError: false, message: 'plain' });
        expect(e).toBeInstanceOf(Error);
        expect(e).not.toBeInstanceOf(TaskError);
    });
});

// ── Real worker threads ─────────────────────────────────────────────────────

const FIXTURE = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '__fixtures__',
    'isolation-test-worker.mjs',
);

function realSpawn(behavior: string, echo?: unknown): SpawnIsolationWorker {
    return (_entry, _data, _env) =>
        new NodeWorker(FIXTURE, {
            workerData: { behavior, echo },
        }) as unknown as IsolationWorkerLike;
}

function runReal(
    behavior: string,
    signal: AbortSignal,
    echo?: unknown,
): ReturnType<typeof executeInWorker> {
    return executeInWorker({
        entryPath: FIXTURE,
        workerData: WORKER_DATA,
        env: {},
        hooks: noopHooks(),
        signal,
        spawn: realSpawn(behavior, echo),
    });
}

describe('worker-host — real threads', () => {
    it('hard-kills a SYNCHRONOUS busy-loop worker at the grace deadline', async () => {
        const run = runReal('busy', new AbortController().signal);
        const start = Date.now();
        // The busy loop never reads the abort message, so terminate() must hard
        // -kill it after the grace window. If isolation didn't work, this test
        // process itself would hang (the loop would be on our thread).
        await run.terminate(50);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(45); // waited the grace window
        await expect(run.result).rejects.toBeDefined(); // exited via terminate
    }, 10_000);

    it('a cooperative worker exits on abort without waiting the full grace', async () => {
        const run = runReal('cooperative-abort', new AbortController().signal);
        const start = Date.now();
        await run.terminate(5_000); // generous grace
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(2_000); // exited fast on abort, didn't wait 5s
        await expect(run.result).rejects.toBeDefined();
    }, 10_000);

    it('resolves with the result a real worker posts', async () => {
        const run = runReal('echo-done', new AbortController().signal, {
            success: true,
            itemsProcessed: 9,
        });
        await expect(run.result).resolves.toEqual({
            success: true,
            itemsProcessed: 9,
        });
    }, 10_000);

    // Deferred theoretical race: sandbox-entry.ts posts `done`/`error` then
    // `process.exit(0)` in the same tick, with no guarantee node:worker_threads
    // drains the message before the host's `exit` event fires. Run this
    // repeatedly — a flaky ordering violation would surface as an occasional
    // "isolation worker exited before completing" rejection instead of the
    // posted result.
    it('resolves with the posted result even when the worker posts done then process.exit(0) in the same tick', async () => {
        for (let i = 0; i < 25; i++) {
            const run = runReal('post-then-exit', new AbortController().signal, {
                success: true,
                itemsProcessed: i,
            });
            await expect(run.result).resolves.toEqual({
                success: true,
                itemsProcessed: i,
            });
        }
    }, 20_000);

    // S2 (Windows e2e 2026-09-27): "isolation worker exited (code 0) before
    // completing" was first blamed on a LARGE result losing this race. Node
    // drains the worker's port before emitting `exit`, so a multi-MB result
    // posted in the same tick as process.exit(0) still arrives. The real cause
    // was CLI guards firing inside the sandbox bundle (utils/cli-entry.ts).
    it('delivers a LARGE result posted in the same tick as process.exit(0)', async () => {
        const items = Array.from({ length: 50_000 }, (_, i) => ({
            id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
            segments: [{ kind: 'intro', startMs: i, endMs: i + 90_000 }],
        }));
        for (let i = 0; i < 5; i++) {
            const run = runReal('post-then-exit', new AbortController().signal, {
                success: true,
                itemsProcessed: i,
                result: { items },
            });
            const result = (await run.result) as { itemsProcessed: number; result: unknown };
            expect(result.itemsProcessed).toBe(i);
            expect((result.result as { items: unknown[] }).items).toHaveLength(items.length);
        }
    }, 30_000);
});

// Plugin-defined remediation travels independently of the task/stage id.
it('round-trips identity and operational remedies through worker serialization', () => {
    for (const remediation of ['identity', 'operational'] as const) {
        const original = new TaskError({
            message: 'plugin failure',
            kind: 'permanent',
            remediation,
        });
        const restored = rehydrateError(serializeError(original)) as TaskError;
        expect(restored.remediation).toBe(remediation);
        expect(restored.kind).toBe('permanent');
    }
});
