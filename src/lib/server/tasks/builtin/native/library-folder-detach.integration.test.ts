// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * library-folder-detach retires the files of a deleted library folder the
 * way the scanner retires a vanished file: media_files rows go, an item left
 * without files is dismissed (has_files false), and files outside the folder
 * — including a sibling whose name merely starts the same — are untouched.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    attachFileToItem,
    upsertMediaFile,
} from '$lib/server/database/queries/media-files.queries.js';

describe('library-folder-detach task', () => {
    let sql: postgres.Sql;
    let task: typeof import('./media-item-tasks.js').libraryFolderDetachTask;
    const ROOT = `/zz-detach-${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
        sql = getTestDb();
        task = (await import('./media-item-tasks.js')).libraryFolderDetachTask;
    });

    afterAll(async () => {
        await sql`DELETE FROM media_files WHERE file_path LIKE ${ROOT + '%'}`;
        await sql`DELETE FROM media_items WHERE title LIKE 'zz-detach-%'`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_files WHERE file_path LIKE ${ROOT + '%'}`;
        await sql`DELETE FROM media_items WHERE title LIKE 'zz-detach-%'`;
    });

    async function movieWithFile(title: string, filePath: string): Promise<string> {
        const id = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${id}::uuid, ${title}, 'movie', 'active', true)
        `;
        const { id: fileId } = await upsertMediaFile(sql, { filePath });
        await attachFileToItem(sql, fileId, id);
        return id;
    }

    function ctx(input: { path: string }) {
        return {
            sql,
            input,
            signal: new AbortController().signal,
            reportProgress: vi.fn(),
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        };
    }

    it('retires the folder files and leaves everything else alone', async () => {
        const inside = await movieWithFile('zz-detach-inside', `${ROOT}/movies/a/a.mkv`);
        const sibling = await movieWithFile('zz-detach-sibling', `${ROOT}/movies-4k/b.mkv`);

        const result = (await task.execute(ctx({ path: `${ROOT}/movies` }) as never)) as {
            success: boolean;
            itemsProcessed: number;
        };

        expect(result).toMatchObject({ success: true, itemsProcessed: 1 });
        const files = await sql<{ file_path: string }[]>`
            SELECT file_path FROM media_files WHERE file_path LIKE ${ROOT + '%'}
        `;
        expect(files.map((f) => f.file_path)).toEqual([`${ROOT}/movies-4k/b.mkv`]);

        const items = await sql<{ id: string; has_files: boolean; is_dismissed: boolean }[]>`
            SELECT id, has_files, is_dismissed FROM media_items
            WHERE id IN (${inside}::uuid, ${sibling}::uuid)
        `;
        const byId = new Map(items.map((i) => [i.id, i]));
        expect(byId.get(inside)?.has_files).toBe(false);
        expect(byId.get(sibling)).toMatchObject({ has_files: true, is_dismissed: false });
    });

    it('stops without touching files when the folder was added again', async () => {
        await movieWithFile('zz-detach-readded', `${ROOT}/again/c.mkv`);
        const group = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${group}::uuid, 'zz-detach-group')`;
        await sql`
            INSERT INTO library_paths (path, media_type, library_group_id)
            VALUES (${`${ROOT}/again`}, 'movie', ${group}::uuid)
        `;
        try {
            const result = (await task.execute(ctx({ path: `${ROOT}/again` }) as never)) as {
                stopReason?: string;
                result?: { folderReAdded?: boolean };
            };
            expect(result.stopReason).toBe('skipped');
            expect(result.result?.folderReAdded).toBe(true);
            const [{ n }] = await sql<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM media_files WHERE file_path LIKE ${ROOT + '/again/%'}
            `;
            expect(n).toBe(1);
        } finally {
            await sql`DELETE FROM library_paths WHERE path = ${`${ROOT}/again`}`;
            await sql`DELETE FROM library_groups WHERE id = ${group}::uuid`;
        }
    });
});
