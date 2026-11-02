// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library growth answer for the admin home: the size curve (≤ 120 points) and,
 * per filesystem the libraries live on, when it fills at the current pace.
 *
 * Read-only over the daily snapshots (`library-storage-snapshot` task) plus a
 * reconstruction from `media_files` for the days before the first snapshot. It
 * runs on the web process and never touches a mount: free space comes from
 * what the worker measured.
 */

import type postgres from 'postgres';
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
    type LibraryVolumeGrowth,
    type StorageEstimate,
} from '$lib/schemas/admin-library-storage-growth.js';
import {
    buildArrivalPrior,
    buildGrowthSeries,
    downsampleSeries,
    estimateTimeToFull,
    type ArrivalPrior,
    type FreeSpacePoint,
} from './growth-math.js';

/** The sparkline's range; the snapshot task keeps the same two years. */
const SERIES_WINDOW_DAYS = 730;
const SERIES_MAX_POINTS = 120;
/**
 * The estimate weighs up to two years (recent days count more); one more day
 * so the oldest kept snapshot is included.
 */
const VOLUME_WINDOW_DAYS = 731;
/**
 * A filesystem not measured for a week is hidden rather than estimated: the
 * worker lost the mount or stopped running, and a figure from then is stale.
 */
const VOLUME_STALE_DAYS = 7;

const CACHE_KEY = 'v1:admin:library-storage-growth';
/** Snapshots change once a day; the backfill aggregate is the only cost. */
const CACHE_TTL_S = 900;

