// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { withValidation } from '$lib/server/middleware/validate.js';
import { jellyfinEpisodeLookupSchema } from '$lib/schemas/playback.js';
import { Logger } from '$lib/server/utils/logger.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { JellyfinEpisodeResponseSchema } from '$lib/schemas/api-playback-responses.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { getDb } from '$lib/server/database/index.js';
import { findEpisodeBySeriesName } from '$lib/server/database/queries/episode-search.queries.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';

const logger = Logger.for('EpisodeLookupAPI');

export const POST: RequestHandler = requireAuth(
    withErrorHandler(
        withValidation(
            async ({ validated, locals }) => {
                const { seriesName, season, episode } = validated.body;

                const sql = getDb();
                if (!sql) {
                    return ApiResponses.error(
                        'Database not available',
                        'Database connection not established',
                        503,
                    );
                }

                try {
                    const accessCtx = await buildSearchAccessContext(sql, locals.user);
                    const result = await findEpisodeBySeriesName(sql, seriesName, season, episode, {
                        deniedGroupIds: accessCtx.deniedGroupIds,
                        ageRating: accessCtx.ageRating,
                    });

                    return typedJson(JellyfinEpisodeResponseSchema, {
                        episodeId: result?.id ?? null,
                    });
                } catch (error) {
                    logger.error('Failed to find episode', error as Error, {
                        seriesName,
                        season,
                        episode,
                    });
                    return ApiResponses.error('Failed to find episode', error as Error);
                }
            },
            { body: jellyfinEpisodeLookupSchema },
        ),
    ),
);
