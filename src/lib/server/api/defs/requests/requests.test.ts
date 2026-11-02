// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the requests domain defs.
 *
 * Tests cover:
 *  - hasRequestPermission enforcement
 *  - quota_exceeded error code on quota exhaustion
 *  - `tv` → `series` canonicalisation in GET /requests response
 *  - `requests:admin` scope gate for scope=all
 *  - 201 + Location on successful POST
 *  - Dependency-unavailable returns 503
 *  - GET /requests/quota: `tv` → `series` key rename
 *  - POST /requests/{id}/dismiss: 204 on success
 *
 * External services (Jellyseerr, providerResolutionService, rate-limit) are
 * mocked so tests run without a live DB/Valkey/network.
 *
 * Handlers are called directly (`def.handlers.METHOD`) rather than via
 * `mount()` to keep the mocking surface minimal — this matches the pattern
 * used by other def unit tests in this codebase (e.g. playlists tests).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { EndpointDef } from '$lib/server/api/define.js';
import type { createRequestBodySchema } from '$lib/schemas/request.js';
import { toUserId } from '$lib/shared/user-id.js';

// ── Module mocks ─────────────────────────────────────────────────────────────
// vi.mock calls are hoisted to the top by vitest — order relative to imports
// doesn't matter.

const mockResolveUserLink = vi.fn();
const mockGetUserQuota = vi.fn();
const mockCreateRequestForUser = vi.fn();
const mockGetPendingRequestsForUser = vi.fn();
const mockGetRequests = vi.fn();
const mockGetRequestById = vi.fn();
const mockIsConfigured = vi.fn();
const mockGetDismissalsForUser = vi.fn();
const mockGetSimpleStatusLabel = vi.fn();
const mockFilterOrphanedRequests = vi.fn();
const mockFilterRequestsWithoutCatalogMatch = vi.fn();
const mockResolveToTmdb = vi.fn();
const mockDeleteDismissal = vi.fn();
const mockUpsertDismissal = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
const mockGetMediaByTmdbId = vi.fn();
const mockGetRequestSeasons = vi.fn();

// Exercise the browser route with its parsed body, using the same real
// RequestManager and mocked dependencies as the public API tests.
vi.mock('$lib/server/api/mount.js', () => ({
    mount: (def: EndpointDef<{ body: typeof createRequestBodySchema }>) => ({
        POST: async (event: RequestEvent) =>
            def.handlers.POST!(event, {
                surface: 'internal',
                input: {
                    body: def.request!.body.parse(await event.request.json()),
                    query: undefined,
                    params: undefined,
                },
            }),
    }),
}));

vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: {
        resolveUserLink: (...args: unknown[]) => mockResolveUserLink(...args),
        getUserQuota: (...args: unknown[]) => mockGetUserQuota(...args),
        createRequestForUser: (...args: unknown[]) => mockCreateRequestForUser(...args),
        getPendingRequestsForUser: (...args: unknown[]) => mockGetPendingRequestsForUser(...args),
        getRequests: (...args: unknown[]) => mockGetRequests(...args),
        getRequestById: (...args: unknown[]) => mockGetRequestById(...args),
        getMediaByTmdbId: (...args: unknown[]) => mockGetMediaByTmdbId(...args),
        isConfigured: (...args: unknown[]) => mockIsConfigured(...args),
        getRequestSeasons: (...args: unknown[]) => mockGetRequestSeasons(...args),
    },
}));

vi.mock('$lib/server/services/request-status/index.js', () => ({
    getDismissalsForUser: (...args: unknown[]) => mockGetDismissalsForUser(...args),
    getSimpleStatusLabel: (...args: unknown[]) => mockGetSimpleStatusLabel(...args),
    deleteDismissal: (...args: unknown[]) => mockDeleteDismissal(...args),
    upsertDismissal: (...args: unknown[]) => mockUpsertDismissal(...args),
}));

vi.mock('$lib/server/services/request-status/orphan-filter.js', () => ({
    filterOrphanedRequests: (...args: unknown[]) => mockFilterOrphanedRequests(...args),
}));

vi.mock('$lib/server/services/request-status/catalog-match-filter.js', () => ({
    filterRequestsWithoutCatalogMatch: (...args: unknown[]) =>
        mockFilterRequestsWithoutCatalogMatch(...args),
}));

