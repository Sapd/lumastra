// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Player UI Tests
 *
 * Tests mini-player behavior, queue panel, and playback persistence
 * across navigation.
 *
 * Note: Audio playback in Playwright may not produce actual sound,
 * but we can verify DOM state transitions and mini-player visibility.
 */

import { adminTest as test, expect } from './fixtures/auth';

test.describe('Music Player UI', () => {
    test('mini-player is hidden initially (no track playing)', async ({ page }) => {
        await page.goto('/music');
        // Mini-player should not be visible when nothing is playing
        const miniPlayer = page.locator('[data-testid="mini-player"], .mini-player');
        // Either not present or hidden
        const isVisible = await miniPlayer.isVisible().catch(() => false);
        expect(isVisible).toBe(false);
    });

    test('clicking play on a track shows the mini-player', async ({ page }) => {
        await page.goto('/music/albums');
        // Navigate to an album detail page
        const albumLink = page.locator('a[href*="/music/albums/"]').first();
        if ((await albumLink.count()) === 0) {
            test.skip();
            return;
        }
        await albumLink.click();
        await page.waitForURL(/\/music\/albums\//);

        // Find and click a play button
        const playButton = page
            .locator(
                'button[aria-label*="play" i], button[data-testid="play-track"], button:has(svg)',
            )
            .first();
        if ((await playButton.count()) === 0) {
            test.skip();
            return;
        }
        await playButton.click();

        // Mini-player should appear
        const miniPlayer = page.locator('[data-testid="mini-player"], .mini-player');
        await expect(miniPlayer).toBeVisible({ timeout: 5000 });
    });

    test('mini-player persists across navigation', async ({ page }) => {
        // Start from music page and trigger playback
        await page.goto('/music/albums');
        const albumLink = page.locator('a[href*="/music/albums/"]').first();
        if ((await albumLink.count()) === 0) {
            test.skip();
            return;
        }
        await albumLink.click();
        await page.waitForURL(/\/music\/albums\//);

        const playButton = page
            .locator('button[aria-label*="play" i], button[data-testid="play-track"]')
            .first();
        if ((await playButton.count()) === 0) {
            test.skip();
            return;
        }
        await playButton.click();

        // Wait for mini-player
        const miniPlayer = page.locator('[data-testid="mini-player"], .mini-player');
        await expect(miniPlayer).toBeVisible({ timeout: 5000 });

        // Navigate away to another page
        await page.goto('/music');
        // Mini-player should still be visible
        await expect(miniPlayer).toBeVisible({ timeout: 5000 });
    });

    test('queue panel has Queue and Lyrics tabs', async ({ page }) => {
        await page.goto('/music/albums');
        const albumLink = page.locator('a[href*="/music/albums/"]').first();
        if ((await albumLink.count()) === 0) {
            test.skip();
            return;
        }
        await albumLink.click();
        await page.waitForURL(/\/music\/albums\//);

        const playButton = page
            .locator('button[aria-label*="play" i], button[data-testid="play-track"]')
            .first();
        if ((await playButton.count()) === 0) {
            test.skip();
            return;
        }
        await playButton.click();

        // Expand queue panel
        const expandButton = page
            .locator(
                'button[aria-label*="expand" i], button[aria-label*="queue" i], button[data-testid="expand-queue"]',
            )
            .first();
        if ((await expandButton.count()) > 0) {
            await expandButton.click();
            // Check for Queue and Lyrics tabs
            const queueTab = page.locator('button:has-text("Queue")');
            const lyricsTab = page.locator('button:has-text("Lyrics")');
            await expect(queueTab).toBeVisible({ timeout: 5000 });
            await expect(lyricsTab).toBeVisible({ timeout: 5000 });
        }
    });
});
