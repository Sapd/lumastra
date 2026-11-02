// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';

/**
 * The admin sidebar lists the active section's pages itself, so the section tab
 * row hides — but only while the FULL sidebar shows. Below 1280px the layout
 * forces the rail (`matchMedia('(max-width: 1279px)')` in the admin layout) and
 * AdminSectionTabs hides only from `min-width: 1280px`. The two literals live in
 * different files and jsdom evaluates neither, so this pins both sides of the
 * edge: at no width may the pages be listed twice, or not at all.
 */
test.describe('admin sidebar sub-pages', () => {
    test('full sidebar at 1280px lists the pages and hides the tab row', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto('/admin/tasks/runs');
        await expectHydrated(page);

        const sidebar = page.getByRole('navigation', { name: 'Admin sections' });
        const pages = sidebar.locator('#admin-nav-pages-tasks');
        await expect(pages).toBeVisible();
        await expect(pages.locator('a[aria-current="page"]')).toHaveAttribute(
            'href',
            /\/admin\/tasks\/runs$/,
        );
        await expect(page.locator('nav.section-tabs')).toBeHidden();
    });

    test('rail at 1279px keeps the tab row and lists no pages inline', async ({ page }) => {
        await page.setViewportSize({ width: 1279, height: 900 });
        await page.goto('/admin/tasks/runs');
        await expectHydrated(page);

        await expect(page.locator('#admin-nav-pages-tasks')).toHaveCount(0);
        const tabs = page.locator('nav.section-tabs');
        await expect(tabs).toBeVisible();
        await expect(tabs.locator('a[aria-current="page"]')).toHaveAttribute(
            'href',
            /\/admin\/tasks\/runs$/,
        );
    });

    test('Settings keeps its own area nav next to the full sidebar', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/admin/settings/playback');
        await expectHydrated(page);

        await expect(page.getByRole('navigation', { name: 'Settings', exact: true })).toBeVisible();
        await expect(page.locator('#admin-nav-pages-settings')).toHaveCount(0);
    });
});
