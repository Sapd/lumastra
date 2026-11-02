// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { stripNarratorSuffix } from './audiobook-title';

describe('stripNarratorSuffix', () => {
    it('strips the German "Gesprochen von" credit that ABS bakes into the title', () => {
        expect(
            stripNarratorSuffix(
                'Milo Farrow und der Stein der Weisen - Gesprochen von Felix Vale',
                ['Felix Vale'],
            ),
        ).toBe('Milo Farrow und der Stein der Weisen');
    });

    it('is language-agnostic — the connector phrase is never matched, only the name', () => {
        for (const connector of ['Narrated by', 'Read by', 'gelesen von', 'Lu par', '']) {
            expect(
                stripNarratorSuffix(`Some Book - ${connector} Felix Vale`.replace('  ', ' '), [
                    'Felix Vale',
                ]),
            ).toBe('Some Book');
        }
    });

    it('strips a bracketed credit', () => {
        expect(
            stripNarratorSuffix('Der Wanderer (Gesprochen von Gero Lindenwald)', [
                'Gero Lindenwald',
            ]),
        ).toBe('Der Wanderer');
    });

    it('strips only the LAST segment of a multi-separator title', () => {
        expect(
            stripNarratorSuffix('KLMN - Das leere Grab im Moor - Gesprochen von Sascha Fenwick', [
                'Sascha Fenwick',
            ]),
        ).toBe('KLMN - Das leere Grab im Moor');
    });

    it('handles en/em dashes, pipes and colons as separators', () => {
        expect(stripNarratorSuffix('Buch – Felix Vale', ['Felix Vale'])).toBe('Buch');
        expect(stripNarratorSuffix('Buch — Felix Vale', ['Felix Vale'])).toBe('Buch');
        expect(stripNarratorSuffix('Buch | Felix Vale', ['Felix Vale'])).toBe('Buch');
        expect(stripNarratorSuffix('Buch: gelesen von Felix Vale', ['Felix Vale'])).toBe('Buch');
    });

    it('matches case- and whitespace-insensitively', () => {
        expect(stripNarratorSuffix('Buch -  gesprochen  von   FELIX   VALE ', ['Felix Vale'])).toBe(
            'Buch',
        );
    });

    // ---- the "leave it alone" half of the contract -------------------------

    it('leaves the title alone when no narrators are known', () => {
        const title = 'Milo Farrow und der Stein der Weisen - Gesprochen von Felix Vale';
        expect(stripNarratorSuffix(title, [])).toBe(title);
        expect(stripNarratorSuffix(title, undefined)).toBe(title);
    });

    it('leaves the title alone when the trailing segment is not the narrator', () => {
        const title = 'Der Hüter der Lichter - Die Begleiter';
        expect(stripNarratorSuffix(title, ['Armin Hölzner'])).toBe(title);
    });

    it('leaves the title alone when there is no separator', () => {
        expect(stripNarratorSuffix('Felix Vale liest Milo Farrow', ['Felix Vale'])).toBe(
            'Felix Vale liest Milo Farrow',
        );
    });

    it('does not match a narrator name across a word boundary', () => {
        // "Vale" is the narrator here, but "Steinvale" is part of the title.
        expect(stripNarratorSuffix('Früchte des Nebels - Jon Steinvale', ['Vale'])).toBe(
            'Früchte des Nebels - Jon Steinvale',
        );
    });

    it('refuses to strip an over-long trailing segment', () => {
        const long =
            'Buch - Eine vollständige und ungekürzte Lesung des gesamten Werkes vorgetragen von Felix Vale';
        expect(stripNarratorSuffix(long, ['Felix Vale'])).toBe(long);
    });

    it('refuses to reduce the title to a fragment', () => {
        expect(stripNarratorSuffix('A - Felix Vale', ['Felix Vale'])).toBe('A - Felix Vale');
    });

    it('ignores a one-character narrator entry', () => {
        expect(stripNarratorSuffix('Buch - Etwas Anderes', ['X'])).toBe('Buch - Etwas Anderes');
    });

    it('is a no-op on empty/blank input', () => {
        expect(stripNarratorSuffix('', ['Felix Vale'])).toBe('');
        expect(stripNarratorSuffix(undefined, ['Felix Vale'])).toBe('');
        expect(stripNarratorSuffix(null, ['Felix Vale'])).toBe('');
    });
});
