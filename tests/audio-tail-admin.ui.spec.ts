// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { AudioTailAssessmentSchema } from '../src/lib/schemas/audio-tail-assessment';
import { adminTest as test, expect } from './fixtures/auth';
import { expectHydrated } from './helpers/hydration';

const MEDIA_TITLE = 'Glass Harbour Audio Tail Fixture';

test('measured audio tail evidence is visible in Files and Health', async ({ page }) => {
    // This covers Files, Health and two viewport/reload round trips through
    // probe history. Give the dev server the same cold-route budget as the
    // other multi-page admin probes; retain each assertion's own timeout.
    test.setTimeout(90_000);
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !/lumastra_(?:t_|tests)/.test(new URL(databaseUrl).pathname)) {
        throw new Error(
            'Audio-tail browser E2E requires an isolated lumastra_t_* or lumastra_tests database',
        );
    }

    const MEDIA_ID = randomUUID();
    const FILE_ID = randomUUID();
    const FILE_NAME = `glass-harbour-audio-tail-${FILE_ID}.mkv`;
    const warning = { type: 'episode_number_unparsed', detected_at: '2026-10-24T12:00:00Z' };
    const sql = postgres(databaseUrl, { max: 1 });
    const filePath = `/nonexistent/lumastra-e2e/${FILE_NAME}`;
    const assessment = AudioTailAssessmentSchema.parse({
        version: 1,
        measuredAt: '2026-10-24T12:00:00Z',
        method: 'ffmpeg-astats-frames-v1',
        thresholdDbfs: -60,
        completeness: 'unverified',
        scope: 'measured',
        observation: 'near_silent',
        requested: { start: 100, end: 120 },
        inventorySignature: `fixture-inventory-${FILE_ID}`,
        inventory: [
            {
                index: 0,
                codec_type: 'video',
                codec_name: 'h264',
                time_base: '1/1000',
                start_time: '0.000000',
            },
            {
                index: 1,
                codec_type: 'audio',
                codec_name: 'pcm_s16le',
                channels: 2,
                sample_rate: '48000',
                time_base: '1/1000',
                start_time: '0.000000',
                duration: '120.000000',
            },
        ],
        source: {
            generation: `fixture-generation-${FILE_ID}`,
            physical: `fixture-physical-${FILE_ID}`,
            streams: `fixture-streams-${FILE_ID}`,
        },
        limits: { seconds: 180, streams: 8, concurrency: 2, budgetMs: 90000 },
        reviewedIssues: [warning],
        reasons: [],
        streams: [
            {
                index: 1,
                requested: { start: 100, end: 120 },
                decoded: { start: 100, end: 120 },
                samples: 960000,
                coverageSeconds: 20,
                continuous: true,
                channels: [1, 2].map((channel) => ({
                    channel,
                    peakDbfs: -300,
                    rmsDbfs: -300,
                    digitalZero: true,
                })),
                reasons: [],
            },
        ],
    });
    const seedPath = resolve('test-results/audio-tail/browser-assessment-seed.json');

    try {
        mkdirSync(resolve('test-results/audio-tail'), { recursive: true });
        writeFileSync(seedPath, `${JSON.stringify(assessment, null, 2)}\n`);

        await sql`
            INSERT INTO media_items (id, title, media_type, has_files, status, year)
            VALUES (${MEDIA_ID}, ${MEDIA_TITLE}, 'movie', TRUE, 'active', 2001)
        `;
        await sql`
            INSERT INTO media_files (id, file_path, duration_seconds, file_size_bytes, container_format, health_issues)
            VALUES (${FILE_ID}, ${filePath}, 120, 12000000, 'matroska',
                ${sql.json([warning])})
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${FILE_ID}, ${MEDIA_ID}, TRUE)
        `;
        await sql`
            INSERT INTO media_streams (file_id, stream_type, stream_index, codec, channels, sample_rate)
            VALUES (${FILE_ID}, 'video', 0, 'h264', NULL, NULL),
                   (${FILE_ID}, 'audio', 1, 'pcm_s16le', 2, 48000)
            ON CONFLICT DO NOTHING
        `;
        // Seed last: the media_streams trigger invalidates prior assessments.
        await sql`
            UPDATE media_files SET health_tail_assessment = ${sql.json(assessment as unknown as postgres.JSONValue)}
            WHERE id = ${FILE_ID}
        `;

        await sql`INSERT INTO plugin_failure_events (plugin_id, item_id, reason, occurred_at)
            VALUES ('media-probe', ${FILE_ID}, 'truncated_video', '2026-10-01T00:00:00Z'),
                   ('media-probe', ${FILE_ID}, 'truncated_video', '2026-10-02T00:00:00Z')`;

        await page.goto(`/admin/library/media/${MEDIA_ID}?tab=files`);
        await expectHydrated(page);
        const fileDiagnosis = page.getByTestId('audio-tail-diagnosis');
        await expect(fileDiagnosis).toContainText(
            'All measured channels stayed at or below −60 dBFS peak in the measured interval.',
        );
        await expect(fileDiagnosis).toContainText(
            'File completeness remains unverified. Silence does not resolve existing warnings.',
        );
        await fileDiagnosis.getByText('Measurement details', { exact: true }).click();
        await expect(fileDiagnosis.locator('pre')).toContainText('"observation": "near_silent"');
        await expect(fileDiagnosis.locator('pre')).toContainText('"completeness": "unverified"');
        await expect(fileDiagnosis.locator('pre')).toContainText('fixture-inventory-');

        await page.goto('/admin/system/health#files');
        await expectHydrated(page);
        const healthFiles = page.locator('#files');
        const healthRow = healthFiles.getByText(FILE_NAME, { exact: true }).locator('../../..');
        await expect(healthRow).toBeVisible();
        await expect(healthRow.getByTestId('audio-tail-diagnosis')).toContainText(
            'All measured channels stayed at or below −60 dBFS peak in the measured interval.',
        );
        await expect(healthRow.getByTestId('audio-tail-diagnosis')).toContainText(
            'File completeness remains unverified. Silence does not resolve existing warnings.',
        );
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto('/admin/tasks/media-probe?tab=failures');
            await expectHydrated(page);
            const recordedIssue = page.locator(`p[title="${FILE_ID}"]`).locator('..');
            await expect(recordedIssue).toContainText(MEDIA_TITLE);
            await expect(recordedIssue).toContainText('Latest recorded issue');
            await expect(recordedIssue).toContainText('2 recorded observations');
            await expect(
                page.getByText(/A completed recheck can still leave warnings/),
            ).toBeVisible();
            await page.reload();
            await expectHydrated(page);
            await expect(recordedIssue).toContainText('Latest recorded issue');
            await expect(recordedIssue).toContainText('2 recorded observations');
            expect(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            ).toBe(true);
            await page.screenshot({
                path: test.info().outputPath(`probe-history-${width}.png`),
                animations: 'disabled',
            });
            await page.getByRole('link', { name: 'Browse current file health' }).click();
            await expectHydrated(page);
            await expect(healthRow.getByTestId('audio-tail-diagnosis')).toContainText(
                'Silence does not resolve existing warnings.',
            );
        }
        const [preserved] = await sql<{ events: number; unresolved: number }[]>`
            SELECT count(*)::int AS events, count(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved
            FROM plugin_failure_events WHERE plugin_id = 'media-probe' AND item_id = ${FILE_ID}
        `;
        expect(preserved).toEqual({ events: 2, unresolved: 2 });
    } finally {
        await sql`DELETE FROM plugin_failure_events WHERE plugin_id = 'media-probe' AND item_id = ${FILE_ID}`;
        await sql`DELETE FROM media_file_items WHERE file_id = ${FILE_ID}`;
        await sql`DELETE FROM media_streams WHERE file_id = ${FILE_ID}`;
        await sql`DELETE FROM media_files WHERE id = ${FILE_ID}`;
        await sql`DELETE FROM media_items WHERE id = ${MEDIA_ID}`;
        await sql.end();
    }
});
