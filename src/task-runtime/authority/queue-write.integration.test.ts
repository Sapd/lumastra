// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Queue, FlowProducer } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../tests/integration/setup/test-database.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { TaskRunner } from '$lib/server/tasks/runner.js';
import { sweepQueueOperationJournal } from '$lib/server/tasks/queue-journal-janitor.js';
import { tasksRegistry } from '$lib/server/tasks/metrics.js';
import {
    AuthorityStore,
    ManagedAuthorityDisabledError,
    assertTaskAuthorityUnmanaged,
    enableManagedAuthorityForTesting,
    type AuthorityToken,
} from './store.js';
import {
    QueueOperationUncertainError,
    QueueWriteNotSentError,
    resetUnmanagedQueueWriteCheckForTesting,
    withTaskQueueWrite,
} from './queue-write.js';
import { taskJobId, assertTaskJobOrigin } from './queue-origin.js';

const sql = postgres(getTestDatabaseUrl(), { max: 3 });
const store = new AuthorityStore(sql);
const queueName = `queue-fence-${randomUUID()}`;
const connection = getQueueConnectionOptions();
if (!connection) throw new Error('Isolated queue connection required');
const queue = new Queue(queueName, { connection });
const flow = new FlowProducer({ connection });
const owners: string[] = [];

async function owner(): Promise<AuthorityToken> {
    const ownerId = randomUUID();
    owners.push(ownerId);
    return store.initialize('tasks', ownerId, 'typescript');
}
function gate(): { wait: Promise<void>; release: () => void } {
    let release!: () => void;
    return {
        wait: new Promise<void>((resolve) => {
            release = resolve;
        }),
        release: () => release(),
    };
}

