// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    privateUsers: [] as Array<{ username: string; hide_streams: boolean }>,
    sql: vi.fn(),
}));
vi.mock('../config.js', () => ({
    config: {
        FEATURE_SESSIONS: true,
        LIVETV_SOURCE: 'standalone',
        STREAM_PROXY_URL: 'http://proxy.test',
    },
    features: { sessionsPublic: true, sessionsDeviceInfoPublic: true },
    FEATURE_PER_TASK_QUEUES: true,
}));
vi.mock('../auth.js', () => ({ isUserAdmin: () => false }));
vi.mock('../cache/single-flight.js', () => ({
    getOrComputeSingleFlight: async (opts: { compute: () => Promise<string> }) => opts.compute(),
}));
vi.mock('../database/connection.js', () => ({ getDb: () => null }));
vi.mock('./database.service.js', () => ({ aiDbService: { getSql: async () => mocks.sql } }));
vi.mock('../cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: async () => null,
}));
vi.mock('../utils/widget-guard.js', () => ({ isWidgetDisabled: () => false }));
vi.mock('./media-aggregation.service.js', () => ({
    MediaAggregationService: { getActiveSessions: async () => ({ sessions: [] }) },
}));
vi.mock('./audiobookshelf-direct-sessions.service.js', () => ({
    mergeDirectAudiobookshelfSessions: async (sessions: unknown[]) => sessions,
}));
vi.mock('./play-session-device.service.js', () => ({
    prefetchAllDeviceSessions: async () => ({
        byPlaySessionId: new Map(),
        byDeviceUser: new Map(),
    }),
}));
vi.mock('./livetv/livetv-session.service.js', () => ({
    listActiveLiveTvPlaybackSessions: async () => [
        {
            sessionId: 'session',
            stationId: 'station',
            feedId: 'feed',
            viewerKey: 'alice:private-browser',
            sourceId: 'source',
            userId: 'alice-id',
            username: 'alice',
            deviceId: 'device',
            clientName: 'Lumastra Web',
            startedAt: 1,
            state: 'active',
            rungId: '720p4m',
            appliedMaxHeight: 720,
            appliedMaxBitrateBps: 4000000,
        },
    ],
}));
vi.mock('./livetv/index.js', () => ({
    getLiveTvProvider: async () => ({
        getChannel: async () => ({ id: 'feed', name: 'Channel HD', images: {} }),
    }),
}));
vi.mock('./livetv/station.service.js', () => ({
    resolveStation: async () => ({ shownFeedId: 'feed' }),
    readStationNowNext: async () => ({
        current: {
            title: 'News',
            startTime: new Date(Date.now() - 60000).toISOString(),
            endTime: new Date(Date.now() + 60000).toISOString(),
        },
        next: null,
    }),
}));
vi.mock('./livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({
        getProxyStatus: async () => ({
            channels: [{ channelId: 'feed', probeResult: { videoCodec: 'hevc', height: 1080 } }],
        }),
    }),
}));
vi.mock('./adaptive-playback-state.service.js', () => ({
    resolveSessionAdaptive: async () => new Map(),
    redactSessionAdaptive: (state: unknown) => state,
}));

import { getHomeActiveSessions } from './home-active-sessions.service.js';

beforeEach(() => {
    mocks.privateUsers = [];
    mocks.sql.mockImplementation(async () => mocks.privateUsers);
});
function locals(username: string, live: boolean, admin = false): App.Locals {
    return {
        user: {
            username,
            userId: `${username}-id`,
            userGroups: [],
            hasWatchPermission: true,
            hasLiveTvPermission: live,
        },
        principal: { isAdmin: admin },
    } as unknown as App.Locals;
}

it('passes a real Live TV merge through visibility and the home response contract', async () => {
    const result = await getHomeActiveSessions(locals('bob', true), {
        titleLang: null,
        textLang: null,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
        title: 'Channel HD',
        mediaType: 'tvchannel',
        liveTvProgramName: 'News',
        userId: 'alice-id',
        deviceId: 'device',
        clientname: 'Lumastra Web',
        playCodec: 'h264',
        playOriginalCodec: 'hevc',
        playVideoHeight: 720,
        playBitrate: 4000000,
    });
    expect(JSON.stringify(result)).not.toContain('alice:private-browser');
});
it.each([false, true])(
    'withholds another viewer without Live TV permission, admin=%s',
    async (admin) => {
        expect(
            (
                await getHomeActiveSessions(locals('bob', false, admin), {
                    titleLang: null,
                    textLang: null,
                })
            ).sessions,
        ).toEqual([]);
    },
);
it('applies stream privacy after merging while preserving the owner exemption', async () => {
    mocks.privateUsers = [{ username: 'alice', hide_streams: true }];
    expect(
        (await getHomeActiveSessions(locals('bob', true), { titleLang: null, textLang: null }))
            .sessions,
    ).toEqual([]);
    expect(
        (await getHomeActiveSessions(locals('alice', true), { titleLang: null, textLang: null }))
            .sessions,
    ).toHaveLength(1);
});

it('withholds the current channel from its owner after Live TV is disabled', async () => {
    expect(
        (await getHomeActiveSessions(locals('alice', false), { titleLang: null, textLang: null }))
            .sessions,
    ).toEqual([]);
});
