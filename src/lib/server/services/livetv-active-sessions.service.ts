// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { getOrComputeSingleFlight } from '../cache/single-flight.js';
import type { UserId } from '$lib/shared/user-id.js';
import { ApiProblem } from '../api/problem.js';
import { config } from '../config.js';
import { Logger } from '../utils/logger.js';
import { getLiveTvProvider } from './livetv/index.js';
import {
    listActiveLiveTvPlaybackSessions,
    type LiveTvPlaybackSession,
} from './livetv/livetv-session.service.js';
import { readStationNowNext, resolveStation } from './livetv/station.service.js';
import { getStreamProxyClient } from './livetv/stream-proxy-client.js';
import { resolveSessionAdaptive } from './adaptive-playback-state.service.js';
import { parseUserAgent, detectFormFactor } from '$lib/utils/user-agent.js';
import { getDb } from '../database/connection.js';
import { resolveUsernamesToUsers } from '../database/queries/users.queries.js';
import { foldUsername } from '$lib/shared/username-fold.js';
import type { StreamSession } from '../types.js';
import type { RequestEvent } from '@sveltejs/kit';
import { getLiveTvSessionService } from './livetv/livetv-session.service.js';
import { withPlaybackViewerLock } from './livetv/playback-session-lifecycle.js';
import { auditLog, auditActor } from '../utils/audit-log.js';

const logger = Logger.for('LiveTvActiveSessions');
let inventoryScope = '';
let inventorySnapshot: { at: number; sessions: LiveTvPlaybackSession[] } | null = null;

/** The ordinary Active Streams stop action also owns Live TV session teardown. */
export async function cancelLiveTvPlaybackSession(
    event: RequestEvent,
    id: string,
): Promise<Response | null> {
    if (config.LIVETV_SOURCE !== 'standalone' || !config.STREAM_PROXY_URL) return null;
    const service = getLiveTvSessionService();
    const session = await service.peekPlaybackSession(id).catch(() => undefined);
    if (session === undefined)
        return ApiProblem.dependencyUnavailable('Live TV session store unavailable');
    if (!session) return null;
    const user = event.locals.user;
    const owner = session.userId ? session.userId === user?.userId : false;
    let legacyOwner = false;
    if (!session.userId && user?.userId) {
        const sql = getDb();
        if (sql) {
            const identities = await resolveUsernamesToUsers(sql, [session.username]).catch(
                () => null,
            );
            if (!identities)
                return ApiProblem.dependencyUnavailable('Live TV ownership unavailable');
            legacyOwner = identities.get(foldUsername(session.username))?.id === user.userId;
        } else legacyOwner = session.username === user.username;
    }
    if (!owner && !legacyOwner && !(event.locals.principal?.isAdmin && user?.hasLiveTvPermission))
        return null;
    return withPlaybackViewerLock(
        session.viewerKey,
        async () => {
            if (await service.releasePlaybackSession(session)) {
                await getStreamProxyClient()
                    .leaveChannel(session.feedId, session.viewerKey)
                    .catch((error: unknown) => {
                        logger.warn('Stopped session but proxy leave failed', {
                            sessionId: id,
                            error: String(error),
                        });
                    });
                await service.removeSessionIfChannel(
                    session.viewerKey,
                    session.sourceId,
                    session.feedId,
                );
            }
            auditLog(
                owner || legacyOwner ? 'play_session.self_cancel' : 'play_session.cancel',
                id,
                auditActor(event),
            );
            return new Response(null, { status: 204 });
        },
        2000,
    );
}

