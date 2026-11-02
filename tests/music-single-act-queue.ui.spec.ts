// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';
import { withoutNetworkChangeErrors } from './helpers/network-changes';
import { placeInLibraryGroup } from './integration/fixtures/library-access.fixtures';

const FIRST = 'e2eacc10-0000-4000-8000-000000000001';
const SECOND = 'e2eacc10-0000-4000-8000-000000000002';
const GROUP = 'e2eacc10-0000-4000-8000-000000000003';
const ALBUM = 'e2eacc10-0000-4000-8000-000000000004';
const TRACK = 'e2eacc10-0000-4000-8000-000000000005';
const PREFIX = 'SingleActQueueFixture';
const FIRST_TITLE = `${PREFIX} Above & Lanterns`;
const SECOND_TITLE = `${PREFIX} Copper and Lanterns`;
const TRACK_TITLE = `${PREFIX} Unresolved duet`;
const QUEUE = `/admin/library/media?filter=music-artist-unsplit&domain=music&type=artist&q=${PREFIX}&sort=title&order=asc`;

test.describe.configure({ mode: 'serial' });

function database(): postgres.Sql {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !/lumastra_(?:t_|tests)/.test(new URL(databaseUrl).pathname)) {
        throw new Error('Single-act browser tests require a disposable test database');
    }
    return postgres(databaseUrl, { max: 1 });
}

test.beforeEach(async () => {
    const sql = database();
    try {
        await sql`INSERT INTO library_groups (id, name) VALUES (${GROUP}, ${PREFIX}) ON CONFLICT (id) DO NOTHING`;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, custom_metadata)
            VALUES (${FIRST}, ${FIRST_TITLE}, 'artist', 'active', TRUE, '{"queue_fixture":true}'::jsonb),
                   (${SECOND}, ${SECOND_TITLE}, 'artist', 'active', TRUE, '{"queue_fixture":true}'::jsonb)
            ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = 'active',
                has_files = TRUE, custom_metadata = EXCLUDED.custom_metadata
        `;
        for (const artistId of [FIRST, SECOND]) {
            const [existing] =
                await sql`SELECT 1 FROM media_items WHERE parent_id = ${artistId} LIMIT 1`;
            if (!existing)
                await placeInLibraryGroup(sql, {
                    mediaItemId: artistId,
                    mediaType: 'artist',
                    libraryGroupId: GROUP,
                });
        }
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, has_files)
            VALUES (${ALBUM}, ${`${PREFIX} Shared EP`}, 'album', 'active', ${FIRST}, TRUE)
            ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = 'active',
                parent_id = EXCLUDED.parent_id, has_files = TRUE
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id, has_files, custom_metadata)
            VALUES (
                ${TRACK}, ${TRACK_TITLE}, 'track', 'active', ${ALBUM}, TRUE,
                ${sql.json({ artist: `${FIRST_TITLE} & Guest Voice`, album_artist: FIRST_TITLE })}
            )
            ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, status = 'active',
                parent_id = EXCLUDED.parent_id, has_files = TRUE,
                custom_metadata = EXCLUDED.custom_metadata
        `;
    } finally {
        await sql.end();
    }
});

test.afterAll(async () => {
    const sql = database();
    try {
        await sql`DELETE FROM media_files WHERE library_group_id = ${GROUP}`;
        await sql`DELETE FROM media_items WHERE parent_id IN (SELECT id FROM media_items WHERE parent_id IN (${FIRST}, ${SECOND}))`;
        await sql`DELETE FROM media_items WHERE parent_id IN (${FIRST}, ${SECOND})`;
        await sql`DELETE FROM media_items WHERE id IN (${FIRST}, ${SECOND})`;
        await sql`DELETE FROM library_groups WHERE id = ${GROUP}`;
    } finally {
        await sql.end();
    }
});

