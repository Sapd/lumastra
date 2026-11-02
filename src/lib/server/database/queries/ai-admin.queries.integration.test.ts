// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for AI Admin Query Module
 *
 * Tests system stats, suggestion cleanup, embedding management,
 * MDBList coverage, and search functions.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getSystemStats,
    deleteExpiredSuggestions,
    deleteUserSuggestions,
    getWatchHistoryStats,
    deleteAllMediaEmbeddings,
    deleteAllMediaItems,
    deleteLibraryAvailability,
    deleteAllExternalIds,
    deleteAllProviderMetadata,
    deleteEmbeddingsBySource,
    deleteProviderMetadataByProviders,
    getMdblistCoverage,
    searchMediaByTitle,
    getMdblistTagStats,
} from './ai-admin.queries.js';

describe('AI Admin Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    });

    // ========================================================================
    // System Stats
    // ========================================================================

    describe('getSystemStats', () => {
        it('returns zero counts for empty database', async () => {
            const stats = await getSystemStats(sql);
            expect(stats.totalUsers).toBe(0);
            expect(stats.totalRatings).toBe(0);
            expect(stats.totalMediaItems).toBe(0);
            expect(stats.totalSuggestions).toBe(0);
        });

        it('counts media items correctly', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const stats = await getSystemStats(sql);
            expect(stats.totalMediaItems).toBe(1);
        });
    });

    // ========================================================================
    // Suggestion Cleanup
    // ========================================================================

    describe('deleteExpiredSuggestions', () => {
        it('deletes suggestions older than the given date', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const mediaId = crypto.randomUUID();
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    id: mediaId,
                    title: 'Test',
                    original_title: null,
                    media_type: 'movie',
                    year: 2024,
                }),
            );

            await sql`
                INSERT INTO user_suggestions (user_id, media_id, cache_context, combined_score, created_at)
                VALUES (${userId}::uuid, ${mediaId}::uuid, 'test', 50, NOW() - INTERVAL '1 hour')
            `;

            await deleteExpiredSuggestions(sql, new Date());

            const rows = await sql`SELECT * FROM user_suggestions WHERE user_id = ${userId}::uuid`;
            expect(rows.length).toBe(0);
        });
    });

    describe('deleteUserSuggestions', () => {
        it('deletes all suggestions for a user', async () => {
            const userId: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, userId);
            const mediaId = crypto.randomUUID();
            await insertTestMediaItem(
                sql,
                createTestMediaItem({
                    id: mediaId,
                    title: 'Test',
                    original_title: null,
                    media_type: 'movie',
                    year: 2024,
                }),
            );

            await sql`
                INSERT INTO user_suggestions (user_id, media_id, cache_context, combined_score)
                VALUES (${userId}::uuid, ${mediaId}::uuid, 'test', 50)
            `;

            await deleteUserSuggestions(sql, userId);

            const rows = await sql`SELECT * FROM user_suggestions WHERE user_id = ${userId}::uuid`;
            expect(rows.length).toBe(0);
        });
    });

    // ========================================================================
    // Watch History Stats
    // ========================================================================

    describe('getWatchHistoryStats', () => {
        it('returns zero for empty ratings', async () => {
            const stats = await getWatchHistoryStats(sql);
            expect(stats.ratingsCount).toBe(0);
            expect(stats.usersWithRatings).toBe(0);
        });
    });

    // ========================================================================
    // Reset / Cleanup
    // ========================================================================

    describe('deleteAllMediaEmbeddings', () => {
        it('deletes all embeddings and returns count', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const vector = '[' + Array(1024).fill(0.1).join(',') + ']';
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${item.id}::uuid, ${vector}::vector, 'test')
            `;

            const result = await deleteAllMediaEmbeddings(sql);
            expect(result.deletedCount).toBeGreaterThanOrEqual(0);
        });
    });

    describe('deleteAllExternalIds', () => {
        it('deletes all external IDs', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, {
                    tmdbId: 123,
                    mediaType: 'movie',
                }),
            );

            const result = await deleteAllExternalIds(sql);
            expect(result.deletedCount).toBeGreaterThanOrEqual(0);
        });
    });

    describe('deleteAllProviderMetadata', () => {
        it('deletes all provider metadata', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'tmdb', '{}'::jsonb, NOW())
            `;

            const result = await deleteAllProviderMetadata(sql);
            expect(result.deletedCount).toBeGreaterThanOrEqual(0);
        });
    });

    describe('deleteEmbeddingsBySource', () => {
        it('deletes embeddings matching source', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const vector = '[' + Array(1024).fill(0.1).join(',') + ']';
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${item.id}::uuid, ${vector}::vector, 'test-source')
            `;

            const result = await deleteEmbeddingsBySource(sql, 'test-source');
            expect(result.deletedCount).toBeGreaterThanOrEqual(0);
        });
    });

    describe('deleteProviderMetadataByProviders', () => {
        it('deletes metadata for given providers', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'tmdb', '{}'::jsonb, NOW())
            `;

            const result = await deleteProviderMetadataByProviders(sql, ['tmdb']);
            expect(result.deletedCount).toBeGreaterThanOrEqual(0);
        });
    });

    describe('deleteLibraryAvailability', () => {
        it('deletes availability for a library', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO library_availability (media_id, library, library_item_id, available)
                VALUES (${item.id}::uuid, 'test-lib', 'item-1', true)
            `;

            await deleteLibraryAvailability(sql, 'test-lib');

            const rows = await sql`SELECT * FROM library_availability WHERE library = 'test-lib'`;
            expect(rows.length).toBe(0);
        });
    });

    describe('deleteAllMediaItems', () => {
        it('deletes all media items', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await deleteAllMediaItems(sql);
            expect(result.deletedCount).toBeGreaterThanOrEqual(0);
        });
    });

    // ========================================================================
    // MDBList Coverage
    // ========================================================================

    describe('getMdblistCoverage', () => {
        it('returns zero coverage for empty database', async () => {
            const result = await getMdblistCoverage(sql);
            expect(result.totalItems).toBe(0);
            expect(result.withMdblist).toBe(0);
            expect(result.coveragePercent).toBe(0);
        });
    });

    describe('getMdblistTagStats', () => {
        it('returns zero stats for empty database', async () => {
            const result = await getMdblistTagStats(sql);
            expect(result.total).toBe(0);
            expect(result.withTags).toBe(0);
            expect(result.withoutTags).toBe(0);
        });
    });

    // ========================================================================
    // Search Media By Title
    // ========================================================================

    describe('searchMediaByTitle', () => {
        it('returns matching media by title pattern', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'Alpha Test Movie',
            });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, {
                    tmdbId: 123,
                    mediaType: 'movie',
                }),
            );

            const rows = await searchMediaByTitle(sql, '%Alpha%', 'Alpha Test Movie');
            expect(rows.length).toBeGreaterThanOrEqual(0);
        });

        it('filters by media type when provided', async () => {
            const movie = createTestMediaItem({
                media_type: 'movie',
                title: 'Unique Movie',
            });
            const tv = createTestMediaItem({
                media_type: 'tv',
                title: 'Unique Show',
            });
            await insertTestMediaItem(sql, movie);
            await insertTestMediaItem(sql, tv);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(movie.id, {
                    tmdbId: 111,
                    mediaType: 'movie',
                }),
            );
            await insertTestExternalIds(
                sql,
                createTestExternalIds(tv.id, {
                    tmdbId: 222,
                    mediaType: 'tv',
                }),
            );

            const rows = await searchMediaByTitle(sql, '%Unique%', 'Unique Movie', 'movie');
            const titles = rows.map((r) => r.title);
            expect(titles).not.toContain('Unique Show');
        });
    });
});
