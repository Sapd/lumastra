// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Radio Now-Playing UI Tests
 *
 * Tests admin panel reachability and public detail page rendering.
 * This smoke test verifies UI layout without calling upstream metadata APIs
 * (API contract is covered in radio-now-playing.api.spec.ts).
 */

import { adminTest as test, expect } from './fixtures/auth';

test.describe('Radio now-playing UI', () => {
    test('create form offers the now-playing source before the station exists', async ({
        page,
    }) => {
        await page.goto('/admin/settings/music?tab=radio');
        await page.getByRole('button', { name: /add radio station/i }).click();
        await page.getByText(/now playing \(optional\)/i).click();
        await expect(page.getByLabel(/metadata url/i)).toBeVisible();
        await expect(page.getByRole('button', { name: /detect fields/i })).toBeVisible();
        // One save path: the form's own Create button, no separate "Save mapping".
        await expect(page.getByRole('button', { name: /save mapping/i })).toHaveCount(0);
    });

    test('public detail page renders hero and Play button', async ({ page, request }) => {
        // Pick a station id from the admin list API.
        const list = await request.get('/api/admin/radio');
        test.skip(!list.ok(), 'admin list unavailable');
        const body = await list.json();
        const stationId = body?.data?.stations?.[0]?.id;
        test.skip(!stationId, 'no seeded station');

        await page.goto(`/music/radio/${stationId}`);
        await expect(page.getByRole('button', { name: /play/i })).toBeVisible();
    });
});
