// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `/api/v1` service-token envelope
 * (`allowedPathPrefixes`/`allowedMethods`) and scope/method gate, plus the
 * two "invalid credential state" denials (missing impersonation target,
 * unprovisioned non-impersonating creator) — all reached via `resolveAuth()`
 * -> `handlePatAuth`/`handleServiceTokenAuth` in `forward-auth.ts`, which now
 * delegate to the shared `$lib/server/auth/token-identity.ts` producer.
 *
 * Fix-plan-5 Task 3 review, Important 1: `token-identity.ts`'s doc comment
 * cited this file before it existed. Nothing previously asserted the exact
 * denial bodies for `Token not permitted on this endpoint`,
 * `Method not permitted by token`, server-side `insufficient_scope`,
 * `impersonation_failed`, or `Token owner not provisioned` — only
 * `tasks/api-auth.ts`'s ApiAuthError-wrapped equivalents had coverage
 * (api-auth.test.ts), which is a DIFFERENT plane with a DIFFERENT outward
 * mapping (405->403, no bare-`{error}`-without-`message` bodies).
 *
 * Follows forward-auth.test.ts's established mocking convention: the
 * token-validation services and the DB/cache layers underneath
 * `resolveTokenUserAccess()`/`resolveOwnerIsAdminFailClosed()`/the
 * impersonation raw-SQL query are mocked at the LEAF (credential validate(),
 * `getUserByUsername`, a raw `Database.getSql()` tagged-template,
 * `resolveEffectiveAccess`, the L1 caches) — `resolveTokenUserAccess`,
 * `resolveOwnerAdminStatus`/`resolveOwnerIsAdminFailClosed`, and
 * `tokenEnvelopeDenial`/`v1ScopeMethodDenial` all run for REAL.
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
    isUserAdmin: (groups: string[] = []) => groups.includes('admin-group'),
    buildUserPermissions: (
        groups: string[],
        opts?: { isAdminOverride?: boolean; extraCapabilities?: { isAdmin?: boolean } },
    ) => {
        const isAdmin =
            opts?.isAdminOverride ??
            (groups.includes('admin-group') || opts?.extraCapabilities?.isAdmin === true);
        return {
            hasWatchPermission: isAdmin,
            hasLiveTvPermission: isAdmin,
            hasRequestPermission: isAdmin,
            hasReviewPermission: isAdmin,
            hasMediaAnnotationPermission: isAdmin,
            isAdmin,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: isAdmin,
            liveTvPriority: isAdmin ? 'high' : 'low',
        };
    },
}));

// Per-username userId cache — unlike forward-auth.test.ts's single fixed
// value, this file needs BOTH a cache HIT (the ordinary creator) and a
// genuine MISS-then-DB-miss (the "not provisioned" creator), so it is a real
// map keyed by username, empty by default (every username starts as a miss;
// tests that need a hit populate it explicitly).
const userIdCache = new Map<string, string>();
const mockGetCachedDisabled = vi.fn<(username: string) => boolean | null>(() => null);
vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: () => null,
    setCachedIsAdmin: () => {},
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: (username: string) => mockGetCachedDisabled(username),
    setCachedDisabled: () => {},
    getCachedDeleted: () => null,
    setCachedDeleted: () => {},
    getCachedUserId: (username: string) => userIdCache.get(username.toLowerCase()) ?? null,
    setCachedUserId: (username: string, id: string) => {
        userIdCache.set(username.toLowerCase(), id);
    },
    getCachedGroups: () => null,
    setCachedGroups: () => {},
    invalidateUserAdminCache: () => {},
}));

vi.mock('$lib/server/cache/user-max-age-cache.js', () => {
    const MAX_AGE_MISS_SENTINEL = Symbol('max-age-miss');
    return {
        MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
        getCachedMaxAge: () => MAX_AGE_MISS_SENTINEL,
        setCachedMaxAge: () => {},
        invalidateUserMaxAgeCache: () => {},
    };
});

// aiDbService.getSql(): non-null by default (unlike forward-auth.test.ts's
// "DB unavailable" default) — this file's "not provisioned" case relies
// SOLELY on the userId cache MISS + the users.queries mock returning null
// (a real "no such row"), not on a missing DB handle, so the DEFAULT here
// must let that DB round trip actually happen.
const mockGetSql = vi.fn(async (): Promise<unknown> => ({}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => mockGetSql() },
}));

vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => false),
    getKeysByPattern: vi.fn(async () => []),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

// Impersonation-target raw SQL row — empty array by default (case 6, "target
// missing", needs exactly this; other tests that impersonate override).
interface ImpersonationRow {
    username: string;
    groups: string[] | null;
    disabled_at: Date | null;
    deleted_at: Date | null;
    is_admin: boolean;
    admin_pinned: boolean;
    max_age_rating: number | null;
    age_rating_pinned: boolean;
}
let impersonationRows: ImpersonationRow[] = [];
const mockSqlQuery = vi.fn(async () => impersonationRows);
vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): typeof mockSqlQuery {
            return mockSqlQuery;
        }
    }
    return { Database: MockDatabase };
});

const mockPatValidate = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        validate: (...args: unknown[]) => mockPatValidate(...args),
        hasScope: (validated: { scopes: string[] }, required: string) => {
            if (validated.scopes.includes('admin')) return true;
            if (required === 'read' && validated.scopes.includes('write')) return true;
            return validated.scopes.includes(required);
        },
    }),
}));

const mockSvcValidate = vi.fn();
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({
        validate: (...args: unknown[]) => mockSvcValidate(...args),
    }),
}));

interface MockUserRow {
    id: string;
    username: string;
    is_admin: boolean;
    admin_pinned: boolean;
    max_age_rating: number | null;
    age_rating_pinned: boolean;
    groups: string[];
    disabled_at: Date | null;
    deleted_at: Date | null;
}
// Default: resolves the ordinary CREATOR fixture row for its own username,
// null (no such row) for anything else — e.g. the "ghost-admin" creator in
// the not-provisioned case, which relies on exactly this default.
const mockGetUserByUsername = vi.fn<(username: string) => Promise<MockUserRow | null>>(
    async (username: string) => {
        if (username.toLowerCase() !== CREATOR_USERNAME) return null;
        return {
            id: CREATOR_ID,
            username: CREATOR_USERNAME,
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: null,
            deleted_at: null,
        };
    },
);
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (_sql: unknown, username: string) => mockGetUserByUsername(username),
    // The service-token owner is resolved by id (API package 15).
    getUserById: (_sql: unknown, id: string) =>
        id === CREATOR_ID ? mockGetUserByUsername(CREATOR_USERNAME) : Promise.resolve(null),
}));

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: async (
        _sql: unknown,
        _userId: string,
        syncedGroups: readonly string[],
    ) => ({
        inAppGroupNames: [] as string[],
        effectiveGroups: [...syncedGroups],
        capabilities: {} as Record<string, unknown>,
    }),
}));

vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({
        validate: vi.fn(async () => null),
        getStatus: vi.fn(async () => null),
    }),
}));

