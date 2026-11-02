// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for MediaIdResolver Edge Cases
 *
 * Tests the fixes for non-TMDB composite key parsing (2-part format).
 * The browse-only content tests have been removed as the legacy jellyfin_* tables
 * no longer exist in the UUID-based schema.
 */

import { describe, test, expect } from 'vitest';
import { parseMediaId, validateParsedMediaId } from '$lib/server/utils/media-key-parser.js';

describe('MediaIdResolver Edge Cases', () => {
    describe('parseMediaId - Non-TMDB composite key handling', () => {
        test('accepts 2-part IMDB composite key', () => {
            const parsed = parseMediaId('imdb:tt0137523');

            expect(parsed).toEqual({
                type: 'composite',
                provider: 'imdb',
                externalId: 'tt0137523',
                mediaType: undefined, // No mediaType required for IMDB
            });

            expect(validateParsedMediaId(parsed)).toBe(true);
        });

        test('accepts 2-part TVDB composite key', () => {
            const parsed = parseMediaId('tvdb:12345');

            expect(parsed).toEqual({
                type: 'composite',
                provider: 'tvdb',
                externalId: '12345',
                mediaType: undefined,
            });

            expect(validateParsedMediaId(parsed)).toBe(true);
        });

        test('accepts 2-part Jellyfin composite key', () => {
            const parsed = parseMediaId('jellyfin:550e8400-e29b-41d4-a716-446655440000');

            expect(parsed).toEqual({
                type: 'composite',
                provider: 'jellyfin',
                externalId: '550e8400-e29b-41d4-a716-446655440000',
                mediaType: undefined,
            });

            expect(validateParsedMediaId(parsed)).toBe(true);
        });

        test('rejects 2-part TMDB composite key (requires mediaType)', () => {
            const parsed = parseMediaId('tmdb:550');

            // Should not parse as composite (TMDB requires 3-part format)
            expect(parsed.type).toBe('uuid');
            expect(validateParsedMediaId(parsed)).toBe(false);
        });

        test('accepts 3-part TMDB composite key', () => {
            const parsed = parseMediaId('tmdb:550:movie');

            expect(parsed).toEqual({
                type: 'composite',
                provider: 'tmdb',
                externalId: '550',
                mediaType: 'movie',
            });

            expect(validateParsedMediaId(parsed)).toBe(true);
        });

        test('accepts 3-part IMDB composite key (optional mediaType)', () => {
            const parsed = parseMediaId('imdb:tt0137523:movie');

            expect(parsed).toEqual({
                type: 'composite',
                provider: 'imdb',
                externalId: 'tt0137523',
                mediaType: 'movie',
            });

            expect(validateParsedMediaId(parsed)).toBe(true);
        });

        test('normalizes media type aliases', () => {
            const parsed1 = parseMediaId('tmdb:550:film');
            expect(parsed1.mediaType).toBe('movie');

            const parsed2 = parseMediaId('tmdb:1399:series');
            expect(parsed2.mediaType).toBe('tv');

            const parsed3 = parseMediaId('imdb:tt0137523:show');
            expect(parsed3.mediaType).toBe('tv');
        });

        test('validates parsed IDs correctly', () => {
            // Valid UUIDs
            expect(
                validateParsedMediaId(parseMediaId('550e8400-e29b-41d4-a716-446655440000')),
            ).toBe(true);

            // Valid composite keys
            expect(validateParsedMediaId(parseMediaId('imdb:tt0137523'))).toBe(true);
            expect(validateParsedMediaId(parseMediaId('tmdb:550:movie'))).toBe(true);

            // Invalid formats
            expect(validateParsedMediaId(parseMediaId('550'))).toBe(false); // Bare number
            expect(validateParsedMediaId(parseMediaId('tmdb:550'))).toBe(false); // TMDB without mediaType
            expect(validateParsedMediaId(parseMediaId(''))).toBe(false); // Empty string
        });

        test('rejects invalid provider names', () => {
            // Numeric provider (like "550:movie")
            const parsed1 = parseMediaId('550:movie');
            expect(validateParsedMediaId(parsed1)).toBe(false);

            // Invalid provider name
            const parsed2 = parseMediaId('invalid:123:movie');
            expect(validateParsedMediaId(parsed2)).toBe(false);

            // Valid provider name
            const parsed3 = parseMediaId('imdb:tt0137523:movie');
            expect(validateParsedMediaId(parsed3)).toBe(true);
        });
    });

    describe('edge cases and error handling', () => {
        test('parseMediaId handles empty strings', () => {
            const parsed = parseMediaId('');

            expect(parsed.type).toBe('uuid');
            expect(parsed.uuid).toBeUndefined();
            expect(validateParsedMediaId(parsed)).toBe(false);
        });

        test('parseMediaId handles whitespace', () => {
            const parsed = parseMediaId('   ');

            expect(validateParsedMediaId(parsed)).toBe(false);
        });

        test('parseMediaId trims input', () => {
            const parsed = parseMediaId('  imdb:tt0137523  ');

            expect(parsed).toEqual({
                type: 'composite',
                provider: 'imdb',
                externalId: 'tt0137523',
                mediaType: undefined,
            });

            expect(validateParsedMediaId(parsed)).toBe(true);
        });

        test('parseMediaId handles case-insensitive providers', () => {
            const parsed1 = parseMediaId('IMDB:tt0137523');
            expect(parsed1.provider).toBe('imdb');

            const parsed2 = parseMediaId('TmDb:550:movie');
            expect(parsed2.provider).toBe('tmdb');
        });

        test('parseMediaId handles invalid composite formats', () => {
            // Too many parts
            const parsed1 = parseMediaId('tmdb:550:movie:extra');
            expect(validateParsedMediaId(parsed1)).toBe(false);

            // Single part
            const parsed2 = parseMediaId('justtext');
            expect(validateParsedMediaId(parsed2)).toBe(false);
        });
    });
});
