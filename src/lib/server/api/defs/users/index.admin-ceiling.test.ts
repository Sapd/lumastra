// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-13, C1: `POST /api/v1/users` let a `users:admin`-only
 * credential create a brand-new admin account (`isAdmin: true`). `users:admin`
 * stays a non-admin delegation scope (model (a)): creating an admin now
 * requires the caller to already be an administrator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import type { ApiContext } from '$lib/server/api/define.js';

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
const mockCreateUser = vi.fn();
vi.mock('$lib/server/services/admin-user.service.js', () => ({
    createUser: (...args: unknown[]) => mockCreateUser(...args),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({ listUsers: vi.fn() }));
vi.mock('$lib/server/mappers/user.mapper.js', () => ({ mapUserToApi: vi.fn() }));

vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});

import { auditLog } from '$lib/server/utils/audit-log.js';
import { def } from './index.js';
import { CreateLocalUserResponseSchema } from '$lib/schemas/api-admin-responses.js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(principal: Principal): RequestEvent {
    return {
        request: new Request('http://localhost/api/v1/users', { method: 'POST' }),
        url: new URL('http://localhost/api/v1/users'),
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

function ctxWithBody(body: unknown): ApiContext {
    return { surface: 'v1', input: { body } } as unknown as ApiContext;
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

const POST = def.handlers.POST!;

describe('POST /api/v1/users: admin ceiling (C1)', () => {
    beforeEach(() => {
        vi.mocked(auditLog).mockClear();
        mockCreateUser.mockReset().mockResolvedValue({
            ok: true,
            data: {
                id: '11111111-1111-4111-8111-111111111111',
                username: 'newadmin',
                isAdmin: true,
            },
        });
    });

    it('a users:admin caller cannot create a new admin -> 403, createUser never called', async () => {
        const res = await POST(
            makeEvent(usersAdminOnly),
            ctxWithBody({ username: 'newadmin', password: 'password123', isAdmin: true }),
        );
        expect(res.status).toBe(403);
        expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it.each(['victim@example.test', ''])(
        'rejects every delegated email assignment (%s)',
        async (email) => {
            const res = await POST(
                makeEvent(usersAdminOnly),
                ctxWithBody({
                    username: 'victim',
                    password: 'password123',
                    isAdmin: false,
                    email,
                }),
            );
            expect(res.status).toBe(403);
            expect(mockCreateUser).not.toHaveBeenCalled();
        },
    );

    it('a users:admin caller may still create a plain (non-admin) user', async () => {
        mockCreateUser.mockResolvedValue({
            ok: true,
            data: {
                id: '22222222-2222-4222-8222-222222222222',
                username: 'newuser',
                isAdmin: false,
            },
        });
        const res = await POST(
            makeEvent(usersAdminOnly),
            ctxWithBody({ username: 'newuser', password: 'password123' }),
        );
        expect(res.status).toBe(201);
        expect(mockCreateUser).toHaveBeenCalledTimes(1);
        expect(await res.json()).toMatchObject({
            user: { id: '22222222-2222-4222-8222-222222222222' },
        });
    });

    it('passes email to creation and exposes the native-login warning', async () => {
        mockCreateUser.mockResolvedValue({
            ok: true,
            data: { id: USER_ID, username: 'anna', isAdmin: false },
            warnings: ['native_login_disabled'],
        });
        const body = def.request!.body!.parse({
            username: 'anna',
            password: 'password123',
            email: 'anna@example.test',
        });
        const res = await POST(makeEvent(adminSession), ctxWithBody(body));
        expect(mockCreateUser).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ email: 'anna@example.test' }),
        );
        expect(auditLog).toHaveBeenCalledWith('user.create', 'anna', expect.anything(), {
            isAdmin: false,
            emailHash: 'fa8cb084c54d9b1b1837e67b6ceba88433135ad4588a091751592165c96b1c55',
        });
        expect(JSON.stringify(vi.mocked(auditLog).mock.calls)).not.toContain('anna@example.test');
        expect(CreateLocalUserResponseSchema.parse(await res.json())).toMatchObject({
            warnings: ['native_login_disabled'],
        });
    });

    it('an admin caller may create a new admin', async () => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({ username: 'newadmin', password: 'password123', isAdmin: true }),
        );
        expect(res.status).toBe(201);
        expect(mockCreateUser).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ isAdmin: true }),
        );
    });

    it('an admin-scoped PAT caller may create a new admin', async () => {
        const res = await POST(
            makeEvent(adminPat),
            ctxWithBody({ username: 'newadmin', password: 'password123', isAdmin: true }),
        );
        expect(res.status).toBe(201);
        expect(mockCreateUser).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ isAdmin: true }),
        );
    });
});
