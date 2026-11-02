// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/short-movies
 *
 * Movies under 90 minutes with AI personalization and damper filtering.
 *
 * Thin adapter: delegates to the shared recommender dispatch
 * (`getRailItems('short-movies', …)`). The strategy owns the user-scoped
 * curated cache (the single cache), the taste-damper context and the
 * availability filter. The legacy `watched=` CSV of already-seen TMDB ids is
 * forwarded through `opts.extra.watchedTmdbIds`. The public response shape is
 * unchanged: reason kind 'for-you', score = imdbRating/10.
 *
 * Response: paginate(RecommendationItem[], page)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { paginate, ApiProblem, isDependencyUnavailable } from '$lib/server/api/problem.js';
import {
    getRailItems,
    buildAccessContext,
    UnknownRailError,
} from '../recommendations/recommender.js';
import { parseWatchedTmdb } from '../recommendations/strategies/rail-extra.js';

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(10),
    watched: z.string().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            const raw = {
                limit: event.url.searchParams.get('limit') ?? undefined,
                watched: event.url.searchParams.get('watched') ?? undefined,
            };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { limit, watched: watchedParam } = parsed.data;

            const accessCtx = await buildAccessContext(event);
            if (!accessCtx) return ApiProblem.unauthorized();

            const watchedTmdbIds = parseWatchedTmdb(watchedParam);
            const extra = watchedTmdbIds.length > 0 ? { watchedTmdbIds } : undefined;

            try {
                const result = await getRailItems('short-movies', accessCtx, {
                    surface: ctx.surface,
                    limit,
                    extra,
                });
                return json(paginate(result.items, { limit, offset: 0, hasMore: result.hasMore }));
            } catch (err) {
                if (err instanceof UnknownRailError) {
                    return ApiProblem.validationFailed([{ field: 'type', message: err.message }]);
                }
                if (isDependencyUnavailable(err)) {
                    return ApiProblem.dependencyUnavailable(err.message);
                }
                throw err;
            }
        },
    },
});
