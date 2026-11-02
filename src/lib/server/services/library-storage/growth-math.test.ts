// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    buildGrowthSeries,
    downsampleSeries,
    estimateTimeToFull,
    type FreeSpacePoint,
    type GrowthPoint,
} from './growth-math';

const GB = 1e9;
const BASE_DAY = Date.UTC(2026, 0, 1) / 86_400_000;

function dateOf(offset: number): string {
    return new Date((BASE_DAY + offset) * 86_400_000).toISOString().slice(0, 10);
}

/** Free-space series for days 0..n-1 from a value function. */
function series(n: number, free: (t: number) => number, start = 0): FreeSpacePoint[] {
    return Array.from({ length: n }, (_, t) => ({
        date: dateOf(start + t),
        freeBytes: free(start + t),
    }));
}

/** Tiny deterministic LCG returning values in [-1, 1). */
function lcg(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296;
        return (s / 4_294_967_296) * 2 - 1;
    };
}

describe('estimateTimeToFull', () => {
    it('flat free space is not filling', () => {
        expect(estimateTimeToFull(series(30, () => 1e12))).toMatchObject({ state: 'not_filling' });
    });

    it('steady usage growth gives an exact range', () => {
        // 10 GB/day, last day has exactly 1 TB free. A perfectly steady history
        // has nothing to resample, so every simulated path agrees.
        const est = estimateTimeToFull(series(30, (t) => 1.29e12 - 10 * GB * t));
        expect(est).toMatchObject({
            state: 'filling',
            daysUntilFull: 100,
            daysUntilFullLow: 100,
            daysUntilFullHigh: 100,
            bytesPerDay: 10 * GB,
            model: 'trend',
            basisDays: 30,
            bandLevel: 0.9,
        });
    });

    it('shrinking usage (free rises) is not filling', () => {
        expect(estimateTimeToFull(series(30, (t) => 1e12 + 5 * GB * t))).toMatchObject({
            state: 'not_filling',
        });
    });

    it('stays near the truth with noise and two big outliers', () => {
        const noise = lcg(42);
        const pts = series(80, (t) => {
            const level = 2e12 - 10 * GB * t;
            let v = level * (1 + 0.05 * noise());
            if (t === 20) v += 500 * GB; // temporary deletion
            if (t === 50) v -= 400 * GB; // temporary transcode spike
            return v;
        });
        // Truth: 10 GB/day from the true level on the last day (79): 2e12 - 790 GB.
        const truth = (2e12 - 10 * GB * 79) / (10 * GB);
        const est = estimateTimeToFull(pts);
        expect(est.state).toBe('filling');
        if (est.state !== 'filling') return;
        expect(Math.abs(est.daysUntilFull - truth) / truth).toBeLessThan(0.15);
        expect(est.daysUntilFullLow).toBeLessThanOrEqual(est.daysUntilFull);
        expect(est.daysUntilFullHigh).toBeDefined();
        expect(est.daysUntilFull).toBeLessThanOrEqual(est.daysUntilFullHigh!);
    });

    it('needs at least 14 distinct days', () => {
        const few = estimateTimeToFull(series(13, (t) => 1e12 - GB * t));
        expect(few).toEqual({ state: 'insufficient_data', snapshotDays: 13 });
        const enough = estimateTimeToFull(series(14, (t) => 1e12 - GB * t));
        expect(enough.state).toBe('filling');
    });

    it('respects custom minDays', () => {
        const est = estimateTimeToFull(
            series(5, (t) => 1e12 - GB * t),
            { minDays: 5 },
        );
        expect(est.state).toBe('filling');
    });

    it('drops an older growth regime the recent weeks no longer resemble', () => {
        // 100 days of steep decline (50 GB/day), then 91 days at 1 GB/day.
        // Was a fixed 90-day window; now the regime check finds the cut, so
        // the answer is the same however much history is passed.
        const steep = series(100, (t) => 9e12 - 50 * GB * t);
        const slow = series(91, (t) => 2e12 - GB * (t - 100), 100);
        const est = estimateTimeToFull([...steep, ...slow]);
        expect(est).toMatchObject({ state: 'filling', daysUntilFull: 1910, bytesPerDay: GB });
        expect(est.state === 'filling' && est.basisDays).toBeLessThan(100);
        const all = estimateTimeToFull([...steep, ...slow], { windowDays: 10_000 });
        expect(all).toMatchObject({ state: 'filling', daysUntilFull: 1910 });
        // A short window still limits what is considered.
        const short = estimateTimeToFull([...steep, ...slow], { windowDays: 20 });
        expect(short).toMatchObject({ state: 'filling', basisDays: 21 });
    });

    it('lets the last duplicate of a date win', () => {
        const good = series(20, (t) => 1.19e12 - 10 * GB * t);
        const junk: FreeSpacePoint[] = [{ date: dateOf(3), freeBytes: 5e12 }];
        // Junk first, the real value (in `good`) comes later and must win.
        const est = estimateTimeToFull([...junk, ...good]);
        expect(est).toMatchObject({ state: 'filling', daysUntilFull: 100 });
        // Junk last overrides the real value for that day: no longer exact.
        const est2 = estimateTimeToFull([...good, ...junk]);
        expect(est2.state).toBe('filling');
        expect(est2.state === 'filling' && est2.daysUntilFull).toBe(100);
    });

    it('returns 0 days when free space is already 0', () => {
        const est = estimateTimeToFull(series(20, (t) => Math.max(0, 190 * GB - 10 * GB * t)));
        expect(est).toMatchObject({ state: 'filling', daysUntilFull: 0, daysUntilFullLow: 0 });
    });

    it('omits the high end when the slow paths never fill', () => {
        // 30 days, all growth in one 200 GB step, 4.8 TB left: many futures
        // see no further step for decades. (Was a Theil-Sen band test; the
        // band now comes from simulated paths.)
        const est = estimateTimeToFull(series(30, (t) => 5e12 - (t >= 10 ? 200 * GB : 0)));
        expect(est.state).toBe('filling');
        if (est.state !== 'filling') return;
        expect(est.daysUntilFullHigh).toBeUndefined();
        expect(est.daysUntilFullLow).toBeLessThanOrEqual(est.daysUntilFull);
        expect(est.confidence).toBe('low');
    });

    it('ignores invalid rows', () => {
        const pts: FreeSpacePoint[] = [
            ...series(14, (t) => 1.13e12 - 10 * GB * t),
            { date: 'nope', freeBytes: 1 },
            { date: '2026-02-31', freeBytes: 1 },
            { date: dateOf(5), freeBytes: Number.NaN },
            { date: dateOf(6), freeBytes: -5 },
            { date: dateOf(7), freeBytes: Number.POSITIVE_INFINITY },
        ];
        expect(estimateTimeToFull(pts)).toMatchObject({ state: 'filling', daysUntilFull: 100 });
    });

    it('reports zero days for empty input', () => {
        expect(estimateTimeToFull([])).toEqual({ state: 'insufficient_data', snapshotDays: 0 });
    });
});

