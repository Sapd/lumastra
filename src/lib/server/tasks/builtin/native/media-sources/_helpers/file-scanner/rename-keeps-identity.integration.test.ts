// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A full scan keeps an item's identity (its media_items id, so its watch state,
 * ratings and playlist entries) when a file is renamed, moved or replaced
 * between two scans.
 *
 * The full scan handles new files BEFORE it retires vanished ones. The rename
 * reclaim by head hash only looked at already-dismissed items, so the new path
 * minted a new item and stale cleanup then dismissed the old one with the
 * user's state on it. Provider-matched items were safe (the provider id finds
 * the same row); these cases have no provider id:
 *   - an unmatched movie renamed to another title (same bytes);
 *   - an unmatched series folder renamed to another title (same bytes);
 *   - a track replaced by a file in another format (same album, title, track
 *     and disc; different bytes).
 * The negative controls pin what must stay apart: a copy (the old file is still
 * there) and a single episode moved out of a series whose other files stay.
 *
 * Real scanner (`scanForSync`, stale cleanup included), real Postgres, real
 * files and the real ffprobe; no metadata provider, so every video takes the
 * unmatched path. Only the Valkey progress store is stubbed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import * as folderOwner from './series-folder-owner.js';
import { processVideoFile } from './video-processor.js';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';

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
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import { scanForSync } from '../../file-scanner.js';
import { deleteStaleMediaFile } from '../../../../../../database/queries/media-files.queries.js';
import { ID3_UTF8, textFrameBody, writeId3Mp3 } from './id3-mp3-fixture.test-helpers.js';
import * as folderQueries from '../../../../../../database/queries/series-folder-ownership.queries.js';
import {
    insertTestExternalIds,
    createTestRating,
    insertTestRating,
} from '../../../../../../../../../tests/integration/fixtures/index.js';

const VIDEO = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const FLAC = join(process.cwd(), 'tests', 'fixtures', 'music', 'sample.flac');

interface ItemRow {
    id: string;
    title: string;
    status: string;
    is_dismissed: boolean;
    parent_id: string | null;
}

/**
 * The video fixture with a `free` box appended. The fixture is smaller than the
 * 64 KB the head hash reads, so the payload gives each copy its own hash (two
 * episodes with one hash are ambiguous, and the reclaim rightly refuses them)
 * while the file stays a valid MP4.
 */
async function writeVideo(file: string, tag: string): Promise<string> {
    await mkdir(dirname(file), { recursive: true });
    const payload = Buffer.from(`lumastra-test:${tag}`, 'utf8');
    const box = Buffer.alloc(8);
    box.writeUInt32BE(8 + payload.length, 0);
    box.write('free', 4, 'latin1');
    await writeFile(file, Buffer.concat([await readFile(VIDEO), box, payload]));
    return file;
}

/** The FLAC fixture with its Vorbis comment replaced by `tags`. */
async function writeFlac(file: string, tags: Record<string, string>): Promise<string> {
    await mkdir(dirname(file), { recursive: true });
    const src = await readFile(FLAC);
    if (src.toString('latin1', 0, 4) !== 'fLaC') throw new Error('fixture is not a FLAC file');
    const blocks: { type: number; body: Buffer }[] = [];
    let pos = 4;
    for (;;) {
        const header = src[pos];
        const length = src.readUIntBE(pos + 1, 3);
        const type = header & 0x7f;
        // Drop the old comment, pictures and padding; keep STREAMINFO etc.
        if (type !== 4 && type !== 6 && type !== 1) {
            blocks.push({ type, body: src.subarray(pos + 4, pos + 4 + length) });
        }
        pos += 4 + length;
        if (header & 0x80) break;
    }
    const u32le = (n: number): Buffer => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(n, 0);
        return b;
    };
    const vendor = Buffer.from('lumastra-test', 'utf8');
    const entries = Object.entries(tags).map(([k, v]) => Buffer.from(`${k}=${v}`, 'utf8'));
    blocks.push({
        type: 4,
        body: Buffer.concat([
            u32le(vendor.length),
            vendor,
            u32le(entries.length),
            ...entries.flatMap((e) => [u32le(e.length), e]),
        ]),
    });
    const out: Buffer[] = [Buffer.from('fLaC', 'latin1')];
    blocks.forEach((b, i) => {
        const h = Buffer.alloc(4);
        h[0] = (i === blocks.length - 1 ? 0x80 : 0) | b.type;
        h.writeUIntBE(b.body.length, 1, 3);
        out.push(h, b.body);
    });
    out.push(src.subarray(pos));
    await writeFile(file, Buffer.concat(out));
    return file;
}