vi.mock('$lib/server/services/provider-resolution.service.js', () => ({
    providerResolutionService: {
        resolveToTmdb: (...args: unknown[]) => mockResolveToTmdb(...args),
    },
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    RateLimitPresets: { STANDARD: { limit: 100, windowSeconds: 60 } },
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

vi.mock('$lib/server/dev-user.js', () => ({
    getEffectiveUser: (_: unknown, username: string) => username,
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        DEFAULT_USER: 'default-user',
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// ── Import defs AFTER mocks (dynamic import ensures mocks are applied) ────────

const { def: requestsDef } = await import('./index.js');
const { def: quotaDef } = await import('./quota.js');
const { def: dismissDef } = await import('./dismissals.js');
const { def: requestDismissalDef } = await import('./[id]/dismissal.js');
const { def: requestByIdDef } = await import('./[id]/index.js');
const { POST: browserRequest } = await import('../../../../../routes/api/request/+server.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_USER_ID = toUserId('00000000-0000-0000-0000-000000000001');
const CTX_V1 = { surface: 'v1' as const };

function makeUser(opts: { isAdmin?: boolean; hasRequestPermission?: boolean } = {}) {
    return {
        userId: BASE_USER_ID,
        username: 'alice',
        groups: '',
        userGroups: [] as string[],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: opts.hasRequestPermission ?? true,
        isAdmin: opts.isAdmin ?? false,
        isModerator: false,
        maxAgeRating: null as null | number,
        isAgeRating: false,
        isAgeRestricted: false,
        liveTvPriority: 'low' as const,
    };
}

function makeEvent(
    opts: {
        method?: 'GET' | 'POST';
        username?: string;
        isAdmin?: boolean;
        hasRequestPermission?: boolean;
        searchParams?: Record<string, string>;
        body?: unknown;
        params?: Record<string, string>;
        principalScopes?: string[];
        /** An admin session's principal (buildPrincipal expands 'admin'). */
        adminSession?: boolean;
    } = {},
): RequestEvent {
    const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
    const url = new URL('http://localhost/api/v1/requests');
    const sp = opts.searchParams ?? {};
    for (const [k, v] of Object.entries(sp)) url.searchParams.set(k, v);

    const user = makeUser({
        isAdmin: opts.isAdmin,
        hasRequestPermission: opts.hasRequestPermission,
    });
    if (opts.username !== undefined) user.username = opts.username;

    const principal = opts.adminSession
        ? {
              kind: 'session' as const,
              userId: BASE_USER_ID,
              username: user.username,
              userGroups: ['admins'],
              scopes: ['admin', 'read', 'write', 'requests:read', 'requests:admin'],
              isAdmin: true,
          }
        : opts.principalScopes
          ? {
                kind: 'pat' as const,
                userId: BASE_USER_ID,
                username: user.username,
                userGroups: [],
                scopes: opts.principalScopes,
                isAdmin: false,
            }
          : undefined;

    const request = new Request(url.toString(), {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    return {
        url,
        request,
        params: opts.params ?? {},
        route: { id: '/api/v1/requests' as const },
        locals: { user, principal },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

async function bodyJson(res: Response) {
    return res.clone().json() as Promise<Record<string, unknown>>;
}

// ── Setup defaults ────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('1.2.3.4');
    mockIsConfigured.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({
        allowed: true,
        resetAt: 9999999,
        remaining: 19,
        total: 20,
    });
    mockFilterOrphanedRequests.mockResolvedValue({ kept: [] });
    mockFilterRequestsWithoutCatalogMatch.mockResolvedValue({ kept: [] });
    mockGetDismissalsForUser.mockResolvedValue([]);
    mockGetRequests.mockResolvedValue([]);
    mockGetRequestById.mockResolvedValue(null);
    mockGetSimpleStatusLabel.mockReturnValue('pending');
    mockDeleteDismissal.mockResolvedValue(undefined);
});

// ── Auth spec shape tests ─────────────────────────────────────────────────────

describe('def.auth shape', () => {
    it('requests: GET requires user auth', () => {
        const spec = (requestsDef.auth as Record<string, unknown>).GET;
        expect(spec).toMatchObject({ kind: 'user' });
    });

    it('requests: POST requires user auth', () => {
        const spec = (requestsDef.auth as Record<string, unknown>).POST;
        expect(spec).toMatchObject({ kind: 'user' });
    });

    it('quota: GET requires user auth', () => {
        const spec = quotaDef.auth;
        expect(spec).toMatchObject({ kind: 'user' });
    });

    it('dismiss: POST requires user auth', () => {
        const spec = dismissDef.auth;
        expect(spec).toMatchObject({ kind: 'user' });
    });
});

// ── POST /requests — hasRequestPermission enforcement (P0 bug fix) ────────────

describe('POST /requests — hasRequestPermission enforcement (P0 bug fix)', () => {
    it('returns 403 when hasRequestPermission is false', async () => {
        const event = makeEvent({ body: {}, hasRequestPermission: false });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(403);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('forbidden');
    });

    it('proceeds past permission gate when hasRequestPermission is true', async () => {
        // Rate limiter passes, but body is empty ({}) → validation_failed (not 403)
        const event = makeEvent({ body: {}, hasRequestPermission: true });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        // Should fail with validation_failed, NOT forbidden
        expect((res as Response).status).not.toBe(403);
    });
});

// ── POST /requests — rate limiting ───────────────────────────────────────────

describe('POST /requests — rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: 9999999 });
        const event = makeEvent({ body: { externalIds: { tmdb: '550' }, mediaType: 'movie' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(429);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('rate_limited');
    });
});

// ── POST /requests — quota_exceeded ──────────────────────────────────────────

describe('POST /requests — quota_exceeded', () => {
    it('returns 422 quota_exceeded when movie quota is exhausted', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 550 });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 5, used: 5, remaining: 0, days: 7, restricted: true },
            tv: { limit: 0, used: 0, remaining: null, days: 7, restricted: false },
        });

        const event = makeEvent({ body: { externalIds: { tmdb: '550' }, mediaType: 'movie' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('quota_exceeded');
        // D8: structured quota details must be present
        expect(body.details).toMatchObject({ bucket: 'movie', limit: 5, used: 5, remaining: 0 });
    });

    it('returns 422 quota_exceeded when series quota is exhausted', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 1396 });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 0, used: 0, remaining: null, days: 7, restricted: false },
            tv: { limit: 3, used: 3, remaining: 0, days: 7, restricted: true },
        });

        const event = makeEvent({ body: { externalIds: { tmdb: '1396' }, mediaType: 'series' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('quota_exceeded');
        // D8: structured quota details must be present
        expect(body.details).toMatchObject({ bucket: 'series', limit: 3, used: 3, remaining: 0 });
    });

    it('proceeds when remaining quota > 0', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 550 });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 5, used: 1, remaining: 4, days: 7, restricted: false },
            tv: { limit: 0, used: 0, remaining: null, days: 7, restricted: false },
        });
        mockCreateRequestForUser.mockResolvedValue({ success: true, requestId: 42 });
        mockDeleteDismissal.mockResolvedValue(undefined);

        const event = makeEvent({ body: { externalIds: { tmdb: '550' }, mediaType: 'movie' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(201);
    });

    it('proceeds when limit is 0 (unlimited quota)', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 1396 });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 0, used: 0, remaining: null, days: 7, restricted: false },
            tv: { limit: 0, used: 100, remaining: null, days: 7, restricted: false },
        });
        mockCreateRequestForUser.mockResolvedValue({ success: true, requestId: 43 });
        mockDeleteDismissal.mockResolvedValue(undefined);

        const event = makeEvent({ body: { externalIds: { tmdb: '1396' }, mediaType: 'series' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(201);
    });
});

