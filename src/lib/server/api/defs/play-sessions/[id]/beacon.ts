// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/play-sessions/[id]/beacon.ts — POST /play-sessions/{id}/beacon
 *
 * POST-only alias of PUT /play-sessions/{id}.
 * Browsers cannot send PUT via `navigator.sendBeacon` (spec limitation);
 * this endpoint accepts the same body and session outcomes as PUT.
 *
 * Auth: {kind:'scope', anyOf:['media:write']} — ownership check inside
 * handler additionally.
 *
 * `request.body` = PlaybackReportSchema (same as parent PUT).
 * `request.params` = id (non-empty string).
 */

import { z } from 'zod';
import { PlaybackRefusalSchema } from '$lib/schemas/playback-refusal.js';
import { playbackPolicyResponse } from '../_policy-response.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import {
    PlaybackReportSchema,
    playbackReportToSessionUpdate,
} from '$lib/schemas/session-update.js';
import { SessionHeartbeatResponseSchema } from '$lib/schemas/api-playback-responses.js';
import { getSessionById } from '$lib/server/database/queries/play-sessions.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getPlaySessionLifecycleService } from '$lib/server/services/play-session-lifecycle.service.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const BeaconIdParams = z.object({
    id: z.string().min(1),
});

/** Server-clock epoch ms → ISO 8601 for the wire; null stays null. */
function toResumeAnchorAt(epochMs: number | null): string | null {
    return epochMs === null || !Number.isFinite(epochMs) ? null : new Date(epochMs).toISOString();
}

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:write'] },

    // OpenAPI docs for the /api/v1/play-sessions/{id}/beacon (public/native)
    // surface. Migrated verbatim from the retired
    // src/routes/api/v1/play-sessions/[id]/beacon/_openapi.ts. `stability:
    // 'stable'` carried over; no `auth` field → security stays NO_AUTH
    // (byte-identical to the prior spec).
    docs: {
        POST: {
            tags: ['Play Sessions'],
            summary: 'Report progress with sendBeacon (POST twin of the update)',
            stability: 'stable',
            description:
                'POST-only mirror of the session-update PUT for navigator.sendBeacon() compatibility ' +
                '(sendBeacon cannot issue PUT). Accepts the same listenedTotalMs (music), listenedDeltaMs (audiobooks), finished, crossfade and nextMediaId fields and endReason=skip as PUT, with identical music counters and deduplication. Updates the play session identified by the `id` path ' +
                'param. Music prefetch promotion uses the same atomic admission as PUT and may return 422 stream_limit, transcode_not_allowed or ip_restricted; fall back to a normal start on refusal. Returns 204 on success, or 200 with a superseded, lost, or killed session outcome.',
            body: PlaybackReportSchema,
            responses: {
                200: {
                    schema: SessionHeartbeatResponseSchema,
                    description: 'Session outcome (superseded, lost, or killed)',
                },
                204: 'Update accepted (no content)',
                401: 'Authentication required',
                404: 'Session not found',
                422: {
                    schema: PlaybackRefusalSchema,
                    contentType: 'application/problem+json',
                    description: 'Prefetch promotion refused by stream, method or IP policy',
                },
                500: 'Internal server error',
            },
        },
    },

    request: {
        /**
         * POST body — same shape as PUT /play-sessions/{id}.
         * Unknown fields are stripped (not .strict()).
         */
        body: PlaybackReportSchema,
        params: BeaconIdParams,
    },

    handlers: {
        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiResponses.error('Database unavailable');

            const userId = event.locals.user?.userId;
            if (!userId) return ApiResponses.unauthorized();

            const sessionId = ctx.input!.params!.id;

            const session = await getSessionById(sql, sessionId);
            if (!session) return ApiResponses.notFound('Session not found');
            if (session.user_id !== userId) return ApiResponses.notFound('Session not found');

            const service = getPlaySessionLifecycleService();
            const result = await service.update(
                sessionId,
                playbackReportToSessionUpdate(ctx.input!.body, String(session.media_type)),
                event.locals.user,
            );
            if (result && 'policyError' in result)
                return playbackPolicyResponse(result.policyError);
            if (result && ('action' in result || result.sessionLost)) {
                const responseBody = {
                    progressSaved: result.wrote_to_durable,
                    resumeAnchorAt: toResumeAnchorAt(result.resume_anchor),
                    ...('action' in result ? { action: result.action, reason: result.reason } : {}),
                    // Same ack shape as the PUT.
                    ...('action' in result && result.action === 'superseded'
                        ? { superseded: true }
                        : {}),
                    ...(result.sessionLost !== undefined
                        ? { sessionLost: result.sessionLost }
                        : {}),
                };
                return new Response(JSON.stringify(responseBody), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            // Successful beacons need no body; preserve explicit session outcomes above.
            return new Response(null, { status: 204 });
        },
    },
});
