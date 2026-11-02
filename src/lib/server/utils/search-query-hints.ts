// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search query hints — "Anna (2019)", "Anna 2019", "movie 2019", "Serie (1999)".
 *
 * A release year or a media-type word is not part of a title, so leaving it in
 * the text makes the full-text AND-match fail ("anna" AND "2019" matches nothing)
 * or drowns the right title in noise. This pure parser splits a raw query into
 * the title text plus the hints, and the search def decides how hard to apply
 * them:
 *
 *   - type word + year, NO title text ("movie 2019", "Movie (2019)")
 *       → the user wants every movie of that year (hard filter).
 *   - year + title text ("Anna (2019)", "Anna 2019")
 *       → the year only BOOSTS matching titles; a title whose year is off by one
 *         in the metadata is still found.
 *   - type word + title text + year ("movie Anna 2019") → type is hard, year boosts.
 *
 * A type word alone is never a hint ("Movie 43", "The Series"), and neither is a
 * query that is only a year ("1917", "2012") — those are titles.
 */

export type SearchTypeHint = 'movie' | 'tv';

export interface SearchQueryHints {
    /** Query with the year / type words removed. Empty when only hints were given. */
    text: string;
    year?: number;
    type?: SearchTypeHint;
}

const MIN_YEAR = 1850;
/** Upcoming releases exist in a catalog; "Blade Runner 2049" must stay a title. */
const FUTURE_YEARS = 5;

const TYPE_WORDS: Record<string, SearchTypeHint> = {
    movie: 'movie',
    movies: 'movie',
    film: 'movie',
    films: 'movie',
    series: 'tv',
    serie: 'tv',
    serien: 'tv',
    show: 'tv',
    shows: 'tv',
    tv: 'tv',
};

const TYPE_WORD_RE = Object.keys(TYPE_WORDS).join('|');
// (2019) / [2019] — an explicit year marker; any 4-digit number is accepted
// because the intent is unambiguous.
const BRACKETED_YEAR_RE = /[([]\s*(\d{4})\s*[)\]]/;
const BARE_YEAR_RE = /^\d{4}$/;

function plausibleBareYear(year: number): boolean {
    return year >= MIN_YEAR && year <= new Date().getFullYear() + FUTURE_YEARS;
}

export function parseSearchQueryHints(query: string): SearchQueryHints {
    const original = query.trim();
    let rest = original;
    let year: number | undefined;
    let type: SearchTypeHint | undefined;

    const bracket = BRACKETED_YEAR_RE.exec(rest);
    if (bracket) {
        year = Number.parseInt(bracket[1]!, 10);
        rest = `${rest.slice(0, bracket.index)} ${rest.slice(bracket.index + bracket[0].length)}`;
    }

    let tokens = rest.split(/\s+/).filter(Boolean);

    // A type word counts only next to a year, at either end ("movie 2019 anna").
    // Taken first: "movie 1234" is unambiguous even though 1234 is no plausible
    // release year for a bare number.
    const typeRe = new RegExp(`^(${TYPE_WORD_RE})$`, 'i');
    const takeType = (): void => {
        const first = tokens[0];
        const last = tokens.length > 1 ? tokens.at(-1) : undefined;
        if (first && typeRe.test(first)) {
            type = TYPE_WORDS[first.toLowerCase()];
            tokens = tokens.slice(1);
        } else if (last && typeRe.test(last)) {
            type = TYPE_WORDS[last.toLowerCase()];
            tokens = tokens.slice(0, -1);
        }
    };

    if (year === undefined) {
        // Bare year as the first or last token only. With a type word beside it
        // any 4-digit number is an explicit year; without one it must be plausible.
        const withoutType = tokens;
        takeType();
        const isYear = (t: string | undefined): t is string =>
            !!t && BARE_YEAR_RE.test(t) && (type !== undefined || plausibleBareYear(Number(t)));
        const last = tokens.at(-1);
        const first = tokens[0];
        if (isYear(last)) {
            year = Number(last);
            tokens = tokens.slice(0, -1);
        } else if (isYear(first)) {
            year = Number(first);
            tokens = tokens.slice(1);
        } else {
            tokens = withoutType;
            type = undefined;
        }
    } else {
        takeType();
    }

    if (year === undefined) return { text: original };

    // "2019" alone (or "(2019)") with no title and no type word is a title/typo,
    // not a hint. "movie 2019" has a type word, so it is.
    if (tokens.length === 0 && !type) {
        return { text: original };
    }

    return { text: tokens.join(' '), year, ...(type ? { type } : {}) };
}
