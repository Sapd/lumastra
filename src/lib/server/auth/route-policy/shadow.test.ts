// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shadow mode compares the table with what today's gates answered and logs
 * disagreements — and never changes a response, even when it throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { redirect, type Handle, type RequestEvent } from '@sveltejs/kit';

const warn = vi.fn();
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

const {
    withRoutePolicyShadow,
    markOldGate,
    clearOldGate,
    noteCollapsedStatus,
    resetShadowForTests,
} = await import('./shadow.js');

interface Opts {
    routeId: string | null;
    method?: string;
    user?: { ownerIsAdmin?: boolean };
    principal?: { kind: string; isAdmin: boolean; scopes?: string[] };
    headers?: Record<string, string>;
}

function makeEvent(o: Opts): RequestEvent {
    return {
        route: { id: o.routeId },
        url: new URL('http://localhost/x'),
        request: new Request('http://localhost/x', {
            method: o.method ?? 'GET',
            headers: o.headers,
        }),
        cookies: { get: () => undefined },
        locals: {
            ...(o.user ? { user: o.user } : {}),
            ...(o.principal ? { principal: { scopes: [], ...o.principal } } : {}),
        },
    } as unknown as RequestEvent;
}

const deps = {
    isApiV1RequestAuthorized: (e: RequestEvent) => Boolean(e.locals.user),
    deviceAuthEnabled: () => true,
};

/** Run one request through the wrapper; `answer` plays today's mainHandle. */
async function run(
    o: Opts,
    answer: (event: RequestEvent) => Response | Promise<Response>,
    d = deps,
): Promise<Response> {
    const event = makeEvent(o);
    const inner: Handle = async ({ event: e }) => answer(e);
    const handle = withRoutePolicyShadow(inner, d);
    return handle({ event, resolve: vi.fn() } as unknown as Parameters<Handle>[0]);
}

const classes = (): string[] => warn.mock.calls.map((c) => (c[1] as { class: string }).class);

