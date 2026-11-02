// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Keep token rules in sync with music_search_normalize() (migration 16.442.0).
 * Accents are NOT folded here: the SQL side applies immutable_unaccent to the
 * tsquery and to the indexed titles. Decomposing (NFD) would split Hangul into
 * jamo and strip kana dakuten, which unaccent keeps. Combining marks are kept
 * as part of a word.
 */
export function normalizeMusicSearch(text: string): string {
    return text
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
        .replace(/(\p{L})([0-9])/gu, '$1 $2')
        .replace(/([0-9])(\p{L})/gu, '$1 $2')
        .replace(/\b(?:vol|volume) +(?=[0-9])/g, '')
        .replace(/\b0+([0-9])/g, '$1')
        .trim()
        .replace(/ +/g, ' ');
}

/** Words retain completion matching; numbers always match an entire lexeme. */
export function buildMusicTsQuery(text: string): string | null {
    const tokens = normalizeMusicSearch(text).split(' ').filter(Boolean);
    // One-letter tokens ("u" of "U2", "p" of "P!nk") match a whole lexeme;
    // dropping them would leave a bare number that matches every "Part 2".
    const terms = tokens.map((token) =>
        /^[0-9]+$/.test(token) || token.length < 2 ? token : `${token}:*`,
    );
    return terms.length ? terms.join(' & ') : null;
}
