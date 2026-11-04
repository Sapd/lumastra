// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression (Helm router, 3d37f8e1f2 failed on a real cluster): the router-hop verdict was keyed on
 * the Request object, but Paraglide's middleware hands the rest of the chain a CLONED Request, so the
 * play-sessions def minted the grant's client IP from the TCP peer (a router pod) while the media
 * request, checked in forward-auth.ts via getClientIpStrict, resolved the forwarded client. Every
 * grant then failed with 403 ip_mismatch.
 *
 * This goes through the REAL mount() path and the REAL client-ip resolver (nothing about IP
 * resolution is mocked), simulating the hooks chain: runWithRouterHop(original request) around a
 * handler that swaps in a clone, exactly like paraglideHandle does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playbackStartFixture } from '$lib/schemas/playback-start.test-fixture.js';

const mockGetSql = vi.fn();
const mockCheckSessionKickCooldown = vi.fn();
const mockCheckMediaAccess = vi.fn();
const mockStartPlaySession = vi.fn();
const mockNotifySessionStarted = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => mockGetSql() },
}));
vi.mock('$lib/server/services/session-kill.service.js', () => ({
    checkSessionKickCooldown: (...a: unknown[]) => mockCheckSessionKickCooldown(...a),
}));
vi.mock('$lib/server/middleware/media-access.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/middleware/media-access.js')>();
    return {
        ...actual,
        checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
    };
});
vi.mock('$lib/server/services/play-sessions.service.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/play-sessions.service.js')>();
    return {
        ...actual,
        startPlaySession: (...a: unknown[]) => mockStartPlaySession(...a),
    };
});
vi.mock('$lib/server/services/play-session-lifecycle.service.js', () => ({
    getPlaySessionLifecycleService: () => ({ notifySessionStarted: mockNotifySessionStarted }),
}));

import { def } from './index.js';
import { principalLocals } from '$lib/server/api/principal-locals.test-helpers.js';
import { mount } from '$lib/server/api/mount.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { deriveRouterHopSecret, runWithRouterHop } from '$lib/server/utils/router-hop.js';

const KEY = 'f'.repeat(64);
const SECRET = deriveRouterHopSecret(KEY);
const CLIENT = '203.0.113.9';

const BODY = {
    mediaId: '00000000-0000-4000-a000-000000000001',
    deviceId: 'device-1',
    capabilities: {
        containers: ['mp4'],
        videoCodecs: ['h264'],
        audioCodecs: ['aac'],
        subtitleFormats: ['vtt'],
        hdr: [],
    },
};

/** What the router forwards: client in X-Forwarded-For, hop secret, TCP peer = a router pod. */
function routerRequest(path: string, init: { hop?: string; xff?: string; body?: unknown } = {}) {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('x-forwarded-for', init.xff ?? CLIENT);
    if (init.hop !== undefined) headers.set('x-lumastra-router-hop', init.hop);
    return new Request(`https://app.example${path}`, {
        method: init.body ? 'POST' : 'GET',
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
    });
}

/** paraglideHandle: event.request = <clone with the same headers/body>. */
function paraglideClone(request: Request): Request {
    return new Request(request.url, {
        method: request.method,
        headers: new Headers(request.headers),
        body: request.body,
        // @ts-expect-error duplex is required for requests with a body
        duplex: 'half',
    });
}

function makeEvent(request: Request, peer: string) {
    return {
        request,
        url: new URL(request.url),
        params: {},
        route: { id: '/api/v1/play-sessions' },
        getClientAddress: () => peer,
        platform: undefined,
        locals: principalLocals({ kind: 'session', ownerIsAdmin: false }),
    };
}

const savedKey = process.env.LUMASTRA_MASTER_KEY;
beforeEach(() => {
    process.env.LUMASTRA_MASTER_KEY = KEY;
    vi.clearAllMocks();
    mockGetSql.mockResolvedValue({} as never);
    mockCheckSessionKickCooldown.mockResolvedValue({ kicked: false });
    mockCheckMediaAccess.mockResolvedValue(true);
    mockStartPlaySession.mockResolvedValue(playbackStartFixture());
});
afterEach(() => {
    if (savedKey === undefined) delete process.env.LUMASTRA_MASTER_KEY;
    else process.env.LUMASTRA_MASTER_KEY = savedKey;
});

