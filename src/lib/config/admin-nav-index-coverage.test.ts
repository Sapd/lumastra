// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps the admin search index honest: every admin route has a `search-meta.ts`
 * next to its page, every tab id a page reads from the URL is declared in that
 * meta, and every message the metas reference resolves in English and German.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_NAV, type NavGateContext } from './admin-nav.js';
import { ADMIN_ROUTE_METAS, buildAdminPageIndex } from '$lib/utils/admin/admin-page-index';
import * as paraglideRuntime from '$lib/paraglide/runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const adminRoutesRoot = join(here, '..', '..', 'routes', 'admin');

/** Tab-like URL values a page reads or links to that are not manifest tabs. */
const NON_TAB_PARAMS: Record<string, string> = {
    '/admin/library/media|tab=tracks':
        'artist queue links open the dynamic media detail Tracks tab; this scan excludes dynamic detail routes',
    '/admin/library/media|tab=files': 'deep link into the item detail page, not a tab of the list',
    '/admin/fix/wrong-match|view=broken':
        'links to Fix matches (?view=broken), not a tab of this page',
    '/admin/tasks/runs|view=all': 'list-mode toggle (all runs vs. by task), not a tab',
    '/admin/tasks/runs|view=grouped': 'list-mode toggle (all runs vs. by task), not a tab',
    '/admin|tab=cluster': 'Home cluster tile links to the Cluster tab of System health',
    '/admin/users/sessions|tab=cluster':
        '"System load" links to the Cluster tab of System health (CPU, memory, GPU per host)',
};

/** Pages that render tab controls which are not addressable through the URL. */
const TABS_NOT_IN_URL: Record<string, string> = {
    '/admin/system/transcode-failures': 'Failed/Recovered pills live in component state only',
};

interface RouteFile {
    route: string;
    file: string;
}

function collectRoutes(dir: string, segments: string[], out: RouteFile[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
        if (!entry.isDirectory() || entry.name.includes('[')) continue;
        const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
        const next = isGroup ? segments : [...segments, entry.name];
        const sub = join(dir, entry.name);
        if (existsSync(join(sub, '+page.svelte'))) {
            out.push({ route: `/admin/${next.join('/')}`, file: join(sub, '+page.svelte') });
        }
        collectRoutes(sub, next, out);
    }
}

function adminRoutes(): RouteFile[] {
    const routes: RouteFile[] = [];
    if (existsSync(join(adminRoutesRoot, '+page.svelte'))) {
        routes.push({ route: '/admin', file: join(adminRoutesRoot, '+page.svelte') });
    }
    collectRoutes(adminRoutesRoot, [], routes);
    return routes;
}

/**
 * Route groups core may not import (license boundary, CLAUDE.md: not even via
 * `import.meta.glob`). They get no search-meta.ts; their nav pages are indexed
 * from ADMIN_NAV instead.
 */
const PROTECTED_TIER_DIR = '(private)';
const isProtectedTier = (file: string): boolean => file.split(/[\\/]/).includes(PROTECTED_TIER_DIR);

const metaByRoute = new Map(ADMIN_ROUTE_METAS.map((r) => [r.path, r.meta]));
const tabsOf = (route: string): Set<string> =>
    new Set((metaByRoute.get(route)?.tabs ?? []).map((t) => `${t.param ?? 'tab'}=${t.id}`));

