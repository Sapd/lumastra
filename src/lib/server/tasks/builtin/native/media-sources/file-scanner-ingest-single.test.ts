// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import { setSensitivePrefixesForTests } from '$lib/server/utils/contained-fs.js';
import { resetScannerEligibilityCache } from '$lib/server/utils/walk-directory.js';

const { processVideoFile } = vi.hoisted(() => ({ processVideoFile: vi.fn() }));

vi.mock('./_helpers/file-scanner/video-processor.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./_helpers/file-scanner/video-processor.js')>()),
    processVideoFile,
}));
vi.mock('../../../../database/connection.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../database/connection.js')>()),
    getDb: () => null,
}));

import { ingestSingleFile } from './file-scanner.js';

describe('ingestSingleFile eligibility', () => {
    let base: string;
    let root: string;
    const ctx = {
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never;
    const sql = {} as unknown as postgres.Sql;
    const libraryPath = (): LibraryPathRow =>
        ({ path: root, media_type: 'movies' }) as unknown as LibraryPathRow;

    beforeEach(async () => {
        processVideoFile.mockReset();
        processVideoFile.mockResolvedValue('error');
        resetScannerEligibilityCache();
        base = await mkdtemp(join(tmpdir(), 'ingest-single-'));
        root = join(base, 'lib');
        await mkdir(root, { recursive: true });
        await mkdir(join(base, 'secret'), { recursive: true });
        await writeFile(join(base, 'secret', 'master.key'), 'secret');
        setSensitivePrefixesForTests([join(base, 'secret')]);
    });

    afterEach(async () => {
        setSensitivePrefixesForTests([]);
        await rm(base, { recursive: true, force: true });
    });

    it('filters 01.mp3 -> <sensitive>/master.key without reaching processVideoFile', async () => {
        const link = join(root, '01.mp3');
        await symlink(join(base, 'secret', 'master.key'), link);
        const res = await ingestSingleFile(sql, link, libraryPath(), ctx);
        expect(res).toEqual({ status: 'filtered', mediaItemId: null });
        expect(processVideoFile).not.toHaveBeenCalled();
    });

    it('filters a file under extras/', async () => {
        await mkdir(join(root, 'Film', 'extras'), { recursive: true });
        const file = join(root, 'Film', 'extras', 'x.mkv');
        await writeFile(file, '');
        const res = await ingestSingleFile(sql, file, libraryPath(), ctx);
        expect(res).toEqual({ status: 'filtered', mediaItemId: null });
        expect(processVideoFile).not.toHaveBeenCalled();
    });

    it('still ingests an eligible file', async () => {
        const file = join(root, 'Film.mkv');
        await writeFile(file, '');
        const res = await ingestSingleFile(sql, file, libraryPath(), ctx);
        expect(processVideoFile).toHaveBeenCalledTimes(1);
        expect(res.status).toBe('error');
    });
});
