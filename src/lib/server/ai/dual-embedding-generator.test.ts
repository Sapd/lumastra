// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for embedding generation robustness
 * Tests handling of undefined values, missing data, and edge cases
 */

import { describe, it, expect } from 'vitest';
import {
    createDiscoveryEmbeddingText as createJellyseerrEmbeddingText,
    createLibraryEmbeddingText as createJellyfinEmbeddingText,
} from './embedding-text-formatter';
import { type JellyseerrMovieData, type LibraryMediaData } from './dual-embedding-generator';

const invalidNumber = undefined as unknown as number;
const invalidString = undefined as unknown as string;

describe('Jellyseerr Embedding Text Generation', () => {
    it('should handle undefined values in genre arrays', () => {
        const movie: JellyseerrMovieData = {
            id: 1,
            tmdbId: 1,
            title: 'Test Movie',
            overview: 'Test overview',
            releaseDate: '2024-01-01',
            genres: [
                { id: 28, name: 'Action' },
                { id: invalidNumber, name: invalidString }, // Problematic
                { id: 35, name: 'Comedy' },
            ],
            voteAverage: 7.0,
            voteCount: 100,
            popularity: 200,
            mediaType: 'movie',
            originalLanguage: 'en',
            originalTitle: 'Test Movie',
            adult: false,
        };

        const result = createJellyseerrEmbeddingText(movie);

        expect(result).toBeDefined();
        expect(result).not.toContain('undefined');
        expect(result).toContain('Action');
        expect(result).toContain('Comedy');
    });

    it('should handle undefined values in cast arrays', () => {
        const movie: JellyseerrMovieData = {
            id: 2,
            tmdbId: 2,
            title: 'Cast Test',
            overview: 'Testing cast',
            releaseDate: '2024-01-01',
            genres: [{ id: 18, name: 'Drama' }],
            voteAverage: 7.0,
            voteCount: 100,
            popularity: 200,
            mediaType: 'movie',
            originalLanguage: 'en',
            originalTitle: 'Cast Test',
            adult: false,
            cast: [
                { id: 1, name: 'Actor One', character: 'Hero', order: 0 },
                {
                    id: 2,
                    name: invalidString,
                    character: 'Villain',
                    order: 1,
                }, // Problematic
                { id: 3, name: 'Actor Three', character: 'Sidekick', order: 2 },
                { id: 4, name: '', character: 'Extra', order: 3 }, // Empty string
            ],
        };

        const result = createJellyseerrEmbeddingText(movie);

        expect(result).toBeDefined();
        expect(result).not.toContain('undefined');
        expect(result).toContain('Actor One');
        expect(result).toContain('Actor Three');
        // Should only have 2 actors
        const castMatch = result.match(/Cast: ([^|]+)/);
        expect(castMatch).toBeDefined();
        if (castMatch) {
            const actors = castMatch[1].split(',').map((s) => s.trim());
            expect(actors.length).toBe(2);
        }
    });

    it('should handle undefined values in crew arrays', () => {
        const movie: JellyseerrMovieData = {
            id: 3,
            tmdbId: 3,
            title: 'Crew Test',
            overview: 'Testing crew',
            releaseDate: '2024-01-01',
            genres: [{ id: 18, name: 'Drama' }],
            voteAverage: 7.0,
            voteCount: 100,
            popularity: 200,
            mediaType: 'movie',
            originalLanguage: 'en',
            originalTitle: 'Crew Test',
            adult: false,
            crew: [
                {
                    id: 1,
                    name: 'Director One',
                    job: 'Director',
                    department: 'Directing',
                },
                {
                    id: 2,
                    name: invalidString,
                    job: 'Producer',
                    department: 'Production',
                }, // Problematic
                {
                    id: 3,
                    name: 'Producer Two',
                    job: invalidString,
                    department: 'Production',
                }, // Problematic
            ],
        };

        const result = createJellyseerrEmbeddingText(movie);

        expect(result).toBeDefined();
        expect(result).not.toContain('undefined');
        expect(result).toContain('Director One');
        // Producer Two should be filtered out because job is undefined
        expect(result).not.toContain('Producer Two');
    });

    it('should handle undefined values in all metadata arrays', () => {
        const movie: JellyseerrMovieData = {
            id: 4,
            tmdbId: 4,
            title: 'Full Test',
            overview: 'Complete test',
            releaseDate: '2024-01-01',
            genres: [{ id: 18, name: 'Drama' }],
            voteAverage: 7.0,
            voteCount: 100,
            popularity: 200,
            mediaType: 'movie',
            originalLanguage: 'en',
            originalTitle: 'Full Test',
            adult: false,
            keywords: [
                { id: 1, name: 'keyword1' },
                { id: 2, name: invalidString }, // Problematic - should be filtered
            ],
            productionCompanies: [
                { id: 1, name: 'Studio A' },
                { id: 2, name: invalidString }, // Problematic - should be filtered
            ],
            spokenLanguages: [
                { iso_639_1: 'en', name: 'English' },
                { iso_639_1: invalidString, name: invalidString }, // Problematic - should be filtered
            ],
            productionCountries: [
                { iso_3166_1: 'US', name: 'United States' },
                { iso_3166_1: invalidString, name: invalidString }, // Problematic - should be filtered
            ],
            networks: [
                { id: 1, name: 'Harborline' },
                { id: 2, name: invalidString }, // Problematic - should be filtered
            ],
        };

        const result = createJellyseerrEmbeddingText(movie);

        expect(result).toBeDefined();
        expect(result).not.toContain('undefined');
        // Keywords ARE included in embedding text
        expect(result).toContain('keyword1');
        // NOTE: Studios, Networks, Countries, Languages are intentionally EXCLUDED
        // from embedding text as "business/production metadata" (see formatEmbeddingText docs)
        // The important thing is that undefined values don't cause crashes
    });

    it('should handle empty arrays gracefully', () => {
        const movie: JellyseerrMovieData = {
            id: 5,
            tmdbId: 5,
            title: 'Empty Arrays',
            overview: 'Testing empty',
            releaseDate: '2024-01-01',
            genres: [],
            voteAverage: 5.0,
            voteCount: 10,
            popularity: 50,
            mediaType: 'movie',
            originalLanguage: 'en',
            originalTitle: 'Empty Arrays',
            adult: false,
            cast: [],
            crew: [],
            keywords: [],
            productionCompanies: [],
            spokenLanguages: [],
            productionCountries: [],
            networks: [],
        };

        const result = createJellyseerrEmbeddingText(movie);

        expect(result).toBeDefined();
        expect(result).not.toContain('undefined');
        expect(result).toContain('Empty Arrays');
        expect(result).toContain('2024');
    });

    it('should handle minimal movie with only required fields', () => {
        const movie: JellyseerrMovieData = {
            id: 6,
            tmdbId: 6,
            title: 'Minimal',
            overview: 'Minimal data',
            releaseDate: '2024-01-01',
            genres: [{ id: 18, name: 'Drama' }],
            voteAverage: 7.0,
            voteCount: 100,
            popularity: 200,
            mediaType: 'movie',
            originalLanguage: 'en',
            originalTitle: 'Minimal',
            adult: false,
        };

        const result = createJellyseerrEmbeddingText(movie);

        expect(result).toBeDefined();
        expect(result).not.toContain('undefined');
        expect(result).toContain('Minimal');
    });

    it('should reproduce The Toxic Avenger scenario', () => {
        const movie: JellyseerrMovieData = {
            id: 1508266,
            tmdbId: 1508266,
            title: 'The Toxic Avenger',
            overview:
                'Infolge eines katastrophalen Giftunfalls mit radioaktivem Müll verwandelt sich der zum Fußabtreter degradierte Hausmeister Winston Gooze (Peter Dinklage) in eine neue Art von Held',
            releaseDate: '2025-03-07',
            genres: [
                { id: 28, name: 'Action' },
                { id: 35, name: 'Comedy' },
                { id: 878, name: 'Science Fiction' },
            ],
            voteAverage: 6.2,
            voteCount: 45,
            popularity: 385,
            runtime: 102,
            mediaType: 'movie',
            originalLanguage: 'en',
            originalTitle: 'The Toxic Avenger',
            adult: false,
            cast: [
                {
                    id: 1,
                    name: 'Peter Dinklage',
                    character: 'Winston Gooze',
                    order: 0,
                },
                {
                    id: 2,
                    name: 'Kevin Bacon',
                    character: 'Bob Garbinger',
                    order: 1,
                },
            ],
            crew: [
                {
                    id: 1,
                    name: 'Macon Blair',
                    job: 'Director',
                    department: 'Directing',
                },
            ],
        };

        const result = createJellyseerrEmbeddingText(movie);

        expect(result).toBeDefined();
        expect(result).not.toContain('undefined');
        expect(result).toContain('The Toxic Avenger');
        expect(result).toContain('Peter Dinklage');
        expect(result).toContain('Kevin Bacon');
        expect(result).toContain('Macon Blair');
        expect(result).toContain('Action');
        expect(result).toContain('Science Fiction');
    });
});

