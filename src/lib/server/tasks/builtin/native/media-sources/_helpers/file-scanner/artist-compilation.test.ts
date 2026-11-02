// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parseArtistNames } from './audio-processor.js';
import { buildArtistCreditEvidence, resolveArtistCredit } from './artist-credit.js';
import { COMPILATION_ARTIST_THRESHOLD } from '$lib/shared/various-artists.js';

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Guards the detection that the scanner's "collapse to Various Artists" logic
 * relies on: a real compilation credit must parse into >= the threshold count,
 * while genuine collaborations stay below it.
 */
describe('oversized compilation detection', () => {
    // The real-world row that motivated the feature (TechnoBase.FM 40 sampler).
    const COMPILATION_CREDIT =
        '89ers, Scotty, Aquagen, Jens O., Neptunica, Mairee, KYANU, ' +
        'Lady Luminis, SubControllZ, NoYesMan, AlphaStar!, Casaris, ' +
        'Nick Unique, Art Directors, DJ Fenwick, Picco, Beachbag, ' +
        'Jerome, BRAMD, Kat, Alex Megane, DJ LHT, Dan Fenwick, ' +
        'Manuel Lauren, Harbor Bounce, Deso Latee';

    it('parses a large sampler credit into >= the compilation threshold', () => {
        const names = parseArtistNames(COMPILATION_CREDIT);
        expect(names.length).toBeGreaterThanOrEqual(COMPILATION_ARTIST_THRESHOLD);
    });

    it('keeps a genuine 2-way collaboration below the threshold', () => {
        expect(parseArtistNames('Calvin Fenwick & Dua Lipa').length).toBeLessThan(
            COMPILATION_ARTIST_THRESHOLD,
        );
    });

    it('keeps a small comma collaboration below the threshold', () => {
        expect(parseArtistNames('Sonny, Cher, Elvis').length).toBeLessThan(
            COMPILATION_ARTIST_THRESHOLD,
        );
    });

    it('does not over-split a band name with an internal comma + "The"', () => {
        // "The X" guard keeps this as a single artist, well below the threshold.
        expect(parseArtistNames('Tyler, The Creator').length).toBeLessThan(
            COMPILATION_ARTIST_THRESHOLD,
        );
    });
});

describe('parseArtistNames — " x " collaboration separator', () => {
    it('splits an "A x B x C" EDM/pop collab into individual artists', () => {
        // Real prod row (Moi Liora) — the "x" separator used to squash all
        // three credits into one artist because it was not a collab marker.
        expect(parseArtistNames('Liora Vale x Lantern Pitch x Lanternlovers United')).toEqual([
            'Liora Vale',
            'Lantern Pitch',
            'Lanternlovers United',
        ]);
    });

    it('is case-insensitive on the "x" marker', () => {
        expect(parseArtistNames('MØ X Diplo')).toEqual(['MØ', 'Diplo']);
    });

    it('only splits on a space-flanked "x", not an "x" inside a name', () => {
        // No surrounding whitespace → not a separator; the name stays intact.
        expect(parseArtistNames('Lanternxman')).toEqual(['Lanternxman']);
    });
});

describe('parseArtistNames — German "und" conjunction', () => {
    // "und" is an AMBIGUOUS joiner ("Peter und die Firma" is one act): the
    // evidence-free parse keeps it whole and the library evidence decides.
    const evidence = buildArtistCreditEvidence([
        'DJ Antoine',
        'DJ Antoine feat. Tom',
        'Mad Mark',
        'Mad Mark & Someone',
    ]);

    it('splits "A und B" once the library proves both parts (the reported case)', () => {
        expect(parseArtistNames('DJ Antoine und Mad Mark')).toEqual(['DJ Antoine und Mad Mark']);
        expect(resolveArtistCredit('DJ Antoine und Mad Mark', evidence)).toEqual([
            'DJ Antoine',
            'Mad Mark',
        ]);
    });

    it('is case-insensitive and only treats a space-flanked "und" as a joiner', () => {
        expect(resolveArtistCredit('DJ Antoine UND Mad Mark', evidence)).toEqual([
            'DJ Antoine',
            'Mad Mark',
        ]);
        // "und" inside a word must not split.
        expect(parseArtistNames('Fundgrube')).toEqual(['Fundgrube']);
    });

    it('does not split when a part begins with a German article', () => {
        // "die Firma" begins with an article → treated as one act, not split.
        expect(parseArtistNames('Peter und die Firma')).toEqual(['Peter und die Firma']);
    });

    it('keeps a single act whose name repeats around "und" (dedup)', () => {
        // "Ich und Ich" is one band — identical parts dedupe to a single name,
        // so it is not treated as a 2-way collaboration.
        expect(parseArtistNames('Ich und Ich')).toEqual(['Ich und Ich']);
    });

    it('still prefers a high-confidence marker over "und"', () => {
        // "&" wins; "und" is only consulted when no confident marker is present.
        expect(parseArtistNames('A und B feat. C')).toEqual(['A und B', 'C']);
    });
});
