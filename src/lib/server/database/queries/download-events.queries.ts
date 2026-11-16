// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * download_events: the log of download attempts on every surface (web, /j, /api/v1).
 *
 * One row per (user, file|rendition, device) transfer. A segmented or resumed
 * download (several Range requests from the same device within a few minutes)
 * re-opens and extends the same row instead of adding one per request.
 */

import type postgres from 'postgres';

export type DownloadSurface = 'web' | 'jellyfin' | 'api';
export type DownloadOutcome = 'completed' | 'aborted' | 'denied' | 'rate_limited' | 'error';

/**
 * An open row with no activity for this long belongs to a dead stream (a crashed replica
 * never ended it): a new request must not inherit its stream count. Matches the lease TTL.
 */
export const OPEN_ROW_STALE_MS = 30_000;

/** A successful ranged request that sent less than this (and does not start at 0) merges into the previous row. */
export const TINY_RANGE_MERGE_BYTES = 1024 * 1024;

/** An ended row younger than this is re-opened by the next request for the same transfer. */
export const DOWNLOAD_REOPEN_WINDOW_MS = 10 * 60_000;

export interface DownloadEventInput {
    userId: string;
    mediaItemId: string;
    fileId?: string | null;
    renditionId?: string | null;
    surface: DownloadSurface;
    deviceKey: string;
    clientName?: string | null;
    bytesTotal?: number | null;
    rangeStart?: number | null;
}

export interface DownloadEventRow {
    id: string;
    userId: string;
    mediaItemId: string;
    fileId: string | null;
    renditionId: string | null;
    surface: DownloadSurface;
    deviceKey: string;
    clientName: string | null;
    bytesTotal: number | null;
    bytesSent: number;
    rangeStart: number | null;
    startedAt: Date;
    lastActivityAt: Date;
    endedAt: Date | null;
    outcome: DownloadOutcome | null;
    /** Opaque keyset cursor `<started_at, microsecond precision>|<id>`: pass as `before` for older rows. */
    cursor: string;
}

/**
 * Start a download row, or join/re-open the one for the same (user, file|rendition,
 * device). An open row gains a stream (`open_streams` + 1); a row that ended `aborted`/
 * `error` within the reopen window is re-opened with one stream; a `completed` download
 * and refusals (`denied`, `rate_limited`) never are. Serialised per transfer by an
 * advisory lock, with the unique partial index on open rows (and ON CONFLICT) as the
 * backstop, so two simultaneous starts end up on ONE row.
 */
export async function startDownloadEvent(sql: postgres.Sql, e: DownloadEventInput): Promise<string>;
export async function startDownloadEvent(
    sql: postgres.Sql,
    e: DownloadEventInput,
    opts: { allowInsert?: () => boolean },
): Promise<string | null>;
export async function startDownloadEvent(
    sql: postgres.Sql,
    e: DownloadEventInput,
    /**
     * Asked right before a NEW row would be inserted (never for a join or a re-open): false
     * skips the insert and returns null. The per-user row budget charges only real inserts.
     */
    opts: { allowInsert?: () => boolean } = {},
): Promise<string | null> {
    const fileId = e.fileId ?? null;
    const renditionId = e.renditionId ?? null;
    const since = new Date(Date.now() - DOWNLOAD_REOPEN_WINDOW_MS);
    const staleBefore = new Date(Date.now() - OPEN_ROW_STALE_MS);
    const lockKey = `${e.userId}|${e.deviceKey}|${fileId ?? renditionId ?? ''}`;

    return await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

        const joined = await tx<{ id: string }[]>`
            UPDATE download_events
            SET open_streams = CASE WHEN last_activity_at < ${staleBefore}
                                    THEN 1 ELSE open_streams + 1 END,
                last_activity_at = now()
            WHERE id = (
                SELECT id FROM download_events
                WHERE user_id = ${e.userId}
                  AND device_key = ${e.deviceKey}
                  AND file_id IS NOT DISTINCT FROM ${fileId}
                  AND rendition_id IS NOT DISTINCT FROM ${renditionId}
                  AND ended_at IS NULL
                ORDER BY started_at DESC
                LIMIT 1
            )
            RETURNING id
        `;
        if (joined[0]) return joined[0].id;

        const reopened = await tx<{ id: string }[]>`
            UPDATE download_events
            SET ended_at = NULL, outcome = NULL, open_streams = 1, last_activity_at = now()
            WHERE id = (
                SELECT id FROM download_events
                WHERE user_id = ${e.userId}
                  AND device_key = ${e.deviceKey}
                  AND file_id IS NOT DISTINCT FROM ${fileId}
                  AND rendition_id IS NOT DISTINCT FROM ${renditionId}
                  AND ended_at > ${since} AND outcome IN ('aborted', 'error')
                ORDER BY started_at DESC
                LIMIT 1
            )
            RETURNING id
        `;
        if (reopened[0]) return reopened[0].id;

        if (opts.allowInsert && !opts.allowInsert()) return null;
        const rows = await tx<{ id: string }[]>`
            INSERT INTO download_events
                (user_id, media_item_id, file_id, rendition_id, surface, device_key,
                 client_name, bytes_total, range_start, open_streams)
            VALUES
                (${e.userId}, ${e.mediaItemId}, ${fileId}, ${renditionId}, ${e.surface},
                 ${e.deviceKey}, ${e.clientName ?? null}, ${e.bytesTotal ?? null},
                 ${e.rangeStart ?? null}, 1)
            ON CONFLICT (user_id, device_key, (COALESCE(file_id, rendition_id)))
                WHERE ended_at IS NULL
            DO UPDATE SET open_streams = CASE
                              WHEN download_events.last_activity_at < ${staleBefore}
                              THEN 1 ELSE download_events.open_streams + 1 END,
                          last_activity_at = now()
            RETURNING id
        `;
        return rows[0].id;
    });
}

