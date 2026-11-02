// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for processArtwork's flat season-artwork routing.
 *
 * `Show/season01-poster.jpg` (Sonarr/Kodi/Jellyfin flat convention) must attach
 * to the SEASON the filename names — never to the series, and never to
 * whichever season happens to own an episode file in the same directory. It
 * must be dropped rather than mis-attached when the named season does not exist.
 *
 * Both library layouts are covered because they fail differently today:
 *   - season-foldered  (`Show/Season 01/S01E01.mkv`) -> the file is DROPPED
 *   - folderless       (`Show/S01E01.mkv`)           -> the file is MIS-ATTACHED
 *                                                       to season 1
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import {
    upsertMediaFile,
    attachFileToItem,
} from '../../../../../../database/queries/media-files.queries.js';
import { upsertLocalArtwork } from '../../../../../../database/queries/media-artwork.queries.js';
import type { ArtworkEntry } from '../../../../../../utils/walk-directory.js';
import type { FileScannerContext } from './shared.js';
import { processArtwork } from './ancillary-processors.js';

const LIB = '/library/tv';

const context = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
} as unknown as FileScannerContext;

interface Show {
    seriesId: string;
    season1Id: string;
    season2Id: string;
    specialsId: string;
    episodeId: string;
}

describe('processArtwork — flat season artwork', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Repo convention (see media-artwork.queries.integration.test.ts:55):
        // truncateTables serialises every test TRUNCATE behind
        // TRUNCATE_ADVISORY_LOCK_KEY. A hand-rolled `sql.unsafe('TRUNCATE …')`
        // bypasses that lock and can deadlock against a lingering teardown in
        // another file (test-database.ts:105-113 documents the failure mode).
        await truncateTables(sql, [...TEST_TABLES.media, 'media_artwork']);
    });

    /**
     * Build a series with:
     *   - season 1  (holds the only episode file)
     *   - season 2  (exists, owns no files)
     *   - specials  (season_number 0, owns no files)
     * and one episode whose file lives at `episodePath`.
     *   foldered   -> `<LIB>/<name>/Season 01/S01E01.mkv`
     *   folderless -> `<LIB>/<name>/S01E01.mkv`
     *
     * Season 2 exists specifically so the folderless tests can DISCRIMINATE:
     * today's resolution ignores the number in the filename and always lands on
     * the season that owns the episode (season 1).
     */
    async function insertShow(name: string, layout: 'foldered' | 'folderless'): Promise<Show> {
        const [series] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES (${name}, 'tv', 'active', true)
            RETURNING id
        `;
        const [season1] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number)
            VALUES ('Season 1', 'season', 'active', true, ${series.id}::uuid, 1)
            RETURNING id
        `;
        const [season2] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number)
            VALUES ('Season 2', 'season', 'active', false, ${series.id}::uuid, 2)
            RETURNING id
        `;
        const [specials] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number)
            VALUES ('Specials', 'season', 'active', false, ${series.id}::uuid, 0)
            RETURNING id
        `;
        const [episode] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, status, has_files, parent_id, season_number, episode_number)
            VALUES ('Pilot', 'episode', 'active', true, ${season1.id}::uuid, 1, 1)
            RETURNING id
        `;
        const episodePath =
            layout === 'foldered'
                ? `${LIB}/${name}/Season 01/S01E01.mkv`
                : `${LIB}/${name}/S01E01.mkv`;
        const { id: fileId } = await upsertMediaFile(sql, { filePath: episodePath });
        await attachFileToItem(sql, fileId, episode.id);
        return {
            seriesId: series.id,
            season1Id: season1.id,
            season2Id: season2.id,
            specialsId: specials.id,
            episodeId: episode.id,
        };
    }

    async function artworkRows(
        mediaItemId: string,
    ): Promise<{ artwork_type: string; file_path: string | null }[]> {
        return sql<{ artwork_type: string; file_path: string | null }[]>`
            SELECT artwork_type, file_path
            FROM media_artwork
            WHERE media_item_id = ${mediaItemId}::uuid
        `;
    }

    async function customPosterUrl(mediaItemId: string): Promise<string | null> {
        const [row] = await sql<[{ custom_poster_url: string | null }]>`
            SELECT custom_poster_url FROM media_items WHERE id = ${mediaItemId}::uuid
        `;
        return row.custom_poster_url;
    }

    // -- Season-foldered layout: the file is DROPPED today ------------------

    it('attaches Show/season01-poster.jpg to the season, leaving the series poster untouched', async () => {
        const show = await insertShow('Foldered Show', 'foldered');
        // The series already owns its own poster — it must survive verbatim.
        const seriesPosterPath = `${LIB}/Foldered Show/poster.jpg`;
        await upsertLocalArtwork(sql, {
            mediaItemId: show.seriesId,
            artworkType: 'poster',
            filePath: seriesPosterPath,
        });

        const entry: ArtworkEntry = {
            filePath: `${LIB}/Foldered Show/season01-poster.jpg`,
            artworkType: 'poster',
            seasonNumber: 1,
        };
        expect(await processArtwork(sql, entry, context)).toBe('added');

        expect(await artworkRows(show.season1Id)).toEqual([
            { artwork_type: 'poster', file_path: entry.filePath },
        ]);
        // Series untouched: same single row, same path.
        expect(await artworkRows(show.seriesId)).toEqual([
            { artwork_type: 'poster', file_path: seriesPosterPath },
        ]);
        expect(await customPosterUrl(show.season1Id)).toBe(
            `/api/image/custom/${show.season1Id}/poster`,
        );
        expect(await artworkRows(show.specialsId)).toEqual([]);
    });

    it('attaches season-specials-poster.jpg to the season_number = 0 row', async () => {
        const show = await insertShow('Specials Show', 'foldered');

        const entry: ArtworkEntry = {
            filePath: `${LIB}/Specials Show/season-specials-poster.jpg`,
            artworkType: 'poster',
            seasonNumber: 0,
        };
        expect(await processArtwork(sql, entry, context)).toBe('added');

        expect(await artworkRows(show.specialsId)).toEqual([
            { artwork_type: 'poster', file_path: entry.filePath },
        ]);
        expect(await artworkRows(show.season1Id)).toEqual([]);
        expect(await artworkRows(show.seriesId)).toEqual([]);
    });

    // -- Folderless layout: the file is MIS-ATTACHED to season 1 today ------

    it('honours the number in the filename: season02-poster.jpg lands on season 2, not the episode-bearing season 1', async () => {
        const show = await insertShow('Folderless Show', 'folderless');

        const entry: ArtworkEntry = {
            filePath: `${LIB}/Folderless Show/season02-poster.jpg`,
            artworkType: 'poster',
            seasonNumber: 2,
        };
        expect(await processArtwork(sql, entry, context)).toBe('added');

        expect(await artworkRows(show.season2Id)).toEqual([
            { artwork_type: 'poster', file_path: entry.filePath },
        ]);
        // Today's resolution (episode in the same dir -> findSeasonParentIfEpisode)
        // would have put it HERE. It must not.
        expect(await artworkRows(show.season1Id)).toEqual([]);
        expect(await artworkRows(show.seriesId)).toEqual([]);
        expect(await artworkRows(show.episodeId)).toEqual([]);
    });

    it('skips (never falls back to season 1 or the series) when the named season does not exist', async () => {
        const show = await insertShow('Missing Season Show', 'folderless');

        const entry: ArtworkEntry = {
            filePath: `${LIB}/Missing Season Show/season07-poster.jpg`,
            artworkType: 'poster',
            seasonNumber: 7,
        };
        expect(await processArtwork(sql, entry, context)).toBe('skipped');

        expect(await artworkRows(show.seriesId)).toEqual([]);
        expect(await artworkRows(show.season1Id)).toEqual([]);
        expect(await artworkRows(show.season2Id)).toEqual([]);
        expect(await artworkRows(show.episodeId)).toEqual([]);
    });

    // -- Guards: these pass BEFORE and AFTER; they lock behaviour in place --

    it('GUARD: folderless season01-poster.jpg still lands on season 1', async () => {
        const show = await insertShow('Folderless One', 'folderless');

        const entry: ArtworkEntry = {
            filePath: `${LIB}/Folderless One/season01-poster.jpg`,
            artworkType: 'poster',
            seasonNumber: 1,
        };
        expect(await processArtwork(sql, entry, context)).toBe('added');

        expect(await artworkRows(show.season1Id)).toEqual([
            { artwork_type: 'poster', file_path: entry.filePath },
        ]);
        expect(await artworkRows(show.seriesId)).toEqual([]);
        expect(await customPosterUrl(show.seriesId)).toBeNull();
    });

    it('GUARD: skips when the folder resolves to no media item at all', async () => {
        const entry: ArtworkEntry = {
            filePath: `${LIB}/Unknown Show/season01-poster.jpg`,
            artworkType: 'poster',
            seasonNumber: 1,
        };
        expect(await processArtwork(sql, entry, context)).toBe('skipped');

        const [{ count }] = await sql<[{ count: string }]>`SELECT count(*) FROM media_artwork`;
        expect(Number(count)).toBe(0);
    });

    it('GUARD: an entry without seasonNumber still uses the existing folder resolution', async () => {
        const show = await insertShow('Legacy Show', 'foldered');

        // `Show/Season 01/folder.jpg` — the folder holds the episode file, so the
        // existing path resolves episode -> findSeasonParentIfEpisode -> season.
        const entry: ArtworkEntry = {
            filePath: `${LIB}/Legacy Show/Season 01/folder.jpg`,
            artworkType: 'poster',
        };
        expect(await processArtwork(sql, entry, context)).toBe('added');

        expect(await artworkRows(show.season1Id)).toEqual([
            { artwork_type: 'poster', file_path: entry.filePath },
        ]);
    });

    it('attaches series-root artwork to a season-foldered series', async () => {
        const show = await insertShow('Ted', 'foldered');
        const entry: ArtworkEntry = {
            filePath: `${LIB}/Ted/backdrop.jpg`,
            artworkType: 'backdrop',
        };

        expect(await processArtwork(sql, entry, context)).toBe('added');

        expect(await artworkRows(show.seriesId)).toEqual([
            { artwork_type: 'backdrop', file_path: entry.filePath },
        ]);
        expect(await artworkRows(show.season1Id)).toEqual([]);
        expect(await artworkRows(show.episodeId)).toEqual([]);
    });

    it('does not attribute library-root artwork to a folderless show', async () => {
        const show = await insertShow('Folderless Show', 'folderless');
        const entry: ArtworkEntry = {
            filePath: `${LIB}/backdrop.jpg`,
            artworkType: 'backdrop',
        };

        expect(await processArtwork(sql, entry, context)).toBe('skipped');

        expect(await artworkRows(show.seriesId)).toEqual([]);
        expect(await artworkRows(show.season1Id)).toEqual([]);
        expect(await artworkRows(show.episodeId)).toEqual([]);
    });
});