// ── POST /requests — 201 + Location header ────────────────────────────────────

describe('POST /requests — 201 + Location header', () => {
    it('returns 201 with Location header on success', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 550 });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 5, used: 1, remaining: 4, days: 7, restricted: false },
            tv: { limit: 0, used: 0, remaining: null, days: 7, restricted: false },
        });
        mockCreateRequestForUser.mockResolvedValue({ success: true, requestId: 99 });
        mockDeleteDismissal.mockResolvedValue(undefined);

        const event = makeEvent({ body: { externalIds: { tmdb: '550' }, mediaType: 'movie' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(201);
        expect((res as Response).headers.get('Location')).toBe('/api/v1/requests/99');
        const body = await bodyJson(res as Response);
        expect(body.id).toBe(99);
        expect(typeof body.requestedAt).toBe('string');
    });
});

// ── POST /requests — dependency unavailable ───────────────────────────────────

describe('POST /requests — dependency unavailable', () => {
    it('returns 503 dependency_unavailable when Jellyseerr is down', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 550 });
        mockResolveUserLink.mockResolvedValue({ state: 'unavailable' });

        const event = makeEvent({ body: { externalIds: { tmdb: '550' }, mediaType: 'movie' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(503);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('dependency_unavailable');
    });
});

// ── POST /requests — validation ───────────────────────────────────────────────

describe('POST /requests — validation', () => {
    it('rejects `tv` as mediaType', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 1396 });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 0, used: 0, remaining: null, days: 7, restricted: false },
            tv: { limit: 0, used: 0, remaining: null, days: 7, restricted: false },
        });
        mockCreateRequestForUser.mockResolvedValue({ success: true, requestId: 101 });

        const event = makeEvent({ body: { externalIds: { tmdb: '1396' }, mediaType: 'tv' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        // The public boundary accepts only movie and series.
        expect((res as Response).status).toBe(422);
    });

    it('accepts `series` as canonical mediaType', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 1396 });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 0, used: 0, remaining: null, days: 7, restricted: false },
            tv: { limit: 0, used: 0, remaining: null, days: 7, restricted: false },
        });
        mockCreateRequestForUser.mockResolvedValue({ success: true, requestId: 102 });

        const event = makeEvent({ body: { externalIds: { tmdb: '1396' }, mediaType: 'series' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(201);
    });

    it('returns 422 when externalIds is empty', async () => {
        const event = makeEvent({ body: { externalIds: {}, mediaType: 'movie' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 422 when mediaType is invalid', async () => {
        const event = makeEvent({ body: { externalIds: { tmdb: '550' }, mediaType: 'book' } });
        const res = await requestsDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });
});

// ── GET /requests — scope=mine ────────────────────────────────────────────────

describe('GET /requests — scope=mine (default)', () => {
    it('returns 503 when Jellyseerr is unavailable', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'unavailable' });
        const event = makeEvent({ method: 'GET' });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(503);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('dependency_unavailable');
    });

    it('returns linked:false when user has no Jellyseerr account', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'not_linked' });
        const event = makeEvent({ method: 'GET' });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        expect(body.linked).toBe(false);
        expect(Array.isArray(body.items)).toBe(true);
        expect((body.items as unknown[]).length).toBe(0);
    });

    it('canonicalises `tv` mediaType to `series` in response items', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetDismissalsForUser.mockResolvedValue([]);
        mockGetPendingRequestsForUser.mockResolvedValue([
            {
                id: 1,
                type: 'tv', // old Jellyseerr value
                media: { tmdbId: 1396, status: 2, status4k: undefined },
                mediaInfo: { title: 'Drifting Clouds', posterPath: '/poster.jpg' },
                status: 1,
                is4k: false,
                createdAt: '2026-01-01T00:00:00Z',
            },
        ]);
        mockFilterOrphanedRequests.mockImplementation((arr: unknown[]) =>
            Promise.resolve({ kept: arr }),
        );
        mockFilterRequestsWithoutCatalogMatch.mockImplementation((arr: unknown[]) =>
            Promise.resolve({ kept: arr }),
        );
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeEvent({ method: 'GET' });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        const items = body.items as Array<{ mediaType: string; dismissalKey: string }>;
        expect(items.length).toBe(1);
        // `tv` from Jellyseerr → `series` in public API response
        expect(items[0].mediaType).toBe('series');
        expect(items[0].dismissalKey).toBe('tmdb:1396:tv');
    });
});

// ── GET /requests — scope=all admin gate ──────────────────────────────────────

