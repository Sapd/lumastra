// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Extras (Trailer Resolution) Query Module
 *
 * Tests resolving a parent media item's local trailer child, and looking
 * up an item's media_type + parent_id.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';

// Import query functions to test
import {
    findLocalTrailerForItem,
    getMediaTypeAndParent,
    findLibraryGroupForItemTree,
} from './media-extras.queries.js';
import {
    findParentMediaItemByFolder,
    findRootMediaItemByFolderRecursive,
} from './media-files.queries.js';
import { getMediaDetailByUuid } from './media-details.queries.js';

describe('Media Extras Queries', () => {
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

    /**
     * Insert a movie media_items row and return its UUID.
     */
    async function insertMovie(localSql: postgres.Sql, title: string): Promise<string> {
        const rows = await localSql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, has_files)
            VALUES (${title}, 'movie', true)
            RETURNING id
        `;
        return rows[0].id;
    }

    /**
     * Insert an 'extra' media_items row (trailer, featurette, etc.) linked
     * to a parent movie/series via parent_id. Returns the new UUID.
     */
    async function insertExtra(
        localSql: postgres.Sql,
        parentId: string,
        extraType: string,
    ): Promise<string> {
        const rows = await localSql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, extra_type, parent_id)
            VALUES (${extraType}, 'extra', ${extraType}, ${parentId})
            RETURNING id
        `;
        return rows[0].id;
    }

    /**
     * Link a media_items row to a media_files row via media_file_items,
     * with the given is_missing flag on the file.
     */
    async function linkFile(
        localSql: postgres.Sql,
        mediaItemId: string,
        filePath: string,
        isMissing: boolean,
    ): Promise<void> {
        const [file] = await localSql<{ id: string }[]>`
            INSERT INTO media_files (file_path, is_missing)
            VALUES (${filePath}, ${isMissing})
            RETURNING id
        `;
        await localSql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${file.id}, ${mediaItemId})
        `;
    }

    describe('findLocalTrailerForItem', () => {
        it('returns the trailer child with a present file', async () => {
            const movieId = await insertMovie(sql, 'Movie A');
            const trailerId = await insertExtra(sql, movieId, 'trailer');
            await linkFile(sql, trailerId, '/data/movies/Movie A/trailers/t1.mkv', false);
            expect(await findLocalTrailerForItem(sql, movieId)).toBe(trailerId);
        });

        it('returns null when the only trailer file is missing', async () => {
            const movieId = await insertMovie(sql, 'Movie B');
            const trailerId = await insertExtra(sql, movieId, 'trailer');
            await linkFile(sql, trailerId, '/data/movies/Movie B/trailers/t1.mkv', true);
            expect(await findLocalTrailerForItem(sql, movieId)).toBeNull();
        });

        it('returns null when there is no trailer child / ignores other extra types', async () => {
            const movieId = await insertMovie(sql, 'Movie C');
            const featuretteId = await insertExtra(sql, movieId, 'featurette');
            await linkFile(sql, featuretteId, '/data/movies/Movie C/extras/f1.mkv', false);
            expect(await findLocalTrailerForItem(sql, movieId)).toBeNull();
        });

        it('is deterministic with multiple trailers (lowest id wins)', async () => {
            const movieId = await insertMovie(sql, 'Movie D');
            const t1 = await insertExtra(sql, movieId, 'trailer');
            const t2 = await insertExtra(sql, movieId, 'trailer');
            await linkFile(sql, t1, '/data/movies/Movie D/trailers/t1.mkv', false);
            await linkFile(sql, t2, '/data/movies/Movie D/trailers/t2.mkv', false);
            const expected = [t1, t2].sort()[0];
            expect(await findLocalTrailerForItem(sql, movieId)).toBe(expected);
        });
    });

    /**
     * Insert a series ('tv') media_items row and return its UUID. Series
     * parents have no `media_files` of their own — only their episodes do.
     */
    async function insertSeries(localSql: postgres.Sql, title: string): Promise<string> {
        const rows = await localSql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, has_files)
            VALUES (${title}, 'tv', false)
            RETURNING id
        `;
        return rows[0].id;
    }

    /**
     * Insert an episode media_items row as a child of `seriesId`.
     */
    async function insertEpisode(
        localSql: postgres.Sql,
        seriesId: string,
        title: string,
    ): Promise<string> {
        const rows = await localSql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, has_files)
            VALUES (${title}, 'episode', ${seriesId}, true)
            RETURNING id
        `;
        return rows[0].id;
    }

    describe('getMediaTypeAndParent', () => {
        it('returns type and parent for an extra', async () => {
            const movieId = await insertMovie(sql, 'Movie E');
            const trailerId = await insertExtra(sql, movieId, 'trailer');
            expect(await getMediaTypeAndParent(sql, trailerId)).toEqual({
                media_type: 'extra',
                parent_id: movieId,
            });
        });

        it('returns null for an unknown id', async () => {
            expect(
                await getMediaTypeAndParent(sql, '00000000-0000-0000-0000-000000000000'),
            ).toBeNull();
        });
    });

    /**
     * Insert a library_groups row and return its UUID. `name` is the only
     * NOT NULL column without a default.
     */
    async function insertLibraryGroup(localSql: postgres.Sql): Promise<string> {
        const rows = await localSql<{ id: string }[]>`
            INSERT INTO library_groups (name)
            VALUES ('Test Group')
            RETURNING id
        `;
        return rows[0].id;
    }

    /**
     * Link a media_items row to a media_files row via media_file_items,
     * stamping the file's library_group_id directly (bypasses the ingest
     * code path — used to simulate a movie whose file already carries a
     * library group).
     */
    async function linkFileWithGroup(
        localSql: postgres.Sql,
        mediaItemId: string,
        filePath: string,
        groupId: string,
    ): Promise<void> {
        const [file] = await localSql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id)
            VALUES (${filePath}, ${groupId})
            RETURNING id
        `;
        await localSql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${file.id}, ${mediaItemId})
        `;
    }

    describe('findLibraryGroupForItemTree', () => {
        it("resolves from the item's own files (direct case)", async () => {
            const groupId = await insertLibraryGroup(sql);
            const movieId = await insertMovie(sql, 'Movie I');
            await linkFileWithGroup(sql, movieId, '/data/movies/Movie I/i.mkv', groupId);
            expect(await findLibraryGroupForItemTree(sql, movieId)).toBe(groupId);
        });

        it('walks descendants when the item itself has no files (series case)', async () => {
            const groupId = await insertLibraryGroup(sql);
            const seriesId = await insertSeries(sql, 'Series A');
            const episodeId = await insertEpisode(sql, seriesId, 'Series A S01E01');
            await linkFileWithGroup(sql, episodeId, '/data/series/Series A/S01E01.mkv', groupId);
            expect(await findLibraryGroupForItemTree(sql, seriesId)).toBe(groupId);
        });

        it('returns null when neither the item nor any descendant has a grouped file', async () => {
            const seriesId = await insertSeries(sql, 'Series B');
            await insertEpisode(sql, seriesId, 'Series B S01E01'); // no file at all
            expect(await findLibraryGroupForItemTree(sql, seriesId)).toBeNull();
        });
    });

    describe('findRootMediaItemByFolderRecursive (series-root extras fallback)', () => {
        it('resolves a series root folder to the series row via an episode file in a season subfolder', async () => {
            const seriesId = await insertSeries(sql, 'Stargate Origins');
            const episodeId = await insertEpisode(sql, seriesId, 'Stargate Origins S01E01');
            await linkFile(
                sql,
                episodeId,
                '/data/series/Stargate Origins (2018) [imdbid-tt7161862]/Season 1/S01E01.mkv',
                false,
            );

            // The series root has no file directly inside it — only the
            // episode, one subfolder down — so the existing direct-children
            // lookup must miss here (this is the bug: processExtra's ONLY
            // resolution path before this fallback).
            expect(
                await findParentMediaItemByFolder(
                    sql,
                    '/data/series/Stargate Origins (2018) [imdbid-tt7161862]',
                ),
            ).toBeNull();

            expect(
                await findRootMediaItemByFolderRecursive(
                    sql,
                    '/data/series/Stargate Origins (2018) [imdbid-tt7161862]',
                ),
            ).toBe(seriesId);
        });

        it('walks up through a season parent to the series when the episode has a season row', async () => {
            const seriesId = await insertSeries(sql, 'Series K');
            const seasonRows = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, parent_id, has_files)
                VALUES ('Season 1', 'season', ${seriesId}, false)
                RETURNING id
            `;
            const seasonId = seasonRows[0].id;
            const episodeRows = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, parent_id, has_files)
                VALUES ('Series K S01E01', 'episode', ${seasonId}, true)
                RETURNING id
            `;
            const episodeId = episodeRows[0].id;
            await linkFile(sql, episodeId, '/data/series/Series K/Season 1/S01E01.mkv', false);

            expect(await findRootMediaItemByFolderRecursive(sql, '/data/series/Series K')).toBe(
                seriesId,
            );
        });

        it('a movie folder still resolves via the direct path (no behavior change)', async () => {
            const movieId = await insertMovie(sql, 'Movie K');
            await linkFile(sql, movieId, '/data/movies/Movie K/Movie K.mkv', false);

            // The direct-children lookup (tried FIRST by processExtra) already
            // succeeds for a movie — the recursive fallback is never reached
            // in practice for this shape.
            expect(await findParentMediaItemByFolder(sql, '/data/movies/Movie K')).toBe(movieId);
            // The recursive fallback also resolves the same result for this
            // flat shape (no ancestors — the movie IS its own top), so it is
            // a safe, behavior-preserving fallback if ever reached.
            expect(await findRootMediaItemByFolderRecursive(sql, '/data/movies/Movie K')).toBe(
                movieId,
            );
        });

        it('returns null for a folder with no linked files at all', async () => {
            expect(
                await findRootMediaItemByFolderRecursive(sql, '/data/movies/Nonexistent Folder'),
            ).toBeNull();
        });
    });

    describe('getMediaDetailByUuid has_local_trailer', () => {
        it('reports has_local_trailer', async () => {
            const movieId = await insertMovie(sql, 'Movie F');
            expect((await getMediaDetailByUuid(sql, movieId))?.has_local_trailer).toBe(false);
            const trailerId = await insertExtra(sql, movieId, 'trailer');
            await linkFile(sql, trailerId, '/data/movies/Movie F/trailers/t.mkv', false);
            expect((await getMediaDetailByUuid(sql, movieId))?.has_local_trailer).toBe(true);
        });
    });
});
