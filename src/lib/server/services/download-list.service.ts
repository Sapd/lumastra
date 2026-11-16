// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * download-list.service.ts: what a title downloads as, shared by GET /api/media/{id}/download-list
 * (the web queue) and GET /api/media/{id}/download-zip (the archive). One code path, so the
 * archive holds exactly the files, folders and names the queue lists.
 *
 * The caller has already checked that the user may see `internalId` and may download. This
 * function applies the per-item library/age filter (`checkMediaAccessBatch`) to the rows.
 */

import { extname } from 'node:path';
import type postgres from 'postgres';
import { checkMediaAccessBatch } from '$lib/server/middleware/media-access.js';
import { deniedLibraryGroupsFor } from '$lib/server/services/download-file-scope.js';
import {
    buildDownloadFilename,
    sanitizeFilenamePart,
} from '$lib/server/handlers/media-download-handler.js';
import {
    getDownloadListRoot,
    getSingleDownloadRow,
    listEpisodeDownloadRows,
    type DownloadListRoot,
    type DownloadListRow,
} from '$lib/server/database/queries/download-list.queries.js';

export function seasonFolder(season: number | null): string | null {
    if (season === null) return null;
    return season === 0 ? 'Specials' : `Season ${String(season).padStart(2, '0')}`;
}

export function folderName(title: string, year: number | null): string {
    const base = sanitizeFilenamePart(title) || 'download';
    return year ? `${base} (${year})` : base;
}

/** `season` query value: null = not given, 'invalid' = not a small non-negative integer. */
export function parseSeason(raw: string | null): number | null | 'invalid' {
    if (raw === null || raw === '') return null;
    if (!/^\d{1,4}$/.test(raw)) return 'invalid';
    return Number(raw);
}

export interface DownloadListItem {
    mediaItemId: string;
    fileId: string;
    /** Library path from the database; never sent to a client. */
    filePath: string;
    season: number | null;
    episode: number | null;
    seasonFolder: string | null;
    fileName: string;
    sizeBytes: number;
    available: boolean;
}

export interface DownloadList {
    root: DownloadListRoot;
    seriesFolder: string;
    /** Accessible items that have no file row. */
    missingCount: number;
    /**
     * The same count per season ("0" = specials, "unknown" = no season number), only seasons
     * with something missing. Lets a client warn for the scope it shows, not the whole list.
     */
    missingBySeason: Record<string, number>;
    items: DownloadListItem[];
}

export async function buildDownloadList(
    sql: postgres.Sql,
    internalId: string,
    accessUser: Parameters<typeof checkMediaAccessBatch>[2],
    { season, specials }: { season: number | null; specials: boolean },
): Promise<DownloadList | null> {
    const root = await getDownloadListRoot(sql, internalId);
    if (!root) return null;
    // File-level library scope: the default file is picked among files the caller may read.
    const denied = await deniedLibraryGroupsFor(sql, accessUser);

    let rows: DownloadListRow[];
    let seriesFolder: string;
    if (root.media_type === 'tv' || root.media_type === 'season') {
        rows = await listEpisodeDownloadRows(sql, internalId, denied);
        const seriesTitle = root.media_type === 'tv' ? root.title : rows[0]?.series_title;
        seriesFolder = folderName(
            seriesTitle ?? root.title,
            root.media_type === 'tv' ? root.year : null,
        );
        rows = rows.filter((r) => {
            if (season !== null) return r.season_number === season;
            return specials || r.season_number !== 0;
        });
    } else {
        const single = await getSingleDownloadRow(sql, internalId, denied);
        rows = single ? [single] : [];
        seriesFolder =
            single?.media_type === 'episode' && single.series_title
                ? folderName(single.series_title, single.series_year ?? null)
                : folderName(root.title, root.year);
    }

    const allowedIds = await checkMediaAccessBatch(
        sql,
        rows.map((r) => r.id),
        accessUser,
    );
    // A lone episode lands in the same Show/Season folder as in a season list.
    const inSeasonFolder =
        root.media_type === 'tv' || root.media_type === 'season' || root.media_type === 'episode';

    const byNumber = (a: number | null, b: number | null) =>
        (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
    const accessible = rows.filter((r) => allowedIds.has(r.id));
    const missingCount = accessible.filter((r) => !r.file_id || !r.file_path).length;
    const missingBySeason: Record<string, number> = {};
    for (const r of accessible) {
        if (r.file_id && r.file_path) continue;
        const key = r.season_number === null ? 'unknown' : String(r.season_number);
        missingBySeason[key] = (missingBySeason[key] ?? 0) + 1;
    }
    const items = [...accessible]
        .sort(
            (a, b) =>
                byNumber(a.season_number, b.season_number) ||
                byNumber(a.episode_number, b.episode_number),
        )
        .filter((r) => r.file_id && r.file_path)
        .map((r) => ({
            mediaItemId: r.id,
            fileId: r.file_id as string,
            filePath: r.file_path as string,
            season: r.season_number,
            episode: r.episode_number,
            // An episode with no season number lands in "Season 00", not at the root.
            seasonFolder: inSeasonFolder
                ? r.season_number === null
                    ? 'Season 00'
                    : seasonFolder(r.season_number)
                : null,
            // extname(file_path) assumes path mapping keeps the extension (the route uses the mapped path).
            fileName: buildDownloadFilename(r, extname(r.file_path as string)),
            sizeBytes: Number(r.file_size_bytes ?? 0),
            available: r.is_missing !== true && Number(r.file_size_bytes ?? 0) > 0,
        }));

    return { root, seriesFolder, missingCount, missingBySeason, items };
}
