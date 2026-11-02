// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { adminTest as test, expect } from './fixtures/auth';
import { TEST_MEDIA_ITEM_ID } from './global-setup';
import { gotoHydrated } from './helpers/cold-load';

test('sidebar Back and Forward retain the browse search', async ({ page }) => {
    await gotoHydrated(page, '/browse?type=movies&mode=az&q=matrix');
    await expect(page.getByRole('textbox', { name: 'Search titles in your library' })).toHaveValue(
        'matrix',
    );
    await page
        .getByRole('complementary')
        .getByRole('button', { name: 'Playlists', exact: true })
        .click();
    await expect(page).toHaveURL(/\/playlists$/);
    await page.goBack();
    await expect(page.getByRole('textbox', { name: 'Search titles in your library' })).toHaveValue(
        'matrix',
    );
    await page.goForward();
    await expect(page).toHaveURL(/\/playlists$/);
});

// The seeded catalog has three unrelated synthetic titles and no embeddings, so
// the server returns no similar titles for any of them. Serve a deterministic
// "similar" rail from the route instead: the seeded `E2E Test Video` is similar
// to every other title (and to nothing itself), and opening it from the rail is
// real navigation through the real modal.
const SEEDED_VIDEO_ID = TEST_MEDIA_ITEM_ID;

test('modal Back does not put the related title back in the browser return path', async ({
    page,
}) => {
    await page.route(/\/api\/media\/[^/]+\/similar(?:\?|$)/, async (route) => {
        const key = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '');
        const similar = key.includes(SEEDED_VIDEO_ID)
            ? []
            : [
                  {
                      id: SEEDED_VIDEO_ID,
                      type: 'movie',
                      catalogId: SEEDED_VIDEO_ID,
                      ids: {},
                      images: {},
                      title: 'E2E Test Video',
                      score: 0.9,
                      availability: { isAvailable: true, hasFile: true, canRequest: false },
                  },
              ];
        await route.fulfill({ json: { items: similar, truncated: false } });
    });
    await gotoHydrated(page, '/browse?type=movies&mode=az');
    // Open a card through its title: the card is a button whose centre carries a
    // nested Play button, so a centre click would navigate to /watch instead of
    // opening the modal.
    await page.getByRole('tabpanel').getByText('E2E Related Video', { exact: true }).click();
    const original = page.getByRole('dialog').last();
    const title = await original.getByRole('heading', { level: 1 }).innerText();
    const parentUrl = page.url();
    await original
        .getByRole('region', { name: 'Similar Movies' })
        .getByRole('button')
        .first()
        .click();
    await expect(page).not.toHaveURL(parentUrl);
    await page.getByRole('dialog').last().getByRole('button', { name: title, exact: true }).click();
    await expect(page).toHaveURL(parentUrl);
    await page.goBack();
    await expect(page.getByRole('dialog')).toHaveCount(0);
});
