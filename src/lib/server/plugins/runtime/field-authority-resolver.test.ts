// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { FieldAuthorityResolver } from './field-authority-resolver';

describe('FieldAuthorityResolver', () => {
    it('merges non-overlapping fields from two providers', () => {
        const resolver = new FieldAuthorityResolver({
            defaultPriorities: {
                title: ['tmdb'],
                letterboxd_rating: ['mdblist'],
            },
        });

        const result = resolver.merge([
            { provider: 'tmdb', data: { title: 'Daydream' } },
            { provider: 'mdblist', data: { letterboxd_rating: 4.2 } },
        ]);

        expect(result.merged.title).toBe('Daydream');
        expect(result.merged.letterboxd_rating).toBe(4.2);
        expect(result.fieldSources.title).toBe('tmdb');
        expect(result.fieldSources.letterboxd_rating).toBe('mdblist');
    });

    it('uses priority to resolve overlapping fields', () => {
        const resolver = new FieldAuthorityResolver({
            defaultPriorities: {
                overview: ['tmdb', 'jellyfin'],
            },
        });

        const result = resolver.merge([
            { provider: 'jellyfin', data: { overview: 'Jellyfin overview' } },
            { provider: 'tmdb', data: { overview: 'TMDB overview' } },
        ]);

        expect(result.merged.overview).toBe('TMDB overview');
        expect(result.fieldSources.overview).toBe('tmdb');
    });

    it('falls through to next provider when field is null/undefined', () => {
        const resolver = new FieldAuthorityResolver({
            defaultPriorities: {
                tagline: ['tmdb', 'mdblist'],
            },
        });

        const result = resolver.merge([
            { provider: 'tmdb', data: { tagline: null } },
            { provider: 'mdblist', data: { tagline: 'A great movie' } },
        ]);

        expect(result.merged.tagline).toBe('A great movie');
        expect(result.fieldSources.tagline).toBe('mdblist');
    });

    it('applies admin overrides over default priorities', () => {
        const resolver = new FieldAuthorityResolver({
            defaultPriorities: {
                poster_path: ['tmdb', 'tvdb'],
            },
            adminOverrides: {
                poster_path: ['tvdb', 'tmdb'],
            },
        });

        const result = resolver.merge([
            { provider: 'tmdb', data: { poster_path: '/tmdb.jpg' } },
            { provider: 'tvdb', data: { poster_path: '/tvdb.jpg' } },
        ]);

        expect(result.merged.poster_path).toBe('/tvdb.jpg');
        expect(result.fieldSources.poster_path).toBe('tvdb');
    });

    it('applies anime-specific overrides when isAnime=true', () => {
        const resolver = new FieldAuthorityResolver({
            defaultPriorities: {
                vote_average: ['tmdb', 'mdblist'],
            },
            animeOverrides: {
                vote_average: ['mdblist', 'tmdb'],
            },
        });

        const result = resolver.merge(
            [
                { provider: 'tmdb', data: { vote_average: 8.1 } },
                { provider: 'mdblist', data: { vote_average: 9.0 } },
            ],
            { isAnime: true },
        );

        expect(result.merged.vote_average).toBe(9.0);
        expect(result.fieldSources.vote_average).toBe('mdblist');
    });

    it('returns empty merged when no providers have data', () => {
        const resolver = new FieldAuthorityResolver({
            defaultPriorities: { title: ['tmdb'] },
        });

        const result = resolver.merge([]);

        expect(result.merged).toEqual({});
        expect(result.fieldSources).toEqual({});
    });

    it('handles fields not in priority map (first provider wins)', () => {
        const resolver = new FieldAuthorityResolver({
            defaultPriorities: {},
        });

        const result = resolver.merge([
            { provider: 'tmdb', data: { custom_field: 'value1' } },
            { provider: 'mdblist', data: { custom_field: 'value2' } },
        ]);

        expect(result.merged.custom_field).toBe('value1');
    });

    it('tracks all field sources accurately', () => {
        const resolver = new FieldAuthorityResolver({
            defaultPriorities: {
                title: ['tmdb'],
                overview: ['tmdb', 'jellyfin'],
                letterboxd_rating: ['mdblist'],
            },
        });

        const result = resolver.merge([
            {
                provider: 'tmdb',
                data: { title: 'Daydream', overview: 'A thief...' },
            },
            { provider: 'mdblist', data: { letterboxd_rating: 4.2 } },
            { provider: 'jellyfin', data: { overview: 'Different overview' } },
        ]);

        expect(result.fieldSources).toEqual({
            title: 'tmdb',
            overview: 'tmdb',
            letterboxd_rating: 'mdblist',
        });
    });
});
