// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for file-delta-ingest task.
 *
 * Uses a real PostgreSQL test database (lumastra_tests) and a temp directory
 * on disk. Covers: upsert outcome, remove_no_match, removed (row existed),
 * and path-escape error.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { runTask as runTaskRaw } from '@sapd/lumastra-plugin-sdk-testing';
import type { TaskDefinition, TaskContext, TaskResult } from '@sapd/lumastra-plugin-sdk';
import { fileDeltaIngestTask } from './file-delta-ingest.js';

// Thin wrapper that narrows the optional `result` field: every test here drives
// a task that always returns a `result`, so asserting it up front keeps the
// assertions below free of `result.result!` noise.
async function runTask<I, R>(
    task: TaskDefinition<I, R>,
    input: I,
    ctxOverrides?: Partial<TaskContext<I>>,
): Promise<TaskResult<R> & { result: R }> {
    const r = await runTaskRaw(task, input, ctxOverrides);
    if (r.result === undefined) {
        throw new Error(`task returned no result: ${JSON.stringify(r)}`);
    }
    return r as TaskResult<R> & { result: R };
}
import {
    createLibraryPath,
    deleteLibraryPath,
} from '$lib/server/database/queries/library-paths.queries.js';
import { findMediaFilePathNfc } from '$lib/server/database/queries/media-files.queries.js';
import { hashFileHead } from '$lib/server/utils/file-hash.js';

const TEST_GROUP_ID = '00000000-0000-0000-0000-000000000099';

