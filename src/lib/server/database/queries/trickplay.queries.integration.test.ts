// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Trickplay Query Module
 *
 * Tests media item lookup, video path resolution, and episode enumeration
 * for trickplay generation.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createAndInsertTestMovie,
    createAndInsertTestSeries,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getMediaItemForTrickplay,
    findVideoPath,
    findEpisodesForSeries,
    findEpisodesForSeason,
} from './trickplay.queries.js';

describe('Trickplay Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
        ]);
    });

    // ========================================================================
    // getMediaItemForTrickplay
    // ========================================================================

    describe('getMediaItemForTrickplay', () => {
        it('returns media item metadata when found', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getMediaItemForTrickplay(sql, item.id);

            expect(result).not.toBeNull();
            expect(result!.id).toBe(item.id);
            expect(result!.media_type).toBe('movie');
            expect(result!.title).toBe(item.title);
            expect(result!.parent_id).toBeNull();
        });

        it('returns null for non-existent media item', async () => {
            const result = await getMediaItemForTrickplay(
                sql,
                '00000000-0000-0000-0000-000000000000',
            );
            expect(result).toBeNull();
        });

        it('returns parent_id for episode items', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [episodeRow] = await sql<{ id: string; parent_id: string }[]>`
                SELECT id, parent_id FROM media_items
                WHERE parent_id IN (
                    SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid
                )
                AND media_type = 'episode'
                LIMIT 1
            `;
            expect(episodeRow).toBeDefined();

            const result = await getMediaItemForTrickplay(sql, episodeRow.id);
            expect(result).not.toBeNull();
            expect(result!.media_type).toBe('episode');
            expect(result!.parent_id).toBe(episodeRow.parent_id);
        });
    });

    // ========================================================================
    // findVideoPath
    // ========================================================================

    describe('findVideoPath', () => {
        it('finds direct file link for a movie', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const fileId = crypto.randomUUID();
            const filePath = '/test/movies/sample.mkv';

            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${filePath}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${mediaId}::uuid)
            `;

            const result = await findVideoPath(sql, mediaId);
            expect(result).toBe(filePath);
        });

        it('finds parent-level file link for an episode', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [seasonRow] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${series.seriesId}::uuid
                AND media_type = 'season'
                LIMIT 1
            `;
            const [episodeRow] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${seasonRow.id}::uuid
                AND media_type = 'episode'
                LIMIT 1
            `;

            const fileId = crypto.randomUUID();
            const filePath = '/test/seasons/sample.mkv';
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${filePath}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${seasonRow.id}::uuid)
            `;

            const result = await findVideoPath(sql, episodeRow.id);
            expect(result).toBe(filePath);
        });

        it('finds grandparent-level file link for an episode', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [episodeRow] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id IN (
                    SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid
                )
                AND media_type = 'episode'
                LIMIT 1
            `;

            const fileId = crypto.randomUUID();
            const filePath = '/test/series/root.mkv';
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${filePath}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${series.seriesId}::uuid)
            `;

            const result = await findVideoPath(sql, episodeRow.id);
            expect(result).toBe(filePath);
        });

        it('returns null when no file link exists', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const result = await findVideoPath(sql, mediaId);
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // findEpisodesForSeries
    // ========================================================================

    describe('findEpisodesForSeries', () => {
        it('returns all episodes for a series ordered by sort_order then title', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 3,
            });

            const result = await findEpisodesForSeries(sql, series.seriesId);

            expect(result.length).toBe(6);
            result.forEach((ep) => {
                expect(ep.id).toBeTruthy();
                expect(ep.title).toBeTruthy();
            });
        });

        it('returns empty array for series with no episodes', async () => {
            const { id: seriesId } = await createAndInsertTestMovie(sql);
            const result = await findEpisodesForSeries(sql, seriesId);
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // findEpisodesForSeason
    // ========================================================================

    describe('findEpisodesForSeason', () => {
        it('returns episodes for a specific season', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 2,
            });
            const [seasonRow] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${series.seriesId}::uuid
                AND media_type = 'season'
                ORDER BY season_number
                LIMIT 1
            `;

            const result = await findEpisodesForSeason(sql, seasonRow.id);

            expect(result.length).toBe(2);
        });

        it('returns empty array for season with no episodes', async () => {
            const { id: movieId } = await createAndInsertTestMovie(sql);
            const result = await findEpisodesForSeason(sql, movieId);
            expect(result).toEqual([]);
        });
    });
});
