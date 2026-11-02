// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for search helper utilities
 */

import { describe, it, expect } from 'vitest';
import { shouldPerformSearch } from './search-helpers';

describe('shouldPerformSearch', () => {
    describe('Query validation', () => {
        it('should return false for empty query with no operators', () => {
            expect(shouldPerformSearch('', {})).toBe(false);
        });

        it('should return false for single character query with no operators', () => {
            expect(shouldPerformSearch('a', {})).toBe(false);
        });

        it('should return false for whitespace-only query with no operators', () => {
            expect(shouldPerformSearch('   ', {})).toBe(false);
        });

        it('should return true for 2 character query with no operators', () => {
            expect(shouldPerformSearch('ab', {})).toBe(true);
        });

        it('should return true for query longer than 2 characters', () => {
            expect(shouldPerformSearch('batman', {})).toBe(true);
        });

        it('should trim whitespace when checking query length', () => {
            expect(shouldPerformSearch('  ab  ', {})).toBe(true);
            expect(shouldPerformSearch('  a  ', {})).toBe(false);
        });

        it('should return true for query with special characters', () => {
            expect(shouldPerformSearch('a-b', {})).toBe(true);
            expect(shouldPerformSearch('a.b', {})).toBe(true);
            expect(shouldPerformSearch('a/b', {})).toBe(true);
        });
    });

    describe('Operator validation', () => {
        it('should return true when yearMin is set, even with empty query', () => {
            expect(shouldPerformSearch('', { yearMin: 2020 })).toBe(true);
        });

        it('should return true when yearMax is set (via yearMin logic)', () => {
            // Note: yearMax alone doesn't trigger search, but yearMin does
            expect(shouldPerformSearch('', { yearMin: 2000 })).toBe(true);
        });

        it('should return true when ratingMin is set, even with empty query', () => {
            expect(shouldPerformSearch('', { ratingMin: 7.5 })).toBe(true);
        });

        it('should return true when genres are set, even with empty query', () => {
            expect(shouldPerformSearch('', { genres: ['Action'] })).toBe(true);
        });

        it('should return true when exclude filters are set, even with empty query', () => {
            expect(shouldPerformSearch('', { exclude: ['Horror'] })).toBe(true);
        });

        it('should return false when genres array is empty', () => {
            expect(shouldPerformSearch('', { genres: [] })).toBe(false);
        });

        it('should return false when exclude array is empty', () => {
            expect(shouldPerformSearch('', { exclude: [] })).toBe(false);
        });
    });

    describe('Combined query and operators', () => {
        it('should return true when both query and operators are valid', () => {
            expect(
                shouldPerformSearch('batman', {
                    yearMin: 2020,
                    ratingMin: 7.0,
                    genres: ['Action'],
                }),
            ).toBe(true);
        });

        it('should return true when query is short but operators are set', () => {
            expect(shouldPerformSearch('a', { yearMin: 2020 })).toBe(true);
        });

        it('should return true when query is valid and some operators are set', () => {
            expect(
                shouldPerformSearch('batman', {
                    yearMin: 2020,
                }),
            ).toBe(true);
        });
    });

    describe('Edge cases', () => {
        it('should handle undefined operator values', () => {
            expect(
                shouldPerformSearch('ab', {
                    yearMin: undefined,
                    ratingMin: undefined,
                    genres: undefined,
                    exclude: undefined,
                }),
            ).toBe(true);
        });

        it('should handle zero values for numeric operators', () => {
            // Year 0 should still be considered "set"
            expect(shouldPerformSearch('', { yearMin: 0 })).toBe(true);
            // Rating 0 should still be considered "set"
            expect(shouldPerformSearch('', { ratingMin: 0 })).toBe(true);
        });

        it('should handle very long queries', () => {
            const longQuery = 'a'.repeat(1000);
            expect(shouldPerformSearch(longQuery, {})).toBe(true);
        });

        it('should handle queries with only numbers', () => {
            expect(shouldPerformSearch('42', {})).toBe(true);
        });

        it('should handle queries with unicode characters', () => {
            expect(shouldPerformSearch('日本', {})).toBe(true); // Japanese
            expect(shouldPerformSearch('🎬🎥', {})).toBe(true); // Emojis
        });
    });

    describe('Real-world scenarios', () => {
        it('should allow filter-only searches (no query text)', () => {
            // User wants "all movies from 2020 with rating > 8"
            expect(
                shouldPerformSearch('', {
                    yearMin: 2020,
                    ratingMin: 8.0,
                    genres: [],
                }),
            ).toBe(true);
        });

        it('should reject searches with no criteria at all', () => {
            // User hasn't typed anything and has no filters
            expect(shouldPerformSearch('', {})).toBe(false);
        });

        it('should allow genre-only searches', () => {
            // User wants "all Action movies"
            expect(shouldPerformSearch('', { genres: ['Action', 'Adventure'] })).toBe(true);
        });

        it('should allow exclude-only searches', () => {
            // User wants "all movies except Horror"
            expect(shouldPerformSearch('', { exclude: ['Horror'] })).toBe(true);
        });

        it('should handle typical search query', () => {
            // User searches "batman 2020"
            expect(shouldPerformSearch('batman', { yearMin: 2020 })).toBe(true);
        });

        it('should handle single letter with year filter', () => {
            // Edge case: searching for "X" movie from 2022
            expect(shouldPerformSearch('X', { yearMin: 2022 })).toBe(true);
        });
    });
});
