// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// The Live TV channel access gate on the routes that do not join a stream:
// segment / init / media-playlist proxies (cached gate) and channel metadata
// (uncached gate). A viewer who knows a hidden channel's id must get 404 and
// the proxy / provider must never be asked.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

const { proxyClient, provider, mockCanStream, mockCanRead } = vi.hoisted(() => ({
    proxyClient: {
        proxyHlsSegment: vi.fn(),
        proxyHlsRungPlaylist: vi.fn(),
        proxyHlsRungSegment: vi.fn(),
        proxyHlsAdaptivePlaylist: vi.fn(),
        proxyHlsAdaptiveSegment: vi.fn(),
        proxyHlsVariantFile: vi.fn(),
    },
    provider: {
        getChannel: vi.fn(),
        getPrograms: vi.fn(),
        getCurrentProgram: vi.fn(),
    },
    mockCanStream: vi.fn(),
    mockCanRead: vi.fn(),
}));

vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => proxyClient,
}));
vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue(provider),
}));
vi.mock('$lib/server/services/livetv/station.service.js', async (original) => ({
    ...(await original<typeof import('$lib/server/services/livetv/station.service.js')>()),
    readStationAirings: async (ids: string[]) => {
        await provider.getPrograms();
        return new Map(ids.map((id) => [id, []]));
    },
    readStationSchedules: async (ids: string[]) => {
        await provider.getCurrentProgram();
        return new Map(ids.map((id) => [id, []]));
    },
    readStationNowNext: async () => ({ current: null, next: null }),
    resolveStation: async (stationId: string) => ({
        stationId,
        shownFeedId: stationId,
        groupId: null,
    }),
}));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: mockCanStream,
    canReadLiveTvChannelStream: mockCanRead,
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackLiveTV: vi.fn() },
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, property, receiver) {
                if (
                    property === 'FEATURE_LIVETV' ||
                    property === 'LIVETV_ADAPTIVE_LADDER_ENABLED' ||
                    property === 'LIVETV_ADAPTIVE_INCLUDE_ORIGINAL'
                )
                    return true;
                return Reflect.get(target, property, receiver);
            },
        }),
    };
});
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { mount } from '$lib/server/api/mount.js';
import type { EndpointDef } from '$lib/server/api/define.js';
import { def as segmentDef } from './[id]/stream/[segment].js';
import { def as rungPlaylistDef } from './[id]/stream/r/[rung]/playlist.m3u8.js';
import { def as rungSegmentDef } from './[id]/stream/r/[rung]/[segment].js';
import { def as adaptivePlaylistDef } from './[id]/stream/a/[output]/playlist.m3u8.js';
import { def as adaptiveSegmentDef } from './[id]/stream/a/[output]/[segment].js';
import { def as variantMasterDef } from './[id]/stream/v/[variant]/master.m3u8.js';
import { def as variantPlaylistDef } from './[id]/stream/v/[variant]/playlist.m3u8.js';
import { def as variantFileDef } from './[id]/stream/v/[variant]/[file].js';
import { def as channelDef } from '../stations/[stationId].js';
import { validateReadWindow } from '../read-window.js';
import { ProgramsWindowSchema } from '../stations/[stationId]/programs.js';
import { def as programsDef } from '../stations/[stationId]/programs.js';
import { def as currentProgramDef } from '../stations/[stationId]/current-program.js';

const CHANNEL = '550e8400-e29b-41d4-a716-446655440000';

