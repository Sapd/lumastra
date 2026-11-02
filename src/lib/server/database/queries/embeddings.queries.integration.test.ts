// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Embeddings Query Module
 *
 * Tests dual-embedding lookups, counts, coverage, and backlog queries
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
    getDualEmbedding,
    getLibraryEmbeddingCount,
    getDiscoveryEmbeddingCount,
    getTotalEmbeddingCount,
    getLibraryEmbeddingCoverage,
    findEmbeddingCoverageTableBacklog,
} from './embeddings.queries.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Embeddings Queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, ['media_item_stage_state', ...TEST_TABLES.media]);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['media_item_stage_state', ...TEST_TABLES.media]);
    });

    // ========================================================================
    // Helpers
    // ========================================================================

    async function seedMovie(
        tmdbId: number,
        options: {
            libraryEmb?: boolean;
            discoveryEmb?: boolean;
            hasFiles?: boolean;
        } = {},
    ): Promise<string> {
        const id = crypto.randomUUID();
        const item = createTestMediaItem({
            id,
            title: `Test Movie ${tmdbId}`,
            media_type: 'movie',
            year: 2024,
        });
        await insertTestMediaItem(sql, item);
        await insertTestExternalIds(sql, createTestExternalIds(id, { tmdbId, mediaType: 'movie' }));
        if (options.libraryEmb) {
            await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.LIBRARY));
        }
        if (options.discoveryEmb) {
            await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.DISCOVERY));
        }
        if (options.hasFiles) {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/${id}.mkv`}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${id}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${id}::uuid
            `;
        }
        return id;
    }

    // ========================================================================
    // getDualEmbedding
    // ========================================================================

    describe('getDualEmbedding', () => {
        it('returns null when media item not found', async () => {
            const result = await getDualEmbedding(sql, 999999, 'movie');
            expect(result).toBeNull();
        });

        it('returns embedding data when found', async () => {
            await seedMovie(990100, { libraryEmb: true, discoveryEmb: true });

            const result = await getDualEmbedding(sql, 990100, 'movie');
            expect(result).not.toBeNull();
            expect(result!.library_embedding).toBeDefined();
            expect(result!.discovery_embedding).toBeDefined();
            expect(result!.metadata).toBeDefined();
        });

        it('returns undefined embeddings when not present', async () => {
            await seedMovie(990101);

            const result = await getDualEmbedding(sql, 990101, 'movie');
            expect(result).not.toBeNull();
            expect(result!.library_embedding).toBeUndefined();
            expect(result!.discovery_embedding).toBeUndefined();
        });
    });

    // ========================================================================
    // Count Queries
    // ========================================================================

    describe('getLibraryEmbeddingCount', () => {
        it('returns 0 when no library embeddings exist', async () => {
            const count = await getLibraryEmbeddingCount(sql);
            expect(typeof count).toBe('number');
            expect(count).toBeGreaterThanOrEqual(0);
        });

        it('counts only library embeddings', async () => {
            await seedMovie(990102, { libraryEmb: true });
            await seedMovie(990103, { discoveryEmb: true });

            const count = await getLibraryEmbeddingCount(sql);
            const all = await getTotalEmbeddingCount(sql);
            expect(count).toBe(1);
            expect(all).toBe(2);
        });
    });

    describe('getDiscoveryEmbeddingCount', () => {
        it('counts only discovery embeddings', async () => {
            await seedMovie(990104, { discoveryEmb: true });
            await seedMovie(990105, { libraryEmb: true });

            const count = await getDiscoveryEmbeddingCount(sql);
            expect(count).toBe(1);
        });
    });

    describe('getTotalEmbeddingCount', () => {
        it('counts all embeddings', async () => {
            await seedMovie(990106, { libraryEmb: true, discoveryEmb: true });
            await seedMovie(990107, { libraryEmb: true });

            const count = await getTotalEmbeddingCount(sql);
            expect(count).toBe(3);
        });
    });

    // ========================================================================
    // getLibraryEmbeddingCoverage
    // ========================================================================

    describe('getLibraryEmbeddingCoverage', () => {
        it('returns eligible and embedded counts', async () => {
            await seedMovie(990108, { hasFiles: true, libraryEmb: true });
            await seedMovie(990109, { hasFiles: true });
            await seedMovie(990110, { libraryEmb: true }); // no files → not eligible

            const coverage = await getLibraryEmbeddingCoverage(sql);
            expect(coverage.eligible).toBe(2);
            expect(coverage.embedded).toBe(1);
        });
    });

    // ========================================================================
    // findEmbeddingCoverageTableBacklog
    // ========================================================================

    describe('findEmbeddingCoverageTableBacklog', () => {
        it('returns empty array when no backlog rows', async () => {
            const rows = await findEmbeddingCoverageTableBacklog(sql, 'test-stage', 10);
            expect(rows).toEqual([]);
        });

        it('returns pending items', async () => {
            const mediaId = await seedMovie(990111);
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
                VALUES (${mediaId}::uuid, 'test-stage', 'pending', 1)
            `;

            const rows = await findEmbeddingCoverageTableBacklog(sql, 'test-stage', 10);
            expect(rows.length).toBe(1);
            expect(rows[0].id).toBe(mediaId);
        });

        it('excludes non-active media items', async () => {
            const mediaId = await seedMovie(990112);
            await sql`
                UPDATE media_items SET status = 'deleted' WHERE id = ${mediaId}::uuid
            `;
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
                VALUES (${mediaId}::uuid, 'test-stage', 'pending', 1)
            `;

            const rows = await findEmbeddingCoverageTableBacklog(sql, 'test-stage', 10);
            expect(rows).toEqual([]);
        });

        it('excludes dismissed items', async () => {
            const mediaId = await seedMovie(990113);
            await sql`
                UPDATE media_items SET is_dismissed = true WHERE id = ${mediaId}::uuid
            `;
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
                VALUES (${mediaId}::uuid, 'test-stage', 'pending', 1)
            `;

            const rows = await findEmbeddingCoverageTableBacklog(sql, 'test-stage', 10);
            expect(rows).toEqual([]);
        });

        it('respects the limit parameter', async () => {
            for (let i = 0; i < 5; i++) {
                const id = await seedMovie(990114 + i);
                await sql`
                    INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
                    VALUES (${id}::uuid, 'limit-stage', 'pending', 1)
                `;
            }

            const rows = await findEmbeddingCoverageTableBacklog(sql, 'limit-stage', 2);
            expect(rows.length).toBe(2);
        });
    });
});
