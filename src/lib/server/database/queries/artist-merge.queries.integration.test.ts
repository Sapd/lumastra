// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Artist Merge Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgresClient from 'postgres';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
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
    findCollaborationArtists,
    getTrackIdsForArtist,
    getAlbumsForArtist,
    findDuplicateAlbumByTitle,
    reparentTracksToAlbum,
    deleteEmptyAlbum,
    reparentAlbumToArtist,
    mergeAdditionalArtistIds,
    replaceArtistIdInTracks,
    remapAdditionalArtistId,
    deleteEmptyArtist,
} from './artist-merge.queries.js';

describe('Artist Merge Queries', () => {
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

    describe('findCollaborationArtists', () => {
        it('finds artists with collaboration markers', async () => {
            const artist = createTestArtist({ title: 'Artist feat. Guest' });
            await insertTestArtist(sql, artist);

            const rows = await findCollaborationArtists(sql);
            expect(rows.some((r) => r.id === artist.id)).toBe(true);
        });

        it('finds " x " collab credits (EDM/pop style)', async () => {
            const artist = createTestArtist({
                title: 'Liora Vale x Lantern Pitch x Lanternlovers United',
            });
            await insertTestArtist(sql, artist);

            const rows = await findCollaborationArtists(sql);
            expect(rows.some((r) => r.id === artist.id)).toBe(true);
        });

        it('does not match an unflanked "x" inside a name', async () => {
            const artist = createTestArtist({ title: 'Lanternxman' });
            await insertTestArtist(sql, artist);

            const rows = await findCollaborationArtists(sql);
            expect(rows.some((r) => r.id === artist.id)).toBe(false);
        });

        it('does not return plain artist names', async () => {
            const artist = createTestArtist({ title: 'Solo Artist' });
            await insertTestArtist(sql, artist);

            const rows = await findCollaborationArtists(sql);
            expect(rows.some((r) => r.id === artist.id)).toBe(false);
        });
    });

    describe('getTrackIdsForArtist', () => {
        it('returns track IDs under an artist', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            const track = createTestTrack(album.id, 1);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await insertTestTrack(sql, track);

            const ids = await getTrackIdsForArtist(sql, artist.id);
            expect(ids).toContain(track.id);
        });
    });

    describe('getAlbumsForArtist', () => {
        it('returns albums for an artist', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const rows = await getAlbumsForArtist(sql, artist.id);
            expect(rows.length).toBe(1);
            expect(rows[0].id).toBe(album.id);
        });
    });

    describe('findDuplicateAlbumByTitle', () => {
        it('finds album with normalized matching title', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id, {
                title: 'Greatest Hits',
            });
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const dupId = await findDuplicateAlbumByTitle(sql, artist.id, 'greatest hits!');
            expect(dupId).toBe(album.id);
        });

        it('returns null when no match', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);

            const dupId = await findDuplicateAlbumByTitle(sql, artist.id, 'Nothing');
            expect(dupId).toBeNull();
        });

        it('never treats two different non-Latin titles as duplicates', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id, { title: '愛' });
            const deluxe = createTestAlbum(artist.id, { title: 'Любовь (Deluxe)' });
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await insertTestAlbum(sql, deluxe);

            expect(await findDuplicateAlbumByTitle(sql, artist.id, '夢')).toBeNull();
            expect(await findDuplicateAlbumByTitle(sql, artist.id, 'Мечта (Deluxe)')).toBeNull();
            expect(await findDuplicateAlbumByTitle(sql, artist.id, '愛')).toBe(album.id);
            expect(await findDuplicateAlbumByTitle(sql, artist.id, 'любовь deluxe')).toBe(
                deluxe.id,
            );
        });

        it('keeps accented letters (Café ≠ Caf) but ignores punctuation and spacing', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id, { title: 'Café - Live' });
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            expect(await findDuplicateAlbumByTitle(sql, artist.id, 'café live')).toBe(album.id);
            expect(await findDuplicateAlbumByTitle(sql, artist.id, 'Caf Live')).toBeNull();
        });

        it('ignores typographic punctuation; a punctuation-only title matches only itself', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id, { title: 'Don’t Stop – Live' });
            const dots = createTestAlbum(artist.id, { title: '...' });
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await insertTestAlbum(sql, dots);

            expect(await findDuplicateAlbumByTitle(sql, artist.id, "Don't Stop - Live")).toBe(
                album.id,
            );
            expect(await findDuplicateAlbumByTitle(sql, artist.id, '...')).toBe(dots.id);
            expect(await findDuplicateAlbumByTitle(sql, artist.id, '???')).toBeNull();
        });
    });

    describe('reparentTracksToAlbum', () => {
        it('moves tracks from one album to another', async () => {
            const artist = createTestArtist();
            const album1 = createTestAlbum(artist.id);
            const album2 = createTestAlbum(artist.id);
            const track = createTestTrack(album1.id, 1);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album1);
            await insertTestAlbum(sql, album2);
            await insertTestTrack(sql, track);

            await reparentTracksToAlbum(sql, album1.id, album2.id);

            const rows = await sql`
                SELECT parent_id FROM media_items WHERE id = ${track.id}::uuid
            `;
            expect(rows[0].parent_id).toBe(album2.id);
        });
    });

    describe('deleteEmptyAlbum', () => {
        it('deletes album with no tracks', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const deleted = await deleteEmptyAlbum(sql, album.id);
            expect(deleted).toBe(true);
        });

        it('does not delete album with tracks', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            const track = createTestTrack(album.id, 1);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await insertTestTrack(sql, track);

            const deleted = await deleteEmptyAlbum(sql, album.id);
            expect(deleted).toBe(false);
        });
    });

    describe('reparentAlbumToArtist', () => {
        it('changes album parent_id', async () => {
            const artist1 = createTestArtist();
            const artist2 = createTestArtist();
            const album = createTestAlbum(artist1.id);
            await insertTestArtist(sql, artist1);
            await insertTestArtist(sql, artist2);
            await insertTestAlbum(sql, album);

            await reparentAlbumToArtist(sql, album.id, artist2.id);

            const rows = await sql`
                SELECT parent_id FROM media_items WHERE id = ${album.id}::uuid
            `;
            expect(rows[0].parent_id).toBe(artist2.id);
        });
    });

    describe('mergeAdditionalArtistIds', () => {
        it('appends additional artist IDs to track custom_metadata', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            const track = createTestTrack(album.id, 1);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await insertTestTrack(sql, track);

            const extraId = crypto.randomUUID();
            await mergeAdditionalArtistIds(sql, track.id, [extraId]);

            const rows = await sql`
                SELECT custom_metadata FROM media_items WHERE id = ${track.id}::uuid
            `;
            expect(rows[0].custom_metadata.additional_artist_ids).toContain(extraId);
        });

        it('does not write locked tracks', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            const track = createTestTrack(album.id, 1);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await insertTestTrack(sql, track);
            await sql`UPDATE media_items SET metadata_locked=true WHERE id=${track.id}`;
            const [before] =
                await sql`SELECT custom_metadata FROM media_items WHERE id=${track.id}`;
            expect(await mergeAdditionalArtistIds(sql, track.id, [crypto.randomUUID()])).toBe(
                false,
            );
            const [after] = await sql`SELECT custom_metadata FROM media_items WHERE id=${track.id}`;
            expect(after.custom_metadata).toEqual(before.custom_metadata);
        });

        it('merges against a concurrent committed edit after waiting for the row lock', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            const track = createTestTrack(album.id, 1);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await insertTestTrack(sql, track);
            const first = crypto.randomUUID();
            const second = crypto.randomUUID();
            const writer = postgresClient(getTestDatabaseUrl(), { max: 1 });
            const scanner = postgresClient(getTestDatabaseUrl(), { max: 1 });
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            let entered!: () => void;
            const acquired = new Promise<void>((resolve) => {
                entered = resolve;
            });
            try {
                const transaction = writer.begin(async (tx) => {
                    await tx`UPDATE media_items SET custom_metadata=jsonb_set(COALESCE(custom_metadata,'{}'::jsonb),
                        '{additional_artist_ids}', ${tx.json([first])}) WHERE id=${track.id}`;
                    entered();
                    await held;
                });
                await acquired;
                const merging = mergeAdditionalArtistIds(scanner, track.id, [second]);
                release();
                await transaction;
                expect(await merging).toBe(true);
                const [row] = await sql<{ ids: string[] }[]>`
                    SELECT custom_metadata->'additional_artist_ids' AS ids FROM media_items WHERE id=${track.id}`;
                expect(row.ids).toEqual([first, second]);
            } finally {
                release();
                await writer.end();
                await scanner.end();
            }
        });
    });

    describe('replaceArtistIdInTracks', () => {
        it('replaces old artist ID with new in additional_artist_ids', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            const track = createTestTrack(album.id, 1);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await insertTestTrack(sql, track);

            const oldId = crypto.randomUUID();
            const newId = crypto.randomUUID();
            await mergeAdditionalArtistIds(sql, track.id, [oldId]);
            await replaceArtistIdInTracks(sql, oldId, newId);

            const rows = await sql`
                SELECT custom_metadata FROM media_items WHERE id = ${track.id}::uuid
            `;
            expect(rows[0].custom_metadata.additional_artist_ids).not.toContain(oldId);
            expect(rows[0].custom_metadata.additional_artist_ids).toContain(newId);
        });

        it('remaps remixer credits but keeps locked credits byte-identical', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            const unlocked = createTestTrack(album.id, 1);
            const locked = createTestTrack(album.id, 2);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);
            await insertTestTrack(sql, unlocked);
            await insertTestTrack(sql, locked);
            const oldId = crypto.randomUUID();
            const newId = crypto.randomUUID();
            const credits = [{ id: oldId, credited_name: 'A', source: 'tag' }];
            const metadata = { track_remixer_credits: credits, remixer_artist_ids: [oldId] };
            await sql`UPDATE media_items SET custom_metadata=${sql.json(metadata)} WHERE id=ANY(${[unlocked.id, locked.id]}::uuid[])`;
            await sql`UPDATE media_items SET metadata_locked=true WHERE id=${locked.id}`;
            await replaceArtistIdInTracks(sql, oldId, newId);
            const rows = await sql<{ id: string; custom_metadata: typeof metadata }[]>`
                SELECT id,custom_metadata FROM media_items WHERE id=ANY(${[unlocked.id, locked.id]}::uuid[])`;
            const byId = new Map(rows.map((row) => [row.id, row.custom_metadata]));
            expect(byId.get(unlocked.id)?.track_remixer_credits).toEqual([
                { id: newId, credited_name: 'A', source: 'tag' },
            ]);
            expect(byId.get(unlocked.id)?.remixer_artist_ids).toEqual([newId]);
            expect(byId.get(locked.id)).toEqual(metadata);
        });
    });

    describe('deleteEmptyArtist', () => {
        it('deletes artist with no albums', async () => {
            const artist = createTestArtist();
            await insertTestArtist(sql, artist);

            const deleted = await deleteEmptyArtist(sql, artist.id);
            expect(deleted).toBe(true);
        });

        it('does not delete artist with albums', async () => {
            const artist = createTestArtist();
            const album = createTestAlbum(artist.id);
            await insertTestArtist(sql, artist);
            await insertTestAlbum(sql, album);

            const deleted = await deleteEmptyArtist(sql, artist.id);
            expect(deleted).toBe(false);
        });
    });
    describe('remapAdditionalArtistId', () => {
        async function track(meta: Record<string, unknown>, locked: boolean): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, metadata_locked, custom_metadata)
                VALUES (${id}::uuid, ${'t ' + id.slice(0, 6)}, 'track', 'active', ${locked}, ${sql.json(meta as never)})
            `;
            return id;
        }
        const idsOf = async (id: string): Promise<string[]> => {
            const [row] = await sql<{ ids: string[] }[]>`
                SELECT ARRAY(SELECT jsonb_array_elements_text(custom_metadata->'additional_artist_ids')) AS ids
                FROM media_items WHERE id = ${id}::uuid
            `;
            return row.ids;
        };

        it('remaps on locked and unlocked tracks, keeping order and collapsing repeats', async () => {
            const [a, b, keep] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
            const locked = await track({ additional_artist_ids: [a, b, keep] }, true);
            const open = await track({ additional_artist_ids: [keep, a, b] }, false);
            const untouched = await track({ additional_artist_ids: [b] }, false);

            expect(await remapAdditionalArtistId(sql, a, keep)).toBe(2);
            expect(await idsOf(locked)).toEqual([keep, b]);
            expect(await idsOf(open)).toEqual([keep, b]);
            expect(await idsOf(untouched)).toEqual([b]);
        });

        it('drops the id when no replacement is given', async () => {
            const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
            const locked = await track({ additional_artist_ids: [a, b] }, true);
            expect(await remapAdditionalArtistId(sql, a, null)).toBe(1);
            expect(await idsOf(locked)).toEqual([b]);
        });
    });
});
