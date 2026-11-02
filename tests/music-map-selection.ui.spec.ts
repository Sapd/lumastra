// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { adminTest as test, expect } from './fixtures/auth';
import { SONIC_UI_DEFAULTS, SONIC_UI_FLAGS, setFeatureFlags } from './helpers/feature-flags';

// Needs FEATURE_MUSIC_MAP and FEATURE_MUSIC_SONIC: switched on for this file below.
let restoreFlags: (() => Promise<void>) | undefined;
test.beforeAll(async ({ baseURL }) => {
    restoreFlags = await setFeatureFlags(baseURL, SONIC_UI_FLAGS, SONIC_UI_DEFAULTS);
});
test.afterAll(async () => {
    await restoreFlags?.();
});

test('map tracks can be selected without drawing, previewed, and kept after closing', async ({
    page,
}) => {
    await page.route('**/api/music/map', (route) =>
        route.fulfill({
            json: {
                hasCoords: true,
                points: [
                    {
                        id: '00000000-0000-4000-8000-000000000001',
                        title: 'Map test song',
                        artist: 'Test artist',
                        x: 0.5,
                        y: 0.5,
                        topMood: 'happy',
                        images: {},
                    },
                ],
            },
        }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/music/map');
    await page.getByRole('button', { name: 'Browse tracks', exact: true }).click();
    const canvas = page.locator('canvas');
    await expect
        .poll(async () => (await canvas.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(320);
    expect((await canvas.boundingBox())?.height).toBeLessThanOrEqual(760);
    await page.getByRole('checkbox', { name: 'Map test song Test artist' }).check();
    await page.getByRole('button', { name: 'Preview selection', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Music Map selection', exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Save as playlist' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(preview).not.toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Map test song Test artist' })).toBeChecked();
});
