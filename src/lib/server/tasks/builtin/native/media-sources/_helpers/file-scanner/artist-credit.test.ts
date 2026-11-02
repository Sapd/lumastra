// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    atomizeArtistCredit,
    buildArtistCreditEvidence,
    countArtistCreditAtoms,
    mergeSlashSplitCredits,
    NO_ARTIST_CREDIT_EVIDENCE,
    parseArtistNames,
    resolveArtistCredit,
} from './artist-credit.js';

/**
 * Example names are fictional; production shapes and measurements are retained.
 * A slice of the production library's real ARTIST tags (2026-09-29). The cases
 * below are the ones the old unconditional " & " split got wrong or right.
 */
const LIBRARY_TAGS = [
    'Rowan & Cian',
    'Rowan & Cian Feat. Sundale',
    'Rowan & Cian feat. Lindenvale',
    'rowan and cian',
    'Rowan & Cian, HarborBrothers',
    'Cian, Nora',
    'HarborBrothers',
    'HarborBrothers feat. Carlprit',
    'Wilhart',
    'Wilhart & Solara',
    'Wilhart & DrumMasterz',
    'Wilhart & The Nation',
    'Sashman & Wilhart',
    'SashMan',
    'SashMan & Toryn',
    'Blasterjaxx',
    'Hardwell & Blasterjaxx',
    'Blasterjaxx & Harris & Ford',
    'Harris & Ford',
    'Harris & Ford feat. Jöli',
    'Echo & The Lanternfolk',
    'Earth, Wind & Fire',
    'W&W',
    'W&W x Harris & Ford',
    'Ray & Anita',
    'Grrtz',
    'Alari & Grrtz',
    'Frede & Grrtz',
    'Cloud Seven & Grrtz',
    'Alari',
    'Alari feat. Vane',
];

const evidence = buildArtistCreditEvidence(LIBRARY_TAGS, ['Above & Lanterns']);

describe('parseArtistNames (evidence-free)', () => {
    it('splits strong markers but keeps an ambiguous group whole', () => {
        expect(parseArtistNames('Rowan & Cian Feat. Sundale')).toEqual(['Rowan & Cian', 'Sundale']);
        expect(parseArtistNames('Liora Vale x Lantern Pitch x Lanternlovers United')).toEqual([
            'Liora Vale',
            'Lantern Pitch',
            'Lanternlovers United',
        ]);
    });

    it('never treats a joiner without whitespace as a join', () => {
        expect(parseArtistNames('W&W')).toEqual(['W&W']);
        expect(parseArtistNames('G&g Feat. Gary Wright & Baby Brown')).toEqual([
            'G&g',
            'Gary Wright & Baby Brown',
        ]);
        expect(parseArtistNames('+44')).toEqual(['+44']);
    });

    it('still splits a plain comma list, but not "Tyler, The Creator"', () => {
        expect(parseArtistNames('Alari, Grrtz')).toEqual(['Alari', 'Grrtz']);
        expect(parseArtistNames('Tyler, The Creator')).toEqual(['Tyler, The Creator']);
        expect(parseArtistNames('A,')).toEqual(['A']);
    });
});

