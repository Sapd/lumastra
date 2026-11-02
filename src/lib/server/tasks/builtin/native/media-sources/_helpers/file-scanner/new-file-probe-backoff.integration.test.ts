// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A NEW file (main or extra) whose content ffprobe rejects as invalid data
 * backs off like every other scan failure (fix plan 6, deferred Task 7
 * item). Before, nothing was recorded for it, so every scan probed it again
 * and counted one more scan error, forever, with nothing on the Ingest Map.
 *
 * Now the first failures record `container_unreadable` on a stub row with the
 * scanner's retry tiers (`nextRetryAtForAttempt`: attempts 1-2 retry at once,
 * then 24 h, then 7 d); inside the window the scan skips the file without
 * probing, and a change on disk (newer mtime) ends the window early.
 *
 * The REAL scanner (`processVideoFile`, `processExtra`), real Postgres, real
 * files and the real ffprobe; nothing in the scanner is mocked.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, copyFile, utimes } from 'node:fs/promises';
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
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import {
    listScanIssues,
    clearUnlinkedFileScanIssue,
} from '../../../../../../database/queries/media-files.queries.js';
import { cleanupOrphanedMediaFiles } from '../../../../../../database/queries/database-cleanup.queries.js';
import type { FileScannerContext } from './shared.js';
import { processVideoFile } from './video-processor.js';
import { processExtra } from './ancillary-processors.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const GARBAGE = 'this is not a media container, just text bytes\n'.repeat(64);
const OLD_MTIME = new Date('2020-01-01T00:00:00Z');

interface IssueRow {
    linked: boolean;
    issue: { type: string; attempt_count?: number; next_retry_at?: string } | null;
}

describe('new-file probe failure backoff (real PG, real ffprobe)', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    const logger = {
        info: (): void => undefined,
        warn: (): void => undefined,
        error: (): void => undefined,
        debug: (): void => undefined,
    };
    let context: FileScannerContext;

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger } as unknown as FileScannerContext;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-probe-backoff-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`probe-backoff-${Date.now()}`})
            RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'movie', ${group.id}, true)
            RETURNING *
        `;
        libraryPath = lp;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function unreadableIssue(filePath: string): Promise<IssueRow> {
        const [row] = await sql<{ linked: boolean; health_issues: IssueRow['issue'][] | null }[]>`
            SELECT mf.health_issues,
                   EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id) AS linked
            FROM media_files mf
            WHERE mf.file_path = ${filePath}
        `;
        return {
            linked: row?.linked ?? false,
            issue: row?.health_issues?.find((i) => i?.type === 'container_unreadable') ?? null,
        };
    }

    async function brokenFile(filePath: string): Promise<void> {
        await writeFile(filePath, GARBAGE);
        await utimes(filePath, OLD_MTIME, OLD_MTIME);
    }

    const scanMain = (filePath: string): ReturnType<typeof processVideoFile> =>
        processVideoFile(sql, filePath, libraryPath, [], context);

    async function mainMovieFile(): Promise<string> {
        const dir = join(root, 'Broken Movie (2021)');
        await mkdir(dir, { recursive: true });
        return join(dir, 'Broken Movie (2021).mkv');
    }

    it('a NEW main file with invalid data backs off after the retry tiers, stays listed, and survives orphan cleanup', async () => {
        const file = await mainMovieFile();
        await brokenFile(file);

        // Attempts 1-2 retry on the next scan; the third sets a 24 h window.
        for (let attempt = 1; attempt <= 3; attempt++) {
            expect(await scanMain(file)).toBe('error');
            const { linked, issue } = await unreadableIssue(file);
            expect(linked).toBe(false);
            expect(issue?.attempt_count).toBe(attempt);
        }
        const recorded = (await unreadableIssue(file)).issue!;
        expect(Date.parse(recorded.next_retry_at!)).toBeGreaterThan(Date.now());

        // Inside the window: skipped, not probed (the attempt count holds).
        expect(await scanMain(file)).toBe('skipped');
        expect((await unreadableIssue(file)).issue?.attempt_count).toBe(3);

        expect((await listScanIssues(sql)).map((r) => r.file_path)).toContain(file);
        await cleanupOrphanedMediaFiles(sql);
        expect((await unreadableIssue(file)).issue?.attempt_count).toBe(3);
    }, 60_000);

    it('a change on disk ends the window: the file is probed again, linked, and the issue cleared', async () => {
        const file = await mainMovieFile();
        await brokenFile(file);
        for (let attempt = 1; attempt <= 3; attempt++) await scanMain(file);
        expect(await scanMain(file)).toBe('skipped');

        await copyFile(FIXTURE, file);
        const now = new Date(Date.now() + 60_000);
        await utimes(file, now, now);

        // 'updated', not 'added': the stub row already exists.
        expect(await scanMain(file)).toBe('updated');
        const after = await unreadableIssue(file);
        expect(after.linked).toBe(true);
        expect(after.issue).toBeNull();
    }, 60_000);

    it('a NEW extra with invalid data backs off the same way', async () => {
        const movieDir = join(root, 'Parent Movie (2020)');
        await mkdir(join(movieDir, 'trailers'), { recursive: true });
        await copyFile(FIXTURE, join(movieDir, 'Parent Movie (2020).mkv'));
        expect(await scanMain(join(movieDir, 'Parent Movie (2020).mkv'))).toBe('added');
        const extra = join(movieDir, 'trailers', 'garbage-trailer.mkv');
        await brokenFile(extra);
        const entry = { filePath: extra, extraType: 'trailer' as const, parentFolder: movieDir };

        for (let attempt = 1; attempt <= 3; attempt++) {
            expect(await processExtra(sql, entry, context)).toBe('error');
            expect((await unreadableIssue(extra)).issue?.attempt_count).toBe(attempt);
        }
        expect(await processExtra(sql, entry, context)).toBe('skipped');
        const held = await unreadableIssue(extra);
        expect(held.issue?.attempt_count).toBe(3);
        expect(held.linked).toBe(false);
    }, 60_000);

    // Controls: GREEN before and after.
    it('control: a NEW file holding real media is linked on the first scan and records nothing', async () => {
        const file = await mainMovieFile();
        await copyFile(FIXTURE, file);
        expect(await scanMain(file)).toBe('added');
        const row = await unreadableIssue(file);
        expect(row.linked).toBe(true);
        expect(row.issue).toBeNull();
    }, 60_000);

    it("control: the scanner's clear leaves a LINKED row's container_unreadable (trickplay's decode verdict) alone", async () => {
        const file = await mainMovieFile();
        await copyFile(FIXTURE, file);
        expect(await scanMain(file)).toBe('added');
        await sql`
            UPDATE media_files
               SET health_issues = ${sql.json([
                   { type: 'container_unreadable', detected_at: new Date().toISOString() },
               ])}
             WHERE file_path = ${file}
        `;
        await clearUnlinkedFileScanIssue(sql, file, 'container_unreadable');
        expect((await unreadableIssue(file)).issue?.type).toBe('container_unreadable');
    }, 60_000);

    it('control: a broken NEW file is never linked', async () => {
        const file = await mainMovieFile();
        await brokenFile(file);
        await scanMain(file);
        expect((await unreadableIssue(file)).linked).toBe(false);
    }, 60_000);
});
