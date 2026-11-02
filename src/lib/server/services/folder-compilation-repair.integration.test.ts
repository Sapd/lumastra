// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateMusicArtist } from '../database/queries/media-items.queries.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { previewFolderCompilations } from './folder-compilation-repair.js';
import { findExistingFolderAlbum } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/album-folder-resolver.js';
import { alignFolderAlbumParent } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/album-artist-evidence.js';

let db: postgres.Sql;
const rollback = new Error('rollback fixture');
async function fixture(
    run: (sql: postgres.Sql, albums: string[], tracks: string[]) => Promise<void>,
): Promise<void> {
    await db
        .begin(async (raw) => {
            const sql = raw as unknown as postgres.Sql;
            const albums: string[] = [];
            const tracks: string[] = [];
            for (let i = 0; i < 3; i++) {
                const [artist] = await sql<
                    { id: string }[]
                >`INSERT INTO media_items (title,media_type) VALUES (${`Cobalt Weaver ${i}`},'artist') RETURNING id`;
                const [album] = await sql<
                    { id: string }[]
                >`INSERT INTO media_items (title,media_type,parent_id,created_at) VALUES ('Velvet Observatory','album',${artist.id},'2020-01-01'::timestamptz + make_interval(secs=>${i})) RETURNING id`;
                const [track] = await sql<
                    { id: string }[]
                >`INSERT INTO media_items (title,media_type,parent_id,custom_metadata)
                VALUES (${`Lantern Song ${i}`},'track',${album.id},${sql.json({ album: 'Velvet Observatory', artist: `Cobalt Weaver ${i}`, album_artist: `Cobalt Weaver ${i}`, track_number: i + 1 })}) RETURNING id`;
                const [file] = await sql<
                    { id: string }[]
                >`INSERT INTO media_files (file_path,is_missing) VALUES (${`/invented/Velvet Observatory/CD${i + 1}/song.mp3`},false) RETURNING id`;
                await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${track.id},true)`;
                albums.push(album.id);
                tracks.push(track.id);
            }
            await run(sql, albums, tracks);
            throw rollback;
        })
        .catch((error: unknown) => {
            if (error !== rollback) throw error;
        });
}

describe('automatic folder compilation repair', () => {
    beforeAll(() => {
        db = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('previews a many-way release deterministically without deleting albums or moving tracks', async () => {
        await fixture(async (sql, albums, tracks) => {
            const before =
                await sql`SELECT id,parent_id,custom_metadata FROM media_items ORDER BY id`;
            const first = await previewFolderCompilations(sql, albums[0]);
            const second = await previewFolderCompilations(sql, albums[2]);
            expect(first).toEqual(second);
            expect(first.groups).toHaveLength(1);
            expect(first.groups[0].albums.map((row) => row.id)).toEqual(albums);
            expect(first.groups[0].trackCount).toBe(3);
            expect(
                await sql`SELECT id,parent_id,custom_metadata FROM media_items ORDER BY id`,
            ).toEqual(before);
            expect(
                await sql`SELECT id FROM media_items WHERE id=ANY(${tracks}::uuid[])`,
            ).toHaveLength(3);
        });
    });
    it('does not show another folder as the selected album release', async () => {
        await fixture(async (sql, albums, tracks) => {
            // With only two remaining performers, explicit compilation tags are
            // required by the existing album-artist rule; names alone are too weak.
            await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"compilation":true}'::jsonb WHERE id=ANY(${tracks.slice(0, 2)}::uuid[])`;
            await sql`UPDATE media_files SET file_path='/invented/Other Release/solo.flac' WHERE id IN
                (SELECT file_id FROM media_file_items WHERE media_item_id=${tracks[2]})`;
            expect((await previewFolderCompilations(sql, albums[0])).groups).toHaveLength(1);
            expect((await previewFolderCompilations(sql, albums[2])).groups).toEqual([]);
        });
    });

    it.each(['different-folder', 'distinct-edition', 'missing-file', 'locked'] as const)(
        'does not propose a title-only compilation with %s evidence',
        async (reason) => {
            await fixture(async (sql, albums, tracks) => {
                if (reason === 'different-folder')
                    await sql`UPDATE media_files SET file_path=file_path || '/' || id::text`;
                if (reason === 'distinct-edition')
                    await sql`UPDATE media_items SET custom_metadata=custom_metadata || jsonb_build_object('musicbrainz_album_id',id::text) WHERE id=ANY(${albums}::uuid[])`;
                if (reason === 'missing-file') await sql`UPDATE media_files SET is_missing=true`;
                if (reason === 'locked')
                    await sql`UPDATE media_items SET metadata_locked=true WHERE id=ANY(${albums}::uuid[])`;
                expect((await previewFolderCompilations(sql, albums[0])).groups).toEqual([]);
                expect(
                    await sql`SELECT id FROM media_items WHERE id=ANY(${albums}::uuid[])`,
                ).toHaveLength(3);
                expect(
                    await sql`SELECT id,parent_id FROM media_items WHERE id=ANY(${tracks}::uuid[]) ORDER BY id`,
                ).toEqual(
                    tracks
                        .map((id, index) => ({ id, parent_id: albums[index] }))
                        .sort((a, b) => a.id.localeCompare(b.id)),
                );
            });
        },
    );

    it('reuses a folder fragment despite different credits, but rejects conflicts across all candidates', async () => {
        await fixture(async (sql, albums, tracks) => {
            const lookup = (): Promise<string | null> =>
                findExistingFolderAlbum(
                    sql,
                    '/invented/Velvet Observatory',
                    'Velvet Observatory',
                    { album: 'Velvet Observatory', artist: 'Amber Current' },
                    null,
                    undefined,
                    true,
                    false,
                    true,
                );
            expect(await lookup()).toBe(albums[0]);
            for (const id of tracks)
                await sql`UPDATE media_items SET custom_metadata=custom_metadata || jsonb_build_object('musicbrainz_album_id',${randomUUID()}::text) WHERE id=${id}`;
            expect(await lookup()).toBe(null);
        });
    });

    it('keeps a locked track under its existing album artist during scanner parent alignment', async () => {
        await fixture(async (sql, albums, tracks) => {
            const va = await findOrCreateMusicArtist(sql, { name: 'Various Artists' });
            const before = await sql`SELECT parent_id FROM media_items WHERE id=${albums[0]}`;
            await sql`UPDATE media_items SET metadata_locked=true WHERE id=${tracks[0]}`;
            expect(await alignFolderAlbumParent(sql, albums[0], va, 'track-artists')).toBe(
                albums[0],
            );
            expect(await sql`SELECT parent_id FROM media_items WHERE id=${albums[0]}`).toEqual(
                before,
            );
        });
    });
});
