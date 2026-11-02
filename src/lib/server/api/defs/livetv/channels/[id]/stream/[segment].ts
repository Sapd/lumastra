// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { hlsAuthQuery } from '$lib/server/utils/hls-request-utils.js';
/**
 * defs/livetv/channels/[id]/stream/[segment].ts
 *   GET /livetv/channels/{id}/stream/{segment}
 *
 * Class R — HLS segment/playlist proxy (success response is media bytes or HLS text).
 *
 * GET /livetv/channels/{id}/stream/{segment}
 *   Proxies HLS segments (.m4s fMP4, .ts MPEG-TS) and the media playlist
 *   (playlist.m3u8) from the stream proxy.  Streams binary segments directly
 *   without buffering.  Media playlist responses rewrite segment/init URLs to
 *   the correct surface prefix and propagate auth query params.
 *
 * Auth: feature:FEATURE_LIVETV → user (+ inline hasLiveTvPermission check)
 *   Tier-1 errors: problem+json.
 *   Tier-2 errors: fail the next request (HLS player retries naturally).
 */

import { touchLiveTvViewer } from '$lib/server/services/livetv/viewer-liveness.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { canReadLiveTvChannelStream } from '$lib/server/services/livetv/channel-access.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { proxyErrorResponse } from './stream-helpers.js';

const HlsSegmentQuerySchema = z.object({
    grant: z.string().optional().meta({ description: 'Opaque playback grant secret' }),
    PlaySessionId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SEGMENT_RE = /^(segment-\d+\.(m4s|ts)|init\.mp4|playlist\.m3u8)$/;

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
 * Query params accepted by HLS segment/playlist requests.
 *
 * `grant` — alternate Bearer credential forms passed
 * through from the master playlist. Lenient: unknown params are stripped.
 */
const HlsSegmentQuery = z.object({
    grant: z.string().optional(),
    PlaySessionId: z.string().optional(),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Stream Live TV over HLS (opaque)',
            stability: 'protocol',
            auth: 'none',
            description:
                'The Live TV HLS stream of one channel. The start response of a Live TV playback ' +
                'session (`delivery.url`) hands out the master playlist URL; fetch it and follow ' +
                'the URLs inside the playlists, with the `grant` they carry. Everything below ' +
                '`/livetv/channels/{id}/stream/` is an implementation detail of the stream and ' +
                'may change in any release: the master playlist, the media playlists and the ' +
                'segments (MPEG-TS or fMP4) live at different paths depending on the stream ' +
                'form the server picked (source copy, adaptive ladder, capped rung, H.264 ' +
                'compatibility copy of an HEVC channel). Never build these URLs and never rely ' +
                'on a path shape. This entry documents the family; only the URLs the server ' +
                'gives you are supported.',
            query: HlsSegmentQuerySchema,
            responses: {
                200: {
                    binary: [
                        'application/vnd.apple.mpegurl',
                        'video/MP2T',
                        'video/mp4',
                        'application/octet-stream',
                    ],
                    description: 'HLS playlist or segment bytes',
                },
                401: 'Invalid or expired stream token',
                404: 'Not found',
                503: 'Stream proxy unavailable',
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
        query: HlsSegmentQuery,
    },
    handlers: {
        /**
         * GET /livetv/channels/{id}/stream/{segment}
         *
         * Proxies individual HLS segments and the media playlist from the stream
         * proxy.  Binary segments are streamed directly without buffering in memory.
         * The media playlist (playlist.m3u8) has its segment/init URLs rewritten
         * to route through SvelteKit at the correct surface prefix.
         *
         * Replaces:
         *   GET /api/livetv/channels/{channelId}/stream/{segment}  (internal)
         *   GET /api/v1/livetv/channels/{channelId}/stream/{segment}  (was a fork)
         */
        GET: async (event, ctx) => {
            const { locals, params, url, request } = event;

            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }

            const channelId = params.id;
            // `/api/v1` mounts this def on a rest route (`[...path]`, documented as
            // the one opaque Live TV entry), `/api` on `[segment]`. Both reach the
            // same file-name check below.
            const segment = params.segment ?? params.path;

            if (!channelId)
                return ApiProblem.validationFailed([{ field: 'id', message: 'Required' }]);
            if (!isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a valid UUID' },
                ]);
            }
            if (!segment) {
                return ApiProblem.validationFailed([{ field: 'segment', message: 'Required' }]);
            }
            if (!VALID_SEGMENT_RE.test(segment)) {
                return ApiProblem.validationFailed([
                    { field: 'segment', message: 'Invalid segment name' },
                ]);
            }

            // Segment-only players (VLC, Kodi) never send keepalives: a fetch is the heartbeat.
            touchLiveTvViewer(event, channelId);
            if (!(await canReadLiveTvChannelStream(locals, channelId))) {
                return ApiProblem.notFound(`Channel ${channelId} not found`);
            }
            const proxyClient = getStreamProxyClient();
            const proxyResponse = await proxyClient.proxyHlsSegment(
                channelId,
                segment,
                request.signal,
            );

            if (!proxyResponse.ok) {
                return await proxyErrorResponse(proxyResponse);
            }

            // Media playlist: rewrite segment/init URLs to route through SvelteKit.
            if (segment === 'playlist.m3u8') {
                const m3u8Text = await proxyResponse.text();
                const authQuery = buildAuthQuery(url);
                const routeBase = apiUrl(ctx.surface, `/livetv/channels/${channelId}/stream`);

                const rewritten = m3u8Text
                    .replace(/^(segment-\d+\.(?:m4s|ts))$/gm, `${routeBase}/$1${authQuery}`)
                    .replace(/URI="(init\.mp4)"/g, `URI="${routeBase}/$1${authQuery}"`);

                return new Response(rewritten, {
                    headers: {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Cache-Control': 'no-cache',
                    },
                });
            }

            // Binary segments: stream directly without buffering.
            // Guard against a bodyless upstream response (some proxies send a
            // 200 with Content-Length: 0 and no body).  Passing null to Response
            // produces an empty 200 body that HLS players will misbehave on.
            if (!proxyResponse.body) {
                return ApiProblem.badGateway('Proxy returned empty segment body');
            }

            const segLen = parseInt(proxyResponse.headers.get('content-length') ?? '', 10);
            if (segLen > 0) bandwidthTracker.trackLiveTV(segLen);

            const contentType =
                segment === 'init.mp4'
                    ? 'video/mp4'
                    : segment.endsWith('.m4s')
                      ? 'video/iso.segment'
                      : 'video/MP2T';

            return new Response(proxyResponse.body, {
                headers: {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-cache',
                },
            });
        },
    },
});
