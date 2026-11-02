// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the valkey module before importing the service
const mockGetValkeyClient = vi.hoisted(() => vi.fn());
const scan = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const revoke = vi.hoisted(() => vi.fn().mockResolvedValue(1));
vi.mock('../playback-grant.js', () => ({ revokeGrantsForPlaySession: revoke }));
vi.mock('$lib/server/cache/valkey', () => ({
    scanKeysOrThrow: scan,
    getValkeyClient: mockGetValkeyClient,
    getCoordinationClient: mockGetValkeyClient,
}));
vi.mock('$lib/server/config', () => ({
    config: {
        LIVETV_VIEWER_TIMEOUT_SECONDS: 30,
        LIVETV_GRACE_PERIOD_SECONDS: 30,
    },
}));

import { getValkeyClient } from '$lib/server/cache/valkey';
import {
    createLiveTvSessionService,
    listActiveLiveTvPlaybackSessions,
    listUserLiveTvResources,
} from './livetv-session.service';

describe('LiveTvSessionService', () => {
    let mockClient: Record<string, ReturnType<typeof vi.fn>>;
    let service: ReturnType<typeof createLiveTvSessionService>;

    beforeEach(() => {
        revoke.mockClear();
        scan.mockReset();
        mockClient = {
            ttl: vi.fn().mockResolvedValue(120),
            set: vi.fn().mockResolvedValue('OK'),
            get: vi.fn().mockResolvedValue(null),
            del: vi.fn().mockResolvedValue(1),
            sadd: vi.fn().mockResolvedValue(1),
            srem: vi.fn().mockResolvedValue(1),
            smembers: vi.fn().mockResolvedValue([]),
            expire: vi.fn().mockResolvedValue(1),
            getdel: vi.fn().mockResolvedValue(null),
            customCommand: vi.fn().mockResolvedValue(1),
        };
        vi.mocked(getValkeyClient).mockReturnValue(mockClient as never);
        service = createLiveTvSessionService();
    });

    it('lists only live current playback pointers, without refreshing their leases', async () => {
        const rows = ['watching', 'preview', 'ended', 'old', 'abandoned'].map((id) => ({
            sessionId: id,
            viewerKey: `alice:${id}`,
            username: 'alice',
            stationId: 'station',
            feedId: 'feed',
            sourceId: 'source',
            startedAt: 1,
            state: id === 'ended' ? 'ended' : 'active',
            kind: id === 'preview' ? 'preview' : 'playback',
        }));
        scan.mockResolvedValue([
            ...rows.map((s) => `livetv:v2:viewer-psess:${s.viewerKey}`),
            `livetv:v2:viewer-psess:${rows[0].viewerKey}`,
        ]);
        mockClient.get.mockImplementation(async (key: string) => {
            if (key.startsWith('livetv:v2:psess:'))
                return key.endsWith(':replacement')
                    ? null
                    : JSON.stringify(rows.find((s) => key.endsWith(`:${s.sessionId}`)));
            const row = rows.find((s) => key.endsWith(s.viewerKey));
            return row?.sessionId === 'old' ? 'replacement' : row?.sessionId;
        });
        mockClient.ttl.mockImplementation(async (key: string) =>
            key.endsWith(':abandoned') ? 50 : 115,
        );
        expect((await listActiveLiveTvPlaybackSessions()).map((s) => s.sessionId)).toEqual([
            'watching',
        ]);
        expect(scan).toHaveBeenCalledWith('livetv:v2:viewer-psess:*', Infinity);
        expect(mockClient.expire).not.toHaveBeenCalled();
        expect(mockClient.set).not.toHaveBeenCalled();
    });

    it('does not cap retained history before finding an active viewer', async () => {
        const ids = [...Array.from({ length: 1001 }, (_, index) => `ended-${index}`), 'watching'];
        const pointers = ids.map((id) => `livetv:v2:viewer-psess:${id}`);
        scan.mockImplementation(async (_pattern: string, limit = 1000) => pointers.slice(0, limit));
        mockClient.get.mockImplementation(async (key: string) => {
            const id = key.split(':').at(-1)!;
            if (!key.startsWith('livetv:v2:psess:')) return id;
            return JSON.stringify({
                sessionId: id,
                viewerKey: id,
                username: 'alice',
                stationId: 'station',
                feedId: 'feed',
                state: id === 'watching' ? 'active' : 'ended',
            });
        });
        expect((await listActiveLiveTvPlaybackSessions()).map((s) => s.sessionId)).toEqual([
            'watching',
        ]);
    });

    it('does not let a malformed record hide healthy viewers', async () => {
        scan.mockResolvedValue(['livetv:v2:viewer-psess:bad', 'livetv:v2:viewer-psess:good']);
        const good = {
            sessionId: 'good',
            viewerKey: 'good',
            username: 'alice',
            stationId: 'station',
            feedId: 'feed',
            state: 'active',
        };
        mockClient.get.mockImplementation(async (key: string) => {
            if (key === 'livetv:v2:psess:bad') return '{broken';
            if (key === 'livetv:v2:psess:good') return JSON.stringify(good);
            return key.endsWith(':good') ? 'good' : 'bad';
        });
        expect((await listActiveLiveTvPlaybackSessions()).map((s) => s.sessionId)).toEqual([
            'good',
        ]);
    });

    it('registers a session and returns it via getSourceViewers', async () => {
        const entry = {
            viewerKey: 'alice:device:a',
            channelId: 'ch1',
            sourceId: 'src1',
            priority: 'low' as const,
            startedAt: 1000,
            username: 'alice',
        };
        mockClient.smembers.mockResolvedValueOnce(['alice:device:a']).mockResolvedValueOnce([]);
        mockClient.get.mockResolvedValue(JSON.stringify(entry));

        await service.registerSession('alice:device:a', 'alice', 'ch1', 'src1', 'low');

        expect(mockClient.set).toHaveBeenCalledWith(
            'livetv:v2:session:alice:device:a',
            expect.any(String),
            expect.objectContaining({ expiry: expect.anything() }),
        );
        expect(mockClient.sadd).toHaveBeenCalledWith('livetv:v2:source:src1:sessions', [
            'alice:device:a',
        ]);

        const viewers = await service.getSourceViewers('src1');
        expect(viewers).toHaveLength(1);
        expect(viewers[0].username).toBe('alice');
    });

    it('keeps the original start when the same viewer re-registers on the same channel', async () => {
        mockClient.get.mockResolvedValueOnce(
            JSON.stringify({
                viewerKey: 'alice:device:a',
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 1234,
            }),
        );
        await service.registerSession('alice:device:a', 'alice', 'ch1', 'src1', 'low');
        const stored = JSON.parse(mockClient.set.mock.calls[0][1] as string);
        expect(stored.startedAt).toBe(1234);
    });

    it('starts the clock again when the viewer moves to another channel', async () => {
        mockClient.get.mockResolvedValueOnce(
            JSON.stringify({
                viewerKey: 'alice:device:a',
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 1234,
            }),
        );
        const before = Date.now();
        await service.registerSession('alice:device:a', 'alice', 'ch2', 'src1', 'low');
        const stored = JSON.parse(mockClient.set.mock.calls[0][1] as string);
        expect(stored.startedAt).toBeGreaterThanOrEqual(before);
    });

    it('stores two devices for one username as independent viewers', async () => {
        await service.registerSession('alice:device:a', 'alice', 'ch1', 'src1', 'low');
        await service.registerSession('alice:device:b', 'alice', 'ch2', 'src1', 'low');

        expect(mockClient.set).toHaveBeenNthCalledWith(
            1,
            'livetv:v2:session:alice:device:a',
            expect.any(String),
            expect.any(Object),
        );
        expect(mockClient.set).toHaveBeenNthCalledWith(
            2,
            'livetv:v2:session:alice:device:b',
            expect.any(String),
            expect.any(Object),
        );
        expect(mockClient.sadd).toHaveBeenNthCalledWith(1, 'livetv:v2:source:src1:sessions', [
            'alice:device:a',
        ]);
        expect(mockClient.sadd).toHaveBeenNthCalledWith(2, 'livetv:v2:source:src1:sessions', [
            'alice:device:b',
        ]);
    });

    it('getSourceViewers skips stale set entries (session key expired)', async () => {
        mockClient.smembers
            .mockResolvedValueOnce(['alice:device:a', 'bob:device:b'])
            .mockResolvedValueOnce([]);
        // alice session expired, bob still active
        mockClient.get.mockResolvedValueOnce(null).mockResolvedValueOnce(
            JSON.stringify({
                viewerKey: 'bob:device:b',
                username: 'bob',
                channelId: 'ch2',
                sourceId: 'src1',
                priority: 'high',
                startedAt: 2000,
            }),
        );

        const viewers = await service.getSourceViewers('src1');
        expect(viewers).toHaveLength(1);
        expect(viewers[0].username).toBe('bob');
        // Should clean up stale entry
        expect(mockClient.srem).toHaveBeenCalledWith('livetv:v2:source:src1:sessions', [
            'alice:device:a',
        ]);
    });

    it('removes a stale source index after a device switches sources', async () => {
        mockClient.smembers.mockResolvedValueOnce(['alice:device:a']).mockResolvedValueOnce([]);
        mockClient.get.mockResolvedValue(
            JSON.stringify({
                viewerKey: 'alice:device:a',
                username: 'alice',
                channelId: 'ch2',
                sourceId: 'src2',
                priority: 'low',
                startedAt: 2000,
            }),
        );

        await expect(service.getSourceViewers('src1')).resolves.toEqual([]);
        expect(mockClient.srem).toHaveBeenCalledWith('livetv:v2:source:src1:sessions', [
            'alice:device:a',
        ]);
    });

    it('keeps active v1 sessions visible during a rolling upgrade', async () => {
        mockClient.smembers.mockResolvedValueOnce([]).mockResolvedValueOnce(['alice']);
        mockClient.get.mockResolvedValue(
            JSON.stringify({
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 1000,
            }),
        );

        await expect(service.getSourceViewers('src1')).resolves.toEqual([
            {
                viewerKey: 'alice',
                username: 'alice',
                channelId: 'ch1',
                sourceId: 'src1',
                priority: 'low',
                startedAt: 1000,
            },
        ]);
        expect(mockClient.get).toHaveBeenCalledWith('livetv:v1:session:alice');
    });

    it('markKicked sets the kicked flag', async () => {
        await service.markKicked('alice:device:a', 'higher_priority_viewer');
        expect(mockClient.set).toHaveBeenCalledWith(
            'livetv:v2:kicked:alice:device:a',
            expect.stringContaining('higher_priority_viewer'),
            expect.objectContaining({ expiry: expect.anything() }),
        );
    });

    it('checkKicked returns kicked=true when flag exists', async () => {
        mockClient.get.mockResolvedValue(
            JSON.stringify({
                reason: 'higher_priority_viewer',
                kickedAt: Date.now(),
            }),
        );
        const result = await service.checkKicked('alice:device:a');
        expect(result).toEqual({
            kicked: true,
            reason: 'higher_priority_viewer',
        });
    });

    it('checkKicked returns kicked=false when flag absent', async () => {
        mockClient.get.mockResolvedValue(null);
        const result = await service.checkKicked('alice:device:a');
        expect(result).toEqual({ kicked: false });
    });

    it('markKicked stores the channel the flag applies to', async () => {
        await service.markKicked('alice:device:a', 'higher_priority_viewer', 'ch1');
        const stored = JSON.parse(String(mockClient.set.mock.calls[0][1]));
        expect(stored).toMatchObject({ reason: 'higher_priority_viewer', channelId: 'ch1' });
    });

    it('checkKicked applies a channel flag to that channel only', async () => {
        mockClient.get.mockResolvedValue(
            JSON.stringify({ reason: 'higher_priority_viewer', kickedAt: 1, channelId: 'ch1' }),
        );
        expect(await service.checkKicked('alice:device:a', 'ch1')).toEqual({
            kicked: true,
            reason: 'higher_priority_viewer',
        });
        expect(await service.checkKicked('alice:device:a', 'ch2')).toEqual({ kicked: false });
    });

    it('checkKicked applies a flag without a channel to every channel', async () => {
        mockClient.get.mockResolvedValue(
            JSON.stringify({ reason: 'higher_priority_viewer', kickedAt: 1 }),
        );
        expect(await service.checkKicked('alice:device:a', 'ch2')).toMatchObject({ kicked: true });
    });

    it('consumeKicked takes the flag with GETDEL, once', async () => {
        const flag = JSON.stringify({ reason: 'r', kickedAt: 1, channelId: 'ch1' });
        mockClient.get.mockResolvedValue(flag);
        mockClient.getdel.mockResolvedValueOnce(flag).mockResolvedValueOnce(null);
        expect(await service.consumeKicked('alice:device:a', 'ch1')).toEqual({
            kicked: true,
            reason: 'r',
        });
        // A concurrent keepalive that peeked the flag too loses the GETDEL.
        expect(await service.consumeKicked('alice:device:a', 'ch1')).toEqual({ kicked: false });
        expect(mockClient.getdel).toHaveBeenCalledWith('livetv:v2:kicked:alice:device:a');
    });

    it('consumeKicked leaves a flag for another channel alone', async () => {
        mockClient.get.mockResolvedValue(
            JSON.stringify({ reason: 'r', kickedAt: 1, channelId: 'ch1' }),
        );
        expect(await service.consumeKicked('alice:device:a', 'ch2')).toEqual({ kicked: false });
        expect(mockClient.getdel).not.toHaveBeenCalled();
    });

    it('removeSessionIfChannel drops the source index only when the session was removed', async () => {
        mockClient.customCommand.mockResolvedValueOnce(1);
        expect(await service.removeSessionIfChannel('alice:device:a', 'src1', 'ch1')).toBe(true);
        expect(mockClient.customCommand).toHaveBeenCalledWith(
            expect.arrayContaining(['EVAL', '1', 'livetv:v2:session:alice:device:a', 'ch1']),
        );
        expect(mockClient.srem).toHaveBeenCalledWith('livetv:v2:source:src1:sessions', [
            'alice:device:a',
        ]);

        mockClient.srem.mockClear();
        mockClient.customCommand.mockResolvedValueOnce(0);
        expect(await service.removeSessionIfChannel('alice:device:a', 'src1', 'ch1')).toBe(false);
        expect(mockClient.srem).not.toHaveBeenCalled();
    });
    it('revocation inventory includes own previews and legacy streams without including another account', async () => {
        const records: Record<string, unknown> = {
            'livetv:v2:psess:preview': {
                sessionId: 'preview',
                username: 'alice',
                state: 'active',
                kind: 'preview',
            },
            'livetv:v2:psess:other': { sessionId: 'other', username: 'bob', state: 'active' },
            'livetv:v2:psess:ended': { sessionId: 'ended', username: 'alice', state: 'ended' },
            'livetv:v2:session:alice:device:d': {
                username: 'alice',
                viewerKey: 'alice:device:d',
                channelId: 'feed',
                sourceId: 'source',
            },
            'livetv:v2:session:bob:device:d': {
                username: 'bob',
                viewerKey: 'bob:device:d',
                channelId: 'feed',
                sourceId: 'source',
            },
            'livetv:v1:session:alice': {
                username: 'alice',
                channelId: 'legacy',
                sourceId: 'source',
            },
        };
        scan.mockImplementation(async (pattern: string) =>
            Object.keys(records).filter((key) => key.startsWith(pattern.replace('*', ''))),
        );
        mockClient.get.mockImplementation(async (key: string) =>
            records[key] ? JSON.stringify(records[key]) : null,
        );
        const resources = await listUserLiveTvResources('alice');
        expect(resources.playback.map((entry) => entry.sessionId)).toEqual(['preview']);
        expect(resources.viewers.map((entry) => entry.viewerKey).sort()).toEqual([
            'alice',
            'alice:device:d',
        ]);
        expect(mockClient.ttl).not.toHaveBeenCalled();
    });
    it('stores a playback handle and atomically swaps the viewer pointer, superseding the previous record', async () => {
        mockClient.customCommand.mockResolvedValueOnce('old-session').mockResolvedValueOnce(1);
        const entry = await service.startPlaybackSession({
            viewerKey: 'alice:device:a',
            username: 'alice',
            stationId: 'station',
            feedId: 'feed',
            sourceId: 'source',
        });
        expect(entry).toMatchObject({ state: 'active', stationId: 'station', feedId: 'feed' });
        expect(mockClient.set).toHaveBeenCalledWith(
            `livetv:v2:psess:${entry.sessionId}`,
            JSON.stringify(entry),
            expect.anything(),
        );
        expect(mockClient.customCommand.mock.calls[0][0]).toEqual([
            'SET',
            'livetv:v2:viewer-psess:alice:device:a',
            entry.sessionId,
            'GET',
            'EX',
            '120',
        ]);
        expect(mockClient.customCommand.mock.calls[1][0]).toEqual([
            'EVAL',
            expect.any(String),
            '1',
            'livetv:v2:psess:old-session',
            'superseded',
            '120',
        ]);
    });

    it('ends only the evicted feed, leaving a newer feed session untouched', async () => {
        mockClient.get
            .mockResolvedValueOnce('new-session')
            .mockResolvedValueOnce(
                JSON.stringify({
                    sessionId: 'new-session',
                    viewerKey: 'alice:device:a',
                    feedId: 'new-feed',
                    state: 'active',
                }),
            )
            .mockResolvedValueOnce('new-session');
        await service.endViewerPlaybackSession('alice:device:a', 'old-feed', 'evicted');
        expect(mockClient.customCommand).not.toHaveBeenCalled();
    });

    it('revokes grants when the backing playback record expires', async () => {
        mockClient.get.mockResolvedValue(null);
        expect(await service.getPlaybackSession('expired-session')).toBeNull();
        expect(revoke).toHaveBeenCalledWith('expired-session', undefined, 'reaped');
    });

    it('release compares the session handle, so a delayed same-feed leave cannot take the pointer', async () => {
        mockClient.customCommand.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
        const entry = {
            sessionId: 'old',
            viewerKey: 'alice:device:a',
            username: 'alice',
            stationId: 'station',
            feedId: 'feed',
            sourceId: 'source',
            startedAt: 1,
            state: 'active' as const,
        };
        expect(await service.releasePlaybackSession(entry)).toBe(false);
        expect(revoke).toHaveBeenCalledWith('old', undefined, 'stopped');
        expect(mockClient.customCommand.mock.calls[1][0]).toEqual([
            'EVAL',
            expect.any(String),
            '1',
            'livetv:v2:viewer-psess:alice:device:a',
            'old',
        ]);
    });
});

it.each([
    ['left', 'stopped'],
    ['superseded', 'superseded'],
    ['evicted', 'admin_kill'],
    ['expired', 'reaped'],
] as const)('revokes session grants on %s with reason %s', async (reason, expected) => {
    mockGetValkeyClient.mockReturnValue({ customCommand: vi.fn().mockResolvedValue(1) });
    await createLiveTvSessionService().endPlaybackSession('live-session', reason);
    expect(revoke).toHaveBeenCalledWith('live-session', undefined, expected);
});
