// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/cache/valkey', () => ({
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
}));
vi.mock('$lib/server/config', () => ({
    config: { LIVETV_KICK_POLICY: 'shortest' },
}));

import { acquireLock, releaseLock } from '$lib/server/cache/valkey';
import type { LiveTvSessionEntry, LiveTvSessionService } from './livetv-session.service';
import { createLiveTvPriorityService, pickVictimChannel } from './livetv-priority.service';

const makeMockSessionService = (): LiveTvSessionService => ({
    startPlaybackSession: vi.fn(),
    getPlaybackSession: vi.fn(),
    peekPlaybackSession: vi.fn(),
    getViewerPlaybackSession: vi.fn(),
    endPlaybackSession: vi.fn(),
    endViewerPlaybackSession: vi.fn().mockResolvedValue(undefined),
    releasePlaybackSession: vi.fn(),
    refreshPlaybackSession: vi.fn(),
    registerSession: vi.fn(),
    refreshSession: vi.fn().mockResolvedValue(true),
    removeSession: vi.fn(),
    removeSessionIfChannel: vi.fn().mockResolvedValue(true),
    getSession: vi.fn().mockResolvedValue(null),
    getSourceViewers: vi.fn().mockResolvedValue([]),
    markKicked: vi.fn(),
    checkKicked: vi.fn().mockResolvedValue({ kicked: false }),
    consumeKicked: vi.fn().mockResolvedValue({ kicked: false }),
    clearKicked: vi.fn(),
});

// The proxy reports every session the test registered, one channel per viewer group, so a
// test only has to describe the sessions. Tests about the proxy's own view override it.
const makeMockProxy = (sessions: LiveTvSessionService) => ({
    leaveChannel: vi.fn().mockResolvedValue(undefined),
    getProxyStatus: vi.fn().mockImplementation(async () => {
        const viewers = await sessions.getSourceViewers('src1');
        const counts = new Map<string, number>();
        for (const v of viewers) counts.set(v.channelId, (counts.get(v.channelId) ?? 0) + 1);
        return {
            channels: [...counts].map(([channelId, n]) => ({
                channelId,
                sourceId: 'src1',
                viewers: n,
            })),
        };
    }),
});

function viewer(
    viewerKey: string,
    channelId: string,
    priority: 'high' | 'low',
    startedAt: number,
): LiveTvSessionEntry {
    return {
        viewerKey,
        username: viewerKey.split(':')[0],
        channelId,
        sourceId: 'src1',
        priority,
        startedAt,
    };
}