describe('GET /requests — scope=all admin gate', () => {
    it('returns 403 scope_required for scope=all without requests:admin', async () => {
        const event = makeEvent({ method: 'GET', searchParams: { scope: 'all' } });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(403);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('scope_required');
    });

    it('allows scope=all when principal has requests:admin', async () => {
        // scope=all uses getRequests (all-users endpoint) — NOT getPendingRequestsForUser
        const allUsersRequests = [
            {
                id: 10,
                type: 'movie',
                media: { tmdbId: 550, status: 1, status4k: undefined },
                mediaInfo: { title: 'Quiet Orbit', posterPath: null },
                status: 1,
                is4k: false,
                createdAt: '2026-01-01T00:00:00Z',
            },
        ];
        mockGetRequests.mockResolvedValue(allUsersRequests);
        mockFilterOrphanedRequests.mockImplementation((arr: unknown[]) =>
            Promise.resolve({ kept: arr }),
        );
        mockFilterRequestsWithoutCatalogMatch.mockImplementation((arr: unknown[]) =>
            Promise.resolve({ kept: arr }),
        );
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeEvent({
            method: 'GET',
            searchParams: { scope: 'all' },
            principalScopes: ['admin', 'requests:admin'],
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        // Must call getRequests (all-users), NOT getPendingRequestsForUser (per-user)
        expect(mockGetRequests).toHaveBeenCalled();
        expect(mockGetPendingRequestsForUser).not.toHaveBeenCalled();
        const body = await bodyJson(res as Response);
        const items = body.items as Array<{ id: number }>;
        expect(items.length).toBe(1);
        expect(items[0].id).toBe(10);
    });

    it('refuses scope=all when only locals.user.isAdmin says admin (no principal)', async () => {
        // locals.user.isAdmin is the OWNER's flag; without a principal there are
        // no admin rights (requests-admin.ts, spec 2026-10-07 §5.1).
        const event = makeEvent({
            method: 'GET',
            searchParams: { scope: 'all' },
            isAdmin: true,
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(403);
        expect(mockGetRequests).not.toHaveBeenCalled();
    });

    it('allows scope=all for an admin session principal', async () => {
        // scope=all uses getRequests (all-users endpoint) — NOT getPendingRequestsForUser
        mockGetRequests.mockResolvedValue([]);

        const event = makeEvent({
            method: 'GET',
            searchParams: { scope: 'all' },
            isAdmin: true,
            adminSession: true,
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        expect(mockGetRequests).toHaveBeenCalled();
        expect(mockGetPendingRequestsForUser).not.toHaveBeenCalled();
    });

    it('returns 422 for unknown scope value', async () => {
        const event = makeEvent({ method: 'GET', searchParams: { scope: 'bogus' } });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });
});

// ── GET /requests?externalId= — media-detail lookup ──────────────────────────

describe('GET /requests — ?externalId= lookup', () => {
    /** An already-fulfilled request: status 5 / media AVAILABLE. */
    const availableMovieRequest = {
        id: 7,
        type: 'movie' as const,
        media: { tmdbId: 550, status: 5, tvdbId: undefined },
        mediaInfo: { title: 'Quiet Orbit', posterPath: '/fc.jpg' },
        status: 5,
        is4k: false,
        createdAt: '2026-01-01T00:00:00Z',
        requestedBy: { id: 1, displayName: 'alice', username: 'alice' },
    };

    /** Same TMDB ID, different media type — the composite-key collision case. */
    const collidingSeriesRequest = {
        ...availableMovieRequest,
        id: 8,
        type: 'tv' as const,
        mediaInfo: { title: 'Some Series', posterPath: '/ss.jpg' },
    };

    it('returns a fulfilled request — not an empty list', async () => {
        // Regression: the branch used getPendingRequestsForUser(), which drops
        // every AVAILABLE request, so a fulfilled request was indistinguishable
        // from "never requested".
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetRequests.mockResolvedValue([availableMovieRequest]);
        mockGetSimpleStatusLabel.mockReturnValue('available');

        const event = makeEvent({ method: 'GET', searchParams: { externalId: 'tmdb:550' } });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);

        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        expect(body.items).toHaveLength(1);
        expect((body.items as Record<string, unknown>[])[0].status).toBe('available');
        expect(mockGetPendingRequestsForUser).not.toHaveBeenCalled();
    });

    it('queries all statuses scoped to the calling user', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 42 } });
        mockGetRequests.mockResolvedValue([]);

        const event = makeEvent({ method: 'GET', searchParams: { externalId: 'tmdb:550' } });
        await requestsDef.handlers.GET!(event, CTX_V1);

        expect(mockGetRequests).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'all', requestedBy: 42 }),
        );
    });

    it('disambiguates a colliding TMDB ID via mediaType', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetRequests.mockResolvedValue([availableMovieRequest, collidingSeriesRequest]);
        mockGetSimpleStatusLabel.mockReturnValue('available');

        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'tmdb:550', mediaType: 'series' },
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);

        const body = await bodyJson(res as Response);
        const items = body.items as Record<string, unknown>[];
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe(8);
        expect(items[0].mediaType).toBe('series');
    });

    it('rejects the legacy `tv` alias for mediaType', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetRequests.mockResolvedValue([availableMovieRequest, collidingSeriesRequest]);
        mockGetSimpleStatusLabel.mockReturnValue('available');

        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'tmdb:550', mediaType: 'tv' },
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);

        expect((res as Response).status).toBe(422);
    });

    it('returns both rows when mediaType is omitted', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetRequests.mockResolvedValue([availableMovieRequest, collidingSeriesRequest]);
        mockGetSimpleStatusLabel.mockReturnValue('available');

        const event = makeEvent({ method: 'GET', searchParams: { externalId: 'tmdb:550' } });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);

        const items = (await bodyJson(res as Response)).items as Record<string, unknown>[];
        expect(items).toHaveLength(2);
    });

    it('returns 422 for an invalid mediaType', async () => {
        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'tmdb:550', mediaType: 'book' },
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        expect((await bodyJson(res as Response)).code).toBe('validation_failed');
    });

    it('returns 503 when the Jellyseerr link cannot be resolved', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'unavailable' });

        const event = makeEvent({ method: 'GET', searchParams: { externalId: 'tmdb:550' } });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(503);
        expect((await bodyJson(res as Response)).code).toBe('dependency_unavailable');
    });

    it('returns linked:false rather than 503 when the user has no Jellyseerr account', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'not_linked' });

        const event = makeEvent({ method: 'GET', searchParams: { externalId: 'tmdb:550' } });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        expect(body.linked).toBe(false);
        expect(body.items).toHaveLength(0);
    });

    it('pages past the first 100 requests instead of truncating', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetSimpleStatusLabel.mockReturnValue('available');

        // A full first page of unrelated requests, with the match on page two.
        const filler = Array.from({ length: 100 }, (_, i) => ({
            ...availableMovieRequest,
            id: 1000 + i,
            media: { ...availableMovieRequest.media, tmdbId: 9000 + i },
        }));
        mockGetRequests
            .mockResolvedValueOnce(filler)
            .mockResolvedValueOnce([availableMovieRequest]);

        const event = makeEvent({ method: 'GET', searchParams: { externalId: 'tmdb:550' } });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);

        const items = (await bodyJson(res as Response)).items as Record<string, unknown>[];
        expect(items).toHaveLength(1);
        expect(mockGetRequests).toHaveBeenCalledTimes(2);
        expect(mockGetRequests).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 100 }));
    });

    it('rejects ids and externalId together', async () => {
        const event = makeEvent({
            method: 'GET',
            searchParams: { ids: '1', externalId: 'tmdb:550' },
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
    });
});

