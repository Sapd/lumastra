// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "When is this library disk full?" from the worker's daily free-space
 * snapshots. Pure, deterministic, no I/O.
 *
 * Why not a straight line: media libraries grow in steps. A season pack or a
 * 4K collection lands as +500 GB in one day and then nothing happens for
 * weeks; a cleanup frees 2 TB at once; a transcode cache on the same share
 * eats space for a day and gives it back. A line through that is noisy and its
 * band says little about how soon the next step can fill the disk.
 *
 * The model, in order:
 * 1. Clean: a change undone within 3 days (cache spike, a copy that was moved
 *    away again) is removed. Steps that stay are kept, whatever their size.
 * 2. Daily consumption (free space lost per day). A large deletion is a level
 *    shift, not a rate: one cleanup should move today's free space, not
 *    promise that cleanups keep happening. Only when they recur (3+ events)
 *    are they part of the process.
 * 3. Seasons, only when the data carries them: a year of real snapshots with a
 *    significant month effect, or the approximate arrival history as a weak
 *    prior (see `buildArrivalPrior`). Factors are shrunk towards "no season".
 * 4. Regime change: if recent weeks differ significantly from older ones (a
 *    new download habit, a migration finished), the older part is dropped.
 * 5. Forecast: a seeded Monte Carlo of 500 future paths. Each path draws its
 *    own rate (bootstrap of the recency-weighted mean: how sure are we about
 *    the pace?) and then replays 7-day blocks of real history (how lumpy is
 *    the pace?). The day a path's consumption reaches today's free space is
 *    its "full" day; the answer is the median and the 5 % / 95 % quantiles.
 *    Blocks of a week keep bursts, multi-day copies and the weekly rhythm
 *    intact, so the band is as wide as the history is lumpy.
 */

const MS_PER_DAY = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatDay(day: number): string {
    return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** UTC calendar day number for YYYY-MM-DD, or null for anything that is not a real date. */
export function parseDay(date: string): number | null {
    const m = DATE_RE.exec(date);
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isFinite(ms)) return null;
    const day = ms / MS_PER_DAY;
    // Reject overflow dates such as 2026-02-31 (Date.UTC would roll them over).
    return formatDay(day) === date ? day : null;
}

function monthOf(day: number): number {
    return new Date(day * MS_PER_DAY).getUTCMonth();
}

export interface FreeSpacePoint {
    /** YYYY-MM-DD */
    date: string;
    freeBytes: number;
}

export type ForecastModel = 'trend' | 'bursty' | 'seasonal';
export type ForecastConfidence = 'low' | 'medium' | 'high';

export type StorageEstimate =
    | { state: 'insufficient_data'; snapshotDays: number }
    | { state: 'not_filling'; basisDays?: number; ignoredDeletions?: number }
    | {
          state: 'filling';
          /** Median of the simulated paths, days from the last measurement. */
          daysUntilFull: number;
          /** Soonest end of the band (5 % of paths are full earlier). */
          daysUntilFullLow: number;
          /** Latest end of the band; absent when the slow paths never fill. */
          daysUntilFullHigh?: number;
          /** Average consumption the forecast assumes; seasons average out over a year. */
          bytesPerDay: number;
          confidence?: ForecastConfidence;
          model?: ForecastModel;
          /** Days with a real measurement the pace was learned from. */
          basisDays?: number;
          /** Share of paths inside low..high (0.9). */
          bandLevel?: number;
          /** True when the approximate arrival history shaped the band or the seasons. */
          approximatePrior?: boolean;
          /** One-off large deletions left out of the pace (present only when > 0). */
          ignoredDeletions?: number;
      };

/**
 * What the approximate arrival history (files the library holds today, dated
 * by arrival) may contribute. Library-wide, not per filesystem, and missing
 * deleted files, so it informs only the SHAPE of growth, never its pace.
 */
export interface ArrivalPrior {
    /** Month factors Jan..Dec (mean 1), or null when the years show no consistent season. */
    seasonal: number[] | null;
    /** Daily arrival multipliers (mean 1, season removed) of up to the last three years; empty when unusable. */
    pool: number[];
}

export interface EstimateOptions {
    /** Days of history considered. Default 730 (what the snapshot task keeps). */
    windowDays?: number;
    /** Fewer distinct days than this: no estimate rather than a guess. Default 14. */
    minDays?: number;
    /** From `buildArrivalPrior`; weak evidence on burst shape and seasons. */
    prior?: ArrivalPrior | null;
    /** False forces a model without seasons. Default true. */
    seasonal?: boolean;
}

