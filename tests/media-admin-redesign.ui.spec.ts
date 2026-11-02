// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import type { BrowserContext, Page } from '@playwright/test';
import { adminTest as test, expect, ADMIN_FORWARD_AUTH_HEADERS } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';
import { observeNetworkChanges, withoutNetworkChangeErrors } from './helpers/network-changes';

const SERIES = 'e2eadd00-0000-4000-8000-000000000001';
const SEASON = 'e2eadd00-0000-4000-8000-000000000002';
const FIRST = 'e2eadd00-0000-4000-8000-000000000003';
const SECOND = 'e2eadd00-0000-4000-8000-000000000004';
const METADATA_MATCH = 'e2eadd00-0000-4000-8000-000000000005';
const FILE = 'e2eadd00-0000-4000-8000-000000000006';
const ARTIST = 'e2eadd00-0000-4000-8000-000000000007';
const ALBUM = 'e2eadd00-0000-4000-8000-000000000008';
const TRACK = 'e2eadd00-0000-4000-8000-000000000009';
const TRACK_TWO = 'e2eadd00-0000-4000-8000-00000000000a';
const AUDIO_FILE = 'e2eadd00-0000-4000-8000-00000000000b';
const MOVIE = 'e2eadd00-0000-4000-8000-00000000000c';
const ORIGINAL_FILE = 'e2eadd00-0000-4000-8000-00000000000d';
const REMASTER_FILE = 'e2eadd00-0000-4000-8000-00000000000e';
const SECOND_SEASON = 'e2eadd04-0000-4000-8000-000000000000';
const CREDIT_LEAD = 'e2eadd03-0000-4000-8000-000000000001';
const CREDIT_GUEST = 'e2eadd03-0000-4000-8000-000000000002';
const CREDIT_REMIXER = 'e2eadd03-0000-4000-8000-000000000003';
const INCOMPLETE_SERIES = 'e2eadd05-0000-4000-8000-000000000001';
const INCOMPLETE_SEASON = 'e2eadd05-0000-4000-8000-000000000002';
const INCOMPLETE_EPISODE = 'e2eadd05-0000-4000-8000-000000000003';
const LANGUAGE_SERIES = 'e2eadd06-0000-4000-8000-000000000001';
const LANGUAGE_SEASON = 'e2eadd06-0000-4000-8000-000000000002';
const LANGUAGE_EPISODE = 'e2eadd06-0000-4000-8000-000000000003';
const UNKNOWN_EPISODE = 'e2eadd06-0000-4000-8000-000000000004';
const LANGUAGE_FILE = 'e2eadd06-0000-4000-8000-000000000005';
const DUB_FILE = 'e2eadd06-0000-4000-8000-000000000006';
const UNPROBED_FILE = 'e2eadd06-0000-4000-8000-000000000007';
const TITLE = 'Lumen Harbour Console Fixture';
const FILE_PATH = '/nonexistent/lumastra-e2e/lumen-harbour-S01E01E02.mp4';
const BROWSER_MOVIES = Array.from({ length: 31 }, (_, index) => ({
    id: `e2eadd02-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    title: `${TITLE} Extra ${String(index + 1).padStart(3, '0')}`,
    media_type: 'movie',
    has_files: true,
    status: 'active',
    year: 2001,
}));

// This suite edits shared, disposable records and must stay in one worker even
// when the project's normal UI configuration enables full parallelism.
test.describe.configure({ mode: 'serial' });

type ObservedPageError = { page: Page; message: string };
const uncaughtPageErrors = new WeakMap<BrowserContext, ObservedPageError[]>();

test.beforeEach(async ({ page, context }) => {
    const errors: ObservedPageError[] = [];
    uncaughtPageErrors.set(context, errors);
    const observePage = (observed: Page): void => {
        observed.on('pageerror', (error) =>
            errors.push({ page: observed, message: error.message }),
        );
    };
    for (const existing of context.pages()) observePage(existing);
    context.on('page', observePage);
    await page.emulateMedia({ reducedMotion: 'reduce' });
});

test.afterEach(({ context }, info) => {
    if (
        info.expectedStatus === 'skipped' &&
        info.annotations.some((annotation) => annotation.type === 'environment-quarantine')
    )
        return;
    const errors = (uncaughtPageErrors.get(context) ?? []).flatMap(({ page, message }) =>
        withoutNetworkChangeErrors(page, [message]),
    );
    expect(errors, 'uncaught browser errors').toEqual([]);
});

// These records exercise the real server load, list query, file mapping endpoint,
// and client navigation. Do not substitute browser route mocks for these seams.
test.beforeAll(async ({ request }) => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !/lumastra_(?:t_|tests)/.test(new URL(databaseUrl).pathname)) {
        throw new Error(
            'Media console E2E requires an isolated lumastra_t_* or lumastra_tests database',
        );
    }
    const sql = postgres(databaseUrl, { max: 1 });
    try {
        await sql`
            INSERT INTO media_items (id, title, media_type, has_files, status, overview, year)
            VALUES (${SERIES}, ${TITLE}, 'tv', TRUE, 'active', 'A fictional coastal observatory.', 2001),
                   (${METADATA_MATCH}, 'The Distant Observatory', 'movie', TRUE, 'active', ${TITLE}, 2001)
            ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, overview = EXCLUDED.overview,
                has_files = TRUE, status = 'active', year = EXCLUDED.year
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, has_files, status, runtime_seconds, custom_metadata)
            VALUES (${ARTIST}, 'Harbour Lights Collective', 'artist', NULL, TRUE, 'active', NULL, '{}'::jsonb),
                   (${CREDIT_LEAD}, 'Signal Harbour Lead', 'artist', NULL, FALSE, 'active', NULL, '{}'::jsonb),
                   (${CREDIT_GUEST}, 'Tidal Ridge Guest', 'artist', NULL, FALSE, 'active', NULL, '{}'::jsonb),
                   (${CREDIT_REMIXER}, 'Copper Lantern Remixer', 'artist', NULL, FALSE, 'active', NULL, '{}'::jsonb),
                   (${ALBUM}, 'Midnight Coastal Collection', 'album', ${ARTIST}, TRUE, 'active', NULL, '{}'::jsonb),
                   (${TRACK}, 'Amber Horizon Mix', 'track', ${ALBUM}, TRUE, 'active', 183,
                    ${sql.json({ artist: 'Signal Harbour Lead & Tidal Ridge Guest', raw_artist_tags: { source: 'embedded', artist: 'Signal Harbour Lead & Tidal Ridge Guest' }, essentia: { danceability: 2.4, energy: 0.46, bpm: 129.2, key: 'E', essentia_analyzed: true } })}),
                   (${TRACK_TWO}, 'Silver Harbour Dub', 'track', ${ALBUM}, FALSE, 'active', 3600, '{}'::jsonb)
            ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, parent_id = EXCLUDED.parent_id,
                has_files = EXCLUDED.has_files, runtime_seconds = EXCLUDED.runtime_seconds,
                custom_metadata = EXCLUDED.custom_metadata, overview = NULL
        `;
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${METADATA_MATCH}, 'tmdb', ${sql.json({ keywords: [TITLE] })})
            ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata
        `;
        const collectionTracks = Array.from({ length: 194 }, (_, index) => ({
            id: `e2eadd01-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            title: `Coastal Session ${String(index + 1).padStart(3, '0')}`,
            media_type: 'track',
            parent_id: ALBUM,
            has_files: false,
            status: 'active',
            runtime_seconds: 180,
        }));
        await sql`INSERT INTO media_items ${sql(collectionTracks)} ON CONFLICT (id) DO NOTHING`;
        await sql`INSERT INTO media_items ${sql(BROWSER_MOVIES)} ON CONFLICT (id) DO NOTHING`;
        await sql`
            INSERT INTO media_items (id, title, media_type, has_files, status, year)
            VALUES (${MOVIE}, 'Calm Water Versions', 'movie', TRUE, 'active', 2001)
            ON CONFLICT (id) DO NOTHING
        `;
        await sql`
            INSERT INTO media_files (id, file_path, edition, duration_seconds, file_size_bytes, container_format)
            VALUES (${ORIGINAL_FILE}, '/nonexistent/lumastra-e2e/calm-water-original.mp4', 'Original edit', 120, 12000000, 'mp4'),
                   (${REMASTER_FILE}, '/nonexistent/lumastra-e2e/calm-water-remaster.mkv', 'Archive remaster', 121, 60000000, 'matroska')
            ON CONFLICT (id) DO NOTHING
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
            VALUES (${ORIGINAL_FILE}, ${MOVIE}, TRUE, 0), (${REMASTER_FILE}, ${MOVIE}, FALSE, 1)
            ON CONFLICT (file_id, media_item_id) DO NOTHING
        `;
        await sql`
            INSERT INTO media_streams (file_id, stream_type, stream_index, codec, width, height)
            VALUES (${ORIGINAL_FILE}, 'video', 0, 'h264', 960, 540),
                   (${REMASTER_FILE}, 'video', 0, 'hevc', 1920, 1080)
            ON CONFLICT DO NOTHING
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, has_files, status)
            VALUES (${SEASON}, 'Season 1', 'season', ${SERIES}, 1, TRUE, 'active')
            ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, has_files = TRUE, status = 'active'
        `;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
            VALUES (${SECOND_SEASON}, 'Season 2', 'season', ${SERIES}, 2, 'active') ON CONFLICT (id) DO NOTHING`;
        const longSeries = Array.from({ length: 802 }, (_, index) => ({
            id: `e2eadd04-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            title: `Observatory Dispatch ${String(index + 1).padStart(3, '0')}`,
            media_type: 'episode',
            parent_id: SECOND_SEASON,
            season_number: 2,
            episode_number: index + 1,
            status: 'active',
            has_files: false,
            premiere_date: '2001-01-03',
        }));
        await sql`INSERT INTO media_items ${sql(longSeries)} ON CONFLICT (id) DO NOTHING`;

        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number,
                                     has_files, status, runtime_seconds, premiere_date)
            VALUES (${FIRST}, 'The Lantern Signal', 'episode', ${SEASON}, 1, 1, TRUE, 'active', 90, '2001-01-01'),
                   (${SECOND}, 'The Quiet Crossing', 'episode', ${SEASON}, 1, 2, TRUE, 'active', 60, '2001-01-02')
            ON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id,
                has_files = TRUE, status = 'active', runtime_seconds = EXCLUDED.runtime_seconds
        `;
        await sql`INSERT INTO media_items(id,title,media_type,parent_id,status,season_number,episode_number)
            VALUES (${INCOMPLETE_SERIES},'Night Jet Identity Fixture','tv',NULL,'active',NULL,NULL),
                   (${INCOMPLETE_SEASON},'Unnumbered Season','season',${INCOMPLETE_SERIES},'active',NULL,NULL),
                   (${INCOMPLETE_EPISODE},'Unproven Episode Identity','episode',${INCOMPLETE_SEASON},'active',NULL,NULL)
            ON CONFLICT(id) DO NOTHING`;

        await sql`
            INSERT INTO media_files (id, file_path, duration_seconds, file_size_bytes, container_format)
            VALUES (${FILE}, ${FILE_PATH}, 150, 12000000, 'mov,mp4,m4a,3gp,3g2,mj2')
            ON CONFLICT (id) DO UPDATE SET duration_seconds = EXCLUDED.duration_seconds,
                file_size_bytes = EXCLUDED.file_size_bytes
        `;
        await sql`
            INSERT INTO media_files (id, file_path, duration_seconds, file_size_bytes, container_format)
            VALUES (${AUDIO_FILE}, '/nonexistent/lumastra-e2e/amber-horizon.mp3', 183, 8000000, 'mp3')
            ON CONFLICT (id) DO NOTHING
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${AUDIO_FILE}, ${TRACK}, TRUE)
            ON CONFLICT (file_id, media_item_id) DO NOTHING
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, start_offset_ms, end_offset_ms, offset_source)
            VALUES (${FILE}, ${FIRST}, TRUE, 0, 90000, 'runtime-split'),
                   (${FILE}, ${SECOND}, TRUE, 90000, 150000, 'runtime-split')
            ON CONFLICT (file_id, media_item_id) DO UPDATE SET start_offset_ms = EXCLUDED.start_offset_ms,
                end_offset_ms = EXCLUDED.end_offset_ms, offset_source = EXCLUDED.offset_source, is_default = TRUE
        `;
        await sql`INSERT INTO media_items(id,title,media_type,parent_id,status,season_number,episode_number,has_files)
            VALUES (${LANGUAGE_SERIES},'Prism Reef Language Fixture','tv',NULL,'active',NULL,NULL,TRUE),
                   (${LANGUAGE_SEASON},'Season 1','season',${LANGUAGE_SERIES},'active',1,NULL,TRUE),
                   (${LANGUAGE_EPISODE},'The Moonlit Archive','episode',${LANGUAGE_SEASON},'active',1,1,TRUE),
                   (${UNKNOWN_EPISODE},'The Uncharted Reel','episode',${LANGUAGE_SEASON},'active',1,2,TRUE)
            ON CONFLICT(id) DO NOTHING`;
        await sql`INSERT INTO media_files(id,file_path,edition,duration_seconds,probed_at)
            VALUES (${LANGUAGE_FILE},'/nonexistent/lumastra-e2e/prism-reef-original.mkv','Original multilingual',120,now()),
                   (${DUB_FILE},'/nonexistent/lumastra-e2e/prism-reef-dub.mkv','English dub',120,now()),
                   (${UNPROBED_FILE},'/nonexistent/lumastra-e2e/prism-reef-unprobed.mkv',NULL,120,NULL)
            ON CONFLICT(id) DO NOTHING`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default,sort_order)
            VALUES (${LANGUAGE_FILE},${LANGUAGE_EPISODE},TRUE,0),
                   (${DUB_FILE},${LANGUAGE_EPISODE},FALSE,1),
                   (${UNPROBED_FILE},${UNKNOWN_EPISODE},TRUE,0)
            ON CONFLICT(file_id,media_item_id) DO NOTHING`;
        await sql`INSERT INTO media_streams(file_id,stream_type,stream_index,codec,language,is_default,is_forced)
            VALUES (${LANGUAGE_FILE},'video',0,'h264',NULL,FALSE,FALSE),
                   (${LANGUAGE_FILE},'audio',1,'aac','jpn',TRUE,FALSE),
                   (${LANGUAGE_FILE},'audio',2,'aac','ger',FALSE,FALSE),
                   (${LANGUAGE_FILE},'audio',5,'aac','ita',FALSE,FALSE),
                   (${LANGUAGE_FILE},'audio',6,'aac','spa',FALSE,FALSE),
                   (${LANGUAGE_FILE},'subtitle',3,'subrip','eng',TRUE,FALSE),
                   (${LANGUAGE_FILE},'subtitle',4,'ass','und',FALSE,TRUE),
                   (${DUB_FILE},'video',0,'h264',NULL,FALSE,FALSE),
                   (${DUB_FILE},'audio',1,'aac','eng',TRUE,FALSE)
            ON CONFLICT DO NOTHING`;
        await sql`INSERT INTO external_subtitle_files(file_id,subtitle_path,language,format,is_forced)
            VALUES (${LANGUAGE_FILE},'/nonexistent/lumastra-e2e/prism-reef.fr.forced.ass','fra','ass',TRUE)
            ON CONFLICT DO NOTHING`;
        for (const [id, externalId] of [
            [SERIES, '72900001'],
            [SEASON, '72900002'],
            [SECOND, '72900003'],
            [INCOMPLETE_SERIES, '72900010'],
            [INCOMPLETE_EPISODE, '72900011'],
        ]) {
            const response = await request.put(`/api/admin/media/${id}/external-ids`, {
                data: { provider: 'tmdb', externalId },
            });
            expect(response.status(), await response.text()).toBe(200);
        }
    } finally {
        await sql.end();
    }
});

test('title search excludes metadata-only matches and broader search includes them', async ({
    page,
}) => {
    await page.goto(`/admin/library/media?q=${encodeURIComponent(TITLE)}`);
    await expectHydrated(page);
    await expect(page.getByRole('link', { name: TITLE, exact: true })).toBeVisible();
    await expect(
        page.getByRole('link', { name: 'The Distant Observatory', exact: true }),
    ).toHaveCount(0);
    await page.getByLabel('Search scope', { exact: true }).selectOption('metadata');
    await expect(page).toHaveURL(/scope=metadata/);
    await expect(
        page.getByRole('link', { name: 'The Distant Observatory', exact: true }),
    ).toBeVisible();
});

test('all episode sections remain reachable and expose shared-file boundaries', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${SECOND}`);
    await expectHydrated(page);
    await expect(
        page.getByRole('heading', { name: 'The Quiet Crossing', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/part 2 of 2/i)).toBeVisible();
    await expect(page.getByText(/1:30/).first()).toBeVisible();
    for (const name of ['Files', 'Artwork', 'Maintenance', 'Overview']) {
        await page.getByRole('tab', { name: new RegExp(`^${name}(?:\\s|$)`) }).click();
        await expect(
            page.getByRole('tab', { name: new RegExp(`^${name}(?:\\s|$)`) }),
        ).toHaveAttribute('aria-selected', 'true');
    }
    await page.getByRole('tab', { name: /^Files(?:\s|$)/ }).click();
    const mappings = page.getByRole('region', { name: 'Episode mappings and boundaries' });
    await expect(mappings.getByRole('link', { name: /The Lantern Signal/ })).toBeVisible();
    await expect(mappings.getByRole('link', { name: /The Quiet Crossing/ })).toBeVisible();
    await expect(mappings.getByText(/file time/i).first()).toBeVisible();
});

test('series inventory groups a shared physical file once and keeps both episode links', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${SERIES}?tab=files`);
    await expectHydrated(page);
    // The first container inventory compiles its API graph on the dev server.
    await expect(page.getByText(/1 physical file/i)).toBeVisible({ timeout: 30_000 });
    const mappings = page.getByRole('region', { name: 'Episode mappings and boundaries' });
    await expect(mappings.getByRole('link', { name: /The Lantern Signal/ })).toBeVisible();
    await expect(mappings.getByRole('link', { name: /The Quiet Crossing/ })).toBeVisible();
    await page.getByText('Filename and path', { exact: true }).click();
    await expect(page.getByText(/lumen-harbour-S01E01E02\.mp4/).first()).toBeVisible();
});

test('movie version cards compare quality and technical details follow the selected file', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${MOVIE}?tab=files`);
    await expectHydrated(page);
    const versions = page.getByTestId('physical-file-cards');
    await expect(versions.locator('article')).toHaveCount(2);
    await expect(versions.getByText('960 × 540', { exact: true })).toBeVisible();
    await expect(versions.getByText('1920 × 1080', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Original edit', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(page.getByRole('cell', { name: 'h264', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Archive remaster', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'hevc', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'h264', exact: true })).toHaveCount(0);
});

test('Files refreshes replacement streams without changing the selected version', async ({
    page,
}) => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
        await page.goto(`/admin/library/media/${MOVIE}?tab=files`);
        await expectHydrated(page);
        await page.getByRole('button', { name: 'Archive remaster', exact: true }).click();
        await expect(page.getByRole('cell', { name: 'hevc', exact: true })).toBeVisible();
        await sql`UPDATE media_streams SET codec='av1',width=2560,height=1440
            WHERE file_id=${REMASTER_FILE} AND stream_type='video'`;
        const refreshed = page.waitForResponse(
            (response) =>
                response.url().includes(`/media/${MOVIE}/files?`) &&
                response.request().method() === 'GET',
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        expect((await refreshed).ok()).toBe(true);
        const version = page.locator(`[data-file-id="${REMASTER_FILE}"]`);
        await expect(version.getByText('2560 × 1440', { exact: true })).toBeVisible();
        await expect(version.getByText('av1', { exact: true })).toBeVisible();
        await expect(page.getByRole('cell', { name: 'av1', exact: true })).toBeVisible();
        await expect(page.getByRole('cell', { name: 'hevc', exact: true })).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: 'Archive remaster', exact: true }),
        ).toHaveAttribute('aria-pressed', 'true');
    } finally {
        await sql`UPDATE media_streams SET codec='hevc',width=1920,height=1080
            WHERE file_id=${REMASTER_FILE} AND stream_type='video'`;
        await sql.end();
    }
});