// ── GET /requests/quota — tv→series canonicalisation ─────────────────────────

describe('GET /requests/quota — tv→series canonicalisation', () => {
    it('returns 503 when Jellyseerr is unavailable', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'unavailable' });
        const event = makeEvent({ method: 'GET' });
        const res = await quotaDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(503);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('dependency_unavailable');
    });

    it('returns linked:false when user has no Jellyseerr account', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'not_linked' });
        const event = makeEvent({ method: 'GET' });
        const res = await quotaDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        expect(body.linked).toBe(false);
        expect(body.quota).toBeNull();
    });

    it('exposes `series` key (not `tv`) in quota response', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 5, used: 1, remaining: 4, days: 7, restricted: false },
            tv: { limit: 3, used: 0, remaining: 3, days: 7, restricted: false },
        });

        const event = makeEvent({ method: 'GET' });
        const res = await quotaDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        expect(body.linked).toBe(true);
        const quota = body.quota as Record<string, unknown>;
        // `tv` key → `series` key in public API
        expect(quota).toHaveProperty('series');
        expect(quota).not.toHaveProperty('tv');
        expect((quota.series as Record<string, unknown>).remaining).toBe(3);
    });

    it('returns null remaining when limit is 0 (unlimited)', async () => {
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 0, used: 0, remaining: 0, days: 7, restricted: false },
            tv: { limit: 0, used: 0, remaining: 0, days: 7, restricted: false },
        });

        const event = makeEvent({ method: 'GET' });
        const res = await quotaDef.handlers.GET!(event, CTX_V1);
        const body = await bodyJson(res as Response);
        const quota = body.quota as Record<string, Record<string, unknown>>;
        expect(quota.movie.remaining).toBeNull();
        expect(quota.series.remaining).toBeNull();
    });
});

// ── POST /requests/{id}/dismiss ───────────────────────────────────────────────

describe('POST /requests/{id}/dismiss', () => {
    function makeDismissEvent(body?: unknown) {
        return makeEvent({ body, params: { id: '42' } });
    }

    it('returns 204 on successful dismissal', async () => {
        mockUpsertDismissal.mockResolvedValue({
            success: true,
            dismissedAt: '2026-01-01T00:00:00Z',
        });

        const event = makeDismissEvent({ externalIds: { tmdb: '550' }, mediaType: 'movie' });
        const res = await dismissDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(204);
    });

    it('returns 422 when externalIds is empty', async () => {
        const event = makeDismissEvent({ externalIds: {}, mediaType: 'movie' });
        const res = await dismissDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('accepts `series` mediaType and normalises to `tv` for internal service', async () => {
        mockUpsertDismissal.mockResolvedValue({
            success: true,
            dismissedAt: '2026-01-01T00:00:00Z',
        });

        const event = makeDismissEvent({ externalIds: { tmdb: '1396' }, mediaType: 'series' });
        const res = await dismissDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(204);
        // Verify upsertDismissal was called with the internal `tv` value
        expect(mockUpsertDismissal).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ tmdb: '1396' }),
            'tv', // normalised from 'series'
        );
    });

    it('returns 422 validation_failed when media cannot be identified', async () => {
        mockUpsertDismissal.mockResolvedValue({
            success: false,
            error: 'Cannot identify media',
        });

        const event = makeDismissEvent({ externalIds: { tmdb: '999' }, mediaType: 'movie' });
        const res = await dismissDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 429 when rate limit is exceeded', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: 9999999 });

        const event = makeDismissEvent({ externalIds: { tmdb: '550' }, mediaType: 'movie' });
        const res = await dismissDef.handlers.POST!(event, CTX_V1);
        expect((res as Response).status).toBe(429);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('rate_limited');
    });
});

// ── GET /requests/{id} — single request fetch ────────────────────────────────

