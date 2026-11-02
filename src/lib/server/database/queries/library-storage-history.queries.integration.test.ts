// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library storage history queries against real PostgreSQL: the daily size and
 * volume snapshots (migration 16.413.0) and the media_files reconstruction.
 *
 * Every test runs inside a transaction that is rolled back. Fixture files carry
 * their own library groups and far-past dates, so rows other tests left in the
 * database cannot change the answers being checked.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import {
    getDatabaseToday,
    getLatestLibrarySizeByMediaType,
    getLibraryBackfillDaily,
    getLibrarySizeSnapshotTotals,
    getLibraryVolumeSnapshots,
    pruneLibraryStorageSnapshots,
    writeLibrarySizeSnapshot,
    writeLibraryVolumeSnapshots,
} from './library-storage-history.queries.js';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

let sql: postgres.Sql;

beforeAll(() => {
    sql = postgres(getTestDatabaseUrl(), { max: 2, onnotice: () => {} });
});

afterAll(async () => {
    await sql?.end();
});

class Rollback extends Error {}

async function inRolledBackTx(body: (tx: postgres.Sql) => Promise<void>): Promise<void> {
    try {
        await sql.begin(async (tx) => {
            await body(tx as unknown as postgres.Sql);
            throw new Rollback();
        });
    } catch (err) {
        if (!(err instanceof Rollback)) throw err;
    }
}

async function seedLibrary(
    tx: postgres.Sql,
    name: string,
    mediaType: string,
): Promise<{ groupId: string; pathId: string }> {
    const [group] = await tx<{ id: string }[]>`
        INSERT INTO library_groups (name) VALUES (${name}) RETURNING id
    `;
    const [path] = await tx<{ id: string }[]>`
        INSERT INTO library_paths (path, media_type, library_group_id)
        VALUES (${`/data/fixture-${name}`}, ${mediaType}, ${group.id})
        RETURNING id
    `;
    return { groupId: group.id, pathId: path.id };
}

async function seedFile(
    tx: postgres.Sql,
    opts: {
        groupId: string | null;
        bytes: number | null;
        missing?: boolean;
        createdAt?: string;
        mtime?: string | null;
    },
): Promise<string> {
    const [row] = await tx<{ id: string }[]>`
        INSERT INTO media_files (file_path, library_group_id, file_size_bytes, is_missing, created_at, file_mtime)
        VALUES (
            ${`/data/fixture/${crypto.randomUUID()}.mkv`},
            ${opts.groupId},
            ${opts.bytes},
            ${opts.missing ?? false},
            ${opts.createdAt ?? '1971-06-01T12:00:00Z'}::timestamptz,
            ${opts.mtime ?? null}::timestamptz
        )
        RETURNING id
    `;
    return row.id;
}

interface SizeRow {
    media_type: string;
    total_bytes: string;
    file_count: number;
}

async function sizeRowsFor(
    tx: postgres.Sql,
    groupId: string | null,
    day: string,
): Promise<SizeRow[]> {
    return tx<SizeRow[]>`
        SELECT media_type, total_bytes::text AS total_bytes, file_count
        FROM library_size_snapshots
        WHERE taken_on = ${day}::date AND library_group_id IS NOT DISTINCT FROM ${groupId}::uuid
    `;
}

