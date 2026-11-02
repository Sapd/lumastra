// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isVariousArtistsName, VARIOUS_ARTISTS_ALIASES } from './various-artists';

describe('isVariousArtistsName — localized aliases', () => {
    it.each([
        'Çeşitli Sanatçılar', // tr
        'Verschiedene Interpreten', // de
        'Varios Artistas', // es
        'Vários Artistas', // pt
        'Artistes Divers', // fr
        'Multi-interprètes', // fr
        'Artisti Vari', // it
        'Verschillende Artiesten', // nl
        'Различные исполнители', // ru
    ])('matches %s', (name) => {
        expect(isVariousArtistsName(name)).toBe(true);
    });

    it('is case-insensitive and trims', () => {
        expect(isVariousArtistsName('  çeşitli sanatçılar ')).toBe(true);
    });

    it('still matches the English aliases', () => {
        for (const n of ['Various Artists', 'VA', 'V.A.', 'V/A', 'Various']) {
            expect(isVariousArtistsName(n)).toBe(true);
        }
    });

    it('does NOT match genuine artists', () => {
        for (const n of ['Darius', 'Finlay', 'Various Cruelties', 'Vari Zanolli']) {
            expect(isVariousArtistsName(n)).toBe(false);
        }
    });

    it('exports the alias list NFC-normalized', () => {
        for (const a of VARIOUS_ARTISTS_ALIASES) {
            expect(a.normalize('NFC')).toBe(a);
        }
    });
});

describe('isVariousArtistsName — scene/ripper release prefixes', () => {
    // Real ALBUMARTIST values found on prod, each of which had minted its own
    // bogus artist row holding a whole compilation (the worst held 473 tracks
    // by 419 different artists).
    it('matches a VA marker used as a prefix on a release title', () => {
        for (const n of [
            'VA - Future Trance Vol 61 (2012)',
            'VA-Technobase.FM.Vol.22-3CD-2018-VOiCE',
            'VA - TechnoBase FM Vol 24 (2019)',
            'VA.-.Technobase.FM.Vol.27-WEB-2020-ZzZz',
            'VA - Technobase Fm Vol 44 (2025)',
            'Various Artists - Bravo Hits 100',
            'various artists — Some Comp',
        ]) {
            expect(isVariousArtistsName(n), n).toBe(true);
        }
    });

    // A false positive here is destructive: this predicate gates diversity
    // caps, station filters, embedding text and display at once.
    it('does not sweep in real names that merely start with "Va"', () => {
        for (const n of [
            'Various Cruelties', // no dash — the original guard, still holds
            'Va-Va Voom', // lowercase alias is not matched
            'Valley - The Band', // "Valley" is not a VA alias
            'Vanessa Mae',
            'VAST',
            'Vader',
        ]) {
            expect(isVariousArtistsName(n), n).toBe(false);
        }
    });

    it('still matches the plain whole-string forms', () => {
        for (const n of ['VA', 'V.A.', 'Various', 'Various Artists']) {
            expect(isVariousArtistsName(n), n).toBe(true);
        }
    });
});
