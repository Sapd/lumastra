// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Album Art Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { recomputeHasFiles } from './media-files.queries.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    insertTestArtist,
    createTestAlbum,
    insertTestAlbum,
    createTestTrack,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    findTracksUnderDir,
    findAlbumsNeedingCoverArt,
    clearCoverArtFetchFlag,
    findTrackFileForAlbum,
} from './album-art.queries.js';

describe('Album Art Queries', () => {
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

    describe('findTracksUnderDir', () => {
        it('returns tracks whose file_path matches the prefix', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            const track = createTestTrack(album.id, 1);
            await insertTestAlbum(sql, album);
            await insertTestTrack(sql, track);

            const rows = await findTracksUnderDir(sql, '/test/music/');
            expect(rows.length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('findAlbumsNeedingCoverArt', () => {
        it('returns albums flagged for cover art fetch', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Needs Cover',
            });
            await insertTestAlbum(sql, album);
            await sql`
                UPDATE media_items
                SET custom_metadata = jsonb_build_object('needs_cover_art_fetch', true)
                WHERE id = ${album.id}::uuid
            `;

            const track = createTestTrack(album.id, 1);
            await insertTestTrack(sql, track);
            await recomputeHasFiles(sql, track.id);

            const rows = await findAlbumsNeedingCoverArt(sql);
            expect(rows.some((r) => r.id === album.id)).toBe(true);
        });

        it('does not return albums with existing local poster artwork', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id, {
                title: 'Has Cover',
            });
            await insertTestAlbum(sql, album);
            await sql`
                UPDATE media_items
                SET custom_metadata = jsonb_build_object('needs_cover_art_fetch', true)
                WHERE id = ${album.id}::uuid
            `;
            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
                VALUES (${album.id}::uuid, 'poster', 'local', '/covers/poster.jpg')
            `;

            const track = createTestTrack(album.id, 1);
            await insertTestTrack(sql, track);
            await recomputeHasFiles(sql, track.id);

            const rows = await findAlbumsNeedingCoverArt(sql);
            expect(rows.some((r) => r.id === album.id)).toBe(false);
        });
    });

    describe('clearCoverArtFetchFlag', () => {
        it('removes the needs_cover_art_fetch flag', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);
            await sql`
                UPDATE media_items
                SET custom_metadata = jsonb_build_object('needs_cover_art_fetch', true)
                WHERE id = ${album.id}::uuid
            `;

            await clearCoverArtFetchFlag(sql, album.id);

            const rows = await sql`
                SELECT custom_metadata FROM media_items WHERE id = ${album.id}::uuid
            `;
            expect(rows[0].custom_metadata.needs_cover_art_fetch).toBeUndefined();
        });
    });

    describe('findTrackFileForAlbum', () => {
        it('returns a track file path for the album', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            const track = createTestTrack(album.id, 1);
            await insertTestAlbum(sql, album);
            await insertTestTrack(sql, track);

            const result = await findTrackFileForAlbum(sql, album.id);
            expect(result).not.toBeNull();
            expect(result?.filePath).toContain('.mp3');
            expect(result?.trackId).toBe(track.id);
        });

        it('returns null when album has no tracks', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);
            const album = createTestAlbum(artist.id);
            await insertTestAlbum(sql, album);

            const result = await findTrackFileForAlbum(sql, album.id);
            expect(result).toBeNull();
        });
    });
});
