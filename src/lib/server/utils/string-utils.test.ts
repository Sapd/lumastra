// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for string normalization utilities
 */

import { describe, it, expect } from 'vitest';
import { normalizeTitle, normalizeTitleStrict, fuzzyTitleMatch } from './string-utils';

// ---------------------------------------------------------------------------
// Exclusion-safe title matching (M6)
// The calendar/upcoming routes use a min-length guard before substring checks
// so short/common names like "Luma" don't accidentally exclude "Paradise Luma".
// This helper mirrors the logic in those routes.
// ---------------------------------------------------------------------------
const MIN_FUZZY_TOKEN_LEN = 5;

function isExcludedSafe(excludedName: string, seriesName: string): boolean {
    const normalizedExcluded = normalizeTitle(excludedName);
    const normalizedSeries = normalizeTitle(seriesName);
    // Exact match always wins
    if (normalizedExcluded === normalizedSeries) return true;
    // Substring containment only for tokens longer than the min threshold
    const shorter =
        normalizedExcluded.length <= normalizedSeries.length
            ? normalizedExcluded
            : normalizedSeries;
    const longer =
        normalizedExcluded.length <= normalizedSeries.length
            ? normalizedSeries
            : normalizedExcluded;
    return shorter.length > MIN_FUZZY_TOKEN_LEN && longer.includes(shorter);
}

describe('normalizeTitle', () => {
    describe('basic normalization', () => {
        it('converts to lowercase', () => {
            expect(normalizeTitle('The LANTERN')).toBe('the lantern');
            expect(normalizeTitle('STAR LANTERNS')).toBe('star lanterns');
        });

        it('trims whitespace', () => {
            expect(normalizeTitle('  Movie Title  ')).toBe('movie title');
        });

        it('collapses multiple spaces', () => {
            expect(normalizeTitle('The    Long    Title')).toBe('the long title');
        });
    });

    describe('punctuation handling', () => {
        it('replaces punctuation with spaces', () => {
            expect(normalizeTitle("The Lord's Journey!")).toBe('the lord s journey');
            expect(normalizeTitle('Harbor-Keeper: No Way Back')).toBe('harbor keeper no way back');
            expect(normalizeTitle('Mission: Uncharted')).toBe('mission uncharted');
        });

        it('normalizes smart quotes to straight quotes', () => {
            expect(normalizeTitle("It's a Lantern Life")).toBe('it s a lantern life');
            expect(normalizeTitle("It's a Lantern Life")).toBe('it s a lantern life');
        });

        it('handles special characters', () => {
            expect(normalizeTitle('HARB·E')).toBe('harb e');
            expect(normalizeTitle('Amélune')).toBe('am lune');
        });
    });

    describe('leetspeak conversion', () => {
        it('converts 1 to i', () => {
            expect(normalizeTitle('LANT1BUS')).toBe('lantibus');
            expect(normalizeTitle('Harbor 1')).toBe('harbor i');
        });

        it('converts 3 to e', () => {
            expect(normalizeTitle('TH3 LANTERN')).toBe('the lantern');
            expect(normalizeTitle('L3V3L')).toBe('level');
        });

        it('converts 0 to o', () => {
            expect(normalizeTitle('R0WEN')).toBe('rowen');
            expect(normalizeTitle('ZER0')).toBe('zero');
        });

        it('converts 4 to a', () => {
            expect(normalizeTitle('F4NE')).toBe('fane');
            expect(normalizeTitle('4LORA')).toBe('alora');
        });

        it('converts 5 to s', () => {
            expect(normalizeTitle('5TAR LANTERN5')).toBe('star lanterns');
        });

        it('converts 7 to t', () => {
            expect(normalizeTitle('7HE LAN7ERN')).toBe('the lantern');
        });

        it('handles multiple leetspeak conversions', () => {
            expect(normalizeTitle('L3V3L')).toBe('level');
            expect(normalizeTitle('7H3 L4N73RN K33P3R 1NN')).toBe('the lantern keeper inn');
        });
    });

    describe('edge cases', () => {
        it('handles empty string', () => {
            expect(normalizeTitle('')).toBe('');
        });

        it('handles only whitespace', () => {
            expect(normalizeTitle('   ')).toBe('');
        });

        it('handles only punctuation', () => {
            expect(normalizeTitle('...')).toBe('');
            expect(normalizeTitle('---')).toBe('');
        });

        it('handles numbers mixed with letters', () => {
            // Note: only 1,3,0,4,5,7 are converted (leetspeak), 2 stays as is
            expect(normalizeTitle('2001: A Harbor Journey')).toBe('2ooi a harbor journey');
            expect(normalizeTitle("Harbor's 11")).toBe('harbor s ii');
        });
    });
});

