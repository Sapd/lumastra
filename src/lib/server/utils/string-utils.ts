// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * String normalization utilities for title matching and comparison
 */

/**
 * Normalizes a title for fuzzy matching by:
 * - Converting to lowercase
 * - Normalizing apostrophes (smart quotes to straight)
 * - Replacing common leetspeak numbers with letters (1→i, 3→e, 0→o, 4→a, 5→s, 7→t)
 * - Replacing punctuation with spaces
 * - Collapsing multiple spaces
 * - Trimming whitespace
 *
 * @param title - The title to normalize
 * @returns Normalized title string
 *
 * @example
 * normalizeTitle("The Lord's Journey!") // "the lord s journey"
 * normalizeTitle("PLUR1BUS") // "pluribus"
 */
export function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/['']/g, "'") // Normalize apostrophes
        .replace(/1/g, 'i') // Leetspeak: 1 → i
        .replace(/3/g, 'e') // Leetspeak: 3 → e
        .replace(/0/g, 'o') // Leetspeak: 0 → o
        .replace(/4/g, 'a') // Leetspeak: 4 → a
        .replace(/5/g, 's') // Leetspeak: 5 → s
        .replace(/7/g, 't') // Leetspeak: 7 → t
        .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim();
}

/**
 * Normalizes a title for strict matching by:
 * - Converting to lowercase
 * - Removing all special characters
 * - Normalizing spaces
 * - Trimming whitespace
 *
 * @param title - The title to normalize
 * @returns Normalized title string with no special characters
 *
 * @example
 * normalizeTitleStrict("The Lord's Journey!") // "the lords journey"
 */
export function normalizeTitleStrict(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, '') // Remove special chars entirely
        .replace(/\s+/g, ' ') // Normalize spaces
        .trim();
}

/**
 * Performs fuzzy matching between two titles using normalized comparison
 * Returns true if titles match exactly or one contains the other
 *
 * @param title1 - First title to compare
 * @param title2 - Second title to compare
 * @returns True if titles match or contain each other
 *
 * @example
 * fuzzyTitleMatch("The Lord's Journey", "Lords Journey") // true
 * fuzzyTitleMatch("Star Lanterns", "Star Harbor") // false
 */
export function fuzzyTitleMatch(title1: string, title2: string): boolean {
    const normalized1 = normalizeTitle(title1);
    const normalized2 = normalizeTitle(title2);

    return (
        normalized1 === normalized2 ||
        normalized1.includes(normalized2) ||
        normalized2.includes(normalized1)
    );
}

/**
 * Parses a delimited list string into an array of trimmed, non-empty strings.
 * Supports multiple separators: comma (,), pipe (|), and handles whitespace.
 *
 * @param input - The string to parse (can be null/undefined)
 * @param defaultValue - Optional default value if input is empty
 * @returns Array of parsed items
 *
 * @example
 * parseList('Group1, Group2, Group3')     // ['Group1', 'Group2', 'Group3']
 * parseList('Group1|Group2|Group3')       // ['Group1', 'Group2', 'Group3']
 * parseList('Group1,Group2|Group3')       // ['Group1', 'Group2', 'Group3']
 * parseList('  Group1 , Group2  ')        // ['Group1', 'Group2']
 * parseList('')                            // []
 * parseList(null)                          // []
 * parseList('', 'default')                 // ['default']
 */
export function parseList(input: string | null | undefined, defaultValue?: string): string[] {
    if (!input || input.trim() === '') {
        if (defaultValue) {
            return parseList(defaultValue);
        }
        return [];
    }

    return input
        .split(/[,|]/) // Split on comma or pipe
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
