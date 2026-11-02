// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/**
 * Album hover-card summary.
 *
 * A deliberately tiny sibling of `/api/music/albums/[id]`: that route loads the
 * album's full track list and popularity data, which is far too heavy to fire on
 * a 150ms hover. This one is a single indexed row.
 */

import { toAlbumSummary } from '$lib/server/services/music/track-projection.js';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getAlbumSummary } from '$lib/server/database/queries/music.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';

export const GET: RequestHandler = requireAuth(
    withErrorHandler(async ({ params, locals }) => {
        if (!locals.user) return ApiProblem.unauthorized();

        const sql = await aiDbService.getSql();
        if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

        if (!params.id) return ApiProblem.validationFailed('Missing album ID');

        const album = await getAlbumSummary(sql, params.id);
        if (!album) return ApiProblem.notFound('Album not found');

        // 404 rather than 403 on denial, so the endpoint cannot be used to probe
        // for albums outside the caller's library scope.
        if (!(await checkMediaAccess(sql, params.id, locals.user))) {
            return ApiProblem.notFound('Album not found');
        }

        const imageSets = await resolveImageSets(sql, 'internal', [
            { id: album.id, mediaType: 'album' },
        ]);
        return json(toAlbumSummary(album, imageSets.get(album.id) ?? {}));
    }),
);
