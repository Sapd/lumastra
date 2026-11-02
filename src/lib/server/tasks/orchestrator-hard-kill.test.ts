// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hard-kill integration tests for TaskOrchestrator.cancelRun({ hard: true }).
 *
 * Uses vi.mock('./hard-kill.js') to keep the import graph within the V8 heap
 * limit for this worker fork. The orchestrator.test.ts file already fills most
 * of the worker heap; this file must not load additional heavy modules.
 *
 * NOTE: These tests focus on the cancelRun → HardKill wiring branch.
 * The HardKill class itself is tested in hard-kill.test.ts.
 */

import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import type { StateMachine } from './state-machine.js';
import type postgres from 'postgres';
import type { Queue } from 'bullmq';
import { TaskOrchestrator } from './orchestrator.js';

// Real ownership transactions/scripts are covered by real-store integration tests.
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

// ── Mock HardKill before orchestrator loads it ────────────────────────────────
// vitest hoists vi.mock calls before any imports, so the mock intercepts the
// `import { HardKill } from './hard-kill.js'` inside orchestrator.ts.

const scheduleFn = vi.fn(
    (_runId: string, _deadlineMs?: number) => ({}) as ReturnType<typeof setTimeout>,
);
const cancelScheduledFn = vi.fn((_runId: string) => {});
const executeFn = vi.fn(async (_runId: string) => ({
    killed: true,
    method: 'redis-pipeline' as const,
}));

vi.mock('./hard-kill.js', () => ({
    HardKill: vi.fn().mockImplementation(function () {
        return {
            schedule: scheduleFn,
            cancelScheduled: cancelScheduledFn,
            execute: executeFn,
        };
    }),
}));

// ── Standard orchestrator test mocks ─────────────────────────────────────────

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
vi.mock('$lib/server/config.js', async () =>
    // Shared with orchestrator.test.ts. This file's private copy of the list
    // is what rotted while it sat excluded from the runner — see the fixture.
    (await import('./__fixtures__/task-config-mock.js')).taskConfigMock(),
);
vi.mock('./lua/loader.js', () => ({
    luaLoader: {
        load: vi.fn(async () => {}),
        invoke: vi.fn(async () => ({ ok: 'enqueued' })),
    },
}));
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

// ── Minimal stubs ─────────────────────────────────────────────────────────────

function makeClient() {
    const hashes = new Map<string, Map<string, string>>();
    const published: Array<{ channel: string; message: string }> = [];
    const store = new Map<string, { value: string; expiresAt: number }>();
    const customCommand = vi.fn(async (cmd: string[]): Promise<unknown> => {
        switch (cmd[0]?.toUpperCase()) {
            case 'HSET': {
                let h = hashes.get(cmd[1]);
                if (!h) {
                    h = new Map();
                    hashes.set(cmd[1], h);
                }
                for (let i = 2; i + 1 < cmd.length; i += 2) h.set(cmd[i], cmd[i + 1]);
                return 1;
            }
            case 'HGET':
                return hashes.get(cmd[1])?.get(cmd[2]) ?? null;
            case 'HGETALL': {
                const h = hashes.get(cmd[1]);
                if (!h) return [];
                const flat: string[] = [];
                for (const [k, v] of h) flat.push(k, v);
                return flat;
            }
            case 'PEXPIRE':
                return 1;
            case 'EXISTS':
                return hashes.has(cmd[1]) ? 1 : 0;
            case 'PUBLISH':
                published.push({ channel: cmd[1], message: cmd[2] });
                return 0;
            case 'SET': {
                const isNx = cmd.includes('NX');
                if (isNx && store.has(cmd[1]) && store.get(cmd[1])!.expiresAt > Date.now())
                    return null;
                const pxIdx = cmd.indexOf('PX');
                store.set(cmd[1], {
                    value: cmd[2],
                    expiresAt: Date.now() + (pxIdx > 0 ? Number(cmd[pxIdx + 1]) : 60_000),
                });
                return 'OK';
            }
            case 'EVAL': {
                const key = cmd[3];
                const expected = cmd[4];
                const e = store.get(key);
                if (!e || e.value !== expected) return 0;
                if (/PEXPIRE/.test(cmd[1])) {
                    e.expiresAt = Date.now() + Number(cmd[5]);
                    return 1;
                }
                if (/DEL/.test(cmd[1])) {
                    store.delete(key);
                    return 1;
                }
                return 0;
            }
            default:
                return null;
        }
    });
    return { customCommand, _hashes: hashes, _published: published };
}

