// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Genre-rail ranking.
 *
 * The fixtures in `PROD_LIBRARY` / `HEAVY_LISTENER` are real counts measured on
 * the production library (23,847 tracks, 399 genres), so the ordering assertions
 * here are the actual shipped behaviour, not a toy. If a tuning change moves
 * these, that is a product decision to make deliberately — not a test to relax.
 */

import { describe, it, expect } from 'vitest';
import { rankGenreRails, foldGenres, genreKey } from './genre-ranker.service';
import type { MusicGenreRow } from '../../database/queries/music.queries';

function g(genre: string, track_count: number, album_count: number): MusicGenreRow {
    return { genre, track_count, album_count };
}

/** Real prod counts (album counts approximated where not load-bearing). */
const PROD_LIBRARY: MusicGenreRow[] = [
    g('Rock', 8123, 600),
    g('Electronic', 6255, 500),
    g('Pop', 4794, 400),
    g('Heavy Metal', 3312, 260),
    g('Pop Rock', 2826, 220),
    g('Dance', 2381, 190),
    g('dance', 135, 12),
    g('Hip Hop', 2335, 180),
    g('Hip-Hop', 9, 1),
    g('Trance', 1848, 150),
    g('Hard Rock', 1811, 140),
    g('Power Metal', 1633, 130),
    g('Alternative Rock', 1616, 128),
    g('House', 1611, 126),
    g('Metal', 1721, 135),
    g('Hard Trance', 901, 70),
    g('Classical', 51, 4),
    g('Avant-Garde Metal', 31, 1),
    g('Dans', 112, 5),
];

/** The heavy listener's album-capped weights, as measured on prod. */
const HEAVY_LISTENER = [
    { genre: 'electronic', weight: 58 },
    { genre: 'dance', weight: 50 },
    { genre: 'pop', weight: 40 },
    { genre: 'rock', weight: 33 },
    { genre: 'house', weight: 29 },
    { genre: 'trance', weight: 23 },
    { genre: 'hard rock', weight: 20 },
    { genre: 'hard trance', weight: 20 },
    { genre: 'heavy metal', weight: 13 },
];

describe('genreKey / foldGenres', () => {
    it('folds spelling variants onto one key', () => {
        expect(genreKey('Hip-Hop')).toBe(genreKey('Hip Hop'));
        expect(genreKey('Euro Dance')).toBe(genreKey('Eurodance'));
        expect(genreKey('EDM')).toBe(genreKey('Edm'));
    });

    it('does NOT fold genuinely different genres', () => {
        // Folding these would destroy real signal — the heavy listener plays
        // Rock and Hard Rock at measurably different rates.
        expect(genreKey('Hard Rock')).not.toBe(genreKey('Rock'));
        expect(genreKey('Pop Rock')).not.toBe(genreKey('Pop'));
    });

    it('sums counts and labels the rail with the dominant spelling', () => {
        const folded = foldGenres([g('Dance', 2381, 190), g('dance', 135, 12)]);
        expect(folded).toHaveLength(1);
        expect(folded[0]).toMatchObject({ title: 'Dance', trackCount: 2516, albumCount: 202 });
        expect(folded[0].variants.sort()).toEqual(['dance']);
    });

    it('keeps every variant for the fetch predicate', () => {
        const folded = foldGenres([g('Hip Hop', 2335, 180), g('Hip-Hop', 9, 1)]);
        expect(folded[0].variants.sort()).toEqual(['hip hop', 'hip-hop']);
    });
});

