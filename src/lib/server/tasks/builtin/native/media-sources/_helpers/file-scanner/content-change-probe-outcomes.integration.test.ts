// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ruling T7-probe-outcomes (fix plan 6, Task 7 fix round 3), end to end: the
 * REAL scanner (`processVideoFile`, `processExtra`) against real Postgres,
 * real files on disk and the real ffprobe. Nothing in the scanner is mocked —
 * the unit tests next door mock `onFileContentChanged`, which is exactly how
 * the invalidation wiping `container_unreadable` stayed hidden.
 *
 * - Important-A: an ABORTED probe of a content-changed linked file must write
 *   nothing, so the next scan re-detects the change and the playlist-class
 *   refusal runs. Round 3 reproduced it with an ffconcat body pointing at a
 *   FIFO (ffprobe blocked until the scan was cancelled); since round 4 the
 *   head sniff refuses every concat/HLS body before ffprobe runs, so no such
 *   body can block a probe any more, and the test cancels the scan between
 *   processVideoFile's own entry check and the probe instead.
 * - Important-B: `container_unreadable` survives the probe-data invalidation
 *   the same call performs.
 * - Important-C: a NEW extra whose probe did not return ok is never linked.
 * - Extras: a content change invalidates the extra's probe data, and a later
 *   readable change clears its `container_unreadable`.
 * - N1 (fix round 4, ruling T7-probe-outcomes-2): an ffconcat body whose
 *   nested HLS playlist points at a missing segment makes ffprobe fail with
 *   "Invalid data" — about the REFERENCED file. Classed invalid-data, its hash
 *   was committed and it stayed linked; a later edit of the (non-media)
 *   .m3u8 then pointed playback at another library with no rescan noticing.
 *   The content sniff refuses it on the first scan.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { probeFileForScan, type FileScannerContext } from './shared.js';
import { processVideoFile } from './video-processor.js';
import { processExtra } from './ancillary-processors.js';

const execFileAsync = promisify(execFile);

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const GARBAGE = 'this is not a media container, just text bytes\n'.repeat(64);
const OLD_MTIME = new Date('2020-01-01T00:00:00Z');

/**
 * A signal that reads as not-aborted exactly once — processVideoFile's entry
 * check — and as aborted from then on, so the scan is cancelled after change
 * detection and before the content-change probe, deterministically.
 */
function signalAbortedAfterEntryCheck(): AbortSignal {
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, 'aborted', { get: () => ++reads > 1 });
    return controller.signal;
}

