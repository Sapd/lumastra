// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { numberChannelsByCategory, numberChannelsForLineup } from './channel-numbering';
import type { LiveTvCategory, LiveTvChannel } from '$lib/schemas/livetv';

function category(id: string, name: string, sortOrder: number): LiveTvCategory {
    return { id, name, sortOrder, isVisible: true };
}

function channels(categoryId: string | undefined, count: number, prefix: string): LiveTvChannel[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        name: `${prefix} ${String(i).padStart(3, '0')}`,
        sortOrder: i,
        isVisible: true,
        categoryId,
        images: {},
    }));
}

function numbersFor(result: ReturnType<typeof numberChannelsByCategory>, prefix: string): number[] {
    return result.filter((entry) => entry.channel.id.startsWith(`${prefix}-`)).map((e) => e.number);
}

describe('numberChannelsByCategory', () => {
    it('gives the first category 1..n and later categories their own thousands block', () => {
        // Mirrors prod: Sports(419) is the biggest bucket, so blocks are 1000 wide.
        const cats = [category('sports', 'Sports', 0), category('free', 'Free TV', 1)];
        const result = numberChannelsByCategory(
            [...channels('sports', 419, 'sp'), ...channels('free', 73, 'fr')],
            cats,
        );

        const sports = numbersFor(result, 'sp');
        const free = numbersFor(result, 'fr');
        expect([sports[0], sports.at(-1)]).toEqual([1, 419]);
        expect([free[0], free.at(-1)]).toEqual([2000, 2072]);
    });

    it('uses 100-wide blocks when every category is small', () => {
        const cats = [category('a', 'A', 0), category('b', 'B', 1), category('c', 'C', 2)];
        const result = numberChannelsByCategory(
            [...channels('a', 12, 'a'), ...channels('b', 5, 'b'), ...channels('c', 3, 'c')],
            cats,
        );

        expect(numbersFor(result, 'a')[0]).toBe(1);
        expect(numbersFor(result, 'b')[0]).toBe(200);
        expect(numbersFor(result, 'c')[0]).toBe(300);
    });

    it('widens blocks when a category would overflow (oss installs vary)', () => {
        const cats = [category('a', 'A', 0), category('b', 'B', 1)];
        const result = numberChannelsByCategory(
            [...channels('a', 1500, 'a'), ...channels('b', 2, 'b')],
            cats,
        );

        // 1500 channels needs 10000-wide blocks so block 1 (1..1500) can't collide.
        expect(numbersFor(result, 'a')[0]).toBe(1);
        expect(numbersFor(result, 'a').at(-1)).toBe(1500);
        expect(numbersFor(result, 'b')[0]).toBe(20000);
    });

    it('handles more categories than there are digits', () => {
        const cats = Array.from({ length: 12 }, (_, i) => category(`c${i}`, `C${i}`, i));
        const result = numberChannelsByCategory(
            cats.flatMap((cat) => channels(cat.id, 2, cat.id)),
            cats,
        );

        expect(numbersFor(result, 'c0')[0]).toBe(1);
        expect(numbersFor(result, 'c9')[0]).toBe(1000);
        expect(numbersFor(result, 'c11')[0]).toBe(1200);
    });

    it('orders output by category order, then by channel sortOrder', () => {
        const cats = [category('first', 'First', 0), category('second', 'Second', 1)];
        // Deliberately interleaved input — getAllVisibleChannels returns channels
        // ordered by sort_order globally, so categories arrive mixed together.
        const result = numberChannelsByCategory(
            [...channels('second', 2, 'sec'), ...channels('first', 2, 'fir')],
            cats,
        );

        expect(result.map((entry) => entry.channel.id)).toEqual([
            'fir-0',
            'fir-1',
            'sec-0',
            'sec-1',
        ]);
    });

    it('puts uncategorized channels in a trailing block', () => {
        const cats = [category('a', 'A', 0)];
        const result = numberChannelsByCategory(
            [...channels('a', 3, 'a'), ...channels(undefined, 2, 'none')],
            cats,
        );

        expect(numbersFor(result, 'a')[0]).toBe(1);
        expect(numbersFor(result, 'none')[0]).toBe(200);
    });

    it('skips categories that have no visible channels', () => {
        const cats = [category('a', 'A', 0), category('empty', 'Empty', 1), category('b', 'B', 2)];
        const result = numberChannelsByCategory(
            [...channels('a', 2, 'a'), ...channels('b', 2, 'b')],
            cats,
        );

        // B takes the second block rather than leaving a hole for the empty one.
        expect(numbersFor(result, 'b')[0]).toBe(200);
    });

    it('never repeats a number and covers every channel', () => {
        const cats = [category('a', 'A', 0), category('b', 'B', 1), category('c', 'C', 2)];
        const input = [
            ...channels('a', 150, 'a'),
            ...channels('b', 40, 'b'),
            ...channels(undefined, 7, 'none'),
            ...channels('c', 12, 'c'),
        ];

        const result = numberChannelsByCategory(input, cats);

        expect(result).toHaveLength(input.length);
        expect(new Set(result.map((entry) => entry.number)).size).toBe(input.length);
    });

    it('falls back to positional numbering when there are no categories at all', () => {
        const result = numberChannelsByCategory(channels(undefined, 4, 'x'), []);
        expect(result.map((entry) => entry.number)).toEqual([1, 2, 3, 4]);
    });
});

describe('numberChannelsForLineup', () => {
    const cats = [category('news', 'News', 0)];

    it('uses the stored numbers in number order; an unnumbered channel trails the highest', () => {
        const lineup = channels('news', 4, 'n');
        lineup[0].channelNumber = 9;
        lineup[1].channelNumber = 2;
        lineup[2].channelNumber = 5;
        const result = numberChannelsForLineup(lineup, cats);
        expect(result.map((e) => [e.channel.id, e.number])).toEqual([
            ['n-1', 2],
            ['n-2', 5],
            ['n-0', 9],
            ['n-3', 10],
        ]);
    });

    it('falls back to category blocks when no channel has a stored number', () => {
        const lineup = channels('news', 3, 'n');
        expect(numberChannelsForLineup(lineup, cats)).toEqual(
            numberChannelsByCategory(lineup, cats),
        );
    });
});
