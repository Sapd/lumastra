// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for media_added_pending — the per-hook staging buffer for
 * batched media.item.added webhook delivery. The dispatcher's staging handler
 * inserts; the MediaAddedNotifier flush loop drains.
 */
import type postgres from 'postgres';
import type { MediaAddedItem } from '$lib/server/tasks/cloud-events.js';

export interface PendingFlushRow {
    id: string;
    payload: MediaAddedItem;
}

/** Stage one hydrated item for one hook. Idempotent on (hook_id, media_item_id). */
export async function insertPendingMediaAdded(
    sql: postgres.Sql,
    params: { hookId: string; mediaItemId: string; payload: MediaAddedItem },
): Promise<void> {
    await sql`
        INSERT INTO media_added_pending (hook_id, media_item_id, payload)
        VALUES (
            ${params.hookId}::uuid,
            ${params.mediaItemId}::uuid,
            ${sql.json(params.payload as unknown as Record<string, never>)}
        )
        ON CONFLICT (hook_id, media_item_id) DO NOTHING
    `;
}

export interface DueHookRow {
    hook_id: string;
    pending_count: number;
    max_batch_size: number;
}

/**
 * Hooks due to flush: oldest pending row older than the hook's window OR
 * accumulated >= the hook's max batch size.
 */
export async function listHooksDueForFlush(sql: postgres.Sql): Promise<DueHookRow[]> {
    return sql<DueHookRow[]>`
        SELECT p.hook_id,
               COUNT(*)::int AS pending_count,
               h.max_batch_size
        FROM media_added_pending p
        JOIN task_webhook_hooks h ON h.id = p.hook_id
        GROUP BY p.hook_id, h.batch_window_seconds, h.max_batch_size
        HAVING COUNT(*) >= h.max_batch_size
            OR MIN(p.created_at) <= NOW() - (h.batch_window_seconds * INTERVAL '1 second')
    `;
}

/**
 * Claim up to `limit` oldest pending rows for one hook (FOR UPDATE SKIP LOCKED
 * so a leadership handoff can't double-deliver). Caller builds the batch then
 * calls deletePendingByIds within the same transaction.
 */
export async function claimPendingForHook(
    sql: postgres.Sql,
    hookId: string,
    limit: number,
): Promise<PendingFlushRow[]> {
    return sql<PendingFlushRow[]>`
        SELECT id, payload
        FROM media_added_pending
        WHERE hook_id = ${hookId}::uuid
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
    `;
}

export async function deletePendingByIds(sql: postgres.Sql, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await sql`DELETE FROM media_added_pending WHERE id = ANY(${ids}::uuid[])`;
}