for (const variant of [
    { name: 'desktop list', width: 1280, height: 900, layout: 'list' },
    { name: 'mobile list', width: 390, height: 844, layout: 'list' },
    { name: 'desktop grid', width: 1280, height: 900, layout: 'grid' },
]) {
    test(`${variant.name}: real classification and Undo refresh the queue and persist`, async ({
        page,
    }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width: variant.width, height: variant.height });
        await page.goto(`${QUEUE}&layout=${variant.layout}`);
        await expectHydrated(page);
        await expect(page.getByText(`2 items matching "${PREFIX}"`, { exact: true })).toBeVisible();
        const mark = page.getByRole('button', { name: /^Mark .+ as a single act$/ });
        await expect(mark).toHaveCount(2);
        const response = page.waitForResponse(
            (r) =>
                r.url().endsWith(`/api/admin/media/${FIRST}/no-split`) &&
                r.request().method() === 'PATCH',
        );
        await mark.first().click();
        expect((await response).ok()).toBe(true);
        await expect(mark).toHaveCount(1);
        await expect(page.getByText(`1 items matching "${PREFIX}"`, { exact: true })).toBeVisible();
        await expect(
            page.getByRole('button', {
                name: `Undo single-act classification for ${FIRST_TITLE}`,
                exact: true,
            }),
        ).toBeVisible();
        const sql = database();
        try {
            const [marked] = await sql`SELECT custom_metadata FROM media_items WHERE id = ${FIRST}`;
            expect(marked.custom_metadata).toEqual({ queue_fixture: true, no_split: true });
            await page.screenshot({
                path: `.cache/single-act/${variant.name.replaceAll(' ', '-')}.png`,
                fullPage: true,
            });
            await page
                .getByRole('button', {
                    name: `Undo single-act classification for ${FIRST_TITLE}`,
                    exact: true,
                })
                .click();
            await expect(mark).toHaveCount(2);
            await expect(
                page.getByText(`2 items matching "${PREFIX}"`, { exact: true }),
            ).toBeVisible();
            const [undone] = await sql`SELECT custom_metadata FROM media_items WHERE id = ${FIRST}`;
            expect(undone.custom_metadata).toEqual({ queue_fixture: true });
        } finally {
            await sql.end();
        }
        const url = new URL(page.url());
        expect(url.searchParams.get('filter')).toBe('music-artist-unsplit');
        expect(url.searchParams.get('q')).toBe(PREFIX);
        expect(url.searchParams.get('layout')).toBe(variant.layout);
        expect(withoutNetworkChangeErrors(page, errors)).toEqual([]);
    });
}

test('queue review opens artist tracks and the guarded per-track credit editor', async ({
    page,
}) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${QUEUE}&layout=list`);
    await expectHydrated(page);

    await page.getByRole('link', { name: 'Review artist tracks' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/admin/library/media/${FIRST}\\?tab=tracks`));
    await expectHydrated(page);
    await page.getByRole('searchbox', { name: 'Find a track', exact: true }).fill(TRACK_TITLE);
    await expect(page.getByRole('link', { name: 'Review track credits' })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Review track credits' })).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('tracks_q')).toBe(TRACK_TITLE);
    const filteredArtistWorkspace = new URL(page.url());
    expect(filteredArtistWorkspace.searchParams.get('tracks_q')).toBe(TRACK_TITLE);
    const reviewHref = new URL(
        (await page.getByRole('link', { name: 'Review track credits' }).getAttribute('href'))!,
        page.url(),
    );
    expect(reviewHref.searchParams.get('music_from_artist_tracks')).toBe(FIRST);
    expect(reviewHref.searchParams.get('tracks_q')).toBe(TRACK_TITLE);
    expect(reviewHref.searchParams.get('tracks_page')).toBe('1');
    await page.getByRole('link', { name: 'Review track credits' }).click();

    await expect(page).toHaveURL(
        new RegExp(
            `/admin/library/media/${TRACK}\\?.*music_from_artist_tracks=${FIRST}.*#artist-credits`,
        ),
    );
    await expectHydrated(page);
    const editor = page.locator('#artist-credits');
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('heading', { name: 'Artist credits' })).toBeVisible();
    await editor.getByText('Original tag evidence').click();
    await expect(editor.locator('pre')).toContainText(`${FIRST_TITLE} & Guest Voice`);
    await expect(
        editor.getByRole('button', { name: 'Save artists and remixers', exact: true }),
    ).toBeVisible();

    // Back follows the actual browser history and restores the prior workspace.
    await page.goBack();
    await expect(page).toHaveURL(filteredArtistWorkspace.toString());
    await expect(page.getByRole('searchbox', { name: 'Find a track', exact: true })).toHaveValue(
        TRACK_TITLE,
    );
    await page.goBack();
    await expect(page).toHaveURL(/filter=music-artist-unsplit/);
    await expect(page.getByRole('link', { name: 'Review artist tracks' })).toHaveCount(2);

    const sql = database();
    try {
        const [artist] = await sql`SELECT custom_metadata FROM media_items WHERE id = ${FIRST}`;
        const [album] = await sql`SELECT parent_id FROM media_items WHERE id = ${ALBUM}`;
        const [track] = await sql`SELECT id, parent_id FROM media_items WHERE id = ${TRACK}`;
        expect(artist.custom_metadata).toEqual({ queue_fixture: true });
        expect(album.parent_id).toBe(FIRST);
        expect(track).toEqual({ id: TRACK, parent_id: ALBUM });
    } finally {
        await sql.end();
    }
    expect(withoutNetworkChangeErrors(page, errors)).toEqual([]);
});

