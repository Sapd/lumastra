// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A file still being copied when the scan reads it: the scanner probes (or
 * tag-parses) the partial file and only afterwards commits mtime/size/hash
 * (`initFileChangeDetection`). If the copy finished in between, the row stored
 * the FINAL size beside data read from the partial file, so every later scan
 * triaged it `unchanged` and never read it again.
 *
 * `processVideoFile` now snapshots the stat before processing and, when the
 * file moved on, stores the snapshot (`keepProbedFileStat`), so the next
 * scan's triage sees a change. Real Postgres, real files.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile, stat, rename } from 'node:fs/promises';
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
import {
    keepProbedFileStat,
    markFileMissing,
    attachFileToItem,
    loadMediaFilesByPrefix,
    upsertMediaFile,
} from '../../../../../../database/queries/media-files.queries.js';
import { initFileChangeDetection, triageFiles } from './shared.js';

describe('keepProbedFileStat: a file that grew during the scan is read again (real PG)', () => {
    let sql: postgres.Sql;
    let root: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-probed-stat-'));
        return async () => {
            await rm(root, { recursive: true, force: true });
        };
    });

    async function linkedRow(filePath: string): Promise<string> {
        const { id } = await upsertMediaFile(sql, { filePath });
        const [item] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, has_files)
            VALUES ('Partial Copy', 'movie', 'active', true)
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${id}, ${item.id}, true)
        `;
        return id;
    }

    it('stores the pre-processing snapshot, so triage no longer calls the file unchanged', async () => {
        const file = join(root, 'Partial Copy (2020).mkv');
        await writeFile(file, Buffer.alloc(4096, 1));
        const snapshot = await stat(file); // what the probe read
        await appendFile(file, Buffer.alloc(8192, 2)); // the copy finishes
        const fileId = await linkedRow(file);
        await initFileChangeDetection(sql, fileId, file); // commits the FINAL stat

        // Without the fix: the final stat is stored and the file reads unchanged.
        const before = await triageFiles([file], await loadMediaFilesByPrefix(sql, root));
        expect(before.unchanged).toEqual([file]);

        expect(
            await keepProbedFileStat(sql, file, { mtime: snapshot.mtime, size: snapshot.size }),
        ).toBe(true);

        const after = await triageFiles([file], await loadMediaFilesByPrefix(sql, root));
        expect(after.unchanged).toEqual([]);
        expect(after.maybeChanged).toEqual([file]);
    });

    it('restores an unchanged returning track through scanner triage, including its ancestors', async () => {
        const file = join(root, 'Returning.mp3');
        await writeFile(file, Buffer.alloc(4096, 1));
        const ids: string[] = [];
        for (const type of ['artist', 'album', 'track']) {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, parent_id)
                VALUES (${`Returning ${type}`}, ${type}, ${ids.at(-1) ?? null}) RETURNING id
            `;
            ids.push(row.id);
        }
        const { id: fileId } = await upsertMediaFile(sql, { filePath: file });
        await attachFileToItem(sql, fileId, ids[2]);
        await initFileChangeDetection(sql, fileId, file);
        const [original] = await sql`SELECT title, created_at FROM media_items WHERE id = ${ids[2]}`;
        await rename(file, `${file}.offline`);
        await markFileMissing(sql, fileId);
        expect(await sql`SELECT id FROM media_items WHERE id = ANY(${ids}::uuid[]) AND has_files`).toHaveLength(0);

        await rename(`${file}.offline`, file);
        // Identical bytes, size and mtime: no upsert/attach or tag processing.
        const triage = await triageFiles([file], await loadMediaFilesByPrefix(sql, root), undefined, root, sql);
        expect(triage.unchanged).toEqual([file]);
        expect(triage.maybeChanged).toEqual([]);
        expect(await sql`SELECT id FROM media_items WHERE id = ANY(${ids}::uuid[]) AND has_files AND files_lost_at IS NULL`).toHaveLength(3);
        expect((await sql`SELECT title, created_at FROM media_items WHERE id = ${ids[2]}`)[0]).toEqual(original);
        expect((await sql`SELECT is_missing, probed_at FROM media_files WHERE id = ${fileId}`)[0]).toEqual({ is_missing: false, probed_at: null });
    });

    it('leaves a row alone when the stored stat already matches the snapshot', async () => {
        const file = join(root, 'Settled (2020).mkv');
        await writeFile(file, Buffer.alloc(4096, 1));
        const fileId = await linkedRow(file);
        await initFileChangeDetection(sql, fileId, file);
        const snapshot = await stat(file);

        expect(
            await keepProbedFileStat(sql, file, { mtime: snapshot.mtime, size: snapshot.size }),
        ).toBe(false);
        const triage = await triageFiles([file], await loadMediaFilesByPrefix(sql, root));
        expect(triage.unchanged).toEqual([file]);
    });
});
