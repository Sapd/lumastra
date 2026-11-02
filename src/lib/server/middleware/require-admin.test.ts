// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `requireAdmin()` (middleware/auth.ts) — split out of
 * `derive-is-admin-from-bearer.test.ts` when that file's namesake function
 * was deleted as dead code (fix round 1, Important #2): `requireAdmin()`
 * itself is very much alive (the primary gate for ~50 route files under
 * `src/routes/`) and keeps its own coverage here.
 *
 * Mocks the shared `resolveBearerAdminPrincipal()` helper directly
 * (`$lib/server/auth/resolve-bearer-principal.ts`) rather than the deeper
 * pat/svc/database chain it's built on — `requireAdmin()` only ever
 * CONSUMES that helper's `Principal | null` result, so this suite is about
 * what `requireAdmin()` does with it (materialise onto `locals.principal`,
 * never overwrite an existing one, deny when null/non-admin), not about how
 * the helper itself resolves a verdict — that's
 * `auth/resolve-bearer-principal.test.ts`'s job.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockResolveBearerAdminPrincipal = vi.fn();
vi.mock('$lib/server/auth/resolve-bearer-principal.js', () => ({
    resolveBearerAdminPrincipal: (...args: unknown[]) => mockResolveBearerAdminPrincipal(...args),
}));

// fix-plan-5 Task 3: resolveBearerAdminPrincipal() now also calls
// getClientIpStrict (IP-outage fix) — export it here too even though this
// suite mocks resolveBearerAdminPrincipal itself wholesale (never exercising
// the real client-ip.js chain): research-shape-a.md §Q1's mock-factory trap
// note calls this out explicitly for both this file and
// resolve-bearer-principal.test.ts, and a future test in this file that
// imports the real helper should not silently fail closed on a missing
// export.
vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIp: () => '127.0.0.1',
    getClientIpStrict: () => '127.0.0.1',
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { requireAdmin, requireSelfOrAdmin } from './auth.js';

function makeAdminEvent(authHeader?: string): RequestEvent {
    const headers = new Headers();
    if (authHeader) headers.set('authorization', authHeader);
    return {
        request: new Request('http://localhost/api/admin/test', { headers }),
        url: new URL('http://localhost/api/admin/test'),
        locals: {},
    } as unknown as RequestEvent;
}

// Item 2: requireAdmin() must materialise event.locals.principal from the
// shared helper when it resolves one and locals.principal isn't already
// set, so an auditLog() call inside a non-mounted /api/admin/* handler is
// attributable to the specific PAT/service token rather than falling
// through to actor:'system'.
describe('requireAdmin(): materialises locals.principal from a Bearer credential (item 2, R5)', () => {
    beforeEach(() => {
        mockResolveBearerAdminPrincipal.mockReset();
    });

    // 2026-10-13: an existing principal's verdict is final; no second Bearer lookup.
    it('an admin principal (session path) never consults the Bearer fallback', async () => {
        const handler = vi.fn(async () => new Response(null, { status: 200 }));
        const event = {
            ...makeAdminEvent(),
            locals: {
                user: { ownerIsAdmin: true, username: 'denis' },
                principal: { kind: 'session', isAdmin: true, username: 'denis' },
            },
        } as unknown as RequestEvent;
        const res = await requireAdmin(handler)(event);
        expect(res.status).toBe(200);
        expect(mockResolveBearerAdminPrincipal).not.toHaveBeenCalled();
    });

    it('a Bearer PAT admin caller reaches the handler with locals.principal materialised', async () => {
        mockResolveBearerAdminPrincipal.mockResolvedValue({
            kind: 'pat',
            isAdmin: true,
            credentialId: '501',
            username: 'ci-token',
        });

        const handler = vi.fn(async (event: RequestEvent) => {
            expect(event.locals.principal).toMatchObject({
                kind: 'pat',
                isAdmin: true,
                credentialId: '501',
            });
            return new Response(null, { status: 200 });
        });

        const event = makeAdminEvent('Bearer pat_citoken');
        const res = await requireAdmin(handler)(event);
        expect(res.status).toBe(200);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    // 2026-10-13: with a principal present its verdict is final; the Bearer header
    // is not looked up again and the principal is left untouched.
    it('does not overwrite an existing locals.principal and does not re-resolve the Bearer', async () => {
        mockResolveBearerAdminPrincipal.mockResolvedValue({
            kind: 'pat',
            isAdmin: true,
            credentialId: '502',
            username: 'ci-token',
        });

        const existingPrincipal = { kind: 'forward_auth', username: 'bob', isAdmin: true };
        const handler = vi.fn(async (event: RequestEvent) => {
            expect(event.locals.principal).toBe(existingPrincipal);
            return new Response(null, { status: 200 });
        });

        const event = {
            request: new Request('http://localhost/api/admin/test', {
                headers: { authorization: 'Bearer pat_citoken' },
            }),
            url: new URL('http://localhost/api/admin/test'),
            locals: { principal: existingPrincipal },
        } as unknown as RequestEvent;
        await requireAdmin(handler)(event);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(mockResolveBearerAdminPrincipal).not.toHaveBeenCalled();
    });

    it('a non-admin principal is denied even when a Bearer header would resolve to an admin', async () => {
        mockResolveBearerAdminPrincipal.mockResolvedValue({
            kind: 'pat',
            isAdmin: true,
            credentialId: '503',
            username: 'ci-token',
        });
        const handler = vi.fn(async () => new Response(null, { status: 200 }));
        const event = {
            request: new Request('http://localhost/api/admin/test', {
                headers: { authorization: 'Bearer pat_citoken' },
            }),
            url: new URL('http://localhost/api/admin/test'),
            locals: { principal: { kind: 'session', username: 'bob', isAdmin: false } },
        } as unknown as RequestEvent;
        const res = await requireAdmin(handler)(event);
        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
        expect(mockResolveBearerAdminPrincipal).not.toHaveBeenCalled();
    });

    it('a non-admin Bearer caller (Principal resolved but isAdmin:false) is denied 403 and the handler never runs', async () => {
        mockResolveBearerAdminPrincipal.mockResolvedValue({
            kind: 'pat',
            isAdmin: false,
            username: 'low-scope',
        });

        const handler = vi.fn();
        const res = await requireAdmin(handler)(makeAdminEvent('Bearer pat_lowscope'));
        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
    });

    it('a Bearer caller the shared helper resolves to null (no admin-class scope) is denied 403', async () => {
        mockResolveBearerAdminPrincipal.mockResolvedValue(null);

        const handler = vi.fn();
        const res = await requireAdmin(handler)(makeAdminEvent('Bearer pat_noscope'));
        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
    });
});

// 2026-10-13 sweep: the verdict is the credential's (localsIsAdmin), not the owner flag.
describe("requireAdmin / requireSelfOrAdmin: an admin owner's non-admin credential", () => {
    beforeEach(() => {
        mockResolveBearerAdminPrincipal.mockReset();
        mockResolveBearerAdminPrincipal.mockResolvedValue(null);
    });

    function eventWith(locals: Record<string, unknown>, params: Record<string, string> = {}) {
        return {
            request: new Request('http://localhost/api/admin/test'),
            url: new URL('http://localhost/api/admin/test'),
            params,
            locals,
        } as unknown as RequestEvent;
    }
    const scopedToken = {
        user: { username: 'admin', isAdmin: true },
        principal: { username: 'admin', isAdmin: false },
    };
    const adminSession = {
        user: { username: 'admin', isAdmin: true },
        principal: { username: 'admin', isAdmin: true },
    };

    it('requireAdmin denies the scoped token and admits the admin session', async () => {
        const handler = vi.fn(async () => new Response('ok'));
        expect((await requireAdmin(handler)(eventWith(scopedToken))).status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
        expect((await requireAdmin(handler)(eventWith(adminSession))).status).toBe(200);
    });

    it("requireSelfOrAdmin refuses another user's data to the scoped token", async () => {
        const handler = vi.fn(async () => new Response('ok'));
        const gate = requireSelfOrAdmin('userId')(handler);
        expect((await gate(eventWith(scopedToken, { userId: 'bob' }))).status).toBe(403);
        expect((await gate(eventWith(adminSession, { userId: 'bob' }))).status).toBe(200);
        expect((await gate(eventWith(scopedToken, { userId: 'admin' }))).status).toBe(200);
    });
});
