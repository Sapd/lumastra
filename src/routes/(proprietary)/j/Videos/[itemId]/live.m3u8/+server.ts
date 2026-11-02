// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { config } from '$lib/server/config.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    StreamLimitError,
    StreamFailureError,
} from '$lib/server/services/livetv/standalone-livetv-provider.js';
import { validatePlayToken } from '$lib/server/proprietary/jellyfin-compat/play-token.js';
import { disarmSilentStart } from '$lib/server/proprietary/jellyfin-compat/silent-start.js';
import {
    applyPlayTokenIdentity,
    buildPlayTokenUserContext,
} from '$lib/server/proprietary/jellyfin-compat/play-token-user.js';
import { enforceTokenLiveTvAccess } from '$lib/server/proprietary/jellyfin-compat/livetv-token-access.js';
import {
    deriveLiveTvViewerKey,
    liveTvCredentialFingerprint,
} from '$lib/server/services/livetv/livetv-viewer-key.js';

const logger = Logger.for('JellyfinCompat:LiveTV:HLS');

/**
 * Core handler — locals.user must already be populated by the caller.
 * `apiKeyForChildren` is appended to the rewritten playlist.m3u8 URL so the
 * downstream segment route can re-authenticate (HLS is stateless per-segment).
 */
async function handleLiveTvHls(event: RequestEvent, apiKeyForChildren: string): Promise<Response> {
    const { params, locals } = event;
    const itemId = params.itemId;

    if (!itemId || !isUuid(itemId)) {
        return ApiResponses.badRequest('Invalid item ID');
    }

    if (!config.FEATURE_LIVETV || !locals.user?.hasLiveTvPermission) {
        return ApiProblem.notFound();
    }

    const viewerId = deriveLiveTvViewerKey(event);
    const channelId = itemId;
    // The channel access rule of the /api stream endpoints (hidden category,
    // hidden feed while feed choice is off): before any join.
    if (!(await canStreamLiveTvChannel(locals, channelId))) {
        return ApiResponses.notFound('Live stream source not found');
    }

    try {
        const provider = await getLiveTvProvider();
        await provider.getStreamInfo(channelId, viewerId);
    } catch (err) {
        if (err instanceof StreamLimitError) {
            return new Response(
                JSON.stringify({
                    error: 'stream_limit_reached',
                    limit: err.limit,
                    active: err.activeChannels,
                }),
                { status: 503, headers: { 'Content-Type': 'application/json' } },
            );
        }
        if (err instanceof StreamFailureError) {
            return new Response(JSON.stringify({ error: err.errorCode, message: err.message }), {
                status: 502,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        logger.error(
            'Failed to get stream info for LiveTV channel',
            err instanceof Error ? err : new Error(String(err)),
            { channelId },
        );
        return ApiResponses.error('Could not start or join stream', undefined, 502);
    }

    let m3u8Text: string;
    try {
        const proxyClient = getStreamProxyClient();
        const proxyResponse = await proxyClient.proxyHlsPlaylist(channelId);

        if (!proxyResponse.ok) {
            return ApiResponses.error(
                `Proxy returned ${proxyResponse.status}`,
                undefined,
                proxyResponse.status as 500,
            );
        }

        m3u8Text = await proxyResponse.text();
    } catch (err) {
        logger.error(
            'Failed to fetch upstream HLS playlist',
            err instanceof Error ? err : new Error(String(err)),
            { channelId },
        );
        return ApiResponses.error('Failed to fetch upstream playlist', undefined, 502);
    }

    // Rewrite playlist.m3u8 reference to point through the Jellyfin-compat segment
    // route, carrying the api_key forward so HLS sub-fetches re-authenticate.
    const apiKeyQuery = apiKeyForChildren
        ? `?api_key=${encodeURIComponent(apiKeyForChildren)}`
        : '';
    const rewritten = m3u8Text.replace(
        /^playlist\.m3u8$/gm,
        `/j/Videos/${channelId}/live/playlist.m3u8${apiKeyQuery}`,
    );

    return new Response(rewritten, {
        headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache',
        },
    });
}

/**
 * GET /Videos/[itemId]/live.m3u8
 *
 * Serves the HLS master playlist for a LiveTV channel via the Jellyfin
 * compatibility layer.
 *
 * Auth: play token (UUID api_key issued by PlaybackInfo) takes priority so that
 * ExoPlayer stream requests work without session cookie support. Falls back to
 * withJellyfinAuth (X-Emby-Authorization header) for browser-based clients.
 */
const jellyfinAuthHandler: RequestHandler = withJellyfinAuth(
    (event) => {
        void disarmSilentStart({
            username: event.locals.user?.username ?? null,
            itemId: event.params.itemId,
            userId: event.locals.user?.userId ?? null,
            deviceId: event.locals.jfDevice?.deviceId ?? null,
        });
        return handleLiveTvHls(event, event.url.searchParams.get('api_key') ?? '');
    },
    { pat: 'deny' },
);

export const GET: RequestHandler = withErrorHandler(async (event) => {
    if (!config.FEATURE_LIVETV) return ApiProblem.notFound();
    const itemId = event.params.itemId ?? '';
    const apiKeyParam = event.url.searchParams.get('api_key') ?? '';

    // Play-token path — UUID tokens issued by PlaybackInfo for ExoPlayer stream URLs
    if (isUuid(apiKeyParam)) {
        const tokenData = await validatePlayToken(apiKeyParam);
        if (tokenData?.itemId === itemId) {
            // Serve-time re-check: the token forces hasLiveTvPermission, so a
            // user whose Live TV access was revoked after token issuance would
            // otherwise keep streaming until the (renewable) token expires.
            const revoked = await enforceTokenLiveTvAccess(tokenData.userId);
            if (revoked) return revoked;
            const user = await buildPlayTokenUserContext(tokenData.userId, {
                hasLiveTvPermission: true,
            });
            if (!user) return ApiResponses.unauthorized('Account not provisioned');
            applyPlayTokenIdentity(event, user);
            void disarmSilentStart({ username: tokenData.userId, itemId: tokenData.itemId });
            event.locals.liveTvCredentialId = liveTvCredentialFingerprint('jf-play', apiKeyParam);
            return handleLiveTvHls(event, apiKeyParam);
        }
        return ApiResponses.unauthorized('Invalid or expired stream token');
    }

    // Session-token path (X-Emby-Authorization header or 64-char hex api_key)
    return jellyfinAuthHandler(event);
});
