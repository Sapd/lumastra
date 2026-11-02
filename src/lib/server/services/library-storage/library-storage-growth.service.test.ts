// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * groupVolumes: library paths → filesystems → a free-space series per
 * filesystem. The traps it exists for: several libraries on one share must give
 * ONE filesystem, a remount that renumbers the device must not cut the series,
 * and a filesystem nobody measured for a week must be hidden, not estimated.
 * Also protects the response schema, series bound, and cached-body validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';

vi.mock('$lib/server/cache/single-flight.js', () => ({ getOrComputeSingleFlight: vi.fn() }));
vi.mock('$lib/server/database/queries/library-storage-history.queries.js', () => ({
    getDatabaseToday: vi.fn(),
    getLatestLibrarySizeByMediaType: vi.fn(),
    getLibraryBackfillDaily: vi.fn(),
    getLibrarySizeSnapshotTotals: vi.fn(),
    getLibraryVolumeSnapshots: vi.fn(),
}));

import {
    computeLibraryStorageGrowth,
    getLibraryStorageGrowth,
    groupVolumes,
} from './library-storage-growth.service.js';
import {
    getDatabaseToday,
    getLatestLibrarySizeByMediaType,
    getLibraryBackfillDaily,
    getLibrarySizeSnapshotTotals,
    getLibraryVolumeSnapshots,
    type VolumeSnapshotRow,
} from '$lib/server/database/queries/library-storage-history.queries.js';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import {
    LibraryStorageGrowthSchema,
    type LibraryStorageGrowth,
} from '$lib/schemas/admin-library-storage-growth.js';

const GIB = 1024 ** 3;

function day(offset: number): string {
    return new Date(Date.UTC(2026, 9, 21) + offset * 86_400_000).toISOString().slice(0, 10);
}

/** 30 days of a share losing 10 GiB a day, starting with 1 TiB free. */
function share(pathId: string, name: string, device: (d: number) => string): VolumeSnapshotRow[] {
    return Array.from({ length: 30 }, (_, i) => ({
        date: day(i - 29),
        libraryPathId: pathId,
        deviceId: device(i),
        freeBytes: (1024 - 10 * i) * GIB,
        totalBytes: 50_000 * GIB,
        libraryName: name,
    }));
}

describe('groupVolumes', () => {
    it('gives one filesystem for libraries on one share, with an estimate', () => {
        const rows = [...share('p1', 'Series', () => '7'), ...share('p2', 'Movies', () => '7')];
        const vols = groupVolumes(rows, day(0));
        expect(vols).toHaveLength(1);
        expect(vols[0].libraries).toEqual(['Movies', 'Series']);
        expect(vols[0].measuredOn).toBe(day(0));
        // 734 GiB free at 10 GiB/day: full on day 74 (73 days leave 4 GiB).
        expect(vols[0].estimate).toMatchObject({ state: 'filling', daysUntilFull: 74 });
    });

    it('follows a filesystem through a remount that changed its device id', () => {
        const rows = share('p1', 'Series', (i) => (i < 20 ? '7' : '9'));
        const vols = groupVolumes(rows, day(0));
        expect(vols).toHaveLength(1);
        expect(vols[0].id).toBe('9');
        expect(vols[0].estimate.state).toBe('filling');
        const unchangedDevice = groupVolumes(
            share('p1', 'Series', () => '7'),
            day(0),
        );
        expect(vols[0].estimate).toEqual(unchangedDevice[0].estimate);
        expect(vols[0].estimate).toMatchObject({ basisDays: 30 });
    });

    it('keeps separate disks apart and puts the soonest first', () => {
        const slow = share('p2', 'Music', () => '8').map((r) => ({
            ...r,
            freeBytes: r.freeBytes + 5_000 * GIB,
        }));
        const vols = groupVolumes([...slow, ...share('p1', 'Series', () => '7')], day(0));
        expect(vols.map((v) => v.libraries[0])).toEqual(['Series', 'Music']);
    });

    it('hides filesystems not measured for over a week', () => {
        expect(
            groupVolumes(
                share('p1', 'Series', () => '7'),
                day(8),
            ),
        ).toEqual([]);
        expect(groupVolumes([], day(0))).toEqual([]);
    });

    it('ages each filesystem independently and counts stale estimates from today', () => {
        const staleRows = share('p2', 'Music', () => '8').map((row, i) => ({
            ...row,
            date: day(i - 32),
        }));
        const expiredRows = share('p3', 'Archive', () => '9').map((row, i) => ({
            ...row,
            date: day(i - 37),
        }));
        const volumes = groupVolumes(
            [...share('p1', 'Movies', () => '7'), ...staleRows, ...expiredRows],
            day(0),
        );
        expect(volumes).toHaveLength(2);
        expect(volumes.find((volume) => volume.id === '7')?.measuredOn).toBe(day(0));
        expect(volumes.find((volume) => volume.id === '9')).toBeUndefined();

        const stale = volumes.find((volume) => volume.id === '8');
        expect(stale?.measuredOn).toBe(day(-3));
        const measuredToday = groupVolumes(staleRows, day(-3))[0].estimate;
        const aged = stale?.estimate;
        expect(measuredToday.state).toBe('filling');
        expect(aged?.state).toBe('filling');
        if (measuredToday.state !== 'filling' || aged?.state !== 'filling') {
            throw new Error('expected filling estimates for both measurement dates');
        }
        expect(aged.daysUntilFull).toBe(measuredToday.daysUntilFull - 3);
        expect(aged.daysUntilFullLow).toBe(measuredToday.daysUntilFullLow - 3);
        expect(aged.daysUntilFullHigh).toBe(measuredToday.daysUntilFullHigh! - 3);
    });

    it('uses only the new disk history after a path moves to a much larger filesystem', () => {
        const rows: VolumeSnapshotRow[] = share('p1', 'Movies', () => '1').map((row, i) => ({
            ...row,
            deviceId: i < 20 ? '1' : '2',
            totalBytes: (i < 20 ? 4 : 50) * 1024 ** 4,
            freeBytes: i < 20 ? (100 - i) * GIB : 40 * 1024 ** 4 - (i - 20) * 10 * GIB,
        }));

        const volumes = groupVolumes(rows, day(0));

        expect(volumes).toHaveLength(1);
        expect(volumes[0].id).toBe('2');
        const estimate = volumes[0].estimate;
        expect(estimate.state).toBe('insufficient_data');
        if (estimate.state !== 'insufficient_data') throw new Error('expected only new-disk data');
        expect(estimate.snapshotDays).toBeGreaterThan(0);
        expect(estimate.snapshotDays).toBeLessThanOrEqual(10);
    });
});

