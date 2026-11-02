// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * requireAdmin() takes ONE credential verdict. With a principal on the request
 * it never resolves an extra Bearer header, so the gate and the handler
 * (localsIsAdmin) cannot disagree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockResolveBearerAdminPrincipal = vi.fn();
vi.mock('$lib/server/auth/resolve-bearer-principal.js', () => ({
    resolveBearerAdminPrincipal: (...args: unknown[]) => mockResolveBearerAdminPrincipal(...args),
}));
vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIp: () => '127.0.0.1',
    getClientIpStrict: () => '127.0.0.1',
}));

import { requireAdmin } from './auth.js';

function event(locals: Record<string, unknown>): RequestEvent {
    const headers = new Headers({ authorization: 'Bearer admin-pat' });
    return {
        request: new Request('http://localhost/api/admin/test', { headers }),
        url: new URL('http://localhost/api/admin/test'),
        params: {},
        locals,
    } as unknown as RequestEvent;
}

describe('requireAdmin: one credential per request', () => {
    beforeEach(() => {
        mockResolveBearerAdminPrincipal.mockReset();
        mockResolveBearerAdminPrincipal.mockResolvedValue({ username: 'admin', isAdmin: true });
    });

    it('a non-admin session plus an admin Bearer header is denied without a second lookup', async () => {
        const handler = vi.fn(async () => new Response('ok'));
        const res = await requireAdmin(handler)(
            event({
                user: { username: 'bob', isAdmin: false },
                principal: { username: 'bob', isAdmin: false },
            }),
        );
        expect(res.status).toBe(403);
        expect(handler).not.toHaveBeenCalled();
        expect(mockResolveBearerAdminPrincipal).not.toHaveBeenCalled();
    });

    it('without a principal the Bearer credential is resolved and becomes the principal', async () => {
        const handler = vi.fn(async () => new Response('ok'));
        const ev = event({});
        const res = await requireAdmin(handler)(ev);
        expect(res.status).toBe(200);
        expect(mockResolveBearerAdminPrincipal).toHaveBeenCalledOnce();
        expect((ev.locals as { principal?: { isAdmin: boolean } }).principal?.isAdmin).toBe(true);
    });
});
