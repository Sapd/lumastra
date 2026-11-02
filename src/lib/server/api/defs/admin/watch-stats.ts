// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/watch-stats.ts — GET /api/v1/admin/watch-stats
 *
 * Instance-wide ops aggregates (not personal stats); admin surface. Returns
 * clean `{ stats, day? }` — no legacy `{ success }` envelope. Query logic is
 * shared with `/api/watch-stats` via admin-stats.service.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/admin/watch-stats/`
 * `+server.ts` (`requireAdmin(withErrorHandler(withValidation(...)))`).
 * Behaviour is preserved exactly:
 *   - Auth: `{kind:'admin'}` → mount()'s enforce() runs the SAME
 *     locals.principal/locals.user.isAdmin + resolveBearerAdminPrincipal()
 *     primitives as `requireAdmin`.
 *   - Query validation stays IN-HANDLER via the ORIGINAL `withValidation()`
 *     call (reused directly, not re-implemented) — preserves the exact
 *     `ApiResponses.validationError` 422 envelope and field-naming instead of
 *     mount()'s declarative `request.query` slot.
 *   - `withErrorHandler` is dropped: mount()'s own error wrapper provides the
 *     equivalent problem+json 500 fallback for uncaught throws (established
 *     Phase 3 precedent — see defs/library/scan.ts, defs/runs/index.ts).
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { withValidation } from '$lib/server/middleware/validate.js';
import { problem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { cacheManager, CACHE_NAMESPACES, buildVersionedCacheKey } from '$lib/server/cache';
import {
    fetchAdminStats,
    type AdminStatsPayload,
} from '$lib/server/services/admin-stats.service.js';
import { type Timeframe } from '$lib/server/database/queries/admin-stats.queries.js';
import { WatchStatsQuerySchema } from '$lib/schemas/api-query-params.js';
import { WatchStatsResponseSchema } from '$lib/schemas/api-admin-responses';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get admin watch stats',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: { schema: WatchStatsResponseSchema, description: 'Watch stats aggregates' },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: withValidation(
            async ({ validated }) => {
                const type = validated.query.type;
                const timeframe = validated.query.timeframe as Timeframe;
                const limit = validated.query.limit;
                const sort = validated.query.sort;
                const day = validated.query.day ?? '';
                const daySegment = day.replace(/[^a-zA-Z]/g, '').slice(0, 16) || '-';

                const sql = getDb();
                if (!sql) {
                    return problem('dependency_unavailable', { error: 'Database not available' });
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
            { query: WatchStatsQuerySchema },
        ),
    },
});
