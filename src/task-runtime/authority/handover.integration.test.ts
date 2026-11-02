// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../tests/integration/setup/test-database.js';
import type { ValkeyLike } from '../../lib/server/tasks/valkey-types.js';
import {
    installValkeyTaskAuthority,
    quarantineValkeyTaskAuthority,
} from '../../lib/server/tasks/lua/fenced-control.js';
import {
    VALKEY_TASK_AUTHORITY_KEY,
    VALKEY_TASK_MANAGED_KEY,
    invokeFencedValkey,
} from '../../lib/server/tasks/lua/fenced.js';
import { AuthorityStore, type AuthorityToken } from './store.js';
import { withTaskQueueWrite } from './queue-write.js';
import {
    PostgresHandoverStorage,
    TaskHandoverCoordinator,
    type HandoverRequest,
    type HandoverResourceDrain,
} from './handover.js';

const sql = postgres(getTestDatabaseUrl(), { max: 4 });
const store = new AuthorityStore(sql);
const prefix = `handover:${randomUUID()}:`;
const coordinationAuthorityKey = `${prefix}coord:${VALKEY_TASK_AUTHORITY_KEY}`;
const coordinationManagedKey = `${prefix}coord:${VALKEY_TASK_MANAGED_KEY}`;
const cacheAuthorityKey = `${prefix}cache:${VALKEY_TASK_AUTHORITY_KEY}`;
const cacheManagedKey = `${prefix}cache:${VALKEY_TASK_MANAGED_KEY}`;
const queueMutationKey = `${prefix}actual-queue-mutation`;
const retryMutationKey = `${prefix}retry-writes`;
const historyIds = new Set<string>();
let coordinationRedis: IORedis;
let cacheRedis: IORedis;
let coordination: ValkeyLike;
let cache: ValkeyLike;
function client(redis: IORedis, target: 'coord' | 'cache'): ValkeyLike {
    return {
        customCommand: (args): Promise<unknown> =>
            redis.call(
                args[0],
                ...args
                    .slice(1)
                    .map((arg) =>
                        arg === VALKEY_TASK_AUTHORITY_KEY || arg === VALKEY_TASK_MANAGED_KEY
                            ? `${prefix}${target}:${arg}`
                            : arg,
                    ),
            ),
    };
}
async function clean(): Promise<void> {
    // Handover deliberately checks GLOBAL history. Other sequential fixtures can
    // leave accepted pending runs; this closed resource fixture must start with
    // none. The transfer-transaction test below creates fresh nonterminal work
    // after the drain observer and still requires the real guard to reject it.
    await sql`DELETE FROM task_history WHERE state IN ('pending', 'active', 'cancelling')`;
    await sql`DELETE FROM task_runtime_handovers WHERE partition = 'tasks'`;
    await sql`DELETE FROM task_runtime_queue_operations WHERE partition = 'tasks'`;
    await sql`DELETE FROM task_runtime_executions WHERE partition = 'tasks'`;
    await sql`DELETE FROM task_runtime_commands WHERE partition = 'tasks'`;
    await sql`DELETE FROM task_runtime_authorities WHERE partition = 'tasks'`;
    await coordinationRedis.del(
        coordinationAuthorityKey,
        coordinationManagedKey,
        cacheAuthorityKey,
        cacheManagedKey,
        queueMutationKey,
        retryMutationKey,
    );
}
async function fixture(): Promise<{ source: AuthorityToken; request: HandoverRequest }> {
    const source = await store.initialize('tasks', randomUUID(), 'typescript', 120_000);
    const snapshot = await store.getSnapshot(source);
    if (!snapshot) throw new Error('Missing source');
    for (const mirror of [coordination, cache]) {
        await quarantineValkeyTaskAuthority(mirror);
        await installValkeyTaskAuthority(mirror, undefined, snapshot);
    }
    return {
        source,
        request: {
            handoverId: randomUUID(),
            source,
            next: { ownerId: randomUUID(), ownerKind: 'typescript' },
            recovery: false,
            leaseMs: 120_000,
        },
    };
}
/** A known, closed fixture resource set. This is NOT a production raw-plugin drainer. */
function emptyFixtureDrain(queues: readonly Queue[] = []): HandoverResourceDrain {
    return {
        queues: Object.freeze([...queues]),
        verify: async (source): Promise<void> => {
            const rows = await sql`SELECT invocation_id FROM task_runtime_executions
                WHERE partition = ${source.partition} AND generation = ${source.generation}::bigint
                    AND owner_id = ${source.ownerId}`;
            if (rows.length !== 0) throw new Error('Fixture has unregistered resources');
        },
    };
}
function fixtureQueue(): Queue {
    const testCache = process.env.TEST_TASK_CACHE_URL;
    if (!testCache) throw new Error('Explicit isolated TEST_TASK_CACHE_URL required');
    const url = new URL(testCache);
    if (url.protocol !== 'redis:') throw new Error('Isolated plaintext test Valkey required');
    return new Queue(`handover-${randomUUID()}`, {
        connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            db: Number(url.pathname.slice(1)),
            username: url.username ? decodeURIComponent(url.username) : undefined,
            password: url.password ? decodeURIComponent(url.password) : undefined,
        },
        prefix: `${prefix}bull`,
    });
}

