// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ruling T7-music (fix plan 6, Task 7 fix round 5): a music library never
 * sniffed. `processAudioFile` reads tags with music-metadata, which accepts a
 * text body, so an ffconcat script or a DASH manifest saved as `.mp3`/`.m4a`/
 * `.flac` was LINKED as a track. The music-transcode input
 * (`-protocol_whitelist file -i <track>`) then followed ffconcat → `.m3u8` →
 * an absolute path into another directory and played the foreign track.
 *
 * Drives the REAL scanner (`processVideoFile` → `processAudioFile`) against
 * real Postgres and real files; real audio is generated with ffmpeg.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
import type { FileScannerContext } from './shared.js';
import { processVideoFile } from './video-processor.js';

const execFileAsync = promisify(execFile);

// Pass-through spy: counts the content sniffs a scan performs.
vi.mock('$lib/server/utils/playlist-sniff.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/playlist-sniff.js')>();
    return { ...actual, sniffFileForPlaylist: vi.fn(actual.sniffFileForPlaylist) };
});
import { sniffFileForPlaylist } from '$lib/server/utils/playlist-sniff.js';

const FFCONCAT = 'ffconcat version 1.0\nfile v.m3u8\n';
const MPD =
    '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"></MPD>\n';

async function makeAudio(out: string, codecArgs: string[], title: string): Promise<void> {
    await execFileAsync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        ...codecArgs,
        '-metadata',
        `title=${title}`,
        '-metadata',
        'artist=Sniff Artist',
        '-metadata',
        'album=Sniff Album',
        out,
    ]);
}

describe('music scanner refuses playlist bodies (real PG)', () => {
    let sql: postgres.Sql;
    let root: string;
    let outside: string;
    let albumDir: string;
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
        root = await mkdtemp(join(tmpdir(), 'lumastra-music-sniff-'));
        outside = await mkdtemp(join(tmpdir(), 'lumastra-music-other-'));
        albumDir = join(root, 'Sniff Artist', 'Sniff Album');
        await mkdir(albumDir, { recursive: true });
        // The foreign track the playlist chain points at, and the chain's
        // middle link, next to the scanned file.
        const foreign = join(outside, 'foreign.mp3');
        await makeAudio(foreign, ['-c:a', 'libmp3lame'], 'Foreign');
        await writeFile(
            join(albumDir, 'v.m3u8'),
            `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\n${foreign}\n#EXT-X-ENDLIST\n`,
        );
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`music-sniff-${Date.now()}`})
            RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'music', ${group.id}, true)
            RETURNING *
        `;
        libraryPath = lp;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    const scan = (filePath: string): ReturnType<typeof processVideoFile> =>
        processVideoFile(sql, filePath, libraryPath, [], context);

    async function fileState(
        filePath: string,
    ): Promise<{ linked: boolean; issues: string[] } | null> {
        const [row] = await sql<{ linked: boolean; health_issues: { type: string }[] | null }[]>`
            SELECT EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id) AS linked,
                   mf.health_issues
            FROM media_files mf
            WHERE mf.file_path = ${filePath}
        `;
        if (!row) return null;
        return { linked: row.linked, issues: (row.health_issues ?? []).map((i) => i.type) };
    }

    it.each([
        ['an ffconcat body saved as .mp3', '01 Concat.mp3', FFCONCAT],
        ['an ffconcat body saved as .m4a', '02 Concat.m4a', FFCONCAT],
        ['an ffconcat body saved as .flac', '03 Concat.flac', FFCONCAT],
        ['a DASH manifest saved as .mp3', '04 Manifest.mp3', MPD],
    ])(
        '%s is never linked, and the refusal is recorded',
        async (_label, name, body) => {
            const p = join(albumDir, name);
            await writeFile(p, body);

            expect(await scan(p)).toBe('error');

            const state = await fileState(p);
            expect(state?.linked ?? false).toBe(false);
            expect(state?.issues).toContain('playlist_container_rejected');
        },
        60_000,
    );

    it('a linked track whose content changes into an ffconcat body is retired', async () => {
        const p = join(albumDir, '05 Changing.mp3');
        await makeAudio(p, ['-c:a', 'libmp3lame'], 'Changing');
        expect(await scan(p)).toBe('added');
        expect((await fileState(p))?.linked).toBe(true);

        await writeFile(p, FFCONCAT);

        expect(await scan(p)).toBe('error');
        const state = await fileState(p);
        expect(state?.linked ?? false).toBe(false);
        expect(state?.issues).toContain('playlist_container_rejected');
    }, 60_000);

    // Controls (green before and after): real audio is linked.
    it.each([
        ['mp3', '06 Real.mp3', ['-c:a', 'libmp3lame']],
        ['flac', '07 Real.flac', ['-c:a', 'flac']],
        ['m4a', '08 Real.m4a', ['-c:a', 'aac']],
    ])(
        'control: a real %s is linked',
        async (_label, name, codecArgs) => {
            const p = join(albumDir, name);
            await makeAudio(p, codecArgs, name);

            expect(await scan(p)).toBe('added');
            expect((await fileState(p))?.linked).toBe(true);
        },
        60_000,
    );

    // Unchanged tracks are never sniffed: the sniff runs on the new-file and
    // content-changed paths only, both after change detection.
    it('an unchanged linked track is not sniffed on a rescan', async () => {
        const p = join(albumDir, '09 Unchanged.mp3');
        await makeAudio(p, ['-c:a', 'libmp3lame'], 'Unchanged');
        const sniffs = vi.mocked(sniffFileForPlaylist);
        sniffs.mockClear();

        expect(await scan(p)).toBe('added');
        expect(sniffs).toHaveBeenCalledTimes(1);

        sniffs.mockClear();
        expect(await scan(p)).toBe('skipped');
        expect(await scan(p)).toBe('skipped');
        expect(sniffs).not.toHaveBeenCalled();
    }, 60_000);
});
