// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every route under /admin and /api/admin is gated in hooks, before `resolve()`.
 *
 * The /admin `+layout.server.ts` load is NOT a gate: a client data request
 * (`/admin/settings/__data.json?x-sveltekit-invalidated=0011111`) makes
 * SvelteKit skip the root and /admin layout loads and run only the page load,
 * and a form action runs before any load. Fixed in hooks (6f7f5a4f93); e2e seam:
 * tests/admin-settings-pages.api.spec.ts "layout gate cannot be skipped".
 *
 * This sweep reads the route tree from disk, so a new admin route is covered
 * the moment its directory exists — and a gate that stops matching some route
 * shape (a group, a param, a rest segment) fails here with the route's name.
 */

import { describe, it, expect, vi } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { adminRouteGate, type AdminGateEvent } from './admin-route-gate.js';
import { listRouteIds, samplePathFor, withoutGroups } from './route-tree.test-helpers.js';

const HEADERS = { 'Content-Type': 'application/json' };
const ADMIN = { ownerIsAdmin: true };
const PLAIN_USER = { ownerIsAdmin: false };

type Outcome = { resolved: true } | { redirect: string; status: number } | { status: number };

interface Call {
    routeId: string | null;
    pathname: string;
    method?: string;
    user?: { ownerIsAdmin: boolean } | null;
    isDataRequest?: boolean;
    hasBearer?: boolean;
    basePath?: string;
}

/** The hook's sequence around the gate: gate first, `resolve()` only if it lets the request through. */
async function runGate(call: Call): Promise<{ outcome: Outcome; resolveCalls: number }> {
    const resolve = vi.fn(async (_event: unknown) => new Response('page'));
    const event: AdminGateEvent & { isDataRequest: boolean } = {
        route: { id: call.routeId },
        url: new URL(`http://lumastra.test${call.pathname}`),
        request: { method: call.method ?? 'GET' },
        // 2026-10-13: admin is the principal's verdict now; an admin session has an admin principal.
        locals: {
            user: call.user,
            principal: call.user ? { isAdmin: call.user.ownerIsAdmin } : undefined,
        },
        isDataRequest: call.isDataRequest ?? false,
    };
    try {
        const denied = adminRouteGate(event, {
            hasBearer: call.hasBearer ?? false,
            headers: HEADERS,
            basePath: call.basePath ?? '',
        });
        if (denied)
            return { outcome: { status: denied.status }, resolveCalls: resolve.mock.calls.length };
        await resolve(event);
        return { outcome: { resolved: true }, resolveCalls: resolve.mock.calls.length };
    } catch (e) {
        if (isRedirect(e)) {
            return {
                outcome: { redirect: e.location, status: e.status },
                resolveCalls: resolve.mock.calls.length,
            };
        }
        throw e;
    }
}

const ROUTE_IDS = listRouteIds();
// Selected by URL prefix here, NOT with the gate's own matcher — a matcher that
// stops recognising a route shape must fail that route below, not drop it.
const underUrlPrefix = (prefix: string) => (id: string) => {
    const p = withoutGroups(id);
    return p === prefix || p.startsWith(`${prefix}/`);
};
const ADMIN_PAGE_IDS = ROUTE_IDS.filter(underUrlPrefix('/admin'));
const ADMIN_API_IDS = ROUTE_IDS.filter(underUrlPrefix('/api/admin'));

const HOME_REDIRECT = { redirect: '/', status: 303 };
const FORBIDDEN = { status: 403 };

describe('route enumeration', () => {
    it('finds the admin route tree (an empty glob must not pass)', () => {
        expect(ADMIN_PAGE_IDS.length).toBeGreaterThan(40);
        expect(ADMIN_API_IDS.length).toBeGreaterThan(40);
        expect(ADMIN_PAGE_IDS).toContain('/admin/settings');
    });

    it('turns route ids into URL paths', () => {
        expect(samplePathFor('/admin/(enterprise)/courses/[id]')).toBe('/admin/courses/p1');
        expect(samplePathFor('/admin/media/[...rest]')).toBe('/admin/media/a/b');
        expect(samplePathFor('/admin/[[lang]]/x')).toBe('/admin/x');
        expect(samplePathFor('/admin/[id=uuid]/y')).toBe('/admin/p1/y');
    });
});

