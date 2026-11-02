// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Focused browser coverage for the five admin repair flows in the media fix bundle.
 * Keep this as real-server UI coverage: no page.route/API response substitutes.
 */
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Page } from '@playwright/test';
import { AudioTailAssessmentSchema } from '../src/lib/schemas/audio-tail-assessment';
import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';
import { withoutNetworkChangeErrors } from './helpers/network-changes';

type Fixture = {
    sql: postgres.Sql;
    ids: string[];
};

const pageErrors = new WeakMap<Page, string[]>();

async function screenshot(page: Page, name: string): Promise<void> {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
        true,
    );
    await page.screenshot({
        path: test.info().outputPath(`${name}.png`),
        fullPage: false,
        animations: 'disabled',
    });
}

function disposableDatabase(): string {
    const value = process.env.DATABASE_URL;
    if (!value || !/^\/lumastra_(?:t_[\w-]+|tests|e2e)$/.test(new URL(value).pathname)) {
        throw new Error(
            'Five-fix admin E2E requires an isolated lumastra_t_* or lumastra_tests database',
        );
    }
    return value;
}

async function fixture(): Promise<Fixture> {
    return { sql: postgres(disposableDatabase(), { max: 1 }), ids: [] };
}

async function cleanup(db: Fixture): Promise<void> {
    const ids = [...db.ids];
    try {
        if (ids.length) {
            await db.sql`DELETE FROM sync_quarantine WHERE expected_series_id = ANY(${ids}::uuid[]) OR external_id = ANY(${ids})`;
            await db.sql`DELETE FROM media_file_items WHERE media_item_id = ANY(${ids}::uuid[]) OR file_id = ANY(${ids}::uuid[])`;
            await db.sql`DELETE FROM image_candidates WHERE media_item_id = ANY(${ids}::uuid[])`;
            await db.sql`DELETE FROM external_ids WHERE media_id = ANY(${ids}::uuid[])`;
            await db.sql`DELETE FROM media_files WHERE id = ANY(${ids}::uuid[])`;
            await db.sql`DELETE FROM media_items WHERE parent_id = ANY(${ids}::uuid[])`;
            await db.sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
            await db.sql`DELETE FROM library_groups WHERE id = ANY(${ids}::uuid[])`;
        }
    } finally {
        await db.sql.end();
    }
}

function ids(db: Fixture, count: number): string[] {
    const values = Array.from({ length: count }, () => randomUUID());
    db.ids.push(...values);
    return values;
}

function numericTmdbId(seed: string): string {
    const digest = createHash('sha256').update(seed).digest('hex').slice(0, 12);
    return String((Number.parseInt(digest, 16) % 80_000_000) + 10_000_000);
}

async function seedEpisodeTree(db: Fixture, options: { withFile?: boolean; title?: string } = {}) {
    const [series, season, first, second, file] = ids(db, 5);
    const title = options.title ?? `Five Fix Coastal Fixture ${series.slice(0, 8)}`;
    try {
        await db.sql`INSERT INTO media_items (id,title,media_type,status,has_files)
            VALUES (${series},${title},'tv','active',TRUE)`;
        await db.sql`INSERT INTO media_items (id,title,media_type,parent_id,season_number,status,has_files)
            VALUES (${season},'Season 1','season',${series},1,'active',TRUE)`;
        await db.sql`INSERT INTO media_items (id,title,media_type,parent_id,season_number,episode_number,status,has_files,title_binding)
            VALUES (${first},'The First Tide','episode',${season},1,1,'active',TRUE,'position'),
                   (${second},'The Second Tide','episode',${season},1,2,'active',TRUE,'position')`;
        if (options.withFile) {
            await db.sql`INSERT INTO media_files (id,file_path,duration_seconds,file_size_bytes,container_format,is_missing)
                VALUES (${file},${`/nonexistent/lumastra-e2e/five-fix-${file}.mkv`},240,1000000,'matroska',TRUE)`;
            await db.sql`INSERT INTO media_file_items (file_id,media_item_id,is_default,start_offset_ms,end_offset_ms)
                VALUES (${file},${first},TRUE,0,120000),(${file},${second},TRUE,120000,240000)`;
        }
        return { series, season, first, second, file, title };
    } catch (error) {
        await cleanup(db);
        throw error;
    }
}

const viewports = [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
] as const;

