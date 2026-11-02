// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// The adaptive segment route tells the ABR state service which rung a viewer fetched:
// the server-side source of the Active Streams / Admin → Sessions badge.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

const { proxyClient, mockRecord } = vi.hoisted(() => ({
    proxyClient: { proxyHlsAdaptiveSegment: vi.fn() },
    mockRecord: vi.fn(),
}));

vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => proxyClient,
}));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canReadLiveTvChannelStream: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackLiveTV: vi.fn() },
}));
vi.mock('$lib/server/services/adaptive-playback-state.service.js', () => ({
    recordAdaptiveSegment: mockRecord,
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

import { mount } from '$lib/server/api/mount.js';
import type { EndpointDef } from '$lib/server/api/define.js';
import { def as adaptiveSegmentDef } from './[id]/stream/a/[output]/[segment].js';

const CHANNEL = '550e8400-e29b-41d4-a716-446655440000';

function event(locals: Partial<App.Locals>, cookie?: string): RequestEvent {
    const path = `/api/v1/livetv/channels/${CHANNEL}/stream/a/540p2m/segment-7.ts`;
    return {
        url: new URL(`http://localhost${path}`),
        request: new Request(`http://localhost${path}`),
        params: { id: CHANNEL, output: '540p2m', segment: 'segment-7.ts' },
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
            ...locals,
        },
        cookies: { get: vi.fn(() => cookie), set: vi.fn() } as unknown as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('adaptive segment route records the rung', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        proxyClient.proxyHlsAdaptiveSegment.mockImplementation(
            async () =>
                new Response(new Uint8Array([0x47]), {
                    status: 200,
                    headers: { 'content-length': '1' },
                }),
        );
    });

    it('records channel, viewer key, user and rung on a served segment', async () => {
        const { GET } = mount(adaptiveSegmentDef as EndpointDef, { surface: 'v1' });
        const res = await GET!(event({ liveTvCredentialId: 'device:a' }));
        expect(res.status).toBe(200);
        expect(mockRecord).toHaveBeenCalledWith(CHANNEL, 'alice:device:a', 'alice', '540p2m');
    });

    it('uses the browser cookie key but never mints one', async () => {
        const { GET } = mount(adaptiveSegmentDef as EndpointDef, { surface: 'v1' });
        const withCookie = event({}, 'browser:b1');
        await GET!(withCookie);
        expect(mockRecord).toHaveBeenCalledWith(CHANNEL, 'alice:browser:b1', 'alice', '540p2m');

        mockRecord.mockClear();
        const noCookie = event({});
        expect((await GET!(noCookie)).status).toBe(200);
        expect(mockRecord).not.toHaveBeenCalled();
        expect(noCookie.cookies.set).not.toHaveBeenCalled();
    });

    it('records nothing when the proxy fails', async () => {
        proxyClient.proxyHlsAdaptiveSegment.mockResolvedValue(new Response(null, { status: 404 }));
        const { GET } = mount(adaptiveSegmentDef as EndpointDef, { surface: 'v1' });
        expect((await GET!(event({ liveTvCredentialId: 'device:a' }))).status).toBe(502);
        expect(mockRecord).not.toHaveBeenCalled();
    });
});
