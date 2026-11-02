// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cancelling a scan kills a REAL in-flight ffprobe (fix plan 6, deferred
 * Task 7 item). The pieces — the scan's signal reaching `probeMediaFile`,
 * and an aborted probe writing nothing — are unit-covered; this is the
 * end-to-end check that they meet.
 *
 * A FIFO named like a movie passes the content sniff (a non-regular file is
 * left to ffprobe) and blocks ffprobe on open, with no writer, until its 15 s
 * timeout. The test waits until that ffprobe process exists, cancels the scan
 * and expects: the scan returns `skipped` well inside the timeout, ffprobe is
 * gone, and nothing about the file was written. Real scanner, real Postgres,
 * real ffprobe.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
import type { FileScannerContext } from './shared.js';
import { processVideoFile } from './video-processor.js';
import { processExtra } from './ancillary-processors.js';

const execFileAsync = promisify(execFile);

/**
 * Pids of running ffprobe processes whose command line contains `needle`,
 * matched as a plain substring (`pgrep -f` would read the path's parentheses
 * as a regex).
 */
async function pidsMatching(needle: string): Promise<number[]> {
    // CI hosts have huge compiler command lines. Filter by executable before
    // capturing arguments, rather than buffering the whole host's process list.
    const filtered = process.platform === 'linux';
    const args = filtered
        ? ['-C', basename(process.env.FFPROBE_PATH || 'ffprobe'), '-o', 'pid=,command=']
        : ['-ax', '-o', 'pid=,command='];
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync('ps', args));
    } catch (error) {
        // procps reports no matching processes with status1 and empty output.
        if (
            filtered &&
            error instanceof Error &&
            'code' in error &&
            error.code === 1 &&
            'stdout' in error &&
            error.stdout === '' &&
            'stderr' in error &&
            error.stderr === ''
        )
            return [];
        throw error;
    }
    return stdout
        .split('\n')
        .filter((l) => l.includes('ffprobe') && l.includes(needle))
        .map((l) => Number.parseInt(l.trim(), 10))
        .filter((n) => Number.isFinite(n));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
}

describe('scan cancel kills an in-flight ffprobe (real PG, real ffprobe)', () => {
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
        root = await mkdtemp(join(tmpdir(), 'lumastra-scan-abort-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`scan-abort-${Date.now()}`})
            RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'movie', ${group.id}, true)
            RETURNING *
        `;
        libraryPath = lp;
        return async () => {
            // A probe that outlived a failed assertion must not leak.
            for (const pid of await pidsMatching(root)) {
                try {
                    process.kill(pid, 'SIGKILL');
                } catch {
                    /* already gone */
                }
            }
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function fifo(path: string): Promise<void> {
        execFileSync('mkfifo', [path]);
    }

    async function cancelOnceProbing<T>(
        fifoPath: string,
        run: (signal: AbortSignal) => Promise<T>,
    ): Promise<{ outcome: T; elapsedMs: number }> {
        const controller = new AbortController();
        const started = Date.now();
        const pending = run(controller.signal);
        const probing = await waitFor(async () => (await pidsMatching(fifoPath)).length > 0, 5000);
        expect(probing).toBe(true);
        controller.abort();
        const outcome = await pending;
        return { outcome, elapsedMs: Date.now() - started };
    }

    async function nothingWritten(filePath: string): Promise<void> {
        const rows = await sql`SELECT 1 FROM media_files WHERE file_path = ${filePath}`;
        expect(rows).toHaveLength(0);
    }

    it('a new main file: the scan returns skipped at once, ffprobe is killed, nothing is written', async () => {
        const dir = join(root, 'Blocking Movie (2021)');
        await mkdir(dir, { recursive: true });
        const file = join(dir, 'Blocking Movie (2021).mkv');
        await fifo(file);

        const { outcome, elapsedMs } = await cancelOnceProbing(file, (signal) =>
            processVideoFile(sql, file, libraryPath, [], context, undefined, signal),
        );

        expect(outcome).toBe('skipped');
        expect(elapsedMs).toBeLessThan(10_000);
        expect(await waitFor(async () => (await pidsMatching(file)).length === 0, 2000)).toBe(true);
        await nothingWritten(file);
    }, 30_000);

    it('a new extra: the same', async () => {
        const movieDir = join(root, 'Parent Movie (2020)');
        await mkdir(join(movieDir, 'trailers'), { recursive: true });
        const extra = join(movieDir, 'trailers', 'blocking-trailer.mkv');
        await fifo(extra);

        const { outcome, elapsedMs } = await cancelOnceProbing(extra, (signal) =>
            processExtra(
                sql,
                { filePath: extra, extraType: 'trailer', parentFolder: movieDir },
                context,
                signal,
            ),
        );

        expect(outcome).toBe('skipped');
        expect(elapsedMs).toBeLessThan(10_000);
        expect(await waitFor(async () => (await pidsMatching(extra)).length === 0, 2000)).toBe(
            true,
        );
        await nothingWritten(extra);
    }, 30_000);
});
