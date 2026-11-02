// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/playback-quality/device/[deviceId]/index.ts
 *
 * GET /api/admin/playback-quality/device/[deviceId]?days=<N>
 *
 * Returns playback quality statistics for a specific device.
 * Query params:
 * - days: number (default 7, clamped 1–365)
 *
 * Cutoff convention: floored to UTC midnight (same as overview route).
 *
 * Auth: admin (playback:read scope grants read; playback:admin for full).
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
import { DevicePlaybackQualityResponseSchema } from '$lib/schemas/api-admin-responses.js';
import { playbackQualityQuerySchema } from '$lib/schemas/admin.js';
import {
    getDeviceSessionDetails,
    getScopedDeliveryPercentiles,
} from '$lib/server/database/queries/playback-analytics.queries.js';

/** Device IDs are opaque strings; reject obviously-invalid values (empty / > 255 chars). */
const DEVICE_ID_MAX_LEN = 255;

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: z.object({ deviceId: z.string().min(1).max(DEVICE_ID_MAX_LEN) }),
        query: playbackQualityQuerySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { deviceId } = ctx.input!.params!;
            const days = ctx.input!.query!.days;

            // Floor to UTC midnight — same convention as the overview route.
            const cutoffDate = new Date();
            cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
            cutoffDate.setUTCHours(0, 0, 0, 0);

            const [stats, sessionRows, scopedPercentiles] = await Promise.all([
                playbackTelemetryService.getDeviceQualityStats(deviceId, days),
                getDeviceSessionDetails(sql, deviceId, cutoffDate),
                getScopedDeliveryPercentiles(sql, cutoffDate, { deviceId }),
            ]);

            if (!stats) {
                return ApiProblem.internalError('Failed to get device stats');
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
                DevicePlaybackQualityResponseSchema.parse({
                    ...stats,
                    sessions: sessionRows,
                    deliveryPercentiles,
                }),
            );
        },
    },
});
