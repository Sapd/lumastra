// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media File Resolution Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import { upsertMediaFile, attachFileToItem } from './media-files.queries.js';

import { resolvePlaybackSelection, resolveMediaFiles } from './media-file-resolution.queries.js';

describe('Media File Resolution Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE media_file_items, media_files, media_items RESTART IDENTITY CASCADE',
        );
    });

    // ========================================================================
    // resolvePlaybackSelection
    // ========================================================================

    describe('resolvePlaybackSelection', () => {
        it('returns empty result when no files linked', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await resolvePlaybackSelection(sql, item.id);
            expect(result.files).toEqual([]);
            expect(result.fileId).toBeNull();
        });

        it('returns all files and default fileId when no options.fileId', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId1 } = await upsertMediaFile(sql, {
                filePath: '/movies/A.mkv',
            });
            const { id: fileId2 } = await upsertMediaFile(sql, {
                filePath: '/movies/B.mkv',
            });
            await attachFileToItem(sql, fileId1, item.id);
            await attachFileToItem(sql, fileId2, item.id);

            const result = await resolvePlaybackSelection(sql, item.id);
            expect(result.files).toHaveLength(2);
            // First attached becomes default
            expect(result.fileId).toBe(fileId1);
        });

        it('returns only the matched file when options.fileId specified', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId1 } = await upsertMediaFile(sql, {
                filePath: '/movies/A.mkv',
            });
            const { id: fileId2 } = await upsertMediaFile(sql, {
                filePath: '/movies/B.mkv',
            });
            await attachFileToItem(sql, fileId1, item.id);
            await attachFileToItem(sql, fileId2, item.id);

            const result = await resolvePlaybackSelection(sql, item.id, {
                fileId: fileId2,
            });
            expect(result.files).toHaveLength(1);
            expect(result.files[0].id).toBe(fileId2);
            expect(result.fileId).toBe(fileId2);
        });

        it('returns empty result for non-matching fileId', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId1 } = await upsertMediaFile(sql, {
                filePath: '/movies/A.mkv',
            });
            await attachFileToItem(sql, fileId1, item.id);

            const result = await resolvePlaybackSelection(sql, item.id, {
                fileId: '00000000-0000-0000-0000-000000000000',
            });
            expect(result.files).toEqual([]);
            expect(result.fileId).toBeNull();
        });
    });

    // ========================================================================
    // resolveMediaFiles
    // ========================================================================

    describe('resolveMediaFiles', () => {
        it('returns just the files array', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: '/movies/A.mkv',
            });
            await attachFileToItem(sql, fileId, item.id);

            const files = await resolveMediaFiles(sql, item.id);
            expect(files).toHaveLength(1);
            expect(files[0].id).toBe(fileId);
        });
    });
});