function event(path: string, params: Record<string, string>): RequestEvent {
    return {
        url: new URL(
            `http://localhost${path}${path.includes('?') ? '&' : '?'}from=2026-10-16T10:00:00Z&to=2026-10-16T12:00:00Z`,
        ),
        request: new Request(`http://localhost${path}`),
        params: { ...params, stationId: params.stationId ?? params.id ?? params.channelId },
        route: { id: path as never },
        locals: {
            user: {
                userId: toUserId('00000000-0000-0000-0000-000000000001'),
                username: 'alice',
                groups: '',
                userGroups: [],
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                isModerator: false,
                maxAgeRating: null,
                isAgeRestricted: false,
                liveTvPriority: 'low',
            },
            principal: { isAdmin: false },
            liveTvCredentialId: 'device:a',
        },
        cookies: { get: vi.fn(), set: vi.fn() } as unknown as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function hls(): Response {
    return new Response('#EXTM3U\nsegment-1.ts\n', { status: 200 });
}
function bytes(): Response {
    return new Response(new Uint8Array([0x47]), {
        status: 200,
        headers: { 'content-length': '1' },
    });
}

const base = `/api/v1/livetv/channels/${CHANNEL}/stream`;

const STREAM_ROUTES: Array<{
    name: string;
    def: EndpointDef;
    path: string;
    params: Record<string, string>;
    proxy: keyof typeof proxyClient;
    reply: () => Response;
}> = [
    {
        name: 'stream/{segment} (segment)',
        def: segmentDef as EndpointDef,
        path: `${base}/segment-1.m4s`,
        params: { id: CHANNEL, segment: 'segment-1.m4s' },
        proxy: 'proxyHlsSegment',
        reply: bytes,
    },
    {
        name: 'stream/{segment} (media playlist)',
        def: segmentDef as EndpointDef,
        path: `${base}/playlist.m3u8`,
        params: { id: CHANNEL, segment: 'playlist.m3u8' },
        proxy: 'proxyHlsSegment',
        reply: hls,
    },
    {
        name: 'stream/r/{rung}/playlist.m3u8',
        def: rungPlaylistDef as EndpointDef,
        path: `${base}/r/540p2m/playlist.m3u8`,
        params: { id: CHANNEL, rung: '540p2m' },
        proxy: 'proxyHlsRungPlaylist',
        reply: hls,
    },
    {
        name: 'stream/r/{rung}/{segment}',
        def: rungSegmentDef as EndpointDef,
        path: `${base}/r/540p2m/segment-1.ts`,
        params: { id: CHANNEL, rung: '540p2m', segment: 'segment-1.ts' },
        proxy: 'proxyHlsRungSegment',
        reply: bytes,
    },
    {
        name: 'stream/a/{output}/playlist.m3u8',
        def: adaptivePlaylistDef as EndpointDef,
        path: `${base}/a/540p2m/playlist.m3u8`,
        params: { id: CHANNEL, output: '540p2m' },
        proxy: 'proxyHlsAdaptivePlaylist',
        reply: hls,
    },
    {
        name: 'stream/a/{output}/{segment}',
        def: adaptiveSegmentDef as EndpointDef,
        path: `${base}/a/540p2m/segment-1.ts`,
        params: { id: CHANNEL, output: '540p2m', segment: 'segment-1.ts' },
        proxy: 'proxyHlsAdaptiveSegment',
        reply: bytes,
    },
    {
        name: 'stream/v/{variant}/master.m3u8',
        def: variantMasterDef as EndpointDef,
        path: `${base}/v/fmp4/master.m3u8?PlaySessionId=live-session`,
        params: { id: CHANNEL, variant: 'fmp4' },
        proxy: 'proxyHlsVariantFile',
        reply: () => new Response('#EXTM3U\nplaylist.m3u8\n', { status: 200 }),
    },
    {
        name: 'stream/v/{variant}/playlist.m3u8',
        def: variantPlaylistDef as EndpointDef,
        path: `${base}/v/fmp4/playlist.m3u8`,
        params: { id: CHANNEL, variant: 'fmp4' },
        proxy: 'proxyHlsVariantFile',
        reply: hls,
    },
    {
        name: 'stream/v/{variant}/{file}',
        def: variantFileDef as EndpointDef,
        path: `${base}/v/fmp4/init.mp4`,
        params: { id: CHANNEL, variant: 'fmp4', file: 'init.mp4' },
        proxy: 'proxyHlsVariantFile',
        reply: bytes,
    },
];

describe('Live TV stream reads check the channel access gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCanRead.mockResolvedValue(true);
        mockCanStream.mockResolvedValue(true);
    });

    it.each(STREAM_ROUTES)(
        '$name: 404 and no proxy call for a channel the viewer may not stream',
        async (route) => {
            mockCanRead.mockResolvedValue(false);
            const ev = event(route.path, route.params);
            const { GET } = mount(route.def, { surface: 'v1' });
            const res = await GET!(ev);
            expect(res.status).toBe(404);
            expect(mockCanRead).toHaveBeenCalledWith(ev.locals, CHANNEL);
            for (const fn of Object.values(proxyClient)) expect(fn).not.toHaveBeenCalled();
            // Segment reads use the cached gate, never a per-request query.
            expect(mockCanStream).not.toHaveBeenCalled();
        },
    );

    it.each(STREAM_ROUTES)('$name: proxies when the gate allows', async (route) => {
        proxyClient[route.proxy].mockImplementation(async () => route.reply());
        const { GET } = mount(route.def, { surface: 'v1' });
        const res = await GET!(event(route.path, route.params));
        expect(res.status).toBe(200);
        expect(proxyClient[route.proxy]).toHaveBeenCalled();
    });
});