const DEFAULT_WINDOW_DAYS = 730;
const DEFAULT_MIN_DAYS = 14;
/** Behaviour 3 months ago counts half as much as today's. */
const HALF_LIFE_DAYS = 90;
const BLOCK_DAYS = 7;
/** A change undone within this many days was never real growth. */
const SPIKE_MAX_DAYS = 3;
/** "Undone" = back within 25 % of the excursion. */
const SPIKE_RETURN_TOLERANCE = 0.25;
/** Robust z beyond which a day is a burst, a deletion or a spike candidate. */
const OUTLIER_Z = 5;
const RECURRING_DELETIONS = 3;
/** A regime cut keeps at least 6 weeks and needs 2 older weeks to compare against. */
const CHANGE_MIN_RECENT_WEEKS = 6;
const CHANGE_MIN_OLDER_WEEKS = 2;
/** Max over all split points of a Mann-Whitney z; 3.5 keeps chance splits out. */
const CHANGE_Z = 3.5;
/** Every month must have been seen once before real data may claim a season. */
const SEASON_MIN_SPAN_DAYS = 365;
/** Below two cycles a one-off phase can pose as a season; a regime check runs first. */
const SEASON_TWO_CYCLES_DAYS = 730;
const SEASON_MIN_AMPLITUDE = 0.15;
/** The prior's season is used at half its size: library-wide and approximate. */
const PRIOR_SEASON_WEIGHT = 0.5;
/** The prior's burst shape counts like 28 days of real data, fading to 7 after a year. */
const PRIOR_POOL_DAYS = 28;
const PATHS = 500;
/**
 * Paths are simulated to 4× the average-pace answer (at least 2 years, at most
 * 20); a path not full by then counts as "never".
 */
const MAX_HORIZON_DAYS = 7300;
/** The average-pace fallback is capped too: past a century it is "never" in all but name. */
const MAX_REPORTED_DAYS = 36_500;
const BAND_LEVEL = 0.9;
/** Fixed seed: the same snapshots always give the same answer. */
const SEED = 0x6c756d61;

/** mulberry32: tiny, fast, good enough for resampling. */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

function median(values: ArrayLike<number>): number {
    const sorted = Array.from(values).sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return 0;
    const mid = Math.floor(n / 2);
    return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation scaled to a normal sigma. */
function robustSigma(values: ArrayLike<number>, centre: number): number {
    const dev = Array.from(values, (v) => Math.abs(v - centre));
    return 1.4826 * median(dev);
}

/** Midranks (ties share their average rank), 1-based. */
function ranks(values: number[]): number[] {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(values.length);
    let i = 0;
    while (i < order.length) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
        const r = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) out[order[k][1]] = r;
        i = j + 1;
    }
    return out;
}

/** Chi-square critical value (Wilson-Hilferty); z 3.09 ≈ 0.1 %, 2.326 ≈ 1 %. */
function chiSquareCritical(df: number, z: number): number {
    const a = 2 / (9 * df);
    return df * (1 - a + z * Math.sqrt(a)) ** 3;
}

/**
 * Index of the first week of a significantly different recent regime, or null.
 * Mann-Whitney on ranks: a single huge burst moves one rank, not the test.
 * Ties (many empty weeks) are left uncorrected, which only makes it stricter.
 */
function findChangePoint(weekly: number[]): number | null {
    const w = weekly.length;
    if (w < CHANGE_MIN_RECENT_WEEKS + CHANGE_MIN_OLDER_WEEKS) return null;
    const r = ranks(weekly);
    const prefix = [0];
    for (const v of r) prefix.push(prefix[prefix.length - 1] + v);
    const total = prefix[w];
    let best: number | null = null;
    let bestZ = CHANGE_Z;
    for (let s = CHANGE_MIN_OLDER_WEEKS; s <= w - CHANGE_MIN_RECENT_WEEKS; s++) {
        const n1 = w - s;
        const n2 = s;
        const u = total - prefix[s] - (n1 * (n1 + 1)) / 2;
        const sd = Math.sqrt((n1 * n2 * (w + 1)) / 12);
        const z = Math.abs((u - (n1 * n2) / 2) / sd);
        if (z >= bestZ) {
            bestZ = z;
            best = s;
        }
    }
    return best;
}

