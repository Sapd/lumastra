// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for media key parser utilities
 *
 * Tests parsing of media identifiers in various formats:
 * - UUID format (primary)
 * - Composite key format: provider:id:mediaType
 */

import { describe, it, expect } from 'vitest';
import {
    isUuid,
    normalizeUuid,
    isValidMediaType,
    normalizeMediaType,
    parseMediaId,
    validateParsedMediaId,
    createCompositeKey,
    parseMediaTypeParam,
    parseMediaIdFromParams,
    describeParsedMediaId,
} from './media-key-parser';

// =============================================================================
// isUuid
// =============================================================================

describe('isUuid', () => {
    describe('valid UUIDs', () => {
        it('recognizes standard UUID v4 format', () => {
            expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
        });

        it('recognizes UUID with uppercase letters', () => {
            expect(isUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
        });

        it('recognizes UUID with mixed case', () => {
            expect(isUuid('550e8400-E29B-41d4-A716-446655440000')).toBe(true);
        });

        it('recognizes various valid UUIDs', () => {
            expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
            expect(isUuid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(true);
            expect(isUuid('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
        });

        it('recognizes Jellyfin UUIDs without dashes', () => {
            expect(isUuid('0c0bcb2a78a54b0be51f45d97f9e4d1c')).toBe(true);
            expect(isUuid('550e8400e29b41d4a716446655440000')).toBe(true);
            expect(isUuid('00000000000000000000000000000000')).toBe(true);
            expect(isUuid('ffffffffffffffffffffffffffffffff')).toBe(true);
        });

        it('recognizes Jellyfin UUIDs with mixed case', () => {
            expect(isUuid('0C0BCB2A78A54B0BE51F45D97F9E4D1C')).toBe(true);
            expect(isUuid('0c0bcb2A78a54B0Be51f45d97f9e4d1C')).toBe(true);
        });
    });

    describe('invalid UUIDs', () => {
        it('rejects empty string', () => {
            expect(isUuid('')).toBe(false);
        });

        it('rejects bare numeric IDs', () => {
            expect(isUuid('550')).toBe(false);
            expect(isUuid('12345')).toBe(false);
            expect(isUuid('123456789')).toBe(false);
        });

        it('rejects UUID with wrong hyphen positions', () => {
            expect(isUuid('550e8400e29b-41d4-a716-446655440000')).toBe(false);
            expect(isUuid('550e-8400-e29b-41d4a716-446655440000')).toBe(false);
        });

        it('rejects UUID with wrong length', () => {
            expect(isUuid('550e8400-e29b-41d4-a716-44665544000')).toBe(false); // Too short
            expect(isUuid('550e8400-e29b-41d4-a716-4466554400001')).toBe(false); // Too long
        });

        it('rejects UUID with invalid characters', () => {
            expect(isUuid('550e8400-e29b-41d4-a716-44665544000g')).toBe(false);
            expect(isUuid('550e8400-e29b-41d4-a716-44665544000!')).toBe(false);
            expect(isUuid('550e8400-e29b-41d4-a716-44665544 000')).toBe(false);
        });

        it('rejects composite key format', () => {
            expect(isUuid('tmdb:550:movie')).toBe(false);
        });
    });
});

// =============================================================================
// normalizeUuid
// =============================================================================

describe('normalizeUuid', () => {
    describe('UUIDs with dashes', () => {
        it('returns standard UUID unchanged (lowercased)', () => {
            expect(normalizeUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(
                '550e8400-e29b-41d4-a716-446655440000',
            );
        });

        it('lowercases uppercase UUIDs', () => {
            expect(normalizeUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(
                '550e8400-e29b-41d4-a716-446655440000',
            );
        });

        it('lowercases mixed-case UUIDs', () => {
            expect(normalizeUuid('550e8400-E29B-41d4-A716-446655440000')).toBe(
                '550e8400-e29b-41d4-a716-446655440000',
            );
        });
    });

    describe('Jellyfin UUIDs without dashes', () => {
        it('adds dashes to dashless UUID', () => {
            expect(normalizeUuid('0c0bcb2a78a54b0be51f45d97f9e4d1c')).toBe(
                '0c0bcb2a-78a5-4b0b-e51f-45d97f9e4d1c',
            );
        });

        it('adds dashes and lowercases uppercase Jellyfin UUID', () => {
            expect(normalizeUuid('0C0BCB2A78A54B0BE51F45D97F9E4D1C')).toBe(
                '0c0bcb2a-78a5-4b0b-e51f-45d97f9e4d1c',
            );
        });

        it('handles all-zeros dashless UUID', () => {
            expect(normalizeUuid('00000000000000000000000000000000')).toBe(
                '00000000-0000-0000-0000-000000000000',
            );
        });

        it('handles all-Fs dashless UUID', () => {
            expect(normalizeUuid('ffffffffffffffffffffffffffffffff')).toBe(
                'ffffffff-ffff-ffff-ffff-ffffffffffff',
            );
        });

        it('adds dashes to real Jellyfin example UUID', () => {
            expect(normalizeUuid('550e8400e29b41d4a716446655440000')).toBe(
                '550e8400-e29b-41d4-a716-446655440000',
            );
        });
    });

    describe('invalid input', () => {
        it('returns invalid UUID unchanged', () => {
            expect(normalizeUuid('not-a-uuid')).toBe('not-a-uuid');
            expect(normalizeUuid('12345')).toBe('12345');
            expect(normalizeUuid('tmdb:550:movie')).toBe('tmdb:550:movie');
        });
    });
});

// =============================================================================
// isValidMediaType
// =============================================================================

describe('isValidMediaType', () => {
    describe('valid media types', () => {
        it('recognizes movie', () => {
            expect(isValidMediaType('movie')).toBe(true);
        });

        it('recognizes tv', () => {
            expect(isValidMediaType('tv')).toBe(true);
        });

        it('recognizes episode', () => {
            expect(isValidMediaType('episode')).toBe(true);
        });

        it('recognizes season', () => {
            expect(isValidMediaType('season')).toBe(true);
        });

        it('is case-insensitive', () => {
            expect(isValidMediaType('MOVIE')).toBe(true);
            expect(isValidMediaType('TV')).toBe(true);
            expect(isValidMediaType('Movie')).toBe(true);
            expect(isValidMediaType('Tv')).toBe(true);
        });
    });

    describe('invalid media types', () => {
        it('rejects empty string', () => {
            expect(isValidMediaType('')).toBe(false);
        });

        it('rejects aliases (use normalizeMediaType for those)', () => {
            expect(isValidMediaType('series')).toBe(false);
            expect(isValidMediaType('show')).toBe(false);
            expect(isValidMediaType('film')).toBe(false);
        });

        it('rejects invalid types', () => {
            expect(isValidMediaType('audio')).toBe(false);
            expect(isValidMediaType('audiobook')).toBe(false);
            expect(isValidMediaType('invalid')).toBe(false);
            expect(isValidMediaType('movies')).toBe(false);
        });
    });
});

// =============================================================================
// normalizeMediaType
// =============================================================================

describe('normalizeMediaType', () => {
    describe('direct media types', () => {
        it('normalizes movie to movie', () => {
            expect(normalizeMediaType('movie')).toBe('movie');
            expect(normalizeMediaType('MOVIE')).toBe('movie');
            expect(normalizeMediaType('Movie')).toBe('movie');
        });

        it('normalizes tv to tv', () => {
            expect(normalizeMediaType('tv')).toBe('tv');
            expect(normalizeMediaType('TV')).toBe('tv');
            expect(normalizeMediaType('Tv')).toBe('tv');
        });

        it('normalizes episode to episode', () => {
            expect(normalizeMediaType('episode')).toBe('episode');
            expect(normalizeMediaType('EPISODE')).toBe('episode');
        });

        it('normalizes season to season', () => {
            expect(normalizeMediaType('season')).toBe('season');
            expect(normalizeMediaType('SEASON')).toBe('season');
        });
    });

    describe('aliases', () => {
        it('normalizes series to tv', () => {
            expect(normalizeMediaType('series')).toBe('tv');
            expect(normalizeMediaType('SERIES')).toBe('tv');
            expect(normalizeMediaType('Series')).toBe('tv');
        });

        it('normalizes show to tv', () => {
            expect(normalizeMediaType('show')).toBe('tv');
            expect(normalizeMediaType('SHOW')).toBe('tv');
            expect(normalizeMediaType('Show')).toBe('tv');
        });

        it('normalizes film to movie', () => {
            expect(normalizeMediaType('film')).toBe('movie');
            expect(normalizeMediaType('FILM')).toBe('movie');
            expect(normalizeMediaType('Film')).toBe('movie');
        });
    });

    describe('invalid types', () => {
        it('returns null for invalid media types', () => {
            expect(normalizeMediaType('invalid')).toBeNull();
            expect(normalizeMediaType('audio')).toBeNull();
            expect(normalizeMediaType('audiobook')).toBeNull();
            expect(normalizeMediaType('movies')).toBeNull();
            expect(normalizeMediaType('tvshow')).toBeNull();
        });

        it('returns null for empty string', () => {
            expect(normalizeMediaType('')).toBeNull();
        });
    });
});

// =============================================================================
// parseMediaId
// =============================================================================

describe('parseMediaId', () => {
    describe('valid UUID format', () => {
        it('parses standard UUID', () => {
            const result = parseMediaId('550e8400-e29b-41d4-a716-446655440000');
            expect(result).toEqual({
                type: 'uuid',
                uuid: '550e8400-e29b-41d4-a716-446655440000',
            });
        });

        it('normalizes UUID to lowercase', () => {
            const result = parseMediaId('550E8400-E29B-41D4-A716-446655440000');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
        });

        it('trims whitespace around UUID', () => {
            const result = parseMediaId('  550e8400-e29b-41d4-a716-446655440000  ');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
        });
    });

    describe('valid composite key format', () => {
        it('parses tmdb:id:movie format', () => {
            const result = parseMediaId('tmdb:550:movie');
            expect(result).toEqual({
                type: 'composite',
                provider: 'tmdb',
                externalId: '550',
                mediaType: 'movie',
            });
        });

        it('parses tmdb:id:tv format', () => {
            const result = parseMediaId('tmdb:1399:tv');
            expect(result).toEqual({
                type: 'composite',
                provider: 'tmdb',
                externalId: '1399',
                mediaType: 'tv',
            });
        });

        it('parses with media type aliases', () => {
            const seriesResult = parseMediaId('tmdb:1399:series');
            expect(seriesResult.type).toBe('composite');
            expect(seriesResult.mediaType).toBe('tv');

            const showResult = parseMediaId('tmdb:1399:show');
            expect(showResult.type).toBe('composite');
            expect(showResult.mediaType).toBe('tv');

            const filmResult = parseMediaId('tmdb:550:film');
            expect(filmResult.type).toBe('composite');
            expect(filmResult.mediaType).toBe('movie');
        });

        it('handles different providers', () => {
            const imdbResult = parseMediaId('imdb:tt0111161:movie');
            expect(imdbResult).toEqual({
                type: 'composite',
                provider: 'imdb',
                externalId: 'tt0111161',
                mediaType: 'movie',
            });

            const tvdbResult = parseMediaId('tvdb:81189:tv');
            expect(tvdbResult).toEqual({
                type: 'composite',
                provider: 'tvdb',
                externalId: '81189',
                mediaType: 'tv',
            });
        });

        it('normalizes provider to lowercase', () => {
            const result = parseMediaId('TMDB:550:movie');
            expect(result.provider).toBe('tmdb');
        });

        it('handles episode and season media types', () => {
            const episodeResult = parseMediaId('tmdb:12345:episode');
            expect(episodeResult.type).toBe('composite');
            expect(episodeResult.mediaType).toBe('episode');

            const seasonResult = parseMediaId('tmdb:12345:season');
            expect(seasonResult.type).toBe('composite');
            expect(seasonResult.mediaType).toBe('season');
        });
    });

    describe('rejected formats - bare numeric ID', () => {
        it('rejects bare numeric ID without provider', () => {
            const result = parseMediaId('550');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });

        it('rejects large bare numeric ID', () => {
            const result = parseMediaId('123456789');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });
    });

    describe('rejected formats - short format (id:mediaType)', () => {
        it('rejects short format without provider', () => {
            const result = parseMediaId('550:movie');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });

        it('rejects short format with tv type', () => {
            const result = parseMediaId('1399:tv');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });
    });

    describe('rejected formats - invalid composite', () => {
        it('rejects composite with missing media type', () => {
            const result = parseMediaId('tmdb:550');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });

        it('rejects composite with invalid media type', () => {
            const result = parseMediaId('tmdb:550:invalid');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });

        it('rejects composite with too many parts', () => {
            const result = parseMediaId('tmdb:550:movie:extra');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });

        it('rejects composite with empty provider', () => {
            const result = parseMediaId(':550:movie');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });

        it('rejects composite with empty external ID', () => {
            const result = parseMediaId('tmdb::movie');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });
    });

    describe('invalid input', () => {
        it('handles empty string', () => {
            const result = parseMediaId('');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });

        it('handles whitespace only', () => {
            const result = parseMediaId('   ');
            expect(result.type).toBe('uuid');
            // Whitespace trims to empty string, which is not a valid UUID
            expect(result.uuid).toBeUndefined();
            // validateParsedMediaId returns false for missing uuid
            expect(validateParsedMediaId(result)).toBe(false);
        });

        it('handles null-like values via type coercion', () => {
            // @ts-expect-error Testing invalid input
            const nullResult = parseMediaId(null);
            expect(nullResult.type).toBe('uuid');
            expect(nullResult.uuid).toBeUndefined();

            // @ts-expect-error Testing invalid input
            const undefinedResult = parseMediaId(undefined);
            expect(undefinedResult.type).toBe('uuid');
            expect(undefinedResult.uuid).toBeUndefined();
        });
    });

    describe('non-numeric string without colons', () => {
        it('rejects invalid non-UUID strings', () => {
            const result = parseMediaId('some-random-string');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });

        it('rejects strings that look like IDs but are not valid UUIDs', () => {
            const result = parseMediaId('invalid-id');
            expect(result.type).toBe('uuid');
            expect(result.uuid).toBeUndefined();
            expect(validateParsedMediaId(result)).toBe(false);
        });
    });

    describe('deprecated queryMediaType parameter', () => {
        it('ignores the second parameter', () => {
            // The queryMediaType parameter is deprecated and ignored
            const result = parseMediaId('tmdb:550:movie', 'tv');
            expect(result.mediaType).toBe('movie'); // Not 'tv'
        });
    });
});

// =============================================================================
// validateParsedMediaId
// =============================================================================

describe('validateParsedMediaId', () => {
    describe('UUID type validation', () => {
        it('returns true for UUID type with uuid set', () => {
            expect(
                validateParsedMediaId({
                    type: 'uuid',
                    uuid: '550e8400-e29b-41d4-a716-446655440000',
                }),
            ).toBe(true);
        });

        it('returns false for UUID type without uuid', () => {
            expect(validateParsedMediaId({ type: 'uuid' })).toBe(false);
        });

        it('returns false for UUID type with empty uuid', () => {
            expect(validateParsedMediaId({ type: 'uuid', uuid: '' })).toBe(false);
        });
    });

    describe('composite type validation', () => {
        it('returns true for composite with all required fields', () => {
            expect(
                validateParsedMediaId({
                    type: 'composite',
                    provider: 'tmdb',
                    externalId: '550',
                    mediaType: 'movie',
                }),
            ).toBe(true);
        });

        it('returns false for composite without provider', () => {
            expect(
                validateParsedMediaId({
                    type: 'composite',
                    externalId: '550',
                    mediaType: 'movie',
                }),
            ).toBe(false);
        });

        it('returns false for composite without externalId', () => {
            expect(
                validateParsedMediaId({
                    type: 'composite',
                    provider: 'tmdb',
                    mediaType: 'movie',
                }),
            ).toBe(false);
        });

        it('returns false for composite without mediaType', () => {
            expect(
                validateParsedMediaId({
                    type: 'composite',
                    provider: 'tmdb',
                    externalId: '550',
                }),
            ).toBe(false);
        });

        it('returns false for composite with empty strings', () => {
            expect(
                validateParsedMediaId({
                    type: 'composite',
                    provider: '',
                    externalId: '550',
                    mediaType: 'movie',
                }),
            ).toBe(false);

            expect(
                validateParsedMediaId({
                    type: 'composite',
                    provider: 'tmdb',
                    externalId: '',
                    mediaType: 'movie',
                }),
            ).toBe(false);
        });
    });

    describe('integration with parseMediaId', () => {
        it('validates all parsed valid UUIDs', () => {
            const parsed = parseMediaId('550e8400-e29b-41d4-a716-446655440000');
            expect(validateParsedMediaId(parsed)).toBe(true);
        });

        it('validates all parsed valid composite keys', () => {
            const parsed = parseMediaId('tmdb:550:movie');
            expect(validateParsedMediaId(parsed)).toBe(true);
        });

        it('rejects all parsed invalid inputs', () => {
            expect(validateParsedMediaId(parseMediaId(''))).toBe(false);
            expect(validateParsedMediaId(parseMediaId('550'))).toBe(false);
            expect(validateParsedMediaId(parseMediaId('550:movie'))).toBe(false);
            expect(validateParsedMediaId(parseMediaId('tmdb:550'))).toBe(false);
        });
    });
});

// =============================================================================
// createCompositeKey
// =============================================================================

describe('createCompositeKey', () => {
    describe('basic key creation', () => {
        it('creates key with string externalId', () => {
            expect(createCompositeKey('tmdb', '550', 'movie')).toBe('tmdb:550:movie');
        });

        it('creates key with numeric externalId', () => {
            expect(createCompositeKey('tmdb', 550, 'movie')).toBe('tmdb:550:movie');
        });

        it('creates key for TV show', () => {
            expect(createCompositeKey('tmdb', '1399', 'series')).toBe('tmdb:1399:series');
        });

        it('creates key for episode', () => {
            expect(createCompositeKey('tmdb', '12345', 'episode')).toBe('tmdb:12345:episode');
        });

        it('creates key for season', () => {
            expect(createCompositeKey('tmdb', '67890', 'season')).toBe('tmdb:67890:season');
        });
    });

    describe('different providers', () => {
        it('creates IMDB key', () => {
            expect(createCompositeKey('imdb', 'tt0111161', 'movie')).toBe('imdb:tt0111161:movie');
        });

        it('creates TVDB key', () => {
            expect(createCompositeKey('tvdb', '81189', 'series')).toBe('tvdb:81189:series');
        });
    });

    describe('round-trip with parseMediaId', () => {
        it('creates key that can be parsed back', () => {
            const key = createCompositeKey('tmdb', '550', 'movie');
            const parsed = parseMediaId(key);

            expect(parsed.type).toBe('composite');
            expect(parsed.provider).toBe('tmdb');
            expect(parsed.externalId).toBe('550');
            expect(parsed.mediaType).toBe('movie');
        });
    });
});

// =============================================================================
// parseMediaTypeParam
// =============================================================================

describe('parseMediaTypeParam', () => {
    it('returns normalized media type for valid input', () => {
        expect(parseMediaTypeParam('movie')).toBe('movie');
        expect(parseMediaTypeParam('tv')).toBe('tv');
        expect(parseMediaTypeParam('series')).toBe('tv');
        expect(parseMediaTypeParam('film')).toBe('movie');
    });

    it('returns null for invalid input', () => {
        expect(parseMediaTypeParam('invalid')).toBeNull();
        expect(parseMediaTypeParam('')).toBeNull();
    });

    it('returns null for null input', () => {
        expect(parseMediaTypeParam(null)).toBeNull();
    });
});

// =============================================================================
// parseMediaIdFromParams
// =============================================================================

describe('parseMediaIdFromParams', () => {
    it('parses id param', () => {
        const result = parseMediaIdFromParams({ id: 'tmdb:550:movie' }, new URLSearchParams());
        expect(result.type).toBe('composite');
        expect(result.provider).toBe('tmdb');
    });

    it('parses mediaId param', () => {
        const result = parseMediaIdFromParams({ mediaId: 'tmdb:550:movie' }, new URLSearchParams());
        expect(result.type).toBe('composite');
    });

    it('ignores legacy tmdbId param (no longer supported)', () => {
        const result = parseMediaIdFromParams({ tmdbId: 'tmdb:550:movie' }, new URLSearchParams());
        // tmdbId param is no longer supported - returns empty/invalid parse
        expect(result.type).toBe('uuid');
        expect(result.uuid).toBeUndefined();
    });

    it('prefers id over mediaId over tmdbId', () => {
        const result = parseMediaIdFromParams(
            {
                id: 'tmdb:1:movie',
                mediaId: 'tmdb:2:movie',
                tmdbId: 'tmdb:3:movie',
            },
            new URLSearchParams(),
        );
        expect(result.externalId).toBe('1');
    });

    it('handles missing params', () => {
        const result = parseMediaIdFromParams({}, new URLSearchParams());
        expect(validateParsedMediaId(result)).toBe(false);
    });
});

// =============================================================================
// describeParsedMediaId
// =============================================================================

describe('describeParsedMediaId', () => {
    it('describes UUID type with uuid', () => {
        const description = describeParsedMediaId({
            type: 'uuid',
            uuid: '550e8400-e29b-41d4-a716-446655440000',
        });
        expect(description).toBe('UUID: 550e8400-e29b-41d4-a716-446655440000');
    });

    it('describes UUID type without uuid', () => {
        const description = describeParsedMediaId({ type: 'uuid' });
        expect(description).toBe('UUID: (missing)');
    });

    it('describes composite type', () => {
        const description = describeParsedMediaId({
            type: 'composite',
            provider: 'tmdb',
            externalId: '550',
            mediaType: 'movie',
        });
        expect(description).toBe('tmdb:550:movie');
    });
});

// =============================================================================
// Integration scenarios
// =============================================================================

describe('Integration Scenarios', () => {
    describe('Scenario 1: API route receiving various ID formats', () => {
        it('handles UUID from internal reference', () => {
            const id = '550e8400-e29b-41d4-a716-446655440000';
            const parsed = parseMediaId(id);
            expect(validateParsedMediaId(parsed)).toBe(true);
            expect(parsed.type).toBe('uuid');
        });

        it('handles composite key from deep link', () => {
            const id = 'tmdb:550:movie';
            const parsed = parseMediaId(id);
            expect(validateParsedMediaId(parsed)).toBe(true);
            expect(parsed.type).toBe('composite');
        });

        it('rejects legacy bare TMDB ID format', () => {
            const id = '550';
            const parsed = parseMediaId(id);
            expect(validateParsedMediaId(parsed)).toBe(false);
        });

        it('rejects legacy short format', () => {
            const id = '550:movie';
            const parsed = parseMediaId(id);
            expect(validateParsedMediaId(parsed)).toBe(false);
        });
    });

    describe('Scenario 2: Building URLs with composite keys', () => {
        it('creates URL-safe composite keys', () => {
            const key = createCompositeKey('tmdb', 550, 'movie');
            expect(key).toBe('tmdb:550:movie');

            // Verify it can be used in URL and parsed back
            const url = `/api/media/${encodeURIComponent(key)}`;
            const idFromUrl = decodeURIComponent(url.split('/').pop()!);
            const parsed = parseMediaId(idFromUrl);

            expect(parsed.type).toBe('composite');
            expect(parsed.provider).toBe('tmdb');
            expect(parsed.externalId).toBe('550');
            expect(parsed.mediaType).toBe('movie');
        });
    });

    describe('Scenario 3: Media type normalization in queries', () => {
        const testCases = [
            { input: 'movie', expected: 'movie' },
            { input: 'Movie', expected: 'movie' },
            { input: 'MOVIE', expected: 'movie' },
            { input: 'film', expected: 'movie' },
            { input: 'tv', expected: 'tv' },
            { input: 'TV', expected: 'tv' },
            { input: 'series', expected: 'tv' },
            { input: 'show', expected: 'tv' },
            { input: 'Series', expected: 'tv' },
        ];

        testCases.forEach(({ input, expected }) => {
            it(`normalizes "${input}" to "${expected}"`, () => {
                expect(normalizeMediaType(input)).toBe(expected);
            });
        });
    });

    describe('Scenario 4: Validation error messages', () => {
        it('provides helpful description for debugging', () => {
            // Valid composite
            const validComposite = parseMediaId('tmdb:550:movie');
            expect(describeParsedMediaId(validComposite)).toBe('tmdb:550:movie');

            // Invalid (missing uuid)
            const invalid = parseMediaId('550');
            expect(describeParsedMediaId(invalid)).toBe('UUID: (missing)');
        });
    });
});
