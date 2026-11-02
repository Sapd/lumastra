// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An ID3v2.3 file whose album-artist frame holds NUL-separated UTF-16 values
 * (Mp3tag style) used to reach Postgres with a raw 0x00 and fail the whole
 * file with error 22021. Drives the REAL scanner against real PG and real
 * bytes: the first value becomes the primary artist, the others are linked
 * through custom_metadata.additional_artist_ids.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import type { FileScannerContext } from './shared.js';
import { processVideoFile } from './video-processor.js';
import { prodNulAlbumArtistFrames, writeId3Mp3 } from './id3-mp3-fixture.test-helpers.js';

describe('music scanner: NUL-separated ID3v2.3 album artist (real PG)', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    const logger = {
        info: (): void => undefined,
        warn: (): void => undefined,
        error: (): void => undefined,
        debug: (): void => undefined,
    };
    let context: FileScannerContext;

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger } as unknown as FileScannerContext;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-nul-artist-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`nul-artist-${Date.now()}`})
            RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'music', ${group!.id}, true)
            RETURNING *
        `;
        libraryPath = lp!;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM library_paths WHERE id = ${lp!.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group!.id}`;
        };
    });

    it('scans without 22021; primary artist is the first value, the rest are linked', async () => {
        const albumDir = join(root, "L'EXAIS x Perfect Pitch x Rocco", 'Woodpecker (2026)');
        await mkdir(albumDir, { recursive: true });
        const p = await writeId3Mp3(
            join(albumDir, "L'EXAIS x Perfect Pitch x Rocco - 01 - Woodpecker.mp3"),
            3,
            prodNulAlbumArtistFrames(),
        );

        const result = await processVideoFile(sql, p, libraryPath, [], context);
        expect(result).toBe('added');

        const [row] = await sql<
            {
                id: string;
                title: string;
                parent_id: string;
                custom_metadata: Record<string, unknown> | null;
            }[]
        >`
            SELECT mi.id, mi.title, mi.parent_id, mi.custom_metadata
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mf.file_path = ${p}
        `;
        expect(row, 'track row with a file').toBeDefined();
        expect(row!.title).toBe('Woodpecker');

        const [album] = await sql<{ parent_id: string }[]>`
            SELECT parent_id FROM media_items WHERE id = ${row!.parent_id}
        `;
        const [primary] = await sql<{ title: string }[]>`
            SELECT title FROM media_items WHERE id = ${album!.parent_id}
        `;
        expect(primary!.title).toBe("L'EXAIS");

        const extraIds = row!.custom_metadata?.additional_artist_ids as string[] | undefined;
        expect(extraIds).toBeDefined();
        const extras = await sql<{ title: string }[]>`
            SELECT title FROM media_items WHERE id = ANY(${extraIds!}::uuid[])
        `;
        // ensureTrackArtistLinks also links the primary via the TPE1 credit split.
        expect([...new Set(extras.map((e) => e.title))].sort()).toEqual([
            "L'EXAIS",
            'Perfect Pitch',
            'Rocco',
        ]);
    }, 60_000);
});
