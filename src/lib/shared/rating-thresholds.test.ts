// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    MIN_RATINGS_FOR_RECOMMENDATIONS,
    PROFILE_RATING_WINDOW,
    RATING_MILESTONES,
    crossedMilestone,
    deriveProfileStatus,
    shouldRemoveSuggestionOnRating,
} from './rating-thresholds';

describe('rating-thresholds', () => {
    it('unlock threshold is 5 and is the first milestone', () => {
        expect(MIN_RATINGS_FOR_RECOMMENDATIONS).toBe(5);
        expect(RATING_MILESTONES[0]).toBe(5);
    });

    it('profile rating window is widened to 500 (Plan 2.5 Task 1)', () => {
        expect(PROFILE_RATING_WINDOW).toBe(500);
    });

    it('crossedMilestone detects a crossing', () => {
        expect(crossedMilestone(4, 5)).toBe(5);
        expect(crossedMilestone(24, 25)).toBe(25);
        expect(crossedMilestone(24, 26)).toBe(25); // jump over still reports it
    });

    it('crossedMilestone returns null when nothing crossed', () => {
        expect(crossedMilestone(5, 6)).toBeNull();
        expect(crossedMilestone(10, 10)).toBeNull();
    });

    it('deriveProfileStatus follows the unlock state, not per-submit regen', () => {
        expect(deriveProfileStatus(0)).toBe('none');
        expect(deriveProfileStatus(1)).toBe('building');
        expect(deriveProfileStatus(4)).toBe('building');
        expect(deriveProfileStatus(5)).toBe('ready');
        // 6th rating (no rebuild cadence) is still 'ready' — regression guard
        // against deriving from the per-submit recommendationsReady flag.
        expect(deriveProfileStatus(6)).toBe('ready');
        expect(deriveProfileStatus(237)).toBe('ready');
    });

    describe('shouldRemoveSuggestionOnRating', () => {
        it('is true at the widened dislike boundary (4/10), matching the system-wide dislike band', () => {
            expect(shouldRemoveSuggestionOnRating(4)).toBe(true);
        });

        it('is true for everything below the dislike boundary', () => {
            expect(shouldRemoveSuggestionOnRating(3)).toBe(true);
            expect(shouldRemoveSuggestionOnRating(1)).toBe(true);
        });

        it('is false just above the dislike boundary (5)', () => {
            expect(shouldRemoveSuggestionOnRating(5)).toBe(false);
        });

        it('is false in the rest of the neutral band (6-7)', () => {
            expect(shouldRemoveSuggestionOnRating(6)).toBe(false);
            expect(shouldRemoveSuggestionOnRating(7)).toBe(false);
        });

        it('is true at the love boundary (8) and everything above', () => {
            expect(shouldRemoveSuggestionOnRating(8)).toBe(true);
            expect(shouldRemoveSuggestionOnRating(9)).toBe(true);
            expect(shouldRemoveSuggestionOnRating(10)).toBe(true);
        });
    });
});