describe('GET /requests/{id}', () => {
    /** Sample Jellyseerr request fixture owned by alice */
    const aliceRequest = {
        id: 42,
        type: 'movie' as const,
        media: { tmdbId: 550, status: 1, status4k: undefined },
        mediaInfo: { title: 'Quiet Orbit', posterPath: '/poster.jpg' },
        status: 1,
        is4k: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        requestedBy: { id: 1, displayName: 'alice', username: 'alice', email: 'alice@example.com' },
    };

    function makeIdEvent(id: string, opts: Parameters<typeof makeEvent>[0] = {}) {
        return makeEvent({ ...opts, params: { id } });
    }

    it('auth spec requires user auth', () => {
        expect(requestByIdDef.auth).toMatchObject({ kind: 'user' });
    });

    it('returns 404 when request does not exist', async () => {
        mockGetRequestById.mockResolvedValue(null);
        const event = makeIdEvent('42');
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(404);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('not_found');
    });

    it('returns 422 when id is not a positive integer', async () => {
        const event = makeIdEvent('abc');
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 422 for id = 0', async () => {
        const event = makeIdEvent('0');
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 503 when Jellyseerr is not configured', async () => {
        mockIsConfigured.mockReturnValue(false);
        const event = makeIdEvent('42');
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(503);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('dependency_unavailable');
    });

    it('returns 200 with RequestItem shape when caller owns the request', async () => {
        mockGetRequestById.mockResolvedValue(aliceRequest);
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeIdEvent('42', { username: 'alice' });
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        expect(body.id).toBe(42);
        expect(body.mediaType).toBe('movie');
        expect(body.title).toBe('Quiet Orbit');
        expect(body.status).toBe('pending');
        expect(body.externalIds).toMatchObject({ tmdb: '550' });
    });

    it('canonicalises `tv` media type to `series` in response', async () => {
        const tvRequest = { ...aliceRequest, type: 'tv' as const };
        mockGetRequestById.mockResolvedValue(tvRequest);
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeIdEvent('42', { username: 'alice' });
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        expect(body.mediaType).toBe('series');
    });

    it('returns 403 when caller does not own the request and lacks requests:admin', async () => {
        const bobRequest = {
            ...aliceRequest,
            requestedBy: { id: 2, displayName: 'bob', username: 'bob', email: 'bob@example.com' },
        };
        mockGetRequestById.mockResolvedValue(bobRequest);

        // Caller is alice, request belongs to bob
        const event = makeIdEvent('42', { username: 'alice' });
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(403);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('forbidden');
    });

    it('allows admin to fetch any request via requests:admin scope', async () => {
        const bobRequest = {
            ...aliceRequest,
            requestedBy: { id: 2, displayName: 'bob', username: 'bob', email: 'bob@example.com' },
        };
        mockGetRequestById.mockResolvedValue(bobRequest);
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeIdEvent('42', {
            username: 'alice',
            principalScopes: ['admin', 'requests:admin'],
        });
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        expect(body.id).toBe(42);
    });

    // The `??` chain this replaced never consulted an admin flag once a Principal
    // carried a scopes array: `scopes.includes(...)` returns a BOOLEAN, and `??`
    // only falls through on null/undefined. The existing admin test above passes
    // either way because its fixture omits principalScopes entirely — so the
    // production shape (/api/v1, where resolveAuth always populates scopes) was
    // the one case nothing covered.
    it('allows an admin Principal to fetch any request even without the literal requests:admin scope', async () => {
        const bobRequest = {
            ...aliceRequest,
            requestedBy: { id: 2, displayName: 'bob', username: 'bob', email: 'bob@example.com' },
        };
        mockGetRequestById.mockResolvedValue(bobRequest);
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeIdEvent('42', { username: 'alice', principalScopes: ['read'] });
        // Admin by identity, not by a literal scope match — what deriveIsAdmin decides.
        (event.locals as { principal?: { isAdmin: boolean } }).principal!.isAdmin = true;

        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
    });

    it('does NOT re-grant admin to a low-scope Principal owned by an admin', async () => {
        // The other half of the same precedence rule (H4): once a Principal exists
        // it is authoritative, so locals.user.isAdmin — derived from live groups and
        // blind to the token's scopes — must not rescue a deliberately narrow token.
        const bobRequest = {
            ...aliceRequest,
            requestedBy: { id: 2, displayName: 'bob', username: 'bob', email: 'bob@example.com' },
        };
        mockGetRequestById.mockResolvedValue(bobRequest);

        const event = makeIdEvent('42', {
            username: 'alice',
            isAdmin: true, // locals.user — group-derived, would have granted
            principalScopes: ['read'], // principal.isAdmin stays false
        });
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(403);
    });

    it('allows an admin session to fetch any request without explicit scope', async () => {
        const bobRequest = {
            ...aliceRequest,
            requestedBy: { id: 2, displayName: 'bob', username: 'bob', email: 'bob@example.com' },
        };
        mockGetRequestById.mockResolvedValue(bobRequest);
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeIdEvent('42', { username: 'alice', isAdmin: true, adminSession: true });
        const res = await requestByIdDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
    });
});

// ── GET /requests?ids= batch fetch ───────────────────────────────────────────

