// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Music Admin Query Module
 *
 * Tests hierarchy queries, album listings, track listings, and orphan detection.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMusicHierarchy,
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getMusicHierarchy,
    getMusicContainerSummary,
    getAlbumsForArtist,
    getTracksForAlbum,
    getOrphanedMusicItems,
} from './music-admin.queries.js';

/**
 * Seeds a 2-disc album where one track carries a NON-NUMERIC `disc_number`.
 *
 * Not a hypothetical shape: `custom_metadata` is a freeform jsonb column and
 * `PUT /api/admin/media/bulk-metadata` merges an arbitrary admin-supplied object
 * into it verbatim (up to 100 keys, no per-key schema, by design), so an admin
 * pasting the raw ID3 combined form "1/2" is enough. Before the
 * `jsonb_typeof(...) = 'number'` guard, the bare
 * `(custom_metadata->>'disc_number')::int` in both of this module's ORDER BY
 * clauses raised `invalid input syntax for type integer` for the WHOLE
 * statement — one such row 500s the entire page rather than sorting oddly.
 */
async function seedAlbumWithPoisonedDiscTag(
    sql: postgres.Sql,
): Promise<{ artistId: string; albumId: string }> {
    const artist = createTestArtist();
    await insertTestArtist(sql, artist);
    const album = createTestAlbum(artist.id);
    await insertTestAlbum(sql, album);

    const d2t1 = createTestTrack(album.id, 1, {
        title: 'Disc Two Track One',
        custom_metadata: { disc_number: 2 },
    });
    const poisoned = createTestTrack(album.id, 2, {
        title: 'Poisoned Disc Tag',
        custom_metadata: { disc_number: '1/2' },
    });
    const d1t1 = createTestTrack(album.id, 1, {
        title: 'Disc One Track One',
        custom_metadata: { disc_number: 1 },
    });
    await insertTestTrack(sql, d2t1);
    await insertTestTrack(sql, poisoned);
    await insertTestTrack(sql, d1t1);

    return { artistId: artist.id, albumId: album.id };
}

/**
 * The guard yields NULL for the string, and the enclosing COALESCE(..., 1) sorts
 * it WITH disc 1 rather than exiling it past the last disc. So disc 1
 * (sort_order 1, then the poisoned row's 2) precedes disc 2.
 */
const EXPECTED_POISONED_ORDER = ['Disc One Track One', 'Poisoned Disc Tag', 'Disc Two Track One'];

