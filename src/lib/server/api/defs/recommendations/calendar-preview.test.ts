// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { canonicalizeCalendarRow } from './calendar-delegate.js';
import type { CalendarRow } from '$lib/server/database/queries/calendar.queries.js';
const series = '123e4567-e89b-42d3-a456-426614174000';
const row: CalendarRow = {
    id: null,
    title: 'Pilot',
    media_type: 'episode',
    series_name: 'Show',
    series_id: null,
    season_number: 1,
    episode_number: 1,
    premiere_date: '2026-10-17',
    has_files: false,
    overview: null,
    year: 2026,
    source: 'monitored',
    source_series_id: 99,
    tmdb_id: 123,
};

describe('calendar preview mapper', () => {
    it('uses episode type and resolvable series handles for monitored rows', () => {
        expect(canonicalizeCalendarRow(row)).toMatchObject({
            id: 'tmdb:123:series',
            catalogId: null,
            type: 'episode',
            context: {
                series: { id: 'tmdb:123:series', catalogId: null, title: 'Show' },
                seasonNumber: 1,
                episodeNumber: 1,
                airDate: '2026-10-17',
            },
            monitored: true,
            hasFile: false,
        });
    });
    it('uses a catalog episode id when present', () => {
        expect(canonicalizeCalendarRow({ ...row, id: series, series_id: series })).toMatchObject({
            id: series,
            catalogId: series,
        });
    });
    it('drops rows that only have Sonarr IDs', () => {
        expect(canonicalizeCalendarRow({ ...row, tmdb_id: null })).toBeNull();
    });
    it('uses movie identity and context.airDate for movie releases', () => {
        expect(canonicalizeCalendarRow({ ...row, media_type: 'movie' })).toMatchObject({
            id: 'tmdb:123:movie',
            type: 'movie',
            context: { airDate: '2026-10-17' },
        });
    });
});
