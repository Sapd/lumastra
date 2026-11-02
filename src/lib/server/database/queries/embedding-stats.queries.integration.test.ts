// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Embedding Stats Query Module
 *
 * Tests overview, video, and music embedding statistics queries
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
    getEmbeddingOverviewStats,
    getVideoEmbeddingStats,
    getMusicEmbeddingStats,
} from './embedding-stats.queries.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Embedding Stats Queries', () => {
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
        options: { libraryEmb?: boolean; discoveryEmb?: boolean } = {},
    ): Promise<string> {
        const id = crypto.randomUUID();
        const item = createTestMediaItem({
            id,
            title: `Stats Movie ${tmdbId}`,
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
        return id;
    }

    async function seedTrack(options: { withEmbedding?: boolean } = {}): Promise<string> {
        const id = crypto.randomUUID();
        await insertTestMediaItem(
            sql,
            createTestMediaItem({
                id,
                title: 'Test Track',
                media_type: 'track',
                year: null,
            }),
        );
        if (options.withEmbedding) {
            await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.MUSIC));
        }
        return id;
    }

    // ========================================================================
    // getEmbeddingOverviewStats
    // ========================================================================

    describe('getEmbeddingOverviewStats', () => {
        it('returns media type counts', async () => {
            await seedMovie(990400);
            await seedMovie(990401);

            const stats = await getEmbeddingOverviewStats(sql);
            expect(stats.mediaTypeCounts).toBeInstanceOf(Array);
            const movieCount = stats.mediaTypeCounts.find((r) => r.media_type === 'movie');
            expect(movieCount).toBeDefined();
        });

        it('returns source counts', async () => {
            await seedMovie(990402, { libraryEmb: true });
            await seedMovie(990403, { discoveryEmb: true });

            const stats = await getEmbeddingOverviewStats(sql);
            expect(stats.sourceCounts.length).toBeGreaterThanOrEqual(1);
        });

        it('returns overview counts', async () => {
            const stats = await getEmbeddingOverviewStats(sql);
            expect(stats.overviewCounts).toBeInstanceOf(Array);
            expect(stats.overviewCounts.length).toBe(1);
        });
    });

    // ========================================================================
    // getVideoEmbeddingStats
    // ========================================================================

    describe('getVideoEmbeddingStats', () => {
        it('returns quality metrics', async () => {
            const stats = await getVideoEmbeddingStats(sql);
            expect(stats.quality).toBeInstanceOf(Array);
            expect(stats.quality.length).toBe(1);
        });

        it('returns coverage metrics', async () => {
            await seedMovie(990404, { libraryEmb: true });
            await seedMovie(990405, { discoveryEmb: true });
            await seedMovie(990406);

            const stats = await getVideoEmbeddingStats(sql);
            expect(stats.coverage).toBeInstanceOf(Array);
            expect(stats.coverage.length).toBe(1);
            const cov = stats.coverage[0];
            expect(Number(cov.has_library_embedding)).toBeGreaterThanOrEqual(1);
            expect(Number(cov.has_discovery_embedding)).toBeGreaterThanOrEqual(1);
            expect(Number(cov.no_embeddings)).toBeGreaterThanOrEqual(1);
        });

        it('returns recent items', async () => {
            await seedMovie(990407);

            const stats = await getVideoEmbeddingStats(sql);
            expect(stats.recent).toBeInstanceOf(Array);
        });

        it('returns noExternalId items', async () => {
            const id = crypto.randomUUID();
            await insertTestMediaItem(sql, createTestMediaItem({ id, media_type: 'movie' }));

            const stats = await getVideoEmbeddingStats(sql);
            expect(stats.noExternalId).toBeInstanceOf(Array);
        });

        it('returns sample items', async () => {
            await seedMovie(990408);

            const stats = await getVideoEmbeddingStats(sql);
            expect(stats.sample).toBeInstanceOf(Array);
        });
    });

    // ========================================================================
    // getMusicEmbeddingStats
    // ========================================================================

    describe('getMusicEmbeddingStats', () => {
        it('returns track quality metrics', async () => {
            await seedTrack();
            await seedTrack({ withEmbedding: true });

            const stats = await getMusicEmbeddingStats(sql);
            expect(stats.quality).toBeInstanceOf(Array);
            expect(stats.quality.length).toBe(1);
            const q = stats.quality[0];
            expect(Number(q.total_tracks)).toBeGreaterThanOrEqual(2);
        });

        it('returns recent tracks', async () => {
            await seedTrack();

            const stats = await getMusicEmbeddingStats(sql);
            expect(stats.recentTracks).toBeInstanceOf(Array);
        });

        it('returns sample tracks', async () => {
            await seedTrack();

            const stats = await getMusicEmbeddingStats(sql);
            expect(stats.sample).toBeInstanceOf(Array);
        });
    });
});
