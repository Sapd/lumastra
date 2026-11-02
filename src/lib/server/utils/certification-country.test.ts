// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { pickCertificationForCountry } from './certification-country';

describe('pickCertificationForCountry', () => {
    it.each([
        ['US:PG-13 / Germany:FSK 12', 'DE', 'FSK 12'],
        ['US:PG-13 / Germany:FSK 12', 'US', 'PG-13'],
        ['US:PG-13 / Germany:FSK 12', 'GB', 'PG-13'],
        ['Germany:12', 'DE', '12'],
        ['Rated PG-13', 'DE', 'Rated PG-13'],
        ['FSK 12', 'DE', 'FSK 12'],
        ['FSK: 12', 'DE', 'FSK: 12'],
        ['UK:15 | Australia:MA15+', 'AU', 'MA15+'],
        ['Germany:Not Rated / US:R', 'DE', 'R'],
        ['Germany:12', 'US', '12'],
        ['Sweden:15 / US:PG-13', 'US', 'PG-13'],
        ['Sweden:15 / Germany:FSK 12', 'US', 'FSK 12'],
    ])('%s for %s -> %s', (raw, country, expected) => {
        expect(pickCertificationForCountry(raw, country)).toBe(expected);
    });

    it('returns null for nothing usable', () => {
        expect(pickCertificationForCountry('', 'DE')).toBeNull();
        expect(pickCertificationForCountry(null, 'DE')).toBeNull();
        expect(pickCertificationForCountry('Not Rated', 'DE')).toBeNull();
        expect(pickCertificationForCountry('Germany:Unrated', 'DE')).toBeNull();
        expect(pickCertificationForCountry('Sweden:15', 'US')).toBeNull();
        expect(pickCertificationForCountry('Taiwan:R', 'US')).toBeNull();
    });
});
