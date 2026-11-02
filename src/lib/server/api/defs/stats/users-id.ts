// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/stats/users-id.ts — GET /api/v1/stats/users/{id}
 *
 * Social stats — view another user's personal stats.
 *
 * {id} is the stable users.id UUID.
 *
 * Auth: FEATURE_SOCIAL + {kind:'user'}
 * Visibility gate (applied after id resolution):
 *   - self or admin → always allowed
 *   - target has hide_streams=true → 403 (socialVisibility=nobody)
 *   - otherwise → allowed
 *
 * Query parameters:
 *   ?include=<metric>[,<metric>]  — comma-separated metric list; omit for bundle (all)
 *   ?period=7d|30d|90d|all|year:YYYY  — time window (default: all)
 *
 * Note: the target user's stats are filtered by the VIEWER's access context
 * (the authenticated caller), because the viewer cannot see titles that are
 * inaccessible to them regardless of what the target user watched.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import {
    personalStatsService,
    accessFingerprint,
} from '$lib/server/services/personal-stats.service.js';
import { MINIMUM_DATA_REQUIREMENTS } from '$lib/types/personal-stats.js';
import { cacheManager, CACHE_NAMESPACES, buildVersionedCacheKey } from '$lib/server/cache/index.js';
import { StatsPeriodSchema } from '$lib/schemas/personal-stats-types.js';
import {
    PublicSocialStatsResponseSchema,
    PUBLIC_STATS_METRICS,
} from '$lib/schemas/public-personal-stats.js';
import type { StatsPeriod, PersonalStatsType } from '$lib/schemas/personal-stats-types.js';
import { denyAllAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import {
    toPublicStats,
    toPublicUnavailable,
    parsePublicInclude,
    type UnavailableMetric,
} from './transforms.js';

const logger = Logger.for('PersonalStats');

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

/**
 * Query schema for GET /stats/users/{id}.
 * Mirrors the me.ts schema — same query vocabulary. `period` is gated by the
 * canonical `StatsPeriodSchema` (enum 7d|30d|90d|all ∪ `year:YYYY`, 2000-2099);
 * the handler re-validates via the same schema. Metric-name lookup for
 * `include` happens in the handler.
 */
const StatsUsersIdQuerySchema = z.object({
    include: z.string().optional(),
    period: StatsPeriodSchema.optional(),
    // Same bounds as the published query: out of range is a 422.
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
});

// Metrics that require an accessCtx for proper filtering
const ACCESS_SENSITIVE = new Set<PersonalStatsType>(['completion', 'records', 'top-titles']);

function parsePeriod(raw: string | null): StatsPeriod | null {
    const val = raw ?? 'all';
    const parsed = StatsPeriodSchema.safeParse(val);
    return parsed.success ? parsed.data : null;
}

async function computeOneStat(
    type: PersonalStatsType,
    userId: UserId,
    period: StatsPeriod,
    access: MediaAccessBoundary,
): Promise<unknown> {
    switch (type) {
        case 'overview':
            return personalStatsService.getOverviewStats(userId, period);
        case 'watch-time':
            return personalStatsService.getWatchTimeStats(userId, period);
        case 'peak-hours':
            return personalStatsService.getPeakHoursStats(userId, period);
        case 'completion':
            return personalStatsService.getCompletionStats(userId, period, access);
        case 'genres':
            return personalStatsService.getGenreStats(userId, period);
        case 'keywords':
            return personalStatsService.getKeywordStats(userId, period);
        case 'devices':
            return personalStatsService.getDeviceStats(userId, period);
        case 'quality':
            return personalStatsService.getQualityStats(userId, period);
        case 'ratings':
            return personalStatsService.getRatingStats(userId);
        case 'taste-profile':
            return personalStatsService.getTasteProfileStats(userId);
        case 'records':
            return personalStatsService.getFunRecords(userId, period, access);
        case 'top-titles':
            return personalStatsService.getTopTitles(userId, period, access);
    }
}

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Stats'],
            summary: "Get another user's viewing statistics",
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns personal viewing statistics for the specified user. ' +
                'Requires both `FEATURE_SOCIAL` and `FEATURE_PERSONAL_STATS` to be enabled. ' +
                'Subject must have social visibility enabled (`hide_streams` = false). ' +
                "Stats are filtered by the viewer's library access context — the viewer cannot " +
                'see title names for content they cannot access. ' +
                'Self and admins bypass visibility restrictions. ' +
                'The one `limit`/`offset` pair pages genres, keywords and topTitles together; ' +
                'values outside their bounds are a 422. `insufficient_data` entries for another ' +
                "user carry `requiredSessions` but not that user's `sessionCount`.",
            query: z.object({
                include: z
                    .string()
                    .optional()
                    .meta({
                        description:
                            'Comma-separated metric names (camelCase): overview, watchTime, peakHours, ' +
                            'completion, genres, keywords, devices, quality, ratings, tasteProfile, ' +
                            'records, topTitles. Omit for all metrics. Any other name is a 422.',
                    }),
                period: StatsPeriodSchema.optional().meta({
                    description:
                        'Time window (default: all). One of 7d|30d|90d|all or year:YYYY (2000-2099).',
                }),
                limit: z.coerce.number().int().min(1).max(100).default(30).meta({
                    description: 'Page size of the ranked metrics genres, keywords and topTitles.',
                }),
                offset: z.coerce.number().int().min(0).max(10000).default(0).meta({
                    description:
                        'Page offset of the ranked metrics genres, keywords and topTitles.',
                }),
            }),
            responses: {
                200: {
                    schema: PublicSocialStatsResponseSchema,
                    description: 'Target user viewing statistics',
                },
                401: 'Authentication required',
                403: 'User has opted out of social visibility',
                404: 'User not found or feature not enabled',
                422: 'Invalid period, metric name, limit or offset',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_SOCIAL',
        then: { kind: 'user' },
    },
    request: {
        params: z.object({ id: z.string().min(1) }),
        query: StatsUsersIdQuerySchema,
    },
    handlers: {
        /**
         * GET /api/v1/stats/users/{id}
         *
         * Returns personal stats for another user, subject to social visibility.
         *
         * The *viewer's* access context filters surfaced titles (completion, records,
         * top-titles) — the viewer cannot see content inaccessible to them regardless
         * of what the target user watched.
         */
        GET: async (event, ctx) => {
            if (!features.social) {
                return ApiProblem.notFound("Feature 'social' is not enabled");
            }
            if (!features.personalStats) {
                return ApiProblem.notFound("Feature 'personalStats' is not enabled");
            }

            const { url, params, locals } = event;

            const targetId = params.id;
            if (!targetId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);

            const viewerUsername = locals.principal?.username ?? locals.user?.username;
            const viewerIsAdmin = locals.principal?.isAdmin === true;
            // Viewer's own id — from principal preferred (Q8); both have UserId
            const viewerUserId = locals.principal?.userId ?? locals.user?.userId;

            if (!viewerUsername) return ApiProblem.unauthorized();

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Resolve target user
            const targetUser = await getUserById(db, targetId);
            if (!targetUser) return ApiProblem.notFound('User not found');

            const targetUserId = toUserId(targetUser.id);

            // --- Visibility check (self/admin bypass) ---
            const isSelf = viewerUserId === targetUser.id;
            if (!isSelf && !viewerIsAdmin) {
                // hide_streams = true means the user has opted out of social visibility.
                // `hide_streams = true` maps to `nobody`, `false/null` to `instance`.
                if (targetUser.hide_streams === true) {
                    return ApiProblem.forbidden('This user has opted out of social visibility.');
                }
            }

            // --- Parse query params ---
            const periodRaw = url.searchParams.get('period');
            const period = parsePeriod(periodRaw);
            if (!period) {
                return ApiProblem.validationFailed([
                    {
                        field: 'period',
                        message: `Invalid period '${periodRaw}'. Must be 7d|30d|90d|all|year:YYYY (2000-2099).`,
                        value: periodRaw,
                    },
                ]);
            }

            const { metrics: requestedMetrics, invalid: invalidMetrics } = parsePublicInclude(
                url.searchParams.get('include'),
            );
            if (invalidMetrics.length > 0) {
                return ApiProblem.validationFailed([
                    {
                        field: 'include',
                        message: `Unknown metric(s): ${invalidMetrics.join(', ')}. Use one of: ${PUBLIC_STATS_METRICS.join(', ')}`,
                        value: invalidMetrics,
                    },
                ]);
            }

            // --- Viewer's access context (for filtering titles in target's stats) ---
            // Always thread the viewer's access boundary to avoid surfacing
            // restricted title names in stats.
            const needsAccessCtx = requestedMetrics.some((m) => ACCESS_SENSITIVE.has(m));
            let viewerAccessCtx: MediaAccessBoundary | undefined;
            if (needsAccessCtx && locals.user) {
                viewerAccessCtx = await buildSearchAccessContext(db, locals.user)
                    .then(searchAccessBoundary)
                    .catch(() => undefined);
            }
            // Fail CLOSED — an undefined boundary skipped filtering AND cached the
            // unfiltered payload under the shared un-fingerprinted key. Covers all
            // three ways the boundary can go missing: no locals.user, a rejected
            // buildSearchAccessContext, and (in me.ts) no database handle.
            const accessCtxUnavailable = needsAccessCtx && !viewerAccessCtx;
            // The boundary actually handed to computeOneStat. It is REQUIRED now,
            // so the "no boundary" case has to name a scope rather than vanish:
            // denyAll, never unrestricted. Access-sensitive metrics are already
            // refused above when the boundary is missing; this makes the residual
            // path fail closed instead of unfiltered if that gate is ever bypassed.
            const accessBoundary = viewerAccessCtx ?? denyAllAccess();

            const statsCache = cacheManager.for(CACHE_NAMESPACES.personalStats);
            const fingerprint = viewerAccessCtx ? accessFingerprint(viewerAccessCtx) : '';

            // --- Session count gate ---
            // null = the count could not be read: every requested metric is
            // reported `failed` (retryable), never `insufficient_data`.
            const sessionCount = await personalStatsService
                .getSessionCount(targetUserId)
                .catch((err: unknown) => {
                    logger.warn('Session count lookup failed; metrics reported failed', {
                        error: String(err),
                    });
                    return null;
                });

            // --- Fan-out over requested metrics ---
            const metricsOut: Partial<Record<PersonalStatsType, unknown>> = {};
            const unavailableOut: UnavailableMetric[] = [];

            await Promise.allSettled(
                requestedMetrics.map(async (type) => {
                    if (sessionCount === null) {
                        unavailableOut.push({ type, reason: 'failed' });
                        return;
                    }
                    const minRequired = MINIMUM_DATA_REQUIREMENTS[type];
                    if (sessionCount < minRequired) {
                        unavailableOut.push({ type, reason: 'insufficient_data' });
                        return;
                    }

                    const isAccessSensitive = ACCESS_SENSITIVE.has(type);
                    if (isAccessSensitive && accessCtxUnavailable) {
                        unavailableOut.push({ type, reason: 'access_unavailable' });
                        return;
                    }
                    // Cache is keyed by target user id + viewer's access fingerprint.
                    // Different viewers with different access restrictions must NOT share
                    // a filtered result (that could reveal restricted content to a more
                    // restricted viewer via the cache).
                    const cacheKey =
                        isAccessSensitive && fingerprint
                            ? buildVersionedCacheKey('adminStats', type, period, fingerprint)
                            : buildVersionedCacheKey('adminStats', type, period);

                    const cached = await statsCache.get<{ stats: unknown }>(cacheKey, targetUserId);
                    if (cached) {
                        metricsOut[type] = cached.stats;
                        return;
                    }

                    try {
                        const stats = await computeOneStat(
                            type,
                            targetUserId,
                            period,
                            accessBoundary,
                        );
                        metricsOut[type] = stats;
                        await statsCache.set(
                            cacheKey,
                            { type, period, stats },
                            undefined,
                            targetUserId,
                        );
                    } catch {
                        unavailableOut.push({ type, reason: 'failed' });
                    }
                }),
            );

            // --- Convert the internal (cached) shapes to the public DTOs ---
            // The cache keeps the internal shape; the ranked metrics are paged here.
            const { metrics, failed } = toPublicStats(metricsOut, {
                limit: ctx.input?.query?.limit ?? 30,
                offset: ctx.input?.query?.offset ?? 0,
                surface: ctx.surface,
            });
            for (const type of failed) unavailableOut.push({ type, reason: 'failed' });
            // Another user's session count is not the viewer's to see.
            const unavailable = toPublicUnavailable(unavailableOut, sessionCount ?? 0, {
                includeSessionCount: isSelf,
            });

            return json({
                subject: {
                    id: targetUser.id,
                    username: targetUser.username,
                    displayName: targetUser.display_name ?? undefined,
                },
                period,
                metrics,
                unavailable,
            });
        },
    },
});
