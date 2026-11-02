// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure SQL query module for segment_delivery_failures. No side effects and no
 * business logic — classification of a response into a category/resource kind
 * lives in segment-delivery-failure.service.ts, per the three-tier DB
 * architecture.
 */

import type postgres from 'postgres';

/**
 * `segment_delivery_failures.play_session_id` is free text (see the migration:
 * native clients send Swift's UPPERCASE `UUID().uuidString`, and non-UUID ids
 * reach the handler on malformed requests), so joining it against the
 * `play_sessions.id` uuid column needs a guarded cast.
 *
 * The CASE is load-bearing and must not be flattened into
 * `col ~ pattern AND col::uuid = ...`: Postgres does not guarantee
 * left-to-right short-circuit evaluation of AND subexpressions in a JOIN's ON
 * clause, so a non-UUID id still throws "invalid input syntax for type uuid"
 * with the regex ANDed in front. CASE's WHEN/THEN order IS guaranteed. This is
 * the same trap `playback-incident-events.queries.ts` documents, and its
 * integration test caught.
 *
 * `lower()` before the match because the stored id preserves the client's
 * spelling while `play_sessions.id` comes back lowercased.
 */
const PLAY_SESSION_ID_UUID_PATTERN =
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** Broad reason a response was not 2xx. */
export type SegmentFailureCategory =
    /** Live job, resource not written yet — answered 503 + Retry-After. */
    | 'not_ready'
    /** Resource genuinely gone: session ended, cleanup removed the output. */
    | 'gone'
    /** Ownership/auth rejection for the requested play session. */
    | 'forbidden'
    /** Malformed request (missing PlaySessionId, bad path). */
    | 'bad_request'
    /** Unhandled server-side error while serving. */
    | 'server_error';

/** What was being fetched, derived from the request path's shape. */
export type SegmentResourceKind =
    'segment' | 'init' | 'media_playlist' | 'master_playlist' | 'subtitle' | 'other';

export interface SegmentDeliveryFailureInput {
    playSessionId: string;
    category: SegmentFailureCategory;
    httpStatus: number;
    resourceKind: SegmentResourceKind;
    /** Stream directory (e.g. 'video_0'), or null when the path has none. */
    streamVariant: string | null;
}

/**
 * Upsert one failure onto its aggregate row, bumping the counter and the
 * last-seen stamp. Collapses a retry storm into a single row — see the
 * migration for why this table aggregates where its siblings append.
 */
export async function recordSegmentDeliveryFailure(
    sql: postgres.Sql,
    input: SegmentDeliveryFailureInput,
): Promise<void> {
    await sql`
        INSERT INTO segment_delivery_failures (
            play_session_id, category, http_status, resource_kind, stream_variant
        ) VALUES (
            ${input.playSessionId}, ${input.category}, ${input.httpStatus},
            ${input.resourceKind}, ${input.streamVariant}
        )
        ON CONFLICT (play_session_id, category, http_status, resource_kind,
                     COALESCE(stream_variant, ''))
        DO UPDATE SET
            occurrences  = segment_delivery_failures.occurrences + 1,
            last_seen_at = now()
    `;
}

export interface SegmentDeliveryFailureRow {
    id: string;
    play_session_id: string;
    category: SegmentFailureCategory;
    http_status: number;
    resource_kind: SegmentResourceKind;
    stream_variant: string | null;
    occurrences: number;
    first_seen_at: Date;
    last_seen_at: Date;
    /** Joined from play_sessions — null when the id matched no session. */
    user_id: string | null;
    media_id: string | null;
    username: string | null;
    device_id: string | null;
    client_name: string | null;
    media_title: string | null;
}

export interface SegmentDeliveryFailureFilters {
    playSessionId?: string;
    userId?: string;
    category?: SegmentFailureCategory;
    from?: Date;
    to?: Date;
    limit: number;
    offset: number;
}

/**
 * Filtered, paginated, most-recently-seen first. All filters are optional and
 * AND'd together via the `(${x} IS NULL OR col = ${x})` idiom used across this
 * query layer.
 *
 * `playSessionId` is matched case-insensitively: the caller pasting an id out
 * of a native client's log has the uppercase spelling, while one copied from
 * an admin surface reading play_sessions is lowercase, and both must find the
 * same rows.
 */
export type SegmentDeliveryFailureMatch = Omit<SegmentDeliveryFailureFilters, 'limit' | 'offset'>;

