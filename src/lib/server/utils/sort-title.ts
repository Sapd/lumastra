// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Sort-title derivation
 *
 * Produces a normalized, collation-stable sort key for a media title — the
 * same idea as Jellyfin's `SortName`, Plex's `titleSort` and Kodi's
 * `<sorttitle>`. The key is stored once at write time in
 * `media_items.sort_title` and used for `ORDER BY` and A-Z letter bucketing,
 * so ordering no longer depends on the database's `lc_collate`.
 *
 * Why a precomputed key instead of an `ORDER BY` expression:
 * - Under the prod `en_US.utf8` collation, Hangul/CJK code points sort *after*
 *   `z`, so non-Latin titles (e.g. the Korean series "사랑은 별빛에서") are
 *   buried at the very bottom of the alphabetical list and look "missing".
 * - We romanize Hangul to Latin so those titles bucket under their real first
 *   letter ("사…" → "sa…" → `S`), even when no `english_title` exists.
 *
 * The derived key is **lowercase ASCII** for Latin and Hangul titles. Titles in
 * scripts we cannot romanize without a dictionary (Hanzi/Kanji with no
 * `english_title`) keep their raw characters and deliberately fall into the `#`
 * bucket — which the A-Z view exposes, so they remain reachable.
 *
 * The sort key only affects ORDER/bucket position — the displayed title is
 * always the original `media_items.title`.
 */

// Revised-Romanization (transliteration-style) jamo tables, indexed by the
// position derived from a precomposed Hangul syllable's code point. Values are
// already lowercase Latin. Exact phonetic accuracy is not required: the key
// only needs to be deterministic and produce a sensible leading Latin letter.

/** 19 leading consonants (초성), index = floor((code - 0xAC00) / 588). */
const HANGUL_INITIALS = [
    'g',
    'kk',
    'n',
    'd',
    'tt',
    'r',
    'm',
    'b',
    'pp',
    's',
    'ss',
    '',
    'j',
    'jj',
    'ch',
    'k',
    't',
    'p',
    'h',
] as const;

/** 21 vowels (중성), index = floor(((code - 0xAC00) % 588) / 28). */
const HANGUL_MEDIALS = [
    'a',
    'ae',
    'ya',
    'yae',
    'eo',
    'e',
    'yeo',
    'ye',
    'o',
    'wa',
    'wae',
    'oe',
    'yo',
    'u',
    'wo',
    'we',
    'wi',
    'yu',
    'eu',
    'ui',
    'i',
] as const;

/** 28 trailing consonants (종성), index = (code - 0xAC00) % 28 (0 = none). */
const HANGUL_FINALS = [
    '',
    'g',
    'kk',
    'gs',
    'n',
    'nj',
    'nh',
    'd',
    'l',
    'lg',
    'lm',
    'lb',
    'ls',
    'lt',
    'lp',
    'lh',
    'm',
    'b',
    'bs',
    's',
    'ss',
    'ng',
    'j',
    'ch',
    'k',
    't',
    'p',
    'h',
] as const;

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;

/**
 * Romanize precomposed Hangul syllables (U+AC00–U+D7A3) to Latin using Revised
 * Romanization. Any non-Hangul character (Latin, CJK, kana, punctuation) is
 * passed through unchanged, so this is safe to run over any title.
 */
export function romanizeHangul(input: string): string {
    let out = '';
    for (const ch of input) {
        const code = ch.codePointAt(0);
        if (code !== undefined && code >= HANGUL_BASE && code <= HANGUL_LAST) {
            const s = code - HANGUL_BASE;
            const initial = Math.floor(s / 588);
            const medial = Math.floor((s % 588) / 28);
            const final = s % 28;
            out += HANGUL_INITIALS[initial] + HANGUL_MEDIALS[medial] + HANGUL_FINALS[final];
        } else {
            out += ch;
        }
    }
    return out;
}

/**
 * Leading articles stripped from the sort key, per language.
 *
 * Keyed by the primary subtag of a `library_paths.language` value, so `de`,
 * `de-DE` and `German` all resolve through {@link normalizeLanguageTag}.
 *
 * This is a *bounded* set keyed off a **declared** library language — not
 * open-ended token matching. Stripping German articles from an English library
 * would mangle "Die Harbor" (→ "harbor"), which is exactly why the list is scoped
 * rather than unioned. A language we do not know falls back to English, which
 * is the historical behaviour.
 *
 * Word-boundary forms only; apostrophe-elided articles (French `l'`, Italian
 * `dell'`) are handled by {@link LEADING_ELIDED_ARTICLE}.
 */
const ARTICLES_BY_LANGUAGE: Record<string, readonly string[]> = {
    en: ['the', 'a', 'an'],
    de: [
        'der',
        'die',
        'das',
        'den',
        'dem',
        'des',
        'ein',
        'eine',
        'einen',
        'einem',
        'einer',
        'eines',
    ],
    nl: ['de', 'het', 'een'],
    fr: ['le', 'la', 'les', 'un', 'une', 'des'],
    es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas'],
    it: ['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una'],
    pt: ['o', 'a', 'os', 'as', 'um', 'uma'],
    sv: ['den', 'det', 'en', 'ett'],
    da: ['den', 'det', 'en', 'et'],
    nb: ['den', 'det', 'en', 'et'],
    no: ['den', 'det', 'en', 'et'],
};

