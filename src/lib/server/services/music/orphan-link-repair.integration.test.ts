// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { TEST_TABLES, truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { repairOrphanMusicLinks } from './orphan-link-repair.js';
import { listMusicEdits, undoMusicEdit } from './edit-recovery.js';
let sql: postgres.Sql;
async function item(type: string, title: string, parent: string | null = null): Promise<string> {
    const [row] = await sql<
        { id: string }[]
    >`INSERT INTO media_items(media_type,title,parent_id) VALUES (${type},${title},${parent}) RETURNING id`;
    return row.id;
}
async function source(parent: string | null, album: string, artist: string): Promise<string> {
    const id = await item('track', 'Invented Window', parent);
    await sql`UPDATE media_items SET custom_metadata=${sql.json({ album, album_artist: artist, artist: 'Different Performer' })} WHERE id=${id}`;
    const [file] = await sql<
        { id: string }[]
    >`INSERT INTO media_files(file_path,is_missing) VALUES (${`/invented/${id}.flac`},false) RETURNING id`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${file.id},${id},true)`;
    return id;
}
async function parent(id: string): Promise<string | null> {
    return (
        await sql<{ parent_id: string | null }[]>`SELECT parent_id FROM media_items WHERE id=${id}`
    )[0].parent_id;
}
beforeAll(() => {
    sql = getTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
});
afterAll(async () => {
    await closeTestDb();
});
describe('unambiguous orphan music links', () => {
    it('fills only a missing album owner from unanimous tags and saves exact Undo; Undo prevents repeating the same decision', async () => {
        const artist = await item('artist', 'Wicker Assembly');
        const album = await item('album', 'Dawn Notebook');
        await source(album, 'Dawn Notebook', 'Wicker Assembly');
        await source(album, 'Dawn Notebook', 'Wicker Assembly');
        expect(await repairOrphanMusicLinks(sql)).toBe(1);
        expect(await parent(album)).toBe(artist);
        expect(
            (await sql`SELECT metadata_locked FROM media_items WHERE id=${album}`)[0]
                .metadata_locked,
        ).toBe(false);
        const [receipt] = await listMusicEdits(sql, album);
        expect(receipt.kind).toBe('hierarchy');
        await undoMusicEdit(sql, album, receipt.id, 'curator');
        expect(await parent(album)).toBeNull();
        expect(await repairOrphanMusicLinks(sql)).toBe(0);
        const next = await item('artist', 'Ochre Assembly');
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"album_artist":"Ochre Assembly"}'::jsonb WHERE parent_id=${album}`;
        expect(await repairOrphanMusicLinks(sql)).toBe(1);
        expect(await parent(album)).toBe(next);
    });
    it('links an orphan track to one existing tagged album and does not create or delete identities', async () => {
        const artist = await item('artist', 'North Loom');
        const album = await item('album', 'Small Letters', artist);
        const track = await source(null, 'Small Letters', 'North Loom');
        const before = await sql`SELECT id FROM media_items ORDER BY id`;
        expect(await repairOrphanMusicLinks(sql)).toBe(1);
        expect(await parent(track)).toBe(album);
        expect(await sql`SELECT id FROM media_items ORDER BY id`).toEqual(before);
        const [receipt] = await listMusicEdits(sql, track);
        await undoMusicEdit(sql, track, receipt.id, 'curator');
        expect(await parent(track)).toBeNull();
        expect(await parent(album)).toBe(artist);
    });
    it.each([
        'disagree',
        'plural',
        'locked',
        'hidden',
        'missing',
        'different-scope',
        'performer-only',
        'musicbrainz-owner',
        'release-conflict',
    ] as const)('abstains when source/identity evidence is %s', async (reason) => {
        const artist = await item('artist', 'Moss Assembly');
        const album = await item('album', 'Written Sky');
        const first = await source(album, 'Written Sky', 'Moss Assembly');
        const second = await source(album, 'Written Sky', 'Moss Assembly');
        if (reason === 'disagree')
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"album_artist":"Another Assembly"}'::jsonb WHERE id=${second}`;
        if (reason === 'plural')
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"album_artists":["Moss Assembly","Another Assembly"]}'::jsonb WHERE id=${first}`;
        if (reason === 'locked')
            await sql`UPDATE media_items SET metadata_locked=true WHERE id=${first}`;
        if (reason === 'hidden')
            await sql`UPDATE media_items SET is_dismissed=true WHERE id=${first}`;
        if (reason === 'missing') await sql`UPDATE media_files SET is_missing=true`;
        if (reason === 'musicbrainz-owner') {
            await sql`UPDATE media_items SET custom_metadata='{"musicbrainz_artist_id":"10000000-0000-4000-8000-000000000001"}'::jsonb WHERE id=${artist}`;
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"musicbrainz_album_artist_ids":["10000000-0000-4000-8000-000000000002"]}'::jsonb WHERE id=${first}`;
        }
        if (reason === 'release-conflict') {
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || jsonb_build_object('musicbrainz_album_id',id::text) WHERE id=ANY(${[first, second]}::uuid[])`;
        }
        if (reason === 'performer-only')
            await sql`UPDATE media_items SET custom_metadata=custom_metadata-'album_artist' WHERE id=${first}`;
        if (reason === 'different-scope') {
            const [group] = await sql<
                { id: string }[]
            >`INSERT INTO library_groups(name) VALUES ('Invented Other Library') RETURNING id`;
            await sql`UPDATE media_items SET library_group_id=${group.id} WHERE id=${artist}`;
        }
        expect(await repairOrphanMusicLinks(sql)).toBe(0);
        expect(await parent(album)).toBeNull();
        expect(await listMusicEdits(sql, album)).toEqual([]);
    });
    it('accepts agreeing explicit provider identities without creating identities', async () => {
        const artist = await item('artist', 'Willow Assembly');
        const album = await item('album', 'Woven Almanac');
        const first = await source(album, 'Woven Almanac', 'Willow Assembly');
        await sql`UPDATE media_items SET custom_metadata='{"musicbrainz_artist_id":"10000000-0000-4000-8000-000000000001"}'::jsonb WHERE id=${artist}`;
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"musicbrainz_album_artist_ids":["10000000-0000-4000-8000-000000000001"]}'::jsonb WHERE id=${first}`;
        expect(await repairOrphanMusicLinks(sql)).toBe(1);
        expect(await parent(album)).toBe(artist);
    });

    it('walks past an ambiguous first page and honors cancellation', async () => {
        for (let i = 0; i < 65; i++)
            await sql`INSERT INTO media_items(id,media_type,title) VALUES
            (${'00000000-0000-4000-8000-' + String(i).padStart(12, '0')},'track',${'Unresolved Window ' + i})`;
        const artist = await item('artist', 'Late Assembly');
        const album = await item('album', 'Late Notebook');
        await source(album, 'Late Notebook', 'Late Assembly');
        expect(await repairOrphanMusicLinks(sql, () => true)).toBe(0);
        expect(await parent(album)).toBeNull();
        expect(await repairOrphanMusicLinks(sql)).toBe(1);
        expect(await parent(album)).toBe(artist);
    });
});
