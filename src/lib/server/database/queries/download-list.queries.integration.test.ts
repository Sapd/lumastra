// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { getMediaItemForDownloadNaming } from './catalog-operations.queries.js';
import { buildDownloadFilename } from '../../handlers/media-download-handler.js';
import {
    getDownloadListRoot,
    getSingleDownloadRow,
    listEpisodeDownloadRows,
} from './download-list.queries.js';

describe('download-list queries', () => {
    let sql: postgres.Sql;
    const ids = {
        series: crypto.randomUUID(),
        s1: crypto.randomUUID(),
        e1: crypto.randomUUID(),
        e2: crypto.randomUUID(),
        e3: crypto.randomUUID(),
        fa: crypto.randomUUID(),
        fb: crypto.randomUUID(),
        fc: crypto.randomUUID(),
    };

    beforeAll(async () => {
        sql = getTestDb();
        await sql`INSERT INTO media_items (id, title, media_type, year, status) VALUES (${ids.series}, 'DL Show', 'tv', 2004, 'active')`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, status) VALUES (${ids.s1}, 'S1', 'season', ${ids.series}, 1, 'active')`;
        for (const [id, n] of [
            [ids.e1, 1],
            [ids.e2, 2],
            [ids.e3, 3],
        ] as const) {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status) VALUES (${id}, ${'Ep' + n}, 'episode', ${ids.s1}, 1, ${n}, 'active')`;
        }
        // e1: two files, the second is the default; e2: one missing file; e3: no file.
        await sql`INSERT INTO media_files (id, file_path, file_size_bytes, created_at, updated_at) VALUES (${ids.fa}, '/dl/a.mkv', 10, now(), now()), (${ids.fb}, '/dl/b.mp4', 20, now(), now()), (${ids.fc}, '/dl/c.mkv', 30, now(), now())`;
        await sql`UPDATE media_files SET is_missing = true WHERE id = ${ids.fc}`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order) VALUES (${ids.fa}, ${ids.e1}, false, 0), (${ids.fb}, ${ids.e1}, true, 1), (${ids.fc}, ${ids.e2}, true, 0)`;
    });

    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE id = ANY(${[ids.e1, ids.e2, ids.e3, ids.s1, ids.series]}::uuid[])`;
        await sql`DELETE FROM media_files WHERE id = ANY(${[ids.fa, ids.fb, ids.fc]}::uuid[])`;
        await closeTestDb();
    });

    it('root lookup', async () => {
        expect(await getDownloadListRoot(sql, ids.series)).toMatchObject({
            title: 'DL Show',
            year: 2004,
            media_type: 'tv',
        });
    });

    it('episodes of a series: default file, series title, ordered', async () => {
        const rows = await listEpisodeDownloadRows(sql, ids.series);
        expect(rows.map((r) => r.id)).toEqual([ids.e1, ids.e2, ids.e3]);
        expect(rows[0]).toMatchObject({ file_id: ids.fb, series_title: 'DL Show' });
        expect(rows[1]).toMatchObject({ file_id: ids.fc, is_missing: true });
        expect((await listEpisodeDownloadRows(sql, ids.s1)).length).toBe(3);
    });

    it('single item row', async () => {
        expect(await getSingleDownloadRow(sql, ids.e1)).toMatchObject({ file_id: ids.fb });
        expect(await getSingleDownloadRow(sql, ids.e3)).toMatchObject({ file_id: null });
    });

    it('episodes without a file row come back with file_id null', async () => {
        const rows = await listEpisodeDownloadRows(sql, ids.series);
        expect(rows.map((r) => r.id)).toEqual([ids.e1, ids.e2, ids.e3]);
        expect(rows[2].file_id).toBeNull();
    });

    it('a single episode row names itself like the download route and carries the series', async () => {
        const row = await getSingleDownloadRow(sql, ids.e1);
        const naming = await getMediaItemForDownloadNaming(sql, ids.e1);
        expect(row).toMatchObject({ series_title: 'DL Show', series_year: 2004 });
        expect(buildDownloadFilename(row!, '.mp4')).toBe(buildDownloadFilename(naming!, '.mp4'));
        expect(buildDownloadFilename(row!, '.mp4')).toBe('DL Show - S01E01 - Ep1.mp4');
    });

    it('lists an episode parented directly to the series (no season row) and one with a null season number', async () => {
        const flat = crypto.randomUUID();
        const noSeason = crypto.randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status) VALUES (${flat}, 'Flat', 'episode', ${ids.series}, 1, 9, 'active'), (${noSeason}, 'NoSeason', 'episode', ${ids.s1}, NULL, 8, 'active')`;
        try {
            const rows = await listEpisodeDownloadRows(sql, ids.series);
            const f = rows.find((r) => r.id === flat);
            expect(f).toMatchObject({ series_title: 'DL Show', season_number: 1 });
            expect(rows.find((r) => r.id === noSeason)).toMatchObject({ season_number: null });
            // a season container does not pick up the flat episode
            expect((await listEpisodeDownloadRows(sql, ids.s1)).map((r) => r.id)).not.toContain(
                flat,
            );
        } finally {
            await sql`DELETE FROM media_items WHERE id = ANY(${[flat, noSeason]}::uuid[])`;
        }
    });

    it('the default file is the best ALLOWED one: a denied default is skipped, all denied leaves no file', async () => {
        const denied = crypto.randomUUID();
        // e1's default (fb) sits in a denied library, the other file (fa) is unrestricted
        await sql`UPDATE media_files SET library_group_id = ${denied} WHERE id = ${ids.fb}`;
        try {
            expect(await getSingleDownloadRow(sql, ids.e1)).toMatchObject({ file_id: ids.fb });
            expect(await getSingleDownloadRow(sql, ids.e1, [denied])).toMatchObject({
                file_id: ids.fa,
            });
            const rows = await listEpisodeDownloadRows(sql, ids.series, [denied]);
            expect(rows[0]).toMatchObject({ id: ids.e1, file_id: ids.fa });
            // another denied group changes nothing
            expect(await getSingleDownloadRow(sql, ids.e1, [crypto.randomUUID()])).toMatchObject({
                file_id: ids.fb,
            });
            // every file denied: the row stays, without a file
            await sql`UPDATE media_files SET library_group_id = ${denied} WHERE id = ${ids.fa}`;
            expect(await getSingleDownloadRow(sql, ids.e1, [denied])).toMatchObject({
                file_id: null,
            });
        } finally {
            await sql`UPDATE media_files SET library_group_id = NULL WHERE id = ANY(${[ids.fa, ids.fb]}::uuid[])`;
        }
    });
});
