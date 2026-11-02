// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Sql } from 'postgres';
import { json, type RequestEvent } from '@sveltejs/kit';
import { ApiProblem, liveTvFailureProblem, problem } from '$lib/server/api/problem.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import {
    getLiveTvSessionService,
    listUserLiveTvResources,
    type LiveTvPlaybackSession,
    type PlaybackFailure,
} from './livetv-session.service.js';
import {
    failureFacts,
    translateFeedsTried,
    type StationFeedRef,
} from './livetv-failure-mapping.js';
import { isLiveTvFailureReason } from '../../../../shared/livetv-failure-reason.js';
import type { HeartbeatResponse } from '../../../../shared/livetv-proxy-types.js';
import { getStreamProxyClient } from './stream-proxy-client.js';
import { canReadLiveTvChannelStream } from './channel-access.js';
import { acquireLock, releaseLock } from '$lib/server/cache/valkey.js';

/** Serializes session start/leave, including same-feed replacement, across app instances. */
export async function withPlaybackViewerLock(
    viewerKey: string,
    action: () => Promise<Response>,
    /** Retry window for the lock; a leave beacon cannot retry itself, so it waits briefly. */
    waitMs = 0,
): Promise<Response> {
    const key = `livetv:v2:psess-lock:${viewerKey}`;
    let token: string | null;
    try {
        token = await acquireLock(key, 120);
        for (let waited = 0; !token && waited < waitMs; waited += 200) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            token = await acquireLock(key, 120);
        }
    } catch {
        return ApiProblem.dependencyUnavailable('Live TV session store unavailable');
    }
    if (!token)
        return problem('conflict', {
            reason: 'session_busy',
            error: 'Live TV session change in progress',
        });
    try {
        return await action();
    } catch {
        return ApiProblem.dependencyUnavailable('Live TV session store unavailable');
    } finally {
        await releaseLock(key, token).catch(() => false);
    }
}

export async function loadPlaybackSession(
    event: RequestEvent,
    /** A leave must still work after the viewer's Live TV permission was revoked mid-stream. */
    requirePermission = true,
): Promise<LiveTvPlaybackSession | Response | null> {
    if (!event.locals.user) return ApiProblem.unauthorized('Authentication required');
    if (requirePermission && !event.locals.user.hasLiveTvPermission) return ApiProblem.notFound();
    try {
        const session = await getLiveTvSessionService().getPlaybackSession(
            event.params.playbackSessionId!,
        );
        // A foreign session looks exactly like an unknown one.
        if (session && session.username !== event.locals.user.username) return null;
        return session;
    } catch {
        return ApiProblem.dependencyUnavailable('Live TV session store unavailable');
    }
}

/** The stored failure of a heartbeat the proxy answered for a failed channel. */
export function failureFromHeartbeat(
    result: HeartbeatResponse | undefined,
    now: Date = new Date(),
    /** The session's feeds in the order their URLs were sent to the proxy. */
    feeds: ReadonlyArray<StationFeedRef> = [],
): PlaybackFailure | undefined {
    const failure = result?.failure;
    if (!failure || !isLiveTvFailureReason(failure.reason)) return undefined;
    const facts = failureFacts(
        failure.reason,
        failure,
        translateFeedsTried(failure.feedsTried, feeds),
    );
    return {
        code: facts.reason,
        retryable: facts.retryable,
        ...(facts.retryAfterMs !== undefined ? { retryAfterMs: facts.retryAfterMs } : {}),
        at: now.toISOString(),
        ...(facts.feedsTried.length > 0 ? { feedsTried: facts.feedsTried } : {}),
    };
}

/** 410 for a session that ended because its channel failed; feedsTried for admins only. */
function failedSessionResponse(failure: PlaybackFailure, isAdmin: boolean): Response {
    return liveTvFailureProblem({
        reason: failure.code,
        retryable: failure.retryable,
        retryAfterMs: failure.retryAfterMs,
        feedsTried: failure.feedsTried,
        isAdmin,
        status: 410,
        error: 'playback_session_ended',
        detailReason: 'failed',
    });
}

export async function playbackKeepalive(event: RequestEvent): Promise<Response> {
    const session = await loadPlaybackSession(event);
    if (session instanceof Response) return session;
    if (!session) return problem('not_found', { reason: 'session_not_found' });
    const service = getLiveTvSessionService();
    // The eviction notification (and its reconnect guard) belongs to the session that was
    // evicted, so a delayed keepalive of a superseded/left session must not consume it.
    // A session that already ended `failed` may also carry the flag: the eviction wins over it.
    const mayConsume =
        session.state === 'active' ||
        session.endReason === 'evicted' ||
        session.endReason === 'failed';
    const kicked = mayConsume
        ? await service.consumeKicked(session.viewerKey, session.feedId)
        : { kicked: false as const };
    if (kicked.kicked) {
        await service.endPlaybackSession(session.sessionId, 'evicted').catch(() => {});
    }
    // An evicted viewer is never told "retry": the eviction answer comes before a stored failure.
    if (kicked.kicked) {
        return problem('gone', {
            error: 'playback_session_ended',
            reason: 'evicted',
            details: kicked.reason,
        });
    }
    if (session.state === 'ended' && session.endReason === 'failed' && session.failure) {
        return failedSessionResponse(session.failure, localsIsAdmin(event.locals));
    }
    if (session.state === 'ended') {
        return problem('gone', {
            error: 'playback_session_ended',
            reason: session.endReason ?? 'evicted',
        });
    }
    if (!(await canReadLiveTvChannelStream(event.locals, session.feedId)))
        return ApiProblem.notFound('Station not found');
    try {
        const result = await getStreamProxyClient().heartbeat(
            session.feedId,
            session.viewerKey,
            event.request.signal,
        );
        if (!result?.success) {
            const failure = failureFromHeartbeat(result, new Date(), session.feeds);
            if (failure) {
                await service
                    .endPlaybackSession(session.sessionId, 'failed', failure)
                    .catch(() => {});
                // The channel is dead: free the viewer's slot now. A client that gets this 410 does not
                // call leave on an ended session, so nothing else would release it before the orphan sweep.
                await getStreamProxyClient()
                    .leaveChannel(session.feedId, session.viewerKey, event.request.signal)
                    .catch(() => {});
                await service
                    .removeSessionIfChannel(session.viewerKey, session.sourceId, session.feedId)
                    .catch(() => {});
                return failedSessionResponse(failure, localsIsAdmin(event.locals));
            }
            await service.endPlaybackSession(session.sessionId, 'expired').catch(() => {});
            return problem('not_found', { reason: 'session_expired' });
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes('Proxy 404')) {
            await service.endPlaybackSession(session.sessionId, 'expired').catch(() => {});
            return problem('not_found', { reason: 'session_expired' });
        }
        return ApiProblem.dependencyUnavailable('Stream proxy unavailable');
    }
    // A successful proxy heartbeat remains successful during a transient Valkey failure.
    await service.refreshPlaybackSession(session).catch(() => {});
    return new Response(null, { status: 204 });
}

