// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Genre Service
 */

import { describe, it, expect } from 'vitest';
import { GenreService, type GenreInfo } from './genre.service';

describe('GenreService', () => {
    describe('getMovieGenreName', () => {
        it('returns correct name for known movie genre IDs', () => {
            expect(GenreService.getMovieGenreName(28)).toBe('Action');
            expect(GenreService.getMovieGenreName(35)).toBe('Comedy');
            expect(GenreService.getMovieGenreName(18)).toBe('Drama');
            expect(GenreService.getMovieGenreName(27)).toBe('Horror');
            expect(GenreService.getMovieGenreName(878)).toBe('Science Fiction');
            expect(GenreService.getMovieGenreName(10749)).toBe('Romance');
        });

        it('returns "Unknown" for unknown genre IDs', () => {
            expect(GenreService.getMovieGenreName(99999)).toBe('Unknown');
            expect(GenreService.getMovieGenreName(0)).toBe('Unknown');
        });
    });

    describe('getTVGenreName', () => {
        it('returns correct name for known TV genre IDs', () => {
            expect(GenreService.getTVGenreName(10759)).toBe('Action & Adventure');
            expect(GenreService.getTVGenreName(10765)).toBe('Sci-Fi & Fantasy');
            expect(GenreService.getTVGenreName(10762)).toBe('Kids');
            expect(GenreService.getTVGenreName(10767)).toBe('Talk');
        });

        it('returns "Unknown" for unknown genre IDs', () => {
            expect(GenreService.getTVGenreName(99999)).toBe('Unknown');
        });
    });

    describe('getGenreName', () => {
        it('uses movie genres when mediaType is movie', () => {
            expect(GenreService.getGenreName(28, 'movie')).toBe('Action');
        });

        it('uses TV genres when mediaType is tv', () => {
            expect(GenreService.getGenreName(10759, 'tv')).toBe('Action & Adventure');
        });

        it('falls back to combined lookup without mediaType', () => {
            expect(GenreService.getGenreName(28)).toBe('Action');
            expect(GenreService.getGenreName(10759)).toBe('Action & Adventure');
        });

        it('handles genres that exist in both movie and TV', () => {
            // Animation (16) exists in both
            expect(GenreService.getGenreName(16, 'movie')).toBe('Animation');
            expect(GenreService.getGenreName(16, 'tv')).toBe('Animation');
        });
    });

    describe('getGenreId', () => {
        it('returns ID for known genre name', () => {
            expect(GenreService.getGenreId('Action', 'movie')).toBe(28);
            expect(GenreService.getGenreId('action', 'movie')).toBe(28); // case insensitive
        });

        it('returns ID for TV-specific genre', () => {
            expect(GenreService.getGenreId('Action & Adventure', 'tv')).toBe(10759);
        });

        it('returns undefined for unknown genre name', () => {
            expect(GenreService.getGenreId('Unknown Genre', 'movie')).toBeUndefined();
        });

        it('falls back to combined lookup without mediaType', () => {
            expect(GenreService.getGenreId('Horror')).toBe(27);
        });
    });

    describe('getAllMovieGenres', () => {
        it('returns array of genre info objects', () => {
            const genres = GenreService.getAllMovieGenres();
            expect(Array.isArray(genres)).toBe(true);
            expect(genres.length).toBeGreaterThan(0);
        });

        it('each genre has id and name', () => {
            const genres = GenreService.getAllMovieGenres();
            genres.forEach((genre) => {
                expect(typeof genre.id).toBe('number');
                expect(typeof genre.name).toBe('string');
            });
        });

        it('includes common movie genres', () => {
            const genres = GenreService.getAllMovieGenres();
            const names = genres.map((g) => g.name);
            expect(names).toContain('Action');
            expect(names).toContain('Comedy');
            expect(names).toContain('Drama');
        });
    });

    describe('getAllTVGenres', () => {
        it('returns array of TV genre info objects', () => {
            const genres = GenreService.getAllTVGenres();
            expect(Array.isArray(genres)).toBe(true);
            expect(genres.length).toBeGreaterThan(0);
        });

        it('includes TV-specific genres', () => {
            const genres = GenreService.getAllTVGenres();
            const names = genres.map((g) => g.name);
            expect(names).toContain('Action & Adventure');
            expect(names).toContain('Sci-Fi & Fantasy');
        });
    });

    describe('convertGenreIds', () => {
        it('converts array of IDs to GenreInfo objects', () => {
            const result = GenreService.convertGenreIds([28, 35, 18], 'movie');
            expect(result).toHaveLength(3);
            expect(result[0]).toEqual({ id: 28, name: 'Action' });
            expect(result[1]).toEqual({ id: 35, name: 'Comedy' });
            expect(result[2]).toEqual({ id: 18, name: 'Drama' });
        });

        it('filters out unknown genre IDs', () => {
            const result = GenreService.convertGenreIds([28, 99999, 35], 'movie');
            expect(result).toHaveLength(2);
            expect(result.map((g) => g.name)).not.toContain('Unknown');
        });

        it('handles empty array', () => {
            expect(GenreService.convertGenreIds([])).toEqual([]);
        });
    });

    describe('convertGenreNames', () => {
        it('converts array of names to GenreInfo objects', () => {
            const result = GenreService.convertGenreNames(['Action', 'Comedy'], 'movie');
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ id: 28, name: 'Action' });
            expect(result[1]).toEqual({ id: 35, name: 'Comedy' });
        });

        it('filters out unknown genre names', () => {
            const result = GenreService.convertGenreNames(['Action', 'Unknown Genre'], 'movie');
            expect(result).toHaveLength(1);
        });

        it('handles empty array', () => {
            expect(GenreService.convertGenreNames([])).toEqual([]);
        });
    });

    describe('normalizeGenres', () => {
        it('handles array of GenreInfo objects', () => {
            const input: GenreInfo[] = [
                { id: 28, name: 'Action' },
                { id: 35, name: 'Comedy' },
            ];
            expect(GenreService.normalizeGenres(input)).toEqual(input);
        });

        it('handles array of genre IDs', () => {
            const result = GenreService.normalizeGenres([28, 35], 'movie');
            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('Action');
        });

        it('handles array of genre names', () => {
            const result = GenreService.normalizeGenres(['Action', 'Comedy'], 'movie');
            expect(result).toHaveLength(2);
            expect(result[0].id).toBe(28);
        });

        it('handles null/undefined', () => {
            expect(GenreService.normalizeGenres(null)).toEqual([]);
            expect(GenreService.normalizeGenres(undefined)).toEqual([]);
        });

        it('handles empty array', () => {
            expect(GenreService.normalizeGenres([])).toEqual([]);
        });
    });

    describe('getGenreNames', () => {
        it('extracts names from GenreInfo array', () => {
            const genres: GenreInfo[] = [
                { id: 28, name: 'Action' },
                { id: 35, name: 'Comedy' },
            ];
            expect(GenreService.getGenreNames(genres)).toEqual(['Action', 'Comedy']);
        });
    });

    describe('getGenreIds', () => {
        it('extracts IDs from GenreInfo array', () => {
            const genres: GenreInfo[] = [
                { id: 28, name: 'Action' },
                { id: 35, name: 'Comedy' },
            ];
            expect(GenreService.getGenreIds(genres)).toEqual([28, 35]);
        });
    });

    describe('filterByMediaType', () => {
        it('filters genres to only movie-valid IDs', () => {
            const genres: GenreInfo[] = [
                { id: 28, name: 'Action' }, // valid movie
                { id: 10759, name: 'Action & Adventure' }, // TV only
            ];
            const result = GenreService.filterByMediaType(genres, 'movie');
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe(28);
        });

        it('filters genres to only TV-valid IDs', () => {
            const genres: GenreInfo[] = [
                { id: 10759, name: 'Action & Adventure' }, // valid TV
                { id: 27, name: 'Horror' }, // movie only
            ];
            const result = GenreService.filterByMediaType(genres, 'tv');
            expect(result).toHaveLength(1);
            expect(result[0].id).toBe(10759);
        });
    });

    describe('getPopularGenres', () => {
        it('returns popular movie genres', () => {
            const genres = GenreService.getPopularGenres('movie', 5);
            expect(genres.length).toBeLessThanOrEqual(5);
            expect(genres.every((g) => g.name !== 'Unknown')).toBe(true);
        });

        it('returns popular TV genres', () => {
            const genres = GenreService.getPopularGenres('tv', 5);
            expect(genres.length).toBeLessThanOrEqual(5);
        });

        it('respects limit parameter', () => {
            const genres = GenreService.getPopularGenres('movie', 3);
            expect(genres).toHaveLength(3);
        });
    });

    describe('searchGenres', () => {
        it('finds genres by partial name match', () => {
            const results = GenreService.searchGenres('act', 'movie');
            expect(results.some((g) => g.name === 'Action')).toBe(true);
        });

        it('is case insensitive', () => {
            const results = GenreService.searchGenres('ACTION', 'movie');
            expect(results.some((g) => g.name === 'Action')).toBe(true);
        });

        it('prioritizes starts-with matches', () => {
            const results = GenreService.searchGenres('sci', 'movie');
            // "Science Fiction" should come before any genre that just contains "sci"
            expect(results[0].name).toBe('Science Fiction');
        });

        it('returns empty array for no matches', () => {
            const results = GenreService.searchGenres('xyz123', 'movie');
            expect(results).toEqual([]);
        });

        it('searches all genres without mediaType', () => {
            const results = GenreService.searchGenres('adventure');
            expect(results.length).toBeGreaterThan(0);
        });
    });

    describe('calculateGenreSimilarity', () => {
        it('returns 1 for identical genre sets', () => {
            const genres: GenreInfo[] = [
                { id: 28, name: 'Action' },
                { id: 35, name: 'Comedy' },
            ];
            expect(GenreService.calculateGenreSimilarity(genres, genres)).toBe(1);
        });

        it('returns 0 for completely different genres', () => {
            const genres1: GenreInfo[] = [{ id: 28, name: 'Action' }];
            const genres2: GenreInfo[] = [{ id: 27, name: 'Horror' }];
            expect(GenreService.calculateGenreSimilarity(genres1, genres2)).toBe(0);
        });

        it('calculates Jaccard similarity correctly', () => {
            // Intersection: Action, Sci-Fi (2)
            // Union: Action, Adventure, Sci-Fi, Thriller (4)
            // Jaccard = 2/4 = 0.5
            const genres1: GenreInfo[] = [
                { id: 28, name: 'Action' },
                { id: 12, name: 'Adventure' },
                { id: 878, name: 'Science Fiction' },
            ];
            const genres2: GenreInfo[] = [
                { id: 28, name: 'Action' },
                { id: 878, name: 'Science Fiction' },
                { id: 53, name: 'Thriller' },
            ];
            expect(GenreService.calculateGenreSimilarity(genres1, genres2)).toBeCloseTo(0.5, 2);
        });

        it('returns 0 for empty arrays', () => {
            expect(GenreService.calculateGenreSimilarity([], [])).toBe(0);
            expect(GenreService.calculateGenreSimilarity([{ id: 28, name: 'Action' }], [])).toBe(0);
        });
    });

    describe('getComplementaryGenres', () => {
        it('returns complementary genres for Action', () => {
            const complementary = GenreService.getComplementaryGenres(28, 'movie');
            const ids = complementary.map((g) => g.id);
            // Action pairs with Adventure(12), Thriller(53), Crime(80)
            expect(ids).toContain(12);
            expect(ids).toContain(53);
            expect(ids).toContain(80);
        });

        it('returns empty array for unknown genre', () => {
            const complementary = GenreService.getComplementaryGenres(99999);
            expect(complementary).toEqual([]);
        });

        it('filters out Unknown genres', () => {
            const complementary = GenreService.getComplementaryGenres(28);
            expect(complementary.every((g) => g.name !== 'Unknown')).toBe(true);
        });
    });

    describe('validateGenre', () => {
        it('returns true for valid GenreInfo', () => {
            expect(GenreService.validateGenre({ id: 28, name: 'Action' })).toBe(true);
        });

        it('returns falsy for invalid objects', () => {
            // Note: validateGenre uses short-circuit evaluation, returns falsy for invalid inputs
            expect(GenreService.validateGenre(null)).toBeFalsy();
            expect(GenreService.validateGenre(undefined)).toBeFalsy();
            expect(GenreService.validateGenre({})).toBe(false);
            expect(GenreService.validateGenre({ id: 28 })).toBe(false);
            expect(GenreService.validateGenre({ name: 'Action' })).toBe(false);
        });

        it('returns false for invalid id/name types', () => {
            expect(GenreService.validateGenre({ id: '28', name: 'Action' })).toBe(false);
            expect(GenreService.validateGenre({ id: 28, name: 123 })).toBe(false);
        });

        it('returns false for invalid id values', () => {
            expect(GenreService.validateGenre({ id: 0, name: 'Action' })).toBe(false);
            expect(GenreService.validateGenre({ id: -1, name: 'Action' })).toBe(false);
        });

        it('returns false for empty name', () => {
            expect(GenreService.validateGenre({ id: 28, name: '' })).toBe(false);
        });
    });

    describe('cleanGenreArray', () => {
        it('filters out invalid genres', () => {
            const input: unknown[] = [
                { id: 28, name: 'Action' },
                null,
                { id: 35, name: 'Comedy' },
                { id: 0, name: 'Invalid' },
                undefined,
            ];
            const result = GenreService.cleanGenreArray(input);
            expect(result).toHaveLength(2);
        });

        it('removes duplicates by ID', () => {
            const input: GenreInfo[] = [
                { id: 28, name: 'Action' },
                { id: 28, name: 'Action' },
                { id: 35, name: 'Comedy' },
            ];
            const result = GenreService.cleanGenreArray(input);
            expect(result).toHaveLength(2);
        });

        it('handles empty array', () => {
            expect(GenreService.cleanGenreArray([])).toEqual([]);
        });
    });
});
