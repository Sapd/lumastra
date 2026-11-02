// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Type Cache Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import { getMediaType, isMusicMediaType, clearMediaTypeCache } from './media-type-cache.queries.js';

describe('Media Type Cache Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        clearMediaTypeCache();
    });

    // ========================================================================
    // getMediaType
    // ========================================================================

    describe('getMediaType', () => {
        it('returns media_type for an existing item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getMediaType(sql, item.id);
            expect(result).toBe('movie');
        });

        it('returns null for non-existent media', async () => {
            const result = await getMediaType(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });

        it('caches result and returns from cache on second call', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            const first = await getMediaType(sql, item.id);
            expect(first).toBe('tv');

            // Update in DB behind the cache's back
            await sql`UPDATE media_items SET media_type = 'movie' WHERE id = ${item.id}::uuid`;

            const second = await getMediaType(sql, item.id);
            // Should still be 'tv' because of cache
            expect(second).toBe('tv');
        });
    });

    // ========================================================================
    // isMusicMediaType
    // ========================================================================

    describe('isMusicMediaType', () => {
        it('returns true for track', () => {
            expect(isMusicMediaType('track')).toBe(true);
        });

        it('returns true for audio', () => {
            expect(isMusicMediaType('audio')).toBe(true);
        });

        it('returns true for music', () => {
            expect(isMusicMediaType('music')).toBe(true);
        });

        it('returns false for movie', () => {
            expect(isMusicMediaType('movie')).toBe(false);
        });

        it('returns false for null', () => {
            expect(isMusicMediaType(null)).toBe(false);
        });
    });

    // ========================================================================
    // clearMediaTypeCache
    // ========================================================================

    describe('clearMediaTypeCache', () => {
        it('clears the in-memory cache', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            await getMediaType(sql, item.id);
            await sql`UPDATE media_items SET media_type = 'movie' WHERE id = ${item.id}::uuid`;

            clearMediaTypeCache();
            const result = await getMediaType(sql, item.id);
            expect(result).toBe('movie');
        });
    });
});
