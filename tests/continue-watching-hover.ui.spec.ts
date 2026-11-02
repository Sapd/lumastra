// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Locator, Page } from '@playwright/test';
import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';

const seriesName = 'Hover pointer fixture';
const removeLabel = `Remove ${seriesName} from Continue Watching`;
const fixtureId = 'e2e00000-0000-4000-8000-000000000081';
const artwork = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#253956"/></svg>')}`;

async function expectWithinViewport(page: Page, locator: Locator): Promise<void> {
    await expect(locator).toBeVisible();
    await expect(locator).toHaveCSS('visibility', 'visible');
    const bounds = await locator.boundingBox();
    const viewport = page.viewportSize();
    expect(bounds).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.height);
}

async function movePointerTo(page: Page, locator: Locator): Promise<void> {
    const bounds = await locator.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2, {
        steps: 8,
    });
}

test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    const screenshot = testInfo.outputPath('pointer-failure.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('Pointer failure', { path: screenshot, contentType: 'image/png' });
});

test.beforeEach(async ({ page }) => {
    // Only the feed data is stubbed: the actual home section, media card,
    // popup portal, styles, Floating UI positioning and pointer handlers run.
    await page.route(/\/api\/for-you\/watching(?:\?|$)/, (route) =>
        route.fulfill({
            json: {
                sections: [
                    {
                        id: 'continue-watching',
                        type: 'continue-watching',
                        title: 'Continue Watching',
                        cardVariant: 'backdrop',
                        items: [
                            {
                                id: fixtureId,
                                externalIds: { internal: fixtureId },
                                mediaType: 'episode',
                                title: seriesName,
                                seriesName,
                                seriesId: 'e2e00000-0000-4000-8000-000000000082',
                                subtitle: 'S4:E38 - Pointer transitions',
                                seasonNumber: 4,
                                episodeNumber: 38,
                                durationMs: 21 * 60_000,
                                progress: 86,
                                overview:
                                    'A deterministic episode used to exercise the real pointer and portal behavior.',
                                image: artwork,
                                backdrop: artwork,
                                isAvailable: true,
                                hasFiles: true,
                                canRequest: false,
                            },
                        ],
                    },
                ],
            },
        }),
    );
});

for (const viewport of [
    { width: 1440, height: 900 },
    { width: 800, height: 600 },
]) {
    test.describe(`Continue Watching pointer interaction at ${viewport.width}px`, () => {
        test.use({ viewport });

        test('card actions remain reachable; preview and icon hints survive real pointer transitions', async ({
            page,
        }, testInfo) => {
            test.setTimeout(90_000);
            // Exercise the real cached-shell recovery path: the fresh server
            // seed is deliberately stale to the client, so the watching strip
            // fetches our deterministic feed instead of trusting the empty SSR row.
            await page.clock.setFixedTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
            await gotoHydrated(page, '/');
            const card = page.locator('.card-touch-root').filter({ hasText: seriesName }).first();
            await expect(card).toBeVisible({ timeout: 30_000 });
            await card.scrollIntoViewIfNeeded();

            // Video cards expose dismiss through their shared action menu.
            // Hover the trigger without opening a preview, then prove that the
            // menu still offers the title-scoped Continue Watching action.
            await card.hover({ position: { x: 12, y: 12 } });
            const actions = card.getByRole('button', { name: 'Actions', exact: true });
            await actions.hover();
            await page.waitForTimeout(350);
            await expect(page.locator('.media-hover-popup')).toHaveCount(0);
            await actions.click();
            await expect(
                page.getByRole('menuitem', { name: removeLabel, exact: true }),
            ).toBeVisible();
            await page.keyboard.press('Escape');

            await card.locator('[data-play-button]').hover();
            const popup = page.locator('.media-hover-popup');
            // Default hover opening has no extra dwell; allow only rendering
            // and the existing fade, rather than the old long hover delay.
            await expect(popup).toBeVisible({ timeout: 500 });
            await expect(popup.locator('.progress-text')).toHaveText('3 min left');
            await expect(popup.locator('.popup-episode')).toHaveText('S4E38 · Pointer transitions');

            const icon = popup.locator('[data-action="more"]');
            await icon.hover();
            const title = popup.getByRole('heading', { name: seriesName, exact: true });
            await expect(title).toBeVisible();
            const hint = page.locator('.popup-action-tooltip');
            await expect(hint).toHaveText('Similar titles');
            await expectWithinViewport(page, hint);
            await movePointerTo(page, hint);
            await page.waitForTimeout(200);
            await expect(popup).toBeVisible();
            await expect(title).toBeVisible();
            await expectWithinViewport(page, hint);
            await movePointerTo(page, icon);
            await page.waitForTimeout(200);
            await expect(popup).toBeVisible();
            await expect(title).toBeVisible();
            await expectWithinViewport(page, hint);

            const screenshot = `test-results/cw-preview-${viewport.width}.png`;
            await page.screenshot({ path: screenshot });
            await testInfo.attach('Continue Watching preview', {
                path: screenshot,
                contentType: 'image/png',
            });
            await page.keyboard.press('Escape');
            await expect(popup).toHaveCount(0);
            await expect(hint).toHaveCount(0);
        });
    });
}
