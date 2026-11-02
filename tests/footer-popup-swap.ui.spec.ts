// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';

/**
 * The account trigger is the hero avatar button in `src/routes/+page.svelte`
 * (it was moved there out of the footer). Its `<img alt>` is a paraglide
 * message — `m.nav_account_menu()`, "Account" in en and "Konto" in de — so the
 * old `[alt="User avatar"]` selector matched nothing and the spec spent 30s
 * timing out. `Avatar.svelte` also drops the `<img>` entirely and renders text
 * initials when it has neither a `src` nor a `username`, so keying on the image
 * at all is fragile. The class is the stable, locale-independent handle.
 */
const accountTrigger = 'button.hero-avatar-btn';

test.describe('footer bar + slim popup swap', () => {
    test('footer bar still renders configured action links', async ({ page }) => {
        await page.goto('/');
        // At least one FOOTER_LINKS button (Chat/Request/Wiki/Quick Connect) is present.
        await expect(page.locator('.btn').first()).toBeVisible();
    });

    test('avatar opens the slimmed popup with Settings + Logout floor', async ({ page }) => {
        await page.goto('/');
        // `use:popup` is a client action: without hydration the click lands on a
        // dead element and the popup never opens.
        await expectHydrated(page);
        await page.locator(accountTrigger).first().click();
        await expect(page.getByRole('link', { name: /Settings/ }).first()).toBeVisible();
        await expect(page.getByText(/Logout|Sign out/).first()).toBeVisible();
        // Migrated items are GONE from the popup.
        await expect(page.getByText('API Tokens')).toHaveCount(0);
        await expect(page.getByText('Customize Widgets')).toHaveCount(0);
        await expect(page.getByText('Hidden items')).toHaveCount(0);
    });

    test('popup Settings lands on the first enabled section', async ({ page }) => {
        await page.goto('/');
        await expectHydrated(page);
        await page.locator(accountTrigger).first().click();
        await page
            .getByRole('link', { name: /^Settings/ })
            .first()
            .click();
        await expect(page).toHaveURL(/\/settings\/[a-z]+$/);
    });

    test('page-behind is inert while the overlay is open', async ({ page }) => {
        await page.goto('/settings/playback');
        await expectHydrated(page);

        // The page-behind is the SIDEBAR, not <main>. The settings overlay is a
        // route that renders INTO this layout's <main> (`{@render children()}`),
        // so marking `main.main-content` inert would disable the overlay itself
        // — `src/routes/+layout.svelte` says so where it wraps only the Sidebar
        // in `<div style="display: contents" inert={settingsOverlayOpen}>`.
        // Asserting inert on <main> asserted the opposite of the a11y contract.
        await expect(page.locator('main.main-content')).not.toHaveAttribute('inert', /.*/);
        await expect(page.locator('div[inert]').first()).toBeAttached();
    });
});
