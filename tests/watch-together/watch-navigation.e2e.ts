// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FIXTURE_DIR, LIBRARY_GROUP_ID, MOVIE_FILE } from './wt-seed';
import { expect, type Page } from '@playwright/test';
import { expectHydrated } from '../helpers/hydration';
import { webUrl } from './wt-env';
import { identityHeaders, scenario } from './wt-harness';

async function expectFrame(page: Page): Promise<void> {
    await expect
        .poll(
            () =>
                page.locator('.watch-page video').evaluateAll((videos) => {
                    const video = videos[0] as HTMLVideoElement | undefined;
                    return !!video && video.videoWidth > 0 && video.currentTime > 0;
                }),
            { timeout: 30_000 },
        )
        .toBe(true);
}

// A normal anchor exercises SvelteKit's click interception without depending on
// a particular browse carousel's ordering or involving the movie-detail dialog.
async function enterWatch(page: Page, id: string, suffix = ''): Promise<void> {
    await page.evaluate(
        ({ id, suffix }) => {
            document.getElementById('watch-history-link')?.remove();
            const link = document.createElement('a');
            link.id = 'watch-history-link';
            link.href = `/watch/${id}?t=0${suffix}`;
            link.textContent = 'Open fixture';
            link.style.cssText =
                'position:fixed;top:0;left:0;z-index:999999;background:white;color:black';
            document.body.append(link);
        },
        { id, suffix },
    );
    await page.locator('#watch-history-link').click();
    await expectFrame(page);
}

