// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';

/**
 * The settings overlay's own dialog, addressed by the thing that makes it that
 * dialog. A bare `getByRole('dialog')` is a strict-mode violation here: the
 * Account section mounts `AvatarUploadPopover`, which is a second
 * `role="dialog"`, so the locator resolved to two elements and the failure
 * ("strict mode violation") read like a rendering bug rather than an
 * over-broad selector.
 */
const settingsDialog = '[role="dialog"][aria-labelledby="settings-dialog-heading"]';

test.describe('settings shell', () => {
    // `expectHydrated` alone may wait HYDRATION_TIMEOUT_MS (30s) on a cold dev
    // server, which is the whole default test timeout.
    test.describe.configure({ timeout: 90_000 });

    test('/settings redirects to the first enabled section', async ({ page }) => {
        // The desktop redirect to the first enabled section is a client redirect
        // in the layout (`/settings` itself renders the section list), so it
        // only happens after hydration.
        await gotoHydrated(page, '/settings');
        await expect(page).toHaveURL(/\/settings\/[a-z]+$/);
        await expect(page.locator(settingsDialog)).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();
    });

    test('a section deep-links and shows its heading', async ({ page }) => {
        await gotoHydrated(page, '/settings/playback');
        // The overlay owns the page's only h1 (sr-only "Settings"); the section
        // title is the h2 labelled `settings-section-heading`.
        await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeAttached();
        await expect(page.getByRole('heading', { level: 2, name: 'Playback' })).toBeVisible();
    });

    test('close button leaves the settings overlay', async ({ page }) => {
        await gotoHydrated(page, '/settings/playback');
        // `closeSettings` is an onclick handler. The close button is
        // server-rendered, so without this barrier Playwright clicks it before
        // the handler is attached, nothing navigates, and the failure reads as
        // a dead close button. Measured: with the barrier the URL goes to `/`.
        await page.getByRole('button', { name: 'Close settings' }).click();
        await expect(page).not.toHaveURL(/\/settings/);
    });

    test('search surfaces a synonym match', async ({ page }) => {
        await gotoHydrated(page, '/settings/playback');
        await page.getByLabel('Search settings').fill('captions');
        await expect(page.getByText('Default subtitle language')).toBeVisible();
    });
});
