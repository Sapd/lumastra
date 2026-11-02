// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-13, C1: `POST /api/v1/users/{id}/password` let a
 * `users:admin`-only credential reset an ADMINISTRATOR's password. The target
 * user's admin status is checked BEFORE `delegateToAdmin()` hands off to the
 * internal admin handler, so the ceiling judges the real (pre-delegation)
 * caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import type { UserRow } from '$lib/server/database/queries/users.queries.js';

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
const mockGetUserById = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));
const mockDelegateToAdmin = vi.fn();
// The ceiling judges the target via Formula A (resolveOwnerAdminStatus); derive
// it from the mocked row's is_admin so these cases keep their intent.
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatus: async () => {
        const row = (await mockGetUserById()) as { is_admin?: boolean } | null;
        return row ? { isAdmin: row.is_admin === true } : null;
    },
}));
vi.mock('$lib/server/api/delegate.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/api/delegate.js')>();
    return { ...actual, delegateToAdmin: (...args: unknown[]) => mockDelegateToAdmin(...args) };
});
vi.mock('../../../../../../routes/api/admin/users/[username]/password/+server.js', () => ({
    POST: vi.fn(),
}));

import { def } from './password.js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(principal: Principal, id: string): RequestEvent {
    return {
        request: new Request(`http://localhost/api/v1/users/${id}/password`, { method: 'POST' }),
        url: new URL(`http://localhost/api/v1/users/${id}/password`),
        params: { id },
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

function userRow(overrides: Partial<UserRow> = {}): UserRow {
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

describe('POST /api/v1/users/{id}/password: admin ceiling (C1)', () => {
    beforeEach(() => {
        mockGetUserById.mockReset();
        mockDelegateToAdmin.mockReset().mockResolvedValue(new Response('ok', { status: 200 }));
    });

    it("a users:admin caller cannot reset an ADMIN's password -> 403, never delegates", async () => {
        mockGetUserById.mockResolvedValue(userRow({ is_admin: true }));
        const res = await POST(makeEvent(usersAdminOnly, USER_ID), undefined as never);
        expect(res.status).toBe(403);
        expect(mockDelegateToAdmin).not.toHaveBeenCalled();
    });

    it('a users:admin caller may reset a NON-admin password', async () => {
        mockGetUserById.mockResolvedValue(userRow({ is_admin: false }));
        const res = await POST(makeEvent(usersAdminOnly, USER_ID), undefined as never);
        expect(res.status).toBe(200);
        expect(mockDelegateToAdmin).toHaveBeenCalledTimes(1);
    });

    it("an admin caller may reset an ADMIN's password", async () => {
        mockGetUserById.mockResolvedValue(userRow({ is_admin: true }));
        const res = await POST(makeEvent(adminSession, USER_ID), undefined as never);
        expect(res.status).toBe(200);
        expect(mockDelegateToAdmin).toHaveBeenCalledTimes(1);
    });
});
