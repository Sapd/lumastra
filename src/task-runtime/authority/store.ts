// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import { assertRustOwnershipReady } from './readiness.js';

export const TASK_AUTHORITY_PARTITION = 'tasks';
// Serialize first management against participating unbound writers. Never delete
// a managed authority row to return to compatibility mode.
const TASK_MANAGEMENT_LOCK = 0x5441534b;

const tokenSchema = z
    .object({
        partition: z.string().regex(/^[a-z][a-z0-9:._-]{0,127}$/),
        generation: z
            .string()
            .regex(/^[1-9][0-9]{0,18}$/)
            .refine(
                (value) =>
                    /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
            ),
        ownerId: z.string().uuid(),
    })
    .strict();
export type AuthorityToken = z.infer<typeof tokenSchema>;
export type AuthorityOwnerKind = 'typescript' | 'rust';
export interface AuthoritySnapshot {
    authority: AuthorityToken;
    ownerKind: AuthorityOwnerKind;
    phase: 'active' | 'draining';
    leaseUntilMs: number;
    live: boolean;
}
export type AuthorityJson = postgres.JSONValue;
export interface AuthorityReceipt {
    commandId: string;
    authority: AuthorityToken;
    result: AuthorityJson;
    completedAt: string;
}
export interface ExecutionAdmission {
    invocationId: string;
    dispatchId: string;
    runId: string;
    taskId: string;
}
export interface ExecutionRecord extends ExecutionAdmission {
    state: 'active' | 'settled';
    outcome: AuthorityJson | null;
}
/** Invocation continuation only; this is NOT process/SQL teardown evidence. */
export interface ExecutionTeardown {
    dispatchId: string;
    quiescent: true;
}
export interface DispatchTeardownProof {
    processGroupStopped: true;
    sqlConnectionsDrained: true;
}
export interface DrainProof {
    generation: string;
    dispatchIds: string[];
}
export interface MutationOptions {
    allowDraining?: boolean;
}
interface AuthorityRow {
    partition: string;
    generation: string;
    owner_id: string;
    phase: 'active' | 'draining';
    owner_kind: AuthorityOwnerKind;
    live: boolean;
}
interface ReceiptRow {
    command_id: string;
    generation: string;
    owner_id: string;
    payload_hash: string;
    result: AuthorityJson;
    completed_at: Date;
}
export class AuthorityError extends Error {
    constructor(
        public readonly code:
            'stale_authority' | 'draining' | 'conflict' | 'not_drained' | 'invalid',
    ) {
        super(`Task authority: ${code}`);
        this.name = 'AuthorityError';
    }
}

const MANAGED_AUTHORITY_DISABLED_MESSAGE =
    'Managed task authority is not production-ready and is disabled; see src/task-runtime/authority/README.md';

/** Managed task authority (an authority row + tokens) is refused outside tests. */
export class ManagedAuthorityDisabledError extends Error {
    readonly code = 'managed_authority_disabled';
    constructor(message: string = MANAGED_AUTHORITY_DISABLED_MESSAGE) {
        super(message);
        this.name = 'ManagedAuthorityDisabledError';
    }
}

// undefined = default: enabled only inside a non-production vitest process.
let managedAuthorityOverride: boolean | undefined;

/**
 * Test-only switch for the managed-authority guard. `true` enables it, `false`
 * forces the production refusal, `null` restores the default (enabled under
 * vitest). Refuses to run in a production process.
 */
export function enableManagedAuthorityForTesting(enabled: boolean | null = true): void {
    if (process.env.NODE_ENV === 'production')
        throw new ManagedAuthorityDisabledError(
            'enableManagedAuthorityForTesting() cannot run in production',
        );
    managedAuthorityOverride = enabled ?? undefined;
}

function managedAuthorityEnabled(): boolean {
    if (managedAuthorityOverride !== undefined) return managedAuthorityOverride;
    return process.env.VITEST === 'true' && process.env.NODE_ENV !== 'production';
}

