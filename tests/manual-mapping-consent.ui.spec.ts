// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';

for (const width of [1280, 390]) {
    test(`mapping at ${width}px requires deliberate restoration and retains exact chapter cuts`, async ({
        page,
    }) => {
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl || !/lumastra_(?:t_|tests)/.test(new URL(databaseUrl).pathname)) {
            throw new Error('Mapping browser checks require a disposable test database');
        }
        const sql = postgres(databaseUrl, { max: 1 });
        const series = randomUUID();
        const season = randomUUID();
        const first = randomUUID();
        const second = randomUUID();
        const third = randomUUID();
        const file = randomUUID();
        try {
            await sql`INSERT INTO media_items(id,title,media_type,status,has_files)
                VALUES(${series},'Exact Crossing Mapping Fixture','tv','active',TRUE)`;
            await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number,status,has_files)
                VALUES(${season},'Season 1','season',${series},1,'active',TRUE)`;
            for (const [index, id] of [first, second, third].entries()) {
                await sql`INSERT INTO media_items(id,title,media_type,parent_id,season_number,episode_number,status,has_files,runtime_seconds,is_dismissed,dismissed_at)
                    VALUES(${id},${`Exact Crossing Part ${index + 1}`},'episode',${season},1,${index + 1},'active',${index < 2},60,${index === 1},${index === 1 ? new Date('2026-10-01T12:00:00Z') : null})`;
            }
            await sql`INSERT INTO media_files(id,file_path,duration_seconds,file_size_bytes,container_format)
                VALUES(${file},${`/nonexistent/e2e-exact-mapping/${file}.mkv`},120,12000000,'matroska')`;
            await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default,start_offset_ms,end_offset_ms,offset_source)
                VALUES(${file},${first},TRUE,0,60000,'manual'),(${file},${second},TRUE,60000,120000,'manual')`;
            await sql`INSERT INTO episode_chapters(file_id,chapter_index,chapter_name,start_ticks,source)
                VALUES(${file},0,'Exact chapter cut',591230000,'file')`;
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`/admin/library/media/${first}?tab=files`);
            await expectHydrated(page);
            await expect(
                page.getByText('Linked media items across the library: 2', { exact: true }),
            ).toBeVisible();
            await page
                .getByTestId('physical-file-cards')
                .getByRole('button', { name: 'Episodes in file', exact: true })
                .click();
            const editor = page.getByRole('dialog', { name: /Episodes in this file/ });
            const save = editor.getByRole('button', { name: 'Save links', exact: true });
            await expect(save).toBeDisabled();
            await expect(
                editor.getByRole('checkbox', { name: /Restore dismissed episode S01E02/ }),
            ).not.toBeChecked();
            await editor.getByRole('button', { name: 'From chapters', exact: true }).click();
            const cut = editor.getByLabel('Episode 2 starts at', { exact: true });
            await expect(cut).toHaveValue('0:59.123');
            await cut.fill('0:59.123');
            await expect(save).toBeDisabled();
            await editor
                .getByRole('checkbox', { name: /Restore dismissed episode S01E02/ })
                .check();
            await editor.screenshot({ path: `test-results/manual-mapping-consent-${width}.png` });
            await expect(save).toBeEnabled();
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            ).toBe(true);
            const write = page.waitForResponse(
                (response) =>
                    response.request().method() === 'PUT' &&
                    response.url().endsWith(`/files/${file}/episodes`),
            );
            await save.click();
            expect((await write).status()).toBe(200);
            await expect(save).toBeEnabled();
            await editor.getByRole('button', { name: 'Close', exact: true }).click();
            await expect(editor).not.toBeVisible();
            const links =
                await sql`SELECT media_item_id,start_offset_ms,end_offset_ms FROM media_file_items WHERE file_id=${file} ORDER BY start_offset_ms`;
            expect(
                links.map((row) => [
                    row.media_item_id,
                    Number(row.start_offset_ms),
                    Number(row.end_offset_ms),
                ]),
            ).toEqual([
                [first, 0, 59123],
                [second, 59123, 120000],
            ]);
            const [restored] =
                await sql`SELECT is_dismissed,dismissed_at,title FROM media_items WHERE id=${second}`;
            expect(restored).toMatchObject({
                is_dismissed: false,
                dismissed_at: null,
                title: 'Exact Crossing Part 2',
            });
            await page.reload();
            await expectHydrated(page);
            await page
                .getByTestId('physical-file-cards')
                .getByRole('button', { name: 'Episodes in file', exact: true })
                .click();
            await expect(editor.getByLabel('Episode 2 starts at', { exact: true })).toHaveValue(
                '0:59.123',
            );
            await expect(
                editor.getByRole('checkbox', { name: /Restore dismissed episode/ }),
            ).toHaveCount(0);
            await editor
                .getByRole('combobox', { name: 'Choose an episode…', exact: true })
                .selectOption(third);
            await editor.getByRole('button', { name: 'Add', exact: true }).click();
            await expect(editor).not.toContainText('NaN');
            await expect(editor.getByLabel('Episode 2 starts at', { exact: true })).toHaveValue('');
            await expect(save).toBeDisabled();
            await editor.getByRole('button', { name: 'Close', exact: true }).click();
        } finally {
            await sql`DELETE FROM episode_chapters WHERE file_id=${file}`;
            await sql`DELETE FROM media_file_items WHERE file_id=${file}`;
            await sql`DELETE FROM media_files WHERE id=${file}`;
            await sql`DELETE FROM media_items WHERE id IN (${first},${second},${third},${season},${series})`;
            await sql.end();
        }
    });
}
