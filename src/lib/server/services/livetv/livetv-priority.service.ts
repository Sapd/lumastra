// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { acquireLock, releaseLock } from '$lib/server/cache/valkey';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger.js';
import type { LiveTvSessionEntry, LiveTvSessionService } from './livetv-session.service';
import type { StreamProxyClient } from './stream-proxy-client';
import { getStreamProxyClient } from './stream-proxy-client';
import { getLiveTvSessionService } from './livetv-session.service';

const logger = Logger.for('LiveTvPriorityService');

/** A viewer removed from the proxy to free a slot; flagged kicked once the newcomer got it. */
export interface EvictedViewer {
    sessionId?: string;
    viewerKey: string;
    channelId: string;
}

export type PriorityEnforcementResult =
    { allowed: true; kickedViewer?: string; evicted?: EvictedViewer[] } | { allowed: false };

export interface LiveTvPriorityService {
    checkAndEnforcePriority(
        viewerKey: string,
        priority: 'high' | 'low',
        channelId: string,
        sourceId: string,
        maxStreams: number,
    ): Promise<PriorityEnforcementResult>;
    /**
     * Flags the evicted viewers kicked (410 on their next keepalive or join of the channel
     * they lost). Call only after the newcomer's retry join succeeded: a failed retry
     * must not leave the evicted viewers locked out of a channel nobody took over.
     */
    confirmEviction(evicted: readonly EvictedViewer[]): Promise<void>;
}

export function createLiveTvPriorityService(
    sessionService: LiveTvSessionService,
    proxyClient: Pick<StreamProxyClient, 'leaveChannel'> &
        Partial<Pick<StreamProxyClient, 'getProxyStatus'>>,
): LiveTvPriorityService {
    return {
        async checkAndEnforcePriority(viewerKey, priority, channelId, sourceId, maxStreams) {
            const lockKey = `livetv:v1:priority-lock:${sourceId}`;
            const lockToken = await acquireLock(lockKey, 5); // 5 seconds
            if (!lockToken) {
                logger.warn('livetv-priority: could not acquire lock', {
                    viewerKey,
                    sourceId,
                });
                return { allowed: false };
            }

            try {
                const viewers = await sessionService.getSourceViewers(sourceId);

                // Count unique channels EXCLUDING the requested channel (same channel = shared slot)
                const otherChannels = new Set(
                    viewers.filter((v) => v.channelId !== channelId).map((v) => v.channelId),
                );

                if (priority === 'low') {
                    return { allowed: otherChannels.size < maxStreams };
                }

                // The proxy, not Valkey, decides whether a slot is free: it refused this
                // join, so ask it which channels hold the source's slots and how many
                // viewers each has. Without its answer nobody is evicted: the sessions
                // alone cannot tell a protected viewer from a low one.
                const proxyChannels = await liveChannelsOnSource(proxyClient, sourceId);
                if (!proxyChannels) {
                    logger.warn('livetv-priority: no eviction without proxy status', {
                        viewerKey,
                        sourceId,
                        channelId,
                    });
                    return { allowed: false };
                }
                // A channel nobody watches any more (in its grace period) is reclaimed by
                // the proxy on the retry, so it does not count as taken.
                const slotsInUse = [...proxyChannels].filter(
                    ([id, n]) => id !== channelId && n > 0,
                ).length;
                if (slotsInUse < maxStreams) {
                    // A slot is (or came) free: the retry gets it.
                    return { allowed: true };
                }

                const victims = pickVictimChannel(
                    viewers,
                    channelId,
                    proxyChannels,
                    config.LIVETV_KICK_POLICY,
                );
                if (!victims) {
                    return { allowed: false };
                }

                // Capture handles before the proxy leaves: confirmation must end the
                // victim, even if that viewer starts a replacement before the retry.
                const playbackVictims = await Promise.all(
                    victims.map(async (victim) => {
                        try {
                            return await sessionService.getViewerPlaybackSession(victim.viewerKey);
                        } catch {
                            return null;
                        }
                    }),
                );

                // Free the slot on the proxy BEFORE releasing the lock. A channel's slot is
                // only free once its LAST viewer is gone, so every viewer on it leaves.
                const leaves = await Promise.allSettled(
                    victims.map((victim) =>
                        proxyClient.leaveChannel(victim.channelId, victim.viewerKey),
                    ),
                );
                const left: LiveTvSessionEntry[] = [];
                for (const [i, leave] of leaves.entries()) {
                    if (leave.status === 'rejected') {
                        logger.warn('livetv-priority: proxy leave failed during eviction', {
                            victim: victims[i].username,
                            channelId: victims[i].channelId,
                            error: String(leave.reason),
                        });
                    } else {
                        left.push(victims[i]);
                    }
                }

                // Only viewers the proxy let go lose their session; a viewer whose leave
                // failed is still on the proxy and keeps its session.
                await Promise.allSettled(
                    left.map((victim) => sessionService.removeSession(victim.viewerKey, sourceId)),
                );

                if (left.length < victims.length) {
                    // The channel still holds a viewer, so the slot is still taken.
                    logger.warn('livetv-priority: eviction did not free the slot', {
                        viewerKey,
                        sourceId,
                        victimChannelId: victims[0].channelId,
                        left: left.length,
                        victims: victims.length,
                    });
                    return { allowed: false };
                }

                logger.info('livetv-priority: evicted low-priority viewer', {
                    viewerKey,
                    victim: victims.map((v) => v.username).join(','),
                    victimChannelId: victims[0].channelId,
                    channelId,
                });
                return {
                    allowed: true,
                    kickedViewer: victims[0].username,
                    evicted: victims.map((v, index) => ({
                        ...(playbackVictims[index]?.feedId === v.channelId
                            ? { sessionId: playbackVictims[index].sessionId }
                            : {}),
                        viewerKey: v.viewerKey,
                        channelId: v.channelId,
                    })),
                };
            } finally {
                await releaseLock(lockKey, lockToken);
            }
        },

        async confirmEviction(evicted) {
            await Promise.allSettled(
                evicted.map(async (victim) => {
                    await (
                        victim.sessionId
                            ? sessionService.endPlaybackSession(victim.sessionId, 'evicted')
                            : sessionService.endViewerPlaybackSession(
                                  victim.viewerKey,
                                  victim.channelId,
                                  'evicted',
                              )
                    ).catch((error: unknown) => {
                        logger.warn('Failed to mark evicted playback session', {
                            error: String(error),
                        });
                    });
                    await sessionService.markKicked(
                        victim.viewerKey,
                        'higher_priority_viewer',
                        victim.channelId,
                    );
                }),
            );
        },
    };
}

