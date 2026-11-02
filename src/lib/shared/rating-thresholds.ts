// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Single source of truth for rating-count thresholds (server + client).
 *
 * Before this module existed, "how many ratings unlock recommendations" was
 * hardcoded in two places that disagreed: rating-manager.service.ts gated
 * suggestion generation at `ratingCount >= 10` while rate.ts's progress/
 * messaging block promised recommendations at 5. Both now import from here.
 */
export const MIN_RATINGS_FOR_RECOMMENDATIONS = 5;

/**
 * How many of a user's most recent ratings feed the profile-rebuild centroid
 * (both the %5-cadence path and the manual-refresh path — see
 * user-profile.service.ts). Widened from 100 → 500: recency decay already
 * makes old ratings cheap, so a hard window that dropped a veteran user's
 * older ratings entirely (previously silently truncating anyone past 100)
 * is no longer necessary.
 */
export const PROFILE_RATING_WINDOW = 500;

/** Rating-count milestones surfaced to the client (gamified progress UX). */
export const RATING_MILESTONES = [5, 25, 50, 100, 250, 500] as const;

/**
 * Whether a rating should immediately drop a title's `user_suggestions` row
 * (the taste rail) between profile-rebuild milestones. Widens the dislike
 * side to the same `<= 4` band the rest of the system already treats as a
 * dislike (`getDislikedMediaIds`, Rocchio negative routing, the `rating <= 4`
 * "because you watched" purge in `cache/invalidation.ts`).
 *
 * Single source of truth: `rating-manager.service.ts` and `cache/invalidation.ts`
 * both import this function so the gates cannot drift apart again.
 */
export function shouldRemoveSuggestionOnRating(rating: number): boolean {
    return rating >= 8 || rating <= 4;
}

/** Highest milestone crossed moving from previousTotal to newTotal, or null. */
export function crossedMilestone(previousTotal: number, newTotal: number): number | null {
    let crossed: number | null = null;
    for (const m of RATING_MILESTONES) {
        if (previousTotal < m && newTotal >= m) crossed = m;
    }
    return crossed;
}

/**
 * AI taste-profile state as a function of lifetime rating count.
 *
 * Derived from the UNLOCK state (count vs threshold), NOT from any per-submit
 * "regenerated this time" flag — a veteran's 237th rating is still 'ready'
 * even when that particular submit didn't trigger a profile rebuild.
 */
export function deriveProfileStatus(totalRatings: number): 'none' | 'building' | 'ready' {
    if (totalRatings >= MIN_RATINGS_FOR_RECOMMENDATIONS) return 'ready';
    return totalRatings > 0 ? 'building' : 'none';
}