export async function updateDownloadEvent(
    sql: postgres.Sql,
    id: string,
    { bytesSentDelta }: { bytesSentDelta: number },
): Promise<void> {
    const delta = Math.max(0, Math.floor(bytesSentDelta));
    await sql`
        UPDATE download_events
        SET bytes_sent = CASE WHEN bytes_total IS NULL THEN bytes_sent + ${delta}
                              ELSE LEAST(bytes_sent + ${delta}, bytes_total) END,
            last_activity_at = now()
        WHERE id = ${id}
    `;
}

/**
 * End one stream of a row. The row itself is only closed (ended_at / outcome set) when its
 * last open stream ends; until then it stays open. `completed` when everything was sent
 * (bytes_sent >= bytes_total, counting earlier segments), or when this stream ran to its
 * natural end and `reachedEnd` says its range covered the end of the file (a Range
 * request for the tail). Otherwise the given outcome; a stream that merely ended naturally
 * without covering the file is recorded as `aborted` so the next segment re-opens it.
 * bytes_sent never exceeds bytes_total (overlapping retries).
 */
export async function endDownloadEvent(
    sql: postgres.Sql,
    id: string,
    outcome: DownloadOutcome,
    {
        bytesSentDelta = 0,
        reachedEnd = false,
    }: { bytesSentDelta?: number; reachedEnd?: boolean } = {},
): Promise<void> {
    const delta = Math.max(0, Math.floor(bytesSentDelta));
    await sql`
        UPDATE download_events
        SET bytes_sent = CASE WHEN bytes_total IS NULL THEN bytes_sent + ${delta}
                              ELSE LEAST(bytes_sent + ${delta}, bytes_total) END,
            last_activity_at = now(),
            open_streams = GREATEST(open_streams - 1, 0),
            ended_at = CASE WHEN open_streams <= 1 THEN now() ELSE NULL END,
            outcome = CASE
                WHEN open_streams > 1 THEN NULL
                WHEN bytes_total IS NULL THEN ${outcome}::text
                WHEN bytes_sent + ${delta} >= bytes_total THEN 'completed'
                WHEN ${outcome}::text = 'completed' AND ${reachedEnd}::boolean THEN 'completed'
                WHEN ${outcome}::text = 'completed' THEN 'aborted'
                ELSE ${outcome}::text
            END
        WHERE id = ${id}
    `;
}

/**
 * A just-ended row for a tiny successful range request (not from byte 0, under
 * TINY_RANGE_MERGE_BYTES) is folded into the latest earlier row of the same transfer within
 * the reopen window, whatever that row's outcome (refusals included: a refusal ranks lowest, so
 * the completed outcome replaces it): bytes are added (capped
 * at the total), the better outcome wins (completed > aborted > error) and the tiny row is
 * deleted. Without it a client could write one row per few-byte Range request. Returns true
 * when merged. No earlier row, or the row is still open, leaves it alone.
 */
