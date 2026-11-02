// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ValkeyLike } from '../../lib/server/tasks/valkey-types.js';
import { configValue } from '../../lib/server/cache/task-valkey-guard.js';
import {
    installValkeyTaskAuthority,
    quarantineValkeyTaskAuthority,
    type ValkeyTaskAuthoritySnapshot,
} from '../../lib/server/tasks/lua/fenced-control.js';
import {
    captureValkeyAuthority,
    VALKEY_TASK_AUTHORITY_KEY,
    VALKEY_TASK_MANAGED_KEY,
} from '../../lib/server/tasks/lua/fenced.js';
import type postgres from 'postgres';
import type { Queue } from 'bullmq';
import {
    AuthorityError,
    AuthorityStore,
    type AuthorityOwnerKind,
    type AuthorityToken,
} from './store.js';

export interface HandoverRequest {
    handoverId: string;
    source: AuthorityToken;
    next: { ownerId: string; ownerKind: AuthorityOwnerKind };
    recovery: boolean;
    leaseMs?: number;
}
export interface HandoverCheckpoint {
    request: HandoverRequest;
    phase: 'closing' | 'quarantined' | 'transferred' | 'complete';
}
export interface HandoverSnapshot extends ValkeyTaskAuthoritySnapshot {
    ownerKind: AuthorityOwnerKind;
    live: boolean;
}
/**
 * Trusted storage/control-plane port, never an executor/plugin RPC contract.
 * The implementation must serialize ALL management changes (including direct
 * Store transfers and initialization) for the duration of serialized(). Each
 * checkpoint is durable, and advance() commits ownership plus 'transferred' in
 * ONE PostgreSQL transaction. A failed/unknown queue operation remains a barrier.
 */
