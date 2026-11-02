// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Migrated audiobook start IP tests for POST /play-sessions.
 *
 * Security review P2: the `clientIp` this def hands to `openAudiobookSession`
 * becomes the stream token's IP binding, which `audiobook-stream-routes.ts`
 * later validates against using the SAME strict resolver (see
 * `audiobook-stream-routes.strict-ip.test.ts`). If the mint side used the
 * implicit-trust `getClientIp` instead, a listener behind an unpinned reverse
 * proxy would mint under an attacker-controllable XFF-derived IP; worse, mint
 * and validate would disagree whenever only one of the two used the strict
 * resolver. This test pins that the def passes the STRICT (non-spoofable)
 * peer, not a forged `X-Forwarded-For`, mirroring the shape of
 * `audiobook-stream-routes.strict-ip.test.ts` and
 * `forward-auth-stream-token-strict-ip.test.ts`: mock the downstream call to
 * record which `clientIp` it received, and deliberately do NOT mock
 * `$lib/server/utils/client-ip.js` so the strict-vs-spoofable distinction is
 * genuine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import { playbackStartFixture } from '$lib/schemas/playback-start.test-fixture.js';

const BOUND_IP = '203.0.113.7';

const openSessionCalls: Array<{ clientIp: string }> = [];
const mockStartPlaybackSession = vi.fn(
    async (
        _sql: unknown,
        _userId: unknown,
        _username: unknown,
        clientIp: string,
        ..._context: unknown[]
    ) => {
        openSessionCalls.push({ clientIp });
        return {
            ...playbackStartFixture(),
            kind: 'audiobook' as const,
            delivery: {
                kind: 'multipart-audio' as const,
                tracks: [],
                chapters: [],
                startPositionMs: 0,
                durationMs: null,
            },
        };
    },
);
vi.mock('$lib/server/services/play-sessions.service.js', () => ({
    startPlaySession: (...args: [unknown, unknown, unknown, string, ...unknown[]]) =>
        mockStartPlaybackSession(...args),
    isPolicyError: () => false,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/services/session-kill.service.js', () => ({
    checkSessionKickCooldown: async () => ({ kicked: false }),
}));
vi.mock('$lib/server/services/play-session-lifecycle.service.js', () => ({
    getPlaySessionLifecycleService: () => ({ notifySessionStarted: vi.fn() }),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));

vi.mock('$lib/server/config.js', () => ({ config: { APP_VERSION: '1.0.0' } }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// NOTE: $lib/server/utils/client-ip.js is intentionally NOT mocked — the real
// getClientIpStrictFromRequest must be exercised for this test to mean
// anything.

const { def } = await import('./index.js');

function makeEvent(opts: { peer: string; xff?: string }): RequestEvent {
    const url = new URL('http://localhost/api/play-sessions');
    const headers = new Headers({ 'content-type': 'application/json' });
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    const request = new Request(url, { method: 'POST', headers });

    return {
        request,
        url,
        params: {},
        locals: {
            user: { userId: 'user-1', username: 'alice' },
            principal: undefined,
            authMethod: undefined,
            accessToken: undefined,
            deviceSessionId: undefined,
        },
        getClientAddress: () => opts.peer,
    } as unknown as RequestEvent;
}

function ctxWithBody(): ApiContext {
    return {
        surface: 'v1',
        input: {
            body: {
                mediaId: playbackStartFixture().mediaId,
                deviceId: 'device-1',
                capabilities: {
                    containers: ['mp4'],
                    videoCodecs: [],
                    audioCodecs: ['aac'],
                    subtitleFormats: [],
                    hdr: [],
                },
            },
        },
    } as unknown as ApiContext;
}

const POST = def.handlers.POST!;

beforeEach(() => {
    vi.clearAllMocks();
    openSessionCalls.length = 0;
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('P2 — audiobook session mint uses the strict (non-spoofable) client IP', () => {
    it('a forged X-Forwarded-For does NOT change the IP the session (and its stream token) is bound to', async () => {
        const event = makeEvent({ peer: BOUND_IP, xff: '198.51.100.42' /* forged */ });

        const response = await POST(event, ctxWithBody());

        expect(response.status).toBe(201);
        expect(openSessionCalls).toHaveLength(1);
        // The raw peer, not the attacker-controlled header, must be what the
        // session — and therefore the stream token's IP binding — is minted
        // under.
        expect(openSessionCalls[0].clientIp).toBe(BOUND_IP);
    });

    it('with no X-Forwarded-For at all, the peer address is used directly', async () => {
        const event = makeEvent({ peer: BOUND_IP });

        await POST(event, ctxWithBody());

        expect(openSessionCalls[0]!.clientIp).toBe(BOUND_IP);
    });
});

it('passes the request User-Agent as diagnostic context without changing authentication', async () => {
    const event = makeEvent({ peer: BOUND_IP });
    event.request.headers.set('user-agent', 'Apple test agent');
    await POST(event, ctxWithBody());
    expect(mockStartPlaybackSession).toHaveBeenCalledWith(
        expect.anything(),
        'user-1',
        'alice',
        BOUND_IP,
        expect.anything(),
        'unknown',
        expect.objectContaining({ userAgent: 'Apple test agent', mintedByAdmin: false }),
    );
});
