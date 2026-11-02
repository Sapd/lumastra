// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reads for the admin file-episodes editor (manual-file-links.service.ts does
 * the writes): one file's links in file order, its chapters, and the episodes
 * of the series it can be linked to.
 */

import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { MANUAL_OFFSET_SOURCE } from '$lib/shared/manual-file-segments.js';

export interface FileEpisodeLink {
    mediaItemId: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    title: string | null;
    isDismissed: boolean;
    dismissedAt: string | null;
    isDefault: boolean;
    sortOrder: number;
    startMs: number | null;
    endMs: number | null;
    offsetSource: string | null;
    boundaryOrigin: string | null;
}

export interface FileEpisodeCandidate {
    id: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    title: string | null;
    isDismissed: boolean;
    dismissedAt: string | null;
    runtimeMs: number | null;
}

export interface FileEpisodeEditorData {
    revision: string;
    series?: { id: string; title: string | null };
    file: {
        id: string;
        filePath: string;
        durationMs: number | null;
        /** True when an admin set these links by hand. */
        manual: boolean;
    };
    links: FileEpisodeLink[];
    chapters: { name: string | null; startMs: number }[];
    episodes: FileEpisodeCandidate[];
}

/** Evidence relevant to a mapping review. Deliberately excludes watch/playback
 * state and generic updated_at values, which change during ordinary playback. */
export async function getFileEpisodeReviewRevision(
    sql: postgres.Sql,
    fileId: string,
    seriesId: string,
): Promise<string> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- explicit admin file/target evidence
    const [row] = await sql<{ evidence: postgres.JSONValue }[]>`
        WITH target AS (
            SELECT id FROM media_items WHERE id = ${seriesId}
            UNION SELECT id FROM media_items WHERE parent_id = ${seriesId}
            UNION SELECT ep.id FROM media_items ep JOIN media_items season ON season.id = ep.parent_id
                WHERE season.parent_id = ${seriesId}
        ), relevant AS (
            SELECT id FROM target
            UNION SELECT media_item_id FROM media_file_items WHERE file_id = ${fileId}
            UNION SELECT mi.parent_id FROM media_items mi JOIN media_file_items mfi ON mfi.media_item_id = mi.id WHERE mfi.file_id = ${fileId}
            UNION SELECT season.parent_id FROM media_items mi JOIN media_items season ON season.id = mi.parent_id
                JOIN media_file_items mfi ON mfi.media_item_id = mi.id WHERE mfi.file_id = ${fileId}
        )
        SELECT jsonb_build_object(
            'file', (SELECT jsonb_build_array(id, file_path, file_hash_head, file_size_bytes,
                file_mtime, duration_seconds, is_missing, chapters_probed_mtime, chapters_probed_size)
                FROM media_files WHERE id = ${fileId}),
            'hierarchy', (SELECT jsonb_agg(jsonb_build_array(id, parent_id, media_type, status,
                season_number, episode_number, title, runtime_seconds, is_dismissed, dismissed_at) ORDER BY id)
                FROM media_items WHERE id IN (SELECT id FROM relevant)),
            'links', (SELECT jsonb_agg(jsonb_build_array(mfi.file_id, mfi.media_item_id,
                mfi.is_default, mfi.sort_order, mfi.start_offset_ms, mfi.end_offset_ms,
                mfi.offset_source, mfi.boundary_origin) ORDER BY mfi.file_id, mfi.media_item_id)
                FROM media_file_items mfi WHERE mfi.file_id = ${fileId}
                    OR mfi.media_item_id IN (SELECT id FROM relevant)),
            'chapters', (SELECT jsonb_agg(jsonb_build_array(chapter_index, chapter_name,
                start_ticks, end_ticks, source) ORDER BY chapter_index)
                FROM episode_chapters WHERE file_id = ${fileId})
        ) AS evidence
    `;
    return createHash('sha256').update(JSON.stringify(row.evidence)).digest('hex');
}

function numOrNull(v: string | number | null): number | null {
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * The series a media item belongs to (itself for a series, the parent of a
 * season, the grandparent of an episode), or null.
 */
export async function resolveSeriesIdForItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<string | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin lookup by explicit id
    const [row] = await sql<{ series_id: string | null }[]>`
        SELECT CASE
            WHEN mi.media_type = 'tv' THEN mi.id
            WHEN mi.media_type = 'season' AND p.media_type = 'tv' AND p.status = 'active' THEN p.id
            WHEN mi.media_type = 'episode' AND p.media_type = 'season' AND p.status = 'active'
                AND gp.media_type = 'tv' AND gp.status = 'active' THEN gp.id
        END AS series_id
        FROM media_items mi
        LEFT JOIN media_items p ON p.id = mi.parent_id
        LEFT JOIN media_items gp ON gp.id = p.parent_id
        WHERE mi.id = ${mediaItemId} AND mi.status = 'active'
    `;
    return row?.series_id ?? null;
}

