// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Latest Embeddings Query Module
 *
 * Tests retrieval of latest embedding rows with library/discovery filtering.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';

import { getLatestEmbeddings } from './latest-embeddings.queries.js';

describe('Latest Embeddings Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_embeddings',
            'provider_metadata',
            'provider_capabilities',
            'external_ids',
            'media_items',
        ]);
    });

    async function createItemWithEmbedding(
        mediaType: 'movie' | 'tv',
        source: string,
    ): Promise<string> {
        const item = createTestMediaItem({ media_type: mediaType });
        await insertTestMediaItem(sql, item);

        // Insert a minimal embedding
        const vector = Array.from({ length: 1024 }, () => Math.random());
        await sql`
            INSERT INTO media_embeddings (media_id, embedding, source)
            VALUES (
                ${item.id}::uuid,
                ${`[${vector.join(',')}]`}::vector,
                ${source}
            )
        `;

        return item.id;
    }

    // ========================================================================
    // getLatestEmbeddings
    // ========================================================================

    describe('getLatestEmbeddings', () => {
        it('returns items ordered by updated time', async () => {
            const id1 = await createItemWithEmbedding('movie', EMBEDDING_SOURCE.LIBRARY);

            await new Promise((r) => setTimeout(r, 50));

            const id2 = await createItemWithEmbedding('tv', EMBEDDING_SOURCE.LIBRARY);

            const result = await getLatestEmbeddings(sql, {
                limit: 10,
                source: null,
            });

            expect(result.length).toBeGreaterThanOrEqual(2);
            const ids = result.map((r) => r.internal_id);
            expect(ids).toContain(id1);
            expect(ids).toContain(id2);
        });

        it('filters by library source', async () => {
            const libId = await createItemWithEmbedding('movie', EMBEDDING_SOURCE.LIBRARY);
            await createItemWithEmbedding('tv', EMBEDDING_SOURCE.DISCOVERY);

            const result = await getLatestEmbeddings(sql, {
                limit: 10,
                source: 'library',
            });

            const ids = result.map((r) => r.internal_id);
            expect(ids).toContain(libId);
        });

        it('filters by discovery source', async () => {
            await createItemWithEmbedding('movie', EMBEDDING_SOURCE.LIBRARY);
            const discId = await createItemWithEmbedding('tv', EMBEDDING_SOURCE.DISCOVERY);

            const result = await getLatestEmbeddings(sql, {
                limit: 10,
                source: 'tmdb',
            });

            const ids = result.map((r) => r.internal_id);
            expect(ids).toContain(discId);
        });

        it('returns empty array when no items match', async () => {
            const result = await getLatestEmbeddings(sql, {
                limit: 10,
                source: 'library',
            });
            expect(result).toEqual([]);
        });

        it('includes has_library and has_discovery flags', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Insert only library embedding
            const vector = Array.from({ length: 1024 }, () => Math.random());
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (
                    ${item.id}::uuid,
                    ${`[${vector.join(',')}]`}::vector,
                    ${EMBEDDING_SOURCE.LIBRARY}
                )
            `;

            const result = await getLatestEmbeddings(sql, {
                limit: 10,
                source: null,
            });

            const row = result.find((r) => r.internal_id === item.id);
            expect(row).toBeDefined();
            expect(row!.has_library).toBe(true);
            expect(row!.has_discovery).toBe(false);
        });

        it('includes provider metadata fields when available', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const vector = Array.from({ length: 1024 }, () => Math.random());
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (
                    ${item.id}::uuid,
                    ${`[${vector.join(',')}]`}::vector,
                    ${EMBEDDING_SOURCE.LIBRARY}
                )
            `;

            await sql`
                INSERT INTO provider_capabilities (provider, enabled, priority)
                VALUES ('tmdb', true, 1)
                ON CONFLICT (provider) DO UPDATE SET enabled = true
            `;

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${item.id}::uuid,
                    'tmdb',
                    ${sql.json({
                        overview: 'Test movie',
                        genres: [28, 12],
                        keywords: ['action'],
                        imdb_rating: 7.5,
                        tmdb_rating: 8.0,
                        rt_rating: 85,
                        letterboxd_rating: 3.5,
                        mdblist_score: 75,
                        runtime_minutes: 120,
                        streaming_services: ['Harborline'],
                    })},
                    NOW()
                )
            `;

            const result = await getLatestEmbeddings(sql, {
                limit: 10,
                source: null,
            });

            const row = result.find((r) => r.internal_id === item.id);
            expect(row).toBeDefined();
            expect(row!.overview).toBe('Test movie');
            expect(row!.imdb_rating).toBe(7.5);
            expect(row!.tmdb_rating).toBe(8.0);
            expect(row!.rt_rating).toBe(85);
            expect(row!.mdblist_score).toBe(75);
            expect(row!.runtime_minutes).toBe(120);
        });

        it('limits results correctly', async () => {
            // Create 5 items
            for (let i = 0; i < 5; i++) {
                await createItemWithEmbedding('movie', EMBEDDING_SOURCE.LIBRARY);
            }

            const result = await getLatestEmbeddings(sql, {
                limit: 3,
                source: 'library',
            });
            expect(result.length).toBeLessThanOrEqual(3);
        });
    });
});