for (const viewport of viewports) {
    test.describe(`five admin fixes · ${viewport.name}`, () => {
        test.beforeEach(async ({ page }) => {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const errors: string[] = [];
            pageErrors.set(page, errors);
            page.on('pageerror', (error) => errors.push(error.message));
        });

        test.afterEach(async ({ page }, info) => {
            if (
                info.expectedStatus === 'skipped' &&
                info.annotations.some((annotation) => annotation.type === 'environment-quarantine')
            )
                return;
            expect(
                withoutNetworkChangeErrors(page, pageErrors.get(page) ?? []),
                'uncaught browser errors',
            ).toEqual([]);
        });

        test('shared episode thumbnails show source and protected missing-file state', async ({
            page,
        }) => {
            const db = await fixture();
            const tree = await seedEpisodeTree(db, { withFile: true });
            const [thumbA, thumbB] = ids(db, 2);
            const sharedPath = `/nonexistent/lumastra-e2e/shared-thumb-${thumbA}.jpg`;
            try {
                await db.sql`INSERT INTO image_candidates (id,media_item_id,artwork_type,source,file_path,provider,chosen_by,selected,locked)
                    VALUES (${thumbA},${tree.first},'thumb','local',${sharedPath},'local-folder','admin',TRUE,TRUE),
                           (${thumbB},${tree.second},'thumb','local',${sharedPath},'local-folder','auto',TRUE,FALSE)`;
                await page.goto(`/admin/library/media/${tree.series}?tab=artwork`);
                await expectHydrated(page);
                const review = page.locator('details[aria-label="Optional episode pictures"]');
                await expect(review).toHaveJSProperty('open', false);
                await review
                    .getByText('Choose separate episode pictures (optional)', { exact: true })
                    .click();
                await expect(review).toContainText('The First Tide');
                await expect(review).toContainText('The Second Tide');
                await expect(review).toContainText(`five-fix-${tree.file}.mkv`);
                const firstRow = review.locator('li').filter({ hasText: 'The First Tide' });
                await expect(firstRow).toContainText('shared');
                await expect(firstRow).toContainText('Locked');
                await expect(firstRow).toContainText('Manual choice');
                await expect(
                    firstRow.getByRole('button', {
                        name: 'Choose a separate picture',
                        exact: true,
                    }),
                ).toBeDisabled();
                await expect(review).toContainText('shared-thumb-');
                expect(
                    await page.evaluate(
                        () => document.documentElement.scrollWidth <= innerWidth + 1,
                    ),
                ).toBe(true);
                await review.scrollIntoViewIfNeeded();
                await expect(review).toBeInViewport();
                await screenshot(page, `shared-thumbnail-${viewport.name}`);
            } finally {
                // Cancel page refreshes before deleting the records they read.
                await page.goto('about:blank').catch(() => {});
                await cleanup(db);
            }
        });

        for (const alreadyResolved of [false, true]) {
            test(`collaboration review ${alreadyResolved ? 'acknowledges resolved credits' : 'applies selected credits'} and preserves album ownership`, async ({
                page,
            }) => {
                const db = await fixture();
                const [group, collab, memberA, memberB, album, track, trackFile, dismissed] = ids(
                    db,
                    8,
                );
                const suffix = collab.slice(0, 8);
                const memberAName = `Harbour Lights ${suffix}`;
                const memberBName = `Tidal Ridge ${suffix}`;
                const collaborationName = `${memberAName} & ${memberBName}`;
                const queue = `/admin/library/media?filter=music-artist-unsplit&domain=music&type=artist&q=${suffix}&sort=title&order=asc&layout=list`;
                try {
                    await db.sql`INSERT INTO library_groups (id,name) VALUES (${group},${`five-fix-${suffix}`})`;
                    await db.sql`INSERT INTO media_items (id,title,media_type,status,has_files,custom_metadata)
                    VALUES (${collab},${collaborationName},'artist','active',TRUE,'{}'),
                           (${memberA},${memberAName},'artist','active',TRUE,'{}'),
                           (${memberB},${memberBName},'artist','active',TRUE,'{}'),
                           (${album},'Night Crossing Sessions','album','active',TRUE,'{}')`;
                    await db.sql`UPDATE media_items SET parent_id=${collab} WHERE id=${album}`;
                    await db.sql`INSERT INTO media_items (id,title,media_type,parent_id,status,has_files,custom_metadata)
                    VALUES (${track},'Lanterns at Dawn','track',${album},'active',TRUE,
                    ${db.sql.json({ artist: collaborationName, album_artist: collaborationName })})`;
                    if (alreadyResolved) {
                        await db.sql`UPDATE media_items SET custom_metadata=custom_metadata || ${db.sql.json(
                            {
                                track_artist_credits: [
                                    { id: memberA, credited_name: memberAName },
                                    { id: memberB, credited_name: memberBName },
                                ],
                            },
                        )} WHERE id=${track}`;
                    }
                    await db.sql`INSERT INTO media_files (id,file_path,duration_seconds,library_group_id)
                    VALUES (${trackFile},${`/nonexistent/lumastra-e2e/collaboration-${trackFile}.flac`},180,${group})`;
                    await db.sql`INSERT INTO media_file_items (file_id,media_item_id,is_default)
                    VALUES (${trackFile},${track},TRUE)`;
                    await db.sql`INSERT INTO media_items (id,title,media_type,parent_id,status,is_dismissed,custom_metadata)
                    VALUES (${dismissed},'Hidden duplicate','track',${album},'active',TRUE,
                    ${db.sql.json({ artist: collaborationName })})`;
                    const [hiddenBefore] =
                        await db.sql`SELECT is_dismissed,custom_metadata,xmin::text AS version FROM media_items WHERE id=${dismissed}`;
                    const [activeBefore] =
                        await db.sql`SELECT custom_metadata,xmin::text AS version FROM media_items WHERE id=${track}`;
                    await page.goto(queue);
                    await expectHydrated(page);
                    await expect(
                        page.getByText(`1 items matching "${suffix}"`, { exact: true }),
                    ).toBeVisible();
                    await page
                        .getByRole('button', { name: 'Resolve collaboration', exact: true })
                        .click();
                    const dialog = page.getByRole('dialog', {
                        name: 'Review collaboration credits',
                    });
                    await expect(dialog).toBeVisible();
                    await expect
                        .poll(() =>
                            dialog
                                .locator('..')
                                .evaluate((element) =>
                                    Math.round(element.getBoundingClientRect().top),
                                ),
                        )
                        .toBe(0);
                    await dialog
                        .getByRole('button', { name: 'Close collaboration review', exact: true })
                        .focus();
                    await page.keyboard.press('Shift+Tab');
                    await expect(dialog.locator(':focus')).toHaveCount(1);

                    await dialog.getByLabel('Search existing artists').fill(memberAName);
                    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
                    await dialog.getByRole('button', { name: memberAName, exact: true }).click();
                    await dialog.getByLabel('Search existing artists').fill(memberBName);
                    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
                    await dialog.getByRole('button', { name: memberBName, exact: true }).click();
                    await dialog
                        .getByRole('button', { name: 'Preview credits', exact: true })
                        .click();
                    await expect(dialog).toContainText('Lanterns at Dawn');
                    await expect(dialog).toContainText(
                        `Night Crossing Sessions → ${collaborationName} (unchanged)`,
                    );
                    await dialog
                        .getByRole('heading', { name: 'Track and album impact', exact: true })
                        .scrollIntoViewIfNeeded();
                    await screenshot(page, `collaboration-preview-${viewport.name}`);
                    if (!alreadyResolved) {
                        await dialog
                            .getByRole('checkbox', {
                                name: 'Select Lanterns at Dawn for credit repair',
                            })
                            .check();
                    }

                    // The current flow saves the selected credits directly;
                    // completion is automatic once unresolved tracks are gone.
                    // Album owners and hidden tracks are protected by the API,
                    // and the database assertions below verify both invariants.
                    if (alreadyResolved) {
                        const [unrelated] = ids(db, 1);
                        await db.sql`INSERT INTO media_items (id,title,media_type,custom_metadata) VALUES (${unrelated},'Other arrival','track',${db.sql.json({ artist: 'Unrelated Solo Arrival' })})`;
                    }
                    await dialog
                        .getByRole('button', {
                            name: 'Save selected track credits',
                            exact: true,
                        })
                        .click();
                    await expect(dialog.getByRole('status')).toContainText(
                        alreadyResolved
                            ? 'Review saved. Track credits and album owners are unchanged.'
                            : 'Saved 1 track credits',
                    );
                    await expect(
                        dialog.getByRole('button', {
                            name: 'Show this artist in cleanup again',
                            exact: true,
                        }),
                    ).toBeVisible();
                    const [stored] =
                        await db.sql`SELECT custom_metadata FROM media_items WHERE id=${track}`;
                    const [albumRow] =
                        await db.sql`SELECT parent_id FROM media_items WHERE id=${album}`;
                    const [reviewed] =
                        await db.sql`SELECT custom_metadata->>'collaboration_reviewed' AS marker FROM media_items WHERE id=${collab}`;
                    const [hiddenAfter] =
                        await db.sql`SELECT is_dismissed,custom_metadata,xmin::text AS version FROM media_items WHERE id=${dismissed}`;
                    expect(hiddenAfter).toEqual(hiddenBefore);
                    if (alreadyResolved) {
                        const [activeAfter] =
                            await db.sql`SELECT custom_metadata,xmin::text AS version FROM media_items WHERE id=${track}`;
                        expect(activeAfter).toEqual(activeBefore);
                    }
                    expect(stored.custom_metadata.track_artist_credits).toBeTruthy();
                    expect(albumRow.parent_id).toBe(collab);
                    expect(reviewed.marker).toMatch(/^[a-f0-9]{32}$/);
                    await dialog
                        .getByRole('button', { name: 'Close collaboration review', exact: true })
                        .click();
                    await expect(
                        page.getByText(`0 items matching "${suffix}"`, { exact: true }),
                    ).toBeVisible();
                } finally {
                    // Cancel page refreshes before deleting the records they read.
                    await page.goto('about:blank').catch(() => {});
                    await cleanup(db);
                }
            });
        }

        test('episode online-match picker previews the choice and applies both assignments atomically', async ({
            page,
        }) => {
            const db = await fixture();
            const tree = await seedEpisodeTree(db);
            const firstTmdbId = numericTmdbId(tree.first);
            const secondTmdbId = String(Number(firstTmdbId) + 1);
            try {
                // eslint-disable-next-line no-restricted-syntax -- Seed exact pre-existing provider assignments in the disposable database; the UI exercises the canonical mutation.
                await db.sql`INSERT INTO external_ids (media_id,provider,external_id,media_type,is_primary,source)
                    VALUES (${tree.first},'tmdb',${firstTmdbId},'episode',TRUE,'browser-fixture'),
                           (${tree.second},'tmdb',${secondTmdbId},'episode',TRUE,'browser-fixture')`;
                await page.goto(
                    `/admin/library/media/${tree.first}?tab=maintenance&section=metadata`,
                );
                await expectHydrated(page);
                await page
                    .getByRole('button', {
                        name: 'Swap the online matches for two episodes',
                        exact: true,
                    })
                    .click();
                await page.getByLabel('Other episode in this series').selectOption(tree.second);
                const review = page.locator('div[class*="border-amber-500/50"]');
                await expect(review.getByRole('link')).toHaveCount(2);
                await expect(review).toContainText(firstTmdbId);
                await expect(review).toContainText(secondTmdbId);
                await review.scrollIntoViewIfNeeded();
                await expect(review).toBeInViewport();
                await screenshot(page, `tmdb-exchange-preview-${viewport.name}`);
                await expect(review.getByRole('checkbox')).toHaveCount(0);
                await review.getByRole('button', { name: 'Apply swap', exact: true }).click();
                const savedMessage = page.getByText(/Saved TMDB episode IDs:/);
                await expect(savedMessage).toContainText(firstTmdbId);
                await expect(savedMessage).toContainText(secondTmdbId);
                await expect(
                    page.getByRole('button', { name: 'Undo online match swap', exact: true }),
                ).toBeVisible();
                const rows =
                    await db.sql`SELECT media_id,external_id FROM external_ids WHERE media_id IN (${tree.first},${tree.second}) AND provider='tmdb' ORDER BY media_id`;
                expect(rows).toHaveLength(2);
                expect(rows.find((row) => row.media_id === tree.first)?.external_id).toBe(
                    secondTmdbId,
                );
                expect(rows.find((row) => row.media_id === tree.second)?.external_id).toBe(
                    firstTmdbId,
                );
            } finally {
                // Cancel page refreshes before deleting the records they read.
                await page.goto('about:blank').catch(() => {});
                await cleanup(db);
            }
        });

        test('current-match quarantine preview uses current DB identity and hides only selected warnings', async ({
            page,
        }) => {
            const db = await fixture();
            const tree = await seedEpisodeTree(db, { withFile: true });
            const [warning] = ids(db, 1);
            const seriesTmdbId = numericTmdbId(tree.series);
            const episodeTmdbId = numericTmdbId(tree.first);
            try {
                await db.sql`UPDATE media_items SET title_binding='position' WHERE id=${tree.first}`;
                // Current-match acknowledgement requires a present default file.
                await db.sql`UPDATE media_files SET is_missing=FALSE WHERE id=${tree.file}`;
                // eslint-disable-next-line no-restricted-syntax -- Seed exact pre-existing provider assignments in the disposable database; the UI exercises the canonical mutation.
                await db.sql`INSERT INTO external_ids (media_id,provider,external_id,media_type,is_primary,source)
                    VALUES (${tree.series},'tmdb',${seriesTmdbId},'tv',TRUE,'browser-fixture'),
                           (${tree.first},'tmdb',${episodeTmdbId},'episode',TRUE,'browser-fixture')`;
                await db.sql`INSERT INTO sync_quarantine (id,provider,external_id,media_type,parent_tmdb_id,expected_series_id,reason,source,payload)
                    VALUES (${warning},'lumastra-reconcile',${tree.first},'episode',${seriesTmdbId},${tree.series},
                    'reconcile-backfill:matched','browser-fixture',${db.sql.json({ seriesMediaId: tree.series, seasonNumber: 1, episodeNumber: 1, matchedTmdbEpisodeId: episodeTmdbId, proposedTitle: 'The First Tide' })})`;
                await page.goto('/admin/library/quarantine');
                await expectHydrated(page);
                const row = page.getByRole('row').filter({ hasText: tree.title });
                await expect(row).toBeVisible();
                await row
                    .getByRole('button', { name: 'Review current matches', exact: true })
                    .click();
                const panel = page.getByRole('region', { name: 'Review current matches' });
                await expect(panel).toContainText(`The First Tide`);
                const technical = panel.locator('article details');
                await expect(technical).toHaveJSProperty('open', false);
                await technical.locator('summary').click();
                await expect(technical).toContainText(episodeTmdbId);
                await expect(
                    panel.getByRole('link', { name: 'Review this episode individually' }),
                ).toHaveAttribute(
                    'href',
                    `/admin/library/media/${tree.first}?tab=maintenance&section=metadata`,
                );
                const heading = panel.getByRole('heading', { name: /Review current matches/ });
                expect(
                    await heading.evaluate((element) =>
                        parseFloat(getComputedStyle(element).fontSize),
                    ),
                ).toBeLessThanOrEqual(20);
                const selection = panel.getByRole('checkbox').first();
                await selection.check();
                await panel.scrollIntoViewIfNeeded();
                await expect(panel).toBeInViewport();
                await screenshot(page, `current-match-preview-${viewport.name}`);
                await panel
                    .getByRole('button', { name: 'Hide selected warnings (1)', exact: true })
                    .click();
                await expect(page.getByRole('dialog')).toHaveCount(0);
                await expect(panel.getByRole('status')).toContainText('hidden: 1');
                const [quarantine] =
                    await db.sql`SELECT resolved_at,resolution FROM sync_quarantine WHERE id=${warning}`;
                expect(quarantine.resolved_at).not.toBeNull();
                expect(quarantine.resolution).toBe('dismissed');
            } finally {
                // Cancel page refreshes before deleting the records they read.
                await page.goto('about:blank').catch(() => {});
                await cleanup(db);
            }
        });

        test('stored audio-tail assessment states the unverified limit and keeps raw evidence collapsed', async ({
            page,
        }) => {
            const db = await fixture();
            const [movie, file] = ids(db, 2);
            const assessment = AudioTailAssessmentSchema.parse({
                version: 1,
                measuredAt: '2026-10-24T12:00:00Z',
                method: 'ffmpeg-astats-frames-v1',
                thresholdDbfs: -60,
                completeness: 'unverified',
                scope: 'measured',
                observation: 'near_silent',
                requested: { start: 100, end: 120 },
                inventorySignature: `e2e-${file}`,
                inventory: [
                    {
                        index: 1,
                        codec_type: 'audio',
                        codec_name: 'pcm_s16le',
                        channels: 2,
                        sample_rate: '48000',
                    },
                    {
                        index: 2,
                        codec_type: 'audio',
                        codec_name: 'pcm_s16le',
                        channels: 2,
                        sample_rate: '48000',
                    },
                ],
                source: { generation: `g-${file}`, physical: `p-${file}`, streams: `s-${file}` },
                limits: { seconds: 180, streams: 8, concurrency: 2, budgetMs: 90000 },
                reasons: [],
                streams: [
                    {
                        index: 1,
                        requested: { start: 100, end: 100 },
                        packetEof: true,
                        packetCount: 20,
                        packetInterval: { start: 80, end: 100 },
                        packetEnd: 100,
                        noPostVideoPackets: true,
                        timingToleranceSeconds: 0.0011,
                        samples: 0,
                        coverageSeconds: 0,
                        continuous: true,
                        channels: [],
                        reasons: [],
                    },
                    {
                        index: 2,
                        requested: { start: 100, end: 120 },
                        packetEof: true,
                        packetCount: 1000,
                        packetInterval: { start: 98, end: 120 },
                        packetEnd: 120,
                        decoded: { start: 100, end: 120 },
                        samples: 960000,
                        coverageSeconds: 20,
                        continuous: true,
                        channels: [
                            { channel: 1, peakDbfs: -300, rmsDbfs: -300, digitalZero: true },
                            { channel: 2, peakDbfs: -300, rmsDbfs: -300, digitalZero: true },
                        ],
                        reasons: [],
                    },
                ],
            });
            try {
                await db.sql`INSERT INTO media_items (id,title,media_type,status,has_files)
                    VALUES (${movie},'Five Fix Stored Tail Fixture','movie','active',TRUE)`;
                await db.sql`INSERT INTO media_files (id,file_path,duration_seconds,file_size_bytes,container_format)
                    VALUES (${file},${`/nonexistent/lumastra-e2e/five-tail-${file}.mkv`},120,1000000,'matroska')`;
                await db.sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file},${movie},TRUE)`;
                const warnings = [
                    {
                        type: 'video_ends_early',
                        detail: 'Fixture warning retained',
                        detected_at: '2026-10-24T12:00:00Z',
                    },
                ];
                await db.sql`UPDATE media_files SET health_issues=${JSON.stringify(warnings)}::text::jsonb,
                    health_tail_assessment=${JSON.stringify(assessment)}::text::jsonb WHERE id=${file}`;
                await page.goto(`/admin/library/media/${movie}?tab=files`);
                await expectHydrated(page);
                const diagnosis = page.getByTestId('audio-tail-diagnosis');
                await expect(diagnosis).toContainText('All measured channels stayed at or below');
                const scope = diagnosis
                    .locator('details')
                    .filter({ hasText: 'What this check can tell you' });
                await expect(scope).toHaveJSProperty('open', false);
                await scope.locator('summary').click();
                await expect(scope).toContainText('File completeness remains unverified');
                await expect(scope).toContainText(/2 of 2 audio streams/);
                await expect(
                    page.getByTestId('physical-file-cards').getByText(/Fixture warning retained/),
                ).toBeVisible();
                const [retained] =
                    await db.sql`SELECT health_issues FROM media_files WHERE id=${file}`;
                expect(retained.health_issues).toEqual(warnings);
                const raw = diagnosis.locator('details').filter({ hasText: 'Measurement details' });
                await expect(raw).toHaveJSProperty('open', false);
                await expect(diagnosis.locator('pre')).toBeHidden();
                await diagnosis.scrollIntoViewIfNeeded();
                await expect(diagnosis).toBeInViewport();
                await screenshot(page, `audio-tail-stored-${viewport.name}`);
                await raw.locator('summary').click();
                await expect(diagnosis.locator('pre')).toContainText('"noPostVideoPackets": true');
                await expect(diagnosis.locator('pre')).toContainText(
                    '"completeness": "unverified"',
                );
                expect(
                    await page.evaluate(
                        () => document.documentElement.scrollWidth <= innerWidth + 1,
                    ),
                ).toBe(true);
            } finally {
                // Cancel page refreshes before deleting the records they read.
                await page.goto('about:blank').catch(() => {});
                await cleanup(db);
            }
        });
    });
}