describe('writeLibrarySizeSnapshot', () => {
    it('sums files per library with the media type its paths declare, missing ones too', async () => {
        await inRolledBackTx(async (tx) => {
            const movies = await seedLibrary(tx, 'growth-movies', 'movie');
            await seedFile(tx, { groupId: movies.groupId, bytes: 100 });
            await seedFile(tx, { groupId: movies.groupId, bytes: 200 });
            await seedFile(tx, { groupId: movies.groupId, bytes: 999, missing: true });

            await writeLibrarySizeSnapshot(tx, '1971-01-05');

            expect(await sizeRowsFor(tx, movies.groupId, '1971-01-05')).toEqual([
                // The missing file still counts: a dropped mount must not draw a cliff.
                { media_type: 'movie', total_bytes: '1299', file_count: 3 },
            ]);
        });
    });

    it('replaces the day instead of keeping a stale row, also for files without a library', async () => {
        await inRolledBackTx(async (tx) => {
            const shows = await seedLibrary(tx, 'growth-shows', 'tv');
            const big = await seedFile(tx, { groupId: shows.groupId, bytes: 5_000 });
            await seedFile(tx, { groupId: null, bytes: 7 });

            await writeLibrarySizeSnapshot(tx, '1971-01-06');
            await tx`DELETE FROM media_files WHERE id = ${big}`;
            await writeLibrarySizeSnapshot(tx, '1971-01-06');

            // The library lost its only file: no row left for it that day.
            expect(await sizeRowsFor(tx, shows.groupId, '1971-01-06')).toEqual([]);
            // Files with no group: one 'unknown' row, not one per run.
            const ungrouped = await sizeRowsFor(tx, null, '1971-01-06');
            expect(ungrouped).toHaveLength(1);
            expect(ungrouped[0].media_type).toBe('unknown');
        });
    });

    it('lands on today by default and feeds the totals and the media-type split', async () => {
        await inRolledBackTx(async (tx) => {
            await tx`DELETE FROM library_size_snapshots`;
            const music = await seedLibrary(tx, 'growth-music', 'music');
            await seedFile(tx, { groupId: music.groupId, bytes: 4_000 });

            await writeLibrarySizeSnapshot(tx);
            const today = await getDatabaseToday(tx);
            const [{ current }] = await tx<{ current: string }[]>`
                SELECT to_char(current_date, 'YYYY-MM-DD') AS current
            `;
            expect(today).toBe(current);

            const totals = await getLibrarySizeSnapshotTotals(tx, 30);
            expect(totals.at(-1)?.date).toBe(today);
            expect(totals.at(-1)?.bytes).toBeGreaterThanOrEqual(4_000);

            const split = await getLatestLibrarySizeByMediaType(tx);
            const musicRow = split.find((r) => r.mediaType === 'music');
            expect(musicRow?.bytes).toBeGreaterThanOrEqual(4_000);
            expect(musicRow?.fileCount).toBeGreaterThanOrEqual(1);
        });
    });
});

describe('library volume snapshots', () => {
    it('round-trips 50 TB shares with library names; a later run updates, never erases', async () => {
        await inRolledBackTx(async (tx) => {
            await tx`DELETE FROM library_volume_snapshots`;
            const a = await seedLibrary(tx, 'growth-vol-a', 'movie');
            const b = await seedLibrary(tx, 'growth-vol-b', 'tv');
            const tb = 1024 ** 4;

            await writeLibraryVolumeSnapshots(tx, [
                {
                    libraryPathId: a.pathId,
                    deviceId: '64769',
                    freeBytes: 3 * tb,
                    totalBytes: 50 * tb,
                },
                {
                    libraryPathId: b.pathId,
                    deviceId: '64769',
                    freeBytes: 3 * tb,
                    totalBytes: 50 * tb,
                },
            ]);
            // A second run the same day where one path could not be measured.
            await writeLibraryVolumeSnapshots(tx, [
                {
                    libraryPathId: a.pathId,
                    deviceId: '64769',
                    freeBytes: 2.5 * tb,
                    totalBytes: 50 * tb,
                },
            ]);

            // A restart while a mount is down must not erase the day's reading.
            await writeLibraryVolumeSnapshots(tx, []);

            const rows = await getLibraryVolumeSnapshots(tx, 7);
            expect(rows).toHaveLength(2);
            expect(rows.find((r) => r.libraryPathId === a.pathId)).toMatchObject({
                deviceId: '64769',
                freeBytes: 2.5 * tb,
                totalBytes: 50 * tb,
                libraryName: 'growth-vol-a',
            });
            // Not measured in the second run: the first run's reading stays.
            expect(rows.find((r) => r.libraryPathId === b.pathId)?.freeBytes).toBe(3 * tb);
        });
    });

    it('keeps rows of a deleted path, without a name', async () => {
        await inRolledBackTx(async (tx) => {
            await tx`DELETE FROM library_volume_snapshots`;
            const gone = await seedLibrary(tx, 'growth-vol-gone', 'movie');
            await writeLibraryVolumeSnapshots(tx, [
                { libraryPathId: gone.pathId, deviceId: '1', freeBytes: 10, totalBytes: 20 },
            ]);
            await tx`DELETE FROM library_paths WHERE id = ${gone.pathId}`;

            const rows = await getLibraryVolumeSnapshots(tx, 7);
            expect(rows).toHaveLength(1);
            expect(rows[0].libraryName).toBeNull();
        });
    });
});