/**
 * Map a declared library language onto a key of {@link ARTICLES_BY_LANGUAGE}.
 *
 * Accepts BCP-47 tags (`de`, `de-DE`) and the English endonyms AudiobookShelf
 * writes into item metadata (`German`). Anything unrecognised yields `en`.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
    german: 'de',
    deutsch: 'de',
    english: 'en',
    dutch: 'nl',
    nederlands: 'nl',
    french: 'fr',
    francais: 'fr',
    spanish: 'es',
    espanol: 'es',
    italian: 'it',
    italiano: 'it',
    portuguese: 'pt',
    swedish: 'sv',
    danish: 'da',
    norwegian: 'nb',
};

export function normalizeLanguageTag(language: string | null | undefined): string {
    const raw = (language ?? '').trim().toLowerCase();
    if (raw.length === 0) return 'en';
    const folded = raw.normalize('NFKD').replace(/\p{M}/gu, '');
    if (LANGUAGE_ALIASES[folded]) return LANGUAGE_ALIASES[folded];
    const primary = folded.split(/[-_]/)[0];
    return ARTICLES_BY_LANGUAGE[primary] ? primary : 'en';
}

const ARTICLE_PATTERN_CACHE = new Map<string, RegExp>();

function leadingArticlePattern(languageKey: string): RegExp {
    const cached = ARTICLE_PATTERN_CACHE.get(languageKey);
    if (cached) return cached;
    const articles = ARTICLES_BY_LANGUAGE[languageKey] ?? ARTICLES_BY_LANGUAGE.en;
    const pattern = new RegExp(`^(?:${articles.join('|')})\\s+`);
    ARTICLE_PATTERN_CACHE.set(languageKey, pattern);
    return pattern;
}

/**
 * Apostrophe-elided articles, which carry no trailing space: French "L'Éclaireur",
 * Italian "L'Amica luminosa". Applied only for languages that use them, so an
 * English title like "D'Artagnan" is untouched.
 */
const LEADING_ELIDED_ARTICLE = /^(?:l|d|dell|nell|all|un)['’]\s*/;
const ELIDING_LANGUAGES = new Set(['fr', 'it']);

/** Leading non-alphanumeric run (punctuation/brackets/whitespace). */
const LEADING_NON_ALNUM = /^[^\p{L}\p{N}]+/u;

export interface SortTitleOptions {
    /** Remote libraries must not assume English when no article rules were declared. */
    declaredLanguageOnly?: boolean;
}

/**
 * Derive the normalized sort key for a media title.
 *
 * Pipeline:
 *   1. Seed with `englishTitle` when present (so e.g. "星灯命运" with an English
 *      title "The Keeper of Lanterns: Destiny" sorts under `K`), else the title.
 *   2. Romanize any Hangul syllables to Latin.
 *   3. NFKD-normalize and strip combining marks (folds full-width forms and
 *      diacritics, so "Übler Wind" sorts under `U`, not into `#`), then lowercase.
 *   4. Strip leading punctuation/brackets/whitespace (".harbor" → "harbor").
 *   5. Strip a leading English article ("The Lantern" → "lantern").
 *   6. Collapse internal whitespace.
 *
 * The result is never empty: if normalization strips everything, it falls back
 * to the lowercased original title (then originalTitle) so every row remains
 * sortable.
 *
 * @param title - The display title (`media_items.title`).
 * @param englishTitle - Optional English title (`media_items.english_title`).
 * @param originalTitle - Optional original-language title (last-resort fallback).
 * @param language - Optional declared library language (`library_paths.language`).
 *   Omitting it keeps the historical English-only behaviour, so existing callers
 *   and their stored keys are unaffected — there is no re-sort and no backfill.
 *   A caller that knows its library's language passes it to get correct
 *   bucketing (without it a German library piles under D/E for Der/Die/Das/Ein).
 * @returns A lowercase, comparable sort key.
 */
export function deriveSortTitle(
    title: string,
    englishTitle?: string | null,
    originalTitle?: string | null,
    language?: string | null,
    options: SortTitleOptions = {},
): string {
    const safeTitle = title ?? '';
    const seed = englishTitle && englishTitle.trim().length > 0 ? englishTitle : safeTitle;

    let key = romanizeHangul(seed);
    // NFKD decomposes accented letters and full-width forms; stripping combining
    // marks (\p{M}) folds "ü"→"u", "é"→"e" so accented Latin titles bucket under
    // their base letter instead of falling after "z" under COLLATE "C".
    key = key.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    // Strip leading punctuation and articles repeatedly: removing an article can
    // re-expose leading punctuation (e.g. The "Harbor" Prince → "harbor" prince
    // → harbor prince), and stripping punctuation can re-expose an article.
    // When an English title seeded the key, the key IS English regardless of the
    // library's language — strip English articles for it, not the library's.
    const seededFromEnglish =
        englishTitle !== undefined && englishTitle !== null && englishTitle.trim().length > 0;
    const languageKey = seededFromEnglish ? 'en' : normalizeLanguageTag(language);
    const articlePattern = leadingArticlePattern(languageKey);
    const stripsElided = ELIDING_LANGUAGES.has(languageKey);
    const declared = (language ?? '').trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    const declaredKey = LANGUAGE_ALIASES[declared] ?? declared.split(/[-_]/)[0];
    const stripArticles =
        !options.declaredLanguageOnly ||
        seededFromEnglish ||
        ARTICLES_BY_LANGUAGE[declaredKey] !== undefined;

    let previous: string;
    do {
        previous = key;
        key = key.replace(LEADING_NON_ALNUM, '');
        if (stripArticles) key = key.replace(articlePattern, '');
        if (stripArticles && stripsElided) key = key.replace(LEADING_ELIDED_ARTICLE, '');
    } while (key !== previous);
    key = key.replace(/\s+/g, ' ').trim();

    if (key.length > 0) return key;

    // Everything stripped (e.g. a title that is only punctuation) — fall back to
    // a non-empty, deterministic value so the row is never unsortable.
    const fallback = (safeTitle || originalTitle || '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .trim();
    return fallback;
}
