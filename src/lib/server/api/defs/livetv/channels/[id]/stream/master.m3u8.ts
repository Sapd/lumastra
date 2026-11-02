// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { hlsAuthQuery } from '$lib/server/utils/hls-request-utils.js';
/**
 * defs/livetv/channels/[id]/stream/master.m3u8.ts
 *   GET /livetv/channels/{id}/stream/master.m3u8
 *
 * Class R — HLS master playlist (success response is HLS text, not JSON).
 *
 * GET /livetv/channels/{id}/stream/master.m3u8
 *   Proxies the HLS master playlist from the stream proxy.
 *   Rewrites the media-playlist reference (playlist.m3u8) to route through
 *   SvelteKit's [segment] handler at the correct surface prefix.
 *   Also propagates `grant` query params so external HLS
 *   players (tvOS, etc.) stay authenticated on subsequent requests.
 *
 *   Always calls getStreamInfo() before serving — ensures the viewer is
 *   registered even when the channel is already active (idempotent join).
 *
 * Auth: feature:FEATURE_LIVETV → user (+ inline hasLiveTvPermission check)
 *   Tier-1 errors (pre-stream): problem+json.
 *   Tier-2 errors (mid-stream): fail the next segment/manifest.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getLiveTvSessionService } from '$lib/server/services/livetv/livetv-session.service.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { Logger } from '$lib/server/utils/logger.js';
import { joinWithEviction, proxyErrorResponse } from './stream-helpers.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import {
    deriveLiveTvViewerKey,
    isLiveTvPreviewRequest,
    liveTvJoinPriority,
} from '$lib/server/services/livetv/livetv-viewer-key.js';

const HlsMasterQuerySchema = z.object({
    grant: z.string().optional().meta({ description: 'Opaque playback grant secret' }),
    PlaySessionId: z.string().min(1),
});

const logger = Logger.for('LiveTV:HLS');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize the playback grant and session binding for child URIs. */
function buildAuthQuery(url: URL): string {
    return hlsAuthQuery(url);
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

/**
 * Query params surfaced by this HLS manifest endpoint.
 *
 * `grant` — alternate Bearer credential forms accepted by
 * the auth middleware; propagated to downstream segment requests. The mount()
 * layer does not validate their content (auth middleware handles them), but we
 * declare them here for documentation and to allow unknown params to be stripped.
 */
const HlsMasterQuery = z.object({
    grant: z.string().optional(),
    PlaySessionId: z.string().min(1),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Get Live TV HLS master playlist',
            stability: 'protocol',
            visibility: 'internal',
            auth: 'none',
            description:
                'Returns the HLS master playlist (m3u8) for a Live TV channel stream. ' +
                'Authentication is via `?token=stream_...` query parameter. ' +
                'This is a streaming transport endpoint — do not call directly.',
            query: HlsMasterQuerySchema,
            responses: {
                200: {
                    binary: ['application/vnd.apple.mpegurl', 'application/x-mpegURL'],
                    description: 'HLS master playlist',
                },
                401: 'Invalid or expired stream token',
                404: 'Channel not found',
                503: {
                    description:
                        'Stream unavailable — the channel has no free viewer slot ' +
                        '(Retry-After: 30). This endpoint accepts no bitrate/cap parameter; ' +
                        'a version-skewed or misbehaving stream proxy can still answer ' +
                        'cap_unavailable to this uncapped join',
                    code: 'stream_limit',
                },
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_LIVETV',
        then: { kind: 'user' },
    },
    raw: true,
    request: {
        query: HlsMasterQuery,
    },
    handlers: {
        /**
         * GET /livetv/channels/{id}/stream/master.m3u8
         *
         * Joins the viewer to the channel (idempotent) then proxies the HLS
         * master playlist from the stream proxy.  Segment URLs are rewritten
         * to route through SvelteKit at the correct surface prefix.
         *
         * Replaces:
         *   GET /api/livetv/channels/{channelId}/stream/master.m3u8  (internal)
         *   GET /api/v1/livetv/channels/{channelId}/stream/master.m3u8  (was a fork)
         */
        GET: async (event, ctx) => {
            const { locals, params, url, request } = event;

            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }

            const channelId = params.id;
            if (!channelId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);
            if (!isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a valid UUID' },
                ]);
            }

            const username = locals.user.username;
            const viewerId = deriveLiveTvViewerKey(event);
            const priority = liveTvJoinPriority(
                locals.user.liveTvPriority,
                isLiveTvPreviewRequest(event.url),
            );
            const sessionService = getLiveTvSessionService();
            const proxyClient = getStreamProxyClient();

            // Anti-reconnect guard.
            const kickedStatus = await sessionService.checkKicked(viewerId, channelId);
            if (kickedStatus.kicked) {
                return problem('gone', {
                    error: 'viewer_kicked',
                    details: kickedStatus.reason,
                });
            }

            // Always join before serving — ensures viewer is registered even when
            // the channel is already active (another viewer / resumed session).
            const streamInfoOrError = await joinWithEviction(
                locals,
                channelId,
                viewerId,
                priority,
                'HLS',
            );
            if (streamInfoOrError instanceof Response) return streamInfoOrError;
            const streamInfo = streamInfoOrError;

            // Register session (non-fatal — proxy is source of truth).
            try {
                await sessionService.registerSession(
                    viewerId,
                    username,
                    channelId,
                    streamInfo.sourceId ?? channelId,
                    priority,
                );
            } catch (sessionErr) {
                logger.warn('Session registration failed, continuing with playlist', {
                    channelId,
                    error: sessionErr instanceof Error ? sessionErr.message : String(sessionErr),
                });
            }

            const proxyResponse = await proxyClient.proxyHlsPlaylist(channelId, request.signal);
            if (!proxyResponse.ok) {
                return await proxyErrorResponse(proxyResponse);
            }

            const m3u8Raw = await proxyResponse.text();
            // Normalise line endings: some HLS implementations emit CRLF (\r\n).
            // If not normalised, /^playlist\.m3u8$/gm would fail to match because
            // the trailing \r is part of the "line" after splitting on \n.
            const m3u8Text = m3u8Raw.replace(/\r\n/g, '\n');

            const authQuery = buildAuthQuery(url);

            // Determine the route base for this surface so segment URLs are
            // routable by external players.
            const routeBase = apiUrl(ctx.surface, `/livetv/channels/${channelId}/stream`);

            // Rewrite playlist.m3u8 reference (with any existing query string).
            const rewritten = m3u8Text.replace(
                /^playlist\.m3u8(\?.*)?$/gm,
                (_match, existingQuery: string | undefined) => {
                    const base = `${routeBase}/playlist.m3u8`;
                    if (existingQuery && authQuery) {
                        return `${base}${existingQuery}&${authQuery.slice(1)}`;
                    }
                    return `${base}${existingQuery ?? ''}${authQuery}`;
                },
            );

            return new Response(rewritten, {
                headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Cache-Control': 'no-cache',
                },
            });
        },
    },
});
