// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveSessionSchema } from '$lib/schemas/api-playback-responses.js';
const mocks = vi.hoisted(() => ({
    list: vi.fn(),
    sql: vi.fn(),
    identities: vi.fn(),
    singleFlight: vi.fn(),
    status: vi.fn(),
    channel: vi.fn(),
    guide: vi.fn(),
    peek: vi.fn(),
    release: vi.fn(),
    leave: vi.fn(),
    remove: vi.fn(),
}));
vi.mock('../cache/single-flight.js', () => ({ getOrComputeSingleFlight: mocks.singleFlight }));
vi.mock('../database/connection.js', () => ({ getDb: () => mocks.sql() }));
vi.mock('../database/queries/users.queries.js', () => ({
    resolveUsernamesToUsers: mocks.identities,
}));
vi.mock('../config.js', () => ({
    config: { LIVETV_SOURCE: 'standalone', STREAM_PROXY_URL: 'http://proxy.test' },
}));
vi.mock('./livetv/index.js', () => ({
    getLiveTvProvider: async () => ({ getChannel: mocks.channel }),
}));
vi.mock('./livetv/livetv-session.service.js', () => ({
    listActiveLiveTvPlaybackSessions: mocks.list,
    getLiveTvSessionService: () => ({
        peekPlaybackSession: mocks.peek,
        releasePlaybackSession: mocks.release,
        removeSessionIfChannel: mocks.remove,
    }),
}));
vi.mock('./livetv/station.service.js', () => ({
    resolveStation: async () => ({ shownFeedId: 'feed' }),
    readStationNowNext: mocks.guide,
}));
vi.mock('./livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({ getProxyStatus: mocks.status, leaveChannel: mocks.leave }),
}));
vi.mock('./adaptive-playback-state.service.js', () => ({
    resolveSessionAdaptive: async () => new Map(),
}));
vi.mock('./livetv/playback-session-lifecycle.js', () => ({
    withPlaybackViewerLock: async (_key: string, action: () => Promise<Response>) => action(),
}));
vi.mock('../utils/audit-log.js', () => ({ auditLog: vi.fn(), auditActor: () => ({}) }));

import {
    mergeLiveTvSessions,
    cancelLiveTvPlaybackSession,
} from './livetv-active-sessions.service.js';
import type { RequestEvent } from '@sveltejs/kit';

