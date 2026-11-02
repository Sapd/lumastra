// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/anime
 *
 * Anime recommendations with AI personalization.
 *
 * Thin adapter: delegates to the shared recommender dispatch
 * (`getRailItems('anime', …)`). The strategy owns the user-scoped curated cache
 * (the single cache), the taste-damper context, the availability filter and the
 * combined watched exclusion. The legacy `watched=` CSV (TMDB ids) and
 * `watchedIds=` CSV (internal UUIDs) are forwarded through
 * `opts.extra.watchedTmdbIds` / `opts.extra.watchedUuids`. The public response
 * shape is unchanged: reason kind 'ai', score = aiSimilarity/100.
 *
 * AGE GATE: anime is unavailable to age-restricted profiles. The canonical 403
 * is enforced HERE (this route has the request principal) before dispatch — the
 * strategy also defensively returns an empty result so /feed can never leak it.
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
import { parseWatchedTmdb, parseWatchedUuids } from '../recommendations/strategies/rail-extra.js';

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(40).optional().default(10),
    watchedIds: z.string().optional(),
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
                watchedIds: event.url.searchParams.get('watchedIds') ?? undefined,
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
            const { limit, watchedIds: watchedIdsParam, watched: watchedParam } = parsed.data;

            const accessCtx = await buildAccessContext(event);
            if (!accessCtx) return ApiProblem.unauthorized();

            // Age-restricted profiles cannot access anime recommendations.
            if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'This feature is not available for age-restricted profiles',
                );
            }

            const watchedTmdbIds = parseWatchedTmdb(watchedParam);
            const watchedUuids = parseWatchedUuids(watchedIdsParam);
            const extraEntries: Record<string, unknown> = {
                ...(watchedTmdbIds.length > 0 ? { watchedTmdbIds } : {}),
                ...(watchedUuids.length > 0 ? { watchedUuids } : {}),
            };
            const extra = Object.keys(extraEntries).length > 0 ? extraEntries : undefined;

            try {
                const result = await getRailItems('anime', accessCtx, {
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
