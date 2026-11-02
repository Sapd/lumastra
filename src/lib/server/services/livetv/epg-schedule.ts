// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ProgramRow } from '$lib/server/database/queries/livetv-programs.queries.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('EpgSchedule');

/**
 * EPG Schedule Collapsing
 *
 * A broadcast channel airs exactly one programme at a time, so a channel's EPG
 * must be a non-overlapping sequence. Overlap is therefore a data error, not a
 * legitimate shape — and it is the only reliable signal we have.
 *
 * Real feeds violate this routinely. The common failure mode: an aggregator
 * reuses one `tvg-id` for several channel variants and concatenates each
 * variant's schedule under it, e.g.
 *
 *     <channel id="OrbNature.de@SD"><display-name>Orb Nature HD *</display-name></channel>
 *     <channel id="OrbNature.de@SD"><display-name>Orb Nature FHD</display-name></channel>
 *     <channel id="OrbNature.de@SD"><display-name>Orb Nature HD</display-name></channel>
 *
 * Every programme carries the same channel id, so a correct 1:1 channel match
 * still pulls in N complete schedules. They are usually near-identical but
 * time-shifted by a constant per-channel offset (seconds to hours), so no two
 * entries share a start time and no exact-duplicate test finds them.
 *
 * Do NOT dedupe on (title, start ± tolerance): the parallel schedules
 * frequently disagree on both title and block granularity — one lists a single
 * 20h "Sendepause" where the other has a full evening of programmes.
 *
 * Strategy:
 *   1. Partition a channel's programmes into non-overlapping "lanes" using
 *      best-fit assignment. Because each embedded schedule is internally
 *      contiguous (each programme ends where the next begins), best-fit keeps
 *      each source schedule intact in its own lane instead of interleaving them.
 *   2. Keep the richest lane whole — never a mix, which would produce jarring
 *      few-minute boundary shifts mid-schedule.
 *   3. Gap-fill from the remaining lanes wherever the primary has no coverage,
 *      so a lane that merely stops early doesn't cost us the rest of the week.
 *
 * Genuine repeats survive untouched: a 55-minute show re-airing four hours
 * later does not overlap its earlier airing.
 *
 * Cost is O(n log n) plus O(n × lanes). Lanes equal the number of parallel
 * schedules on one channel — 1 to 4 on real feeds. The degenerate case is a
 * channel whose programmes all mutually overlap, where lanes grow with n and
 * the scan turns quadratic; at the largest feed the parser accepts that is
 * still under a second, so there is no cap here. A cap would have to drop
 * programmes to stay within it, which is worse than being slow on input that
 * is already garbage.
 *
 * @module services/livetv/epg-schedule
 */

/** Half-open time range in epoch milliseconds: [start, end). */
export interface ScheduleInterval {
    start: number;
    end: number;
}

export interface CollapseResult<T> {
    /** The surviving non-overlapping schedule, ordered by start time. */
    kept: T[];
    /** Entries removed as parallel-schedule duplicates or unusable ranges. */
    dropped: T[];
    /** How many parallel schedules were detected (1 = clean feed). */
    laneCount: number;
}

interface Entry<T> {
    item: T;
    start: number;
    end: number;
    /** Original index — keeps every tie-break deterministic. */
    seq: number;
}

interface Lane<T> {
    entries: Entry<T>[];
    lastEnd: number;
    coveredMs: number;
}

/**
 * Collapse one channel's programmes to a single non-overlapping schedule.
 *
 * Entries with an unusable range (NaN, zero-length or inverted) cannot be
 * placed on a timeline at all and are reported as dropped.
 *
 * Deterministic: the result depends only on the set of programmes, never on
 * their input order.
 */
