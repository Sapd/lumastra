// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    computeGenreStreakProfile,
    genreAffinity,
    genreStreakScoreAdjustment,
    isGenreStreakActive,
    getGenreTags,
} from './music-genre-streak.js';

describe('computeGenreStreakProfile', () => {
    it('returns an empty profile with fewer than 3 tagged tracks (cold start)', () => {
        expect(computeGenreStreakProfile([])).toEqual({ weights: new Map(), cohesion: 0 });
        expect(computeGenreStreakProfile([['rock']])).toEqual({
            weights: new Map(),
            cohesion: 0,
        });
        // Only 2 tagged tracks: with recency decay the current track's own
        // weight (1.0) always dominates a single prior entry, so requiring
        // just 2 would make "streak" fire on one track regardless of
        // whether the prior track agrees. Must stay empty until 3.
        expect(computeGenreStreakProfile([['rock'], ['dance']])).toEqual({
            weights: new Map(),
            cohesion: 0,
        });
        expect(computeGenreStreakProfile([['rock'], null, undefined])).toEqual({
            weights: new Map(),
            cohesion: 0,
        });
    });

    it('produces full cohesion when every tagged track shares one tag', () => {
        const profile = computeGenreStreakProfile([['rock', 'metal'], ['metal'], ['metal']]);
        expect(profile.cohesion).toBeCloseTo(1, 5);
        expect(profile.weights.get('metal')).toBeCloseTo(1, 5);
    });

    it('recency-weights earlier tracks less (index 0 = current, weight halves per hop)', () => {
        // current=rock, prior=rock, prior-prior=dance — rock should dominate
        // even though dance is also present, because it's closer in the window.
        const profile = computeGenreStreakProfile([['rock'], ['rock'], ['dance']]);
        const rockWeight = profile.weights.get('rock') ?? 0;
        const danceWeight = profile.weights.get('dance') ?? 0;
        expect(rockWeight).toBeGreaterThan(danceWeight);
        expect(profile.cohesion).toBeCloseTo(rockWeight, 5);
    });

    it('the current track sets a cohesion floor even against a disagreeing history', () => {
        // Deliberate: with weight halving per hop back, the current track's
        // own weight (1.0) is >= the sum of every decayed prior weight
        // combined (a capped geometric series), so the current track's
        // genre can never be fully outvoted by history alone — it can only
        // be reinforced (pushed higher) or left at its floor. This protects
        // whatever's actively playing right now as the baseline signal
        // rather than snapping back to an older genre the user has since
        // moved on from.
        const disagreeing = computeGenreStreakProfile([['rock'], ['dance'], ['dance']]);
        const agreeing = computeGenreStreakProfile([['rock'], ['rock'], ['rock']]);
        expect(disagreeing.weights.get('rock')).toBeGreaterThanOrEqual(0.5);
        expect(disagreeing.weights.get('rock')).toBeGreaterThan(
            disagreeing.weights.get('dance') ?? 0,
        );
        // Agreeing history still reinforces cohesion well above that floor.
        expect(agreeing.cohesion).toBeGreaterThan(disagreeing.weights.get('rock') ?? 0);
    });

    it('genre-mixed history produces partial cohesion, not a hard failure', () => {
        const profile = computeGenreStreakProfile([['rock'], ['dance'], ['rock']]);
        expect(profile.cohesion).toBeLessThan(1);
        expect(profile.cohesion).toBeGreaterThan(0);
    });

    it('ignores untagged tracks in the window rather than treating them as a genre change', () => {
        const withGap = computeGenreStreakProfile([['rock'], null, ['rock'], ['rock']]);
        const withoutGap = computeGenreStreakProfile([['rock'], ['rock'], ['rock']]);
        expect(withGap.cohesion).toBeCloseTo(1, 5);
        expect(withoutGap.cohesion).toBeCloseTo(1, 5);
    });
});

