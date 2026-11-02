// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music feedback model.
 *
 * Explicit feedback is stored in `user_ratings.rating` as an integer:
 * - `>= MUSIC_FEEDBACK_LIKE_RATING` means the user explicitly liked the track
 * - `<= MUSIC_FEEDBACK_DISLIKE_RATING` means the user explicitly disliked it
 * - anything in between is implicit behaviour (completed / skipped)
 *
 * These constants are the single source of truth for both writes
 * (`recordTrackLike` / `recordTrackDislike`) and reads (`getTrackFeedback`).
 */

export const MUSIC_FEEDBACK_LIKE_RATING = 9;
export const MUSIC_FEEDBACK_DISLIKE_RATING = 2;

/** Ceiling for implicit behaviour (complete-listen). Preserves explicit likes above it. */
export const MUSIC_FEEDBACK_IMPLICIT_CEILING = 8;
/**
 * Floor for implicit behaviour (skip). Must stay above MUSIC_FEEDBACK_DISLIKE_RATING
 * so a passive skip can never push a track into the explicit-dislike range (<= 2).
 * A passive skip from rating 3 will clamp at 3, not drop to 2 or below.
 */
export const MUSIC_FEEDBACK_IMPLICIT_FLOOR = 3;

export type MusicTrackFeedback = 'liked' | 'disliked' | null;

export function ratingToFeedback(rating: number | null | undefined): MusicTrackFeedback {
    if (rating === null || rating === undefined) return null;
    if (rating >= MUSIC_FEEDBACK_LIKE_RATING) return 'liked';
    if (rating <= MUSIC_FEEDBACK_DISLIKE_RATING) return 'disliked';
    return null;
}
