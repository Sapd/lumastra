// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Unmanaged task mode (production) must not journal queue writes: a Valkey
// failure during an enqueue surfaces the original error so startRun's
// compensation and hard-kill's Lua bypass run, with no pending journal row.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { z } from 'zod';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { QueueOperationUncertainError } from '../../../task-runtime/authority/queue-write.js';
import { TaskRegistry } from './registry.js';
import { StateMachine, stateMachine } from './state-machine.js';
import { TaskOrchestrator } from './orchestrator.js';
import { HardKill } from './hard-kill.js';
import { identityKey } from './identity.js';
import { luaLoader } from './lua/loader.js';
import { requireClient, type ValkeyLike } from './valkey-types.js';

const sql = postgres(getTestDatabaseUrl(), { max: 4 });
const taskIds = new Set<string>();
const runIds = new Set<string>();
const keys = new Set<string>();

async function journalRowsSince(since: Date): Promise<number> {
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::integer AS count
        FROM task_runtime_queue_operations WHERE created_at >= ${since}`;
    return row.count;
}

function transportFailure(): Error {
    // The ioredis message for a command rejected on a closed connection.
    return new Error('Connection is closed.');
}

describe('unmanaged queue writes surface the original Valkey error', () => {
    beforeAll(async () => {
        await connectValkey();
        await luaLoader.load();
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        if (keys.size > 0) await requireClient().customCommand(['DEL', ...keys]);
        keys.clear();
    });
    afterAll(async () => {
        for (const taskId of taskIds) {
            await sql`DELETE FROM task_history WHERE task_id = ${taskId}`;
            await sql`DELETE FROM task_quota_usage WHERE task_id = ${taskId}`;
        }
        for (const id of runIds) await sql`DELETE FROM task_history WHERE id = ${id}`;
        await sql.end();
        await disconnectValkey();
    });

    it('startRun compensates a failed enqueue: no journal row, identity released, row failed', async () => {
        const taskId = `unmanaged-enqueue-${randomUUID().slice(0, 8)}`;
        taskIds.add(taskId);
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Unmanaged enqueue fixture',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ scope: z.string() }),
                identityFor: (input) => (input as { scope: string }).scope,
                exclusiveWith: { scope: 'global' as const, ttl: '24h' },
                quotas: { maxRunsPerDay: 5 },
                async execute() {
                    return { success: true };
                },
            }),
        );
        const orchestrator = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: () => requireClient(),
        });
        try {
            const since = new Date(Date.now() - 1_000);
            const failure = transportFailure();
            vi.spyOn(Queue.prototype, 'add').mockRejectedValueOnce(failure);

            const attempt = orchestrator.startRun(taskId, { scope: 'lib-1' });
            await expect(attempt).rejects.toBe(failure);
            await expect(attempt).rejects.not.toBeInstanceOf(QueueOperationUncertainError);
            expect(await journalRowsSince(since)).toBe(0);

            const [failed] = await sql<{ id: string; state: string; error: { message: string } }[]>`
                SELECT id, state, error FROM task_history WHERE task_id = ${taskId}`;
            expect(failed.state).toBe('failed');
            expect(failed.error.message).toContain('startRun compensation');

            // Identity released: the same scope starts a NEW run instead of
            // deduping onto the failed one.
            const retry = await orchestrator.startRun(taskId, { scope: 'lib-1' });
            expect(retry.deduped).toBeFalsy();
            expect(retry.runId).not.toBe(failed.id);

            // The failed run keeps its daily slot by design (its task_history row
            // counts toward today's bucket); the retry takes the second one. No
            // slot leaks beyond the two runs that exist.
            const [usage] = await sql<{ runs: number }[]>`
                SELECT runs FROM task_quota_usage WHERE task_id = ${taskId}`;
            expect(usage.runs).toBe(2);
        } finally {
            await orchestrator.stop();
        }
    }, 30_000);

    it('hard-kill falls through to the Lua bypass when moveToFailed fails', async () => {
        const id = randomUUID();
        runIds.add(id);
        await sql`INSERT INTO task_history
            (id, task_id, label, state, input, trigger, actor, processing_version,
             started_at, heartbeat_at, owner_instance_id)
            VALUES (${id}, 'unmanaged-hard-kill-fixture', 'fixture', 'active',
                '{}', '{"kind":"manual"}', '{"type":"system"}', 1, NOW(), NOW(), 'fixture')`;
        const client: ValkeyLike = requireClient();
        const base = 'unmanaged-hard-kill-fixture~~global';
        const jobId = `${base}#${id}`;
        const active = `task:run:active:${id}`;
        const identity = identityKey('unmanaged-hard-kill-fixture', base);
        keys.add(active).add(`task:run:terminal:${id}`).add(identity);
        await client.customCommand(['HSET', active, 'state', 'active']);
        await client.customCommand(['SET', identity, id]);
        const moveToFailed = vi.fn(async () => {
            throw transportFailure();
        });
        const job = {
            id: jobId,
            data: {},
            getState: async () => 'active',
            token: 'worker-token',
            moveToFailed,
        };
        const queue = {
            name: `unmanaged-hk-${randomUUID().slice(0, 8)}`,
            opts: { prefix: 'bull:task' },
            getJob: async () => job,
        } as unknown as Queue;
        const since = new Date(Date.now() - 1_000);
        const hardKill = new HardKill(
            () => sql,
            () => queue,
            () => client,
            new StateMachine(() => client),
            async () => jobId,
        );

        expect(await hardKill.execute(id)).toEqual({ killed: true, method: 'redis-pipeline' });
        expect(moveToFailed).toHaveBeenCalledTimes(1);
        expect(await journalRowsSince(since)).toBe(0);
        const [history] = await sql`SELECT state FROM task_history WHERE id = ${id}`;
        expect(history.state).toBe('cancelled');
        expect(await client.customCommand(['GET', identity])).toBeNull();
    });
});
