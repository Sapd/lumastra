// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';

test('Home media modal preserves history through close, Back and Forward', async ({ page }) => {
    test.setTimeout(90_000);
    await gotoHydrated(page, '/');
    const hero = page.getByRole('button', { name: /^Open details for / }).first();
    await expect(hero).toBeVisible();
    // Modal registration is lazy; only retry opening, never history assertions.
    await expect(async () => {
        await hero.click({ timeout: 2_000 });
        await expect(page.getByRole('dialog').last()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const modalUrl = page.url();
    const modalState: unknown = await page.evaluate(() => window.history.state);
    expect(modalState).not.toEqual({});
    const title = await page
        .getByRole('dialog')
        .last()
        .getByRole('heading', { level: 1 })
        .innerText();
    await page.evaluate(() =>
        document.documentElement.setAttribute('data-history-document', 'same'),
    );
    const documents: string[] = [];
    page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            documents.push(request.url());
        }
    });

    // Forward reconstructs the modal from its URL, including canonicalization.
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(modalUrl);
    await expect(page.getByRole('dialog').last().getByRole('heading', { level: 1 })).toHaveText(
        title,
    );
    expect(await page.evaluate(() => window.history.state)).toEqual(modalState);

    await page
        .getByRole('dialog')
        .last()
        .getByRole('button', {
            name: 'Close',
            exact: true,
            disabled: false,
        })
        .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await page.goBack();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(hero).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Check a real page transition as well as two shallow Home entries.
    await page
        .getByRole('complementary')
        .getByRole('button', {
            name: 'Playlists',
            exact: true,
        })
        .click();
    await expect(page).toHaveURL(/\/playlists$/);
    await expect(hero).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(hero).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(/\/playlists$/);
    await expect(hero).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-history-document', 'same');
    expect(documents).toEqual([]);
});