const POST = mount(def, { surface: 'v1' }).POST!;

/** The hooks chain for one inbound request: scope around the rest, Request swapped by Paraglide. */
async function throughHooks<T>(
    original: Request,
    peer: string,
    next: (event: ReturnType<typeof makeEvent>) => Promise<T>,
): Promise<T> {
    const event = makeEvent(original, peer);
    return runWithRouterHop(original, async () => {
        event.request = paraglideClone(event.request);
        return next(event);
    });
}

describe('mint (real mount + play-sessions def) and check agree for one hop-authenticated client', () => {
    it('mints the forwarded client IP although Paraglide replaced the Request', async () => {
        const original = routerRequest('/api/v1/play-sessions', { hop: SECRET, body: BODY });
        const res = await throughHooks(original, '10.42.0.52', async (event) =>
            POST(event as never),
        );
        expect(res.status, await res.clone().text()).toBe(201);
        expect(mockStartPlaySession.mock.calls[0]?.[3]).toBe(CLIENT);
    });

    it('the media request through the OTHER router pod resolves the same address as the mint', async () => {
        const mint = await throughHooks(
            routerRequest('/api/v1/play-sessions', { hop: SECRET, body: BODY }),
            '10.42.0.52',
            async (event) => {
                await POST(event as never);
                return mockStartPlaySession.mock.calls[0]?.[3] as string;
            },
        );
        for (const pod of ['10.42.0.52', '10.42.1.77']) {
            const check = await throughHooks(
                routerRequest('/api/playback/abc/file', { hop: SECRET }),
                pod,
                // forward-auth.ts handleStreamToken: getClientIpStrict(event)
                async (event) => getClientIpStrict(event as never),
            );
            expect(check).toBe(mint);
        }
        expect(mint).toBe(CLIENT);
    });

    it('without a valid hop both sides use the TCP peer, a forged X-Forwarded-For counts for nothing', async () => {
        for (const hop of [undefined, 'forged']) {
            mockStartPlaySession.mockClear();
            const original = routerRequest('/api/v1/play-sessions', {
                hop,
                xff: '6.6.6.6',
                body: BODY,
            });
            const mint = await throughHooks(original, '10.42.0.200', async (event) => {
                await POST(event as never);
                return mockStartPlaySession.mock.calls[0]?.[3] as string;
            });
            const check = await throughHooks(
                routerRequest('/api/playback/abc/file', { hop, xff: '6.6.6.6' }),
                '10.42.0.200',
                async (event) => getClientIpStrict(event as never),
            );
            expect(mint).toBe('10.42.0.200');
            expect(check).toBe('10.42.0.200');
        }
    });

    it('an internal sub-request does not inherit the outer verdict: both sides fall back to the peer', async () => {
        const outer = routerRequest('/api/v1/play-sessions', { hop: SECRET });
        const inner = await throughHooks(outer, '10.42.0.52', async () => {
            // event.fetch re-enters the handle chain with its own request (here carrying a
            // client-looking X-Forwarded-For but no hop secret).
            const sub = routerRequest('/api/v1/other', { xff: '6.6.6.6' });
            return throughHooks(sub, '127.0.0.1', async (event) =>
                getClientIpStrict(event as never),
            );
        });
        expect(inner).toBe('127.0.0.1');
    });

    it('the secret header is gone for every later reader', async () => {
        const original = routerRequest('/api/v1/play-sessions', { hop: SECRET });
        const seen = await throughHooks(original, '10.42.0.52', async (event) => [
            event.request.headers.get('x-lumastra-router-hop'),
            original.headers.get('x-lumastra-router-hop'),
        ]);
        expect(seen).toEqual([null, null]);
    });
});
