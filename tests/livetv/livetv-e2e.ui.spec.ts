// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect, missingFfmpeg, ffmpegSkipReason } from './fixtures';
import { expectHydrated } from '../helpers/hydration';
import { baseURL, identityHeaders, viewerTimeoutSeconds } from './env';
import { fixtureState, api, json, providerStatus } from './harness';

// Scope to the actual grid: the personalized For You row may repeat stations
// after the API tests record real watches. It must not inflate the card count.
function grid(page: Page): Locator {
    return page.getByRole('group', { name: 'Channel filter', exact: true }).locator('..');
}

async function playing(page: Page): Promise<void> {
    const video = page.locator('video').first();
    await expect(video).toBeVisible();
    await expect
        .poll(
            async (): Promise<number> =>
                video.evaluate((element: HTMLVideoElement): number => element.currentTime),
            {
                timeout: 60_000,
                intervals: [500, 1000],
            },
        )
        .toBeGreaterThan(1);
    const before = await video.evaluate((element: HTMLVideoElement): number => element.currentTime);
    await expect
        .poll(
            async (): Promise<number> =>
                video.evaluate((element: HTMLVideoElement): number => element.currentTime),
            {
                timeout: 15_000,
                intervals: [500],
            },
        )
        .toBeGreaterThan(before + 1);
    expect(
        await video.evaluate(
            (element: HTMLVideoElement): number | null => element.error?.code ?? null,
        ),
    ).toBeNull();
    await expect(page.getByRole('alert')).toHaveCount(0);
}

test.describe('Live TV browser @livetv', (): void => {
    test.skip(missingFfmpeg, ffmpegSkipReason);

    test('four cards, real video, second user stream limit, terminal priority takeover', async ({
        browser,
        actors,
    }, testInfo): Promise<void> => {
        // Browser contexts are separate devices/cookie jars, not just pages with
        // the same cached identity. They still are tabs in this one Chromium run.
        await json(
            await actors.alice.request.patch(`${api}/simple-mode`, {
                data: { enabled: false, stationIds: [], clearStartStation: true },
            }),
        );
        const contexts: BrowserContext[] = [];
        try {
            const aliceContext = await browser.newContext({
                baseURL,
                extraHTTPHeaders: identityHeaders('alice'),
                locale: 'en-US',
            });
            contexts.push(aliceContext);
            const alice = await aliceContext.newPage();
            await alice.goto('/livetv');
            await expectHydrated(alice);
            const cards = grid(alice).getByRole('button', {
                name: /^(News One|Sports Two|Movies Three|Kids Four)(?: HD| SD)?(?: - |$)/,
            });
            await expect(cards).toHaveCount(4);
            const stations = fixtureState().stations;
            const news = stations.find((station) => station.name.startsWith('News One'))!;
            const sports = stations.find((station) => station.name.startsWith('Sports Two'))!;
            await grid(alice)
                .getByRole('button', { name: /^News One(?: - |$)/ })
                .click();
            await expect(alice).toHaveURL(new RegExp(`/watch/${news.id}(?:\\?|$)`));
            await playing(alice);

            const bobContext = await browser.newContext({
                baseURL,
                extraHTTPHeaders: identityHeaders('bob'),
                locale: 'en-US',
            });
            contexts.push(bobContext);
            const bob = await bobContext.newPage();
            await bob.goto('/livetv');
            await expectHydrated(bob);
            await grid(bob)
                .getByRole('button', { name: /^Sports Two(?: - |$)/ })
                .click();
            await expect(bob.getByText('All streams are in use', { exact: true })).toBeVisible();
            expect((await providerStatus()).connections).toBe(1);

            let aliceRejoins = 0;
            alice.on('request', (request): void => {
                if (
                    (request.method() === 'POST' &&
                        /\/livetv\/playback-sessions$/.test(new URL(request.url()).pathname)) ||
                    (request.method() === 'GET' &&
                        /\/livetv\/channels\/[^/]+\/stream\/(?:.*\/)?master\.m3u8$/.test(
                            new URL(request.url()).pathname,
                        ))
                )
                    aliceRejoins++;
            });
            const adminContext = await browser.newContext({
                baseURL,
                extraHTTPHeaders: identityHeaders('admin'),
                locale: 'en-US',
            });
            contexts.push(adminContext);
            const admin = await adminContext.newPage();
            await admin.goto('/livetv');
            await expectHydrated(admin);
            await grid(admin)
                .getByRole('button', { name: /^Sports Two(?: - |$)/ })
                .click();
            await expect(admin).toHaveURL(new RegExp(`/watch/${sports.id}(?:\\?|$)`));
            await playing(admin);
            const evicted = alice.getByRole('alert').filter({
                hasText: 'Your stream was stopped to allow a higher-priority user to watch.',
            });
            await expect(evicted).toBeVisible({ timeout: 30_000 });
            const until = Date.now() + (viewerTimeoutSeconds * 2 + 1) * 1000;
            // Observe for more than two heartbeat intervals. A momentary overlay
            // followed by an automatic rejoin is a regression, even if video stopped.
            await expect
                .poll(
                    async (): Promise<boolean> => {
                        await expect(evicted).toBeVisible();
                        expect(
                            aliceRejoins,
                            'evicted player must require an explicit user action',
                        ).toBe(0);
                        return Date.now() >= until;
                    },
                    { timeout: 40_000, intervals: [1000] },
                )
                .toBe(true);
            expect((await providerStatus()).active).toEqual([
                expect.objectContaining({ id: 'sports-two' }),
            ]);
        } catch (error) {
            for (const [index, context] of contexts.entries()) {
                try {
                    await context
                        .pages()[0]
                        ?.screenshot({ path: testInfo.outputPath(`viewer-${index}.png`) });
                } catch (screenshotError) {
                    console.error('Could not capture Live TV failure screenshot', screenshotError);
                }
            }
            throw error;
        } finally {
            // Playwright's own `trace: retain-on-failure` already traces these contexts.
            for (const context of contexts) await context.close();
        }
    });
});