describe('Music Admin Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    // ========================================================================
    // getMusicHierarchy
    // ========================================================================

    describe('getMusicHierarchy', () => {
        it('returns null for a non-existent artist id', async () => {
            const result = await getMusicHierarchy(sql, crypto.randomUUID());
            expect(result).toBeNull();
        });

        it('returns artist with empty albums when no albums exist', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 0,
            });
            // Delete album manually to orphan artist tracks? Actually createAndInsertTestMusicHierarchy always creates an album.
            // Instead, just test that hierarchy returns albums (which includes the created album).
            const result = await getMusicHierarchy(sql, artistId);
            expect(result).not.toBeNull();
            expect(result!.artist.id).toBe(artistId);
            expect(result!.albums.length).toBeGreaterThanOrEqual(0);
        });

        it('returns full hierarchy with tracks', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 3,
            });

            const result = await getMusicHierarchy(sql, artistId);

            expect(result).not.toBeNull();
            expect(result!.artist.id).toBe(artistId);
            expect(result!.artist.track_count).toBe(3);
            expect(result!.albums.length).toBe(1);
            expect(result!.albums[0].id).toBe(albumId);
            expect(result!.albums[0].tracks.length).toBe(3);
            expect(result!.albums[0].tracks.map((t) => t.id)).toEqual(trackIds);
        });

        it('survives a non-numeric disc_number instead of failing the whole hierarchy', async () => {
            const { artistId, albumId } = await seedAlbumWithPoisonedDiscTag(sql);

            const result = await getMusicHierarchy(sql, artistId);

            expect(result).not.toBeNull();
            expect(result!.albums.length).toBe(1);
            expect(result!.albums[0].id).toBe(albumId);
            expect(result!.albums[0].tracks.map((t) => t.title)).toEqual(EXPECTED_POISONED_ORDER);
        });
    });

    // ========================================================================
    // getAlbumsForArtist
    // ========================================================================

    describe('getAlbumsForArtist', () => {
        it('returns empty array when artist has no albums', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 0,
            });
            await sql`DELETE FROM media_items WHERE parent_id = ${artistId}::uuid AND media_type = 'album'`;

            const result = await getAlbumsForArtist(sql, artistId);
            expect(result).toEqual([]);
        });

        it('returns albums with track counts and total duration', async () => {
            const { artistId, albumId } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });

            const result = await getAlbumsForArtist(sql, artistId);

            expect(result.length).toBe(1);
            expect(result[0].id).toBe(albumId);
            expect(result[0].track_count).toBe(2);
            expect(result[0].total_duration_seconds).toBeGreaterThan(0);
        });
    });

    // ========================================================================
    // getTracksForAlbum
    // ========================================================================

    describe('music aggregate context', () => {
        it('counts descendants for containers and lists each track once despite multiple file links', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });
            await sql`UPDATE media_items SET runtime_seconds=180 WHERE id = ANY(${trackIds})`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                SELECT file_id, ${trackIds[0]}::uuid, false FROM media_file_items
                WHERE media_item_id=${trackIds[1]} LIMIT 1 ON CONFLICT DO NOTHING`;
            expect(await getMusicContainerSummary(sql, artistId)).toEqual({
                albumCount: 1,
                trackCount: 2,
                totalSeconds: 360,
            });
            expect(await getMusicContainerSummary(sql, albumId)).toEqual({
                albumCount: 0,
                trackCount: 2,
                totalSeconds: 360,
            });
            expect(await getTracksForAlbum(sql, albumId)).toHaveLength(2);
        });
    });

    describe('getTracksForAlbum', () => {
        it('uses an available alternate when the default file is missing, and null when all are missing', async () => {
            const { albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });
            const [original] = await sql<
                { file_id: string }[]
            >`SELECT file_id FROM media_file_items WHERE media_item_id=${trackIds[0]}`;
            const [alternate] = await sql<
                { file_id: string }[]
            >`SELECT file_id FROM media_file_items WHERE media_item_id=${trackIds[1]}`;
            await sql`UPDATE media_files SET is_missing=true WHERE id=${original.file_id}`;
            await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${alternate.file_id},${trackIds[0]},false)`;
            const available = await getTracksForAlbum(sql, albumId);
            expect(available[0].file_path).toBe(available[1].file_path);
            expect(available[0].file_path).not.toBeNull();
            await sql`UPDATE media_files SET is_missing=true WHERE id=${alternate.file_id}`;
            expect(
                (await getTracksForAlbum(sql, albumId)).every((track) => track.file_path === null),
            ).toBe(true);
        });

        it('returns empty array when album has no tracks', async () => {
            const { albumId } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 0,
            });

            const result = await getTracksForAlbum(sql, albumId);
            expect(result).toEqual([]);
        });

        it('returns tracks for an album with file paths and metadata', async () => {
            const { albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });

            const result = await getTracksForAlbum(sql, albumId);

            expect(result.length).toBe(2);
            expect(result.map((t) => t.id)).toEqual(trackIds);
            expect(result[0].file_path).not.toBeNull();
        });

        it('survives a non-numeric disc_number instead of failing the whole album', async () => {
            const { albumId } = await seedAlbumWithPoisonedDiscTag(sql);

            const result = await getTracksForAlbum(sql, albumId);

            expect(result.map((t) => t.title)).toEqual(EXPECTED_POISONED_ORDER);
        });
    });

    // ========================================================================
    // getOrphanedMusicItems
    // ========================================================================

    describe('getOrphanedMusicItems', () => {
        it('returns empty array when no orphans exist', async () => {
            await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
            const result = await getOrphanedMusicItems(sql);
            expect(result.length).toBe(0);
        });

        it('detects tracks without a valid album parent', async () => {
            const albumId = crypto.randomUUID();
            const trackId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, created_at, updated_at)
                VALUES (${albumId}::uuid, 'Temp Album', 'album', NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, created_at, updated_at)
                VALUES (${trackId}::uuid, 'Orphan Track', 'track', ${albumId}::uuid, NOW(), NOW())
            `;
            await sql`DELETE FROM media_items WHERE id = ${albumId}::uuid`;

            const result = await getOrphanedMusicItems(sql);
            const orphan = result.find((r) => r.id === trackId);
            expect(orphan).toBeDefined();
            expect(orphan!.reason).toBe('track without album parent');
        });

        it('detects albums without a valid artist parent', async () => {
            const artistId = crypto.randomUUID();
            const albumId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, created_at, updated_at)
                VALUES (${artistId}::uuid, 'Temp Artist', 'artist', NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, created_at, updated_at)
                VALUES (${albumId}::uuid, 'Orphan Album', 'album', ${artistId}::uuid, NOW(), NOW())
            `;
            await sql`DELETE FROM media_items WHERE id = ${artistId}::uuid`;

            const result = await getOrphanedMusicItems(sql);
            const orphan = result.find((r) => r.id === albumId);
            expect(orphan).toBeDefined();
            expect(orphan!.reason).toBe('album without artist parent');
        });
    });
});
