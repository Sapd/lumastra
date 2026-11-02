// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for collaborative chat messages.
 * All write paths for `collaborative_chat_messages` go through this module.
 *
 * Note: playlist IDs are integers (not UUIDs); context_id is an integer column.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// ── Row shapes ────────────────────────────────────────────────────────────────

export interface ChatMessageRow {
    id: number;
    user_id: string;
    message: string;
    message_type: string;
    created_at: Date;
}

export interface ChatMessageWithContext {
    id: number;
    user_id: string;
    context_id: number;
    owner_user_id: string;
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Fetch chat messages for a playlist, optionally filtered/paginated.
 */
export async function getPlaylistChatMessages(
    sql: postgres.Sql,
    params: {
        playlistId: number;
        limit: number;
        before?: number;
        since?: number;
    },
): Promise<
    Array<{
        id: number;
        user_id: string;
        username: string;
        message: string;
        message_type: string | null;
        created_at: Date;
    }>
> {
    const { playlistId, limit, before, since } = params;

    // JOIN users so each message carries the author's resolved login `username`,
    // not the bare users.id UUID (collaborative_chat_messages.user_id is a UUID
    // since mig 16.46.0). LEFT JOIN so a deleted author never drops a message.
    if (since !== undefined) {
        return sql<
            Array<{
                id: number;
                user_id: string;
                username: string;
                message: string;
                message_type: string | null;
                created_at: Date;
            }>
        >`
            SELECT cm.id, cm.user_id, COALESCE(u.username, cm.user_id::text) AS username, cm.message, cm.message_type, cm.created_at
            FROM collaborative_chat_messages cm
            LEFT JOIN users u ON u.id = cm.user_id
            WHERE cm.context_type = 'playlist'
              AND cm.context_id = ${playlistId}
              AND cm.deleted_at IS NULL
              AND cm.id > ${since}
            ORDER BY cm.created_at ASC
            LIMIT ${limit}
        `;
    }

    if (before !== undefined) {
        return sql<
            Array<{
                id: number;
                user_id: string;
                username: string;
                message: string;
                message_type: string | null;
                created_at: Date;
            }>
        >`
            SELECT cm.id, cm.user_id, COALESCE(u.username, cm.user_id::text) AS username, cm.message, cm.message_type, cm.created_at
            FROM collaborative_chat_messages cm
            LEFT JOIN users u ON u.id = cm.user_id
            WHERE cm.context_type = 'playlist'
              AND cm.context_id = ${playlistId}
              AND cm.deleted_at IS NULL
              AND cm.id < ${before}
            ORDER BY cm.created_at DESC
            LIMIT ${limit}
        `;
    }

    return sql<
        Array<{
            id: number;
            user_id: string;
            username: string;
            message: string;
            message_type: string | null;
            created_at: Date;
        }>
    >`
        SELECT cm.id, cm.user_id, COALESCE(u.username, cm.user_id::text) AS username, cm.message, cm.message_type, cm.created_at
        FROM collaborative_chat_messages cm
        LEFT JOIN users u ON u.id = cm.user_id
        WHERE cm.context_type = 'playlist'
          AND cm.context_id = ${playlistId}
          AND cm.deleted_at IS NULL
        ORDER BY cm.created_at DESC
        LIMIT ${limit}
    `;
}

/**
 * Fetch a single chat message with playlist ownership, for permission checks.
 */
export async function getChatMessageWithContext(
    sql: postgres.Sql,
    params: { messageId: number; playlistId: number },
): Promise<ChatMessageWithContext | null> {
    const rows = await sql<ChatMessageWithContext[]>`
        SELECT cm.id, cm.user_id, cm.context_id, p.user_id AS owner_user_id
        FROM collaborative_chat_messages cm
        JOIN playlists p ON p.id = cm.context_id
        WHERE cm.id = ${params.messageId}
          AND cm.context_type = 'playlist'
          AND cm.context_id = ${params.playlistId}
          AND cm.deleted_at IS NULL
    `;
    return rows[0] ?? null;
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Insert a new chat message for a playlist and return the created row.
 */
export async function insertPlaylistChatMessage(
    sql: postgres.Sql,
    params: {
        playlistId: number;
        userId: UserId;
        message: string;
    },
): Promise<ChatMessageRow> {
    const rows = await sql<ChatMessageRow[]>`
        INSERT INTO collaborative_chat_messages (context_type, context_id, user_id, message, message_type)
        VALUES ('playlist', ${params.playlistId}, ${params.userId}::uuid, ${params.message}, 'user')
        RETURNING id, user_id, message, message_type, created_at
    `;
    const row = rows[0];
    if (!row) throw new Error('Insert returned no rows');
    return row;
}

/**
 * Soft-delete a chat message by setting deleted_at = NOW().
 */
export async function softDeleteChatMessage(sql: postgres.Sql, messageId: number): Promise<void> {
    await sql`
        UPDATE collaborative_chat_messages
        SET deleted_at = NOW()
        WHERE id = ${messageId}
    `;
}
