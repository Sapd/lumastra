// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-12, C3: `POST /api/v1/service-tokens` accepted any
 * scope string from a `tokens:admin` caller and defaulted a MISSING `scopes`
 * to `['admin']`. Scopes are now a required enum, and a non-admin caller can
 * neither mint admin scope nor a token that impersonates an administrator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import type { ApiContext } from '$lib/server/api/define.js';

const mockCreate = vi.fn();
const mockGetMinterEnvelope = vi.fn();
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({
        create: mockCreate,
        listAll: vi.fn(),
        getMinterEnvelope: (...args: unknown[]) => mockGetMinterEnvelope(...args),
    }),
}));
const mockGetUserById = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
    getUserIdByUsername: vi.fn(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
// Security review 2026-09-23, C6: the impersonation-target admin ceiling now
// reads the RESOLVED Formula-A verdict (resolveOwnerAdminStatus) instead of
// the raw `is_admin` column, which missed an in-app-only admin target.
// Mocked at this seam (not the formula itself, which resolve-owner-admin-
// status.test.ts already exercises unmocked) since this file's job is the
// mint-ceiling authorization logic, not the admin formula.
const mockResolveOwnerAdminStatus = vi.fn();
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatus: (...args: unknown[]) => mockResolveOwnerAdminStatus(...args),
}));
vi.mock('$lib/server/config.js', () => ({
    features: { deviceAuth: true },
    config: {},
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { def } from './index.js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(principal: Principal): RequestEvent {
    return {
        request: new Request('http://localhost/api/v1/service-tokens', { method: 'POST' }),
        url: new URL('http://localhost/api/v1/service-tokens'),
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

function ctxWithBody(body: unknown): ApiContext {
    return { surface: 'v1', input: { body } } as unknown as ApiContext;
}

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

const POST = def.handlers.POST!;

describe('POST /service-tokens: minting ceiling (C3)', () => {
    beforeEach(() => {
        mockCreate.mockReset().mockResolvedValue({ id: 1, token: 'svc_new' });
        mockGetUserById.mockReset();
        mockResolveOwnerAdminStatus.mockReset();
    });

    it("tokens:admin caller + scopes ['admin'] -> 403, nothing minted", async () => {
        const res = await POST(
            makeEvent(tokensAdminOnly),
            ctxWithBody({ name: 'x', scopes: ['admin'] }),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('tokens:admin caller impersonating an administrator -> 403, nothing minted', async () => {
        mockGetUserById.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000001',
            username: 'root',
            is_admin: true,
            groups: ['admins'],
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: '00000000-0000-0000-0000-000000000001',
            groups: ['admins'],
            effectiveGroups: ['admins'],
            isAdmin: true,
            adminPinned: false,
        });
        const res = await POST(
            makeEvent(tokensAdminOnly),
            ctxWithBody({
                name: 'x',
                scopes: ['read'],
                actAsUserId: '11111111-1111-4111-8111-111111111111',
            }),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    // RED at HEAD (security review 2026-09-23, C6): the ceiling used to read
    // the RAW `target.is_admin` column directly — an unpinned target whose
    // ONLY admin grant is the in-app `admin` capability has `is_admin:false`
    // on the row, so the raw read said "not admin" and a tokens:admin caller
    // could mint a token impersonating them (201) despite them being admin
    // on every other surface (Formula A). GREEN once the ceiling consumes
    // resolveOwnerAdminStatus()'s resolved verdict instead.
    it('[C6] tokens:admin caller impersonating an in-app-only admin target -> 403, nothing minted', async () => {
        mockGetUserById.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000002',
            username: 'inapp-admin',
            is_admin: false, // raw column says non-admin
            groups: ['users'],
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: '00000000-0000-0000-0000-000000000002',
            groups: ['users'],
            effectiveGroups: ['users'],
            isAdmin: true, // Formula A: in-app `admin` capability
            adminPinned: false,
        });
        const res = await POST(
            makeEvent(tokensAdminOnly),
            ctxWithBody({
                name: 'x',
                scopes: ['read'],
                actAsUserId: '11111111-1111-4111-8111-111111111111',
            }),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    // Usernames are stored case-folded (`testuser`); `actAsUser` arrived as the
    // operator typed it, so `TestUser` was a 422 "not found" for a user that
    // exists. Found by the e2e service-token spec once it could run.
    it('actAsUserId is resolved by UUID', async () => {
        mockGetUserById.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000003',
            username: 'testuser',
            is_admin: false,
            groups: ['users'],
        });
        mockResolveOwnerAdminStatus.mockResolvedValue({
            userId: '00000000-0000-0000-0000-000000000003',
            groups: ['users'],
            effectiveGroups: ['users'],
            isAdmin: false,
            adminPinned: false,
        });
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({
                name: 'x',
                scopes: ['read'],
                actAsUserId: '11111111-1111-4111-8111-111111111111',
            }),
        );
        expect(mockGetUserById).toHaveBeenCalledWith(
            expect.anything(),
            '11111111-1111-4111-8111-111111111111',
        );
        expect(res.status).toBe(201);
    });

    // getUserByUsername does not filter soft-deleted or disabled rows, so a
    // tokens:admin caller could mint a token acting as an account that can no
    // longer sign in.
    it.each([
        ['disabled', { disabled_at: new Date() }],
        ['deleted', { deleted_at: new Date() }],
    ])('actAsUser naming a %s user -> 422, nothing minted', async (_label, extra) => {
        mockGetUserById.mockResolvedValue({
            id: '00000000-0000-0000-0000-000000000004',
            username: 'gone',
            is_admin: false,
            groups: ['users'],
            disabled_at: null,
            deleted_at: null,
            ...extra,
        });
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({
                name: 'x',
                scopes: ['read'],
                actAsUserId: '11111111-1111-4111-8111-111111111111',
            }),
        );
        expect(res.status).toBe(422);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('admin session + admin scope -> 201', async () => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({ name: 'x', scopes: ['admin'] }),
        );
        expect(res.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['admin'] }));
    });

    it('passes the session principal as ownerUserId to the service (no minting token involved)', async () => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({ name: 'x', scopes: ['read'] }),
        );
        expect(res.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({ ownerUserId: USER_ID, createdViaTokenId: undefined }),
        );
    });

    it('records the PAT principal (tokens:admin) as the owner', async () => {
        const res = await POST(
            makeEvent(tokensAdminOnly),
            ctxWithBody({ name: 'x', scopes: ['read'] }),
        );
        expect(res.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: USER_ID }));
    });

    it('the request schema requires at least one scope from the service-token enum', () => {
        const schema = def.request!.body!;
        expect(schema.safeParse({ name: 'x' }).success).toBe(false);
        expect(schema.safeParse({ name: 'x', scopes: [] }).success).toBe(false);
        expect(schema.safeParse({ name: 'x', scopes: ['users:admin'] }).success).toBe(false);
        expect(schema.safeParse({ name: 'x', scopes: ['read'] }).success).toBe(true);
    });
});

