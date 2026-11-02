// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the batched query helpers added for fix-plan Task 5
 * (C5 — playlist bulk-add): `resolveMediaIdsBatch` (lookup-only, never
 * creates a stub) and `bulkInsertPlaylistItems` (one INSERT for many rows).
 *
 * Covers the two properties the fix-plan brief calls out specifically:
 *  - `media_items` row count is UNCHANGED after resolving a batch of unknown
 *    external ids (the whole point of replacing `resolveOrCreateMediaId`).
 *  - known ids are inserted with correct, contiguous positions in ONE
 *    statement, and `ON CONFLICT DO NOTHING` correctly skips a pre-existing
 *    item without erroring.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    createAndInsertTestMovie,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    createPlaylist,
    resolveMediaIdsBatch,
    bulkInsertPlaylistItems,
} from './playlists.queries.js';

describe('Playlist bulk-add batch helpers (integration)', () => {
    let sql: postgres.Sql;
    const owner = generateTestUserId();

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ${owner}::uuid)`;
        await sql`DELETE FROM playlists WHERE user_id = ${owner}::uuid`;
        await ensureTestUser(sql, owner);
    });

    async function countMediaItems(): Promise<number> {
        const rows = await sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM media_items`;
        return Number(rows[0].count);
    }

    describe('resolveMediaIdsBatch', () => {
        it('resolves a known external id and leaves an unknown one absent from the map — never creates a stub', async () => {
            const movie = await createAndInsertTestMovie(sql, {});
            const before = await countMediaItems();

            const map = await resolveMediaIdsBatch(sql, [
                { provider: 'tmdb', externalId: String(movie.tmdbId), mediaType: 'movie' },
                { provider: 'tmdb', externalId: '9999999999', mediaType: 'movie' },
            ]);

            expect(map.get(`tmdb:${movie.tmdbId}:movie`)).toBe(movie.id);
            expect(map.has('tmdb:9999999999:movie')).toBe(false);

            // The whole point of the fix: a miss does not create a media_items row.
            const after = await countMediaItems();
            expect(after).toBe(before);
        });

        it('media_items row count is unchanged after resolving a batch that is ENTIRELY unknown ids', async () => {
            const before = await countMediaItems();

            const keys = Array.from({ length: 25 }, (_, i) => ({
                provider: 'tmdb',
                externalId: String(8000000 + i),
                mediaType: 'movie',
            }));
            const map = await resolveMediaIdsBatch(sql, keys);

            expect(map.size).toBe(0);
            const after = await countMediaItems();
            expect(after).toBe(before);
        });
    });

    describe('bulkInsertPlaylistItems', () => {
        it('inserts multiple known ids in ONE statement with correct, contiguous positions', async () => {
            const movieA = await createAndInsertTestMovie(sql, {});
            const movieB = await createAndInsertTestMovie(sql, {});
            const playlist = await createPlaylist(
                sql,
                owner,
                'Bulk Test',
                null,
                'private',
                'video',
            );

            const rows = await bulkInsertPlaylistItems(sql, playlist.id, [
                {
                    mediaId: movieA.id,
                    seasonNumber: null,
                    episodeNumber: null,
                    title: 'Movie A',
                    seriesName: null,
                    overview: null,
                    posterPath: null,
                },
                {
                    mediaId: movieB.id,
                    seasonNumber: null,
                    episodeNumber: null,
                    title: 'Movie B',
                    seriesName: null,
                    overview: null,
                    posterPath: null,
                },
            ]);

            expect(rows).toHaveLength(2);
            const byMediaId = new Map(rows.map((r) => [r.media_id, r]));
            expect(byMediaId.get(movieA.id)?.position).toBe(0);
            expect(byMediaId.get(movieB.id)?.position).toBe(1);
        });

        it('ON CONFLICT DO NOTHING skips a pre-existing item without erroring, and only returns the newly inserted row', async () => {
            const movieA = await createAndInsertTestMovie(sql, {});
            const movieB = await createAndInsertTestMovie(sql, {});
            const playlist = await createPlaylist(
                sql,
                owner,
                'Bulk Conflict Test',
                null,
                'private',
                'video',
            );

            // Pre-insert movieA so the batched insert below must skip it.
            await bulkInsertPlaylistItems(sql, playlist.id, [
                {
                    mediaId: movieA.id,
                    seasonNumber: null,
                    episodeNumber: null,
                    title: 'Movie A (already there)',
                    seriesName: null,
                    overview: null,
                    posterPath: null,
                },
            ]);

            const rows = await bulkInsertPlaylistItems(sql, playlist.id, [
                {
                    mediaId: movieA.id,
                    seasonNumber: null,
                    episodeNumber: null,
                    title: 'Movie A (duplicate attempt)',
                    seriesName: null,
                    overview: null,
                    posterPath: null,
                },
                {
                    mediaId: movieB.id,
                    seasonNumber: null,
                    episodeNumber: null,
                    title: 'Movie B (new)',
                    seriesName: null,
                    overview: null,
                    posterPath: null,
                },
            ]);

            expect(rows).toHaveLength(1);
            expect(rows[0].media_id).toBe(movieB.id);

            const finalCount = await sql<{ count: string }[]>`
                SELECT COUNT(*)::text AS count FROM playlist_items WHERE playlist_id = ${playlist.id}
            `;
            expect(Number(finalCount[0].count)).toBe(2);
        });
    });
});
