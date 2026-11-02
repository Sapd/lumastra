// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/playback-quality/user/[userId]/index.ts
 *
 * GET /api/admin/playback-quality/user/[userId]?days=<N>
 *
 * Returns playback quality statistics for a specific user.
 * Query params:
 * - days: number (default 7, clamped 1–365)
 *
 * Cutoff convention: floored to UTC midnight (same as overview route).
 *
 * The speed-test strip is deliberately NOT cut off at `days`: a speed test is an
 * ACTIVE measurement the user chose to run, so they are sparse by nature and a
 * 7-day window would usually show none. The ten most recent ones are what tell
 * an operator whether this user's line has ever measured healthy at all.
 *
 * Auth: admin (playback:read for token-based callers).
 * Surface: internal-only.
 * 503 dependency_unavailable when DB is down.
 *
 * NOTE: Rate limiting (withAdminHeavyRateLimit) is not applied at the def layer.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { playbackTelemetryService } from '$lib/server/services/playback-telemetry.service.js';
import { UserPlaybackQualityResponseSchema } from '$lib/schemas/api-admin-responses.js';
import { toUserId } from '$lib/shared/user-id.js';
import { playbackQualityQuerySchema } from '$lib/schemas/admin.js';
import {
    getUserSessionDetails,
    getScopedDeliveryPercentiles,
} from '$lib/server/database/queries/playback-analytics.queries.js';
import { listRecentSpeedTests } from '$lib/server/database/queries/network-speed-tests.queries.js';
import { toSpeedTestResponse } from '$lib/schemas/api-network-responses.js';

/** Recent-enough to read as "this user's line", short enough to stay a strip. */
const SPEED_TEST_LIMIT = 10;

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: z.object({ userId: z.string().min(1) }),
        query: playbackQualityQuerySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { userId } = ctx.input!.params!;

            let typedUserId;
            try {
                typedUserId = toUserId(userId);
            } catch {
                return ApiProblem.validationFailed([
                    { field: 'userId', message: 'Invalid user ID format' },
                ]);
            }

            const days = ctx.input!.query!.days;

            // Floor to UTC midnight — same convention as the overview route.
            const cutoffDate = new Date();
            cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
            cutoffDate.setUTCHours(0, 0, 0, 0);

            const [stats, sessionRows, scopedPercentiles, speedTestRows] = await Promise.all([
                playbackTelemetryService.getUserQualityStats(typedUserId, days),
                getUserSessionDetails(sql, userId, cutoffDate),
                getScopedDeliveryPercentiles(sql, cutoffDate, { userId }),
                listRecentSpeedTests(sql, userId, SPEED_TEST_LIMIT),
            ]);

            if (!stats) {
                return ApiProblem.internalError('Failed to get user stats');
            }

            const deliveryPercentiles =
                scopedPercentiles.sampleCount > 0
                    ? {
                          p50Ms: scopedPercentiles.p50Ms,
                          p95Ms: scopedPercentiles.p95Ms,
                          p99Ms: scopedPercentiles.p99Ms,
                          sampleCount: scopedPercentiles.sampleCount,
                      }
                    : undefined;

            return json(
                UserPlaybackQualityResponseSchema.parse({
                    ...stats,
                    sessions: sessionRows,
                    deliveryPercentiles,
                    speedTests: speedTestRows.map(toSpeedTestResponse),
                }),
            );
        },
    },
});
