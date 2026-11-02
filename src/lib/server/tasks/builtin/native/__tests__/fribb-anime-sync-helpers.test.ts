// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    buildTmdbLookup,
    buildImdbLookup,
    disambiguate,
    fribbTypeSide,
    lookupFribbEntries,
    fribbAnimeSyncTask,
} from '../fribb-anime-sync.js';
import type { FribbEntry } from '../fribb-anime-sync.js';

describe('fribbTypeSide', () => {
    it('maps MOVIE (any case) to movie-side', () => {
        expect(fribbTypeSide('MOVIE')).toBe('movie');
        expect(fribbTypeSide('Movie')).toBe('movie');
        expect(fribbTypeSide(' movie ')).toBe('movie');
    });

    it('maps every non-movie kind to tv-side (legacy !== "Movie" semantics)', () => {
        for (const t of ['TV', 'OVA', 'ONA', 'SPECIAL', 'Special', 'MUSIC']) {
            expect(fribbTypeSide(t)).toBe('tv');
        }
    });

    it('returns null for unusable types', () => {
        expect(fribbTypeSide(undefined)).toBeNull();
        expect(fribbTypeSide('')).toBeNull();
        expect(fribbTypeSide('UNKNOWN')).toBeNull();
    });
});

describe('buildTmdbLookup — current object shape (the regression)', () => {
    it('indexes a MOVIE entry under movie:<id> from the nested {movie:[…]} bucket', () => {
        // Exact production shape observed for MAL 32281 "Your Name.".
        const entries: FribbEntry[] = [
            { themoviedb_id: { movie: [372058] }, mal_id: 32281, type: 'MOVIE' },
        ];
        const map = buildTmdbLookup(entries);
        expect(lookupFribbEntries(map, 'movie', 372058)).toHaveLength(1);
        // Must NOT leak into the tv side.
        expect(lookupFribbEntries(map, 'tv', 372058)).toHaveLength(0);
    });

    it('indexes a tv bucket under tv:<id> and never cross-matches a movie query', () => {
        // MAL 33674 "No Game No Life Zero" maps to a *tv* tmdb id in Fribb.
        const entries: FribbEntry[] = [
            { themoviedb_id: { tv: [60808] }, mal_id: 33674, type: 'MOVIE' },
        ];
        const map = buildTmdbLookup(entries);
        expect(lookupFribbEntries(map, 'tv', 60808)).toHaveLength(1);
        expect(lookupFribbEntries(map, 'movie', 60808)).toHaveLength(0);
    });

    it('handles a scalar bucket value as well as an array', () => {
        const map = buildTmdbLookup([{ themoviedb_id: { tv: 60808 }, mal_id: 1, type: 'TV' }]);
        expect(lookupFribbEntries(map, 'tv', 60808)).toHaveLength(1);
    });

    it('indexes both buckets when an entry carries a movie and a tv id', () => {
        const map = buildTmdbLookup([
            { themoviedb_id: { movie: [11], tv: [22] }, mal_id: 5, type: 'MOVIE' },
        ]);
        expect(lookupFribbEntries(map, 'movie', 11)).toHaveLength(1);
        expect(lookupFribbEntries(map, 'tv', 22)).toHaveLength(1);
    });

    it('skips entries with a null/empty themoviedb_id', () => {
        const map = buildTmdbLookup([
            { mal_id: 1, type: 'MOVIE' },
            { themoviedb_id: null, mal_id: 2, type: 'MOVIE' },
            { themoviedb_id: { movie: null }, mal_id: 3, type: 'MOVIE' },
            { themoviedb_id: { movie: [100] }, mal_id: 4, type: 'MOVIE' },
        ]);
        expect(map.size).toBe(1);
        expect(lookupFribbEntries(map, 'movie', 100)).toHaveLength(1);
    });
});

describe('buildTmdbLookup — legacy bare-number shape (back-compat)', () => {
    it('indexes a bare number under the side implied by type', () => {
        const map = buildTmdbLookup([
            { themoviedb_id: 100, mal_id: 1, type: 'TV' },
            { themoviedb_id: 200, mal_id: 2, type: 'Movie' },
        ]);
        expect(lookupFribbEntries(map, 'tv', 100)).toHaveLength(1);
        expect(lookupFribbEntries(map, 'movie', 100)).toHaveLength(0);
        expect(lookupFribbEntries(map, 'movie', 200)).toHaveLength(1);
    });

    it('indexes under both sides when the legacy type is unusable', () => {
        const map = buildTmdbLookup([{ themoviedb_id: 300, mal_id: 1, type: 'UNKNOWN' }]);
        expect(lookupFribbEntries(map, 'movie', 300)).toHaveLength(1);
        expect(lookupFribbEntries(map, 'tv', 300)).toHaveLength(1);
    });

    it('groups multiple entries sharing the same (side, id)', () => {
        const map = buildTmdbLookup([
            { themoviedb_id: 100, mal_id: 1, type: 'TV' },
            { themoviedb_id: 100, mal_id: 2, type: 'OVA' },
        ]);
        expect(lookupFribbEntries(map, 'tv', 100)).toHaveLength(2);
    });
});

