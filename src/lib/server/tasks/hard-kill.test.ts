// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for hard-kill.ts.
 * All BullMQ, Valkey, and Postgres interactions are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Queue } from 'bullmq';
import type postgres from 'postgres';
import { HardKill } from './hard-kill.js';
import type { StateMachine } from './state-machine.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

type FakeClient = {
    customCommand: (cmd: string[]) => Promise<unknown>;
    _cmds: string[][];
};

function makeFakeClient(): FakeClient {
    const cmds: string[][] = [];
    return {
        customCommand: vi.fn(async (cmd: string[]) => {
            cmds.push(cmd);
            return 1;
        }),
        _cmds: cmds,
    };
}

function makeFakeSql(rows: Record<string, unknown>[] = []) {
    const fn = vi.fn(async () => rows) as unknown as postgres.Sql;
    (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return fn;
}

function makeFakeSm(): StateMachine {
    return {
        transitionRun: vi.fn(async () => ({ ok: true })),
        transitionStage: vi.fn(async () => ({ ok: true })),
        incrementStage: vi.fn(async () => ({ ok: true })),
        claimRun: vi.fn(async () => ({ ok: true })),
    } as unknown as StateMachine;
}

function makeFakeQueue(jobState?: string, hasToken?: boolean): Queue {
    const fakeJob = {
        getState: vi.fn(async () => jobState ?? 'active'),
        moveToFailed: vi.fn(async () => {}),
        token: hasToken ? 'tok-123' : undefined,
        name: 'task-id',
    };
    return {
        name: 'io',
        getJob: vi.fn(async () => (jobState !== undefined ? fakeJob : null)),
        getActive: vi.fn(async () => []),
    } as unknown as Queue;
}

function makeHardKill(opts: {
    sqlRows?: Record<string, unknown>[];
    queue?: Queue;
    clientCmds?: FakeClient;
    jobId?: string | null;
    emitTerminal?: ReturnType<typeof vi.fn>;
}): {
    hk: HardKill;
    client: FakeClient;
    sm: StateMachine;
    sql: postgres.Sql;
    emitTerminal: ReturnType<typeof vi.fn>;
} {
    const client = opts.clientCmds ?? makeFakeClient();
    const sm = makeFakeSm();
    const sqlRows = opts.sqlRows ?? [{ state: 'cancelling', task_id: 'my-task' }];
    const sql = makeFakeSql(sqlRows);
    const emitTerminal = opts.emitTerminal ?? vi.fn(async () => {});
    const emitTerminalFn = emitTerminal as unknown as (
        taskId: string,
        runId: string,
        to: 'completed' | 'failed' | 'cancelled',
        extra?: Record<string, string | number>,
    ) => Promise<void>;

    const hk = new HardKill(
        () => sql,
        (_taskId) => opts.queue ?? makeFakeQueue(),
        () =>
            client as unknown as {
                customCommand: (cmd: string[]) => Promise<unknown>;
            },
        sm,
        async () => opts.jobId ?? 'job-456',
        emitTerminalFn,
    );
    return { hk, client, sm, sql, emitTerminal };
}

// ── schedule / cancelScheduled ─────────────────────────────────────────────────

describe('HardKill.schedule', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns a timer ID', () => {
        const { hk } = makeHardKill({});
        const timer = hk.schedule('run_1', 60_000);
        expect(timer).toBeDefined();
        hk.cancelScheduled('run_1');
    });

    it('fires execute after the deadline', async () => {
        const executeSpy = vi.fn(async () => ({
            killed: true,
            method: 'already-terminal' as const,
        }));
        const { hk } = makeHardKill({});
        // Patch execute so we can assert it was called.
        hk['execute'] = executeSpy;

        hk.schedule('run_fire', 60_000);
        await vi.advanceTimersByTimeAsync(60_001);
        expect(executeSpy).toHaveBeenCalledWith('run_fire', undefined);
    });

    it('captures authority when scheduling, before the caller token changes', async () => {
        const authority = {
            partition: 'tasks',
            generation: '1',
            ownerId: '11111111-1111-4111-8111-111111111111',
        };
        const { hk } = makeHardKill({});
        const execute = vi
            .spyOn(hk, 'execute')
            .mockResolvedValue({ killed: false, method: 'already-terminal' });
        hk.schedule('run_origin', 10, authority);
        authority.generation = '2';
        authority.ownerId = '22222222-2222-4222-8222-222222222222';
        await vi.advanceTimersByTimeAsync(11);
        expect(execute).toHaveBeenCalledWith('run_origin', {
            partition: 'tasks',
            generation: '1',
            ownerId: '11111111-1111-4111-8111-111111111111',
        });
        expect(Object.isFrozen(execute.mock.calls[0][1])).toBe(true);
    });

    it('cancelScheduled prevents execute from firing', async () => {
        const executeSpy = vi.fn(async () => ({
            killed: false,
            method: 'already-terminal' as const,
        }));
        const { hk } = makeHardKill({});
        hk['execute'] = executeSpy;

        hk.schedule('run_cancel', 60_000);
        hk.cancelScheduled('run_cancel');
        await vi.advanceTimersByTimeAsync(70_000);
        expect(executeSpy).not.toHaveBeenCalled();
    });
});

