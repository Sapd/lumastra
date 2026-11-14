// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    channelIdOfSyntheticProgram,
    filterPrograms,
    matchesFlagFilters,
    pageResult,
    parseBool,
    programQueryFromBody,
    programQueryFromUrl,
    MAX_WINDOW_MS,
    programWindow,
    sortPrograms,
    syntheticLiveProgram,
    type ProgramEntry,
} from './livetv-query';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const MIN = 60_000;

function entry(
    id: string,
    startOffsetMin: number,
    durationMin: number,
    opts: { category?: string; genres?: string[]; title?: string } = {},
): ProgramEntry {
    const start = new Date(NOW.getTime() + startOffsetMin * MIN);
    const end = new Date(start.getTime() + durationMin * MIN);
    return {
        program: {
            id,
            channelId: 'ch',
            title: opts.title ?? id,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            genres: opts.genres,
        },
        channelName: 'Channel',
        hasLogo: false,
        category: opts.category,
    };
}

function q(search: string): ReturnType<typeof programQueryFromUrl> {
    return programQueryFromUrl(new URL(`https://x.test/j/LiveTv/Programs${search}`));
}

const ids = (entries: ProgramEntry[]): string[] => entries.map((e) => e.program.id);

describe('parseBool', () => {
    it('reads true/false in any case and ignores anything else', () => {
        expect(parseBool('TRUE')).toBe(true);
        expect(parseBool('false')).toBe(false);
        expect(parseBool(true)).toBe(true);
        expect(parseBool('yes')).toBeUndefined();
        expect(parseBool(null)).toBeUndefined();
    });
});

describe('programQueryFromUrl / programQueryFromBody', () => {
    it('reads every Jellyfin program param, case-insensitively', () => {
        const query = q(
            '?channelIds=a,b&minStartDate=2026-10-07T10:00:00Z&maxStartDate=2026-10-07T20:00:00Z' +
                '&hasAired=false&isAiring=true&isMovie=true&isSports=false&genres=News|Talk' +
                '&startIndex=5&limit=10&sortBy=Name,StartDate&sortOrder=Descending&enableTotalRecordCount=false',
        );
        expect(query.channelIdSources).toEqual(['a', 'b']);
        expect(query.minStartDate?.toISOString()).toBe('2026-10-07T10:00:00.000Z');
        expect(query.maxStartDate?.toISOString()).toBe('2026-10-07T20:00:00.000Z');
        expect(query.hasAired).toBe(false);
        expect(query.isAiring).toBe(true);
        expect(query.isMovie).toBe(true);
        expect(query.isSports).toBe(false);
        expect(query.isNews).toBeUndefined();
        expect(query.genres).toEqual(['News', 'Talk']);
        expect(query.startIndex).toBe(5);
        expect(query.limit).toBe(10);
        expect(query.limitGiven).toBe(true);
        expect(query.sortBy).toEqual(['Name', 'StartDate']);
        expect(query.sortOrder).toEqual(['Descending']);
        expect(query.enableTotalRecordCount).toBe(false);
    });

    it('defaults: unbounded limit, total count on, garbage ignored', () => {
        const query = q('?limit=abc&startIndex=-4&minStartDate=notadate&isKids=maybe');
        expect(query.limitGiven).toBe(false);
        expect(query.limit).toBe(20000);
        expect(query.startIndex).toBe(0);
        expect(query.minStartDate).toBeUndefined();
        expect(query.isKids).toBeUndefined();
        expect(query.enableTotalRecordCount).toBe(true);
    });

    it('reads the GetProgramsDto body', () => {
        const query = programQueryFromBody({
            ChannelIds: ['a'],
            HasAired: true,
            IsNews: true,
            Genres: ['News'],
            SortBy: ['StartDate'],
            SortOrder: ['Descending'],
            Limit: 3,
            StartIndex: 1,
            EnableTotalRecordCount: false,
            MinEndDate: '2026-10-07T11:00:00Z',
        });
        expect(query.channelIdSources).toEqual(['a']);
        expect(query.hasAired).toBe(true);
        expect(query.isNews).toBe(true);
        expect(query.genres).toEqual(['News']);
        expect(query.sortOrder).toEqual(['Descending']);
        expect(query.limit).toBe(3);
        expect(query.startIndex).toBe(1);
        expect(query.enableTotalRecordCount).toBe(false);
        expect(query.minEndDate?.toISOString()).toBe('2026-10-07T11:00:00.000Z');
    });
});