describe('POST /service-tokens: service-token caller fails closed', () => {
    const svcPrincipal = buildPrincipal({
        kind: 'service_token',
        userId: USER_ID,
        username: 'service:test-minter',
        userGroups: ['admin'],
        tokenScopes: ['admin'],
        ownerIsAdmin: true,
        credentialId: '101',
    });

    function svcEvent(principal: Principal): RequestEvent {
        return {
            request: new Request('http://localhost/api/v1/service-tokens', {
                method: 'POST',
                headers: { authorization: 'Bearer svc_0123456789abcdef' },
            }),
            url: new URL('http://localhost/api/v1/service-tokens'),
            locals: { principal, user: undefined },
        } as unknown as RequestEvent;
    }

    beforeEach(() => {
        mockCreate.mockReset().mockResolvedValue({ id: 1, token: 'svc_new' });
        mockGetMinterEnvelope.mockReset();
    });

    it('minter row gone (revoked/expired since auth) -> 403, nothing minted', async () => {
        mockGetMinterEnvelope.mockResolvedValue(null);
        const res = await POST(
            svcEvent(svcPrincipal),
            ctxWithBody({ name: 'x', scopes: ['read'] }),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it("minter still owned by 'service:<name>' -> 403, nothing minted", async () => {
        mockGetMinterEnvelope.mockResolvedValue({
            id: 101,
            name: 'test-minter',
            createdBy: 'service:other',
            ownerUserId: '00000000-0000-4000-8000-0000000000aa',
            actAsUser: null,
            scopes: ['admin'],
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            expiresAt: null,
        });
        const res = await POST(
            svcEvent(svcPrincipal),
            ctxWithBody({ name: 'x', scopes: ['read'] }),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('svc_ bearer whose principal is not a service token -> 403, nothing minted', async () => {
        const res = await POST(
            svcEvent(adminSession),
            ctxWithBody({ name: 'x', scopes: ['read'] }),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('owner is the minter’s owner, with the minter recorded', async () => {
        mockGetMinterEnvelope.mockResolvedValue({
            id: 101,
            name: 'test-minter',
            createdBy: 'testowner',
            ownerUserId: '00000000-0000-4000-8000-0000000000aa',
            actAsUser: null,
            scopes: ['admin'],
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            expiresAt: null,
        });
        const res = await POST(
            svcEvent(svcPrincipal),
            ctxWithBody({ name: 'x', scopes: ['read'] }),
        );
        expect(res.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({ createdBy: 'testowner', createdViaTokenId: 101 }),
        );
    });
});

describe('POST /service-tokens: integrations:read grant (API package 15)', () => {
    beforeEach(() => {
        mockCreate.mockReset().mockResolvedValue({ id: 1, token: 'svc_new' });
        mockGetUserById.mockReset();
        mockGetMinterEnvelope.mockReset();
    });

    it('an admin mints integrations:read alone -> 201', async () => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({ name: 'homepage', scopes: ['integrations:read'] }),
        );
        expect(res.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({ scopes: ['integrations:read'] }),
        );
    });

    it('accepts the three integration endpoint paths as prefixes, and GET/HEAD methods', async () => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({
                name: 'bot',
                scopes: ['integrations:read'],
                allowedPathPrefixes: [
                    '/api/v1/integrations/watch-history',
                    '/api/v1/integrations/upcoming',
                    '/api/v1/integrations/homepage/',
                ],
                allowedMethods: ['GET', 'HEAD'],
            }),
        );
        expect(res.status).toBe(201);
    });

    it.each([
        ['combined with another grant', { scopes: ['integrations:read', 'read'] }, 'scopes'],
        [
            'with actAsUserId',
            {
                scopes: ['integrations:read'],
                actAsUserId: '11111111-1111-4111-8111-111111111111',
            },
            'actAsUserId',
        ],
        [
            'with forceNonAdmin',
            { scopes: ['integrations:read'], forceNonAdmin: true },
            'forceNonAdmin',
        ],
        [
            'with a path prefix outside the integrations family',
            {
                scopes: ['integrations:read'],
                allowedPathPrefixes: ['/api/v1/integrations/watch-history', '/api/v1/users'],
            },
            'allowedPathPrefixes',
        ],
        [
            'with a sibling path that only shares the prefix string',
            { scopes: ['integrations:read'], allowedPathPrefixes: ['/api/v1/integrationsx'] },
            'allowedPathPrefixes',
        ],
        [
            'with the integrations family root as a prefix',
            { scopes: ['integrations:read'], allowedPathPrefixes: ['/api/v1/integrations/'] },
            'allowedPathPrefixes',
        ],
        [
            'with another integrations-family path as a prefix',
            { scopes: ['integrations:read'], allowedPathPrefixes: ['/api/v1/integrations/keys'] },
            'allowedPathPrefixes',
        ],
        [
            'with a write method',
            { scopes: ['integrations:read'], allowedMethods: ['GET', 'POST'] },
            'allowedMethods',
        ],
    ])('422s integrations:read %s, nothing minted', async (_label, body, field) => {
        const res = await POST(makeEvent(adminSession), ctxWithBody({ name: 'x', ...body }));
        expect(res.status).toBe(422);
        const problem = (await res.json()) as { details?: Array<{ field: string }> };
        expect(problem.details?.map((d) => d.field)).toContain(field);
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockGetUserById).not.toHaveBeenCalled();
    });

    it('a non-admin caller cannot mint integrations:read -> 403', async () => {
        const holder = buildPrincipal({
            kind: 'pat',
            userId: USER_ID,
            username: 'ops',
            userGroups: [],
            tokenScopes: ['tokens:admin', 'integrations:read'],
            ownerIsAdmin: false,
        });
        const res = await POST(
            makeEvent(holder),
            ctxWithBody({ name: 'x', scopes: ['integrations:read'] }),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('an admin service token cannot mint integrations:read (it does not hold the grant)', async () => {
        mockGetMinterEnvelope.mockResolvedValue({
            id: 101,
            name: 'minter',
            createdBy: 'testowner',
            ownerUserId: '00000000-0000-4000-8000-0000000000aa',
            actAsUser: null,
            scopes: ['admin'],
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            expiresAt: null,
        });
        const svcPrincipal = buildPrincipal({
            kind: 'service_token',
            userId: USER_ID,
            username: 'service:minter',
            userGroups: ['admin'],
            tokenScopes: ['admin'],
            ownerIsAdmin: true,
            credentialId: '101',
        });
        const res = await POST(
            {
                request: new Request('http://localhost/api/v1/service-tokens', {
                    method: 'POST',
                    headers: { authorization: 'Bearer svc_0123456789abcdef' },
                }),
                url: new URL('http://localhost/api/v1/service-tokens'),
                locals: { principal: svcPrincipal, user: undefined },
            } as unknown as RequestEvent,
            ctxWithBody({ name: 'x', scopes: ['integrations:read'] }),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('a minter without owner_user_id cannot mint -> 403', async () => {
        mockGetMinterEnvelope.mockResolvedValue({
            id: 101,
            name: 'minter',
            createdBy: 'testowner',
            ownerUserId: null,
            actAsUser: null,
            scopes: ['admin'],
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            expiresAt: null,
        });
        const svcPrincipal = buildPrincipal({
            kind: 'service_token',
            userId: USER_ID,
            username: 'service:minter',
            userGroups: ['admin'],
            tokenScopes: ['admin'],
            ownerIsAdmin: true,
            credentialId: '101',
        });
        const res = await POST(
            {
                request: new Request('http://localhost/api/v1/service-tokens', {
                    method: 'POST',
                    headers: { authorization: 'Bearer svc_0123456789abcdef' },
                }),
                url: new URL('http://localhost/api/v1/service-tokens'),
                locals: { principal: svcPrincipal, user: undefined },
            } as unknown as RequestEvent,
            ctxWithBody({ name: 'x', scopes: ['read'] }),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('the request schema takes the grant enum and IP literals only', () => {
        const schema = def.request!.body!;
        expect(schema.safeParse({ name: 'x', scopes: ['integrations:read'] }).success).toBe(true);
        expect(schema.safeParse({ name: 'x', scopes: ['integrations:write'] }).success).toBe(false);
        expect(
            schema.safeParse({ name: 'x', scopes: ['read'], allowedIps: ['10.0.0.5', '::1'] })
                .success,
        ).toBe(true);
        for (const bad of ['10.0.0.0/8', 'example.com', '', '999.1.1.1']) {
            expect(
                schema.safeParse({ name: 'x', scopes: ['read'], allowedIps: [bad] }).success,
            ).toBe(false);
        }
        const many = Array.from({ length: 33 }, (_, i) => `10.0.0.${i + 1}`);
        expect(schema.safeParse({ name: 'x', scopes: ['read'], allowedIps: many }).success).toBe(
            false,
        );
    });
});

describe('POST /service-tokens: the new token needs an owner id', () => {
    beforeEach(() => {
        mockCreate.mockReset().mockResolvedValue({ id: 1, token: 'svc_new' });
    });

    it('a non-token caller without a user id -> 403, nothing minted', async () => {
        const ownerless = buildPrincipal({
            kind: 'session',
            userId: undefined as unknown as typeof USER_ID,
            username: 'root',
            userGroups: ['admins'],
            sessionIsAdmin: true,
        });
        const res = await POST(makeEvent(ownerless), ctxWithBody({ name: 'x', scopes: ['read'] }));
        expect(res.status).toBe(403);
        expect(JSON.stringify(await res.json())).toContain('Cannot determine the token owner');
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('a session caller mints with its own user id as owner', async () => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({ name: 'x', scopes: ['read'] }),
        );
        expect(res.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: USER_ID }));
    });
});

describe('POST /service-tokens: diagnostics:read grant (debug report, spec 2026-10-21 §6)', () => {
    const DIAG_BODY = { name: 'debug-bot', scopes: ['diagnostics:read'], expiresInDays: 7 };

    beforeEach(() => {
        mockCreate.mockReset().mockResolvedValue({ id: 1, token: 'svc_new' });
        mockGetUserById.mockReset();
        mockGetMinterEnvelope.mockReset();
    });

    it('an admin mints diagnostics:read alone with an expiry -> 201', async () => {
        const res = await POST(makeEvent(adminSession), ctxWithBody(DIAG_BODY));
        expect(res.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({ scopes: ['diagnostics:read'], expiresInDays: 7 }),
        );
    });

    it('accepts the report path (and a child below it) as a prefix, and GET/HEAD', async () => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({
                ...DIAG_BODY,
                allowedPathPrefixes: [
                    '/api/v1/admin/debug-report',
                    '/api/v1/admin/debug-report/runs/',
                ],
                allowedMethods: ['GET', 'HEAD'],
            }),
        );
        expect(res.status).toBe(201);
    });

    it.each([
        '/api/v1/admin/debug-report/../users',
        '/api/v1/admin/debug-report/runs/../../users',
        '/api/v1/admin/debug-report/runs/./x',
        '/api/v1/admin/debug-report/runs/%2e%2e/users',
        '/api/v1/admin/debug-report//health',
        '/api/v1/admin/debug-report/unknown',
        '/api/v1/admin/debug-report/healthcheck',
    ])('422s an unsafe diagnostics prefix %s', async (prefix) => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({ ...DIAG_BODY, allowedPathPrefixes: [prefix] }),
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as { details?: Array<{ field: string }> };
        expect(body.details).toEqual(
            expect.arrayContaining([expect.objectContaining({ field: 'allowedPathPrefixes' })]),
        );
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it.each(['health', 'runs', 'client-diagnostics', 'cluster'])(
        'accepts the known diagnostics child %s',
        async (child) => {
            const res = await POST(
                makeEvent(adminSession),
                ctxWithBody({
                    ...DIAG_BODY,
                    allowedPathPrefixes: [`/api/v1/admin/debug-report/${child}`],
                }),
            );
            expect(res.status).toBe(201);
        },
    );

    it('accepts exactly 90 days', async () => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({ ...DIAG_BODY, expiresInDays: 90 }),
        );
        expect(res.status).toBe(201);
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ expiresInDays: 90 }));
    });

    it.each([
        ['combined with another grant', { scopes: ['diagnostics:read', 'read'] }, 'scopes'],
        [
            'combined with integrations:read',
            { scopes: ['diagnostics:read', 'integrations:read'] },
            'scopes',
        ],
        [
            'with actAsUserId',
            { actAsUserId: '11111111-1111-4111-8111-111111111111' },
            'actAsUserId',
        ],
        ['with forceNonAdmin', { forceNonAdmin: true }, 'forceNonAdmin'],
        ['with no expiry', { expiresInDays: undefined }, 'expiresInDays'],
        ['with expiresInDays null', { expiresInDays: null }, 'expiresInDays'],
        ['with 91 days', { expiresInDays: 91 }, 'expiresInDays'],
        [
            'with a path prefix outside the report',
            { allowedPathPrefixes: ['/api/v1/admin/users'] },
            'allowedPathPrefixes',
        ],
        [
            'with a sibling path that only shares the prefix string',
            { allowedPathPrefixes: ['/api/v1/admin/debug-reportx'] },
            'allowedPathPrefixes',
        ],
        [
            'with the admin prefix above the report',
            { allowedPathPrefixes: ['/api/v1/admin'] },
            'allowedPathPrefixes',
        ],
        ['with a POST method', { allowedMethods: ['GET', 'POST'] }, 'allowedMethods'],
    ])('422s diagnostics:read %s, nothing minted', async (_label, patch, field) => {
        const body: Record<string, unknown> = { ...DIAG_BODY, ...(patch as object) };
        // `expiresInDays: undefined` in the patch means "absent": drop the key.
        if (body.expiresInDays === undefined) delete body.expiresInDays;
        const res = await POST(makeEvent(adminSession), ctxWithBody(body));
        expect(res.status).toBe(422);
        const problem = (await res.json()) as { details?: Array<{ field: string }> };
        expect(problem.details?.map((d) => d.field)).toContain(field);
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockGetUserById).not.toHaveBeenCalled();
    });

    it('a non-admin PAT holding the grant cannot mint diagnostics:read -> 403', async () => {
        const holder = buildPrincipal({
            kind: 'pat',
            userId: USER_ID,
            username: 'ops',
            userGroups: [],
            tokenScopes: ['tokens:admin', 'diagnostics:read'],
            ownerIsAdmin: false,
        });
        const res = await POST(makeEvent(holder), ctxWithBody(DIAG_BODY));
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it('an admin service token cannot mint diagnostics:read for a child (it does not literally hold the grant)', async () => {
        mockGetMinterEnvelope.mockResolvedValue({
            id: 101,
            name: 'minter',
            createdBy: 'testowner',
            ownerUserId: '00000000-0000-4000-8000-0000000000aa',
            actAsUser: null,
            scopes: ['admin'],
            allowedIps: null,
            allowedPathPrefixes: null,
            allowedMethods: null,
            forceNonAdmin: false,
            expiresAt: null,
        });
        const svcPrincipal = buildPrincipal({
            kind: 'service_token',
            userId: USER_ID,
            username: 'service:minter',
            userGroups: ['admin'],
            tokenScopes: ['admin'],
            ownerIsAdmin: true,
            credentialId: '101',
        });
        const res = await POST(
            {
                request: new Request('http://localhost/api/v1/service-tokens', {
                    method: 'POST',
                    headers: { authorization: 'Bearer svc_0123456789abcdef' },
                }),
                url: new URL('http://localhost/api/v1/service-tokens'),
                locals: { principal: svcPrincipal, user: undefined },
            } as unknown as RequestEvent,
            ctxWithBody(DIAG_BODY),
        );
        expect(res.status).toBe(403);
        expect(mockCreate).not.toHaveBeenCalled();
    });
});