describe('buildGrowthSeries', () => {
    it('folds pre-window days into the baseline', () => {
        const series = buildGrowthSeries({
            backfillDaily: [
                { date: '2020-01-01', bytes: 100 },
                { date: '2020-06-01', bytes: 50 },
                { date: '2026-01-05', bytes: 10 },
            ],
            snapshots: [],
            today: '2026-01-10',
            windowDays: 10,
        });
        expect(series).toEqual([
            { date: '2025-12-31', bytes: 150, approximate: true },
            { date: '2026-01-05', bytes: 160, approximate: true },
            { date: '2026-01-10', bytes: 160, approximate: true },
        ]);
    });

    it('switches from approximate to real at the first snapshot', () => {
        const series = buildGrowthSeries({
            backfillDaily: [
                { date: '2026-01-01', bytes: 100 },
                { date: '2026-01-03', bytes: 20 },
                { date: '2026-01-06', bytes: 30 },
            ],
            snapshots: [
                { date: '2026-01-07', bytes: 160 },
                { date: '2026-01-05', bytes: 125 },
            ],
            today: '2026-01-08',
        });
        expect(series).toEqual([
            { date: '2026-01-01', bytes: 100, approximate: true },
            { date: '2026-01-03', bytes: 120, approximate: true },
            { date: '2026-01-05', bytes: 125, approximate: false },
            { date: '2026-01-07', bytes: 160, approximate: false },
        ]);
    });

    it('ends at today when there are no snapshots', () => {
        const series = buildGrowthSeries({
            backfillDaily: [{ date: '2026-01-01', bytes: 100 }],
            snapshots: [],
            today: '2026-01-04',
        });
        expect(series.at(-1)).toEqual({ date: '2026-01-04', bytes: 100, approximate: true });
        expect(series).toHaveLength(2);
    });

    it('does not duplicate today when a backfill day is today', () => {
        const series = buildGrowthSeries({
            backfillDaily: [
                { date: '2026-01-01', bytes: 100 },
                { date: '2026-01-04', bytes: 5 },
            ],
            snapshots: [],
            today: '2026-01-04',
        });
        expect(series.map((p) => p.date)).toEqual(['2026-01-01', '2026-01-04']);
        expect(series.at(-1)!.bytes).toBe(105);
    });

    it('dedupes snapshots by date, last wins, and drops out-of-range ones', () => {
        const series = buildGrowthSeries({
            backfillDaily: [],
            snapshots: [
                { date: '2026-01-02', bytes: 1 },
                { date: '2026-01-02', bytes: 2 },
                { date: '2025-01-01', bytes: 9 },
                { date: '2026-02-01', bytes: 9 },
            ],
            today: '2026-01-05',
            windowDays: 30,
        });
        expect(series).toEqual([{ date: '2026-01-02', bytes: 2, approximate: false }]);
    });

    it('returns [] for empty input', () => {
        expect(
            buildGrowthSeries({ backfillDaily: [], snapshots: [], today: '2026-01-01' }),
        ).toEqual([]);
    });
});

