// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { requireClient } from '$lib/server/tasks/valkey-types.js';
import { insertTaskHistoryRow, type TaskHistoryInsert } from '$lib/server/tasks/task-history.js';
import { PendingWriteDrain, type PendingWrite } from '$lib/server/tasks/pending-write-drain.js';
import { AuthorityStore, type AuthorityToken } from './store.js';
import { withExistingTaskWrite } from './existing-write.js';
import {
    quarantineValkeyTaskAuthority,
    installValkeyTaskAuthority,
} from '$lib/server/tasks/lua/fenced-control.js';
import {
    VALKEY_TASK_AUTHORITY_KEY,
    VALKEY_TASK_MANAGED_KEY,
} from '$lib/server/tasks/lua/fenced.js';

const prefix = `existing-write-${randomUUID()}`;
const connections: postgres.Sql[] = [];
const runIds: string[] = [];
const keys = [
    'task:pending-writes',
    'task:pending-writes:processing',
    'task:pending-writes:poison',
    VALKEY_TASK_AUTHORITY_KEY,
    VALKEY_TASK_MANAGED_KEY,
];
function connection(): postgres.Sql {
    const sql = postgres(getTestDatabaseUrl(), { max: 1 });
    connections.push(sql);
    return sql;
}
const db = connection();
const store = new AuthorityStore(db);
const ownedOwnerIds = new Set<string>();
function ownerId(): string {
    const id = randomUUID();
    ownedOwnerIds.add(id);
    return id;
}
function row(): TaskHistoryInsert {
    const id = randomUUID();
    runIds.push(id);
    return {
        id,
        taskId: 'existing-writer-fixture',
        parentRunId: null,
        label: prefix,
        state: 'pending',
        input: {},
        scope: null,
        trigger: { kind: 'in-process' },
        actor: { type: 'system' },
        startedAt: new Date(),
        processingVersion: 1,
        ownerInstanceId: randomUUID(),
        retentionPolicy: 'standard',
        stages: [],
    };
}
async function owner(leaseMs = 30_000): Promise<AuthorityToken> {
    const authority = await store.initialize('tasks', ownerId(), 'typescript', leaseMs);
    await mirror(authority);
    return authority;
}
async function mirror(authority: AuthorityToken, previous?: AuthorityToken): Promise<void> {
    await quarantineValkeyTaskAuthority(requireClient(), previous);
    await installValkeyTaskAuthority(requireClient(), previous, {
        authority,
        phase: 'active',
        leaseUntilMs: Date.now() + 30_000,
    });
}
// This suite tests the SQL fence, not physical mirror/process handover. Seed
// the coordinator's prerequisite journal explicitly; full handover has its own
// real two-mirror integration suite.
async function prepareTransferFixture(
    token: AuthorityToken,
    targetStore = store,
): Promise<() => Promise<AuthorityToken>> {
    const nextOwner = ownerId();
    const id = randomUUID();
    await db`INSERT INTO task_runtime_handovers
        (partition, handover_id, source_generation, source_owner_id, next_owner_id, next_owner_kind, recovery, phase)
        VALUES (${token.partition}, ${id}, ${token.generation}::bigint, ${token.ownerId}, ${nextOwner}, 'typescript', false, 'quarantined')`;
    return () =>
        targetStore.handoffWithCheckpoint(
            token,
            { ownerId: nextOwner, ownerKind: 'typescript' },
            { generation: token.generation, dispatchIds: [] },
            30_000,
            async (tx) => {
                await tx`UPDATE task_runtime_handovers SET phase = 'complete' WHERE handover_id = ${id}`;
            },
            false,
            id,
        );
}
async function transfer(token: AuthorityToken): Promise<AuthorityToken> {
    await store.beginDrain(token);
    const successor = await (await prepareTransferFixture(token))();
    await mirror(successor, token);
    return successor;
}
async function clearLists(): Promise<void> {
    await requireClient().customCommand(['DEL', ...keys]);
}
function pending(runId: string, authority?: AuthorityToken): PendingWrite {
    return {
        kind: 'update',
        runId,
        authority,
        payload: {
            state: 'completed',
            completedAt: new Date().toISOString(),
            result: { success: true },
        },
        enqueuedAt: Date.now(),
    };
}

