// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * calendar-feed.service: range validation, the Sonarr/Radarr gap-fill gate and
 * its cache-key agreement, the cache read-through and the per-user mute filter.
 * The v1 row shape (canonicalizeCalendarRow) is checked here too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CalendarRow } from '$lib/server/database/queries/calendar.queries.js';

const h = vi.hoisted(() => ({
    cache: new Map<string, unknown>(),
    config: { SHOW_UNAVAILABLE_MEDIA: true, METADATA_ADDITIONAL_LANGUAGES: [] as string[] },
    unrestricted: true,
    query: vi.fn(),
    exclusions: null as null | {
        itemIds: Set<string>;
        tmdbTv: Set<string>;
        tmdbMovie: Set<string>;
        tvdbTv: Set<string>;
    },
}));

vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { calendar: 'calendar' },
    cacheManager: {
        for: () => ({
            get: async (key: string) => h.cache.get(key) ?? null,
            set: async (key: string, value: unknown) => {
                h.cache.set(key, value);
            },
        }),
    },
}));
vi.mock('$lib/server/config.js', () => ({ config: h.config }));
vi.mock('$lib/server/database/queries/calendar.queries.js', () => ({
    getCalendarItemsFromDb: (...args: unknown[]) => h.query(...args),
}));
vi.mock('$lib/server/database/queries/builders/media-access-boundary.js', () => ({
    isUnrestricted: () => h.unrestricted,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: async () => ({}),
    searchAccessBoundary: () => ({}),
    buildSearchAccessCacheKey: () => (h.unrestricted ? 'all' : 'lib-only'),
}));
vi.mock('$lib/server/utils/excluded-series.js', () => ({
    getExcludedSeriesKeys: async () => h.exclusions,
}));
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: vi.fn() },
}));
vi.mock('$lib/server/utils/translation-overlay.js', () => ({ applyTranslationOverlay: vi.fn() }));

import { loadCalendarFeed, parseCalendarRange } from './calendar-feed.service';
import { canonicalizeCalendarRow } from '$lib/server/api/defs/recommendations/calendar-delegate.js';

const SERIES = '0b9e4c1a-2d3f-4e5a-8b6c-7d8e9f0a1b2c';

function row(over: Partial<CalendarRow> = {}): CalendarRow {
    return {
        id: '1a2b3c4d-1111-4222-8333-944455566677',
        title: 'Pilot',
        media_type: 'episode',
        series_name: 'Lantern Ward',
        series_id: SERIES,
        season_number: 1,
        episode_number: 1,
        premiere_date: '2026-10-20',
        has_files: false,
        overview: null,
        year: 2026,
        source: 'catalog',
        source_series_id: null,
        tmdb_id: null,
        ...over,
    };
}

const user = { userId: 'u1', username: 'alice' } as Parameters<typeof loadCalendarFeed>[1];
const sql = {} as Parameters<typeof loadCalendarFeed>[0];
const start = new Date('2026-10-01T00:00:00Z');
const end = new Date('2026-10-31T23:59:59.999Z');

describe('parseCalendarRange', () => {
    it('normalizes to UTC day bounds', () => {
        const r = parseCalendarRange('2026-10-05T13:00:00Z', '2026-10-06T01:00:00Z');
        expect(r.ok && r.start.toISOString()).toBe('2026-10-05T00:00:00.000Z');
        expect(r.ok && r.end.toISOString()).toBe('2026-10-06T23:59:59.999Z');
    });

    it('rejects an invalid date, a reversed range and a span over 90 days', async () => {
        for (const [s, e] of [
            ['not-a-date', null],
            ['2026-10-10', '2026-10-01'],
            ['2026-01-01', '2026-06-01'],
        ] as const) {
            const r = parseCalendarRange(s, e);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.response.status).toBe(422);
        }
    });
});

describe('loadCalendarFeed', () => {
    beforeEach(() => {
        h.cache.clear();
        h.query.mockReset();
        h.query.mockResolvedValue([row()]);
        h.config.SHOW_UNAVAILABLE_MEDIA = true;
        h.unrestricted = true;
        h.exclusions = null;
    });

    it('gap-fills for an unrestricted user and keys the cache with :mon', async () => {
        await loadCalendarFeed(sql, user, start, end);
        expect(h.query.mock.calls[0][4]).toBe(true);
        expect([...h.cache.keys()]).toEqual(['calendar:v4:2026-10-01:2026-10-31:all:mon']);
    });

    it('never gap-fills for a restricted user, even with the toggle on', async () => {
        h.unrestricted = false;
        await loadCalendarFeed(sql, user, start, end);
        expect(h.query.mock.calls[0][4]).toBe(false);
        expect([...h.cache.keys()][0].endsWith(':mon')).toBe(false);
    });

    it('follows the raw SHOW_UNAVAILABLE_MEDIA toggle', async () => {
        h.config.SHOW_UNAVAILABLE_MEDIA = false;
        await loadCalendarFeed(sql, user, start, end);
        expect(h.query.mock.calls[0][4]).toBe(false);
    });

    it('filters cached catalog stubs at read time without changing the saved range', async () => {
        h.config.SHOW_UNAVAILABLE_MEDIA = false;
        const available = row({ has_files: true });
        const hidden = row({ id: 'hidden' });
        h.query.mockResolvedValue([available, hidden]);
        expect(await loadCalendarFeed(sql, user, start, end)).toEqual([available]);
        expect(await loadCalendarFeed(sql, user, start, end)).toEqual([available]);
        expect(h.query).toHaveBeenCalledTimes(1);
        expect([...h.cache.values()]).toEqual([[available, hidden]]);
    });

    it('reads through the cache', async () => {
        await loadCalendarFeed(sql, user, start, end);
        await loadCalendarFeed(sql, user, start, end);
        expect(h.query).toHaveBeenCalledTimes(1);
    });

    it('drops the rows the user muted, after the cache', async () => {
        const other = row({ id: '9f8e7d6c-1111-4222-8333-944455566677', series_id: null });
        h.query.mockResolvedValue([row(), other]);
        h.exclusions = {
            itemIds: new Set([SERIES]),
            tmdbTv: new Set(),
            tmdbMovie: new Set(),
            tvdbTv: new Set(),
        };
        const rows = await loadCalendarFeed(sql, user, start, end);
        expect(rows).toEqual([other]);
        expect((h.cache.values().next().value as CalendarRow[]).length).toBe(2);
    });
});

describe('canonicalizeCalendarRow (v1)', () => {
    it('emits episodes as previews with a resolvable series handle and typed coordinates', () => {
        const out = canonicalizeCalendarRow(row({ source: 'monitored', id: null, tmdb_id: 7 }));
        expect(out).toMatchObject({
            type: 'episode',
            monitored: true,
            hasFile: false,
            context: {
                series: { id: SERIES, title: 'Lantern Ward' },
                seasonNumber: 1,
                episodeNumber: 1,
                airDate: '2026-10-20',
            },
        });
        expect(out?.id).toBeTruthy();
    });
});