export async function playbackLeave(event: RequestEvent): Promise<Response> {
    const session = await loadPlaybackSession(event, false);
    if (session instanceof Response) return session;
    if (!session || session.state === 'ended') return new Response(null, { status: 204 });
    return withPlaybackViewerLock(
        session.viewerKey,
        async () => {
            const service = getLiveTvSessionService();
            // Only the current session may release proxy presence. The pointer protects a
            // newer session even when it selected the same feed as this delayed leave.
            if (await service.releasePlaybackSession(session)) {
                const presence = await service.getSession(session.viewerKey);
                try {
                    await getStreamProxyClient().leaveChannel(
                        session.feedId,
                        session.viewerKey,
                        event.request.signal,
                    );
                } catch {
                    /* Presence cleanup still runs if the proxy is unavailable. */
                }
                await service.removeSessionIfChannel(
                    session.viewerKey,
                    presence?.sourceId ?? session.sourceId,
                    session.feedId,
                );
            }
            return new Response(null, { status: 204 });
        },
        // A beacon cannot retry a 409, so wait out a concurrent start.
        2000,
    );
}

export async function playbackState(event: RequestEvent): Promise<Response> {
    const session = await loadPlaybackSession(event);
    if (session instanceof Response) return session;
    if (!session) return problem('not_found', { reason: 'session_not_found' });
    const { sessionId, stationId, feedId, state, endReason, adaptive, variant } = session;
    const failure =
        endReason === 'failed' && session.failure
            ? {
                  code: session.failure.code,
                  retryable: session.failure.retryable,
                  ...(session.failure.retryAfterMs !== undefined
                      ? { retryAfterMs: session.failure.retryAfterMs }
                      : {}),
                  at: session.failure.at,
              }
            : undefined;
    return json(
        {
            playbackSessionId: sessionId,
            stationId,
            feedId,
            purpose: session.kind ?? 'playback',
            state,
            endReason,
            failure,
            adaptive,
            variant,
        },
        { headers: { 'Cache-Control': 'no-store' } },
    );
}

/** Explicit permission revocation releases resources now, rather than waiting for keepalive expiry.
 * Keep presence on a failed proxy leave so repeating the off write can retry cleanup.
 */
export async function revokeUserLiveTvPlayback(sql: Sql, username: string): Promise<void> {
    const { revokeLiveGrantsForUser } = await import('../playback-grant.js');
    const results = await Promise.allSettled([
        revokeLiveGrantsForUser(sql, username),
        (async () => {
            const resources = await listUserLiveTvResources(username);
            const service = getLiveTvSessionService();
            const viewers = new Map(
                resources.viewers.map((entry) => [`${entry.viewerKey}:${entry.channelId}`, entry]),
            );
            for (const session of resources.playback) {
                await service.releasePlaybackSession(session);
                viewers.set(`${session.viewerKey}:${session.feedId}`, {
                    viewerKey: session.viewerKey,
                    username,
                    channelId: session.feedId,
                    sourceId: session.sourceId,
                    startedAt: session.startedAt,
                    priority: 'low',
                });
            }
            const cleanup = await Promise.allSettled(
                [...viewers.values()].map(async (entry) => {
                    const response = await withPlaybackViewerLock(
                        entry.viewerKey,
                        async () => {
                            const left = await getStreamProxyClient().leaveChannel(
                                entry.channelId,
                                entry.viewerKey,
                                undefined,
                                { immediate: true },
                            );
                            if (!left.success) throw new Error('Live TV cleanup incomplete');
                            await service.removeSessionIfChannel(
                                entry.viewerKey,
                                entry.sourceId,
                                entry.channelId,
                            );
                            return new Response(null, { status: 204 });
                        },
                        2000,
                    );
                    if (response.status !== 204) throw new Error('Live TV cleanup incomplete');
                }),
            );
            if (cleanup.some((result) => result.status === 'rejected'))
                throw new Error('Live TV cleanup incomplete');
        })(),
    ]);
    if (results.some((result) => result.status === 'rejected'))
        throw new Error('Live TV cleanup incomplete');
}
