// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    getCountries,
    getCultures,
    getLocalizationOptions,
    getParentalRatings,
} from './localization';

describe('getCultures', () => {
    it('carries ISO 639-2/T first, then /B, and the ISO 639-1 code', () => {
        expect(getCultures().find((c) => c.Name === 'German')).toEqual({
            Name: 'German',
            DisplayName: 'German',
            TwoLetterISOLanguageName: 'de',
            ThreeLetterISOLanguageName: 'deu',
            ThreeLetterISOLanguageNames: ['deu', 'ger'],
        });
        expect(getCultures().find((c) => c.Name === 'English')).toMatchObject({
            ThreeLetterISOLanguageNames: ['eng'],
        });
    });

    it('is sorted and unique by display name', () => {
        const names = getCultures().map((c) => c.DisplayName);
        expect(names).toEqual([...names].sort());
        expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    });

    it('languages without an ISO 639-1 code have an empty two-letter name', () => {
        expect(getCultures().find((c) => c.ThreeLetterISOLanguageName === 'ace')).toMatchObject({
            TwoLetterISOLanguageName: '',
        });
    });
});

describe('getCountries', () => {
    it('uses the alpha-2 code as Name', () => {
        expect(getCountries().find((c) => c.Name === 'DE')).toEqual({
            Name: 'DE',
            DisplayName: 'Germany',
            TwoLetterISORegionName: 'DE',
            ThreeLetterISORegionName: 'DEU',
        });
    });
});

describe('getParentalRatings', () => {
    it('has the US ratings with camelCase scores, Unrated and the 21 catch-all', () => {
        const ratings = getParentalRatings();
        expect(ratings.find((r) => r.Name === 'PG-13')).toEqual({
            Name: 'PG-13',
            Value: 13,
            RatingScore: { score: 13, subScore: 0 },
        });
        expect(ratings.find((r) => r.Name === 'Unrated')).toEqual({
            Name: 'Unrated',
            Value: null,
            RatingScore: null,
        });
        expect(ratings.at(-1)).toMatchObject({ Name: '21', Value: 21 });
    });
});

describe('getLocalizationOptions', () => {
    it('lists the UI locales with their own names', () => {
        const options = getLocalizationOptions();
        expect(options).toContainEqual({ Name: 'English', Value: 'en' });
        expect(options).toContainEqual({ Name: 'Deutsch', Value: 'de' });
    });
});