describe('resolveArtistCredit — library evidence', () => {
    it('keeps a duo whose parts never appear apart (the reported case)', () => {
        expect(resolveArtistCredit('Rowan & Cian Feat. Sundale', evidence)).toEqual([
            'Rowan & Cian',
            'Sundale',
        ]);
        expect(resolveArtistCredit('Rowan And Cian', evidence)).toEqual(['Rowan And Cian']);
        // One unrelated "Cian" ("Cian, Nora") is below the independence bar.
        expect(resolveArtistCredit('Rowan & Cian', evidence)).toEqual(['Rowan & Cian']);
    });

    it('splits a real collaboration whose parts stand alone elsewhere', () => {
        expect(resolveArtistCredit('Wilhart & Solara', evidence)).toEqual(['Wilhart', 'Solara']);
        expect(resolveArtistCredit('Alari & Grrtz', evidence)).toEqual(['Alari', 'Grrtz']);
        // Only Frede is unproven; Grrtz is independent, so both come apart.
        expect(resolveArtistCredit('Frede & Grrtz', evidence)).toEqual(['Frede', 'Grrtz']);
    });

    it('glues the dependent run back together inside a longer credit', () => {
        expect(resolveArtistCredit('Blasterjaxx & Harris & Ford', evidence)).toEqual([
            'Blasterjaxx',
            'Harris & Ford',
        ]);
        expect(resolveArtistCredit('Rowan & Cian, HarborBrothers', evidence)).toEqual([
            'Rowan & Cian',
            'HarborBrothers',
        ]);
    });

    it('keeps band names that only look like a join', () => {
        expect(resolveArtistCredit('Echo & The Lanternfolk', evidence)).toEqual([
            'Echo & The Lanternfolk',
        ]);
        expect(resolveArtistCredit('Earth, Wind & Fire', evidence)).toEqual(['Earth, Wind & Fire']);
        expect(resolveArtistCredit('W & W', evidence)).toEqual(['W & W']);
        expect(resolveArtistCredit('Ich und Ich', evidence)).toEqual(['Ich und Ich']);
        expect(resolveArtistCredit('W&W x Harris & Ford', evidence)).toEqual([
            'W&W',
            'Harris & Ford',
        ]);
    });

    it('never splits a known act, even when a part is independent', () => {
        const withAbove = buildArtistCreditEvidence(
            ['Above', 'Above feat. X', 'Above & Lanterns'],
            ['Above & Lanterns'],
        );
        expect(resolveArtistCredit('Above & Lanterns', withAbove)).toEqual(['Above & Lanterns']);
    });

    it('keeps every ambiguous group whole without evidence', () => {
        expect(resolveArtistCredit('Santiano & Nathan Evans', NO_ARTIST_CREDIT_EVIDENCE)).toEqual([
            'Santiano & Nathan Evans',
        ]);
    });

    it('does not read a known act as evidence for its parts', () => {
        // Prod: "Above & Lanterns" (no_split) made "Lanterns" look independent and
        // split "Way and Lanterns", a different act.
        const e = buildArtistCreditEvidence(
            [
                'Above & Lanterns',
                'above und lanterns',
                'Kate Fenwick & Lanterns',
                'MD Lantern vs. Way and Lanterns',
            ],
            ['Above & Lanterns'],
        );
        expect(resolveArtistCredit('MD Lantern vs. Way and Lanterns feat. Johanna', e)).toEqual([
            'MD Lantern',
            'Way and Lanterns',
            'Johanna',
        ]);
    });

    it('ignores sampler credits as evidence', () => {
        // Two different 6+ name sampler tags mention a "Cian" without Rowan —
        // that must not make the Cian of "Rowan & Cian" an artist of his own.
        const e = buildArtistCreditEvidence([
            'Rowan & Cian',
            'A, B, C, D, E & Cian',
            'F, G, H, I, J, Cian',
        ]);
        expect(resolveArtistCredit('Rowan & Cian', e)).toEqual(['Rowan & Cian']);
    });

    it('counts duplicate spellings of one tag once', () => {
        // "Ray" appears only in "Ray & Anita"; the two spellings are one tag.
        const e = buildArtistCreditEvidence(['Ray & Anita', 'ray & anita', 'RAY  &  ANITA']);
        expect(resolveArtistCredit('Ray & Anita', e)).toEqual(['Ray & Anita']);
    });
});

describe('atom counting (compilation detection)', () => {
    it('counts every name an "&"-joined sampler could credit', () => {
        const sampler = 'Pinball & Topmodelz & Aquagen & Scotty & 89ers & Deso Latee';
        expect(countArtistCreditAtoms(sampler)).toBe(6);
        expect(parseArtistNames(sampler)).toHaveLength(1);
    });

    it('atomizes across strong and ambiguous joiners', () => {
        expect(atomizeArtistCredit('Rowan & Cian, HarborBrothers feat. X')).toEqual([
            'Rowan',
            'Cian',
            'HarborBrothers',
            'X',
        ]);
    });
});

/**
 * Shapes of the production ARTIST tags (2026-10-15) that created artist rows
 * named "& …", "feat. …", "Vs. …", "x …" and "\ …". Names fictional.
 */
