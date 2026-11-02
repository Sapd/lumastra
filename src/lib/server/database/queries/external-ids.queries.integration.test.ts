// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for External IDs Query Module
 *
 * Tests TMDB/Jellyfin/IMDB resolution, batch operations, and collision handling.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestTvShow,
    createTestMediaItem,
    insertTestMediaItem,
    insertTestExternalIds,
    createTestExternalIds,
} from '../../../../../tests/integration/fixtures/index.js';

// Import query functions to test
import {
    resolveFromTmdb,
    resolveFromJellyfin,
    resolveFromImdb,
    getTmdbId,
    getJellyfinId,
    getImdbId,
    existsByTmdb,
    existsByJellyfin,
    getAllExternalIds,
    getExternalIdRecords,
    batchResolveFromTmdb,
    batchResolveFromJellyfin,
    batchGetTmdbIds,
    buildTmdbKey,
    parseTmdbKey,
} from './external-ids.queries.js';

describe('External IDs Queries', () => {
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

    // ==========================================================================
    // Single ID Resolution
    // ==========================================================================

    describe('resolveFromTmdb', () => {
        it('resolves TMDB ID to internal UUID with correct media type', async () => {
            const { id, tmdbId } = await createAndInsertTestMovie(sql, {
                tmdbId: 550001,
            });

            const result = await resolveFromTmdb.get(sql, {
                tmdbId,
                mediaType: 'movie',
            });

            expect(result).toBe(id);
        });

        it('returns null for non-existent TMDB ID', async () => {
            const result = await resolveFromTmdb.get(sql, {
                tmdbId: 999999999,
                mediaType: 'movie',
            });

            expect(result).toBeNull();
        });

        it('handles TMDB ID collision (same ID, different media types)', async () => {
            // This is a critical test: TMDB ID 1429 is both a movie AND a TV show
            const collisionId = 991429;

            const movie = await createAndInsertTestMovie(sql, {
                title: 'Collision Movie',
                tmdbId: collisionId,
            });

            const tvShow = await createAndInsertTestTvShow(sql, {
                title: 'Collision TV',
                tmdbId: collisionId,
            });

            // Same TMDB ID should resolve to different UUIDs based on media_type
            const movieResult = await resolveFromTmdb.get(sql, {
                tmdbId: collisionId,
                mediaType: 'movie',
            });
            const tvResult = await resolveFromTmdb.get(sql, {
                tmdbId: collisionId,
                mediaType: 'tv',
            });

            expect(movieResult).toBe(movie.id);
            expect(tvResult).toBe(tvShow.id);
            expect(movieResult).not.toBe(tvResult);
        });

        it('returns null when media_type does not match', async () => {
            await createAndInsertTestMovie(sql, { tmdbId: 550002 });

            // Query with wrong media_type
            const result = await resolveFromTmdb.get(sql, {
                tmdbId: 550002,
                mediaType: 'tv',
            });

            expect(result).toBeNull();
        });
    });

    describe('resolveFromJellyfin', () => {
        it('resolves Jellyfin ID to internal UUID', async () => {
            const jellyfinId = 'test-jellyfin-uuid-001';
            const { id } = await createAndInsertTestMovie(sql, { jellyfinId });

            const result = await resolveFromJellyfin.get(sql, { jellyfinId });

            expect(result).toBe(id);
        });

        it('handles UUID and non-UUID Jellyfin IDs', async () => {
            const jellyfinId1 = '550e8400-e29b-41d4-a716-446655440000';
            const jellyfinId2 = 'abc123nonuuid';

            const { id: id1 } = await createAndInsertTestMovie(sql, {
                jellyfinId: jellyfinId1,
                tmdbId: 550010,
            });
            const { id: id2 } = await createAndInsertTestMovie(sql, {
                jellyfinId: jellyfinId2,
                tmdbId: 550011,
            });

            const result1 = await resolveFromJellyfin.get(sql, {
                jellyfinId: jellyfinId1,
            });
            const result2 = await resolveFromJellyfin.get(sql, {
                jellyfinId: jellyfinId2,
            });

            expect(result1).toBe(id1);
            expect(result2).toBe(id2);
        });
    });

    describe('resolveFromImdb', () => {
        it('resolves IMDB ID to internal UUID with mediaType filter', async () => {
            const { id } = await createAndInsertTestMovie(sql, {
                imdbId: 'tt9990001',
            });

            const result = await resolveFromImdb.get(sql, {
                imdbId: 'tt9990001',
                mediaType: 'movie',
            });

            expect(result).toBe(id);
        });

        it('resolves IMDB ID to internal UUID without mediaType filter (backward compat)', async () => {
            const { id } = await createAndInsertTestMovie(sql, {
                imdbId: 'tt9990002',
            });

            const result = await resolveFromImdb.get(sql, {
                imdbId: 'tt9990002',
            });

            expect(result).toBe(id);
        });
    });

    // ==========================================================================
    // Reverse Resolution (UUID to external ID)
    // ==========================================================================

    describe('getTmdbId', () => {
        it('returns TMDB ID for internal UUID', async () => {
            const { id, tmdbId } = await createAndInsertTestMovie(sql, {
                tmdbId: 550003,
            });

            const result = await getTmdbId.get(sql, { mediaId: id });

            expect(result).toBe(tmdbId);
        });

        it('returns null for UUID without TMDB ID', async () => {
            // Create media item with only Jellyfin ID (no TMDB)
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const externalIds = createTestExternalIds(item.id, {
                jellyfinId: 'jf-only-id',
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            const result = await getTmdbId.get(sql, { mediaId: item.id });

            expect(result).toBeNull();
        });
    });

    describe('getJellyfinId', () => {
        it('returns Jellyfin ID for internal UUID', async () => {
            const jellyfinId = 'test-jf-reverse-001';
            const { id } = await createAndInsertTestMovie(sql, { jellyfinId });

            const result = await getJellyfinId.get(sql, { mediaId: id });

            // Stored as dashless after normalization
            expect(result).toBe('testjfreverse001');
        });
    });

    describe('getImdbId', () => {
        it('returns IMDB ID for internal UUID', async () => {
            const imdbId = 'tt9990010';
            const { id } = await createAndInsertTestMovie(sql, { imdbId });

            const result = await getImdbId.get(sql, { mediaId: id });

            expect(result).toBe(imdbId);
        });
    });

    // ==========================================================================
    // Existence Checks
    // ==========================================================================

    describe('existsByTmdb', () => {
        it('returns true for existing TMDB ID with correct media type', async () => {
            const { tmdbId } = await createAndInsertTestMovie(sql, {
                tmdbId: 550004,
            });

            const exists = await existsByTmdb.check(sql, {
                tmdbId,
                mediaType: 'movie',
            });

            expect(exists).toBe(true);
        });

        it('returns false for non-existent TMDB ID', async () => {
            const exists = await existsByTmdb.check(sql, {
                tmdbId: 999999998,
                mediaType: 'movie',
            });

            expect(exists).toBe(false);
        });

        it('returns false for wrong media type', async () => {
            await createAndInsertTestMovie(sql, { tmdbId: 550005 });

            const exists = await existsByTmdb.check(sql, {
                tmdbId: 550005,
                mediaType: 'tv',
            });

            expect(exists).toBe(false);
        });
    });

    describe('existsByJellyfin', () => {
        it('returns true for existing Jellyfin ID', async () => {
            const jellyfinId = 'test-exists-jf-001';
            await createAndInsertTestMovie(sql, { jellyfinId });

            const exists = await existsByJellyfin.check(sql, { jellyfinId });

            expect(exists).toBe(true);
        });

        it('returns false for non-existent Jellyfin ID', async () => {
            const exists = await existsByJellyfin.check(sql, {
                jellyfinId: 'non-existent-jellyfin-id',
            });

            expect(exists).toBe(false);
        });
    });

    // ==========================================================================
    // Multi-ID Queries
    // ==========================================================================

    describe('getAllExternalIds', () => {
        it('returns all external IDs for a media item', async () => {
            const { id } = await createAndInsertTestMovie(sql, {
                tmdbId: 550006,
                imdbId: 'tt9990006',
                jellyfinId: 'jf-all-ids-001',
            });

            const result = await getAllExternalIds.one(sql, { mediaId: id });

            expect(result).not.toBeNull();
            expect(result?.internal_id).toBe(id);
            expect(result?.tmdb_id).toBe(550006);
            expect(result?.imdb_id).toBe('tt9990006');
            // Stored as dashless after normalization
            expect(result?.jellyfin_id).toBe('jfallids001');
        });

        it('returns null for missing provider IDs', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Only add TMDB ID
            const externalIds = createTestExternalIds(item.id, {
                tmdbId: 550007,
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            const result = await getAllExternalIds.one(sql, {
                mediaId: item.id,
            });

            expect(result?.tmdb_id).toBe(550007);
            expect(result?.imdb_id).toBeNull();
            expect(result?.jellyfin_id).toBeNull();
        });
    });

    describe('getExternalIdRecords', () => {
        it('returns all external ID records for a media item', async () => {
            const { id } = await createAndInsertTestMovie(sql, {
                tmdbId: 550008,
                imdbId: 'tt9990008',
                jellyfinId: 'jf-records-001',
            });

            const records = await getExternalIdRecords.all(sql, {
                mediaId: id,
            });

            expect(records.length).toBe(3);
            expect(records.map((r) => r.provider).sort()).toEqual(['imdb', 'jellyfin', 'tmdb']);
        });
    });

    // ==========================================================================
    // Batch Operations
    // ==========================================================================

    describe('batchResolveFromTmdb', () => {
        it('resolves multiple TMDB IDs in single query', async () => {
            const movie1 = await createAndInsertTestMovie(sql, {
                tmdbId: 550100,
            });
            const movie2 = await createAndInsertTestMovie(sql, {
                tmdbId: 550101,
            });
            const tvShow = await createAndInsertTestTvShow(sql, {
                tmdbId: 550102,
            });

            const items = [
                { tmdbId: 550100, mediaType: 'movie' as const },
                { tmdbId: 550101, mediaType: 'movie' as const },
                { tmdbId: 550102, mediaType: 'tv' as const },
            ];

            const result = await batchResolveFromTmdb(sql, items);

            expect(result.size).toBe(3);
            expect(result.get('550100:movie')).toBe(movie1.id);
            expect(result.get('550101:movie')).toBe(movie2.id);
            expect(result.get('550102:tv')).toBe(tvShow.id);
        });

        it('returns empty map for empty input', async () => {
            const result = await batchResolveFromTmdb(sql, []);

            expect(result.size).toBe(0);
        });

        it('handles partial matches', async () => {
            await createAndInsertTestMovie(sql, { tmdbId: 550200 });

            const items = [
                { tmdbId: 550200, mediaType: 'movie' as const },
                { tmdbId: 550999, mediaType: 'movie' as const }, // Non-existent
            ];

            const result = await batchResolveFromTmdb(sql, items);

            expect(result.size).toBe(1);
            expect(result.has('550200:movie')).toBe(true);
            expect(result.has('550999:movie')).toBe(false);
        });

        it('handles large batch efficiently', async () => {
            // Create 50 movies
            const movies: Array<{ id: string; tmdbId: number }> = [];
            for (let i = 0; i < 50; i++) {
                const movie = await createAndInsertTestMovie(sql, {
                    tmdbId: 560000 + i,
                });
                movies.push(movie);
            }

            const items = movies.map((m) => ({
                tmdbId: m.tmdbId,
                mediaType: 'movie' as const,
            }));

            const result = await batchResolveFromTmdb(sql, items);

            expect(result.size).toBe(50);
            movies.forEach((m) => {
                expect(result.get(`${m.tmdbId}:movie`)).toBe(m.id);
            });
        });
    });

    describe('batchResolveFromJellyfin', () => {
        it('resolves multiple Jellyfin IDs in single query', async () => {
            // Use dashless IDs so normalizeJellyfinId returns the same value,
            // preventing the dual-key insertion that would inflate result.size.
            const jfIds = ['jfbatch001', 'jfbatch002', 'jfbatch003'];
            const items: Array<{ id: string; jellyfinId: string }> = [];

            for (let i = 0; i < jfIds.length; i++) {
                const { id } = await createAndInsertTestMovie(sql, {
                    jellyfinId: jfIds[i],
                    tmdbId: 570000 + i,
                });
                items.push({ id, jellyfinId: jfIds[i] });
            }

            const result = await batchResolveFromJellyfin(sql, jfIds);

            expect(result.size).toBe(3);
            items.forEach((item) => {
                expect(result.get(item.jellyfinId)).toBe(item.id);
            });
        });
    });

    describe('batchGetTmdbIds', () => {
        it('gets TMDB IDs for multiple internal UUIDs', async () => {
            const movie1 = await createAndInsertTestMovie(sql, {
                tmdbId: 580001,
            });
            const movie2 = await createAndInsertTestMovie(sql, {
                tmdbId: 580002,
            });
            const movie3 = await createAndInsertTestMovie(sql, {
                tmdbId: 580003,
            });

            const mediaIds = [movie1.id, movie2.id, movie3.id];
            const result = await batchGetTmdbIds(sql, mediaIds);

            expect(result.size).toBe(3);
            expect(result.get(movie1.id)).toBe(580001);
            expect(result.get(movie2.id)).toBe(580002);
            expect(result.get(movie3.id)).toBe(580003);
        });
    });

    // ==========================================================================
    // Utility Functions
    // ==========================================================================

    describe('buildTmdbKey', () => {
        it('builds composite key string', () => {
            const key = buildTmdbKey(550, 'movie');
            expect(key).toBe('550:movie');
        });
    });

    describe('parseTmdbKey', () => {
        it('parses valid composite key', () => {
            const result = parseTmdbKey('550:movie');

            expect(result).not.toBeNull();
            expect(result?.tmdbId).toBe(550);
            expect(result?.mediaType).toBe('movie');
        });

        it('parses TV media type', () => {
            const result = parseTmdbKey('1399:tv');

            expect(result?.mediaType).toBe('tv');
        });

        it('returns null for invalid keys', () => {
            expect(parseTmdbKey('invalid')).toBeNull();
            expect(parseTmdbKey('abc:movie')).toBeNull();
            expect(parseTmdbKey('550:invalid')).toBeNull();
            expect(parseTmdbKey('')).toBeNull();
        });
    });
});