type Sql = ((s: readonly string[], ...v: unknown[]) => Promise<unknown[]>) & {
    json: (v: unknown) => unknown;
    _res: Map<string, unknown[]>;
};

function makeSql(): Sql {
    const res = new Map<string, unknown[]>();
    const fn = ((strings: readonly string[], ..._v: unknown[]) => {
        const head = (strings[0] || '').trim().slice(0, 80);
        for (const [k, v] of res) {
            if (head.includes(k)) return Promise.resolve(v);
        }
        return Promise.resolve([]);
    }) as Sql;
    fn.json = (v: unknown) => v;
    fn._res = res;
    return fn;
}

// ── Shared setup ──────────────────────────────────────────────────────────────

let orch: TaskOrchestrator;
let client: ReturnType<typeof makeClient>;
let sql: Sql;

beforeAll(async () => {
    client = makeClient();
    sql = makeSql();
    sql._res.set('SELECT id FROM task_history', [{ id: 'run_child' }]);

    const reg = new TaskRegistry();
    reg.registerTask(
        defineTask({
            id: 'x',
            name: 'X',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io',
            inputSchema: z.object({ n: z.string() }),
            identityFor: (i) => i.n,
            async execute() {
                return { success: true };
            },
        }),
    );

    const sm = {
        transitionRun: vi.fn(async () => ({ ok: true })),
        transitionStage: vi.fn(),
        incrementStage: vi.fn(),
        claimRun: vi.fn(),
    } as unknown as StateMachine;

    const q = {
        add: vi.fn(async () => ({})),
        getJob: vi.fn(async () => null),
        getActive: vi.fn(async () => []),
        close: vi.fn(async () => {}),
        name: 'io',
    };

    orch = await TaskOrchestrator.start(['io'], {
        registry: reg,
        stateMachine: sm,
        getSql: () => sql as unknown as postgres.Sql,
        getClient: () => client,
        instanceId: 'test-instance',
        queueFactory: () => q as unknown as Queue,
        queueEventsFactory: () => null,
        flowProducer: null,
    });
});