describe('every admin route has search metadata', () => {
    const routes = adminRoutes();

    it('finds the admin routes', () => {
        expect(routes.length).toBeGreaterThan(40);
    });

    it('has a sibling search-meta.ts for every static +page.svelte', () => {
        const missing = routes
            .filter((r) => !isProtectedTier(r.file))
            .filter((r) => !existsSync(join(dirname(r.file), 'search-meta.ts')))
            .map((r) => r.route);
        expect(missing, 'add a search-meta.ts next to these pages').toEqual([]);
    });

    it('has no search-meta.ts without a page, and the glob sees exactly the routes', () => {
        expect(ADMIN_ROUTE_METAS.map((r) => r.path).sort()).toEqual(
            routes
                .filter((r) => !isProtectedTier(r.file))
                .map((r) => r.route)
                .sort(),
        );
    });

    it('metas without a nav page above them declare their permission explicitly', () => {
        const navPaths = ADMIN_NAV.flatMap((section) => section.pages.map((p) => p.path));
        const hasNavAncestor = (path: string): boolean =>
            navPaths.some((p) =>
                p === '/admin' ? path === p : path === p || path.startsWith(p + '/'),
            );
        const open = ADMIN_ROUTE_METAS.filter(
            (r) => !hasNavAncestor(r.path) && r.meta.permission === undefined,
        ).map((r) => r.path);
        expect(open, 'add `permission: {}` (or real gating) to these metas').toEqual([]);
    });

    it('has a meta for every nav page outside the protected tier', () => {
        const hasPrivateTree = existsSync(join(adminRoutesRoot, PROTECTED_TIER_DIR));
        const routePaths = new Set(routes.map((r) => r.route));
        const protectedRoutes = new Set(
            routes.filter((r) => isProtectedTier(r.file)).map((r) => r.route),
        );
        for (const section of ADMIN_NAV) {
            for (const page of section.pages) {
                // Core keeps gated private-module nav definitions, but the public tree
                // has neither their pages nor search metadata. In a private tree,
                // still require each page so a missing route cannot hide a gap.
                if (page.privateModule && !hasPrivateTree) {
                    expect(routePaths.has(page.path), page.path).toBe(false);
                    continue;
                }
                expect(routePaths.has(page.path), page.path).toBe(true);
                if (protectedRoutes.has(page.path)) continue;
                expect(metaByRoute.has(page.path), page.path).toBe(true);
            }
        }
    });

    it('reuses the nav manifest title and description for nav pages', () => {
        for (const section of ADMIN_NAV) {
            for (const page of section.pages) {
                const meta = metaByRoute.get(page.path);
                if (!meta) continue;
                expect(meta?.title, page.path).toBe(page.title);
                expect(meta?.description, page.path).toBe(page.description);
            }
        }
    });

    it('mirrors the nav gating of nav pages', () => {
        for (const section of ADMIN_NAV) {
            for (const page of section.pages) {
                const meta = metaByRoute.get(page.path);
                if (!meta) continue;
                const permission = meta.permission;
                expect(permission?.devOnly ?? false, page.path).toBe(page.devOnly ?? false);
                expect(permission?.privateModule, page.path).toBe(page.privateModule);
                expect(permission?.featureFlag, page.path).toBe(page.featureFlag);
            }
        }
    });
});

describe('search metadata messages', () => {
    const gate = {
        devToolsEnabled: true,
        features: { libraryUpload: true } as NavGateContext['features'],
        trainingAssignments: true,
        assessment: true,
        showcase: true,
    };

    for (const locale of paraglideRuntime.locales) {
        it(`resolves every title, description and keyword list in ${locale}`, () => {
            const runtime = paraglideRuntime as unknown as {
                overwriteGetLocale: (fn: () => string) => void;
                getLocale: () => string;
            };
            const original = runtime.getLocale;
            runtime.overwriteGetLocale(() => locale);
            try {
                for (const { path, meta } of ADMIN_ROUTE_METAS) {
                    expect(meta.title(), `${path} title`).toBeTruthy();
                    if (meta.description)
                        expect(meta.description(), `${path} description`).toBeTruthy();
                    if (meta.keywords)
                        expect(meta.keywords().length, `${path} keywords`).toBeGreaterThan(0);
                    for (const tab of meta.tabs ?? []) {
                        const where = `${path} tab ${tab.id}`;
                        expect(tab.title(), `${where} title`).toBeTruthy();
                        if (tab.description)
                            expect(tab.description(), `${where} description`).toBeTruthy();
                        if (tab.keywords)
                            expect(tab.keywords().length, `${where} keywords`).toBeGreaterThan(0);
                    }
                }
            } finally {
                runtime.overwriteGetLocale(original);
            }
        });
    }

    it('builds an index entry for every page and tab when nothing is gated', () => {
        const index = buildAdminPageIndex({ navSections: [...ADMIN_NAV], gate });
        const hrefs = new Set(index.map((e) => `${e.kind}:${e.href}`));
        for (const section of ADMIN_NAV) {
            for (const page of section.pages) {
                expect(hrefs.has(`page:${page.path}`), page.path).toBe(true);
            }
        }
        for (const { path, meta } of ADMIN_ROUTE_METAS) {
            expect(hrefs.has(`page:${path}`), path).toBe(true);
            for (const tab of meta.tabs ?? []) {
                const href = `${path}?${tab.param ?? 'tab'}=${encodeURIComponent(tab.id)}`;
                expect(hrefs.has(`tab:${href}`), href).toBe(true);
            }
        }
    });

    it('has unique tab ids per page', () => {
        for (const { path, meta } of ADMIN_ROUTE_METAS) {
            const keys = (meta.tabs ?? []).map((t) => `${t.param ?? 'tab'}=${t.id}`);
            expect(new Set(keys).size, path).toBe(keys.length);
        }
    });
});