describe('library storage growth responses', () => {
    const sql = mockContext({ runId: 'growth-test' }).sql as postgres.Sql;
    const queries = [
        getDatabaseToday,
        getLatestLibrarySizeByMediaType,
        getLibraryBackfillDaily,
        getLibrarySizeSnapshotTotals,
        getLibraryVolumeSnapshots,
    ];

    beforeEach(() => {
        vi.resetAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
        vi.mocked(getDatabaseToday).mockResolvedValue(day(0));
        vi.mocked(getLibraryBackfillDaily).mockResolvedValue([
            { date: day(-1), bytes: 3 * GIB },
            { date: day(0), bytes: GIB },
        ]);
        vi.mocked(getLibrarySizeSnapshotTotals).mockResolvedValue([]);
        vi.mocked(getLatestLibrarySizeByMediaType).mockResolvedValue([
            { mediaType: 'movie', bytes: 4 * GIB, fileCount: 4 },
        ]);
        vi.mocked(getLibraryVolumeSnapshots).mockResolvedValue(share('p1', 'Movies', () => '7'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns a schema-valid answer with at most 120 points from three years of daily backfill', async () => {
        vi.mocked(getLibraryBackfillDaily).mockResolvedValue(
            Array.from({ length: 1096 }, (_, i) => ({ date: day(i - 1095), bytes: GIB })),
        );
        vi.mocked(getLibrarySizeSnapshotTotals).mockResolvedValue(
            Array.from({ length: 30 }, (_, i) => ({ date: day(i - 29), bytes: (2000 + i) * GIB })),
        );

        const result = await computeLibraryStorageGrowth(sql);

        expect(LibraryStorageGrowthSchema.parse(result)).toEqual(result);
        expect(result.generatedAt).toBe('2026-10-21T12:00:00.000Z');
        expect(result.series.length).toBeGreaterThan(0);
        expect(result.series.length).toBeLessThanOrEqual(120);
        expect(result.series[0].date).toBe(day(-730));
        expect(result.series[result.series.length - 1].date).toBe(day(0));
        expect(result.firstSnapshotDate).toBe(day(-29));
        expect(result.series.some((point) => point.approximate)).toBe(true);
        expect(result.series.some((point) => !point.approximate)).toBe(true);
    });

    it('leaves firstSnapshotDate undefined when there are no snapshots', async () => {
        const result = await computeLibraryStorageGrowth(sql);

        expect(result.firstSnapshotDate).toBeUndefined();
        expect(LibraryStorageGrowthSchema.parse(result)).toEqual(result);
        expect(result.series.length).toBeGreaterThan(0);
        expect(result.series.every((point) => point.approximate)).toBe(true);
    });

    it('recomputes a schema-invalid cached body using fresh query results', async () => {
        vi.mocked(getOrComputeSingleFlight).mockResolvedValue('{"series":"nope"}');

        const result = await getLibraryStorageGrowth(sql);

        expect(LibraryStorageGrowthSchema.parse(result)).toEqual(result);
        expect(result.generatedAt).toBe('2026-10-21T12:00:00.000Z');
        expect(result.byMediaType).toEqual([{ mediaType: 'movie', bytes: 4 * GIB, fileCount: 4 }]);
        expect(result.series[result.series.length - 1].bytes).toBe(4 * GIB);
        expect(result.volumes).toHaveLength(1);
        for (const query of queries) expect(query).toHaveBeenCalledTimes(1);
        expect(getDatabaseToday).toHaveBeenCalledWith(sql);
        expect(getLibrarySizeSnapshotTotals).toHaveBeenCalledWith(sql, 730);
        expect(getLibraryVolumeSnapshots).toHaveBeenCalledWith(sql, 731);
    });

    it('returns a valid cached answer unchanged without querying', async () => {
        const cached: LibraryStorageGrowth = {
            generatedAt: '2026-10-20T00:00:00.000Z',
            series: [{ date: day(-1), bytes: 2 * GIB, approximate: false }],
            firstSnapshotDate: day(-1),
            byMediaType: [{ mediaType: 'tv', bytes: 2 * GIB, fileCount: 2 }],
            volumes: [],
        };
        vi.mocked(getOrComputeSingleFlight).mockResolvedValue(JSON.stringify(cached));

        const result = await getLibraryStorageGrowth(sql);

        expect(result).toEqual(cached);
        expect(getOrComputeSingleFlight).toHaveBeenCalledTimes(1);
        for (const query of queries) expect(query).not.toHaveBeenCalled();
    });
});
