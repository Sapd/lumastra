// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /me/pats (mounted on /api/me/pats and /api/v1/me/pats):
 * which scopes a caller may put on a new PAT.
 *
 * The principals are built by the real producers (`buildPrincipal`,
 * `mapRequestedScopeToRaw`), and `locals.user` is built the way the device-JWT
 * branch of forward-auth builds it — spread from the OWNER's live permissions.
 * That divergence is the bug: an admin owner's device token has
 * `locals.user.isAdmin === true` while its principal is non-admin, and the
 * handler used to read the former (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { mapRequestedScopeToRaw } from '$lib/server/oauth/device-scope-map.js';
import type { UserId } from '$lib/shared/user-id.js';

const mockCreate = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ create: (...a: unknown[]) => mockCreate(...a) }),
}));

const { def } = await import('./pats.js');
const ctx: ApiContext = { surface: 'v1' };

const USER_ID = '11111111-1111-1111-1111-111111111111' as UserId;

type Kind = Parameters<typeof buildPrincipal>[0]['kind'];

/** locals as resolveAuth leaves them for one credential. */
function locals(opts: {
    kind: Kind;
    ownerIsAdmin: boolean;
    tokenScopes?: string[];
}): RequestEvent['locals'] {
    const isSession = opts.kind === 'session' || opts.kind === 'forward_auth';
    const principal = buildPrincipal({
        kind: opts.kind,
        userId: USER_ID,
        username: 'alice',
        userGroups: opts.ownerIsAdmin ? ['admins'] : ['users'],
        tokenScopes: opts.tokenScopes ?? [],
        sessionIsAdmin: isSession ? opts.ownerIsAdmin : false,
        ownerIsAdmin: opts.ownerIsAdmin,
    });
    return {
        principal,
        // Device JWT / session: locals.user carries the OWNER's live isAdmin.
        user: {
            userId: USER_ID,
            username: 'alice',
            groups: '',
            userGroups: principal.userGroups,
            isAdmin: opts.ownerIsAdmin,
        },
    } as unknown as RequestEvent['locals'];
}

const deviceJwt = (ownerIsAdmin: boolean, requested: string | null = 'media') =>
    locals({ kind: 'bearer', ownerIsAdmin, tokenScopes: mapRequestedScopeToRaw(requested) });
const session = (ownerIsAdmin: boolean) => locals({ kind: 'session', ownerIsAdmin });
const forwardAuth = (ownerIsAdmin: boolean) => locals({ kind: 'forward_auth', ownerIsAdmin });
const pat = (ownerIsAdmin: boolean, tokenScopes: string[]) =>
    locals({ kind: 'pat', ownerIsAdmin, tokenScopes });

async function mint(l: RequestEvent['locals'], scopes: string[]): Promise<Response> {
    const event = {
        url: new URL('http://localhost/api/v1/me/pats'),
        params: {},
        locals: l,
        request: new Request('http://localhost/api/v1/me/pats', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 't', scopes }),
        }),
    } as unknown as RequestEvent;
    return def.handlers.POST!(event, ctx);
}

describe('POST /me/pats — mintable scopes', () => {
    beforeEach(() => {
        mockCreate.mockReset();
        mockCreate.mockResolvedValue({ id: 1, token: 'pat_x' });
    });

    describe('device JWT (OAuth device flow)', () => {
        it('an admin owner’s device token cannot mint an admin PAT', async () => {
            const res = await mint(deviceJwt(true), ['admin']);
            expect(res.status).toBe(403);
            expect(mockCreate).not.toHaveBeenCalled();
        });

        it('an admin owner’s device token cannot mint read/write either (session required)', async () => {
            const res = await mint(deviceJwt(true), ['read', 'write']);
            expect(res.status).toBe(403);
            expect(((await res.json()) as { reason?: string }).reason).toBe('session_required');
            expect(mockCreate).not.toHaveBeenCalled();
        });

        it('a read-only device token (media:read) cannot mint write', async () => {
            const res = await mint(deviceJwt(false, 'media:read'), ['write']);
            expect(res.status).toBe(403);
            expect(mockCreate).not.toHaveBeenCalled();
        });

        it('a read-only device token cannot mint the read+write jellyfin_compat scope', async () => {
            const res = await mint(deviceJwt(false, 'media:read'), ['jellyfin_compat']);
            expect(res.status).toBe(403);
        });

        it('a read-only device token cannot mint read or jellyfin_compat_read either', async () => {
            expect((await mint(deviceJwt(false, 'media:read'), ['read'])).status).toBe(403);
            expect(
                (await mint(deviceJwt(false, 'media:read'), ['jellyfin_compat_read'])).status,
            ).toBe(403);
            expect(mockCreate).not.toHaveBeenCalled();
        });

        it('a media device token cannot mint a write PAT that would outlive the app', async () => {
            const res = await mint(deviceJwt(false, 'media'), ['write']);
            expect(res.status).toBe(403);
            expect(((await res.json()) as { reason?: string }).reason).toBe('session_required');
            expect(mockCreate).not.toHaveBeenCalled();
        });
    });

    describe('sessions keep what they could mint before (prerequisite)', () => {
        for (const [label, make] of [
            ['session', session],
            ['forward auth', forwardAuth],
        ] as const) {
            it(`${label}, non-admin: read, write, jellyfin_compat yes — admin no`, async () => {
                expect((await mint(make(false), ['read'])).status).toBe(201);
                expect((await mint(make(false), ['read', 'write'])).status).toBe(201);
                expect((await mint(make(false), ['jellyfin_compat'])).status).toBe(201);
                expect((await mint(make(false), ['admin'])).status).toBe(403);
            });

            it(`${label}, admin: admin and read/write`, async () => {
                expect((await mint(make(true), ['admin'])).status).toBe(201);
                expect((await mint(make(true), ['read', 'write'])).status).toBe(201);
            });
        }
    });

    describe('PATs', () => {
        it('an admin-scoped PAT of an admin cannot mint anything (session required)', async () => {
            expect((await mint(pat(true, ['admin']), ['admin'])).status).toBe(403);
            expect((await mint(pat(true, ['admin']), ['read'])).status).toBe(403);
            expect(mockCreate).not.toHaveBeenCalled();
        });

        it('a write PAT of an admin owner cannot mint admin', async () => {
            expect((await mint(pat(true, ['read', 'write']), ['admin'])).status).toBe(403);
        });
    });

    it('without a principal nothing is minted, even if locals.user says admin', async () => {
        const l = session(true) as unknown as Record<string, unknown>;
        delete l.principal;
        const locals = l as unknown as RequestEvent['locals'];
        expect((await mint(locals, ['admin'])).status).toBe(401);
        expect((await mint(locals, ['write'])).status).toBe(401);
        expect(mockCreate).not.toHaveBeenCalled();
    });
});
