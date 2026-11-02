// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One physical file reached under two names is one file.
 *
 * - A case-only rename on a case-insensitive share (SMB, macOS): the listing
 *   shows `Night Film.mkv`, but the old row's `night film.mkv` still stats as
 *   present, so stale cleanup kept it and the new name became a second row.
 *   The runner's disk is case-sensitive, so the listing is emulated: both names
 *   are hard links to one inode and the walk reports only the new one.
 * - A hard link or a symlink to a file the library already has was ingested
 *   as a second file (a "version" of itself, or a second movie).
 *
 * Real scanner, real Postgres, real ffprobe; the Valkey progress store is
 * stubbed and, for the case-only test, the walk listing is filtered.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

vi.mock('./progress-store.js', () => ({
    setScanProgress: async () => {},
    getScanProgress: async () => null,
    deleteScanProgress: async () => {},
    getAnyScanProgress: async () => null,
    getAggregateScanProgress: async () => null,
    getScanProgressByKey: async () => new Map(),
}));

/** Paths the emulated case-insensitive listing hides (the old spelling). */
const hiddenFromWalk = new Set<string>();
vi.mock('$lib/server/utils/walk-directory.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/utils/walk-directory.js')>();
    return {
        ...real,
        walkDirectoryWithResult: async (
            ...args: Parameters<typeof real.walkDirectoryWithResult>
        ): ReturnType<typeof real.walkDirectoryWithResult> => {
            const walk = await real.walkDirectoryWithResult(...args);
            return { ...walk, files: walk.files.filter((f) => !hiddenFromWalk.has(f)) };
        },
    };
});

import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import { scanForSync } from '../../file-scanner.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');

describe('file scanner — one file under two names', () => {
    let sql: postgres.Sql;
    let root: string;
    let pathId: string;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        hiddenFromWalk.clear();
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'same-file-%'`;
        root = mkdtempSync(join(tmpdir(), 'same-file-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`same-file-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'movie', ${group.id}, true) RETURNING id`;
        pathId = lp.id;
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const scan = (): Promise<unknown> => scanForSync(pathId, { sql, logger } as never);

    async function fileRows(): Promise<Array<{ file_path: string; item: string | null }>> {
        return sql<Array<{ file_path: string; item: string | null }>>`
            SELECT mf.file_path, mfi.media_item_id::text AS item
              FROM media_files mf
              LEFT JOIN media_file_items mfi ON mfi.file_id = mf.id
             ORDER BY mf.file_path
        `;
    }

    it('a case-only rename on a case-insensitive share renames the row, keeping its item', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        const before = join(root, 'Night Film (2020)', 'night film (2020).mkv');
        copyFileSync(FIXTURE, before);
        await scan();
        const [row] = await fileRows();
        expect(row.file_path).toBe(before);

        const after = join(root, 'Night Film (2020)', 'Night Film (2020).mkv');
        linkSync(before, after);
        hiddenFromWalk.add(before);
        await scan();

        expect(await fileRows()).toEqual([{ file_path: after, item: row.item }]);
    });

    it('a hard link to a known file in another folder is not ingested again', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        const original = join(root, 'Night Film (2020)', 'Night Film (2020).mkv');
        copyFileSync(FIXTURE, original);
        await scan();

        mkdirSync(join(root, 'Collections', 'Favourites'), { recursive: true });
        linkSync(original, join(root, 'Collections', 'Favourites', 'Night Film (2020).mkv'));
        await scan();

        expect((await fileRows()).map((r) => r.file_path)).toEqual([original]);
    });

    it('a symlink and its target found in the same first scan are one file', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        const target = join(root, 'Night Film (2020)', 'Night Film (2020).mkv');
        copyFileSync(FIXTURE, target);
        mkdirSync(join(root, 'Shortcuts'));
        symlinkSync(target, join(root, 'Shortcuts', 'Night Film (2020).mkv'));
        await scan();

        expect(await fileRows()).toHaveLength(1);
    });

    it('two different files with the same content stay two files', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        mkdirSync(join(root, 'Day Film (2021)'));
        copyFileSync(FIXTURE, join(root, 'Night Film (2020)', 'Night Film (2020).mkv'));
        copyFileSync(FIXTURE, join(root, 'Day Film (2021)', 'Day Film (2021).mkv'));
        await scan();

        expect(await fileRows()).toHaveLength(2);
    });
});
