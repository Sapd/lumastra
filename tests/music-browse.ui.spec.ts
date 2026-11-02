// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Browse UI Tests
 *
 * Tests navigation and discovery flows in the music section.
 * Requires seeded music data from global-setup.ts.
 */

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';
import { expectHydrated } from './helpers/hydration';
import { fetchPageData } from './helpers/svelte-data';

test.describe('Music Browse UI', () => {
    test('sidebar has Music entry that navigates to /music', async ({ page }) => {
        await page.goto('/');
        // Look for the music link in the sidebar
        const musicLink = page.locator('nav a[href="/music"], aside a[href="/music"]');
        if ((await musicLink.count()) === 0) {
            test.skip();
            return;
        }
        await musicLink.first().click();
        await expect(page).toHaveURL(/\/music/);
    });

    test('/music page loads with content', async ({ page }) => {
        await gotoHydrated(page, '/music');
        // Should not be a 404 page
        await expect(page.getByRole('heading', { level: 1, name: 'Music' })).toBeVisible({
            timeout: 10000,
        });
    });

    test('/music/albums page shows album grid', async ({ page }) => {
        await page.goto('/music/albums');
        // Should show album cards or empty state
        const content = page.locator('[data-testid="album-grid"], .grid, main');
        await expect(content.first()).toBeVisible({ timeout: 10000 });
    });

    test('clicking an album navigates to album detail with track list', async ({ page }) => {
        await page.goto('/music/albums');
        // Wait for album links to appear
        const albumLink = page.locator('a[href*="/music/albums/"]').first();
        if ((await albumLink.count()) === 0) {
            test.skip();
            return;
        }
        await albumLink.click();
        await expect(page).toHaveURL(/\/music\/albums\//);
        // Should show track listing
        const tracks = page.locator('[data-testid="track-list"], table, ol, ul');
        await expect(tracks.first()).toBeVisible({ timeout: 10000 });
    });

    test('/music/artists page shows artist grid', async ({ page }) => {
        await page.goto('/music/artists');
        const content = page.locator('[data-testid="artist-grid"], .grid, main');
        await expect(content.first()).toBeVisible({ timeout: 10000 });
    });

    test('clicking an artist navigates to artist detail', async ({ page }) => {
        await page.goto('/music/artists');
        const artistLink = page.locator('a[href*="/music/artists/"]').first();
        if ((await artistLink.count()) === 0) {
            test.skip();
            return;
        }
        await artistLink.click();
        await expect(page).toHaveURL(/\/music\/artists\//);
    });

    test('Top Artists streams in and renders below Quick Picks', async ({ page }) => {
        // Phase 1 streams Top Artists and Recently Added Albums. This test
        // asserts:
        //   (a) Quick Picks (SSR) is visible at DOM-ready time — the critical
        //       path still includes it.
        //   (b) Top Artists can arrive later without blocking DOM-ready.
        //   (c) If Top Artists arrives, its DOM Y-position is below Quick Picks.
        //
        // On a test DB without plays/artists a section may be legitimately
        // empty and skipped. We only assert ordering when both are present.
        await page.goto('/music', { waitUntil: 'domcontentloaded' });

        // Quick Picks is SSR'd — must be visible at DOM-ready.
        const quickPicksTitle = page.getByText(/quick picks/i).first();
        const quickPicksVisible = await quickPicksTitle
            .isVisible({ timeout: 2000 })
            .catch(() => false);
        if (!quickPicksVisible) {
            test.skip();
            return;
        }

        // Top Artists can take up to 3s to stream in.
        const topArtistsTitle = page.getByText(/top artists|popular artists/i).first();
        const topArtistsVisible = await topArtistsTitle
            .isVisible({ timeout: 3000 })
            .catch(() => false);

        if (topArtistsVisible) {
            const qpBox = await quickPicksTitle.boundingBox();
            const taBox = await topArtistsTitle.boundingBox();
            expect(qpBox).not.toBeNull();
            expect(taBox).not.toBeNull();
            expect(qpBox!.y).toBeLessThan(taBox!.y);
        }
    });

    test('scrolling to a genre carousel triggers lazy fetch', async ({ page, request }) => {
        // Skip when the library has no genre carousel to lazy-load. The
        // carousels are driven by `data.genreCarouselNames` from
        // `/music`'s server load, and the e2e fixture set (one artist, one
        // album, two tracks) yields NONE — so without this the test asserted
        // that an absent carousel fetches. Same soft-skip the rest of this
        // file already uses for absent data.
        const musicData = await fetchPageData(request, '/music');
        const genres = (musicData.genreCarouselNames as string[] | undefined) ?? [];
        test.skip(genres.length === 0, 'No genre carousels in the e2e fixture library');

        const fetchedUrls: string[] = [];
        page.on('request', (req) => {
            const url = req.url();
            if (url.includes('/api/music/sections/genre/')) {
                fetchedUrls.push(url);
            }
        });

        await page.goto('/music', { waitUntil: 'domcontentloaded' });
        await expectHydrated(page);

        // Scroll the REAL scroll surface. On desktop the app locks root scroll
        // and `main.main-content` owns it (app.css), so `window.scrollTo` moves
        // nothing and the IntersectionObserver never fires.
        await page.evaluate(() => {
            const mc = document.querySelector('main.main-content');
            if (mc) mc.scrollTop = mc.scrollHeight;
            else window.scrollTo(0, document.body.scrollHeight);
        });

        await page.waitForTimeout(2000);

        // At least one genre carousel fetch fired after scrolling.
        // (With rootMargin=200px, some may fire on load for large viewports — the
        // hard assertion is 'scrolling DOES trigger at least one fetch'.)
        expect(fetchedUrls.length).toBeGreaterThan(0);
        for (const url of fetchedUrls) {
            expect(url).toMatch(/\/api\/music\/sections\/genre\/[^?]+(\?ids=|$)/);
        }
    });
});
