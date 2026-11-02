// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the chapter-probe marker (migration 16.407.0) and the
 * queries that read it. The SQL is what these check: the marker must match the
 * row's stat exactly, only the file's own chapters count, and the stored probe
 * the trickplay generator reads comes from the first video stream.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    loadKnownFileChapters,
    markChaptersProbed,
    upsertChaptersForFile,
} from './episode-chapters.queries.js';
import { loadStoredVideoProbe } from './media-files.queries.js';

const MTIME = '2026-10-01T10:00:00.000Z';
/** The stat the row was inserted with, i.e. the stat a probe of it would see. */
const PROBED = { mtime: new Date(MTIME), size: 4096 };

describe('chapter probe marker', () => {
    let sql: postgres.Sql;
    let fileId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, [
            'episode_chapters',
            'media_streams',
            'media_file_items',
            'media_files',
            ...TEST_TABLES.media,
        ]);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'episode_chapters',
            'media_streams',
            'media_file_items',
            'media_files',
            ...TEST_TABLES.media,
        ]);
        fileId = crypto.randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path, file_mtime, file_size_bytes, created_at, updated_at)
            VALUES (${fileId}::uuid, ${'/test/marker.mkv'}, ${MTIME}::timestamptz, ${4096}, NOW(), NOW())
        `;
    });

    it('a file that was never marked has no known chapters', async () => {
        await upsertChaptersForFile(sql, fileId, [
            {
                chapterIndex: 0,
                chapterName: 'Intro',
                startTicks: '0',
                endTicks: '10000000',
                source: 'file',
            },
        ]);

        expect(await loadKnownFileChapters(sql, fileId)).toBeNull();
    });

    it('a marked file returns its own chapters in milliseconds, in index order', async () => {
        await upsertChaptersForFile(sql, fileId, [
            {
                chapterIndex: 1,
                chapterName: 'Act Two',
                startTicks: '600000000',
                endTicks: '13800000000',
                source: 'file',
            },
            {
                chapterIndex: 0,
                chapterName: 'Cold Open',
                startTicks: '0',
                endTicks: '600000000',
                source: 'file',
            },
        ]);
        await markChaptersProbed(sql, fileId, PROBED);

        expect(await loadKnownFileChapters(sql, fileId)).toEqual({
            chapters: [
                { index: 0, title: 'Cold Open', startTimeMs: 0, endTimeMs: 60000 },
                { index: 1, title: 'Act Two', startTimeMs: 60000, endTimeMs: 1380000 },
            ],
        });
    });

    it('a marked file with no chapters is a known "no chapters"', async () => {
        await markChaptersProbed(sql, fileId, PROBED);

        expect(await loadKnownFileChapters(sql, fileId)).toEqual({ chapters: [] });
    });

    it('a changed stat makes the marker stale, so the chapters are not trusted', async () => {
        await upsertChaptersForFile(sql, fileId, [
            {
                chapterIndex: 0,
                chapterName: 'Intro',
                startTicks: '0',
                endTicks: '10000000',
                source: 'file',
            },
        ]);
        await markChaptersProbed(sql, fileId, PROBED);
        await sql`
            UPDATE media_files SET file_mtime = ${'2026-10-02T10:00:00.000Z'}::timestamptz
            WHERE id = ${fileId}::uuid
        `;

        expect(await loadKnownFileChapters(sql, fileId)).toBeNull();
    });

    it("only the file's own chapters count; Jellyfin-sourced rows are ignored", async () => {
        await upsertChaptersForFile(sql, fileId, [
            {
                chapterIndex: 0,
                chapterName: 'From Jellyfin',
                startTicks: '0',
                endTicks: '10000000',
                source: 'jellyfin',
            },
        ]);
        await markChaptersProbed(sql, fileId, PROBED);

        expect(await loadKnownFileChapters(sql, fileId)).toEqual({ chapters: [] });
    });

    it('a file row without a stat (never scanned) cannot be marked', async () => {
        const bare = crypto.randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path, created_at, updated_at)
            VALUES (${bare}::uuid, ${'/test/bare.mkv'}, NOW(), NOW())
        `;
        await markChaptersProbed(sql, bare, PROBED);

        expect(await loadKnownFileChapters(sql, bare)).toBeNull();
    });

    it('a probe whose stat differs from the row is not marked, even if the row has since moved on', async () => {
        // The file was probed at size 4096 but the row now says 8192 (changed
        // between the probe and the marker write): stale chapters must not be
        // marked fresh.
        await upsertChaptersForFile(sql, fileId, [
            {
                chapterIndex: 0,
                chapterName: 'Stale',
                startTicks: '0',
                endTicks: '10000000',
                source: 'file',
            },
        ]);
        await sql`UPDATE media_files SET file_size_bytes = ${8192} WHERE id = ${fileId}::uuid`;

        const marked = await markChaptersProbed(sql, fileId, PROBED);

        expect(marked).toBe(false);
        expect(await loadKnownFileChapters(sql, fileId)).toBeNull();
        const [row] = await sql`
            SELECT chapters_probed_mtime, chapters_probed_size FROM media_files WHERE id = ${fileId}::uuid
        `;
        expect(row.chapters_probed_mtime).toBeNull();
        expect(row.chapters_probed_size).toBeNull();
    });

    it('a probe whose mtime differs from the row is not marked', async () => {
        const marked = await markChaptersProbed(sql, fileId, {
            mtime: new Date('2026-10-01T10:00:01.000Z'),
            size: 4096,
        });

        expect(marked).toBe(false);
        expect(await loadKnownFileChapters(sql, fileId)).toBeNull();
    });

    it('a probe whose stat matches the row is marked with exactly that stat and reports true', async () => {
        const marked = await markChaptersProbed(sql, fileId, PROBED);

        expect(marked).toBe(true);
        const [row] = await sql`
            SELECT chapters_probed_mtime, chapters_probed_size FROM media_files WHERE id = ${fileId}::uuid
        `;
        expect(new Date(row.chapters_probed_mtime).getTime()).toBe(PROBED.mtime.getTime());
        expect(Number(row.chapters_probed_size)).toBe(PROBED.size);
        expect(await loadKnownFileChapters(sql, fileId)).toEqual({ chapters: [] });
    });
});

