// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for rating utilities
 */

import { describe, it, expect } from 'vitest';
import {
    selectBestRating,
    getAllRatings,
    normalizeRating,
    getRatingMax,
    formatRating,
    pickDisplayRating,
    MIN_DISPLAY_VOTE_COUNT,
    DEFAULT_RATING_PREFERENCE,
    type RatingRow,
    type RatingPreference,
    type RatingSource,
} from './rating-utils';

describe('selectBestRating', () => {
    describe('primary preference order', () => {
        it('returns IMDB rating when available (primary preference)', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
                tmdb_rating: 8.0,
                letterboxd_rating: 4.0,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(7.5);
            expect(result.ratingSource).toBe('imdb');
        });

        it('falls back to TMDB when IMDB missing', () => {
            const row: RatingRow = {
                imdb_rating: null,
                tmdb_rating: 8.0,
                letterboxd_rating: 4.0,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(8.0);
            expect(result.ratingSource).toBe('tmdb');
        });

        it('falls back to TMDB when IMDB undefined', () => {
            const row: RatingRow = {
                tmdb_rating: 8.0,
                letterboxd_rating: 4.0,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(8.0);
            expect(result.ratingSource).toBe('tmdb');
        });

        it('falls back to letterboxd when both IMDB and TMDB missing', () => {
            const row: RatingRow = {
                imdb_rating: null,
                tmdb_rating: null,
                letterboxd_rating: 3.5,
            };

            const result = selectBestRating(row);

            // MDBList reports Letterboxd already on 0-10, so 3.5 passes through
            // unchanged. This previously asserted 7.0 (a `* 2` that assumed the
            // site's 0-5 stars) — see the response-contract tests at the bottom.
            expect(result.rating).toBe(3.5);
            expect(result.ratingSource).toBe('letterboxd');
        });

        it('falls back to trakt when earlier sources missing', () => {
            const row: RatingRow = {
                trakt_score: 78,
            };

            const result = selectBestRating(row);

            // Trakt is 0-100 scale, so 78 / 10 = 7.8
            expect(result.rating).toBe(7.8);
            expect(result.ratingSource).toBe('trakt');
        });

        it('falls back to mdblist when earlier sources missing', () => {
            const row: RatingRow = {
                mdblist_score: 82,
            };

            const result = selectBestRating(row);

            // MDBList is 0-100 scale, so 82 / 10 = 8.2
            expect(result.rating).toBe(8.2);
            expect(result.ratingSource).toBe('mdblist');
        });
    });

    describe('returns undefined when no ratings available', () => {
        it('returns undefined values for empty row', () => {
            const row: RatingRow = {};

            const result = selectBestRating(row);

            expect(result.rating).toBeUndefined();
            expect(result.ratingSource).toBeUndefined();
        });

        it('returns undefined values when all ratings are null', () => {
            const row: RatingRow = {
                imdb_rating: null,
                tmdb_rating: null,
                letterboxd_rating: null,
                mdblist_score: null,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBeUndefined();
            expect(result.ratingSource).toBeUndefined();
        });

        it('returns undefined values when all ratings are undefined', () => {
            const row: RatingRow = {
                imdb_rating: undefined,
                tmdb_rating: undefined,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBeUndefined();
            expect(result.ratingSource).toBeUndefined();
        });
    });

    describe('handles null/undefined values correctly', () => {
        it('skips null values and uses next available', () => {
            const row: RatingRow = {
                imdb_rating: null,
                tmdb_rating: 7.2,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(7.2);
            expect(result.ratingSource).toBe('tmdb');
        });

        it('skips undefined values and uses next available', () => {
            const row: RatingRow = {
                imdb_rating: undefined,
                tmdb_rating: 7.2,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(7.2);
            expect(result.ratingSource).toBe('tmdb');
        });
    });

    describe('handles NaN values', () => {
        it('skips NaN values', () => {
            const row: RatingRow = {
                imdb_rating: NaN,
                tmdb_rating: 7.5,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(7.5);
            expect(result.ratingSource).toBe('tmdb');
        });

        it('returns undefined when all values are NaN', () => {
            const row: RatingRow = {
                imdb_rating: NaN,
                tmdb_rating: NaN,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBeUndefined();
            expect(result.ratingSource).toBeUndefined();
        });
    });

    describe('treats 0 as valid rating', () => {
        it('returns 0 as a valid rating', () => {
            const row: RatingRow = {
                imdb_rating: 0,
                tmdb_rating: 7.5,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(0);
            expect(result.ratingSource).toBe('imdb');
        });

        it('returns 0 when normalized from 0-100 scale', () => {
            const row: RatingRow = {
                rt_rating: 0,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(0);
            expect(result.ratingSource).toBe('rt');
        });
    });

    describe('vote_average maps to tmdb source', () => {
        it('uses vote_average as TMDB when tmdb_rating not present', () => {
            const row: RatingRow = {
                vote_average: 7.8,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(7.8);
            expect(result.ratingSource).toBe('tmdb');
        });

        it('prefers tmdb_rating over vote_average', () => {
            const row: RatingRow = {
                tmdb_rating: 8.0,
                vote_average: 7.5,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(8.0);
            expect(result.ratingSource).toBe('tmdb');
        });

        it('falls back to vote_average when tmdb_rating is null', () => {
            const row: RatingRow = {
                tmdb_rating: null,
                vote_average: 7.5,
            };

            const result = selectBestRating(row);

            expect(result.rating).toBe(7.5);
            expect(result.ratingSource).toBe('tmdb');
        });
    });

    describe('custom preference order', () => {
        it('uses custom primary preference', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
                rt_rating: 85,
                tmdb_rating: 8.0,
            };

            const customPreference: RatingPreference = {
                primary: ['rt'],
                fallback: ['imdb', 'tmdb'],
            };

            const result = selectBestRating(row, customPreference);

            // RT is 0-100 scale, so 85 / 10 = 8.5
            expect(result.rating).toBe(8.5);
            expect(result.ratingSource).toBe('rt');
        });

        it('falls back to custom fallback order', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
                tmdb_rating: 8.0,
            };

            const customPreference: RatingPreference = {
                primary: ['rt', 'letterboxd'],
                fallback: ['tmdb', 'imdb'],
            };

            const result = selectBestRating(row, customPreference);

            expect(result.rating).toBe(8.0);
            expect(result.ratingSource).toBe('tmdb');
        });

        it('uses default preference when not specified', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
                tmdb_rating: 8.0,
            };

            const result = selectBestRating(row);

            // Default prefers IMDB
            expect(result.rating).toBe(7.5);
            expect(result.ratingSource).toBe('imdb');
        });
    });
});

describe('getAllRatings', () => {
    describe('returns all available ratings', () => {
        it('returns empty array for empty row', () => {
            const row: RatingRow = {};

            const result = getAllRatings(row);

            expect(result).toEqual([]);
        });

        it('returns single rating when only one available', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
            };

            const result = getAllRatings(row);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                value: 7.5,
                source: 'imdb',
                rawValue: 7.5,
            });
        });

        it('returns multiple ratings when available', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
                tmdb_rating: 8.0,
                letterboxd_rating: 3.5,
            };

            const result = getAllRatings(row);

            expect(result).toHaveLength(3);
            expect(result).toContainEqual({
                value: 7.5,
                source: 'imdb',
                rawValue: 7.5,
            });
            expect(result).toContainEqual({
                value: 8.0,
                source: 'tmdb',
                rawValue: 8.0,
            });
            expect(result).toContainEqual({
                value: 3.5,
                source: 'letterboxd',
                rawValue: 3.5,
            });
        });

        it('returns all rating sources when all present', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
                tmdb_rating: 8.0,
                letterboxd_rating: 3.5,
                rt_rating: 65,
                rt_audience_score: 72,
                metacritic_score: 85,
                trakt_score: 78,
                mdblist_score: 82,
                mal_score: 8.2,
            };

            const result = getAllRatings(row);

            expect(result).toHaveLength(9);
        });
    });

    describe('normalizes values correctly', () => {
        it('passes letterboxd through — MDBList already reports it 0-10', () => {
            const row: RatingRow = {
                letterboxd_rating: 3.5,
            };

            const result = getAllRatings(row);

            expect(result[0].value).toBe(3.5);
            expect(result[0].rawValue).toBe(3.5);
        });

        it('normalizes 0-100 scale ratings', () => {
            const row: RatingRow = {
                rt_rating: 65,
                metacritic_score: 85,
            };

            const result = getAllRatings(row);

            const rt = result.find((r) => r.source === 'rt');
            const metacritic = result.find((r) => r.source === 'metacritic');

            expect(rt?.value).toBe(6.5);
            expect(rt?.rawValue).toBe(65);
            expect(metacritic?.value).toBe(8.5);
            expect(metacritic?.rawValue).toBe(85);
        });
    });

    describe('skips invalid values', () => {
        it('skips null values', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
                tmdb_rating: null,
            };

            const result = getAllRatings(row);

            expect(result).toHaveLength(1);
            expect(result[0].source).toBe('imdb');
        });

        it('skips undefined values', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
                tmdb_rating: undefined,
            };

            const result = getAllRatings(row);

            expect(result).toHaveLength(1);
        });

        it('skips NaN values', () => {
            const row: RatingRow = {
                imdb_rating: 7.5,
                tmdb_rating: NaN,
            };

            const result = getAllRatings(row);

            expect(result).toHaveLength(1);
            expect(result[0].source).toBe('imdb');
        });
    });

    describe('handles vote_average', () => {
        it('uses vote_average as TMDB source', () => {
            const row: RatingRow = {
                vote_average: 7.8,
            };

            const result = getAllRatings(row);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                value: 7.8,
                source: 'tmdb',
                rawValue: 7.8,
            });
        });

        it('prefers tmdb_rating over vote_average', () => {
            const row: RatingRow = {
                tmdb_rating: 8.0,
                vote_average: 7.5,
            };

            const result = getAllRatings(row);

            const tmdbRating = result.find((r) => r.source === 'tmdb');
            expect(tmdbRating?.value).toBe(8.0);
            expect(result.filter((r) => r.source === 'tmdb')).toHaveLength(1);
        });
    });
});

