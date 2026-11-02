// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure SQL for client_diagnostics / client_diagnostic_blobs. Validation, redaction and
 * budgets live in services/client-diagnostics/ingest.service.ts.
 */

import type postgres from 'postgres';
import type { DiagnosticKind } from '$lib/schemas/client-diagnostics.js';
import { PLAY_SESSION_ID_UUID_PATTERN } from './id-guards.js';
import { withTx } from '$lib/server/database/with-tx.js';

export interface NewClientDiagnostic {
    eventId: string;
    kind: DiagnosticKind;
    userId: string;
    deviceId: string | null;
    platform: 'ios' | 'tvos' | 'web' | 'other';
    appVersion: string | null;
    appBuild: string | null;
    osVersion: string | null;
    deviceModel: string | null;
    playSessionId: string | null;
    attemptId: string | null;
    mediaId: string | null;
    occurredAt: Date;
    fingerprint: string | null;
    occurrences: number;
    summary: string | null;
    payload: Record<string, unknown>;
    payloadBytes: number;
}

/**
 * Inserts one row inside the given `sql`/transaction, resolving `media_id` via
 * an existence probe (a stale/deleted uuid becomes NULL rather than tripping
 * the FK and losing the row — same reasoning as
 * {@link insertPlaybackIncidentEvent} in playback-incident-events.queries.ts).
 * Returns the inserted id, or null when (user_id, event_id) already exists.
 */
async function insertOne(
    sql: postgres.Sql,
    r: NewClientDiagnostic,
): Promise<{ id: number } | null> {
    // The media_items reference below is an FK existence probe on a write-only
    // telemetry insert: nothing about the item is returned to the caller, and
    // the response is identical whether the item exists or not, so there is no
    // access decision (and no existence oracle) here.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [inserted] = await sql<{ id: number }[]>`
        INSERT INTO client_diagnostics (
            event_id, kind, user_id, device_id, platform,
            app_version, app_build, os_version, device_model,
            play_session_id, attempt_id, media_id,
            occurred_at, fingerprint, occurrences, summary, payload, payload_bytes
        ) VALUES (
            ${r.eventId}, ${r.kind}, ${r.userId}::uuid, ${r.deviceId}, ${r.platform},
            ${r.appVersion}, ${r.appBuild}, ${r.osVersion}, ${r.deviceModel},
            ${r.playSessionId}, ${r.attemptId},
            (SELECT id FROM media_items WHERE id = ${r.mediaId}::uuid),
            ${r.occurredAt}, ${r.fingerprint}, ${r.occurrences}, ${r.summary},
            ${sql.json(r.payload as unknown as Record<string, never>)}, ${r.payloadBytes}
        )
        ON CONFLICT (user_id, event_id) DO NOTHING
        RETURNING id
    `;
    return inserted ?? null;
}

/**
 * Bulk insert; duplicates of (user_id, event_id) are skipped (idempotent
 * per-batch retry). Rows are inserted one at a time inside a single
 * transaction rather than via postgres.js's multi-row `sql(rows)` helper —
 * that helper does not compose with a `sql.json(...)` value per row cleanly,
 * and the media_id existence probe needs a per-row subquery anyway. Returns
 * the number of rows actually inserted (conflicts do not count).
 */
export async function insertClientDiagnostics(
    sql: postgres.Sql,
    rows: NewClientDiagnostic[],
): Promise<number> {
    if (rows.length === 0) return 0;
    return withTx(sql, async (tx) => {
        let count = 0;
        for (const r of rows) {
            if (await insertOne(tx, r)) count++;
        }
        return count;
    });
}

export async function insertLogBundle(
    sql: postgres.Sql,
    row: NewClientDiagnostic,
    blob: { content: Buffer; uncompressedBytes: number; sha256: string },
): Promise<{ id: number } | null> {
    return withTx(sql, async (tx) => {
        const created = await insertOne(tx, row);
        if (!created) return null;
        await tx`
            INSERT INTO client_diagnostic_blobs (diagnostic_id, content, content_bytes, uncompressed_bytes, sha256)
            VALUES (${created.id}, ${blob.content}, ${blob.content.length}, ${blob.uncompressedBytes}, ${blob.sha256})
        `;
        return created;
    });
}

/**
 * Sum of `payload_bytes` this user has sent in the last 24h — the daily byte budget's
 * spend counter. `excludeKinds` lets a caller keep budget-exempt kinds (playback_incident
 * is always-on and never counted against or charged to the budget — see ingest.service.ts)
 * out of the SUM entirely, not just out of what consumes it.
 */
export async function sumBytesLast24h(
    sql: postgres.Sql,
    userId: string,
    opts: { excludeKinds?: DiagnosticKind[] } = {},
): Promise<number> {
    const excludeKinds =
        opts.excludeKinds && opts.excludeKinds.length > 0 ? opts.excludeKinds : null;
    const [row] = await sql<{ total: string }[]>`
        SELECT COALESCE(SUM(payload_bytes), 0)::text AS total
        FROM client_diagnostics
        WHERE user_id = ${userId}::uuid AND received_at > now() - interval '1 day'
          AND (${excludeKinds}::text[] IS NULL OR kind <> ALL(${excludeKinds}::text[]))
    `;
    return Number(row?.total ?? 0);
}

/** Rows of `kind` this user sent in the rolling last 24 h (by server receipt time) —
 *  the playback-incident daily cap in ingest.service.ts. */
export async function countKindLast24h(
    sql: postgres.Sql,
    userId: string,
    kind: DiagnosticKind,
): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM client_diagnostics
        WHERE user_id = ${userId}::uuid AND kind = ${kind}
          AND received_at > now() - interval '1 day'
    `;
    return row?.n ?? 0;
}

