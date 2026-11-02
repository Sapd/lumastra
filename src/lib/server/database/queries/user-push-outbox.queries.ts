// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Push outbox queries.
 *
 * The claim pattern is lifted from `tasks/webhook-outbox.ts`: select ready rows
 * `FOR UPDATE SKIP LOCKED`, then push `next_attempt_at` forward by a claim TTL so
 * a concurrent replica's pass skips them. That is the whole of the mutual
 * exclusion — there is deliberately no leader election, exactly as the webhook
 * outbox runs unconditionally on every replica.
 *
 * @module queries/user-push-outbox
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

export interface PushOutboxRow {
    id: string;
    user_id: string;
    notification_id: string;
    kind: string;
    attempts: number;
    delivered_tokens: string[];
    created_at: Date;
}

/**
 * Insert the intent to push. Returns false when a row already existed — the
 * unique key on `notification_id` makes a retried emitter idempotent rather than
 * duplicating a lock-screen banner.
 */
export async function enqueuePushOutbox(
    sql: postgres.Sql,
    params: { userId: UserId; notificationId: string; kind: string },
): Promise<boolean> {
    const rows = await sql`
        INSERT INTO user_push_outbox (user_id, notification_id, kind)
        VALUES (${params.userId}, ${params.notificationId}, ${params.kind})
        ON CONFLICT (notification_id) DO NOTHING
        RETURNING id
    `;
    return rows.length > 0;
}

export async function claimReadyPushRows(
    sql: postgres.Sql,
    limit: number,
    claimTtlSeconds: number,
): Promise<PushOutboxRow[]> {
    return await sql.begin(async (tx): Promise<PushOutboxRow[]> => {
        const ready = await tx<{ id: string }[]>`
            SELECT id FROM user_push_outbox
            WHERE dead = FALSE AND next_attempt_at <= NOW()
            ORDER BY next_attempt_at
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
        `;
        if (ready.length === 0) return [];
        const ids = ready.map((r) => r.id);
        return await tx<PushOutboxRow[]>`
            UPDATE user_push_outbox
            SET next_attempt_at = NOW() + (${claimTtlSeconds} * INTERVAL '1 second')
            WHERE id = ANY(${ids}::uuid[])
            RETURNING id, user_id, notification_id, kind, attempts, delivered_tokens, created_at
        `;
    });
}

/**
 * Fully delivered — remove the row. The durable record of the notification is
 * `user_notifications`; the outbox only ever holds pending intent.
 */
export async function markPushRowDelivered(sql: postgres.Sql, id: string): Promise<void> {
    await sql`DELETE FROM user_push_outbox WHERE id = ${id}`;
}

export async function markPushRowDead(
    sql: postgres.Sql,
    id: string,
    reason: string,
): Promise<void> {
    await sql`
        UPDATE user_push_outbox
        SET dead = TRUE, dead_reason = ${reason}
        WHERE id = ${id}
    `;
}

/**
 * CAS on `attempts` — a concurrent pass cannot observe the same `attempts` and
 * both increment to the same value, which would silently halve the ladder.
 *
 * `consumesAttempt` decouples "spend a permanent-retry-budget rung" from
 * "wait before trying again". A relay `Retry-After` is a free, EXPECTED
 * backoff — Apple/the relay asking us to slow down is not a failure of ours —
 * so `push-outbox.ts` passes `false` for it, leaving `attempts` untouched
 * while still moving `next_attempt_at` out by the requested delay. The CAS
 * predicate still matches on `expectedAttempts` either way: a concurrent
 * pass that already advanced `attempts` (a genuine ladder rung) must still
 * lose this race, or a stale caller could overwrite a legitimate rung's
 * bookkeeping.
 */
export async function reschedulePushRow(
    sql: postgres.Sql,
    id: string,
    expectedAttempts: number,
    delaySeconds: number,
    deliveredTokens: string[],
    consumesAttempt: boolean,
): Promise<boolean> {
    const rows = await sql`
        UPDATE user_push_outbox
        SET attempts         = CASE WHEN ${consumesAttempt} THEN ${expectedAttempts + 1} ELSE attempts END,
            next_attempt_at  = NOW() + (${delaySeconds} * INTERVAL '1 second'),
            delivered_tokens = ${sql.json(deliveredTokens)}
        WHERE id = ${id} AND attempts = ${expectedAttempts}
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Retention sweep for dead rows.
 *
 * Nothing else removes them. `markPushRowDelivered` DELETEs, so a successful
 * row is self-cleaning, but a dead row is kept on purpose — it is the only
 * place an operator can see WHY a push never arrived. Kept forever, though, it
 * is just a leak, and the leak is worst exactly when something is misconfigured:
 * with no relay credential every single row dies, so a broken install
 * accumulates one permanent row per notification per user from day one.
 *
 * Deliberately time-based rather than count-based, so the admin view keeps a
 * full picture of a recent incident instead of a truncated one.
 *
 * Note this is NOT the whole story for the table: `notification_id` cascades
 * from `user_notifications`, so pruning the inbox also drops any outbox row
 * still attached to it. That path only ever covered rows whose notification
 * expired; dead rows outlive nothing on their own.
 */
export async function pruneDeadPushRows(sql: postgres.Sql, cutoff: Date): Promise<number> {
    const rows = await sql`
        DELETE FROM user_push_outbox
        WHERE dead = TRUE AND created_at < ${cutoff}
        RETURNING id
    `;
    return rows.length;
}

/** Operator turned the feature off. Queued rows must stop, not drain. */
export async function retireQueuedPushRows(sql: postgres.Sql, reason: string): Promise<number> {
    const rows = await sql`
        UPDATE user_push_outbox
        SET dead = TRUE, dead_reason = ${reason}
        WHERE dead = FALSE
        RETURNING id
    `;
    return rows.length;
}