/** Non-overlapping weekly sums aligned to the END, so the latest week is complete. */
function weeklySums(daily: ArrayLike<number>): number[] {
    const weeks = Math.floor(daily.length / BLOCK_DAYS);
    const offset = daily.length - weeks * BLOCK_DAYS;
    const out: number[] = [];
    for (let b = 0; b < weeks; b++) {
        let s = 0;
        for (let j = 0; j < BLOCK_DAYS; j++) s += daily[offset + b * BLOCK_DAYS + j];
        out.push(s);
    }
    return out;
}

/**
 * Removes changes that revert within SPIKE_MAX_DAYS, replacing them by a line
 * between the levels around them. The last few points cannot be confirmed as
 * spikes yet and stay as measured: a burst that landed yesterday is real until
 * it is undone, and an early warning is the safe side.
 */
function despike(days: number[], ys: number[]): number[] {
    const n = ys.length;
    const out = ys.slice();
    if (n < 3) return out;
    const rates: number[] = [];
    for (let i = 1; i < n; i++) rates.push((ys[i - 1] - ys[i]) / (days[i] - days[i - 1]));
    const drift = median(rates);
    const floor = Math.max(1, 1e-4 * median(ys.map(Math.abs)));
    const threshold = Math.max(OUTLIER_Z * robustSigma(rates, drift), floor);

    let i = 1;
    while (i < n) {
        const pre = out[i - 1];
        const preDay = days[i - 1];
        const dev = out[i] - (pre - drift * (days[i] - preDay));
        if (Math.abs(dev) > threshold) {
            let back = -1;
            for (let j = i + 1; j < n && days[j] - preDay <= SPIKE_MAX_DAYS + 1; j++) {
                const expected = pre - drift * (days[j] - preDay);
                if (Math.abs(out[j] - expected) <= SPIKE_RETURN_TOLERANCE * Math.abs(dev)) {
                    back = j;
                    break;
                }
            }
            if (back > 0) {
                const span = days[back] - preDay;
                for (let k = i; k < back; k++) {
                    const t = (days[k] - preDay) / span;
                    out[k] = pre + t * (out[back] - pre);
                }
                i = back;
                continue;
            }
        }
        i++;
    }
    return out;
}

/** Days per run of consecutive flagged days = number of events. */
function countRuns(flags: boolean[]): number {
    let runs = 0;
    for (let k = 0; k < flags.length; k++) if (flags[k] && (k === 0 || !flags[k - 1])) runs++;
    return runs;
}

interface Season {
    factors: number[];
    /** Half-width of the per-path amplitude draw: how sure we are about the season's size. */
    amplitudeSpread: number;
    fromPrior: boolean;
    /** The real snapshots carry the season themselves (not only the prior). */
    fromReal: boolean;
}

/**
 * Month factors (mean 1) from the real consumption and/or the prior, or null
 * when neither carries a season worth modelling.
 *
 * Real data: day means per calendar month, tested with Kruskal-Wallis on
 * weekly sums grouped by month (ranks, so a single burst week cannot fake a
 * month effect). Each month is then shrunk towards the centre (the prior's
 * shape at half strength, or "no season") by how noisy that month's estimate
 * is compared with the spread between months (empirical Bayes): steady
 * seasonal data keeps its factors, bursty data is pulled to flat.
 */
