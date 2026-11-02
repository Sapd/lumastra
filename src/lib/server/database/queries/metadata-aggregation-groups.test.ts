// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { aggregateFieldsWithGroupOverrides } from './metadata-aggregation.queries.js';

describe('aggregateFieldsWithGroupOverrides', () => {
    const providerData = new Map<string, Record<string, unknown>>([
        ['tmdb', { overview: 'TMDB overview', genres: ['Action'], vote_average: 7.5 }],
        [
            'anidb',
            {
                overview: 'AniDB overview',
                genres: ['Anime', 'Action'],
                vote_average: 8.2,
            },
        ],
        [
            'mdblist',
            {
                overview: 'MDBList overview',
                mal_score: 85,
                rt_audience_score: 92,
            },
        ],
    ]);

    it('uses group overrides for specified fields', () => {
        const overrides = {
            overview: ['anidb', 'tmdb'],
            genres: ['anidb', 'tmdb'],
        };
        const { aggregated, fieldSources } = aggregateFieldsWithGroupOverrides(
            providerData,
            overrides,
        );
        expect(aggregated.overview).toBe('AniDB overview');
        expect(fieldSources.overview).toBe('anidb');
        expect(aggregated.genres).toEqual(['Anime', 'Action']);
        expect(fieldSources.genres).toBe('anidb');
    });

    it('falls through to global defaults for non-overridden fields', () => {
        const overrides = { overview: ['anidb', 'tmdb'] };
        const { aggregated, fieldSources } = aggregateFieldsWithGroupOverrides(
            providerData,
            overrides,
        );
        // mal_score global default is ['mdblist']
        expect(aggregated.mal_score).toBe(85);
        expect(fieldSources.mal_score).toBe('mdblist');
    });

    it('uses global defaults when overrides is null', () => {
        const { aggregated, fieldSources } = aggregateFieldsWithGroupOverrides(providerData, null);
        // Global default: overview is ['tmdb', 'jellyfin', 'mdblist']
        expect(aggregated.overview).toBe('TMDB overview');
        expect(fieldSources.overview).toBe('tmdb');
    });

    it('skips to next provider when override provider has no data', () => {
        const overrides = { overview: ['jellyfin', 'anidb', 'tmdb'] };
        const { aggregated, fieldSources } = aggregateFieldsWithGroupOverrides(
            providerData,
            overrides,
        );
        // jellyfin has no data, falls through to anidb
        expect(aggregated.overview).toBe('AniDB overview');
        expect(fieldSources.overview).toBe('anidb');
    });
});
