// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The disk-full model on the shapes real libraries produce: steady growth,
 * rare big steps, cache spikes that revert, one-off cleanups, seasons, and a
 * short history helped only by the approximate arrival prior. All inputs are
 * generated deterministically; the model itself is seeded.
 */

import { describe, it, expect } from 'vitest';
import {
    buildArrivalPrior,
    estimateTimeToFull,
    type FreeSpacePoint,
    type StorageEstimate,
} from './disk-full-forecast';

const GB = 1e9;
const DAY_MS = 86_400_000;
const BASE_DAY = Date.UTC(2026, 0, 1) / DAY_MS;

function iso(day: number): string {
    return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Free space for days start..start+n-1 (offsets from 2026-01-01). */
function series(n: number, free: (t: number) => number, start = 0): FreeSpacePoint[] {
    return Array.from({ length: n }, (_, t) => ({
        date: iso(BASE_DAY + start + t),
        freeBytes: free(start + t),
    }));
}

/** Free space from a daily consumption function, ending at `freeAtEnd`. */
function fromConsumption(
    firstDay: number,
    lastDay: number,
    used: (day: number) => number,
    freeAtEnd: number,
): FreeSpacePoint[] {
    let total = 0;
    for (let d = firstDay + 1; d <= lastDay; d++) total += used(d);
    const out: FreeSpacePoint[] = [];
    let so = 0;
    for (let d = firstDay; d <= lastDay; d++) {
        if (d > firstDay) so += used(d);
        out.push({ date: iso(d), freeBytes: freeAtEnd + total - so });
    }
    return out;
}

/** mulberry32 in [0, 1), for test data only. */
function rand(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function filling(est: StorageEstimate): Extract<StorageEstimate, { state: 'filling' }> {
    expect(est.state).toBe('filling');
    if (est.state !== 'filling') throw new Error(`expected filling, got ${est.state}`);
    return est;
}

function bandWidth(est: Extract<StorageEstimate, { state: 'filling' }>): number {
    return (est.daysUntilFullHigh ?? Infinity) - est.daysUntilFullLow;
}

/** 1 GB/day plus a 300 GB step on irregular days: a season pack every few weeks. */
const BURST_DAYS = new Set([7, 30, 41, 70, 96, 110, 141, 160]);
function burstyFree(t: number): number {
    let used = 0;
    for (let k = 1; k <= t; k++) used += GB + (BURST_DAYS.has(k) ? 300 * GB : 0);
    return 4e12 - used;
}

/** 16 years of arrivals: small daily trickle, ~3 % burst days (15 % in December, which is also 3x busier). */
function arrivalHistory(seed: number): Array<{ date: string; bytes: number }> {
    const next = rand(seed);
    const rows: Array<{ date: string; bytes: number }> = [];
    const first = Date.UTC(2010, 0, 1) / DAY_MS;
    const last = Date.UTC(2026, 9, 20) / DAY_MS;
    for (let d = first; d <= last; d++) {
        const december = new Date(d * DAY_MS).getUTCMonth() === 11;
        let bytes = 5 * GB * next();
        if (next() < (december ? 0.15 : 0.03)) bytes += 300 * GB;
        if (december) bytes *= 3;
        rows.push({ date: iso(d), bytes });
    }
    return rows;
}

describe('estimateTimeToFull model', () => {
    it('flat free space is not filling', () => {
        expect(estimateTimeToFull(series(60, () => 2e12))).toEqual({
            state: 'not_filling',
            basisDays: 60,
        });
    });

    it('an already-full disk stays full even after usage has been flat for 30 days', () => {
        const estimate = filling(estimateTimeToFull(series(30, () => 0)));

        expect(estimate).toMatchObject({
            daysUntilFull: 0,
            daysUntilFullLow: 0,
            daysUntilFullHigh: 0,
            bytesPerDay: 0,
            basisDays: 30,
        });
    });

    it('caps a tiny positive pace on a huge disk at a safe integer horizon', () => {
        // At this magnitude a one-byte change is still exactly representable.
        const estimate = filling(estimateTimeToFull(series(30, (t) => 1e15 - t)));

        expect(estimate.bytesPerDay).toBe(1);
        expect(Number.isSafeInteger(estimate.daysUntilFull)).toBe(true);
        expect(estimate.daysUntilFull).toBeGreaterThan(0);
        expect(estimate.daysUntilFull).toBeLessThanOrEqual(36_500);
    });

    it('steady growth matches the simple answer, with high confidence on long data', () => {
        // 10 GB/day for half a year; 1 TB left: exactly 100 days.
        const est = filling(estimateTimeToFull(series(180, (t) => 2.79e12 - 10 * GB * t)));
        expect(est).toMatchObject({
            daysUntilFull: 100,
            daysUntilFullLow: 100,
            daysUntilFullHigh: 100,
            bytesPerDay: 10 * GB,
            model: 'trend',
            confidence: 'high',
            basisDays: 180,
        });
        // Short history of the same line: same answer, less trust.
        expect(estimateTimeToFull(series(30, (t) => 1.29e12 - 10 * GB * t))).toMatchObject({
            daysUntilFull: 100,
            confidence: 'medium',
        });
    });

    it('bursty growth: sensible median, wider band than steady growth of the same pace', () => {
        const bursty = filling(estimateTimeToFull(series(180, burstyFree)));
        const pace = (burstyFree(0) - burstyFree(179)) / 179;
        const simple = burstyFree(179) / pace; // ≈ 99 days
        const steady = filling(estimateTimeToFull(series(180, (t) => 4e12 - pace * t)));

        expect(bursty.model).toBe('bursty');
        expect(Math.abs(bursty.daysUntilFull - simple) / simple).toBeLessThan(0.25);
        expect(bursty.daysUntilFullLow).toBeLessThan(simple);
        expect(bursty.daysUntilFullHigh ?? Infinity).toBeGreaterThan(simple);
        expect(bandWidth(bursty)).toBeGreaterThan(bandWidth(steady) + 30);
        expect(steady.model).toBe('trend');
        expect(bursty.confidence).not.toBe('high');
    });

    it('ignores a temporary spike that reverts within days', () => {
        const clean = filling(estimateTimeToFull(series(120, (t) => 2e12 - 10 * GB * t)));
        // A transcode cache eats 400 GB for two days and gives it back.
        const spiky = filling(
            estimateTimeToFull(
                series(120, (t) => 2e12 - 10 * GB * t - (t === 60 || t === 61 ? 400 * GB : 0)),
            ),
        );
        expect(Math.abs(spiky.daysUntilFull - clean.daysUntilFull)).toBeLessThanOrEqual(1);
        expect(spiky.bytesPerDay).toBeCloseTo(clean.bytesPerDay, -8);
        expect(spiky.model).toBe('trend');
    });

    it('counts a step on the last day: it cannot be confirmed as a spike yet', () => {
        const before = filling(estimateTimeToFull(series(60, (t) => 2e12 - 10 * GB * t)));
        const after = filling(
            estimateTimeToFull(series(60, (t) => 2e12 - 10 * GB * t - (t === 59 ? 500 * GB : 0))),
        );
        expect(after.daysUntilFull).toBeLessThan(before.daysUntilFull - 40);
    });

    it('treats a one-off big deletion as more free space, not as a slower pace', () => {
        // 10 GB/day; on day 80 a 2 TB cleanup.
        const est = filling(
            estimateTimeToFull(series(120, (t) => 2e12 - 10 * GB * t + (t >= 80 ? 2000 * GB : 0))),
        );
        const freeNow = 2e12 - 10 * GB * 119 + 2000 * GB;
        expect(est.bytesPerDay).toBe(10 * GB);
        expect(est.daysUntilFull).toBe(Math.ceil(freeNow / (10 * GB)));
        // Reported, so the tile can say why the drop did not lengthen the estimate.
        expect(est.ignoredDeletions).toBe(1);
    });

    it('keeps recurring deletions as part of the pace', () => {
        // 10 GB/day in, a 150 GB cleanup every 30 days out: net 5 GB/day.
        const est = filling(
            estimateTimeToFull(
                series(180, (t) => 3e12 - 10 * GB * t + Math.floor(t / 30) * 150 * GB),
            ),
        );
        expect(est.bytesPerDay / GB).toBeGreaterThan(4);
        expect(est.bytesPerDay / GB).toBeLessThan(6.5);
        expect(est.ignoredDeletions).toBeUndefined();
    });

    it('shrinking usage is not filling', () => {
        expect(estimateTimeToFull(series(90, (t) => 1e12 + 5 * GB * t))).toMatchObject({
            state: 'not_filling',
        });
    });

    it('too little data gives insufficient_data', () => {
        expect(estimateTimeToFull(series(13, (t) => 1e12 - 10 * GB * t))).toEqual({
            state: 'insufficient_data',
            snapshotDays: 13,
        });
        // 14 days spread over three weeks are enough: the count is of measured days.
        const sparse = series(21, (t) => 1e12 - 10 * GB * t).filter((_, i) => i % 3 !== 1);
        expect(sparse).toHaveLength(14);
        expect(estimateTimeToFull(sparse).state).toBe('filling');
    });

    it('learns a season from two years and beats the trend-only model on a holdout', () => {
        // 5 GB/day, four times that in Nov-Jan (holiday downloading), ±10 % daily noise.
        const next = rand(11);
        const start = Date.UTC(2024, 7, 1) / DAY_MS;
        const trainEnd = Date.UTC(2026, 8, 30) / DAY_MS;
        const daily = new Map<number, number>();
        for (let d = start; d <= trainEnd + 400; d++) {
            const m = new Date(d * DAY_MS).getUTCMonth();
            const heavy = m === 10 || m === 11 || m === 0;
            daily.set(d, (heavy ? 20 : 5) * GB * (0.9 + 0.2 * next()));
        }
        const used = (d: number): number => daily.get(d) as number;
        const freeAtEnd = 1575 * GB;
        const train = fromConsumption(start, trainEnd, used, freeAtEnd);

        // Truth: the day the held-out future actually fills the disk (mid-January).
        let consumed = 0;
        let truth = 0;
        for (let k = 1; k < 400 && truth === 0; k++) {
            consumed += used(trainEnd + k);
            if (consumed >= freeAtEnd) truth = k;
        }
        expect(truth).toBeGreaterThan(90);

        const seasonal = filling(estimateTimeToFull(train));
        const trendOnly = filling(estimateTimeToFull(train, { seasonal: false }));
        expect(seasonal.model).toBe('seasonal');
        expect(trendOnly.model).not.toBe('seasonal');
        const errSeasonal = Math.abs(seasonal.daysUntilFull - truth);
        const errTrend = Math.abs(trendOnly.daysUntilFull - truth);
        expect(errSeasonal).toBeLessThan(errTrend / 3);
        expect(errSeasonal / truth).toBeLessThan(0.15);
        // The band is honest about it: the truth lies inside.
        expect(seasonal.daysUntilFullLow).toBeLessThanOrEqual(truth);
        expect(seasonal.daysUntilFullHigh ?? Infinity).toBeGreaterThanOrEqual(truth);
    });

    it('does not invent a season from steady data', () => {
        const est = filling(
            estimateTimeToFull(
                series(730, (t) => 9e12 - 10 * GB * t),
                { windowDays: 730 },
            ),
        );
        expect(est.model).toBe('trend');
    });

    it('a single phase within one year is a regime change, not a season', () => {
        // 400 days: 30 GB/day for the first 200, then 3 GB/day.
        const pts = series(400, (t) =>
            t < 200 ? 20e12 - 30 * GB * t : 20e12 - 30 * GB * 199 - 3 * GB * (t - 199),
        );
        const est = filling(estimateTimeToFull(pts));
        expect(est.model).not.toBe('seasonal');
        expect(est.bytesPerDay / GB).toBeCloseTo(3, 0);
    });

    it('short data with only the approximate prior: wider band, confidence low, flagged', () => {
        const prior = buildArrivalPrior(arrivalHistory(5));
        expect(prior).not.toBeNull();
        expect(prior!.pool.length).toBeGreaterThan(300);
        // December is the clear peak of the prior's season.
        expect(prior!.seasonal).not.toBeNull();
        const dec = prior!.seasonal![11];
        expect(dec).toBe(Math.max(...prior!.seasonal!));

        const pts = series(20, (t) => 1.19e12 - 10 * GB * t);
        const plain = filling(estimateTimeToFull(pts));
        expect(plain.approximatePrior).toBeUndefined();

        // Burst shape only: the pace still comes from the real snapshots.
        const shapeOnly = filling(
            estimateTimeToFull(pts, { prior: { ...prior!, seasonal: null } }),
        );
        expect(shapeOnly).toMatchObject({
            confidence: 'low',
            approximatePrior: true,
            basisDays: 20,
            model: 'trend',
        });
        expect(shapeOnly.bytesPerDay).toBe(plain.bytesPerDay);
        expect(bandWidth(shapeOnly)).toBeGreaterThan(bandWidth(plain));

        // With its season too: a busy December ahead brings the date forward.
        const withPrior = filling(estimateTimeToFull(pts, { prior }));
        expect(withPrior).toMatchObject({
            confidence: 'low',
            approximatePrior: true,
            model: 'seasonal',
        });
    });

    it('a strong seasonal arrival prior does not change the pace of a short real series', () => {
        const arrivals: Array<{ date: string; bytes: number }> = [];
        const first = Date.UTC(2019, 0, 1) / DAY_MS;
        const last = Date.UTC(2025, 11, 31) / DAY_MS;
        for (let d = first; d <= last; d++) {
            const month = new Date(d * DAY_MS).getUTCMonth();
            // Repeatable month ranking over seven full years, with a large December peak.
            arrivals.push({ date: iso(d), bytes: (month === 11 ? 100 : 1 + month / 10) * GB });
        }
        const prior = buildArrivalPrior(arrivals);
        expect(prior?.seasonal).not.toBeNull();
        if (!prior?.seasonal) throw new Error('expected a seasonal arrival prior');
        expect(prior.seasonal[11]).toBe(Math.max(...prior.seasonal));
        expect(prior.seasonal[11]).toBeGreaterThan(3 * prior.seasonal[10]);

        // Real snapshots span the quiet November and busy December of the prior,
        // but this filesystem's measured consumption stays at 10 GB/day throughout.
        const start = Date.UTC(2026, 10, 1) / DAY_MS;
        const points = fromConsumption(start, start + 59, () => 10 * GB, 1e12);
        expect(points).toHaveLength(60);
        const plain = filling(estimateTimeToFull(points, { prior: null }));
        const seasonal = filling(estimateTimeToFull(points, { prior }));

        expect(seasonal.model).toBe('seasonal');
        expect(seasonal.approximatePrior).toBe(true);
        expect(plain.bytesPerDay).toBe(10 * GB);
        expect(
            Math.abs(seasonal.bytesPerDay - plain.bytesPerDay) / plain.bytesPerDay,
        ).toBeLessThanOrEqual(0.05);
    });

    it('rejects an arrival history that is one import cliff', () => {
        const rows = arrivalHistory(9).map((r) => ({ ...r, bytes: r.bytes / 1000 }));
        rows.push({ date: '2026-06-01', bytes: 40e12 });
        const prior = buildArrivalPrior(rows);
        expect(prior?.pool ?? []).toEqual([]);
        expect(buildArrivalPrior([])).toBeNull();
        expect(buildArrivalPrior([{ date: '2026-01-01', bytes: 5 }])).toBeNull();
    });

    it('is deterministic: the same input gives the same output', () => {
        const prior = buildArrivalPrior(arrivalHistory(5));
        const pts = series(180, burstyFree);
        expect(estimateTimeToFull(pts, { prior })).toEqual(estimateTimeToFull(pts, { prior }));
        expect(buildArrivalPrior(arrivalHistory(5))).toEqual(prior);
    });

    it('stays within budget on two years of bursty data with a 16-year prior', () => {
        const prior = buildArrivalPrior(arrivalHistory(5));
        const next = rand(3);
        let free = 30e12;
        const pts = series(730, () => {
            free -= GB + (next() < 0.04 ? 250 * GB * next() : 0);
            return free;
        });
        for (let i = 0; i < 3; i++) estimateTimeToFull(pts, { prior });
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
            const t0 = performance.now();
            estimateTimeToFull(pts, { prior });
            times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        // ~4 ms idle, but 20-30 ms on a loaded shared runner: a tight wall-clock
        // budget only flakes. 150 ms still catches the regression that matters
        // (a quadratic path over 730 days x 500 paths costs seconds).
        expect(times[2]).toBeLessThan(150);
    });
});