function coordinator(
    drain?: HandoverResourceDrain,
    cacheMirror: ValkeyLike | undefined = cache,
): TaskHandoverCoordinator {
    return new TaskHandoverCoordinator(new PostgresHandoverStorage(sql, drain), {
        coordination,
        cache: cacheMirror,
    });
}
async function journalPhase(): Promise<string> {
    const [row] = await sql<
        { phase: string }[]
    >`SELECT phase FROM task_runtime_handovers WHERE partition = 'tasks'`;
    return row.phase;
}

// This inactive authority-pilot fixture requires noeviction for both namespaced mirrors.
// It does not qualify activation on the evictable deployment cache.
describe('serialized PostgreSQL + independent namespaced Valkey mirrors', () => {
    beforeAll(async () => {
        const testCache = process.env.TEST_TASK_CACHE_URL;
        if (!testCache || Number(new URL(testCache).pathname.slice(1)) < 1)
            throw new Error('Explicit isolated TEST_TASK_CACHE_URL required');
        coordinationRedis = new IORedis(testCache);
        cacheRedis = new IORedis(testCache);
        await Promise.all([coordinationRedis.ping(), cacheRedis.ping()]);
        coordination = client(coordinationRedis, 'coord');
        cache = client(cacheRedis, 'cache');
    });
    beforeEach(async () => {
        await clean();
    });
    afterEach(async () => {
        for (const id of historyIds) await sql`DELETE FROM task_history WHERE id = ${id}`;
        historyIds.clear();
    });
    afterAll(async () => {
        if (coordinationRedis && cacheRedis) {
            await clean();
            coordinationRedis.disconnect();
            cacheRedis.disconnect();
        }
        await sql.end();
    });

    it('does not accept durable boolean attestations without an actual registered resource drainer', async () => {
        const { source, request } = await fixture();
        const execution = {
            invocationId: randomUUID(),
            dispatchId: randomUUID(),
            runId: randomUUID(),
            taskId: 'raw-plugin',
        };
        await store.admitExecution(source, execution);
        await store.settleExecution(
            source,
            execution.invocationId,
            { status: 'completed' },
            { dispatchId: execution.dispatchId, quiescent: true },
        );
        await store.beginDrain(source);
        await store.confirmDispatchTeardown(source, execution.dispatchId, {
            processGroupStopped: true,
            sqlConnectionsDrained: true,
        });
        await expect(coordinator().handover(request)).rejects.toMatchObject({
            code: 'not_drained',
        });
        expect((await store.getSnapshot())?.authority).toEqual(source);
        expect(await journalPhase()).toBe('quarantined');
        expect(await coordinationRedis.hget(coordinationAuthorityKey, 'phase')).toBe('quarantined');
        expect(await cacheRedis.hget(cacheAuthorityKey, 'phase')).toBe('quarantined');
    });

    it('observes a real controlled process exit and SQL session disappearance before transfer', async () => {
        const { source, request } = await fixture();
        const execution = {
            invocationId: randomUUID(),
            dispatchId: randomUUID(),
            runId: randomUUID(),
            taskId: 'contained-fixture',
        };
        await store.admitExecution(source, execution);
        await store.settleExecution(
            source,
            execution.invocationId,
            { status: 'completed' },
            { dispatchId: execution.dispatchId, quiescent: true },
        );
        const name = `handover-${randomUUID()}`;
        const resourceSql = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { application_name: name },
        });
        await resourceSql`SELECT 1`;
        const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
            env: {},
            detached: true,
            stdio: 'ignore',
        });
        await once(child, 'spawn');
        let observed = false;
        const drain: HandoverResourceDrain = {
            queues: Object.freeze([]),
            verify: async (original): Promise<void> => {
                expect(original).toEqual(source);
                const [before] = await sql<
                    { count: number }[]
                >`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name = ${name}`;
                expect(before.count).toBe(1);
                const exited = once(child, 'exit');
                child.kill('SIGTERM');
                await exited;
                try {
                    process.kill(-child.pid!, 0);
                    throw new Error('Fixture process group still exists');
                } catch (error) {
                    expect(error).toMatchObject({ code: 'ESRCH' });
                }
                await resourceSql.end();
                const [after] = await sql<
                    { count: number }[]
                >`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name = ${name}`;
                expect(after.count).toBe(0);
                observed = true;
                await store.confirmDispatchTeardown(source, execution.dispatchId, {
                    processGroupStopped: true,
                    sqlConnectionsDrained: true,
                });
            },
        };
        try {
            const result = await coordinator(drain).handover(request);
            expect(observed).toBe(true);
            expect(result.authority).toEqual({
                ...source,
                generation: '2',
                ownerId: request.next.ownerId,
            });
            expect(await journalPhase()).toBe('complete');
            expect(await coordinationRedis.hget(coordinationAuthorityKey, 'generation')).toBe('2');
            expect(await coordinationRedis.get(coordinationManagedKey)).toBe('1');
            expect(await cacheRedis.hget(cacheAuthorityKey, 'generation')).toBe('2');
            expect(await cacheRedis.get(cacheManagedKey)).toBe('1');
        } finally {
            if (child.exitCode === null) child.kill('SIGKILL');
            await resourceSql.end();
        }
    });

    it('keeps the exact source owner when a real queue mutation has an unknown acknowledgment', async () => {
        const { source, request } = await fixture();
        await expect(
            withTaskQueueWrite(sql, source, { kind: 'fixture', queue: 'fixture' }, async () => {
                await coordinationRedis.set(queueMutationKey, 'applied');
                throw new Error('Lost RPC acknowledgment');
            }),
        ).rejects.toThrow('Lost RPC');
        await expect(coordinator(emptyFixtureDrain()).handover(request)).rejects.toMatchObject({
            code: 'not_drained',
        });
        expect(await coordinationRedis.get(queueMutationKey)).toBe('applied');
        expect((await store.getSnapshot())?.authority).toEqual(source);
        expect(await journalPhase()).toBe('quarantined');
    });

    it('restarts after transfer and a lost install ACK, restoring BOTH mirrors from the durable successor', async () => {
        const { source, request } = await fixture();
        let failed = false;
        const loseAck: ValkeyLike = {
            customCommand: async (args): Promise<unknown> => {
                const result = await cache.customCommand(args);
                if (!failed && args[0] === 'EVAL' && args[5] === 'install') {
                    failed = true;
                    throw new Error('Lost mirror install acknowledgment');
                }
                return result;
            },
        };
        await expect(coordinator(emptyFixtureDrain(), loseAck).handover(request)).rejects.toThrow(
            'Lost mirror',
        );
        expect(await journalPhase()).toBe('transferred');
        expect((await store.getSnapshot())?.authority.generation).toBe('2');
        const current = (await store.getSnapshot())!.authority;
        await expect(
            store.admitExecution(current, {
                invocationId: randomUUID(),
                dispatchId: randomUUID(),
                runId: randomUUID(),
                taskId: 'early-successor',
            }),
        ).rejects.toMatchObject({ code: 'not_drained' });
        await expect(
            store.withExistingWrite(current, async (tx) => {
                await tx`UPDATE task_runtime_authorities SET updated_at = to_timestamp(0) WHERE partition = 'tasks'`;
            }),
        ).rejects.toMatchObject({ code: 'not_drained' });
        await expect(
            withTaskQueueWrite(sql, current, { kind: 'early-add', queue: 'fixture' }, async () => {
                await coordinationRedis.set(queueMutationKey, 'early');
            }),
        ).rejects.toMatchObject({ code: 'not_drained' });
        expect(await coordinationRedis.get(queueMutationKey)).toBeNull();
        // A completely lost cache fence is restored only under the journal and DB authority.
        await cacheRedis.del(cacheAuthorityKey, cacheManagedKey);
        const result = await coordinator().handover(request);
        expect(result.authority).toEqual({
            ...source,
            generation: '2',
            ownerId: request.next.ownerId,
        });
        expect(await journalPhase()).toBe('complete');
        expect(await cacheRedis.hget(cacheAuthorityKey, 'ownerId')).toBe(request.next.ownerId);
        await expect(
            coordinator().handover({ ...request, source: { ...source, ownerId: randomUUID() } }),
        ).rejects.toMatchObject({ code: 'stale_authority' });
    });

    it('reconciles interruption while closing, quarantining the other mirror even after a lost first ACK', async () => {
        const { source, request } = await fixture();
        let fail = true;
        const lost: ValkeyLike = {
            customCommand: async (args): Promise<unknown> => {
                const result = await coordination.customCommand(args);
                if (fail && args[0] === 'EVAL' && args[5] === 'quarantine') {
                    fail = false;
                    throw new Error('Lost quarantine acknowledgment');
                }
                return result;
            },
        };
        const interrupted = new TaskHandoverCoordinator(
            new PostgresHandoverStorage(sql, emptyFixtureDrain()),
            {
                coordination: lost,
                cache,
            },
        );
        await expect(interrupted.handover(request)).rejects.toThrow('Lost quarantine');
        expect(await journalPhase()).toBe('closing');
        expect((await store.getSnapshot())?.authority).toEqual(source);
        expect(await cacheRedis.hget(cacheAuthorityKey, 'phase')).toBe('quarantined');
        expect(
            (await coordinator(emptyFixtureDrain()).handover(request)).authority.generation,
        ).toBe('2');
    });

    it('recovers only the exact expired source after both mirrors disappear', async () => {
        const { source, request } = await fixture();
        await sql`UPDATE task_runtime_authorities SET lease_until = clock_timestamp() - interval '1 second' WHERE partition = 'tasks'`;
        await coordinationRedis.del(
            coordinationAuthorityKey,
            coordinationManagedKey,
            cacheAuthorityKey,
            cacheManagedKey,
            queueMutationKey,
        );
        const result = await coordinator(emptyFixtureDrain()).handover({
            ...request,
            recovery: true,
        });
        expect(result.authority).toEqual({
            ...source,
            generation: '2',
            ownerId: request.next.ownerId,
        });
        expect(await journalPhase()).toBe('complete');
        expect(await coordinationRedis.hget(coordinationAuthorityKey, 'ownerId')).toBe(
            request.next.ownerId,
        );
        expect(await cacheRedis.hget(cacheAuthorityKey, 'ownerId')).toBe(request.next.ownerId);
    });

    it('recovers an expired interrupted successor only through explicit qualified newer-generation recovery', async () => {
        const { request } = await fixture();
        let fail = true;
        const lost: ValkeyLike = {
            customCommand: async (args): Promise<unknown> => {
                const result = await cache.customCommand(args);
                if (fail && args[0] === 'EVAL' && args[5] === 'install') {
                    fail = false;
                    throw new Error('Lost install');
                }
                return result;
            },
        };
        await expect(coordinator(emptyFixtureDrain(), lost).handover(request)).rejects.toThrow(
            'Lost install',
        );
        await sql`UPDATE task_runtime_authorities SET lease_until = clock_timestamp() - interval '1 second' WHERE partition = 'tasks'`;
        await expect(coordinator().handover(request)).rejects.toMatchObject({
            code: 'snapshot_conflict',
        });
        const snapshot = await store.getSnapshot();
        expect(snapshot?.authority.generation).toBe('2');
        expect(snapshot?.live).toBe(false);
        expect(await journalPhase()).toBe('transferred');
        expect(await cacheRedis.hget(cacheAuthorityKey, 'phase')).toBe('quarantined');
        if (!snapshot) throw new Error('Missing expired successor');
        const recovery: HandoverRequest = {
            handoverId: randomUUID(),
            source: snapshot.authority,
            next: { ownerId: randomUUID(), ownerKind: 'typescript' },
            recovery: true,
            leaseMs: 120_000,
        };
        await expect(coordinator().handover(recovery)).rejects.toMatchObject({
            code: 'not_drained',
        });
        expect((await store.getSnapshot())?.authority.generation).toBe('2');
        const restored = await coordinator(emptyFixtureDrain()).handover(recovery);
        expect(restored.authority).toEqual({
            ...snapshot.authority,
            generation: '3',
            ownerId: recovery.next.ownerId,
        });
        expect(restored.live).toBe(true);
        expect(await journalPhase()).toBe('complete');
        expect(await cacheRedis.hget(cacheAuthorityKey, 'generation')).toBe('3');
    });

    it('serializes duplicate coordinators and supports a one-connection PostgreSQL pool', async () => {
        const { request } = await fixture();
        const one = postgres(getTestDatabaseUrl(), { max: 1 });
        const two = postgres(getTestDatabaseUrl(), { max: 1 });
        try {
            const create = (pool: postgres.Sql): TaskHandoverCoordinator =>
                new TaskHandoverCoordinator(
                    new PostgresHandoverStorage(pool, emptyFixtureDrain()),
                    { coordination, cache },
                );
            const settled = await Promise.allSettled([
                create(one).handover(request),
                create(two).handover(request),
            ]);
            const results = settled.map((result) => {
                if (result.status === 'rejected') throw result.reason;
                return result.value;
            });
            expect(results[0].authority).toEqual(results[1].authority);
            expect(results[0].authority.generation).toBe('2');
            expect(await journalPhase()).toBe('complete');
        } finally {
            await Promise.all([one.end(), two.end()]);
        }
    });

    it('rolls back the coordinator reserved transaction when the real checkpoint UPDATE raises a SQL error', async () => {
        const { source, request } = await fixture();
        const functionName = `handover_fail_${randomUUID().replaceAll('-', '')}`;
        const triggerName = `handover_trigger_${randomUUID().replaceAll('-', '')}`;
        const dedicated = postgres(getTestDatabaseUrl(), { max: 1 });
        const control = new TaskHandoverCoordinator(
            new PostgresHandoverStorage(dedicated, emptyFixtureDrain()),
            { coordination, cache },
        );
        try {
            await sql`CREATE FUNCTION ${sql(functionName)}() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW.phase = 'transferred' THEN
                        RAISE EXCEPTION 'fixture checkpoint persistence failed';
                    END IF;
                    RETURN NEW;
                END $$`;
            await sql`CREATE TRIGGER ${sql(triggerName)} BEFORE UPDATE ON task_runtime_handovers
                FOR EACH ROW EXECUTE FUNCTION ${sql(functionName)}()`;
            await expect(control.handover(request)).rejects.toThrow(
                'fixture checkpoint persistence failed',
            );
            expect((await store.getSnapshot())?.authority).toEqual(source);
            expect(await journalPhase()).toBe('quarantined');
            await sql`DROP TRIGGER ${sql(triggerName)} ON task_runtime_handovers`;
            await sql`DROP FUNCTION ${sql(functionName)}()`;
            // The exact same one-connection pool must be reusable: aborted
            // transaction cleanup and advisory unlock cannot strand it.
            expect((await control.handover(request)).authority.generation).toBe('2');
        } finally {
            await sql`DROP TRIGGER IF EXISTS ${sql(triggerName)} ON task_runtime_handovers`;
            await sql`DROP FUNCTION IF EXISTS ${sql(functionName)}()`;
            await dedicated.end({ timeout: 0 });
        }
    });

    it('replays a completed handover read-only while successor admission and actual Lua writes remain valid', async () => {
        const { request } = await fixture();
        const completed = await coordinator(emptyFixtureDrain()).handover(request);
        const execution = {
            invocationId: randomUUID(),
            dispatchId: randomUUID(),
            runId: randomUUID(),
            taskId: 'healthy-successor',
        };
        await store.admitExecution(completed.authority, execution);
        const [before] = await sql<
            { updated_at: Date }[]
        >`SELECT updated_at FROM task_runtime_handovers WHERE partition = 'tasks'`;
        const observing = (mirror: ValkeyLike): ValkeyLike => ({
            customCommand: async (args): Promise<unknown> => {
                if (args[0] === 'EVAL' && ['quarantine', 'install'].includes(args[5]))
                    throw new Error('Completed retry attempted an authority mutation');
                await invokeFencedValkey(
                    "return redis.call('INCR', KEYS[1])",
                    [retryMutationKey],
                    [],
                    mirror,
                    completed.authority,
                );
                return mirror.customCommand(args);
            },
        });
        const retry = new TaskHandoverCoordinator(new PostgresHandoverStorage(sql), {
            coordination: observing(coordination),
            cache: observing(cache),
        });
        expect((await retry.handover(request)).authority).toEqual(completed.authority);
        expect(
            (await store.lookupExecution(completed.authority, execution.invocationId))?.state,
        ).toBe('active');
        expect(Number(await coordinationRedis.get(retryMutationKey))).toBeGreaterThanOrEqual(4);
        expect(await coordinationRedis.hget(coordinationAuthorityKey, 'phase')).toBe('active');
        expect(await cacheRedis.hget(cacheAuthorityKey, 'phase')).toBe('active');
        const [after] = await sql<
            { updated_at: Date }[]
        >`SELECT updated_at FROM task_runtime_handovers WHERE partition = 'tasks'`;
        expect(after.updated_at).toEqual(before.updated_at);
    });

    it.each([
        { state: 'waiting', delay: 0 },
        { state: 'delayed', delay: 60000 },
    ])(
        'blocks an accepted real $state job despite settled publication and no execution admission',
        async ({ state, delay }) => {
            const { source, request } = await fixture();
            const queue = fixtureQueue();
            const control = coordinator(emptyFixtureDrain([queue]));
            try {
                const job = await withTaskQueueWrite(
                    sql,
                    source,
                    { kind: 'fixture-add', queue: queue.name },
                    () => queue.add('accepted-source-work', {}, { jobId: randomUUID(), delay }),
                );
                expect(await job.getState()).toBe(state);
                const [pending] = await sql<{ count: number }[]>`SELECT count(*)::integer AS count
                    FROM task_runtime_queue_operations WHERE partition = 'tasks' AND state = 'pending'`;
                expect(pending.count).toBe(0);
                await expect(control.handover(request)).rejects.toMatchObject({
                    code: 'not_drained',
                });
                expect((await store.getSnapshot())?.authority).toEqual(source);
                expect((await store.getDrainProof(source)).dispatchIds).toEqual([]);
                await withTaskQueueWrite(
                    sql,
                    source,
                    { kind: 'fixture-cancel', queue: queue.name, jobId: job.id },
                    () => job.remove(),
                    { allowDraining: true },
                );
                expect((await control.handover(request)).authority.generation).toBe('2');
            } finally {
                await queue.obliterate({ force: true });
                await queue.close();
            }
        },
    );

    it('requires an empty paused roster queue to resume before handover', async () => {
        const { source, request } = await fixture();
        const queue = fixtureQueue();
        const control = coordinator(emptyFixtureDrain([queue]));
        try {
            await queue.pause();
            await expect(control.handover(request)).rejects.toMatchObject({ code: 'not_drained' });
            expect((await store.getSnapshot())?.authority).toEqual(source);
            await queue.resume();
            expect((await control.handover(request)).authority.generation).toBe('2');
        } finally {
            await queue.obliterate({ force: true });
            await queue.close();
        }
    });

    it('rechecks global nonterminal history in the actual transfer transaction', async () => {
        const { source, request } = await fixture();
        const runId = randomUUID();
        historyIds.add(runId);
        // Create after the process observer, so only the final locked transfer
        // guard can discover the newly visible accepted pending run.
        let inserted = false;
        const drain: HandoverResourceDrain = {
            queues: Object.freeze([]),
            verify: async (): Promise<void> => {
                if (inserted) return;
                inserted = true;
                await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version)
                VALUES (${runId}, 'handover-history-fixture', 'fixture', 'pending', '{}', '{"kind":"manual"}', '{"type":"system"}', 1)`;
            },
        };
        const control = coordinator(drain);
        await expect(control.handover(request)).rejects.toMatchObject({ code: 'not_drained' });
        expect((await store.getSnapshot())?.authority).toEqual(source);
        expect(await journalPhase()).toBe('quarantined');
        await store.withExistingWrite(source, async (tx) => {
            await tx`UPDATE task_history SET state = 'cancelled', completed_at = clock_timestamp() WHERE id = ${runId}`;
        });
        expect((await control.handover(request)).authority.generation).toBe('2');
    });

    it('rejects a CACHE policy observation that reports eviction without advancing source', async () => {
        const { source, request } = await fixture();
        const unsafeCache: ValkeyLike = {
            customCommand: (args): Promise<unknown> =>
                args[0] === 'CONFIG'
                    ? Promise.resolve(['maxmemory-policy', 'allkeys-lru'])
                    : cache.customCommand(args),
        };
        await expect(
            coordinator(emptyFixtureDrain(), unsafeCache).handover(request),
        ).rejects.toMatchObject({ code: 'unsafe_eviction' });
        expect((await store.getSnapshot())?.authority).toEqual(source);
    });

    it('transfers with the task Valkey as the ONLY mirror (production: no cache mirror)', async () => {
        const { source, request } = await fixture();
        // The deployment cache is allkeys-lru and never holds fence keys; a
        // handover must not require it (assertNoEviction would always refuse).
        const result = await coordinator(emptyFixtureDrain(), undefined).handover(request);
        expect(result.authority).toEqual({
            ...source,
            generation: '2',
            ownerId: request.next.ownerId,
        });
        expect(await coordinationRedis.hget(coordinationAuthorityKey, 'generation')).toBe('2');
        expect(await coordinationRedis.get(coordinationManagedKey)).toBe('1');
    });
});
