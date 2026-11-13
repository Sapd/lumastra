// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { configSections } from '$lib/config/schema';
import {
    ADMIN_SETTINGS_PAGES,
    ORPHAN_SECTION_IDS,
    getPageForSection,
} from './admin-settings-pages';
import { ADMIN_NAV } from './admin-nav';

describe('admin settings page registry', () => {
    it('claims every config section exactly once, or marks it orphan', () => {
        const claimed = new Map<string, number>();
        for (const page of ADMIN_SETTINGS_PAGES) {
            for (const id of page.sectionIds) {
                claimed.set(id, (claimed.get(id) ?? 0) + 1);
            }
        }
        for (const section of configSections) {
            const claims = claimed.get(section.id) ?? 0;
            const orphan = ORPHAN_SECTION_IDS.has(section.id);
            // Exactly one of: claimed once, or orphan.
            expect(
                (claims === 1 && !orphan) || (claims === 0 && orphan),
                `section '${section.id}' must be claimed by exactly one page OR be orphan (claims=${claims}, orphan=${orphan})`,
            ).toBe(true);
        }
    });

    it('never double-claims a section across pages', () => {
        const seen = new Set<string>();
        for (const page of ADMIN_SETTINGS_PAGES) {
            for (const id of page.sectionIds) {
                expect(seen.has(id), `section '${id}' claimed by multiple pages`).toBe(false);
                seen.add(id);
            }
        }
    });

    it('resolves branding to the main settings page', () => {
        expect(getPageForSection('branding')?.href).toBe('/admin/settings');
    });

    it('deep-links navigation settings to the tab that actually renders them', () => {
        // NOT ?tab=navigation. The Navigation tab renders only the custom link-list
        // editor for the hidden array keys; the navigation section's visible rows
        // (FEATURE_SIDEBAR, SHOW_FOOTER, …) are rendered by HomepageSettingsTab.
        // Pointing at the Navigation tab landed the user where the row doesn't exist.
        const nav = getPageForSection('navigation');
        expect(nav?.href).toBe('/admin/settings/homepage');
        expect(nav?.tab).toBe('homepage');
    });

    it('resolves default-tab sections to their own tab (deep-link pinning)', () => {
        expect(getPageForSection('music')?.tab).toBe('settings');
        expect(getPageForSection('homepage')?.tab).toBe('homepage');
        expect(getPageForSection('trending')?.tab).toBe('homepage');
    });

    it('keeps the general page down to the instance-wide sections', () => {
        const general = ADMIN_SETTINGS_PAGES.find((p) => p.href === '/admin/settings');
        expect(general?.sectionIds).toEqual([
            'branding',
            'features',
            'localization',
            'diagnostics',
            'advanced',
            'modules',
            'licensing',
        ]);
    });

    it('resolves the redistributed sections to the page that now loads them', () => {
        // Each expectation mirrors one `+page.server.ts` section list. If a loader
        // and this registry disagree the deep-link opens a page without the row —
        // the single-ownership test above cannot catch that.
        for (const id of ['groups', 'auth', 'social', 'deviceAuth', 'network']) {
            expect(getPageForSection(id)?.href, id).toBe('/admin/settings/access');
        }
        for (const id of ['image', 'media', 'topshelf']) {
            expect(getPageForSection(id)?.href, id).toBe('/admin/settings/media');
        }
        expect(getPageForSection('downloads')?.href).toBe('/admin/settings/playback');
        expect(getPageForSection('advanced-tasks')?.href).toBe('/admin/settings/tasks');
        expect(getPageForSection('sync')?.href).toBe('/admin/settings/connections');
    });

    it('deep-links browse/hover to the homepage tab that renders them', () => {
        // Same trap as `navigation`: HomepageSettingsTab renders the whole loaded
        // schema, the Navigation tab renders only the custom link-list editor.
        for (const id of ['browse', 'hover']) {
            const hit = getPageForSection(id);
            expect(hit?.href, id).toBe('/admin/settings/homepage');
            expect(hit?.tab, id).toBe('homepage');
        }
    });

    it('leaves no section unreachable', () => {
        // `requests` (Jellyseerr URL + API key) was an orphan: no page loaded it, so
        // those values could only be set by env var or by editing settings.json.
        // Every section now resolves to a page.
        expect([...ORPHAN_SECTION_IDS]).toEqual([]);
        expect(getPageForSection('requests')?.href).toBe('/admin/settings/connections');
        expect(getPageForSection('licensing')?.href).toBe('/admin/settings');
    });

    it('labels each page exactly as the settings nav does', () => {
        // Search results are grouped under these labels; "Live TV Sources" under a
        // nav entry called "Live TV" read as two different places.
        const navTitles = new Map(
            ADMIN_NAV.flatMap((section) => section.pages).map((p) => [p.path, p.title()] as const),
        );
        for (const page of ADMIN_SETTINGS_PAGES) {
            expect(page.label(), page.href).toBe(navTitles.get(page.href));
        }
    });

    it("has each page's loader actually load every section the registry gives it", () => {
        // A section claimed here but missing from the page's loader has no editor
        // anywhere (`push` was claimed by Access but never loaded, so the push
        // relay settings could not be set in the UI). Read as text: the loaders
        // pull in the DB and config service. Connections builds its list from
        // CONNECTION_SERVICES, so that module counts as part of its loader.
        for (const page of ADMIN_SETTINGS_PAGES) {
            let source = readFileSync(`src/routes${page.href}/+page.server.ts`, 'utf-8');
            if (page.href === '/admin/settings/connections') {
                source += readFileSync('src/lib/server/admin/connection-status.ts', 'utf-8');
            }
            for (const id of page.sectionIds) {
                expect(source.includes(`'${id}'`), `${page.href} does not load '${id}'`).toBe(true);
            }
        }
    });
});
