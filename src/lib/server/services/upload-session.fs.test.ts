// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Upload session service against a REAL temp directory — the chunk/finalize
 * guarantees (no overwrite, no truncated assembly, server-owned chunk layout,
 * symlink containment) live in filesystem calls, so mocking `node:fs` would
 * assert nothing. Only the DB queries are faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

vi.mock('$lib/server/config.js', () => ({
    config: {
        MAX_VIDEO_UPLOAD_GB: 50,
        MAX_RESOURCE_UPLOAD_MB: 500,
        MAX_SUBTITLE_UPLOAD_MB: 10,
        MAX_CHAPTER_UPLOAD_MB: 1,
        UPLOAD_CHUNK_SIZE_MB: 1,
        UPLOAD_STAGING_DIR: '',
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const q = vi.hoisted(() => ({
    createUploadSession: vi.fn(),
    incrementChunksReceived: vi.fn(),
    claimUploadSessionForAssembly: vi.fn(),
    releaseUploadSessionAssemblyClaim: vi.fn(),
    finalizeUploadSession: vi.fn(),
    abortUploadSession: vi.fn(),
    deleteUploadSession: vi.fn(),
    findExpiredUploadSessions: vi.fn(),
    deleteExpiredUploadSession: vi.fn(),
}));
vi.mock('$lib/server/database/queries/upload-sessions.queries.js', () => q);

import {
    initUpload,
    writeChunk,
    finalizeUpload,
    validateAncillaryMime,
} from './upload-session.service';
import type { UploadSessionRow } from '$lib/server/database/queries/upload-sessions.queries.js';

const MB = 1024 * 1024;
const sql = vi.fn(async () => []) as unknown as postgres.Sql;

let root: string;
let libraryRoot: string;

function sessionFor(over: Partial<UploadSessionRow>): UploadSessionRow {
    return {
        id: 'u1',
        library_path_id: 'lp1',
        uploader_user: 'admin',
        filename: 'clip.mp4',
        mime_type: 'video/mp4',
        total_size: 0,
        total_chunks: 0,
        chunks_received: 0,
        destination_folder: '',
        staging_dir: join(libraryRoot, '.upload-staging', 'u1'),
        status: 'uploading',
        error_message: null,
        media_item_id: null,
        sha256_expected: null,
        sha256_actual: null,
        created_at: new Date(),
        updated_at: new Date(),
        expires_at: new Date(Date.now() + 86_400_000),
        ...over,
    };
}

/** Writes every chunk of `data` through writeChunk, as the chunk endpoint does. */
async function uploadAll(session: UploadSessionRow, data: Buffer): Promise<void> {
    for (let i = 0; i < session.total_chunks; i++) {
        await writeChunk(sql, session, i, data.subarray(i * MB, (i + 1) * MB));
    }
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'upload-fs-'));
    libraryRoot = join(root, 'lib');
    await mkdir(join(libraryRoot, '.upload-staging', 'u1'), { recursive: true });
    for (const fn of Object.values(q)) fn.mockReset();
    q.createUploadSession.mockImplementation(async (_sql, p) => ({
        ...sessionFor({}),
        ...p,
        id: 'u1',
    }));
    q.incrementChunksReceived.mockResolvedValue(1);
    q.claimUploadSessionForAssembly.mockResolvedValue(true);
    q.releaseUploadSessionAssemblyClaim.mockResolvedValue(undefined);
    q.finalizeUploadSession.mockResolvedValue(undefined);
    q.deleteUploadSession.mockResolvedValue(undefined);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('initUpload', () => {
    const base = {
        libraryPathId: 'lp1',
        uploaderUser: 'admin',
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        destinationFolder: '',
    };

    it('stores the chunk count derived from the size, not the client-declared one', async () => {
        const result = await initUpload({
            sql,
            libraryRoot,
            ...base,
            totalSize: 2 * MB + 5,
            totalChunks: 9999,
        });
        expect(q.createUploadSession.mock.calls[0][1].total_chunks).toBe(3);
        expect(result.chunkSize).toBe(MB);
    });

    it('accepts the MIME types browsers report for every allowed extension', async () => {
        for (const [filename, mimeType] of [
            ['a.wmv', 'video/x-ms-wmv'],
            ['b.ts', 'video/mp2t'],
            ['c.ogv', 'video/ogg'],
            ['d.mkv', 'application/octet-stream'],
        ]) {
            await expect(
                initUpload({
                    sql,
                    libraryRoot,
                    ...base,
                    filename,
                    mimeType,
                    totalSize: 10,
                    totalChunks: 1,
                }),
            ).resolves.toMatchObject({ uploadId: 'u1' });
        }
    });

    it('refuses a target name that already exists (409) before any data is sent', async () => {
        await writeFile(join(libraryRoot, 'clip.mp4'), 'existing');
        await expect(
            initUpload({ sql, libraryRoot, ...base, totalSize: 10, totalChunks: 1 }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(q.createUploadSession).not.toHaveBeenCalled();
    });

    it('rejects hidden destination segments such as another session staging dir', async () => {
        await expect(
            initUpload({
                sql,
                libraryRoot,
                ...base,
                destinationFolder: '.upload-staging/other',
                totalSize: 10,
                totalChunks: 1,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects a destination folder that escapes the library through a symlink', async () => {
        const outside = join(root, 'outside');
        await mkdir(outside);
        await symlink(outside, join(libraryRoot, 'link'));
        await expect(
            initUpload({
                sql,
                libraryRoot,
                ...base,
                destinationFolder: 'link',
                totalSize: 10,
                totalChunks: 1,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects a filename longer than 255 bytes', async () => {
        await expect(
            initUpload({
                sql,
                libraryRoot,
                ...base,
                filename: `${'ä'.repeat(130)}.mp4`,
                totalSize: 10,
                totalChunks: 1,
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('deletes the session row when the staging dir cannot be created', async () => {
        // A FILE where the staging parent dir must go makes mkdir fail.
        await rm(join(libraryRoot, '.upload-staging'), { recursive: true });
        await writeFile(join(libraryRoot, '.upload-staging'), 'not a dir');
        await expect(
            initUpload({ sql, libraryRoot, ...base, totalSize: 10, totalChunks: 1 }),
        ).rejects.toThrow();
        expect(q.deleteUploadSession).toHaveBeenCalledWith(sql, 'u1');
    });
});

describe('writeChunk', () => {
    it('rejects a chunk whose length does not match the session layout', async () => {
        const s = sessionFor({ total_size: 2 * MB + 5, total_chunks: 3 });
        await expect(writeChunk(sql, s, 0, Buffer.alloc(10))).rejects.toMatchObject({
            statusCode: 400,
        });
        await expect(writeChunk(sql, s, 2, Buffer.alloc(6))).rejects.toMatchObject({
            statusCode: 400,
        });
        expect(await readdir(s.staging_dir)).toEqual([]);
    });

    it('counts a retried chunk once and leaves no temp files behind', async () => {
        const s = sessionFor({ total_size: 5, total_chunks: 1, chunks_received: 1 });
        await writeChunk(sql, s, 0, Buffer.from('hello'));
        await writeChunk(sql, s, 0, Buffer.from('hello'));
        expect(q.incrementChunksReceived).toHaveBeenCalledTimes(1);
        expect(await readdir(s.staging_dir)).toEqual(['chunk-000000']);
    });
});

describe('finalizeUpload', () => {
    const data = Buffer.alloc(2 * MB + 5, 7);

    it('assembles the chunks into the library', async () => {
        const s = sessionFor({ total_size: data.length, total_chunks: 3 });
        await uploadAll(s, data);
        const { finalPath } = await finalizeUpload({
            sql,
            session: s,
            libraryRoot,
            expectedTotalChunks: 3,
        });
        expect(finalPath).toBe(join(libraryRoot, 'clip.mp4'));
        expect((await readFile(finalPath)).equals(data)).toBe(true);
    });

    it('refuses a client chunk count that differs from the session (no truncated file)', async () => {
        const s = sessionFor({ total_size: data.length, total_chunks: 3 });
        await writeChunk(sql, s, 0, data.subarray(0, MB));
        await expect(
            finalizeUpload({ sql, session: s, libraryRoot, expectedTotalChunks: 1 }),
        ).rejects.toMatchObject({ statusCode: 422 });
        expect(await readdir(libraryRoot)).not.toContain('clip.mp4');
        expect(q.claimUploadSessionForAssembly).not.toHaveBeenCalled();
    });

    it('never overwrites a file that appeared after init, and hands the session back', async () => {
        const s = sessionFor({ total_size: data.length, total_chunks: 3 });
        await uploadAll(s, data);
        await writeFile(join(libraryRoot, 'clip.mp4'), 'original');
        await expect(
            finalizeUpload({ sql, session: s, libraryRoot, expectedTotalChunks: 3 }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(await readFile(join(libraryRoot, 'clip.mp4'), 'utf8')).toBe('original');
        expect(q.releaseUploadSessionAssemblyClaim).toHaveBeenCalledWith(
            sql,
            'u1',
            expect.stringContaining('already exists'),
        );
        expect(await readdir(s.staging_dir)).not.toContain('_assembled');
    });

    it('releases the claim when the client hash does not match', async () => {
        const s = sessionFor({ total_size: data.length, total_chunks: 3 });
        await uploadAll(s, data);
        await expect(
            finalizeUpload({
                sql,
                session: s,
                libraryRoot,
                expectedTotalChunks: 3,
                clientSha256: 'deadbeef',
            }),
        ).rejects.toMatchObject({ statusCode: 422 });
        expect(q.releaseUploadSessionAssemblyClaim).toHaveBeenCalled();
        expect(q.finalizeUploadSession).not.toHaveBeenCalled();
    });
});

describe('validateAncillaryMime (resource)', () => {
    it('rejects a resource whose name is a video even with an allowed MIME type', () => {
        expect(validateAncillaryMime('resource', 'movie.mp4', 'application/pdf').valid).toBe(false);
        expect(validateAncillaryMime('resource', 'notes.pdf', 'application/pdf').valid).toBe(true);
    });
});
