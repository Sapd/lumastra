// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { config } from '$lib/server/config.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { validatePlayToken } from '$lib/server/jellyfin-compat/play-token.js';
import { disarmSilentStart } from '$lib/server/jellyfin-compat/silent-start.js';
import {
    applyPlayTokenIdentity,
    buildPlayTokenUserContext,
} from '$lib/server/jellyfin-compat/play-token-user.js';
import { enforceTokenLiveTvAccess } from '$lib/server/jellyfin-compat/livetv-token-access.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import {
    canReadLiveTvChannelStream,
    canStreamLiveTvChannel,
} from '$lib/server/services/livetv/channel-access.js';
import {
    deriveLiveTvViewerKey,
    liveTvCredentialFingerprint,
} from '$lib/server/services/livetv/livetv-viewer-key.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('JellyfinCompat:LiveTV:Segment');

/**
 * GET /Videos/[itemId]/live/[segment]
 *
 * Proxies individual HLS segments and media playlists for LiveTV channels
 * via the Jellyfin compatibility layer.
 *
 * Auth: play-token (UUID api_key) takes priority so ExoPlayer's stateless
 * segment fetches work without re-sending the X-Emby-Authorization header.
 * Falls back to withJellyfinAuth for browser-based clients.
 *
 * Segment types: playlist.m3u8, segment-*.m4s, segment-*.ts, init.mp4
 *
 * Viewer liveness: a Jellyfin client joins the channel exactly once (live.m3u8)
 * and then only polls this route. The stream proxy reaps a viewer whose
 * heartbeat is older than LIVETV_VIEWER_TIMEOUT_SECONDS, and a channel with no
 * viewers stops FFmpeg after the grace period — so without a heartbeat here
 * every /j Live TV session died ~75 s in with a 404 playlist. Each media
 * playlist poll (one per target duration) now heartbeats the same viewer key
 * live.m3u8 joined with, and re-joins when the proxy no longer knows it.
 */

/**
 * Keep the proxy viewer alive on a media-playlist poll. Never throws: a
 * heartbeat problem must not take down a stream that is otherwise fine.
 */