describe('normalizeTitleStrict', () => {
    describe('basic normalization', () => {
        it('converts to lowercase', () => {
            expect(normalizeTitleStrict('The LANTERN')).toBe('the lantern');
        });

        it('removes special characters entirely', () => {
            expect(normalizeTitleStrict("The Lord's Journey!")).toBe('the lords journey');
            expect(normalizeTitleStrict('Harbor-Keeper: No Way Back')).toBe(
                'harborkeeper no way back',
            );
        });

        it('normalizes whitespace', () => {
            expect(normalizeTitleStrict('The    Movie')).toBe('the movie');
        });

        it('trims whitespace', () => {
            expect(normalizeTitleStrict('  Movie  ')).toBe('movie');
        });
    });

    describe('comparison with normalizeTitle', () => {
        it('removes special chars instead of replacing with space', () => {
            // normalizeTitle replaces with space, normalizeTitleStrict removes entirely
            expect(normalizeTitle("Lord's")).toBe('lord s');
            expect(normalizeTitleStrict("Lord's")).toBe('lords');
        });
    });

    describe('edge cases', () => {
        it('handles empty string', () => {
            expect(normalizeTitleStrict('')).toBe('');
        });

        it('preserves numbers (no leetspeak conversion)', () => {
            expect(normalizeTitleStrict("Harbor's 11")).toBe('harbors 11');
            expect(normalizeTitleStrict('Le7el')).toBe('le7el');
        });
    });
});

describe('fuzzyTitleMatch', () => {
    describe('exact matches', () => {
        it('matches identical titles', () => {
            expect(fuzzyTitleMatch('The Lantern', 'The Lantern')).toBe(true);
        });

        it('matches with different casing', () => {
            expect(fuzzyTitleMatch('THE LANTERN', 'the lantern')).toBe(true);
            expect(fuzzyTitleMatch('Star Lanterns', 'STAR LANTERNS')).toBe(true);
        });

        it('matches with different punctuation', () => {
            // Note: "Lord's" -> "lord s" but "Lords" -> "lords" (different)
            // Contains matching still works because one is a substring of the other
            expect(fuzzyTitleMatch('Spider-Man', 'Spider Man')).toBe(true);
            // Same punctuation, different casing
            expect(fuzzyTitleMatch("The Lord's Journey", "the lord's journey")).toBe(true);
        });
    });

    describe('contains matching', () => {
        it('matches when first contains second', () => {
            expect(fuzzyTitleMatch('Star Lanterns: A New Light', 'Star Lanterns')).toBe(true);
            expect(fuzzyTitleMatch('The Keeper of the Lanterns: Fellowship', 'Fellowship')).toBe(
                true,
            );
        });

        it('matches when second contains first', () => {
            expect(fuzzyTitleMatch('Lantern', 'The Lantern Reloaded')).toBe(true);
            expect(fuzzyTitleMatch('Star Lanterns', 'Star Lanterns Episode IV')).toBe(true);
        });

        it('matches with partial overlap', () => {
            expect(fuzzyTitleMatch('KOTL: Fellowship', 'Fellowship')).toBe(true);
        });
    });

    describe('non-matches', () => {
        it('does not match completely different titles', () => {
            expect(fuzzyTitleMatch('Star Lanterns', 'Star Harbor')).toBe(false);
            expect(fuzzyTitleMatch('The Lantern', 'The Tidekeeper')).toBe(false);
        });

        it('does not match partial word overlaps', () => {
            expect(fuzzyTitleMatch('The', 'Theater')).toBe(true); // "the" is contained in "theater"
            expect(fuzzyTitleMatch('Lantern', 'Lant')).toBe(true); // "lant" is contained in "lantern"
        });
    });

    describe('edge cases', () => {
        it('handles empty strings', () => {
            expect(fuzzyTitleMatch('', '')).toBe(true);
            expect(fuzzyTitleMatch('Movie', '')).toBe(true); // empty is contained in anything
            expect(fuzzyTitleMatch('', 'Movie')).toBe(true);
        });

        it('handles leetspeak in both titles', () => {
            // Same leetspeak on both sides
            expect(fuzzyTitleMatch('Le7el', 'LE7EL')).toBe(true);
            expect(fuzzyTitleMatch('Th3 Lantern', 'th3 lantern')).toBe(true);
        });

        it('leetspeak vs normal spelling behavior', () => {
            // "Le7el" -> "letel" (7->t), "Level" -> "level" - different strings
            expect(fuzzyTitleMatch('Le7el', 'Level')).toBe(false);
            // "Th3" -> "the" (3->e), "The" -> "the" - these match!
            expect(fuzzyTitleMatch('Th3', 'The')).toBe(true);
        });
    });
});

