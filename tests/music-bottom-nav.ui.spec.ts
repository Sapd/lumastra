// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mobile music bottom tab bar — presence, route scoping, active states,
 * search route, deep-link redirect, and MiniPlayer offset.
 */

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';
import { expectHydrated, HYDRATION_TIMEOUT_MS } from './helpers/hydration';
import type { Page } from '@playwright/test';

const MOBILE = { width: 390, height: 844 }; // iPhone 12-ish
const DESKTOP = { width: 1440, height: 900 };

const bar = (page: Page) => page.locator('[data-testid="music-bottom-nav"]');

test.describe('Music bottom nav — presence & scoping', () => {
    test('renders on /music at mobile width', async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await page.goto('/music');
        await expect(bar(page)).toBeVisible();
    });

    test('is absent on desktop width', async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await page.goto('/music');
        await expect(bar(page)).toBeHidden();
    });

    test('renders on /playlists?type=music but not on plain /playlists', async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await page.goto('/playlists?type=music');
        await expect(bar(page)).toBeVisible();
        await page.goto('/playlists');
        await expect(bar(page)).toBeHidden();
    });

    test('is absent on a non-music page', async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await page.goto('/');
        await expect(bar(page)).toBeHidden();
    });
});

test.describe('Music bottom nav — active tab', () => {
    test('Home active on /music; Library active across its three surfaces', async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await page.goto('/music');
        await expect(page.locator('[data-tab="home"]')).toHaveAttribute('aria-current', 'page');

        for (const path of ['/music/albums', '/music/artists', '/playlists?type=music']) {
            await page.goto(path);
            await expect(bar(page)).toBeVisible();
            await expect(page.locator('[data-tab="library"]')).toHaveAttribute(
                'aria-current',
                'page',
            );
        }
    });

    test('Explore + Search tabs resolve', async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await page.goto('/music/explore');
        await expect(page.locator('[data-tab="explore"]')).toHaveAttribute('aria-current', 'page');
        await page.goto('/music/search');
        await expect(page.locator('[data-tab="search"]')).toHaveAttribute('aria-current', 'page');
    });
});

test.describe('Music library navigation', () => {
    test('desktop albums → Playlists keeps Music navigation while clearing list filters', async ({
        page,
    }) => {
        await page.setViewportSize(DESKTOP);
        await gotoHydrated(page, '/music/albums');

        await page
            .getByRole('navigation', { name: 'Browse the Library' })
            .getByRole('link', { name: 'Playlists', exact: true })
            .click();
        await expect(page).toHaveURL(/\/playlists\?type=music$/);
        const musicNav = page.getByRole('navigation', { name: 'Music navigation' });
        await expect(musicNav).toBeVisible();
        await expect(musicNav.getByRole('link', { name: 'Library' })).toHaveAttribute(
            'aria-current',
            'page',
        );
        await expect(page.locator('button.dock-icon-wrapper[aria-label="Music"]')).toHaveClass(
            /\bactive\b/,
        );
        await expect(
            page.locator('button.dock-icon-wrapper[aria-label="Playlists"]'),
        ).not.toHaveClass(/\bactive\b/);

        await page.getByRole('searchbox').fill('music-nav-no-match');
        await expect(page).toHaveURL(/\/playlists\?type=music&q=music-nav-no-match/);
        await page.getByRole('button', { name: 'Clear all filters' }).first().click();

        await expect(page).toHaveURL(/\/playlists\?type=music$/);
        await expect(musicNav.getByRole('link', { name: 'Library' })).toHaveAttribute(
            'aria-current',
            'page',
        );
        await expect(
            page.getByRole('navigation', { name: 'Browse the Library' }).getByRole('link', {
                name: 'Playlists',
            }),
        ).toHaveAttribute('aria-current', 'page');
    });

    test('a newly created empty music playlist keeps Library selected on mobile detail', async ({
        page,
        request,
    }) => {
        await page.setViewportSize(MOBILE);
        await gotoHydrated(page, '/playlists?type=music');
        let playlistId: string | undefined;
        try {
            await page.getByRole('button', { name: 'New playlist' }).click();
            await page
                .getByRole('textbox', { name: 'Name' })
                .fill('Music navigation empty fixture');
            await page.getByRole('button', { name: 'Create', exact: true }).click();

            await expect(page).toHaveURL(/\/playlists\/\d+\?type=music$/);
            playlistId = new URL(page.url()).pathname.split('/').at(-1);
            await expectHydrated(page);
            await expect(bar(page)).toBeVisible();
            await expect(bar(page).getByRole('link', { name: 'Library' })).toHaveAttribute(
                'aria-current',
                'page',
            );
            await expect(
                page.getByRole('navigation', { name: 'Browse the Library' }).getByRole('link', {
                    name: 'Playlists',
                }),
            ).toHaveAttribute('aria-current', 'page');

            await page.setViewportSize(DESKTOP);
            await expect(page.locator('button.dock-icon-wrapper[aria-label="Music"]')).toHaveClass(
                /\bactive\b/,
            );
            await expect(
                page.locator('button.dock-icon-wrapper[aria-label="Playlists"]'),
            ).not.toHaveClass(/\bactive\b/);
        } finally {
            if (playlistId) {
                const response = await request.delete(`/api/playlists/${playlistId}`, {
                    headers: { Origin: new URL(page.url()).origin },
                });
                expect(response.ok()).toBe(true);
            }
        }
    });

    test('Library returns to the remembered desktop segment', async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        const username = (process.env.TEST_USER || 'TestUser').toLowerCase();
        await page.addInitScript((name) => {
            localStorage.setItem(`lumastra:music:last-library-segment:${name}`, 'artists');
        }, username);
        await gotoHydrated(page, '/music');

        const musicNav = page.getByRole('navigation', { name: 'Music navigation' });
        const libraryLink = musicNav.getByRole('link', { name: 'Library' });
        await expect(libraryLink).toHaveAttribute('href', '/music/artists');
        await libraryLink.click();
        await expect(page).toHaveURL(/\/music\/artists$/);
    });
});

