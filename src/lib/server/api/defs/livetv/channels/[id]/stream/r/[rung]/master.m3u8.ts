// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { hlsAuthQuery } from '$lib/server/utils/hls-request-utils.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { getLiveTvRung } from '$lib/shared/livetv-rungs.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import {
    deriveLiveTvViewerKey,
    isLiveTvPreviewRequest,
    liveTvJoinPriority,
} from '$lib/server/services/livetv/livetv-viewer-key.js';
import { getLiveTvCapFallback } from '$lib/server/services/livetv/livetv-cap-policy.js';
import { getLiveTvSessionService } from '$lib/server/services/livetv/livetv-session.service.js';
import { joinWithEviction } from '../../stream-helpers.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';

const Query = z.object({ grant: z.string().optional(), PlaySessionId: z.string().min(1) });
const logger = Logger.for('LiveTV:HLS:Rung');

function authQuery(url: URL): string {
    return hlsAuthQuery(url);
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Get a capped Live TV HLS master playlist',
            stability: 'protocol',
            visibility: 'internal',
            auth: 'none',
            query: Query,
            responses: {
                200: { binary: ['application/vnd.apple.mpegurl'], description: 'HLS master' },
                401: 'Authentication required',
                404: 'Channel or rung not found',
                503: {
                    description:
                        'Requested cap unavailable — the pinned rung could not be honored ' +
                        '(see also stream_limit, emitted on the same join path when the ' +
                        'channel has no free viewer slot)',
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

            const viewerKey = deriveLiveTvViewerKey(event);
            const sessionService = getLiveTvSessionService();
            const kicked = await sessionService.checkKicked(viewerKey, channelId);
            if (kicked.kicked) {
                return problem('gone', { error: 'viewer_kicked', details: kicked.reason });
            }

            const streamInfo = await joinWithEviction(
                event.locals,
                channelId,
                viewerKey,
                liveTvJoinPriority(
                    event.locals.user.liveTvPriority,
                    isLiveTvPreviewRequest(event.url),
                ),
                'HLS:Rung',
                {
                    rung: { ...rung },
                    requestedMaxBitrate: rung.maxBitrate,
                    belowLadder: false,
                    // Rung URLs are authenticated but predictable. Re-run feasibility
                    // so a direct URL cannot bypass the initial /stream cap verdict.
                    // Existing encoders still take EgressManager's zero-cost share path.
                    pinned: false,
                    fallback: getLiveTvCapFallback(),
                },
            );
            if (streamInfo instanceof Response) return streamInfo;
            if (streamInfo.rungId !== rung.id) {
                return problem('cap_unavailable', { error: 'Pinned Live TV rung unavailable' });
            }

            try {
                await sessionService.registerSession(
                    viewerKey,
                    event.locals.user.username,
                    channelId,
                    streamInfo.sourceId ?? channelId,
                    liveTvJoinPriority(
                        event.locals.user.liveTvPriority,
                        isLiveTvPreviewRequest(event.url),
                    ),
                );
            } catch (error) {
                logger.warn('Rung session registration failed', {
                    channelId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            const playlistUrl = `${apiUrl(
                ctx.surface,
                `/livetv/channels/${channelId}/stream/r/${rung.id}/playlist.m3u8`,
            )}${authQuery(event.url)}`;
            const body = [
                '#EXTM3U',
                '#EXT-X-VERSION:3',
                // BANDWIDTH only. This master wraps a SINGLE variant — it exists just
                // for the HLS.js #7283 workaround (a media playlist served as the
                // manifest URL stops loading fragments on live streams), so RESOLUTION
                // and CODECS have nothing to select between, and both were wrong:
                //   - CODECS claimed avc1.4d401f (H.264 Main@3.1) while egress-args.ts
                //     sets no -profile:v/-level, so libx264 and every hardware encoder
                //     emit High at level >= 4.0 for 1080p. generateMasterPlaylist
                //     already records what a hardcoded avc1 hint costs: the player
                //     builds a SourceBuffer from the hint instead of the stream and
                //     throws NotSupportedError.
                //   - RESOLUTION assumed 16:9, but egress scales with
                //     `scale=-2:'min(ih,H)'`, so a 4:3 or 2.35:1 source has a width
                //     this route cannot know. The adaptive master derives it from the
                //     probe (adaptiveVariantWidth); this route has no probe.
                `#EXT-X-STREAM-INF:BANDWIDTH=${rung.maxBitrate}`,
                playlistUrl,
                '',
            ].join('\n');
            return new Response(body, {
                headers: {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Cache-Control': 'no-cache',
                },
            });
        },
    },
});