for (const failure of ['server', 'network']) {
    test(`confirmed mark retains Undo across ${failure} refresh failure, and refresh retry never rewrites`, async ({
        page,
    }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        let failRefresh = true;
        let writes = 0;
        page.on('request', (request) => {
            if (
                request.method() === 'PATCH' &&
                request.url().endsWith(`/api/admin/media/${FIRST}/no-split`)
            )
                writes++;
        });
        await page.route('**/admin/library/media?*', async (route) => {
            const request = route.request();
            if (
                request.method() === 'POST' &&
                new URL(request.url()).searchParams.has('/refreshSingleActQueue') &&
                failRefresh
            ) {
                if (failure === 'network') await route.abort('failed');
                else
                    await route.fulfill({
                        status: 503,
                        headers: { 'X-E2E-Expected-Status': '503' },
                        contentType: 'application/json',
                        body: JSON.stringify({
                            type: 'error',
                            status: 503,
                            error: { message: 'Temporary test outage' },
                        }),
                    });
                return;
            }
            await route.continue();
        });
        await page.goto(QUEUE);
        await expectHydrated(page);
        await page
            .getByRole('button', { name: `Mark ${FIRST_TITLE} as a single act`, exact: true })
            .click();
        const feedback = page.getByTestId(`single-act-feedback-${FIRST}`);
        await expect(
            feedback.getByText('The change was saved, but the list could not be refreshed.', {
                exact: true,
            }),
        ).toBeVisible();
        await expect(
            feedback.getByRole('button', {
                name: `Undo single-act classification for ${FIRST_TITLE}`,
                exact: true,
            }),
        ).toBeVisible();
        await expect(page.getByText(`2 items matching "${PREFIX}"`, { exact: true })).toBeVisible();
        const sql = database();
        try {
            const [marked] = await sql`SELECT custom_metadata FROM media_items WHERE id = ${FIRST}`;
            expect(marked.custom_metadata.no_split).toBe(true);
        } finally {
            await sql.end();
        }
        failRefresh = false;
        await feedback.getByRole('button', { name: 'Retry refresh', exact: true }).click();
        await expect(
            feedback.getByRole('button', { name: 'Retry refresh', exact: true }),
        ).toHaveCount(0);
        await expect(
            feedback.getByText('The change was saved, but the list could not be refreshed.', {
                exact: true,
            }),
        ).toHaveCount(0);
        await expect(page.getByText(`1 items matching "${PREFIX}"`, { exact: true })).toBeVisible();
        expect(writes).toBe(1);
        await feedback
            .getByRole('button', {
                name: `Undo single-act classification for ${FIRST_TITLE}`,
                exact: true,
            })
            .click();
        await expect(page.getByText(`2 items matching "${PREFIX}"`, { exact: true })).toBeVisible();
        expect(writes).toBe(2);
        expect(withoutNetworkChangeErrors(page, errors)).toEqual([]);
    });
}

test('a failed mark keeps the queue entry and can retry the actual write', async ({ page }) => {
    let rejectWrite = true;
    await page.route(`**/api/admin/media/${FIRST}/no-split`, async (route) => {
        if (rejectWrite) {
            await route.fulfill({
                status: 503,
                headers: { 'X-E2E-Expected-Status': '503' },
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Temporary test outage' }),
            });
        } else await route.continue();
    });
    await page.goto(QUEUE);
    await expectHydrated(page);
    await page
        .getByRole('button', { name: `Mark ${FIRST_TITLE} as a single act`, exact: true })
        .click();
    const feedback = page.getByTestId(`single-act-feedback-${FIRST}`);
    await expect(
        feedback.getByRole('button', { name: 'Retry marking', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: FIRST_TITLE, exact: true })).toBeVisible();
    await expect(page.getByText(`2 items matching "${PREFIX}"`, { exact: true })).toBeVisible();
    rejectWrite = false;
    await feedback.getByRole('button', { name: 'Retry marking', exact: true }).click();
    await expect(page.getByText(`1 items matching "${PREFIX}"`, { exact: true })).toBeVisible();
    await expect(
        feedback.getByRole('button', {
            name: `Undo single-act classification for ${FIRST_TITLE}`,
            exact: true,
        }),
    ).toBeVisible();
});
