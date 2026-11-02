// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A multi-episode file that lost a link is relinked by the next scan even when
 * the file itself is unchanged.
 *
 * `processVideoFile` re-checks every episode a range name (`S01E01E02`)
 * claims and recreates a missing link, but the full scan's triage skips an
 * unchanged file before it gets there. So a combined file that was ever left
 * linked to only part of its range (the second episode created later, a
 * failed write, an old bug) stayed half-linked forever.
 *
 * Real scanner, real Postgres, real ffprobe; only the Valkey progress store is
 * stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

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
import { recordStubIfRangeFullySuperseded } from './multi-episode-links.js';
import * as chapterWriter from '$lib/server/services/file-chapters.service.js';
import * as chapterReader from './scan-chapters.js';
import { scanForSync, requestFileScannerAbortForKey } from '../../file-scanner.js';
import { setManualFileEpisodes } from '$lib/server/services/manual-file-links.service.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');

describe('file scanner — an unchanged multi-episode file is relinked', () => {
    let sql: postgres.Sql;
    let root: string;
    let pathId: string;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'multi-ep-heal-%'`;
        root = mkdtempSync(join(tmpdir(), 'multi-ep-heal-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`multi-ep-heal-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'tv', ${group.id}, true) RETURNING id`;
        pathId = lp.id;
    });
    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

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

    it('recreates the missing link of a combined file on a scan where nothing changed', async () => {
        mkdirSync(join(root, 'Harbor Tales', 'Season 01'), { recursive: true });
        const combined = join(root, 'Harbor Tales', 'Season 01', 'Harbor Tales S01E01E02.mkv');
        copyFileSync(FIXTURE, combined);

        await scanForSync(pathId, { sql, logger } as never);
        expect(await linkedEpisodes(combined)).toEqual([1, 2]);

        // As a matched series: no provider is configured here, so the scan
        // flagged the episodes awaiting a match, which promotes the file out of
        // the unchanged set on its own. A matched library has no such flag.
        await sql`
            UPDATE media_items
               SET custom_metadata = custom_metadata - 'awaiting_provider_match'
                                                     - 'awaiting_provider_match_since'
        `;
        // The file keeps only part of its range (as rows left by an old bug do).
        await sql`
            DELETE FROM media_file_items mfi
             USING media_files mf, media_items mi
             WHERE mfi.file_id = mf.id AND mi.id = mfi.media_item_id
               AND mf.file_path = ${combined} AND mi.episode_number = 2
        `;
        expect(await linkedEpisodes(combined)).toEqual([1]);

        logger.info.mockClear();
        await scanForSync(pathId, { sql, logger } as never);
        // The second scan really did see the file as unchanged: not new, not
        // changed, not awaiting a match.
        const triage = logger.info.mock.calls
            .map((c) => String(c[0]))
            .find((line) => line.includes('File scanner: triage'));
        expect(triage).toMatch(/0 awaiting-rematch/);
        expect(triage).toMatch(/0 maybe-changed, 0 new/);
        expect(await linkedEpisodes(combined)).toEqual([1, 2]);
    });

    it.each(['manual', 'unlinked', 'superseded'])(
        'promotes unchanged chapter gaps and persists full-file chapters while retaining %s mapping',
        async (mapping) => {
            const folder = join(root, 'Lantern Shore', 'Season 01');
            mkdirSync(folder, { recursive: true });
            const filePath = join(
                folder,
                mapping !== 'unlinked'
                    ? 'Lantern Shore S01E01E02.mkv'
                    : 'Lantern Shore S01E15E14.mkv',
            );
            const metadata = join(root, 'chapters.ffmetadata');
            writeFileSync(
                metadata,
                ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=5000\ntitle=Chapter 2\n',
            );
            const mux = spawnSync(
                process.env.FFMPEG_PATH ?? 'ffmpeg',
                [
                    '-y',
                    '-i',
                    FIXTURE,
                    '-f',
                    'ffmetadata',
                    '-i',
                    metadata,
                    '-map_metadata',
                    '1',
                    '-map_chapters',
                    '1',
                    '-c',
                    'copy',
                    filePath,
                ],
                { encoding: 'utf8' },
            );
            expect(mux.status, mux.stderr).toBe(0);
            if (mapping === 'superseded') {
                copyFileSync(FIXTURE, join(folder, 'Lantern Shore S01E01.mkv'));
                copyFileSync(FIXTURE, join(folder, 'Lantern Shore S01E02.mkv'));
            }
            await sql`UPDATE library_paths SET scan_chapters=false WHERE id=${pathId}`;
            await scanForSync(pathId, { sql, logger } as never);
            const [file] = await sql<
                { id: string; duration_seconds: number }[]
            >`SELECT id,duration_seconds FROM media_files WHERE file_path=${filePath}`;
            expect(
                await sql`SELECT id FROM episode_chapters WHERE file_id=${file.id}`,
            ).toHaveLength(0);
            if (mapping === 'manual') {
                const entries = await sql<
                    { media_item_id: string }[]
                >`SELECT media_item_id FROM media_file_items WHERE file_id=${file.id} ORDER BY media_item_id`;
                await setManualFileEpisodes(
                    sql,
                    file.id,
                    entries.map((e) => e.media_item_id),
                    [
                        { startMs: 0, endMs: 2300, boundaryOrigin: 'unknown' },
                        {
                            startMs: 2300,
                            endMs: Math.round(file.duration_seconds * 1000),
                            boundaryOrigin: 'manual',
                        },
                    ],
                );
            }
            if (mapping === 'superseded') expect(await linkedEpisodes(filePath)).toEqual([]);
            const before =
                await sql`SELECT media_item_id,sort_order,start_offset_ms,end_offset_ms,offset_source,boundary_origin FROM media_file_items WHERE file_id=${file.id} ORDER BY media_item_id`;
            await sql`UPDATE media_items SET custom_metadata=custom_metadata-'awaiting_provider_match'-'awaiting_provider_match_since'`;
            await sql`UPDATE library_paths SET scan_chapters=true WHERE id=${pathId}`;
            await scanForSync(pathId, { sql, logger } as never);
            const chapters = await sql<
                { chapter_name: string; start_ticks: number }[]
            >`SELECT chapter_name,start_ticks FROM episode_chapters WHERE file_id=${file.id} ORDER BY chapter_index`;
            expect(chapters.map((c) => c.chapter_name)).toEqual(['Opening', 'Chapter 2']);
            expect(Number(chapters[1].start_ticks)).toBe(20000000);
            const [marked] =
                await sql`SELECT chapters_probed_mtime=file_mtime AND chapters_probed_size=file_size_bytes AS valid FROM media_files WHERE id=${file.id}`;
            expect(marked.valid).toBe(true);
            expect(
                await sql`SELECT media_item_id,sort_order,start_offset_ms,end_offset_ms,offset_source,boundary_origin FROM media_file_items WHERE file_id=${file.id} ORDER BY media_item_id`,
            ).toEqual(before);
        },
    );

    it('caches a successful empty chapter probe in the actual bulk triage', async () => {
        const folder = join(root, 'Lantern Shore', 'Season 01');
        mkdirSync(folder, { recursive: true });
        const filePath = join(folder, 'Lantern Shore S01E01.mkv');
        copyFileSync(FIXTURE, filePath);
        await sql`UPDATE library_paths SET scan_chapters=false WHERE id=${pathId}`;
        await scanForSync(pathId, { sql, logger } as never);
        await sql`UPDATE media_items SET custom_metadata=custom_metadata-'awaiting_provider_match'-'awaiting_provider_match_since'`;
        await sql`UPDATE library_paths SET scan_chapters=true WHERE id=${pathId}`;
        await scanForSync(pathId, { sql, logger } as never);
        const [file] =
            await sql`SELECT id, chapters_probed_mtime, chapters_probed_size FROM media_files WHERE file_path=${filePath}`;
        expect(file.chapters_probed_mtime).not.toBeNull();
        expect(file.chapters_probed_size).not.toBeNull();
        expect(await sql`SELECT id FROM episode_chapters WHERE file_id=${file.id}`).toHaveLength(0);
        logger.info.mockClear();
        await scanForSync(pathId, { sql, logger } as never);
        expect(
            logger.info.mock.calls
                .map((c) => String(c[0]))
                .find((line) => line.includes('File scanner: triage')),
        ).toMatch(/1 unchanged/);
    });

    it.each(['during-first', 'after-first'])(
        'stops superseded physical chapter catch-up on internal cancellation %s',
        async (timing) => {
            const folder = join(root, 'Lantern Shore', 'Season 01');
            mkdirSync(folder, { recursive: true });
            const ranges = ['Lantern Shore S01E01E02.mkv', 'Lantern Shore S01E03E04.mkv'].map(
                (name) => join(folder, name),
            );
            for (const name of ['S01E01', 'S01E02', 'S01E03', 'S01E04'])
                copyFileSync(FIXTURE, join(folder, `Lantern Shore ${name}.mkv`));
            for (const filePath of ranges) copyFileSync(FIXTURE, filePath);
            await sql`UPDATE library_paths SET scan_chapters=false WHERE id=${pathId}`;
            await scanForSync(pathId, { sql, logger } as never);
            const files = await sql<
                { id: string }[]
            >`SELECT id FROM media_files WHERE file_path=ANY(${ranges}::text[]) ORDER BY file_path`;
            expect(files).toHaveLength(2);
            for (const file of files)
                await sql`INSERT INTO episode_chapters(file_id,chapter_index,chapter_name,start_ticks,source) VALUES(${file.id},0,'Prior untrusted chapter',0,'file')`;
            await sql`UPDATE media_items SET custom_metadata=custom_metadata-'awaiting_provider_match'-'awaiting_provider_match_since'`;
            await sql`UPDATE library_paths SET scan_chapters=true WHERE id=${pathId}`;
            // This tests the positively proven skip/catch-up branch. Legacy
            // raw stubs intentionally take the ordinary processing branch.
            const [scope] = await sql<{ season_id: string; library_group_id: string }[]>`
                SELECT ep.parent_id AS season_id, mf.library_group_id FROM media_files mf
                JOIN media_file_items mfi ON mfi.file_id = mf.id JOIN media_items ep ON ep.id = mfi.media_item_id
                WHERE mf.file_path = ${join(folder, 'Lantern Shore S01E01.mkv')}`;
            for (const filePath of ranges)
                await recordStubIfRangeFullySuperseded(
                    sql,
                    filePath,
                    scope.season_id,
                    scope.library_group_id,
                );
            expect(
                (
                    await sql`SELECT current_range_mapping_proof(id) AS current FROM media_files WHERE id = ANY(${files.map((f) => f.id)}::uuid[])`
                ).every((row) => row.current),
            ).toBe(true);
            const original = chapterWriter.replaceProbedFileChapters;
            const read = vi.spyOn(chapterReader, 'readScanChapters');
            let calls = 0;
            vi.spyOn(chapterWriter, 'replaceProbedFileChapters').mockImplementation(
                async (handle, id, probe, path, options) => {
                    if (!files.some((file) => file.id === id))
                        return original(handle, id, probe, path, options);
                    calls++;
                    expect(options?.signal).toBeInstanceOf(AbortSignal);
                    if (timing === 'during-first')
                        expect(requestFileScannerAbortForKey(pathId)).toBe(true);
                    const stored = await original(handle, id, probe, path, options);
                    if (timing === 'after-first')
                        expect(requestFileScannerAbortForKey(pathId)).toBe(true);
                    return stored;
                },
            );
            await scanForSync(pathId, { sql, logger } as never);
            expect(calls).toBe(1);
            expect(read.mock.calls.filter(([path]) => ranges.includes(path))).toHaveLength(1);
            const marked =
                await sql`SELECT id FROM media_files WHERE id=ANY(${files.map((file) => file.id)}::uuid[]) AND chapters_probed_mtime IS NOT NULL`;
            expect(marked).toHaveLength(timing === 'after-first' ? 1 : 0);
            const remaining =
                await sql`SELECT chapter_name FROM episode_chapters WHERE file_id=ANY(${files.map((file) => file.id)}::uuid[])`;
            expect(remaining).toHaveLength(timing === 'after-first' ? 1 : 2);
            expect(remaining.every((row) => row.chapter_name === 'Prior untrusted chapter')).toBe(
                true,
            );
        },
    );
});
