// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import postgres from 'postgres';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { requireClient } from './valkey-types.js';
import { getQueueConnectionOptions } from './connection.js';
import { PER_TASK_QUEUE_PREFIX } from './queue-naming.js';
import { PendingWriteDrain, type PendingWrite } from './pending-write-drain.js';
import { captureTerminalQueueAttempt, type TerminalQueueAttempt } from './terminal-attempt.js';

const sql = postgres(getTestDatabaseUrl(), { max: 3 });
beforeAll(async () => {
    await connectValkey();
});
afterAll(async () => {
    await disconnectValkey();
    await sql.end();
});
async function until(check: () => Promise<boolean> | boolean): Promise<void> {
    const end = performance.now() + 10_000;
    while (!(await check())) {
        if (performance.now() > end) throw new Error('Terminal attempt observation timed out');
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
}

it.each(['same-attempt', 'newer-attempt', 'missing-job', 'lost-ack'] as const)(
    'validates retained provenance through the actual queue lifecycle: %s',
    async (scenario) => {
        const id = `terminal-attempt-${randomUUID()}`;
        const runId = `run_${randomUUID()}`;
        const connection = getQueueConnectionOptions();
        if (!connection) throw new Error('Queue connection required');
        const queue = new Queue(id, { connection, prefix: PER_TASK_QUEUE_PREFIX });
        let attempt: TerminalQueueAttempt | undefined;
        let releases: () => void = () => {};
        let calls = 0;
        const worker = new Worker(
            id,
            async (job) => {
                calls++;
                if (calls === 1) {
                    attempt = captureTerminalQueueAttempt(job);
                    throw new Error('first attempt failed');
                }
                await new Promise<void>((resolve) => {
                    releases = resolve;
                });
                return { success: true };
            },
            { connection, prefix: PER_TASK_QUEUE_PREFIX, concurrency: 1 },
        );
        try {
            await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at) VALUES (${runId}, ${id}, 'Attempt fixture', 'active', '{}', '{"kind":"manual"}', '{"type":"system"}', 1, NOW())`;
            const original = await queue.add(id, { runId }, { jobId: id });
            await until(async () => (await original.getState()) === 'failed');
            expect(attempt).toBeDefined();
            const write: PendingWrite = {
                kind: 'update',
                runId,
                queueAttempt: attempt,
                payload: {
                    state: 'failed',
                    error: { message: 'original attempt' },
                    completedAt: new Date().toISOString(),
                },
                enqueuedAt: Date.now(),
            };
            const drain = new PendingWriteDrain(sql, async () => requireClient());
            if (scenario === 'newer-attempt') {
                await original.retry();
                await until(() => calls === 2);
            }
            if (scenario === 'missing-job') await original.remove();
            if (scenario === 'lost-ack') {
                const lostReply = new PendingWriteDrain(sql, async () => ({
                    customCommand: async (command) => {
                        const result = await requireClient().customCommand(command);
                        if (
                            (command[0] === 'EVAL' || command[0] === 'EVALSHA') &&
                            command.includes('task:pending-writes') &&
                            command.some(
                                (value) =>
                                    value.startsWith('{') && value.includes('"kind":"update"'),
                            )
                        )
                            throw new Error('Actual enqueue applied; ACK lost');
                        return result;
                    },
                }));
                await expect(lostReply.enqueue(write, { strict: true })).rejects.toThrow(
                    'unconfirmed',
                );
            }
            await drain.enqueue(write, { strict: true });
            await drain.drain();
            const rows = await sql<
                { state: string; error: { message: string } }[]
            >`SELECT state, error FROM task_history WHERE id = ${runId}`;
            if (scenario === 'same-attempt' || scenario === 'lost-ack')
                expect(rows[0]?.state).toBe('failed');
            else expect(rows[0]?.state).toBe('active');
            if (scenario === 'missing-job') {
                expect(
                    Number(await requireClient().customCommand(['LLEN', 'task:pending-writes'])),
                ).toBeGreaterThan(0);
                await sql`UPDATE task_history SET state = 'completed' WHERE id = ${runId}`;
                await drain.drain();
                expect(
                    (
                        await sql<
                            { state: string }[]
                        >`SELECT state FROM task_history WHERE id = ${runId}`
                    )[0]?.state,
                ).toBe('completed');
            }
            if (scenario === 'newer-attempt') {
                releases();
                await until(async () => (await original.getState()) === 'completed');
            }
        } finally {
            releases();
            await worker.close();
            await queue.obliterate({ force: true });
            await queue.close();
            await sql`DELETE FROM task_history WHERE id = ${runId}`;
        }
    },
    20_000,
);

it.each(
    (['same-attempt', 'newer-attempt', 'missing-job', 'existing-result'] as const).flatMap(
        (scenario) => [false, true].map((native) => ({ scenario, native })),
    ),
)(
    'conserves the original result after a state-only terminal mirror: $scenario (native=$native)',
    async ({ scenario, native }) => {
        const id = `terminal-result-${randomUUID()}`;
        const runId = `run_${randomUUID()}`;
        const connection = getQueueConnectionOptions();
        if (!connection) throw new Error('Queue connection required');
        const queue = new Queue(id, { connection, prefix: PER_TASK_QUEUE_PREFIX });
        let attempt: TerminalQueueAttempt | undefined;
        let calls = 0;
        let release: () => void = () => {};
        const worker = new Worker(
            id,
            async (job) => {
                calls++;
                if (calls === 1) {
                    attempt = captureTerminalQueueAttempt(job);
                    throw new Error('original failure');
                }
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                return { success: true };
            },
            { connection, prefix: PER_TASK_QUEUE_PREFIX },
        );
        try {
            const completedAt = '2026-10-18T00:00:00.000Z';
            const originalResult = native
                ? {
                      success: true,
                      itemsProcessed: 1,
                      result: {
                          probed: 0,
                          keyframed: 0,
                          errors: 0,
                          missing: 0,
                          recheck: {
                              fileId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                              outcome: 'warning',
                              reason: 'warnings_remain',
                              issues: [{ type: 'video_ends_early' }],
                          },
                      },
                  }
                : { itemsProcessed: 7 };
            await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at, completed_at, error)
                VALUES (${runId}, ${id}, 'Result fixture', 'failed', '{}', '{"kind":"manual"}', '{"type":"system"}', 1, NOW(), ${completedAt}, '{"message":"mirror"}')`;
            const job = await queue.add(id, { runId }, { jobId: id });
            await until(async () => (await job.getState()) === 'failed');
            expect(attempt).toBeDefined();
            if (scenario === 'newer-attempt') {
                await job.retry();
                await until(() => calls === 2);
            }
            if (scenario === 'missing-job') await job.remove();
            if (scenario === 'existing-result')
                await sql`UPDATE task_history SET result = '{"other":true}' WHERE id = ${runId}`;
            const write: PendingWrite = {
                kind: 'update',
                runId,
                queueAttempt: attempt,
                payload: {
                    state: 'failed',
                    result: originalResult,
                    error: { message: 'original' },
                    completedAt: new Date().toISOString(),
                },
                enqueuedAt: Date.now(),
            };
            const drain = new PendingWriteDrain(sql, async () => requireClient());
            await drain.enqueue(write, { strict: true });
            await drain.enqueue(write, { strict: true }); // Applied twice/lost ACK remains idempotent.
            await drain.drain();
            const rows = await sql<
                { result: unknown; error: { message: string }; completed_at: Date }[]
            >`SELECT result, error, completed_at FROM task_history WHERE id = ${runId}`;
            expect(rows[0]?.result).toEqual(
                scenario === 'same-attempt'
                    ? originalResult
                    : scenario === 'existing-result'
                      ? { other: true }
                      : null,
            );
            if (native && scenario === 'same-attempt') {
                expect(rows[0]?.result).toMatchObject({
                    success: true,
                    itemsProcessed: 1,
                    result: {
                        recheck: {
                            outcome: 'warning',
                            reason: 'warnings_remain',
                            issues: [{ type: 'video_ends_early' }],
                        },
                    },
                });
                const [shape] =
                    await sql`SELECT jsonb_typeof(result) AS kind FROM task_history WHERE id = ${runId}`;
                expect(shape.kind).toBe('object');
            }
            expect(rows[0]?.error.message).toBe('mirror');
            expect(new Date(rows[0]!.completed_at).toISOString()).toBe(completedAt);
            if (scenario === 'missing-job' || scenario === 'existing-result') {
                expect(
                    Number(await requireClient().customCommand(['LLEN', 'task:pending-writes'])),
                ).toBeGreaterThan(0);
                // Only the complete original result acknowledges this missing or
                // conflicting observation; state='failed' alone was insufficient.
                await sql`UPDATE task_history SET result = ${sql.json(originalResult)} WHERE id = ${runId}`;
                await drain.drain();
            }
        } finally {
            release();
            await worker.close();
            await queue.obliterate({ force: true });
            await queue.close();
            await sql`DELETE FROM task_history WHERE id = ${runId}`;
        }
    },
    20_000,
);

