// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for security review P2 — stream-token IP pinning must use the
 * STRICT (non-spoofable) client IP at validate, not the implicit-trust
 * `getClientIp`. When `TRUSTED_PROXY_IPS` is unset, `getClientIp` honors an
 * attacker-supplied `X-Forwarded-For` by implicit proxy trust, so a thief of
 * a stream token bound to another IP could forge the header to pass the
 * binding check from any peer.
 *
 * Modeled on `forward-auth-pat-allowlist-strict-ip.test.ts` (C15): drives the
 * full `handleStreamToken` flow through `resolveAuth`, with
 * `streaming-session.service.js` mocked to reproduce the real `validate()`
 * IP-binding contract (reject unless the `clientIp` argument matches the
 * mint-time IP) — so the test proves WHICH ip forward-auth hands to the
 * service, without needing the service's own database/cache plumbing.
 *
 * Deliberately does NOT mock `$lib/server/utils/client-ip.js` — the real
 * module is exercised so the strict-vs-spoofable distinction is genuine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const getLiveSession = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => ({ getPlaybackSession: getLiveSession }),
}));

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: { FEATURE_JELLYFIN_COMPAT: false },
    features: { deviceAuth: true },
}));

const warnGrant = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: warnGrant, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// Identity resolution for the validated session's username — not the
// behaviour under test here (that's the C4 permission resolver, covered in
// resolve-token-user-access.test.ts / forward-auth.test.ts's M13), so both
// are stubbed to a fixed, enabled, unrestricted account.
vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({
    applyLiveTvUserPolicy: vi.fn(async () => undefined),
    isLiveTvRouteId: (id: string) => id.includes('/livetv/'),
    isSyntheticLiveTvIdentity: () => false,
}));
vi.mock('$lib/server/auth/resolve-user-id.js', () => ({
    resolveUserIdByUsername: vi.fn(async () => '00000000-0000-0000-0000-0000000000aa'),
}));
vi.mock('$lib/server/auth/resolve-token-user-access.js', () => ({
    resolveTokenUserAccess: vi.fn(async () => ({
        userGroups: [],
        disabled: false,
        permissions: {
            hasWatchPermission: true,
            hasLiveTvPermission: true,
            hasRequestPermission: true,
            hasReviewPermission: false,
            hasMediaAnnotationPermission: false,
            isAdmin: false,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: false,
            liveTvPriority: 'low',
        },
    })),
}));

// The token under attack was minted while the client's strict IP was peer A
// (BOUND_IP). Reproduces the real service's validate() contract: reject
// unless the `clientIp` argument matches the bound IP. Recording every call
// lets the tests assert WHICH ip forward-auth actually passed in.
const BOUND_IP = '203.0.113.7';
const streamValidateCalls: Array<{ token: string; itemId: string; clientIp: string }> = [];
const mockStreamValidate = vi.fn(async (token: string, itemId: string, clientIp: string) => {
    streamValidateCalls.push({ token, itemId, clientIp });
    if (clientIp !== BOUND_IP) return { reason: 'ip_mismatch', grantId: 'grant-1' };
    return {
        id: 'sess-1',
        username: 'alice',
        userId: 'jellyfin-user-uuid',
        deviceSessionId: null,
        mediaItemId: 'item123',
        isWildcard: false,
        clientIp: BOUND_IP,
        createdAt: new Date(),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
    };
});
const mockStreamGetStatus = vi.fn(async () => ({
    valid: false,
    reason: 'wrong_ip' as const,
}));
vi.mock('$lib/server/services/playback-grant.js', async () => {
    const { resolvePlaybackGrantRoute } = await import('../services/playback-grant-routes.js');
    return {
        resolvePlaybackGrantRoute,
        validatePlaybackGrant: (
            token: string,
            opts: { clientIp: string; route: { mediaId?: string } },
        ) => mockStreamValidate(token, opts.route.mediaId ?? '', opts.clientIp),
    };
});
vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({
        validate: (token: string, itemId: string, clientIp: string) =>
            mockStreamValidate(token, itemId, clientIp),
        getStatus: () => mockStreamGetStatus(),
    }),
}));

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn(), hasScope: () => true }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn() }),
}));
vi.mock('$lib/server/oauth/jwt.js', () => ({
    verifyAccessToken: vi.fn(),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));
vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));
// forward-auth.ts's other (non-stream-token) static imports otherwise pull in
// the real DB/task-registry module graph at import time — mirrors
// forward-auth.test.ts's mock set.
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => null) },
}));
vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): () => Promise<unknown[]> {
            return vi.fn(async () => []);
        }
    }
    return { Database: MockDatabase };
});
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: vi.fn(async () => ({
        inAppGroupNames: [],
        effectiveGroups: [],
        capabilities: {},
    })),
}));
vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: () => null,
    setCachedIsAdmin: () => {},
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: () => null,
    setCachedDisabled: () => {},
    getCachedDeleted: () => null,
    setCachedDeleted: () => {},
    getCachedUserId: () => '00000000-0000-0000-0000-0000000000aa',
    setCachedUserId: () => {},
    invalidateUserAdminCache: () => {},
}));
vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: () => false,
    buildUserPermissions: () => ({
        hasWatchPermission: false,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        isAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    }),
}));