scenario(
    'watch restores playback through Back and Forward',
    {
        directions: ['A hosts'],
        tag: ['@chromium-only', '@pr'],
    },
    async (s) => {
        for (const width of [1440, 390]) {
            const context = await s.browser.newContext({
                javaScriptEnabled: false,
                extraHTTPHeaders: identityHeaders(s.hostUser),
                viewport: { width, height: 1000 },
            });
            s.onCleanup(() => context.close());
            const page = await context.newPage();
            for (const path of ['/', '/browse']) {
                await page.goto(webUrl() + path);
                await expect(page.locator('.icon-dock')).toHaveCount(1);
                expect(
                    await page
                        .locator('.icon-dock')
                        .evaluate((el) => getComputedStyle(el).position),
                ).toBe('fixed');
                if (width === 1440)
                    expect(
                        await page
                            .locator('.icon-dock')
                            .evaluate((el) => getComputedStyle(el).width),
                    ).toBe('70px');
                expect(
                    await page
                        .locator('main.main-content')
                        .evaluate((el) => getComputedStyle(el).marginLeft),
                ).toBe(width === 1440 ? '70px' : '0px');
            }
            await context.close();
        }
        const movie = await s.movie();
        const alternatePath = join(FIXTURE_DIR, `history-${randomUUID()}.mp4`);
        await copyFile(MOVIE_FILE, alternatePath);
        s.onCleanup(() => rm(alternatePath, { force: true }));
        await s.sql`UPDATE media_file_items SET is_default=true WHERE media_item_id=${movie.id}`;
        const [alternate] = await s.sql<{ id: string }[]>`
            INSERT INTO media_files(file_path) VALUES (${alternatePath}) RETURNING id`;
        await s.sql`INSERT INTO media_file_items(file_id,media_item_id,label,is_default)
            VALUES (${alternate.id},${movie.id},'History alternate',false)`;

        const show = await s.show();

        // Leave a cold root while chrome is still absent. Blocking media (not
        // session cleanup) keeps the first-frame gate closed without a dialog.
        const cold = await s.participant(s.hostUser, 'host-cold-exit');
        let releaseMedia: (() => void) | undefined;
        const mediaGate = new Promise<void>((resolve) => {
            releaseMedia = resolve;
        });
        s.onCleanup(async () => {
            releaseMedia?.();
        });
        await cold.page.route('**/*', async (route) => {
            if (route.request().resourceType() === 'media') await mediaGate;
            await route.continue().catch(() => {});
        });
        await cold.page.goto(`${webUrl()}/watch/${movie.id}?t=0`, {
            waitUntil: 'domcontentloaded',
        });
        await expectHydrated(cold.page);
        await expect(cold.page.locator('.bell-anchor button')).toHaveCount(0);
        const coldToken = await cold.page.evaluate(() => {
            const token = crypto.randomUUID();
            document.documentElement.dataset.watchHistoryDocument = token;
            const link = document.createElement('a');
            link.id = 'cold-exit-link';
            link.href = '/browse';
            link.textContent = 'Browse';
            link.style.cssText =
                'position:fixed;top:0;left:0;z-index:999999;background:white;color:black';
            document.body.append(link);
            return token;
        });
        await cold.page.locator('#cold-exit-link').click();
        await expect(cold.page).toHaveURL(/\/browse(?:\?|$)/);
        await expect(cold.page.locator('.browse-page')).toBeVisible();
        await expect(cold.page.locator('.icon-dock')).toBeVisible();
        expect(
            await cold.page.evaluate(() => document.documentElement.dataset.watchHistoryDocument),
        ).toBe(coldToken);
        releaseMedia?.();
        await cold.page.close();

        for (const item of [movie, show.episodes[0]]) {
            const participant = await s.participant(s.hostUser, `host-${item.id}`);
            const page = participant.page;
            let releasePlayback: (() => void) | undefined;
            s.onCleanup(async () => {
                releasePlayback?.();
            });
            if (item.id === movie.id) {
                const gate = new Promise<void>((resolve) => {
                    releasePlayback = resolve;
                });
                await page.route('**/api/play-sessions', async (route) => {
                    if (route.request().method() === 'POST') await gate;
                    await route.continue();
                });
            }
            await page.goto(`${webUrl()}/watch/${item.id}?t=0`);
            await expectHydrated(page);
            if (releasePlayback) {
                await page.getByRole('button', { name: 'Search', exact: true }).click();
                await expect(page.getByRole('dialog').locator('input').first()).toBeVisible();
                expect(
                    await page
                        .locator('.watch-page video')
                        .evaluate((video) => (video as HTMLVideoElement).videoWidth),
                ).toBe(0);
                await page.keyboard.press('Escape');
                releasePlayback();
            }
            await expectFrame(page);
            await expect(page.locator('.bell-anchor button').first()).toBeAttached();
            // Adding the canonical slug used to erase the router's history indexes.
            await expect.poll(() => new URL(page.url()).searchParams.has('slug')).toBe(true);

            await page.evaluate(() => {
                const link = document.createElement('a');
                link.id = 'leave-cold-watch';
                link.href = '/browse';
                link.textContent = 'Browse';
                link.style.cssText =
                    'position:fixed;top:0;left:0;z-index:999999;background:white;color:black';
                document.body.append(link);
            });
            await page.locator('#leave-cold-watch').click();
            await expect(page).toHaveURL(/\/browse(?:\?|$)/);
            await expect(page.locator('.browse-page')).toBeVisible();
            await expect(page.locator('.icon-dock')).toBeVisible();
            const token = await page.evaluate(() => {
                const token = crypto.randomUUID();
                document.documentElement.dataset.watchHistoryDocument = token;
                return token;
            });
            await enterWatch(page, item.id);
            if (item.id === movie.id) {
                await page.mouse.move(600, 500);
                await page.getByRole('button', { name: 'Video quality', exact: true }).click();
                await page
                    .locator('.version-card')
                    .filter({ hasText: 'History alternate' })
                    .click();
                await expect
                    .poll(() => new URL(page.url()).searchParams.get('fileId'))
                    .toBe(alternate.id);
                await expectFrame(page);
            }

            await page.goBack();
            await expect(page).toHaveURL(/\/browse(?:\?|$)/);
            await expect(page.locator('.browse-page')).toBeVisible();
            await expect(page.locator('.watch-page')).toHaveCount(0);
            await page.goForward();
            await expectFrame(page);
            if (item.id === movie.id) {
                expect(new URL(page.url()).searchParams.get('fileId')).toBe(alternate.id);
            }
            // Also traverse Back into watch, then Forward out of it.
            await page.locator('#watch-history-link').evaluate((link) => {
                link.setAttribute('href', '/browse');
            });
            await page.locator('#watch-history-link').click();
            await expect(page).toHaveURL(/\/browse(?:\?|$)/);
            await expect(page.locator('.browse-page')).toBeVisible();
            await page.goBack();
            await expectFrame(page);
            await page.goForward();
            await expect(page).toHaveURL(/\/browse(?:\?|$)/);
            await expect(page.locator('.browse-page')).toBeVisible();
            await expect(page.locator('.watch-page')).toHaveCount(0);
            expect(
                await page.evaluate(() => document.documentElement.dataset.watchHistoryDocument),
            ).toBe(token);
            await page.close();
        }

        for (const type of ['educational', 'personal', 'home_video']) {
            const participant = await s.participant(s.hostUser, `host-${type}`);
            const page = participant.page;
            const kind = type === 'educational' ? 'educational' : 'personal';
            await page.goto(`${webUrl()}/browse`);
            await expectHydrated(page);
            await enterWatch(page, show.episodes[0].id, `&ctx=${kind}&col=${show.showId}`);
            await expect(page.locator(`.${kind}-shell`)).toHaveCount(0);
            await page
                .locator('#watch-history-link')
                .evaluate((link) => link.setAttribute('href', '/browse'));
            await page.locator('#watch-history-link').click();
            await expect(page).toHaveURL(/\/browse(?:\?|$)/);
            await expect(page.locator('.browse-page')).toBeVisible();
            const [library] = await s.sql<{ id: string }[]>`
                INSERT INTO library_paths(path,media_type,library_group_id,enabled)
                VALUES (${join(FIXTURE_DIR, randomUUID())},${type},${LIBRARY_GROUP_ID},true)
                RETURNING id`;
            s.onCleanup(async () => {
                await s.sql`DELETE FROM library_paths WHERE id=${library.id}`;
            });
            try {
                await enterWatch(page, show.episodes[0].id, `&ctx=${kind}&col=${show.showId}`);
                await expect(page.locator(`.${kind}-shell`)).toBeVisible();
                await page.close();
            } finally {
                // Surface cleanup failures; harness cleanup is only a fallback.
                await s.sql`DELETE FROM library_paths WHERE id=${library.id}`;
            }
        }
    },
);
