// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Evidence-based artist-credit splitting against a real database:
 *
 *  - `mergeCollaborationArtists` splits a combined row only when the library's
 *    own tags prove a part independent ("Wilhart & Solara" splits, "Rowan & Cian"
 *    stays);
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { mergeCollaborationArtists } from '../media-sources/_helpers/file-scanner/audio-processor.js';
import { resetArtistCreditEvidenceCache } from '../media-sources/_helpers/file-scanner/artist-credit-evidence.js';
import type { FileScannerContext } from '../media-sources/_helpers/file-scanner/shared.js';

import {
    TEST_TABLES,
    truncateTables,
} from '../../../../../../../tests/integration/helpers/cleanup.js';

const ROLLBACK = '__rollback__';

async function inRollback(
    sql: postgres.Sql,
    body: (tx: postgres.Sql) => Promise<void>,
): Promise<void> {
    await sql
        .begin(async (tx: postgres.TransactionSql) => {
            await body(tx as unknown as postgres.Sql);
            throw new Error(ROLLBACK);
        })
        .catch((e: unknown) => {
            if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
        });
}

async function insertArtist(tx: postgres.Sql, title: string): Promise<string> {
    const [row] = await tx<{ id: string }[]>`
        INSERT INTO media_items (title, media_type) VALUES (${title}, 'artist') RETURNING id
    `;
    return row.id;
}

async function insertAlbum(tx: postgres.Sql, title: string, artistId: string): Promise<string> {
    const [row] = await tx<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, parent_id)
        VALUES (${title}, 'album', ${artistId}) RETURNING id
    `;
    return row.id;
}

async function insertTrack(
    tx: postgres.Sql,
    title: string,
    albumId: string,
    meta: Record<string, unknown>,
): Promise<string> {
    const [row] = await tx<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, parent_id, custom_metadata)
        VALUES (${title}, 'track', ${albumId}, ${tx.json(meta as Record<string, never>)})
        RETURNING id
    `;
    const [file] = await tx<
        { id: string }[]
    >`INSERT INTO media_files (file_path) VALUES (${'/music/fixtures/' + row.id + '.mp3'}) RETURNING id`;
    await tx`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${row.id},true)`;
    return row.id;
}

async function artistTitleOfAlbum(tx: postgres.Sql, albumId: string): Promise<string | null> {
    const [row] = await tx<{ title: string }[]>`
        SELECT artist.title FROM media_items album
        JOIN media_items artist ON artist.id = album.parent_id
        WHERE album.id = ${albumId}
    `;
    return row?.title ?? null;
}

async function artistExists(tx: postgres.Sql, title: string): Promise<boolean> {
    const rows = await tx`
        SELECT 1 FROM media_items WHERE media_type = 'artist' AND title = ${title}
    `;
    return rows.length > 0;
}

const context = { logger: mockLogger() } as unknown as FileScannerContext;

describe('evidence-based artist-credit splitting (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        // The base schema seeds Various Artists; each rolled-back fixture owns
        // its catalog and must not inherit rows from earlier test files.
        await truncateTables(sql, TEST_TABLES.media);
    });

    beforeEach(() => {
        resetArtistCreditEvidenceCache();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    it('splits a proven collaboration row and keeps a duo row whole', async () => {
        await inRollback(sql, async (tx) => {
            // Wilhart is credited alone twice → independent.
            const withard = await insertArtist(tx, 'Wilhart');
            const soloAlbum = await insertAlbum(tx, 'Solo', withard);
            await insertTrack(tx, 'One', soloAlbum, { artist: 'Wilhart' });
            await insertTrack(tx, 'Two', soloAlbum, { artist: 'Wilhart feat. Jo' });

            const collab = await insertArtist(tx, 'Wilhart & Solara');
            const collabAlbum = await insertAlbum(tx, 'Together', collab);
            await insertTrack(tx, 'Three', collabAlbum, {
                artist: 'Wilhart & Solara',
                album_artist: 'Wilhart & Solara',
            });

            const duo = await insertArtist(tx, 'Rowan & Cian');
            const duoAlbum = await insertAlbum(tx, 'Mond', duo);
            await insertTrack(tx, 'Mond', duoAlbum, { artist: 'Rowan & Cian' });

            await mergeCollaborationArtists(tx, context);

            expect(await artistTitleOfAlbum(tx, collabAlbum)).toBe('Wilhart');
            expect(await artistExists(tx, 'Wilhart & Solara')).toBe(false);
            expect(await artistExists(tx, 'Solara')).toBe(true);

            expect(await artistTitleOfAlbum(tx, duoAlbum)).toBe('Rowan & Cian');
            expect(await artistExists(tx, 'Rowan')).toBe(false);
        });
    });
});