describe('loadStoredVideoProbe', () => {
    let sql: postgres.Sql;
    let fileId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_streams',
            'media_file_items',
            'media_files',
            ...TEST_TABLES.media,
        ]);
        fileId = crypto.randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path, file_mtime, file_size_bytes, duration_seconds,
                                     probed_at, created_at, updated_at)
            VALUES (${fileId}::uuid, ${'/test/video.mkv'}, ${MTIME}::timestamptz, ${4096}, ${5400.5},
                    NOW(), NOW(), NOW())
        `;
    });

    afterAll(async () => {
        await truncateTables(sql, [
            'media_streams',
            'media_file_items',
            'media_files',
            ...TEST_TABLES.media,
        ]);
    });

    it('returns the duration and the FIRST video stream, not a later one', async () => {
        await sql`
            INSERT INTO media_streams (file_id, stream_type, stream_index, codec, width, height, pixel_format, is_default)
            VALUES
                (${fileId}::uuid, 'video', 0, 'hevc', 1920, 1080, 'yuv420p10le', true),
                (${fileId}::uuid, 'video', 1, 'mjpeg', 300, 300, 'yuvj420p', false)
        `;

        const row = await loadStoredVideoProbe(sql, fileId);

        expect(row).toMatchObject({
            duration_seconds: 5400.5,
            width: 1920,
            height: 1080,
            codec: 'hevc',
            pixel_format: 'yuv420p10le',
        });
        expect(row?.probed_at).not.toBeNull();
    });

    it('returns nulls for the video fields when the file has no video stream', async () => {
        const row = await loadStoredVideoProbe(sql, fileId);

        expect(row?.width).toBeNull();
        expect(row?.codec).toBeNull();
    });

    it('returns null for a file that does not exist', async () => {
        expect(await loadStoredVideoProbe(sql, crypto.randomUUID())).toBeNull();
    });
});
