// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { TEST_TABLES, truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { confirmArtistCredits, getArtistCreditReview } from './artist-credit-review.js';
import { deleteEmptyArtist } from '$lib/server/database/queries/artist-merge.queries.js';
import { listMusicEdits, undoMusicEdit } from './edit-recovery.js';
import { albumArtistSnapshot, saveAlbumArtist } from './album-artist-edit.js';
import {
    applyCollaboration,
    previewCollaboration,
    returnCollaborationToQueue,
} from './collaboration-review.js';

let sql: postgres.Sql;
async function item(type: string, title: string, parent: string | null = null): Promise<string> {
    const [row] = await sql<{ id: string }[]>`INSERT INTO media_items(media_type,title,parent_id)
        VALUES (${type},${title},${parent}) RETURNING id`;
    return row.id;
}
async function details(id: string): Promise<postgres.Row> {
    const [row] =
        await sql`SELECT parent_id,title_source,custom_metadata,metadata_locked,metadata_locked_by,
        metadata_locked_at::text FROM media_items WHERE id=${id}`;
    return row;
}
async function withFile(id: string, tag: string): Promise<void> {
    await sql`UPDATE media_items SET custom_metadata=jsonb_build_object('artist',${tag}::text) WHERE id=${id}`;
    const [file] = await sql<
        { id: string }[]
    >`INSERT INTO media_files(file_path) VALUES (${`/music/recovery/${id}.flac`}) RETURNING id`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${file.id},${id},true)`;
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

describe('durable music edit recovery', () => {
    it('restores exact credit order, source, membership, title provenance and lock actor/time; second Undo is idempotent', async () => {
        const a = await item('artist', 'Cedar');
        const b = await item('artist', 'Lumen');
        const owner = await item('artist', 'Quiet Assembly');
        const album = await item('album', 'Paper Harbour', owner);
        const track = await item('track', 'Glass Harbour', album);
        const beforeMeta = {
            artist: 'Cedar and Lumen',
            artist_credit_source: 'file',
            musicbrainz_artist_ids: ['f1010101-1010-4010-8010-101010101010'],
            track_artist_credits: [
                { id: a, credited_name: 'Cedar' },
                { id: b, credited_name: 'Lumen' },
            ],
            track_remixer_credits: [{ id: b, credited_name: 'Lumen remix' }],
            additional_artist_ids: [owner, b, a],
            file_artist_ids: [a, b],
            album_artist_ids: [owner],
            remixer_artist_ids: [b],
            independent_remixer_artist_ids: [b],
            title_remixer_artist_ids: [b],
            raw_artist_tags: { ARTIST: 'Cedar and Lumen' },
            genre: 'Fictional Ambient',
        };
        await sql`UPDATE media_items SET title_source='filename',custom_metadata=${sql.json(beforeMeta)},
            metadata_locked=true,metadata_locked_by='earlier curator',metadata_locked_at='2026-10-01 12:34:56.123456+00' WHERE id=${track}`;
        const before = await details(track);
        const ownerBefore = await details(album);
        const review = await getArtistCreditReview(sql, track);
        await confirmArtistCredits(sql, track, 'new curator', {
            snapshot: review.snapshot,
            credits: [
                { artist: { id: b, name: 'Lumen' }, creditedAs: 'Lumen guest', role: 'performer' },
                { artist: { id: a, name: 'Cedar' }, creditedAs: 'Cedar remix', role: 'remixer' },
            ],
        });
        expect((await details(track)).custom_metadata.artist_credit_source).toBe('manual');
        const [receipt] = await listMusicEdits(sql, track);
        expect(receipt.kind).toBe('credits');
        await undoMusicEdit(sql, track, receipt.id, 'curator');
        expect(await details(track)).toEqual(before);
        expect(await details(album)).toEqual(ownerBefore);
        const [version] =
            await sql`SELECT xmin::text AS version FROM media_items WHERE id=${track}`;
        await undoMusicEdit(sql, track, receipt.id, 'curator');
        expect(
            (await sql`SELECT xmin::text AS version FROM media_items WHERE id=${track}`)[0],
        ).toEqual(version);
        expect((await listMusicEdits(sql, track))[0].undone).toBe(true);
    });

    it('keeps new and subsequently shared artists and refuses stale or wrong-target Undo', async () => {
        const owner = await item('artist', 'Bramble');
        const album = await item('album', 'Night Paper', owner);
        const track = await item('track', 'First Lantern', album);
        const review = await getArtistCreditReview(sql, track);
        await confirmArtistCredits(sql, track, 'curator', {
            snapshot: review.snapshot,
            credits: [
                { artist: { newName: 'Oriole Field' }, creditedAs: 'Oriole', role: 'performer' },
            ],
        });
        const [created] = await sql<
            { id: string }[]
        >`SELECT id FROM media_items WHERE title='Oriole Field' AND media_type='artist'`;
        await item('album', 'Shared release', created.id);
        const [receipt] = await listMusicEdits(sql, track);
        await expect(undoMusicEdit(sql, album, receipt.id, 'curator')).rejects.toThrow(
            'no longer available',
        );
        await undoMusicEdit(sql, track, receipt.id, 'curator');
        expect(await sql`SELECT id FROM media_items WHERE id=${created.id}`).toHaveLength(1);
        const again = await getArtistCreditReview(sql, track);
        await confirmArtistCredits(sql, track, 'curator', {
            snapshot: again.snapshot,
            credits: [
                {
                    artist: { id: created.id, name: 'Oriole Field' },
                    creditedAs: 'Oriole',
                    role: 'performer',
                },
            ],
        });
        const [latest] = await listMusicEdits(sql, track);
        await sql`UPDATE media_items SET metadata_locked_by='another editor' WHERE id=${track}`;
        const current = await details(track);
        await expect(undoMusicEdit(sql, track, latest.id, 'curator')).rejects.toThrow(
            'changed since',
        );
        expect(await details(track)).toEqual(current);
    });

    it('saves album ownership once and restores parent and protection without deleting a newly shared artist', async () => {
        const owner = await item('artist', 'Juniper');
        const album = await item('album', 'Soft Almanac', owner);
        const before = await details(album);
        const snapshot = await albumArtistSnapshot(sql, album);
        const saved = await saveAlbumArtist(
            sql,
            album,
            'curator',
            { artistName: 'Copper Meadow' },
            snapshot,
        );
        expect((await details(album)).parent_id).toBe(saved.artistId);
        expect((await details(album)).metadata_locked).toBe(true);
        expect(await deleteEmptyArtist(sql, owner)).toBe(false);
        await item('album', 'Another release', saved.artistId);
        const [receipt] = await listMusicEdits(sql, album);
        await undoMusicEdit(sql, album, receipt.id, 'curator');
        expect(await details(album)).toEqual(before);
        expect(await sql`SELECT id FROM media_items WHERE id=${saved.artistId}`).toHaveLength(1);
        const stale = await albumArtistSnapshot(sql, album);
        await sql`UPDATE media_items SET title='Soft Almanac Revised' WHERE id=${album}`;
        await expect(
            saveAlbumArtist(sql, album, 'curator', { artistId: saved.artistId }, stale),
        ).rejects.toThrow('changed');
        expect((await details(album)).parent_id).toBe(owner);
    });

    it('saves a partial collaboration, retains unresolved locked/hidden tracks and atomically undoes the saved batch', async () => {
        const a = await item('artist', 'Fern');
        const b = await item('artist', 'Sable');
        const combined = await item('artist', 'Fern & Sable');
        const album = await item('album', 'River Paper', combined);
        const one = await item('track', 'One Window', album);
        const two = await item('track', 'Two Windows', album);
        const locked = await item('track', 'Protected Window', album);
        const hidden = await item('track', 'Hidden Window', album);
        for (const id of [one, two, locked, hidden]) await withFile(id, 'Fern & Sable');
        await sql`UPDATE media_items SET metadata_locked=true WHERE id=${locked}`;
        await sql`UPDATE media_items SET is_dismissed=true WHERE id=${hidden}`;
        const before = await Promise.all([one, two, locked, hidden, album, combined].map(details));
        const members = [
            { id: a, name: 'Fern' },
            { id: b, name: 'Sable' },
        ];
        const preview = await previewCollaboration(sql, combined, members);
        const result = await applyCollaboration(sql, combined, 'curator', {
            snapshot: preview.snapshot,
            members,
            trackIds: [one, two],
        });
        expect(result).toMatchObject({ changedTracks: 2, reviewed: false });
        expect(await details(locked)).toEqual(before[2]);
        expect(await details(hidden)).toEqual(before[3]);
        expect(await details(album)).toEqual(before[4]);
        const [receipt] = await listMusicEdits(sql, combined);
        expect(receipt.kind).toBe('collaboration');
        expect(await listMusicEdits(sql, one)).toEqual([]);
        await undoMusicEdit(sql, combined, receipt.id, 'curator');
        expect(await Promise.all([one, two, locked, hidden, album, combined].map(details))).toEqual(
            before,
        );
    });

    it('refuses the entire batch Undo after one track changes, and returning to cleanup never undoes credits', async () => {
        const a = await item('artist', 'Maple');
        const b = await item('artist', 'Ibis');
        const combined = await item('artist', 'Maple & Ibis');
        const album = await item('album', 'Distant Paper', combined);
        const one = await item('track', 'First', album);
        const two = await item('track', 'Second', album);
        for (const id of [one, two]) await withFile(id, 'Maple & Ibis');
        const members = [
            { id: a, name: 'Maple' },
            { id: b, name: 'Ibis' },
        ];
        const preview = await previewCollaboration(sql, combined, members);
        await applyCollaboration(sql, combined, 'curator', {
            snapshot: preview.snapshot,
            members,
            trackIds: [one, two],
        });
        const [receipt] = await listMusicEdits(sql, combined);
        await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"artist":"Retagged"}'::jsonb WHERE id=${two}`;
        const saved = await details(one);
        await expect(undoMusicEdit(sql, combined, receipt.id, 'curator')).rejects.toThrow(
            'changed since',
        );
        expect(await details(one)).toEqual(saved);
        await returnCollaborationToQueue(sql, combined, 'curator');
        expect(await details(one)).toEqual(saved);
        expect((await listMusicEdits(sql, combined))[0].undone).toBe(false);
    });
});
