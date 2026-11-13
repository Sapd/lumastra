// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for /j/Videos/[itemId]/live/[segment] viewer keepalive.
//
// A Jellyfin client (ExoPlayer) joins the channel once via live.m3u8 and then
// only ever polls playlist.m3u8 + segments. Nothing in that loop reached the
// stream proxy's heartbeat, so the viewer was reaped after
// LIVETV_VIEWER_TIMEOUT_SECONDS, the grace period ran out and FFmpeg stopped:
// /j Live TV sessions could die with a 404 playlist after the timeout,
// forcing clients to reconnect repeatedly.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });
const liveFeature = vi.hoisted(() => ({ enabled: true }));
vi.mock('$lib/server/config.js', async (original) => {
    const actual = await original<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, key, receiver) {
                return key === 'FEATURE_LIVETV'
                    ? liveFeature.enabled
                    : Reflect.get(target, key, receiver);
            },
        }),
    };
});

const {
    mockProxyHlsSegment,
    mockHeartbeat,
    mockGetStreamInfo,
    mockValidatePlayToken,
    mockCanReadStream,
} = vi.hoisted(() => ({
    mockProxyHlsSegment: vi.fn(),
    mockHeartbeat: vi.fn(),
    mockGetStreamInfo: vi.fn(),
    mockValidatePlayToken: vi.fn(),
    mockCanReadStream: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

// The Live TV channel access gate has its own tests (channel-access.test.ts).
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: vi.fn().mockResolvedValue(true),
    canReadLiveTvChannelStream: mockCanReadStream,
}));
vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({
        proxyHlsSegment: mockProxyHlsSegment,
        proxyHlsPlaylist: vi.fn(async () => new Response('#EXTM3U\nplaylist.m3u8\n')),
        heartbeat: mockHeartbeat,
    }),
}));

vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({ getStreamInfo: mockGetStreamInfo }),
}));

vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackLiveTV: vi.fn() },
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/play-token.js', () => ({
    validatePlayToken: mockValidatePlayToken,
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/play-token-user.js', () => ({
    // 2026-10-13: routes call applyPlayTokenIdentity (user + never-admin stream_token principal).
    applyPlayTokenIdentity: (event: { locals: Record<string, unknown> }, user: unknown) => {
        event.locals.user = user;
        event.locals.principal = { kind: 'stream_token', isAdmin: false, scopes: [] };
    },
    buildPlayTokenUserContext: vi.fn().mockResolvedValue({
        userId: '00000000-0000-0000-0000-000000000001',
        username: 'aleks',
        hasLiveTvPermission: true,
    }),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/livetv-token-access.js', () => ({
    enforceTokenLiveTvAccess: vi.fn().mockResolvedValue(null),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

import { GET } from './+server';

const CHANNEL_ID = 'ee4a93da-cf74-4b88-8ae8-a3a126c09a3f';
const PLAY_TOKEN = '25962c70-2833-4938-a37b-25729187b0ae';
const USER_ID = '00000000-0000-0000-0000-000000000001';

// Must match what live.m3u8 joined with, or the heartbeat keeps a stranger alive.
const EXPECTED_VIEWER_KEY = `aleks:jf-play:${createHash('sha256').update(PLAY_TOKEN).digest('hex')}`;

