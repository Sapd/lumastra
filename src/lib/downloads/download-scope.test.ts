// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test, vi } from 'vitest';
import type { DownloadList, DownloadListItem } from './download-queue.svelte';
import {
    episodeCode,
    fromHereEpisodes,
    initialSeriesScope,
    realSeasonCount,
    scopeItems,
    scopeOptions,
    scopeQuery,
} from './download-scope';

vi.mock('$app/paths', () => ({ base: '' }));

const ep = (season: number | null, n: number | null, over: Partial<DownloadListItem> = {}) =>
    ({
        mediaItemId: `s${season}e${n}`,
        fileId: `f${season}${n}`,
        season,
        episode: n,
        seasonFolder: 'x',
        fileName: `Show - S0${season}E0${n}.mkv`,
        sizeBytes: 100,
        available: true,
        ...over,
    }) as DownloadListItem;

const all = (items: DownloadListItem[]): DownloadList => ({
    allowed: true,
    maxParallel: 0,
    seriesFolder: 'Show',
    missingCount: 0,
    items,
});

const multi = all([ep(0, 1), ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1)]);

describe('scopeOptions', () => {
    test('from an episode in the middle of a multi-season series: all five', () => {
        const s = initialSeriesScope(multi, { scope: 'episode', episodeId: 's1e2' })!;
        expect(scopeOptions(s)).toEqual([
            { scope: 'episode', count: 1, bytes: 100 },
            { scope: 'fromHere', count: 2, bytes: 200 },
            { scope: 'custom', count: 3, bytes: 300 },
            { scope: 'season', count: 3, bytes: 300 },
            { scope: 'series', count: 4, bytes: 400 },
        ]);
    });

    test('the last episode has no "from here" (only itself remains)', () => {
        const s = initialSeriesScope(multi, { scope: 'episode', episodeId: 's1e3' })!;
        expect(scopeOptions(s).map((o) => o.scope)).toEqual([
            'episode',
            'custom',
            'season',
            'series',
        ]);
    });

    test('a season of one episode has no checklist', () => {
        const s = initialSeriesScope(multi, { scope: 'season', season: 2 })!;
        expect(scopeOptions(s).map((o) => o.scope)).toEqual(['season', 'series']);
    });

    test('a single-season series has no "whole series" row next to its season', () => {
        const one = all([ep(1, 1), ep(1, 2)]);
        const s = initialSeriesScope(one, { scope: 'series', season: 1 })!;
        expect(scopeOptions(s).map((o) => o.scope)).toEqual(['custom', 'season']);
        expect(s.scope).toBe('season');
    });

    test('one regular season plus specials: "series" stays offered while viewing specials or the season', () => {
        const l = all([ep(0, 1), ep(0, 2), ep(1, 1), ep(1, 2)]);
        for (const season of [0, 1]) {
            const s = initialSeriesScope(l, { scope: 'series', season })!;
            expect(s.scope).toBe('series');
            expect(scopeOptions(s).map((o) => o.scope)).toContain('series');
        }
    });

    test('without a season only "series" exists', () => {
        const s = initialSeriesScope(multi, { scope: 'series' })!;
        expect(scopeOptions(s).map((o) => o.scope)).toEqual(['series']);
    });

    test('unavailable items never count', () => {
        const l = all([ep(1, 1), ep(1, 2, { available: false }), ep(1, 3), ep(2, 1)]);
        const s = initialSeriesScope(l, { scope: 'season', season: 1 })!;
        expect(scopeItems(s).map((i) => i.mediaItemId)).toEqual(['s1e1', 's1e3']);
        expect(fromHereEpisodes({ ...s, episodeId: 's1e1' })).toHaveLength(2);
        expect(realSeasonCount(l)).toBe(2);
    });
});

describe('initialSeriesScope', () => {
    test('null for an unavailable or unknown episode and for an empty list', () => {
        const l = all([ep(1, 1, { available: false }), ep(1, 2)]);
        expect(initialSeriesScope(l, { scope: 'episode', episodeId: 's1e1' })).toBeNull();
        expect(initialSeriesScope(l, { scope: 'episode', episodeId: 'zz' })).toBeNull();
        expect(initialSeriesScope(all([]), { scope: 'series' })).toBeNull();
    });

    test('the checklist starts with the opening episode, or with the whole season', () => {
        expect(initialSeriesScope(multi, { scope: 'custom', episodeId: 's1e2' })!.custom).toEqual([
            's1e2',
        ]);
        expect(initialSeriesScope(multi, { scope: 'custom', season: 1 })!.custom).toEqual([
            's1e1',
            's1e2',
            's1e3',
        ]);
    });
});

describe('scopeQuery and episodeCode', () => {
    test('season 0 is asked for with specials; subsets carry ids only', () => {
        const s = initialSeriesScope(multi, { scope: 'season', season: 0 })!;
        expect(scopeQuery(s)).toEqual({ season: 0, specials: true });
        const sub = initialSeriesScope(multi, { scope: 'fromHere', episodeId: 's1e2' })!;
        expect(scopeQuery(sub)).toEqual({ episodeIds: ['s1e2', 's1e3'] });
        const sp = all([ep(0, 1), ep(0, 2), ep(1, 1)]);
        const special = initialSeriesScope(sp, { scope: 'custom', season: 0 })!;
        expect(scopeQuery(special)).toEqual({ episodeIds: ['s0e1', 's0e2'], specials: true });
    });

    test('code is SxxEyy, or the file name without numbers', () => {
        expect(episodeCode(ep(1, 2))).toBe('S01E02');
        expect(episodeCode(ep(null, null, { fileName: 'Pilot.mkv' }))).toBe('Pilot.mkv');
    });
});
