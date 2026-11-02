// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { pickTmdbCertification } from './tmdb-certification';

const movie = {
    release_dates: {
        results: [
            {
                iso_3166_1: 'DE',
                release_dates: [
                    { certification: '', type: 1, release_date: '2020-01-01T00:00:00.000Z' },
                    { certification: '16', type: 3, release_date: '2020-02-01T00:00:00.000Z' },
                    { certification: '12', type: 4, release_date: '2020-06-01T00:00:00.000Z' },
                ],
            },
            {
                iso_3166_1: 'US',
                release_dates: [
                    { certification: 'R', type: 3, release_date: '2020-02-02T00:00:00.000Z' },
                ],
            },
            {
                iso_3166_1: 'GB',
                release_dates: [{ certification: 'NR', type: 3, release_date: '2020-02-02' }],
            },
        ],
    },
};

const tv = {
    content_ratings: {
        results: [
            { iso_3166_1: 'DE', rating: '12' },
            { iso_3166_1: 'DE', rating: '16' },
            { iso_3166_1: 'US', rating: 'TV-MA' },
            { iso_3166_1: 'GB', rating: 'NR' },
        ],
    },
};

describe('pickTmdbCertification', () => {
    it('movie: the configured country wins', () => {
        expect(pickTmdbCertification(movie, 'movie', 'DE')).toEqual({
            certification: '16',
            country: 'DE',
        });
        expect(pickTmdbCertification(movie, 'movie', 'US')).toEqual({
            certification: 'R',
            country: 'US',
        });
    });

    it('movie: takes the STRICTEST usable certification across all release types', () => {
        const uncut = {
            release_dates: {
                results: [
                    {
                        iso_3166_1: 'DE',
                        release_dates: [
                            { certification: '16', type: 3, release_date: '2020-01-01' },
                            { certification: '', type: 4 },
                            { certification: '18', type: 5, release_date: '2020-06-01' },
                            { certification: '12', type: 1 },
                        ],
                    },
                ],
            },
        };
        expect(pickTmdbCertification(uncut, 'movie', 'DE')).toEqual({
            certification: '18',
            country: 'DE',
        });
    });

    it('movie: a country with only empty entries and unrated markers falls back to the US', () => {
        const onlyMarkers = {
            release_dates: {
                results: [
                    {
                        iso_3166_1: 'DE',
                        release_dates: [
                            { certification: '', type: 3 },
                            { certification: 'NR', type: 4 },
                        ],
                    },
                    { iso_3166_1: 'US', release_dates: [{ certification: 'PG', type: 3 }] },
                ],
            },
        };
        expect(pickTmdbCertification(onlyMarkers, 'movie', 'DE')).toEqual({
            certification: 'PG',
            country: 'US',
        });
    });

    it('a present but unparseable national certification does NOT fall back to the US', () => {
        const odd = {
            release_dates: {
                results: [
                    { iso_3166_1: 'DE', release_dates: [{ certification: 'Ungeprueft', type: 3 }] },
                    { iso_3166_1: 'US', release_dates: [{ certification: 'PG', type: 3 }] },
                ],
            },
        };
        expect(pickTmdbCertification(odd, 'movie', 'DE')).toBeNull();
        const oddTv = {
            content_ratings: {
                results: [
                    { iso_3166_1: 'ES', rating: 'Ungeprueft' },
                    { iso_3166_1: 'US', rating: 'TV-14' },
                ],
            },
        };
        expect(pickTmdbCertification(oddTv, 'tv', 'ES')).toBeNull();
    });

    it('maps BPjM Restricted to 18', () => {
        const bpjm = {
            release_dates: {
                results: [
                    {
                        iso_3166_1: 'DE',
                        release_dates: [{ certification: 'BPjM Restricted', type: 3 }],
                    },
                    { iso_3166_1: 'US', release_dates: [{ certification: 'PG', type: 3 }] },
                ],
            },
        };
        expect(pickTmdbCertification(bpjm, 'movie', 'DE')).toEqual({
            certification: 'BPjM Restricted',
            country: 'DE',
        });
    });

    it('movie: falls back to the US when the country has nothing usable', () => {
        expect(pickTmdbCertification(movie, 'movie', 'GB')).toEqual({
            certification: 'R',
            country: 'US',
        });
        expect(pickTmdbCertification(movie, 'movie', 'FR')).toEqual({
            certification: 'R',
            country: 'US',
        });
    });

    it('tv: matches the iso_3166_1 entry, falls back to the US', () => {
        expect(pickTmdbCertification(tv, 'tv', 'DE')).toEqual({
            certification: '16',
            country: 'DE',
        });
        expect(pickTmdbCertification(tv, 'tv', 'GB')).toEqual({
            certification: 'TV-MA',
            country: 'US',
        });
    });

    it('returns null without usable data', () => {
        expect(pickTmdbCertification(null, 'movie', 'DE')).toBeNull();
        expect(pickTmdbCertification({}, 'tv', 'DE')).toBeNull();
        expect(
            pickTmdbCertification({ content_ratings: { results: [] } }, 'tv', 'DE'),
        ).toBeNull();
        // A movie response has no content_ratings block and vice versa.
        expect(pickTmdbCertification(tv, 'movie', 'DE')).toBeNull();
        expect(pickTmdbCertification(movie, 'tv', 'DE')).toBeNull();
    });
});