export async function getFileEpisodeEditorData(
    sql: postgres.Sql,
    fileId: string,
    seriesId: string,
    attempt = 0,
): Promise<FileEpisodeEditorData | null> {
    const revision = await getFileEpisodeReviewRevision(sql, fileId, seriesId);
    // File-episodes endpoint enforces auth.kind=admin before loading this explicit file/series.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin editor needs the target series title independently of viewer availability
    const [file] = await sql<
        {
            id: string;
            file_path: string;
            duration_seconds: number | null;
            series_title: string | null;
        }[]
    >`
        SELECT id, file_path, duration_seconds,
            (SELECT title FROM media_items WHERE id = ${seriesId}) AS series_title
        FROM media_files WHERE id = ${fileId}
    `;
    if (!file) return null;

    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin view of one file's links
    const links = await sql<
        {
            media_item_id: string;
            season_number: number | null;
            episode_number: number | null;
            title: string | null;
            is_dismissed: boolean;
            dismissed_at: string | null;
            is_default: boolean;
            sort_order: number;
            start_offset_ms: string | null;
            end_offset_ms: string | null;
            offset_source: string | null;
            boundary_origin: string | null;
        }[]
    >`
        SELECT mfi.media_item_id, mi.season_number, mi.episode_number, mi.title,
               mi.is_dismissed, mi.dismissed_at::text AS dismissed_at,
               mfi.is_default, mfi.sort_order,
               mfi.start_offset_ms, mfi.end_offset_ms, mfi.offset_source, mfi.boundary_origin
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mfi.file_id = ${fileId}
        ORDER BY mfi.start_offset_ms ASC NULLS LAST, mfi.sort_order,
                 mi.season_number NULLS LAST, mi.episode_number NULLS LAST
    `;

    const chapters = await sql<{ chapter_name: string | null; start_ms: string }[]>`
        SELECT chapter_name, (start_ticks / 10000)::bigint AS start_ms
        FROM episode_chapters
        WHERE file_id = ${fileId}
        ORDER BY chapter_index
    `;

    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin picker over one series
    const episodes = await sql<
        {
            id: string;
            season_number: number | null;
            episode_number: number | null;
            title: string | null;
            is_dismissed: boolean;
            dismissed_at: string | null;
            runtime_seconds: number | null;
        }[]
    >`
        SELECT ep.id, ep.season_number, ep.episode_number, ep.title, ep.runtime_seconds,
               ep.is_dismissed, ep.dismissed_at::text AS dismissed_at
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesId}
          AND ep.media_type = 'episode'
          AND ep.status = 'active' AND season.status = 'active'
        ORDER BY ep.season_number NULLS LAST, ep.episode_number NULLS LAST, ep.id
    `;

    if (revision !== (await getFileEpisodeReviewRevision(sql, fileId, seriesId))) {
        if (attempt >= 2) throw new Error('File mapping changed while loading its review.');
        return getFileEpisodeEditorData(sql, fileId, seriesId, attempt + 1);
    }
    return {
        revision,
        series: { id: seriesId, title: file.series_title },
        file: {
            id: file.id,
            filePath: file.file_path,
            durationMs:
                file.duration_seconds !== null && file.duration_seconds > 0
                    ? Math.round(file.duration_seconds * 1000)
                    : null,
            manual: links.some((l) => l.offset_source === MANUAL_OFFSET_SOURCE),
        },
        links: links.map((l) => ({
            mediaItemId: l.media_item_id,
            seasonNumber: l.season_number,
            episodeNumber: l.episode_number,
            title: l.title,
            isDismissed: l.is_dismissed,
            dismissedAt: l.dismissed_at,
            isDefault: l.is_default,
            sortOrder: l.sort_order,
            startMs: numOrNull(l.start_offset_ms),
            endMs: numOrNull(l.end_offset_ms),
            offsetSource: l.offset_source,
            boundaryOrigin: l.boundary_origin,
        })),
        chapters: chapters.map((c) => ({ name: c.chapter_name, startMs: Number(c.start_ms) })),
        episodes: episodes.map((e) => ({
            id: e.id,
            seasonNumber: e.season_number,
            episodeNumber: e.episode_number,
            title: e.title,
            isDismissed: e.is_dismissed,
            dismissedAt: e.dismissed_at,
            runtimeMs:
                e.runtime_seconds !== null && e.runtime_seconds > 0
                    ? e.runtime_seconds * 1000
                    : null,
        })),
    };
}