describe('GET /requests?ids= batch fetch', () => {
    const req42 = {
        id: 42,
        type: 'movie' as const,
        media: { tmdbId: 550, status: 1, status4k: undefined },
        mediaInfo: { title: 'Quiet Orbit', posterPath: '/poster.jpg' },
        status: 1,
        is4k: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        requestedBy: { id: 1, displayName: 'alice', username: 'alice', email: 'alice@example.com' },
    };

    it('returns items when ids match owned requests', async () => {
        mockIsConfigured.mockReturnValue(true);
        mockGetRequestById.mockImplementation((id: number) =>
            id === 42 ? Promise.resolve(req42) : Promise.resolve(null),
        );
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeEvent({ method: 'GET', searchParams: { ids: '42' }, username: 'alice' });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        const items = body.items as Array<{ id: number }>;
        expect(items.length).toBe(1);
        expect(items[0].id).toBe(42);
    });

    it('filters out requests not owned by the caller', async () => {
        const bobReq = {
            ...req42,
            id: 99,
            requestedBy: { id: 2, displayName: 'bob', username: 'bob', email: 'bob@example.com' },
        };
        mockIsConfigured.mockReturnValue(true);
        mockGetRequestById.mockImplementation((id: number) => {
            if (id === 42) return Promise.resolve(req42);
            if (id === 99) return Promise.resolve(bobReq);
            return Promise.resolve(null);
        });
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        // alice requests both IDs — only her request is returned
        const event = makeEvent({
            method: 'GET',
            searchParams: { ids: '42,99' },
            username: 'alice',
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        const items = body.items as Array<{ id: number }>;
        expect(items.length).toBe(1);
        expect(items[0].id).toBe(42);
    });

    it('returns 422 when ids is empty string', async () => {
        mockIsConfigured.mockReturnValue(true);
        const event = makeEvent({ method: 'GET', searchParams: { ids: '' } });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 422 when ids and externalId are both present', async () => {
        mockIsConfigured.mockReturnValue(true);
        const event = makeEvent({
            method: 'GET',
            searchParams: { ids: '42', externalId: 'tmdb:550' },
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 503 when Jellyseerr is not configured', async () => {
        mockIsConfigured.mockReturnValue(false);
        const event = makeEvent({ method: 'GET', searchParams: { ids: '42' } });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(503);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('dependency_unavailable');
    });
});

// ── GET /requests?externalId= batch fetch ────────────────────────────────────

describe('GET /requests?externalId= batch fetch', () => {
    const req42 = {
        id: 42,
        type: 'movie' as const,
        media: { tmdbId: 550, status: 1, status4k: undefined },
        mediaInfo: { title: 'Quiet Orbit', posterPath: '/poster.jpg' },
        status: 1,
        is4k: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        requestedBy: { id: 1, displayName: 'alice', username: 'alice', email: 'alice@example.com' },
    };

    it('returns matching requests for externalId=tmdb:550', async () => {
        mockIsConfigured.mockReturnValue(true);
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetRequests.mockResolvedValue([req42]);
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'tmdb:550' },
            username: 'alice',
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        const items = body.items as Array<{ id: number }>;
        expect(items.length).toBe(1);
        expect(items[0].id).toBe(42);
    });

    it('returns empty items when no requests match the TMDB ID', async () => {
        mockIsConfigured.mockReturnValue(true);
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetRequests.mockResolvedValue([req42]); // tmdbId 550

        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'tmdb:9999' },
            username: 'alice',
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        const body = await bodyJson(res as Response);
        expect((body.items as unknown[]).length).toBe(0);
    });

    it('returns 422 for externalId without colon separator', async () => {
        mockIsConfigured.mockReturnValue(true);
        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'tmdb550' },
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 422 for unsupported provider', async () => {
        mockIsConfigured.mockReturnValue(true);
        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'imdb:tt0137523' },
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 422 for non-integer TMDB ID', async () => {
        mockIsConfigured.mockReturnValue(true);
        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'tmdb:abc' },
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(422);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('validation_failed');
    });

    it('admin with requests:admin scope uses getRequests (all users)', async () => {
        mockIsConfigured.mockReturnValue(true);
        mockGetRequests.mockResolvedValue([req42]);
        mockGetSimpleStatusLabel.mockReturnValue('pending');

        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'tmdb:550' },
            principalScopes: ['admin', 'requests:admin'],
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(200);
        // Admin path uses getRequests, not getPendingRequestsForUser
        expect(mockGetRequests).toHaveBeenCalled();
        expect(mockGetPendingRequestsForUser).not.toHaveBeenCalled();
        const body = await bodyJson(res as Response);
        expect((body.items as unknown[]).length).toBe(1);
    });

    it('returns 503 when Jellyseerr is not configured', async () => {
        mockIsConfigured.mockReturnValue(false);
        const event = makeEvent({
            method: 'GET',
            searchParams: { externalId: 'tmdb:550' },
        });
        const res = await requestsDef.handlers.GET!(event, CTX_V1);
        expect((res as Response).status).toBe(503);
        const body = await bodyJson(res as Response);
        expect(body.code).toBe('dependency_unavailable');
    });
});

describe('browser request submission shares the public API protections', () => {
    it('rejects exhausted quota before creating a request', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 550 });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 5, used: 5, remaining: 0, days: 7 },
        });
        const res = await browserRequest!(
            makeEvent({ body: { externalIds: { tmdb: '550' }, mediaType: 'movie' } }),
        );
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ code: 'quota_exceeded' });
        expect(mockCreateRequestForUser).not.toHaveBeenCalled();
    });

    it('reports success after creation even if dismissal cleanup fails', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 550 });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockGetUserQuota.mockResolvedValue({
            movie: { limit: 0, used: 0, remaining: null, days: 7 },
        });
        mockCreateRequestForUser.mockResolvedValue({ success: true, requestId: 42 });
        mockDeleteDismissal.mockRejectedValueOnce(new Error('Database unavailable'));
        const res = await browserRequest!(
            makeEvent({ body: { externalIds: { tmdb: '550' }, mediaType: 'movie' } }),
        );
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({
            id: 42,
            requestedAt: expect.any(String),
        });
    });

    it('returns a retry delay in seconds, not an epoch timestamp', async () => {
        mockCheckRateLimit.mockResolvedValue({
            allowed: false,
            resetAt: Math.floor(Date.now() / 1000) + 60,
        });
        const res = await browserRequest!(
            makeEvent({ body: { externalIds: { tmdb: '550' }, mediaType: 'movie' } }),
        );
        expect(res.status).toBe(429);
        const retryAfter = Number(res.headers.get('Retry-After'));
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(60);
    });
});

describe('season picker for series outside the local catalog', () => {
    it('loads seasons through Seerr using the resolved provider ID', async () => {
        const { POST } = await import('../../../../../routes/api/request/seasons/+server.js');
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 123 });
        mockGetRequestSeasons.mockResolvedValue([{ seasonNumber: 1, episodeCount: 6 }]);
        const response = await POST!(
            makeEvent({ body: { externalIds: { tvdb: '456' }, mediaType: 'series' } }),
        );
        expect(response.status).toBe(200);
        expect(mockResolveToTmdb).toHaveBeenCalledWith({ tvdb: '456' }, 'tv');
        expect(mockGetRequestSeasons).toHaveBeenCalledWith(123);
        expect(await response.json()).toEqual({ items: [{ seasonNumber: 1, episodeCount: 6 }] });
    });

    it('reports an upstream failure instead of pretending there are no seasons', async () => {
        const { POST } = await import('../../../../../routes/api/request/seasons/+server.js');
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 123 });
        mockGetRequestSeasons.mockResolvedValue(null);
        const response = await POST!(
            makeEvent({ body: { externalIds: { tmdb: '123' }, mediaType: 'series' } }),
        );
        expect(response.status).toBe(503);
    });
});

