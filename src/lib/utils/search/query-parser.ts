// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query Parser for Search
 *
 * Parses search operators from query strings.
 * Supports advanced search syntax:
 * - year:2024 or year:2020-2024 (year range)
 * - rating:>8 or rating:>=7.5 (minimum rating)
 * - genre:action,comedy (genre filters)
 * - -horror -romance (exclude terms)
 *
 * Extracted from Search.svelte to improve testability and reusability.
 */

export interface SearchOperators {
    query: string; // Plain text query after extracting operators
    yearMin?: number; // year:2020 or year:2020-2024 (min)
    yearMax?: number; // year:2020-2024 (max)
    ratingMin?: number; // rating:>8 or rating:>=7.5
    genres?: string[]; // genre:action,comedy
    exclude?: string[]; // -horror -romance
}

/**
 * Parse search operators from the query string.
 *
 * @example
 * parseSearchOperators('daydream year:2010 rating:>8')
 * // { query: 'daydream', yearMin: 2010, yearMax: 2010, ratingMin: 8 }
 *
 * @example
 * parseSearchOperators('action year:2020-2024 -horror')
 * // { query: 'action', yearMin: 2020, yearMax: 2024, exclude: ['horror'] }
 */
export function parseSearchOperators(input: string): SearchOperators {
    const result: SearchOperators = {
        query: '',
        exclude: [],
    };

    const parts: string[] = [];
    const trimmed = input.trim();
    const tokens = trimmed ? trimmed.split(/\s+/) : [];

    for (const token of tokens) {
        // Year filter: year:2024 or year:2020-2024
        const yearMatch = token.match(/^year:(\d{4})(?:-(\d{4}))?$/i);
        if (yearMatch) {
            result.yearMin = parseInt(yearMatch[1], 10);
            result.yearMax = yearMatch[2] ? parseInt(yearMatch[2], 10) : result.yearMin;
            continue;
        }

        // Rating filter: rating:>8 or rating:>=7.5 or rating:8
        const ratingMatch = token.match(/^rating:([>]=?)?(\d+(?:\.\d+)?)$/i);
        if (ratingMatch) {
            result.ratingMin = parseFloat(ratingMatch[2]);
            continue;
        }

        // Genre filter: genre:action or genre:action,comedy
        const genreMatch = token.match(/^genre:(.+)$/i);
        if (genreMatch) {
            result.genres = genreMatch[1].split(',').map((g) => g.trim().toLowerCase());
            continue;
        }

        // Exclude term: -horror
        if (token.startsWith('-') && token.length > 1) {
            result.exclude!.push(token.substring(1).toLowerCase());
            continue;
        }

        // Regular search term
        parts.push(token);
    }

    result.query = parts.join(' ');
    return result;
}
