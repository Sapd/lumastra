// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A proxy 410 `channel_failed` must reach a media-only player as the typed 410 problem, from every
 * HLS route. The conversion lives in proxyErrorResponse; this pins that the routes call it and
 * that the answer carries no feedsTried and no URL. Master, media playlist and segment are
 * behavioural; the remaining routes are pinned by source so a merge cannot drop the call.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { LIVETV_RUNGS } from '$lib/shared/livetv-rungs.js';

const { proxy, session, provider, access } = vi.hoisted(() => ({
    proxy: {
        proxyHlsSegment: vi.fn(),
        proxyHlsPlaylist: vi.fn(),
        proxyHlsRungPlaylist: vi.fn(),
        leaveChannel: vi.fn(),
    },
    session: {
        checkKicked: vi.fn(),
        registerSession: vi.fn(),
    },
    provider: { getStreamInfo: vi.fn() },
    access: { canStream: vi.fn(), canRead: vi.fn() },
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_LIVETV: true,
        LIVETV_ADAPTIVE_LADDER_ENABLED: true,
        LIVETV_SHOW_ACTIVE_STREAMS: false,
    },
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/auth.js', () => ({ isUserAdmin: () => false }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/middleware/media-access', () => ({ checkMediaAccess: vi.fn() }));
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({ resolveTokenUserAccess: vi.fn() }));
vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => proxy,
}));
vi.mock('$lib/server/services/livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => session,
}));
vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: async () => provider,
}));
vi.mock('$lib/server/services/livetv/livetv-priority.service.js', () => ({
    getLiveTvPriorityService: () => ({}),
}));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: access.canStream,
    canReadLiveTvChannelStream: access.canRead,
}));
vi.mock('$lib/server/services/livetv/viewer-liveness.js', () => ({ touchLiveTvViewer: vi.fn() }));

import { mount } from '$lib/server/api/mount.js';
import { def as masterDef } from './master.m3u8.js';
import { def as segmentDef } from './[segment].js';
import { def as rungPlaylistDef } from './r/[rung]/playlist.m3u8.js';

const CHANNEL = '550e8400-e29b-41d4-a716-446655440000';
const RUNG = LIVETV_RUNGS[0].id;
const SECRET_URL = 'http://provider.invalid/live.m3u8?token=hunter2';

function proxy410(): Response {
    return new Response(
        JSON.stringify({
            error: 'channel_failed',
            reason: 'geo_blocked',
            retryable: false,
            feedsTried: [{ index: 0, feedId: 'feed-secret', reason: 'geo_blocked' }],
            url: SECRET_URL,
        }),
        { status: 410, headers: { 'Content-Type': 'application/json' } },
    );
}

function makeEvent(path: string, params: Record<string, string>): RequestEvent {
    const url = new URL(`http://localhost/api/v1/livetv/channels/${CHANNEL}/stream/${path}`);
    return {
        url,
        request: new Request(url),
        params,
        route: { id: '/api/v1/livetv/channels/[id]/stream' },
        locals: {
            user: {
                userId: toUserId('00000000-0000-0000-0000-000000000001'),
                username: 'viewer',
                groups: '',
                userGroups: [],
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                isAdmin: false,
                isModerator: false,
                maxAgeRating: null,
                isAgeRestricted: false,
                liveTvPriority: 'low',
            },
            liveTvCredentialId: 'test:device',
        },
        cookies: { get: vi.fn(), set: vi.fn() },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.resetAllMocks();
    access.canStream.mockResolvedValue(true);
    access.canRead.mockResolvedValue(true);
    proxy.proxyHlsSegment.mockImplementation(async () => proxy410());
    proxy.proxyHlsPlaylist.mockImplementation(async () => proxy410());
    proxy.proxyHlsRungPlaylist.mockImplementation(async () => proxy410());
    session.checkKicked.mockResolvedValue({ kicked: false });
    session.registerSession.mockResolvedValue(undefined);
    provider.getStreamInfo.mockResolvedValue({
        streamUrl: `/api/livetv/channels/${CHANNEL}/stream/master.m3u8`,
        requiresProxy: true,
        rungId: null,
    });
});

describe('proxy 410 channel_failed on the HLS routes', () => {
    const cases: Array<[string, () => Promise<Response> | Response]> = [
        [
            'master playlist',
            () =>
                mount(masterDef, { surface: 'v1' }).GET!(
                    makeEvent('master.m3u8?PlaySessionId=s1', { id: CHANNEL }),
                ),
        ],
        [
            'media segment',
            () =>
                mount(segmentDef, { surface: 'v1' }).GET!(
                    makeEvent('segment-1.ts', { id: CHANNEL, segment: 'segment-1.ts' }),
                ),
        ],
        [
            'rung media playlist',
            () =>
                mount(rungPlaylistDef, { surface: 'v1' }).GET!(
                    makeEvent(`r/${RUNG}/playlist.m3u8`, { id: CHANNEL, rung: RUNG }),
                ),
        ],
    ];

    it.each(cases)(
        '%s becomes a typed 410 geo_blocked without feedsTried or URLs',
        async (_n, call) => {
            const response = await call();
            expect(response.status).toBe(410);
            const text = await response.text();
            expect(JSON.parse(text)).toMatchObject({
                code: 'geo_blocked',
                failure: { retryable: false },
                status: 410,
            });
            expect(text).not.toContain('feedsTried');
            expect(text).not.toContain('feed-secret');
            expect(text).not.toContain('hunter2');
            expect(text).not.toContain('provider.invalid');
        },
    );
});

describe('proxy answers of a Rust-style proxy on the HLS routes', () => {
    it('a plain 404 or 502 from the proxy is a generic 502, never a crash', async () => {
        for (const status of [404, 502]) {
            proxy.proxyHlsSegment.mockImplementation(
                async () => new Response('{"error":"no_segments"}', { status }),
            );
            const response = await mount(segmentDef, { surface: 'v1' }).GET!(
                makeEvent('segment-1.ts', { id: CHANNEL, segment: 'segment-1.ts' }),
            );
            expect(response.status).toBe(502);
        }
    });
});

describe('every HLS route that reads the proxy converts a 410', () => {
    const ROUTES = [
        '[segment].ts',
        'master.m3u8.ts',
        'a/master.m3u8.ts',
        'a/[output]/[segment].ts',
        'a/[output]/playlist.m3u8.ts',
        'r/[rung]/[segment].ts',
        'r/[rung]/playlist.m3u8.ts',
        'v/[variant]/[file].ts',
        'v/[variant]/playlist.m3u8.ts',
    ];
    it.each(ROUTES)('%s answers a proxy failure through proxyErrorResponse', (route) => {
        const source = readFileSync(fileURLToPath(new URL(route, import.meta.url)), 'utf8');
        expect(source).toMatch(/proxyErrorResponse\(/);
    });
});
