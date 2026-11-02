// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/debug/sonarr/lookup.ts
 *
 * GET /api/admin/debug/sonarr/lookup?tvdbId=...
 *
 * Admin debug endpoint: looks up a Sonarr series by TVDB ID.
 * Returns null values when the series is not found in Sonarr.
 *
 * Query param: tvdbId — TVDB ID (coerced to integer via schema)
 *
 * Response: { seriesId: number | null, titleSlug: string | null, title: string | null, monitored: boolean }
 * 502 bad_gateway on Sonarr API errors.
 *
 * Auth: admin.  Surface: internal-only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { sonarrClient } from '$lib/server/sonarr.js';
import { sonarrLookupQuerySchema } from '$lib/schemas/admin.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('DebugSonarr');

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const SonarrLookupResponseSchema = z.object({
    seriesId: z.number().int().nullable(),
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
        query: sonarrLookupQuerySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const { tvdbId } = ctx.input!.query;

            try {
                const series = await sonarrClient.getSeriesByTvdbId(tvdbId);

                if (!series) {
                    return json(
                        SonarrLookupResponseSchema.parse({
                            seriesId: null,
                            titleSlug: null,
                            title: null,
                            monitored: false,
                        }),
                    );
                }

                logger.info(`Sonarr series for TVDB ${tvdbId}`, {
                    id: series.id,
                    titleSlug: series.titleSlug,
                    title: series.title,
                    monitored: series.monitored,
                });

                return json(
                    SonarrLookupResponseSchema.parse({
                        seriesId: series.id,
                        titleSlug: series.titleSlug || null,
                        title: series.title,
                        monitored: series.monitored,
                    }),
                );
            } catch (error) {
                logger.error('Error fetching Sonarr data', { error });
                return ApiProblem.badGateway('Failed to fetch Sonarr data');
            }
        },
    },
});
