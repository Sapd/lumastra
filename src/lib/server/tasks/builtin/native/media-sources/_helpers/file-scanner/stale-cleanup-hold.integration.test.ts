// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A stale cleanup the safety guards refuse is recorded, and an admin can
 * confirm it.
 *
 * The scanner refuses to remove missing files when its walk found under 20 %
 * of the files the database knows, or none: that is what an offline or
 * half-mounted share looks like. Before, the refusal was a log line and lasted
 * forever: a library whose files really were deleted (7k bench files on
 * preprod, 2026-10-20) kept every dead row, and nothing told the admin why.
 *
 * Real scanner, real Postgres; only the Valkey progress store is stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
import {
    confirmCleanupHold,
    getCleanupHold,
} from '../../../../../../database/queries/library-cleanup-holds.queries.js';
import { INVARIANTS } from '../../../../../../services/health-invariants/invariants.js';

describe('file scanner — a refused stale cleanup is recorded and can be confirmed', () => {
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
        vi.clearAllMocks();
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'stale-hold-%'`;
        root = mkdtempSync(join(tmpdir(), 'stale-hold-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`stale-hold-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'movie', ${group.id}, true) RETURNING id`;
        pathId = lp.id;
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    async function knownMovie(title: string, filePath: string): Promise<void> {
        const [item] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', ${title}, 'active', true) RETURNING id`;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, file_mtime, file_size_bytes, file_hash_head)
            VALUES (${filePath}, NOW(), 1, ${`head-${title}`}) RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                  VALUES (${item.id}, ${file.id}, true)`;
    }

    const fileRows = async (): Promise<number> =>
        Number((await sql`SELECT count(*)::int AS n FROM media_files`)[0].n);

    const heldInvariant = INVARIANTS.find((i) => i.id === 'library-cleanup-held');

    /** 1 file left on disk, 24 deleted: the walk found 1/25 = 4 % of the known files. */
    async function libraryWithMostFilesDeleted(): Promise<void> {
        mkdirSync(join(root, 'Kept (2001)'));
        const kept = join(root, 'Kept (2001)', 'Kept (2001).mkv');
        writeFileSync(kept, 'x');
        await knownMovie('Kept', kept);
        for (let i = 0; i < 24; i++) {
            await knownMovie(`Gone ${i}`, join(root, `Gone ${i} (2002)`, `Gone ${i} (2002).mkv`));
        }
    }

    it('records the refusal with its counts and shows it as a health finding', async () => {
        await libraryWithMostFilesDeleted();
        await scanForSync(pathId, { sql, logger } as never);

        expect(await fileRows()).toBe(25);
        const hold = await getCleanupHold(sql, pathId);
        expect(hold).toMatchObject({
            reason: 'few_files',
            walked: 1,
            known: 25,
            confirmed_at: null,
        });
        expect(heldInvariant).toBeDefined();
        expect(await heldInvariant!.query(sql)).toBe(1);
    });

    it('removes the missing files once after the admin confirms, then forgets the hold', async () => {
        await libraryWithMostFilesDeleted();
        await scanForSync(pathId, { sql, logger } as never);
        expect(
            await confirmCleanupHold(sql, {
                libraryPathId: pathId,
                expectedWalked: 1,
                confirmedBy: 'admin',
            }),
        ).toBe(true);
        expect(await heldInvariant!.query(sql)).toBe(0);

        await scanForSync(pathId, { sql, logger } as never);

        expect(
            logger.warn.mock.calls.filter(([message]) =>
                String(message).includes('stale delete failed'),
            ),
        ).toEqual([]);
        expect(await fileRows()).toBe(1);
        expect(await getCleanupHold(sql, pathId)).toBeNull();
    });

    it('a confirmed hold does not cover a later walk that finds even fewer files', async () => {
        await libraryWithMostFilesDeleted();
        // Two files on disk when the admin looks: walked 2 of 26.
        mkdirSync(join(root, 'Also Kept (2004)'));
        const alsoKept = join(root, 'Also Kept (2004)', 'Also Kept (2004).mkv');
        writeFileSync(alsoKept, 'x');
        await knownMovie('Also Kept', alsoKept);
        await scanForSync(pathId, { sql, logger } as never);
        expect(await getCleanupHold(sql, pathId)).toMatchObject({ walked: 2, known: 26 });
        expect(
            await confirmCleanupHold(sql, {
                libraryPathId: pathId,
                expectedWalked: 2,
                confirmedBy: 'admin',
            }),
        ).toBe(true);

        // Before the next scan the share loses another file: a new situation.
        rmSync(alsoKept);
        await scanForSync(pathId, { sql, logger } as never);

        expect(await fileRows()).toBe(26);
        expect(await getCleanupHold(sql, pathId)).toMatchObject({
            walked: 1,
            known: 26,
            confirmed_at: null,
        });
    });

    it('a confirmation for another walk changes nothing', async () => {
        await libraryWithMostFilesDeleted();
        await scanForSync(pathId, { sql, logger } as never);
        expect(
            await confirmCleanupHold(sql, {
                libraryPathId: pathId,
                expectedWalked: 7,
                confirmedBy: 'admin',
            }),
        ).toBe(false);

        await scanForSync(pathId, { sql, logger } as never);
        expect(await fileRows()).toBe(25);
    });

    it('an empty walk is held as "no files" and needs its own confirmation', async () => {
        for (let i = 0; i < 3; i++) {
            await knownMovie(`Gone ${i}`, join(root, `Gone ${i} (2002)`, `Gone ${i} (2002).mkv`));
        }
        await scanForSync(pathId, { sql, logger } as never);
        expect(await getCleanupHold(sql, pathId)).toMatchObject({
            reason: 'no_files',
            walked: 0,
            known: 3,
        });
        expect(await fileRows()).toBe(3);

        expect(
            await confirmCleanupHold(sql, {
                libraryPathId: pathId,
                expectedWalked: 0,
                confirmedBy: 'admin',
            }),
        ).toBe(true);
        await scanForSync(pathId, { sql, logger } as never);
        expect(await fileRows()).toBe(0);
        expect(await getCleanupHold(sql, pathId)).toBeNull();
    });

    it('a scan that is not held clears an old hold', async () => {
        await libraryWithMostFilesDeleted();
        await scanForSync(pathId, { sql, logger } as never);
        expect(await getCleanupHold(sql, pathId)).not.toBeNull();

        // The share is back: every known file is on disk again.
        for (let i = 0; i < 24; i++) {
            mkdirSync(join(root, `Gone ${i} (2002)`));
            writeFileSync(join(root, `Gone ${i} (2002)`, `Gone ${i} (2002).mkv`), 'x');
        }
        await scanForSync(pathId, { sql, logger } as never);
        expect(await getCleanupHold(sql, pathId)).toBeNull();
        expect(await fileRows()).toBe(25);
    });
});