describe('normalizeRating', () => {
    describe('IMDB scale (0-10)', () => {
        it('returns value unchanged', () => {
            expect(normalizeRating(7.5, 'imdb')).toBe(7.5);
            expect(normalizeRating(10, 'imdb')).toBe(10);
            expect(normalizeRating(0, 'imdb')).toBe(0);
        });
    });

    describe('TMDB scale (0-10)', () => {
        it('returns value unchanged', () => {
            expect(normalizeRating(7.5, 'tmdb')).toBe(7.5);
            expect(normalizeRating(10, 'tmdb')).toBe(10);
            expect(normalizeRating(0, 'tmdb')).toBe(0);
        });
    });

    describe('Letterboxd scale (0-5)', () => {
        it('passes values through — MDBList reports letterboxd already on 0-10', () => {
            expect(normalizeRating(3.5, 'letterboxd')).toBe(3.5);
            expect(normalizeRating(9, 'letterboxd')).toBe(9);
            expect(normalizeRating(0, 'letterboxd')).toBe(0);
            expect(normalizeRating(10, 'letterboxd')).toBe(10);
        });
    });

    describe('RT scale (0-100)', () => {
        it('converts to 0-10 scale by dividing by 10', () => {
            expect(normalizeRating(65, 'rt')).toBe(6.5);
            expect(normalizeRating(100, 'rt')).toBe(10);
            expect(normalizeRating(0, 'rt')).toBe(0);
        });
    });

    describe('RT Audience scale (0-100)', () => {
        it('converts to 0-10 scale by dividing by 10', () => {
            expect(normalizeRating(72, 'rt_audience')).toBe(7.2);
            expect(normalizeRating(100, 'rt_audience')).toBe(10);
            expect(normalizeRating(0, 'rt_audience')).toBe(0);
        });
    });

    describe('Metacritic scale (0-100)', () => {
        it('converts to 0-10 scale by dividing by 10', () => {
            expect(normalizeRating(85, 'metacritic')).toBe(8.5);
            expect(normalizeRating(100, 'metacritic')).toBe(10);
            expect(normalizeRating(0, 'metacritic')).toBe(0);
        });
    });

    describe('Trakt scale (0-100)', () => {
        it('converts to 0-10 scale by dividing by 10', () => {
            expect(normalizeRating(78, 'trakt')).toBe(7.8);
            expect(normalizeRating(100, 'trakt')).toBe(10);
            expect(normalizeRating(0, 'trakt')).toBe(0);
        });
    });

    describe('MDBList scale (0-100)', () => {
        it('converts to 0-10 scale by dividing by 10', () => {
            expect(normalizeRating(82, 'mdblist')).toBe(8.2);
            expect(normalizeRating(100, 'mdblist')).toBe(10);
            expect(normalizeRating(0, 'mdblist')).toBe(0);
        });
    });

    describe('MAL scale (0-10)', () => {
        it('returns value unchanged', () => {
            expect(normalizeRating(8.2, 'mal')).toBe(8.2);
            expect(normalizeRating(10, 'mal')).toBe(10);
            expect(normalizeRating(0, 'mal')).toBe(0);
        });
    });

    describe('edge cases', () => {
        it('returns undefined for null input', () => {
            expect(normalizeRating(null, 'imdb')).toBeUndefined();
        });

        it('returns undefined for undefined input', () => {
            expect(normalizeRating(undefined, 'imdb')).toBeUndefined();
        });

        it('returns undefined for NaN input', () => {
            expect(normalizeRating(NaN, 'imdb')).toBeUndefined();
        });

        it('treats 0 as valid input', () => {
            expect(normalizeRating(0, 'imdb')).toBe(0);
            expect(normalizeRating(0, 'rt')).toBe(0);
            expect(normalizeRating(0, 'letterboxd')).toBe(0);
        });
    });
});

