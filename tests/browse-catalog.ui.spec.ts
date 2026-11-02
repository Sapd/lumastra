// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';

// Keep navigation assertions independent of the test database's media catalog.
test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/browse(?:\?|$)/, (route) =>
        route.fulfill({
            json: { recentlyAdded: [], genres: [{ genre: 'Action', items: [] }] },
        }),
    );
    await page.route(/\/api\/browse\/az(?:\?|$)/, (route) =>
        route.fulfill({
            json: { items: [], page: { limit: 50, offset: 0, total: 0, hasMore: false } },
        }),
    );
    await page.route(/\/api\/browse\/libraries(?:\?|$)/, (route) =>
        route.fulfill({
            json: { libraries: [], totalLibraries: 0 },
        }),
    );
    await page.route(/\/api\/browse\/keywords(?:\?|$)/, (route) =>
        route.fulfill({
            json: {
                items: [],
                availableKeywords: [],
                page: { limit: 5, offset: 0, total: 0, hasMore: false },
            },
        }),
    );
});

test('Discover reloads the selected media type after switching from Library', async ({ page }) => {
    await gotoHydrated(page, '/browse?mode=az');
    await expect(page.getByRole('button', { name: 'Library · A–Z' })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await page.getByRole('tab', { name: 'Movies', exact: true }).click();
    const browseResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/browse' && url.searchParams.get('type') === 'movies';
    });
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    expect((await browseResponse).ok()).toBe(true);
    await expect(page.getByRole('tab', { name: 'Movies', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Movies');
    await expect(page.getByRole('tabpanel').getByText('Series', { exact: true })).toHaveCount(0);
});

test('genre navigation, title search and reload preserve the catalog scope', async ({ page }) => {
    await gotoHydrated(page, '/browse?mode=az');
    await expect(page.getByRole('button', { name: 'Library · A–Z' })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await page.getByRole('tab', { name: 'Movies', exact: true }).click();
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    const genre = page
        .getByRole('navigation', { name: 'Browse by genre' })
        .getByRole('link', { name: 'Action', exact: true });
    await genre.click();
    await expect(page.getByRole('button', { name: 'Remove Action' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search titles in your library' }).fill('matrix');
    await expect(page).toHaveURL(/q=matrix/);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Search titles in your library' })).toHaveValue(
        'matrix',
    );
    await expect(page.getByRole('button', { name: 'Remove Action' })).toBeVisible();
    // The search box's own ✕ (aria-label). With no match for "matrix" the empty
    // state offers a second button with the same name, so address the box's one.
    await page.getByLabel('Clear search', { exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Search titles in your library' })).toHaveValue(
        '',
    );
    await expect(page).not.toHaveURL(/q=matrix/);
    await expect(page.getByRole('button', { name: 'Remove Action' })).toBeVisible();
});

test('bare Browse restores Kids, list, filters and sorting through reload and browser history', async ({
    page,
}) => {
    test.setTimeout(120_000);
    const startupErrors: string[] = [];
    page.on('pageerror', (error) => {
        if (error.message.includes('before router is initialized'))
            startupErrors.push(error.message);
    });
    const kidsId = 'a95f348c-9d6a-4fd2-aa75-b8d824ad342a';
    await page.route(/\/api\/browse\/libraries(?:\?|$)/, (route) =>
        route.fulfill({
            json: {
                totalLibraries: 2,
                libraries: [
                    { id: kidsId, name: 'Kids', mediaType: 'mixed', itemCount: 20 },
                    {
                        id: 'ea4283a8-0c52-434f-93b6-f2b9213c844e',
                        name: 'Other',
                        mediaType: 'mixed',
                        itemCount: 10,
                    },
                ],
            },
        }),
    );
    await gotoHydrated(page, '/browse?mode=az');
    await page.locator('.filter-trigger').click();
    await expect(page.locator(`.catalog-library-field option[value="${kidsId}"]`)).toBeAttached();
    await page.locator('.catalog-library-field select').selectOption(kidsId);
    await page
        .locator('.filter-dialog fieldset')
        .first()
        .getByRole('button', { name: 'German', exact: true })
        .click();
    await page.locator('.filter-dialog .done').click();
    await page.getByRole('button', { name: 'Compact list', exact: true }).click();
    await page.getByRole('combobox', { name: 'Sort order' }).selectOption('year_desc');
    await expect(page).toHaveURL(/sort=year_desc/);

    await page.getByRole('link', { name: 'Back', exact: true }).click();
    await page.locator('a[href$="/browse"]').first().click();
    await expect(page).toHaveURL(new RegExp(`libraryGroupId=${kidsId}`));
    await expect(page.getByRole('button', { name: 'Compact list', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(page.getByRole('combobox', { name: 'Sort order' })).toHaveValue('year_desc');
    await expect(page).toHaveURL(/audio=de/);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Compact list', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(page.getByRole('combobox', { name: 'Sort order' })).toHaveValue('year_desc');
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Browse', exact: true })).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`libraryGroupId=${kidsId}`));
    await expect(page.getByRole('button', { name: 'Compact list', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    const azResponse = page.waitForRequest((request) => {
        const incoming = new URL(request.url());
        return (
            incoming.pathname === '/api/browse/az' &&
            incoming.searchParams.get('libraryGroupId') === kidsId
        );
    });
    await gotoHydrated(page, '/browse');
    const restored = new URL((await azResponse).url());
    expect(restored.searchParams.get('audio')).toBe('de');
    expect(restored.searchParams.get('sort')).toBe('year_desc');
    await expect(page.getByRole('button', { name: 'Library · A–Z', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await page.locator('.filter-trigger').click();
    await expect(page.locator('.catalog-library-field select')).toHaveValue(kidsId);
    expect(startupErrors).toEqual([]);
});
