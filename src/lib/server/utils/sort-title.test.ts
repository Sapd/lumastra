// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the sort-title derivation helper.
 *
 * Verifies that non-Latin (Hangul/CJK), punctuation-first and article-prefixed
 * titles all collapse to a sensible, lowercase, collation-stable sort key —
 * the fix for Korean/CJK series being buried after "Z" in A-Z browse.
 */

import { describe, it, expect } from 'vitest';
import { deriveSortTitle, romanizeHangul } from './sort-title.js';

/** First bucket letter the A-Z view would compute for a sort key. */
function bucketOf(key: string): string {
    return /^[a-z]/.test(key) ? key[0].toUpperCase() : '#';
}

describe('romanizeHangul', () => {
    it('romanizes a simple syllable (사 → sa)', () => {
        expect(romanizeHangul('사')).toBe('sa');
    });

    it('romanizes syllables with a final consonant (랑 → rang, 은 → eun)', () => {
        expect(romanizeHangul('랑')).toBe('rang');
        expect(romanizeHangul('은')).toBe('eun');
    });

    it('romanizes a full Korean title to leading "s"', () => {
        const r = romanizeHangul('사랑은 별빛에서');
        expect(r.startsWith('sarangeun')).toBe(true);
    });

    it('passes non-Hangul characters through unchanged', () => {
        expect(romanizeHangul('The Lantern')).toBe('The Lantern');
        expect(romanizeHangul('星灯命运')).toBe('星灯命运');
        expect(romanizeHangul('逃げる')).toBe('逃げる');
    });
});

describe('deriveSortTitle', () => {
    it('puts a Hangul-titled series with no english_title under "S"', () => {
        const key = deriveSortTitle('사랑은 별빛에서', null, null);
        expect(bucketOf(key)).toBe('S');
    });

    it('uses english_title as the seed when present (星灯命运 → "Keeper of Lanterns…" → K)', () => {
        const key = deriveSortTitle('星灯命运', 'The Keeper of Lanterns: Destiny', '星灯命运');
        expect(key).toBe('keeper of lanterns: destiny');
        expect(bucketOf(key)).toBe('K');
    });

    it('strips a leading article', () => {
        expect(deriveSortTitle('The Lantern')).toBe('lantern');
        expect(deriveSortTitle('A Bright Harbor')).toBe('bright harbor');
        expect(deriveSortTitle('An Invisible Harbor')).toBe('invisible harbor');
    });

    it('does not strip "a"/"an" when not a standalone leading article', () => {
        expect(deriveSortTitle('Ant-Keeper')).toBe('ant-keeper');
        expect(deriveSortTitle('Andara')).toBe('andara');
    });

    it('strips leading punctuation so ".harbor" buckets under H', () => {
        const key = deriveSortTitle('.harbor');
        expect(key).toBe('harbor');
        expect(bucketOf(key)).toBe('H');
    });

    it('strips leading brackets ("[Orion No Mori]" → "orion no mori]")', () => {
        const key = deriveSortTitle('[Orion No Mori] - [Mein*Licht]');
        expect(bucketOf(key)).toBe('O');
    });

    it('strips an article that re-exposes leading punctuation', () => {
        // english_title is `The "Harbor" Prince…` → after "the " the quote must
        // also be stripped so it buckets under H, not "#".
        const key = deriveSortTitle('The Harbor Prince', 'The "Harbor" Prince and the Stony Cat');
        expect(key.startsWith('harbor')).toBe(true);
        expect(bucketOf(key)).toBe('H');
    });

    it('keeps a digit-leading title under "#" after stripping the article', () => {
        // "The 100 Lanterns…" → "100 lanterns…" → "#" (correct: digit-led).
        const key = deriveSortTitle('The 100 Lanterns That Really Guide You');
        expect(bucketOf(key)).toBe('#');
    });

    it('folds diacritics so accented Latin buckets under its base letter', () => {
        // "Übler Wind" must sort under U (not into "#" after Z) for a German audience.
        const key = deriveSortTitle('Übler Wind');
        expect(key).toBe('ubler wind');
        expect(bucketOf(key)).toBe('U');
    });

    it('folds full-width Latin to ASCII', () => {
        expect(deriveSortTitle('ＺＯＯＭ')).toBe('zoom');
    });

    it('routes dictionary-only CJK (no english_title) into the "#" bucket', () => {
        const key = deriveSortTitle('静かな港の物語', null, null);
        expect(bucketOf(key)).toBe('#');
    });

    it('never returns an empty key (punctuation-only title falls back)', () => {
        const key = deriveSortTitle('!!!');
        expect(key.length).toBeGreaterThan(0);
    });

    it('produces deterministic, comparable lowercase keys', () => {
        const a = deriveSortTitle('Zephyr Land Saga');
        const b = deriveSortTitle('사랑은 별빛에서');
        // Korean romanizes to "s…", which sorts before "z…" under byte order.
        expect(a > b).toBe(true);
    });
});

