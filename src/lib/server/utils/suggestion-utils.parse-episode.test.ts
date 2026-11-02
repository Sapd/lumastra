// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseEpisodeQuery } from './suggestion-utils.js';

describe('parseEpisodeQuery', () => {
    it('parses the usual shapes', () => {
        expect(parseEpisodeQuery('Moon Tide S37E13')).toEqual({
            seriesName: 'Moon Tide',
            season: 37,
            episode: 13,
        });
        expect(parseEpisodeQuery('  show s1e4 ')).toEqual({
            seriesName: 'show',
            season: 1,
            episode: 4,
        });
        expect(parseEpisodeQuery('Moon Tide')).toBeNull();
        expect(parseEpisodeQuery('S1E4')).toBeNull();
    });

    // `^(.+?)\s*S\d+E\d+$` tried the whitespace run once per series-name position.
    it.each([
        ['a long whitespace run', `a${' '.repeat(64_000)}x`],
        ['a long run before a near miss', `a${' '.repeat(64_000)}S1E`],
    ])('is linear on %s', (_label, query) => {
        const start = performance.now();
        parseEpisodeQuery(query);
        expect(performance.now() - start).toBeLessThan(500);
    });
});