it.each(['original-owner', 'successor-owner'] as const)(
    'reaped-job pending terminal write after three missing observations: %s',
    async (scenario) => {
        const id = `terminal-reaped-${randomUUID()}`;
        const runId = `run_${randomUUID()}`;
        const connection = getQueueConnectionOptions();
        if (!connection) throw new Error('Queue connection required');
        const queue = new Queue(id, { connection, prefix: PER_TASK_QUEUE_PREFIX });
        let attempt: TerminalQueueAttempt | undefined;
        const worker = new Worker(
            id,
            async (job) => {
                attempt = captureTerminalQueueAttempt(job);
                throw new Error('original failure');
            },
            { connection, prefix: PER_TASK_QUEUE_PREFIX, concurrency: 1 },
        );
        const client = requireClient();
        try {
            // Earlier scenarios may leave retained entries; this one needs the list head.
            await client.customCommand([
                'DEL',
                'task:pending-writes',
                'task:pending-writes:processing',
            ]);
            await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at, owner_instance_id) VALUES (${runId}, ${id}, 'Reaped fixture', 'active', '{}', '{"kind":"manual"}', '{"type":"system"}', 1, NOW(), 'drain-original')`;
            const job = await queue.add(id, { runId }, { jobId: id });
            await until(async () => (await job.getState()) === 'failed');
            expect(attempt).toBeDefined();
            await job.remove();
            const drain = new PendingWriteDrain(sql, async () => requireClient());
            await drain.enqueue(
                {
                    kind: 'update',
                    runId,
                    queueAttempt: attempt,
                    ownerInstanceId: 'drain-original',
                    payload: {
                        state: 'failed',
                        result: { itemsProcessed: 4 },
                        error: { message: 'original attempt' },
                        completedAt: new Date().toISOString(),
                    },
                    enqueuedAt: Date.now(),
                },
                { strict: true },
            );
            for (let observed = 1; observed < 3; observed++) {
                await drain.drain();
                const [retained] = (await client.customCommand([
                    'LRANGE',
                    'task:pending-writes',
                    '0',
                    '-1',
                ])) as string[];
                expect(JSON.parse(retained)).toMatchObject({ jobMissingObservations: observed });
                expect(
                    (
                        await sql<
                            { state: string }[]
                        >`SELECT state FROM task_history WHERE id = ${runId}`
                    )[0]?.state,
                ).toBe('active');
            }
            // A successor attempt (re-dispatched under a new job) now owns the row.
            if (scenario === 'successor-owner')
                await sql`UPDATE task_history SET owner_instance_id = 'drain-successor' WHERE id = ${runId}`;
            expect(await drain.drain()).toEqual({ drained: 1, remaining: 0 });
            const [row] = await sql<
                { state: string; result: unknown }[]
            >`SELECT state, result FROM task_history WHERE id = ${runId}`;
            if (scenario === 'original-owner') {
                expect(row?.state).toBe('failed');
                expect(row?.result).toEqual({ itemsProcessed: 4 });
            } else {
                expect(row?.state).toBe('active');
                expect(row?.result).toBeNull();
            }
        } finally {
            await worker.close();
            await queue.obliterate({ force: true });
            await queue.close();
            await sql`DELETE FROM task_history WHERE id = ${runId}`;
        }
    },
    20_000,
);
