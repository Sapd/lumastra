// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { hlsAuthQuery } from '$lib/server/utils/hls-request-utils.js';
import { touchLiveTvViewer } from '$lib/server/services/livetv/viewer-liveness.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { getLiveTvRung } from '$lib/shared/livetv-rungs.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { canReadLiveTvChannelStream } from '$lib/server/services/livetv/channel-access.js';
import { config } from '$lib/server/config.js';
import { proxyErrorResponse } from '../../stream-helpers.js';

const Query = z.object({ grant: z.string().optional(), PlaySessionId: z.string().optional() });

function authQuery(url: URL): string {
    return hlsAuthQuery(url);
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Get a capped Live TV HLS media playlist',
            stability: 'protocol',
            visibility: 'internal',
            auth: 'none',
            query: Query,
            responses: {
                200: { binary: ['application/vnd.apple.mpegurl'], description: 'HLS playlist' },
                401: 'Authentication required',
                404: 'Channel or rung not found',
                503: {
                    description:
                        'Rung starting or unavailable — the proxy has no ready playlist for this rung yet',
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
            if (!config.LIVETV_ADAPTIVE_LADDER_ENABLED) {
                return ApiProblem.forbidden('Live TV quality ladder is disabled');
            }
            const channelId = event.params.id;
            const rung = getLiveTvRung(event.params.rung ?? '');
            if (!channelId || !isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a valid UUID' },
                ]);
            }
            if (!rung) return ApiProblem.notFound('Live TV quality rung not found');

            // Segment-only players (VLC, Kodi) never send keepalives: a fetch is the heartbeat.

            touchLiveTvViewer(event, channelId);

            if (!(await canReadLiveTvChannelStream(event.locals, channelId))) {
                return ApiProblem.notFound(`Channel ${channelId} not found`);
            }
            const response = await getStreamProxyClient().proxyHlsRungPlaylist(
                channelId,
                rung.id,
                event.request.signal,
            );
            if (response.status === 410) return await proxyErrorResponse(response);
            if (!response.ok) {
                return problem('cap_unavailable', {
                    error: `Live TV rung playlist unavailable (${response.status})`,
                    retryAfter: 2,
                });
            }

            const routeBase = apiUrl(
                ctx.surface,
                `/livetv/channels/${channelId}/stream/r/${rung.id}`,
            );
            const query = authQuery(event.url);
            const body = (await response.text()).replace(
                /^(segment-\d+\.ts)$/gm,
                `${routeBase}/$1${query}`,
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
