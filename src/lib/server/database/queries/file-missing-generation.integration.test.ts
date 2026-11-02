// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import { assessFilePresence } from '$lib/server/utils/file-presence.js';
import {
    attachFileToItem,
    getUnprobedFiles,
    markFileMissing,
    restoreMissingFile,
    loadMediaFilesByPrefix,
    upsertMediaFile,
} from './media-files.queries.js';

// Real connections and a real lock wait: neither ordering depends on a timer.
describe('missing observations waiting behind a newer scan', () => {
    it.each(['missing', 'restore'] as const)('attachment and %s use file before item locks', async (operation) => {
        const db = getTestDb();
        const worker = postgres(getTestDatabaseUrl(), { max: 1 });
        const attacher = postgres(getTestDatabaseUrl(), { max: 1 });
        const blocker = postgres(getTestDatabaseUrl(), { max: 1 });
        const [track] = await db<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES (${crypto.randomUUID()}, 'track') RETURNING id
        `;
        const file = await upsertMediaFile(db, { filePath: `/attach-missing/${crypto.randomUUID()}.mp3` });
        await attachFileToItem(db, file.id, track.id);
        if (operation === 'restore') await markFileMissing(db, file.id);
        let release = (): void => {};
        let ready = (): void => {};
        const held = new Promise<void>((resolve) => { ready = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const holding = blocker.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${track.id}))`;
            ready();
            await gate;
        });
        let changing: Promise<boolean> | undefined;
        let attaching: Promise<void> | undefined;
        try {
            await held;
            const [wp] = await worker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            const [ap] = await attacher<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            changing = operation === 'missing'
                ? markFileMissing(worker, file.id, async () => true)
                : restoreMissingFile(worker, file.id, async () => true);
            const waitBlocked = async (pid: number): Promise<void> => {
                await vi.waitFor(async () => {
                    const [row] = await db`SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`;
                    expect(row.blocked).toBe(true);
                });
            };
            await waitBlocked(wp.pid);
            attaching = attachFileToItem(attacher, file.id, track.id);
            await waitBlocked(ap.pid);
            release();
            await holding;
            expect(await changing).toBe(true);
            await attaching;
            expect((await db`SELECT is_missing FROM media_files WHERE id = ${file.id}`)[0].is_missing)
                .toBe(operation === 'missing');
        } finally {
            release();
            await Promise.allSettled([holding, changing, attaching]);
            await Promise.all([worker.end(), attacher.end(), blocker.end()]);
            await db`DELETE FROM media_files WHERE id = ${file.id}`;
            await db`DELETE FROM media_items WHERE id = ${track.id}`;
        }
    });

    it('restores an unchanged returned file when its cached missing flag is stale', async () => {
        const db = getTestDb();
        const root = await mkdtemp(join(tmpdir(), 'lumastra-missing-cache-'));
        const filePath = join(root, 'track.mp3');
        await writeFile(filePath, 'same content');
        const info = await stat(filePath);
        const [track] = await db<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES (${crypto.randomUUID()}, 'track') RETURNING id
        `;
        const file = await upsertMediaFile(db, { filePath });
        try {
            await attachFileToItem(db, file.id, track.id);
            await db`UPDATE media_files SET file_mtime = ${info.mtime}, file_size_bytes = ${info.size},
                     file_hash_head = 'same-head' WHERE id = ${file.id}`;
            const cache = await loadMediaFilesByPrefix(db, root);
            expect(cache.get(filePath)?.is_missing).toBe(false);
            await markFileMissing(db, file.id);
            const { triageFiles } = await import('$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/shared.js');
            const result = await triageFiles([filePath], cache, 200, root, db);
            expect(result.unchanged).toEqual([filePath]);
            expect((await db`SELECT is_missing, probed_at FROM media_files WHERE id = ${file.id}`)[0])
                .toEqual({ is_missing: false, probed_at: null });
            expect((await db`SELECT has_files, files_lost_at FROM media_items WHERE id = ${track.id}`)[0])
                .toEqual({ has_files: true, files_lost_at: null });
        } finally {
            await db`DELETE FROM media_files WHERE id = ${file.id}`;
            await db`DELETE FROM media_items WHERE id = ${track.id}`;
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects a stale probe generation even when the successful scan finished before locking began', async () => {
        const db = getTestDb();
        const [track] = await db<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES (${crypto.randomUUID()}, 'track') RETURNING id
        `;
        const filePath = `/missing-generation/${crypto.randomUUID()}.mp3`;
        const file = await upsertMediaFile(db, { filePath });
        try {
            await attachFileToItem(db, file.id, track.id);
            const observed = (await getUnprobedFiles(db, 100)).find((row) => row.id === file.id);
            expect(observed?.file_version).toBeDefined();
            await upsertMediaFile(db, { filePath });
            const confirm = vi.fn(async () => true);
            expect(await markFileMissing(db, file.id, confirm, observed!.file_version)).toBe(false);
            expect(confirm).not.toHaveBeenCalled();
            expect((await db`SELECT is_missing FROM media_files WHERE id = ${file.id}`)[0].is_missing).toBe(false);
        } finally {
            await db`DELETE FROM media_files WHERE id = ${file.id}`;
            await db`DELETE FROM media_items WHERE id = ${track.id}`;
        }
    });

    it.each(['returned-file', 'new-generation'])('keeps availability after %s', async (kind) => {
        const db = getTestDb();
        const scanner = postgres(getTestDatabaseUrl(), { max: 1 });
        const marker = postgres(getTestDatabaseUrl(), { max: 1 });
        const root = await mkdtemp(join(tmpdir(), 'lumastra-missing-race-'));
        const filePath = join(root, 'track.mp3');
        const [track] = await db<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES (${crypto.randomUUID()}, 'track') RETURNING id
        `;
        const file = await upsertMediaFile(db, { filePath });
        await attachFileToItem(db, file.id, track.id);
        let release: () => void = () => {};
        let ready: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            ready = resolve;
        });
        const unblock = new Promise<void>((resolve) => {
            release = resolve;
        });
        let pending: Promise<boolean> | undefined;
        const writer = scanner.begin(async (tx) => {
            await tx`SELECT id FROM media_files WHERE id = ${file.id} FOR UPDATE`;
            await tx`SELECT pg_advisory_xact_lock(hashtext(${track.id}))`;
            ready();
            await unblock;
            if (kind === 'new-generation') {
                // Even if the path disappeared again, the earlier observation
                // cannot overwrite this newer scanner generation.
                await upsertMediaFile(tx as unknown as postgres.Sql, { filePath });
            }
        });
        try {
            await held;
            const [connection] = await marker<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            expect(await assessFilePresence(filePath)).toBe('missing');
            const confirm = vi.fn(async () => (await assessFilePresence(filePath)) === 'missing');
            pending = markFileMissing(marker, file.id, confirm);
            await vi.waitFor(async () => {
                const [row] = await db<{ blocked: boolean }[]>`
                    SELECT cardinality(pg_blocking_pids(${connection.pid})) > 0 AS blocked
                `;
                expect(row.blocked).toBe(true);
            });
            if (kind === 'returned-file') await writeFile(filePath, 'returned');
            release();
            await writer;
            expect(await pending).toBe(false);
            expect(confirm).toHaveBeenCalledTimes(kind === 'returned-file' ? 1 : 0);
            expect((await db`SELECT is_missing FROM media_files WHERE id = ${file.id}`)[0].is_missing).toBe(false);
            expect(
                (await db`SELECT has_files, files_lost_at FROM media_items WHERE id = ${track.id}`)[0],
            ).toEqual({ has_files: true, files_lost_at: null });
        } finally {
            release();
            await Promise.allSettled([writer, pending]);
            await scanner.end();
            await marker.end();
            await db`DELETE FROM media_files WHERE id = ${file.id}`;
            await db`DELETE FROM media_items WHERE id = ${track.id}`;
            await rm(root, { recursive: true, force: true });
        }
    });
});
