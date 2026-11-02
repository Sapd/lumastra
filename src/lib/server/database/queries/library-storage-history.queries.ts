// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library storage history (migration 16.413.0): the daily size and free-space
 * snapshots behind the admin home growth sparkline and the disk-full estimate,
 * plus the reconstruction of the curve from `media_files` for the days before
 * the first snapshot.
 *
 * Each function takes `sql` first and has no side effects beyond the query.
 * The snapshot writer (`library-storage-snapshot` task) wraps the two writes of
 * a day in one transaction; readers go through `library-storage-growth.service`.
 *
 * Days are returned as `YYYY-MM-DD` text, never `Date`: a `date` column read
 * into a JS Date lands on midnight in the server's zone and shifts a day when
 * formatted in UTC.
 */

import type postgres from 'postgres';

/** One library path's filesystem, as the worker measured it today. */
export interface VolumeSnapshotInsert {
    libraryPathId: string;
    /** `stat().dev` of the path, as text (bigint-safe). */
    deviceId: string;
    freeBytes: number;
    totalBytes: number;
}

export interface DailyBytes {
    date: string;
    bytes: number;
}

export interface MediaTypeBytes {
    mediaType: string;
    bytes: number;
    fileCount: number;
}

export interface VolumeSnapshotRow {
    date: string;
    libraryPathId: string;
    deviceId: string;
    freeBytes: number;
    totalBytes: number;
    /** Library name of the path; null when the path or its library is gone. */
    libraryName: string | null;
}

