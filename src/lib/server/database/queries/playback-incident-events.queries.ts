// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure SQL query module for playback_incident_events. No side effects,
 * no business logic (redaction/validation/truncation live in
 * playback-incident.service.ts, per the codebase's three-tier DB architecture).
 */

import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { PLAY_SESSION_ID_UUID_PATTERN } from './id-guards.js';
import {
    insertClientDiagnostics,
    enforceClientDiagnosticRowCap,
} from './client-diagnostics.queries.js';

// Re-exported for existing importers (e.g. delivery-windows.queries.ts); the
// constant itself now lives in id-guards.ts. New code should import it from
// there directly.
export { PLAY_SESSION_ID_UUID_PATTERN } from './id-guards.js';

export interface NewPlaybackIncidentEvent {
    attemptId: string;
    playSessionId: string;
    incidentAt: Date;
    triggerType: 'error' | 'reconnect' | 'terminal';
    errorType: string | null;
    stage: string | null;
    httpStatus: number | null;
    serverDiagnosticCode: string | null;
    reconnectCause: string | null;
    message: string | null;
    userId: string | null;
    deviceId: string | null;
    mediaId: string | null;
    timeline: unknown[];
    clientInfo: Record<string, unknown> | null;
    eventId?: string;
    platform?: 'ios' | 'tvos' | 'web' | 'other';
    appVersion?: string | null;
    appBuild?: string | null;
    osVersion?: string | null;
    deviceModel?: string | null;
    logTail?: unknown;
    summary?: string | null;
}

/**
 * Derives the legacy `platform` bucket from `clientInfo.platform` (as the
 * 16.268.0 migration's backfill does), falling back to 'other' when absent
 * or unrecognized. `client_diagnostics.platform` is NOT NULL, so every insert
 * needs a value even when the caller never supplied `opts.platform`.
 */
function platformFromClientInfo(
    info: Record<string, unknown> | null,
): 'ios' | 'tvos' | 'web' | 'other' {
    const p = typeof info?.platform === 'string' ? info.platform.toLowerCase() : '';
    return p === 'ios' || p === 'tvos' || p === 'web' ? p : 'other';
}

/**
 * Since migration 16.268.0 incidents live in client_diagnostics (kind = 'playback_incident').
 * This module keeps its legacy API and row shape so every existing consumer is unchanged.
 * Column mapping: legacy incident_at = cd.occurred_at (client time);
 * legacy occurred_at = cd.received_at (server time); the rest lives in cd.payload.
 */
function incidentColumns(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        cd.id, cd.attempt_id, COALESCE(cd.play_session_id, '') AS play_session_id,
        cd.occurred_at AS incident_at, cd.received_at AS occurred_at,
        cd.payload->>'triggerType' AS trigger_type,
        cd.payload->>'errorType' AS error_type,
        cd.payload->>'stage' AS stage,
        (cd.payload->>'httpStatus')::int AS http_status,
        cd.payload->>'serverDiagnosticCode' AS server_diagnostic_code,
        cd.payload->>'reconnectCause' AS reconnect_cause,
        cd.payload->>'message' AS message,
        cd.user_id, cd.device_id
    `;
}

export async function insertPlaybackIncidentEvent(
    sql: postgres.Sql,
    row: NewPlaybackIncidentEvent,
): Promise<{ id: number; inserted: boolean }> {
    if (!row.userId) throw new Error('playback incidents require an authenticated user');
    const eventId = row.eventId ?? randomUUID();
    const payload: Record<string, unknown> = {
        triggerType: row.triggerType,
        ...(row.errorType ? { errorType: row.errorType } : {}),
        ...(row.stage ? { stage: row.stage } : {}),
        ...(row.httpStatus !== null && row.httpStatus !== undefined
            ? { httpStatus: row.httpStatus }
            : {}),
        ...(row.serverDiagnosticCode ? { serverDiagnosticCode: row.serverDiagnosticCode } : {}),
        ...(row.reconnectCause ? { reconnectCause: row.reconnectCause } : {}),
        ...(row.message ? { message: row.message } : {}),
        timeline: row.timeline,
        ...(row.clientInfo ? { clientInfo: row.clientInfo } : {}),
        ...(row.logTail ? { logTail: row.logTail } : {}),
    };
    const serialized = JSON.stringify(payload);
    const insertedCount = await insertClientDiagnostics(sql, [
        {
            eventId,
            kind: 'playback_incident',
            userId: row.userId,
            deviceId: row.deviceId,
            platform: row.platform ?? platformFromClientInfo(row.clientInfo),
            appVersion: row.appVersion ?? null,
            appBuild: row.appBuild ?? null,
            osVersion: row.osVersion ?? null,
            deviceModel: row.deviceModel ?? null,
            playSessionId: row.playSessionId,
            attemptId: row.attemptId,
            mediaId: row.mediaId,
            occurredAt: row.incidentAt,
            fingerprint: null,
            occurrences: 1,
            summary: row.summary ?? (row.message ?? row.errorType ?? row.triggerType).slice(0, 200),
            payload,
            payloadBytes: Buffer.byteLength(serialized, 'utf8'),
        },
    ]);
    const [created] = await sql<{ id: number }[]>`
        SELECT id FROM client_diagnostics WHERE user_id = ${row.userId}::uuid AND event_id = ${eventId}::uuid
    `;
    return { id: created.id, inserted: insertedCount > 0 };
}

/**
 * Resolves EVERY unresolved row for this user+attempt, not just the most
 * recent one. A single attempt can accumulate multiple unresolved incidents
 * (e.g. two errors fired before recovery, or a flush that raced the
 * resolve), and a "most recent only" resolve leaves the earlier rows
 * permanently unresolved even though the attempt did recover. Returns the
 * count actually resolved (0 is a legitimate no-op — e.g. the triggering
 * flush was itself dropped by rate limiting).
 */
export async function resolveUnresolvedIncidentsByAttempt(
    sql: postgres.Sql,
    userId: string,
    attemptId: string,
): Promise<number> {
    const result = await sql`
        UPDATE client_diagnostics
        SET resolved_at = NOW()
        WHERE kind = 'playback_incident'
          AND user_id = ${userId}::uuid
          AND attempt_id = ${attemptId}
          AND resolved_at IS NULL
    `;
    return result.count;
}

/**
 * transcode_failure_events rows for every play_session_id this attempt has
 * ever used, not just the flush-time one — a reconnect renews the session id,
 * so scoping to a single session id would miss the pre-renewal leg.
 *
 * `userId` is REQUIRED, and the session-id subquery is scoped by it exactly
 * like {@link resolveUnresolvedIncidentsByAttempt}. attempt_id is a
 * client-generated string, not an unguessable token, and the ingest endpoint
 * does not verify that a reporter originated the attempt it names — so an
 * attempt-only subquery would happily pick up another user's incident rows
 * (and through them, another user's transcode failures) whenever a
 * play_session_id value can be guessed or replayed.
 */
export async function listCorrelatedTranscodeFailures(
    sql: postgres.Sql,
    attemptId: string,
    userId: string,
): Promise<{ occurred_at: Date; category: string; summary: string | null }[]> {
    return sql<{ occurred_at: Date; category: string; summary: string | null }[]>`
        SELECT tf.occurred_at, tf.category, tf.summary
        FROM transcode_failure_events tf
        WHERE tf.play_session_id IN (
            SELECT DISTINCT play_session_id
            FROM client_diagnostics
            WHERE kind = 'playback_incident'
              AND attempt_id = ${attemptId}
              AND user_id = ${userId}::uuid
        )
        ORDER BY tf.occurred_at DESC
    `;
}

/** LIMIT-batched delete, driven by pruneUntilDrained. Mirrors
 *  pruneTranscodeFailureEvents. */
export async function prunePlaybackIncidentEvents(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM client_diagnostics
        WHERE id IN (
            SELECT id FROM client_diagnostics
            WHERE kind = 'playback_incident' AND received_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/**
 * LIMIT-batched delete over the FROZEN legacy `playback_incident_events` table, driven by
 * pruneUntilDrained. Migration 16.268.0 copied its rows into client_diagnostics but kept
 * the table (dropped by a later migration); until then its rows still hold personal
 * data and must age out on the same PLAYBACK_INCIDENT_RETENTION_DAYS window. Keyed by
 * the legacy `occurred_at` (server receipt time — the legacy naming trap: `incident_at`
 * is the client clock). A no-op returning 0 once the table no longer exists.
 */
export async function pruneLegacyPlaybackIncidentEvents(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const [reg] = await sql<{ exists: string | null }[]>`
        SELECT to_regclass('public.playback_incident_events')::text AS exists
    `;
    if (!reg?.exists) return 0;
    const result = await sql`
        DELETE FROM playback_incident_events
        WHERE id IN (
            SELECT id FROM playback_incident_events
            WHERE occurred_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/** Backstop that survives a maintenance task that never runs: caps each
 *  user's row count, independent of retention. A single bounded pass per
 *  cleanup run is sufficient — this is insurance, not the primary bound. */
export async function enforcePlaybackIncidentRowCap(
    sql: postgres.Sql,
    capPerUser: number,
    limit = 5_000,
): Promise<number> {
    return enforceClientDiagnosticRowCap(sql, ['playback_incident'], capPerUser, limit);
}

/** The full row shape for the admin list/detail surface — every column,
 *  `timeline`/`client_info` left as the JSONB shapes Postgres hands back. */
export interface PlaybackIncidentRow {
    id: number;
    attempt_id: string;
    play_session_id: string;
    incident_at: Date;
    occurred_at: Date;
    trigger_type: string;
    error_type: string | null;
    stage: string | null;
    http_status: number | null;
    server_diagnostic_code: string | null;
    reconnect_cause: string | null;
    message: string | null;
    user_id: string | null;
    device_id: string | null;
    media_id: string | null;
    timeline: unknown;
    client_info: Record<string, unknown> | null;
    resolved_at: Date | null;
    username: string | null;
    device_name: string | null;
    media_title: string | null;
}

export interface PlaybackIncidentListFilters {
    userId?: string;
    deviceId?: string;
    mediaId?: string;
    triggerType?: 'error' | 'reconnect' | 'terminal';
    from?: Date;
    to?: Date;
    limit: number;
    offset: number;
}

/**
 * Filtered, paginated, most-recent-first — backs the admin "By user/session"
 * lookup list. All filters are optional and AND'd together; an absent filter
 * is a no-op via the `(${x} IS NULL OR col = ${x})` idiom already used
 * elsewhere in this query layer (e.g. `ingest-map.queries.ts`).
 *
 * Ordering and the from/to window are on `received_at` (legacy `occurred_at`
 * = server receipt time), matching the legacy table's semantics exactly.
 */
export async function listPlaybackIncidents(
    sql: postgres.Sql,
    filters: PlaybackIncidentListFilters,
): Promise<{ rows: PlaybackIncidentRow[]; total: number }> {
    const { userId, deviceId, mediaId, triggerType, from, to, limit, offset } = filters;
    const conditions = sql`
        WHERE cd.kind = 'playback_incident'
          AND (${userId ?? null}::uuid IS NULL OR cd.user_id = ${userId ?? null}::uuid)
          AND (${deviceId ?? null}::text IS NULL OR cd.device_id = ${deviceId ?? null}::text)
          AND (${mediaId ?? null}::uuid IS NULL OR cd.media_id = ${mediaId ?? null}::uuid)
          AND (${triggerType ?? null}::text IS NULL OR cd.payload->>'triggerType' = ${triggerType ?? null}::text)
          AND (${from ?? null}::timestamptz IS NULL OR cd.received_at >= ${from ?? null}::timestamptz)
          AND (${to ?? null}::timestamptz IS NULL OR cd.received_at <= ${to ?? null}::timestamptz)
    `;
    const [rows, countRows] = await Promise.all([
        // Admin-only diagnostics query; media title is display context, not a user-scoped result.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        sql<PlaybackIncidentRow[]>`
            SELECT ${incidentColumns(sql)},
                   COALESCE(cd.media_id, ps.media_id) AS media_id,
                   COALESCE(cd.payload->'timeline', '[]'::jsonb) AS timeline,
                   cd.payload->'clientInfo' AS client_info,
                   cd.resolved_at,
                   u.username,
                   COALESCE(ud.custom_name, ud.reported_name) AS device_name,
                   mi.title AS media_title
            FROM client_diagnostics cd
            LEFT JOIN play_sessions ps
                ON ps.id = (CASE WHEN lower(cd.play_session_id) ~ ${PLAY_SESSION_ID_UUID_PATTERN}
                                  THEN lower(cd.play_session_id)::uuid END)
                AND ps.user_id = cd.user_id
            LEFT JOIN users u ON u.id = cd.user_id
            LEFT JOIN user_devices ud ON ud.user_id = cd.user_id AND ud.device_id = cd.device_id
            LEFT JOIN media_items mi ON mi.id = COALESCE(cd.media_id, ps.media_id)
            ${conditions}
            ORDER BY cd.received_at DESC
            LIMIT ${limit} OFFSET ${offset}
        `,
        sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM client_diagnostics cd
            ${conditions}
        `,
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
}

/** One incident's full row, or null when it doesn't exist — backs the admin detail drawer. */
export async function getPlaybackIncidentById(
    sql: postgres.Sql,
    id: number,
): Promise<PlaybackIncidentRow | null> {
    // Admin-only diagnostics query; media title is display context, not a user-scoped result.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<PlaybackIncidentRow[]>`
        SELECT ${incidentColumns(sql)},
               COALESCE(cd.media_id, ps.media_id) AS media_id,
               COALESCE(cd.payload->'timeline', '[]'::jsonb) AS timeline,
               cd.payload->'clientInfo' AS client_info,
               cd.resolved_at,
               u.username,
               COALESCE(ud.custom_name, ud.reported_name) AS device_name,
               mi.title AS media_title
        FROM client_diagnostics cd
        LEFT JOIN play_sessions ps
            ON ps.id = (CASE WHEN lower(cd.play_session_id) ~ ${PLAY_SESSION_ID_UUID_PATTERN}
                              THEN lower(cd.play_session_id)::uuid END)
            AND ps.user_id = cd.user_id
        LEFT JOIN users u ON u.id = cd.user_id
        LEFT JOIN user_devices ud ON ud.user_id = cd.user_id AND ud.device_id = cd.device_id
        LEFT JOIN media_items mi ON mi.id = COALESCE(cd.media_id, ps.media_id)
        WHERE cd.id = ${id} AND cd.kind = 'playback_incident'
    `;
    return rows[0] ?? null;
}

/** Clear one incident — the admin list's per-row clear button. Returns rows removed (0 = not found). */
export async function deletePlaybackIncidentById(sql: postgres.Sql, id: number): Promise<number> {
    const result =
        await sql`DELETE FROM client_diagnostics WHERE id = ${id} AND kind = 'playback_incident'`;
    return result.count;
}

/**
 * Clear incidents in bulk — the admin list's clear-all button.
 *
 * `userId` is honoured so that clearing while the page is filtered to one user
 * (`?userId=…`, how the health-invariant deep-links land here) clears only the
 * rows on screen. Absent filter = clear every playback_incident row, using the
 * same `(${x} IS NULL OR col = ${x})` idiom as {@link listPlaybackIncidents} so
 * one statement covers both.
 */
export async function deletePlaybackIncidents(
    sql: postgres.Sql,
    filters: { userId?: string } = {},
): Promise<number> {
    const { userId } = filters;
    const result = await sql`
        DELETE FROM client_diagnostics
         WHERE kind = 'playback_incident'
           AND (${userId ?? null}::uuid IS NULL OR user_id = ${userId ?? null}::uuid)
    `;
    return result.count;
}

/**
 * Summarized, identity-free rows for the Instance Diagnostics bundle —
 * deliberately excludes user_id/device_id/timeline (unlike
 * {@link PlaybackIncidentRow}), since that bundle is meant to be paste-safe
 * into a public issue. Mirrors `listRecentFailures` in
 * transcode-failure-events.queries.ts.
 */
export async function listRecentIncidentFailures(
    sql: postgres.Sql,
    limit: number,
): Promise<
    {
        occurred_at: Date;
        trigger_type: string;
        error_type: string | null;
        reconnect_cause: string | null;
        server_diagnostic_code: string | null;
    }[]
> {
    return sql`
        SELECT received_at AS occurred_at,
               payload->>'triggerType' AS trigger_type,
               payload->>'errorType' AS error_type,
               payload->>'reconnectCause' AS reconnect_cause,
               payload->>'serverDiagnosticCode' AS server_diagnostic_code
        FROM client_diagnostics
        WHERE kind = 'playback_incident'
        ORDER BY received_at DESC
        LIMIT ${limit}
    `;
}
