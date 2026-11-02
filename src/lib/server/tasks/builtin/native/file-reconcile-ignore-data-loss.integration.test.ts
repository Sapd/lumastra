// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression (bug F): a file that is STILL PRESENT on disk but is newly
 * excluded by the ignore policy (a `.lumastraignore` was added to its folder)
 * must not lose its `media_files` row.
 *
 * Shape of the bug: `file-reconcile` diffs its own walk against the DB's known
 * paths. The walk honors `.lumastraignore`, so a file that exists on disk but
 * was just ignored vanishes from the walk listing while its row is still in
 * `media_files` — reconcile reads that as "removed from disk" and dispatches a
 * `file-delta-ingest` remove for it. The delta run deletes the row WITHOUT
 * checking that the file still exists on disk, so the user's item (and its
 * dismissal state) is destroyed for a file that is sitting right there.
 *
 * Expected behaviour: reconcile→delta must never delete the row of a file that
 * still exists on disk (hiding/skipping it is fine). Today the pipeline
 * deletes it, so the assertion below is red.
 *
 * Drives the real chain: real walk + real reconcile execute (orchestrator
 * dispatch captured via vi.mock, exactly the payload reconcile hands to
 * file-delta-ingest) + the real file-delta-ingest execute against that
 * payload, against a real Postgres + Valkey.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { runTask } from '@sapd/lumastra-plugin-sdk-testing';
import { walkDirectoryWithResult } from '$lib/server/utils/walk-directory.js';
import {
    createLibraryPath,
    deleteLibraryPath,
} from '$lib/server/database/queries/library-paths.queries.js';
import { fileReconcileTask } from './file-reconcile.js';
import { fileDeltaIngestTask } from './file-delta-ingest.js';

// Capture the file-delta-ingest payloads reconcile dispatches via the
// orchestrator (instead of really queueing a run), so the test can feed the
// EXACT payload reconcile produced into the real delta execute below.
const { dispatched, startRunMock } = vi.hoisted(() => {
    const dispatched: Array<{ taskId: string; input: Record<string, unknown> }> = [];
    const startRunMock = vi.fn(
        async (taskId: string, input: unknown, _opts: unknown): Promise<unknown> => {
            dispatched.push({ taskId, input: input as Record<string, unknown> });
            return { runId: 'mock-delta-run', deduped: false };
        },
    );
    return { dispatched, startRunMock };
});

vi.mock('../../orchestrator.js', () => ({
    orchestrator: { startRun: startRunMock },
}));

const TEST_GROUP_ID = '00000000-0000-0000-0000-000000000098';