describe('rankGenreRails — with listening history', () => {
    const rails = rankGenreRails({ libraryGenres: PROD_LIBRARY, affinity: HEAVY_LISTENER });

    it('ranks what the viewer plays above what is merely large', () => {
        // Rock is the biggest genre in the library at 8,123 tracks. He plays
        // Electronic/Dance/Pop more, so it does not lead.
        expect(rails[0].title).toBe('Electronic');
        expect(rails.findIndex((r) => r.title === 'Rock')).toBeGreaterThan(0);
    });

    it('lets a small played genre beat a large unplayed one', () => {
        const hardTrance = rails.findIndex((r) => r.title === 'Hard Trance'); // 901 tracks
        const powerMetal = rails.findIndex((r) => r.title === 'Power Metal'); // 1633, unplayed
        expect(hardTrance).toBeGreaterThanOrEqual(0);
        expect(powerMetal === -1 || hardTrance < powerMetal).toBe(true);
    });

    it('drops the 51-track Classical rail the hardcoded list used to show', () => {
        expect(rails.map((r) => r.title)).not.toContain('Classical');
    });

    it('drops a one-album obsession that raw affinity would rank highly', () => {
        // 11 completes, all from a single album, in a 31-track genre.
        expect(rails.map((r) => r.title)).not.toContain('Avant-Garde Metal');
    });

    it('caps rails sharing a head token', () => {
        const rockish = rails.filter((r) => r.title.toLowerCase().endsWith('rock'));
        expect(rockish.length).toBeLessThanOrEqual(2);
    });

    it('returns exactly the requested number of rails', () => {
        expect(rails).toHaveLength(8);
    });
});

describe('rankGenreRails — cold start', () => {
    it('collapses to library ordering with no history, without a special path', () => {
        const rails = rankGenreRails({ libraryGenres: PROD_LIBRARY, affinity: [] });
        expect(rails[0].title).toBe('Rock'); // largest eligible genre
        expect(rails.map((r) => r.title)).not.toContain('Classical');
    });

    it('emits nothing when no genre is big enough for a rail', () => {
        const rails = rankGenreRails({
            libraryGenres: [g('Classical', 51, 4), g('Dans', 112, 5)],
            affinity: [],
        });
        expect(rails).toEqual([]);
    });

    it('survives an empty library', () => {
        expect(rankGenreRails({ libraryGenres: [], affinity: [] })).toEqual([]);
    });
});

describe('rankGenreRails — pinned genres', () => {
    it('shows a pin first even when it fails the eligibility gate', () => {
        const rails = rankGenreRails({
            libraryGenres: PROD_LIBRARY,
            affinity: HEAVY_LISTENER,
            pinnedGenreNames: ['Classical'],
        });
        expect(rails[0].title).toBe('Classical');
    });

    it('does not duplicate a pin that would also rank on its own', () => {
        const rails = rankGenreRails({
            libraryGenres: PROD_LIBRARY,
            affinity: HEAVY_LISTENER,
            pinnedGenreNames: ['Electronic'],
        });
        expect(rails.filter((r) => r.title === 'Electronic')).toHaveLength(1);
    });
});

describe('rankGenreRails — stability', () => {
    it('is deterministic for identical input', () => {
        const a = rankGenreRails({ libraryGenres: PROD_LIBRARY, affinity: HEAVY_LISTENER });
        const b = rankGenreRails({ libraryGenres: PROD_LIBRARY, affinity: HEAVY_LISTENER });
        expect(a.map((r) => r.key)).toEqual(b.map((r) => r.key));
    });

    it('keeps a previously-shown rail that slipped just past the cut', () => {
        const baseline = rankGenreRails({ libraryGenres: PROD_LIBRARY, affinity: [] });
        const dropped = baseline[7].key;
        // A listening burst that would otherwise evict it.
        const withHistory = rankGenreRails({
            libraryGenres: PROD_LIBRARY,
            affinity: [{ genre: 'hard trance', weight: 200 }],
            previousKeys: baseline.map((r) => r.key),
        });
        expect(withHistory.map((r) => r.key)).toContain(dropped);
    });

    it('still drops a rail that falls far past the cut', () => {
        const rails = rankGenreRails({
            libraryGenres: PROD_LIBRARY,
            affinity: HEAVY_LISTENER,
            previousKeys: ['classical'], // ineligible, never ranked
        });
        expect(rails.map((r) => r.key)).not.toContain('classical');
    });
});
