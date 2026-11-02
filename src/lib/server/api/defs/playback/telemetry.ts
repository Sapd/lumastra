// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playback/telemetry.ts — POST /playback/telemetry
 *
 * Receive playback telemetry events from external players (tvOS, native HLS,
 * etc.).  Rate-limited to 30 req/min per user (each request carries up to 100
 * events).
 *
 * Auth: {kind:'user'} — any authenticated user.
 *
 * `request.body` = publicTelemetryReportSchema, derived from what the handler
 * validates via `withValidation({ body: publicTelemetryReportSchema })`.
 * Unknown fields are stripped (not .strict()). Lenient on optional fields.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { publicTelemetryReportSchema } from '$lib/schemas/playback.js';
import {
    playbackTelemetryService,
    type ClientTelemetryReport,
} from '$lib/server/services/playback-telemetry.service.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaybackTelemetryDef');

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_S = 60;

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Playback'],
            summary: 'Submit client telemetry events',
            stability: 'stable',
            description:
                'Reports playback telemetry (rebuffer events, bandwidth estimates, etc.) for a play session. ' +
                'Accepts a camelCase payload; external players may omit metrics, so event fields are optional. ' +
                'An empty `events` array is acknowledged without recording. Always returns 204 on success.',
            body: publicTelemetryReportSchema,
            responses: {
                204: 'Telemetry events accepted (no content)',
                400: 'Invalid telemetry payload',
                401: 'Authentication required',
                404: 'Session not found',
                429: 'Rate limit exceeded (30 requests per minute per user)',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        /**
         * POST body — publicTelemetryReportSchema.
         *
         * Derived from the existing `withValidation({ body: publicTelemetryReportSchema })`
         * call.  Required: playbackSessionId (UUID), events (array, 0–100 items).
         * Optional: deviceId (≤255 chars), clientType (string).
         * Unknown fields are stripped (not .strict()).
         */
        body: publicTelemetryReportSchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            // Inline rate limit: 30 req / 60 s per user (mirrors the original
            // withValkeyRateLimit(30, 60) middleware wrapper).
            const rl = await checkRateLimit(
                `telemetry:${userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
            }

            try {
                const body = ctx.input!.body;

                // Empty event array — just acknowledge.
                if (body.events.length === 0) {
                    return new Response(null, { status: 204 });
                }

                // Map external clientType string → internal enum.
                let clientType: 'hls_js' | 'native_hls' | 'unknown' = 'unknown';
                if (body.clientType) {
                    const ct = body.clientType.toLowerCase();
                    if (ct.includes('hls_js') || ct.includes('hlsjs')) {
                        clientType = 'hls_js';
                    } else if (
                        ct.includes('native') ||
                        ct.includes('avplayer') ||
                        ct.includes('tvos') ||
                        ct.includes('ios')
                    ) {
                        clientType = 'native_hls';
                    }
                }

                const report: ClientTelemetryReport = {
                    playSessionId: body.playbackSessionId,
                    deviceId: body.deviceId,
                    clientType,
                    events: body.events.map((e) => ({
                        type: e.type,
                        value: e.value,
                        metadata: {
                            ...e.metadata,
                            externalClient: body.clientType || 'unknown',
                        },
                        timestamp: e.timestamp || Date.now(),
                    })),
                };

                const accepted = await playbackTelemetryService.recordClientReport(report, userId);
                if (!accepted) {
                    return problem('not_found', { error: 'Session not found' });
                }

                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Failed to record telemetry', err as Error);
                return problem('internal_error', { error: 'Failed to record telemetry' });
            }
        },
    },
});
