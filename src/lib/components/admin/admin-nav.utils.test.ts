// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/components/admin/admin-nav.utils.test.ts
import { describe, it, expect } from 'vitest';
import type { AdminNavSection } from '$lib/config/admin-nav.js';
import { ADMIN_NAV } from '$lib/config/admin-nav.js';
import {
    sectionPageGroups,
    settingsPageGroups,
    isRouteActive,
    isGroupActive,
    resolveActiveNavPath,
    isPinActive,
    resolveSectionLandingPath,
    lastSectionPageStorageKey,
} from './admin-nav.utils';

describe('isRouteActive', () => {
    it('matches root /admin exactly', () => {
        expect(isRouteActive('/admin', '/admin')).toBe(true);
        expect(isRouteActive('/admin', '/admin/users')).toBe(false);
    });

    it('matches sub-routes with prefix', () => {
        expect(isRouteActive('/admin/users', '/admin/users')).toBe(true);
        expect(isRouteActive('/admin/users', '/admin/users/123')).toBe(true);
        expect(isRouteActive('/admin/users', '/admin/settings')).toBe(false);
    });
});

describe('isGroupActive', () => {
    const contentRoutes = [
        '/admin/library',
        '/admin/library/media',
        '/admin/tasks',
        '/admin/developer/embeddings',
    ];

    it('returns true when current path matches any group route', () => {
        expect(isGroupActive(contentRoutes, '/admin/library/media')).toBe(true);
        expect(isGroupActive(contentRoutes, '/admin/library/media/abc-123')).toBe(true);
    });

    it('returns false when current path is in a different group', () => {
        expect(isGroupActive(contentRoutes, '/admin/settings')).toBe(false);
        expect(isGroupActive(contentRoutes, '/admin')).toBe(false);
    });
});

describe('resolveActiveNavPath', () => {
    it('picks the nested sibling over its parent (regression: double highlight)', () => {
        const paths = ['/admin/users', '/admin/users/sessions', '/admin/users/api-tokens'];
        expect(resolveActiveNavPath('/admin/users/sessions', paths)).toBe('/admin/users/sessions');
    });

    it('the parent path loses once a nested sibling matches', () => {
        const paths = ['/admin/users', '/admin/users/sessions'];
        // Sanity: the parent alone would still "match" via prefix — but it must
        // not be the winner when a longer sibling also matches.
        expect(resolveActiveNavPath('/admin/users/sessions', paths)).not.toBe('/admin/users');
    });

    it('matches exactly when only the parent path is given', () => {
        const paths = ['/admin/users'];
        expect(resolveActiveNavPath('/admin/users/sessions', paths)).toBe('/admin/users');
        expect(resolveActiveNavPath('/admin/users', paths)).toBe('/admin/users');
    });

    it('treats /admin as a special case that matches only exactly', () => {
        const paths = ['/admin', '/admin/library/media'];
        expect(resolveActiveNavPath('/admin', paths)).toBe('/admin');
        expect(resolveActiveNavPath('/admin/library/media', paths)).toBe('/admin/library/media');
        expect(resolveActiveNavPath('/admin/unknown', paths)).toBeNull();
    });

    it('returns null when nothing matches', () => {
        expect(
            resolveActiveNavPath('/admin/settings', ['/admin/users', '/admin/tasks']),
        ).toBeNull();
    });

    it('resolves a deep sub-route to the longest matching ancestor page', () => {
        const paths = ['/admin/tasks', '/admin/tasks/runs'];
        expect(resolveActiveNavPath('/admin/tasks/runs/abc-123', paths)).toBe('/admin/tasks/runs');
        expect(resolveActiveNavPath('/admin/tasks/xyz', paths)).toBe('/admin/tasks');
    });
});

describe('isPinActive', () => {
    it('matches a pin whose href carries a query or anchor on its pathname', () => {
        const pin = { href: '/admin/library/fix-matches?view=broken' };
        expect(isPinActive('/admin/library/fix-matches', pin)).toBe(true);
        expect(
            isPinActive('/admin/settings/security', { href: '/admin/settings/security#2fa' }),
        ).toBe(true);
        expect(isPinActive('/admin/library/media', pin)).toBe(false);
    });
});

describe('resolveSectionLandingPath', () => {
    const section: AdminNavSection = {
        id: 'users',
        title: () => 'Users',
        icon: 0 as unknown as AdminNavSection['icon'],
        pages: [
            { path: '/admin/users', title: () => 'Users' },
            { path: '/admin/users/sessions', title: () => 'Active sessions' },
        ],
    };

    it('prefers the remembered path when it is still a visible page', () => {
        expect(resolveSectionLandingPath(section, '/admin/users/sessions')).toBe(
            '/admin/users/sessions',
        );
    });

    it('falls back to the default landing page when nothing is remembered', () => {
        expect(resolveSectionLandingPath(section, null)).toBe('/admin/users');
    });

    it('falls back to the default landing page when the remembered path is stale', () => {
        expect(resolveSectionLandingPath(section, '/admin/users/removed-page')).toBe(
            '/admin/users',
        );
    });
});

describe('lastSectionPageStorageKey', () => {
    it('namespaces the key per section id', () => {
        expect(lastSectionPageStorageKey('users')).toBe('admin:last-page:users');
        expect(lastSectionPageStorageKey('tasks')).toBe('admin:last-page:tasks');
    });
});

describe('sectionPageGroups / settingsPageGroups', () => {
    const settings = ADMIN_NAV.find((s) => s.id === 'settings')!;
    const paths = (group: { pages: { path: string }[] }): string[] =>
        group.pages.map((p) => p.path);

    it('splits Settings into General / Media / Experience, every page exactly once', () => {
        const groups = settingsPageGroups(settings.pages);
        expect(groups.map((g) => g.id)).toEqual(['general', 'media', 'experience']);
        // Exact membership: the flyout and the in-page directory both render
        // these groups, and a new Settings page must be placed on purpose.
        expect(new Set(paths(groups[0]))).toEqual(
            new Set([
                '/admin/settings',
                '/admin/settings/access',
                '/admin/settings/secrets',
                '/admin/settings/connections',
                '/admin/settings/providers',
            ]),
        );
        expect(new Set(paths(groups[1]))).toEqual(
            new Set([
                '/admin/settings/media',
                '/admin/settings/playback',
                '/admin/settings/music',
                '/admin/settings/livetv',
                '/admin/settings/audiobookshelf',
            ]),
        );
        const all = groups.flatMap(paths);
        expect(all.sort()).toEqual(settings.pages.map((p) => p.path).sort());
    });

    it('drops a group whose pages are all gated away', () => {
        const media = paths(settingsPageGroups(settings.pages)[1]);
        const gated = { ...settings, pages: settings.pages.filter((p) => !media.includes(p.path)) };
        expect(sectionPageGroups(gated).map((g) => g.id)).toEqual(['general', 'experience']);
    });

    it('returns one unlabelled group for any other section', () => {
        const tasks = ADMIN_NAV.find((s) => s.id === 'tasks')!;
        expect(sectionPageGroups(tasks)).toEqual([
            { id: 'tasks', label: null, pages: tasks.pages },
        ]);
    });
});
