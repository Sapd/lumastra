// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import {
    mintPlaybackGrant,
    buildGrantedHref,
    type MintedPlaybackGrant,
} from '../playback-grant.js';
import { getClientIpStrictFromRequest } from '$lib/server/utils/client-ip.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { withPlaybackViewerLock } from './playback-session-lifecycle.js';
import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getLiveTvSessionService } from '$lib/server/services/livetv/livetv-session.service.js';
import { resolveStation, mapFeedStations } from './station.service.js';
import { getStreamProxyClient } from './stream-proxy-client.js';
import type { LiveTvPlaybackSession } from './livetv-session.service.js';
import {
    getDeviceIdForSession,
    getUserDeviceByDeviceId,
} from '$lib/server/database/queries/user-devices.queries.js';
import { getDb } from '$lib/server/database/connection.js';
import { recordChannelWatch } from '$lib/server/database/queries/livetv-channels.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { joinWithEviction } from '$lib/server/api/defs/livetv/channels/[id]/stream/stream-helpers.js';
import { liveTvJoinCompat } from '$lib/server/services/livetv/livetv-join-compat.js';
import type { z } from 'zod';
import type { PlaybackSessionStartSchema } from '$lib/schemas/livetv-playback-sessions.js';
import { apiBase, apiUrl } from '$lib/shared/api-urls.js';
import { getLiveTvRung, LIVETV_RUNGS, resolveLiveTvRung } from '$lib/shared/livetv-rungs.js';
import {
    deriveLiveTvViewerKey,
    liveTvJoinPriority,
} from '$lib/server/services/livetv/livetv-viewer-key.js';
import { getLiveTvCapFallback } from '$lib/server/services/livetv/livetv-cap-policy.js';
import { config } from '$lib/server/config.js';

const logger = Logger.for('LiveTV:Start');

/** How often the player must send keepalive for a Live TV playback session. */
const LIVETV_HEARTBEAT_INTERVAL_MS = 10_000;

