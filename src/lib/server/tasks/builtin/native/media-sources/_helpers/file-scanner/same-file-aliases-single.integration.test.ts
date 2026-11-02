// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One physical file under two names is one file on the watcher / delta path
 * too (`ingestSingleFile`), not only in the full scan.
 *
 * - A live case-only rename on a case-insensitive share: the watcher sees
 *   `add Night Film.mkv`, and its unlink of `night film.mkv` is dropped as a
 *   phantom because the old name still stats. The row is renamed in place.
 *   The runner's disk is case-sensitive, so the share is emulated with hard
 *   links: the old name, the new name and the swapped-case probe name the
 *   check uses to tell a case-insensitive directory all point at one inode.
 * - A hard link or a symlink to a file the library already has is skipped.
 *
 * Real scanner, real Postgres, real ffprobe; only the Valkey progress store is
 * stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import {
    mkdtempSync,
    mkdirSync,
    copyFileSync,
    rmSync,
    linkSync,
    symlinkSync,
    unlinkSync,
} from 'node:fs';
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

import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import {
    getLibraryPathById,
    type LibraryPathRow,
} from '$lib/server/database/queries/library-paths.queries.js';
import { runTask } from '@sapd/lumastra-plugin-sdk-testing';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { ingestSingleFile, scanForSync } from '../../file-scanner.js';
import { fileDeltaIngestTask } from '../../../file-delta-ingest.js';
import { swapCaseProbeName } from './same-file-aliases.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');

describe('ingestSingleFile — one file under two names', () => {
    let sql: postgres.Sql;
    let root: string;
    let pathId: string;
    let lp: LibraryPathRow;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const ctx = (): never => ({ sql, logger }) as never;

    beforeAll(async () => {
        sql = getTestDb();
        await connectValkey();
    });
    afterAll(async () => {
        await closeTestDb();
        await disconnectValkey();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'same-file-single-%'`;
        root = mkdtempSync(join(tmpdir(), 'same-file-single-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`same-file-single-${Date.now()}`}) RETURNING id`;
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'movie', ${group.id}, true) RETURNING id`;
        pathId = row.id;
        lp = (await getLibraryPathById(sql, pathId))!;
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    async function fileRows(): Promise<Array<{ file_path: string; item: string | null }>> {
        return sql<Array<{ file_path: string; item: string | null }>>`
            SELECT mf.file_path, mfi.media_item_id::text AS item
              FROM media_files mf
              LEFT JOIN media_file_items mfi ON mfi.file_id = mf.id
             ORDER BY mf.file_path
        `;
    }

    it('a live case-only rename on a case-insensitive share renames the row, keeping its item', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        const before = join(root, 'Night Film (2020)', 'night film (2020).mkv');
        copyFileSync(FIXTURE, before);
        await scanForSync(pathId, ctx());
        const [row] = await fileRows();
        expect(row.file_path).toBe(before);

        const after = join(root, 'Night Film (2020)', 'Night Film (2020).mkv');
        linkSync(before, after);
        linkSync(before, swapCaseProbeName(after)!);
        const res = await ingestSingleFile(sql, after, lp, ctx());

        expect(res).toEqual({ status: 'skipped', mediaItemId: row.item });
        expect(await fileRows()).toEqual([{ file_path: after, item: row.item }]);
    });

    it('a hard link to a known file in another folder is not ingested again', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        const original = join(root, 'Night Film (2020)', 'Night Film (2020).mkv');
        copyFileSync(FIXTURE, original);
        await scanForSync(pathId, ctx());

        mkdirSync(join(root, 'Collections', 'Favourites'), { recursive: true });
        const link = join(root, 'Collections', 'Favourites', 'Night Film (2020).mkv');
        linkSync(original, link);
        const res = await ingestSingleFile(sql, link, lp, ctx());

        expect(res.status).toBe('skipped');
        expect((await fileRows()).map((r) => r.file_path)).toEqual([original]);
    });

    it('a symlink to a known file is not ingested again', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        const target = join(root, 'Night Film (2020)', 'Night Film (2020).mkv');
        copyFileSync(FIXTURE, target);
        await scanForSync(pathId, ctx());

        mkdirSync(join(root, 'Shortcuts'));
        const link = join(root, 'Shortcuts', 'Night Film (2020).mkv');
        symlinkSync(target, link);
        const res = await ingestSingleFile(sql, link, lp, ctx());

        expect(res.status).toBe('skipped');
        expect((await fileRows()).map((r) => r.file_path)).toEqual([target]);
    });

    it('a different file with the same content is still ingested', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        mkdirSync(join(root, 'Day Film (2021)'));
        copyFileSync(FIXTURE, join(root, 'Night Film (2020)', 'Night Film (2020).mkv'));
        await scanForSync(pathId, ctx());

        const other = join(root, 'Day Film (2021)', 'Day Film (2021).mkv');
        copyFileSync(FIXTURE, other);
        const res = await ingestSingleFile(sql, other, lp, ctx());

        expect(res.status).toBe('ingested');
        expect(await fileRows()).toHaveLength(2);
    });

    /** Removes `rel` the way the delta ingest does (the watcher's removal path is the same delete). */
    async function removeViaDelta(rel: string): Promise<void> {
        await runTask(
            fileDeltaIngestTask,
            { libraryPathId: pathId, upsert: [], remove: [rel] },
            { sql },
        );
    }

    it('a hard link renamed over its original is ingested once the original is unlinked', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        const original = join(root, 'Night Film (2020)', 'nf.2020.1080p.mkv');
        copyFileSync(FIXTURE, original);
        await scanForSync(pathId, ctx());
        const [row] = await fileRows();
        expect(row.file_path).toBe(original);

        // Radarr-style rename: link the new name, then unlink the old one.
        const renamed = join(root, 'Night Film (2020)', 'Night Film (2020).mkv');
        linkSync(original, renamed);
        const res = await ingestSingleFile(sql, renamed, lp, ctx());
        expect(res.status).toBe('skipped');
        expect((await fileRows()).map((r) => r.file_path)).toEqual([original]);

        unlinkSync(original);
        await removeViaDelta('Night Film (2020)/nf.2020.1080p.mkv');

        const rows = await fileRows();
        expect(rows.map((r) => r.file_path)).toEqual([renamed]);
        expect(rows[0].item).not.toBeNull();
    });

    it('a hard link in another folder is ingested once the original it aliased is unlinked', async () => {
        mkdirSync(join(root, 'Night Film (2020)'));
        mkdirSync(join(root, 'Collections'));
        const original = join(root, 'Night Film (2020)', 'Night Film (2020).mkv');
        copyFileSync(FIXTURE, original);
        await scanForSync(pathId, ctx());

        const moved = join(root, 'Collections', 'Night Film (2020).mkv');
        linkSync(original, moved);
        const res = await ingestSingleFile(sql, moved, lp, ctx());
        expect(res.status).toBe('skipped');

        unlinkSync(original);
        await removeViaDelta('Night Film (2020)/Night Film (2020).mkv');

        const rows = await fileRows();
        expect(rows.map((r) => r.file_path)).toEqual([moved]);
        expect(rows[0].item).not.toBeNull();
    });
});
