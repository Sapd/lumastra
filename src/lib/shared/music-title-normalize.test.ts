// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Novelty-cut detection for the autoplay candidate filter.
 *
 * (Remix/version normalisation is covered by the sibling suite at
 * src/lib/server/database/queries/music-title-normalize.test.ts, which
 * exercises the same module through its re-export shim.)
 */

import { describe, it, expect } from 'vitest';
import { isNoveltyCutTitle } from './music-title-normalize.js';

// ---------------------------------------------------------------------------
// isNoveltyCutTitle
// ---------------------------------------------------------------------------

describe('isNoveltyCutTitle', () => {
    it('matches the a cappella spellings that actually occur in the library', () => {
        // Anonymized titles from a 24k-track library.
        expect(isNoveltyCutTitle('Lumma! (a cappella)')).toBe(true);
        expect(isNoveltyCutTitle('Moonlight Harbor (acappella)')).toBe(true);
        expect(isNoveltyCutTitle('Keeper of Light (MJC Favourite Acappella Mix)')).toBe(true);
        expect(isNoveltyCutTitle('We Have Lanterns (a cappella, Simon Linden mix)')).toBe(true);
        expect(isNoveltyCutTitle('Moon Biddy Bye Bye (Fenwicks mix a cappella)')).toBe(true);
    });

    it('matches the single-p misspellings, which are the common ones', () => {
        // The original pattern required a double p, so the spelling most tags
        // actually use walked straight past the filter and kept autoplaying.
        expect(isNoveltyCutTitle('Rowanway (Acapella)')).toBe(true);
        expect(isNoveltyCutTitle('Harbor Rhapsody - a capella')).toBe(true);
        expect(isNoveltyCutTitle('Find Lanterns (acapela edit)')).toBe(true);
    });

    it('matches karaoke cuts', () => {
        expect(isNoveltyCutTitle('Something (Karaoke Version)')).toBe(true);
    });

    it('does NOT match instrumentals — their audio is representative', () => {
        // 309 of 24,240 tracks carry this word, many legitimately (scores,
        // electronic). An instrumental keeps the full production minus vocals,
        // so its embedding is a fine neighbour.
        expect(isNoveltyCutTitle('Cliffs of Fenwick (Instrumental)')).toBe(false);
        expect(isNoveltyCutTitle('Instrumental Break')).toBe(false);
    });

    it('does not match ordinary titles', () => {
        expect(isNoveltyCutTitle('Kids (2 Finger an den Kopf)')).toBe(false);
        expect(isNoveltyCutTitle('Mother')).toBe(false);
        expect(isNoveltyCutTitle('Capital Letters')).toBe(false);
        expect(isNoveltyCutTitle('Acapulco Nights')).toBe(false);
    });

    it('treats missing titles as ordinary rather than throwing', () => {
        expect(isNoveltyCutTitle(null)).toBe(false);
        expect(isNoveltyCutTitle(undefined)).toBe(false);
        expect(isNoveltyCutTitle('')).toBe(false);
    });
});
