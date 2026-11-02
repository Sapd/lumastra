// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security fix C15 (2026-09-16): `POST /play-sessions` used to feed the
 * `require_single_ip` anti-sharing gate with the LAX client-IP resolver
 * (`getClientIpFromRequest`), which — with `TRUSTED_PROXY_IPS` unset, the
 * default posture — honors `X-Forwarded-For` from ANY peer (implicit proxy
 * trust). A second device sharing the same credential could forge an XFF
 * matching the first session's IP and make `ip_address != ip_address`
 * evaluate false forever, silently defeating the admin-configured
 * anti-sharing control. The 422 body also handed back the victim's real IP
 * (`allowed_ip`) for the attacker to copy.
 *
 * This test does NOT mock `$lib/server/utils/client-ip.js` — the IP
 * resolution itself is the seam under test ("assert at the mint", not by
 * mocking the resolver away). Everything else the handler touches (DB
 * handle, kick-cooldown, media-access gate, the service call, lifecycle
 * notification) is mocked so the real `startPlaySession` policy logic never
 * runs; this test only proves what `ip_address` the def computes and hands
 * to it, and what the 422 body contains — mirroring the seam-testing
 * standard set for this round (global-constraints.md §2).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const SQL = {} as never;

function makeEvent(opts: { peer: string; xForwardedFor?: string }) {
    const headers = new Headers();
    if (opts.xForwardedFor) headers.set('x-forwarded-for', opts.xForwardedFor);
    return {
        request: new Request('https://app.example/api/play-sessions', {
            method: 'POST',
            headers,
        }),
        getClientAddress: () => opts.peer,
        locals: {
            user: { userId: 'uid-alice', username: 'alice' },
            principal: undefined,
        },
    } as never;
}

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

function invoke(event: ReturnType<typeof makeEvent>) {
    return def.handlers.POST!(event, { input: { body: BODY } } as never);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSql.mockResolvedValue(SQL);
    mockCheckSessionKickCooldown.mockResolvedValue({ kicked: false });
    mockCheckMediaAccess.mockResolvedValue(true);
});

describe('POST /play-sessions — client-IP resolution feeding require_single_ip (C15)', () => {
    it('uses the STRICT resolver: a forged X-Forwarded-For matching a prior peer does not collapse a genuinely different peer to the same ip_address', async () => {
        mockStartPlaySession.mockResolvedValue(playbackStartFixture());

        // Session 1: legitimate device at peer 203.0.113.5.
        await invoke(makeEvent({ peer: '203.0.113.5' }));
        const ipArgSession1 = mockStartPlaySession.mock.calls[0]?.[3];
        expect(ipArgSession1).toBe('203.0.113.5');

        mockStartPlaySession.mockClear();

        // Session 2: a genuinely DIFFERENT peer (a second device sharing the
        // credential), forging X-Forwarded-For to match session 1's IP in an
        // attempt to defeat require_single_ip. TRUSTED_PROXY_IPS is unset in
        // this test env (the default/vulnerable posture) — the LAX resolver
        // would honor the forged header from any peer; the strict resolver
        // must ignore it and report the true, different peer.
        await invoke(makeEvent({ peer: '198.51.100.9', xForwardedFor: '203.0.113.5' }));
        const ipArgSession2 = mockStartPlaySession.mock.calls[0]?.[3];

        // The mint must report the REAL peer, not the spoofed header — proving
        // require_single_ip (which compares this value against the first
        // session's stored ip_address) still sees them as different clients.
        expect(ipArgSession2).toBe('198.51.100.9');
        expect(ipArgSession2).not.toBe(ipArgSession1);
    });

    it('does not echo allowed_ip back in the 422 body on an ip_restriction refusal', async () => {
        mockStartPlaySession.mockResolvedValue({
            kind: 'ip_restriction',
            allowed_ip: '203.0.113.5',
            grace_remaining_seconds: 30,
        });

        const res = await invoke(makeEvent({ peer: '198.51.100.9' }));
        expect(res.status).toBe(422);
        const responseBody = (await res.json()) as { code: string; details: object };
        expect(responseBody.code).toBe('ip_restricted');
        const details = responseBody.details;

        expect(details).not.toHaveProperty('allowed_ip');
        expect(details).toHaveProperty('graceRemainingSeconds', 30);
    });
});

describe('POST /play-sessions — start contract', () => {
    it('returns a stable 422 prefetch refusal with a normal-start fallback', async () => {
        mockStartPlaySession.mockResolvedValue({ kind: 'prefetch_requires_current_session' });
        const response = await def.handlers.POST!(makeEvent({ peer: '203.0.113.5' }), {
            input: { body: { ...BODY, purpose: 'prefetch' } },
        } as never);
        expect(response.status).toBe(422);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(await response.json()).toMatchObject({
            code: 'prefetch_requires_current_session', status: 422,
            details: { suggestion: 'Start with purpose=play' },
        });
        expect(mockNotifySessionStarted).not.toHaveBeenCalled();
    });

    it('returns the envelope and announces its Lumastra session id', async () => {
        mockStartPlaySession.mockResolvedValue(playbackStartFixture());
        const response = await invoke(makeEvent({ peer: '203.0.113.5' }));
        expect(response.status).toBe(201);
        expect(await response.json()).toEqual(playbackStartFixture());
        expect(mockNotifySessionStarted).toHaveBeenCalledWith(
            'uid-alice',
            playbackStartFixture().playbackSessionId,
            BODY.mediaId,
        );
    });

    it.each([false, true])(
        'threads principal admin provenance and request surface (%s)',
        async (isAdmin) => {
            mockStartPlaySession.mockResolvedValue(playbackStartFixture());
            const event = makeEvent({ peer: '203.0.113.5' });
            Object.assign((event as unknown as { locals: object }).locals, {
                principal: { kind: 'pat', isAdmin },
            });
            await def.handlers.POST!(event, {
                surface: 'internal',
                input: { body: BODY },
            } as never);
            expect(mockStartPlaySession.mock.calls[0][6]).toMatchObject({
                mintedByAdmin: isAdmin,
                surface: 'internal',
            });
        },
    );

    it('enforces access before starting any kind', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const response = await invoke(makeEvent({ peer: '203.0.113.5' }));
        expect(response.status).toBe(404);
        expect(mockStartPlaySession).not.toHaveBeenCalled();
    });

    it('returns a start failure without issuing a successful envelope', async () => {
        mockStartPlaySession.mockResolvedValue({ status: 503, message: 'Upstream unavailable' });
        expect((await invoke(makeEvent({ peer: '203.0.113.5' }))).status).toBe(503);
        expect(mockNotifySessionStarted).not.toHaveBeenCalled();
    });
});