describe('file-reconcile: ignore-excluded file that still exists on disk', () => {
    let sql: postgres.Sql;
    let tempDir: string;
    let libraryPathId: string;

    beforeAll(async () => {
        sql = getTestDb();
        // reconcile's recently-skipped lookup + delta's queue drain both go
        // through requireClient() — same pattern as the delta integration test.
        await connectValkey();

        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${TEST_GROUP_ID}, 'Reconcile Ignore Test Group')
            ON CONFLICT DO NOTHING
        `;
        tempDir = await mkdtemp(join(tmpdir(), 'lumastra-reconcile-ignore-'));
        const lp = await createLibraryPath(sql, {
            path: tempDir,
            media_type: 'movie',
            library_group_id: TEST_GROUP_ID,
        });
        libraryPathId = lp.id;
    });

    afterAll(async () => {
        await sql`DELETE FROM media_file_items WHERE file_id IN
                  (SELECT id FROM media_files WHERE file_path LIKE ${tempDir + '%'})`.catch(
            () => undefined,
        );
        await sql`DELETE FROM media_items WHERE title LIKE 'IgnoreTest %'`.catch(() => undefined);
        await sql`DELETE FROM media_files WHERE file_path LIKE ${tempDir + '%'}`.catch(
            () => undefined,
        );
        await deleteLibraryPath(sql, libraryPathId).catch(() => undefined);
        await rm(tempDir, { recursive: true, force: true });
        await closeTestDb();
        await disconnectValkey();
    });

    it('keeps the media_files row of a still-present file that was just newly ignored', async () => {
        // Two movies on disk, both with pre-existing media_files rows (as if
        // ingested by an earlier scan). After the rows were written, the admin
        // added a .lumastraignore to ONE folder — the file is still on disk,
        // it is merely hidden from the walk now.
        const normalAbs = join(tempDir, 'Normal (2021)', 'movie.mkv');
        const ignoredAbs = join(tempDir, 'Ignored (2020)', 'movie.mkv');
        const ignoredRel = 'Ignored (2020)/movie.mkv';

        await mkdir(join(tempDir, 'Normal (2021)'), { recursive: true });
        await mkdir(join(tempDir, 'Ignored (2020)'), { recursive: true });
        await writeFile(normalAbs, 'x');
        await writeFile(ignoredAbs, 'x');
        await writeFile(join(tempDir, 'Ignored (2020)', '.lumastraignore'), '*.mkv\n');

        await sql`
            INSERT INTO media_files (file_path) VALUES (${normalAbs})
            ON CONFLICT (file_path) DO NOTHING
        `;
        const [ignoredItem] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', 'IgnoreTest Newly Ignored', 'active', true)
            RETURNING id
        `;
        const [ignoredFile] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${ignoredAbs})
            ON CONFLICT (file_path) DO NOTHING
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (media_item_id, file_id, is_default)
            VALUES (${ignoredItem.id}, ${ignoredFile.id}, true)
        `;

        // Setup preflight (true today AND after any fix): the walk genuinely
        // excludes the ignored file even though it exists on disk — that is
        // precisely the asymmetry that makes reconcile propose its removal.
        const walk = await walkDirectoryWithResult(tempDir);
        expect(walk.hadErrors).toBe(false);
        expect(walk.files).toContain(normalAbs);
        expect(walk.files).not.toContain(ignoredAbs);

        // 1. Real reconcile execute (targeted to this library path).
        const reconcileResult = await runTask(fileReconcileTask, { libraryPathId }, { sql });
        expect(reconcileResult.success).toBe(true);

        // 2. Feed the payload reconcile dispatched into the REAL delta execute,
        //    exactly as the orchestrator+runner would.
        const deltaDispatch = dispatched.find((d) => d.taskId === 'file-delta-ingest');
        const removePayload = Array.isArray(deltaDispatch?.input['remove'])
            ? (deltaDispatch?.input['remove'] as string[])
            : [];
        const upsertPayload = Array.isArray(deltaDispatch?.input['upsert'])
            ? (deltaDispatch?.input['upsert'] as string[])
            : [];
        let deltaOutcomes = 'no delta run dispatched';
        if (deltaDispatch) {
            const deltaResult = await runTask(
                fileDeltaIngestTask,
                { libraryPathId, upsert: upsertPayload, remove: removePayload },
                { sql },
            );
            deltaOutcomes = JSON.stringify(
                (deltaResult.result?.results ?? []).map((r) => ({
                    path: r.path,
                    outcome: r.outcome,
                })),
            );
        }

        // Control: the non-ignored file's row is untouched (setup sanity).
        const [normalAfter] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM media_files WHERE file_path = ${normalAbs}
        `;
        expect(Number(normalAfter.count)).toBe(1);

        // The bug assertion: the still-present, merely-ignored file keeps its
        // row. Red today: reconcile lists it in `remove` and the delta run
        // deletes the row without checking the file still exists.
        const [ignoredAfter] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM media_files WHERE file_path = ${ignoredAbs}
        `;
        expect(
            Number(ignoredAfter.count),
            `bug F: reconcile→file-delta-ingest deleted the media_files row of ${ignoredRel} ` +
                `although the file is still on disk (it is only newly .lumastraignore-excluded). ` +
                `remove payload=${JSON.stringify(removePayload)}, ` +
                `delta outcomes=${deltaOutcomes}, ` +
                `reconcile result=${JSON.stringify(reconcileResult.result)}`,
        ).toBe(1);

        // And the item it was attached to must not have been soft-dismissed.
        const [itemAfter] = await sql<{ is_dismissed: boolean }[]>`
            SELECT is_dismissed FROM media_items WHERE id = ${ignoredItem.id}
        `;
        expect(
            itemAfter.is_dismissed,
            `bug F: the item behind the still-present ignored file was soft-dismissed ` +
                `by the bogus remove (is_dismissed=true means its user data was unlinked)`,
        ).toBe(false);
    });
});
