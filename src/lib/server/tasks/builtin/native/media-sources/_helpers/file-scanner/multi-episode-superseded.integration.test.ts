// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A multi-episode file whose every episode has a file of its own ("fully
 * superseded") is remembered, so an unchanged one costs the scan nothing.
 *
 * It never gets a media-item link, so it used to have no `media_files` row
 * and triage saw it as new on every scan: probe, parse and series hierarchy
 * again, for every such file, on every run (all 200 of them on a preprod
 * bench). It now keeps a stub row with a `range_superseded` reason, its stat
 * and the files that cover it. It comes back the moment one of those files is
 * gone: on the next full scan, or right away when the watcher / delta ingest
 * removes that file.
 *
 * Real scanner, real Postgres, real ffprobe; only the Valkey progress store is
 * stubbed for the scans (the delta-ingest test connects to the test Valkey).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { runTask } from '@sapd/lumastra-plugin-sdk-testing';

vi.mock('./progress-store.js', () => ({
    setScanProgress: async () => {},
    getScanProgress: async () => null,
    deleteScanProgress: async () => {},
    getAnyScanProgress: async () => null,
    getAggregateScanProgress: async () => null,
    getScanProgressByKey: async () => new Map(),
}));

import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { scanForSync } from '../../file-scanner.js';
import { fileDeltaIngestTask } from '../../../file-delta-ingest.js';
import { recordRangeSupersededFile } from '$lib/server/database/queries/media-files.queries.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');

