// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/stats/my-stats.ts — GET /api/my-stats
 *
 * Personal statistics for the authenticated user (single type).
 *
 * Contract: bare object — PersonalStatsEnvelope.
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
import { cacheManager, CACHE_NAMESPACES, buildVersionedCacheKey } from '$lib/server/cache/index.js';
import {
    personalStatsService,
    accessFingerprint,
} from '$lib/server/services/personal-stats.service.js';
import {
    MINIMUM_DATA_REQUIREMENTS,
    type PersonalStatsType,
    type StatsPeriod,
} from '$lib/types/personal-stats.js';
import { features } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { denyAllAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    PersonalStatsEnvelopeSchema,
    type PersonalStatsEnvelope,
} from '$lib/schemas/api-stats-responses.js';

const logger = Logger.for('MyStatsDef');

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

            const { url, locals } = event;
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

            const username = locals.user.username;
            const userId = locals.user.userId;

            const accessSensitive =
                type === 'completion' || type === 'records' || type === 'top-titles';
            const dbForAccess = accessSensitive ? getDb() : null;
            const accessCtx = dbForAccess
                ? await buildSearchAccessContext(dbForAccess, locals.user)
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
            const fingerprint = accessSensitive ? accessFingerprint(accessBoundary) : '';

            const statsCache = cacheManager.for(CACHE_NAMESPACES.personalStats);
            const cacheKey = fingerprint
                ? buildVersionedCacheKey('personalStats', type, period, fingerprint)
                : buildVersionedCacheKey('personalStats', type, period);

            const cached = await statsCache.get<PersonalStatsEnvelope>(cacheKey, userId);
            if (cached) {
                logger.debug('Cache hit for personal stats', { type, period, username });
                return json(PersonalStatsEnvelopeSchema.parse(cached));
            }

            logger.info('Computing personal stats', { type, period, username });

            const sessionCount = await personalStatsService.getSessionCount(userId);
            const minRequired = MINIMUM_DATA_REQUIREMENTS[type];

            if (sessionCount < minRequired) {
                return json({
                    type,
                    insufficientData: true,
                    sessionCount,
                    minRequired,
                    message: `Need at least ${minRequired} viewing sessions for ${type} stats. You have ${sessionCount}.`,
                } satisfies PersonalStatsEnvelope);
            }

            let stats: PersonalStatsEnvelope['stats'];

            switch (type) {
                case 'overview':
                    stats = await personalStatsService.getOverviewStats(userId, period);
                    break;
                case 'watch-time':
                    stats = await personalStatsService.getWatchTimeStats(userId, period);
                    break;
                case 'peak-hours':
                    stats = await personalStatsService.getPeakHoursStats(userId, period);
                    break;
                case 'completion':
                    stats = await personalStatsService.getCompletionStats(
                        userId,
                        period,
                        accessBoundary,
                    );
                    break;
                case 'genres':
                    stats = await personalStatsService.getGenreStats(userId, period);
                    break;
                case 'keywords':
                    stats = await personalStatsService.getKeywordStats(userId, period);
                    break;
                case 'devices':
                    stats = await personalStatsService.getDeviceStats(userId, period);
                    break;
                case 'quality':
                    stats = await personalStatsService.getQualityStats(userId, period);
                    break;
                case 'ratings':
                    stats = await personalStatsService.getRatingStats(userId);
                    break;
                case 'taste-profile':
                    stats = await personalStatsService.getTasteProfileStats(userId);
                    break;
                case 'records':
                    stats = await personalStatsService.getFunRecords(
                        userId,
                        period,
                        accessBoundary,
                    );
                    break;
                case 'top-titles':
                    stats = await personalStatsService.getTopTitles(userId, period, accessBoundary);
                    break;
                default:
                    return ApiProblem.validationFailed([
                        { field: 'type', message: `Unknown stat type: ${type}`, value: type },
                    ]);
            }

            const response: PersonalStatsEnvelope = { type, period, stats };
            await statsCache.set(cacheKey, response, undefined, userId);

            return json(PersonalStatsEnvelopeSchema.parse(response));
        },
    },
});
