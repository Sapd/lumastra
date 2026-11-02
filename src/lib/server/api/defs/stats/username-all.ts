// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/stats/username-all.ts — GET /api/stats/[username]/all
 *
 * Admin (or self) composite stats (all types) by username.
 *
 * Contract: bare object — AllStatsResponse.
 * DB down → 503 dependency_unavailable.
 *
 * Auth: user (permission check: admin or self enforced in handler).
 * Feature gate: FEATURE_PERSONAL_STATS.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { personalStatsService } from '$lib/server/services/personal-stats.service.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { features } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import type { StatsPeriod } from '$lib/types/personal-stats.js';
import { AllStatsResponseSchema } from '$lib/schemas/api-stats-responses.js';

const logger = Logger.for('AdminStatsAllDef');

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
        params: z.object({ username: z.string().min(1) }),
        query: z.object({ period: z.string().optional() }),
    },
    handlers: {
        GET: async (event, _ctx) => {
            if (!features.personalStats) {
                return ApiProblem.notFound("Feature 'personalStats' is not enabled");
            }

            const { url, params, locals } = event;
            const targetUsername = params.username;
            if (!targetUsername) {
                return ApiProblem.validationFailed([
                    { field: 'username', message: 'Username is required' },
                ]);
            }

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

            const currentUser = locals.user.username;
            const isAdmin = locals.principal?.isAdmin === true;
            const isOwnStats = currentUser.toLowerCase() === targetUsername.toLowerCase();

            if (!isAdmin && !isOwnStats) {
                logger.warn('Unauthorized stats access attempt', {
                    currentUser,
                    targetUsername,
                    isAdmin,
                });
                return ApiProblem.forbidden(
                    'You can only view your own statistics. Use /my-stats instead.',
                );
            }

            const dbSql = getDb();
            if (!dbSql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const uid = await getUserIdByUsername(dbSql, targetUsername);
            if (!uid) {
                return ApiProblem.notFound(`User '${targetUsername}' not found`);
            }

            logger.info('Computing all stats for user', {
                period,
                targetUsername,
                requestedBy: currentUser,
            });

            const statsCache = cacheManager.for(CACHE_NAMESPACES.personalStats);
            // Explicitly UNRESTRICTED. This admin surface previously passed NO
            // access argument at all, which meant the same thing but invisibly —
            // exactly the omission the required-by-shape boundary exists to
            // surface. The behaviour is unchanged (unrestricted still fingerprints
            // to '', so warm cache entries stay valid); it is now greppable.
            //
            // NOTE the deliberate divergence from `users-id.ts`, the other
            // admin-scoped stats surface, which threads the VIEWER's boundary and
            // reports access-sensitive metrics unavailable when it cannot build
            // one. Narrowing this endpoint to match would change which titles an
            // admin sees, which is out of scope for this migration — but it is the
            // obvious follow-up.
            const result = await personalStatsService.getAllStats(
                uid,
                period,
                'adminStats',
                statsCache,
                unrestrictedAccess(),
            );

            return json(AllStatsResponseSchema.parse(result));
        },
    },
});