export async function mergeTinyRangeEvent(sql: postgres.Sql, id: string): Promise<boolean> {
    const since = new Date(Date.now() - DOWNLOAD_REOPEN_WINDOW_MS);
    return await sql.begin(async (tx) => {
        type SourceRow = {
            user_id: string;
            device_key: string;
            file_id: string | null;
            rendition_id: string | null;
            bytes_sent: string;
            outcome: DownloadOutcome | null;
            ended_at: Date | null;
        };
        // The row's identity is immutable, so it can be read before the lock only to build
        // the lock key; its STATE (closed or reopened by a join) is read again after it.
        const [probe] = await tx<Pick<SourceRow, 'user_id' | 'device_key' | 'file_id' | 'rendition_id'>[]>`
            SELECT user_id, device_key, file_id, rendition_id FROM download_events WHERE id = ${id}`;
        if (!probe) return false;
        const lockKey = `${probe.user_id}|${probe.device_key}|${probe.file_id ?? probe.rendition_id ?? ''}`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        // Same lock as startDownloadEvent: a concurrent join cannot slip in now. Re-read the
        // source under it and make sure it is still closed before merging and deleting it.
        const [row] = await tx<SourceRow[]>`
            SELECT user_id, device_key, file_id, rendition_id, bytes_sent, outcome, ended_at
            FROM download_events WHERE id = ${id} FOR UPDATE`;
        if (!row || !row.ended_at) return false;
        const [target] = await tx<{ id: string; outcome: DownloadOutcome | null }[]>`
            SELECT id, outcome FROM download_events
            WHERE user_id = ${row.user_id}
              AND device_key = ${row.device_key}
              AND file_id IS NOT DISTINCT FROM ${row.file_id}
              AND rendition_id IS NOT DISTINCT FROM ${row.rendition_id}
              AND id <> ${id}
              AND (ended_at IS NULL OR ended_at > ${since})
            ORDER BY started_at DESC
            LIMIT 1
        `;
        if (!target) return false;
        const rank = (o: DownloadOutcome | null): number =>
            o === 'completed' ? 3 : o === 'aborted' ? 2 : o === 'error' ? 1 : 0;
        const better = rank(row.outcome) > rank(target.outcome) ? row.outcome : target.outcome;
        await tx`
            UPDATE download_events
            SET bytes_sent = CASE WHEN bytes_total IS NULL THEN bytes_sent + ${row.bytes_sent}::bigint
                                  ELSE LEAST(bytes_sent + ${row.bytes_sent}::bigint, bytes_total) END,
                outcome = CASE WHEN ended_at IS NULL THEN outcome ELSE ${better}::text END,
                last_activity_at = now()
            WHERE id = ${target.id}
        `;
        await tx`DELETE FROM download_events WHERE id = ${id}`;
        return true;
    });
}

export async function recordRefusedDownload(
    sql: postgres.Sql,
    e: DownloadEventInput,
    outcome: 'denied' | 'rate_limited',
): Promise<void> {
    await sql`
        INSERT INTO download_events
            (user_id, media_item_id, file_id, rendition_id, surface, device_key,
             client_name, bytes_total, range_start, ended_at, outcome, open_streams)
        VALUES
            (${e.userId}, ${e.mediaItemId}, ${e.fileId ?? null}, ${e.renditionId ?? null},
             ${e.surface}, ${e.deviceKey}, ${e.clientName ?? null}, ${e.bytesTotal ?? null},
             ${e.rangeStart ?? null}, now(), ${outcome}, 0)
    `;
}