/** The JOIN + WHERE every filtered read and the filtered clear share. */
function failureFilterSql(
    sql: postgres.Sql,
    filters: SegmentDeliveryFailureMatch,
): {
    joined: postgres.PendingQuery<postgres.Row[]>;
    conditions: postgres.PendingQuery<postgres.Row[]>;
} {
    const { playSessionId, userId, category, from, to } = filters;
    const psid = playSessionId ? playSessionId.toLowerCase() : null;
    const joined = sql`
        LEFT JOIN play_sessions ps
            ON ps.id = (CASE WHEN lower(sdf.play_session_id) ~ ${PLAY_SESSION_ID_UUID_PATTERN}
                             THEN lower(sdf.play_session_id)::uuid END)
    `;
    const conditions = sql`
        WHERE (${psid}::text IS NULL OR lower(sdf.play_session_id) = ${psid}::text)
          AND (${userId ?? null}::uuid IS NULL OR ps.user_id = ${userId ?? null}::uuid)
          AND (${category ?? null}::text IS NULL OR sdf.category = ${category ?? null}::text)
          AND (${from ?? null}::timestamptz IS NULL OR sdf.last_seen_at >= ${from ?? null}::timestamptz)
          AND (${to ?? null}::timestamptz IS NULL OR sdf.last_seen_at <= ${to ?? null}::timestamptz)
    `;
    return { joined, conditions };
}

/** True when no filter narrows the match (a clear would remove every row). */
export function isUnfilteredFailureMatch(filters: SegmentDeliveryFailureMatch): boolean {
    return (
        !filters.playSessionId &&
        !filters.userId &&
        !filters.category &&
        !filters.from &&
        !filters.to
    );
}

export async function listSegmentDeliveryFailures(
    sql: postgres.Sql,
    filters: SegmentDeliveryFailureFilters,
): Promise<{ rows: SegmentDeliveryFailureRow[]; total: number }> {
    const { limit, offset } = filters;
    const { joined, conditions } = failureFilterSql(sql, filters);
    const [rows, countRows] = await Promise.all([
        // Admin-only diagnostics query; media title is display context, not a user-scoped result.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        sql<SegmentDeliveryFailureRow[]>`
            SELECT sdf.id, sdf.play_session_id, sdf.category, sdf.http_status,
                   sdf.resource_kind, sdf.stream_variant, sdf.occurrences,
                   sdf.first_seen_at, sdf.last_seen_at,
                   ps.user_id, ps.media_id, ps.device_id, ps.client_name,
                   u.username, mi.title AS media_title
            FROM segment_delivery_failures sdf
            ${joined}
            LEFT JOIN users u ON u.id = ps.user_id
            LEFT JOIN media_items mi ON mi.id = ps.media_id
            ${conditions}
            -- id breaks ties: rows upserted in one batch share last_seen_at and
            -- would otherwise repeat or vanish across pages.
            ORDER BY sdf.last_seen_at DESC, sdf.id DESC
            LIMIT ${limit} OFFSET ${offset}
        `,
        sql<{ count: number }[]>`
            SELECT count(*)::int AS count
            FROM segment_delivery_failures sdf
            ${joined}
            ${conditions}
        `,
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
}

/**
 * Clear recorded failures matching the SAME filters the list honours, so a
 * filtered page clears exactly what it shows. With no filter every row goes —
 * the endpoint requires an explicit `all=1` for that.
 */
export async function deleteSegmentDeliveryFailures(
    sql: postgres.Sql,
    filters: SegmentDeliveryFailureMatch,
): Promise<number> {
    const { joined, conditions } = failureFilterSql(sql, filters);
    const deleted = await sql<{ id: string }[]>`
        DELETE FROM segment_delivery_failures
        WHERE id IN (
            SELECT sdf.id
            FROM segment_delivery_failures sdf
            ${joined}
            ${conditions}
        )
        RETURNING id
    `;
    return deleted.length;
}

/** Retention sweep — batched so a large backlog cannot hold a long write lock. */
export async function pruneSegmentDeliveryFailures(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const deleted = await sql<{ id: string }[]>`
        DELETE FROM segment_delivery_failures
        WHERE id IN (
            SELECT id FROM segment_delivery_failures
            WHERE last_seen_at < ${cutoff}
            LIMIT ${limit}
        )
        RETURNING id
    `;
    return deleted.length;
}
