// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { parseEmbyAuthHeader, withJellyfinAuth } from './middleware';
import type { JellyfinCompatPatAuth } from './pat-auth';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockValidateSession = vi.fn();
const mockRevokeSession = vi.fn();
vi.mock('./auth', () => ({
    validateSession: (...args: unknown[]) => mockValidateSession(...args),
    revokeSession: (...args: unknown[]) => mockRevokeSession(...args),
}));

const mockNotice = vi.fn();
vi.mock('$lib/server/services/notification-events.service.js', () => ({
    publishUserEvent: (...args: unknown[]) => mockNotice(...args),
}));
const mockNoticeThrottle = vi.fn();
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache/valkey.js')>()),
    setIfNotExists: (...args: unknown[]) => mockNoticeThrottle(...args),
}));
const mockRateLimit = vi.fn();
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
const { mockNoticeError } = vi.hoisted(() => ({ mockNoticeError: vi.fn() }));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockNoticeError }),
    },
}));

const mockValidatePat = vi.fn();
vi.mock('./pat-auth', () => ({
    validateJellyfinCompatPat: (...args: unknown[]) => mockValidatePat(...args),
}));

// SECURITY REVIEW 2026-09-16, task 6 (C6 + deleted_at follow-up): middleware.ts
// used to have its OWN hand-rolled is_admin/deleted_at/disabled_at re-check,
// gated on a COLD getCachedIsAdmin — the exact defect this cache mock's
// default value now proves doesn't matter any more. `mockGetCachedIsAdmin`
// defaults to a WARM (non-null) value here, which under the OLD
// implementation would have SKIPPED the live re-check entirely (that was
// the bug). Under the current implementation there is no separate re-check
// to skip: disabled_at/deleted_at are read every time via
// resolveTokenUserAccess() below, unconditional on this cache's warmth — see
// the "disabled/deleted account live re-check" describe block for the test
// that pins this down directly (a WARM isAdmin cache + a disabled/deleted
// user must still 401).
//
// The OTHER user-admin-cache exports below (disabled/deleted/userId/groups)
// are consumed by the REAL resolveTokenUserAccess() the session branch calls
// (security review C9, 2026-09-15/16) — always a miss here, so every test
// exercises resolveTokenUserAccess's DB path via mockGetUserByUsername below,
// deterministically, rather than depending on cross-test cache state.
const mockGetCachedIsAdmin = vi.fn<(username: string) => boolean | null>(() => false);
const mockSetCachedIsAdmin = vi.fn();
vi.mock('$lib/server/cache/user-admin-cache', () => ({
    getCachedIsAdmin: (username: string) => mockGetCachedIsAdmin(username),
    setCachedIsAdmin: (...args: unknown[]) => mockSetCachedIsAdmin(...args),
    // Fix round 1, Important 4: resolveRow() also reads/writes this entry —
    // always a miss, same rationale as the other resolveTokenUserAccess-only
    // entries below.
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: () => null,
    setCachedDisabled: () => {},
    // `deleted_at`'s parallel cache entry (security review 2026-09-16, task 6
    // follow-up) — same "always a miss" rationale as disabled/userId/groups
    // above: every test exercises resolveTokenUserAccess's DB path via
    // mockGetUserByUsername, deterministically.
    getCachedDeleted: () => null,
    setCachedDeleted: () => {},
    getCachedUserId: () => null,
    setCachedUserId: () => {},
    getCachedGroups: () => null,
    setCachedGroups: () => {},
}));

const { MAX_AGE_MISS } = vi.hoisted(() => ({ MAX_AGE_MISS: Symbol('max-age-miss') }));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS,
    getCachedMaxAge: () => MAX_AGE_MISS,
    setCachedMaxAge: () => {},
}));

// DB row(s) returned by the live re-check's `new Database().getSql()` query.
// Only consumed by tests that force a cold cache above.
const mockDbUserRow = vi.fn<() => Array<Record<string, unknown>>>(() => []);
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}),
    Database: class {
        getSql() {
            return async () => mockDbUserRow();
        }
    },
}));

// resolveTokenUserAccess's own DB row read (security review C9, 2026-09-16):
// the session branch now live-resolves groups/admin-pin/age-rating-pin/in-app
// merge via the canonical resolver instead of the session's mint-time
// `session.groups` snapshot. Default row mirrors SESSION_USER so the ~50
// pre-existing tests (which never anticipated this call) keep passing
// unchanged; tests that specifically exercise the age-rating pin or the
// unresolvable-row fail-closed path override this per-test.
const mockGetUserByUsername = vi.fn<(username: string) => Promise<Record<string, unknown> | null>>(
    async (username: string) => ({
        id: '00000000-0000-0000-0000-000000000001',
        username,
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        groups: ['Librarians'],
        disabled_at: null,
        deleted_at: null,
    }),
);
const mockGetUserLiveTvAllowed = vi.fn(async () => true);
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserLiveTvAllowed: () => mockGetUserLiveTvAllowed(),
    getUserByUsername: (username: string) => mockGetUserByUsername(username),
}));

const mockResolveEffectiveAccess = vi.fn(
    async (_sql: unknown, _userId: string, syncedGroups: string[]) => ({
        inAppGroupNames: [] as string[],
        effectiveGroups: syncedGroups,
        capabilities: {},
    }),
);
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: [unknown, string, string[]]) =>
        mockResolveEffectiveAccess(...args),
}));