describe('Jellyfin Embedding Text Generation', () => {
    it('should handle undefined values in Jellyfin genre arrays', () => {
        const movie: LibraryMediaData = {
            Id: 'test-1',
            Name: 'Jellyfin Test',
            Overview: 'Testing Jellyfin',
            GenreItems: [
                { Name: 'Action', Id: '1' },
                { Name: invalidString, Id: '2' }, // Problematic
                { Name: 'Drama', Id: '3' },
            ],
            ProductionYear: 2024,
        };

        const result = createJellyfinEmbeddingText(movie);

        expect(result).toBeDefined();
        expect(result).not.toContain('undefined');
        expect(result).toContain('Action');
        expect(result).toContain('Drama');
    });

    it('should handle undefined values in Jellyfin People arrays', () => {
        const movie: LibraryMediaData = {
            Id: 'test-2',
            Name: 'People Test',
            Overview: 'Testing people',
            People: [
                { Name: 'Director One', Type: 'Director' },
                { Name: invalidString, Type: 'Director' }, // Problematic
                { Name: 'Actor One', Type: 'Actor' },
                { Name: '', Type: 'Actor' }, // Empty string
            ],
            ProductionYear: 2024,
        };

        const result = createJellyfinEmbeddingText(movie);

        expect(result).toBeDefined();
        expect(result).not.toContain('undefined');
        expect(result).toContain('Director One');
        expect(result).toContain('Actor One');
    });
});

describe('Database Array Preparation', () => {
    it('should prepare clean arrays for PostgreSQL storage', () => {
        const testData: {
            genres: Array<number | undefined | null>;
            networks: Array<string | undefined | null>;
            keywords: Array<string | undefined | null>;
        } = {
            genres: [1, undefined, 2, null, 3],
            networks: ['Harborline', undefined, 'Lanternbox', ''],
            keywords: ['action', undefined, 'drama', null],
        };

        // Simulate database preparation
        const cleanGenres = testData.genres.filter((id) => id !== undefined && id !== null);
        const cleanNetworks = testData.networks.filter(Boolean);
        const cleanKeywords = testData.keywords.filter(Boolean);

        expect(cleanGenres).toEqual([1, 2, 3]);
        expect(cleanNetworks).toEqual(['Harborline', 'Lanternbox']);
        expect(cleanKeywords).toEqual(['action', 'drama']);

        // Ensure no undefined or null values
        expect(cleanGenres.some((v) => v === undefined || v === null)).toBe(false);
        expect(cleanNetworks.some((v) => v === undefined || v === null || v === '')).toBe(false);
        expect(cleanKeywords.some((v) => v === undefined || v === null || v === '')).toBe(false);
    });
});
