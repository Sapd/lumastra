// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for `toCalendarItem` (defs/recommendations/calendar.ts) — the row →
 * wire mapping behind GET /api/calendar.
 *
 * Background: `sonarrSeriesId` on this endpoint has never held a Sonarr id. It
 * holds the parent series' `media_items` UUID, while a *different* producer
 * (`transformSonarrToMediaItem`, for ?view=episodes) fills a field of the same
 * name with a genuine numeric Sonarr id. One name, two identifier namespaces.
 *
 * These tests pin the split: the UUID reaches the honestly-named
 * `seriesMediaId`, the legacy alias keeps carrying the SAME value for wire
 * compatibility, and the numeric Sonarr id stays in `sourceSeriesId`.
 */

import { describe, expect, it } from 'vitest';
import { type CalendarRawRow, toCalendarItem } from './calendar.js';

const SERIES_UUID = '974d7f8d-cacb-4cfb-b9c9-243d92a2b9e0';
const EPISODE_UUID = '11111111-2222-3333-4444-555555555555';

function makeRow(overrides: Partial<CalendarRawRow> = {}): CalendarRawRow {
    return {
        id: EPISODE_UUID,
        title: 'Cold Harbor',
        media_type: 'episode',
        series_name: 'Starhaven',
        series_id: SERIES_UUID,
        season_number: 2,
        episode_number: 10,
        premiere_date: '2026-08-01T00:00:00Z',
        has_files: true,
        overview: 'The finale.',
        year: 2026,
        source: 'catalog',
        source_series_id: null,
        tmdb_id: 95396,
        ...overrides,
    };
}

describe('toCalendarItem — series identifier split', () => {
    it('puts the series media_items UUID in seriesMediaId', () => {
        const item = toCalendarItem(makeRow());

        expect(item?.context?.series?.id).toBe(SERIES_UUID);
        // Not the episode's own id — the PARENT series row.
        expect(item?.context?.series?.id).not.toBe(item?.id);
    });

    it('carries the series catalogId alongside its handle', () => {
        const item = toCalendarItem(makeRow());

        expect(item?.context?.series?.catalogId).toBe(SERIES_UUID);
        expect(item?.context?.series?.catalogId).toBe(item?.context?.series?.id);
    });

    it('never emits a numeric value in either series field', () => {
        // The whole point of the split: a UUID string is what this producer has,
        // so neither field may be coercible to a Sonarr-style integer id.
        const item = toCalendarItem(makeRow());

        expect(typeof item?.context?.series?.id).toBe('string');
        expect(typeof item?.context?.series?.catalogId).toBe('string');
        expect(Number.isNaN(Number(item?.context?.series?.catalogId))).toBe(true);
    });

    it('keeps the genuine numeric Sonarr id in sourceSeriesId, apart from both', () => {
        const item = toCalendarItem(
            makeRow({ id: null, series_id: null, source: 'monitored', source_series_id: 456 }),
        );

        expect(item?.id).toBe('tmdb:95396:series');
        expect(item?.catalogId).toBeNull();
        expect(item).not.toHaveProperty('sourceSeriesId');
    });

    it('leaves both series fields undefined for a movie row', () => {
        const item = toCalendarItem(
            makeRow({
                media_type: 'movie',
                series_name: null,
                series_id: null,
                season_number: null,
                episode_number: null,
            }),
        );

        expect(item?.type).toBe('movie');
        expect(item?.context?.series?.id).toBeUndefined();
        expect(item?.context?.series?.catalogId).toBeUndefined();
    });
});
