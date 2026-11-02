// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A file linked to its episodes by hand keeps its order and windows.
 *
 * The SpongeBob S9 shape: `S09E20-21` actually holds 9x20 and then 9x19. The
 * scanner links it to 9x20 + 9x21 from the name, and automatic segments would
 * put 9x19 first even if the links were right (they sort by episode number).
 * An admin fixes it by hand; a rescan, a segment refresh and a full segment
 * rebuild must all leave the fix alone, and playing 9x19 must start at the
 * second window.
 *
 * Real scanner, real Postgres, real ffprobe; only the Valkey progress store is
 * stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, utimesSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';

vi.mock(
    '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/progress-store.js',
    () => ({
        setScanProgress: async () => {},
        getScanProgress: async () => null,
        deleteScanProgress: async () => {},
        getAnyScanProgress: async () => null,
        getAggregateScanProgress: async () => null,
        getScanProgressByKey: async () => new Map(),
    }),
);

import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { scanForSync } from '$lib/server/tasks/builtin/native/media-sources/file-scanner.js';
import {
    rebuildAllFileSegments,
    refreshSegmentsForFile,
} from '$lib/server/database/queries/file-segments.queries.js';
import { getFileSiblingEpisodes } from '$lib/server/database/queries/episode-search.queries.js';
import {
    attachFileToItem,
    deleteStaleMediaFile,
    promoteHighestQualityVersion,
} from '$lib/server/database/queries/media-files.queries.js';
import { isManuallyLinkedFile } from '$lib/server/database/queries/file-segments.queries.js';
import { resolveEpisodeEntryPoint } from '$lib/server/utils/episode-entry-point.js';
import { clearManualFileEpisodes, setManualFileEpisodes } from './manual-file-links.service.js';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');

/** A 22-minute double; the fixture is 5 s, so the stored duration is set by hand. */
const DURATION_MS = 1_320_000;
const HALF_MS = 660_000;

interface LinkRow {
    episode_number: number;
    sort_order: number;
    is_default: boolean;
    start_offset_ms: string | null;
    end_offset_ms: string | null;
    offset_source: string | null;
}

