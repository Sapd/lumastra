// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isGenericEpisodeTitle, normalizeEpisodeTitle } from './episode-title-match.js';

/**
 * String similarity utilities for fuzzy matching.
 * Uses normalized Levenshtein distance.
 */

/**
 * Compute normalized similarity (0-1) between two strings.
 * Case-insensitive, whitespace-normalized.
 */
export function normalizedSimilarity(a: string, b: string): number {
    const sa = a.toLowerCase().trim();
    const sb = b.toLowerCase().trim();
    if (sa === sb) return 1.0;
    if (sa.length === 0 || sb.length === 0) {
        return sa.length === sb.length ? 1.0 : 0;
    }

    const maxLen = Math.max(sa.length, sb.length);
    const dist = levenshteinDistance(sa, sb);
    return 1 - dist / maxLen;
}

/**
 * Find best match for a query among candidates.
 */
export function bestMatch(
    query: string,
    candidates: string[],
): { bestIndex: number; bestScore: number } {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < candidates.length; i++) {
        const score = normalizedSimilarity(query, candidates[i]);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = i;
        }
    }
    return { bestIndex, bestScore };
}

function levenshteinDistance(a: string, b: string): number {
    // Ensure b is the shorter string so we allocate O(min(m,n)) memory
    if (a.length < b.length) {
        const tmp = a;
        a = b;
        b = tmp;
    }
    const m = a.length;
    const n = b.length;
    if (n === 0) return m;

    // Two-row rolling array instead of full (m+1)×(n+1) matrix
    let prev = new Array<number>(n + 1);
    let curr = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        const tmp = prev;
        prev = curr;
        curr = tmp;
    }
    return prev[n];
}

/**
 * Chapter names that carry no episode-title signal: sequential markers
 * ("Chapter 3", "Kapitel 2", "Teil 4", "Part 1"), structural segments
 * (intro/credits/recap…), or bare timecodes. Used to suppress false
 * chapter→title matches.
 */
const GENERIC_CHAPTER_PATTERNS: RegExp[] = [
    /^(chapter|kapitel|teil|part|episode|szene|scene)\s*\d+$/i,
    /^(intro|opening|outro|ending|credits?|abspann|vorspann|recap|preview|prologue|epilogue|teaser|titles?)$/i,
    /^\d{1,2}:\d{2}(:\d{2})?$/, // bare timecode
    /^(?:main|start|chapter|episode|episode n)$/i,
    /^(?:intro|opening|outro|ending|credits?)(?:\s*[/&+]\s*(?:intro|opening|outro|ending|credits?))+$/i,
];

export function isGenericChapterName(name: string | null | undefined): boolean {
    if (!name) return true;
    const trimmed = name.trim();
    const normalized = normalizeEpisodeTitle(trimmed);
    if (/^[\p{P}\p{N}\s]*$/u.test(trimmed)) return true;
    return (
        isGenericEpisodeTitle(trimmed) ||
        GENERIC_CHAPTER_PATTERNS.some((re) => re.test(trimmed) || re.test(normalized))
    );
}

/**
 * Like bestMatch, but returns bestIndex = -1 when the top score is below
 * `threshold`. Keeps callers from binding on weak matches.
 */
export function bestMatchAboveThreshold(
    query: string,
    candidates: string[],
    threshold: number,
): { bestIndex: number; bestScore: number } {
    const { bestIndex, bestScore } = bestMatch(query, candidates);
    if (bestScore < threshold) return { bestIndex: -1, bestScore };
    return { bestIndex, bestScore };
}
