// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-12, C3: `POST /api/admin/pats` (and its `/api/v1/pats`
 * facade) let a `tokens:admin` caller mint an `admin`-scoped PAT for any admin
 * user, which then satisfied deriveIsAdmin() everywhere. The endpoint now
 * refuses more authority than the caller holds.
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
const mockPatCreate = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ create: mockPatCreate }),
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, features: {
            ...actual.features,
            deviceAuth: false, // the PAT admin handlers gate on userPats only
            userPats: true,
            jellyfinSync: false,
        } };
});
vi.mock('$lib/server/jellyfin/user.service.js', () => ({
    jellyfinUserService: { getUserByName: vi.fn() },
}));
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});
// Formula A verdict for the target; defaults to the row's is_admin below.
const mockResolveOwner = vi.fn();
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatus: (...args: unknown[]) => mockResolveOwner(...args),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { def } from './pats.js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(principal: Principal, body: unknown): RequestEvent {
    return {
        request: new Request('http://localhost/api/admin/pats', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        url: new URL('http://localhost/api/admin/pats'),
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

const ctx = { surface: 'internal' } as unknown as ApiContext;

const tokensAdminOnly = buildPrincipal({
    kind: 'pat',
    userId: USER_ID,
    username: 'ops',
    userGroups: [],
    tokenScopes: ['tokens:admin', 'read'],
    ownerIsAdmin: false,
});
const adminSession = buildPrincipal({
    kind: 'session',
    userId: USER_ID,
    username: 'root',
    userGroups: ['admins'],
    sessionIsAdmin: true,
});

function targetUser(isAdmin: boolean): void {
    mockResolveOwner.mockResolvedValue({ isAdmin });
    mockSql.mockResolvedValue([
        {
            id: '00000000-0000-0000-0000-000000000001',
            username: 'target',
            groups: isAdmin ? ['admins'] : [],
            is_admin: isAdmin,
        },
    ]);
}

const POST = def.handlers.POST!;

describe('POST /admin/pats: minting ceiling (C3)', () => {
    beforeEach(() => {
        mockSql.mockReset();
        mockPatCreate.mockReset().mockResolvedValue({ id: 5, token: 'pat_new' });
    });

    it("tokens:admin caller + scopes ['admin'] for a plain user -> 403, nothing minted", async () => {
        targetUser(false);
        const res = await POST(
            makeEvent(tokensAdminOnly, {
                userId: '11111111-1111-4111-8111-111111111111',
                name: 'x',
                scopes: ['admin'],
            }),
            ctx,
        );
        expect(res.status).toBe(403);
        expect(mockPatCreate).not.toHaveBeenCalled();
    });

    it('tokens:admin caller + read scope for an ADMIN user -> 403, nothing minted', async () => {
        targetUser(true);
        const res = await POST(
            makeEvent(tokensAdminOnly, {
                userId: '11111111-1111-4111-8111-111111111111',
                name: 'x',
                scopes: ['read'],
            }),
            ctx,
        );
        expect(res.status).toBe(403);
        expect(mockPatCreate).not.toHaveBeenCalled();
    });

    it('tokens:admin caller + read scope for a plain user -> minted', async () => {
        targetUser(false);
        const res = await POST(
            makeEvent(tokensAdminOnly, {
                userId: '11111111-1111-4111-8111-111111111111',
                name: 'x',
                scopes: ['read'],
            }),
            ctx,
        );
        expect(res.status).toBeLessThan(300);
        expect(mockPatCreate).toHaveBeenCalledTimes(1);
    });

    it('admin session + admin scope for an admin user -> minted', async () => {
        targetUser(true);
        const res = await POST(
            makeEvent(adminSession, {
                userId: '11111111-1111-4111-8111-111111111111',
                name: 'x',
                scopes: ['admin'],
            }),
            ctx,
        );
        expect(res.status).toBeLessThan(300);
        expect(mockPatCreate).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['admin'] }));
    });

    it('tokens:admin caller for an in-app admin whose is_admin column is false -> 403', async () => {
        targetUser(false);
        mockResolveOwner.mockResolvedValue({ isAdmin: true });
        const res = await POST(
            makeEvent(tokensAdminOnly, {
                userId: '11111111-1111-4111-8111-111111111111',
                name: 'x',
                scopes: ['read'],
            }),
            ctx,
        );
        expect(res.status).toBe(403);
        expect(mockPatCreate).not.toHaveBeenCalled();
    });

    it('rejects a lifetime beyond the cap instead of overflowing the Date range', async () => {
        targetUser(false);
        const res = await POST(
            makeEvent(adminSession, {
                userId: '11111111-1111-4111-8111-111111111111',
                name: 'x',
                scopes: ['read'],
                expiresInDays: 1e15,
            }),
            ctx,
        );
        expect(res.status).toBe(422);
        expect(mockPatCreate).not.toHaveBeenCalled();
    });
});

describe('GET /admin/pats filters', () => {
    it('422s an invalid filter instead of returning every token', async () => {
        const GET = def.handlers.GET!;
        const event = {
            url: new URL('http://localhost/api/admin/pats?scope=bogus'),
            locals: { principal: adminSession, user: undefined },
            request: new Request('http://localhost/api/admin/pats?scope=bogus'),
        } as unknown as RequestEvent;
        const res = await GET(event, ctx);
        expect(res.status).toBe(422);
    });
});