// NOTE: $lib/server/utils/client-ip.js is intentionally NOT mocked — see the
// file doc comment above.

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeStreamTokenEvent(opts: { peer: string; xff?: string; path?: string }): RequestEvent {
    const url = new URL('http://localhost' + (opts.path ?? '/api/v1/playback/item123/hls.m3u8'));
    url.searchParams.set('grant', 'stream_abc123');
    const headers = new Headers();
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    const request = new Request(url, { headers });

    return {
        url,
        request,
        params: {},
        route: { id: url.pathname },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => opts.peer,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

beforeEach(() => {
    vi.clearAllMocks();
    streamValidateCalls.length = 0;
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('P2 — stream-token IP binding uses the strict (non-spoofable) client IP', () => {
    it('a thief presenting the token from an untrusted peer B, with a forged X-Forwarded-For matching the mint peer A, is REJECTED (wrong_ip)', async () => {
        const PEER_B = '198.51.100.42';
        const event = makeStreamTokenEvent({ peer: PEER_B, xff: BOUND_IP });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(403);
        expect((result as Response).headers.get('X-Playback-Grant-Reason')).toBe('ip_mismatch');
        expect(await (result as Response).json()).toMatchObject({
            code: 'ip_mismatch',
            reason: 'ip_mismatch',
        });
        // The service was called with the RAW peer, not the forged header —
        // proving forward-auth passes the strict IP, not getClientIp.
        expect(streamValidateCalls).toHaveLength(1);
        expect(streamValidateCalls[0].clientIp).toBe(PEER_B);
        expect(event.locals.user).toBeUndefined();
    });

    it('the legitimate owner, presenting the token directly from the mint peer (no proxy involved), is ACCEPTED', async () => {
        const event = makeStreamTokenEvent({ peer: BOUND_IP });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(streamValidateCalls).toHaveLength(1);
        expect(streamValidateCalls[0].clientIp).toBe(BOUND_IP);
        expect(event.locals.user?.username).toBe('alice');
    });
});

describe('grant credential boundaries', () => {
    it.each(['stream_token', 'api_key'])('rejects retired %s URL credentials', async (param) => {
        const event = makeStreamTokenEvent({ peer: BOUND_IP });
        event.url.searchParams.delete('grant');
        event.url.searchParams.set(param, 'stream_abc123');
        const result = await resolveAuth(event, noopMigration, true);
        expect(result?.status).toBe(401);
        expect(mockStreamValidate).not.toHaveBeenCalled();
        expect(event.locals.user).toBeUndefined();
    });
    it.each([
        '/api/v1/media/item123/playability',
        '/api/v1/playback/grants/id',
        '/api/v1/music/quick-picks',
    ])('rejects a grant on JSON route %s', async (path) => {
        const event = makeStreamTokenEvent({ peer: BOUND_IP, path });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result?.status).toBe(403);
        expect(result?.headers.get('X-Playback-Grant-Reason')).toBe('wrong_scope');
        expect(mockStreamValidate).not.toHaveBeenCalled();
    });
    it('authenticates an internal API media URL with the same grant validator', async () => {
        const event = makeStreamTokenEvent({ peer: BOUND_IP, path: '/api/playback/item123/hls' });
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(streamValidateCalls).toHaveLength(1);
        expect(event.locals.user?.username).toBe('alice');
    });
});

it.each(['expired', 'revoked', 'ip_mismatch', 'wrong_scope', 'session_ended', 'invalid'] as const)(
    'returns the coarse %s denial and logs only the public grant id',
    async (reason) => {
        mockStreamValidate.mockImplementationOnce(async () => ({
            reason,
            grantId: 'grant-public',
        }));
        const event = makeStreamTokenEvent({ peer: BOUND_IP });
        const response = await resolveAuth(event, noopMigration, true);
        // ip_mismatch and wrong_scope are 403 (problem+json code ip_mismatch / forbidden);
        // every other grant failure is 401 invalid_grant. The reason stays in the body.
        const expectedStatus = reason === 'ip_mismatch' || reason === 'wrong_scope' ? 403 : 401;
        const expectedCode =
            reason === 'ip_mismatch'
                ? 'ip_mismatch'
                : reason === 'wrong_scope'
                  ? 'forbidden'
                  : 'invalid_grant';
        expect(response?.status).toBe(expectedStatus);
        expect(response?.headers.get('Content-Type')).toBe('application/problem+json');
        expect(response?.headers.get('X-Playback-Grant-Reason')).toBe(reason);
        expect(await response?.json()).toMatchObject({ code: expectedCode, reason });
        expect(warnGrant).toHaveBeenCalledWith(
            'Playback grant rejected',
            expect.objectContaining({ grantId: 'grant-public', reason }),
        );
        expect(JSON.stringify(warnGrant.mock.calls)).not.toContain(
            event.url.searchParams.get('grant'),
        );
        expect(event.locals.user).toBeUndefined();
    },
);

it('answers 503 dependency_unavailable, not 401, when the grant check itself throws', async () => {
    mockStreamValidate.mockImplementationOnce(async () => {
        throw new Error('valkey unreachable');
    });
    const event = makeStreamTokenEvent({ peer: BOUND_IP });
    const response = await resolveAuth(event, noopMigration, true);
    expect(response?.status).toBe(503);
    expect(response?.headers.get('X-Playback-Grant-Reason')).toBe('unavailable');
    expect(await response?.json()).toMatchObject({ code: 'dependency_unavailable' });
    expect(event.locals.user).toBeUndefined();
});

it('keeps the admitted Live TV viewer identity when the grant replaces the account credential', async () => {
    getLiveSession.mockResolvedValue({
        sessionId: 'live-session',
        viewerKey: 'alice:pat:original',
        feedId: 'feed',
        state: 'active',
    });
    const event = makeStreamTokenEvent({
        peer: BOUND_IP,
        path: '/api/v1/livetv/channels/feed/stream/master.m3u8?PlaySessionId=live-session',
    });
    expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
    expect(event.locals.liveTvCredentialId).toBe('pat:original');
    const { deriveLiveTvViewerKey, peekLiveTvViewerKey } =
        await import('../services/livetv/livetv-viewer-key.js');
    expect(deriveLiveTvViewerKey(event)).toBe('alice:pat:original');
    expect(peekLiveTvViewerKey(event)).toBe('alice:pat:original');
    expect(event.cookies.set).not.toHaveBeenCalled();
});

it('returns recoverable session-expired 410 only for a confirmed server restart', async () => {
    mockStreamValidate.mockImplementationOnce(async () => ({
        reason: 'session_restarted',
        grantId: 'grant-public',
    }));
    const event = makeStreamTokenEvent({ peer: BOUND_IP });
    const response = await resolveAuth(event, noopMigration, true);

    expect(response?.status).toBe(410);
    expect(response?.headers.get('X-Playback-Grant-Reason')).toBe('session_restarted');
    expect(response?.headers.get('X-Lumastra-Diagnostic-Code')).toBe('session-expired');
    expect(response?.headers.get('X-Lumastra-Session-Terminal')).toBe('false');
    expect(await response?.json()).toMatchObject({ code: 'gone', reason: 'session_restarted' });
    expect(event.locals.user).toBeUndefined();
});

it.each([true, false])(
    'C-1: stream principal applies group permission only for live grants (live=%s)',
    async (live) => {
        const { resolveTokenUserAccess } =
            await import('$lib/server/auth/resolve-token-user-access.js');
        const resolver = vi.mocked(resolveTokenUserAccess);
        const access = await resolver('alice');
        resolver.mockResolvedValueOnce({
            ...access!,
            permissions: { ...access!.permissions, hasLiveTvPermission: false },
        });
        const path = live
            ? '/api/v1/livetv/channels/feed/stream/master.m3u8?PlaySessionId=ps'
            : '/api/v1/playback/item123/hls';
        getLiveSession.mockResolvedValue({ sessionId: 'ps', state: 'active', feedId: 'feed' });
        const event = makeStreamTokenEvent({ peer: BOUND_IP, path });
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.hasLiveTvPermission).toBe(!live);
        expect(resolver).toHaveBeenLastCalledWith('alice', { freshGroups: live });
    },
);
