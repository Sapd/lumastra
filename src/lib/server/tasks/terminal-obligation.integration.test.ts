// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { getQueueConnectionOptions } from './connection.js';
import { PER_TASK_QUEUE_PREFIX } from './queue-naming.js';
import { requireClient, type ValkeyLike } from './valkey-types.js';
import { StateMachine } from './state-machine.js';
import { TaskRunner } from './runner.js';
import { taskTerminalWriteAbandonedTotal } from './metrics.js';

// Retained runner terminal writes against real PostgreSQL, Valkey and BullMQ.
// A row lock plus statement_timeout makes the terminal UPDATE fail transiently;
// a rejected pending-write enqueue then leaves the write as a runner obligation.
const sql = postgres(getTestDatabaseUrl(), { max: 4 });
const timeoutSql = postgres(getTestDatabaseUrl(), {
    max: 2,
    connection: { statement_timeout: 200 },
});
beforeAll(async () => {
    await connectValkey();
});
afterAll(async () => {
    await disconnectValkey();
    await timeoutSql.end({ timeout: 2 });
    await sql.end({ timeout: 2 });
});

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
    const end = performance.now() + 10_000;
    while (!(await check())) {
        if (performance.now() > end) throw new Error('Terminal obligation observation timed out');
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}

interface RunnerInternals {
    executingQueueJobs: Map<string, Job>;
    writeTerminalToPostgres(
        runId: string,
        to: 'completed' | 'failed' | 'cancelled',
        result: unknown,
        error: null,
    ): Promise<void>;
}

interface RetainedFixture {
    runId: string;
    job: Job;
    runner: TaskRunner;
    releaseRow: () => Promise<void>;
    acceptEnqueue: () => void;
    cleanup: () => Promise<void>;
}

const ORIGINAL_INSTANCE = 'obligation-original';