export interface HandoverSession {
    /** Create or recover the exact request; mismatched source/target/id rejects. */
    open(
        request: HandoverRequest,
        quarantineInterruptedRecovery?: () => Promise<void>,
    ): Promise<HandoverCheckpoint>;
    closeAdmissions(checkpoint: HandoverCheckpoint): Promise<void>;
    snapshot(): Promise<HandoverSnapshot>;
    /**
     * Must perform actual process containment and SQL drain observation for all
     * registered original-owner resources, not trust execution-row booleans.
     * Missing resources/unknown containment blocks. This is deliberately a hook
     * to audited supervisor infrastructure, not a caller-supplied proof object.
     */
    verifyResourceTeardown(checkpoint: HandoverCheckpoint): Promise<void>;
    /** Checks settled invocations, exact dispatch set and durable queue barriers. */
    assertDrained(checkpoint: HandoverCheckpoint): Promise<readonly string[]>;
    markQuarantined(checkpoint: HandoverCheckpoint): Promise<void>;
    advance(
        checkpoint: HandoverCheckpoint,
        dispatchIds: readonly string[],
    ): Promise<HandoverSnapshot>;
    /** Rechecks source resources, queue barriers and both-mirror verification. */
    complete(checkpoint: HandoverCheckpoint): Promise<void>;
}
export interface HandoverStorage {
    serialized<T>(partition: string, work: (session: HandoverSession) => Promise<T>): Promise<T>;
}
export interface HandoverMirrors {
    /** The task Valkey (TASK_CACHE_URL): the only instance holding fence keys. */
    coordination: ValkeyLike;
    /**
     * An optional SECOND noeviction mirror. Never the deployment cache
     * (CACHE_URL): it is allkeys-lru by design, so assertNoEviction would always
     * refuse it, and the fence keys (`task:runtime:*`) route to the task Valkey
     * anyway — the cache never holds a fence to quarantine.
     */
    cache?: ValkeyLike;
}
export class HandoverError extends Error {
    constructor(
        public readonly code:
            | 'invalid'
            | 'mirror_conflict'
            | 'mirror_unavailable'
            | 'unsafe_eviction'
            | 'snapshot_conflict',
    ) {
        super(`Task handover: ${code}`);
        this.name = 'HandoverError';
    }
}
function string(value: unknown): string | undefined {
    return typeof value === 'string'
        ? value
        : Buffer.isBuffer(value)
          ? value.toString('utf8')
          : undefined;
}
function same(a: AuthorityToken, b: AuthorityToken): boolean {
    return a.partition === b.partition && a.generation === b.generation && a.ownerId === b.ownerId;
}
function nextToken(request: HandoverRequest): AuthorityToken {
    return {
        partition: request.source.partition,
        generation: (BigInt(request.source.generation) + 1n).toString(),
        ownerId: request.next.ownerId,
    };
}
function copyRequest(request: HandoverRequest): HandoverRequest {
    const source = captureValkeyAuthority(request.source);
    if (!source) throw new HandoverError('invalid');
    const next = captureValkeyAuthority(nextToken(request));
    if (
        !source ||
        !next ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            request.handoverId,
        ) ||
        !['typescript', 'rust'].includes(request.next.ownerKind) ||
        typeof request.recovery !== 'boolean' ||
        (request.recovery && request.next.ownerKind !== 'typescript') ||
        (request.leaseMs !== undefined &&
            (!Number.isInteger(request.leaseMs) ||
                request.leaseMs < 100 ||
                request.leaseMs > 300_000))
    )
        throw new HandoverError('invalid');
    return Object.freeze({
        ...request,
        source,
        next: Object.freeze({ ...request.next }),
    });
}
/** Fail closed if CONFIG permission is unavailable on any mirror. */
async function assertNoEviction(client: ValkeyLike): Promise<void> {
    // configValue also reads GLIDE's GlideRecord ([{ key, value }]) form.
    const reply = await client.customCommand(['CONFIG', 'GET', 'maxmemory-policy']);
    if (configValue(reply, 'maxmemory-policy') !== 'noeviction')
        throw new HandoverError('unsafe_eviction');
}
interface MirrorState {
    token: AuthorityToken | undefined;
    phase: string | undefined;
    leaseUntilMs: string | undefined;
    managed: string | undefined;
}
async function readMirror(client: ValkeyLike): Promise<MirrorState> {
    // One Lua read avoids a torn authority/managed observation.
    const reply = await client.customCommand([
        'EVAL',
        `local a = redis.call('HMGET', KEYS[1], 'generation', 'ownerId', 'phase', 'leaseUntilMs')
         return {a[1] or '', a[2] or '', a[3] or '', a[4] or '', redis.call('GET', KEYS[2]) or ''}`,
        '2',
        VALKEY_TASK_AUTHORITY_KEY,
        VALKEY_TASK_MANAGED_KEY,
    ]);
    if (!Array.isArray(reply) || reply.length !== 5) throw new HandoverError('mirror_unavailable');
    const [generation, ownerId, phase, leaseUntilMs, managed] = reply.map(string);
    if (generation === undefined || ownerId === undefined || phase === undefined)
        throw new HandoverError('mirror_unavailable');
    let token: AuthorityToken | undefined;
    if (generation !== '' || ownerId !== '') {
        try {
            token = captureValkeyAuthority({ partition: 'tasks', generation, ownerId });
        } catch {
            throw new HandoverError('mirror_conflict');
        }
    }
    return { token, phase, leaseUntilMs, managed };
}
function assertSnapshot(snapshot: HandoverSnapshot, expected: AuthorityToken): void {
    if (
        !same(snapshot.authority, expected) ||
        !['active', 'draining'].includes(snapshot.phase) ||
        !Number.isSafeInteger(snapshot.leaseUntilMs) ||
        snapshot.leaseUntilMs <= 0
    )
        throw new HandoverError('snapshot_conflict');
}

async function verifyMirrors(
    clients: readonly ValkeyLike[],
    snapshot: HandoverSnapshot,
): Promise<void> {
    for (const client of clients) {
        const mirror = await readMirror(client);
        if (
            !mirror.token ||
            !same(mirror.token, snapshot.authority) ||
            mirror.managed !== '1' ||
            mirror.phase !== snapshot.phase ||
            mirror.leaseUntilMs !== String(snapshot.leaseUntilMs)
        )
            throw new HandoverError('mirror_conflict');
    }
}

/**
 * Inactive control-plane coordinator. It does not select a runtime or start a
 * consumer. Startup must await this reconciliation before allowing unmanaged or
 * managed writers; total mirror loss never authorizes unbound compatibility.
 * Every retry uses the durable journal and original owner, including after a
 * lost transfer/install acknowledgment. There is no "force" or boolean proof.
 */