// ── execute — already-terminal ────────────────────────────────────────────────

describe('HardKill.execute — already terminal', () => {
    it('returns already-terminal when state is completed', async () => {
        const { hk } = makeHardKill({
            sqlRows: [{ state: 'completed', task_id: 'my-task' }],
        });
        const result = await hk.execute('run_done');
        expect(result).toEqual({ killed: false, method: 'already-terminal' });
    });

    it('returns already-terminal when state is cancelled', async () => {
        const { hk } = makeHardKill({
            sqlRows: [{ state: 'cancelled', task_id: 'my-task' }],
        });
        const result = await hk.execute('run_done');
        expect(result).toEqual({ killed: false, method: 'already-terminal' });
    });

    it('returns already-terminal when run not found', async () => {
        const { hk } = makeHardKill({ sqlRows: [] });
        const result = await hk.execute('run_missing');
        expect(result).toEqual({ killed: false, method: 'already-terminal' });
    });
});

// ── execute — BullMQ graceful path ─────────────────────────────────────────────

describe('HardKill.execute — BullMQ path', () => {
    it('calls moveToFailed when job is active with token', async () => {
        const queue = makeFakeQueue('active', true);
        const { hk } = makeHardKill({ queue });

        const result = await hk.execute('run_bullmq');
        expect(result).toEqual({ killed: true, method: 'bullmq' });
        expect(queue.getJob as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    });

    it('stops on an uncertain supported queue RPC without falling through to destructive Lua', async () => {
        const boundary = await import('../../../task-runtime/authority/queue-write.js');
        const uncertain = new boundary.QueueOperationUncertainError(
            'operation-fixture',
            new Error('reply lost'),
        );
        const write = vi.spyOn(boundary, 'withTaskQueueWrite').mockRejectedValueOnce(uncertain);
        try {
            const { hk, client, emitTerminal } = makeHardKill({
                queue: makeFakeQueue('active', true),
            });
            await expect(hk.execute('run_uncertain')).rejects.toBe(uncertain);
            expect(client._cmds).toHaveLength(0);
            expect(emitTerminal).not.toHaveBeenCalled();
        } finally {
            write.mockRestore();
        }
    });

    it('requires reconciliation for a managed job whose worker lock token is unavailable', async () => {
        const { taskJobId } = await import('../../../task-runtime/authority/queue-origin.js');
        const authority = {
            partition: 'tasks',
            generation: '1',
            ownerId: '11111111-1111-4111-8111-111111111111',
        };
        const id = taskJobId('my-task~~global#run-managed', authority);
        const client = makeFakeClient();
        const queue = {
            name: 'io',
            getJob: async () => ({
                id,
                data: { taskAuthority: authority },
                getState: async () => 'active',
            }),
        } as unknown as Queue;
        const hardKill = new HardKill(
            () => makeFakeSql([{ state: 'cancelling', task_id: 'my-task' }]),
            () => queue,
            () => client,
            makeFakeSm(),
            async () => id,
            undefined,
            authority,
        );
        await expect(hardKill.execute('run-managed')).rejects.toMatchObject({
            code: 'not_drained',
        });
        // Only the private intent marker was written; queue cleanup never ran.
        expect(client._cmds).toHaveLength(1);
        expect(client._cmds[0][1]).toContain('hardKillQueuePending');
    });

    it('falls through to redis-pipeline when no token', async () => {
        const queue = makeFakeQueue('active', false);
        const { hk, client } = makeHardKill({ queue });

        const result = await hk.execute('run_notoken');
        // Falls through to Lua bypass + finalizes as redis-pipeline
        expect(result.killed).toBe(true);
        expect(result.method).toBe('redis-pipeline');
        // Lua EVAL should have been issued
        const evalCmd = client._cmds.find((c) => c[0] === 'EVAL');
        expect(evalCmd).toBeDefined();
    });

    it('falls through to redis-pipeline when job not found in queue', async () => {
        // getJob returns null
        const queue = makeFakeQueue(undefined, false);
        const { hk, client } = makeHardKill({ queue });

        const result = await hk.execute('run_nojob');
        expect(result.killed).toBe(true);
        expect(result.method).toBe('redis-pipeline');
        const evalCmd = client._cmds.find((c) => c[0] === 'EVAL');
        expect(evalCmd).toBeDefined();
    });
});

// ── execute — redis pipeline bypass ──────────────────────────────────────────

describe('HardKill.execute — Lua bypass', () => {
    it('issues EVAL with correct prefix, queue name and jobId', async () => {
        const queue = makeFakeQueue(undefined, false);
        const { hk, client } = makeHardKill({ queue, jobId: 'job-789' });

        await hk.execute('run_lua');
        const evalCmd = client._cmds.find((c) => c[0] === 'EVAL');
        expect(evalCmd).toBeDefined();
        // Every mutated queue key is explicit; ARGV[1] keeps the job id.
        expect(evalCmd![2]).toBe('9');
        expect(evalCmd!.slice(3, 12)).toEqual([
            'bull:task:io:active',
            'bull:task:io:waiting',
            'bull:task:io:prioritized',
            'bull:task:io:waiting-children',
            'bull:task:io:delayed',
            'bull:task:io:job-789',
            'bull:task:io:job-789:lock',
            'bull:task:io:job-789:dependencies',
            'bull:task:io:job-789:processed',
        ]);
        expect(evalCmd![12]).toBe('job-789');
    });

    it('writes cancelled state to Postgres after bypass', async () => {
        const queue = makeFakeQueue(undefined, false);
        const { hk, sql } = makeHardKill({ queue });

        await hk.execute('run_finalize');
        // The mock sql fn tracks calls; the UPDATE should have been issued
        expect((sql as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    });

    it('calls stateMachine.transitionRun to cancelling→cancelled', async () => {
        const queue = makeFakeQueue(undefined, false);
        const { hk, sm } = makeHardKill({ queue });

        await hk.execute('run_sm');
        expect(sm.transitionRun).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: 'run_sm',
                from: 'cancelling',
                to: 'cancelled',
            }),
        );
    });
});