async function retainedObligation(
    options: { maxAgeMs?: number; jobRunId?: string } = {},
): Promise<RetainedFixture> {
    const { maxAgeMs } = options;
    const id = `terminal-obligation-${randomUUID()}`;
    const runId = `run_${randomUUID()}`;
    const connection = getQueueConnectionOptions();
    if (!connection) throw new Error('Queue connection required');
    const queue = new Queue(id, { connection, prefix: PER_TASK_QUEUE_PREFIX });
    let captured: Job | undefined;
    const worker = new Worker(
        id,
        async (job) => {
            captured = job;
            return { success: true };
        },
        { connection, prefix: PER_TASK_QUEUE_PREFIX, concurrency: 1 },
    );
    await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at, owner_instance_id)
        VALUES (${runId}, ${id}, 'Obligation fixture', 'active', '{}', '{"kind":"manual"}', '{"type":"system"}', 1, NOW(), ${ORIGINAL_INSTANCE})`;
    // A mismatching job runId keeps the queue observation UNKNOWN (provenance).
    const added = await queue.add(id, { runId: options.jobRunId ?? runId }, { jobId: id });
    await until(async () => (await added.getState()) === 'completed');
    if (!captured) throw new Error('Worker did not capture the job');
    const job = captured;

    let enqueueAccepted = false;
    const client: ValkeyLike = {
        customCommand: async (command) => {
            if (
                !enqueueAccepted &&
                (command[0] === 'EVAL' || command[0] === 'EVALSHA') &&
                command.includes('task:pending-writes') &&
                command.some((value) => value.startsWith('{') && value.includes('"kind":"update"'))
            )
                throw new Error('fixture: pending-write enqueue unavailable');
            return requireClient().customCommand(command);
        },
    };
    const runner = TaskRunner.createExecutor({
        getSql: () => timeoutSql,
        getClient: () => client,
        stateMachine: new StateMachine(requireClient),
        instanceId: ORIGINAL_INSTANCE,
        ...(maxAgeMs !== undefined ? { terminalObligationMaxAgeMs: maxAgeMs } : {}),
    });

    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    let locked: () => void = () => {};
    const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
    });
    const rowTransaction = sql.begin(async (tx) => {
        await tx`SELECT id FROM task_history WHERE id = ${runId} FOR UPDATE`;
        locked();
        await released;
    });
    await lockTaken;

    const internals = runner as unknown as RunnerInternals;
    internals.executingQueueJobs.set(runId, job);
    await internals.writeTerminalToPostgres(runId, 'completed', { itemsProcessed: 3 }, null);
    internals.executingQueueJobs.delete(runId);

    const releaseRow = async (): Promise<void> => {
        release();
        await rowTransaction;
    };
    return {
        runId,
        job,
        runner,
        releaseRow,
        acceptEnqueue: () => {
            enqueueAccepted = true;
        },
        cleanup: async () => {
            await releaseRow();
            await worker.close();
            await queue.obliterate({ force: true });
            await queue.close();
            await sql`DELETE FROM task_history WHERE id = ${runId}`;
        },
    };
}

async function abandonedCount(): Promise<number> {
    const metric = await taskTerminalWriteAbandonedTotal.get();
    return metric.values.find((value) => value.labels.state === 'completed')?.value ?? 0;
}

it('clears a retained terminal write once BullMQ has reaped its job, so execution becomes quiescent', async () => {
    const f = await retainedObligation();
    try {
        expect(f.runner.isExecutionQuiescent()).toBe(false);
        await f.releaseRow();
        await f.job.remove();

        await f.runner.retryPendingTerminalWrites();

        expect(f.runner.isExecutionQuiescent()).toBe(true);
        const [row] = await sql<
            { state: string; result: { itemsProcessed: number } | null }[]
        >`SELECT state, result FROM task_history WHERE id = ${f.runId}`;
        expect(row?.state).toBe('completed');
        expect(row?.result).toEqual({ itemsProcessed: 3 });
    } finally {
        await f.cleanup();
    }
}, 30_000);

it('never applies a reaped-job terminal write over a successor attempt that owns the run', async () => {
    const f = await retainedObligation();
    try {
        await f.releaseRow();
        await f.job.remove();
        // Reconciler re-dispatch: a successor attempt on another instance owns the row.
        await sql`UPDATE task_history SET owner_instance_id = 'obligation-successor' WHERE id = ${f.runId}`;

        await f.runner.retryPendingTerminalWrites();

        expect(f.runner.isExecutionQuiescent()).toBe(true);
        const [row] = await sql<
            { state: string; result: unknown; owner_instance_id: string }[]
        >`SELECT state, result, owner_instance_id FROM task_history WHERE id = ${f.runId}`;
        expect(row).toEqual({
            state: 'active',
            result: null,
            owner_instance_id: 'obligation-successor',
        });
    } finally {
        await f.cleanup();
    }
}, 30_000);

it('keeps a young UNKNOWN terminal write; after the age cap marks the row for recovery', async () => {
    const f = await retainedObligation({ maxAgeMs: 1_500, jobRunId: `run_${randomUUID()}` });
    try {
        const before = await abandonedCount();
        await expect(f.runner.retryPendingTerminalWrites()).rejects.toThrow(
            'Terminal persistence remains UNKNOWN',
        );
        expect(f.runner.isExecutionQuiescent()).toBe(false);
        expect(await abandonedCount()).toBe(before);

        await f.releaseRow();
        await new Promise<void>((resolve) => setTimeout(resolve, 1_600));
        // The pending-write enqueue is still rejected: the durable marker is the fallback.
        await f.runner.retryPendingTerminalWrites();

        expect(f.runner.isExecutionQuiescent()).toBe(true);
        expect(await abandonedCount()).toBe(before + 1);
        const [row] = await sql<
            { state: string; error: { code: string; intendedState: string } | null }[]
        >`SELECT state, error FROM task_history WHERE id = ${f.runId}`;
        expect(row?.state).toBe('active');
        expect(row?.error).toMatchObject({
            code: 'TERMINAL_WRITE_ABANDONED',
            intendedState: 'completed',
        });
    } finally {
        await f.cleanup();
    }
}, 30_000);

it('hands an abandoned terminal write to the durable pending-write list when it can', async () => {
    const f = await retainedObligation({ maxAgeMs: 1, jobRunId: `run_${randomUUID()}` });
    const client = requireClient();
    try {
        await f.releaseRow();
        f.acceptEnqueue();
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        await f.runner.retryPendingTerminalWrites();

        expect(f.runner.isExecutionQuiescent()).toBe(true);
        const entries = (await client.customCommand([
            'LRANGE',
            'task:pending-writes',
            '0',
            '-1',
        ])) as string[];
        const mine = entries.filter((entry) => entry.includes(f.runId));
        expect(mine).toHaveLength(1);
        expect(JSON.parse(mine[0])).toMatchObject({
            runId: f.runId,
            ownerInstanceId: ORIGINAL_INSTANCE,
            payload: { state: 'completed', result: { itemsProcessed: 3 } },
        });
        const [row] = await sql<
            { error: unknown }[]
        >`SELECT error FROM task_history WHERE id = ${f.runId}`;
        expect(row?.error).toBeNull();
        for (const entry of mine)
            await client.customCommand(['LREM', 'task:pending-writes', '0', entry]);
    } finally {
        await f.cleanup();
    }
}, 30_000);
