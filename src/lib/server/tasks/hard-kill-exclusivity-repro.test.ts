// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F17 — Hard-kill never releases exclusiveWith identity keys.
 *
 * Finding: The runner's processJob is the only production path that invokes
 * releaseExclusivityKey. HardKill bypasses the runner entirely, calling Lua
 * pipeline ZREM/DEL and mirroring state, but never releases the identity key.
 * After hard-kill, a subsequent startRun with the same identity will SETNX-fail.
 *
 * Citations: src/lib/server/tasks/hard-kill.ts:95-161,
 *            src/lib/server/tasks/runner.ts:2459-2497
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLog = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLog),
    },
}));

const mockStateMachine = vi.hoisted(() => ({
    transitionRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/tasks/state-machine.js', () => ({
    stateMachine: mockStateMachine,
}));

const mockLuaLoader = vi.hoisted(() => ({
    invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/tasks/lua/loader.js', () => ({
    luaLoader: mockLuaLoader,
}));

describe('F17 — Hard-kill must release exclusiveWith identity key', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('releases the exclusivity identity key after killing a run', async () => {
        const { HardKill } = await import('$lib/server/tasks/hard-kill.js');

        // A tagged-template `sql` stub: the SELECT in execute() returns a
        // single non-terminal ('cancelling') row so the kill path runs.
        const sql = Object.assign(
            vi.fn(async () => [{ state: 'cancelling', task_id: 'my-task' }]),
            { json: (value: unknown): unknown => value },
        ) as never;

        const mockQueue = {
            getJob: vi.fn().mockResolvedValue({
                getState: vi.fn().mockResolvedValue('active'),
                // No token → BullMQ graceful path declines, falls through to the
                // Lua bypass + identity release.
                moveToFailed: vi.fn().mockResolvedValue(undefined),
            }),
            opts: { prefix: 'bull:task' },
            name: 'cpu',
        };

        const client = { customCommand: vi.fn().mockResolvedValue(1) };

        // Constructor order: (getSql, getQueueForTask, getClient, stateMachine,
        // getJobIdForRun).
        const hardKill = new HardKill(
            () => sql, // getSql
            () => mockQueue as never, // getQueueForTask
            () => client as never, // getClient
            mockStateMachine as never,
            async () => 'my-task~~global#run-abc123', // getJobIdForRun
        );

        await hardKill.execute('run-abc123');

        // Verify that the hard-kill path ran (state machine transition)
        expect(mockStateMachine.transitionRun).toHaveBeenCalled();

        // CORRECT behavior: HardKill should invoke release-identity so the
        // same identity can be re-enqueued immediately.
        // BUG: HardKill never invokes the Lua 'release-identity' script.
        expect(mockLuaLoader.invoke).toHaveBeenCalledWith(
            'release-identity',
            ['task:identity:my-task:my-task~~global'],
            expect.anything(),
            expect.anything(),
            undefined,
        );
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
