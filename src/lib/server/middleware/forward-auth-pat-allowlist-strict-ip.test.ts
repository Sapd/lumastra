// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for security review 2026-09-12, C15 — the PAT `allowed_ips`
 * check (and the `last_used_ip` value persisted alongside it) must be driven
 * by the STRICT (non-spoofable) client IP, not the implicit-trust
 * `getClientIp`. When `TRUSTED_PROXY_IPS` is unset, `getClientIp` honors an
 * attacker-supplied `X-Forwarded-For` by implicit proxy trust, so a thief of
 * an IP-bound token could forge the header to satisfy the allowlist from any
 * peer.
 *
 * Modeled on `forward-auth-rate-limit-strict-ip.test.ts` (H8): drives the
 * full `handlePatAuth` flow through `resolveAuth`, with `pat.service.js`
 * mocked to reproduce the real `isIpAllowed()` contract (reject unless the
 * `clientIp` argument it receives matches the token's allowlist) — so the
 * test proves WHICH ip forward-auth hands to the service, without needing the
 * service's own database/cache plumbing.
 *
 * Deliberately does NOT mock `$lib/server/utils/client-ip.js` — the real
 * module is exercised so the strict-vs-spoofable distinction is genuine.
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
    getCachedDeleted: () => null,
    setCachedDeleted: () => {},
    getCachedUserId: () => '00000000-0000-0000-0000-0000000000aa',
    setCachedUserId: () => {},
    getCachedGroups: () => null,
    setCachedGroups: () => {},
    invalidateUserAdminCache: () => {},
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => null) },
}));

vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: 0, total: 1 })),
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

// resolveTokenUserAccess() (now also consulted by handlePatAuth for the
// age-rating axis — security review C9/C10, 2026-09-15/16) resolves the
// owner's row via getUserByUsername, not through the Database mock above
// (whose empty-array stub would otherwise read as "no such user" and deny
// every PAT in this file with a 401 before the IP-allowlist logic under test
// ever runs).
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: async (username: string) => ({
        id: '11111111-1111-1111-1111-111111111111',
        username,
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        groups: [] as string[],
        disabled_at: null,
        deleted_at: null,
    }),
}));

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: async (
        _sql: unknown,
        _userId: string,
        syncedGroups: readonly string[],
    ) => ({ inAppGroupNames: [], effectiveGroups: [...syncedGroups], capabilities: {} }),
}));

const { MAX_AGE_MISS_SENTINEL } = vi.hoisted(() => ({
    MAX_AGE_MISS_SENTINEL: Symbol('max-age-miss'),
}));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
    getCachedMaxAge: () => MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: () => {},
}));

// The PAT this attacker is trying to use is bound to 203.0.113.5. Reproduces
// the real service's isIpAllowed() contract: reject unless the `clientIp`
// argument matches an allowlist entry. Recording every call lets the tests
// assert WHICH ip forward-auth actually passed in.
const ALLOWED_IP = '203.0.113.5';
const patValidateCalls: Array<{ token: string; clientIp: string | undefined }> = [];
const mockPatValidate = vi.fn(async (token: string, clientIp?: string) => {
    patValidateCalls.push({ token, clientIp });
    if (clientIp !== ALLOWED_IP) return null;
    return {
        id: 1,
        userId: '11111111-1111-1111-1111-111111111111',
        username: 'alice',
        name: 'alice-pat',
        scopes: ['read'],
        groups: [] as string[],
        jellyfinUserId: null,
        tokenPrefix: 'pat_abc',
        allowedIps: [ALLOWED_IP],
    };
});
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        validate: (...args: [string, string?]) => mockPatValidate(...args),
        hasScope: () => true,
    }),
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn() }),
}));

vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({ validate: vi.fn(), getStatus: vi.fn() }),
}));

// NOTE: $lib/server/utils/client-ip.js is intentionally NOT mocked — see the
// file doc comment above.

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makePatBearerEvent(opts: { peer: string; xff?: string }): RequestEvent {
    const url = new URL('http://localhost/api/v1/media');
    const headers = new Headers();
    headers.set('authorization', 'Bearer pat_abc123');
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
    patValidateCalls.length = 0;
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('C15 — PAT allowed_ips check uses the strict (non-spoofable) client IP', () => {
    it('a thief presenting the token from an untrusted peer, with a forged X-Forwarded-For matching the allowlist, is REJECTED', async () => {
        const event = makePatBearerEvent({ peer: '10.0.0.9', xff: ALLOWED_IP });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
        // The service was called with the RAW peer, not the forged header —
        // proving forward-auth passes the strict IP, not getClientIp.
        expect(patValidateCalls).toHaveLength(1);
        expect(patValidateCalls[0].clientIp).toBe('10.0.0.9');
        expect(event.locals.user).toBeUndefined();
    });

    it('the legitimate owner, presenting the token directly from the allowed IP (no proxy involved), is ACCEPTED', async () => {
        const event = makePatBearerEvent({ peer: ALLOWED_IP });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(patValidateCalls).toHaveLength(1);
        expect(patValidateCalls[0].clientIp).toBe(ALLOWED_IP);
        expect(event.locals.user?.username).toBe('alice');
    });
});
