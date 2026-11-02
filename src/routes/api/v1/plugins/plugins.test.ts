// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-mount + auth-gate tests for /api/v1/plugins/external/*.
 *
 * These were written when the endpoints were 501 stubs and asserted that status
 * directly. The external-plugin work (migrations 16.168/16.169) implemented them
 * for real, so those assertions described a contract that no longer exists and
 * the file went red — which is why they now assert the gate rather than the body.
 *
 * What this file covers, and all it covers: that each route exports its verb,
 * that a bearer-less request is rejected 401, that an insufficient scope is
 * rejected 403, and that an admin PAT is admitted THROUGH the gate into the
 * handler. "Admitted" is observed as the handler's deliberate
 * `if (!sql) return ApiResponses.error('database unavailable')` branch — a unit
 * run has no DATABASE_URL, and reaching that line proves auth passed and the
 * handler ran. It is a real code path, not an environment accident.
 *
 * Request/response SHAPES live in the def-layer tests next to each definition
 * (`$lib/server/api/defs/plugins/external/*.test.ts`); install/enable/disable
 * behaviour against a real database belongs in an integration test, not here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockValidatePat = vi.fn();

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
                ownerIsAdmin: (validated.scopes ?? []).includes('admin'),
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
    getServiceTokenService: () => ({ validate: vi.fn() }),
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        headers?: Record<string, string>;
        params?: Record<string, string>;
    } = {},
) {
    return {
        request: {
            headers: new Headers(opts.headers ?? {}),
            json: async () => ({}),
        },
        params: opts.params ?? {},
        url: new URL('http://localhost/api/v1/plugins/external'),
        // authenticate() reads event.locals.user; empty locals routes
        // through the bearer-only path.
        locals: {},
    };
}

const adminPat = {
    id: 1,
    userId: '11111111-1111-4111-8111-111111111111',
    username: 'alice',
    name: 'test',
    scopes: ['admin'],
    groups: [],
    jellyfinUserId: null,
    tokenPrefix: 'pat_aaa',
};

// ── GET /api/v1/plugins/external ─────────────────────────────────────────────

describe('GET /api/v1/plugins/external', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('admits an admin PAT through to the handler', async () => {
        const { GET } = (await import('./external/+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).not.toBe(401);
        expect(resp.status).not.toBe(403);
        expect(resp.status).toBe(500);
    });

    it('returns 401 with no bearer', async () => {
        const { GET } = (await import('./external/+server.js'))!;
        const event = makeEvent();
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 when scope insufficient', async () => {
        mockValidatePat.mockResolvedValue({ ...adminPat, scopes: ['write'] });
        const { GET } = (await import('./external/+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await GET!(event as Parameters<NonNullable<typeof GET>>[0]);
        expect(resp.status).toBe(403);
    });
});

// ── POST /api/v1/plugins/external/install ─────────────────────────────────────

describe('POST /api/v1/plugins/external/install', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('admits an admin PAT through to the handler', async () => {
        const { POST } = (await import('./external/install/+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).not.toBe(401);
        expect(resp.status).not.toBe(403);
        expect(resp.status).toBe(500);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = (await import('./external/install/+server.js'))!;
        const event = makeEvent();
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });
});

// ── POST /api/v1/plugins/external/{id}/uninstall ──────────────────────────────

describe('POST /api/v1/plugins/external/{id}/uninstall', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('admits an admin PAT through to the handler', async () => {
        const { POST } = (await import('./external/[id]/uninstall/+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'my-plugin' },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).not.toBe(401);
        expect(resp.status).not.toBe(403);
        expect(resp.status).toBe(500);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./external/[id]/uninstall/+server.js');
        const event = makeEvent({ params: { id: 'my-plugin' } });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });
});

// ── POST /api/v1/plugins/external/{id}/enable ─────────────────────────────────

describe('POST /api/v1/plugins/external/{id}/enable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('admits an admin PAT through to the handler', async () => {
        const { POST } = await import('./external/[id]/enable/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'my-plugin' },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).not.toBe(401);
        expect(resp.status).not.toBe(403);
        expect(resp.status).toBe(500);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./external/[id]/enable/+server.js');
        const event = makeEvent({ params: { id: 'my-plugin' } });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });
});

// ── POST /api/v1/plugins/external/{id}/disable ────────────────────────────────

describe('POST /api/v1/plugins/external/{id}/disable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('admits an admin PAT through to the handler', async () => {
        const { POST } = await import('./external/[id]/disable/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'my-plugin' },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).not.toBe(401);
        expect(resp.status).not.toBe(403);
        expect(resp.status).toBe(500);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./external/[id]/disable/+server.js');
        const event = makeEvent({ params: { id: 'my-plugin' } });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });
});

// ── POST /api/v1/plugins/external/{id}/reload ─────────────────────────────────

describe('POST /api/v1/plugins/external/{id}/reload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('admits an admin PAT through to the handler', async () => {
        const { POST } = await import('./external/[id]/reload/+server.js');
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            params: { id: 'my-plugin' },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).not.toBe(401);
        expect(resp.status).not.toBe(403);
        expect(resp.status).toBe(500);
    });

    it('returns 401 with no bearer', async () => {
        const { POST } = await import('./external/[id]/reload/+server.js');
        const event = makeEvent({ params: { id: 'my-plugin' } });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });
});
