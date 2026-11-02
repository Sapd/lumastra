// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-13, C1: a `users:admin`-only credential could PATCH
 * `isAdmin: true` on any user — including itself — pinning full admin status.
 * `users:admin` stays a non-admin delegation scope (model (a)): granting admin
 * now requires the caller to already be an administrator. Demotion is unaffected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import type { ApiContext } from '$lib/server/api/define.js';
import type { UserRow } from '$lib/server/database/queries/users.queries.js';

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
const mockGetUserById = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));
const mockSetUserAdmin = vi.fn();
const mockSetUserEmail = vi.fn();
const mockSetDisabled = vi.fn();
const mockSetUserAgeRating = vi.fn();
vi.mock('$lib/server/services/admin-user.service.js', () => ({
    setUserEmail: (...args: unknown[]) => mockSetUserEmail(...args),
    setDisabled: (...args: unknown[]) => mockSetDisabled(...args),
    setUserAdmin: (...args: unknown[]) => mockSetUserAdmin(...args),
    setUserAgeRating: (...args: unknown[]) => mockSetUserAgeRating(...args),
}));
const mockResolveOwnerAdminStatus = vi.fn();
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatus: (...args: unknown[]) => mockResolveOwnerAdminStatus(...args),
}));
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, config: { ...actual.config, ADMIN_GROUPS: [] } };
});

import { def } from './[id].js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(principal: Principal, id: string): RequestEvent {
    return {
        request: new Request(`http://localhost/api/v1/users/${id}`, { method: 'PATCH' }),
        url: new URL(`http://localhost/api/v1/users/${id}`),
        params: { id },
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

function ctxWithBody(body: unknown): ApiContext {
    return { surface: 'v1', input: { body } } as unknown as ApiContext;
}

function userRow(overrides: Partial<UserRow> = {}): UserRow {
    return {
        id: USER_ID,
        username: 'owner',
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

describe('PATCH /api/v1/users/{id}: admin ceiling (C1)', () => {
    beforeEach(() => {
        mockGetUserById.mockReset().mockResolvedValue(userRow());
        mockSetUserAdmin.mockReset().mockResolvedValue({
            ok: true,
            data: { username: 'owner', isAdmin: true, adminPinned: true },
        });
    });

    it('a users:admin caller cannot promote itself to admin -> 403, setUserAdmin never called', async () => {
        const res = await PATCH(makeEvent(usersAdminOnly, USER_ID), ctxWithBody({ isAdmin: true }));
        expect(res.status).toBe(403);
        expect(mockSetUserAdmin).not.toHaveBeenCalled();
    });

    it('an admin caller may promote a user to admin', async () => {
        mockGetUserById
            .mockResolvedValueOnce(userRow())
            .mockResolvedValueOnce(userRow({ is_admin: true }));
        const res = await PATCH(makeEvent(adminSession, USER_ID), ctxWithBody({ isAdmin: true }));
        expect(res.status).toBe(200);
        expect(mockSetUserAdmin).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                targetUsername: 'owner',
                change: { kind: 'set', value: true },
            }),
        );
    });

    it('an admin-scoped PAT caller may promote a user to admin', async () => {
        mockGetUserById
            .mockResolvedValueOnce(userRow())
            .mockResolvedValueOnce(userRow({ is_admin: true }));
        const res = await PATCH(makeEvent(adminPat, USER_ID), ctxWithBody({ isAdmin: true }));
        expect(res.status).toBe(200);
        expect(mockSetUserAdmin).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                targetUsername: 'owner',
                change: { kind: 'set', value: true },
            }),
        );
    });
});

describe('PATCH /api/v1/users/{id}: disable ceiling for an admin target', () => {
    beforeEach(() => {
        mockGetUserById.mockReset().mockResolvedValue(userRow());
        mockSetDisabled.mockReset().mockResolvedValue({ ok: true, data: undefined });
        mockSetUserAgeRating.mockReset().mockResolvedValue({ ok: true, data: undefined });
        mockResolveOwnerAdminStatus.mockReset();
    });

    it('403s a users:admin caller disabling a Formula-A admin and writes NO other field first', async () => {
        // is_admin column false; the admin verdict comes from an in-app group.
        mockResolveOwnerAdminStatus.mockResolvedValue({ isAdmin: true });
        const res = await PATCH(
            makeEvent(usersAdminOnly, USER_ID),
            ctxWithBody({ maxAgeRating: 12, disabled: true }),
        );
        expect(res.status).toBe(403);
        expect(mockSetUserAgeRating).not.toHaveBeenCalled();
        expect(mockSetDisabled).not.toHaveBeenCalled();
    });

    it('lets a users:admin caller disable a non-admin', async () => {
        mockResolveOwnerAdminStatus.mockResolvedValue({ isAdmin: false });
        const res = await PATCH(
            makeEvent(usersAdminOnly, USER_ID),
            ctxWithBody({ disabled: true }),
        );
        expect(res.status).toBe(200);
        expect(mockSetDisabled).toHaveBeenCalledTimes(1);
    });
});

describe('PATCH user email', () => {
    beforeEach(() => {
        mockGetUserById.mockReset().mockResolvedValue(userRow());
        mockSetUserEmail.mockReset().mockResolvedValue({ ok: true, data: undefined });
        mockResolveOwnerAdminStatus.mockReset().mockResolvedValue({ isAdmin: false });
    });
    it.each(['victim@example.test', ''])(
        'rejects delegated email changes even for a non-admin (%s)',
        async (email) => {
            const res = await PATCH(makeEvent(usersAdminOnly, USER_ID), ctxWithBody({ email }));
            expect(res.status).toBe(403);
            expect(mockSetUserEmail).not.toHaveBeenCalled();
        },
    );

    it('passes the validated email to storage and returns the updated record', async () => {
        mockGetUserById
            .mockResolvedValueOnce(userRow())
            .mockResolvedValueOnce(userRow({ email: 'anna@example.test' }));
        const body = def.request!.body!.parse({ email: ' Anna@Example.Test ' });
        const res = await PATCH(makeEvent(adminSession, USER_ID), ctxWithBody(body));
        expect(res.status).toBe(200);
        expect(mockSetUserEmail).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ targetUsername: 'owner', email: 'anna@example.test' }),
        );
        expect(await res.json()).toMatchObject({ user: { email: 'anna@example.test' } });
    });
    it('prevents delegated user managers from changing an effective admin’s matching email', async () => {
        mockResolveOwnerAdminStatus.mockResolvedValue({ isAdmin: true });
        const res = await PATCH(
            makeEvent(usersAdminOnly, USER_ID),
            ctxWithBody({ email: 'anna@example.test' }),
        );
        expect(res.status).toBe(403);
        expect(mockSetUserEmail).not.toHaveBeenCalled();
    });
    it('rejects combined email and role edits before any field can be written', () => {
        expect(
            def.request!.body!.safeParse({ email: 'anna@example.test', isAdmin: true }).success,
        ).toBe(false);
    });
    it('maps duplicate email to an actionable conflict response', async () => {
        mockSetUserEmail.mockResolvedValue({
            ok: false,
            status: 409,
            message: 'Use a different email.',
        });
        const res = await PATCH(
            makeEvent(adminSession, USER_ID),
            ctxWithBody({ email: 'anna@example.test' }),
        );
        expect(res.status).toBe(409);
    });
});