describe('genreAffinity', () => {
    const profile = computeGenreStreakProfile([
        ['heavy metal', 'rock'],
        ['heavy metal'],
        ['heavy metal'],
    ]);

    it('returns null (no signal) for an untagged candidate', () => {
        expect(genreAffinity(null, profile)).toBeNull();
        expect(genreAffinity([], profile)).toBeNull();
    });

    it('returns null (no signal) when the session profile itself is empty', () => {
        expect(genreAffinity(['dance'], { weights: new Map(), cohesion: 0 })).toBeNull();
    });

    it('returns the strongest matching tag weight for a tagged candidate', () => {
        expect(genreAffinity(['heavy metal'], profile)).toBeCloseTo(profile.cohesion, 5);
    });

    it('returns 0 (confirmed zero overlap) for a tagged candidate sharing nothing with the streak', () => {
        expect(genreAffinity(['dance', 'electro house'], profile)).toBe(0);
    });

    it('is case-insensitive', () => {
        expect(genreAffinity(['Heavy Metal'], profile)).toBeCloseTo(profile.cohesion, 5);
    });
});

describe('genreStreakScoreAdjustment', () => {
    const profile = computeGenreStreakProfile([['rock'], ['rock'], ['rock']]);

    it('is 0 for an untagged candidate regardless of weight', () => {
        expect(genreStreakScoreAdjustment(null, profile, 0.25)).toBe(0);
    });

    it('boosts a candidate matching the dominant streak genre', () => {
        const adjustment = genreStreakScoreAdjustment(['rock'], profile, 0.25);
        expect(adjustment).toBeGreaterThan(0);
        expect(adjustment).toBeCloseTo(0.25 * profile.cohesion, 5);
    });

    it('penalizes a candidate with confirmed zero overlap', () => {
        const adjustment = genreStreakScoreAdjustment(['dance'], profile, 0.25);
        expect(adjustment).toBeLessThan(0);
        expect(adjustment).toBeCloseTo(-0.25 * profile.cohesion, 5);
    });

    it('scales down with a genre-mixed (low-cohesion) streak', () => {
        const mixed = computeGenreStreakProfile([['rock'], ['dance'], ['rock']]);
        const focused = computeGenreStreakProfile([['rock'], ['rock'], ['rock']]);
        const mixedAdjustment = Math.abs(genreStreakScoreAdjustment(['dance'], mixed, 0.25));
        const focusedAdjustment = Math.abs(genreStreakScoreAdjustment(['dance'], focused, 0.25));
        expect(mixedAdjustment).toBeLessThan(focusedAdjustment);
    });
});

describe('isGenreStreakActive', () => {
    it('is inactive below the cohesion threshold', () => {
        const mixed = computeGenreStreakProfile([['rock'], ['dance'], ['rock']]);
        expect(isGenreStreakActive(mixed, 0.9)).toBe(false);
    });

    it('is inactive below 3 tagged tracks even when the two present agree', () => {
        const tooFew = computeGenreStreakProfile([['rock'], ['rock']]);
        expect(isGenreStreakActive(tooFew, 0.5)).toBe(false);
    });

    it('is active at or above the cohesion threshold', () => {
        const focused = computeGenreStreakProfile([['rock'], ['rock'], ['rock']]);
        expect(isGenreStreakActive(focused, 0.5)).toBe(true);
    });
});

describe('getGenreTags', () => {
    it('returns null for missing/empty metadata', () => {
        expect(getGenreTags(null)).toBeNull();
        expect(getGenreTags(undefined)).toBeNull();
        expect(getGenreTags({})).toBeNull();
    });

    it('lowercases and extracts an array of genre strings', () => {
        expect(getGenreTags({ genre: ['Rock', 'Hard Rock'] })).toEqual(['rock', 'hard rock']);
    });

    it('wraps a single string genre value', () => {
        expect(getGenreTags({ genre: 'Dance' })).toEqual(['dance']);
    });

    it('drops non-string array entries and empty results', () => {
        expect(getGenreTags({ genre: [1, null, ''] })).toBeNull();
    });
});