async function keepViewerAlive(event: RequestEvent, channelId: string): Promise<void> {
    let viewerId: string;
    try {
        viewerId = deriveLiveTvViewerKey(event);
    } catch {
        return;
    }

    let viewerGone: boolean;
    try {
        const result = await getStreamProxyClient().heartbeat(channelId, viewerId);
        viewerGone = !result?.success;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 404 = the proxy has no such viewer/channel (reaped, or proxy restarted).
        // Anything else is the proxy being unreachable — nothing to re-join.
        if (!message.includes('Proxy 404')) {
            logger.warn('Live TV viewer heartbeat failed', { channelId, viewerId, error: message });
            return;
        }
        viewerGone = true;
    }

    if (!viewerGone) return;

    // getStreamInfo is an idempotent join: it re-registers the viewer and
    // restarts FFmpeg if the channel was already torn down. A segment request
    // must not join a channel the viewer may not open (live.m3u8's gate).
    if (!(await canStreamLiveTvChannel(event.locals, channelId))) return;
    try {
        const provider = await getLiveTvProvider();
        await provider.getStreamInfo(channelId, viewerId);
    } catch (err) {
        logger.warn('Live TV viewer re-join failed', {
            channelId,
            viewerId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
async function handleLiveSegment(
    event: RequestEvent,
    apiKeyForChildren: string,
): Promise<Response> {
    const { params, locals } = event;
    const itemId = params.itemId;
    const segment = params.segment;

    if (!itemId || !isUuid(itemId)) {
        return ApiResponses.badRequest('Invalid item ID');
    }

    if (!config.FEATURE_LIVETV || !locals.user?.hasLiveTvPermission) {
        return ApiProblem.notFound();
    }

    if (!segment || !/^(segment-\d+\.(m4s|ts)|init\.mp4|playlist\.m3u8)$/.test(segment)) {
        return ApiResponses.badRequest('Invalid segment');
    }

    const channelId = itemId;

    // live.m3u8's lineup gate, cached per channel: without it a viewer could
    // read a hidden channel that someone else keeps running.
    if (!(await canReadLiveTvChannelStream(locals, channelId))) {
        return ApiResponses.notFound('Channel not found');
    }

    if (segment === 'playlist.m3u8') {
        await keepViewerAlive(event, channelId);
    }

    let proxyResponse: Response;
    try {
        const proxyClient = getStreamProxyClient();
        proxyResponse = await proxyClient.proxyHlsSegment(channelId, segment);
    } catch {
        return ApiResponses.error('Upstream proxy error', undefined, 502);
    }

    if (!proxyResponse.ok) {
        return ApiResponses.error(
            `Proxy returned ${proxyResponse.status}`,
            undefined,
            proxyResponse.status as 500,
        );
    }

    // Media playlist needs URL rewriting (segment/init references) and must
    // carry the api_key forward so ExoPlayer's stateless segment fetches
    // re-authenticate.
    if (segment === 'playlist.m3u8') {
        const m3u8Text = await proxyResponse.text();
        const apiKeyQuery = apiKeyForChildren
            ? `?api_key=${encodeURIComponent(apiKeyForChildren)}`
            : '';
        const rewritten = m3u8Text
            .replace(
                /^(segment-\d+\.(?:m4s|ts))$/gm,
                `/j/Videos/${channelId}/live/$1${apiKeyQuery}`,
            )
            .replace(/URI="(init\.mp4)"/g, `URI="/j/Videos/${channelId}/live/$1${apiKeyQuery}"`);
        return new Response(rewritten, {
            headers: {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-cache',
            },
        });
    }

    // Stream binary segments directly
    const segLen = parseInt(proxyResponse.headers.get('content-length') ?? '', 10);
    if (segLen > 0) bandwidthTracker.trackLiveTV(segLen);
    return new Response(proxyResponse.body, {
        headers: {
            'Content-Type':
                segment === 'init.mp4'
                    ? 'video/mp4'
                    : segment.endsWith('.m4s')
                      ? 'video/iso.segment'
                      : 'video/MP2T',
            'Cache-Control': 'no-cache',
        },
    });
}

const jellyfinAuthHandler: RequestHandler = withJellyfinAuth(
    (event) => {
        void disarmSilentStart({
            username: event.locals.user?.username ?? null,
            itemId: event.params.itemId,
            userId: event.locals.user?.userId ?? null,
            deviceId: event.locals.jfDevice?.deviceId ?? null,
        });
        return handleLiveSegment(event, event.url.searchParams.get('api_key') ?? '');
    },
    { pat: 'deny' },
);

export const GET: RequestHandler = withErrorHandler(async (event) => {
    if (!config.FEATURE_LIVETV) return ApiProblem.notFound();
    const itemId = event.params.itemId ?? '';
    const apiKeyParam = event.url.searchParams.get('api_key') ?? '';

    if (isUuid(apiKeyParam)) {
        const tokenData = await validatePlayToken(apiKeyParam);
        if (tokenData?.itemId === itemId) {
            // Serve-time re-check (cheap L1-cache hit): deny once Live TV access
            // is revoked rather than serving segments until token expiry.
            const revoked = await enforceTokenLiveTvAccess(tokenData.userId);
            if (revoked) return revoked;
            const user = await buildPlayTokenUserContext(tokenData.userId, {
                hasLiveTvPermission: true,
            });
            if (!user) return ApiResponses.unauthorized('Account not provisioned');
            applyPlayTokenIdentity(event, user);
            void disarmSilentStart({ username: tokenData.userId, itemId: tokenData.itemId });
            // Same discriminator live.m3u8 uses, so the heartbeat names the
            // viewer that actually joined.
            event.locals.liveTvCredentialId = liveTvCredentialFingerprint('jf-play', apiKeyParam);
            return handleLiveSegment(event, apiKeyParam);
        }
        return ApiResponses.unauthorized('Invalid or expired stream token');
    }

    return jellyfinAuthHandler(event);
});
