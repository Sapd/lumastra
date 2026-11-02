// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure math for the admin "library size" card: a growth series for the
 * sparkline (this file) and the "disk full in ~N months" estimate
 * (`disk-full-forecast.ts`). No DB, no I/O.
 */

import { formatDay, parseDay } from './disk-full-forecast.js';

// The disk-full model lives in its own file; re-exported so callers keep one import.
export {
    buildArrivalPrior,
    estimateTimeToFull,
    type ArrivalPrior,
    type EstimateOptions,
    type ForecastConfidence,
    type ForecastModel,
    type FreeSpacePoint,
    type StorageEstimate,
} from './disk-full-forecast.js';

export interface GrowthPoint {
    date: string;
    bytes: number;
    approximate: boolean;
}

export interface BuildGrowthSeriesInput {
    /** Bytes of CURRENT files grouped by the day each file arrived (approximation: deleted files are missing). Any order, may contain days before windowStart. */
    backfillDaily: Array<{ date: string; bytes: number }>;
    /** Real daily snapshots of total library bytes. Any order. */
    snapshots: Array<{ date: string; bytes: number }>;
    today: string;
    /** Default 730. */
    windowDays?: number;
}

/**
 * Joins the approximate history (rebuilt from file arrival dates) with the
 * real snapshots. Snapshots win from their first day on; the backfill only
 * fills the time before, so the chart can draw that part dashed.
 */
export function buildGrowthSeries(input: BuildGrowthSeriesInput): GrowthPoint[] {
    const todayDay = parseDay(input.today);
    if (todayDay === null) return [];
    const windowStart = todayDay - (input.windowDays ?? 730);

    const snaps = new Map<number, number>();
    for (const s of input.snapshots) {
        const day = parseDay(s.date);
        if (day === null || !Number.isFinite(s.bytes)) continue;
        if (day < windowStart || day > todayDay) continue;
        snaps.set(day, s.bytes);
    }
    const snapDays = [...snaps.keys()].sort((a, b) => a - b);

    // Several rows for the same day add up; days after today are not history.
    const arrivals = new Map<number, number>();
    for (const b of input.backfillDaily) {
        const day = parseDay(b.date);
        if (day === null || !Number.isFinite(b.bytes) || day > todayDay) continue;
        arrivals.set(day, (arrivals.get(day) ?? 0) + b.bytes);
    }
    const arrivalDays = [...arrivals.keys()].sort((a, b) => a - b);

    const out = new Map<number, GrowthPoint>();
    // The backfill only covers the time before the first real snapshot.
    const coveredEnd = snapDays.length > 0 ? snapDays[0] - 1 : todayDay;

    if (arrivalDays.length > 0) {
        // Cumulative bytes at the end of each arrival day; pre-window days fold into it.
        const cumulativeAt = new Map<number, number>();
        let running = 0;
        for (const day of arrivalDays) {
            running += arrivals.get(day) as number;
            cumulativeAt.set(day, running);
        }
        const startDay = Math.max(windowStart, arrivalDays[0]);
        const cumulativeUpTo = (day: number): number => {
            let value = 0;
            for (const d of arrivalDays) {
                if (d > day) break;
                value = cumulativeAt.get(d) as number;
            }
            return value;
        };
        // Arrival days read their running total directly; only the two points
        // that can fall between arrivals scan (prod has ~5,500 arrival days).
        const emit = (day: number, bytes = cumulativeUpTo(day)): void => {
            out.set(day, { date: formatDay(day), bytes, approximate: true });
        };
        if (startDay <= coveredEnd) emit(startDay);
        for (const day of arrivalDays) {
            if (day > startDay && day <= coveredEnd) emit(day, cumulativeAt.get(day));
        }
        if (snapDays.length === 0 && !out.has(todayDay)) emit(todayDay, running);
    }

    for (const day of snapDays) {
        out.set(day, { date: formatDay(day), bytes: snaps.get(day) as number, approximate: false });
    }

    return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
}

/**
 * Thins a series for the sparkline. Buckets by time, not by index, so a gap
 * between the backfill and the snapshots stays a gap. The series is
 * cumulative, so the last point of a bucket is the right one to keep. The
 * boundary between approximate and real points is kept so the dashed/solid
 * switch does not move.
 */
export function downsampleSeries(points: GrowthPoint[], maxPoints = 120): GrowthPoint[] {
    if (points.length <= maxPoints) return [...points];

    const dayOf = (p: GrowthPoint): number => parseDay(p.date) ?? 0;
    const first = dayOf(points[0]);
    const span = Math.max(1, dayOf(points[points.length - 1]) - first);

    const anchors = new Set<number>([0, points.length - 1]);
    let lastApprox = -1;
    let firstReal = -1;
    points.forEach((p, i) => {
        if (p.approximate) lastApprox = i;
        else if (firstReal < 0) firstReal = i;
    });
    if (lastApprox >= 0) anchors.add(lastApprox);
    if (firstReal >= 0) anchors.add(firstReal);

    // Last index per time bucket.
    const lastInBucket = new Map<number, number>();
    points.forEach((p, i) => {
        const b = Math.min(maxPoints - 1, Math.floor(((dayOf(p) - first) / span) * maxPoints));
        lastInBucket.set(b, i);
    });
    const candidates = [...lastInBucket.values()]
        .filter((i) => !anchors.has(i))
        .sort((a, b) => a - b);

    const room = Math.max(0, maxPoints - anchors.size);
    let chosen = candidates;
    if (candidates.length > room) {
        // Evenly thin the interior points; anchors are never dropped.
        chosen = [];
        for (let k = 0; k < room; k++) {
            chosen.push(candidates[Math.floor(((k + 0.5) * candidates.length) / room)]);
        }
    }
    return [...new Set([...anchors, ...chosen])].sort((a, b) => a - b).map((i) => points[i]);
}
