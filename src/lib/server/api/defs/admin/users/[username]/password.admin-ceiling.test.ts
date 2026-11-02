// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-13, C1: `POST /api/admin/users/:username/password`
 * let a `users:admin`-only credential reset an ADMINISTRATOR's password —
 * reachable directly (internal surface, users:admin scope) as well as via the
 * v1 facade's `delegateToAdmin()` handoff. The ceiling judges the caller via
 * `principalBeforeDelegation()` first, so it still catches the delegated path
 * even though `delegateToAdmin()` elevates `locals.principal` for the handoff.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import type { ApiContext } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import type { UserRow } from '$lib/server/database/queries/users.queries.js';

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
const mockGetUserByUsername = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...args: unknown[]) => mockGetUserByUsername(...args),
}));
const mockResetPassword = vi.fn();
vi.mock('$lib/server/services/admin-user.service.js', () => ({
    resetPassword: (...args: unknown[]) => mockResetPassword(...args),
}));
// The ceiling judges the target via Formula A (resolveOwnerAdminStatus); derive
// it from the mocked row so these cases keep their is_admin-driven intent.
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatus: async (sql: unknown, username: string) => {
        const row = (await mockGetUserByUsername(sql, username)) as UserRow | null;
        return row ? { isAdmin: row.is_admin === true } : null;
    },
}));
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});

import { def } from './password.js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(principal: Principal, username: string): RequestEvent {
    return {
        request: new Request(`http://localhost/api/admin/users/${username}/password`, {
            method: 'POST',
        }),
        url: new URL(`http://localhost/api/admin/users/${username}/password`),
        params: { username },
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

function ctxWithBody(body: unknown): ApiContext {
    return { surface: 'internal', input: { body } } as unknown as ApiContext;
}

function targetRow(overrides: Partial<UserRow> = {}): UserRow {
    return {
        id: USER_ID,
        username: 'target',
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        display_name: null,
        email: null,
        hide_streams: false,
        groups: [],
        groups_updated_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        last_seen_at: null,
        disabled_at: null,
        deleted_at: null,
        avatar_data: null,
        avatar_content_type: null,
        ...overrides,
    };
}

const usersAdminOnly = buildPrincipal({
    kind: 'pat',
    userId: USER_ID,
    username: 'ops',
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

const POST = def.handlers.POST!;

describe('POST /api/admin/users/:username/password: admin ceiling (C1)', () => {
    beforeEach(() => {
        mockGetUserByUsername.mockReset();
        mockResetPassword.mockReset().mockResolvedValue({ ok: true, data: undefined });
    });

    it("a users:admin caller cannot reset an ADMIN's password -> 403, resetPassword never called", async () => {
        mockGetUserByUsername.mockResolvedValue(targetRow({ is_admin: true }));
        const res = await POST(
            makeEvent(usersAdminOnly, 'target'),
            ctxWithBody({ newPassword: 'newpassword123' }),
        );
        expect(res.status).toBe(403);
        expect(mockResetPassword).not.toHaveBeenCalled();
    });

    it('a users:admin caller may reset a NON-admin password', async () => {
        mockGetUserByUsername.mockResolvedValue(targetRow({ is_admin: false }));
        const res = await POST(
            makeEvent(usersAdminOnly, 'target'),
            ctxWithBody({ newPassword: 'newpassword123' }),
        );
        expect(res.status).toBe(200);
        expect(mockResetPassword).toHaveBeenCalledTimes(1);
    });

    it("an admin caller may reset an ADMIN's password", async () => {
        mockGetUserByUsername.mockResolvedValue(targetRow({ is_admin: true }));
        const res = await POST(
            makeEvent(adminSession, 'target'),
            ctxWithBody({ newPassword: 'newpassword123' }),
        );
        expect(res.status).toBe(200);
        expect(mockResetPassword).toHaveBeenCalledTimes(1);
    });

    it('reached via delegateToAdmin, still judges the ORIGINAL non-admin caller -> 403', async () => {
        mockGetUserByUsername.mockResolvedValue(targetRow({ is_admin: true }));
        const event = makeEvent(usersAdminOnly, 'target');
        let seenElevated: boolean | undefined;
        // 2026-10-13: delegateToAdmin() no longer elevates locals.principal.
        const res = await delegateToAdmin(event, async (ev) => {
            seenElevated = ev.locals.principal?.isAdmin;
            return POST(ev, ctxWithBody({ newPassword: 'newpassword123' }));
        });
        expect(seenElevated).toBe(false);
        expect(res.status).toBe(403);
        expect(mockResetPassword).not.toHaveBeenCalled();
    });
});
