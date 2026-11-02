// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for task webhook hooks (task_webhook_hooks table).
 * All CRUD operations on task_webhook_hooks go through this module.
 */

import type postgres from 'postgres';

// ── Row shapes ────────────────────────────────────────────────────────────────

export interface WebhookHookRow {
    id: string;
    url: string;
    event_filter: unknown;
    task_filter: unknown;
    library_group_filter: unknown;
    media_type_filter: unknown;
    batch_window_seconds: number;
    max_batch_size: number;
    /** Display name shown to users (migration 16.288.0); NULL when unnamed. */
    label?: string | null;
    headers: unknown;
    active: boolean;
    include_progress: boolean;
    created_by: string;
    created_at: Date;
    secret_encrypted: Buffer;
    /** Status of the most recent completed attempt retained in the outbox. */
    last_status?: number | null;
    last_error?: string | null;
    last_delivered_at?: Date | null;
    dead_count?: number;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Index expressions match migration 16.461.0, including the legacy timestamp fallback. */
function deliverySummaryJoins(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        LEFT JOIN LATERAL (
            SELECT CASE WHEN delivered_at IS NOT NULL AND last_status >= 300
                        THEN NULL ELSE last_status END AS last_status,
                   CASE WHEN delivered_at IS NOT NULL THEN NULL ELSE last_error END AS last_error
            FROM task_webhook_outbox
            WHERE hook_id = h.id
              AND (attempts > 0 OR delivered_at IS NOT NULL OR last_error IS NOT NULL OR last_status IS NOT NULL)
            ORDER BY COALESCE(last_attempt_at, delivered_at, created_at) DESC, created_at DESC, id DESC
            LIMIT 1
        ) latest ON true
        LEFT JOIN LATERAL (
            SELECT delivered_at AS last_delivered_at
            FROM task_webhook_outbox
            WHERE hook_id = h.id AND delivered_at IS NOT NULL
            ORDER BY delivered_at DESC
            LIMIT 1
        ) successful ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::integer AS dead_count
            FROM task_webhook_outbox
            WHERE hook_id = h.id AND dead
              AND (attempts > 0 OR delivered_at IS NOT NULL OR last_error IS NOT NULL OR last_status IS NOT NULL)
              AND COALESCE(last_attempt_at, delivered_at, created_at)
                  > COALESCE(successful.last_delivered_at, '-infinity'::timestamptz)
        ) summary ON true
    `;
}

/**
 * List all webhook hooks, ordered by creation time descending.
 */
export async function listWebhookHooks(sql: postgres.Sql): Promise<WebhookHookRow[]> {
    return sql<WebhookHookRow[]>`
        SELECT h.*, latest.last_status, latest.last_error,
               successful.last_delivered_at, summary.dead_count
        FROM task_webhook_hooks h
        ${deliverySummaryJoins(sql)}
        ORDER BY h.created_at DESC
    `;
}

/**
 * Get a single webhook hook by id.
 * Returns the row or null when not found.
 */
export async function getWebhookHookById(
    sql: postgres.Sql,
    id: string,
): Promise<WebhookHookRow | null> {
    const rows = await sql<WebhookHookRow[]>`
        SELECT h.*, latest.last_status, latest.last_error,
               successful.last_delivered_at, summary.dead_count
        FROM task_webhook_hooks h
        ${deliverySummaryJoins(sql)}
        WHERE h.id = ${id}::uuid
    `;
    return rows[0] ?? null;
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Insert a new webhook hook and return its ID.
 *
 * The caller supplies the id rather than letting the column default generate
 * one: `secret_encrypted` is sealed BOUND to the hook id (security review
 * 2026-09-13, C19), so the id has to exist before the row does.
 */
export async function insertWebhookHook(
    sql: postgres.Sql,
    params: {
        id: string;
        url: string;
        secretEncrypted: Buffer;
        eventFilter: string[];
        taskFilter: string[] | null;
        libraryGroupFilter: string[] | null;
        headers: Record<string, string> | null;
        active: boolean;
        includeProgress: boolean;
        createdBy: string;
        mediaTypeFilter: string[] | null;
        batchWindowSeconds: number;
        maxBatchSize: number;
        label?: string | null;
    },
): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO task_webhook_hooks
            (id, url, secret_encrypted, event_filter, task_filter,
             library_group_filter, headers, active, include_progress, created_by,
             media_type_filter, batch_window_seconds, max_batch_size, label)
        VALUES (
            ${params.id}::uuid,
            ${params.url},
            ${params.secretEncrypted},
            ${sql.json(params.eventFilter)},
            ${params.taskFilter ? sql.json(params.taskFilter) : null},
            ${params.libraryGroupFilter ? sql.json(params.libraryGroupFilter) : null},
            ${params.headers ? sql.json(params.headers) : null},
            ${params.active},
            ${params.includeProgress},
            ${params.createdBy},
            ${params.mediaTypeFilter ? sql.json(params.mediaTypeFilter) : null},
            ${params.batchWindowSeconds},
            ${params.maxBatchSize},
            ${params.label ?? null}
        )
        RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('Insert returned no id');
    return id;
}

/**
 * Update a webhook hook (with a new encrypted secret).
 * Returns the updated hook id, or null if not found.
 */
export async function updateWebhookHookWithSecret(
    sql: postgres.Sql,
    params: {
        id: string;
        url: string;
        secretEncrypted: Buffer;
        eventFilter: string[];
        taskFilter: string[] | null;
        libraryGroupFilter: string[] | null;
        headers: Record<string, string> | null;
        active: boolean;
        includeProgress: boolean;
        mediaTypeFilter: string[] | null;
        batchWindowSeconds: number | null;
        maxBatchSize: number | null;
        /** `undefined` keeps the stored label; `null` clears it. */
        label?: string | null;
    },
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        UPDATE task_webhook_hooks
        SET url = ${params.url},
            secret_encrypted = ${params.secretEncrypted},
            event_filter = ${sql.json(params.eventFilter)},
            task_filter = ${params.taskFilter ? sql.json(params.taskFilter) : null},
            library_group_filter = ${params.libraryGroupFilter ? sql.json(params.libraryGroupFilter) : null},
            headers = ${params.headers ? sql.json(params.headers) : null},
            active = ${params.active},
            include_progress = ${params.includeProgress},
            media_type_filter = ${params.mediaTypeFilter ? sql.json(params.mediaTypeFilter) : null},
            batch_window_seconds = COALESCE(${params.batchWindowSeconds}, batch_window_seconds),
            max_batch_size = COALESCE(${params.maxBatchSize}, max_batch_size),
            label = CASE WHEN ${params.label === undefined} THEN label ELSE ${params.label ?? null} END
        WHERE id = ${params.id}::uuid
        RETURNING id
    `;
    return rows[0]?.id ?? null;
}

