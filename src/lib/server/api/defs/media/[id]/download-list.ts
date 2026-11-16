// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/download-list.ts — GET /api/media/{id}/download-list
 *
 * What the web download queue needs for a title: whether this user may
 * download at all, the parallel limit, the folder names, and one entry per
 * file (a movie = one entry, a series = every episode, or one season with
 * `?season=N`; season 0 only with `?specials=1`).
 *
 * Each entry names the file the download route would serve by default
 * (the same default as playback) and the exact Content-Disposition filename.
 * Only items the user may access are listed, using the same batch library/age
 * check as every other list endpoint.
 *
 * `?summary=1` returns only `{ allowed, maxParallel }` (no item queries); the web UI
 * uses it for button visibility and fetches the full list on click.
 *
 * Auth: user. Surface: internal.
 */

import { extname } from 'node:path';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { checkMediaAccess, checkMediaAccessBatch } from '$lib/server/middleware/media-access.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { canDownload } from '$lib/server/services/download-access.service.js';
import {
    crossSiteForbiddenResponse,
    downloadSubjectOf,
    mediaAccessUserOf,
} from '$lib/server/services/download-access-guard.js';
import {
    buildDownloadFilename,
    sanitizeFilenamePart,
} from '$lib/server/handlers/media-download-handler.js';
import {
    getDownloadListRoot,
    getSingleDownloadRow,
    listEpisodeDownloadRows,
    type DownloadListRow,
} from '$lib/server/database/queries/download-list.queries.js';
import { deniedLibraryGroupsFor } from '$lib/server/services/download-file-scope.js';
import { resolveCatalogInternalId } from '../../catalog/resolve-id.js';

function seasonFolder(season: number | null): string | null {
    if (season === null) return null;
    return season === 0 ? 'Specials' : `Season ${String(season).padStart(2, '0')}`;
}

function folderName(title: string, year: number | null): string {
    const base = sanitizeFilenamePart(title) || 'download';
    return year ? `${base} (${year})` : base;
}

function parseSeason(raw: string | null): number | null | 'invalid' {
    if (raw === null || raw === '') return null;
    if (!/^\d{1,4}$/.test(raw)) return 'invalid';
    return Number(raw);
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const crossSite = crossSiteForbiddenResponse(event.request, event.url);
            if (crossSite) return crossSite;

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const season = parseSeason(event.url.searchParams.get('season'));
            if (season === 'invalid') {
                return ApiProblem.validationFailed([
                    { field: 'season', message: 'season must be a non-negative integer' },
                ]);
            }
            const specials = event.url.searchParams.get('specials') === '1';

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const accessUser = mediaAccessUserOf(event.locals);
            if (!accessUser || !(await checkMediaAccess(sql, internalId, accessUser))) {
                return ApiProblem.notFound('Media item not found');
            }

            // `summary=1`: just the permission, for button visibility. No item
            // queries; the visibility check above already 404s invisible ids.
            const allowed = await canDownload(downloadSubjectOf(event.locals));
            if (event.url.searchParams.get('summary') === '1') {
                return json({ allowed, maxParallel: config.DOWNLOAD_MAX_PARALLEL_PER_USER });
            }
            // Not allowed: no file names, sizes or episode structure to a user who cannot download.
            if (!allowed) {
                return json({
                    allowed: false,
                    maxParallel: config.DOWNLOAD_MAX_PARALLEL_PER_USER,
                    seriesFolder: '',
                    missingCount: 0,
                    items: [],
                });
            }

            // File-level library scope, applied inside the default-file selection.
            const denied = await deniedLibraryGroupsFor(sql, accessUser);
            const root = await getDownloadListRoot(sql, internalId);
            if (!root) return ApiProblem.notFound('Media item not found');

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
                root.media_type === 'tv' ||
                root.media_type === 'season' ||
                root.media_type === 'episode';

            const byNumber = (a: number | null, b: number | null) =>
                (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
            const accessible = rows.filter((r) => allowedIds.has(r.id));
            const missingCount = accessible.filter((r) => !r.file_id || !r.file_path).length;
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

            return json({
                allowed,
                maxParallel: config.DOWNLOAD_MAX_PARALLEL_PER_USER,
                seriesFolder,
                missingCount,
                items,
            });
        },
    },
});
