// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for notification forwarding: a user's notifications delivered to
 * OPERATOR webhooks subscribed to `org.lumastra.user.notification` (migration
 * 16.288.0).
 *
 * Two independent gates have to agree before anything is queued:
 *   - the operator subscribed an active hook to the event BY NAME (an empty
 *     `event_filter` — "everything" for every other event — never counts), and
 *   - the user switched `users.notification_forwarding` on.
 */

import type postgres from 'postgres';

/** The CloudEvent type operator hooks subscribe to for forwarded notifications. */
export const USER_NOTIFICATION_EVENT_TYPE = 'org.lumastra.user.notification';

export interface ForwardingHookRow {
    id: string;
    label: string | null;
}

/**
 * Active operator hooks that named `org.lumastra.user.notification` in their
 * event filter. Containment (`@>`) rather than the outbox's "empty means all"
 * rule, the same way `listActiveMediaAddedHooks` selects its hooks: per-user
 * notification content must never reach a hook whose admin did not ask for it.
 */
export async function listUserNotificationForwardingHooks(
    sql: postgres.Sql,
): Promise<ForwardingHookRow[]> {
    return sql<ForwardingHookRow[]>`
        SELECT id::text, label
        FROM task_webhook_hooks
        WHERE active = true
          AND event_filter @> ${sql.json([USER_NOTIFICATION_EVENT_TYPE])}::jsonb
        ORDER BY created_at
    `;
}

export interface ForwardingRecipientRow {
    username: string;
}

/**
 * The user's username when they opted in AND the account is live; null
 * otherwise. A disabled or deleted account forwards nothing even if the flag
 * was left on.
 */
export async function getForwardingRecipient(
    sql: postgres.Sql,
    userId: string,
): Promise<ForwardingRecipientRow | null> {
    const rows = await sql<ForwardingRecipientRow[]>`
        SELECT username
        FROM users
        WHERE id = ${userId}::uuid
          AND notification_forwarding = true
          AND disabled_at IS NULL
          AND deleted_at IS NULL
    `;
    return rows[0] ?? null;
}

export async function getNotificationForwarding(
    sql: postgres.Sql,
    userId: string,
): Promise<boolean | null> {
    const rows = await sql<{ notification_forwarding: boolean }[]>`
        SELECT notification_forwarding FROM users WHERE id = ${userId}::uuid
    `;
    return rows[0]?.notification_forwarding ?? null;
}

/** Returns the stored value, or null when the user row does not exist. */
export async function setNotificationForwarding(
    sql: postgres.Sql,
    userId: string,
    enabled: boolean,
): Promise<boolean | null> {
    const rows = await sql<{ notification_forwarding: boolean }[]>`
        UPDATE users
        SET notification_forwarding = ${enabled}
        WHERE id = ${userId}::uuid
        RETURNING notification_forwarding
    `;
    return rows[0]?.notification_forwarding ?? null;
}

/**
 * Queue one forwarded notification for one operator hook. Idempotent on
 * (hook_id, event_id), the same conflict target `WebhookOutbox.enqueue` uses.
 */
export async function enqueueForwardedNotification(
    sql: postgres.Sql,
    params: { hookId: string; eventId: string; payload: Record<string, unknown> },
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO task_webhook_outbox (hook_id, event_id, payload, next_attempt_at)
        VALUES (
            ${params.hookId}::uuid,
            ${params.eventId},
            ${sql.json(params.payload as Record<string, never>)},
            NOW()
        )
        ON CONFLICT (hook_id, event_id) DO NOTHING
        RETURNING id::text
    `;
    return rows.length > 0;
}