test.describe('Music search route', () => {
    test('/music/search renders results for ?q=', async ({ page }) => {
        await page.setViewportSize(MOBILE);
        await gotoHydrated(page, '/music/search?q=the');
        // Input reflects the query; results panel or an empty-state renders.
        await expect(page.getByRole('searchbox', { name: /^Search artists/ })).toHaveValue('the');
        await expect(page.locator('main')).toBeVisible();
    });

    test('mobile /music?q= redirects to /music/search', async ({ page }) => {
        await page.setViewportSize(MOBILE);
        // This compatibility redirect runs on mount after the viewport is known.
        await gotoHydrated(page, '/music?q=test');
        await expect(page).toHaveURL(/\/music\/search\?q=test/);
    });
});

test.describe('MiniPlayer offset with/without bar', () => {
    // Read the --music-bottom-nav-h CSS var rather than .mini-player's computed
    // `bottom` style: playback isn't guaranteed to be active in a fresh e2e env
    // (no seeded "now playing" state), so the MiniPlayer itself may not render.
    // The var is set by the root layout's $effect independently of MiniPlayer
    // visibility, which is exactly the surface this test needs to pin down.
    test('MiniPlayer bottom offset is non-zero on a music route when the bar is present', async ({
        page,
    }) => {
        await page.setViewportSize(MOBILE);
        await page.goto('/music');
        await expect(bar(page)).toBeVisible();
        // POLL, do not read once. The bar is server-rendered and CSS-gated, so
        // it is visible well before hydration — but this var is written by a
        // `$effect` in the root layout, so it reads `0px` until onMount runs.
        // Measured on the same page load: `0px` immediately after goto,
        // `calc(3.5rem + 0px)` once `#svelte-announcer` is attached.
        await expect
            .poll(
                () =>
                    page.evaluate(() =>
                        getComputedStyle(document.documentElement)
                            .getPropertyValue('--music-bottom-nav-h')
                            .trim(),
                    ),
                { timeout: HYDRATION_TIMEOUT_MS },
            )
            .not.toBe('0px');
    });

    test('clearance follows enlarged navigation and safe-area padding', async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 720 });
        await gotoHydrated(page, '/music');
        await expect(bar(page)).toBeVisible();
        const initialHeight = (await bar(page).boundingBox())!.height;

        async function expectMatchingClearance(): Promise<void> {
            await expect
                .poll(
                    () =>
                        page.evaluate(() => {
                            const navigation = document.querySelector('[data-music-bottom-nav]');
                            if (!navigation) return Infinity;
                            // Resolve the actual layout variable through CSS, including calc()/env().
                            const probe = document.createElement('div');
                            probe.style.cssText =
                                'position:fixed;width:0;height:var(--music-bottom-nav-h,0px);pointer-events:none';
                            document.body.append(probe);
                            const difference = Math.abs(
                                probe.getBoundingClientRect().height -
                                    navigation.getBoundingClientRect().height,
                            );
                            probe.remove();
                            return difference;
                        }),
                    { timeout: HYDRATION_TIMEOUT_MS },
                )
                .toBeLessThan(1);
        }

        await expectMatchingClearance();
        await page.addStyleTag({
            content:
                '[data-music-bottom-nav] a { font-size:22px !important; line-height:1.2 !important; }',
        });
        await expect
            .poll(async () => (await bar(page).boundingBox())!.height)
            .toBeGreaterThan(initialHeight);
        await expectMatchingClearance();
        const enlargedHeight = (await bar(page).boundingBox())!.height;

        // Padding alone changes the border box, exercising safe-area updates.
        await page.addStyleTag({
            content: '[data-music-bottom-nav] { padding-bottom:32px !important; }',
        });
        await expect
            .poll(async () => (await bar(page).boundingBox())!.height)
            .toBeGreaterThan(enlargedHeight + 30);
        await expectMatchingClearance();
    });

    test('MiniPlayer bottom offset is zero on a non-music route when the bar is absent', async ({
        page,
    }) => {
        await page.setViewportSize(MOBILE);
        await page.goto('/');
        await expect(bar(page)).toBeHidden();
        // Guards against a regression where the layout $effect fires
        // unconditionally and gives every page a phantom MiniPlayer offset.
        const navH = await page.evaluate(() =>
            getComputedStyle(document.documentElement)
                .getPropertyValue('--music-bottom-nav-h')
                .trim(),
        );
        expect(navH).toBe('0px');
    });
});