vi.mock('$lib/server/oauth/jwt.js', () => ({
    verifyAccessToken: vi.fn(async () => null),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeApiV1Event(opts: {
    path: string;
    method?: string;
    authHeader?: string;
}): RequestEvent {
    const url = new URL('http://localhost' + opts.path);
    const headers = new Headers();
    if (opts.authHeader) headers.set('authorization', opts.authHeader);
    const request = new Request(url, { method: opts.method ?? 'GET', headers });

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
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

/** A resolvable, enabled, non-admin creator row — the "ordinary creator" fixture. */
const CREATOR_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_USERNAME = 'the-creator';

async function jsonBody(response: Response): Promise<unknown> {
    return response.json();
}

beforeEach(() => {
    vi.clearAllMocks();
    userIdCache.clear();
    userIdCache.set(CREATOR_USERNAME, CREATOR_ID);
    mockGetSql.mockResolvedValue({} as unknown);
    mockGetCachedDisabled.mockReturnValue(null);
    impersonationRows = [];
    mockSqlQuery.mockResolvedValue(impersonationRows);
});

function svcToken(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        name: 'svc-test',
        createdBy: CREATOR_USERNAME,
        ownerUserId: CREATOR_ID,
        actAsUser: null,
        allowedPathPrefixes: null,
        allowedMethods: null,
        forceNonAdmin: false,
        scopes: ['admin'],
        ...overrides,
    };
}

function patToken(overrides: Record<string, unknown> = {}) {
    return {
        id: 2,
        userId: CREATOR_ID,
        username: CREATOR_USERNAME,
        name: 'pat-test',
        scopes: ['admin'],
        groups: [],
        jellyfinUserId: null,
        tokenPrefix: 'pat_test',
        allowedIps: null,
        ...overrides,
    };
}

// ── C2 fix delta 1: empty-string prefix now fails closed (was allow-all) ────

describe("service token envelope: allowedPathPrefixes:[''] (C2 fix delta 1)", () => {
    it("denies every path — was ALLOW-ALL before this fix (RED on base: FA turned '' into boundary '/', matching everything)", async () => {
        mockSvcValidate.mockResolvedValue(
            svcToken({ allowedPathPrefixes: [''], allowedMethods: null }),
        );
        const event = makeApiV1Event({
            path: '/api/v1/admin/system/change-timeline',
            authHeader: 'Bearer svc_emptyprefix',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(403);
        const body = await jsonBody(response);
        expect(response.headers.get('Content-Type')).toBe('application/problem+json');
        expect(body).toEqual({
            code: 'forbidden',
            error: 'Token not permitted on this endpoint',
            status: 403,
        });
        // No `reason` or `message` key: the envelope denial carries no machine detail.
        expect(Object.keys(body as object)).toEqual(['code', 'error', 'status']);
    });
});

// ── C2 fix delta 2: method comparison is now case-insensitive ──────────────

describe("service token envelope: allowedMethods:['get'] (C2 fix delta 2)", () => {
    it('a GET request is allowed — was 405 before this fix (RED on base: FA compared methods case-sensitively)', async () => {
        mockSvcValidate.mockResolvedValue(svcToken({ allowedMethods: ['get'] }));
        const event = makeApiV1Event({
            path: '/api/v1/admin/system/change-timeline',
            method: 'GET',
            authHeader: 'Bearer svc_lowercasemethod',
        });
        const result = await resolveAuth(event, noopMigration, true);
        // undefined = continue to the route; the credential was accepted.
        expect(result).toBeUndefined();
        expect(event.locals.principal?.kind).toBe('service_token');
    });
});

// ── Path miss ────────────────────────────────────────────────────────────────

describe('service token envelope: path miss', () => {
    it('a path outside allowedPathPrefixes gets 403 {error} (no message)', async () => {
        mockSvcValidate.mockResolvedValue(
            svcToken({ allowedPathPrefixes: ['/api/v1/metrics'], allowedMethods: null }),
        );
        const event = makeApiV1Event({
            path: '/api/v1/admin/system/change-timeline',
            authHeader: 'Bearer svc_pathmiss',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(403);
        const body = await jsonBody(response);
        expect(response.headers.get('Content-Type')).toBe('application/problem+json');
        expect(body).toEqual({
            code: 'forbidden',
            error: 'Token not permitted on this endpoint',
            status: 403,
        });
        expect(Object.keys(body as object)).toEqual(['code', 'error', 'status']);
    });
});

// ── Method miss ──────────────────────────────────────────────────────────────

describe('service token envelope: method miss', () => {
    it('a method outside allowedMethods gets 403 forbidden with reason method_not_permitted', async () => {
        mockSvcValidate.mockResolvedValue(
            svcToken({ allowedPathPrefixes: null, allowedMethods: ['GET'] }),
        );
        const event = makeApiV1Event({
            path: '/api/v1/admin/system/change-timeline',
            method: 'POST',
            authHeader: 'Bearer svc_methodmiss',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(403);
        expect(response.headers.get('Content-Type')).toBe('application/problem+json');
        const body = await jsonBody(response);
        expect(body).toEqual({
            code: 'forbidden',
            error: 'Method not permitted by token',
            status: 403,
            reason: 'method_not_permitted',
        });
        expect(Object.keys(body as object)).toEqual(['code', 'error', 'status', 'reason']);
    });
});

// ── v1ScopeMethodDenial pin (Important 3): read-scope POST for BOTH kinds ──

describe('v1ScopeMethodDenial: read-scope POST is insufficient_scope for both token kinds', () => {
    it('a read-scope PAT POST gets 403 scope_required', async () => {
        mockPatValidate.mockResolvedValue(patToken({ scopes: ['read'] }));
        const event = makeApiV1Event({
            path: '/api/v1/media',
            method: 'POST',
            authHeader: 'Bearer pat_readonly',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(403);
        const body = (await jsonBody(response)) as { code: string; error: string };
        expect(body.code).toBe('scope_required');
        expect(body.error).toMatch(/write.*admin.*POST/);
    });

    it('a read-scope service token POST gets 403 scope_required', async () => {
        mockSvcValidate.mockResolvedValue(svcToken({ scopes: ['read'] }));
        const event = makeApiV1Event({
            path: '/api/v1/media',
            method: 'POST',
            authHeader: 'Bearer svc_readonly',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(403);
        const body = (await jsonBody(response)) as { code: string; error: string };
        expect(body.code).toBe('scope_required');
        expect(body.error).toMatch(/write.*admin.*POST/);
    });
});

// ── Identity-first ordering (Task 3 review, RULING not accepted) ───────────
//
// handlePatAuth resolves identity (401 on failure) BEFORE the /api/v1-only
// scope/method gate (403) — restoring the pre-extraction order. A
// disabled/unresolvable owner must get 401 "invalid_token" (and so count
// toward maybeRateLimitFailedAuth's failed-auth counter), never a 403
// "insufficient_scope" that a bare read-scope-vs-POST check would otherwise
// produce first if the gate ran before identity resolution.
describe('PAT identity resolution runs BEFORE the scope/method gate', () => {
    it('a read-scope PAT POST from a DISABLED owner gets 401, not 403', async () => {
        mockGetUserByUsername.mockResolvedValueOnce({
            id: CREATOR_ID,
            username: CREATOR_USERNAME,
            is_admin: false,
            admin_pinned: false,
            max_age_rating: null,
            age_rating_pinned: false,
            groups: [],
            disabled_at: new Date('2026-01-01'),
            deleted_at: null,
        });
        mockPatValidate.mockResolvedValue(patToken({ scopes: ['read'] }));
        const event = makeApiV1Event({
            path: '/api/v1/media',
            method: 'POST',
            authHeader: 'Bearer pat_disabledowner',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(401);
        const body = (await jsonBody(response)) as { code: string };
        expect(body.code).toBe('invalid_token');
    });
});

// ── Impersonation target missing ────────────────────────────────────────────

describe('service token impersonation: target missing', () => {
    it('an actAsUser with no matching row gets 403 invalid_impersonation', async () => {
        impersonationRows = [];
        mockSqlQuery.mockResolvedValue([]);
        mockSvcValidate.mockResolvedValue(
            svcToken({ actAsUser: '99999999-9999-4999-8999-999999999999' }),
        );
        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer svc_missingtarget',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(403);
        const body = (await jsonBody(response)) as { code: string; reason: string; error: string };
        expect(body.code).toBe('forbidden');
        expect(body.reason).toBe('invalid_impersonation');
        expect(body.error).toBe('Impersonation target not found or not authorized');
    });
});

// ── Non-impersonating creator not provisioned ───────────────────────────────

describe('service token, non-impersonating: owner not provisioned', () => {
    it("a token without owner_user_id gets 401 invalid_token 'Token owner not provisioned'", async () => {
        // validate() already rejects such a row; this pins the producer's own
        // defensive check (the owner is resolved by id, never by createdBy).
        mockSvcValidate.mockResolvedValue(
            svcToken({ createdBy: 'ghost-admin', ownerUserId: null, actAsUser: null }),
        );
        const event = makeApiV1Event({
            path: '/api/v1/media',
            authHeader: 'Bearer svc_ghostcreator',
        });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        // An unresolvable owner makes the token unusable: 401 invalid_token (re-authenticate).
        expect(response.status).toBe(401);
        const body = (await jsonBody(response)) as { code: string; error: string };
        expect(body.code).toBe('invalid_token');
        expect(body.error).toBe('Token owner not provisioned');
    });
});
