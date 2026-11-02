// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/series/watch-marker.ts — `series/{id}/watch-marker`.
 *
 * "Where am I in this series": the caller's single series watch marker
 * (episode + position), resolved by `effectiveSeriesMarker`. With `from` the
 * response also carries the forward-only relation of the marker to the
 * caller's episode, so no client re-implements episode ordering.
 *
 *   GET /series/{id}/watch-marker
 *   GET /series/{id}/watch-marker?from=<episodeId>&fromPositionMs=N&excludeSessionId=S
 *
 * Distinct from `next-episode`, which answers "next UNWATCHED episode".
 *
 * Auth: user. ID forms: UUID or tvdb/tmdb/imdb :series handle in the path.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getMediaItemType } from '$lib/server/database/queries/media-items.queries.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import { effectiveSeriesMarker } from '$lib/server/services/effective-series-marker.service.js';
import { SeriesWatchMarkerSchema } from '$lib/schemas/api-series-responses';
import { resolveSeriesId } from './resolve-series-id.js';

const WatchMarkerQuery = z
    .object({
        from: z.uuid().optional().meta({
            description:
                'Episode the caller is on. Enables the forward-only `relation` and `sameFileAsFrom`.',
        }),
        fromPositionMs: z.coerce.number().int().min(0).optional().meta({
            description:
                "Caller's position in `from` (ms); decides `same` vs `forward` on one episode",
        }),
        excludeSessionId: z
            .string()
            .optional()
            .meta({
                description:
                    "Caller's own play-session id, excluded from the live step so a paused player " +
                    'never finds itself',
            }),
    })
    .meta({
        id: 'SeriesWatchMarkerQuery',
        description:
            'Series path accepts UUID or tvdb/tmdb/imdb :series handles; example /series/tvdb:81189:series/watch-marker',
    });

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Series'],
            summary: 'Get the series watch marker',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Accepts UUID or tvdb/tmdb/imdb :series handles. Returns PlaybackProgress (and positionMs) with where the authenticated user is in a series: a live session on another ' +
                'device, else the in-progress Continue Watching episode, else the next episode, ' +
                'else `finished` / `not_started`. Pass `from` (and `fromPositionMs`) to get the ' +
                'forward-only `relation`: clients move a player only on `forward`. ' +
                '`404 not_found` when the series does not exist or is not accessible.',
            responses: {
                200: {
                    schema: SeriesWatchMarkerSchema,
                    description: 'Series watch marker',
                },
                400: 'Invalid query parameters',
                401: 'Authentication required',
                404: 'Series not found',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        query: WatchMarkerQuery,
    },

    handlers: {
        GET: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) {
                return ApiProblem.unauthorized();
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const seriesInternalId = await resolveSeriesId(event);
            if (!seriesInternalId) {
                return ApiProblem.notFound('Series not found');
            }

            // Access gate — library + age. The resolver does not re-gate. A
            // movie or episode id is not a series: without this check the
            // resolver would answer it with an empty `not_started` marker.
            const [accessible, mediaType] = await Promise.all([
                checkMediaAccess(sql, seriesInternalId, event.locals.user),
                getMediaItemType(sql, seriesInternalId),
            ]);
            if (!accessible || !isSeries(mediaType)) {
                return ApiProblem.notFound('Series not found');
            }

            const query = ctx.input?.query;
            const marker = await effectiveSeriesMarker({
                userId,
                seriesId: seriesInternalId,
                fromEpisodeId: query?.from ?? null,
                fromPositionMs: query?.fromPositionMs ?? null,
                excludeSessionId: query?.excludeSessionId ?? null,
                sql,
            });

            return json(marker);
        },
    },
});
