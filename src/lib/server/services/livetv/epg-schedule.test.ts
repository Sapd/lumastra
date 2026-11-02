// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { collapseChannelSchedule, collapseByChannel } from './epg-schedule.js';

// ── Helpers ────────────────────────────────────────────────────────────

interface P {
    title: string;
    start: string;
    end: string;
}

const p = (title: string, start: string, end: string): P => ({ title, start, end });

const toInterval = (item: P) => ({
    start: Date.parse(item.start),
    end: Date.parse(item.end),
});

const collapse = (items: P[]) => collapseChannelSchedule(items, toInterval);

/** Build a contiguous chain: each programme starts where the previous ended. */
function chain(titles: string[], firstStart: string, slotMinutes: number, offsetSeconds = 0): P[] {
    let t = Date.parse(firstStart) + offsetSeconds * 1000;
    return titles.map((title) => {
        const start = t;
        t += slotMinutes * 60_000;
        return p(title, new Date(start).toISOString(), new Date(t).toISOString());
    });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('collapseChannelSchedule', () => {
    it('leaves a clean non-overlapping schedule untouched', () => {
        const items = chain(['A', 'B', 'C'], '2026-07-28T12:00:00Z', 30);
        const result = collapse(items);
        expect(result.kept).toEqual(items);
        expect(result.dropped).toEqual([]);
        expect(result.laneCount).toBe(1);
    });

    it('collapses two time-shifted parallel chains to one (the real prod bug)', () => {
        // Orb Nature FHD: the provider declares one tvg-id three times and
        // concatenates each variant's schedule under it. Both chains are
        // internally contiguous and offset by a constant ~3m17s.
        const a = chain(['Riffhai', 'Nationalparks', 'Into the Blue'], '2026-07-28T12:07:24Z', 55);
        const b = chain(
            ['Riffhai', 'Nationalparks', 'Into the Blue'],
            '2026-07-28T12:07:24Z',
            55,
            197,
        );
        const result = collapse([...a, ...b]);

        expect(result.laneCount).toBe(2);
        expect(result.kept).toHaveLength(3);
        expect(result.dropped).toHaveLength(3);
        // Exactly one coherent chain survives — never a mix of the two.
        const keptStarts = result.kept.map((k) => k.start);
        expect(new Set(keptStarts).size).toBe(3);
        for (let i = 1; i < result.kept.length; i++) {
            expect(Date.parse(result.kept[i].start)).toBeGreaterThanOrEqual(
                Date.parse(result.kept[i - 1].end),
            );
        }
    });

    it('drops overlapping entries whose titles differ', () => {
        // 1767 of 6288 overlapping prod rows disagree on title — a title-equality
        // dedupe (the old frontend hack) cannot catch these.
        const items = [
            p('Sendepause', '2026-07-29T04:00:00Z', '2026-07-30T00:30:00Z'),
            p('Q7R Live', '2026-07-29T04:00:00Z', '2026-07-29T08:00:00Z'),
            p('Studio Talk', '2026-07-29T08:00:00Z', '2026-07-29T12:00:00Z'),
        ];
        const result = collapse(items);
        // The two-item lane is richer than the single 20h block.
        expect(result.kept.map((k) => k.title)).toEqual(['Q7R Live', 'Studio Talk']);
        expect(result.dropped.map((d) => d.title)).toEqual(['Sendepause']);
    });

    it('never emits an overlapping pair', () => {
        const items = [
            ...chain(['A', 'B', 'C', 'D'], '2026-07-28T00:00:00Z', 45),
            ...chain(['A', 'B', 'C', 'D'], '2026-07-28T00:00:00Z', 45, 133),
            ...chain(['A', 'B', 'C', 'D'], '2026-07-28T00:00:00Z', 45, 300),
        ];
        const result = collapse(items);
        const sorted = [...result.kept].sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
        for (let i = 1; i < sorted.length; i++) {
            expect(Date.parse(sorted[i].start)).toBeGreaterThanOrEqual(
                Date.parse(sorted[i - 1].end),
            );
        }
        expect(result.kept.length + result.dropped.length).toBe(items.length);
    });

    it('prefers the lane with more programmes over the one with coarser blocks', () => {
        const coarse = [p('Sendepause', '2026-07-28T00:00:00Z', '2026-07-28T12:00:00Z')];
        const granular = chain(['A', 'B', 'C', 'D', 'E', 'F'], '2026-07-28T00:00:00Z', 120);
        expect(collapse([...coarse, ...granular]).kept).toHaveLength(6);
        // Input order must not change the outcome.
        expect(collapse([...granular, ...coarse]).kept).toHaveLength(6);
    });

    it('gap-fills from secondary lanes where the primary has no coverage', () => {
        // Primary lane is richer but stops early; the secondary lane still has
        // the tail of the week. Dropping it wholesale would lose real EPG data.
        const primary = chain(['A', 'B', 'C', 'D'], '2026-07-28T00:00:00Z', 60);
        const secondary = [
            // overlaps the primary — must be dropped
            p('A-dup', '2026-07-28T00:02:00Z', '2026-07-28T01:02:00Z'),
            // beyond the primary's coverage — must be kept
            p('Tail', '2026-07-29T00:00:00Z', '2026-07-29T01:00:00Z'),
        ];
        const result = collapse([...primary, ...secondary]);
        expect(result.kept.map((k) => k.title)).toEqual(['A', 'B', 'C', 'D', 'Tail']);
        expect(result.dropped.map((d) => d.title)).toEqual(['A-dup']);
    });

    it('keeps genuine repeats that do not overlap', () => {
        // A 55min show re-airing 4h later is real programming, not a duplicate.
        const items = [
            p('Nachrichtenblick', '2026-07-28T12:00:00Z', '2026-07-28T12:55:00Z'),
            p('Filler', '2026-07-28T12:55:00Z', '2026-07-28T16:00:00Z'),
            p('Nachrichtenblick', '2026-07-28T16:00:00Z', '2026-07-28T16:55:00Z'),
        ];
        expect(collapse(items).kept).toHaveLength(3);
        expect(collapse(items).dropped).toEqual([]);
    });

    it('is deterministic regardless of input order', () => {
        const items = [
            ...chain(['A', 'B', 'C'], '2026-07-28T00:00:00Z', 50),
            ...chain(['A', 'B', 'C'], '2026-07-28T00:00:00Z', 50, 90),
        ];
        const forward = collapse(items).kept.map((k) => k.start);
        const reversed = collapse([...items].reverse()).kept.map((k) => k.start);
        expect(reversed).toEqual(forward);
    });

    it('is deterministic when two lanes tie on count, coverage and first start', () => {
        // Two variants clipped to the same window agree on every ranking signal,
        // so the winner used to come down to arrival order and could flip
        // between imports of identical data.
        // Same count (2), same covered time (60 min) and same first start,
        // but no two intervals are identical — so exact-duplicate collapsing
        // doesn't fire and the lanes genuinely tie on every ranking signal.
        const laneA = [
            p('A1', '2026-07-28T12:00:00Z', '2026-07-28T12:30:00Z'),
            p('A2', '2026-07-28T13:00:00Z', '2026-07-28T13:30:00Z'),
        ];
        const laneB = [
            p('B1', '2026-07-28T12:00:00Z', '2026-07-28T12:40:00Z'),
            p('B2', '2026-07-28T12:50:00Z', '2026-07-28T13:10:00Z'),
        ];
        const forward = collapse([...laneA, ...laneB]).kept.map((k) => k.title);
        const interleaved = collapse([laneB[0], laneA[0], laneA[1], laneB[1]]).kept.map(
            (k) => k.title,
        );
        const reversed = collapse([...laneB, ...laneA].reverse()).kept.map((k) => k.title);
        expect(interleaved).toEqual(forward);
        expect(reversed).toEqual(forward);
    });

    it('drops exact duplicates, keeping the first occurrence', () => {
        const dup = p('A', '2026-07-28T12:00:00Z', '2026-07-28T13:00:00Z');
        const result = collapse([dup, { ...dup }]);
        expect(result.kept).toHaveLength(1);
        expect(result.kept[0]).toBe(dup);
        expect(result.dropped).toHaveLength(1);
    });

    it('drops entries with an unusable time range', () => {
        const items = [
            p('ok', '2026-07-28T12:00:00Z', '2026-07-28T13:00:00Z'),
            p('zero', '2026-07-28T14:00:00Z', '2026-07-28T14:00:00Z'),
            p('inverted', '2026-07-28T16:00:00Z', '2026-07-28T15:00:00Z'),
            p('nan', 'not-a-date', '2026-07-28T18:00:00Z'),
        ];
        const result = collapse(items);
        expect(result.kept.map((k) => k.title)).toEqual(['ok']);
        expect(result.dropped).toHaveLength(3);
    });

    it('handles empty and single-item input', () => {
        expect(collapse([]).kept).toEqual([]);
        expect(collapse([]).laneCount).toBe(0);
        const one = [p('A', '2026-07-28T12:00:00Z', '2026-07-28T13:00:00Z')];
        expect(collapse(one).kept).toEqual(one);
    });
});

describe('collapseByChannel', () => {
    it('collapses each channel independently and reports what it dropped', () => {
        interface Row {
            channel_id: string;
            start: string;
            end: string;
        }
        const rows: Row[] = [
            { channel_id: 'a', start: '2026-07-28T12:00:00Z', end: '2026-07-28T13:00:00Z' },
            { channel_id: 'a', start: '2026-07-28T12:03:00Z', end: '2026-07-28T13:03:00Z' },
            { channel_id: 'b', start: '2026-07-28T12:00:00Z', end: '2026-07-28T13:00:00Z' },
        ];
        const result = collapseByChannel(
            rows,
            (r) => r.channel_id,
            (r) => ({
                start: Date.parse(r.start),
                end: Date.parse(r.end),
            }),
        );
        expect(result.kept).toHaveLength(2);
        expect(result.droppedCount).toBe(1);
        expect(result.channelsAffected).toBe(1);
    });

    it('counts and returns consistently when the same object appears twice', () => {
        // Survivor tracking must be positional. Keyed on the item itself,
        // keeping one occurrence of a shared reference keeps them all, and the
        // returned rows contradict droppedCount.
        const row = { channel_id: 'a', start: '2026-07-28T12:00:00Z', end: '2026-07-28T13:00:00Z' };
        const result = collapseByChannel(
            [row, row],
            (r) => r.channel_id,
            (r) => ({ start: Date.parse(r.start), end: Date.parse(r.end) }),
        );
        expect(result.droppedCount).toBe(1);
        expect(result.kept).toHaveLength(1);
    });

    it('preserves input order of the kept rows across channels', () => {
        interface Row {
            channel_id: string;
            start: string;
            end: string;
        }
        const rows: Row[] = [
            { channel_id: 'b', start: '2026-07-28T12:00:00Z', end: '2026-07-28T13:00:00Z' },
            { channel_id: 'a', start: '2026-07-28T12:00:00Z', end: '2026-07-28T13:00:00Z' },
        ];
        const result = collapseByChannel(
            rows,
            (r) => r.channel_id,
            (r) => ({
                start: Date.parse(r.start),
                end: Date.parse(r.end),
            }),
        );
        expect(result.kept.map((r) => r.channel_id)).toEqual(['b', 'a']);
        expect(result.droppedCount).toBe(0);
    });
});
