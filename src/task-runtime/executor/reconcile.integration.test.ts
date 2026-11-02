// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { expect, it, vi } from 'vitest';
import { getTestDatabaseUrl } from '../../../tests/integration/setup/test-database.js';
import { AuthorityStore } from '../authority/store.js';
import { ExecutorClient } from '../executor-client.js';
import { startExecutorServer } from './server.js';
import { reconcileExecutorAdmission } from './reconcile.js';

it('recovers the real expired-owner durable UNKNOWN through production reconciliation and private transport without re-execution', async () => {
    const sql = postgres(getTestDatabaseUrl(), { max: 2 });
    const store = new AuthorityStore(sql);
    const authority = await store.initialize(`receipt:${randomUUID()}`, randomUUID(), 'typescript');
    const command = {
        authority,
        invocationId: randomUUID(),
        dispatchId: randomUUID(),
        runId: randomUUID(),
        taskId: 'receipt-task',
        queueName: 'receipt-task',
        jobId: 'receipt-task#fixture',
        lockToken: randomUUID(),
        lockDurationMs: 30_000,
        catalogRevision: 'a'.repeat(64),
    };
    const directory = await mkdtemp(path.join(tmpdir(), 'expired-receipt-'));
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    let server: Awaited<ReturnType<typeof startExecutorServer>> | undefined;
    try {
        await store.admitExecution(authority, {
            invocationId: command.invocationId,
            dispatchId: command.dispatchId,
            runId: command.runId,
            taskId: command.taskId,
        });
        await sql`UPDATE task_runtime_authorities SET lease_until = clock_timestamp() - interval '1 second' WHERE partition = ${authority.partition}`;
        await store.beginDrain(authority);
        await store.confirmExpiredTeardown(authority, command.invocationId, {
            dispatchId: command.dispatchId,
            quiescent: true,
        });
        server = await startExecutorServer({
            directory,
            secret: 'b'.repeat(64),
            catalogRevision: () => command.catalogRevision,
            executor: { execute, cancel() {}, isQuiescent: () => true, async close() {} },
            authorize: async () => {
                throw new Error('Admission acknowledgement was lost');
            },
            reconcile: (execution) => reconcileExecutorAdmission(store, execution),
        });
        const client = new ExecutorClient({ ...server, secret: 'b'.repeat(64) });
        expect(await client.execute(command, { pollIntervalMs: 20 })).toMatchObject({
            admitted: true,
            outcome: { status: 'unknown', reason: 'owner_lease_expired' },
            quiescent: true,
        });
        expect(await client.request({ operation: 'status' })).toMatchObject({
            status: { active: 0, quiescent: true },
        });
        expect(execute).not.toHaveBeenCalled();
    } finally {
        await server?.close();
        await sql`DELETE FROM task_runtime_executions WHERE partition = ${authority.partition}`;
        await sql`DELETE FROM task_runtime_authorities WHERE partition = ${authority.partition}`;
        await sql.end();
        await rm(directory, { recursive: true, force: true });
    }
}, 15_000);
