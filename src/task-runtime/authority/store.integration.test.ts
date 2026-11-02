// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../tests/integration/setup/test-database.js';
import {
    AuthorityError,
    AuthorityStore,
    type AuthorityToken,
    type ExecutionAdmission,
} from './store.js';

const prefix = `fence-${randomUUID()}`;
const pools: postgres.Sql[] = [];
function connection(): postgres.Sql {
    const sql = postgres(getTestDatabaseUrl(), { max: 1 });
    pools.push(sql);
    return sql;
}
const db = connection();
const store = new AuthorityStore(db);
async function owner(leaseMs = 30_000): Promise<AuthorityToken> {
    return store.initialize(`${prefix}:${randomUUID()}`, randomUUID(), 'typescript', leaseMs);
}
function admission(): ExecutionAdmission {
    return {
        invocationId: randomUUID(),
        dispatchId: randomUUID(),
        runId: randomUUID(),
        taskId: 'ordinary-sdk-task',
    };
}
async function changedAt(token: AuthorityToken): Promise<number> {
    const [row] = await db<
        { updated_at: Date }[]
    >`SELECT updated_at FROM task_runtime_authorities WHERE partition = ${token.partition}`;
    return row.updated_at.getTime();
}

describe('durable task authority (real PostgreSQL)', () => {
    beforeAll(async () => {
        const [row] = await db`SELECT to_regclass('task_runtime_authorities') AS table_name`;
        expect(row.table_name).toBe('task_runtime_authorities');
    });
    afterAll(async () => {
        await db`DELETE FROM task_runtime_executions WHERE starts_with(partition, ${prefix})`;
        await db`DELETE FROM task_runtime_commands WHERE starts_with(partition, ${prefix})`;
        await db`DELETE FROM task_runtime_authorities WHERE starts_with(partition, ${prefix})`;
        await Promise.all(pools.map((sql) => sql.end()));
    });

    it('initializes once and never silently resets an existing generation', async () => {
        const token = await owner();
        expect(token.generation).toBe('1');
        await expect(store.initialize(token.partition, randomUUID(), 'rust')).rejects.toMatchObject(
            { code: 'conflict' },
        );
        await store.assertCurrent(token);
    });

    it('rejects malformed generations as validation errors before invoking a writer', async () => {
        const token = await owner();
        let invoked = false;
        await expect(
            store.withExistingWrite({ ...token, generation: 'invalid' }, async () => {
                invoked = true;
            }),
        ).rejects.toMatchObject({ name: 'ZodError' });
        expect(invoked).toBe(false);
        await store.assertCurrent(token);
    });

    it('serializes duplicate commands on independent connections and returns the original durable receipt', async () => {
        const token = await owner();
        const commandId = randomUUID();
        let calls = 0;
        const stores = [new AuthorityStore(connection()), new AuthorityStore(connection())];
        const results = await Promise.all(
            stores.map((other) =>
                other.withMutation(
                    token,
                    commandId,
                    { operation: 'fixture', b: 2, a: 1 },
                    async (tx) => {
                        calls++;
                        await tx`UPDATE task_runtime_authorities SET updated_at = to_timestamp(0) WHERE partition = ${token.partition}`;
                        await tx`SELECT pg_sleep(0.05)`;
                        return { applied: true };
                    },
                ),
            ),
        );
        expect(calls).toBe(1);
        expect(results[0]).toEqual(results[1]);
        expect(await changedAt(token)).toBe(0);
        expect(await store.lookupReceipt(token.partition, commandId)).toEqual(results[0]);
        await expect(
            store.withMutation(token, commandId, { a: 1, b: 3 }, async () => null),
        ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('canonicalizes object keys but rejects changed commands and non-JSON payloads', async () => {
        const token = await owner();
        const id = randomUUID();
        await store.withMutation(token, id, { a: 1, b: { c: 2 } }, async () => 'first');
        expect(
            (await store.withMutation(token, id, { b: { c: 2 }, a: 1 }, async () => 'wrong'))
                .result,
        ).toBe('first');
        await expect(
            store.withMutation(token, randomUUID(), { value: Number.NaN }, async () => null),
        ).rejects.toBeInstanceOf(AuthorityError);
    });

    it('rejects sparse arrays before mutation and preserves JSON null receipts and outcomes', async () => {
        const token = await owner();
        let called = false;
        const sparse = new Array<null>(1);
        await expect(
            store.withMutation(token, randomUUID(), sparse, async () => {
                called = true;
                return null;
            }),
        ).rejects.toMatchObject({ code: 'invalid' });
        expect(called).toBe(false);
        for (const payload of [null, true, 42, 'text', [null], { value: null }]) {
            const id = randomUUID();
            const result = await store.withMutation(token, id, payload, async () => null);
            expect(result.result).toBeNull();
            expect(await store.lookupReceipt(token.partition, id)).toEqual(result);
            const [row] = await db<
                { sql_null: boolean; kind: string }[]
            >`SELECT result IS NULL AS sql_null, jsonb_typeof(result) AS kind FROM task_runtime_commands WHERE partition = ${token.partition} AND command_id = ${id}`;
            expect(row).toEqual({ sql_null: false, kind: 'null' });
        }
        const execution = admission();
        await store.admitExecution(token, execution);
        await store.settleExecution(token, execution.invocationId, null, {
            dispatchId: execution.dispatchId,
            quiescent: true,
        });
        const [row] = await db<
            { state: string; sql_null: boolean; kind: string }[]
        >`SELECT state, outcome IS NULL AS sql_null, jsonb_typeof(outcome) AS kind FROM task_runtime_executions WHERE partition = ${token.partition} AND invocation_id = ${execution.invocationId}`;
        expect(row).toEqual({ state: 'settled', sql_null: false, kind: 'null' });
    });

    it('rolls back the mutation and its receipt together on failure', async () => {
        const token = await owner();
        const id = randomUUID();
        const initial = await changedAt(token);
        await expect(
            store.withMutation(token, id, {}, async (tx) => {
                await tx`UPDATE task_runtime_authorities SET updated_at = to_timestamp(0) WHERE partition = ${token.partition}`;
                throw new Error('fixture failure');
            }),
        ).rejects.toThrow('fixture failure');
        expect(await changedAt(token)).toBe(initial);
        expect(await store.lookupReceipt(token.partition, id)).toBeNull();
    });

    it('rolls back a callback that outlives the database-clock lease', async () => {
        const token = await owner(300);
        const id = randomUUID();
        await expect(
            store.withMutation(token, id, {}, async (tx) => {
                await tx`UPDATE task_runtime_authorities SET updated_at = to_timestamp(0) WHERE partition = ${token.partition}`;
                await tx`SELECT pg_sleep(0.4)`;
                return 'too late';
            }),
        ).rejects.toMatchObject({ code: 'stale_authority' });
        expect(await changedAt(token)).toBeGreaterThan(0);
        expect(await store.lookupReceipt(token.partition, id)).toBeNull();
        await expect(store.renew(token)).rejects.toMatchObject({ code: 'stale_authority' });
    });

    it('recovers a lost admission acknowledgement without executing the same dispatch twice', async () => {
        const token = await owner();
        const execution = admission();
        await store.admitExecution(token, execution); // Deliberately discard acknowledgment.
        expect(await store.lookupExecution(token, execution.invocationId)).toEqual({
            state: 'active',
            dispatchId: execution.dispatchId,
            outcome: null,
        });
        await expect(store.admitExecution(token, execution)).rejects.toMatchObject({
            code: 'conflict',
        });
        await expect(
            store.admitExecution(token, { ...execution, invocationId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'conflict' });
    });

    it('drains admissions atomically and refuses handoff while any invocation remains live', async () => {
        const token = await owner();
        const execution = admission();
        await store.admitExecution(token, execution);
        await store.beginDrain(token);
        const attempts = await Promise.allSettled(
            Array.from({ length: 5 }, () =>
                new AuthorityStore(connection()).admitExecution(token, admission()),
            ),
        );
        expect(
            attempts.every(
                (result) =>
                    result.status === 'rejected' &&
                    result.reason instanceof AuthorityError &&
                    result.reason.code === 'draining',
            ),
        ).toBe(true);
        await expect(
            store.handoff(
                token,
                { ownerId: randomUUID(), ownerKind: 'rust' },
                { generation: '1', dispatchIds: [execution.dispatchId] },
            ),
        ).rejects.toMatchObject({ code: 'not_drained' });
        // A logical task cancellation cannot release this barrier. Only the
        // caller's positively confirmed quiescence/dispatch receipt can settle.
        expect((await store.lookupExecution(token, execution.invocationId))?.state).toBe('active');
    });

    it('requires bound teardown evidence, increments generations, and rejects late executor completions', async () => {
        const token = await owner();
        const execution = admission();
        await store.admitExecution(token, execution);
        await store.beginDrain(token);
        await expect(
            store.settleExecution(
                token,
                execution.invocationId,
                { ok: true },
                { dispatchId: randomUUID(), quiescent: true },
            ),
        ).rejects.toMatchObject({ code: 'conflict' });
        await store.settleExecution(
            token,
            execution.invocationId,
            { ok: true },
            { dispatchId: execution.dispatchId, quiescent: true },
        );
        await expect(
            store.handoff(
                token,
                { ownerId: randomUUID(), ownerKind: 'rust' },
                { generation: '1', dispatchIds: [] },
            ),
        ).rejects.toMatchObject({ code: 'not_drained' });
        await expect(
            store.handoff(
                token,
                { ownerId: randomUUID(), ownerKind: 'rust' },
                { generation: '1', dispatchIds: [execution.dispatchId] },
            ),
        ).rejects.toMatchObject({ code: 'not_drained' });
        await expect(
            store.confirmDispatchTeardown(token, randomUUID(), {
                processGroupStopped: true,
                sqlConnectionsDrained: true,
            }),
        ).rejects.toMatchObject({ code: 'not_drained' });
        await store.confirmDispatchTeardown(token, execution.dispatchId, {
            processGroupStopped: true,
            sqlConnectionsDrained: true,
        });
        const native = await store.handoff(
            token,
            { ownerId: randomUUID(), ownerKind: 'rust' },
            { generation: '1', dispatchIds: [execution.dispatchId] },
        );
        expect(native.generation).toBe('2');
        await expect(
            store.settleExecution(
                token,
                execution.invocationId,
                { late: true },
                { dispatchId: execution.dispatchId, quiescent: true },
            ),
        ).rejects.toMatchObject({ code: 'conflict' });
        await expect(
            store.withMutation(token, randomUUID(), {}, async () => 'stale'),
        ).rejects.toMatchObject({ code: 'stale_authority' });
        await store.beginDrain(native);
        const compatibility = await store.handoff(
            native,
            { ownerId: randomUUID(), ownerKind: 'typescript' },
            { generation: '2', dispatchIds: [] },
        );
        expect(compatibility.generation).toBe('3');
        await store.assertCurrent(compatibility);
    });

    it('returns committed receipts after handoff without replaying stale writes', async () => {
        const token = await owner();
        const id = randomUUID();
        const accepted = await store.withMutation(
            token,
            id,
            { operation: 'fixture' },
            async () => ({ ok: true }),
        );
        await store.beginDrain(token);
        await store.handoff(
            token,
            { ownerId: randomUUID(), ownerKind: 'typescript' },
            { generation: token.generation, dispatchIds: [] },
        );
        expect(
            await store.withMutation(token, id, { operation: 'fixture' }, async () => {
                throw new Error('must not replay');
            }),
        ).toEqual(accepted);
        expect(await store.lookupReceipt(token.partition, id)).toEqual(accepted);
    });

    it('holds the generation fence across a real concurrent SQL mutation and drain', async () => {
        const token = await owner();
        let entered!: () => void;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const wait = new Promise<void>((resolve) => {
            release = resolve;
        });
        const mutation = new AuthorityStore(connection()).withMutation(
            token,
            randomUUID(),
            {},
            async (tx) => {
                entered();
                await wait;
                await tx`UPDATE task_runtime_authorities SET updated_at = to_timestamp(0) WHERE partition = ${token.partition}`;
                return { committed: true };
            },
        );
        await ready;
        let drained = false;
        const drain = new AuthorityStore(connection()).beginDrain(token).then(() => {
            drained = true;
        });
        // Verify at the database seam: the other connection really is waiting
        // for our lock, rather than relying on a scheduler/timing assumption.
        let blocked = false;
        const deadline = Date.now() + 2_000;
        while (!blocked && Date.now() < deadline) {
            const [row] = await db<{ blocked: boolean }[]>`SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                AND wait_event_type = 'Lock' AND query LIKE '%task_runtime_authorities%'
            ) AS blocked`;
            blocked = row.blocked;
            if (!blocked) await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        if (!blocked) {
            release();
            await mutation;
            await drain;
        }
        expect(blocked).toBe(true);
        expect(drained).toBe(false);
        release();
        expect((await mutation).result).toEqual({ committed: true });
        await drain;
        await expect(store.admitExecution(token, admission())).rejects.toMatchObject({
            code: 'draining',
        });
    });
    it('checks lease time after waiting for a row lock, rather than before', async () => {
        const token = await owner(300);
        let entered!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const holder = connection().begin(async (tx) => {
            await tx`SELECT partition FROM task_runtime_authorities WHERE partition = ${token.partition} FOR UPDATE`;
            entered();
            await tx`SELECT pg_sleep(0.4)`;
        });
        await ready;
        const rejected = expect(
            new AuthorityStore(connection()).assertCurrent(token),
        ).rejects.toMatchObject({ code: 'stale_authority' });
        await holder;
        await rejected;
    });

    it('rejects live handoff if its lease expires while waiting to read execution teardown', async () => {
        const token = await owner(2_000);
        await store.beginDrain(token);
        const blocker = connection();
        const contender = connection();
        const [{ pid: blockerPid }] = await blocker<
            { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        const [{ pid: contenderPid }] = await contender<
            { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        let entered!: () => void;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const holder = blocker.begin(async (tx) => {
            await tx`LOCK TABLE task_runtime_executions IN ACCESS EXCLUSIVE MODE`;
            entered();
            await held;
        });
        await ready;
        const handoff = new AuthorityStore(contender)
            .handoff(
                token,
                { ownerId: randomUUID(), ownerKind: 'typescript' },
                { generation: token.generation, dispatchIds: [] },
            )
            .then(
                (authority) => ({ authority, error: null }),
                (error: unknown) => ({ authority: null, error }),
            );
        try {
            // This relation-lock wait proves handoff passed its initial live
            // authority check and is blocked in the subsequent executions read.
            await expect
                .poll(async () => {
                    const [row] = await db<
                        { blocked: boolean }[]
                    >`SELECT ${blockerPid} = ANY(pg_blocking_pids(${contenderPid})) AS blocked`;
                    return row.blocked;
                })
                .toBe(true);
            await expect
                .poll(
                    async () => {
                        const [row] = await db<
                            { expired: boolean }[]
                        >`SELECT lease_until <= clock_timestamp() AS expired FROM task_runtime_authorities WHERE partition = ${token.partition}`;
                        return row.expired;
                    },
                    { timeout: 5_000 },
                )
                .toBe(true);
        } finally {
            release();
            await holder;
        }
        const result = await handoff;
        expect(result.authority).toBeNull();
        expect(result.error).toBeInstanceOf(AuthorityError);
        expect(result.error).toMatchObject({ code: 'stale_authority' });
        const [row] = await db<{ generation: string; owner_id: string; phase: string }[]>`
            SELECT generation::text, owner_id, phase FROM task_runtime_authorities
            WHERE partition = ${token.partition}
        `;
        expect(row).toEqual({
            generation: token.generation,
            owner_id: token.ownerId,
            phase: 'draining',
        });
    });

    it('permits expired recovery only after every dispatch has confirmed teardown and only to TypeScript', async () => {
        const token = await owner();
        const execution = admission();
        await store.admitExecution(token, execution);
        await db`UPDATE task_runtime_authorities SET lease_until = clock_timestamp() - interval '1 second' WHERE partition = ${token.partition}`;
        await expect(store.renew(token)).rejects.toMatchObject({ code: 'stale_authority' });
        const next = { ownerId: randomUUID(), ownerKind: 'typescript' as const };
        const proof = { generation: token.generation, dispatchIds: [execution.dispatchId] };
        await expect(
            store.confirmExpiredTeardown(token, execution.invocationId, {
                dispatchId: execution.dispatchId,
                quiescent: true,
            }),
        ).rejects.toMatchObject({ code: 'not_drained' });
        await store.beginDrain(token);
        await expect(store.recoverDrained(token, next, proof)).rejects.toMatchObject({
            code: 'not_drained',
        });
        await expect(
            store.confirmExpiredTeardown(
                { ...token, ownerId: randomUUID() },
                execution.invocationId,
                { dispatchId: execution.dispatchId, quiescent: true },
            ),
        ).rejects.toMatchObject({ code: 'stale_authority' });
        await expect(
            store.settleExecution(
                token,
                execution.invocationId,
                { success: true },
                { dispatchId: execution.dispatchId, quiescent: true },
            ),
        ).rejects.toMatchObject({ code: 'stale_authority' });
        await store.confirmExpiredTeardown(token, execution.invocationId, {
            dispatchId: execution.dispatchId,
            quiescent: true,
        });
        expect((await store.lookupExecution(token, execution.invocationId))?.outcome).toEqual({
            status: 'unknown',
            reason: 'owner_lease_expired',
        });
        await expect(store.recoverDrained(token, next, proof)).rejects.toMatchObject({
            code: 'not_drained',
        });
        await store.confirmDispatchTeardown(token, execution.dispatchId, {
            processGroupStopped: true,
            sqlConnectionsDrained: true,
        });
        const recovered = await store.recoverDrained(token, next, proof);
        expect(recovered.generation).toBe('2');
        await store.assertExecutorAdmissionReady(recovered);
        await expect(store.recoverDrained(token, next, proof)).rejects.toMatchObject({
            code: 'stale_authority',
        });
    });

    it('uses the actual durable owner kind to refuse production Rust executor admission', async () => {
        const token = await owner();
        await store.assertExecutorAdmissionReady(token);
        await store.beginDrain(token);
        const native = await store.handoff(
            token,
            { ownerId: randomUUID(), ownerKind: 'rust' },
            { generation: token.generation, dispatchIds: [] },
        );
        await expect(store.assertExecutorAdmissionReady(native)).rejects.toMatchObject({
            code: 'activation_blocked',
        });
        await expect(
            store.assertExecutorAdmissionReady({ ...native, generation: token.generation }),
        ).rejects.toMatchObject({ code: 'stale_authority' });
    });
    it('replays a committed settlement ACK read-only after expiry and handoff, rejecting changed outcomes', async () => {
        const token = await owner();
        const execution = admission();
        await store.admitExecution(token, execution);
        await store.settleExecution(
            token,
            execution.invocationId,
            { a: 1, b: 2 },
            { dispatchId: execution.dispatchId, quiescent: true },
        );
        const [before] = await db<
            { settled_at: Date }[]
        >`SELECT settled_at FROM task_runtime_executions WHERE partition = ${token.partition} AND invocation_id = ${execution.invocationId}`;
        await db`UPDATE task_runtime_authorities SET lease_until = clock_timestamp() - interval '1 second' WHERE partition = ${token.partition}`;
        await store.settleExecution(
            token,
            execution.invocationId,
            { b: 2, a: 1 },
            { dispatchId: execution.dispatchId, quiescent: true },
        );
        await expect(
            store.settleExecution(
                token,
                execution.invocationId,
                { a: 2, b: 2 },
                { dispatchId: execution.dispatchId, quiescent: true },
            ),
        ).rejects.toMatchObject({ code: 'conflict' });
        await expect(
            store.settleExecution(
                token,
                execution.invocationId,
                { a: 1, b: 2 },
                { dispatchId: randomUUID(), quiescent: true },
            ),
        ).rejects.toMatchObject({ code: 'conflict' });
        await store.beginDrain(token);
        await store.confirmDispatchTeardown(token, execution.dispatchId, {
            processGroupStopped: true,
            sqlConnectionsDrained: true,
        });
        await store.recoverDrained(
            token,
            { ownerId: randomUUID(), ownerKind: 'typescript' },
            { generation: token.generation, dispatchIds: [execution.dispatchId] },
        );
        await store.settleExecution(
            token,
            execution.invocationId,
            { a: 1, b: 2 },
            { dispatchId: execution.dispatchId, quiescent: true },
        );
        const [after] = await db<
            { settled_at: Date }[]
        >`SELECT settled_at FROM task_runtime_executions WHERE partition = ${token.partition} AND invocation_id = ${execution.invocationId}`;
        expect(after.settled_at).toEqual(before.settled_at);
    });

    it('admits one active invocation per run across independent executor connections', async () => {
        const token = await owner();
        const first = admission();
        const second = { ...admission(), runId: first.runId };
        const stores = [new AuthorityStore(connection()), new AuthorityStore(connection())];
        const results = await Promise.allSettled([
            stores[0].admitExecution(token, first),
            stores[1].admitExecution(token, second),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect(rejected?.status === 'rejected' ? rejected.reason : null).toMatchObject({
            code: 'conflict',
        });
        const rows = await db<
            { invocation_id: string; dispatch_id: string }[]
        >`SELECT invocation_id, dispatch_id FROM task_runtime_executions WHERE partition = ${token.partition} AND generation = ${token.generation}::bigint AND run_id = ${first.runId} AND state = 'active'`;
        expect(rows).toHaveLength(1);
        await store.settleExecution(
            token,
            rows[0].invocation_id,
            { done: true },
            { dispatchId: rows[0].dispatch_id, quiescent: true },
        );
        await store.admitExecution(token, { ...admission(), runId: first.runId });
    });

    it.each(['commit', 'rollback'] as const)(
        'reconciles uncertain admission only after the prior transaction resolves: %s',
        async (decision) => {
            const token = await owner();
            const execution = admission();
            expect(
                await store.reconcileExecutionAdmission(token, execution.invocationId),
            ).toBeNull();
            let entered!: () => void;
            let release!: () => void;
            const ready = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const wait = new Promise<void>((resolve) => {
                release = resolve;
            });
            const rollback = new Error('rollback uncertain admission');
            const admissionTransaction = connection()
                .begin(async (tx) => {
                    await tx`SELECT partition FROM task_runtime_authorities WHERE partition = ${token.partition} FOR UPDATE`;
                    await tx`INSERT INTO task_runtime_executions (partition, invocation_id, generation, owner_id, dispatch_id, run_id, task_id, state) VALUES (${token.partition}, ${execution.invocationId}, ${token.generation}::bigint, ${token.ownerId}, ${execution.dispatchId}, ${execution.runId}, ${execution.taskId}, 'active')`;
                    entered();
                    await wait;
                    if (decision === 'rollback') throw rollback;
                })
                .catch((error: unknown) => {
                    if (error !== rollback) throw error;
                });
            await ready;
            let resolved = false;
            const reconcile = new AuthorityStore(connection())
                .reconcileExecutionAdmission(token, execution.invocationId)
                .then((record) => {
                    resolved = true;
                    return record;
                });
            let blocked = false;
            const deadline = Date.now() + 2_000;
            try {
                while (!blocked && Date.now() < deadline) {
                    const [row] = await db<
                        { blocked: boolean }[]
                    >`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%task_runtime_authorities%') AS blocked`;
                    blocked = row.blocked;
                    if (!blocked) await new Promise<void>((resolve) => setTimeout(resolve, 10));
                }
                expect(blocked).toBe(true);
                expect(resolved).toBe(false);
            } finally {
                release();
                await admissionTransaction;
            }
            const record = await reconcile;
            expect(record).toEqual(
                decision === 'commit' ? { ...execution, state: 'active', outcome: null } : null,
            );
            if (decision === 'commit') {
                await store.settleExecution(
                    token,
                    execution.invocationId,
                    { ok: true },
                    { dispatchId: execution.dispatchId, quiescent: true },
                );
                expect(
                    await store.reconcileExecutionAdmission(token, execution.invocationId),
                ).toEqual({ ...execution, state: 'settled', outcome: { ok: true } });
            }
        },
    );
});
