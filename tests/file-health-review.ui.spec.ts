// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { AudioTailAssessmentSchema } from '../src/lib/schemas/audio-tail-assessment.js';
import { adminTest as test, expect } from './fixtures/auth.js';
import { expectHydrated } from './helpers/hydration.js';
import { withoutNetworkChangeErrors } from './helpers/network-changes';

test('admins can review exact duration findings, undo, and recover from a stale preview', async ({
    page,
}) => {
    test.setTimeout(120000);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !/lumastra_(?:t_|tests)/.test(new URL(databaseUrl).pathname)) {
        throw new Error(
            'File-health review browser E2E requires an isolated lumastra_t_* or lumastra_tests database',
        );
    }

    const mediaId = randomUUID();
    const fileId = randomUUID();
    const mediaTitle = `Duration Review Fixture ${fileId}`;
    const reviewRoot = resolve('test-results/file-health-review');
    mkdirSync(reviewRoot, { recursive: true });
    const fixtureDir = mkdtempSync(join(reviewRoot, 'physical-file-'));
    const filePath = join(fixtureDir, `duration-review-${fileId}.mkv`);
    const screenshotsDir = reviewRoot;
    const rawIssue = {
        type: 'truncated_video',
        basis: 'duration_comparison',
        expected_duration: 120,
        actual_duration: 100,
        detected_at: '2026-10-26T00:00:00.000Z',
    };
    const sql = postgres(databaseUrl, { max: 1 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
        mkdirSync(screenshotsDir, { recursive: true });
        writeFileSync(filePath, 'Synthetic physical media file for isolated browser review E2E.');
        const fileStat = statSync(filePath, { bigint: true });
        const fileSize = String(fileStat.size);
        const fileMtime = new Date(Number(fileStat.mtimeNs / 1_000_000n));

        await sql`
            INSERT INTO media_items (id, title, media_type, has_files, status, year)
            VALUES (${mediaId}, ${mediaTitle}, 'movie', TRUE, 'active', 2001)
        `;
        await sql`
            INSERT INTO media_files
                (id, file_path, duration_seconds, file_size_bytes, file_mtime, container_format, health_issues)
            VALUES
                (${fileId}, ${filePath}, 120, ${fileSize}, ${fileMtime}, 'matroska', ${sql.json([rawIssue])})
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${fileId}, ${mediaId}, TRUE)
        `;

        // Keep these expressions byte-for-byte aligned with
        // analyzerFileGenerationSql and healthStreamSignatureSql. The assessment
        // must describe the exact source and stream inventory the preview reads.
        const [source] = await sql<{ generation: string; streams: string }[]>`
            SELECT
                md5(jsonb_build_array(mf.id, mf.file_path, mf.file_hash_head,
                    mf.file_size_bytes, mf.file_mtime, mf.duration_seconds)::text) AS generation,
                md5(COALESCE((SELECT jsonb_agg(to_jsonb(ms) - 'id' - 'created_at' - 'updated_at'
                    ORDER BY ms.stream_index)::text
                    FROM media_streams ms WHERE ms.file_id = mf.id), '[]')) AS streams
            FROM media_files mf
            WHERE mf.id = ${fileId}::uuid
        `;
        const assessment = AudioTailAssessmentSchema.parse({
            version: 1,
            method: 'ffmpeg-astats-frames-v2',
            measuredAt: new Date().toISOString(),
            thresholdDbfs: -60,
            completeness: 'unverified',
            scope: 'partial',
            observation: 'unknown',
            inventorySignature: 'synthetic-empty-inventory',
            inventory: [],
            source: {
                generation: source.generation,
                streams: source.streams,
                physical: [
                    'stat-v2',
                    fileStat.ino,
                    fileStat.size,
                    fileStat.mtimeNs,
                    fileStat.ctimeNs,
                ].join(':'),
            },
            limits: { seconds: 180, streams: 8, concurrency: 2, budgetMs: 90000 },
            reasons: ['no_measurable_post_video_interval'],
            streams: [],
            packetTail: {
                success: true,
                endedPrematurely: false,
                hasAudio: false,
                videoEnd: 100,
            },
        });

        // Set the assessment after the file and associations are in place so its
        // source witness remains current through the preview.
        await sql`
            UPDATE media_files
            SET health_tail_assessment = ${sql.json(assessment as unknown as postgres.JSONValue)}
            WHERE id = ${fileId}::uuid
        `;

        for (const viewport of [
            { width: 1440, height: 1000, name: 'desktop' },
            { width: 390, height: 844, name: 'mobile' },
        ]) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.goto('/admin/system/health#files');
            await expectHydrated(page);

            const filesPanel = page.locator('#files');
            const fileRow = filesPanel
                .getByText(filePath.split('/').at(-1)!, { exact: true })
                .locator('../../..');
            await expect(fileRow).toBeVisible();
            await expect(fileRow).toContainText('100');
            await expect(fileRow).toContainText('120');

            if (viewport.name === 'desktop') {
                await fileRow.getByRole('button', { name: 'Review duration difference' }).click();
                let dialog = page.getByRole('dialog');
                await expect(
                    dialog.getByRole('heading', { name: 'Review duration difference' }),
                ).toBeVisible();
                await expect(dialog).toContainText(filePath);
                await expect(dialog).toContainText('This does not certify its content.');
                await expect(dialog.getByText('truncated_video', { exact: true })).toBeVisible();
                await dialog.getByText('Notes (optional)', { exact: true }).click();
                await dialog
                    .getByLabel('Notes (optional)')
                    .fill('Verified the complete ending against this source file.');
                await dialog.getByRole('button', { name: 'Keep this file', exact: true }).click();
                await expect(dialog.getByRole('status')).toContainText(
                    'File kept. Duration warning hidden.',
                );
                await expect(
                    dialog.getByRole('button', { name: 'Keep this file', exact: true }),
                ).toHaveCount(0);

                const [preservedAfterConfirm] = await sql<{ health_issues: unknown }[]>`
                    SELECT health_issues FROM media_files WHERE id = ${fileId}::uuid
                `;
                expect(preservedAfterConfirm.health_issues).toEqual([rawIssue]);

                await dialog.getByRole('button', { name: 'Close' }).click();
                await filesPanel.getByRole('button', { name: /^Reviewed \(/ }).click();
                await expect(fileRow).toBeVisible();
                await expect(fileRow).toContainText('Reviewed duration finding');
                await fileRow.getByRole('button', { name: 'Review duration difference' }).click();
                dialog = page.getByRole('dialog');
                // The compact card summarizes acceptance; exact original
                // measurements remain available in its review disclosure.
                await expect(dialog).toContainText('Expected 120s · observed 100s');
                const currentHistory = dialog
                    .locator('article')
                    .filter({ hasText: 'Verified the complete ending against this source file.' });
                await expect(currentHistory).toBeVisible();
                await expect(currentHistory).toContainText(
                    new RegExp(process.env.TEST_USER || 'TestUser', 'i'),
                );
                await expect(
                    dialog.getByRole('button', { name: 'Show this warning again', exact: true }),
                ).toBeVisible();
                await dialog
                    .getByRole('button', { name: 'Show this warning again', exact: true })
                    .click();
                await expect(dialog.getByRole('status')).toContainText('Review decision revoked.');
                await expect(dialog).toContainText('revoked');

                const [preservedAfterUndo] = await sql<{ health_issues: unknown }[]>`
                    SELECT health_issues FROM media_files WHERE id = ${fileId}::uuid
                `;
                expect(preservedAfterUndo.health_issues).toEqual([rawIssue]);
                const [reviewRows] = await sql<{ count: number; revoked: number }[]>`
                    SELECT count(*)::int AS count,
                           count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
                    FROM media_file_health_reviews WHERE file_id = ${fileId}::uuid
                `;
                expect(reviewRows).toEqual({ count: 1, revoked: 1 });

                await dialog.getByRole('button', { name: 'Close' }).click();
                await filesPanel.getByRole('button', { name: /Needs review/ }).click();
                await expect(fileRow).toBeVisible();
                await fileRow.getByRole('button', { name: 'Review duration difference' }).click();
                dialog = page.getByRole('dialog');
                await expect(
                    dialog.getByRole('button', { name: 'Keep this file', exact: true }),
                ).toBeEnabled();

                // Mutate only this isolated test file after the preview captured
                // its snapshot; the server must reject the stale confirmation.
                await sql`
                    UPDATE media_files
                    SET file_size_bytes = ${String(fileStat.size + 123n)}
                    WHERE id = ${fileId}::uuid
                `;
                const conflict = page.waitForResponse(
                    (response) =>
                        new URL(response.url()).pathname ===
                            '/api/admin/media/file-health/reviews' &&
                        response.request().method() === 'POST' &&
                        response.status() === 409,
                );
                await dialog.getByRole('button', { name: 'Keep this file', exact: true }).click();
                expect((await conflict).status()).toBe(409);
                await expect(dialog.getByRole('alert')).toContainText('changed');
                await expect(dialog.getByRole('button', { name: 'Retry preview' })).toBeVisible();
                await expect(
                    dialog.getByRole('button', { name: 'Keep this file', exact: true }),
                ).toHaveCount(0);
                await dialog.getByRole('button', { name: 'Retry preview' }).click();
                await expect(dialog).toContainText(
                    /The file or its source information changed|A successful current recheck is required/,
                );
                await expect(
                    dialog.getByRole('button', { name: 'Keep this file', exact: true }),
                ).toHaveCount(0);

                const [historyAfterConflict] = await sql<{ count: number }[]>`
                    SELECT count(*)::int AS count FROM media_file_health_reviews WHERE file_id = ${fileId}::uuid
                `;
                expect(historyAfterConflict.count).toBe(1);
            } else {
                // The changed source keeps the finding blocked after the stale
                // confirmation attempt, with no old confirmation available.
                await fileRow.getByRole('button', { name: 'Review duration difference' }).click();
                const dialog = page.getByRole('dialog');
                await expect(dialog).toContainText(
                    /The file or its source information changed|A successful current recheck is required/,
                );
                await expect(
                    dialog.getByRole('button', { name: 'Keep this file', exact: true }),
                ).toHaveCount(0);
            }

            expect(
                await page.evaluate(
                    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
                ),
            ).toBe(true);
            await page.screenshot({
                path: join(screenshotsDir, `duration-review-${viewport.name}.png`),
                animations: 'disabled',
                timeout: 10000,
            });
            await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
        }
        expect(withoutNetworkChangeErrors(page, pageErrors)).toEqual([]);
    } finally {
        await sql`DELETE FROM media_file_health_reviews WHERE file_id = ${fileId}::uuid`;
        await sql`DELETE FROM media_file_items WHERE file_id = ${fileId}::uuid`;
        await sql`DELETE FROM media_streams WHERE file_id = ${fileId}::uuid`;
        await sql`DELETE FROM media_files WHERE id = ${fileId}::uuid`;
        await sql`DELETE FROM media_items WHERE id = ${mediaId}::uuid`;
        await sql.end();
        rmSync(fixtureDir, { recursive: true, force: true });
    }
});
