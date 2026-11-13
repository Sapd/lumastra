// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The /admin and /api/admin access gates that `hooks.server.ts` runs before
 * `resolve()`. Pulled out of the hook so a unit test can sweep every route id
 * under those prefixes (`src/lib/server/auth/admin-route-gate.test.ts`).
 *
 * The gate lives in hooks, not in the /admin `+layout.server.ts` load: a client
 * data request (`/admin/…/__data.json?x-sveltekit-invalidated=001`) marks the
 * layout node as not invalidated, SvelteKit skips its load and runs only the
 * page's load — and a form ACTION runs before any load at all.
 */

import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export type GatedRoutePrefix = '/admin' | '/api/admin';

export interface AdminGateEvent {
    route: { id: string | null };
    url: URL;
    request: { method: string };
    locals: {
        user?: { ownerIsAdmin?: boolean } | null;
        principal?: { isAdmin?: boolean } | null;
        authMethod?: string;
    };
}

/** `/admin/(private)/courses` → `/admin/courses`: route groups never appear in a URL. */
function stripRouteGroups(id: string): string {
    return id.replace(/\/\([^/)]+\)/g, '') || '/';
}

/**
 * Whether a request targets `prefix` or anything below it, for the route-prefix
 * access gates. Matches on `event.route.id` — the route SvelteKit actually
 * dispatches to, resolved before `handle` runs from the DECODED, base-stripped,
 * rerouted path — because `event.url.pathname` is none of those: `/%61dmin/…`
 * routes to /admin but fails a `startsWith('/admin/')`, and on a subfolder
 * install the pathname is `/<base>/admin/…`. The decoded-path check covers
 * requests no route matched (still a 404, but gated the same way).
 */
export function isUnderRoutePrefix(
    event: { route: { id: string | null }; url: URL },
    prefix: GatedRoutePrefix,
    basePath: string = base,
): boolean {
    const id = event.route.id === null ? null : stripRouteGroups(event.route.id);
    if (id !== null && (id === prefix || id.startsWith(`${prefix}/`))) return true;
    let path = event.url.pathname;
    if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
        path = path.slice(basePath.length) || '/';
    }
    try {
        path = decodeURI(path);
    } catch {
        // expected: malformed escape — SvelteKit 400s it; compare the raw path
    }
    return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Run the /admin and /api/admin gates. Returns `null` when the request may
 * proceed to `resolve()`, a 403 Response to return as-is, or THROWS a 303
 * redirect home (a non-admin GET/HEAD on an /admin page; SvelteKit turns it
 * into `{"type":"redirect"}` for data requests).
 *
 * `hasBearer`: a Bearer credential on /api/admin is passed through to the
 * route's own requireAdmin gate (see the comment at the call site).
 */
export function adminRouteGate(
    event: AdminGateEvent,
    opts: {
        hasBearer: boolean;
        headers: Record<string, string>;
        onReject?: (status: number) => void;
        basePath?: string;
    },
): Response | null {
    const basePath = opts.basePath ?? base;
    const isAdmin = localsIsAdmin(event.locals);
    if (isUnderRoutePrefix(event, '/admin', basePath) && !isAdmin) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method)) {
            opts.onReject?.(403);
            return new Response(
                JSON.stringify({ error: 'forbidden', message: 'Admin access required' }),
                { status: 403, headers: opts.headers },
            );
        }
        opts.onReject?.(303);
        redirect(303, appPath('/'));
    }
    if (isUnderRoutePrefix(event, '/api/admin', basePath) && !isAdmin && !opts.hasBearer) {
        opts.onReject?.(403);
        return new Response(
            JSON.stringify({ error: 'forbidden', message: 'Insufficient permissions' }),
            { status: 403, headers: opts.headers },
        );
    }
    return null;
}
