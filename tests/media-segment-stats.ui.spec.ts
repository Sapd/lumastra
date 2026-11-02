// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';
import type { Page } from '@playwright/test';

const CONFIG_HASH = 'config-hash-must-never-render';

const populatedStats = {
    type: 'Outro',
    bucketSeconds: 15,
    histogram: [
        { method: 'chromaprint', bucketStart: 15, items: 4 },
        { method: 'chromaprint', bucketStart: 45, items: 1 },
        { method: 'chapter-mark', bucketStart: 30, items: 2 },
    ],
    summary: [
        {
            method: 'chromaprint',
            items: 4,
            p50: 45,
            p90: 120,
            p99: 180,
            maxSeconds: 240,
            snappedToChapter: 1,
        },
        {
            method: 'chapter-mark',
            items: 2,
            p50: 30,
            p90: 45,
            p99: 60,
            maxSeconds: 60,
            snappedToChapter: 2,
        },
    ],
    configCohorts: [
        {
            configHash: CONFIG_HASH,
            detectorVersion: 3,
            items: 6,
            methods: 2,
            oldest: '2026-07-01T00:00:00.000Z',
            newest: '2026-07-31T00:00:00.000Z',
        },
    ],
    repairBacklog: {
        minLengthSeconds: 90,
        items: 2,
        lengths: [{ bucketStart: 90, items: 2 }],
    },
};

async function stubStats(page: Page, response: object | null, status = 200): Promise<string[]> {
    const requests: string[] = [];
    await page.route(/\/api\/admin\/media-segments\/stats(?:\?.*)?$/, async (route) => {
        const url = new URL(route.request().url());
        requests.push(url.search);
        if (response === null) {
            await route.fulfill({
                status,
                contentType: 'application/problem+json',
                json: {
                    code: 'dependency_unavailable',
                    detail: 'Could not load segment statistics.',
                },
            });
        } else {
            await route.fulfill({ status, contentType: 'application/json', json: response });
        }
    });
    return requests;
}

async function openStatsPage(page: Page): Promise<void> {
    // `/admin/library` forwards to the section's landing page (Media, or
    // Sources while no library has files). Segment stats is listed as a sub-page
    // of the Library section in the full sidebar (>= 1280px, the Desktop Chrome
    // default); below that width it is in the section tab row instead.
    await gotoHydrated(page, '/admin/library');
    await expect(page).toHaveURL(/\/admin\/library\/[a-z-]+$/);
    const sidebar = page.getByRole('navigation', { name: 'Admin sections' });
    const link = sidebar.locator('#admin-nav-pages-library').getByRole('link', {
        name: 'Segment stats',
    });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/admin\/library\/segment-stats$/);
}

test.describe('admin media segment stats', () => {
    test('library navigation opens the page and fills sparse histogram intervals', async ({
        page,
    }) => {
        await stubStats(page, populatedStats);
        await openStatsPage(page);
        await expect(page.getByRole('heading', { name: 'Media segment stats' })).toBeVisible();
        await expect(page.getByRole('cell', { name: 'chromaprint' })).toBeVisible();
        // SQL returns only non-empty GROUP BY buckets. The page must restore the
        // missing x-axis intervals instead of compressing 15s, 30s and 45s
        // together as adjacent bars.
        // Bars are titled "<from>–<to> · <n> items"; chromaprint and chapter-mark
        // are both empty at 0–15s, and only chromaprint is empty at 30–45s.
        await expect(page.locator('[title="0s–15s · 0 items"]')).toHaveCount(2);
        await expect(page.locator('[title="30s–45s · 0 items"]')).toHaveCount(1);
        await expect(page.getByText('Cohort 1')).toBeVisible();
        await expect(page.getByText(CONFIG_HASH, { exact: false })).toHaveCount(0);
    });

    test('changing type and bucket width reloads the endpoint with selected parameters', async ({
        page,
    }) => {
        const requests = await stubStats(page, populatedStats);
        await openStatsPage(page);
        await expect.poll(() => requests.length).toBeGreaterThan(0);
        await expect(page.getByText('Detector summary')).toBeVisible();

        await page.getByLabel('Segment type').selectOption('Intro');
        await page.getByLabel('Bucket width (seconds)').fill('30');
        await page.getByLabel('Bucket width (seconds)').press('Tab');

        await expect.poll(() => requests.at(-1)).toContain('type=Intro');
        await expect.poll(() => requests.at(-1)).toContain('bucketSeconds=30');
    });

    test('an older filter response cannot overwrite the latest selection', async ({ page }) => {
        const requestedTypes: string[] = [];
        await page.route(/\/api\/admin\/media-segments\/stats(?:\?.*)?$/, async (route) => {
            const type = new URL(route.request().url()).searchParams.get('type') ?? 'Outro';
            requestedTypes.push(type);
            if (type === 'Intro') await new Promise((resolve) => setTimeout(resolve, 250));
            const method =
                type === 'Intro' ? 'blackframe' : type === 'Preview' ? 'manual' : 'cohort';
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                json: {
                    ...populatedStats,
                    type,
                    histogram: [{ method, bucketStart: 15, items: 1 }],
                    summary: [
                        {
                            method,
                            items: 1,
                            p50: 15,
                            p90: 15,
                            p99: 15,
                            maxSeconds: 15,
                            snappedToChapter: 0,
                        },
                    ],
                    repairBacklog: type === 'Outro' ? populatedStats.repairBacklog : null,
                },
            });
        });
        await openStatsPage(page);
        await expect(page.getByRole('cell', { name: 'cohort', exact: true })).toBeVisible();

        await page.getByLabel('Segment type').selectOption('Intro');
        await expect.poll(() => requestedTypes).toContain('Intro');
        await page.getByLabel('Segment type').selectOption('Preview');

        await expect(page.getByRole('cell', { name: 'manual', exact: true })).toBeVisible();
        await page.waitForTimeout(300);
        await expect(page.getByRole('cell', { name: 'blackframe', exact: true })).toHaveCount(0);
    });

    test('an extreme duration is downsampled to a bounded number of bars', async ({ page }) => {
        await stubStats(page, {
            ...populatedStats,
            bucketSeconds: 1,
            histogram: [{ method: 'manual', bucketStart: 1_000_000, items: 1 }],
            summary: [
                {
                    method: 'manual',
                    items: 1,
                    p50: 1_000_000,
                    p90: 1_000_000,
                    p99: 1_000_000,
                    maxSeconds: 1_000_000,
                    snappedToChapter: 0,
                },
            ],
        });
        await openStatsPage(page);

        const histogram = page.locator('section').first();
        await expect(histogram.locator('[title]')).toHaveCount(300);
        await expect(page.getByRole('cell', { name: 'manual', exact: true })).toBeVisible();
    });

    test('empty data shows the no-candidates state', async ({ page }) => {
        const requests = await stubStats(page, {
            ...populatedStats,
            histogram: [],
            summary: [],
            configCohorts: [],
            repairBacklog: null,
        });
        await openStatsPage(page);
        await expect.poll(() => requests.length).toBeGreaterThan(0);

        await expect(page.getByText('No candidates for this segment type.')).toBeVisible();
        await expect(page.getByText('No configuration cohorts recorded.')).toBeVisible();
    });

    test('endpoint failure shows the retry state', async ({ page }) => {
        await stubStats(page, null, 503);
        await openStatsPage(page);

        await expect(page.getByText('Could not load segment statistics.')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    });
});
