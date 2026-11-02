// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/play-sessions/[id].ts — PUT /play-sessions/{id}
 *
 * Report progress, pause, resume, or complete a play session.
 * Verifies session ownership before applying the update.
 *
 * On heartbeats (status=ACTIVE|PAUSED): returns JSON with resumeAnchorAt,
 * progressSaved, optional transcode progress, and optional kill/superseded.
 * On COMPLETED: returns 204, or 200 with a superseded, lost, or killed outcome.
 *
 * Auth: {kind:'scope', anyOf:['media:write']} — ownership check inside
 * handler additionally; media:write excludes a media:read-scoped device
 * token from reporting/mutating playback.
 *
 * `request.body` = PlaybackReportSchema (camelCase wire body), converted to the
 * internal SessionUpdate before the lifecycle service call.
 * `request.params` = id (non-empty string, from SvelteKit route params).
 */

import { PlaybackRefusalSchema } from '$lib/schemas/playback-refusal.js';
import { getTakeoverDeviceName } from '$lib/server/database/queries/resume-handoff.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { z } from 'zod';
import { playbackPolicyResponse } from './_policy-response.js';
import { cancellationDef, cancelPlaybackSession } from './_cancellation.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import {
    PlaybackReportSchema,
    playbackReportToSessionUpdate,
} from '$lib/schemas/session-update.js';
import { SessionHeartbeatResponseSchema } from '$lib/schemas/api-playback-responses.js';
import { getSessionById } from '$lib/server/database/queries/play-sessions.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getPlaySessionLifecycleService,
    type HeartbeatResult,
} from '$lib/server/services/play-session-lifecycle.service.js';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service.js';
import {
    clearClientAdaptiveReport,
    recordClientAdaptiveReport,
} from '$lib/server/services/adaptive-playback-state.service.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const PlaySessionIdParams = z.object({
    id: z.string().min(1),
});

/** Server-clock epoch ms → ISO 8601 for the wire; null stays null. */
function toResumeAnchorAt(epochMs: number | null): string | null {
    return epochMs === null || !Number.isFinite(epochMs) ? null : new Date(epochMs).toISOString();
}

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

