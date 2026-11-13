// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ADMIN_NAV,
    visibleNav,
    findNavPage,
    allNavPaths,
    type NavGateContext,
} from './admin-nav.js';

const baseCtx: NavGateContext = {
    devToolsEnabled: false,
    features: {},
    trainingAssignments: false,
    assessment: false,
    showcase: false,
};

describe('admin-nav manifest', () => {
    it('has the seven canonical sections in order', () => {
        expect(ADMIN_NAV.map((s) => s.id)).toEqual([
            'home',
            'library',
            'tasks',
            'system',
            'users',
            'settings',
            'developer',
        ]);
    });

    it('has no duplicate page paths', () => {
        const paths = allNavPaths();
        expect(new Set(paths).size).toBe(paths.length);
    });

    it('every page path is absolute under /admin', () => {
        for (const path of allNavPaths()) {
            expect(path.startsWith('/admin')).toBe(true);
        }
    });

    it('every section has at least one page and a landing page', () => {
        for (const section of ADMIN_NAV) {
            expect(section.pages.length).toBeGreaterThan(0);
            expect(typeof section.pages[0].path).toBe('string');
        }
    });

    it('titles and descriptions resolve to non-empty strings', () => {
        for (const section of ADMIN_NAV) {
            expect(section.title()).toBeTruthy();
            for (const page of section.pages) {
                expect(page.title()).toBeTruthy();
                if (page.description) expect(page.description()).toBeTruthy();
            }
        }
    });
});

describe('visibleNav gating', () => {
    it('hides the Developer section when dev tools are off', () => {
        const ids = visibleNav(baseCtx).map((s) => s.id);
        expect(ids).not.toContain('developer');
    });

    it('shows the Developer section when dev tools are on', () => {
        const ids = visibleNav({ ...baseCtx, devToolsEnabled: true }).map((s) => s.id);
        expect(ids).toContain('developer');
    });

    it('hides private-module pages unless their module is enabled', () => {
        const users = visibleNav(baseCtx).find((s) => s.id === 'users');
        const paths = users?.pages.map((p) => p.path) ?? [];
        expect(paths).not.toContain('/admin/trainings');
        expect(paths).not.toContain('/admin/courses');
    });

    it('shows training pages only when trainingAssignments is on', () => {
        const users = visibleNav({ ...baseCtx, trainingAssignments: true }).find(
            (s) => s.id === 'users',
        );
        const paths = users?.pages.map((p) => p.path) ?? [];
        expect(paths).toContain('/admin/trainings');
        expect(paths).toContain('/admin/reporting');
        expect(paths).not.toContain('/admin/courses');
    });

    it('shows assessment pages only when assessment is on', () => {
        const users = visibleNav({ ...baseCtx, assessment: true }).find((s) => s.id === 'users');
        const paths = users?.pages.map((p) => p.path) ?? [];
        expect(paths).toContain('/admin/courses');
        expect(paths).toContain('/admin/quizzes');
        expect(paths).not.toContain('/admin/trainings');
    });

    it('hides the showcase page unless the showcase module is enabled', () => {
        const library = visibleNav(baseCtx).find((s) => s.id === 'library');
        expect(library?.pages.map((p) => p.path)).not.toContain('/admin/showcase');
        // Library still renders (its other pages are unaffected).
        expect(library).toBeDefined();
    });

    it('shows the showcase page only when the showcase module is on', () => {
        const library = visibleNav({ ...baseCtx, showcase: true }).find((s) => s.id === 'library');
        expect(library?.pages.map((p) => p.path)).toContain('/admin/showcase');
    });

    it('drops a page whose featureFlag is falsy and keeps it when truthy', () => {
        const ids = visibleNav(baseCtx).map((s) => s.id);
        expect(ids).toEqual(['home', 'library', 'tasks', 'system', 'users', 'settings']);
    });

    it('shows the upload page only when an uploadable library exists', () => {
        const hidden = visibleNav(baseCtx).find((s) => s.id === 'library');
        expect(hidden?.pages.map((p) => p.path)).not.toContain('/admin/library/upload');
        const shown = visibleNav({
            ...baseCtx,
            features: { ...baseCtx.features, libraryUpload: true },
        }).find((s) => s.id === 'library');
        expect(shown?.pages.map((p) => p.path)).toContain('/admin/library/upload');
    });
});

describe('findNavPage', () => {
    it('matches /admin exactly to Home', () => {
        const hit = findNavPage('/admin');
        expect(hit?.section.id).toBe('home');
        expect(hit?.page.path).toBe('/admin');
    });

    it('does not match /admin to a sub-route', () => {
        const hit = findNavPage('/admin/library/media');
        expect(hit?.section.id).toBe('library');
        expect(hit?.page.path).toBe('/admin/library/media');
    });

    it('resolves a deep child to the nearest ancestor page (longest prefix)', () => {
        const hit = findNavPage('/admin/tasks/some-task-id');
        expect(hit?.section.id).toBe('tasks');
        expect(hit?.page.path).toBe('/admin/tasks');
    });

    it('resolves /admin/tasks/runs to its own Runs entry, not the Overview page (admin-ia step:runs)', () => {
        const hit = findNavPage('/admin/tasks/runs');
        expect(hit?.section.id).toBe('tasks');
        expect(hit?.page.path).toBe('/admin/tasks/runs');
    });

    it('returns null for an unknown path', () => {
        expect(findNavPage('/admin/nonexistent-xyz')).toBeNull();
    });
});

/**
 * Every manifest path must resolve to a real route directory (admin-ia
 * redesign, step `sections-routing`: "this step breaks links if sloppy").
 * SvelteKit route GROUPS (`(private)`) are transparent in the URL, so the
 * walker skips those segments rather than requiring a literal directory match.
 */
function collectPagePaths(dir: string, urlPrefix: string): string[] {
    const paths: string[] = [];
    let entries: Dirent<string>[];
    try {
        entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
        return paths;
    }
    const hasPage = entries.some(
        (e) => e.isFile() && (e.name === '+page.svelte' || e.name === '+page.server.ts'),
    );
    if (hasPage) paths.push(urlPrefix);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
        const segment = isGroup ? '' : `/${entry.name}`;
        paths.push(...collectPagePaths(join(dir, entry.name), urlPrefix + segment));
    }
    return paths;
}

describe('route existence', () => {
    it('every ADMIN_NAV path has a matching route directory under src/routes', () => {
        const adminRoutesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../routes/admin');
        const validPaths = new Set(collectPagePaths(adminRoutesRoot, '/admin'));
        // Some pages live under routes/admin/(private), which the public tree does
        // not ship. Their nav entries stay hidden there (the module is never enabled), so
        // only require their routes when that route group is present.
        const hasPrivateTree = existsSync(join(adminRoutesRoot, '(private)'));
        const privatePaths = new Set(
            ADMIN_NAV.flatMap((s) => s.pages)
                .filter((p) => 'privateModule' in p && p.privateModule)
                .map((p) => p.path),
        );
        for (const path of allNavPaths()) {
            if (!hasPrivateTree && privatePaths.has(path)) continue;
            expect(validPaths.has(path), `no route directory backs manifest path ${path}`).toBe(
                true,
            );
        }
    });
});
