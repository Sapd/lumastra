// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { adminTest as test, expect } from './fixtures/auth';
import { gotoHydrated } from './helpers/cold-load';

const series = randomUUID();
const season = randomUUID();
const episode = randomUUID();

// Real admin pages and parent/child loads; extraction responses are controlled
// because the frame decoder and selection transaction have separate DB tests.
test.describe('episode thumbnail admin controls', () => {
    let sql: postgres.Sql;
    test.beforeAll(async () => {
        const url = process.env.TEST_DATABASE_URL;
        if (!url || !new URL(url).pathname.startsWith('/lumastra_t_'))
            throw new Error('This spec requires an isolated lumastra-remote test database');
        sql = postgres(url, { max: 1 });
        await sql`INSERT INTO media_items (id,title,media_type,has_files) VALUES (${series},'Thumbnail UI series','tv',true)`;
        await sql`INSERT INTO media_items (id,title,media_type,parent_id,season_number,has_files)
            VALUES (${season},'Thumbnail UI season','season',${series},1,true)`;
        await sql`INSERT INTO media_items (id,title,media_type,parent_id,season_number,episode_number,has_files)
            VALUES (${episode},'Thumbnail UI episode','episode',${season},1,1,true)`;
    });
    test.afterAll(async () => {
        if (!sql) return;
        await sql`DELETE FROM media_items WHERE id=ANY(${[episode, season, series]}::uuid[])`;
        await sql.end();
    });

    test('extracts despite existing artwork and refreshes the real sidebar preview', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1600, height: 1000 });
        let extracted = false;
        await page.route(
            /\/api\/(?:v1\/)?media\/[^/]+\/images\/(?:thumb|poster|backdrop|logo)(?:\?.*)?$/,
            (route) =>
                route.fulfill({
                    contentType: 'image/svg+xml',
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="navy"/></svg>',
                }),
        );
        await page.route(`**/api/admin/media/${episode}/images`, (route) =>
            route.fulfill({
                json: [
                    {
                        id: 'thumb',
                        artworkType: 'thumb',
                        url: `/api/media/${episode}/images/thumb`,
                        source: 'self',
                        sourceId: episode,
                        sourceName: 'Episode',
                    },
                ],
            }),
        );
        await page.route(`**/api/admin/media/${episode}/images/candidates`, (route) =>
            route.fulfill({
                json: {
                    applied: false,
                    candidates: [
                        {
                            id: randomUUID(),
                            media_item_id: episode,
                            artwork_type: 'thumb',
                            provider: extracted ? 'frame-extract' : 'tmdb',
                            provider_ref: extracted ? 'new-frame' : 'old-still',
                            language: null,
                            width: 640,
                            height: 360,
                            chosen_by: extracted ? 'admin' : 'auto',
                            fetched_at: new Date().toISOString(),
                            locked: extracted,
                            selected: true,
                            sort_order: 0,
                            file_path: extracted ? '/new-thumb.jpg' : null,
                            remote_url: null,
                        },
                    ],
                },
            }),
        );
        await page.route(`**/api/admin/media/${episode}/images/extract`, async (route) => {
            expect(route.request().postDataJSON()).toMatchObject({
                artworkType: 'thumb',
                force: true,
            });
            extracted = true;
            await route.fulfill({ json: { extracted: true, filePath: '/new-thumb.jpg' } });
        });
        await gotoHydrated(page, `/admin/library/media/${episode}?tab=artwork`);
        await page.getByTitle('Show hierarchy', { exact: true }).click();
        const preview = page.locator(`aside img[src*="${episode}"]`).first();
        await expect(preview).toBeVisible();
        const before = await preview.getAttribute('src');
        await page
            .getByRole('button', { name: /^Extract from video$/i })
            .last()
            .click();
        await expect.poll(() => extracted).toBe(true);
        await expect(preview).not.toHaveAttribute('src', before!);
        await page.getByText('Image sources and candidates', { exact: true }).click();
        const selectedThumb = page.locator('li').filter({
            has: page.getByText('Episode picture · Selected', { exact: true }),
        });
        await expect(selectedThumb).toBeVisible();
        await expect(selectedThumb).toContainText('Source: frame-extract');
        await selectedThumb.getByText('Technical details', { exact: true }).click();
        await expect(selectedThumb).toContainText('new-frame');
        await expect(selectedThumb).toContainText('admin');
        await expect(
            selectedThumb.getByRole('button', { name: 'Use this image', exact: true }),
        ).toBeDisabled();
        await expect(
            selectedThumb.getByRole('button', { name: 'Hide this picture', exact: true }),
        ).toBeVisible();
    });

    test('queues season extraction from the Files view', async ({ page }) => {
        let queued = false;
        await page.route(
            `**/api/admin/media/${season}/episode-thumbnails/regenerate`,
            async (route) => {
                expect(route.request().postDataJSON()).toMatchObject({
                    scope: 'season',
                });
                queued = true;
                await route.fulfill({ json: { runId: 'run_ui_thumbnails', message: 'Queued' } });
            },
        );
        await gotoHydrated(page, `/admin/library/media/${season}?tab=files`);
        await page
            .getByRole('button', {
                name: 'Repair missing episode pictures',
                exact: true,
            })
            .click();
        await expect.poll(() => queued).toBe(true);
        await expect(
            page.getByText(
                'Missing episode pictures are being repaired. Manual and hidden pictures are kept.',
                { exact: true },
            ),
        ).toBeVisible();
    });
});
