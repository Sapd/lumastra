// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';
import { getAlbumSeries } from './music-album-series.queries.js';
import {
    unrestrictedAccess,
    restrictedAccess,
    denyAllAccess,
} from './builders/media-access-boundary.js';

describe('getAlbumSeries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe('TRUNCATE TABLE media_file_items, media_files, media_items CASCADE');
    });

    async function insertArtist(title: string): Promise<string> {
        return insertTestArtist(sql, createTestArtist({ title }));
    }

    async function insertAlbum(
        artistId: string,
        title: string,
        opts: { year?: number; tracks?: number } = {},
    ): Promise<string> {
        const album = createTestAlbum(artistId, { title, year: opts.year ?? 2012 });
        await insertTestAlbum(sql, album);
        for (let i = 1; i <= (opts.tracks ?? 1); i++) {
            await insertTestTrack(sql, createTestTrack(album.id, i));
        }
        return album.id;
    }

    it('returns the whole series ordered by volume, despite inconsistent spellings', async () => {
        const va = await insertArtist('Various Artists');
        const v70 = await insertAlbum(va, 'Future Trance 70', { year: 2014 });
        const v61 = await insertAlbum(va, 'Future Trance Vol.61', { year: 2012, tracks: 2 });
        const v65 = await insertAlbum(va, 'Future Trance Vol. 65', { year: 2013 });
        await insertAlbum(va, 'Hands Up Essentials, Vol. 1');

        const rows = await getAlbumSeries(sql, v65, unrestrictedAccess());

        expect(rows.map((r) => r.album_id)).toEqual([v61, v65, v70]);
        expect(rows.map((r) => r.volume)).toEqual([61, 65, 70]);
        expect(rows[0]).toMatchObject({ year: 2012, track_count: 2 });
    });

    it('never merges the same stem across album artists', async () => {
        const queen = await insertArtist('Queen');
        const abba = await insertArtist('ABBA');
        const q1 = await insertAlbum(queen, 'Greatest Hits Vol. 1');
        await insertAlbum(abba, 'Greatest Hits Vol. 2');

        expect(await getAlbumSeries(sql, q1, unrestrictedAccess())).toEqual([]);
    });

    it('is empty for an album without a series or with only one volume', async () => {
        const artist = await insertArtist('Solo');
        const plain = await insertAlbum(artist, 'Just An Album');
        const lone = await insertAlbum(artist, 'Lonely Vol. 1');

        expect(await getAlbumSeries(sql, plain, unrestrictedAccess())).toEqual([]);
        expect(await getAlbumSeries(sql, lone, unrestrictedAccess())).toEqual([]);
    });

    it('is empty when every match is the same volume (editions, discs)', async () => {
        const va = await insertArtist('Various Artists');
        const plain = await insertAlbum(va, 'Edition Test Vol. 1');
        await insertAlbum(va, 'Edition Test Vol. 1 (Deluxe)');
        await insertAlbum(va, 'Edition Test Vol. 1 (CD 2)');

        expect(await getAlbumSeries(sql, plain, unrestrictedAccess())).toEqual([]);
    });

    it('is empty when the open album itself has no playable tracks', async () => {
        const va = await insertArtist('Various Artists');
        const ghost = await insertAlbum(va, 'Ghost Series Vol. 1', { tracks: 0 });
        await insertAlbum(va, 'Ghost Series Vol. 2');
        await insertAlbum(va, 'Ghost Series Vol. 3');

        expect(await getAlbumSeries(sql, ghost, unrestrictedAccess())).toEqual([]);
    });

    it('drops albums without playable tracks', async () => {
        const va = await insertArtist('Various Artists');
        const v1 = await insertAlbum(va, 'Series X Vol. 1');
        const v2 = await insertAlbum(va, 'Series X Vol. 2');
        await insertAlbum(va, 'Series X Vol. 3', { tracks: 0 });

        const rows = await getAlbumSeries(sql, v1, unrestrictedAccess());
        expect(rows.map((r) => r.album_id)).toEqual([v1, v2]);
    });

    it('applies the access boundary to every series member', async () => {
        const va = await insertArtist('Various Artists');
        const v1 = await insertAlbum(va, 'Rated Series Vol. 1');
        const v2 = await insertAlbum(va, 'Rated Series Vol. 2');
        const v3 = await insertAlbum(va, 'Rated Series Vol. 3');
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${v3}::uuid`;

        const teen = restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: true });
        expect((await getAlbumSeries(sql, v1, teen)).map((r) => r.album_id)).toEqual([v1, v2]);
        expect(await getAlbumSeries(sql, v1, denyAllAccess())).toEqual([]);
    });
});
