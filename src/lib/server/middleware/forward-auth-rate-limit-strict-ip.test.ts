// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for H8 / M17 on the /api/v1 failed-auth rate-limit bucket
 * (`maybeRateLimitFailedAuth` in forward-auth.ts, driven end-to-end through
 * `resolveAuth`).
 *
 * H8 — the bucket key must use the STRICT (non-spoofable) client IP
 * (`getClientIpStrict`), not the implicit-trust `getClientIp`. When
 * `TRUSTED_PROXY_IPS` is unset, `getClientIp` honors an attacker-supplied
 * `X-Forwarded-For` by implicit proxy trust, so keying the bucket on it would
 * let an attacker rotate `X-Forwarded-For` per request to dodge the limit.
 * `getClientIpStrict` falls back to the raw TCP peer in that case, so every
 * request from the same peer lands in the same bucket regardless of XFF.
 *
 * M17 — when the rate-limit backend throws (Valkey outage), the original 401
 * must still surface unchanged (fail-open) for every request in the burst.
 *
 * Deliberately does NOT mock `$lib/server/utils/client-ip.js` — the real
 * module is exercised so the strict-vs-spoofable distinction is genuine
 * rather than asserted against a mock. Relies on `TRUSTED_PROXY_IPS` being
 * unset in the test environment (not set by any project vitest config/.env —
 * see client-ip.test.ts for the equivalent module-level unit tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: { FEATURE_JELLYFIN_COMPAT: false },
    features: { deviceAuth: true },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
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

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: () => null,
    setCachedIsAdmin: () => {},
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: () => null,
    setCachedDisabled: () => {},
    getCachedUserId: () => '00000000-0000-0000-0000-0000000000aa',
    setCachedUserId: () => {},
    invalidateUserAdminCache: () => {},
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => null) },
}));

vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => true),
    getKeysByPattern: vi.fn(async () => []),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): () => Promise<unknown[]> {
            return vi.fn(async () => []);
        }
    }
    return { Database: MockDatabase };
});

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn(), hasScope: () => true }),
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn() }),
}));

vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({ validate: vi.fn(), getStatus: vi.fn() }),
}));

// Every Bearer token fails verification -> the resolveAuth /api/v1 JWT path
// always returns a 401, which is exactly the response maybeRateLimitFailedAuth
// gates on.
const mockVerifyAccessToken = vi.fn<(token: string) => Promise<null>>(async () => null);
vi.mock('$lib/server/oauth/jwt.js', () => ({
    verifyAccessToken: (...args: [string]) => mockVerifyAccessToken(...args),
}));

// Fixed-window counter keyed on whatever string checkRateLimit is called
// with — lets the tests assert bucket IDENTITY (the same key hit N+1 times)
// without depending on Valkey/memory-store internals.
const rateLimitCounts = new Map<string, number>();
let rateLimitShouldThrow = false;
const mockCheckRateLimit = vi.fn(async (key: string, limit: number, _windowSeconds: number) => {
    if (rateLimitShouldThrow) throw new Error('Valkey unreachable');
    const count = (rateLimitCounts.get(key) ?? 0) + 1;
    rateLimitCounts.set(key, count);
    return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        resetAt: 9999999999,
        total: limit,
    };
});
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...args: [string, number, number]) => mockCheckRateLimit(...args),
}));

// NOTE: $lib/server/utils/client-ip.js is intentionally NOT mocked — see the
// file doc comment above.

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeBadBearerEvent(opts: { peer: string; xff?: string }): RequestEvent {
    const url = new URL('http://localhost/api/v1/media');
    const headers = new Headers();
    headers.set('authorization', 'Bearer not-a-real-token');
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
    mockVerifyAccessToken.mockResolvedValue(null);
    rateLimitCounts.clear();
    rateLimitShouldThrow = false;
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('H8 — /api/v1 failed-auth rate-limit bucket keys on the strict (non-spoofable) IP', () => {
    it('N+1 bad-Bearer requests, each with a DIFFERENT X-Forwarded-For, from the SAME peer collapse into ONE bucket and the (N+1)th is limited', async () => {
        const PEER = '203.0.113.9';
        const LIMIT = 60; // PUBAPI_FAILED_AUTH_LIMIT_PER_MINUTE

        const responses: Response[] = [];
        for (let i = 0; i < LIMIT + 1; i++) {
            const event = makeBadBearerEvent({ peer: PEER, xff: `198.51.100.${i % 255}` });
            const result = await resolveAuth(event, noopMigration, true);
            expect(result).toBeInstanceOf(Response);
            responses.push(result as Response);
        }

        // First LIMIT requests: normal 401s (bucket not yet exhausted).
        for (let i = 0; i < LIMIT; i++) {
            expect(responses[i].status).toBe(401);
        }
        // The (LIMIT+1)th request from the SAME peer must be rate-limited —
        // proving all LIMIT+1 attempts shared one bucket keyed on the peer,
        // not on the attacker-rotated XFF.
        expect(responses[LIMIT].status).toBe(429);

        // Exactly one distinct rate-limit key was ever used, despite LIMIT+1
        // distinct XFF values.
        expect(rateLimitCounts.size).toBe(1);
        const [key] = [...rateLimitCounts.keys()];
        expect(key).toBe(`apiv1:auth_fail:${PEER}`);
    });

    it('two requests with different XFF values from the same peer both count against the SAME bucket', async () => {
        const PEER = '203.0.113.9';
        const event1 = makeBadBearerEvent({ peer: PEER, xff: '1.1.1.1' });
        const event2 = makeBadBearerEvent({ peer: PEER, xff: '2.2.2.2' });

        await resolveAuth(event1, noopMigration, true);
        await resolveAuth(event2, noopMigration, true);

        expect(rateLimitCounts.get(`apiv1:auth_fail:${PEER}`)).toBe(2);
    });
});

describe('M17 — rate-limit fails OPEN when checkRateLimit throws (Valkey outage)', () => {
    it('N+1 bad-Bearer requests all still return 401 unchanged when the rate-limit backend is down', async () => {
        rateLimitShouldThrow = true;
        const PEER = '203.0.113.10';

        for (let i = 0; i < 5; i++) {
            const event = makeBadBearerEvent({ peer: PEER });
            const result = await resolveAuth(event, noopMigration, true);
            expect(result).toBeInstanceOf(Response);
            expect((result as Response).status).toBe(401);
        }
    });
});