function fitSeason(
    cons: Float64Array,
    firstDay: number,
    prior: ArrivalPrior | null,
): Season | null {
    const priorSeason = prior?.seasonal ?? null;
    const centre = Array.from({ length: 12 }, (_, m) =>
        priorSeason ? 1 + PRIOR_SEASON_WEIGHT * (priorSeason[m] - 1) : 1,
    );
    let factors = centre;
    let realSignificant = false;
    let minCycles = 0;

    if (cons.length >= SEASON_MIN_SPAN_DAYS) {
        const sum = new Array<number>(12).fill(0);
        const count = new Array<number>(12).fill(0);
        for (let k = 0; k < cons.length; k++) {
            const m = monthOf(firstDay + k);
            sum[m] += cons[k];
            count[m]++;
        }
        const means = sum.map((v, m) => (count[m] > 0 ? v / count[m] : 0));
        const grand = means.reduce((acc, v) => acc + v, 0) / 12;
        const weekly = weeklySums(cons);
        // One cycle cannot tell "December is heavy" from "this December
        // was". If a plain regime change explains the year, it wins.
        const regime = cons.length < SEASON_TWO_CYCLES_DAYS && findChangePoint(weekly) !== null;
        if (count.every((c) => c >= 14) && grand > 0 && !regime) {
            const offset = cons.length - weekly.length * BLOCK_DAYS;
            const groups = weekly.map((_, b) => monthOf(firstDay + offset + b * BLOCK_DAYS + 3));
            const r = ranks(weekly);
            const n = weekly.length;
            const rankSum = new Array<number>(12).fill(0);
            const byMonth: number[][] = Array.from({ length: 12 }, () => []);
            groups.forEach((g, b) => {
                rankSum[g] += r[b];
                byMonth[g].push(weekly[b] / BLOCK_DAYS / grand);
            });
            let h = 0;
            let used = 0;
            for (let g = 0; g < 12; g++) {
                if (byMonth[g].length === 0) continue;
                h += (rankSum[g] * rankSum[g]) / byMonth[g].length;
                used++;
            }
            h = (12 / (n * (n + 1))) * h - 3 * (n + 1);
            // 0.1 %: weekly sums are autocorrelated, which inflates H.
            realSignificant = used >= 2 && h >= chiSquareCritical(used - 1, 3.09);

            const raw = means.map((v) => Math.max(0, v) / grand);
            // Noise of each month's mean, from its weeks; a month with one week borrows the average.
            const noise = byMonth.map((vals) => {
                if (vals.length < 2) return NaN;
                const mu = vals.reduce((acc, v) => acc + v, 0) / vals.length;
                const v = vals.reduce((acc, x) => acc + (x - mu) ** 2, 0) / (vals.length - 1);
                return v / vals.length;
            });
            const known = noise.filter((v) => Number.isFinite(v));
            const avgNoise = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1;
            const noiseOf = noise.map((v) => (Number.isFinite(v) ? v : avgNoise));
            const rawMean = raw.reduce((acc, v) => acc + v, 0) / 12;
            const between = raw.reduce((acc, v) => acc + (v - rawMean) ** 2, 0) / 11;
            const signal = Math.max(0, between - avgNoise);
            minCycles = Math.min(...count) / 30.44;
            factors = raw.map((v, m) => {
                let shrink = signal > 0 ? noiseOf[m] / (noiseOf[m] + signal) : 1;
                // Seen once: keep a third of the doubt whatever the noise says.
                if (count[m] / 30.44 < 1.5) shrink = Math.max(shrink, 1 / 3);
                return centre[m] + (1 - shrink) * (v - centre[m]);
            });
        }
    }

    if (!realSignificant && !priorSeason) return null;
    const mean = factors.reduce((a, b) => a + b, 0) / 12;
    const normalised = factors.map((f) => Math.max(0.05, f / mean));
    if (Math.max(...normalised.map((f) => Math.abs(f - 1))) < SEASON_MIN_AMPLITUDE) return null;
    return {
        factors: normalised,
        // Two clean cycles: the season's size is known to about a quarter; else half.
        amplitudeSpread: realSignificant && minCycles >= 1.5 ? 0.25 : 0.5,
        fromPrior: priorSeason !== null,
        fromReal: realSignificant,
    };
}

/** Vose alias table: O(1) weighted draws. */
function aliasTable(weights: number[]): { prob: Float64Array; alias: Int32Array } {
    const n = weights.length;
    const total = weights.reduce((a, b) => a + b, 0);
    const prob = new Float64Array(n);
    const alias = new Int32Array(n);
    const scaled = weights.map((w) => (w * n) / total);
    const small: number[] = [];
    const large: number[] = [];
    scaled.forEach((p, i) => (p < 1 ? small : large).push(i));
    while (small.length > 0 && large.length > 0) {
        const s = small.pop() as number;
        const l = large.pop() as number;
        prob[s] = scaled[s];
        alias[s] = l;
        scaled[l] = scaled[l] + scaled[s] - 1;
        (scaled[l] < 1 ? small : large).push(l);
    }
    for (const i of large) prob[i] = 1;
    for (const i of small) prob[i] = 1;
    return { prob, alias };
}

function draw(table: { prob: Float64Array; alias: Int32Array }, next: () => number): number {
    const i = Math.floor(next() * table.prob.length);
    return next() < table.prob[i] ? i : table.alias[i];
}

/**
 * Estimates when a filesystem runs out of space from its daily free-bytes
 * snapshots. See the file comment for the model.
 */
