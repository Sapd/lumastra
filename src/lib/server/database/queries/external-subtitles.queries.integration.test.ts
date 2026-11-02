// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for External Subtitles Query Module
 *
 * Tests upsert, retrieval, and ID lookups for external subtitle files.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    buildUpsertExternalSubtitleQuery,
    upsertExternalSubtitle,
    getExternalSubtitlesForFile,
    getExternalSubtitlesForMediaItem,
    getExternalSubtitlesByJellyfinId,
    getExternalSubtitleById,
    getExternalSubtitleByIdForMediaItem,
} from './external-subtitles.queries.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('External Subtitles Queries', () => {
    let sql: postgres.Sql;
    let testFileId: string;
    let testMediaItemId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, [
            'external_subtitle_files',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
        ]);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'external_subtitle_files',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
        ]);

        // Create test media file and item
        testFileId = crypto.randomUUID();
        testMediaItemId = crypto.randomUUID();

        await sql`
            INSERT INTO media_files (id, file_path, created_at, updated_at)
            VALUES (${testFileId}::uuid, ${'/test/movie.mkv'}, NOW(), NOW())
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${testMediaItemId}::uuid, ${'Test Movie'}, 'movie', 'active')
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${testFileId}::uuid, ${testMediaItemId}::uuid)
        `;
    });

    // ========================================================================
    // buildUpsertExternalSubtitleQuery
    // ========================================================================

    describe('buildUpsertExternalSubtitleQuery', () => {
        it('returns the params object unchanged', () => {
            const params = {
                fileId: 'abc',
                subtitlePath: '/test/sub.srt',
                language: 'en',
                format: 'srt' as const,
                isForced: false,
                isSDH: false,
            };
            expect(buildUpsertExternalSubtitleQuery(params)).toBe(params);
        });
    });

    // ========================================================================
    // upsertExternalSubtitle
    // ========================================================================

    describe('upsertExternalSubtitle', () => {
        it('inserts a new external subtitle row', async () => {
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.en.srt',
                language: 'en',
                format: 'srt',
                isForced: false,
                isSDH: false,
            });

            const rows = await getExternalSubtitlesForFile(sql, testFileId);
            expect(rows.length).toBe(1);
            expect(rows[0].subtitle_path).toBe('/test/movie.en.srt');
            expect(rows[0].language).toBe('en');
            expect(rows[0].format).toBe('srt');
            expect(rows[0].is_forced).toBe(false);
            expect(rows[0].is_sdh).toBe(false);
        });

        it('updates on conflict by subtitle_path', async () => {
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.en.srt',
                language: 'en',
                format: 'srt',
                isForced: false,
                isSDH: false,
            });

            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.en.srt',
                language: 'fr',
                format: 'ass',
                isForced: true,
                isSDH: true,
            });

            const rows = await getExternalSubtitlesForFile(sql, testFileId);
            expect(rows.length).toBe(1);
            expect(rows[0].language).toBe('fr');
            expect(rows[0].format).toBe('ass');
            expect(rows[0].is_forced).toBe(true);
            expect(rows[0].is_sdh).toBe(true);
        });

        it('allows null language', async () => {
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.und.srt',
                language: null,
                format: 'srt',
                isForced: false,
                isSDH: false,
            });

            const rows = await getExternalSubtitlesForFile(sql, testFileId);
            expect(rows.length).toBe(1);
            expect(rows[0].language).toBeNull();
        });
    });

    // ========================================================================
    // getExternalSubtitlesForFile
    // ========================================================================

    describe('getExternalSubtitlesForFile', () => {
        it('returns empty array when file has no subtitles', async () => {
            const rows = await getExternalSubtitlesForFile(sql, testFileId);
            expect(rows).toEqual([]);
        });

        it('returns subtitles ordered by language, forced, format', async () => {
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.de.srt',
                language: 'de',
                format: 'srt',
                isForced: false,
                isSDH: false,
            });
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.en.forced.srt',
                language: 'en',
                format: 'srt',
                isForced: true,
                isSDH: false,
            });
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.en.srt',
                language: 'en',
                format: 'srt',
                isForced: false,
                isSDH: false,
            });

            const rows = await getExternalSubtitlesForFile(sql, testFileId);
            expect(rows.length).toBe(3);
            // Alphabetical: de before en, then en non-forced before en forced
            expect(rows[0].language).toBe('de');
            expect(rows[0].is_forced).toBe(false);
            expect(rows[1].language).toBe('en');
            expect(rows[1].is_forced).toBe(false);
            expect(rows[2].language).toBe('en');
            expect(rows[2].is_forced).toBe(true);
        });

        it('breaks a language/forced/format tie by path, so positions stay stable', async () => {
            // Inserted out of path order; positions back the /j 1000 + n indices.
            for (const subtitlePath of ['/test/movie.en.b.srt', '/test/movie.en.a.srt']) {
                await upsertExternalSubtitle(sql, {
                    fileId: testFileId,
                    subtitlePath,
                    language: 'en',
                    format: 'srt',
                    isForced: false,
                    isSDH: false,
                });
            }

            const rows = await getExternalSubtitlesForFile(sql, testFileId);
            expect(rows.map((r) => r.subtitle_path)).toEqual([
                '/test/movie.en.a.srt',
                '/test/movie.en.b.srt',
            ]);
        });
    });

    // ========================================================================
    // getExternalSubtitlesForMediaItem
    // ========================================================================

    describe('getExternalSubtitlesForMediaItem', () => {
        it('returns subtitles linked to the media item', async () => {
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.en.srt',
                language: 'en',
                format: 'srt',
                isForced: false,
                isSDH: false,
            });

            const rows = await getExternalSubtitlesForMediaItem(sql, testMediaItemId);
            expect(rows.length).toBe(1);
            expect(rows[0].subtitle_path).toBe('/test/movie.en.srt');
        });

        it('returns empty array when media item has no subtitles', async () => {
            const rows = await getExternalSubtitlesForMediaItem(sql, testMediaItemId);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getExternalSubtitlesByJellyfinId
    // ========================================================================

    describe('getExternalSubtitlesByJellyfinId', () => {
        it('resolves subtitles via jellyfin external id', async () => {
            const jellyfinId = 'abc123def456';
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${testMediaItemId}::uuid, 'jellyfin', ${jellyfinId}, 'movie')
            `;
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.en.srt',
                language: 'en',
                format: 'srt',
                isForced: false,
                isSDH: false,
            });

            const rows = await getExternalSubtitlesByJellyfinId(sql, jellyfinId);
            expect(rows.length).toBe(1);
            expect(rows[0].subtitle_path).toBe('/test/movie.en.srt');
        });

        it('returns empty array for unknown jellyfin id', async () => {
            const rows = await getExternalSubtitlesByJellyfinId(sql, 'nonexistent123');
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getExternalSubtitleById
    // ========================================================================

    describe('getExternalSubtitleById', () => {
        it('returns the subtitle row when found', async () => {
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.en.srt',
                language: 'en',
                format: 'srt',
                isForced: false,
                isSDH: false,
            });

            const [inserted] = await sql<{ id: string }[]>`
                SELECT id FROM external_subtitle_files WHERE subtitle_path = ${'/test/movie.en.srt'}
            `;

            const row = await getExternalSubtitleById(sql, inserted.id);
            expect(row).not.toBeNull();
            expect(row!.subtitle_path).toBe('/test/movie.en.srt');
        });

        it('returns null for unknown id', async () => {
            const row = await getExternalSubtitleById(sql, crypto.randomUUID());
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getExternalSubtitleByIdForMediaItem
    // ========================================================================

    describe('getExternalSubtitleByIdForMediaItem', () => {
        it('returns subtitle when it belongs to the media item', async () => {
            await upsertExternalSubtitle(sql, {
                fileId: testFileId,
                subtitlePath: '/test/movie.en.srt',
                language: 'en',
                format: 'srt',
                isForced: false,
                isSDH: false,
            });

            const [inserted] = await sql<{ id: string }[]>`
                SELECT id FROM external_subtitle_files WHERE subtitle_path = ${'/test/movie.en.srt'}
            `;

            const row = await getExternalSubtitleByIdForMediaItem(
                sql,
                inserted.id,
                testMediaItemId,
            );
            expect(row).not.toBeNull();
        });

        it('returns null when subtitle does not belong to media item', async () => {
            // Create another file/media not linked to testMediaItemId
            const otherFileId = crypto.randomUUID();
            const otherMediaId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${otherFileId}::uuid, ${'/test/other.mkv'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${otherMediaId}::uuid, ${'Other Movie'}, 'movie', 'active')
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${otherFileId}::uuid, ${otherMediaId}::uuid)
            `;
            await upsertExternalSubtitle(sql, {
                fileId: otherFileId,
                subtitlePath: '/test/other.en.srt',
                language: 'en',
                format: 'srt',
                isForced: false,
                isSDH: false,
            });

            const [inserted] = await sql<{ id: string }[]>`
                SELECT id FROM external_subtitle_files WHERE subtitle_path = ${'/test/other.en.srt'}
            `;

            const row = await getExternalSubtitleByIdForMediaItem(
                sql,
                inserted.id,
                testMediaItemId,
            );
            expect(row).toBeNull();
        });
    });
});
