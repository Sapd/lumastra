// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for `user_notification_webhooks` — the per-user outbound
 * notification endpoint added in migration 16.192.0.
 *
 * Every function here is user-scoped by construction: there is no
 * "list all hooks" read, because no surface in the product has a reason to see
 * more than one user's endpoint at a time and the absence of the function is a
 * cheaper guarantee than a review comment. The admin outbox view reports on
 * `task_webhook_outbox`, which carries the hook id and never the URL.
 */

import type postgres from 'postgres';

// ── Row shapes ────────────────────────────────────────────────────────────────

export interface UserNotificationWebhookRow {
    id: string;
    user_id: string;
    url: string;
    created_at: Date;
    updated_at: Date;
}

/** What the enqueue path needs: the hook id, nothing else. */
export interface UserNotificationWebhookTarget {
    id: string;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * The caller's own hook, or null.
 *
 * `secret_encrypted` is deliberately NOT selected. It is write-only by the same
 * rule the operator hook follows (`rowToWebhook` reports `hasSecret`, never the
 * value), and a column that is never read cannot be leaked by a serializer
 * someone adds later.
 */
export async function getUserNotificationWebhook(
    sql: postgres.Sql,
    userId: string,
): Promise<UserNotificationWebhookRow | null> {
    const rows = await sql<UserNotificationWebhookRow[]>`
        SELECT id::text, user_id::text, url, created_at, updated_at
        FROM user_notification_webhooks
        WHERE user_id = ${userId}::uuid
    `;
    return rows[0] ?? null;
}

/**
 * Resolve the delivery target for one user. Returns null when the user has not
 * configured an endpoint — the common case, since the feature is off by default
 * and opt-in per user even when it is on.
 */
export async function getUserNotificationWebhookTarget(
    sql: postgres.Sql,
    userId: string,
): Promise<UserNotificationWebhookTarget | null> {
    const rows = await sql<UserNotificationWebhookTarget[]>`
        SELECT id::text
        FROM user_notification_webhooks
        WHERE user_id = ${userId}::uuid
    `;
    return rows[0] ?? null;
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Create or replace the caller's endpoint. One row per user (UNIQUE user_id), so
 * "save" is an upsert rather than a create/update pair.
 *
 * Replacing the URL also replaces the signing secret: a new endpoint has never
 * seen the old secret and the old endpoint must not keep a working one.
 */
export async function upsertUserNotificationWebhook(
    sql: postgres.Sql,
    params: {
        userId: string;
        url: string;
        secretEncrypted: Buffer;
    },
): Promise<UserNotificationWebhookRow> {
    const rows = await sql<UserNotificationWebhookRow[]>`
        INSERT INTO user_notification_webhooks (user_id, url, secret_encrypted)
        VALUES (${params.userId}::uuid, ${params.url}, ${params.secretEncrypted})
        ON CONFLICT (user_id) DO UPDATE
            SET url              = EXCLUDED.url,
                secret_encrypted = EXCLUDED.secret_encrypted,
                updated_at       = NOW()
        RETURNING id::text, user_id::text, url, created_at, updated_at
    `;
    const row = rows[0];
    if (!row) throw new Error('Upsert returned no row');
    return row;
}

/**
 * Clear the caller's endpoint. Returns true when a row was removed.
 *
 * The outbox FK is ON DELETE CASCADE, so clearing the URL also drops every
 * queued-but-undelivered notification for it. That is the intended reading of
 * "clear": a user who removes their endpoint is not asking for the backlog to
 * arrive at whatever they configure next.
 */
export async function deleteUserNotificationWebhook(
    sql: postgres.Sql,
    userId: string,
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        DELETE FROM user_notification_webhooks
        WHERE user_id = ${userId}::uuid
        RETURNING id::text
    `;
    return rows.length > 0;
}

/**
 * Queue one notification for delivery to a user hook.
 *
 * This is an INSERT into `task_webhook_outbox` — the SAME table
 * `WebhookOutbox.enqueue()` writes and `WebhookOutbox.deliveryPass()` drains.
 * There is no second delivery path: backoff, HMAC signing, the 404/410
 * fast-death, the DLQ and the admin outbox view all apply unchanged. The only
 * difference is which of the two owner columns is set.
 *
 * `ON CONFLICT DO NOTHING` against `task_webhook_outbox_user_hook_event_uniq`
 * makes the enqueue idempotent for a deterministic `eventId`. The durable
 * `user_notifications` INSERT is already the arbiter upstream (see
 * `notification-events.service.ts`); this is the second net, for the case where
 * a row is inserted, the process dies before the enqueue, and a later retry
 * re-derives the same event id.
 */
export async function enqueueUserWebhookDelivery(
    sql: postgres.Sql,
    params: {
        userHookId: string;
        eventId: string;
        payload: Record<string, unknown>;
    },
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO task_webhook_outbox (user_hook_id, event_id, payload, next_attempt_at)
        VALUES (
            ${params.userHookId}::uuid,
            ${params.eventId},
            ${sql.json(params.payload as Record<string, never>)},
            NOW()
        )
        ON CONFLICT (user_hook_id, event_id) WHERE user_hook_id IS NOT NULL DO NOTHING
        RETURNING id::text
    `;
    return rows.length > 0;
}