/** Merge before privacy/access filtering; never expose proxy URLs or viewer credentials. */
export async function mergeLiveTvSessions(existing: StreamSession[]): Promise<StreamSession[]> {
    try {
        if (config.LIVETV_SOURCE !== 'standalone' || !config.STREAM_PROXY_URL) {
            inventorySnapshot = null;
            return existing;
        }
        const scope = createHash('sha256')
            .update(config.STREAM_PROXY_URL)
            .digest('hex')
            .slice(0, 20);
        if (scope !== inventoryScope) {
            inventorySnapshot = null;
            inventoryScope = scope;
        }
        // Shared across viewers. Privacy and capability filtering still runs per
        // viewer in ActiveSessionsView, after this unfiltered inventory is merged.
        const json = await getOrComputeSingleFlight({
            cacheKey: `sf:livetv-active-streams:v1:${scope}`,
            ttlSeconds: 2,
            lockTtlSeconds: 15,
            compute: async () => JSON.stringify(await buildLiveTvSessions(scope)),
        });
        const sessions = JSON.parse(json) as StreamSession[];
        const byId = new Map(sessions.map((row) => [row.playSessionId, row]));
        return [
            ...existing.filter((row) => {
                if (
                    row.mediaType !== 'tvchannel' ||
                    row.sessionSource !== 'lumastra' ||
                    !row.playSessionId
                )
                    return true;
                const live = byId.get(row.playSessionId);
                if (!live || row.mediaItemId !== live.mediaItemId) return true;
                const sameOwner =
                    row.userId && live.userId
                        ? row.userId === live.userId
                        : foldUsername(row.username) === foldUsername(live.username);
                return !sameOwner;
            }),
            ...sessions,
        ];
    } catch (error) {
        logger.warn('Live TV inventory unavailable', { error: String(error) });
        return existing;
    }
}

