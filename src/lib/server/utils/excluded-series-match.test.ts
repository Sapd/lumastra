// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    NO_EXCLUSIONS,
    deserializeExclusions,
    hasExclusions,
    isCalendarRowExcluded,
    isMonitoredMovieExcluded,
    isMonitoredSeriesExcluded,
    serializeExclusions,
    type ExcludableCalendarRow,
    type SeriesExclusions,
} from './excluded-series-match';

const SERIES_A = 'aaaaaaaa-0000-4000-a000-000000000001';
const SERIES_B = 'bbbbbbbb-0000-4000-a000-000000000002';
const MOVIE_A = 'cccccccc-0000-4000-a000-000000000003';
const EPISODE_OF_A = 'dddddddd-0000-4000-a000-000000000004';

function muting(over: Partial<SeriesExclusions>): SeriesExclusions {
    return { ...NO_EXCLUSIONS, ...over };
}

function catalogEpisode(over: Partial<ExcludableCalendarRow> = {}): ExcludableCalendarRow {
    return {
        id: EPISODE_OF_A,
        title: 'Pilot',
        media_type: 'episode',
        series_name: 'Lanterns',
        series_id: SERIES_A,
        tmdb_id: null,
        ...over,
    };
}

function monitoredEpisode(over: Partial<ExcludableCalendarRow> = {}): ExcludableCalendarRow {
    return catalogEpisode({ id: null, series_id: null, tmdb_id: 4242, ...over });
}

function catalogMovie(over: Partial<ExcludableCalendarRow> = {}): ExcludableCalendarRow {
    return {
        id: MOVIE_A,
        title: 'Lanterns of Vell',
        media_type: 'movie',
        series_name: null,
        series_id: null,
        tmdb_id: null,
        ...over,
    };
}

function monitoredMovie(over: Partial<ExcludableCalendarRow> = {}): ExcludableCalendarRow {
    return catalogMovie({ id: null, tmdb_id: 4242, ...over });
}

describe('isCalendarRowExcluded', () => {
    it('is false when nothing is muted', () => {
        expect(isCalendarRowExcluded(NO_EXCLUSIONS, catalogEpisode())).toBe(false);
        expect(isCalendarRowExcluded(NO_EXCLUSIONS, monitoredMovie())).toBe(false);
    });

    it('hides a catalog episode by its series id, not by the episode id', () => {
        const bySeries = muting({ itemIds: new Set([SERIES_A]) });
        expect(isCalendarRowExcluded(bySeries, catalogEpisode())).toBe(true);
        expect(isCalendarRowExcluded(bySeries, catalogEpisode({ series_id: SERIES_B }))).toBe(
            false,
        );
        const byEpisode = muting({ itemIds: new Set([EPISODE_OF_A]) });
        expect(isCalendarRowExcluded(byEpisode, catalogEpisode())).toBe(false);
    });

    it('compares ids case-insensitively', () => {
        const ex = muting({ itemIds: new Set([SERIES_A]) });
        expect(
            isCalendarRowExcluded(ex, catalogEpisode({ series_id: SERIES_A.toUpperCase() })),
        ).toBe(true);
    });

    it('hides a catalog movie by its own id', () => {
        const ex = muting({ itemIds: new Set([MOVIE_A]) });
        expect(isCalendarRowExcluded(ex, catalogMovie())).toBe(true);
        expect(isCalendarRowExcluded(ex, catalogMovie({ id: SERIES_B }))).toBe(false);
    });

    it('hides a monitored episode by TMDB TV id', () => {
        const ex = muting({ tmdbTv: new Set(['4242']) });
        expect(isCalendarRowExcluded(ex, monitoredEpisode())).toBe(true);
        expect(isCalendarRowExcluded(ex, monitoredEpisode({ tmdb_id: 7 }))).toBe(false);
    });

    it('scopes a TMDB id by media type', () => {
        const tvOnly = muting({ tmdbTv: new Set(['4242']) });
        expect(isCalendarRowExcluded(tvOnly, monitoredMovie())).toBe(false);
        const movieOnly = muting({ tmdbMovie: new Set(['4242']) });
        expect(isCalendarRowExcluded(movieOnly, monitoredMovie())).toBe(true);
        expect(isCalendarRowExcluded(movieOnly, monitoredEpisode())).toBe(false);
    });

    it('hides a monitored episode that carries its catalog series id, by either key', () => {
        const row = monitoredEpisode({ series_id: SERIES_A });
        expect(isCalendarRowExcluded(muting({ itemIds: new Set([SERIES_A]) }), row)).toBe(true);
        expect(isCalendarRowExcluded(muting({ tmdbTv: new Set(['4242']) }), row)).toBe(true);
        expect(isCalendarRowExcluded(muting({ tmdbTv: new Set(['9999']) }), row)).toBe(false);
    });

    it('hides a catalog row through the id a TMDB key resolved to', () => {
        // The loader merges catalog ids found via the TMDB key into itemIds,
        // so a mute made while the title was monitored-only follows it into the catalog.
        const ex = muting({ tmdbTv: new Set(['4242']), itemIds: new Set([SERIES_A]) });
        expect(isCalendarRowExcluded(ex, catalogEpisode())).toBe(true);
    });

    it('never mutes by title: a row without a TMDB id stays visible', () => {
        // A muted catalog title carries its TMDB id, never its name.
        const ex = muting({ itemIds: new Set([SERIES_A]), tmdbTv: new Set(['4242']) });
        const noTmdb = { tmdb_id: null };
        expect(
            isCalendarRowExcluded(ex, monitoredEpisode({ ...noTmdb, series_name: 'Lanterns' })),
        ).toBe(false);
        expect(
            isCalendarRowExcluded(ex, monitoredMovie({ ...noTmdb, title: 'Lanterns of Vell' })),
        ).toBe(false);
        // A catalog row is matched by id even when the name equals a muted one.
        expect(isCalendarRowExcluded(ex, catalogEpisode({ series_id: SERIES_B }))).toBe(false);
    });
});

