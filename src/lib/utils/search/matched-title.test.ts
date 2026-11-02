// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
    matchKeysForSql,
    primaryTitleMatches,
    secondaryTitle,
    selectMatchedTitle,
} from './matched-title';

describe('stored search title selection', () => {
    const primary = 'The Worst Witch';
    it('returns the actual stored alias, including substring queries', () => {
        expect(
            selectMatchedTitle(primary, 'Eine lausige Hexe', ['Eine lausige Hexe', 'A Bad Witch']),
        ).toBe('Eine lausige Hexe');
        expect(selectMatchedTitle(primary, 'lausige', ['Eine lausige Hexe'])).toBe(
            'Eine lausige Hexe',
        );
    });
    it('prefers exact stored matches deterministically', () => {
        const titles = ['Eine lausige Hexe: Extras', 'Eine lausige Hexe'];
        expect(selectMatchedTitle(primary, 'Eine lausige Hexe', titles)).toBe('Eine lausige Hexe');
        expect(selectMatchedTitle(primary, 'Eine lausige Hexe', [...titles].reverse())).toBe(
            'Eine lausige Hexe',
        );
    });
    it('omits primary hits, equivalent aliases, empty and unrelated metadata hits', () => {
        expect(selectMatchedTitle(primary, 'worst', ['Eine lausige Hexe'])).toBeUndefined();
        expect(
            selectMatchedTitle(primary, 'someone in the overview', ['Eine lausige Hexe']),
        ).toBeUndefined();
        expect(selectMatchedTitle(primary, 'lausige', [])).toBeUndefined();
        expect(secondaryTitle(' THE—WÓRST   WITCH! ', primary)).toBeUndefined();
        expect(secondaryTitle('   ', primary)).toBeUndefined();
        expect(secondaryTitle(undefined, primary)).toBeUndefined();
    });
    it('suppresses the explanation when the language overlay already displays it', () => {
        expect(
            selectMatchedTitle('Eine lausige Hexe', 'Eine lausige Hexe', [
                'Eine lausige Hexe',
                primary,
            ]),
        ).toBeUndefined();
    });
});

describe('word and German title matching', () => {
    it('matches rearranged terms, intervening words and prefixes', () => {
        expect(
            selectMatchedTitle('Other title', 'Hexe lausige', ['Eine lausige kleine Hexe']),
        ).toBe('Eine lausige kleine Hexe');
        expect(selectMatchedTitle('Other title', 'laus hex', ['Eine lausige Hexe'])).toBe(
            'Eine lausige Hexe',
        );
        expect(
            selectMatchedTitle('Eine lausige kleine Hexe', 'Hexe lausige', [
                'Another Hexe lausige',
            ]),
        ).toBeUndefined();
    });
    it('does not erase boundaries to manufacture a match', () => {
        expect(selectMatchedTitle('Other title', 'AB CD', ['ABCD'])).toBeUndefined();
        expect(selectMatchedTitle('Other title', 'ab cd', ['Xabcd Y'])).toBeUndefined();
    });
    it('folds German spellings for matching, retaining stored display text', () => {
        expect(selectMatchedTitle('Other title', 'strasse', ['Die Straße'])).toBe('Die Straße');
        expect(
            selectMatchedTitle('Other title', 'maedchen loewe gruen', [
                'Das Mädchen, der Löwe und Grün',
            ]),
        ).toBe('Das Mädchen, der Löwe und Grün');
        expect(selectMatchedTitle('Das Mädchen', 'maedchen', ['Other Maedchen'])).toBeUndefined();
    });
    it('uses the stored canonical title when a language overlay changed the primary', () => {
        expect(selectMatchedTitle('Eine lausige Hexe', 'worst witch', ['The Worst Witch'])).toBe(
            'The Worst Witch',
        );
    });
});

describe('database-compatible accent matching', () => {
    it.each([
        ['Łowca', 'Lowca'],
        ['Ørnen', 'Ornen'],
        ['Đavolji', 'Davolji'],
        ['Ðagur', 'Dagur'],
        ['Þor', 'Thor'],
        ['Æon Flux', 'Aeon Flux'],
        ['Œuvre', 'Oeuvre'],
        ['Shōrai', 'Shorai'],
    ])('preserves stored %s when searched as %s', (stored, query) => {
        expect(selectMatchedTitle('Other title', query, [stored])).toBe(stored);
        expect(selectMatchedTitle('Other title', stored, [query])).toBe(query);
        expect(selectMatchedTitle(stored, query, ['Another ' + query])).toBeUndefined();
        expect(secondaryTitle(stored, query)).toBeUndefined();
    });
    it('preserves ASCII digraphs rather than manufacturing a different title match', () => {
        expect(selectMatchedTitle('Other title', 'Pot', ['Poet'])).toBeUndefined();
        expect(selectMatchedTitle('Other title', 'Maestro', ['Mastro'])).toBeUndefined();
        expect(selectMatchedTitle('Other title', 'Poet', ['Pot'])).toBeUndefined();
    });
});

describe('SQL match helpers', () => {
    it('primaryTitleMatches agrees with selectMatchedTitle suppression', () => {
        expect(primaryTitleMatches('The Worst Witch', 'worst')).toBe(true);
        expect(primaryTitleMatches('The Worst Witch', 'lausige')).toBe(false);
        expect(primaryTitleMatches('Ärger', 'aerger')).toBe(true);
    });
    it('matchKeysForSql emits normalized whole keys and words, dropping one-letter queries', () => {
        expect(matchKeysForSql('Élan  Vital!')).toEqual([
            { text: 'elan vital', words: ['elan', 'vital'] },
        ]);
        expect(matchKeysForSql('Grüße').map((key) => key.text)).toEqual(['grusse', 'gruesse']);
        expect(matchKeysForSql('x')).toEqual([]);
    });
});
