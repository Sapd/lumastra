// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { touchLiveTvViewer } from '$lib/server/services/livetv/viewer-liveness.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getLiveTvRung } from '$lib/shared/livetv-rungs.js';
import { config } from '$lib/server/config.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { canReadLiveTvChannelStream } from '$lib/server/services/livetv/channel-access.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { peekLiveTvViewerKey } from '$lib/server/services/livetv/livetv-viewer-key.js';
import { recordAdaptiveSegment } from '$lib/server/services/adaptive-playback-state.service.js';
import { proxyErrorResponse } from '../../stream-helpers.js';

const Query = z.object({ grant: z.string().optional(), PlaySessionId: z.string().optional() });
const SEGMENT = /^segment-\d+\.ts$/;

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Get an adaptive Live TV segment',
            stability: 'protocol',
            visibility: 'internal',
            auth: 'none',
            query: Query,
            responses: { 200: { binary: ['video/MP2T'], description: 'MPEG-TS segment' } },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    raw: true,
    request: { query: Query },
    handlers: {
        GET: async (event) => {
            if (!event.locals.user?.hasLiveTvPermission) return ApiProblem.notFound();
            if (!config.LIVETV_ADAPTIVE_LADDER_ENABLED)
                return ApiProblem.forbidden('Adaptive Live TV is disabled');
            const channelId = event.params.id;
            const outputId = event.params.output ?? '';
            const segment = event.params.segment;
            if (!channelId || !isUuid(channelId))
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a valid UUID' },
                ]);
            if (outputId !== 'original' && !getLiveTvRung(outputId))
                return ApiProblem.notFound('Adaptive output not found');
            if (outputId === 'original' && !config.LIVETV_ADAPTIVE_INCLUDE_ORIGINAL)
                return ApiProblem.notFound('Adaptive Original output not enabled');
            if (!segment || !SEGMENT.test(segment))
                return ApiProblem.validationFailed([
                    { field: 'segment', message: 'Invalid segment name' },
                ]);

            // Segment-only players (VLC, Kodi) never send keepalives: a fetch is the heartbeat.

            touchLiveTvViewer(event, channelId);

            if (!(await canReadLiveTvChannelStream(event.locals, channelId))) {
                return ApiProblem.notFound(`Channel ${channelId} not found`);
            }
            const response = await getStreamProxyClient().proxyHlsAdaptiveSegment(
                channelId,
                outputId,
                segment,
                event.request.signal,
            );
            if (!response.ok || !response.body) return await proxyErrorResponse(response);
            const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
            if (length > 0) bandwidthTracker.trackLiveTV(length);
            // The rung in the URL is the variant this viewer plays now — the server-side
            // source of the adaptive badge in Active Streams and Admin → Sessions.
            const viewerKey = peekLiveTvViewerKey(event);
            if (viewerKey) {
                void recordAdaptiveSegment(
                    channelId,
                    viewerKey,
                    event.locals.user.username,
                    outputId,
                );
            }
            return new Response(response.body, {
                headers: { 'Content-Type': 'video/MP2T', 'Cache-Control': 'no-cache' },
            });
        },
    },
});