describe('monitored predicates', () => {
    it('accept a numeric or string TMDB id', () => {
        const ex = muting({ tmdbTv: new Set(['4242']), tmdbMovie: new Set(['99']) });
        expect(isMonitoredSeriesExcluded(ex, 4242)).toBe(true);
        expect(isMonitoredSeriesExcluded(ex, '4242')).toBe(true);
        expect(isMonitoredMovieExcluded(ex, 99)).toBe(true);
        expect(isMonitoredSeriesExcluded(ex, undefined)).toBe(false);
        expect(isMonitoredMovieExcluded(ex, null)).toBe(false);
    });

    it('match a Sonarr series row by TVDB id when its TMDB id is missing or differs', () => {
        const ex = muting({ tmdbTv: new Set(['4242']), tvdbTv: new Set(['81189']) });
        expect(isMonitoredSeriesExcluded(ex, undefined, 81189)).toBe(true);
        expect(isMonitoredSeriesExcluded(ex, 777, '81189')).toBe(true);
        expect(isMonitoredSeriesExcluded(ex, 777, 12)).toBe(false);
        // TMDB and TVDB ids are separate namespaces.
        expect(isMonitoredSeriesExcluded(ex, 81189)).toBe(false);
        expect(isMonitoredSeriesExcluded(ex, undefined, 4242)).toBe(false);
    });

    it('treat 0, the arr payloads\' "no id", as no id', () => {
        const ex = muting({ tmdbTv: new Set(['0']), tvdbTv: new Set(['0']) });
        expect(isMonitoredSeriesExcluded(ex, 0, 0)).toBe(false);
        expect(isMonitoredSeriesExcluded(ex, '0', '0')).toBe(false);
    });
});

describe('serialization', () => {
    it('round-trips through the cache form', () => {
        const ex = muting({
            itemIds: new Set([SERIES_A]),
            tmdbTv: new Set(['1']),
            tmdbMovie: new Set(['2']),
            tvdbTv: new Set(['3']),
            unresolvedTmdb: true,
        });
        const back = deserializeExclusions(JSON.parse(JSON.stringify(serializeExclusions(ex))));
        expect(back).toEqual(ex);
        expect(hasExclusions(back)).toBe(true);
        expect(hasExclusions(NO_EXCLUSIONS)).toBe(false);
    });
});
