// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * queue-blend.ts — pure, dependency-free helpers for the /rate "Everything"
 * blend. No DB / server imports so they unit-test in the plain vitest env.
 */

/**
 * Explore share of an "Everything" page as a step function of the user's
 * remaining unrated-seen backlog. Higher backlog → leaner explore (floored at
 * 0.30 so explore is never crowded out); an empty backlog is all explore.
 *
 * Returned as a SHARE (not an absolute count) so it is correct for any page
 * `count`. The caller computes `Math.round(count * share)`.
 */
export function shareForBacklog(backlog: number): number {
    if (backlog <= 0) return 1;
    if (backlog < 5) return 0.65;
    if (backlog < 10) return 0.5;
    if (backlog < 20) return 0.4;
    return 0.3;
}

/**
 * Interleave two ordered lists by even spread: each output position is drawn
 * from whichever list has emitted the smaller fraction of itself so far (is
 * "behind" its proportional share). Ties favor the FIRST list (`a`) — callers
 * pass seen as `a` so the deck opens on a familiar title. Pure and
 * deterministic; each list's own order is preserved.
 */
export function evenSpreadInterleave<T>(a: T[], b: T[]): T[] {
    const out: T[] = [];
    const total = a.length + b.length;
    let ai = 0;
    let bi = 0;
    for (let i = 0; i < total; i++) {
        if (ai >= a.length) {
            out.push(b[bi++]);
            continue;
        }
        if (bi >= b.length) {
            out.push(a[ai++]);
            continue;
        }
        // Fraction of each list already emitted; pick the one that is behind.
        // Ties (equal fractions, including both 0 at the start) → `a`.
        const aProgress = ai / a.length;
        const bProgress = bi / b.length;
        if (aProgress <= bProgress) {
            out.push(a[ai++]);
        } else {
            out.push(b[bi++]);
        }
    }
    return out;
}
