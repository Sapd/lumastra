// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

const { proxyClient, trackLiveTV } = vi.hoisted(() => ({
    proxyClient: { proxyHlsVariantFile: vi.fn() },
    trackLiveTV: vi.fn(),
}));

// Segment-only liveness has its own tests; here it would heartbeat the mocked proxy client.
vi.mock('$lib/server/services/livetv/viewer-liveness.js', () => ({ touchLiveTvViewer: vi.fn() }));
vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => proxyClient,
}));
// The channel access gate has its own tests (channel-access.test.ts, livetv-channel-gate-defs.test.ts).
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
import { def as masterDef } from './[id]/stream/v/[variant]/master.m3u8.js';

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

describe('Live TV compat variant HLS defs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('requires PlaySessionId on a master URL', async () => {
        const { GET } = mount(masterDef, { surface: 'v1' });
        const response = await GET!(
            event(`/api/v1/livetv/channels/${CHANNEL}/stream/v/fmp4/master.m3u8?grant=k`, {
                id: CHANNEL,
                variant: 'fmp4',
            }),
        );
        expect(response.status).toBe(422);
        expect(proxyClient.proxyHlsVariantFile).not.toHaveBeenCalled();
    });

    it('variant master passes the proxy attributes through and points at this surface', async () => {
        proxyClient.proxyHlsVariantFile.mockResolvedValueOnce(
            new Response(
                '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n' +
                    '#EXT-X-STREAM-INF:BANDWIDTH=18400000,CODECS="hvc1.2.4.L153.B0,mp4a.40.2",' +
                    'RESOLUTION=3840x2160,VIDEO-RANGE=PQ\nplaylist.m3u8\n',
            ),
        );
        const { GET } = mount(masterDef, { surface: 'v1' });
        const response = await GET!(
            event(
                `/api/v1/livetv/channels/${CHANNEL}/stream/v/fmp4/master.m3u8?PlaySessionId=live-session&grant=k`,
                {
                    id: CHANNEL,
                    variant: 'fmp4',
                },
            ),
        );
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain('CODECS="hvc1.2.4.L153.B0,mp4a.40.2"');
        expect(body).toContain('VIDEO-RANGE=PQ');
        expect(body).toContain(
            `\n/api/v1/livetv/channels/${CHANNEL}/stream/v/fmp4/playlist.m3u8?PlaySessionId=live-session&grant=k\n`,
        );
        expect(body).not.toMatch(/^playlist\.m3u8$/m);
        expect(proxyClient.proxyHlsVariantFile).toHaveBeenCalledWith(
            CHANNEL,
            'fmp4',
            'master.m3u8',
            expect.anything(),
        );
    });

    it.each([
        ['an error status', () => Promise.resolve(new Response(null, { status: 400 }))],
        ['a network failure', () => Promise.reject(new Error('ECONNREFUSED'))],
    ])('variant master falls back to a bare master on %s', async (_label, reply) => {
        proxyClient.proxyHlsVariantFile.mockImplementationOnce(reply);
        const { GET } = mount(masterDef, { surface: 'internal' });
        const response = await GET!(
            event(
                `/api/livetv/channels/${CHANNEL}/stream/v/h264/master.m3u8?PlaySessionId=live-session`,
                {
                    id: CHANNEL,
                    variant: 'h264',
                },
            ),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(
            `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=8000000\n` +
                `/api/livetv/channels/${CHANNEL}/stream/v/h264/playlist.m3u8?PlaySessionId=live-session\n`,
        );
    });
});