describe('getRatingMax', () => {
    describe('returns correct max values', () => {
        it('returns 10 for IMDB', () => {
            expect(getRatingMax('imdb')).toBe(10);
        });

        it('returns 10 for TMDB', () => {
            expect(getRatingMax('tmdb')).toBe(10);
        });

        it('returns 10 for Letterboxd (MDBList reports it 0-10, not 0-5 stars)', () => {
            expect(getRatingMax('letterboxd')).toBe(10);
        });

        it('returns 100 for RT', () => {
            expect(getRatingMax('rt')).toBe(100);
        });

        it('returns 100 for RT Audience', () => {
            expect(getRatingMax('rt_audience')).toBe(100);
        });

        it('returns 100 for Metacritic', () => {
            expect(getRatingMax('metacritic')).toBe(100);
        });

        it('returns 100 for Trakt', () => {
            expect(getRatingMax('trakt')).toBe(100);
        });

        it('returns 100 for MDBList', () => {
            expect(getRatingMax('mdblist')).toBe(100);
        });

        it('returns 10 for MAL', () => {
            expect(getRatingMax('mal')).toBe(10);
        });
    });
});

describe('formatRating', () => {
    describe('formats to 1 decimal place', () => {
        it('formats whole numbers', () => {
            expect(formatRating(7)).toBe('7.0');
            expect(formatRating(10)).toBe('10.0');
            expect(formatRating(0)).toBe('0.0');
        });

        it('formats single decimal', () => {
            expect(formatRating(7.5)).toBe('7.5');
            expect(formatRating(8.3)).toBe('8.3');
        });

        it('rounds to 1 decimal place', () => {
            expect(formatRating(7.82)).toBe('7.8');
            expect(formatRating(7.86)).toBe('7.9');
            expect(formatRating(7.849)).toBe('7.8');
            expect(formatRating(7.95)).toBe('8.0');
        });

        it('handles very small decimals', () => {
            expect(formatRating(0.1)).toBe('0.1');
            expect(formatRating(0.05)).toBe('0.1');
            expect(formatRating(0.04)).toBe('0.0');
        });
    });

    describe('edge cases', () => {
        it('returns undefined for undefined input', () => {
            expect(formatRating(undefined)).toBeUndefined();
        });

        it('returns undefined for null input', () => {
            expect(formatRating(null)).toBeUndefined();
        });

        it('returns undefined for NaN input', () => {
            expect(formatRating(NaN)).toBeUndefined();
        });

        it('formats 0 correctly', () => {
            expect(formatRating(0)).toBe('0.0');
        });
    });
});

