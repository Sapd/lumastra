// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';
import { ensureSeededMusicStreamable, SEEDED_MUSIC_TRACK } from './helpers/music-fixture';

test.describe('Music Channels UI', () => {
    // A fresh database loses the seeded tracks' file link to the first library
    // scan; the channel's first track then 404s. See helpers/music-fixture.ts.
    test.beforeAll(async () => {
        await ensureSeededMusicStreamable();
    });

    test('radio page mood chip starts a channel', async ({ page }) => {
        // The real cold start (POST /api/music/recommendations with a mood seed) only picks tracks that
        // have an audio embedding and run at least 60 s; the two seeded fixture tracks
        // have neither, so it answers 404 and nothing would play. That endpoint has its
        // own API specs: this one is about the chip starting playback, so hand the
        // page the seeded track the way the endpoint would.
        let bootstrapMood: string | null = null;
        await page.route('**/api/music/recommendations**', async (route) => {
            const body = route.request().postDataJSON() as {
                seed?: { type: string; mood?: string };
                context?: { currentTrackId?: string };
            } | null;
            // Only the cold start (no current track) is faked; the follow-up
            // queue top-ups go to the real endpoint.
            if (body?.context?.currentTrackId) {
                await route.fallback();
                return;
            }
            bootstrapMood = body?.seed?.mood ?? null;
            await route.fulfill({
                json: {
                    alternatives: [],
                    source: 'mood',
                    next: SEEDED_MUSIC_TRACK,
                },
            });
        });
        await page.goto('/music/radio');
        // The chip handler is attached on hydration; an earlier click does nothing.
        await expectHydrated(page);

        const moodChip = page.locator('button:has-text("Chill")').first();
        if ((await moodChip.count()) === 0) {
            test.skip();
            return;
        }

        await moodChip.click();

        // Mini-player should appear (music playing). `.fixed.bottom-0` used to match
        // the music bottom nav (hidden on desktop) instead; the player is `.mini-player`.
        await expect(page.locator('.mini-player')).toBeVisible({ timeout: 8000 });
        expect(bootstrapMood).toBe('chill');
    });

    test('genre card starts a genre channel', async ({ page }) => {
        await page.goto('/music/radio');

        // Genre cards appear only if library has genres with 3+ tracks
        const genreCard = page.locator('button:has-text("tracks")').first();
        if ((await genreCard.count()) === 0) {
            test.skip();
            return;
        }

        await genreCard.click();

        await expect(page.locator('.mini-player')).toBeVisible({ timeout: 8000 });
    });

    test('artist page Start Radio button is visible', async ({ page }) => {
        await page.goto('/music/artists');

        const artistLink = page.locator('a[href*="/music/artists/"]').first();
        if ((await artistLink.count()) === 0) {
            test.skip();
            return;
        }

        await artistLink.click();
        await page.waitForURL(/\/music\/artists\//);

        const radioButton = page.locator('button:has-text("Start Radio")');
        await expect(radioButton).toBeVisible({ timeout: 5000 });
    });

    test('album page Start Radio button is visible', async ({ page }) => {
        await page.goto('/music/albums');

        const albumLink = page.locator('a[href*="/music/albums/"]').first();
        if ((await albumLink.count()) === 0) {
            test.skip();
            return;
        }

        await albumLink.click();
        await page.waitForURL(/\/music\/albums\//);

        const radioButton = page.locator('button:has-text("Start Radio")');
        await expect(radioButton).toBeVisible({ timeout: 5000 });
    });

    test('music home mood chips are present and clickable', async ({ page }) => {
        await page.goto('/music');

        // Mood chips rendered from moodChips server data
        const chips = page.locator('.flex.flex-wrap button');
        const count = await chips.count();
        if (count === 0) {
            test.skip();
            return;
        }

        // Verify at least one chip is visible
        await expect(chips.first()).toBeVisible();
    });
});