function mapEventRow(r: Record<string, unknown>): DownloadEventRow {
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    return {
        id: r.id as string,
        userId: r.user_id as string,
        mediaItemId: r.media_item_id as string,
        fileId: (r.file_id as string | null) ?? null,
        renditionId: (r.rendition_id as string | null) ?? null,
        surface: r.surface as DownloadSurface,
        deviceKey: r.device_key as string,
        clientName: (r.client_name as string | null) ?? null,
        bytesTotal: num(r.bytes_total),
        bytesSent: Number(r.bytes_sent),
        rangeStart: num(r.range_start),
        startedAt: r.started_at as Date,
        lastActivityAt: r.last_activity_at as Date,
        endedAt: (r.ended_at as Date | null) ?? null,
        outcome: (r.outcome as DownloadOutcome | null) ?? null,
        cursor: (r.cursor as string | undefined) ?? '',
    };
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/i;

/** True for a cursor string as produced by `listDownloadEvents` (`DownloadEventRow.cursor`). */
export function isDownloadCursor(v: string): boolean {
    return CURSOR_RE.test(v);
}

export async function listDownloadEvents(
    sql: postgres.Sql,
    opts: { userId?: string; limit: number; before?: string },
): Promise<DownloadEventRow[]> {
    const m = opts.before ? CURSOR_RE.exec(opts.before) : null;
    if (opts.before && !m) throw new Error('invalid download cursor');
    const ts = m?.[1] ?? null;
    const cursorId = m?.[2] ?? null;
    // The cursor timestamp goes in as text (cast in SQL): postgres.js would turn a
    // `::timestamptz` parameter into a JS Date and cut it to milliseconds.
    const rows = await sql<Record<string, unknown>[]>`
        SELECT id, user_id, media_item_id, file_id, rendition_id, surface, device_key,
               client_name, bytes_total, bytes_sent, range_start, started_at,
               last_activity_at, ended_at, outcome,
               to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                   || '|' || id::text AS cursor
        FROM download_events
        WHERE (${opts.userId ?? null}::uuid IS NULL OR user_id = ${opts.userId ?? null})
          AND (${ts}::text IS NULL
               OR (started_at, id) < (${ts}::text::timestamptz, ${cursorId}::uuid))
        ORDER BY started_at DESC, id DESC
        LIMIT ${opts.limit}
    `;
    return rows.map(mapEventRow);
}

/**
 * Whether a transfer of `fileId` (a file or rendition id) by the user shows in the log since
 * `since`: still open, or active/ended after it, refusals aside. Lets the web queue confirm
 * that a link it handed to the browser actually reached the server.
 */
export async function hasRecentDownloadStart(
    sql: postgres.Sql,
    userId: string,
    fileId: string,
    since: Date,
): Promise<boolean> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
        return false;
    }
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM download_events
        WHERE user_id = ${userId}
          AND (file_id = ${fileId} OR rendition_id = ${fileId})
          AND (outcome IS NULL OR outcome IN ('completed', 'aborted', 'error'))
          AND last_activity_at >= ${since}
        LIMIT 1
    `;
    return rows.length > 0;
}

/** Open rows (no end yet) of the given users, for matching running transfers to titles. */
export async function listOpenDownloadEvents(
    sql: postgres.Sql,
    userIds: string[],
): Promise<DownloadEventRow[]> {
    if (userIds.length === 0) return [];
    const rows = await sql<Record<string, unknown>[]>`
        SELECT id, user_id, media_item_id, file_id, rendition_id, surface, device_key,
               client_name, bytes_total, bytes_sent, range_start, started_at,
               last_activity_at, ended_at, outcome
        FROM download_events
        WHERE ended_at IS NULL AND user_id IN ${sql(userIds)}
        ORDER BY started_at DESC
    `;
    return rows.map(mapEventRow);
}

/**
 * Close rows left open by a crashed process: no activity since `idleBefore` means no
 * transfer is running. Ends them as `aborted` at their last activity. LIMIT-batched
 * for `pruneUntilDrained` (the cutoff is a Date).
 */
export async function closeStaleDownloadEvents(
    sql: postgres.Sql,
    idleBefore: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        UPDATE download_events
        SET ended_at = last_activity_at, outcome = 'aborted', open_streams = 0
        WHERE id IN (
            SELECT id FROM download_events
            WHERE ended_at IS NULL AND last_activity_at < ${idleBefore}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

export interface DownloadTitleInfo {
    title: string;
    seriesTitle: string | null;
    season: number | null;
    episode: number | null;
}

/** Display titles for media items (episodes carry their series title, season and episode number). */
export async function getDownloadTitles(
    sql: postgres.Sql,
    mediaItemIds: string[],
): Promise<Map<string, DownloadTitleInfo>> {
    const out = new Map<string, DownloadTitleInfo>();
    if (mediaItemIds.length === 0) return out;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only (api/admin/downloads requires admin)
    const rows = await sql<
        {
            id: string;
            title: string | null;
            series_title: string | null;
            season_number: number | null;
            episode_number: number | null;
        }[]
    >`
        SELECT mi.id, mi.title, series.title AS series_title,
               mi.season_number, mi.episode_number
        FROM media_items mi
        LEFT JOIN media_items season ON season.id = mi.parent_id AND mi.media_type = 'episode'
        LEFT JOIN media_items series ON series.id = CASE
            WHEN mi.media_type = 'season' THEN mi.parent_id
            WHEN mi.media_type = 'episode' THEN COALESCE(season.parent_id, mi.parent_id)
        END
        WHERE mi.id IN ${sql(mediaItemIds)}
    `;
    for (const r of rows) {
        out.set(r.id, {
            title: r.title ?? r.id,
            seriesTitle: r.series_title,
            season: r.season_number,
            episode: r.episode_number,
        });
    }
    return out;
}

export async function getUsernamesByIds(
    sql: postgres.Sql,
    userIds: string[],
): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (userIds.length === 0) return out;
    const rows = await sql<{ id: string; username: string }[]>`
        SELECT id, username FROM users WHERE id IN ${sql(userIds)}
    `;
    for (const r of rows) out.set(r.id, r.username);
    return out;
}

/** LIMIT-batched delete for `pruneUntilDrained` (the cutoff is a Date). */
export async function pruneDownloadEvents(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM download_events
        WHERE id IN (
            SELECT id FROM download_events
            WHERE started_at < ${cutoff} AND last_activity_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}

export async function deleteDownloadEventsOlderThan(
    sql: postgres.Sql,
    days: number,
): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    return pruneDownloadEvents(sql, cutoff, 2_147_483_647);
}
