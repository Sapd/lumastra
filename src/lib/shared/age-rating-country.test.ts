// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { defaultAgeRatingCountry, resolveAgeRatingCountry } from './age-rating-country';

describe('defaultAgeRatingCountry', () => {
    it.each([
        ['de-DE', 'DE'],
        ['en-US', 'US'],
        ['en-GB', 'GB'],
        ['en-AU', 'AU'],
        ['fr-FR', 'FR'],
        ['nl-NL', 'NL'],
        ['es-ES', 'ES'],
        ['de-AT', 'DE'],
        ['de-CH', 'DE'],
        ['de', 'DE'],
        ['en', 'US'],
        ['de_DE', 'DE'],
        ['ja-JP', 'US'],
        ['pt-BR', 'US'],
        ['', 'US'],
        [null, 'US'],
    ])('%s -> %s', (tag, expected) => {
        expect(defaultAgeRatingCountry(tag)).toBe(expected);
    });
});

describe('resolveAgeRatingCountry', () => {
    it('auto follows the metadata language', () => {
        expect(resolveAgeRatingCountry('auto', 'de-DE')).toBe('DE');
        expect(resolveAgeRatingCountry('', 'en-GB')).toBe('GB');
        expect(resolveAgeRatingCountry(undefined, 'ja-JP')).toBe('US');
    });

    it('an explicit supported country wins over the language', () => {
        expect(resolveAgeRatingCountry('gb', 'de-DE')).toBe('GB');
        expect(resolveAgeRatingCountry('US', 'de-DE')).toBe('US');
    });

    it('an unsupported explicit value falls back to the language default', () => {
        expect(resolveAgeRatingCountry('XX', 'de-DE')).toBe('DE');
    });
});
