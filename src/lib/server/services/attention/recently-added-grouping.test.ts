// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { RecentlyAddedRow } from '$lib/server/database/queries/attention.queries';
import { groupRecentlyAdded } from './recently-added-grouping';

const BASE = Date.parse('2026-10-13T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function at(hoursAgo: number): string {
    return new Date(BASE - hoursAgo * HOUR).toISOString();
}

function ep(
    id: string,
    seriesId: string,
    s: number | null,
    e: number | null,
    hoursAgo = 0,
): RecentlyAddedRow {
    return {
        id,
        title: `Episode ${id}`,
        mediaType: 'episode',
        year: null,
        seriesId,
        seriesTitle: `Series ${seriesId}`,
        seasonNumber: s,
        episodeNumber: e,
        addedAt: at(hoursAgo),
    };
}

function movie(id: string, hoursAgo = 0): RecentlyAddedRow {
    return {
        id,
        title: `Movie ${id}`,
        mediaType: 'movie',
        year: 2001,
        seriesId: null,
        seriesTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        addedAt: at(hoursAgo),
    };
}

describe('groupRecentlyAdded', () => {
    it('collapses one series into one item led by the newest episode, with real counts', () => {
        const [item, ...rest] = groupRecentlyAdded(
            [ep('a', 'S', 5, 24), ep('b', 'S', 5, 21), ep('c', 'S', 5, 23), ep('d', 'S', 5, 22)],
            10,
        );
        expect(rest).toHaveLength(0);
        expect(item.id).toBe('a');
        expect(item.episodeNumber).toBe(24);
        expect(item.seriesId).toBe('S');
        expect(item.episodeCount).toBe(4);
        expect(item.seasons).toEqual([{ season: 5, episodes: [21, 22, 23, 24] }]);
    });

    it('leaves single items without group fields', () => {
        const items = groupRecentlyAdded([ep('a', 'S', 1, 1), movie('m')], 10);
        expect(items.map((i) => i.id)).toEqual(['a', 'm']);
        for (const i of items) {
            expect(i.episodeCount).toBeUndefined();
            expect(i.seasons).toBeUndefined();
        }
        expect(items[1].year).toBe(2001);
    });

    it('keeps two series with the same title apart', () => {
        const a = { ...ep('a', 'S1', 1, 1), seriesTitle: 'Same' };
        const b = { ...ep('b', 'S2', 1, 2), seriesTitle: 'Same' };
        expect(groupRecentlyAdded([a, b], 10)).toHaveLength(2);
    });

    it('joins interleaved episodes and keeps newest-first row order', () => {
        const items = groupRecentlyAdded(
            [ep('a', 'S', 1, 2), movie('m'), ep('b', 'T', 1, 1), ep('c', 'S', 1, 1)],
            10,
        );
        expect(items.map((i) => i.id)).toEqual(['a', 'm', 'b']);
        expect(items[0].seasons).toEqual([{ season: 1, episodes: [1, 2] }]);
    });

    it('splits a series into separate rows when its episodes arrived more than a day apart', () => {
        const items = groupRecentlyAdded(
            [
                ep('a', 'S', 2, 2, 0),
                ep('b', 'S', 2, 1, 1),
                ep('c', 'S', 1, 9, 30),
                ep('d', 'S', 1, 8, 31),
            ],
            10,
        );
        expect(items.map((i) => [i.id, i.episodeCount])).toEqual([
            ['a', 2],
            ['c', 2],
        ]);
    });

    it('chains a burst: each episode only has to be within a day of the previous one', () => {
        const rows = Array.from({ length: 5 }, (_, i) => ep(`e${i}`, 'S', 1, 10 - i, i * 20));
        expect(groupRecentlyAdded(rows, 10)).toHaveLength(1);
    });

    it('counts every episode of a large import, beyond the visible row cap', () => {
        const rows = [
            ...Array.from({ length: 120 }, (_, i) =>
                ep(`e${i}`, 'S', 1 + Math.floor(i / 24), (i % 24) + 1),
            ),
            ...Array.from({ length: 15 }, (_, i) => movie(`m${i}`, 1)),
        ];
        const items = groupRecentlyAdded(rows, 10);
        expect(items).toHaveLength(10);
        expect(items[0].episodeCount).toBe(120);
        expect(items[0].seasons?.map((s) => s.season)).toEqual([1, 2, 3, 4, 5]);
    });

    it('still lets episodes join a visible group after the row cap is reached', () => {
        const rows = [
            ep('a', 'S', 1, 3),
            ...Array.from({ length: 3 }, (_, i) => movie(`m${i}`)),
            ep('b', 'S', 1, 2),
        ];
        const items = groupRecentlyAdded(rows, 2);
        expect(items.map((i) => i.id)).toEqual(['a', 'm0']);
        expect(items[0].episodeCount).toBe(2);
    });

    it('counts episodes without numbers but lists only numbered ones, deduplicated', () => {
        const [item] = groupRecentlyAdded(
            [ep('a', 'S', 1, 3), ep('b', 'S', 1, 3), ep('c', 'S', 1, null), ep('d', 'S', 0, 1)],
            10,
        );
        expect(item.episodeCount).toBe(4);
        expect(item.seasons).toEqual([
            { season: 0, episodes: [1] },
            { season: 1, episodes: [3] },
        ]);
    });
});