describe('pruneLibraryStorageSnapshots', () => {
    it('drops rows older than the retention from both tables', async () => {
        await inRolledBackTx(async (tx) => {
            const lib = await seedLibrary(tx, 'growth-prune', 'movie');
            await seedFile(tx, { groupId: lib.groupId, bytes: 1 });
            await tx`DELETE FROM library_size_snapshots`;
            await tx`DELETE FROM library_volume_snapshots`;
            await writeLibrarySizeSnapshot(tx, '1971-01-01');
            await writeLibrarySizeSnapshot(tx);
            await writeLibraryVolumeSnapshots(
                tx,
                [{ libraryPathId: lib.pathId, deviceId: '1', freeBytes: 1, totalBytes: 2 }],
                '1971-01-01',
            );

            const pruned = await pruneLibraryStorageSnapshots(tx, 730);

            expect(pruned).toBeGreaterThanOrEqual(2);
            const [{ old }] = await tx<{ old: number }[]>`
                SELECT (SELECT count(*) FROM library_size_snapshots WHERE taken_on < '2000-01-01')
                     + (SELECT count(*) FROM library_volume_snapshots WHERE taken_on < '2000-01-01') AS old
            `;
            expect(Number(old)).toBe(0);
            expect((await getLibrarySizeSnapshotTotals(tx, 1)).length).toBe(1);
        });
    });
});

describe('getLibraryBackfillDaily', () => {
    it('dates each present file by the earlier of first-seen and mtime', async () => {
        await inRolledBackTx(async (tx) => {
            const lib = await seedLibrary(tx, 'growth-backfill', 'movie');
            // Copied onto the disk long before Lumastra first saw it.
            await seedFile(tx, {
                groupId: lib.groupId,
                bytes: 1_000,
                createdAt: '1995-03-10T12:00:00Z',
                mtime: '1995-03-02T12:00:00Z',
            });
            // No mtime recorded: first-seen day.
            await seedFile(tx, {
                groupId: lib.groupId,
                bytes: 20,
                createdAt: '1995-03-10T12:00:00Z',
            });
            // mtime AFTER first-seen (file rewritten in place): still first-seen day.
            await seedFile(tx, {
                groupId: lib.groupId,
                bytes: 3,
                createdAt: '1995-03-10T12:00:00Z',
                mtime: '1995-04-01T12:00:00Z',
            });
            // A broken-clock mtime (epoch 0) is not history: first-seen day.
            await seedFile(tx, {
                groupId: lib.groupId,
                bytes: 400,
                createdAt: '1995-03-10T12:00:00Z',
                mtime: '1970-01-01T00:00:00Z',
            });
            // Missing files count (as on the card); size-less ones cannot.
            await seedFile(tx, {
                groupId: lib.groupId,
                bytes: 50_000,
                missing: true,
                createdAt: '1995-03-02T12:00:00Z',
            });
            await seedFile(tx, {
                groupId: lib.groupId,
                bytes: null,
                createdAt: '1995-03-02T12:00:00Z',
            });

            const days = await getLibraryBackfillDaily(tx);
            const byDay = new Map(days.map((d) => [d.date, d.bytes]));

            expect(byDay.get('1995-03-02')).toBe(51_000);
            expect(byDay.get('1995-03-10')).toBe(423);
            expect(byDay.has('1995-04-01')).toBe(false);
            expect(byDay.has('1970-01-01')).toBe(false);
            // Oldest first.
            const sorted = [...days].sort((x, y) => (x.date < y.date ? -1 : 1));
            expect(days).toEqual(sorted);
        });
    });
});