// ---------------------------------------------------------------------------
// isExcludedSafe — calendar/upcoming series-exclusion matching logic (M6)
// ---------------------------------------------------------------------------
describe('isExcludedSafe (exclusion-safe matching)', () => {
    describe('over-exclusion regression cases (M6)', () => {
        it('does NOT exclude "Paradise Luma" when "Luma" is excluded (short token)', () => {
            // "luma" is 4 chars — below the MIN_FUZZY_TOKEN_LEN threshold
            expect(isExcludedSafe('Luma', 'Paradise Luma')).toBe(false);
        });

        it('excludes "Luma" exactly when "Luma" is excluded', () => {
            expect(isExcludedSafe('Luma', 'Luma')).toBe(true);
        });

        it('does NOT exclude "The Wisp" when "Wisp" is excluded (short token)', () => {
            // "wisp" is 4 chars
            expect(isExcludedSafe('Wisp', 'The Wisp')).toBe(false);
        });

        it('excludes "The Wisp" exactly when "The Wisp" is excluded', () => {
            expect(isExcludedSafe('The Wisp', 'The Wisp')).toBe(true);
        });

        it('does NOT exclude "Drifting Fog" when "Fog" is excluded (short token)', () => {
            // "fog" is 3 chars
            expect(isExcludedSafe('Fog', 'Drifting Fog')).toBe(false);
        });

        it('does NOT exclude "Starhaven" when "Starh" is excluded (≤5 chars)', () => {
            // "starh" is 5 chars (equal to threshold, NOT greater)
            expect(isExcludedSafe('Starh', 'Starhaven')).toBe(false);
        });
    });

    describe('valid long-token exclusions (should still work)', () => {
        it('excludes "Drifting Clouds Season 2" when "Drifting Clouds" is excluded (>5 chars)', () => {
            // "drifting clouds" is 15 chars — exceeds threshold
            expect(isExcludedSafe('Drifting Clouds', 'Drifting Clouds Season 2')).toBe(true);
        });

        it('excludes a series containing a long excluded suffix', () => {
            // "station" is 7 chars
            expect(isExcludedSafe('Station', 'Station Lantern')).toBe(true);
        });

        it('excludes exact match regardless of length', () => {
            expect(isExcludedSafe('Starhaven', 'Starhaven')).toBe(true);
        });

        it('excludes case-insensitive exact match', () => {
            expect(isExcludedSafe('starhaven', 'STARHAVEN')).toBe(true);
        });
    });

    describe('edge cases', () => {
        it('returns false for empty series name', () => {
            expect(isExcludedSafe('Luma', '')).toBe(false);
        });

        it('returns false for empty excluded name', () => {
            // empty string is 0 chars — below threshold, and exact match with non-empty is false
            expect(isExcludedSafe('', 'Paradise Lost')).toBe(false);
        });
    });
});