/**
 * Update a webhook hook without changing the secret.
 * Returns the updated hook id, or null if not found.
 */
export async function updateWebhookHookWithoutSecret(
    sql: postgres.Sql,
    params: {
        id: string;
        url: string;
        eventFilter: string[];
        taskFilter: string[] | null;
        libraryGroupFilter: string[] | null;
        headers: Record<string, string> | null;
        active: boolean;
        includeProgress: boolean;
        mediaTypeFilter: string[] | null;
        batchWindowSeconds: number | null;
        maxBatchSize: number | null;
        /** `undefined` keeps the stored label; `null` clears it. */
        label?: string | null;
    },
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        UPDATE task_webhook_hooks
        SET url = ${params.url},
            event_filter = ${sql.json(params.eventFilter)},
            task_filter = ${params.taskFilter ? sql.json(params.taskFilter) : null},
            library_group_filter = ${params.libraryGroupFilter ? sql.json(params.libraryGroupFilter) : null},
            headers = ${params.headers ? sql.json(params.headers) : null},
            active = ${params.active},
            include_progress = ${params.includeProgress},
            media_type_filter = ${params.mediaTypeFilter ? sql.json(params.mediaTypeFilter) : null},
            batch_window_seconds = COALESCE(${params.batchWindowSeconds}, batch_window_seconds),
            max_batch_size = COALESCE(${params.maxBatchSize}, max_batch_size),
            label = CASE WHEN ${params.label === undefined} THEN label ELSE ${params.label ?? null} END
        WHERE id = ${params.id}::uuid
        RETURNING id
    `;
    return rows[0]?.id ?? null;
}

/**
 * Delete a webhook hook by id and return the deleted hook's id,
 * or null if not found.
 */
export async function deleteWebhookHook(sql: postgres.Sql, id: string): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        DELETE FROM task_webhook_hooks
        WHERE id = ${id}::uuid
        RETURNING id
    `;
    return rows[0]?.id ?? null;
}

/**
 * Active hooks subscribed to the media.item.added event, with the fields the
 * dispatcher's staging handler and the notifier's flush loop need.
 */
export interface MediaAddedHookRow {
    id: string;
    media_type_filter: unknown;
    library_group_filter: unknown;
    batch_window_seconds: number;
    max_batch_size: number;
}

export async function listActiveMediaAddedHooks(sql: postgres.Sql): Promise<MediaAddedHookRow[]> {
    return sql<MediaAddedHookRow[]>`
        SELECT id, media_type_filter, library_group_filter,
               batch_window_seconds, max_batch_size
        FROM task_webhook_hooks
        WHERE active = true
          AND event_filter @> '["org.lumastra.media.item.added"]'::jsonb
    `;
}