export function estimateTimeToFull(
    points: FreeSpacePoint[],
    options: EstimateOptions = {},
): StorageEstimate {
    const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
    const minDays = options.minDays ?? DEFAULT_MIN_DAYS;
    const prior = options.prior ?? null;

    // Last occurrence of a date wins (a re-taken snapshot supersedes the earlier one).
    const byDay = new Map<number, number>();
    for (const p of points) {
        if (!Number.isFinite(p.freeBytes) || p.freeBytes < 0) continue;
        const day = parseDay(p.date);
        if (day === null) continue;
        byDay.set(day, p.freeBytes);
    }
    const allDays = [...byDay.keys()].sort((a, b) => a - b);
    if (allDays.length === 0) return { state: 'insufficient_data', snapshotDays: 0 };
    const lastDay = allDays[allDays.length - 1];
    const days = allDays.filter((d) => d >= lastDay - windowDays);
    if (days.length < Math.max(2, minDays)) {
        return { state: 'insufficient_data', snapshotDays: days.length };
    }

    const raw = days.map((d) => byDay.get(d) as number);
    const levels = despike(days, raw);
    const firstDay = days[0];

    // Daily consumption from day firstDay+1 to lastDay; a gap spreads its change evenly.
    const len = lastDay - firstDay;
    const cons = new Float64Array(len);
    for (let i = 1; i < days.length; i++) {
        const gap = days[i] - days[i - 1];
        const perDay = (levels[i - 1] - levels[i]) / gap;
        for (let d = days[i - 1] + 1; d <= days[i]; d++) cons[d - firstDay - 1] = perDay;
    }

    const floor = Math.max(1, 1e-4 * median(raw));
    const scale = (values: ArrayLike<number>): { centre: number; sigma: number } => {
        const centre = median(values);
        const sigma = Math.max(robustSigma(values, centre), 0.05 * Math.abs(centre), floor);
        return { centre, sigma };
    };

    // One-off deletions are level shifts: today's free space already has them.
    // Only days that FREED space count; a quieter phase is not a deletion.
    const del = scale(cons);
    const deletion = Array.from(cons, (c) => c < 0 && c - del.centre < -OUTLIER_Z * del.sigma);
    // Counted so the tile can say so: "ignores 1 large cleanup" explains why a
    // big drop in usage did not lengthen the estimate.
    let ignoredDeletions = 0;
    const deletionRuns = countRuns(deletion);
    if (deletionRuns < RECURRING_DELETIONS) {
        ignoredDeletions = deletionRuns;
        deletion.forEach((isDel, k) => {
            if (isDel) cons[k] = del.centre;
        });
    }
    const withDeletions = <T extends object>(e: T): T =>
        ignoredDeletions > 0 ? { ...e, ignoredDeletions } : e;

    const season = options.seasonal === false ? null : fitSeason(cons, firstDay + 1, prior);
    if (season && !season.fromReal) {
        // A season only the prior saw may shape the FUTURE, never the pace:
        // rescale it so the observed days average exactly 1, or dividing
        // by it would move bytesPerDay (the prior is approximate).
        let sum = 0;
        for (let k = 0; k < len; k++) sum += season.factors[monthOf(firstDay + 1 + k)];
        const windowMean = len > 0 ? sum / len : 1;
        if (windowMean > 0) season.factors = season.factors.map((f) => f / windowMean);
    }
    const factorAt = (day: number): number => (season ? season.factors[monthOf(day)] : 1);
    // Only a season the real data carries is divided out of the past. Dividing
    // by a prior-only season, even rescaled, still moves the average (quiet
    // months are inflated more than busy ones are deflated), so its factors
    // shape the simulated future only.
    const deseasonalise = season !== null && season.fromReal;
    const flat = new Float64Array(len);
    for (let k = 0; k < len; k++) {
        flat[k] = deseasonalise ? cons[k] / factorAt(firstDay + 1 + k) : cons[k];
    }

    // Drop an older regime the recent weeks no longer resemble.
    const weekly = weeklySums(flat);
    const cut = findChangePoint(weekly);
    const start = cut === null ? 0 : len - (weekly.length - cut) * BLOCK_DAYS;
    const basis = flat.subarray(start);
    const basisRaw = cons.subarray(start);
    const basisFirstDay = firstDay + 1 + start;
    const basisDays = days.filter((d) => d >= basisFirstDay - 1).length;
    const n = basis.length;

    const weights = Array.from(basis, (_, k) => 0.5 ** ((n - 1 - k) / HALF_LIFE_DAYS));
    const weightSum = weights.reduce((a, b) => a + b, 0);

    // Circular blocks: every day sits in exactly blockLen blocks. Plain moving
    // blocks under-sample the ends, so a burst mid-series would be over-counted.
    const blockLen = Math.min(BLOCK_DAYS, n);
    const realBlocks = n;
    const realMeans = new Float64Array(realBlocks);
    const blockWeights: number[] = [];
    for (let s = 0; s < realBlocks; s++) {
        let sum = 0;
        let w = 0;
        for (let j = 0; j < blockLen; j++) {
            const k = (s + j) % n;
            sum += basis[k];
            w += weights[k];
        }
        realMeans[s] = sum / blockLen;
        blockWeights.push(w / blockLen);
    }
    const realWeightTotal = blockWeights.reduce((a, b) => a + b, 0);
    // The recency-weighted pace, measured exactly the way the paths will draw it.
    const mean = blockWeights.reduce((acc, w, s) => acc + w * realMeans[s], 0) / realWeightTotal;
    const freeNow = raw[raw.length - 1];
    // A disk that is already full stays "full", even when it stopped growing
    // because nothing more fits.
    if (freeNow <= 0) {
        return {
            state: 'filling',
            daysUntilFull: 0,
            daysUntilFullLow: 0,
            daysUntilFullHigh: 0,
            bytesPerDay: Math.max(0, Math.round(mean)),
            basisDays,
            bandLevel: BAND_LEVEL,
            model: season ? 'seasonal' : 'trend',
            confidence: 'high',
        };
    }
    if (!(mean > 0)) return withDeletions({ state: 'not_filling', basisDays });

    const bytesPerDay = Math.round(mean);
    const base = {
        bytesPerDay,
        basisDays,
        bandLevel: BAND_LEVEL,
        model: (season ? 'seasonal' : 'trend') as ForecastModel,
    };

    // How much of the growth came in bursts (real bytes, before season removal).
    const burst = scale(basisRaw);
    const burstFlags = Array.from(basisRaw, (c) => c - burst.centre > OUTLIER_Z * burst.sigma);
    let burstBytes = 0;
    let positiveBytes = 0;
    basisRaw.forEach((c, k) => {
        if (c > 0) positiveBytes += c;
        if (burstFlags[k]) burstBytes += c - burst.centre;
    });
    const burstShare = positiveBytes > 0 ? burstBytes / positiveBytes : 0;
    const burstEvents = countRuns(burstFlags);

    // Block pool: real blocks (value = c - mean + m*), then prior blocks (value = mult * m*).
    const usePriorPool =
        prior !== null && prior.pool.length >= 52 * BLOCK_DAYS && blockLen === BLOCK_DAYS;
    const priorBlocks = usePriorPool ? prior.pool.length - blockLen + 1 : 0;
    const blocks = realBlocks + priorBlocks;
    const baseArr = new Float64Array(blocks * blockLen);
    const coefArr = new Float64Array(blocks * blockLen);
    for (let s = 0; s < realBlocks; s++) {
        for (let j = 0; j < blockLen; j++) {
            baseArr[s * blockLen + j] = basis[(s + j) % n] - mean;
            coefArr[s * blockLen + j] = 1;
        }
    }
    const realTable = aliasTable(blockWeights.slice());
    let priorShare = 0;
    if (usePriorPool) {
        const priorTotal = PRIOR_POOL_DAYS * Math.min(1, Math.max(0.25, 90 / basisDays));
        priorShare = priorTotal / (priorTotal + realWeightTotal);
        for (let s = 0; s < priorBlocks; s++) {
            const b = realBlocks + s;
            for (let j = 0; j < blockLen; j++) coefArr[b * blockLen + j] = prior.pool[s + j];
            blockWeights.push(priorTotal / priorBlocks);
        }
    }
    const table = aliasTable(blockWeights);

    // Per block: sums and prefix bounds, so a path only walks days inside a block that may cross.
    const baseSum = new Float64Array(blocks);
    const coefSum = new Float64Array(blocks);
    const baseMax = new Float64Array(blocks);
    const coefMax = new Float64Array(blocks);
    const coefMin = new Float64Array(blocks);
    for (let b = 0; b < blocks; b++) {
        let pb = 0;
        let pc = 0;
        let mb = -Infinity;
        let mxc = -Infinity;
        let mnc = Infinity;
        for (let j = 0; j < blockLen; j++) {
            pb += baseArr[b * blockLen + j];
            pc += coefArr[b * blockLen + j];
            mb = Math.max(mb, pb);
            mxc = Math.max(mxc, pc);
            mnc = Math.min(mnc, pc);
        }
        baseSum[b] = pb;
        coefSum[b] = pc;
        baseMax[b] = mb;
        coefMax[b] = mxc;
        coefMin[b] = mnc;
    }

    // Effective sample size of the weighted mean: how many days the pace really rests on.
    const effectiveDays = (weightSum * weightSum) / weights.reduce((a, w) => a + w * w, 0);
    const rateDraws = Math.max(1, Math.round(effectiveDays / blockLen));
    const horizon = Math.min(MAX_HORIZON_DAYS, Math.max(730, Math.ceil((4 * freeNow) / mean)));
    const steps = Math.ceil(horizon / blockLen);
    const stepFactor = new Float64Array(steps);
    for (let st = 0; st < steps; st++) {
        stepFactor[st] = factorAt(lastDay + st * blockLen + Math.ceil(blockLen / 2));
    }
    // Float sums of equal steps can land a hair short of the exact free space.
    const target = freeNow * (1 - 1e-9);

    const next = rng(SEED);
    const hits = new Float64Array(PATHS);
    for (let p = 0; p < PATHS; p++) {
        let acc = 0;
        for (let r = 0; r < rateDraws; r++) acc += realMeans[draw(realTable, next)];
        const rate = acc / rateDraws;
        const amp = season ? 1 + season.amplitudeSpread * (2 * next() - 1) : 1;
        let used = 0;
        let hit = Infinity;
        for (let st = 0; st < steps && hit === Infinity; st++) {
            const b = draw(table, next);
            const f = Math.max(0.05, 1 + amp * (stepFactor[st] - 1));
            const upper = f * (baseMax[b] + (rate >= 0 ? coefMax[b] : coefMin[b]) * rate);
            if (used + upper >= target) {
                let c = used;
                for (let j = 0; j < blockLen; j++) {
                    c += f * (baseArr[b * blockLen + j] + coefArr[b * blockLen + j] * rate);
                    if (c >= target) {
                        hit = st * blockLen + j + 1;
                        break;
                    }
                }
            }
            used += f * (baseSum[b] + coefSum[b] * rate);
        }
        hits[p] = hit;
    }
    hits.sort();

    const lowHit = hits[Math.floor(((1 - BAND_LEVEL) / 2) * PATHS)];
    const midHit = hits[Math.floor(PATHS / 2)];
    const highHit = hits[Math.ceil(((1 + BAND_LEVEL) / 2) * PATHS) - 1];
    // More than half the paths never fill: report the average-pace answer, flagged low.
    const daysUntilFull = Number.isFinite(midHit)
        ? midHit
        : Math.min(MAX_REPORTED_DAYS, Math.ceil(freeNow / mean));
    const daysUntilFullLow = Number.isFinite(lowHit)
        ? Math.min(lowHit, daysUntilFull)
        : daysUntilFull;
    const daysUntilFullHigh = Number.isFinite(highHit)
        ? Math.max(highHit, daysUntilFull)
        : undefined;

    const model: ForecastModel = season ? 'seasonal' : burstShare >= 0.3 ? 'bursty' : 'trend';
    const confidence = rateConfidence({
        basisDays,
        basisSpan: n,
        mid: daysUntilFull,
        relWidth:
            daysUntilFullHigh === undefined || !Number.isFinite(midHit)
                ? Infinity
                : (daysUntilFullHigh - daysUntilFullLow) / Math.max(1, daysUntilFull),
        burstShare,
        burstEvents,
        priorShare,
    });

    const result: StorageEstimate = {
        state: 'filling',
        daysUntilFull,
        daysUntilFullLow,
        ...base,
        model,
        confidence,
    };
    if (daysUntilFullHigh !== undefined) result.daysUntilFullHigh = daysUntilFullHigh;
    if (priorShare > 0 || season?.fromPrior) result.approximatePrior = true;
    return withDeletions(result);
}

