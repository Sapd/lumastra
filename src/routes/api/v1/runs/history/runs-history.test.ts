// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for DELETE /api/v1/runs/history
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockValidatePat = vi.fn();

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: mockValidatePat }),
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn() }),
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

const mockGetDb = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: mockGetDb,
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
        badRequest: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400 }),
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
    opts: {
        headers?: Record<string, string>;
        url?: URL;
        body?: unknown;
    } = {},
) {
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    return {
        request: new Request('http://localhost/api/v1/runs/history', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json', ...opts.headers },
            body,
        }),
        params: {},
        url: opts.url ?? new URL('http://localhost/api/v1/runs/history'),
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
const readPat = {
    id: 2,
    userId: '22222222-2222-4222-8222-222222222222',
    username: 'bob',
    scopes: ['read'],
    groups: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/runs/history', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        mockValidatePat.mockResolvedValue(adminPat);
    });

    it('returns 401 with no bearer', async () => {
        mockGetDb.mockReturnValue(null);
        const { DELETE } = await import('./+server.js');
        const resp = await DELETE(makeEvent() as Parameters<typeof DELETE>[0]);
        expect(resp.status).toBe(401);
    });

    it('returns 403 for read scope', async () => {
        mockValidatePat.mockResolvedValue(readPat);
        mockGetDb.mockReturnValue(null);
        const { DELETE } = await import('./+server.js');
        const resp = await DELETE(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
            }) as Parameters<typeof DELETE>[0],
        );
        expect(resp.status).toBe(403);
    });

    it('defaults olderThanDays to 90 when missing (schema-driven)', async () => {
        // No olderThanDays → schema applies default(90). With DB unavailable
        // the handler returns 503, not 400 — the contract is now "missing is
        // allowed and means 90 days".
        mockGetDb.mockReturnValue(null);
        const { DELETE } = await import('./+server.js');
        const resp = await DELETE(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
            }) as Parameters<typeof DELETE>[0],
        );
        expect(resp.status).toBe(503);
    });

    it('returns 422 when olderThanDays is below schema minimum', async () => {
        mockGetDb.mockReturnValue(null);
        const { DELETE } = await import('./+server.js');
        const resp = await DELETE(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                body: { olderThanDays: 0 },
            }) as Parameters<typeof DELETE>[0],
        );
        expect(resp.status).toBe(422);
    });

    /**
     * Build a tagged-template SQL stub whose `.begin()` invokes the callback
     * with the same tx handle (so canned-row sequencing carries through).
     * The route handler now wraps lock + CREATE + CTE inside `sql.begin()`
     * to keep the advisory lock held across the whole trim operation.
     */
    function makeTxSql(sequence: Array<unknown>) {
        let call = 0;
        const tag = (async (..._args: unknown[]) => {
            const next = sequence[call];
            call += 1;
            if (next instanceof Error) throw next;
            return next ?? [];
        }) as unknown as ((...a: unknown[]) => Promise<unknown>) & {
            begin: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
        };
        tag.begin = async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> => cb(tag);
        return tag;
    }

    it('returns kind=complete with deleted count via query string', async () => {
        // Inside sql.begin(): advisory lock → CREATE TABLE → trim CTE.
        const fakeSql = makeTxSql([[{ acquired: true }], [], [{ archived: '5', deleted: '5' }]]);
        mockGetDb.mockReturnValue(fakeSql);
        const url = new URL('http://localhost/api/v1/runs/history?olderThanDays=90');
        const { DELETE } = await import('./+server.js');
        const resp = await DELETE(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                url,
            }) as Parameters<typeof DELETE>[0],
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            kind: string;
            deleted: number;
            message?: string;
        };
        expect(body.kind).toBe('complete');
        expect(body.deleted).toBe(5);
    });

    it('returns kind=complete via JSON body', async () => {
        const fakeSql = makeTxSql([[{ acquired: true }], [], [{ archived: '12', deleted: '12' }]]);
        mockGetDb.mockReturnValue(fakeSql);
        const { DELETE } = await import('./+server.js');
        const resp = await DELETE(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                body: { olderThanDays: 30 },
            }) as Parameters<typeof DELETE>[0],
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { kind: string; deleted: number };
        expect(body.kind).toBe('complete');
        expect(body.deleted).toBe(12);
    });

    it('returns kind=already-running when advisory lock collides', async () => {
        // Lock fails first call; no further queries fire inside begin().
        const fakeSql = makeTxSql([[{ acquired: false }]]);
        mockGetDb.mockReturnValue(fakeSql);
        const url = new URL('http://localhost/api/v1/runs/history?olderThanDays=90');
        const { DELETE } = await import('./+server.js');
        const resp = await DELETE(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                url,
            }) as Parameters<typeof DELETE>[0],
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { kind: string; deleted: number };
        expect(body.kind).toBe('already-running');
        expect(body.deleted).toBe(0);
    });

    it('returns kind=partial on DB error mid-batch', async () => {
        const fakeSql = makeTxSql([[{ acquired: true }], [], new Error('connection lost')]);
        mockGetDb.mockReturnValue(fakeSql);
        const url = new URL('http://localhost/api/v1/runs/history?olderThanDays=90');
        const { DELETE } = await import('./+server.js');
        const resp = await DELETE(
            makeEvent({
                headers: { authorization: 'Bearer pat_abc' },
                url,
            }) as Parameters<typeof DELETE>[0],
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
            kind: string;
            deleted: number;
            message: string;
        };
        expect(body.kind).toBe('partial');
        expect(body.deleted).toBe(0);
        expect(body.message).toContain('connection lost');
    });
});
