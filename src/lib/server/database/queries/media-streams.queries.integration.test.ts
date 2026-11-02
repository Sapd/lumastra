// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Streams Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import { upsertMediaFile, attachFileToItem } from './media-files.queries.js';

import {
    replaceStreamsForFile,
    getStreamsForMediaItem,
    getStreamsForFile,
    getAudioStreamsForMediaItem,
} from './media-streams.queries.js';

describe('Media Streams Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE media_streams, media_file_items, media_files, media_items RESTART IDENTITY CASCADE',
        );
    });

    async function createFileWithItem(
        filePath = '/movies/test.mkv',
    ): Promise<{ fileId: string; itemId: string }> {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        const { id: fileId } = await upsertMediaFile(sql, { filePath });
        await attachFileToItem(sql, fileId, item.id);
        return { fileId, itemId: item.id };
    }

    // ========================================================================
    // replaceStreamsForFile
    // ========================================================================

    describe('replaceStreamsForFile', () => {
        it('inserts streams for a file', async () => {
            const { fileId } = await createFileWithItem();

            await replaceStreamsForFile(sql, fileId, [
                {
                    file_id: fileId,
                    stream_type: 'video',
                    stream_index: 0,
                    codec: 'h264',
                    is_default: true,
                    is_forced: false,
                },
                {
                    file_id: fileId,
                    stream_type: 'audio',
                    stream_index: 1,
                    codec: 'aac',
                    is_default: true,
                    is_forced: false,
                },
            ]);

            const rows = await sql`
                SELECT * FROM media_streams WHERE file_id = ${fileId}::uuid ORDER BY stream_index
            `;
            expect(rows).toHaveLength(2);
            expect(rows[0].stream_type).toBe('video');
            expect(rows[1].stream_type).toBe('audio');
        });

        it('replaces existing streams', async () => {
            const { fileId } = await createFileWithItem();

            await replaceStreamsForFile(sql, fileId, [
                {
                    file_id: fileId,
                    stream_type: 'video',
                    stream_index: 0,
                    codec: 'h264',
                    is_default: true,
                    is_forced: false,
                },
            ]);
            await replaceStreamsForFile(sql, fileId, [
                {
                    file_id: fileId,
                    stream_type: 'video',
                    stream_index: 0,
                    codec: 'hevc',
                    is_default: true,
                    is_forced: false,
                },
            ]);

            const rows = await sql`
                SELECT * FROM media_streams WHERE file_id = ${fileId}::uuid
            `;
            expect(rows).toHaveLength(1);
            expect(rows[0].codec).toBe('hevc');
        });

        it('is a no-op for empty stream array', async () => {
            const { fileId } = await createFileWithItem();
            await replaceStreamsForFile(sql, fileId, []);
            const rows = await sql`
                SELECT * FROM media_streams WHERE file_id = ${fileId}::uuid
            `;
            expect(rows).toHaveLength(0);
        });
    });

    // ========================================================================
    // getStreamsForMediaItem
    // ========================================================================

    describe('getStreamsForMediaItem', () => {
        it('returns streams ordered by type and index', async () => {
            const { fileId, itemId } = await createFileWithItem();

            await replaceStreamsForFile(sql, fileId, [
                {
                    file_id: fileId,
                    stream_type: 'audio',
                    stream_index: 1,
                    codec: 'aac',
                    is_default: true,
                    is_forced: false,
                },
                {
                    file_id: fileId,
                    stream_type: 'video',
                    stream_index: 0,
                    codec: 'h264',
                    is_default: true,
                    is_forced: false,
                },
            ]);

            const rows = await getStreamsForMediaItem(sql, itemId);
            expect(rows).toHaveLength(2);
            // audio comes before video alphabetically? No, ORDER BY stream_type, stream_index
            // 'audio' < 'video', so audio first? Wait, the order is stream_type ASC, stream_index ASC
            // audio comes before video
            expect(rows[0].stream_type).toBe('audio');
            expect(rows[1].stream_type).toBe('video');
        });

        it('returns empty array when item has no files', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const rows = await getStreamsForMediaItem(sql, item.id);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getStreamsForFile
    // ========================================================================

    describe('getStreamsForFile', () => {
        it('returns streams for a specific file', async () => {
            const { fileId } = await createFileWithItem();

            await replaceStreamsForFile(sql, fileId, [
                {
                    file_id: fileId,
                    stream_type: 'subtitle',
                    stream_index: 2,
                    codec: 'srt',
                    is_default: false,
                    is_forced: false,
                },
            ]);

            const rows = await getStreamsForFile(sql, fileId);
            expect(rows).toHaveLength(1);
            expect(rows[0].codec).toBe('srt');
        });

        it('verifies file belongs to mediaItemId when provided', async () => {
            const { fileId, itemId } = await createFileWithItem();
            const otherItem = createTestMediaItem({
                media_type: 'movie',
                id: crypto.randomUUID(),
            });
            await insertTestMediaItem(sql, otherItem);

            await replaceStreamsForFile(sql, fileId, [
                {
                    file_id: fileId,
                    stream_type: 'video',
                    stream_index: 0,
                    codec: 'h264',
                    is_default: true,
                    is_forced: false,
                },
            ]);

            const rows = await getStreamsForFile(sql, fileId, itemId);
            expect(rows).toHaveLength(1);

            const mismatched = await getStreamsForFile(sql, fileId, otherItem.id);
            expect(mismatched).toEqual([]);
        });
    });

    // ========================================================================
    // getAudioStreamsForMediaItem
    // ========================================================================

    describe('getAudioStreamsForMediaItem', () => {
        it('returns only audio streams', async () => {
            const { fileId, itemId } = await createFileWithItem();

            await replaceStreamsForFile(sql, fileId, [
                {
                    file_id: fileId,
                    stream_type: 'video',
                    stream_index: 0,
                    codec: 'h264',
                    is_default: true,
                    is_forced: false,
                },
                {
                    file_id: fileId,
                    stream_type: 'audio',
                    stream_index: 1,
                    codec: 'aac',
                    language: 'eng',
                    is_default: true,
                    is_forced: false,
                },
            ]);

            const rows = await getAudioStreamsForMediaItem(sql, itemId);
            expect(rows).toHaveLength(1);
            expect(rows[0].stream_type).toBe('audio');
            expect(rows[0].language).toBe('eng');
        });
    });

    // ========================================================================
    // Accessibility fields (is_hearing_impaired / is_visual_impaired / has_closed_captions)
    // ========================================================================

    describe('accessibility fields', () => {
        it('round-trips is_hearing_impaired / is_visual_impaired / has_closed_captions', async () => {
            const { fileId, itemId } = await createFileWithItem();

            await replaceStreamsForFile(sql, fileId, [
                {
                    file_id: fileId,
                    stream_type: 'video',
                    stream_index: 0,
                    codec: 'hevc',
                    is_default: true,
                    is_forced: false,
                    has_closed_captions: true,
                },
                {
                    file_id: fileId,
                    stream_type: 'audio',
                    stream_index: 1,
                    codec: 'eac3',
                    is_default: true,
                    is_forced: false,
                    is_visual_impaired: true,
                },
                {
                    file_id: fileId,
                    stream_type: 'subtitle',
                    stream_index: 2,
                    codec: 'subrip',
                    is_default: false,
                    is_forced: false,
                    is_hearing_impaired: true,
                },
            ]);

            const rows = await getStreamsForMediaItem(sql, itemId);
            expect(rows.find((r) => r.stream_type === 'video')?.has_closed_captions).toBe(true);
            expect(rows.find((r) => r.stream_type === 'audio')?.is_visual_impaired).toBe(true);
            expect(rows.find((r) => r.stream_type === 'subtitle')?.is_hearing_impaired).toBe(true);
        });
    });
});