export class TaskHandoverCoordinator {
    constructor(
        private readonly storage: HandoverStorage,
        private readonly mirrors: HandoverMirrors,
    ) {}

    async handover(input: HandoverRequest): Promise<HandoverSnapshot> {
        const request = copyRequest(input);
        return this.storage.serialized(request.source.partition, async (session) => {
            const successor = nextToken(request);
            const clients = [
                ...new Set(
                    this.mirrors.cache
                        ? [this.mirrors.coordination, this.mirrors.cache]
                        : [this.mirrors.coordination],
                ),
            ];
            await Promise.all(clients.map(assertNoEviction));
            const quarantineAll = async (expected: AuthorityToken): Promise<void> => {
                // Attempt BOTH even when the first acknowledgment is uncertain.
                const results = await Promise.allSettled(
                    clients.map(async (client) => {
                        const mirror = await readMirror(client);
                        if (
                            mirror.token &&
                            !same(mirror.token, expected) &&
                            !same(mirror.token, request.source) &&
                            !(
                                mirror.managed === '1' &&
                                BigInt(mirror.token.generation) < BigInt(request.source.generation)
                            )
                        )
                            throw new HandoverError('mirror_conflict');
                        await quarantineValkeyTaskAuthority(client, mirror.token);
                    }),
                );
                const failure = results.find((result) => result.status === 'rejected');
                if (failure?.status === 'rejected') throw failure.reason;
            };
            const checkpoint = await session.open(request, () => quarantineAll(request.source));
            if (checkpoint.phase === 'closing' || checkpoint.phase === 'quarantined')
                await session.closeAdmissions(checkpoint);
            let snapshot = await session.snapshot();
            assertSnapshot(
                snapshot,
                checkpoint.phase === 'transferred' || checkpoint.phase === 'complete'
                    ? successor
                    : request.source,
            );
            if (checkpoint.phase === 'complete') {
                // The successor may already be executing. Receipt replay only
                // observes it; it must never transiently revoke its mirrors.
                if (
                    !snapshot.live ||
                    snapshot.phase !== 'active' ||
                    snapshot.ownerKind !== request.next.ownerKind
                )
                    throw new HandoverError('snapshot_conflict');
                await verifyMirrors(clients, snapshot);
                const current = await session.snapshot();
                assertSnapshot(current, successor);
                if (
                    !current.live ||
                    current.phase !== snapshot.phase ||
                    current.ownerKind !== snapshot.ownerKind ||
                    current.leaseUntilMs !== snapshot.leaseUntilMs
                )
                    throw new HandoverError('snapshot_conflict');
                return current;
            }
            await quarantineAll(snapshot.authority);
            if (checkpoint.phase === 'closing') await session.markQuarantined(checkpoint);
            if (checkpoint.phase === 'closing' || checkpoint.phase === 'quarantined') {
                await session.verifyResourceTeardown(checkpoint);
                const dispatchIds = await session.assertDrained(checkpoint);
                snapshot = await session.advance(checkpoint, dispatchIds);
                assertSnapshot(snapshot, successor);
            }
            // Re-read durable authority after an uncertain/slow checkpoint. No
            // supplied lease or mirror is the source for an installed snapshot.
            snapshot = await session.snapshot();
            assertSnapshot(snapshot, successor);
            if (!snapshot.live || snapshot.ownerKind !== request.next.ownerKind)
                throw new HandoverError('snapshot_conflict');
            for (const client of clients) {
                const prior = await readMirror(client);
                if (prior.phase !== 'quarantined') throw new HandoverError('mirror_conflict');
                await installValkeyTaskAuthority(client, prior.token, snapshot);
            }
            await verifyMirrors(clients, snapshot);
            await session.complete(checkpoint);
            return snapshot;
        });
    }
}

