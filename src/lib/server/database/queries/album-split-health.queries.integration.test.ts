// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { placeInLibraryGroup } from '../../../../../tests/integration/fixtures/library-access.fixtures.js';
import { refreshSplitAlbumHealth, listSplitAlbumHealth } from './album-split-health.queries.js';

let db: postgres.Sql;
const rollback = new Error('rollback fixture');
beforeAll(() => {
    db = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});

describe('bounded split album health scan', () => {
    it('probes peers outside the batch, advances its cursor and clears findings when a tag changes', async () => {
        try {
            await db.begin(async (raw) => {
                const sql = raw as unknown as postgres.Sql;
                await sql`DELETE FROM album_split_health_pairs`;
                await sql`UPDATE album_split_health_cursor SET after_id=NULL`;
                const [group] = await sql<
                    { id: string }[]
                >`INSERT INTO library_groups(name) VALUES (${crypto.randomUUID()}) RETURNING id`;
                const [artist] = await sql<
                    { id: string }[]
                >`INSERT INTO media_items(title,media_type) VALUES (${crypto.randomUUID()},'artist') RETURNING id`;
                const albums = Array.from({ length: 105 }, (_, n) => ({
                    id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
                    title: `Batch album ${n}`,
                    media_type: 'album',
                    parent_id: artist.id,
                }));
                await sql`INSERT INTO media_items ${sql(albums)}`;
                const a = albums[0].id,
                    b = albums[104].id;
                const trackIds: string[] = [];
                for (const [album, folder] of [
                    [a, 'CD 1'],
                    [b, 'Disc2'],
                ]) {
                    const [track] = await sql<
                        { id: string }[]
                    >`INSERT INTO media_items(title,media_type,parent_id,custom_metadata)
                        VALUES ('Batch track','track',${album},'{"album":" Shared_Album ","album_artist":" Shared_Artist "}'::jsonb) RETURNING id`;
                    trackIds.push(track.id);
                    const { fileId } = await placeInLibraryGroup(sql, {
                        mediaItemId: track.id,
                        mediaType: 'track',
                        libraryGroupId: group.id,
                    });
                    await sql`UPDATE media_files SET file_path=${`/health/${group.id}/Shared Album/${folder}/${fileId}.flac`},is_missing=false WHERE id=${fileId}`;
                }
                expect(await refreshSplitAlbumHealth(sql)).toBe(1);
                expect(await listSplitAlbumHealth(sql)).toMatchObject([{ album_a: a, album_b: b }]);
                const [cursor] = await sql<
                    { after_id: string }[]
                >`SELECT after_id FROM album_split_health_cursor`;
                expect(cursor.after_id).toBe(albums[99].id);
                // A changed peer is in the next batch. Old findings are revalidated,
                // while findings unrelated to a batch are retained until their turn.
                await sql`UPDATE media_items SET custom_metadata=custom_metadata || '{"album":"Unrelated album"}'::jsonb WHERE id=${trackIds[1]}`;
                expect(await refreshSplitAlbumHealth(sql)).toBe(0);
                expect(await listSplitAlbumHealth(sql)).toEqual([]);
                throw rollback;
            });
        } catch (error) {
            if (error !== rollback) throw error;
        }
    });
    it('uses the collapsed-folder expression index for its peer lookup', async () => {
        try {
            await db.begin(async (raw) => {
                const sql = raw as unknown as postgres.Sql;
                await sql`SET LOCAL enable_seqscan=off`;
                const plan = await sql`EXPLAIN (FORMAT JSON) SELECT id FROM media_files
                    WHERE regexp_replace(regexp_replace(file_path, '/[^/]+$', ''),
                        '/(cd|disc|disk|vol(ume)?[.]?|part)[[:space:]]*[0-9]+$', '', 'i')='/health/example'
                    AND is_missing IS NOT TRUE`;
                expect(JSON.stringify(plan)).toContain('idx_media_files_album_folder');
                throw rollback;
            });
        } catch (error) {
            if (error !== rollback) throw error;
        }
    });
});