describe('route policy shadow mode', () => {
    beforeEach(() => {
        warn.mockReset();
        resetShadowForTests();
        vi.stubEnv('ROUTE_POLICY_MODE', 'shadow');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('is a pass-through when the mode is off', async () => {
        vi.stubEnv('ROUTE_POLICY_MODE', '');
        const res = await run({ routeId: '/admin/settings' }, () => new Response('x'));
        expect(await res.text()).toBe('x');
        expect(warn).not.toHaveBeenCalled();
    });

    it('agrees with the admin gate redirecting a non-admin page read', async () => {
        const event = { routeId: '/admin/settings', user: { ownerIsAdmin: false } };
        await expect(
            run(event, (e) => {
                markOldGate(e, 'admin-gate');
                redirect(303, '/');
            }),
        ).rejects.toMatchObject({ status: 303 });
        expect(warn).not.toHaveBeenCalled();
    });

    it('M1: the table denies what the old layers served (an old leak)', async () => {
        await run(
            { routeId: '/admin/settings', user: { ownerIsAdmin: false } },
            () => new Response('{}'),
        );
        expect(classes()).toEqual(['M1']);
    });

    it('agrees when resolveAuth asks an anonymous visitor to sign in', async () => {
        await run({ routeId: '/browse' }, (e) => {
            markOldGate(e, 'resolveAuth');
            return new Response(null, {
                status: 303,
                headers: { location: '/login?redirect=%2Fbrowse' },
            });
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('a 200 help page from resolveAuth is a sign-in answer, not an allow', async () => {
        await run({ routeId: '/admin/settings', method: 'POST' }, (e) => {
            markOldGate(e, 'resolveAuth');
            return new Response('<!DOCTYPE html>', { status: 200 });
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('a credential refused by resolveAuth (read-only scope on a write) is not a mismatch', async () => {
        await run(
            {
                routeId: '/api/v1/playlists',
                method: 'POST',
                headers: { authorization: 'Bearer pat_ro' },
            },
            (e) => {
                markOldGate(e, 'resolveAuth');
                return new Response(null, { status: 403 });
            },
            { ...deps, isApiV1RequestAuthorized: () => true },
        );
        expect(warn).not.toHaveBeenCalled();
    });

    it('M6: resolveAuth denies a route the table would open', async () => {
        await run({ routeId: '/login' }, (e) => {
            markOldGate(e, 'resolveAuth');
            return new Response(null, { status: 401 });
        });
        expect(classes()).toEqual(['M6']);
    });

    it('ignores resolveAuth kill switches (feature off)', async () => {
        await run({ routeId: '/(proprietary)/j/Items' }, (e) => {
            markOldGate(e, 'resolveAuth');
            return new Response('Not Found', { status: 404 });
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('M3: a handler demands identity the table does not', async () => {
        await run({ routeId: '/browse', user: {} }, () => new Response(null, { status: 401 }));
        expect(classes()).toEqual(['M3']);
    });

    it('a public or token-surface route refusing a caller is its own auth, not a mismatch', async () => {
        await run({ routeId: '/login' }, () => new Response(null, { status: 401 }));
        await run({ routeId: '/(proprietary)/j/Items' }, () => new Response(null, { status: 401 }));
        await run(
            { routeId: '/subsonic/rest/[...path]' },
            () => new Response(null, { status: 403 }),
        );
        expect(warn).not.toHaveBeenCalled();
    });

    it('judges the identity the gates saw, not what a handler left in locals', async () => {
        await run({ routeId: '/browse', user: { ownerIsAdmin: false } }, (e) => {
            markOldGate(e, 'resolveAuth');
            clearOldGate(e); // resolveAuth let it through; identity recorded here
            delete (e.locals as unknown as Record<string, unknown>).user; // e.g. /logout
            return new Response('ok');
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('classifies on the status before the bypass-path 404 collapse', async () => {
        await run({ routeId: '/api/media/[id]', user: {} }, (e) => {
            noteCollapsedStatus(e, 401);
            return new Response('{}', { status: 404 });
        });
        expect(classes()).toEqual(['M3']);
    });

    it('rethrows a non-redirect error untouched', async () => {
        const err = new Error('handler blew up');
        await expect(run({ routeId: '/browse', user: {} }, () => Promise.reject(err))).rejects.toBe(
            err,
        );
        expect(warn).not.toHaveBeenCalled();
    });

    it('never reads the request or response body', async () => {
        const event = makeEvent({
            routeId: '/admin/settings',
            user: { ownerIsAdmin: false },
            method: 'POST',
        });
        const response = new Response('payload', { status: 200 });
        const handle = withRoutePolicyShadow(async () => response, deps);
        const res = await handle({ event, resolve: vi.fn() } as unknown as Parameters<Handle>[0]);
        expect(res.bodyUsed).toBe(false);
        expect(event.request.bodyUsed).toBe(false);
    });

    it('accepts the mode with stray case and whitespace', async () => {
        vi.stubEnv('ROUTE_POLICY_MODE', ' Shadow ');
        await run(
            { routeId: '/admin/settings', user: { ownerIsAdmin: false } },
            () => new Response('{}'),
        );
        expect(classes()).toEqual(['M1']);
    });

    it('HEAD is judged like GET', async () => {
        await run(
            { routeId: '/admin/settings', user: { ownerIsAdmin: false }, method: 'HEAD' },
            (e) => {
                markOldGate(e, 'admin-gate');
                redirect(303, '/');
            },
        ).catch(() => {});
        expect(warn).not.toHaveBeenCalled();
    });

    it('an absolute login Location counts as sign-in required', async () => {
        await run({ routeId: '/browse' }, (e) => {
            markOldGate(e, 'resolveAuth');
            return new Response(null, {
                status: 303,
                headers: { location: 'https://media.example/login?redirect=%2Fbrowse' },
            });
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('M4: a handler 403s a signed-in user on a user row', async () => {
        await run(
            { routeId: '/api/media/[id]', user: { ownerIsAdmin: false } },
            () => new Response(null, { status: 403 }),
        );
        expect(classes()).toEqual(['M4']);
    });

    it('M2: a hooks gate denies what the table allows', async () => {
        await run({ routeId: '/api/media/[id]', user: { ownerIsAdmin: false } }, (e) => {
            markOldGate(e, 'v1-backstop');
            return new Response(null, { status: 401 });
        });
        expect(classes()).toEqual(['M2']);
    });

    it('defers an unidentified Bearer request on /api/admin to the route, as today', async () => {
        await run(
            { routeId: '/api/admin/users', headers: { authorization: 'Bearer pat_x' } },
            () => new Response('[]'),
        );
        expect(warn).not.toHaveBeenCalled();
    });

    it('never defers a Bearer header on an /admin page', async () => {
        await run(
            {
                routeId: '/admin/settings',
                user: { ownerIsAdmin: false },
                headers: { authorization: 'Bearer pat_x' },
            },
            () => new Response('{}'),
        );
        expect(classes()).toEqual(['M1']);
    });

    it('M7: both deny with a different shape', async () => {
        await run(
            { routeId: '/admin/settings', user: { ownerIsAdmin: false }, method: 'POST' },
            (e) => {
                markOldGate(e, 'admin-gate');
                return new Response(null, { status: 401 });
            },
        );
        expect(classes()).toEqual(['M7']);
    });

    it('M5-cookie: a session principal and locals.user disagree on admin', async () => {
        await run(
            {
                routeId: '/browse',
                user: { ownerIsAdmin: true },
                principal: { kind: 'session', isAdmin: false },
            },
            () => new Response('ok'),
        );
        expect(classes()).toEqual(['M5-cookie']);
    });

    it.each(['/api/v1/me', '/login'])(
        'ignores token admin-flag differences on user/public policies (%s)',
        async (routeId) => {
            await run(
                {
                    routeId,
                    user: { ownerIsAdmin: true },
                    principal: { kind: 'bearer', isAdmin: false, scopes: ['write'] },
                    headers: { authorization: 'Bearer pat_write' },
                },
                () => new Response('ok'),
            );
            expect(warn).not.toHaveBeenCalled();
        },
    );

    it.each(['/admin/settings', '/api/admin/users'])(
        'M5: keeps token admin-flag differences on admin policies (%s)',
        async (routeId) => {
            await run(
                {
                    routeId,
                    user: { ownerIsAdmin: true },
                    principal: { kind: 'bearer', isAdmin: false, scopes: ['write'] },
                    headers: { authorization: 'Bearer pat_write' },
                },
                () => new Response('ok'),
            );
            expect(classes()).toEqual(['M5']);
        },
    );

    it('still reports a user-policy allow/deny disagreement for a scoped admin-owned token', async () => {
        await run(
            {
                routeId: '/api/v1/me',
                user: { ownerIsAdmin: true },
                principal: { kind: 'bearer', isAdmin: false, scopes: ['write'] },
            },
            () => new Response(null, { status: 403 }),
        );
        expect(classes()).toEqual(['M4']);
    });

    it('logs one line per key, buckets unknown methods', async () => {
        const o = { routeId: '/admin/settings', user: { ownerIsAdmin: false }, method: 'PURGE' };
        await run(o, () => new Response('{}'));
        await run(o, () => new Response('{}'));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1]).toMatchObject({ method: '_other', class: 'M1' });
    });

    it('skips the CORS preflight, which is answered before any gate', async () => {
        await run(
            {
                routeId: '/api/v1/me',
                method: 'OPTIONS',
                headers: { origin: 'https://app.example' },
            },
            () =>
                new Response(null, {
                    status: 204,
                    headers: { 'access-control-allow-methods': 'GET' },
                }),
        );
        expect(warn).not.toHaveBeenCalled();
    });

    it('still compares an OPTIONS that went through the gates', async () => {
        await run(
            {
                routeId: '/admin/settings',
                method: 'OPTIONS',
                user: { ownerIsAdmin: false },
                headers: { origin: 'https://evil.example' },
            },
            () => new Response(null, { status: 204 }),
        );
        expect(classes()).toEqual(['M1']);
    });

    it('skips unrouted and enterprise requests', async () => {
        await run({ routeId: null }, () => new Response(null, { status: 404 }));
        await run({ routeId: '/admin/(enterprise)/courses' }, () => new Response('{}'));
        expect(warn).not.toHaveBeenCalled();
    });

    it('never changes the response when the evaluation throws', async () => {
        const boom = {
            ...deps,
            isApiV1RequestAuthorized: () => {
                throw new Error('boom');
            },
        };
        const res = await run(
            { routeId: '/api/v1/me' },
            () => new Response('body', { status: 200 }),
            boom,
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('body');
    });

    it('passes the same Response object through', async () => {
        const original = new Response('same');
        const res = await run({ routeId: '/browse', user: {} }, () => original);
        expect(res).toBe(original);
    });
});
