// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    CONJUNCTION_SYMBOL_REGEX_ERE,
    CONJUNCTION_SYMBOL_REGEX_POSIX,
    CONJUNCTION_WORD_REGEX_ERE,
    CONJUNCTION_WORD_REGEX_POSIX,
    hasArtistConjunctionMarker,
    shouldFlagArtistForSplit,
} from './artist-conjunction.js';

/**
 * BLOCKING-TIER coverage of what the conjunction markers MEAN.
 *
 * Before this file, the only proof that `+44` is not flagged lived in
 * `music-hygiene.queries.integration.test.ts`, and that tier gates nothing:
 *
 *   package.json  → `test`: `vitest run --exclude='**\/*.integration.test.ts'`
 *   test.yml      → the `integration-tests` job is `continue-on-error: true`
 *
 * What the blocking tier did have was a TEXT assertion on the emitted SQL —
 * strong against deleting or inverting the quantifier, silent about a
 * semantics-preserving rewrite that reintroduces the bug in a new spelling.
 *
 * Both halves are needed and both are here or in the two query suites: the text
 * assertions pin that the shipped SQL is still THIS module's rendering; this
 * file pins what that rendering matches.
 */
describe('artist conjunction markers — semantics', () => {
    /**
     * The rendering is what the two queries actually contain — asserted verbatim
     * by `music-hygiene.queries.test.ts` and `artist-merge.queries.test.ts`. If
     * that ever stops being true, those suites fail and the table below is
     * measuring something that no longer ships, so pin the exact strings here
     * too rather than letting a silent re-render slide.
     */
    it('renders the two dialects the two queries are written in', () => {
        expect(CONJUNCTION_WORD_REGEX_POSIX).toBe(
            '[[:space:]]+(feat[.]?|ft[.]?|featuring|vs[.]?|x|und|and)[[:space:]]+',
        );
        expect(CONJUNCTION_SYMBOL_REGEX_POSIX).toBe('[[:space:]]+[&+][[:space:]]+');
        expect(CONJUNCTION_WORD_REGEX_ERE).toBe(
            '\\s+(feat\\.?|ft\\.?|featuring|vs\\.?|x|und|and)\\s+',
        );
        expect(CONJUNCTION_SYMBOL_REGEX_ERE).toBe('\\s+[&+]\\s+');
    });

    /**
     * The two dialects must stay two spellings of ONE pattern. A verbatim
     * compare would only assert they are spelled differently, so the POSIX class
     * is translated to its `\s` equivalent first — the single substitution that
     * separates them.
     *
     * Revert-check (CROSS-WIRE): render one branch from the other dialect's
     * table and this fails; it also fails if a marker is added to one rendering
     * only, which is the drift this whole module exists to make impossible.
     */
    it('spells one pattern two ways, not two patterns', () => {
        const toEre = (posix: string) => posix.split('[[:space:]]').join('\\s');
        expect(toEre(CONJUNCTION_WORD_REGEX_POSIX)).toBe(
            CONJUNCTION_WORD_REGEX_ERE.split('\\.').join('[.]'),
        );
        expect(toEre(CONJUNCTION_SYMBOL_REGEX_POSIX)).toBe(CONJUNCTION_SYMBOL_REGEX_ERE);
    });

    /**
     * The founding constraint of the whole hygiene feature. `+`, `-` and `=` are
     * symbol-only album fixtures and `+44` is a real band; the browser page
     * that lists these findings shows them on page one of a real library. One
     * indefensible row here costs the operator's trust in every count on the
     * page, which is why the must-NOT list is longer than the must list.
     */
    const MUST_NOT_FLAG: readonly [string, string][] = [
        ['+44', 'a band name that GLUES the + to the digits — the original bug'],
        ['AC+DC', 'stylised name, + glued to letters on both sides'],
        ['blink+182', '+ glued between a word and digits'],
        ['Eli Fenwick', 'no marker at all'],
        ['+', 'an Eli Fenwick album title, bare'],
        ['-', 'an Eli Fenwick album title, bare'],
        ['=', 'an Eli Fenwick album title, bare'],
        ['Above&Lanterns', 'unspaced & is not a conjunction'],
        ['Lanternxman', 'the reason the x marker is space-flanked'],
        ['Anderson', '"and" inside a word'],
        ['Brand New', '"and" ending a word'],
        ['Eli Fenwick x', 'trailing marker with no right-hand operand'],
        ['Fenwick+', 'trailing + with nothing after it'],
        ['undertow', '"und" inside a word'],
        ['Bund Deutscher', '"und" ending a word'],
    ];

    it.each(MUST_NOT_FLAG)('does NOT flag %j (%s)', (title) => {
        expect(hasArtistConjunctionMarker(title)).toBe(false);
    });

    /**
     * The markers the merge pass is FOR. This is a heuristic, not a defect list
     * — "Above & Lanterns" is one act and matches anyway — so a match here means
     * "worth an operator's eye", never "wrong".
     */
    const MUST_FLAG: readonly [string, string][] = [
        ['Soren & Fenwick', 'the canonical & case'],
        ['Rowan And Cian', 'English " and " — stored unsplit, so the merge must see it'],
        ['Aria Fenwick + Nora Vale', 'the canonical + case'],
        ['Jay-L feat. Alina Vale', 'feat with the abbreviating dot'],
        ['Jay-L feat Alina Vale', 'feat without the dot'],
        ['A ft. B', 'ft with the dot'],
        ['A featuring B', 'the unabbreviated word'],
        ['A vs. B', 'vs with the dot'],
        ['X und Y', 'the German conjunction'],
        ['Liora Vale x Lantern Pitch', 'the marker the scanner learned first'],
        ['Jay-L FEAT. Alina Vale', 'the word branch is case-insensitive (~*)'],
    ];

    it.each(MUST_FLAG)('flags %j (%s)', (title) => {
        expect(hasArtistConjunctionMarker(title)).toBe(true);
    });

    /**
     * The dot in `feat.` must be a LITERAL dot. If it decays to "any character"
     * — which is what happens when `\.` is written into a JS template literal
     * and JS strips the unrecognised escape before Postgres sees it — then
     * `featx` matches too, and the trap has been hit twice in this series.
     */
    it('treats the abbreviating dot as a literal, not "any character"', () => {
        expect(hasArtistConjunctionMarker('A feat. B')).toBe(true);
        expect(hasArtistConjunctionMarker('A featx B')).toBe(false);
        expect(hasArtistConjunctionMarker('A vsx B')).toBe(false);
    });

    /**
     * `no_split` is the operator escape hatch for the inherent ambiguity of
     * "X & Y". Compared as a STRING against `'true'` because that is what
     * `COALESCE(custom_metadata->>'no_split', '') <> 'true'` does: `->>` renders
     * jsonb `true` and jsonb `"true"` identically, and a JS-truthy test would
     * suppress a row someone had explicitly flagged `false`.
     */
    describe('the no_split escape hatch', () => {
        it('suppresses a flagged row for boolean true and for the string "true"', () => {
            expect(
                shouldFlagArtistForSplit({
                    title: 'Above & Lanterns',
                    custom_metadata: { no_split: true },
                }),
            ).toBe(false);
            expect(
                shouldFlagArtistForSplit({
                    title: 'Above & Lanterns',
                    custom_metadata: { no_split: 'true' },
                }),
            ).toBe(false);
        });

        /**
         * Every case here is JS-TRUTHY except `false`, on purpose. `if (flag)
         * return false` — the obvious way to write this — passes a table that
         * only tries `false`, `undefined` and `null`, because those three are
         * falsy under both readings. The string `'false'` and the string
         * `'yes'` are what separate them, and they are not academic: `->>`
         * renders whatever jsonb holds, so any hand-edited or plugin-written
         * `custom_metadata` reaches here as an arbitrary string.
         */
        it('does not suppress for anything that is merely truthy', () => {
            expect(
                shouldFlagArtistForSplit({
                    title: 'Above & Lanterns',
                    custom_metadata: { no_split: false },
                }),
            ).toBe(true);
            expect(
                shouldFlagArtistForSplit({
                    title: 'Above & Lanterns',
                    custom_metadata: { no_split: 'false' },
                }),
            ).toBe(true);
            expect(
                shouldFlagArtistForSplit({
                    title: 'Above & Lanterns',
                    custom_metadata: { no_split: 'yes' },
                }),
            ).toBe(true);
            expect(
                shouldFlagArtistForSplit({
                    title: 'Above & Lanterns',
                    custom_metadata: { no_split: 1 },
                }),
            ).toBe(true);
            expect(
                shouldFlagArtistForSplit({
                    title: 'Above & Lanterns',
                    custom_metadata: { something_else: true },
                }),
            ).toBe(true);
            expect(shouldFlagArtistForSplit({ title: 'Above & Lanterns' })).toBe(true);
            expect(
                shouldFlagArtistForSplit({ title: 'Above & Lanterns', custom_metadata: null }),
            ).toBe(true);
        });

        it('leaves an unflagged name unflagged whatever the escape hatch says', () => {
            expect(shouldFlagArtistForSplit({ title: '+44' })).toBe(false);
            expect(
                shouldFlagArtistForSplit({ title: '+44', custom_metadata: { no_split: true } }),
            ).toBe(false);
        });
    });
});
