// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The published scan progress never overshoots and its denominator never grows.
 *
 * Reported from prod: after "Scan" on the kids library the row raced to ~100%,
 * then fell back and crawled up again. The total started as the media-file
 * count only; triage marked every unchanged file done in ONE write (2,869 of
 * 2,945 = 97%), and the extras/artwork/subtitle files were added to the total
 * only when the ancillary pass began. The ancillary walks now run beside the
 * main walk, so the scanning phase starts with the whole scan's denominator.
 *
 * Drives the REAL scanner over a temp library against Postgres; only the
 * Valkey progress store is replaced, by a recorder.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

const writes = vi.hoisted(
    () => [] as Array<{ phase?: string; totalFiles: number; processedFiles: number }>,
);
vi.mock('./progress-store.js', () => ({
    setScanProgress: async (
        _key: string,
        p: { phase?: string; totalFiles: number; processedFiles: number },
    ) => {
        writes.push({ phase: p.phase, totalFiles: p.totalFiles, processedFiles: p.processedFiles });
    },
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

describe('file scanner — published progress', () => {
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
        writes.length = 0;
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'scan-progress-%'`;

        // Two movies already known and UNCHANGED (as on a rescan), plus the
        // ancillary files that used to be added to the total late.
        root = mkdtempSync(join(tmpdir(), 'scan-progress-'));
        for (const title of ['Alpha (2001)', 'Beta (2002)']) {
            const dir = join(root, title);
            mkdirSync(dir);
            writeFileSync(join(dir, `${title}.mkv`), 'x');
            writeFileSync(join(dir, 'poster.jpg'), 'x');
            writeFileSync(join(dir, `${title}.en.srt`), '1\n00:00:01,000 --> 00:00:02,000\nhi\n');
        }

        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`scan-progress-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'movie', ${group.id}, true) RETURNING id`;
        pathId = lp.id;

        for (const title of ['Alpha (2001)', 'Beta (2002)']) {
            const filePath = join(root, title, `${title}.mkv`);
            const st = statSync(filePath);
            const [item] = await sql<{ id: string }[]>`
                INSERT INTO media_items (media_type, title, status, has_files)
                VALUES ('movie', ${title}, 'active', true) RETURNING id`;
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, file_mtime, file_size_bytes, file_hash_head)
                VALUES (${filePath}, ${new Date(st.mtimeMs)}, ${st.size}, 'head') RETURNING id`;
            await sql`INSERT INTO media_file_items (media_item_id, file_id)
                      VALUES (${item.id}, ${file.id})`;
        }
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('starts the scanning phase with the WHOLE total and never overshoots it', async () => {
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        await scanForSync(pathId, { sql, logger } as never);

        const scanning = writes.filter((w) => w.phase !== 'discovering');
        expect(scanning.length).toBeGreaterThan(0);
        // 2 media + 2 posters + 2 subtitles, known from the first write on.
        const total = scanning[0].totalFiles;
        expect(total).toBe(6);
        for (const w of scanning) {
            expect(w.totalFiles).toBe(total);
            expect(w.processedFiles).toBeLessThanOrEqual(w.totalFiles);
        }
        // Triage's jump (2 unchanged media) is a third of the scan, not ~100%.
        const afterTriage = scanning.find((w) => w.processedFiles > 0);
        expect(afterTriage?.processedFiles).toBe(2);
    });
});
