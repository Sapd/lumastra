// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';
import { expectHydrated } from './helpers/hydration';
import { musicTrackFromCard } from '../src/lib/utils/music-track';

test('finished desk uses page scrolling while the Home dock stays compact', async ({ page }) => {
    const tracks = Array.from({ length: 20 }, (_, index) =>
        musicTrackFromCard({
            id: `e2e11111-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            title:
                index === 2
                    ? 'A long song title that wraps comfortably on a narrow screen'
                    : `Result song ${index + 1}`,
            artists: [{ id: null, title: 'Sample artist' }],
            durationMs: 180000,
        }),
    );
    await page.addInitScript((seed) => {
        localStorage.setItem(
            'lumastra:music-alchemy:v3',
            JSON.stringify({
                seedTracks: [seed],
                avoidTracks: [],
                energy: 0.5,
                tempo: 0.5,
                obscurity: 0.5,
                dockCollapsed: false,
            }),
        );
    }, tracks[0]);
    await page.route('**/api/music/alchemy/brew', async (route) => {
        await route.fulfill({
            json: {
                tracks,
                totalDurationMs: 3600000,
                moodAnchors: [
                    { label: 'happy', x: 0.5, y: 0.2, size: 12, color: '#f59e0b' },
                    { label: 'party', x: 0.5, y: 0.8, size: 8, color: '#ec4899' },
                ],
            },
        });
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoHydrated(page, '/music/alchemy');
    await page.getByRole('button', { name: 'Brew mix', exact: true }).click();
    const result = page.getByRole('region', { name: 'Brew result', exact: true });
    const list = result.getByRole('list', { name: 'Brewed tracks' });
    await expect(list.getByRole('listitem')).toHaveCount(20);
    await expect(result.getByText('Happy', { exact: true })).toBeVisible();
    await expect(page.locator('.mixing-desk canvas')).toHaveCount(0);

    for (const width of [1280, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await expect
            .poll(() =>
                list.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight)),
            )
            .toBeLessThan(1);
        expect(await list.evaluate((element) => element.clientHeight)).toBeGreaterThan(256);
        expect(
            await page
                .locator('.mixing-desk')
                .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
    }

    // Client-side navigation preserves the shared, ephemeral brewed result.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page
        .getByRole('navigation', { name: 'Music navigation' })
        .getByRole('link', { name: 'Home', exact: true })
        .click();
    await expect(page).toHaveURL(/\/music$/);
    await expectHydrated(page);
    const dockList = page.locator('.dock-ticket').getByRole('list', { name: 'Brewed tracks' });
    await expect(dockList.getByRole('listitem')).toHaveCount(20);
    await expect
        .poll(() => dockList.evaluate((element) => element.scrollHeight - element.clientHeight))
        .toBeGreaterThan(0);
    expect(await dockList.evaluate((element) => element.clientHeight)).toBeLessThanOrEqual(256);
});
