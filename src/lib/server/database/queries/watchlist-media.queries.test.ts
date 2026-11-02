// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for watchlist-media query module exports
 */

import { describe, it, expect } from 'vitest';
import { getUserWatchlistMedia } from './watchlist-media.queries.js';
import type { WatchlistMediaRow } from './watchlist-media.queries.js';

describe('watchlist-media.queries', () => {
    it('exports getUserWatchlistMedia as a function', () => {
        expect(typeof getUserWatchlistMedia).toBe('function');
    });

    it('WatchlistMediaRow type compiles with expected shape', () => {
        const row: WatchlistMediaRow = {
            primary_ext_id: 'tmdb-550',
            title: 'Quiet Orbit',
            media_type: 'movie',
            media_id: 'uuid-123',
            overview: 'A movie',
            saved_at: '2024-01-01',
            tmdb_rating: 8.4,
            is_available: true,
            can_request: false,
            jellyseerr_id: 123,
            genres: [18, 53],
            release_date: '1999-10-15',
            popularity: 61.4,
            imdb_id: 'tt0137523',
            imdb_rating: 8.8,
            rt_rating: 79,
            actors: ['Bram Fenwick'],
            directors: ['David Fincher'],
            runtime_minutes: 139,
            certification: 'R',
            letterboxd_rating: 4.4,
            letterboxd_votes: 1000,
            rt_audience_score: 96,
            mdblist_score: 88,
            trakt_score: 85,
            mal_score: null,
            year: 1999,
        };
        expect(row.title).toBe('Quiet Orbit');
    });
});
