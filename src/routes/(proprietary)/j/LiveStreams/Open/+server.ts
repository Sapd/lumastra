// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import { json, type RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { isRecord } from '$lib/utils/data-extraction';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import {
    StreamFailureError,
    StreamLimitError,
} from '$lib/server/services/livetv/standalone-livetv-provider';
import {
    deriveLiveTvViewerKey,
    liveTvCredentialFingerprint,
} from '$lib/server/services/livetv/livetv-viewer-key';
import { getParam, hasLiveTvPermission } from '$lib/server/proprietary/jellyfin-compat/utils';
import {
    issuePlayToken,
    revokePlayTokenBySession,
} from '$lib/server/proprietary/jellyfin-compat/play-token';
import {
    buildStreamLimitPlaybackInfo,
    freshPlaySessionId,
    noticeLanguage,
} from '$lib/server/proprietary/jellyfin-compat/stream-limit-notice';
import { liveTvMediaSource } from '$lib/server/proprietary/jellyfin-compat/livetv-live-stream';
import type { JellyfinPlaybackInfoResponse } from '$lib/server/proprietary/jellyfin-compat/types';

const logger = Logger.for('JellyfinCompat:LiveStreams:Open');

function stringField(body: Record<string, unknown>, key: string): string | undefined {
    const v = body[key];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The stream-limit clip as a LiveStreamResponse, or Jellyfin-less 503 when it cannot be built. */
function limitResponse(clip: JellyfinPlaybackInfoResponse | null, limit: number): Response {
    const source = clip?.MediaSources[0];
    if (source) return json({ MediaSource: source });
    return new Response(JSON.stringify({ error: 'stream_limit_reached', limit }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * POST /LiveStreams/Open → LiveStreamResponse { MediaSource }.
 *
 * Some apps tune Live TV by opening a live stream instead of (or after)
 * PlaybackInfo. Lumastra serves Live TV only, so the item to open is a channel:
 * `ItemId` (query or OpenLiveStreamDto body), or `OpenToken`, which for our own
 * sources is the channel id. Anything else is 404.
 *
 * The tune runs exactly like PlaybackInfo's Live TV branch: Live TV permission,
 * and the TV source's concurrent-stream cap (joined under the play-token
 * viewer key the live.m3u8 polls keep alive). A cap reached answers with the "streams in use" clip as the media source, the
 * way PlaybackInfo does; a stream the source cannot start is 502.
 */
async function handleOpen(event: RequestEvent): Promise<Response> {
    const { url, locals } = event;
    const raw: unknown = await readBoundedJson(event.request).catch(() => ({}));
    const body = isRecord(raw) ? raw : {};

    const channelId =
        getParam(url, 'ItemId') ??
        stringField(body, 'ItemId') ??
        getParam(url, 'OpenToken') ??
        stringField(body, 'OpenToken');
    if (!channelId) {
        return ApiResponses.badRequest('ItemId or OpenToken is required');
    }
    // 404 (not 403) without permission: the same answer as an unknown channel.
    if (!hasLiveTvPermission(locals.user) || !isUuid(channelId)) {
        return ApiResponses.notFound('Live stream source not found');
    }
    const user = locals.user;

    try {
        const provider = await getLiveTvProvider();
        const channel = await provider.getChannel(channelId);
        // A channel the admin hid (disabled or broken source) does not exist for
        // clients, as in the guide, Programs/{id} and Timers/Defaults: never tune it.
        if (!channel || channel.isVisible === false) {
            return ApiResponses.notFound('Live stream source not found');
        }
        // …nor one in a hidden category (the /api stream endpoints' access rule).
        if (!(await canStreamLiveTvChannel(locals, channelId))) {
            return ApiResponses.notFound('Live stream source not found');
        }

        const playSessionId = await freshPlaySessionId(
            getParam(url, 'PlaySessionId') ?? stringField(body, 'PlaySessionId'),
        );
        const streamToken = await issuePlayToken(channelId, user.username, playSessionId, null);
        // The viewer key the live.m3u8 / segment routes derive from this token:
        // this join is the very viewer their playlist polls keep alive.
        locals.liveTvCredentialId = liveTvCredentialFingerprint('jf-play', streamToken);
        try {
            await provider.getStreamInfo(channelId, deriveLiveTvViewerKey(event));
        } catch (err) {
            // Nothing will use the token now; do not leave it usable.
            await revokePlayTokenBySession(playSessionId);
            if (err instanceof StreamLimitError) {
                logger.info('Live stream open refused — source stream limit reached', {
                    channelId,
                    limit: err.limit,
                    active: err.activeChannels.length,
                });
                const clip =
                    err.limit > 0
                        ? await buildStreamLimitPlaybackInfo({
                              kind: 'livetv_source',
                              userId: user.userId,
                              cap: err.limit,
                              lang: noticeLanguage(event.request),
                              itemId: channelId,
                          })
                        : null;
                return limitResponse(clip, err.limit);
            }
            if (err instanceof StreamFailureError) {
                return new Response(
                    JSON.stringify({ error: err.errorCode, message: err.message }),
                    { status: 502, headers: { 'Content-Type': 'application/json' } },
                );
            }
            throw err;
        }

        return json({ MediaSource: liveTvMediaSource(channelId, streamToken, playSessionId) });
    } catch (error) {
        logger.error('LiveStreams/Open failed', error as Error, { channelId });
        return ApiResponses.error('Could not open live stream', undefined, 502);
    }
}

// pat: 'deny' like PlaybackInfo: the response embeds a replayable play token.
// POST mutates nothing persistent but is non-safe, so it declares mode: 'write'.
export const POST: RequestHandler = withJellyfinAuth(handleOpen, { pat: 'deny', mode: 'write' });
