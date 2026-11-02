// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/stats/me.ts — GET /api/v1/me/stats
 *
 * User-facing personal statistics for the authenticated user.
 *
 * Query parameters:
 *   ?include=<metric>[,<metric>]  — comma-separated camelCase metric list; omit for bundle (all)
 *   ?period=7d|30d|90d|all|year:YYYY  — time window (default: all)
 *
 * Response shape: { subject, period, metrics, unavailable[] } (see public-personal-stats.ts)
 *   - `metrics` holds only the requested (and available) metrics, camelCase, typed.
 *   - `unavailable[]` lists omitted metrics with a reason (insufficient_data |
 *     access_unavailable | failed), in canonical metric order.
 *
 * Auth: {kind:'user'} — any authenticated user (session, PAT, device JWT, svc).
 * Feature gate: FEATURE_PERSONAL_STATS.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getDb } from '$lib/server/database/connection.js';
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
    PublicPersonalStatsResponseSchema,
    PUBLIC_STATS_METRICS,
} from '$lib/schemas/public-personal-stats.js';
import type { StatsPeriod, PersonalStatsType } from '$lib/schemas/personal-stats-types.js';
import { denyAllAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { UserId } from '$lib/shared/user-id.js';
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
 * Query schema for GET /stats/me.
 *
 * `period` is gated by the canonical `StatsPeriodSchema` — the full grammar
 * (enum 7d|30d|90d|all ∪ `year:YYYY`, 2000-2099). The handler re-validates via
 * the same schema as defense-in-depth. `include` (comma-separated metric names)
 * is semantically validated in the handler.
 *
 * `limit` and `offset` apply to ranked-metric sub-pages (top-titles,
 * genres, keywords); they are coerced from query-string strings.
 */
const StatsMeQuerySchema = z.object({
    /** Comma-separated metric names, e.g. "overview,genres". */
    include: z.string().optional(),
    /** Time window: 7d | 30d | 90d | all | year:YYYY */
    period: StatsPeriodSchema.optional(),
    /** Page size of the ranked metrics (genres, keywords, topTitles together); out of range is a 422. */
    limit: z.coerce.number().int().min(1).max(100).default(30),
    /** Page offset of the ranked metrics; out of range is a 422. */
    offset: z.coerce.number().int().min(0).max(10000).default(0),
});

// Metrics that require an accessCtx for proper filtering
const ACCESS_SENSITIVE = new Set<PersonalStatsType>(['completion', 'records', 'top-titles']);

/**
 * Parse and validate ?period= query param.
 */
function parsePeriod(raw: string | null): StatsPeriod | null {
    const val = raw ?? 'all';
    const parsed = StatsPeriodSchema.safeParse(val);
    return parsed.success ? parsed.data : null;
}

/**
 * Dispatch a single stat computation.
 */
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
        GET: {
            tags: ['Stats'],
            summary: 'Get personal viewing statistics',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns personal viewing statistics for the authenticated user. ' +
                'Requires `FEATURE_PERSONAL_STATS` to be enabled. ' +
                'Use `?include=<metric>[,<metric>]` for partial fetches (comma-separated). ' +
                'Available metrics: overview, watchTime, peakHours, completion, genres, ' +
                'keywords, devices, quality, ratings, tasteProfile, records, topTitles. ' +
                'Durations are integer milliseconds (`*Ms`), timestamps ISO 8601 (`*At`). ' +
                'Metrics that cannot be returned are listed in `unavailable` with a reason. ' +
                'Use `?period=7d|30d|90d|all|year:YYYY` to set the time window (default: all). ' +
                'The one `limit`/`offset` pair pages genres, keywords and topTitles together; ' +
                'values outside their bounds are a 422.',
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
                    schema: PublicPersonalStatsResponseSchema,
                    description: 'Personal viewing statistics',
                },
                401: 'Authentication required',
                404: 'Feature not enabled',
                422: 'Invalid period, metric name, limit or offset',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_PERSONAL_STATS',
        then: { kind: 'user' },
    },
    request: {
        query: StatsMeQuerySchema,
    },
    handlers: {
        /**
         * GET /api/v1/me/stats
         *
         * Returns personal viewing stats for the authenticated user.
         * Respects ?include= for partial fetches; ?period= for time windowing.
         *
         * Response:
         *   {
         *     subject: { id, username },
         *     period: string,
         *     metrics: PublicStatsMetrics,             // typed, camelCase, ms units
         *     unavailable: PublicStatsUnavailable[],   // omitted metrics with a reason
         *   }
         */
        GET: async (event, ctx) => {
            if (!features.personalStats) {
                return ApiProblem.notFound("Feature 'personalStats' is not enabled");
            }

            const { url, locals } = event;
            const user = locals.user ?? locals.principal;
            if (!user) return ApiProblem.unauthorized();

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

            const userId = locals.principal?.userId ?? locals.user?.userId;
            const username = locals.principal?.username ?? locals.user?.username;
            if (!userId || !username) return ApiProblem.unauthorized();

            // --- Access context (for access-sensitive metrics) ---
            const needsAccessCtx = requestedMetrics.some((m) => ACCESS_SENSITIVE.has(m));
            let accessCtx: MediaAccessBoundary | undefined;
            if (needsAccessCtx) {
                const db = getDb();
                // `locals.user` is REQUIRED here, not merely convenient.
                // buildSearchAccessContext takes a non-optional UserContext, but
                // locals.user is `AppUserInfo | undefined` (app.d.ts) — this call
                // used to pass it unguarded, a type error that shipped silently
                // (the repo has no working typecheck gate). It never fired because
                // every auth populator in forward-auth.ts sets locals.user next to
                // locals.principal, but the `locals.user ?? locals.principal`
                // fallback above explicitly contemplates a principal WITHOUT a
                // user. On that path `user.maxAgeRating` throws, the `.catch`
                // swallows it, and the caller silently gets a boundary-less
                // request. Guarding makes the principal-only case land on the
                // fail-closed branch below instead.
                if (db && locals.user) {
                    accessCtx = await buildSearchAccessContext(db, locals.user)
                        .then(searchAccessBoundary)
                        .catch(() => undefined);
                }
            }
            // Fail CLOSED. An undefined boundary previously meant "skip filtering"
            // AND produced an empty fingerprint, so the unfiltered result was
            // written to the SHARED un-fingerprinted cache entry and served to
            // every later viewer. Access-sensitive metrics are now reported
            // unavailable instead of computed without a boundary.
            const accessCtxUnavailable = needsAccessCtx && !accessCtx;
            // The boundary actually handed to computeOneStat. It is REQUIRED now,
            // so the "no boundary" case has to name a scope rather than vanish:
            // denyAll, never unrestricted. Access-sensitive metrics are already
            // refused above when the boundary is missing; this makes the residual
            // path fail closed instead of unfiltered if that gate is ever bypassed.
            const accessBoundary = accessCtx ?? denyAllAccess();

            const statsCache = cacheManager.for(CACHE_NAMESPACES.personalStats);
            // Fingerprint the boundary that is actually USED, not the optional one.
            // Identical in every reachable state — access-sensitive metrics are
            // refused above when accessCtx is missing — but it keeps the cache key
            // and the filtering derived from a single value, so a denyAll fallback
            // can never key as unrestricted if that gate is ever bypassed. Matches
            // my-stats.ts / username.ts. Unrestricted still fingerprints to '',
            // preserving warm entries.
            const fingerprint = accessFingerprint(accessBoundary);

            // --- Session count gate ---
            // null = the count could not be read: every requested metric is
            // reported `failed` (retryable), never `insufficient_data`.
            const sessionCount = await personalStatsService
                .getSessionCount(userId)
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
                    const cacheKey =
                        isAccessSensitive && fingerprint
                            ? buildVersionedCacheKey('personalStats', type, period, fingerprint)
                            : buildVersionedCacheKey('personalStats', type, period);

                    const cached = await statsCache.get<{ stats: unknown }>(cacheKey, userId);
                    if (cached) {
                        metricsOut[type] = cached.stats;
                        return;
                    }

                    try {
                        const stats = await computeOneStat(type, userId, period, accessBoundary);
                        metricsOut[type] = stats;
                        await statsCache.set(cacheKey, { type, period, stats }, undefined, userId);
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
            const unavailable = toPublicUnavailable(unavailableOut, sessionCount ?? 0);

            return json({
                subject: { id: userId, username },
                period,
                metrics,
                unavailable,
            });
        },
    },
});