describe('downsampleSeries', () => {
    function longSeries(n: number, approxCount: number): GrowthPoint[] {
        return Array.from({ length: n }, (_, i) => ({
            date: dateOf(i),
            bytes: i * 1000,
            approximate: i < approxCount,
        }));
    }

    it('leaves short series untouched (as a copy)', () => {
        const pts = longSeries(50, 10);
        const out = downsampleSeries(pts);
        expect(out).toEqual(pts);
        expect(out).not.toBe(pts);
    });

    it('thins 730 points to at most 120, keeping the anchors', () => {
        const pts = longSeries(730, 400);
        const out = downsampleSeries(pts);
        expect(out.length).toBeLessThanOrEqual(120);
        expect(out.length).toBeGreaterThan(100);
        expect(out[0]).toEqual(pts[0]);
        expect(out.at(-1)).toEqual(pts[729]);
        expect(out).toContainEqual(pts[399]); // last approximate
        expect(out).toContainEqual(pts[400]); // first real
        const dates = out.map((p) => p.date);
        expect(dates).toEqual([...dates].sort());
        expect(new Set(dates).size).toBe(dates.length);
    });

    it('respects a small maxPoints even with anchors', () => {
        const out = downsampleSeries(longSeries(200, 100), 10);
        expect(out.length).toBeLessThanOrEqual(10);
        expect(out[0].date).toBe(dateOf(0));
        expect(out.at(-1)!.date).toBe(dateOf(199));
        expect(out.some((p) => p.date === dateOf(99))).toBe(true);
        expect(out.some((p) => p.date === dateOf(100))).toBe(true);
    });

    it('buckets by time so gaps stay gaps', () => {
        // 150 dense points, a long gap, 5 points at the end.
        const dense = longSeries(150, 0);
        const tail: GrowthPoint[] = Array.from({ length: 5 }, (_, i) => ({
            date: dateOf(1000 + i),
            bytes: 1,
            approximate: false,
        }));
        const out = downsampleSeries([...dense, ...tail], 20);
        expect(out.length).toBeLessThanOrEqual(20);
        expect(out.at(-1)!.date).toBe(dateOf(1004));
    });
});