describe('scanner probe-outcome table (real PG, real ffprobe)', () => {
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
        await sql`DELETE FROM library_paths WHERE path LIKE ${join(tmpdir(), 'lumastra-probe-outcomes-') + '%'}`;
        root = await mkdtemp(join(tmpdir(), 'lumastra-probe-outcomes-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`probe-outcomes-${Date.now()}`})
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

    /**
     * Seed a LINKED movie row for `filePath` whose stored stat/hash no longer
     * match the file on disk, so the next scan classifies it `content-changed`.
     */
    async function seedLinkedFile(
        filePath: string,
        extra: { containerFormat?: string } = {},
    ): Promise<{ fileId: string; itemId: string }> {
        const [item] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', 'Probe Outcome Movie', 'active', true)
            RETURNING id
        `;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (
                file_path, library_group_id, file_mtime, file_size_bytes, file_hash_head,
                container_format, probed_at
            )
            VALUES (
                ${filePath}, ${libraryPath.library_group_id}, ${OLD_MTIME}, 1, 'old-hash',
                ${extra.containerFormat ?? null},
                ${extra.containerFormat ? new Date() : null}
            )
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (media_item_id, file_id, is_default)
            VALUES (${item.id}, ${file.id}, true)
        `;
        return { fileId: file.id, itemId: item.id };
    }

    async function fileRow(filePath: string): Promise<{
        id: string;
        file_hash_head: string | null;
        container_format: string | null;
        probed_at: Date | null;
        health_issues: { type: string }[] | null;
        linked: boolean;
    } | null> {
        const [row] = await sql<
            {
                id: string;
                file_hash_head: string | null;
                container_format: string | null;
                probed_at: Date | null;
                health_issues: { type: string }[] | null;
                linked: boolean;
            }[]
        >`
            SELECT mf.id, mf.file_hash_head, mf.container_format, mf.probed_at, mf.health_issues,
                   EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id) AS linked
            FROM media_files mf
            WHERE mf.file_path = ${filePath}
        `;
        return row ?? null;
    }

    const issueTypes = (row: { health_issues: { type: string }[] | null } | null): string[] =>
        (row?.health_issues ?? []).map((i) => i.type);

    const scanMain = (
        filePath: string,
        abortSignal?: AbortSignal,
    ): ReturnType<typeof processVideoFile> =>
        processVideoFile(sql, filePath, libraryPath, [], context, undefined, abortSignal);

    // -----------------------------------------------------------------------
    // Important-A
    // -----------------------------------------------------------------------
    it.each(['valid', 'invalid', 'playlist'])(
        'descending linked changed file keeps physical %s handling before refusing identity',
        async (kind) => {
            libraryPath = { ...libraryPath, media_type: 'tv' };
            const filePath = join(root, 'Lantern Shore S11E15E14.mkv');
            if (kind === 'valid') await copyFile(FIXTURE, filePath);
            else
                await writeFile(
                    filePath,
                    kind === 'invalid'
                        ? GARBAGE
                        : "ffconcat version 1.0\nfile '/fictional/untrusted.mkv'\n",
                );
            const { fileId, itemId } = await seedLinkedFile(filePath);
            const [series] = await sql<
                { id: string }[]
            >`INSERT INTO media_items(media_type,title,status) VALUES('tv','Lantern Shore','active') RETURNING id`;
            const [season] = await sql<
                { id: string }[]
            >`INSERT INTO media_items(media_type,title,status,parent_id,season_number) VALUES('season','Season 11','active',${series.id},11) RETURNING id`;
            await sql`UPDATE media_items SET media_type='episode',parent_id=${season.id},season_number=11,episode_number=15 WHERE id=${itemId}`;
            const outcome = await scanMain(filePath);
            const links =
                await sql`SELECT file_id FROM media_file_items WHERE media_item_id=${itemId}`;
            const row = await fileRow(filePath);
            if (kind === 'playlist') {
                expect(outcome).toBe('error');
                expect(links).toHaveLength(0);
                expect(
                    row?.health_issues?.some((i) => i.type === 'playlist_container_rejected'),
                ).toBe(true);
            } else {
                expect(outcome).toBe('updated');
                expect(links).toHaveLength(1);
                expect(links[0].file_id).toBe(fileId);
                expect(row?.file_hash_head).not.toBe('old-hash');
                expect(row?.health_issues?.some((i) => i.type === 'container_unreadable')).toBe(
                    kind === 'invalid',
                );
            }
        },
    );

    it('Important-A: an aborted probe commits nothing, so the rescan refuses the ffconcat body', async () => {
        const movieDir = join(root, 'Probe Movie (2020)');
        await mkdir(movieDir);
        const main = join(movieDir, 'Probe Movie (2020).mkv');
        await writeFile(main, 'ffconcat version 1.0\nfile sib.mkv\n');
        await copyFile(FIXTURE, join(movieDir, 'sib.mkv'));
        await seedLinkedFile(main);

        // Scan 1 is cancelled after change detection, before the probe.
        const first = await scanMain(main, signalAbortedAfterEntryCheck());

        expect(first).toBe('skipped');
        const afterAbort = await fileRow(main);
        expect(afterAbort?.file_hash_head).toBe('old-hash');
        expect(afterAbort?.linked).toBe(true);
        expect(issueTypes(afterAbort)).toEqual([]);

        // Scan 2: the change is still pending, so the probe runs and
        // retires the linked row.
        const second = await scanMain(main);

        expect(second).toBe('error');
        const afterRescan = await fileRow(main);
        expect(afterRescan?.linked).toBe(false);
        expect(issueTypes(afterRescan)).toContain('playlist_container_rejected');
    }, 30_000);

    // Control (green before and after): with no abort, the same body is
    // refused on the first scan.
    it('control: an ffconcat body referencing real media is refused without any abort', async () => {
        const movieDir = join(root, 'Concat Movie (2020)');
        await mkdir(movieDir);
        const main = join(movieDir, 'Concat Movie (2020).mkv');
        await writeFile(main, 'ffconcat version 1.0\nfile sib.mkv\n');
        await copyFile(FIXTURE, join(movieDir, 'sib.mkv'));
        await seedLinkedFile(main);

        expect(await scanMain(main)).toBe('error');
        const row = await fileRow(main);
        expect(row?.linked).toBe(false);
        expect(issueTypes(row)).toContain('playlist_container_rejected');
    }, 30_000);

    // -----------------------------------------------------------------------
    // Important-B
    // -----------------------------------------------------------------------
    it('Important-B: a linked file changed into garbage keeps container_unreadable and commits its hash', async () => {
        const movieDir = join(root, 'Garbage Movie (2020)');
        await mkdir(movieDir);
        const main = join(movieDir, 'Garbage Movie (2020).mkv');
        await writeFile(main, GARBAGE);
        await seedLinkedFile(main, { containerFormat: 'matroska,webm' });

        expect(await scanMain(main)).toBe('updated');

        const row = await fileRow(main);
        expect(issueTypes(row)).toContain('container_unreadable');
        expect(row?.file_hash_head).not.toBe('old-hash');
        expect(row?.linked).toBe(true);
        // The invalidation ran: the stale container_format is gone.
        expect(row?.container_format).toBeNull();
    }, 30_000);

    // Control (green before and after): a readable content change records
    // no container_unreadable.
    it('control: a linked file changed into real media records no container_unreadable', async () => {
        const movieDir = join(root, 'Real Movie (2020)');
        await mkdir(movieDir);
        const main = join(movieDir, 'Real Movie (2020).mkv');
        await copyFile(FIXTURE, main);
        await seedLinkedFile(main, { containerFormat: 'matroska,webm' });

        expect(await scanMain(main)).toBe('updated');

        const row = await fileRow(main);
        expect(issueTypes(row)).not.toContain('container_unreadable');
        expect(row?.linked).toBe(true);
    }, 30_000);

    // -----------------------------------------------------------------------
    // Extras
    // -----------------------------------------------------------------------
    async function seedParentMovie(): Promise<{ movieDir: string; itemId: string }> {
        const movieDir = join(root, 'Parent Movie (2020)');
        await mkdir(join(movieDir, 'trailers'), { recursive: true });
        const main = join(movieDir, 'Parent Movie (2020).mkv');
        await copyFile(FIXTURE, main);
        const { itemId } = await seedLinkedFile(main);
        return { movieDir, itemId };
    }

    it('Important-C: a NEW extra whose probe fails is never linked', async () => {
        const { movieDir } = await seedParentMovie();
        const extra = join(movieDir, 'trailers', 'garbage-trailer.mkv');
        await writeFile(extra, GARBAGE);

        const outcome = await processExtra(
            sql,
            { filePath: extra, extraType: 'trailer', parentFolder: movieDir },
            context,
        );

        expect(outcome).toBe('error');
        expect((await fileRow(extra))?.linked ?? false).toBe(false);
    }, 30_000);

    // Control (green before and after): a readable new extra is linked.
    it('control: a NEW extra holding real media is linked', async () => {
        const { movieDir } = await seedParentMovie();
        const extra = join(movieDir, 'trailers', 'real-trailer.mkv');
        await copyFile(FIXTURE, extra);

        const outcome = await processExtra(
            sql,
            { filePath: extra, extraType: 'trailer', parentFolder: movieDir },
            context,
        );

        expect(outcome).toBe('added');
        expect((await fileRow(extra))?.linked).toBe(true);
    }, 30_000);

    it("extras: a content change invalidates the extra's probe data, and a readable change clears container_unreadable", async () => {
        const { movieDir } = await seedParentMovie();
        const extra = join(movieDir, 'trailers', 'changing-trailer.mkv');
        await writeFile(extra, GARBAGE);
        await seedLinkedFile(extra, { containerFormat: 'matroska,webm' });
        const entry = { filePath: extra, extraType: 'trailer' as const, parentFolder: movieDir };

        // Change 1: garbage — probe data invalidated, issue recorded.
        await processExtra(sql, entry, context);
        const afterGarbage = await fileRow(extra);
        expect(afterGarbage?.container_format).toBeNull();
        expect(afterGarbage?.probed_at).toBeNull();
        expect(issueTypes(afterGarbage)).toContain('container_unreadable');

        // Change 2: real media — the issue clears.
        await rm(extra);
        await copyFile(FIXTURE, extra);
        await processExtra(sql, entry, context);
        const afterReal = await fileRow(extra);
        expect(issueTypes(afterReal)).not.toContain('container_unreadable');
        expect(afterReal?.linked).toBe(true);
    }, 30_000);

    // -----------------------------------------------------------------------
    // N1 (fix round 4)
    // -----------------------------------------------------------------------
    it('N1: an ffconcat body whose nested playlist fails "Invalid data" is refused, and stays refused after the playlist is edited', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'lumastra-other-lib-'));
        try {
            const secret = join(outside, 'secret.mkv');
            await copyFile(FIXTURE, secret);
            const movieDir = join(root, 'Nested Movie (2020)');
            await mkdir(movieDir);
            const main = join(movieDir, 'Nested Movie (2020).mkv');
            const playlist = join(movieDir, 'v.m3u8');
            await writeFile(main, 'ffconcat version 1.0\nfile v.m3u8\n');
            await writeFile(
                playlist,
                '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nnotyet.mkv\n#EXT-X-ENDLIST\n',
            );
            await seedLinkedFile(main, { containerFormat: 'matroska,webm' });

            expect(await scanMain(main)).toBe('error');
            const afterFirst = await fileRow(main);
            expect(afterFirst?.linked).toBe(false);
            expect(issueTypes(afterFirst)).toContain('playlist_container_rejected');

            // The non-media sibling is edited to point outside the library;
            // A's own bytes do not change.
            await writeFile(
                playlist,
                `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${secret}\n#EXT-X-ENDLIST\n`,
            );
            // The row is an unlinked stub now, so the rescan takes the
            // new-file path — and refuses again.
            expect(await scanMain(main)).toBe('error');
            expect((await fileRow(main))?.linked).toBe(false);
        } finally {
            await rm(outside, { recursive: true, force: true });
        }
    }, 60_000);

    it('N1: an HLS body inside a .mkv (which ffprobe itself would not detect as HLS) is refused on content change', async () => {
        const movieDir = join(root, 'Hls Movie (2020)');
        await mkdir(movieDir);
        const main = join(movieDir, 'Hls Movie (2020).mkv');
        await writeFile(
            main,
            '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:9/seg.ts\n#EXT-X-ENDLIST\n',
        );
        await seedLinkedFile(main, { containerFormat: 'matroska,webm' });

        expect(await scanMain(main)).toBe('error');
        const row = await fileRow(main);
        expect(row?.linked).toBe(false);
        expect(issueTypes(row)).toContain('playlist_container_rejected');
    }, 30_000);

    it('N1: a NEW extra with an HLS body is refused with a recorded issue', async () => {
        const { movieDir } = await seedParentMovie();
        const extra = join(movieDir, 'trailers', 'hls-trailer.mkv');
        await writeFile(extra, '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg.ts\n');

        await processExtra(
            sql,
            { filePath: extra, extraType: 'trailer', parentFolder: movieDir },
            context,
        );

        const row = await fileRow(extra);
        expect(row?.linked ?? false).toBe(false);
        expect(issueTypes(row)).toContain('playlist_container_rejected');
    }, 30_000);

    // Controls (green before and after): real containers stay ok, garbage
    // stays invalid-data, and a binary file that merely contains "file"
    // mid-line is not refused.
    describe('controls through the real ffprobe', () => {
        it.each([
            ['mp4', ['-c', 'copy']],
            ['mkv', ['-c', 'copy']],
            ['webm', ['-c:v', 'libvpx', '-b:v', '200k', '-an']],
        ])(
            'a real %s is ok',
            async (ext, codecArgs) => {
                const out = join(root, `real.${ext}`);
                await execFileAsync('ffmpeg', [
                    '-v',
                    'error',
                    '-y',
                    '-i',
                    FIXTURE,
                    ...codecArgs,
                    out,
                ]);
                expect((await probeFileForScan(out)).kind).toBe('ok');
            },
            60_000,
        );

        it('a garbage binary file is invalid-data', async () => {
            const p = join(root, 'garbage.mkv');
            await writeFile(
                p,
                Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) & 0xff)),
            );
            expect(await probeFileForScan(p)).toMatchObject({
                kind: 'failed',
                failure: 'invalid-data',
            });
        }, 30_000);

        it('a binary file containing "file" mid-line is not refused', async () => {
            const p = join(root, 'binary-with-file.mkv');
            const head = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x13, 0x37]);
            await writeFile(
                p,
                Buffer.concat([head, Buffer.from('xxfile yy'), Buffer.alloc(2048, 0x7f)]),
            );
            expect((await probeFileForScan(p)).kind).not.toBe('refused');
        }, 30_000);
    });
});