/**
 * A coarse label, deliberately: the band already carries the numbers. Each
 * rule can only lower the level, so no single good property buys "high".
 */
function rateConfidence(x: {
    basisDays: number;
    basisSpan: number;
    mid: number;
    relWidth: number;
    burstShare: number;
    burstEvents: number;
    priorShare: number;
}): ForecastConfidence {
    let level = 2;
    const cap = (max: number): void => {
        level = Math.min(level, max);
    };
    if (x.basisDays < 90) cap(1);
    if (x.basisDays < 30) cap(0);
    if (x.relWidth > 0.5) cap(1);
    if (x.relWidth > 1.5) cap(0);
    // Growth that is mostly a handful of bursts: the next burst decides.
    if (x.burstShare >= 0.5) cap(x.burstEvents < 3 ? 0 : 1);
    if (x.priorShare >= 0.5) cap(0);
    // Far beyond what was observed, habits change more than any band shows.
    if (x.mid > 4 * x.basisSpan) cap(1);
    return level === 2 ? 'high' : level === 1 ? 'medium' : 'low';
}

/**
 * Turns the approximate arrival history into the weak prior. Seasons need at
 * least three full calendar years with a consistent month ranking (Friedman
 * test, 1 %); the burst pool needs arrivals spread over many days, because a
 * history where one day holds a quarter of everything is an import artefact
 * (files without an older mtime), not a burst pattern.
 */