describe('names ending in "X", Oxford commas and dangling joiners', () => {
    it.each([
        ['Ziggo X &  Bohold', ['Ziggo X &  Bohold']],
        ['ZIGGO X & Dropexx', ['ZIGGO X & Dropexx']],
        ['Ziggo X feat. Kilo MC', ['Ziggo X', 'Kilo MC']],
        ['Ziggo X Feat. Sedan', ['Ziggo X', 'Sedan']],
        ['Nova Distra X Vs. Kaylo', ['Nova Distra X', 'Kaylo']],
        ['Talvo 2XLC, Para X feat. Marlo Lenz', ['Talvo 2XLC, Para X', 'Marlo Lenz']],
        ['Andor Rayne & Digitar X Feat. Sylva Tor', ['Andor Rayne & Digitar X', 'Sylva Tor']],
        ['Axo x Ziggo X x DJ Sequa', ['Axo', 'Ziggo X', 'DJ Sequa']],
        ['Axo x X Embassy', ['Axo', 'X Embassy']],
        ['AXO X X EMBASSY', ['AXO', 'X EMBASSY']],
        ['Axo x And One', ['Axo', 'And One']],
        ['W, x Axo', ['W', 'Axo']],
    ])('%s → %j', (tag, expected) => {
        expect(parseArtistNames(tag)).toEqual(expected);
        for (const name of resolveArtistCredit(tag, NO_ARTIST_CREDIT_EVIDENCE)) {
            // No fragment row: a leading joiner, or a lowercase " x " marker
            // ("X Embassy" is a name).
            expect(name).not.toMatch(/^(?:[&+,\\]|(?:[Ff]eat|[Ff]t|[Vv]s)\.\s|x\s)/);
        }
    });

    it('still splits a plain " x " collab and keeps names that start with X or Ft', () => {
        expect(parseArtistNames('Rocco X Pulsar X Ninko')).toEqual(['Rocco', 'Pulsar', 'Ninko']);
        expect(parseArtistNames('X Embassy')).toEqual(['X Embassy']);
        expect(parseArtistNames('Ft Unity Feat. Goldstar')).toEqual(['Ft Unity', 'Goldstar']);
        expect(parseArtistNames('Ziggo X')).toEqual(['Ziggo X']);
        for (const name of ['X Embassy', 'Ft Unity', '+44', '& Co', 'Ziggo X']) {
            expect(resolveArtistCredit(name, NO_ARTIST_CREDIT_EVIDENCE)).toEqual([name]);
        }
    });

    it('treats an Oxford comma as one boundary', () => {
        const e = buildArtistCreditEvidence(['Vizo', 'Vizo feat. Jo', 'Imanbo', 'Imanbo x Lu']);
        expect(resolveArtistCredit('VIZO, Imanbo, & Dieter Bolt feat. Leora', e)).toEqual([
            'VIZO',
            'Imanbo',
            'Dieter Bolt',
            'Leora',
        ]);
        expect(resolveArtistCredit('Vizo, Imanbo, and Dieter Bolt', e)).toEqual([
            'Vizo',
            'Imanbo',
            'Dieter Bolt',
        ]);
        // A capitalised "And" after a comma starts a name: the band "And One".
        expect(resolveArtistCredit('Vizo, And One', e)).toEqual(['Vizo', 'And One']);
        expect(atomizeArtistCredit('Vizo, Imanbo, & Dieter Bolt')).toEqual([
            'Vizo',
            'Imanbo',
            'Dieter Bolt',
        ]);
    });

    it('splits the " X & …" credit only where the library proves the parts', () => {
        const e = buildArtistCreditEvidence([
            'Ziggo X',
            'Ziggo X feat. Kilo MC',
            'Ziggo X & Bohold',
            'Ziggo X & Dropexx',
        ]);
        expect(resolveArtistCredit('Ziggo X & Bohold', e)).toEqual(['Ziggo X', 'Bohold']);
    });
});

describe('mergeSlashSplitCredits', () => {
    it('re-joins an ID3v2.3 "/" split at a "/\\" styling', () => {
        expect(mergeSlashSplitCredits(['Axel', '\\ Ingo'])).toEqual(['Axel /\\ Ingo']);
        expect(mergeSlashSplitCredits(['Axel', '\\Ingo'])).toEqual(['Axel/\\Ingo']);
    });

    it('leaves real multi-value lists alone', () => {
        expect(mergeSlashSplitCredits(['Foo', 'Bar'])).toEqual(['Foo', 'Bar']);
        expect(mergeSlashSplitCredits(['\\ Lead'])).toEqual(['\\ Lead']);
    });
});

describe('hostile tag text', () => {
    // A tag frame can be megabytes. Whitespace-led separators were quadratic on a
    // long whitespace run, so one 40 KB ARTIST tag cost seconds per call.
    const hostile = `A${' '.repeat(40_000)}B`;
    const BUDGET_MS = 1000;

    function elapsed(fn: () => void): number {
        const start = performance.now();
        fn();
        return performance.now() - start;
    }

    it.each([
        ['parseArtistNames', () => parseArtistNames(hostile)],
        ['atomizeArtistCredit', () => atomizeArtistCredit(hostile)],
        ['countArtistCreditAtoms', () => countArtistCreditAtoms(hostile)],
        ['resolveArtistCredit', () => resolveArtistCredit(hostile, NO_ARTIST_CREDIT_EVIDENCE)],
    ])('%s stays fast on a 40 KB whitespace run', (_name, run) => {
        expect(elapsed(() => run())).toBeLessThan(BUDGET_MS);
    });

    it.each([
        ['an x-marker run', `A ${'x '.repeat(2000)}B`],
        ['an Oxford-comma run', `A${', &'.repeat(1300)} B`],
        ['a comma run before a marker', `A${','.repeat(4000)} x B`],
    ])('stays fast on %s', (_name, tag) => {
        const e = buildArtistCreditEvidence([tag, 'A', 'A feat. C']);
        expect(elapsed(() => resolveArtistCredit(tag, e))).toBeLessThan(BUDGET_MS);
        expect(elapsed(() => atomizeArtistCredit(tag))).toBeLessThan(BUDGET_MS);
    });

    it('still splits a normal credit', () => {
        expect(parseArtistNames('Alpha feat. Beta')).toEqual(['Alpha', 'Beta']);
    });
});