const live = {
    sessionId: 'session',
    stationId: 'station',
    feedId: 'feed',
    sourceId: 'source',
    viewerKey: 'private-viewer-key',
    username: 'alice',
    userId: 'alice-id',
    clientName: 'Lumastra Web',
    state: 'active',
    startedAt: 1,
};
beforeEach(() => {
    vi.clearAllMocks();
    mocks.sql.mockReturnValue(null);
    mocks.singleFlight.mockImplementation(async (opts: { compute: () => Promise<string> }) =>
        opts.compute(),
    );
    mocks.list.mockResolvedValue([live]);
    mocks.channel.mockResolvedValue({ id: 'feed', name: 'Channel HD', images: {} });
    mocks.guide.mockResolvedValue({
        current: {
            title: 'News',
            description: 'Headlines',
            startTime: new Date(Date.now() - 60000).toISOString(),
            endTime: new Date(Date.now() + 60000).toISOString(),
        },
        next: { title: 'Weather', startTime: new Date(Date.now() + 60000).toISOString() },
    });
    mocks.status.mockResolvedValue({
        channels: [
            {
                channelId: 'feed',
                segmentCount: 3,
                probeResult: {
                    videoCodec: 'hevc',
                    audioCodec: 'aac',
                    width: 1920,
                    height: 1080,
                    hdr: false,
                },
            },
        ],
    });
    mocks.peek.mockResolvedValue(live);
    mocks.release.mockResolvedValue(true);
    mocks.leave.mockResolvedValue({ success: true });
    mocks.remove.mockResolvedValue(true);
});
describe('Live TV Active Streams', () => {
    it('includes channel, programme, output and identity data in the response contract without credentials', async () => {
        const [row] = await mergeLiveTvSessions([]);
        expect(ActiveSessionSchema.safeParse(row).success).toBe(true);
        expect(row).toMatchObject({
            title: 'Channel HD',
            mediaType: 'tvchannel',
            liveTvProgramName: 'News',
            liveTvNextProgramName: 'Weather',
            playCodec: 'hevc',
            playOriginalAudioCodec: 'aac',
            userId: 'alice-id',
        });
        expect(row.liveTvProgramProgressPercent).toBeCloseTo(50, 0);
        const guide = await mocks.guide.mock.results[0].value;
        const parsed = ActiveSessionSchema.parse(row);
        expect(parsed.liveTvProgramStartTime).toBe(guide.current.startTime);
        expect(parsed.liveTvProgramEndTime).toBe(guide.current.endTime);
        expect(JSON.stringify(row)).not.toContain('private-viewer-key');
    });
    it('reports a fixed quality output separately from its source', async () => {
        mocks.list.mockResolvedValue([
            { ...live, rungId: '720p4m', appliedMaxHeight: 720, appliedMaxBitrateBps: 4000000 },
        ]);
        expect((await mergeLiveTvSessions([]))[0]).toMatchObject({
            playOriginalCodec: 'hevc',
            playCodec: 'h264',
            playOriginalVideoHeight: 1080,
            playVideoHeight: 720,
            playBitrate: 4000000,
            playIsTranscoding: true,
        });
    });
    it('bounds a failed inventory lookup to a recent snapshot and clears it on a successful empty list', async () => {
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
            expect(await mergeLiveTvSessions([])).toHaveLength(1);
            mocks.list.mockRejectedValue(new Error('store unavailable'));
            clock.mockReturnValue(now + 10_000);
            expect(await mergeLiveTvSessions([])).toHaveLength(1);
            clock.mockReturnValue(now + 30_001);
            expect(await mergeLiveTvSessions([])).toHaveLength(0);
            mocks.list.mockResolvedValue([]);
            expect(await mergeLiveTvSessions([])).toHaveLength(0);
            mocks.list.mockRejectedValue(new Error('store unavailable'));
            expect(await mergeLiveTvSessions([])).toHaveLength(0);
        } finally {
            clock.mockRestore();
        }
    });
    it('keeps the video codec when only audio is converted', async () => {
        mocks.status.mockResolvedValue({
            channels: [
                {
                    channelId: 'feed',
                    probeResult: {
                        videoCodec: 'hevc',
                        audioCodec: 'ac3',
                        width: 1920,
                        height: 1080,
                    },
                    transcodeDecision: { videoAction: 'copy', audioAction: 'transcode' },
                },
            ],
        });
        expect((await mergeLiveTvSessions([]))[0]).toMatchObject({
            playCodec: 'hevc',
            playIsTranscoding: true,
            playOriginalAudioCodec: 'ac3',
            playTranscodeAudioCodec: 'aac',
        });
    });
    it('reports the actual HEVC ingest encoder output', async () => {
        mocks.status.mockResolvedValue({
            channels: [
                {
                    channelId: 'feed',
                    probeResult: { videoCodec: 'mpeg2video', audioCodec: 'aac' },
                    transcodeDecision: {
                        videoAction: 'transcode',
                        audioAction: 'copy',
                        videoEncoder: 'hevc_qsv',
                    },
                },
            ],
        });
        expect((await mergeLiveTvSessions([]))[0]).toMatchObject({
            playOriginalCodec: 'mpeg2video',
            playCodec: 'hevc',
            playTranscodeCodec: 'hevc',
        });
    });
    it('reports a dependency outage when a stop cannot read the Live TV session store', async () => {
        mocks.peek.mockRejectedValue(new Error('store down'));
        expect(
            (await cancelLiveTvPlaybackSession({ locals: {} } as RequestEvent, 'session'))?.status,
        ).toBe(503);
        expect(mocks.release).not.toHaveBeenCalled();
    });

    it('does not claim play/pause state or a playback position from keepalives', async () => {
        const [row] = await mergeLiveTvSessions([]);
        expect(row.playIsPlaying).toBeUndefined();
        expect(row.playCurrentTime).toBeUndefined();
        expect(row.liveTvProgramProgressPercent).toBeDefined();
    });
    it('distinguishes HDR input from an SDR quality output', async () => {
        mocks.list.mockResolvedValue([{ ...live, rungId: '720p4m', appliedMaxHeight: 720 }]);
        mocks.status.mockResolvedValue({
            channels: [{ channelId: 'feed', probeResult: { videoCodec: 'hevc', hdr: true } }],
        });
        expect((await mergeLiveTvSessions([]))[0]).toMatchObject({
            playOriginalVideoRange: 'HDR',
            playVideoRange: 'SDR',
        });
    });
    it('resolves legacy ownership to a unique stable user ID despite username casing', async () => {
        mocks.sql.mockReturnValue({});
        mocks.identities.mockResolvedValue(
            new Map([['alice', { id: 'alice-id', username: 'Alice' }]]),
        );
        mocks.peek.mockResolvedValue({ ...live, userId: undefined, username: 'ALICE' });
        const event = {
            locals: { user: { userId: 'alice-id', username: 'alice' } },
        } as RequestEvent;
        expect((await cancelLiveTvPlaybackSession(event, 'session'))?.status).toBe(204);
    });
    it('shares raw enrichment across viewers without caching their pre-existing sessions', async () => {
        const cache = new Map<string, string>();
        mocks.singleFlight.mockImplementation(
            async (opts: { cacheKey: string; compute: () => Promise<string> }) => {
                if (!cache.has(opts.cacheKey)) cache.set(opts.cacheKey, await opts.compute());
                return cache.get(opts.cacheKey)!;
            },
        );
        const prior = (id: string) =>
            ActiveSessionSchema.parse({
                __id: id,
                id: 'movie',
                mediaItemId: 'movie',
                title: 'Movie',
                mediaType: 'movie',
                username: id,
            });
        expect((await mergeLiveTvSessions([prior('viewer-a')])).map((s) => s.__id)).toEqual([
            'viewer-a',
            'session',
        ]);
        expect((await mergeLiveTvSessions([prior('viewer-b')])).map((s) => s.__id)).toEqual([
            'viewer-b',
            'session',
        ]);
        expect(mocks.list).toHaveBeenCalledOnce();
        expect(mocks.status).toHaveBeenCalledOnce();
        expect(mocks.guide).toHaveBeenCalledOnce();
    });

    it('preserves an unrelated external session with the same source-session ID', async () => {
        const other = ActiveSessionSchema.parse({
            __id: 'external',
            id: 'book',
            mediaItemId: 'book',
            title: 'Book',
            mediaType: 'audiobook',
            username: 'bob',
            sessionSource: 'audiobookshelf',
            playSessionId: 'session',
        });
        expect((await mergeLiveTvSessions([other])).map((s) => s.__id)).toEqual([
            'external',
            'session',
        ]);
    });

    it('preserves two devices watching the same station', async () => {
        mocks.list.mockResolvedValue([live, { ...live, sessionId: 'second' }]);
        expect((await mergeLiveTvSessions([])).map((s) => s.__id)).toEqual(['session', 'second']);
    });
    it('retains a fresh viewer when proxy status and EPG are temporarily unavailable', async () => {
        mocks.status.mockRejectedValue(new Error('offline'));
        mocks.guide.mockRejectedValue(new Error('offline'));
        expect(await mergeLiveTvSessions([])).toHaveLength(1);
    });
    it.each([
        [false, false],
        [true, false],
        [false, true],
    ])('blocks a foreign stop, admin=%s permission=%s', async (isAdmin, permission) => {
        const event = {
            locals: {
                user: { userId: 'bob-id', username: 'bob', hasLiveTvPermission: permission },
                principal: { isAdmin },
            },
        } as RequestEvent;
        expect(await cancelLiveTvPlaybackSession(event, 'session')).toBeNull();
        expect(mocks.release).not.toHaveBeenCalled();
    });
    it('stops only the owning viewer and frees its proxy presence', async () => {
        const event = {
            locals: { user: { userId: 'alice-id', username: 'alice' } },
        } as RequestEvent;
        expect((await cancelLiveTvPlaybackSession(event, 'session'))?.status).toBe(204);
        expect(mocks.leave).toHaveBeenCalledWith('feed', 'private-viewer-key');
        expect(mocks.remove).toHaveBeenCalledWith('private-viewer-key', 'source', 'feed');
    });
});
