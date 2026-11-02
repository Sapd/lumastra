// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';
import { expectServerFeature } from './helpers/server-features';
import { UpcomingCalendarItemSchema } from '../src/lib/schemas/api-recommender-responses';
import { paginatedEnvelope } from '../src/lib/schemas/pagination';

test('calendar groups a season release and exposes every episode on hover and focus', async ({
    page,
}) => {
    // The calendar widget sits below the fold and is mounted lazily when it
    // scrolls into view (LazyMount), so the viewport must be tall enough to show
    // it without scrolling. It also exists only when `features.calendar` is on,
    // which needs Sonarr or Radarr configured on the server (the e2e server gets
    // a placeholder SONARRURL; no request ever leaves for it, /api/calendar is
    // stubbed below).
    await expectServerFeature(
        page,
        'calendar',
        'set SONARRURL (any value; the calendar response is stubbed) in the Playwright web server env',
    );
    await page.setViewportSize({ width: 1440, height: 2400 });
    const releaseDate = new Date();
    releaseDate.setHours(12, 0, 0, 0);
    await page.addInitScript(() => {
        localStorage.setItem('lumastra:calendar-view', 'week');
        localStorage.setItem('calendar-week-style', 'compact');
        localStorage.setItem('calendar-collapsed', 'false');
    });
    await page.route(/\/api\/(?:calendar|v1\/upcoming)(?:\?|$)/, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/upcoming') && url.searchParams.get('view') !== 'calendar') {
            await route.continue();
            return;
        }
        await route.fulfill({
            json: paginatedEnvelope(UpcomingCalendarItemSchema).parse({
                items: Array.from({ length: 10 }, (_, i) => ({
                    title: `Episode ${10 - i}`,
                    id: 'tmdb:900000:series',
                    catalogId: null,
                    type: 'episode',
                    ids: {},
                    images: {},
                    context: {
                        series: {
                            id: 'tmdb:900000:series',
                            catalogId: null,
                            title: 'Calendar season release',
                        },
                        seasonNumber: 2,
                        episodeNumber: 10 - i,
                        airDate: releaseDate.toISOString(),
                    },
                    monitored: true,
                    hasFile: false,
                })),
                page: { limit: 500, offset: 0, hasMore: false },
            }),
        });
    });
    await gotoHydrated(page, '/');
    const entry = page.locator('.calendar-day-thumb');
    await expect(entry).toHaveCount(1, { timeout: 60_000 });
    await entry.hover();
    const preview = page.getByRole('dialog', { name: /Calendar season release/ });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('button')).toHaveCount(10);
    await expect(preview.getByRole('button').first()).toContainText('S2E1');
    await expect(preview.getByRole('button').last()).toContainText('S2E10');
    await preview.hover();
    await preview.getByRole('button').last().scrollIntoViewIfNeeded();
    await expect(preview.getByRole('button').last()).toBeInViewport();
    await entry.focus();
    await page.keyboard.press('Tab');
    await expect(preview.getByRole('button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(preview).not.toBeVisible();
    await expect(entry).toBeFocused();
    await entry.click();
    await expect(preview).toBeVisible();
    // The interactive episode preview must yield to the right-click actions,
    // even when moving the pointer over the entry schedules another preview.
    await entry.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Calendar season release' });
    await expect(menu).toBeVisible();
    await expect(preview).not.toBeVisible();
    await entry.hover();
    await page.waitForTimeout(250); // longer than the calendar's 150ms hover delay
    await expect(preview).not.toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(1);
    await expect(menu.getByRole('menuitem')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await entry.blur();
    await entry.focus();
    await expect(preview).toBeVisible();
});