// resolveTokenUserAccess pulls buildUserPermissions from the REAL auth.js —
// pin a deterministic config so these tests don't depend on the repo's real
// settings.json (mirrors resolve-token-user-access.test.ts's convention).
vi.mock('$lib/server/config.js', () => ({
    config: {
        ADMIN_GROUPS: ['admin-group'],
        AGE_RATING_GROUP_PREFIX: 'age-',
        WATCH_PERMISSION_GROUPS: [],
        LIVETV_GROUPS: [],
        REQUEST_GROUPS: [],
        SOCIAL_REVIEW_GROUPS: [],
        MEDIA_ANNOTATION_GROUPS: [],
        MODERATOR_GROUPS: [],
        LIVETV_HIGH_PRIORITY_GROUPS: [],
    },
    features: {},
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockEventOptions {
    headers?: Record<string, string>;
    searchParams?: Record<string, string>;
    pathname?: string;
    method?: string;
}

function mockEvent(
    opts: MockEventOptions = {},
): Parameters<ReturnType<typeof withJellyfinAuth>>[0] {
    const url = new URL('http://localhost/j/Items');
    if (opts.pathname) {
        url.pathname = opts.pathname;
    }
    for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
        url.searchParams.set(k, v);
    }

    const headerMap = new Map(
        Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );

    const locals: Record<string, unknown> = {};

    return {
        request: {
            headers: {
                get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
            },
            method: opts.method ?? 'GET',
        },
        url,
        locals,
        // Satisfy RequestEvent shape minimally
        params: {},
        route: { id: null },
        cookies: {} as never,
        fetch: fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as Parameters<ReturnType<typeof withJellyfinAuth>>[0];
}

const SESSION_USER = {
    userId: 'aaaaaaaa-0000-4000-a000-000000000001',
    username: 'testuser',
    ownerIsAdmin: false,
    groups: ['Librarians'],
    displayName: 'Testuser',
    deviceId: 'dev-1',
    deviceName: 'iPhone',
    clientName: 'Swiftfin iOS',
    clientVersion: '1.0',
    createdAt: '2024-01-01T00:00:00Z',
};

const PAT_AUTH: JellyfinCompatPatAuth = {
    tokenId: 42,
    userId: toUserId('00000000-0000-0000-0000-000000000001'),
    username: 'testuser',
    groups: 'Librarians',
    userGroups: ['Librarians'],
    ownerIsAdmin: false,
    hasWatchPermission: true,
    hasLiveTvPermission: false,
    isReadOnly: false,
    hasRequestPermission: false,
    hasReviewPermission: false,
    hasMediaAnnotationPermission: false,
    maxAgeRating: null,
    isAgeRestricted: false,
    isModerator: false,
    liveTvPriority: 'low',
};

const PAT_AUTH_READONLY: JellyfinCompatPatAuth = {
    ...PAT_AUTH,
    isReadOnly: true,
};

beforeEach(() => {
    mockGetUserLiveTvAllowed.mockReset().mockResolvedValue(true);
    mockNotice.mockReset();
    mockNotice.mockResolvedValue('inserted');
    mockNoticeThrottle.mockReset();
    mockNoticeThrottle.mockResolvedValue(false);
    mockNoticeError.mockReset();
    mockRateLimit.mockReset();
    mockRateLimit.mockResolvedValue({ allowed: true });
    mockGetCachedIsAdmin.mockReset();
    mockGetCachedIsAdmin.mockReturnValue(false);
    mockSetCachedIsAdmin.mockReset();
    mockDbUserRow.mockReset();
    mockDbUserRow.mockReturnValue([]);
    mockRevokeSession.mockReset();
    mockRevokeSession.mockResolvedValue(undefined);
    mockGetUserByUsername.mockReset();
    mockGetUserByUsername.mockImplementation(async (username: string) => ({
        id: '00000000-0000-0000-0000-000000000001',
        username,
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        groups: ['Librarians'],
        disabled_at: null,
        deleted_at: null,
    }));
    mockResolveEffectiveAccess.mockReset();
    mockResolveEffectiveAccess.mockImplementation(
        async (_sql: unknown, _userId: string, syncedGroups: string[]) => ({
            inAppGroupNames: [],
            effectiveGroups: syncedGroups,
            capabilities: {},
        }),
    );
});

// ---------------------------------------------------------------------------
// parseEmbyAuthHeader tests (existing suite preserved)
// ---------------------------------------------------------------------------

describe('parseEmbyAuthHeader', () => {
    it('parses quoted values (Streamyfin format)', () => {
        const result = parseEmbyAuthHeader(
            'MediaBrowser Client="Streamyfin", Device="iPhone", DeviceId="abc123", Version="0.51.0", Token="mytoken"',
        );
        expect(result.Client).toBe('Streamyfin');
        expect(result.Device).toBe('iPhone');
        expect(result.DeviceId).toBe('abc123');
        expect(result.Version).toBe('0.51.0');
        expect(result.Token).toBe('mytoken');
    });

    it('parses unquoted values (Swiftfin SDK format)', () => {
        const result = parseEmbyAuthHeader(
            'MediaBrowser DeviceId=iOS_064F5E40, Device=iPhone, Client=Swiftfin iOS, Version=1.4.1, Token=abc123def',
        );
        expect(result.DeviceId).toBe('iOS_064F5E40');
        expect(result.Device).toBe('iPhone');
        expect(result.Client).toBe('Swiftfin iOS');
        expect(result.Version).toBe('1.4.1');
        expect(result.Token).toBe('abc123def');
    });

    it('parses mixed quoted and unquoted values', () => {
        const result = parseEmbyAuthHeader(
            'MediaBrowser Client="My App", Token=abc123, Version=1.0',
        );
        expect(result.Client).toBe('My App');
        expect(result.Token).toBe('abc123');
        expect(result.Version).toBe('1.0');
    });

    it('handles Emby prefix', () => {
        const result = parseEmbyAuthHeader('Emby Client="Test", Token="xyz"');
        expect(result.Client).toBe('Test');
        expect(result.Token).toBe('xyz');
    });

    it('handles bare key=value without prefix', () => {
        const result = parseEmbyAuthHeader('Version=1.4.1');
        expect(result.Version).toBe('1.4.1');
    });

    it('handles values with spaces (unquoted device names)', () => {
        const result = parseEmbyAuthHeader(
            "MediaBrowser Client=Swiftfin iOS, Device=Testuser's iPhone, Token=abc",
        );
        expect(result.Client).toBe('Swiftfin iOS');
        expect(result.Device).toBe("Testuser's iPhone");
        expect(result.Token).toBe('abc');
    });

    it('handles empty string', () => {
        const result = parseEmbyAuthHeader('');
        expect(result).toEqual({});
    });

    it('handles 64-char hex tokens', () => {
        const token = 'd362a505db16b31acd5b641dadc351617a6eb63643de438d74643b445da3a0a0';
        const result = parseEmbyAuthHeader(`MediaBrowser Token="${token}"`);
        expect(result.Token).toBe(token);
    });

    it('handles 64-char hex tokens unquoted', () => {
        const token = 'd362a505db16b31acd5b641dadc351617a6eb63643de438d74643b445da3a0a0';
        const result = parseEmbyAuthHeader(`MediaBrowser Token=${token}`);
        expect(result.Token).toBe(token);
    });

    it('handles empty quoted values', () => {
        const result = parseEmbyAuthHeader('MediaBrowser Client="", Token="abc"');
        expect(result.Client).toBe('');
        expect(result.Token).toBe('abc');
    });

    it('is case-insensitive for MediaBrowser prefix', () => {
        const result = parseEmbyAuthHeader('mediabrowser Token=abc');
        expect(result.Token).toBe('abc');
    });
});

// ---------------------------------------------------------------------------
// withJellyfinAuth — session path
// ---------------------------------------------------------------------------

describe('withJellyfinAuth — session path', () => {
    beforeEach(() => {
        mockValidateSession.mockReset();
        mockValidatePat.mockReset();
    });

    it('authenticates via session token in header', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=session-tok',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
        expect(event.locals.authMethod).toBe('jellyfin_compat_session');
        expect(event.locals.user.username).toBe('testuser');
        expect(event.locals.liveTvCredentialId).toBe('jf-device:dev-1');
        expect((event.locals as unknown as Record<string, unknown>).jfToken).toBe('session-tok');
    });

    it('jfDevice.clientVersion prefers the per-request Version header', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=session-tok, Version="0.19.10"',
            },
        });
        await handler(event);
        expect(event.locals.jfDevice?.clientVersion).toBe('0.19.10');
    });

    it('jfDevice.clientVersion falls back to the session version', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        await handler(event);
        expect(event.locals.jfDevice?.clientVersion).toBe('1.0');
    });

    it('jfDevice.clientVersion is null when neither header nor session has one', async () => {
        mockValidateSession.mockResolvedValue({ ...SESSION_USER, clientVersion: '' });
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        await handler(event);
        expect(event.locals.jfDevice?.clientVersion).toBeNull();
    });

    it('fingerprints legacy sessions that have no bound device id', async () => {
        mockValidateSession.mockResolvedValue({ ...SESSION_USER, deviceId: '' });
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        await handler(event);
        expect(event.locals.liveTvCredentialId).toMatch(/^jf-session:[a-f0-9]{64}$/);
        expect(event.locals.liveTvCredentialId).not.toContain('session-tok');
    });

    it('authenticates via session token in query string', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({ searchParams: { api_key: 'session-tok' } });
        const res = await handler(event);
        expect(res.status).toBe(200);
        expect(event.locals.authMethod).toBe('jellyfin_compat_session');
        expect((event.locals as unknown as Record<string, unknown>).jfToken).toBe('session-tok');
    });

    it('session token works even on pat: deny routes', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'), {
            pat: 'deny',
        });
        const event = mockEvent({
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=session-tok',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
        expect(event.locals.authMethod).toBe('jellyfin_compat_session');
    });

    it('returns 401 when no token is provided', async () => {
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent();
        const res = await handler(event);
        expect(res.status).toBe(401);
    });
});

