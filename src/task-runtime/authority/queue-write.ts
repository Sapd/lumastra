// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import {
    AuthorityError,
    AuthorityStore,
    TASK_AUTHORITY_PARTITION,
    type AuthorityToken,
} from './store.js';

export interface QueueOperation {
    kind: string;
    queue: string;
    jobId?: string;
}

export class QueueOperationUncertainError extends Error {
    constructor(
        public readonly operationId: string,
        cause: unknown,
    ) {
        super(
            `Queue operation ${operationId} needs reconciliation: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
        );
        this.name = 'QueueOperationUncertainError';
    }
}

/**
 * Thrown by a managed queue write callback when it can prove the command never
 * reached Valkey (for example, it refused before issuing any RPC). Only this
 * marker lets the journal retire its pending row on failure: a transport error
 * such as ioredis' "Connection is closed." is also used for commands already
 * written and awaiting a reply, so it proves nothing.
 */
export class QueueWriteNotSentError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'QueueWriteNotSentError';
    }
}

// BullMQ rejections that carry a definite server reply proving no mutation:
// Job.remove() throws the first when its atomic remove script answered 0
// (locked job, nothing removed); the second is the scripts' JobNotExist reply.
const NON_MUTATING_REJECTIONS = [
    /^Job .+ could not be removed because it is locked by another worker$/,
    /^Missing key for job /,
];

function provablyNotMutated(cause: unknown): boolean {
    if (cause instanceof QueueWriteNotSentError) return true;
    return (
        cause instanceof Error &&
        NON_MUTATING_REJECTIONS.some((pattern) => pattern.test(cause.message))
    );
}

const UNMANAGED_RECHECK_MS = 30_000;
let unmanagedVerifiedAt = Number.NEGATIVE_INFINITY;
let unmanagedCheck: Promise<void> | undefined;

/**
 * Tokenless queue writes are valid only while no `tasks` authority row exists.
 * The `NOT EXISTS` probe runs at most every 30 s per process; concurrent callers
 * share one in-flight probe. A row (or a failed probe) fails closed, and a row
 * keeps failing on every call until it is gone.
 */
async function assertQueueWritesUnmanaged(sql: postgres.Sql | null): Promise<void> {
    if (Date.now() - unmanagedVerifiedAt < UNMANAGED_RECHECK_MS) return;
    if (!sql) throw new AuthorityError('stale_authority');
    unmanagedCheck ??= (async (): Promise<void> => {
        try {
            const rows = await sql`SELECT 1 FROM task_runtime_authorities
                WHERE partition = ${TASK_AUTHORITY_PARTITION} LIMIT 1`;
            if (rows.length !== 0) throw new AuthorityError('stale_authority');
            unmanagedVerifiedAt = Date.now();
        } finally {
            unmanagedCheck = undefined;
        }
    })();
    await unmanagedCheck;
}

/** Test-only: forget the cached unmanaged verification. */
export function resetUnmanagedQueueWriteCheckForTesting(): void {
    unmanagedVerifiedAt = Number.NEGATIVE_INFINITY;
}

/** In managed mode this is an uncertainty journal, NOT a submission outbox.
 * Pending records are not cleared on rejection: a lost Redis/SQL reply is not
 * evidence that no mutation occurred. Initialization and transfer check this
 * same table while holding the authority lock. Only a successfully acknowledged
 * RPC, a callback failure marked QueueWriteNotSentError, or a BullMQ rejection
 * whose reply proves nothing changed (locked job, missing job key) settles it.
 * Abandoned records require explicit external reconciliation.
 *
 * Unmanaged mode (no token: the only production mode, managed authority is
 * refused) writes no journal row and runs the queue write directly, so the
 * write's own error reaches the caller and the caller's compensation runs. It
 * still refuses (stale_authority) while a `tasks` authority row exists, using a
 * per-process check cached for 30 s.
 */
export async function withTaskQueueWrite<T>(
    sql: postgres.Sql | null,
    authority: AuthorityToken | undefined,
    operation: QueueOperation,
    write: () => Promise<T>,
    options: { allowDraining?: boolean } = {},
): Promise<T> {
    if (authority === undefined) {
        await assertQueueWritesUnmanaged(sql);
        return write();
    }
    if (!sql) throw new AuthorityError('stale_authority');
    const original = { ...authority };
    if (original.partition !== TASK_AUTHORITY_PARTITION) throw new AuthorityError('invalid');
    const descriptor = z
        .object({
            kind: z.string().min(1).max(128),
            queue: z.string().min(1).max(256),
            jobId: z.string().min(1).max(2048).optional(),
        })
        .strict()
        .parse(operation);
    const operationId = randomUUID();
    const store = new AuthorityStore(sql);
    await store.withExistingWrite(
        original,
        async (tx) => {
            await tx`INSERT INTO task_runtime_queue_operations
            (operation_id, partition, generation, owner_id, kind, queue_name, job_id, state)
            VALUES (${operationId}, ${TASK_AUTHORITY_PARTITION}, ${original.generation}::bigint,
                ${original.ownerId}, ${descriptor.kind}, ${descriptor.queue}, ${descriptor.jobId ?? null}, 'pending')`;
        },
        { allowDraining: options.allowDraining ?? false },
    );
    // Do not put this inside a database transaction: a connection can disappear
    // and release its locks while the queue RPC is still executing.
    let result: T;
    try {
        result = await write();
    } catch (cause) {
        if (provablyNotMutated(cause)) {
            try {
                await retire(sql, operationId);
            } catch (retireError) {
                throw new QueueOperationUncertainError(operationId, retireError);
            }
            throw cause;
        }
        throw new QueueOperationUncertainError(operationId, cause);
    }
    try {
        // Retire only our acknowledged operation. Keeping every successful RPC
        // forever would grow an unbounded journal under ordinary TS traffic.
        // No authority lease is needed: pending has blocked transfer so far.
        await retire(sql, operationId);
    } catch (cause) {
        throw new QueueOperationUncertainError(operationId, cause);
    }
    return result;
}

async function retire(sql: postgres.Sql, operationId: string): Promise<void> {
    const rows = await sql`DELETE FROM task_runtime_queue_operations
        WHERE operation_id = ${operationId} AND state = 'pending' RETURNING operation_id`;
    if (rows.length !== 1) throw new AuthorityError('conflict');
}
