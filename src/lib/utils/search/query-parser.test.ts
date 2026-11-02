// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for search query-parser
 *
 * Tests operator parsing: year, rating, genre, exclude, and plain text terms.
 */

import { describe, it, expect } from 'vitest';
import { parseSearchOperators } from './query-parser';

describe('parseSearchOperators', () => {
    it('parses plain text only', () => {
        expect(parseSearchOperators('daydream')).toEqual({
            query: 'daydream',
            exclude: [],
        });
    });

    it('parses single year filter', () => {
        expect(parseSearchOperators('year:2010')).toEqual({
            query: '',
            yearMin: 2010,
            yearMax: 2010,
            exclude: [],
        });
    });

    it('parses year range filter', () => {
        expect(parseSearchOperators('year:2020-2024')).toEqual({
            query: '',
            yearMin: 2020,
            yearMax: 2024,
            exclude: [],
        });
    });

    it('parses rating with > operator', () => {
        expect(parseSearchOperators('rating:>8')).toEqual({
            query: '',
            ratingMin: 8,
            exclude: [],
        });
    });

    it('parses rating with >= operator', () => {
        expect(parseSearchOperators('rating:>=7.5')).toEqual({
            query: '',
            ratingMin: 7.5,
            exclude: [],
        });
    });

    it('parses plain rating without operator', () => {
        expect(parseSearchOperators('rating:8')).toEqual({
            query: '',
            ratingMin: 8,
            exclude: [],
        });
    });

    it('parses single genre filter', () => {
        expect(parseSearchOperators('genre:action')).toEqual({
            query: '',
            genres: ['action'],
            exclude: [],
        });
    });

    it('parses multiple genre filters', () => {
        expect(parseSearchOperators('genre:action,comedy')).toEqual({
            query: '',
            genres: ['action', 'comedy'],
            exclude: [],
        });
    });

    it('parses exclude term', () => {
        expect(parseSearchOperators('-horror')).toEqual({
            query: '',
            exclude: ['horror'],
        });
    });

    it('parses combined query with all operators', () => {
        expect(parseSearchOperators('daydream year:2010 rating:>8 -horror')).toEqual({
            query: 'daydream',
            yearMin: 2010,
            yearMax: 2010,
            ratingMin: 8,
            exclude: ['horror'],
        });
    });

    it('returns empty query for empty string', () => {
        expect(parseSearchOperators('')).toEqual({
            query: '',
            exclude: [],
        });
    });

    it('returns empty query for whitespace-only string', () => {
        expect(parseSearchOperators('   ')).toEqual({
            query: '',
            exclude: [],
        });
    });

    it('is case-insensitive for YEAR operator', () => {
        expect(parseSearchOperators('YEAR:2010')).toEqual({
            query: '',
            yearMin: 2010,
            yearMax: 2010,
            exclude: [],
        });
    });

    it('is case-insensitive for RATING operator', () => {
        expect(parseSearchOperators('RATING:>8')).toEqual({
            query: '',
            ratingMin: 8,
            exclude: [],
        });
    });

    it('is case-insensitive for GENRE operator', () => {
        expect(parseSearchOperators('GENRE:ACTION')).toEqual({
            query: '',
            genres: ['action'],
            exclude: [],
        });
    });

    it('normalizes genre values to lowercase', () => {
        expect(parseSearchOperators('genre:AcTiOn')).toEqual({
            query: '',
            genres: ['action'],
            exclude: [],
        });
    });

    it('ignores leading and trailing whitespace on entire input', () => {
        expect(parseSearchOperators('  daydream year:2010  ')).toEqual({
            query: 'daydream',
            yearMin: 2010,
            yearMax: 2010,
            exclude: [],
        });
    });

    it('normalizes exclude terms to lowercase', () => {
        expect(parseSearchOperators('-Horror')).toEqual({
            query: '',
            exclude: ['horror'],
        });
    });

    it('parses multiple exclude terms', () => {
        expect(parseSearchOperators('-horror -romance')).toEqual({
            query: '',
            exclude: ['horror', 'romance'],
        });
    });

    it('treats malformed year operator as plain text', () => {
        expect(parseSearchOperators('year:abc')).toEqual({
            query: 'year:abc',
            exclude: [],
        });
    });

    it('treats malformed rating operator as plain text', () => {
        expect(parseSearchOperators('rating:abc')).toEqual({
            query: 'rating:abc',
            exclude: [],
        });
    });

    it('ignores standalone minus sign', () => {
        expect(parseSearchOperators('-')).toEqual({
            query: '-',
            exclude: [],
        });
    });

    it('handles multiple regular search terms', () => {
        expect(parseSearchOperators('star lanterns')).toEqual({
            query: 'star lanterns',
            exclude: [],
        });
    });

    it('preserves multi-word query with operators interspersed', () => {
        expect(parseSearchOperators('the silent beacon year:2008 genre:action')).toEqual({
            query: 'the silent beacon',
            yearMin: 2008,
            yearMax: 2008,
            genres: ['action'],
            exclude: [],
        });
    });
});
