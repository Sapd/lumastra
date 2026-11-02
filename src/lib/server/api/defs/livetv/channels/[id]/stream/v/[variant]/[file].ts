// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /livetv/channels/{id}/stream/v/{variant}/{file}
 *
 * A compat variant's init segment (`init.mp4`, or `init-<n>.mp4` after an ingest failover;
 * fMP4 only) or media segment
 * (`segment-N.m4s` for fmp4, `segment-N.ts` for h264), streamed from the stream proxy.
 */
import { touchLiveTvViewer } from '$lib/server/services/livetv/viewer-liveness.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { canReadLiveTvChannelStream } from '$lib/server/services/livetv/channel-access.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { parseVariant } from './variant-params.js';
import { proxyErrorResponse } from '../../stream-helpers.js';

const Query = z.object({ grant: z.string().optional(), PlaySessionId: z.string().optional() });
const FILE = {
    fmp4: /^(?:init(?:-\d+)?\.mp4|segment-\d+\.m4s)$/,
    h264: /^segment-\d+\.ts$/,
} as const;

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Get a Live TV compatibility HLS segment',
            stability: 'protocol',
            visibility: 'internal',
            auth: 'none',
            query: Query,
            responses: {
                200: {
                    binary: ['video/mp4', 'video/MP2T'],
                    description: 'fMP4 init or media segment, or MPEG-TS segment',
                },
                401: 'Authentication required',
                404: 'Segment not found',
                502: 'Stream proxy unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    raw: true,
    request: { query: Query },
    handlers: {
        GET: async (event) => {
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
            const file = event.params.file;
            if (!file || !FILE[variant].test(file)) {
                return ApiProblem.validationFailed([
                    { field: 'file', message: 'Invalid segment name' },
                ]);
            }

            // Segment-only players (VLC, Kodi) never send keepalives: a fetch is the heartbeat.

            touchLiveTvViewer(event, channelId);

            if (!(await canReadLiveTvChannelStream(event.locals, channelId))) {
                return ApiProblem.notFound(`Channel ${channelId} not found`);
            }
            const response = await getStreamProxyClient().proxyHlsVariantFile(
                channelId,
                variant,
                file,
                event.request.signal,
            );
            if (response.status === 404) return ApiProblem.notFound('Segment not found');
            if (!response.ok || !response.body) {
                return await proxyErrorResponse(response);
            }
            const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
            if (length > 0) bandwidthTracker.trackLiveTV(length);
            return new Response(response.body, {
                headers: {
                    'Content-Type': variant === 'fmp4' ? 'video/mp4' : 'video/MP2T',
                    'Cache-Control': 'no-cache',
                },
            });
        },
    },
});
