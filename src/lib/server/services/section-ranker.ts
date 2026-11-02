// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section Engagement Ranker (M3)
 *
 * Pure scoring function that reorders the For-You "long tail" carousel
 * sections by a user's accumulated per-section engagement (see
 * `user-section-feedback.queries.ts`'s `getFeedback()`). Flag-gated by
 * `FEATURE_FORYOU_SECTION_RANKER` (default OFF) — consumed by
 * `GET /api/for-you/section-order`.
 *
 * v1 is intentionally simple: one engagement-ratio score per section, no
 * recency/decay weighting. A future extension could weight recent engagement
 * more heavily (e.g. exponential decay keyed on `lastEngagedAt`) — YAGNI for
 * now.
 */

import type { FeedbackRow } from '$lib/server/database/queries/user-section-feedback.queries';

/** Minimum impressions before a section's engagement is treated as signal rather than noise. */
export const MIN_IMPRESSIONS = 5;
/** Additive smoothing denominator — dampens scores for low-impression sections. */
export const SMOOTHING = 10;
/** Weight applied to abandonments in the score numerator. */
export const ABANDON_WEIGHT = 0.5;
/** Weight applied to dismissals in the score numerator (penalized harder than abandons). */
export const DISMISS_WEIGHT = 1.0;

/**
 * Score a single section's engagement. Cold-start (no feedback row, or fewer
 * than `MIN_IMPRESSIONS` impressions) is neutral (0) rather than penalized or
 * boosted — a section the user simply hasn't seen enough of yet keeps its
 * canonical position instead of being shoved to either end.
 */
function scoreSection(row: FeedbackRow | undefined): number {
    if (!row || row.impressions < MIN_IMPRESSIONS) return 0;
    return (
        (row.plays - ABANDON_WEIGHT * row.abandonments - DISMISS_WEIGHT * row.dismissals) /
        (row.impressions + SMOOTHING)
    );
}

/**
 * Reorder `canonicalOrder` by per-section engagement score, descending.
 *
 * Stable: ties (including every neutral-0 section) keep their canonical
 * relative order. Implemented as an explicit decorate-sort-by-(score,
 * canonicalIndex) rather than relying on `Array.prototype.sort`'s stability
 * guarantee, so the tie-break is deterministic and self-documenting.
 *
 * Every section in `canonicalOrder` appears exactly once in the output —
 * none are dropped or duplicated.
 */
export function computeSectionOrder(
    feedback: Map<string, FeedbackRow>,
    canonicalOrder: string[],
): string[] {
    const decorated = canonicalOrder.map((sectionType, index) => ({
        sectionType,
        index,
        score: scoreSection(feedback.get(sectionType)),
    }));

    decorated.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return a.index - b.index;
    });

    return decorated.map((d) => d.sectionType);
}
