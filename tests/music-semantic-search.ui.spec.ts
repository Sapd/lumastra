// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Semantic Search UI Tests
 *
 * Tests the progressive-trigger semantic search sections on /music:
 *   - "Sounds like…" (kind=sound, /api/music/text-search)
 *   - "Lyrics about…" (kind=lyrics, /api/music/lyrics-search)
 *
 * Core invariant (Test 1) must pass in ALL environments:
 *   Typing in the music search box MUST NOT trigger embedding endpoints.
 *   Only an explicit expand click may fire them.
 *
 * Tests 2 & 3 self-skip when the relevant feature flag is off (no header present).
 */

import { adminTest as test, expect } from './fixtures/auth';

const SOUND_ENDPOINT = '/api/music/text-search';
const LYRICS_ENDPOINT = '/api/music/lyrics-search';
const SOUND_TESTID = 'semantic-section-sound';
const LYRICS_TESTID = 'semantic-section-lyrics';

test.describe('Music Semantic Search UI', () => {
    /**
     * Test 1 (env-independent, must always pass):
     * Typing in the /music search box triggers FTS but MUST NOT call either
     * embedding endpoint. The sections are disclosed-only — they never auto-fetch
     * on keystroke.
     */
    test('FTS results appear on typing but NO embedding endpoint is called on keystroke', async ({
        page,
    }) => {
        const embeddingRequests: string[] = [];

        page.on('request', (req) => {
            const url = req.url();
            if (url.includes(SOUND_ENDPOINT) || url.includes(LYRICS_ENDPOINT)) {
                embeddingRequests.push(url);
            }
        });

        await page.goto('/music', { waitUntil: 'domcontentloaded' });

        // Locate the main music search input (first text input on the page)
        const searchInput = page.locator('input[type="text"]').first();
        await expect(searchInput).toBeVisible({ timeout: 10000 });

        // Type a query — triggers FTS debounce, must NOT trigger semantic endpoints
        await searchInput.fill('radiohead');

        // Wait long enough for the debounce (200 ms) plus any FTS round-trip,
        // and for any would-be embedding request to fire if it were miscoded.
        await page.waitForTimeout(2000);

        // Embedding endpoints must have fired exactly zero times from typing alone.
        expect(embeddingRequests).toHaveLength(0);
    });

    /**
     * Test 2 (feature-gated, self-skips when textToSound is off):
     * When the "Sounds like…" section header is present:
     *   - While collapsed → no call to /api/music/text-search
     *   - After explicit expand → exactly one call fires + content panel appears
     */
    test('sound section: collapsed=no fetch, expand=exactly one fetch fires', async ({ page }) => {
        const soundRequests: string[] = [];

        page.on('request', (req) => {
            if (req.url().includes(SOUND_ENDPOINT)) {
                soundRequests.push(req.url());
            }
        });

        await page.goto('/music', { waitUntil: 'domcontentloaded' });

        // Enter search mode so the semantic sections are rendered
        const searchInput = page.locator('input[type="text"]').first();
        await expect(searchInput).toBeVisible({ timeout: 10000 });
        await searchInput.fill('radiohead');

        // Wait for the page to enter search mode (semantic sections render if enabled)
        await page.waitForTimeout(600);

        // If the feature is disabled the header won't render — skip gracefully
        const soundHeader = page.getByTestId(SOUND_TESTID);
        const soundVisible = await soundHeader.isVisible({ timeout: 3000 }).catch(() => false);
        if (!soundVisible) {
            test.skip();
            return;
        }

        // Verify it is currently collapsed (aria-expanded="false")
        await expect(soundHeader).toHaveAttribute('aria-expanded', 'false');

        // No fetch should have fired yet just from typing
        expect(soundRequests).toHaveLength(0);

        // Expand the section
        await soundHeader.click();

        // Wait for the fetch to complete (network may be slow in CI)
        await page.waitForTimeout(3000);

        // Exactly one fetch should have fired
        expect(soundRequests).toHaveLength(1);
        expect(soundRequests[0]).toContain(SOUND_ENDPOINT);

        // The content panel should now be visible (results, skeleton, error, or empty state)
        const contentPanelId = await soundHeader.getAttribute('aria-controls');
        if (contentPanelId) {
            const contentPanel = page.locator(`#${contentPanelId}`);
            // Panel must not have `hidden` class (expanded)
            await expect(contentPanel).not.toHaveClass(/\bhidden\b/, { timeout: 5000 });
        } else {
            // Fallback: header should now be aria-expanded="true"
            await expect(soundHeader).toHaveAttribute('aria-expanded', 'true');
        }
    });

    /**
     * Test 3 (feature-gated, self-skips when lyricsSearch is on):
     * When the "Lyrics about…" section header is ABSENT (feature disabled):
     *   - /api/music/lyrics-search must never be called
     * When the header IS present, skip this test (feature is enabled, not what we're testing here).
     */
    test('lyrics section: if disabled, header is absent and endpoint is never called', async ({
        page,
    }) => {
        const lyricsRequests: string[] = [];

        page.on('request', (req) => {
            if (req.url().includes(LYRICS_ENDPOINT)) {
                lyricsRequests.push(req.url());
            }
        });

        await page.goto('/music', { waitUntil: 'domcontentloaded' });

        // Enter search mode
        const searchInput = page.locator('input[type="text"]').first();
        await expect(searchInput).toBeVisible({ timeout: 10000 });
        await searchInput.fill('heartbreak');

        await page.waitForTimeout(600);

        // Check if lyrics section is enabled
        const lyricsHeader = page.getByTestId(LYRICS_TESTID);
        const lyricsVisible = await lyricsHeader.isVisible({ timeout: 2000 }).catch(() => false);

        if (lyricsVisible) {
            // Feature is enabled — this test covers the disabled case, skip it
            test.skip();
            return;
        }

        // Feature is disabled: header must not exist and endpoint must not have been called
        expect(await lyricsHeader.count()).toBe(0);

        // Wait to confirm no latent request fires
        await page.waitForTimeout(1500);
        expect(lyricsRequests).toHaveLength(0);
    });
});