async function buildLiveTvSessions(scope: string): Promise<StreamSession[]> {
    const live = await listActiveLiveTvPlaybackSessions()
        .then((sessions) => {
            if (scope === inventoryScope) inventorySnapshot = { at: Date.now(), sessions };
            return sessions;
        })
        .catch((error: unknown) => {
            if (
                scope === inventoryScope &&
                inventorySnapshot &&
                Date.now() - inventorySnapshot.at < 30_000
            ) {
                logger.debug('Using recent Live TV inventory during a store outage');
                return inventorySnapshot.sessions;
            }
            throw error;
        });
    if (live.length === 0) return [];
    // Proxy failure must not erase viewers whose keepalives are still fresh.
    const status = await getStreamProxyClient()
        .getProxyStatus(AbortSignal.timeout(2500))
        .catch(() => null);
    const adaptive = await resolveSessionAdaptive(
        live.map((s) => ({
            sessionId: s.sessionId,
            username: s.username,
            mediaType: 'tvchannel',
            mediaId: s.feedId,
            deviceId: s.deviceId,
            viewerKey: s.viewerKey,
        })),
    );
    const sql = getDb();
    const identities: Awaited<ReturnType<typeof resolveUsernamesToUsers>> = sql
        ? await resolveUsernamesToUsers(
              sql,
              live.filter((s) => !s.userId).map((s) => s.username),
          ).catch(
              (): Awaited<ReturnType<typeof resolveUsernamesToUsers>> =>
                  new Map<string, { id: UserId; username: string }>(),
          )
        : new Map<string, { id: UserId; username: string }>();
    const provider = await getLiveTvProvider();
    const stationIds = [...new Set(live.map((s) => s.stationId))];
    const metadataEntries: Array<
        readonly [
            string,
            {
                channel: Awaited<ReturnType<typeof provider.getChannel>>;
                guide: Awaited<ReturnType<typeof readStationNowNext>> | null;
            },
        ]
    > = [];
    for (let offset = 0; offset < stationIds.length; offset += 16) {
        metadataEntries.push(
            ...(await Promise.all(
                stationIds.slice(offset, offset + 16).map(async (id) => {
                    const station = await resolveStation(id).catch(() => null);
                    const [channel, guide] = await Promise.all([
                        provider.getChannel(station?.shownFeedId ?? id).catch(() => undefined),
                        readStationNowNext(id).catch(() => null),
                    ]);
                    return [id, { channel, guide }] as const;
                }),
            )),
        );
    }
    const metadata = new Map(metadataEntries);
    const sessions: StreamSession[] = live
        .filter((s) => !status?.channels.find((c) => c.channelId === s.feedId)?.terminal)
        .map((s) => {
            const { channel, guide } = metadata.get(s.stationId)!;
            const proxy = status?.channels.find((c) => c.channelId === s.feedId);
            const current = guide?.current;
            const start = current ? Date.parse(current.startTime) : 0;
            const end = current ? Date.parse(current.endTime) : 0;
            const progress =
                end > start
                    ? Math.max(0, Math.min(100, ((Date.now() - start) / (end - start)) * 100))
                    : undefined;
            const abr = adaptive.get(s.sessionId);
            const probe = proxy?.probeResult;
            const qualityTranscode =
                s.variant === 'h264' || !!s.rungId || (!!abr?.current && !abr.current.original);
            const videoTranscoding =
                qualityTranscode || proxy?.transcodeDecision?.videoAction === 'transcode';
            const audioTranscoding =
                qualityTranscode || proxy?.transcodeDecision?.audioAction === 'transcode';
            const encoder = proxy?.transcodeDecision?.videoEncoder;
            const outputCodec = qualityTranscode
                ? 'h264'
                : videoTranscoding
                  ? encoder
                      ? encoder.includes('hevc') || encoder === 'libx265'
                          ? 'hevc'
                          : 'h264'
                      : undefined
                  : (probe?.videoCodec ?? undefined);
            const transcoding = videoTranscoding || audioTranscoding;
            return {
                __id: s.sessionId,
                id: s.stationId,
                mediaItemId: s.stationId,
                mediaType: 'tvchannel',
                title: channel?.name ?? proxy?.channelName ?? s.stationId,
                images: channel?.images,
                imageId: channel?.id,
                username: s.username,
                userId: s.userId ?? identities.get(foldUsername(s.username))?.id,
                playSessionId: s.sessionId,
                deviceId: s.deviceId,
                clientname: s.clientName ?? 'Lumastra',
                userAgent: s.userAgent,
                browsername:
                    s.deviceName ?? (s.userAgent ? parseUserAgent(s.userAgent) : s.clientName),
                formFactor: detectFormFactor(s.userAgent, s.clientName),
                sessionSource: 'lumastra',
                // A keepalive proves connection liveness, not play/pause state.
                isBuffering: proxy ? proxy.segmentCount === 0 : undefined,
                playMethod: transcoding ? 'Transcode' : 'DirectStream',
                playIsTranscoding: !!transcoding,
                playBitrate: abr?.current?.bitrate ?? s.appliedMaxBitrateBps ?? undefined,
                playOriginalCodec: probe?.videoCodec ?? undefined,
                playCodec: outputCodec,
                playTranscodeCodec: videoTranscoding ? outputCodec : undefined,
                playTranscodeAudioCodec: audioTranscoding ? 'aac' : undefined,
                playOriginalVideoWidth: probe?.width,
                playOriginalVideoHeight: probe?.height,
                playVideoHeight: abr?.current?.height ?? s.appliedMaxHeight ?? probe?.height,
                playVideoWidth: !videoTranscoding ? probe?.width : undefined,
                playOriginalAudioCodec: probe?.audioCodec ?? undefined,
                playOriginalVideoRange: probe ? (probe.hdr ? 'HDR' : 'SDR') : undefined,
                playVideoRange: qualityTranscode
                    ? 'SDR'
                    : videoTranscoding && probe?.hdr
                      ? undefined
                      : probe
                        ? probe.hdr
                            ? 'HDR'
                            : 'SDR'
                        : undefined,
                adaptive: abr,
                liveTvProgramName: current?.title,
                liveTvProgramDescription: current?.description,
                liveTvProgramStartTime: current?.startTime,
                liveTvProgramEndTime: current?.endTime,
                liveTvProgramProgressPercent:
                    progress === undefined ? undefined : Math.round(progress),

                streamProgress: progress,
                liveTvNextProgramName: guide?.next?.title,
                liveTvNextProgramStartTime: guide?.next?.startTime,
            };
        });
    return sessions;
}
