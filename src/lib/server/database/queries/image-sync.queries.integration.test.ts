// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Image Sync Query Module
 *
 * Tests media item lookups, video path resolution, episode lookups,
 * artwork checks, and file path discovery for image sync operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createAndInsertTestSeries,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getMediaItemForImageSync,
    findVideoPath,
    findEpisodesForSeries,
    findVideoPathForSeries,
    findEpisodesForSeason,
    hasLocalArtwork,
    getLocalArtworkPaths,
    findMediaItemIdsWithLocalArtwork,
    deleteArtworkByIds,
    findEpisodeByNumbers,
    findSeasonByNumber,
    getMediaFilePaths,
    getEpisodeFilePaths,
    getSeriesFilePaths,
} from './image-sync.queries.js';

describe('Image Sync Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_artwork',
            'media_file_items',
            'media_files',
            'media_items',
            'external_ids',
        ]);
    });

    // ========================================================================
    // getMediaItemForImageSync
    // ========================================================================

    describe('getMediaItemForImageSync', () => {
        it('returns media item info when found', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getMediaItemForImageSync(sql, item.id);

            expect(result).not.toBeNull();
            expect(result!.id).toBe(item.id);
            expect(result!.media_type).toBe('movie');
            expect(result!.title).toBe(item.title);
        });

        it('returns null for non-existent item', async () => {
            const result = await getMediaItemForImageSync(
                sql,
                '00000000-0000-0000-0000-000000000000',
            );
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // findVideoPath
    // ========================================================================

    describe('findVideoPath', () => {
        it('returns direct file path for media item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/movies/test.mkv', 7200)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;

            const result = await findVideoPath(sql, item.id);
            expect(result).toBe('/movies/test.mkv');
        });

        it('returns null when no file exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await findVideoPath(sql, item.id);
            expect(result).toBeNull();
        });

        it('prefers the default file version over other linked versions', async () => {
            // An episode can link several physical files (alternate versions, or a
            // combined multi-episode file the scanner range-linked). Only the
            // is_default row is "this episode's file" — the timestamp math in
            // buildEpisodeTimestampMap resolves against is_default too, so picking a
            // different row here yields a frame from the wrong video entirely.
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            const [otherFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/tv/show/S06E01E03-combined.mkv', 344)
                RETURNING id
            `;
            const [defaultFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds)
                VALUES ('/tv/show/S06E02-own-file.mkv', 632)
                RETURNING id
            `;
            // Insert the non-default row FIRST so physical row order favours it.
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${otherFile.id}::uuid, ${item.id}::uuid, false),
                       (${defaultFile.id}::uuid, ${item.id}::uuid, true)
            `;

            const result = await findVideoPath(sql, item.id);
            expect(result).toBe('/tv/show/S06E02-own-file.mkv');
        });
    });

    // ========================================================================
    // findEpisodesForSeries
    // ========================================================================

    describe('findEpisodesForSeries', () => {
        it('returns all episode IDs for a series', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 3,
            });

            const result = await findEpisodesForSeries(sql, series.seriesId);

            expect(result).toHaveLength(6);
        });

        it('returns empty array for series with no episodes', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            const result = await findEpisodesForSeries(sql, item.id);
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // findVideoPathForSeries
    // ========================================================================

    describe('findVideoPathForSeries', () => {
        it('returns first episode file path for a series', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            // Insert a file for one of the episodes
            const episodes = await findEpisodesForSeries(sql, series.seriesId);
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/series/s01e01.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${episodes[0].id}::uuid)
            `;

            const result = await findVideoPathForSeries(sql, series.seriesId);
            expect(result).toBe('/series/s01e01.mkv');
        });

        it('returns null when series has no episode files', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            const result = await findVideoPathForSeries(sql, item.id);
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // findEpisodesForSeason
    // ========================================================================

    describe('findEpisodesForSeason', () => {
        it('returns episode IDs for a season', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 3,
            });

            const [seasonRow] = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE parent_id = ${series.seriesId} AND media_type = 'season' LIMIT 1
            `;
            const seasonId = seasonRow.id;

            const result = await findEpisodesForSeason(sql, seasonId);
            expect(result).toHaveLength(3);
        });

        it('returns empty array for season with no episodes', async () => {
            const item = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, item);

            const result = await findEpisodesForSeason(sql, item.id);
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // hasLocalArtwork
    // ========================================================================

    describe('hasLocalArtwork', () => {
        it('returns true when local artwork exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${item.id}::uuid, 'poster', 'local', '/artwork/poster.jpg')
            `;

            const result = await hasLocalArtwork(sql, item.id, 'poster');
            expect(result).toBe(true);
        });

        it('returns false when only remote artwork exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${item.id}::uuid, 'poster', 'tmdb', 'https://tmdb/poster.jpg')
            `;

            const result = await hasLocalArtwork(sql, item.id, 'poster');
            expect(result).toBe(false);
        });

        it('returns false when no artwork exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await hasLocalArtwork(sql, item.id, 'poster');
            expect(result).toBe(false);
        });
    });

    // ========================================================================
    // getLocalArtworkPaths
    // ========================================================================

    describe('getLocalArtworkPaths', () => {
        it('returns local artwork paths for media items', async () => {
            const item1 = createTestMediaItem({ media_type: 'movie' });
            const item2 = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item1);
            await insertTestMediaItem(sql, item2);

            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES
                    (${item1.id}::uuid, 'poster', 'local', '/art/1.jpg'),
                    (${item2.id}::uuid, 'backdrop', 'local', '/art/2.jpg')
            `;

            const result = await getLocalArtworkPaths(sql, [item1.id, item2.id]);
            expect(result).toHaveLength(2);
        });

        it('returns empty array for empty input', async () => {
            const result = await getLocalArtworkPaths(sql, []);
            expect(result).toEqual([]);
        });

        it('excludes remote artwork', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${item.id}::uuid, 'poster', 'tmdb', 'https://remote.jpg')
            `;

            const result = await getLocalArtworkPaths(sql, [item.id]);
            expect(result).toHaveLength(0);
        });

        it('returns media_item_id and artwork_type alongside id and file_path', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${item.id}::uuid, 'poster', 'local', '/art/poster.jpg')
            `;

            const rows = await getLocalArtworkPaths(sql, [item.id]);
            expect(rows).toHaveLength(1);
            // The reaper needs BOTH of these to pick the right custom_<type>_url to
            // clear; `{ id, file_path }` alone cannot identify the column.
            expect(rows[0].media_item_id).toBe(item.id);
            expect(rows[0].artwork_type).toBe('poster');
            expect(rows[0].file_path).toBe('/art/poster.jpg');
            expect(typeof rows[0].id).toBe('string');
        });
    });

    // ========================================================================
    // findMediaItemIdsWithLocalArtwork
    // ========================================================================

    describe('findMediaItemIdsWithLocalArtwork', () => {
        it('pages distinct ids ascending, skipping remote-only items', async () => {
            const a = createTestMediaItem({ media_type: 'movie' });
            const b = createTestMediaItem({ media_type: 'movie' });
            const c = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, a);
            await insertTestMediaItem(sql, b);
            await insertTestMediaItem(sql, c);

            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES
                    (${a.id}::uuid, 'poster',   'local', '/art/a-poster.jpg'),
                    (${a.id}::uuid, 'backdrop', 'local', '/art/a-backdrop.jpg'),
                    (${b.id}::uuid, 'poster',   'local', '/art/b-poster.jpg'),
                    (${c.id}::uuid, 'poster',   'tmdb',  'https://remote/c.jpg')
            `;

            // crypto.randomUUID() yields lowercase canonical uuids, whose JS
            // lexicographic order matches Postgres' uuid byte order, so the
            // expected page order is just the sorted pair.
            const sorted = [a.id, b.id].sort();

            const page1 = await findMediaItemIdsWithLocalArtwork(sql, null, 1);
            expect(page1).toEqual([sorted[0]]);

            const page2 = await findMediaItemIdsWithLocalArtwork(sql, sorted[0], 10);
            expect(page2).toEqual([sorted[1]]);

            const page3 = await findMediaItemIdsWithLocalArtwork(sql, sorted[1], 10);
            expect(page3).toEqual([]);
        });

        it('excludes local rows with a NULL file_path', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${item.id}::uuid, 'poster', 'local', NULL)
            `;

            const ids = await findMediaItemIdsWithLocalArtwork(sql, null, 10);
            expect(ids).toEqual([]);
        });
    });

    // ========================================================================
    // deleteArtworkByIds
    // ========================================================================

    describe('deleteArtworkByIds', () => {
        it('retains archived image bytes and references during automatic cleanup', async () => {
            const item = createTestMediaItem({ title: 'Lantern Gallery', media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`INSERT INTO media_artwork(media_item_id,artwork_type,file_path) VALUES (${item.id},'poster','/art/hidden.jpg')`;
            const [candidate] = await getLocalArtworkPaths(sql, [item.id]);
            await sql`UPDATE image_candidates SET suppressed=true,selected=false WHERE id=${candidate.id}`;
            expect(await hasLocalArtwork(sql, item.id, 'poster')).toBe(false);
            expect(await getLocalArtworkPaths(sql, [item.id])).toEqual([]);
            expect(await deleteArtworkByIds(sql, [candidate.id])).toBe(0);
            expect(
                await sql`SELECT id FROM image_candidates WHERE id=${candidate.id}`,
            ).toHaveLength(1);
        });
        it('deletes artwork by IDs and returns count', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const [artRow] = await sql<{ id: string }[]>`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${item.id}::uuid, 'poster', 'local', '/art/poster.jpg')
                RETURNING id
            `;

            const [canonical] = await getLocalArtworkPaths(sql, [item.id]);
            expect(canonical.id).not.toBe(artRow.id);
            const count = await deleteArtworkByIds(sql, [canonical.id]);
            expect(
                await sql`SELECT id FROM image_candidates WHERE id = ${canonical.id}`,
            ).toHaveLength(0);
            expect(count).toBe(1);

            const remaining = await sql`
                SELECT id FROM media_artwork WHERE id = ${artRow.id}::uuid
            `;
            expect(remaining).toHaveLength(0);
        });

        it('keeps a remaining alternative selected, mirrored and reachable when deleting a canonical ID', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`SELECT register_image_candidate(${item.id},'poster','local-folder','/first.jpg','/first.jpg')`;
            await sql`SELECT register_image_candidate(${item.id},'poster','tmdb','/alternate.jpg','/alternate.jpg')`;
            await sql`UPDATE media_items SET custom_poster_url = ${`/api/image/custom/${item.id}/poster`} WHERE id = ${item.id}`;
            const [first] = await sql<
                { id: string }[]
            >`SELECT id FROM image_candidates WHERE media_item_id = ${item.id} AND selected`;
            expect(await deleteArtworkByIds(sql, [first.id])).toBe(1);
            expect(
                await sql`SELECT file_path FROM image_candidates WHERE media_item_id = ${item.id} AND selected`,
            ).toEqual([{ file_path: '/alternate.jpg' }]);
            expect(
                await sql`SELECT file_path FROM media_artwork WHERE media_item_id = ${item.id}`,
            ).toEqual([{ file_path: '/alternate.jpg' }]);
            expect(
                await sql`SELECT custom_poster_url FROM media_items WHERE id = ${item.id}`,
            ).toEqual([{ custom_poster_url: `/api/image/custom/${item.id}/poster` }]);
        });

        it('returns 0 for empty input', async () => {
            const count = await deleteArtworkByIds(sql, []);
            expect(count).toBe(0);
        });

        it('clears the paired custom_{type}_url of each deleted local row', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const [posterRow] = await sql<{ id: string }[]>`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${item.id}::uuid, 'poster', 'local', '/art/poster.jpg')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${item.id}::uuid, 'backdrop', 'local', '/art/backdrop.jpg')
            `;
            await sql`
                UPDATE media_items
                SET custom_poster_url   = ${'/api/image/custom/' + item.id + '/poster'},
                    custom_backdrop_url = ${'/api/image/custom/' + item.id + '/backdrop'}
                WHERE id = ${item.id}::uuid
            `;

            const [canonical] = (await getLocalArtworkPaths(sql, [item.id])).filter(
                (row) => row.artwork_type === 'poster',
            );
            expect(canonical.id).not.toBe(posterRow.id);
            expect(await deleteArtworkByIds(sql, [canonical.id])).toBe(1);
            expect(
                await sql`SELECT id FROM image_candidates WHERE id = ${canonical.id}`,
            ).toHaveLength(0);
            expect(await sql`SELECT id FROM media_artwork WHERE id = ${posterRow.id}`).toHaveLength(
                0,
            );

            const [after] = await sql<{ poster: string | null; backdrop: string | null }[]>`
                SELECT custom_poster_url AS poster, custom_backdrop_url AS backdrop
                FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(after.poster).toBeNull();
            // The backdrop row still stands, so its pointer must survive.
            expect(after.backdrop).toBe(`/api/image/custom/${item.id}/backdrop`);
        });

        it('leaves a provider URL standing when a local row is deleted', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const [artRow] = await sql<{ id: string }[]>`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${item.id}::uuid, 'poster', 'local', '/art/poster.jpg')
                RETURNING id
            `;
            await sql`
                UPDATE media_items
                SET custom_poster_url = 'https://image.tmdb.org/t/p/original/xyz.jpg'
                WHERE id = ${item.id}::uuid
            `;

            const [canonical] = (await getLocalArtworkPaths(sql, [item.id])).filter(
                (row) => row.artwork_type === 'poster',
            );
            expect(canonical.id).not.toBe(artRow.id);
            expect(await deleteArtworkByIds(sql, [canonical.id])).toBe(1);

            const [after] = await sql<{ poster: string | null }[]>`
                SELECT custom_poster_url AS poster FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(after.poster).toBe('https://image.tmdb.org/t/p/original/xyz.jpg');
        });
    });

    // ========================================================================
    // findEpisodeByNumbers
    // ========================================================================

    describe('findEpisodeByNumbers', () => {
        it('finds episode by season and episode number', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 3,
            });

            const result = await findEpisodeByNumbers(sql, series.seriesId, 1, 2);
            expect(result).not.toBeNull();
        });

        it('returns null for non-existent episode', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            const result = await findEpisodeByNumbers(sql, item.id, 99, 99);
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // findSeasonByNumber
    // ========================================================================

    describe('findSeasonByNumber', () => {
        it('finds season by number within a series', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 2,
            });

            const result = await findSeasonByNumber(sql, series.seriesId, 2);
            expect(result).not.toBeNull();
        });

        it('returns null for non-existent season', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            const result = await findSeasonByNumber(sql, item.id, 99);
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // getMediaFilePaths
    // ========================================================================

    describe('getMediaFilePaths', () => {
        it('returns file paths for media item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/movies/test.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;

            const result = await getMediaFilePaths(sql, item.id);
            expect(result).toEqual(['/movies/test.mkv']);
        });

        it('returns empty array when no files exist', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getMediaFilePaths(sql, item.id);
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // getEpisodeFilePaths
    // ========================================================================

    describe('getEpisodeFilePaths', () => {
        it('returns file paths for child episodes', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            const episodes = await findEpisodesForSeries(sql, series.seriesId);
            const [seasonRow] = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE parent_id = ${series.seriesId} AND media_type = 'season' LIMIT 1
            `;
            const seasonId = seasonRow.id;

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/series/s01e01.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${episodes[0].id}::uuid)
            `;

            const result = await getEpisodeFilePaths(sql, seasonId);
            expect(result).toContain('/series/s01e01.mkv');
        });
    });

    // ========================================================================
    // getSeriesFilePaths
    // ========================================================================

    describe('getSeriesFilePaths', () => {
        it('returns both direct and episode paths', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES ('/series/direct.mkv')
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;

            const result = await getSeriesFilePaths(sql, item.id);
            expect(result.direct).toBe('/series/direct.mkv');
            expect(result.episode).toBeNull();
        });
    });
});
