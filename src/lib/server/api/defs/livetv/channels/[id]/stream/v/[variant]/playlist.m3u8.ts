// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /livetv/channels/{id}/stream/v/{variant}/playlist.m3u8
 *
 * The compat variant's media playlist from the stream proxy, with the init segment
 * (EXT-X-MAP, fMP4 only) and segment names rewritten to this surface's routes.
 */
import { touchLiveTvViewer } from '$lib/server/services/livetv/viewer-liveness.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { canReadLiveTvChannelStream } from '$lib/server/services/livetv/channel-access.js';
import { parseVariant, rewriteVariantPlaylist, variantAuthQuery } from './variant-params.js';
import { proxyErrorResponse } from '../../stream-helpers.js';

const Query = z.object({ grant: z.string().optional(), PlaySessionId: z.string().optional() });

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Get a Live TV compatibility HLS media playlist',
            stability: 'protocol',
            visibility: 'internal',
            auth: 'none',
            query: Query,
            responses: {
                200: { binary: ['application/vnd.apple.mpegurl'], description: 'HLS playlist' },
                401: 'Authentication required',
                404: 'Channel or variant not found',
                503: {
                    description: 'Variant starting or unavailable — no ready playlist yet',
                    code: 'cap_unavailable',
                },
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    raw: true,
    request: { query: Query },
    handlers: {
        GET: async (event, ctx) => {
            if (!event.locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            const channelId = event.params.id;
            if (!channelId || !isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a valid UUID' },
                ]);
            }
            const variant = parseVariant(event.params.variant);
            if (!variant) return ApiProblem.notFound('Live TV stream variant not found');

            // Segment-only players (VLC, Kodi) never send keepalives: a fetch is the heartbeat.

            touchLiveTvViewer(event, channelId);

            if (!(await canReadLiveTvChannelStream(event.locals, channelId))) {
                return ApiProblem.notFound(`Channel ${channelId} not found`);
            }
            const response = await getStreamProxyClient().proxyHlsVariantFile(
                channelId,
                variant,
                'playlist.m3u8',
                event.request.signal,
            );
            if (response.status === 410) return await proxyErrorResponse(response);
            if (!response.ok) {
                return problem('cap_unavailable', {
                    error: `Live TV variant playlist unavailable (${response.status})`,
                    retryAfter: 2,
                });
            }
            const routeBase = apiUrl(
                ctx.surface,
                `/livetv/channels/${channelId}/stream/v/${variant}`,
            );
            const body = rewriteVariantPlaylist(
                await response.text(),
                routeBase,
                variantAuthQuery(event.url),
            );
            return new Response(body, {
                headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Cache-Control': 'no-cache',
                },
            });
        },
    },
});