describe('LiveTvPriorityService', () => {
    it('confirms the captured victim handle rather than ending a replacement session', async () => {
        const sessions = makeMockSessionService();
        vi.mocked(sessions.endPlaybackSession).mockResolvedValue(undefined);
        const service = createLiveTvPriorityService(sessions, makeMockProxy(sessions) as never);
        await service.confirmEviction([
            { sessionId: 'victim-session', viewerKey: 'alice:device:a', channelId: 'feed' },
        ]);
        expect(sessions.endPlaybackSession).toHaveBeenCalledWith('victim-session', 'evicted');
        expect(sessions.endViewerPlaybackSession).not.toHaveBeenCalled();
        expect(sessions.markKicked).toHaveBeenCalledWith(
            'alice:device:a',
            'higher_priority_viewer',
            'feed',
        );
    });

    let sessions: ReturnType<typeof makeMockSessionService>;
    let proxy: ReturnType<typeof makeMockProxy>;

    beforeEach(() => {
        sessions = makeMockSessionService();
        proxy = makeMockProxy(sessions);
        vi.mocked(acquireLock).mockResolvedValue('lock-token');
        vi.mocked(releaseLock).mockResolvedValue(true);
    });

    it('allows join when under limit', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            {
                viewerKey: 'alice:device:a',
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 1000,
            },
        ]);
        // maxStreams=2, 1 unique channel in use → allowed
        const result = await service.checkAndEnforcePriority('bob', 'low', 'ch2', 'src1', 2);
        expect(result.allowed).toBe(true);
        expect(proxy.leaveChannel).not.toHaveBeenCalled();
    });

    it('blocks low-priority when at limit', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            {
                viewerKey: 'alice:device:a',
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 1000,
            },
            {
                viewerKey: 'bob:device:b',
                username: 'bob',
                channelId: 'ch2',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 2000,
            },
        ]);
        // maxStreams=2, 2 unique channels → at limit, new user is low priority
        const result = await service.checkAndEnforcePriority('carol', 'low', 'ch3', 'src1', 2);
        expect(result.allowed).toBe(false);
        expect(proxy.leaveChannel).not.toHaveBeenCalled();
    });

    it('high-priority evicts every low-priority viewer of the channel it takes the slot from', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            {
                viewerKey: 'alice:device:a',
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'high',
                startedAt: 1000,
            },
            {
                viewerKey: 'bob:device:b',
                username: 'bob',
                channelId: 'ch2',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 3000,
            }, // shortest
            {
                viewerKey: 'carol:device:c',
                username: 'carol',
                channelId: 'ch2',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 2000,
            }, // longer
        ]);
        // maxStreams=2, 2 unique channels at limit, new high-priority user wants ch3
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 2);
        expect(result.allowed).toBe(true);
        if (!result.allowed) return;
        expect(result.kickedViewer).toBe('bob');
        // The slot is ch2's: it is only free once BOTH of its viewers have left.
        expect(proxy.leaveChannel).toHaveBeenCalledWith('ch2', 'bob:device:b');
        expect(proxy.leaveChannel).toHaveBeenCalledWith('ch2', 'carol:device:c');
        expect(result.evicted).toEqual([
            { viewerKey: 'bob:device:b', channelId: 'ch2' },
            { viewerKey: 'carol:device:c', channelId: 'ch2' },
        ]);
        // Nobody is flagged kicked until the newcomer's retry join succeeded.
        expect(sessions.markKicked).not.toHaveBeenCalled();
        await service.confirmEviction(result.evicted!);
        expect(sessions.markKicked).toHaveBeenCalledWith(
            'bob:device:b',
            'higher_priority_viewer',
            'ch2',
        );
        expect(sessions.markKicked).toHaveBeenCalledWith(
            'carol:device:c',
            'higher_priority_viewer',
            'ch2',
        );
        expect(proxy.leaveChannel).not.toHaveBeenCalledWith('ch1', expect.anything());
    });

    it('same channel does not count as extra slot', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            {
                viewerKey: 'alice:device:a',
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 1000,
            },
            {
                viewerKey: 'bob:device:b',
                username: 'bob',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 2000,
            },
        ]);
        // maxStreams=1, both watching ch1 (same slot) → new viewer on ch1 = still 1 slot
        const result = await service.checkAndEnforcePriority('carol', 'low', 'ch1', 'src1', 1);
        expect(result.allowed).toBe(true);
        expect(proxy.leaveChannel).not.toHaveBeenCalled();
    });

    it('high-priority cannot kick when all low-priority are on the same channel', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            {
                viewerKey: 'alice:device:a',
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 1000,
            },
            {
                viewerKey: 'bob:device:b',
                username: 'bob',
                channelId: 'ch2',
                sourceId: 'src1',
                priority: 'high',
                startedAt: 2000,
            },
        ]);
        // maxStreams=2, both channels used, alice is low but on ch1, dave wants ch3
        // alice is on ch1 (different from ch3) → she IS kickable
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 2);
        expect(result.allowed).toBe(true);
        if (!result.allowed) return;
        expect(result.kickedViewer).toBe('alice');
    });

    it('high-priority cannot kick when no low-priority viewers exist', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            {
                viewerKey: 'alice:device:a',
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'high',
                startedAt: 1000,
            },
            {
                viewerKey: 'bob:device:b',
                username: 'bob',
                channelId: 'ch2',
                sourceId: 'src1',
                priority: 'high',
                startedAt: 2000,
            },
        ]);
        const result = await service.checkAndEnforcePriority('carol', 'high', 'ch3', 'src1', 2);
        expect(result.allowed).toBe(false);
    });

    it('never evicts a low-priority viewer sharing a channel with a high-priority one', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            viewer('alice:device:a', 'ch1', 'high', 1000),
            viewer('bob:device:b', 'ch1', 'low', 2000),
        ]);
        // Kicking bob would leave alice on ch1 — the slot stays taken.
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 1);
        expect(result.allowed).toBe(false);
        expect(proxy.leaveChannel).not.toHaveBeenCalled();
        expect(sessions.markKicked).not.toHaveBeenCalled();
    });

    it('shortest policy takes the channel watched for the shortest time', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            viewer('alice:device:a', 'ch1', 'low', 1000),
            // ch2's viewers: one joined late, but the channel has been watched since 500
            viewer('bob:device:b', 'ch2', 'low', 500),
            viewer('carol:device:c', 'ch2', 'low', 9000),
        ]);
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 2);
        expect(result).toMatchObject({ allowed: true, kickedViewer: 'alice' });
        expect(proxy.leaveChannel).toHaveBeenCalledTimes(1);
        expect(proxy.leaveChannel).toHaveBeenCalledWith('ch1', 'alice:device:a');
    });

    it('skips a channel whose proxy viewer count exceeds the sessions it knows', async () => {
        const proxyWithStatus = {
            ...proxy,
            getProxyStatus: vi.fn().mockResolvedValue({
                channels: [
                    { channelId: 'ch1', sourceId: 'src1', viewers: 2 },
                    { channelId: 'ch2', sourceId: 'src1', viewers: 1 },
                ],
            }),
        };
        const service = createLiveTvPriorityService(sessions, proxyWithStatus as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            // ch1 has a second viewer without a session — maybe high priority
            viewer('alice:device:a', 'ch1', 'low', 9000),
            viewer('bob:device:b', 'ch2', 'low', 1000),
        ]);
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 2);
        expect(result).toMatchObject({ allowed: true, kickedViewer: 'bob' });
        expect(proxyWithStatus.leaveChannel).toHaveBeenCalledWith('ch2', 'bob:device:b');
        expect(proxyWithStatus.leaveChannel).not.toHaveBeenCalledWith('ch1', expect.anything());
    });

    it('evicts nobody when the proxy shows a slot free (a channel in its grace period)', async () => {
        const proxyWithStatus = {
            ...proxy,
            getProxyStatus: vi.fn().mockResolvedValue({
                channels: [{ channelId: 'ch1', sourceId: 'src1', viewers: 0 }],
            }),
        };
        const service = createLiveTvPriorityService(sessions, proxyWithStatus as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            viewer('alice:device:a', 'ch1', 'low', 1000),
        ]);
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 1);
        expect(result).toEqual({ allowed: true });
        expect(proxyWithStatus.leaveChannel).not.toHaveBeenCalled();
    });

    it('evicts nobody when the proxy holds the slot for viewers it has no session for', async () => {
        const proxyWithStatus = {
            ...proxy,
            getProxyStatus: vi.fn().mockResolvedValue({
                channels: [{ channelId: 'ch9', sourceId: 'src1', viewers: 1 }],
            }),
        };
        const service = createLiveTvPriorityService(sessions, proxyWithStatus as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([]);
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 1);
        expect(result).toEqual({ allowed: false });
        expect(proxyWithStatus.leaveChannel).not.toHaveBeenCalled();
    });

    it('evicts nobody when the proxy status call fails', async () => {
        const proxyWithStatus = {
            ...proxy,
            getProxyStatus: vi.fn().mockRejectedValue(new Error('Proxy 503')),
        };
        const service = createLiveTvPriorityService(sessions, proxyWithStatus as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            viewer('alice:device:a', 'ch1', 'low', 1000),
        ]);
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 1);
        expect(result).toEqual({ allowed: false });
        expect(proxyWithStatus.leaveChannel).not.toHaveBeenCalled();
        expect(sessions.removeSession).not.toHaveBeenCalled();
    });

    it('evicts nobody when the proxy client has no status call', async () => {
        const service = createLiveTvPriorityService(sessions, {
            leaveChannel: proxy.leaveChannel,
        } as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            viewer('alice:device:a', 'ch1', 'low', 1000),
        ]);
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 1);
        expect(result).toEqual({ allowed: false });
        expect(proxy.leaveChannel).not.toHaveBeenCalled();
    });

    it('does not free a slot, kick or remove anyone when every proxy leave fails', async () => {
        vi.mocked(proxy.leaveChannel).mockRejectedValue(new Error('Proxy 502'));
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            viewer('alice:device:a', 'ch1', 'low', 1000),
            viewer('bob:device:b', 'ch1', 'low', 2000),
        ]);
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 1);
        expect(result).toEqual({ allowed: false });
        expect(sessions.removeSession).not.toHaveBeenCalled();
        expect(sessions.markKicked).not.toHaveBeenCalled();
    });

    it('keeps the session of a viewer whose leave failed and refuses the newcomer', async () => {
        vi.mocked(proxy.leaveChannel)
            .mockRejectedValueOnce(new Error('Proxy 502'))
            .mockResolvedValueOnce(undefined as never);
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            viewer('alice:device:a', 'ch1', 'low', 1000),
            viewer('bob:device:b', 'ch1', 'low', 2000),
        ]);
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 1);
        // ch1 still holds alice on the proxy: its slot is not free.
        expect(result).toEqual({ allowed: false });
        expect(sessions.removeSession).toHaveBeenCalledTimes(1);
        expect(sessions.removeSession).toHaveBeenCalledWith('bob:device:b', 'src1');
        expect(sessions.markKicked).not.toHaveBeenCalled();
    });

    it('flags nobody kicked during enforcement, only on confirmEviction', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(sessions.getSourceViewers).mockResolvedValue([
            viewer('alice:device:a', 'ch1', 'low', 1000),
        ]);
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 1);
        expect(result.allowed).toBe(true);
        expect(proxy.leaveChannel).toHaveBeenCalledWith('ch1', 'alice:device:a');
        expect(sessions.removeSession).toHaveBeenCalledWith('alice:device:a', 'src1');
        expect(sessions.markKicked).not.toHaveBeenCalled();
    });

    it('returns not_allowed if lock cannot be acquired', async () => {
        const service = createLiveTvPriorityService(sessions, proxy as never);
        vi.mocked(acquireLock).mockResolvedValue(null); // lock contention
        const result = await service.checkAndEnforcePriority('dave', 'high', 'ch3', 'src1', 2);
        expect(result.allowed).toBe(false);
    });
});

describe('pickVictimChannel', () => {
    const proxyChannels = new Map([
        ['ch1', 1],
        ['ch2', 1],
    ]);

    it('returns null without the proxy view', () => {
        const viewers = [viewer('alice:device:a', 'ch1', 'low', 1000)];
        expect(pickVictimChannel(viewers, 'ch3', null, 'shortest')).toBeNull();
    });

    it('treats a missing startedAt as the oldest, not the newest', () => {
        const broken = {
            ...viewer('alice:device:a', 'ch1', 'low', 0),
            startedAt: undefined as unknown as number,
        };
        const viewers = [broken, viewer('bob:device:b', 'ch2', 'low', 5000)];
        // shortest watched = bob; the viewer with no start time must not look "new"
        expect(pickVictimChannel(viewers, 'ch3', proxyChannels, 'shortest')?.[0].viewerKey).toBe(
            'bob:device:b',
        );
        expect(pickVictimChannel(viewers, 'ch3', proxyChannels, 'longest')?.[0].viewerKey).toBe(
            'alice:device:a',
        );
    });
});
