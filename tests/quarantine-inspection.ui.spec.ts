// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';

test('quarantine inspection preserves context and hides/restores exact warnings without confirmations', async ({
    page,
}) => {
    test.setTimeout(120_000);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !/lumastra_(?:t_|tests)/.test(new URL(databaseUrl).pathname)) {
        throw new Error('Quarantine browser checks require a disposable test database');
    }
    const sql = postgres(databaseUrl, { max: 1 });
    const series = randomUUID();
    const season = randomUUID();
    const episode = randomUUID();
    const file = randomUUID();
    const prefix = randomUUID().slice(0, 8);
    const warnings = Array.from(
        { length: 251 },
        (_, index) => `${prefix}-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    const title = `Quarantine Current Subject ${series}`;
    try {
        await sql`INSERT INTO media_items(id,title,media_type,status,has_files)
            VALUES(${series},${title},'tv','active',TRUE)`;
        await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number,status,has_files)
            VALUES(${season},'Season 1','season',${series},1,'active',TRUE)`;
        await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number,episode_number,status,has_files,title_binding)
            VALUES(${episode},'The Current Crossing','episode',${season},1,1,'active',TRUE,'identity')`;
        await sql`INSERT INTO media_files(id,file_path,duration_seconds)
            VALUES(${file},${`/nonexistent/e2e-quarantine/${file}.mkv`},120)`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default)
            VALUES(${file},${episode},TRUE)`;
        for (const [index, warning] of warnings.entries()) {
            await sql`INSERT INTO sync_quarantine(id,provider,external_id,media_type,expected_series_id,reason,source,payload)
                VALUES(${warning},'lumastra-reconcile',${index === 0 ? episode : randomUUID()},'episode',${series},
                    ${index === 0 ? 'reconcile-backfill:matched' : 'reconcile-backfill:below-threshold'},'browser-fixture',${sql.json(index === 0 ? { fixture: 'historical-evidence', seriesMediaId: series, seasonNumber: 1, episodeNumber: 1, matchedTmdbEpisodeId: '880001', proposedTitle: 'Invented stored proposal' } : { fixture: 'historical-evidence', confidence: 0 })})`;
        }
        await page.goto(`/admin/library/quarantine?inspect=${series}`);
        await expectHydrated(page);
        const panel = page.getByRole('region', { name: 'Inspect retained warnings' });
        await expect(
            panel.getByText('251 unresolved warnings in this group', { exact: true }),
        ).toBeVisible();
        await expect(
            panel.getByText('The Current Crossing', { exact: false }).first(),
        ).toBeVisible();
        const groupRow = page.getByRole('row').filter({ hasText: title });
        await groupRow
            .getByRole('button', { name: 'Review and accept batch', exact: true })
            .click();
        await expect(
            page.getByText('No eligible decisions in this preview', { exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        const readonlyPreview = page.locator('section').filter({
            has: page.getByRole('heading', {
                name: 'No eligible decisions in this preview',
                exact: true,
            }),
        });
        const reasons = readonlyPreview.getByRole('region', {
            name: 'No eligible decisions in this preview',
            exact: true,
        });
        await expect
            .poll(() =>
                reasons.evaluate(
                    (element) =>
                        element.clientHeight <= 320 && element.scrollHeight > element.clientHeight,
                ),
            )
            .toBe(true);
        await readonlyPreview.screenshot({ path: 'test-results/quarantine-readonly-preview.png' });
        await expect(readonlyPreview.getByRole('link')).toHaveCount(1);
        await expect(readonlyPreview.getByRole('link')).toHaveAttribute(
            'href',
            `/admin/library/media/${episode}`,
        );
        await expect(
            readonlyPreview.getByRole('button', { name: 'Inspect next preview page', exact: true }),
        ).toBeVisible();
        await readonlyPreview
            .getByRole('button', { name: 'Inspect next preview page', exact: true })
            .click();
        await expect(
            readonlyPreview.getByRole('button', { name: 'Inspect next preview page', exact: true }),
        ).toHaveCount(0);
        await expect(readonlyPreview.getByRole('link')).toHaveCount(0);
        await readonlyPreview.getByRole('button', { name: 'Close', exact: true }).click();
        const files = panel.getByRole('link', { name: 'Files (1)', exact: true });
        await expect(files).toHaveAttribute('href', `/admin/library/media/${episode}?tab=files`);
        await expect(files).toHaveAttribute('target', '_blank');
        await panel.getByRole('button', { name: 'Next warnings', exact: true }).click();
        await expect.poll(() => new URL(page.url()).searchParams.get('after')).toBe(warnings[24]);
        await expect(
            panel
                .getByText(
                    'The current subject is unavailable or its provider key cannot be resolved. No identity has been inferred.',
                    { exact: true },
                )
                .first(),
        ).toBeVisible();
        const pagedUrl = page.url();
        await page.locator('a[href="/admin/library/media"]').first().click();
        await expect(page).toHaveURL(/\/admin\/library\/media$/);
        await expectHydrated(page);
        await page.goBack();
        await expect(page).toHaveURL(pagedUrl);
        await expect(panel.locator('article')).toHaveCount(25);
        await expect(panel.getByText('The Current Crossing', { exact: false })).toHaveCount(0);
        await panel.getByRole('button', { name: 'Refresh inspection', exact: true }).click();
        await expect.poll(() => new URL(page.url()).searchParams.has('after')).toBe(false);
        const current = panel.locator('article').filter({ hasText: 'The Current Crossing' });
        await expect(current).toHaveCount(1);
        await current.getByText('Raw historical payload', { exact: true }).click();
        await expect(current.locator('pre')).toContainText('historical-evidence');
        await current.getByRole('button', { name: 'Hide this warning', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(
            panel.getByText('250 unresolved warnings in this group', { exact: true }),
        ).toBeVisible();
        const [resolved] =
            await sql`SELECT resolution,resolved_at FROM sync_quarantine WHERE id=${warnings[0]}`;
        expect(resolved.resolution).toBe('dismissed');
        expect(resolved.resolved_at).not.toBeNull();
        const [siblings] = await sql`SELECT COUNT(*)::int AS count FROM sync_quarantine
            WHERE expected_series_id=${series} AND resolved_at IS NULL`;
        expect(siblings.count).toBe(250);
        const [unchanged] = await sql`SELECT title FROM media_items WHERE id=${episode}`;
        expect(unchanged.title).toBe('The Current Crossing');

        await page.reload();
        await expectHydrated(page);
        const history = page
            .locator('details')
            .filter({ has: page.locator('summary').getByText('Warning history', { exact: true }) });
        await history.locator('summary').click();
        const hidden = history.locator('article').filter({ hasText: title });
        await expect(hidden).toHaveCount(1);
        await hidden.getByRole('button', { name: 'Show again', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect
            .poll(async () => {
                const [row] =
                    await sql`SELECT COUNT(*)::int AS count FROM sync_quarantine WHERE expected_series_id = ${series} AND resolved_at IS NULL`;
                return row.count;
            })
            .toBe(251);
        await page.reload();
        await expectHydrated(page);
        const row = page.getByRole('row').filter({ hasText: title });
        await row.getByRole('button', { name: 'Hide current warnings', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(row).toHaveCount(0);
        await history.locator('summary').click();
        const batch = history
            .locator('article')
            .filter({ hasText: title })
            .filter({ has: page.getByRole('button', { name: 'Show again', exact: true }) });
        await expect(batch).toHaveCount(1);
        await batch.getByRole('button', { name: 'Show again', exact: true }).click();
        await expect(row).toHaveCount(1);
        await page.screenshot({
            path: 'test-results/quarantine-warning-history.png',
            fullPage: true,
        });
    } finally {
        await sql`DELETE FROM sync_quarantine WHERE expected_series_id=${series}`;
        await sql`DELETE FROM media_file_items WHERE file_id=${file}`;
        await sql`DELETE FROM media_files WHERE id=${file}`;
        await sql`DELETE FROM media_items WHERE id IN (${episode},${season},${series})`;
        await sql.end();
    }
});
