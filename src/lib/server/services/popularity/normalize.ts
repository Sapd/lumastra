// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Title and score normalization for popularity matching.
 */

const VERSION_KEYWORDS =
    'remix|edit|mix|version|radio|club|extended|instrumental|acoustic|live|feat|featuring|ft\\.|with|vs|demo|remaster|mono|stereo|nightcore|dub';

const BRACKET_RE = new RegExp(
    `[([\\[]((?:[^()\\[\\]]*(?:${VERSION_KEYWORDS})[^()\\[\\]]*))[)\\]]`,
    'gi',
);

// Strip " - <anything ending with a version keyword>" at end of title. The
// suffix body must contain at least one word before the keyword and allows
// multiple words so multi-word remixer credits (e.g. "G4bby feat. Bazz Boyz
// Edit") are removed cleanly, not only single-word labels ("Radio Edit").
const HYPHEN_SUFFIX_RE = new RegExp(
    `\\s+-\\s+\\S+(?:\\s+\\S+)*\\s+(?:${VERSION_KEYWORDS})\\s*$`,
    'i',
);

/**
 * Normalize a title for matching. Lowercase, strip diacritics, collapse
 * whitespace, remove common parenthetical markers (remix, radio edit, feat.,
 * version labels, etc.). Deterministic and idempotent.
 */
export function normalizeTitle(title: string): string {
    // 1. Trim
    let t = title.trim();

    // 2. Lowercase
    t = t.toLocaleLowerCase('en-US');

    // 3. Strip diacritics
    t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // 4. Remove parenthetical/bracketed version markers (repeat until stable)
    let prev = '';
    while (prev !== t) {
        prev = t;
        t = t.replace(BRACKET_RE, '');
    }

    // 5. Strip trailing hyphen-separated version suffix
    t = t.replace(HYPHEN_SUFFIX_RE, '');

    // 6. Remove all characters except [a-z0-9\s]
    t = t.replace(/[^a-z0-9\s]/g, '');

    // 7. Collapse whitespace
    t = t.replace(/\s+/g, ' ').trim();

    return t;
}

/**
 * Per-artist track score normalization — each track's score is its listener
 * count divided by the maximum listener count across the artist's provided
 * top tracks. The #1 track gets 1.0; deep cuts get small fractions.
 * Returns 0 if all listeners are 0 or tracks is empty.
 */
export function normalizeTrackScores(
    tracks: Array<{ listeners: number; playcount: number }>,
): number[] {
    if (tracks.length === 0) return [];

    const max = Math.max(...tracks.map((t) => t.listeners));
    if (max === 0) return tracks.map(() => 0);

    return tracks.map((t) => t.listeners / max);
}

/**
 * Global artist score normalization — log-scaled listener count against a
 * provided ceiling. Returns a value in [0, 1]. Input <= 0 returns 0.
 * Ceiling of 0 or negative returns 0.
 *
 * Formula: log(1 + listeners) / log(1 + ceiling), clamped to [0, 1].
 */
export function normalizeArtistScore(listeners: number, ceiling: number): number {
    if (listeners <= 0) return 0;
    if (ceiling <= 0) return 0;

    const score = Math.log(1 + listeners) / Math.log(1 + ceiling);
    return Math.min(1, Math.max(0, score));
}
