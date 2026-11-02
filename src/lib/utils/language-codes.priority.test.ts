// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import { sortLanguageCodes, sortByLanguage } from './language-codes';

test('normalizes and deduplicates before putting server languages first', () => {
    expect(
        sortLanguageCodes(
            ['ara', 'eng', 'deu', 'ger', 'fra', 'jpn', 'de-DE'],
            ['de-AT', 'en-US', 'fr'],
        ),
    ).toEqual(['DE', 'EN', 'FR', 'AR', 'JA']);
});
test('absent preferred languages do not add badges; remaining order is deterministic', () => {
    expect(sortLanguageCodes(['jpn', 'spa', 'ara', 'spa'], ['de', 'en'])).toEqual([
        'AR',
        'ES',
        'JA',
    ]);
    expect(sortLanguageCodes([], ['de'])).toEqual([]);
});

test('preserves unmapped languages and leaves unknown tracks last', () => {
    expect(sortLanguageCodes(['ast', 'as', 'und', 'fra'], ['fr'])).toEqual([
        'FR',
        'AS',
        'AST',
        '??',
    ]);
});

test('ranks the original language after every configured server language', () => {
    expect(sortLanguageCodes(['ara', 'jpn', 'eng', 'deu', 'fra'], ['de', 'fr'], 'jpn')).toEqual([
        'DE',
        'FR',
        'JA',
        'AR',
        'EN',
    ]);
    expect(sortLanguageCodes(['eng', 'jpn'], ['en'], 'eng')).toEqual(['EN', 'JA']);
});

test('track ordering keeps same-language variants stable and preserves track identity', () => {
    const tracks = [
        { index: 7, language: 'ara' },
        { index: 4, language: 'jpn' },
        { index: 9, language: 'eng' },
        { index: 2, language: 'deu' },
        { index: 8, language: 'ger' },
    ];
    const sorted = sortByLanguage(tracks, (track) => track.language, ['de', 'en'], 'ja');
    expect(sorted.map((track) => track.index)).toEqual([2, 8, 9, 4, 7]);
    expect(sorted[0]).toBe(tracks[3]);
    expect(tracks.map((track) => track.index)).toEqual([7, 4, 9, 2, 8]);
});
