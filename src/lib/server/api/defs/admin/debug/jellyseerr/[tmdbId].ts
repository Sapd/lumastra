// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/debug/jellyseerr/[tmdbId].ts
 *
 * GET /api/admin/debug/jellyseerr/[tmdbId]?mediaType=movie|series
 *
 * Admin debug endpoint: fetches Jellyseerr data for a given TMDB ID.
 * Returns TVDB ID and external service IDs for Sonarr/Radarr linking.
 *
 * When Jellyseerr is not configured, returns null values rather than erroring.
 *
 * Path param: tmdbId — TMDB ID (coerced to integer)
 * Query param: mediaType — 'movie' | 'series' (canonical public type)
 *
 * Response: { tvdbId: number | null, sonarrId: number | null, radarrId: number | null }
 *
 * Auth: admin.  Surface: internal-only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { jellyseerrClient } from '$lib/server/jellyseerr.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('DebugJellyseerr');

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// Accept both 'series' (canonical public) and 'tv' (legacy) so the UI can
// migrate at its own pace.  Both resolve to the Jellyseerr 'tv' kind.
const mediaTypeSchema = z.enum(['movie', 'series', 'tv']);

const paramsSchema = z.object({
    tmdbId: z.coerce.number().int().positive(),
});

const querySchema = z.object({
    mediaType: mediaTypeSchema,
});

const JellyseerrDebugResponseSchema = z.object({
    tvdbId: z.number().int().nullable(),
    sonarrId: z.number().int().nullable(),
    radarrId: z.number().int().nullable(),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: paramsSchema,
        query: querySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const { tmdbId } = ctx.input!.params;
            const rawType = ctx.input!.query.mediaType;
            // Normalize 'tv' → 'series' for logging; pass 'movie'/'tv' to client.
            // Jellyseerr's API uses 'tv' as the media type key, so we translate
            // canonical 'series' → 'tv' for the upstream call.
            const jellyType: 'movie' | 'tv' = rawType === 'movie' ? 'movie' : 'tv';

            if (!jellyseerrClient.isConfigured()) {
                return json(
                    JellyseerrDebugResponseSchema.parse({
                        tvdbId: null,
                        sonarrId: null,
                        radarrId: null,
                    }),
                );
            }

            try {
                const mediaData = await jellyseerrClient.getMediaByTmdbId(tmdbId, jellyType);

                if (!mediaData) {
                    logger.info(`No Seerr data found for TMDB ${tmdbId} (${rawType})`);
                    return json(
                        JellyseerrDebugResponseSchema.parse({
                            tvdbId: null,
                            sonarrId: null,
                            radarrId: null,
                        }),
                    );
                }

                // Access externalIds from the nested object (Jellyseerr API has both
                // tvdbId at root and in externalIds).
                const tvdbId = mediaData.externalIds?.tvdbId || mediaData.tvdbId || null;

                logger.info(`Seerr data for TMDB ${tmdbId}`, {
                    tvdbId,
                    imdbId: mediaData.externalIds?.imdbId,
                    title: mediaData.title || mediaData.name,
                });

                return json(
                    JellyseerrDebugResponseSchema.parse({
                        tvdbId,
                        sonarrId: null,
                        radarrId: null,
                    }),
                );
            } catch (error) {
                logger.error('Error fetching Seerr data', undefined, { error });
                return ApiProblem.badGateway('Failed to fetch Jellyseerr data');
            }
        },
    },
});
