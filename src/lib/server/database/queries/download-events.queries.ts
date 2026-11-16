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
}

/**
 * Start a download row, or re-open the open / recently ended one for the same
 * (user, file|rendition, device). Only an open row or one that ended `aborted`/`error`
 * is re-opened: a `completed` download and refusals (`denied`, `rate_limited`) never are.
 */
export async function startDownloadEvent(
    sql: postgres.Sql,
    e: DownloadEventInput,
): Promise<string> {
    const fileId = e.fileId ?? null;
    const renditionId = e.renditionId ?? null;
    const since = new Date(Date.now() - DOWNLOAD_REOPEN_WINDOW_MS);

    const reopened = await sql<{ id: string }[]>`
        UPDATE download_events
        SET ended_at = NULL, outcome = NULL, last_activity_at = now()
        WHERE id = (
            SELECT id FROM download_events
            WHERE user_id = ${e.userId}
              AND device_key = ${e.deviceKey}
              AND file_id IS NOT DISTINCT FROM ${fileId}
              AND rendition_id IS NOT DISTINCT FROM ${renditionId}
              AND (ended_at IS NULL
                   OR (ended_at > ${since} AND outcome IN ('aborted', 'error')))
            ORDER BY started_at DESC
            LIMIT 1
        )
        RETURNING id
    `;
    if (reopened[0]) return reopened[0].id;

    const rows = await sql<{ id: string }[]>`
        INSERT INTO download_events
            (user_id, media_item_id, file_id, rendition_id, surface, device_key,
             client_name, bytes_total, range_start)
        VALUES
            (${e.userId}, ${e.mediaItemId}, ${fileId}, ${renditionId}, ${e.surface},
             ${e.deviceKey}, ${e.clientName ?? null}, ${e.bytesTotal ?? null},
             ${e.rangeStart ?? null})
        RETURNING id
    `;
    return rows[0]!.id;
}

export async function updateDownloadEvent(
    sql: postgres.Sql,
    id: string,
    { bytesSentDelta }: { bytesSentDelta: number },
): Promise<void> {
    await sql`
        UPDATE download_events
        SET bytes_sent = bytes_sent + ${Math.max(0, Math.floor(bytesSentDelta))},
            last_activity_at = now()
        WHERE id = ${id}
    `;
}

/**
 * Close a row. `completed` when everything has been sent (bytes_sent >= bytes_total,
 * counting earlier segments of the same transfer), otherwise the given outcome; a
 * stream that merely ended naturally but did not cover the file is recorded as
 * `aborted` so the next segment re-opens it.
 */
export async function endDownloadEvent(
    sql: postgres.Sql,
    id: string,
    outcome: DownloadOutcome,
    { bytesSentDelta = 0 }: { bytesSentDelta?: number } = {},
): Promise<void> {
    await sql`
        UPDATE download_events
        SET bytes_sent = bytes_sent + ${Math.max(0, Math.floor(bytesSentDelta))},
            ended_at = now(),
            last_activity_at = now(),
            outcome = CASE
                WHEN bytes_total IS NULL THEN ${outcome}::text
                WHEN bytes_sent + ${Math.max(0, Math.floor(bytesSentDelta))} >= bytes_total
                    THEN 'completed'
                WHEN ${outcome}::text = 'completed' THEN 'aborted'
                ELSE ${outcome}::text
            END
        WHERE id = ${id}
    `;
}

export async function recordRefusedDownload(
    sql: postgres.Sql,
    e: DownloadEventInput,
    outcome: 'denied' | 'rate_limited',
): Promise<void> {
    await sql`
        INSERT INTO download_events
            (user_id, media_item_id, file_id, rendition_id, surface, device_key,
             client_name, bytes_total, range_start, ended_at, outcome)
        VALUES
            (${e.userId}, ${e.mediaItemId}, ${e.fileId ?? null}, ${e.renditionId ?? null},
             ${e.surface}, ${e.deviceKey}, ${e.clientName ?? null}, ${e.bytesTotal ?? null},
             ${e.rangeStart ?? null}, now(), ${outcome})
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
    };
}

export async function listDownloadEvents(
    sql: postgres.Sql,
    opts: { userId?: string; limit: number; before?: Date },
): Promise<DownloadEventRow[]> {
    const rows = await sql<Record<string, unknown>[]>`
        SELECT id, user_id, media_item_id, file_id, rendition_id, surface, device_key,
               client_name, bytes_total, bytes_sent, range_start, started_at,
               last_activity_at, ended_at, outcome
        FROM download_events
        WHERE (${opts.userId ?? null}::uuid IS NULL OR user_id = ${opts.userId ?? null})
          AND (${opts.before ?? null}::timestamptz IS NULL OR started_at < ${opts.before ?? null})
        ORDER BY started_at DESC
        LIMIT ${opts.limit}
    `;
    return rows.map(mapEventRow);
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
        SET ended_at = last_activity_at, outcome = 'aborted'
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