describe('manual file → episode links', () => {
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
        await sql`DELETE FROM library_groups WHERE name LIKE 'manual-links-%'`;
        root = mkdtempSync(join(tmpdir(), 'manual-links-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`manual-links-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'tv', ${group.id}, true) RETURNING id`;
        pathId = lp.id;
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    async function links(fileId: string): Promise<LinkRow[]> {
        return sql<LinkRow[]>`
            SELECT mi.episode_number, mfi.sort_order, mfi.is_default,
                   mfi.start_offset_ms::text AS start_offset_ms,
                   mfi.end_offset_ms::text AS end_offset_ms,
                   mfi.offset_source
              FROM media_file_items mfi
              JOIN media_items mi ON mi.id = mfi.media_item_id
             WHERE mfi.file_id = ${fileId}
             ORDER BY mfi.sort_order, mi.episode_number
        `;
    }

    async function episodeId(n: number): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE media_type = 'episode' AND episode_number = ${n}`;
        return row.id;
    }

    /** Scan the double, then shape it like the prod rows: 9x19 exists without a file. */
    async function seedDouble(): Promise<{ fileId: string; filePath: string }> {
        mkdirSync(join(root, 'Bikini Show', 'Season 09'), { recursive: true });
        const filePath = join(root, 'Bikini Show', 'Season 09', 'Bikini Show S09E20-21.mkv');
        copyFileSync(FIXTURE, filePath);
        await scanForSync(pathId, { sql, logger } as never);

        const [file] = await sql<{ id: string }[]>`
            SELECT id FROM media_files WHERE file_path = ${filePath}`;
        // A matched series: no provider is configured here, so the scan flagged
        // the episodes awaiting a match, which would promote the file out of
        // the unchanged set on its own.
        await sql`
            UPDATE media_items
               SET custom_metadata = custom_metadata - 'awaiting_provider_match'
                                                     - 'awaiting_provider_match_since'
        `;
        await sql`UPDATE media_files SET duration_seconds = ${DURATION_MS / 1000} WHERE id = ${file.id}`;
        const [season] = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE media_type = 'season' AND season_number = 9`;
        await sql`
            INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number)
            VALUES ('The Executive Treatment', 'episode', 'active', ${season.id}, 9, 19)`;
        return { fileId: file.id, filePath };
    }

    const expectedManual = [
        {
            episode_number: 20,
            sort_order: 0,
            is_default: true,
            start_offset_ms: '0',
            end_offset_ms: String(HALF_MS),
            offset_source: 'manual',
        },
        {
            episode_number: 19,
            sort_order: 1,
            is_default: true,
            start_offset_ms: String(HALF_MS),
            end_offset_ms: String(DURATION_MS),
            offset_source: 'manual',
        },
    ];

    it('keeps [9x20, 9x19] and its windows through a rescan, a segment refresh and a rebuild', async () => {
        const { fileId, filePath } = await seedDouble();
        expect((await links(fileId)).map((l) => l.episode_number)).toEqual([20, 21]);

        const ep20 = await episodeId(20);
        const ep19 = await episodeId(19);
        const result = await setManualFileEpisodes(
            sql,
            fileId,
            [ep20, ep19],
            [
                { startMs: 0, endMs: HALF_MS },
                // Off by 400 ms from the stored duration: snapped to it.
                { startMs: HALF_MS, endMs: DURATION_MS - 400 },
            ],
        );
        expect(result.ok).toBe(true);
        expect(await links(fileId)).toEqual(expectedManual);

        // 9x21 lost its only file.
        const [ep21] = await sql<{ has_files: boolean }[]>`
            SELECT has_files FROM media_items WHERE media_type = 'episode' AND episode_number = 21`;
        expect(ep21.has_files).toBe(false);

        // Rescan with the file unchanged: the range check would otherwise
        // re-create the 9x21 link the name claims.
        await scanForSync(pathId, { sql, logger } as never);
        expect(await links(fileId)).toEqual(expectedManual);

        // Rescan after a touch (metadata-only change: re-stat, chapters).
        const later = new Date(Date.now() + 60_000);
        utimesSync(filePath, later, later);
        await scanForSync(pathId, { sql, logger } as never);
        expect(await links(fileId)).toEqual(expectedManual);

        // Segment refresh (chapter sync, re-probe) and the full rebuild.
        await refreshSegmentsForFile(sql, fileId);
        expect(await links(fileId)).toEqual(expectedManual);
        await rebuildAllFileSegments(sql);
        expect(await links(fileId)).toEqual(expectedManual);

        // A better-looking version does not take 9x19's playback away: without
        // stream rows the ranking falls back to duration, which favours it.
        const [other] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, duration_seconds)
            VALUES (${join(root, 'elsewhere', 'Bikini Show S09E19.mkv')}, 5000)
            RETURNING id`;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${other.id}, ${ep19}, false)`;
        await promoteHighestQualityVersion(sql, ep19);
        expect(await links(fileId)).toEqual(expectedManual);

        // Playing 9x19 opens the file at the second window (the composition
        // info.service uses for the playback entry point), and the file lists
        // 9x20 first.
        const siblings = await getFileSiblingEpisodes(sql, ep19);
        expect(siblings.map((s) => s.episode_number)).toEqual([20, 19]);
        expect(resolveEpisodeEntryPoint(siblings, ep19)).toEqual({
            streamStartPositionMs: HALF_MS,
            clientShouldSeek: true,
            episodeNumberStart: 19,
            episodeNumberEnd: 20,
        });
        expect(resolveEpisodeEntryPoint(siblings, ep20).streamStartPositionMs).toBe(0);
    });

    it('rejects windows that do not cover the file, and episodes of another series', async () => {
        const { fileId } = await seedDouble();
        const ep20 = await episodeId(20);
        const ep19 = await episodeId(19);

        const gap = await setManualFileEpisodes(
            sql,
            fileId,
            [ep20, ep19],
            [
                { startMs: 0, endMs: 600_000 },
                { startMs: HALF_MS, endMs: DURATION_MS },
            ],
        );
        expect(gap).toEqual({ ok: false, reason: 'invalid', message: expect.any(String) });

        const [other] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status) VALUES ('Other Show', 'tv', 'active')
            RETURNING id`;
        const wrongSeries = await setManualFileEpisodes(
            sql,
            fileId,
            [ep20, ep19],
            [
                { startMs: 0, endMs: HALF_MS },
                { startMs: HALF_MS, endMs: DURATION_MS },
            ],
            { seriesId: other.id },
        );
        expect(wrongSeries).toEqual({
            ok: false,
            reason: 'invalid',
            message: 'All episodes must belong to the same series.',
        });

        // Nothing was written.
        expect((await links(fileId)).map((l) => l.offset_source)).toEqual([null, null]);
    });

    it('a scan attach that checked before an admin save does not add a link after it', async () => {
        const { fileId } = await seedDouble();
        const ep20 = await episodeId(20);
        const ep19 = await episodeId(19);
        const ep21 = await episodeId(21);

        // The scan's range repair: not manual yet, so it goes on to attach.
        expect(await isManuallyLinkedFile(sql, fileId)).toBe(false);
        // The admin saves in between.
        await setManualFileEpisodes(
            sql,
            fileId,
            [ep20, ep19],
            [
                { startMs: 0, endMs: HALF_MS },
                { startMs: HALF_MS, endMs: DURATION_MS },
            ],
        );
        // The scan's attach for the name's second episode runs now.
        await attachFileToItem(sql, fileId, ep21);
        expect(await links(fileId)).toEqual(expectedManual);
    });

    it('a scan attach that waits on an admin save in flight sees the save', async () => {
        const { fileId } = await seedDouble();
        const ep20 = await episodeId(20);
        const ep19 = await episodeId(19);
        const ep21 = await episodeId(21);

        let attachDone = false;
        let releaseSave: () => void = () => {};
        const saveHeld = new Promise<void>((resolve) => (releaseSave = resolve));
        let saveLocked: () => void = () => {};
        const locked = new Promise<void>((resolve) => (saveLocked = resolve));

        // An admin save holding the file row, as setManualFileEpisodes does,
        // with 9x21 already removed and the set marked manual.
        const save = sql.begin(async (tx) => {
            await tx`SELECT id FROM media_files WHERE id = ${fileId} FOR UPDATE`;
            await tx`DELETE FROM media_file_items WHERE file_id = ${fileId} AND media_item_id = ${ep21}`;
            await tx`
                UPDATE media_file_items SET offset_source = 'manual'
                WHERE file_id = ${fileId} AND media_item_id = ${ep20}`;
            await tx`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order, offset_source)
                VALUES (${fileId}, ${ep19}, true, 1, 'manual')`;
            saveLocked();
            await saveHeld;
        });
        await locked;
        const attach = attachFileToItem(sql, fileId, ep21).then(() => {
            attachDone = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        // The attach waits for the save instead of slipping in before it.
        expect(attachDone).toBe(false);
        releaseSave();
        await save;
        await attach;

        const after = await links(fileId);
        expect(after.map((l) => l.episode_number)).toEqual([20, 19]);
    });

    it('a window-only edit emits file.windowChanged in the same transaction (outbox on)', async () => {
        const [prior] = await sql<{ value: string }[]>`
            SELECT value FROM feature_flags WHERE key = 'event_outbox_enabled'`;
        await sql`
            INSERT INTO feature_flags (key, value) VALUES ('event_outbox_enabled', 'on')
            ON CONFLICT (key) DO UPDATE SET value = 'on'`;
        try {
            const { fileId } = await seedDouble();
            const ep20 = await episodeId(20);
            const ep19 = await episodeId(19);
            await setManualFileEpisodes(
                sql,
                fileId,
                [ep20, ep19],
                [
                    { startMs: 0, endMs: HALF_MS },
                    { startMs: HALF_MS, endMs: DURATION_MS },
                ],
            );
            await sql`DELETE FROM event_outbox`;

            // Same episodes, same defaults: only the boundary moves.
            await setManualFileEpisodes(
                sql,
                fileId,
                [ep20, ep19],
                [
                    { startMs: 0, endMs: HALF_MS + 4_000 },
                    { startMs: HALF_MS + 4_000, endMs: DURATION_MS },
                ],
            );
            const events = await sql<{ event_name: string; media_item_id: string }[]>`
                SELECT event_name, media_item_id::text FROM event_outbox ORDER BY media_item_id`;
            expect(events.filter((e) => e.event_name === 'file.windowChanged')).toEqual(
                [ep20, ep19]
                    .sort()
                    .map((id) => ({ event_name: 'file.windowChanged', media_item_id: id })),
            );

            // An identical save changes nothing and emits nothing.
            await sql`DELETE FROM event_outbox`;
            await setManualFileEpisodes(
                sql,
                fileId,
                [ep20, ep19],
                [
                    { startMs: 0, endMs: HALF_MS + 4_000 },
                    { startMs: HALF_MS + 4_000, endMs: DURATION_MS },
                ],
            );
            const [{ n }] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM event_outbox WHERE event_name = 'file.windowChanged'`;
            expect(n).toBe(0);
        } finally {
            if (prior) {
                await sql`UPDATE feature_flags SET value = ${prior.value} WHERE key = 'event_outbox_enabled'`;
            } else {
                await sql`DELETE FROM feature_flags WHERE key = 'event_outbox_enabled'`;
            }
        }
    });

    it('back to automatic: the manual marks go, the links stay', async () => {
        const { fileId } = await seedDouble();
        const ep20 = await episodeId(20);
        const ep19 = await episodeId(19);
        await setManualFileEpisodes(
            sql,
            fileId,
            [ep20, ep19],
            [
                { startMs: 0, endMs: HALF_MS },
                { startMs: HALF_MS, endMs: DURATION_MS },
            ],
        );

        expect(await clearManualFileEpisodes(sql, fileId)).toBe(true);
        const after = await links(fileId);
        expect(after.map((l) => l.episode_number).sort()).toEqual([19, 20]);
        expect(after.every((l) => l.offset_source !== 'manual')).toBe(true);
    });
});

