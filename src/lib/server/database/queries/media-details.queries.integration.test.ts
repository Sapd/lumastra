// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Details Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    insertTestExternalIds,
    createTestExternalIds,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getMediaDetailByUuid,
    getMediaDetailByCompositeKey,
    getCachedListItemByCompositeKey,
} from './media-details.queries.js';

describe('Media Details Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'cached_list_items', 'cached_lists']);
    });

    async function insertProviderMetadata(
        mediaId: string,
        metadata: postgres.JSONValue,
    ): Promise<void> {
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
            VALUES (${mediaId}::uuid, 'tmdb', ${sql.json(metadata)}, NOW(), NOW())
        `;
    }

    // ========================================================================
    // getMediaDetailByUuid
    // ========================================================================

    describe('getMediaDetailByUuid', () => {
        it('returns detail row for active media', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, {
                overview: 'Test overview',
                original_language: 'ja',
                imdb_rating: 7.5,
                runtime_minutes: 120,
            });

            const row = await getMediaDetailByUuid(sql, item.id);
            expect(row).not.toBeNull();
            expect(row!.media_id).toBe(item.id);
            expect(row!.title).toBe(item.title);
            expect(row!.overview).toBe('Test overview');
            expect(row!.original_language).toBe('ja');
        });

        it('reads the TMDB score from vote_average, not from the never-written tmdb_rating key', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, {
                // `tmdb_rating` is present here ONLY as a decoy: nothing in the
                // real pipeline writes it, and reading it left tmdb_rating
                // permanently null for every title in the library.
                tmdb_rating: 9.9,
                vote_average: 6.8,
                vote_count: 1234,
            });

            const row = await getMediaDetailByUuid(sql, item.id);
            expect(row!.tmdb_rating).toBe(6.8);
            expect(row!.vote_count).toBe(1234);
        });

        it('yields a null tmdb_rating for a non-numeric vote_average instead of failing the query', async () => {
            // vote_average has no expression index enforcing numeric-ness (unlike
            // imdb_rating), so a bare cast here would raise 22P02 and 500 the
            // whole detail endpoint for that title.
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, { vote_average: 'N/A' });

            const row = await getMediaDetailByUuid(sql, item.id);
            expect(row!.tmdb_rating).toBeNull();
        });

        it('returns structured cast from provider_metadata.cast', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, {
                overview: 'Cast test',
                actors: ['Keiran Vale', 'Laurence Fenwick'],
                cast: [
                    { name: 'Keiran Vale', character: 'Neo', person_id: '6384' },
                    { name: 'Laurence Fenwick', character: 'Morpheus', person_id: '2975' },
                ],
            });

            const row = await getMediaDetailByUuid(sql, item.id);
            expect(row).not.toBeNull();
            // Structured cast round-trips as parsed objects (not a flattened text[]).
            expect(row!.cast_structured).toEqual([
                { name: 'Keiran Vale', character: 'Neo', person_id: '6384' },
                { name: 'Laurence Fenwick', character: 'Morpheus', person_id: '2975' },
            ]);
            // The flat names array is still populated alongside it.
            expect(row!.actors).toEqual(['Keiran Vale', 'Laurence Fenwick']);
        });

        it('returns null cast_structured when provider_metadata has no cast array', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, { actors: ['Solo Name'] });

            const row = await getMediaDetailByUuid(sql, item.id);
            expect(row!.cast_structured).toBeNull();
        });

        it('returns null for non-existent uuid', async () => {
            const row = await getMediaDetailByUuid(sql, '00000000-0000-0000-0000-000000000000');
            expect(row).toBeNull();
        });

        it('returns null for merged/deleted status', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                status: 'merged',
            });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, { overview: 'x' });

            const row = await getMediaDetailByUuid(sql, item.id);
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getMediaDetailByCompositeKey
    // ========================================================================

    describe('getMediaDetailByCompositeKey', () => {
        it('finds media by provider + external_id + media_type', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, {
                    tmdbId: 999001,
                    mediaType: 'movie',
                }),
            );
            await insertProviderMetadata(item.id, { overview: 'Found' });

            const row = await getMediaDetailByCompositeKey(sql, {
                provider: 'tmdb',
                externalId: '999001',
                mediaType: 'movie',
            });
            expect(row).not.toBeNull();
            expect(row!.media_id).toBe(item.id);
        });

        it('returns null when composite key does not match', async () => {
            const row = await getMediaDetailByCompositeKey(sql, {
                provider: 'tmdb',
                externalId: '999999',
                mediaType: 'movie',
            });
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getCachedListItemByCompositeKey
    // ========================================================================

    describe('getCachedListItemByCompositeKey', () => {
        it('returns cached list item when present', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, {
                    tmdbId: 999002,
                    mediaType: 'movie',
                }),
            );
            await sql`
                INSERT INTO cached_lists (list_id, name, list_path)
                VALUES ('test', 'Test List', '/test')
            `;
            await sql`
                INSERT INTO cached_list_items (list_id, media_id, rank)
                VALUES ('test', ${item.id}::uuid, 1)
            `;
            await insertProviderMetadata(item.id, {
                overview: 'Cached',
                mdblist_score: 85,
            });

            const row = await getCachedListItemByCompositeKey(sql, {
                provider: 'tmdb',
                externalId: '999002',
                mediaType: 'movie',
            });
            expect(row).not.toBeNull();
            expect(row!.title).toBe(item.title);
            expect(row!.media_type).toBe('movie');
        });

        it('returns null when no cached_list_items row', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, {
                    tmdbId: 999003,
                    mediaType: 'movie',
                }),
            );

            const row = await getCachedListItemByCompositeKey(sql, {
                provider: 'tmdb',
                externalId: '999003',
                mediaType: 'movie',
            });
            expect(row).toBeNull();
        });
    });
});