describe('full scan keeps identity across a rename / replace (real PG, real ffprobe)', () => {
    let sql: postgres.Sql;
    let root: string;
    let groupId: string;
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    };

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        for (const method of Object.values(logger)) method.mockClear();
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM library_paths`;
        root = await mkdtemp(join(tmpdir(), 'lumastra-rename-identity-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`rename-identity-${Date.now()}`})
            RETURNING id
        `;
        groupId = group.id;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function library(mediaType: 'movie' | 'tv' | 'music'): Promise<string> {
        const libRoot = join(root, mediaType);
        await mkdir(libRoot, { recursive: true });
        // Chapter catch-up writes can contend on folder witnesses. Exercise
        // identity independently; the collision case below pins lock deferral.
        const [lp] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled, scan_chapters)
            VALUES (${libRoot}, ${mediaType}, ${groupId}, true, false) RETURNING id
        `;
        return lp.id;
    }

    const scan = async (pathId: string): Promise<void> => {
        const result = await scanForSync(pathId, { sql, logger } as never);
        expect(result.errors).toEqual([]);
    };

    async function itemOf(filePath: string): Promise<ItemRow | undefined> {
        const [row] = await sql<ItemRow[]>`
            SELECT mi.id, mi.title, mi.status, mi.is_dismissed, mi.parent_id
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mf.file_path = ${filePath}
        `;
        return row;
    }

    async function item(id: string): Promise<ItemRow> {
        const [row] = await sql<ItemRow[]>`
            SELECT id, title, status, is_dismissed, parent_id FROM media_items WHERE id = ${id}
        `;
        return row;
    }

    async function seriesOf(episodeId: string): Promise<ItemRow> {
        const episode = await item(episodeId);
        const season = await item(episode.parent_id!);
        return season.parent_id ? item(season.parent_id) : season;
    }

    /**
     * The item ended the scan with exactly one file, and that file is its
     * default (stale cleanup promoted it when the old default went), and it
     * and its ancestors still count as having files.
     */
    async function expectOnePlayableFile(itemId: string): Promise<void> {
        const links = await sql<{ is_default: boolean }[]>`
            SELECT is_default FROM media_file_items WHERE media_item_id = ${itemId}
        `;
        expect(links).toEqual([{ is_default: true }]);
        const chain = await sql<{ media_type: string; has_files: boolean }[]>`
            WITH RECURSIVE up AS (
                SELECT id, parent_id, media_type, has_files FROM media_items WHERE id = ${itemId}
                UNION ALL
                SELECT p.id, p.parent_id, p.media_type, p.has_files
                FROM media_items p JOIN up ON p.id = up.parent_id
            )
            SELECT media_type, has_files FROM up
        `;
        expect(chain.length).toBeGreaterThan(0);
        for (const row of chain) expect(row).toMatchObject({ has_files: true });
    }

    it('an unmatched movie renamed to another title keeps its item, under the new title', async () => {
        const pathId = await library('movie');
        const oldPath = await writeVideo(
            join(root, 'movie', 'Quiet Harbour (2011)', 'Quiet Harbour (2011).mp4'),
            'movie',
        );
        await scan(pathId);
        const before = await itemOf(oldPath);
        expect(before).toBeDefined();

        const newDir = join(root, 'movie', 'Silent Lighthouse (2012)');
        await rename(dirname(oldPath), newDir);
        const newPath = join(newDir, 'Quiet Harbour (2011).mp4');
        const renamedPath = join(newDir, 'Silent Lighthouse (2012).mp4');
        await rename(newPath, renamedPath);
        await scan(pathId);

        const after = await itemOf(renamedPath);
        expect(after?.id).toBe(before!.id);
        expect(after).toMatchObject({ status: 'active', is_dismissed: false });
        expect(after!.title).toMatch(/silent lighthouse/i);
        await expectOnePlayableFile(before!.id);
        const [{ n }] = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM media_items WHERE media_type = 'movie'
        `;
        expect(Number(n)).toBe(1);
    }, 120_000);

    it('a renamed movie with locked metadata keeps its item and its title', async () => {
        const pathId = await library('movie');
        const oldPath = await writeVideo(
            join(root, 'movie', 'Quiet Harbour (2011)', 'Quiet Harbour (2011).mp4'),
            'locked',
        );
        await scan(pathId);
        const before = await itemOf(oldPath);
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${before!.id}`;

        const renamedPath = join(root, 'movie', 'Silent Lighthouse (2012).mp4');
        await rename(oldPath, renamedPath);
        await scan(pathId);

        const after = await itemOf(renamedPath);
        expect(after?.id).toBe(before!.id);
        expect(after!.title).toBe(before!.title);
        await expectOnePlayableFile(before!.id);
    }, 120_000);

    it('a copy of an unmatched movie under another title stays its own movie', async () => {
        const pathId = await library('movie');
        const original = await writeVideo(
            join(root, 'movie', 'Quiet Harbour (2011)', 'Quiet Harbour (2011).mp4'),
            'copy',
        );
        await scan(pathId);
        const copy = join(
            root,
            'movie',
            'Silent Lighthouse (2012)',
            'Silent Lighthouse (2012).mp4',
        );
        await mkdir(dirname(copy), { recursive: true });
        await writeFile(copy, await readFile(original));
        await scan(pathId);

        const a = await itemOf(original);
        const b = await itemOf(copy);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(b!.id).not.toBe(a!.id);
        expect(a!.title).toMatch(/quiet harbour/i);
    }, 120_000);

    it('an unmatched series folder renamed to another title keeps its series and episodes', async () => {
        const pathId = await library('tv');
        const ep1 = await writeVideo(
            join(root, 'tv', 'Copper Valley', 'Season 01', 'Copper Valley - S01E01.mp4'),
            'ep1',
        );
        const ep2 = await writeVideo(
            join(root, 'tv', 'Copper Valley', 'Season 01', 'Copper Valley - S01E02.mp4'),
            'ep2',
        );
        await scan(pathId);
        const e1 = await itemOf(ep1);
        const e2 = await itemOf(ep2);
        expect(e1).toBeDefined();
        expect(e2).toBeDefined();
        const series = await seriesOf(e1!.id);
        expect(series.title).toMatch(/copper valley/i);

        await rename(join(root, 'tv', 'Copper Valley'), join(root, 'tv', 'Iron Meadow'));
        const season = join(root, 'tv', 'Iron Meadow', 'Season 01');
        const new1 = join(season, 'Iron Meadow - S01E01.mp4');
        const new2 = join(season, 'Iron Meadow - S01E02.mp4');
        await rename(join(season, 'Copper Valley - S01E01.mp4'), new1);
        await rename(join(season, 'Copper Valley - S01E02.mp4'), new2);
        await scan(pathId);

        const a1 = await itemOf(new1);
        const a2 = await itemOf(new2);
        expect(a1?.id).toBe(e1!.id);
        expect(a2?.id).toBe(e2!.id);
        expect(a1).toMatchObject({ status: 'active', is_dismissed: false });
        expect(a2).toMatchObject({ status: 'active', is_dismissed: false });
        const seriesAfter = await seriesOf(a1!.id);
        expect(seriesAfter.id).toBe(series.id);
        expect(seriesAfter.title).toMatch(/iron meadow/i);
        await expectOnePlayableFile(e1!.id);
        await expectOnePlayableFile(e2!.id);
        const [{ n }] = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM media_items WHERE media_type = 'tv'
        `;
        expect(Number(n)).toBe(1);
    }, 120_000);

    it.each([1, 2])(
        'declines a series rename when old file %s reappears after preflight',
        async (restoredEpisode) => {
            const pathId = await library('tv');
            const [lp] = await sql<
                LibraryPathRow[]
            >`SELECT * FROM library_paths WHERE id = ${pathId}`;
            const oldFile = await writeVideo(
                join(root, 'tv', 'Copper Valley', 'Season 01', 'Copper Valley - S01E01.mp4'),
                'reappearing',
            );
            const secondFile = await writeVideo(
                join(root, 'tv', 'Copper Valley', 'Season 01', 'Copper Valley - S01E02.mp4'),
                'reappearing-2',
            );
            const secondBytes = await readFile(secondFile);
            await scan(pathId);
            const oldEpisode = (await itemOf(oldFile))!;
            const oldSeries = await seriesOf(oldEpisode.id);
            const newFile = join(
                root,
                'tv',
                'Iron Meadow',
                'Season 01',
                'Iron Meadow - S01E01.mp4',
            );
            await mkdir(dirname(newFile), { recursive: true });
            await rename(oldFile, newFile);
            await rm(secondFile);
            const restoredPath = restoredEpisode === 1 ? oldFile : secondFile;
            const restoredItem = (await itemOf(restoredPath))!;
            const originalLock = folderOwner.withSeriesFolderLock;
            const lock = vi
                .spyOn(folderOwner, 'withSeriesFolderLock')
                .mockImplementationOnce(async (...args) => {
                    // The candidate was prepared with the old path missing. Restore
                    // the same bytes while it waits to enter the folder transaction.
                    await writeFile(
                        restoredPath,
                        restoredEpisode === 1 ? await readFile(newFile) : secondBytes,
                    );
                    return originalLock(...args);
                });
            try {
                expect(await processVideoFile(sql, newFile, lp, [], { sql, logger } as never)).toBe(
                    'added',
                );
                expect(lock).toHaveBeenCalledOnce();
                expect((await item(oldSeries.id)).title).toBe(oldSeries.title);
                expect((await seriesOf((await itemOf(newFile))!.id)).id).not.toBe(oldSeries.id);
                expect((await itemOf(restoredPath))?.id).toBe(restoredItem.id);
            } finally {
                lock.mockRestore();
            }
        },
        120_000,
    );

    it.each([false, true])(
        'a renamed series folder whose new title another series holds joins that series (contended: %s)',
        async (contended) => {
            const pathId = await library('tv');
            const ep1 = await writeVideo(
                join(root, 'tv', 'Copper Valley', 'Season 01', 'Copper Valley - S01E01.mp4'),
                'holder-old',
            );
            await writeVideo(
                join(root, 'tv', 'Iron Meadow', 'Season 01', 'Iron Meadow - S01E05.mp4'),
                'holder-existing',
            );
            await scan(pathId);
            const oldSeries = await seriesOf((await itemOf(ep1))!.id);
            const holder = await seriesOf(
                (await itemOf(
                    join(root, 'tv', 'Iron Meadow', 'Season 01', 'Iron Meadow - S01E05.mp4'),
                ))!.id,
            );
            expect(holder.id).not.toBe(oldSeries.id);

            const moved = join(root, 'tv', 'Iron Meadow', 'Season 01', 'Iron Meadow - S01E01.mp4');
            await rename(ep1, moved);
            await rm(join(root, 'tv', 'Copper Valley'), { recursive: true });
            logger.warn.mockClear();
            const deferredWarning =
                '[FileScanner] Uncertain current series-folder ownership; leaving episode unlinked';

            // Folder ownership deliberately abstains on NOWAIT contention. Pin that
            // interleaving with a real, independent connection instead of relying on
            // scan-slot timing. The owning title must survive both scans unchanged.
            const blocker = contended ? postgres(getTestDatabaseUrl(), { max: 1 }) : null;
            const reserved = await blocker?.reserve();
            try {
                if (reserved) {
                    await reserved`BEGIN`;
                    await reserved`SELECT id FROM media_items WHERE id = ${holder.id} FOR NO KEY UPDATE`;
                }
                await scan(pathId);
                if (contended) {
                    expect(await itemOf(moved)).toBeUndefined();
                    expect(logger.warn).toHaveBeenCalledWith(
                        deferredWarning,
                        expect.objectContaining({ filePath: moved }),
                    );
                    expect((await item(oldSeries.id)).title).toMatch(/copper valley/i);
                }
            } finally {
                if (reserved) {
                    await reserved`ROLLBACK`;
                    reserved.release();
                }
                await blocker?.end();
            }

            let movedItem = await itemOf(moved);
            if (!movedItem) {
                // A completed scan can intentionally defer an attachment. Retry
                // only that documented outcome, after the contending writer ends;
                // scan errors still fail immediately in scan(). No sleep/polling.
                expect(logger.warn).toHaveBeenCalledWith(
                    deferredWarning,
                    expect.objectContaining({ filePath: moved }),
                );
                await scan(pathId);
                movedItem = await itemOf(moved);
            }

            // Not renamed into a second "Iron Meadow": the file joins the holder.
            expect((await item(oldSeries.id)).title).toMatch(/copper valley/i);
            expect(
                movedItem,
                JSON.stringify({
                    warnings: logger.warn.mock.calls,
                    errors: logger.error.mock.calls,
                }),
            ).toBeDefined();
            expect((await seriesOf(movedItem!.id)).id).toBe(holder.id);
            await expectOnePlayableFile(movedItem!.id);
            await scan(pathId);
            expect((await itemOf(moved))?.id).toBe(movedItem!.id);
        },
        120_000,
    );

    it('an episode dismissed before its renamed file is scanned keeps its identity in the same folder', async () => {
        const pathId = await library('tv');
        const season = join(root, 'tv', 'Copper Valley', 'Season 01');
        const ep1 = await writeVideo(join(season, 'Copper Valley - S01E01.mp4'), 'dismissed');
        await writeVideo(join(season, 'Copper Valley - S01E02.mp4'), 'witness');
        await scan(pathId);
        const before = (await itemOf(ep1))!;
        const series = await seriesOf(before.id);
        const moved = join(season, 'Copper Valley - S01E01 - Renamed.mp4');
        await rename(ep1, moved);
        // The watcher's unlink-before-add ordering leaves a hash snapshot on
        // the dismissed episode, while its sibling still owns the folder.
        await deleteStaleMediaFile(sql, ep1);
        expect(await item(before.id)).toMatchObject({ is_dismissed: true });

        await scan(pathId);
        expect((await itemOf(moved))?.id).toBe(before.id);
        expect((await seriesOf(before.id)).id).toBe(series.id);
        await expectOnePlayableFile(before.id);
    }, 120_000);

    it.each(['same', 'mixed', 'unknown'] as const)(
        'a provider-matched reclaim keeps its episode under contention (owner: %s)',
        async (ownerState) => {
            const ambiguous = ownerState === 'mixed';
            const deferred = ownerState !== 'same';
            const pathId = await library('tv');
            const season = join(root, 'tv', 'Copper Valley', 'Season 01');
            const ep1 = await writeVideo(
                join(season, 'Copper Valley - S01E01.mp4'),
                'provider-old',
            );
            const witness = await writeVideo(
                join(season, 'Copper Valley - S01E02.mp4'),
                'provider-witness',
            );
            const alien = await writeVideo(
                join(root, 'tv', 'Other Show', 'Season 01', 'Other Show - S01E03.mp4'),
                'alien-witness',
            );
            await scan(pathId);
            const before = (await itemOf(ep1))!;
            const series = await seriesOf(before.id);
            const sibling = (await itemOf(witness))!;
            const userId = crypto.randomUUID();
            await insertTestRating(sql, createTestRating(userId, before.id, 8));
            await sql`INSERT INTO watch_history (
                user_id, media_id, media_type, source_service, title,
                session_start_time, session_end_time, actual_watch_time_seconds
            ) VALUES (${userId}, ${before.id}, 'episode', 'lumastra', 'Episode 1', NOW(), NOW(), 42)`;

            await insertTestExternalIds(sql, [
                {
                    media_id: series.id,
                    provider: 'imdb',
                    external_id: 'tt0910001',
                    media_type: 'tv',
                    is_primary: false,
                },
            ]);
            const moved = join(season, 'Copper Valley - S01E01 [imdbid-tt0910001] Renamed.mp4');
            await rename(ep1, moved);
            await deleteStaleMediaFile(sql, ep1);
            const alienMoved = join(season, 'Other Show - S01E03.mp4');
            if (ambiguous) {
                // Competing ownership is unknown until the concurrent move is resolved.
                await rename(alien, alienMoved);
                await sql`UPDATE media_files SET file_path = ${alienMoved} WHERE file_path = ${alien}`;
            }
            // A cheap read can observe no owner before the heavy fence sees
            // a sibling committed by another worker. Pin that observation,
            // leaving all locking and reclaim queries real.
            const ownerLookup =
                ownerState === 'unknown'
                    ? vi.spyOn(folderQueries, 'findSeriesFolderOwnerId').mockResolvedValueOnce(null)
                    : null;
            const witnesses = vi.spyOn(folderQueries, 'listSeriesFolderWitnesses');
            const blocker = postgres(getTestDatabaseUrl(), { max: 1 });
            const reserved = await blocker.reserve();
            try {
                await reserved`BEGIN`;
                // Same lock a chapter/editor writer takes; a separate connection
                // proves this is contention, rather than serialized pool calls.
                await reserved`SELECT pg_advisory_xact_lock(hashtext(${sibling.id}))`;
                const result = await scanForSync(pathId, { sql, logger } as never);
                expect(result.errors).toEqual([]);
                if (deferred) {
                    expect(await itemOf(moved)).toBeUndefined();
                    expect(result).toMatchObject({
                        added: 0,
                        updated: 0,
                        unmatched: 0,
                        skipped: 3,
                    });
                    expect(await item(before.id)).toMatchObject({ is_dismissed: true });
                    const refusals = logger.warn.mock.calls.filter(
                        ([message, detail]) =>
                            message === '[FileScanner] Hash reclaim deferred' &&
                            detail.filePath === moved,
                    );
                    expect(refusals).toHaveLength(1);
                } else {
                    expect((await itemOf(moved))?.id).toBe(before.id);
                    // An established same-series rename must not enumerate,
                    // lock or stat every sibling (including >1000 episodes).
                    expect(witnesses).not.toHaveBeenCalled();
                }
            } finally {
                ownerLookup?.mockRestore();
                witnesses.mockRestore();
                await reserved`ROLLBACK`;
                reserved.release();
                await blocker.end();
            }
            if (ambiguous) {
                // Deferral must outlive both the 24h candidate window and the
                // scanner's 30-day precheck, without changing dismissal time.
                await sql`UPDATE media_items SET dismissed_at = NOW() - INTERVAL '31 days' WHERE id = ${before.id}`;
                await scan(pathId);
                expect(await itemOf(moved)).toBeUndefined();
                await rm(alienMoved);
                await deleteStaleMediaFile(sql, alienMoved);
                await scan(pathId);
            } else if (deferred) {
                await scan(pathId);
            }
            const [pin] = await sql<{ deferred: boolean }[]>`
                SELECT processing_state ? 'hash-reclaim-deferred' AS deferred
                FROM media_items WHERE id = ${before.id}
            `;
            expect(pin.deferred).toBe(false);
            const [userState] = await sql<{ rating: number; watched: number }[]>`
                SELECT r.rating, wh.actual_watch_time_seconds AS watched
                FROM media_files mf
                JOIN media_file_items link ON link.file_id = mf.id
                JOIN user_ratings r ON r.media_id = link.media_item_id AND r.user_id = ${userId}
                JOIN watch_history wh ON wh.media_id = link.media_item_id AND wh.user_id = ${userId}
                WHERE mf.file_path = ${moved}
            `;
            expect(userState).toEqual({ rating: 8, watched: 42 });

            expect((await itemOf(moved))?.id).toBe(before.id);
            expect((await seriesOf(before.id)).id).toBe(series.id);
            await expectOnePlayableFile(before.id);
        },
        120_000,
    );

    it('a hash candidate with no series falls through immediately and clears a stale pin', async () => {
        const pathId = await library('tv');
        const season = join(root, 'tv', 'Copper Valley', 'Season 01');
        const original = await writeVideo(join(season, 'Copper Valley - S01E01.mp4'), 'orphan');
        await writeVideo(join(season, 'Copper Valley - S01E02.mp4'), 'witness');
        await scan(pathId);
        const before = (await itemOf(original))!;
        const moved = join(season, 'Copper Valley - S01E01 Renamed.mp4');
        await rename(original, moved);
        await deleteStaleMediaFile(sql, original);
        await sql`UPDATE media_items SET parent_id = NULL,
            processing_state = processing_state || jsonb_build_object(
                'hash-reclaim-deferred', dismissed_content_hash) WHERE id = ${before.id}`;

        await scan(pathId);
        expect((await itemOf(moved))?.id).toBeDefined();
        expect((await itemOf(moved))?.id).not.toBe(before.id);
        expect(logger.info).toHaveBeenCalledWith(
            '[FileScanner] Hash reclaim refused',
            expect.objectContaining({ filePath: moved, reason: 'candidate series is unknown' }),
        );
        const [pin] = await sql<
            { pinned: boolean }[]
        >`SELECT processing_state ? 'hash-reclaim-deferred' AS pinned
            FROM media_items WHERE id = ${before.id}`;
        expect(pin.pinned).toBe(false);
    }, 120_000);

    it('persistent mixed folder ownership falls through after three deferred scans', async () => {
        const pathId = await library('tv');
        const season = join(root, 'tv', 'Copper Valley', 'Season 01');
        const original = await writeVideo(join(season, 'Copper Valley - S01E01.mp4'), 'persistent');
        await writeVideo(join(season, 'Copper Valley - S01E02.mp4'), 'witness');
        const alien = await writeVideo(
            join(root, 'tv', 'Other Show', 'Season 01', 'Other Show - S01E03.mp4'),
            'alien',
        );
        await scan(pathId);
        const before = (await itemOf(original))!;
        const series = await seriesOf(before.id);
        await insertTestExternalIds(sql, [
            {
                media_id: series.id,
                provider: 'imdb',
                external_id: 'tt0910001',
                media_type: 'tv',
                is_primary: false,
            },
        ]);
        const moved = join(season, 'Copper Valley - S01E01 [imdbid-tt0910001] Renamed.mp4');
        await rename(original, moved);
        await deleteStaleMediaFile(sql, original);
        const alienMoved = join(season, 'Other Show - S01E03.mp4');
        await rename(alien, alienMoved);
        await sql`UPDATE media_files SET file_path = ${alienMoved} WHERE file_path = ${alien}`;

        for (let attempt = 1; attempt <= 3; attempt++) {
            await scan(pathId);
            expect(await itemOf(moved)).toBeUndefined();
            const [pin] = await sql<{ attempts: number }[]>`SELECT
                (processing_state #>> '{hash-reclaim-deferred,attempts}')::int AS attempts
                FROM media_items WHERE id = ${before.id}`;
            expect(pin.attempts).toBe(attempt);
        }
        await scan(pathId);
        const linked = (await itemOf(moved))!;
        expect(linked).toBeDefined();
        await expectOnePlayableFile(linked.id);
        expect(logger.info).toHaveBeenCalledWith(
            '[FileScanner] Hash reclaim refused',
            expect.objectContaining({
                filePath: moved,
                reason: expect.stringContaining('deferral budget exhausted'),
            }),
        );
        const [pin] = await sql<
            { pinned: boolean }[]
        >`SELECT processing_state ? 'hash-reclaim-deferred' AS pinned
            FROM media_items WHERE id = ${before.id}`;
        expect(pin.pinned).toBe(false);
        logger.warn.mockClear();
        await scan(pathId);
        expect((await itemOf(moved))?.id).toBe(linked.id);
        expect(logger.warn).not.toHaveBeenCalledWith(
            '[FileScanner] Hash reclaim deferred',
            expect.anything(),
        );
    }, 120_000);

    it('one episode moved into a new series folder does not rename the series it left', async () => {
        const pathId = await library('tv');
        const stays = await writeVideo(
            join(root, 'tv', 'Copper Valley', 'Season 01', 'Copper Valley - S01E01.mp4'),
            'stays',
        );
        const moves = await writeVideo(
            join(root, 'tv', 'Copper Valley', 'Season 01', 'Copper Valley - S01E02.mp4'),
            'moves',
        );
        await scan(pathId);
        const series = await seriesOf((await itemOf(stays))!.id);

        const moved = join(root, 'tv', 'Iron Meadow', 'Season 01', 'Iron Meadow - S01E02.mp4');
        await mkdir(dirname(moved), { recursive: true });
        await rename(moves, moved);
        await scan(pathId);

        const kept = await itemOf(stays);
        expect(kept).toMatchObject({ status: 'active', is_dismissed: false });
        expect((await seriesOf(kept!.id)).id).toBe(series.id);
        expect((await item(series.id)).title).toMatch(/copper valley/i);
        const movedItem = await itemOf(moved);
        expect(movedItem).toBeDefined();
        expect((await seriesOf(movedItem!.id)).title).toMatch(/iron meadow/i);
    }, 120_000);

    it('a track replaced by a file in another format keeps its item', async () => {
        const pathId = await library('music');
        const albumDir = join(root, 'music', 'Northern Lantern', 'Tidal Atlas');
        await mkdir(albumDir, { recursive: true });
        const mp3 = await writeId3Mp3(join(albumDir, '03 - Glass Orchard.mp3'), 4, [
            { id: 'TIT2', body: textFrameBody(ID3_UTF8, ['Glass Orchard']) },
            { id: 'TALB', body: textFrameBody(ID3_UTF8, ['Tidal Atlas']) },
            { id: 'TPE1', body: textFrameBody(ID3_UTF8, ['Northern Lantern']) },
            { id: 'TRCK', body: textFrameBody(ID3_UTF8, ['3']) },
            { id: 'TPOS', body: textFrameBody(ID3_UTF8, ['1']) },
        ]);
        await scan(pathId);
        const before = await itemOf(mp3);
        expect(before).toBeDefined();

        await rm(mp3);
        const flac = await writeFlac(join(albumDir, '03 - Glass Orchard.flac'), {
            TITLE: 'Glass Orchard',
            ALBUM: 'Tidal Atlas',
            ARTIST: 'Northern Lantern',
            TRACKNUMBER: '3',
            DISCNUMBER: '1',
        });
        await scan(pathId);

        const after = await itemOf(flac);
        expect(after?.id).toBe(before!.id);
        expect(after).toMatchObject({ status: 'active', is_dismissed: false });
        await expectOnePlayableFile(before!.id);
        const [{ n }] = await sql<{ n: string }[]>`
            SELECT count(*)::text AS n FROM media_items WHERE media_type = 'track'
        `;
        expect(Number(n)).toBe(1);
    }, 120_000);

    it('a second format of a track whose first file stays is not merged into it', async () => {
        const pathId = await library('music');
        const albumDir = join(root, 'music', 'Northern Lantern', 'Tidal Atlas');
        await mkdir(albumDir, { recursive: true });
        const mp3 = await writeId3Mp3(join(albumDir, '03 - Glass Orchard.mp3'), 4, [
            { id: 'TIT2', body: textFrameBody(ID3_UTF8, ['Glass Orchard']) },
            { id: 'TALB', body: textFrameBody(ID3_UTF8, ['Tidal Atlas']) },
            { id: 'TPE1', body: textFrameBody(ID3_UTF8, ['Northern Lantern']) },
            { id: 'TRCK', body: textFrameBody(ID3_UTF8, ['3']) },
        ]);
        await scan(pathId);
        const flac = await writeFlac(join(albumDir, '03 - Glass Orchard.flac'), {
            TITLE: 'Glass Orchard',
            ALBUM: 'Tidal Atlas',
            ARTIST: 'Northern Lantern',
            TRACKNUMBER: '3',
        });
        await scan(pathId);

        const a = await itemOf(mp3);
        const b = await itemOf(flac);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(b!.id).not.toBe(a!.id);
    }, 120_000);
});
