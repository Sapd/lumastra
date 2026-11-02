// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External Subtitle Files Query Module
 *
 * Queries for the external_subtitle_files table (migration 11.47.0).
 * External subtitle files (.srt, .ass, .vtt, etc.) discovered alongside
 * video files during library scanning.
 */

import type postgres from 'postgres';

export interface ExternalSubtitleRow {
    id: string;
    file_id: string;
    subtitle_path: string;
    language: string | null;
    format: string;
    is_forced: boolean;
    is_sdh: boolean;
    created_at: Date;
    /**
     * Last time this row's CONTENT changed — NOT last time a scan saw the file.
     *
     * It meant the latter until 2026-08-27: the scanner re-registered every
     * sidecar on every cycle and the upsert stamped NOW() unconditionally, so
     * every row looked touched within the hour. The upsert is now conditional,
     * which is the point — but it silently narrows what this column can be read
     * to mean. Nothing consumes it today. A future vanished-sidecar reaper keyed
     * on staleness ("updated_at older than N days ⇒ gone") would classify ~8.6k
     * perfectly healthy rows as stale on its first run: a sidecar that never
     * changes never gets stamped again. Key such a sweep on a disk check, or add
     * a separate last_seen_at the scan stamps deliberately.
     */
    updated_at: Date;
}

export interface UpsertExternalSubtitleParams {
    fileId: string;
    subtitlePath: string;
    language: string | null;
    format: 'srt' | 'ass' | 'ssa' | 'vtt' | 'sub' | 'sup';
    isForced: boolean;
    isSDH: boolean;
}

/**
 * Returns the validated params object (no DB side-effects).
 * Used for unit testing param construction.
 */
export function buildUpsertExternalSubtitleQuery(
    params: UpsertExternalSubtitleParams,
): UpsertExternalSubtitleParams {
    return params;
}

/**
 * What an `upsertExternalSubtitle` call actually did to the row.
 *
 * `'unchanged'` is the steady state and the whole reason this function reports
 * anything at all: a library scan re-walks every sidecar on every cycle, so the
 * overwhelmingly common case is re-registering a row that is already exactly
 * right. Callers that count scan outcomes MUST NOT report that as 'added' — on
 * production, 8,571 of 8,595 sidecar rows were re-registered in a single scan
 * hour while the newest genuine insert was three weeks old, and the admin scan
 * table read `+8571 added` off it.
 */
export type ExternalSubtitleUpsertOutcome = 'inserted' | 'updated' | 'unchanged';

/**
 * Insert or update an external_subtitle_files row by subtitle_path.
 * On conflict (same path): updates all fields and updated_at — but ONLY when
 * one of them actually differs.
 */
export async function upsertExternalSubtitle(
    sql: postgres.Sql,
    params: UpsertExternalSubtitleParams,
): Promise<ExternalSubtitleUpsertOutcome> {
    const rows = await sql<{ inserted: boolean }[]>`
        INSERT INTO external_subtitle_files
            (file_id, subtitle_path, language, format, is_forced, is_sdh)
        VALUES (
            ${params.fileId},
            ${params.subtitlePath},
            ${params.language},
            ${params.format},
            ${params.isForced},
            ${params.isSDH}
        )
        ON CONFLICT (subtitle_path) DO UPDATE
            SET file_id      = EXCLUDED.file_id,
                language     = EXCLUDED.language,
                format       = EXCLUDED.format,
                is_forced    = EXCLUDED.is_forced,
                is_sdh       = EXCLUDED.is_sdh,
                updated_at   = NOW()
            -- Row-wise IS DISTINCT FROM, which is NULL-safe per column where a
            -- plain inequality would go UNKNOWN on a NULL language:
            -- an identical re-registration writes NOTHING. Without this the
            -- scanner rewrote every sidecar row on every cycle, burning a dead
            -- tuple per row per scan on a table where nothing had genuinely
            -- changed since 2026-08-04.
            WHERE (
                    external_subtitle_files.file_id,
                    external_subtitle_files.language,
                    external_subtitle_files.format,
                    external_subtitle_files.is_forced,
                    external_subtitle_files.is_sdh
                  ) IS DISTINCT FROM (
                    EXCLUDED.file_id,
                    EXCLUDED.language,
                    EXCLUDED.format,
                    EXCLUDED.is_forced,
                    EXCLUDED.is_sdh
                  )
        -- xmax = 0 is true only on a freshly INSERTed tuple. The DO UPDATE
        -- branch stamps xmax with the updating xid, so this separates a genuine
        -- first sighting from a re-registration that changed something.
        RETURNING (xmax = 0) AS inserted
    `;
    // No row came back: neither branch wrote. The insert can only be skipped by
    // the conflict, and the update only by the WHERE above — so this is exactly
    // "the row was already correct".
    if (rows.length === 0) return 'unchanged';
    return rows[0].inserted ? 'inserted' : 'updated';
}

