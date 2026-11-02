// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** PostgreSQL unaccent's common non-decomposing Latin letters; not general transliteration. */
function unaccentTitle(title: string): string {
    const replacements: Record<string, string> = {
        ł: 'l',
        ø: 'o',
        đ: 'd',
        ð: 'd',
        þ: 'th',
        æ: 'ae',
        œ: 'oe',
        ß: 'ss',
    };
    return title
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[łøđðþæœß]/g, (letter) => replacements[letter]);
}

/** Comparison only: always display the stored title, never this normalized key. */
export function normalizeTitle(title: string): string {
    return unaccentTitle(title).replace(/[^\p{L}\p{N}]/gu, '');
}

export function secondaryTitle(candidate: string | undefined, primary: string): string | undefined {
    const title = candidate?.trim();
    if (!title || !normalizeTitle(title) || normalizeTitle(title) === normalizeTitle(primary))
        return undefined;
    return title;
}

/** Mirror search's plain-unaccent and German-digraph forms without collapsing ASCII words. */
function matchKeys(title: string): string[] {
    const german = title
        .toLowerCase()
        .normalize('NFC')
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue');
    return [
        ...new Set(
            [title, german].map((form) =>
                unaccentTitle(form)
                    .replace(/[^\p{L}\p{N}]+/gu, ' ')
                    .trim(),
            ),
        ),
    ];
}

function matchesTitle(title: string, query: string): boolean {
    if (title.includes(query)) return true;
    const titleWords = title.split(' ');
    return query.split(' ').every((term) => titleWords.some((word) => word.startsWith(term)));
}

/** Conservative token matching explains title hits without joining unrelated words. */
export function selectMatchedTitle(
    primary: string,
    query: string,
    candidates: readonly string[],
): string | undefined {
    const terms = matchKeys(query).filter((term) => term.length >= 2);
    const matches = (title: string): boolean =>
        matchKeys(title).some((key) => terms.some((term) => matchesTitle(key, term)));
    if (terms.length === 0 || matches(primary)) return undefined;
    const exact = (title: string): boolean => matchKeys(title).some((key) => terms.includes(key));
    const substring = (title: string): boolean =>
        matchKeys(title).some((key) => terms.some((term) => key.includes(term)));
    return candidates
        .map((candidate) => secondaryTitle(candidate, primary))
        .filter((candidate): candidate is string => !!candidate && matches(candidate))
        .sort(
            (a, b) =>
                Number(exact(b)) - Number(exact(a)) ||
                Number(substring(b)) - Number(substring(a)) ||
                matchKeys(a)[0].length - matchKeys(b)[0].length ||
                a.localeCompare(b, 'en'),
        )[0];
}

/** True when the title itself already explains the hit, so no alias needs to be shown. */
export function primaryTitleMatches(primary: string, query: string): boolean {
    const terms = matchKeys(query).filter((term) => term.length >= 2);
    return terms.some((term) => matchKeys(primary).some((key) => matchesTitle(key, term)));
}

/**
 * Match keys handed to SQL so the database narrows alias rows with the same
 * word/prefix rule the title match above uses: `text` is the whole normalized
 * key, `words` its terms.
 */
export function matchKeysForSql(query: string): Array<{ text: string; words: string[] }> {
    return matchKeys(query)
        .filter((term) => term.length >= 2)
        .map((text) => ({ text, words: text.split(' ').filter(Boolean) }));
}
