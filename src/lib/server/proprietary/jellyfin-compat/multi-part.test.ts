// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
    moviePositionMs,
    partCountFor,
    partLayout,
    partOffsetSeconds,
    toPartItem,
    type PartFile,
} from './multi-part';
import type { JellyfinBaseItemDto } from './types';

const f = (
    id: string,
    part: number | null,
    edition: string | null = null,
    dur = 2700,
): PartFile => ({
    id,
    part_number: part,
    edition,
    duration_seconds: dur,
});

describe('partLayout', () => {
    it('lists part 1 only and counts the parts', () => {
        const layout = partLayout([f('p2', 2), f('p1', 1)]);
        expect(layout.sources.map((s) => s.id)).toEqual(['p1']);
        expect(layout.stackOf('p2')?.map((s) => s.id)).toEqual(['p1', 'p2']);
        expect(layout.partIndex('p1')).toBe(0);
        expect(layout.partIndex('p2')).toBe(1);
        expect(partCountFor(layout, 'p1')).toBe(2);
    });

    it('keeps true versions as sources without a PartCount', () => {
        const layout = partLayout([f('a', null), f('b', null)]);
        expect(layout.sources.map((s) => s.id)).toEqual(['a', 'b']);
        expect(layout.partIndex('a')).toBe(-1);
        expect(partCountFor(layout, 'a')).toBeUndefined();
    });

    it('two copies sharing one part number are versions ("Distant Harbors Part 1")', () => {
        const layout = partLayout([f('a', 1), f('b', 1)]);
        expect(layout.sources.map((s) => s.id)).toEqual(['a', 'b']);
        expect(partCountFor(layout, 'a')).toBeUndefined();
    });

    it('stacks per edition: each cut is a version with its own parts', () => {
        const layout = partLayout([
            f('t1', 1),
            f('t2', 2),
            f('d1', 1, 'Director'),
            f('d2', 2, 'Director'),
            f('d3', 3, 'Director'),
        ]);
        expect(layout.sources.map((s) => s.id)).toEqual(['t1', 'd1']);
        expect(partCountFor(layout, 't1')).toBe(2);
        expect(partCountFor(layout, 'd1')).toBe(3);
        expect(layout.stackOf('d3')?.map((s) => s.id)).toEqual(['d1', 'd2', 'd3']);
    });

    it('a duplicate of a part number stays a version next to the stack', () => {
        const layout = partLayout([f('p1', 1), f('p2', 2), f('p1b', 1)]);
        expect(layout.sources.map((s) => s.id)).toEqual(['p1', 'p1b']);
        expect(layout.partIndex('p1b')).toBe(-1);
    });
});

describe('partOffsetSeconds', () => {
    it('sums the parts before the index', () => {
        const stack = [f('p1', 1, null, 2700), f('p2', 2, null, 2400), f('p3', 3)];
        expect(partOffsetSeconds(stack, 0)).toBe(0);
        expect(partOffsetSeconds(stack, 2)).toBe(5100);
    });
    it('is unknown while an earlier part is unprobed', () => {
        const stack = [{ ...f('p1', 1), duration_seconds: null }, f('p2', 2)];
        expect(partOffsetSeconds(stack, 1)).toBeNull();
    });
});

describe('toPartItem', () => {
    const movie = {
        Name: 'Movie',
        Id: 'movie',
        ServerId: 's',
        Type: 'Movie',
        RunTimeTicks: 5400 * 10_000_000,
        PartCount: 2,
        Chapters: [],
        UserData: {
            PlaybackPositionTicks: 3000 * 10_000_000,
            PlayedPercentage: 55,
            Played: false,
            IsFavorite: false,
            ItemId: 'movie',
        },
    } as JellyfinBaseItemDto;
    const stack = [f('p1', 1), f('p2', 2, null, 2700)];

    it('is the part: own id, own length, position inside the part', () => {
        const part = toPartItem(movie, stack, 1);
        expect(part.Id).toBe('p2');
        expect(part.Name).toBe('Movie (Part 2)');
        expect(part.RunTimeTicks).toBe(2700 * 10_000_000);
        expect(part.PartCount).toBeUndefined();
        expect(part.Chapters).toBeUndefined();
        expect(part.UserData?.ItemId).toBe('p2');
        expect(part.UserData?.PlaybackPositionTicks).toBe(300 * 10_000_000);
    });

    it('has no position when the movie stands in another part', () => {
        const early = { ...movie, UserData: { ...movie.UserData!, PlaybackPositionTicks: 600e7 } };
        expect(toPartItem(early, stack, 1).UserData?.PlaybackPositionTicks).toBe(0);
    });

    it('is labelled by its part number and drops the movie Etag', () => {
        const gap = [f('p1', 1), f('p3', 3)];
        const part = toPartItem({ ...movie, Etag: 'movie-etag' }, gap, 1);
        expect(part.Name).toBe('Movie (Part 3)');
        expect(part.Etag).toBeUndefined();
    });

    it('has no position while the offset is unknown', () => {
        const unprobed = [{ ...f('p1', 1), duration_seconds: null }, f('p2', 2)];
        expect(toPartItem(movie, unprobed, 1).UserData?.PlaybackPositionTicks).toBe(0);
    });
});

describe('moviePositionMs', () => {
    const files = [f('p1', 1, null, 2700), f('p2', 2, null, 2400), f('v', null)];
    const sql = (() => Promise.resolve(files)) as unknown as postgres.Sql;

    it('adds the earlier parts and clamps to the part', async () => {
        expect(await moviePositionMs(sql, 'p2', 'movie', 60_000)).toBe(2_760_000);
        expect(await moviePositionMs(sql, 'p2', 'movie', 9_999_000)).toBe(5_100_000);
    });
    it('passes part 1, versions and movie ids through', async () => {
        expect(await moviePositionMs(sql, 'p1', 'movie', 60_000)).toBe(60_000);
        expect(await moviePositionMs(sql, 'v', 'movie', 60_000)).toBe(60_000);
        expect(await moviePositionMs(sql, 'movie', null, 60_000)).toBe(60_000);
    });
    it('a failing lookup never fails the report', async () => {
        const broken = (() => Promise.reject(new Error('db'))) as unknown as postgres.Sql;
        expect(await moviePositionMs(broken, 'p2', 'movie', 60_000)).toBe(60_000);
    });
});