describe('buildImdbLookup', () => {
    it('indexes entries by imdb id (scalar and array forms)', () => {
        const map = buildImdbLookup([
            { imdb_id: 'tt0169858', mal_id: 32, type: 'MOVIE' },
            { imdb_id: ['tt5914996', 'tt5914997'], mal_id: 33674, type: 'MOVIE' },
        ]);
        expect(map.get('tt0169858')).toHaveLength(1);
        expect(map.get('tt5914996')?.[0].mal_id).toBe(33674);
        expect(map.get('tt5914997')?.[0].mal_id).toBe(33674);
    });

    it('skips entries with no imdb id and empty/non-string ids', () => {
        const map = buildImdbLookup([
            { mal_id: 1, type: 'MOVIE' },
            { imdb_id: null, mal_id: 2, type: 'MOVIE' },
            { imdb_id: '', mal_id: 3, type: 'MOVIE' },
            { imdb_id: 'tt1', mal_id: 4, type: 'MOVIE' },
        ]);
        expect(map.size).toBe(1);
        expect(map.get('tt1')).toHaveLength(1);
    });

    it('groups multiple entries sharing one imdb id', () => {
        const map = buildImdbLookup([
            { imdb_id: 'tt9', mal_id: 1, type: 'MOVIE' },
            { imdb_id: 'tt9', mal_id: 2, type: 'TV' },
        ]);
        expect(map.get('tt9')).toHaveLength(2);
    });
});

describe('disambiguate', () => {
    it('returns null for empty array', () => {
        expect(disambiguate([], 'tv')).toBeNull();
        expect(disambiguate([], 'movie')).toBeNull();
    });

    it('returns the single narrowed entry without inspecting type', () => {
        // buildTmdbLookup already narrowed by side, so a lone entry is used as-is
        // even if its (drifted-case) type field looks tv-ish for a movie query.
        const only: FribbEntry[] = [{ themoviedb_id: { movie: [100] }, mal_id: 1, type: 'MOVIE' }];
        expect(disambiguate(only, 'movie')).toEqual(only[0]);
    });

    it('breaks a tie by preferring the entry whose type matches the side', () => {
        const entries: FribbEntry[] = [
            { themoviedb_id: 100, mal_id: 1, type: 'TV' },
            { themoviedb_id: 100, mal_id: 2, type: 'MOVIE' },
        ];
        expect(disambiguate(entries, 'movie')).toEqual(entries[1]);
        expect(disambiguate(entries, 'tv')).toEqual(entries[0]);
    });

    it('returns null when two entries both match the requested side (ambiguous)', () => {
        const entries: FribbEntry[] = [
            { themoviedb_id: 100, mal_id: 1, type: 'MOVIE' },
            { themoviedb_id: 100, mal_id: 2, type: 'MOVIE' },
        ];
        expect(disambiguate(entries, 'movie')).toBeNull();
    });
});

describe('fribb-anime-sync stage coverage — BUG 5', () => {
    // The task processes both movies and series (SUPPORTED_TYPES = ['movie',
    // 'tv'] in fribb-anime-sync.ts). `coversStages[0].appliesTo` previously only
    // declared 'series', so coverage rows were never seeded for anime movies
    // in a coverage-table-authoritative deployment — findCoverageTableBacklog
    // permanently returned zero movie candidates even though countBacklog()
    // (a plain media_items query) correctly counted them as remaining.
    it('appliesTo includes both movie and series (SDK-canonical vocabulary, not "tv")', () => {
        const stage = fribbAnimeSyncTask.coversStages?.[0];
        expect(stage).toBeDefined();
        expect(stage?.appliesTo).toContain('movie');
        expect(stage?.appliesTo).toContain('series');
        // 'tv' is the media_items.media_type column's storage convention, not
        // a valid SdkMediaType — must never appear in a stage declaration.
        expect(stage?.appliesTo).not.toContain('tv');
    });
});
