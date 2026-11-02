// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One unreadable entry must not stop stale cleanup for the whole library.
 *
 * A walk error (a dangling symlink — debrid/arr libraries always have some —
 * or a folder the server cannot read, like `lost+found`) used to make the
 * scan skip stale cleanup for the ENTIRE library path, on every scan, so
 * deleted files stayed linked forever. Now only DB rows at or under an errored
 * path are protected (the link target may only be offline); everything else
 * is cleaned up as usual.
 *
 * Real scanner, real Postgres; only the Valkey progress store is stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
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
import { scanForSync } from '../../file-scanner.js';

describe('file scanner — stale cleanup with walk errors', () => {
    let sql: postgres.Sql;
    let root: string;
    let pathId: string;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'stale-walkerr-%'`;
        root = mkdtempSync(join(tmpdir(), 'stale-walkerr-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`stale-walkerr-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'movie', ${group.id}, true) RETURNING id`;
        pathId = lp.id;
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    async function knownMovie(title: string, filePath: string): Promise<void> {
        let mtime = new Date();
        let size = 1;
        try {
            const st = statSync(filePath);
            mtime = new Date(st.mtimeMs);
            size = st.size;
        } catch {
            /* the file is gone on disk: that is the point */
        }
        const [item] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', ${title}, 'active', true) RETURNING id`;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, file_mtime, file_size_bytes, file_hash_head)
            VALUES (${filePath}, ${mtime}, ${size}, 'head') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${item.id}, ${file.id}, true)`;
    }

    const rowExists = async (filePath: string): Promise<boolean> =>
        (await sql`SELECT 1 FROM media_files WHERE file_path = ${filePath}`).length > 0;

    it('deletes the rows of removed files although a dangling symlink errors the walk', async () => {
        // Kept: a present movie (the walk must find something).
        mkdirSync(join(root, 'Kept (2001)'));
        const kept = join(root, 'Kept (2001)', 'Kept (2001).mkv');
        writeFileSync(kept, 'x');
        await knownMovie('Kept', kept);
        // Removed from disk: its row must go.
        const removed = join(root, 'Removed (2002)', 'Removed (2002).mkv');
        await knownMovie('Removed', removed);
        // A dangling symlink: its target may only be offline, so its row stays.
        mkdirSync(join(root, 'Linked (2003)'));
        const dangling = join(root, 'Linked (2003)', 'Linked (2003).mkv');
        symlinkSync(join(root, 'nowhere', 'target.mkv'), dangling);
        await knownMovie('Linked', dangling);

        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        await scanForSync(pathId, { sql, logger } as never);

        expect(await rowExists(kept)).toBe(true);
        expect(await rowExists(dangling)).toBe(true);
        expect(await rowExists(removed)).toBe(false);
    });
});
