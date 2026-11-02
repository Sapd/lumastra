// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An unmatched movie (no provider, or no provider hit) is linked as a VERSION
 * of the item that already owns a file in its folder only when that folder is
 * the movie's own folder. Before, `linkOrCreateMovie` linked it to any sibling:
 * every unmatched movie lying directly in the library root (a flat movies
 * folder) or in a shared folder ("Home Videos/") became a "version" of
 * whichever movie was ingested first.
 *
 * The REAL scanner (`processVideoFile`), real Postgres, real files and the real
 * ffprobe; no provider ids, so every file takes the unmatched path.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, copyFile } from 'node:fs/promises';
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

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');

describe('unmatched movies: folder-sibling version linking (real PG, real ffprobe)', () => {
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
        root = await mkdtemp(join(tmpdir(), 'lumastra-folder-versions-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`folder-versions-${Date.now()}`})
            RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'movie', ${group.id}, true)
            RETURNING *
        `;
        libraryPath = lp;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function place(...segments: string[]): Promise<string> {
        const file = join(root, ...segments);
        await mkdir(join(file, '..'), { recursive: true });
        await copyFile(FIXTURE, file);
        return file;
    }

    async function itemOf(filePath: string): Promise<{ id: string; title: string } | undefined> {
        const [row] = await sql<{ id: string; title: string }[]>`
            SELECT mi.id, mi.title
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mf.file_path = ${filePath}
        `;
        return row;
    }

    const scan = (filePath: string): ReturnType<typeof processVideoFile> =>
        processVideoFile(sql, filePath, libraryPath, [], context);

    it('two different movies directly in the library root stay two movies', async () => {
        const a = await place('Alpha Picture (2020).mkv');
        const b = await place('Bravo Picture (2021).mkv');
        expect(await scan(a)).not.toBe('error');
        expect(await scan(b)).not.toBe('error');

        const itemA = await itemOf(a);
        const itemB = await itemOf(b);
        expect(itemA).toBeDefined();
        expect(itemB).toBeDefined();
        expect(itemB!.id).not.toBe(itemA!.id);
        expect(itemB!.title).toMatch(/bravo/i);
    }, 60_000);

    it('different videos in a shared folder ("Home Videos/") stay separate', async () => {
        const a = await place('Home Videos', 'Garden Party.mkv');
        const b = await place('Home Videos', 'Beach Trip.mkv');
        await scan(a);
        await scan(b);
        expect((await itemOf(b))!.id).not.toBe((await itemOf(a))!.id);
    }, 60_000);

    it("a second file in the movie's own folder is still linked as a version", async () => {
        const main = await place('Charlie Picture (2019)', 'Charlie Picture (2019).mkv');
        const alt = await place('Charlie Picture (2019)', 'alt-render-v2.mkv');
        await scan(main);
        await scan(alt);
        expect((await itemOf(alt))!.id).toBe((await itemOf(main))!.id);
    }, 60_000);

    it('different dated movies in a dated shared folder ("Movies 2020/") stay separate', async () => {
        const a = await place('Movies 2020', 'Alpha Picture (2020).mkv');
        const b = await place('Movies 2020', 'Bravo Picture (2020).mkv');
        await scan(a);
        await scan(b);
        expect((await itemOf(b))!.id).not.toBe((await itemOf(a))!.id);
    }, 60_000);
});