/**
 * Startup check: a `tasks` authority row makes every tokenless (production)
 * task write fail with stale_authority, so refuse to start instead.
 */
export async function assertTaskAuthorityUnmanaged(sql: postgres.Sql): Promise<void> {
    const rows = await sql`SELECT generation::text, owner_id FROM task_runtime_authorities
        WHERE partition = ${TASK_AUTHORITY_PARTITION} LIMIT 1`;
    if (rows.length !== 0)
        throw new ManagedAuthorityDisabledError(
            `A managed '${TASK_AUTHORITY_PARTITION}' row exists in task_runtime_authorities, so tokenless task writes would fail with stale_authority. ${MANAGED_AUTHORITY_DISABLED_MESSAGE}`,
        );
}

/** Canonical, bounded JSON identity. Reject values JSON.stringify would silently discard. */
function canonical(value: unknown, depth = 0): string {
    if (depth > 64) throw new AuthorityError('invalid');
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${Array.from(value, (entry) => canonical(entry, depth + 1)).join(',')}]`;
    if (
        typeof value === 'object' &&
        value !== null &&
        Object.getPrototypeOf(value) === Object.prototype
    ) {
        return `{${Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, depth + 1)}`)
            .join(',')}}`;
    }
    throw new AuthorityError('invalid');
}
function hash(value: unknown): string {
    const body = canonical(value);
    if (Buffer.byteLength(body) > 256 * 1024) throw new AuthorityError('invalid');
    return createHash('sha256').update(body).digest('hex');
}
function lease(milliseconds: number): number {
    if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > 300_000)
        throw new AuthorityError('invalid');
    return milliseconds;
}
function receipt(partition: string, row: ReceiptRow): AuthorityReceipt {
    return {
        commandId: row.command_id,
        authority: { partition, generation: row.generation, ownerId: row.owner_id },
        result: row.result,
        completedAt: row.completed_at.toISOString(),
    };
}

/**
 * Authority storage used by participating task writers; incomplete all-writer coverage
 * and raw capabilities still block production Rust ownership.
 * Every mutation callback must await ALL SQL on the supplied transaction and must
 * neither retain it nor perform Redis/HTTP/filesystem side effects. This API is
 * not a sandbox for plugins with raw SQL; they require confirmed process and SQL
 * quiescence before handoff. Keeping the authority row locked makes participating
 * PostgreSQL mutations atomic with the fence and their durable receipt.
 */
export class AuthorityStore {
    constructor(private readonly sql: postgres.Sql) {}

    async initialize(
        partition: string,
        ownerId: string,
        ownerKind: AuthorityOwnerKind,
        leaseMs = 30_000,
    ): Promise<AuthorityToken> {
        // The only path that creates an authority row; transfers update it.
        if (!managedAuthorityEnabled()) throw new ManagedAuthorityDisabledError();
        const token = tokenSchema.parse({ partition, ownerId, generation: '1' });
        if (ownerKind !== 'typescript' && ownerKind !== 'rust') throw new AuthorityError('invalid');
        const duration = lease(leaseMs);
        await this.sql.begin(async (tx) => {
            if (partition === TASK_AUTHORITY_PARTITION) {
                await tx`SELECT pg_advisory_xact_lock(${TASK_MANAGEMENT_LOCK})`;
                await this.assertQueueDrained(tx, partition);
            }
            const rows = await tx`
                INSERT INTO task_runtime_authorities (partition, generation, owner_id, owner_kind, phase, lease_until)
                VALUES (${partition}, 1, ${ownerId}, ${ownerKind}, 'active', clock_timestamp() + ${duration} * interval '1 millisecond')
                ON CONFLICT (partition) DO NOTHING RETURNING partition
            `;
            if (rows.length !== 1) throw new AuthorityError('conflict');
        });
        return token;
    }

