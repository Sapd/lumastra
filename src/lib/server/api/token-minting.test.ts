// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-12, C3: a `tokens:admin` scope could mint a
 * full-admin PAT for any admin user, or a service token with `admin` scope.
 * The minting endpoints now refuse to hand out more authority than the caller
 * holds — and they judge the caller by the principal that passed the OUTER
 * gate, not the one `delegateToAdmin()` elevates for the internal handoff.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from './principal.js';
import { delegateToAdmin } from './delegate.js';
import { denyUnlessMayMint, callerIsAdmin } from './token-minting.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// A missing principal must never be recovered from a raw Bearer header here:
// the outer mount gate establishes the identity before the ceiling runs.
const mockResolveBearerAdminPrincipal = vi.fn();
vi.mock('$lib/server/auth/resolve-bearer-principal.js', () => ({
    resolveBearerAdminPrincipal: (...args: unknown[]) => mockResolveBearerAdminPrincipal(...args),
}));

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(principal?: Principal, user?: { isAdmin: boolean }): RequestEvent {
    return {
        request: new Request('http://localhost/api/v1/pats', { method: 'POST' }),
        url: new URL('http://localhost/api/v1/pats'),
        locals: { principal, user },
    } as unknown as RequestEvent;
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

async function code(res: Response | null): Promise<string | null> {
    if (!res) return null;
    return ((await res.json()) as { code: string }).code;
}

describe('denyUnlessMayMint', () => {
    it('an admin caller may mint anything, including admin scope for an admin', async () => {
        const res = await denyUnlessMayMint(makeEvent(adminSession), {
            scopes: ['admin'],
            targetIsAdmin: true,
        });
        expect(res).toBeNull();
    });

    it("a tokens:admin caller cannot mint 'admin'", async () => {
        const res = await denyUnlessMayMint(makeEvent(tokensAdminOnly), {
            scopes: ['admin'],
            targetIsAdmin: false,
        });
        expect(res?.status).toBe(403);
        expect(await code(res)).toBe('forbidden');
    });

    it("a tokens:admin caller cannot mint any '<area>:admin' scope either", async () => {
        const res = await denyUnlessMayMint(makeEvent(tokensAdminOnly), {
            scopes: ['read', 'users:admin'],
            targetIsAdmin: false,
        });
        expect(res?.status).toBe(403);
    });

    it('a non-admin caller cannot mint a token FOR an administrator, whatever the scopes', async () => {
        const res = await denyUnlessMayMint(makeEvent(tokensAdminOnly), {
            scopes: ['read'],
            targetIsAdmin: true,
        });
        expect(res?.status).toBe(403);
    });

    it('a non-admin caller cannot mint scopes it does not hold itself', async () => {
        const res = await denyUnlessMayMint(makeEvent(tokensAdminOnly), {
            scopes: ['write'],
            targetIsAdmin: false,
        });
        expect(res?.status).toBe(403);
    });

    it('a non-admin caller may mint a subset of what it holds', async () => {
        const res = await denyUnlessMayMint(makeEvent(tokensAdminOnly), {
            scopes: ['read'],
            targetIsAdmin: false,
        });
        expect(res).toBeNull();
    });

    it('the PAT compat scopes count as read/write for the ceiling', async () => {
        expect(
            await denyUnlessMayMint(makeEvent(tokensAdminOnly), {
                scopes: ['jellyfin_compat_read'],
                targetIsAdmin: false,
            }),
        ).toBeNull();
        expect(
            (
                await denyUnlessMayMint(makeEvent(tokensAdminOnly), {
                    scopes: ['jellyfin_compat'],
                    targetIsAdmin: false,
                })
            )?.status,
        ).toBe(403);
    });

    it('with no principal and no user the caller is treated as non-admin (fail closed)', async () => {
        const res = await denyUnlessMayMint(makeEvent(undefined, undefined), {
            scopes: ['admin'],
            targetIsAdmin: false,
        });
        expect(res?.status).toBe(403);
    });

    it('judges the caller by the principal that passed the outer gate, not the delegated one', async () => {
        // 2026-10-13: delegateToAdmin() no longer elevates locals.principal; it marks
        // the request (isDelegatedAdmin) for the admin gates. A minting handler
        // reached that way sees the ORIGINAL, non-admin caller.
        const event = makeEvent(tokensAdminOnly);
        let seenElevated: boolean | undefined;
        const res = await delegateToAdmin(event, async (ev) => {
            seenElevated = ev.locals.principal?.isAdmin;
            return (
                (await denyUnlessMayMint(ev, { scopes: ['admin'], targetIsAdmin: false })) ??
                new Response('minted', { status: 201 })
            );
        });
        expect(seenElevated).toBe(false);
        expect(res.status).toBe(403);
    });
});

describe('callerIsAdmin(): principal-only admin authority', () => {
    it('does not accept the owner admin flag without a principal', async () => {
        const event = makeEvent(undefined, { isAdmin: true });
        expect(await callerIsAdmin(event)).toBe(false);
        expect(
            (await denyUnlessMayMint(event, { scopes: ['admin'], targetIsAdmin: true }))?.status,
        ).toBe(403);
    });

    it('denies a raw Bearer request until the outer gate materializes a principal', async () => {
        mockResolveBearerAdminPrincipal.mockReset().mockResolvedValue(adminSession);
        const event = makeEvent();
        event.request = new Request('http://localhost/api/admin/pats', {
            headers: { authorization: 'Bearer pat_admin' },
        });
        expect(await callerIsAdmin(event)).toBe(false);
        expect(mockResolveBearerAdminPrincipal).not.toHaveBeenCalled();
    });

    it('does not accept an admin owner flag for a non-admin principal', async () => {
        expect(await callerIsAdmin(makeEvent(tokensAdminOnly, { isAdmin: true }))).toBe(false);
    });

    it('accepts a resolved admin principal regardless of the user projection', async () => {
        expect(await callerIsAdmin(makeEvent(adminSession, { isAdmin: false }))).toBe(true);
    });
});
