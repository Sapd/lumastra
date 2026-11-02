// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    leaderIdsToCollapsedGroups,
    collapsedGroupsToLeaderIds,
    type CollapsedGroups,
} from './collapse-state';

/**
 * Test fixture: a flat playlist of episodes carrying their stable series/season
 * keys, mirroring what the playlist page computes via getSeriesKey/getSeasonKey.
 * Contiguous runs of the same key form a "block"; the first item of a run is its
 * leader.
 */
interface TestItem {
    id: number;
    seriesKey: string | null;
    seasonKey: string | null;
}

const seriesKeyOf = (i: TestItem) => i.seriesKey;
const seasonKeyOf = (i: TestItem) => i.seasonKey;

/** Compute leader maps the way the page's $derived blocks do. */
function buildLeaderMaps(items: TestItem[]) {
    const seriesLeader = new Map<number, number>();
    const seasonLeader = new Map<number, number>();

    let curSeriesKey: string | null = null;
    let curSeriesLeader: number | null = null;
    let curSeasonKey: string | null = null;
    let curSeasonLeader: number | null = null;

    for (const item of items) {
        if (item.seriesKey !== curSeriesKey) {
            curSeriesKey = item.seriesKey;
            curSeriesLeader = item.seriesKey ? item.id : null;
        }
        if (curSeriesLeader !== null) seriesLeader.set(item.id, curSeriesLeader);

        if (item.seasonKey !== curSeasonKey) {
            curSeasonKey = item.seasonKey;
            curSeasonLeader = item.seasonKey ? item.id : null;
        }
        if (curSeasonLeader !== null) seasonLeader.set(item.id, curSeasonLeader);
    }

    return {
        seriesLeaderOf: (id: number) => seriesLeader.get(id),
        seasonLeaderOf: (id: number) => seasonLeader.get(id),
    };
}

// A small library: Drifting Clouds S1 (ids 1,2), S2 (id 3); The Wisp S1 (ids 4,5).
const items: TestItem[] = [
    { id: 1, seriesKey: 'bb', seasonKey: 'bb-S1' },
    { id: 2, seriesKey: 'bb', seasonKey: 'bb-S1' },
    { id: 3, seriesKey: 'bb', seasonKey: 'bb-S2' },
    { id: 4, seriesKey: 'wire', seasonKey: 'wire-S1' },
    { id: 5, seriesKey: 'wire', seasonKey: 'wire-S1' },
];

describe('leaderIdsToCollapsedGroups', () => {
    it('maps collapsed leader ids to their stable keys', () => {
        const groups = leaderIdsToCollapsedGroups(
            items,
            [1], // bb series block leader collapsed
            [3], // bb-S2 season block leader collapsed
            seriesKeyOf,
            seasonKeyOf,
        );
        expect(groups).toEqual({ series: ['bb'], season: ['bb-S2'] });
    });

    it('drops leader ids that no longer resolve to an item', () => {
        const groups = leaderIdsToCollapsedGroups(items, [999], [], seriesKeyOf, seasonKeyOf);
        expect(groups).toEqual({ series: [], season: [] });
    });

    it('drops ids whose item has no group key', () => {
        const withMovie: TestItem[] = [...items, { id: 6, seriesKey: null, seasonKey: null }];
        const groups = leaderIdsToCollapsedGroups(withMovie, [6], [6], seriesKeyOf, seasonKeyOf);
        expect(groups).toEqual({ series: [], season: [] });
    });

    it('de-duplicates keys when the same series leads two blocks', () => {
        // bb appears in two separate blocks (leaders 1 and 10) — both collapsed.
        const split: TestItem[] = [
            { id: 1, seriesKey: 'bb', seasonKey: 'bb-S1' },
            { id: 2, seriesKey: 'wire', seasonKey: 'wire-S1' },
            { id: 10, seriesKey: 'bb', seasonKey: 'bb-S2' },
        ];
        const groups = leaderIdsToCollapsedGroups(split, [1, 10], [], seriesKeyOf, seasonKeyOf);
        expect(groups.series).toEqual(['bb']);
    });
});

describe('collapsedGroupsToLeaderIds', () => {
    it('resolves stable keys back to current leader ids', () => {
        const { seriesLeaderOf, seasonLeaderOf } = buildLeaderMaps(items);
        const groups: CollapsedGroups = { series: ['bb'], season: ['wire-S1'] };
        const result = collapsedGroupsToLeaderIds(
            items,
            groups,
            seriesKeyOf,
            seasonKeyOf,
            seriesLeaderOf,
            seasonLeaderOf,
        );
        expect(result.series).toEqual([1]); // bb block leader
        expect(result.season).toEqual([4]); // wire-S1 block leader
    });

    it('survives a reorder: same keys resolve to the new leader ids', () => {
        // Reordered so The Wisp comes first — leaders change, keys do not.
        const reordered: TestItem[] = [
            { id: 4, seriesKey: 'wire', seasonKey: 'wire-S1' },
            { id: 5, seriesKey: 'wire', seasonKey: 'wire-S1' },
            { id: 1, seriesKey: 'bb', seasonKey: 'bb-S1' },
            { id: 2, seriesKey: 'bb', seasonKey: 'bb-S1' },
            { id: 3, seriesKey: 'bb', seasonKey: 'bb-S2' },
        ];
        const { seriesLeaderOf, seasonLeaderOf } = buildLeaderMaps(reordered);
        const result = collapsedGroupsToLeaderIds(
            reordered,
            { series: ['bb'], season: [] },
            seriesKeyOf,
            seasonKeyOf,
            seriesLeaderOf,
            seasonLeaderOf,
        );
        expect(result.series).toEqual([1]); // bb's leader is still id 1 in this order
    });

    it('restores all blocks when a series is split into two', () => {
        const split: TestItem[] = [
            { id: 1, seriesKey: 'bb', seasonKey: 'bb-S1' },
            { id: 2, seriesKey: 'wire', seasonKey: 'wire-S1' },
            { id: 10, seriesKey: 'bb', seasonKey: 'bb-S2' },
        ];
        const { seriesLeaderOf, seasonLeaderOf } = buildLeaderMaps(split);
        const result = collapsedGroupsToLeaderIds(
            split,
            { series: ['bb'], season: [] },
            seriesKeyOf,
            seasonKeyOf,
            seriesLeaderOf,
            seasonLeaderOf,
        );
        expect(result.series.sort((a, b) => a - b)).toEqual([1, 10]);
    });

    it('ignores unknown keys', () => {
        const { seriesLeaderOf, seasonLeaderOf } = buildLeaderMaps(items);
        const result = collapsedGroupsToLeaderIds(
            items,
            { series: ['does-not-exist'], season: [] },
            seriesKeyOf,
            seasonKeyOf,
            seriesLeaderOf,
            seasonLeaderOf,
        );
        expect(result.series).toEqual([]);
    });

    it('round-trips: serialize then resolve yields the same leaders', () => {
        const { seriesLeaderOf, seasonLeaderOf } = buildLeaderMaps(items);
        const groups = leaderIdsToCollapsedGroups(items, [1], [3], seriesKeyOf, seasonKeyOf);
        const result = collapsedGroupsToLeaderIds(
            items,
            groups,
            seriesKeyOf,
            seasonKeyOf,
            seriesLeaderOf,
            seasonLeaderOf,
        );
        expect(result.series).toEqual([1]);
        expect(result.season).toEqual([3]);
    });
});
