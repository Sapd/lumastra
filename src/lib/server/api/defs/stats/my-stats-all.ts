// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/stats/my-stats-all.ts — GET /api/my-stats/all
 *
 * Composite personal statistics (all types) for the authenticated user.
 *
 * Contract: bare object — AllStatsResponse.
 * DB down → 503 dependency_unavailable.
 *
 * Auth: user.
 * Feature gate: FEATURE_PERSONAL_STATS.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { personalStatsService } from '$lib/server/services/personal-stats.service.js';
import { features } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { denyAllAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { StatsPeriod } from '$lib/types/personal-stats.js';
import { AllStatsResponseSchema } from '$lib/schemas/api-stats-responses.js';

const logger = Logger.for('MyStatsAllDef');

const VALID_PERIODS: StatsPeriod[] = ['7d', '30d', '90d', 'all'];

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_PERSONAL_STATS',
        then: { kind: 'user' },
    },
    visibility: 'internal',
    request: {
        query: z.object({ period: z.string().optional() }),
    },
    handlers: {
        GET: async (event, _ctx) => {
            if (!features.personalStats) {
                return ApiProblem.notFound("Feature 'personalStats' is not enabled");
            }

            const { url, locals } = event;
            const period = (url.searchParams.get('period') ?? 'all') as StatsPeriod;

            if (!VALID_PERIODS.includes(period)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'period',
                        message: `Invalid period: ${period}. Valid periods: ${VALID_PERIODS.join(', ')}`,
                        value: period,
                    },
                ]);
            }

            const username = locals.user.username;
            const userId = locals.user.userId;

            logger.info('Computing all personal stats', { period, username });

            const dbForAccess = getDb();
            const accessCtx = dbForAccess
                ? await buildSearchAccessContext(dbForAccess, locals.user)
                      .then(searchAccessBoundary)
                      .catch(() => undefined)
                : undefined;
            // Required-by-shape: getAllStats no longer accepts "no boundary".
            // The fallback is denyAll, never unrestricted — a missing DB handle or
            // a rejected buildSearchAccessContext used to degrade this endpoint to
            // UNFILTERED completion/records/top-titles, cached under the shared
            // un-fingerprinted key. denyAll keys separately and returns nothing.
            const accessBoundary = accessCtx ?? denyAllAccess();

            const statsCache = cacheManager.for(CACHE_NAMESPACES.personalStats);
            const result = await personalStatsService.getAllStats(
                userId,
                period,
                'personalStats',
                statsCache,
                accessBoundary,
            );

            return json(AllStatsResponseSchema.parse(result));
        },
    },
});
