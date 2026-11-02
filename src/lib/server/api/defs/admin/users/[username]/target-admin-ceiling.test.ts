// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `users:admin` is a non-admin delegation scope (security review 2026-09-13,
 * C1). Before 2026-10-06 the ceiling covered only promotion and the password
 * reset, and the password reset judged the target by the raw `users.is_admin`
 * column. A `users:admin`-only token could therefore:
 *   - reset the password of an admin whose verdict comes from an in-app group
 *     or IdP group (`is_admin` lags Formula A for an unpinned admin),
 *   - mint and read an admin's Subsonic token, export an admin's personal
 *     data, unlink an admin's sign-in identity, remap their Jellyfin user,
 *   - disable, re-enable or delete an admin account.
 *
 * Each case calls the def handler with a `users:admin`-only PAT against a
 * target who is admin by Formula A while `is_admin` is false, and asserts the
 * 403 plus that the service was never reached.
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

// Formula A verdict for the target. `is_admin` is never consulted any more.
const mockResolveOwnerAdminStatus = vi.fn();
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', () => ({
    resolveOwnerAdminStatus: (...args: unknown[]) => mockResolveOwnerAdminStatus(...args),
}));

const svc = {
    resetPassword: vi.fn(),
    setDisabled: vi.fn(),
    deleteUser: vi.fn(),
    setUserAdmin: vi.fn(),
    setUserAgeRating: vi.fn(),
    unlinkIdentity: vi.fn(),
    listUserIdentities: vi.fn(),
    setJellyfinOverride: vi.fn(),
    resolveJellyfinForUser: vi.fn(),
    collectUserExport: vi.fn(),
    getOrCreateToken: vi.fn(),
    resetToken: vi.fn(),
    deleteUserToken: vi.fn(),
};
vi.mock('$lib/server/services/admin-user.service.js', () => ({
    resetPassword: (...a: unknown[]) => svc.resetPassword(...a),
    setDisabled: (...a: unknown[]) => svc.setDisabled(...a),
    deleteUser: (...a: unknown[]) => svc.deleteUser(...a),
    setUserAdmin: (...a: unknown[]) => svc.setUserAdmin(...a),
    setUserAgeRating: (...a: unknown[]) => svc.setUserAgeRating(...a),
}));
vi.mock('$lib/server/services/admin-identity.service.js', () => ({
    unlinkIdentity: (...a: unknown[]) => svc.unlinkIdentity(...a),
    listUserIdentities: (...a: unknown[]) => svc.listUserIdentities(...a),
    setJellyfinOverride: (...a: unknown[]) => svc.setJellyfinOverride(...a),
    resolveJellyfinForUser: (...a: unknown[]) => svc.resolveJellyfinForUser(...a),
}));
vi.mock('$lib/server/database/queries/gdpr-export.queries.js', () => ({
    collectUserExport: (...a: unknown[]) => svc.collectUserExport(...a),
}));
vi.mock('$lib/server/subsonic-compat/auth.js', () => ({
    getOrCreateToken: (...a: unknown[]) => svc.getOrCreateToken(...a),
    resetToken: (...a: unknown[]) => svc.resetToken(...a),
    deleteUserToken: (...a: unknown[]) => svc.deleteUserToken(...a),
    formatTokenForDisplay: (t: string) => t,
}));
vi.mock('$lib/server/database/queries/subsonic-client-passwords.queries.js', () => ({
    getTokenByUserId: { one: vi.fn().mockResolvedValue(null) },
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: vi.fn().mockResolvedValue({ id: 'u-1', username: 'target' }),
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, features: { ...actual.features, subsonicCompat: true } };
});
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, resetAt: 0 }),
}));
vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIpStrict: () => '127.0.0.1' }));

import { def as passwordDef } from './password.js';
import { def as indexDef } from './index.js';
import { def as subsonicDef } from './subsonic-password.js';
import { def as gdprDef } from './gdpr-export.js';
import { def as identitiesDef } from './identities.js';
import { def as jellyfinDef } from './jellyfin.js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

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

