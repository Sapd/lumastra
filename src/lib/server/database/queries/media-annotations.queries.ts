// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnnotationRow {
    id: string;
    media_id: string;
    user_id: string;
    type: 'chat' | 'pin' | 'review';
    content: string;
    timestamp_seconds: string | null;
    created_at: Date;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

// Shared by annotations and social review enrichment on both API surfaces.
// A private author can still read their own annotations to manage them.
export async function getAnnotations(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        type?: 'chat' | 'pin' | 'review';
        limit?: number;
        currentUser?: UserId;
    },
): Promise<AnnotationRow[]> {
    const { mediaId, type, limit = 50, currentUser } = params;
    return sql<AnnotationRow[]>`
        SELECT a.id, a.media_id, a.user_id, a.type, a.content, a.timestamp_seconds, a.created_at
        FROM media_annotations a
        JOIN users u_priv ON u_priv.id = a.user_id
        WHERE a.media_id = ${mediaId}
          AND a.deleted_at IS NULL
          AND (
            u_priv.hide_streams IS NULL OR u_priv.hide_streams = false
            ${currentUser ? sql`OR a.user_id = ${currentUser}::uuid` : sql``}
          )
          ${type ? sql`AND a.type = ${type}` : sql``}
        ORDER BY a.created_at ASC
        LIMIT ${limit}
    `;
}

export async function createAnnotation(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        userId: UserId;
        type: 'chat' | 'pin' | 'review';
        content: string;
        timestampSeconds?: number;
    },
): Promise<AnnotationRow> {
    const { mediaId, userId, type, content, timestampSeconds } = params;
    const [row] = await sql<AnnotationRow[]>`
        INSERT INTO media_annotations (media_id, user_id, type, content, timestamp_seconds)
        VALUES (${mediaId}, ${userId}, ${type}, ${content}, ${timestampSeconds ?? null})
        RETURNING id, media_id, user_id, type, content, timestamp_seconds, created_at
    `;
    return row;
}

export async function upsertReview(
    sql: postgres.Sql,
    params: { mediaId: string; userId: UserId; content: string },
): Promise<AnnotationRow> {
    const [row] = await sql<AnnotationRow[]>`
        INSERT INTO media_annotations (media_id, user_id, type, content)
        VALUES (${params.mediaId}, ${params.userId}, 'review', ${params.content})
        ON CONFLICT (media_id, user_id)
        WHERE type = 'review' AND deleted_at IS NULL
        DO UPDATE SET content = EXCLUDED.content, deleted_at = NULL
        RETURNING id, media_id, user_id, type, content, timestamp_seconds, created_at
    `;
    return row;
}

export async function deleteAnnotation(
    sql: postgres.Sql,
    params: { annotationId: string; userId: UserId; isAdmin?: boolean },
): Promise<void> {
    if (params.isAdmin) {
        await sql`
            UPDATE media_annotations
            SET deleted_at = NOW()
            WHERE id = ${params.annotationId}
              AND deleted_at IS NULL
        `;
    } else {
        await sql`
            UPDATE media_annotations
            SET deleted_at = NOW()
            WHERE id = ${params.annotationId}
              AND user_id = ${params.userId}
              AND deleted_at IS NULL
        `;
    }
}

export async function getUserPinCount(
    sql: postgres.Sql,
    params: { mediaId: string; userId: UserId },
): Promise<number> {
    const [row] = await sql<[{ count: string }]>`
        SELECT COUNT(*) AS count
        FROM media_annotations
        WHERE media_id = ${params.mediaId}
          AND user_id = ${params.userId}
          AND type = 'pin'
          AND deleted_at IS NULL
    `;
    return parseInt(row.count, 10);
}
