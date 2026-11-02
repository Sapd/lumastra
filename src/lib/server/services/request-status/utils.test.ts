// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for request status utilities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatReleaseDate, isDateInFuture, validateRequestQuery } from './utils';

describe('formatReleaseDate', () => {
    it('formats a valid date string', () => {
        // Note: Result depends on Europe/Vienna timezone
        const result = formatReleaseDate('2024-12-25');
        expect(result).toMatch(/25/); // Day should be present
        expect(result).toMatch(/Dezember|December/); // Month in German or English
        expect(result).toMatch(/2024/); // Year should be present
    });

    it('returns null for undefined input', () => {
        expect(formatReleaseDate(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(formatReleaseDate('')).toBeNull();
    });

    it('returns null for invalid date string', () => {
        expect(formatReleaseDate('not-a-date')).toBeNull();
        expect(formatReleaseDate('2024-13-45')).toBeNull();
    });

    it('handles ISO date strings', () => {
        const result = formatReleaseDate('2024-06-15T12:00:00Z');
        expect(result).not.toBeNull();
        expect(result).toMatch(/15/);
        expect(result).toMatch(/Juni|June/);
    });
});

describe('isDateInFuture', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns true for future dates', () => {
        expect(isDateInFuture('2024-12-25')).toBe(true);
        expect(isDateInFuture('2025-01-01')).toBe(true);
    });

    it('returns false for past dates', () => {
        expect(isDateInFuture('2024-01-01')).toBe(false);
        expect(isDateInFuture('2023-12-25')).toBe(false);
    });

    it('returns false for current date (depending on time)', () => {
        // Current time is 2024-06-15T12:00:00Z
        // 2024-06-15 as a date string will be parsed as midnight, which is in the past
        expect(isDateInFuture('2024-06-15')).toBe(false);
    });

    it('returns false for undefined input', () => {
        expect(isDateInFuture(undefined)).toBe(false);
    });

    it('returns false for invalid date string', () => {
        expect(isDateInFuture('not-a-date')).toBe(false);
    });
});

describe('validateRequestQuery', () => {
    describe('valid inputs', () => {
        it('validates a valid movie request', () => {
            const result = validateRequestQuery(
                { externalIds: { tmdb: '123' }, mediaType: 'movie' },
                0,
            );
            expect(result.valid).toBe(true);
            if (result.valid) {
                expect(result.data.externalIds.tmdb).toBe('123');
                expect(result.data.mediaType).toBe('movie');
                expect(result.data.seasons).toBeUndefined();
            }
        });

        it('validates a valid TV request with seasons', () => {
            const result = validateRequestQuery(
                {
                    externalIds: { tmdb: '456' },
                    mediaType: 'tv',
                    seasons: [1, 2, 3],
                },
                0,
            );
            expect(result.valid).toBe(true);
            if (result.valid) {
                expect(result.data.externalIds.tmdb).toBe('456');
                expect(result.data.mediaType).toBe('tv');
                expect(result.data.seasons).toEqual([1, 2, 3]);
            }
        });

        it('validates TV request without seasons', () => {
            const result = validateRequestQuery(
                { externalIds: { tmdb: '789' }, mediaType: 'tv' },
                0,
            );
            expect(result.valid).toBe(true);
        });

        it('accepts season 0 (specials)', () => {
            const result = validateRequestQuery(
                {
                    externalIds: { tmdb: '123' },
                    mediaType: 'tv',
                    seasons: [0, 1, 2],
                },
                0,
            );
            expect(result.valid).toBe(true);
        });
    });

    describe('invalid inputs', () => {
        it('rejects null input', () => {
            const result = validateRequestQuery(null, 0);
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.error).toContain('not an object');
            }
        });

        it('rejects non-object input', () => {
            const result = validateRequestQuery('string', 0);
            expect(result.valid).toBe(false);
        });

        it('rejects missing externalIds', () => {
            const result = validateRequestQuery({ mediaType: 'movie' }, 0);
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.error).toContain('externalIds');
            }
        });

        it('rejects non-object externalIds', () => {
            const result = validateRequestQuery({ externalIds: '123', mediaType: 'movie' }, 0);
            expect(result.valid).toBe(false);
        });

        it('rejects empty externalIds', () => {
            const result = validateRequestQuery({ externalIds: {}, mediaType: 'movie' }, 0);
            expect(result.valid).toBe(false);
        });

        it('rejects externalIds with non-string values', () => {
            const result = validateRequestQuery(
                { externalIds: { tmdb: 123 }, mediaType: 'movie' },
                0,
            );
            expect(result.valid).toBe(false);
        });

        it('accepts externalIds with any provider', () => {
            const result = validateRequestQuery(
                { externalIds: { imdb: 'tt1234567' }, mediaType: 'movie' },
                0,
            );
            expect(result.valid).toBe(true);
        });

        it('rejects missing mediaType', () => {
            const result = validateRequestQuery({ externalIds: { tmdb: '123' } }, 0);
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.error).toContain('mediaType');
            }
        });

        it('rejects invalid mediaType', () => {
            const result = validateRequestQuery(
                { externalIds: { tmdb: '123' }, mediaType: 'anime' },
                0,
            );
            expect(result.valid).toBe(false);
        });

        it('rejects non-array seasons', () => {
            const result = validateRequestQuery(
                { externalIds: { tmdb: '123' }, mediaType: 'tv', seasons: 1 },
                0,
            );
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.error).toContain('seasons');
            }
        });

        it('rejects too many seasons', () => {
            const seasons = Array.from({ length: 51 }, (_, i) => i + 1);
            const result = validateRequestQuery(
                { externalIds: { tmdb: '123' }, mediaType: 'tv', seasons },
                0,
            );
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.error).toContain('max 50');
            }
        });

        it('rejects negative season numbers', () => {
            const result = validateRequestQuery(
                {
                    externalIds: { tmdb: '123' },
                    mediaType: 'tv',
                    seasons: [-1, 1, 2],
                },
                0,
            );
            expect(result.valid).toBe(false);
        });

        it('rejects non-integer season numbers', () => {
            const result = validateRequestQuery(
                {
                    externalIds: { tmdb: '123' },
                    mediaType: 'tv',
                    seasons: [1.5, 2],
                },
                0,
            );
            expect(result.valid).toBe(false);
        });

        it('rejects non-numeric season values', () => {
            const result = validateRequestQuery(
                {
                    externalIds: { tmdb: '123' },
                    mediaType: 'tv',
                    seasons: ['1', '2'],
                },
                0,
            );
            expect(result.valid).toBe(false);
        });
    });

    describe('error messages include index', () => {
        it('includes index in externalIds error', () => {
            const result = validateRequestQuery({ externalIds: {}, mediaType: 'movie' }, 5);
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.error).toContain('index 5');
            }
        });

        it('includes index in season error', () => {
            const result = validateRequestQuery(
                {
                    externalIds: { tmdb: '123' },
                    mediaType: 'tv',
                    seasons: [-1],
                },
                3,
            );
            expect(result.valid).toBe(false);
            if (!result.valid) {
                expect(result.error).toContain('index 3');
            }
        });
    });
});