function makeEvent(
    principal: Principal,
    method: string,
    path: string,
    body?: unknown,
): RequestEvent {
    const url = new URL(`http://localhost/api/admin/users/target${path}`);
    return {
        request: new Request(url, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
        url,
        params: { username: 'target' },
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

function ctx(body?: unknown): ApiContext {
    return { surface: 'internal', input: { body } } as unknown as ApiContext;
}

interface Case {
    name: string;
    call: (p: Principal) => Response | Promise<Response>;
    service: ReturnType<typeof vi.fn>;
}

const cases: Case[] = [
    {
        name: 'POST password',
        call: (p) =>
            passwordDef.handlers.POST!(
                makeEvent(p, 'POST', '/password'),
                ctx({ newPassword: 'a-long-new-password' }),
            ),
        service: svc.resetPassword,
    },
    {
        name: 'PATCH disabled',
        call: (p) => indexDef.handlers.PATCH!(makeEvent(p, 'PATCH', '', { disabled: true }), ctx()),
        service: svc.setDisabled,
    },
    {
        name: 'DELETE user',
        call: (p) =>
            indexDef.handlers.DELETE!(
                makeEvent(p, 'DELETE', '', { confirmUsername: 'target' }),
                ctx(),
            ),
        service: svc.deleteUser,
    },
    {
        name: 'POST subsonic-password (mints and returns the token)',
        call: (p) => subsonicDef.handlers.POST!(makeEvent(p, 'POST', '/subsonic-password'), ctx()),
        service: svc.getOrCreateToken,
    },
    {
        name: 'DELETE subsonic-password',
        call: (p) =>
            subsonicDef.handlers.DELETE!(makeEvent(p, 'DELETE', '/subsonic-password'), ctx()),
        service: svc.deleteUserToken,
    },
    {
        name: 'GET gdpr-export',
        call: (p) => gdprDef.handlers.GET!(makeEvent(p, 'GET', '/gdpr-export'), ctx()),
        service: svc.collectUserExport,
    },
    {
        name: 'DELETE identities',
        call: (p) =>
            identitiesDef.handlers.DELETE!(
                makeEvent(p, 'DELETE', '/identities?provider=oidc&subject=abc'),
                ctx(),
            ),
        service: svc.unlinkIdentity,
    },
    {
        name: 'POST jellyfin',
        call: (p) =>
            jellyfinDef.handlers.POST!(
                makeEvent(p, 'POST', '/jellyfin'),
                ctx({ jellyfinUsername: 'other' }),
            ),
        service: svc.setJellyfinOverride,
    },
];

beforeEach(() => {
    mockResolveOwnerAdminStatus.mockReset();
    for (const fn of Object.values(svc)) fn.mockReset();
    svc.resetPassword.mockResolvedValue({ ok: true, data: undefined });
    svc.setDisabled.mockResolvedValue({ ok: true, data: undefined });
    svc.deleteUser.mockResolvedValue({
        ok: true,
        data: { totalDeleted: 0, totalAnonymized: 0, tables: [] },
    });
    svc.unlinkIdentity.mockResolvedValue({ ok: true, data: { unlinked: true } });
    svc.setJellyfinOverride.mockResolvedValue({ ok: true, data: { override: 'other' } });
    svc.collectUserExport.mockResolvedValue({ exported_at: '2026-10-06T00:00:00Z' });
    svc.getOrCreateToken.mockResolvedValue('plaintext-token');
    svc.deleteUserToken.mockResolvedValue(undefined);
});

describe('users:admin target ceiling', () => {
    describe.each(cases)('$name', ({ call, service }) => {
        it('403s a users:admin caller when the target is admin by Formula A only (is_admin column false)', async () => {
            mockResolveOwnerAdminStatus.mockResolvedValue({ isAdmin: true, adminPinned: false });
            const res = await call(usersAdminOnly);
            expect(res.status).toBe(403);
            expect(service).not.toHaveBeenCalled();
        });

        it('fails closed when the target lookup throws', async () => {
            mockResolveOwnerAdminStatus.mockRejectedValue(new Error('db down'));
            const res = await call(usersAdminOnly);
            expect(res.status).toBe(403);
            expect(service).not.toHaveBeenCalled();
        });

        it('lets a users:admin caller act on a non-admin target', async () => {
            mockResolveOwnerAdminStatus.mockResolvedValue({ isAdmin: false, adminPinned: false });
            const res = await call(usersAdminOnly);
            expect(res.status).toBeLessThan(300);
            expect(service).toHaveBeenCalledTimes(1);
        });

        it('lets an administrator act on an admin target without a lookup', async () => {
            mockResolveOwnerAdminStatus.mockResolvedValue({ isAdmin: true, adminPinned: false });
            const res = await call(adminSession);
            expect(res.status).toBeLessThan(300);
            expect(service).toHaveBeenCalledTimes(1);
            expect(mockResolveOwnerAdminStatus).not.toHaveBeenCalled();
        });
    });
});

describe('PATCH /api/admin/users/:username body validation', () => {
    const PATCH = indexDef.handlers.PATCH!;

    it('rejects a body that carries two changes instead of silently dropping one', async () => {
        const res = await PATCH(
            makeEvent(adminSession, 'PATCH', '', { disabled: true, maxAgeRating: 12 }),
            ctx(),
        );
        expect(res.status).toBe(422);
        expect(svc.setDisabled).not.toHaveBeenCalled();
        expect(svc.setUserAgeRating).not.toHaveBeenCalled();
    });

    it.each([12.5, -1, 22, 1e12])('rejects maxAgeRating %s', async (value) => {
        const res = await PATCH(
            makeEvent(adminSession, 'PATCH', '', { maxAgeRating: value }),
            ctx(),
        );
        expect(res.status).toBe(422);
        expect(svc.setUserAgeRating).not.toHaveBeenCalled();
    });

    it('accepts an integer rating in range', async () => {
        svc.setUserAgeRating.mockResolvedValue({ ok: true, data: { maxAgeRating: 12 } });
        const res = await PATCH(makeEvent(adminSession, 'PATCH', '', { maxAgeRating: 12 }), ctx());
        expect(res.status).toBe(200);
        expect(svc.setUserAgeRating).toHaveBeenCalledTimes(1);
    });
});
