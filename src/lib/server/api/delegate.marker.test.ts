// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * delegateToAdmin marks the request for the admin gates instead of making the
 * caller's principal admin for everything the delegated handler calls.
 */

import { describe, it, expect } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { delegateToAdmin, isDelegatedAdmin, principalBeforeDelegation } from './delegate.js';
import { enforce } from './mount.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { authenticate } from '$lib/server/tasks/api-auth.js';

function scopedTokenEvent(): RequestEvent {
    const url = new URL('http://localhost/api/v1/admin/x');
    return {
        url,
        request: new Request(url),
        params: {},
        locals: {
            user: { userId: 'u1', username: 'ops', ownerIsAdmin: false },
            principal: { kind: 'pat', username: 'ops', isAdmin: false, scopes: ['media:admin'] },
        },
    } as unknown as RequestEvent;
}

describe('delegateToAdmin marker', () => {
    it('passes the admin gate without making the caller admin', async () => {
        const event = scopedTokenEvent();
        const original = event.locals.principal;
        let inside: Record<string, unknown> = {};
        const res = await delegateToAdmin(event, async (e) => {
            inside = {
                gate: await enforce({ kind: 'admin' }, e),
                marked: isDelegatedAdmin(e),
                verdict: localsIsAdmin(e.locals),
                samePrincipal: e.locals.principal === original,
                before: principalBeforeDelegation(e) === original,
            };
            return new Response('ok');
        });
        expect(res.status).toBe(200);
        expect(inside).toEqual({
            gate: null,
            marked: true,
            verdict: false,
            samePrincipal: true,
            before: true,
        });
        expect(isDelegatedAdmin(event)).toBe(false);
    });

    it('the mark is gone after a throwing handler, and outside a delegation the gate denies', async () => {
        const event = scopedTokenEvent();
        await expect(
            delegateToAdmin(event, async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(isDelegatedAdmin(event)).toBe(false);
        const denied = await enforce({ kind: 'admin' }, event);
        expect(denied?.status).toBe(403);
    });

    it('requireAdmin passes inside a handoff and denies outside it', async () => {
        const inner = requireAdmin(async () => new Response('admin'));
        const event = scopedTokenEvent();
        expect((await delegateToAdmin(event, inner)).status).toBe(200);
        expect((await inner(event)).status).toBe(403);
    });

    it("authenticate()'s admin-session fallback does not honour the mark", async () => {
        const event = scopedTokenEvent();
        Object.defineProperty(event, 'url', { value: new URL('http://localhost/api/admin/x') });
        let status: number | undefined;
        await delegateToAdmin(event, async (e) => {
            try {
                await authenticate(e);
                status = 200;
            } catch (err) {
                status = (err as { statusCode?: number }).statusCode;
            }
            return new Response('ok');
        });
        expect(status).toBe(401);
    });

    it('overlapping delegations on one request keep the mark until the last one ends', async () => {
        const event = scopedTokenEvent();
        let releaseFirst: () => void = () => {};
        const first = delegateToAdmin(
            event,
            () =>
                new Promise<Response>((r) => {
                    releaseFirst = () => r(new Response('first'));
                }),
        );
        let markedInSecond: boolean | undefined;
        const second = delegateToAdmin(event, async (e) => {
            await Promise.resolve();
            releaseFirst();
            await first;
            markedInSecond = isDelegatedAdmin(e);
            return new Response('second');
        });
        await Promise.all([first, second]);
        expect(markedInSecond).toBe(true);
        expect(isDelegatedAdmin(event)).toBe(false);
    });
});
