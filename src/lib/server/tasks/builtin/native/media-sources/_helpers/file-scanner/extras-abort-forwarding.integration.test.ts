// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The library scan must hand its abort signal to `processExtra`, so a
 * cancelled scan kills an extra's in-flight ffprobe (fix plan 6, Task 7 fix
 * round 3). Drives the REAL scanner (`scanForSync`) over a temp library
 * against Postgres; `processExtra` is wrapped in a pass-through spy only to
 * read the arguments the scan gave it, and the Valkey progress store is
 * replaced by a no-op.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
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

vi.mock('./ancillary-processors.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./ancillary-processors.js')>();
    return { ...actual, processExtra: vi.fn(actual.processExtra) };
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
import { processExtra } from './ancillary-processors.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');

describe('file scanner — extras pass receives the scan abort signal', () => {
    let sql: postgres.Sql;
    let root: string;
    let pathId: string;
    let groupId: string;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        vi.mocked(processExtra).mockClear();
        await truncateTables(sql, TEST_TABLES.media);
        root = mkdtempSync(join(tmpdir(), 'extras-abort-'));
        const movieDir = join(root, 'Abort Movie (2020)');
        mkdirSync(join(movieDir, 'trailers'), { recursive: true });
        copyFileSync(FIXTURE, join(movieDir, 'Abort Movie (2020).mkv'));
        copyFileSync(FIXTURE, join(movieDir, 'trailers', 'Abort Movie-trailer.mkv'));

        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`extras-abort-${Date.now()}`}) RETURNING id`;
        groupId = group.id;
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'movie', ${groupId}, true) RETURNING id`;
        pathId = lp.id;
    });
    afterEach(async () => {
        rmSync(root, { recursive: true, force: true });
        await sql`DELETE FROM library_paths WHERE id = ${pathId}`;
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_groups WHERE id = ${groupId}`;
    });

    it('passes an AbortSignal as processExtra’s fourth argument', async () => {
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
        await scanForSync(pathId, { sql, logger } as never);

        const calls = vi.mocked(processExtra).mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call[3]).toBeInstanceOf(AbortSignal);
        }
    }, 60_000);
});
