// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/debug/radarr/lookup.ts
 *
 * GET /api/admin/debug/radarr/lookup?tmdbId=...
 *
 * Admin debug endpoint: looks up a Radarr movie by TMDB ID.
 * Returns null values when the movie is not found in Radarr.
 *
 * Query param: tmdbId — TMDB ID (string, coerced to integer inside handler)
 *
 * Response: { movieId: number | null, titleSlug: string | null, title: string | null, monitored: boolean }
 * 502 bad_gateway on Radarr API errors.
 *
 * Auth: admin.  Surface: internal-only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { radarrClient } from '$lib/server/sonarr.js';
import { radarrLookupQuerySchema } from '$lib/schemas/admin.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('DebugRadarr');

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const RadarrLookupResponseSchema = z.object({
    movieId: z.number().int().nullable(),
    titleSlug: z.string().nullable(),
    title: z.string().nullable(),
    monitored: z.boolean(),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: radarrLookupQuerySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const tmdbIdNum = parseInt(ctx.input!.query.tmdbId, 10);

            try {
                const movie = await radarrClient.getMovieByTmdbId(tmdbIdNum);

                if (!movie) {
                    logger.info(`No Radarr movie found for TMDB ${tmdbIdNum}`);
                    return json(
                        RadarrLookupResponseSchema.parse({
                            movieId: null,
                            titleSlug: null,
                            title: null,
                            monitored: false,
                        }),
                    );
                }

                logger.info(`Radarr movie for TMDB ${tmdbIdNum}`, {
                    radarrId: movie.id,
                    titleSlug: movie.titleSlug,
                    title: movie.title,
                    tmdbId: movie.tmdbId,
                    monitored: movie.monitored,
                    status: movie.status,
                });

                return json(
                    RadarrLookupResponseSchema.parse({
                        movieId: movie.id,
                        titleSlug: movie.titleSlug || null,
                        title: movie.title,
                        monitored: movie.monitored,
                    }),
                );
            } catch (error) {
                logger.error('Error fetching Radarr data', { error });
                return ApiProblem.badGateway('Failed to fetch Radarr data');
            }
        },
    },
});
