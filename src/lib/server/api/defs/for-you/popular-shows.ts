// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/popular-shows
 *
 * Popular TV shows.
 *
 * Thin adapter: delegates to the shared recommender dispatch
 * (`getRailItems('popular-shows', …)`). The strategy owns the global curated
 * cache (the single cache) and the already-watched exclusion. The public
 * response shape is unchanged: the strategy emits the identical
 * `RecommendationItem` batch (reason kind 'trending', score = rating/10).
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

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(30).optional().default(10),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, ctx) => {
            const raw = { limit: event.url.searchParams.get('limit') ?? undefined };
            const parsed = QuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { limit } = parsed.data;

            const accessCtx = await buildAccessContext(event);
            if (!accessCtx) return ApiProblem.unauthorized();

            try {
                const result = await getRailItems('popular-shows', accessCtx, {
                    surface: ctx.surface,
                    limit,
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