for (const legacyTab of ['images', 'sync', 'pipeline', 'ordering', 'health']) {
    test(`legacy ${legacyTab} detail link reaches the retained tool`, async ({ page }) => {
        await page.goto(`/admin/library/media/${SERIES}?tab=${legacyTab}`);
        await expectHydrated(page);
        const destination =
            legacyTab === 'images'
                ? 'Artwork'
                : ['sync', 'pipeline'].includes(legacyTab)
                  ? 'Maintenance'
                  : 'Episodes';
        await expect(
            page.getByRole('tab', { name: new RegExp(`^${destination}(?:\\s|$)`) }),
        ).toHaveAttribute('aria-selected', 'true');
    });
}

test('browser return preserves search, selection, focus and actual scroll position', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const search = `/admin/library/media?q=${encodeURIComponent(TITLE)}&sort=title&order=desc&layout=list&page_size=50`;
    await page.goto(search);
    await expectHydrated(page);
    const mediaTable = page.locator('table');
    await expect(mediaTable.locator('thead')).not.toContainText('TMDB');
    const defaultTableFit = await mediaTable.evaluate((table) => {
        const scrollContainer = table.parentElement;
        const headerCells = [...table.querySelectorAll('thead th')];
        const bodyCells = table.querySelectorAll('tbody tr:first-child td');
        return {
            clientWidth: scrollContainer?.clientWidth ?? 0,
            scrollWidth: scrollContainer?.scrollWidth ?? 0,
            columns: headerCells.map((header, index) => ({
                label: header.textContent?.trim() ?? '',
                headerWidth: Math.round(header.getBoundingClientRect().width),
                cellWidth: Math.round(bodyCells[index]?.getBoundingClientRect().width ?? 0),
            })),
        };
    });
    expect(
        defaultTableFit.scrollWidth,
        `Default title table should fit without horizontal scrolling: ${JSON.stringify(defaultTableFit.columns)}`,
    ).toBeLessThanOrEqual(defaultTableFit.clientWidth + 1);
    const seriesTitle = page.getByRole('link', { name: TITLE, exact: true });
    const seriesRow = page.getByRole('row').filter({ has: seriesTitle });
    await seriesTitle.scrollIntoViewIfNeeded();
    await expect(seriesRow.getByRole('button', { name: /available aired episodes/ })).toBeVisible();
    await expect(seriesRow.getByRole('button', { name: 'No poster', exact: true })).toBeVisible();
    const seriesGeometry = await seriesRow.evaluate((row) => {
        const cells = row.querySelectorAll('td');
        const titleLink = cells[2]?.querySelector('a');
        return {
            height: row.getBoundingClientRect().height,
            titleWidth: cells[2]?.getBoundingClientRect().width ?? 0,
            titleLinkWidth: titleLink?.getBoundingClientRect().width ?? 0,
            titleMinWidth: titleLink ? getComputedStyle(titleLink).minWidth : '',
            titleOverflow: titleLink ? getComputedStyle(titleLink).textOverflow : '',
        };
    });
    expect(seriesGeometry.height).toBeGreaterThan(40);
    expect(seriesGeometry.height).toBeLessThan(120);
    expect(seriesGeometry.titleWidth).toBeGreaterThanOrEqual(240);
    expect(seriesGeometry.titleWidth).toBeLessThan(520);
    expect(seriesGeometry.titleLinkWidth).toBeGreaterThanOrEqual(180);
    expect(seriesGeometry.titleMinWidth).toBe('0px');
    expect(seriesGeometry.titleOverflow).toBe('ellipsis');
    const targetTitle = BROWSER_MOVIES[0].title;
    const title = page.getByRole('link', { name: targetTitle, exact: true });
    await title.scrollIntoViewIfNeeded();
    const targetRow = page.getByRole('row').filter({ has: title });
    const titleCell = targetRow.locator('td').nth(2);
    const geometry = await titleCell.evaluate((cell) => {
        const titleLink = cell.querySelector('a');
        return {
            floor: Number.parseFloat(getComputedStyle(cell).minWidth),
            width: cell.getBoundingClientRect().width,
            titleMinWidth: titleLink ? getComputedStyle(titleLink).minWidth : '',
            titleOverflow: titleLink ? getComputedStyle(titleLink).textOverflow : '',
        };
    });
    expect(geometry.floor).toBeGreaterThan(100);
    expect(geometry.width).toBeGreaterThanOrEqual(geometry.floor);
    expect(geometry.titleMinWidth).toBe('0px');
    expect(geometry.titleOverflow).toBe('ellipsis');
    const moreIssues = targetRow.getByRole('button', { name: /^\+\d+$/ });
    await moreIssues.focus();
    await moreIssues.click();
    const issueTooltip = page.getByRole('tooltip');
    await expect(issueTooltip).toContainText('No overview');
    await expect(issueTooltip).toContainText('No poster');
    await expect(issueTooltip).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(issueTooltip).toHaveCount(0);
    const scrolled = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>('main.main-content');
        return main && ['auto', 'scroll'].includes(getComputedStyle(main).overflowY)
            ? main.scrollTop
            : (document.scrollingElement?.scrollTop ?? 0);
    });
    expect(scrolled).toBeGreaterThan(100);
    await page
        .getByRole('row')
        .filter({ has: title })
        .getByRole('button', { name: 'Select row', exact: true })
        .click();
    await title.click();
    await expect(page.getByRole('heading', { name: targetTitle, exact: true })).toBeVisible();
    await page.getByRole('link', { name: /back to.*results/i }).click();
    await expect(page).toHaveURL(/q=Lumen(?:\+|%20)Harbour/);
    await expect(page.getByRole('link', { name: targetTitle, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deselect row', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await expect(page.getByRole('link', { name: targetTitle, exact: true })).toBeFocused();
    await expect
        .poll(async () =>
            Math.abs(
                scrolled -
                    (await page.evaluate(() => {
                        const main = document.querySelector<HTMLElement>('main.main-content');
                        return main && ['auto', 'scroll'].includes(getComputedStyle(main).overflowY)
                            ? main.scrollTop
                            : (document.scrollingElement?.scrollTop ?? 0);
                    })),
            ),
        )
        .toBeLessThan(4);
    await page.evaluate(() => {
        document.querySelector<HTMLElement>('main.main-content')?.scrollTo({ top: 0, left: 0 });
        window.scrollTo(0, 0);
    });
    await page.screenshot({
        path: 'test-results/media-admin-redesign-desktop.png',
        animations: 'disabled',
        fullPage: true,
    });
});

test('saved dense columns remain selected and the title floor scrolls inside the table with inspector open', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
        localStorage.setItem(
            'admin-media-columns',
            JSON.stringify({
                v: 6,
                keys: [
                    'poster',
                    'title',
                    'type',
                    'ancestryParent',
                    'ancestryRoot',
                    'year',
                    'children',
                    'tmdb',
                    'status',
                    'actions',
                    'dateAdded',
                    'dateUpdated',
                    'originalTitle',
                    'runtime',
                    'overview',
                    'availability',
                    'fileCount',
                    'author',
                    'series',
                    'narrator',
                ],
            }),
        );
    });

    await page.goto(`/admin/library/media?q=${encodeURIComponent(TITLE)}&layout=list`);
    await expectHydrated(page);
    const title = page.getByRole('link', { name: TITLE, exact: true });
    const row = page.getByRole('row').filter({ has: title });
    await row
        .locator('td')
        .nth(1)
        .click({ position: { x: 15, y: 20 } });
    await expect(page.getByRole('button', { name: 'Close inspector', exact: true })).toBeVisible();

    const table = page.locator('table');
    const geometry = await table.evaluate((element) => {
        const container = element.parentElement;
        const cells = element.querySelectorAll('tbody tr:first-child td');
        const titleLink = cells[2]?.querySelector('a');
        return {
            clientWidth: container?.clientWidth ?? 0,
            scrollWidth: container?.scrollWidth ?? 0,
            titleFloor: Number.parseFloat(cells[2] ? getComputedStyle(cells[2]).minWidth : '0'),
            titleWidth: cells[2]?.getBoundingClientRect().width ?? 0,
            titleLinkMinWidth: titleLink ? getComputedStyle(titleLink).minWidth : '',
        };
    });
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
    expect(geometry.titleFloor).toBeGreaterThan(180);
    expect(geometry.titleWidth).toBeGreaterThanOrEqual(geometry.titleFloor);
    expect(geometry.titleLinkMinWidth).toBe('0px');
    await expect(table.locator('thead')).not.toContainText('TMDB');

    await page.getByRole('button', { name: 'Toggle column visibility' }).click();
    await expect(
        page.getByRole('dialog', { name: 'Visible Columns' }).getByRole('button', {
            name: 'TMDB ID',
            exact: true,
        }),
    ).toHaveAttribute('aria-pressed', 'true');
});

