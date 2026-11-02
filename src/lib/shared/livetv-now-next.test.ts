// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { pickNowNext } from './livetv-now-next.js';
import type { LiveTvAiring } from '$lib/schemas/livetv.js';

function airing(id: string, start: number, end: number): LiveTvAiring {
    return { id, stationId: 'station', title: id,
        startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() };
}

describe('pickNowNext', () => {
    it('returns nulls for empty and ended schedules', () => {
        expect(pickNowNext([], 100)).toEqual({ current: null, next: null });
        expect(pickNowNext([airing('a', 0, 100)], 100)).toEqual({ current: null, next: null });
    });
    it('includes the start and excludes the end at an exact boundary', () => {
        const a = airing('a', 0, 100), b = airing('b', 100, 200), c = airing('c', 200, 300);
        expect(pickNowNext([a, b, c], 100)).toEqual({ current: b, next: c });
    });
    it('finds the next airing before all airings and in a gap', () => {
        const a = airing('a', 100, 200), b = airing('b', 300, 400);
        expect(pickNowNext([a, b], 0)).toEqual({ current: null, next: a });
        expect(pickNowNext([a, b], 250)).toEqual({ current: null, next: b });
        expect(pickNowNext([a, b], 150)).toEqual({ current: a, next: b });
    });
    it('skips overlapping airings when looking beyond the current end', () => {
        const a = airing('a', 0, 200), overlap = airing('overlap', 100, 300), b = airing('b', 200, 400);
        expect(pickNowNext([a, overlap, b], 150)).toEqual({ current: a, next: b });
    });
    it('does not mutate unsorted input and uses the earliest future start', () => {
        const a = airing('a', 0, 100), b = airing('b', 200, 300), c = airing('c', 400, 500);
        const input = Object.freeze([c, b, a]);
        expect(pickNowNext(input, 50)).toEqual({ current: a, next: b });
        expect(input).toEqual([c, b, a]);
    });
    it('ignores zero-length airings before the next valid programme', () => {
        const current = airing('current', 0, 100);
        const next = airing('next', 200, 300);
        const invalid = airing('zero-length', 150, 150);
        expect(pickNowNext([invalid, next, current], 50)).toEqual({ current, next });
        expect(pickNowNext([invalid], 50)).toEqual({ current: null, next: null });
    });
    it.each(['startTime', 'endTime'] as const)('ignores airings with NaN %s', (field) => {
        const current = airing('current', 0, 100);
        const next = airing('next', 200, 300);
        const invalid = { ...airing('invalid', 100, 150), [field]: 'not-a-date' };
        expect(pickNowNext([invalid, next, current], 50)).toEqual({ current, next });
        expect(pickNowNext([invalid], 50)).toEqual({ current: null, next: null });
    });
    it('settles identical starts deterministically regardless of input order', () => {
        const a = airing('a', 0, 100), b = airing('b', 0, 100);
        expect(pickNowNext([b, a], 50)).toEqual(pickNowNext([a, b], 50));
    });
});
