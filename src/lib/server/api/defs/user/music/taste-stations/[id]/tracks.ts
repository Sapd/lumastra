// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/me/music/taste-stations/[id]/tracks — also published at
 * GET /api/v1/me/music/taste-stations/{id}/tracks (beta).
 *
 * Returns a ~50-track queue for the given taste station id. Tracks are
 * kNN'd against the cluster's centroid, MMR-reranked for diversity, and
 * filtered to exclude recently-played tracks.
 *
 * Path params: id — opaque `<version>.<n>` handle from the station listing
 * Query params: limit (default 50, max 100)
 *
 * Response: `{ items: Track[], page: { limit, truncated } }`
 * 404 when the id's clustering has no station at that position, or the station
 *     has no playable tracks.
 * 410 gone when the clustering the id belongs to has expired — list again.
 * 422 when the id is malformed.
 * 429 rate_limited — capped at RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_S
 *     per user (kNN + MMR + a sequential per-candidate access check).
 * DB-down → 503 dependency_unavailable.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getStationQueue, parseStationId } from '$lib/server/services/music/stations.service.js';
import { checkRateLimit, withRateLimitHeaders } from '$lib/server/middleware/valkey-rate-limit.js';
import { MusicStationTracksResponseSchema } from '$lib/schemas/api-music-responses.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Per-user rate limit: kNN + MMR + a sequential per-candidate access check. */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_S = 60;

const ParamsSchema = z.object({
    id: z.string().min(1).max(32),
});

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get the tracks of one taste station',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns a playable queue for the taste station with the given id. Take the id from GET /api/v1/me/music/taste-stations; it stays valid for 7 days even when the clustering changes in between. When it has expired the request answers 410 and the stations must be listed again. `page.truncated` is true when more candidates than `limit` were available. Rate limited to 30 requests per minute per user.',
            query: QuerySchema,
            responses: {
                200: {
                    schema: MusicStationTracksResponseSchema,
                    description: 'Station track queue',
                },
                401: 'Authentication required',
                404: 'No station at that position, or the station has no playable tracks for the caller',
                410: 'The clustering the id belongs to has expired — list the stations again',
                422: 'Malformed station id',
                429: 'Rate limit exceeded',
                503: 'Database unavailable or the station lookup failed — transient, retry. Never reported as an empty list or a 404.',
            },
        },
    },

    request: {
        params: ParamsSchema,
        query: QuerySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('AI database not available');

            const stationId = event.params.id ?? '';
            if (!parseStationId(stationId))
                return ApiProblem.validationFailed('Invalid station id');

            const rl = await checkRateLimit(
                `music:station-tracks:${user.userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return withRateLimitHeaders(
                    ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000)),
                    rl,
                );
            }

            const limitParam = event.url.searchParams.get('limit');
            const rawLimit = limitParam !== null ? Number.parseInt(limitParam, 10) : DEFAULT_LIMIT;
            const limit = Number.isFinite(rawLimit)
                ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
                : DEFAULT_LIMIT;

            let result: Awaited<ReturnType<typeof getStationQueue>>;
            try {
                result = await getStationQueue(
                    sql,
                    user.userId,
                    stationId,
                    limit,
                    user,
                    ctx.surface,
                );
            } catch {
                // Already logged by getStationQueue. 503, not 404: the station
                // may be fine — the lookup failed, and a retry can succeed.
                return withRateLimitHeaders(
                    ApiProblem.dependencyUnavailable('Station tracks unavailable'),
                    rl,
                );
            }

            switch (result.kind) {
                case 'invalid':
                    return withRateLimitHeaders(
                        ApiProblem.validationFailed('Invalid station id'),
                        rl,
                    );
                case 'expired':
                    return withRateLimitHeaders(
                        ApiProblem.gone('Taste station expired — list the stations again'),
                        rl,
                    );
                case 'not_found':
                    return withRateLimitHeaders(ApiProblem.notFound('Station not found'), rl);
                case 'unavailable':
                    return withRateLimitHeaders(
                        ApiProblem.dependencyUnavailable('Station tracks unavailable'),
                        rl,
                    );
                case 'ok':
                    break;
            }

            if (result.tracks.length === 0) {
                return withRateLimitHeaders(
                    ApiProblem.notFound('Station has no playable tracks'),
                    rl,
                );
            }

            return withRateLimitHeaders(
                json({
                    items: result.tracks,
                    page: { limit, truncated: result.truncated },
                }),
                rl,
            );
        },
    },
});