// ---------------------------------------------------------------------------
// withJellyfinAuth — session path: live re-check tears down a disabled or
// soft-deleted account's session (security review 2026-09-13, C2; and
// security review 2026-09-16, task 6, C6 + deleted_at follow-up)
//
// Before task 6, this re-check lived in TWO places: `tokenAccess.disabled`
// below (via resolveTokenUserAccess, unconditional) AND a second, hand-rolled
// `SELECT is_admin, deleted_at, disabled_at` query gated on
// `getCachedIsAdmin(...) === null` — which only read `deleted_at` and
// duplicated (with a DIFFERENT, buggier gate) the `disabled_at` verdict the
// first check already computed correctly. That second block was deleted
// (see middleware.ts's own comment); resolveTokenUserAccess now resolves
// BOTH `disabled` and `deleted` through the same cache/DB seam, and the
// tests below assert the account is denied REGARDLESS of the isAdmin cache's
// state — proving there is no cache-gated backstop left to bypass.
// ---------------------------------------------------------------------------

describe('withJellyfinAuth — session path: disabled/deleted account live re-check (C2, C6)', () => {
    beforeEach(() => {
        mockValidateSession.mockReset();
        mockValidatePat.mockReset();
    });

    it('revokes the session and returns 401 when disabled_at is set', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'testuser',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['Librarians'],
            disabled_at: new Date(),
            deleted_at: null,
        });

        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(event);

        expect(res.status).toBe(401);
        expect(mockRevokeSession).toHaveBeenCalledWith('session-tok');
    });

    it('allows the request through when the live row is active (control case)', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        // Default beforeEach fixture is already active (disabled_at/deleted_at
        // both null) — no override needed.

        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(event);

        expect(res.status).toBe(200);
        expect(mockRevokeSession).not.toHaveBeenCalled();
    });

    // SECURITY REVIEW 2026-09-16, task 6, C6 — the actual finding: the OLD
    // implementation's live re-check was gated on `getCachedIsAdmin(...) ===
    // null`, so a WARM isAdmin cache entry (re-warmed by forward-auth or any
    // token-auth path for this same disabled user, per the finding's proof)
    // silently skipped it. This test pins a WARM isAdmin cache — any
    // non-null value, deliberately NOT the default — alongside a disabled
    // row, and demands 401 anyway.
    it('revokes the session and returns 401 for a disabled user even with a WARM isAdmin cache (C6)', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetCachedIsAdmin.mockReturnValue(true); // warm, and NOT the account's real isAdmin value
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'testuser',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['Librarians'],
            disabled_at: new Date(),
            deleted_at: null,
        });

        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(event);

        expect(res.status).toBe(401);
        expect(mockRevokeSession).toHaveBeenCalledWith('session-tok');
    });

    // The deleted_at equivalent of the C6 test above (security review
    // 2026-09-16, task 6 follow-up — `deleted_at` is `disabled_at`'s sibling
    // lifecycle column, and the pre-fix code's ONLY deleted_at check was the
    // block gated on this same isAdmin cache). RED before the fix: the old
    // code's `resolveTokenUserAccess()` never read `deleted_at` at all, and
    // its own dedicated deleted_at check was skipped by the warm cache here
    // — so a warm-cache soft-deleted user sailed through with 200.
    it('revokes the session and returns 401 for a soft-deleted user even with a WARM isAdmin cache', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetCachedIsAdmin.mockReturnValue(true); // warm
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'testuser',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['Librarians'],
            disabled_at: null,
            deleted_at: new Date(),
        });

        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(event);

        expect(res.status).toBe(401);
        expect(mockRevokeSession).toHaveBeenCalledWith('session-tok');
    });

    it('allows the request through for an active user even with a WARM isAdmin cache (control)', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetCachedIsAdmin.mockReturnValue(true); // warm
        // Default beforeEach fixture is active (disabled_at/deleted_at null).

        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(event);

        expect(res.status).toBe(200);
        expect(mockRevokeSession).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// withJellyfinAuth — session path: the admin age-rating pin is no longer
// frozen for the 30-day session TTL (security review C9, 2026-09-15/16)
// ---------------------------------------------------------------------------

describe('withJellyfinAuth — session path: live age-rating pin (C9)', () => {
    beforeEach(() => {
        mockValidateSession.mockReset();
        mockValidatePat.mockReset();
    });

    it('a pinned user (age_rating_pinned=true, max_age_rating=6, no age group) yields isAgeRestricted:true, maxAgeRating:6', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'testuser',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: 6,
            age_rating_pinned: true,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });

        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(event);

        expect(res.status).toBe(200);
        expect(event.locals.user.isAgeRestricted).toBe(true);
        expect(event.locals.user.maxAgeRating).toBe(6);
    });

    it('an admin lowering the cap mid-session is reflected on the very next request — the session is not frozen for its 30-day TTL', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        // First request: unrestricted (matches the beforeEach default row).
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const firstEvent = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        await handler(firstEvent);
        expect(firstEvent.locals.user.isAgeRestricted).toBe(false);

        // Admin lowers the cap via the PATCH path — simulated here by the DB
        // row changing (the admin route's invalidateUserMaxAgeCache() call is
        // what makes this visible in production; see its own coverage in
        // resolve-token-user-access.test.ts's "L1 cache" describe block).
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'testuser',
            is_admin: false,
            admin_pinned: false,
            max_age_rating: 6,
            age_rating_pinned: true,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });

        const secondEvent = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(secondEvent);

        expect(res.status).toBe(200);
        expect(secondEvent.locals.user.isAgeRestricted).toBe(true);
        expect(secondEvent.locals.user.maxAgeRating).toBe(6);
    });

    // FIX ROUND 1 (CRITICAL 1, security review 2026-09-16): resolveTokenUserAccess()
    // returns the SAME `null` for "no such users row" and "DB unreachable on a
    // cold cache" — this middleware cannot tell them apart, so it must NOT
    // revoke the Valkey session on this path. Revoking here would mean a
    // single Postgres restart/failover destroys every /j client's session
    // that happens to hit it mid-outage, forcing a password re-entry on every
    // affected TV device once the DB recovers. Denying the single request
    // (401) without touching the session is the fail-closed-but-not-destructive
    // choice: a genuinely deleted user keeps failing this same check forever
    // (functionally revoked), and a transient outage self-heals on retry.
    it('denies the request (401) WITHOUT revoking the session when the token user access is unresolvable', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetUserByUsername.mockResolvedValue(null);

        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(event);

        expect(res.status).toBe(401);
        expect(mockRevokeSession).not.toHaveBeenCalled();
    });

    it('a transient DB error self-heals: the session still works on the next request once the DB recovers', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'));

        // First request: DB throws (simulating a Postgres restart/failover).
        mockGetUserByUsername.mockRejectedValueOnce(
            Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
        );
        const firstEvent = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const firstRes = await handler(firstEvent);
        expect(firstRes.status).toBe(503);
        expect(firstRes.headers.get('Retry-After')).toBe('5');
        expect(await firstRes.json()).toMatchObject({ code: 'dependency_unavailable' });
        expect(mockRevokeSession).not.toHaveBeenCalled();

        // Second request, same unmodified session token: DB is back.
        const secondEvent = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const secondRes = await handler(secondEvent);
        expect(secondRes.status).toBe(200);
        expect(mockRevokeSession).not.toHaveBeenCalled();
    });

    // FIX ROUND 1 (Important #4, security review 2026-09-16): the /j session
    // branch fully delegates to resolveTokenUserAccess(), which now carries
    // the `adminPinned ? isAdmin : undefined` tri-state instead of an
    // unconditional override. Confirms the pinned-attack-state invariant
    // (admin_pinned=true, is_admin=false with a stale admin group -> NOT
    // admin) holds on this producer too.
    it('a pin-demoted user (admin_pinned=true, is_admin=false, stale admin group) is NOT admin', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'testuser',
            is_admin: false,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: ['admin-group'], // stale IdP admin group — pin overrides it
            disabled_at: null,
            deleted_at: null,
        });

        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(event);

        expect(res.status).toBe(200);
        expect(event.locals.user.ownerIsAdmin).toBe(false);
        expect(event.locals.user.mediaAccessIsAdmin).toBe(false);
        expect(event.locals.principal).toMatchObject({ kind: 'jellyfin_compat', isAdmin: false });
    });

    it('hides Live TV for an authenticated admin when the per-user switch is disabled', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'testuser',
            is_admin: true,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });
        mockGetUserLiveTvAllowed.mockResolvedValue(false);
        const next = vi.fn(async () => new Response('should not run'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        event.route = { id: '/(proprietary)/j/LiveTv/Channels' } as typeof event.route;
        expect((await withJellyfinAuth(next)(event)).status).toBe(404);
        expect(next).not.toHaveBeenCalled();
    });

    it('an admin password session carries an explicit media admin capability (play tokens mint admin)', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetUserByUsername.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'testuser',
            is_admin: true,
            admin_pinned: true,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        });

        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        const res = await handler(event);

        expect(res.status).toBe(200);
        expect(event.locals.user.ownerIsAdmin).toBe(true);
        expect(event.locals.user.mediaAccessIsAdmin).toBe(true);
        // The admin verdict comes from the /j principal; its scopes stay plain.
        const principal = event.locals.principal;
        expect(principal).toMatchObject({ kind: 'jellyfin_compat', isAdmin: true });
        expect(principal?.scopes).not.toContain('admin');
        expect(principal?.credentialId).toMatch(/^jf-session:[0-9a-f]{64}$/);
        expect(localsIsAdmin(event.locals)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// withJellyfinAuth — PAT path
// ---------------------------------------------------------------------------

describe('withJellyfinAuth — PAT path', () => {
    beforeEach(() => {
        mockValidateSession.mockReset();
        mockValidatePat.mockReset();
        // Default: session miss
        mockValidateSession.mockResolvedValue(null);
    });

    it('accepts PAT from bare X-Emby-Token header (jellyfin-rpc style)', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-emby-token': 'pat_xyz123' },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
        expect(event.locals.authMethod).toBe('jellyfin_compat_pat');
        expect(mockValidatePat).toHaveBeenCalledWith('pat_xyz123', expect.any(String));
    });

    it('accepts PAT from bare X-MediaBrowser-Token header', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: { 'x-mediabrowser-token': 'pat_xyz123' },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
        expect(mockValidatePat).toHaveBeenCalledWith('pat_xyz123', expect.any(String));
    });

    it('accepts PAT from header when pat: allow (default)', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=valid_pat',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
        expect(event.locals.authMethod).toBe('jellyfin_compat_pat');
        expect(event.locals.user.username).toBe('testuser');
        expect(event.locals.user.ownerIsAdmin).toBe(false);
        // A compat PAT never mints admin play tokens, whoever owns it.
        expect(event.locals.user.mediaAccessIsAdmin).toBe(false);
        expect(event.locals.principal).toMatchObject({ kind: 'jellyfin_compat', isAdmin: false });
        expect(event.locals.principal?.credentialId).toMatch(/^jf-pat:[0-9a-f]{64}$/);
        expect(localsIsAdmin(event.locals)).toBe(false);
        expect((event.locals as unknown as Record<string, unknown>).jfToken).toBe('');
        expect(mockValidatePat).toHaveBeenCalledWith('valid_pat', expect.any(String));
    });

    it('rejects PAT from query string — never calls validateJellyfinCompatPat', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({ searchParams: { api_key: 'valid_pat' } });
        const res = await handler(event);
        expect(res.status).toBe(401);
        expect(mockValidatePat).not.toHaveBeenCalled();
    });

    it('notifies the read-only PAT owner once across repeated playback denials', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        const claimed = new Set<string>();
        mockNoticeThrottle.mockImplementation(async (key: string) => {
            if (claimed.has(key)) return false;
            claimed.add(key);
            return true;
        });
        const inner = vi.fn(async () => new Response('ok'));
        const handler = withJellyfinAuth(inner, { pat: 'deny' });
        const responses = await Promise.all(
            Array.from({ length: 5 }, () =>
                handler(
                    mockEvent({
                        headers: { 'x-emby-token': 'pat_readonly' },
                        pathname: '/j/Items/item-id/PlaybackInfo',
                        method: 'POST',
                    }),
                ),
            ),
        );
        expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
        await vi.waitFor(() => expect(mockNotice).toHaveBeenCalledTimes(1));
        expect(mockNoticeThrottle).toHaveBeenCalledWith('v1:jf:pat-deny-notice:42', '1', 86400);
        expect(mockNotice).toHaveBeenCalledWith({
            userId: PAT_AUTH.userId,
            kind: 'jellyfin.readonly_token',
            data: {},
        });
        expect(inner).not.toHaveBeenCalled();
        expect(mockRateLimit).not.toHaveBeenCalled();
    });

    it('does not put a forged Host into the owner notice', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        mockNoticeThrottle.mockResolvedValue(true);
        const event = mockEvent({
            headers: { 'x-emby-token': 'pat_readonly', host: 'phishing.example' },
        });
        event.url.host = 'phishing.example';
        const handler = withJellyfinAuth(async () => new Response('ok'), { pat: 'deny' });
        expect((await handler(event)).status).toBe(403);
        await vi.waitFor(() => expect(mockNotice).toHaveBeenCalledTimes(1));
        expect(mockNotice.mock.calls[0][0].data).toEqual({});
        expect(JSON.stringify(mockNotice.mock.calls)).not.toContain('phishing.example');
    });

    it('silently skips the notice when Valkey cannot grant a claim', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        mockNoticeThrottle.mockResolvedValue(false);
        const handler = withJellyfinAuth(async () => new Response('ok'), { pat: 'deny' });
        expect(
            (await handler(mockEvent({ headers: { 'x-emby-token': 'pat_readonly' } }))).status,
        ).toBe(403);
        expect(mockNoticeThrottle).toHaveBeenCalledTimes(1);
        expect(mockNotice).not.toHaveBeenCalled();
        expect(mockNoticeError).not.toHaveBeenCalled();
    });

    it('returns 403 without waiting for Valkey and logs a throttle failure', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        let rejectClaim: (reason: Error) => void = () => {};
        mockNoticeThrottle.mockImplementation(
            () =>
                new Promise<boolean>((_resolve, reject) => {
                    rejectClaim = reject;
                }),
        );
        const handler = withJellyfinAuth(async () => new Response('ok'), { pat: 'deny' });
        const response = await handler(mockEvent({ headers: { 'x-emby-token': 'pat_readonly' } }));
        expect(response.status).toBe(403);
        expect(mockNotice).not.toHaveBeenCalled();
        const failure = new Error('Valkey unavailable');
        rejectClaim(failure);
        await vi.waitFor(() =>
            expect(mockNoticeError).toHaveBeenCalledWith(
                'Jellyfin compat: failed to notify PAT owner',
                failure,
                { tokenId: 42 },
            ),
        );
        expect(mockRateLimit).not.toHaveBeenCalled();
    });

    it('keeps the 24-hour claim after delivery fails and still returns 403', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        mockNoticeThrottle.mockResolvedValueOnce(true).mockResolvedValue(false);
        const failure = new Error('notice insert failed');
        mockNotice.mockRejectedValue(failure);
        const handler = withJellyfinAuth(async () => new Response('ok'), { pat: 'deny' });
        const response = await handler(mockEvent({ headers: { 'x-emby-token': 'pat_readonly' } }));
        expect(response.status).toBe(403);
        await vi.waitFor(() =>
            expect(mockNoticeError).toHaveBeenCalledWith(
                'Jellyfin compat: failed to notify PAT owner',
                failure,
                { tokenId: 42 },
            ),
        );
        expect(
            (await handler(mockEvent({ headers: { 'x-emby-token': 'pat_readonly' } }))).status,
        ).toBe(403);
        expect(mockNoticeThrottle).toHaveBeenCalledTimes(2);
        expect(mockNotice).toHaveBeenCalledTimes(1);
        expect(mockRateLimit).not.toHaveBeenCalled();
    });

    it('returns 403 while the notice insert is still pending', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        mockNoticeThrottle.mockResolvedValue(true);
        let finish: (value: string) => void = () => {};
        mockNotice.mockImplementation(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                }),
        );
        const handler = withJellyfinAuth(async () => new Response('ok'), { pat: 'deny' });
        try {
            const response = await handler(
                mockEvent({ headers: { 'x-emby-token': 'pat_readonly' } }),
            );
            expect(response.status).toBe(403);
            await vi.waitFor(() => expect(mockNotice).toHaveBeenCalledTimes(1));
        } finally {
            finish('inserted');
        }
    });

    it('returns 403 without a notice for a full-scope PAT on pat: deny route', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH);
        const handler = withJellyfinAuth(async () => new Response('ok'), {
            pat: 'deny',
        });
        const event = mockEvent({
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=valid_pat',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(403);
        expect(mockNoticeThrottle).not.toHaveBeenCalled();
        expect(mockNotice).not.toHaveBeenCalled();
    });

    it('does not call handler on valid-PAT-deny (no rate-limit increment path)', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH);
        const innerHandler = vi.fn().mockResolvedValue(new Response('ok'));
        const handler = withJellyfinAuth(innerHandler, { pat: 'deny' });
        const event = mockEvent({
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=valid_pat',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(403);
        expect(innerHandler).not.toHaveBeenCalled();
    });

    it('a failed /j sign-in leaves no principal from earlier code on the event', async () => {
        mockValidatePat.mockResolvedValue(null);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({ headers: { 'x-emby-token': 'pat_bad' } });
        (event.locals as unknown as Record<string, unknown>).principal = { isAdmin: true };
        const res = await handler(event);
        expect(res.status).toBe(401);
        expect(event.locals.principal).toBeUndefined();
    });

    it('returns 401 when PAT validation returns null', async () => {
        mockValidatePat.mockResolvedValue(null);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=garbage',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(401);
    });

    it('sets jfToken to empty string on PAT auth', async () => {
        mockValidatePat.mockResolvedValue(PAT_AUTH);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=pat-tok',
            },
        });
        await handler(event);
        expect((event.locals as unknown as Record<string, unknown>).jfToken).toBe('');
    });

    it('forwards correct user shape on PAT auth', async () => {
        const patAuth: JellyfinCompatPatAuth = {
            tokenId: 43,
            userId: toUserId('00000000-0000-0000-0000-000000000001'),
            username: 'alice',
            groups: 'Users|Watchers',
            userGroups: ['Users', 'Watchers'],
            ownerIsAdmin: false,
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            isReadOnly: false,
            hasRequestPermission: false,
            hasReviewPermission: false,
            hasMediaAnnotationPermission: false,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: false,
            liveTvPriority: 'low',
        };
        mockValidatePat.mockResolvedValue(patAuth);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=pat-tok',
            },
        });
        await handler(event);
        expect(event.locals.user).toMatchObject({
            username: 'alice',
            groups: 'Users|Watchers',
            userGroups: ['Users', 'Watchers'],
            ownerIsAdmin: false,
            hasWatchPermission: true,
            hasLiveTvPermission: false,
        });
        // isReadOnly is a middleware-level concern and must not leak into
        // event.locals.user, which is a UserContext.
        expect(
            (event.locals.user as unknown as Record<string, unknown>).isReadOnly,
        ).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// withJellyfinAuth — mode gate (read vs write)
