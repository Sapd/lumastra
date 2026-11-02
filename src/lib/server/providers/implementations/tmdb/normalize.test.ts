// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the auto-identify scoring helpers.
 *
 * These guard the title-similarity / year-proximity gate added to stop the
 * "popularity == confidence" mis-identification bug: a popular-but-wrong
 * provider match must score below the acceptance floor so it is never
 * auto-applied. See `auto-identify.service.ts` for the gate that consumes
 * these scores (final = providerConfidence * titleSim * yearProximity, with
 * floors AUTO_IDENTIFY_THRESHOLD = 0.8 and TITLE_SIMILARITY_FLOOR = 0.6).
 */

import { describe, it, expect } from 'vitest';
import { titleSimilarity, yearProximity } from './normalize.js';

// Mirror of TITLE_SIMILARITY_FLOOR in auto-identify.service.ts. If the floor
// changes, these relational assertions still hold; this constant only documents
// the boundary the gate cares about.
const TITLE_SIMILARITY_FLOOR = 0.6;

describe('titleSimilarity', () => {
    it('returns 1 for identical titles', () => {
        expect(titleSimilarity('Voyage to Orion', 'Voyage to Orion')).toBe(1);
    });

    it('returns 1 once case and punctuation are normalised away', () => {
        expect(titleSimilarity('The Outpost!', 'the outpost')).toBe(1);
        // Hyphen normalises to a space on both sides -> identical token sets.
        expect(titleSimilarity('Spider-Man', 'Spider Man')).toBe(1);
    });

    it('returns 0 when either side is empty', () => {
        expect(titleSimilarity('', 'Anything')).toBe(0);
        expect(titleSimilarity('Anything', '')).toBe(0);
    });

    it('scores an unrelated popular title BELOW the acceptance floor (the bug guard)', () => {
        // A home video literally titled "Birthday 2019" must not match the
        // wildly-popular movie "Wayfarers: Last Light" just because it is popular.
        const sim = titleSimilarity('Birthday 2019', 'Avengers Endgame');
        expect(sim).toBeLessThan(TITLE_SIMILARITY_FLOOR);
    });

    it('scores two genuinely different shows below the floor', () => {
        expect(titleSimilarity('Drifting Clouds', 'Voyage to Orion')).toBeLessThan(
            TITLE_SIMILARITY_FLOOR,
        );
    });

    it('scores a clean exact title at/above the floor (the accept path)', () => {
        expect(titleSimilarity('Starhaven', 'Starhaven')).toBeGreaterThanOrEqual(
            TITLE_SIMILARITY_FLOOR,
        );
    });

    it('gives a partial score for a subtitle/extension, ordered between unrelated and exact', () => {
        const partial = titleSimilarity('Drifting Clouds', 'Drifting Clouds: The Movie');
        const unrelated = titleSimilarity('Drifting Clouds', 'Voyage to Orion');
        const exact = titleSimilarity('Drifting Clouds', 'Drifting Clouds');
        expect(partial).toBeGreaterThan(unrelated);
        expect(partial).toBeLessThan(exact);
    });

    it('is symmetric', () => {
        expect(titleSimilarity('The Wisp', 'The Wired')).toBeCloseTo(
            titleSimilarity('The Wired', 'The Wisp'),
            10,
        );
    });
});

describe('yearProximity', () => {
    it('returns 1 for equal years', () => {
        expect(yearProximity(2008, 2008)).toBe(1);
    });

    it('returns 1 when either year is unknown (absent data must not penalise)', () => {
        expect(yearProximity(undefined, 2008)).toBe(1);
        expect(yearProximity(2008, undefined)).toBe(1);
        expect(yearProximity(undefined, undefined)).toBe(1);
    });

    it('degrades linearly to 0 across a 3-year gap', () => {
        expect(yearProximity(2008, 2009)).toBeCloseTo(2 / 3, 10);
        expect(yearProximity(2008, 2010)).toBeCloseTo(1 / 3, 10);
    });

    it('returns 0 at or beyond a 3-year gap', () => {
        expect(yearProximity(2008, 2011)).toBe(0);
        expect(yearProximity(2008, 2020)).toBe(0);
    });

    it('is direction-independent', () => {
        expect(yearProximity(2010, 2008)).toBeCloseTo(yearProximity(2008, 2010), 10);
    });
});