// ── execute — terminal CloudEvent/webhook emit (TASK-C2) ────────────────────

describe('HardKill.execute — terminal CloudEvent emit (TASK-C2)', () => {
    it('emits a cancelled terminal event on the BullMQ path', async () => {
        const queue = makeFakeQueue('active', true); // active + token → bullmq path
        const { hk, emitTerminal } = makeHardKill({ queue });

        const result = await hk.execute('run_emit_bullmq');
        expect(result).toEqual({ killed: true, method: 'bullmq' });
        expect(emitTerminal).toHaveBeenCalledTimes(1);
        expect(emitTerminal).toHaveBeenCalledWith(
            'my-task',
            'run_emit_bullmq',
            'cancelled',
            expect.objectContaining({ errorMessage: 'hard-killed' }),
            undefined,
        );
    });

    it('emits a cancelled terminal event on the Lua bypass path', async () => {
        const queue = makeFakeQueue('active', false); // no token → lua bypass
        const { hk, emitTerminal } = makeHardKill({ queue });

        const result = await hk.execute('run_emit_lua');
        expect(result).toEqual({ killed: true, method: 'redis-pipeline' });
        expect(emitTerminal).toHaveBeenCalledTimes(1);
        expect(emitTerminal).toHaveBeenCalledWith(
            'my-task',
            'run_emit_lua',
            'cancelled',
            expect.objectContaining({ errorMessage: 'hard-killed' }),
            undefined,
        );
    });

    it('does NOT emit when the finalize UPDATE matches 0 rows (already terminal via another path)', async () => {
        // SELECT sees a non-terminal row (so execute proceeds past the terminal
        // short-circuit), but the finalize UPDATE matches 0 rows because a
        // concurrent replica / QueueEvents handler already wrote a terminal
        // state. The RETURNING-id no-op guard must suppress the emit.
        const sqlFn = vi.fn((strings: readonly string[]) => {
            const head = (strings[0] || '').trim().slice(0, 80);
            if (head.startsWith('SELECT state')) {
                return Promise.resolve([{ state: 'cancelling', task_id: 'my-task' }]);
            }
            if (head.startsWith('UPDATE task_history')) {
                return Promise.resolve([]); // 0 rows → lost the race
            }
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;
        (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

        const emitTerminal = vi.fn(async () => {});
        const queue = makeFakeQueue('active', false);
        const hk = new HardKill(
            () => sqlFn,
            (_taskId) => queue,
            () =>
                makeFakeClient() as unknown as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            makeFakeSm(),
            async () => 'job-noemit',
            emitTerminal,
        );

        await hk.execute('run_noemit');
        expect(emitTerminal).not.toHaveBeenCalled();
    });

    it('does not emit when the run is already terminal (short-circuit)', async () => {
        const { hk, emitTerminal } = makeHardKill({
            sqlRows: [{ state: 'completed', task_id: 'my-task' }],
        });
        await hk.execute('run_already_done');
        expect(emitTerminal).not.toHaveBeenCalled();
    });
});

// ── execute — ordering: Postgres UPDATE before BullMQ moveToFailed ──────────

describe('HardKill.execute — Postgres-first ordering (F4)', () => {
    it('writes state=cancelled to Postgres BEFORE moveToFailed so the failed event short-circuits', async () => {
        // Track absolute call order across two unrelated sinks: the Postgres
        // UPDATE (via sql template tag) and the BullMQ moveToFailed call.
        const callOrder: string[] = [];

        // SELECT first row returns 'cancelling'; subsequent UPDATE records.
        let selectCalled = false;
        const sqlFn = vi.fn((strings: readonly string[], ..._v: unknown[]) => {
            const head = (strings[0] || '').trim().slice(0, 80);
            if (head.startsWith('SELECT state')) {
                selectCalled = true;
                return Promise.resolve([{ state: 'cancelling', task_id: 'my-task' }]);
            }
            if (head.startsWith('UPDATE task_history')) {
                // Postgres finalize. Verify the SELECT preceded it.
                expect(selectCalled).toBe(true);
                callOrder.push('pg-update');
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;
        (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

        const moveToFailed = vi.fn(async () => {
            callOrder.push('move-to-failed');
        });
        const fakeJob = {
            getState: vi.fn(async () => 'active'),
            moveToFailed,
            token: 'tok-abc',
            name: 'task-id',
        };
        const queue = {
            name: 'io',
            getJob: vi.fn(async () => fakeJob),
            getActive: vi.fn(async () => []),
        } as unknown as Queue;

        const sm = makeFakeSm();
        const client = makeFakeClient();
        const hk = new HardKill(
            () => sqlFn,
            (_taskId) => queue,
            () =>
                client as unknown as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            sm,
            async () => 'job-ord',
        );

        const result = await hk.execute('run_order');
        expect(result).toEqual({ killed: true, method: 'bullmq' });
        // Postgres UPDATE fired BEFORE moveToFailed.
        expect(callOrder).toEqual(['pg-update', 'move-to-failed']);
        // The UPDATE guard excludes already-terminal states; verify the
        // template included the AND state NOT IN guard clause.
        const updateCall = (sqlFn as unknown as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
            (call[0] as readonly string[])[0]?.trim().startsWith('UPDATE task_history'),
        );
        expect(updateCall).toBeDefined();
        const updateSql = (updateCall![0] as readonly string[]).join(' ');
        expect(updateSql).toMatch(/state = 'cancelled'/);
        expect(updateSql).toMatch(/state NOT IN \('completed', 'failed', 'cancelled'\)/);
    });

    it('writes Postgres UPDATE before Lua bypass when BullMQ path is unavailable', async () => {
        // When BullMQ has no token (worker dead), HardKill falls through to
        // the Lua bypass. The Postgres write must still happen FIRST.
        const callOrder: string[] = [];

        const sqlFn = vi.fn((strings: readonly string[], ..._v: unknown[]) => {
            const head = (strings[0] || '').trim().slice(0, 80);
            if (head.startsWith('SELECT state')) {
                return Promise.resolve([{ state: 'cancelling', task_id: 'my-task' }]);
            }
            if (head.startsWith('UPDATE task_history')) {
                callOrder.push('pg-update');
                return Promise.resolve([]);
            }
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;
        (sqlFn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

        const client: FakeClient = {
            customCommand: vi.fn(async (cmd: string[]) => {
                if (cmd[0] === 'EVAL') callOrder.push('lua-bypass');
                return 1;
            }),
            _cmds: [],
        };
        const queue = makeFakeQueue('active', false); // no token → Lua path

        const hk = new HardKill(
            () => sqlFn,
            (_taskId) => queue,
            () =>
                client as unknown as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            makeFakeSm(),
            async () => 'job-lua-order',
        );

        const result = await hk.execute('run_lua_order');
        expect(result.killed).toBe(true);
        expect(result.method).toBe('redis-pipeline');
        // Postgres UPDATE fired BEFORE the Lua bypass EVAL.
        const pgIdx = callOrder.indexOf('pg-update');
        const luaIdx = callOrder.indexOf('lua-bypass');
        expect(pgIdx).toBeGreaterThanOrEqual(0);
        expect(luaIdx).toBeGreaterThanOrEqual(0);
        expect(pgIdx).toBeLessThan(luaIdx);
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
        ): Promise<unknown> =>
            client.customCommand(
                source === "return redis.call('DEL', KEYS[1])"
                    ? ['DEL', ...keys]
                    : ['EVAL', source, String(keys.length), ...keys, ...args.map(String)],
            ),
    };
});