function dayNumber(date: string): number {
    return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

/**
 * Group volume rows into filesystems by each path's LATEST reading, then
 * follow each filesystem back in time through its library paths. A device id
 * can change after a remount; the paths on it do not.
 *
 * Staleness is judged per filesystem: a share the worker could not reach
 * since yesterday stays on the list (with days counted from today) until it
 * has been unmeasured for a week, even while other filesystems are measured.
 */
export function groupVolumes(
    rows: VolumeSnapshotRow[],
    today: string,
    prior: ArrivalPrior | null = null,
): LibraryVolumeGrowth[] {
    if (rows.length === 0) return [];

    const latestByPath = new Map<string, VolumeSnapshotRow>();
    for (const r of rows) {
        const prev = latestByPath.get(r.libraryPathId);
        if (!prev || r.date > prev.date) latestByPath.set(r.libraryPathId, r);
    }
    const groups = new Map<string, VolumeSnapshotRow[]>();
    for (const r of latestByPath.values()) {
        const g = groups.get(r.deviceId);
        if (g) g.push(r);
        else groups.set(r.deviceId, [r]);
    }

    const out: LibraryVolumeGrowth[] = [];
    for (const [deviceId, members] of groups) {
        const measuredOn = members.reduce(
            (max, m) => (m.date > max ? m.date : max),
            members[0].date,
        );
        const staleDays = Math.max(0, dayNumber(today) - dayNumber(measuredOn));
        if (staleDays > VOLUME_STALE_DAYS) continue;
        const pathIds = new Set(members.map((m) => m.libraryPathId));
        // A path that lived on ANOTHER filesystem earlier (moved to a new disk)
        // must not lend this one its old free space: that reads as a giant
        // one-day jump. Each path counts from the day after it last reported a
        // different device than today's, which still keeps a remount that only
        // renumbered the device (every path changes on the same day).
        const since = new Map<string, string>();
        for (const r of rows) {
            if (!pathIds.has(r.libraryPathId)) continue;
            if (r.deviceId !== deviceId) {
                const prev = since.get(r.libraryPathId);
                if (prev === undefined || r.date > prev) since.set(r.libraryPathId, r.date);
            }
        }
        // A remount keeps the filesystem's size; a different disk rarely has
        // the same size within 2 %, which separates the two even for one path.
        const sameSize = rows.every(
            (r) =>
                !pathIds.has(r.libraryPathId) ||
                r.deviceId === deviceId ||
                Math.abs(r.totalBytes - members[0].totalBytes) <= members[0].totalBytes * 0.02,
        );
        const remountedTogether =
            sameSize && since.size === pathIds.size && new Set(since.values()).size === 1;
        // All paths on one filesystem report the same free space; take the
        // smallest so one odd reading never hides a filling disk.
        const freeByDay = new Map<string, number>();
        for (const r of rows) {
            if (!pathIds.has(r.libraryPathId)) continue;
            const cut = remountedTogether ? undefined : since.get(r.libraryPathId);
            if (cut !== undefined && r.date <= cut) continue;
            const prev = freeByDay.get(r.date);
            if (prev === undefined || r.freeBytes < prev) freeByDay.set(r.date, r.freeBytes);
        }
        const points: FreeSpacePoint[] = [...freeByDay.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([date, freeBytes]) => ({ date, freeBytes }));

        const head = members[0];
        const libraries = [
            ...new Set(members.map((m) => m.libraryName).filter((n): n is string => !!n)),
        ].sort((a, b) => a.localeCompare(b, 'en'));
        out.push({
            id: deviceId,
            libraries,
            freeBytes: Math.min(...members.map((m) => m.freeBytes)),
            totalBytes: head.totalBytes,
            measuredOn,
            estimate: fromToday(estimateTimeToFull(points, { prior }), staleDays),
        });
    }

    return out.sort(compareVolumes);
}

/**
 * The estimate counts days from the last measurement; the UI and the attention
 * item read them as "from today". Shift by how stale the measurement is.
 */
function fromToday(e: StorageEstimate, staleDays: number): StorageEstimate {
    if (e.state !== 'filling' || staleDays === 0) return e;
    const shift = (d: number): number => Math.max(0, d - staleDays);
    return {
        ...e,
        daysUntilFull: shift(e.daysUntilFull),
        daysUntilFullLow: shift(e.daysUntilFullLow),
        ...(e.daysUntilFullHigh !== undefined
            ? { daysUntilFullHigh: shift(e.daysUntilFullHigh) }
            : {}),
    };
}

/** Soonest-to-fill first, then the ones without an estimate, then by size. */
function compareVolumes(a: LibraryVolumeGrowth, b: LibraryVolumeGrowth): number {
    const rank = (v: LibraryVolumeGrowth): number =>
        v.estimate.state === 'filling' ? v.estimate.daysUntilFull : Number.POSITIVE_INFINITY;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (a.totalBytes !== b.totalBytes) return b.totalBytes - a.totalBytes;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function computeLibraryStorageGrowth(
    sql: postgres.Sql,
): Promise<LibraryStorageGrowth> {
    const [today, backfillDaily, snapshots, byMediaType, volumeRows] = await Promise.all([
        getDatabaseToday(sql),
        getLibraryBackfillDaily(sql),
        getLibrarySizeSnapshotTotals(sql, SERIES_WINDOW_DAYS),
        getLatestLibrarySizeByMediaType(sql),
        getLibraryVolumeSnapshots(sql, VOLUME_WINDOW_DAYS),
    ]);

    const series = downsampleSeries(
        buildGrowthSeries({ backfillDaily, snapshots, today, windowDays: SERIES_WINDOW_DAYS }),
        SERIES_MAX_POINTS,
    );

    return {
        generatedAt: new Date().toISOString(),
        series,
        firstSnapshotDate: snapshots[0]?.date,
        byMediaType,
        // Library-wide arrival history: shape of growth (bursts, seasons) only, built once.
        volumes: groupVolumes(volumeRows, today, buildArrivalPrior(backfillDaily)),
    };
}

/** Cached across replicas; the admin home asks once per visit. */
export async function getLibraryStorageGrowth(sql: postgres.Sql): Promise<LibraryStorageGrowth> {
    const body = await getOrComputeSingleFlight({
        cacheKey: CACHE_KEY,
        ttlSeconds: CACHE_TTL_S,
        compute: async () => JSON.stringify(await computeLibraryStorageGrowth(sql)),
    });
    // A body cached by the previous release may not match this one's schema
    // for up to 15 min after a deploy; recompute instead of answering 500.
    let cached: unknown;
    try {
        cached = JSON.parse(body);
    } catch {
        cached = undefined;
    }
    const parsed = LibraryStorageGrowthSchema.safeParse(cached);
    return parsed.success ? parsed.data : computeLibraryStorageGrowth(sql);
}
