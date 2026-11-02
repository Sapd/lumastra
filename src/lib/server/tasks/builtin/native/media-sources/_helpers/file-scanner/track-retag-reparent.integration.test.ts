// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A retag moves the track to its new album and artist.
 *
 * The content-changed branch of `processAudioFile` rewrote the track's tags,
 * title and number but never its place in the hierarchy: a track retagged
 * from "Evening Album" to "Morning Album" (or to another album artist) stayed
 * under the old album forever, and the album list kept showing the old
 * grouping. The track keeps its id (plays, ratings, playlists).
 *
 * Real `processAudioFile`, real Postgres, real files.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    closeTestDb,
    getTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    TEST_TABLES,
    truncateTables,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import type { FileScannerContext } from './shared.js';
import { processAudioFile } from './audio-processor.js';
import { ID3_UTF8, textFrameBody, writeId3Mp3 } from './id3-mp3-fixture.test-helpers.js';

describe('a retagged track moves to its new album (real PG)', () => {
    let sql: postgres.Sql;
    let root: string;
    let lp: LibraryPathRow;
    let context: FileScannerContext;

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger: mockLogger() } as unknown as FileScannerContext;
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-retag-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`retag-${randomUUID()}`}) RETURNING id
        `;
        [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'music', ${group.id}, true) RETURNING *
        `;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function writeTrack(
        file: string,
        album: string,
        albumArtist: string,
        comment = '',
    ): Promise<void> {
        await mkdir(join(file, '..'), { recursive: true });
        await writeId3Mp3(file, 4, [
            ...(comment ? [{ id: 'TENC', body: textFrameBody(ID3_UTF8, [comment]) }] : []),
            { id: 'TIT2', body: textFrameBody(ID3_UTF8, ['Evening Song']) },
            { id: 'TALB', body: textFrameBody(ID3_UTF8, [album]) },
            { id: 'TPE1', body: textFrameBody(ID3_UTF8, ['Night Choir']) },
            { id: 'TPE2', body: textFrameBody(ID3_UTF8, [albumArtist]) },
            { id: 'TRCK', body: textFrameBody(ID3_UTF8, ['3']) },
        ]);
    }

    async function placement(trackId: string): Promise<{ album: string; artist: string }> {
        const [row] = await sql<{ album: string; artist: string }[]>`
            SELECT al.title AS album, ar.title AS artist
              FROM media_items t
              JOIN media_items al ON al.id = t.parent_id
              JOIN media_items ar ON ar.id = al.parent_id
             WHERE t.id = ${trackId}
        `;
        return row;
    }

    async function trackOf(file: string): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            SELECT mfi.media_item_id::text AS id FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id WHERE mf.file_path = ${file}
        `;
        return row.id;
    }

    /** Rewrite in place, with an mtime the change detection cannot miss. */
    async function retag(
        file: string,
        album: string,
        albumArtist: string,
        comment = '',
    ): Promise<void> {
        await writeTrack(file, album, albumArtist, comment);
        const later = new Date(Date.now() + 60_000);
        await utimes(file, later, later);
    }

    it('a new album tag moves the track and removes the emptied album', async () => {
        const file = join(root, 'Night Choir', 'Evening Album', '03 Evening Song.mp3');
        await writeTrack(file, 'Evening Album', 'Night Choir');
        expect(await processAudioFile(sql, file, lp, context)).toBe('added');
        const trackId = await trackOf(file);
        expect(await placement(trackId)).toEqual({ album: 'Evening Album', artist: 'Night Choir' });

        await retag(file, 'Morning Album', 'Night Choir');
        expect(await processAudioFile(sql, file, lp, context)).toBe('updated');

        expect(await trackOf(file)).toBe(trackId);
        expect(await placement(trackId)).toEqual({ album: 'Morning Album', artist: 'Night Choir' });
        const albums = await sql<{ title: string; has_files: boolean }[]>`
            SELECT title, has_files FROM media_items WHERE media_type = 'album' AND status = 'active'
        `;
        expect(albums).toEqual([{ title: 'Morning Album', has_files: true }]);
    });

    it('a new album-artist tag moves the track under that artist', async () => {
        const file = join(root, 'Night Choir', 'Evening Album', '03 Evening Song.mp3');
        await writeTrack(file, 'Evening Album', 'Night Choir');
        await processAudioFile(sql, file, lp, context);
        const trackId = await trackOf(file);

        await retag(file, 'Evening Album', 'Dawn Ensemble');
        await processAudioFile(sql, file, lp, context);

        expect(await placement(trackId)).toEqual({
            album: 'Evening Album',
            artist: 'Dawn Ensemble',
        });
        // The old artist no longer has a track with a file: off the library.
        const [old] = await sql<{ has_files: boolean }[]>`
            SELECT has_files FROM media_items WHERE media_type = 'artist' AND title = 'Night Choir'
        `;
        expect(old?.has_files ?? false).toBe(false);
    });

    it('a locked track stays where the admin put it', async () => {
        const file = join(root, 'Night Choir', 'Evening Album', '03 Evening Song.mp3');
        await writeTrack(file, 'Evening Album', 'Night Choir');
        await processAudioFile(sql, file, lp, context);
        const trackId = await trackOf(file);
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${trackId}`;

        await retag(file, 'Morning Album', 'Night Choir');
        await processAudioFile(sql, file, lp, context);

        expect(await placement(trackId)).toEqual({ album: 'Evening Album', artist: 'Night Choir' });
    });

    it('a content change that keeps the album tags leaves the track in an album the admin renamed', async () => {
        const file = join(root, 'Night Choir', 'Evening Album', '03 Evening Song.mp3');
        await writeTrack(file, 'Evening Album', 'Night Choir');
        await processAudioFile(sql, file, lp, context);
        const trackId = await trackOf(file);
        await sql`
            UPDATE media_items SET title = 'Evening Album (Remastered)'
             WHERE id = (SELECT parent_id FROM media_items WHERE id = ${trackId})
        `;

        // Same album/artist tags, other bytes (a tool rewrote another frame).
        await retag(file, 'Evening Album', 'Night Choir', 'replaygain-tool');
        expect(await processAudioFile(sql, file, lp, context)).toBe('updated');

        expect(await placement(trackId)).toEqual({
            album: 'Evening Album (Remastered)',
            artist: 'Night Choir',
        });
    });
});
