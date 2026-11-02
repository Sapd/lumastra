// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { defaultLineupCountries, displayRegionCode } from './livetv-lineup-defaults';

const available = [
    'us',
    'de',
    'uk',
    'adult',
    'pl',
    'tr',
    'at',
    'ro',
    'ca',
    'ch',
    'religious',
    'ie',
];

describe('defaultLineupCountries', () => {
    it('picks the countries of the browser languages that the provider carries', () => {
        expect(defaultLineupCountries(['de-DE', 'en-US', 'en'], available)).toEqual([
            'de',
            'at',
            'ch',
            'us',
            'uk',
            'ca',
            'ie',
        ]);
    });

    it('maps en-GB to uk and never picks adult or religious', () => {
        expect(defaultLineupCountries(['en-GB'], ['uk', 'us', 'adult'])).toEqual(['uk', 'us']);
        expect(defaultLineupCountries(['ar'], ['adult', 'religious'])).toEqual([]);
    });

    it('picks nothing for an unlisted language, and never reads a language as a country', () => {
        expect(defaultLineupCountries(['pl'], available)).toEqual(['pl']);
        expect(defaultLineupCountries(['ja-JP'], available)).toEqual([]);
        // Catalan is not Canada; ca-ES still picks Spain through its region.
        expect(defaultLineupCountries(['ca'], ['ca', 'es'])).toEqual([]);
        expect(defaultLineupCountries(['ca-ES'], ['ca', 'es'])).toEqual(['es']);
    });
});

describe('displayRegionCode', () => {
    it('maps lineup codes to ISO for Intl.DisplayNames', () => {
        expect(displayRegionCode('uk')).toBe('GB');
        expect(displayRegionCode('de')).toBe('DE');
        expect(displayRegionCode('arab')).toBeNull();
    });
});
