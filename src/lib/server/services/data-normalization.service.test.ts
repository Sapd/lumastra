// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Data Normalization Service
 */

import { describe, it, expect } from 'vitest';
import { DataNormalizationService } from './data-normalization.service';

describe('DataNormalizationService', () => {
    describe('normalizeJellyfinDuration', () => {
        it('converts RunTimeTicks to seconds', () => {
            // RunTimeTicks = nanoseconds / 100
            // 1 hour = 3600 seconds = 36,000,000,000 nanoseconds / 100 = 360,000,000,000 ticks
            expect(DataNormalizationService.normalizeJellyfinDuration(36000000000)).toBe(3600);
        });

        it('handles 0', () => {
            expect(DataNormalizationService.normalizeJellyfinDuration(0)).toBeUndefined();
        });

        it('handles undefined', () => {
            expect(DataNormalizationService.normalizeJellyfinDuration(undefined)).toBeUndefined();
        });

        it('handles small values', () => {
            // 1 second = 10,000,000 ticks
            expect(DataNormalizationService.normalizeJellyfinDuration(10000000)).toBe(1);
        });
    });

    describe('normalizeDate', () => {
        it('converts string date to YYYY-MM-DD format', () => {
            expect(DataNormalizationService.normalizeDate('2024-03-15')).toBe('2024-03-15');
            expect(DataNormalizationService.normalizeDate('2024-03-15T10:30:00Z')).toBe(
                '2024-03-15',
            );
        });

        it('converts Date object to YYYY-MM-DD format', () => {
            const date = new Date('2024-03-15T10:30:00Z');
            expect(DataNormalizationService.normalizeDate(date)).toBe('2024-03-15');
        });

        it('converts Unix timestamp to YYYY-MM-DD format', () => {
            // March 15, 2024 00:00:00 UTC
            const timestamp = 1710460800000;
            expect(DataNormalizationService.normalizeDate(timestamp)).toBe('2024-03-15');
        });

        it('returns undefined for 0 (invalid data)', () => {
            expect(DataNormalizationService.normalizeDate(0)).toBeUndefined();
        });

        it('returns undefined for undefined/null', () => {
            expect(DataNormalizationService.normalizeDate(undefined)).toBeUndefined();
        });

        it('returns undefined for invalid date string', () => {
            expect(DataNormalizationService.normalizeDate('not-a-date')).toBeUndefined();
            expect(DataNormalizationService.normalizeDate('invalid')).toBeUndefined();
        });
    });

    describe('normalizeYear', () => {
        it('extracts year from date string', () => {
            expect(DataNormalizationService.normalizeYear('2024-03-15')).toBe(2024);
            expect(DataNormalizationService.normalizeYear('1999-12-31')).toBe(1999);
        });

        it('returns number directly if valid year', () => {
            expect(DataNormalizationService.normalizeYear(2024)).toBe(2024);
            expect(DataNormalizationService.normalizeYear(1999)).toBe(1999);
        });

        it('returns undefined for 0', () => {
            expect(DataNormalizationService.normalizeYear(0)).toBeUndefined();
        });

        it('handles numbers outside valid year range as timestamps', () => {
            // Numbers outside 1800-2200 are treated as timestamps and parsed
            // 100 ms from epoch = 1970, 3000 ms from epoch = 1970
            expect(DataNormalizationService.normalizeYear(100)).toBe(1970);
            // Very large number as timestamp
            expect(DataNormalizationService.normalizeYear(1700000000000)).toBe(2023); // ~Nov 2023
        });

        it('treats numbers in valid year range as years directly', () => {
            expect(DataNormalizationService.normalizeYear(1999)).toBe(1999);
            expect(DataNormalizationService.normalizeYear(2024)).toBe(2024);
            expect(DataNormalizationService.normalizeYear(1801)).toBe(1801);
            expect(DataNormalizationService.normalizeYear(2199)).toBe(2199);
        });

        it('extracts year from Date object', () => {
            const date = new Date('2024-03-15');
            expect(DataNormalizationService.normalizeYear(date)).toBe(2024);
        });
    });

    describe('normalizeRating', () => {
        it('returns rating as-is for scale 10', () => {
            expect(DataNormalizationService.normalizeRating(8.5, '10')).toBe(8.5);
            expect(DataNormalizationService.normalizeRating(7.0, '10')).toBe(7.0);
        });

        it('converts from scale 5 to scale 10', () => {
            expect(DataNormalizationService.normalizeRating(4.25, '5')).toBe(8.5);
            expect(DataNormalizationService.normalizeRating(5, '5')).toBe(10);
            expect(DataNormalizationService.normalizeRating(2.5, '5')).toBe(5);
        });

        it('converts from scale 100 to scale 10', () => {
            expect(DataNormalizationService.normalizeRating(85, '100')).toBe(8.5);
            expect(DataNormalizationService.normalizeRating(100, '100')).toBe(10);
            expect(DataNormalizationService.normalizeRating(50, '100')).toBe(5);
        });

        it('returns undefined for null/undefined', () => {
            expect(DataNormalizationService.normalizeRating(null)).toBeUndefined();
            expect(DataNormalizationService.normalizeRating(undefined)).toBeUndefined();
        });

        it('handles 0 rating', () => {
            expect(DataNormalizationService.normalizeRating(0, '10')).toBe(0);
        });

        it('defaults to scale 10', () => {
            expect(DataNormalizationService.normalizeRating(7.5)).toBe(7.5);
        });
    });

    describe('extractTmdbId', () => {
        it('extracts from Tmdb property', () => {
            expect(DataNormalizationService.extractTmdbId({ Tmdb: '12345' })).toBe(12345);
        });

        it('extracts from tmdb property (lowercase)', () => {
            expect(DataNormalizationService.extractTmdbId({ tmdb: '12345' })).toBe(12345);
        });

        it('extracts from TMDB property (uppercase)', () => {
            expect(DataNormalizationService.extractTmdbId({ TMDB: '12345' })).toBe(12345);
        });

        it('handles numeric TMDB ID', () => {
            expect(DataNormalizationService.extractTmdbId({ Tmdb: 12345 })).toBe(12345);
        });

        it('returns undefined for empty object', () => {
            expect(DataNormalizationService.extractTmdbId({})).toBeUndefined();
        });

        it('returns undefined for undefined', () => {
            expect(DataNormalizationService.extractTmdbId(undefined)).toBeUndefined();
        });

        it('returns undefined for invalid TMDB ID', () => {
            expect(
                DataNormalizationService.extractTmdbId({ Tmdb: 'not-a-number' }),
            ).toBeUndefined();
        });
    });

    describe('normalizeMediaType', () => {
        it('normalizes movie types', () => {
            expect(DataNormalizationService.normalizeMediaType('movie')).toBe('movie');
            expect(DataNormalizationService.normalizeMediaType('Movie')).toBe('movie');
            expect(DataNormalizationService.normalizeMediaType('MOVIE')).toBe('movie');
            expect(DataNormalizationService.normalizeMediaType('film')).toBe('movie');
        });

        it('normalizes series types', () => {
            expect(DataNormalizationService.normalizeMediaType('series')).toBe('tv');
            expect(DataNormalizationService.normalizeMediaType('tv')).toBe('tv');
            expect(DataNormalizationService.normalizeMediaType('tvseries')).toBe('tv');
        });

        it('normalizes episode type', () => {
            expect(DataNormalizationService.normalizeMediaType('episode')).toBe('episode');
        });

        it('normalizes audiobook type', () => {
            expect(DataNormalizationService.normalizeMediaType('audiobook')).toBe('audiobook');
        });

        it('normalizes book type', () => {
            expect(DataNormalizationService.normalizeMediaType('book')).toBe('book');
        });

        it('normalizes audio/music types', () => {
            // Jellyfin's `Audio` item type IS a track, and 'audio' is also a
            // canonical media_items.media_type value, so the two stay synonymous.
            expect(DataNormalizationService.normalizeMediaType('audio')).toBe('track');
            expect(DataNormalizationService.normalizeMediaType('musicalbum')).toBe('album');
        });

        it("keeps 'music' distinct from 'track'", () => {
            // Changed deliberately: this used to collapse onto 'track'.
            // `MediaItem['mediaType']` has BOTH members, and 'music' is a LIBRARY
            // ROOT marker rather than a playable item, so folding it onto 'track'
            // threw away the distinction for no caller's benefit. Nothing feeds
            // 'music' in anyway — the two production callers pass a Jellyfin
            // `item.Type` ('Audio', 'MusicAlbum', 'MusicArtist'), never 'Music'.
            expect(DataNormalizationService.normalizeMediaType('music')).toBe('music');
        });

        it('normalizes TV channel types', () => {
            expect(DataNormalizationService.normalizeMediaType('tvchannel')).toBe('tvchannel');
            expect(DataNormalizationService.normalizeMediaType('channel')).toBe('tvchannel');
            expect(DataNormalizationService.normalizeMediaType('livetv')).toBe('tvchannel');
        });

        it('normalizes request types', () => {
            expect(DataNormalizationService.normalizeMediaType('anfragen')).toBe('anfragen');
            expect(DataNormalizationService.normalizeMediaType('request')).toBe('anfragen');
        });

        it('returns null for unknown types instead of defaulting to movie', () => {
            // This test used to assert `'movie'` — it encoded the bug. Jellyfin
            // reports container types alongside media (Person, Folder, BoxSet,
            // CollectionFolder), and every one of them came back as a movie
            // MediaItem. `transformJellyfinToMediaItem` now drops them.
            expect(DataNormalizationService.normalizeMediaType('unknown')).toBeNull();
            expect(DataNormalizationService.normalizeMediaType('random')).toBeNull();
            expect(DataNormalizationService.normalizeMediaType('Person')).toBeNull();
            expect(DataNormalizationService.normalizeMediaType('BoxSet')).toBeNull();
            expect(DataNormalizationService.normalizeMediaType('CollectionFolder')).toBeNull();
        });

        it('has no MediaItem member for extra/radio/product', () => {
            // These ARE valid media_items.media_type values, but the legacy
            // app-layer MediaItem union predates them. The mapping table states
            // that gap explicitly rather than folding them onto 'movie'.
            expect(DataNormalizationService.normalizeMediaType('extra')).toBeNull();
            expect(DataNormalizationService.normalizeMediaType('radio')).toBeNull();
            expect(DataNormalizationService.normalizeMediaType('product')).toBeNull();
        });
    });

    describe('normalizeArray', () => {
        it('returns array as-is', () => {
            expect(DataNormalizationService.normalizeArray([1, 2, 3])).toEqual([1, 2, 3]);
            expect(DataNormalizationService.normalizeArray(['a', 'b'])).toEqual(['a', 'b']);
        });

        it('wraps single value in array', () => {
            expect(DataNormalizationService.normalizeArray(5)).toEqual([5]);
            expect(DataNormalizationService.normalizeArray('single')).toEqual(['single']);
        });

        it('returns empty array for null/undefined', () => {
            expect(DataNormalizationService.normalizeArray(null)).toEqual([]);
            expect(DataNormalizationService.normalizeArray(undefined)).toEqual([]);
        });
    });

    describe('calculateProgress', () => {
        it('calculates percentage correctly', () => {
            expect(DataNormalizationService.calculateProgress(50, 100)).toBe(50);
            expect(DataNormalizationService.calculateProgress(25, 100)).toBe(25);
            expect(DataNormalizationService.calculateProgress(75, 100)).toBe(75);
        });

        it('caps at 100%', () => {
            expect(DataNormalizationService.calculateProgress(150, 100)).toBe(100);
        });

        it('floors at 0%', () => {
            expect(DataNormalizationService.calculateProgress(-10, 100)).toBe(0);
        });

        it('returns undefined for missing values', () => {
            expect(DataNormalizationService.calculateProgress(undefined, 100)).toBeUndefined();
            expect(DataNormalizationService.calculateProgress(50, undefined)).toBeUndefined();
            expect(DataNormalizationService.calculateProgress(50, 0)).toBeUndefined();
        });
    });

    describe('ticksToSeconds', () => {
        it('converts ticks to seconds', () => {
            // 10,000,000 ticks = 1 second
            expect(DataNormalizationService.ticksToSeconds(10000000)).toBe(1);
            expect(DataNormalizationService.ticksToSeconds(36000000000)).toBe(3600);
        });

        it('returns undefined for falsy values', () => {
            expect(DataNormalizationService.ticksToSeconds(undefined)).toBeUndefined();
            expect(DataNormalizationService.ticksToSeconds(0)).toBeUndefined();
        });
    });

    describe('safeString', () => {
        it('returns string value', () => {
            expect(DataNormalizationService.safeString('hello')).toBe('hello');
        });

        it('converts number to string', () => {
            expect(DataNormalizationService.safeString(123)).toBe('123');
        });

        it('returns fallback for null/undefined', () => {
            expect(DataNormalizationService.safeString(null)).toBe('');
            expect(DataNormalizationService.safeString(undefined)).toBe('');
            expect(DataNormalizationService.safeString(null, 'fallback')).toBe('fallback');
        });

        it('returns fallback for empty string', () => {
            expect(DataNormalizationService.safeString('')).toBe('');
            expect(DataNormalizationService.safeString('', 'fallback')).toBe('fallback');
        });

        it('prevents literal "undefined" or "null" strings', () => {
            expect(DataNormalizationService.safeString('undefined')).toBe('');
            expect(DataNormalizationService.safeString('null')).toBe('');
        });

        it('returns fallback for whitespace-only string', () => {
            expect(DataNormalizationService.safeString('   ')).toBe('');
            expect(DataNormalizationService.safeString('   ', 'fallback')).toBe('fallback');
        });
    });

    describe('safeNumber', () => {
        it('returns number value', () => {
            expect(DataNormalizationService.safeNumber(42)).toBe(42);
            expect(DataNormalizationService.safeNumber(3.14)).toBe(3.14);
        });

        it('converts string to number', () => {
            expect(DataNormalizationService.safeNumber('42')).toBe(42);
            expect(DataNormalizationService.safeNumber('3.14')).toBe(3.14);
        });

        it('returns undefined for null/undefined', () => {
            expect(DataNormalizationService.safeNumber(null)).toBeUndefined();
            expect(DataNormalizationService.safeNumber(undefined)).toBeUndefined();
        });

        it('returns undefined for NaN', () => {
            expect(DataNormalizationService.safeNumber('not-a-number')).toBeUndefined();
            expect(DataNormalizationService.safeNumber(NaN)).toBeUndefined();
        });
    });

    describe('normalizeBoolean', () => {
        it('returns boolean as-is', () => {
            expect(DataNormalizationService.normalizeBoolean(true)).toBe(true);
            expect(DataNormalizationService.normalizeBoolean(false)).toBe(false);
        });

        it('converts string "true" to true', () => {
            expect(DataNormalizationService.normalizeBoolean('true')).toBe(true);
            expect(DataNormalizationService.normalizeBoolean('TRUE')).toBe(true);
            expect(DataNormalizationService.normalizeBoolean('True')).toBe(true);
        });

        it('converts string "1" to true', () => {
            expect(DataNormalizationService.normalizeBoolean('1')).toBe(true);
        });

        it('converts non-zero number to true', () => {
            expect(DataNormalizationService.normalizeBoolean(1)).toBe(true);
            expect(DataNormalizationService.normalizeBoolean(42)).toBe(true);
            expect(DataNormalizationService.normalizeBoolean(-1)).toBe(true);
        });

        it('converts 0 to false', () => {
            expect(DataNormalizationService.normalizeBoolean(0)).toBe(false);
        });

        it('converts falsy values to false', () => {
            expect(DataNormalizationService.normalizeBoolean(null)).toBe(false);
            expect(DataNormalizationService.normalizeBoolean(undefined)).toBe(false);
            expect(DataNormalizationService.normalizeBoolean('')).toBe(false);
        });

        it('converts other strings to false', () => {
            expect(DataNormalizationService.normalizeBoolean('false')).toBe(false);
            expect(DataNormalizationService.normalizeBoolean('no')).toBe(false);
            expect(DataNormalizationService.normalizeBoolean('random')).toBe(false);
        });
    });

    describe('normalizeOverview', () => {
        it('trims whitespace', () => {
            expect(DataNormalizationService.normalizeOverview('  Hello World  ')).toBe(
                'Hello World',
            );
        });

        it('normalizes line breaks', () => {
            expect(DataNormalizationService.normalizeOverview('Line1\r\nLine2')).toBe(
                'Line1\nLine2',
            );
        });

        it('reduces excessive line breaks', () => {
            expect(DataNormalizationService.normalizeOverview('Line1\n\n\n\nLine2')).toBe(
                'Line1\n\nLine2',
            );
        });

        it('returns undefined for empty/null', () => {
            expect(DataNormalizationService.normalizeOverview('')).toBeUndefined();
            expect(DataNormalizationService.normalizeOverview(undefined)).toBeUndefined();
        });
    });

    describe('mergeWithPriority', () => {
        it('returns primary if defined', () => {
            expect(
                DataNormalizationService.mergeWithPriority('primary', 'fallback', 'tertiary'),
            ).toBe('primary');
        });

        it('returns fallback if primary is null/undefined', () => {
            expect(DataNormalizationService.mergeWithPriority(null, 'fallback', 'tertiary')).toBe(
                'fallback',
            );
            expect(
                DataNormalizationService.mergeWithPriority(undefined, 'fallback', 'tertiary'),
            ).toBe('fallback');
        });

        it('returns tertiary if primary and fallback are null/undefined', () => {
            expect(DataNormalizationService.mergeWithPriority(null, null, 'tertiary')).toBe(
                'tertiary',
            );
            expect(
                DataNormalizationService.mergeWithPriority(undefined, undefined, 'tertiary'),
            ).toBe('tertiary');
        });

        it('returns undefined if all are null/undefined', () => {
            expect(
                DataNormalizationService.mergeWithPriority(undefined, undefined, undefined),
            ).toBeUndefined();
        });

        it('treats 0 and empty string as valid values', () => {
            expect(DataNormalizationService.mergeWithPriority(0, 5, 10)).toBe(0);
            expect(DataNormalizationService.mergeWithPriority('', 'fallback', 'tertiary')).toBe('');
        });
    });

    describe('normalizeUserInfo', () => {
        it('returns trimmed username', () => {
            expect(DataNormalizationService.normalizeUserInfo('  user  ')).toBe('user');
        });

        it('returns fallback for empty/undefined', () => {
            expect(DataNormalizationService.normalizeUserInfo('')).toBe('Unknown User');
            expect(DataNormalizationService.normalizeUserInfo(undefined)).toBe('Unknown User');
        });

        it('uses custom fallback', () => {
            expect(DataNormalizationService.normalizeUserInfo('', 'Anonymous')).toBe('Anonymous');
        });
    });

    describe('normalizeClientInfo', () => {
        it('combines client and version', () => {
            const result = DataNormalizationService.normalizeClientInfo(
                'Firefox',
                '120.0',
                'Windows',
            );
            expect(result.clientname).toBe('Firefox 120.0');
            expect(result.browsername).toBe('Windows');
        });

        it('handles missing version', () => {
            const result = DataNormalizationService.normalizeClientInfo(
                'Firefox',
                undefined,
                'Windows',
            );
            expect(result.clientname).toBe('Firefox');
        });

        it('handles missing client', () => {
            const result = DataNormalizationService.normalizeClientInfo(
                undefined,
                undefined,
                'Windows',
            );
            expect(result.clientname).toBe('Unknown Client');
        });

        it('handles missing device', () => {
            const result = DataNormalizationService.normalizeClientInfo(
                'Firefox',
                '120.0',
                undefined,
            );
            expect(result.browsername).toBe('Unknown Device');
        });
    });

    describe('extractVideoStreamInfo', () => {
        it('extracts video stream properties', () => {
            const streams = [
                {
                    Type: 'Video',
                    Codec: 'h264',
                    BitRate: 5000000,
                    Width: 1920,
                    Height: 1080,
                    VideoRange: 'SDR',
                },
                { Type: 'Audio', Codec: 'aac' },
            ];
            const result = DataNormalizationService.extractVideoStreamInfo(streams);

            expect(result.codec).toBe('h264');
            expect(result.bitRate).toBe(5000000);
            expect(result.width).toBe(1920);
            expect(result.height).toBe(1080);
            expect(result.videoRange).toBe('SDR');
        });

        it('returns empty object for no video stream', () => {
            const streams = [{ Type: 'Audio', Codec: 'aac' }];
            expect(DataNormalizationService.extractVideoStreamInfo(streams)).toEqual({});
        });

        it('returns empty object for undefined streams', () => {
            expect(DataNormalizationService.extractVideoStreamInfo(undefined)).toEqual({});
        });
    });

    describe('extractAudioStreamInfo', () => {
        it('extracts default audio stream', () => {
            const streams = [
                { Type: 'Video', Codec: 'h264' },
                {
                    Type: 'Audio',
                    Codec: 'aac',
                    BitRate: 128000,
                    Channels: 2,
                    Language: 'eng',
                    IsDefault: true,
                },
                {
                    Type: 'Audio',
                    Codec: 'dts',
                    BitRate: 1500000,
                    Channels: 6,
                    Language: 'eng',
                },
            ];
            const result = DataNormalizationService.extractAudioStreamInfo(streams);

            expect(result.codec).toBe('aac');
            expect(result.channels).toBe(2);
        });

        it('falls back to first audio stream if no default', () => {
            const streams = [
                {
                    Type: 'Audio',
                    Codec: 'dts',
                    BitRate: 1500000,
                    Channels: 6,
                    Language: 'eng',
                },
            ];
            const result = DataNormalizationService.extractAudioStreamInfo(streams);

            expect(result.codec).toBe('dts');
            expect(result.channels).toBe(6);
        });

        it('returns empty object for no audio stream', () => {
            const streams = [{ Type: 'Video', Codec: 'h264' }];
            expect(DataNormalizationService.extractAudioStreamInfo(streams)).toEqual({});
        });
    });

    describe('normalizeTitle', () => {
        it('removes special characters but keeps umlauts', () => {
            expect(DataNormalizationService.normalizeTitle('Schöne Bescherung!')).toBe(
                'Schöne Bescherung',
            );
            // Note: parentheses are removed first, leaving the content
            expect(DataNormalizationService.normalizeTitle('Tür (2020)')).toBe('Tür 2020');
        });

        it('handles parenthetical info (removes parens but keeps content)', () => {
            // The regex removes special chars (including parens) before the parenthetical removal regex runs
            // So parenthetical content is kept, just without the parentheses
            expect(DataNormalizationService.normalizeTitle('Movie Title (2020)')).toBe(
                'Movie Title 2020',
            );
            expect(DataNormalizationService.normalizeTitle('Show (Extended Edition)')).toBe(
                'Show Extended Edition',
            );
        });

        it('normalizes whitespace', () => {
            expect(DataNormalizationService.normalizeTitle('  The   Movie  ')).toBe('The Movie');
        });

        it('returns empty string for null/undefined', () => {
            expect(DataNormalizationService.normalizeTitle(undefined)).toBe('');
            expect(DataNormalizationService.normalizeTitle('')).toBe('');
        });
    });
});
