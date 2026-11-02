// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search helper utilities
 *
 * Pure functions for search validation and logic.
 * Extracted from Search.svelte for testability.
 */

/**
 * Determine if a search should be performed based on query and operators
 *
 * @param query - The cleaned search query (after operator extraction)
 * @param operators - Parsed search operators
 * @returns true if search should be performed
 *
 * @example
 * shouldPerformSearch('batman', { yearMin: undefined }) // true (2+ chars)
 * shouldPerformSearch('a', { yearMin: undefined })      // false (too short)
 * shouldPerformSearch('', { yearMin: 2020 })            // true (has operators)
 */
export function shouldPerformSearch(
    query: string,
    operators: {
        yearMin?: number;
        ratingMin?: number;
        genres?: string[];
        exclude?: string[];
    },
): boolean {
    // Check if query is long enough (minimum 2 characters)
    const hasValidQuery = query.trim().length >= 2;

    // Check if any search operators are set
    const hasOperators =
        operators.yearMin !== undefined ||
        operators.ratingMin !== undefined ||
        (operators.genres !== undefined && operators.genres.length > 0) ||
        (operators.exclude !== undefined && operators.exclude.length > 0);

    // Search is valid if query is long enough OR operators are set
    return hasValidQuery || hasOperators;
}
