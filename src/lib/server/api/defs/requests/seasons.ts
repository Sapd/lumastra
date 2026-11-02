// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { z } from 'zod';
import { externalIdsSchema } from '$lib/schemas/common.js';
import { RequestSeasonsResponseSchema } from '$lib/schemas/request-seasons.js';
import { jellyseerrClient } from '$lib/server/jellyseerr.js';
import { providerResolutionService } from '$lib/server/services/provider-resolution.service.js';
import { checkRateLimit, RateLimitPresets } from '$lib/server/middleware/valkey-rate-limit.js';
import { getClientIp } from '$lib/server/utils/client-ip.js';

/**
 * Body for POST /requests/seasons. `series` is canonical; the legacy `tv` token
 * is accepted and both normalise to `tv` internally (same as POST /requests).
 * `movie` parses but is rejected by the handler with 422.
 */
const SeasonsBodySchema = z.object({
    externalIds: externalIdsSchema,
    mediaType: z
        .enum(['movie', 'series'])
        .meta({
            description: 'Must be `series`. `movie` is rejected with 422.',
        })
        // constrained: the enum admits only movie|series|tv and the transform
        // maps 'series' away, so only 'movie'|'tv' can reach here.
        // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
        .transform((v) => (v === 'series' ? 'tv' : v) as 'movie' | 'tv'),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { body: SeasonsBodySchema },
    docs: {
        POST: {
            tags: ['Request'],
            summary: "List a series' seasons and whether each can be requested",
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns every season of a series with its availability and pending state, so a ' +
                'client can offer a season picker before creating a request. ' +
                '`mediaType` must be `series`; `externalIds` needs at least ' +
                'one provider id. Requires request permission. ' +
                'Auth: any authenticated Bearer credential; no additional scope is required ' +
                '(same as `POST /requests/status`). ' +
                'Rate-limited: 100 requests per 60 seconds per user.',
            body: SeasonsBodySchema,
            responses: {
                200: {
                    schema: RequestSeasonsResponseSchema,
                    description: 'Seasons with request availability',
                },
                401: 'Authentication required',
                403: 'Request permission required',
                404: 'Series not found',
                422: 'Validation error or the media is not a series',
                429: 'Rate limit exceeded',
                503: 'Request service is not reachable',
            },
        },
    },
    handlers: {
        POST: async (event, ctx) => {
            if (!event.locals.user?.hasRequestPermission)
                return ApiProblem.forbidden('Request permission required');
            const limit = await checkRateLimit(
                `${getClientIp(event)}:${event.locals.user.username}:request-seasons`,
                RateLimitPresets.STANDARD.limit,
                RateLimitPresets.STANDARD.windowSeconds,
            );
            if (!limit.allowed)
                return ApiProblem.rateLimited(
                    Math.max(1, Math.ceil(limit.resetAt - Date.now() / 1000)),
                );
            const { externalIds, mediaType } = ctx.input!.body;
            if (mediaType !== 'tv') return ApiProblem.validationFailed('A series is required');
            const resolved = await providerResolutionService.resolveToTmdb(externalIds, 'tv');
            if (!resolved.success) return ApiProblem.notFound('Series not found');
            const items = await jellyseerrClient.getRequestSeasons(resolved.tmdbId);
            if (!items) return ApiProblem.dependencyUnavailable('Request service is not reachable');
            return json({ items });
        },
    },
});
