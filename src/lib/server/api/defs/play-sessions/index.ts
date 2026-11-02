// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/play-sessions/index.ts — POST /play-sessions
 *
 * Create a new play session with policy checking (stream limits, transcode
 * policies, IP restrictions).  Mounted on both /api/play-sessions and
 * /api/v1/play-sessions.
 *
 * Auth: {kind:'scope', anyOf:['media:write']} — any authenticated user whose
 * credential carries media:write (sessions/PATs/full-grant device tokens all
 * do; a media:read-scoped device token does not).
 *
 * The `request.body` slot provides the declarative input contract so mount()
 * validates the body BEFORE the handler runs (strict: reject unknown fields).
 */

import { createHash } from 'node:crypto';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import {
    PlaybackStartRequestSchema,
    PlaybackStartResponseSchema,
} from '$lib/schemas/playback-start.js';
import { startPlaySession, isPolicyError } from '$lib/server/services/play-sessions.service.js';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getPlaySessionLifecycleService } from '$lib/server/services/play-session-lifecycle.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getClientIpStrictFromRequest } from '$lib/server/utils/client-ip.js';
import { deriveSurface } from '$lib/server/api/play-surface.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { playbackPolicyResponse } from './_policy-response.js';
import { PlaybackRefusalSchema } from '$lib/schemas/playback-refusal.js';
import { typedJson } from '$lib/server/utils/typed-response.js';

const logger = Logger.for('PlaySessionsDef');

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:write'] },
    rateLimit: {
        limit: 60,
        windowSec: 60,
        keyBy: (event) =>
            `playback-start:${event.locals.principal?.userId ?? event.locals.user?.userId}`,
    },

    // Shared start contract for the internal and public mounts.
    docs: {
        POST: {
            tags: ['Play Sessions'],
            stability: 'stable',
            summary: 'Start a playback session',
            auth: 'bearer',
            description:
                "Starts video, music tracks, internet radio or audiobook playback. Internet radio returns a live file delivery (unknown container until the proxy reads the upstream Content-Type), starts at the live edge and supports only direct playback, without seeking, audio options or prefetch. Reports keep the lease alive without writing track history. Returns granted delivery URLs and a shared reporting resource after enforcing stream and IP policies. Optional purpose=prefetch is music-track-only (other kinds return 422 validation_failed). It requires an admitted ACTIVE or PAUSED play session for the same user and device; 422 prefetch_requires_current_session means fall back to purpose=play. A new allocation replaces the device's one unpromoted prefetch. It consumes no stream slot and stays hidden until a real report or same-device normal start promotes it with normal admission. It expires after 10 minutes or immediately when its current session stops, completes, is killed or reaped.",
            body: PlaybackStartRequestSchema,
            responses: {
                201: {
                    schema: PlaybackStartResponseSchema,
                    description: 'Session created',
                },
                403: 'Access denied or no AudiobookShelf link',
                404: 'Media or selected source not found',
                503: 'AudiobookShelf unavailable',
                422: {
                    schema: PlaybackRefusalSchema,
                    contentType: 'application/problem+json',
                    description:
                        'Structured playback refusal, including prefetch_requires_current_session, source_incompatible, stream_limit, transcode_not_allowed and ip_restricted; details is an object, code is stable.',
                },
            },
        },
    },

    request: {
        /**
         * POST body — PlaybackStartRequestSchema from $lib/schemas/playback-start.
         *
         * Derived directly from the schema the handler has always validated
         * (formerly via withValidation({ body: PlaybackStartRequestSchema })).
         * Unknown fields are rejected. Required: mediaId, deviceId and typed capabilities.
         */
        body: PlaybackStartRequestSchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiResponses.error('Database unavailable');

            const username = event.locals.user?.username;
            const userId = event.locals.user?.userId;
            if (!username || !userId) return ApiResponses.unauthorized();

            const kickStatus = await checkSessionKickCooldown(username);
            if (kickStatus.kicked) {
                return ApiResponses.kicked(kickStatus.remainingSeconds!);
            }

            // Body was validated by mount() via PlaybackStartRequestSchema.
            const body = ctx.input!.body;

            // Full media-access gate: library group + age rating.
            // Returns 404 (not 403) to avoid revealing item existence.
            if (!(await checkMediaAccess(sql, body.mediaId, event.locals.user))) {
                return ApiResponses.notFound('Media');
            }

            // Security fix C15 (2026-09-16): the strict resolver, not the lax
            // one — this value feeds the `require_single_ip` anti-sharing
            // gate (enforceStreamPolicy). The lax resolver honors
            // X-Forwarded-For from ANY peer when TRUSTED_PROXY_IPS is unset
            // (the default posture), so a second device sharing the same
            // credential could forge an XFF matching the first session's IP
            // and make `ip_address != ip_address` never trip. The strict
            // resolver ignores XFF entirely when unpinned, using the raw TCP
            // peer instead — see client-ip.ts's doc comment for why this
            // alone does not fully restore enforcement behind an unpinned
            // proxy (every client behind it still collapses to one address);
            // that residual gap is covered by the security self-check
            // (security-self-check/inventory-checks.ts).
            const ip_address = getClientIpStrictFromRequest(event.request, event.getClientAddress);

            // Attribution for the admin surface-mix stats. Derived from the
            // Principal, never from the request body — see deriveSurface().
            const surface = deriveSurface(event.locals.principal);

            const result = await startPlaySession(
                sql,
                userId,
                username,
                ip_address,
                body,
                surface,
                {
                    parentTokenHash:
                        event.locals.authMethod === 'pat' && event.locals.accessToken
                            ? createHash('sha256').update(event.locals.accessToken).digest('hex')
                            : undefined,
                    deviceSessionId: event.locals.deviceSessionId,
                    userAgent: event.request.headers.get('user-agent') ?? undefined,
                    mintedByAdmin: event.locals.principal?.isAdmin === true,
                    surface: ctx.surface,
                },
            );

            if (isPolicyError(result)) {
                return playbackPolicyResponse(result);
            }

            if ('status' in result) {
                return ApiResponses.error(result.message, undefined, result.status);
            }

            logger.info('Session started', { session_id: result.playbackSessionId, username });

            if (body.purpose !== 'prefetch') {
                getPlaySessionLifecycleService().notifySessionStarted(
                    userId,
                    result.playbackSessionId,
                    body.mediaId,
                );
            }

            return typedJson(PlaybackStartResponseSchema, result, { status: 201 });
        },
    },
});
