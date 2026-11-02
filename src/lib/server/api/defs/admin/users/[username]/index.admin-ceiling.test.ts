// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-13, C1: `PATCH /api/admin/users/:username` accepts a
 * `users:admin`-scoped token too — the same ceiling applies as the v1 facade
 * in `defs/users/[id].ts`. Demotion (the self- and last-admin guards) is
 * unaffected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import type { ApiContext } from '$lib/server/api/define.js';

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});
const mockSetUserAdmin = vi.fn();
vi.mock('$lib/server/services/admin-user.service.js', () => ({
    setDisabled: vi.fn(),
    deleteUser: vi.fn(),
    setUserAdmin: (...args: unknown[]) => mockSetUserAdmin(...args),
    setUserAgeRating: vi.fn(),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({ checkRateLimit: vi.fn() }));
vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIpStrict: vi.fn() }));

import { def } from './index.js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(principal: Principal, username: string, body: unknown): RequestEvent {
    return {
        request: new Request(`http://localhost/api/admin/users/${username}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        url: new URL(`http://localhost/api/admin/users/${username}`),
        params: { username },
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

const ctx = { surface: 'internal' } as unknown as ApiContext;

const usersAdminOnly = buildPrincipal({
    kind: 'pat',
    userId: USER_ID,
    username: 'owner',
    userGroups: [],
    tokenScopes: ['users:admin'],
    ownerIsAdmin: false,
});

const adminSession = buildPrincipal({
    kind: 'session',
    userId: USER_ID,
    username: 'root',
    userGroups: ['admins'],
    sessionIsAdmin: true,
});

// The PAT path builds isAdmin differently from the session path (deriveIsAdmin
// requires BOTH ownerIsAdmin AND an explicit admin-equivalent scope for token
// credentials) — mirror the admin-session case with a genuinely admin-scoped
// PAT to confirm the ceiling grants parity for a token caller too.
const adminPat = buildPrincipal({
    kind: 'pat',
    userId: USER_ID,
    username: 'root',
    userGroups: ['admins'],
    tokenScopes: ['admin'],
    ownerIsAdmin: true,
});

const PATCH = def.handlers.PATCH!;

describe('PATCH /api/admin/users/:username: admin ceiling (C1)', () => {
    beforeEach(() => {
        mockSetUserAdmin.mockReset().mockResolvedValue({
            ok: true,
            data: { username: 'owner', isAdmin: true, adminPinned: true },
        });
    });

    it('a users:admin caller cannot promote another user to admin -> 403, setUserAdmin never called', async () => {
        const res = await PATCH(makeEvent(usersAdminOnly, 'owner', { isAdmin: true }), ctx);
        expect(res.status).toBe(403);
        expect(mockSetUserAdmin).not.toHaveBeenCalled();
    });

    it('an admin caller may promote a user to admin', async () => {
        const res = await PATCH(makeEvent(adminSession, 'owner', { isAdmin: true }), ctx);
        expect(res.status).toBeLessThan(300);
        expect(mockSetUserAdmin).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                targetUsername: 'owner',
                change: { kind: 'set', value: true },
            }),
        );
    });

    it('an admin-scoped PAT caller may promote a user to admin', async () => {
        const res = await PATCH(makeEvent(adminPat, 'owner', { isAdmin: true }), ctx);
        expect(res.status).toBeLessThan(300);
        expect(mockSetUserAdmin).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                targetUsername: 'owner',
                change: { kind: 'set', value: true },
            }),
        );
    });

    // Fix round 1, new finding (security review 2026-09-23): unpinning can
    // itself be a promotion (when the target's IdP groups grant admin), so a
    // delegated `users:admin` token must not be able to trigger it any more
    // than it can send `{isAdmin:true}` directly.
    it('a users:admin caller cannot unpin admin status -> 403, setUserAdmin never called', async () => {
        const res = await PATCH(makeEvent(usersAdminOnly, 'owner', { unpin: true }), ctx);
        expect(res.status).toBe(403);
        expect(mockSetUserAdmin).not.toHaveBeenCalled();
    });

    it('an admin caller may unpin admin status', async () => {
        mockSetUserAdmin.mockResolvedValue({
            ok: true,
            data: { username: 'owner', isAdmin: false, adminPinned: false },
        });
        const res = await PATCH(makeEvent(adminSession, 'owner', { unpin: true }), ctx);
        expect(res.status).toBeLessThan(300);
        expect(mockSetUserAdmin).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ targetUsername: 'owner', change: { kind: 'unpin' } }),
        );
    });

    // Task 9 review round 1, IMPORTANT 1: setUserAdmin's unpin branch can now
    // return {status:400} (the carried-C1 self-demotion guard), but this def
    // only mapped 409/404 — a 400 fell through to ApiProblem.internalError()
    // (500), hiding a client error as a server error. Assert the def maps it
    // to a 422 validation_failed, not a 500.
    it('an admin self-unpinning into non-admin maps the 400 self-demotion guard to 422, not 500', async () => {
        mockSetUserAdmin.mockResolvedValue({
            ok: false,
            status: 400,
            message: 'Cannot remove your own admin status',
        });
        const res = await PATCH(makeEvent(adminSession, 'root', { unpin: true }), ctx);
        expect(res.status).toBe(422);
        const body = await res.json();
        expect(body.error ?? body.detail).toContain('Cannot remove your own admin status');
    });
});
