// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getTrackDetail } from '$lib/server/database/queries/music.queries.js';
import { getTrackFeedback } from '$lib/server/database/queries/music-interactions.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';

const logger = Logger.for('MusicTrackDetailAPI');

export const GET: RequestHandler = requireAuth(
    withErrorHandler(async ({ params, locals, url }) => {
        if (!locals.user) return ApiProblem.unauthorized();

        const sql = await aiDbService.getSql();
        if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

        if (!params.id) return ApiProblem.validationFailed('Missing track ID');

        const [track, feedback] = await Promise.all([
            getTrackDetail(sql, params.id),
            getTrackFeedback(sql, locals.user.userId, params.id),
        ]);

        if (!track) {
            return ApiProblem.notFound('Track not found');
        }

        // Use checkMediaAccess (library + age) so age-restricted callers
        // can't read track metadata they shouldn't see. The old call only
        // covered library groups.
        if (!(await checkMediaAccess(sql, track.id, locals.user))) {
            return ApiProblem.notFound('Track not found');
        }

        logger.debug('Track detail loaded', {
            username: locals.user.username,
            trackId: params.id,
        });

        // Bare object (no success/timestamp wrapper). toMusicTrack embeds
        // self-describing images{} hrefs under this route's own surface prefix.
        const imageSets = await resolveImageSets(
            sql,
            url.pathname.startsWith('/api/v1/') ? 'v1' : 'internal',
            [{ id: track.id, mediaType: 'track' }],
        );
        return json({
            track: toMusicTrack(track, imageSets.get(track.id) ?? {}),
            userContext: { feedback },
        });
    }),
);
