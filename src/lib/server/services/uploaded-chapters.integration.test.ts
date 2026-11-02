// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { latestMediaChange } from '$lib/server/database/queries/admin-media-change.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, it, expect, vi } from 'vitest';
const publication = vi.hoisted(() => ({
    beforeWrite: null as null | (() => Promise<void>),
    afterWrite: null as null | (() => Promise<void>),
}));
vi.mock('$lib/server/utils/contained-fs.js', async (original) => {
    const actual = await original<typeof import('$lib/server/utils/contained-fs.js')>();
    return {
        ...actual,
        writeFileNoFollow: async (...args: Parameters<typeof actual.writeFileNoFollow>) => {
            await publication.beforeWrite?.();
            await actual.writeFileNoFollow(...args);
            await publication.afterWrite?.();
        },
    };
});
afterEach(() => {
    publication.beforeWrite = null;
    publication.afterWrite = null;
});
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    saveUploadedChapters,
    undoUploadedChapters,
    publishSidecar,
} from './uploaded-chapters.service.js';
const sql = getTestDb();
afterAll(closeTestDb);
it('replaces and clears uploaded chapters, recovers exact rows and bytes, and protects manual chapters', async () => {
    const owner = randomUUID(),
        file = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'chapter-upload-'));
    const path = join(dir, 'Lantern Crossing.chapters.json');
    try {
        await sql`INSERT INTO media_items(id,title,media_type) VALUES (${owner},'Lantern Crossing','episode')`;
        await sql`INSERT INTO media_files(id,file_path) VALUES (${file},${join(dir, 'Lantern Crossing.mkv')})`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id) VALUES (${file},${owner})`;
        const first = Buffer.from('[{"title":"Arrival","startMs":1200}]');
        await saveUploadedChapters(
            sql,
            owner,
            file,
            path,
            first,
            JSON.parse(first.toString()),
            'admin',
        );
        const original = await sql`SELECT * FROM episode_chapters WHERE file_id=${file}`;
        expect(original[0].start_ticks).toBe(12000000);
        const failedCommit = {
            begin: async (callback: (tx: postgres.Sql) => Promise<unknown>) =>
                withTx(sql, async (tx) => {
                    await callback(tx);
                    throw new Error('Database commit refused');
                }),
        } as unknown as postgres.Sql;
        await expect(
            saveUploadedChapters(failedCommit, owner, file, path, Buffer.from('[]'), [], 'admin'),
        ).rejects.toThrow('Database commit refused');
        expect(await readFile(path)).toEqual(first);
        expect(await sql`SELECT * FROM episode_chapters WHERE file_id=${file}`).toEqual(original);
        const receipt = await saveUploadedChapters(
            sql,
            owner,
            file,
            path,
            Buffer.from('[]'),
            [],
            'admin',
        );
        expect(await sql`SELECT * FROM episode_chapters WHERE file_id=${file}`).toEqual([]);
        expect(await readFile(path, 'utf8')).toBe('[]');
        await undoUploadedChapters(sql, owner, file, receipt);
        expect(await sql`SELECT * FROM episode_chapters WHERE file_id=${file}`).toEqual(original);
        expect(await readFile(path)).toEqual(first);
        await undoUploadedChapters(sql, owner, file, receipt);
        const stale = await saveUploadedChapters(
            sql,
            owner,
            file,
            path,
            Buffer.from('[]'),
            [],
            'admin',
        );
        await sql`UPDATE media_files SET file_size_bytes=54321 WHERE id=${file}`;
        await expect(undoUploadedChapters(sql, owner, file, stale)).rejects.toThrow('changed');
        await sql`UPDATE media_files SET file_size_bytes=NULL WHERE id=${file}`;
        await undoUploadedChapters(sql, owner, file, stale);
        await sql`UPDATE episode_chapters SET source='manual' WHERE file_id=${file}`;
        await expect(
            saveUploadedChapters(sql, owner, file, path, Buffer.from('[]'), [], 'admin'),
        ).rejects.toThrow('Manual');
        expect(await readFile(path)).toEqual(first);
    } finally {
        await sql`DELETE FROM media_items WHERE id=${owner}`;
        await sql`DELETE FROM media_files WHERE id=${file}`;
        await rm(dir, { recursive: true, force: true });
    }
});
it('leaves no sidecar after DB failure and never replaces bytes without a receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sidecar-upload-'));
    const path = join(dir, 'Lantern.srt');
    try {
        await expect(
            publishSidecar(path, Buffer.from('new'), async () => {
                throw new Error('DB failed');
            }),
        ).rejects.toThrow('DB failed');
        await expect(access(path)).rejects.toThrow();
        await writeFile(path, 'old');
        await expect(
            publishSidecar(path, Buffer.from('new'), async () => undefined),
        ).rejects.toThrow('already exists');
        expect(await readFile(path, 'utf8')).toBe('old');
        await expect(
            publishSidecar(path, Buffer.from('resource'), async () => undefined),
        ).rejects.toThrow('already exists');
        expect(await readFile(path, 'utf8')).toBe('old');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

it('commits the byte recovery receipt before replacing a chapter file and can recover an interrupted publish', async () => {
    const owner = randomUUID(),
        file = randomUUID();
    const dir = await mkdtemp(join(tmpdir(), 'chapter-durable-'));
    const path = join(dir, 'Moonlit Pier.chapters.json');
    const old = Buffer.from('[{"title":"Arrival","startMs":0}]');
    try {
        await sql`INSERT INTO media_items(id,title,media_type) VALUES (${owner},'Moonlit Pier','movie')`;
        await sql`INSERT INTO media_files(id,file_path) VALUES (${file},${join(dir, 'Moonlit Pier.mkv')})`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id) VALUES (${file},${owner})`;
        const previousReceipt = await saveUploadedChapters(
            sql,
            owner,
            file,
            path,
            old,
            JSON.parse(old.toString()),
            'admin',
        );
        const original = await sql`SELECT * FROM episode_chapters WHERE file_id=${file}`;
        publication.beforeWrite = async () => {
            // An independent pooled connection must see the COMMITTED receipt.
            const rows =
                await sql`SELECT id,before_state FROM admin_media_change_receipts WHERE owner=${owner} AND after_state->>'bytes'=${Buffer.from('[]').toString('base64')}`;
            expect(rows).toHaveLength(1);
            expect(rows[0].before_state.bytes).toBe(old.toString('base64'));
            throw new Error('Publication interrupted');
        };
        await expect(
            saveUploadedChapters(sql, owner, file, path, Buffer.from('[]'), [], 'admin'),
        ).rejects.toThrow('Publication interrupted');
        publication.beforeWrite = null;
        const [receipt] =
            await sql`SELECT id FROM admin_media_change_receipts WHERE owner=${owner} AND after_state->>'bytes'=${Buffer.from('[]').toString('base64')}`;
        expect(receipt).toBeDefined();
        // A committed intent is recovery evidence, not an undoable publication.
        expect(await latestMediaChange(sql, owner, `file-chapters:${file}`)).toBe(previousReceipt);
        expect(await readFile(path)).toEqual(old);
        await undoUploadedChapters(sql, owner, file, receipt.id);
        expect(await sql`SELECT * FROM episode_chapters WHERE file_id=${file}`).toEqual(original);
        expect(await readFile(path)).toEqual(old);
        // A crash after rename rolls back the publication transaction, while
        // the previously committed intent still contains the original bytes.
        publication.afterWrite = async () => {
            throw new Error('Crash after rename');
        };
        await expect(
            saveUploadedChapters(sql, owner, file, path, Buffer.from('[]'), [], 'admin'),
        ).rejects.toThrow('Crash after rename');
        publication.afterWrite = null;
        expect(await readFile(path, 'utf8')).toBe('[]');
        expect(await sql`SELECT * FROM episode_chapters WHERE file_id=${file}`).toEqual(original);
        const [interrupted] =
            await sql`SELECT id FROM admin_media_change_receipts WHERE owner=${owner} AND after_state->>'bytes'=${Buffer.from('[]').toString('base64')} AND undone_at IS NULL`;
        // A normal upload retry must recover that pending publication without
        // requiring the lost response's receipt id to be entered anywhere.
        const replacement = Buffer.from('[{"title":"The quay","startMs":50}]');
        const retried = await saveUploadedChapters(
            sql,
            owner,
            file,
            path,
            replacement,
            JSON.parse(replacement.toString()),
            'admin',
        );
        await undoUploadedChapters(sql, owner, file, retried);
        expect(await readFile(path)).toEqual(old);
        const [recovered] =
            await sql`SELECT undone_at FROM admin_media_change_receipts WHERE id=${interrupted.id}`;
        expect(recovered.undone_at).not.toBeNull();
        // A successful COMMIT whose acknowledgement is lost must retain both
        // the published bytes and its completed receipt, not restore old bytes.
        let commits = 0;
        const lostAck = {
            begin: async (callback: (tx: postgres.Sql) => Promise<unknown>) => {
                const value = await withTx(sql, callback);
                if (++commits === 2) throw new Error('Commit acknowledgement lost');
                return value;
            },
        } as unknown as postgres.Sql;
        await expect(
            saveUploadedChapters(lostAck, owner, file, path, Buffer.from('[]'), [], 'admin'),
        ).rejects.toThrow('Commit acknowledgement lost');
        expect(await readFile(path, 'utf8')).toBe('[]');
        expect(await sql`SELECT * FROM episode_chapters WHERE file_id=${file}`).toEqual([]);
        const [committed] =
            await sql`SELECT id FROM admin_media_change_receipts WHERE owner=${owner} AND after_state->>'bytes'=${Buffer.from('[]').toString('base64')} AND undone_at IS NULL`;
        await undoUploadedChapters(sql, owner, file, committed.id);
        expect(await readFile(path)).toEqual(old);
        // A savepoint cannot satisfy the independent durable-receipt boundary.
        await withTx(sql, async (tx) => {
            await expect(
                saveUploadedChapters(tx, owner, file, path, Buffer.from('[]'), [], 'admin'),
            ).rejects.toThrow('independent committed recovery receipt');
        });
        // A crash during Undo also leaves a durable, resumable receipt.
        const next = await saveUploadedChapters(
            sql,
            owner,
            file,
            path,
            Buffer.from('[]'),
            [],
            'admin',
        );
        publication.afterWrite = async () => {
            const [durable] =
                await sql`SELECT before_state,undone_at FROM admin_media_change_receipts WHERE id=${next}`;
            expect(durable.before_state.bytes).toBe(old.toString('base64'));
            expect(durable.undone_at).toBeNull();
            throw new Error('Undo publication interrupted');
        };
        await expect(undoUploadedChapters(sql, owner, file, next)).rejects.toThrow(
            'Undo publication interrupted',
        );
        publication.afterWrite = null;
        await undoUploadedChapters(sql, owner, file, next);
        expect(await sql`SELECT * FROM episode_chapters WHERE file_id=${file}`).toEqual(original);
        expect(await readFile(path)).toEqual(old);
    } finally {
        publication.beforeWrite = null;
        publication.afterWrite = null;
        await sql`DELETE FROM media_items WHERE id=${owner}`;
        await sql`DELETE FROM media_files WHERE id=${file}`;
        await rm(dir, { recursive: true, force: true });
    }
});
