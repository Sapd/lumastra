// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/trending
 *
 * Trending movies and shows — global cache (15min L1 / 1hr L2).
 * Delegates to the existing trendingStrategy so results are consistent with
 * /api/v1/trending.
 *
 * Response: paginate(RecommendationItem[], page)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { paginate, ApiProblem } from '$lib/server/api/problem.js';
import { runRecommender, buildAccessContext } from '../recommendations/recommender.js';
import { trendingStrategy } from '../recommendations/strategies/index.js';

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(20).optional().default(10),
    offset: z.coerce.number().int().min(0).optional().default(0),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event, surfaceCtx) => {
            const raw = {
                limit: event.url.searchParams.get('limit') ?? undefined,
                offset: event.url.searchParams.get('offset') ?? undefined,
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
            const { limit, offset } = parsed.data;

            const ctx = await buildAccessContext(event);
            if (!ctx) return ApiProblem.unauthorized();

            const result = await runRecommender(trendingStrategy, ctx, {
                surface: surfaceCtx.surface,
                limit,
                offset,
            });

            return json(paginate(result.items, { limit, offset, hasMore: result.hasMore }));
        },
    },
});
