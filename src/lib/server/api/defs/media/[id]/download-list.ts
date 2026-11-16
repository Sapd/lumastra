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

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { canDownload } from '$lib/server/services/download-access.service.js';
import {
    crossSiteForbiddenResponse,
    downloadSubjectOf,
    mediaAccessUserOf,
} from '$lib/server/services/download-access-guard.js';
import { buildDownloadList, parseSeason } from '$lib/server/services/download-list.service.js';
import { resolveCatalogInternalId } from '../../catalog/resolve-id.js';

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

            const list = await buildDownloadList(sql, internalId, accessUser, { season, specials });
            if (!list) return ApiProblem.notFound('Media item not found');
            const { seriesFolder, missingCount } = list;
            // The library path stays on the server.
            const items = list.items.map(({ filePath: _filePath, ...item }) => item);

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