describe('queue publication journal with real PostgreSQL and BullMQ', () => {
    afterEach(async () => {
        // Test-only cleanup after all local queue operations have settled. This
        // is not a production unknown-operation reconciliation mechanism.
        await sql`DELETE FROM task_runtime_queue_operations WHERE queue_name = ${queueName}`;
        for (const ownerId of owners) {
            await sql`DELETE FROM task_runtime_authorities WHERE partition = 'tasks' AND owner_id = ${ownerId}`;
        }
        owners.length = 0;
        await queue.obliterate({ force: true });
    });
    afterAll(async () => {
        await flow.close();
        await queue.close();
        await sql.end();
    });

    it('runs an unmanaged real Queue.add without a journal row and surfaces its own error', async () => {
        const entered = gate();
        const finish = gate();
        const jobId = `unmanaged#run_${randomUUID()}`;
        const publication = withTaskQueueWrite(
            sql,
            undefined,
            { kind: 'add', queue: queueName, jobId },
            async () => {
                entered.release();
                await finish.wait;
                return queue.add('fixture', { runId: 'unmanaged' }, { jobId });
            },
        );
        await entered.wait;
        try {
            // Unmanaged mode is the production mode: no journal, so a lost
            // reply can never strand a pending row or block compensation.
            expect(
                await sql`SELECT operation_id FROM task_runtime_queue_operations WHERE queue_name = ${queueName}`,
            ).toHaveLength(0);
        } finally {
            finish.release();
            await publication;
        }
        expect(await queue.getJob(jobId)).toBeTruthy();

        const lost = new Error('Connection is closed.');
        const failing = withTaskQueueWrite(
            sql,
            undefined,
            { kind: 'add', queue: queueName, jobId: `unmanaged#run_${randomUUID()}` },
            async () => {
                throw lost;
            },
        );
        await expect(failing).rejects.toBe(lost);
        await expect(failing).rejects.not.toBeInstanceOf(QueueOperationUncertainError);
        expect(
            await sql`SELECT operation_id FROM task_runtime_queue_operations WHERE queue_name = ${queueName}`,
        ).toHaveLength(0);
    });

    it('refuses tokenless writes while a tasks authority row exists (cached 30 s check)', async () => {
        const token = await owner();
        resetUnmanagedQueueWriteCheckForTesting();
        let calls = 0;
        const write = async (): Promise<void> => {
            calls++;
        };
        await expect(
            withTaskQueueWrite(sql, undefined, { kind: 'add', queue: queueName }, write),
        ).rejects.toMatchObject({ code: 'stale_authority' });
        // Concurrent callers share one probe and all fail closed.
        const results = await Promise.allSettled([
            withTaskQueueWrite(sql, undefined, { kind: 'add', queue: queueName }, write),
            withTaskQueueWrite(sql, undefined, { kind: 'add', queue: queueName }, write),
        ]);
        expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
        expect(calls).toBe(0);

        // A refusal is never cached: once the row is gone the next call passes.
        await sql`DELETE FROM task_runtime_authorities WHERE partition = 'tasks' AND owner_id = ${token.ownerId}`;
        await withTaskQueueWrite(sql, undefined, { kind: 'add', queue: queueName }, write);
        expect(calls).toBe(1);
    });

    it('retires a managed journal row only when the write proves it was never sent', async () => {
        const token = await owner();
        const notSent = new QueueWriteNotSentError('refused before any RPC');
        await expect(
            withTaskQueueWrite(sql, token, { kind: 'add', queue: queueName }, async () => {
                throw notSent;
            }),
        ).rejects.toBe(notSent);
        expect(
            await sql`SELECT operation_id FROM task_runtime_queue_operations WHERE queue_name = ${queueName}`,
        ).toHaveLength(0);
        // A transport error proves nothing: the row stays as a barrier.
        await expect(
            withTaskQueueWrite(sql, token, { kind: 'add', queue: queueName }, async () => {
                throw new Error('Connection is closed.');
            }),
        ).rejects.toBeInstanceOf(QueueOperationUncertainError);
        expect(
            await sql`SELECT operation_id FROM task_runtime_queue_operations
                WHERE queue_name = ${queueName} AND state = 'pending'`,
        ).toHaveLength(1);
    });

    it('keeps the durable barrier after a real FlowProducer.add succeeds but its reply is lost', async () => {
        const token = await owner();
        const jobId = taskJobId(`flow#run_${randomUUID()}`, token);
        await expect(
            withTaskQueueWrite(
                sql,
                token,
                { kind: 'flow-add', queue: queueName, jobId },
                async () => {
                    await flow.add({
                        name: 'fixture',
                        queueName,
                        data: { runId: 'root', taskAuthority: token },
                        opts: { jobId },
                        children: [
                            {
                                name: 'fixture',
                                queueName,
                                data: { runId: 'child', taskAuthority: token },
                                opts: { jobId: taskJobId(`child#run_${randomUUID()}`, token) },
                            },
                        ],
                    });
                    throw new Error('queue reply lost');
                },
            ),
        ).rejects.toThrow('queue reply lost');
        expect(await queue.getJob(jobId)).toBeTruthy();
        await store.beginDrain(token);
        await expect(store.getDrainProof(token)).rejects.toMatchObject({ code: 'not_drained' });
        const [pending] =
            await sql`SELECT state, generation::text, owner_id FROM task_runtime_queue_operations WHERE job_id = ${jobId}`;
        expect(pending).toMatchObject({
            state: 'pending',
            generation: token.generation,
            owner_id: token.ownerId,
        });
    });

    it('does not send a queue RPC when the prepare transaction committed but its ACK was lost', async () => {
        const token = await owner();
        const jobId = taskJobId(`lost-prepare#run_${randomUUID()}`, token);
        let called = false;
        const lostAck = new Proxy(sql, {
            get(target, property, receiver) {
                if (property === 'begin')
                    return async (
                        callback: (tx: postgres.TransactionSql) => Promise<unknown>,
                    ): Promise<never> => {
                        await target.begin(callback);
                        throw new Error('prepare commit reply lost');
                    };
                return Reflect.get(target, property, receiver);
            },
        });
        await expect(
            withTaskQueueWrite(
                lostAck,
                token,
                { kind: 'add', queue: queueName, jobId },
                async () => {
                    called = true;
                    return queue.add('fixture', { runId: 'lost' }, { jobId });
                },
            ),
        ).rejects.toThrow('prepare commit reply lost');
        expect(called).toBe(false);
        expect(await queue.getJob(jobId)).toBeUndefined();
        await store.beginDrain(token);
        await expect(store.getDrainProof(token)).rejects.toMatchObject({ code: 'not_drained' });
    });

    it('blocks draining while a bound queue RPC is paused and releases only after its durable settlement', async () => {
        const token = await owner();
        const entered = gate();
        const finish = gate();
        const jobId = taskJobId(`bound#run_${randomUUID()}`, token);
        const publication = withTaskQueueWrite(
            sql,
            token,
            { kind: 'add', queue: queueName, jobId },
            async () => {
                entered.release();
                await finish.wait;
                return queue.add('fixture', { runId: 'bound', taskAuthority: token }, { jobId });
            },
        );
        await entered.wait;
        try {
            await store.beginDrain(token);
            await expect(store.getDrainProof(token)).rejects.toMatchObject({ code: 'not_drained' });
        } finally {
            finish.release();
            await publication;
        }
        expect(await store.getDrainProof(token)).toMatchObject({
            generation: token.generation,
            dispatchIds: [],
        });
        const job = await queue.getJob(jobId);
        expect(job).toBeTruthy();
        assertTaskJobOrigin(token, job!.data.taskAuthority, job!.id);
        // Actual TaskRunner admission rejects stale or unstamped deliveries
        // before touching run state, providers or the plugin implementation.
        const successor = { ...token, generation: '2', ownerId: randomUUID() };
        const runner = TaskRunner.createExecutor({ authority: successor, getSql: () => sql });
        await expect(runner.processJob(job!)).rejects.toMatchObject({ code: 'stale_authority' });
    });

    it('rejects non-global owners and a missing pool before the actual Queue.add', async () => {
        const token = await owner();
        let calls = 0;
        const write = async (): Promise<void> => {
            calls++;
            await queue.add('fixture', {});
        };
        await expect(
            withTaskQueueWrite(
                sql,
                { ...token, partition: 'other' },
                { kind: 'add', queue: queueName },
                write,
            ),
        ).rejects.toMatchObject({ code: 'invalid' });
        await expect(
            withTaskQueueWrite(null, token, { kind: 'add', queue: queueName }, write),
        ).rejects.toMatchObject({ code: 'stale_authority' });
        expect(calls).toBe(0);
        // Unbound writes no longer consult the authority table per call: the
        // worker refuses to start while a managed row exists instead.
        await expect(assertTaskAuthorityUnmanaged(sql)).rejects.toMatchObject({
            code: 'managed_authority_disabled',
        });
    });

    it('refuses managed authority initialization unless enabled for tests', async () => {
        await assertTaskAuthorityUnmanaged(sql);
        enableManagedAuthorityForTesting(false);
        try {
            await expect(
                store.initialize('tasks', randomUUID(), 'typescript'),
            ).rejects.toBeInstanceOf(ManagedAuthorityDisabledError);
            await expect(
                store.initialize('tasks', randomUUID(), 'typescript'),
            ).rejects.toMatchObject({ code: 'managed_authority_disabled' });
        } finally {
            enableManagedAuthorityForTesting(null);
        }
        expect(await sql`SELECT partition FROM task_runtime_authorities WHERE partition = 'tasks'`)
            .toHaveLength(0);
    });

    it('retires a managed row when BullMQ refuses to remove a locked job', async () => {
        const token = await owner();
        const jobId = taskJobId(`locked#run_${randomUUID()}`, token);
        await queue.add('fixture', { runId: 'locked', taskAuthority: token }, { jobId });
        // Simulate a worker holding the job: BullMQ's remove script answers 0.
        const redis = new IORedis({ ...connection, maxRetriesPerRequest: null });
        try {
            await redis.set(`${queue.toKey(jobId)}:lock`, 'other-worker', 'PX', 30_000);
        } finally {
            redis.disconnect();
        }
        const job = await queue.getJob(jobId);
        const removal = withTaskQueueWrite(
            sql,
            token,
            { kind: 'remove', queue: queueName, jobId },
            () => job!.remove(),
            { allowDraining: true },
        );
        await expect(removal).rejects.toThrow('locked by another worker');
        await expect(removal).rejects.not.toBeInstanceOf(QueueOperationUncertainError);
        expect(await queue.getJob(jobId)).toBeTruthy();
        expect(
            await sql`SELECT operation_id FROM task_runtime_queue_operations WHERE queue_name = ${queueName}`,
        ).toHaveLength(0);
    });

    it('janitor deletes stale unmanaged leftovers, keeps managed rows and reports them', async () => {
        const staleUnmanaged = randomUUID();
        const freshUnmanaged = randomUUID();
        const staleManaged = randomUUID();
        await sql`INSERT INTO task_runtime_queue_operations
            (operation_id, partition, generation, owner_id, kind, queue_name, state, created_at)
            VALUES
            (${staleUnmanaged}, 'tasks', NULL, NULL, 'add', ${queueName}, 'pending', clock_timestamp() - interval '1 hour'),
            (${freshUnmanaged}, 'tasks', NULL, NULL, 'add', ${queueName}, 'pending', clock_timestamp()),
            (${staleManaged}, 'tasks', 1, ${randomUUID()}, 'add', ${queueName}, 'pending', clock_timestamp() - interval '1 hour')`;
        const result = await sweepQueueOperationJournal(sql, 10 * 60_000);
        expect(result).toMatchObject({ unmanagedDeleted: 1 });
        expect(result!.staleManaged).toBeGreaterThanOrEqual(1);
        expect(result!.pending).toBeGreaterThanOrEqual(2);
        expect(result!.oldestPendingSeconds).toBeGreaterThan(3000);
        const left = await sql<{ operation_id: string }[]>`SELECT operation_id
            FROM task_runtime_queue_operations WHERE queue_name = ${queueName}`;
        expect(left.map((row) => row.operation_id).sort()).toEqual(
            [freshUnmanaged, staleManaged].sort(),
        );
        expect((await tasksRegistry.getSingleMetricAsString('lumastra_task_queue_journal_pending')))
            .toContain(`lumastra_task_queue_journal_pending ${result!.pending}`);
    });
});