async function startPlaybackUnlocked(
    event: RequestEvent,
    surface: ApiSurface,
    input: z.infer<typeof PlaybackSessionStartSchema>,
    viewerKey: string,
): Promise<Response> {
    const { locals } = event;
    input = {
        ...input,
        stationId: input.stationId.toLowerCase(),
        feedId: input.feedId?.toLowerCase(),
    };

    if (!locals.user?.hasLiveTvPermission) {
        return ApiProblem.notFound();
    }

    const station = await resolveStation(input.stationId);
    if (!station)
        return problem('not_found', { error: 'Station not found', reason: 'station_not_found' });
    const channelId = input.feedId ?? station.shownFeedId;
    if (input.feedId) {
        const mapping = await mapFeedStations([input.feedId]);
        if (mapping.get(input.feedId) !== station.stationId)
            return problem('not_found', {
                error: 'Feed not found in station',
                reason: 'feed_not_found',
            });
    }

    const username = locals.user.username;
    const preview = input.purpose === 'preview';
    const priority = liveTvJoinPriority(locals.user.liveTvPriority, preview);
    const sessionService = getLiveTvSessionService();

    // Anti-reconnect guard: reject immediately if viewer was recently kicked.
    const kickedStatus = await sessionService.checkKicked(viewerKey, channelId);
    if (kickedStatus.kicked) {
        return problem('gone', {
            error: 'playback_session_ended',
            reason: 'evicted',
            details: kickedStatus.reason,
        });
    }

    const ladderEnabled = config.LIVETV_ADAPTIVE_LADDER_ENABLED;
    const legacyMaxBitrate = input.maxBitrateBps;
    const requestedQuality = input.quality;
    const effectiveQuality = !ladderEnabled
        ? 'original'
        : requestedQuality === undefined || requestedQuality === 'server'
          ? legacyMaxBitrate === undefined
              ? config.LIVETV_DEFAULT_QUALITY
              : 'legacy'
          : requestedQuality;

    const resolvedLegacy =
        effectiveQuality === 'legacy' && legacyMaxBitrate !== undefined
            ? resolveLiveTvRung(legacyMaxBitrate)
            : undefined;
    const selectedRung =
        effectiveQuality === 'legacy'
            ? resolvedLegacy === 'below_ladder'
                ? LIVETV_RUNGS[LIVETV_RUNGS.length - 1]
                : resolvedLegacy
            : effectiveQuality !== 'adaptive' && effectiveQuality !== 'original'
              ? getLiveTvRung(effectiveQuality)
              : undefined;
    const requestedMaxBitrate =
        effectiveQuality === 'legacy' ? legacyMaxBitrate : selectedRung?.maxBitrate;
    const cap =
        selectedRung && requestedMaxBitrate
            ? {
                  rung: { ...selectedRung },
                  requestedMaxBitrate,
                  belowLadder: resolvedLegacy === 'below_ladder',
                  pinned: false,
                  fallback: getLiveTvCapFallback(),
              }
            : undefined;
    const adaptive =
        effectiveQuality === 'adaptive'
            ? {
                  rungs: LIVETV_RUNGS.map((rung) => ({ ...rung })),
                  includeOriginal: config.LIVETV_ADAPTIVE_INCLUDE_ORIGINAL,
                  fallback: getLiveTvCapFallback(),
              }
            : undefined;

    const joined: { feeds?: Array<{ id: string; name: string }> } = {};
    const streamInfoOrError = await joinWithEviction(
        locals,
        channelId,
        viewerKey,
        priority,
        'StreamInfo',
        cap,
        adaptive,
        liveTvJoinCompat(input.hevc, event.request.headers.get('user-agent')),
        // Only a normal start waits for the first segment (and counts as a feed success).
        {
            awaitReady: !preview,
            onFeedsSent: (feeds) => {
                joined.feeds = feeds;
            },
        },
    );
    if (streamInfoOrError instanceof Response) return streamInfoOrError;
    const streamInfo = streamInfoOrError;

    // Register session (non-fatal — proxy is source of truth for slot counts).
    try {
        await sessionService.registerSession(
            viewerKey,
            username,
            channelId,
            streamInfo.sourceId ?? channelId,
            priority,
        );
    } catch (sessionErr) {
        logger.warn('Session registration failed, stream info already returned', {
            channelId,
            error: sessionErr instanceof Error ? sessionErr.message : String(sessionErr),
        });
    }

    // Rewrite the internal stream URL so it routes through the correct
    // surface prefix. Both surfaces use the same SvelteKit HLS proxy
    // routes; only the path prefix differs.
    // Guard: only replace when the URL starts with the internal prefix to
    // avoid double-rewriting if the provider already emits the v1 path.
    const internalPrefix = `${apiBase('internal')}/livetv/`;
    const routeBase = `${apiBase(surface)}/livetv/`;
    const routedStreamUrl = streamInfo.streamUrl.startsWith(internalPrefix)
        ? streamInfo.streamUrl.replace(internalPrefix, routeBase)
        : streamInfo.streamUrl;
    // The master playlist joins as the same viewer the session was started as.
    const publicStreamUrl = preview
        ? `${routedStreamUrl}${routedStreamUrl.includes('?') ? '&' : '?'}preview=1`
        : routedStreamUrl;
    if (surface === 'v1' && !publicStreamUrl.startsWith(routeBase)) {
        logger.warn('streamUrl rewrite missed — external client may get unreachable URL', {
            streamUrl: streamInfo.streamUrl,
        });
    }

    let session: LiveTvPlaybackSession;
    let grant: MintedPlaybackGrant;
    let streamUrl: string;
    try {
        const sql = getDb();
        const deviceId =
            sql && locals.deviceSessionId
                ? await getDeviceIdForSession(
                      sql,
                      locals.user.userId,
                      locals.deviceSessionId,
                  ).catch(() => undefined)
                : undefined;
        const device =
            sql && deviceId
                ? await getUserDeviceByDeviceId(sql, locals.user.userId, deviceId).catch(
                      () => undefined,
                  )
                : undefined;
        session = await sessionService.startPlaybackSession({
            viewerKey,
            username,
            userId: locals.user.userId,
            deviceId: deviceId ?? undefined,
            deviceSessionId: locals.deviceSessionId,
            deviceName: device?.custom_name ?? device?.reported_name ?? undefined,
            clientName:
                surface === 'internal'
                    ? 'Lumastra Web'
                    : (device?.client_id ?? locals.principal?.clientId ?? undefined),
            userAgent: event.request.headers.get('user-agent') ?? undefined,
            stationId: station.stationId,
            feedId: channelId,
            sourceId: streamInfo.sourceId ?? channelId,
            adaptive: streamInfo.adaptive,
            variant: streamInfo.variant,
            rungId: streamInfo.rungId,
            appliedMaxHeight: streamInfo.appliedMaxHeight,
            appliedMaxBitrateBps: streamInfo.appliedMaxBitrateBps,
            kind: preview ? 'preview' : 'playback',
            ...(joined.feeds && joined.feeds.length > 0 ? { feeds: joined.feeds } : {}),
        });
        grant = await mintPlaybackGrant({
            kind: 'live',
            mediaId: station.stationId,
            playbackSessionId: session.sessionId,
            userId: locals.user.userId,
            clientIp: getClientIpStrictFromRequest(event.request, event.getClientAddress),
            deviceSessionId: locals.deviceSessionId,
            castTarget: input.castTarget,
            parentTokenHash:
                locals.authMethod === 'pat' && locals.accessToken
                    ? createHash('sha256').update(locals.accessToken).digest('hex')
                    : undefined,
            mintedByAdmin: locals.principal?.isAdmin === true,
            surface,
        });
        streamUrl = buildGrantedHref(grant, publicStreamUrl);
    } catch (error) {
        // Admission succeeded at the proxy, but there is no usable handle to give
        // the caller. Release that viewer immediately instead of leaking a slot.
        await getStreamProxyClient()
            .leaveChannel(channelId, viewerKey, event.request.signal)
            .catch(() => {});
        await sessionService
            .removeSessionIfChannel(viewerKey, streamInfo.sourceId ?? channelId, channelId)
            .catch(() => {});
        await sessionService
            .endViewerPlaybackSession(viewerKey, channelId, 'expired')
            .catch(() => {});
        throw error;
    }
    const sql = getDb();
    // A preview is not a watch. Awaited, not fire-and-forget: "one accepted start = one row" is then
    // true by the time the caller gets the 201, and a late background insert can no longer race
    // a table truncate/delete that follows (a CI deadlock in the integration shard).
    if (sql && !preview) {
        await recordChannelWatch(sql, locals.user.userId, channelId).catch((error: unknown) => {
            logger.warn('Failed to record accepted Live TV watch', { error: String(error) });
        });
    }
    return json(
        {
            playbackSessionId: session.sessionId,
            kind: 'live',
            stationId: station.stationId,
            purpose: preview ? 'preview' : 'playback',
            delivery: {
                kind: 'live-hls',
                url: streamUrl,
                feedId: channelId,
                requestedQuality: requestedQuality ?? 'server',
                appliedQuality: streamInfo.adaptive
                    ? 'adaptive'
                    : (streamInfo.rungId ?? 'original'),
                sourceId: streamInfo.sourceId,
                requiresProxy: streamInfo.requiresProxy,
                maxStreams: streamInfo.maxStreams,
                rungId: streamInfo.rungId,
                requestedMaxBitrateBps:
                    input.maxBitrateBps ??
                    (requestedQuality && requestedQuality !== 'server'
                        ? getLiveTvRung(requestedQuality)?.maxBitrate
                        : undefined) ??
                    streamInfo.requestedMaxBitrateBps,
                appliedMaxBitrateBps: streamInfo.appliedMaxBitrateBps,
                appliedMaxHeight: streamInfo.appliedMaxHeight,
                reason: !ladderEnabled ? 'ladder_disabled' : streamInfo.reason,
                adaptive: streamInfo.adaptive,
                variant: streamInfo.variant,
            },
            reporting: {
                kind: 'keepalive',
                method: 'POST',
                playbackSessionId: session.sessionId,
                href: apiUrl(surface, `/livetv/playback-sessions/${session.sessionId}/keepalive`),
                intervalMs: LIVETV_HEARTBEAT_INTERVAL_MS,
            },
            grant: {
                id: grant.id,
                token: grant.token,
                mediaId: grant.mediaId,
                playbackSessionId: grant.playbackSessionId,
                kind: grant.kind,
                param: grant.param,
                expiresAt: grant.expiresAt,
                renewAfter: grant.renewAfter,
                renewHref: grant.renewHref,
                ipPinned: grant.ipPinned,
            },
        },
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
}

export async function startPlayback(
    event: RequestEvent,
    surface: ApiSurface,
    input: z.infer<typeof PlaybackSessionStartSchema>,
): Promise<Response> {
    if (!getCoordinationClient())
        return ApiProblem.dependencyUnavailable('Live TV session store unavailable');
    if (!event.locals.user?.hasLiveTvPermission) return ApiProblem.notFound();
    try {
        const viewerKey = deriveLiveTvViewerKey(event, { preview: input.purpose === 'preview' });
        return await withPlaybackViewerLock(viewerKey, () =>
            startPlaybackUnlocked(event, surface, input, viewerKey),
        );
    } catch (error) {
        logger.warn('Playback session could not be started', { error });
        return ApiProblem.dependencyUnavailable('Live TV session could not be stored');
    }
}
