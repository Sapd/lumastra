// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { hlsAuthQuery } from '$lib/server/utils/hls-request-utils.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { LIVETV_RUNGS } from '$lib/shared/livetv-rungs.js';
import { config } from '$lib/server/config.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import {
    deriveLiveTvViewerKey,
    isLiveTvPreviewRequest,
    liveTvJoinPriority,
} from '$lib/server/services/livetv/livetv-viewer-key.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { joinWithEviction, proxyErrorResponse } from '../stream-helpers.js';
import { getLiveTvCapFallback } from '$lib/server/services/livetv/livetv-cap-policy.js';
import { getLiveTvSessionService } from '$lib/server/services/livetv/livetv-session.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { recordAdaptiveLadder } from '$lib/server/services/adaptive-playback-state.service.js';

const logger = Logger.for('LiveTV:HLS:Adaptive');

const Query = z.object({ grant: z.string().optional(), PlaySessionId: z.string().min(1) });

function authQuery(url: URL): string {
    return hlsAuthQuery(url);
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Get the adaptive Live TV HLS master playlist',
            stability: 'protocol',
            visibility: 'internal',
            auth: 'none',
            query: Query,
            responses: {
                200: {
                    binary: ['application/vnd.apple.mpegurl'],
                    description: 'Adaptive HLS master',
                },
                403: 'Adaptive ladder disabled',
                410: 'Viewer was evicted',
                422: 'Invalid request',
                502: 'Upstream stream failure',
                503: {
                    description:
                        'Adaptive ladder unavailable — the proxy could not build the adaptive ' +
                        'encoder group (see also stream_limit, emitted on the same join path ' +
                        'when the channel has no free viewer slot)',
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
                return ApiProblem.forbidden('Adaptive Live TV is disabled by the administrator');
            }
            const channelId = event.params.id;
            if (!channelId || !isUuid(channelId)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Must be a valid UUID' },
                ]);
            }
            const viewerId = deriveLiveTvViewerKey(event);

            // Anti-reconnect guard, mirroring /stream, master.m3u8 and
            // r/[rung]/master.m3u8. This route performs a REAL join — it acquires a
            // viewer slot and can spawn the whole adaptive encoder group — so without
            // the check a kicked viewer whose client still holds this URL silently
            // re-joins. hls.js re-fetches the manifest URL during post-fatal recovery,
            // so that is a routine event, not a hypothetical.
            const sessionService = getLiveTvSessionService();
            const kicked = await sessionService.checkKicked(viewerId, channelId);
            if (kicked.kicked) {
                return problem('gone', { error: 'viewer_kicked', details: kicked.reason });
            }

            const joined = await joinWithEviction(
                event.locals,
                channelId,
                viewerId,
                liveTvJoinPriority(
                    event.locals.user.liveTvPriority,
                    isLiveTvPreviewRequest(event.url),
                ),
                'HLS:Adaptive',
                undefined,
                {
                    rungs: LIVETV_RUNGS.map((rung) => ({ ...rung })),
                    includeOriginal: config.LIVETV_ADAPTIVE_INCLUDE_ORIGINAL,
                    fallback: getLiveTvCapFallback(),
                },
            );
            if (joined instanceof Response) return joined;
            if (!joined.adaptive) {
                return problem('cap_unavailable', { error: 'Adaptive Live TV unavailable' });
            }
            // Display-only: Active Streams and Admin → Sessions show this ladder.
            void recordAdaptiveLadder(channelId, {
                ...joined.adaptive,
                rungs: joined.adaptive.rungs.map(({ maxBitrateBps, ...rung }) => ({
                    ...rung,
                    maxBitrate: maxBitrateBps,
                })),
            });

            // Register the Valkey session (non-fatal — the proxy owns slot counts).
            // Without it this viewer holds a proxy slot and pins encoders while being
            // invisible to the admin active-viewer surfaces, so they cannot be kicked
            // again through them.
            try {
                await sessionService.registerSession(
                    viewerId,
                    event.locals.user.username,
                    channelId,
                    joined.sourceId ?? channelId,
                    liveTvJoinPriority(
                        event.locals.user.liveTvPriority,
                        isLiveTvPreviewRequest(event.url),
                    ),
                );
            } catch (error) {
                logger.warn('Adaptive session registration failed', {
                    channelId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            const response = await getStreamProxyClient().proxyHlsAdaptiveMaster(
                channelId,
                event.request.signal,
            );
            if (!response.ok) return await proxyErrorResponse(response);

            const base = apiUrl(ctx.surface, `/livetv/channels/${channelId}/stream/a`);
            const query = authQuery(event.url);
            const body = (await response.text()).replace(
                /^([A-Za-z0-9_-]+)\/playlist\.m3u8$/gm,
                `${base}/$1/playlist.m3u8${query}`,
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
