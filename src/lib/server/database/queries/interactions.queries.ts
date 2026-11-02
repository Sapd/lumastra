// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for the polymorphic `interactions` (comments) and
 * `interaction_reactions` (per-target emoji reactions) tables.
 *
 * target_type is the closed set enforced at the app layer:
 *   'media'    — media_items.id (UUID)
 *   'playlist' — playlists.id  (integer, stored as text)
 *   'person'   — media_people.id (UUID)
 *
 * Reactions are per-resource-target, NOT per comment.
 *
 * All write paths for these tables go through this module.
 * Do NOT issue raw SQL against `interactions` or `interaction_reactions` elsewhere.
 */

import type postgres from 'postgres';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import { pgTextTimestamp } from './builders/keyset-cursor.builder.js';

// ── Closed target-type taxonomy ───────────────────────────────────────────────

export type InteractionTargetType = 'media' | 'playlist' | 'person';

// ── Row shapes ────────────────────────────────────────────────────────────────

export interface CommentRow {
    /** bigint rendered as string (safe across JS integer boundaries). */
    id: string;
    target_type: string;
    target_id: string;
    user_id: string;
    /** Resolved from the users JOIN; falls back to user_id::text if user is deleted. */
    username: string;
    body: string;
    created_at: Date;
    /**
     * `created_at::text` — the exact Postgres rendering (microsecond precision)
     * used to mint the next keyset cursor. `Date#toISOString()` truncates to
     * milliseconds and would skip/re-emit a comment written in the same ms as
     * the page boundary; keep this a bare string. Only populated by the reads
     * in this module; consumed only by the cursor def.
     */
    created_at_cursor?: string;
    updated_at: Date;
}

/**
 * Decoded keyset cursor for {@link listComments} — mirrors the
 * `(created_at DESC, id DESC)` ordering. `createdAt` is the raw
 * `created_at::text` rendering (micro precision preserved); `id` is the unique
 * bigint tiebreak. `created_at` is NOT NULL (default now()), so there is no
 * NULL-group carry (Gate D2b N/A for this feed).
 */
export interface CommentsCursor {
    createdAt: string;
    id: string;
}

export interface ReactionSummaryRow {
    emoji: string;
    /** bigint COUNT rendered as string. */
    count: string;
    /** Whether the requesting user has reacted with this emoji. */
    reacted_by_me: boolean;
}

// ── Comments — reads ──────────────────────────────────────────────────────────

export interface ListCommentsParams {
    targetType: InteractionTargetType;
    targetId: string;
    limit: number;
    /** Return comments with id > since (poll path, oldest first). */
    since?: string;
    /**
     * Opt-in keyset cursor over `(created_at DESC, id DESC)`. When present it
     * cannot be combined with `since` by the HTTP handler.
     */
    cursor?: CommentsCursor;
}

/**
 * List comments for a target, keyed by (target_type, target_id).
 *
 * Pagination:
 *   - Default: DESC order (newest first).  Callers that need
 *     chronological display should call `.toReversed()` on the result.
 *   - `since`: ASC order (oldest first) — used for polling new messages.
 */
export async function listComments(
    sql: postgres.Sql,
    params: ListCommentsParams,
): Promise<CommentRow[]> {
    const { targetType, targetId, limit, since, cursor } = params;

    // Opt-in keyset cursor (E2): keyset over (created_at DESC, id DESC), the
    // same ordering as the default path. Bind the timestamp half as
    // exact text pinned to OID 25 (TEXT) so postgres.js ships the raw µs string
    // and Postgres parses it losslessly (see keyset-cursor.builder.ts). The def
    // rejects a cursor combined with since.
    if (cursor !== undefined) {
        return sql<CommentRow[]>`
            SELECT
                c.id::text,
                c.target_type,
                c.target_id,
                c.user_id::text,
                COALESCE(u.username, c.user_id::text) AS username,
                c.body,
                c.created_at,
                c.created_at::text AS created_at_cursor,
                c.updated_at
            FROM interactions c
            LEFT JOIN users u ON u.id = c.user_id
            WHERE c.target_type = ${targetType}
              AND c.target_id   = ${targetId}
              AND c.deleted_at IS NULL
              AND (c.created_at, c.id) < (${pgTextTimestamp(sql, cursor.createdAt)}::timestamptz, ${cursor.id}::bigint)
            ORDER BY c.created_at DESC, c.id DESC
            LIMIT ${limit}
        `;
    }

    if (since !== undefined) {
        return sql<CommentRow[]>`
            SELECT
                c.id::text,
                c.target_type,
                c.target_id,
                c.user_id::text,
                COALESCE(u.username, c.user_id::text) AS username,
                c.body,
                c.created_at,
                c.created_at::text AS created_at_cursor,
                c.updated_at
            FROM interactions c
            LEFT JOIN users u ON u.id = c.user_id
            WHERE c.target_type = ${targetType}
              AND c.target_id   = ${targetId}
              AND c.deleted_at IS NULL
              AND c.id > ${since}::bigint
            ORDER BY c.created_at ASC, c.id ASC
            LIMIT ${limit}
        `;
    }

    return sql<CommentRow[]>`
        SELECT
            c.id::text,
            c.target_type,
            c.target_id,
            c.user_id::text,
            COALESCE(u.username, c.user_id::text) AS username,
            c.body,
            c.created_at,
            c.created_at::text AS created_at_cursor,
            c.updated_at
        FROM interactions c
        LEFT JOIN users u ON u.id = c.user_id
        WHERE c.target_type = ${targetType}
          AND c.target_id   = ${targetId}
          AND c.deleted_at IS NULL
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ${limit}
    `;
}

