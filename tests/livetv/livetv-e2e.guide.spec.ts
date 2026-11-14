// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Locator, Page } from '@playwright/test';
import { test, expect, missingFfmpeg, ffmpegSkipReason } from './fixtures';
import { expectHydrated } from '../helpers/hydration';
import { baseURL, identityHeaders } from './env';
import { fixtureState, api, json } from './harness';
import type { LiveTvStationDetail } from '../../src/lib/schemas/livetv';

function programButton(page: Page, title: string): Locator {
    // Guide blocks are labelled "<channel>: <title> (<start> – <end>)".
    return page.getByRole('button', { name: new RegExp(`: ${title} \\(`) });
}

test.describe('Live TV guide programme details @livetv', (): void => {
    test.skip(missingFfmpeg, ffmpegSkipReason);

    test('a guide programme opens its detail panel; "Watch now" only while it airs', async ({
        browser,
        actors,
    }, testInfo): Promise<void> => {
        await json(
            await actors.alice.request.patch(`${api}/simple-mode`, {
                data: { enabled: false, stationIds: [], clearStartStation: true },
            }),
        );
        const news = fixtureState().stations.find((station) =>
            station.name.startsWith('News One'),
        )!;
        const { nowNext } = await json<LiveTvStationDetail>(
            await actors.alice.request.get(`${api}/stations/${news.id}`),
        );
        expect(nowNext.current, 'the synthetic guide covers now').toBeTruthy();
        expect(nowNext.next, 'the synthetic guide has a next airing').toBeTruthy();
        const current = nowNext.current!;
        const next = nowNext.next!;

        const context = await browser.newContext({
            baseURL,
            extraHTTPHeaders: identityHeaders('alice'),
            locale: 'en-US',
            viewport: { width: 1280, height: 800 },
        });
        try {
            const page = await context.newPage();
            await page.goto('/livetv/guide');
            await expectHydrated(page);

            // Upcoming airing: information only, no tune button.
            await programButton(page, next.title).click();
            const upcoming = page.getByRole('dialog');
            await expect(upcoming.getByRole('heading', { name: next.title })).toBeVisible();
            await expect(upcoming.getByText(/^Starts in \d+ min$/)).toBeVisible();
            await expect(upcoming.getByRole('button', { name: 'Watch now' })).toHaveCount(0);
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog')).toHaveCount(0);

            // Live airing: channel, slot, progress, description, Watch now.
            const block = programButton(page, current.title);
            await block.click();
            const panel = page.getByRole('dialog');
            await expect(panel.getByRole('heading', { name: current.title })).toBeVisible();
            await expect(panel.getByText(news.name, { exact: false }).first()).toBeVisible();
            await expect(panel.getByText(/^Today · .+ · 30 min$/)).toBeVisible();
            await expect(panel.getByRole('progressbar')).toBeVisible();
            await expect(panel.getByText('A synthetic test programme.')).toBeVisible();
            await expect(panel.getByRole('button', { name: 'Watch now' })).toBeVisible();
            await page.screenshot({ path: testInfo.outputPath('programme-details-desktop.png') });

            await page.setViewportSize({ width: 390, height: 844 });
            await expect(panel.getByRole('button', { name: 'Watch now' })).toBeInViewport();
            await page.screenshot({ path: testInfo.outputPath('programme-details-mobile.png') });
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog')).toHaveCount(0);

            // Keyboard: Enter opens the panel, Esc closes it and focus returns
            // to the programme; Enter again, then "Watch now" tunes the channel.
            // (A mouse press doesn't focus the block: the guide's drag-to-pan
            // handler prevents it, so focus return is a keyboard concern.)
            await block.focus();
            await page.keyboard.press('Enter');
            await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(current.title);
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog')).toHaveCount(0);
            await expect(block).toBeFocused();

            await page.keyboard.press('Enter');
            await page.getByRole('dialog').getByRole('button', { name: 'Watch now' }).click();
            await expect(page).toHaveURL(new RegExp(`/watch/${news.id}(?:\\?|$)`));
            await expect(page.locator('video').first()).toBeVisible();
        } finally {
            await context.close();
        }
    });
});