function makeEvent(segment: string): RequestEvent {
    return {
        params: { itemId: CHANNEL_ID, segment },
        url: new URL(
            `https://example.test/j/Videos/${CHANNEL_ID}/live/${segment}?api_key=${PLAY_TOKEN}`,
        ),
        locals: {},
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
}

const callGet = (segment: string) =>
    (GET as unknown as (event: RequestEvent) => Promise<Response>)(makeEvent(segment));

const PLAYLIST = '#EXTM3U\n#EXTINF:6.0,\nsegment-0.ts\n';

describe('/j/Videos/[itemId]/live/[segment] keeps the proxy viewer alive', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePlayToken.mockResolvedValue({ itemId: CHANNEL_ID, userId: USER_ID });
        mockHeartbeat.mockResolvedValue({ success: true });
        mockGetStreamInfo.mockResolvedValue({});
        mockCanReadStream.mockResolvedValue(true);
        mockProxyHlsSegment.mockImplementation(async (_channel: string, segment: string) =>
            segment === 'playlist.m3u8'
                ? new Response(PLAYLIST, { status: 200 })
                : new Response(new Uint8Array([0x47]), {
                      status: 200,
                      headers: { 'content-length': '1' },
                  }),
        );
    });

    it('heartbeats the same viewer live.m3u8 joined with on every media playlist fetch', async () => {
        const response = await callGet('playlist.m3u8');

        expect(response.status).toBe(200);
        expect(mockHeartbeat).toHaveBeenCalledTimes(1);
        expect(mockHeartbeat).toHaveBeenCalledWith(CHANNEL_ID, EXPECTED_VIEWER_KEY);
        expect(mockGetStreamInfo).not.toHaveBeenCalled();
    });

    it('re-joins the channel when the proxy no longer knows the viewer', async () => {
        // Proxy restarted or the viewer was already reaped: heartbeat 404s.
        mockHeartbeat.mockRejectedValueOnce(new Error('Proxy 404: {"success":false}'));

        const response = await callGet('playlist.m3u8');

        expect(response.status).toBe(200);
        expect(mockGetStreamInfo).toHaveBeenCalledWith(CHANNEL_ID, EXPECTED_VIEWER_KEY);
        // The join happens BEFORE the playlist is fetched, so a stream that was
        // stopped gets restarted rather than 404ing forever.
        const joinOrder = mockGetStreamInfo.mock.invocationCallOrder[0];
        const fetchOrder = mockProxyHlsSegment.mock.invocationCallOrder[0];
        expect(joinOrder).toBeLessThan(fetchOrder);
    });

    it('re-joins when the heartbeat answers success:false', async () => {
        mockHeartbeat.mockResolvedValueOnce({ success: false, message: 'viewer_not_found' });

        await callGet('playlist.m3u8');

        expect(mockGetStreamInfo).toHaveBeenCalledWith(CHANNEL_ID, EXPECTED_VIEWER_KEY);
    });

    it('still serves the playlist when the proxy heartbeat itself is unreachable', async () => {
        mockHeartbeat.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

        const response = await callGet('playlist.m3u8');

        expect(response.status).toBe(200);
        expect(await response.text()).toContain(`/j/Videos/${CHANNEL_ID}/live/segment-0.ts`);
        expect(mockGetStreamInfo).not.toHaveBeenCalled();
    });

    it('does not heartbeat on segment fetches — the playlist poll is the cadence', async () => {
        const response = await callGet('segment-0.ts');

        expect(response.status).toBe(200);
        expect(mockHeartbeat).not.toHaveBeenCalled();
    });

    it.each(['playlist.m3u8', 'segment-3.ts', 'init.mp4'])(
        'answers 404 for %s of a channel the viewer may not stream, without touching the proxy',
        async (segment) => {
            mockCanReadStream.mockResolvedValue(false);
            const res = await callGet(segment);
            expect(res.status).toBe(404);
            expect(mockCanReadStream).toHaveBeenCalledWith(
                expect.objectContaining({ principal: expect.objectContaining({ isAdmin: false }) }),
                CHANNEL_ID,
            );
            expect(mockProxyHlsSegment).not.toHaveBeenCalled();
            expect(mockHeartbeat).not.toHaveBeenCalled();
            expect(mockGetStreamInfo).not.toHaveBeenCalled();
        },
    );
});

it.each(['master', 'segment'])(
    '%s HLS denial matches the exact unconfigured response',
    async (kind) => {
        const handler = kind === 'master' ? (await import('../../live.m3u8/+server.js')).GET : GET;
        const { buildPlayTokenUserContext } =
            await import('$lib/server/proprietary/jellyfin-compat/play-token-user.js');
        const user = { userId: USER_ID, username: 'aleks', hasLiveTvPermission: true };
        mockValidatePlayToken.mockResolvedValue({ itemId: CHANNEL_ID, userId: USER_ID });
        mockGetStreamInfo.mockResolvedValue({});
        mockCanReadStream.mockResolvedValue(true);
        mockProxyHlsSegment.mockResolvedValue(new Response('stream'));
        vi.mocked(buildPlayTokenUserContext).mockResolvedValue(user as never);
        try {
            liveFeature.enabled = false;
            const absent = await handler(makeEvent('segment-0.ts') as never);
            liveFeature.enabled = true;
            vi.mocked(buildPlayTokenUserContext).mockResolvedValue({
                ...user,
                hasLiveTvPermission: false,
            } as never);
            const denied = await handler(makeEvent('segment-0.ts') as never);
            expect(absent.status).toBe(404);
            expect(denied.status).toBe(absent.status);
            expect(await denied.json()).toEqual(await absent.json());
        } finally {
            liveFeature.enabled = true;
            vi.mocked(buildPlayTokenUserContext).mockResolvedValue(user as never);
        }
    },
);

it.each(['master', 'segment'])(
    '%s HLS fails closed with a retryable response when the permission re-check is unavailable',
    async (kind) => {
        const handler = kind === 'master' ? (await import('../../live.m3u8/+server.js')).GET : GET;
        const { AuthDependencyUnavailableError } =
            await import('$lib/server/auth/dependency-unavailable.js');
        const { enforceTokenLiveTvAccess } =
            await import('$lib/server/proprietary/jellyfin-compat/livetv-token-access.js');
        const { buildPlayTokenUserContext } =
            await import('$lib/server/proprietary/jellyfin-compat/play-token-user.js');
        vi.clearAllMocks();
        mockValidatePlayToken.mockResolvedValue({ itemId: CHANNEL_ID, userId: USER_ID });
        vi.mocked(enforceTokenLiveTvAccess).mockRejectedValueOnce(
            new AuthDependencyUnavailableError(
                Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
            ),
        );
        const response = await handler(makeEvent('segment-0.ts') as never);
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('5');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.json()).toMatchObject({ code: 'dependency_unavailable' });
        expect(buildPlayTokenUserContext).not.toHaveBeenCalled();
        expect(mockGetStreamInfo).not.toHaveBeenCalled();
        expect(mockProxyHlsSegment).not.toHaveBeenCalled();
        expect(mockHeartbeat).not.toHaveBeenCalled();
    },
);