describe('existing history writers retain their captured SQL authority', () => {
    beforeAll(async () => {
        await connectValkey();
        await clearLists();
    });
    afterEach(async () => {
        // Each case creates a fresh generation-one SQL authority. Do not let
        // the preceding case's generation-two mirror impersonate this owner.
        await clearLists();
        for (const id of ownedOwnerIds) {
            await db`DELETE FROM task_runtime_handovers WHERE partition = 'tasks' AND (source_owner_id = ${id} OR next_owner_id = ${id})`;
            await db`DELETE FROM task_runtime_authorities WHERE partition = 'tasks' AND owner_id = ${id}`;
        }
        ownedOwnerIds.clear();
    });
    afterAll(async () => {
        await clearLists();
        for (const id of runIds) await db`DELETE FROM task_history WHERE id = ${id}`;
        await db`DELETE FROM task_runtime_authorities WHERE starts_with(partition, ${prefix})`;
        await Promise.all(connections.map((sql) => sql.end()));
        await disconnectValkey();
    });

    it('keeps unmanaged inserts compatible before management exists', async () => {
        const history = row();
        await insertTaskHistoryRow(db, history);
        const [saved] = await db`SELECT state FROM task_history WHERE id = ${history.id}`;
        expect(saved.state).toBe('pending');
    });

    it('rejects the actual shared history INSERT after handoff', async () => {
        const authority = await owner();
        const history = row();
        await transfer(authority);
        await expect(insertTaskHistoryRow(db, history, authority)).rejects.toMatchObject({
            code: 'stale_authority',
        });
        expect(await db`SELECT id FROM task_history WHERE id = ${history.id}`).toHaveLength(0);
    });

    it('replays a live draining owner using the original token', async () => {
        await clearLists();
        const authority = await owner();
        const history = row();
        await insertTaskHistoryRow(db, history, authority);
        await store.beginDrain(authority);
        const drain = new PendingWriteDrain(db, async () => requireClient(), authority);
        await drain.enqueue(pending(history.id, authority));
        expect(await drain.drain()).toEqual({ drained: 1, remaining: 0 });
        const [saved] = await db`SELECT state, result FROM task_history WHERE id = ${history.id}`;
        expect(saved).toMatchObject({ state: 'completed', result: { success: true } });
    });

    it('quarantines stale terminal and insert replays without borrowing successor authority', async () => {
        await clearLists();
        const authority = await owner();
        const history = row();
        const deferredInsert = row();
        await insertTaskHistoryRow(db, history, authority);
        const drain = new PendingWriteDrain(db, async () => requireClient(), authority);
        const terminal = pending(history.id, authority);
        const insert: PendingWrite = {
            kind: 'insert',
            runId: deferredInsert.id,
            authority,
            payload: { ...deferredInsert },
            enqueuedAt: Date.now(),
        };
        await drain.enqueue(terminal);
        await drain.enqueue(insert);
        const successor = await transfer(authority);
        await store.assertCurrent(successor);
        const successorDrain = new PendingWriteDrain(db, async () => requireClient(), successor);
        expect(await successorDrain.drain()).toEqual({ drained: 2, remaining: 0 });
        const [saved] = await db`SELECT state, result FROM task_history WHERE id = ${history.id}`;
        expect(saved).toMatchObject({ state: 'pending', result: null });
        expect(await db`SELECT id FROM task_history WHERE id = ${deferredInsert.id}`).toHaveLength(
            0,
        );
        const raw = await requireClient().customCommand(['LRANGE', keys[2], '0', '-1']);
        const poisoned = (raw as string[]).map(
            (value) => JSON.parse(String(value)) as PendingWrite & { rejectionReason: string },
        );
        expect(poisoned).toHaveLength(2);
        expect(
            poisoned.every((entry) => entry.authority?.generation === authority.generation),
        ).toBe(true);
        expect(
            poisoned.every((entry) => entry.rejectionReason === 'authority:stale_authority'),
        ).toBe(true);
        expect(poisoned.find((entry) => entry.kind === 'update')?.payload).toEqual(
            terminal.payload,
        );
    });

    it('rolls back history SQL when the lease expires during the transaction', async () => {
        const authority = await owner(500);
        const history = row();
        await insertTaskHistoryRow(db, history, authority);
        await expect(
            withExistingTaskWrite(db, authority, async (tx) => {
                await tx`UPDATE task_history SET state = 'completed' WHERE id = ${history.id}`;
                await tx`SELECT pg_sleep(0.6)`;
            }),
        ).rejects.toMatchObject({ code: 'stale_authority' });
        const [saved] = await db`SELECT state FROM task_history WHERE id = ${history.id}`;
        expect(saved.state).toBe('pending');
    });

    it('holds the authority row lock until SQL has committed, so handoff waits', async () => {
        const authority = await owner();
        const history = row();
        await insertTaskHistoryRow(db, history, authority);
        await store.beginDrain(authority);
        const writer = connection();
        const contender = connection();
        const [{ pid: writerPid }] = await writer<
            { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const [{ pid: contenderPid }] = await contender<
            { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        let signalEntered!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
            signalEntered = resolve;
        });
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const performHandoff = await prepareTransferFixture(
            authority,
            new AuthorityStore(contender),
        );
        const mutation = withExistingTaskWrite(writer, authority, async (tx) => {
            signalEntered();
            await released;
            await tx`UPDATE task_history SET state = 'completed' WHERE id = ${history.id}`;
        });
        await entered;
        const handoff = performHandoff();
        try {
            // Assert the actual PostgreSQL lock wait, not just elapsed time.
            await expect
                .poll(async () => {
                    const [blocked] = await db<
                        { blocked: boolean }[]
                    >`SELECT ${writerPid} = ANY(pg_blocking_pids(${contenderPid})) AS blocked`;
                    return blocked.blocked;
                })
                .toBe(true);
        } finally {
            release();
        }
        await mutation;
        expect((await handoff).generation).toBe('2');
        const [saved] = await db`SELECT state FROM task_history WHERE id = ${history.id}`;
        expect(saved.state).toBe('completed');
        await expect(
            withExistingTaskWrite(writer, authority, async (tx) => {
                await tx`UPDATE task_history SET state = 'failed' WHERE id = ${history.id}`;
            }),
        ).rejects.toMatchObject({ code: 'stale_authority' });
    });

    it('waits for tokenless SQL before initial management and then rejects tokenless inserts and replay', async () => {
        await clearLists();
        const history = row();
        await insertTaskHistoryRow(db, history);
        const writer = connection();
        const contender = connection();
        const [{ pid: writerPid }] = await writer<
            { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const [{ pid: contenderPid }] = await contender<
            { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        let signalEntered!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => {
            signalEntered = resolve;
        });
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        const mutation = withExistingTaskWrite(writer, undefined, async (tx) => {
            signalEntered();
            await released;
            await tx`UPDATE task_history SET state = 'active' WHERE id = ${history.id}`;
        });
        await entered;
        const managedOwnerId = ownerId();
        const initialization = new AuthorityStore(contender).initialize(
            'tasks',
            managedOwnerId,
            'typescript',
        );
        try {
            await expect
                .poll(async () => {
                    const [blocked] = await db<
                        { blocked: boolean }[]
                    >`SELECT ${writerPid} = ANY(pg_blocking_pids(${contenderPid})) AS blocked`;
                    return blocked.blocked;
                })
                .toBe(true);
        } finally {
            release();
        }
        await mutation;
        const authority = await initialization;
        await mirror(authority);
        const refused = row();
        await expect(insertTaskHistoryRow(db, refused)).rejects.toMatchObject({
            code: 'stale_authority',
        });
        expect(await db`SELECT id FROM task_history WHERE id = ${refused.id}`).toHaveLength(0);
        // This is a legacy pre-management entry, not a newly authorized enqueue.
        await requireClient().customCommand([
            'LPUSH',
            keys[0],
            JSON.stringify(pending(history.id)),
        ]);
        const drain = new PendingWriteDrain(db, async () => requireClient(), authority);
        expect(await drain.drain()).toEqual({ drained: 1, remaining: 0 });
        const [saved] = await db`SELECT state FROM task_history WHERE id = ${history.id}`;
        expect(saved.state).toBe('active');
        const raw = await requireClient().customCommand(['LINDEX', keys[2], '0']);
        expect(JSON.parse(String(raw))).toMatchObject({
            runId: history.id,
            rejectionReason: 'authority:stale_authority',
        });
    });
});