interface JournalRow {
    partition: string;
    handover_id: string;
    source_generation: string;
    source_owner_id: string;
    next_owner_id: string;
    next_owner_kind: AuthorityOwnerKind;
    recovery: boolean;
    lease_ms: number;
    phase: HandoverCheckpoint['phase'];
}
function matchesJournal(row: JournalRow, request: HandoverRequest): boolean {
    return (
        row.partition === request.source.partition &&
        row.handover_id === request.handoverId &&
        row.source_generation === request.source.generation &&
        row.source_owner_id === request.source.ownerId &&
        row.next_owner_id === request.next.ownerId &&
        row.next_owner_kind === request.next.ownerKind &&
        row.recovery === request.recovery &&
        row.lease_ms === (request.leaseMs ?? 30_000)
    );
}
export interface HandoverResourceDrain {
    /** Complete, known queue roster after producer registration is closed.
     * Storage snapshots this array at construction. Empty is valid only for a
     * qualified closed resource set known to own no queues (e.g. a fixture). */
    readonly queues: readonly Queue[];
    /**
     * Audited implementation must close/reconcile producer RPCs, stop the actual
     * original-owner contained processes, revoke reconnect ability and observe
     * their database sessions drained. It must reject missing/unknown resources.
     * The existing guardian alone cannot qualify escaped descendants or plugins
     * holding a shared raw SQL role. Do not install a no-op production adapter.
     */
    verify(source: Readonly<AuthorityToken>): Promise<void>;
}

/**
 * Real PostgreSQL journal adapter. One reserved connection owns the session
 * lock and every short transaction. No default drainer exists: ordinary SDK raw
 * SQL/process capabilities cannot currently satisfy this boundary. Passing a
 * drainer is a trusted control-plane dependency, not an untrusted proof claim.
 * Supply a dedicated control-plane pool: an uncertain cleanup destroys the
 * pool rather than returning a session that may still own an advisory lock.
 * No runtime boot path instantiates this adapter or activates a new consumer.
 */
const QUEUE_DRAIN_CHECK_TIMEOUT_MS = 5_000;

export class PostgresHandoverStorage implements HandoverStorage {
    private readonly queues: readonly Queue[] | undefined;

    constructor(
        private readonly sql: postgres.Sql,
        private readonly resourceDrain?: HandoverResourceDrain,
    ) {
        if (resourceDrain && !Array.isArray(resourceDrain.queues))
            throw new HandoverError('invalid');
        this.queues = resourceDrain ? Object.freeze([...resourceDrain.queues]) : undefined;
    }

