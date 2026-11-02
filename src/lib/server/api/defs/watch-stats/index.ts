// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * watch-stats/ — admin global watch-stats aggregates (SPA-internal surface).
 *
 * GET /watch-stats?type=&timeframe=&limit=&sort=&day=
 *
 * Auth: {kind:'admin'} — admin-only.
 * Visibility: internal (SPA admin dashboard; mirrors /api/v1/admin/watch-stats
 * but stays on the SPA surface without /api/v1 bearer requirements).
 *
 * Response contract: bare { stats, day? }  (no legacy `success: true` wrapper)
 * Errors: problem+json (incl. 503 dependency_unavailable).
 *
 * Query logic is shared with /api/v1/admin/watch-stats via admin-stats.service.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { cacheManager, CACHE_NAMESPACES, buildVersionedCacheKey } from '$lib/server/cache/index.js';
import {
    fetchAdminStats,
    type AdminStatsPayload,
} from '$lib/server/services/admin-stats.service.js';
import type { Timeframe } from '$lib/server/database/queries/admin-stats.queries.js';

// ---------------------------------------------------------------------------
// Request schema — mirrors WatchStatsQuerySchema from api-query-params.ts
// ---------------------------------------------------------------------------

const WatchStatsQuery = z.object({
    type: z
        .enum([
            'movies',
            'tvshows',
            'activity',
            'top-users',
            'active-users',
            'genre-breakdown',
            'content-freshness',
            'day-hours',
            'cold-content',
            'completion-leaderboard',
            'dormant-users',
            'device-mix',
            'surface-mix',
            'summary',
        ])
        .optional()
        .default('summary'),
    timeframe: z.enum(['AllTime', 'LastWeek', 'LastMonth']).optional().default('AllTime'),
    limit: z.coerce.number().int().min(1).max(200).optional().default(10),
    day: z.string().optional(),
    sort: z.enum(['cold', 'skyline']).optional().default('cold'),
});

// ---------------------------------------------------------------------------
// Endpoint def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: WatchStatsQuery,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const q = ctx.input?.query ?? {
                type: 'summary' as const,
                timeframe: 'AllTime' as const,
                limit: 10,
                sort: 'cold' as const,
            };

            const type = q.type;
            const timeframe = q.timeframe as Timeframe;
            const limit = q.limit ?? 10;
            const sort = q.sort ?? 'cold';
            const day = q.day ?? '';

            // Sanitise the day param before it becomes a cache-key segment so a
            // crafted value (e.g. containing ':') cannot shift key fields and
            // collide with a different aggregate.
            const daySegment = day.replace(/[^a-zA-Z]/g, '').slice(0, 16) || '-';

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const cache = cacheManager.for(CACHE_NAMESPACES.watchStats);
            const cacheKey = buildVersionedCacheKey(
                'adminStats',
                type,
                timeframe,
                daySegment,
                String(limit),
                sort,
            );

            const cached = await cache.get<AdminStatsPayload>(cacheKey);
            if (cached) {
                return json(cached);
            }

            const payload = await fetchAdminStats(sql, {
                type,
                timeframe,
                limit,
                sort,
                day,
                daySegment,
            });

            await cache.set(cacheKey, payload);

            return json(payload);
        },
    },
});
