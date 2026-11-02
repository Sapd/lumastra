// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/playback-quality/index.ts
 *
 * GET    /api/admin/playback-quality?days=<N>
 *   Returns aggregate playback quality statistics over the last N days.
 *   Cutoff convention: single UTC midnight boundary (cutoffDate) computed as
 *   today-minus-N days floored to the start of that calendar day (UTC). Every
 *   panel reads the per-session rows, so all of them count the same sessions.
 *
 * DELETE /api/admin/playback-quality
 *   Clears all playback telemetry data (does NOT affect watch_history).
 *
 * Auth: playback:admin (or admin) for both methods.
 * Surface: internal-only.
 * 503 dependency_unavailable when DB is down.
 *
 * NOTE: Rate limiting (withAdminHeavyRateLimit) is not applied at the def layer;
 * it is handled at the infra layer. The admin auth spec provides baseline protection.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    PlaybackQualityResponseSchema,
    PlaybackQualityClearResponseSchema,
} from '$lib/schemas/api-admin-responses.js';
import {
    getOverallStats,
    getTranscodingStats,
    getDeviceTypeStats,
    getStreamTypeStats,
    getClientTypeStats,
    getDailyTrends,
    getUsersWithIssues,
    getDevicesWithIssues,
    getCommonIssues,
    getDailyByDeviceType,
    getTranscodeReasons,
    getCrossTabAnalysis,
    clearAllTelemetryData,
    getFleetPercentiles,
    getSessionsWithoutTranscodeReason,
} from '$lib/server/database/queries/playback-analytics.queries.js';
import { playbackQualityQuerySchema } from '$lib/schemas/admin.js';

const logger = Logger.for('PlaybackQualityAPI');

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: playbackQualityQuerySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const days = ctx.input!.query!.days;

            // Floor the window to a UTC midnight boundary so all queries
            // operate on the identical session set.
            const cutoffDate = new Date();
            cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
            cutoffDate.setUTCHours(0, 0, 0, 0);

            const [
                overallStats,
                transcodingStats,
                deviceTypeStats,
                streamTypeStats,
                byClientType,
                dailyTrends,
                usersWithIssuesResult,
                devicesWithIssues,
                commonIssues,
                dailyByDeviceType,
                transcodeReasons,
                crossTabAnalysis,
                fleetPercentiles,
                transcodesWithoutReason,
            ] = await Promise.all([
                getOverallStats(sql, cutoffDate),
                getTranscodingStats(sql, cutoffDate),
                getDeviceTypeStats(sql, cutoffDate),
                getStreamTypeStats(sql, cutoffDate),
                getClientTypeStats(sql, cutoffDate),
                getDailyTrends(sql, cutoffDate),
                getUsersWithIssues(sql, cutoffDate),
                getDevicesWithIssues(sql, cutoffDate),
                getCommonIssues(sql, cutoffDate),
                getDailyByDeviceType(sql, cutoffDate),
                getTranscodeReasons(sql, cutoffDate),
                getCrossTabAnalysis(sql, cutoffDate),
                getFleetPercentiles(sql, cutoffDate),
                getSessionsWithoutTranscodeReason(sql, cutoffDate),
            ]);

            const deliveryPercentiles =
                fleetPercentiles.sampleCount > 0
                    ? {
                          p50Ms: fleetPercentiles.p50Ms,
                          p95Ms: fleetPercentiles.p95Ms,
                          p99Ms: fleetPercentiles.p99Ms,
                          sampleCount: fleetPercentiles.sampleCount,
                      }
                    : undefined;

            // Map raw snake_case rows to the structured schema shape.
            const usersWithIssuesRows = usersWithIssuesResult.map((row) => ({
                userId: row.user_id,
                username: row.username ?? undefined,
                sessionsWithIssues: row.sessions_with_issues,
                totalSessions: row.total_sessions,
                avgHealthScore: row.avg_health_score ?? undefined,
            }));

            return json(
                PlaybackQualityResponseSchema.parse({
                    summary: overallStats || {},
                    byClientType,
                    transcodingStats,
                    deviceTypeStats,
                    streamTypeStats,
                    dailyTrends,
                    dailyByDeviceType,
                    transcodeReasons,
                    crossTabAnalysis,
                    usersWithIssues: usersWithIssuesResult,
                    devicesWithIssues,
                    commonIssues: commonIssues.map((i) => ({
                        issue: i.issue,
                        count: i.count,
                    })),
                    deliveryPercentiles,
                    usersWithIssuesRows,
                    transcodesWithoutReason,
                }),
            );
        },

        DELETE: async (event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            await clearAllTelemetryData(sql);
            auditLog('playback_quality.clear', 'all', auditActor(event));
            logger.info('Cleared all playback quality/telemetry data');

            return json(
                PlaybackQualityClearResponseSchema.parse({
                    message: 'Playback quality data cleared',
                }),
            );
        },
    },
});
