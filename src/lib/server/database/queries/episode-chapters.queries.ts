// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Chapters Query Module
 *
 * Pure SQL queries for reading and writing chapter metadata.
 * Chapter data comes from Jellyfin or media file analysis.
 */

import type postgres from 'postgres';
import { withTx } from '../with-tx.js';
import { buildAutoEpisodeOrderingJoinFragment } from './episode-search.queries.js';
import type { ProbedStat } from '../../utils/scan-probe-cache.js';

/** Walked files whose current bytes have no successful chapter-probe marker. */
export async function findFilesNeedingChapterProbe(
    sql: postgres.Sql,
    paths: string[],
): Promise<Set<string>> {
    if (paths.length === 0) return new Set();
    const rows = await sql<{ file_path: string }[]>`
        SELECT file_path FROM media_files
        WHERE file_path = ANY(${paths}::text[])
          AND (chapters_probed_mtime IS NULL OR chapters_probed_size IS NULL
            OR chapters_probed_mtime IS DISTINCT FROM file_mtime
            OR chapters_probed_size IS DISTINCT FROM file_size_bytes)
    `;
    return new Set(rows.map((row) => row.file_path));
}

export interface EpisodeChapterRow {
    id: number;
    file_id: string;
    /**
     * Owning media item. NOT a column on `episode_chapters` — every getter has to
     * project it from `media_file_items`, because MediaChaptersResponseSchema
     * (which gates both /api/admin/media/{id}/chapters and the v1 twin) declares
     * it required-and-nullable: `.nullable()` accepts null but NOT undefined, so
     * a row missing the key entirely throws inside the handler's `.parse()`.
     */
    media_item_id: string | null;
    chapter_index: number;
    chapter_name: string | null;
    start_ticks: number; // bigint, parsed as number by driver
    end_ticks: number | null;
    source: string;
    fetched_at: Date;
}