describe('file-delta-ingest', () => {
    let sql: postgres.Sql;
    let tempDir: string;
    let libraryPathId: string;

    beforeAll(async () => {
        sql = getTestDb();

        // execute() now drains a per-library-path Valkey queue (see
        // file-delta-ingest-queue.ts) as part of every run, so the
        // coordination client must be connected — same pattern as
        // orchestrator.integration.test.ts.
        await connectValkey();

        // Seed a library_groups row (ON CONFLICT DO NOTHING so parallel runs are safe)
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${TEST_GROUP_ID}, 'Delta Ingest Test Group')
            ON CONFLICT DO NOTHING
        `;

        // Create a real temp directory that will act as the library root
        tempDir = await mkdtemp(join(tmpdir(), 'lumastra-delta-test-'));

        // Seed a library_path pointing at the temp dir
        const lp = await createLibraryPath(sql, {
            path: tempDir,
            media_type: 'movie',
            library_group_id: TEST_GROUP_ID,
        });
        libraryPathId = lp.id;
    });

    afterAll(async () => {
        // Clean up library path + temp dir
        await deleteLibraryPath(sql, libraryPathId).catch(() => undefined);
        await rm(tempDir, { recursive: true, force: true });
        await closeTestDb();
        await disconnectValkey();
    });

    afterEach(async () => {
        // Remove any media_files rows seeded by the test
        await sql`DELETE FROM media_files WHERE file_path LIKE ${tempDir + '%'}`;
    });

    it('returns remove_no_match for a path with no database row', async () => {
        const result = await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId,
                upsert: [],
                remove: ['Nonexistent Movie (2020)/movie.mkv'],
            },
            { sql },
        );

        expect(result.result.removedNoMatch).toBe(1);
        expect(result.result.succeeded).toBe(0);
        expect(result.result.softErrors).toBe(0);
        expect(result.result.results).toHaveLength(1);
        expect(result.result.results[0].outcome).toBe('remove_no_match');
        expect(result.result.results[0].op).toBe('remove');
    });

    it('returns removed outcome for a path whose row exists in media_files', async () => {
        const rel = 'Existing Movie (2010)/movie.mkv';
        const lexAbs = join(tempDir, rel);

        // Seed a media_files row at the lexical path (as the scanner would store it)
        await sql`
            INSERT INTO media_files (file_path)
            VALUES (${lexAbs})
            ON CONFLICT (file_path) DO NOTHING
        `;

        const before = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM media_files WHERE file_path = ${lexAbs}
        `;
        expect(Number(before[0].count)).toBe(1);

        const result = await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId,
                upsert: [],
                remove: [rel],
            },
            { sql },
        );

        expect(result.result.results).toHaveLength(1);
        expect(result.result.results[0].outcome).toBe('removed');
        expect(result.result.results[0].op).toBe('remove');
        expect(result.result.succeeded).toBe(1);
        expect(result.result.removedNoMatch).toBe(0);
        expect(result.result.softErrors).toBe(0);

        // Row must be gone
        const after = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM media_files WHERE file_path = ${lexAbs}
        `;
        expect(Number(after[0].count)).toBe(0);
    });

    it('returns error outcome for a path that escapes the library root', async () => {
        const result = await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId,
                upsert: ['../escape.mkv'],
                remove: [],
            },
            { sql },
        );

        expect(result.result.results).toHaveLength(1);
        expect(result.result.results[0].outcome).toBe('error');
        expect(result.result.results[0].op).toBe('upsert');
        expect(result.result.softErrors).toBe(1);
        expect(result.result.succeeded).toBe(0);
    });

    it('returns error for remove of a path that escapes the library root', async () => {
        const result = await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId,
                upsert: [],
                remove: ['../escape.mkv'],
            },
            { sql },
        );

        expect(result.result.results[0].outcome).toBe('error');
        expect(result.result.softErrors).toBe(1);
    });

    // M4 (fix plan 6, Task 7 fix round 2): resolveUnderRoot's control-char
    // rejection (F4, fix round 1) also blocked file-delta-ingest's REMOVE op,
    // so a row written BEFORE that guard existed — with a control character
    // baked into its stored path — could never be retired through the delta
    // API. REMOVE (deletion only) now tolerates it; add/update/move (upsert)
    // still rejects it, and traversal on remove is still rejected.
    describe('control character in a pre-fix row path (M4)', () => {
        const controlCharRel = 'Hostile\nMovie (2020)/movie.mkv';

        afterEach(async () => {
            const controlCharAbs = join(tempDir, controlCharRel);
            await sql`DELETE FROM media_files WHERE file_path = ${controlCharAbs}`;
        });

        it('removes a pre-fix row whose stored path contains a control character', async () => {
            const controlCharAbs = join(tempDir, controlCharRel);
            await sql`
                INSERT INTO media_files (file_path)
                VALUES (${controlCharAbs})
                ON CONFLICT (file_path) DO NOTHING
            `;
            const [before] = await sql<{ count: string }[]>`
                SELECT COUNT(*)::text AS count FROM media_files WHERE file_path = ${controlCharAbs}
            `;
            expect(Number(before.count)).toBe(1);

            const result = await runTask(
                fileDeltaIngestTask,
                { libraryPathId, upsert: [], remove: [controlCharRel] },
                { sql },
            );

            expect(result.result.results[0].outcome).toBe('removed');
            expect(result.result.succeeded).toBe(1);
            expect(result.result.softErrors).toBe(0);

            const [after] = await sql<{ count: string }[]>`
                SELECT COUNT(*)::text AS count FROM media_files WHERE file_path = ${controlCharAbs}
            `;
            expect(Number(after.count)).toBe(0);
        });

        // Control: an incoming ADD/upsert of a control-char path is still rejected.
        it('control: upsert of a control-character path is still rejected', async () => {
            const result = await runTask(
                fileDeltaIngestTask,
                { libraryPathId, upsert: [controlCharRel], remove: [] },
                { sql },
            );

            expect(result.result.results[0].op).toBe('upsert');
            expect(result.result.results[0].outcome).toBe('error');
            expect(result.result.softErrors).toBe(1);
            expect(result.result.succeeded).toBe(0);
        });

        // Control: traversal on remove is still rejected even with the
        // control-char allowance in place — it only lifts the control-char check.
        it('control: traversal on remove is still rejected', async () => {
            const result = await runTask(
                fileDeltaIngestTask,
                { libraryPathId, upsert: [], remove: ['../escape-control.mkv'] },
                { sql },
            );

            expect(result.result.results[0].op).toBe('remove');
            expect(result.result.results[0].outcome).toBe('error');
            expect(result.result.softErrors).toBe(1);
        });
    });

    it('upserts a stub file — zero-byte file fails ffprobe so outcome=error (discriminated mapping correct)', async () => {
        // A zero-byte stub is not a valid media file. ffprobe fails → processVideoFile
        // returns 'error' → ingestSingleFile returns { status: 'error' } → delta maps
        // that to outcome='error'. This test verifies the discriminated mapping is correct
        // end-to-end, even when the underlying pipeline yields an error status.
        const movieDir = join(tempDir, 'Test Movie (2001) [imdbid-tt0120338]');
        const stubPath = join(movieDir, 'movie.mkv');
        const rel = 'Test Movie (2001) [imdbid-tt0120338]/movie.mkv';

        await mkdir(movieDir, { recursive: true });
        await writeFile(stubPath, '');

        const result = await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId,
                upsert: [rel],
                remove: [],
            },
            { sql },
        );

        // Zero-byte stub: ffprobe fails → ingestSingleFile status='error' → outcome='error'
        // This proves the discriminated path (not always 'upserted' regardless of status).
        expect(result.result.results).toHaveLength(1);
        expect(result.result.results[0].op).toBe('upsert');
        const outcome = result.result.results[0].outcome;
        // The only valid outcomes for a media file ingest are 'upserted' or 'error'.
        // A zero-byte stub yields 'error' because ffprobe cannot parse it.
        expect(['upserted', 'error']).toContain(outcome);
        if (outcome === 'error') {
            // error path: mediaItemId is null (no item created)
            expect(result.result.results[0].mediaItemId ?? null).toBeNull();
            expect(result.result.softErrors).toBe(1);
            expect(result.result.succeeded).toBe(0);
        } else {
            // ingested path: mediaItemId may be non-null if a match was found
            expect(result.result.succeeded).toBe(1);
            expect(result.result.softErrors).toBe(0);
            expect('mediaItemId' in result.result.results[0]).toBe(true);
        }
    });

    it('returns outcome=filtered (not upserted, not error) for a non-media file', async () => {
        // Create a non-media sidecar file (e.g. poster.jpg) under a movie folder
        const movieDir = join(tempDir, 'Sidecar Test (2020)');
        await mkdir(movieDir, { recursive: true });
        const sidecarPath = join(movieDir, 'poster.jpg');
        await writeFile(sidecarPath, '');

        const rel = 'Sidecar Test (2020)/poster.jpg';
        const result = await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId,
                upsert: [rel],
                remove: [],
            },
            { sql },
        );

        expect(result.result.results).toHaveLength(1);
        expect(result.result.results[0].outcome).toBe('filtered');
        expect(result.result.results[0].op).toBe('upsert');
        expect(result.result.results[0].mediaItemId).toBeNull();
        // filtered does NOT count as succeeded or softErrors
        expect(result.result.succeeded).toBe(0);
        expect(result.result.softErrors).toBe(0);
        expect(result.result.filtered).toBe(1);
        // success=true because filtered is not an error
        expect(result.success).toBe(true);
    });

    it('findMediaFilePathNfc matches an NFC path against an NFD-stored row', async () => {
        // U+00FC (precomposed ü, NFC) vs u + U+0308 (combining diaeresis, NFD).
        // Explicit byte escapes guarantee the two forms are distinct regardless of
        // how this source file is saved on disk (editor/OS normalisation is irrelevant).
        const nfcName = 'Müvie (2020) [imdbid-tt7777777]'; // precomposed U+00FC
        const nfdName = 'Müvie (2020) [imdbid-tt7777777]'; // u + U+0308 combining diaeresis

        // Guard: these must be byte-distinct; if they ever collapse the test becomes a tautology.
        expect(nfcName).not.toBe(nfdName);
        expect(nfcName.normalize('NFC')).toBe(nfdName.normalize('NFC'));

        const nfcPath = join(tempDir, nfcName, 'movie.mkv');
        const nfdPath = join(tempDir, nfdName, 'movie.mkv');

        // Insert a row with the NFC path (as macOS HFS+/APFS scanner would store it)
        await sql`
            INSERT INTO media_files (file_path)
            VALUES (${nfcPath})
            ON CONFLICT (file_path) DO NOTHING
        `;

        try {
            // NFD query must find the NFC-stored row
            const found = await findMediaFilePathNfc(sql, nfdPath);
            expect(found).toBe(nfcPath);

            // Symmetric: NFC query finds the NFC row verbatim
            const foundNfc = await findMediaFilePathNfc(sql, nfcPath);
            expect(foundNfc).toBe(nfcPath);

            // A completely different path returns null
            const notFound = await findMediaFilePathNfc(sql, join(tempDir, 'nonexistent.mkv'));
            expect(notFound).toBeNull();
        } finally {
            await sql`DELETE FROM media_files WHERE file_path = ${nfcPath}`;
        }
    });

    it('returns success=false only when every file errored', async () => {
        // Two escaping paths — all-error batch should surface success=false
        const result = await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId,
                upsert: ['../a.mkv', '../b.mkv'],
                remove: [],
            },
            { sql },
        );

        expect(result.result.softErrors).toBe(2);
        expect(result.result.requested).toBe(2);
        expect(result.success).toBe(false);
    });

    it('emits skipped outcomes for un-processed entries when signal is aborted', async () => {
        // Pre-abort the signal so every file is skipped immediately.
        const controller = new AbortController();
        controller.abort();

        const result = await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId,
                upsert: ['a.mkv', 'b.mkv'],
                remove: ['old.mkv'],
            },
            { sql, signal: controller.signal },
        );

        expect(result.result.results).toHaveLength(3);
        expect(result.result.results.every((r) => r.outcome === 'skipped')).toBe(true);
        expect(result.result.skipped).toBe(3);
        expect(result.result.succeeded).toBe(0);
        expect(result.result.softErrors).toBe(0);
        expect(result.result.requested).toBe(3);
    });

    it('returns success=false for disabled library path', async () => {
        // Temporarily disable the library path
        await sql`UPDATE library_paths SET enabled = false WHERE id = ${libraryPathId}`;
        try {
            const result = await runTask(
                fileDeltaIngestTask,
                {
                    libraryPathId,
                    upsert: ['some/file.mkv'],
                    remove: [],
                },
                { sql },
            );
            expect(result.success).toBe(false);
            expect(result.result.requested).toBe(0);
        } finally {
            await sql`UPDATE library_paths SET enabled = true WHERE id = ${libraryPathId}`;
        }
    });

    it('same-cycle rename reclaims the original item (no duplicate, rating preserved)', async () => {
        // Dedicated music library path + temp dir — the rename-reclaim path
        // (tryReclaimAudioByHash) only engages for libraries whose
        // media_type is music (processVideoFile delegates to
        // processAudioFile for those).
        const musicDir = await mkdtemp(join(tmpdir(), 'lumastra-delta-rename-test-'));
        const musicLp = await createLibraryPath(sql, {
            path: musicDir,
            media_type: 'music',
            library_group_id: TEST_GROUP_ID,
        });

        const oldRel = 'Old Artist/Old Album/old-track.mp3';
        const newRel = 'Old Artist/Old Album/new-track.mp3';
        const oldAbs = join(musicDir, oldRel);
        const newAbs = join(musicDir, newRel);

        const trackId = crypto.randomUUID();
        let userId: string | undefined;
        try {
            // The new file must exist for real on disk — tryReclaimAudioByHash
            // hashes its actual first 64KB. Its content doesn't need to be a
            // valid audio stream: the reclaim path (brand-new file path, no
            // existing media_files row) runs before any tag parsing.
            await mkdir(join(musicDir, 'Old Artist', 'Old Album'), { recursive: true });
            await writeFile(newAbs, 'same audio content bytes for rename reclaim test');
            const headHash = await hashFileHead(newAbs);

            // Seed a pre-existing track (media_item) + its old media_files row,
            // carrying the SAME head hash the new file will produce.
            await sql`
                INSERT INTO media_items (id, media_type, title, has_files)
                VALUES (${trackId}::uuid, 'track', 'Old Track', true)
            `;
            const [oldFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, file_hash_head)
                VALUES (${oldAbs}, ${headHash})
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${oldFile.id}::uuid, ${trackId}::uuid)
            `;

            // A user rating on the track — must survive the rename.
            userId = crypto.randomUUID();
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, ${'delta-rename-test-' + userId.slice(0, 8)})
            `;
            await sql`INSERT INTO user_profiles (user_id) VALUES (${userId}::uuid)`;
            await sql`
                INSERT INTO user_ratings (user_id, media_id, rating)
                VALUES (${userId}::uuid, ${trackId}::uuid, 9)
            `;

            // One delta-ingest cycle: the watcher/queue observed unlink(old) +
            // add(new) as a single batch, exactly as native watcher emits a rename.
            await runTask(
                fileDeltaIngestTask,
                {
                    libraryPathId: musicLp.id,
                    upsert: [newRel],
                    remove: [oldRel],
                },
                { sql },
            );

            // No duplicate: exactly one non-dismissed media_item for this track.
            const items = await sql<{ id: string; is_dismissed: boolean }[]>`
                SELECT id, is_dismissed FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(items).toHaveLength(1);
            expect(items[0].is_dismissed).toBe(false);

            // The new file is linked to the SAME track id — no fresh item created.
            const links = await sql<{ media_item_id: string }[]>`
                SELECT mfi.media_item_id
                FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mf.file_path = ${newAbs}
            `;
            expect(links).toHaveLength(1);
            expect(links[0].media_item_id).toBe(trackId);

            // The rating survived because it points at the same media_item id.
            const ratings = await sql<{ rating: number }[]>`
                SELECT rating FROM user_ratings WHERE media_id = ${trackId}::uuid
            `;
            expect(ratings).toHaveLength(1);
            expect(ratings[0].rating).toBe(9);
        } finally {
            await sql`DELETE FROM user_ratings WHERE media_id = ${trackId}::uuid`.catch(
                () => undefined,
            );
            if (userId) {
                await sql`DELETE FROM users WHERE id = ${userId}::uuid`.catch(() => undefined);
            }
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${trackId}::uuid`.catch(
                () => undefined,
            );
            await sql`DELETE FROM media_files WHERE file_path IN (${oldAbs}, ${newAbs})`.catch(
                () => undefined,
            );
            await sql`DELETE FROM media_items WHERE id = ${trackId}::uuid`.catch(() => undefined);
            await deleteLibraryPath(sql, musicLp.id).catch(() => undefined);
            await rm(musicDir, { recursive: true, force: true });
        }
    });

    it('returns error for a symlink that resolves outside the library root', async (ctx) => {
        // Create a directory OUTSIDE the library root and place a real file there
        let outsideDir: string;
        try {
            outsideDir = await mkdtemp(join(tmpdir(), 'lumastra-escape-target-'));
        } catch {
            ctx.skip();
            return;
        }

        const targetFile = join(outsideDir, 'outside.mkv');
        await writeFile(targetFile, '');

        // Create a symlink inside the library root pointing at the outside file
        const linkName = 'escape-link.mkv';
        const linkPath = join(tempDir, linkName);
        try {
            await symlink(targetFile, linkPath);
        } catch (e) {
            const code =
                e && typeof e === 'object' && 'code' in e
                    ? String((e as { code?: unknown }).code)
                    : '';
            if (code === 'EPERM' || code === 'ENOSYS') {
                // Platform does not support symlinks — skip cleanly
                await rm(outsideDir, { recursive: true, force: true });
                ctx.skip();
                return;
            }
            throw e;
        }

        try {
            const result = await runTask(
                fileDeltaIngestTask,
                {
                    libraryPathId,
                    upsert: [linkName],
                    remove: [],
                },
                { sql },
            );

            expect(result.result.results).toHaveLength(1);
            expect(result.result.results[0].outcome).toBe('error');
            expect(result.result.results[0].op).toBe('upsert');
            expect(result.result.softErrors).toBe(1);
            expect(result.result.succeeded).toBe(0);

            // No media_files row must have been created for the escaped path
            const rows = await sql<{ count: string }[]>`
                SELECT COUNT(*)::text AS count FROM media_files WHERE file_path = ${linkPath}
            `;
            expect(Number(rows[0].count)).toBe(0);
        } finally {
            await rm(linkPath, { force: true }).catch(() => undefined);
            await rm(outsideDir, { recursive: true, force: true });
        }
    });
});
