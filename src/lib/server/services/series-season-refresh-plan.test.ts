// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    FULL_REFRESH_MAX_AGE_DAYS,
    FULL_REFRESH_SPREAD_DAYS,
    isFullRefreshDue,
    selectSeasonsToRefresh,
    type SeasonListing,
    type StoredSeasonState,
} from './series-season-refresh-plan.js';

/** Season 0 + seasons 1..n, each 10 episodes aired in its own year. */
function longRunning(n: number): {
    listing: SeasonListing[];
    stored: Map<number, StoredSeasonState>;
} {
    const listing: SeasonListing[] = [
        { season_number: 0, episode_count: 3, air_date: '2010-01-01' },
    ];
    const stored = new Map<number, StoredSeasonState>([
        [0, { episodeCount: 3, premiereDate: '2010-01-01' }],
    ]);
    for (let s = 1; s <= n; s++) {
        const air_date = `${2010 + s}-09-01`;
        listing.push({ season_number: s, episode_count: 10, air_date });
        stored.set(s, { episodeCount: 10, premiereDate: air_date });
    }
    return { listing, stored };
}

describe('selectSeasonsToRefresh (routine series re-sync)', () => {
    it('(a) long-running airing show, nothing changed: only the latest two seasons', () => {
        const { listing, stored } = longRunning(15);
        expect([...selectSeasonsToRefresh(listing, stored, false)].sort((x, y) => x - y)).toEqual([
            14, 15,
        ]);
    });

    it('(b) a new season appears: it is fetched (never stored) next to the latest', () => {
        const { listing, stored } = longRunning(15);
        listing.push({ season_number: 16, episode_count: 8, air_date: '2026-09-01' });
        expect([...selectSeasonsToRefresh(listing, stored, false)].sort((x, y) => x - y)).toEqual([
            15, 16,
        ]);
    });

    it('(b2) a new season that is NOT among the latest two is still fetched, because it is unknown', () => {
        const { listing, stored } = longRunning(5);
        stored.delete(2);
        expect(selectSeasonsToRefresh(listing, stored, false).has(2)).toBe(true);
    });

    it('(c) an older season gained an episode: that season is refetched', () => {
        const { listing, stored } = longRunning(15);
        listing.find((s) => s.season_number === 7)!.episode_count = 11;
        expect([...selectSeasonsToRefresh(listing, stored, false)].sort((x, y) => x - y)).toEqual([
            7, 14, 15,
        ]);
    });

    it('(c2) an older season whose air date moved is refetched', () => {
        const { listing, stored } = longRunning(15);
        listing.find((s) => s.season_number === 3)!.air_date = '2013-10-01';
        expect(selectSeasonsToRefresh(listing, stored, false).has(3)).toBe(true);
    });

    it('does not refetch unchanged specials, but does when their count changes', () => {
        const { listing, stored } = longRunning(5);
        expect(selectSeasonsToRefresh(listing, stored, false).has(0)).toBe(false);
        listing[0].episode_count = 4;
        expect(selectSeasonsToRefresh(listing, stored, false).has(0)).toBe(true);
    });

    it('fetches every season when a file-backed episode has no TMDB identity', () => {
        const { listing, stored } = longRunning(15);
        expect(selectSeasonsToRefresh(listing, stored, true).size).toBe(16);
    });

    it('fetches everything for a series with nothing stored yet', () => {
        const { listing } = longRunning(4);
        expect(selectSeasonsToRefresh(listing, new Map(), false).size).toBe(5);
    });

    it('fetches every season on the series full-refresh day, even when nothing changed', () => {
        const { listing, stored } = longRunning(15);
        expect(selectSeasonsToRefresh(listing, stored, false, true).size).toBe(16);
        expect(selectSeasonsToRefresh(listing, stored, false, false).size).toBe(2);
    });
});

describe('isFullRefreshDue (window since the last full season fetch)', () => {
    const DAY = 86_400_000;
    const now = Date.UTC(2026, 9, 29);
    const ids = Array.from({ length: 200 }, (_, i) => `series-${i}`);

    it('is due when no full fetch was ever recorded or the stamp is unreadable', () => {
        expect(isFullRefreshDue('a', null, now)).toBe(true);
        expect(isFullRefreshDue('a', Number.NaN, now)).toBe(true);
    });

    it('is not due shortly after a full fetch, for any series', () => {
        for (const id of ids) {
            expect(isFullRefreshDue(id, now - 10 * DAY, now)).toBe(false);
            expect(isFullRefreshDue(id, now - 1000, now)).toBe(false);
        }
    });

    it('is due for every series once the stamp is older than the maximum age, however rarely it syncs', () => {
        for (const id of ids) {
            expect(isFullRefreshDue(id, now - FULL_REFRESH_MAX_AGE_DAYS * DAY, now)).toBe(true);
            expect(isFullRefreshDue(id, now - 400 * DAY, now)).toBe(true);
        }
    });

    it('spreads the threshold over the last days of the window by series id (stable per id)', () => {
        const age = (FULL_REFRESH_MAX_AGE_DAYS - FULL_REFRESH_SPREAD_DAYS + 1) * DAY;
        const dueNow = ids.filter((id) => isFullRefreshDue(id, now - age, now));
        // some, but not all, series are due at the earliest point of the window
        expect(dueNow.length).toBeGreaterThan(0);
        expect(dueNow.length).toBeLessThan(ids.length);
        expect(ids.filter((id) => isFullRefreshDue(id, now - age, now))).toEqual(dueNow);
    });
});