// ---------------------------------------------------------------------------

describe('withJellyfinAuth — mode gate', () => {
    beforeEach(() => {
        mockValidateSession.mockReset();
        mockValidatePat.mockReset();
    });

    it('default mode=read: rejects POST from session with 403', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const inner = vi.fn().mockResolvedValue(new Response('ok'));
        const handler = withJellyfinAuth(inner);
        const event = mockEvent({
            method: 'POST',
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=session-tok',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(403);
        expect(inner).not.toHaveBeenCalled();
    });

    it('default mode=read: allows GET from session', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            method: 'GET',
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=session-tok',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
    });

    it('default mode=read: allows HEAD from session', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            method: 'HEAD',
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=session-tok',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
    });

    it('default mode=read: allows OPTIONS from session (CORS preflight)', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            method: 'OPTIONS',
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=session-tok',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
    });

    it('read-only PAT: allows OPTIONS even on mode=write route', async () => {
        mockValidateSession.mockResolvedValue(null);
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        const handler = withJellyfinAuth(async () => new Response('ok'), {
            mode: 'write',
        });
        const event = mockEvent({
            method: 'OPTIONS',
            headers: { 'x-emby-token': 'pat_readonly' },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
    });

    it('mode=write: allows POST from session', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'), {
            mode: 'write',
        });
        const event = mockEvent({
            method: 'POST',
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=session-tok',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
    });

    it('default mode=read: rejects POST from full-access PAT with 403', async () => {
        mockValidateSession.mockResolvedValue(null);
        mockValidatePat.mockResolvedValue(PAT_AUTH);
        const inner = vi.fn().mockResolvedValue(new Response('ok'));
        const handler = withJellyfinAuth(inner);
        const event = mockEvent({
            method: 'POST',
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=valid_pat',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(403);
        expect(inner).not.toHaveBeenCalled();
    });

    it('mode=write: allows POST from full-access PAT', async () => {
        mockValidateSession.mockResolvedValue(null);
        mockValidatePat.mockResolvedValue(PAT_AUTH);
        const handler = withJellyfinAuth(async () => new Response('ok'), {
            mode: 'write',
        });
        const event = mockEvent({
            method: 'POST',
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=valid_pat',
            },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
    });

    it('read-only PAT: rejects POST on mode=write route with 403', async () => {
        mockValidateSession.mockResolvedValue(null);
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        const inner = vi.fn().mockResolvedValue(new Response('ok'));
        const handler = withJellyfinAuth(inner, { mode: 'write' });
        const event = mockEvent({
            method: 'POST',
            headers: { 'x-emby-token': 'pat_readonly' },
        });
        const res = await handler(event);
        expect(res.status).toBe(403);
        expect(inner).not.toHaveBeenCalled();
    });

    it('read-only PAT: allows GET on default mode=read route', async () => {
        mockValidateSession.mockResolvedValue(null);
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            method: 'GET',
            headers: { 'x-emby-token': 'pat_readonly' },
        });
        const res = await handler(event);
        expect(res.status).toBe(200);
    });

    it('read-only PAT: rejects DELETE even on mode=write route', async () => {
        mockValidateSession.mockResolvedValue(null);
        mockValidatePat.mockResolvedValue(PAT_AUTH_READONLY);
        const inner = vi.fn().mockResolvedValue(new Response('ok'));
        const handler = withJellyfinAuth(inner, { mode: 'write' });
        const event = mockEvent({
            method: 'DELETE',
            headers: { 'x-emby-token': 'pat_readonly' },
        });
        const res = await handler(event);
        expect(res.status).toBe(403);
        expect(inner).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// withJellyfinAuth — pathname guard passed to validateSession
// ---------------------------------------------------------------------------

describe('withJellyfinAuth — pathname guard', () => {
    beforeEach(() => {
        mockValidateSession.mockReset();
        mockValidatePat.mockReset();
    });

    it('passes event.url.pathname as second arg to validateSession', async () => {
        mockValidateSession.mockResolvedValue(SESSION_USER);
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const event = mockEvent({
            pathname: '/j/Items',
            headers: {
                'x-emby-authorization': 'MediaBrowser Token=session-tok',
            },
        });
        await handler(event);
        expect(mockValidateSession).toHaveBeenCalledWith('session-tok', '/j/Items');
    });
});

// ---------------------------------------------------------------------------
// parseEmbyAuthHeader — form-encoding
// ---------------------------------------------------------------------------

describe('parseEmbyAuthHeader form-encoded values', () => {
    it('decodes + as a space in display fields', () => {
        // Real header from Jellyfin Android TV: a device named
        // "Fernseher im Wohnzimmer" arrives with spaces as plus signs.
        const result = parseEmbyAuthHeader(
            'MediaBrowser Client="Jellyfin+Android+TV", Device="Fernseher+im+Wohnzimmer", Version="0.19.9"',
        );

        expect(result.Client).toBe('Jellyfin Android TV');
        expect(result.Device).toBe('Fernseher im Wohnzimmer');
    });

    it('percent-decodes non-ASCII device names', () => {
        const result = parseEmbyAuthHeader('MediaBrowser Device="Wohnzimmer-Fernseher%20oben"');
        expect(result.Device).toBe('Wohnzimmer-Fernseher oben');
    });

    it('keeps a genuine plus that was properly escaped', () => {
        // "C+C TV" form-encodes to "C%2BC+TV" — the %2B must survive as '+'
        // while the bare '+' becomes a space.
        const result = parseEmbyAuthHeader('MediaBrowser Device="C%2BC+TV"');
        expect(result.Device).toBe('C+C TV');
    });

    it('leaves DeviceId and Token byte-for-byte', () => {
        // Base64 device ids contain literal '+'. Rewriting it to a space would
        // split one device into two across a reconnect.
        const result = parseEmbyAuthHeader(
            'MediaBrowser DeviceId="ab+cd/ef==", Token="tok+en", Device="Living+Room"',
        );

        expect(result.DeviceId).toBe('ab+cd/ef==');
        expect(result.Token).toBe('tok+en');
        expect(result.Device).toBe('Living Room');
    });

    it('survives a malformed percent-escape instead of throwing', () => {
        // A stray '%' in a device name must not blow up the auth path.
        const result = parseEmbyAuthHeader('MediaBrowser Device="100%+Cinema"');
        expect(result.Device).toBe('100% Cinema');
    });

    it('leaves plain unencoded values untouched', () => {
        const result = parseEmbyAuthHeader('MediaBrowser Client=Swiftfin iOS, Version=1.4.1');
        expect(result.Client).toBe('Swiftfin iOS');
        expect(result.Version).toBe('1.4.1');
    });
});

// ---------------------------------------------------------------------------
// parseEmbyAuthHeader — hostile client names
// ---------------------------------------------------------------------------

describe('parseEmbyAuthHeader hardening', () => {
    it('does not let a device name forge log lines', () => {
        // These values are logged on every session create; a raw newline would
        // let a client inject a whole fake log entry.
        const result = parseEmbyAuthHeader(
            'MediaBrowser Device="TV%0A2026-01-01 ERROR admin logged in"',
        );

        expect(result.Device).not.toContain('\n');
        expect(result.Device).not.toContain('\r');
    });

    it('strips bidi overrides used to disguise a name', () => {
        // U+202E (RLO) reverses rendered order, so a hostile device can be made
        // to read like a familiar one in the settings list.
        const result = parseEmbyAuthHeader('MediaBrowser Device="Evil%E2%80%AEmoorgnisserdemoh"');

        expect(result.Device).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    });

    it('strips zero-width padding that makes two devices look identical', () => {
        const a = parseEmbyAuthHeader('MediaBrowser Device="Apple%20TV"').Device;
        const b = parseEmbyAuthHeader('MediaBrowser Device="Apple%20TV%E2%80%8B"').Device;

        expect(b).not.toMatch(/[\u200B-\u200D\uFEFF]/);
        expect(b).toBe(a);
    });

    it('caps an absurdly long name', () => {
        const result = parseEmbyAuthHeader(`MediaBrowser Device="${'A'.repeat(5000)}"`);

        expect(result.Device.length).toBeLessThanOrEqual(97);
        expect(result.Device.endsWith('…')).toBe(true);
    });

    it('collapses whitespace padding used to push a row out of view', () => {
        const result = parseEmbyAuthHeader('MediaBrowser Device="TV+++++++++++++++++++hidden"');
        expect(result.Device).toBe('TV hidden');
    });

    it('keeps script-looking text as inert literal text', () => {
        // Svelte escapes interpolation, so this must survive verbatim rather
        // than be mangled — the guarantee is "rendered as text", not "removed".
        const result = parseEmbyAuthHeader(
            'MediaBrowser Device="%3Cscript%3Ealert(1)%3C/script%3E"',
        );
        expect(result.Device).toBe('<script>alert(1)</script>');
    });

    it('does not sanitize the token, which must stay byte-exact', () => {
        const long = 'a'.repeat(200);
        const result = parseEmbyAuthHeader(`MediaBrowser Token="${long}"`);
        expect(result.Token).toBe(long);
    });
});

it.each([true, false])(
    'non-dependency PAT errors use the normal failed-auth throttle (allowed=%s)',
    async (allowed) => {
        mockValidateSession.mockResolvedValue(null);
        mockValidatePat.mockRejectedValueOnce(new TypeError('bad PAT metadata'));
        mockRateLimit.mockResolvedValue({ allowed, resetAt: 100 });
        const handler = withJellyfinAuth(async () => new Response('ok'));
        const response = await handler(mockEvent({ headers: { 'x-emby-token': 'pat_test' } }));
        expect(response.status).toBe(allowed ? 401 : 429);
        expect(mockRateLimit).toHaveBeenCalledWith(
            expect.stringContaining('jfcompat:auth_fail:'),
            expect.any(Number),
            expect.any(Number),
        );
    },
);

// The legacy user-state Users/{userId} spellings must never accept another user's path
// for an ordinary credential. UUIDs emitted by Jellyfin are dash-stripped.
describe('legacy path user authorization', () => {
    for (const route of [
        'PlayedItems/item',
        'FavoriteItems/item',
        'PlayingItems/item',
        'PlayingItems/item/Progress',
        'Items/item/UserData',
        'Items',
        'Items/Latest',
        'Items/Resume',
        'Items/Root',
        'Items/item',
        'Suggestions',
    ]) {
        it(`rejects another user in ${route}`, async () => {
            const event = mockEvent({
                headers: { 'X-Emby-Token': 'valid-session' },
                method: 'POST',
                pathname: `/j/Users/bbbbbbbb00004000a000000000000002/${route}`,
            });
            event.params.userId = 'bbbbbbbb00004000a000000000000002';
            mockValidateSession.mockResolvedValue(SESSION_USER);
            const handler = vi.fn(async () => new Response(null, { status: 204 }));
            const response = await withJellyfinAuth(handler, { mode: 'write' })(event);
            expect(response.status).toBe(404);
            expect(handler).not.toHaveBeenCalled();
        });
    }
    for (const path of ['/de/j/Users/other/Items', '/%6a/Users/other/%49tems/item/UserData']) {
        it(`keeps the state guard after rerouting ${path}`, async () => {
            const event = mockEvent({
                headers: { 'X-Emby-Token': 'valid-session' },
                pathname: path,
            });
            event.params.userId = 'bbbbbbbb00004000a000000000000002';
            mockValidateSession.mockResolvedValue(SESSION_USER);
            const handler = vi.fn(async () => new Response(null, { status: 204 }));
            expect((await withJellyfinAuth(handler)(event)).status).toBe(404);
            expect(handler).not.toHaveBeenCalled();
        });
    }
    it('an admin-owned scoped PAT cannot use the admin path exception', async () => {
        const event = mockEvent({
            headers: { 'X-Emby-Token': 'pat-secret' },
            pathname: '/j/Users/bbbbbbbb00004000a000000000000002/Items',
        });
        event.params.userId = 'bbbbbbbb00004000a000000000000002';
        mockValidateSession.mockResolvedValue(null);
        mockValidatePat.mockResolvedValue({ ...PAT_AUTH, ownerIsAdmin: true });
        const handler = vi.fn(async () => new Response(null, { status: 204 }));
        expect((await withJellyfinAuth(handler)(event)).status).toBe(404);
        expect(handler).not.toHaveBeenCalled();
    });
    it('permits a foreign path only for an admin principal', async () => {
        const event = mockEvent({
            headers: { 'X-Emby-Token': 'valid-session' },
            pathname: '/j/Users/bbbbbbbb00004000a000000000000002/Items',
        });
        event.params.userId = 'bbbbbbbb00004000a000000000000002';
        mockValidateSession.mockResolvedValue(SESSION_USER);
        mockGetUserByUsername.mockResolvedValue({
            id: SESSION_USER.userId,
            username: SESSION_USER.username,
            is_admin: true,
            admin_pinned: true,
            groups: [],
            max_age_rating: null,
            age_rating_pinned: false,
            disabled_at: null,
            deleted_at: null,
        });
        expect(
            (await withJellyfinAuth(async () => new Response(null, { status: 204 }))(event)).status,
        ).toBe(204);
        expect(event.locals.principal?.isAdmin).toBe(true);
    });
    it('accepts the caller UUID without dashes', async () => {
        const event = mockEvent({
            headers: { 'X-Emby-Token': 'valid-session' },
            pathname: `/j/Users/${SESSION_USER.userId.replaceAll('-', '')}/Items`,
        });
        event.params.userId = SESSION_USER.userId.replaceAll('-', '');
        mockValidateSession.mockResolvedValue(SESSION_USER);
        expect(
            (await withJellyfinAuth(async () => new Response(null, { status: 204 }))(event)).status,
        ).toBe(204);
    });
});

describe('cross-origin requests remain cookie-blind', () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
        it(`${method} cannot borrow a native session identity`, async () => {
            const event = mockEvent({
                method,
                headers: {
                    Origin: 'https://foreign.example',
                    Cookie: 'lumastra_session=valid-native-session',
                },
            });
            event.locals.user = {
                userId: toUserId(SESSION_USER.userId),
                username: SESSION_USER.username,
            } as App.Locals['user'];
            event.locals.authMethod = 'session';
            const handler = vi.fn(async () => new Response(null, { status: 204 }));
            const response = await withJellyfinAuth(handler, { mode: 'write' })(event);
            expect(response.status).toBe(401);
            expect(handler).not.toHaveBeenCalled();
        });
    }
});

it.each(['quick_connect', undefined])(
    'Quick Connect control admin is restricted, media admin stays live (%s)',
    async (origin) => {
        mockValidateSession.mockResolvedValue({ ...SESSION_USER, origin });
        mockGetUserByUsername.mockResolvedValue({
            id: SESSION_USER.userId,
            username: 'testuser',
            groups: ['admin-group'],
            disabled_at: null,
            deleted_at: null,
        });
        const event = mockEvent({
            headers: { 'x-emby-authorization': 'MediaBrowser Token=session-tok' },
        });
        expect((await withJellyfinAuth(async () => new Response('ok'))(event)).status).toBe(200);
        expect(localsIsAdmin(event.locals)).toBe(origin !== 'quick_connect');
        expect(event.locals.user.mediaAccessIsAdmin).toBe(true);
    },
);
