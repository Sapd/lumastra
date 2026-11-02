// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for GET /api/v1/libraries/paths (canonical path; relocated from the
 * now-deleted legacy /api/v1/library/paths route, which mounted this same def).
 *
 * All external dependencies are mocked — no live infrastructure required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockValidatePat = vi.fn();
const mockValidateSvc = vi.fn();

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: mockValidatePat }),
}));

// fix-plan-5 Task 3: authenticate()'s pat_ branch now resolves identity via
// resolveTokenUserAccess() (Formula A) instead of trusting the raw
// validate() row directly. This suite is about the route's own business
// logic, not identity-resolution correctness (that has its own coverage in
// resolve-token-user-access.test.ts / tasks/api-auth.test.ts), so derive the
// mock's answer from whatever mockValidatePat is configured with per test,
// rather than hitting a real (unconfigured here) Postgres connection.
vi.mock('$lib/server/auth/resolve-token-user-access.js', () => ({
    resolveTokenUserAccess: async (username: string) => {
        const validated = await mockValidatePat();
        if (!validated || validated.username !== username) return null;
        return {
            userGroups: validated.groups ?? [],
            disabled: false,
            deleted: false,
            permissions: {
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                hasReviewPermission: false,
                hasMediaAnnotationPermission: false,
                // The owner is a current admin. Since 2026-10-02 a NON-admin
                // owner's admin-class scopes ('tasks:admin' here) are stripped
                // (stripsAdminScopesForToken() in principal.ts).
                ownerIsAdmin: true,
                maxAgeRating: null,
                isAgeRestricted: false,
                isModerator: false,
                liveTvPriority: 'low',
            },
        };
    },
    computeOwnerMaxAge: () => null,
    mergeMaxAge: (a: number | null, b: number | null) =>
        a === null ? b : b === null ? a : Math.min(a, b),
    MOST_RESTRICTIVE_AGE_RATING: 0,
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: mockValidateSvc }),
}));

const mockGetSql = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

const mockGetAllLibraryPaths = vi.fn();

vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getAllLibraryPaths: mockGetAllLibraryPaths,
}));

vi.mock('$lib/server/mappers/library-path.mapper.js', () => ({
    // Return a full LibraryPath-conforming object — the response schema is the
    // canonical LibraryPathSchema (not a 2-field stub), so every required field
    // must be present or the response-contract gate flags it.
    mapLibraryPathToApi: (row: { id: string; source_prefix: string | null }) => ({
        id: row.id,
        path: '/media/movies',
        mediaType: 'movie',
        language: 'en',
        provider: 'tmdb',
        fallbackProviders: [],
        enabled: true,
        providerPath: null,
        libraryGroupId: 'lg-uuid-1',
        editionLabel: null,
        scanChapters: false,
        sourcePrefix: row.source_prefix,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    }),
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (evt: unknown) => Promise<Response>) => async (evt: unknown) => {
        try {
            return await fn(evt);
        } catch (err) {
            if (err && typeof err === 'object' && 'statusCode' in err) {
                const e = err as { statusCode: number; message: string };
                return new Response(JSON.stringify({ error: e.message }), {
                    status: e.statusCode,
                });
            }
            throw err;
        }
    },
}));

vi.mock('$lib/server/utils/api-responses.js', () => ({
    ApiResponses: {
        unauthorized: (msg: string) =>
            new Response(JSON.stringify({ error: msg }), { status: 401 }),
        forbidden: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 403 }),
        notFound: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 404 }),
        badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
        aiDatabaseUnavailable: (endpoint?: string) =>
            new Response(JSON.stringify({ error: 'AI database unavailable', endpoint }), {
                status: 503,
            }),
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        headers?: Record<string, string>;
        locals?: { user?: unknown };
    } = {},
) {
    return {
        request: {
            headers: new Headers(opts.headers ?? {}),
        },
        url: new URL('http://localhost/api/v1/libraries/paths'),
        locals: opts.locals ?? {},
    };
}

// WAS `scopes: ['tasks:read']` — moved to `tasks:admin` (C5, 2026-09-18
// fix-plan-4 Task 2: `tasks:read` was auto-granted to every non-admin
// session, so a `tasks:read`-scoped credential is no longer sufficient here.
// `tasks:admin` is not itself mintable by an ordinary PAT
// (patScopeSchema.options in schemas/admin.ts) — this mock fabricates the
// validated-token shape directly, as the file already did for `tasks:read`.
const adminPat = {
    id: 1,
    userId: '11111111-1111-4111-8111-111111111111',
    username: 'alice',
    name: 'test',
    scopes: ['tasks:admin'],
    groups: [],
    jellyfinUserId: null,
    tokenPrefix: 'pat_aaa',
};

const stubRow = {
    id: 'lp-uuid-1',
    source_prefix: 'movies/',
};

// ── GET /api/v1/libraries/paths ─────────────────────────────────────────────────

describe('GET /api/v1/libraries/paths', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
        mockGetSql.mockResolvedValue({});
        mockGetAllLibraryPaths.mockResolvedValue([stubRow]);
    });

    it('returns paths list with sourcePrefix for valid tasks:admin token', async () => {
        const { GET } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { paths: Array<{ id: string; sourcePrefix: string }> };
        expect(body.paths).toHaveLength(1);
        expect(body.paths[0].id).toBe('lp-uuid-1');
        expect(body.paths[0].sourcePrefix).toBe('movies/');
    });

    it('returns 401 with no bearer', async () => {
        const { GET } = (await import('./+server.js'))!;
        const event = makeEvent();
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 when scope is insufficient', async () => {
        mockValidatePat.mockResolvedValue({
            ...adminPat,
            scopes: ['jellyfin_compat'],
        });
        const { GET } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(403);
    });

    it('returns 403 for a tasks:read-only token (C5 — no longer sufficient)', async () => {
        mockValidatePat.mockResolvedValue({
            ...adminPat,
            scopes: ['tasks:read'],
        });
        const { GET } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(403);
    });

    it('returns 403 for a bare read/write token (the auto-grant this task removed)', async () => {
        mockValidatePat.mockResolvedValue({
            ...adminPat,
            scopes: ['read', 'write'],
        });
        const { GET } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(403);
    });

    it('returns 503 when AI database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const { GET } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(503);
    });

    it('returns empty paths array when no library paths configured', async () => {
        mockGetAllLibraryPaths.mockResolvedValue([]);
        const { GET } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { paths: unknown[] };
        expect(body.paths).toHaveLength(0);
    });
});
