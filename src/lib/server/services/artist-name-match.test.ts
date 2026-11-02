// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for artist-name normalisation and compound-credit splitting.
 *
 * The accept/reject pairs below are not invented: they are real names from a
 * production library paired with the real top-ranked Deezer result for that
 * query. The rejects are the cases where trusting a fuzzy provider would have
 * written a DIFFERENT artist's photo onto the row.
 */

import { describe, it, expect } from 'vitest';
import {
    normalizeArtistName,
    artistNamesMatch,
    artistSearchQueries,
    leadArtistName,
} from './artist-name-match.js';

describe('normalizeArtistName', () => {
    it('case-folds and collapses whitespace', () => {
        expect(normalizeArtistName('  DJ   Fenwick ')).toBe('dj fenwick');
    });

    it('treats the two encodings of one character as equal', () => {
        // "é" precomposed (U+00E9) vs decomposed ("e" + U+0301). Same spelling,
        // different bytes — an encoding difference, not a naming one.
        expect(normalizeArtistName('Beyonc\u00e9')).toBe(normalizeArtistName('Beyonce\u0301'));
    });

    it('PRESERVES diacritics — the mark is part of the letter', () => {
        // Stripping these bought 2 extra hits per 40 and let a real artist's
        // photo land on a different real artist's row. See the module comment.
        expect(normalizeArtistName('Ni\u00f1o')).not.toBe(normalizeArtistName('Nino'));
        expect(normalizeArtistName('Klanggef\u00fchl')).not.toBe(
            normalizeArtistName('Klanggefuhl'),
        );
    });

    it('preserves word boundaries', () => {
        expect(normalizeArtistName('Sound Danizer')).not.toBe(normalizeArtistName('SounDDizer'));
        expect(normalizeArtistName('D-Tune')).not.toBe(normalizeArtistName('DTune'));
    });
});

describe('artistNamesMatch', () => {
    it.each([
        ['DJ Fenwick', 'DJ Fenwick'],
        ['D-Tune', 'D-tune'],
        ['Mattmoth', 'mattmoth'],
        ['Cc.k', 'Cc.K'],
        ['Gigi DAgostino', "Gigi D'Agostino"],
        ['Gigi DAgostino', 'Gigi D’Agostino'],
        ['Far*East Movement', 'Far East Movement'],
        ['Far_East Movement', 'Far East Movement'],
        ['R.E.M.', 'REM'],
        ['Makry, Jts', 'Makry, JTS'],
        ['Makry & JTS', 'Makry & Jts'],
    ])('accepts %s == %s', (a, b) => {
        expect(artistNamesMatch(a, b)).toBe(true);
    });

    // Every one of these is a real fuzzy top-hit that came back with a photo.
    it.each([
        ['Wildstyles', 'Wildstylez'],
        ['Gigi DAgostino', "Gigi D'Agostino Jr."],
        ['Far*East Movement', 'East Movement'],
        ['Makry, Jts', 'Makry'],
        ['Makry, Jts', 'JTS'],
        ['Makry, Jts', 'Makry & JTS'],
        ['Makry, Jts', 'Makry Jts'],
        ['Makry & JTS', 'Makry'],
        ['Makry & JTS', 'Makry JTS'],
        ['NOIZE', 'Boys Noize'],
        ['Robert Prime', 'Robert Palmer'],
        ['Cre-Yo', 'Crazy Frog'],
        ['Pressure Unit', 'Pressure Fit'],
        ['Sound Danizer', 'SounDDizer'],
        ['Tim H.', 'Tom Grennan'],
        ['Global Deffence', 'Global Defence'],
        ['Steliana', 'Steliana Sima'],
        // Diacritics distinguish distinct artists, in Spanish and in Vietnamese.
        ['Ni\u00f1o', 'Nino'],
        ['Klanggefuhl', 'Klanggef\u00fchl'],
        ['M\u1ea1', 'M\u00e1'],
        ['Matteo Madd\u00e9', 'Matteo Madd\u00e8'],
    ])('rejects %s != %s', (a, b) => {
        expect(artistNamesMatch(a, b)).toBe(false);
    });

    it('rejects an empty query rather than matching another empty', () => {
        expect(artistNamesMatch('', '')).toBe(false);
        expect(artistNamesMatch('   ', '')).toBe(false);
        expect(artistNamesMatch('***', '___')).toBe(false);
    });
});

describe('leadArtistName', () => {
    it.each([
        ['Ferry Corsten presents Gouryella', 'Ferry Corsten'],
        ['Anton Neumark Presents Unreal Babe', 'Anton Neumark'],
        ['Housegeist meets Fec-T', 'Housegeist'],
        ['Cc.k meets Scoon', 'Cc.k'],
        ['Armin van Buuren feat. Sharon den Adel', 'Armin van Buuren'],
        ['Tiesto vs. Diplo', 'Tiesto'],
    ])('splits %s -> %s', (full, lead) => {
        expect(leadArtistName(full)).toBe(lead);
    });

    it('returns null for a plain name', () => {
        expect(leadArtistName('Wavetraxx')).toBeNull();
        expect(leadArtistName('Dancefloor Rockaz')).toBeNull();
    });

    it('does NOT split co-equal credits, where one face misrepresents the act', () => {
        // `&` and `,` are deliberately not separators.
        expect(leadArtistName('Soren & Fenwick')).toBeNull();
        expect(leadArtistName('Sunshine State, PLSCB')).toBeNull();
        expect(leadArtistName('Makry, Jts')).toBeNull();
        expect(leadArtistName('Makry & JTS feat. Guest')).toBeNull();
    });

    it('does not split a name that merely contains a separator word', () => {
        expect(leadArtistName('Wilhart')).toBeNull();
        expect(leadArtistName('Presents')).toBeNull();
        expect(leadArtistName('Meets The Eye')).toBeNull();
    });

    it('rejects a lead too short to search on', () => {
        expect(leadArtistName('A feat. B')).toBeNull();
    });
});

describe('artistSearchQueries', () => {
    it.each([
        ['Gigi DAgostino', ['Gigi DAgostino', 'gigi d agostino']],
        ['Far*East Movement', ['Far*East Movement', 'far east movement']],
        ['Beyoncé', ['Beyoncé', 'beyonce']],
        ['A_B. C’D', ['A_B. C’D', 'a b c d']],
        ['Plain Name', ['Plain Name']],
        ['Makry, Jts', ['Makry, Jts']],
        ['Makry & JTS', ['Makry & JTS']],
        ['***', []],
        ['   ', []],
    ])('bounds and deduplicates queries for %s', (name, queries) => {
        expect(artistSearchQueries(name)).toEqual(queries);
    });
});