    /** Never call while holding the authority row lock: these are Valkey RPCs. */
    private async assertQueuesDrained(): Promise<void> {
        const queues = this.queues;
        if (!queues) throw new AuthorityError('not_drained');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const check = this.checkQueuesDrained(queues);
        // An unanswered count is not evidence of an empty queue.
        check.catch(() => {});
        try {
            await Promise.race([
                check,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new AuthorityError('not_drained')),
                        QUEUE_DRAIN_CHECK_TIMEOUT_MS,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async checkQueuesDrained(queues: readonly Queue[]): Promise<void> {
        for (const queue of queues) {
            const counts = await queue.getJobCounts(
                'waiting',
                'delayed',
                'active',
                'prioritized',
                'waiting-children',
            );
            // BullMQ 6 no longer exposes 'paused' as a public JobType. Refuse
            // any paused queue, including an empty one, via the supported API.
            if (await queue.isPaused()) throw new AuthorityError('not_drained');
            for (const state of [
                'waiting',
                'delayed',
                'active',
                'prioritized',
                'waiting-children',
            ]) {
                const count = counts[state];
                if (!Number.isSafeInteger(count) || count !== 0)
                    throw new AuthorityError('not_drained');
            }
        }
    }

    private async assertHistoryDrained(tx: postgres.Sql): Promise<void> {
        // The task_history_state_check constraint makes this the complement of
        // the terminal states; it matches idx_task_history_state's predicate.
        const rows = await tx`SELECT id FROM task_history
            WHERE state IN ('pending', 'active', 'cancelling') LIMIT 1`;
        if (rows.length !== 0) throw new AuthorityError('not_drained');
    }

    async serialized<T>(
        partition: string,
        work: (session: HandoverSession) => Promise<T>,
    ): Promise<T> {
        if (partition !== 'tasks') throw new HandoverError('invalid');
        const reserved = await this.sql.reserve();
        let locked = false;
        let needsRollback = false;
        let outcome: { ok: true; value: T } | { ok: false; error: unknown };
        try {
            await reserved`SELECT pg_advisory_lock(hashtextextended(${`task-runtime-handover:${partition}`}, 0))`;
            locked = true;
            const [{ pid: lockPid }] = await reserved<
                { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            const assertSession = async (): Promise<void> => {
                const [{ pid }] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                if (pid !== lockPid) throw new AuthorityError('conflict');
            };
            // postgres.js reserve() deliberately omits runtime begin(), even
            // though ReservedSql extends Sql in its types. Explicit tagged
            // transaction commands are supported on a reserved connection.
            let transactionOpen = false;
            const begin = async <T>(
                work: (tx: postgres.TransactionSql) => Promise<T>,
            ): Promise<T> => {
                if (transactionOpen) throw new HandoverError('invalid');
                transactionOpen = true;
                try {
                    await assertSession();
                    await reserved`BEGIN`;
                    needsRollback = true;
                    const result = await work(reserved as unknown as postgres.TransactionSql);
                    await assertSession();
                    await reserved`COMMIT`;
                    await assertSession();
                    needsRollback = false;
                    return result;
                } catch (error) {
                    try {
                        // A failed SQL statement aborts the transaction: even
                        // pg_backend_pid() would fail until ROLLBACK executes.
                        await reserved`ROLLBACK`;
                        needsRollback = false;
                        await assertSession();
                    } catch {
                        // Lost COMMIT acknowledgment remains UNKNOWN; never
                        // retry the mutation on another pooled connection.
                    }
                    throw error;
                } finally {
                    transactionOpen = false;
                }
            };
            const transactional = new Proxy(reserved, {
                get: (target, property, receiver): unknown =>
                    property === 'begin' ? begin : Reflect.get(target, property, receiver),
            });
            const store = new AuthorityStore(transactional);
            const readJournal = async (): Promise<JournalRow | undefined> => {
                await assertSession();
                const [row] = await reserved<JournalRow[]>`
                    SELECT partition, handover_id, source_generation::text, source_owner_id,
                        next_owner_id, next_owner_kind, recovery, lease_ms, phase
                    FROM task_runtime_handovers WHERE partition = ${partition}
                `;
                return row;
            };
            const assertJournal = async (checkpoint: HandoverCheckpoint): Promise<JournalRow> => {
                const row = await readJournal();
                if (!row || !matchesJournal(row, checkpoint.request))
                    throw new AuthorityError('conflict');
                return row;
            };
            const snapshot = async (): Promise<HandoverSnapshot> => {
                await assertSession();
                const current = await store.getSnapshot();
                await assertSession();
                if (!current) throw new AuthorityError('stale_authority');
                return current;
            };
            const session: HandoverSession = {
                open: async (
                    request,
                    quarantineInterruptedRecovery,
                ): Promise<HandoverCheckpoint> => {
                    let interrupted: JournalRow | undefined;
                    const writeJournal = async (tx: postgres.TransactionSql): Promise<void> => {
                        await tx`INSERT INTO task_runtime_handovers
                            (partition, handover_id, source_generation, source_owner_id,
                             next_owner_id, next_owner_kind, recovery, lease_ms, phase)
                            VALUES (${partition}, ${request.handoverId}, ${request.source.generation}::bigint,
                                ${request.source.ownerId}, ${request.next.ownerId}, ${request.next.ownerKind},
                                ${request.recovery}, ${request.leaseMs ?? 30_000}, 'closing')
                            ON CONFLICT (partition) DO UPDATE SET
                                handover_id = EXCLUDED.handover_id,
                                source_generation = EXCLUDED.source_generation,
                                source_owner_id = EXCLUDED.source_owner_id,
                                next_owner_id = EXCLUDED.next_owner_id,
                                next_owner_kind = EXCLUDED.next_owner_kind,
                                recovery = EXCLUDED.recovery, lease_ms = EXCLUDED.lease_ms,
                                phase = 'closing', updated_at = clock_timestamp()`;
                    };
                    await begin(async (tx) => {
                        await assertSession();
                        // Same row-lock order as Store.transfer.
                        const [owner] = await tx<
                            { generation: string; owner_id: string; live: boolean }[]
                        >`
                            SELECT generation::text, owner_id, lease_until > clock_timestamp() AS live
                            FROM task_runtime_authorities WHERE partition = ${partition} FOR UPDATE`;
                        const [row] = await tx<JournalRow[]>`
                            SELECT partition, handover_id, source_generation::text, source_owner_id,
                                next_owner_id, next_owner_kind, recovery, lease_ms, phase
                            FROM task_runtime_handovers WHERE partition = ${partition} FOR UPDATE`;
                        if (row && matchesJournal(row, request)) return;
                        if (
                            !owner ||
                            owner.generation !== request.source.generation ||
                            owner.owner_id !== request.source.ownerId
                        )
                            throw new AuthorityError('stale_authority');
                        if (row && row.phase !== 'complete') {
                            if (
                                row.phase !== 'transferred' ||
                                !request.recovery ||
                                request.next.ownerKind !== 'typescript' ||
                                owner.live ||
                                (BigInt(row.source_generation) + 1n).toString() !==
                                    owner.generation ||
                                row.next_owner_id !== owner.owner_id
                            )
                                throw new AuthorityError('conflict');
                            // An expired, never-admitted successor is not revived.
                            // Preserve its old journal until its own actual resource
                            // observer and durable queue/execution barriers succeed.
                            await tx`UPDATE task_runtime_authorities SET phase = 'draining', updated_at = clock_timestamp()
                                WHERE partition = ${partition}`;
                            interrupted = row;
                            return;
                        }
                        await writeJournal(tx);
                    });
                    if (interrupted) {
                        if (!quarantineInterruptedRecovery) throw new AuthorityError('not_drained');
                        await quarantineInterruptedRecovery();
                        if (!this.resourceDrain) throw new AuthorityError('not_drained');
                        await this.resourceDrain.verify(request.source);
                        await this.assertQueuesDrained();
                        const prior = interrupted;
                        await begin(async (tx) => {
                            await assertSession();
                            const [owner] = await tx<
                                {
                                    generation: string;
                                    owner_id: string;
                                    phase: string;
                                    live: boolean;
                                }[]
                            >`
                                SELECT generation::text, owner_id, phase, lease_until > clock_timestamp() AS live
                                FROM task_runtime_authorities WHERE partition = ${partition} FOR UPDATE`;
                            const [row] = await tx<JournalRow[]>`
                                SELECT partition, handover_id, source_generation::text, source_owner_id,
                                    next_owner_id, next_owner_kind, recovery, lease_ms, phase
                                FROM task_runtime_handovers WHERE partition = ${partition} FOR UPDATE`;
                            if (
                                !owner ||
                                owner.generation !== request.source.generation ||
                                owner.owner_id !== request.source.ownerId ||
                                owner.live ||
                                owner.phase !== 'draining' ||
                                !row ||
                                row.phase !== 'transferred' ||
                                row.handover_id !== prior.handover_id ||
                                row.source_generation !== prior.source_generation ||
                                row.next_owner_id !== request.source.ownerId
                            )
                                throw new AuthorityError('conflict');
                            const pending =
                                await tx`SELECT operation_id FROM task_runtime_queue_operations
                                WHERE partition = ${partition} AND state = 'pending' LIMIT 1`;
                            const unsettled =
                                await tx`SELECT invocation_id FROM task_runtime_executions
                                WHERE partition = ${partition} AND generation = ${request.source.generation}::bigint
                                    AND (state <> 'settled' OR NOT process_group_stopped OR NOT sql_connections_drained OR teardown_at IS NULL)
                                LIMIT 1`;
                            if (pending.length !== 0 || unsettled.length !== 0)
                                throw new AuthorityError('not_drained');
                            await this.assertHistoryDrained(tx);
                            await writeJournal(tx);
                        });
                    }
                    const row = await readJournal();
                    if (!row || !matchesJournal(row, request)) throw new AuthorityError('conflict');
                    return { request, phase: row.phase };
                },
                closeAdmissions: async (checkpoint): Promise<void> => {
                    await assertJournal(checkpoint);
                    await store.beginDrain(checkpoint.request.source);
                },
                snapshot,
                verifyResourceTeardown: async (checkpoint): Promise<void> => {
                    await assertJournal(checkpoint);
                    if (!this.resourceDrain) throw new AuthorityError('not_drained');
                    await this.resourceDrain.verify(checkpoint.request.source);
                },
                assertDrained: async (checkpoint): Promise<readonly string[]> => {
                    await assertJournal(checkpoint);
                    return (await store.getDrainProof(checkpoint.request.source)).dispatchIds;
                },
                markQuarantined: async (checkpoint): Promise<void> => {
                    await assertJournal(checkpoint);
                    const rows = await reserved`UPDATE task_runtime_handovers
                        SET phase = 'quarantined', updated_at = clock_timestamp()
                        WHERE partition = ${partition} AND handover_id = ${checkpoint.request.handoverId}
                            AND phase IN ('closing', 'quarantined') RETURNING partition`;
                    if (rows.length !== 1) throw new AuthorityError('conflict');
                },
                advance: async (checkpoint, dispatchIds): Promise<HandoverSnapshot> => {
                    const row = await assertJournal(checkpoint);
                    if (row.phase !== 'quarantined') throw new AuthorityError('conflict');
                    const request = checkpoint.request;
                    // Expensive barriers run BEFORE the authority row is locked.
                    // Admissions are closed (draining), so participating
                    // publishers cannot add jobs and tokenless writers are
                    // refused; the counts can only shrink until the transfer.
                    await this.assertQueuesDrained();
                    await assertSession();
                    await this.assertHistoryDrained(reserved);
                    await store.handoffWithCheckpoint(
                        request.source,
                        request.next,
                        { generation: request.source.generation, dispatchIds: [...dispatchIds] },
                        request.leaseMs ?? 30_000,
                        async (tx): Promise<void> => {
                            await assertSession();
                            // The authority row is locked and ownership is not
                            // committed yet. Re-validate with index-backed SQL
                            // only; the transfer itself rechecks pending queue
                            // journal rows under the same lock.
                            await this.assertHistoryDrained(tx);
                            const rows = await tx`UPDATE task_runtime_handovers
                                SET phase = 'transferred', updated_at = clock_timestamp()
                                WHERE partition = ${partition} AND handover_id = ${request.handoverId}
                                    AND source_generation = ${request.source.generation}::bigint
                                    AND source_owner_id = ${request.source.ownerId}
                                    AND phase = 'quarantined' RETURNING partition`;
                            if (rows.length !== 1) throw new AuthorityError('conflict');
                        },
                        request.recovery,
                        request.handoverId,
                    );
                    return snapshot();
                },
                complete: async (checkpoint): Promise<void> => {
                    const row = await assertJournal(checkpoint);
                    if (!['transferred', 'complete'].includes(row.phase))
                        throw new AuthorityError('conflict');
                    await begin(async (tx) => {
                        await assertSession();
                        const [owner] = await tx<
                            { generation: string; owner_id: string; live: boolean }[]
                        >`
                            SELECT generation::text, owner_id, lease_until > clock_timestamp() AS live
                            FROM task_runtime_authorities WHERE partition = ${partition} FOR UPDATE`;
                        const next = nextToken(checkpoint.request);
                        if (
                            !owner ||
                            owner.generation !== next.generation ||
                            owner.owner_id !== next.ownerId ||
                            !owner.live
                        )
                            throw new AuthorityError('stale_authority');
                        await tx`UPDATE task_runtime_handovers SET phase = 'complete', updated_at = clock_timestamp()
                            WHERE partition = ${partition} AND handover_id = ${checkpoint.request.handoverId}
                                AND phase IN ('transferred', 'complete')`;
                    });
                },
            };
            outcome = { ok: true, value: await work(session) };
        } catch (error) {
            outcome = { ok: false, error };
        }
        let reusable = true;
        try {
            if (needsRollback) {
                await reserved`ROLLBACK`;
                needsRollback = false;
            }
            if (locked) {
                const [result] = await reserved<{ unlocked: boolean }[]>`
                        SELECT pg_advisory_unlock(hashtextextended(${`task-runtime-handover:${partition}`}, 0)) AS unlocked`;
                if (result?.unlocked !== true) throw new AuthorityError('conflict');
            }
        } catch (error) {
            // Destroy an uncertain dedicated session; preserve the work failure
            // as well instead of replacing it from an unsafe finally block.
            reusable = false;
            await this.sql.end({ timeout: 0 });
            if (!outcome.ok)
                throw new AggregateError([outcome.error, error], 'Task handover cleanup failed', {
                    cause: error,
                });
            throw error;
        } finally {
            if (reusable) reserved.release();
        }
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
    }
}
