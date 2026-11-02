// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for System Status Query Module
 *
 * Tests checkRequiredTables, getMediaStats, getUserStats,
 * getActiveSuggestionCount, and getSystemStatusStats.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    checkRequiredTables,
    getMediaStats,
    getUserStats,
    getActiveSuggestionCount,
    getSystemStatusStats,
} from './system-status.queries.js';

describe('System Status Queries', () => {
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
    // checkRequiredTables
    // ========================================================================

    describe('checkRequiredTables', () => {
        it('returns a Set containing existing tables', async () => {
            const tables = await checkRequiredTables(sql);

            expect(tables).toBeInstanceOf(Set);
            expect(tables.has('media_items')).toBe(true);
            expect(tables.has('media_embeddings')).toBe(true);
        });
    });

    // ========================================================================
    // getMediaStats
    // ========================================================================

    describe('getMediaStats', () => {
        it('returns zero stats when no media exists', async () => {
            const stats = await getMediaStats(sql);

            expect(stats.totalMediaItems).toBe(0);
            expect(stats.libraryEmbeddings).toBe(0);
            expect(stats.primaryProviderEmbeddings).toBe(0);
            expect(stats.bothEmbeddings).toBe(0);
        });

        it('counts active media items correctly', async () => {
            await createAndInsertTestMovie(sql, { tmdbId: 990101 });
            await createAndInsertTestMovie(sql, { tmdbId: 990102 });

            const stats = await getMediaStats(sql);

            expect(stats.totalMediaItems).toBe(2);
        });

        it('ignores non-active media items', async () => {
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${crypto.randomUUID()}::uuid, 'Deleted Movie', 'movie', 'deleted')
            `;

            const stats = await getMediaStats(sql);

            expect(stats.totalMediaItems).toBe(0);
        });
    });

    // ========================================================================
    // getUserStats
    // ========================================================================

    describe('getUserStats', () => {
        // getUserStats counts *registered accounts* (rows in `users`), no longer
        // "users with an embedding". The shared beforeEach truncate list does NOT
        // include `users`, so accounts leak between tests — clear it here for a
        // deterministic count. DELETE cascades to user_profiles etc.
        beforeEach(async () => {
            await sql`DELETE FROM users`;
        });

        it('returns zero when no registered accounts exist', async () => {
            const count = await getUserStats(sql);
            expect(count).toBe(0);
        });

        it('counts a single registered account', async () => {
            await ensureTestUser(sql, crypto.randomUUID());

            const count = await getUserStats(sql);
            expect(count).toBe(1);
        });

        it('counts multiple registered accounts', async () => {
            await ensureTestUser(sql, crypto.randomUUID());
            await ensureTestUser(sql, crypto.randomUUID());

            const count = await getUserStats(sql);
            expect(count).toBe(2);
        });

        it('excludes soft-deleted and disabled accounts', async () => {
            const active = crypto.randomUUID();
            const deleted = crypto.randomUUID();
            const disabled = crypto.randomUUID();
            await ensureTestUser(sql, active);
            await ensureTestUser(sql, deleted);
            await ensureTestUser(sql, disabled);
            await sql`UPDATE users SET deleted_at = now() WHERE id = ${deleted}::uuid`;
            await sql`UPDATE users SET disabled_at = now() WHERE id = ${disabled}::uuid`;

            const count = await getUserStats(sql);
            expect(count).toBe(1);
        });
    });

    // ========================================================================
    // getActiveSuggestionCount
    // ========================================================================

    describe('getActiveSuggestionCount', () => {
        it('returns zero when no suggestions exist', async () => {
            const count = await getActiveSuggestionCount(sql);
            expect(count).toBe(0);
        });

        it('counts only non-expired suggestions', async () => {
            const userId = crypto.randomUUID();
            await ensureTestUser(sql, userId);

            const { id: movieId1 } = await createAndInsertTestMovie(sql, {
                tmdbId: 990201,
            });
            const { id: movieId2 } = await createAndInsertTestMovie(sql, {
                tmdbId: 990202,
            });

            // Expired suggestion
            await sql`
                INSERT INTO user_suggestions (user_id, media_id, expires_at)
                VALUES (
                    ${userId}::uuid,
                    ${movieId1}::uuid,
                    NOW() - INTERVAL '1 day'
                )
            `;

            // Active suggestion
            await sql`
                INSERT INTO user_suggestions (user_id, media_id, expires_at)
                VALUES (
                    ${userId}::uuid,
                    ${movieId2}::uuid,
                    NOW() + INTERVAL '1 day'
                )
            `;

            const count = await getActiveSuggestionCount(sql);
            expect(count).toBe(1);
        });
    });

    // ========================================================================
    // getSystemStatusStats
    // ========================================================================

    describe('getSystemStatusStats', () => {
        it('returns combined stats', async () => {
            const stats = await getSystemStatusStats(sql);

            expect(stats).toHaveProperty('totalMediaItems');
            expect(stats).toHaveProperty('libraryEmbeddings');
            expect(stats).toHaveProperty('primaryProviderEmbeddings');
            expect(stats).toHaveProperty('bothEmbeddings');
            expect(stats).toHaveProperty('totalUsers');
            expect(stats).toHaveProperty('totalSuggestions');
        });
    });
});