export function buildArrivalPrior(
    daily: Array<{ date: string; bytes: number }>,
): ArrivalPrior | null {
    const byDay = new Map<number, number>();
    for (const r of daily) {
        if (!Number.isFinite(r.bytes) || r.bytes < 0) continue;
        const day = parseDay(r.date);
        if (day === null) continue;
        byDay.set(day, (byDay.get(day) ?? 0) + r.bytes);
    }
    if (byDay.size === 0) return null;
    const keys = [...byDay.keys()].sort((a, b) => a - b);
    const first = keys[0];
    const last = keys[keys.length - 1];
    const span = last - first + 1;
    if (span < 365) return null;
    const arr = new Float64Array(span);
    for (const [d, b] of byDay) arr[d - first] = b;

    const seasonal = priorSeason(arr, first, last);

    const windowLen = Math.min(3 * 365, span);
    const start = span - windowLen;
    let windowBytes = 0;
    let maxDay = 0;
    let arrivalDays = 0;
    for (let k = start; k < span; k++) {
        windowBytes += arr[k];
        maxDay = Math.max(maxDay, arr[k]);
        if (arr[k] > 0) arrivalDays++;
    }
    let pool: number[] = [];
    if (windowBytes > 0 && arrivalDays >= 100 && maxDay < 0.25 * windowBytes) {
        // Normalise by a centred one-year mean, so multi-year growth is not a burst.
        const prefix = new Float64Array(span + 1);
        for (let k = 0; k < span; k++) prefix[k + 1] = prefix[k] + arr[k];
        const mult: number[] = [];
        for (let k = start; k < span; k++) {
            const lo = Math.max(0, k - 182);
            const hi = Math.min(span, k + 183);
            const local = (prefix[hi] - prefix[lo]) / (hi - lo);
            let v = local > 0 ? arr[k] / local : 0;
            if (seasonal) v /= seasonal[monthOf(first + k)];
            // Cap one day at ten weeks of normal arrivals: beyond that it is an import, not a habit.
            mult.push(Math.min(v, 70));
        }
        const m = mult.reduce((a, b) => a + b, 0) / mult.length;
        if (m > 0) pool = mult.map((v) => v / m);
    }
    if (!seasonal && pool.length === 0) return null;
    return { seasonal, pool };
}

