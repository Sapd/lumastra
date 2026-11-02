// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';

test.describe('settings sections (Plan 2)', () => {
    /**
     * Privacy is its OWN section now (`/settings/privacy`, PrivacySection.svelte)
     * and is listed separately in the settings nav. "Hide my streams" moved with
     * it; only the message KEY still carries the old `settings_display_` prefix,
     * which is why grepping the string still finds it under src/ and made this
     * look like a live assertion. Display kept the full-text search default.
     */
    test('Instance always credits audiobookshelf', async ({ page }) => {
        await page.goto('/admin/system/instance#data-flows');
        const credit = page.locator('#data-flows').getByRole('link', {
            name: 'Audiobook integration with audiobookshelf',
        });
        await expect(credit).toBeVisible();
        await expect(page.locator('#data-flows')).toContainText(
            'When configured, Lumastra connects to your audiobookshelf server',
        );
        await expect(credit.locator('img')).toBeVisible();
        await expect(credit).toHaveAttribute('href', 'https://www.audiobookshelf.org/');
    });

    test('Display shows the fulltext default', async ({ page }) => {
        await page.goto('/settings/display');
        await expect(page.getByText(/Full-text search/i)).toBeVisible();
    });

    test('Privacy shows the hide-my-streams master opt-out', async ({ page }) => {
        await page.goto('/settings/privacy');
        await expect(page.getByText(/Hide my streams/i).first()).toBeVisible();
    });

    test('Playback deep-link highlight scrolls to the control', async ({ page }) => {
        await page.goto('/settings/playback?highlight=skip-intro');
        await expect(page.locator('#playback-skip-intro')).toBeVisible();
    });

    test('Subtitles renders defaults + appearance', async ({ page }) => {
        await page.goto('/settings/subtitles');
        await expect(page.getByText('Default subtitle language')).toBeVisible();
    });

    test('Home reorder exposes Move up / Move down per row', async ({ page }) => {
        await page.goto('/settings/home');
        await expect(page.getByRole('button', { name: /Move down/ }).first()).toBeVisible();
    });

    test('Devices: single revoke needs confirmation (no native dialog)', async ({ page }) => {
        await page.goto('/settings/devices');
        await expectHydrated(page);
        const revoke = page.getByRole('button', { name: /Log out/ }).first();
        if (await revoke.isVisible().catch(() => false)) {
            await revoke.click();
            await expect(page.getByRole('button', { name: /Confirm/ })).toBeVisible();
        }
    });
});