function toNumber(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Replace the size snapshot of `takenOn` (default: today in the database's
 * zone) with one row per library and media type, computed from `media_files`.
 *
 * Delete-then-insert rather than upsert: a library that lost all its files
 * since the day's first run would otherwise keep its stale row. Files the
 * scanner marked missing still count, like the size on the admin home card:
 * a dropped mount marks thousands missing at once, and leaving them out drew
 * a "library shrank by 50 TB" cliff into the measured curve. A library's media type is
 * the one its paths declare; a group whose paths disagree takes the first
 * alphabetically, and files with no group count as `unknown`.
 */
export async function writeLibrarySizeSnapshot(
    sql: postgres.Sql,
    takenOn?: string,
): Promise<number> {
    const day = takenOn ? sql`${takenOn}::date` : sql`current_date`;
    await sql`DELETE FROM library_size_snapshots WHERE taken_on = ${day}`;
    const rows = await sql`
        INSERT INTO library_size_snapshots
            (taken_on, library_group_id, media_type, total_bytes, file_count)
        SELECT ${day},
               mf.library_group_id,
               COALESCE(lt.media_type, 'unknown'),
               COALESCE(SUM(mf.file_size_bytes), 0),
               COUNT(*)
        FROM media_files mf
        LEFT JOIN (
            SELECT library_group_id, MIN(media_type) AS media_type
            FROM library_paths
            GROUP BY library_group_id
        ) lt ON lt.library_group_id = mf.library_group_id
        GROUP BY mf.library_group_id, COALESCE(lt.media_type, 'unknown')
        RETURNING 1
    `;
    return rows.length;
}

/**
 * Record today's measurement per path (upsert). A path not measured in this
 * run keeps whatever an earlier run of the same day measured: a restart while
 * a mount is down must not erase the day's good reading. Unknown is not
 * "full", and it is not "nothing" either.
 */
export async function writeLibraryVolumeSnapshots(
    sql: postgres.Sql,
    rows: VolumeSnapshotInsert[],
    takenOn?: string,
): Promise<number> {
    const day = takenOn ? sql`${takenOn}::date` : sql`current_date`;
    if (rows.length === 0) return 0;
    const inserted = await sql`
        INSERT INTO library_volume_snapshots
            (taken_on, library_path_id, device_id, free_bytes, total_bytes)
        SELECT ${day}, v.library_path_id, v.device_id, v.free_bytes, v.total_bytes
        FROM UNNEST(
            ${rows.map((r) => r.libraryPathId)}::uuid[],
            ${rows.map((r) => r.deviceId)}::text[],
            ${rows.map((r) => Math.max(0, Math.round(r.freeBytes)))}::bigint[],
            ${rows.map((r) => Math.max(0, Math.round(r.totalBytes)))}::bigint[]
        ) AS v(library_path_id, device_id, free_bytes, total_bytes)
        ON CONFLICT (taken_on, library_path_id) DO UPDATE
            SET device_id = EXCLUDED.device_id,
                free_bytes = EXCLUDED.free_bytes,
                total_bytes = EXCLUDED.total_bytes
        RETURNING 1
    `;
    return inserted.length;
}

/** Drop snapshot rows older than `keepDays`. */
export async function pruneLibraryStorageSnapshots(
    sql: postgres.Sql,
    keepDays: number,
): Promise<number> {
    const days = Math.max(1, Math.floor(keepDays));
    const sizes = await sql`
        DELETE FROM library_size_snapshots
        WHERE taken_on < current_date - ${days}::int
        RETURNING 1
    `;
    const volumes = await sql`
        DELETE FROM library_volume_snapshots
        WHERE taken_on < current_date - ${days}::int
        RETURNING 1
    `;
    return sizes.length + volumes.length;
}

/** Total library bytes per snapshot day over the last `sinceDays`, oldest first. */
export async function getLibrarySizeSnapshotTotals(
    sql: postgres.Sql,
    sinceDays: number,
): Promise<DailyBytes[]> {
    const rows = await sql<{ date: string; bytes: string }[]>`
        SELECT to_char(taken_on, 'YYYY-MM-DD') AS date, SUM(total_bytes)::text AS bytes
        FROM library_size_snapshots
        WHERE taken_on >= current_date - ${Math.max(1, Math.floor(sinceDays))}::int
        GROUP BY taken_on
        ORDER BY taken_on
    `;
    return rows.map((r) => ({ date: r.date, bytes: toNumber(r.bytes) }));
}

/** The latest snapshot day split by media type, largest first. */
export async function getLatestLibrarySizeByMediaType(
    sql: postgres.Sql,
): Promise<MediaTypeBytes[]> {
    const rows = await sql<{ media_type: string; bytes: string; file_count: string }[]>`
        SELECT media_type, SUM(total_bytes)::text AS bytes, SUM(file_count)::text AS file_count
        FROM library_size_snapshots
        WHERE taken_on = (SELECT MAX(taken_on) FROM library_size_snapshots)
        GROUP BY media_type
        ORDER BY SUM(total_bytes) DESC, media_type
    `;
    return rows.map((r) => ({
        mediaType: r.media_type,
        bytes: toNumber(r.bytes),
        fileCount: toNumber(r.file_count),
    }));
}

/**
 * Bytes of the files the library holds now, grouped by the day each arrived.
 * The approximation behind the curve before the first snapshot.
 *
 * A file's day is the earlier of when Lumastra first saw it and its mtime. On
 * prod (2026-10) the first scan inserted 45 of 53 TB within one month, so
 * `created_at` alone draws a single cliff on the install date, on every new
 * install. The mtime spreads that over the years the files actually arrived on
 * disk. It backdates a file copied with its mtime preserved, which is why the
 * points stay labelled approximate and the estimate never reads them. An mtime
 * before 1990 is a broken clock (epoch 0 from some copy tools), not history.
 * Missing files count, as in the snapshots, so both halves of the curve agree.
 */
export async function getLibraryBackfillDaily(sql: postgres.Sql): Promise<DailyBytes[]> {
    const rows = await sql<{ date: string; bytes: string }[]>`
        SELECT to_char(d, 'YYYY-MM-DD') AS date, SUM(bytes)::text AS bytes
        FROM (
            SELECT CASE
                       WHEN file_mtime >= '1990-01-01'::timestamptz
                           THEN LEAST(created_at, file_mtime)
                       ELSE created_at
                   END::date AS d,
                   file_size_bytes AS bytes
            FROM media_files
            WHERE file_size_bytes IS NOT NULL
        ) f
        GROUP BY d
        ORDER BY d
    `;
    return rows.map((r) => ({ date: r.date, bytes: toNumber(r.bytes) }));
}

/** Volume snapshot rows of the last `sinceDays`, oldest first, with library names. */
export async function getLibraryVolumeSnapshots(
    sql: postgres.Sql,
    sinceDays: number,
): Promise<VolumeSnapshotRow[]> {
    const rows = await sql<
        {
            date: string;
            library_path_id: string;
            device_id: string;
            free_bytes: string;
            total_bytes: string;
            library_name: string | null;
        }[]
    >`
        SELECT to_char(v.taken_on, 'YYYY-MM-DD') AS date,
               v.library_path_id,
               v.device_id,
               v.free_bytes::text AS free_bytes,
               v.total_bytes::text AS total_bytes,
               COALESCE(NULLIF(lg.display_name, ''), lg.name) AS library_name
        FROM library_volume_snapshots v
        LEFT JOIN library_paths lp ON lp.id = v.library_path_id
        LEFT JOIN library_groups lg ON lg.id = lp.library_group_id
        WHERE v.taken_on >= current_date - ${Math.max(1, Math.floor(sinceDays))}::int
        ORDER BY v.taken_on, v.library_path_id
    `;
    return rows.map((r) => ({
        date: r.date,
        libraryPathId: r.library_path_id,
        deviceId: r.device_id,
        freeBytes: toNumber(r.free_bytes),
        totalBytes: toNumber(r.total_bytes),
        libraryName: r.library_name,
    }));
}

/** Today in the database's zone, the same day the snapshot writer stamps. */
export async function getDatabaseToday(sql: postgres.Sql): Promise<string> {
    const [row] = await sql<[{ today: string }]>`
        SELECT to_char(current_date, 'YYYY-MM-DD') AS today
    `;
    return row.today;
}
