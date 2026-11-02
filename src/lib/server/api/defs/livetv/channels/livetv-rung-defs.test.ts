// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

const { getStreamInfo, sessionService, proxyClient, trackLiveTV } = vi.hoisted(() => ({
    getStreamInfo: vi.fn(),
    sessionService: {
        checkKicked: vi.fn().mockResolvedValue({ kicked: false }),
        registerSession: vi.fn().mockResolvedValue(undefined),
    },
    proxyClient: {
        proxyHlsRungPlaylist: vi.fn(),
        proxyHlsRungSegment: vi.fn(),
    },
    trackLiveTV: vi.fn(),
}));

vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({ getStreamInfo }),
}));
vi.mock('$lib/server/services/livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => sessionService,
}));
// Segment-only liveness has its own tests; here it would heartbeat the mocked proxy client.
vi.mock('$lib/server/services/livetv/viewer-liveness.js', () => ({ touchLiveTvViewer: vi.fn() }));
vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => proxyClient,
}));
// The channel access gate has its own tests (livetv.defs.test.ts, channel-access.test.ts).
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: vi.fn().mockResolvedValue(true),
    canReadLiveTvChannelStream: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackLiveTV },
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, property, receiver) {
                if (property === 'FEATURE_LIVETV' || property === 'LIVETV_ADAPTIVE_LADDER_ENABLED')
                    return true;
                return Reflect.get(target, property, receiver);
            },
        }),
    };
});
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

import { mount } from '$lib/server/api/mount.js';
import { def as masterDef } from './[id]/stream/r/[rung]/master.m3u8.js';
import { def as playlistDef } from './[id]/stream/r/[rung]/playlist.m3u8.js';
import { def as segmentDef } from './[id]/stream/r/[rung]/[segment].js';

const CHANNEL = '550e8400-e29b-41d4-a716-446655440000';

function event(path: string, params: Record<string, string>): RequestEvent {
    return {
        url: new URL(`http://localhost${path}`),
        request: new Request(`http://localhost${path}`),
        params,
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

describe('Live TV rung HLS defs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.LIVETV_CAP_FALLBACK;
        sessionService.checkKicked.mockResolvedValue({ kicked: false });
        getStreamInfo.mockResolvedValue({
            streamUrl: `/api/livetv/channels/${CHANNEL}/stream/r/540p2m/master.m3u8?PlaySessionId=live-session`,
            sourceId: 'src-1',
            requiresProxy: true,
            maxStreams: 2,
            rungId: '540p2m',
            requestedMaxBitrateBps: 2_000_000,
            appliedMaxBitrateBps: 2_000_000,
            appliedMaxHeight: 540,
            reason: null,
        });
    });

    it('rung master re-checks feasibility and emits a real variant', async () => {
        const { GET } = mount(masterDef, { surface: 'v1' });
        const response = await GET!(
            event(
                `/api/v1/livetv/channels/${CHANNEL}/stream/r/540p2m/master.m3u8?PlaySessionId=live-session&grant=secret`,
                {
                    id: CHANNEL,
                    rung: '540p2m',
                },
            ),
        );

        expect(response.status).toBe(200);
        expect(getStreamInfo).toHaveBeenCalledWith(
            CHANNEL,
            'alice:device:a',
            {
                rung: { id: '540p2m', height: 540, maxBitrate: 2_000_000, codec: 'h264' },
                requestedMaxBitrate: 2_000_000,
                belowLadder: false,
                pinned: false,
                // The real config getter — LIVETV_CAP_FALLBACK now defaults to
                // 'source' so a quality that cannot be produced degrades instead of
                // taking the channel down.
                fallback: 'source',
            },
            undefined,
        );
        const body = await response.text();
        // BANDWIDTH only: a single-variant master has nothing to select between, and
        // both RESOLUTION (assumed 16:9) and CODECS (claimed Main@3.1 while the encoder
        // emits High) were wrong. See the note in r/[rung]/master.m3u8.ts.
        expect(body).toContain('#EXT-X-STREAM-INF:BANDWIDTH=2000000\n');
        expect(body).not.toContain('RESOLUTION=');
        expect(body).not.toContain('CODECS=');
        expect(body).toContain(
            `/api/v1/livetv/channels/${CHANNEL}/stream/r/540p2m/playlist.m3u8?PlaySessionId=live-session&grant=secret`,
        );
    });

    it('rejects a rung outside the fixed ladder before joining', async () => {
        const { GET } = mount(masterDef, { surface: 'v1' });
        const response = await GET!(
            event(
                `/api/v1/livetv/channels/${CHANNEL}/stream/r/escape/master.m3u8?PlaySessionId=live-session`,
                {
                    id: CHANNEL,
                    rung: 'escape',
                },
            ),
        );
        expect(response.status).toBe(404);
        expect(getStreamInfo).not.toHaveBeenCalled();
    });

    it('rewrites rung media segments and maps a missing rung to retryable 503', async () => {
        proxyClient.proxyHlsRungPlaylist.mockResolvedValueOnce(
            new Response('#EXTM3U\nsegment-7.ts\n', { status: 200 }),
        );
        const { GET } = mount(playlistDef, { surface: 'internal' });
        const requestEvent = event(
            `/api/livetv/channels/${CHANNEL}/stream/r/540p2m/playlist.m3u8?PlaySessionId=live-session&grant=tok`,
            { id: CHANNEL, rung: '540p2m' },
        );
        const response = await GET!(requestEvent);
        expect(await response.text()).toContain(
            `/api/livetv/channels/${CHANNEL}/stream/r/540p2m/segment-7.ts?PlaySessionId=live-session&grant=tok`,
        );

        proxyClient.proxyHlsRungPlaylist.mockResolvedValueOnce(new Response(null, { status: 404 }));
        const unavailable = await GET!(requestEvent);
        expect(unavailable.status).toBe(503);
        expect((await unavailable.json()).code).toBe('cap_unavailable');
    });

    it('serves only strict MPEG-TS rung segment names and accounts their bytes', async () => {
        const { GET } = mount(segmentDef, { surface: 'v1' });
        const invalid = await GET!(
            event(`/api/v1/livetv/channels/${CHANNEL}/stream/r/540p2m/../secret`, {
                id: CHANNEL,
                rung: '540p2m',
                segment: '../secret',
            }),
        );
        expect(invalid.status).toBe(422);
        expect(proxyClient.proxyHlsRungSegment).not.toHaveBeenCalled();

        proxyClient.proxyHlsRungSegment.mockResolvedValueOnce(
            new Response(new Uint8Array([1, 2, 3]), {
                headers: { 'content-length': '3' },
            }),
        );
        const valid = await GET!(
            event(`/api/v1/livetv/channels/${CHANNEL}/stream/r/540p2m/segment-7.ts`, {
                id: CHANNEL,
                rung: '540p2m',
                segment: 'segment-7.ts',
            }),
        );
        expect(valid.status).toBe(200);
        expect(trackLiveTV).toHaveBeenCalledWith(3);
    });
});