/**
 * A short real video, so the probed duration matches the windows: the pattern
 * changes the bytes (and the head hash) without changing the length.
 */
function makeVideo(path: string, seconds: number, pattern = 'testsrc'): void {
    const run = spawnSync(
        process.env.FFMPEG_PATH || 'ffmpeg',
        [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            `${pattern}=size=160x90:rate=5`,
            '-t',
            String(seconds),
            '-c:v',
            'mpeg4',
            path,
        ],
        { encoding: 'utf8' },
    );
    if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}

describe('manual file → episode links follow the file', () => {
    let sql: postgres.Sql;
    let root: string;
    let seasonDir: string;
    let pathId: string;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const SECONDS = 40;
    const HALF = 20_000;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM manual_file_link_sets`;
        await sql`DELETE FROM library_paths`;
        await sql`DELETE FROM library_groups WHERE name LIKE 'manual-move-%'`;
        root = mkdtempSync(join(tmpdir(), 'manual-move-'));
        seasonDir = join(root, 'Bikini Show', 'Season 09');
        mkdirSync(seasonDir, { recursive: true });
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`manual-move-${Date.now()}`}) RETURNING id`;
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'tv', ${group.id}, true) RETURNING id`;
        pathId = lp.id;
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    const scan = (): Promise<unknown> => scanForSync(pathId, { sql, logger } as never);

    async function episodeId(n: number): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE media_type = 'episode' AND episode_number = ${n}`;
        return row.id;
    }

    /** Links of the file at `path`, in file order, as `episode:start-end:source`. */
    async function linksAt(path: string): Promise<string[]> {
        const rows = await sql<
            { n: number; s: string | null; e: string | null; src: string | null }[]
        >`
            SELECT mi.episode_number AS n, mfi.start_offset_ms::text AS s,
                   mfi.end_offset_ms::text AS e, mfi.offset_source AS src
              FROM media_files mf
              JOIN media_file_items mfi ON mfi.file_id = mf.id
              JOIN media_items mi ON mi.id = mfi.media_item_id
             WHERE mf.file_path = ${path}
             ORDER BY mfi.sort_order, mi.episode_number
        `;
        return rows.map((r) => `${r.n}:${r.s ?? '-'}-${r.e ?? '-'}:${r.src ?? '-'}`);
    }

    const MANUAL = [`20:0-${HALF}:manual`, `19:${HALF}-${SECONDS * 1000}:manual`];

    /** The double, scanned, with 9x19 present and the set made by hand. */
    async function seedManualDouble(): Promise<string> {
        const filePath = join(seasonDir, 'Bikini Show S09E20-21.mkv');
        makeVideo(filePath, SECONDS);
        await scan();
        await sql`
            UPDATE media_items
               SET custom_metadata = custom_metadata - 'awaiting_provider_match'
                                                     - 'awaiting_provider_match_since'
        `;
        const [season] = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE media_type = 'season' AND season_number = 9`;
        await sql`
            INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number)
            VALUES ('The Executive Treatment', 'episode', 'active', ${season.id}, 9, 19)`;
        // The scan leaves duration_seconds to the media-probe task; set it as
        // that task would.
        const [file] = await sql<{ id: string }[]>`
            UPDATE media_files SET duration_seconds = ${SECONDS}
            WHERE file_path = ${filePath} RETURNING id`;
        const result = await setManualFileEpisodes(
            sql,
            file.id,
            [await episodeId(20), await episodeId(19)],
            [
                { startMs: 0, endMs: HALF },
                { startMs: HALF, endMs: SECONDS * 1000, boundaryOrigin: 'even-split' },
            ],
        );
        expect(result).toEqual({ ok: true, mediaItemIds: expect.any(Array) });
        expect(await linksAt(filePath)).toEqual(MANUAL);
        const [set] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM manual_file_link_sets`;
        expect(set.n).toBe(1);
        return filePath;
    }

    it('full-scan order: the renamed file gets the set back, the old row is cleaned up', async () => {
        const oldPath = await seedManualDouble();
        const newPath = join(seasonDir, 'Bikini Show S09E20-21 (fixed).mkv');
        renameSync(oldPath, newPath);

        await scan();
        expect(await linksAt(newPath)).toEqual(MANUAL);
        const origins =
            await sql`SELECT l.boundary_origin FROM media_file_items l JOIN media_files f ON f.id=l.file_id WHERE f.file_path=${newPath} ORDER BY l.sort_order`;
        expect(origins.map((r) => r.boundary_origin)).toEqual([null, 'even-split']);
        expect(await linksAt(oldPath)).toEqual([]);
        const [ep21] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM media_file_items mfi
            JOIN media_items mi ON mi.id = mfi.media_item_id WHERE mi.episode_number = 21`;
        expect(ep21.n).toBe(0);

        // And it stays that way on the next scan.
        await scan();
        expect(await linksAt(newPath)).toEqual(MANUAL);
    });

    it('watcher order: the old row is gone first, the episodes come back with the set', async () => {
        const oldPath = await seedManualDouble();
        const newPath = join(
            root,
            'Bikini Show',
            'Season 09',
            'moved',
            'Bikini Show S09E20-21.mkv',
        );
        mkdirSync(join(seasonDir, 'moved'));
        renameSync(oldPath, newPath);
        // The watcher's unlink: row deleted, both episodes left without a file.
        await deleteStaleMediaFile(sql, oldPath);
        const dismissed = await sql<{ d: boolean }[]>`
            SELECT is_dismissed AS d FROM media_items WHERE episode_number IN (19, 20)`;
        expect(dismissed.every((r) => r.d)).toBe(true);

        await scan();
        expect(await linksAt(newPath)).toEqual(MANUAL);
        const back = await sql<{ d: boolean; f: boolean }[]>`
            SELECT is_dismissed AS d, has_files AS f FROM media_items WHERE episode_number IN (19, 20)`;
        expect(back).toEqual([
            { d: false, f: true },
            { d: false, f: true },
        ]);
    });

    it('watcher order, cross-season set: a moved S10E13 holding 11x16 + 10x19 keeps it', async () => {
        const filePath = join(root, 'Bikini Show', 'Season 10', 'Bikini Show S10E13.mkv');
        mkdirSync(join(root, 'Bikini Show', 'Season 10'), { recursive: true });
        makeVideo(filePath, SECONDS);
        await scan();
        await sql`
            UPDATE media_items
               SET custom_metadata = custom_metadata - 'awaiting_provider_match'
                                                     - 'awaiting_provider_match_since'
        `;
        const [series] = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE media_type = 'tv'`;
        const [s10] = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE media_type = 'season' AND season_number = 10`;
        const [s11] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, parent_id, season_number)
            VALUES ('Season 11', 'season', 'active', ${series.id}, 11) RETURNING id`;
        const [e1016] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number)
            VALUES ('The Incredible Shrinking Sponge', 'episode', 'active', ${s11.id}, 11, 16) RETURNING id`;
        const [e1019] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number)
            VALUES ('Sportz?', 'episode', 'active', ${s10.id}, 10, 19) RETURNING id`;
        const [file] = await sql<{ id: string }[]>`
            UPDATE media_files SET duration_seconds = ${SECONDS}
            WHERE file_path = ${filePath} RETURNING id`;
        expect(
            await setManualFileEpisodes(
                sql,
                file.id,
                [e1016.id, e1019.id],
                [
                    { startMs: 0, endMs: HALF },
                    { startMs: HALF, endMs: SECONDS * 1000 },
                ],
            ),
        ).toEqual({ ok: true, mediaItemIds: expect.any(Array) });

        const newPath = join(
            root,
            'Bikini Show',
            'Season 10',
            'Bikini Show S10E13 (11x16+10x19).mkv',
        );
        renameSync(filePath, newPath);
        await deleteStaleMediaFile(sql, filePath);
        await scan();

        const rows = await sql<{ s: number; n: number; start: string; src: string }[]>`
            SELECT mi.season_number AS s, mi.episode_number AS n,
                   mfi.start_offset_ms::text AS start, mfi.offset_source AS src
              FROM media_files mf
              JOIN media_file_items mfi ON mfi.file_id = mf.id
              JOIN media_items mi ON mi.id = mfi.media_item_id
             WHERE mf.file_path = ${newPath}
             ORDER BY mfi.sort_order`;
        expect(rows).toEqual([
            { s: 11, n: 16, start: '0', src: 'manual' },
            { s: 10, n: 19, start: String(HALF), src: 'manual' },
        ]);
    });

    it('a copy next to the original is linked from its name, the original keeps the set', async () => {
        const original = await seedManualDouble();
        const copy = join(seasonDir, 'Bikini Show S09E20-21 copy.mkv');
        copyFileSync(original, copy);

        await scan();
        expect(await linksAt(original)).toEqual(MANUAL);
        expect((await linksAt(copy)).every((l) => !l.endsWith(':manual'))).toBe(true);
    });

    it('new bytes of the same length keep the windows; another length hands the file back', async () => {
        const filePath = await seedManualDouble();
        const [before] = await sql<
            { h: string }[]
        >`SELECT file_hash_head AS h FROM manual_file_link_sets`;

        makeVideo(filePath, SECONDS, 'testsrc2');
        await scan();
        expect(await linksAt(filePath)).toEqual(MANUAL);
        const [after] = await sql<
            { h: string }[]
        >`SELECT file_hash_head AS h FROM manual_file_link_sets`;
        expect(after.h).not.toBe(before.h);

        makeVideo(filePath, 25, 'rgbtestsrc');
        await scan();
        expect((await linksAt(filePath)).every((l) => !l.endsWith(':manual'))).toBe(true);
        const [sets] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM manual_file_link_sets`;
        expect(sets.n).toBe(0);
    });
});