describe('DEFAULT_RATING_PREFERENCE', () => {
    it('has IMDB and TMDB as primary preferences', () => {
        expect(DEFAULT_RATING_PREFERENCE.primary).toContain('imdb');
        expect(DEFAULT_RATING_PREFERENCE.primary).toContain('tmdb');
        expect(DEFAULT_RATING_PREFERENCE.primary[0]).toBe('imdb');
    });

    it('has letterboxd, trakt, mdblist, rt, mal as fallbacks', () => {
        expect(DEFAULT_RATING_PREFERENCE.fallback).toContain('letterboxd');
        expect(DEFAULT_RATING_PREFERENCE.fallback).toContain('trakt');
        expect(DEFAULT_RATING_PREFERENCE.fallback).toContain('mdblist');
        expect(DEFAULT_RATING_PREFERENCE.fallback).toContain('rt');
        expect(DEFAULT_RATING_PREFERENCE.fallback).toContain('mal');
    });
});

describe('pickDisplayRating', () => {
    it('prefers IMDB when present and > 0, regardless of TMDB vote count', () => {
        expect(pickDisplayRating({ imdbRating: 7.5, tmdbRating: 9.9, voteCount: 1 })).toBe(7.5);
    });

    it('shows TMDB rating when vote_count meets the floor', () => {
        expect(
            pickDisplayRating({
                imdbRating: null,
                tmdbRating: 8.0,
                voteCount: MIN_DISPLAY_VOTE_COUNT,
            }),
        ).toBe(8.0);
    });

    it('hides TMDB rating when vote_count is below the floor', () => {
        expect(
            pickDisplayRating({
                imdbRating: null,
                tmdbRating: 10.0,
                voteCount: MIN_DISPLAY_VOTE_COUNT - 1,
            }),
        ).toBeUndefined();
    });

    it('hides TMDB rating when vote_count is null', () => {
        expect(
            pickDisplayRating({ imdbRating: undefined, tmdbRating: 8.0, voteCount: null }),
        ).toBeUndefined();
    });

    it('treats a tmdbRating of 0 as "no score", not as the worst possible score', () => {
        // vote_average is 0 for titles TMDB has no votes for; a qualifying
        // vote_count alongside it would otherwise render a literal "0.0" badge
        // and suppress the mdblist/RT fallback in transformToMediaDetail.
        expect(
            pickDisplayRating({ imdbRating: null, tmdbRating: 0, voteCount: 200 }),
        ).toBeUndefined();
    });

    it('returns undefined when both imdbRating and tmdbRating are absent', () => {
        expect(
            pickDisplayRating({ imdbRating: null, tmdbRating: null, voteCount: 200 }),
        ).toBeUndefined();
    });

    it('ignores a zero/negative IMDB rating and falls through to the TMDB gate', () => {
        expect(
            pickDisplayRating({
                imdbRating: 0,
                tmdbRating: 7.2,
                voteCount: MIN_DISPLAY_VOTE_COUNT,
            }),
        ).toBe(7.2);
    });
});