afterAll(async () => {
    await orch.stop();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cancelRun — hard kill wiring', () => {
    it('hard:true returns accepted+deferred and schedules hard-kill', async () => {
        scheduleFn.mockClear();
        client._hashes.set('task:run:active:run_H', new Map([['state', 'active']]));

        const result = await orch.cancelRun('run_H', { hard: true });
        expect(result).toEqual({ accepted: true, deferred: 'hard-kill' });
        expect(scheduleFn).toHaveBeenCalledWith('run_H');
    });

    it('soft cancel returns accepted without deferred', async () => {
        scheduleFn.mockClear();
        client._hashes.set('task:run:active:run_S', new Map([['state', 'active']]));

        const result = await orch.cancelRun('run_S');
        expect(result).toEqual({ accepted: true });
        expect(scheduleFn).not.toHaveBeenCalled();
    });

    it('cancelScheduled called when run reaches terminal state', async () => {
        cancelScheduledFn.mockClear();

        await (
            orch as unknown as {
                writeTerminalToPostgres: (
                    id: string,
                    to: string,
                    extra: undefined,
                ) => Promise<void>;
            }
        ).writeTerminalToPostgres('run_T', 'completed', undefined);

        expect(cancelScheduledFn).toHaveBeenCalledWith('run_T');
    });

    it('hard:true on an already-cancelling run escalates to hard-kill (was a no-op)', async () => {
        // Regression: the admin "Force stop" button is only enabled once a run
        // is already 'cancelling', so a hard cancel ALWAYS arrives re-entrant.
        // The old short-circuit returned {accepted:true} without scheduling the
        // hard-kill, so Force stop did nothing — the prod 2h "Stopping…" bug.
        scheduleFn.mockClear();
        client._hashes.set('task:run:active:run_RC', new Map([['state', 'cancelling']]));

        const result = await orch.cancelRun('run_RC', { hard: true });
        expect(result).toEqual({ accepted: true, deferred: 'hard-kill' });
        // Near-immediate deadline (operator already waited through the soft window).
        expect(scheduleFn).toHaveBeenCalledWith('run_RC', 2_000);
    });

    it('soft re-entrant cancel on an already-cancelling run stays a no-op', async () => {
        scheduleFn.mockClear();
        client._hashes.set('task:run:active:run_RS', new Map([['state', 'cancelling']]));

        const result = await orch.cancelRun('run_RS');
        expect(result).toEqual({ accepted: true, reason: 'already_cancelling' });
        expect(scheduleFn).not.toHaveBeenCalled();
    });

    it('nuclearStop is graceful by default: a run already cancelling is left to stop', async () => {
        // Same default as single-run cancel — never do more than asked.
        scheduleFn.mockClear();
        client._hashes.set('task:run:active:run_child', new Map([['state', 'cancelling']]));

        const res = await orch.nuclearStop('x');
        expect(res.cancelled).toBeGreaterThan(0);
        expect(res.escalated).toBe(0);
        expect(scheduleFn).not.toHaveBeenCalled();
    });

    it('nuclearStop with force:true force-kills each run', async () => {
        // A run wedged in 'cancelling' is force-finalized, not no-op'd.
        scheduleFn.mockClear();
        client._hashes.set('task:run:active:run_child', new Map([['state', 'cancelling']]));

        const res = await orch.nuclearStop('x', { force: true });
        expect(res.cancelled).toBeGreaterThan(0);
        expect(res.escalated).toBeGreaterThan(0);
        // Re-entrant hard path → scheduled with the near-immediate deadline.
        expect(scheduleFn).toHaveBeenCalledWith('run_child', 2_000);
    });

    it('cascades hard:true to pipeline children', async () => {
        scheduleFn.mockClear();
        client._hashes.set('task:run:active:run_parent', new Map([['state', 'active']]));
        client._hashes.set('task:run:active:run_child', new Map([['state', 'active']]));

        await orch.cancelRun('run_parent', { hard: true });

        const ids = scheduleFn.mock.calls.map((c) => c[0]);
        expect(ids).toContain('run_parent');
        expect(ids).toContain('run_child');
    });
});

// Keep behavior fixtures independent of the SQL boundary; recovery-fencing.integration
// exercises the real transactions and ownership rejection.
vi.mock('../../../task-runtime/authority/existing-write.js', () => ({
    withExistingTaskWrite: async <T>(
        sql: import('postgres').Sql,
        _authority: unknown,
        mutate: (tx: import('postgres').Sql) => Promise<T>,
    ): Promise<T> => mutate(sql),
}));

vi.mock('../../../task-runtime/authority/queue-write.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../task-runtime/authority/queue-write.js')>()),
    withTaskQueueWrite: async <T>(
        _sql: unknown,
        _authority: unknown,
        _operation: unknown,
        write: () => Promise<T>,
    ): Promise<T> => write(),
}));

vi.mock('./lua/fenced.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lua/fenced.js')>();
    return {
        ...actual,
        invokeFencedValkey: async (
            source: string,
            keys: string[],
            args: (string | number)[],
            client: { customCommand(cmd: string[]): Promise<unknown> },
        ): Promise<unknown> => {
            if (source.startsWith("return redis.call('SET'"))
                return client.customCommand([
                    'SET',
                    keys[0],
                    String(args[0]),
                    'NX',
                    'PX',
                    String(args[1]),
                ]);
            if (source === "return redis.call('GET', KEYS[1])")
                return client.customCommand(['GET', keys[0]]);
            return client.customCommand([
                'EVAL',
                source,
                String(keys.length),
                ...keys,
                ...args.map(String),
            ]);
        },
    };
});
