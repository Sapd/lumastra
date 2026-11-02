// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for POST /api/v1/libraries/scan (canonical path; relocated from the
 * now-deleted legacy /api/v1/library/scan route, which mounted this same def).
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

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: mockValidateSvc }),
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
                isAdmin: (validated.scopes ?? []).includes('admin'),
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

const mockStartRun = vi.fn();

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: mockStartRun,
    },
}));

vi.mock('$lib/server/tasks/backpressure.js', () => ({
    BackpressureError: class BackpressureError extends Error {
        retryAfterMs: number;
        constructor(retryAfterMs: number) {
            super('queue at capacity');
            this.name = 'BackpressureError';
            this.retryAfterMs = retryAfterMs;
        }
    },
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
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        headers?: Record<string, string>;
        body?: unknown;
        locals?: { user?: unknown };
    } = {},
) {
    return {
        request: {
            headers: new Headers(opts.headers ?? {}),
            json: async () => opts.body ?? {},
        },
        params: {},
        url: new URL('http://localhost/api/v1/libraries/scan'),
        locals: opts.locals ?? {},
    };
}

const adminPat = {
    id: 1,
    userId: '11111111-1111-4111-8111-111111111111',
    username: 'alice',
    name: 'test',
    scopes: ['tasks:run'],
    groups: [],
    jellyfinUserId: null,
    tokenPrefix: 'pat_aaa',
};

// ── POST /api/v1/libraries/scan ─────────────────────────────────────────────────

describe('POST /api/v1/libraries/scan', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidatePat.mockResolvedValue(adminPat);
        mockStartRun.mockResolvedValue({ runId: 'r1', deduped: false });
    });

    it('POST {} returns 202 with runId and statusUrl', async () => {
        const { POST } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {},
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(202);
        const body = (await resp.json()) as { runId: string; deduped: boolean; statusUrl: string };
        expect(body.runId).toBe('r1');
        expect(body.statusUrl).toBe('/api/v1/runs/r1');
        expect(mockStartRun).toHaveBeenCalledWith(
            'file-library-scan',
            { libraryPathId: undefined },
            expect.objectContaining({ trigger: { kind: 'manual', by: 'alice' } }),
        );
    });

    it('returns 200 when run is deduped', async () => {
        mockStartRun.mockResolvedValue({ runId: 'r1', deduped: true });
        const { POST } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {},
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { deduped: boolean };
        expect(body.deduped).toBe(true);
    });

    it('returns 403 when token lacks tasks:run scope', async () => {
        mockValidatePat.mockResolvedValue({ ...adminPat, scopes: ['read'] });
        const { POST } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {},
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(403);
    });

    it('returns 422 for malformed libraryPathId (non-uuid)', async () => {
        const { POST } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: { libraryPathId: 'not-a-uuid' },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(422);
    });

    it('returns 401 with no bearer token', async () => {
        const { POST } = (await import('./+server.js'))!;
        const event = makeEvent({ body: {} });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 503 with Retry-After when BackpressureError', async () => {
        const { BackpressureError } = await import('$lib/server/tasks/backpressure.js');
        mockStartRun.mockRejectedValue(new BackpressureError(30_000));
        const { POST } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: {},
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        expect(resp.status).toBe(503);
        expect(resp.headers.get('retry-after')).toBe('30');
    });

    it('scopes scan to libraryPathId when provided', async () => {
        mockValidatePat.mockResolvedValue(adminPat);
        mockStartRun.mockResolvedValue({ runId: 'r2', deduped: false });
        const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
        const { POST } = (await import('./+server.js'))!;
        const event = makeEvent({
            headers: { authorization: 'Bearer pat_abc' },
            body: { libraryPathId: uuid },
        });
        const resp = await POST!(event as Parameters<NonNullable<typeof POST>>[0]);
        // Verify startRun was called with the scoped libraryPathId
        expect(resp.status).toBe(202);
        expect(mockStartRun).toHaveBeenCalledWith(
            'file-library-scan',
            { libraryPathId: uuid },
            expect.anything(),
        );
    });
});