// =============================================================================
// Response-contract bounds (regression: RESPONSE CONFORMANCE on /api/v1/media)
// =============================================================================

/**
 * `MediaNodeDetailsSchema.rating` is `z.number().min(0).max(10)`, so anything
 * selectBestRating returns is contract-bound: a value outside 0-10 fails
 * mount()'s conformance check and a strict generated client rejects the whole
 * response.
 *
 * Both cases below are real production rows (verified against the prod
 * provider_metadata table, 2026-08-20), not hypotheticals.
 */
describe('normalized rating stays inside the 0-10 response contract', () => {
    it('does not double-scale letterboxd (MDBList already reports it 0-10)', () => {
        // "Lantern Keeper: Infinity Castle" — the row that actually tripped the
        // prod conformance log. imdb/tmdb absent, letterboxd 8 → was 8*2 = 16.
        const row: RatingRow = {
            imdb_rating: null,
            tmdb_rating: null,
            letterboxd_rating: 8,
        };

        const result = selectBestRating(row);

        expect(result.ratingSource).toBe('letterboxd');
        expect(result.rating).toBe(8);
    });

    it('agrees with IMDB on titles that carry both (The Gatekeeper: 8.7 vs 9.0)', () => {
        // Cross-scale proof: if letterboxd were 0-5, doubling 9.0 would give 18
        // while IMDB says 8.7 — the two sources track each other on 0-10.
        expect(normalizeRating(9.0, 'letterboxd')).toBe(9.0);
    });

    it('skips a negative provider sentinel instead of emitting it', () => {
        // 7 prod rows carry mdblist_score = -1 ("no score"), and all 7 have no
        // imdb/tmdb/letterboxd/trakt — so -1 was selected and emitted as -0.1,
        // violating .min(0).
        const row: RatingRow = { mdblist_score: -1 };

        const result = selectBestRating(row);

        expect(result.rating).toBeUndefined();
        expect(result.ratingSource).toBeUndefined();
    });

    it('clamps a provider value that overshoots its declared scale', () => {
        // Two prod rows store letterboxd_rating = 10.2. Even on the corrected
        // identity scale that breaches max(10), so the normalizer clamps.
        expect(normalizeRating(10.2, 'letterboxd')).toBe(10);
    });

    it('normalizes every source into 0-10 across the observed prod ranges', () => {
        // Observed min/max per source on the prod provider_metadata table
        // (2026-08-20). Driven through normalizeRating rather than
        // selectBestRating because metacritic and rt_audience are deliberately
        // absent from DEFAULT_RATING_PREFERENCE — they are only reachable via a
        // custom preference, but their SCALE still has to be right.
        const ranges: Array<[RatingSource, number, number]> = [
            ['imdb', 1, 10],
            ['letterboxd', 2, 10.2],
            ['mal', 3.2, 9.1],
            ['mdblist', 0, 94],
            ['metacritic', 1, 100],
            ['rt', 2, 100],
            ['rt_audience', 5, 100],
            ['trakt', 10, 100],
        ];

        for (const [source, min, max] of ranges) {
            for (const raw of [min, max]) {
                const value = normalizeRating(raw, source);
                expect(value, `${source}=${raw}`).toBeDefined();
                expect(value, `${source}=${raw}`).toBeGreaterThanOrEqual(0);
                expect(value, `${source}=${raw}`).toBeLessThanOrEqual(10);
            }
        }
    });
});