describe('deriveSortTitle — language-aware article stripping', () => {
    it('leaves every existing caller untouched when no language is passed', () => {
        // Historical English-only behaviour. Any change here re-sorts stored
        // keys for movies/TV/music, which is why language is opt-in.
        expect(deriveSortTitle('The Lantern')).toBe('lantern');
        expect(deriveSortTitle('A Lanterns of Winter')).toBe('lanterns of winter');
        expect(deriveSortTitle('Der Hüter der Lichter')).toBe('der huter der lichter');
        expect(deriveSortTitle('Die Harbor')).toBe('die harbor');
    });

    it('strips German articles for a German library', () => {
        expect(deriveSortTitle('Der Hüter der Lichter', null, null, 'de')).toBe(
            'huter der lichter',
        );
        expect(deriveSortTitle('Die sieben ???', null, null, 'de')).toBe('sieben ???');
        expect(deriveSortTitle('Das Lichtbild', null, null, 'de')).toBe('lichtbild');
        expect(deriveSortTitle('Ein Rätsel für KLMN', null, null, 'de')).toBe('ratsel fur klmn');
    });

    it('does NOT strip German articles from an English library', () => {
        // The reason the list is language-scoped rather than unioned.
        expect(deriveSortTitle('Die Harbor', null, null, 'en')).toBe('die harbor');
        expect(deriveSortTitle('Das Licht', null, null, 'en')).toBe('das licht');
    });

    it('accepts BCP-47 tags and the endonyms AudiobookShelf writes', () => {
        expect(deriveSortTitle('Der Sternwind', null, null, 'de-DE')).toBe('sternwind');
        expect(deriveSortTitle('Der Sternwind', null, null, 'German')).toBe('sternwind');
        expect(deriveSortTitle('Der Sternwind', null, null, 'DEUTSCH')).toBe('sternwind');
    });

    it('falls back to English for an unknown or empty language', () => {
        expect(deriveSortTitle('The Shore', null, null, 'klingon')).toBe('shore');
        expect(deriveSortTitle('Der Sternwind', null, null, 'klingon')).toBe('der sternwind');
        expect(deriveSortTitle('The Shore', null, null, '')).toBe('shore');
    });

    it('handles apostrophe-elided articles only where the language uses them', () => {
        expect(deriveSortTitle("L'Éclaireur", null, null, 'fr')).toBe('eclaireur');
        expect(deriveSortTitle("L'Amica luminosa", null, null, 'it')).toBe('amica luminosa');
        // English keeps them — "D'Artagnan" is a name, not an elided article.
        expect(deriveSortTitle("D'Artagnan", null, null, 'en')).toBe("d'artagnan");
    });

    it('uses English articles when an English title seeded the key', () => {
        // The key is English even though the library is German.
        expect(deriveSortTitle('Der Wächter', 'The Gatekeeper', null, 'de')).toBe('gatekeeper');
    });

    it('still strips interleaved punctuation and articles', () => {
        expect(deriveSortTitle('Die "Sieben" Laternenzeichen', null, null, 'de')).toBe(
            'sieben" laternenzeichen',
        );
        expect(deriveSortTitle('65 - Als der Hüter sich verlor', null, null, 'de')).toBe(
            '65 - als der huter sich verlor',
        );
    });
});
