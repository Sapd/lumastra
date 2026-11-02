// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/channels/programs-search.ts — GET /livetv/programs/search
 *
 * GET /livetv/programs/search?q={query}&limit={limit}&offset={offset}
 *   Full-text search for TV airings: one item per airing of a station's owner feed,
 *   wrapped in the standard {items, page} collection envelope with offset paging.
 *   Requires Live TV permission.
 *
 * Auth: feature:FEATURE_LIVETV → user (+ inline hasLiveTvPermission check)
 */

import { stationDto } from '$lib/server/services/livetv/station.service.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { hideOfflineStations } from '$lib/server/services/livetv/channel-health.service.js';
import { ProgramSearchResponseSchema } from '$lib/schemas/livetv';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

const ProgramsSearchQuerySchema = z.object({
    q: z
        .string()
        .trim()
        .min(2)
        .max(200)
        .meta({ description: 'Search query text (minimum 2 characters)' }),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .default(DEFAULT_LIMIT)
        .meta({
            description: `Max airings to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
        }),
    offset: z.coerce.number().int().min(0).default(0).meta({ description: 'Airings to skip' }),
});

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Search EPG programs',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Full-text search over the EPG. Returns one item per airing, keyed by `stationId` ' +
                '(the id to pass to `POST /livetv/playback-sessions`), with a `station` summary and ' +
                '`temporalStatus`. Only the schedule the guide shows for a station is searched, so a ' +
                'show appears once per station; group by title client-side to merge stations. ' +
                'Ordered live first, then by relevance. Offset paging via `limit`/`offset`. ' +
                'A down Live TV provider returns `503 dependency_unavailable`.',
            query: ProgramsSearchQuerySchema,
            responses: {
                200: {
                    schema: ProgramSearchResponseSchema,
                    description: 'Program airing search results',
                },
                401: 'Authentication required',
                404: 'Live TV not available',
                422: 'Validation failed',
                503: 'Live TV provider unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_LIVETV',
        then: { kind: 'user' },
    },
    request: {
        query: ProgramsSearchQuerySchema,
    },
    handlers: {
        /**
         * GET /livetv/programs/search
         *
         * Searches EPG airings by query text and attaches the station summary from the
         * viewer lineup. Airings of stations missing from the lineup are dropped.
         */
        GET: async ({ locals }, ctx) => {
            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            const { q, limit, offset } = ctx.input!.query;

            let items;
            let hasMore;
            try {
                const provider = await getLiveTvProvider();
                const [found, allFeeds] = await Promise.all([
                    provider.searchPrograms(q, limit + 1, offset),
                    provider.getChannels(),
                ]);
                const lineup = await hideOfflineStations(allFeeds, locals);
                hasMore = found.length > limit;
                const stations = new Map<string, ReturnType<typeof stationDto>>();
                for (const channel of lineup) {
                    const station = stationDto(channel);
                    if (!stations.has(station.id)) stations.set(station.id, station);
                }
                items = found.slice(0, limit).flatMap((airing) => {
                    const station = stations.get(airing.stationId);
                    return station
                        ? [
                              {
                                  ...airing,
                                  station: {
                                      id: station.id,
                                      name: station.name,
                                      images: station.images,
                                  },
                              },
                          ]
                        : [];
                });
            } catch {
                return ApiProblem.dependencyUnavailable('Live TV provider unavailable');
            }

            return json(paginate(items, { limit, offset, hasMore }));
        },
    },
});