describe('programWindow', () => {
    it('defaults to now-3h .. now+24h', () => {
        const w = programWindow(q(''), NOW);
        expect(w.start.getTime()).toBe(NOW.getTime() - 3 * 60 * MIN);
        expect(w.end.getTime()).toBe(NOW.getTime() + 24 * 60 * MIN);
    });

    it('follows explicit date bounds and caps the span at 48 hours', () => {
        const w = programWindow(
            q('?minStartDate=2026-10-08T00:00:00Z&maxStartDate=2026-12-31T00:00:00Z'),
            NOW,
        );
        expect(w.start.toISOString()).toBe('2026-10-08T00:00:00.000Z');
        expect(w.end.getTime() - w.start.getTime()).toBe(48 * 60 * MIN);
    });

    it('clamps a 100-day request (GET bounds and POST body alike) to 48 hours', () => {
        const fromUrl = programWindow(
            q('?minStartDate=2026-07-01T00:00:00Z&maxEndDate=2026-10-09T00:00:00Z'),
            NOW,
        );
        expect(fromUrl.end.getTime() - fromUrl.start.getTime()).toBe(MAX_WINDOW_MS);
        const fromBody = programWindow(
            programQueryFromBody({
                MinStartDate: '2026-10-07T00:00:00Z',
                MaxStartDate: '2027-01-15T00:00:00Z',
            }),
            NOW,
        );
        expect(fromBody.end.getTime() - fromBody.start.getTime()).toBe(MAX_WINDOW_MS);
    });

    it('a far-past lower bound with no upper bound still covers now', () => {
        const w = programWindow(q('?minEndDate=2026-01-01T00:00:00Z'), NOW);
        expect(w.start.getTime()).toBeLessThanOrEqual(NOW.getTime());
        expect(w.end.getTime()).toBeGreaterThan(NOW.getTime());
        expect(w.end.getTime() - w.start.getTime()).toBe(MAX_WINDOW_MS);
    });

    it('never ends before it starts', () => {
        const w = programWindow(q('?minStartDate=2026-10-20T00:00:00Z'), NOW);
        expect(w.end.getTime()).toBeGreaterThan(w.start.getTime());
    });
});

describe('filterPrograms', () => {
    const aired = entry('aired', -120, 60);
    const airing = entry('airing', -30, 60);
    const upcoming = entry('upcoming', 60, 60);
    const all = [aired, airing, upcoming];

    it('HasAired and IsAiring, both polarities', () => {
        expect(ids(filterPrograms(all, q('?hasAired=true'), NOW))).toEqual(['aired']);
        expect(ids(filterPrograms(all, q('?hasAired=false'), NOW))).toEqual(['airing', 'upcoming']);
        expect(ids(filterPrograms(all, q('?isAiring=true'), NOW))).toEqual(['airing']);
        expect(ids(filterPrograms(all, q('?isAiring=false'), NOW))).toEqual(['aired', 'upcoming']);
    });

    it('min/max start and end dates', () => {
        const at = (min: number): string => new Date(NOW.getTime() + min * MIN).toISOString();
        expect(ids(filterPrograms(all, q(`?minStartDate=${at(-60)}`), NOW))).toEqual([
            'airing',
            'upcoming',
        ]);
        expect(ids(filterPrograms(all, q(`?maxStartDate=${at(0)}`), NOW))).toEqual([
            'aired',
            'airing',
        ]);
        expect(ids(filterPrograms(all, q(`?minEndDate=${at(0)}`), NOW))).toEqual([
            'airing',
            'upcoming',
        ]);
        expect(ids(filterPrograms(all, q(`?maxEndDate=${at(0)}`), NOW))).toEqual(['aired']);
    });

    it('content flags from the channel category: movie AND, tags OR, false excludes', () => {
        const movie = entry('movie', 0, 90, { category: 'Movies' });
        const sports = entry('sports', 0, 90, { category: 'Sport' });
        const news = entry('news', 0, 90, { category: 'News' });
        const other = entry('other', 0, 90, { category: 'General' });
        const list = [movie, sports, news, other];
        expect(ids(filterPrograms(list, q('?isMovie=true'), NOW))).toEqual(['movie']);
        expect(ids(filterPrograms(list, q('?isMovie=false'), NOW))).toEqual([
            'sports',
            'news',
            'other',
        ]);
        expect(ids(filterPrograms(list, q('?isSports=true&isNews=true'), NOW))).toEqual([
            'sports',
            'news',
        ]);
        expect(ids(filterPrograms(list, q('?isNews=false'), NOW))).toEqual([
            'movie',
            'sports',
            'other',
        ]);
        expect(filterPrograms(list, q('?isSeries=true'), NOW)).toEqual([]);
        expect(filterPrograms(list, q('?isSeries=false'), NOW)).toHaveLength(4);
    });

    it('genres match any, case-insensitively', () => {
        const a = entry('a', 0, 30, { genres: ['News', 'Talk'] });
        const b = entry('b', 0, 30, { genres: ['Sport'] });
        const c = entry('c', 0, 30);
        expect(ids(filterPrograms([a, b, c], q('?genres=talk|sport'), NOW))).toEqual(['a', 'b']);
    });
});

