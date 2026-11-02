// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseSearchQueryHints } from './search-query-hints.js';

describe('parseSearchQueryHints', () => {
    it.each([
        ['Anna (2019)', { text: 'Anna', year: 2019 }],
        ['Anna [2019]', { text: 'Anna', year: 2019 }],
        ['Anna 2019', { text: 'Anna', year: 2019 }],
        ['2019 Anna', { text: 'Anna', year: 2019 }],
        ['Wonder Woman 1984', { text: 'Wonder Woman', year: 1984 }],
        ['MOVIE 1234', { text: '', year: 1234, type: 'movie' }],
        ['Movie (1234)', { text: '', year: 1234, type: 'movie' }],
        ['movie 2019', { text: '', year: 2019, type: 'movie' }],
        ['2019 film', { text: '', year: 2019, type: 'movie' }],
        ['Serie (1999)', { text: '', year: 1999, type: 'tv' }],
        ['movie Anna 2019', { text: 'Anna', year: 2019, type: 'movie' }],
        ['Anna (2019) movie', { text: 'Anna', year: 2019, type: 'movie' }],
    ])('parses %s', (q, expected) => {
        expect(parseSearchQueryHints(q)).toEqual(expected);
    });

    it.each([
        'Anna',
        '1917',
        '2012',
        '(2019)',
        'Cloud Runner 2049',
        'Lanternlight 451',
        'Movie 43',
        'The Movie',
        'movie',
        '*',
    ])('leaves %s untouched', (q) => {
        expect(parseSearchQueryHints(q)).toEqual({ text: q });
    });
});