const logger = Logger.for('PlaySessionUpdateDef');

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:write'] },

    // OpenAPI docs for the /api/v1/play-sessions/{id} (public/native) surface.
    // Migrated verbatim from the retired src/routes/api/v1/play-sessions/[id]/
    // _openapi.ts, which re-exported the internal play-sessions/[id]/_openapi.ts
    // `route`. No `auth`/`stability` fields → security stays NO_AUTH and
    // stability defaults per path (byte-identical to the prior spec).
    docs: {
        ...cancellationDef.docs,
        PUT: {
            tags: ['Play Sessions'],
            stability: 'stable',
            summary: 'Report progress, pause, resume or completion',
            description:
                'Music prefetch: the first ACTIVE or positive-position/heard-time report promotes with normal admission; 422 stream_limit leaves it unpromoted. If promotion is refused, fall back to a normal start; ending the current session expires its unpromoted prefetch. Music: listenedTotalMs is cumulative heard audio (omitted uses sessionElapsedMs); only the first positive heard report counts a play, never allocation or fetching. Audiobooks use listenedDeltaMs per interval; omitted uses growth of cumulative sessionElapsedMs, whose baseline advances on every accepted report. Retired listenedMs is rejected. endReason=skip records a heard skip; terminal/replay retries never count twice. Crossfade omitted keeps, null clears, object sets; PAUSED with a fade clears it; COMPLETED clears fade and nextMediaId. nextMediaId is set-only. ' +
                'Report progress, pause, resume, or complete a play session. Verifies session ownership. ' +
                'On heartbeats (status=ACTIVE|PAUSED) the response always includes resumeAnchorAt and ' +
                'progressSaved so the client can advance its localStorage resume cache and detect ' +
                'engagement-gate openings. Optional action/reason fields surface kill or superseded ' +
                'states; an optional transcode field is layered in when a transcode job is active. ' +
                'COMPLETED requests return 204, or 200 with a superseded, lost, or killed session outcome.',
            body: PlaybackReportSchema,
            responses: {
                200: {
                    schema: SessionHeartbeatResponseSchema,
                    description:
                        'Heartbeat acknowledgement: resumeAnchorAt + progressSaved, plus optional ' +
                        'kill/superseded/transcode fields. Also covers the rare action=kill response on COMPLETED.',
                },
                204: 'COMPLETED accepted (no content)',
                422: {
                    schema: PlaybackRefusalSchema,
                    contentType: 'application/problem+json',
                    description: 'Prefetch promotion refused by normal playback admission (stream_limit, ip_restricted or transcode_not_allowed)',
                },
                404: 'Not found',
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    request: {
        /**
         * PUT body — PlaybackReportSchema (camelCase).
         *
         * Unknown fields are stripped.
         * Required: positionMs, status, eventSeq, sessionElapsedMs.
         */
        body: PlaybackReportSchema,
        bodyMethods: ['PUT'],
        /**
         * Route params — id must be a non-empty string.
         */
        params: PlaySessionIdParams,
    },

    handlers: {
        DELETE: (event, ctx) => cancelPlaybackSession(event, ctx.input!.params!.id),
        PUT: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiResponses.error('Database unavailable');

            const userId = event.locals.user?.userId;
            if (!userId) return ApiResponses.unauthorized();

            // Params validated by mount() — id is guaranteed non-empty.
            const sessionId = ctx.input!.params!.id;

            // Verify ownership.
            const session = await getSessionById(sql, sessionId);
            if (!session) return ApiResponses.notFound('Session not found');
            if (session.user_id !== userId) return ApiResponses.notFound('Session not found');

            // Body validated by mount().
            const body = playbackReportToSessionUpdate(ctx.input!.body, String(session.media_type));

            const service = getPlaySessionLifecycleService();
            const result = await service.update(sessionId, body, event.locals.user);

            if (result && 'policyError' in result)
                return playbackPolicyResponse(result.policyError);

            // Display-only ABR state for Active Streams / Admin → Sessions. Best-effort:
            // a Valkey hiccup must never fail the heartbeat.
            if (body.status === 'COMPLETED') {
                void clearClientAdaptiveReport(sessionId).catch(() => undefined);
            } else if (body.adaptive && result && !('action' in result)) {
                void recordClientAdaptiveReport(sessionId, body.adaptive).catch(() => undefined);
            }

            // A completed session has no body unless a terminal outcome needs to reach the client.
            if (
                body.status === 'COMPLETED' &&
                !(result && ('action' in result || result.sessionLost))
            ) {
                return new Response(null, { status: 204 });
            }

            // Heartbeat (ACTIVE|PAUSED) — result is HeartbeatResult.
            if (result === undefined) {
                return ApiResponses.error('Database unavailable');
            }
            const heartbeatResult: HeartbeatResult = result;
            const responseBody: Record<string, unknown> = {
                progressSaved: heartbeatResult.wrote_to_durable,
                resumeAnchorAt: toResumeAnchorAt(heartbeatResult.resume_anchor),
                ...('action' in heartbeatResult
                    ? { action: heartbeatResult.action, reason: heartbeatResult.reason }
                    : {}),
                ...(heartbeatResult.sessionLost !== undefined
                    ? { sessionLost: heartbeatResult.sessionLost }
                    : {}),
            };

            if ('action' in heartbeatResult && heartbeatResult.action === 'superseded') {
                responseBody.superseded = true;
                // Cross-device takeover: name the device so the player can say where.
                if (heartbeatResult.reason === 'session_superseded') {
                    const deviceName = await getTakeoverDeviceName(
                        sql,
                        userId,
                        session.media_id,
                        sessionId,
                    ).catch((err: unknown) => {
                        logger.warn('Takeover device lookup failed', err as Error);
                        return null;
                    });
                    if (deviceName) responseBody.deviceName = deviceName;
                }
            }

            if (!('action' in heartbeatResult)) {
                const transcode =
                    session.transcode_job_id || session.play_method !== 'direct'
                        ? await getFFmpegTranscodeService().getPlayerTranscodeProgressMultiPod(
                              sessionId,
                          )
                        : undefined;
                if (transcode) responseBody.transcode = transcode;
            }

            return new Response(JSON.stringify(responseBody), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    },
});
