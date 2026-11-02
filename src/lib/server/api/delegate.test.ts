// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for delegateToAdmin().
 *
 * The delegation shim exists so a `/api/v1` endpoint gated by a fine-grained
 * scope (e.g. `media:admin`) can reuse the internal admin handler, which is
 * mounted with `auth: { kind: 'admin' }`. Since enforce() treats a present
 * Principal as authoritative, the shim must get the inner admin gate to accept
 * the call — patching only `locals.user` 403s every least-privilege token at the
 * inner gate after the outer scope gate accepted it. Since 2026-10-13 it marks
 * the request (isDelegatedAdmin) instead of elevating the principal. There are
 * 59 call sites, so this regressed silently in bulk.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('$lib/server/config.js', () => ({ config: {}, features: {} }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/auth.js', () => ({ isUserAdmin: vi.fn().mockReturnValue(false) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));

import { delegateToAdmin } from './delegate.js';
import { enforce } from './mount.js';
import { buildPrincipal } from './principal.js';

const UID = toUserId('00000000-0000-0000-0000-000000000001');

/** A PAT scoped `media:admin` — passes the outer scope gate, not admin itself. */
function makeScopedTokenEvent(): RequestEvent {
    const principal = buildPrincipal({
        kind: 'pat',
        userId: UID,
        username: 'ci-token',
        userGroups: [],
        tokenScopes: ['media:admin'],
        sessionIsAdmin: false,
        ownerIsAdmin: false,
    });
    return {
        locals: { principal, user: undefined, authMethod: 'pat' },
        params: {},
        request: new Request('https://x/api/v1/media/abc', { method: 'DELETE' }),
        url: new URL('https://x/api/v1/media/abc'),
    } as unknown as RequestEvent;
}

describe('delegateToAdmin', () => {
    it('lets a least-privilege scope token through the delegated {kind:"admin"} gate', async () => {
        const event = makeScopedTokenEvent();

        // Precondition: the token is NOT admin on its own.
        expect(event.locals.principal!.isAdmin).toBe(false);
        expect(await enforce({ kind: 'admin' }, event)).not.toBeNull();

        // The inner admin handler, as mounted internally.
        const innerAdminHandler = async (e: RequestEvent): Promise<Response> => {
            const denied = await enforce({ kind: 'admin' }, e);
            if (denied) return denied;
            return new Response('deleted', { status: 200 });
        };

        const res = await delegateToAdmin(event, innerAdminHandler);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('deleted');
    });

    it('restores the original principal and user after delegation', async () => {
        const event = makeScopedTokenEvent();
        const origPrincipal = event.locals.principal;
        const origUser = event.locals.user;

        await delegateToAdmin(event, async () => new Response('ok'));

        expect(event.locals.principal).toBe(origPrincipal);
        expect(event.locals.principal!.isAdmin).toBe(false);
        expect(event.locals.user).toBe(origUser);
    });

    it('restores the principal even when the delegated handler throws', async () => {
        const event = makeScopedTokenEvent();
        const origPrincipal = event.locals.principal;

        await expect(
            delegateToAdmin(event, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');

        expect(event.locals.principal).toBe(origPrincipal);
        expect(event.locals.principal!.isAdmin).toBe(false);
    });

    it('fails closed with 403 when no principal was resolved', async () => {
        const event = {
            locals: {},
            params: {},
            request: new Request('https://x/api/v1/media/abc'),
            url: new URL('https://x/api/v1/media/abc'),
        } as unknown as RequestEvent;

        const handler = vi.fn();
        const res = await delegateToAdmin(event, handler);
        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
    });

    it('does not disturb an already-admin principal', async () => {
        const principal = buildPrincipal({
            kind: 'session',
            userId: UID,
            username: 'denis',
            userGroups: ['admins'],
            tokenScopes: [],
            sessionIsAdmin: true,
            ownerIsAdmin: true,
        });
        const event = {
            locals: { principal, user: { ownerIsAdmin: true } },
            params: {},
            request: new Request('https://x/api/admin/media/abc'),
            url: new URL('https://x/api/admin/media/abc'),
        } as unknown as RequestEvent;

        const res = await delegateToAdmin(event, async (e) => {
            expect(e.locals.principal!.isAdmin).toBe(true);
            return new Response('ok');
        });
        expect(res.status).toBe(200);
        expect(event.locals.principal).toBe(principal); // same ref, not a clone
    });
});
