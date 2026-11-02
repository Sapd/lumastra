// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { certificationToAge } from './certification-parser';

describe('certificationToAge', () => {
    // German FSK
    it.each([
        ['FSK 0', 0],
        ['FSK 6', 6],
        ['FSK 12', 12],
        ['FSK 16', 16],
        ['FSK 18', 18],
        ['fsk 12', 12],
    ])('parses German FSK: %s → %i', (cert, expected) => {
        expect(certificationToAge(cert)).toBe(expected);
    });

    // MPAA
    it.each([
        ['G', 0],
        ['PG', 8],
        ['PG-13', 13],
        ['R', 17],
        ['NC-17', 18],
    ])('parses MPAA: %s → %i', (cert, expected) => {
        expect(certificationToAge(cert)).toBe(expected);
    });

    // US TV
    it.each([
        ['TV-Y', 0],
        ['TV-Y7', 7],
        ['TV-G', 0],
        ['TV-PG', 10],
        ['TV-14', 14],
        ['TV-MA', 18],
    ])('parses US TV: %s → %i', (cert, expected) => {
        expect(certificationToAge(cert)).toBe(expected);
    });

    // UK BBFC
    it.each([
        ['U', 0],
        ['12A', 12],
        ['15', 15],
        ['18', 18],
        ['R18', 18],
    ])('parses UK BBFC: %s → %i', (cert, expected) => {
        expect(certificationToAge(cert)).toBe(expected);
    });

    // Australian
    it.each([
        ['MA15+', 15],
        ['MA 15+', 15],
        ['R18+', 18],
    ])('parses Australian: %s → %i', (cert, expected) => {
        expect(certificationToAge(cert)).toBe(expected);
    });

    // Edge cases
    it('returns null for empty string', () => {
        expect(certificationToAge('')).toBeNull();
    });

    it('returns null for "NR"', () => {
        expect(certificationToAge('NR')).toBeNull();
    });

    it('returns null for "Not Rated"', () => {
        expect(certificationToAge('Not Rated')).toBeNull();
    });

    it('returns null for null/undefined', () => {
        expect(certificationToAge(null)).toBeNull();
        expect(certificationToAge(undefined)).toBeNull();
    });

    // Numeric-only strings
    it.each([
        ['0', 0],
        ['6', 6],
        ['12', 12],
        ['16', 16],
        ['18', 18],
    ])('parses bare numeric: %s → %i', (cert, expected) => {
        expect(certificationToAge(cert)).toBe(expected);
    });
    // Table-driven: national systems and the shapes NFO / Jellyfin / TMDB emit.
    it.each([
        // FSK: every spelling seen in the wild
        ['BPjM Restricted', 18],
        ['keine Jugendfreigabe', 18],
        ['FSK-12', 12],
        ['FSK 12', 12],
        ['FSK12', 12],
        ['FSK: 12', 12],
        ['FSK ab 12', 12],
        ['FSK-16', 16],
        ['FSK-0', 0],
        ['FSK o.A.', 0],
        ['ab 12', 12],
        ['ab 16 Jahren', 16],
        ['Germany:FSK 12', 12],
        ['Germany:FSK-16', 16],
        ['Germany: 18', 18],
        ['DE:12', 12],
        ['DE-6', 6],
        ['6', 6],
        ['12+', 12],
        ['+12', 12],
        ['16+', 16],
        // MPAA with prefixes and run-together forms
        ['Rated PG-13', 13],
        ['Rated R', 17],
        ['US:PG-13', 13],
        ['USA:R', 17],
        ['PG13', 13],
        ['NC17', 18],
        ['pg-13', 13],
        // TV parental guidelines
        ['TV-Y7-FV', 7],
        ['TV14', 14],
        ['TVMA', 18],
        ['US:TV-MA', 18],
        // BBFC
        ['12', 12],
        ['12A', 12],
        ['U', 0],
        ['UK:15', 15],
        ['GB:PG', 8],
        // Australia
        ['M', 15],
        ['MA15+', 15],
        ['R18+', 18],
        ['X18+', 18],
        ['E', 0],
        ['Australia:MA 15+', 15],
        // Netherlands, France, Spain
        ['AL', 0],
        ['9', 9],
        ['14', 14],
        ['Kijkwijzer 12', 12],
        ['Tous publics', 0],
        ['TP', 0],
        ['-10', 10],
        ['-12', 12],
        ['-16', 16],
        ['FR:-18', 18],
        ['+7', 7],
        ['+18', 18],
        ['APTA', 0],
        ['Todos los públicos', 0],
    ])('table: %s → %s', (cert, expected) => {
        expect(certificationToAge(cert)).toBe(expected);
    });

    it.each([
        'NR',
        'Unrated',
        'UNRATED',
        'Not Rated',
        'Germany:Not Rated',
        'N/A',
        'None',
        'Season 2',
        'Sweden:15',
        'Taiwan:R',
        'Ab 99',
        '45',
        'garbage',
        '   ',
    ])('returns null for %j', (cert) => {
        expect(certificationToAge(cert)).toBeNull();
    });
});