/** Viewer count per channel holding a slot on `sourceId`, per the proxy; null when unknown. */
async function liveChannelsOnSource(
    proxyClient: Partial<Pick<StreamProxyClient, 'getProxyStatus'>>,
    sourceId: string,
): Promise<Map<string, number> | null> {
    if (!proxyClient.getProxyStatus) return null;
    try {
        // Bounded: this runs while the source's priority lock is held.
        const status = await proxyClient.getProxyStatus(AbortSignal.timeout(2_000));
        if (!Array.isArray(status?.channels)) return null;
        return new Map(
            status.channels
                .filter((c) => c.sourceId === sourceId)
                .map((c) => [c.channelId, c.viewers]),
        );
    } catch (err) {
        logger.warn('livetv-priority: proxy status unavailable', {
            sourceId,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * The viewers whose eviction frees one slot, or null when no slot can be freed.
 *
 * A slot belongs to a CHANNEL, so it is only freed when every viewer on that channel
 * leaves. A channel qualifies when all its viewers are low priority and, when the proxy
 * reported its viewer count, the sessions account for all of them (a viewer we cannot
 * see might be high priority). Evicting one viewer of a channel that keeps another
 * would cut that viewer off and still leave the newcomer without a slot.
 *
 * No proxy view (`proxyChannels` null) means no victim.
 *
 * Policy: `shortest` takes the channel watched for the shortest time (its earliest
 * session started most recently), `longest` the one watched longest.
 */
export function pickVictimChannel(
    viewers: readonly LiveTvSessionEntry[],
    channelId: string,
    proxyChannels: ReadonlyMap<string, number> | null,
    kickPolicy: string,
): LiveTvSessionEntry[] | null {
    // Without the proxy's view a viewer we hold no session for could be protected.
    if (!proxyChannels) return null;
    const byChannel = new Map<string, LiveTvSessionEntry[]>();
    for (const v of viewers) {
        if (v.channelId === channelId) continue;
        const list = byChannel.get(v.channelId) ?? [];
        list.push(v);
        byChannel.set(v.channelId, list);
    }
    const candidates = [...byChannel.entries()]
        .filter(([id, list]) => {
            if (list.some((v) => v.priority !== 'low')) return false;
            const proxyViewers = proxyChannels.get(id);
            // Not on the proxy any more, or in its grace period: evicting it frees nothing
            // (the proxy reclaims a grace slot on its own).
            if (proxyViewers === undefined || proxyViewers === 0) return false;
            return proxyViewers <= list.length;
        })
        .map(([, list]) => ({
            list,
            // A missing start time counts as the oldest, so it never reads as newly started.
            since: Math.min(...list.map((v) => (Number.isFinite(v.startedAt) ? v.startedAt : 0))),
        }));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (kickPolicy === 'shortest' ? b.since - a.since : a.since - b.since));
    return candidates[0].list;
}

let _instance: LiveTvPriorityService | null = null;
export function getLiveTvPriorityService(): LiveTvPriorityService {
    _instance ??= createLiveTvPriorityService(getLiveTvSessionService(), getStreamProxyClient());
    return _instance;
}