test('episode detail inherits its series results and direct links tolerate no saved results', async ({
    page,
}) => {
    await page.goto(`/admin/library/media?q=${encodeURIComponent(TITLE)}&layout=list`);
    await expectHydrated(page);
    await page.getByRole('link', { name: TITLE, exact: true }).click();
    await expect(page.getByTestId('triage-bar')).toBeVisible();
    await page.getByRole('tab', { name: /^Episodes(?:\s|$)/ }).click();
    await page.getByText('The Lantern Signal', { exact: true }).click();
    await page.getByRole('button', { name: 'Open Detail Page', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/media/${FIRST}$`));
    const results = page.getByTestId('triage-bar');
    await expect(results).toBeVisible();
    await expect(results.getByRole('link', { name: /back to.*results/i })).toBeVisible();
    await expect(results.getByRole('link', { name: /^(Previous|Next)$/ })).toHaveCount(0);
    await page.reload();
    await expectHydrated(page);
    await expect(page.getByTestId('triage-bar')).toBeVisible();
    await page
        .getByTestId('triage-bar')
        .getByRole('link', { name: /back to.*results/i })
        .click();
    await expect(page).toHaveURL(/q=Lumen(?:\+|%20)Harbour/);
    await expect(page.getByRole('link', { name: TITLE, exact: true })).toBeVisible();

    await page.evaluate(() => sessionStorage.removeItem('admin-media-triage'));
    await page.goto(`/admin/library/media/${FIRST}`);
    await expectHydrated(page);
    await expect(
        page.getByRole('heading', { name: 'The Lantern Signal', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('triage-bar')).toHaveCount(0);
});

test('overview shortcuts and edit actions navigate to their actual destination', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${MOVIE}?tab=overview`);
    await expectHydrated(page);
    await page.getByRole('button', { name: 'Inspect files and versions', exact: true }).click();
    await expect(page).toHaveURL(/tab=files/);
    await expect(page.getByRole('tab', { name: /^Files(?:\s|$)/ })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await page.getByRole('button', { name: 'Edit metadata', exact: true }).click();
    await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.goto(`/admin/library/media/${ALBUM}?tab=overview&tracks_q=Amber`);
    await expectHydrated(page);
    await page.getByRole('button', { name: 'Open album tracks', exact: true }).click();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
});

test('maintenance sections preserve the parent music workspace', async ({ page }) => {
    await page.goto(
        `/admin/library/media/${TRACK}?tab=maintenance&music_from_album=${ALBUM}&tracks_q=Amber&tracks_sort=title`,
    );
    await expectHydrated(page);
    await page.getByRole('link', { name: 'Media processing', exact: true }).click();
    await expect(page).toHaveURL(/tracks_q=Amber/);
    await page.getByRole('link', { name: 'History', exact: true }).click();
    await page.getByRole('link', { name: 'Back to album tracks', exact: true }).click();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
    await expect(page.getByLabel('Track order', { exact: true })).toHaveValue('title');
});

test('narrow details keep every section reachable without horizontal overflow', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/admin/library/media/${SECOND}`);
    await expectHydrated(page);
    await expect(
        page.getByRole('heading', { name: 'The Quiet Crossing', exact: true }),
    ).toBeVisible();
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.screenshot({
        path: 'test-results/media-admin-redesign-mobile.png',
        animations: 'disabled',
        fullPage: true,
    });
    for (const name of ['Files', 'Artwork', 'Maintenance']) {
        await page.getByRole('tab', { name: new RegExp(`^${name}(?:\\s|$)`) }).click();
        await expect(
            page.getByRole('tab', { name: new RegExp(`^${name}(?:\\s|$)`) }),
        ).toHaveAttribute('aria-selected', 'true');
        expect(
            await page.evaluate(
                () => document.documentElement.scrollWidth <= window.innerWidth + 1,
            ),
        ).toBe(true);
    }
});

test('music parent files include the audio linked to their descendant tracks', async ({ page }) => {
    test.setTimeout(90_000);
    for (const id of [ALBUM, ARTIST]) {
        const inventory = page.waitForResponse(
            (response) => new URL(response.url()).pathname === `/api/admin/media/${id}/files`,
        );
        await page.goto(`/admin/library/media/${id}?tab=files`);
        await expectHydrated(page);
        const response = await inventory;
        expect(response.status(), await response.text()).toBe(200);
        await expect(page.getByText('1 physical file', { exact: true })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByRole('link', { name: /^Amber Horizon Mix/ })).toBeVisible();
    }
});

test('curated album tracks support find, edit and return without losing the list', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${ALBUM}?tab=tracks`);
    await expectHydrated(page);
    await page.getByLabel('Find a track', { exact: true }).fill('Amber');
    await expect(page.getByRole('link', { name: 'Amber Horizon Mix', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Silver Harbour Dub', exact: true })).toHaveCount(
        0,
    );
    await page.getByRole('link', { name: 'Edit metadata', exact: true }).click();
    await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
    await page.getByLabel('Title', { exact: true }).fill('Amber Horizon Mix — Reviewed');
    const [saved] = await Promise.all([
        page.waitForResponse(
            (response) =>
                response.url().endsWith(`/media/${TRACK}/metadata`) &&
                response.request().method() === 'PATCH',
        ),
        page.getByRole('button', { name: 'Save Changes', exact: true }).click(),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    expect(saved.request().postDataJSON()).not.toHaveProperty('overview');
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
        const [persisted] = await sql`
            SELECT title, overview FROM media_items WHERE id = ${TRACK}
        `;
        expect(persisted.title).toBe('Amber Horizon Mix — Reviewed');
        expect(persisted.overview).toBeNull();
    } finally {
        await sql.end();
    }
    await expect(
        page.getByRole('heading', { name: 'Amber Horizon Mix — Reviewed', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Back to album tracks', exact: true }).click();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
    await expect(
        page.getByRole('link', { name: 'Amber Horizon Mix — Reviewed', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Silver Harbour Dub', exact: true })).toHaveCount(
        0,
    );
    await page.goto(`/admin/library/media/${TRACK}?tab=overview`);
    await expectHydrated(page);
    await expect(
        page.getByRole('heading', { name: 'Amber Horizon Mix — Reviewed', exact: true }),
    ).toBeVisible();
    await expect(
        page.getByText('No description yet. Add one with Edit metadata.', { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.evaluate(() => {
        document.querySelector<HTMLElement>('main.main-content')?.scrollTo({ top: 0, left: 0 });
        window.scrollTo(0, 0);
    });
    await page.screenshot({
        path: 'test-results/media-admin-redesign-music.png',
        animations: 'disabled',
        fullPage: true,
    });
});

test('artist discography opens album tracks and preserves its search context', async ({ page }) => {
    await page.goto(`/admin/library/media/${ARTIST}?tab=discography`);
    await expectHydrated(page);
    await page.getByLabel('Find an album', { exact: true }).fill('Midnight');
    await page.getByRole('link', { name: 'Tracks', exact: true }).click();
    await expect(page.getByRole('tab', { name: /^Tracks(?:\s|$)/ })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await page.getByRole('link', { name: 'Back to artist discography', exact: true }).click();
    await expect(page.getByLabel('Find an album', { exact: true })).toHaveValue('Midnight');
});

test('music shows a danceability score and only applicable maintenance actions', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${TRACK}?tab=audio-features`);
    await expectHydrated(page);
    await expect(page.getByText('2.4/3', { exact: true })).toBeVisible();
    await expect(page.getByText('240%', { exact: true })).toHaveCount(0);
    for (const id of [TRACK, ALBUM, ARTIST]) {
        await page.goto(`/admin/library/media/${id}?tab=sync`);
        await expectHydrated(page);
        await expect(
            page.getByRole('button', { name: 'Rebuild seek previews', exact: true }),
        ).toHaveCount(0);
        await expect(
            page.getByRole('button', { name: 'Regenerate outros', exact: true }),
        ).toHaveCount(0);
        await page.goto(`/admin/library/media/${id}?tab=images`);
        await expectHydrated(page);
        await expect(
            page.getByRole('button', { name: 'Extract from Video', exact: true }),
        ).toHaveCount(0);
    }
});

test('long series mapping editor finds episodes and preserves deliberate playback order', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${SERIES}?tab=files`);
    await expectHydrated(page);
    await page.getByRole('button', { name: 'Episodes in file', exact: true }).first().click();
    const editor = page.getByRole('dialog', { name: /Episodes in this file/ });
    await expect(editor.getByText(TITLE, { exact: true })).toBeVisible();
    const selected = editor.locator('ol').getByRole('listitem');
    await expect(selected).toHaveCount(2);
    await selected.nth(1).getByRole('button', { name: 'Move up', exact: true }).click();
    await expect(selected.first()).toContainText('The Quiet Crossing');
    await expect(selected.nth(1)).toContainText('The Lantern Signal');
    await editor.getByLabel('Season filter', { exact: true }).selectOption('2');
    await editor
        .getByLabel('Find an episode by title or number', { exact: true })
        .fill('Dispatch 777');
    const chooser = editor.getByRole('combobox', { name: 'Choose an episode…', exact: true });
    await expect(chooser.getByRole('option')).toHaveCount(2);
    await expect(chooser.getByRole('option', { name: /Observatory Dispatch 777/ })).toHaveCount(1);
    await expect(selected.first()).toContainText('The Quiet Crossing');
    await expect(
        editor.getByText('Estimated from episode runtimes; content not verified', { exact: true }),
    ).toBeVisible();
    await chooser.selectOption('e2eadd04-0000-4000-8000-000000000777');
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(selected).toHaveCount(3);
    await expect(
        editor.getByText(/Changing the episode count clears draft cuts/).first(),
    ).toBeVisible();
    await expect(editor.getByText(/Embedded chapters may still exist/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
        true,
    );
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(editor).toHaveCount(0);
});

test('curated album metadata can be edited and returned to its filtered tracks', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${ALBUM}?tab=tracks&tracks_q=Amber`);
    await expectHydrated(page);
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
    await page.getByRole('button', { name: 'Edit metadata', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Midnight Coastal Collection — Edited');
    const [saved] = await Promise.all([
        page.waitForResponse(
            (response) =>
                response.url().endsWith(`/media/${ALBUM}/metadata`) &&
                response.request().method() === 'PATCH',
        ),
        page.getByRole('button', { name: 'Save Changes', exact: true }).click(),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    expect(saved.request().postDataJSON()).not.toHaveProperty('overview');
    await expect(
        page.getByRole('heading', { name: 'Midnight Coastal Collection — Edited', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open album tracks', exact: true }).click();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
    await expect(page.getByRole('link', { name: /Amber Horizon Mix/ })).toBeVisible();
    await page.goto(`/admin/library/media/${ALBUM}?tab=overview`);
    await expectHydrated(page);
    await expect(
        page.getByRole('heading', { name: 'Midnight Coastal Collection — Edited', exact: true }),
    ).toBeVisible();
    await expect(
        page.getByText('No description yet. Add one with Edit metadata.', { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.evaluate(() => {
        document.querySelector<HTMLElement>('main.main-content')?.scrollTo({ top: 0, left: 0 });
        window.scrollTo(0, 0);
    });
    await page.screenshot({
        path: 'test-results/media-admin-redesign-music.png',
        fullPage: true,
        animations: 'disabled',
    });
});

test('track credits review saves canonical roles without changing its curated album', async ({
    page,
}) => {
    await page.goto(
        `/admin/library/media/${TRACK}?tab=overview&music_from_album=${ALBUM}&tracks_q=Amber&tracks_sort=title`,
    );
    await expectHydrated(page);
    const credits = page.getByRole('region', { name: 'Artist credits', exact: true });
    const rows = credits
        .getByRole('list', { name: 'Proposed credits', exact: true })
        .getByRole('listitem');
    await expect(
        credits.getByRole('searchbox', { name: 'Find an artist', exact: true }),
    ).toBeVisible();
    while (
        await credits.getByRole('button', { name: 'Remove credit from draft', exact: true }).count()
    ) {
        await credits
            .getByRole('button', { name: 'Remove credit from draft', exact: true })
            .first()
            .click();
    }
    for (const name of ['Signal Harbour Lead', 'Tidal Ridge Guest']) {
        await credits.getByRole('searchbox', { name: 'Find an artist', exact: true }).fill(name);
        await credits.getByRole('button', { name, exact: true }).click();
    }
    await credits.getByLabel('New artist name', { exact: true }).fill('Prism Quay Fixture Guest');
    await credits.getByRole('button', { name: 'Add new artist to draft', exact: true }).click();
    await credits.getByLabel('Add as', { exact: true }).selectOption('remixer');
    await credits
        .getByRole('searchbox', { name: 'Find an artist', exact: true })
        .fill('Copper Lantern Remixer');
    await credits.getByRole('button', { name: 'Copper Lantern Remixer', exact: true }).click();
    await expect(rows).toHaveCount(4);
    await rows.nth(1).getByRole('button', { name: 'Move credit up', exact: true }).click();
    await rows.first().getByLabel('Credited as', { exact: true }).fill('Tidal Ridge');
    const [saved] = await Promise.all([
        page.waitForResponse(
            (response) =>
                response.url().endsWith(`/media/${TRACK}/metadata`) &&
                response.request().method() === 'PATCH',
        ),
        credits.getByRole('button', { name: 'Save artists and remixers', exact: true }).click(),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    await expect(credits.getByRole('status')).toContainText(
        'Artist credits saved, protected and reloaded',
    );
    await page.reload();
    await expectHydrated(page);
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText('Tidal Ridge Guest');
    await expect(rows.first().getByLabel('Credited as', { exact: true })).toHaveValue(
        'Tidal Ridge',
    );
    await expect(rows.nth(1)).toContainText('Signal Harbour Lead');
    await expect(rows.nth(2)).toContainText('Prism Quay Fixture Guest');
    await expect(rows.nth(3).getByLabel('Credit role', { exact: true })).toHaveValue('remixer');
    await expect(credits).toContainText('Harbour Lights Collective');
    await credits.screenshot({
        path: 'test-results/media-admin-redesign-credits.png',
        animations: 'disabled',
    });
    await expect(page.getByRole('heading', { name: /^Amber Horizon Mix/ })).toBeVisible();
    await page.getByRole('link', { name: 'Back to album tracks', exact: true }).click();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
    await expect(page.getByLabel('Track order', { exact: true })).toHaveValue('title');
});

test('credited artist tracks reach another owner album and retain their review context', async ({
    page,
}) => {
    await page.goto(
        `/admin/library/media/${CREDIT_GUEST}?tab=tracks&tracks_q=Amber&tracks_sort=title`,
    );
    await expectHydrated(page);
    await expect(page.getByRole('tab', { name: /^Tracks(?:\s|$)/ })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(
        page.getByRole('heading', { name: 'Tidal Ridge Guest', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
    await expect(
        page.getByRole('link', { name: 'Midnight Coastal Collection — Edited', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Amber Horizon Mix — Reviewed', exact: true }).click();
    await expect(
        page.getByRole('link', { name: 'Back to artist tracks', exact: true }),
    ).toBeVisible();
    await page.getByRole('tab', { name: /^Files(?:\s|$)/ }).click();
    await page.getByRole('link', { name: 'Back to artist tracks', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/library/media/${CREDIT_GUEST}\\?`));
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
    await expect(page.getByLabel('Track order', { exact: true })).toHaveValue('title');
    await expect(
        page.getByRole('link', { name: 'Amber Horizon Mix — Reviewed', exact: true }),
    ).toBeVisible();
    await page
        .getByRole('link', { name: 'Midnight Coastal Collection — Edited', exact: true })
        .click();
    await expect(
        page.getByRole('link', { name: 'Back to artist tracks', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('');
    await page.getByLabel('Find a track', { exact: true }).fill('Reviewed');
    await page.getByRole('link', { name: 'Amber Horizon Mix — Reviewed', exact: true }).click();
    await page.getByRole('link', { name: 'Back to album tracks', exact: true }).click();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Reviewed');
    await page.getByRole('link', { name: 'Back to artist tracks', exact: true }).click();
    await expect(
        page.getByRole('heading', { name: 'Tidal Ridge Guest', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
    await page.getByRole('link', { name: 'Amber Horizon Mix — Reviewed', exact: true }).click();
    await page
        .getByRole('link', { name: 'Review album ownership separately', exact: true })
        .click();
    await expect(page.getByLabel('Title', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Open album tracks', exact: true }).click();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('');
    await page.getByLabel('Find a track', { exact: true }).fill('Reviewed');
    await page.getByRole('link', { name: 'Amber Horizon Mix — Reviewed', exact: true }).click();
    await page.getByRole('link', { name: 'Back to album tracks', exact: true }).click();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Reviewed');
    await page.getByRole('link', { name: 'Back to artist tracks', exact: true }).click();
    await expect(page.getByLabel('Find a track', { exact: true })).toHaveValue('Amber');
});

test('metadata provider links use the actual series hierarchy in both identity views', async ({
    page,
}) => {
    for (const [id, ownId, href] of [
        [SERIES, '72900001', 'https://www.themoviedb.org/tv/72900001'],
        [SEASON, '72900002', 'https://www.themoviedb.org/tv/72900001/season/1'],
        [SECOND, '72900003', 'https://www.themoviedb.org/tv/72900001/season/1/episode/2'],
    ]) {
        await page.goto(`/admin/library/media/${id}?tab=sync`);
        await expectHydrated(page);
        await expect(page.getByRole('link', { name: ownId, exact: true })).toHaveAttribute(
            'href',
            href,
        );
        const [identityResponse] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().endsWith(`/media/${id}/external-ids`) &&
                    response.request().method() === 'GET',
            ),
            page.getByRole('button', { name: 'Manage', exact: true }).click(),
        ]);
        expect(identityResponse.status(), await identityResponse.text()).toBe(200);
        await expect(
            page.getByRole('link', { name: new RegExp(`^TMDB .*${ownId}$`) }),
        ).toHaveAttribute('href', href);
    }
    const identityPanel = page
        .getByRole('heading', { name: 'External IDs', exact: true })
        .locator('../..');
    await identityPanel.getByTitle('Edit', { exact: true }).click();
    await identityPanel.locator('input[type="text"]').first().fill('72900013');
    const [updated] = await Promise.all([
        page.waitForResponse(
            (response) =>
                response.url().endsWith(`/media/${SECOND}/external-ids`) &&
                response.request().method() === 'PUT',
        ),
        identityPanel.getByTitle('Save', { exact: true }).click(),
    ]);
    expect(updated.status(), await updated.text()).toBe(200);
    await expect(
        page.getByRole('link', { name: 'TMDB · episode · 72900013', exact: true }),
    ).toHaveAttribute('href', 'https://www.themoviedb.org/tv/72900001/season/1/episode/2');
    await page.goto(`/admin/library/media/${INCOMPLETE_EPISODE}?tab=sync`);
    await expectHydrated(page);
    await expect(page.getByText('TMDB · episode · 72900011', { exact: true })).toBeVisible();
    await expect(page.locator('a[href^="https://www.themoviedb.org/"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    await expect(page.getByText('TMDB · episode · 72900011', { exact: true })).toBeVisible();
    await expect(page.locator('a[href^="https://www.themoviedb.org/"]')).toHaveCount(0);
});

test('saving an estimated cut preserves its provenance after a fresh page load', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${SERIES}?tab=files`);
    await expectHydrated(page);
    await page.getByRole('button', { name: 'Episodes in file', exact: true }).first().click();
    const editor = page.getByRole('dialog', { name: /Episodes in this file/ });
    await editor.getByRole('button', { name: 'Even split', exact: true }).click();
    const [saved] = await Promise.all([
        page.waitForResponse(
            (response) =>
                response.url().endsWith(`/files/${FILE}/episodes`) &&
                response.request().method() === 'PUT',
        ),
        editor.getByRole('button', { name: 'Save links', exact: true }).click(),
    ]);
    expect(saved.status(), await saved.text()).toBe(200);
    await expect(
        editor.getByText(
            'Saved and reloaded episode links. The order and windows below are now the saved mapping.',
            { exact: true },
        ),
    ).toBeVisible();
    await expect(
        editor.getByText('Estimated equal split; content not verified', { exact: true }),
    ).toBeVisible();
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await expectHydrated(page);
    await page.getByRole('button', { name: 'Episodes in file', exact: true }).first().click();
    await expect(
        editor.getByText('Estimated equal split; content not verified', { exact: true }),
    ).toBeVisible();
    await expect(editor.getByText('Saved manual boundary', { exact: true })).toHaveCount(0);
    await editor.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(
        page
            .getByRole('region', { name: 'Episode mappings and boundaries' })
            .getByText(/Estimated equal split; content not verified/)
            .first(),
    ).toBeVisible();
});

test('touch overflow reveals remaining episode languages without opening track details', async ({
    browser,
    baseURL,
    context,
}) => {
    const touchContext = await browser.newContext({
        baseURL,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
        extraHTTPHeaders: ADMIN_FORWARD_AUTH_HEADERS,
    });
    let finishNetwork: (() => Promise<void>) | undefined;
    try {
        const touchPage = await touchContext.newPage();
        finishNetwork = observeNetworkChanges(touchPage, test.info());
        touchPage.on('pageerror', (error) =>
            uncaughtPageErrors.get(context)?.push({ page: touchPage, message: error.message }),
        );
        await touchPage.goto(`/admin/library/media/${LANGUAGE_SERIES}?tab=episodes`);
        await expectHydrated(touchPage);
        const playback = touchPage
            .getByTestId('episode-language-summary')
            .filter({ hasText: 'Japanese' })
            .getByRole('region', { name: 'Playback file languages', exact: true });
        await playback.getByRole('button', { name: 'Audio: +1 more', exact: true }).tap();
        const languages = touchPage.getByRole('region', { name: 'Audio', exact: true });
        for (const language of ['Japanese', 'German', 'Italian', 'Spanish']) {
            await expect(languages).toContainText(language);
        }
        await expect(languages).toBeVisible();
        await expect(playback.locator('details').first()).not.toHaveAttribute('open', '');
        await touchPage.screenshot({
            path: 'test-results/media-admin-redesign-language-touch.png',
            animations: 'disabled',
            fullPage: true,
        });
    } finally {
        await finishNetwork?.();
        await touchContext.close();
    }
});

test('episode language summaries preserve default release, sidecars and alternate version differences', async ({
    page,
}) => {
    await page.goto(`/admin/library/media/${LANGUAGE_SERIES}?tab=episodes`);
    await expectHydrated(page);
    const episodeSummary = page
        .getByTestId('episode-language-summary')
        .filter({ hasText: 'Japanese' });
    await expect(episodeSummary).toBeVisible();
    const playback = episodeSummary.getByRole('region', {
        name: 'Playback file languages',
        exact: true,
    });
    // The compact line shows three languages in the viewer's configured order;
    // the fourth audio language is available through the overflow disclosure.
    for (const language of ['English', 'French', 'Unknown language']) {
        await expect(playback.locator('summary').first()).toContainText(language);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.screenshot({
        path: 'test-results/media-admin-redesign-language-row.png',
        animations: 'disabled',
        fullPage: true,
    });
    const compactBounds = await playback.boundingBox();
    expect(compactBounds?.height).toBeLessThanOrEqual(64);
    const overflow = playback.getByRole('button', { name: 'Audio: +1 more', exact: true });
    await overflow.focus();
    const languages = page.getByRole('region', { name: 'Audio', exact: true });
    for (const language of ['Japanese', 'German', 'Italian', 'Spanish']) {
        await expect(languages).toContainText(language);
    }
    await overflow.blur();
    await playback.getByLabel('Language details', { exact: true }).click();
    await expect(playback.locator('details').first()).toHaveAttribute('open', '');
    await expect(playback.getByText('French · forced · external', { exact: true })).toBeVisible();
    await expect(playback).toContainText('forced');
    await expect(playback).toContainText('external');
    await page
        .getByRole('cell')
        .filter({ hasText: 'The Moonlit Archive' })
        .getByText('The Moonlit Archive', { exact: true })
        .click();
    await page.getByRole('button', { name: 'Open Detail Page', exact: true }).click();
    await expect(
        page.getByRole('heading', { name: 'The Moonlit Archive', exact: true }),
    ).toBeVisible();
    const overviewLanguages = page.getByRole('region', {
        name: 'Playback file languages',
        exact: true,
    });
    await overviewLanguages.getByLabel('Language details', { exact: true }).click();
    await expect(overviewLanguages.getByText('Japanese · default', { exact: true })).toBeVisible();
    await expect(overviewLanguages.locator('summary').first()).toContainText('French');
    await page.getByRole('tab', { name: /^Files(?:\s|$)/ }).click();
    const fileLanguages = page.getByRole('region', { name: 'File languages', exact: true });
    await expect(fileLanguages).toHaveCount(2);
    const original = fileLanguages.filter({ hasText: 'Japanese' });
    await expect(original.locator('summary').first()).toContainText('German');
    await expect(original.locator('summary').first()).toContainText('French');
    const dub = fileLanguages.filter({ hasText: 'None found' });
    await expect(dub.locator('summary').first()).toContainText('English');
    await expect(dub.locator('summary').first()).toContainText('None found');
    await expect(dub.getByText('Japanese', { exact: true })).toHaveCount(0);
    await expect(dub.getByText('French', { exact: true })).toHaveCount(0);
    await page.screenshot({
        path: 'test-results/media-admin-redesign-languages.png',
        animations: 'disabled',
        fullPage: true,
    });
});

test('an unprobed episode does not claim to have no audio or subtitles', async ({ page }) => {
    await page.goto(`/admin/library/media/${UNKNOWN_EPISODE}`);
    await expectHydrated(page);
    const languages = page.getByRole('region', { name: 'Playback file languages', exact: true });
    await expect(languages.locator('summary').first()).toContainText('Unknown (not probed)');
    await expect(languages.getByText('None found', { exact: true })).toHaveCount(0);
});

test('analysis readiness follows replacement input without remounting the episode', async ({
    page,
    request,
}) => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
        await page.goto(
            `/admin/library/media/${UNKNOWN_EPISODE}?tab=maintenance&section=processing`,
        );
        await expectHydrated(page);
        const generate = page.getByRole('button', { name: 'Generate', exact: true });
        await expect(generate, await page.locator('body').innerText()).toBeDisabled();
        await expect(page.getByText(/Awaiting a present, probed video file/)).toBeVisible();
        const rejected = await request.post(`/api/admin/media/${UNKNOWN_EPISODE}/segments`, {
            data: { scope: 'single' },
        });
        expect(rejected.status(), await rejected.text()).toBe(409);

        // A separate worker verifies the replacement. The open page must reconcile
        // canonical data rather than require an admin to queue a doomed analysis.
        await sql`UPDATE media_files SET probed_at = now(), duration_seconds = 120,
            file_size_bytes = 12000000 WHERE id = ${UNPROBED_FILE}`;
        await sql`INSERT INTO media_streams(file_id,stream_type,stream_index,codec)
            VALUES (${UNPROBED_FILE},'video',0,'h264')`;
        // A read started before the fixture update may finish first. The
        // focus reconciler queues another read; require that canonical result
        // within five seconds, before the 15-second periodic refresh can help.
        const ready = page.waitForResponse(
            async (response) => {
                if (
                    !response.url().endsWith(`/media/${UNKNOWN_EPISODE}/segments`) ||
                    response.request().method() !== 'GET'
                )
                    return false;
                if (response.status() !== 200) return true;
                const body = (await response.json()) as {
                    analysisInputs?: Array<{ state: string }>;
                };
                return body.analysisInputs?.[0]?.state === 'ready';
            },
            { timeout: 5000 },
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        const readyResponse = await ready;
        expect(readyResponse.status(), await readyResponse.text()).toBe(200);
        const readyData = await readyResponse.json();
        expect(readyData.analysisInputs[0]).toMatchObject({
            state: 'ready',
            fileId: UNPROBED_FILE,
            proof: null,
        });
        await expect(generate).toBeEnabled();
        await expect(page.getByText(/Awaiting a present, probed video file/)).toHaveCount(0);

        // Another replacement under the same UUID has not been verified yet.
        await sql`UPDATE media_files SET probed_at = NULL, duration_seconds = NULL,
            file_size_bytes = 18000000 WHERE id = ${UNPROBED_FILE}`;
        await sql`DELETE FROM media_streams WHERE file_id = ${UNPROBED_FILE}`;
        // A read started before the fixture update may finish first. The
        // focus reconciler queues another read; require that canonical result
        // within five seconds, before the 15-second periodic refresh can help.
        const pending = page.waitForResponse(
            async (response) => {
                if (
                    !response.url().endsWith(`/media/${UNKNOWN_EPISODE}/segments`) ||
                    response.request().method() !== 'GET'
                )
                    return false;
                if (response.status() !== 200) return true;
                const body = (await response.json()) as {
                    analysisInputs?: Array<{ state: string }>;
                };
                return body.analysisInputs?.[0]?.state === 'awaiting-input';
            },
            { timeout: 5000 },
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        const pendingResponse = await pending;
        expect(pendingResponse.status(), await pendingResponse.text()).toBe(200);
        const pendingData = await pendingResponse.json();
        expect(pendingData.analysisInputs[0]).toMatchObject({
            state: 'awaiting-input',
            inputIdentity: null,
            proof: null,
        });
        await expect(generate).toBeDisabled();
        await expect(page.getByText(/Awaiting a present, probed video file/)).toBeVisible();
        await expect(page).toHaveURL(
            new RegExp(`${UNKNOWN_EPISODE}\\?tab=maintenance&section=processing$`),
        );
    } finally {
        await sql`DELETE FROM media_streams WHERE file_id = ${UNPROBED_FILE}`;
        await sql`UPDATE media_files SET probed_at = NULL, duration_seconds = 120,
            file_size_bytes = NULL WHERE id = ${UNPROBED_FILE}`;
        await sql.end();
    }
});

test('Health replaces changed physical rows with the same count and opens unlinked mapping review', async ({
    page,
    request,
}) => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    const firstId = 'e2eadd07-0000-4000-8000-000000000001';
    const secondId = 'e2eadd07-0000-4000-8000-000000000002';
    const firstName = 'coastal-health-first.mkv';
    const secondName = 'coastal-health-unlinked.mkv';
    const warning = [{ type: 'episode_number_unparsed', detected_at: new Date().toISOString() }];
    try {
        await sql`INSERT INTO media_files(id,file_path,duration_seconds,health_issues)
            VALUES (${firstId},${`/nonexistent/lumastra-e2e/${firstName}`},150,${sql.json(warning)}),
                   (${secondId},${`/nonexistent/lumastra-e2e/${secondName}`},150,NULL)`;
        const before = await request.get('/api/admin/media/file-health');
        expect(before.status(), await before.text()).toBe(200);
        const beforeData = await before.json();
        await page.goto('/admin/system/health#files');
        await expectHydrated(page);
        const files = page.locator('#files');
        await expect(files.getByText(firstName, { exact: true })).toBeVisible();
        await expect(files.getByText(secondName, { exact: true })).toHaveCount(0);

        await sql.begin(async (tx) => {
            await tx`UPDATE media_files SET health_issues=NULL,updated_at=now() WHERE id=${firstId}`;
            await tx`UPDATE media_files SET health_issues=${sql.json(warning)},updated_at=now()
                WHERE id=${secondId}`;
        });
        const refresh = page.waitForResponse(
            (response) =>
                new URL(response.url()).pathname === '/api/admin/media/file-health' &&
                response.request().method() === 'GET',
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        const refreshed = await (await refresh).json();
        expect(refreshed.count).toBe(beforeData.count);
        await expect(files.getByText(firstName, { exact: true })).toHaveCount(0);
        const row = files.getByText(secondName, { exact: true }).locator('../../..');
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: 'Review episode mapping', exact: true }).click();
        const editor = page.getByRole('dialog', { name: /Episodes in this file/ });
        await expect(
            editor.getByText('Select a series to review this file’s episode mapping.'),
        ).toBeVisible();
        await expect(
            editor.getByRole('button', { name: 'Save links', exact: true }),
        ).toBeDisabled();
        await editor
            .getByRole('searchbox', { name: 'Search for a series', exact: true })
            .fill(TITLE);
        await editor.getByRole('button', { name: `${TITLE} (2001)`, exact: true }).click();
        await expect(
            editor.getByRole('combobox', { name: 'Choose an episode…', exact: true }),
        ).toBeVisible();
        await expect(
            editor.getByText('Could not load the episode links', { exact: true }),
        ).toHaveCount(0);
        await editor.getByRole('button', { name: 'Close', exact: true }).click();
    } finally {
        await sql`DELETE FROM media_file_items WHERE file_id IN (${firstId},${secondId})`;
        await sql`DELETE FROM media_files WHERE id IN (${firstId},${secondId})`;
        await sql.end();
    }
});

// Keep this spec's data isolated from other browser suites and later runs.
test('competing mapping edits preserve stale drafts and require fresh review for Save and reset', async ({
    page,
    request,
}) => {
    const endpoint = `/api/admin/media/${SERIES}/files/${FILE}/episodes`;
    const savedMapping = async () => {
        const response = await request.get(endpoint);
        expect(response.status(), await response.text()).toBe(200);
        return response.json();
    };
    const openEditor = async (editorPage: typeof page) => {
        await editorPage.goto(`/admin/library/media/${SERIES}?tab=files`);
        await expectHydrated(editorPage);
        await editorPage
            .getByRole('button', { name: 'Episodes in file', exact: true })
            .first()
            .click();
        const dialog = editorPage.getByRole('dialog', { name: /Episodes in this file/ });
        await expect(dialog.getByLabel('Episode 2 starts at', { exact: true })).toBeVisible();
        return dialog;
    };
    const submit = async (editorPage: typeof page, method: 'PUT' | 'DELETE') => {
        const [response] = await Promise.all([
            editorPage.waitForResponse(
                (response) =>
                    response.url().endsWith(`/files/${FILE}/episodes`) &&
                    response.request().method() === method,
            ),
            editorPage
                .getByRole('dialog', { name: /Episodes in this file/ })
                .getByRole('button', { name: 'Save links', exact: true })
                .click(),
        ]);
        return response;
    };
    const otherPage = await page.context().newPage();
    try {
        const firstEditor = await openEditor(page);
        const otherEditor = await openEditor(otherPage);
        const draftCut = otherEditor.getByLabel('Episode 2 starts at', { exact: true });
        await draftCut.fill('1:02.0');
        await firstEditor.getByLabel('Episode 2 starts at', { exact: true }).fill('1:01.0');
        expect((await submit(page, 'PUT')).status()).toBe(200);
        const firstSaved = await savedMapping();
        expect(firstSaved.links[1].startMs).toBe(61000);

        expect((await submit(otherPage, 'PUT')).status()).toBe(409);
        await expect(
            otherEditor.getByText(/Your draft is kept\. Reload the current evidence/),
        ).toBeVisible();
        await expect(draftCut).toHaveValue('1:02.0');
        await expect(
            otherEditor.getByRole('button', { name: 'Save links', exact: true }),
        ).toBeDisabled();
        expect(await savedMapping()).toEqual(firstSaved);
        await otherEditor.getByRole('button', { name: 'Reload episodes', exact: true }).click();
        await expect(otherEditor.getByText(/Current evidence reloaded/)).toBeVisible();
        await expect(draftCut).toHaveValue('1:02.0');
        expect((await submit(otherPage, 'PUT')).status()).toBe(200);
        const secondSaved = await savedMapping();
        expect(secondSaved.links[1].startMs).toBe(62000);

        // The first editor still holds its earlier review. Reset must use the
        // same stale-write guard as Save, rather than deleting a newer edit.
        await firstEditor.getByRole('button', { name: 'Back to automatic', exact: true }).click();
        expect((await submit(page, 'DELETE')).status()).toBe(409);
        expect(await savedMapping()).toEqual(secondSaved);
        await firstEditor.getByRole('button', { name: 'Reload episodes', exact: true }).click();
        await expect(firstEditor.getByText(/Current evidence reloaded/)).toBeVisible();
        expect((await submit(page, 'DELETE')).status()).toBe(200);
        const reset = await savedMapping();
        expect(reset.file.manual).toBe(false);
        expect(reset.links).toHaveLength(2);
        expect(
            reset.links.every(
                (link: { offsetSource: string | null }) => link.offsetSource !== 'manual',
            ),
        ).toBe(true);
        await firstEditor.getByRole('button', { name: 'Close', exact: true }).click();
        await page.reload();
        await expectHydrated(page);
        expect((await savedMapping()).revision).toBe(reset.revision);
    } finally {
        await otherPage.close();
    }
});

test('review reload identifies a removed draft episode before allowing another Save', async ({
    page,
}) => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
        await page.goto(`/admin/library/media/${SERIES}?tab=files`);
        await expectHydrated(page);
        await page.getByRole('button', { name: 'Episodes in file', exact: true }).first().click();
        const editor = page.getByRole('dialog', { name: /Episodes in this file/ });
        await expect(editor.getByLabel('Episode 2 starts at', { exact: true })).toBeVisible();
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${SECOND}`;
        const [conflict] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().endsWith(`/files/${FILE}/episodes`) &&
                    response.request().method() === 'PUT',
            ),
            editor.getByRole('button', { name: 'Save links', exact: true }).click(),
        ]);
        expect(conflict.status()).toBe(409);
        await editor.getByRole('button', { name: 'Reload episodes', exact: true }).click();
        await expect(editor.getByText(/Current evidence reloaded/)).toBeVisible();
        // The retained row remains readable and removable, but cannot be
        // silently submitted into a hierarchy it no longer belongs to.
        const staleRow = editor.locator('ol > li').filter({ hasText: 'The Quiet Crossing' });
        await expect(staleRow).toBeVisible();
        await expect(
            editor.getByRole('button', { name: 'Save links', exact: true }),
        ).toBeDisabled();
        await staleRow.getByRole('button', { name: 'Remove', exact: true }).click();
        await expect(editor.getByRole('button', { name: 'Save links', exact: true })).toBeEnabled();
        const [saved] = await Promise.all([
            page.waitForResponse(
                (response) =>
                    response.url().endsWith(`/files/${FILE}/episodes`) &&
                    response.request().method() === 'PUT',
            ),
            editor.getByRole('button', { name: 'Save links', exact: true }).click(),
        ]);
        expect(saved.status(), await saved.text()).toBe(200);
    } finally {
        await sql`UPDATE media_items SET status = 'active' WHERE id = ${SECOND}`;
        await sql.end();
    }
});

test.afterAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !/lumastra_(?:t_|tests)/.test(new URL(databaseUrl).pathname)) return;
    const sql = postgres(databaseUrl, { max: 1 });
    try {
        const languageFiles = [LANGUAGE_FILE, DUB_FILE, UNPROBED_FILE];
        await sql`DELETE FROM external_subtitle_files WHERE file_id = ANY(${languageFiles})`;
        await sql`DELETE FROM media_file_items WHERE file_id = ANY(${languageFiles})`;
        await sql`DELETE FROM media_streams WHERE file_id = ANY(${languageFiles})`;
        await sql`DELETE FROM media_files WHERE id = ANY(${languageFiles})`;
        for (const id of [LANGUAGE_EPISODE, UNKNOWN_EPISODE, LANGUAGE_SEASON, LANGUAGE_SERIES]) {
            await sql`DELETE FROM media_items WHERE id = ${id}`;
        }
        await sql`DELETE FROM media_file_items WHERE file_id IN (${FILE}, ${AUDIO_FILE}, ${ORIGINAL_FILE}, ${REMASTER_FILE})`;
        await sql`DELETE FROM media_streams WHERE file_id IN (${ORIGINAL_FILE}, ${REMASTER_FILE})`;
        await sql`DELETE FROM media_files WHERE id IN (${FILE}, ${AUDIO_FILE}, ${ORIGINAL_FILE}, ${REMASTER_FILE})`;
        await sql`DELETE FROM media_items WHERE parent_id = ${ALBUM}`;
        await sql`DELETE FROM media_items WHERE parent_id = ${SECOND_SEASON}`;
        await sql`DELETE FROM media_items WHERE id = ${SECOND_SEASON}`;
        await sql`DELETE FROM media_items WHERE id = ANY(${BROWSER_MOVIES.map((movie) => movie.id)})`;
        await sql`DELETE FROM media_items WHERE media_type='artist' AND title='Prism Quay Fixture Guest'`;
        for (const id of [
            TRACK,
            TRACK_TWO,
            ALBUM,
            ARTIST,
            FIRST,
            SECOND,
            SEASON,
            SERIES,
            METADATA_MATCH,
            MOVIE,
            CREDIT_LEAD,
            CREDIT_GUEST,
            CREDIT_REMIXER,
            INCOMPLETE_EPISODE,
            INCOMPLETE_SEASON,
            INCOMPLETE_SERIES,
        ]) {
            await sql`DELETE FROM media_items WHERE id = ${id}`;
        }
    } finally {
        await sql.end();
    }
});
