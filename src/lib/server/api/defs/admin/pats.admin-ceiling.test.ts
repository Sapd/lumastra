// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Release review 2026-10-21, finding 3: a non-admin holding `tokens:admin` could
 * list and revoke an administrator's PATs (mint was already guarded). List and
 * revoke now apply the same "target must not be an admin unless the caller is"
 * rule as the device routes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import type { ApiContext } from '$lib/server/api/define.js';

const mockSql = vi.fn();
vi.mock('$lib/server/database/index.js', () => ({
    getDb:
        () =>
        (...args: unknown[]) =>
            mockSql(...args),
}));
const mockListAll = vi.fn();
const mockListForUser = vi.fn();
const mockRevoke = vi.fn();
const mockRevokeAsAdmin = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        listAll: mockListAll,
        listForUser: mockListForUser,
        revoke: mockRevoke,
        revokeAsAdmin: mockRevokeAsAdmin,
    }),
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, features: { ...actual.features, deviceAuth: false, userPats: true } };
});
vi.mock('$lib/server/jellyfin/user.service.js', () => ({
    jellyfinUserService: { getUserByName: vi.fn() },
}));
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});
const mockOwnerById = vi.fn();
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatus: vi.fn(),
    resolveOwnerAdminStatusById: (...a: unknown[]) => mockOwnerById(...a),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: vi.fn(async (_sql: unknown, id: string) => ({ id, username: `user-${id}` })),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { def as adminPats } from './pats.js';
import { def as userPats } from '../users/[id]/pats.js';
import { def as userPatsId } from '../users/[id]/pats-id.js';

const ADMIN_ID = '00000000-0000-4000-8000-0000000000aa';
const PLAIN_ID = '00000000-0000-4000-8000-0000000000bb';
const CALLER = toUserId('00000000-0000-4000-8000-000000000042');
const ctx = { surface: 'internal' } as unknown as ApiContext;

const delegate: Principal = buildPrincipal({
    kind: 'pat',
    userId: CALLER,
    username: 'ops',
    userGroups: [],
    tokenScopes: ['tokens:admin'],
    ownerIsAdmin: false,
});
const admin: Principal = buildPrincipal({
    kind: 'session',
    userId: CALLER,
    username: 'root',
    userGroups: ['admins'],
    sessionIsAdmin: true,
});

function ev(
    principal: Principal,
    method: string,
    url: string,
    params: Record<string, string> = {},
): RequestEvent {
    return {
        request: new Request(url, { method }),
        url: new URL(url),
        params,
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

function patItem(ownerId: string) {
    return {
        id: 1,
        owner: { userId: ownerId, displayName: null, images: {} },
        name: 't',
        description: null,
        tokenPrefix: 'pat_x',
        scopes: ['read'],
        allowedIps: null,
        createdAt: new Date(),
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        usageCount: 0,
        isExpired: false,
    };
}

beforeEach(() => {
    mockSql.mockReset().mockResolvedValue([]);
    mockOwnerById
        .mockReset()
        .mockImplementation(async (_s: unknown, id: string) => ({ isAdmin: id === ADMIN_ID }));
    mockListAll.mockReset();
    mockListForUser.mockReset().mockResolvedValue([]);
    mockRevoke.mockReset().mockResolvedValue(true);
    mockRevokeAsAdmin.mockReset().mockResolvedValue({ revoked: true, username: 'x' });
});

describe('users/{id}/pats list', () => {
    const GET = userPats.handlers.GET!;
    it('non-admin delegate cannot list an administrator’s PATs', async () => {
        const res = await GET(ev(delegate, 'GET', 'http://l/x', { id: ADMIN_ID }), ctx);
        expect(res.status).toBe(403);
        expect(mockListForUser).not.toHaveBeenCalled();
    });
    it('non-admin delegate can list a plain user’s PATs; an admin can list anyone’s', async () => {
        expect((await GET(ev(delegate, 'GET', 'http://l/x', { id: PLAIN_ID }), ctx)).status).toBe(
            200,
        );
        expect((await GET(ev(admin, 'GET', 'http://l/x', { id: ADMIN_ID }), ctx)).status).toBe(
            200,
        );
    });
});

describe('users/{id}/pats/{tokenId} revoke', () => {
    const DELETE = userPatsId.handlers.DELETE!;
    it('non-admin delegate cannot revoke an administrator’s PAT', async () => {
        const res = await DELETE(
            ev(delegate, 'DELETE', 'http://l/x', { id: ADMIN_ID, tokenId: '7' }),
            ctx,
        );
        expect(res.status).toBe(403);
        expect(mockRevoke).not.toHaveBeenCalled();
    });
    it('non-admin delegate can revoke a plain user’s PAT', async () => {
        const res = await DELETE(
            ev(delegate, 'DELETE', 'http://l/x', { id: PLAIN_ID, tokenId: '7' }),
            ctx,
        );
        expect(res.status).toBe(204);
    });
});

describe('admin/pats list and revoke', () => {
    it('GET ?userId=<admin> is refused for a delegate', async () => {
        const res = await adminPats.handlers.GET!(
            ev(delegate, 'GET', `http://l/api/admin/pats?userId=${ADMIN_ID}`),
            ctx,
        );
        expect(res.status).toBe(403);
        expect(mockListAll).not.toHaveBeenCalled();
    });
    it('GET (all) hides administrators’ PATs from a delegate, not from an admin', async () => {
        mockListAll.mockResolvedValue([patItem(ADMIN_ID), patItem(PLAIN_ID)]);
        const asDelegate = await adminPats.handlers.GET!(
            ev(delegate, 'GET', 'http://l/api/admin/pats'),
            ctx,
        );
        const d = (await asDelegate.json()) as { items: { owner: { userId: string } }[] };
        expect(d.items.map((i) => i.owner.userId)).toEqual([PLAIN_ID]);
        const asAdmin = await adminPats.handlers.GET!(
            ev(admin, 'GET', 'http://l/api/admin/pats'),
            ctx,
        );
        expect(((await asAdmin.json()) as { items: unknown[] }).items).toHaveLength(2);
    });
    it('DELETE of an administrator’s PAT is refused for a delegate, nothing revoked', async () => {
        mockSql.mockResolvedValue([{ user_id: ADMIN_ID }]);
        const res = await adminPats.handlers.DELETE!(
            ev(delegate, 'DELETE', 'http://l/api/admin/pats?id=9', { id: '9' }),
            ctx,
        );
        expect(res.status).toBe(403);
        expect(mockRevokeAsAdmin).not.toHaveBeenCalled();
    });
    it('DELETE of a plain user’s PAT works for a delegate', async () => {
        mockSql.mockResolvedValue([{ user_id: PLAIN_ID }]);
        const res = await adminPats.handlers.DELETE!(
            ev(delegate, 'DELETE', 'http://l/api/admin/pats?id=9', { id: '9' }),
            ctx,
        );
        expect(res.status).toBe(204);
    });
});
