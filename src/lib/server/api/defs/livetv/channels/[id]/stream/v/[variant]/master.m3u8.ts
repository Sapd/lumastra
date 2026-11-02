// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /livetv/channels/{id}/stream/v/{variant}/master.m3u8
 *
 * Master playlist wrapping one compat variant's media playlist (the hls.js #7283 workaround,
 * see the rung master). Unlike the source and rung masters it does NOT join: the variant is
 * a decision the `/stream` join made from the player's reported capabilities, and that join
 * already registered the viewer. A variant nobody started has no playlist, so a guessed URL
 * starts nothing.
 *
 * The body comes from the stream proxy, which knows the variant's codecs, resolution and
 * video range (handleVariantMaster). When the proxy cannot answer (an older proxy during a
 * rollout, a variant still starting) the route falls back to a bare master; the player then
 * probes the stream itself.
 */
import { touchLiveTvViewer } from '$lib/server/services/livetv/viewer-liveness.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { canReadLiveTvChannelStream } from '$lib/server/services/livetv/channel-access.js';
import { parseVariant, variantAuthQuery } from './variant-params.js';

const Query = z.object({ grant: z.string().optional(), PlaySessionId: z.string().min(1) });

/** Fallback BANDWIDTH: the remux carries the source's rate, which this route cannot know. */
const BANDWIDTH = { fmp4: 20_000_000, h264: 8_000_000 } as const;

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            summary: 'Get a Live TV compatibility HLS master playlist',
            stability: 'protocol',
            visibility: 'internal',
            auth: 'none',
            description:
                'Master playlist of the compatibility output (fmp4 or h264) the stream join chose for ' +
                'this player. Use the `delivery.url` from the Live TV start rather than building this path.',
            query: Query,
            responses: {
                200: { binary: ['application/vnd.apple.mpegurl'], description: 'HLS master' },
                401: 'Authentication required',
                404: 'Channel or variant not found',
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
            const playlistUrl = `${apiUrl(
                ctx.surface,
                `/livetv/channels/${channelId}/stream/v/${variant}/playlist.m3u8`,
            )}${variantAuthQuery(event.url)}`;
            let body: string | null = null;
            try {
                const response = await getStreamProxyClient().proxyHlsVariantFile(
                    channelId,
                    variant,
                    'master.m3u8',
                    event.request.signal,
                );
                if (response.ok) {
                    body = (await response.text()).replace(/^playlist\.m3u8$/m, () => playlistUrl);
                }
            } catch {
                // best-effort: the bare master below still plays.
            }
            // No CODECS here: a wrong hint makes hls.js build the wrong SourceBuffer (see
            // generateMasterPlaylist in the stream proxy).
            body ??= [
                '#EXTM3U',
                '#EXT-X-VERSION:6',
                `#EXT-X-STREAM-INF:BANDWIDTH=${BANDWIDTH[variant]}`,
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