describe('admin tabs vs the pages that read them', () => {
    const routes = adminRoutes();

    /** `param=id` pairs a page's source names literally. */
    function literalTabs(source: string): Set<string> {
        const found = new Set<string>();
        const patterns: Array<RegExp> = [
            /[?&](tab|view|status)=([a-z0-9][a-z0-9-]*)/g,
            /searchParams\.get\('(tab|view|status)'\)\s*===\s*'([^']+)'/g,
            /searchParams\.set\('(tab|view|status)',\s*'([^']+)'/g,
        ];
        for (const re of patterns) {
            for (const match of source.matchAll(re)) found.add(`${match[1]}=${match[2]}`);
        }
        // Tab item literals (`{ id: 'x', label: ... }`) of a URL-synced <Tabs>.
        if (source.includes('syncToUrl')) {
            const param = /urlParam="(\w+)"/.exec(source)?.[1] ?? 'tab';
            for (const match of source.matchAll(/\bid:\s*'([a-z0-9][a-z0-9-]*)',\s*label:/g)) {
                found.add(`${param}=${match[1]}`);
            }
        }
        return found;
    }

    it('every literal tab id a page uses is a tab in its search-meta (or allowlisted)', () => {
        const unknown: string[] = [];
        const usedAllowlist = new Set<string>();
        for (const { route, file } of routes) {
            const known = tabsOf(route);
            for (const pair of literalTabs(readFileSync(file, 'utf8'))) {
                const key = `${route}|${pair}`;
                if (known.has(pair)) continue;
                if (key in NON_TAB_PARAMS) usedAllowlist.add(key);
                else unknown.push(key);
            }
        }
        expect(
            unknown,
            'declare these in search-meta tabs (or NON_TAB_PARAMS with a reason)',
        ).toEqual([]);
        expect([...usedAllowlist].sort()).toEqual(Object.keys(NON_TAB_PARAMS).sort());
    });

    it('every page with tab controls declares tabs (or is allowlisted)', () => {
        const undeclared: string[] = [];
        for (const { route, file } of routes) {
            const source = readFileSync(file, 'utf8');
            if (!/<(Tabs|AdminWorkspaceTabs)\b/.test(source)) continue;
            if (tabsOf(route).size === 0 && !(route in TABS_NOT_IN_URL)) undeclared.push(route);
        }
        expect(undeclared).toEqual([]);
        for (const route of Object.keys(TABS_NOT_IN_URL)) {
            expect(tabsOf(route).size, `${route} has meta tabs now`).toBe(0);
        }
    });

    it('a page with meta tabs renders its tab bar from the meta', () => {
        const notFromMeta = routes
            .filter((r) => tabsOf(r.route).size > 0)
            .filter((r) => !/from '\.\/search-meta'/.test(readFileSync(r.file, 'utf8')))
            .map((r) => r.route);
        expect(notFromMeta).toEqual([]);
    });

    it('the system health view type matches its meta tabs', () => {
        const source = readFileSync(
            join(here, '..', 'components', 'admin', 'system-health', 'health-workspace.ts'),
            'utf8',
        );
        const union = /export type HealthView = ([^;]+);/.exec(source)?.[1] ?? '';
        const ids = [...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
        const fromMeta = [...tabsOf('/admin/system/health')].map((p) => p.split('=')[1]).sort();
        expect(ids).toEqual(fromMeta);
    });
});