    private async lock(
        tx: postgres.TransactionSql,
        token: AuthorityToken,
        allowDraining: boolean,
        requireLive = true,
        requireCompletedHandover = true,
    ): Promise<AuthorityRow> {
        tokenSchema.parse(token);
        // Cast to text explicitly: bigint must never pass through a JS number.
        const [row] = await tx<AuthorityRow[]>`
            SELECT partition, generation::text, owner_id, owner_kind, phase, false AS live
            FROM task_runtime_authorities WHERE partition = ${token.partition} FOR UPDATE
        `;
        if (row) {
            const [clock] = await tx<
                { live: boolean }[]
            >`SELECT lease_until > clock_timestamp() AS live FROM task_runtime_authorities WHERE partition = ${token.partition}`;
            row.live = clock.live;
        }
        if (
            !row ||
            row.generation !== token.generation ||
            row.owner_id !== token.ownerId ||
            (requireLive && !row.live)
        )
            throw new AuthorityError('stale_authority');
        if (requireCompletedHandover && token.partition === TASK_AUTHORITY_PARTITION) {
            const pending = await tx`SELECT handover_id FROM task_runtime_handovers
                WHERE partition = ${token.partition} AND phase = 'transferred'
                    AND source_generation + 1 = ${token.generation}::bigint
                    AND next_owner_id = ${token.ownerId}`;
            if (pending.length !== 0) throw new AuthorityError('not_drained');
        }
        if (!allowDraining && row.phase !== 'active') throw new AuthorityError('draining');
        return row;
    }

    /** Existing mirrors do not create command receipts. All mutation SQL must
     * use this transaction; neither retain it nor issue external side effects. */
    async withExistingWrite<T>(
        token: AuthorityToken,
        mutate: (tx: postgres.TransactionSql) => Promise<T>,
        options: MutationOptions = { allowDraining: true },
    ): Promise<T> {
        // Copy before any await: delayed work cannot borrow a mutable successor.
        const original = tokenSchema.parse(token);
        return this.sql.begin(async (tx) => {
            await this.lock(tx, original, options.allowDraining ?? false);
            const result = await mutate(tx);
            await this.lock(tx, original, options.allowDraining ?? false);
            return result;
        }) as Promise<T>;
    }