/** Get all chapters for a media item (via its default file), ordered by index */
export async function getChaptersForEpisode(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<EpisodeChapterRow[]> {
    return sql<EpisodeChapterRow[]>`
        SELECT ec.*, mfi.media_item_id
        FROM episode_chapters ec
        JOIN media_file_items mfi ON mfi.file_id = ec.file_id
        WHERE mfi.media_item_id = ${mediaItemId}
          AND mfi.is_default = true
        ORDER BY ec.chapter_index
    `;
}

/** Get all chapters for a physical file, ordered by index.
 *  When mediaItemId is provided, verifies the file belongs to that item. */
export async function getChaptersForFile(
    sql: postgres.Sql,
    fileId: string,
    mediaItemId?: string,
): Promise<EpisodeChapterRow[]> {
    if (mediaItemId) {
        return sql<EpisodeChapterRow[]>`
            SELECT ec.*, mfi.media_item_id
            FROM episode_chapters ec
            JOIN media_file_items mfi ON mfi.file_id = ec.file_id
            WHERE ec.file_id = ${fileId}
              AND mfi.media_item_id = ${mediaItemId}
            ORDER BY ec.chapter_index
        `;
    }
    // No caller-supplied owner: pick one deterministically instead of joining.
    // media_file_items is keyed (file_id, media_item_id), so a plain JOIN would
    // return each chapter once per linked item (split episodes share a file) —
    // and `is_default` does not disambiguate, since it marks the default FILE
    // for an item, not the default item for a file. LATERAL keeps the row count
    // at one per chapter and yields NULL for an unlinked file.
    return sql<EpisodeChapterRow[]>`
        SELECT ec.*, owner.media_item_id
        FROM episode_chapters ec
        LEFT JOIN LATERAL (
            SELECT mfi.media_item_id
            FROM media_file_items mfi
            WHERE mfi.file_id = ec.file_id
            ORDER BY mfi.sort_order, mfi.media_item_id
            LIMIT 1
        ) owner ON true
        WHERE ec.file_id = ${fileId}
        ORDER BY ec.chapter_index
    `;
}

/** Get all chapters for all episodes of a series */
export async function getChaptersForSeries(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<EpisodeChapterRow[]> {
    return sql<EpisodeChapterRow[]>`
        SELECT ec.*, mfi.media_item_id FROM episode_chapters ec
        JOIN media_file_items mfi ON mfi.file_id = ec.file_id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
        WHERE season.parent_id = ${seriesMediaId} AND mi.media_type = 'episode'
        ORDER BY COALESCE(eo.order_season_number, mi.season_number),
                 COALESCE(eo.order_episode_number, mi.episode_number),
                 ec.chapter_index
    `;
}

/** Batch upsert chapters for a physical media file (replaces existing) */
export async function upsertChaptersForFile(
    sql: postgres.Sql,
    fileId: string,
    chapters: Array<{
        chapterIndex: number;
        chapterName: string | null;
        startTicks: string;
        endTicks: string | null;
        source: string;
    }>,
    options: { allowUploadReplacement?: boolean } = {},
): Promise<void> {
    const rows = chapters.map((ch) => ({
        file_id: fileId,
        chapter_index: ch.chapterIndex,
        chapter_name: ch.chapterName,
        start_ticks: ch.startTicks,
        end_ticks: ch.endTicks,
        source: ch.source,
    }));

    await withTx(sql, async (tx) => {
        await tx`SELECT id FROM media_files WHERE id=${fileId} FOR UPDATE`;
        if (
            options.allowUploadReplacement ||
            chapters.some((chapter) => chapter.source === 'upload')
        ) {
            const protectedRows = await tx`SELECT 1 FROM episode_chapters WHERE file_id=${fileId}
                AND source NOT IN ('file','jellyfin','upload') LIMIT 1`;
            if (protectedRows.length) return;
        } else {
            const automatic = chapters.every(
                (ch) => ch.source === 'file' || ch.source === 'jellyfin',
            );
            if (automatic) {
                const protectedRows =
                    await tx`SELECT 1 FROM episode_chapters WHERE file_id=${fileId}
                    AND source NOT IN ('file','jellyfin') LIMIT 1`;
                if (protectedRows.length) return;
            }
        }
        await tx`DELETE FROM episode_chapters WHERE file_id = ${fileId}`;
        if (rows.length > 0) await tx`INSERT INTO episode_chapters ${tx(rows)}`;
    });
}

/** Check if chapters exist for a specific file (lightweight existence check) */
export async function hasChaptersForFile(sql: postgres.Sql, fileId: string): Promise<boolean> {
    const [row] = await sql`
        SELECT 1 FROM episode_chapters WHERE file_id = ${fileId} LIMIT 1
    `;
    return !!row;
}

/** Check if chapters exist for a media item */
export async function hasChapters(sql: postgres.Sql, mediaItemId: string): Promise<boolean> {
    const [row] = await sql`
        SELECT 1
        FROM episode_chapters ec
        JOIN media_file_items mfi ON mfi.file_id = ec.file_id
        WHERE mfi.media_item_id = ${mediaItemId}
        LIMIT 1
    `;
    return !!row;
}

/** Count episodes with chapters for a series */
export async function countEpisodesWithChapters(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<number> {
    const [row] = await sql`
        SELECT COUNT(DISTINCT mfi.media_item_id) AS count
        FROM episode_chapters ec
        JOIN media_file_items mfi ON mfi.file_id = ec.file_id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesMediaId} AND mi.media_type = 'episode'
    `;
    return Number(row?.count ?? 0);
}

/**
 * Record that this file's chapters were probed at `stat`, the stat the probe
 * itself saw, and stored as the probe returned them (or that it has none).
 * Readers trust the stored `source = 'file'` rows only while the marker matches
 * the row's stat, see {@link loadKnownFileChapters}.
 *
 * The write is conditional on the row still carrying `stat`. A file that changed
 * between the probe and this call has a different row stat, so nothing is marked
 * and its stale chapters are never trusted. Returns whether a row was marked.
 * Call it only after a successful probe whose result was stored unchanged.
 */
export async function markChaptersProbed(
    sql: postgres.Sql,
    fileId: string,
    stat: ProbedStat,
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE media_files
        SET chapters_probed_mtime = ${stat.mtime}::timestamptz,
            chapters_probed_size = ${stat.size}
        WHERE id = ${fileId}::uuid
          AND file_mtime = ${stat.mtime}::timestamptz
          AND file_size_bytes = ${stat.size}
        RETURNING id
    `;
    return rows.length > 0;
}

/** One stored chapter, in the shape the chapter detectors read. */
export interface KnownFileChapter {
    index: number;
    title: string | null;
    startTimeMs: number;
    endTimeMs: number;
}

/**
 * The chapters already known for a file, when they can stand in for a probe:
 * the file's chapter marker matches its stat (see {@link markChaptersProbed}).
 * Returns null when the file is unknown or the marker is missing or stale. An
 * empty `chapters` array means "probed, no chapters". Only `source = 'file'`
 * rows count, so chapters a Jellyfin fallback wrote are never mistaken for the
 * file's own.
 */
export async function loadKnownFileChapters(
    sql: postgres.Sql,
    fileId: string,
): Promise<{ chapters: KnownFileChapter[] } | null> {
    const rows = await sql<
        Array<{
            marker_valid: boolean | null;
            chapter_index: number | null;
            chapter_name: string | null;
            start_ticks: string | null;
            end_ticks: string | null;
        }>
    >`
        SELECT
            (mf.chapters_probed_mtime IS NOT NULL
                AND mf.chapters_probed_mtime = mf.file_mtime
                AND mf.chapters_probed_size = mf.file_size_bytes) AS marker_valid,
            ec.chapter_index,
            ec.chapter_name,
            ec.start_ticks,
            ec.end_ticks
        FROM media_files mf
        LEFT JOIN episode_chapters ec
            ON ec.file_id = mf.id AND ec.source = 'file'
        WHERE mf.id = ${fileId}::uuid
        ORDER BY ec.chapter_index
    `;
    const [first] = rows;
    if (!first || first.marker_valid !== true) return null;

    const chapters: KnownFileChapter[] = [];
    for (const row of rows) {
        if (row.chapter_index === null) continue;
        chapters.push({
            index: row.chapter_index,
            title: row.chapter_name,
            startTimeMs: Math.round(Number(row.start_ticks ?? 0) / 10000),
            endTimeMs: Math.round(Number(row.end_ticks ?? 0) / 10000),
        });
    }
    return { chapters };
}

/** Caller holds this transaction through the sidecar write and chapter import. */
export async function canUploadChaptersForFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<boolean> {
    await sql`SELECT id FROM media_files WHERE id=${fileId} FOR UPDATE`;
    const [row] = await sql`SELECT 1 FROM episode_chapters WHERE file_id=${fileId}
        AND source NOT IN ('file','jellyfin','upload') LIMIT 1`;
    return !row;
}