describe('every /admin route is gated in hooks', () => {
    for (const id of ADMIN_PAGE_IDS) {
        const path = samplePathFor(id);
        it(`${id}`, async () => {
            const blocked: Array<[string, Call, Outcome]> = [
                [
                    'GET page as non-admin',
                    { routeId: id, pathname: path, user: PLAIN_USER },
                    HOME_REDIRECT,
                ],
                // SvelteKit strips `/__data.json` from event.url before handle; the
                // route id is the page's own. The invalidation mask never reaches the gate.
                [
                    'GET __data.json as non-admin',
                    { routeId: id, pathname: path, user: PLAIN_USER, isDataRequest: true },
                    HOME_REDIRECT,
                ],
                [
                    'HEAD as non-admin',
                    { routeId: id, pathname: path, method: 'HEAD', user: PLAIN_USER },
                    HOME_REDIRECT,
                ],
                [
                    'POST (form action) as non-admin',
                    { routeId: id, pathname: path, method: 'POST', user: PLAIN_USER },
                    FORBIDDEN,
                ],
                [
                    'DELETE as non-admin',
                    { routeId: id, pathname: path, method: 'DELETE', user: PLAIN_USER },
                    FORBIDDEN,
                ],
                // resolveAuth answers anonymous requests first (sign-in redirect / 401);
                // the gate must still refuse one that reaches it without a user.
                ['GET anonymous', { routeId: id, pathname: path, user: undefined }, HOME_REDIRECT],
                [
                    'POST anonymous',
                    { routeId: id, pathname: path, method: 'POST', user: null },
                    FORBIDDEN,
                ],
                [
                    'GET percent-encoded path as non-admin',
                    { routeId: id, pathname: path.replace('/admin', '/%61dmin'), user: PLAIN_USER },
                    HOME_REDIRECT,
                ],
                [
                    'GET under a base path as non-admin',
                    {
                        routeId: id,
                        pathname: `/media${path}`,
                        user: PLAIN_USER,
                        basePath: '/media',
                    },
                    HOME_REDIRECT,
                ],
            ];
            for (const [label, call, expected] of blocked) {
                const { outcome, resolveCalls } = await runGate(call);
                expect(outcome, `${id}: ${label}`).toEqual(expected);
                expect(resolveCalls, `${id}: ${label} reached resolve()`).toBe(0);
            }
            for (const method of ['GET', 'POST']) {
                const { outcome, resolveCalls } = await runGate({
                    routeId: id,
                    pathname: path,
                    method,
                    user: ADMIN,
                });
                expect(outcome, `${id}: ${method} as admin`).toEqual({ resolved: true });
                expect(resolveCalls).toBe(1);
            }
        });
    }
});

describe('every /api/admin route is gated in hooks', () => {
    for (const id of ADMIN_API_IDS) {
        const path = samplePathFor(id);
        it(`${id}`, async () => {
            for (const method of ['GET', 'POST', 'DELETE']) {
                for (const user of [PLAIN_USER, undefined]) {
                    const label = `${method} as ${user ? 'non-admin' : 'anonymous'}`;
                    const { outcome, resolveCalls } = await runGate({
                        routeId: id,
                        pathname: path,
                        method,
                        user,
                    });
                    expect(outcome, `${id}: ${label}`).toEqual(FORBIDDEN);
                    expect(resolveCalls, `${id}: ${label} reached resolve()`).toBe(0);
                }
            }
            const admin = await runGate({ routeId: id, pathname: path, user: ADMIN });
            expect(admin.outcome, `${id}: GET as admin`).toEqual({ resolved: true });
            // A Bearer credential goes on to the route's own requireAdmin gate.
            const bearer = await runGate({
                routeId: id,
                pathname: path,
                user: PLAIN_USER,
                hasBearer: true,
            });
            expect(bearer.outcome, `${id}: Bearer`).toEqual({ resolved: true });
        });
    }
});

describe('the gate matches the route, not the raw pathname', () => {
    it('blocks an unmatched (404) /admin path, encoded or under a base path', async () => {
        for (const call of [
            { routeId: null, pathname: '/admin/nope' },
            { routeId: null, pathname: '/%61dmin/nope' },
            { routeId: null, pathname: '/%61dmin' },
            { routeId: null, pathname: '/media/admin/nope', basePath: '/media' },
            { routeId: null, pathname: '/media/%61dmin/nope', basePath: '/media' },
        ]) {
            const { outcome, resolveCalls } = await runGate({ ...call, user: PLAIN_USER });
            expect(outcome, call.pathname).toEqual(HOME_REDIRECT);
            expect(resolveCalls).toBe(0);
        }
    });

    it('blocks a rerouted path (e.g. a localized URL) by its route id', async () => {
        const { outcome } = await runGate({
            routeId: '/admin/settings',
            pathname: '/de/admin/settings',
            user: PLAIN_USER,
        });
        expect(outcome).toEqual(HOME_REDIRECT);
    });

    it('blocks an /admin route that sits inside a route group', async () => {
        const { outcome } = await runGate({
            routeId: '/(group)/admin/x',
            pathname: '/admin/x',
            user: PLAIN_USER,
            method: 'POST',
        });
        expect(outcome).toEqual(FORBIDDEN);
    });

    it('does not gate look-alike routes', async () => {
        for (const [routeId, pathname] of [
            ['/administrator', '/administrator'],
            ['/api/v1/admin/watch-stats', '/api/v1/admin/watch-stats'],
            ['/settings', '/settings'],
            ['/', '/'],
        ] as const) {
            const { outcome } = await runGate({
                routeId,
                pathname,
                user: PLAIN_USER,
                method: 'POST',
            });
            expect(outcome, routeId).toEqual({ resolved: true });
        }
    });
});