export interface ClientDiagnosticRow {
    id: number;
    event_id: string;
    kind: DiagnosticKind;
    user_id: string | null;
    device_id: string | null;
    platform: 'ios' | 'tvos' | 'web' | 'other';
    app_version: string | null;
    app_build: string | null;
    os_version: string | null;
    device_model: string | null;
    play_session_id: string | null;
    attempt_id: string | null;
    media_id: string | null;
    occurred_at: Date;
    received_at: Date;
    fingerprint: string | null;
    occurrences: number;
    summary: string | null;
    payload: Record<string, unknown>;
    resolved_at: Date | null;
    username: string | null;
    device_name: string | null;
    media_title: string | null;
    has_blob: boolean;
}

export interface ClientDiagnosticListFilters {
    kinds?: DiagnosticKind[];
    platform?: string;
    userId?: string;
    deviceId?: string;
    appVersion?: string;
    fingerprint?: string;
    resolved?: boolean;
    from?: Date;
    to?: Date;
    q?: string;
    limit: number;
    offset: number;
}

/** Escapes ILIKE metacharacters (`%`, `_`, and the escape char itself) in a user-supplied search term. */
function escapeIlike(term: string): string {
    return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** A blank/whitespace-only string is "no filter", same as `undefined`. Shared by
 *  `whereClause` and `isFilterEmpty` so a blank string can never mean two
 *  different things to those two functions (e.g. `appVersion: ''` producing a
 *  `LIKE '%'` in the WHERE clause — matching every row with a non-null
 *  app_version — while `isFilterEmpty` still considered it "no filter set"
 *  and let an unguarded `deleteClientDiagnostics` run wide open). */
function normalizeStringFilter(v: string | undefined): string | undefined {
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

type NormalizedStringFilters = {
    platform: string | undefined;
    userId: string | undefined;
    deviceId: string | undefined;
    appVersion: string | undefined;
    fingerprint: string | undefined;
};

/** Normalizes every string-valued filter field once, for both `whereClause` and `isFilterEmpty`. */
function normalizeStringFilters(
    f: Pick<
        ClientDiagnosticListFilters,
        'platform' | 'userId' | 'deviceId' | 'appVersion' | 'fingerprint'
    >,
): NormalizedStringFilters {
    return {
        platform: normalizeStringFilter(f.platform),
        userId: normalizeStringFilter(f.userId),
        deviceId: normalizeStringFilter(f.deviceId),
        appVersion: normalizeStringFilter(f.appVersion),
        fingerprint: normalizeStringFilter(f.fingerprint),
    };
}

/** A blank/whitespace-only search term is "no filter", same as `undefined`. */
function normalizeQ(q: string | undefined): string | null {
    const normalized = normalizeStringFilter(q);
    return normalized ?? null;
}

function whereClause(
    sql: postgres.Sql,
    f: Omit<ClientDiagnosticListFilters, 'limit' | 'offset'>,
): postgres.PendingQuery<postgres.Row[]> {
    const kinds = f.kinds && f.kinds.length > 0 ? f.kinds : null;
    const { platform, userId, deviceId, appVersion, fingerprint } = normalizeStringFilters(f);
    const q = normalizeQ(f.q);
    // The short id shown in the admin UI (e.g. "7F3A-91C2") is the first 8 hex
    // chars of event_id with a dash in the middle — strip non-hex chars and
    // match it as a prefix of the dash-stripped event_id.
    const qHex = q ? q.replace(/[^0-9a-f]/gi, '').toLowerCase() : null;
    const qShort = qHex && qHex.length >= 4 ? qHex : null;
    const qLike = q ? `%${escapeIlike(q)}%` : null;
    return sql`
        WHERE (${kinds}::text[] IS NULL OR cd.kind = ANY(${kinds}::text[]))
          AND (${platform ?? null}::text IS NULL OR cd.platform = ${platform ?? null}::text)
          AND (${userId ?? null}::uuid IS NULL OR cd.user_id = ${userId ?? null}::uuid)
          AND (${deviceId ?? null}::text IS NULL OR cd.device_id = ${deviceId ?? null}::text)
          AND (${appVersion ?? null}::text IS NULL OR cd.app_version LIKE ${appVersion ? `${escapeIlike(appVersion)}%` : null})
          AND (${fingerprint ?? null}::text IS NULL OR cd.fingerprint = ${fingerprint ?? null}::text)
          AND (${f.resolved ?? null}::boolean IS NULL
               OR (${f.resolved ?? null}::boolean AND cd.resolved_at IS NOT NULL)
               OR (NOT ${f.resolved ?? null}::boolean AND cd.resolved_at IS NULL))
          AND (${f.from ?? null}::timestamptz IS NULL OR cd.occurred_at >= ${f.from ?? null}::timestamptz)
          AND (${f.to ?? null}::timestamptz IS NULL OR cd.occurred_at <= ${f.to ?? null}::timestamptz)
          AND (${q}::text IS NULL
               OR (${qShort}::text IS NOT NULL AND replace(cd.event_id::text, '-', '') LIKE ${qShort ? `${qShort}%` : null})
               OR cd.payload->>'errorId' = ${q}::text
               OR cd.summary ILIKE ${qLike})
    `;
}

/**
 * True when every filter field is absent/empty — i.e. the filter would match
 * every row. Used to guard {@link deleteClientDiagnostics} against an
 * accidental full-table delete. Uses the SAME string normalization as
 * `whereClause` (via `normalizeStringFilters`), so a blank/whitespace-only
 * string filter is treated as "not set" here exactly as it is in the WHERE
 * clause — never "set" in one and "unset" in the other.
 */
function isFilterEmpty(f: Omit<ClientDiagnosticListFilters, 'limit' | 'offset' | 'q'>): boolean {
    const { platform, userId, deviceId, appVersion, fingerprint } = normalizeStringFilters(f);
    return (
        (!f.kinds || f.kinds.length === 0) &&
        platform === undefined &&
        userId === undefined &&
        deviceId === undefined &&
        appVersion === undefined &&
        fingerprint === undefined &&
        f.resolved === undefined &&
        f.from === undefined &&
        f.to === undefined
    );
}

export async function listClientDiagnostics(
    sql: postgres.Sql,
    f: ClientDiagnosticListFilters,
): Promise<{ rows: ClientDiagnosticRow[]; total: number }> {
    const where = whereClause(sql, f);
    const [rows, count] = await Promise.all([
        // Admin-only diagnostics query; media title is display context.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        sql<ClientDiagnosticRow[]>`
            SELECT cd.id, cd.event_id, cd.kind, cd.user_id, cd.device_id, cd.platform,
                   cd.app_version, cd.app_build, cd.os_version, cd.device_model,
                   cd.play_session_id, cd.attempt_id,
                   COALESCE(mi_direct.id, mi_ps.id) AS media_id,
                   cd.occurred_at, cd.received_at, cd.fingerprint, cd.occurrences, cd.summary,
                   '{}'::jsonb AS payload, cd.resolved_at,
                   u.username, COALESCE(ud.custom_name, ud.reported_name) AS device_name,
                   COALESCE(mi_direct.title, mi_ps.title) AS media_title,
                   EXISTS (SELECT 1 FROM client_diagnostic_blobs b WHERE b.diagnostic_id = cd.id) AS has_blob
            FROM client_diagnostics cd
            LEFT JOIN play_sessions ps
                ON ps.id = (CASE WHEN lower(cd.play_session_id) ~ ${PLAY_SESSION_ID_UUID_PATTERN}
                                 THEN lower(cd.play_session_id)::uuid END)
                AND ps.user_id = cd.user_id
            LEFT JOIN users u ON u.id = cd.user_id
            LEFT JOIN user_devices ud ON ud.user_id = cd.user_id AND ud.device_id = cd.device_id
            -- media_id can point at a since-deleted media item; joining media_items
            -- separately for cd.media_id and ps.media_id (rather than
            -- COALESCE-ing the ids BEFORE the join) lets a dangling cd.media_id
            -- fall through to the play session's still-live item instead of
            -- hiding it behind a NULL join.
            LEFT JOIN media_items mi_direct ON mi_direct.id = cd.media_id
            LEFT JOIN media_items mi_ps ON mi_ps.id = ps.media_id
            ${where}
            ORDER BY cd.occurred_at DESC, cd.id DESC
            LIMIT ${f.limit} OFFSET ${f.offset}
        `,
        sql<{ count: number }[]>`SELECT count(*)::int AS count FROM client_diagnostics cd ${where}`,
    ]);
    return { rows, total: count[0]?.count ?? 0 };
}

export async function getClientDiagnosticById(
    sql: postgres.Sql,
    id: number,
): Promise<
    | (ClientDiagnosticRow & {
          blob_content_bytes: number | null;
          blob_uncompressed_bytes: number | null;
          blob_sha256: string | null;
      })
    | null
> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<
        (ClientDiagnosticRow & {
            blob_content_bytes: number | null;
            blob_uncompressed_bytes: number | null;
            blob_sha256: string | null;
        })[]
    >`
        SELECT cd.id, cd.event_id, cd.kind, cd.user_id, cd.device_id, cd.platform,
               cd.app_version, cd.app_build, cd.os_version, cd.device_model,
               cd.play_session_id, cd.attempt_id,
               COALESCE(mi_direct.id, mi_ps.id) AS media_id,
               cd.occurred_at, cd.received_at, cd.fingerprint, cd.occurrences, cd.summary,
               cd.payload, cd.resolved_at,
               u.username, COALESCE(ud.custom_name, ud.reported_name) AS device_name,
               COALESCE(mi_direct.title, mi_ps.title) AS media_title,
               (b.id IS NOT NULL) AS has_blob,
               b.content_bytes AS blob_content_bytes,
               b.uncompressed_bytes AS blob_uncompressed_bytes,
               b.sha256 AS blob_sha256
        FROM client_diagnostics cd
        LEFT JOIN client_diagnostic_blobs b ON b.diagnostic_id = cd.id
        LEFT JOIN play_sessions ps
            ON ps.id = (CASE WHEN lower(cd.play_session_id) ~ ${PLAY_SESSION_ID_UUID_PATTERN}
                             THEN lower(cd.play_session_id)::uuid END)
            AND ps.user_id = cd.user_id
        LEFT JOIN users u ON u.id = cd.user_id
        LEFT JOIN user_devices ud ON ud.user_id = cd.user_id AND ud.device_id = cd.device_id
        -- See listClientDiagnostics: a dangling cd.media_id must not hide the
        -- play session's still-live media item, so media_items is joined
        -- separately for each id and COALESCEd AFTER the join.
        LEFT JOIN media_items mi_direct ON mi_direct.id = cd.media_id
        LEFT JOIN media_items mi_ps ON mi_ps.id = ps.media_id
        WHERE cd.id = ${id}
    `;
    return rows[0] ?? null;
}

export async function getLogBundleBlob(
    sql: postgres.Sql,
    id: number,
): Promise<{ content: Buffer; event_id: string } | null> {
    const rows = await sql<{ content: Buffer; event_id: string }[]>`
        SELECT b.content, cd.event_id
        FROM client_diagnostic_blobs b JOIN client_diagnostics cd ON cd.id = b.diagnostic_id
        WHERE b.diagnostic_id = ${id}
    `;
    return rows[0] ?? null;
}

export async function deleteClientDiagnosticById(sql: postgres.Sql, id: number): Promise<number> {
    return (await sql`DELETE FROM client_diagnostics WHERE id = ${id}`).count;
}

/**
 * Bulk-clears rows matching the given filters. Refuses to run — throwing
 * before any SQL executes — when every filter field is absent/empty, since
 * that would delete the entire table; pass `{ allowAll: true }` for the rare
 * intentional "clear everything" action.
 */
export async function deleteClientDiagnostics(
    sql: postgres.Sql,
    f: Omit<ClientDiagnosticListFilters, 'limit' | 'offset' | 'q'>,
    opts: { allowAll?: boolean } = {},
): Promise<number> {
    if (isFilterEmpty(f) && !opts.allowAll) {
        throw new Error(
            'deleteClientDiagnostics: refusing to delete every row with no filters — pass { allowAll: true } to clear the entire table intentionally',
        );
    }
    const where = whereClause(sql, f);
    return (await sql`DELETE FROM client_diagnostics cd ${where}`).count;
}

export async function pruneClientDiagnostics(
    sql: postgres.Sql,
    kinds: DiagnosticKind[],
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM client_diagnostics
        WHERE id IN (
            SELECT id FROM client_diagnostics
            WHERE kind = ANY(${kinds}::text[]) AND received_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

export async function enforceClientDiagnosticRowCap(
    sql: postgres.Sql,
    kinds: DiagnosticKind[],
    capPerUser: number,
    limit = 5_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM client_diagnostics
        WHERE id IN (
            SELECT id FROM (
                SELECT id, received_at, ROW_NUMBER() OVER (
                    PARTITION BY user_id ORDER BY received_at DESC, id DESC
                ) AS rn
                FROM client_diagnostics
                WHERE user_id IS NOT NULL AND kind = ANY(${kinds}::text[])
            ) ranked
            WHERE rn > ${capPerUser}
            -- Deterministic candidate order: without this, a LIMIT-truncated
            -- partial pass picks an arbitrary subset each run. Oldest-first
            -- guarantees every pass makes forward progress.
            ORDER BY received_at ASC
            LIMIT ${limit}
        )
    `;
    return result.count;
}

/** Keep only the newest `keep` /j ClientLog bundles per (user, device). */
export async function pruneJellyfinBundlesForDevice(
    sql: postgres.Sql,
    userId: string,
    deviceId: string,
    keep: number,
): Promise<number> {
    const rows = await sql`
        DELETE FROM client_diagnostics WHERE id IN (
            SELECT id FROM client_diagnostics
            WHERE user_id = ${userId}::uuid AND device_id = ${deviceId} AND kind = 'log_bundle'
              AND payload->>'source' = 'jellyfin'
            ORDER BY received_at DESC, id DESC
            OFFSET ${keep}
        ) RETURNING id`;
    return rows.length;
}

/** One client-diagnostic group of the debug report's window, aggregated. */
export interface ClientDiagnosticGroupSummaryRow {
    kind: string;
    platform: string;
    appVersion: string | null;
    /** `none` for rows without a fingerprint. */
    fingerprint: string;
    count: number;
    firstSeen: Date;
    lastSeen: Date;
}

/**
 * Client diagnostics over the last `sinceHours`, grouped by kind, platform, app
 * version and fingerprint. Aggregates only: NO user, device, device model,
 * media, play session, payload or joined title column is read. Rows without a
 * fingerprint group under `none`.
 */
export async function summarizeClientDiagnostics(
    sql: postgres.Sql,
    { sinceHours }: { sinceHours: number },
): Promise<ClientDiagnosticGroupSummaryRow[]> {
    return sql<ClientDiagnosticGroupSummaryRow[]>`
        SELECT cd.kind AS kind,
               cd.platform AS platform,
               cd.app_version AS "appVersion",
               COALESCE(cd.fingerprint, 'none') AS fingerprint,
               COALESCE(SUM(cd.occurrences), 0)::int AS count,
               MIN(cd.occurred_at) AS "firstSeen",
               MAX(cd.occurred_at) AS "lastSeen"
        FROM client_diagnostics cd
        WHERE cd.occurred_at >= NOW() - (${sinceHours} || ' hours')::interval
        GROUP BY cd.kind, cd.platform, cd.app_version, COALESCE(cd.fingerprint, 'none')
        ORDER BY count DESC, fingerprint
        LIMIT 200
    `;
}

/** One recent event of a client-diagnostic group. Its summary is client-written text. */
export interface ClientDiagnosticGroupEventRow {
    occurredAt: Date;
    kind: string;
    platform: string;
    appVersion: string | null;
    osVersion: string | null;
    summary: string | null;
}

/**
 * The newest events of one group (`none` = rows without a fingerprint) in the
 * last `sinceHours`. Only occurrence time, kind, platform, versions and summary:
 * no user, device, payload or blob column.
 */
export async function listClientDiagnosticGroup(
    sql: postgres.Sql,
    fingerprint: string,
    { limit = 20, sinceHours = 24 }: { limit?: number; sinceHours?: number } = {},
): Promise<ClientDiagnosticGroupEventRow[]> {
    const match =
        fingerprint === 'none'
            ? sql`cd.fingerprint IS NULL`
            : sql`cd.fingerprint = ${fingerprint}`;
    return sql<ClientDiagnosticGroupEventRow[]>`
        SELECT cd.occurred_at AS "occurredAt",
               cd.kind AS kind,
               cd.platform AS platform,
               cd.app_version AS "appVersion",
               cd.os_version AS "osVersion",
               cd.summary AS summary
        FROM client_diagnostics cd
        WHERE ${match}
          AND cd.occurred_at >= NOW() - (${sinceHours} || ' hours')::interval
        ORDER BY cd.occurred_at DESC
        LIMIT ${limit}
    `;
}
