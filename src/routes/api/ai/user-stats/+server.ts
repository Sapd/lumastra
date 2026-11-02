// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/ai/user-stats
 *
 * User AI rating statistics.
 *
 * Caching: User-scoped L1/L2 cache (5min L1 / 1hr L2).
 * Stats change when users rate items, but we can tolerate slight delay.
 *
 * Response: bare object via json() + problem+json errors
 * incl. 503 dependency_unavailable when the DB is down.
 *
 * Auth: user. Surface: internal.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { UserStatsResponseSchema } from '$lib/schemas/api-ai-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { getUserRatingCount, getUserTodayRatingCount } from '$lib/server/database/queries';

const logger = Logger.for('UserStatsAPI');
const userStatsCache = cacheManager.for(CACHE_NAMESPACES.userRatings);

interface UserStats {
    totalRatings: number;
    todayRatings: number;
    aiConfidence: number;
}

/**
 * Calculate AI confidence based on total ratings.
 * More ratings = better understanding of user preferences.
 */
function calculateAiConfidence(totalRatings: number): number {
    // 0-20 ratings: 10-70% confidence (Getting Started -> Learning)
    // 20-40 ratings: 70-80% confidence (Learning -> Understanding)
    // 40-60 ratings: 80-90% confidence (Understanding -> Expert)
    // 60+ ratings: 90-100% confidence (Expert -> Soulmate AI)
    let confidence: number;
    if (totalRatings === 0) {
        confidence = 10;
    } else if (totalRatings <= 20) {
        confidence = Math.min(70, 10 + totalRatings * 3);
    } else if (totalRatings <= 40) {
        confidence = Math.min(80, 70 + (totalRatings - 20) * 0.5);
    } else if (totalRatings <= 60) {
        confidence = Math.min(90, 80 + (totalRatings - 40) * 0.5);
    } else {
        confidence = Math.min(100, 90 + (totalRatings - 60) * 0.25);
    }
    return Math.round(confidence);
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            // Use dev user override system
            const { getEffectiveUser } = await import('$lib/server/dev-user');
            const authenticatedUser = event.locals.user?.username;
            const userId = getEffectiveUser(event.request, authenticatedUser);

            if (!userId || userId === 'anonymous') {
                return ApiProblem.unauthorized('User not authenticated');
            }

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            // Resolve username → users.id UUID. The cache MUST be scoped by this
            // UUID (not the username) so it matches cacheInvalidation.onUserRating(),
            // which deletes by UUID. Scoping by username left the count stale after a
            // rating — "Rate N to unlock For You" never cleared until the TTL expired.
            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries');
            const resolvedUserId = await getUserIdByUsername(sql, userId);
            if (!resolvedUserId) {
                return ApiProblem.notFound('User not found');
            }

            // Check L1/L2 cache first (scoped by the resolved UUID)
            const cacheKey = 'stats';
            const cached = await userStatsCache.get<UserStats>(cacheKey, resolvedUserId);
            if (cached) {
                return json(UserStatsResponseSchema.parse({ stats: cached, cached: true }));
            }

            // Use centralized typed queries
            const [totalRatings, todayRatings] = await Promise.all([
                getUserRatingCount.getOrDefault(sql, { userId: resolvedUserId }, 0),
                getUserTodayRatingCount.getOrDefault(sql, { userId: resolvedUserId }, 0),
            ]);

            const stats: UserStats = {
                totalRatings,
                todayRatings,
                aiConfidence: calculateAiConfidence(totalRatings),
            };

            // Cache the stats for future requests (UUID-scoped — see above)
            await userStatsCache.set(cacheKey, stats, undefined, resolvedUserId);

            logger.debug('Fetched user statistics', { resolvedUserId, stats });

            return json(UserStatsResponseSchema.parse({ stats }));
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
