// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/stats/username.ts — GET /api/stats/[username]
 *
 * Admin (or self) single-type stats lookup by username.
 *
 * Contract: bare object — PersonalStatsEnvelope.
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
import { cacheManager, CACHE_NAMESPACES, buildVersionedCacheKey } from '$lib/server/cache/index.js';
import {
    personalStatsService,
    accessFingerprint,
} from '$lib/server/services/personal-stats.service.js';
import { MINIMUM_DATA_REQUIREMENTS } from '$lib/types/personal-stats.js';
import { features } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { denyAllAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { PersonalStatsType, StatsPeriod } from '$lib/types/personal-stats.js';
import {
    PersonalStatsEnvelopeSchema,
    type PersonalStatsEnvelope,
} from '$lib/schemas/api-stats-responses.js';

const logger = Logger.for('AdminStatsDef');

const VALID_TYPES: PersonalStatsType[] = [
    'overview',
    'watch-time',
    'peak-hours',
    'completion',
    'genres',
    'keywords',
    'devices',
    'quality',
    'ratings',
    'taste-profile',
    'records',
    'top-titles',
];

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
        query: z.object({
            type: z.string().optional(),
            period: z.string().optional(),
        }),
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

            const type = (url.searchParams.get('type') ?? 'overview') as PersonalStatsType;
            const period = (url.searchParams.get('period') ?? 'all') as StatsPeriod;

            if (!VALID_TYPES.includes(type)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'type',
                        message: `Invalid stat type: ${type}. Valid types: ${VALID_TYPES.join(', ')}`,
                        value: type,
                    },
                ]);
            }

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

            const isAccessSensitive =
                type === 'completion' || type === 'records' || type === 'top-titles';
            const accessCtx = isAccessSensitive
                ? await buildSearchAccessContext(dbSql, locals.user)
                      .then(searchAccessBoundary)
                      .catch(() => undefined)
                : undefined;
            // Required-by-shape: the service parameter is no longer optional, so an
            // unavailable boundary must NAME a scope rather than vanish. denyAll,
            // never unrestricted — computing an access-sensitive type without a
            // boundary is precisely the fail-open this migration removes. The
            // fingerprint is derived from the SAME value, so a denyAll fallback
            // gets its own cache key instead of poisoning the unrestricted entry.
            const accessBoundary = accessCtx ?? denyAllAccess();

            const statsCache = cacheManager.for(CACHE_NAMESPACES.personalStats);
            const fingerprint = isAccessSensitive ? accessFingerprint(accessBoundary) : '';
            const cacheKey = fingerprint
                ? buildVersionedCacheKey('adminStats', type, period, fingerprint)
                : buildVersionedCacheKey('adminStats', type, period);

            const cached = await statsCache.get<PersonalStatsEnvelope>(cacheKey, uid);
            if (cached) {
                logger.debug('Cache hit for admin stats', { type, period, targetUsername });
                return json(PersonalStatsEnvelopeSchema.parse(cached));
            }

            logger.info('Computing stats for user', {
                type,
                period,
                targetUsername,
                requestedBy: currentUser,
            });

            const sessionCount = await personalStatsService.getSessionCount(uid);
            const minRequired = MINIMUM_DATA_REQUIREMENTS[type];

            if (sessionCount < minRequired) {
                return json(
                    PersonalStatsEnvelopeSchema.parse({
                        type,
                        insufficientData: true,
                        sessionCount,
                        minRequired,
                        message: `User needs at least ${minRequired} viewing sessions for ${type} stats. They have ${sessionCount}.`,
                    } satisfies PersonalStatsEnvelope),
                );
            }

            let stats: PersonalStatsEnvelope['stats'];

            switch (type) {
                case 'overview':
                    stats = await personalStatsService.getOverviewStats(uid, period);
                    break;
                case 'watch-time':
                    stats = await personalStatsService.getWatchTimeStats(uid, period);
                    break;
                case 'peak-hours':
                    stats = await personalStatsService.getPeakHoursStats(uid, period);
                    break;
                case 'completion':
                    stats = await personalStatsService.getCompletionStats(
                        uid,
                        period,
                        accessBoundary,
                    );
                    break;
                case 'genres':
                    stats = await personalStatsService.getGenreStats(uid, period);
                    break;
                case 'keywords':
                    stats = await personalStatsService.getKeywordStats(uid, period);
                    break;
                case 'devices':
                    stats = await personalStatsService.getDeviceStats(uid, period);
                    break;
                case 'quality':
                    stats = await personalStatsService.getQualityStats(uid, period);
                    break;
                case 'ratings':
                    stats = await personalStatsService.getRatingStats(uid);
                    break;
                case 'taste-profile':
                    stats = await personalStatsService.getTasteProfileStats(uid);
                    break;
                case 'records':
                    stats = await personalStatsService.getFunRecords(uid, period, accessBoundary);
                    break;
                case 'top-titles':
                    stats = await personalStatsService.getTopTitles(uid, period, accessBoundary);
                    break;
                default:
                    return ApiProblem.validationFailed([
                        { field: 'type', message: `Unknown stat type: ${type}`, value: type },
                    ]);
            }

            const response: PersonalStatsEnvelope = { type, period, stats };
            await statsCache.set(cacheKey, response, undefined, uid);

            return json(PersonalStatsEnvelopeSchema.parse(response));
        },
    },
});