export function collapseChannelSchedule<T>(
    programs: readonly T[],
    toInterval: (item: T) => ScheduleInterval,
): CollapseResult<T> {
    if (programs.length === 0) {
        return { kept: [], dropped: [], laneCount: 0 };
    }

    const dropped: T[] = [];
    const entries: Entry<T>[] = [];

    for (let i = 0; i < programs.length; i++) {
        const item = programs[i];
        const { start, end } = toInterval(item);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            dropped.push(item);
            continue;
        }
        entries.push({ item, start, end, seq: i });
    }

    // Sort by start, then end, then original position. Array.prototype.sort is
    // stable, but the explicit seq tie-break makes the ordering independent of
    // input order too, which is what actually guarantees determinism.
    entries.sort((a, b) => a.start - b.start || a.end - b.end || a.seq - b.seq);

    // Exact duplicates (identical range) are not a lane of their own — collapse
    // them first so they can't inflate a lane's score.
    const deduped: Entry<T>[] = [];
    for (const entry of entries) {
        const prev = deduped[deduped.length - 1];
        if (prev && prev.start === entry.start && prev.end === entry.end) {
            dropped.push(entry.item);
            continue;
        }
        deduped.push(entry);
    }

    // ── 1. Best-fit lane partitioning ──────────────────────────────────
    // Append to the compatible lane that ends latest. For a contiguous chain
    // that lane is always the chain's own (its last end === this start), so
    // parallel schedules stay separated even when one of them has gaps.
    const lanes: Lane<T>[] = [];
    for (const entry of deduped) {
        let best: Lane<T> | undefined;
        for (const lane of lanes) {
            if (lane.lastEnd <= entry.start && (!best || lane.lastEnd > best.lastEnd)) {
                best = lane;
            }
        }
        if (best) {
            best.entries.push(entry);
            best.lastEnd = entry.end;
            best.coveredMs += entry.end - entry.start;
        } else {
            lanes.push({
                entries: [entry],
                lastEnd: entry.end,
                coveredMs: entry.end - entry.start,
            });
        }
    }

    if (lanes.length <= 1) {
        return {
            kept: deduped.map((e) => e.item),
            dropped,
            laneCount: lanes.length,
        };
    }

    // ── 2. Rank lanes, keep the richest one whole ──────────────────────
    // Programme count first: a lane with real listings beats one padding the
    // same hours with a handful of coarse filler blocks. Covered time breaks
    // ties so a lane spanning the whole week wins over a single-day one.
    //
    // The final tie-break compares the lanes' interval sequences rather than
    // their input positions. Two variants of the same channel can easily agree
    // on count, coverage and first start — clipped to the same window they
    // usually do — and settling that on arrival order would let the surviving
    // schedule flip between imports of identical data.
    const ranked = [...lanes].sort(
        (a, b) =>
            b.entries.length - a.entries.length ||
            b.coveredMs - a.coveredMs ||
            compareIntervalSequences(a.entries, b.entries),
    );

    const kept: Entry<T>[] = [...ranked[0].entries];

    // ── 3. Gap-fill from the remaining lanes ───────────────────────────
    // `kept` stays sorted by start, so a binary search locates the only two
    // entries a candidate could overlap.
    for (let i = 1; i < ranked.length; i++) {
        for (const candidate of ranked[i].entries) {
            const at = lowerBound(kept, candidate.start);
            const before = kept[at - 1];
            const after = kept[at];
            if (before && before.end > candidate.start) continue;
            if (after && candidate.end > after.start) continue;
            kept.splice(at, 0, candidate);
        }
    }

    const keptSet = new Set(kept);
    for (const entry of deduped) {
        if (!keptSet.has(entry)) dropped.push(entry.item);
    }

    return { kept: kept.map((e) => e.item), dropped, laneCount: lanes.length };
}

/**
 * Order two lanes by their interval sequences, earliest-differing first.
 *
 * Derived purely from the programmes' own times, so it cannot depend on input
 * order. Returns 0 only when both lanes occupy exactly the same slots, in which
 * case either choice yields the same schedule shape and `seq` settles it.
 */
function compareIntervalSequences<T>(a: Entry<T>[], b: Entry<T>[]): number {
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) {
        const diff = a[i].start - b[i].start || a[i].end - b[i].end;
        if (diff !== 0) return diff;
    }
    return a.length - b.length || a[0].seq - b[0].seq;
}

/** First index in `sorted` whose start is >= `start`. */
function lowerBound<T>(sorted: Entry<T>[], start: number): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid].start < start) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export interface CollapseByChannelResult<T> {
    /** Surviving rows, in the original input order. */
    kept: T[];
    droppedCount: number;
    /** Channels that carried more than one parallel schedule. */
    channelsAffected: number;
}

/**
 * Collapse a flat, multi-channel programme list. Each channel is collapsed
 * independently; the surviving rows keep their original relative order so
 * callers that already sorted (e.g. the guide query) stay sorted.
 */
export function collapseByChannel<T>(
    programs: readonly T[],
    toChannelId: (item: T) => string,
    toInterval: (item: T) => ScheduleInterval,
): CollapseByChannelResult<T> {
    // Bucket by position, not by value. Keying survivors on the items
    // themselves would mean that if the caller ever passes the same object
    // reference twice, keeping one occurrence keeps them all — and the counts
    // would contradict the returned rows.
    const byChannel = new Map<string, number[]>();
    for (let i = 0; i < programs.length; i++) {
        const channelId = toChannelId(programs[i]);
        const bucket = byChannel.get(channelId);
        if (bucket) bucket.push(i);
        else byChannel.set(channelId, [i]);
    }

    const survives = new Array<boolean>(programs.length).fill(false);
    let droppedCount = 0;
    let channelsAffected = 0;

    for (const indices of byChannel.values()) {
        const result = collapseChannelSchedule(indices, (i) => toInterval(programs[i]));
        if (result.dropped.length > 0) {
            droppedCount += result.dropped.length;
            channelsAffected++;
        }
        for (const i of result.kept) survives[i] = true;
    }

    return {
        kept: programs.filter((_, i) => survives[i]),
        droppedCount,
        channelsAffected,
    };
}

/**
 * Read-side safety net for the non-overlap invariant.
 *
 * Ingest is authoritative — it collapses parallel schedules with the full feed
 * in hand (see epg-schedule.ts). This guard exists so rows written by an older
 * build, or a half-finished import, never reach a client: station reads and the
 * legacy provider share this collapse, and only some of them have a frontend we
 * control. On a clean database it drops nothing.
 *
 * It sees only the requested window, so on dirty legacy data two different
 * windows over the same slot can each pick a different parallel schedule —
 * each response is internally consistent, but they may disagree with one
 * another. Re-importing the source is what actually reconciles them; only the
 * full schedule supports one authoritative answer.
 */

export function collapseProgramRows<T extends ProgramRow>(rows: T[]): T[] {
    const result = collapseByChannel(
        rows,
        (row) => row.channel_id,
        (row) => ({ start: row.start_time.getTime(), end: row.end_time.getTime() }),
    );
    if (result.droppedCount > 0) {
        logger.warn(
            `Suppressed ${result.droppedCount} overlapping EPG program(s) across ` +
                `${result.channelsAffected} channel(s) at read time — re-import the ` +
                `Live TV source to fix the stored data`,
        );
    }
    return result.kept;
}
