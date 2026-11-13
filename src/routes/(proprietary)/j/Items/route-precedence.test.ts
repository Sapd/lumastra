// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/Items/Counts`, `/Items/Root` and `/Items/Filters2` used to be answered by `/Items/[itemId]`
 * (as an unknown item id). Resolve real request paths against the real route
 * tree with SvelteKit's own route sorting and matching, so the literal routes
 * provably win. Uses SvelteKit internals (sort_routes / find_route) by file
 * path; if an upgrade moves them, update the two paths below.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface Route {
    id: string;
    pattern: RegExp;
    params: unknown[];
}

const KIT = resolve('node_modules/@sveltejs/kit/src');
const ROUTES = resolve('src/routes');

function routeIds(dir: string, out: string[] = []): string[] {
    const entries = readdirSync(dir);
    if (entries.some((e) => e.startsWith('+server.') || e.startsWith('+page.'))) {
        const rel = relative(ROUTES, dir).split('\\').join('/');
        out.push(rel ? `/${rel}` : '/');
    }
    for (const e of entries) {
        if (e === 'node_modules') continue;
        const full = join(dir, e);
        if (statSync(full).isDirectory()) routeIds(full, out);
    }
    return out;
}

let resolveRoute: (path: string) => string | undefined;

beforeAll(async () => {
    const sort = (await import(
        pathToFileURL(join(KIT, 'core/sync/create_manifest_data/sort.js')).href
    )) as { sort_routes: (r: Route[]) => Route[] };
    const routing = (await import(pathToFileURL(join(KIT, 'utils/routing.js')).href)) as {
        parse_route_id: (id: string) => { pattern: RegExp; params: unknown[] };
        find_route: (path: string, routes: Route[], matchers: object) => { route: Route } | null;
    };
    const routes = sort.sort_routes(
        routeIds(ROUTES).map((id) => ({ id, ...routing.parse_route_id(id) })),
    );
    resolveRoute = (path) => routing.find_route(path, routes, {})?.route.id;
});

describe('/j/Items literal routes outrank /j/Items/[itemId]', () => {
    const ID = '0f8e2d3c4b5a69788796a5b4c3d2e1f0';

    it.each([
        ['/j/Items/Counts', '/(proprietary)/j/Items/Counts'],
        ['/j/Items/Root', '/(proprietary)/j/Items/Root'],
        [`/j/Users/${ID}/Items/Root`, '/(proprietary)/j/Users/[userId]/Items/Root'],
        ['/j/Items/Latest', '/(proprietary)/j/Items/Latest'],
        ['/j/Items/Filters', '/(proprietary)/j/Items/Filters'],
        ['/j/Items/Filters2', '/(proprietary)/j/Items/Filters2'],
        ['/j/Genres/Science%20Fiction', '/(proprietary)/j/Genres/[genreName]'],
        [`/j/Items/${ID}`, '/(proprietary)/j/Items/[itemId]'],
        [`/j/Users/${ID}/Items/${ID}`, '/(proprietary)/j/Users/[userId]/Items/[itemId]'],
    ])('%s → %s', (path, expected) => {
        expect(resolveRoute(path)).toBe(expected);
    });
});
