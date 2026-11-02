// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for User Pinned Genres Query Module
 *
 * Tests CRUD for per-user pinned genre carousels on /music.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getPinnedGenres,
    getPinnedGenreNames,
    isGenrePinned,
    pinGenre,
    unpinGenre,
} from './user-pinned-genres.queries.js';

describe('User Pinned Genres Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['user_pinned_genres']);
    });

    // ========================================================================
    // pinGenre
    // ========================================================================

    describe('pinGenre', () => {
        it('pins a genre with default position (append)', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const result = await pinGenre.execute(sql, {
                userId,
                genre: 'Rock',
            });

            expect(result.length).toBe(1);
            expect(result[0].genre).toBe('Rock');
            expect(result[0].position).toBe(0);
        });

        it('appends genres with incrementing positions', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const first = await pinGenre.execute(sql, {
                userId,
                genre: 'Rock',
            });
            const second = await pinGenre.execute(sql, {
                userId,
                genre: 'Jazz',
            });

            expect(first[0].position).toBe(0);
            expect(second[0].position).toBe(1);
        });

        it('updates pinned_at on conflict without changing position', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const first = await pinGenre.execute(sql, {
                userId,
                genre: 'Rock',
            });
            const originalPinnedAt = first[0].pinned_at;

            // Slight delay so timestamps differ
            await new Promise((r) => setTimeout(r, 10));
            const second = await pinGenre.execute(sql, {
                userId,
                genre: 'Rock',
            });

            expect(second.length).toBe(1);
            expect(second[0].position).toBe(first[0].position);
            expect(second[0].pinned_at).not.toEqual(originalPinnedAt);
        });
    });

    // ========================================================================
    // getPinnedGenres
    // ========================================================================

    describe('getPinnedGenres', () => {
        it('returns pinned genres ordered by position ASC', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await pinGenre.execute(sql, { userId, genre: 'Jazz' });
            await pinGenre.execute(sql, { userId, genre: 'Rock' });
            await pinGenre.execute(sql, { userId, genre: 'Classical' });

            const result = await getPinnedGenres.all(sql, { userId });

            expect(result.length).toBe(3);
            expect(result[0].genre).toBe('Jazz');
            expect(result[1].genre).toBe('Rock');
            expect(result[2].genre).toBe('Classical');
        });

        it('returns empty array when user has no pinned genres', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const result = await getPinnedGenres.all(sql, { userId });
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // getPinnedGenreNames
    // ========================================================================

    describe('getPinnedGenreNames', () => {
        it('returns only genre names in order', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await pinGenre.execute(sql, { userId, genre: 'Blues' });
            await pinGenre.execute(sql, { userId, genre: 'Funk' });

            const result = await getPinnedGenreNames.all(sql, { userId });

            expect(result.length).toBe(2);
            expect(result[0].genre).toBe('Blues');
            expect(result[1].genre).toBe('Funk');
        });
    });

    // ========================================================================
    // isGenrePinned
    // ========================================================================

    describe('isGenrePinned', () => {
        it('returns true when genre is pinned', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            await pinGenre.execute(sql, { userId, genre: 'Metal' });

            const result = await isGenrePinned.check(sql, {
                userId,
                genre: 'Metal',
            });
            expect(result).toBe(true);
        });

        it('returns false when genre is not pinned', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const result = await isGenrePinned.check(sql, {
                userId,
                genre: 'Opera',
            });
            expect(result).toBe(false);
        });
    });

    // ========================================================================
    // unpinGenre
    // ========================================================================

    describe('unpinGenre', () => {
        it('removes a pinned genre', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            await pinGenre.execute(sql, { userId, genre: 'Pop' });

            const result = await unpinGenre.execute(sql, {
                userId,
                genre: 'Pop',
            });
            expect(result.length).toBe(1);

            const exists = await isGenrePinned.check(sql, {
                userId,
                genre: 'Pop',
            });
            expect(exists).toBe(false);
        });

        it('returns empty array when genre was not pinned', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const result = await unpinGenre.execute(sql, {
                userId,
                genre: 'NonExistent',
            });
            expect(result.length).toBe(0);
        });
    });
});
