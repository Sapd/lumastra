// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { getAlbumSummaries } from '$lib/server/database/queries/music.queries.js';
import { toAlbumSummary } from '$lib/server/services/music/track-projection.js';

/**
 * defs/music/albums/series.ts — `GET /api/music/albums/[id]/series`
 * (internal surface only; feeds the album modal's "Series" list).
 *
 * Returns every album of the series the seed album belongs to, the seed
 * included, ordered by volume. Series are detected from album titles under the
 * same album artist — see `$lib/shared/music-album-series`.
 *
 * Response shape: bare object `{ albums: AlbumSeriesEntry[], sourceAlbumId }`;
 * `albums` is empty when the album is not part of a series.
 * Errors → problem+json. 404 when the seed album is not accessible,
 * 503 dependency_unavailable when the DB is down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { getAlbumSeries } from '$lib/server/database/queries/music-album-series.queries.js';
import { AlbumSeriesResponseSchema } from '$lib/schemas/api-music-responses.js';

const paramsSchema = z.object({
    id: z.string().min(1),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Music'],
            summary: 'Get the series an album belongs to',
            description:
                'Albums of the same series as the seed album (detected from titles such as "Vol. 62" under the same album artist), the seed included, ordered by volume. Empty when the album is not part of a series.',
            responses: {
                200: { schema: AlbumSeriesResponseSchema, description: 'Album series' },
                401: 'Authentication required',
                404: 'Album not found or not accessible',
                503: 'Database unavailable',
            },
        },
    },

    request: {
        params: paramsSchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const albumId = event.params.id;
            if (!albumId) return ApiProblem.validationFailed('Missing album ID');

            if (!(await checkMediaAccess(sql, albumId, user))) {
                return ApiProblem.notFound('Album not found or not accessible');
            }

            const accessCtx = await buildSearchAccessContext(sql, user);
            const rows = await getAlbumSeries(sql, albumId, searchAccessBoundary(accessCtx));

            const summaries = new Map(
                (await getAlbumSummaries(
                    sql,
                    rows.map((row) => row.album_id),
                    searchAccessBoundary(accessCtx),
                )).map((row) => [row.id, row]),
            );
            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                rows.map((row) => ({ id: row.album_id, mediaType: 'album' })),
            );
            return json({
                albums: rows.flatMap((row) => {
                    const summary = summaries.get(row.album_id);
                    return summary
                        ? [
                              {
                                  ...toAlbumSummary(summary, imageSets.get(summary.id) ?? {}),
                                  volume: row.volume,
                              },
                          ]
                        : [];
                }),
                sourceAlbumId: albumId,
            });
        },
    },
});
