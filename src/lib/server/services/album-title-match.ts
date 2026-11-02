// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { normalizeArtistName } from './artist-name-match.js';

/** Remove trailing edition/bonus labels, preserving meaningful parenthetical titles. */
export function normalizeAlbumTitle(title: string): string {
    let base = title.normalize('NFC').trim();
    let previous: string;
    do {
        previous = base;
        base = base
            .replace(/\s*\[[^[\]]*\]\s*$/u, '')
            .replace(
                /\s*\((?:incl\.?\b[^()]*|[^()]*\bremix(?:es)?\b[^()]*|[^()]*\bmix|single|ep|bonus\b[^()]*|deluxe\b[^()]*|[^()]*\bremaster(?:ed)?\b[^()]*|[^()]*\bedition)\)\s*$/iu,
                '',
            )
            .replace(/\s+[-–—]\s*(?:incl\.?\b.*|single|ep)\s*$/iu, '')
            .replace(/\s+ep\s*$/iu, '')
            .trim();
    } while (base !== previous);
    return normalizeArtistName(base);
}

/** Equality only: broader search queries never permit fuzzy candidate acceptance. */
export function albumTitlesMatch(a: string, b: string): boolean {
    const base = normalizeAlbumTitle(a);
    return base.length > 0 && base === normalizeAlbumTitle(b);
}

/** Full spelling first, then at most one distinct base-title search on a miss. */
export function albumSearchQueries(title: string): string[] {
    const original = title.trim();
    if (!original || !/[\p{L}\p{N}]/u.test(original)) return [];
    const base = normalizeAlbumTitle(original);
    return base && base !== original.toLowerCase() ? [original, base] : [original];
}