describe('file scanner — a fully superseded multi-episode file', () => {
    let sql: postgres.Sql;
    let root: string;
    let season: string;
    let pathId: string;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    beforeAll(async () => {
        sql = getTestDb();
        await connectValkey();
    });
    afterAll(async () => {
        await closeTestDb();
        await disconnectValkey();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'range-superseded-%'`;
        root = mkdtempSync(join(tmpdir(), 'range-superseded-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`range-superseded-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'tv', ${group.id}, true) RETURNING id`;
        pathId = lp.id;
        season = join(root, 'Harbor Tales', 'Season 01');
        mkdirSync(season, { recursive: true });
        for (const name of ['Harbor Tales S01E01.mkv', 'Harbor Tales S01E02.mkv']) {
            copyFileSync(FIXTURE, join(season, name));
        }
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const scan = async (): Promise<string> => {
        logger.info.mockClear();
        await scanForSync(pathId, { sql, logger } as never);
        return logger.info.mock.calls
            .map((c) => String(c[0]))
            .filter((line) => line.includes('File scanner: triage'))
            .join('\n');
    };

    async function linkedEpisodes(filePath: string): Promise<number[]> {
        const rows = await sql<{ n: number }[]>`
            SELECT mi.episode_number AS n
              FROM media_files mf
              JOIN media_file_items mfi ON mfi.file_id = mf.id
              JOIN media_items mi ON mi.id = mfi.media_item_id
             WHERE mf.file_path = ${filePath}
             ORDER BY 1
        `;
        return rows.map((r) => r.n);
    }

    it.each(['S11E15E14', '11x15-14'])(
        'refuses descending %s on initial and existing-file scans without coverage evidence',
        async (range) => {
            const filePath = join(season, `Harbor Tales ${range}.mkv`);
            copyFileSync(FIXTURE, filePath);
            for (let scanIndex = 0; scanIndex < 2; scanIndex++) {
                await scan();
                expect(await linkedEpisodes(filePath)).toEqual([]);
                const [file] = await sql<
                    {
                        health_issues: { type: string }[];
                        duration_seconds: number;
                        container_format: string;
                    }[]
                >`
                SELECT duration_seconds, container_format, health_issues FROM media_files WHERE file_path = ${filePath}`;
                expect(file.health_issues.some((i) => i.type === 'episode_number_unparsed')).toBe(
                    true,
                );
                expect(file.health_issues.some((i) => i.type === 'range_superseded')).toBe(false);
                expect(file.duration_seconds).toBeGreaterThan(0);
                expect(file.container_format).toBeTruthy();
            }
        },
    );

    it('rejects an empty coverage write before creating a stub', async () => {
        const filePath = join(season, 'Harbor Tales S11E15E14.mkv');
        await expect(
            recordRangeSupersededFile(sql, {
                filePath,
                libraryGroupId: null,
                supersededBy: [],
                mtime: new Date(),
                size: 10,
            }),
        ).rejects.toThrow('at least one covering file');
        expect(await sql`SELECT id FROM media_files WHERE file_path = ${filePath}`).toHaveLength(0);
    });

    async function issueTypes(filePath: string): Promise<string[]> {
        const [row] = await sql<{ types: string[] | null }[]>`
            SELECT ARRAY(SELECT jsonb_array_elements(health_issues)->>'type') AS types
              FROM media_files WHERE file_path = ${filePath}
        `;
        return row?.types ?? [];
    }

    /** As a matched series: the scan here has no provider, so it flags episodes awaiting one. */
    async function asMatched(): Promise<void> {
        await sql`
            UPDATE media_items
               SET custom_metadata = custom_metadata - 'awaiting_provider_match'
                                                     - 'awaiting_provider_match_since'
        `;
    }

    /** Scan until the combined file carries its reason (one scan, or two when it was linked first). */
    async function settle(combined: string): Promise<void> {
        for (let i = 0; i < 3 && !(await issueTypes(combined)).includes('range_superseded'); i++) {
            await scan();
        }
        await asMatched();
    }

    it('records the file once and skips it while nothing changed', async () => {
        const combined = join(season, 'Harbor Tales S01E01E02.mkv');
        copyFileSync(FIXTURE, combined);
        await scan();
        await settle(combined);

        expect(await linkedEpisodes(combined)).toEqual([]);
        expect(await issueTypes(combined)).toEqual(['range_superseded']);

        const triage = await scan();
        expect(triage).toMatch(/0 maybe-changed, 0 new/);
        expect(triage).toMatch(/1 superseded-range/);
        expect(await linkedEpisodes(combined)).toEqual([]);
    });

    it('links the file again on the next scan once one of its episode files is deleted', async () => {
        const combined = join(season, 'Harbor Tales S01E01E02.mkv');
        copyFileSync(FIXTURE, combined);
        await scan();
        await settle(combined);
        expect(await issueTypes(combined)).toEqual(['range_superseded']);

        rmSync(join(season, 'Harbor Tales S01E02.mkv'));
        await scan();
        // The missing sibling remains a DB witness until this pass's stale
        // cleanup. Ownership abstains honestly; the next normal scan recovers.
        expect(await linkedEpisodes(combined)).toEqual([]);
        expect(await issueTypes(combined)).toContain('range_superseded');
        expect(
            await sql`SELECT id FROM media_files WHERE file_path = ${join(season, 'Harbor Tales S01E02.mkv')}`,
        ).toHaveLength(0);
        await scan();
        expect(await sql`SELECT id FROM media_items WHERE media_type = 'tv'`).toHaveLength(1);
        expect(await linkedEpisodes(combined)).toEqual([2]);
        expect(await issueTypes(combined)).toEqual([]);
    });

    it('links the file right away when the delta ingest removes one of its episode files', async () => {
        const combined = join(season, 'Harbor Tales S01E01E02.mkv');
        copyFileSync(FIXTURE, combined);
        await scan();
        await settle(combined);
        expect(await issueTypes(combined)).toEqual(['range_superseded']);

        rmSync(join(season, 'Harbor Tales S01E02.mkv'));
        await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId: pathId,
                upsert: [],
                remove: ['Harbor Tales/Season 01/Harbor Tales S01E02.mkv'],
            },
            { sql },
        );

        expect(await linkedEpisodes(combined)).toEqual([2]);
        expect(await issueTypes(combined)).toEqual([]);
    });

    it('links the file again when the second of its covering files is removed later', async () => {
        const combined = join(season, 'Harbor Tales S01E01E02.mkv');
        copyFileSync(FIXTURE, combined);
        await scan();
        await settle(combined);
        expect(await issueTypes(combined)).toEqual(['range_superseded']);

        // First covering file goes: the range file links episode 1 and yields
        // episode 2 to the file that is still there. It is linked now, so its
        // superseded verdict is gone.
        rmSync(join(season, 'Harbor Tales S01E01.mkv'));
        await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId: pathId,
                upsert: [],
                remove: ['Harbor Tales/Season 01/Harbor Tales S01E01.mkv'],
            },
            { sql },
        );
        expect(await linkedEpisodes(combined)).toEqual([1]);
        expect(await issueTypes(combined)).toEqual([]);

        // Second covering file goes: the range file must take episode 2 now,
        // not on the next full scan.
        rmSync(join(season, 'Harbor Tales S01E02.mkv'));
        await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId: pathId,
                upsert: [],
                remove: ['Harbor Tales/Season 01/Harbor Tales S01E02.mkv'],
            },
            { sql },
        );

        expect(await linkedEpisodes(combined)).toEqual([1, 2]);
    });
});
