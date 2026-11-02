// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { AuthorityStore, type AuthorityToken } from '../../../task-runtime/authority/store.js';
import { RunLivenessAuthority } from './run-liveness-authority.js';
import { HardKill, HARD_KILL_QUEUE_PENDING_CODE } from './hard-kill.js';
import { QueueOperationUncertainError } from '../../../task-runtime/authority/queue-write.js';
import { identityKey } from './identity.js';
import { luaLoader } from './lua/loader.js';
import { queryCancelGraceCandidateIds } from './run-liveness-authority.js';
import { OrphanSweep } from './orphan-sweep.js';
import { StateMachine } from './state-machine.js';
import { PendingWriteDrain } from './pending-write-drain.js';
import { LeaderLock } from './leader-lock.js';
import { taskJobId } from '../../../task-runtime/authority/queue-origin.js';
import { TaskRegistry } from './registry.js';
import { requireClient, type ValkeyLike } from './valkey-types.js';
import { quarantineValkeyTaskAuthority, installValkeyTaskAuthority } from './lua/fenced-control.js';
import { VALKEY_TASK_AUTHORITY_KEY, VALKEY_TASK_MANAGED_KEY } from './lua/fenced.js';
import type { Queue } from 'bullmq';

const sql = postgres(getTestDatabaseUrl(), { max: 3 });
const store = new AuthorityStore(sql);
const owners = new Set<string>();
const runIds: string[] = [];
const keys = new Set<string>([VALKEY_TASK_AUTHORITY_KEY, VALKEY_TASK_MANAGED_KEY]);
function ownerId(): string {
    const id = randomUUID();
    owners.add(id);
    return id;
}
function key(value: string): string {
    keys.add(value);
    return value;
}
async function initialize(): Promise<AuthorityToken> {
    return store.initialize('tasks', ownerId(), 'typescript');
}
// Explicit journal fixture isolates participating mutation fences; the
// coordinator's real mirror/process handover is tested in its own suite.
async function transfer(original: AuthorityToken): Promise<AuthorityToken> {
    await store.beginDrain(original);
    const nextOwner = ownerId();
    const handoverId = randomUUID();
    await sql`INSERT INTO task_runtime_handovers
        (partition, handover_id, source_generation, source_owner_id, next_owner_id, next_owner_kind, recovery, phase)
        VALUES (${original.partition}, ${handoverId}, ${original.generation}::bigint,
            ${original.ownerId}, ${nextOwner}, 'typescript', false, 'quarantined')`;
    return store.handoffWithCheckpoint(
        original,
        { ownerId: nextOwner, ownerKind: 'typescript' },
        { generation: original.generation, dispatchIds: [] },
        30_000,
        async (tx) => {
            await tx`UPDATE task_runtime_handovers SET phase = 'complete'
            WHERE handover_id = ${handoverId}`;
        },
        false,
        handoverId,
    );
}
async function install(authority: AuthorityToken, previous?: AuthorityToken): Promise<void> {
    const client = requireClient();
    await quarantineValkeyTaskAuthority(client, previous);
    await installValkeyTaskAuthority(client, previous, {
        authority,
        phase: 'active',
        leaseUntilMs: Date.now() + 30_000,
    });
}
async function run(state: 'active' | 'cancelling' = 'active'): Promise<string> {
    const id = randomUUID();
    runIds.push(id);
    await sql`INSERT INTO task_history
        (id, task_id, label, state, input, trigger, actor, processing_version,
         started_at, heartbeat_at, owner_instance_id)
        VALUES (${id}, 'recovery-fence-fixture', 'recovery-fence-fixture', ${state},
            '{}', '{"kind":"manual"}', '{"type":"system"}', 1,
            NOW() - interval '1 hour', NOW() - interval '1 hour', 'fixture')`;
    return id;
}
function recovery(
    authority?: AuthorityToken,
    getClient = async (): Promise<ValkeyLike> => requireClient(),
): RunLivenessAuthority {
    return new RunLivenessAuthority(
        sql,
        new StateMachine(() => requireClient(), authority),
        getClient,
        undefined,
        new TaskRegistry(),
        false,
        undefined,
        undefined,
        undefined,
        authority,
    );
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('recovery mutation boundaries retain the operation origin', () => {
    beforeAll(async () => {
        await connectValkey();
        await luaLoader.load();
    });
    afterEach(async () => {
        vi.useRealTimers();
        for (const id of owners) {
            await sql`DELETE FROM task_runtime_handovers WHERE source_owner_id = ${id} OR next_owner_id = ${id}`;
            await sql`DELETE FROM task_runtime_queue_operations WHERE owner_id = ${id}`;
            await sql`DELETE FROM task_runtime_authorities WHERE partition = 'tasks' AND owner_id = ${id}`;
        }
        await requireClient().customCommand(['DEL', ...keys]);
        owners.clear();
    });
    afterAll(async () => {
        for (const id of runIds) await sql`DELETE FROM task_history WHERE id = ${id}`;
        await sql.end();
        await disconnectValkey();
    });

    it('keeps unmanaged recovery working before management exists', async () => {
        const id = await run();
        const report = await recovery().reclaimStaleRuns([id], 'unmanaged');
        expect(report.reclaimed).toBe(1);
        const [saved] = await sql`SELECT state FROM task_history WHERE id = ${id}`;
        expect(saved.state).toBe('failed');
        key(`task:run:terminal:${id}`);
    });

    it('rejects stale and unbound SQL reclaim after management, including a mutated caller token', async () => {
        const id = await run();
        const original = await initialize();
        const stale = recovery(original);
        const successor = await transfer(original);
        // Mutating a caller-owned object cannot reauthorize an old reclaimer.
        Object.assign(original, successor);
        expect((await stale.reclaimStaleRuns([id], 'stale')).reclaimed).toBe(0);
        expect((await recovery().reclaimStaleRuns([id], 'unbound')).reclaimed).toBe(0);
        const [saved] = await sql`SELECT state, completed_at FROM task_history WHERE id = ${id}`;
        expect(saved).toMatchObject({ state: 'active', completed_at: null });
    });

    it('rejects old terminal-hash writes and active-hash deletion when handoff happens after SQL reclaim', async () => {
        const id = await run();
        const original = await initialize();
        await install(original);
        const entered = deferred();
        const release = deferred();
        let calls = 0;
        const reclaimer = recovery(original, async () => {
            calls++;
            // First lookup classifies; the second is the actual terminal write,
            // after the original SQL mutation has committed.
            if (calls === 2) {
                entered.resolve();
                await release.promise;
            }
            return requireClient();
        });
        const reclaim = reclaimer.reclaimStaleRuns([id], 'handoff-between-stores');
        await entered.promise;
        const successor = await transfer(original);
        await install(successor, original);
        const active = key(`task:run:active:${id}`);
        const terminal = key(`task:run:terminal:${id}`);
        await requireClient().customCommand([
            'HSET',
            active,
            'state',
            'active',
            'generation',
            successor.generation,
        ]);
        release.resolve();
        await reclaim;
        expect(await requireClient().customCommand(['EXISTS', terminal])).toBe(0);
        expect(await requireClient().customCommand(['HGET', active, 'generation'])).toBe(
            successor.generation,
        );
    });

    it('rejects stale and tokenless shared-counter reconciliation inside the actual Lua invocation', async () => {
        const original = await initialize();
        await install(original);
        const registry = new TaskRegistry();
        const taskId = `counter-${randomUUID()}`;
        vi.spyOn(registry, 'getAllTasks').mockReturnValue([
            { id: taskId, quotas: { maxConcurrent: 8 } },
        ] as ReturnType<TaskRegistry['getAllTasks']>);
        const active = key(`task:active-count:${taskId}`);
        const budget = key('task:resource-budget:io');
        await requireClient().customCommand(['SET', active, '7']);
        await requireClient().customCommand(['SET', budget, '6']);
        const successor = await transfer(original);
        await install(successor, original);
        for (const origin of [original, undefined]) {
            const reclaimer = new RunLivenessAuthority(
                sql,
                new StateMachine(() => requireClient(), origin),
                async () => requireClient(),
                undefined,
                registry,
                true,
                undefined,
                undefined,
                undefined,
                origin,
            );
            await reclaimer.sweepStaleCounters();
        }
        expect(await requireClient().customCommand(['GET', active])).toBe('7');
        expect(await requireClient().customCommand(['GET', budget])).toBe('6');
    });

    it('retains the scheduling authority and rejects late hard-kill mutations', async () => {
        const id = await run('cancelling');
        const original = await initialize();
        await install(original);
        const client = requireClient();
        const queueLookup = vi.fn<() => Queue | undefined>(() => undefined);
        const hardKill = new HardKill(
            () => sql,
            queueLookup,
            () => client,
            new StateMachine(() => client, original),
            async () => null,
            undefined,
            original,
        );
        const execution = hardKill.execute.bind(hardKill);
        let attempted: Promise<unknown> | undefined;
        vi.spyOn(hardKill, 'execute').mockImplementation((...args) => {
            const result = execution(...args);
            attempted = result;
            return result;
        });
        const successor = await transfer(original);
        await install(successor, original);
        Object.assign(original, successor);
        // The constructor captured generation 1 even though the supplied object changed.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        hardKill.schedule(id, 10);
        await vi.advanceTimersByTimeAsync(11);
        vi.useRealTimers();
        expect(attempted).toBeDefined();
        await expect(attempted).rejects.toThrow('TASK_AUTHORITY_STALE');
        expect(queueLookup).not.toHaveBeenCalled();
        const [saved] = await sql`SELECT state, completed_at FROM task_history WHERE id = ${id}`;
        expect(saved).toMatchObject({ state: 'cancelling', completed_at: null });
    });

    it.each(['missing-token', 'uncertain-rpc'] as const)(
        'keeps managed hard-kill history retryable when cleanup has %s',
        async (failure) => {
            const id = await run('cancelling');
            const original = await initialize();
            await install(original);
            const client = requireClient();
            const base = 'recovery-fence-fixture~~global';
            const jobId = taskJobId(`${base}#${id}`, original);
            const active = key(`task:run:active:${id}`);
            const terminal = key(`task:run:terminal:${id}`);
            const identity = key(identityKey('recovery-fence-fixture', base));
            await client.customCommand(['HSET', active, 'state', 'cancelling']);
            await client.customCommand(['SET', identity, id]);
            const moveToFailed = vi.fn(async () => {
                throw new Error('queue reply lost');
            });
            const job = {
                id: jobId,
                data: { taskAuthority: original },
                getState: async () => 'active',
                token: failure === 'uncertain-rpc' ? 'worker-token' : undefined,
                moveToFailed,
            };
            const queue = { name: 'io', getJob: async () => job } as unknown as Queue;
            const hardKill = new HardKill(
                () => sql,
                () => queue,
                () => client,
                new StateMachine(() => client, original),
                async () => jobId,
                undefined,
                original,
            );
            if (failure === 'missing-token') {
                await expect(hardKill.execute(id)).rejects.toMatchObject({ code: 'not_drained' });
                expect(moveToFailed).not.toHaveBeenCalled();
            } else {
                await expect(hardKill.execute(id)).rejects.toBeInstanceOf(
                    QueueOperationUncertainError,
                );
                expect(moveToFailed).toHaveBeenCalledTimes(1);
                expect(
                    await sql`SELECT operation_id FROM task_runtime_queue_operations
                    WHERE owner_id = ${original.ownerId} AND state = 'pending'`,
                ).toHaveLength(1);
            }
            const [history] = await sql`SELECT state, completed_at, cancel_requested_at, error
                FROM task_history WHERE id = ${id}`;
            expect(history).toMatchObject({
                state: 'cancelling',
                completed_at: null,
                error: { code: HARD_KILL_QUEUE_PENDING_CODE },
            });
            expect(history.cancel_requested_at).not.toBeNull();
            expect(await queryCancelGraceCandidateIds(sql, 0)).toContain(id);
            expect(await client.customCommand(['GET', identity])).toBe(id);
            expect(await client.customCommand(['HGET', active, 'hardKillQueuePending'])).toBe('1');
            expect(await client.customCommand(['EXISTS', terminal])).toBe(0);
        },
    );

    it('settles managed history only after an acknowledged queue cleanup and blocks observer terminals while pending', async () => {
        const id = await run('cancelling');
        const original = await initialize();
        await install(original);
        const client = requireClient();
        const base = 'recovery-fence-fixture~~acknowledged';
        const jobId = taskJobId(`${base}#${id}`, original);
        const active = key(`task:run:active:${id}`);
        const terminal = key(`task:run:terminal:${id}`);
        const identity = key(identityKey('recovery-fence-fixture', base));
        await client.customCommand(['HSET', active, 'state', 'cancelling']);
        await client.customCommand(['SET', identity, id]);
        const stateMachine = new StateMachine(() => client, original);
        const moveToFailed = vi.fn(async () => {
            const [duringRpc] =
                await sql`SELECT state, completed_at, error FROM task_history WHERE id = ${id}`;
            expect(duringRpc).toMatchObject({
                state: 'cancelling',
                completed_at: null,
                error: { code: HARD_KILL_QUEUE_PENDING_CODE },
            });
            // A failure observer's cancelling->cancelled fallback must also
            // lose against the private marker before the RPC ACK exists.
            expect(
                await stateMachine.transitionRun({
                    runId: id,
                    from: 'cancelling',
                    to: 'cancelled',
                }),
            ).toMatchObject({ ok: false, error: 'hard kill queue cleanup pending' });
        });
        const job = {
            id: jobId,
            data: { taskAuthority: original },
            getState: async () => 'active',
            token: 'worker-token',
            moveToFailed,
        };
        const queue = { name: 'io', getJob: async () => job } as unknown as Queue;
        const hardKill = new HardKill(
            () => sql,
            () => queue,
            () => client,
            stateMachine,
            async () => jobId,
            undefined,
            original,
        );
        expect(await hardKill.execute(id)).toEqual({ killed: true, method: 'bullmq' });
        const [history] = await sql`SELECT state, completed_at FROM task_history WHERE id = ${id}`;
        expect(history.state).toBe('cancelled');
        expect(history.completed_at).not.toBeNull();
        expect(await client.customCommand(['GET', identity])).toBeNull();
        expect(await client.customCommand(['EXISTS', active])).toBe(0);
        expect(await client.customCommand(['HGET', terminal, 'hardKillQueuePending'])).toBe('0');
        expect(await client.customCommand(['HGET', terminal, 'hardKillAuthorityGeneration'])).toBe(
            original.generation,
        );
        expect(
            await sql`SELECT operation_id FROM task_runtime_queue_operations
            WHERE owner_id = ${original.ownerId} AND state = 'pending'`,
        ).toHaveLength(0);
    });

    it('stops a stale drainer before claiming or acknowledging lists, while the successor quarantines the original entry', async () => {
        const id = await run();
        const original = await initialize();
        await install(original);
        const pending = key('task:pending-writes');
        const processing = key('task:pending-writes:processing');
        const poison = key('task:pending-writes:poison');
        const entry = {
            kind: 'update' as const,
            runId: id,
            authority: original,
            payload: { state: 'completed' as const },
            enqueuedAt: Date.now(),
        };
        const stale = new PendingWriteDrain(sql, async () => requireClient(), original);
        await stale.enqueue(entry);
        const enqueueEntered = deferred();
        const enqueueRelease = deferred();
        const delayedEnqueuer = new PendingWriteDrain(
            sql,
            async () => {
                enqueueEntered.resolve();
                await enqueueRelease.promise;
                return requireClient();
            },
            original,
        );
        const deferredEntry = { ...entry, authority: { ...original } };
        const delayedEnqueue = delayedEnqueuer.enqueue(deferredEntry);
        await enqueueEntered.promise;
        const successor = await transfer(original);
        await install(successor, original);
        Object.assign(deferredEntry.authority, successor);
        enqueueRelease.resolve();
        await delayedEnqueue;
        expect(await requireClient().customCommand(['LLEN', pending])).toBe(1);

        await expect(stale.drain()).rejects.toThrow('TASK_AUTHORITY_STALE');
        expect(await requireClient().customCommand(['LLEN', pending])).toBe(1);
        expect(await requireClient().customCommand(['LLEN', processing])).toBe(0);
        // A tokenless enqueue cannot borrow this bound drainer's authority.
        const next = new PendingWriteDrain(sql, async () => requireClient(), successor);
        await next.enqueue({ ...entry, authority: undefined });
        expect(await requireClient().customCommand(['LLEN', pending])).toBe(1);
        expect(await next.drain()).toEqual({ drained: 1, remaining: 0 });
        const rejected = JSON.parse(
            String(await requireClient().customCommand(['LINDEX', poison, '0'])),
        );
        expect(rejected).toMatchObject({
            authority: original,
            rejectionReason: 'authority:stale_authority',
        });
        const [saved] = await sql`SELECT state FROM task_history WHERE id = ${id}`;
        expect(saved.state).toBe('active');
    });

    it('fences leadership acquire/renew/release and fails verification closed after handoff', async () => {
        const original = await initialize();
        await install(original);
        const lockKey = key(`lock:orch:fence-${randomUUID()}`);
        const lock = new LeaderLock(
            requireClient(),
            lockKey,
            'same-holder',
            30_000,
            10_000,
            original,
        );
        expect(await lock.acquire()).toBe(true);
        lock.stop();
        const successor = await transfer(original);
        await install(successor, original);
        await requireClient().customCommand(['SET', lockKey, 'same-holder', 'PX', '15000']);
        expect(await lock.verifyHeld()).toBe(false);
        await expect(lock.renew()).rejects.toThrow('TASK_AUTHORITY_STALE');
        await expect(lock.acquire()).rejects.toThrow('TASK_AUTHORITY_STALE');
        await lock.release();
        expect(await requireClient().customCommand(['GET', lockKey])).toBe('same-holder');
        const unbound = new LeaderLock(requireClient(), lockKey, 'same-holder', 30_000, 10_000);
        expect(await unbound.verifyHeld()).toBe(false);
    });

    it('rejects stale orphan queue RPC before it mutates BullMQ', async () => {
        const original = await initialize();
        const moveToCompleted = vi.fn(async () => undefined);
        const jobId = taskJobId(`orphan#${randomUUID()}`, original);
        const queue = {
            name: 'io',
            getJobs: async () => [
                { id: jobId, name: 'fixture', data: { taskAuthority: original }, moveToCompleted },
            ],
        } as unknown as Queue;
        const dependency = key(`bull:task:cpu:missing-${randomUUID()}`);
        const deps = key(`bull:task:io:${jobId}:dependencies`);
        await requireClient().customCommand(['SADD', deps, dependency]);
        const sweep = new OrphanSweep(
            (cls) => (cls === 'io' ? queue : undefined),
            async () => requireClient(),
            undefined,
            original,
            () => sql,
        );
        await transfer(original);
        expect((await sweep.run()).swept).toBe(0);
        expect(moveToCompleted).not.toHaveBeenCalled();
        expect(
            await sql`SELECT operation_id FROM task_runtime_queue_operations WHERE owner_id = ${original.ownerId}`,
        ).toHaveLength(0);
    });
});