describe('sortPrograms', () => {
    const late = entry('late', 60, 30, { title: 'Alpha' });
    const early = entry('early', 0, 120, { title: 'Charlie' });
    const mid = entry('mid', 30, 10, { title: 'Bravo' });

    it('defaults to StartDate ascending', () => {
        expect(ids(sortPrograms([late, early, mid], q('')))).toEqual(['early', 'mid', 'late']);
    });

    it('honours SortBy/SortOrder pairs and ignores unknown keys', () => {
        expect(ids(sortPrograms([late, early, mid], q('?sortBy=Name')))).toEqual([
            'late',
            'mid',
            'early',
        ]);
        expect(
            ids(sortPrograms([late, early, mid], q('?sortBy=StartDate&sortOrder=Descending'))),
        ).toEqual(['late', 'mid', 'early']);
        expect(ids(sortPrograms([late, early, mid], q('?sortBy=Runtime')))).toEqual([
            'mid',
            'late',
            'early',
        ]);
        expect(ids(sortPrograms([late, early, mid], q('?sortBy=Bogus')))).toEqual([
            'early',
            'mid',
            'late',
        ]);
    });

    it('Random keeps every entry', () => {
        expect(ids(sortPrograms([late, early, mid], q('?sortBy=Random'))).sort()).toEqual([
            'early',
            'late',
            'mid',
        ]);
    });
});

describe('pageResult', () => {
    it('reports the full total, or the page length when the count is off', () => {
        expect(pageResult([1, 2, 3, 4, 5], 1, 2, true)).toEqual({ page: [2, 3], total: 5 });
        expect(pageResult([1, 2, 3, 4, 5], 1, 2, false)).toEqual({ page: [2, 3], total: 2 });
    });
});

describe('matchesFlagFilters', () => {
    it('passes everything when no flag is set', () => {
        expect(matchesFlagFilters(undefined, {})).toBe(true);
    });
});

describe('synthetic programs', () => {
    it('round-trips the channel id and spans the current UTC day', () => {
        const p = syntheticLiveProgram(
            { id: '11111111-1111-1111-1111-111111111111', name: 'One', sortOrder: 0 } as never,
            NOW,
        );
        expect(channelIdOfSyntheticProgram(p.id)).toBe('11111111-1111-1111-1111-111111111111');
        expect(p.startTime).toBe('2026-10-07T00:00:00.000Z');
        expect(p.endTime).toBe('2026-10-08T00:00:00.000Z');
        expect(channelIdOfSyntheticProgram('11111111-1111-1111-1111-111111111111')).toBeNull();
    });
});