const META_ROUTES: Array<{
    name: string;
    def: EndpointDef;
    path: string;
    params: Record<string, string>;
    call: keyof typeof provider;
}> = [
    {
        name: 'channels/{id}',
        def: channelDef as EndpointDef,
        path: `/api/v1/livetv/stations/${CHANNEL}`,
        params: { stationId: CHANNEL },
        call: 'getChannel',
    },
    {
        name: 'channels/{id}/programs',
        def: programsDef as EndpointDef,
        path: `/api/v1/livetv/stations/${CHANNEL}/programs`,
        params: { stationId: CHANNEL },
        call: 'getPrograms',
    },
    {
        name: 'current-program/{channelId}',
        def: currentProgramDef as EndpointDef,
        path: `/api/v1/livetv/stations/${CHANNEL}/current-program`,
        params: { stationId: CHANNEL },
        call: 'getCurrentProgram',
    },
];

describe('Live TV channel metadata checks the channel access gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCanStream.mockResolvedValue(true);
        provider.getChannel.mockResolvedValue({
            id: CHANNEL,
            name: 'Channel 1',
            images: {},
            sortOrder: 0,
            isVisible: true,
        });
        provider.getPrograms.mockResolvedValue([]);
        provider.getCurrentProgram.mockResolvedValue(null);
    });

    it.each(META_ROUTES)(
        '$name: 404 and no provider call for a channel the viewer may not stream',
        async (route) => {
            mockCanStream.mockResolvedValue(false);
            const ev = event(route.path, route.params);
            const { GET } = mount(route.def, { surface: 'v1' });
            const res = await GET!(ev);
            expect(res.status).toBe(404);
            expect(mockCanStream).toHaveBeenCalledWith(ev.locals, CHANNEL);
            for (const fn of Object.values(provider)) expect(fn).not.toHaveBeenCalled();
        },
    );

    it.each(META_ROUTES)('$name: answers when the gate allows', async (route) => {
        const { GET } = mount(route.def, { surface: 'v1' });
        const res = await GET!(event(route.path, route.params));
        expect(res.status).toBe(200);
        expect(provider[route.call]).toHaveBeenCalled();
    });

    it('current-program refuses a caller without Live TV permission', async () => {
        const ev = event(`/api/v1/livetv/stations/${CHANNEL}/current-program`, {
            channelId: CHANNEL,
        });
        (ev.locals.user as { hasLiveTvPermission: boolean }).hasLiveTvPermission = false;
        const { GET } = mount(currentProgramDef as EndpointDef, { surface: 'v1' });
        expect((await GET!(ev)).status).toBe(404);
        expect(provider.getCurrentProgram).not.toHaveBeenCalled();
    });
});

describe('station program windows', () => {
    it('requires explicit timestamps and caps the window at 24 hours', () => {
        expect(ProgramsWindowSchema.safeParse({}).success).toBe(false);
        expect(ProgramsWindowSchema.safeParse({ view: 'day' }).success).toBe(false);
        const from = '2026-10-16T10:00:00Z';
        expect(ProgramsWindowSchema.safeParse({ from, to: '2026-10-17T10:00:00Z' }).success).toBe(
            true,
        );
        expect(validateReadWindow({ from, to: '2026-10-17T10:00:01Z' })?.status).toBe(422);
        expect(validateReadWindow({ from, to: from })?.status).toBe(422);
        expect(
            ProgramsWindowSchema.safeParse({
                from: '2026-10-16T10:00:00',
                to: '2026-10-16T11:00:00',
            }).success,
        ).toBe(false);
    });
});
