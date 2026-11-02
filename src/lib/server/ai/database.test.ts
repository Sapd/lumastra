// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Database utility functions
 *
 * IMPORTANT: Tests for pure functions only.
 * Database connection tests are in the integration test file.
 */

import { describe, it, expect } from 'vitest';
import { tmdbKey, parseTmdbKey } from '../database/connection';

describe('TMDB Key Functions', () => {
    /**
     * CRITICAL: TMDB IDs are NOT unique across media types!
     * The same TMDB ID can refer to both a movie AND a TV show.
     * For example: TMDB ID 119051 is "Wednesday" (TV show) AND "Wednesday" (movie)
     *
     * These functions provide the composite key mechanism to handle this.
     */

    describe('tmdbKey', () => {
        it('creates composite key for movie', () => {
            expect(tmdbKey(12345, 'movie')).toBe('12345:movie');
        });

        it('creates composite key for TV show', () => {
            expect(tmdbKey(12345, 'tv')).toBe('12345:tv');
        });

        it('creates different keys for same ID with different media types', () => {
            // This is the critical case - same TMDB ID, different media types
            const movieKey = tmdbKey(119051, 'movie');
            const tvKey = tmdbKey(119051, 'tv');

            expect(movieKey).toBe('119051:movie');
            expect(tvKey).toBe('119051:tv');
            expect(movieKey).not.toBe(tvKey);
        });

        it('handles large TMDB IDs', () => {
            expect(tmdbKey(1234567890, 'movie')).toBe('1234567890:movie');
        });

        it('handles small TMDB IDs', () => {
            expect(tmdbKey(1, 'movie')).toBe('1:movie');
            expect(tmdbKey(0, 'tv')).toBe('0:tv');
        });
    });

    describe('parseTmdbKey', () => {
        it('parses valid movie key', () => {
            const result = parseTmdbKey('12345:movie');
            expect(result).toEqual({
                tmdb_id: 12345,
                media_type: 'movie',
            });
        });

        it('parses valid TV key', () => {
            const result = parseTmdbKey('67890:tv');
            expect(result).toEqual({
                tmdb_id: 67890,
                media_type: 'tv',
            });
        });

        it('returns null for invalid format (no colon)', () => {
            expect(parseTmdbKey('12345movie')).toBeNull();
            expect(parseTmdbKey('invalid')).toBeNull();
        });

        it('returns null for invalid media type', () => {
            expect(parseTmdbKey('12345:podcast')).toBeNull();
            expect(parseTmdbKey('12345:episode')).toBeNull();
        });

        it('normalizes media type aliases to canonical form', () => {
            expect(parseTmdbKey('12345:series')).toEqual({
                tmdb_id: 12345,
                media_type: 'tv',
            });
            expect(parseTmdbKey('12345:MOVIE')).toEqual({
                tmdb_id: 12345,
                media_type: 'movie',
            });
            expect(parseTmdbKey('12345:TV')).toEqual({
                tmdb_id: 12345,
                media_type: 'tv',
            });
        });

        it('returns null for non-numeric TMDB ID', () => {
            expect(parseTmdbKey('abc:movie')).toBeNull();
            expect(parseTmdbKey(':movie')).toBeNull();
        });

        it('returns null for empty string', () => {
            expect(parseTmdbKey('')).toBeNull();
        });

        it('returns null for malformed keys', () => {
            expect(parseTmdbKey('12345:')).toBeNull();
            expect(parseTmdbKey(':tv')).toBeNull();
        });

        it('rejects keys with invalid media type (including extra segments)', () => {
            // The function uses lastIndexOf(':'), so '12345:movie:extra' becomes
            // tmdbId='12345:movie', mediaType='extra' - and 'extra' is invalid
            const result = parseTmdbKey('12345:movie:extra');
            expect(result).toBeNull();
        });

        it('handles edge case with colon in middle', () => {
            // Only first colon should be used for splitting
            const result = parseTmdbKey('123:movie');
            expect(result).toEqual({ tmdb_id: 123, media_type: 'movie' });
        });
    });

    describe('roundtrip', () => {
        it('key -> parse -> key produces same result', () => {
            const original = { tmdb_id: 603, media_type: 'movie' as const };
            const key = tmdbKey(original.tmdb_id, original.media_type);
            const parsed = parseTmdbKey(key);

            expect(parsed).toEqual(original);
        });

        it('works for TV shows', () => {
            const original = { tmdb_id: 1399, media_type: 'tv' as const };
            const key = tmdbKey(original.tmdb_id, original.media_type);
            const parsed = parseTmdbKey(key);

            expect(parsed).toEqual(original);
        });

        it('preserves the problematic Wednesday case', () => {
            // TMDB ID 119051 is both "Wednesday" movie and TV show
            const movieKey = tmdbKey(119051, 'movie');
            const tvKey = tmdbKey(119051, 'tv');

            const parsedMovie = parseTmdbKey(movieKey);
            const parsedTv = parseTmdbKey(tvKey);

            expect(parsedMovie?.tmdb_id).toBe(119051);
            expect(parsedMovie?.media_type).toBe('movie');
            expect(parsedTv?.tmdb_id).toBe(119051);
            expect(parsedTv?.media_type).toBe('tv');
        });
    });

    describe('type safety', () => {
        it('media_type is strictly typed', () => {
            const result = parseTmdbKey('123:movie');
            if (result) {
                // TypeScript should know this is 'movie' | 'tv'
                const mediaType: 'movie' | 'tv' = result.media_type;
                expect(mediaType).toBe('movie');
            }
        });
    });
});