describe('request-specific dismissal identity and ownership', () => {
    it('derives the media key from the owned request without reading a body', async () => {
        mockGetRequestById.mockResolvedValue({
            id: 42,
            type: 'tv',
            media: { tmdbId: 1396 },
            requestedBy: { id: 1 },
        });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        mockUpsertDismissal.mockResolvedValue({
            success: true,
            dismissedAt: '2026-10-17T00:00:00Z',
        });
        const event = makeEvent({ params: { id: '42' } });
        const response = await requestDismissalDef.handlers.POST!(event, CTX_V1);
        expect(response.status).toBe(204);
        expect(mockUpsertDismissal).toHaveBeenCalledWith(
            expect.any(String),
            { tmdb: '1396' },
            'tv',
        );
    });
    it('rate-limits before any Jellyseerr call', async () => {
        mockCheckRateLimit.mockResolvedValue({ allowed: false, resetAt: 9999999 });
        mockGetRequestById.mockClear();
        const response = await requestDismissalDef.handlers.POST!(
            makeEvent({ params: { id: '42' } }),
            CTX_V1,
        );
        expect(response.status).toBe(429);
        expect(mockGetRequestById).not.toHaveBeenCalled();
        expect(mockUpsertDismissal).not.toHaveBeenCalled();
    });
    it('returns 404 for a request whose media has no tmdbId', async () => {
        mockGetRequestById.mockResolvedValue({
            id: 42,
            type: 'movie',
            media: {},
            requestedBy: { id: 1 },
        });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        const response = await requestDismissalDef.handlers.POST!(
            makeEvent({ params: { id: '42' } }),
            CTX_V1,
        );
        expect(response.status).toBe(404);
        expect(mockUpsertDismissal).not.toHaveBeenCalled();
    });
    it('returns 404 and never writes a dismissal for another user’s request', async () => {
        mockGetRequestById.mockResolvedValue({
            id: 42,
            type: 'movie',
            media: { tmdbId: 550 },
            requestedBy: { id: 2 },
        });
        mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
        const response = await requestDismissalDef.handlers.POST!(
            makeEvent({ params: { id: '42' } }),
            CTX_V1,
        );
        expect(response.status).toBe(404);
        expect(mockUpsertDismissal).not.toHaveBeenCalled();
    });

    it('lets a requests admin dismiss another user’s request without a Jellyseerr link lookup', async () => {
        mockGetRequestById.mockResolvedValue({
            id: 42,
            type: 'movie',
            media: { tmdbId: 550 },
            requestedBy: { id: 2 },
        });
        mockUpsertDismissal.mockResolvedValue({
            success: true,
            dismissedAt: '2026-10-17T00:00:00Z',
        });
        const response = await requestDismissalDef.handlers.POST!(
            makeEvent({ params: { id: '42' }, adminSession: true }),
            CTX_V1,
        );
        expect(response.status).toBe(204);
        expect(mockResolveUserLink).not.toHaveBeenCalled();
        expect(mockUpsertDismissal).toHaveBeenCalledWith(
            expect.any(String),
            { tmdb: '550' },
            'movie',
        );
    });
    it('treats a token with the requests:admin scope as an admin', async () => {
        mockGetRequestById.mockResolvedValue({
            id: 42,
            type: 'tv',
            media: { tmdbId: 1396 },
            requestedBy: { id: 2 },
        });
        mockUpsertDismissal.mockResolvedValue({
            success: true,
            dismissedAt: '2026-10-17T00:00:00Z',
        });
        const response = await requestDismissalDef.handlers.POST!(
            makeEvent({ params: { id: '42' }, principalScopes: ['requests:admin'] }),
            CTX_V1,
        );
        expect(response.status).toBe(204);
        expect(mockResolveUserLink).not.toHaveBeenCalled();
    });
    it('returns 404 and writes nothing when the caller has no Jellyseerr link (unlinked)', async () => {
        mockGetRequestById.mockResolvedValue({
            id: 42,
            type: 'movie',
            media: { tmdbId: 550 },
            requestedBy: { id: 1 },
        });
        mockResolveUserLink.mockResolvedValue({ state: 'unlinked' });
        const response = await requestDismissalDef.handlers.POST!(
            makeEvent({ params: { id: '42' } }),
            CTX_V1,
        );
        expect(response.status).toBe(404);
        expect(mockUpsertDismissal).not.toHaveBeenCalled();
    });
    it('returns 503 and writes nothing when Jellyseerr cannot resolve the link (unavailable)', async () => {
        mockGetRequestById.mockResolvedValue({
            id: 42,
            type: 'movie',
            media: { tmdbId: 550 },
            requestedBy: { id: 1 },
        });
        mockResolveUserLink.mockResolvedValue({ state: 'unavailable' });
        const response = await requestDismissalDef.handlers.POST!(
            makeEvent({ params: { id: '42' } }),
            CTX_V1,
        );
        expect(response.status).toBe(503);
        expect(mockUpsertDismissal).not.toHaveBeenCalled();
    });
    it.each(['music', 'anime', undefined])(
        'returns 404 for request type %s even for an owner or an admin',
        async (type) => {
            mockGetRequestById.mockResolvedValue({
                id: 42,
                type,
                media: { tmdbId: 550 },
                requestedBy: { id: 1 },
            });
            mockResolveUserLink.mockResolvedValue({ state: 'linked', user: { id: 1 } });
            for (const adminSession of [false, true]) {
                const response = await requestDismissalDef.handlers.POST!(
                    makeEvent({ params: { id: '42' }, adminSession }),
                    CTX_V1,
                );
                expect(response.status).toBe(404);
            }
            expect(mockUpsertDismissal).not.toHaveBeenCalled();
        },
    );
});
