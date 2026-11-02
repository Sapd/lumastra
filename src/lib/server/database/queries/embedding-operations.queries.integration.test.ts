// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Embedding Operations Query Module
 *
 * Tests metadata updates, embedding upserts, and batch aggregation queries
 * against a real PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    createTestEmbedding,
    insertTestEmbedding,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';

import {
    updateMediaItemMetadata,
    upsertMediaEmbedding,
    getMediaItemCore,
    getMediaItemExternalIds,
    getMediaItemEmbeddings,
    getMediaItemAvailability,
    batchGetMediaItems,
    batchGetExternalIds,
    batchGetEmbeddings,
    batchGetLibraryAvailability,
} from './embedding-operations.queries.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Embedding Operations Queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    // ========================================================================
    // Helpers
    // ========================================================================

    async function seedMovie(
        tmdbId: number,
        options: { withEmbedding?: boolean; withFile?: boolean } = {},
    ): Promise<string> {
        const id = crypto.randomUUID();
        const item = createTestMediaItem({
            id,
            title: `Embed Op Movie ${tmdbId}`,
            media_type: 'movie',
            year: 2024,
        });
        await insertTestMediaItem(sql, item);
        await insertTestExternalIds(sql, createTestExternalIds(id, { tmdbId, mediaType: 'movie' }));
        if (options.withEmbedding) {
            await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.LIBRARY));
        }
        if (options.withFile) {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/${id}.mkv`}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${id}::uuid)
            `;
        }
        return id;
    }

    // ========================================================================
    // updateMediaItemMetadata
    // ========================================================================

    describe('updateMediaItemMetadata', () => {
        it('updates title and year', async () => {
            const id = await seedMovie(990200);

            await updateMediaItemMetadata(sql, {
                mediaId: id,
                title: 'Updated Title',
                originalTitle: 'Original Title',
                year: 2025,
                isLocalOnly: true,
            });

            const [row] = await sql<{ title: string; year: number; is_local_only: boolean }[]>`
                SELECT title, year, is_local_only FROM media_items WHERE id = ${id}::uuid
            `;
            expect(row.title).toBe('Updated Title');
            expect(row.year).toBe(2025);
            expect(row.is_local_only).toBe(true);
        });

        it('preserves existing year when null is passed', async () => {
            const id = await seedMovie(990201);

            await updateMediaItemMetadata(sql, {
                mediaId: id,
                title: 'Updated',
                originalTitle: null,
                year: null,
                isLocalOnly: false,
            });

            const [row] = await sql<{ year: number }[]>`
                SELECT year FROM media_items WHERE id = ${id}::uuid
            `;
            expect(row.year).toBe(2024);
        });
    });

    // ========================================================================
    // upsertMediaEmbedding
    // ========================================================================

    describe('upsertMediaEmbedding', () => {
        it('inserts a new embedding', async () => {
            const id = await seedMovie(990202);
            const vectorStr = '[' + Array(1024).fill(0.1).join(',') + ']';

            await upsertMediaEmbedding(sql, {
                mediaId: id,
                source: 'test-source',
                embeddingVector: vectorStr,
            });

            const rows = await getMediaItemEmbeddings(sql, id);
            expect(rows.length).toBe(1);
            expect(rows[0].source).toBe('test-source');
        });

        it('updates on conflict', async () => {
            const id = await seedMovie(990203);

            await upsertMediaEmbedding(sql, {
                mediaId: id,
                source: 'library',
                embeddingVector: '[' + Array(1024).fill(0.1).join(',') + ']',
            });
            await upsertMediaEmbedding(sql, {
                mediaId: id,
                source: 'library',
                embeddingVector: '[' + Array(1024).fill(0.9).join(',') + ']',
            });

            const rows = await getMediaItemEmbeddings(sql, id);
            expect(rows.length).toBe(1);
            expect(rows[0].source).toBe('library');
        });
    });

    // ========================================================================
    // getMediaItemCore
    // ========================================================================

    describe('getMediaItemCore', () => {
        it('returns core fields for active media', async () => {
            const id = await seedMovie(990206);

            const row = await getMediaItemCore(sql, id);
            expect(row).not.toBeNull();
            expect(row!.id).toBe(id);
            expect(row!.title).toContain('Embed Op Movie');
            expect(row!.media_type).toBe('movie');
        });

        it('returns null for deleted media', async () => {
            const id = await seedMovie(990207);
            await sql`
                UPDATE media_items SET status = 'deleted' WHERE id = ${id}::uuid
            `;

            const row = await getMediaItemCore(sql, id);
            expect(row).toBeNull();
        });

        it('returns null for unknown id', async () => {
            const row = await getMediaItemCore(sql, crypto.randomUUID());
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getMediaItemExternalIds
    // ========================================================================

    describe('getMediaItemExternalIds', () => {
        it('returns external ids for a media item', async () => {
            const id = await seedMovie(990208);

            const rows = await getMediaItemExternalIds(sql, id);
            expect(rows.length).toBeGreaterThanOrEqual(1);
            expect(rows.some((r) => r.provider === 'tmdb')).toBe(true);
        });

        it('returns empty array when no external ids', async () => {
            const id = crypto.randomUUID();
            await insertTestMediaItem(sql, createTestMediaItem({ id, media_type: 'movie' }));

            const rows = await getMediaItemExternalIds(sql, id);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getMediaItemEmbeddings
    // ========================================================================

    describe('getMediaItemEmbeddings', () => {
        it('returns embeddings for a media item', async () => {
            const id = await seedMovie(990209, { withEmbedding: true });

            const rows = await getMediaItemEmbeddings(sql, id);
            expect(rows.length).toBe(1);
            expect(rows[0].source).toBe(EMBEDDING_SOURCE.LIBRARY);
        });

        it('returns empty array when no embeddings', async () => {
            const id = await seedMovie(990210);

            const rows = await getMediaItemEmbeddings(sql, id);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getMediaItemAvailability
    // ========================================================================

    describe('getMediaItemAvailability', () => {
        it('returns available true when file item exists', async () => {
            const id = await seedMovie(990211, { withFile: true });

            const result = await getMediaItemAvailability(sql, id);
            expect(result).not.toBeNull();
            expect(result!.available).toBe(true);
        });

        it('returns available false when no file item exists', async () => {
            const id = await seedMovie(990212);

            const result = await getMediaItemAvailability(sql, id);
            expect(result).not.toBeNull();
            expect(result!.available).toBe(false);
        });
    });

    // ========================================================================
    // batchGetMediaItems
    // ========================================================================

    describe('batchGetMediaItems', () => {
        it('returns media items for given UUIDs', async () => {
            const id1 = await seedMovie(990213);
            const id2 = await seedMovie(990214);

            const rows = await batchGetMediaItems(sql, [id1, id2]);
            expect(rows.length).toBe(2);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(id1);
            expect(ids).toContain(id2);
        });

        it('skips deleted items', async () => {
            const id = await seedMovie(990215);
            await sql`
                UPDATE media_items SET status = 'deleted' WHERE id = ${id}::uuid
            `;

            const rows = await batchGetMediaItems(sql, [id]);
            expect(rows).toEqual([]);
        });

        it('returns empty array for empty input', async () => {
            const rows = await batchGetMediaItems(sql, []);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // batchGetExternalIds
    // ========================================================================

    describe('batchGetExternalIds', () => {
        it('returns external ids for multiple media items', async () => {
            const id1 = await seedMovie(990216);
            const id2 = await seedMovie(990217);

            const rows = await batchGetExternalIds(sql, [id1, id2]);
            expect(rows.length).toBeGreaterThanOrEqual(2);
        });
    });

    // ========================================================================
    // batchGetEmbeddings
    // ========================================================================

    describe('batchGetEmbeddings', () => {
        it('returns embeddings for multiple media items', async () => {
            const id1 = await seedMovie(990218, { withEmbedding: true });
            const id2 = await seedMovie(990219, { withEmbedding: true });

            const rows = await batchGetEmbeddings(sql, [id1, id2]);
            expect(rows.length).toBe(2);
        });
    });

    // ========================================================================
    // batchGetLibraryAvailability
    // ========================================================================

    describe('batchGetLibraryAvailability', () => {
        it('returns available items with file links', async () => {
            const id1 = await seedMovie(990220, { withFile: true });
            const id2 = await seedMovie(990221);

            const rows = await batchGetLibraryAvailability(sql, [id1, id2]);
            expect(rows.length).toBe(1);
            expect(rows[0].media_id).toBe(id1);
            expect(rows[0].available).toBe(true);
        });
    });
});
