// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
/**
 * Artist hover-card summary.
 *
 * A deliberately tiny sibling of `/api/music/artists/[id]`: that route loads the
 * artist's full discography, every track, and two popularity joins, which is far
 * too heavy to fire on a 150ms hover. This one is a single indexed row.
 */

import { toArtistSummary } from '$lib/server/services/music/track-projection.js';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getArtistSummary } from '$lib/server/database/queries/music.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';

export const GET: RequestHandler = requireAuth(
    withErrorHandler(async ({ params, locals }) => {
        if (!locals.user) return ApiProblem.unauthorized();

        const sql = await aiDbService.getSql();
        if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

        if (!params.id) return ApiProblem.validationFailed('Missing artist ID');

        const artist = await getArtistSummary(sql, params.id);
        if (!artist) return ApiProblem.notFound('Artist not found');

        // 404 rather than 403 on denial, so the endpoint cannot be used to probe
        // for artists outside the caller's library scope.
        if (!(await checkMediaAccess(sql, params.id, locals.user))) {
            return ApiProblem.notFound('Artist not found');
        }

        const imageSets = await resolveImageSets(sql, 'internal', [
            { id: artist.id, mediaType: 'artist' },
        ]);
        return json(toArtistSummary(artist, imageSets.get(artist.id) ?? {}));
    }),
);