function priorSeason(arr: Float64Array, first: number, last: number): number[] | null {
    const firstYear = new Date(first * MS_PER_DAY).getUTCFullYear();
    const lastYear = new Date(last * MS_PER_DAY).getUTCFullYear();
    const shares: number[][] = [];
    for (let y = lastYear; y >= firstYear && shares.length < 10; y--) {
        const jan1 = Date.UTC(y, 0, 1) / MS_PER_DAY;
        const dec31 = Date.UTC(y, 11, 31) / MS_PER_DAY;
        if (jan1 < first || dec31 > last) continue;
        const sum = new Array<number>(12).fill(0);
        const count = new Array<number>(12).fill(0);
        for (let d = jan1; d <= dec31; d++) {
            const m = monthOf(d);
            sum[m] += arr[d - first];
            count[m]++;
        }
        const perDay = sum.map((s, m) => s / count[m]);
        const yearMean = perDay.reduce((a, b) => a + b, 0) / 12;
        if (yearMean > 0) shares.push(perDay.map((v) => v / yearMean));
    }
    if (shares.length < 3) return null;
    // Friedman: rank the months within each year, so one heavy year cannot fake a season.
    const k = 12;
    const rankSums = new Array<number>(k).fill(0);
    for (const s of shares) ranks(s).forEach((r, m) => (rankSums[m] += r));
    const y = shares.length;
    const q = (12 / (y * k * (k + 1))) * rankSums.reduce((a, r) => a + r * r, 0) - 3 * y * (k + 1);
    if (q < chiSquareCritical(k - 1, 2.326)) return null;
    const med = Array.from({ length: k }, (_, m) => median(shares.map((s) => s[m])));
    const mean = med.reduce((a, b) => a + b, 0) / k;
    if (!(mean > 0)) return null;
    return med.map((v) => Math.max(0.05, v / mean));
}