/**
 * Fetch a single non-deleted comment for permission checks.
 *
 * Returns null when the comment is not found, belongs to a different target,
 * or has been soft-deleted.
 */
export async function getCommentOwner(
    sql: postgres.Sql,
    params: {
        commentId: string;
        targetType: InteractionTargetType;
        targetId: string;
    },
): Promise<{ user_id: string } | null> {
    const rows = await sql<{ user_id: string }[]>`
        SELECT user_id::text
        FROM interactions
        WHERE id          = ${params.commentId}::bigint
          AND target_type = ${params.targetType}
          AND target_id   = ${params.targetId}
          AND deleted_at IS NULL
    `;
    return rows[0] ?? null;
}

// ── Comments — writes ─────────────────────────────────────────────────────────

export interface InsertCommentParams {
    targetType: InteractionTargetType;
    targetId: string;
    userId: string;
    body: string;
}

/**
 * Insert a new comment and return the created row (with username resolved).
 */
export async function insertComment(
    sql: postgres.Sql,
    params: InsertCommentParams,
): Promise<CommentRow> {
    // Target access is checked by the interaction API/service; this locks target existence.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<CommentRow[]>`
        WITH inserted AS (
            INSERT INTO interactions (target_type, target_id, user_id, body)
            SELECT ${params.targetType}, ${params.targetId}, ${params.userId}::uuid, ${params.body}
            WHERE ${params.targetType} <> 'media' OR EXISTS (
                SELECT 1 FROM media_items WHERE id = ${isUuid(params.targetId) ? normalizeUuid(params.targetId) : null}::uuid FOR KEY SHARE
            )
            RETURNING id, target_type, target_id, user_id, body, created_at, updated_at
        )
        SELECT
            i.id::text,
            i.target_type,
            i.target_id,
            i.user_id::text,
            COALESCE(u.username, i.user_id::text) AS username,
            i.body,
            i.created_at,
            i.updated_at
        FROM inserted i
        LEFT JOIN users u ON u.id = i.user_id
    `;
    const row = rows[0];
    if (!row) throw new Error('insertComment: INSERT returned no rows');
    return row;
}

/**
 * Soft-delete a comment by setting deleted_at = NOW().
 *
 * Only operates when the comment belongs to the given target (prevents
 * cross-target deletes via crafted IDs).
 */
export async function softDeleteComment(
    sql: postgres.Sql,
    params: {
        commentId: string;
        targetType: InteractionTargetType;
        targetId: string;
    },
): Promise<void> {
    await sql`
        UPDATE interactions
        SET deleted_at = NOW()
        WHERE id          = ${params.commentId}::bigint
          AND target_type = ${params.targetType}
          AND target_id   = ${params.targetId}
          AND deleted_at IS NULL
    `;
}

// ── Reactions — reads ─────────────────────────────────────────────────────────

/**
 * List aggregated reaction counts for a target, with a per-user "reacted?" flag.
 *
 * `requestingUserId` may be null (unauthenticated) — in that case
 * `reacted_by_me` is always false.
 */
export async function listReactions(
    sql: postgres.Sql,
    params: {
        targetType: InteractionTargetType;
        targetId: string;
        requestingUserId: string | null;
    },
): Promise<ReactionSummaryRow[]> {
    const { targetType, targetId, requestingUserId } = params;

    // Use a nil UUID as the fallback so the BOOL_OR comparison is safe when
    // requestingUserId is null (no real user will ever have the nil UUID).
    const callerUuid = requestingUserId ?? '00000000-0000-0000-0000-000000000000';

    return sql<ReactionSummaryRow[]>`
        SELECT
            emoji,
            COUNT(*)::text                                           AS count,
            BOOL_OR(user_id = ${callerUuid}::uuid)                   AS reacted_by_me
        FROM interaction_reactions
        WHERE target_type = ${targetType}
          AND target_id   = ${targetId}
        GROUP BY emoji
        ORDER BY COUNT(*) DESC, emoji
    `;
}

// ── Reactions — writes ────────────────────────────────────────────────────────

/**
 * Upsert a reaction (emoji) by a user on a target (idempotent).
 *
 * The unique constraint (target_type, target_id, user_id, emoji) is the upsert
 * key — calling this twice with the same args is a no-op.
 */
export async function upsertReaction(
    sql: postgres.Sql,
    params: {
        targetType: InteractionTargetType;
        targetId: string;
        userId: string;
        emoji: string;
    },
): Promise<void> {
    // Target access is checked by the interaction API/service; this locks target existence.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await sql`
        INSERT INTO interaction_reactions (target_type, target_id, user_id, emoji)
        SELECT ${params.targetType}, ${params.targetId}, ${params.userId}::uuid, ${params.emoji}
        WHERE ${params.targetType} <> 'media' OR EXISTS (
            SELECT 1 FROM media_items WHERE id = ${isUuid(params.targetId) ? normalizeUuid(params.targetId) : null}::uuid FOR KEY SHARE
        )
        ON CONFLICT (target_type, target_id, user_id, emoji) DO NOTHING
    `;
}

/**
 * Remove a specific reaction by a user on a target.
 *
 * Silently succeeds when the reaction does not exist (idempotent DELETE).
 */
export async function deleteReaction(
    sql: postgres.Sql,
    params: {
        targetType: InteractionTargetType;
        targetId: string;
        userId: string;
        emoji: string;
    },
): Promise<void> {
    await sql`
        DELETE FROM interaction_reactions
        WHERE target_type = ${params.targetType}
          AND target_id   = ${params.targetId}
          AND user_id     = ${params.userId}::uuid
          AND emoji       = ${params.emoji}
    `;
}
