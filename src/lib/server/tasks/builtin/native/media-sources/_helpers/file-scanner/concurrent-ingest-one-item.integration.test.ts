// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One file ingested by two processes at once must land on ONE media item.
 *
 * Found on a fresh public-image install with no TMDB key (GPU hw-transcode test,
 * 2026-10-02): five "Test Alpha (2026)/Test Alpha (2026).mkv" folders were copied
 * into the library while a forced file-library-scan and the live file watcher
 * both ingested them. One file ended up linked to TWO personal media_items
 * (created 3 ms apart), so the library showed a duplicate. Both ingest paths
 * end in createPersonalMediaItem, whose "already linked?" check and the
 * insert+attach after it were not atomic.
 *
 * The in-process per-title lock only serializes callers inside one process; the
 * scan and the watcher can run in different processes (or replicas). Each
 * "process" here is a separately imported module instance, so it has its own
 * in-process lock map and only the database can serialize them.
 *
 * Real scanner, real Postgres, real files and real ffprobe; only the metadata
 * provider (none configured) and the lifecycle enqueue are stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, copyFile } from 'node:fs/promises';
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
import type { FileScannerContext } from './shared.js';

vi.mock('../../../../../plugin-context.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProviderConfigured: vi.fn(async () => false),
}));
vi.mock('../../../../../../services/metadata-matching.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    matchFileToMetadata: vi.fn(async () => ({ matched: false })),
}));
vi.mock('../../../../../../services/media-lifecycle.service.js', async (importOriginal) => {
    const actual = await importOriginal<{ MediaLifecycleService: object }>();
    return {
        ...actual,
        MediaLifecycleService: Object.assign(Object.create(actual.MediaLifecycleService), {
            afterMatched: vi.fn(async () => undefined),
        }),
    };
});

// Two module instances = two processes (sequential imports: concurrent dynamic
// imports can bypass vi.mock factories).
const scanProcess = await import('./video-processor.js');
vi.resetModules();
const watcherProcess = await import('./video-processor.js');

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const TMDB = 'tmdb-metadata-provider';
const TITLES = ['Test Alpha', 'Test Beta', 'Test Gamma', 'Test Delta', 'Test Epsilon'];

describe('concurrent ingest of one file by two processes (real PG, real ffprobe)', () => {
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
        root = await mkdtemp(join(tmpdir(), 'lumastra-concurrent-ingest-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`concurrent-ingest-${Date.now()}`})
            RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
            VALUES (${root}, 'movie', ${group.id}, true, 'tmdb')
            RETURNING *
        `;
        libraryPath = lp;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function movieFile(title: string): Promise<string> {
        const folder = `${title} (2026)`;
        const dir = join(root, folder);
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, `${folder}.mp4`);
        await copyFile(FIXTURE, filePath);
        return filePath;
    }

    it('scan and watcher racing on the same new files: each file gets exactly one item', async () => {
        const files = await Promise.all(TITLES.map(movieFile));

        const outcomes = await Promise.all(
            files.flatMap((filePath) => [
                scanProcess.processVideoFile(sql, filePath, libraryPath, [TMDB], context),
                watcherProcess.processVideoFile(sql, filePath, libraryPath, [TMDB], context),
            ]),
        );
        expect(outcomes.every((o) => o === 'added' || o === 'updated')).toBe(true);

        const links = await sql<{ file_path: string; items: number }[]>`
            SELECT mf.file_path, count(mfi.media_item_id)::int AS items
            FROM media_files mf
            LEFT JOIN media_file_items mfi ON mfi.file_id = mf.id
            WHERE mf.file_path = ANY(${files})
            GROUP BY mf.file_path
        `;
        expect(links).toHaveLength(files.length);
        expect(links.filter((l) => l.items !== 1)).toEqual([]);

        const [{ n }] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM media_items WHERE media_type = 'movie'
        `;
        expect(n).toBe(files.length);
    });
});
