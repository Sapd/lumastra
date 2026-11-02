// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';

// These use the configured catalog: the homepage must have a media card.
test('homepage details expose a visible close button on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoHydrated(page, '/');
    const hero = page.getByRole('button', { name: /^Open details for / }).first();
    await expect(hero).toBeVisible();
    // The modal components load lazily after hydration. A tap before the modal
    // registry is ready is dropped (the page logs "Modal registry not
    // initialized") and nothing opens — a PRODUCT BUG (tracked 2026-10-13
    // ci/e2e-speed: getModalComponent throws instead of awaiting waitForModals()).
    // This test is about the close button, so repeat the tap until the modal
    // route is in the URL. Only the OPENING is retried; the close-button assertions
    // below run once.
    await expect(async () => {
        await hero.click({ timeout: 2_000 });
        await expect(page).toHaveURL(/[?&]modal=/, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const dialog = page.getByRole('dialog').last();
    // ModalMovie also renders a compact sticky-header close button that stays
    // `disabled` while the hero is on screen; the enabled one is the control a
    // phone user can actually tap.
    const close = dialog.getByRole('button', { name: 'Close modal', exact: true, disabled: false });
    await expect(close).toBeVisible();
    await close.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
});