/**
 * Get all external subtitles linked to a media_files row.
 * Ordered by language (nulls last), then forced status, then format.
 */
export async function getExternalSubtitlesForFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<ExternalSubtitleRow[]> {
    return sql<ExternalSubtitleRow[]>`
        SELECT * FROM external_subtitle_files
        WHERE file_id = ${fileId}
        ORDER BY language NULLS LAST, is_forced, format, subtitle_path
    `;
}

/**
 * Get all external subtitles for a media item (via media_file_items join).
 * Uses internal UUID to find linked video files then their subtitles.
 * Ordered by language (nulls last), then forced status, then format.
 */
export async function getExternalSubtitlesForMediaItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<ExternalSubtitleRow[]> {
    return sql<ExternalSubtitleRow[]>`
        SELECT esf.*
        FROM external_subtitle_files esf
        JOIN media_files mf ON esf.file_id = mf.id
        JOIN media_file_items mfi ON mf.id = mfi.file_id
        WHERE mfi.media_item_id = ${mediaItemId}
        ORDER BY esf.language NULLS LAST, esf.is_forced, esf.format, esf.subtitle_path
    `;
}

/**
 * Get external subtitles for a media item identified by Jellyfin item ID.
 * Used by subtitle-cache.service.ts to serve local files for IsExternal streams.
 *
 * Returns subtitles ordered consistently — caller selects by positional index
 * to approximate Jellyfin's stream ordering.
 */
export async function getExternalSubtitlesByJellyfinId(
    sql: postgres.Sql,
    jellyfinItemId: string,
): Promise<ExternalSubtitleRow[]> {
    return sql<ExternalSubtitleRow[]>`
        SELECT esf.*
        FROM external_subtitle_files esf
        JOIN media_files mf ON esf.file_id = mf.id
        JOIN media_file_items mfi ON mf.id = mfi.file_id
        JOIN media_items mi ON mfi.media_item_id = mi.id
        JOIN external_ids ei ON ei.media_id = mi.id
        WHERE ei.provider = 'jellyfin'
          AND ei.external_id = ${jellyfinItemId}
        ORDER BY esf.language NULLS LAST, esf.is_forced, esf.format, esf.subtitle_path
    `;
}

/**
 * Get a single external subtitle row by its UUID.
 */
export async function getExternalSubtitleById(
    sql: postgres.Sql,
    subtitleId: string,
): Promise<ExternalSubtitleRow | null> {
    const rows = await sql<ExternalSubtitleRow[]>`
        SELECT * FROM external_subtitle_files
        WHERE id = ${subtitleId}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Get a single external subtitle row by UUID, only if it belongs to the given
 * media item (verified via media_file_items join). Returns null if the subtitle
 * does not exist OR does not belong to the media item — prevents IDOR.
 */
export async function getExternalSubtitleByIdForMediaItem(
    sql: postgres.Sql,
    subtitleId: string,
    mediaItemId: string,
): Promise<ExternalSubtitleRow | null> {
    const rows = await sql<ExternalSubtitleRow[]>`
        SELECT esf.*
        FROM external_subtitle_files esf
        JOIN media_files mf ON esf.file_id = mf.id
        JOIN media_file_items mfi ON mf.id = mfi.file_id
        WHERE esf.id = ${subtitleId}
          AND mfi.media_item_id = ${mediaItemId}
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/** The columns of a sidecar row that `upsertExternalSubtitle` compares. */
export type ExternalSubtitleKey = Pick<
    ExternalSubtitleRow,
    'file_id' | 'language' | 'format' | 'is_forced' | 'is_sdh'
>;

/**
 * Every sidecar row under a library path, keyed by subtitle_path. One query per
 * scan lets the scanner recognise an unchanged sidecar without a round trip —
 * the per-sidecar upsert-that-writes-nothing was ~120ms apiece serially and
 * made up ~11 of a 12-minute /data/series scan on prod (5,728 sidecars).
 */
export async function loadExternalSubtitlesByPrefix(
    sql: postgres.Sql,
    pathPrefix: string,
): Promise<Map<string, ExternalSubtitleKey>> {
    const escaped = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped.endsWith('/') ? escaped : escaped + '/';
    const rows = await sql<(ExternalSubtitleKey & { subtitle_path: string })[]>`
        SELECT subtitle_path, file_id, language, format, is_forced, is_sdh
        FROM external_subtitle_files
        WHERE subtitle_path LIKE ${prefix + '%'} ESCAPE '\\'
    `;
    const map = new Map<string, ExternalSubtitleKey>();
    for (const { subtitle_path, ...key } of rows) map.set(subtitle_path, key);
    return map;
}
