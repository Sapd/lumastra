// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Suggestion Engine Query Module
 *
 * Tests getTestExcludeQuery, getTotalMovieCount, getTotalTvCount.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestTvShow,
    insertTestEmbedding,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';

import {
    getTestExcludeQuery,
    getTotalMovieCount,
    getTotalTvCount,
} from './suggestion-engine.queries.js';

describe('Suggestion Engine Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    // ========================================================================
    // getTestExcludeQuery
    // ========================================================================

    describe('getTestExcludeQuery', () => {
        it('returns total and after-exclude counts', async () => {
            const { id: movieId, tmdbId } = await createAndInsertTestMovie(sql, { tmdbId: 990001 });
            await insertTestEmbedding(sql, {
                media_id: movieId,
                embedding: Array.from({ length: 1024 }, () => 0.01),
                source: EMBEDDING_SOURCE.LIBRARY,
            });

            const result = await getTestExcludeQuery(sql, [[String(tmdbId), 'movie']]);

            expect(result).not.toBeNull();
            expect(result!.total).toBe(1);
            expect(result!.after_exclude).toBe(0);
        });

        it('does not exclude unmatched items', async () => {
            const { id: movieId } = await createAndInsertTestMovie(sql);
            await insertTestEmbedding(sql, {
                media_id: movieId,
                embedding: Array.from({ length: 1024 }, () => 0.01),
                source: EMBEDDING_SOURCE.LIBRARY,
            });

            const result = await getTestExcludeQuery(sql, [['999999', 'movie']]);

            expect(result).not.toBeNull();
            expect(result!.total).toBe(1);
            expect(result!.after_exclude).toBe(1);
        });

        it('returns zero counts when no media with embeddings exist', async () => {
            const result = await getTestExcludeQuery(sql, [['999999', 'movie']]);
            expect(result).not.toBeNull();
            expect(result!.total).toBe(0);
            expect(result!.after_exclude).toBe(0);
        });
    });

    // ========================================================================
    // getTotalMovieCount
    // ========================================================================

    describe('getTotalMovieCount', () => {
        it('counts active, library-backed movies with embeddings', async () => {
            const { id: id1 } = await createAndInsertTestMovie(sql, {
                withFileItem: true,
            });
            const { id: id2 } = await createAndInsertTestMovie(sql, {
                withFileItem: true,
            });
            await insertTestEmbedding(sql, {
                media_id: id1,
                embedding: Array.from({ length: 1024 }, () => 0.01),
                source: EMBEDDING_SOURCE.LIBRARY,
            });
            await insertTestEmbedding(sql, {
                media_id: id2,
                embedding: Array.from({ length: 1024 }, () => 0.01),
                source: EMBEDDING_SOURCE.DISCOVERY,
            });

            const count = await getTotalMovieCount(sql);
            expect(count).toBe(2);
        });

        // IDENT-H5: catalog ghosts (active movie metadata with an embedding but
        // no files on disk) must NOT be counted as library content.
        it('ignores movies without files (has_files = false)', async () => {
            const { id } = await createAndInsertTestMovie(sql);
            await insertTestEmbedding(sql, {
                media_id: id,
                embedding: Array.from({ length: 1024 }, () => 0.01),
                source: EMBEDDING_SOURCE.LIBRARY,
            });

            const count = await getTotalMovieCount(sql);
            expect(count).toBe(0);
        });

        it('ignores movies without embeddings', async () => {
            await createAndInsertTestMovie(sql, { withFileItem: true });

            const count = await getTotalMovieCount(sql);
            expect(count).toBe(0);
        });

        it('ignores non-active movies', async () => {
            const { id } = await createAndInsertTestMovie(sql, {
                withFileItem: true,
            });
            await insertTestEmbedding(sql, {
                media_id: id,
                embedding: Array.from({ length: 1024 }, () => 0.01),
                source: EMBEDDING_SOURCE.LIBRARY,
            });
            await sql`
                UPDATE media_items SET status = 'deleted' WHERE id = ${id}::uuid
            `;

            const count = await getTotalMovieCount(sql);
            expect(count).toBe(0);
        });
    });

    // ========================================================================
    // getTotalTvCount
    // ========================================================================

    describe('getTotalTvCount', () => {
        it('counts active TV shows with embeddings', async () => {
            const { id: id1 } = await createAndInsertTestTvShow(sql);
            await insertTestEmbedding(sql, {
                media_id: id1,
                embedding: Array.from({ length: 1024 }, () => 0.01),
                source: EMBEDDING_SOURCE.LIBRARY,
            });

            const count = await getTotalTvCount(sql);
            expect(count).toBe(1);
        });

        it('returns 0 when no TV shows have embeddings', async () => {
            await createAndInsertTestTvShow(sql);

            const count = await getTotalTvCount(sql);
            expect(count).toBe(0);
        });
    });
});
