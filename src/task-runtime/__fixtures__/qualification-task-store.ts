// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import postgres from 'postgres';
import { PER_TASK_QUEUE_PREFIX } from '$lib/server/tasks/queue-naming.js';

/** Actual hosts must not consume queues left by unrelated integration fixtures.
 * The suite is sequential, and both endpoints must be disposable test DBs.
 * Initializing an actual queue also identifies the selected slot on runners
 * sharing a Valkey server across logical DBs. Production guards stay enabled.
 */
export async function isolateQualificationTaskStore(): Promise<() => Promise<void>> {
    const database = new URL(process.env.TEST_DATABASE_URL ?? '');
    assert(/^\/(?:lumastra_t_[a-z0-9_]+|lumastra_tests)$/.test(database.pathname));
    const urls = [
        process.env.TEST_CACHE_URL ?? process.env.CACHE_URL,
        process.env.TEST_TASK_CACHE_URL ?? process.env.TASK_CACHE_URL,
    ];
    // Validate every endpoint before clearing either of them.
    for (const value of urls) {
        assert(value, 'Sanctioned integration Valkeys are required');
        assert(/^\/(?:[1-9]|1[0-5])$/.test(new URL(value).pathname), 'Refusing non-test Valkey');
    }
    const clearCoordination = async (): Promise<void> => {
        for (const value of new Set(urls)) {
            const client = new Redis(value!);
            try {
                await client.flushdb();
            } finally {
                await client.quit();
            }
        }
    };
    await clearCoordination();
    const connection = new Redis(urls[1]!, { maxRetriesPerRequest: null });
    const queue = new Queue(`qualification-${randomUUID()}`, {
        connection,
        prefix: PER_TASK_QUEUE_PREFIX,
    });
    const sql = postgres(database.toString(), { max: 1 });
    let originalRuns: string[];
    let originalSchedules: string[];
    try {
        originalRuns = (await sql<{ id: string }[]>`SELECT id FROM task_history`).map(
            (row) => row.id,
        );
        originalSchedules = (
            await sql<{ task_id: string }[]>`SELECT task_id FROM scheduler_state`
        ).map((row) => row.task_id);
        const job = await queue.add('initialize-test-store', {});
        await job.remove();
    } catch (error) {
        await queue.close();
        await connection.quit();
        await sql.end();
        throw error;
    }
    return async (): Promise<void> => {
        try {
            await queue.obliterate({ force: true });
            // Hosts and their SQL sessions have stopped before this hook. Remove
            // queued startup work BEFORE its history, including jobs never claimed
            // by a worker (owner_instance_id is still NULL). Otherwise later drain
            // and timeline fixtures see these accepted runs and scheduler rows.
            await clearCoordination();
            await sql.begin(async (tx) => {
                await tx`DELETE FROM task_history WHERE NOT (id::text = ANY(${originalRuns}::text[]))`;
                await tx`DELETE FROM scheduler_state WHERE NOT (task_id = ANY(${originalSchedules}::text[]))`;
            });
        } finally {
            await queue.close();
            await connection.quit();
            await sql.end();
        }
    };
}