    /** Compatibility is permitted only while the global partition is unmanaged.
     * Shared advisory lock closes the absent-row/initialize race. No authority
     * token is ever inferred from the current owner for an old callback. */
    async withUnmanagedWrite<T>(mutate: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
        return this.sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock_shared(${TASK_MANAGEMENT_LOCK})`;
            const rows = await tx`SELECT partition FROM task_runtime_authorities
                WHERE partition = ${TASK_AUTHORITY_PARTITION}`;
            if (rows.length !== 0) throw new AuthorityError('stale_authority');
            return mutate(tx);
        }) as Promise<T>;
    }

    async assertCurrent(token: AuthorityToken, options: MutationOptions = {}): Promise<void> {
        await this.sql.begin(async (tx) => {
            await this.lock(tx, token, options.allowDraining ?? false);
        });
    }

    /** Production executor gate reads owner kind from durable storage, never IPC input. */
    async assertExecutorAdmissionReady(token: AuthorityToken): Promise<void> {
        await this.sql.begin(async (tx) => {
            const row = await this.lock(tx, token, false);
            if (row.owner_kind === 'rust') assertRustOwnershipReady();
        });
    }

    async renew(token: AuthorityToken, leaseMs = 30_000): Promise<void> {
        await this.sql.begin(async (tx) => {
            await this.lock(tx, token, true);
            await tx`UPDATE task_runtime_authorities SET lease_until = clock_timestamp() + ${lease(leaseMs)} * interval '1 millisecond', updated_at = clock_timestamp() WHERE partition = ${token.partition}`;
        });
    }

    async beginDrain(token: AuthorityToken): Promise<void> {
        await this.sql.begin(async (tx) => {
            // Closing admissions is safe even after expiry; it grants no lease.
            await this.lock(tx, token, true, false);
            await tx`UPDATE task_runtime_authorities SET phase = 'draining', updated_at = clock_timestamp() WHERE partition = ${token.partition}`;
        });
    }

    async admitExecution(token: AuthorityToken, admission: ExecutionAdmission): Promise<void> {
        const input = z
            .object({
                invocationId: z.string().uuid(),
                dispatchId: z.string().uuid(),
                runId: z.string().min(1).max(256),
                taskId: z.string().min(1).max(256),
            })
            .strict()
            .parse(admission);
        await this.sql.begin(async (tx) => {
            await this.lock(tx, token, false);
            const active = await tx`SELECT invocation_id FROM task_runtime_executions
                WHERE partition = ${token.partition} AND generation = ${token.generation}::bigint
                AND run_id = ${input.runId} AND state = 'active' LIMIT 1`;
            if (active.length !== 0) throw new AuthorityError('conflict');
            const rows = await tx`
                INSERT INTO task_runtime_executions (partition, invocation_id, generation, owner_id, dispatch_id, run_id, task_id, state)
                VALUES (${token.partition}, ${input.invocationId}, ${token.generation}::bigint, ${token.ownerId}, ${input.dispatchId}, ${input.runId}, ${input.taskId}, 'active')
                ON CONFLICT DO NOTHING RETURNING invocation_id
            `;
            // Admissions are never replayed: an UNKNOWN dispatch must be queried,
            // not executed twice just because the first acknowledgment was lost.
            if (rows.length !== 1) throw new AuthorityError('conflict');
            await this.lock(tx, token, false);
        });
    }

    async settleExecution(
        token: AuthorityToken,
        invocationId: string,
        outcome: AuthorityJson,
        teardown: ExecutionTeardown,
    ): Promise<void> {
        z.string().uuid().parse(invocationId);
        z.object({ dispatchId: z.string().uuid(), quiescent: z.literal(true) })
            .strict()
            .parse(teardown);
        tokenSchema.parse(token);
        const outcomeHash = hash(outcome);
        await this.sql.begin(async (tx) => {
            // A committed settlement is a receipt: replay is read-only even if
            // this original owner's lease expired or authority moved onward.
            await tx`SELECT partition FROM task_runtime_authorities WHERE partition = ${token.partition} FOR UPDATE`;
            const [existing] = await tx<
                { state: string; dispatch_id: string; outcome: AuthorityJson | null }[]
            >`
                SELECT state, dispatch_id, outcome FROM task_runtime_executions
                WHERE partition = ${token.partition} AND invocation_id = ${invocationId}
                AND generation = ${token.generation}::bigint AND owner_id = ${token.ownerId}
            `;
            if (existing?.state === 'settled') {
                if (
                    existing.dispatch_id !== teardown.dispatchId ||
                    hash(existing.outcome) !== outcomeHash
                )
                    throw new AuthorityError('conflict');
                return;
            }
            await this.lock(tx, token, true);
            const rows = await tx`
                UPDATE task_runtime_executions SET state = 'settled', outcome = COALESCE(${tx.json(outcome)}, 'null'::jsonb), settled_at = clock_timestamp()
                WHERE partition = ${token.partition} AND invocation_id = ${invocationId}
                    AND generation = ${token.generation}::bigint AND owner_id = ${token.ownerId}
                    AND dispatch_id = ${teardown.dispatchId} AND state = 'active'
                RETURNING invocation_id
            `;
            if (rows.length !== 1) throw new AuthorityError('conflict');
            await this.lock(tx, token, true);
        });
    }

    /** Record invocation quiescence after expiry without accepting a task result.
     * Full dispatch process/SQL teardown requires confirmDispatchTeardown too.
     * Expired work has UNKNOWN outcome, never a successful task completion.
     */
    async confirmExpiredTeardown(
        token: AuthorityToken,
        invocationId: string,
        teardown: ExecutionTeardown,
    ): Promise<void> {
        z.string().uuid().parse(invocationId);
        z.object({ dispatchId: z.string().uuid(), quiescent: z.literal(true) })
            .strict()
            .parse(teardown);
        await this.sql.begin(async (tx) => {
            const row = await this.lock(tx, token, true, false);
            if (row.live || row.phase !== 'draining') throw new AuthorityError('not_drained');
            const rows = await tx`UPDATE task_runtime_executions SET state = 'settled',
                outcome = '{"status":"unknown","reason":"owner_lease_expired"}'::jsonb, settled_at = clock_timestamp()
                WHERE partition = ${token.partition} AND invocation_id = ${invocationId}
                AND generation = ${token.generation}::bigint AND owner_id = ${token.ownerId}
                AND dispatch_id = ${teardown.dispatchId} AND state = 'active'
                RETURNING invocation_id`;
            if (rows.length !== 1) throw new AuthorityError('conflict');
        });
    }

    /** Separate supervisor attestation AFTER actual process-group stop and SQL
     * connection drain. Never called automatically when execute() resolves.
     * The caller is trusted; an SDK plugin holding the DB role can bypass this
     * protocol, which is one reason production Rust ownership stays blocked.
     */
    async confirmDispatchTeardown(
        token: AuthorityToken,
        dispatchId: string,
        proof: DispatchTeardownProof,
    ): Promise<void> {
        z.string().uuid().parse(dispatchId);
        z.object({ processGroupStopped: z.literal(true), sqlConnectionsDrained: z.literal(true) })
            .strict()
            .parse(proof);
        await this.sql.begin(async (tx) => {
            const row = await this.lock(tx, token, true, false);
            if (row.phase !== 'draining') throw new AuthorityError('not_drained');
            const rows = await tx`UPDATE task_runtime_executions SET process_group_stopped = true,
                sql_connections_drained = true, teardown_at = COALESCE(teardown_at, clock_timestamp())
                WHERE partition = ${token.partition} AND dispatch_id = ${dispatchId}
                AND generation = ${token.generation}::bigint AND owner_id = ${token.ownerId}
                AND state = 'settled' RETURNING invocation_id`;
            if (rows.length !== 1) throw new AuthorityError('not_drained');
        });
    }

    /** Barrier lookup for an uncertain admission. Caller must await ALL prior
     * admission SQL, not abandon its connection/promise and race this lookup.
     * The authority lock waits for a participating admission transaction to
     * commit or roll back before absence can be observed. No new admission may
     * be scheduled later after the caller uses absence as a release decision.
     */
    async reconcileExecutionAdmission(
        token: AuthorityToken,
        invocationId: string,
    ): Promise<ExecutionRecord | null> {
        z.string().uuid().parse(invocationId);
        return this.sql.begin(async (tx) => {
            await this.lock(tx, token, true, false);
            const [row] = await tx<
                {
                    invocation_id: string;
                    dispatch_id: string;
                    run_id: string;
                    task_id: string;
                    state: 'active' | 'settled';
                    outcome: AuthorityJson | null;
                }[]
            >`
                SELECT invocation_id, dispatch_id, run_id, task_id, state, outcome FROM task_runtime_executions
                WHERE partition = ${token.partition} AND invocation_id = ${invocationId}
                AND generation = ${token.generation}::bigint AND owner_id = ${token.ownerId}
            `;
            return row
                ? {
                      invocationId: row.invocation_id,
                      dispatchId: row.dispatch_id,
                      runId: row.run_id,
                      taskId: row.task_id,
                      state: row.state,
                      outcome: row.outcome,
                  }
                : null;
        });
    }

    async lookupExecution(
        token: AuthorityToken,
        invocationId: string,
    ): Promise<{
        state: 'active' | 'settled';
        dispatchId: string;
        outcome: AuthorityJson | null;
    } | null> {
        tokenSchema.parse(token);
        z.string().uuid().parse(invocationId);
        const [row] = await this.sql<
            { state: 'active' | 'settled'; dispatch_id: string; outcome: AuthorityJson | null }[]
        >`
            SELECT state, dispatch_id, outcome FROM task_runtime_executions
            WHERE partition = ${token.partition} AND invocation_id = ${invocationId}
                AND generation = ${token.generation}::bigint AND owner_id = ${token.ownerId}
        `;
        return row ? { state: row.state, dispatchId: row.dispatch_id, outcome: row.outcome } : null;
    }

    async getSnapshot(token?: AuthorityToken): Promise<AuthoritySnapshot | null> {
        const original = token ? tokenSchema.parse(token) : undefined;
        const [row] = await this.sql<
            {
                partition: string;
                generation: string;
                owner_id: string;
                owner_kind: AuthorityOwnerKind;
                phase: 'active' | 'draining';
                lease_until: Date;
                live: boolean;
            }[]
        >`SELECT partition, generation::text, owner_id, owner_kind, phase, lease_until,
            lease_until > clock_timestamp() AS live FROM task_runtime_authorities
            WHERE partition = ${original?.partition ?? TASK_AUTHORITY_PARTITION}`;
        if (!row) {
            if (original) throw new AuthorityError('stale_authority');
            return null;
        }
        if (
            original &&
            (row.generation !== original.generation || row.owner_id !== original.ownerId)
        )
            throw new AuthorityError('stale_authority');
        return {
            authority: {
                partition: row.partition,
                generation: row.generation,
                ownerId: row.owner_id,
            },
            ownerKind: row.owner_kind,
            phase: row.phase,
            leaseUntilMs: row.lease_until.getTime(),
            live: row.live,
        };
    }

    private async assertQueueDrained(
        tx: postgres.TransactionSql,
        partition: string,
    ): Promise<void> {
        if (partition !== TASK_AUTHORITY_PARTITION) return;
        const rows = await tx`SELECT operation_id FROM task_runtime_queue_operations
            WHERE partition = ${partition} AND state = 'pending' LIMIT 1`;
        if (rows.length !== 0) throw new AuthorityError('not_drained');
    }

    async getDrainProof(token: AuthorityToken): Promise<DrainProof> {
        const original = tokenSchema.parse(token);
        return this.sql.begin(async (tx) => {
            const row = await this.lock(tx, original, true, false);
            if (row.phase !== 'draining') throw new AuthorityError('not_drained');
            await this.assertQueueDrained(tx, original.partition);
            const executions = await tx<
                {
                    dispatch_id: string;
                    state: string;
                    teardown_at: Date | null;
                    process_group_stopped: boolean;
                    sql_connections_drained: boolean;
                }[]
            >`
                SELECT dispatch_id, state, teardown_at, process_group_stopped, sql_connections_drained
                FROM task_runtime_executions WHERE partition = ${original.partition}
                AND generation = ${original.generation}::bigint`;
            if (
                executions.some(
                    (entry) =>
                        entry.state !== 'settled' ||
                        !entry.teardown_at ||
                        !entry.process_group_stopped ||
                        !entry.sql_connections_drained,
                )
            )
                throw new AuthorityError('not_drained');
            return {
                generation: original.generation,
                dispatchIds: executions.map((entry) => entry.dispatch_id),
            };
        });
    }

    /** The coordinator checkpoint commits with the generation change. */
    async handoffWithCheckpoint(
        token: AuthorityToken,
        next: { ownerId: string; ownerKind: AuthorityOwnerKind },
        proof: DrainProof,
        leaseMs: number,
        checkpoint: (tx: postgres.TransactionSql, nextToken: AuthorityToken) => Promise<void>,
        recovery: boolean,
        expectedHandoverId: string,
    ): Promise<AuthorityToken> {
        z.string().uuid().parse(expectedHandoverId);
        return this.transfer(token, next, proof, leaseMs, recovery, checkpoint, expectedHandoverId);
    }

    async handoff(
        token: AuthorityToken,
        next: { ownerId: string; ownerKind: AuthorityOwnerKind },
        proof: DrainProof,
        leaseMs = 30_000,
    ): Promise<AuthorityToken> {
        return this.transfer(token, next, proof, leaseMs, false);
    }

    /** Never automatic: requires exact expired owner, explicit drain and every dispatch teardown. */
    async recoverDrained(
        token: AuthorityToken,
        next: { ownerId: string; ownerKind: 'typescript' },
        proof: DrainProof,
        leaseMs = 30_000,
    ): Promise<AuthorityToken> {
        if (next.ownerKind !== 'typescript') throw new AuthorityError('invalid');
        return this.transfer(token, next, proof, leaseMs, true);
    }

    private async transfer(
        token: AuthorityToken,
        next: { ownerId: string; ownerKind: AuthorityOwnerKind },
        proof: DrainProof,
        leaseMs: number,
        recovery: boolean,
        checkpoint?: (tx: postgres.TransactionSql, nextToken: AuthorityToken) => Promise<void>,
        expectedHandoverId?: string,
    ): Promise<AuthorityToken> {
        token = tokenSchema.parse(token);
        next = z
            .object({ ownerId: z.string().uuid(), ownerKind: z.enum(['typescript', 'rust']) })
            .strict()
            .parse(next);
        proof = { generation: proof.generation, dispatchIds: [...proof.dispatchIds] };
        if (recovery && next.ownerKind !== 'typescript') throw new AuthorityError('invalid');
        z.string().uuid().parse(next.ownerId);
        z.enum(['typescript', 'rust']).parse(next.ownerKind);
        if (
            proof.generation !== token.generation ||
            new Set(proof.dispatchIds).size !== proof.dispatchIds.length
        )
            throw new AuthorityError('not_drained');
        for (const id of proof.dispatchIds) z.string().uuid().parse(id);
        const generation = (BigInt(token.generation) + 1n).toString();
        tokenSchema.parse({ ...token, generation });
        await this.sql.begin(async (tx) => {
            const row = await this.lock(tx, token, true, !recovery);
            if (recovery && row.live) throw new AuthorityError('not_drained');
            if (row.phase !== 'draining') throw new AuthorityError('not_drained');
            await this.assertQueueDrained(tx, token.partition);
            if (token.partition === TASK_AUTHORITY_PARTITION) {
                const [journal] = await tx<
                    {
                        handover_id: string;
                        source_generation: string;
                        source_owner_id: string;
                        next_owner_id: string;
                        next_owner_kind: string;
                        recovery: boolean;
                        lease_ms: number;
                        phase: string;
                    }[]
                >`
                    SELECT handover_id, source_generation::text, source_owner_id, next_owner_id,
                        next_owner_kind, recovery, lease_ms, phase
                    FROM task_runtime_handovers WHERE partition = ${token.partition} FOR UPDATE`;
                if (
                    !checkpoint ||
                    !expectedHandoverId ||
                    !journal ||
                    journal.handover_id !== expectedHandoverId ||
                    journal.source_generation !== token.generation ||
                    journal.source_owner_id !== token.ownerId ||
                    journal.next_owner_id !== next.ownerId ||
                    journal.next_owner_kind !== next.ownerKind ||
                    journal.recovery !== recovery ||
                    journal.lease_ms !== leaseMs ||
                    journal.phase !== 'quarantined'
                )
                    throw new AuthorityError('not_drained');
            }
            const executions = await tx<
                {
                    dispatch_id: string;
                    state: string;
                    process_group_stopped: boolean;
                    sql_connections_drained: boolean;
                    teardown_at: Date | null;
                }[]
            >`
                SELECT dispatch_id, state, process_group_stopped, sql_connections_drained, teardown_at FROM task_runtime_executions
                WHERE partition = ${token.partition} AND generation = ${token.generation}::bigint
            `;
            const confirmed = new Set(proof.dispatchIds);
            if (
                executions.some(
                    (entry) =>
                        entry.state !== 'settled' ||
                        !entry.process_group_stopped ||
                        !entry.sql_connections_drained ||
                        !entry.teardown_at ||
                        !confirmed.has(entry.dispatch_id),
                ) ||
                executions.length !== confirmed.size
            )
                throw new AuthorityError('not_drained');
            // Execution-table contention may outlast the original lease.
            // Re-evaluate after all blocking work before advancing ownership.
            await this.lock(tx, token, true, !recovery);
            await tx`UPDATE task_runtime_authorities SET generation = ${generation}::bigint, owner_id = ${next.ownerId}, owner_kind = ${next.ownerKind}, phase = 'active', lease_until = clock_timestamp() + ${lease(leaseMs)} * interval '1 millisecond', updated_at = clock_timestamp() WHERE partition = ${token.partition}`;
            if (checkpoint) {
                const nextToken = { partition: token.partition, generation, ownerId: next.ownerId };
                await checkpoint(tx, nextToken);
                // The successor remains unavailable to writers until the
                // coordinator verifies both mirrors and completes its journal.
                await this.lock(tx, nextToken, false, true, false);
            }
        });
        return { partition: token.partition, generation, ownerId: next.ownerId };
    }

    async lookupReceipt(partition: string, commandId: string): Promise<AuthorityReceipt | null> {
        tokenSchema.shape.partition.parse(partition);
        z.string().uuid().parse(commandId);
        const [row] = await this.sql<
            ReceiptRow[]
        >`SELECT command_id, generation::text, owner_id, payload_hash, result, completed_at FROM task_runtime_commands WHERE partition = ${partition} AND command_id = ${commandId}`;
        return row ? receipt(partition, row) : null;
    }

    async withMutation(
        token: AuthorityToken,
        commandId: string,
        payload: AuthorityJson,
        mutate: (tx: postgres.TransactionSql) => Promise<AuthorityJson>,
        options: MutationOptions = {},
    ): Promise<AuthorityReceipt> {
        tokenSchema.parse(token);
        z.string().uuid().parse(commandId);
        const payloadHash = hash(payload);
        return this.sql.begin(async (tx) => {
            // Lock even when replaying a receipt, serializing duplicate commands.
            await tx`SELECT partition FROM task_runtime_authorities WHERE partition = ${token.partition} FOR UPDATE`;
            const [existing] = await tx<
                ReceiptRow[]
            >`SELECT command_id, generation::text, owner_id, payload_hash, result, completed_at FROM task_runtime_commands WHERE partition = ${token.partition} AND command_id = ${commandId}`;
            if (existing) {
                if (existing.payload_hash !== payloadHash) throw new AuthorityError('conflict');
                return receipt(token.partition, existing);
            }
            await this.lock(tx, token, options.allowDraining ?? false);
            const result = await mutate(tx);
            hash(result);
            // No expired lease may commit after a slow callback. Handoff itself
            // cannot race past the row lock held throughout this transaction.
            await this.lock(tx, token, options.allowDraining ?? false);
            const [row] = await tx<
                ReceiptRow[]
            >`INSERT INTO task_runtime_commands (partition, command_id, generation, owner_id, payload_hash, result) VALUES (${token.partition}, ${commandId}, ${token.generation}::bigint, ${token.ownerId}, ${payloadHash}, COALESCE(${tx.json(result)}, 'null'::jsonb)) RETURNING command_id, generation::text, owner_id, payload_hash, result, completed_at`;
            return receipt(token.partition, row);
        });
    }
}
